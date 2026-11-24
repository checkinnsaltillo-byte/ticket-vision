/* Model Lab · modelado estadístico y aprendizaje automático por proyecto.
   Proyectos (objetivo, puntos de interés, opciones) → tabla de variables por punto (indicadores de la malla nacional + columnas del usuario) → modelo en el navegador.
   Este módulo guarda proyectos, puntos, datos y resultados en Cloud Storage, arma la tabla de datos por coordenada y busca unidades del DENUE.
   Se registra con require("./modelab.js")(app, deps). */
"use strict";
const crypto = require("crypto");

module.exports = function (app, D) {
  const R = "/geometrika/modelab", IDX = "modelab/proyectos.json", OB = (id, n) => `modelab/${id}/${n}.json`;
  const sleep = ms => new Promise(r => setTimeout(r, ms)), ahora = () => new Date().toISOString(), norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const idOk = id => /^[a-z0-9]{6,24}$/.test(String(id || "")), SCIAN = (() => { try { return require("./scian.json"); } catch (_) { return { s: {}, ss: {} }; } })();
  const wrap = fn => async (req, res) => { if (!D.originOk(req)) return res.status(403).json({ ok: false }); try { await fn(req, res); } catch (e) { res.status(e.status || 500).json({ ok: false, error: String(e.message || e) }); } };
  const err = (m, st) => { const e = new Error(m); e.status = st || 400; return e; };

  /* ───────── Bienes inmuebles: bases de propiedades descargadas en Check Inn (Alojamientos Airbnb, Publicaciones de Facebook y de Mercado Libre) ─────────
     Se entregan como tabla normalizada (columnas legibles + coordenadas) para usarlas como puntos de interés y para el análisis de valuación. */
  const INM = { c: new Map() };
  const num = v => { if (v == null || v === "") return null; const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^\d.\-]/g, "")); return Number.isFinite(n) ? n : null; };
  const bool01 = v => v === true || v === "true" || v === 1 ? 1 : v === false || v === "false" || v === 0 ? 0 : null;
  const TIPO_RX = [["departamento", /\b(departamento|depto|depa|dpto|penthouse|loft)\b/i], ["casa", /\b(casa|residencia|townhouse|duplex)\b/i], ["terreno", /\b(terreno|lote|predio)\b/i], ["oficina", /\b(oficina|consultorio)\b/i], ["local", /\b(local|plaza comercial|comercial)\b/i], ["bodega", /\b(bodega|galp[oó]n|nave industrial)\b/i], ["edificio", /\bedificio\b/i], ["quinta", /\b(quinta|hacienda|rancho|parcela)\b/i], ["cuarto", /\b(cuarto|habitaci[oó]n|recamara en renta)\b/i]];
  const tipoDe = t => { const s = String(t || ""); for (const [k, rx] of TIPO_RX) if (rx.test(s)) return k; return "otro"; };
  const USD = 18.5;   // conversión aproximada para publicaciones en dólares (solo referencia: la columna «Moneda original» conserva el dato)
  const FUENTES = {
    airbnb: { id: "airbnb", nombre: "Alojamientos (Airbnb)", desc: "Alojamientos de Airbnb descargados: tipo, capacidad, calificación, amenidades y precio por noche de la última búsqueda.", obj: "mercado/airbnb.json", unidad: "MXN por noche" },
    facebook: { id: "facebook", nombre: "Publicaciones en Facebook", desc: "Publicaciones de Marketplace estructuradas: tipo, operación, precio, superficie, recámaras y baños.", obj: "mercado/facebook.json", unidad: "MXN" },
    mercadolibre: { id: "mercadolibre", nombre: "Publicaciones en Mercado Libre", desc: "Inmuebles de Mercado Libre: venta y renta, superficie, recámaras, baños y precisión de la ubicación.", obj: "mercado/mercadolibre.json", unidad: "MXN" }
  };
  async function leeInm(f) {
    const c = INM.c.get(f); if (c && Date.now() - c.t < 300000) return c.d; const F = FUENTES[f]; if (!F) throw err("Fuente no válida", 404); const { data } = await D.readGcs(F.obj), items = (data && data.items) || {}; let rows = [], cols = [];
    if (f === "airbnb") {
      const lista = new Map(((data && data.lista) || []).map(l => [String(l.id), l]));
      cols = ["ID", "Título", "Tipo", "Operación", "Precio", "Ciudad", "Estado", "Latitud", "Longitud", "Huéspedes", "Habitaciones", "Camas", "Baños", "Calificación", "Evaluaciones", "Superanfitrión", "Años del anfitrión", "Núm. de amenidades", "Ocupación a 90 días", "Noches mínimas", "URL"];
      Object.values(items).forEach(it => { if (num(it.lat) == null || num(it.lng) == null) return; const l = lista.get(String(it.id)), p = l && num(l.precioNoche); const tp = String(it.tipo || "").split(":")[0].trim();
        rows.push([String(it.id), it.titulo || "", tp, "noche", p, it.ciudad || "", it.estado || "", num(it.lat), num(it.lng), num(it.huespedes), num(it.habitaciones), num(it.camas), num(it.banos), num(it.calificacion), num(it.evaluaciones), bool01(it.superanfitrion), num(it.hostAnios), num(it.nAmenidades), num(it.ocup90), num(it.minNoches), it.url || ""]); });
    } else if (f === "facebook") {
      cols = ["ID", "Título", "Tipo", "Operación", "Precio", "Periodo", "Ciudad", "Estado", "Colonia", "Dirección", "Código postal", "Latitud", "Longitud", "Recámaras", "Baños", "Medios baños", "Estacionamientos", "m² construcción", "m² terreno", "Amueblado", "Núm. de amenidades", "Publicada", "URL"];
      Object.values(items).forEach(it => { if (it.geo === false || num(it.lat) == null || num(it.lng) == null) return; let p = num(it.precio); const t = `${it.titulo || ""} ${String(it.descripcion || "").slice(0, 400)}`, venta = /\b(se vende|en venta|vendo|venta de|\bventa\b)\b/i.test(t) && !/\b(renta|rento|alquiler)\b/i.test(String(it.titulo || ""));
        const op = venta ? "venta" : /\b(renta|rento|alquil)/i.test(t) ? "renta" : (p != null && p >= 300000 ? "venta" : (it.operacion || "renta"));
        if (p != null && it.periodo && /diari|noche/i.test(it.periodo)) p *= 30; else if (p != null && it.periodo && /semana/i.test(it.periodo)) p *= 4.33;
        rows.push([String(it.id), it.titulo || "", it.tipo || tipoDe(t), op, p, it.periodo || "", it.ciudad || "", it.estado || "", it.colonia || "", it.direccion || "", it.cp || "", num(it.lat), num(it.lng), num(it.recamaras), num(it.banos), num(it.medios_banos), num(it.estacionamientos), num(it.m2_construccion), num(it.m2_terreno), bool01(it.amueblado), Array.isArray(it.amenidades) ? it.amenidades.length : null, it.publicada || it.fecha_publicacion || "", it.url_origen || it.url || ""]); });
    } else {
      cols = ["ID", "Título", "Tipo", "Operación", "Precio", "Moneda original", "Ciudad", "Estado", "Colonia", "Calle", "Latitud", "Longitud", "Precisión de la ubicación", "Tipo de ubicación", "Recámaras", "Baños", "Estacionamientos", "m² totales", "m² construcción", "Antigüedad (años)", "Jardín", "Publicado", "URL"];
      Object.values(items).forEach(it => { if (num(it.lat) == null || num(it.lng) == null) return; let p = num(it.precio); const mo = it.moneda || "MXN"; if (p != null && /USD|U\$S/i.test(mo)) p = Math.round(p * USD); const at = it.atributos || {};
        rows.push([String(it.id), it.titulo || "", tipoDe(`${it.titulo || ""} ${String(it.url || "").replace(/[-_]/g, " ")}`), it.op || "", p, mo, it.ciudad || "", it.estado || "", it.colonia || "", it.calle || "", num(it.lat), num(it.lng), num(it.geoPrec), it.geoTipo || "", num(it.recamaras != null ? it.recamaras : at.Recámaras), num(it.banos != null ? it.banos : at.Baños), num(it.estacionamientos != null ? it.estacionamientos : at.Estacionamientos), num(it.m2_total), num(it.m2_construccion), num(at.Antigüedad), at.Jardín == null ? null : (/s[ií]|^1$/i.test(String(at.Jardín)) ? 1 : 0), it.publicado || "", it.url || ""]); });
    }
    const d = { cols, rows, total: Object.keys(items).length, at: ahora() }; INM.c.set(f, { t: Date.now(), d }); return d;
  }
  /* fotos, publicante y desarrollo de las publicaciones (para las tarjetas de la valuación); se piden por id, aparte de la tabla para no contaminar el modelo */
  const FOT = { t: 0, m: null };
  async function leeFotos() {
    if (FOT.m && Date.now() - FOT.t < 300000) return FOT.m; const m = {};
    for (const f of Object.keys(FUENTES)) { try { const { data } = await D.readGcs(FUENTES[f].obj), items = (data && data.items) || {}, lista = new Map(((data && data.lista) || []).map(l => [String(l.id), l]));
      Object.values(items).forEach(it => { const id = String(it.id); let foto = "", host = "", sub = "";
        if (f === "airbnb") { foto = it.foto || ""; host = it.anfitrion || ""; sub = it.tipo || ""; }
        else if (f === "facebook") { const fo = Array.isArray(it.fotos) ? it.fotos[0] : null; foto = (fo && (fo.url || fo)) || ""; host = it.contacto_nombre || ""; sub = it.colonia || ""; }
        else { const l = lista.get(id) || {}; foto = (it.fotos || []).filter(Boolean)[0] || l.thumb || ""; host = it.vendedor || ""; sub = it.colonia || ""; }
        m[id] = { f: typeof foto === "string" ? foto : "", h: String(host || ""), s: String(sub || "") }; }); } catch (_) { } }
    FOT.m = m; FOT.t = Date.now(); return m;
  }
  /* ficha completa de una publicación (fotos, descripción, atributos, vendedor) para abrirla dentro de la valuación */
  const RAW = { c: new Map() };
  async function leeRaw(f) { const c = RAW.c.get(f); if (c && Date.now() - c.t < 300000) return c.d; const { data } = await D.readGcs(FUENTES[f].obj), d = { items: (data && data.items) || {}, lista: new Map(((data && data.lista) || []).map(l => [String(l.id), l])) }; RAW.c.set(f, { t: Date.now(), d }); return d; }
  const fx = v => (v == null || v === "" || (Array.isArray(v) && !v.length)) ? null : v;
  app.post(R + "/inmuebles/ficha", wrap(async (req, res) => {
    const id = String((req.body || {}).id || ""); if (!id) throw err("Falta el id", 400); let out = null;
    for (const f of Object.keys(FUENTES)) { const R2 = await leeRaw(f), it = R2.items[id] || Object.values(R2.items).find(x => String(x.id) === id); if (!it) continue;
      const pares = [], P = (k, v, u) => { v = fx(v); if (v != null) pares.push([k, u ? v + " " + u : v]); };
      if (f === "mercadolibre") { const l = R2.lista.get(id) || {}, at = it.atributos || {}; const fotos = (it.fotos || []).filter(Boolean); if (!fotos.length && l.thumb) fotos.push(l.thumb);
        P("Operación", it.op); P("Recámaras", it.recamaras != null ? it.recamaras : at["Recámaras"]); P("Baños", it.banos != null ? it.banos : at["Baños"]); P("Estacionamientos", it.estacionamientos); P("Superficie total", it.m2_total, "m²"); P("Superficie construida", it.m2_construccion, "m²"); Object.keys(at).forEach(k => P(k, at[k]));
        out = { fuente: "Mercado Libre", titulo: it.titulo, url: it.url, descripcion: it.descripcion || "", fotos, pares, vendedor: it.vendedor || "", ubicacion: it.direccion || [it.colonia, it.ciudad, it.estado].filter(Boolean).join(", "), publicado: it.publicado || it.extraido || "", amenidades: [] }; }
      else if (f === "facebook") { const fotos = (Array.isArray(it.fotos) ? it.fotos : []).map(x => x && (x.url || x)).filter(x => typeof x === "string");
        P("Tipo", it.tipo); P("Operación", it.operacion); P("Periodo", it.periodo); P("Recámaras", it.recamaras); P("Baños", it.banos); P("Medios baños", it.medios_banos); P("Estacionamientos", it.estacionamientos); P("Construcción", it.m2_construccion, "m²"); P("Terreno", it.m2_terreno, "m²"); P("Amueblado", it.amueblado === true ? "Sí" : it.amueblado === false ? "No" : null); P("Detalles", it.detalles_unidad); P("Vendedor en Facebook desde", it.vendedor_desde);
        out = { fuente: "Facebook Marketplace", titulo: it.titulo, url: it.url_origen || it.url, descripcion: it.descripcion || "", fotos, pares, vendedor: it.contacto_nombre || "", ubicacion: [it.direccion, it.colonia, it.ciudad, it.estado].filter(Boolean).join(", "), publicado: it.publicado_texto || it.fecha_publicacion || "", amenidades: Array.isArray(it.amenidades) ? it.amenidades : [] }; }
      else { const fotos = it.foto ? [it.foto] : [], l = R2.lista.get(id) || {};
        P("Tipo", it.tipo); P("Huéspedes", it.huespedes); P("Habitaciones", it.habitaciones); P("Camas", it.camas); P("Baños", it.banos); P("Calificación", it.calificacion); P("Evaluaciones", it.evaluaciones); P("Superanfitrión", it.superanfitrion ? "Sí" : "No"); P("Años del anfitrión", it.hostAnios); P("Noches mínimas", it.minNoches); P("Ocupación a 90 días", it.ocup90 != null ? it.ocup90 + " %" : null); P("Precio por noche", l.precioNoche ? "$" + Math.round(l.precioNoche).toLocaleString("es-MX") : null);
        out = { fuente: "Airbnb", titulo: it.titulo, url: it.url, descripcion: it.descripcion || it.ubicacionTxt || "", fotos, pares, vendedor: it.anfitrion || "", ubicacion: it.ubicacion || [it.ciudad, it.estado].filter(Boolean).join(", "), publicado: "", amenidades: Array.isArray(it.amenidades) ? it.amenidades.slice(0, 40) : [] }; }
      out.lat = it.lat; out.lng = it.lng; break; }
    if (!out) throw err("No se encontró la publicación", 404); res.set("Cache-Control", "no-store"); res.json({ ok: true, ficha: out }); }));
  app.post(R + "/inmuebles/fotos", wrap(async (req, res) => { const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.slice(0, 5000) : [], m = await leeFotos(), out = {}; ids.forEach(i => { const k = String(i); if (m[k]) out[k] = m[k]; }); res.set("Cache-Control", "no-store"); res.json({ ok: true, items: out }); }));
  /* proxy de fotos de las publicaciones (solo hosts de portales conocidos): algunos navegadores o bloqueadores no dejan cargar las imágenes de terceros directamente */
  app.get(R + "/inmuebles/img", async (req, res) => {
    try { const u = new URL(String(req.query.u || "")); if (u.protocol !== "https:" || !/(^|\.)(mlstatic\.com|fbcdn\.net|muscache\.com)$/i.test(u.hostname)) return res.status(400).end();
      const r = await fetch(u.href, { headers: { accept: "image/*" } }); if (!r.ok) return res.status(404).end(); const ct = r.headers.get("content-type") || ""; if (!/^image\//i.test(ct)) return res.status(415).end();
      const b = Buffer.from(await r.arrayBuffer()); if (b.length > 6e6) return res.status(413).end(); res.set({ "Content-Type": ct, "Cache-Control": "public, max-age=86400", "Cross-Origin-Resource-Policy": "cross-origin" }); res.end(b); } catch (_) { res.status(502).end(); } });
  app.get(R + "/inmuebles", wrap(async (req, res) => {
    const out = []; for (const f of Object.keys(FUENTES)) { try { const d = await leeInm(f), F = FUENTES[f]; out.push({ id: F.id, nombre: F.nombre, desc: F.desc, unidad: F.unidad, n: d.rows.length, total: d.total, conPrecio: d.rows.filter(r => r[4] != null).length }); } catch (_) { out.push({ id: f, nombre: FUENTES[f].nombre, desc: FUENTES[f].desc, n: 0, total: 0, conPrecio: 0 }); } }
    res.set("Cache-Control", "no-store"); res.json({ ok: true, fuentes: out });
  }));
  app.get(R + "/inmuebles/:fuente", wrap(async (req, res) => { const d = await leeInm(String(req.params.fuente)); res.set("Cache-Control", "no-store"); res.json({ ok: true, fuente: FUENTES[req.params.fuente].nombre, unidad: FUENTES[req.params.fuente].unidad, cols: d.cols, rows: d.rows, total: d.total }); }));

  /* ───────── índice de proyectos (concurrencia optimista) ───────── */
  let IC = { d: null, gen: null, t: 0 };
  async function leeIdx(fresco) { if (!fresco && IC.d && Date.now() - IC.t < 3000) return IC; const { data, gen } = await D.readGcs(IDX); IC = { d: data && Array.isArray(data.proyectos) ? data : { proyectos: [] }, gen, t: Date.now() }; return IC; }
  async function mutaIdx(fn) { for (let i = 0; i < 6; i++) { const c = await leeIdx(true), r = fn(c.d); try { await D.writeGcs(IDX, c.d, c.gen); IC = { d: c.d, gen: String(Date.now()), t: 0 }; return r; } catch (e) { if (!e.conflict) throw e; await sleep(150 * (i + 1)); } } throw err("No se pudo guardar el proyecto; intenta de nuevo.", 409); }

  /* ───────── proyectos ───────── */
  /* ── análisis anidados en cada proyecto: un mismo conjunto de datos puede tener varios (modelos supervisados, no supervisados…). El análisis «principal» usa los archivos de siempre; los nuevos, an_<id>_* ── */
  const aidDe = req => { const a = String((req.query && req.query.a) || ""); return /^[a-z0-9]{3,20}$/.test(a) && a !== "principal" ? a : "principal"; };
  const AK = (id, aid, n) => aid === "principal" ? OB(id, n) : OB(id, "an_" + aid + "_" + n);
  const listaAn = p => (p.analisis && p.analisis.length) ? p.analisis : [{ id: "principal", nombre: "Análisis principal", creado: p.creado, actualizado: p.actualizado, estado: p.estado || "nuevo", enfoque: p.enfoque || null, metodo: p.metodo || null, kpi: p.kpi || null, nVars: p.nVars || 0 }];
  const asegura = p => { if (!p.analisis || !p.analisis.length) p.analisis = listaAn(p).map(a => Object.assign({}, a)); return p.analisis; };
  const sincro = p => { const L = p.analisis || []; if (!L.length) return; p.estado = L.some(a => a.estado === "modelado") ? "modelado" : L.some(a => a.estado === "configurado") ? "configurado" : "nuevo"; const u = L.slice().sort((a, b) => String(b.actualizado || "").localeCompare(String(a.actualizado || "")))[0]; p.enfoque = u.enfoque || null; p.metodo = u.metodo || null; p.kpi = u.kpi || null; p.nVars = u.nVars || 0; p.actualizado = ahora(); };
  const resumen = p => ({ id: p.id, nombre: p.nombre, objetivo: String(p.objetivo || "").slice(0, 240), creado: p.creado, actualizado: p.actualizado, nPuntos: p.nPuntos || 0, fuente: p.fuente || "mapa", columnas: p.columnas || [], estado: p.estado || "nuevo", enfoque: p.enfoque || null, metodo: p.metodo || null, kpi: p.kpi || null, usuario: p.usuario || null, vars: p.nVars || 0, nAn: listaAn(p).length, analisis: listaAn(p).map(a => ({ id: a.id, nombre: a.nombre, estado: a.estado })) });
  app.get(R + "/proyectos", wrap(async (req, res) => { const c = await leeIdx(true); res.set("Cache-Control", "no-store"); res.json({ ok: true, proyectos: c.d.proyectos.filter(x => x.tipo !== "sim").map(resumen).sort((a, b) => String(b.actualizado || b.creado).localeCompare(String(a.actualizado || a.creado))) }); }));
  app.get(R + "/proyectos/:id", wrap(async (req, res) => { const id = req.params.id; if (!idOk(id)) throw err("id"); const c = await leeIdx(true), p = c.d.proyectos.find(x => x.id === id); if (!p) throw err("No existe el proyecto.", 404);
    const [pu, mo] = await Promise.all([D.readGcs(OB(id, "puntos")), D.readGcs(OB(id, "modelo"))]); res.set("Cache-Control", "no-store"); res.json({ ok: true, proyecto: p, puntos: (pu.data && pu.data.puntos) || [], modelo: mo.data || null, analisis: listaAn(p) }); }));
  app.post(R + "/proyectos", wrap(async (req, res) => {
    const b = req.body || {}, nombre = String(b.nombre || "").trim().slice(0, 80); if (!nombre) throw err("Falta el nombre del proyecto."); const puntos = Array.isArray(b.puntos) ? b.puntos.slice(0, 20000) : [];
    if (!puntos.length) throw err("El proyecto necesita al menos un punto de interés.");
    for (const q of puntos) if (!isFinite(+q.lat) || !isFinite(+q.lng) || Math.abs(+q.lat) > 90 || Math.abs(+q.lng) > 180) throw err("Hay coordenadas no válidas.");
    const id = idOk(b.id) ? b.id : "m" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex"), cfg = b.cfg && typeof b.cfg === "object" ? b.cfg : {};
    const pts = puntos.map(q => { const o = { lat: Math.round(+q.lat * 1e6) / 1e6, lng: Math.round(+q.lng * 1e6) / 1e6 }; if (q.id != null) o.id = String(q.id).slice(0, 80); if (q.x && typeof q.x === "object") { o.x = {}; for (const k of Object.keys(q.x).slice(0, 30)) { const v = q.x[k]; o.x[String(k).slice(0, 60)] = typeof v === "number" ? v : v == null ? null : String(v).slice(0, 120); } } return o; });
    const columnas = Array.isArray(b.columnas) ? b.columnas.slice(0, 30).map(c => ({ name: String(c.name || "").slice(0, 60), label: String(c.label || c.name || "").slice(0, 80), tipo: String(c.tipo || "").slice(0, 10) })) : [];
    const la = pts.map(q => q.lat), lo = pts.map(q => q.lng), lat = la.reduce((a, b) => a + b, 0) / la.length, lng = lo.reduce((a, b) => a + b, 0) / lo.length, bbox = [Math.min(...lo), Math.min(...la), Math.max(...lo), Math.max(...la)], ancho = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]); let zona = "";
    try { const ms = await D.nacMuns(), ents = D.ents(), dentro = ms.filter(m => lat >= m.bbox[0] && lat <= m.bbox[2] && lng >= m.bbox[1] && lng <= m.bbox[3]).sort((a, b) => (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) - (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]))[0];
      if (dentro) { const e = ents[+dentro.c.slice(0, 2)] || ""; zona = ancho > 1.5 ? "Varias entidades" : ancho > .35 ? e : dentro.nm + ", " + e; } } catch (_) { }
    let nuevo = null;
    await mutaIdx(ix => { const ya = ix.proyectos.find(x => x.id === id); const p = Object.assign({}, ya || {}, { id, nombre, objetivo: String(b.objetivo || "").slice(0, 4000), fuente: ["mapa", "archivo", "denue", "geolab", "inmuebles"].includes(b.fuente) ? b.fuente : "mapa", nPuntos: pts.length, columnas, cfg, mapa: b.mapa || (ya && ya.mapa) || null, creado: (ya && ya.creado) || ahora(), actualizado: ahora(), lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, bbox: bbox.map(v => Math.round(v * 1e5) / 1e5), zona, usuario: String(b.usuario || (ya && ya.usuario) || "").slice(0, 40) || null, estado: ya ? ya.estado : "nuevo" });
      if (!ya && ix.proyectos.filter(x => x.tipo !== "sim").length >= 200) throw err("Máximo 200 proyectos.");
      if (ya) ix.proyectos[ix.proyectos.indexOf(ya)] = p; else ix.proyectos.push(p); nuevo = p; });
    await D.writeGcs(OB(id, "puntos"), { puntos: pts, at: ahora() }, null); res.json({ ok: true, proyecto: nuevo });
  }));
  app.delete(R + "/proyectos/:id", wrap(async (req, res) => { const id = req.params.id; if (!idOk(id)) throw err("id"); let aids = []; await mutaIdx(ix => { const pr = ix.proyectos.find(x => x.id === id); aids = ((pr && pr.analisis) || []).map(a => a.id).filter(a => a !== "principal"); ix.proyectos = ix.proyectos.filter(x => x.id !== id && x.padre !== id); }); for (const n of ["puntos", "datos", "modelo", "resultados", "escenarios"]) { try { await D.writeGcs(OB(id, n), { borrado: ahora() }, null); } catch (_) { } } for (const a of aids) for (const n of ["modelo", "datos", "resultados", "escenarios"]) { try { await D.writeGcs(AK(id, a, n), { borrado: ahora() }, null); } catch (_) { } } res.json({ ok: true }); }));
  /* configuración del modelo (variables, enfoque, método, preprocesamiento) y resultados */
  app.post(R + "/proyectos/:id/modelo", wrap(async (req, res) => { const id = req.params.id; if (!idOk(id)) throw err("id"); const b = req.body || {}, m = b.modelo && typeof b.modelo === "object" ? b.modelo : null; if (!m) throw err("Falta el modelo.");
    const aid = aidDe(req); await D.writeGcs(AK(id, aid, "modelo"), Object.assign({}, m, { at: ahora() }), null);
    await mutaIdx(ix => { const p = ix.proyectos.find(x => x.id === id); if (!p) throw err("No existe el proyecto.", 404); const L = asegura(p), a = L.find(x => x.id === aid); if (!a) throw err("No existe el análisis.", 404); a.enfoque = m.enfoque || null; a.metodo = m.metodo || null; a.nVars = (m.x || []).length + (m.y ? 1 : 0); if (a.estado === "nuevo" && a.nVars) a.estado = "configurado"; a.actualizado = ahora(); sincro(p); }); res.json({ ok: true }); }));
  app.post(R + "/proyectos/:id/datos", wrap(async (req, res) => { const id = req.params.id; if (!idOk(id)) throw err("id"); const b = req.body || {}; if (!b.ds || !Array.isArray(b.ds.rows)) throw err("Faltan los datos."); await D.writeGcs(AK(id, aidDe(req), "datos"), { ds: b.ds, at: ahora() }, null); res.json({ ok: true }); }));
  app.get(R + "/proyectos/:id/datos", wrap(async (req, res) => { const id = req.params.id; if (!idOk(id)) throw err("id"); const { data } = await D.readGcs(AK(id, aidDe(req), "datos")); res.set("Cache-Control", "no-store"); res.json({ ok: true, ds: data && data.ds || null, at: data && data.at || null }); }));
  app.post(R + "/proyectos/:id/resultados", wrap(async (req, res) => { const id = req.params.id; if (!idOk(id)) throw err("id"); const b = req.body || {}; if (!b.res || typeof b.res !== "object") throw err("Faltan los resultados.");
    const aid = aidDe(req); await D.writeGcs(AK(id, aid, "resultados"), { res: b.res, at: ahora() }, null); await mutaIdx(ix => { const p = ix.proyectos.find(x => x.id === id); if (!p) return; const a = asegura(p).find(x => x.id === aid); if (!a) return; a.estado = "modelado"; a.kpi = Array.isArray(b.kpi) ? b.kpi.slice(0, 3) : a.kpi; if (b.metodo) a.metodo = String(b.metodo).slice(0, 80); a.actualizado = ahora(); sincro(p); }); res.json({ ok: true }); }));
  app.get(R + "/proyectos/:id/resultados", wrap(async (req, res) => { const id = req.params.id; if (!idOk(id)) throw err("id"); const { data } = await D.readGcs(AK(id, aidDe(req), "resultados")); res.set("Cache-Control", "no-store"); res.json({ ok: true, res: data && data.res || null, at: data && data.at || null }); }));

  /* ───────── tabla de variables por punto: cada coordenada se ubica en su AGEB y se leen los indicadores precalculados de la malla nacional ───────── */
  app.post(R + "/tabla", wrap(async (req, res) => {
    const b = req.body || {}, pts = Array.isArray(b.puntos) ? b.puntos : [], specs = (Array.isArray(b.specs) ? b.specs : []).filter(s => /^[a-z]+\d*$/.test(s)).slice(0, 120);
    if (!pts.length || pts.length > 20000) throw err("Entre 1 y 20 000 puntos."); if (!specs.length) throw err("Elige al menos un indicador.");
    const M = await D.malla(), tipos = (M.mmeta && M.mmeta.tipos) || [], rows = [], ag = []; let sin = 0;
    for (const q of pts) { const lat = +q[0], lng = +q[1], kx = 111320 * Math.cos(lat * Math.PI / 180), ci = Math.floor(lat / .05), cj = Math.floor(lng / .05); let best = null, bd = 3000 * 3000;
      for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) for (const k of (M.grid.get(i + "_" + j) || [])) { const v = M.A[k][1], dx = (v[1] - lng) * kx, dy = (v[0] - lat) * 111320, d2 = dx * dx + dy * dy; if (d2 < bd) { bd = d2; best = k; } }
      if (best == null) { sin++; rows.push(specs.map(() => null)); ag.push(null); continue; }
      const [clave, v, r, am, su, ig] = M.A[best]; ag.push(clave); rows.push(specs.map(s => { const x = D.mVal(r, s, M.ref, am, su, v, ig); return s === "tipo" ? (x == null ? null : tipos[x] || null) : (typeof x === "number" && isFinite(x) ? x : null); })); }
    res.json({ ok: true, specs, rows, ageb: ag, sinAgeb: sin });
  }));

  /* ───────── DENUE: ciudades y búsqueda de unidades económicas ───────── */
  app.get(R + "/ciudades", wrap(async (req, res) => {
    const q = norm(req.query.q).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim(); if (q.length < 2) return res.json({ ok: true, items: [] });
    const muns = await D.nacMuns(), MT = await D.metro(), ents = D.ents(), out = [];
    for (const [id, mt] of Object.entries(MT.met || {})) { const n = norm(mt.n); if (n.includes(q)) { const ms = Object.entries(MT.mun).filter(([, v]) => v === id).map(([c]) => c); out.push({ t: "Ciudad", n: mt.n, d: ms.length + " municipios", muns: ms, s: n.replace(/^(zona metropolitana|metropoli municipal|zona conurbada) (de |del |de la |de los |de las )?/, "").startsWith(q) ? 0 : 2 }); } }
    for (const m of muns) { const n = norm(m.nm); if (n.includes(q)) out.push({ t: "Municipio", n: m.nm, d: ents[+m.c.slice(0, 2)] || "", muns: [m.c], s: n.startsWith(q) ? 1 : 3 }); }
    out.sort((a, b) => a.s - b.s); res.json({ ok: true, items: out.slice(0, 12) });
  }));
  app.get(R + "/scian", wrap(async (req, res) => { res.set("Cache-Control", "public, max-age=86400"); res.json({ ok: true, s: SCIAN.s, ss: SCIAN.ss }); }));
  app.post(R + "/denue", wrap(async (req, res) => {
    const b = req.body || {}, muns = (Array.isArray(b.muns) ? b.muns : []).filter(c => /^\d{5}$/.test(c)).slice(0, 80); if (!muns.length) throw err("Elige primero una ciudad o municipio.");
    const grupos = String(b.q || "").split(",").map(g => norm(g).split(/\s+/).filter(Boolean)).filter(g => g.length), sc = (Array.isArray(b.scian) ? b.scian : []).map(String).filter(s => /^\d{2,6}$/.test(s)), tmin = Math.max(0, Math.min(6, +b.tmin || 0)), tmax = Math.max(0, Math.min(6, b.tmax == null ? 6 : +b.tmax)), lim = Math.max(1, Math.min(20000, +b.limite || 5000));
    const items = [], fac = {}; let total = 0, grup = null;
    for (const c of muns) { const d = await D.hx(`denue/mun/${c.slice(0, 2)}/${c}.json`); if (!d || !d.p) continue; grup = grup || (d.meta && d.meta.grupos);
      for (const p of d.p) { const sci = String(p[5] || ""); if (p[3] < tmin || p[3] > tmax) continue; if (sc.length && !sc.some(s => sci.startsWith(s))) continue; if (grupos.length) { const nm = norm(p[4]); if (!grupos.some(g => g.every(w => nm.includes(w)))) continue; }
        total++; const k = sci.slice(0, 2); fac[k] = (fac[k] || 0) + 1; if (items.length < lim) items.push({ lat: p[0], lng: p[1], nombre: p[4], scian: sci, tam: p[3], grupo: p[2], mun: c }); } }
    res.json({ ok: true, total, devueltos: items.length, truncado: total > items.length, sectores: fac, tamanos: ["0-5", "6-10", "11-30", "31-50", "51-100", "101-250", "251+"], grupos: (grup || []).map(g => g.n), items });
  }));

  /* ───────── Simulación: conjuntos de puntos nuevos evaluados con una versión del modelo, y escenarios con valores escritos a mano ─────────
     Cada conjunto es una entrada oculta del índice (tipo "sim", padre = proyecto) con su propio número y archivo de puntos, de modo que el
     precálculo de análisis gratuitos (datos ambientales, escena, red vial, población, origen/destino) funciona igual que en un proyecto. */
  const limpiaPts = arr => (Array.isArray(arr) ? arr : []).slice(0, 5000).map(q => { if (!isFinite(+q.lat) || !isFinite(+q.lng) || Math.abs(+q.lat) > 90 || Math.abs(+q.lng) > 180) throw err("Hay coordenadas no válidas."); const o = { lat: Math.round(+q.lat * 1e6) / 1e6, lng: Math.round(+q.lng * 1e6) / 1e6 }; if (q.id != null) o.id = String(q.id).slice(0, 80); if (q.x && typeof q.x === "object") { o.x = {}; for (const k of Object.keys(q.x).slice(0, 30)) { const v = q.x[k]; o.x[String(k).slice(0, 60)] = typeof v === "number" ? v : v == null ? null : String(v).slice(0, 120); } } return o; });
  const simPadre = async (id) => { if (!idOk(id)) throw err("id"); const c = await leeIdx(true), p = c.d.proyectos.find(x => x.id === id && x.tipo !== "sim"); if (!p) throw err("No existe el proyecto.", 404); return p; };
  const simResumen = p => ({ id: p.id, nombre: p.nombre, nota: p.nota || "", creado: p.creado, actualizado: p.actualizado, nPuntos: p.nPuntos || 0, fuente: p.fuente || "mapa", columnas: p.columnas || [], cfg: p.cfg || {}, sim: p.sim || {} });
  app.get(R + "/proyectos/:id/sim", wrap(async (req, res) => { const id = req.params.id; await simPadre(id); const aid = aidDe(req), c = await leeIdx(true); const { data } = await D.readGcs(AK(id, aid, "escenarios"));
    res.set("Cache-Control", "no-store"); res.json({ ok: true, conjuntos: c.d.proyectos.filter(x => x.tipo === "sim" && x.padre === id && (x.aid || "principal") === aid).map(simResumen).sort((a, b) => String(b.creado).localeCompare(String(a.creado))), escenarios: (data && data.items) || [] }); }));
  app.post(R + "/proyectos/:id/sim", wrap(async (req, res) => {
    const id = req.params.id; await simPadre(id); const b = req.body || {}, nombre = String(b.nombre || "").trim().slice(0, 80); if (!nombre) throw err("Falta el nombre del conjunto.");
    const pts = limpiaPts(b.puntos); if (!pts.length) throw err("El conjunto necesita al menos un punto."); const sid = idOk(b.id) ? b.id : "m" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex"); let out = null;
    const la = pts.map(q => q.lat), lo = pts.map(q => q.lng), lat = la.reduce((a, c) => a + c, 0) / la.length, lng = lo.reduce((a, c) => a + c, 0) / lo.length;
    await mutaIdx(ix => { const ya = ix.proyectos.find(x => x.id === sid); if (ya && (ya.tipo !== "sim" || ya.padre !== id)) throw err("Id no válido."); if (!ya && ix.proyectos.filter(x => x.tipo === "sim" && x.padre === id).length >= 100) throw err("Máximo 100 conjuntos por proyecto.");
      const p = Object.assign({}, ya || {}, { id: sid, tipo: "sim", padre: id, aid: aidDe(req), nombre, nota: String(b.nota || "").slice(0, 600), nPuntos: pts.length, fuente: ["mapa", "archivo", "denue", "coordenadas", "inmuebles"].includes(b.fuente) ? b.fuente : "mapa", columnas: Array.isArray(b.columnas) ? b.columnas.slice(0, 30).map(c => ({ name: String(c.name || "").slice(0, 60), label: String(c.label || c.name || "").slice(0, 80), tipo: String(c.tipo || "").slice(0, 10) })) : [], cfg: b.cfg && typeof b.cfg === "object" ? b.cfg : {}, sim: b.sim && typeof b.sim === "object" ? b.sim : (ya && ya.sim) || {}, lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, creado: (ya && ya.creado) || ahora(), actualizado: ahora(), usuario: String(b.usuario || (ya && ya.usuario) || "").slice(0, 40) || null });
      if (ya) ix.proyectos[ix.proyectos.indexOf(ya)] = p; else ix.proyectos.push(p); out = p; });
    await D.writeGcs(OB(sid, "puntos"), { puntos: pts, at: ahora() }, null); res.json({ ok: true, conjunto: simResumen(out) }); }));
  app.get(R + "/proyectos/:id/sim/:sid", wrap(async (req, res) => { const id = req.params.id, sid = req.params.sid; await simPadre(id); if (!idOk(sid)) throw err("id"); const c = await leeIdx(true), p = c.d.proyectos.find(x => x.id === sid && x.tipo === "sim" && x.padre === id); if (!p) throw err("No existe el conjunto.", 404);
    const [pu, rs] = await Promise.all([D.readGcs(OB(sid, "puntos")), D.readGcs(OB(sid, "simres"))]); res.set("Cache-Control", "no-store"); res.json({ ok: true, conjunto: simResumen(p), puntos: (pu.data && pu.data.puntos) || [], res: (rs.data && rs.data.res) || null }); }));
  app.post(R + "/proyectos/:id/sim/:sid/resultados", wrap(async (req, res) => { const id = req.params.id, sid = req.params.sid; await simPadre(id); if (!idOk(sid)) throw err("id"); const b = req.body || {}; if (!b.res || typeof b.res !== "object") throw err("Faltan los resultados.");
    await D.writeGcs(OB(sid, "simres"), { res: b.res, at: ahora() }, null); await mutaIdx(ix => { const p = ix.proyectos.find(x => x.id === sid && x.tipo === "sim" && x.padre === id); if (!p) throw err("No existe el conjunto.", 404); p.sim = Object.assign({}, p.sim || {}, b.sim && typeof b.sim === "object" ? b.sim : {}); p.actualizado = ahora(); }); res.json({ ok: true }); }));
  app.delete(R + "/proyectos/:id/sim/:sid", wrap(async (req, res) => { const id = req.params.id, sid = req.params.sid; await simPadre(id); if (!idOk(sid)) throw err("id"); await mutaIdx(ix => { ix.proyectos = ix.proyectos.filter(x => !(x.id === sid && x.tipo === "sim" && x.padre === id)); }); for (const n of ["puntos", "simres"]) { try { await D.writeGcs(OB(sid, n), { borrado: ahora() }, null); } catch (_) { } } res.json({ ok: true }); }));
  /* escenarios con valores escritos a mano */
  app.post(R + "/proyectos/:id/sim-escenarios", wrap(async (req, res) => { const id = req.params.id; await simPadre(id); const b = req.body || {}, e = b.escenario && typeof b.escenario === "object" ? b.escenario : null; if (!e) throw err("Falta el escenario.");
    const { data } = await D.readGcs(AK(id, aidDe(req), "escenarios")), items = (data && data.items) || []; if (items.length >= 300) throw err("Máximo 300 escenarios guardados."); const it = { id: "e" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex"), nombre: String(e.nombre || "Escenario").slice(0, 80), creado: ahora(), ver: String(e.ver || "").slice(0, 40), verNombre: String(e.verNombre || "").slice(0, 80), valores: e.valores && typeof e.valores === "object" ? e.valores : {}, resultado: e.resultado && typeof e.resultado === "object" ? e.resultado : {}, nota: String(e.nota || "").slice(0, 300) };
    items.unshift(it); await D.writeGcs(AK(id, aidDe(req), "escenarios"), { items, at: ahora() }, null); res.json({ ok: true, escenario: it }); }));
  app.delete(R + "/proyectos/:id/sim-escenarios/:eid", wrap(async (req, res) => { const id = req.params.id; await simPadre(id); const aid = aidDe(req), { data } = await D.readGcs(AK(id, aid, "escenarios")), items = ((data && data.items) || []).filter(x => x.id !== req.params.eid); await D.writeGcs(AK(id, aid, "escenarios"), { items, at: ahora() }, null); res.json({ ok: true }); }));

  /* ───────── enlaces de Google Maps → coordenadas (largos o cortos; solo se siguen redirecciones dentro de Google) ───────── */
  const coordDeUrl = href => { let t = String(href); for (let i = 0; i < 2; i++) { try { t = decodeURIComponent(t); } catch (_) { break; } }
    const ok = (la, lo) => isFinite(la) && isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0);
    let m = t.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/) || t.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/) || t.match(/[?&](?:q|ll|query|center|destination|daddr)=(-?\d+(?:\.\d+)?)[,+ ]\s*(-?\d+(?:\.\d+)?)/);
    if (m && ok(+m[1], +m[2])) { const n = t.match(/\/place\/([^/@?]+)/); return { lat: +(+m[1]).toFixed(6), lng: +(+m[2]).toFixed(6), nombre: n ? n[1].replace(/\+/g, " ").slice(0, 80) : "" }; } return null; };
  app.get(R + "/gmaps", wrap(async (req, res) => {
    let u = String(req.query.url || "").trim().slice(0, 2000); if (!u) throw err("Pega un enlace de Google Maps."); if (!/^https?:\/\//i.test(u)) u = "https://" + u; let cur; try { cur = new URL(u); } catch (_) { throw err("El enlace no es válido."); }
    const okHost = h => /(^|\.)google\.[a-z.]+$/i.test(h) || /^(maps\.app\.goo\.gl|goo\.gl|g\.co)$/i.test(h);
    for (let i = 0; i < 6; i++) { if (!okHost(cur.hostname)) throw err("Solo se aceptan enlaces de Google Maps."); const c = coordDeUrl(cur.href); if (c) return res.json(Object.assign({ ok: true }, c));
      const r = await fetch(cur.href, { redirect: "manual", headers: { "accept-language": "es-MX,es;q=0.9" } }), loc = r.headers.get("location");
      if (r.status >= 300 && r.status < 400 && loc) { cur = new URL(loc, cur); continue; }
      const t = (await r.text()).slice(0, 400000), m = t.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || t.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/); if (m) { const c2 = coordDeUrl("@" + m[1] + "," + m[2]); if (c2) return res.json(Object.assign({ ok: true }, c2)); } break; }
    throw err("No se encontraron coordenadas en ese enlace. Abre el lugar en Google Maps y copia el enlace desde «Compartir», o usa la coordenada manual.");
  }));

  /* ── análisis de un proyecto ── */
  app.get(R + "/proyectos/:id/analisis/:aid", wrap(async (req, res) => { const id = req.params.id, aid = req.params.aid; if (!idOk(id)) throw err("id"); const c = await leeIdx(true), p = c.d.proyectos.find(x => x.id === id && x.tipo !== "sim"); if (!p) throw err("No existe el proyecto.", 404); const a = listaAn(p).find(x => x.id === aid); if (!a) throw err("No existe el análisis.", 404);
    const mo = await D.readGcs(AK(id, aid, "modelo")); res.set("Cache-Control", "no-store"); res.json({ ok: true, analisis: a, modelo: mo.data || null }); }));
  app.post(R + "/proyectos/:id/analisis", wrap(async (req, res) => { const id = req.params.id; await simPadre(id); const nombre = String((req.body || {}).nombre || "").trim().slice(0, 80); if (!nombre) throw err("Falta el nombre del análisis."); let nuevo = null;
    await mutaIdx(ix => { const p = ix.proyectos.find(x => x.id === id && x.tipo !== "sim"); if (!p) throw err("No existe el proyecto.", 404); const L = asegura(p); if (L.length >= 30) throw err("Máximo 30 análisis por proyecto."); nuevo = { id: "a" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex"), nombre, creado: ahora(), actualizado: ahora(), estado: "nuevo", enfoque: null, metodo: null, kpi: null, nVars: 0 }; L.push(nuevo); p.actualizado = ahora(); }); res.json({ ok: true, analisis: nuevo }); }));
  app.post(R + "/proyectos/:id/analisis/:aid", wrap(async (req, res) => { const id = req.params.id, aid = req.params.aid; await simPadre(id); const nombre = String((req.body || {}).nombre || "").trim().slice(0, 80); if (!nombre) throw err("Falta el nombre del análisis.");
    await mutaIdx(ix => { const p = ix.proyectos.find(x => x.id === id && x.tipo !== "sim"); if (!p) throw err("No existe el proyecto.", 404); const a = asegura(p).find(x => x.id === aid); if (!a) throw err("No existe el análisis.", 404); a.nombre = nombre; a.actualizado = ahora(); }); res.json({ ok: true }); }));
  app.delete(R + "/proyectos/:id/analisis/:aid", wrap(async (req, res) => { const id = req.params.id, aid = req.params.aid; await simPadre(id); let sims = [];
    await mutaIdx(ix => { const p = ix.proyectos.find(x => x.id === id && x.tipo !== "sim"); if (!p) throw err("No existe el proyecto.", 404); const L = asegura(p); if (L.length <= 1) throw err("Un proyecto necesita al menos un análisis."); if (!L.some(x => x.id === aid)) throw err("No existe el análisis.", 404); p.analisis = L.filter(x => x.id !== aid); sincro(p); sims = ix.proyectos.filter(x => x.tipo === "sim" && x.padre === id && (x.aid || "principal") === aid).map(x => x.id); ix.proyectos = ix.proyectos.filter(x => !sims.includes(x.id)); });
    for (const n of ["modelo", "datos", "resultados", "escenarios"]) { try { await D.writeGcs(AK(id, aid, n), { borrado: ahora() }, null); } catch (_) { } } for (const sid of sims) for (const n of ["puntos", "simres"]) { try { await D.writeGcs(OB(sid, n), { borrado: ahora() }, null); } catch (_) { } } res.json({ ok: true }); }));
};
