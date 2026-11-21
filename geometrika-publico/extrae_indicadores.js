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
  // indicadores que se agregan llamando a una función auxiliar, p. ej. ent.push(ice('viv', 'vivienda'), ice('rc', 'renta corta')): se deja un marcador para respetar el orden
  if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && n.callee.property.name === "push" && n.callee.object.type === "Identifier" && n.arguments.length && n.arguments.every(a => a.type === "CallExpression" && a.callee.type === "Identifier" && a.callee.name !== "euCov"))
    n.arguments.forEach(a => (arrays[n.callee.object.name] = arrays[n.callee.object.name] || []).push({ __pend: a }));
  if (n.type === "VariableDeclarator" && n.id.name === "AN" && n.init && n.init.type === "ObjectExpression") AN = n.init;
  if (n.type === "ReturnStatement" && n.argument) { let X = n.argument; while (X.type === "CallExpression" && (X.callee.name === "bxAnota" || X.callee.name === "igIntegra") && X.arguments[0]) X = X.arguments[0]; const A = X;   // return [...] o return igIntegra([...])
    if (A && A.type === "ArrayExpression" && A.elements[0] && A.elements[0].type === "ObjectExpression" && prop(A.elements[0], "an")) RET = A; }
  for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === "string") walk(v); }
})(ast);
if (!AN || !RET) throw new Error("no se halló AN o el return");
const enf = {}; AN.properties.forEach(p => { const o = p.value, arr = prop(o, "ind"); enf[p.key.name] = { id: str(prop(o, "id")), ico: str(prop(o, "ico")), n: str(prop(o, "n")), d: str(prop(o, "d")), ind: arrays[arr.name] || [] }; });
// Categorías cuyo «an» no es una lista literal de AN.x (MediaLab, EconoLab): los enfoques se arman con variables, .map() y funciones auxiliares (I0, eInd…).
// Se resuelven de forma estática: sin proyecto, sin giro y sin ciudad elegidos; lo que depende de datos queda fuera del texto.
const decl = {}; ast.body[0].expression.body.body.forEach(s => { if (s.type === "VariableDeclaration") s.declarations.forEach(d => { if (d.id.type === "Identifier" && d.init && !(d.id.name in decl)) decl[d.id.name] = d.init; }); });
function evL(n, env, prof) {   // evaluación tolerante de textos: sustituye parámetros, sigue constantes y descarta los trozos dinámicos
  if (!n || (prof = prof || 0) > 12) return undefined;
  if (n.type === "Literal") return n.value;
  if (n.type === "Identifier") { if (env && n.name in env) return evL(env[n.name].n, env[n.name].env, prof + 1); return decl[n.name] ? evL(decl[n.name], null, prof + 1) : undefined; }
  if (n.type === "TemplateLiteral") { let s = ""; n.quasis.forEach((q, k) => { s += q.value.cooked; if (n.expressions[k]) { const v = evL(n.expressions[k], env, prof + 1); s += v === undefined ? "…" : v; } }); return s; }
  if (n.type === "BinaryExpression" && n.operator === "+") { const a = evL(n.left, env, prof + 1), b = evL(n.right, env, prof + 1); return (a === undefined && b === undefined) ? undefined : (a === undefined ? "" : a) + (b === undefined ? "" : b); }
  if (n.type === "BinaryExpression" && ["===", "==", "!==", "!="].includes(n.operator)) { const a = evL(n.left, env, prof + 1), b = evL(n.right, env, prof + 1); return a === undefined || b === undefined ? undefined : (n.operator[0] === "!" ? a !== b : a === b); }
  if (n.type === "LogicalExpression" && n.operator === "||") { const a = evL(n.left, env, prof + 1); return a === undefined || a === "" ? evL(n.right, env, prof + 1) : a; }
  if (n.type === "ConditionalExpression") { const c = evL(n.consequent, env, prof + 1), a = evL(n.alternate, env, prof + 1), tv = n.test.type === "BinaryExpression" ? evL(n.test, env, prof + 1) : undefined; if (typeof tv === "boolean") return tv ? c : a; return n.test.type === "Identifier" ? (a !== undefined ? a : c) : (c !== undefined ? c : a); }   // «x ? … : …» con x = dato aún no elegido → rama sin dato
  return undefined;
}
const strL = (n, env) => { const v = evL(n, env); if (v === undefined) { dinam++; return "…"; } return String(v).replace(/\s+/g, " ").replace(/\bde el\b/g, "del").trim(); };
const propL = (o, k, env) => { const p = o.properties.find(p => p.key && (p.key.name === k || p.key.value === k)); return p ? strL(p.value, env) : ""; };
function varsL(vp, env) { const o = []; if (vp && vp.type === "ArrayExpression") vp.elements.forEach(e => { if (e && e.type === "CallExpression" && e.callee.name === "V") { const A = e.arguments, tr = []; if (A[5] && A[5].type === "ArrayExpression") A[5].elements.forEach(x => { if (x && x.type === "CallExpression" && x.callee.name === "T") tr.push({ n: strL(x.arguments[0], env), d: strL(x.arguments[1], env), f: strL(x.arguments[2], env) }); }); o.push({ n: strL(A[0], env), d: strL(A[1], env), u: strL(A[2], env), f: strL(A[3], env), tr }); } }); return o; }
function indDe(n, env, prof) {   // indicador a partir de un objeto literal o de una llamada a una función auxiliar que termina devolviéndolo
  if (!n || (prof = prof || 0) > 8) return null;
  if (n.type === "ObjectExpression") return prop(n, "id") ? { id: propL(n, "id", env), n: propL(n, "n", env), tipo: propL(n, "tipo", env), d: propL(n, "d", env), u: propL(n, "u", env), m: propL(n, "m", env), f: propL(n, "f", env), vars: varsL(prop(n, "vars"), env) } : null;
  if (n.type === "CallExpression" && n.callee.type === "Identifier") { const fn = decl[n.callee.name]; if (!fn || fn.type !== "ArrowFunctionExpression" || fn.body.type === "BlockStatement") return null;
    const e2 = {}; fn.params.forEach((p, k) => { if (p.type === "Identifier") e2[p.name] = { n: n.arguments[k] || null, env }; }); const r = indDe(fn.body, e2, prof + 1);
    // serie de EconoLab de la que sale el dato (ecNac = nacional, ecEst = por estado, ecLoc = por ciudad): Data Lab la usa para la vista previa
    if (r) n.arguments.forEach(a => { const t = a && a.type === "CallExpression" && a.callee.type === "Identifier" && { ecNac: "nac", ecEst: "est", ecLoc: "ciu" }[a.callee.name]; if (t && a.arguments[0] && a.arguments[0].type === "Literal") r.s = [t, String(a.arguments[0].value)]; });
    return r; }
  return null;
}
function indsDe(n, env, prof) {   // lista de indicadores; null si no se puede resolver sin datos
  if (!n || (prof = prof || 0) > 8) return null;
  if (n.type === "Identifier") { const d = decl[n.name], L = d ? indsDe(d, env, prof + 1) : null; return arrays[n.name] && arrays[n.name].length ? (L || []).concat(arrays[n.name]) : L; }
  if (n.type === "ConditionalExpression") { const c = indsDe(n.consequent, env, prof + 1), a = indsDe(n.alternate, env, prof + 1); return !c ? a : !a ? c : (a.length > c.length ? a : c); }   // la rama con más indicadores (la otra suele ser el aviso «sin datos»)
  if (n.type === "ArrayExpression") { const L = []; n.elements.forEach(e => { if (!e) return; if (e.type === "SpreadElement") (indsDe(e.argument, env, prof + 1) || []).forEach(x => L.push(x)); else { const i = indDe(e, env); if (i) L.push(i); } }); return L; }
  return null;
}
function enfDe(n, prof) {   // enfoques de una categoría: AN.x, objeto literal, variable, lista o lista.map(() => ({…}))
  if (!n || (prof = prof || 0) > 8) return [];
  if (n.type === "MemberExpression" && n.object.type === "Identifier" && n.object.name === "AN") { const e = enf[n.property.name]; if (!e) throw new Error("enfoque desconocido: AN." + n.property.name); return [e]; }
  if (n.type === "ObjectExpression" && prop(n, "ind")) return [{ id: propL(n, "id"), ico: propL(n, "ico"), n: propL(n, "n"), d: propL(n, "d"), ind: indsDe(prop(n, "ind")) || [] }];
  if (n.type === "Identifier" && decl[n.name]) return enfDe(decl[n.name], prof + 1);
  if (n.type === "SpreadElement") return enfDe(n.argument, prof + 1);
  if (n.type === "ArrayExpression") return n.elements.reduce((L, e) => L.concat(enfDe(e, prof + 1)), []);
  if (n.type === "ConditionalExpression") { const c = enfDe(n.consequent, prof + 1), a = enfDe(n.alternate, prof + 1); return a.length > c.length ? a : c; }
  if (n.type === "CallExpression" && n.callee.type === "MemberExpression" && n.callee.property.name === "map" && n.arguments[0] && n.arguments[0].type === "ArrowFunctionExpression") return enfDe(n.arguments[0].body, prof + 1);   // un enfoque por elemento (p. ej. por proyecto): se documenta uno genérico
  return [];
}
Object.keys(arrays).forEach(k => { const L = arrays[k], R = L.map(x => x && x.__pend ? indDe(x.__pend, null) : x).filter(Boolean); L.splice(0, L.length, ...R); });   /* en su lugar: los enfoques ya apuntan a estas listas */
const cats = RET.elements.map(c => { const id = str(prop(c, "id")), an = enfDe(prop(c, "an")); if (!an.length) throw new Error("categoría «" + id + "» sin enfoques reconocibles: revisar la forma de su «an»"); return { id, ico: str(prop(c, "ico")), n: str(prop(c, "n")), d: str(prop(c, "d")), an }; });
const nInd = cats.reduce((a, c) => a + c.an.reduce((b, e) => b + e.ind.length, 0), 0), sinVars = [];
cats.forEach(c => c.an.forEach(e => e.ind.forEach(i => { if (!i.vars.length) sinVars.push(i.id); })));
console.log("categorías", cats.length, "· enfoques", cats.reduce((a, c) => a + c.an.length, 0), "· indicadores", nInd, "· sin variables:", sinVars.join(",") || "ninguno", "· textos dinámicos:", dinam);
const ciu = {}; try { const m = txt.match(/const ECO_CIU = (\[\[[\s\S]*?\]\]);/); if (m) JSON.parse(m[1]).forEach(c => { ciu[c[0]] = c[1]; }); } catch (_) { }
const nArr = Object.values(arrays).reduce((a, l) => a + l.length, 0); console.log("indicadores hallados en push:", nArr);
fs.writeFileSync(out, "/* Catálogo de indicadores de Geo Lab (sin datos). Generado por extrae_indicadores.js a partir de maqueta/entorno.html; no editar a mano. */\nwindow.DL_INDICADORES = " + JSON.stringify(cats, null, 0) + ";\n/* ciudades con datos de empleo (ENOE): clave → nombre */\nwindow.DL_ECO_CIU = " + JSON.stringify(ciu) + ";\n");
