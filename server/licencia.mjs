// Licencias firmadas (ECDSA P-256). Compatible con el generador TT1/TT2.
// Modo estricto: con clave pública o empaquetado Electron, sin licencia válida no hay uso.
import { createHash, createPublicKey, verify } from "node:crypto";
import { hostname, networkInterfaces, platform, arch } from "node:os";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin I,O,0,1
const DIR = dirname(fileURLToPath(import.meta.url));
const PRODUCTO = "ADMINPOS";

/**
 * Clave pública embebida (base64 del export "raw" del generador o SPKI).
 * Cuando la rellenes, el programa EXIGE licencia aunque borren clave_publica.txt.
 * Ejemplo: pega aquí la misma línea que muestra el generador en "Clave pública".
 */
const CLAVE_PUBLICA_EMBEBIDA = "";

let dirDatos = join(DIR, "..", "data");
let pubKey = null;
let modoEstricto = false;
let cacheOk = null; // { hasta, resultado }
let empaquetado = false;

export function configurarLicencia(opciones = {}) {
  if (opciones.dir) dirDatos = opciones.dir;
  empaquetado = !!(opciones.empaquetado || process.env.ADMINPOS_EMPAQUETADO === "1");
  modoEstricto = !!(
    opciones.estricto ||
    empaquetado ||
    process.env.ADMINPOS_LICENCIA_OBLIGATORIA === "1" ||
    CLAVE_PUBLICA_EMBEBIDA
  );
  cargarClavePublica(opciones.pubRaw || null);
}

function asegurarDir() {
  try {
    mkdirSync(dirDatos, { recursive: true });
  } catch {}
}

function rutaLic() {
  return join(dirDatos, "licencia.txt");
}

function rutaMeta() {
  return join(dirDatos, "licencia.meta.json");
}

/** Código de PC estable (16 caracteres). */
export function codigoPC() {
  const nets = networkInterfaces() || {};
  const macs = Object.values(nets)
    .flat()
    .filter((i) => i && !i.internal && i.mac && i.mac !== "00:00:00:00:00:00")
    .map((i) => i.mac)
    .sort();
  const semilla = ["APOS", hostname(), platform(), arch(), macs.join("|") || "nomac"].join("::");
  const hash = createHash("sha256").update(semilla).digest();
  let out = "";
  for (let i = 0; i < 16; i++) out += ALFABETO[hash[i] % ALFABETO.length];
  return out;
}

export function codigoFormateado() {
  const c = codigoPC();
  return c.match(/.{1,4}/g).join("-");
}

function b64ToBuf(raw) {
  const b64 = String(raw).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

function importarPublica(raw) {
  if (!raw) return null;
  const t = String(raw).trim();
  if (!t || t.startsWith("#")) return null;
  // Puede venir con comentarios: tomar primera línea no vacía sin #
  const linea = t.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  if (!linea) return null;

  if (linea.includes("BEGIN PUBLIC KEY")) {
    return createPublicKey(linea.includes("-----") ? t : linea);
  }

  const buf = b64ToBuf(linea);
  // Punto sin comprimir P-256 (WebCrypto export raw): 0x04 || X(32) || Y(32)
  if (buf.length === 65 && buf[0] === 0x04) {
    const x = buf.subarray(1, 33).toString("base64url");
    const y = buf.subarray(33, 65).toString("base64url");
    return createPublicKey({
      key: { kty: "EC", crv: "P-256", x, y },
      format: "jwk",
    });
  }
  // SPKI DER
  try {
    return createPublicKey({ key: buf, format: "der", type: "spki" });
  } catch {
    return null;
  }
}

function cargarClavePublica(rawB64) {
  const candidatos = [];
  if (rawB64) candidatos.push(rawB64);
  if (process.env.ADMINPOS_PUBKEY) candidatos.push(process.env.ADMINPOS_PUBKEY);
  if (CLAVE_PUBLICA_EMBEBIDA) candidatos.push(CLAVE_PUBLICA_EMBEBIDA);

  const archivos = [
    join(DIR, "clave_publica.txt"),
    join(DIR, "..", "clave_publica.txt"),
    join(dirDatos, "clave_publica.txt"),
  ];
  for (const f of archivos) {
    if (existsSync(f)) {
      try {
        candidatos.push(readFileSync(f, "utf8"));
      } catch {}
    }
  }

  pubKey = null;
  for (const c of candidatos) {
    try {
      const k = importarPublica(c);
      if (k) {
        pubKey = k;
        break;
      }
    } catch {}
  }
}

function ub64(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function parsePayload(txt) {
  const p = String(txt || "").split("|");
  if (p[0] === "TT2" && p.length >= 5) {
    return {
      ver: 2,
      producto: (p[1] || "").toUpperCase(),
      mc: (p[2] || "").toUpperCase(),
      ini: p[3],
      exp: p[4],
      cliente: p.slice(5).join("|") || "",
    };
  }
  if (p[0] === "TT1" && p.length >= 4) {
    return {
      ver: 1,
      producto: "ADMINPOS",
      mc: (p[1] || "").toUpperCase(),
      ini: p[2],
      exp: p[3],
      cliente: p.slice(4).join("|") || "",
    };
  }
  return null;
}

function ymdHoy() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function parseYmd(s) {
  const n = parseInt(String(s).replace(/\D/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function leerMeta() {
  try {
    if (!existsSync(rutaMeta())) return {};
    return JSON.parse(readFileSync(rutaMeta(), "utf8"));
  } catch {
    return {};
  }
}

function guardarMeta(m) {
  asegurarDir();
  try {
    writeFileSync(rutaMeta(), JSON.stringify(m, null, 0), "utf8");
  } catch {}
}

/** Detecta reloj atrasado de forma simple (no se puede adelantar el vencimiento borrando meta). */
function antiRollback(expYmd) {
  const meta = leerMeta();
  const hoy = ymdHoy();
  const maxVisto = parseYmd(meta.maxYmd);
  if (maxVisto && hoy + 1 < maxVisto) {
    // Reloj fue hacia atrás más de un día respecto al último uso
    return { ok: false, error: "Fecha del sistema inconsistente. Corrige la hora de la PC." };
  }
  if (!maxVisto || hoy > maxVisto) {
    meta.maxYmd = String(hoy);
    guardarMeta(meta);
  }
  if (expYmd && maxVisto > expYmd && hoy <= expYmd) {
    // Habían visto un día posterior al vencimiento; no permitir "volver"
    return { ok: false, error: "Licencia vencida (protección de fecha)." };
  }
  return { ok: true };
}

/** Verifica token. Devuelve { ok, ... } */
export function verificarToken(token, mcEsperado = codigoPC()) {
  if (!token || typeof token !== "string") return { ok: false, error: "Sin licencia" };
  if (!pubKey) {
    return {
      ok: false,
      error: modoEstricto
        ? "Falta la clave pública de licencias en esta instalación"
        : "Falta clave pública (clave_publica.txt)",
    };
  }

  const partes = token.trim().split(".");
  if (partes.length !== 2) return { ok: false, error: "Formato de licencia inválido" };

  let payloadBuf, sigBuf;
  try {
    payloadBuf = ub64(partes[0]);
    sigBuf = ub64(partes[1]);
  } catch {
    return { ok: false, error: "Licencia corrupta" };
  }

  // WebCrypto firma en formato IEEE P1363 (r||s); Node debe usar dsaEncoding
  let okSig = false;
  try {
    okSig = verify(
      "SHA-256",
      payloadBuf,
      { key: pubKey, dsaEncoding: "ieee-p1363" },
      sigBuf
    );
  } catch {
    okSig = false;
  }
  if (!okSig) {
    // Reintento por si alguien firmó en DER
    try {
      okSig = verify("SHA-256", payloadBuf, { key: pubKey, dsaEncoding: "der" }, sigBuf);
    } catch {
      okSig = false;
    }
  }
  if (!okSig) return { ok: false, error: "Firma no válida" };

  const txt = payloadBuf.toString("utf8");
  const datos = parsePayload(txt);
  if (!datos) return { ok: false, error: "Payload no reconocido" };

  const mc = String(mcEsperado || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (datos.mc !== mc) return { ok: false, error: "Esta licencia es para otra PC", mc: datos.mc };

  if (datos.ver === 2 && datos.producto && datos.producto !== PRODUCTO && datos.producto !== "AMBOS") {
    return { ok: false, error: `Licencia para ${datos.producto}, este programa es ${PRODUCTO}` };
  }

  const hoy = ymdHoy();
  const exp = parseYmd(datos.exp);
  const ini = parseYmd(datos.ini);
  if (ini && hoy < ini) return { ok: false, error: "Licencia aún no inicia", ...datos, expira: datos.exp };
  if (exp && hoy > exp) return { ok: false, error: "Licencia vencida", ...datos, expira: datos.exp, vencida: true };

  const rb = antiRollback(exp);
  if (!rb.ok) return { ok: false, error: rb.error, ...datos, expira: datos.exp };

  return {
    ok: true,
    producto: datos.producto || PRODUCTO,
    cliente: datos.cliente,
    ini: datos.ini,
    expira: datos.exp,
    mc: datos.mc,
  };
}

export function leerLicenciaGuardada() {
  asegurarDir();
  const f = rutaLic();
  if (!existsSync(f)) return null;
  try {
    return readFileSync(f, "utf8").trim();
  } catch {
    return null;
  }
}

export function guardarLicencia(token) {
  asegurarDir();
  const t = String(token || "").trim();
  writeFileSync(rutaLic(), t, "utf8");
  // Huella para detectar manipulación burda del archivo
  const meta = leerMeta();
  meta.huella = createHash("sha256").update(t).digest("hex").slice(0, 32);
  meta.guardada = new Date().toISOString();
  guardarMeta(meta);
  cacheOk = null;
}

export function estadoLicencia() {
  const mc = codigoPC();
  const tieneClave = !!pubKey;
  const token = leerLicenciaGuardada();

  if (!tieneClave && !modoEstricto) {
    return {
      ok: true,
      requiere: false,
      mc,
      mcFmt: codigoFormateado(),
      error: null,
      tieneClavePublica: false,
      modo: "desarrollo",
    };
  }

  if (!tieneClave && modoEstricto) {
    return {
      ok: false,
      requiere: true,
      mc,
      mcFmt: codigoFormateado(),
      error: "Instalación incompleta: falta clave pública de licencias",
      tieneClavePublica: false,
    };
  }

  if (!token) {
    return {
      ok: false,
      requiere: true,
      mc,
      mcFmt: codigoFormateado(),
      error: "No hay licencia activada",
      tieneClavePublica: true,
    };
  }

  // Comprobar huella
  const meta = leerMeta();
  if (meta.huella) {
    const h = createHash("sha256").update(token).digest("hex").slice(0, 32);
    if (h !== meta.huella) {
      return {
        ok: false,
        requiere: true,
        mc,
        mcFmt: codigoFormateado(),
        error: "Archivo de licencia alterado",
        tieneClavePublica: true,
      };
    }
  }

  const v = verificarToken(token, mc);
  return {
    ...v,
    requiere: !v.ok,
    mc,
    mcFmt: codigoFormateado(),
    tieneClavePublica: true,
  };
}

/** Cache corto para no verificar firma en cada request, pero revalidar a menudo. */
export function licenciaPermiteUso() {
  const ahora = Date.now();
  if (cacheOk && cacheOk.hasta > ahora) return cacheOk.resultado;

  if (!pubKey && !modoEstricto) {
    const r = { ok: true, modo: "sin_clave_publica" };
    cacheOk = { hasta: ahora + 30_000, resultado: r };
    return r;
  }

  const e = estadoLicencia();
  const r = e.ok ? { ok: true, ...e } : { ok: false, ...e };
  cacheOk = { hasta: ahora + 15_000, resultado: r };
  return r;
}

export function invalidarCacheLicencia() {
  cacheOk = null;
}
