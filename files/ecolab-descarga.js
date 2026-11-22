#!/usr/bin/env node
// EcoLab · descarga de indicadores del Banco de Indicadores del INEGI (BIE/BISE) → ecolab-datos.js
// Uso (a mano):  INEGI_TOKEN=xxxx node files/ecolab-descarga.js   → escribe geometrika-publico/ecolab-datos.js
// En producción lo llama server.js (POST /internal/ecolab-actualizar, Cloud Scheduler mensual) y publica el resultado en GitHub.
// El token se obtiene gratis en https://www.inegi.org.mx/app/desarrolladores/generatoken/Usuarios/token_Verify.aspx
// La jerarquía (Área > Grupo > Indicador) se edita en CFG; el resto (frecuencia, unidad, tema, fuente,
// última actualización, periodos) viene de la propia API. Para periodicidad: correr este script con un cron
// (p. ej. Cloud Scheduler → Cloud Run) y publicar el archivo generado.
const fs = require("fs"), path = require("path");
let TOKEN = process.env.INEGI_TOKEN || "";
const B = "https://www.inegi.org.mx/app/api/indicadores/desarrolladores/jsonxml";

// [área, grupo, [[id, nombre corto, (opc.) nota]...]]
const CFG = [
  ["Precios e inflación", "Índice Nacional de Precios al Consumidor", [
    ["910392", "INPC general (índice)"], ["910399", "Inflación mensual"], ["910406", "Inflación anual"], ["334452", "INPC subyacente (índice)"]]],
  ["Actividad económica", "Indicador Global de la Actividad Económica (IGAE)", [
    ["737121", "IGAE total (índice de volumen físico)"], ["737145", "IGAE total · variación anual"]]],
  ["Actividad económica", "Actividad industrial", [
    ["736407", "Actividad industrial total (índice)"], ["736526", "Actividad industrial · variación anual"]]],
  ["Actividad económica", "Producto Interno Bruto trimestral", [
    ["737371", "PIB trimestral (pesos de 2018)"], ["737374", "PIB trimestral · variación anual"]]],
  ["Empleo y salarios", "Mercado laboral (ENOE)", [
    ["444603", "Tasa de desocupación"], ["444602", "Tasa de participación"], ["444610", "Tasa de informalidad laboral (TIL1)"]]],
  ["Confianza y expectativas", "Confianza del consumidor", [["454168", "Indicador de confianza del consumidor"]]],
  ["Confianza y expectativas", "Índice global (EMOE)", [
    ["701401", "Confianza empresarial global"], ["701400", "Tendencia empresarial global"]]],
  ["Confianza y expectativas", "Confianza por sector", [
    ["701570", "Industrias manufactureras"], ["701407", "Construcción"], ["701826", "Comercio (mayoreo y menudeo)"],
    ["701975", "Servicios privados no financieros"]]],
  ["Confianza y expectativas", "Tendencia por sector", [
    ["701490", "Industrias manufactureras"], ["701402", "Construcción"], ["701820", "Comercio (mayoreo y menudeo)"],
    ["701940", "Servicios privados no financieros"]]],
  ["Industria", "Pedidos manufactureros", [
    ["701618", "Total manufacturas"], ["701619", "Alimentos, bebidas y tabaco"], ["701620", "Petróleo, química y plástico"],
    ["701621", "Minerales no metálicos y metálicas básicas"], ["701622", "Computación, electrónicos y eléctricos"],
    ["701623", "Equipo de transporte"], ["701624", "Productos metálicos, maquinaria y muebles"], ["701625", "Textiles, prendas, madera y papel"]]],
  ["Industria", "Capacidad instalada", [["710380", "Capacidad de planta utilizada"]]],
  ["Comercio exterior", "Saldo de la balanza comercial", [["6204198542", "Balanza comercial de mercancías"]]],
  ["Comercio exterior", "Exportaciones", [
    ["6204198547", "Exportaciones totales"], ["6204198561", "Exportaciones no petroleras"], ["6204198556", "Exportaciones petroleras"]]],
  ["Comercio exterior", "Importaciones", [
    ["6204198549", "Importaciones totales"], ["6204198564", "Importaciones no petroleras"], ["6204198559", "Importaciones petroleras"]]],
  ["Empleo y salarios", "Personal ocupado", [
    ["702094", "Personal ocupado total"], ["702095", "Personal dependiente"], ["702096", "Personal subcontratado"]]],
  ["Empleo y salarios", "Remuneraciones", [
    ["702100", "Remuneraciones totales"], ["702102", "Remuneraciones medias reales"]]],
  ["Consumo y ventas", "Vehículos", [
    ["6207131346", "Ventas de vehículos ligeros"], ["6207131348", "Variación anual de ventas de ligeros"], ["6207131351", "Ventas al menudeo de vehículos pesados"]]],
  ["Turismo", "Visitantes internacionales", [
    ["6207123161", "Visitantes internacionales que ingresan al país"], ["6207123162", "Gasto de los visitantes internacionales"]]],
];

// ── Clasificación sectorial (propuesta): 3 grandes sectores › 10 sectores-monitor › subsectores SCIAN ──
// IGAE por sector (nacional, mensual): índice 737122-737144, variación anual 737146-737168 (mismo orden)
const IGAE_S = [["Actividades primarias", "agro", "11"], ["Agricultura", "agro", "111"], ["Cría y explotación de animales", "agro", "112"],
  ["Actividades secundarias", "", "T2"], ["Minería", "mineria_energia", "21"], ["Energía eléctrica, agua y gas", "mineria_energia", "22"], ["Construcción", "construccion", "23"],
  ["Industrias manufactureras", "manufacturas", "31-33"], ["Actividades terciarias", "", "T3"], ["Comercio al por mayor", "comercio", "43"], ["Comercio al por menor", "comercio", "46"],
  ["Transportes, correos y almacenamiento", "transporte_info", "48-49"], ["Información en medios masivos", "transporte_info", "51"],
  ["Servicios financieros y de seguros", "finanzas_inmob", "52"], ["Servicios inmobiliarios y de alquiler", "finanzas_inmob", "53"],
  ["Servicios profesionales, científicos y técnicos", "servicios_neg", "54"], ["Apoyo a los negocios y manejo de residuos", "servicios_neg", "56"],
  ["Servicios educativos", "social", "61"], ["Servicios de salud y asistencia social", "social", "62"], ["Esparcimiento, culturales y deportivos", "turismo", "71"],
  ["Alojamiento temporal y preparación de alimentos", "turismo", "72"], ["Otros servicios (excepto gobierno)", "social", "81"], ["Actividades gubernamentales y legislativas", "social", "93"]];
CFG.push(["Actividad económica", "IGAE por sector · índice de volumen físico", IGAE_S.map((x, i) => [String(737122 + i), x[0], x[1], x[2], "idx"])]);
CFG.push(["Actividad económica", "IGAE por sector · variación anual", IGAE_S.map((x, i) => [String(737146 + i), x[0], x[1], x[2], "yoy"])]);

// ── Ciclo oficial del INEGI (Sistema de Indicadores Cíclicos) y tendencia-ciclo ──
// «Ciclo» = componente cíclico en puntos (100 = tendencia). Coincidente y adelantado son los indicadores compuestos.
const CICLO = [["334338", "Indicador coincidente", "Compuestos"], ["334339", "Indicador adelantado", "Compuestos"],
  ["334349", "Indicador global de la actividad económica (IGAE)"], ["334344", "Actividad industrial"], ["334354", "Construcción (volumen físico)"], ["334359", "Ingresos por suministros al por menor"], ["334441", "Actividades primarias"], ["334446", "Actividades terciarias"], ["334451", "Inversión fija bruta"],
  ["334366", "Tasa de desocupación urbana"], ["334371", "Tendencia del empleo en las manufacturas"], ["334376", "Asegurados permanentes en el IMSS"], ["334381", "Expectativa sobre el personal ocupado"],
  ["334386", "Importaciones totales"], ["334461", "Importaciones no petroleras"], ["334391", "Exportaciones totales"], ["334396", "Exportaciones petroleras"], ["334401", "Exportaciones no petroleras"], ["334406", "Precio promedio del petróleo crudo"],
  ["334411", "Tasa de interés interbancaria (TIIE)"], ["334466", "Cetes a 28 días"], ["334431", "Tasa de fondeo gubernamental"], ["334416", "Tipo de cambio nominal"], ["334421", "Tipo de cambio real (multilateral)"], ["334426", "Índice de precios y cotizaciones de la BMV"], ["334436", "Reservas internacionales"],
  ["334486", "Indicador de confianza empresarial"], ["334491", "Indicador agregado de tendencia"], ["334496", "Indicador de pedidos manufactureros"], ["334501", "Indicador de confianza del consumidor"], ["334506", "Expectativa sobre uso de planta y equipo"], ["334511", "Expectativa sobre inventarios de insumos"]];
CFG.push(["Ciclo económico (INEGI)", "Indicadores compuestos", CICLO.filter(x => x[2]).map(x => [x[0], x[1], "", "", "ciclo"])]);
CFG.push(["Ciclo económico (INEGI)", "Componentes del Sistema de Indicadores Cíclicos", CICLO.filter(x => !x[2]).map(x => [x[0], "Ciclo · " + x[1], "", "", "ciclo"])]);
// tendencia-ciclo oficial (índice) de cada sector del IGAE (bloques de 7 series desde 737217; la tendencia-ciclo es la 6.ª) y de la actividad industrial
const IGAE_TC = [["Total de la actividad económica", "TOT"], ["Actividades primarias", "11"], ["Actividades secundarias", "T2"], ["Minería", "21"], ["Energía eléctrica, agua y gas", "22"], ["Construcción", "23"], ["Industrias manufactureras", "31-33"], ["Actividades terciarias", "T3"], ["Comercio al por mayor", "43"], ["Comercio al por menor", "46"],
  ["Transportes, correos y almacenamiento", "48-49"], ["Información en medios masivos", "51"], ["Servicios financieros y de seguros", "52"], ["Servicios inmobiliarios y de alquiler", "53"], ["Servicios profesionales, científicos y técnicos", "54"], ["Apoyo a los negocios y manejo de residuos", "56"], ["Servicios educativos", "61"], ["Servicios de salud y asistencia social", "62"],
  ["Esparcimiento, culturales y deportivos", "71"], ["Alojamiento temporal y preparación de alimentos", "72"], ["Otros servicios (excepto gobierno)", "81"], ["Actividades gubernamentales y legislativas", "93"]];
CFG.push(["Ciclo económico (INEGI)", "Tendencia-ciclo del IGAE por sector", IGAE_TC.map((x, i) => [String(737217 + 7 * i + 5), x[0] + " · tendencia-ciclo", "", x[1], "tc"])]);
CFG.push(["Ciclo económico (INEGI)", "Tendencia-ciclo de la actividad industrial", [["736888", "Actividad industrial total · tendencia-ciclo", "", "AI", "tc"], ["736895", "Minería · tendencia-ciclo", "", "AI21", "tc"], ["736923", "Energía, agua y gas · tendencia-ciclo", "", "AI22", "tc"], ["736944", "Construcción · tendencia-ciclo", "", "AI23", "tc"], ["736972", "Manufacturas · tendencia-ciclo", "", "AI31", "tc"]]]);
// otros indicadores nacionales ligados a un sector
const SEC_TAG = { "701570": "manufacturas", "701490": "manufacturas", "701618": "manufacturas", "701619": "manufacturas", "701620": "manufacturas", "701621": "manufacturas", "701622": "manufacturas", "701623": "manufacturas", "701624": "manufacturas", "701625": "manufacturas", "710380": "manufacturas",
  "701407": "construccion", "701402": "construccion", "701826": "comercio", "701820": "comercio", "701975": "transporte_info,finanzas_inmob,servicios_neg,turismo", "701940": "transporte_info,finanzas_inmob,servicios_neg,turismo",
  "6204198561": "manufacturas", "6204198564": "manufacturas", "6204198556": "mineria_energia", "6204198559": "mineria_energia", "6207131346": "manufacturas,comercio", "6207131348": "manufacturas,comercio", "6207131351": "transporte_info,comercio",
  "6207123161": "turismo", "6207123162": "turismo", "736407": "mineria_energia,construccion,manufacturas", "736526": "mineria_energia,construccion,manufacturas" };
// Series estatales (área 0 = las 32 entidades): [id, clave, nombre, sector, tipo, id alterno]. El alterno (“con petróleo”) completa las 9 entidades que el INEGI publica aparte.
//   tipo: idx = índice, yoy = variación anual, tasa = porcentaje
const ESTATAL = [
  ["741927", "itaee_idx", "Actividad económica estatal (ITAEE) · índice desestacionalizado", "", "idx"], ["741929", "itaee_yoy", "Actividad económica estatal (ITAEE) · variación anual", "", "yoy"],
  ["740263", "ind_idx", "Actividad industrial estatal · índice desestacionalizado", "", "idx"], ["740265", "ind_yoy", "Actividad industrial estatal · variación anual", "", "yoy"],
  ["740711", "man_idx", "Manufacturas estatales · índice desestacionalizado", "manufacturas", "idx"], ["740713", "man_yoy", "Manufacturas estatales · variación anual (mensual)", "manufacturas", "yoy"],
  ["448335", "desoc", "Tasa de desocupación estatal (desestacionalizada)", "", "tasa"], ["741930", "itaee_tc", "Actividad económica estatal (ITAEE) · tendencia-ciclo", "", "tc"], ["740266", "ind_tc", "Actividad industrial estatal · tendencia-ciclo", "", "tc"],
  ["741291", "s_agro", "ITAEE · actividades primarias · variación anual", "agro", "yoy"], ["741364", "s_sec", "ITAEE · actividades secundarias · variación anual", "", "yoy", "741367"], ["741765", "s_ter", "ITAEE · actividades terciarias · variación anual", "", "yoy"],
  ["741446", "s_min", "ITAEE · minería · variación anual", "mineria_energia", "yoy", "741449"], ["741528", "s_ene", "ITAEE · energía eléctrica, agua y gas · variación anual", "mineria_energia", "yoy", "741531"],
  ["741610", "s_con", "ITAEE · construcción · variación anual", "construccion", "yoy", "741613"], ["741692", "s_man", "ITAEE · manufacturas · variación anual", "manufacturas", "yoy", "741695"],
  ["741829", "s_com", "ITAEE · comercio · variación anual", "comercio", "yoy"], ["778243", "s_tra", "ITAEE · transportes e información · variación anual", "transporte_info", "yoy"],
  ["778307", "s_fin", "ITAEE · servicios financieros e inmobiliarios · variación anual", "finanzas_inmob", "yoy"], ["778371", "s_neg", "ITAEE · servicios profesionales y de apoyo a negocios · variación anual", "servicios_neg", "yoy"],
  ["778435", "s_soc", "ITAEE · educación, salud y gobierno · variación anual", "social", "yoy"], ["778499", "s_tur", "ITAEE · esparcimiento, alojamiento y alimentos · variación anual", "turismo", "yoy"]];

// Series por ciudad (ENOE trimestral, 39 ciudades; área = 470000NN del catálogo CL_GEO_AREA)
const CIUDADES = ["47000001", "47000002", "47000003", "47000004", "47000005", "47000006", "47000007", "47000008", "47000009", "47000010", "47000011", "47000012", "47000013", "47000014", "47000015", "47000016", "47000017", "47000018", "47000019", "47000020",
  "47000023", "47000024", "47000026", "47000027", "47000036", "47000037", "47000038", "47000039", "47000040", "47000041", "47000043", "47000047", "47000050", "47000051", "47000052", "47000053", "47000054", "47000076", "47000077"];
const CIUDAD_S = [["447619", "c_desoc", "Tasa de desocupación (total)", "tasa"], ["447651", "c_desoc_h", "Tasa de desocupación (hombres)", "tasa"], ["447683", "c_desoc_m", "Tasa de desocupación (mujeres)", "tasa"],
  ["447154", "c_pob", "Población de 15 años y más", "abs"], ["447155", "c_pea", "Población económicamente activa (PEA)", "abs"], ["447156", "c_ocup", "Población ocupada", "abs"], ["447158", "c_subo_n", "Población subocupada", "abs"]];
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }
async function get(u) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } }); return await r.json(); }
    catch (e) { await new Promise(r => setTimeout(r, 800)); }
  }
  return null;
}
const cl = async c => { const m = {}; for (const f of ["BISE", "BIE-BISE"]) ((await get(`${B}/${c}/null/es/${f}/2.0/${TOKEN}`)) || { CODE: [] }).CODE.forEach(x => { m[x.value] = x.Description; }); return m; };   // BIE-BISE pisa a BISE
const OBS = (s, dec) => s.OBSERVATIONS.filter(o => o.OBS_VALUE != null && o.OBS_VALUE !== "").map(o => [o.TIME_PERIOD, +(+o.OBS_VALUE).toPrecision(dec || 9)]);

async function descargar(token, log) {
  TOKEN = token || TOKEN; if (!TOKEN) throw new Error("Falta INEGI_TOKEN"); log = log || (() => {});
  const [FREQ, UNIT, TOPIC, SOURCE, NOTE, IND] = await Promise.all(["CL_FREQ", "CL_UNIT", "CL_TOPIC", "CL_SOURCE", "CL_NOTE", "CL_INDICATOR"].map(cl));
  const out = { generado: new Date().toISOString(), fuente: "INEGI · API del Banco de Indicadores (BIE/BISE)", indicadores: [] }, faltan = [];
  // 1) nacionales
  const items = CFG.flatMap(([area, grupo, lista]) => lista.map(x => [area, grupo, ...x]));
  const nac = await pool(items, 6, async ([area, grupo, id, nombre, sec, scian, tipo]) => {
    let d = await get(`${B}/INDICATOR/${id}/es/00/false/BIE-BISE/2.0/${TOKEN}?type=json`), s = d && d.Series && d.Series[0];
    if (!s) { d = await get(`${B}/INDICATOR/${id}/es/00000/false/BISE/2.0/${TOKEN}?type=json`); s = d && d.Series && d.Series[0]; }   // respaldo: conjunto BISE
    const obs = s && s.OBSERVATIONS ? OBS(s).reverse() : [];
    if (!obs.length) { faltan.push(id); return null; }
    log(".");
    return { id, area, grupo, nombre, sectores: String(SEC_TAG[id] || sec || "").split(",").filter(Boolean), scian: scian || "", tipo: tipo || "", descripcion: (IND[id] || "").trim(),
      frecuencia: FREQ[s.FREQ] || s.FREQ, unidad: (UNIT[s.UNIT] || "").trim(), mult: ({ "1": "Miles", "2": "Millones", "4": "Billones" })[s.UNIT_MULT] || "",
      tema: TOPIC[s.TOPIC] || "", fuente: String(s.SOURCE || "").split(",").map(x => SOURCE[x.trim()]).filter(Boolean).join(" · "),
      nota: NOTE[s.NOTE] || "", actualizado: (s.LASTUPDATE || "").slice(0, 10), obs };
  });
  out.indicadores = nac.filter(Boolean);
  // 2) estatales (área 0 = 32 entidades)
  const filtra = (s, est, tiene) => s.OBSERVATIONS.forEach(o => { if ((tiene && tiene.has(o.COBER_GEO)) || o.OBS_VALUE == null || o.OBS_VALUE === "" || +o.TIME_PERIOD.slice(0, 4) < 2008) return; (est[o.COBER_GEO] = est[o.COBER_GEO] || []).push([o.TIME_PERIOD, +(+o.OBS_VALUE).toFixed(3)]); });
  const est1 = await pool(ESTATAL, 4, async ([id, clave, nombre, sector, tipo, alt]) => {
    const d = await get(`${B}/INDICATOR/${id}/es/0/false/BIE-BISE/2.0/${TOKEN}?type=json`), s = d && d.Series && d.Series[0];
    if (!s || !s.OBSERVATIONS) { faltan.push("est:" + id); return null; }
    const est = {}; filtra(s, est);
    if (alt) { const d2 = await get(`${B}/INDICATOR/${alt}/es/0/false/BIE-BISE/2.0/${TOKEN}?type=json`), s2 = d2 && d2.Series && d2.Series[0]; if (s2) filtra(s2, est, new Set(Object.keys(est))); }
    Object.values(est).forEach(a => a.reverse()); log("e");
    return { id, clave, nombre, sector, tipo, descripcion: (IND[id] || "").trim(), frecuencia: FREQ[s.FREQ] || s.FREQ, unidad: (UNIT[s.UNIT] || "").trim(), tema: TOPIC[s.TOPIC] || "", actualizado: (s.LASTUPDATE || "").slice(0, 10), est };
  });
  out.estatal = est1.filter(Boolean);
  // 3) ciudades: una consulta por ciudad y serie
  out.ciudad = [];
  for (const [id, clave, nombre, tipo] of CIUDAD_S) {
    const res = await pool(CIUDADES, 6, async code => { const d = await get(`${B}/INDICATOR/${id}/es/${code}/false/BIE-BISE/2.0/${TOKEN}?type=json`), s = d && d.Series && d.Series[0]; return s && s.OBSERVATIONS ? { code, s } : null; });
    const est = {}; let meta = null;
    res.filter(Boolean).forEach(({ code, s }) => { meta = meta || s; const a = s.OBSERVATIONS.filter(o => o.OBS_VALUE != null && o.OBS_VALUE !== "" && +o.TIME_PERIOD.slice(0, 4) >= 2008).map(o => [o.TIME_PERIOD, +(+o.OBS_VALUE).toFixed(3)]).reverse(); if (a.length) est[code] = a; });
    if (!meta) { faltan.push("ciu:" + id); continue; }
    out.ciudad.push({ id, clave, nombre, tipo, frecuencia: FREQ[meta.FREQ] || meta.FREQ, unidad: (UNIT[meta.UNIT] || "").trim(), tema: TOPIC[meta.TOPIC] || "", actualizado: (meta.LASTUPDATE || "").slice(0, 10), est });
    log("c");
  }
  const C = Object.fromEntries(out.ciudad.map(x => [x.clave, x])), deriv = (clave, nombre, num, den, f) => { if (!C[num] || !C[den]) return; const est = {}; Object.keys(C[num].est).forEach(code => { const dm = Object.fromEntries((C[den].est[code] || []).map(o => [o[0], o[1]])); const a = C[num].est[code].filter(o => dm[o[0]]).map(o => [o[0], +f(o[1], dm[o[0]]).toFixed(3)]); if (a.length) est[code] = a; }); out.ciudad.push({ id: "der", clave, nombre, tipo: "tasa", frecuencia: C[num].frecuencia, unidad: "Porcentaje", tema: "Calculada", actualizado: C[num].actualizado, est }); };
  deriv("c_part", "Tasa de participación (PEA / población de 15 años y más)", "c_pea", "c_pob", (a, b) => a / b * 100);
  deriv("c_ocupr", "Tasa de ocupación (ocupados / población de 15 años y más)", "c_ocup", "c_pob", (a, b) => a / b * 100);
  deriv("c_subo", "Tasa de subocupación (subocupados / ocupados)", "c_subo_n", "c_ocup", (a, b) => a / b * 100);
  out.resumen = { nacionales: out.indicadores.length, estatales: out.estatal.length, ciudades: out.ciudad.length, faltan };
  return out;
}
const aJs = d => "window.ECO_DATA=" + JSON.stringify(d) + ";\n";
function cli() {
  descargar(process.env.INEGI_TOKEN, s => process.stdout.write(s)).then(d => {
    const r = d.resumen; console.log(`\n${r.nacionales} series nacionales; ${r.estatales} estatales, ${r.ciudades} de ciudades` + (r.faltan.length ? `; sin datos: ${r.faltan.join(", ")}` : ""));
    fs.writeFileSync(path.join(__dirname, "..", "geometrika-publico", "ecolab-datos.js"), aJs(d));
  }).catch(e => { console.error(e.message); process.exit(1); });
}
module.exports = { descargar, aJs, cli };
if (require.main === module) cli();
