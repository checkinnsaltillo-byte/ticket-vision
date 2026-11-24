#!/usr/bin/env node
/* Biblioteca de indicadores de Model Lab → modelab-biblioteca.js
   Toma de datalab.js las definiciones de la malla nacional (MX_D y ML_D) y deja solo los indicadores que existen por AGEB en el servidor (se pueden consultar por coordenada):
   { k: "enfoque:id", n: nombre, u: unidad, s: clave que entiende /geometrika/modelab/tabla, e: enfoque, c: categoría, g: grupo, cat: true si es categórico }. */
const fs = require("fs"), vm = require("vm"), path = require("path");
const dir = __dirname, src = fs.readFileSync(path.join(dir, "datalab.js"), "utf8");
const win = {}; vm.runInNewContext(fs.readFileSync(path.join(dir, "datalab-indicadores.js"), "utf8"), { window: win });
const CATI = win.DL_INDICADORES, a0 = src.indexOf("const MX_G = ["), a1 = src.indexOf("  CATI.forEach(c => c.an.forEach(e => e.ind.forEach(i => prep(i, c, e))));");
const d0 = src.indexOf("  const ML_D = (() =>"), d1 = src.indexOf("  const ML_NIV = {");
if (a0 < 0 || a1 < a0 || d0 < 0 || d1 < d0) { console.error("extrae_biblioteca: no se encontraron los bloques MX_D / ML_D en datalab.js"); process.exit(1); }
const ctx = { CATI, out: null }; vm.createContext(ctx);
vm.runInContext(src.slice(a0, a1) + "\n" + src.slice(d0, d1) + "\nout = ML_D;", ctx);
const nom = {}; CATI.forEach(c => (c.an || []).forEach(e => { nom[e.id] = [e.n, c.n]; }));
const lista = [];
for (const [k, d] of Object.entries(ctx.out)) {
  const s = d.t === "mg" ? d.s : d.t === "ag" ? d.v : d.t === "wc" ? (d.v === "cons" ? "sk" : "sv") : null; if (!s) continue;
  const [e, c] = nom[k.split(":")[0]] || ["", ""]; lista.push({ k, n: d.n, u: d.u || "", s, e, c, cat: !!d.cat });
}
/* indicadores socioeconómicos por AGEB que no vienen de las definiciones de Data Lab: índice NSE, ingreso del hogar (ENIGH) y su nivel */
[{ k: "dem:nsei", n: "Índice de nivel socioeconómico (NSE)", u: "índice", s: "nsei" }, { k: "dem:ingn", n: "Nivel de ingreso del hogar (1 a 5)", u: "nivel", s: "ingn" }, { k: "dem:ing", n: "Ingreso mensual típico del hogar", u: "MXN/mes", s: "ing" }].forEach(x => { if (!lista.some(y => y.k === x.k)) lista.push(Object.assign({ e: "Demografía", c: "Entorno socioeconómico", cat: false }, x)); });
lista.sort((x, y) => x.c.localeCompare(y.c) || x.e.localeCompare(y.e) || x.k.localeCompare(y.k));
fs.writeFileSync(path.join(dir, "modelab-biblioteca.js"), "/* Biblioteca de indicadores de Model Lab (generada por extrae_biblioteca.js; no editar a mano). */\nwindow.MO_BIBLIO = " + JSON.stringify(lista) + ";\n");
fs.writeFileSync(path.join(dir, "..", "files", "biblioteca.json"), JSON.stringify(lista));
console.log("modelab-biblioteca: " + lista.length + " indicadores consultables por coordenada");
