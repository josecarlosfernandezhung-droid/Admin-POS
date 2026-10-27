"use strict";
/* Admin POS — pantalla única para Windows (PC) y Android (APK). Sin librerías externas. */
const $ = (s, r = document) => r.querySelector(s);
const esApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const LS = {
  get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const SS = {
  get: (k) => { try { return sessionStorage.getItem(k) || ""; } catch { return ""; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
  del: (k) => { try { sessionStorage.removeItem(k); } catch {} },
};
const S = { base: "", token: "", yo: null, periodo: LS.get("periodoPref") || "hoy", desde: "", hasta: "", vista: "resumen", estado: null, conteos: {}, tk: 0,
  ventas: { q: "", pagina: 1, sub: "tickets" }, prod: { q: "", familia: "", orden: "vendidos", activos: true, pagina: 1, sub: "lista" }, exis: { q: "", local: "", pagina: 1 },
  cajaPag: 1, invSub: "alertas", abcClase: "A", perSub: "auditoria", ev: { tipo: "cancel", usuario: "", nombre: "", pagina: 1 }, pagCb: null,
  favs: (() => { try { return JSON.parse(LS.get("favs") || "[]"); } catch { return []; } })(),
};
function aplicarPrefs() {
  document.documentElement.classList.toggle("oscuro", LS.get("tema") === "oscuro");
  document.documentElement.classList.toggle("grande", LS.get("fuente") === "grande");
}
aplicarPrefs();
function toggleFav(v) {
  const i = S.favs.indexOf(v);
  if (i >= 0) S.favs.splice(i, 1); else if (S.favs.length < 6) S.favs.push(v);
  LS.set("favs", JSON.stringify(S.favs));
}

// Parámetros de periodo para las APIs (incluye rango personalizado)
function paramsPeriodo(extra = {}) {
  const p = { periodo: S.periodo, ...extra };
  if (S.periodo === "custom" && S.desde && S.hasta) {
    p.desde = S.desde;
    p.hasta = S.hasta;
  }
  return p;
}

// ---------- Formato ----------
const e = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n, d = 2) => Number(n || 0).toLocaleString("es-ES", { maximumFractionDigits: d });
const cup = (n) => fmt(n) + " CUP";
const compacto = (n) => { const a = Math.abs(n || 0); return a >= 1e6 ? fmt(n / 1e6, 1) + " M" : a >= 1e3 ? fmt(Math.round(n / 1e3), 0) + " mil" : fmt(n, 0); };
const MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const diaLargo = (s) => (s ? `${+s.slice(8, 10)} ${MES[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}` : "");
const diaCorto = (s) => `${+s.slice(8, 10)} ${MES[+s.slice(5, 7) - 1]}`;
const fechaHora = (s) => (s ? `${+s.slice(8, 10)} ${MES[+s.slice(5, 7) - 1]} ${s.slice(11, 16)}` : "—");
const signo = (v) => (v == null ? "" : (v > 0 ? "+" : "") + fmt(v, 1) + " %");
const claseVar = (v) => (v == null ? "" : v >= 0 ? "sube" : "baja");
const ROL = { admin: "Administrador", gerente: "Gerente", cajero: "Cajero" };
const etRol = (r) => `<span class="etiqueta et-${r}">${ROL[r] || r}</span>`;

// ---------- Comunicación con el servidor ----------
async function api(ruta, op = {}) {
  const cab = { "Content-Type": "application/json" };
  if (S.token) cab.Authorization = "Bearer " + S.token;
  let r;
  try { r = await fetch(S.base + ruta, { ...op, headers: cab }); }
  catch { throw new Error("No se pudo conectar con la PC. Revisa que esté encendida y en la misma red WiFi."); }
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && S.token) { sesionVencida(); throw new Error(d.error || "Sesión vencida"); }
  if (!r.ok) throw Object.assign(new Error(d.error || "Error " + r.status), { status: r.status });
  return d;
}
const get = (ruta, p) => api(ruta + (p ? "?" + new URLSearchParams(p) : ""));
const post = (ruta, c) => api(ruta, { method: "POST", body: JSON.stringify(c || {}) });

let venciendo = false;
function sesionVencida() {
  if (venciendo) return;
  venciendo = true;
  S.token = ""; S.yo = null; SS.del("token");
  setTimeout(() => { venciendo = false; iniciar("Tu sesión terminó. Entra otra vez con tu PIN."); }, 0);
}

// ---------- Avisos y cuadros ----------
let tAviso;
function aviso(txt) {
  const a = $("#aviso"); a.textContent = txt; a.hidden = false;
  clearTimeout(tAviso); tAviso = setTimeout(() => (a.hidden = true), 3200);
}
function abrirModal(html, clase = "centrada") {
  const m = $("#modal"); m.innerHTML = `<div class="cortina ${clase}" data-act="cortina">${html}</div>`; m.hidden = false;
}
function cerrarModal() { const m = $("#modal"); m.hidden = true; m.innerHTML = ""; }
function pedir({ titulo, texto = "", campos, ok = "Guardar" }) {
  return new Promise((res) => {
    abrirModal(`<form class="dialogo" id="form-pedir"><h3>${e(titulo)}</h3>${texto ? `<p class="muted" style="margin:0">${texto}</p>` : ""}
      ${campos.map((c) => `<label class="campo">${e(c.etiqueta)}<input name="${c.id}" type="${c.tipo || "text"}" ${c.pin ? 'inputmode="numeric" maxlength="8" pattern="[0-9]*"' : ""} autocomplete="off" ${c.val ? `value="${e(c.val)}"` : ""}></label>`).join("")}
      <p class="error" id="err-pedir" hidden></p>
      <div class="acciones"><button type="button" class="btn sec" id="no-pedir">Cancelar</button><button class="btn">${e(ok)}</button></div></form>`);
    const f = $("#form-pedir"); f.querySelector("input")?.focus();
    $("#no-pedir").onclick = () => { cerrarModal(); res(null); };
    f.onsubmit = (ev) => { ev.preventDefault(); const v = Object.fromEntries(new FormData(f)); res({ v, error: (m) => { const x = $("#err-pedir"); x.textContent = m; x.hidden = false; }, cerrar: cerrarModal }); };
  });
}
async function descargarCSV(nombre, filas) {
  const txt = "\ufeff" + filas.map((r) => r.map((c) => { c = String(c ?? ""); return /[";\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(";")).join("\r\n");
  const file = new File([txt], nombre, { type: "text/csv" });
  if (esApp) {
    try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: nombre }); return; } } catch {}
    abrirModal(`<div class="dialogo"><h3>${e(nombre)}</h3><p class="muted" style="margin:0">Copia este texto y pégalo en una hoja de cálculo.</p><textarea class="entrada" rows="10" readonly>${e(txt)}</textarea><div class="acciones"><button class="btn" data-act="cerrarModal">Cerrar</button></div></div>`);
    return;
  }
  const url = URL.createObjectURL(file); const a = document.createElement("a");
  a.href = url; a.download = nombre; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------- Pantallas de entrada ----------
const centro = (html) => { $("#raiz").innerHTML = `<div class="centro"><div class="caja">${html}</div></div>`; };
const logoCaja = `<img class="logo" src="logo.png" alt="">`;

function pantallaServidor(msg) {
  // (diagnóstico de red disponible tras conectar)
  centro(`${logoCaja}<h1>Admin POS</h1><p class="sub">Escribe la dirección de la PC de la tienda</p>
    <label class="campo">Dirección de la PC<input id="servidor" inputmode="url" placeholder="http://192.168.1.10:3000" value="${e(LS.get("servidor"))}"></label>
    <p class="error" id="err" ${msg ? "" : "hidden"}>${e(msg || "")}</p>
    <button class="btn" data-act="conectar">Conectar</button>
    <button class="btn sec" data-act="probarDiag">Probar conexión</button>
    <p id="diagRes" class="muted" style="text-align:center;font-size:.84rem;margin:0"></p>
    <p class="muted" style="text-align:center;font-size:.84rem;margin:0">La PC debe tener Admin POS en bandeja (servidor activo). Mismo WiFi.</p>`);
}
async function conectarServidor() {
  let s = $("#servidor").value.trim().replace(/\/+$/, "");
  if (!s) return;
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  if (!/:\d+$/.test(s)) s += ":3000";
  S.base = s;
  try { await get("/api/estado"); LS.set("servidor", s); iniciar(); }
  catch (err) { pantallaServidor(err.message); }
}
// Probar sin entrar (diagnóstico de red)
window.__probarDiag = async function () {
  let s = $("#servidor")?.value.trim().replace(/\/+$/, "") || LS.get("servidor");
  if (!s) { $("#diagRes").textContent = "Escribe la dirección primero"; return; }
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  if (!/:\d+$/.test(s)) s += ":3000";
  const prev = S.base; S.base = s;
  try {
    const t0 = Date.now();
    const d = await get("/api/diagnostico");
    const ms = Date.now() - t0;
    $("#diagRes").textContent = d.ok
      ? `✅ OK · ${ms} ms · BD ${d.dbMs} ms · ${fmt(d.productos,0)} productos`
      : `❌ Servidor responde pero BD falla: ${d.error || ""}`;
  } catch (err) {
    $("#diagRes").textContent = "❌ No se pudo conectar: " + err.message;
  } finally { S.base = prev; }
};

function pantallaDb(msg, previo = {}) {
  const est = S.estado;
  if (!est.local) {
    centro(`${logoCaja}<h1>Falta configurar la PC</h1><p class="sub">La primera configuración se hace en la PC de la tienda: abre Admin POS allí y escribe el usuario de MariaDB.</p>
      <button class="btn" data-act="reintentar">Ya está, reintentar</button>${esApp ? '<button class="enlace" data-act="cambiarServidor">Cambiar dirección de la PC</button>' : ""}`);
    return;
  }
  centro(`${logoCaja}<h1>Conectar con AxisPOS</h1><p class="sub">Escribe una sola vez el usuario de MariaDB. Se guarda en esta PC y no se vuelve a pedir.</p>
    <form id="form-db" style="display:contents">
    <label class="campo">Usuario de MariaDB (solo lectura)<input name="usuario" autocomplete="off" autocapitalize="none" required value="${e(previo.usuario || "")}"></label>
    <label class="campo">Contraseña<input name="clave" type="password" autocomplete="off"></label>
    <details class="avanzado" ${previo.base ? "open" : ""}><summary>Opciones de conexión</summary>
      <label class="campo">Servidor<input name="host" value="${e(previo.host || "127.0.0.1")}"></label>
      <label class="campo">Puerto<input name="puerto" inputmode="numeric" value="${e(previo.puerto || 3306)}"></label>
      <label class="campo">Base de datos<input name="base" value="${e(previo.base || "axispos")}" required></label></details>
    <p class="error" id="err" ${msg ? "" : "hidden"}>${e(msg || "")}</p>
    <button class="btn" id="b-db">Conectar</button></form>`);
  $("#form-db").onsubmit = async (ev) => {
    ev.preventDefault();
    const b = $("#b-db"); b.disabled = true; b.textContent = "Conectando…";
    const v = Object.fromEntries(new FormData(ev.target));
    try {
      const r = await post("/api/config/db", v);
      if (r.permisos === "escritura") {
        abrirModal(`<div class="dialogo"><h3>Ojo con los permisos</h3><p class="muted" style="margin:0">Este usuario de MariaDB puede modificar datos. Admin POS solo lee, pero lo más seguro es crear un usuario que solo tenga permiso de lectura (SELECT).</p><div class="acciones"><button class="btn" data-act="seguirDb">Entendido, continuar</button></div></div>`);
      } else iniciar();
    } catch (err) { pantallaDb(err.message, v); }
  };
}

function pantallaDbError() {
  const est = S.estado;
  centro(`${logoCaja}<h1>Sin conexión a MariaDB</h1><p class="error" style="text-align:center">${e(est.dbError)}</p>
    <button class="btn" data-act="reintentar">Reintentar</button>
    ${est.local ? '<button class="btn sec" data-act="cambiarDb">Cambiar la conexión</button><button class="enlace" data-act="olvidePin">Restablecer PIN del administrador</button>' : ""}
    ${esApp ? '<button class="enlace" data-act="cambiarServidor">Cambiar dirección de la PC</button>' : ""}`);
}

function pantallaPinInicial(msg) {
  const est = S.estado;
  if (!est.local) {
    centro(`${logoCaja}<h1>Falta crear el PIN</h1><p class="sub">Abre Admin POS en la PC de la tienda y crea el PIN del administrador.</p><button class="btn" data-act="reintentar">Reintentar</button>`);
    return;
  }
  const c = est.candidatosAdmin || [];
  centro(`${logoCaja}<h1>PIN del administrador</h1><p class="sub">Elige quién administra el panel y crea su PIN (4 a 8 números). Después podrás poner el PIN de cada usuario en Ajustes.</p>
    <form id="form-pin0" style="display:contents">
    <label class="campo">Administrador<select name="id" class="entrada">${c.map((u) => `<option value="${u.id}">${e(u.nombre)}</option>`).join("")}</select></label>
    <label class="campo">PIN<input name="pin" type="password" inputmode="numeric" maxlength="8" pattern="[0-9]*" required autocomplete="off"></label>
    <label class="campo">Repite el PIN<input name="pin2" type="password" inputmode="numeric" maxlength="8" pattern="[0-9]*" required autocomplete="off"></label>
    <p class="error" id="err" ${msg ? "" : "hidden"}>${e(msg || "")}</p>
    <button class="btn">Crear PIN y entrar</button></form>`);
  $("#form-pin0").onsubmit = async (ev) => {
    ev.preventDefault();
    const v = Object.fromEntries(new FormData(ev.target));
    if (v.pin !== v.pin2) return pantallaPinInicial("Los dos PIN no son iguales.");
    try { const r = await post("/api/pin/inicial", { id: v.id, pin: v.pin }); S.token = r.token; S.yo = r.usuario; entrarApp(); }
    catch (err) { pantallaPinInicial(err.message); }
  };
}

let loginSel = null, loginPin = "";
function pantallaLogin(msg) {
  const us = S.estado.usuarios;
  if (!us.length) { centro(`${logoCaja}<h1>Admin POS</h1><p class="sub">Todavía no hay usuarios con PIN. El administrador debe ponerlos en Ajustes.</p><button class="btn" data-act="reintentar">Reintentar</button>`); return; }
  if (!us.some((u) => u.id === loginSel)) loginSel = us.length === 1 ? us[0].id : null;
  loginPin = "";
  centro(`${logoCaja}<h1>Admin POS</h1><p class="sub">${loginSel ? "Escribe tu PIN" : "¿Quién eres?"}</p>
    <div class="usuarios">${us.map((u) => `<button class="usuario ${u.id === loginSel ? "sel" : ""}" data-act="selUsuario" data-id="${u.id}">${e(u.nombre)}<small>${ROL[u.rol] || ""}</small></button>`).join("")}</div>
    <div class="puntos" id="puntos"></div>
    <p class="error" id="err" style="text-align:center" ${msg ? "" : "hidden"}>${e(msg || "")}</p>
    <div class="teclado">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-act="tecla" data-v="${n}">${n}</button>`).join("")}
      <button class="accion" data-act="tecla" data-v="borrar">Borrar</button><button data-act="tecla" data-v="0">0</button><button class="accion" data-act="tecla" data-v="ok">Entrar</button></div>
    ${S.estado.local ? '<button class="enlace" data-act="olvidePin">Olvidé el PIN del administrador</button>' : ""}
    ${esApp ? '<button class="enlace" data-act="cambiarServidor">Cambiar dirección de la PC</button>' : ""}`);
  pintarPuntos();
}
function pintarPuntos() { const p = $("#puntos"); if (p) p.innerHTML = Array.from({ length: Math.max(4, loginPin.length) }, (_, i) => `<i class="${i < loginPin.length ? "lleno" : ""}"></i>`).join(""); }
async function teclaPin(v) {
  if (!loginSel) return aviso("Primero elige tu nombre.");
  if (v === "borrar") loginPin = loginPin.slice(0, -1);
  else if (v === "ok") {
    if (loginPin.length < 4) return aviso("El PIN tiene al menos 4 números.");
    try { const r = await post("/api/login", { id: loginSel, pin: loginPin }); S.token = r.token; S.yo = r.usuario; entrarApp(); }
    catch (err) { loginPin = ""; pintarPuntos(); const x = $("#err"); x.textContent = err.message; x.hidden = false; }
    return;
  } else if (loginPin.length < 8) loginPin += v;
  pintarPuntos();
}
document.addEventListener("keydown", (ev) => {
  if (!$("#puntos") || ev.ctrlKey || ev.altKey || ev.metaKey || $("#modal:not([hidden])")) return;
  if (/^\d$/.test(ev.key)) teclaPin(ev.key); else if (ev.key === "Backspace") teclaPin("borrar"); else if (ev.key === "Enter") teclaPin("ok");
});

async function olvidePin() {
  const r = await pedir({ titulo: "Restablecer PIN", texto: "Para confirmar que eres el dueño, escribe la contraseña de MariaDB. Se borrarán todos los PIN y tendrás que crear el del administrador otra vez.", campos: [{ id: "clave", etiqueta: "Contraseña de MariaDB", tipo: "password" }], ok: "Restablecer" });
  if (!r) return;
  try { await post("/api/pin/reiniciar", { clave: r.v.clave }); r.cerrar(); iniciar(); } catch (err) { r.error(err.message); }
}

// ---------- Arranque ----------
async function iniciar(msg) {
  cerrarModal();
  if (esApp) { S.base = LS.get("servidor"); if (!S.base) return pantallaServidor(); }
  try { S.estado = await get("/api/estado"); }
  catch (err) { return esApp ? pantallaServidor(err.message) : centro(`${logoCaja}<h1>Admin POS</h1><p class="error" style="text-align:center">${e(err.message)}</p><button class="btn" data-act="reintentar">Reintentar</button>`); }
  const est = S.estado;
  if (est.licencia && est.licencia.requiere) return pantallaLicencia(est.licencia);
  if (!est.dbConfigurada) return pantallaDb();
  if (est.dbError) return pantallaDbError();
  if (!est.pinsConfigurados) return pantallaPinInicial();
  const t = SS.get("token");
  if (t && !msg) { S.token = t; try { S.yo = await get("/api/yo"); return entrarApp(); } catch { S.token = ""; SS.del("token"); } }
  pantallaLogin(msg);
}

function pantallaLicencia(lic = {}) {
  const vencida = /vencid/i.test(lic.error || "");
  const otraPc = /otra PC/i.test(lic.error || "");
  const badge = vencida
    ? '<span class="lic-badge lic-bad">Vencida</span>'
    : otraPc
      ? '<span class="lic-badge lic-bad">PC distinta</span>'
      : '<span class="lic-badge lic-warn">Sin activar</span>';
  const titulo = vencida ? "Licencia vencida" : otraPc ? "Licencia de otra PC" : "Activar licencia";
  const ayuda = vencida
    ? "Tu periodo terminó. Pide una renovación con el código de esta PC."
    : otraPc
      ? "Esa licencia fue emitida para otro equipo. Usa el código de abajo."
      : "Para usar Admin POS en esta PC hace falta una licencia firmada.";
  centro(`${logoCaja}
    <div class="lic-head">
      <h1>${titulo}</h1>
      ${badge}
    </div>
    <p class="sub">${e(ayuda)}</p>
    ${lic.error && !vencida && !otraPc ? `<div class="aviso-caja">${e(lic.error)}</div>` : ""}

    <div class="lic-paso">
      <div class="lic-n">1</div>
      <div class="lic-paso-cuerpo">
        <b>Código de esta PC</b>
        <p class="muted" style="margin:4px 0 8px;font-size:.84rem">Envíaselo a quien te genera la licencia (WhatsApp, correo, etc.).</p>
        <div class="lic-codigo">
          <code id="mcLic">${e(lic.mc || "—")}</code>
          <button type="button" class="btn sec chico" data-act="copiarMc">Copiar</button>
        </div>
      </div>
    </div>

    <div class="lic-paso">
      <div class="lic-n">2</div>
      <div class="lic-paso-cuerpo">
        <b>Pega la licencia recibida</b>
        <p class="muted" style="margin:4px 0 8px;font-size:.84rem">Es un texto largo. Cópialo completo, sin espacios de más al inicio o al final.</p>
        <textarea id="tokLic" class="lic-token" rows="5" placeholder="Pega aquí la licencia…" spellcheck="false" autocomplete="off"></textarea>
>
        <p class="error" id="errLic" hidden></p>
        <p class="ok" id="okLic" hidden></p>
      </div>
    </div>

    <button class="btn" id="btnActivarLic" data-act="activarLic">Activar licencia</button>
    <button class="btn sec" data-act="reintentar">Ya la activé · reintentar</button>
    <p class="muted" style="text-align:center;font-size:.8rem;margin:4px 0 0">La licencia queda guardada solo en esta PC y no necesita internet.</p>`);
  const ta = $("#tokLic");
  if (ta) {
    ta.addEventListener("paste", () => setTimeout(() => { ta.value = ta.value.trim(); }, 0));
  }
}

// ---------- Estructura principal ----------
const SECCIONES = [["resumen", "Resumen"], ["ventas", "Ventas"], ["productos", "Productos"], ["existencias", "Existencias"], ["caja", "Caja"], ["equipo", "Equipo"], ["inventario", "Inventario"], ["perdidas", "Pérdidas"], ["ajustes", "Ajustes"], ["ayuda", "Ayuda"]];
const SIN_PERIODO = ["inventario", "ajustes", "ayuda"];
let temporizadores = [];

function entrarApp() {
  SS.set("token", S.token);
  cerrarModal();
  const items = SECCIONES.filter(([k]) => S.yo.permisos.includes(k));
  if (!items.some(([k]) => k === S.vista)) S.vista = "resumen";
  const pip = (k) => (k === "inventario" || k === "perdidas" ? `<span class="pip" data-pip="${k}" hidden></span>` : "");
  $("#raiz").innerHTML = `<div class="app">
    <aside class="lateral"><div class="marca"><img src="logo.png" alt=""><div><h2>Admin POS</h2><small>Panel de control</small></div></div>
      ${items.map(([k, n]) => `<button class="nav" data-act="ir" data-v="${k}">${n}${pip(k)}</button>`).join("")}
      <div class="pie"><div>${e(S.yo.nombre)} · ${ROL[S.yo.rol]}</div><button data-act="cambiarMiPin">Cambiar mi PIN</button><button data-act="salir">Salir</button></div></aside>
    <div class="principal"><div class="barra">
      <div class="marca"><img src="logo.png" alt=""><h2>Admin POS</h2><button class="yo" data-act="menuYo">${e(S.yo.nombre)}</button></div>
      <div class="periodo" id="periodo">${[["hoy", "Hoy"], ["7", "7 días"], ["30", "30 días"], ["90", "90 días"], ["todo", "Todo"], ["custom", "Fechas"]].map(([v, n]) => `<button data-act="periodo" data-v="${v}">${n}</button>`).join("")}
        <button class="btn sec chico" data-act="buscarGlobal" title="Buscar">🔍</button>
        <button class="btn sec chico" data-act="toggleTema" id="btnTema" title="Cambiar tema claro/oscuro">${LS.get("tema") === "oscuro" ? "☀️ Claro" : "🌙 Oscuro"}</button>
        <button class="btn sec chico" data-act="prefsUI" title="Preferencias">Aa</button>
        <span id="rango-custom" class="rango-custom" ${S.periodo === "custom" ? "" : "hidden"}>
          <input type="date" id="desde" value="${e(S.desde)}" data-in="fechaDesde">
          <span>–</span>
          <input type="date" id="hasta" value="${e(S.hasta)}" data-in="fechaHasta">
          <button class="btn sec" data-act="aplicarFechas" style="padding:6px 10px;font-size:.82rem">Ver</button>
        </span>
      </div>
      <div class="menu" id="menu">${items.map(([k, n]) => `<button data-act="ir" data-v="${k}">${n}${pip(k)}</button>`).join("")}</div></div>
      <main class="contenido" id="contenido"></main></div></div>`;
  marcarNav();
  vista();
  actualizarConteos();
  temporizadores.forEach(clearInterval);
  temporizadores = [setInterval(actualizarConteos, 60000), setInterval(() => { if (S.vista === "resumen" && S.yo && document.visibilityState === "visible") vistas.resumen(true); }, 30000)];
}

function marcarNav() {
  document.querySelectorAll("[data-act=ir]").forEach((b) => b.classList.toggle("sel", b.dataset.v === S.vista));
  document.querySelectorAll("[data-act=periodo]").forEach((b) => b.classList.toggle("sel", b.dataset.v === S.periodo));
  const p = $("#periodo"); if (p) p.hidden = SIN_PERIODO.includes(S.vista);
  const rc = $("#rango-custom"); if (rc) rc.hidden = S.periodo !== "custom";
  const mb = document.querySelector("#menu .sel"); if (mb) mb.scrollIntoView({ inline: "center", block: "nearest" });
}

function ir(v) { S.vista = v; S.ventas.pagina = S.prod.pagina = S.exis.pagina = S.cajaPag = 1; marcarNav(); window.scrollTo(0, 0); vista(); }

async function vista(silencio) {
  const tk = ++S.tk;
  if (!silencio) $("#contenido").innerHTML = '<p class="cargando">Cargando…</p>';
  try { await vistas[S.vista](silencio); }
  catch (err) { if (tk === S.tk && S.yo) $("#contenido").innerHTML = `<div class="tarjeta"><p class="error">${e(err.message)}</p><button class="btn sec chico" data-act="recargar">Reintentar</button></div>`; }
}
const aqui = (tk) => tk === S.tk;
const cab = (t, s) => `<h1>${t}</h1>${s ? `<p class="sub">${s}</p>` : ""}`;
const rangoTxt = (d) => `${diaLargo(d.desde)} – ${diaLargo(d.hasta)}`;

function pager(pagina, paginas) {
  return `<div class="pag"><button data-act="pag" data-n="${pagina - 1}" ${pagina <= 1 ? "disabled" : ""}>Anterior</button><span>${pagina} / ${paginas}</span><button data-act="pag" data-n="${pagina + 1}" ${pagina >= paginas ? "disabled" : ""}>Siguiente</button></div>`;
}
const hbar = (nombre, valor, max, texto) => `<div class="hbar"><div class="t"><span>${e(nombre)}</span><span class="num">${texto}</span></div><div class="pista"><i style="width:${max > 0 ? Math.max(2, (valor / max) * 100) : 0}%"></i></div></div>`;

async function actualizarConteos() {
  if (!S.token) return;
  try {
    const c = await get("/api/conteos"); S.conteos = c;
    const val = { inventario: c.stockAltas || 0, perdidas: c.anomaliasAltas || 0 };
    document.querySelectorAll("[data-pip]").forEach((p) => { const n = val[p.dataset.pip]; p.textContent = n; p.hidden = !n; });
    const n = val.inventario + val.perdidas;
    if (S.ultimoPip != null && n > S.ultimoPip && "Notification" in window && Notification.permission === "granted") new Notification("Admin POS", { body: `Hay ${n} alertas importantes: revisa Inventario y Pérdidas.` });
    S.ultimoPip = n;
  } catch {}
}

// ---------- Gráficas (Chart.js interactivo + fallback SVG) ----------
const chartsActivos = {};
function destruirCharts() {
  Object.values(chartsActivos).forEach((c) => { try { c.destroy(); } catch {} });
  Object.keys(chartsActivos).forEach((k) => delete chartsActivos[k]);
}

function graficaHoras(horas, pico) {
  if (typeof Chart === "undefined") {
    const hs = horas.map((x) => x.hora);
    const a = Math.min(7, ...hs), b = Math.max(20, ...hs);
    const mapa = new Map(horas.map((x) => [x.hora, x.total]));
    const max = Math.max(1, ...horas.map((x) => x.total));
    let h = "";
    for (let i = a; i <= b; i++) { const v = mapa.get(i) || 0; h += `<div class="b ${pico && pico.hora === i ? "pico" : ""}" title="${i}:00 — ${cup(v)}"><i style="height:${(v / max) * 100}%"></i><em>${i}</em></div>`; }
    return `<div class="barras">${h}</div>`;
  }
  return `<div class="chart-wrap"><canvas id="chart-horas" height="180"></canvas></div>`;
}
function graficaLinea(dias) {
  if (dias.length < 2) return '<p class="muted">Todavía no hay suficientes días para dibujar la curva.</p>';
  if (typeof Chart === "undefined") {
    const W = Math.max(280, Math.min(900, ((document.querySelector('#contenido') || {}).clientWidth || 340) - 40)), H = 190, L = 50, B = 24, T = 10, R = 8;
    const max = Math.max(1, ...dias.map((d) => d.total)) * 1.08;
    const x = (i) => L + (i * (W - L - R)) / (dias.length - 1), y = (v) => T + (1 - v / max) * (H - T - B);
    const pts = dias.map((d, i) => `${x(i).toFixed(1)},${y(d.total).toFixed(1)}`);
    const etq = [0, Math.floor((dias.length - 1) / 3), Math.floor(((dias.length - 1) * 2) / 3), dias.length - 1];
    return `<div class="linea"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
      ${[0, 0.5, 1].map((f) => { const v = (max / 1.08) * f; return `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#d0dbe8"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#5a6b80">${compacto(v)}</text>`; }).join("")}
      <path d="M${x(0)},${y(0)} L${pts.join(" L")} L${x(dias.length - 1)},${y(0)} Z" fill="#2563eb" opacity=".14"/>
      <polyline points="${pts.join(" ")}" fill="none" stroke="#2563eb" stroke-width="2.4" stroke-linejoin="round"/>
      ${etq.map((i) => `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === dias.length - 1 ? "end" : "middle"}" font-size="11" fill="#5a6b80">${diaCorto(dias[i].dia)}</text>`).join("")}</svg></div>`;
  }
  return `<div class="chart-wrap"><canvas id="chart-dias" height="200"></canvas></div>`;
}
function graficaDiaSemana(dias) {
  if (!dias || dias.length < 3) return "";
  return `<div class="chart-wrap"><canvas id="chart-diasem" height="180"></canvas></div>`;
}

function montarCharts(d) {
  if (typeof Chart === "undefined") return;
  destruirCharts();
  const color = "#2563eb";
  const color2 = "#0ea5e9";
  const color3 = "#7c3aed";
  const grid = "#d0dbe8";
  const txt = "#5a6b80";
  const tipFmt = (v) => cup(v);
  const azules = ["#2563eb","#0ea5e9","#38bdf8","#1d4ed8","#0284c7","#7c3aed","#6366f1"];

  const cDias = document.getElementById("chart-dias");
  if (cDias && d.porDia && d.porDia.length > 1) {
    chartsActivos.dias = new Chart(cDias, {
      type: "line",
      data: {
        labels: d.porDia.map((x) => diaCorto(x.dia)),
        datasets: [{ label: "Ventas", data: d.porDia.map((x) => x.total), borderColor: color, backgroundColor: "rgba(37,99,235,.18)", fill: true, tension: 0.25, pointRadius: 3, pointHoverRadius: 6, pointBackgroundColor: color, pointBorderColor: "#fff" }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => tipFmt(ctx.raw) } } },
        scales: { x: { ticks: { color: txt, maxRotation: 0 }, grid: { display: false } }, y: { ticks: { color: txt, callback: (v) => compacto(v) }, grid: { color: grid } } },
      },
    });
  }

  const cHoras = document.getElementById("chart-horas");
  if (cHoras && d.porHora) {
    const hs = d.porHora.map((x) => x.hora);
    const a = Math.min(7, ...hs), b = Math.max(20, ...hs);
    const mapa = new Map(d.porHora.map((x) => [x.hora, x.total]));
    const labels = [], vals = [];
    for (let i = a; i <= b; i++) { labels.push(i + ":00"); vals.push(mapa.get(i) || 0); }
    chartsActivos.horas = new Chart(cHoras, {
      type: "bar",
      data: { labels, datasets: [{ label: "Ventas", data: vals, backgroundColor: vals.map((_, i) => azules[i % azules.length]), borderRadius: 6 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => tipFmt(ctx.raw) } } },
        scales: { x: { ticks: { color: txt }, grid: { display: false } }, y: { ticks: { color: txt, callback: (v) => compacto(v) }, grid: { color: grid } } },
      },
    });
  }

  const cSem = document.getElementById("chart-diasem");
  if (cSem && d.porDia && d.porDia.length >= 3) {
    const nombres = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
    const acum = [0, 0, 0, 0, 0, 0, 0];
    const cnt = [0, 0, 0, 0, 0, 0, 0];
    d.porDia.forEach((x) => {
      const dte = new Date(x.dia + "T12:00:00");
      const wd = dte.getDay();
      acum[wd] += x.total;
      cnt[wd] += 1;
    });
    const orden = [1, 2, 3, 4, 5, 6, 0];
    const labels = orden.map((i) => nombres[i]);
    const vals = orden.map((i) => (cnt[i] ? acum[i] / cnt[i] : 0));
    chartsActivos.diasem = new Chart(cSem, {
      type: "bar",
      data: { labels, datasets: [{ label: "Promedio por día", data: vals, backgroundColor: vals.map((_, i) => azules[i % azules.length]), borderRadius: 6 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => "Promedio: " + tipFmt(ctx.raw) } } },
        scales: { x: { ticks: { color: txt }, grid: { display: false } }, y: { ticks: { color: txt, callback: (v) => compacto(v) }, grid: { color: grid } } },
      },
    });
  }
}

// ---------- Secciones ----------
const vistas = {};

vistas.resumen = async (silencio) => {
  const tk = S.tk;
  const [d, panel, alertas] = await Promise.all([
    get("/api/resumen", paramsPeriodo()),
    get("/api/panel", paramsPeriodo()).catch(() => null),
    get("/api/alertas-inicio", paramsPeriodo()).catch(() => null),
  ]);
  if (!aqui(tk)) return;
  const solo = S.yo.rol === "cajero";
  const pico = d.porHora.reduce((m, x) => (!m || x.total > m.total ? x : m), null);
  const tr = d.tiempoReal;
  const vc = (v, txt) => (v == null ? `<div class="v muted">${txt}</div>` : `<div class="v ${claseVar(v)}">${v >= 0 ? "▲" : "▼"} ${signo(v)} ${txt}</div>`);
  const maxFam = Math.max(1, ...d.familias.map((f) => f.total));
  const bloqAlertas = alertas?.items?.length
    ? `<div class="tarjeta"><h3>Alertas al abrir</h3>${alertas.items.map((a) => `<div class="fila"><span class="etiqueta et-${a.nivel === "ok" ? "ok" : a.nivel === "alta" ? "alta" : "media"}">${a.nivel}</span><span style="margin-left:8px">${e(a.texto)}</span></div>`).join("")}</div>`
    : "";
  const bloqPanel = panel && !solo
    ? `<div class="kpis">
        <div class="kpi"><span>Ventas (período)</span><b class="num">${cup(panel.ventasPeriodo)}</b><small>${fmt(panel.tickets, 0)} tickets</small></div>
        <div class="kpi"><span>Último día</span><b class="num">${cup(panel.ventasHoy)}</b></div>
        <div class="kpi"><span>Caja fuera tol.</span><b class="num">${fmt(panel.caja?.conDiferencia || 0, 0)}</b><small>falt. ${cup(panel.caja?.faltante || 0)}</small></div>
        <div class="kpi"><span>Mermas</span><b class="num">${cup(panel.mermas || 0)}</b></div>
      </div>
      ${(panel.stockCritico || []).length ? `<div class="tarjeta"><h3>Stock crítico</h3>${panel.stockCritico.map((x) => `<div class="fila"><div>${e(x.nombre)}</div><div class="d"><span class="etiqueta et-alta">${e(x.tipo || "alerta")}</span></div></div>`).join("")}</div>` : ""}`
    : "";
  // Notificaciones locales (app abierta)
  if (alertas?.items?.some((a) => a.nivel === "alta") && typeof Notification !== "undefined" && Notification.permission === "granted") {
    try { new Notification("Admin POS", { body: alertas.items.filter((a) => a.nivel === "alta").map((a) => a.texto).join(" · ") }); } catch {}
  } else if (alertas?.items?.some((a) => a.nivel === "alta") && typeof Notification !== "undefined" && Notification.permission === "default") {
    try { Notification.requestPermission(); } catch {}
  }
  const favHtml = S.favs.length
    ? `<div class="favs">${S.favs.map((v) => `<button data-act="irFav" data-v="${e(v)}">${e(v)}</button>`).join("")}
        <button class="link" data-act="comparar">Comparar períodos</button></div>`
    : `<div class="favs"><button class="link" data-act="comparar">Comparar períodos</button>
        <span class="muted" style="font-size:.82rem">Marca secciones como favoritas desde el menú (próximamente) o úsalas abajo.</span></div>`;
  $("#contenido").innerHTML = `${cab(solo ? "Tus ventas" : "Cómo va la tienda", `${rangoTxt(d)}. Importes de las ventas registradas en AxisPOS, en CUP.`)}
    ${favHtml}${bloqAlertas}${bloqPanel}
    <div class="tarjeta hero"><div class="etq">${solo ? "Tus ventas del período" : "Ventas del período"}</div>
      <div class="grande num">${cup(d.total)}</div>
      <div class="muted">Neto ${cup(d.neto)} tras devoluciones · unos ${fmt(d.neto / d.tasa, 0)} US$ a ${fmt(d.tasa, 0)} CUP</div>
      ${d.anterior ? `<span class="chip ${claseVar(d.anterior.variacion)}">${d.anterior.variacion == null ? "Sin datos del período anterior" : signo(d.anterior.variacion) + " frente al período anterior"}</span>` : ""}
      <div class="mini"><div><span>Tickets</span><b class="num">${fmt(d.tickets, 0)}</b></div><div><span>Promedio</span><b class="num">${compacto(d.promedio)}</b></div>
        <div><span>Devoluciones</span><b class="num">${compacto(d.devoluciones)}</b><small>${d.devDocs} docs.</small></div></div></div>
    ${solo ? "" : `<div class="tarjeta"><h3>Costos y ganancia <small>según costo de ficha / operación</small></h3>
      <div class="kpis">
        <div class="kpi"><span>Ventas</span><b class="num">${cup(d.total)}</b></div>
        <div class="kpi"><span>Descuentos</span><b class="num">${cup(d.descuentos || 0)}</b></div>
        <div class="kpi"><span>Costo de lo vendido</span><b class="num">${cup(d.costo || 0)}</b></div>
        <div class="kpi"><span>Ganancia bruta</span><b class="num" style="color:var(--verde)">${cup(d.ganancia || 0)}</b>
          <small>Margen ${fmt((d.margen || 0) * 100, 1)} % · Costo × $1: ${fmt(d.costoPorPeso || 0, 2)}</small></div>
      </div>
      <p class="muted" style="margin:8px 0 0;font-size:.84rem">El costo usa el precio de costo de cada línea (o el de la ficha del producto). Si en AxisPOS muchos artículos no tienen costo cargado, la ganancia saldrá inflada.</p></div>`}
    <div class="tarjeta"><h3>Tiempo real <small>último día con ventas: ${diaLargo(tr.dia)}</small></h3><div class="rt">
      <div><span>Ese día</span><b class="num">${cup(tr.hoy)}</b>${vc(tr.varDia, "vs día anterior")}<span>${tr.hoyTickets} tickets</span></div>
      <div><span>Últimos 7 días</span><b class="num">${cup(tr.semana)}</b>${vc(tr.varSemana, "vs 7 días antes")}</div>
      <div><span>Este mes</span><b class="num">${cup(tr.mes)}</b>${vc(tr.varMes, "vs mismo tramo del mes anterior")}<span>Mes anterior completo: ${compacto(tr.mesAntCompleto)}</span></div></div>
      ${tr.horasHoy.length ? `<div style="margin-top:14px"><span class="muted" style="font-size:.82rem">Ventas por hora de ese día</span>${graficaHoras(tr.horasHoy, tr.horasHoy.reduce((m, x) => (!m || x.total > m.total ? x : m), null))}</div>` : ""}</div>
    <div class="tarjeta"><h3>Ritmo del día <small>${pico ? `Pico a las ${pico.hora}:00` : ""}</small></h3>${graficaHoras(d.porHora, pico)}
      <p class="muted" style="margin:10px 0 0;font-size:.84rem">${d.formasPago.map((f) => `${e(f.socio)} ${compacto(f.total)}`).join(" · ")}</p></div>
    <div class="tarjeta"><h3>Ventas por día <small>${fmt(d.unidades, 0)} unidades</small></h3>${graficaLinea(d.porDia)}</div>
    <div class="tarjeta"><h3>Promedio por día de la semana</h3>${graficaDiaSemana(d.porDia)}<p class="muted" style="margin:8px 0 0;font-size:.84rem">Promedio de ventas de cada día de la semana en el período seleccionado.</p></div>
    <div class="tarjeta"><h3>Lo más vendido</h3><div class="scroll"><table><tr><th>Artículo</th><th>Familia</th><th class="d">Unid.</th><th class="d">Importe</th></tr>
      ${d.top.map((x) => `<tr><td>${e(x.nombre)}</td><td class="muted">${e(x.familia)}</td><td class="d num">${fmt(x.unidades, 0)}</td><td class="d num">${compacto(x.total)}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">Sin ventas en este período</td></tr>'}</table></div></div>
    <div class="tarjeta"><h3>Venta por grupo / familia</h3>
      ${d.familias.map((f) => hbar(f.familia, f.total, maxFam, compacto(f.total))).join("") || '<p class="muted">Sin datos</p>'}
      <div class="scroll" style="margin-top:12px"><table><tr><th>Grupo</th><th class="d">Unid.</th><th class="d">Costo</th><th class="d">Ganancia</th><th class="d">%</th><th class="d">Ventas</th></tr>
      ${d.familias.map((f) => `<tr><td>${e(f.familia)}</td><td class="d num">${fmt(f.unidades || 0, 0)}</td><td class="d num">${compacto(f.costo || 0)}</td><td class="d num">${compacto(f.ganancia || 0)}</td><td class="d num">${fmt((f.parte || 0) * 100, 1)} %</td><td class="d num"><b>${compacto(f.total)}</b></td></tr>`).join("")}
      </table></div></div>
    ${solo ? "" : `<div class="tarjeta"><h3>Ventas por trabajador</h3>${d.cajeros.map((c) => `<div class="fila"><div>${e(c.nombre)}<small>${ROL[c.rol] || ""} · ${fmt(c.tickets, 0)} tickets${c.devoluciones ? ` · dev. ${compacto(c.devoluciones)}` : ""}</small></div><div class="d num"><b>${compacto(c.total)}</b></div></div>`).join("") || '<p class="muted">Sin datos</p>'}</div>`}
    <div class="tarjeta"><h3>Últimos tickets <small><button class="link" data-act="ir" data-v="ventas">Ver todos</button></small></h3>
      ${d.recientes.map((t) => `<div class="fila clic" data-act="ticket" data-acct="${t.acct}" style="cursor:pointer"><div><span class="link">${t.ticket}</span><small>${fechaHora(t.fecha)} · ${e(t.cajero || "")}</small></div><div class="d num">${cup(t.total)}</div></div>`).join("") || '<p class="muted">Sin tickets</p>'}</div>`;
  // Montar gráficas interactivas (Chart.js)
  requestAnimationFrame(() => montarCharts(d));
};

vistas.ventas = async () => {
  const tk = S.tk;
  const tabs = subTabs([["tickets", "Tickets"], ["dia", "Ventas por día"]], S.ventas.sub, "ventasSub");
  if (S.ventas.sub === "dia") {
    const d = await get("/api/ventas-dia", paramsPeriodo());
    if (!aqui(tk)) return;
    const r = d.resumen;
    $("#contenido").innerHTML = `${cab("Ventas", "Total de transacciones y desglose diario.")}${tabs}
      <div class="kpis">
        <div class="kpi"><span>Total transacciones</span><b class="num">${fmt(r.tickets, 0)}</b><small>${fmt(r.lineas, 0)} líneas · ${fmt(r.dias, 0)} días</small></div>
        <div class="kpi"><span>Importe total</span><b class="num">${cup(r.total)}</b></div>
        <div class="kpi"><span>Ticket promedio</span><b class="num">${cup(r.ticketPromedio)}</b></div>
        <div class="kpi"><span>Promedio por día</span><b class="num">${cup(r.promedioDia)}</b><small>${fmt(r.unidades, 0)} unidades</small></div>
      </div>
      <div class="tarjeta"><h3>Ventas por día</h3>
        <div class="scroll"><table><tr><th>Día</th><th class="d">Tickets</th><th class="d">Unidades</th><th class="d">Líneas</th><th class="d">Ticket prom.</th><th class="d">Total</th></tr>
        ${d.filas.map((x) => `<tr><td class="num">${diaLargo(x.dia)}</td><td class="d num">${fmt(x.tickets, 0)}</td><td class="d num">${fmt(x.unidades, 0)}</td><td class="d num">${fmt(x.lineas, 0)}</td><td class="d num">${cup(x.ticketPromedio)}</td><td class="d num"><b>${cup(x.total)}</b></td></tr>`).join("") || '<tr><td colspan="6" class="muted">Sin ventas en el período</td></tr>'}
        </table></div></div>`;
    return;
  }
  $("#contenido").innerHTML = `${cab("Ventas", "Listado de tickets y total de transacciones.")}${tabs}
    <div class="tarjeta"><div class="filtros"><input id="q-ventas" type="search" placeholder="Ticket, cajero o artículo" value="${e(S.ventas.q)}" data-in="buscaVentas"><button class="btn" data-act="csvVentas">Descargar CSV</button></div><div id="lista"><p class="cargando">Cargando…</p></div></div>`;
  S.pagCb = (n) => { S.ventas.pagina = n; listaVentas(); };
  await listaVentas(tk);
};
async function listaVentas() {
  const tk = S.tk;
  const d = await get("/api/ventas", paramsPeriodo({ q: S.ventas.q, pagina: S.ventas.pagina }));
  if (!aqui(tk) || !$("#lista")) return;
  $("#lista").innerHTML = `<p class="muted" style="margin:0 0 8px"><b>${fmt(d.total, 0)} transacciones</b> (tickets) en el período. ${rangoTxt(d.rango || { desde: "", hasta: "" }).replace(/^ – $/, "")}</p>
    <div class="scroll"><table><tr><th>Cuándo</th><th>Ticket</th><th>Cajero</th><th>Socio</th><th class="d">Total</th></tr>
    ${d.filas.map((t) => `<tr class="clic" data-act="ticket" data-acct="${t.acct}"><td class="num">${fechaHora(t.fecha)}</td><td class="link num">${t.ticket}</td><td>${e(t.cajero || "")}</td><td class="muted">${e(t.socio || "")}</td><td class="d num">${cup(t.total)}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">No se encontró nada</td></tr>'}</table></div>${pager(d.pagina, d.paginas)}`;
}
async function abrirTicket(acct) {
  try {
    const t = await get("/api/ticket", { acct });
    const logsHtml = (t.logs && t.logs.length)
      ? `<div style="margin-top:14px"><h4 style="margin:0 0 6px;font-size:.9rem">Registro relacionado (anulaciones, cancelaciones…)</h4>
          ${t.logs.map((l) => `<div class="fila" style="align-items:flex-start"><div><small>${fechaHora(l.fecha)} · ${e(l.usuario)}</small><div style="font-size:.88rem">${e(l.mensaje)}</div></div></div>`).join("")}</div>`
      : "";
    const pagosHtml = (t.pagos && t.pagos.length)
      ? `<div style="margin-top:10px"><h4 style="margin:0 0 6px;font-size:.9rem">Pagos registrados</h4>
          ${t.pagos.map((p) => `<div class="fila"><div>Modo ${e(p.modo)}${p.socio ? ` · ${e(p.socio)}` : ""}</div><div class="d num">${cup(p.monto)}</div></div>`).join("")}</div>`
      : "";
    abrirModal(`<div class="panel"><header><div><span class="muted">${t.devolucion ? "Devolución" : "Ticket"}</span><h2 class="num">${t.ticket}</h2><span class="muted">${fechaHora(t.fecha)} · ${e(t.cajero || "")} · ${e(t.socio || "")}</span></div><button class="cerrar" data-act="cerrarModal">✕</button></header>
      <div class="cuerpo">${t.lineas.map((l) => `<div class="fila"><div>${e(l.nombre)}<small>${fmt(l.cant, 3)} pzs. × ${cup(l.precio)}${l.descuento ? ` · desc. ${fmt(l.descuento, 1)} %` : ""}${l.nota ? ` · ${e(l.nota)}` : ""}</small></div><div class="d num">${cup(l.importe)}</div></div>`).join("")}
      ${pagosHtml}${logsHtml}</div>
      <footer><span class="muted">Total</span><b class="num">${cup(t.total)}</b></footer></div>`, "");
  } catch (err) { aviso(err.message); }
}

vistas.productos = async () => {
  const tk = S.tk;
  const tabs = subTabs([["lista", "Catálogo"], ["top", "Top"], ["precios", "Precios"], ["margen", "Margen"], ["efecto", "Efecto precio"]], S.prod.sub, "prodSub");
  if (S.prod.sub === "margen") {
    const d = await get("/api/margen", paramsPeriodo());
    if (!aqui(tk)) return;
    $("#contenido").innerHTML = `${cab("Productos", "Margen bruto por producto y familia (costo real o estimado).")}${tabs}
      <div class="tarjeta"><h3>Por familia</h3><div class="scroll"><table><tr><th>Familia</th><th class="d">Ventas</th><th class="d">Costo</th><th class="d">Ganancia</th><th class="d">Margen</th></tr>
      ${d.familias.map((f) => `<tr><td>${e(f.familia)}</td><td class="d num">${cup(f.ventas)}</td><td class="d num">${cup(f.costo)}</td><td class="d num">${cup(f.ganancia)}</td><td class="d num">${fmt(f.margen * 100, 1)} %</td></tr>`).join("")}
      </table></div></div>
      <div class="tarjeta"><h3>Por producto</h3><div class="scroll"><table><tr><th>Producto</th><th class="d">Unid.</th><th class="d">Ventas</th><th class="d">Costo</th><th class="d">Ganancia</th><th class="d">Margen</th></tr>
      ${d.filas.map((x) => `<tr><td>${e(x.nombre)}${x.estimado ? " <small>(est.)</small>" : ""}</td><td class="d num">${fmt(x.unidades, 0)}</td><td class="d num">${cup(x.ventas)}</td><td class="d num">${cup(x.costo)}</td><td class="d num">${cup(x.ganancia)}</td><td class="d num">${fmt(x.margen * 100, 1)} %</td></tr>`).join("")}
      </table></div></div>`;
    return;
  }
  if (S.prod.sub === "efecto") {
    const d = await get("/api/efecto-precios", paramsPeriodo());
    if (!aqui(tk)) return;
    $("#contenido").innerHTML = `${cab("Productos", "Productos cuyo precio medio cambió entre la 1.ª y 2.ª mitad del período.")}${tabs}
      <div class="tarjeta"><div class="scroll"><table><tr><th>Producto</th><th class="d">P. antes</th><th class="d">P. después</th><th class="d">Δ %</th><th class="d">Unid. antes</th><th class="d">Unid. después</th><th class="d">Δ unid.</th></tr>
      ${d.filas.map((x) => `<tr><td>${e(x.nombre)}</td><td class="d num">${cup(x.precioAntes)}</td><td class="d num">${cup(x.precioDespues)}</td>
        <td class="d num">${fmt(x.cambioPct * 100, 1)} %</td><td class="d num">${fmt(x.unidAntes, 0)}</td><td class="d num">${fmt(x.unidDespues, 0)}</td>
        <td class="d num">${x.varUnid != null ? fmt(x.varUnid * 100, 0) + " %" : "—"}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">Sin cambios de precio significativos</td></tr>'}
      </table></div></div>`;
    return;
  }
  if (S.prod.sub === "top") {
    const d = await get("/api/top", paramsPeriodo({ limite: 50 }));
    if (!aqui(tk)) return;
    $("#contenido").innerHTML = `${cab("Productos", "Los más vendidos del período. Toca uno para ver sus transacciones.")}${tabs}
      <div class="kpis"><div class="kpi"><span>Importe de estos productos</span><b class="num">${cup(d.totalImporte)}</b></div></div>
      <div class="tarjeta"><div class="scroll"><table><tr><th>#</th><th>Artículo</th><th>Familia</th><th class="d">Unid.</th><th class="d">Tickets</th><th class="d">%</th><th class="d">Total</th></tr>
      ${d.filas.map((p) => `<tr class="clic" data-act="prodTx" data-id="${p.id}" style="cursor:pointer"><td class="num muted">${p.puesto}</td><td>${e(p.nombre)}<small>${e(p.codigo || "")}</small></td><td class="muted">${e(p.familia)}</td><td class="d num">${fmt(p.unidades, 0)}</td><td class="d num">${fmt(p.tickets, 0)}</td><td class="d num">${fmt(p.parte * 100, 1)} %</td><td class="d num"><b>${cup(p.total)}</b></td></tr>`).join("") || '<tr><td colspan="7" class="muted">Sin ventas</td></tr>'}
      </table></div></div>`;
    return;
  }
  if (S.prod.sub === "precios") {
    const d = await get("/api/cambios-precio", paramsPeriodo());
    if (!aqui(tk)) return;
    $("#contenido").innerHTML = `${cab("Productos", "Artículos vendidos a más de un precio en el período y quién los cobró así.")}${tabs}
      <div class="kpis"><div class="kpi"><span>Productos con varios precios</span><b class="num">${fmt(d.total, 0)}</b></div></div>
      <div class="tarjeta"><p class="muted" style="margin:0 0 10px;font-size:.86rem">Se detecta por el precio de cada línea de venta en AxisPOS (no hay un log de «quién editó la ficha»). Si el mismo producto se vendió a 2+ precios distintos, aquí ves a qué precio, cuántas veces y qué cajero lo cobró.</p>
      ${d.filas.map((p) => `<div class="tarjeta" style="margin:0 0 12px;box-shadow:none;border:1px solid var(--borde)">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <div><b>${e(p.nombre)}</b><small style="display:block">${e(p.familia)}${p.codigo ? " · " + e(p.codigo) : ""}</small></div>
          <div class="d num"><span class="etiqueta et-media">${p.nPrecios} precios</span>
            <small style="display:block">de ${cup(p.precioMin)} a ${cup(p.precioMax)} (Δ ${cup(p.variacion)})</small></div>
        </div>
        <div class="scroll" style="margin-top:8px"><table><tr><th class="d">Precio</th><th class="d">Unid.</th><th class="d">Tickets</th><th>Quién cobró a ese precio</th></tr>
        ${p.precios.map((pr) => `<tr>
          <td class="d num"><b>${cup(pr.precio)}</b></td>
          <td class="d num">${fmt(pr.unidades, 0)}</td>
          <td class="d num">${fmt(pr.tickets, 0)}</td>
          <td>${(pr.quienes || []).map((q) => `${e(q.usuario)} (${fmt(q.tickets, 0)} t.)`).join(", ") || "—"}</td>
        </tr>`).join("")}
        </table></div>
      </div>`).join("") || '<p class="muted">En este período ningún producto se vendió a más de un precio distinto.</p>'}
      </div>`;
    return;
  }
  const d0 = await get("/api/productos", paramsPeriodo({ q: S.prod.q, familia: S.prod.familia, orden: S.prod.orden, activos: S.prod.activos ? 1 : 0, pagina: S.prod.pagina }));
  if (!aqui(tk)) return;
  S.famLista = d0.familias;
  $("#contenido").innerHTML = `${cab("Productos", "Catálogo y ventas. Toca un artículo para ver sus transacciones.")}${tabs}
    <div class="tarjeta"><div class="filtros"><input type="search" placeholder="Nombre o código" value="${e(S.prod.q)}" data-in="buscaProd">
    <select data-in="famProd"><option value="">Todas las familias</option>${d0.familias.map((f) => `<option value="${f.id}" ${String(f.id) === String(S.prod.familia) ? "selected" : ""}>${e(f.nombre)}</option>`).join("")}</select>
    <select data-in="ordenProd">${[["vendidos", "Más vendidos"], ["nombre", "Nombre"], ["stock", "Más existencia"], ["precio", "Mayor precio"]].map(([v, n]) => `<option value="${v}" ${S.prod.orden === v ? "selected" : ""}>${n}</option>`).join("")}</select>
    <label class="chk"><input type="checkbox" data-in="activosProd" ${S.prod.activos ? "checked" : ""}> Solo activos</label></div><div id="lista"></div></div>`;
  S.pagCb = (n) => { S.prod.pagina = n; recargarProd(); };
  pintarProd(d0);
};
async function recargarProd() {
  const tk = S.tk;
  const d = await get("/api/productos", paramsPeriodo({ q: S.prod.q, familia: S.prod.familia, orden: S.prod.orden, activos: S.prod.activos ? 1 : 0, pagina: S.prod.pagina }));
  if (aqui(tk)) pintarProd(d);
}
function pintarProd(d) {
  const cajero = S.yo.rol === "cajero";
  $("#lista").innerHTML = `<p class="muted" style="margin:0 0 8px">${fmt(d.total, 0)} artículos. Toca una fila para ver transacciones del período.</p><div class="scroll"><table><tr><th>Código</th><th>Artículo</th><th>Familia</th><th class="d">Precio</th><th class="d">Existencia</th>${cajero ? "" : '<th class="d">Vendido</th>'}</tr>
    ${d.filas.map((p) => `<tr class="clic" data-act="prodTx" data-id="${p.id}" style="cursor:pointer"><td class="muted">${e(p.codigo)}</td><td>${e(p.nombre)}</td><td class="muted">${e(p.familia)}</td><td class="d num">${cup(p.precio)}</td><td class="d num ${p.existencia <= 0 ? "baja" : ""}" ${p.existencia <= 0 ? 'style="color:var(--rojo)"' : ""}>${fmt(p.existencia, 2)}</td>${cajero ? "" : `<td class="d num">${p.vendido ? fmt(p.vendido, 0) + " · " + compacto(p.importe) : "—"}</td>`}</tr>`).join("") || '<tr><td colspan="6" class="muted">No se encontró nada</td></tr>'}</table></div>${pager(d.pagina, d.paginas)}`;
}
async function abrirProdTx(id, pagina = 1) {
  try {
    const d = await get("/api/prod-tx", paramsPeriodo({ id, pagina }));
    if (d.error) { aviso(d.error); return; }
    const p = d.producto;
    abrirModal(`<div class="panel"><header><div><span class="muted">Transacciones del producto</span><h2>${e(p.nombre)}</h2>
      <span class="muted">${e(p.codigo || "")} · ${e(p.familia || "")} · ${fmt(d.tickets, 0)} tickets · ${fmt(d.unidades, 0)} u. · ${cup(d.importe)}</span></div>
      <button class="cerrar" data-act="cerrarModal">✕</button></header>
      <div class="cuerpo"><div class="scroll"><table><tr><th>Cuándo</th><th>Ticket</th><th>Cajero</th><th class="d">Cant.</th><th class="d">Importe</th></tr>
      ${d.filas.map((x) => `<tr class="clic" data-act="ticket" data-acct="${x.acct}" style="cursor:pointer"><td class="num">${fechaHora(x.fecha)}</td><td class="link num">${x.ticket}</td><td>${e(x.cajero)}</td><td class="d num">${fmt(x.cant, 2)}</td><td class="d num">${cup(x.importe)}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">Sin ventas en el período</td></tr>'}
      </table></div>
      ${d.paginas > 1 ? `<div style="margin-top:10px;display:flex;gap:8px;justify-content:center">${d.pagina > 1 ? `<button class="btn sec" data-act="prodTxPag" data-id="${p.id}" data-n="${d.pagina - 1}">Anterior</button>` : ""}${d.pagina < d.paginas ? `<button class="btn sec" data-act="prodTxPag" data-id="${p.id}" data-n="${d.pagina + 1}">Siguiente</button>` : ""}</div>` : ""}
      </div></div>`, "");
  } catch (err) { aviso(err.message); }
}

vistas.existencias = async () => {
  const tk = S.tk;
  const d = await get("/api/existencias", paramsPeriodo({ q: S.exis.q, local: S.exis.local, pagina: S.exis.pagina }));
  if (!aqui(tk)) return;
  $("#contenido").innerHTML = `${cab("Existencias", "Foto del almacén según AxisPOS. Las cantidades son las que están guardadas, pieza por pieza.")}
    <div class="kpis"><div class="kpi"><span>Referencias con stock</span><b class="num">${fmt(d.referencias, 0)}</b></div><div class="kpi"><span>Piezas en total</span><b class="num">${fmt(d.piezas, 0)}</b></div><div class="kpi"><span>Vendidos y agotados</span><b class="num">${fmt(d.agotados, 0)}</b></div></div>
    ${d.agotadosLista.length ? `<div class="tarjeta"><h3>Se vendieron y ya no quedan <small>en el período</small></h3><div class="rejilla2">${d.agotadosLista.map((x) => `<div class="fila"><div>${e(x.nombre)}</div><div class="d num muted">${cup(x.importe)}</div></div>`).join("")}</div></div>` : ""}
    <div class="tarjeta"><div class="filtros"><input type="search" placeholder="Buscar artículo" value="${e(S.exis.q)}" data-in="buscaExis"><select data-in="localExis"><option value="">Todos los locales</option>${d.locales.map((l) => `<option value="${l.id}" ${String(l.id) === String(S.exis.local) ? "selected" : ""}>${e(l.nombre)}</option>`).join("")}</select></div><div id="lista"></div></div>`;
  S.pagCb = (n) => { S.exis.pagina = n; recargarExis(); };
  pintarExis(d);
};
async function recargarExis() { const tk = S.tk; const d = await get("/api/existencias", paramsPeriodo({ q: S.exis.q, local: S.exis.local, pagina: S.exis.pagina })); if (aqui(tk)) pintarExis(d); }
function pintarExis(d) {
  $("#lista").innerHTML = `<div class="scroll"><table><tr><th>Artículo</th><th>Local</th><th class="d">Cantidad</th></tr>${d.filas.map((x) => `<tr><td>${e(x.nombre)}</td><td class="muted">${e(x.local)}</td><td class="d num">${fmt(x.cantidad, 2)}</td></tr>`).join("") || '<tr><td colspan="3" class="muted">Sin existencias para este filtro</td></tr>'}</table></div>${pager(d.pagina, d.paginas)}`;
}

vistas.caja = async () => {
  const tk = S.tk;
  const d = await get("/api/caja", paramsPeriodo({ pagina: S.cajaPag }));
  if (!aqui(tk)) return;
  S.pagCb = (n) => { S.cajaPag = n; vista(true); };
  const etDif = (t) => {
    if (t.diferencia == null) return '<span class="etiqueta et-gris">Sin cierre</span>';
    const txt = `${t.diferencia > 0 ? "+" : ""}${fmt(t.diferencia, 0)}`;
    if (t.nivel === "ok") return `<span class="etiqueta et-ok">OK ${txt}</span>`;
    return `<span class="etiqueta et-${t.nivel === "alta" ? "alta" : "media"}">${txt}</span>`;
  };
  const etPagos = (t) => {
    if (!(t.ventas > 0)) return "—";
    if (Math.abs(t.difPagos) <= 1) return '<span class="muted" style="font-size:.82rem">Pagos OK</span>';
    return `<span class="etiqueta et-media">Δ ${fmt(t.difPagos, 0)}</span>`;
  };
  $("#contenido").innerHTML = `${cab("Caja", "Conciliación de cada turno: lo contado al cierre vs lo que el sistema esperaba.")}
    <div class="kpis"><div class="kpi"><span>Ventas</span><b class="num">${cup(d.ventas)}</b></div><div class="kpi"><span>Devoluciones</span><b class="num">${cup(d.devoluciones)}</b></div><div class="kpi"><span>Neto</span><b class="num">${cup(d.neto)}</b></div>
      <div class="kpi"><span>Turnos</span><b class="num">${d.turnos}</b><small>${d.conDiferencia} fuera de tolerancia (${fmt(d.tolerancia, 0)} CUP)</small></div></div>
    <div class="tarjeta"><h3>Cómo leer las columnas</h3>
      <p class="muted" style="margin:0;font-size:.86rem">
        <b>Esperado</b> = fondo inicial + ventas − devoluciones − retiros.<br>
        <b>Diferencia (efectivo)</b> = contado − esperado. Negativo = faltante, positivo = sobrante. Solo es <b>OK</b> si |diferencia| ≤ tolerancia (${fmt(d.tolerancia, 0)} CUP en Ajustes).<br>
        <b>Pagos vs ventas</b> es otra cosa: compara el total de ventas del turno con los pagos registrados (efectivo/tarjeta/transferencia). «Pagos OK» no significa que el efectivo del cajón cuadre.
      </p></div>
    ${d.conDiferencia ? `<div class="tarjeta"><h3>Auditoría de cierres (efectivo)</h3><div class="rt"><div><span>Faltante acumulado</span><b class="num" style="color:var(--rojo)">${cup(d.faltante)}</b></div><div><span>Sobrante acumulado</span><b class="num" style="color:var(--verde)">${cup(d.sobrante)}</b></div><div><span>Turnos con pagos ≠ ventas</span><b class="num">${d.sinCuadrar}</b></div></div></div>` : ""}
    ${(d.porCajero && d.porCajero.length) ? `<div class="tarjeta"><h3>Histórico de diferencias por cajero (efectivo)</h3>
      <div class="scroll"><table><tr><th>Cajero</th><th class="d">Turnos</th><th class="d">Fuera tol.</th><th class="d">Faltante</th><th class="d">Sobrante</th><th class="d">Neto</th><th class="d">Máx. faltante</th></tr>
      ${d.porCajero.map((c) => `<tr><td>${e(c.usuario)}</td><td class="d num">${c.turnos}</td><td class="d num">${c.conDif}</td>
        <td class="d num" style="color:${c.faltante < 0 ? "var(--rojo)" : "inherit"}">${c.faltante ? cup(c.faltante) : "—"}</td>
        <td class="d num" style="color:${c.sobrante > 0 ? "var(--verde)" : "inherit"}">${c.sobrante ? cup(c.sobrante) : "—"}</td>
        <td class="d num">${cup(c.totalDif)}</td>
        <td class="d num">${c.maxFaltante < 0 ? cup(c.maxFaltante) : "—"}</td></tr>`).join("")}</table></div></div>` : ""}
    <div class="tarjeta"><h3>Cobros por forma de pago</h3>${d.formasPago.map((f) => `<div class="fila"><div>${e(f.socio)}<small>${fmt(f.tickets, 0)} tickets</small></div><div class="d num">${cup(f.total)}</div></div>`).join("") || '<p class="muted">Sin datos</p>'}</div>
    <div class="tarjeta"><h3>Turnos</h3>
      <div class="scroll"><table><tr><th>Apertura</th><th>Quién</th><th class="d">Ventas</th><th class="d">Efectivo</th><th class="d">Tarjeta</th><th class="d">Transfer.</th><th class="d">Esperado</th><th class="d">Contado</th><th class="d">Dif. efectivo</th><th class="d">Horas</th></tr>
      ${d.filas.map((t) => `<tr>
        <td class="num">${fechaHora(t.apertura)}<small>${fechaHora(t.cierre)}</small></td>
        <td>${e(t.usuario || "")}<small>${e(t.local || "")}</small></td>
        <td class="d num">${cup(t.ventas)}</td>
        <td class="d num">${t.efectivo ? cup(t.efectivo) : "—"}</td>
        <td class="d num">${t.tarjeta ? cup(t.tarjeta) : "—"}</td>
        <td class="d num">${t.transferencia ? cup(t.transferencia) : "—"}</td>
        <td class="d num">${t.contado ? cup(t.esperado) : "—"}</td>
        <td class="d num">${t.contado ? cup(t.contado) : "—"}</td>
        <td class="d">${etDif(t)}</td>
        <td class="d num">${t.horasTurno != null ? fmt(t.horasTurno, 1) + " h" : "—"}</td>
      </tr>`).join("") || '<tr><td colspan="10" class="muted">Sin turnos en el período</td></tr>'}</table></div>${pager(d.pagina, d.paginas)}</div>`;
};

vistas.equipo = async () => {
  const tk = S.tk;
  if (!S.eqSub) S.eqSub = "ventas";
  const tabs = subTabs([["ventas", "Ventas"], ["prod", "Productividad"], ["ranking", "Ranking + señales"], ["turnos", "Horario turnos"]], S.eqSub, "eqSub");
  if (S.eqSub === "ranking") {
    const d = await get("/api/ranking", paramsPeriodo());
    if (!aqui(tk)) return;
    $("#contenido").innerHTML = `${cab("Equipo", "Productividad y señales de caja/anulaciones.")}${tabs}
      <div class="tarjeta"><div class="scroll"><table><tr><th>Cajero</th><th class="d">Ventas/h</th><th class="d">Tickets/h</th><th>Señales</th></tr>
      ${d.filas.map((x) => `<tr><td>${e(x.usuario)}</td><td class="d num">${x.ventasHora!=null?cup(x.ventasHora):"—"}</td>
        <td class="d num">${x.ticketsHora!=null?fmt(x.ticketsHora,1):"—"}</td>
        <td>${(x.señales||[]).map((s)=>`<span class="etiqueta et-${s.nivel}">${e(s.texto)}</span> `).join("")||'<span class="etiqueta et-ok">OK</span>'}</td></tr>`).join("")}
      </table></div></div>`;
    return;
  }
  if (S.eqSub === "prod") {
    const d = await get("/api/productividad", paramsPeriodo());
    if (!aqui(tk)) return;
    $("#contenido").innerHTML = `${cab("Equipo", "Tickets y ventas por hora de turno.")}${tabs}
      <div class="tarjeta"><div class="scroll"><table><tr><th>Cajero</th><th class="d">Turnos</th><th class="d">Horas</th><th class="d">Tickets/h</th><th class="d">Ventas/h</th><th class="d">Unid/ticket</th><th class="d">Ticket medio</th></tr>
      ${d.filas.map((x) => `<tr><td>${e(x.usuario)}</td><td class="d num">${x.turnos}</td><td class="d num">${fmt(x.horas, 1)}</td>
        <td class="d num">${x.ticketsHora != null ? fmt(x.ticketsHora, 1) : "—"}</td>
        <td class="d num">${x.ventasHora != null ? cup(x.ventasHora) : "—"}</td>
        <td class="d num">${x.unidTicket != null ? fmt(x.unidTicket, 1) : "—"}</td>
        <td class="d num">${x.ticketMedio != null ? cup(x.ticketMedio) : "—"}</td></tr>`).join("")}
      </table></div></div>`;
    return;
  }
  if (S.eqSub === "turnos") {
    const d = await get("/api/turnos-horario", paramsPeriodo());
    if (!aqui(tk)) return;
    const h = d.horario || {};
    $("#contenido").innerHTML = `${cab("Equipo", `Horario esperado apertura ${h.aperturaMin}:00–${h.aperturaMax}:00 · máx ${h.horasMax} h (Ajustes).`)}${tabs}
      <div class="kpis"><div class="kpi"><span>Abiertos</span><b class="num">${fmt(d.abiertos, 0)}</b></div><div class="kpi"><span>Con alerta</span><b class="num">${fmt(d.conAlerta, 0)}</b></div></div>
      <div class="tarjeta"><div class="scroll"><table><tr><th>Apertura</th><th>Cierre</th><th>Quién</th><th>Local</th><th class="d">Horas</th><th>Alertas</th></tr>
      ${d.filas.map((x) => `<tr ${x.alerta ? 'style="background:rgba(255,80,80,.08)"' : ""}>
        <td class="num">${fechaHora(x.apertura)}</td><td class="num">${x.cierre ? fechaHora(x.cierre) : "Abierto"}</td>
        <td>${e(x.usuario || "")}</td><td class="muted">${e(x.local || "")}</td>
        <td class="d num">${x.horas != null ? fmt(x.horas, 1) : "—"}</td>
        <td>${(x.flags||[]).map((f)=>`<span class="etiqueta et-media">${e(f)}</span>`).join(" ")||"—"}</td></tr>`).join("")}
      </table></div></div>`;
    return;
  }
  const d = await get("/api/equipo", paramsPeriodo());
  if (!aqui(tk)) return;
  $("#contenido").innerHTML = `${cab("Equipo", "Quién cobró y a nombre de qué socio quedó la venta.")}${tabs}
    ${d.cajeros.map((c) => `<div class="tarjeta"><div style="display:flex;justify-content:space-between;align-items:baseline"><h3 style="margin:0">${e(c.nombre)}</h3>${etRol(c.rol)}</div><span class="muted">${e(c.grupo)}</span>
      <div class="grande num" style="font:600 1.7rem var(--serif);margin:8px 0 2px">${cup(c.total)}</div><div class="muted">${fmt(c.tickets, 0)} tickets · devoluciones ${cup(c.devoluciones)} · promedio ${compacto(c.tickets ? c.total / c.tickets : 0)}</div>
      <div class="hbar"><div class="pista"><i style="width:${Math.max(2, c.parte * 100)}%"></i></div></div></div>`).join("") || '<div class="tarjeta"><p class="muted">Sin ventas en este período</p></div>'}
    <div class="tarjeta"><h3>Socios en las ventas</h3><div class="scroll"><table><tr><th>Socio</th><th class="d">Tickets</th><th class="d">Importe</th></tr>${d.socios.map((s) => `<tr><td>${e(s.socio)}</td><td class="d num">${fmt(s.tickets, 0)}</td><td class="d num">${cup(s.total)}</td></tr>`).join("")}</table></div></div>`;
};

// ---------- Inventario ----------
const subTabs = (lista, actual, act) => `<div class="subpestanas">${lista.map(([k, n]) => `<button class="${k === actual ? "sel" : ""}" data-act="${act}" data-v="${k}">${n}</button>`).join("")}</div>`;
const TIPO_ALERTA = { agotado: "Agotado", minimo: "Bajo mínimo", reorden: "Reponer" };

vistas.inventario = async () => {
  const tk = S.tk;
  const tabs = subTabs([
    ["alertas", "Alertas"],
    ["ipv", "IPV"],
    ["traspasos", "Traspasos"],
    ["hechos", "Traspasos hechos"],
    ["antiguedad", "Antigüedad"],
    ["fisico", "Físico / Arqueo"],
    ["abc", "ABC"],
    ["compras", "Compras"],
  ], S.invSub, "invSub");
  let cuerpo = "";
  if (S.invSub === "alertas") {
    const d = await get("/api/alertas");
    cuerpo = `<div class="kpis"><div class="kpi"><span>Agotados que se vendían</span><b class="num">${d.resumen.agotados}</b></div><div class="kpi"><span>Bajo el mínimo</span><b class="num">${d.resumen.minimo}</b></div><div class="kpi"><span>Por reponer</span><b class="num">${d.resumen.reorden}</b></div></div>
      <div class="tarjeta"><h3>Productos en alerta <small>${d.total} en total</small></h3><p class="muted" style="margin:-4px 0 8px;font-size:.84rem">Se calcula con las ventas de los últimos ${d.ventana} días. Punto de reposición = venta diaria × (${d.plazo} días de entrega + ${d.seguridad} de seguridad). Puedes cambiar estos números en Ajustes.</p>
      ${d.filas.map((x) => `<div class="fila"><div>${e(x.nombre)}<small>${e(x.familia)}${x.clase !== "-" ? " · clase " + x.clase : ""}${x.minimo > 0 ? " · mínimo " + fmt(x.minimo, 0) : ""}</small></div>
        <div class="d"><span class="etiqueta et-${x.tipo}">${TIPO_ALERTA[x.tipo]}</span><small>Stock ${fmt(x.stock, 1)} · vende ${fmt(x.diaria, 1)}/día${x.cobertura != null ? ` · alcanza ${fmt(x.cobertura, 1)} d` : ""}</small></div></div>`).join("") || '<p class="muted">No hay productos en alerta. Todo en orden.</p>'}</div>`;
  } else if (S.invSub === "ipv") {
    const d = await get("/api/ipv", paramsPeriodo({ q: S.exis.q || "", local: S.exis.local || "" }));
    if (!aqui(tk)) return;
    const r = d.resumen;
    cuerpo = `<div class="kpis">
        <div class="kpi"><span>Existencia inicial</span><b class="num">${fmt(r.inicio, 0)}</b><small>valor ~ ${cup(r.valorInicio)}</small></div>
        <div class="kpi"><span>Entradas</span><b class="num">${fmt(r.entradas, 0)}</b></div>
        <div class="kpi"><span>Ventas</span><b class="num">${fmt(r.ventas, 0)}</b><small>${cup(r.importeVentas)}</small></div>
        <div class="kpi"><span>Existencia final</span><b class="num">${fmt(r.final, 0)}</b><small>valor ~ ${cup(r.valorFinal)}</small></div>
      </div>
      <div class="kpis">
        <div class="kpi"><span>Devoluciones</span><b class="num">${fmt(r.devoluciones, 0)}</b></div>
        <div class="kpi"><span>Mermas / bajas</span><b class="num">${fmt(r.mermas, 0)}</b></div>
        <div class="kpi"><span>Productos en el IPV</span><b class="num">${fmt(r.productos, 0)}</b></div>
      </div>
      <div class="tarjeta"><div class="filtros"><input type="search" placeholder="Buscar producto" value="${e(S.exis.q)}" data-in="buscaExis">
        <select data-in="localExis"><option value="">Todos los locales</option>${d.locales.map((l) => `<option value="${l.id}" ${String(l.id) === String(S.exis.local) ? "selected" : ""}>${e(l.nombre)}</option>`).join("")}</select>
        <button class="btn sec" data-act="invSub" data-v="ipv">Aplicar</button>
        <button class="btn sec" data-act="printVista">Imprimir / PDF</button></div>
        <p class="muted" style="margin:0 0 8px;font-size:.84rem">Período ${diaLargo(d.desde)} – ${diaLargo(d.hasta)}. Inicial = stock actual − movimientos del período (reconstruido desde AxisPOS).</p>
        <h3>Movimiento de mercancías por producto</h3>
        <div class="scroll"><table>
          <tr><th>Producto</th><th class="d">Inicio</th><th class="d">Entradas</th><th class="d">Ventas</th><th class="d">Dev.</th><th class="d">Mermas</th><th class="d">Final</th><th class="d">\$ ventas</th></tr>
          ${d.filas.map((x) => `<tr>
            <td>${e(x.nombre)}<small>${e(x.familia)}${x.codigo ? " · " + e(x.codigo) : ""}</small></td>
            <td class="d num">${fmt(x.inicio, 1)}</td>
            <td class="d num">${x.entradas ? fmt(x.entradas, 1) : "—"}</td>
            <td class="d num">${x.ventas ? fmt(x.ventas, 1) : "—"}</td>
            <td class="d num">${x.devoluciones ? fmt(x.devoluciones, 1) : "—"}</td>
            <td class="d num">${x.mermas ? fmt(x.mermas, 1) : "—"}</td>
            <td class="d num"><b>${fmt(x.final, 1)}</b></td>
            <td class="d num">${x.importeVentas ? compacto(x.importeVentas) : "—"}</td>
          </tr>`).join("") || '<tr><td colspan="8" class="muted">Sin movimientos ni stock en el filtro</td></tr>'}
        </table></div></div>
      <div class="tarjeta"><h3>Tipos de movimiento en el período</h3>
        <div class="scroll"><table><tr><th>Tipo</th><th class="d">Operaciones</th><th class="d">Unidades</th><th class="d">Importe</th></tr>
        ${(d.tiposMovimiento || []).map((t) => `<tr><td>${e(t.nombre)} <small class="muted">(${t.tipo})</small></td><td class="d num">${fmt(t.n, 0)}</td><td class="d num">${fmt(t.volumen, 1)}</td><td class="d num">${t.importe ? compacto(t.importe) : "—"}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">Sin movimientos</td></tr>'}
        </table></div></div>
      <div class="tarjeta"><h3>Stock actual por local (valorado)</h3>
        <div class="scroll"><table><tr><th>Local</th><th class="d">Refs.</th><th class="d">Piezas</th><th class="d">Valor costo</th><th class="d">Valor venta</th></tr>
        ${d.porLocal.map((x) => `<tr><td>${e(x.local)}</td><td class="d num">${fmt(x.refs, 0)}</td><td class="d num">${fmt(x.piezas, 1)}</td><td class="d num">${cup(x.costo)}</td><td class="d num">${cup(x.venta)}</td></tr>`).join("")}
        </table></div></div>`;
  } else if (S.invSub === "traspasos") {
    const d = await get("/api/traspasos", paramsPeriodo());
    if (!aqui(tk)) return;
    const inv = d.inversion || { total: 0, porLocal: [] };
    cuerpo = `<div class="kpis">
        <div class="kpi"><span>Inversión total</span><b class="num">${cup(inv.total)}</b><small>costo real o −${d.costoEstimadoPct || 0} % del precio</small></div>
        <div class="kpi"><span>Productos a mover</span><b class="num">${fmt(d.resumen.productos, 0)}</b><small>${d.resumen.altas} urgencia alta</small></div>
        <div class="kpi"><span>Unidades sugeridas</span><b class="num">${fmt(d.resumen.unidades, 0)}</b></div>
        <div class="kpi"><span>Valor del traspaso</span><b class="num">${cup(d.resumen.valorCosto)}</b></div>
      </div>
      <div class="tarjeta"><h3>Inversión por almacén / local</h3>
        <div class="scroll"><table><tr><th>Local</th><th>Tipo</th><th class="d">Refs.</th><th class="d">Piezas</th><th class="d">Invertido</th></tr>
        ${inv.porLocal.map((x) => `<tr><td>${e(x.local)}</td><td class="muted">${e(x.tipo)}</td><td class="d num">${fmt(x.refs, 0)}</td><td class="d num">${fmt(x.piezas, 1)}</td><td class="d num"><b>${cup(x.inversion)}</b></td></tr>`).join("") || '<tr><td colspan="5" class="muted">Sin stock</td></tr>'}
        </table></div></div>
      <div class="tarjeta"><h3>Cómo se calcula el traspaso</h3>
        <p class="muted" style="margin:0;font-size:.86rem">
          <b>PV:</b> ${d.puntosVenta.map((x) => e(x.nombre)).join(", ") || "—"} · <b>Almacén:</b> ${d.almacenes.map((x) => e(x.nombre)).join(", ") || "—"}.<br>
          Objetivo = mayor entre <b>mínimo de ficha</b> y <b>nominal</b> (${d.diasObjetivo} días × venta diaria). Se mueve la diferencia, sin superar el stock del almacén.
        </p></div>
      <div class="tarjeta"><h3>Sugerencias almacén → punto de venta</h3>
        <div class="scroll"><table><tr><th>Producto</th><th class="d">Mín.</th><th class="d">Nominal</th><th class="d">En PV</th><th class="d">En alm.</th><th class="d">Mover</th><th>Urgencia</th></tr>
        ${d.filas.map((x) => `<tr>
          <td>${e(x.nombre)}<small>${e(x.motivo || "")} · ${e(x.desde)} → ${e(x.hacia)}</small></td>
          <td class="d num">${x.minimo ? fmt(x.minimo, 1) : "—"}</td>
          <td class="d num">${fmt(x.nominal, 1)}</td>
          <td class="d num">${fmt(x.enPv, 1)}</td>
          <td class="d num">${fmt(x.enAlm, 1)}</td>
          <td class="d num"><b>${fmt(x.sugerido, 1)}</b></td>
          <td><span class="etiqueta et-${x.urgencia === "alta" ? "alta" : x.urgencia === "media" ? "media" : "ok"}">${x.urgencia}</span></td>
        </tr>`).join("") || '<tr><td colspan="7" class="muted">Nada que mover: el PV cumple mínimo y cobertura, o no hay stock en almacén.</td></tr>'}
        </table></div></div>`;
  } else if (S.invSub === "hechos") {
    const d = await get("/api/traspasos-hechos", paramsPeriodo());
    cuerpo = `<div class="kpis"><div class="kpi"><span>Movimientos</span><b class="num">${fmt(d.movimientos, 0)}</b></div><div class="kpi"><span>Unidades</span><b class="num">${fmt(d.unidades, 0)}</b></div></div>
      <div class="tarjeta"><h3>Historial de traspasos (AxisPOS)</h3>
        <div class="scroll"><table><tr><th>Cuándo</th><th>Tipo</th><th>Producto</th><th class="d">Cant.</th><th>Usuario</th><th>Local</th></tr>
        ${d.filas.map((x) => `<tr><td class="num">${fechaHora(x.fecha)}</td><td>${e(x.nombreTipo)}</td><td>${e(x.nombre)}</td><td class="d num">${fmt(x.cant, 1)}</td><td>${e(x.usuario || "")}</td><td class="muted">${e(x.local)}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">Sin traspasos registrados en el período (OperType 7/26/27).</td></tr>'}
        </table></div></div>`;
  } else if (S.invSub === "antiguedad") {
    const d = await get("/api/antiguedad", paramsPeriodo());
    const r = d.resumen;
    cuerpo = `<div class="kpis">
        <div class="kpi"><span>0–30 días</span><b class="num">${fmt(r.d0_30.n, 0)}</b><small>${cup(r.d0_30.capital)}</small></div>
        <div class="kpi"><span>31–60</span><b class="num">${fmt(r.d31_60.n, 0)}</b><small>${cup(r.d31_60.capital)}</small></div>
        <div class="kpi"><span>61–90</span><b class="num">${fmt(r.d61_90.n, 0)}</b><small>${cup(r.d61_90.capital)}</small></div>
        <div class="kpi"><span>&gt;90 días</span><b class="num">${fmt(r.d90.n, 0)}</b><small>${cup(r.d90.capital)}</small></div>
        <div class="kpi"><span>Nunca vendido</span><b class="num">${fmt(r.nunca.n, 0)}</b><small>${cup(r.nunca.capital)}</small></div>
      </div>
      <div class="tarjeta"><h3>Capital parado &gt; 90 días</h3>
        <div class="scroll"><table><tr><th>Producto</th><th>Familia</th><th class="d">Stock</th><th class="d">Días</th><th class="d">Valor</th></tr>
        ${d.filas90.map((x) => `<tr><td>${e(x.nombre)}</td><td class="muted">${e(x.familia)}</td><td class="d num">${fmt(x.stock, 1)}</td><td class="d num">${x.dias ?? "—"}</td><td class="d num">${cup(x.valor)}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">Ninguno</td></tr>'}
        </table></div></div>
      <div class="tarjeta"><h3>Con stock y sin ventas registradas</h3>
        <div class="scroll"><table><tr><th>Producto</th><th>Familia</th><th class="d">Stock</th><th class="d">Valor</th></tr>
        ${d.filasNunca.map((x) => `<tr><td>${e(x.nombre)}</td><td class="muted">${e(x.familia)}</td><td class="d num">${fmt(x.stock, 1)}</td><td class="d num">${cup(x.valor)}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">Ninguno</td></tr>'}
        </table></div></div>`;
  } else if (S.invSub === "fisico") {
    cuerpo = `<div class="tarjeta"><h3>1. Generar lista para Arqueo</h3>
      <p class="muted" style="font-size:.86rem">Descarga un JSON filtrado e impórtalo en Arqueo Stock (o úsalo como guía de conteo).</p>
      <label class="chk"><input type="checkbox" id="arqSoloMin"> Solo bajo mínimo / reponer</label>
      <label class="campo">Clase ABC (opcional)
        <select id="arqClase"><option value="">Todas</option><option value="A">A</option><option value="B">B</option><option value="C">C</option></select>
      </label>
      <button class="btn sec" data-act="genListaArqueo">Descargar lista JSON</button>
    </div>
    <div class="tarjeta"><h3>2. Comparar conteo físico vs sistema</h3>
      <p class="muted" style="font-size:.86rem">Arqueo → Stock en vivo → IP de esta PC y puerto (ej. 3000). Tras contar, exporta JSON y cárgalo aquí.</p>
      <input type="file" id="arqueoFile" accept=".json,application/json" style="margin:10px 0">
      <button class="btn" data-act="importArqueo">Comparar con el sistema</button>
      <button class="btn sec" data-act="importArqueoAjustes">Informe de ajustes (para AxisPOS)</button>
      <div id="fisicoRes"></div></div>`;
  } else if (S.invSub === "abc") {
    const d = await get("/api/abc", { clase: S.abcClase });
    const nombres = { A: "Clase A · alta rotación", B: "Clase B · media", C: "Clase C · baja", S: "Sin movimiento" };
    cuerpo = `<div class="kpis">${["A", "B", "C"].map((c) => `<div class="kpi"><span>${nombres[c]}</span><b class="num">${fmt(d.clases[c].pct * 100, 0)} % de las ventas</b><small>${d.clases[c].n} productos · ${compacto(d.clases[c].importe)}</small></div>`).join("")}
      <div class="kpi"><span>Sin movimiento (${d.ventana} días)</span><b class="num">${d.sinMovimiento.n} productos</b><small>Capital detenido aprox. ${compacto(d.sinMovimiento.capital)}</small></div></div>
      <div class="tarjeta">${subTabs([["A", "A"], ["B", "B"], ["C", "C"], ["S", "Sin movimiento"]], S.abcClase, "abcClase")}<p class="muted" style="margin:10px 0;font-size:.84rem">Clase A: los productos que juntos hacen el 80 % de las ventas. B: el siguiente 15 %. C: el 5 % restante y lo que casi no rota. Calculado con los últimos ${d.ventana} días.</p>
      <div class="scroll"><table><tr><th>Producto</th><th>Familia</th><th class="d">Stock</th><th class="d">Vendido</th><th class="d">Importe</th>${S.abcClase === "S" ? "" : '<th class="d">% acum.</th>'}</tr>
      ${d.filas.map((x) => `<tr><td>${e(x.nombre)}</td><td class="muted">${e(x.familia)}</td><td class="d num">${fmt(x.stock, 1)}</td><td class="d num">${fmt(x.unidades, 0)}</td><td class="d num">${compacto(x.importe)}</td>${S.abcClase === "S" ? "" : `<td class="d num">${x.acum != null ? fmt(x.acum * 100, 0) + " %" : ""}</td>`}</tr>`).join("") || '<tr><td colspan="6" class="muted">Sin productos</td></tr>'}</table></div></div>`;
  } else {
    const d = await get("/api/compras");
    S.comprasCsv = d.filas;
    cuerpo = `<div class="kpis"><div class="kpi"><span>Productos a pedir</span><b class="num">${d.total}</b></div><div class="kpi"><span>Costo estimado</span><b class="num">${cup(d.estimado)}</b><small>${d.sinCosto} sin costo cargado</small></div></div>
      <div class="tarjeta"><h3>Lista de compra <small><button class="link" data-act="csvCompras">Descargar CSV</button></small></h3><p class="muted" style="margin:-4px 0 8px;font-size:.84rem">Cantidad = venta diaria × (${d.cobertura} días de cobertura + ${d.seguridad} de seguridad) − lo que hay. Ordenada por importancia (clase A primero) y urgencia. Venta medida en los últimos ${d.ventana} días.</p>
      <div class="scroll"><table><tr><th>Producto</th><th>Clase</th><th class="d">Stock</th><th class="d">Alcanza</th><th class="d">Pedir</th><th class="d">Costo est.</th></tr>
      ${d.filas.map((x) => `<tr><td>${e(x.nombre)}</td><td>${x.clase}</td><td class="d num">${fmt(x.stock, 1)}</td><td class="d num">${x.cobertura != null ? fmt(x.cobertura, 1) + " d" : "—"}</td><td class="d num"><b>${fmt(x.pedir, 0)}</b></td><td class="d num">${x.estimado != null ? compacto(x.estimado) : "—"}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">Nada por pedir por ahora</td></tr>'}</table></div></div>`;
  }
  if (aqui(tk)) $("#contenido").innerHTML = `${cab("Inventario", "Alertas, IPV valorado, traspasos almacén→PV, ABC y compras.")}${tabs}${cuerpo}`;
};

// ---------- Pérdidas ----------
const TIPOS_EV = [["cancel", "Cancelaciones"], ["anular", "Anulaciones"], ["elim", "Líneas quitadas"], ["desc", "Descuentos"], ["login", "Accesos fallidos"], ["cajon", "Cajón abierto"]];
vistas.perdidas = async () => {
  const tk = S.tk;
  const tabs = subTabs([["auditoria", "Auditoría"], ["alertas", "Alertas"], ["mermas", "Mermas"], ["devoluciones", "Devoluciones"], ["patrones", "Patrones anulación"], ["eventos", "Eventos"]], S.perSub, "perSub");
  let cuerpo = "";
  if (S.perSub === "auditoria") {
    const d = await get("/api/auditoria", paramsPeriodo());
    if (!aqui(tk)) return;
    const nv = (n) => (n === "alta" ? "alta" : n === "media" ? "media" : "ok");
    cuerpo = `
      <p style="margin:0 0 8px"><button class="btn sec chico" data-act="printVista">Imprimir / PDF auditoría</button></p>
      <div class="kpis">
        <div class="kpi"><span>Ventas del período</span><b class="num">${cup(d.ventas.total)}</b><small>${fmt(d.ventas.tickets, 0)} tickets</small></div>
        <div class="kpi"><span>Faltante caja</span><b class="num" style="color:var(--rojo)">${cup(d.caja.faltante)}</b></div>
        <div class="kpi"><span>Sobrante caja</span><b class="num" style="color:var(--verde)">${cup(d.caja.sobrante)}</b></div>
        <div class="kpi"><span>Turnos con dif. / sin cuadrar</span><b class="num">${d.caja.conDiferencia} / ${d.caja.sinCuadrar}</b></div>
      </div>
      <div class="tarjeta"><h3>Qué revisar primero</h3>
        ${d.hallazgos.map((h) => `<div class="fila" style="align-items:flex-start"><div><span class="etiqueta et-${nv(h.nivel)}">${h.nivel === "ok" ? "OK" : h.nivel}</span> <b>${e(h.titulo)}</b><small style="display:block;margin-top:4px">${e(h.texto)}</small></div></div>`).join("")}
      </div>
      <div class="tarjeta"><h3>Scorecard por cajero <small>riesgo = señales + caja</small></h3>
        <div class="scroll"><table><tr><th>Cajero</th><th class="d">Riesgo</th><th class="d">Tickets</th><th class="d">Cancel.</th><th class="d">Anul.</th><th class="d">Desc. altos</th><th class="d">Faltante caja</th><th class="d">Turnos dif.</th></tr>
        ${d.scorecard.map((u) => `<tr>
          <td>${e(u.nombre)}${u.flags.length ? `<small>${u.flags.slice(0, 2).map((f) => e(f.texto)).join(" · ")}</small>` : ""}</td>
          <td class="d"><span class="etiqueta et-${u.nivel}">${u.nivel}</span></td>
          <td class="d num">${fmt(u.tickets, 0)}</td>
          <td class="d num">${u.cancel || "—"}</td>
          <td class="d num">${u.anuladas || "—"}</td>
          <td class="d num">${u.descAltos || "—"}</td>
          <td class="d num" style="color:${u.cajaFaltante < 0 ? "var(--rojo)" : "inherit"}">${u.cajaFaltante ? cup(u.cajaFaltante) : "—"}</td>
          <td class="d num">${u.cajaConDif || "—"}</td>
        </tr>`).join("") || '<tr><td colspan="8" class="muted">Sin datos</td></tr>'}
        </table></div>
        <p class="muted" style="margin:8px 0 0;font-size:.84rem">Umbrales: descuento ≥ ${d.umbrales.descMax} %, cancelación grande ≥ ${fmt(d.umbrales.umbralCancel, 0)} CUP, tolerancia cierre ${fmt(d.umbrales.tolCierre, 0)} CUP (se cambian en Ajustes).</p>
      </div>
      <div class="tarjeta"><h3>Tickets grandes</h3>
        <div class="scroll"><table><tr><th>Cuándo</th><th>Ticket</th><th>Cajero</th><th class="d">Líneas</th><th class="d">Total</th></tr>
        ${d.ticketsGrandes.map((t) => `<tr class="clic" data-act="ticket" data-acct="${t.acct}" style="cursor:pointer"><td class="num">${fechaHora(t.fecha)}</td><td class="link num">${t.ticket}</td><td>${e(t.cajero)}</td><td class="d num">${t.lineas}</td><td class="d num">${cup(t.total)}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">Ninguno por encima del umbral</td></tr>'}
        </table></div></div>
      <div class="tarjeta"><h3>Descuentos altos (≥ ${d.umbrales.descMax} %)</h3>
        <div class="scroll"><table><tr><th>Cuándo</th><th>Ticket</th><th>Artículo</th><th>Cajero</th><th class="d">Desc.</th><th class="d">Importe</th></tr>
        ${d.descuentosAltos.map((x) => `<tr class="clic" data-act="ticket" data-acct="${x.acct}" style="cursor:pointer"><td class="num">${fechaHora(x.fecha)}</td><td class="link num">${x.ticket}</td><td>${e(x.nombre)}</td><td>${e(x.cajero)}</td><td class="d num">${fmt(x.descuento, 0)} %</td><td class="d num">${cup(x.importe)}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">Sin descuentos altos</td></tr>'}
        </table></div></div>
      ${d.fueraHorario.length ? `<div class="tarjeta"><h3>Ventas fuera de horario (antes 7:00 / desde 21:00)</h3>
        ${d.fueraHorario.map((x) => `<div class="fila"><div>${x.hora}:00 h</div><div class="d num">${fmt(x.tickets, 0)} tickets · ${cup(x.total)}</div></div>`).join("")}</div>` : ""}
      <div class="tarjeta"><h3>Quién más cancela / anula</h3>
        ${d.topCanceladores.map((x) => `<div class="fila"><div>${e(x.nombre)}</div><div class="d num">${fmt(x.n, 0)}</div></div>`).join("") || '<p class="muted">Sin cancelaciones</p>'}
        <p style="margin:10px 0 0"><button class="link" data-act="perSub" data-v="eventos">Ver eventos detallados</button> · <button class="link" data-act="ir" data-v="caja">Ir a Caja</button></p>
      </div>`;
  } else if (S.perSub === "alertas") {
    const d = await get("/api/anomalias", paramsPeriodo());
    const ver = (u, t, n) => (n ? `<button data-act="verEventos" data-tipo="${t}" data-u="${u.id}" data-nombre="${e(u.nombre)}">${n} ${{ cancel: "cancelaciones", elim: "líneas quitadas", desc: "descuentos", anular: "anuladas", login: "accesos fallidos", cajon: "cajón abierto" }[t]}</button>` : "");
    cuerpo = `<div class="kpis"><div class="kpi"><span>Alertas altas</span><b class="num" style="color:${d.totales.alta ? "var(--rojo)" : "inherit"}">${d.totales.alta}</b></div><div class="kpi"><span>Alertas medias</span><b class="num">${d.totales.media}</b></div></div>
      ${d.usuarios.map((u) => `<div class="tarjeta"><div style="display:flex;justify-content:space-between;align-items:baseline"><h3 style="margin:0">${e(u.nombre)}</h3>${u.flags.length ? `<span class="etiqueta et-${u.flags.some((f) => f.nivel === "alta") ? "alta" : "media"}">${u.flags.length} señal${u.flags.length > 1 ? "es" : ""}</span>` : '<span class="etiqueta et-ok">Sin señales</span>'}</div>
        ${u.flags.length ? `<ul class="banderas">${u.flags.map((f) => `<li><span class="punto ${f.nivel}"></span>${e(f.texto)}</li>`).join("")}</ul>` : '<p class="muted" style="margin:6px 0 0">Nada fuera de lo normal en este período.</p>'}
        <div class="cifras"><span>${fmt(u.tickets, 0)} tickets</span>${ver(u, "cancel", u.cancel)}${ver(u, "elim", u.lineasElim)}${ver(u, "desc", u.descuentos)}${ver(u, "anular", u.anuladas)}${ver(u, "login", u.loginFallidos)}${ver(u, "cajon", u.cajon)}</div></div>`).join("") || '<div class="tarjeta"><p class="muted">No hay actividad registrada en este período.</p></div>'}
      <div class="tarjeta"><h3>Cierres de caja con diferencia</h3>${d.cierresConDiferencia.map((t) => `<div class="fila"><div>${e(t.usuario || "")}<small>${fechaHora(t.apertura)}</small></div><div class="d"><span class="etiqueta et-${t.nivel}">${t.diferencia > 0 ? "+" : ""}${fmt(t.diferencia, 0)} CUP</span></div></div>`).join("") || '<p class="muted">Todos los cierres cuadran dentro de la tolerancia.</p>'}
        <p style="margin:10px 0 0"><button class="link" data-act="ir" data-v="caja">Ver todos los turnos en Caja</button></p></div>
      <details class="tarjeta"><summary class="muted" style="cursor:pointer">¿Cómo se deciden las alertas?</summary><p class="muted" style="margin:8px 0 0;font-size:.86rem">Cancelaciones: ${e(d.criterios.cancelTasa)}, o una sola cancelación de monto alto. Líneas quitadas: ${e(d.criterios.lineas)}. Descuentos manuales de ${e(d.criterios.descuento)}. Devoluciones: ${e(d.criterios.devolucion)}. Diferencia de caja: más de ${e(d.criterios.cierre)}. Los umbrales de monto se cambian en Ajustes. Una alerta es una señal para revisar, no una prueba de que algo esté mal.</p></details>`;
  } else if (S.perSub === "devoluciones") {
    const d = await get("/api/devoluciones", paramsPeriodo());
    cuerpo = `<div class="kpis"><div class="kpi"><span>Importe</span><b class="num">${cup(d.total)}</b></div><div class="kpi"><span>Unidades</span><b class="num">${fmt(d.unidades, 0)}</b></div><div class="kpi"><span>Movimientos</span><b class="num">${fmt(d.movimientos, 0)}</b></div></div>
      <div class="tarjeta"><h3>Por producto</h3>${d.porProducto.map((x) => `<div class="fila"><div>${e(x.nombre)}</div><div class="d num">${fmt(x.cant, 1)} u · ${cup(x.importe)}</div></div>`).join("") || '<p class="muted">Sin datos</p>'}</div>
      <div class="tarjeta"><h3>Por usuario</h3>${d.porUsuario.map((x) => `<div class="fila"><div>${e(x.usuario)}</div><div class="d num">${fmt(x.n, 0)} mov · ${cup(x.importe)}</div></div>`).join("")}</div>
      <div class="tarjeta"><h3>Detalle</h3>${d.filas.map((x) => `<div class="fila clic" data-act="ticket" data-acct="${x.acct}" style="cursor:pointer"><div>${e(x.nombre)}<small>${fechaHora(x.fecha)} · ${e(x.usuario)} · ticket ${x.ticket}</small></div><div class="d num">${fmt(x.cant, 1)} · ${cup(x.importe)}</div></div>`).join("")}</div>`;
  } else if (S.perSub === "patrones") {
    const d = await get("/api/patrones-anulacion", paramsPeriodo());
    const maxH = Math.max(1, ...d.porHora.map((h) => h.n));
    cuerpo = `<div class="kpis"><div class="kpi"><span>Eventos de anulación/cancelación</span><b class="num">${fmt(d.total, 0)}</b></div></div>
      <div class="tarjeta"><h3>Por hora del día</h3>${d.porHora.filter((h) => h.n).map((h) => hbar(h.hora + ":00", h.n, maxH, fmt(h.n, 0))).join("") || '<p class="muted">Sin datos</p>'}</div>
      <div class="tarjeta"><h3>Por usuario</h3>${d.porUsuario.map((x) => `<div class="fila"><div>${e(x.usuario)}</div><div class="d num">${fmt(x.n, 0)}</div></div>`).join("")}</div>
      <div class="tarjeta"><h3>Recientes</h3>${d.recientes.map((x) => `<div class="fila"><div>${e(x.usuario)}<small>${e(x.mensaje)}</small></div><div class="d muted num">${fechaHora(x.fecha)}</div></div>`).join("") || '<p class="muted">Sin eventos</p>'}</div>`;
  } else if (S.perSub === "mermas") {
    const d = await get("/api/mermas", paramsPeriodo());
    const max = Math.max(1, ...d.categorias.map((c) => c.valor));
    const maxP = Math.max(1, ...(d.porProducto || []).map((p) => p.valor));
    cuerpo = `<div class="kpis"><div class="kpi"><span>Valor de las mermas</span><b class="num">${cup(d.total)}</b></div><div class="kpi"><span>Frente a las ventas</span><b class="num">${fmt(d.impacto * 100, 2)} %</b></div><div class="kpi"><span>Movimientos</span><b class="num">${d.movimientos}</b></div><div class="kpi"><span>Productos distintos</span><b class="num">${fmt((d.porProducto || []).length, 0)}</b></div></div>
      ${d.movimientos ? `<div class="tarjeta"><h3>Por motivo</h3>${d.categorias.map((c) => hbar(c.nombre + ` (${c.n})`, c.valor, max, cup(c.valor))).join("")}${d.estimados ? `<p class="muted" style="font-size:.84rem;margin:8px 0 0">${d.estimados} movimientos no tienen costo cargado: se valoraron al precio de venta.</p>` : ""}</div>
      <div class="tarjeta"><h3>Total de mermas por producto</h3>
        <div class="scroll"><table><tr><th>Producto</th><th class="d">Mov.</th><th class="d">Cantidad</th><th class="d">Valor</th></tr>
        ${(d.porProducto || []).map((p) => `<tr><td>${e(p.nombre)}</td><td class="d num">${fmt(p.n, 0)}</td><td class="d num">${fmt(p.cantidad, 2)}</td><td class="d num"><b>${cup(p.valor)}</b></td></tr>`).join("")}
        </table></div>
        ${hbar("Mayor merma", (d.porProducto || [])[0]?.valor || 0, maxP, cup((d.porProducto || [])[0]?.valor || 0))}
      </div>
      <div class="tarjeta"><h3>Detalle de movimientos</h3>${d.filas.map((x) => `<div class="fila"><div>${e(x.nombre)}<small>${fechaHora(x.fecha)} · ${e(x.usuario || "")}${x.nota ? " · " + e(x.nota) : ""}</small></div><div class="d num">${fmt(x.cantidad, 2)} u.<small>${cup(x.valor)}</small></div></div>`).join("")}</div>`
      : '<div class="tarjeta"><p class="muted" style="margin:0">No hay mermas registradas en este período. Si las anotas en AxisPOS como «Merma» y escribes el motivo en la nota (vencimiento, daño, robo), aquí se clasifican y se mide cuánto pesan.</p></div>'}`;
  } else {
    S.pagCb = (n) => { S.ev.pagina = n; vista(true); };
    const d = await get("/api/eventos", paramsPeriodo({ tipo: S.ev.tipo, usuario: S.ev.usuario, pagina: S.ev.pagina }));
    cuerpo = `<div class="tarjeta"><div class="filtros"><select data-in="tipoEv">${TIPOS_EV.map(([v, n]) => `<option value="${v}" ${S.ev.tipo === v ? "selected" : ""}>${n}</option>`).join("")}</select>${S.ev.usuario ? `<button class="btn sec chico" data-act="quitarUsuarioEv">Solo ${e(S.ev.nombre)} ✕</button>` : ""}</div>
      <p class="muted" style="margin:0 0 6px">${fmt(d.total, 0)} eventos en el período. Toca un evento con ticket para ver la venta original.</p>
      ${d.filas.map((x) => `<div class="fila ${x.acct ? "clic" : ""}" ${x.acct ? `data-act="ticket" data-acct="${x.acct}" style="cursor:pointer"` : ""}>
        <div>${e(x.usuario)}${x.ticket ? ` · <span class="link">Ticket ${x.ticket}</span>${x.ticketTotal != null ? ` · ${cup(x.ticketTotal)}` : ""}` : ""}
          <small>${e(x.mensaje)}</small></div>
        <div class="d muted num">${fechaHora(x.fecha + ":00")}</div></div>`).join("") || '<p class="muted">Sin eventos.</p>'}${pager(d.pagina, d.paginas)}</div>`;
  }
  if (aqui(tk)) $("#contenido").innerHTML = `${cab("Pérdidas", "Señales para prevenir pérdidas: cancelaciones, descuentos, cierres de caja y mermas.")}${tabs}${cuerpo}`;
};

// ---------- Ajustes ----------
vistas.ajustes = async () => {
  const tk = S.tk;
  const d = await get("/api/ajustes");
  if (!aqui(tk)) return;
  const a = d.ajustes;
  const campo = (k, n, ayuda) => `<label class="campo">${n}<input name="${k}" inputmode="decimal" value="${a[k]}"><span style="font-size:.76rem">${ayuda}</span></label>`;
  $("#contenido").innerHTML = `${cab("Ajustes", "Solo el administrador ve esta pantalla.")}
    <div class="tarjeta"><h3>PIN y rol de cada usuario</h3><p class="muted" style="margin:-4px 0 8px;font-size:.86rem">Sin PIN no se puede entrar. Administrador: ve y cambia todo. Gerente: ve todo menos Ajustes. Cajero: solo sus propias ventas y turnos, y consulta de precios y existencias.</p>
      ${d.usuarios.map((u) => `<div class="fila" style="align-items:center;flex-wrap:wrap"><div>${e(u.nombre)}<small>${e(u.grupo)} · rol de AxisPOS: ${ROL[u.rolDefecto]}</small></div>
        <div class="d" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end"><select class="entrada" style="width:auto" data-in="rolUsuario" data-id="${u.id}">${["admin", "gerente", "cajero"].map((r) => `<option value="${r}" ${u.rol === r ? "selected" : ""}>${ROL[r]}</option>`).join("")}</select>
        <button class="btn sec chico" data-act="ponerPin" data-id="${u.id}" data-nombre="${e(u.nombre)}">${u.tienePin ? "Cambiar PIN" : "Poner PIN"}</button>${u.tienePin ? `<button class="btn sec chico" data-act="quitarPin" data-id="${u.id}" data-nombre="${e(u.nombre)}">Quitar</button>` : ""}</div></div>`).join("")}</div>
    <form class="tarjeta" id="form-aj"><h3>Alertas y cálculos</h3><div class="filtros" style="align-items:start">
      ${campo("tasa", "Tasa (CUP por USD)", "Solo para mostrar el equivalente")}${campo("plazoRepos", "Días que tarda un pedido", "Para el punto de reposición")}${campo("seguridad", "Días de seguridad", "Colchón extra")}
      ${campo("cobertura", "Días de venta a cubrir al comprar", "Para la lista de compras")}${campo("ventanaVentas", "Días de historial de ventas", "Para la venta diaria y el ABC")}${campo("umbralCancel", "Cancelación grande (CUP)", "Desde este monto se marca")}
      ${campo("descMax", "Descuento manual alto (%)", "Desde este % se marca")}${campo("tolCierre", "Diferencia de caja tolerada (CUP)", "Más que esto se marca")}
      ${campo("horaAperturaMin", "Hora mínima apertura turno", "Ej. 7")}${campo("horaAperturaMax", "Hora máxima apertura turno", "Ej. 10")}
      ${campo("horasTurnoMax", "Horas máximas de un turno", "Ej. 12")}${campo("metaDiaria", "Meta diaria de ventas (CUP)", "0 = sin meta")}
      ${campo("costoEstimadoPct", "Costo estimado si falta (%)", "Ej. 10 → costo = precio de venta − 10 %. Para IPV, inversión y márgenes.")}</div>
      <p class="error" id="err-aj" hidden></p><button class="btn">Guardar ajustes</button></form>
    <form class="tarjeta" id="form-db2"><h3>Conexión con MariaDB</h3>${d.db.permisos === "escritura" ? '<div class="aviso-caja">Este usuario de MariaDB puede modificar datos. Es más seguro usar uno de solo lectura (SELECT).</div>' : ""}
      <div class="filtros" style="margin-top:10px"><label class="campo">Servidor<input name="host" value="${e(d.db.host)}"></label><label class="campo">Puerto<input name="puerto" value="${d.db.puerto}"></label><label class="campo">Base de datos<input name="base" value="${e(d.db.base)}"></label>
      <label class="campo">Usuario<input name="usuario" value="${e(d.db.usuario)}" autocapitalize="none"></label><label class="campo">Contraseña (vacía = no cambiar)<input name="clave" type="password" autocomplete="off"></label></div>
      <p class="error" id="err-db" hidden></p><button class="btn sec">Probar y guardar conexión</button></form>`;
  $("#form-aj").onsubmit = async (ev) => {
    ev.preventDefault();
    const v = Object.fromEntries(new FormData(ev.target));
    for (const k in v) v[k] = Number(String(v[k]).replace(",", "."));
    try { await post("/api/ajustes/params", v); aviso("Ajustes guardados"); } catch (err) { const x = $("#err-aj"); x.textContent = err.message; x.hidden = false; }
  };
  $("#form-db2").onsubmit = async (ev) => {
    ev.preventDefault();
    try { await post("/api/config/db", Object.fromEntries(new FormData(ev.target))); aviso("Conexión guardada"); vista(true); } catch (err) { const x = $("#err-db"); x.textContent = err.message; x.hidden = false; }
  };
};

// ---------- Ayuda ----------
vistas.ayuda = async () => {
  const tk = S.tk;
  const rol = S.yo?.rol || "cajero";
  $("#contenido").innerHTML = `${cab("Ayuda", "Guía de primer uso y explicación de cada sección. Todo funciona en la red local, sin internet.")}
  <div class="tarjeta ayuda-bloque" id="ayuda-inicio">
    <h3>1. Primer uso (pasos iniciales)</h3>
    <ol class="ayuda-lista">
      <li><b>En la PC de la tienda</b> instala o descomprime Admin POS y ábrelo (o ejecuta <code>npm run servidor</code> y entra a <code>http://localhost:3000</code>).</li>
      <li><b>Licencia</b> (si aparece): anota el <b>código de esta PC</b>, pide la licencia firmada, pégala y toca Activar. Sin clave pública el programa puede abrir en modo desarrollo.</li>
      <li><b>MariaDB / AxisPOS</b>: la primera vez pide host, base, usuario y contraseña de solo lectura si es posible. Se guarda cifrada en esta PC.</li>
      <li><b>PIN del administrador</b>: elige un usuario de AxisPOS con nivel alto y crea un PIN de 4–8 dígitos. Ese PIN es de Admin POS, no el de Windows.</li>
      <li><b>Resto del equipo</b>: en <b>Ajustes</b> pon PIN y rol (Administrador / Gerente / Cajero) a cada persona que vaya a entrar.</li>
      <li><b>Desde el móvil</b> (mismo WiFi): abre <code>http://IP-DE-LA-PC:3000</code>. La IP suele verse al arrancar o en el diagnóstico de red.</li>
      <li><b>Bandeja del sistema</b> (versión .exe): puedes dejar el servidor corriendo sin tener el panel abierto y entrar solo desde el teléfono.</li>
    </ol>
    <p class="muted" style="font-size:.86rem;margin:8px 0 0">Si algo falla al conectar, usa el diagnóstico de red en la pantalla inicial (antes del PIN) y revisa firewall de Windows y que MariaDB acepte conexiones locales.</p>
  </div>

  <div class="tarjeta ayuda-bloque">
    <h3>2. Barra superior y temas</h3>
    <ul class="ayuda-lista">
      <li><b>Hoy / 7 días / 30 días / 90 días / Todo / Fechas</b>: filtra casi todos los reportes. “Fechas” permite un rango personalizado.</li>
      <li><b>🔍 Buscar</b>: localiza tickets, productos o cajeros según el texto.</li>
      <li><b>🌙 / ☀️</b>: cambia entre tema oscuro y claro (se recuerda en este dispositivo).</li>
      <li><b>Aa</b>: texto más grande y otras preferencias de pantalla.</li>
      <li>Tu nombre abre el menú de sesión (salir, etc.).</li>
    </ul>
  </div>

  <div class="tarjeta ayuda-bloque">
    <h3>3. Secciones de la aplicación</h3>

    <details class="ayuda-det" open>
      <summary><b>Resumen</b></summary>
      <p>Vista general del negocio en el periodo elegido: ventas, tickets, ticket medio, faltantes de caja, ganancia cuando hay costos, gráficos de ventas por día, por hora y por día de la semana, y ventas por familia. Ideal para “cómo vamos hoy”.</p>
    </details>
    <details class="ayuda-det">
      <summary><b>Ventas</b></summary>
      <p>Listado de tickets del periodo. Puedes filtrar y abrir el detalle. Las <b>anulaciones</b> permiten ver la venta original antes de anular. Sirve para auditorías puntuales y reclamos.</p>
    </details>
    <details class="ayuda-det">
      <summary><b>Productos</b></summary>
      <p>Catálogo, top de productos, cambios de precio (quién cambió), márgenes y costos. Si un producto no tiene costo en AxisPOS, en Ajustes puedes definir un % estimado (ej. precio − 10 %) para aproximar ganancia e inversión.</p>
    </details>
    <details class="ayuda-det">
      <summary><b>Existencias</b></summary>
      <p>Stock actual por almacén/punto de venta, valoración de inventario (cuánto hay invertido) y sugerencias de <b>traspaso</b> desde almacén al POS según mínimo y ritmo de venta.</p>
    </details>
    <details class="ayuda-det">
      <summary><b>Caja</b></summary>
      <p>Cierres y conciliaciones: ventas, efectivo, tarjeta, transferencia, esperado vs contado y diferencia. La <b>tolerancia</b> (en Ajustes) define desde cuándo se marca faltante/sobrante. No confundir “cuadra el medio de pago” con “cuadra el efectivo del cajón”.</p>
    </details>
    <details class="ayuda-det">
      <summary><b>Equipo</b></summary>
      <p>Desempeño por cajero: ventas, anulaciones, señales de caja y productividad. Útil para turnos y seguimiento del personal (gerente y admin).</p>
    </details>
    <details class="ayuda-det">
      <summary><b>Inventario</b></summary>
      <p>IPV (inicio, movimientos, final), cruce con conteo físico / Arqueo, exportación JSON filtrada para contar en el móvil, e informe de ajustes sugeridos (sin escribir solo en AxisPOS hasta que tú lo apliques). Incluye impresión/PDF orientado a auditoría.</p>
    </details>
    <details class="ayuda-det">
      <summary><b>Pérdidas</b></summary>
      <p>Mermas por producto y totales, cancelaciones grandes, descuentos altos y otras señales de riesgo. Pensado para ver “qué se está perdiendo” con claridad.</p>
    </details>
    <details class="ayuda-det">
      <summary><b>Ajustes</b> ${rol === "admin" ? "" : "<span class='pill'>Solo administrador</span>"}</summary>
      <p>PIN y rol de cada usuario, tolerancia de caja, umbrales de alertas, meta diaria, horario de turno, % de costo estimado y datos de conexión MariaDB. El gerente no ve esta pantalla; el cajero tampoco.</p>
    </details>
    <details class="ayuda-det">
      <summary><b>Ayuda</b></summary>
      <p>Esta guía. Disponible para todos los roles.</p>
    </details>
  </div>

  <div class="tarjeta ayuda-bloque">
    <h3>4. Roles</h3>
    <ul class="ayuda-lista">
      <li><b>Administrador</b>: acceso total, incluida la configuración y los PIN.</li>
      <li><b>Gerente</b>: opera y audita (ventas, caja, inventario, pérdidas) sin cambiar la conexión ni los PIN.</li>
      <li><b>Cajero</b>: resumen y consulta de ventas/productos/existencias/caja según permisos; no ve inventario avanzado ni ajustes.</li>
    </ul>
  </div>

  <div class="tarjeta ayuda-bloque">
    <h3>5. Arqueo e inventario físico</h3>
    <ol class="ayuda-lista">
      <li>En Inventario exporta o usa el stock en vivo hacia la app de <b>Arqueo</b>.</li>
      <li>Cuenta en el local y guarda el JSON del conteo.</li>
      <li>Impórtalo aquí para ver faltantes/sobrantes y el informe de ajustes sugeridos.</li>
      <li>Los movimientos en AxisPOS (entradas, ventas, mermas) alimentan el IPV inicio → final.</li>
    </ol>
  </div>

  <div class="tarjeta ayuda-bloque">
    <h3>6. Licencias</h3>
    <p>Cada PC tiene un código. La licencia firmada se activa una vez y queda en esta máquina. No necesita internet. Si vence o cambias de equipo, hay que emitir otra con el generador (misma llave pública que la del programa).</p>
  </div>

  <div class="tarjeta ayuda-bloque">
    <h3>7. Problemas frecuentes</h3>
    <ul class="ayuda-lista">
      <li><b>No conecta MariaDB</b>: revisa usuario/clave/base, que el servicio esté activo y el firewall.</li>
      <li><b>El móvil no abre el panel</b>: misma WiFi, IP correcta, puerto 3000 permitido, servidor en marcha (bandeja o ventana).</li>
      <li><b>Olvidé el PIN del admin</b>: en la PC local, opción de restablecer con la contraseña de MariaDB (borra los PIN y vuelve a crear el del admin).</li>
      <li><b>Números de caja raros</b>: mira la tolerancia y separa diferencia de efectivo vs otros medios de pago.</li>
      <li><b>Sin costos / márgenes en cero</b>: completa PriceIn en AxisPOS o usa el % de costo estimado en Ajustes.</li>
    </ul>
  </div>

  <p class="muted" style="text-align:center;font-size:.84rem">Admin POS lee AxisPOS en local. No sustituye el POS de venta: es el panel de control, auditoría e inventario.</p>`;
  if (!aqui(tk)) return;
};

// ---------- Acciones (clics) ----------
async function ponerPin(id, nombre) {
  const r = await pedir({ titulo: `PIN de ${nombre}`, texto: "De 4 a 8 números. Si ya tenía, se reemplaza y se cierra su sesión.", campos: [{ id: "pin", etiqueta: "Nuevo PIN", tipo: "password", pin: true }], ok: "Guardar PIN" });
  if (!r) return;
  try { await post("/api/ajustes/pin", { id, pin: r.v.pin }); r.cerrar(); aviso("PIN guardado"); vista(true); } catch (err) { r.error(err.message); }
}
async function cambiarMiPin() {
  const r = await pedir({ titulo: "Cambiar mi PIN", campos: [{ id: "actual", etiqueta: "PIN actual", tipo: "password", pin: true }, { id: "nuevo", etiqueta: "PIN nuevo", tipo: "password", pin: true }], ok: "Cambiar" });
  if (!r) return;
  try { await post("/api/mi-pin", r.v); r.cerrar(); aviso("PIN cambiado"); } catch (err) { r.error(err.message); }
}
async function salir() { try { await post("/api/logout"); } catch {} S.token = ""; S.yo = null; SS.del("token"); temporizadores.forEach(clearInterval); iniciar(); }

const ACC = {
  cortina: (el, ev) => { if (ev.target === el) cerrarModal(); },
  cerrarModal,
  ir: (el) => { cerrarModal(); ir(el.dataset.v); },
  periodo: (el) => {
    S.periodo = el.dataset.v;
    if (S.periodo !== "custom") LS.set("periodoPref", S.periodo);
    S.ventas.pagina = S.prod.pagina = S.exis.pagina = S.cajaPag = S.ev.pagina = 1;
    marcarNav();
    if (S.periodo === "custom") {
      if (!S.desde || !S.hasta) return;
    }
    vista();
  },
  buscarGlobal: () => {
    abrirModal(`<div class="dialogo busqueda-box"><h3>Búsqueda global</h3>
      <input type="search" id="qGlobal" placeholder="Ticket, producto o cajero…" autofocus>
      <div id="resGlobal" class="muted" style="margin-top:10px;min-height:40px">Escribe al menos 2 caracteres</div>
      <button class="btn sec" data-act="cerrarModal">Cerrar</button></div>`);
    const inp = $("#qGlobal");
    let t;
    inp.oninput = () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const q = inp.value.trim();
        if (q.length < 2) { $("#resGlobal").textContent = "Escribe al menos 2 caracteres"; return; }
        try {
          const d = await get("/api/buscar", paramsPeriodo({ q }));
          $("#resGlobal").innerHTML = `
            <h4 style="margin:8px 0 4px">Tickets</h4>
            ${(d.tickets || []).map((x) => `<div class="fila clic" data-act="ticket" data-acct="${x.acct}" style="cursor:pointer"><div>#${x.ticket} · ${e(x.cajero)}<small>${fechaHora(x.fecha)}</small></div><div class="d num">${cup(x.total)}</div></div>`).join("") || '<p class="muted">Ninguno</p>'}
            <h4 style="margin:12px 0 4px">Productos</h4>
            ${(d.productos || []).map((x) => `<div class="fila clic" data-act="prodTx" data-id="${x.id}" style="cursor:pointer"><div>${e(x.nombre)}<small>${e(x.codigo || "")}</small></div><div class="d num">${cup(x.precio)}</div></div>`).join("") || '<p class="muted">Ninguno</p>'}
            <h4 style="margin:12px 0 4px">Usuarios</h4>
            ${(d.usuarios || []).map((x) => `<div class="fila"><div>${e(x.nombre)}</div></div>`).join("") || '<p class="muted">Ninguno</p>'}`;
        } catch (err) { $("#resGlobal").textContent = err.message; }
      }, 300);
    };
  },
  toggleTema: () => {
    const oscuro = LS.get("tema") !== "oscuro";
    LS.set("tema", oscuro ? "oscuro" : "");
    aplicarPrefs();
    const b = document.getElementById("btnTema");
    if (b) b.textContent = oscuro ? "☀️ Claro" : "🌙 Oscuro";
  },
  prefsUI: () => {
    abrirModal(`<div class="dialogo"><h3>Preferencias de pantalla</h3>
      <label class="chk"><input type="checkbox" id="prefOscuro" ${LS.get("tema") === "oscuro" ? "checked" : ""}> Modo oscuro</label>
      <label class="chk"><input type="checkbox" id="prefGrande" ${LS.get("fuente") === "grande" ? "checked" : ""}> Texto más grande</label>
      <p class="muted" style="font-size:.84rem">También puedes usar el botón 🌙/☀️ de la barra superior.</p>
      <button class="btn" data-act="guardarPrefs">Guardar</button>
      <button class="btn sec" data-act="cerrarModal">Cerrar</button></div>`);
  },
  guardarPrefs: () => {
    LS.set("tema", $("#prefOscuro")?.checked ? "oscuro" : "");
    LS.set("fuente", $("#prefGrande")?.checked ? "grande" : "");
    aplicarPrefs();
    const b = document.getElementById("btnTema");
    if (b) b.textContent = LS.get("tema") === "oscuro" ? "☀️ Claro" : "🌙 Oscuro";
    cerrarModal();
    aviso("Preferencias guardadas");
  },
  toggleFav: (el) => { toggleFav(el.dataset.v); vista(true); },
  irFav: (el) => { S.vista = el.dataset.v; vista(); },
  comparar: async () => {
    abrirModal(`<div class="dialogo"><h3>Comparar dos períodos</h3>
      <p class="muted">Período A = el de la barra superior. Período B:</p>
      <label class="campo">Desde B<input type="date" id="cDesde"></label>
      <label class="campo">Hasta B<input type="date" id="cHasta"></label>
      <button class="btn" data-act="runComparar">Comparar</button>
      <button class="btn sec" data-act="cerrarModal">Cerrar</button>
      <div id="cmpRes"></div></div>`);
  },
  runComparar: async () => {
    const d2 = $("#cDesde")?.value, h2 = $("#cHasta")?.value;
    if (!d2 || !h2) { aviso("Elige ambas fechas de B"); return; }
    try {
      const d = await get("/api/comparar", paramsPeriodo({ desde2: d2, hasta2: h2 }));
      if (d.error) { aviso(d.error); return; }
      const pct = (x) => x == null ? "—" : fmt(x * 100, 1) + " %";
      $("#cmpRes").innerHTML = `<div class="rt" style="margin-top:12px">
        <div><span>Ventas A</span><b class="num">${cup(d.a.total)}</b></div>
        <div><span>Ventas B</span><b class="num">${cup(d.b.total)}</b></div>
        <div><span>Δ ventas</span><b class="num">${cup(d.delta.total)} (${pct(d.delta.totalPct)})</b></div>
        <div><span>Tickets A / B</span><b class="num">${fmt(d.a.tickets,0)} / ${fmt(d.b.tickets,0)}</b></div>
        <div><span>Δ tickets</span><b class="num">${d.delta.tickets} (${pct(d.delta.ticketsPct)})</b></div>
        <div><span>Caja fuera A / B</span><b class="num">${d.a.cajaFuera} / ${d.b.cajaFuera}</b></div>
      </div>`;
    } catch (err) { aviso(err.message); }
  },
  diagRed: async () => {
    const box = $("#diagRes");
    if (box) box.textContent = "Probando…";
    try {
      const t0 = Date.now();
      const d = await get("/api/diagnostico");
      const ms = Date.now() - t0;
      const txt = d.ok
        ? `✅ Conectado · ida y vuelta ${ms} ms · BD ${d.dbMs} ms · ${fmt(d.productos,0)} productos · ${e(d.version)}`
        : `❌ BD no responde: ${e(d.error || "error")}`;
      if (box) box.textContent = txt; else aviso(txt);
    } catch (err) {
      if (box) box.textContent = "❌ " + err.message; else aviso(err.message);
    }
  },
  printVista: () => window.print(),
  genListaArqueo: async () => {
    try {
      const soloMin = $("#arqSoloMin")?.checked ? "1" : "0";
      const clase = $("#arqClase")?.value || "";
      const d = await get("/api/lista-arqueo", paramsPeriodo({ soloMin, clase }));
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `lista-arqueo-${d.n}.json`;
      a.click();
      aviso(`Lista generada: ${d.n} productos`);
    } catch (err) { aviso(err.message); }
  },
  aplicarFechas: () => {
    const d = $("#desde")?.value, h = $("#hasta")?.value;
    if (!d || !h) { aviso("Elige fecha desde y hasta"); return; }
    S.desde = d; S.hasta = h; S.periodo = "custom";
    S.ventas.pagina = S.prod.pagina = S.exis.pagina = S.cajaPag = S.ev.pagina = 1;
    marcarNav(); vista();
  },
  pag: (el) => S.pagCb && S.pagCb(Number(el.dataset.n)),
  ticket: (el) => abrirTicket(el.dataset.acct),
  recargar: () => vista(),
  reintentar: () => iniciar(),
  copiarMc: async () => {
    const t = ($("#mcLic")?.textContent || "").trim();
    if (!t || t === "—") return;
    try {
      await navigator.clipboard.writeText(t);
      aviso("Código copiado");
    } catch {
      const r = document.createRange();
      r.selectNodeContents($("#mcLic"));
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      aviso("Código seleccionado · copia con Ctrl+C");
    }
  },
  activarLic: async () => {
    const token = ($("#tokLic")?.value || "").trim();
    const err = $("#errLic");
    const ok = $("#okLic");
    const btn = $("#btnActivarLic");
    if (err) { err.hidden = true; err.textContent = ""; }
    if (ok) { ok.hidden = true; ok.textContent = ""; }
    if (!token) {
      if (err) { err.textContent = "Pega el texto completo de la licencia."; err.hidden = false; }
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = "Activando…"; }
    try {
      const r = await post("/api/licencia/activar", { token });
      if (ok) {
        ok.textContent = r.expira
          ? `Licencia activada · válida hasta ${r.expira}${r.cliente ? " · " + r.cliente : ""}`
          : "Licencia activada correctamente.";
        ok.hidden = false;
      }
      aviso("Licencia activada");
      setTimeout(() => iniciar(), 600);
    } catch (e) {
      if (err) { err.textContent = e.message || "Licencia no válida"; err.hidden = false; }
      else aviso(e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Activar licencia"; }
    }
  },
  conectar: conectarServidor,
  probarDiag: () => window.__probarDiag && window.__probarDiag(),
  cerrarModal: () => cerrarModal(),
  cambiarServidor: () => { LS.set("servidor", ""); S.base = ""; pantallaServidor(); },
  cambiarDb: () => pantallaDb("", {}),
  seguirDb: () => iniciar(),
  olvidePin,
  selUsuario: (el) => { loginSel = Number(el.dataset.id); pantallaLogin(); },
  tecla: (el) => teclaPin(el.dataset.v),
  menuYo: () => abrirModal(`<div class="dialogo"><h3>${e(S.yo.nombre)}</h3>${etRol(S.yo.rol)}<button class="btn sec" data-act="cambiarMiPin">Cambiar mi PIN</button><button class="btn" data-act="salir">Salir</button></div>`),
  cambiarMiPin: () => { cerrarModal(); cambiarMiPin(); },
  salir: () => { cerrarModal(); salir(); },
  invSub: (el) => { S.invSub = el.dataset.v; vista(); },
  abcClase: (el) => { S.abcClase = el.dataset.v; vista(true); },
  perSub: (el) => { S.perSub = el.dataset.v; vista(); },
  ventasSub: (el) => { S.ventas.sub = el.dataset.v; S.ventas.pagina = 1; vista(); },
  prodSub: (el) => { S.prod.sub = el.dataset.v; S.prod.pagina = 1; vista(); },
  eqSub: (el) => { S.eqSub = el.dataset.v; vista(); },
  prodTx: (el) => abrirProdTx(el.dataset.id, 1),
  prodTxPag: (el) => abrirProdTx(el.dataset.id, Number(el.dataset.n) || 1),
  verEventos: (el) => { S.ev = { tipo: el.dataset.tipo, usuario: el.dataset.u, nombre: el.dataset.nombre, pagina: 1 }; S.perSub = "eventos"; vista(); },
  quitarUsuarioEv: () => { S.ev.usuario = ""; S.ev.pagina = 1; vista(true); },
  ponerPin: (el) => ponerPin(el.dataset.id, el.dataset.nombre),
  quitarPin: async (el) => { if (!confirm(`¿Quitar el PIN de ${el.dataset.nombre}? No podrá entrar hasta que le pongas otro.`)) return; try { await post("/api/ajustes/quitar-pin", { id: el.dataset.id }); aviso("PIN quitado"); vista(true); } catch (err) { aviso(err.message); } },
  csvVentas: async () => {
    try {
      const d = await get("/api/ventas", paramsPeriodo({ q: S.ventas.q, todo: 1 }));
      await descargarCSV(`ventas-${S.periodo}.csv`, [["Fecha", "Ticket", "Cajero", "Socio", "Total"], ...d.filas.map((t) => [t.fecha, t.ticket, t.cajero, t.socio, t.total])]);
    } catch (err) { aviso(err.message); }
  },
  csvCompras: () => descargarCSV("compras-sugeridas.csv", [["Producto", "Clase", "Stock", "Venta diaria", "Pedir", "Costo estimado"], ...(S.comprasCsv || []).map((x) => [x.nombre, x.clase, x.stock, x.diaria.toFixed(2), x.pedir, x.estimado ?? ""])]),
  importArqueoAjustes: async () => {
    const inp = document.getElementById("arqueoFile");
    if (!inp?.files?.length) { aviso("Elige el JSON exportado desde Arqueo Stock"); return; }
    try {
      const txt = await inp.files[0].text();
      const data = JSON.parse(txt);
      const body = Array.isArray(data) ? { items: data } : data.productos ? { items: data.productos } : data;
      const r = await post("/api/fisico?modo=ajustes", body);
      const box = document.getElementById("fisicoRes");
      if (!box) return;
      box.innerHTML = `<p class="aviso-caja">${e(r.mensaje || "")}</p>
        <div class="kpis"><div class="kpi"><span>Ajustes</span><b class="num">${fmt((r.filas||[]).length,0)}</b></div>
          <div class="kpi"><span>Valor faltante</span><b class="num">${cup(r.resumen?.valorFaltante||0)}</b></div>
          <div class="kpi"><span>Valor sobrante</span><b class="num">${cup(r.resumen?.valorSobrante||0)}</b></div></div>
        <div class="scroll"><table><tr><th>Producto</th><th class="d">Sistema</th><th class="d">Físico</th><th class="d">Dif.</th><th>Acción sugerida</th></tr>
        ${(r.filas||[]).map((x)=>`<tr><td>${e(x.nombre)}<small>${e(x.codigo)}</small></td><td class="d num">${fmt(x.sistema,1)}</td><td class="d num">${fmt(x.fisico,1)}</td>
          <td class="d num">${x.diferencia>0?"+":""}${fmt(x.diferencia,1)}</td><td>${e(x.accion)}<small>${e(x.tipoAxis)}</small></td></tr>`).join("")}
        </table></div>
        <button class="link" data-act="printVista">Imprimir / PDF</button>`;
      S.fisicoCsv = r.filas;
    } catch (err) { aviso(err.message || "No se pudo leer el archivo"); }
  },
  importArqueo: async () => {
    const inp = document.getElementById("arqueoFile");
    if (!inp?.files?.length) { aviso("Elige el JSON exportado desde Arqueo Stock"); return; }
    try {
      const txt = await inp.files[0].text();
      const data = JSON.parse(txt);
      const body = Array.isArray(data) ? { items: data } : data.productos ? { items: data.productos } : data;
      const r = await post("/api/fisico", body);
      const box = document.getElementById("fisicoRes");
      if (!box) return;
      const s = r.resumen;
      box.innerHTML = `<div class="kpis" style="margin-top:12px">
        <div class="kpi"><span>Comparados</span><b class="num">${fmt(s.comparados, 0)}</b></div>
        <div class="kpi"><span>OK</span><b class="num">${fmt(s.ok, 0)}</b></div>
        <div class="kpi"><span>Faltante</span><b class="num" style="color:var(--rojo)">${fmt(s.faltante, 0)}</b><small>${cup(s.valorFaltante)}</small></div>
        <div class="kpi"><span>Sobrante</span><b class="num" style="color:var(--verde)">${fmt(s.sobrante, 0)}</b><small>${cup(s.valorSobrante)}</small></div>
      </div>
      <div class="scroll"><table><tr><th>Producto</th><th class="d">Sistema</th><th class="d">Físico</th><th class="d">Dif.</th><th class="d">Valor</th></tr>
      ${r.filas.map((x) => `<tr><td>${e(x.nombre)}<small>${e(x.codigo)}</small></td><td class="d num">${fmt(x.sistema, 1)}</td><td class="d num">${fmt(x.fisico, 1)}</td>
        <td class="d num" style="color:${x.estado === "faltante" ? "var(--rojo)" : x.estado === "sobrante" ? "var(--verde)" : "inherit"}">${x.diferencia > 0 ? "+" : ""}${fmt(x.diferencia, 1)}</td>
        <td class="d num">${cup(x.valor)}</td></tr>`).join("")}
      </table></div>
      <button class="link" data-act="csvFisico">Exportar CSV</button>`;
      S.fisicoCsv = r.filas;
    } catch (err) { aviso(err.message || "No se pudo leer el archivo"); }
  },
  csvFisico: () => descargarCSV("inventario-fisico.csv", [["Producto", "Código", "Sistema", "Físico", "Diferencia", "Valor"], ...(S.fisicoCsv || []).map((x) => [x.nombre, x.codigo, x.sistema, x.fisico, x.diferencia, x.valor])]),
};

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-act]");
  if (el && ACC[el.dataset.act]) ACC[el.dataset.act](el, ev);
});

let tEntrada;
const ENT = {
  buscaVentas: (el) => { S.ventas.q = el.value; S.ventas.pagina = 1; listaVentas(); },
  buscaProd: (el) => { S.prod.q = el.value; S.prod.pagina = 1; recargarProd(); },
  famProd: (el) => { S.prod.familia = el.value; S.prod.pagina = 1; recargarProd(); },
  ordenProd: (el) => { S.prod.orden = el.value; S.prod.pagina = 1; recargarProd(); },
  activosProd: (el) => { S.prod.activos = el.checked; S.prod.pagina = 1; recargarProd(); },
  buscaExis: (el) => {
    S.exis.q = el.value; S.exis.pagina = 1;
    if (S.vista === "inventario" && S.invSub === "ipv") vista(true);
    else recargarExis();
  },
  localExis: (el) => {
    S.exis.local = el.value; S.exis.pagina = 1;
    if (S.vista === "inventario" && S.invSub === "ipv") vista(true);
    else recargarExis();
  },
  tipoEv: (el) => { S.ev.tipo = el.value; S.ev.pagina = 1; vista(true); },
  rolUsuario: async (el) => { try { await post("/api/ajustes/rol", { id: el.dataset.id, rol: el.value }); aviso("Rol cambiado"); } catch (err) { aviso(err.message); vista(true); } },
};
const manejarEntrada = (ev) => {
  const el = ev.target.closest("[data-in]");
  if (!el || !ENT[el.dataset.in]) return;
  const ahora = ev.type === "change" || el.tagName === "SELECT" || el.type === "checkbox";
  if (ev.type === "input" && ahora) return;
  clearTimeout(tEntrada);
  if (ahora) ENT[el.dataset.in](el); else tEntrada = setTimeout(() => ENT[el.dataset.in](el), 300);
};
document.addEventListener("input", manejarEntrada);
document.addEventListener("change", manejarEntrada);
document.addEventListener("click", () => { if ("Notification" in window && Notification.permission === "default" && S.yo) Notification.requestPermission(); }, { once: true });

iniciar();
