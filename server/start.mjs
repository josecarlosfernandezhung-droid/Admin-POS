import { iniciar } from "./server.mjs";
const puerto = await iniciar(Number(process.env.PORT) || 3000);
console.log(`Panel AxisPOS listo en http://localhost:${puerto}`);
