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
const CLAVE_PUBLICA_EMBEBIDA =
  "BCXbleMq3+rvSGa5SxMU/rvv6fe9PrJe8uIxUoMoZrSRY/1KszcWqM63VlI/V8mfxDwt45VPWZFu1BWM2aS+h0s=";

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

  // JWK completo pegado (a veces exportan JSON)
  if (t.startsWith("{") && t.includes("kty")) {
    try {
      const j = JSON.parse(t);
      if (j.kty === "EC" && j.x && j.y) {
        return createPublicKey({
          key: { kty: "EC", crv: j.crv || "P-256", x: j.x, y: j.y },
          format: "jwk",
        });
      }
    } catch {}
  }

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
  // Algunos generadores guardan solo X||Y (64 bytes)
  if (buf.length === 64) {
    const x = buf.subarray(0, 32).toString("base64url");
    const y = buf.subarray(32, 64).toString("base64url");
    return createPublicKey({
      key: { kty: "EC", crv: "P-256", x, y },
      format: "jwk",
    });
  }
  try {
    return createPublicKey({ key: buf, format: "der", type: "spki" });
  } catch {
    return null;
  }
}

/** Quita saltos de línea/espacios que mete WhatsApp o el móvil al pegar. */
export function normalizarToken(token) {
  return String(token || "").replace(/\s+/g, "").trim();
}

function cargarClavePublica(rawB64) {
  const candidatos = [];
  // Embebida primero: garantiza la misma llave en .exe instalado
  if (CLAVE_PUBLICA_EMBEBIDA) candidatos.push(CLAVE_PUBLICA_EMBEBIDA);
  if (rawB64) candidatos.push(rawB64);
  if (process.env.ADMINPOS_PUBKEY) candidatos.push(process.env.ADMINPOS_PUBKEY);

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

function derInt(b) {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  b = b.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return Buffer.concat([Buffer.from([0x02, b.length]), b]);
}

function p1363aDer(sig) {
  const r = derInt(sig.subarray(0, 32));
  const sv = derInt(sig.subarray(32, 64));
  const cuerpo = Buffer.concat([r, sv]);
  return Buffer.concat([Buffer.from([0x30, cuerpo.length]), cuerpo]);
}

/** Huella corta de la clave pública cargada (para comparar con el generador). */
export function huellaClave() {
  try {
    if (!pubKey) return null;
    const der = pubKey.export({ type: "spki", format: "der" });
    return createHash("sha256").update(der).digest("hex").slice(0, 12).toUpperCase();
  } catch {
    return null;
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
  token = normalizarToken(token);
  if (!token) return { ok: false, error: "Sin licencia" };
  if (!pubKey) {
    return {
      ok: false,
      error: modoEstricto
        ? "Falta la clave pública de licencias en esta instalación"
        : "Falta clave pública (clave_publica.txt)",
    };
  }

  const partes = token.split(".");
  if (partes.length !== 2) {
    return {
      ok: false,
      error: partes.length < 2
        ? "Licencia incompleta (debe tener dos partes separadas por un punto)"
        : "Formato de licencia inválido",
    };
  }

  let payloadBuf, sigBuf;
  try {
    payloadBuf = ub64(partes[0]);
    sigBuf = ub64(partes[1]);
  } catch {
    return { ok: false, error: "Licencia corrupta o mal copiada" };
  }

  // WebCrypto firma en IEEE P1363 (r||s); también probamos DER
  let okSig = false;
  for (const enc of ["ieee-p1363", "der"]) {
    try {
      if (verify("SHA-256", payloadBuf, { key: pubKey, dsaEncoding: enc }, sigBuf)) {
        okSig = true;
        break;
      }
    } catch {}
  }
  // Respaldo: convierte r||s a DER a mano (Node viejo que ignora dsaEncoding)
  if (!okSig && sigBuf.length === 64) {
    try {
      okSig = verify("SHA-256", payloadBuf, pubKey, p1363aDer(sigBuf));
    } catch {}
  }
  if (!okSig) {
    return {
      ok: false,
      error:
        `Firma no válida. Huella de la clave de esta app: ${huellaClave()} · Node ${process.versions.node}. Casi siempre: (1) la clave pública de esta app no es la del generador que firmó, o (2) la licencia se pegó cortada.`,
    };
  }

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
      huella: huellaClave(),
      node: process.versions.node,
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
    huella: huellaClave(),
    node: process.versions.node,
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
