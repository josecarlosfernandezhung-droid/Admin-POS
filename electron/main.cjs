const { app, BrowserWindow, dialog, safeStorage, Tray, Menu, nativeImage, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { networkInterfaces } = require("node:os");

// Una sola instancia: si ya corre en bandeja, al abrir de nuevo se muestra la ventana
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let tray = null;
let puerto = 3000;
let saliendo = false;

function ipsLan() {
  try {
    return Object.values(networkInterfaces())
      .flat()
      .filter((i) => i && i.family === "IPv4" && !i.internal)
      .map((i) => i.address);
  } catch {
    return [];
  }
}

function urlLocal() {
  return `http://localhost:${puerto}`;
}

function urlsMovil() {
  return ipsLan().map((ip) => `http://${ip}:${puerto}`);
}

function icono() {
  const p = path.join(__dirname, "..", "build", "icon.png");
  try {
    return nativeImage.createFromPath(p);
  } catch {
    return nativeImage.createEmpty();
  }
}

function crearTray() {
  if (tray) return;
  tray = new Tray(icono());
  tray.setToolTip("Admin POS — servidor activo");
  const menu = Menu.buildFromTemplate([
    {
      label: "Abrir panel",
      click: () => mostrarVentana(),
    },
    {
      label: "Abrir en el navegador",
      click: () => shell.openExternal(urlLocal()),
    },
    { type: "separator" },
    {
      label: `Servidor: puerto ${puerto}`,
      enabled: false,
    },
    ...urlsMovil().map((u) => ({
      label: `Móvil: ${u}`,
      click: () => shell.openExternal(u),
    })),
    { type: "separator" },
    {
      label: "Iniciar con Windows",
      type: "checkbox",
      checked: !!app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          openAsHidden: true,
          path: process.execPath,
          args: ["--hidden"],
        });
      },
    },
    { type: "separator" },
    {
      label: "Salir (apaga el servidor)",
      click: () => {
        saliendo = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("double-click", () => mostrarVentana());
}

function mostrarVentana() {
  if (!win) {
    win = new BrowserWindow({
      width: 1100,
      height: 760,
      autoHideMenuBar: true,
      title: "Admin POS",
      icon: path.join(__dirname, "..", "build", "icon.png"),
      show: false,
    });
    win.loadURL(urlLocal());
    win.on("close", (e) => {
      // Cerrar la ventana NO apaga el servidor: queda en la bandeja
      if (!saliendo) {
        e.preventDefault();
        win.hide();
      }
    });
    win.once("ready-to-show", () => {
      if (!process.argv.includes("--hidden")) win.show();
    });
  } else {
    win.show();
    win.focus();
  }
}

async function arrancarServidor() {
  const { iniciar } = await import(pathToFileURL(path.join(__dirname, "..", "server", "server.mjs")).href);
  const cifra = safeStorage.isEncryptionAvailable();
  puerto = await iniciar(3000, {
    dir: app.getPath("userData"),
    cifrar: cifra ? (t) => safeStorage.encryptString(t).toString("base64") : undefined,
    descifrar: cifra ? (t) => safeStorage.decryptString(Buffer.from(t, "base64")) : undefined,
    empaquetado: app.isPackaged,
    estricto: app.isPackaged,
  });
  return puerto;
}

app.whenReady().then(async () => {
  try {
    await arrancarServidor();
  } catch (e) {
    dialog.showErrorBox(
      "Admin POS",
      e && e.code === "EADDRINUSE"
        ? "El puerto 3000 ya está en uso. Cierra otra copia del panel (o el proceso en bandeja) y vuelve a intentarlo."
        : String((e && e.message) || e)
    );
    app.quit();
    return;
  }
  crearTray();
  // Si arranca con Windows (--hidden), solo bandeja; si no, muestra la ventana
  if (!process.argv.includes("--hidden")) {
    mostrarVentana();
  }
});

app.on("second-instance", () => {
  mostrarVentana();
});

// No salir al cerrar todas las ventanas: el servidor sigue en bandeja
app.on("window-all-closed", (e) => {
  if (!saliendo) {
    /* seguir vivo en bandeja */
  }
});

app.on("before-quit", () => {
  saliendo = true;
});
