// Mercado Libre Inmuebles: rutas de búsqueda, lectura de resultados y de fichas (HTML público; el sitio no bloquea al servidor).
// Se usa desde server.js (sección «Mercado Libre»). Sin estado propio: todo lo que guarda lo decide server.js.
const cheerio = require("cheerio");
const BASE = "https://inmuebles.mercadolibre.com.mx";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// Clasificaciones: id propio → ruta de Mercado Libre (verificadas con la faceta «Inmueble» de la página de resultados)
const CLASES = [
  { id: "departamento", nombre: "Departamento", ruta: "departamentos" }, { id: "casa", nombre: "Casa", ruta: "casas" },
  { id: "casa-condominio", nombre: "Casa en condominio", ruta: "casas", filtro: "condominio" }, { id: "oficina", nombre: "Oficina", ruta: "oficinas" },
  { id: "local", nombre: "Local comercial", ruta: "locales-comerciales" }, { id: "terreno", nombre: "Terreno", ruta: "terrenos" },
  { id: "bodega", nombre: "Bodega o galpón", ruta: "bodegas" }, { id: "edificio", nombre: "Edificio", ruta: "edificios" },
  { id: "quinta", nombre: "Quinta o hacienda", ruta: "haciendas" }, { id: "rancho", nombre: "Rancho", ruta: "ranchos" }];
const TIPOS = [{ id: "renta", nombre: "Rentar" }, { id: "venta", nombre: "Comprar" }, { id: "desarrollos", nombre: "Desarrollos" }, { id: "remate", nombre: "Remate" }];
const norm = t => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const slug = t => norm(t).replace(/ /g, "-");
const ESTADOS = { "aguascalientes": ["ags", "aguascalientes"], "baja-california": ["bc", "baja california", "b c"], "baja-california-sur": ["bcs", "baja california sur", "b c s"], "campeche": ["camp", "campeche"], "chiapas": ["chis", "chiapas"], "chihuahua": ["chih", "chihuahua"], "coahuila": ["coah", "coahuila", "coahuila de zaragoza"], "colima": ["col", "colima"], "distrito-federal": ["cdmx", "ciudad de mexico", "df", "d f", "distrito federal", "cd mx"], "durango": ["dgo", "durango"], "estado-de-mexico": ["edomex", "estado de mexico", "mex", "edo mex", "mexico"], "guanajuato": ["gto", "guanajuato"], "guerrero": ["gro", "guerrero"], "hidalgo": ["hgo", "hidalgo"], "jalisco": ["jal", "jalisco"], "michoacan": ["mich", "michoacan", "michoacan de ocampo"], "morelos": ["mor", "morelos"], "nayarit": ["nay", "nayarit"], "nuevo-leon": ["nl", "n l", "nuevo leon"], "oaxaca": ["oax", "oaxaca"], "puebla": ["pue", "puebla"], "queretaro": ["qro", "queretaro"], "quintana-roo": ["q roo", "qroo", "quintana roo"], "san-luis-potosi": ["slp", "s l p", "san luis potosi"], "sinaloa": ["sin", "sinaloa"], "sonora": ["son", "sonora"], "tabasco": ["tab", "tabasco"], "tamaulipas": ["tamps", "tamaulipas"], "tlaxcala": ["tlax", "tlaxcala"], "veracruz": ["ver", "veracruz"], "yucatan": ["yuc", "yucatan"], "zacatecas": ["zac", "zacatecas"] };
const ESTADO_DE = {}; Object.entries(ESTADOS).forEach(([s, al]) => al.forEach(a => { ESTADO_DE[a] = s; }));
// «Saltillo, Coah.» → { nombre, estado:"coahuila", ciudad:"saltillo" }; «Coahuila» → solo estado
function parseUbicacion(texto) {
  const p = String(texto || "").split(",").map(x => x.trim()).filter(Boolean); if (!p.length) return { error: "Escribe la ubicación (por ejemplo «Saltillo, Coah.»)" };
  const est = ESTADO_DE[norm(p[p.length - 1])]; if (!est && p.length === 1) return { error: "Escribe «Ciudad, Estado» (por ejemplo «Saltillo, Coah.»)" }; if (!est) return { error: `No reconozco el estado «${p[p.length - 1]}»` };
  const ciudad = p.length > 1 ? slug(p[0]) : ""; return { nombre: texto.trim(), estado: est, ciudad };
}
function rutaBusqueda({ tipo, clase, estado, ciudad, pagina }) {
  const loc = `${estado}/${ciudad ? ciudad + "/" : ""}`, pg = pagina > 1 ? `_Desde_${(pagina - 1) * 48 + 1}_NoIndex_True` : "";
  if (tipo === "desarrollos" || tipo === "remate") return `${BASE}/${tipo}/${loc}${pg}`;
  const c = CLASES.find(x => x.id === clase); return `${BASE}/${c ? c.ruta + "/" : ""}${tipo}/${loc}${pg}`;
}
async function pedir(url, intentos) {
  let ult; for (let i = 0; i < (intentos || 3); i++) {
    try { const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "es-MX,es;q=0.9", "Accept": "text/html,application/xhtml+xml" }, redirect: "follow", signal: AbortSignal.timeout(45000) });
      if (r.status === 404) return { html: "", status: 404, url: r.url }; if (r.status === 403 || r.status === 429) { ult = new Error("Mercado Libre limitó las lecturas (HTTP " + r.status + ")"); ult.bloqueo = true; await new Promise(z => setTimeout(z, 8000 * (i + 1))); continue; }
      if (!r.ok) throw new Error("HTTP " + r.status); return { html: await r.text(), status: 200, url: r.url }; } catch (e) { ult = e; if (e.bloqueo) continue; await new Promise(z => setTimeout(z, 2500 * (i + 1))); } }
  throw ult || new Error("sin respuesta");
}
const num = t => { const m = String(t || "").replace(/[, ]/g, "").match(/\d+(\.\d+)?/); return m ? +m[0] : null; };
const idDe = u => { const m = String(u || "").match(/MLM-?(\d{6,})/); return m ? m[1] : null; };
const limpiaUrl = u => String(u || "").split("#")[0].replace(/&amp;/g, "&");
function parseBusqueda(html) {
  const $ = cheerio.load(html), tot = (html.match(/([\d.,]+)\s*resultados?/) || [])[1], out = [];
  $("li.ui-search-layout__item").each((_, li) => {
    const c = $(li), a = c.find("a.poly-component__title").first(), url = limpiaUrl(a.attr("href")), id = idDe(url); if (!id) return;
    const money = c.find(".poly-component__price .andes-money-amount").first(), prAria = money.attr("aria-label") || "", pr = num(money.find(".andes-money-amount__fraction").first().text()) || num(prAria), mon = /d[oó]lar|usd/i.test(prAria) || /US|USD/.test(money.find(".andes-money-amount__currency-symbol").first().text()) ? "USD" : "MXN";
    const attrs = c.find(".poly-attributes_list li, .poly-attributes-list__item").map((__, x) => $(x).text().replace(/\s+/g, " ").trim()).get(), head = c.find(".poly-component__headline").first().text().trim();
    const rec = attrs.map(x => x.match(/(\d+)\s*rec/i)).find(Boolean), ban = attrs.map(x => x.match(/(\d+(?:\.\d+)?)\s*ba[nñ]/i)).find(Boolean), m2 = attrs.map(x => x.match(/([\d.,]+)\s*m²/i)).find(Boolean);
    out.push({ id, url, titulo: a.text().replace(/\s+/g, " ").trim(), headline: head, precio: pr, moneda: mon, atributos: attrs, recamaras: rec ? +rec[1] : (attrs.some(x => /monoambiente|sin rec/i.test(x)) ? 0 : null), banos: ban ? +ban[1] : null, m2: m2 ? num(m2[1]) : null, ubicacion: c.find(".poly-component__location").first().text().replace(/\s+/g, " ").trim(), thumb: c.find("img.poly-component__picture").first().attr("src") || "" });
  });
  return { total: tot ? num(tot) : null, items: out };
}
function parseFicha(html, url) {
  const $ = cheerio.load(html), T = s => $(s).first().text().replace(/\s+/g, " ").trim(); let ld = null;
  $("script[type='application/ld+json']").each((_, s) => { try { const d = JSON.parse($(s).contents().text()); if (d && d["@type"] === "Product" && !ld) ld = d; } catch (_) {} });
  const sub = T(".ui-pdp-header__subtitle, .ui-pdp-subtitle"), pub = (sub.match(/Publicado[^|]*/i) || [""])[0].trim(), op = /renta/i.test(sub || T("h1")) ? "renta" : /venta/i.test(sub) ? "venta" : "";
  const ic = $(".ui-pdp-highlighted-specs-res__icon-label").map((_, x) => $(x).text().replace(/\s+/g, " ").trim()).get(), at = {}; $(".ui-vpp-highlighted-specs__key-value").each((_, x) => { const t = $(x).text().replace(/\s+/g, " ").trim(), i = t.indexOf(":"); if (i > 0) at[t.slice(0, i).trim()] = t.slice(i + 1).trim(); });
  const rec = ic.map(x => x.match(/(\d+)\s*rec/i)).find(Boolean), ban = ic.map(x => x.match(/(\d+(?:\.\d+)?)\s*ba[nñ]/i)).find(Boolean), mt = ic.map(x => x.match(/([\d.,]+)\s*m²\s*tot/i)).find(Boolean), mc = ic.map(x => x.match(/([\d.,]+)\s*m²\s*(?:cub|const|útil|util)/i)).find(Boolean);
  const dir = T(".ui-vip-location__subtitle p, .ui-vip-location__subtitle").trim(), P = dir.split(",").map(x => x.trim()).filter(Boolean);
  const mp = (html.replace(/&amp;/g, "&").match(/staticmap\?[^"']*?center=(-?\d+\.\d+)%2C(-?\d+\.\d+)[^"']*?zoom=(\d+)/) || html.replace(/&amp;/g, "&").match(/staticmap\?[^"']*?center=(-?\d+\.\d+),(-?\d+\.\d+)[^"']*?zoom=(\d+)/) || []);
  const fotos = [...new Set((html.match(/https:\\?\/\\?\/http2\.mlstatic\.com\\?\/D_NQ_NP_(?:2X_)?\d+-MLM\d+_\d+-[A-Z](?:-[A-Za-z0-9_-]+)?\.(?:webp|jpg)/g) || []).map(x => x.replace(/\\/g, "")))];
  const porId = new Map(); fotos.forEach(u => { const k = (u.match(/(\d+-MLM\d+_\d+)/) || [])[1]; if (k && !porId.has(k)) porId.set(k, u.replace(/D_NQ_NP_2X_/, "D_NQ_NP_")); });
  const off = (ld && ld.offers) || {}, pr = off.price != null ? +off.price : num(T(".ui-pdp-price__second-line .andes-money-amount__fraction, .andes-money-amount__fraction"));
  return { id: idDe(url) || idDe((ld || {}).sku), url: limpiaUrl(url), titulo: (ld && ld.name) || T("h1"), op, publicado: pub, precio: pr, moneda: off.priceCurrency || "MXN", recamaras: rec ? +rec[1] : (ic.some(x => /monoamb/i.test(x)) ? 0 : null), banos: ban ? +ban[1] : null, m2_total: mt ? num(mt[1]) : null, m2_construccion: mc ? num(mc[1]) : null,
    estacionamientos: at["Estacionamientos"] != null ? num(at["Estacionamientos"]) : null, atributos: at, descripcion: T(".ui-pdp-description__content"), direccion: dir, calle: P.length >= 3 ? P.slice(0, P.length >= 4 ? P.length - 3 : 1).join(", ") : "", colonia: P.length >= 4 ? P[P.length - 3] : "", ciudad: P.length >= 2 ? P[P.length - 2] : "", estado: P.length >= 1 ? P[P.length - 1] : "",
    lat: mp[1] ? +mp[1] : null, lng: mp[2] ? +mp[2] : null, zoom: mp[3] ? +mp[3] : null, geoPrec: mp[1] ? Math.min((mp[1].split(".")[1] || "").length, (mp[2].split(".")[1] || "").length) : null, vendedor: T(".ui-vip-profile-info__info-container .ui-pdp-seller__header__title, .ui-pdp-seller__header__title, .ui-vip-profile-info a, .ui-vip-profile-info").slice(0, 120) || "", fotos: [...porId.values()].slice(0, 40), estado_pub: /pausad|finalizad|no est[aá] disponible/i.test(T(".ui-pdp-message, .ui-pdp-container__row--message")) ? "no_disponible" : "ok" };
}
module.exports = { CLASES, TIPOS, ESTADOS, parseUbicacion, rutaBusqueda, pedir, parseBusqueda, parseFicha, BASE, UA };
