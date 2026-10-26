// Guarda en la PC: conexión a MariaDB (usuario de solo lectura), PIN de cada usuario y ajustes.
// La contraseña de MariaDB se cifra con Windows DPAPI (safeStorage de Electron) cuando está disponible.
// El archivo queda en la carpeta de datos del programa con permisos solo para el dueño.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

let DIR = process.env.AX_DATA_DIR || join(process.cwd(), "datos");
let ARCHIVO = join(DIR, "config.json");
let cifrarFn = null;
let descifrarFn = null;

export function configurarAlmacen({ dir, cifrar, descifrar } = {}) {
  if (dir) {
    DIR = dir;
    ARCHIVO = join(DIR, "config.json");
  }
  cifrarFn = typeof cifrar === "function" ? cifrar : null;
  descifrarFn = typeof descifrar === "function" ? descifrar : null;
  cache = null; // forzar relectura
}

export const AJUSTES_BASE = {
  tasa: 740, // CUP por USD (solo para mostrar el equivalente)
  plazoRepos: 7, // días que tarda en llegar un pedido
  seguridad: 3, // días extra de seguridad
  cobertura: 30, // días de venta que se quieren tener en almacén al comprar
  ventanaVentas: 30, // días de historial para calcular la venta diaria
  umbralCancel: 100000, // una cancelación de este monto o más se marca
  descMax: 20, // % de descuento manual a partir del cual se marca
  tolCierre: 500, // diferencia de caja tolerada (CUP)
};

let cache = null;

function sellar(txt) {
  if (cifrarFn) {
    try {
      return "enc:" + cifrarFn(String(txt || ""));
    } catch {}
  }
  // Fallback: base64 (el archivo tiene permisos 0600)
  return "b64:" + Buffer.from(String(txt || ""), "utf8").toString("base64");
}

function abrir(txt) {
  if (typeof txt !== "string") return null;
  try {
    if (txt.startsWith("enc:")) {
      if (!descifrarFn) return null;
      return descifrarFn(txt.slice(4));
    }
    if (txt.startsWith("b64:")) {
      return Buffer.from(txt.slice(4), "base64").toString("utf8");
    }
    // Compatibilidad con versiones anteriores (texto plano)
    return txt;
  } catch {
    return null;
  }
}

export function leer() {
  if (cache) return cache;
  let datos = {};
  try {
    datos = JSON.parse(readFileSync(ARCHIVO, "utf8"));
  } catch {}
  const dbRaw = datos.db || null;
  let db = null;
  if (dbRaw) {
    const clave = abrir(dbRaw.clave);
    if (clave !== null) {
      db = { host: dbRaw.host, puerto: dbRaw.puerto, base: dbRaw.base, usuario: dbRaw.usuario, clave };
    } else {
      // Si no se pudo descifrar, dejamos db=null para forzar reconfiguración
      db = null;
    }
  }
  cache = {
    db,
    usuarios: datos.usuarios || {},
    ajustes: { ...AJUSTES_BASE, ...(datos.ajustes || {}) },
    _dbRaw: dbRaw, // para guardar sin perder el cifrado
  };
  return cache;
}

export function guardar() {
  mkdirSync(DIR, { recursive: true });
  const c = leer();
  // Guardamos la versión cifrada de la clave
  let dbParaGuardar = null;
  if (c.db) {
    dbParaGuardar = {
      host: c.db.host,
      puerto: c.db.puerto,
      base: c.db.base,
      usuario: c.db.usuario,
      clave: sellar(c.db.clave),
    };
  } else if (c._dbRaw) {
    dbParaGuardar = c._dbRaw;
  }
  const aGuardar = {
    db: dbParaGuardar,
    usuarios: c.usuarios,
    ajustes: c.ajustes,
  };
  const tmp = ARCHIVO + ".tmp";
  writeFileSync(tmp, JSON.stringify(aGuardar, null, 2), { mode: 0o600 });
  renameSync(tmp, ARCHIVO);
  cache = null; // invalidar para próxima lectura
}

export function hashPin(pin) {
  const salt = randomBytes(16).toString("hex");
  return { salt, hash: scryptSync(pin, salt, 32).toString("hex") };
}

export function pinCorrecto(pin, reg) {
  if (!reg || !reg.hash) return false;
  const esperado = Buffer.from(reg.hash, "hex");
  const real = scryptSync(String(pin), reg.salt, 32);
  return esperado.length === real.length && timingSafeEqual(esperado, real);
}

export const hayPins = () => Object.values(leer().usuarios).some((u) => u && u.hash);

// Rol por defecto según el nivel que ya tiene el usuario en AxisPOS
export const rolPorNivel = (nivel) => (Number(nivel) >= 3 ? "admin" : Number(nivel) === 2 ? "gerente" : "cajero");

export function rolDe(id, nivel) {
  const r = leer().usuarios[id]?.rol;
  return r === "admin" || r === "gerente" || r === "cajero" ? r : rolPorNivel(nivel);
}

export const PERMISOS = {
  admin: ["resumen", "ventas", "productos", "existencias", "caja", "equipo", "inventario", "perdidas", "ajustes"],
  gerente: ["resumen", "ventas", "productos", "existencias", "caja", "equipo", "inventario", "perdidas"],
  cajero: ["resumen", "ventas", "productos", "existencias", "caja"],
};

// --- Sesiones con PIN (en memoria) ---
const SESION_MS = 12 * 60 * 60 * 1000;
const sesiones = new Map();
const intentos = new Map(); // idUsuario -> { fallos, hasta }

export function abrirSesion(u) {
  const token = randomBytes(24).toString("hex");
  sesiones.set(token, { ...u, expira: Date.now() + SESION_MS });
  return token;
}

export function sesionDe(req) {
  const m = /^Bearer (\w+)$/.exec(req.headers.authorization || "");
  const s = m && sesiones.get(m[1]);
  if (!s) return null;
  if (s.expira < Date.now()) {
    sesiones.delete(m[1]);
    return null;
  }
  s.expira = Date.now() + SESION_MS;
  return { token: m[1], ...s };
}

export const cerrarSesion = (token) => sesiones.delete(token);
export const cerrarTodas = () => sesiones.clear();
export const cerrarSesionesDe = (id) => {
  for (const [t, s] of sesiones) if (s.id === id) sesiones.delete(t);
};

// Bloqueo por PIN equivocado: 5 fallos = 60 s
export function bloqueado(id) {
  const i = intentos.get(id);
  return i && i.hasta > Date.now() ? Math.ceil((i.hasta - Date.now()) / 1000) : 0;
}
export function falloPin(id) {
  const i = intentos.get(id) || { fallos: 0, hasta: 0 };
  i.fallos += 1;
  if (i.fallos >= 5) {
    i.hasta = Date.now() + 60_000;
    i.fallos = 0;
  }
  intentos.set(id, i);
}
export const pinBien = (id) => intentos.delete(id);
