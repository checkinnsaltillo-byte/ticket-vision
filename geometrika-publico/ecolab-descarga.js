#!/usr/bin/env node
// EcoLab · descarga de indicadores del Banco de Indicadores del INEGI (BIE/BISE) → ecolab-datos.js
// Uso:  INEGI_TOKEN=xxxx node geometrika-publico/ecolab-descarga.js
// El token se obtiene gratis en https://www.inegi.org.mx/app/desarrolladores/generatoken/Usuarios/token_Verify.aspx
// La jerarquía (Área > Grupo > Indicador) se edita en CFG; el resto (frecuencia, unidad, tema, fuente,
// última actualización, periodos) viene de la propia API. Para periodicidad: correr este script con un cron
// (p. ej. Cloud Scheduler → Cloud Run) y publicar el archivo generado.
const fs = require("fs"), path = require("path");
const TOKEN = process.env.INEGI_TOKEN;
if (!TOKEN) { console.error("Falta INEGI_TOKEN"); process.exit(1); }
const B = "https://www.inegi.org.mx/app/api/indicadores/desarrolladores/jsonxml";

// [área, grupo, [[id, nombre corto, (opc.) nota]...]]
const CFG = [
  ["Confianza empresarial", "Índice global (EMOE)", [
    ["701401", "Confianza empresarial global"], ["701400", "Tendencia empresarial global"]]],
  ["Confianza empresarial", "Confianza por sector", [
    ["701570", "Industrias manufactureras"], ["701407", "Construcción"], ["701826", "Comercio (mayoreo y menudeo)"],
    ["701975", "Servicios privados no financieros"]]],
  ["Confianza empresarial", "Tendencia por sector", [
    ["701490", "Industrias manufactureras"], ["701402", "Construcción"], ["701820", "Comercio (mayoreo y menudeo)"],
    ["701940", "Servicios privados no financieros"]]],
  ["Industria", "Pedidos manufactureros", [
    ["701618", "Total manufacturas"], ["701619", "Alimentos, bebidas y tabaco"], ["701620", "Petróleo, química y plástico"],
    ["701621", "Minerales no metálicos y metálicas básicas"], ["701622", "Computación, electrónicos y eléctricos"],
    ["701623", "Equipo de transporte"], ["701624", "Productos metálicos, maquinaria y muebles"], ["701625", "Textiles, prendas, madera y papel"]]],
  ["Industria", "Capacidad instalada", [["710380", "Capacidad de planta utilizada"]]],
  ["Industria", "Actividad industrial", [["496326", "Total de la actividad industrial"]]],
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
  ["Cuentas nacionales", "Producto y consumo", [
    ["494098", "PIB a precios de mercado (trimestral)"], ["497040", "Consumo privado (trimestral)"], ["527799", "PIB de la economía nacional (anual)"]]],
];

async function get(u) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } }); return await r.json(); }
    catch (e) { await new Promise(r => setTimeout(r, 800)); }
  }
  return null;
}
const cl = async c => Object.fromEntries(((await get(`${B}/${c}/null/es/BISE/2.0/${TOKEN}`)) || { CODE: [] }).CODE.map(x => [x.value, x.Description]));

(async () => {
  const [FREQ, UNIT, TOPIC, SOURCE, NOTE, IND] = await Promise.all(["CL_FREQ", "CL_UNIT", "CL_TOPIC", "CL_SOURCE", "CL_NOTE", "CL_INDICATOR"].map(cl));
  const out = { generado: new Date().toISOString(), fuente: "INEGI · API del Banco de Indicadores (BIE/BISE)", indicadores: [] }, faltan = [];
  for (const [area, grupo, lista] of CFG) for (const [id, nombre] of lista) {
    const d = await get(`${B}/INDICATOR/${id}/es/00000/false/BISE/2.0/${TOKEN}?type=json`);
    const s = d && d.Series && d.Series[0];
    if (!s || !s.OBSERVATIONS) { faltan.push(id); continue; }
    const obs = s.OBSERVATIONS.filter(o => o.OBS_VALUE != null && o.OBS_VALUE !== "").map(o => [o.TIME_PERIOD, +(+o.OBS_VALUE).toPrecision(9)]).reverse();
    if (!obs.length) { faltan.push(id); continue; }
    out.indicadores.push({
      id, area, grupo, nombre, descripcion: (IND[id] || "").trim(),
      frecuencia: FREQ[s.FREQ] || s.FREQ, unidad: UNIT[s.UNIT] || "", mult: ({ "1": "Miles", "2": "Millones", "4": "Billones" })[s.UNIT_MULT] || "",
      tema: TOPIC[s.TOPIC] || "", fuente: String(s.SOURCE || "").split(",").map(x => SOURCE[x.trim()]).filter(Boolean).join(" · "),
      nota: NOTE[s.NOTE] || "", actualizado: (s.LASTUPDATE || "").slice(0, 10), obs
    });
    process.stdout.write(".");
  }
  console.log(`\n${out.indicadores.length} series descargadas` + (faltan.length ? `; sin datos: ${faltan.join(", ")}` : ""));
  fs.writeFileSync(path.join(__dirname, "ecolab-datos.js"), "window.ECO_DATA=" + JSON.stringify(out) + ";\n");
})();
