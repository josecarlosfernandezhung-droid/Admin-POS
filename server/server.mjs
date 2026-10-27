// Servidor del Admin POS: lee MariaDB (solo lectura), controla PIN y roles, y sirve la pantalla.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import * as A from "./almacen.mjs";
import * as Q from "./consultas.mjs";
import * as Lic from "./licencia.mjs";

const WWW = join(dirname(fileURLToPath(import.meta.url)), "..", "www");
const TIPOS = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json",
};

// ---------- Conexión a MariaDB ----------
let pool = null;
let poolClave = "";

function crearPool(db) {
  const p = mysql.createPool({
    host: db.host, port: db.puerto, user: db.usuario, password: db.clave, database: db.base,
    connectionLimit: 4, connectTimeout: 6000, charset: "utf8mb4", dateStrings: true, decimalNumbers: true,
  });
  // Seguro extra: aunque el usuario tuviera permisos de escritura, esta sesión es de solo lectura
  try {
    p.pool.on("connection", (c) => c.query("SET SESSION TRANSACTION READ ONLY", () => {}));
  } catch {}
  return p;
}

function obtenerPool() {
  const db = A.leer().db;
  if (!db) return null;
  const clave = JSON.stringify(db);
  if (pool && poolClave === clave) return pool;
  if (pool) pool.end().catch(() => {});
  pool = crearPool(db);
  poolClave = clave;
  return pool;
}

let dbEstado = { t: 0, clave: "", error: null };
async function probarDb() {
  const p = obtenerPool();
  if (!p) return "sin_config";
  if (dbEstado.clave === poolClave && Date.now() - dbEstado.t < 8000) return dbEstado.error;
  let error = null;
  try {
    await p.query("SELECT 1");
  } catch (e) {
    error = mensajeDb(e, A.leer().db);
  }
  dbEstado = { t: Date.now(), clave: poolClave, error };
  return error;
}

function mensajeDb(e, db = {}) {
  if (e.code === "ER_ACCESS_DENIED_ERROR") return "Usuario o contraseña de MariaDB incorrectos.";
  if (e.code === "ER_BAD_DB_ERROR") return "Esa base de datos no existe en MariaDB.";
  if (e.code === "ER_NO_SUCH_TABLE") return "Esa base no parece ser de AxisPOS (faltan tablas).";
  if (["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH"].includes(e.code))
    return `No se pudo conectar a MariaDB en ${db.host || "?"}:${db.puerto || "?"}. ¿Está encendido?`;
  return "Error de la base de datos: " + (e.sqlMessage || e.message || e.code || "desconocido");
}

// ---------- Utilidades HTTP ----------
const esLocal = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
const ipsLocales = () => Object.values(networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);

function responder(res, estado, datos) {
  res.writeHead(estado, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(datos));
}
const falla = (res, estado, error, extra = {}) => responder(res, estado, { error, ...extra });

function leerJson(req) {
  return new Promise((ok, mal) => {
    let txt = "";
    req.on("data", (c) => {
      txt += c;
      if (txt.length > 20_000) {
        mal(new Error("Cuerpo demasiado grande"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        ok(JSON.parse(txt || "{}"));
      } catch {
        mal(new Error("JSON inválido"));
      }
    });
    req.on("error", mal);
  });
}

const pinValido = (p) => /^\d{4,8}$/.test(String(p || ""));
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Usuarios de AxisPOS (con caché corto) ----------
let usuariosCache = { t: 0, v: [] };
async function usuariosAxis(p, fresco = false) {
  if (!fresco && Date.now() - usuariosCache.t < 20000 && usuariosCache.v.length) return usuariosCache.v;
  const v = await Q.usuariosAxis(p);
  usuariosCache = { t: Date.now(), v };
  return v;
}

const perfil = (u) => ({ id: u.id, nombre: u.nombre, rol: u.rol, permisos: A.PERMISOS[u.rol] });
const adminsConPin = (lista) => lista.filter((u) => A.rolDe(u.id, u.nivel) === "admin" && A.leer().usuarios[u.id]?.hash);

// ---------- Rutas públicas / de configuración ----------
async function estado(req, res) {
  const cfg = A.leer();
  const local = esLocal(req);
  const lic = Lic.estadoLicencia();
  const base = {
    dbConfigurada: !!cfg.db,
    pinsConfigurados: A.hayPins(),
    local,
    ips: ipsLocales(),
    licencia: {
      ok: !!lic.ok,
      requiere: !!lic.requiere && !!lic.tieneClavePublica,
      mc: lic.mcFmt || lic.mc,
      error: lic.error || null,
      cliente: lic.cliente || null,
      expira: lic.expira || null,
      tieneClavePublica: !!lic.tieneClavePublica,
    },
  };
  if (!cfg.db) return responder(res, 200, { ...base, usuarios: [], dbError: null });
  const err = await probarDb();
  if (err) return responder(res, 200, { ...base, usuarios: [], dbError: err });
  const lista = await usuariosAxis(obtenerPool());
  const conPin = lista.filter((u) => cfg.usuarios[u.id]?.hash).map((u) => ({ id: u.id, nombre: u.nombre, rol: A.rolDe(u.id, u.nivel) }));
  const candidatos = local && !base.pinsConfigurados ? lista.filter((u) => u.nivel >= 3).map((u) => ({ id: u.id, nombre: u.nombre })) : [];
  responder(res, 200, { ...base, usuarios: conPin, candidatosAdmin: candidatos, dbError: null });
}

async function guardarDb(req, res, sesion) {
  const cfg = A.leer();
  const b = await leerJson(req);
  const permitido = (!cfg.db && esLocal(req)) || (sesion && sesion.rol === "admin") || (cfg.db && esLocal(req) && !A.hayPins());
  if (!permitido) return falla(res, 403, cfg.db ? "Solo el administrador puede cambiar la conexión." : "La primera configuración debe hacerse desde la PC.");
  const db = {
    host: String(b.host || "127.0.0.1").trim(), puerto: parseInt(b.puerto, 10) || 3306,
    base: String(b.base || "").trim(), usuario: String(b.usuario || "").trim(), clave: String(b.clave ?? ""),
  };
  if (!db.base || !/^[\w$.-]+$/.test(db.base)) return falla(res, 400, "Escribe el nombre de la base de datos.");
  if (!db.usuario) return falla(res, 400, "Escribe el usuario de MariaDB.");
  if (!db.clave && cfg.db && cfg.db.usuario === db.usuario) db.clave = cfg.db.clave;
  const prueba = crearPool(db);
  try {
    await prueba.query("SELECT COUNT(*) FROM users");
  } catch (e) {
    await prueba.end().catch(() => {});
    await pausa(500);
    return falla(res, 400, mensajeDb(e, db));
  }
  const permisos = await Q.comprobarPermisos(prueba);
  await prueba.end().catch(() => {});
  cfg.db = db;
  A.guardar();
  usuariosCache = { t: 0, v: [] };
  dbEstado = { t: 0, clave: "", error: null };
  responder(res, 200, { ok: true, permisos });
}

async function pinInicial(req, res) {
  if (!esLocal(req) || A.hayPins()) return falla(res, 403, "Ya hay PIN configurados o no estás en la PC.");
  const p = obtenerPool();
  if (!p) return falla(res, 400, "Primero configura la conexión a MariaDB.");
  const b = await leerJson(req);
  if (!pinValido(b.pin)) return falla(res, 400, "El PIN debe tener de 4 a 8 números.");
  const u = (await usuariosAxis(p, true)).find((x) => x.id === Number(b.id) && x.nivel >= 3);
  if (!u) return falla(res, 400, "Elige un administrador de AxisPOS.");
  A.leer().usuarios[u.id] = { ...A.hashPin(String(b.pin)), rol: "admin" };
  A.guardar();
  const token = A.abrirSesion({ id: u.id, nombre: u.nombre, rol: "admin" });
  responder(res, 200, { token, usuario: perfil({ id: u.id, nombre: u.nombre, rol: "admin" }) });
}

async function reiniciarPins(req, res) {
  if (!esLocal(req)) return falla(res, 403, "Solo se puede hacer desde la PC.");
  const b = await leerJson(req);
  const db = A.leer().db;
  if (!db || String(b.clave || "") !== db.clave) {
    await pausa(800);
    return falla(res, 401, "La contraseña de MariaDB no coincide.");
  }
  A.leer().usuarios = {};
  A.guardar();
  A.cerrarTodas();
  responder(res, 200, { ok: true });
}

async function login(req, res) {
  const p = obtenerPool();
  if (!p) return falla(res, 400, "Falta configurar la conexión.");
  const b = await leerJson(req);
  const id = Number(b.id);
  const espera = A.bloqueado(id);
  if (espera) return falla(res, 429, `Demasiados intentos. Espera ${espera} s.`);
  const reg = A.leer().usuarios[id];
  const u = (await usuariosAxis(p)).find((x) => x.id === id);
  if (!u || !reg || !A.pinCorrecto(String(b.pin || ""), reg)) {
    A.falloPin(id);
    await pausa(400);
    return falla(res, 401, "PIN incorrecto.");
  }
  A.pinBien(id);
  const rol = A.rolDe(u.id, u.nivel);
  const token = A.abrirSesion({ id: u.id, nombre: u.nombre, rol });
  responder(res, 200, { token, usuario: perfil({ id: u.id, nombre: u.nombre, rol }) });
}

async function miPin(req, res, s) {
  const b = await leerJson(req);
  const reg = A.leer().usuarios[s.id];
  if (!A.pinCorrecto(String(b.actual || ""), reg)) {
    await pausa(400);
    return falla(res, 401, "El PIN actual no es correcto.");
  }
  if (!pinValido(b.nuevo)) return falla(res, 400, "El PIN nuevo debe tener de 4 a 8 números.");
  A.leer().usuarios[s.id] = { ...reg, ...A.hashPin(String(b.nuevo)) };
  A.guardar();
  responder(res, 200, { ok: true });
}

// ---------- Ajustes (solo administrador) ----------
async function verAjustes(res, p) {
  const cfg = A.leer();
  const lista = await usuariosAxis(p, true);
  const db = cfg.db;
  responder(res, 200, {
    db: { host: db.host, puerto: db.puerto, base: db.base, usuario: db.usuario, permisos: await Q.comprobarPermisos(p) },
    ajustes: cfg.ajustes,
    usuarios: lista.map((u) => ({ id: u.id, nombre: u.nombre, grupo: u.grupo, nivel: u.nivel, rolDefecto: A.rolPorNivel(u.nivel), rol: A.rolDe(u.id, u.nivel), tienePin: !!cfg.usuarios[u.id]?.hash })),
  });
}

async function ajustesPost(req, res, ruta, s, p) {
  const b = await leerJson(req);
  const cfg = A.leer();
  const lista = await usuariosAxis(p, true);
  const u = lista.find((x) => x.id === Number(b.id));
  if (ruta === "/api/ajustes/pin") {
    if (!u) return falla(res, 400, "Usuario no encontrado.");
    if (!pinValido(b.pin)) return falla(res, 400, "El PIN debe tener de 4 a 8 números.");
    cfg.usuarios[u.id] = { ...(cfg.usuarios[u.id] || {}), ...A.hashPin(String(b.pin)) };
    A.cerrarSesionesDe(u.id);
  } else if (ruta === "/api/ajustes/quitar-pin") {
    if (!u) return falla(res, 400, "Usuario no encontrado.");
    const antes = cfg.usuarios[u.id];
    if (antes?.hash && A.rolDe(u.id, u.nivel) === "admin" && adminsConPin(lista).length <= 1) return falla(res, 400, "Debe quedar al menos un administrador con PIN.");
    if (antes) delete antes.hash, delete antes.salt;
    A.cerrarSesionesDe(u.id);
  } else if (ruta === "/api/ajustes/rol") {
    if (!u || !["admin", "gerente", "cajero"].includes(b.rol)) return falla(res, 400, "Datos no válidos.");
    const era = A.rolDe(u.id, u.nivel);
    if (era === "admin" && b.rol !== "admin" && cfg.usuarios[u.id]?.hash && adminsConPin(lista).length <= 1) return falla(res, 400, "Debe quedar al menos un administrador con PIN.");
    cfg.usuarios[u.id] = { ...(cfg.usuarios[u.id] || {}), rol: b.rol };
    A.cerrarSesionesDe(u.id);
  } else if (ruta === "/api/ajustes/params") {
    const lim = { tasa: [1, 100000], plazoRepos: [0, 120], seguridad: [0, 60], cobertura: [1, 365], ventanaVentas: [7, 365], umbralCancel: [1, 1e9], descMax: [1, 100], tolCierre: [0, 1e7], costoEstimadoPct: [0, 90] };
    for (const [k, [mn, mx]] of Object.entries(lim)) {
      if (b[k] === undefined) continue;
      const v = Number(b[k]);
      if (!Number.isFinite(v) || v < mn || v > mx) return falla(res, 400, `Valor no válido en «${k}».`);
      cfg.ajustes[k] = v;
    }
  } else return falla(res, 404, "No encontrado");
  A.guardar();
  responder(res, 200, { ok: true });
}

// ---------- Consultas con permiso ----------
const MODULO = {
  resumen: "resumen", ventas: "ventas", ticket: "ventas", "ventas-dia": "ventas",
  productos: "productos", top: "productos", "prod-tx": "productos", "cambios-precio": "productos", margen: "productos", "efecto-precios": "productos",
  existencias: "existencias", caja: "caja", equipo: "equipo", productividad: "equipo", "duracion-turnos": "equipo", ranking: "equipo", "turnos-horario": "equipo",
  alertas: "inventario", abc: "inventario", compras: "inventario", ipv: "inventario", traspasos: "inventario",
  antiguedad: "inventario", "traspasos-hechos": "inventario", fisico: "inventario", "lista-arqueo": "inventario",
  anomalias: "perdidas", eventos: "perdidas", mermas: "perdidas", auditoria: "perdidas",
  devoluciones: "perdidas", "patrones-anulacion": "perdidas",
  "alertas-inicio": "resumen", panel: "resumen", comparar: "resumen", buscar: "resumen",
};

async function consulta(res, nombre, s, p, q) {
  if (!A.PERMISOS[s.rol].includes(MODULO[nombre] || "conteos") && nombre !== "conteos") return falla(res, 403, "Tu rol no tiene acceso a esta sección.");
  const aj = A.leer().ajustes;
  const r = await Q.resolverRango(p, q.periodo, q);
  const ctx = { r, uid: s.rol === "cajero" ? s.id : null, rol: s.rol, aj, rolDe: A.rolDe };
  let datos;
  switch (nombre) {
    case "resumen": datos = { ...(await Q.resumen(p, ctx)), tasa: aj.tasa }; break;
    case "ventas": datos = await Q.ventas(p, ctx, q); break;
    case "ventas-dia": datos = await Q.ventasPorDia(p, ctx); break;
    case "ticket": datos = await Q.ticket(p, ctx, parseInt(String(q.acct || "").replace(/\D/g, ""), 10)); if (!datos) return falla(res, 404, "Ticket no encontrado."); break;
    case "productos": datos = await Q.productos(p, ctx, q); break;
    case "top": datos = await Q.topProductos(p, ctx, q); break;
    case "prod-tx": datos = await Q.transaccionesProducto(p, ctx, q); break;
    case "cambios-precio": datos = await Q.cambiosPrecio(p, ctx, q); break;
    case "existencias": datos = await Q.existencias(p, ctx, q); break;
    case "caja": datos = await Q.caja(p, ctx, q); break;
    case "equipo": datos = await Q.equipoCompleto(p, ctx); break;
    case "alertas": datos = await Q.alertasStock(p, ctx); break;
    case "abc": datos = await Q.analisisABC(p, ctx, q); break;
    case "compras": datos = await Q.sugerenciasCompra(p, ctx); break;
    case "ipv": datos = await Q.ipv(p, ctx, q); break;
    case "traspasos": datos = await Q.traspasos(p, ctx, q); break;
    case "anomalias": datos = await Q.anomalias(p, ctx); break;
    case "eventos": datos = await Q.eventos(p, ctx, q); break;
    case "mermas": datos = await Q.mermas(p, ctx); break;
    case "auditoria": datos = await Q.auditoria(p, ctx); break;
    case "devoluciones": datos = await Q.devolucionesDetalle(p, ctx); break;
    case "antiguedad": datos = await Q.antiguedadStock(p, ctx); break;
    case "traspasos-hechos": datos = await Q.traspasosHechos(p, ctx); break;
    case "margen": datos = await Q.margenProductos(p, ctx); break;
    case "efecto-precios": datos = await Q.efectoPrecios(p, ctx); break;
    case "productividad": datos = await Q.productividad(p, ctx); break;
    case "patrones-anulacion": datos = await Q.patronesAnulacion(p, ctx); break;
    case "duracion-turnos": datos = await Q.duracionTurnos(p, ctx); break;
    case "alertas-inicio": datos = await Q.alertasInicio(p, ctx); break;
    case "panel": datos = await Q.panelDueno(p, ctx); break;
    case "comparar": datos = await Q.compararPeriodos(p, ctx, q); break;
    case "buscar": datos = await Q.busquedaGlobal(p, ctx, q); break;
    case "lista-arqueo": datos = await Q.listaArqueo(p, ctx, q); break;
    case "ranking": datos = await Q.rankingEquipo(p, ctx); break;
    case "turnos-horario": datos = await Q.turnosHorario(p, ctx); break;
    case "conteos": {
      datos = {};
      if (A.PERMISOS[s.rol].includes("inventario")) Object.assign(datos, await Q.conteoAlertas(p, ctx));
      if (A.PERMISOS[s.rol].includes("perdidas")) Object.assign(datos, await Q.conteoPerdidas(p, ctx));
      break;
    }
    default: return falla(res, 404, "No encontrado");
  }
  responder(res, 200, datos);
}

// ---------- Archivos de la pantalla ----------
async function estatico(res, ruta) {
  const limpio = normalize(ruta === "/" ? "/index.html" : ruta).replace(/^([/\\])+/, "");
  if (limpio.startsWith("..")) return falla(res, 404, "No encontrado");
  try {
    const datos = await readFile(join(WWW, limpio));
    res.writeHead(200, { "Content-Type": TIPOS[extname(limpio)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(datos);
  } catch {
    falla(res, 404, "No encontrado");
  }
}

async function manejar(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, "http://x");
  const ruta = url.pathname;
  try {
    if (!ruta.startsWith("/api/")) return await estatico(res, ruta);
    const q = Object.fromEntries(url.searchParams);
    if (ruta === "/api/estado") return await estado(req, res);
    if (ruta === "/api/licencia") {
      return responder(res, 200, Lic.estadoLicencia());
    }
    if (ruta === "/api/licencia/activar" && req.method === "POST") {
      const b = await leerJson(req);
      const token = String(b.token || b.licencia || "").trim();
      if (!token) return falla(res, 400, "Pega la licencia.");
      const v = Lic.verificarToken(token);
      if (!v.ok) return falla(res, 400, v.error || "Licencia no válida");
      Lic.guardarLicencia(token);
      try { Lic.invalidarCacheLicencia(); } catch {}
      return responder(res, 200, { ok: true, cliente: v.cliente, expira: v.expira });
    }
    // Bloqueo por licencia: solo estado/activar/diagnóstico sin licencia
    const licGate = Lic.licenciaPermiteUso();
    const rutaLibreLic =
      ruta === "/api/licencia" ||
      ruta === "/api/licencia/activar" ||
      ruta === "/api/estado" ||
      ruta === "/api/diagnostico" ||
      ruta === "/api/ping";
    if (!licGate.ok && !rutaLibreLic) {
      return falla(res, 402, licGate.error || "Licencia requerida o vencida", {
        licencia: { mc: Lic.codigoFormateado(), requiere: true },
      });
    }
    if (ruta === "/api/login" && req.method === "POST") return await login(req, res);
    if (ruta === "/api/pin/inicial" && req.method === "POST") return await pinInicial(req, res);
    if (ruta === "/api/pin/reiniciar" && req.method === "POST") return await reiniciarPins(req, res);
    // Stock en vivo para Arqueo Stock (sin PIN; solo lectura de existencias en la red local)
    if (ruta === "/api/almacen/stockvivo" || ruta === "/api/stockvivo" || ruta === "/api/catalogo" || ruta === "/api/almacen/ping" || ruta === "/api/ping") {
      const pStock = obtenerPool();
      if (!pStock) return falla(res, 503, "Falta configurar MariaDB en Admin POS.");
      if (ruta.endsWith("ping")) return responder(res, 200, { ok: true, catalogo: { cargado: true } });
      const data = await Q.stockVivo(pStock);
      return responder(res, 200, data);
    }
    // Diagnóstico de red (sin PIN) para el móvil al conectar
    if (ruta === "/api/diagnostico") {
      const pDiag = obtenerPool();
      if (!pDiag) return responder(res, 200, { ok: false, error: "MariaDB no configurada en la PC" });
      const t0 = Date.now();
      const d = await Q.diagnostico(pDiag);
      d.latenciaClienteMs = Date.now() - t0;
      return responder(res, 200, d);
    }
    const s = A.sesionDe(req);
    if (ruta === "/api/config/db" && req.method === "POST") return await guardarDb(req, res, s);
    if (ruta === "/api/logout" && req.method === "POST") {
      if (s) A.cerrarSesion(s.token);
      return responder(res, 200, { ok: true });
    }
    if (!s) return falla(res, 401, "Sesión vencida. Entra otra vez con tu PIN.");
    if (ruta === "/api/yo") return responder(res, 200, perfil(s));
    if (ruta === "/api/mi-pin" && req.method === "POST") return await miPin(req, res, s);
    const p = obtenerPool();
    if (!p) return falla(res, 503, "Falta configurar la conexión a MariaDB.");
    if (ruta === "/api/ajustes" || ruta.startsWith("/api/ajustes/")) {
      if (s.rol !== "admin") return falla(res, 403, "Solo el administrador puede entrar en Ajustes.");
      return ruta === "/api/ajustes" ? await verAjustes(res, p) : await ajustesPost(req, res, ruta, s, p);
    }
    // Importar conteo físico (JSON exportado desde Arqueo Stock)
    if (ruta === "/api/fisico" && req.method === "POST") {
      if (!A.PERMISOS[s.rol].includes("inventario")) return falla(res, 403, "Sin permiso de inventario.");
      const body = await leerJson(req);
      const aj = A.leer().ajustes;
      const r = await Q.resolverRango(p, "30", {});
      const ctx = { r, uid: null, rol: s.rol, aj, rolDe: A.rolDe };
      const modo = (url.searchParams.get("modo") || "") === "ajustes";
      const datos = modo ? await Q.ajustesSugeridos(p, ctx, body) : await Q.inventarioFisico(p, ctx, body);
      return responder(res, 200, datos);
    }
    const m = /^\/api\/([\w-]+)$/.exec(ruta);
    if (m) return await consulta(res, m[1], s, p, q);
    falla(res, 404, "No encontrado");
  } catch (e) {
    console.error(e);
    falla(res, 500, mensajeDb(e, A.leer().db || {}));
  }
}

export function iniciar(puerto = 3000, opciones = {}) {
  // Opciones: { dir, cifrar, descifrar } para cifrado DPAPI en Windows
  if (opciones && (opciones.dir || opciones.cifrar || opciones.descifrar)) {
    A.configurarAlmacen(opciones);
  }
  Lic.configurarLicencia({
    dir: opciones?.dir,
    empaquetado: opciones?.empaquetado,
    estricto: opciones?.estricto,
    pubRaw: opciones?.pubRaw,
  });
  return new Promise((ok, mal) => {
    const srv = http.createServer(manejar);
    srv.once("error", mal);
    srv.listen(puerto, "0.0.0.0", () => ok(srv.address().port));
  });
}
