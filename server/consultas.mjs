// Consultas de solo lectura sobre la base de AxisPOS (MariaDB).
// Las fórmulas se comprobaron contra una copia real: ventas, tickets, devoluciones, existencias y cajeros coinciden al centavo.

// Fecha real de la venta: UserRealTime si es válida, si no Date
const F = "IF(o.UserRealTime BETWEEN '2020-01-01' AND '2036-12-31 23:59:59', o.UserRealTime, o.`Date`)";
// PriceOut en Axis ya trae el precio cobrado; Discount es solo informativo (no volver a restar).
const IMP = "(ABS(o.Qtty) * o.PriceOut)";
// Sign -1 = venta finalizada en Axis; Sign 0 = sin finalizar / anulada en borrador
const VENTA = "o.OperType = 2 AND COALESCE(o.Sign, 0) < 0";
const DEVOL = "o.OperType = 34";
const RANGO = `${F} >= ? AND ${F} < DATE_ADD(?, INTERVAL 1 DAY)`;
const PRECIO = "COALESCE(NULLIF(g.PriceOut2,0), NULLIF(g.PriceOut1,0), NULLIF(g.PriceOut3,0), 0)";
const STOCK = "(SELECT GoodID, SUM(Qtty) AS cant FROM store GROUP BY GoodID)";

const ymd = (d) => d.toISOString().slice(0, 10);
export const sumarDias = (s, n) => {
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};
const difDias = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 864e5);
const num = (x) => (x == null ? 0 : Number(x));
const redondear = (x, d = 2) => Math.round(num(x) * 10 ** d) / 10 ** d;
/** Costo real o estimado: sin PriceIn → precio × (1 − costoEstimadoPct/100). */
const costoDe = (costo, precio, pct) => {
  const c = num(costo);
  if (c > 0) return c;
  const p = num(precio);
  if (p <= 0) return 0;
  const m = Math.min(Math.max(num(pct) || 0, 0), 99);
  return p * (1 - m / 100);
};
export const numTicket = (acct) => String(Math.trunc(num(acct))).padStart(10, "0");

const filas = async (pool, sql, params = []) => (await pool.query(sql, params))[0];
const una = async (pool, sql, params = []) => (await filas(pool, sql, params))[0] || {};
const uid = (ctx) => (ctx.uid != null ? " AND o.UserID = ?" : "");
const parRango = (ctx, d, h) => (ctx.uid != null ? [d, h, ctx.uid] : [d, h]);

// ---------- Periodo ----------
let extremosCache = { t: 0, v: null };
async function extremos(pool) {
  if (extremosCache.v && Date.now() - extremosCache.t < 20000) return extremosCache.v;
  const m = await una(
    pool,
    `SELECT DATE_FORMAT(MIN(x.f),'%Y-%m-%d') AS desde, DATE_FORMAT(MAX(x.f),'%Y-%m-%d') AS hasta
     FROM (SELECT ${F} AS f FROM operations o WHERE ${VENTA}) x WHERE x.f <= NOW()`
  );
  const hoy = ymd(new Date());
  extremosCache = { t: Date.now(), v: { desde: m.desde || hoy, hasta: m.hasta || hoy } };
  return extremosCache.v;
}

export async function resolverRango(pool, periodo, q = {}) {
  const ext = await extremos(pool);
  const ymdOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
  // Rango personalizado: ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
  if (periodo === "custom" || (ymdOk(q.desde) && ymdOk(q.hasta))) {
    let desde = ymdOk(q.desde) ? q.desde : ext.desde;
    let hasta = ymdOk(q.hasta) ? q.hasta : ext.hasta;
    if (desde > hasta) [desde, hasta] = [hasta, desde];
    // Rango personalizado: respetar el día elegido (informe de un solo día, logs, caja).
    // Solo se limita a un máximo de 3 años hacia atrás por seguridad.
    const minDesde = sumarDias(ext.hasta, -365 * 3);
    if (desde < minDesde) desde = minDesde;
    const dias = difDias(desde, hasta) + 1;
    const r = { desde, hasta, dias, todo: false, ultimo: ext.hasta, personalizado: true };
    r.aHasta = sumarDias(desde, -1);
    r.aDesde = sumarDias(r.aHasta, -(dias - 1));
    return r;
  }
  const hasta = ext.hasta;
  let dias = periodo === "hoy" || periodo === "1" ? 1 : periodo === "7" ? 7 : periodo === "90" ? 90 : periodo === "todo" ? null : 30;
  let desde;
  if (dias) desde = sumarDias(hasta, -(dias - 1));
  else {
    desde = ext.desde;
    dias = difDias(desde, hasta) + 1;
  }
  const r = { desde, hasta, dias, todo: periodo === "todo", ultimo: ext.hasta, personalizado: false };
  if (!r.todo) {
    r.aHasta = sumarDias(desde, -1);
    r.aDesde = sumarDias(r.aHasta, -(dias - 1));
  }
  return r;
}

async function totalVentas(pool, ctx, d, h) {
  const r = await una(
    pool,
    `SELECT COALESCE(SUM(${IMP}),0) AS total, COUNT(DISTINCT o.Acct) AS tickets FROM operations o WHERE ${VENTA} AND ${RANGO}${uid(ctx)}`,
    parRango(ctx, d, h)
  );
  return { total: num(r.total), tickets: num(r.tickets) };
}

const porHora = (pool, ctx, d, h) =>
  filas(
    pool,
    `SELECT HOUR(${F}) AS hora, SUM(${IMP}) AS total, COUNT(DISTINCT o.Acct) AS tickets
     FROM operations o WHERE ${VENTA} AND ${RANGO}${uid(ctx)} GROUP BY hora ORDER BY hora`,
    parRango(ctx, d, h)
  );

// ---------- Resumen ----------
export async function resumen(pool, ctx) {
  const { desde, hasta } = ctx.r;
  const U = uid(ctx);
  const P = parRango(ctx, desde, hasta);
  const ultimo = ctx.r.ultimo;
  const inicioMes = ultimo.slice(0, 8) + "01";
  const diaMes = Number(ultimo.slice(8, 10));
  const mesAntIni = ymd(new Date(Date.UTC(Number(ultimo.slice(0, 4)), Number(ultimo.slice(5, 7)) - 2, 1)));
  const mesAntMismoDia = sumarDias(mesAntIni, diaMes - 1);
  const mesAntFin = sumarDias(inicioMes, -1);
  // Costo de lo vendido y descuentos en importe (estilo resumen del PDF)
  const COSTO = "ABS(o.Qtty) * COALESCE(NULLIF(o.PriceIn,0), NULLIF(g.PriceIn,0), 0)";
  const DESC_IMP = "(ABS(o.Qtty) * o.PriceOut * IF(o.Discount BETWEEN 0 AND 100, o.Discount, 0) / 100)";
  const [tot, dev, ant, horas, dias, top, fam, formas, rec, hoyT, ayerT, sem, semAnt, mes, mesAnt, hoyHoras, cajeros, costoDesc] =
    await Promise.all([
      una(pool, `SELECT COALESCE(SUM(${IMP}),0) AS total, COUNT(DISTINCT o.Acct) AS tickets, COALESCE(SUM(ABS(o.Qtty)),0) AS unidades FROM operations o WHERE ${VENTA} AND ${RANGO}${U}`, P),
      una(pool, `SELECT COALESCE(SUM(${IMP}),0) AS total, COUNT(DISTINCT o.Acct) AS docs FROM operations o WHERE ${DEVOL} AND ${RANGO}${U}`, P),
      ctx.r.todo ? Promise.resolve(null) : totalVentas(pool, ctx, ctx.r.aDesde, ctx.r.aHasta),
      porHora(pool, ctx, desde, hasta),
      filas(pool, `SELECT DATE_FORMAT(${F},'%Y-%m-%d') AS dia, SUM(${IMP}) AS total, COUNT(DISTINCT o.Acct) AS tickets, COALESCE(SUM(ABS(o.Qtty)),0) AS unidades FROM operations o WHERE ${VENTA} AND ${RANGO}${U} GROUP BY dia ORDER BY dia`, P),
      filas(pool, `SELECT g.Code AS codigo, g.Name AS nombre, COALESCE(gg.Name,'Sin grupo') AS familia,
            SUM(ABS(o.Qtty)) AS unidades, SUM(${IMP}) AS total, SUM(${COSTO}) AS costo
        FROM operations o LEFT JOIN goods g ON g.ID = o.GoodID LEFT JOIN goodsgroups gg ON gg.ID = g.GroupID
        WHERE ${VENTA} AND ${RANGO}${U} GROUP BY o.GoodID, g.Code, g.Name, gg.Name ORDER BY total DESC LIMIT 80`, P),
      filas(pool, `SELECT COALESCE(gg.Name,'Sin grupo') AS familia,
            SUM(${IMP}) AS total, SUM(ABS(o.Qtty)) AS unidades, SUM(${COSTO}) AS costo
        FROM operations o LEFT JOIN goods g ON g.ID = o.GoodID LEFT JOIN goodsgroups gg ON gg.ID = g.GroupID
        WHERE ${VENTA} AND ${RANGO}${U} GROUP BY gg.ID, gg.Name ORDER BY total DESC`, P),
      filas(pool, `SELECT COALESCE(p.Company,'Sin socio') AS socio, COUNT(DISTINCT o.Acct) AS tickets, SUM(${IMP}) AS total
        FROM operations o LEFT JOIN partners p ON p.ID = o.PartnerID WHERE ${VENTA} AND ${RANGO}${U} GROUP BY p.ID, p.Company ORDER BY total DESC`, P),
      filas(pool, `SELECT o.Acct AS acct, MAX(${F}) AS fecha, SUM(${IMP}) AS total, MAX(u.Name) AS cajero
        FROM operations o LEFT JOIN users u ON u.ID = o.UserID WHERE ${VENTA} AND ${RANGO}${U}
        GROUP BY o.Acct ORDER BY fecha DESC, o.Acct DESC LIMIT 6`, P),
      totalVentas(pool, ctx, ultimo, ultimo),
      totalVentas(pool, ctx, sumarDias(ultimo, -1), sumarDias(ultimo, -1)),
      totalVentas(pool, ctx, sumarDias(ultimo, -6), ultimo),
      totalVentas(pool, ctx, sumarDias(ultimo, -13), sumarDias(ultimo, -7)),
      totalVentas(pool, ctx, inicioMes, ultimo),
      totalVentas(pool, ctx, mesAntIni, mesAntMismoDia),
      porHora(pool, ctx, ultimo, ultimo),
      ctx.uid != null ? Promise.resolve([]) : equipo(pool, { ...ctx, r: ctx.r }),
      una(pool, `SELECT COALESCE(SUM(${COSTO}),0) AS costo, COALESCE(SUM(${DESC_IMP}),0) AS descuentos
        FROM operations o LEFT JOIN goods g ON g.ID = o.GoodID WHERE ${VENTA} AND ${RANGO}${U}`, P),
    ]);
  const mesAntCompleto = await totalVentas(pool, ctx, mesAntIni, mesAntFin);
  const total = num(tot.total);
  const tickets = num(tot.tickets);
  const costo = num(costoDesc.costo);
  // Pagos registrados (efectivo / otros) en turnos del período
  let pagoEfectivo = 0, pagoOtros = 0, pagosList = [];
  try {
    const pagos = await filas(
      pool,
      `SELECT COALESCE(p.Type, p.Mode, 0) AS tipo, COALESCE(SUM(p.Qtty),0) AS monto
       FROM payments p
       JOIN shift sh ON sh.ID = p.ShiftID
       WHERE sh.DateTimeOpen >= ? AND sh.DateTimeOpen < DATE_ADD(?, INTERVAL 1 DAY)
         AND p.OperType = 2
       GROUP BY COALESCE(p.Type, p.Mode, 0)`,
      [desde, hasta]
    );
    for (const x of pagos) {
      const m = num(x.monto);
      // Mode/Type 1 suele ser efectivo en Axis
      if (num(x.tipo) === 1) pagoEfectivo += m;
      else pagoOtros += m;
      pagosList.push({ tipo: num(x.tipo), monto: m });
    }
  } catch {}

  const descuentos = num(costoDesc.descuentos);
  const ganancia = total - costo;
  const pct = (a, b) => (b > 0 ? redondear(((a - b) / b) * 100, 1) : null);
  const base = {
    desde, hasta, dias: ctx.r.dias, ultimoDia: ultimo,
    total, tickets, unidades: num(tot.unidades), promedio: tickets ? total / tickets : 0,
    devoluciones: num(dev.total), devDocs: num(dev.docs), neto: total - num(dev.total),
    costo, descuentos, ganancia,
    pagoEfectivo, pagoOtros, pagosList,
    totalLimpio: total - num(dev.total),
    margen: total > 0 ? ganancia / total : 0,
    costoPorPeso: total > 0 ? costo / total : 0,
    anterior: ant ? { total: ant.total, tickets: ant.tickets, variacion: pct(total, ant.total) } : null,
    porHora: horas.map((x) => ({ hora: num(x.hora), total: num(x.total), tickets: num(x.tickets) })),
    porDia: dias.map((x) => ({
      dia: x.dia,
      total: num(x.total),
      tickets: num(x.tickets),
      unidades: num(x.unidades),
      promedio: num(x.tickets) ? num(x.total) / num(x.tickets) : 0,
    })),
    top: top.map((x) => ({
      codigo: x.codigo || "",
      nombre: x.nombre,
      familia: x.familia,
      unidades: num(x.unidades),
      total: num(x.total),
      costo: num(x.costo),
      ganancia: num(x.total) - num(x.costo),
      margen: num(x.total) > 0 ? (num(x.total) - num(x.costo)) / num(x.total) : 0,
    })),
    familias: fam.map((x) => ({
      familia: x.familia,
      total: num(x.total),
      unidades: num(x.unidades),
      costo: num(x.costo),
      ganancia: num(x.total) - num(x.costo),
      parte: total > 0 ? num(x.total) / total : 0,
    })),
    formasPago: formas.map((x) => ({ socio: x.socio, tickets: num(x.tickets), total: num(x.total) })),
    recientes: rec.map((x) => ({ ticket: numTicket(x.acct), acct: num(x.acct), fecha: x.fecha, total: num(x.total), cajero: x.cajero })),
    cajeros: (cajeros || []).slice(0, 12),
    tiempoReal: {
      dia: ultimo, hoy: hoyT.total, hoyTickets: hoyT.tickets, ayer: ayerT.total, varDia: pct(hoyT.total, ayerT.total),
      semana: sem.total, semanaAnt: semAnt.total, varSemana: pct(sem.total, semAnt.total),
      mes: mes.total, mesAnt: mesAnt.total, varMes: pct(mes.total, mesAnt.total), mesAntCompleto: mesAntCompleto.total,
      horasHoy: hoyHoras.map((x) => ({ hora: num(x.hora), total: num(x.total) })),
    },
  };
  // Sin llamar a panelDueno (evita recursión panel ↔ resumen)
  try {
    base.alertasInicio = await alertasInicio(pool, ctx).catch(() => null);
  } catch (_) {
    base.alertasInicio = null;
  }
  base.panel = {
    desde: base.desde,
    hasta: base.hasta,
    ultimoDia: base.ultimoDia,
    ventasHoy: base.tiempoReal?.hoy ?? 0,
    ventasPeriodo: base.total,
    tickets: base.tickets,
    ganancia: base.ganancia ?? null,
    margen: base.margen ?? null,
    caja: base.alertasInicio?.caja || { conDiferencia: 0, faltante: 0, sobrante: 0 },
    stockCritico: [],
    top: (base.top || []).slice(0, 5),
    mermas: 0,
  };
  return base;
}

// ---------- Ventas ----------
export async function ventasModo(pool, ctx, q = {}) {
  const modo = String(q.modo || "tickets");
  if (modo === "dia" || modo === "por-dia") return ventasPorDia(pool, ctx);
  return ventas(pool, ctx, q);
}

export async function ventas(pool, ctx, q) {
  const { desde, hasta } = ctx.r;
  const busca = String(q.q || "").trim().slice(0, 60);
  const pagina = Math.max(parseInt(q.pagina, 10) || 1, 1);
  const por = q.todo ? 20000 : 40;
  const params = parRango(ctx, desde, hasta);
  let having = "";
  if (busca) {
    having = "HAVING (CAST(o.Acct AS CHAR) LIKE ? OR MAX(u.Name) LIKE ? OR SUM(g.Name LIKE ?) > 0)";
    const l = `%${busca.replace(/^0+/, "")}%`;
    params.push(l, `%${busca}%`, `%${busca}%`);
  }
  const base = `SELECT o.Acct AS acct, MAX(${F}) AS fecha, MAX(u.Name) AS cajero, MAX(p.Company) AS socio, SUM(${IMP}) AS total
    FROM operations o LEFT JOIN users u ON u.ID = o.UserID LEFT JOIN partners p ON p.ID = o.PartnerID LEFT JOIN goods g ON g.ID = o.GoodID
    WHERE ${VENTA} AND ${RANGO}${uid(ctx)} GROUP BY o.Acct ${having}`;
  const [[cuenta], lista] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS n FROM (${base}) z`, params),
    filas(pool, `${base} ORDER BY fecha DESC, o.Acct DESC LIMIT ${por} OFFSET ${(pagina - 1) * por}`, params),
  ]);
  const n = num(cuenta[0].n);
  return {
    total: n, paginas: Math.max(Math.ceil(n / por), 1), pagina,
    filas: lista.map((x) => ({ ticket: numTicket(x.acct), acct: num(x.acct), fecha: x.fecha, cajero: x.cajero, socio: x.socio, total: num(x.total) })),
  };
}

export async function ticket(pool, ctx, acct) {
  const params = [acct];
  let extra = "";
  if (ctx.uid != null) {
    extra = " AND o.UserID = ?";
    params.push(ctx.uid);
  }
  const lineas = await filas(
    pool,
    `SELECT o.ID AS id, o.OperType AS tipo, o.Sign AS sign, g.Name AS nombre, o.Qtty AS qtty, ABS(o.Qtty) AS cant, o.PriceOut AS precio,
            IF(o.Discount BETWEEN 0 AND 100, o.Discount, 0) AS descuento, ${IMP} AS importe,
            ${F} AS fecha, u.Name AS cajero, p.Company AS socio, o.Note AS nota
     FROM operations o LEFT JOIN goods g ON g.ID = o.GoodID LEFT JOIN users u ON u.ID = o.UserID LEFT JOIN partners p ON p.ID = o.PartnerID
     WHERE o.Acct = ?${extra} ORDER BY o.ID`,
    params
  );
  if (!lineas.length) {
    // Solo logs (anulación sin líneas restantes)
    const logsSolo = await filas(
      pool,
      `SELECT DATE_FORMAT(l.UserRealTime,'%Y-%m-%d %H:%i') AS fecha, u.Name AS usuario, l.Message AS mensaje
       FROM applicationlog l LEFT JOIN users u ON u.ID = l.UserID
       WHERE l.Message LIKE ? OR l.Message LIKE ?
       ORDER BY l.UserRealTime DESC LIMIT 30`,
      [`%${acct}%`, `%${numTicket(acct)}%`]
    ).catch(() => []);
    if (!logsSolo.length) return null;
    return {
      ticket: numTicket(acct), acct: num(acct), devolucion: false, anulado: true,
      fecha: logsSolo[0]?.fecha, cajero: logsSolo[0]?.usuario || "", socio: "",
      lineas: [], total: 0, logs: logsSolo.map((x) => ({ fecha: x.fecha, usuario: x.usuario || "—", mensaje: String(x.mensaje || "").replace(/\s+/g, " ").slice(0, 300) })),
      pagos: [], estado: "Solo en log (sin líneas de operación)",
    };
  }
  const devol = lineas.some((l) => num(l.tipo) === 34);
  const signs = lineas.map((l) => num(l.sign));
  const anulado = signs.every((s) => s === 0) || lineas.every((l) => num(l.tipo) !== 2 && num(l.tipo) !== 34);

  // Buscar en el log si este ticket fue anulado o cancelado
  const logs = await filas(
    pool,
    `SELECT DATE_FORMAT(l.UserRealTime,'%Y-%m-%d %H:%i') AS fecha, u.Name AS usuario, l.Message AS mensaje
     FROM applicationlog l LEFT JOIN users u ON u.ID = l.UserID
     WHERE l.Message LIKE ? OR l.Message LIKE ?
     ORDER BY l.UserRealTime DESC LIMIT 15`,
    [`%${acct}%`, `%${numTicket(acct)}%`]
  );

  // Pagos del ticket si existen
  const pagos = await filas(
    pool,
    `SELECT p.Mode AS modo, p.Qtty AS monto, COALESCE(p.Company, '') AS socio
     FROM payments p WHERE p.Acct = ?`,
    [acct]
  ).catch(() => []);

  return {
    ticket: numTicket(acct),
    acct: num(acct),
    devolucion: devol,
    anulado: !!anulado,
    estado: anulado ? "Anulada / no finalizada" : devol ? "Devolución" : "Venta",
    fecha: lineas[0].fecha,
    cajero: lineas[0].cajero,
    socio: lineas[0].socio,
    lineas: lineas.map((l) => ({
      nombre: l.nombre,
      tipo: num(l.tipo),
      sign: num(l.sign),
      cant: num(l.cant),
      qtty: num(l.qtty),
      precio: num(l.precio),
      descuento: num(l.descuento),
      importe: num(l.importe),
      nota: l.nota || "",
    })),
    total: lineas.filter((l) => num(l.tipo) === 2 || num(l.tipo) === 34).reduce((s, l) => s + num(l.importe), 0),
    logs: logs.map((x) => ({
      fecha: x.fecha,
      usuario: x.usuario || "—",
      mensaje: String(x.mensaje || "").replace(/\s+/g, " ").slice(0, 300),
    })),
    pagos: (pagos || []).map((p) => ({
      modo: p.modo,
      monto: num(p.monto),
      socio: p.socio,
    })),
  };
}

// ---------- Productos ----------
export async function productos(pool, ctx, q) {
  const { desde, hasta } = ctx.r;
  const busca = `%${String(q.q || "").trim().slice(0, 60)}%`;
  const pagina = Math.max(parseInt(q.pagina, 10) || 1, 1);
  const activos = q.activos !== "0";
  const fam = parseInt(q.familia, 10);
  const orden = { vendidos: "importe DESC, g.Name", nombre: "g.Name", stock: "existencia DESC, g.Name", precio: "precio DESC, g.Name" }[q.orden] || "importe DESC, g.Name";
  const cond = [`(g.Name LIKE ? OR g.Code LIKE ? OR g.BarCode1 LIKE ?)`];
  const params = [busca, busca, busca];
  if (activos) cond.push("COALESCE(g.Deleted,0) = 0");
  if (Number.isInteger(fam)) {
    cond.push("g.GroupID = ?");
    params.push(fam);
  }
  const donde = cond.join(" AND ");
  const cajero = ctx.rol === "cajero";
  const [[cuenta], lista] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS n FROM goods g WHERE ${donde}`, params),
    filas(
      pool,
      `SELECT g.ID AS id, g.Code AS codigo, g.Name AS nombre, COALESCE(gg.Name,'Sin grupo') AS familia, g.PriceIn AS costo,
              ${PRECIO} AS precio, COALESCE(s.cant,0) AS existencia, COALESCE(v.unidades,0) AS vendido, COALESCE(v.total,0) AS importe
       FROM goods g LEFT JOIN goodsgroups gg ON gg.ID = g.GroupID
       LEFT JOIN ${STOCK} s ON s.GoodID = g.ID
       LEFT JOIN (SELECT o.GoodID, SUM(ABS(o.Qtty)) AS unidades, SUM(${IMP}) AS total FROM operations o WHERE ${VENTA} AND ${RANGO} GROUP BY o.GoodID) v ON v.GoodID = g.ID
       WHERE ${donde} ORDER BY ${orden} LIMIT 40 OFFSET ${(pagina - 1) * 40}`,
      [desde, hasta, ...params]
    ),
  ]);
  const n = num(cuenta[0].n);
  const familias = await filas(pool, `SELECT gg.ID AS id, gg.Name AS nombre FROM goodsgroups gg WHERE EXISTS (SELECT 1 FROM goods g WHERE g.GroupID = gg.ID) ORDER BY gg.Name`);
  return {
    total: n, paginas: Math.max(Math.ceil(n / 40), 1), pagina, familias,
    filas: lista.map((x) => ({
      id: x.id, codigo: x.codigo, nombre: x.nombre, familia: x.familia, precio: num(x.precio), existencia: num(x.existencia),
      ...(cajero ? {} : { costo: num(x.costo), vendido: num(x.vendido), importe: num(x.importe) }),
    })),
  };
}

// ---------- Top productos ----------
export async function productosModo(pool, ctx, q) {
  const modo = String(q.modo || "lista");
  if (modo === "top") return topProductos(pool, ctx, q);
  if (modo === "margen") return margenProductos(pool, ctx);
  return productos(pool, ctx, q);
}

export async function topProductos(pool, ctx, q) {
  const { desde, hasta } = ctx.r;
  const limite = Math.min(Math.max(parseInt(q.limite, 10) || 50, 10), 200);
  const U = uid(ctx);
  const P = parRango(ctx, desde, hasta);
  const lista = await filas(
    pool,
    `SELECT g.ID AS id, g.Code AS codigo, g.Name AS nombre, COALESCE(gg.Name,'Sin grupo') AS familia,
            SUM(ABS(o.Qtty)) AS unidades, SUM(${IMP}) AS total, COUNT(DISTINCT o.Acct) AS tickets
     FROM operations o
     LEFT JOIN goods g ON g.ID = o.GoodID
     LEFT JOIN goodsgroups gg ON gg.ID = g.GroupID
     WHERE ${VENTA} AND ${RANGO}${U}
     GROUP BY g.ID, g.Code, g.Name, gg.Name
     ORDER BY total DESC
     LIMIT ${limite}`,
    P
  );
  const totalImporte = lista.reduce((s, x) => s + num(x.total), 0);
  return {
    desde, hasta,
    filas: lista.map((x, i) => ({
      puesto: i + 1,
      id: x.id,
      codigo: x.codigo,
      nombre: x.nombre,
      familia: x.familia,
      unidades: num(x.unidades),
      tickets: num(x.tickets),
      total: num(x.total),
      parte: totalImporte > 0 ? num(x.total) / totalImporte : 0,
    })),
    totalImporte,
  };
}

/** Productos vendidos a más de un precio en el período y quién los vendió a cada precio. */
export async function cambiosPrecio(pool, ctx, q) {
  const { desde, hasta } = ctx.r;
  const U = uid(ctx);
  const P = parRango(ctx, desde, hasta);
  // Precios distintos por producto (PriceOut de la línea de venta)
  const precios = await filas(
    pool,
    `SELECT o.GoodID AS id, g.Code AS codigo, g.Name AS nombre, COALESCE(gg.Name,'Sin grupo') AS familia,
            o.PriceOut AS precio, SUM(ABS(o.Qtty)) AS unidades, COUNT(DISTINCT o.Acct) AS tickets,
            SUM(${IMP}) AS total
     FROM operations o
     LEFT JOIN goods g ON g.ID = o.GoodID
     LEFT JOIN goodsgroups gg ON gg.ID = g.GroupID
     WHERE ${VENTA} AND ${RANGO}${U} AND o.PriceOut > 0
     GROUP BY o.GoodID, g.Code, g.Name, gg.Name, o.PriceOut
     HAVING o.GoodID IS NOT NULL
     ORDER BY g.Name, o.PriceOut`,
    P
  );
  // Quién vendió a cada precio
  const porUsuario = await filas(
    pool,
    `SELECT o.GoodID AS id, o.PriceOut AS precio, u.Name AS usuario,
            SUM(ABS(o.Qtty)) AS unidades, COUNT(DISTINCT o.Acct) AS tickets
     FROM operations o
     LEFT JOIN users u ON u.ID = o.UserID
     WHERE ${VENTA} AND ${RANGO}${U} AND o.PriceOut > 0
     GROUP BY o.GoodID, o.PriceOut, u.ID, u.Name`,
    P
  );
  const userMap = new Map();
  for (const x of porUsuario) {
    const k = `${num(x.id)}|${num(x.precio)}`;
    if (!userMap.has(k)) userMap.set(k, []);
    userMap.get(k).push({
      usuario: x.usuario || "Sin nombre",
      unidades: num(x.unidades),
      tickets: num(x.tickets),
    });
  }
  // Agrupar por producto; solo los que tienen ≥ 2 precios distintos
  const byProd = new Map();
  for (const x of precios) {
    const id = num(x.id);
    if (!byProd.has(id)) {
      byProd.set(id, {
        id,
        codigo: x.codigo,
        nombre: x.nombre,
        familia: x.familia,
        precios: [],
        precioMin: Infinity,
        precioMax: 0,
        unidades: 0,
        tickets: 0,
      });
    }
    const p = byProd.get(id);
    const pr = num(x.precio);
    p.precios.push({
      precio: pr,
      unidades: num(x.unidades),
      tickets: num(x.tickets),
      total: num(x.total),
      quienes: userMap.get(`${id}|${pr}`) || [],
    });
    p.precioMin = Math.min(p.precioMin, pr);
    p.precioMax = Math.max(p.precioMax, pr);
    p.unidades += num(x.unidades);
    p.tickets += num(x.tickets);
  }
  const filasOut = [...byProd.values()]
    .filter((p) => p.precios.length >= 2)
    .map((p) => ({
      ...p,
      nPrecios: p.precios.length,
      variacion: p.precioMax - p.precioMin,
      variacionPct: p.precioMin > 0 ? (p.precioMax - p.precioMin) / p.precioMin : 0,
      precios: p.precios.sort((a, b) => a.precio - b.precio),
    }))
    .sort((a, b) => b.variacion - a.variacion);

  return {
    desde,
    hasta,
    total: filasOut.length,
    filas: filasOut.slice(0, 150),
  };
}

// ---------- Transacciones de un producto ----------
export async function transaccionesProducto(pool, ctx, q) {
  const { desde, hasta } = ctx.r;
  const goodId = parseInt(q.id, 10);
  if (!Number.isInteger(goodId)) return { error: "Producto no válido" };
  const pagina = Math.max(parseInt(q.pagina, 10) || 1, 1);
  const por = 40;
  const U = uid(ctx);
  const baseParams = parRango(ctx, desde, hasta);
  const params = [...baseParams, goodId];
  const [[cuenta], lista, info] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) AS n FROM operations o WHERE ${VENTA} AND ${RANGO}${U} AND o.GoodID = ?`,
      params
    ),
    filas(
      pool,
      `SELECT o.Acct AS acct, ${F} AS fecha, ABS(o.Qtty) AS cant, o.PriceOut AS precio,
              IF(o.Discount BETWEEN 0 AND 100, o.Discount, 0) AS descuento, ${IMP} AS importe,
              u.Name AS cajero, p.Company AS socio
       FROM operations o
       LEFT JOIN users u ON u.ID = o.UserID
       LEFT JOIN partners p ON p.ID = o.PartnerID
       WHERE ${VENTA} AND ${RANGO}${U} AND o.GoodID = ?
       ORDER BY ${F} DESC, o.Acct DESC
       LIMIT ${por} OFFSET ${(pagina - 1) * por}`,
      params
    ),
    una(pool, `SELECT g.ID AS id, g.Code AS codigo, g.Name AS nombre, COALESCE(gg.Name,'Sin grupo') AS familia
      FROM goods g LEFT JOIN goodsgroups gg ON gg.ID = g.GroupID WHERE g.ID = ?`, [goodId]),
  ]);
  const n = num(cuenta[0].n);
  const totales = await una(
    pool,
    `SELECT COALESCE(SUM(ABS(o.Qtty)),0) AS unidades, COALESCE(SUM(${IMP}),0) AS total, COUNT(DISTINCT o.Acct) AS tickets
     FROM operations o WHERE ${VENTA} AND ${RANGO}${U} AND o.GoodID = ?`,
    params
  );
  return {
    producto: info || { id: goodId, nombre: "Producto", codigo: "", familia: "" },
    desde, hasta,
    total: n,
    paginas: Math.max(Math.ceil(n / por), 1),
    pagina,
    unidades: num(totales.unidades),
    importe: num(totales.total),
    tickets: num(totales.tickets),
    filas: lista.map((x) => ({
      acct: num(x.acct),
      ticket: numTicket(x.acct),
      fecha: x.fecha,
      cant: num(x.cant),
      precio: num(x.precio),
      descuento: num(x.descuento),
      importe: num(x.importe),
      cajero: x.cajero || "",
      socio: x.socio || "",
    })),
  };
}

// ---------- Ventas por día (tabla detallada) ----------
export async function ventasPorDia(pool, ctx) {
  const { desde, hasta } = ctx.r;
  const U = uid(ctx);
  const P = parRango(ctx, desde, hasta);
  const dias = await filas(
    pool,
    `SELECT DATE_FORMAT(${F},'%Y-%m-%d') AS dia,
            SUM(${IMP}) AS total,
            COUNT(DISTINCT o.Acct) AS tickets,
            COALESCE(SUM(ABS(o.Qtty)),0) AS unidades,
            COUNT(*) AS lineas
     FROM operations o
     WHERE ${VENTA} AND ${RANGO}${U}
     GROUP BY dia
     ORDER BY dia DESC`,
    P
  );
  const tot = dias.reduce(
    (a, x) => ({
      total: a.total + num(x.total),
      tickets: a.tickets + num(x.tickets),
      unidades: a.unidades + num(x.unidades),
      lineas: a.lineas + num(x.lineas),
      dias: a.dias + 1,
    }),
    { total: 0, tickets: 0, unidades: 0, lineas: 0, dias: 0 }
  );
  return {
    desde, hasta,
    resumen: {
      total: tot.total,
      tickets: tot.tickets,
      unidades: tot.unidades,
      lineas: tot.lineas,
      dias: tot.dias,
      promedioDia: tot.dias ? tot.total / tot.dias : 0,
      ticketPromedio: tot.tickets ? tot.total / tot.tickets : 0,
    },
    filas: dias.map((x) => ({
      dia: x.dia,
      total: num(x.total),
      tickets: num(x.tickets),
      unidades: num(x.unidades),
      lineas: num(x.lineas),
      ticketPromedio: num(x.tickets) ? num(x.total) / num(x.tickets) : 0,
    })),
  };
}

// ---------- Existencias ----------
export async function existencias(pool, ctx, q) {
  const { desde, hasta } = ctx.r;
  const busca = `%${String(q.q || "").trim().slice(0, 60)}%`;
  const pagina = Math.max(parseInt(q.pagina, 10) || 1, 1);
  const local = parseInt(q.local, 10);
  const params = [busca, busca];
  let filtro = "";
  if (Number.isInteger(local)) {
    filtro = " AND s.ObjectID = ?";
    params.push(local);
  }
  const base = `SELECT s.ObjectID AS lid, o.Name AS local, s.GoodID AS id, g.Name AS nombre, SUM(s.Qtty) AS cantidad
    FROM store s JOIN goods g ON g.ID = s.GoodID JOIN objects o ON o.ID = s.ObjectID
    WHERE (g.Name LIKE ? OR g.Code LIKE ?)${filtro} GROUP BY s.ObjectID, o.Name, s.GoodID, g.Name HAVING SUM(s.Qtty) > 0.0005`;
  const [kpi, agot, locales, [cuenta], lista] = await Promise.all([
    una(pool, `SELECT COUNT(*) AS referencias, COALESCE(SUM(t.cant),0) AS piezas FROM (SELECT GoodID, SUM(Qtty) AS cant FROM store GROUP BY GoodID HAVING SUM(Qtty) > 0.0005) t`),
    filas(pool, `SELECT g.Name AS nombre, v.total AS importe
      FROM (SELECT o.GoodID, SUM(${IMP}) AS total FROM operations o WHERE ${VENTA} AND ${RANGO} GROUP BY o.GoodID) v
      JOIN goods g ON g.ID = v.GoodID LEFT JOIN ${STOCK} s ON s.GoodID = v.GoodID
      WHERE COALESCE(s.cant,0) <= 0.0005 ORDER BY v.total DESC`, [desde, hasta]),
    filas(pool, `SELECT o.ID AS id, o.Name AS nombre, o.Deleted AS archivado FROM objects o WHERE EXISTS (SELECT 1 FROM store s WHERE s.ObjectID = o.ID AND s.Qtty <> 0) ORDER BY o.Name`),
    pool.query(`SELECT COUNT(*) AS n FROM (${base}) z`, params),
    filas(pool, `${base} ORDER BY cantidad DESC, nombre LIMIT 40 OFFSET ${(pagina - 1) * 40}`, params),
  ]);
  const n = num(cuenta[0].n);
  return {
    referencias: num(kpi.referencias), piezas: num(kpi.piezas), agotados: agot.length,
    agotadosLista: agot.slice(0, 12).map((x) => ({ nombre: x.nombre, importe: num(x.importe) })),
    locales: locales.map((x) => ({ id: x.id, nombre: x.nombre + (num(x.archivado) !== 0 ? " (archivado)" : "") })),
    total: n, paginas: Math.max(Math.ceil(n / 40), 1), pagina,
    filas: lista.map((x) => ({ id: x.id, nombre: x.nombre, local: x.local, cantidad: num(x.cantidad) })),
  };
}

// ---------- IPV detallado (inventario valorado por local) ----------
// Nombres legibles de tipos de operación típicos de AxisPOS / Microinvest
const NOMBRE_OPER = {
  1: "Entrada / compra",
  2: "Venta",
  3: "Merma / desecho",
  4: "Pedido",
  7: "Transferencia",
  8: "Producción",
  11: "Baja / uso interno",
  12: "Recepción",
  15: "Inventario / ajuste",
  26: "Transferencia salida",
  27: "Transferencia entrada",
  34: "Devolución de venta",
  35: "Devolución a proveedor",
};

export async function ipv(pool, ctx, q) {
  const { desde, hasta } = ctx.r;
  const busca = `%${String(q.q || "").trim().slice(0, 60)}%`;
  const local = parseInt(q.local, 10);
  const tieneLocal = Number.isInteger(local);

  // --- Stock actual (existencia final) por producto ---
  const stockParams = [busca, busca, busca];
  let stockFiltro = " AND COALESCE(g.Deleted,0) = 0";
  if (tieneLocal) {
    stockFiltro += " AND s.ObjectID = ?";
    stockParams.push(local);
  }
  const filasStock = await filas(
    pool,
    `SELECT g.ID AS id, g.Code AS codigo, g.Name AS nombre, COALESCE(gg.Name,'Sin grupo') AS familia,
            SUM(s.Qtty) AS final, g.PriceIn AS costoUnit, ${PRECIO} AS precioUnit
     FROM store s
     JOIN goods g ON g.ID = s.GoodID
     LEFT JOIN goodsgroups gg ON gg.ID = g.GroupID
     WHERE (g.Name LIKE ? OR g.Code LIKE ? OR g.BarCode1 LIKE ?)${stockFiltro}
     GROUP BY g.ID, g.Code, g.Name, gg.Name, g.PriceIn, g.PriceOut1, g.PriceOut2, g.PriceOut3`,
    stockParams
  );
  const stockMap = new Map(filasStock.map((x) => [num(x.id), x]));

  // --- Movimientos del período por producto y tipo ---
  // Qtty en AxisPOS: ventas suelen ser negativas; usamos el signo real para reconstruir
  const movParams = [desde, hasta, busca, busca, busca];
  let movLocal = "";
  // Filtrar por local vía turno si se pide
  if (tieneLocal) {
    // Mismo local que el stock: ObjectID de la operación o del turno
    movLocal = " AND (o.ObjectID = ? OR EXISTS (SELECT 1 FROM shift sh WHERE sh.ID = o.ShiftID AND sh.ObjectID = ?))";
    movParams.push(local, local);
  }
  const movs = await filas(
    pool,
    `SELECT o.GoodID AS id, o.OperType AS tipo,
            SUM(o.Qtty) AS neto,
            SUM(ABS(o.Qtty)) AS volumen,
            SUM(${IMP}) AS importe,
            COUNT(*) AS n
     FROM operations o
     JOIN goods g ON g.ID = o.GoodID
     WHERE ${F} >= ? AND ${F} < DATE_ADD(?, INTERVAL 1 DAY)
       AND (g.Name LIKE ? OR g.Code LIKE ? OR g.BarCode1 LIKE ?)
       ${movLocal}
     GROUP BY o.GoodID, o.OperType`,
    movParams
  );

  // Resumen global por tipo de movimiento
  const tiposAgg = {};
  // Por producto: acumular por clase de movimiento
  const porProd = new Map();

  const ensure = (id) => {
    if (!porProd.has(id)) {
      const s = stockMap.get(id);
      porProd.set(id, {
        id,
        codigo: s?.codigo || "",
        nombre: s?.nombre || `Producto ${id}`,
        familia: s?.familia || "",
        costoUnit: num(s?.costoUnit),
        precioUnit: num(s?.precioUnit),
        final: num(s?.final),
        ventas: 0,
        devoluciones: 0,
        entradas: 0,
        mermas: 0,
        transferencias: 0,
        otros: 0,
        netoMov: 0, // suma de Qtty firmada en el período
        importeVentas: 0,
        tipos: {},
      });
    }
    return porProd.get(id);
  };

  // Incluir productos que tienen stock aunque no se movieron
  for (const [id] of stockMap) ensure(id);

  for (const m of movs) {
    const id = num(m.id);
    const tipo = num(m.tipo);
    const row = ensure(id);
    if (!row.nombre || row.nombre.startsWith("Producto ")) {
      // Completar nombre si solo había movimiento
      // (se rellena abajo con consulta si hace falta)
    }
    const vol = num(m.volumen);
    const neto = num(m.neto);
    row.netoMov += neto;
    row.tipos[tipo] = { tipo, nombre: NOMBRE_OPER[tipo] || `Tipo ${tipo}`, volumen: vol, neto, importe: num(m.importe), n: num(m.n) };

    if (!tiposAgg[tipo]) tiposAgg[tipo] = { tipo, nombre: NOMBRE_OPER[tipo] || `Tipo ${tipo}`, volumen: 0, importe: 0, n: 0 };
    tiposAgg[tipo].volumen += vol;
    tiposAgg[tipo].importe += num(m.importe);
    tiposAgg[tipo].n += num(m.n);

    if (tipo === 2) {
      row.ventas += vol;
      row.importeVentas += num(m.importe);
    } else if (tipo === 34) {
      row.devoluciones += vol;
    } else if (tipo === 1 || tipo === 12 || tipo === 27 || tipo === 35) {
      row.entradas += vol;
    } else if (tipo === 3 || tipo === 11) {
      row.mermas += vol;
    } else if (tipo === 7 || tipo === 26) {
      row.transferencias += vol;
    } else {
      row.otros += vol;
    }
  }

  // Completar nombres de productos solo con movimiento
  const faltan = [...porProd.values()].filter((p) => !p.nombre || p.nombre.startsWith("Producto ")).map((p) => p.id);
  if (faltan.length) {
    const nombres = await filas(
      pool,
      `SELECT g.ID AS id, g.Code AS codigo, g.Name AS nombre, COALESCE(gg.Name,'Sin grupo') AS familia, g.PriceIn AS costoUnit, ${PRECIO} AS precioUnit
       FROM goods g LEFT JOIN goodsgroups gg ON gg.ID = g.GroupID WHERE g.ID IN (${faltan.map(() => "?").join(",")})`,
      faltan
    );
    for (const n of nombres) {
      const row = porProd.get(num(n.id));
      if (row) {
        row.codigo = n.codigo;
        row.nombre = n.nombre;
        row.familia = n.familia;
        row.costoUnit = num(n.costoUnit);
        row.precioUnit = num(n.precioUnit);
      }
    }
  }

  // Existencia inicial = final − neto de movimientos del período
  // (neto = suma de Qtty firmadas; ventas restan, entradas suman)
  const pctCostoIpv = ctx.aj?.costoEstimadoPct ?? 10;
  const filasMov = [...porProd.values()].map((p) => {
    const final = p.final;
    const inicio = redondear(final - p.netoMov, 3);
    if (inicio < -0.0005) { /* contado abajo */ }
    const costoU = costoDe(p.costoUnit, p.precioUnit, pctCostoIpv);
    return {
      id: p.id,
      codigo: p.codigo,
      nombre: p.nombre,
      familia: p.familia,
      inicio,
      entradas: redondear(p.entradas, 3),
      ventas: redondear(p.ventas, 3),
      devoluciones: redondear(p.devoluciones, 3),
      mermas: redondear(p.mermas, 3),
      transferencias: redondear(p.transferencias, 3),
      otros: redondear(p.otros, 3),
      final: redondear(final, 3),
      importeVentas: redondear(p.importeVentas),
      valorInicio: redondear(inicio * costoU),
      valorFinal: redondear(final * costoU),
      costoUnit: costoU,
      tipos: Object.values(p.tipos),
    };
  });

  // Orden: más movimiento / más ventas primero
  filasMov.sort((a, b) => b.ventas - a.ventas || Math.abs(b.final) - Math.abs(a.final));

  // Totales
  const tot = filasMov.reduce(
    (a, x) => ({
      inicio: a.inicio + x.inicio,
      entradas: a.entradas + x.entradas,
      ventas: a.ventas + x.ventas,
      devoluciones: a.devoluciones + x.devoluciones,
      mermas: a.mermas + x.mermas,
      final: a.final + x.final,
      importeVentas: a.importeVentas + x.importeVentas,
      valorInicio: a.valorInicio + x.valorInicio,
      valorFinal: a.valorFinal + x.valorFinal,
    }),
    { inicio: 0, entradas: 0, ventas: 0, devoluciones: 0, mermas: 0, final: 0, importeVentas: 0, valorInicio: 0, valorFinal: 0 }
  );

  // Stock valorado por local (como antes)
  const stockLocalParams = [busca, busca, busca];
  let stockLocalFiltro = " AND COALESCE(g.Deleted,0) = 0";
  if (tieneLocal) {
    stockLocalFiltro += " AND s.ObjectID = ?";
    stockLocalParams.push(local);
  }
  const filasStockLocal = await filas(
    pool,
    `SELECT s.ObjectID AS lid, o.Name AS local, g.ID AS id, g.Name AS nombre,
            SUM(s.Qtty) AS cantidad, g.PriceIn AS costoUnit, ${PRECIO} AS precioUnit
     FROM store s JOIN goods g ON g.ID = s.GoodID JOIN objects o ON o.ID = s.ObjectID
     WHERE (g.Name LIKE ? OR g.Code LIKE ? OR g.BarCode1 LIKE ?)${stockLocalFiltro}
     GROUP BY s.ObjectID, o.Name, g.ID, g.Name, g.PriceIn, g.PriceOut1, g.PriceOut2, g.PriceOut3
     HAVING SUM(s.Qtty) > 0.0005`,
    stockLocalParams
  );
  const porLocal = {};
  for (const x of filasStockLocal) {
    const L = x.local || "Sin local";
    const cant = num(x.cantidad);
    const vCosto = cant * (num(x.costoUnit) > 0 ? num(x.costoUnit) : 0);
    const vVenta = cant * (num(x.precioUnit) > 0 ? num(x.precioUnit) : 0);
    if (!porLocal[L]) porLocal[L] = { local: L, lid: x.lid, piezas: 0, costo: 0, venta: 0, refs: 0 };
    porLocal[L].piezas += cant;
    porLocal[L].costo += vCosto;
    porLocal[L].venta += vVenta;
    porLocal[L].refs += 1;
  }

  const locales = await filas(
    pool,
    `SELECT o.ID AS id, o.Name AS nombre FROM objects o
     WHERE EXISTS (SELECT 1 FROM store s WHERE s.ObjectID = o.ID AND ABS(s.Qtty) > 0.0005)
     ORDER BY o.Name`
  );

  return {
    desde,
    hasta,
    resumen: {
      productos: filasMov.length,
      inicio: redondear(tot.inicio, 2),
      avisoInicioNegativo: tot.inicio < -0.5,
      productosInicioNeg: filasMov.filter((x) => num(x.inicio) < -0.0005).length,
      entradas: redondear(tot.entradas, 2),
      ventas: redondear(tot.ventas, 2),
      devoluciones: redondear(tot.devoluciones, 2),
      mermas: redondear(tot.mermas, 2),
      final: redondear(tot.final, 2),
      importeVentas: redondear(tot.importeVentas),
      valorInicio: redondear(tot.valorInicio),
      valorFinal: redondear(tot.valorFinal),
    },
    tiposMovimiento: Object.values(tiposAgg).sort((a, b) => b.volumen - a.volumen),
    porLocal: Object.values(porLocal)
      .map((x) => ({ ...x, piezas: redondear(x.piezas, 2), costo: redondear(x.costo), venta: redondear(x.venta) }))
      .sort((a, b) => b.costo - a.costo),
    locales: locales.map((x) => ({ id: x.id, nombre: x.nombre })),
    // Tabla principal: inicio → movimientos → final
    filas: filasMov.slice(0, 250),
  };
}

// ---------- Sugerencias de traspaso almacén → punto de venta ----------

/** Historia de mercancía de un producto (estilo AxisPOS). */
export async function historialMercancia(pool, ctx, q) {
  const id = parseInt(q.id || q.goodId, 10);
  if (!Number.isInteger(id)) return { error: "Producto no indicado" };
  const { desde, hasta } = ctx.r;
  const local = parseInt(q.local, 10);
  const tieneLocal = Number.isInteger(local);

  const [prod] = await filas(
    pool,
    `SELECT g.ID AS id, g.Code AS codigo, g.Name AS nombre, g.PriceIn AS costo, ${PRECIO} AS precio,
            COALESCE(gg.Name,'Sin grupo') AS familia
     FROM goods g LEFT JOIN goodsgroups gg ON gg.ID = g.GroupID WHERE g.ID = ?`,
    [id]
  );
  if (!prod) return { error: "Producto no encontrado" };

  // Stock actual total / por local
  const stocks = await filas(
    pool,
    `SELECT s.ObjectID AS localId, COALESCE(ob.Name, CONCAT('Local ', s.ObjectID)) AS local, SUM(s.Qtty) AS qty
     FROM store s LEFT JOIN objects ob ON ob.ID = s.ObjectID
     WHERE s.GoodID = ? GROUP BY s.ObjectID, ob.Name`,
    [id]
  );
  const stockTotal = stocks.reduce((a, x) => a + num(x.qty), 0);

  let localSql = "";
  const params = [id, desde, hasta];
  if (tieneLocal) {
    localSql = " AND EXISTS (SELECT 1 FROM shift sh WHERE sh.ID = o.ShiftID AND sh.ObjectID = ?)";
    params.push(local);
  }

  const movs = await filas(
    pool,
    `SELECT o.ID AS id,
            DATE_FORMAT(${F}, '%Y-%m-%d %H:%i') AS fecha,
            o.OperType AS tipo,
            o.Qtty AS cant,
            o.PriceOut AS precio,
            o.PriceIn AS costo,
            ${IMP} AS importe,
            o.Acct AS ticket,
            o.Note AS nota,
            COALESCE(u.Name, '') AS usuario,
            COALESCE(ob.Name, '') AS local
     FROM operations o
     LEFT JOIN users u ON u.ID = o.UserID
     LEFT JOIN shift sh ON sh.ID = o.ShiftID
     LEFT JOIN objects ob ON ob.ID = sh.ObjectID
     WHERE o.GoodID = ? AND ${F} >= ? AND ${F} < DATE_ADD(?, INTERVAL 1 DAY)${localSql}
     ORDER BY ${F} ASC, o.ID ASC
     LIMIT 2000`,
    params
  );

  // Nombres de tipos habituales AxisPOS
  const NOM = {
    1: "Compra / entrada",
    2: "Venta",
    3: "Merma / baja",
    7: "Transferencia salida",
    8: "Transferencia entrada",
    11: "Ajuste",
    12: "Producción",
    16: "Stock-taking / conteo",
    34: "Devolución",
  };

  // Reconstruir existencia corrida hacia el final conocido
  // final actual; restamos movimientos posteriores al 'hasta' no están; dentro del rango:
  // empezamos desde stock actual, restamos neto de TODOS los movs desde 'desde' hasta ahora fuera del listado es complejo.
  // Enfoque práctico: existencia final = stock actual; ir hacia atrás desde el último movimiento del rango.
  let corrida = stockTotal;
  // movimientos posteriores a 'hasta' no están en la lista; stock actual incluye todo.
  // Para el listado: calculamos hacia atrás desde el final del periodo ≈ stock actual si hasta=hoy.
  const detalle = [];
  // Primero neto del periodo
  const neto = movs.reduce((a, m) => a + num(m.cant), 0);
  // inicio periodo ≈ final - neto (si no hubo mov fuera y stock actual es final)
  let saldo = redondear(stockTotal - 0, 3); // asumimos hasta ≈ hoy
  // Ajuste: si el periodo no llega a hoy, no es exacto; documentamos.

  // Rehacer: ir de más antiguo a más reciente partiendo de inicio = final - suma(cant en periodo)
  let inicio = redondear(stockTotal - neto, 3);
  let running = inicio;
  for (const m of movs) {
    const cant = num(m.cant);
    const entrada = cant > 0 ? cant : 0;
    const salida = cant < 0 ? Math.abs(cant) : 0;
    running = redondear(running + cant, 3);
    detalle.push({
      id: m.id,
      fecha: m.fecha,
      tipo: m.tipo,
      operacion: NOM[m.tipo] || `Tipo ${m.tipo}`,
      entrada: entrada || null,
      salida: salida || null,
      cant,
      importe: num(m.importe),
      costo: num(m.costo),
      precio: num(m.precio),
      final: running,
      ticket: m.ticket,
      usuario: m.usuario,
      local: m.local,
      nota: m.nota || "",
    });
  }

  return {
    producto: {
      id: prod.id,
      codigo: prod.codigo,
      nombre: prod.nombre,
      familia: prod.familia,
      costo: num(prod.costo),
      precio: num(prod.precio),
    },
    stockTotal: redondear(stockTotal, 3),
    stocks,
    desde,
    hasta,
    inicio: redondear(inicio, 3),
    final: redondear(running, 3),
    movimientos: detalle.length,
    filas: detalle,
  };
}

export async function traspasos(pool, ctx, q) {
  const aj = ctx.aj;
  const { desde, hasta } = ctx.r;
  const dias = Math.max(ctx.r.dias || aj.ventanaVentas || 30, 7);
  // Días de cobertura objetivo en el punto de venta
  const diasObjetivo = Math.max(parseInt(q.dias, 10) || aj.cobertura || 14, 3);

  // Locales con ventas en el período (candidatos a punto de venta) vía turnos
  let ventasPorLocal;
  try {
    ventasPorLocal = await filas(
      pool,
      `SELECT sh.ObjectID AS lid, obj.Name AS local, COUNT(DISTINCT o.Acct) AS tickets, COALESCE(SUM(${IMP}),0) AS total
       FROM operations o
       JOIN shift sh ON sh.ID = o.ShiftID
       JOIN objects obj ON obj.ID = sh.ObjectID
       WHERE ${VENTA} AND ${RANGO}
       GROUP BY sh.ObjectID, obj.Name
       ORDER BY total DESC`,
      [desde, hasta]
    );
  } catch {
    ventasPorLocal = await filas(
      pool,
      `SELECT o.ID AS lid, o.Name AS local, 0 AS tickets, 0 AS total FROM objects o
       WHERE EXISTS (SELECT 1 FROM store s WHERE s.ObjectID = o.ID AND s.Qtty > 0) ORDER BY o.Name`
    );
  }

  const pctCosto = aj.costoEstimadoPct;
  const stockPorLocal = await filas(
    pool,
    `SELECT s.ObjectID AS lid, o.Name AS local, s.GoodID AS gid, g.Code AS codigo, g.Name AS nombre,
            COALESCE(gg.Name,'Sin grupo') AS familia, SUM(s.Qtty) AS cant, g.PriceIn AS costo, ${PRECIO} AS precio,
            COALESCE(g.MinQtty, 0) AS minimo
     FROM store s
     JOIN objects o ON o.ID = s.ObjectID
     JOIN goods g ON g.ID = s.GoodID
     LEFT JOIN goodsgroups gg ON gg.ID = g.GroupID
     WHERE COALESCE(g.Deleted,0) = 0
     GROUP BY s.ObjectID, o.Name, s.GoodID, g.Code, g.Name, gg.Name, g.PriceIn, g.PriceOut1, g.PriceOut2, g.PriceOut3, g.MinQtty
     HAVING SUM(s.Qtty) > 0.0005`
  );

  // Ventas por producto (global en el período) para estimar demanda diaria
  const ventasProd = await filas(
    pool,
    `SELECT o.GoodID AS gid, SUM(ABS(o.Qtty)) AS unidades
     FROM operations o WHERE ${VENTA} AND ${RANGO}
     GROUP BY o.GoodID`,
    [desde, hasta]
  );
  const demanda = new Map(ventasProd.map((x) => [num(x.gid), num(x.unidades) / dias]));

  // Clasificar locales: con ventas = PV; sin ventas pero con stock = almacén
  const lidsConVenta = new Set(ventasPorLocal.filter((x) => num(x.tickets) > 0 || num(x.total) > 0).map((x) => num(x.lid)));
  const todosLids = [...new Set(stockPorLocal.map((x) => num(x.lid)))];
  const pvLids = lidsConVenta.size ? lidsConVenta : new Set(todosLids.slice(0, 1));
  const almLids = new Set(todosLids.filter((id) => !pvLids.has(id)));
  // Si no hay almacén distinto, usar el local con más stock y menos ventas como "almacén"
  if (almLids.size === 0 && todosLids.length > 1) {
    const ranking = todosLids.map((id) => {
      const st = stockPorLocal.filter((s) => num(s.lid) === id).reduce((a, s) => a + num(s.cant), 0);
      const vt = ventasPorLocal.find((v) => num(v.lid) === id);
      return { id, st, tickets: num(vt?.tickets) };
    }).sort((a, b) => a.tickets - b.tickets || b.st - a.st);
    if (ranking[0]) almLids.add(ranking[0].id);
  }

  // Stock index + inversión por local
  const idx = new Map();
  const inversionPorLocal = {};
  let inversionTotal = 0;
  for (const s of stockPorLocal) {
    const gid = num(s.gid);
    const costoU = costoDe(s.costo, s.precio, pctCosto);
    const cant = num(s.cant);
    const inv = cant * costoU;
    inversionTotal += inv;
    const L = s.local || "Sin local";
    if (!inversionPorLocal[L]) inversionPorLocal[L] = { local: L, lid: num(s.lid), piezas: 0, inversion: 0, refs: 0, esPv: pvLids.has(num(s.lid)), esAlm: almLids.has(num(s.lid)) };
    inversionPorLocal[L].piezas += cant;
    inversionPorLocal[L].inversion += inv;
    inversionPorLocal[L].refs += 1;

    if (!idx.has(gid)) {
      idx.set(gid, {
        id: gid,
        codigo: s.codigo,
        nombre: s.nombre,
        familia: s.familia,
        costo: costoU,
        costoReal: num(s.costo) > 0,
        precio: num(s.precio),
        minimo: num(s.minimo),
        enPv: 0,
        enAlm: 0,
        detallePv: [],
        detalleAlm: [],
      });
    }
    const row = idx.get(gid);
    if (num(s.minimo) > row.minimo) row.minimo = num(s.minimo);
    const lid = num(s.lid);
    if (pvLids.has(lid)) {
      row.enPv += cant;
      row.detallePv.push({ local: s.local, cant });
    }
    if (almLids.has(lid)) {
      row.enAlm += cant;
      row.detalleAlm.push({ local: s.local, cant });
    }
  }

  const sugerencias = [];
  for (const row of idx.values()) {
    const diaria = demanda.get(row.id) || 0;
    if (row.enAlm <= 0.0005) continue;
    // Objetivo en PV: el mayor entre mínimo de ficha, stock nominal por días de cobertura, y el mínimo operativo
    const porCobertura = diaria > 0 ? diaria * diasObjetivo : 0;
    const minimo = row.minimo > 0 ? row.minimo : 0;
    // Stock nominal ≈ cobertura por venta; si no hay venta pero hay mínimo, usar el mínimo
    const nominal = Math.max(porCobertura, minimo);
    if (nominal <= 0) continue; // sin mínimo ni venta: no sugerir
    if (row.enPv >= nominal - 0.0005) continue; // ya tiene suficiente en PV
    let pedir = nominal - row.enPv;
    pedir = Math.min(pedir, row.enAlm);
    pedir = redondear(pedir, 2);
    if (pedir < 0.01) continue;
    const coberturaPv = diaria > 0 ? row.enPv / diaria : (row.enPv > 0 ? 999 : 0);
    const bajoMinimo = minimo > 0 && row.enPv < minimo;
    const urgencia = bajoMinimo || coberturaPv <= 3 ? "alta" : coberturaPv <= 7 || (minimo > 0 && row.enPv < minimo * 1.5) ? "media" : "baja";
    sugerencias.push({
      id: row.id,
      codigo: row.codigo,
      nombre: row.nombre,
      familia: row.familia,
      diaria: redondear(diaria, 2),
      minimo: redondear(minimo, 2),
      nominal: redondear(nominal, 2),
      enPv: redondear(row.enPv, 2),
      enAlm: redondear(row.enAlm, 2),
      coberturaPv: redondear(coberturaPv, 1),
      sugerido: pedir,
      valorCosto: redondear(pedir * row.costo),
      costoEstimado: !row.costoReal,
      urgencia,
      motivo: bajoMinimo ? "Bajo el mínimo de ficha" : porCobertura >= minimo ? "Cubrir días de venta" : "Alcanzar mínimo",
      desde: row.detalleAlm.map((d) => `${d.local}: ${redondear(d.cant, 1)}`).join(", "),
      hacia: row.detallePv.map((d) => `${d.local}: ${redondear(d.cant, 1)}`).join(", ") || "Punto de venta",
    });
  }
  sugerencias.sort((a, b) => {
    const u = { alta: 0, media: 1, baja: 2 };
    return (u[a.urgencia] - u[b.urgencia]) || b.sugerido - a.sugerido;
  });

  const localesPv = [...pvLids].map((id) => {
    const v = ventasPorLocal.find((x) => num(x.lid) === id);
    const n = stockPorLocal.find((x) => num(x.lid) === id);
    return { id, nombre: v?.local || n?.local || String(id), tickets: num(v?.tickets) };
  });
  const localesAlm = [...almLids].map((id) => {
    const n = stockPorLocal.find((x) => num(x.lid) === id);
    return { id, nombre: n?.local || String(id) };
  });

  return {
    dias,
    diasObjetivo,
    costoEstimadoPct: pctCosto,
    puntosVenta: localesPv,
    almacenes: localesAlm,
    inversion: {
      total: redondear(inversionTotal),
      porLocal: Object.values(inversionPorLocal)
        .map((x) => ({
          local: x.local,
          lid: x.lid,
          piezas: redondear(x.piezas, 2),
          inversion: redondear(x.inversion),
          refs: x.refs,
          tipo: x.esPv && x.esAlm ? "mixto" : x.esPv ? "punto de venta" : x.esAlm ? "almacén" : "otro",
        }))
        .sort((a, b) => b.inversion - a.inversion),
    },
    resumen: {
      productos: sugerencias.length,
      unidades: redondear(sugerencias.reduce((s, x) => s + x.sugerido, 0), 1),
      valorCosto: redondear(sugerencias.reduce((s, x) => s + x.valorCosto, 0)),
      altas: sugerencias.filter((x) => x.urgencia === "alta").length,
    },
    filas: sugerencias.slice(0, 120),
  };
}

// ---------- Caja y cierres ----------
/**
 * Cuadre alineado con AxisPOS:
 * - DiffClose oficial de Axis
 * - Esperado = TotalOpen + libro de caja del turno − TotalWithdrawal
 * - PriceOut ya incluye descuento; no se vuelve a restar
 * - Solo ventas finalizadas (Sign < 0)
 */
export async function caja(pool, ctx, q) {
  const { desde, hasta } = ctx.r;
  const tol = num(ctx.aj?.tolCierre) || 500;
  const pagina = Math.max(parseInt(q.pagina, 10) || 1, 1);
  const filtroU = ctx.uid != null ? " AND sh.UserID = ?" : "";
  const params = ctx.uid != null ? [desde, hasta, ctx.uid] : [desde, hasta];

  const todos = await filas(
    pool,
    `SELECT sh.ID AS id, o.Name AS local, u.Name AS usuario,
            DATE_FORMAT(sh.DateTimeOpen,'%Y-%m-%d %H:%i:%s') AS apertura,
            DATE_FORMAT(sh.DateTimeClose,'%Y-%m-%d %H:%i:%s') AS cierre,
            sh.TotalOpen AS inicial, sh.TotalFinal AS contado,
            sh.TotalWithdrawal AS retiro, sh.DiffClose AS difAxis,
            COALESCE(v.total,0) AS ventas, COALESCE(v.tickets,0) AS tickets,
            COALESCE(d.total,0) AS devoluciones,
            COALESCE(cb.neto,0) AS libroCaja,
            COALESCE(cb.entradas,0) AS libroEntradas,
            COALESCE(cb.salidas,0) AS libroSalidas,
            COALESCE(pg.efectivo,0) AS pagosEfectivo,
            COALESCE(pg.tarjeta,0) AS pagosTarjeta,
            COALESCE(pg.transfer,0) AS pagosTransfer,
            COALESCE(pg.otros,0) AS pagosOtros,
            COALESCE(pg.todos,0) AS pagosTodos
     FROM shift sh
     LEFT JOIN objects o ON o.ID = sh.ObjectID
     LEFT JOIN users u ON u.ID = sh.UserID
     LEFT JOIN (
       SELECT o.ShiftID, SUM(${IMP}) AS total, COUNT(DISTINCT o.Acct) AS tickets
       FROM operations o WHERE ${VENTA} GROUP BY o.ShiftID
     ) v ON v.ShiftID = sh.ID
     LEFT JOIN (
       SELECT o.ShiftID, SUM(${IMP}) AS total
       FROM operations o WHERE ${DEVOL} GROUP BY o.ShiftID
     ) d ON d.ShiftID = sh.ID
     LEFT JOIN (
       SELECT ShiftID,
              SUM(CASE WHEN COALESCE(Sign,0) >= 0 THEN COALESCE(Profit,0) ELSE 0 END) AS entradas,
              SUM(CASE WHEN COALESCE(Sign,0) < 0 THEN COALESCE(Profit,0) ELSE 0 END) AS salidas,
              SUM(COALESCE(Sign,0) * COALESCE(Profit,0)) AS neto
       FROM cashbook
       GROUP BY ShiftID
     ) cb ON cb.ShiftID = sh.ID
     LEFT JOIN (
       SELECT ShiftID,
              SUM(CASE WHEN Mode = 1 THEN Qtty ELSE 0 END) AS efectivo,
              SUM(CASE WHEN Mode = 2 THEN Qtty ELSE 0 END) AS tarjeta,
              SUM(CASE WHEN Mode = 3 THEN Qtty ELSE 0 END) AS transfer,
              SUM(CASE WHEN Mode NOT IN (1,2,3) THEN Qtty ELSE 0 END) AS otros,
              SUM(Qtty) AS todos
       FROM payments WHERE OperType = 2
       GROUP BY ShiftID
     ) pg ON pg.ShiftID = sh.ID
     WHERE sh.DateTimeOpen >= ? AND sh.DateTimeOpen < DATE_ADD(?, INTERVAL 1 DAY)${filtroU}
     ORDER BY sh.DateTimeOpen DESC`,
    params
  ).catch(async (err) => {
    // Si cashbook no existe, degradar sin libro
    console.error("caja query", err.message);
    return filas(
      pool,
      `SELECT sh.ID AS id, o.Name AS local, u.Name AS usuario,
              DATE_FORMAT(sh.DateTimeOpen,'%Y-%m-%d %H:%i:%s') AS apertura,
              DATE_FORMAT(sh.DateTimeClose,'%Y-%m-%d %H:%i:%s') AS cierre,
              sh.TotalOpen AS inicial, sh.TotalFinal AS contado,
              sh.TotalWithdrawal AS retiro, sh.DiffClose AS difAxis,
              COALESCE(v.total,0) AS ventas, COALESCE(v.tickets,0) AS tickets,
              COALESCE(d.total,0) AS devoluciones,
              0 AS libroCaja, 0 AS libroEntradas, 0 AS libroSalidas,
              COALESCE(pg.efectivo,0) AS pagosEfectivo,
              COALESCE(pg.tarjeta,0) AS pagosTarjeta,
              COALESCE(pg.transfer,0) AS pagosTransfer,
              COALESCE(pg.otros,0) AS pagosOtros,
              COALESCE(pg.todos,0) AS pagosTodos
       FROM shift sh
       LEFT JOIN objects o ON o.ID = sh.ObjectID
       LEFT JOIN users u ON u.ID = sh.UserID
       LEFT JOIN (
         SELECT o.ShiftID, SUM(${IMP}) AS total, COUNT(DISTINCT o.Acct) AS tickets
         FROM operations o WHERE ${VENTA} GROUP BY o.ShiftID
       ) v ON v.ShiftID = sh.ID
       LEFT JOIN (
         SELECT o.ShiftID, SUM(${IMP}) AS total FROM operations o WHERE ${DEVOL} GROUP BY o.ShiftID
       ) d ON d.ShiftID = sh.ID
       LEFT JOIN (
         SELECT ShiftID,
                SUM(CASE WHEN Mode = 1 THEN Qtty ELSE 0 END) AS efectivo,
                SUM(CASE WHEN Mode = 2 THEN Qtty ELSE 0 END) AS tarjeta,
                SUM(CASE WHEN Mode = 3 THEN Qtty ELSE 0 END) AS transfer,
                SUM(CASE WHEN Mode NOT IN (1,2,3) THEN Qtty ELSE 0 END) AS otros,
                SUM(Qtty) AS todos
         FROM payments WHERE OperType = 2 GROUP BY ShiftID
       ) pg ON pg.ShiftID = sh.ID
       WHERE sh.DateTimeOpen >= ? AND sh.DateTimeOpen < DATE_ADD(?, INTERVAL 1 DAY)${filtroU}
       ORDER BY sh.DateTimeOpen DESC`,
      params
    );
  });

  const turnos = todos.map((t) => {
    const ventas = num(t.ventas);
    const dev = num(t.devoluciones);
    const contado = num(t.contado);
    const inicial = num(t.inicial);
    const retiro = num(t.retiro);
    const libro = num(t.libroCaja);
    // En Axis: neto libro ≈ SUM(Sign * Profit); Sign +1 entrada, -1 salida
    // Esperado efectivo = fondo + movimientos de libro - retirada
    const esperado = redondear(inicial + libro - retiro);
    const difAxis = t.difAxis == null ? null : num(t.difAxis);
    const cerrado = !!(t.cierre && String(t.cierre) !== "0000-00-00 00:00:00");
    // Axis DiffClose = esperado − contado
    const difCalc = cerrado ? redondear(esperado - contado) : null;
    const diferencia = difAxis != null ? redondear(difAxis) : difCalc;
    const sinContar = cerrado && contado === 0 && Math.abs(esperado) > 1;
    const pagosTodos = num(t.pagosTodos);
    const difPagos = redondear(pagosTodos - (ventas - dev));

    // Cierres sin conteo: DiffClose de Axis ≈ todo el esperado; NO es faltante real.
    let nivel = "ok";
    if (sinContar) nivel = "media";
    else if (diferencia != null && Math.abs(diferencia) > tol)
      nivel = Math.abs(diferencia) > tol * 3 ? "alta" : "media";
    const difReal = sinContar ? null : diferencia;

    return {
      id: t.id,
      local: t.local,
      usuario: t.usuario,
      apertura: t.apertura,
      cierre: t.cierre,
      tickets: num(t.tickets),
      ventas,
      devoluciones: dev,
      retiro,
      inicial,
      libroCaja: redondear(libro),
      libroEntradas: redondear(num(t.libroEntradas)),
      libroSalidas: redondear(num(t.libroSalidas)),
      esperado,
      contado,
      diferencia: difReal != null ? difReal : (sinContar ? null : diferencia),
      diferenciaAxis: diferencia,
      difAxis,
      difCalc,
      nivel,
      sinContar,
      estadoCierre: !cerrado ? "Abierto" : sinContar ? "Cerrado sin contar" : "Cerrado",
      pagosEfectivo: num(t.pagosEfectivo),
      pagosTarjeta: num(t.pagosTarjeta),
      pagosTransfer: num(t.pagosTransfer),
      pagosOtros: num(t.pagosOtros),
      pagos: pagosTodos,
      difPagos,
      formasPago: [
        { modo: 1, nombre: "Efectivo", total: num(t.pagosEfectivo) },
        { modo: 2, nombre: "Tarjeta", total: num(t.pagosTarjeta) },
        { modo: 3, nombre: "Transferencia", total: num(t.pagosTransfer) },
        { modo: 0, nombre: "Otros", total: num(t.pagosOtros) },
      ].filter((x) => Math.abs(x.total) > 0.001),
      sinCierre: !cerrado,
      horasTurno:
        t.cierre && t.apertura
          ? redondear(
              (new Date(String(t.cierre).replace(" ", "T")) -
                new Date(String(t.apertura).replace(" ", "T"))) /
                3600000,
              2
            )
          : null,
      metodo: difAxis != null ? "DiffClose AxisPOS" : "libro de caja",
    };
  });

  const ventasTot = turnos.reduce((s, t) => s + t.ventas, 0);
  const conDif = turnos.filter((t) => !t.sinContar && t.diferencia != null && Math.abs(t.diferencia) > tol);
  const paginas = Math.max(Math.ceil(turnos.length / 20), 1);

  const porCajeroMap = new Map();
  for (const t of turnos) {
    const k = t.usuario || "Sin nombre";
    if (!porCajeroMap.has(k))
      porCajeroMap.set(k, {
        usuario: k, turnos: 0, conDif: 0, faltante: 0, sobrante: 0,
        totalDif: 0, maxFaltante: 0, maxSobrante: 0, sinContar: 0,
      });
    const c = porCajeroMap.get(k);
    c.turnos += 1;
    if (t.sinContar) {
      c.sinContar += 1;
      continue; // no suma al faltante/sobrante del neto
    }
    if (t.diferencia == null) continue;
    c.totalDif += t.diferencia;
    // DiffClose = esperado − contado → positivo = faltante
    if (t.diferencia > 0.009) {
      c.faltante += t.diferencia;
      c.maxFaltante = Math.max(c.maxFaltante, t.diferencia);
      if (Math.abs(t.diferencia) > tol) c.conDif += 1;
    } else if (t.diferencia < -0.009) {
      c.sobrante += -t.diferencia;
      c.maxSobrante = Math.max(c.maxSobrante, -t.diferencia);
      if (Math.abs(t.diferencia) > tol) c.conDif += 1;
    }
  }
  const porCajero = [...porCajeroMap.values()]
    .map((c) => ({
      ...c,
      faltante: redondear(c.faltante),
      sobrante: redondear(c.sobrante),
      totalDif: redondear(c.totalDif),
      maxFaltante: redondear(c.maxFaltante),
      maxSobrante: redondear(c.maxSobrante),
    }))
    .sort((a, b) => Math.abs(b.totalDif) - Math.abs(a.totalDif));

  const formas = await filas(
    pool,
    `SELECT COALESCE(p.Company,'Sin socio') AS socio, COUNT(DISTINCT o.Acct) AS tickets, SUM(${IMP}) AS total
     FROM operations o LEFT JOIN partners p ON p.ID = o.PartnerID
     WHERE ${VENTA} AND ${RANGO}${uid(ctx)} GROUP BY p.ID, p.Company ORDER BY total DESC`,
    parRango(ctx, desde, hasta)
  ).catch(() => []);

  const dv = await filas(
    pool,
    `SELECT COALESCE(SUM(${IMP}),0) AS total FROM operations o WHERE ${DEVOL} AND ${RANGO}${uid(ctx)}`,
    parRango(ctx, desde, hasta)
  ).catch(() => [{ total: 0 }]);

  return {
    ventas: ventasTot,
    devoluciones: num(dv[0]?.total),
    neto: ventasTot - num(dv[0]?.total),
    turnos: turnos.length,
    conDiferencia: conDif.length,
    cerradosSinContar: turnos.filter((t) => t.sinContar).length,
    faltante: redondear(conDif.filter((t) => t.diferencia > 0).reduce((s, t) => s + t.diferencia, 0)),
    sobrante: redondear(conDif.filter((t) => t.diferencia < 0).reduce((s, t) => s + Math.abs(t.diferencia), 0)),
    sinCuadrar: turnos.filter((t) => Math.abs(t.difPagos) > 1 && t.ventas > 0).length,
    tolerancia: tol,
    nota:
      "Faltante/sobrante solo de turnos CON conteo físico. Los cierres sin contar no suman al neto (Axis deja DiffClose = esperado cuando contado=0).",
    formasPago: formas.map((x) => ({ socio: x.socio, tickets: num(x.tickets), total: num(x.total) })),
    porCajero,
    pagina,
    paginas,
    filas: q.todo ? turnos : turnos.slice((pagina - 1) * 20, pagina * 20),
  };
}


// ---------- Equipo ----------
export async function equipo(pool, ctx) {
  const { desde, hasta } = ctx.r;
  const P = [desde, hasta];
  const [vt, dv] = await Promise.all([
    filas(pool, `SELECT o.UserID AS id, u.Name AS nombre, u.UserLevel AS nivel, COALESCE(ug.Name, 'Sistema') AS grupo, SUM(${IMP}) AS total, COUNT(DISTINCT o.Acct) AS tickets
      FROM operations o LEFT JOIN users u ON u.ID = o.UserID LEFT JOIN usersgroups ug ON ug.ID = u.GroupID
      WHERE ${VENTA} AND ${RANGO} GROUP BY o.UserID, u.Name, u.UserLevel, ug.Name ORDER BY total DESC`, P),
    filas(pool, `SELECT o.UserID AS id, SUM(${IMP}) AS total FROM operations o WHERE ${DEVOL} AND ${RANGO} GROUP BY o.UserID`, P),
  ]);
  const dmap = new Map(dv.map((x) => [x.id, num(x.total)]));
  const max = Math.max(1, ...vt.map((x) => num(x.total)));
  return vt.map((x) => ({
    id: x.id, nombre: x.nombre || `Usuario ${x.id}`, grupo: x.grupo, rol: ctx.rolDe(x.id, x.nivel), total: num(x.total),
    tickets: num(x.tickets), devoluciones: dmap.get(x.id) || 0, parte: num(x.total) / max,
  }));
}

export async function equipoModo(pool, ctx, q = {}) {
  const modo = String(q.modo || "lista");
  if (modo === "ranking") return rankingEquipo(pool, ctx);
  if (modo === "productividad" || modo === "prod") return productividad(pool, ctx);
  if (modo === "turnos" || modo === "horario") return turnosHorario(pool, ctx);
  if (modo === "duracion") return duracionTurnos(pool, ctx);
  return equipoCompleto(pool, ctx);
}

export async function equipoCompleto(pool, ctx) {
  const [lista, formas, cajaData] = await Promise.all([
    equipo(pool, ctx),
    filas(pool, `SELECT COALESCE(p.Company,'Sin socio') AS socio, COUNT(DISTINCT o.Acct) AS tickets, SUM(${IMP}) AS total
      FROM operations o LEFT JOIN partners p ON p.ID = o.PartnerID WHERE ${VENTA} AND ${RANGO} GROUP BY p.ID, p.Company ORDER BY total DESC`, [ctx.r.desde, ctx.r.hasta]),
    caja(pool, { ...ctx, uid: null }, { todo: true }).catch(() => ({ porCajero: [] })),
  ]);
  const cajaMap = new Map((cajaData.porCajero || []).map((c) => [c.usuario, c]));
  const cajeros = lista.map((x) => {
    const c = cajaMap.get(x.nombre) || {};
    const señales = [];
    if (num(c.faltante) > (ctx.aj?.tolCierre || 500) * 3) señales.push({ nivel: "alta", texto: "Faltante alto" });
    if (num(c.sinContar) >= 2) señales.push({ nivel: "media", texto: `${c.sinContar} sin contar` });
    if (num(c.conDif) >= 3) señales.push({ nivel: "media", texto: `${c.conDif} fuera tol.` });
    return {
      ...x,
      faltante: num(c.faltante),
      sobrante: num(c.sobrante),
      sinContar: num(c.sinContar),
      turnosDif: num(c.conDif),
      señales,
    };
  });
  return {
    cajeros,
    socios: formas.map((x) => ({ socio: x.socio, tickets: num(x.tickets), total: num(x.total) })),
  };
}

// ---------- Inventario: alertas, ABC, compras ----------
let invCache = { t: 0, clave: "", v: null };
export async function datosInventario(pool, ctx) {
  const aj = ctx.aj;
  const clave = `${aj.ventanaVentas}|${aj.plazoRepos}|${aj.seguridad}|${aj.cobertura}|${ctx.r.ultimo}`;
  if (invCache.v && invCache.clave === clave && Date.now() - invCache.t < 60000) return invCache.v;
  const hasta = ctx.r.ultimo;
  const desde = sumarDias(hasta, -(aj.ventanaVentas - 1));
  const lista = await filas(
    pool,
    `SELECT g.ID AS id, g.Code AS codigo, g.Name AS nombre, COALESCE(gg.Name,'Sin grupo') AS familia, g.PriceIn AS costo,
            ${PRECIO} AS precio, g.MinQtty AS minimo, COALESCE(s.cant,0) AS stock, COALESCE(v.unidades,0) AS unidades, COALESCE(v.total,0) AS importe
     FROM goods g LEFT JOIN goodsgroups gg ON gg.ID = g.GroupID LEFT JOIN ${STOCK} s ON s.GoodID = g.ID
     LEFT JOIN (SELECT o.GoodID, SUM(ABS(o.Qtty)) AS unidades, SUM(${IMP}) AS total FROM operations o WHERE ${VENTA} AND ${RANGO} GROUP BY o.GoodID) v ON v.GoodID = g.ID
     WHERE COALESCE(g.Deleted,0) = 0 AND (ABS(COALESCE(s.cant,0)) > 0.0005 OR COALESCE(v.unidades,0) > 0)`,
    [desde, hasta]
  );
  const items = lista.map((x) => {
    const stock = num(x.stock), unidades = num(x.unidades), diaria = unidades / aj.ventanaVentas;
    const reorden = diaria * (aj.plazoRepos + aj.seguridad);
    return {
      id: x.id, codigo: x.codigo, nombre: x.nombre, familia: x.familia, costo: num(x.costo), precio: num(x.precio),
      minimo: num(x.minimo), stock, unidades, importe: num(x.importe), diaria, reorden,
      cobertura: diaria > 0 ? Math.max(stock, 0) / diaria : null,
    };
  });
  // ABC por importe vendido en la ventana
  const conVenta = items.filter((x) => x.importe > 0).sort((a, b) => b.importe - a.importe);
  const totalImp = conVenta.reduce((s, x) => s + x.importe, 0) || 1;
  let acum = 0;
  for (const x of conVenta) {
    const antes = acum / totalImp;
    acum += x.importe;
    x.clase = antes < 0.8 ? "A" : antes < 0.95 ? "B" : "C";
    x.acum = acum / totalImp;
  }
  for (const x of items) if (!x.clase) x.clase = "-";
  const v = { items, desde, hasta, totalImp };
  invCache = { t: Date.now(), clave, v };
  return v;
}

export async function inventarioModo(pool, ctx, q = {}) {
  const modo = String(q.modo || "alertas");
  if (modo === "abc") return analisisABC(pool, ctx, q);
  if (modo === "compras") return sugerenciasCompra(pool, ctx);
  if (modo === "antiguedad") return antiguedadStock(pool, ctx);
  if (modo === "ipv") return ipv(pool, ctx, q);
  if (modo === "traspasos") return traspasos(pool, ctx, q);
  if (modo === "hechos" || modo === "traspasos-hechos") return traspasosHechos(pool, ctx, q);
  if (modo === "existencias" || modo === "stock") return existencias(pool, ctx, q);
  if (modo === "lista-arqueo" || modo === "arqueo") return listaArqueo(pool, ctx, q);
  return alertasStock(pool, ctx);
}

export async function alertasStock(pool, ctx) {
  const d = await datosInventario(pool, ctx);
  const aj = ctx.aj;
  const alertas = [];
  for (const x of d.items) {
    let tipo = null, nivel = "media";
    if (x.stock <= 0.0005 && x.unidades > 0) { tipo = "agotado"; nivel = "alta"; }
    else if (x.minimo > 0 && x.stock <= x.minimo) { tipo = "minimo"; nivel = x.stock <= x.minimo / 2 ? "alta" : "media"; }
    else if (x.diaria > 0 && x.stock <= x.reorden) { tipo = "reorden"; nivel = x.cobertura <= aj.plazoRepos ? "alta" : "media"; }
    if (tipo) alertas.push({ ...x, tipo, nivel });
  }
  alertas.sort((a, b) => (a.nivel === b.nivel ? (a.cobertura ?? -1) - (b.cobertura ?? -1) : a.nivel === "alta" ? -1 : 1));
  return {
    ventana: aj.ventanaVentas, plazo: aj.plazoRepos, seguridad: aj.seguridad,
    resumen: { agotados: alertas.filter((a) => a.tipo === "agotado").length, minimo: alertas.filter((a) => a.tipo === "minimo").length, reorden: alertas.filter((a) => a.tipo === "reorden").length, altas: alertas.filter((a) => a.nivel === "alta").length },
    filas: alertas.slice(0, 150).map(({ id, codigo, nombre, familia, stock, minimo, diaria, reorden, cobertura, tipo, nivel, clase }) => ({ id, codigo, nombre, familia, stock, minimo, diaria, reorden, cobertura, tipo, nivel, clase })),
    total: alertas.length,
  };
}

export async function analisisABC(pool, ctx, q) {
  const d = await datosInventario(pool, ctx);
  const clases = { A: { n: 0, importe: 0 }, B: { n: 0, importe: 0 }, C: { n: 0, importe: 0 } };
  for (const x of d.items) if (clases[x.clase]) { clases[x.clase].n++; clases[x.clase].importe += x.importe; }
  const quietos = d.items.filter((x) => x.stock > 0.0005 && x.unidades === 0);
  const capital = quietos.reduce((s, x) => s + x.stock * (x.costo > 0 ? x.costo : x.precio), 0);
  const clase = ["A", "B", "C", "S"].includes(q.clase) ? q.clase : "A";
  const sel = clase === "S" ? quietos.sort((a, b) => b.stock * b.precio - a.stock * a.precio) : d.items.filter((x) => x.clase === clase);
  return {
    ventana: ctx.aj.ventanaVentas, totalImporte: d.totalImp,
    clases: Object.fromEntries(Object.entries(clases).map(([k, v]) => [k, { n: v.n, importe: v.importe, pct: v.importe / d.totalImp }])),
    sinMovimiento: { n: quietos.length, capital },
    clase, filas: sel.slice(0, 100).map((x) => ({ id: x.id, nombre: x.nombre, familia: x.familia, stock: x.stock, unidades: x.unidades, importe: x.importe, acum: x.acum ?? null, precio: x.precio })),
  };
}

export async function sugerenciasCompra(pool, ctx) {
  const d = await datosInventario(pool, ctx);
  const aj = ctx.aj;
  const filasC = [];
  for (const x of d.items) {
    if (!(x.diaria > 0) || x.stock > x.reorden) continue;
    const objetivo = x.diaria * (aj.cobertura + aj.seguridad);
    const pedir = Math.ceil(objetivo - Math.max(x.stock, 0));
    if (pedir <= 0) continue;
    filasC.push({ id: x.id, codigo: x.codigo, nombre: x.nombre, familia: x.familia, clase: x.clase, stock: x.stock, diaria: x.diaria, cobertura: x.cobertura, pedir, costo: x.costo, estimado: x.costo > 0 ? pedir * x.costo : null });
  }
  const orden = { A: 0, B: 1, C: 2, "-": 3 };
  filasC.sort((a, b) => orden[a.clase] - orden[b.clase] || (a.cobertura ?? 0) - (b.cobertura ?? 0));
  return {
    cobertura: aj.cobertura, plazo: aj.plazoRepos, seguridad: aj.seguridad, ventana: aj.ventanaVentas,
    total: filasC.length, estimado: filasC.reduce((s, x) => s + (x.estimado || 0), 0), sinCosto: filasC.filter((x) => x.estimado == null).length,
    filas: filasC.slice(0, 300),
  };
}

export async function conteoAlertas(pool, ctx) {
  const a = await alertasStock(pool, ctx);
  return { stockAltas: a.resumen.altas, stockTotal: a.total };
}

// ---------- Pérdidas: anomalías, eventos y mermas ----------
const NUM_TOTAL = "CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(l.Message, 'total: ', -1), ',', 1) AS DECIMAL(18,2))";
const NUM_DESC = "CAST(SUBSTRING_INDEX(l.Message, ' a ', -1) AS DECIMAL(10,2))";
const LOGF = "l.UserRealTime >= ? AND l.UserRealTime < DATE_ADD(?, INTERVAL 1 DAY)";

/** Logs de Axis reutilizables (auditoría, informe, eventos). */
async function logsAxis(pool, desde, hasta, condSql, limit = 80, extraParams = []) {
  return filas(
    pool,
    `SELECT DATE_FORMAT(l.UserRealTime,'%Y-%m-%d %H:%i') AS fecha, u.Name AS usuario, l.Message AS mensaje, l.UserID AS uid
     FROM applicationlog l LEFT JOIN users u ON u.ID = l.UserID
     WHERE ${LOGF} AND (${condSql})
     ORDER BY l.UserRealTime DESC LIMIT ${Math.min(Math.max(limit, 1), 500)}`,
    [desde, hasta, ...extraParams]
  ).catch(() => []);
}


export async function anomalias(pool, ctx) {
  const { desde, hasta } = ctx.r;
  const aj = ctx.aj;
  const [reg, vt, dv, cierres] = await Promise.all([
    filas(pool, `SELECT l.UserID AS id, MAX(u.Name) AS nombre,
        SUM(l.Message LIKE '%operación cancelada%') AS cancel,
        COALESCE(SUM(CASE WHEN l.Message LIKE '%operación cancelada%' THEN ${NUM_TOTAL} ELSE 0 END),0) AS cancelMonto,
        COALESCE(MAX(CASE WHEN l.Message LIKE '%operación cancelada%' THEN ${NUM_TOTAL} ELSE 0 END),0) AS cancelMax,
        SUM(l.Message LIKE 'Anular venta%') AS anuladas,
        SUM(l.Message LIKE '%se eliminó%') AS lineasElim,
        SUM(l.Message LIKE '%cambiado el descuento%') AS descuentos,
        SUM(l.Message LIKE '%cambiado el descuento%' AND ${NUM_DESC} >= ?) AS descAltos,
        SUM(l.Message LIKE 'Editar venta%' OR l.Message LIKE 'Editar devoluci%') AS ediciones,
        SUM(l.Message LIKE '%cajón de moneda%') AS cajon,
        SUM(l.Message LIKE 'Inicio fallido%') AS loginFallidos
      FROM applicationlog l LEFT JOIN users u ON u.ID = l.UserID WHERE ${LOGF} GROUP BY l.UserID`, [aj.descMax, desde, hasta]),
    filas(pool, `SELECT o.UserID AS id, SUM(${IMP}) AS total, COUNT(DISTINCT o.Acct) AS tickets FROM operations o WHERE ${VENTA} AND ${RANGO} GROUP BY o.UserID`, [desde, hasta]),
    filas(pool, `SELECT o.UserID AS id, SUM(${IMP}) AS total, COUNT(DISTINCT o.Acct) AS docs FROM operations o WHERE ${DEVOL} AND ${RANGO} GROUP BY o.UserID`, [desde, hasta]),
    caja(pool, { ...ctx, uid: null }, { todo: true }),
  ]);
  const vmap = new Map(vt.map((x) => [x.id, x]));
  const dmap = new Map(dv.map((x) => [x.id, x]));
  const usuarios = [];
  for (const r of reg) {
    const v = vmap.get(r.id), d = dmap.get(r.id);
    const tickets = num(v?.tickets), cancel = num(r.cancel);
    const tasaCancel = tickets + cancel > 0 ? cancel / (tickets + cancel) : 0;
    const elimPorTicket = tickets ? num(r.lineasElim) / tickets : 0;
    const tasaDev = num(v?.total) > 0 ? num(d?.total) / num(v.total) : 0;
    const flags = [];
    const marca = (tipo, nivel, texto) => flags.push({ tipo, nivel, texto });
    if (cancel >= 5 && tasaCancel >= 0.03) marca("cancelaciones", tasaCancel >= 0.06 ? "alta" : "media", `${cancel} cancelaciones (${(tasaCancel * 100).toFixed(1)} % de sus operaciones)`);
    if (num(r.cancelMax) >= aj.umbralCancel) marca("cancel_monto", "alta", `Cancelación de ${Math.round(num(r.cancelMax))} CUP (umbral ${aj.umbralCancel})`);
    if (elimPorTicket >= 0.6 && num(r.lineasElim) >= 20) marca("lineas", elimPorTicket >= 1.2 ? "alta" : "media", `${num(r.lineasElim)} productos quitados de tickets (${elimPorTicket.toFixed(2)} por ticket)`);
    if (num(r.descAltos) >= 3) marca("descuentos", num(r.descAltos) >= 10 ? "alta" : "media", `${num(r.descAltos)} descuentos manuales de ${aj.descMax} % o más`);
    if (tasaDev >= 0.02 && num(d?.docs) >= 3) marca("devoluciones", tasaDev >= 0.05 ? "alta" : "media", `Devoluciones por ${(tasaDev * 100).toFixed(1)} % de sus ventas (${num(d?.docs)} documentos)`);
    if (num(r.anuladas) >= 5) marca("anuladas", num(r.anuladas) >= 15 ? "alta" : "media", `${num(r.anuladas)} ventas anuladas`);
    if (num(r.loginFallidos) >= 3) marca("login", num(r.loginFallidos) >= 10 ? "alta" : "media", `${num(r.loginFallidos)} inicios de sesión fallidos`);
    usuarios.push({
      id: r.id, nombre: r.id == -1 ? "Desconocido" : r.nombre || `Usuario ${r.id}`, tickets,
      cancel, cancelMonto: num(r.cancelMonto), cancelMax: num(r.cancelMax), anuladas: num(r.anuladas), lineasElim: num(r.lineasElim),
      descuentos: num(r.descuentos), descAltos: num(r.descAltos), ediciones: num(r.ediciones), cajon: num(r.cajon),
      loginFallidos: num(r.loginFallidos), devoluciones: num(d?.total), devDocs: num(d?.docs), tasaCancel, elimPorTicket, tasaDev, flags,
    });
  }
  // Turnos con diferencia de caja, por usuario
  const turnosDif = cierres.filas.filter((t) => t.nivel === "media" || t.nivel === "alta");
  const gravedad = (u) => u.flags.reduce((s, f) => s + (f.nivel === "alta" ? 3 : 1), 0);
  usuarios.sort((a, b) => gravedad(b) - gravedad(a) || b.cancel - a.cancel);
  return {
    desde, hasta, usuarios,
    totales: { alta: usuarios.reduce((s, u) => s + u.flags.filter((f) => f.nivel === "alta").length, 0), media: usuarios.reduce((s, u) => s + u.flags.filter((f) => f.nivel === "media").length, 0) },
    cierresConDiferencia: turnosDif.slice(0, 8).map((t) => ({ id: t.id, usuario: t.usuario, apertura: t.apertura, diferencia: t.diferencia, nivel: t.nivel })),
    criterios: { cancelTasa: "3 % (media) / 6 % (alta)", lineas: "0,6 (media) / 1,2 (alta) quitados por ticket", descuento: `${aj.descMax} % o más`, devolucion: "2 % (media) / 5 % (alta) de lo vendido", cierre: `${aj.tolCierre} CUP` },
  };
}

export async function eventos(pool, ctx, q) {
  const { desde, hasta } = ctx.r;
  const pagina = Math.max(parseInt(q.pagina, 10) || 1, 1);
  const filtros = {
    cancel: "l.Message LIKE '%operación cancelada%'",
    anular: "l.Message LIKE 'Anular venta%' OR l.Message LIKE '%anul%' OR l.Message LIKE '%Anular%'",
    elim: "l.Message LIKE '%se eliminó%' OR l.Message LIKE '%eliminó la mercanc%'",
    desc: "l.Message LIKE '%descuento%' OR l.Message LIKE '%Discount%'",
    precio: "l.Message LIKE '%precio de venta%' OR l.Message LIKE '%modificado la mercanc%' OR l.Message LIKE '%antiguo precio%'",
    login: "l.Message LIKE 'Inicio fallido%' OR l.Message LIKE '%Inicio fallido%'",
    cajon: "l.Message LIKE '%cajón de moneda%' OR l.Message LIKE '%cajon%'",
    cierre: "l.Message LIKE '%auditoría de caja%' OR l.Message LIKE '%auditoria de caja%'",
    todo: "1=1",
  };
  const cond = filtros[q.tipo] || filtros.cancel;
  const params = [desde, hasta];
  let extra = "";
  const u = parseInt(q.usuario, 10);
  if (Number.isInteger(u)) {
    extra = " AND l.UserID = ?";
    params.push(u);
  }
  const [[cuenta], lista] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS n FROM applicationlog l WHERE ${LOGF} AND ${cond}${extra}`, params),
    filas(pool, `SELECT l.ID AS id, DATE_FORMAT(l.UserRealTime,'%Y-%m-%d %H:%i') AS fecha, u.Name AS usuario, l.Message AS mensaje, l.UserID AS uid
      FROM applicationlog l LEFT JOIN users u ON u.ID = l.UserID WHERE ${LOGF} AND ${cond}${extra} ORDER BY l.UserRealTime DESC LIMIT 30 OFFSET ${(pagina - 1) * 30}`, params),
  ]);
  const n = num(cuenta[0].n);

  // Extraer Acct/ticket del mensaje (varios formatos Axis) y resolver en lote
  const parseAccts = (msg) => {
    const s = String(msg || "");
    const out = new Set();
    // "venta 0000123456", "ticket 123456", "cuenta 123456", "#0000123456", números 5–12 dígitos
    const re = /(?:venta|ticket|cuenta|acct|doc(?:umento)?|n[ºo°.]?\s*ticket)\s*[#:.]?\s*0*(\d{4,12})|\b0*(\d{5,12})\b|#0*(\d{4,12})\b/gi;
    let m;
    while ((m = re.exec(s))) {
      const n = parseInt(m[1] || m[2] || m[3], 10);
      if (n > 0) out.add(n);
    }
    return [...out];
  };
  const candidatos = new Set();
  const porFila = lista.map((x) => {
    const msg = String(x.mensaje || "").replace(/\s+/g, " ");
    const nums = parseAccts(msg);
    nums.forEach((n) => candidatos.add(n));
    return { x, msg, nums };
  });
  const mapa = new Map();
  if (candidatos.size) {
    const ids = [...candidatos].slice(0, 80);
    const ph = ids.map(() => "?").join(",");
    const rows = await filas(
      pool,
      `SELECT o.Acct AS acct, MAX(${F}) AS fecha, SUM(${IMP}) AS total, MAX(u.Name) AS cajero
       FROM operations o LEFT JOIN users u ON u.ID = o.UserID
       WHERE o.Acct IN (${ph}) AND o.OperType IN (2, 34)
       GROUP BY o.Acct`,
      ids
    ).catch(() => []);
    for (const r of rows) mapa.set(num(r.acct), r);
  }
  const filasOut = porFila.map(({ x, msg, nums }) => {
    let acct = null, ticketInfo = null;
    for (const c of nums) {
      const t = mapa.get(c);
      if (t) {
        acct = num(t.acct);
        ticketInfo = { ticket: numTicket(acct), fecha: t.fecha, total: num(t.total), cajero: t.cajero };
        break;
      }
    }
    return {
      id: x.id,
      fecha: x.fecha,
      usuario: x.usuario || "—",
      mensaje: msg.slice(0, 220),
      acct,
      ticket: ticketInfo ? ticketInfo.ticket : null,
      ticketTotal: ticketInfo ? ticketInfo.total : null,
      ticketFecha: ticketInfo ? ticketInfo.fecha : null,
    };
  });
  return { total: n, paginas: Math.max(Math.ceil(n / 30), 1), pagina, filas: filasOut };
}

const CATEGORIAS = [
  ["vencimiento", /venc|caduc|expir/i],
  ["dano", /da[ñn]|roto|rota|quebr|rotur|defect|mal estado/i],
  ["robo", /robo|hurto|perd|extrav|falt|desapar/i],
];
const NOMBRE_CAT = { vencimiento: "Vencimiento", dano: "Daño o rotura", robo: "Robo o pérdida", sin_motivo: "Sin motivo anotado" };

export async function mermas(pool, ctx) {
  const { desde, hasta } = ctx.r;
  const lista = await filas(
    pool,
    `SELECT o.ID AS id, ${F} AS fecha, g.ID AS goodId, g.Name AS nombre, ABS(o.Qtty) AS cantidad, o.PriceIn AS costoOp, g.PriceIn AS costoFicha, ${PRECIO} AS precio,
            o.Note AS nota, u.Name AS usuario, o.OperType AS tipo
     FROM operations o LEFT JOIN goods g ON g.ID = o.GoodID LEFT JOIN users u ON u.ID = o.UserID
     WHERE o.OperType IN (3, 11) AND ${RANGO} ORDER BY fecha DESC LIMIT 2000`,
    [desde, hasta]
  );
  const ventas = (await totalVentas(pool, { uid: null }, desde, hasta)).total;
  const cats = {};
  const porProd = {};
  let total = 0, estimados = 0;
  const detalle = lista.map((x) => {
    const costo = num(x.costoOp) > 0 ? num(x.costoOp) : num(x.costoFicha) > 0 ? num(x.costoFicha) : null;
    const unit = costo ?? num(x.precio);
    const valor = num(x.cantidad) * unit;
    if (costo == null) estimados++;
    const cat = (CATEGORIAS.find(([, re]) => re.test(x.nota || "")) || ["sin_motivo"])[0];
    cats[cat] = cats[cat] || { cat, nombre: NOMBRE_CAT[cat], n: 0, valor: 0 };
    cats[cat].n++;
    cats[cat].valor += valor;
    total += valor;
    const key = x.goodId != null ? String(x.goodId) : (x.nombre || "?");
    if (!porProd[key]) porProd[key] = { id: x.goodId, nombre: x.nombre || "Sin nombre", cantidad: 0, valor: 0, n: 0 };
    porProd[key].cantidad += num(x.cantidad);
    porProd[key].valor += valor;
    porProd[key].n += 1;
    return { fecha: x.fecha, nombre: x.nombre, cantidad: num(x.cantidad), valor, nota: x.nota || "", usuario: x.usuario, categoria: cat, estimado: costo == null };
  });
  const porProducto = Object.values(porProd)
    .map((p) => ({ ...p, cantidad: redondear(p.cantidad, 3), valor: redondear(p.valor) }))
    .sort((a, b) => b.valor - a.valor);
  return {
    desde, hasta, total, movimientos: detalle.length, estimados, ventas, impacto: ventas > 0 ? total / ventas : 0,
    categorias: Object.values(cats).sort((a, b) => b.valor - a.valor),
    porProducto,
    filas: detalle.slice(0, 80),
  };
}

export async function conteoPerdidas(pool, ctx) {
  const a = await anomalias(pool, ctx);
  return { anomaliasAltas: a.totales.alta, anomaliasMedias: a.totales.media };
}

// ---------- Auditoría detallada del negocio ----------
export async function auditoria(pool, ctx) {
  // Vista unificada: reutiliza el informe completo y expone el subconjunto "resumen"
  const full = await informeAuditoria(pool, ctx);
  const r = full.resumenEjecutivo || {};
  const det = full.detalle || {};
  const scorecard = (full.fichasTrabajadores || []).map((f) => ({
    id: f.id,
    nombre: f.nombre,
    ventas: f.ventas,
    tickets: f.tickets,
    anulaciones: f.anulaciones,
    cancelaciones: f.cancelaciones,
    devoluciones: f.devoluciones,
    faltante: f.faltante,
    sobrante: f.sobrante,
    turnosDif: f.turnosDif,
    sinContar: f.sinContar,
    riesgo: f.señales?.some((s) => s.nivel === "alta") ? 3 : f.señales?.some((s) => s.nivel === "media") ? 1 : 0,
    señales: f.señales || [],
  }));
  return {
    desde: full.meta?.desde,
    hasta: full.meta?.hasta,
    hallazgos: full.hallazgos || [],
    scorecard,
    caja: {
      faltante: r.faltante || 0,
      sobrante: r.sobrante || 0,
      conDiferencia: r.turnosFueraTol || 0,
      sinCuadrar: 0,
      turnos: r.turnos || 0,
      porCajero: (full.fichasTrabajadores || []).map((f) => ({
        usuario: f.nombre,
        turnos: f.turnos,
        conDif: f.turnosDif,
        faltante: f.faltante,
        sobrante: f.sobrante,
        sinContar: f.sinContar,
      })),
    },
    ticketsGrandes: (det.turnosConDiferencia || []).slice(0, 0), // reservado
    descuentosAltos: [],
    fueraHorario: [],
    cancelacionesPorDia: [],
    topCanceladores: (full.fichasTrabajadores || [])
      .filter((f) => f.anulaciones + f.cancelaciones > 0)
      .map((f) => ({ id: f.id, nombre: f.nombre, n: f.anulaciones + f.cancelaciones }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 10),
    ventas: { total: r.ventas || 0, tickets: r.tickets || 0 },
    cambiosPrecio: det.cambiosPrecio || [],
    anulaciones: det.anulaciones || [],
    cancelaciones: det.cancelaciones || [],
    devolucionesDetalle: det.consumoCasa ? [] : [],
    contadores: {
      cambiosPrecio: (det.cambiosPrecio || []).length,
      anulaciones: (det.anulaciones || []).length,
      cancelaciones: (det.cancelaciones || []).length,
      devoluciones: (det.devolucionesDetalle || []).length,
      descuentosAltos: 0,
      turnosConDif: r.turnosFueraTol || 0,
    },
    umbrales: {
      descMax: ctx.aj?.descMax ?? 20,
      umbralCancel: ctx.aj?.umbralCancel ?? 100000,
      tolCierre: ctx.aj?.tolCierre ?? 500,
    },
    notaCaja: "Unificado con Informe de auditoría. Faltante/sobrante solo con conteo físico.",
    informe: full,
  };
}

export async function usuariosAxis(pool) {
  const l = await filas(
    pool,
    `SELECT u.ID AS id, u.Name AS nombre, u.UserLevel AS nivel, COALESCE(ug.Name,'Sistema') AS grupo
     FROM users u LEFT JOIN usersgroups ug ON ug.ID = u.GroupID WHERE COALESCE(u.Deleted,0) = 0 AND u.ID <> 1 ORDER BY u.Name`
  );
  return l.map((x) => ({ id: num(x.id), nombre: x.nombre, nivel: num(x.nivel), grupo: x.grupo }));
}

export async function comprobarPermisos(pool) {
  try {
    const r = await filas(pool, "SHOW GRANTS FOR CURRENT_USER()");
    const texto = r.map((x) => Object.values(x)[0]).join(" ");
    return /\b(INSERT|UPDATE|DELETE|DROP|ALTER|ALL PRIVILEGES)\b/i.test(texto) ? "escritura" : "lectura";
  } catch {
    return "desconocido";
  }
}

// ========== Amplaciones: devoluciones, antigüedad, traspasos hechos, físico, margen, productividad ==========

export async function devolucionesDetalle(pool, ctx) {
  const { desde, hasta } = ctx.r;
  const lista = await filas(
    pool,
    `SELECT o.Acct AS acct, ${F} AS fecha, g.Name AS nombre, g.Code AS codigo, ABS(o.Qtty) AS cant,
            ${IMP} AS importe, u.Name AS usuario, o.Note AS nota, COALESCE(obj.Name,'') AS local
     FROM operations o
     LEFT JOIN goods g ON g.ID = o.GoodID
     LEFT JOIN users u ON u.ID = o.UserID
     LEFT JOIN shift sh ON sh.ID = o.ShiftID
     LEFT JOIN objects obj ON obj.ID = sh.ObjectID
     WHERE ${DEVOL} AND ${RANGO}
     ORDER BY fecha DESC LIMIT 500`,
    [desde, hasta]
  );
  const porProd = {};
  const porUser = {};
  let total = 0, unidades = 0;
  for (const x of lista) {
    const imp = num(x.importe), c = num(x.cant);
    total += imp; unidades += c;
    const k = x.nombre || "?";
    if (!porProd[k]) porProd[k] = { nombre: k, codigo: x.codigo, cant: 0, importe: 0, n: 0 };
    porProd[k].cant += c; porProd[k].importe += imp; porProd[k].n++;
    const u = x.usuario || "Sin nombre";
    if (!porUser[u]) porUser[u] = { usuario: u, cant: 0, importe: 0, n: 0 };
    porUser[u].cant += c; porUser[u].importe += imp; porUser[u].n++;
  }
  return {
    desde, hasta, total: redondear(total), unidades: redondear(unidades, 2), movimientos: lista.length,
    porProducto: Object.values(porProd).sort((a, b) => b.importe - a.importe).slice(0, 40),
    porUsuario: Object.values(porUser).sort((a, b) => b.importe - a.importe),
    filas: lista.map((x) => ({
      ticket: numTicket(x.acct), acct: num(x.acct), fecha: x.fecha, nombre: x.nombre, codigo: x.codigo,
      cant: num(x.cant), importe: num(x.importe), usuario: x.usuario, nota: x.nota || "", local: x.local,
    })),
  };
}

export async function antiguedadStock(pool, ctx) {
  const pct = ctx.aj?.costoEstimadoPct ?? 10;
  const hasta = ctx.r.ultimo;
  const ultVenta = await filas(
    pool,
    `SELECT o.GoodID AS id, MAX(DATE_FORMAT(${F},'%Y-%m-%d')) AS ultima
     FROM operations o WHERE ${VENTA} GROUP BY o.GoodID`
  );
  const mapaUlt = new Map(ultVenta.map((x) => [num(x.id), x.ultima]));
  const stock = await filas(
    pool,
    `SELECT g.ID AS id, g.Code AS codigo, g.Name AS nombre, COALESCE(gg.Name,'Sin grupo') AS familia,
            SUM(s.Qtty) AS stock, g.PriceIn AS costo, ${PRECIO} AS precio
     FROM store s JOIN goods g ON g.ID = s.GoodID LEFT JOIN goodsgroups gg ON gg.ID = g.GroupID
     WHERE COALESCE(g.Deleted,0)=0 GROUP BY g.ID, g.Code, g.Name, gg.Name, g.PriceIn, g.PriceOut1, g.PriceOut2, g.PriceOut3
     HAVING SUM(s.Qtty) > 0.0005`
  );
  const buckets = { d0_30: [], d31_60: [], d61_90: [], d90: [], nunca: [] };
  let capital = { d0_30: 0, d31_60: 0, d61_90: 0, d90: 0, nunca: 0 };
  for (const x of stock) {
    const st = num(x.stock);
    const costoU = costoDe(x.costo, x.precio, pct);
    const val = st * costoU;
    const ultima = mapaUlt.get(num(x.id));
    let dias = null, bucket = "nunca";
    if (ultima) {
      dias = difDias(ultima, hasta);
      if (dias <= 30) bucket = "d0_30";
      else if (dias <= 60) bucket = "d31_60";
      else if (dias <= 90) bucket = "d61_90";
      else bucket = "d90";
    }
    const row = {
      id: x.id, codigo: x.codigo, nombre: x.nombre, familia: x.familia,
      stock: redondear(st, 2), valor: redondear(val), ultima: ultima || null, dias,
    };
    buckets[bucket].push(row);
    capital[bucket] += val;
  }
  for (const k of Object.keys(buckets)) buckets[k].sort((a, b) => b.valor - a.valor);
  return {
    hasta,
    resumen: {
      d0_30: { n: buckets.d0_30.length, capital: redondear(capital.d0_30) },
      d31_60: { n: buckets.d31_60.length, capital: redondear(capital.d31_60) },
      d61_90: { n: buckets.d61_90.length, capital: redondear(capital.d61_90) },
      d90: { n: buckets.d90.length, capital: redondear(capital.d90) },
      nunca: { n: buckets.nunca.length, capital: redondear(capital.nunca) },
    },
    filas90: buckets.d90.slice(0, 80),
    filasNunca: buckets.nunca.slice(0, 80),
    filas61: buckets.d61_90.slice(0, 40),
  };
}

export async function traspasosHechos(pool, ctx, q = {}) {
  const { desde, hasta } = ctx.r;
  const pct = ctx.aj?.costoEstimadoPct ?? 10;
  const busca = String(q.q || "").trim().slice(0, 60);
  const origenId = parseInt(q.origen, 10);
  const destId = parseInt(q.destino, 10);
  const tieneOrigen = Number.isInteger(origenId);
  const tieneDest = Number.isInteger(destId);

  // Tipos de transferencia habituales en Axis / Microinvest
  const TIPOS = [7, 8, 26, 27];
  const NOM = {
    7: "Transferencia salida",
    8: "Transferencia entrada",
    26: "Traspaso",
    27: "Traspaso (alt)",
  };

  let lista = [];
  // Intento 1: ObjectID en operations (algunas instalaciones)
  try {
    lista = await filas(
      pool,
      `SELECT o.ID AS id, ${F} AS fecha, o.OperType AS tipo, o.Qtty AS cant, o.Acct AS acct,
              o.PriceIn AS costo, o.PriceOut AS precio, o.Note AS nota,
              g.ID AS gid, g.Code AS codigo, g.Name AS nombre, g.PriceIn AS costoFicha, ${PRECIO} AS precioFicha,
              u.Name AS usuario,
              o.ObjectID AS objectId,
              COALESCE(obj.Name, CONCAT('Local ', o.ObjectID)) AS local
       FROM operations o
       LEFT JOIN goods g ON g.ID = o.GoodID
       LEFT JOIN users u ON u.ID = o.UserID
       LEFT JOIN objects obj ON obj.ID = o.ObjectID
       WHERE o.OperType IN (7, 8, 26, 27) AND ${RANGO}
       ORDER BY fecha DESC, o.Acct, o.ID
       LIMIT 4000`,
      [desde, hasta]
    );
  } catch {
    lista = [];
  }
  // Intento 2: local vía turno
  if (!lista.length) {
    lista = await filas(
      pool,
      `SELECT o.ID AS id, ${F} AS fecha, o.OperType AS tipo, o.Qtty AS cant, o.Acct AS acct,
              o.PriceIn AS costo, o.PriceOut AS precio, o.Note AS nota,
              g.ID AS gid, g.Code AS codigo, g.Name AS nombre, g.PriceIn AS costoFicha, ${PRECIO} AS precioFicha,
              u.Name AS usuario,
              sh.ObjectID AS objectId,
              COALESCE(obj.Name, '') AS local
       FROM operations o
       LEFT JOIN goods g ON g.ID = o.GoodID
       LEFT JOIN users u ON u.ID = o.UserID
       LEFT JOIN shift sh ON sh.ID = o.ShiftID
       LEFT JOIN objects obj ON obj.ID = sh.ObjectID
       WHERE o.OperType IN (7, 8, 26, 27) AND ${RANGO}
       ORDER BY fecha DESC, o.Acct, o.ID
       LIMIT 4000`,
      [desde, hasta]
    ).catch(() => []);
  }

  // Emparejar por documento (Acct): salidas (cant<0 o tipo 7) + entradas (cant>0 o tipo 8)
  const porDoc = new Map();
  for (const x of lista) {
    const key = String(x.acct ?? x.id);
    if (!porDoc.has(key)) porDoc.set(key, []);
    porDoc.get(key).push(x);
  }

  const filasOut = [];
  const rutas = new Map(); // "Desde→Hasta" agregados
  let unidades = 0;
  let valorCosto = 0;

  const pushFila = (row) => {
    if (busca) {
      const hay = `${row.nombre} ${row.codigo}`.toLowerCase().includes(busca.toLowerCase());
      if (!hay) return;
    }
    if (tieneOrigen && num(row.origenId) !== origenId) return;
    if (tieneDest && num(row.destinoId) !== destId) return;
    filasOut.push(row);
    unidades += Math.abs(row.cant);
    valorCosto += row.valorCosto;
    const rk = `${row.desde} → ${row.hasta}`;
    if (!rutas.has(rk)) rutas.set(rk, { ruta: rk, desde: row.desde, hasta: row.hasta, n: 0, unidades: 0, valor: 0 });
    const r = rutas.get(rk);
    r.n += 1;
    r.unidades += Math.abs(row.cant);
    r.valor += row.valorCosto;
  };

  for (const [, items] of porDoc) {
    const salidas = items.filter((x) => num(x.cant) < 0 || num(x.tipo) === 7);
    const entradas = items.filter((x) => num(x.cant) > 0 || num(x.tipo) === 8);
    // Emparejar por producto
    const byGood = new Map();
    for (const x of items) {
      const gid = num(x.gid) || x.nombre;
      if (!byGood.has(gid)) byGood.set(gid, { sal: [], ent: [] });
      const g = byGood.get(gid);
      if (num(x.cant) < 0 || num(x.tipo) === 7) g.sal.push(x);
      else g.ent.push(x);
    }
    for (const [, g] of byGood) {
      if (g.sal.length && g.ent.length) {
        const s = g.sal[0];
        const e = g.ent[0];
        const cant = Math.max(Math.abs(num(s.cant)), Math.abs(num(e.cant)));
        const costoU = costoDe(s.costo || e.costo || s.costoFicha, s.precioFicha || e.precioFicha, pct);
        pushFila({
          fecha: s.fecha || e.fecha,
          acct: num(s.acct || e.acct),
          tipo: num(s.tipo),
          nombreTipo: "Traspaso",
          codigo: s.codigo || e.codigo || "",
          nombre: s.nombre || e.nombre || "—",
          cant: redondear(cant, 3),
          costoUnit: redondear(costoU, 4),
          valorCosto: redondear(cant * costoU, 2),
          desde: s.local || "Origen",
          hasta: e.local || "Destino",
          origenId: num(s.objectId),
          destinoId: num(e.objectId),
          usuario: s.usuario || e.usuario || "",
          nota: (s.nota || e.nota || "").slice(0, 120),
        });
      } else {
        // Sin par: mostrar línea suelta
        for (const x of [...g.sal, ...g.ent]) {
          const cant = Math.abs(num(x.cant));
          const costoU = costoDe(x.costo || x.costoFicha, x.precioFicha, pct);
          const esSal = num(x.cant) < 0 || num(x.tipo) === 7;
          pushFila({
            fecha: x.fecha,
            acct: num(x.acct),
            tipo: num(x.tipo),
            nombreTipo: NOM[num(x.tipo)] || `Tipo ${x.tipo}`,
            codigo: x.codigo || "",
            nombre: x.nombre || "—",
            cant: redondear(cant, 3),
            costoUnit: redondear(costoU, 4),
            valorCosto: redondear(cant * costoU, 2),
            desde: esSal ? (x.local || "Origen") : "—",
            hasta: !esSal ? (x.local || "Destino") : "—",
            origenId: esSal ? num(x.objectId) : null,
            destinoId: !esSal ? num(x.objectId) : null,
            usuario: x.usuario || "",
            nota: (x.nota || "").slice(0, 120),
          });
        }
      }
    }
  }

  filasOut.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));

  const locales = await filas(
    pool,
    `SELECT o.ID AS id, o.Name AS nombre FROM objects o
     WHERE EXISTS (SELECT 1 FROM store s WHERE s.ObjectID = o.ID)
     ORDER BY o.Name`
  ).catch(() => []);

  // Top productos movidos
  const porProd = {};
  for (const x of filasOut) {
    const k = x.nombre;
    if (!porProd[k]) porProd[k] = { nombre: k, codigo: x.codigo, cant: 0, valor: 0, n: 0 };
    porProd[k].cant += x.cant;
    porProd[k].valor += x.valorCosto;
    porProd[k].n += 1;
  }

  return {
    desde,
    hasta,
    movimientos: filasOut.length,
    unidades: redondear(unidades, 2),
    valorCosto: redondear(valorCosto, 2),
    rutas: [...rutas.values()]
      .map((r) => ({ ...r, unidades: redondear(r.unidades, 2), valor: redondear(r.valor, 2) }))
      .sort((a, b) => b.unidades - a.unidades),
    porProducto: Object.values(porProd)
      .map((x) => ({ ...x, cant: redondear(x.cant, 2), valor: redondear(x.valor, 2) }))
      .sort((a, b) => b.cant - a.cant)
      .slice(0, 40),
    locales: locales.map((x) => ({ id: x.id, nombre: x.nombre })),
    filtros: { q: busca, origen: tieneOrigen ? origenId : "", destino: tieneDest ? destId : "" },
    filas: filasOut.slice(0, 800),
  };
}

/** Catálogo stock en vivo para Arqueo Stock (mismo formato que espera la app de conteo). */
export async function stockVivo(pool) {
  const lista = await filas(
    pool,
    `SELECT g.ID AS id, g.Code AS sku, g.Name AS nombre, ${PRECIO} AS precio, COALESCE(SUM(s.Qtty),0) AS stock,
            g.BarCode1 AS barcode
     FROM goods g
     LEFT JOIN store s ON s.GoodID = g.ID
     WHERE COALESCE(g.Deleted,0)=0
     GROUP BY g.ID, g.Code, g.Name, g.PriceOut1, g.PriceOut2, g.PriceOut3, g.BarCode1
     ORDER BY g.Name
     LIMIT 20000`
  );
  const items = lista.map((x) => ({
    id: num(x.id),
    sku: x.sku || String(x.id),
    codigo: x.sku || String(x.id),
    barcode: x.barcode || "",
    nombre: x.nombre,
    stock: num(x.stock),
    existencia: num(x.stock),
    precio: num(x.precio),
  }));
  // Varios formatos: Arqueo Stock / clientes antiguos
  return {
    ok: true,
    items,
    productos: items,
    catalogo: { cargado: true, n: items.length, items },
    n: items.length,
    total: items.length,
    ts: Date.now(),
  };
}

/** Compara conteo físico (JSON de Arqueo) con stock del sistema. */
export async function inventarioFisico(pool, ctx, body) {
  const pct = ctx.aj?.costoEstimadoPct ?? 10;
  const conteos = Array.isArray(body?.items) ? body.items : Array.isArray(body) ? body : [];
  const stock = await filas(
    pool,
    `SELECT g.ID AS id, g.Code AS codigo, g.Name AS nombre, COALESCE(SUM(s.Qtty),0) AS sistema,
            g.PriceIn AS costo, ${PRECIO} AS precio
     FROM goods g LEFT JOIN store s ON s.GoodID = g.ID
     WHERE COALESCE(g.Deleted,0)=0
     GROUP BY g.ID, g.Code, g.Name, g.PriceIn, g.PriceOut1, g.PriceOut2, g.PriceOut3`
  );
  const bySku = new Map();
  const byNom = new Map();
  for (const x of stock) {
    const row = {
      id: x.id, codigo: x.codigo, nombre: x.nombre, sistema: num(x.sistema),
      costo: costoDe(x.costo, x.precio, pct), precio: num(x.precio),
    };
    if (x.codigo) bySku.set(String(x.codigo).trim().toLowerCase(), row);
    byNom.set(String(x.nombre || "").trim().toLowerCase(), row);
  }
  const filasOut = [];
  let faltante = 0, sobrante = 0, ok = 0, valorFaltante = 0, valorSobrante = 0;
  for (const c of conteos) {
    const sku = String(c.codigo || c.sku || "").trim().toLowerCase();
    const nom = String(c.nombre || "").trim().toLowerCase();
    const fisico = c.stockReal != null ? num(c.stockReal) : (num(c.stockCuarto) + num(c.stockPlaca));
    if (c.stockReal == null && c.stockCuarto == null && c.stockPlaca == null) continue;
    let sys = (sku && bySku.get(sku)) || (nom && byNom.get(nom)) || null;
    const sistema = sys ? sys.sistema : 0;
    const dif = redondear(fisico - sistema, 3);
    const costoU = sys ? sys.costo : 0;
    const val = dif * costoU;
    if (Math.abs(dif) < 0.001) ok++;
    else if (dif < 0) { faltante++; valorFaltante += val; }
    else { sobrante++; valorSobrante += val; }
    filasOut.push({
      nombre: (sys && sys.nombre) || c.nombre || sku,
      codigo: (sys && sys.codigo) || c.codigo || c.sku || "",
      sistema: redondear(sistema, 3),
      fisico: redondear(fisico, 3),
      diferencia: dif,
      valor: redondear(val),
      estado: Math.abs(dif) < 0.001 ? "ok" : dif < 0 ? "faltante" : "sobrante",
    });
  }
  filasOut.sort((a, b) => Math.abs(b.diferencia) - Math.abs(a.diferencia));
  return {
    resumen: {
      comparados: filasOut.length, ok, faltante, sobrante,
      valorFaltante: redondear(valorFaltante), valorSobrante: redondear(valorSobrante),
    },
    filas: filasOut.slice(0, 300),
  };
}

export async function margenProductos(pool, ctx) {
  const { desde, hasta } = ctx.r;
  const pct = ctx.aj?.costoEstimadoPct ?? 10;
  const lista = await filas(
    pool,
    `SELECT g.ID AS id, g.Name AS nombre, COALESCE(gg.Name,'Sin grupo') AS familia,
            SUM(ABS(o.Qtty)) AS unidades, SUM(${IMP}) AS ventas,
            SUM(ABS(o.Qtty) * COALESCE(NULLIF(o.PriceIn,0), NULLIF(g.PriceIn,0), 0)) AS costoReal
     FROM operations o
     LEFT JOIN goods g ON g.ID = o.GoodID
     LEFT JOIN goodsgroups gg ON gg.ID = g.GroupID
     WHERE ${VENTA} AND ${RANGO}
     GROUP BY g.ID, g.Name, gg.Name
     ORDER BY ventas DESC LIMIT 200`,
    [desde, hasta]
  );
  // Si costo real 0, estimar con % del precio medio implícito
  const filasOut = lista.map((x) => {
    const ventas = num(x.ventas), unidades = num(x.unidades);
    let costo = num(x.costoReal);
    let estimado = false;
    if (costo <= 0 && ventas > 0) {
      costo = ventas * (1 - Math.min(Math.max(pct, 0), 99) / 100);
      estimado = true;
    }
    const ganancia = ventas - costo;
    return {
      id: x.id, nombre: x.nombre, familia: x.familia, unidades: redondear(unidades, 2),
      ventas: redondear(ventas), costo: redondear(costo), ganancia: redondear(ganancia),
      margen: ventas > 0 ? ganancia / ventas : 0, estimado,
    };
  });
  const porFam = {};
  for (const x of filasOut) {
    if (!porFam[x.familia]) porFam[x.familia] = { familia: x.familia, ventas: 0, costo: 0, ganancia: 0 };
    porFam[x.familia].ventas += x.ventas;
    porFam[x.familia].costo += x.costo;
    porFam[x.familia].ganancia += x.ganancia;
  }
  return {
    desde, hasta, costoEstimadoPct: pct,
    familias: Object.values(porFam).map((f) => ({
      ...f, margen: f.ventas > 0 ? f.ganancia / f.ventas : 0,
    })).sort((a, b) => b.ganancia - a.ganancia),
    filas: filasOut,
  };
}

export async function efectoPrecios(pool, ctx) {
  const { desde, hasta } = ctx.r;
  // Mitad del período
  const dias = Math.max(ctx.r.dias || 30, 2);
  const mitad = sumarDias(desde, Math.floor(dias / 2) - 1);
  const [antes, despues] = await Promise.all([
    filas(pool, `SELECT o.GoodID AS id, g.Name AS nombre, AVG(o.PriceOut) AS precio, SUM(ABS(o.Qtty)) AS unid, SUM(${IMP}) AS total
      FROM operations o LEFT JOIN goods g ON g.ID = o.GoodID
      WHERE ${VENTA} AND ${F} >= ? AND ${F} < DATE_ADD(?, INTERVAL 1 DAY) GROUP BY o.GoodID, g.Name`, [desde, mitad]),
    filas(pool, `SELECT o.GoodID AS id, g.Name AS nombre, AVG(o.PriceOut) AS precio, SUM(ABS(o.Qtty)) AS unid, SUM(${IMP}) AS total
      FROM operations o LEFT JOIN goods g ON g.ID = o.GoodID
      WHERE ${VENTA} AND ${F} >= ? AND ${F} < DATE_ADD(?, INTERVAL 1 DAY) GROUP BY o.GoodID, g.Name`, [sumarDias(mitad, 1), hasta]),
  ]);
  const mapA = new Map(antes.map((x) => [num(x.id), x]));
  const mapB = new Map(despues.map((x) => [num(x.id), x]));
  const filasOut = [];
  for (const [id, a] of mapA) {
    const b = mapB.get(id);
    if (!b) continue;
    const pa = num(a.precio), pb = num(b.precio);
    if (pa <= 0 || Math.abs(pb - pa) / pa < 0.02) continue; // cambio < 2%
    filasOut.push({
      id, nombre: a.nombre || b.nombre,
      precioAntes: redondear(pa), precioDespues: redondear(pb),
      cambioPct: (pb - pa) / pa,
      unidAntes: num(a.unid), unidDespues: num(b.unid),
      ventasAntes: num(a.total), ventasDespues: num(b.total),
      varUnid: num(a.unid) > 0 ? (num(b.unid) - num(a.unid)) / num(a.unid) : null,
    });
  }
  filasOut.sort((a, b) => Math.abs(b.cambioPct) - Math.abs(a.cambioPct));
  return { desde, hasta, corte: mitad, filas: filasOut.slice(0, 80) };
}

export async function productividad(pool, ctx) {
  const { desde, hasta } = ctx.r;
  const turnos = await filas(
    pool,
    `SELECT sh.ID AS id, u.Name AS usuario, sh.DateTimeOpen AS ap, sh.DateTimeClose AS ci,
            COALESCE(v.tickets,0) AS tickets, COALESCE(v.total,0) AS ventas, COALESCE(v.unid,0) AS unid
     FROM shift sh
     LEFT JOIN users u ON u.ID = sh.UserID
     LEFT JOIN (
       SELECT o.ShiftID, COUNT(DISTINCT o.Acct) AS tickets, SUM(${IMP}) AS total, SUM(ABS(o.Qtty)) AS unid
       FROM operations o WHERE ${VENTA} GROUP BY o.ShiftID
     ) v ON v.ShiftID = sh.ID
     WHERE sh.DateTimeOpen >= ? AND sh.DateTimeOpen < DATE_ADD(?, INTERVAL 1 DAY)
     ORDER BY sh.DateTimeOpen DESC LIMIT 300`,
    [desde, hasta]
  );
  const porUser = {};
  for (const t of turnos) {
    const u = t.usuario || "Sin nombre";
    if (!porUser[u]) porUser[u] = { usuario: u, turnos: 0, horas: 0, tickets: 0, ventas: 0, unid: 0 };
    const c = porUser[u];
    c.turnos++;
    c.tickets += num(t.tickets);
    c.ventas += num(t.ventas);
    c.unid += num(t.unid);
    if (t.ap && t.ci) {
      const h = (new Date(String(t.ci).replace(" ", "T")) - new Date(String(t.ap).replace(" ", "T"))) / 3600000;
      if (h > 0 && h < 24) c.horas += h;
    }
  }
  const filasOut = Object.values(porUser).map((c) => ({
    ...c,
    horas: redondear(c.horas, 1),
    ticketsHora: c.horas > 0 ? redondear(c.tickets / c.horas, 2) : null,
    ventasHora: c.horas > 0 ? redondear(c.ventas / c.horas) : null,
    unidTicket: c.tickets > 0 ? redondear(c.unid / c.tickets, 2) : null,
    ticketMedio: c.tickets > 0 ? redondear(c.ventas / c.tickets) : null,
  })).sort((a, b) => (b.ventasHora || 0) - (a.ventasHora || 0));
  return { desde, hasta, filas: filasOut };
}

export async function patronesAnulacion(pool, ctx) {
  const { desde, hasta } = ctx.r;
  // Cancelaciones desde systemlog + líneas
  let logs = [];
  try {
    logs = await filas(
      pool,
      `SELECT DATE_FORMAT(l.DateTime,'%Y-%m-%d %H:%i:%s') AS fecha, HOUR(l.DateTime) AS hora,
              u.Name AS usuario, l.Message AS mensaje
       FROM systemlog l LEFT JOIN users u ON u.ID = l.UserID
       WHERE l.DateTime >= ? AND l.DateTime < DATE_ADD(?, INTERVAL 1 DAY)
         AND (l.Message LIKE '%cancel%' OR l.Message LIKE '%anul%' OR l.Message LIKE '%void%' OR l.Message LIKE '%elimin%')
       ORDER BY l.DateTime DESC LIMIT 1000`,
      [desde, hasta]
    );
  } catch { logs = []; }
  const porHora = Array.from({ length: 24 }, (_, h) => ({ hora: h, n: 0 }));
  const porUser = {};
  for (const x of logs) {
    const h = num(x.hora);
    if (h >= 0 && h < 24) porHora[h].n++;
    const u = x.usuario || "Sin nombre";
    if (!porUser[u]) porUser[u] = { usuario: u, n: 0 };
    porUser[u].n++;
  }
  return {
    desde, hasta, total: logs.length,
    porHora,
    porUsuario: Object.values(porUser).sort((a, b) => b.n - a.n),
    recientes: logs.slice(0, 40).map((x) => ({ fecha: x.fecha, usuario: x.usuario, mensaje: (x.mensaje || "").slice(0, 120) })),
  };
}

export async function duracionTurnos(pool, ctx) {
  const { desde, hasta } = ctx.r;
  const lista = await filas(
    pool,
    `SELECT sh.ID AS id, u.Name AS usuario, o.Name AS local,
            DATE_FORMAT(sh.DateTimeOpen,'%Y-%m-%d %H:%i:%s') AS apertura,
            DATE_FORMAT(sh.DateTimeClose,'%Y-%m-%d %H:%i:%s') AS cierre
     FROM shift sh
     LEFT JOIN users u ON u.ID = sh.UserID
     LEFT JOIN objects o ON o.ID = sh.ObjectID
     WHERE sh.DateTimeOpen >= ? AND sh.DateTimeOpen < DATE_ADD(?, INTERVAL 1 DAY)
     ORDER BY sh.DateTimeOpen DESC LIMIT 200`,
    [desde, hasta]
  );
  const filasOut = lista.map((t) => {
    let horas = null;
    if (t.apertura && t.cierre) {
      horas = (new Date(t.cierre.replace(" ", "T")) - new Date(t.apertura.replace(" ", "T"))) / 3600000;
      if (horas < 0 || horas > 36) horas = null;
    }
    const alerta = horas != null && (horas > 12 || horas < 0.5);
    return {
      id: t.id, usuario: t.usuario, local: t.local, apertura: t.apertura, cierre: t.cierre,
      horas: horas != null ? redondear(horas, 2) : null,
      abierto: !t.cierre,
      alerta,
    };
  });
  return {
    desde, hasta,
    abiertos: filasOut.filter((x) => x.abierto).length,
    largos: filasOut.filter((x) => x.horas != null && x.horas > 12).length,
    filas: filasOut,
  };
}

export async function alertasInicio(pool, ctx) {
  const { desde, hasta } = ctx.r;
  const tol = ctx.aj.tolCierre;
  const [cajaData, alertas, merma] = await Promise.all([
    caja(pool, ctx, { pagina: 1 }),
    alertasStock(pool, ctx).catch(() => ({ resumen: {} })),
    mermas(pool, ctx).catch(() => ({ total: 0, movimientos: 0 })),
  ]);
  const items = [];
  if (cajaData.conDiferencia > 0) {
    items.push({ nivel: "alta", texto: `${cajaData.conDiferencia} turnos fuera de tolerancia de caja (${tol} CUP). Faltante acum. ${Math.abs(cajaData.faltante).toFixed(0)} CUP.` });
  }
  if (alertas.resumen?.agotados > 0) {
    items.push({ nivel: "alta", texto: `${alertas.resumen.agotados} productos agotados que se estaban vendiendo.` });
  }
  if (alertas.resumen?.reorden > 0) {
    items.push({ nivel: "media", texto: `${alertas.resumen.reorden} productos en punto de reposición.` });
  }
  if (merma.movimientos > 0) {
    items.push({ nivel: "media", texto: `Mermas del período: ${merma.movimientos} mov. · valor ~ ${Number(merma.total).toFixed(0)} CUP.` });
  }
  if (!items.length) items.push({ nivel: "ok", texto: "Sin alertas fuertes en el período seleccionado." });
  return { items, caja: { conDiferencia: cajaData.conDiferencia, faltante: cajaData.faltante }, stock: alertas.resumen || {} };
}

export async function panelDueno(pool, ctx) {
  // No llama a resumen() — evita bucle infinito resumen ↔ panelDueno
  const { desde, hasta, ultimo } = ctx.r;
  const U = uid(ctx);
  const P = parRango(ctx, desde, hasta);
  const [tot, hoyT, cajaData, alertas, top, merma] = await Promise.all([
    una(pool, `SELECT COALESCE(SUM(${IMP}),0) AS total, COUNT(DISTINCT o.Acct) AS tickets FROM operations o WHERE ${VENTA} AND ${RANGO}${U}`, P),
    una(pool, `SELECT COALESCE(SUM(${IMP}),0) AS total FROM operations o WHERE ${VENTA} AND DATE(${F}) = ?${U}`, ctx.uid != null ? [ultimo, ctx.uid] : [ultimo]),
    caja(pool, ctx, { pagina: 1 }),
    alertasStock(pool, ctx).catch(() => ({ resumen: { agotados: 0, reorden: 0 }, filas: [] })),
    topProductos(pool, ctx, { limite: 5 }),
    mermas(pool, ctx).catch(() => ({ total: 0 })),
  ]);
  const total = num(tot.total);
  const tickets = num(tot.tickets);
  return {
    desde, hasta, ultimoDia: ultimo,
    ventasHoy: num(hoyT.total),
    ventasPeriodo: total,
    tickets,
    ganancia: null,
    margen: null,
    caja: { conDiferencia: cajaData.conDiferencia, faltante: cajaData.faltante, sobrante: cajaData.sobrante },
    stockCritico: (alertas.filas || []).filter((x) => x.nivel === "alta" || x.tipo === "agotado" || x.tipo === "minimo").slice(0, 8),
    top: top.filas || top.top || [],
    mermas: merma.total || 0,
  };
}

// ========== Comparar períodos, lista arqueo, ranking, diagnóstico ==========

export async function compararPeriodos(pool, ctx, q) {
  const d1 = q.desde1 || ctx.r.desde;
  const h1 = q.hasta1 || ctx.r.hasta;
  const d2 = q.desde2;
  const h2 = q.hasta2;
  if (!d2 || !h2) return { error: "Indica el segundo período (desde2, hasta2)" };
  async function bloque(desde, hasta) {
    const ctx2 = { ...ctx, r: { ...ctx.r, desde, hasta, primero: desde, ultimo: hasta } };
    const [ventasR, ticketsR, cajaR] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(${IMP}),0) AS t, COUNT(DISTINCT o.Acct) AS n FROM operations o WHERE ${VENTA} AND ${RANGO}`, [desde, hasta]),
      pool.query(`SELECT COUNT(DISTINCT o.Acct) AS n FROM operations o WHERE ${VENTA} AND ${RANGO}`, [desde, hasta]),
      caja(pool, { ...ctx, r: { desde, hasta, primero: desde, ultimo: hasta } }, { pagina: 1 }).catch(() => null),
    ]);
    const total = num(ventasR[0][0].t);
    const tickets = num(ventasR[0][0].n);
    return {
      desde, hasta, total, tickets,
      ticketMedio: tickets > 0 ? redondear(total / tickets) : 0,
      cajaFuera: cajaR?.conDiferencia || 0,
      faltante: cajaR?.faltante || 0,
    };
  }
  const [a, b] = await Promise.all([bloque(d1, h1), bloque(d2, h2)]);
  const varPct = (x, y) => (y > 0 ? (x - y) / y : null);
  return {
    a, b,
    delta: {
      total: redondear(a.total - b.total),
      totalPct: varPct(a.total, b.total),
      tickets: a.tickets - b.tickets,
      ticketsPct: varPct(a.tickets, b.tickets),
      ticketMedio: redondear(a.ticketMedio - b.ticketMedio),
    },
  };
}

/** Lista filtrada para Arqueo Stock (JSON listo para importar / conteo). */
export async function listaArqueo(pool, ctx, q) {
  const lid = q.local ? parseInt(q.local, 10) : null;
  const soloMin = q.soloMin === "1" || q.soloMin === "true";
  const clase = q.clase || ""; // A/B/C o vacío
  const pct = ctx.aj?.costoEstimadoPct ?? 10;

  let abcIds = null;
  if (clase) {
    const abc = await analisisABC(pool, ctx, { clase }).catch(() => null);
    if (abc?.filas) abcIds = new Set(abc.filas.map((x) => num(x.id)));
  }

  const stock = await filas(
    pool,
    `SELECT g.ID AS id, g.Code AS sku, g.Name AS nombre, ${PRECIO} AS precio,
            COALESCE(SUM(s.Qtty),0) AS stock, g.MinQtty AS minimo, o.Name AS local, s.ObjectID AS lid
     FROM store s
     JOIN goods g ON g.ID = s.GoodID
     LEFT JOIN objects o ON o.ID = s.ObjectID
     WHERE COALESCE(g.Deleted,0)=0 ${lid ? "AND s.ObjectID = ?" : ""}
     GROUP BY g.ID, g.Code, g.Name, g.PriceOut1, g.PriceOut2, g.PriceOut3, g.MinQtty, o.Name, s.ObjectID
     HAVING ABS(COALESCE(SUM(s.Qtty),0)) > 0.0005 OR 1=1
     ORDER BY g.Name
     LIMIT 15000`,
    lid ? [lid] : []
  );

  // Agregar por producto (suma locales si no se filtró)
  const map = new Map();
  for (const x of stock) {
    if (abcIds && !abcIds.has(num(x.id))) continue;
    const st = num(x.stock);
    if (soloMin && st > num(x.minimo) && num(x.minimo) > 0) continue;
    if (soloMin && num(x.minimo) <= 0 && st > 0) continue;
    const k = num(x.id);
    if (!map.has(k)) {
      map.set(k, {
        sku: x.sku || String(x.id),
        nombre: x.nombre,
        stock: 0,
        precio: num(x.precio),
        minimo: num(x.minimo),
      });
    }
    map.get(k).stock += st;
  }
  const items = [...map.values()].map((x) => ({
    sku: x.sku,
    nombre: x.nombre,
    stock: redondear(x.stock, 3),
    precio: x.precio,
  }));
  return {
    generado: new Date().toISOString(),
    filtros: { local: lid, soloMin, clase },
    n: items.length,
    items,
  };
}

/** Tras el arqueo: informe de ajustes sugeridos (para capturar en AxisPOS, sin escribir BD). */
export async function ajustesSugeridos(pool, ctx, body) {
  const fisico = await inventarioFisico(pool, ctx, body);
  const sugeridos = (fisico.filas || [])
    .filter((x) => Math.abs(x.diferencia) >= 0.001)
    .map((x) => ({
      codigo: x.codigo,
      nombre: x.nombre,
      sistema: x.sistema,
      fisico: x.fisico,
      diferencia: x.diferencia,
      valor: x.valor,
      accion: x.diferencia < 0
        ? `Bajar stock en ${Math.abs(x.diferencia)} (faltante físico)`
        : `Subir stock en ${x.diferencia} (sobrante físico)`,
      tipoAxis: x.diferencia < 0 ? "Merma / ajuste negativo" : "Ajuste positivo / entrada",
    }));
  return {
    resumen: fisico.resumen,
    mensaje: "Este informe no modifica AxisPOS. Úsalo para capturar los ajustes manualmente en el POS.",
    filas: sugeridos,
  };
}

export async function rankingEquipo(pool, ctx) {
  const d = await equipoCompleto(pool, ctx);
  const filasOut = (d.cajeros || []).map((x) => ({
    usuario: x.nombre,
    ventasHora: null,
    ticketsHora: null,
    ventas: x.total,
    tickets: x.tickets,
    señales: x.señales || [],
  })).sort((a, b) => b.ventas - a.ventas);
  return { filas: filasOut };
}

export async function turnosHorario(pool, ctx) {
  const base = await duracionTurnos(pool, ctx);
  const hMin = ctx.aj.horaAperturaMin ?? 7;
  const hMax = ctx.aj.horaAperturaMax ?? 10;
  const hMaxTurno = ctx.aj.horasTurnoMax ?? 12;
  const filas = base.filas.map((t) => {
    const flags = [];
    if (t.abierto) flags.push("Sin cerrar");
    if (t.horas != null && t.horas > hMaxTurno) flags.push(`Más de ${hMaxTurno} h`);
    if (t.apertura) {
      const h = parseInt(String(t.apertura).slice(11, 13), 10);
      if (!Number.isNaN(h) && (h < hMin || h > hMax)) flags.push(`Apertura fuera de ${hMin}:00–${hMax}:00`);
    }
    return { ...t, flags, alerta: flags.length > 0 || t.alerta };
  });
  return {
    ...base,
    horario: { aperturaMin: hMin, aperturaMax: hMax, horasMax: hMaxTurno },
    filas,
    conAlerta: filas.filter((x) => x.alerta).length,
  };
}

export async function diagnostico(pool) {
  const t0 = Date.now();
  let dbOk = false, dbMs = null, err = null, nGoods = null;
  try {
    const t1 = Date.now();
    await pool.query("SELECT 1");
    dbMs = Date.now() - t1;
    dbOk = true;
    const [r] = await pool.query("SELECT COUNT(*) AS n FROM goods");
    nGoods = num(r[0].n);
  } catch (e) {
    err = e.message || String(e);
  }
  return {
    ok: dbOk,
    servidorMs: Date.now() - t0,
    dbMs,
    error: err,
    productos: nGoods,
    version: "Admin POS unificado",
    ts: new Date().toISOString(),
  };
}

export async function busquedaGlobal(pool, ctx, q) {
  const term = String(q.q || "").trim();
  if (term.length < 2) return { tickets: [], productos: [], usuarios: [] };
  const like = `%${term}%`;
  const esNum = /^\d+$/.test(term);
  const [tickets, productos, usuarios] = await Promise.all([
    filas(
      pool,
      `SELECT DISTINCT o.Acct AS acct, ${F} AS fecha, u.Name AS cajero, SUM(${IMP}) AS total
       FROM operations o LEFT JOIN users u ON u.ID = o.UserID
       WHERE ${VENTA} AND ${RANGO} AND (${esNum ? "o.Acct = ?" : "0"} OR CAST(o.Acct AS CHAR) LIKE ?)
       GROUP BY o.Acct, fecha, u.Name
       ORDER BY fecha DESC LIMIT 15`,
      esNum ? [ctx.r.desde, ctx.r.hasta, parseInt(term, 10), like] : [ctx.r.desde, ctx.r.hasta, like]
    ).catch(() => []),
    filas(
      pool,
      `SELECT g.ID AS id, g.Code AS codigo, g.Name AS nombre, ${PRECIO} AS precio
       FROM goods g WHERE COALESCE(g.Deleted,0)=0 AND (g.Name LIKE ? OR g.Code LIKE ?)
       ORDER BY g.Name LIMIT 15`,
      [like, like]
    ).catch(() => []),
    filas(
      pool,
      `SELECT u.ID AS id, u.Name AS nombre FROM users u WHERE u.Name LIKE ? LIMIT 10`,
      [like]
    ).catch(() => []),
  ]);
  return {
    tickets: tickets.map((x) => ({ acct: num(x.acct), ticket: numTicket(x.acct), fecha: x.fecha, cajero: x.cajero, total: num(x.total) })),
    productos: productos.map((x) => ({ id: x.id, codigo: x.codigo, nombre: x.nombre, precio: num(x.precio) })),
    usuarios: usuarios.map((x) => ({ id: x.id, nombre: x.nombre })),
  };
}

/** Informe formal de auditoría (resumen ejecutivo, hallazgos, fichas, anexos). */
const informeCache = { t: 0, k: "", v: null };
export async function informeAuditoria(pool, ctx) {
  const { desde, hasta } = ctx.r;
  const aj = ctx.aj || {};
  const tol = num(aj.tolCierre) || 500;
  const P = [desde, hasta];
  const ck = `${desde}|${hasta}|${ctx.uid || ""}|${tol}`;
  if (informeCache.v && informeCache.k === ck && Date.now() - informeCache.t < 45000) {
    return informeCache.v;
  }

  const [
    cajaData,
    ventasRes,
    tarjetaSinBanco,
    parcialesCero,
    anulaciones,
    cancelaciones,
    consumoCasa,
    cambiosPrecio,
    productosElim,
    stockNeg,
    arqueosAjuste,
    porUsuarioVentas,
    porUsuarioAnul,
    porUsuarioCancel,
    porUsuarioDev,
    evidenciasParcialFinal,
  ] = await Promise.all([
    caja(pool, { ...ctx, uid: null }, { todo: true }),
    una(pool, `SELECT COALESCE(SUM(${IMP}),0) AS total, COUNT(DISTINCT o.Acct) AS tickets FROM operations o WHERE ${VENTA} AND ${RANGO}`, P),
    // Tickets pagados con tarjeta (Mode 2) — señal para cruzar con banco
    filas(
      pool,
      `SELECT p.Acct AS acct, MAX(p.Qtty) AS monto, MAX(p.Mode) AS modo,
              MAX(DATE_FORMAT(sh.DateTimeOpen,'%Y-%m-%d %H:%i')) AS turno,
              MAX(u.Name) AS cajero, MAX(o.Name) AS local
       FROM payments p
       JOIN shift sh ON sh.ID = p.ShiftID
       LEFT JOIN users u ON u.ID = sh.UserID
       LEFT JOIN objects o ON o.ID = sh.ObjectID
       WHERE p.OperType = 2 AND p.Mode = 2
         AND sh.DateTimeOpen >= ? AND sh.DateTimeOpen < DATE_ADD(?, INTERVAL 1 DAY)
       GROUP BY p.Acct
       ORDER BY monto DESC LIMIT 80`,
      P
    ).catch(() => []),
    // Cierres con contado 0 y libro/esperado > 0 ("cuenta a casa $0")
    Promise.resolve(null), // se llena desde cajaData
    filas(
      pool,
      `SELECT DATE_FORMAT(l.UserRealTime,'%Y-%m-%d %H:%i') AS fecha, u.Name AS usuario, l.Message AS mensaje
       FROM applicationlog l LEFT JOIN users u ON u.ID = l.UserID
       WHERE ${LOGF} AND (l.Message LIKE 'Anular venta%' OR l.Message LIKE '%Anular venta%' OR l.Message LIKE '%anulada%')
       ORDER BY l.UserRealTime DESC LIMIT 100`,
      P
    ).catch(() => []),
    filas(
      pool,
      `SELECT DATE_FORMAT(l.UserRealTime,'%Y-%m-%d %H:%i') AS fecha, u.Name AS usuario, l.Message AS mensaje
       FROM applicationlog l LEFT JOIN users u ON u.ID = l.UserID
       WHERE ${LOGF} AND l.Message LIKE '%operación cancelada%'
       ORDER BY l.UserRealTime DESC LIMIT 100`,
      P
    ).catch(() => []),
    // Consumo casa: Partner con nombre tipo casa / consumo interno / OperType especiales
    filas(
      pool,
      `SELECT DATE_FORMAT(${F},'%Y-%m-%d %H:%i') AS fecha, g.Name AS producto, ABS(o.Qtty) AS cant,
              ${IMP} AS importe, u.Name AS usuario, COALESCE(p.Company, p.Name, '') AS socio, o.Note AS nota
       FROM operations o
       LEFT JOIN goods g ON g.ID = o.GoodID
       LEFT JOIN users u ON u.ID = o.UserID
       LEFT JOIN partners p ON p.ID = o.PartnerID
       WHERE ${RANGO} AND (
         LOWER(COALESCE(p.Company,'')) LIKE '%casa%'
         OR LOWER(COALESCE(p.Name,'')) LIKE '%casa%'
         OR LOWER(COALESCE(p.Company,'')) LIKE '%consumo%'
         OR LOWER(COALESCE(o.Note,'')) LIKE '%casa%'
         OR LOWER(COALESCE(o.Note,'')) LIKE '%consumo%'
         OR o.OperType IN (12, 13)
       )
       ORDER BY ${F} DESC LIMIT 80`,
      P
    ).catch(() => []),
    filas(
      pool,
      `SELECT DATE_FORMAT(l.UserRealTime,'%Y-%m-%d %H:%i') AS fecha, u.Name AS usuario, l.Message AS mensaje
       FROM applicationlog l LEFT JOIN users u ON u.ID = l.UserID
       WHERE ${LOGF} AND (l.Message LIKE '%precio de venta%' OR l.Message LIKE '%antiguo precio%' OR l.Message LIKE '%modificado la mercanc%')
       ORDER BY l.UserRealTime DESC LIMIT 80`,
      P
    ).catch(() => []),
    filas(
      pool,
      `SELECT DATE_FORMAT(l.UserRealTime,'%Y-%m-%d %H:%i') AS fecha, u.Name AS usuario, l.Message AS mensaje
       FROM applicationlog l LEFT JOIN users u ON u.ID = l.UserID
       WHERE ${LOGF} AND (l.Message LIKE '%eliminó%' OR l.Message LIKE '%eliminado%' OR l.Message LIKE '%se eliminó%')
       ORDER BY l.UserRealTime DESC LIMIT 60`,
      P
    ).catch(() => []),
    filas(
      pool,
      `SELECT g.ID AS id, g.Code AS codigo, g.Name AS nombre, SUM(s.Qtty) AS stock, ${PRECIO} AS precio
       FROM store s JOIN goods g ON g.ID = s.GoodID
       WHERE COALESCE(g.Deleted,0)=0
       GROUP BY g.ID, g.Code, g.Name, g.PriceOut1, g.PriceOut2, g.PriceOut3
       HAVING SUM(s.Qtty) < -0.0005
       ORDER BY stock ASC LIMIT 80`
    ).catch(() => []),
    filas(
      pool,
      `SELECT DATE_FORMAT(l.UserRealTime,'%Y-%m-%d %H:%i') AS fecha, u.Name AS usuario, l.Message AS mensaje
       FROM applicationlog l LEFT JOIN users u ON u.ID = l.UserID
       WHERE ${LOGF} AND (l.Message LIKE '%auditoría de caja%' OR l.Message LIKE '%auditoria de caja%' OR l.Message LIKE '%ajuste%' OR l.Message LIKE '%reconteo%')
       ORDER BY l.UserRealTime DESC LIMIT 60`,
      P
    ).catch(() => []),
    filas(
      pool,
      `SELECT u.ID AS id, u.Name AS nombre, SUM(${IMP}) AS ventas, COUNT(DISTINCT o.Acct) AS tickets
       FROM operations o JOIN users u ON u.ID = o.UserID
       WHERE ${VENTA} AND ${RANGO} GROUP BY u.ID, u.Name ORDER BY ventas DESC`,
      P
    ).catch(() => []),
    filas(
      pool,
      `SELECT u.ID AS id, u.Name AS nombre, COUNT(*) AS n
       FROM applicationlog l LEFT JOIN users u ON u.ID = l.UserID
       WHERE ${LOGF} AND (l.Message LIKE 'Anular venta%' OR l.Message LIKE '%Anular venta%')
       GROUP BY u.ID, u.Name ORDER BY n DESC`,
      P
    ).catch(() => []),
    filas(
      pool,
      `SELECT u.ID AS id, u.Name AS nombre, COUNT(*) AS n
       FROM applicationlog l LEFT JOIN users u ON u.ID = l.UserID
       WHERE ${LOGF} AND l.Message LIKE '%operación cancelada%'
       GROUP BY u.ID, u.Name ORDER BY n DESC`,
      P
    ).catch(() => []),
    filas(
      pool,
      `SELECT u.ID AS id, u.Name AS nombre, SUM(${IMP}) AS total, COUNT(DISTINCT o.Acct) AS docs
       FROM operations o JOIN users u ON u.ID = o.UserID
       WHERE ${DEVOL} AND ${RANGO} GROUP BY u.ID, u.Name ORDER BY total DESC`,
      P
    ).catch(() => []),
    // Parcial vs final: turnos con contado 0 vs con conteo, y reaperturas en log
    filas(
      pool,
      `SELECT DATE_FORMAT(l.UserRealTime,'%Y-%m-%d %H:%i') AS fecha, u.Name AS usuario, l.Message AS mensaje
       FROM applicationlog l LEFT JOIN users u ON u.ID = l.UserID
       WHERE ${LOGF} AND (
         l.Message LIKE '%parcial%' OR l.Message LIKE '%final%'
         OR l.Message LIKE '%recont%' OR l.Message LIKE '%TotalFinal%'
         OR l.Message LIKE '%cerró%' OR l.Message LIKE '%cierre%'
       )
       ORDER BY l.UserRealTime DESC LIMIT 80`,
      P
    ).catch(() => []),
  ]);

  const parciales = (cajaData.filas || []).filter((t) => t.sinContar || (t.contado === 0 && Math.abs(t.esperado || 0) > 1));
  const conDif = (cajaData.filas || []).filter((t) => t.nivel === "media" || t.nivel === "alta");

  // Fichas por trabajador
  const mapa = new Map();
  const touch = (id, nombre) => {
    const k = String(id || nombre || "?");
    if (!mapa.has(k))
      mapa.set(k, {
        id: id || null,
        nombre: nombre || "—",
        ventas: 0,
        tickets: 0,
        anulaciones: 0,
        cancelaciones: 0,
        devoluciones: 0,
        docsDev: 0,
        faltante: 0,
        sobrante: 0,
        turnos: 0,
        turnosDif: 0,
        sinContar: 0,
        señales: [],
      });
    return mapa.get(k);
  };
  for (const x of porUsuarioVentas) {
    const f = touch(x.id, x.nombre);
    f.ventas = num(x.ventas);
    f.tickets = num(x.tickets);
  }
  for (const x of porUsuarioAnul) {
    const f = touch(x.id, x.nombre);
    f.anulaciones = num(x.n);
  }
  for (const x of porUsuarioCancel) {
    const f = touch(x.id, x.nombre);
    f.cancelaciones = num(x.n);
  }
  for (const x of porUsuarioDev) {
    const f = touch(x.id, x.nombre);
    f.devoluciones = num(x.total);
    f.docsDev = num(x.docs);
  }
  for (const c of cajaData.porCajero || []) {
    const f = touch(null, c.usuario);
    f.nombre = c.usuario;
    f.faltante = num(c.faltante);
    f.sobrante = num(c.sobrante);
    f.turnos = num(c.turnos);
    f.turnosDif = num(c.conDif);
    f.sinContar = num(c.sinContar);
  }
  const fichas = [...mapa.values()].map((f) => {
    const señales = [];
    if (f.faltante > tol * 3) señales.push({ nivel: "alta", texto: `Faltante acumulado ${Math.round(f.faltante)} CUP` });
    if (f.anulaciones >= 10) señales.push({ nivel: "alta", texto: `${f.anulaciones} anulaciones` });
    else if (f.anulaciones >= 3) señales.push({ nivel: "media", texto: `${f.anulaciones} anulaciones` });
    if (f.cancelaciones >= 15) señales.push({ nivel: "media", texto: `${f.cancelaciones} cancelaciones` });
    if (f.sinContar >= 2) señales.push({ nivel: "media", texto: `${f.sinContar} cierres sin contar` });
    if (f.turnosDif >= 3) señales.push({ nivel: "media", texto: `${f.turnosDif} turnos fuera de tolerancia` });
    if (!señales.length && f.ventas > 0) señales.push({ nivel: "ok", texto: "Sin señales fuertes" });
    return { ...f, señales, netoComunal: redondear(f.faltante - f.sobrante) };
  }).sort((a, b) => b.faltante - a.faltante || b.anulaciones - a.anulaciones || b.ventas - a.ventas);

  const hallazgos = [];
  if ((cajaData.faltante || 0) > tol)
    hallazgos.push({
      nivel: "alta",
      titulo: `Faltante de efectivo: ${Math.round(cajaData.faltante)} CUP`,
      texto: "Suma de turnos donde el contado fue menor que el libro de caja (DiffClose > 0), fuera de tolerancia.",
      seccion: "caja",
    });
  if ((cajaData.sobrante || 0) > tol)
    hallazgos.push({
      nivel: "media",
      titulo: `Sobrante de efectivo: ${Math.round(cajaData.sobrante)} CUP`,
      texto: "Suma de turnos con contado mayor al esperado. Revisar retiros no registrados o reconteos.",
      seccion: "caja",
    });
  if (parciales.length)
    hallazgos.push({
      nivel: "alta",
      titulo: `${parciales.length} cierre(s) con contado $0 (parcial / cuenta a casa)`,
      texto: "El turno cerró sin conteo físico; Axis deja el esperado como diferencia. No equivale a faltante probado hasta que se reconte.",
      seccion: "parciales",
    });
  if (tarjetaSinBanco.length)
    hallazgos.push({
      nivel: "media",
      titulo: `${tarjetaSinBanco.length} tickets con pago tarjeta en el período`,
      texto: "Cruzar montos y fechas con el extracto bancario. Admin POS no ve el banco: solo registra el Mode=tarjeta en Axis.",
      seccion: "tarjeta",
    });
  if (anulaciones.length >= 5)
    hallazgos.push({
      nivel: "media",
      titulo: `${anulaciones.length} anulaciones de venta en el log`,
      texto: "Revisar si hay patrón por usuario o ticket reabierto/recobrado.",
      seccion: "anulaciones",
    });
  if (consumoCasa.length)
    hallazgos.push({
      nivel: "media",
      titulo: `${consumoCasa.length} movimientos tipo consumo/casa`,
      texto: "Salidas asociadas a socio/nota 'casa' o consumo interno. Verificar autorización.",
      seccion: "casa",
    });
  if (stockNeg.length)
    hallazgos.push({
      nivel: "alta",
      titulo: `${stockNeg.length} productos con stock negativo`,
      texto: "Existencia < 0: ventas sin entrada, traspasos mal cargados o conteos pendientes.",
      seccion: "inventario",
    });
  if (productosElim.length)
    hallazgos.push({
      nivel: "media",
      titulo: `${productosElim.length} eventos de eliminación en el log`,
      texto: "Productos o líneas eliminadas. Contrastar con inventario.",
      seccion: "eliminados",
    });
  if (cambiosPrecio.length >= 10)
    hallazgos.push({
      nivel: "media",
      titulo: `${cambiosPrecio.length} cambios de precio registrados`,
      texto: "Ver quién cambió y si coinciden con ventas o arqueos dudosos.",
      seccion: "precios",
    });
  if (!hallazgos.length)
    hallazgos.push({
      nivel: "ok",
      titulo: "Sin hallazgos prioritarios en el período",
      texto: "No hay señales fuertes con los umbrales actuales; conviene revisar anexos igual.",
      seccion: "ok",
    });

  const recomendaciones = [];
  if (parciales.length)
    recomendaciones.push("Prohibir o controlar cierres con contado 0: exigir arqueo físico antes de cerrar turno.");
  if ((cajaData.faltante || 0) > tol)
    recomendaciones.push("Cuadrar faltantes por cajero y turno; documentar justificación o descuento de nómina según política.");
  if (tarjetaSinBanco.length)
    recomendaciones.push("Conciliar semanalmente pagos Mode=tarjeta de Axis vs depósitos/extracto bancario.");
  if (stockNeg.length)
    recomendaciones.push("Correr conteo físico de los SKU en negativo y ajustar con documento de inventario.");
  if (anulaciones.length >= 5)
    recomendaciones.push("Limitar permiso de anular ventas y exigir motivo obligatorio en Axis.");
  if (consumoCasa.length)
    recomendaciones.push("Registrar consumo de casa con socio fijo y tope diario; revisar listado en este informe.");
  if (cambiosPrecio.length >= 10)
    recomendaciones.push("Restringir cambio de precio a un rol supervisor y auditar el log semanalmente.");
  recomendaciones.push("Mantener tolerancia de caja explícita (Ajustes) y revisar solo desviaciones fuera de tolerancia.");
  recomendaciones.push("Conservar este informe + backup .woback del período como anexo de auditoría.");

  const netoComunal = redondear((cajaData.faltante || 0) - (cajaData.sobrante || 0));

  const out = {
    meta: {
      titulo: "Informe de auditoría operativa",
      desde,
      hasta,
      generado: new Date().toISOString(),
      toleranciaCaja: tol,
      fuentes: [
        "Base AxisPOS (MariaDB): operations, payments, shift, cashbook, store, goods, partners, users",
        "applicationlog de AxisPOS (cancelaciones, anulaciones, precios, eliminaciones, cierres)",
        "DiffClose y libro de caja (cashbook) para efectivo",
      ],
      metodo: [
        "Ventas = OperType 2 y Sign < 0; importe = |Qtty| × PriceOut (descuento ya en precio).",
        "Efectivo: esperado = TotalOpen + Σ(Sign×Profit cashbook) − TotalWithdrawal; diferencia = DiffClose Axis.",
        "Faltante si DiffClose > tolerancia; sobrante si DiffClose < −tolerancia.",
        "Tarjeta = payments Mode 2; no se valida depósito bancario (fuera de alcance del POS).",
        "Consumo casa = socio/nota con 'casa'/'consumo' u OperType 12/13 si existen.",
        "Stock negativo = SUM(store.Qtty) < 0 por producto.",
      ],
    },
    resumenEjecutivo: {
      ventas: num(ventasRes.total),
      tickets: num(ventasRes.tickets),
      faltante: cajaData.faltante || 0,
      sobrante: cajaData.sobrante || 0,
      netoComunal,
      turnos: cajaData.turnos || 0,
      turnosFueraTol: cajaData.conDiferencia || 0,
      cerradosSinContar: parciales.length,
      ticketsTarjeta: tarjetaSinBanco.length,
      anulaciones: anulaciones.length,
      cancelaciones: cancelaciones.length,
      stockNegativo: stockNeg.length,
      cambiosPrecio: cambiosPrecio.length,
      texto:
        `Período ${desde} a ${hasta}. Ventas ${Math.round(num(ventasRes.total))} CUP en ${num(ventasRes.tickets)} tickets. ` +
        `Efectivo: faltante ${Math.round(cajaData.faltante || 0)} / sobrante ${Math.round(cajaData.sobrante || 0)} ` +
        `(neto ${Math.round(netoComunal)}). ` +
        `${parciales.length} cierres sin conteo, ${tarjetaSinBanco.length} tickets tarjeta a conciliar con banco, ` +
        `${anulaciones.length} anulaciones en log, ${stockNeg.length} SKU en negativo.`,
    },
    hallazgos,
    detalle: {
      tarjetaSinBanco: tarjetaSinBanco.map((x) => ({
        acct: num(x.acct),
        ticket: numTicket(x.acct),
        monto: num(x.monto),
        cajero: x.cajero || "",
        local: x.local || "",
        turno: x.turno,
      })),
      parcialesCero: parciales.map((t) => ({
        id: t.id,
        usuario: t.usuario,
        apertura: t.apertura,
        cierre: t.cierre,
        esperado: t.esperado,
        contado: t.contado,
        diferencia: t.diferencia,
        libroCaja: t.libroCaja,
      })),
      anulaciones: anulaciones.map((x) => ({ fecha: x.fecha, usuario: x.usuario || "—", mensaje: x.mensaje })),
      cancelaciones: cancelaciones.map((x) => ({ fecha: x.fecha, usuario: x.usuario || "—", mensaje: x.mensaje })),
      consumoCasa: consumoCasa.map((x) => ({
        fecha: x.fecha,
        producto: x.producto,
        cant: num(x.cant),
        importe: num(x.importe),
        usuario: x.usuario || "",
        socio: x.socio || "",
        nota: x.nota || "",
      })),
      cambiosPrecio: cambiosPrecio.map((x) => ({ fecha: x.fecha, usuario: x.usuario || "—", mensaje: x.mensaje })),
      productosEliminados: productosElim.map((x) => ({ fecha: x.fecha, usuario: x.usuario || "—", mensaje: x.mensaje })),
      stockNegativo: stockNeg.map((x) => ({
        id: x.id,
        codigo: x.codigo,
        nombre: x.nombre,
        stock: num(x.stock),
        precio: num(x.precio),
      })),
      arqueosAjustes: arqueosAjuste.map((x) => ({ fecha: x.fecha, usuario: x.usuario || "—", mensaje: x.mensaje })),
      evidenciasParcialFinal: evidenciasParcialFinal.map((x) => ({
        fecha: x.fecha,
        usuario: x.usuario || "—",
        mensaje: x.mensaje,
      })),
      turnosConDiferencia: conDif.slice(0, 40).map((t) => ({
        id: t.id,
        usuario: t.usuario,
        apertura: t.apertura,
        esperado: t.esperado,
        contado: t.contado,
        diferencia: t.diferencia,
        nivel: t.nivel,
      })),
    },
    fichasTrabajadores: fichas,
    conclusionesPorPersona: fichas
      .filter((f) => f.señales.some((s) => s.nivel !== "ok") || f.ventas > 0)
      .map((f) => ({
        nombre: f.nombre,
        resumen:
          `Ventas ${Math.round(f.ventas)} CUP (${f.tickets} tickets). ` +
          `Anulaciones ${f.anulaciones}, cancelaciones ${f.cancelaciones}, ` +
          `devoluciones ${Math.round(f.devoluciones)} CUP. ` +
          `Caja: faltante ${Math.round(f.faltante)}, sobrante ${Math.round(f.sobrante)}, ` +
          `neto ${Math.round(f.netoComunal)}, cierres sin contar ${f.sinContar}.`,
        señales: f.señales,
      })),
    recomendaciones,
    limitaciones: [
      "No se accede al extracto bancario: los pagos con tarjeta deben conciliarse a mano.",
      "Los cierres con contado 0 inflan DiffClose en Axis; no demuestran por sí solos apropiación.",
      "Consumo de casa depende de cómo se nombró el socio/nota en Axis; puede haber falsos positivos o faltantes.",
      "El log (applicationlog) puede truncarse o no registrar todos los eventos según versión de Axis.",
      "Stock negativo es síntoma; la causa (venta, merma, traspaso) requiere IPV/historial del producto.",
      "Este informe es de lectura sobre la base; no modifica datos ni sustituye auditoría contable formal.",
    ],
  };
  informeCache.t = Date.now();
  informeCache.k = ck;
  informeCache.v = out;
  return out;
}
