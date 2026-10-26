# Admin POS (versión unificada)

Una sola app, dos versiones: **APK (Android)** y **Admin-POS.exe (Windows)**. Lee la base MariaDB de AxisPOS (solo lectura).

Esta versión combina **todas** las características de las dos aplicaciones anteriores y añade mejoras:

## Características

- **Resumen** completo (7/30/90 días/Todo, tiempo real, comparativos, ritmo del día, más vendido, familias, cajeros, últimos tickets)
- **Gráficos interactivos** (Chart.js): ventas por día, por hora y promedio por día de la semana con tooltips
- **Ventas** (buscador, tickets, CSV)
- **Productos** y **Existencias** por local
- **Caja** (cierres: esperado vs contado, cobros)
- **Detección de faltantes y sobrantes**: cruce automático del dinero contado con las ventas teóricas y **histórico de diferencias por cajero** para auditorías
- **Equipo** (ventas por vendedor, devoluciones, socios)
- **Inventario** (alertas, ABC, compras sugeridas)
- **Pérdidas / Control** (alertas de caja, mermas, eventos, anomalías)
- **Ajustes** (PIN, roles, conexión, umbrales)
- **Cifrado de la contraseña de MariaDB** con Windows DPAPI (safeStorage de Electron)
- **PIN de emergencia**: si se olvida el PIN del administrador, se puede restablecer con la contraseña de MariaDB

## Primera vez (en la PC de la tienda)
1. Abre Admin-POS.exe. Escribe **una sola vez** el usuario y la contraseña de MariaDB (usuario de solo lectura). Quedan guardados cifrados en esta PC.
2. Elige al administrador de AxisPOS y crea su PIN (4 a 8 números).
3. En **Ajustes** pon el PIN de cada usuario y su rol. Sin PIN no se entra.

## En el teléfono
Instala la APK, escribe la dirección que ves en la PC (ej. http://192.168.1.10:3000) y entra con tu PIN. La PC debe estar encendida y en el mismo WiFi.

## Roles
- **Administrador:** todo, incluido Ajustes (PIN, roles, conexión, umbrales).
- **Gerente:** todo menos Ajustes.
- **Cajero:** solo sus propias ventas, turnos y tickets; consulta precios y existencias (sin costos).
El rol sugerido sale del nivel del usuario en AxisPOS (3 = administrador, 2 = gerente, otro = cajero) y se puede cambiar.

## Compilar en GitHub
1. Sube todos los archivos al repositorio (debe existir `.github/workflows/build.yml`).
2. **Actions → Compilar Admin POS → Run workflow**.
3. Descarga en *Artifacts*: `Admin-POS-android` (APK) y `Admin-POS-windows` (Admin-POS.exe).

## Notas
- Si Windows pregunta por el Firewall, permite el acceso en redes privadas.
- ¿Olvidaste el PIN del administrador? En la PC, pantalla de PIN → «Olvidé el PIN del administrador» (pide la contraseña de MariaDB).
- Los datos de conexión y los PIN (cifrados con hash) se guardan en la carpeta privada de Windows del programa.
- Solo lee datos (consultas SELECT), no modifica nada.
- Funciona completamente sin internet (gráficos incluidos localmente). Solo necesita red local WiFi entre la PC y el teléfono.
