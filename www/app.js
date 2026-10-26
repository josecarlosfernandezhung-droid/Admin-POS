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
const S = { base: "", token: "", yo: null, periodo: "30", desde: "", hasta: "", vista: "resumen", estado: null, conteos: {}, tk: 0,
  ventas: { q: "", pagina: 1, sub: "tickets" }, prod: { q: "", familia: "", orden: "vendidos", activos: true, pagina: 1, sub: "lista" }, exis: { q: "", local: "", pagina: 1 },
  cajaPag: 1, invSub: "alertas", abcClase: "A", perSub: "auditoria", ev: { tipo: "cancel", usuario: "", nombre: "", pagina: 1 }, pagCb: null };

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
  centro(`${logoCaja}<h1>Admin POS</h1><p class="sub">Escribe la dirección de la PC de la tienda</p>
    <label class="campo">Dirección de la PC<input id="servidor" inputmode="url" placeholder="http://192.168.1.10:3000" value="${e(LS.get("servidor"))}"></label>
    <p class="error" id="err" ${msg ? "" : "hidden"}>${e(msg || "")}</p>
    <button class="btn" data-act="conectar">Conectar</button>
    <p class="muted" style="text-align:center;font-size:.84rem;margin:0">La dirección aparece en la pantalla de inicio del programa en la PC.</p>`);
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
  if (!est.dbConfigurada) return pantallaDb();
  if (est.dbError) return pantallaDbError();
  if (!est.pinsConfigurados) return pantallaPinInicial();
  const t = SS.get("token");
  if (t && !msg) { S.token = t; try { S.yo = await get("/api/yo"); return entrarApp(); } catch { S.token = ""; SS.del("token"); } }
  pantallaLogin(msg);
}

// ---------- Estructura principal ----------
const SECCIONES = [["resumen", "Resumen"], ["ventas", "Ventas"], ["productos", "Productos"], ["existencias", "Existencias"], ["caja", "Caja"], ["equipo", "Equipo"], ["inventario", "Inventario"], ["perdidas", "Pérdidas"], ["ajustes", "Ajustes"]];
const SIN_PERIODO = ["inventario", "ajustes"];
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
      <div class="periodo" id="periodo">${[["7", "7 días"], ["30", "30 días"], ["90", "90 días"], ["todo", "Todo"], ["custom", "Fechas"]].map(([v, n]) => `<button data-act="periodo" data-v="${v}">${n}</button>`).join("")}
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
      ${[0, 0.5, 1].map((f) => { const v = (max / 1.08) * f; return `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e3dccf"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#6f685f">${compacto(v)}</text>`; }).join("")}
      <path d="M${x(0)},${y(0)} L${pts.join(" L")} L${x(dias.length - 1)},${y(0)} Z" fill="#b8602f" opacity=".14"/>
      <polyline points="${pts.join(" ")}" fill="none" stroke="#b8602f" stroke-width="2.4" stroke-linejoin="round"/>
      ${etq.map((i) => `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === dias.length - 1 ? "end" : "middle"}" font-size="11" fill="#6f685f">${diaCorto(dias[i].dia)}</text>`).join("")}</svg></div>`;
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
  const color = "#b8602f";
  const grid = "#e3dccf";
  const txt = "#6f685f";
  const tipFmt = (v) => cup(v);

  const cDias = document.getElementById("chart-dias");
  if (cDias && d.porDia && d.porDia.length > 1) {
    chartsActivos.dias = new Chart(cDias, {
      type: "line",
      data: {
        labels: d.porDia.map((x) => diaCorto(x.dia)),
        datasets: [{ label: "Ventas", data: d.porDia.map((x) => x.total), borderColor: color, backgroundColor: "rgba(184,96,47,.15)", fill: true, tension: 0.25, pointRadius: 3, pointHoverRadius: 6 }],
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
      data: { labels, datasets: [{ label: "Ventas", data: vals, backgroundColor: color, borderRadius: 4 }] },
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
      data: { labels, datasets: [{ label: "Promedio por día", data: vals, backgroundColor: color, borderRadius: 4 }] },
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
  const d = await get("/api/resumen", paramsPeriodo());
  if (!aqui(tk)) return;
  const solo = S.yo.rol === "cajero";
  const pico = d.porHora.reduce((m, x) => (!m || x.total > m.total ? x : m), null);
  const tr = d.tiempoReal;
  const vc = (v, txt) => (v == null ? `<div class="v muted">${txt}</div>` : `<div class="v ${claseVar(v)}">${v >= 0 ? "▲" : "▼"} ${signo(v)} ${txt}</div>`);
  const maxFam = Math.max(1, ...d.familias.map((f) => f.total));
  $("#contenido").innerHTML = `${cab(solo ? "Tus ventas" : "Cómo va la tienda", `${rangoTxt(d)}. Importes de las ventas registradas en AxisPOS, en CUP.`)}
    <div class="tarjeta hero"><div class="etq">${solo ? "Tus ventas del período" : "Ventas del período"}</div>
      <div class="grande num">${cup(d.total)}</div>
      <div class="muted">Neto ${cup(d.neto)} tras devoluciones · unos ${fmt(d.neto / d.tasa, 0)} US$ a ${fmt(d.tasa, 0)} CUP</div>
      ${d.anterior ? `<span class="chip ${claseVar(d.anterior.variacion)}">${d.anterior.variacion == null ? "Sin datos del período anterior" : signo(d.anterior.variacion) + " frente al período anterior"}</span>` : ""}
      <div class="mini"><div><span>Tickets</span><b class="num">${fmt(d.tickets, 0)}</b></div><div><span>Promedio</span><b class="num">${compacto(d.promedio)}</b></div>
        <div><span>Devoluciones</span><b class="num">${compacto(d.devoluciones)}</b><small>${d.devDocs} docs.</small></div></div></div>
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
    <div class="tarjeta"><h3>Familias</h3>${d.familias.map((f) => hbar(f.familia, f.total, maxFam, compacto(f.total))).join("") || '<p class="muted">Sin datos</p>'}</div>
    ${solo ? "" : `<div class="tarjeta"><h3>Cajeros</h3>${d.cajeros.map((c) => `<div class="fila"><div>${e(c.nombre)}<small>${ROL[c.rol] || ""}</small></div><div class="d num">${compacto(c.total)} · ${fmt(c.tickets, 0)}</div></div>`).join("") || '<p class="muted">Sin datos</p>'}</div>`}
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
  const tabs = subTabs([["lista", "Catálogo"], ["top", "Top productos"]], S.prod.sub, "prodSub");
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
  const etDif = (t) => (t.diferencia == null ? '<span class="etiqueta et-gris">Sin cierre</span>' : `<span class="etiqueta et-${t.nivel === "alta" ? "alta" : t.nivel === "media" ? "media" : "ok"}">${t.diferencia > 0 ? "+" : ""}${fmt(t.diferencia, 0)}</span>`);
  $("#contenido").innerHTML = `${cab("Caja", "Conciliación de cada turno: lo que el sistema vendió contra lo que se contó al cerrar.")}
    <div class="kpis"><div class="kpi"><span>Ventas</span><b class="num">${cup(d.ventas)}</b></div><div class="kpi"><span>Devoluciones</span><b class="num">${cup(d.devoluciones)}</b></div><div class="kpi"><span>Neto</span><b class="num">${cup(d.neto)}</b></div>
      <div class="kpi"><span>Turnos</span><b class="num">${d.turnos}</b><small>${d.conDiferencia} con diferencia mayor a ${fmt(d.tolerancia, 0)} CUP</small></div></div>
    ${d.conDiferencia ? `<div class="tarjeta"><h3>Auditoría de cierres</h3><div class="rt"><div><span>Faltante acumulado</span><b class="num" style="color:var(--rojo)">${cup(d.faltante)}</b></div><div><span>Sobrante acumulado</span><b class="num" style="color:var(--verde)">${cup(d.sobrante)}</b></div><div><span>Turnos sin cuadrar con cobros</span><b class="num">${d.sinCuadrar}</b></div></div>
      <details style="margin-top:10px"><summary class="muted" style="cursor:pointer;font-size:.86rem">¿Por qué puede haber diferencias grandes?</summary>
      <p class="muted" style="margin:8px 0 0;font-size:.86rem">
        <b>Esperado</b> = fondo inicial + ventas del turno − devoluciones − retiros.<br>
        <b>Diferencia</b> = dinero contado al cierre − esperado (negativo = faltante, positivo = sobrante).<br>
        Diferencias grandes suelen deberse a: fondo inicial mal registrado, retiros no apuntados, ventas de otro turno contadas aquí, o contado de caja que incluye otras formas de pago. El histórico por cajero (abajo) ayuda a ver si se concentra en alguien. «Sin cuadrar con cobros» compara ventas del sistema vs pagos registrados (efectivo/tarjeta/transferencia).
      </p></details></div>` : ""}
    ${(d.porCajero && d.porCajero.length) ? `<div class="tarjeta"><h3>Histórico de diferencias por cajero</h3>
      <p class="muted" style="margin:-4px 0 10px;font-size:.86rem">Cruce automático entre el dinero contado al cierre y las ventas teóricas del turno (efectivo + tarjetas + transferencias). Útil para auditorías internas.</p>
      <div class="scroll"><table><tr><th>Cajero</th><th class="d">Turnos</th><th class="d">Con dif.</th><th class="d">Faltante</th><th class="d">Sobrante</th><th class="d">Neto</th><th class="d">Máx. faltante</th></tr>
      ${d.porCajero.map((c) => `<tr><td>${e(c.usuario)}</td><td class="d num">${c.turnos}</td><td class="d num">${c.conDif}</td>
        <td class="d num" style="color:${c.faltante < 0 ? "var(--rojo)" : "inherit"}">${c.faltante ? cup(c.faltante) : "—"}</td>
        <td class="d num" style="color:${c.sobrante > 0 ? "var(--verde)" : "inherit"}">${c.sobrante ? cup(c.sobrante) : "—"}</td>
        <td class="d num">${cup(c.totalDif)}</td>
        <td class="d num">${c.maxFaltante < 0 ? cup(c.maxFaltante) : "—"}</td></tr>`).join("")}</table></div></div>` : ""}
    <div class="tarjeta"><h3>Cobros por forma de pago</h3>${d.formasPago.map((f) => `<div class="fila"><div>${e(f.socio)}<small>${fmt(f.tickets, 0)} tickets</small></div><div class="d num">${cup(f.total)}</div></div>`).join("") || '<p class="muted">Sin datos</p>'}</div>
    <div class="tarjeta"><h3>Turnos</h3><p class="muted" style="margin:-4px 0 10px;font-size:.86rem">Esperado = fondo inicial + ventas − devoluciones − retiros. Diferencia = contado − esperado (negativo = faltante). «Cobros» compara las ventas con los pagos registrados.</p>
      <div class="scroll"><table><tr><th>Apertura</th><th>Cierre</th><th>Quién abrió</th><th class="d">Ventas</th><th class="d">Contado</th><th class="d">Diferencia</th><th class="d">Cobros</th></tr>
      ${d.filas.map((t) => `<tr><td class="num">${fechaHora(t.apertura)}</td><td class="num">${fechaHora(t.cierre)}</td><td>${e(t.usuario || "")}</td><td class="d num">${cup(t.ventas)}</td><td class="d num">${t.contado ? cup(t.contado) : "—"}</td><td class="d">${etDif(t)}</td><td class="d">${t.ventas > 0 ? (Math.abs(t.difPagos) <= 1 ? '<span class="etiqueta et-ok">Cuadra</span>' : `<span class="etiqueta et-media">${fmt(t.difPagos, 0)}</span>`) : "—"}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">Sin turnos en el período</td></tr>'}</table></div>${pager(d.pagina, d.paginas)}</div>`;
};

vistas.equipo = async () => {
  const tk = S.tk;
  const d = await get("/api/equipo", paramsPeriodo());
  if (!aqui(tk)) return;
  $("#contenido").innerHTML = `${cab("Equipo", "Quién cobró y a nombre de qué socio quedó la venta.")}
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
  const tabs = subTabs([["alertas", "Alertas de stock"], ["abc", "Análisis ABC"], ["compras", "Compras sugeridas"]], S.invSub, "invSub");
  let cuerpo = "";
  if (S.invSub === "alertas") {
    const d = await get("/api/alertas");
    cuerpo = `<div class="kpis"><div class="kpi"><span>Agotados que se vendían</span><b class="num">${d.resumen.agotados}</b></div><div class="kpi"><span>Bajo el mínimo</span><b class="num">${d.resumen.minimo}</b></div><div class="kpi"><span>Por reponer</span><b class="num">${d.resumen.reorden}</b></div></div>
      <div class="tarjeta"><h3>Productos en alerta <small>${d.total} en total</small></h3><p class="muted" style="margin:-4px 0 8px;font-size:.84rem">Se calcula con las ventas de los últimos ${d.ventana} días. Punto de reposición = venta diaria × (${d.plazo} días de entrega + ${d.seguridad} de seguridad). Puedes cambiar estos números en Ajustes.</p>
      ${d.filas.map((x) => `<div class="fila"><div>${e(x.nombre)}<small>${e(x.familia)}${x.clase !== "-" ? " · clase " + x.clase : ""}${x.minimo > 0 ? " · mínimo " + fmt(x.minimo, 0) : ""}</small></div>
        <div class="d"><span class="etiqueta et-${x.tipo}">${TIPO_ALERTA[x.tipo]}</span><small>Stock ${fmt(x.stock, 1)} · vende ${fmt(x.diaria, 1)}/día${x.cobertura != null ? ` · alcanza ${fmt(x.cobertura, 1)} d` : ""}</small></div></div>`).join("") || '<p class="muted">No hay productos en alerta. Todo en orden.</p>'}</div>`;
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
  if (aqui(tk)) $("#contenido").innerHTML = `${cab("Inventario", "")}${tabs}${cuerpo}`;
};

// ---------- Pérdidas ----------
const TIPOS_EV = [["cancel", "Cancelaciones"], ["anular", "Anulaciones"], ["elim", "Líneas quitadas"], ["desc", "Descuentos"], ["login", "Accesos fallidos"], ["cajon", "Cajón abierto"]];
vistas.perdidas = async () => {
  const tk = S.tk;
  const tabs = subTabs([["auditoria", "Auditoría"], ["alertas", "Alertas"], ["mermas", "Mermas"], ["eventos", "Eventos"]], S.perSub, "perSub");
  let cuerpo = "";
  if (S.perSub === "auditoria") {
    const d = await get("/api/auditoria", paramsPeriodo());
    if (!aqui(tk)) return;
    const nv = (n) => (n === "alta" ? "alta" : n === "media" ? "media" : "ok");
    cuerpo = `
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
      ${campo("descMax", "Descuento manual alto (%)", "Desde este % se marca")}${campo("tolCierre", "Diferencia de caja tolerada (CUP)", "Más que esto se marca")}</div>
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
    S.ventas.pagina = S.prod.pagina = S.exis.pagina = S.cajaPag = S.ev.pagina = 1;
    marcarNav();
    if (S.periodo === "custom") {
      // No recargar hasta que elijan fechas y pulsen Ver
      if (!S.desde || !S.hasta) return;
    }
    vista();
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
  conectar: conectarServidor,
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
  buscaExis: (el) => { S.exis.q = el.value; S.exis.pagina = 1; recargarExis(); },
  localExis: (el) => { S.exis.local = el.value; S.exis.pagina = 1; recargarExis(); },
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
