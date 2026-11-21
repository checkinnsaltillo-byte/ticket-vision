/* Catálogo de indicadores INEGI (BIE/BISE) para Data Lab. Lee ecolab-datos.js (el más reciente de los que se le pasan) y escribe datalab-inegi.js
   con la MISMA estructura que datalab-indicadores.js (categoría › enfoque › indicador › variables › transformaciones) y las fuentes que alimentan.
   Uso: node extrae_inegi.js salida.js datos1.js [datos2.js …] */
const fs = require("fs"), vm = require("vm");
const [, , salida, ...rutas] = process.argv;
let D = null;
rutas.forEach(r => { try { const w = {}; vm.runInNewContext(fs.readFileSync(r, "utf8"), { window: w }); const d = w.ECO_DATA; if (d && d.indicadores && (!D || String(d.generado) > String(D.generado))) D = d; } catch (_) { } });
if (!D) { console.error("extrae_inegi: sin datos de EconoLab"); process.exit(1); }
const MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const per = t => { const [a, m] = String(t).split("/"); return /^\d+$/.test(m || "") && m.length <= 2 ? (D.__trim ? "" : "") + a + "-" + m : a + "/" + (m || ""); };
const perL = (t, frec) => { const [a, m] = String(t).split("/"); return frec === "Trimestral" ? "T" + (+m) + " " + a : MES[(+m || 1) - 1] + " " + a; };
const AREAS = { "Precios e inflación": ["💲", "Inflación y precios al consumidor."], "Actividad económica": ["📈", "Producción: IGAE, actividad industrial y PIB trimestral."], "Empleo y salarios": ["👷", "Ocupación, desocupación, informalidad y remuneraciones."], "Confianza y expectativas": ["🧭", "Encuestas de confianza del consumidor y opinión empresarial."], "Industria": ["🏭", "Pedidos manufactureros y capacidad instalada."], "Comercio exterior": ["🚢", "Balanza comercial, exportaciones e importaciones."], "Consumo y ventas": ["🛍️", "Ventas de vehículos y consumo."], "Turismo": ["🏖️", "Visitantes internacionales."], "Ciclo económico (INEGI)": ["🔄", "Sistema de Indicadores Cíclicos y series de tendencia-ciclo."] };
const slug = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const tipoDe = t => t === "idx" ? "Índice" : t === "yoy" || t === "tc" || t === "ciclo" || t === "der" ? "Dato calculado" : "Dato duro";
const formula = (t, frec) => t === "yoy" ? "Δ% anual = (xₜ ÷ xₜ₋" + (frec === "Trimestral" ? "₄" : "₁₂") + " − 1) · 100  (la publica el INEGI ya calculada)" : t === "tc" ? "Tendencia-ciclo = componente de tendencia y ciclo de la serie desestacionalizada (método del INEGI)" : t === "ciclo" ? "Ciclo = desviación de la serie respecto de su tendencia; 100 = tendencia (método del INEGI, Sistema de Indicadores Cíclicos)" : t === "idx" ? "Índice = (valor del periodo ÷ valor del periodo base) · 100  (lo publica el INEGI)" : "Sin fórmula: dato directo de la fuente.";
const trans = (t, frec) => { const o = []; if (t !== "yoy" && t !== "tc" && t !== "ciclo") o.push({ n: "Variación anual y vs. periodo previo", d: "EconoLab las calcula a partir de la misma serie para graficarlas junto al nivel.", f: "Δ% = (xₜ ÷ xₜ₋ₚ − 1) · 100, p = " + (frec === "Trimestral" ? "4 trimestres / 1 trimestre" : "12 meses / 1 mes") }); o.push({ n: "Suavizado (opcional)", d: "Se puede ver la serie con LOESS o media móvil; la serie original no se modifica.", f: "LOESS (ventana local) · media móvil de 1 año" }); return o; };
const FUENTES = new Map(), IND = [];
const fk = f => String(f || "INEGI").replace(/\s*\d{4}\.?$/, "").replace(/\.$/, "").trim();
const regFuente = (f, area, scope) => { const k = fk(f); let e = FUENTES.get(k); if (!e) FUENTES.set(k, e = { n: k, a: new Set(), s: new Set(), c: 0 }); e.a.add(area); e.s.add(scope); e.c++; return k; };
const enf = {}, add = (ar, ico, d, i) => { (enf[ar] = enf[ar] || { id: "inegi_" + slug(ar), ico, n: ar, d, ind: [] }).ind.push(i); };
// nacional
D.indicadores.forEach(r => {
  const first = r.obs[0], last = r.obs[r.obs.length - 1], fz = fk(r.fuente), u = (r.unidad || "") + (r.mult ? " (" + r.mult.toLowerCase() + ")" : "");
  const n = r.grupo && !new RegExp("^" + r.nombre.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(r.grupo) ? r.grupo + " · " + r.nombre : r.nombre;
  regFuente(r.fuente, r.area, "Nacional");
  add(r.area, (AREAS[r.area] || ["📊"])[0], (AREAS[r.area] || [0, ""])[1], {
    id: "inegi_" + r.id, n, tipo: tipoDe(r.tipo), d: (r.descripcion || r.nombre) + (r.nota ? ". " + r.nota : "") + ".", u: u || "—",
    m: "Serie «" + r.nombre + "» (id " + r.id + " del Banco de Indicadores) de: " + fz + ". Periodicidad " + (r.frecuencia || "").toLowerCase() + "; datos de " + perL(first[0], r.frecuencia) + " a " + perL(last[0], r.frecuencia) + " (" + r.obs.length + " observaciones); última actualización en la fuente: " + (r.actualizado || "—") + ". Se descarga con la API del INEGI (BIE/BISE) y EconoLab la actualiza cada mes." + (r.tema ? " Tema INEGI: " + r.tema + "." : ""),
    f: formula(r.tipo, r.frecuencia),
    vars: [{ n: r.nombre, d: r.descripcion || "Serie publicada por el INEGI.", u: u || "—", f: fz + " · API BIE/BISE · id " + r.id, cob: "Nacional · " + perL(first[0], r.frecuencia) + " a " + perL(last[0], r.frecuencia), tr: trans(r.tipo, r.frecuencia) }],
    x: { a: "Nacional", g: "i:" + r.id, ge: r.grupo }
  });
});
// estatal y ciudades
const emite = (E, ambito, area, ico, desc, cobTxt) => E.forEach(e => {
  const ks = Object.keys(e.est || {}); let a = "9999", b = "0000", mx = 0; ks.forEach(k => { const o = e.est[k]; if (o && o.length) { mx = Math.max(mx, o.length); if (o[0][0] < a) a = o[0][0]; const l = o[o.length - 1][0]; if (l > b) b = l; } });
  const propia = e.id === "der", fz = propia ? "Cálculo propio de EconoLab sobre series de la ENOE" : "INEGI · " + (e.tema || "Banco de Indicadores");
  regFuente(propia ? "INEGI. Encuesta Nacional de Ocupación y Empleo (ENOE)" : "INEGI · Banco de Indicadores (BIE/BISE) · series " + ambito.toLowerCase(), area, ambito);
  add(area, ico, desc, {
    id: "inegi_" + ambito.slice(0, 3).toLowerCase() + "_" + e.clave, n: e.nombre, tipo: propia ? "Dato calculado" : tipoDe(e.tipo === "tasa" || e.tipo === "abs" ? "" : e.tipo), d: (e.descripcion || e.nombre) + ".", u: e.unidad || "—",
    m: propia ? "Indicador derivado: " + (e.descripcion || e.nombre) + ". EconoLab lo calcula con series de la ENOE publicadas por el INEGI (BIE/BISE) para cada ciudad. " : "Serie «" + e.nombre + "» (id " + e.id + " del Banco de Indicadores) por " + (ambito === "Estados" ? "entidad federativa" : "ciudad") + ". Periodicidad " + (e.frecuencia || "").toLowerCase() + "; " + ks.length + " " + (ambito === "Estados" ? "entidades" : "ciudades") + ", de " + perL(a, e.frecuencia) + " a " + perL(b, e.frecuencia) + "; última actualización en la fuente: " + (e.actualizado || "—") + ". Se descarga con la API del INEGI (BIE/BISE) y EconoLab la actualiza cada mes.",
    f: propia ? (e.descripcion || "Razón entre series de la ENOE") : formula(e.tipo === "tasa" || e.tipo === "abs" ? "" : e.tipo, e.frecuencia),
    vars: [{ n: e.nombre, d: e.descripcion || "Serie publicada por el INEGI.", u: e.unidad || "—", f: fz + (propia ? "" : " · API BIE/BISE · id " + e.id), cob: ks.length + " " + (ambito === "Estados" ? "entidades" : "ciudades") + " · " + perL(a, e.frecuencia) + " a " + perL(b, e.frecuencia), tr: trans(e.tipo === "tasa" || e.tipo === "abs" ? "" : e.tipo, e.frecuencia) }],
    x: { a: ambito, g: ambito === "Estados" ? "reg" : "ciu" }
  });
});
emite(D.estatal || [], "Estados", "Estados (por entidad federativa)", "🗺️", "Actividad económica, industria, manufacturas, desocupación y ITAEE por sector, para las 32 entidades.", "32 entidades");
emite(D.ciudad || [], "Ciudades", "Ciudades (ENOE)", "🏙️", "Mercado laboral de las 39 ciudades que cubre la ENOE.", "39 ciudades");
const ORDEN = Object.keys(AREAS).concat(["Estados (por entidad federativa)", "Ciudades (ENOE)"]);
const an = ORDEN.map(k => enf[k]).filter(Boolean).concat(Object.keys(enf).filter(k => !ORDEN.includes(k)).map(k => enf[k]));
const CAT = { id: "inegi", ico: "🇲🇽", n: "Economía y estadística oficial (INEGI)", d: "Series del Banco de Indicadores del INEGI (BIE/BISE) que alimentan EconoLab: nacional, por estado y por ciudad.", an };
const fuentes = [...FUENTES.values()].map((f, i) => ({
  id: "inegi_api_" + slug(f.n).slice(0, 40), cat: "eco", n: f.n, p: "INEGI", t: "Pública", a: "Gratuita (requiere token de la API)", m: "API del Banco de Indicadores (BIE/BISE)", e: "Activa",
  ob: "Dar seguimiento a la coyuntura económica: " + [...f.a].join(", ").toLowerCase() + ".", ind: [...f.a].map(x => x.replace(/ \(.*\)$/, "") + " (EconoLab)"), cob: [...f.s].join(" · ") + " · " + f.c + " series",
  act: "Mensual: Cloud Scheduler corre el día 28 y publica solo si hay datos nuevos (generado " + String(D.generado).slice(0, 10) + ")", alm: "Sitio publicado · ecolab-datos.js (copia de las series)", lic: "Libre uso INEGI, citando la fuente", url: "https://www.inegi.org.mx/servicios/api_indicadores.html", nota: "Se consulta con la API en la ruta /app/api/indicadores/desarrolladores/jsonxml/INDICATOR/<id>/…/BIE-BISE/2.0/<token>."
}));
const NOTICIAS = [
  { id: "noticias_gdelt", cat: "noticias", n: "GDELT · noticias del mundo (DOC 2.0)", p: "The GDELT Project", t: "Pública", a: "Gratuita", m: "API (1 consulta cada 5 s)", e: "Parcial", ob: "Monitoreo masivo de noticias en cualquier idioma y país: título, medio, fecha e imagen.", ind: ["Media Lab"], cob: "Mundial · últimos ~3 meses", act: "Continua (cada 15 min)", alm: "Cloud Storage · medialab/<proyecto>/noticias.json", lic: "Uso libre citando la fuente", url: "https://www.gdeltproject.org/", nota: "Desde el servidor puede rechazar las consultas por límite; Media Lab cambia solo a Google Noticias." },
  { id: "noticias_grss", cat: "noticias", n: "Google Noticias · RSS de búsqueda", p: "Google", t: "Pública", a: "Gratuita (uso no comercial)", m: "RSS", e: "Activa", ob: "Notas recientes por término: título, medio y fecha.", ind: ["Media Lab"], cob: "México · hasta 100 notas por consulta", act: "Continua", alm: "Cloud Storage · medialab/<proyecto>/noticias.json", lic: "Términos de Google Noticias (no comercial)", url: "https://news.google.com/", nota: "Sin texto ni categorías; el texto se descarga de cada medio." },
  { id: "noticias_newsdata", cat: "noticias", n: "NewsData.io · API de noticias", p: "NewsData.io", t: "Privada", a: "De pago (plan por volumen)", m: "API", e: "Propuesto", ob: "Noticias con categorías, descripción y texto según el plan.", ind: ["Media Lab"], cob: "Mundial", act: "Continua", alm: "Cloud Storage · medialab/<proyecto>/noticias.json", lic: "Según contrato", url: "https://newsdata.io/", nota: "Requiere la variable NEWSDATA_API_KEY en el servidor." },
  { id: "noticias_gnews", cat: "noticias", n: "GNews · API de noticias", p: "GNews", t: "Privada", a: "De pago económico", m: "API", e: "Propuesto", ob: "Noticias con título, descripción, imagen y filtros por fecha, país e idioma.", ind: ["Media Lab"], cob: "Mundial", act: "Continua", alm: "Cloud Storage · medialab/<proyecto>/noticias.json", lic: "Según contrato", url: "https://gnews.io/", nota: "Requiere la variable GNEWS_API_KEY en el servidor." }
];
const salidaJs = "/* Indicadores y fuentes del INEGI (BIE/BISE) para Data Lab. Generado por extrae_inegi.js a partir de ecolab-datos.js; no editar a mano. */\n" +
  "(function(){var W=window;W.DL_INDICADORES=(W.DL_INDICADORES||[]).concat([" + JSON.stringify(CAT) + "]);W.DL_CATS=(W.DL_CATS||[]).concat([{k:'eco',n:'Economía y estadística oficial',ic:'🇲🇽',d:'Series del INEGI (BIE/BISE) para el monitoreo económico'},{k:'noticias',n:'Noticias y medios',ic:'📰',d:'Servicios de noticias que alimentan Media Lab'}]);W.DL_FUENTES=(W.DL_FUENTES||[]).concat(" + JSON.stringify(fuentes.concat(NOTICIAS)) + ");})();\n";
fs.writeFileSync(salida, salidaJs);
console.log("datalab-inegi: " + an.reduce((a, e) => a + e.ind.length, 0) + " indicadores en " + an.length + " enfoques · " + fuentes.length + " fuentes · datos " + String(D.generado).slice(0, 10));
