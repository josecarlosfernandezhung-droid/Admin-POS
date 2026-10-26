const { app, BrowserWindow, dialog, safeStorage } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

if (!app.requestSingleInstanceLock()) app.quit();

async function crearVentana() {
  let puerto;
  try {
    const { iniciar } = await import(
      pathToFileURL(path.join(__dirname, "..", "server", "server.mjs")).href
    );
    // La contraseña de MariaDB se guarda cifrada con el sistema (Windows DPAPI) en la carpeta de datos del programa.
    const cifra = safeStorage.isEncryptionAvailable();
    puerto = await iniciar(3000, {
      dir: app.getPath("userData"),
      cifrar: cifra ? (t) => safeStorage.encryptString(t).toString("base64") : undefined,
      descifrar: cifra ? (t) => safeStorage.decryptString(Buffer.from(t, "base64")) : undefined,
    });
  } catch (e) {
    dialog.showErrorBox(
      "Admin POS",
      e && e.code === "EADDRINUSE"
        ? "El puerto 3000 ya está en uso. Cierra otra copia del panel y vuelve a abrirlo."
        : String((e && e.message) || e)
    );
    app.quit();
    return;
  }
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    autoHideMenuBar: true,
    title: "Admin POS",
    icon: path.join(__dirname, "..", "build", "icon.png"),
  });
  win.loadURL(`http://localhost:${puerto}`);
}

app.whenReady().then(crearVentana);
app.on("window-all-closed", () => app.quit());
