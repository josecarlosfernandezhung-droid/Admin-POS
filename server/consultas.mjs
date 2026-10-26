// Consultas de solo lectura sobre la base de AxisPOS (MariaDB).
// Las fórmulas se comprobaron contra una copia real: ventas, tickets, devoluciones, existencias y cajeros coinciden al centavo.

// Fecha real de la venta: UserRealTime si es válida, si no Date
const F = "IF(o.UserRealTime BETWEEN '2020-01-01' AND '2036-12-31 23:59:59', o.UserRealTime, o.`Date`)";
const IMP = "(ABS(o.Qtty) * o.PriceOut * (1 - IF(o.Discount BETWEEN 0 AND 100, o.Discount, 0) / 100))";
const VENTA = "o.OperType = 2 AND COALESCE(o.Sign, 0) <= 0";
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
    // No pasar del último día con ventas
    if (hasta > ext.hasta) hasta = ext.hasta;
    if (desde < ext.desde) desde = ext.desde;
    const dias = difDias(desde, hasta) + 1;
    const r = { desde, hasta, dias, todo: false, ultimo: ext.hasta, personalizado: true };
    r.aHasta = sumarDias(desde, -1);
    r.aDesde = sumarDias(r.aHasta, -(dias - 1));
    return r;
  }
  const hasta = ext.hasta;
  let dias = periodo === "7" ? 7 : periodo === "90" ? 90 : periodo === "todo" ? null : 30;
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
      filas(pool, `SELECT DATE_FORMAT(${F},'%Y-%m-%d') AS dia, SUM(${IMP}) AS total, COUNT(DISTINCT o.Acct) AS tickets FROM operations o WHERE ${VENTA} AND ${RANGO}${U} GROUP BY dia ORDER BY dia`, P),
      filas(pool, `SELECT g.Name AS nombre, COALESCE(gg.Name,'Sin grupo') AS familia, SUM(ABS(o.Qtty)) AS unidades, SUM(${IMP}) AS total
        FROM operations o LEFT JOIN goods g ON g.ID = o.GoodID LEFT JOIN goodsgroups gg ON gg.ID = g.GroupID
        WHERE ${VENTA} AND ${RANGO}${U} GROUP BY o.GoodID, g.Name, gg.Name ORDER BY total DESC LIMIT 15`, P),
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
  const descuentos = num(costoDesc.descuentos);
  const ganancia = total - costo;
  const pct = (a, b) => (b > 0 ? redondear(((a - b) / b) * 100, 1) : null);
  return {
    desde, hasta, dias: ctx.r.dias, ultimoDia: ultimo,
    total, tickets, unidades: num(tot.unidades), promedio: tickets ? total / tickets : 0,
    devoluciones: num(dev.total), devDocs: num(dev.docs), neto: total - num(dev.total),
    costo, descuentos, ganancia,
    margen: total > 0 ? ganancia / total : 0,
    costoPorPeso: total > 0 ? costo / total : 0,
    anterior: ant ? { total: ant.total, tickets: ant.tickets, variacion: pct(total, ant.total) } : null,
    porHora: horas.map((x) => ({ hora: num(x.hora), total: num(x.total), tickets: num(x.tickets) })),
    porDia: dias.map((x) => ({ dia: x.dia, total: num(x.total), tickets: num(x.tickets) })),
    top: top.map((x) => ({ nombre: x.nombre, familia: x.familia, unidades: num(x.unidades), total: num(x.total) })),
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
}

// ---------- Ventas ----------
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
    `SELECT o.ID AS id, o.OperType AS tipo, g.Name AS nombre, ABS(o.Qtty) AS cant, o.PriceOut AS precio,
            IF(o.Discount BETWEEN 0 AND 100, o.Discount, 0) AS descuento, ${IMP} AS importe,
            ${F} AS fecha, u.Name AS cajero, p.Company AS socio, o.Note AS nota
     FROM operations o LEFT JOIN goods g ON g.ID = o.GoodID LEFT JOIN users u ON u.ID = o.UserID LEFT JOIN partners p ON p.ID = o.PartnerID
     WHERE o.Acct = ? AND o.OperType IN (2, 34)${extra} ORDER BY o.ID`,
    params
  );
  if (!lineas.length) return null;
  const devol = lineas[0].tipo === 34;

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
    fecha: lineas[0].fecha,
    cajero: lineas[0].cajero,
    socio: lineas[0].socio,
    lineas: lineas.map((l) => ({
      nombre: l.nombre,
      cant: num(l.cant),
      precio: num(l.precio),
      descuento: num(l.descuento),
      importe: num(l.importe),
      nota: l.nota || "",
    })),
    total: lineas.reduce((s, l) => s + num(l.importe), 0),
    logs: logs.map((x) => ({
      fecha: x.fecha,
      usuario: x.usuario || "—",
      mensaje: String(x.mensaje || "").replace(/\s+/g, " ").slice(0, 200),
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
    movLocal = " AND EXISTS (SELECT 1 FROM shift sh WHERE sh.ID = o.ShiftID AND sh.ObjectID = ?)";
    movParams.push(local);
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
  const filasMov = [...porProd.values()].map((p) => {
    const final = p.final;
    const inicio = redondear(final - p.netoMov, 3);
    const costoU = p.costoUnit > 0 ? p.costoUnit : 0;
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

  const stockPorLocal = await filas(
    pool,
    `SELECT s.ObjectID AS lid, o.Name AS local, s.GoodID AS gid, g.Code AS codigo, g.Name AS nombre,
            COALESCE(gg.Name,'Sin grupo') AS familia, SUM(s.Qtty) AS cant, g.PriceIn AS costo, ${PRECIO} AS precio
     FROM store s
     JOIN objects o ON o.ID = s.ObjectID
     JOIN goods g ON g.ID = s.GoodID
     LEFT JOIN goodsgroups gg ON gg.ID = g.GroupID
     WHERE COALESCE(g.Deleted,0) = 0
     GROUP BY s.ObjectID, o.Name, s.GoodID, g.Code, g.Name, gg.Name, g.PriceIn, g.PriceOut1, g.PriceOut2, g.PriceOut3
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

  // Stock index: gid -> { pv: cant, alm: cant, nombre, ... }
  const idx = new Map();
  for (const s of stockPorLocal) {
    const gid = num(s.gid);
    if (!idx.has(gid)) {
      idx.set(gid, {
        id: gid,
        codigo: s.codigo,
        nombre: s.nombre,
        familia: s.familia,
        costo: num(s.costo),
        precio: num(s.precio),
        enPv: 0,
        enAlm: 0,
        detallePv: [],
        detalleAlm: [],
      });
    }
    const row = idx.get(gid);
    const cant = num(s.cant);
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
    if (diaria <= 0 && row.enPv > 0) continue; // no se vende y ya hay en PV
    if (row.enAlm <= 0.0005) continue; // nada en almacén
    const coberturaPv = diaria > 0 ? row.enPv / diaria : (row.enPv > 0 ? 999 : 0);
    // Hace falta si cobertura en PV < días objetivo, o está agotado en PV y se vende
    if (diaria > 0 && coberturaPv >= diasObjetivo) continue;
    if (diaria <= 0) continue;
    const objetivo = diaria * diasObjetivo;
    let pedir = Math.max(0, objetivo - row.enPv);
    pedir = Math.min(pedir, row.enAlm);
    pedir = redondear(pedir, 2);
    if (pedir < 0.5 && row.enPv > 0.0005) continue;
    if (pedir < 0.01) continue;
    const urgencia = coberturaPv <= 3 ? "alta" : coberturaPv <= 7 ? "media" : "baja";
    sugerencias.push({
      id: row.id,
      codigo: row.codigo,
      nombre: row.nombre,
      familia: row.familia,
      diaria: redondear(diaria, 2),
      enPv: redondear(row.enPv, 2),
      enAlm: redondear(row.enAlm, 2),
      coberturaPv: redondear(coberturaPv, 1),
      sugerido: pedir,
      valorCosto: redondear(pedir * (row.costo > 0 ? row.costo : 0)),
      urgencia,
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
    puntosVenta: localesPv,
    almacenes: localesAlm,
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
export async function caja(pool, ctx, q) {
  const { desde, hasta } = ctx.r;
  const tol = ctx.aj.tolCierre;
  const pagina = Math.max(parseInt(q.pagina, 10) || 1, 1);
  const filtroU = ctx.uid != null ? " AND sh.UserID = ?" : "";
  const params = ctx.uid != null ? [desde, hasta, ctx.uid] : [desde, hasta];
  const todos = await filas(
    pool,
    `SELECT sh.ID AS id, o.Name AS local, u.Name AS usuario, DATE_FORMAT(sh.DateTimeOpen,'%Y-%m-%d %H:%i:%s') AS apertura,
            DATE_FORMAT(sh.DateTimeClose,'%Y-%m-%d %H:%i:%s') AS cierre, sh.TotalOpen AS inicial, sh.TotalFinal AS contado,
            sh.TotalWithdrawal AS retiro, sh.DiffClose AS difAxis, COALESCE(v.total,0) AS ventas, COALESCE(v.tickets,0) AS tickets,
            COALESCE(d.total,0) AS devoluciones, COALESCE(pg.total,0) AS pagos
     FROM shift sh LEFT JOIN objects o ON o.ID = sh.ObjectID LEFT JOIN users u ON u.ID = sh.UserID
     LEFT JOIN (SELECT o.ShiftID, SUM(${IMP}) AS total, COUNT(DISTINCT o.Acct) AS tickets FROM operations o WHERE ${VENTA} GROUP BY o.ShiftID) v ON v.ShiftID = sh.ID
     LEFT JOIN (SELECT o.ShiftID, SUM(${IMP}) AS total FROM operations o WHERE ${DEVOL} GROUP BY o.ShiftID) d ON d.ShiftID = sh.ID
     LEFT JOIN (SELECT ShiftID, SUM(Qtty) AS total FROM payments WHERE OperType = 2 AND Mode = 1 GROUP BY ShiftID) pg ON pg.ShiftID = sh.ID
     WHERE sh.DateTimeOpen >= ? AND sh.DateTimeOpen < DATE_ADD(?, INTERVAL 1 DAY)${filtroU} ORDER BY sh.DateTimeOpen DESC`,
    params
  );
  const turnos = todos.map((t) => {
    const ventas = num(t.ventas), dev = num(t.devoluciones), contado = num(t.contado);
    const esperado = num(t.inicial) + ventas - dev - num(t.retiro);
    const cerrado = !!t.cierre && contado > 0;
    const dif = cerrado ? redondear(contado - esperado) : null;
    const difPagos = redondear(ventas - num(t.pagos));
    const nivel = dif == null ? null : Math.abs(dif) > tol * 10 ? "alta" : Math.abs(dif) > tol ? "media" : "ok";
    return {
      id: t.id, local: t.local, usuario: t.usuario, apertura: t.apertura, cierre: t.cierre, tickets: num(t.tickets),
      ventas, devoluciones: dev, retiro: num(t.retiro), inicial: num(t.inicial), esperado: redondear(esperado), contado,
      diferencia: dif, nivel, difAxis: num(t.difAxis), pagos: num(t.pagos), difPagos, sinCierre: !cerrado && !!t.cierre,
    };
  });
  const [[dv], formas] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(${IMP}),0) AS total FROM operations o WHERE ${DEVOL} AND ${RANGO}${uid(ctx)}`, parRango(ctx, desde, hasta)),
    filas(pool, `SELECT COALESCE(p.Company,'Sin socio') AS socio, COUNT(DISTINCT o.Acct) AS tickets, SUM(${IMP}) AS total
      FROM operations o LEFT JOIN partners p ON p.ID = o.PartnerID WHERE ${VENTA} AND ${RANGO}${uid(ctx)} GROUP BY p.ID, p.Company ORDER BY total DESC`, parRango(ctx, desde, hasta)),
  ]);
  const ventasTot = turnos.reduce((s, t) => s + t.ventas, 0);
  const conDif = turnos.filter((t) => t.nivel === "media" || t.nivel === "alta");
  const paginas = Math.max(Math.ceil(turnos.length / 20), 1);

  // Histórico de diferencias por cajero (faltantes / sobrantes) para auditoría
  const porCajeroMap = new Map();
  for (const t of turnos) {
    if (t.diferencia == null) continue;
    const k = t.usuario || "Sin nombre";
    if (!porCajeroMap.has(k)) porCajeroMap.set(k, { usuario: k, turnos: 0, conDif: 0, faltante: 0, sobrante: 0, totalDif: 0, maxFaltante: 0, maxSobrante: 0 });
    const c = porCajeroMap.get(k);
    c.turnos += 1;
    c.totalDif += t.diferencia;
    if (t.diferencia < 0) {
      c.faltante += t.diferencia;
      c.maxFaltante = Math.min(c.maxFaltante, t.diferencia);
      c.conDif += 1;
    } else if (t.diferencia > 0) {
      c.sobrante += t.diferencia;
      c.maxSobrante = Math.max(c.maxSobrante, t.diferencia);
      c.conDif += 1;
    }
  }
  const porCajero = [...porCajeroMap.values()]
    .map((c) => ({ ...c, faltante: redondear(c.faltante), sobrante: redondear(c.sobrante), totalDif: redondear(c.totalDif), maxFaltante: redondear(c.maxFaltante), maxSobrante: redondear(c.maxSobrante) }))
    .sort((a, b) => Math.abs(b.totalDif) - Math.abs(a.totalDif));

  return {
    ventas: ventasTot, devoluciones: num(dv[0].total), neto: ventasTot - num(dv[0].total), turnos: turnos.length,
    conDiferencia: conDif.length, faltante: redondear(conDif.filter((t) => t.diferencia < 0).reduce((s, t) => s + t.diferencia, 0)),
    sobrante: redondear(conDif.filter((t) => t.diferencia > 0).reduce((s, t) => s + t.diferencia, 0)),
    sinCuadrar: turnos.filter((t) => Math.abs(t.difPagos) > 1 && t.ventas > 0).length, tolerancia: tol,
    formasPago: formas.map((x) => ({ socio: x.socio, tickets: num(x.tickets), total: num(x.total) })),
    porCajero,
    pagina, paginas, filas: q.todo ? turnos : turnos.slice((pagina - 1) * 20, pagina * 20),
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

export async function equipoCompleto(pool, ctx) {
  const lista = await equipo(pool, ctx);
  const formas = await filas(pool, `SELECT COALESCE(p.Company,'Sin socio') AS socio, COUNT(DISTINCT o.Acct) AS tickets, SUM(${IMP}) AS total
    FROM operations o LEFT JOIN partners p ON p.ID = o.PartnerID WHERE ${VENTA} AND ${RANGO} GROUP BY p.ID, p.Company ORDER BY total DESC`, [ctx.r.desde, ctx.r.hasta]);
  return { cajeros: lista, socios: formas.map((x) => ({ socio: x.socio, tickets: num(x.tickets), total: num(x.total) })) };
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
    elim: "l.Message LIKE '%se eliminó%'",
    desc: "l.Message LIKE '%cambiado el descuento%'",
    login: "l.Message LIKE 'Inicio fallido%'",
    cajon: "l.Message LIKE '%cajón de moneda%'",
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

  // Intentar extraer número de ticket/cuenta del mensaje para poder abrir la venta original
  const filasOut = [];
  for (const x of lista) {
    const msg = String(x.mensaje || "").replace(/\s+/g, " ");
    // Buscar números largos que puedan ser Acct (tickets AxisPOS suelen ser numéricos)
    const nums = (msg.match(/\b\d{5,12}\b/g) || []).map((s) => parseInt(s, 10)).filter((n) => n > 0);
    let acct = null;
    let ticketInfo = null;
    if (nums.length) {
      // Probar el último número largo del mensaje (suele ser el ticket)
      for (const candidato of nums.reverse()) {
        const t = await una(pool, `SELECT o.Acct AS acct, MAX(${F}) AS fecha, SUM(${IMP}) AS total, MAX(u.Name) AS cajero
          FROM operations o LEFT JOIN users u ON u.ID = o.UserID
          WHERE o.Acct = ? AND o.OperType IN (2, 34) GROUP BY o.Acct LIMIT 1`, [candidato]);
        if (t && t.acct) {
          acct = num(t.acct);
          ticketInfo = { ticket: numTicket(acct), fecha: t.fecha, total: num(t.total), cajero: t.cajero };
          break;
        }
      }
    }
    filasOut.push({
      id: x.id,
      fecha: x.fecha,
      usuario: x.usuario || "—",
      mensaje: msg.slice(0, 220),
      acct,
      ticket: ticketInfo ? ticketInfo.ticket : null,
      ticketTotal: ticketInfo ? ticketInfo.total : null,
      ticketFecha: ticketInfo ? ticketInfo.fecha : null,
    });
  }
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
  const { desde, hasta } = ctx.r;
  const aj = ctx.aj;
  const P = [desde, hasta];

  const [anom, cajaData, ticketsGrandes, descAltos, porHoraNoche, cancelDia, resumenVentas, topCanceladores] =
    await Promise.all([
      anomalias(pool, ctx),
      caja(pool, { ...ctx, uid: null }, { todo: true }),
      filas(
        pool,
        `SELECT o.Acct AS acct, MAX(${F}) AS fecha, SUM(${IMP}) AS total, MAX(u.Name) AS cajero, COUNT(*) AS lineas
         FROM operations o LEFT JOIN users u ON u.ID = o.UserID
         WHERE ${VENTA} AND ${RANGO}
         GROUP BY o.Acct HAVING SUM(${IMP}) >= ?
         ORDER BY total DESC LIMIT 25`,
        [...P, Math.max(aj.umbralCancel || 100000, 50000)]
      ),
      filas(
        pool,
        `SELECT o.Acct AS acct, MAX(${F}) AS fecha, g.Name AS nombre, ABS(o.Qtty) AS cant,
                o.PriceOut AS precio, IF(o.Discount BETWEEN 0 AND 100, o.Discount, 0) AS descuento,
                ${IMP} AS importe, u.Name AS cajero
         FROM operations o
         LEFT JOIN goods g ON g.ID = o.GoodID
         LEFT JOIN users u ON u.ID = o.UserID
         WHERE ${VENTA} AND ${RANGO} AND IF(o.Discount BETWEEN 0 AND 100, o.Discount, 0) >= ?
         ORDER BY descuento DESC, ${F} DESC LIMIT 40`,
        [...P, aj.descMax || 20]
      ),
      filas(
        pool,
        `SELECT HOUR(${F}) AS hora, COUNT(DISTINCT o.Acct) AS tickets, SUM(${IMP}) AS total
         FROM operations o WHERE ${VENTA} AND ${RANGO}
           AND (HOUR(${F}) < 7 OR HOUR(${F}) >= 21)
         GROUP BY hora ORDER BY hora`,
        P
      ),
      filas(
        pool,
        `SELECT DATE_FORMAT(l.UserRealTime,'%Y-%m-%d') AS dia, COUNT(*) AS n
         FROM applicationlog l
         WHERE ${LOGF} AND (l.Message LIKE '%operación cancelada%' OR l.Message LIKE 'Anular venta%')
         GROUP BY dia ORDER BY dia DESC LIMIT 30`,
        P
      ),
      una(pool, `SELECT COALESCE(SUM(${IMP}),0) AS total, COUNT(DISTINCT o.Acct) AS tickets FROM operations o WHERE ${VENTA} AND ${RANGO}`, P),
      filas(
        pool,
        `SELECT u.Name AS nombre, l.UserID AS id, COUNT(*) AS n
         FROM applicationlog l LEFT JOIN users u ON u.ID = l.UserID
         WHERE ${LOGF} AND (l.Message LIKE '%operación cancelada%' OR l.Message LIKE 'Anular venta%')
         GROUP BY l.UserID, u.Name ORDER BY n DESC LIMIT 10`,
        P
      ),
    ]);

  const cajaPorUser = new Map();
  for (const t of cajaData.filas || []) {
    const k = t.usuario || "Sin nombre";
    if (!cajaPorUser.has(k)) cajaPorUser.set(k, { faltante: 0, sobrante: 0, turnos: 0, conDif: 0 });
    const c = cajaPorUser.get(k);
    c.turnos += 1;
    if (t.diferencia != null) {
      if (t.diferencia < 0) c.faltante += t.diferencia;
      if (t.diferencia > 0) c.sobrante += t.diferencia;
      if (t.nivel === "media" || t.nivel === "alta") c.conDif += 1;
    }
  }

  const scorecard = (anom.usuarios || [])
    .map((u) => {
      const cj = cajaPorUser.get(u.nombre) || { faltante: 0, sobrante: 0, turnos: 0, conDif: 0 };
      const riesgo =
        u.flags.filter((f) => f.nivel === "alta").length * 3 +
        u.flags.filter((f) => f.nivel === "media").length +
        (cj.conDif > 2 ? 2 : 0) +
        (Math.abs(cj.faltante) > (aj.tolCierre || 500) * 5 ? 2 : 0);
      return {
        id: u.id,
        nombre: u.nombre,
        tickets: u.tickets,
        cancel: u.cancel,
        anuladas: u.anuladas,
        lineasElim: u.lineasElim,
        descAltos: u.descAltos,
        devoluciones: u.devoluciones,
        tasaCancel: u.tasaCancel,
        tasaDev: u.tasaDev,
        flags: u.flags,
        cajaFaltante: redondear(cj.faltante),
        cajaSobrante: redondear(cj.sobrante),
        cajaTurnos: cj.turnos,
        cajaConDif: cj.conDif,
        riesgo,
        nivel: riesgo >= 8 ? "alta" : riesgo >= 4 ? "media" : "ok",
      };
    })
    .sort((a, b) => b.riesgo - a.riesgo);

  const hallazgos = [];
  if (anom.totales.alta > 0)
    hallazgos.push({
      nivel: "alta",
      titulo: `${anom.totales.alta} alerta(s) alta(s) de comportamiento`,
      texto: "Hay cajeros con cancelaciones, anulaciones o descuentos fuera de lo normal. Revisa el scorecard.",
    });
  if (cajaData.faltante < -(aj.tolCierre || 500) * 3)
    hallazgos.push({
      nivel: "alta",
      titulo: `Faltante de caja acumulado: ${Math.round(cajaData.faltante)} CUP`,
      texto: "El dinero contado al cierre está por debajo de lo esperado en varios turnos.",
    });
  if (cajaData.sobrante > (aj.tolCierre || 500) * 10)
    hallazgos.push({
      nivel: "media",
      titulo: `Sobrante de caja muy alto: +${Math.round(cajaData.sobrante)} CUP`,
      texto: "Puede indicar fondos iniciales mal registrados, retiros no apuntados o contados que mezclan formas de pago.",
    });
  if ((cajaData.sinCuadrar || 0) > 5)
    hallazgos.push({
      nivel: "media",
      titulo: `${cajaData.sinCuadrar} turnos sin cuadrar ventas vs cobros`,
      texto: "Las ventas del sistema no coinciden con los pagos registrados.",
    });
  if (descAltos.length >= 10)
    hallazgos.push({
      nivel: "media",
      titulo: `${descAltos.length} líneas con descuento ≥ ${aj.descMax} %`,
      texto: "Revisa si los descuentos altos están autorizados.",
    });
  if (porHoraNoche.length)
    hallazgos.push({
      nivel: "media",
      titulo: "Ventas fuera de horario (antes de 7:00 o desde 21:00)",
      texto: `${porHoraNoche.reduce((s, x) => s + num(x.tickets), 0)} tickets en horario atípico.`,
    });
  if (!hallazgos.length)
    hallazgos.push({
      nivel: "ok",
      titulo: "Sin alertas prioritarias en este período",
      texto: "No hay señales fuertes; igual conviene revisar el scorecard y la caja.",
    });

  return {
    desde,
    hasta,
    hallazgos,
    scorecard,
    caja: {
      faltante: cajaData.faltante,
      sobrante: cajaData.sobrante,
      conDiferencia: cajaData.conDiferencia,
      sinCuadrar: cajaData.sinCuadrar,
      turnos: cajaData.turnos,
      porCajero: cajaData.porCajero || [],
    },
    ticketsGrandes: ticketsGrandes.map((x) => ({
      acct: num(x.acct),
      ticket: numTicket(x.acct),
      fecha: x.fecha,
      total: num(x.total),
      cajero: x.cajero || "",
      lineas: num(x.lineas),
    })),
    descuentosAltos: descAltos.map((x) => ({
      acct: num(x.acct),
      ticket: numTicket(x.acct),
      fecha: x.fecha,
      nombre: x.nombre,
      cant: num(x.cant),
      descuento: num(x.descuento),
      importe: num(x.importe),
      cajero: x.cajero || "",
    })),
    fueraHorario: porHoraNoche.map((x) => ({ hora: num(x.hora), tickets: num(x.tickets), total: num(x.total) })),
    cancelacionesPorDia: cancelDia.map((x) => ({ dia: x.dia, n: num(x.n) })),
    topCanceladores: topCanceladores.map((x) => ({ id: num(x.id), nombre: x.nombre || "—", n: num(x.n) })),
    ventas: { total: num(resumenVentas.total), tickets: num(resumenVentas.tickets) },
    umbrales: { descMax: aj.descMax, umbralCancel: aj.umbralCancel, tolCierre: aj.tolCierre },
  };
}

// ---------- Usuarios de AxisPOS (para PIN y roles) ----------
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
