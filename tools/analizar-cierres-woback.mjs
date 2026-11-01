#!/usr/bin/env node
/** Compara DiffClose Axis vs esperado = open + cashbook − retiro */
import { readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const file = process.argv[2];
const tol = Number(process.argv[3] || 500);
if (!file || !existsSync(file)) {
  console.error("Uso: node tools/analizar-cierres-woback.mjs archivo.woback [tol]");
  process.exit(1);
}
const raw = readFileSync(file);
const text = raw[0] === 0x1f ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
const g = (b, k) => {
  const x = b.match(new RegExp(`<${k}>([^<]*)</${k}>`));
  return x ? x[1] : null;
};
const shifts = [];
for (const m of text.matchAll(/<shift>(.*?)<\/shift>/gs)) {
  const b = m[1];
  shifts.push({
    id: g(b, "ID"),
    open: Number(g(b, "TotalOpen") || 0),
    final: Number(g(b, "TotalFinal") || 0),
    wd: Number(g(b, "TotalWithdrawal") || 0),
    dif: Number(g(b, "DiffClose") || 0),
    when: g(b, "DateTimeOpen"),
  });
}
const libro = new Map();
for (const m of text.matchAll(/<cashbook>(.*?)<\/cashbook>/gs)) {
  const b = m[1];
  const sid = g(b, "ShiftID");
  if (!sid) continue;
  const profit = Number(g(b, "Profit") || 0);
  const sign = Number(g(b, "Sign") || 0);
  if (!libro.has(sid)) libro.set(sid, 0);
  libro.set(sid, libro.get(sid) + sign * profit);
}
let match = 0, miss = 0;
const fails = [];
for (const s of shifts) {
  const cb = libro.get(s.id) || 0;
  const esperado = s.open + cb - s.wd;
  const difCalc = esperado - s.final;
  if (Math.abs(difCalc - s.dif) < 1) match++;
  else {
    miss++;
    if (fails.length < 10)
      fails.push({ id: s.id, when: s.when, axis: s.dif, calc: difCalc, esperado, final: s.final, cb });
  }
}
console.log(`Turnos ${shifts.length} | coinciden con Axis ${match} | no ${miss}`);
console.log(`|DiffClose|>${tol}: ${shifts.filter((s) => Math.abs(s.dif) > tol).length}`);
if (fails.length) {
  console.log("Ejemplos que no coinciden:");
  fails.forEach((f) => console.log(f));
}
