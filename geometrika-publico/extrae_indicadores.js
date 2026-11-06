// Extrae el catálogo ESTÁTICO de indicadores de Geo Lab (maqueta/entorno.html → función indLista) sin datos: categorías, enfoques, indicadores, variables y transformaciones.
// Uso: node extrae_indicadores.js <entorno.html> <salida.js>
const fs = require("fs"), acorn = require(process.env.HOME + "/opt/terser/node_modules/acorn");
const [src, out] = process.argv.slice(2), txt = fs.readFileSync(src, "utf8");
const i0 = txt.indexOf("function indLista() {"), i1 = txt.indexOf("\n}\n", i0) + 3; if (i0 < 0 || i1 < i0) throw new Error("no se encontró indLista");
const ast = acorn.parse("(" + txt.slice(i0, i1).replace(/^function indLista/, "function") + ")", { ecmaVersion: 2022 });
let dinam = 0;
function ev(n) {
  if (!n) return "";
  if (n.type === "Literal") return n.value;
  if (n.type === "TemplateLiteral") { let s = ""; n.quasis.forEach((q, k) => { s += q.value.cooked; if (n.expressions[k]) { const v = ev(n.expressions[k]); s += v === undefined ? "…" : v; } }); return s; }
  if (n.type === "BinaryExpression" && n.operator === "+") { const a = ev(n.left), b = ev(n.right); return (a === undefined || b === undefined) ? undefined : a + b; }
  if (n.type === "ArrayExpression") return n.elements.map(ev);
  return undefined;
}
const str = (n) => { const v = ev(n); if (v === undefined) { dinam++; return "…"; } return String(v).replace(/\s+/g, " ").trim(); };
const prop = (o, k) => { const p = o.properties.find(p => p.key && (p.key.name === k || p.key.value === k)); return p ? p.value : null; };
const arrays = {}; let AN = null, RET = null;
(function walk(n) {
  if (!n || typeof n.type !== "string") { return; }
  // indicadores de cobertura del entorno urbano de INEGI: se generan con euCov(id, n, d, k, sub, lo, hi, nota); se expanden igual que en entorno.html
  if (n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "euCov") {
    const A = n.arguments, sub = str(A[4]), FEU = "INEGI · Censo 2020 (entorno urbano por frente de manzana)";
    (arrays.euL = arrays.euL || []).push({ id: str(A[0]), n: str(A[1]), tipo: "Dato duro", d: str(A[2]), u: "% de la longitud de vialidad", m: "Del entorno urbano del Censo 2020 por frente de manzana (INEGI) se suma la longitud de los frentes que " + sub + " y se divide entre la longitud de los frentes con dato, dentro de 500 m de la propiedad.", f: "P = L(frentes que " + sub + ") / L(frentes con dato) · 100",
      vars: [{ n: "Longitud con el elemento", d: "Metros de vialidad cuyos frentes de manzana lo tienen.", u: "m", f: FEU, tr: [{ n: "Suma por longitud", d: "Cada frente de manzana pesa por su longitud.", f: "L = Σ lᵢ" }] }, { n: "Longitud con dato", d: "Metros de vialidad cuyos frentes tienen respuesta (sí o no).", u: "m", f: FEU, tr: [] }] });
  }
  if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && n.callee.property.name === "push" && n.arguments[0] && n.arguments[0].type === "ObjectExpression" && prop(n.arguments[0], "id") && prop(n.arguments[0], "id").type === "Literal" && prop(n.arguments[0], "tipo") && n.callee.object.type === "Identifier") {
    const o = n.arguments[0], a = n.callee.object.name, vars = [], vp = prop(o, "vars");
    if (vp && vp.type === "ArrayExpression") vp.elements.forEach(e => { if (e && e.type === "CallExpression" && e.callee.name === "V") { const A = e.arguments, tr = []; if (A[5] && A[5].type === "ArrayExpression") A[5].elements.forEach(t => { if (t && t.type === "CallExpression" && t.callee.name === "T") tr.push({ n: str(t.arguments[0]), d: str(t.arguments[1]), f: str(t.arguments[2]) }); }); vars.push({ n: str(A[0]), d: str(A[1]), u: str(A[2]), f: str(A[3]), tr }); } });
    (arrays[a] = arrays[a] || []).push({ id: str(prop(o, "id")), n: str(prop(o, "n")), tipo: str(prop(o, "tipo")), d: str(prop(o, "d")), u: str(prop(o, "u")), m: str(prop(o, "m")), f: str(prop(o, "f")), vars });
  }
  if (n.type === "VariableDeclarator" && n.id.name === "AN" && n.init && n.init.type === "ObjectExpression") AN = n.init;
  if (n.type === "ReturnStatement" && n.argument && n.argument.type === "ArrayExpression" && n.argument.elements[0] && n.argument.elements[0].type === "ObjectExpression" && prop(n.argument.elements[0], "an")) RET = n.argument;
  for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === "string") walk(v); }
})(ast);
if (!AN || !RET) throw new Error("no se halló AN o el return");
const enf = {}; AN.properties.forEach(p => { const o = p.value, arr = prop(o, "ind"); enf[p.key.name] = { id: str(prop(o, "id")), ico: str(prop(o, "ico")), n: str(prop(o, "n")), d: str(prop(o, "d")), ind: arrays[arr.name] || [] }; });
const cats = RET.elements.map(c => ({ id: str(prop(c, "id")), ico: str(prop(c, "ico")), n: str(prop(c, "n")), d: str(prop(c, "d")), an: prop(c, "an").elements.map(e => enf[e.property.name]) }));
const nInd = cats.reduce((a, c) => a + c.an.reduce((b, e) => b + e.ind.length, 0), 0), sinVars = [];
cats.forEach(c => c.an.forEach(e => e.ind.forEach(i => { if (!i.vars.length) sinVars.push(i.id); })));
console.log("categorías", cats.length, "· enfoques", cats.reduce((a, c) => a + c.an.length, 0), "· indicadores", nInd, "· sin variables:", sinVars.join(",") || "ninguno", "· textos dinámicos:", dinam);
const nArr = Object.values(arrays).reduce((a, l) => a + l.length, 0); console.log("indicadores hallados en push:", nArr);
fs.writeFileSync(out, "/* Catálogo de indicadores de Geo Lab (sin datos). Generado por extrae_indicadores.js a partir de maqueta/entorno.html; no editar a mano. */\nwindow.DL_INDICADORES = " + JSON.stringify(cats, null, 0) + ";\n");
