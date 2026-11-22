/* Media Lab · monitor masivo de noticias.
   Proyectos (términos, zona, periodo, periodicidad) → extracción por rebanadas reanudables (aguanta miles de términos) → noticias normalizadas
   (medio, categoría/subcategoría, lugar georreferenciado, entidades, resumen) guardadas en Cloud Storage → consulta filtrada para el tablero.
   Proveedores: GDELT (gratis, sin clave), Google Noticias RSS (gratis, 100 notas por consulta), NewsData.io y GNews (con clave en variable de entorno).
   Se registra con require("./medialab.js")(app, deps). */
"use strict";
const crypto = require("crypto");

module.exports = function (app, D) {
  const PRJ = "medialab/proyectos.json", OBJ = id => `medialab/${id}/noticias.json`;
  const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const sha = s => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);
  const SEGUIM = /^(utm_[a-z]+|fbclid|gclid|igshid|mc_[a-z]+|ref|ref_src|source|cmpid|ocid|outputtype|amp|s)$/i;
  function urlClave(url) {   // igual que antes si no hay parámetros; si los hay, se conservan los que identifican la nota (p. ej. ?artid=123)
    const base = String(url).replace(/[?#].*$/, ""), q = (String(url).split("#")[0].split("?")[1] || "");
    if (!q) return base; const k = q.split("&").filter(x => x && !SEGUIM.test(x.split("=")[0])).sort().join("&"); return k ? base + "?" + k : base;
  }
  const claveTit = n => (n.dom || "") + (n.soc && n.soc.pg ? "@" + n.soc.pg : "") + "|" + norm(n.t).replace(/[^a-z0-9ñ ]/g, "").replace(/\s+/g, " ").trim().slice(0, 90);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const par = arr => arr.length > 1 ? "(" + arr.join(" OR ") + ")" : (arr[0] || "");   // GDELT solo admite paréntesis alrededor de grupos con OR
  const ahoraIso = () => new Date().toISOString();

  /* ───────── uso y costos de las APIs (se mide cada llamada; el costo se calcula al consultar con tarifas editables) ───────── */
  const USO = "medialab/uso.json";
  const TARIFAS0 = { ia: { "claude-haiku-5-5": { in: 1, out: 5 }, "claude-sonnet-5": { in: 3, out: 15 }, def: { in: 3, out: 15 } }, places: 0.032, gdelt: 0, grss: 0, newsdata: 0, gnews: 0, fbapify: 0.004, gserp: 0.002, fbpost: 0.0053, texto: 0, gnres: 0 };
  const SVC = { ia: "IA · Anthropic (Claude)", places: "Google Places (búsqueda de lugares)", gdelt: "GDELT (noticias)", grss: "Google Noticias (RSS)", newsdata: "NewsData.io", gnews: "GNews", fbapify: "Facebook (Apify · búsqueda directa, por publicación recibida)", gserp: "Google · búsqueda de publicaciones (por página de resultados)", fbpost: "Facebook (Apify · lectura de publicación por enlace)", texto: "Descarga de páginas de medios", gnres: "Resolución de enlaces de Google Noticias", notas: "Notas nuevas guardadas" };
  const BUF = [];
  const uso = (svc, o) => { o = o || {}; BUF.push([new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10), o.proy || "_", svc, o]); };   /* fecha en hora de México, igual que los filtros de Costos */
  async function vuelcaUso() {
    if (!BUF.length) return; const lote = BUF.splice(0, BUF.length);
    for (let i = 0; i < 6; i++) {
      try {
        const { data, gen } = await D.readGcs(USO), U = data || { d: {}, tarifas: null };
        lote.forEach(([f, pr, sv, o]) => { const a = ((U.d[f] = U.d[f] || {})[pr] = U.d[f][pr] || {}), e = a[sv] = a[sv] || { n: 0, in: 0, out: 0, k: 0, mod: {} }; e.n += o.n || 0; e.in += o.in || 0; e.out += o.out || 0; e.k += o.k || 0; if (o.mod) { const m = e.mod[o.mod] = e.mod[o.mod] || [0, 0, 0]; m[0] += o.n || 0; m[1] += o.in || 0; m[2] += o.out || 0; } });
        await D.writeGcs(USO, U, gen); return;
      } catch (e) { if (!e.conflict) { BUF.unshift(...lote); return; } await sleep(150 * (i + 1)); }
    }
    BUF.unshift(...lote);
  }
  setInterval(() => { vuelcaUso().catch(() => { }); }, 20000).unref();
  const costoDe = (sv, e, T) => { if (sv === "ia") return Object.entries(e.mod || {}).reduce((a, [m, v]) => { const t = (T.ia && (T.ia[m] || T.ia.def)) || { in: 0, out: 0 }; return a + v[1] / 1e6 * t.in + v[2] / 1e6 * t.out; }, 0); return (e.n || 0) * (+T[sv] || 0); };

  /* ───────── catálogos ───────── */
  const ESTADOS = { "01": "Aguascalientes", "02": "Baja California", "03": "Baja California Sur", "04": "Campeche", "05": "Coahuila", "06": "Colima", "07": "Chiapas", "08": "Chihuahua", "09": "Ciudad de México", "10": "Durango", "11": "Guanajuato", "12": "Guerrero", "13": "Hidalgo", "14": "Jalisco", "15": "Estado de México", "16": "Michoacán", "17": "Morelos", "18": "Nayarit", "19": "Nuevo León", "20": "Oaxaca", "21": "Puebla", "22": "Querétaro", "23": "Quintana Roo", "24": "San Luis Potosí", "25": "Sinaloa", "26": "Sonora", "27": "Tabasco", "28": "Tamaulipas", "29": "Tlaxcala", "30": "Veracruz", "31": "Yucatán", "32": "Zacatecas" };
  const REG = {}; Object.entries({ "Noroeste": ["02", "03", "08", "10", "25", "26"], "Noreste": ["05", "19", "28"], "Occidente y Bajío": ["01", "06", "11", "14", "16", "18", "22", "24", "32"], "Centro": ["09", "13", "15", "17", "21", "29"], "Sur": ["07", "12", "20", "30"], "Península y Sureste": ["04", "23", "27", "31"] }).forEach(([r, l]) => l.forEach(e => { REG[e] = r; }));
  const ALIAS_EDO = { "cdmx": "09", "ciudad de mexico": "09", "distrito federal": "09", "edomex": "15", "estado de mexico": "15", "coahuila de zaragoza": "05", "veracruz de ignacio de la llave": "30", "michoacan de ocampo": "16", "nuevo leon": "19" };
  const MEDIOS = { "elheraldodemexico.com": "El Heraldo de México", "heraldodemexico.com.mx": "El Heraldo de México", "milenio.com": "Milenio", "imagen.com.mx": "Imagen", "imagentv.com": "Imagen Televisión", "mvsnoticias.com": "MVS Noticias", "noticieros.televisa.com": "Noticieros Televisa", "televisa.com": "Televisa", "eluniversal.com.mx": "El Universal", "jornada.com.mx": "La Jornada", "excelsior.com.mx": "Excélsior", "reforma.com": "Reforma", "elfinanciero.com.mx": "El Financiero", "expansion.mx": "Expansión", "proceso.com.mx": "Proceso", "vanguardia.com.mx": "Vanguardia", "elsiglodetorreon.com.mx": "El Siglo de Torreón", "elnorte.com": "El Norte", "abcnoticias.mx": "ABC Noticias", "elimparcial.com": "El Imparcial", "informador.mx": "El Informador", "razon.com.mx": "La Razón", "eleconomista.com.mx": "El Economista", "tvazteca.com": "TV Azteca", "aztecanoticias.com.mx": "Azteca Noticias", "infobae.com": "Infobae", "animalpolitico.com": "Animal Político", "sdpnoticias.com": "SDP Noticias", "debate.com.mx": "Debate", "elsoldemexico.com.mx": "El Sol de México", "lajornadamaya.mx": "La Jornada Maya", "zocalo.com.mx": "Zócalo", "periodicoelmexicano.com.mx": "El Mexicano" };
  const nomMedio = d => { d = String(d || "").toLowerCase().replace(/^www\./, ""); if (MEDIOS[d]) return MEDIOS[d]; const k = Object.keys(MEDIOS).find(x => d.endsWith("." + x)); if (k) return MEDIOS[k]; const b = d.replace(/\.(com|mx|org|net|info|tv|news)(\.[a-z]{2})?$/, "").split(".").pop(); return b ? b.charAt(0).toUpperCase() + b.slice(1) : d; };

  /* taxonomía simple por palabras clave (categoría › subcategoría); la IA, si está activa, la refina */
  const TAX = [
    ["Política", { "Gobierno": "gobierno|gobernador|gobernadora|alcalde|alcaldesa|presidente municipal|presidenta|ayuntamiento|cabildo|secretar[ií]a|administraci[oó]n", "Elecciones y partidos": "elecci|candidat|votaci|partido|morena|\\bpan\\b|\\bpri\\b|\\bine\\b|campa[ñn]a electoral", "Congreso y leyes": "congreso|diputad|senad|iniciativa|reforma|\\bley\\b|legisla" }],
    ["Seguridad y justicia", { "Delincuencia": "asesin|homicid|robo|asalto|secuestr|balacera|detenid|narco|c[aá]rtel|extorsi|feminicid", "Tribunales": "juez|fiscal|sentencia|vinculan|audiencia|tribunal|amparo", "Emergencias y accidentes": "accidente|choque|incendio|volcadura|protecci[oó]n civil|rescate|explosi" }],
    ["Economía y negocios", { "Finanzas": "\\bpeso\\b|inflaci|banxico|tasa de inter|bolsa|d[oó]lar|inversi|deuda|presupuesto", "Empresas": "empresa|empresari|compa[ñn][ií]a|ventas|corporativ|\\bmarca\\b", "Empleo": "empleo|desempleo|salario|trabajador|imss|vacante|sindicat", "Industria y comercio": "industria|manufactur|comercio|exporta|arancel|automotriz|planta\\b|nearshoring", "Inmobiliario y construcción": "vivienda|inmobiliari|construcci|desarrollo urbano|hipotec|terreno|edificio|\\bobra\\b" }],
    ["Deportes", { "Futbol": "f[uú]tbol|liga mx|\\bgol\\b|rayados|tigres|santos laguna|selecci[oó]n mexicana|mundial", "Otros deportes": "b[eé]isbol|basquet|nfl|nba|\\bbox\\b|tenis|olimp|atletismo|f[oó]rmula 1" }],
    ["Cultura y espectáculos", { "Música y espectáculos": "concierto|cantante|m[uú]sica|festival|pel[ií]cula|\\bserie\\b|actor|actriz|farándula", "Cultura y arte": "museo|exposici[oó]n|teatro|libro|cultura|\\barte\\b|artista|literatura" }],
    ["Salud", { "Salud pública": "salud|hospital|vacuna|epidemia|dengue|covid|enfermedad|imss|issste|medicina", "Bienestar": "obesidad|diabetes|nutrici|ejercicio|salud mental|adicciones" }],
    ["Educación", { "Educación": "escuela|universidad|alumno|estudiante|maestro|\\bsep\\b|educaci|beca|uanl|unam|tec de monterrey" }],
    ["Tecnología y ciencia", { "Tecnología": "tecnolog|inteligencia artificial|\\bia\\b|\\bapp\\b|celular|internet|ciberseguridad|software", "Ciencia": "cient[ií]fic|investigaci|descubr|nasa|astronom|universo" }],
    ["Medio ambiente y clima", { "Clima": "clima|lluvia|sequ[ií]a|calor|frente fr[ií]o|hurac[aá]n|tormenta|temperatura|granizo", "Agua y ambiente": "\\bagua\\b|contaminaci|medio ambiente|presa|conagua|residuos|reforestaci|\\baire\\b" }],
    ["Movilidad e infraestructura", { "Vialidad y transporte": "vialidad|tr[aá]fico|transporte|\\bmetro\\b|camion|carretera|bache|autopista|aeropuerto|vuelo", "Obra pública": "obra p[uú]blica|puente|pavimenta|infraestructura|drenaje|alumbrado" }],
    ["Sociedad y comunidad", { "Comunidad": "colonia|vecino|comunidad|protesta|marcha|manifestaci|desaparecid|migrante|derechos humanos|vivienda social" }],
    ["Internacional", { "Mundo": "estados unidos|trump|biden|ucrania|rusia|gaza|israel|china|europa|\\bONU\\b|canad[aá]|venezuela|argentina" }]
  ].map(([c, subs]) => [c, Object.entries(subs).map(([s, re]) => [s, new RegExp(re, "i")])]);
  function clasifica(txt) {
    let mejor = null, ms = 0;
    for (const [c, subs] of TAX) { let tot = 0, bs = null, bn = 0; for (const [s, re] of subs) { const m = txt.match(new RegExp(re.source, "gi")); const n = m ? m.length : 0; tot += n; if (n > bn) { bn = n; bs = s; } } if (tot > ms) { ms = tot; mejor = [c, bs]; } }
    return mejor || ["General", "Sin subcategoría"];
  }
  const CATS = TAX.map(([c, subs]) => ({ c, subs: subs.map(x => x[0]) })).concat([{ c: "General", subs: ["Sin subcategoría"] }]);

  /* ───────── geografía (municipios de todo el país desde los datos propios) ───────── */
  let GAZ = null;
  async function gaz() {
    if (GAZ) return GAZ;
    const M = await D.nacMuns(), por = new Map(), edo = {};
    for (const m of M) {
      const nm = norm(m.nm); if (nm.length < 4) continue; const e = m.c.slice(0, 2), lat = (m.bbox[0] + m.bbox[2]) / 2, lng = (m.bbox[1] + m.bbox[3]) / 2, w = m.pob || 1;
      const x = { c: m.c, nm: m.nm, e, lat, lng, pob: w }; (por.get(nm) || por.set(nm, []).get(nm)).push(x);
      const s = edo[e] || (edo[e] = { lat: 0, lng: 0, w: 0 }); s.lat += lat * w; s.lng += lng * w; s.w += w;
    }
    for (const e of Object.keys(edo)) { edo[e].lat /= edo[e].w || 1; edo[e].lng /= edo[e].w || 1; }
    GAZ = { por, edo, nombres: [...por.keys()].sort((a, b) => b.length - a.length) }; return GAZ;
  }
  function lugarDe(txt, zonaEdos, G) {
    const n = " " + norm(txt).replace(/[^a-z0-9ñ ]/g, " ").replace(/\s+/g, " ") + " ";
    let muni = null;
    for (const nm of G.nombres) { if (n.indexOf(" " + nm + " ") < 0) continue; const c = G.por.get(nm); const pref = c.find(x => zonaEdos.includes(x.e)) || c.slice().sort((a, b) => b.pob - a.pob)[0]; if (nm.length < 5 && !zonaEdos.includes(pref.e)) continue; muni = pref; break; }
    if (muni) return { nivel: "municipio", met: "regla", mun: muni.c, munN: muni.nm, est: muni.e, estN: ESTADOS[muni.e], lat: muni.lat, lng: muni.lng };
    for (const a of Object.keys(ALIAS_EDO).concat(Object.values(ESTADOS).map(norm))) { if (n.indexOf(" " + a + " ") < 0) continue; const e = ALIAS_EDO[a] || Object.keys(ESTADOS).find(k => norm(ESTADOS[k]) === a); if (e && G.edo[e]) return { nivel: "estado", met: "regla", est: e, estN: ESTADOS[e], lat: G.edo[e].lat, lng: G.edo[e].lng }; }
    return null;
  }

  /* ───────── entidades por reglas (la IA, si está activa, las mejora) ───────── */
  const RE_INST = /\b(IMSS|ISSSTE|SAT|INE|SEP|CFE|PEMEX|Pemex|FGR|Guardia Nacional|Sedena|Semar|SCJN|Suprema Corte|Banxico|Profeco|Conagua|UANL|UNAM|Tec de Monterrey|Cámara de Diputados|Senado|Congreso(?: del? [A-ZÁÉÍÓÚ][\wáéíóúñ]+)?|Fiscalía(?: [A-ZÁÉÍÓÚ][\wáéíóúñ]+){0,3}|Secretaría de [A-ZÁÉÍÓÚ][\wáéíóúñ]+(?: de [A-ZÁÉÍÓÚ][\wáéíóúñ]+)?|Gobierno (?:de|del) [A-ZÁÉÍÓÚ][\wáéíóúñ]+(?: [A-ZÁÉÍÓÚ][\wáéíóúñ]+)?|Ayuntamiento de [A-ZÁÉÍÓÚ][\wáéíóúñ]+|Universidad [A-ZÁÉÍÓÚ][\wáéíóúñ]+)\b/g;
  const RE_PERS = /\b(?:alcald[ea]|gobernador[a]?|president[ea]|senador[a]?|diputad[oa]|secretari[oa]|fiscal|director[a]?|empresari[oa]|entrenador|t[eé]cnico|jugador|doctor[a]?|Dr\.|Dra\.|titular|ministro|candidat[oa])\s+(?:de\s+[\wáéíóúñ ]{3,25}?\s+)?([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+(?:de|del|la)\s+)?(?:\s*[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){1,3})/g;
  function entidades(txt, terminos) {
    const inst = [...new Set((txt.match(RE_INST) || []).map(x => x.trim()))].slice(0, 6), pers = []; let m; RE_PERS.lastIndex = 0;
    while ((m = RE_PERS.exec(txt)) && pers.length < 5) { const p = m[1].trim(); if (!pers.includes(p)) pers.push(p); }
    const nt = norm(txt), top = (terminos || []).filter(t => t.length > 2 && nt.includes(norm(t))).slice(0, 8);
    return { pers, inst, top };
  }

  /* ───────── proveedores de noticias ───────── */
  const GATE = { gnres: 1200, gdelt: 5300, grss: 2200, newsdata: 1300, gnews: 1200, fbgoogle: 1100, fbapify: 1500, fbmix: 1200 }, ULT = {};
  async function puerta(p) { const w = (ULT[p] || 0) + (GATE[p] || 1000) - Date.now(); if (w > 0) await sleep(w); ULT[p] = Date.now(); }
  const PROVS = {
    gdelt: { n: "GDELT (gratis)", clave: null, max: 250, ventana: "últimos ~3 meses", nota: "Cobertura mundial masiva, sin clave. 1 consulta cada 5 s; solo ~3 meses hacia atrás; trae título, medio, fecha e imagen (sin texto)." },
    grss: { n: "Google Noticias (RSS)", clave: null, max: 100, ventana: "histórico variable", nota: "Gratis y sin clave, pero hasta 100 notas por consulta y de uso no comercial según Google; sin texto ni categorías." },
    newsdata: { n: "NewsData.io", clave: "NEWSDATA_API_KEY", max: 50, ventana: "según plan", nota: "API de pago con categorías, descripción y (en planes altos) texto completo; filtros por país/idioma/categoría." },
    fbmix: { n: "Facebook · descubrir con Google y completar con Apify", clave: "APIFY_TOKEN", max: 30, ventana: "según indexación de Google", social: true, nota: "Encuentra publicaciones públicas de Facebook con el buscador de Google (muy barato), descarta las que no mencionan el término y la zona, y solo de las que pasan trae fecha exacta, reacciones, comentarios y compartidos (≈ 0.005 USD cada una)." },
    fbapify: { n: "Facebook · búsqueda directa (Apify)", clave: "APIFY_TOKEN", max: 25, ventana: "según Facebook", social: true, nota: "Busca publicaciones públicas de Facebook por palabra clave, lugar y rango de fechas (Apify). Trae el texto, la página, la fecha, las reacciones (con su desglose), los comentarios y las veces compartida. Hasta 25 publicaciones por consulta y por semana, de las más recientes a las más antiguas; cada una cuesta ≈ 0.004 USD con el plan Starter de Apify." },
    gnews: { n: "GNews", clave: "GNEWS_API_KEY", max: 100, ventana: "según plan", nota: "API de pago económica: títulos, descripción, imagen y fuente; filtros por fecha, país e idioma." }
  };
  const disponibles = () => Object.fromEntries(Object.entries(PROVS).map(([k, v]) => [k, { n: v.n, ok: !v.clave || !!process.env[v.clave], clave: v.clave, nota: v.nota, ventana: v.ventana, social: !!v.social }]));
  const fmtG = d => new Date(d).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  /* descarga con https (IPv4, plazo largo y redirecciones): el fetch de Node corta a los 10 s al conectar con algunos servidores */
  const https = require("https"), http = require("http");
  function jget(url, ms, extra, n) {
    return new Promise((ok, no) => {
      const u = new URL(url), mod = u.protocol === "http:" ? http : https;
      const rq = mod.get(u, { family: 4, timeout: ms || 25000, headers: Object.assign({ "User-Agent": "Mozilla/5.0 (compatible; MediaLabClient/1.0)", "Accept-Encoding": "identity", Accept: "*/*" }, (extra && extra.headers) || {}) }, r => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && (n || 0) < 4) { r.resume(); return ok(jget(new URL(r.headers.location, u).toString(), ms, extra, (n || 0) + 1)); }
        const ch = []; let len = 0; r.on("data", c => { len += c.length; if (len < 3e6) ch.push(c); }); r.on("end", () => { const t = Buffer.concat(ch).toString("utf8"); if (r.statusCode >= 400) { const e = new Error("HTTP " + r.statusCode + " " + t.slice(0, 120)); e.status = r.statusCode; return no(e); } ok(t); });
      });
      rq.on("timeout", () => rq.destroy(new Error("tiempo agotado"))); rq.on("error", no);
    });
  }
  async function pGdelt(cfg, q, d, h, limite, act) {
    const desde = Math.max(new Date(d).getTime(), Date.now() - 88 * 864e5), idi = par((cfg.idiomas || ["spanish"]).map(i => "sourcelang:" + i)), pais = par((cfg.paises || ["MX"]).map(c => "sourcecountry:" + c));
    const full = `${q} ${pais} ${idi}`.replace(/\s+/g, " ").trim();
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(full)}&mode=artlist&maxrecords=250&format=json&sort=datedesc&startdatetime=${fmtG(desde)}&enddatetime=${fmtG(h)}`;
    let lim429 = false;
    for (let i = 0; i < 3; i++) {
      if (limite && Date.now() > limite - 12000) { const e = new Error("sin tiempo en esta rebanada"); e.reintentar = true; e.limitado = lim429; throw e; }
      act && act(`GDELT: esperando respuesta (intento ${i + 1} de 3)…`); await puerta("gdelt"); let t; try { t = await jget(url, 20000); } catch (e) { if (e.status === 429 || /tiempo agotado|ECONNRESET|ETIMEDOUT/.test(e.message)) { lim429 = true; act && act(`GDELT limitó o no respondió; reintentando en ${6 + i * 3} s…`); await sleep(6000 + i * 3000); continue; } throw e; }
      if (/^\s*[{[]/.test(t)) { let j; try { j = JSON.parse(t); } catch (_) { j = { articles: [] }; } const a = j.articles || []; return { items: a.map(x => ({ url: x.url, titulo: x.title, fecha: x.seendate ? new Date(x.seendate.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z")).toISOString() : null, medio: x.domain, idioma: x.language, pais: x.sourcecountry, imagen: x.socialimage && /^https?:/.test(x.socialimage) ? x.socialimage : "" })), saturado: a.length >= 250 }; }
      if (/limit requests|too many/i.test(t)) { lim429 = true; await sleep(6000); continue; } throw new Error("GDELT: " + t.slice(0, 140));
    }
    const e2 = new Error("GDELT: límite de consultas o sin respuesta"); e2.limitado = true; throw e2;
  }
  const tag = (x, t) => { const m = x.match(new RegExp("<" + t + "[^>]*>([\\s\\S]*?)</" + t + ">")); return m ? m[1].replace(/^<!\[CDATA\[|\]\]>$/g, "").trim() : ""; };
  const dec = s => String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  async function pGrss(cfg, q, d, h, limite, act) {
    const f = x => new Date(x).toISOString().slice(0, 10), full = `${q} after:${f(d)} before:${f(new Date(new Date(h).getTime() + 864e5))}`;
    await puerta("grss"); const t = await jget(`https://news.google.com/rss/search?q=${encodeURIComponent(full)}&hl=es-419&gl=MX&ceid=MX:es-419`, 25000);
    const items = (t.match(/<item>[\s\S]*?<\/item>/g) || []).map(it => { const src = it.match(/<source url="([^"]*)">([^<]*)<\/source>/); let ti = dec(tag(it, "title")); const sn = src ? dec(src[2]) : ""; if (sn && ti.endsWith(" - " + sn)) ti = ti.slice(0, -(sn.length + 3));
      let dom = ""; try { dom = src ? new URL(src[1]).hostname : ""; } catch (_) { } return { url: dec(tag(it, "link")), titulo: ti, fecha: new Date(tag(it, "pubDate") || Date.now()).toISOString(), medio: dom || sn, medioN: sn, idioma: "Spanish", pais: "Mexico", imagen: "", descripcion: (() => { let d = dec(dec(tag(it, "description"))).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim(); if (norm(d).startsWith(norm(ti).slice(0, 40))) d = ""; return d.slice(0, 300); })() }; });
    return { items, saturado: items.length >= 95 };
  }
  async function pNewsdata(cfg, q, d, h, limite, act) {
    const key = process.env.NEWSDATA_API_KEY; if (!key) throw new Error("Falta NEWSDATA_API_KEY"); const out = []; let page = "";
    for (let i = 0; i < 3; i++) { await puerta("newsdata"); const u = `https://newsdata.io/api/1/latest?apikey=${key}&q=${encodeURIComponent(q.slice(0, 480))}&country=${(cfg.paises || ["MX"]).join(",").toLowerCase()}&language=es${page ? "&page=" + page : ""}`; const j = JSON.parse(await jget(u, 25000)); (j.results || []).forEach(x => out.push({ url: x.link, titulo: x.title, fecha: x.pubDate ? new Date(x.pubDate.replace(" ", "T") + "Z").toISOString() : null, medio: (x.source_url || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "") || x.source_id, medioN: x.source_name || "", idioma: x.language, pais: (x.country || [])[0] || "", imagen: x.image_url || "", descripcion: String(x.description || "").slice(0, 300), catProv: (x.category || [])[0] || "" })); if (!j.nextPage) break; page = j.nextPage; }
    return { items: out.filter(x => !x.fecha || (new Date(x.fecha) >= new Date(d) && new Date(x.fecha) <= new Date(h))), saturado: false };
  }
  async function pGnews(cfg, q, d, h, limite, act) {
    const key = process.env.GNEWS_API_KEY; if (!key) throw new Error("Falta GNEWS_API_KEY"); await puerta("gnews");
    const j = JSON.parse(await jget(`https://gnews.io/api/v4/search?q=${encodeURIComponent(q.slice(0, 190))}&lang=es&country=${(cfg.paises || ["MX"])[0].toLowerCase()}&max=100&from=${new Date(d).toISOString()}&to=${new Date(h).toISOString()}&apikey=${key}`, 25000));
    const a = j.articles || []; return { items: a.map(x => ({ url: x.url, titulo: x.title, fecha: x.publishedAt, medio: (x.source && x.source.url || "").replace(/^https?:\/\//, "").replace(/\/.*$/, ""), medioN: x.source && x.source.name || "", idioma: "Spanish", pais: "Mexico", imagen: x.image || "", descripcion: String(x.description || "").slice(0, 300) })), saturado: a.length >= 100 };
  }
  /* Facebook (publicaciones públicas) a través de un buscador web: Brave Search con site:facebook.com y rango de fechas */
  async function pFb(cfg, q, d, h, limite, act) {
    const key = process.env.BRAVE_API_KEY; if (!key) throw new Error("Falta BRAVE_API_KEY"); const f = x => new Date(x).toISOString().slice(0, 10), out = [], vistos = new Set();
    let reint = 0; for (let pg = 0; pg < 3; pg++) {
      await puerta("fbgoogle"); let j;
      try { j = JSON.parse(await jget(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent("site:facebook.com " + q)}&country=mx&search_lang=es&count=20&offset=${pg}&freshness=${f(d)}to${f(h)}&extra_snippets=true&text_decorations=false`, 25000, { headers: { "X-Subscription-Token": key, Accept: "application/json" } })); }
      catch (e) { if (e.status === 429 && reint++ < 2) { await sleep(2500); pg--; continue; } if (pg > 0) break; throw e; }
      const r = (j.web && j.web.results) || [];
      for (const x of r) { let u; try { u = new URL(x.url); } catch (_) { continue; } if (!/(^|\.)(facebook\.com|fb\.com|fb\.watch)$/.test(u.hostname) || vistos.has(x.url)) continue; vistos.add(x.url);
        const tt = String(x.title || "").replace(/\s*[|·-]\s*Facebook\s*$/i, "").trim(), pagina = (tt.split(/\s[-–|]\s/)[0] || "").slice(0, 60) || u.pathname.split("/").filter(Boolean)[0] || "Facebook", desc = String(x.description || "").replace(/\s+/g, " ").trim(), extra = (x.extra_snippets || []).join(" ").replace(/\s+/g, " ").trim();
        let fe = x.page_age ? new Date(x.page_age) : null; if (!fe || isNaN(fe)) fe = new Date(h);
        out.push({ url: x.url, titulo: tt.length >= 8 ? tt : desc.slice(0, 140), fecha: fe.toISOString(), medio: "facebook.com", medioN: "Facebook · " + pagina, idioma: "Spanish", pais: "Mexico", imagen: (x.thumbnail && x.thumbnail.src) || "", descripcion: (desc + (extra ? " " + extra : "")).slice(0, 400) }); }
      if (r.length < 20 || !(j.query && j.query.more_results_available)) break;
    }
    return { items: out, saturado: out.length >= 55 };
  }
  /* Facebook con reacciones: actor de Apify que busca publicaciones públicas (consulta simple: palabra + lugar; no admite OR ni comillas) */
  const FB_N = 25;
  function apPost(path, cuerpo, ms) {
    return new Promise((ok, no) => {
      const tk = process.env.APIFY_TOKEN; if (!tk) return no(new Error("Falta APIFY_TOKEN")); const data = JSON.stringify(cuerpo);
      const rq = https.request({ hostname: "api.apify.com", path, method: "POST", family: 4, timeout: ms || 240000, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), Authorization: "Bearer " + tk } }, r => {
        const ch = []; r.on("data", c => ch.push(c)); r.on("end", () => { const t = Buffer.concat(ch).toString("utf8"); if (r.statusCode >= 400) { const e = new Error("Apify HTTP " + r.statusCode + " " + t.slice(0, 160)); e.status = r.statusCode; return no(e); } ok(t); });
      });
      rq.on("timeout", () => rq.destroy(new Error("Apify: tiempo agotado"))); rq.on("error", no); rq.write(data); rq.end();
    });
  }
  /* ejecuta el actor sin esperar de más y revisa su mensaje de estado: el plan gratuito de Apify limita el ritmo y, en ese caso, el actor "termina bien" con 0 resultados */
  async function apCorre(input, actor) {
    const tk = process.env.APIFY_TOKEN, hdr = { headers: { Authorization: "Bearer " + tk, Accept: "application/json" } };
    let run = JSON.parse(await apPost(`/v2/acts/${actor || "scraper_one~facebook-posts-search"}/runs?timeout=220&waitForFinish=60`, input, 80000)).data;
    for (let i = 0; i < 5 && run && (run.status === "READY" || run.status === "RUNNING"); i++) run = JSON.parse(await jget(`https://api.apify.com/v2/actor-runs/${run.id}?waitForFinish=60`, 80000, hdr)).data;
    if (!run || run.status !== "SUCCEEDED") throw new Error("Apify: la ejecución terminó como " + (run && run.status));
    if (/rate limit/i.test(run.statusMessage || "")) { const e = new Error("Apify limitó el ritmo de consultas (plan gratuito)"); e.limitado = true; throw e; }
    return JSON.parse(await jget(`https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?clean=1&limit=500`, 60000, hdr));
  }
  async function pApify(cfg, q, d, h, limite, act) {
    const f = x => new Date(x).toISOString().slice(0, 10), N = 100, input = { query: String(q).replace(/[{}$<>`"]/g, " ").trim().slice(0, 100), resultsCount: N, searchType: "top", startDate: f(d), endDate: f(h) };
    let arr, esp = [45000, 90000, 180000];
    for (let i = 0; ; i++) {
      await puerta("fbapify");
      try { arr = await apCorre(input); break; } catch (e) { if (!e.limitado) throw e; if (i >= esp.length) throw e; act && act(`Apify limitó el ritmo: esperando ${Math.round(esp[i] / 1000)} s para reintentar (intento ${i + 1} de ${esp.length})…`); await sleep(esp[i]); }
    }
    if (!Array.isArray(arr)) throw new Error("Apify: respuesta no válida");
    const items = arr.filter(x => x && x.url && x.postText).map(x => { const tx = String(x.postText).replace(/\s+/g, " ").trim(), at = (x.attachments || []).find(a => a && a.type === "photo"), au = x.author || {};
      return { url: x.url, titulo: tx.slice(0, 140), fecha: x.timestamp ? new Date(x.timestamp).toISOString() : new Date(h).toISOString(), medio: "facebook.com", medioN: "Facebook · " + String(au.name || "").slice(0, 60), idioma: "Spanish", pais: "Mexico", imagen: at ? (at.url || at.image || at.thumbnail || "") : "", descripcion: tx.slice(0, 600),
        soc: { r: +x.reactionsCount || 0, rx: x.reactions || {}, c: +x.commentsCount || 0, s: +x.sharesCount || 0, pg: String(au.name || "").slice(0, 80), pu: au.profileUrl || "", pid: String(x.postId || "") } }; });
    return { items, saturado: arr.length >= N, crudo: arr.length };
  }
  /* filtro de precisión para Facebook: la publicación debe traer texto suficiente, mencionar el término buscado y mencionar la zona (en el texto, en hashtags o en el nombre de la página) */
  function fbPasa(n, terms, zona) {
    const cuerpo = String(n.d || n.t || ""), txt = norm(n.t + " " + cuerpo), junto = txt.replace(/[^a-z0-9ñ]/g, ""); if (cuerpo.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, "").length < 40) return false;
    const okT = (terms || []).some(t => { const ws = norm(t).replace(/["]/g, "").split(/\s+/).filter(w => w.length > 2); return ws.length && ws.every(w => txt.includes(w.length > 5 ? w.slice(0, 5) : w)); }); if (!okT) return false;
    const z = zona || {}, nom = [...(z.estadosN || []), ...(z.ciudades || [])].filter(Boolean); if (!nom.length) return true;
    if (n.lug && (z.estados || []).includes(n.lug.est)) return true; const pg = norm((n.soc && n.soc.pg) || ""), pgJ = pg.replace(/[^a-z0-9ñ]/g, "");
    return nom.some(x => { const a = norm(x), j = a.replace(/[^a-z0-9ñ]/g, ""); return txt.includes(a) || junto.includes(j) || pg.includes(a) || pgJ.includes(j); });
  }
  /* Facebook combinado: 1) Google encuentra enlaces de publicaciones (site:facebook.com + término + lugar + fechas); 2) se descartan las que no mencionan término y zona o ya están guardadas;
     3) solo de las que pasan se lee la publicación por su enlace (fecha exacta, reacciones, comentarios, compartidos) */
  const FBM_PAG = 3, FBM_MAX = 30;
  /* de los resultados de Google: enlaces de publicaciones de Facebook que mencionan término y zona y que aún no están guardados */
  function fbmCand(org, T, z, G, ya, max) {
    const vistos = new Set(), cand = [];
    for (const r of org) { let u; try { u = new URL(r.url); } catch (_) { continue; } if (!/(^|\.)facebook\.com$/.test(u.hostname) || !/\/(posts|videos|reel|watch|photos|permalink)/.test(u.pathname + u.search) && !/story_fbid|fbid=/.test(u.search)) continue;
      const tit = String(r.title || "").replace(/\s*[|·-]\s*Facebook\s*$/i, "").trim(), des = String(r.description || "").replace(/\s+/g, " ").trim(), txt = tit + ". " + des; let pg = ""; try { pg = decodeURIComponent(u.pathname.split("/").filter(Boolean)[0] || ""); } catch (_) { }
      if (vistos.has(r.url) || (ya && ya(r.url))) continue; vistos.add(r.url);
      if (!fbPasa({ t: tit, d: txt, lug: lugarDe(txt, z.estados || [], G), soc: { pg } }, T, z)) continue; cand.push({ url: r.url, tit, des }); if (cand.length >= max) break; }
    return cand;
  }
  /* une cada candidato con lo que devolvió el lector de publicaciones (fecha exacta, reacciones, comentarios, compartidos) */
  function fbmItems(cand, det) {
    const por = new Map((Array.isArray(det) ? det : []).map(x => [x.url, x.data || {}])), items = [];
    for (const c of cand) { const x = por.get(c.url); if (!x) continue; const st = x.statistics || {}, ts = (x.video_details && x.video_details.publish_timestamp) || x.publish_timestamp; if (!ts) continue;
      const tx = String(x.post_title || c.tit || "").replace(/\s+/g, " ").trim(), rc = st.reaction_count && typeof st.reaction_count === "object" ? st.reaction_count.count : st.reaction_count, rx = {}; (st.reactions_details || []).forEach(k => { if (k && k.type) rx[String(k.type).toLowerCase()] = +k.count || 0; });
      items.push({ url: c.url, titulo: tx.slice(0, 140) || c.tit, fecha: new Date(ts * 1000).toISOString(), medio: "facebook.com", medioN: "Facebook · " + String(x.owner_name || "").slice(0, 60), idioma: "Spanish", pais: "Mexico", imagen: x.thumbnail || "", descripcion: (tx + (c.des && !norm(tx).includes(norm(c.des).slice(0, 40)) ? " … " + c.des : "")).slice(0, 700),
        soc: { r: +rc || 0, rx, c: +st.comment_count || 0, s: +st.shares_count || 0, pg: String(x.owner_name || "").slice(0, 80), pu: "", pid: String(x.post_id || x.id || "") } }); }
    return items;
  }
  async function pFbMix(cfg, q, d, h, limite, act, ctx) {
    const f = x => new Date(x).toISOString().slice(0, 10), dia = 864e5, usos = []; await puerta("fbmix");
    const pags = await apCorre({ queries: `site:facebook.com ${q} after:${f(new Date(d).getTime() - dia)} before:${f(new Date(h).getTime() + dia)}`, maxPagesPerQuery: FBM_PAG, resultsPerPage: 10, countryCode: "mx", languageCode: "es", mobileResults: false, saveHtml: false, includeUnfilteredResults: true }, "apify~google-search-scraper");
    const org = (Array.isArray(pags) ? pags : []).flatMap(p => p.organicResults || []); usos.push(["gserp", Math.max(1, (Array.isArray(pags) ? pags.length : 1))]);
    const G = await gaz(), T = limpiaTerminos(cfg.terminos).pos, z = cfg.zona || {}, cand = fbmCand(org, T, z, G, ctx && ctx.ya, FBM_MAX);
    act && act(`Google encontró ${org.length} enlaces; ${cand.length} mencionan el término y la zona. Leyendo esas publicaciones…`);
    let items = []; if (cand.length) { const det = await apCorre({ urls: cand.map(c => c.url), maxConcurrency: 8 }, "mina_safwat~facebook-post-scraper-ppr"); usos.push(["fbpost", (Array.isArray(det) ? det.length : 0)]); items = fbmItems(cand, det); }
    return { items, saturado: org.length >= FBM_PAG * 10, usos, usd: usos.reduce((a, [sv, n]) => a + n * (TARIFAS0[sv] || 0), 0) };
  }
  const esFb = p => p === "fbapify" || p === "fbmix";
  const FETCH = { gdelt: pGdelt, grss: pGrss, newsdata: pNewsdata, gnews: pGnews, fbgoogle: pFb, fbapify: pApify, fbmix: pFbMix };
  /* consultas: para Facebook una por término y lugar; para el resto, grupos con OR */
  const gruposZ = (terms, prov, z) => { z = z || {}; if (!esFb(prov)) return grupos(terms, prov, zonaConsulta(z)); if (prov === "fbmix") { const n = [...(z.estadosN || []), ...(z.ciudades || [])].filter(Boolean).slice(0, 6), lug = n.length > 1 ? "(" + n.map(x => `"${x}"`).join(" OR ") + ")" : n.length ? `"${n[0]}"` : ""; return terms.map(t => (`"${String(t).replace(/"/g, "")}" ` + lug).trim()); } const n = [...(z.estadosN || []), ...(z.ciudades || [])].filter(Boolean).slice(0, 6), out = []; terms.forEach(t => { (n.length ? n : [""]).forEach(l => out.push((String(t).replace(/^"|"$/g, "") + " " + l).trim().slice(0, 100))); }); return out; };

  /* Google Noticias entrega enlaces de redirección: se resuelve el enlace real del medio (formato antiguo: base64; nuevo: consulta a batchexecute) */
  function jpost(url, cuerpo, ms) {
    return new Promise((ok, no) => {
      const u = new URL(url), rq = https.request(u, { method: "POST", family: 4, timeout: ms || 12000, headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "Content-Length": Buffer.byteLength(cuerpo), "User-Agent": "Mozilla/5.0 (compatible; MediaLabClient/1.0)" } }, r => { const ch = []; r.on("data", c => ch.push(c)); r.on("end", () => { const t = Buffer.concat(ch).toString("utf8"); r.statusCode >= 400 ? no(new Error("HTTP " + r.statusCode)) : ok(t); }); });
      rq.on("timeout", () => rq.destroy(new Error("tiempo agotado"))); rq.on("error", no); rq.write(cuerpo); rq.end();
    });
  }
  async function resuelveGN(link, proy) {
    const id = (String(link).match(/\/articles\/([^?\/#]+)/) || [])[1]; if (!id) return null;
    try { const b = Buffer.from(id.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1"), m = b.match(/https?:\/\/[\x21-\x7e]+/); if (m && !/^AU_yq/.test(b.slice(4, 10))) return m[0]; } catch (_) { }
    try {
      uso("gnres", { n: 1, proy }); await puerta("gnres"); const pag = await jget("https://news.google.com/rss/articles/" + id, 10000), sg = (pag.match(/data-n-a-sg="([^"]+)"/) || [])[1], ts = (pag.match(/data-n-a-ts="([^"]+)"/) || [])[1]; if (!sg || !ts) return null;
      const payload = ["Fbv4je", `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts},"${sg}"]`];
      await puerta("gnres"); const t = await jpost("https://news.google.com/_/DotsSplashUi/data/batchexecute", "f.req=" + encodeURIComponent(JSON.stringify([[payload]])), 12000);
      const parts = t.split("\n\n"); const arr = JSON.parse(parts[1]); const url = JSON.parse(arr[0][2])[1]; return /^https?:/.test(url) ? url : null;
    } catch (_) { return null; }
  }
  /* descarga del texto de la nota (en segundo plano, con tope por extracción): párrafos del artículo o, si no hay, la descripción de la página */
  const RUIDO = /suscr[ií]b|cookies|aviso de privacidad|todos los derechos|derechos reservados|inicia sesi[oó]n|reg[ií]strate|newsletter|publicidad|leer m[aá]s|s[ií]guenos|compartir en/i;
  function extraeTexto(h) {
    const meta = k => { const m = h.match(new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]+content=["']([^"']*)["']`, "i")) || h.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${k}["']`, "i")); return m ? dec(m[1]).trim() : ""; };
    const limpio = h.replace(/<(script|style|nav|header|footer|aside|form|noscript)[\s\S]*?<\/\1>/gi, " ");
    const art = (limpio.match(/<article[\s\S]*?<\/article>/i) || [limpio])[0], vistos = new Set();
    const ps = (art.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || []).map(x => dec(x.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()).filter(x => x.length > 70 && !RUIDO.test(x) && !vistos.has(x) && vistos.add(x));
    let texto = ps.join("\n\n").slice(0, 2500); const desc = meta("og:description") || meta("description");
    if (texto.length < 200 && desc) texto = desc;
    return { texto, desc, img: meta("og:image"), titulo: meta("og:title") };
  }
  async function bajaTexto(n, proy) {
    if (n.texto) return true;
    try { let url = n.urlReal || n.url; if (/news\.google\.com/.test(url)) { url = await resuelveGN(url, proy); if (!url) { n.txErr = 1; return false; } n.urlReal = url; }
      uso("texto", { n: 1, proy }); const h = (await jget(url, 8000)).slice(0, 500000), r = extraeTexto(h); if (r.texto && r.texto.length > 60) { n.texto = r.texto; if (!n.d && r.desc) n.d = r.desc.slice(0, 300); if (!n.img && /^https?:/.test(r.img)) n.img = r.img; return true; } } catch (_) { }
    n.txErr = 1; return false;
  }
  function entraFase(w, cfg, X, sig) {
    const ia = !(cfg.ia === false || cfg.iaAuto !== true || !process.env.ANTHROPIC_API_KEY), tx = cfg.texto !== false && +cfg.textoMax !== 0;
    if (sig === "ia" && ia) { w.fase = "enriquecimiento"; w.ia.pend = X.items.filter(n => !n.desc && (!n.ia || !n.an)).sort((a, b) => (b.f > a.f ? 1 : -1)).slice(0, +cfg.iaMax > 0 ? +cfg.iaMax : 1e9).map(n => n.id); if (w.ia.pend.length) return; sig = "tx"; }
    if (sig === "ia") sig = "tx";
    if (sig === "tx" && tx) { w.tx = { pend: X.items.filter(n => !n.texto && !n.txErr).sort((a, b) => (b.f > a.f ? 1 : -1)).slice(0, +cfg.textoMax || 500).map(n => n.id), hecho: 0, fallos: 0 }; w.fase = "texto"; if (w.tx.pend.length) return; }
    w.fase = "fin";
  }
  /* términos → grupos de consulta (aguanta miles) */
  function limpiaTerminos(txt) {
    const L = Array.isArray(txt) ? txt : String(txt || "").split(/[\n,;]+/), vistos = new Set(), pos = [], neg = [];
    for (let t of L) { t = String(t).trim(); if (!t) continue; const ng = t.startsWith("-"); if (ng) t = t.slice(1).trim(); const k = norm(t); if (k.length < 3 || vistos.has(k)) continue; vistos.add(k); (ng ? neg : pos).push(t.replace(/"/g, "")); }
    return { pos: pos.slice(0, 20000), neg: neg.slice(0, 500) };
  }
  function grupos(terminos, prov, zonaTxt) {
    const lim = prov === "gdelt" ? 190 : prov === "gnews" ? 170 : prov === "newsdata" ? 420 : prov === "fbgoogle" ? 110 : 95, extra = zonaTxt ? zonaTxt.length + 8 : 0, out = []; let cur = [], len = 0;
    for (const t of terminos) { const q = /\s/.test(t) ? `"${t}"` : t; if (len + q.length + 4 + extra > lim && cur.length) { out.push(cur); cur = []; len = 0; } cur.push(q); len += q.length + 4; }
    if (cur.length) out.push(cur);
    return out.map(g => par(g) + (zonaTxt ? ` ${zonaTxt}` : ""));
  }
  const zonaConsulta = z => { const n = [...(z.estadosN || []), ...(z.ciudades || [])].filter(Boolean); if (!n.length || n.length > 6) return ""; return par(n.map(x => /\s/.test(x) ? `"${x}"` : x)); };

  /* ───────── almacenamiento ───────── */
  let IDX_C = { d: null, t: 0 };
  async function leeIdx(fresco) { if (!fresco && IDX_C.d && Date.now() - IDX_C.t < 4000) return IDX_C; const { data, gen } = await D.readGcs(PRJ); IDX_C = { d: data && Array.isArray(data.proyectos) ? data : { proyectos: [] }, gen, t: Date.now() }; return IDX_C; }
  async function mutaIdx(fn) { for (let i = 0; i < 6; i++) { const c = await leeIdx(true), r = fn(c.d); try { await D.writeGcs(PRJ, c.d, c.gen); IDX_C = { d: c.d, gen: String(Date.now()), t: 0 }; return r; } catch (e) { if (!e.conflict) throw e; await sleep(200 + i * 150); } } throw new Error("conflicto al guardar proyectos"); }
  const NC = new Map();
  async function cargaNoticias(id) { const c = NC.get(id); if (c && Date.now() - c.t < 60000) { c.t = Date.now(); return c; } const { data } = await D.readGcs(OBJ(id)); const x = { items: data && Array.isArray(data.items) ? data.items : [], t: Date.now(), sucio: false }; NC.set(id, x); if (NC.size > 6) { const k = [...NC.entries()].sort((a, b) => a[1].t - b[1].t)[0][0]; NC.delete(k); } return x; }
  async function guardaNoticias(id, x) { await D.writeGcs(OBJ(id), { items: x.items, at: ahoraIso() }, null); x.sucio = false; }

  /* ───────── enriquecimiento ───────── */
  async function normaliza(raw, p, G) {
    const url = String(raw.url || "").trim(); if (!/^https?:/.test(url)) return null; const titulo = String(raw.titulo || "").replace(/\s+/g, " ").trim(); if (titulo.length < 8) return null;
    const txt = titulo + ". " + (raw.descripcion || ""); const zonaEdos = (p.config.zona && p.config.zona.estados) || [];
    const [cat, sub] = raw.catProv ? [raw.catProv, "General"] : clasifica(txt); const lug = lugarDe(txt, zonaEdos, G); const ent = entidades(txt, p.config.terminos);
    return { id: sha(urlClave(url)), url, t: titulo, d: raw.descripcion || "", f: raw.fecha || ahoraIso(), med: raw.medioN || nomMedio(raw.medio), dom: String(raw.medio || "").replace(/^www\./, ""), img: raw.imagen || "", idi: raw.idioma || "", pais: raw.pais || "", cat, sub, lug: lug || null, ent, res: "", ia: 0, prov: p.config.proveedor, soc: raw.soc || undefined };
  }
  const SYS_IA = "Eres analista de monitoreo de medios en México. Recibes notas (título, descripción breve, medio). Para CADA nota devuelve un objeto con: id; cat y sub (usa EXACTAMENTE una categoría y subcategoría de la lista dada); lugar: {municipio, estado, colonia, sitio} (solo lo que se mencione, si no, cadenas vacías); personas[], instituciones[], temas[] (máx. 5 c/u, nombres propios exactos); resumen (1 o 2 oraciones, máx. 220 caracteres, en español, sin inventar datos); sent (sentimiento de 1 a 9: 1 muy negativo, 5 neutro, 9 muy positivo); pol (polarización de 1 a 10: qué tan divisivo o conflictivo es el tema); haz (peligro de 0 a 100: amenaza para personas, bienes u operaciones; 0 nula, 100 extrema); pob (número entero de personas afectadas que la nota menciona o permite estimar; 0 si no se sabe); alc (alcance geográfico del hecho: local, municipal, estatal o nacional); esc (escala de la población afectada, entero 1 a 8: 1 particular = 1 a 5 personas, 2 grupo reducido = 6 a 50, 3 comunidad o colonia = 50 a 5 mil, 4 zona de la ciudad = 5 mil a 100 mil, 5 ciudad o municipio = 100 mil a 1 millón, 6 estado o región = 1 a 10 millones, 7 nacional = más de 10 millones, 8 global; elige por el número de personas que realmente podrían verse afectadas, no por el lugar donde se publica); gtipo (quiénes son los afectados, UN código: particular, vecinal, sectorial (sector o rama económica), gremial (trabajadores de un oficio o sindicato), etario (niños, jóvenes, adultos mayores), socioeconomico (nivel de ingreso o pobreza), publico (servidores públicos), seguridad (policías, militares, civiles de seguridad), interes (consumidores, usuarios, aficionados, comunidad con intereses comunes), vulnerable (salud, migrantes, discapacidad, minorías), general (toda la población)); grupo (texto de máx. 60 caracteres que nombra al grupo afectado, ej. «maestros de Coahuila», «vecinos de la col. Centro»); act (influencia de los actores principales involucrados, entero 1 a 5: 1 ciudadano común o anónimo, 2 persona o negocio local, 3 figura regional, funcionario medio o empresa mediana, 4 autoridad nacional, gran empresa, líder de opinión o institución de peso, 5 jefe de Estado, líder religioso o político mundial, organismo internacional o corporación global; en esos casos la escala debe reflejar también la audiencia o el alcance de su influencia); actn (nombre del actor principal, máx. 50 caracteres, cadena vacía si no hay); rol (importancia del rol social o económico de lo afectado, entero 1 a 5: 1 anecdótico, 2 cotidiano, 3 relevante para un sector, 4 servicio o sector clave, 5 estratégico para la economía o la sociedad, ej. ley fiscal, energía, salud, agua, seguridad pública); scian (hasta 3 códigos de sector SCIAN de la lista dada, de las actividades económicas relacionadas con la nota; [] si ninguna); grav: {lesiones, armas, infantes} con enteros 0 a 9 (personas lesionadas, armas u objetos punzocortantes involucrados, menores de edad involucrados); viol: {muertes, fuego, blanca, fisicas, verbales} con enteros 0 a 9 (personas fallecidas, lesionados por arma de fuego, lesionados por arma blanca, agresiones físicas leves, agresiones verbales); riesgos (lista con tipos de riesgo entre: físico, legal, operativo, reputacional, financiero, ambiental, sanitario, social). Responde SOLO un arreglo JSON.";
  const SCIAN = { "11": "Agricultura, cría y explotación de animales, aprovechamiento forestal, pesca y caza", "21": "Minería", "22": "Generación, transmisión y distribución de energía eléctrica; suministro de agua y de gas por ductos al consumidor final", "23": "Construcción", "31-33": "Industrias manufactureras", "43": "Comercio al por mayor", "46": "Comercio al por menor", "48-49": "Transportes, correos y almacenamiento", "51": "Información en medios masivos", "52": "Servicios financieros y de seguros", "53": "Servicios inmobiliarios y de alquiler de bienes muebles e intangibles", "54": "Servicios profesionales, científicos y técnicos", "55": "Dirección de corporativos y empresas", "56": "Servicios de apoyo a los negocios y manejo de residuos y desechos, y servicios de remediación", "61": "Servicios educativos", "62": "Servicios de salud y de asistencia social", "71": "Servicios de esparcimiento culturales y deportivos, y otros servicios recreativos", "72": "Servicios de alojamiento temporal y de preparación de alimentos y bebidas", "81": "Otros servicios excepto actividades gubernamentales", "93": "Actividades legislativas, gubernamentales, de impartición de justicia y de organismos internacionales y extraterritoriales" };
  /* Reglas tomadas del dashboard «Noticias analizadas» del proyecto Metrika: Riesgo = Impacto × Peligro / 100 (el Impacto es el índice de población afectada y relevancia); Gravedad y Violencia = Σ(ponderador × calificación) / Σ ponderadores × 100 */
  const WG = [["lesiones", "Lesiones", 3], ["armas", "Armas/obj. punzocortantes", 2], ["infantes", "Infantes involucrados", 1]];
  const WV = [["muertes", "Pérdidas humanas", 5], ["fuego", "Lesionados con armas de fuego", 4], ["blanca", "Lesionados con armas blancas", 3], ["fisicas", "Agresiones físicas leves", 2], ["verbales", "Agresiones verbales", 1]];
  const ALC = { local: 20, municipal: 35, estatal: 55, nacional: 80 };
  /* población afectada: escalas, tipos de grupo y relevancia (escala 65 % + rol social 35 %) */
  const ESCALA = [null, ["Particular", "1 a 5 personas", 8], ["Grupo reducido", "6 a 50 personas", 18], ["Comunidad o colonia", "50 a 5 mil personas", 32], ["Zona de la ciudad", "5 mil a 100 mil personas", 48], ["Ciudad o municipio", "100 mil a 1 millón", 64], ["Estado o región", "1 a 10 millones", 80], ["Nacional", "más de 10 millones", 92], ["Global", "población mundial", 100]];
  const ESC_PTS = [0, 1, 20, 500, 25000, 400000, 4000000, 20000000, 100000000];
  const GTIPO = { particular: "Particular", vecinal: "Vecinal / comunidad", sectorial: "Sector económico", gremial: "Gremio o sindicato", etario: "Grupo de edad", socioeconomico: "Grupo socioeconómico", publico: "Servidores públicos", seguridad: "Seguridad y fuerzas armadas", interes: "Grupo de interés", vulnerable: "Grupo vulnerable", general: "Población general" };
  const ROLN = [null, "Anecdótico", "Cotidiano", "Relevante para un sector", "Servicio o sector clave", "Estratégico"];
  const ACTN = [null, "Ciudadano común", "Local", "Regional o sectorial", "Nacional · alta influencia", "Máxima · global"];
  const RELN = v => v >= 80 ? "Estratégica" : v >= 60 ? "Alta" : v >= 40 ? "Media" : v >= 20 ? "Baja" : "Marginal";
  function afectados(an, pob) {
    let esc = an.esc | 0; if (!esc && pob) { esc = 1; for (let i = 8; i >= 1; i--) if (pob >= ESC_PTS[i]) { esc = i; break; } } if (!esc) return null;
    const rol = Math.max(1, an.rol | 0 || 2), act = an.act | 0, rel = Math.round(act ? ESCALA[esc][2] * 0.5 + rol / 5 * 100 * 0.25 + act / 5 * 100 * 0.25 : ESCALA[esc][2] * 0.65 + rol / 5 * 100 * 0.35);
    const wT = act ? 50 : 65, wR = act ? 25 : 35, comp = [{ nom: "Tamaño del grupo afectado", w: wT, v: ESCALA[esc][2], det: ESCALA[esc][0] + " · " + ESCALA[esc][1] }, { nom: "Importancia de su rol económico o social", w: wR, v: Math.round(rol / 5 * 100), det: ROLN[rol] }].concat(act ? [{ nom: "Influencia de los actores involucrados", w: 25, v: Math.round(act / 5 * 100), det: ACTN[act] + (an.actn ? " · " + an.actn : "") }] : []).map(c => Object.assign(c, { ap: Math.round(c.v * c.w) / 100 }));
    return { comp, esc, escN: ESCALA[esc][0], rango: ESCALA[esc][1], tipo: GTIPO[an.gtipo] ? an.gtipo : "", tipoN: GTIPO[an.gtipo] || "", grupo: an.grupo || "", rol, rolN: ROLN[rol], act, actN: ACTN[act] || "", actn: an.actn || "", rel, relN: RELN(rel) };
  }
  function indicadores(an) {
    if (!an) return null; const cl = (v, a, b) => Math.max(a, Math.min(b, +v || 0)), r1 = v => Math.round(v * 10) / 10;
    const tab = (W, o) => { let sc = 0, mx = 0; const filas = W.map(([k, nom, w]) => { const c = Math.round(cl(o && o[k], 0, 9)); sc += w * c; mx += w; return { k, nom, w, c, cw: w * c }; }); return { filas, score: sc, pct: mx ? r1(sc / mx * 100) : 0 }; };
    const pob = Math.max(0, Math.round(+an.pob || 0)), afe = afectados(an, pob), exp0 = r1(cl(Math.max(Math.log10(1 + pob) / 4 * 100, ALC[an.alc] || 0), 0, 100)), imp = afe ? afe.rel : exp0, expo = r1(cl(imp, 0, 100)), haz = r1(cl(an.haz, 0, 100));
    return { sent: an.sent != null ? cl(an.sent, 1, 9) : null, pol: an.pol != null ? cl(an.pol, 1, 10) : null, pob, afe, alc: an.alc || "", expo, imp: expo, impFb: !afe, haz, risk: r1(expo * haz / 100), grav: tab(WG, an.grav), viol: tab(WV, an.viol), scian: (an.scian || []).map(c => ({ c, n: SCIAN[c] || "Actividad (no mapeada)" })), riesgos: an.riesgos || [] };
  }
  const anCorto = x => { if (!x.an) return null; const i = indicadores(x.an); return { s: i.sent, r: i.risk, e: i.expo, h: i.haz, ec: i.afe && i.afe.escN, rl: i.afe && i.afe.relN, i: i.afe ? i.afe.rel : null, g: i.grav ? i.grav.pct : null, vi: i.viol ? i.viol.pct : null, p: i.pol != null ? Math.round(i.pol * 10) : null, so: x.an.soc ? { e: x.an.emo, t: x.an.tono, p: x.an.post } : undefined }; };
  async function llm(system, user, max, proy, k) {
    const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error("sin ANTHROPIC_API_KEY"); const modelos = [process.env.MEDIALAB_MODEL || "claude-haiku-5-5", "claude-sonnet-5"];
    for (const model of modelos) { const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model, max_tokens: max || 4000, system, messages: [{ role: "user", content: user }] }), signal: AbortSignal.timeout(60000) }); const j = await r.json().catch(() => ({})); if (r.ok && j.content) { uso("ia", { n: 1, in: (j.usage && j.usage.input_tokens) || 0, out: (j.usage && j.usage.output_tokens) || 0, mod: model, proy, k: k || 1 }); return (j.content.map(c => c.text || "").join("")); } if (r.status === 404 || (j.error && /model/i.test(j.error.message || ""))) continue; throw new Error((j.error && j.error.message) || "IA " + r.status); }
    throw new Error("IA no disponible");
  }
  function objetosJson(txt) {
    const i0 = txt.indexOf("["), out = []; if (i0 < 0) return out; let prof = 0, ini = -1, enStr = false, esc = false;
    for (let i = i0 + 1; i < txt.length; i++) {
      const c = txt[i]; if (enStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') enStr = false; continue; }
      if (c === '"') { enStr = true; continue; } if (c === "{") { if (prof === 0) ini = i; prof++; } else if (c === "}") { prof--; if (prof === 0 && ini >= 0) { try { out.push(JSON.parse(txt.slice(ini, i + 1))); } catch (_) { } ini = -1; } }
    }
    return out;
  }
  /* redes sociales: análisis ligero, solo de PERCEPCIÓN (sentimiento, polarización, emoción, tono y postura); no calcula riesgo, población ni sector */
  const SOC_EMO = ["enojo", "indignacion", "miedo", "tristeza", "burla", "apoyo", "esperanza", "neutral"], SOC_TONO = ["informativo", "denuncia", "opinion", "burla", "llamado", "otro"], SOC_POST = ["apoyo", "critica", "neutral"];
  const SYS_SOC = "Eres analista de percepción social en redes sociales de México. Recibes publicaciones públicas de Facebook (id, página, texto y, si se conoce, sus reacciones). Mide ÚNICAMENTE cómo se percibe y se narra el hecho. Devuelve SOLO un arreglo JSON con un objeto por publicación: {\"id\":\"<id recibido>\",\"sent\":1-9 (sentimiento de la publicación: 1 muy negativo, 5 neutro, 9 muy positivo),\"pol\":1-10 (polarización de la narrativa: 1 descriptiva y neutral, 10 lenguaje que divide, culpa o confronta),\"emo\":\"enojo|indignacion|miedo|tristeza|burla|apoyo|esperanza|neutral\" (emoción dominante que transmite o busca provocar),\"tono\":\"informativo|denuncia|opinion|burla|llamado|otro\",\"post\":\"apoyo|critica|neutral\" (postura hacia las autoridades o instituciones mencionadas; neutral si no hay)}. Usa las reacciones solo como apoyo cuando existan. No agregues texto fuera del JSON.";
  async function percepcionLote(items, proy) {
    const txt = await llm(SYS_SOC, JSON.stringify(items.map(x => ({ id: x.id, pagina: (x.soc && x.soc.pg) || x.med, texto: ((x.t || "") + " " + (x.d || "")).slice(0, 520), reacciones: x.soc && x.soc.rx && Object.keys(x.soc.rx).length ? x.soc.rx : undefined }))), 4000, proy, items.length);
    let arr; try { const m = txt.match(/\[[\s\S]*\]/); arr = m ? JSON.parse(m[0]) : null; } catch (_) { arr = null; } if (!arr) arr = objetosJson(txt); if (!arr.length) throw new Error("la IA no devolvió resultados utilizables"); const por = new Map(arr.map(a => [String(a.id), a])), en = (v, L, d) => { v = norm(String(v || "")); return L.includes(v) ? v : d; }; let n = 0;
    for (const x of items) { const a = por.get(String(x.id)); if (!a || a.sent == null) continue; x.an = { v: 1, soc: 1, sent: Math.max(1, Math.min(9, Math.round(+a.sent || 5))), pol: Math.max(1, Math.min(10, Math.round(+a.pol || 1))), emo: en(a.emo, SOC_EMO, "neutral"), tono: en(a.tono, SOC_TONO, "otro"), post: en(a.post, SOC_POST, "neutral") }; x.ia = 1; n++; }
    return n;
  }
  async function enriqueceLote(items, G, proy) {
    const lista = CATS.map(c => c.c + ": " + c.subs.join(", ")).join("\n");
    const txt = await llm(SYS_IA + "\nCategorías y subcategorías:\n" + lista + "\nSectores SCIAN permitidos (código y nombre):\n" + Object.entries(SCIAN).map(([c, n]) => c + " " + n.slice(0, 70)).join("\n"), JSON.stringify(items.map(x => ({ id: x.id, titulo: x.t, descripcion: (x.texto || x.d || "").slice(0, 600), medio: x.med }))), 8000, proy, items.length);
    let arr; try { const m = txt.match(/\[[\s\S]*\]/); arr = m ? JSON.parse(m[0]) : null; } catch (_) { arr = null; } if (!arr) arr = objetosJson(txt); if (!arr.length) throw new Error("la IA no devolvió resultados utilizables"); const por = new Map(arr.map(a => [a.id, a])); let n = 0;
    for (const x of items) {
      const a = por.get(x.id); if (!a) continue; if (a.cat && CATS.find(c => c.c === a.cat)) { x.cat = a.cat; x.sub = (CATS.find(c => c.c === a.cat).subs.includes(a.sub) ? a.sub : x.sub); }
      const L = a.lugar || {}; if (L.municipio || L.estado || L.colonia || L.sitio) { const t = [L.sitio, L.colonia, L.municipio, L.estado].filter(Boolean).join(", "); const g = lugarDe(t, [], G) || x.lug; if (g) { x.lug = Object.assign({}, g, { nivel: L.colonia || L.sitio ? (g.nivel === "municipio" ? "zona" : g.nivel) : g.nivel, zona: L.colonia || "", sitio: L.sitio || "", met: "ia", lat0: g.lat, lng0: g.lng, nivel0: g.nivel }); } }
      const e = x.ent || {}; x.ent = { pers: (a.personas || []).slice(0, 5), inst: (a.instituciones || []).slice(0, 5), top: [...new Set([...(a.temas || []).slice(0, 5), ...(e.top || [])])].slice(0, 8) }; if (a.resumen) x.res = String(a.resumen).slice(0, 260); const ob = v => (v && typeof v === "object" && !Array.isArray(v)) ? v : {}; x.an = { v: 1, sent: a.sent, pol: a.pol, haz: a.haz, pob: a.pob, alc: String(a.alc || "").toLowerCase(), esc: Math.max(0, Math.min(8, Math.round(+a.esc || 0))), gtipo: String(a.gtipo || "").toLowerCase().slice(0, 16), grupo: String(a.grupo || "").slice(0, 70), rol: Math.max(0, Math.min(5, Math.round(+a.rol || 0))), act: Math.max(0, Math.min(5, Math.round(+a.act || 0))), actn: String(a.actn || "").slice(0, 60), scian: (Array.isArray(a.scian) ? a.scian : []).map(c => String(c).trim()).filter(c => SCIAN[c]).slice(0, 3), grav: ob(a.grav), viol: ob(a.viol), riesgos: (Array.isArray(a.riesgos) ? a.riesgos : []).map(r => String(r).toLowerCase().slice(0, 20)).slice(0, 4) }; x.ia = 1; n++;
    }
    return n;
  }
  /* geocodificación opcional de zonas/sitios con Google Places (texto de búsqueda) */
  const GEO_C = new Map();
  async function geocodifica(x, G, proy) {
    const key = process.env.GOOGLE_MAPS_KEY, L = x.lug; if (!key || !L || !(L.zona || L.sitio) || L.chk) return false; L.chk = 1;
    const restaura = () => { let o = L.lat0 != null ? { lat: L.lat0, lng: L.lng0, nivel: L.nivel0 || "estado" } : null;
      if (!o && G) { const g = lugarDe([x.t, x.d].join(". "), [], G); o = g ? { lat: g.lat, lng: g.lng, nivel: g.nivel, mun: g.mun, munN: g.munN } : (G.edo[L.est] ? { lat: G.edo[L.est].lat, lng: G.edo[L.est].lng, nivel: "estado" } : null); } if (o) Object.assign(L, o); };
    if (/^(la |el )?(casa|domicilio|vivienda|residencia|departamento)\b/i.test(L.sitio || "")) L.sitio = "";   // domicilios particulares: no se ubican con precisión
    if (!(L.zona || L.sitio)) { restaura(); return false; }
    const q = [L.sitio, L.zona, L.munN, L.estN].filter(Boolean).join(", "); let r = GEO_C.get(q);
    if (r === undefined) { uso("places", { n: 1, proy }); try { const rs = await fetch("https://places.googleapis.com/v1/places:searchText", { method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "places.location,places.formattedAddress" }, body: JSON.stringify({ textQuery: q, languageCode: "es", regionCode: "MX", maxResultCount: 1 }), signal: AbortSignal.timeout(12000) }); const j = await rs.json(), pl = j.places && j.places[0]; r = pl && pl.location ? { lat: pl.location.latitude, lng: pl.location.longitude, dir: pl.formattedAddress || "" } : null; } catch (_) { r = null; } GEO_C.set(q, r); }
    const okEdo = r && (!L.estN || norm(r.dir).includes(norm(L.estN)));   // el resultado debe caer en el estado de la nota
    if (okEdo) { L.lat = r.lat; L.lng = r.lng; L.nivel = L.sitio ? "punto" : "zona"; L.met = "places"; return true; }
    restaura(); return false;
  }

  /* ───────── extracción por rebanadas ───────── */
  const BLOQ = new Set(); let GDELT_MALO = 0;   // marca de tiempo del último momento en que GDELT no respondió desde el servidor
  function planea(p, desde, hasta, prov) {
    const cfg = p.config, T = limpiaTerminos(cfg.terminos), G = gruposZ(T.pos, prov || cfg.proveedor, cfg.zona || {});
    const pv = prov || cfg.proveedor; let cola = [];
    if (esFb(pv)) {   // Facebook: ventanas de días completos que NO se traslapan (se paga por publicación devuelta); se subdividen solo si una consulta se llena
      const dia0 = x => { const d = new Date(x); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }, a = dia0(desde), b = dia0(hasta), paso = 7 * 864e5;
      for (let fin = b; fin >= a;) { const ini = Math.max(a, fin - (paso - 864e5)); G.forEach((_, g) => cola.push([g, new Date(ini).toISOString(), new Date(fin).toISOString()])); fin = ini - 864e5; }
    } else if (pv === "grss") {   // ventanas de 7 días (14 si hay muchísimos grupos): cada consulta de Google Noticias se queda corta si abarca meses
      const a = new Date(desde).getTime(), b = new Date(hasta).getTime(), paso = (pv === "fbapify" ? Math.max(1, Math.min(+cfg.fbDias || 7, 90)) : G.length > 50 ? 14 : 7) * 864e5;
      for (let t = b; t > a; t -= paso) { const ini = Math.max(a, t - paso); G.forEach((_, g) => cola.push([g, new Date(ini).toISOString(), new Date(t).toISOString()])); }
    } else cola = G.map((_, g) => [g, desde, hasta]);
    return { cola, total: cola.length, neg: T.neg };
  }
  function ventana(p, inicial) {
    const cfg = p.config, h = new Date(); let d;
    if (cfg.periodo && cfg.periodo.tipo === "fijo" && cfg.periodo.desde) { d = new Date(cfg.periodo.desde); if (cfg.periodo.hasta && inicial) { const hh = new Date(cfg.periodo.hasta); return [d.toISOString(), (hh < h ? hh : h).toISOString()]; } }
    else d = new Date(h.getTime() - ((cfg.periodo && cfg.periodo.dias) || 7) * 864e5);
    if (!inicial && p.estado && p.estado.ultima && p.estado.total > 0) d = new Date(Math.max(d.getTime(), new Date(p.estado.ultima).getTime() - 36e5));
    return [d.toISOString(), h.toISOString()];
  }
  async function inicia(id, completa) {
    const c = await leeIdx(true), p = c.d.proyectos.find(x => x.id === id); if (!p) throw new Error("proyecto no encontrado");
    const [d, h] = ventana(p, completa || !p.estado || !p.estado.ultima || !(p.estado.total > 0)), usaG = p.config.proveedor === "gdelt" && Date.now() - Math.max(GDELT_MALO, c.d.gdeltMalo || 0) < 216e5, prv = usaG ? "grss" : p.config.proveedor, pl = planea(p, d, h, prv); if (!pl.total) throw new Error("el proyecto no tiene términos válidos");
    await mutaIdx(ix => { const q = ix.proyectos.find(x => x.id === id); q.estado = Object.assign(q.estado || {}, { trabajo: { fase: "extraccion", cola: pl.cola, total: pl.total, hecho: 0, nuevas: 0, vistas: 0, errores: 0, ultimoError: "", inicio: ahoraIso(), ia: { pend: [], hecho: 0 }, desde: d, hasta: h, prov: usaG ? "grss" : undefined, aviso: usaG ? "GDELT no responde desde el servidor; se usa Google Noticias." : undefined } }); });
    return pl.total;
  }
  const PARAR = new Set();
  async function avanza(id, ms) {
    if (BLOQ.has(id)) return { ocupado: true }; BLOQ.add(id); let hbt = null;
    try {
      const c = await leeIdx(true), p = c.d.proyectos.find(x => x.id === id); if (!p || !p.estado || !p.estado.trabajo || p.estado.trabajo.fase === "fin") { if (p && p.estado && p.estado.parar) await mutaIdx(ix => { const q = ix.proyectos.find(x => x.id === id); if (q && q.estado) delete q.estado.parar; }); return { fin: true }; }
      if (p.estado.parar) { const run = p.estado.trabajo.fb && p.estado.trabajo.fb.run; await mutaIdx(ix => { const q = ix.proyectos.find(x => x.id === id); if (q && q.estado) { delete q.estado.parar; const t = q.estado.trabajo; if (t) { t.fase = "fin"; t.cola = []; t.fb = null; t.aviso = "Extracción detenida por el usuario."; } q.estado.ultima = ahoraIso(); } }); if (run) apPost(`/v2/actor-runs/${run}/abort`, {}, 20000).catch(() => { }); return { fin: true, fase: "fin", detenida: true }; }
      const w = p.estado.trabajo, cfg = p.config, t0 = Date.now(), X = await cargaNoticias(id), G = await gaz(), T = limpiaTerminos(cfg.terminos), negs = T.neg.map(norm);
      let prov = w.prov || cfg.proveedor, grs = gruposZ(T.pos, prov, cfg.zona || {}); const idx = new Map(X.items.map((n, i) => [n.id, i])), idT = new Set(X.items.map(claveTit)), idP = new Set(X.items.map(n => n.soc && n.soc.pid).filter(Boolean)), maxN = Math.min(+cfg.maxNoticias || 5000, 50000), limite = t0 + ms;
      const nuevas0 = w.nuevas || 0; const act = m => { w.act = { m, t: Date.now() }; }, dia = x => new Date(x).toISOString().slice(0, 10); let guardando = false;
      { let nrev = 0; for (const x of X.items) { if (nrev >= 20) break; if (x.lug && (x.lug.nivel === "punto" || x.lug.nivel === "zona") && !x.lug.chk) { await geocodifica(x, G, id); nrev++; X.sucio = true; } } }
      act("Iniciando el tramo de trabajo…");
      let alto = false; hbt = setInterval(async () => { if (guardando) return; guardando = true; try { await mutaIdx(ix => { const q = ix.proyectos.find(x => x.id === id); if (q && q.estado) { if (q.estado.parar) alto = true; q.estado.trabajo = w; } }); } catch (_) { } guardando = false; }, 6000);
      const aGrss = motivo => { GDELT_MALO = Date.now(); mutaIdx(ix => { ix.gdeltMalo = Date.now(); }).catch(() => { }); const pl = planea(p, w.desde, w.hasta, "grss"); prov = "grss"; w.prov = "grss"; grs = grupos(T.pos, "grss", zonaConsulta(cfg.zona || {})); w.cola = pl.cola; w.total = pl.total; w.hecho = 0; w.errores = 0; w.ultimoError = ""; w.aviso = motivo || "GDELT no respondió desde el servidor (límite de consultas); se continuó con Google Noticias."; };
      const mete = async raws => { for (const raw of raws) { w.vistas++; const n = await normaliza(raw, p, G); if (!n) continue; n.prov = prov; if (esFb(prov) && !fbPasa(n, T.pos, cfg.zona)) { w.fuera = (w.fuera || 0) + 1; continue; } const nt = norm(n.t + " " + n.d); if (negs.some(x => nt.includes(x))) continue; if (cfg.zona && cfg.zona.estados && cfg.zona.estados.length && cfg.zona.estricta && n.lug && !cfg.zona.estados.includes(n.lug.est)) continue; if (cfg.medios && cfg.medios.length && !cfg.medios.some(m => (n.dom || "").includes(m.toLowerCase()))) continue; if (idx.has(n.id)) { w.dup = (w.dup || 0) + 1; const e = X.items[idx.get(n.id)]; if (n.ent.top.length) e.ent.top = [...new Set([...(e.ent.top || []), ...n.ent.top])].slice(0, 8); continue; } if (n.soc && n.soc.pid) { if (idP.has(n.soc.pid)) { w.dup = (w.dup || 0) + 1; continue; } idP.add(n.soc.pid); } const kt = claveTit(n); if (idT.has(kt)) { w.dup = (w.dup || 0) + 1; continue; } idT.add(kt); idx.set(n.id, X.items.length); X.items.push(n); w.nuevas++; X.sucio = true; } };
      /* Facebook combinado, por lotes y sin bloquear: cada llamada revisa el estado de la ejecución en Apify y regresa; así no se pierde trabajo aunque Google tarde minutos */
      const fbmixPaso = async () => {
        const hdr = { headers: { Authorization: "Bearer " + process.env.APIFY_TOKEN, Accept: "application/json" } }, f = x => new Date(x).toISOString().slice(0, 10);
        const lee = async run => JSON.parse(await jget(`https://api.apify.com/v2/actor-runs/${run}?waitForFinish=20`, 45000, hdr)).data, datos = async ds => JSON.parse(await jget(`https://api.apify.com/v2/datasets/${ds}/items?clean=1&limit=3000`, 60000, hdr));
        const cierra = F => { w.fb = null; F.lote.forEach((c, i) => { w.hecho++; const a = new Date(c[1]).getTime(), b = new Date(c[2]).getTime(), dd = Math.round((b - a) / 864e5) + 1; if ((F.sat || []).includes(i) && dd > 1) { const m = Math.floor(dd / 2); w.cola.unshift([c[0], c[1], new Date(a + (m - 1) * 864e5).toISOString(), 0], [c[0], new Date(a + m * 864e5).toISOString(), c[2], 0]); w.total++; w.hecho--; } });
          if ((w.fbUsd || 0) >= (+cfg.fbMax || 5) && w.cola.length) { w.aviso = `Se alcanzó el presupuesto de Apify de esta extracción (${(+cfg.fbMax || 5).toFixed(2)} USD): quedaron ${w.cola.length} consulta(s) sin hacer, de las fechas más antiguas. Súbelo en la edición del proyecto si quieres más.`; w.cola = []; } };
        const F = w.fb;
        if (!F) {
          const it = w.cola.shift(); if (!it) { entraFase(w, cfg, X, "ia"); return "sigue"; }
          const lote = [it]; for (let i = 0; i < w.cola.length && lote.length < 10;) { const c = w.cola[i]; if (c[1] === it[1] && c[2] === it[2]) { lote.push(c); w.cola.splice(i, 1); } else i++; }
          const qs = lote.map(c => `site:facebook.com ${grs[c[0]]} after:${f(new Date(c[1]).getTime() - 864e5)} before:${f(new Date(c[2]).getTime() + 864e5)}`);
          const run = JSON.parse(await apPost("/v2/acts/apify~google-search-scraper/runs?timeout=900", { queries: qs.join("\n"), maxPagesPerQuery: FBM_PAG, resultsPerPage: 10, countryCode: "mx", languageCode: "es", mobileResults: false, saveHtml: false, includeUnfilteredResults: true, maxConcurrency: 10 }, 60000)).data;
          w.fb = { fase: "g", run: run.id, ds: run.defaultDatasetId, lote, qs, t: Date.now() }; act(`Google está buscando ${lote.length} término(s) · ${dia(it[1])} → ${dia(it[2])}`); return "espera";
        }
        const run = await lee(F.run), seg = Math.round((Date.now() - F.t) / 1000);
        if (run && (run.status === "READY" || run.status === "RUNNING")) { act(`${F.fase === "g" ? "Google sigue buscando" : "Leyendo " + (F.cand || []).length + " publicaciones en Facebook"} · ${dia(F.lote[0][1])} → ${dia(F.lote[0][2])} · ${seg} s (cada lote suele tardar de 1 a 4 minutos)`); return "espera"; }
        if (F.fase === "g") {
          let pags = []; try { pags = await datos(F.ds); } catch (_) { } if (!Array.isArray(pags)) pags = [];
          if (pags.length) { uso("gserp", { n: pags.length, proy: id }); w.fbUsd = (w.fbUsd || 0) + pags.length * (TARIFAS0.gserp || 0); }
          if (!pags.length) { w.errores++; w.ultimoError = "Google no devolvió resultados para un lote (" + ((run && run.status) || "sin estado") + ")"; cierra(F); return "sigue"; }
          const cnt = new Map(); pags.forEach(pg => { const t = (pg.searchQuery && pg.searchQuery.term) || ""; cnt.set(t, (cnt.get(t) || 0) + (pg.organicResults || []).length); }); F.sat = F.qs.map((q, i) => (cnt.get(q) || 0) >= FBM_PAG * 10 ? i : -1).filter(i => i >= 0);
          const org = pags.flatMap(pg => pg.organicResults || []), cand = fbmCand(org, T.pos, cfg.zona || {}, G, u => idx.has(sha(urlClave(u))), 200); w.vistas += org.length; w.fuera = (w.fuera || 0) + (org.length - cand.length);
          if (!cand.length) { act(`Google encontró ${org.length} enlaces; ninguno nuevo menciona el término y la zona`); cierra(F); return "sigue"; }
          const r2 = JSON.parse(await apPost("/v2/acts/mina_safwat~facebook-post-scraper-ppr/runs?timeout=900", { urls: cand.map(c => c.url), maxConcurrency: 10 }, 60000)).data;
          w.fb = Object.assign({}, F, { fase: "p", run: r2.id, ds: r2.defaultDatasetId, cand, t: Date.now() }); act(`Google encontró ${org.length} enlaces; ${cand.length} mencionan el término y la zona. Leyendo esas publicaciones…`); return "espera";
        }
        let det = []; try { det = await datos(F.ds); } catch (_) { } if (!Array.isArray(det)) det = [];
        if (det.length) { uso("fbpost", { n: det.length, proy: id }); w.fbUsd = (w.fbUsd || 0) + det.length * (TARIFAS0.fbpost || 0); }
        const items = fbmItems(F.cand || [], det); if (!items.length && (F.cand || []).length) { w.errores++; w.ultimoError = "No se pudieron leer las publicaciones de un lote (" + ((run && run.status) || "sin estado") + ")"; }
        await mete(items); act(`Lote listo: ${items.length} publicaciones leídas · gasto acumulado ${(w.fbUsd || 0).toFixed(2)} USD`); cierra(F); return "sigue";
      };
      while (Date.now() - t0 < ms) {
        if (alto || PARAR.has(id)) break;
        if (w.fase === "extraccion" && prov === "fbmix") {
          if (!w.limpio) { w.limpio = 1; let q = 0; X.items.forEach(n => { if (n.soc && !n.desc && !fbPasa(n, T.pos, cfg.zona)) { n.desc = 1; q++; } }); if (q) X.sucio = true; }
          let r0; try { r0 = await fbmixPaso(); } catch (e) { w.errores++; w.ultimoError = String(e.message).slice(0, 200); w.fbErr = (w.fbErr || 0) + 1; if (w.fbErr >= 6) { if (w.fb) { w.hecho += w.fb.lote.length; w.fb = null; } w.fbErr = 0; } break; }
          w.fbErr = 0; if (r0 === "espera") break; if (w.fase === "fin") break; continue;
        }
        if (w.fase === "extraccion") {
          if (esFb(prov) && !w.limpio) { w.limpio = 1; let q = 0; X.items.forEach(n => { if (n.soc && !n.desc && !fbPasa(n, T.pos, cfg.zona)) { n.desc = 1; q++; } }); if (q) { X.sucio = true; act(`Se descartaron ${q} publicaciones guardadas que no mencionan el término y la zona`); } }
          const it = w.cola.shift(); if (!it) { if (prov === "gdelt" && !w.vistas && !w.aviso) { aGrss("GDELT no devolvió notas para estas consultas; se continuó con Google Noticias."); continue; } entraFase(w, cfg, X, "ia"); continue; }
          act(`Consultando ${prov === "grss" ? "Google Noticias" : prov === "gdelt" ? "GDELT" : prov === "fbapify" ? "Facebook (Apify)" : prov === "fbmix" ? "Google + Facebook" : prov} · consulta ${w.hecho + 1} de ${w.total} · ${dia(it[1])} → ${dia(it[2])}`);
          if (!esFb(prov)) uso(prov, { n: 1, proy: id }); let r; try { r = await FETCH[prov](cfg, grs[it[0]], it[1], it[2], limite, act, { ya: u => idx.has(sha(urlClave(u))) }); w.gfallos = 0; if (r.usos) r.usos.forEach(([sv, n]) => uso(sv, { n, proy: id })); else if (prov === "fbapify") uso(prov, { n: r.crudo || r.items.length, proy: id }); act(`Recibidas ${r.items.length} notas del servicio; procesando…`); } catch (e) {
            if (e.reintentar) { if (prov === "gdelt" && e.limitado && (w.gfallos = (w.gfallos || 0) + 1) >= 2) { aGrss(); continue; } w.cola.unshift(it); break; }
            if (e.limitado && esFb(prov)) { w.errores++; w.ultimoError = `Apify limitó el ritmo de consultas (plan gratuito): la extracción se detuvo con ${w.cola.length + 1} consulta(s) pendientes. Vuelve a extraer más tarde o sube de plan en Apify.`; w.cola = []; w.fase = "fin"; continue; }
            w.errores++; w.ultimoError = String(e.message).slice(0, 200); it[3] = (it[3] || 0) + 1;
            if (prov === "gdelt" && (e.limitado || /GDELT/.test(w.ultimoError)) && (w.gfallos = (w.gfallos || 0) + 1) >= 2) { aGrss(); continue; }
            if (it[3] < 3) w.cola.push(it); else w.hecho++; if (/clave|NEWSDATA_API_KEY|GNEWS_API_KEY/.test(w.ultimoError)) { w.fase = "fin"; w.cola = []; } continue; }
          await mete(r.items);
          if (esFb(prov)) { w.fbUsd = (w.fbUsd || 0) + (r.usd != null ? r.usd : (r.crudo || r.items.length) * 0.004); const a = new Date(it[1]).getTime(), b = new Date(it[2]).getTime(), dd = Math.round((b - a) / 864e5) + 1;
            if (r.saturado && dd > 1) { const m = Math.floor(dd / 2), c1 = new Date(a + (m - 1) * 864e5).toISOString(), c2 = new Date(a + m * 864e5).toISOString(); w.cola.unshift([it[0], it[1], c1, 0], [it[0], c2, it[2], 0]); w.total++; w.hecho--; }
            if (w.fbUsd >= (+cfg.fbMax || 5)) { w.aviso = `Se alcanzó el presupuesto de Apify de esta extracción (${(+cfg.fbMax || 5).toFixed(2)} USD): quedaron ${w.cola.length} consulta(s) sin hacer, de las fechas más antiguas. Súbelo en la edición del proyecto si quieres más.`; w.cola = []; }
          } else if (r.saturado) { const a = new Date(it[1]).getTime(), b = new Date(it[2]).getTime(); if (b - a > 3 * 36e5) { const m = new Date((a + b) / 2).toISOString(); w.cola.unshift([it[0], it[1], m, 0], [it[0], m, it[2], 0]); w.total++; w.hecho--; } }
          w.hecho++;
        } else if (w.fase === "texto") {
          const ids = w.tx.pend.splice(0, 16); if (!ids.length) { w.fase = "fin"; continue; } act(`Descargando el texto de las notas: ${w.tx.hecho + w.tx.fallos} hechas, ${w.tx.pend.length + ids.length} por hacer`);
          const lote = ids.map(i => X.items[idx.get(i)]).filter(Boolean); const ok = await Promise.all(lote.map(n => bajaTexto(n, id))); w.tx.hecho += ok.filter(Boolean).length; w.tx.fallos += ok.filter(x => !x).length; X.sucio = true;
        } else if (w.fase === "enriquecimiento") {
          const ids = w.ia.pend.splice(0, 30); if (!ids.length) { entraFase(w, cfg, X, "tx"); continue; } w.ia.vuelo = ids.length; act(`Enriqueciendo con IA: ${w.ia.hecho} listas, ${w.ia.pend.length + ids.length} por hacer`); const lotes = []; for (let k = 0; k < ids.length; k += 10) lotes.push(ids.slice(k, k + 10).map(i => X.items[idx.get(i)]).filter(Boolean));
          const rs = await Promise.all(lotes.map(async lote => { try { if (esFb(prov)) return await percepcionLote(lote, id); const n = await enriqueceLote(lote, G, id); if (cfg.geocodificar) for (const x of lote) await geocodifica(x, G, id); return n; } catch (e) { return e instanceof Error ? e : new Error(String(e)); } })); X.sucio = true;
          w.ia.vuelo = 0; for (const r of rs) { if (typeof r === "number") w.ia.hecho += r; else { w.ultimoError = "IA: " + String(r.message).slice(0, 160); w.errores++; if (/ANTHROPIC|credit|billing|auth/i.test(w.ultimoError)) w.fase = "fin"; } }
        } else break;
        if (w.fase === "fin") break;
      }
      if (X.items.length > maxN) { X.items.sort((a, b) => (b.f > a.f ? 1 : -1)); X.items.length = maxN; }
      uso("notas", { n: (w.nuevas || 0) - nuevas0, proy: id });
      if (X.sucio) await guardaNoticias(id, X);
      await mutaIdx(ix => { const q = ix.proyectos.find(x => x.id === id); if (!q) return; q.estado.trabajo = w; q.estado.total = X.items.length; { const fs = X.items.map(n => n.f).filter(Boolean).sort(); q.estado.rango = fs.length ? [fs[0], fs[fs.length - 1]] : null; } if (w.fase === "fin") { q.estado.ultima = ahoraIso(); q.estado.ultimaNuevas = w.nuevas; q.estado.proxima = proxima(q.config.periodicidad); } });
      return { fase: w.fase, hecho: w.hecho, total: w.total, nuevas: w.nuevas, errores: w.errores, ultimoError: w.ultimoError, aviso: w.aviso, prov: w.prov || cfg.proveedor };
    } finally { clearInterval(hbt); BLOQ.delete(id); vuelcaUso().catch(() => { }); }
  }
  const PER_MS = { horaria: 864e5, "6h": 864e5, diaria: 864e5, semanal: 6048e5, quincenal: 1296e6 };   /* «horaria» y «6h» ya no se ofrecen: los proyectos que las tenían corren a diario */
  const proxima = per => PER_MS[per] ? new Date(Date.now() + PER_MS[per]).toISOString() : null;

  /* ───────── consulta filtrada para el tablero ───────── */
  // Búsqueda amplia: todos los campos de texto de la nota (título, resumen, cuerpo, lugar, medio, categoría, entidades, análisis…)
  const PAJAR = new WeakMap();
  function pajar(n) {
    let h = PAJAR.get(n); if (h !== undefined) return h; const out = [];
    const rec = (v, dep) => { if (v == null || dep > 5) return; if (typeof v === "string") { if (v.length < 60000) out.push(v); } else if (typeof v === "number") out.push(String(v)); else if (Array.isArray(v)) v.forEach(x => rec(x, dep + 1)); else if (typeof v === "object") for (const k of Object.keys(v)) { if (k === "img" || k === "emb") continue; rec(v[k], dep + 1); } };
    rec(n, 0); h = norm(out.join(" ")); PAJAR.set(n, h); return h;
  }
  /* rango por índice: rg = "r:20-80,o:10-100" (o relevancia, r riesgo, i impacto, g gravedad, vi violencia, p polarización) */
  const rgParse = t => { const o = []; String(t || "").split(",").forEach(x => { const m = /^(o|r|i|g|vi|p):(\d{1,3})-(\d{1,3})$/.exec(x); if (m) { const a = Math.min(+m[2], +m[3]), b = Math.max(+m[2], +m[3]); if (a > 0 || b < 100) o.push([m[1], a, b]); } }); return o.length ? o : null; };
  const rgAn = new WeakMap();
  const rgPasa = (n, RG) => { let a = null; if (n.an) { a = rgAn.get(n.an); if (!a) { a = anCorto(n); rgAn.set(n.an, a); } }
    return RG.every(([k, lo, hi]) => { const v = k === "o" ? (n.rob ? n.rob.v : null) : a ? a[k] : null; return v != null && v >= lo && v <= hi; }); };
  /* filtro por actividad económica: un sector SCIAN ("46") o un giro de GeoLab ("g:comercio"), que agrupa varios sectores */
  const GIROS_SC = { agro: ["11"], mineria_energia: ["21", "22"], construccion: ["23"], manufacturas: ["31-33"], comercio: ["43", "46"], transporte_info: ["48-49", "51"], finanzas_inmob: ["52", "53"], servicios_neg: ["54", "55", "56", "81"], turismo: ["71", "72"], social: ["61", "62", "93"] };
  const scSet = v => { v = String(v || ""); if (!v) return null; const L = v.startsWith("g:") ? (GIROS_SC[v.slice(2)] || []) : v.split(",").map(x => x.trim()).filter(Boolean); return L.length ? new Set(L) : null; };
  function filtra(items, q, omitir) {
    const ws = norm(q.q || "").split(/\s+/).filter(Boolean), d0 = q.desde ? new Date(q.desde).getTime() : 0, h0 = q.hasta ? new Date(q.hasta).getTime() + 864e5 : Infinity;
    const [et, ev] = String(q.ent || "").split(/:(.+)/);
    const RG = rgParse(q.rg), SC = scSet(q.scian), CE = (() => { const m = String(q.cerca || "").split(",").map(Number); return m.length === 3 && m.every(isFinite) && m[2] > 0 ? { la: m[0], ln: m[1], km: Math.min(m[2], 500), kx: 111.32 * Math.cos(m[0] * Math.PI / 180) } : null; })();
    return items.filter(n => {
      if (n.desc) return false;
      if (RG && !rgPasa(n, RG)) return false;
      if (+q.rmin > 0 && !(n.soc && (n.soc.r || 0) >= +q.rmin)) return false;
      if (omitir !== "cat" && q.cat && n.cat !== q.cat) return false; if (omitir !== "sub" && q.sub && n.sub !== q.sub) return false;
      if (omitir !== "tx" && (q.tx === "0" || q.tx === "1" || q.tx === "2") && String(estTx(n)) !== q.tx) return false;
      if (omitir !== "reg" && q.reg && !(n.lug && REG[n.lug.est] === q.reg)) return false; if (omitir !== "zona" && q.zona && !(n.lug && n.lug.zona === q.zona)) return false;
      if (omitir !== "est" && q.est && !(n.lug && n.lug.est === q.est)) return false; if (omitir !== "mun" && q.mun && !(n.lug && n.lug.mun === q.mun)) return false;
      if (CE && !(n.lug && n.lug.lat != null && Math.hypot((n.lug.lng - CE.ln) * CE.kx, (n.lug.lat - CE.la) * 111.32) <= CE.km)) return false;
      if (SC && omitir !== "scian" && !(n.an && (n.an.scian || []).some(c => SC.has(c)))) return false;
      if (omitir !== "med" && q.med && n.med !== q.med) return false; if (omitir !== "prov" && q.prov && fuenteDe(n) !== q.prov) return false; const f = new Date(n.f).getTime(); if (f < d0 || f > h0) return false;
      if (omitir !== "ent" && ev) { const L = et === "pers" ? n.ent.pers : et === "inst" ? n.ent.inst : n.ent.top; if (!(L || []).includes(ev)) return false; }
      if (q.geo === "1" && !(n.lug && n.lug.lat != null)) return false;
      if (ws.length) { const h = pajar(n); if (!ws.every(w => h.includes(w))) return false; } return true;
    });
  }
  const estTx = n => n.texto ? 1 : n.txErr ? 2 : 0;
  const fuenteDe = n => /news\.google\.com/.test(n.url || "") ? "grss" : (n.prov === "grss" ? "gdelt" : n.prov || "gdelt");
  const cuenta = (arr, f, top) => { const m = new Map(); arr.forEach(x => { const k = f(x); (Array.isArray(k) ? k : [k]).forEach(v => { if (v) m.set(v, (m.get(v) || 0) + 1); }); }); return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top || 40).map(([v, n]) => ({ v, n })); };
  function facetas(items, q) {
    const F = {}; F.cat = cuenta(filtra(items, q, "cat"), n => n.cat); F.sub = cuenta(filtra(items, q, "sub"), n => n.sub);
    F.est = cuenta(filtra(items, q, "est"), n => n.lug && n.lug.est).map(x => ({ v: x.v, n: x.n, nom: ESTADOS[x.v] }));
    const mm = new Map(); filtra(items, q, "mun").forEach(n => { if (n.lug && n.lug.mun && (!q.est || n.lug.est === q.est)) { const o = mm.get(n.lug.mun) || { v: n.lug.mun, n: 0, nom: n.lug.munN + ", " + ESTADOS[n.lug.est] }; o.n++; mm.set(n.lug.mun, o); } }); F.mun = [...mm.values()].sort((a, b) => b.n - a.n).slice(0, 60);
    F.reg = cuenta(filtra(items, q, "reg"), n => n.lug && REG[n.lug.est]); F.zona = cuenta(filtra(items, q, "zona"), n => n.lug && n.lug.zona, 60);
    F.tx = cuenta(filtra(items, q, "tx"), n => String(estTx(n))); F.scian = cuenta(filtra(items, q, "scian"), n => n.an && n.an.scian, 30).map(x => ({ v: x.v, n: x.n, nom: SCIAN[x.v] || x.v }));
    F.med = cuenta(filtra(items, q, "med"), n => n.med, 60); F.prov = cuenta(filtra(items, q, "prov"), fuenteDe); const e = filtra(items, q, "ent");
    F.pers = cuenta(e, n => n.ent.pers, 200); F.inst = cuenta(e, n => n.ent.inst, 200); F.top = cuenta(e, n => n.ent.top, 200); return F;
  }
  const sigue = req => { try { return D.originOk(req); } catch (_) { return true; } };

  /* ───────── endpoints ───────── */
  const R = "/geometrika/medialab";
  const wrap = f => async (req, res) => { try { if (!sigue(req)) return res.status(403).json({ ok: false }); await f(req, res); } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 240) }); } };
  const SIT_OK = { activo: 1, suspendido: 1, inactivo: 1 }, VIS_OK = { publico: 1, privado: 1, usuarios: 1 }, ROL_OK = { lector: 1, editor: 1, administrador: 1 };
  const hoyMx = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
  /* costo incurrido por proyecto (todo el historial y mes en curso) */
  async function costosProy() {
    await vuelcaUso(); const { data } = await D.readGcs(USO), U = data || { d: {}, tarifas: null }, T = Object.assign({}, TARIFAS0, U.tarifas || {}); if (U.tarifas && U.tarifas.ia) T.ia = Object.assign({}, TARIFAS0.ia, U.tarifas.ia);
    const mes = hoyMx().slice(0, 7), out = {}; Object.keys(U.d).forEach(f => Object.keys(U.d[f]).forEach(pr => Object.entries(U.d[f][pr]).forEach(([sv, e]) => { if (sv === "notas") return; const c = costoDe(sv, e, T), o = out[pr] = out[pr] || { total: 0, mes: 0 }; o.total += c; if (f.slice(0, 7) === mes) o.mes += c; })));
    Object.values(out).forEach(o => { o.total = Math.round(o.total * 1000) / 1000; o.mes = Math.round(o.mes * 1000) / 1000; }); return out;
  }
  /* vigencia: a partir de la fecha el proyecto pasa solo a inactivo */
  async function venceVigencias() {
    const hoy = hoyMx(), c = await leeIdx(); const v = c.d.proyectos.filter(p => p.vigencia && p.vigencia < hoy && (p.situacion || "activo") !== "inactivo"); if (!v.length) return 0;
    await mutaIdx(ix => { ix.proyectos.forEach(p => { if (p.vigencia && p.vigencia < hoy && (p.situacion || "activo") !== "inactivo") { p.situacion = "inactivo"; p.situacionMotivo = "vigencia"; p.estado = p.estado || {}; p.estado.proxima = null; const w = p.estado.trabajo; if (w && w.fase !== "fin") { w.fase = "fin"; w.aviso = "Extracción detenida: venció la vigencia del proyecto."; w.act = null; } } }); });
    return v.length;
  }
  /* limpia los datos de gestión que llegan del cliente */
  function limpiaGestion(b, p) {
    const o = {}; if (b.situacion !== undefined) { if (!SIT_OK[b.situacion]) throw new Error("situación no válida"); o.situacion = b.situacion; }
    if (b.visibilidad !== undefined) { if (!VIS_OK[b.visibilidad]) throw new Error("visibilidad no válida"); o.visibilidad = b.visibilidad; }
    if (b.usuarios !== undefined) o.usuarios = (Array.isArray(b.usuarios) ? b.usuarios : []).map(u => ({ id: String((u && (u.id || u.correo || u.nombre)) || "").trim().slice(0, 80), nombre: String((u && u.nombre) || "").trim().slice(0, 80), rol: ROL_OK[u && u.rol] ? u.rol : "lector" })).filter(u => u.id).slice(0, 100);
    if (b.vigencia !== undefined) { const v = String(b.vigencia || ""); if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error("fecha de vigencia no válida"); o.vigencia = v; }
    if (b.presupuesto !== undefined) { const n = +b.presupuesto; if (!(n >= 0) || !isFinite(n)) throw new Error("presupuesto no válido"); o.presupuesto = Math.round(n * 100) / 100; }
    const vig = o.vigencia !== undefined ? o.vigencia : (p && p.vigencia) || "", sit = o.situacion || (p && p.situacion) || "activo"; if (vig && vig < hoyMx() && sit !== "inactivo") throw new Error("La vigencia ya venció: amplía la fecha o deja el proyecto inactivo");
    return o;
  }
  const pub = p => ({ id: p.id, situacion: SIT_OK[p.situacion] ? p.situacion : "activo", motivo: p.situacionMotivo || "", vigencia: p.vigencia || "", presupuesto: +p.presupuesto || 0, visibilidad: VIS_OK[p.visibilidad] ? p.visibilidad : "publico", usuarios: Array.isArray(p.usuarios) ? p.usuarios : [], titulo: p.titulo, objetivo: p.objetivo, padre: p.padre || "", creado: p.creado, creador: p.creador || "", config: Object.assign({}, p.config, { terminos: undefined, nTerminos: limpiaTerminos(p.config.terminos).pos.length }), estado: Object.assign({}, p.estado || {}, { trabajo: p.estado && p.estado.trabajo ? { fase: p.estado.trabajo.fase, hecho: p.estado.trabajo.hecho, total: p.estado.trabajo.total, nuevas: p.estado.trabajo.nuevas, errores: p.estado.trabajo.errores, ultimoError: p.estado.trabajo.ultimoError, aviso: p.estado.trabajo.aviso, prov: p.estado.trabajo.prov, dup: p.estado.trabajo.dup, desde: p.estado.trabajo.desde, hasta: p.estado.trabajo.hasta, act: p.estado.trabajo.act, inicio: p.estado.trabajo.inicio, vistas: p.estado.trabajo.vistas, ia: { hecho: p.estado.trabajo.ia && p.estado.trabajo.ia.hecho, pend: ((p.estado.trabajo.ia && p.estado.trabajo.ia.pend && p.estado.trabajo.ia.pend.length) || 0) + ((p.estado.trabajo.ia && p.estado.trabajo.ia.vuelo) || 0) }, tx: { hecho: p.estado.trabajo.tx && p.estado.trabajo.tx.hecho, fallos: p.estado.trabajo.tx && p.estado.trabajo.tx.fallos, pend: p.estado.trabajo.tx && p.estado.trabajo.tx.pend && p.estado.trabajo.tx.pend.length } } : null }) });
  /* catálogo de medios ya guardados: crece solo conforme se extraen noticias (se conserva aunque se borre un proyecto) */
  const MEDIOSF = "medialab/medios.json";
  app.get(R + "/medios", wrap(async (req, res) => {
    const c = await leeIdx(), vivo = {};
    for (const p of c.d.proyectos) { try { const X = await cargaNoticias(p.id); for (const n of X.items) { const d = String(n.dom || "").toLowerCase().replace(/^www\./, "").trim(); if (!d || /^news\.google\./.test(d) || !d.includes(".")) continue; const o = vivo[d] = vivo[d] || { d, nom: n.med || d, n: 0 }; o.n++; if (n.med && o.nom === d) o.nom = n.med; } } catch (_) { } }
    let cat = {}, gen = null; try { const r = await D.readGcs(MEDIOSF); cat = (r && r.data) || {}; gen = r && r.gen; } catch (_) { }
    let cambio = false; Object.values(vivo).forEach(o => { const q = cat[o.d]; if (!q) { cat[o.d] = { nom: o.nom, n: o.n }; cambio = true; } else if (o.n > q.n || (o.nom !== o.d && q.nom !== o.nom)) { q.n = Math.max(q.n, o.n); q.nom = o.nom; cambio = true; } });
    if (cambio) { try { await D.writeGcs(MEDIOSF, cat, gen); } catch (_) { } }
    const lista = Object.entries(cat).map(([d, v]) => ({ d, nom: v.nom || d, n: (vivo[d] && vivo[d].n) || 0, max: v.n || 0 })).sort((x, y) => y.n - x.n || String(x.nom).localeCompare(String(y.nom), "es"));
    res.json({ ok: true, medios: lista, total: lista.length });
  }));
  /* uso real de la cuenta de Apify en el ciclo mensual (para mostrar el consumo frente al plan) */
  app.get(R + "/apify/uso", wrap(async (req, res) => {
    const tk = process.env.APIFY_TOKEN; if (!tk) return res.json({ ok: false, error: "Falta APIFY_TOKEN" });
    const j = (JSON.parse(await jget("https://api.apify.com/v2/users/me/limits", 20000, { headers: { Authorization: "Bearer " + tk } })).data) || {};
    res.json({ ok: true, uso: Math.round((((j.current || {}).monthlyUsageUsd) || 0) * 100) / 100, limite: (j.limits || {}).maxMonthlyUsageUsd || 0, fin: (j.monthlyUsageCycle || {}).endAt || null });
  }));
  /* la IA propone la lista final de términos de búsqueda a partir del objetivo y de las ideas del usuario */
  app.post(R + "/terminos/sugerir", wrap(async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ ok: false, error: "Sin ANTHROPIC_API_KEY" });
    const b = req.body || {}, max = Math.max(3, Math.min(+b.max || 15, 200)), ideas = String(b.ideas || "").slice(0, 6000), obj = String(b.objetivo || "").slice(0, 800), tit = String(b.titulo || "").slice(0, 160), zona = String(b.zona || "").slice(0, 300);
    if (!ideas.trim() && obj.trim().length < 5) return res.status(400).json({ ok: false, error: "Escribe algunas ideas o describe el objetivo del proyecto" });
    const sys = `Eres experto en monitoreo de medios en México. Diseñas la lista de TÉRMINOS DE BÚSQUEDA para descargar noticias y publicaciones sobre un proyecto. Devuelve ÚNICAMENTE un objeto JSON: {"terminos":[{"t":"término","por":"razón breve, máx. 12 palabras"}],"nota":"una oración sobre lo que se dejó fuera o se fusionó"}. Reglas: 1) Máximo ${max} términos; pueden ser menos si no hace falta más. 2) Cada término es como lo escribiría un medio en un titular: de 1 a 4 palabras, en español de México, sin comillas ni operadores. 3) La lista debe ser VARIADA y REPRESENTATIVA: cubre las distintas facetas del objetivo (hechos, actores, modalidades, consecuencias) en lugar de repetir la misma idea. 4) EVITA REDUNDANCIA: no incluyas sinónimos, plurales ni variantes que traerían las mismas notas (por ejemplo, no pongas "robo" junto con "robos" ni un término general que ya abarca a otro más específico, salvo que el específico aporte notas distintas). 5) Evita términos demasiado genéricos o ambiguos que traerían ruido (por ejemplo "seguridad" solo). 6) NO incluyas el nombre de la zona geográfica en los términos: el sistema la agrega aparte. 7) Parte de las ideas del usuario: conserva las que sirven, fusiona las redundantes y agrega las que falten para cubrir el objetivo.`;
    const txt = await llm(sys, `Proyecto: ${tit}\nObjetivo: ${obj}\nZona geográfica (no la incluyas en los términos): ${zona || "todo México"}\nIdeas o conceptos del usuario:\n${ideas || "(ninguna: propón a partir del objetivo)"}`, 3000, "_estimar", 1);
    let j = null; try { const i = txt.indexOf("{"), k = txt.lastIndexOf("}"); j = JSON.parse(txt.slice(i, k + 1)); } catch (_) { }
    const vistos = new Set(), L = ((j && j.terminos) || []).map(x => ({ t: String((x && x.t) || "").replace(/["\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60), por: String((x && x.por) || "").slice(0, 140) })).filter(x => x.t.length > 1 && !vistos.has(norm(x.t)) && vistos.add(norm(x.t))).slice(0, max);
    if (!L.length) return res.status(502).json({ ok: false, error: "La IA no devolvió una lista utilizable; intenta de nuevo" });
    res.json({ ok: true, terminos: L, nota: String((j && j.nota) || "").slice(0, 300) });
  }));
  app.get(R + "/proveedores", wrap(async (req, res) => res.json({ ok: true, proveedores: disponibles(), ia: !!process.env.ANTHROPIC_API_KEY, geocodificar: !!process.env.GOOGLE_MAPS_KEY, categorias: CATS, estados: ESTADOS })));
  app.get(R + "/costos", wrap(async (req, res) => {
    await vuelcaUso(); const { data } = await D.readGcs(USO), U = data || { d: {}, tarifas: null }, T = Object.assign({}, TARIFAS0, U.tarifas || {}); if (U.tarifas && U.tarifas.ia) T.ia = Object.assign({}, TARIFAS0.ia, U.tarifas.ia);
    const c = await leeIdx(), tit = Object.fromEntries(c.d.proyectos.map(p => [p.id, p.titulo])); tit._ = "Sin proyecto (pruebas y estimaciones)"; tit._estimar = "Estimaciones del asistente"; const raiz = Object.fromEntries(c.d.proyectos.map(p => [p.id, p.padre || p.id]));   /* redes sociales se suma a su proyecto */
    const desde = String(req.query.desde || "0000-00-00"), fp = String(req.query.proy || ""); let hasta = String(req.query.hasta || "9999-99-99"); if (hasta >= hoyMx()) hasta = "9999-99-99";   /* si el rango llega a hoy, incluye lo registrado con fecha UTC del día siguiente */
    const porSvc = {}, porMes = {}, porDia = {}, porProy = {}; let tot = { costo: 0, llamadas: 0, in: 0, out: 0, notas: 0, ia_notas: 0 };
    const suma = (o, k, sv, e, cst) => { const a = o[k] = o[k] || { costo: 0, llamadas: 0, notas: 0 }; a.costo += cst; if (sv === "notas") a.notas += e.n; else a.llamadas += e.n; };
    Object.keys(U.d).sort().forEach(f => Object.keys(U.d[f]).forEach(pr0 => { const pr = raiz[pr0] || pr0; if (fp && pr !== fp) return; Object.entries(U.d[f][pr0]).forEach(([sv, e]) => {
      const cst = costoDe(sv, e, T), mes = f.slice(0, 7); suma(porMes, mes, sv, e, cst);
      if (f < desde || f > hasta) return;
      const a = porSvc[sv] = porSvc[sv] || { n: 0, in: 0, out: 0, k: 0, costo: 0 }; a.n += e.n; a.in += e.in; a.out += e.out; a.k += e.k; a.costo += cst; suma(porDia, f, sv, e, cst); suma(porProy, pr, sv, e, cst);
      if (sv === "notas") tot.notas += e.n; else { tot.llamadas += e.n; tot.costo += cst; } if (sv === "ia") { tot.in += e.in; tot.out += e.out; tot.ia_notas += e.k; } }); }));
    res.json({ ok: true, limite: +U.limite || 0, tarifas: T, servicios: SVC, porSvc, porMes, porDia, porProy: Object.fromEntries(Object.entries(porProy).map(([k, v]) => [k, Object.assign({ titulo: tit[k] || k }, v)])), total: tot });
  }));
  app.post(R + "/costos/tarifas", wrap(async (req, res) => {
    const t = (req.body || {}).tarifas || {}, limpio = { ia: {} }; Object.keys(TARIFAS0).forEach(k => { if (k === "ia") { Object.entries(t.ia || {}).forEach(([m, v]) => { if (v && isFinite(+v.in) && isFinite(+v.out)) limpio.ia[String(m).slice(0, 40)] = { in: Math.max(0, +v.in), out: Math.max(0, +v.out) }; }); } else if (isFinite(+t[k])) limpio[k] = Math.max(0, +t[k]); });
    for (let i = 0; i < 6; i++) { try { const { data, gen } = await D.readGcs(USO), U = data || { d: {}, tarifas: null }; U.tarifas = limpio; if ((req.body || {}).limite !== undefined) U.limite = Math.max(0, Math.round((+(req.body || {}).limite || 0) * 100) / 100); await D.writeGcs(USO, U, gen); return res.json({ ok: true }); } catch (e) { if (!e.conflict) throw e; await sleep(200); } }
    res.status(409).json({ ok: false, error: "conflicto al guardar" });
  }));
  app.get(R + "/proyectos", wrap(async (req, res) => {
    let cambio = 0; try { cambio = await venceVigencias(); } catch (_) { }
    const c = await leeIdx(!!cambio), falta = c.d.proyectos.filter(p => p.estado && p.estado.total > 0 && !p.estado.rango);
    for (const p of falta) { try { const X = await cargaNoticias(p.id), fs = X.items.map(n => n.f).filter(Boolean).sort(); if (fs.length) p.estado.rango = [fs[0], fs[fs.length - 1]]; } catch (_) { } }
    if (falta.some(p => p.estado.rango)) mutaIdx(ix => { falta.forEach(f => { const q = ix.proyectos.find(x => x.id === f.id); if (q && q.estado && f.estado.rango) q.estado.rango = f.estado.rango; }); }).catch(() => { });
    let cs = {}; try { cs = await costosProy(); } catch (_) { }
    const cz = p => { const o = Object.assign({ total: 0, mes: 0 }, cs[p.id] || {}); c.d.proyectos.forEach(h => { if (h.padre === p.id && cs[h.id]) { o.total = Math.round((o.total + cs[h.id].total) * 1000) / 1000; o.mes = Math.round((o.mes + cs[h.id].mes) * 1000) / 1000; } }); return o; };
    res.json({ ok: true, proyectos: c.d.proyectos.map(p => Object.assign(pub(p), { costo: cz(p) })) });
  }));
  app.get(R + "/proyectos/:id", wrap(async (req, res) => { const c = await leeIdx(); const p = c.d.proyectos.find(x => x.id === req.params.id); if (!p) return res.status(404).json({ ok: false, error: "no existe" }); const o = pub(p); o.config.terminos = req.query.terminos === "1" ? limpiaTerminos(p.config.terminos).pos : undefined; res.json({ ok: true, proyecto: o }); }));
  app.post(R + "/proyectos", wrap(async (req, res) => {
    const b = req.body || {}, titulo = String(b.titulo || "").trim().slice(0, 140); if (titulo.length < 3) return res.status(400).json({ ok: false, error: "Falta el título del proyecto" });
    const T = limpiaTerminos(b.terminos); if (!T.pos.length) return res.status(400).json({ ok: false, error: "Agrega al menos un término de interés" });
    const prov = PROVS[b.proveedor] ? b.proveedor : "gdelt", pr = disponibles()[prov]; if (!pr.ok) return res.status(400).json({ ok: false, error: `${pr.n} requiere la variable ${pr.clave} en el servidor` });
    const z = b.zona || {}, estados = (z.estados || []).filter(e => ESTADOS[e]), cfg = { terminos: [...T.pos, ...T.neg.map(x => "-" + x)], zona: { estados, estadosN: estados.map(e => ESTADOS[e]), ciudades: (z.ciudades || []).map(x => String(x).slice(0, 60)).slice(0, 10), estricta: !!z.estricta },
      periodo: b.periodo && b.periodo.tipo === "fijo" ? { tipo: "fijo", desde: b.periodo.desde, hasta: b.periodo.hasta || null } : { tipo: "movil", dias: Math.max(1, Math.min(+((b.periodo || {}).dias) || 7, 3650)) }, maxNoticias: Math.max(100, Math.min(+b.maxNoticias || 5000, 50000)), periodicidad: PER_MS[b.periodicidad] ? b.periodicidad : "manual",
      proveedor: prov, idiomas: Array.isArray(b.idiomas) && b.idiomas.length ? b.idiomas.slice(0, 5) : ["spanish"], paises: Array.isArray(b.paises) ? b.paises.slice(0, 5) : ["MX"], medios: (b.medios || []).map(x => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 200), texto: esFb(prov) ? false : b.texto !== false, textoMax: Math.max(0, Math.min(+b.textoMax || 500, 5000)), ia: b.ia !== false, iaMax: Math.max(0, Math.min(+b.iaMax || 0, 50000)), geocodificar: !!b.geocodificar, fbMax: Math.max(0.5, Math.min(+b.fbMax || 5, 500)) };
    const id = b.id && /^[a-z0-9]{6,20}$/.test(b.id) ? b.id : crypto.randomBytes(5).toString("hex");
    await mutaIdx(ix => { const prev = ix.proyectos.find(x => x.id === id); if (prev && prev.config) ["iaAuto", "dupSens"].forEach(k => { if (prev.config[k] !== undefined) cfg[k] = prev.config[k]; });
      const i = ix.proyectos.findIndex(x => x.id === id), p = { id, titulo, objetivo: String(b.objetivo || "").slice(0, 600), creador: String(b.creador || "").trim().slice(0, 60) || (i >= 0 ? ix.proyectos[i].creador || "" : ""), creado: i >= 0 ? ix.proyectos[i].creado : ahoraIso(), padre: i >= 0 ? ix.proyectos[i].padre : (/^[a-z0-9]{6,20}$/.test(String(b.padre || "")) ? b.padre : undefined), situacion: i >= 0 ? (ix.proyectos[i].situacion || "activo") : (SIT_OK[b.situacion] ? b.situacion : "activo"), situacionMotivo: i >= 0 ? ix.proyectos[i].situacionMotivo : undefined, vigencia: i >= 0 ? ix.proyectos[i].vigencia : (b.vigencia || ""), presupuesto: i >= 0 ? ix.proyectos[i].presupuesto : (+b.presupuesto || 0), visibilidad: i >= 0 ? ix.proyectos[i].visibilidad : (VIS_OK[b.visibilidad] ? b.visibilidad : "publico"), usuarios: i >= 0 ? ix.proyectos[i].usuarios : [], config: cfg, estado: i >= 0 ? ix.proyectos[i].estado : { proxima: proxima(cfg.periodicidad) } }; if (i >= 0) ix.proyectos[i] = p; else { if (ix.proyectos.length >= 100) throw new Error("máximo 100 proyectos"); ix.proyectos.push(p); } if (prev && prev.objVers) p.objVers = prev.objVers; });
    res.json({ ok: true, id, nTerminos: T.pos.length });
  }));
  app.delete(R + "/proyectos/:id", wrap(async (req, res) => { await mutaIdx(ix => { ix.proyectos = ix.proyectos.filter(x => x.id !== req.params.id && x.padre !== req.params.id); }); NC.delete(req.params.id); try { await D.writeGcs(OBJ(req.params.id), { items: [] }, null); } catch (_) { } res.json({ ok: true }); }));
  app.post(R + "/estimar", wrap(async (req, res) => {
    const b = req.body || {}, T = limpiaTerminos(b.terminos), prov = PROVS[b.proveedor] ? b.proveedor : "gdelt", z = b.zona || {}, estN = (z.estados || []).filter(e => ESTADOS[e]).map(e => ESTADOS[e]); if (!T.pos.length) return res.json({ ok: false, error: "Sin términos" });
    const G = gruposZ(T.pos, prov, { estadosN: estN, ciudades: z.ciudades }), cfg = { idiomas: b.idiomas || ["spanish"], paises: b.paises || ["MX"] }, dias = (b.periodo && b.periodo.tipo === "fijo" && b.periodo.desde) ? Math.max(1, (new Date(b.periodo.hasta || Date.now()) - new Date(b.periodo.desde)) / 864e5) : Math.max(1, +((b.periodo || {}).dias) || 7);
    const h = new Date(), d = new Date(h.getTime() - Math.min(dias, 88) * 864e5), muestra = [], ix = [...new Set([0, Math.floor(G.length / 2), G.length - 1])].slice(0, G.length > 2 ? 3 : G.length); const adv = [];
    if (!disponibles()[prov].ok) adv.push(`${PROVS[prov].n} requiere ${PROVS[prov].clave}`);
    else for (const i of ix) { uso(prov, { n: 1, proy: "_estimar" }); try { const r = await FETCH[prov](cfg, G[i], d, h); muestra.push({ q: G[i].slice(0, 90), n: r.items.length, saturado: r.saturado }); } catch (e) { adv.push(String(e.message).slice(0, 100)); } }
    const prom = muestra.length ? muestra.reduce((a, m) => a + m.n, 0) / muestra.length : 0, sat = muestra.some(m => m.saturado), consultas = G.length * (sat ? 3 : 1), seg = consultas * (GATE[prov] || 1000) / 1000;
    if (dias > 88 && prov === "gdelt") adv.push("GDELT solo busca ~3 meses hacia atrás: el periodo se recorta.");
    if (prov === "fbapify") adv.push(`Facebook (Apify): una consulta por término y lugar, hasta ${FB_N} publicaciones por consulta y semana (≈ ${(FB_N * 0.005).toFixed(2)} USD cada una).`);
    if (prov === "grss") adv.push("Google Noticias entrega máx. 100 notas por consulta; se subdivide por fechas.");
    res.json({ ok: true, terminos: T.pos.length, excluidos: T.neg.length, grupos: G.length, consultas, minutos: Math.max(1, Math.round(seg / 60)), muestra, notasPorGrupo: Math.round(prom), notasEstimadas: Math.round(prom * G.length * 0.6), saturado: sat, advertencias: adv });
  }));
  /* situación del proyecto: activo (extracción programada y manual) · suspendido (solo manual) · inactivo (archivado, solo consulta) */
  app.post(R + "/proyectos/:id/situacion", wrap(async (req, res) => {
    const v = String((req.body || {}).situacion || ""); if (!SIT_OK[v]) return res.status(400).json({ ok: false, error: "situación no válida" }); { const q0 = (await leeIdx(true)).d.proyectos.find(x => x.id === req.params.id); if (q0 && v !== "inactivo" && q0.vigencia && q0.vigencia < hoyMx()) return res.status(400).json({ ok: false, error: "La vigencia del proyecto ya venció: amplía la fecha en «Gestionar»" }); }
    let hallado = false; await mutaIdx(ix => { const p = ix.proyectos.find(x => x.id === req.params.id); if (!p) return; hallado = true; p.situacion = v; p.situacionMotivo = v === "inactivo" ? "manual" : undefined; p.estado = p.estado || {};
      if (v !== "activo") { p.estado.proxima = null; const w = p.estado.trabajo; if (w && w.fase !== "fin") { w.fase = "fin"; w.aviso = "Extracción detenida al cambiar la situación del proyecto a " + v + "."; w.act = null; } }
      else p.estado.proxima = proxima(p.config.periodicidad); });
    if (!hallado) return res.status(404).json({ ok: false, error: "proyecto no encontrado" });
    const c = await leeIdx(true), p = c.d.proyectos.find(x => x.id === req.params.id); res.json({ ok: true, proyecto: p ? pub(p) : null });
  }));
  /* gestión del proyecto: situación, visibilidad y usuarios con rol, vigencia y presupuesto */
  app.post(R + "/proyectos/:id/gestion", wrap(async (req, res) => {
    const c0 = await leeIdx(true), p0 = c0.d.proyectos.find(x => x.id === req.params.id); if (!p0) return res.status(404).json({ ok: false, error: "proyecto no encontrado" });
    let o; try { o = limpiaGestion(req.body || {}, p0); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    await mutaIdx(ix => { const p = ix.proyectos.find(x => x.id === req.params.id); if (!p) return; Object.assign(p, o); p.estado = p.estado || {};
      if (o.situacion) { p.situacionMotivo = o.situacion === "inactivo" ? "manual" : undefined; if (o.situacion !== "activo") { p.estado.proxima = null; const w = p.estado.trabajo; if (w && w.fase !== "fin") { w.fase = "fin"; w.aviso = "Extracción detenida al cambiar la situación del proyecto."; w.act = null; } } else p.estado.proxima = proxima(p.config.periodicidad); }
      if (o.vigencia !== undefined && p.situacionMotivo === "vigencia" && (!o.vigencia || o.vigencia >= hoyMx())) { p.situacion = "activo"; p.situacionMotivo = undefined; p.estado.proxima = proxima(p.config.periodicidad); } });
    const c = await leeIdx(true), p = c.d.proyectos.find(x => x.id === req.params.id), cs = await costosProy(); const q = p ? pub(p) : null; if (q) q.costo = cs[q.id] || { total: 0, mes: 0 }; res.json({ ok: true, proyecto: q });
  }));
  app.post(R + "/proyectos/:id/extraer", wrap(async (req, res) => { const c0 = await leeIdx(true), p0 = c0.d.proyectos.find(x => x.id === req.params.id); if (!p0) return res.status(404).json({ ok: false, error: "proyecto no encontrado" }); if (p0.situacion === "inactivo") return res.status(400).json({ ok: false, error: "El proyecto está inactivo: reactívalo para extraer noticias" }); const en = p0.estado && p0.estado.trabajo && p0.estado.trabajo.fase !== "fin"; const n = en ? (p0.estado.trabajo.total || 0) : await inicia(req.params.id, !!(req.body || {}).completa); const r = await avanza(req.params.id, 40000); const c = await leeIdx(true); const p = c.d.proyectos.find(x => x.id === req.params.id); res.json({ ok: true, grupos: n, avance: r, yaEnCurso: !!en, proyecto: p ? pub(p) : null }); }));
  app.post(R + "/proyectos/:id/detener", wrap(async (req, res) => {
    const id = req.params.id; PARAR.add(id); setTimeout(() => PARAR.delete(id), 120000);
    const ok = await mutaIdx(ix => { const q = ix.proyectos.find(x => x.id === id); if (!q || !q.estado || !q.estado.trabajo || q.estado.trabajo.fase === "fin") return false; q.estado.parar = 1; return true; });
    res.json({ ok: true, detenida: !!ok });
  }));
  app.post(R + "/proyectos/:id/avanzar", wrap(async (req, res) => { const r = await avanza(req.params.id, 40000); const c = await leeIdx(true); const p = c.d.proyectos.find(x => x.id === req.params.id); res.json({ ok: true, avance: r, proyecto: p ? pub(p) : null }); }));
  app.get(R + "/proyectos/:id/noticias", wrap(async (req, res) => {
    const X = await cargaNoticias(req.params.id), q = req.query, pj = (await leeIdx()).d.proyectos.find(x => x.id === req.params.id), DM = qcDupMapa(X, qcUmb(pj)), base = filtra(X.items, q).filter(n => q.nodup !== "1" || !DM.sob.has(String(n.id))).sort((a, b) => (b.f > a.f ? 1 : -1));
    if (q.geo === "1") { return res.json({ ok: true, total: base.length, puntos: base.slice(0, 4000).map(n => ({ id: n.id, t: n.t, lat: n.lug.lat, lng: n.lug.lng, niv: n.lug.nivel, lug: n.lug.munN ? n.lug.munN + ", " + n.lug.estN : n.lug.estN, med: n.med, f: n.f, cat: n.cat, r: n.an ? indicadores(n.an).risk : null })) }); }
    const pag = Math.max(0, +q.pag || 0), n = Math.min(+q.n || 40, 100), H0 = objHash(pj), lite = x => ({ id: x.id, ob: x.rob ? { v: x.rob.v, j: x.rob.j || "", a: x.rob.h === H0 ? 1 : 0 } : null, prov: fuenteDe(x), soc: x.soc, t: x.t, med: x.med, f: x.f, img: x.img, res: x.res || x.d, cat: x.cat, sub: x.sub, lug: x.lug && { met: x.lug.met || "regla", sitio: x.lug.sitio, nivel: x.lug.nivel, est: x.lug.est, estN: x.lug.estN, mun: x.lug.mun, munN: x.lug.munN, lat: x.lug.lat, lng: x.lug.lng, zona: x.lug.zona }, ent: x.ent, ia: x.ia, tx: estTx(x), an: anCorto(x) });
    if (q.dupDe) { const ids = new Set(DM.de.get(String(q.dupDe)) || []), L = X.items.filter(x => ids.has(String(x.id)) && !x.desc); return res.json({ ok: true, total: L.length, items: L.map(lite) }); }
    res.json({ ok: true, total: base.length, de: X.items.length, dups: DM.sob.size, items: base.slice(...(() => { if (q.hastaId) { const ix = base.findIndex(x => String(x.id) === String(q.hastaId)); if (ix >= 0) return [0, Math.min(1200, Math.ceil((ix + 1) / 40) * 40)]; } return [pag * n, pag * n + n]; })()).map(x => Object.assign(lite(x), { dupN: (DM.de.get(String(x.id)) || []).length, dupS: DM.sob.has(String(x.id)) ? 1 : 0 })), facetas: pag === 0 ? facetas(X.items, q) : undefined });
  }));
  /* Timeline: cada noticia vigente en forma compacta (categoría, subcategoría, día y los cuatro índices); el tablero agrega por celda en el navegador */
  /* Tablero social: índices de interacción y datos de las gráficas, sobre las publicaciones con reacciones (respeta los filtros) */
  app.get(R + "/proyectos/:id/social", wrap(async (req, res) => {
    const X = await cargaNoticias(req.params.id), L = filtra(X.items, req.query).filter(n => n.soc), r1 = v => Math.round(v * 10) / 10;
    const W = n => (n.soc.r || 0) + 2 * (n.soc.c || 0) + 3 * (n.soc.s || 0), IX = w => Math.min(100, Math.log10(1 + w) / 5 * 100), sen = n => { const a = anCorto(n); return a && a.s != null ? a.s : null; };
    const RXK = { anger: "angry", sorry: "sad", support: "care" }, nuevo = () => ({ n: 0, r: 0, c: 0, s: 0, w: 0, ix: 0, ss: 0, sn: 0, pos: 0, neu: 0, neg: 0, ps: 0, rx: {}, rxr: 0 }), suma = (o, n) => { o.n++; { const rx = n.soc.rx || {}, ks = Object.keys(rx); if (ks.length) { o.rxr += n.soc.r || 0; ks.forEach(k => { const q = RXK[k] || k; o.rx[q] = (o.rx[q] || 0) + (+rx[k] || 0); }); } const a0 = n.an; if (a0 && a0.pol != null) o.ps += +a0.pol || 0; } o.r += n.soc.r || 0; o.c += n.soc.c || 0; o.s += n.soc.s || 0; const w = W(n); o.w += w; o.ix += IX(w); const v = sen(n); if (v != null) { o.ss += v; o.sn++; if (v >= 7) o.pos++; else if (v >= 4) o.neu++; else o.neg++; } return o; };
    const lg = (x, ref) => Math.min(100, Math.log10(1 + x) / Math.log10(1 + ref) * 100);
    /* Engagement (0 a 100): promedio ponderado, en escala logarítmica, de publicaciones (20 %), reacciones (40 %) y comentarios (40 %) */
    const engDe = o => r1(.2 * lg(o.n, 1000) + .4 * lg(o.r, 100000) + .4 * lg(o.c, 20000));
    const tipoDe = o => { const x = o.rx, tot = Object.values(x).reduce((a, b) => a + b, 0); if (!tot) return null; const g = { apoyo: (x.love || 0) + (x.care || 0), indignacion: x.angry || 0, tristeza: x.sad || 0, burla: x.haha || 0, asombro: x.wow || 0 }, emo = Object.values(g).reduce((a, b) => a + b, 0), dom = Object.entries(g).sort((a, b) => b[1] - a[1])[0]; return { k: emo / tot < .08 ? "pasiva" : dom[0], emo: r1(emo / tot * 100), cob: o.r ? Math.round(o.rxr / o.r * 100) : 0, d: Object.fromEntries(Object.entries(Object.assign({ megusta: x.like || 0 }, g)).map(([k, v]) => [k, r1(v / tot * 100)])) }; };
    const fin = o => { const t = o.r + o.c + o.s; return { eng: engDe(o), tipo: tipoDe(o), pol: o.sn ? r1(o.ps / o.sn) : null, n: o.n, r: o.r, c: o.c, s: o.s, w: o.w, ix: o.n ? r1(o.ix / o.n) : 0, amp: t ? r1(o.s / t * 100) : 0, conv: t ? r1(o.c / t * 100) : 0, prof: t ? r1((o.c + o.s) / t * 100) : 0, sent: o.sn ? r1(o.ss / o.sn) : null, sn: o.sn, pos: o.pos, neu: o.neu, neg: o.neg, neto: o.sn ? Math.round((o.pos - o.neg) / o.sn * 100) : null }; };
    const T = nuevo(), pg = new Map(), cat = new Map(), sub = new Map(), dia = new Map();
    const fs = L.map(n => n.f).filter(Boolean).sort(), dias = fs.length ? (new Date(fs[fs.length - 1]) - new Date(fs[0])) / 864e5 : 0, paso = dias > 75 ? "semana" : "dia", kf = f => { const d = new Date(new Date(f).getTime() - 6 * 3600e3); if (paso === "semana") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
    const acc = (m, k) => { let o = m.get(k); if (!o) m.set(k, o = nuevo()); return o; };
    L.forEach(n => { suma(T, n); suma(acc(pg, n.soc.pg || n.med || "Sin página"), n); const c = n.cat || "Sin clasificación"; suma(acc(cat, c), n); suma(acc(sub, c + "\u0001" + (n.sub || "General")), n); if (n.f) suma(acc(dia, kf(n.f)), n); });
    const lista = (m, max, orden) => [...m.entries()].map(([k, o]) => Object.assign({ k }, fin(o))).sort(orden || ((a, b) => b.w - a.w)).slice(0, max);
    const paginas = lista(pg, 200), tw = T.w || 1, tn = T.n || 1; paginas.forEach(x => { x.cuotaN = r1(x.n / tn * 100); x.cuotaW = r1(x.w / tw * 100); });
    const top = [...L].sort((a, b) => W(b) - W(a)).slice(0, 100).map(n => ({ id: n.id, t: n.t, pg: n.soc.pg || n.med, f: n.f, r: n.soc.r || 0, c: n.soc.c || 0, s: n.soc.s || 0, ix: r1(IX(W(n))), eng: engDe({ n: 1, r: n.soc.r || 0, c: n.soc.c || 0 }) }));
    /* series para la gráfica de dinámica temporal (misma estructura que el análisis narrativo): por clasificación, por página y por subclasificación */
    const LF = L.filter(n => n.f), serieDe = kfn => { const tf = new Map(); LF.forEach(n => tf.set(kfn(n), (tf.get(kfn(n)) || 0) + 1)); const tops = [...tf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map(x => x[0]), per = new Map(); LF.forEach(n => { const k = kf(n.f), r0 = per.get(k) || { f: k, v: {} }, t = tops.includes(kfn(n)) ? kfn(n) : "Otros"; r0.v[t] = (r0.v[t] || 0) + 1; per.set(k, r0); }); return { tops, cuenta: tops.map(t => tf.get(t)), serie: [...per.values()].sort((a, b) => (a.f > b.f ? 1 : -1)), otros: LF.length - tops.reduce((a, t) => a + tf.get(t), 0) }; };
    const temporal = { paso, series: { cat: serieDe(n => n.cat || "Sin clasificación"), top: serieDe(n => n.soc.pg || n.med || "Sin página"), cc: serieDe(n => n.sub || "General") } };
    const emoC = {}, tonoC = {}, postC = {}; L.forEach(n => { const a0 = n.an; if (a0 && a0.soc) { emoC[a0.emo] = (emoC[a0.emo] || 0) + 1; tonoC[a0.tono] = (tonoC[a0.tono] || 0) + 1; postC[a0.post] = (postC[a0.post] || 0) + 1; } });
    res.json({ ok: true, total: Object.assign(fin(T), { paginas: pg.size }), paso, paginas, temas: lista(cat, 30), subs: lista(sub, 80).map(x => { const [c, sb] = x.k.split("\u0001"); return Object.assign(x, { cat: c, sub: sb }); }), dias: lista(dia, 400, (a, b) => (a.k > b.k ? 1 : -1)), top, temporal, sinIA: T.n - T.sn, percep: { emo: emoC, tono: tonoC, post: postC } });
  }));
  app.get(R + "/proyectos/:id/timeline", wrap(async (req, res) => {
    const X = await cargaNoticias(req.params.id), q = req.query, pj = (await leeIdx()).d.proyectos.find(x => x.id === req.params.id), DM = qcDupMapa(X, qcUmb(pj)), H = objHash(pj);
    const L = filtra(X.items, q).filter(n => q.nodup !== "1" || !DM.sob.has(String(n.id))), dia = f => { const t = new Date(f).getTime(); return isNaN(t) ? "" : new Date(t - 6 * 36e5).toISOString().slice(0, 10); };
    const items = L.slice(0, 30000).map(n => { const i = n.an ? indicadores(n.an) : null; return { c: n.cat || "Sin categoría", s: n.sub || "", d: dia(n.f), r: i ? i.risk : null, o: n.rob && n.rob.h === H ? n.rob.v : null, i: i && i.afe ? i.afe.rel : null, e: i ? i.sent : null }; }).filter(x => x.d);
    res.json({ ok: true, total: L.length, items });
  }));
  app.get(R + "/proyectos/:id/noticia/:nid", wrap(async (req, res) => {
    const X = await cargaNoticias(req.params.id), n = X.items.find(x => x.id === req.params.nid); if (!n) return res.status(404).json({ ok: false });
    if (req.query.ia === "1" && process.env.ANTHROPIC_API_KEY && (!n.an || (n.an.act == null && !n.an.soc))) { try { if (n.soc) await percepcionLote([n], req.params.id); else await enriqueceLote([n], await gaz(), req.params.id); X.sucio = true; } catch (_) { } }
    const out = Object.assign({}, n); out.texto = n.texto || "";
    if (n.soc && !out.texto) out.texto = n.d || "";
    if (!n.texto && !n.txErr && !n.soc) { if (await bajaTexto(n, req.params.id)) X.sucio = true; out.texto = n.texto || ""; out.img = n.img || out.img; }
    if (!out.res && !n.soc && process.env.ANTHROPIC_API_KEY && req.query.ia === "1") { try { const t = await llm("Resume la nota en 2 o 3 oraciones en español, sin inventar datos.", `${n.t}\n\n${out.texto || n.d}`, 400, req.params.id, 1); out.res = t.trim().slice(0, 500); n.res = out.res; X.sucio = true; } catch (_) { } }
    out.res = out.res || n.res; out.ind = indicadores(n.an); if (X.sucio) guardaNoticias(req.params.id, X).catch(() => { }); res.json({ ok: true, noticia: out });
  }));
  /* ───────── Análisis narrativo (fenómenos): extracción por nota con IA + agregación para el dashboard ───────── */
  const SYS_NAR = "Eres Analista Senior de Inteligencia de Datos y Lingüística Computacional. Analizas noticias enfocándote en el FENÓMENO social, político o económico, ignorando el sesgo o prestigio del medio. Recibes varias notas (id, título, fecha, texto). Devuelve ÚNICAMENTE un arreglo JSON con un objeto por nota, sin texto adicional. Cada objeto: {\"id\":\"<id recibido>\",\"topico_macro\":\"fenómeno en 2-4 palabras\",\"rafaga\":true|false (evento detonante/disruptivo),\"fase\":\"Surgimiento|Escalada/Ráfaga|Saturación/Debate|Resolución/Declive\",\"conceptos\":[3 a 5 términos que definan el estado actual del fenómeno],\"entidades\":[{\"n\":\"nombre normalizado\",\"t\":\"Persona|Institucion|Lugar|Concepto\",\"r\":1-10}] (máx. 8),\"relaciones\":[{\"a\":\"entidad\",\"b\":\"entidad\",\"i\":1-5}] (pares estrechamente vinculados, máx. 8),\"acciones\":[{\"c\":\"causante\",\"a\":\"acción breve\",\"ta\":\"Impulso/Apoyo|Restricción/Sanción|Conflicto/Denuncia|Negociación/Acuerdo|Impacto/Consecuencia\",\"o\":\"impactado\",\"p\":\"Apoyo (+)|Conflicto (-)|Neutral (0)\",\"ev\":\"frase breve del texto\"}] (máx. 4; solo si el texto establece que A ejecutó una acción que afectó o buscó afectar a B),\"encuadre\":{\"Economico\":0,\"Politico\":0,\"Social\":0,\"Ambiental_Tecnico\":0} (enteros que suman 100),\"origen\":\"Evento_Directo|Declaracion_Oficial|Filtracion_Exclusiva|Reaccion_En_Cadena|Analisis_Secundario\",\"foco\":\"ciudad, región o país del impacto principal\",\"conectadas\":[ubicaciones secundarias],\"mutacion\":\"máx. 15 palabras: ángulo nuevo o eco del hecho original\"}. No alucines: si algo no está en el texto usa [] o null. Separa correlación de causalidad.";
  const NAR_ENUM = { fase: ["Surgimiento", "Escalada/Ráfaga", "Saturación/Debate", "Resolución/Declive"], ta: ["Impulso/Apoyo", "Restricción/Sanción", "Conflicto/Denuncia", "Negociación/Acuerdo", "Impacto/Consecuencia"], p: ["Apoyo (+)", "Conflicto (-)", "Neutral (0)"], origen: ["Evento_Directo", "Declaracion_Oficial", "Filtracion_Exclusiva", "Reaccion_En_Cadena", "Analisis_Secundario"], t: ["Persona", "Institucion", "Lugar", "Concepto"] };
  const cut = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
  function limpiaNar(o) {
    if (!o || typeof o !== "object") return null; const arr = a => Array.isArray(a) ? a : [], en = o.encuadre || {}; let e = ["Economico", "Politico", "Social", "Ambiental_Tecnico"].map(k => Math.max(0, +en[k] || 0)); const se = e.reduce((a, b) => a + b, 0); e = se ? e.map(v => Math.round(v / se * 100)) : [0, 0, 0, 0];
    const ent = arr(o.entidades).map(x => ({ n: cut(x && x.n, 60), t: NAR_ENUM.t.includes(x && x.t) ? x.t : "Concepto", r: Math.min(10, Math.max(1, +(x && x.r) || 1)) })).filter(x => x.n).slice(0, 8);
    return {
      tm: cut(o.topico_macro, 40) || "Sin tópico", rf: o.rafaga === true, fa: NAR_ENUM.fase.includes(o.fase) ? o.fase : null, cc: arr(o.conceptos).map(x => cut(x, 40)).filter(Boolean).slice(0, 5), en: ent,
      re: arr(o.relaciones).map(x => ({ a: cut(x && x.a, 60), b: cut(x && x.b, 60), i: Math.min(5, Math.max(1, +(x && x.i) || 1)) })).filter(x => x.a && x.b && x.a !== x.b).slice(0, 8),
      ac: arr(o.acciones).map(x => ({ c: cut(x && x.c, 60), a: cut(x && x.a, 80), ta: NAR_ENUM.ta.includes(x && x.ta) ? x.ta : null, o: cut(x && x.o, 60), p: NAR_ENUM.p.includes(x && x.p) ? x.p : "Neutral (0)", ev: cut(x && x.ev, 160) })).filter(x => x.c && x.o).slice(0, 4),
      fr: { Economico: e[0], Politico: e[1], Social: e[2], Ambiental_Tecnico: e[3] }, or: NAR_ENUM.origen.includes(o.origen) ? o.origen : null, fo: cut(o.foco, 80) || null, co: arr(o.conectadas).map(x => cut(x, 60)).filter(Boolean).slice(0, 6), mu: cut(o.mutacion, 140) || null
    };
  }
  async function narrativaLote(lote, proy) {
    const user = lote.map(n => `[id ${n.id}] ${n.t}\nFecha: ${String(n.f || "").slice(0, 10)}\n${cut(n.texto || n.res || n.d, 1800)}`).join("\n\n---\n\n");
    const txt = await llm(SYS_NAR, user, 6000, proy, 2); const por = new Map(objetosJson(txt).map(o => [String(o.id), o])); let ok = 0;
    for (const n of lote) { const r = limpiaNar(por.get(String(n.id))); if (r) { n.nar = r; delete n.narF; ok++; } else n.narF = (n.narF || 0) + 1; }
    return ok;
  }
  /* entidades por tipo (para los filtros del análisis): en cuántas notas aparece cada una */
  const entFac = items => { const m = {}; NAR_ENUM.t.forEach(tp => m[tp] = new Map()); items.forEach(n => { if (!n.nar) return; const v = new Set(); n.nar.en.forEach(e => { const k = norm(e.n); if (!k || !m[e.t] || v.has(e.t + "|" + k)) return; v.add(e.t + "|" + k); const o = m[e.t].get(k) || { v: e.n, n: 0 }; o.n++; m[e.t].set(k, o); }); }); const r = {}; for (const tp in m) r[tp] = [...m[tp].values()].sort((a, b) => b.n - a.n).slice(0, 80); return r; };
  const NAR_JOB = new Map();
  /* procesa hasta `max` notas pendientes (lotes de 4, 3 en paralelo) dentro de ~45 s; el cliente repite hasta terminar */
  app.post(R + "/proyectos/:id/narrativa", wrap(async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ ok: false, error: "Sin ANTHROPIC_API_KEY" });
    const id = req.params.id; if (NAR_JOB.get(id) && Date.now() - NAR_JOB.get(id) < 50000) return res.status(409).json({ ok: false, error: "Ya hay un análisis narrativo en curso" }); NAR_JOB.set(id, Date.now());
    try {
      const X = await cargaNoticias(id), t0 = Date.now(), pend = () => X.items.filter(n => !n.desc && !n.nar && (n.narF || 0) < 2 && n.t), max = Math.min(+(req.body && req.body.max) || 60, 120); let hechas = 0, errores = "";
      if (req.body && req.body.reintentar) X.items.forEach(n => { if (!n.nar && n.narF) delete n.narF; });  /* vuelve a intentar las que fallaron */
      let cola = pend().sort((a, b) => (b.f > a.f ? 1 : -1)).slice(0, max); const lotes = []; for (let i = 0; i < cola.length; i += 2) lotes.push(cola.slice(i, i + 2));  /* 2 notas por llamada: con 4 la respuesta se cortaba y se perdía la mitad */
      const trabaja = async () => { while (lotes.length && Date.now() - t0 < 38000) { const l = lotes.shift(); for (const n of l) if (!n.texto && !n.txErr) { try { await bajaTexto(n, id); } catch (_) { } } try { hechas += await narrativaLote(l, id); } catch (e) { errores = e.message; } } };
      await Promise.all([trabaja(), trabaja(), trabaja(), trabaja(), trabaja()]); X.sucio = true; await guardaNoticias(id, X);
      const quedan = pend().length; res.json({ ok: true, hechas, pend: quedan, total: X.items.length, listas: X.items.filter(n => n.nar).length, error: errores || undefined });
    } finally { NAR_JOB.delete(id); }
  }));
  const topN = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  app.get(R + "/proyectos/:id/narrativa", wrap(async (req, res) => {
    const X = await cargaNoticias(req.params.id), q = req.query, base0 = filtra(X.items, q).filter(n => (!q.fase || (n.nar && n.nar.fa === q.fase)) && (!q.or || (n.nar && n.nar.or === q.or)) && (!q.cc || (n.nar && (n.nar.cc || []).includes(q.cc)))), FE = entFac(base0), pares = [["Persona", q.nP], ["Institucion", q.nI], ["Lugar", q.nL], ["Concepto", q.nC]].filter(x => x[1]).map(([tp, v]) => [tp, norm(v)]), base = pares.length ? base0.filter(n => n.nar && pares.every(([tp, v]) => n.nar.en.some(e => e.t === tp && norm(e.n) === v))) : base0, A = base.filter(n => n.nar), FAC = facetas(X.items, q), pend = base.filter(n => !n.nar && (n.narF || 0) < 2 && n.t).length, fallidas = base.filter(n => !n.nar && (n.narF || 0) >= 2).length;
    const T = TARIFAS0.ia["claude-haiku-5-5"], est = Math.round((pend || fallidas) * (2200 * T.in + 2300 * T.out) / 1e6 * 100) / 100;
    if (!A.length) return res.json({ ok: true, vacio: true, total: base.length, listas: 0, pend, fallidas, est, universo: X.items.length, facetas: FAC, entFac: FE });
    const AP = A;
    const fechas = A.map(n => n.f).filter(Boolean).sort(), dias = fechas.length ? (new Date(fechas[fechas.length - 1]) - new Date(fechas[0])) / 864e5 : 0, paso = dias > 120 ? "mes" : dias > 28 ? "semana" : "dia";
    const claveF = f => { const d = new Date(f); if (paso === "mes") d.setUTCDate(1); else if (paso === "semana") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
    /* lista de notas de un periodo (clic en un punto de la gráfica temporal) */
    if (q.notasRel) {   /* notas donde aparece la relación entre dos entidades (clic en una celda de la matriz de coocurrencia) */
      const [ea, eb] = String(q.notasRel).split("|"), par = n => n.nar.re.some(r => { const x = norm(r.a), y = norm(r.b); return (x === ea && y === eb) || (x === eb && y === ea); }), amb = n => { const k = new Set(n.nar.en.map(e => norm(e.n))); return k.has(ea) && k.has(eb); };
      let L = A.filter(par); if (!L.length) L = A.filter(amb); L.sort((a, b) => (b.f > a.f ? 1 : -1));
      const lite = x => ({ id: x.id, prov: fuenteDe(x), t: x.t, med: x.med, f: x.f, img: x.img, res: x.res || x.d, cat: x.cat, sub: x.sub, lug: x.lug && { met: x.lug.met || "regla", sitio: x.lug.sitio, nivel: x.lug.nivel, est: x.lug.est, estN: x.lug.estN, mun: x.lug.mun, munN: x.lug.munN, lat: x.lug.lat, lng: x.lug.lng, zona: x.lug.zona }, ent: x.ent, ia: x.ia, tx: estTx(x), an: anCorto(x), soc: x.soc });
      return res.json({ ok: true, total: L.length, items: L.slice(0, 80).map(lite) });
    }
    if ("notasTm" in q) {
      const L = A.filter(n => (!q.notasTm || (n.nar.tm || "Sin tema") === q.notasTm) && (!q.notasOr || (n.nar.or || "Sin_origen") === q.notasOr) && (!q.notasMed || n.med === q.notasMed)).sort((a, b) => (b.f > a.f ? 1 : -1));
      const lite = x => ({ id: x.id, prov: fuenteDe(x), t: x.t, med: x.med, f: x.f, img: x.img, res: x.res || x.d, cat: x.cat, sub: x.sub, lug: x.lug && { met: x.lug.met || "regla", sitio: x.lug.sitio, nivel: x.lug.nivel, est: x.lug.est, estN: x.lug.estN, mun: x.lug.mun, munN: x.lug.munN, lat: x.lug.lat, lng: x.lug.lng, zona: x.lug.zona }, ent: x.ent, ia: x.ia, tx: estTx(x), an: anCorto(x), soc: x.soc });
      return res.json({ ok: true, total: L.length, items: L.slice(0, 80).map(lite) });
    }
    if (q.notasPer) {
      const g = String(q.notasG || ""), v = String(q.notasV || ""), L = A.filter(n => claveF(n.f) === String(q.notasPer) && (q.notasRaf !== "1" || n.nar.rf) && (!g || !v || (g === "cat" ? (n.cat || "Sin categoría") === v : g === "top" ? n.nar.tm === v : (n.nar.cc || []).includes(v)))).sort((a, b) => (b.f > a.f ? 1 : -1));
      const lite = x => ({ id: x.id, prov: fuenteDe(x), t: x.t, med: x.med, f: x.f, img: x.img, res: x.res || x.d, cat: x.cat, sub: x.sub, lug: x.lug && { met: x.lug.met || "regla", sitio: x.lug.sitio, nivel: x.lug.nivel, est: x.lug.est, estN: x.lug.estN, mun: x.lug.mun, munN: x.lug.munN, lat: x.lug.lat, lng: x.lug.lng, zona: x.lug.zona }, ent: x.ent, ia: x.ia, tx: estTx(x), an: anCorto(x) });
      return res.json({ ok: true, total: L.length, items: L.slice(0, 80).map(lite) });
    }
    /* dinámica temporal: tópicos (top 5) por periodo + ráfagas */
    const construye = kf => { const tf = new Map(); A.forEach(n => tf.set(kf(n), (tf.get(kf(n)) || 0) + 1)); const tops = topN(tf, 7).map(x => x[0]), per = new Map(); A.forEach(n => { const k = claveF(n.f), r = per.get(k) || { f: k, v: {} }, t = tops.includes(kf(n)) ? kf(n) : "Otros"; r.v[t] = (r.v[t] || 0) + 1; per.set(k, r); }); return { tops, cuenta: tops.map(t => tf.get(t)), serie: [...per.values()].sort((a, b) => (a.f > b.f ? 1 : -1)), otros: A.length - tops.reduce((a, t) => a + tf.get(t), 0) }; };
    const series = { cat: construye(n => n.cat || "Sin categoría"), top: construye(n => n.nar.tm) }, tf = new Map(); A.forEach(n => tf.set(n.nar.tm, (tf.get(n.nar.tm) || 0) + 1)); const tops = topN(tf, 5).map(x => x[0]), serie = series.top.serie, raf = new Map();
    { const cf = new Map(), cn = n => [...new Set(n.nar.cc || [])]; A.forEach(n => cn(n).forEach(c => cf.set(c, (cf.get(c) || 0) + 1))); const ct = topN(cf, 12).map(x => x[0]), cp = new Map(); A.forEach(n => { const k = claveF(n.f), r = cp.get(k) || { f: k, v: {} }; cn(n).forEach(c => { if (ct.includes(c)) r.v[c] = (r.v[c] || 0) + 1; }); cp.set(k, r); }); series.cc = { tops: ct, cuenta: ct.map(c => cf.get(c)), serie: [...cp.values()].sort((x, y) => (x.f > y.f ? 1 : -1)), otros: 0 }; }
    A.forEach(n => { if (n.nar.rf) { const k = claveF(n.f), b = raf.get(k) || { f: k, n: 0, cc: new Map(), tm: new Map(), t: n.t }; b.n++; b.tm.set(n.nar.tm, (b.tm.get(n.nar.tm) || 0) + 1); (n.nar.cc || []).forEach(c => b.cc.set(c, (b.cc.get(c) || 0) + 1)); raf.set(k, b); } });
    const rafagas = [...raf.values()].sort((a, b) => b.n - a.n).slice(0, 40).map(b => ({ f: b.f, n: b.n, cc: topN(b.cc, 3).map(x => x[0]), t: b.t, nt: b.tm.size, tp: topN(b.tm, 3).map(([k, v]) => ({ k, v })) }));
    const fases = new Map(); A.forEach(n => n.nar.fa && fases.set(n.nar.fa, (fases.get(n.nar.fa) || 0) + 1));
    const conc = new Map(); A.forEach(n => (n.nar.cc || []).forEach(c => conc.set(c, (conc.get(c) || 0) + 1)));
    /* coocurrencia */
    const ef = new Map(), tipoE = new Map(), enl = new Map(); A.forEach(n => { n.nar.en.forEach(e => { const k = norm(e.n); if (!k) return; const o = ef.get(k) || { n: e.n, t: e.t, c: 0, r: 0 }; o.c++; o.r += e.r; ef.set(k, o); }); n.nar.re.forEach(r => { const a = norm(r.a), b = norm(r.b); if (!a || !b || a === b) return; const k = a < b ? a + "|" + b : b + "|" + a; enl.set(k, (enl.get(k) || 0) + r.i); }); });
    const nodos = [...ef.entries()].sort((a, b) => b[1].c * 10 + b[1].r - (a[1].c * 10 + a[1].r)).slice(0, 18).map(([k, o]) => ({ id: k, n: o.n, t: o.t, c: o.c })), ids = new Set(nodos.map(x => x.id));
    const enlaces = [...enl.entries()].map(([k, w]) => { const [a, b] = k.split("|"); return { a, b, w }; }).filter(e => ids.has(e.a) && ids.has(e.b)).sort((a, b) => b.w - a.w).slice(0, 60);
    /* acciones y posturas */
    const cz = new Map(), im = new Map(), lk = new Map(), ta = new Map(), pos = new Map(); A.forEach(n => n.nar.ac.forEach(a => { const c = norm(a.c), o = norm(a.o); if (!c || !o) return; cz.set(c, { n: a.c, v: ((cz.get(c) || { v: 0 }).v) + 1 }); im.set(o, { n: a.o, v: ((im.get(o) || { v: 0 }).v) + 1 }); const k = c + "|" + o + "|" + a.p; lk.set(k, (lk.get(k) || 0) + 1); if (a.ta) ta.set(a.ta, (ta.get(a.ta) || 0) + 1); pos.set(a.p, (pos.get(a.p) || 0) + 1); }));
    const izq = [...cz.entries()].sort((a, b) => b[1].v - a[1].v).slice(0, 7), der = [...im.entries()].sort((a, b) => b[1].v - a[1].v).slice(0, 7), si = new Set(izq.map(x => x[0])), sd = new Set(der.map(x => x[0]));
    const enlA = [...lk.entries()].map(([k, v]) => { const [c, o, p] = k.split("|"); return { c, o, p, v }; }).filter(e => si.has(e.c) && sd.has(e.o)).sort((a, b) => b.v - a.v).slice(0, 30);
    const evid = []; A.forEach(n => n.nar.ac.forEach(a => { if (a.ev && evid.length < 400) evid.push({ c: a.c, a: a.a, o: a.o, p: a.p, ev: a.ev, id: n.id, t: n.t }); }));
    /* encuadre */
    const fr = { Economico: 0, Politico: 0, Social: 0, Ambiental_Tecnico: 0 }, dom = { Economico: 0, Politico: 0, Social: 0, Ambiental_Tecnico: 0 }; A.forEach(n => { let mx = null; for (const k in fr) { fr[k] += n.nar.fr[k] || 0; if (!mx || (n.nar.fr[k] || 0) > (n.nar.fr[mx] || 0)) mx = k; } if (mx) dom[mx]++; }); for (const k in fr) fr[k] = Math.round(fr[k] / A.length * 10) / 10;
    /* propagación */
    const or = new Map(), foc = new Map(), coord = new Map(), mut = []; AP.forEach(n => { const N = n.nar; if (N.or) or.set(N.or, (or.get(N.or) || 0) + 1); if (N.fo) { const k = norm(N.fo); const o = foc.get(k) || { n: N.fo, c: 0, con: new Map(), ors: {}, cor: {} }; o.c++; if (N.or) o.ors[N.or] = (o.ors[N.or] || 0) + 1; N.co.forEach(x => { o.con.set(x, (o.con.get(x) || 0) + 1); if (N.or) (o.cor[x] = o.cor[x] || {})[N.or] = 1; }); foc.set(k, o); if (n.lug && n.lug.lat != null && !coord.has(k)) coord.set(k, { lat: n.lug.lat, lng: n.lug.lng }); } if (N.mu && mut.length < 12) mut.push({ id: n.id, t: n.t, f: n.f, or: N.or, mu: N.mu }); });
    const focos = [...foc.entries()].sort((a, b) => b[1].c - a[1].c).slice(0, 25).map(([k, o]) => { const con = topN(o.con, 5).map(x => x[0]), cor = {}; con.forEach(x => cor[x] = Object.keys(o.cor[x] || {})); return Object.assign({ n: o.n, c: o.c, con, ors: o.ors, cor }, coord.get(k) || {}); });
    /* hechos propagados: grupos de notas que cuentan el mismo suceso (misma huella de título, personas, cifras y lugar), con 3 o más notas de 2 o más medios */
    const liteL = n => ({ id: n.id, t: n.t, f: n.f, or: n.nar.or || "", mu: n.nar.mu || "", med: n.med, rf: n.nar.rf ? 1 : 0 }), porId = new Map(A.map(n => [n.id, n]));
    let hechos = []; try { hechos = qcDuplicados(A, QC_SENS.media).map(g => { const L = g.items.map(x => porId.get(x.id)).filter(Boolean).sort((x, y) => (x.f > y.f ? 1 : -1)), meds = new Set(L.map(n => n.dom || n.med)); return { id: L[0].id, t: L[0].t, n: L.length, med: meds.size, dias: Math.round((new Date(L[L.length - 1].f) - new Date(L[0].f)) / 864e5), tm: L[0].nar.tm || "", items: L.slice(0, 40).map(liteL) }; }).filter(h => h.n >= 3 && h.med >= 2).sort((a, b) => b.med - a.med || b.n - a.n).slice(0, 40); } catch (_) { }
    const puntos = AP.filter(n => n.lug && n.lug.lat != null).slice(0, 1500).map(n => ({ id: n.id, lat: n.lug.lat, lng: n.lug.lng, or: n.nar.or, t: n.t }));
    const ranking = [...ef.values()].length, tiposE = {}; ef.forEach(o => { tiposE[o.t] = (tiposE[o.t] || 0) + 1; });
    res.json({ ok: true, facetas: FAC, entFac: FE, universo: X.items.length, total: base.length, listas: A.length, pend, fallidas, est, paso, tops, serie, series, rafagas, fases: [...fases].map(([k, v]) => ({ k, v })), conceptos: topN(conc, 60).map(([k, v]) => ({ k, v })),
      kpis: { notas: A.length, entidades: ranking, tipos: tiposE, rafagas: A.filter(n => n.nar.rf).length, topico: tops[0] || "—", topicoN: tf.get(tops[0]) || 0, acciones: [...pos.values()].reduce((a, b) => a + b, 0) },
      cooc: { nodos, enlaces }, acc: { izq: izq.map(([k, o]) => ({ id: k, n: o.n, v: o.v })), der: der.map(([k, o]) => ({ id: k, n: o.n, v: o.v })), enlaces: enlA, tipos: topN(ta, 5).map(([k, v]) => ({ k, v })), posturas: [...pos].map(([k, v]) => ({ k, v })), evidencias: evid.slice(0, 40) },
      encuadre: { prom: fr, dom }, prop: { origen: topN(or, 5).map(([k, v]) => ({ k, v })), focos, puntos, mutaciones: mut, hechos } });
  }));
  /* una entidad/tópico: cuántas notas la mencionan en el tiempo (recurrencia) y su red de co-menciones */
  /* ───── Control de calidad ───── */
  const QC_STOP = new Set("de la el en y a los las del que por con un una para se al su es lo como mas o sus le ya este esta entre tras ante sobre sin no si fue son ha han sera desde hasta tambien pero muy uno dos tres otro otra otros anos ano hombre hombres mujer mujeres joven sujeto presunto presunta presuntos caso casos nuevo leon nl mexico tras durante luego segun quien cual donde cuando hoy ayer dia dias".split(" "));
  /* sinónimos frecuentes en nota roja y judicial: se llevan a una misma raíz antes de comparar */
  const QC_SIN = [[/^(sentenc|conden|dan$|dictan|impon|recib)/, "senten"], [/^(carcel|prision|reclus)/, "prisio"], [/^(asesin|homic|matan|mato|matar|ejecut|ultim)/, "homici"], [/^(deten|captur|arrest|aprehen|caen$|cae$|atrap)/, "deteni"], [/^(vincul|proces)/, "proces"], [/^(rob|asalt|atrac|hurt)/, "robo"], [/^(secuestr|plagi|privacion)/, "secues"], [/^(balac|balea|dispar|tirote|ataque armado)/, "balace"], [/^(muer|falle|sin vida|cadaver|cuerpo)/, "muerte"], [/^(camion|tractocamion|trailer|tractor)/, "camion"], [/^(polic|agente|elemento|oficial)/, "polici"], [/^(choq|choc|accident|volc|percance)/, "choque"]];
  const qcRaiz = w => { for (const [re, r] of QC_SIN) if (re.test(w)) return r; if (/^\d+$/.test(w)) return w; w = w.replace(/(es|s)$/, ""); return w.length > 6 ? w.slice(0, 6) : w; };
  const qcPal = s => norm(s).replace(/[^a-z0-9ñ ]/g, " ").split(/\s+/).filter(w => w.length > 1 && !QC_STOP.has(w) && (w.length > 2 || /^\d+$/.test(w)));
  const qcTok = n => [...new Set(qcPal(n.t).map(qcRaiz))];
  /* huella de una nota: raíces del título, raíces del título + resumen, cifras, personas («Juan Carlos N») y municipio */
  function qcHuella(n) {
    const cuerpo = [n.t, n.d, n.res].filter(Boolean).join(". "), largo = cuerpo + ". " + String(n.texto || "").slice(0, 900);
    const T = new Set(qcPal(n.t).map(qcRaiz)), B = new Set(qcPal(cuerpo).map(qcRaiz));
    const num = new Set((norm(cuerpo).match(/\b\d{1,3}(?:[.,]\d{3})*\b/g) || []).map(x => x.replace(/[.,]/g, "")).filter(x => +x >= 10 && !(+x >= 1990 && +x <= 2100)));
    const per = new Set(); (largo.match(/[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?: [A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,2} ["“”'‘’«]?N["“”'‘’»]?(?![a-záéíóúñA-Z])/g) || []).forEach(x => per.add(norm(x).replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim().replace(/ n$/, "")));
    ((n.nar && n.nar.en) || []).forEach(e => { if (e.t === "Persona") per.add(norm(e.n).replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim().replace(/ n$/, "")); }); ((n.ent && n.ent.pers) || []).forEach(x => per.add(norm(x).replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim().replace(/ n$/, "")));
    per.delete(""); [...per].forEach(x => { if (x.length < 4 || /\b(mujer|hombre|joven|sujeto|menor|adolescente|testigo|victima|conductor|chofer|taxista|policia|agente|juez|fiscal|sentenciad|detenid|imputad|acusad|presunt|responsable|vecin|familia|padre|madre|hijo|pareja|empleado|persona)/.test(x)) per.delete(x); });
    return { T, B, num, per, mun: n.lug && n.lug.mun ? n.lug.mun : "", est: n.lug && n.lug.est ? n.lug.est : "", tm: new Date(n.f).getTime() || 0 };
  }
  const QC_SENS = { estricta: .52, media: .41, amplia: .35 }, qcUmb = p => QC_SENS[(p && p.config && p.config.dupSens) || "media"] || .41;
  /* parecido entre dos notas (0 a 1) y motivos. Combina: palabras del título y del resumen ponderadas por rareza, cifras, personas y lugar. */
  function qcParecido(a, b, idf, dfP, N) {
    const jac = (A, B) => { let i = 0, u = 0; A.forEach(w => { const p = idf(w); u += p; if (B.has(w)) i += p; }); B.forEach(w => { if (!A.has(w)) u += idf(w); }); return u ? i / u : 0; };
    const sT = jac(a.T, b.T), sB = jac(a.B, b.B), nums = [...a.num].filter(x => b.num.has(x)), pers = [...a.per].filter(x => b.per.has(x)), mot = [];
    const mismoMun = a.mun && a.mun === b.mun, otroEst = a.est && b.est && a.est !== b.est, otroMun = a.mun && b.mun && a.mun !== b.mun, comp = x => [...x].some(y => y.includes(" ")), otraPer = !pers.length && comp(a.per) && comp(b.per);
    let s = .5 * sT + .5 * sB; if (sT >= .6) mot.push("título casi igual");
    if (pers.length) { const raro = pers.filter(x => (dfP.get(x) || 1) <= Math.max(6, N * .02)), fuerte = raro.filter(x => x.includes(" ")); s += fuerte.length ? .28 : raro.length ? .18 : .08; mot.push("misma persona: " + (fuerte[0] || raro[0] || pers[0])); } if (nums.length) { s += Math.min(.24, .14 * nums.length); mot.push("misma cifra: " + nums.slice(0, 2).join(", ")); }
    if (mismoMun) { s += .08; mot.push("mismo municipio"); } if (sT < .6) { if (otroEst) s -= .2; else if (otroMun) s -= .18; } if (otraPer) s -= .1;
    const dias = Math.abs(a.tm - b.tm) / 864e5; if (dias < 1.01) s += .04; else if (dias > 2) s -= .06;
    return { s: Math.max(0, Math.min(1, s)), sT, mot };
  }
  /* posibles duplicados: notas del mismo hecho publicadas con 3 días o menos de diferencia (o título casi igual hasta 5 días) */
  function qcDuplicados(items, umb) {
    const QC_UMB = umb || .41;
    const V = items.filter(n => !n.desc && n.t), H = V.map(qcHuella), df = new Map(); H.forEach(h => h.B.forEach(w => df.set(w, (df.get(w) || 0) + 1)));
    const dfP = new Map(); H.forEach(h => h.per.forEach(x => dfP.set(x, (dfP.get(x) || 0) + 1)));
    const N = V.length || 1, idf = w => Math.log(1 + N / (df.get(w) || 1)), inv = new Map(); H.forEach((h, i) => h.B.forEach(w => { if (df.get(w) <= Math.max(40, N * .08)) { let a = inv.get(w); if (!a) inv.set(w, a = []); a.push(i); } }));
    const pares = [];
    for (let i = 0; i < V.length; i++) {
      const c = new Map(); H[i].B.forEach(w => (inv.get(w) || []).forEach(j => { if (j > i) c.set(j, (c.get(j) || 0) + 1); }));
      c.forEach((k, j) => { if (k < 2) return; const dias = Math.abs(H[i].tm - H[j].tm) / 864e5; if (dias > 5 || (V[i].dupOk && V[i].dupOk === V[j].dupOk)) return; const r = qcParecido(H[i], H[j], idf, dfP, N); if ((r.s >= QC_UMB && dias <= 3.01) || (r.sT >= .6 && r.s >= .4)) pares.push([i, j, r.s, r.mot]); });
    }
    /* se unen primero los pares más parecidos; una nota entra a un grupo solo si se parece lo suficiente a la mayoría de sus miembros */
    pares.sort((a, b) => b[2] - a[2]); const grupo = new Map(), G = []; const sc = new Map(pares.map(p => [p[0] + "|" + p[1], p]));
    const par = (i, j) => sc.get(Math.min(i, j) + "|" + Math.max(i, j));
    for (const [i, j] of pares) {
      const gi = grupo.get(i), gj = grupo.get(j);
      if (gi == null && gj == null) { grupo.set(i, G.length); grupo.set(j, G.length); G.push([i, j]); }
      else if (gi != null && gj == null) { if (G[gi].filter(x => par(x, j)).length * 2 > G[gi].length) { G[gi].push(j); grupo.set(j, gi); } }
      else if (gi == null && gj != null) { if (G[gj].filter(x => par(x, i)).length * 2 > G[gj].length) { G[gj].push(i); grupo.set(i, gj); } }
    }
    const pri = n => (n.nar ? 4 : 0) + (n.an ? 2 : 0) + (n.texto ? 1 : 0);   /* se sugiere conservar la más trabajada; a igualdad, la más antigua */
    return G.filter(g => g.length > 1).map(g => {
      g.sort((a, b) => pri(V[b]) - pri(V[a]) || H[a].tm - H[b].tm);
      const its = g.map((i, k) => { const p = k ? par(g[0], i) || qcParecidoPar(H[g[0]], H[i], idf, dfP, N) : null; return { id: V[i].id, t: V[i].t, med: V[i].med, f: V[i].f, sim: k ? Math.round(p[2] * 100) : 100, mot: k ? p[3] : [], ia: !!V[i].an, nar: !!V[i].nar }; }), doms = new Set(g.map(i => V[i].dom || V[i].med));
      const sim = Math.round(its.slice(1).reduce((a, x) => a + x.sim, 0) / (its.length - 1));
      return { items: its, sim, tipo: doms.size === 1 ? "mismo medio" : "réplica entre " + doms.size + " medios" };
    }).sort((a, b) => b.items.length - a.items.length || b.sim - a.sim);
  }
  const qcParecidoPar = (a, b, idf, dfP, N) => { const r = qcParecido(a, b, idf, dfP, N); return [0, 0, r.s, r.mot]; };
  /* relevancia para el objetivo del proyecto: la IA puntúa cada nota (0–100) contra el objetivo y lo justifica.
     La huella del objetivo queda en la nota, así se sabe con qué versión del objetivo se evaluó. */
  const objHash = p => sha(norm((p && p.objetivo) || "").replace(/\s+/g, " ").trim()).slice(0, 10);
  const SYS_OBJ = "Eres analista de monitoreo de medios. Recibes el OBJETIVO de un proyecto de monitoreo y una lista de notas (id, título, resumen). Para CADA nota evalúa qué tan útil es para cumplir ese objetivo, sin importar el prestigio del medio. Devuelve ÚNICAMENTE un arreglo JSON, sin texto adicional, con un objeto por nota: {\"id\": \"…\", \"score\": entero de 0 a 100, \"motivo\": \"una oración en español, máx. 180 caracteres, que diga por qué la nota sirve o no sirve al objetivo, citando el hecho concreto\"}. Escala: 0–19 no tiene relación con el objetivo; 20–39 relación tangencial (mismo tema general, otro lugar o enfoque); 40–59 contexto útil pero no central; 60–79 relevante: aporta un hecho que el objetivo busca vigilar; 80–100 central: es exactamente el tipo de hecho que el objetivo pide. Sé estricto: no premies la sola coincidencia de palabras.";
  async function objetivoLote(lote, p, H) {
    const user = "OBJETIVO DEL PROYECTO «" + cut(p.titulo, 140) + "»:\n" + cut(p.objetivo, 600) + "\n\nNOTAS:\n" + JSON.stringify(lote.map(n => ({ id: n.id, titulo: n.t, resumen: cut(n.res || n.d || n.texto, 420) })));
    const txt = await llm(SYS_OBJ, user, 3500, p.id, lote.length), por = new Map(objetosJson(txt).map(o => [String(o.id), o])); let ok = 0;
    for (const n of lote) { const r = por.get(String(n.id)); if (!r || r.score == null || isNaN(+r.score)) continue; n.rob = { v: Math.max(0, Math.min(100, Math.round(+r.score))), j: cut(r.motivo, 220), h: H, at: ahoraIso() }; ok++; }
    return ok;
  }
  /* mapa de duplicados por proyecto (en memoria): nota recomendada → sus posibles duplicadas, y el conjunto de sobrantes */
  function qcDupMapa(X, umb) {
    const k = (umb || .41) + "|" + X.items.length + "|" + X.items.reduce((a, n) => a + (n.desc ? 1 : 0) + (n.dupOk ? 3 : 0) + (n.an ? 5 : 0) + (n.nar ? 7 : 0) + (n.texto ? 11 : 0), 0); if (X.dupC && X.dupC.k === k) return X.dupC;
    const de = new Map(), sob = new Set(); qcDuplicados(X.items, umb).forEach(g => { de.set(String(g.items[0].id), g.items.slice(1).map(x => String(x.id))); g.items.slice(1).forEach(x => sob.add(String(x.id))); });
    return X.dupC = { k, de, sob };
  }
  /* relevancia 0–100. Con clasificación IA: riesgo 30 %, gravedad 15 %, exposición 15 %, actor 10 %, polarización 10 %, tono 5 %, afinidad con los términos 15 %.
     Sin clasificación IA es preliminar: afinidad con los términos del proyecto, más texto completo y ubicación. */
  function qcRel(n, terms) {
    const enT = norm(n.t), hay = enT + " " + norm(n.d || ""); let ht = 0, hd = 0; for (const w of terms) { if (enT.includes(w)) ht++; else if (hay.includes(w)) hd++; }
    const afin = Math.min(100, ht * 40 + hd * 15);
    if (!n.an) return { v: Math.round(Math.min(100, afin * .7 + (n.texto ? 15 : 0) + (n.lug && n.lug.lat != null ? 15 : 0))), pre: 1, c: { afin } };
    const i = indicadores(n.an), c = { riesgo: i.risk || 0, grav: (i.grav && i.grav.pct) || 0, expo: i.expo || 0, actor: Math.min(5, +n.an.act || 0) * 20, pol: (i.pol || 0) * 10, tono: i.sent != null ? Math.abs(i.sent - 5) / 4 * 100 : 0, afin };
    Object.keys(c).forEach(k => { c[k] = Math.round(c[k]); });
    return { v: Math.round(.3 * c.riesgo + .15 * c.grav + .15 * c.expo + .1 * c.actor + .1 * c.pol + .05 * c.tono + .15 * c.afin), pre: 0, c };
  }
  app.get(R + "/proyectos/:id/calidad", wrap(async (req, res) => {
    const ci = await leeIdx(), p = ci.d.proyectos.find(x => x.id === req.params.id); if (!p) return res.status(404).json({ ok: false, error: "proyecto no encontrado" });
    const X = await cargaNoticias(req.params.id), q = req.query, V = X.items.filter(n => !n.desc), T = V.length, desc = X.items.length - T, dups = qcDuplicados(X.items, qcUmb(p)), nd = dups.reduce((a, g) => a + g.items.length - 1, 0);
    if (q.res === "1") return res.json({ ok: true, dups: { grupos: dups.length, notas: nd } });
    const terms = [...new Set(limpiaTerminos((p.config || {}).terminos).pos.map(norm))].filter(w => w.length > 2).slice(0, 400), RL = new Map(X.items.map(n => [n.id, qcRel(n, terms)]));
    const H = objHash(p), OV = Array.isArray(p.objVers) ? p.objVers : [], verDe = h => OV.findIndex(x => x.h === h) + 1;
    const pc = (a, b) => b ? Math.round(a / b * 1000) / 10 : 0, cu = f => V.filter(f).length, resid = n => !n.cat || /^(otr|sin categor|general)/i.test(n.cat);
    const conIA = cu(n => n.an), nar = cu(n => n.nar), narF = cu(n => !n.nar && (n.narF || 0) >= 2), nResid = cu(resid), sinTx = cu(n => estTx(n) !== 1);
    const M = (k, nom, v, nota, inv) => ({ k, nom, v, de: T, pct: pc(v, T), nota, inv: inv ? 1 : 0 });
    const metricas = [
      M("ia", "Clasificadas con IA", conIA, "Categoría, lugar, entidades e indicadores de riesgo asignados por la IA"),
      M("cat", "Con categoría definida", T - nResid, "No quedaron en una categoría residual (Otros, General o sin categoría)"),
      M("sub", "Con subcategoría", cu(n => n.sub), "Tienen subcategoría además de categoría"),
      M("lug", "Ubicadas en el mapa", cu(n => n.lug && n.lug.lat != null), "Tienen estado, municipio o punto con coordenadas"),
      M("pre", "Ubicación precisa", cu(n => n.lug && (n.lug.nivel === "punto" || n.lug.nivel === "zona")), "Ubicadas a nivel de zona, colonia o sitio"),
      M("tx", "Con texto completo", T - sinTx, "Se pudo descargar el texto de la nota; sin él la IA trabaja solo con título y descripción"),
      M("ent", "Con personas o instituciones", cu(n => n.ent && ((n.ent.pers || []).length || (n.ent.inst || []).length)), "Se identificó al menos una persona o institución"),
      M("obj", "Evaluadas contra el objetivo vigente", cu(n => n.rob && n.rob.h === H), "La IA puntuó su relevancia para el objetivo actual del proyecto"),
      M("nar", "Con análisis narrativo", nar, "Tópico, fase, entidades, acciones y encuadre"),
      M("narF", "Análisis narrativo fallido", narF, "La IA no devolvió un resultado utilizable tras dos intentos", true)];
    const cat = new Map(); V.forEach(n => { const k = n.cat || "Sin categoría", o = cat.get(k) || { cat: k, n: 0, ia: 0, nar: 0, rel: 0 }; o.n++; if (n.an) o.ia++; if (n.nar) o.nar++; o.rel += RL.get(n.id).v; cat.set(k, o); });
    const porCat = [...cat.values()].sort((a, b) => b.n - a.n).slice(0, 30).map(o => ({ cat: o.cat, n: o.n, ia: pc(o.ia, o.n), nar: pc(o.nar, o.n), rel: Math.round(o.rel / o.n) }));
    const hist = Array.from({ length: 10 }, () => 0); let sr = 0; V.forEach(n => { const v = RL.get(n.id).v; sr += v; hist[Math.min(9, Math.floor(v / 10))]++; });
    const alertas = []; if (dups.length) alertas.push({ niv: "alta", txt: `${dups.length} grupo(s) de noticias posiblemente duplicadas: ${nd} nota(s) sobrantes por revisar` });
    if (T - conIA) alertas.push({ niv: "media", txt: `${T - conIA} noticia(s) sin clasificar con IA` }); if (narF) alertas.push({ niv: "media", txt: `${narF} noticia(s) con análisis narrativo fallido` });
    const obAct = cu(n => n.rob && n.rob.h === H), obOld = cu(n => n.rob && n.rob.h !== H); if (obOld) alertas.push({ niv: "media", txt: `${obOld} noticia(s) evaluadas con una versión anterior del objetivo: conviene volver a evaluarlas` });
    if (T && nResid / T > .25) alertas.push({ niv: "media", txt: `${pc(nResid, T)}% de las noticias quedó en una categoría residual` }); if (T && sinTx / T > .4) alertas.push({ niv: "baja", txt: `${pc(sinTx, T)}% de las noticias no tiene texto completo` });
    const est = String(q.est || ""), min = Math.max(0, Math.min(100, +q.min || 0)), minOb = Math.max(0, Math.min(100, +q.minOb || 0)), ordOb = q.ord === "obj", obV = n => (n.rob ? n.rob.v : -1), enDup = new Set(dups.flatMap(g => g.items.slice(1).map(x => x.id)));
    const L = (est === "desc" ? X.items.filter(n => n.desc) : V).filter(n => (est === "sinia" ? !n.an : est === "conia" ? !!n.an : est === "sinnar" ? !n.nar : est === "connar" ? !!n.nar : est === "dup" ? enDup.has(n.id) : est === "sinobj" ? !n.rob : est === "objviejo" ? !!(n.rob && n.rob.h !== H) : true) && RL.get(n.id).v >= min && (!minOb || obV(n) >= minOb)).sort((() => {
      const k = ["obj", "t", "med", "f", "cat", "ia", "nar"].includes(q.ord) ? q.ord : "f", asc = q.dir === "asc" || (!q.dir && (k === "t" || k === "med" || k === "cat")), sg = asc ? 1 : -1, tx = v => String(v || "");
      const val = n => k === "obj" ? (n.rob ? n.rob.v : null) : k === "ia" ? (n.an ? 1 : 0) : k === "nar" ? (n.nar ? 2 : (n.narF || 0) >= 2 ? 1 : 0) : k === "f" ? tx(n.f) : tx(k === "t" ? n.t : k === "med" ? n.med : n.cat);
      return (a, b) => { const x = val(a), y = val(b); if (k === "obj" && (x == null || y == null)) { if (x == null && y == null) return (b.f > a.f ? 1 : -1); return x == null ? 1 : -1; }
        const c = typeof x === "number" ? x - y : x.localeCompare(y, "es", { sensitivity: "base" }); return c ? c * sg : (b.f > a.f ? 1 : -1); };
    })());
    const Ti = TARIFAS0.ia["claude-haiku-5-5"], us = (i, o) => Math.round((i * Ti.in + o * Ti.out) / 1e6 * 1e5) / 1e5;
    res.json({ ok: true, dupSens: QC_SENS[(p.config || {}).dupSens] ? p.config.dupSens : "media", fuentes: cuenta(V, fuenteDe), iaAuto: (p.config || {}).iaAuto === true, ia: !!process.env.ANTHROPIC_API_KEY, total: T, descartadas: desc, relMedia: T ? Math.round(sr / T) : 0, alertas, metricas, porCat, hist, costo: { clas: us(900, 450), narr: us(2200, 2300), obj: us(320, 75) },
      objetivo: { texto: p.objetivo || "", h: H, v: verDe(H) || OV.length + 1, registrada: !!verDe(H), act: obAct, viejas: obOld, sin: T - obAct - obOld, media: obAct ? Math.round(V.reduce((a, n) => a + (n.rob && n.rob.h === H ? n.rob.v : 0), 0) / obAct) : null, versiones: OV.map((x, i) => ({ v: i + 1, texto: x.texto, at: x.at, n: cu(n => n.rob && n.rob.h === x.h), act: x.h === H })) },
      dups: { grupos: dups.length, notas: nd, lista: dups.slice(0, 80) }, nTotal: L.length,
      notas: L.slice(0, Math.max(200, Math.min(2000, +q.lim || 200))).map(n => { const r = RL.get(n.id); return { id: n.id, prov: fuenteDe(n), t: n.t, med: n.med, f: n.f, cat: n.cat || "", rel: r.v, pre: r.pre, c: r.c, ia: n.an ? 1 : 0, nar: n.nar ? 1 : (n.narF || 0) >= 2 ? 2 : 0, tx: estTx(n), dup: enDup.has(n.id) ? 1 : 0, desc: n.desc ? 1 : 0, ob: n.rob ? { v: n.rob.v, j: n.rob.j, ver: verDe(n.rob.h), act: n.rob.h === H ? 1 : 0 } : null }; }) });
  }));
  app.post(R + "/proyectos/:id/calidad/accion", wrap(async (req, res) => {
    const b = req.body || {}, ids = new Set((Array.isArray(b.ids) ? b.ids : []).map(String)), X = await cargaNoticias(req.params.id); let n = 0;
    if (!["descartar", "restaurar", "nodup"].includes(b.tipo) || !ids.size) return res.status(400).json({ ok: false, error: "acción no válida" });
    const marca = "k" + Date.now().toString(36);
    X.items.forEach(x => { if (!ids.has(String(x.id))) return; n++; if (b.tipo === "descartar") x.desc = 1; else if (b.tipo === "restaurar") delete x.desc; else x.dupOk = marca; });
    if (n) { X.sucio = true; await guardaNoticias(req.params.id, X); } res.json({ ok: true, n });
  }));
  app.post(R + "/proyectos/:id/calidad/config", wrap(async (req, res) => {
    const b = req.body || {}, ok = await mutaIdx(ix => { const p = ix.proyectos.find(x => x.id === req.params.id); if (!p) return false; p.config = p.config || {}; if (b.iaAuto !== undefined) p.config.iaAuto = !!b.iaAuto; if (QC_SENS[b.dupSens]) p.config.dupSens = b.dupSens; return true; });
    if (!ok) return res.status(404).json({ ok: false, error: "proyecto no encontrado" }); res.json({ ok: true, iaAuto: !!b.iaAuto });
  }));
  /* análisis con IA a pedido sobre las notas elegidas: tipo «clas» (clasificación e indicadores) o «narr» (análisis narrativo) */
  app.post(R + "/proyectos/:id/calidad/analizar", wrap(async (req, res) => {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ ok: false, error: "Sin ANTHROPIC_API_KEY" });
    const id = req.params.id, b = req.body || {}, tipo = b.tipo === "narr" ? "narr" : b.tipo === "obj" ? "obj" : "clas", ids = new Set((Array.isArray(b.ids) ? b.ids : []).slice(0, 300).map(String));
    if (NAR_JOB.get(id) && Date.now() - NAR_JOB.get(id) < 50000) return res.status(409).json({ ok: false, error: "Ya hay un análisis con IA en curso en este proyecto" }); NAR_JOB.set(id, Date.now());
    try {
      const p0 = (await leeIdx()).d.proyectos.find(x => x.id === id), H = objHash(p0);
      if (tipo === "obj") {
        if (!p0 || String(p0.objetivo || "").trim().length < 5) return res.status(400).json({ ok: false, error: "El proyecto no tiene un objetivo escrito: edítalo y agrégalo" });
        await mutaIdx(ix => { const q = ix.proyectos.find(x => x.id === id); if (!q) return; q.objVers = Array.isArray(q.objVers) ? q.objVers : []; if (!q.objVers.some(x => x.h === H)) q.objVers.push({ h: H, texto: String(q.objetivo || "").slice(0, 600), at: ahoraIso() }); });
      }
      const X = await cargaNoticias(id), t0 = Date.now(), falta = n => !n.desc && n.t && (tipo === "narr" ? !n.nar && (n.narF || 0) < 2 : tipo === "obj" ? !n.rob || n.rob.h !== H : !n.an), pend = () => X.items.filter(n => ids.has(String(n.id)) && falta(n));
      if (b.todas) X.items.forEach(n => { if (falta(n)) ids.add(String(n.id)); });
      const esSoc = !!(p0 && p0.config && esFb(p0.config.proveedor)), cola = pend(), tam = tipo === "narr" ? 2 : tipo === "obj" ? 15 : esSoc ? 20 : 10, lotes = []; for (let i = 0; i < cola.length; i += tam) lotes.push(cola.slice(i, i + tam)); let hechas = 0, error = "";
      const ci = await leeIdx(), p = ci.d.proyectos.find(x => x.id === id), cfg = (p && p.config) || {}, G = tipo === "clas" ? await gaz() : null;
      const trabaja = async () => { while (lotes.length && Date.now() - t0 < 38000) { const l = lotes.shift();
        try { if (tipo === "narr") { for (const n of l) if (!n.texto && !n.txErr) { try { await bajaTexto(n, id); } catch (_) { } } hechas += await narrativaLote(l, id); } else if (tipo === "obj") { hechas += await objetivoLote(l, p0, H); } else if (esSoc) { hechas += await percepcionLote(l, id); } else { hechas += await enriqueceLote(l, G, id); if (cfg.geocodificar) for (const x of l) { try { await geocodifica(x, G, id); } catch (_) { } } } } catch (e) { error = String(e.message || e).slice(0, 200); } } };
      await Promise.all(tipo === "clas" ? [trabaja(), trabaja(), trabaja()] : [trabaja(), trabaja(), trabaja(), trabaja(), trabaja()]);
      if (hechas || tipo === "narr") { X.sucio = true; await guardaNoticias(id, X); }
      res.json({ ok: true, hechas, quedan: pend().map(n => n.id), error: error || undefined });
    } finally { NAR_JOB.delete(id); }
  }));
  app.get(R + "/proyectos/:id/entidad", wrap(async (req, res) => {
    const X = await cargaNoticias(req.params.id), nom = String(req.query.n || "").trim(); if (!nom) return res.status(400).json({ ok: false, error: "falta n" });
    const key = norm(nom), ents = n => { const e = n.ent || {}, m = new Map(); [["pers", e.pers], ["inst", e.inst], ["top", e.top]].forEach(([t, a]) => (a || []).forEach(v => { const k = norm(v); if (k && !m.has(k)) m.set(k, { n: v, t }); })); return m; };
    const frec = new Map(), ady = new Map(), mias = [];
    X.items.forEach(n => { const m = ents(n), ks = [...m.keys()]; ks.forEach(k => { const f = frec.get(k) || { n: m.get(k).n, t: m.get(k).t, c: 0 }; f.c++; frec.set(k, f); });
      for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) { const a = ks[i], b = ks[j]; [[a, b], [b, a]].forEach(([u, v]) => { const mm = ady.get(u) || new Map(); mm.set(v, (mm.get(v) || 0) + 1); ady.set(u, mm); }); }
      if (m.has(key)) mias.push(n); });
    const fechas = mias.map(n => n.f).filter(Boolean).sort(), t0 = fechas.length ? new Date(fechas[0]).getTime() : 0, t1 = fechas.length ? new Date(fechas[fechas.length - 1]).getTime() : 0, dias = (t1 - t0) / 864e5, paso = dias > 120 ? "mes" : dias > 40 ? "semana" : "dia";
    const cub = new Map(); mias.forEach(n => { const d = new Date(n.f); if (paso === "mes") d.setUTCDate(1); else if (paso === "semana") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); const k = d.toISOString().slice(0, 10); cub.set(k, (cub.get(k) || 0) + 1); });
    const serie = [...cub].sort((a, b) => (a[0] > b[0] ? 1 : -1)).map(([f, n]) => ({ f, n }));
    const vec = [...(ady.get(key) || new Map())].sort((a, b) => b[1] - a[1]).slice(0, 30), ids = [key, ...vec.map(v => v[0])], set = new Set(ids), enlaces = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { const w = (ady.get(ids[i]) || new Map()).get(ids[j]); if (w) enlaces.push({ a: ids[i], b: ids[j], w }); }
    const gr = new Map(), gp = new Map(); enlaces.forEach(e => { [[e.a], [e.b]].forEach(([k]) => { gr.set(k, (gr.get(k) || 0) + 1); gp.set(k, (gp.get(k) || 0) + e.w); }); }); const sg = [...gp.values()].reduce((a, b) => a + b, 0) || 1;
    const nodos = ids.map(k => { const f = frec.get(k) || { n: nom, t: "top", c: mias.length }; return { id: k, n: f.n, t: f.t, f: f.c, g: gr.get(k) || 0, gp: gp.get(k) || 0, c: Math.round((gp.get(k) || 0) / sg * 1000) / 10 }; });
    res.json({ ok: true, entidad: { id: key, n: (frec.get(key) || { n: nom }).n, t: (frec.get(key) || { t: "top" }).t, notas: mias.length }, paso, serie, nodos, enlaces, recientes: mias.sort((a, b) => (b.f > a.f ? 1 : -1)).slice(0, 5).map(n => ({ id: n.id, t: n.t, med: n.med, f: n.f })) });
  }));
  /* relanza una extracción completa de un proyecto (o de todos); con reubicar:true también vuelve a evaluar el lugar de las notas ya guardadas */
  app.post("/internal/medialab-relanzar", async (req, res) => {
    const secret = req.get("X-Sync-Secret") || ""; if (!process.env.SYNC_SECRET || secret !== process.env.SYNC_SECRET) return res.status(401).json({ ok: false, error: "unauthorized" });
    try {
      const b = req.body || {}, c = await leeIdx(true), ids = b.id ? [String(b.id)] : c.d.proyectos.map(p => p.id), out = [];
      for (const id of ids) {
        const p = c.d.proyectos.find(x => x.id === id); if (!p) { out.push({ id, ok: false, error: "no existe" }); continue; }
        const w = p.estado && p.estado.trabajo; if (w && w.fase !== "fin") { out.push({ id, ok: false, error: "ya hay una extracción en curso" }); continue; }
        if (b.reubicar) { const X = await cargaNoticias(id); X.items.forEach(n => { n.ia = 0; if (n.lug) n.lug.chk = 0; }); X.sucio = true; await guardaNoticias(id, X); }
        const g = await inicia(id, true); const r = await avanza(id, 40000); out.push({ id, ok: true, grupos: g, reubicar: !!b.reubicar, avance: r });
      }
      res.json({ ok: true, proyectos: out });
    } catch (e) { res.status(500).json({ ok: false, error: String(e.message).slice(0, 200) }); }
  });
  /* tic interno (Cloud Scheduler cada 2 min): continúa trabajos en curso y lanza los proyectos que ya tocan */
  app.post("/internal/medialab-cron", async (req, res) => {
    try {
      const secret = req.get("X-Sync-Secret") || ""; if (!process.env.SYNC_SECRET || secret !== process.env.SYNC_SECRET) return res.status(401).json({ ok: false, error: "unauthorized" });
      try { await venceVigencias(); } catch (e) { console.warn("[medialab] vigencias", e.message); }
      const c = await leeIdx(true), ahora = Date.now(), tareas = []; res.json({ ok: true, proyectos: c.d.proyectos.length });
      for (const p of c.d.proyectos) { if (p.situacion && p.situacion !== "activo") continue; const w = p.estado && p.estado.trabajo; try { if (w && w.fase !== "fin") tareas.push(avanza(p.id, 40000)); else if (p.estado && p.estado.proxima && new Date(p.estado.proxima).getTime() <= ahora && p.config.periodicidad !== "manual") { await inicia(p.id, false); tareas.push(avanza(p.id, 40000)); } } catch (e) { console.warn("[medialab] cron", p.id, e.message); } }
      await Promise.allSettled(tareas);
    } catch (e) { if (!res.headersSent) res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post("/internal/medialab-prueba", async (req, res) => {
    const secret = req.get("X-Sync-Secret") || ""; if (!process.env.SYNC_SECRET || secret !== process.env.SYNC_SECRET) return res.status(401).json({ ok: false, error: "unauthorized" });
    const b = req.body || {}, t0 = Date.now(); try { const h = new Date(), d = new Date(h - (+b.dias || 3) * 864e5), r = await FETCH[b.proveedor || "gdelt"]({ idiomas: b.idiomas || ["spanish"], paises: b.paises || ["MX"] }, b.q || "(inseguridad OR secuestro)", d, h, Date.now() + 40000); res.json({ ok: true, ms: Date.now() - t0, n: r.items.length, saturado: r.saturado, muestra: r.items.slice(0, 3).map(x => x.titulo) }); } catch (e) { res.json({ ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 300), limitado: !!e.limitado }); }
  });
  console.log("[medialab] módulo registrado");
  return { resuelveGN, limpiaTerminos, grupos, clasifica, lugarDe, gaz, normaliza, FETCH, inicia, avanza, extraeTexto, bajaTexto };
};
