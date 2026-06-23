const express   = require("express");
const multer    = require("multer");
const Anthropic = require("@anthropic-ai/sdk");
const XLSX      = require("xlsx");
const fs        = require("fs");
const path      = require("path");
const cors      = require("cors");

const classifyExpense          = require("./classifier");
const { sendRowsToAppsScript } = require("./sheetsClient");

const app       = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const UPLOAD_DIR = "/tmp/uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({ dest: UPLOAD_DIR });

app.use(cors({ origin: true }));
app.use(express.json({ limit: "32mb" }));

// ─── Apps Script URL (maneja Drive y Sheets) ───────────────────────────────

// URL fija — NO usar process.env.APPS_SCRIPT_URL porque Cloud Run tiene
// una variable de entorno antigua que sobreescribe el valor hardcodeado.
// Unificado: ahora toda la lógica (tickets + BANCOS read/save + presupuesto)
// vive en checkin_normalized.gs (Apps Script master).
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwqMfC6tITLXlhEwYzQ5mKzw-KD6-nV7XVKIuekj6pK4Po50oRfVKClZeHcr-si3ppB/exec";

async function callAppsScript(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000); // 25s timeout
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method:  "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body:    JSON.stringify(payload),
      signal:  controller.signal,
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { ok: false, raw: text }; }
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Timeout: Apps Script tardó más de 25s");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Health ────────────────────────────────────────────────────────────────

app.get("/", (req, res) => res.json({
  ok: true, service: "Ticket Vision v8 — Claude Vision", endpoints: ["/process", "/process-json", "/upload-images", "/health"]
}));
app.get("/health", (req, res) => res.json({ ok: true }));

// ─── Índice de tickets existentes (para detección de duplicados) ───────────

app.get("/tickets-index", async (req, res) => {
  try {
    const result = await callAppsScript({ action: "get_tickets_index" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Dashboard: todos los tickets de Sheets ────────────────────────────────

app.get("/get-tickets", async (req, res) => {
  try {
    const result = await callAppsScript({ action: "get_all_tickets" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Registros contables: datos de BANCOS y Presupuesto_sys ───────────────

app.get("/get-bancos", async (req, res) => {
  try {
    const result = await callAppsScript({ action: "get_bancos_data" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Información de huéspedes: proxy al Apps Script del check-in ─────────────
// El check-in tiene su PROPIO Apps Script (code_1.gs) con la lógica completa
// de listGuestRecords_, getGuestFilterOptions_ y getGuestRecordDetail_.
// Lo reutilizamos vía GET en lugar de duplicar la lógica.
const CHECKIN_APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwqMfC6tITLXlhEwYzQ5mKzw-KD6-nV7XVKIuekj6pK4Po50oRfVKClZeHcr-si3ppB/exec";

async function callCheckinAppsScript(action, paramsObj) {
  const url = new URL(CHECKIN_APPS_SCRIPT_URL);
  url.searchParams.set("action", action);
  if (paramsObj) {
    for (const [k, v] of Object.entries(paramsObj)) {
      if (v == null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const r = await fetch(url.toString(), { method: "GET", signal: controller.signal, redirect: "follow" });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { ok: false, raw: text.slice(0, 500) }; }
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Timeout: Apps Script tardó más de 25s");
    throw err;
  } finally { clearTimeout(timer); }
}

// Variante POST con body JSON para payloads grandes (base64 de imágenes,
// arrays de filas). GET trunca URLs largas → fotos llegan corruptas y
// nunca suben. doPost en Apps Script parsea e.postData.contents.
async function callCheckinAppsScriptPost(action, dataObj) {
  const body = JSON.stringify(Object.assign({ action }, dataObj || {}));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000); // 60s para uploads
  try {
    const r = await fetch(CHECKIN_APPS_SCRIPT_URL, {
      method: "POST",
      // text/plain evita el preflight CORS y Apps Script igualmente recibe
      // el body en e.postData.contents (patrón estándar para Apps Script).
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body,
      signal: controller.signal,
      redirect: "follow",
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { ok: false, raw: text.slice(0, 500) }; }
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Timeout: Apps Script tardó más de 60s");
    throw err;
  } finally { clearTimeout(timer); }
}

app.get("/huespedes-list", async (req, res) => {
  try {
    const params = {
      page: req.query.page || "1",
      page_size: req.query.page_size || "10000",
      nombre_reservacion: req.query.nombre_reservacion || "",
      medio_reservacion:  req.query.medio_reservacion  || "",
      celular_principal:  req.query.celular_principal  || "",
      requiere_factura:   req.query.requiere_factura   || "",
      razon_social:       req.query.razon_social       || "",
      forma_pago:         req.query.forma_pago         || "",
      correo:             req.query.correo             || "",
      fecha_entrada_desde: req.query.fecha_entrada_desde || "",
      fecha_entrada_hasta: req.query.fecha_entrada_hasta || "",
      fecha_salida_desde:  req.query.fecha_salida_desde  || "",
      fecha_salida_hasta:  req.query.fecha_salida_hasta  || "",
    };
    const result = await callCheckinAppsScript("list_records", params);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Proxy a la hoja "alojamientos" (catálogo de propiedades) — usado por el
// frontend para homologar nombres entre Reservas_Lodgify y Reservaciones.
app.get("/alojamientos-list", async (req, res) => {
  try {
    const result = await callCheckinAppsScript("list_alojamientos");
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/personal-list", async (req, res) => {
  try {
    const result = await callCheckinAppsScript("list_personal");
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Actualizar una incidencia existente ─────────────────────────────────────
app.post("/update-incidencia", async (req, res) => {
  try {
    const id = String(req.body?.id || '').trim();
    const fields = req.body?.fields || {};
    if (!id) return res.status(400).json({ ok: false, error: 'Falta id' });
    const result = await callCheckinAppsScriptPost("update_incidencia", {
      payload: { id, fields },
    });
    if (!result || !result.ok) throw new Error(result?.error || 'Apps Script update error');
    res.json(result);
  } catch (err) {
    console.error("update_incidencia_error", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Listar reportes de incidencias guardados ────────────────────────────────
app.get("/incidencias-list", async (req, res) => {
  try {
    const result = await callCheckinAppsScript("list_incidencias");
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Guardar reporte de incidencia ───────────────────────────────────────────
// Recibe { payload: {fecha, propiedad, depto, ...}, fotos: [{name, base64, mimeType}] }
// 1) Sube cada foto via Apps Script → DriveApp en /Drive/Incidencias/{año}/{mes}
// 2) Inserta una fila en la hoja "Incidencias" con las URLs públicas
app.post("/save-incidencia", async (req, res) => {
  try {
    const payload = req.body?.payload || {};
    const fotos = Array.isArray(req.body?.fotos) ? req.body.fotos : [];
    const fotosUrls = [];
    for (const f of fotos) {
      if (!f || !f.base64) continue;
      // POST con JSON — base64 puede pesar varios MB, GET truncaría.
      const up = await callCheckinAppsScriptPost("upload_incidencia_image", {
        fecha: payload.fecha || '',
        alojamiento: payload.alojamiento || '',
        file: { fileName: f.name || 'foto.jpg', mimeType: f.mimeType || 'image/jpeg', base64: f.base64 },
      });
      if (up && up.ok && up.url) fotosUrls.push(up.url);
      else console.warn("save_incidencia: foto fallida", JSON.stringify(up).slice(0, 300));
    }
    const saveResult = await callCheckinAppsScriptPost("save_incidencia", {
      payload: { ...payload, fotos_urls: fotosUrls },
    });
    if (!saveResult || !saveResult.ok) throw new Error(saveResult?.error || 'Apps Script save error');
    res.json({ ok: true, id: saveResult.id, timestamp: saveResult.timestamp, fotos_uploaded: fotosUrls.length });
  } catch (err) {
    console.error("save_incidencia_error", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/huespedes-filter-options", async (req, res) => {
  try {
    const result = await callCheckinAppsScript("list_filter_options");
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Proxy de imágenes: descarga la URL de Drive (o cualquier https) server-side
// y la stream-ea al cliente. Bypassa hot-link blocking, headers de referrer,
// cookies, etc. Soporta Drive en cualquiera de sus formatos comunes.
function huExtractDriveId(url) {
  if (!url) return "";
  const s = String(url).trim();
  const m1 = s.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  const m2 = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  const m3 = s.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m1) return m1[1];
  if (m2) return m2[1];
  if (m3) return m3[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
  return "";
}

app.get("/huespedes-image-proxy", async (req, res) => {
  try {
    const rawUrl = String(req.query.url || "").trim();
    if (!rawUrl) return res.status(400).send("Missing url");
    const size = String(req.query.size || "w800").replace(/[^a-z0-9]/gi, "");
    const driveId = huExtractDriveId(rawUrl);
    // Lista de URLs a intentar — la primera que devuelva binario gana.
    const candidates = driveId ? [
      `https://lh3.googleusercontent.com/d/${driveId}=${size}`,
      `https://drive.google.com/thumbnail?id=${driveId}&sz=${size}`,
      `https://drive.google.com/uc?export=view&id=${driveId}`,
      `https://drive.usercontent.google.com/download?id=${driveId}&export=view&authuser=0`,
    ] : (/^https?:\/\//i.test(rawUrl) ? [rawUrl] : []);
    if (!candidates.length) return res.status(400).send("Unsupported url");
    let lastErr = null;
    for (const u of candidates) {
      try {
        const r = await fetch(u, {
          redirect: "follow",
          headers: { "User-Agent": "Mozilla/5.0", "Accept": "image/*,*/*" },
        });
        const ct = r.headers.get("content-type") || "";
        if (!r.ok) { lastErr = `${r.status} on ${u}`; continue; }
        if (!ct.startsWith("image/")) { lastErr = `non-image ct=${ct} on ${u}`; continue; }
        const buf = Buffer.from(await r.arrayBuffer());
        res.setHeader("Content-Type", ct);
        res.setHeader("Cache-Control", "public, max-age=3600");
        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.send(buf);
      } catch (e) { lastErr = e.message; }
    }
    res.status(502).send("All sources failed: " + (lastErr || "unknown"));
  } catch (err) {
    res.status(500).send("proxy error: " + err.message);
  }
});

app.get("/huespedes-detail", async (req, res) => {
  try {
    const result = await callCheckinAppsScript("get_record_detail", { record_id: req.query.record_id || "" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Guarda el monto facturado total (campo "(+) $ Monto facturado Total" del card)
// en la columna "$ Monto facturado Total" de Reservaciones.
// ─── Reservas Lodgify (cache en Google Sheets vía Apps Script) ──────────────
app.get("/lodgify-list", async (req, res) => {
  try {
    const params = {
      source: req.query.source || "",
      status: req.query.status || "",
      name_contains: req.query.name_contains || "",
      limit: req.query.limit || "",
    };
    const result = await callCheckinAppsScript("lodgify_list", params);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/lodgify-sync", async (req, res) => {
  try {
    const full = req.body?.full ? "true" : "";
    const daysBack = req.body?.days_back || "";
    const daysFwd  = req.body?.days_fwd  || "";
    // Sync puede tardar minutos (rolling ~60s, full hasta 5 min). Timeout
    // generoso para no cortar a media operación.
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 5 * 60 * 1000);
    const r = await fetch(CHECKIN_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "lodgify_sync",
        full, days_back: daysBack, days_fwd: daysFwd,
      }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(tm));
    const text = await r.text();
    let json = {};
    try { json = JSON.parse(text); } catch { json = { ok: false, raw: text.slice(0, 400) }; }
    res.json(json);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Unifica dos filas de Reservaciones (winner = manual, loser = propagada de Lodgify)
app.post("/lg-unify-records", async (req, res) => {
  try {
    const winnerId = String(req.body?.winner_id || "").trim();
    const loserId  = String(req.body?.loser_id  || "").trim();
    if (!winnerId || !loserId) throw new Error("Faltan winner_id y/o loser_id");
    const r = await fetch(CHECKIN_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "unify_reservaciones",
        winner_id: winnerId,
        loser_id: loserId,
        fields: req.body?.fields || {},
        hidden_by: req.body?.hidden_by || "",
      }),
    });
    const text = await r.text();
    let json = {};
    try { json = JSON.parse(text); } catch { json = { ok: false, raw: text.slice(0, 400) }; }
    res.json(json);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Oculta una fila de Reservaciones del frontend (sin borrarla del sheet)
app.post("/lg-hide-reservacion", async (req, res) => {
  try {
    const id = String(req.body?.id || "").trim();
    if (!id) throw new Error("Falta id");
    const r = await fetch(CHECKIN_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "hide_reservacion", id, hidden_by: req.body?.hidden_by || "" }),
    });
    const text = await r.text();
    let json = {};
    try { json = JSON.parse(text); } catch { json = { ok: false, raw: text.slice(0, 400) }; }
    res.json(json);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Deshace una unificación: quita ID de Reservaciones_Hidden
app.post("/lg-unhide-reservacion", async (req, res) => {
  try {
    const id = String(req.body?.id || "").trim();
    if (!id) throw new Error("Falta id");
    const r = await fetch(CHECKIN_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "unhide_reservacion", id }),
    });
    const text = await r.text();
    let json = {};
    try { json = JSON.parse(text); } catch { json = { ok: false, raw: text.slice(0, 400) }; }
    res.json(json);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Oculta una reservación de Lodgify del frontend (no la borra del sheet maestro)
app.post("/lg-hide-booking", async (req, res) => {
  try {
    const id = String(req.body?.id || "").trim();
    if (!id) throw new Error("Falta id");
    const r = await fetch(CHECKIN_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "lg_hide_booking", id, hidden_by: req.body?.hidden_by || "" }),
    });
    const text = await r.text();
    let json = {};
    try { json = JSON.parse(text); } catch { json = { ok: false, raw: text.slice(0, 400) }; }
    res.json(json);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Elimina una reservación completa (fila en la hoja "Reservaciones") por su ID.
app.post("/huespedes-delete", async (req, res) => {
  try {
    const recordId = req.body?.record_id || "";
    if (!recordId) throw new Error("Falta record_id");
    const r = await fetch(CHECKIN_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "delete_reservacion", record_id: recordId }),
    });
    const text = await r.text();
    let json = {};
    try { json = JSON.parse(text); } catch { json = { ok: false, raw: text.slice(0, 400) }; }
    res.json(json);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/huespedes-save-monto", async (req, res) => {
  try {
    const recordId    = req.body?.record_id || "";
    const monto       = req.body?.monto_facturado_total ?? "";
    const comisionAir = req.body?.comision_airbnb ?? "";
    const totalAirbnb = req.body?.monto_total_airbnb ?? "";
    if (!recordId) throw new Error("Falta record_id");
    // El Apps Script del check-in expone esta acción vía doPost; usamos POST con
    // text/plain (igual que en la check-in app) para evitar preflight CORS.
    const r = await fetch(CHECKIN_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "update_facturado_total",
        record_id: recordId,
        monto_facturado_total: String(monto),
        // Solo se mandan cuando vienen llenos (caso Airbnb). El Apps Script
        // debe escribirlos en "$ Comisión Airbnb" y "$ MONTO TOTAL Airbnb".
        comision_airbnb:    String(comisionAir || ""),
        monto_total_airbnb: String(totalAirbnb || ""),
      }),
    });
    const text = await r.text();
    let json = {};
    try { json = JSON.parse(text); } catch { json = { ok: false, raw: text.slice(0, 400) }; }
    res.json(json);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Guardar clasificación de registro bancario en hoja BANCOS ───────────────

app.post("/save-banco-clasificacion", async (req, res) => {
  try {
    const { rowNum, clasificacion, ...rest } = req.body;
    if (!rowNum) throw new Error(`rowNum requerido (recibido: ${JSON.stringify(rowNum)})`);

    const result = await callAppsScript({
      action: "save_banco_clasificacion",
      rowNum,
      clasificacion,
      ...rest,
    });

    if (!result.ok) throw new Error(result.error || result.message || "Apps Script error");
    res.json({ ok: true, rowNum, columnsWritten: result.columnsWritten });
  } catch (err) {
    console.error("save_banco_clasificacion_error", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Chatbot financiero (proxy a Anthropic API) ─────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL   = process.env.ANTHROPIC_MODEL   || "claude-haiku-4-5";

app.post("/chat", async (req, res) => {
  try {
    const { message, history = [], context = {} } = req.body || {};
    if (!message) throw new Error("message requerido");
    if (!ANTHROPIC_API_KEY) {
      throw new Error("No hay ANTHROPIC_API_KEY configurada en Cloud Run. Configúrala como variable de entorno para activar el asistente.");
    }

    const systemPrompt =
`Eres un asistente financiero experto integrado al sistema 'Sistema Financiero' de Check Inn Saltillo.
Respondes con DATOS REALES tomados del CONTEXTO_JSON adjunto al final del mensaje del usuario.

NATURALEZA DEL CONTEXTO:
- El contexto NO contiene registros individuales, contiene AGREGADOS pre-calculados sobre el 100% de los movimientos.
- Cubre todo el universo de datos (no es una muestra). No existen 'registros faltantes' que no estén en los agregados.
- 'rango_fechas' indica el período cubierto (desde / hasta). Si el usuario pide un mes fuera de ese rango, responde claramente que no hay datos.

ESTRUCTURA DE 'agregados' (cada fila tiene I=Ingresos, E=Egresos, U=Utilidad, nI/nE=conteos):
- por_mes:               {Mes, I, E, U, nI, nE}                — totales globales por YYYY-MM
- por_cuenta_mes:        {Cuenta, Mes, I, E, U, nI, nE}
- por_subcuenta_mes:     {Cuenta, Sub, Mes, ...}
- por_categoria_mes:     {Cuenta, Sub, Cat, Mes, ...}
- por_concepto_mes:      {Cuenta, Sub, Cat, Con, Mes, ...}     — máxima granularidad
- por_cuenta_bancaria:   {CtaBancaria, Mes, ...}
- por_metodo_pago:       {MetodoPago, Mes, ...}
- por_encargado:         {Encargado, Mes, ...}
- por_propiedad:         {Propiedad, Mes, ...}

REGLAS DE RESPUESTA:
- Habla en español, conciso y claro. Markdown ligero permitido.
- Para sumar Ingresos/Egresos de un período: usa SIEMPRE los agregados. Filtra el array más específico que necesites por 'Mes' (YYYY-MM) y suma I o E. Nunca pidas registros individuales.
- Mes 'abril 2026' = '2026-04'. Trimestre 'Q1 2026' = ['2026-01','2026-02','2026-03'].
- Para 'utilidad' usa el campo U (= I − E) o súmalos manualmente desde I y E.
- Si la pregunta requiere cruzar dimensiones (p.ej. ingresos de una cuenta bancaria en un mes), usa el array que las contenga.
- Si una combinación pedida no aparece en los agregados, responde que esa partida no tuvo movimientos en ese período (no inventes).
- Para 'presupuesto' usa el array 'presupuesto'; para tickets, el array 'tickets'.
- Formato monetario: MXN (\$1,234.56). Nunca inventes cifras.
- Fecha de hoy: ${context.fecha_hoy || new Date().toISOString().slice(0,10)}.
- Rango disponible: ${context.rango_fechas ? context.rango_fechas.desde + ' a ' + context.rango_fechas.hasta : 'no determinado'}.`;

    // El contexto va como segundo bloque dentro del mismo turno del usuario,
    // para que el modelo lo tenga visible junto a la pregunta.
    const userContent = [
      { type: 'text', text: message },
      { type: 'text', text: 'CONTEXTO_JSON:\n```json\n' + JSON.stringify(context).slice(0, 180000) + '\n```' },
    ];

    const messages = [];
    for (const h of history.slice(0, -1)) {
      if (!h || !h.role || !h.content) continue;
      messages.push({ role: h.role, content: h.content });
    }
    messages.push({ role: 'user', content: userContent });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    let r;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type":      "application/json",
          "x-api-key":         ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model:      ANTHROPIC_MODEL,
          max_tokens: 1024,
          system:     systemPrompt,
          messages,
        }),
        signal: controller.signal,
      });
    } finally { clearTimeout(timer); }

    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || ("Anthropic " + r.status));
    const reply = (data.content || []).map(b => b.text || '').join('\n').trim() || '(sin respuesta)';
    res.json({ ok: true, reply, model: data.model, usage: data.usage });
  } catch (err) {
    console.error("chat_error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Guardar Presupuesto_sys: reescribe toda la hoja con las filas dadas ────

app.post("/save-presupuesto", async (req, res) => {
  try {
    const { columns, rows } = req.body;
    if (!Array.isArray(columns) || !Array.isArray(rows)) {
      throw new Error("Payload inválido: se esperan 'columns' y 'rows'");
    }
    const result = await callAppsScript({
      action: "save_presupuesto",
      columns,
      rows,
    });
    if (!result.ok) throw new Error(result.error || result.message || "Apps Script error");
    res.json({ ok: true, rowsWritten: result.rowsWritten });
  } catch (err) {
    console.error("save_presupuesto_error", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Test: verifica conexión con Apps Script y sube imagen de prueba ────────

app.get("/test-drive", async (req, res) => {
  try {
    // 1x1 pixel JPEG en base64
    const pixel = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=";
    const result = await callAppsScript({
      action: "upload_ticket_image",
      ticket_id: "test-001",
      fecha:  new Date().toISOString().slice(0, 10),
      tienda: "TEST_DRIVE",
      file: { fileName: "test_pixel.jpg", mimeType: "image/jpeg", base64: pixel },
    });
    res.json({ ok: true, apps_script_response: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Guardar tickets: imágenes a Drive + filas a Sheets (todo server-side) ──

app.post("/save-tickets", upload.array("files"), async (req, res) => {
  try {
    const metadata  = JSON.parse(req.body.metadata  || "[]");
    const productos = JSON.parse(req.body.productos  || "[]");
    const resumen   = JSON.parse(req.body.resumen    || "[]");
    const cruce     = JSON.parse(req.body.cruce      || "[]");

    // ── 1. Subir imágenes vía Apps Script → DriveApp ──
    const imageUrls = {};
    for (let i = 0; i < (req.files || []).length; i++) {
      const file     = req.files[i];
      const meta     = metadata[i] || {};
      const fecha    = meta.fecha  || new Date().toISOString().slice(0, 10);
      const tienda   = (meta.tienda || "sin_tienda").slice(0, 50);
      const ext      = path.extname(file.originalname || ".jpg").toLowerCase() || ".jpg";
      const fileName = `${fecha}_${tienda.replace(/\s+/g, "_").slice(0, 30)}${ext}`;
      const base64   = fs.readFileSync(file.path).toString("base64");

      const result = await callAppsScript({
        action:    "upload_ticket_image",
        ticket_id: meta.ticket_id || "",
        fecha,
        tienda,
        file: { fileName, mimeType: file.mimetype || "image/jpeg", base64 },
      });

      console.log("upload_result", meta.ticket_id, JSON.stringify(result).slice(0, 200));
      if (result.ok) imageUrls[meta.ticket_id] = { url: result.url, nombre: result.name };
    }

    // ── 2. Agregar URLs a las filas de resumen ──
    const resumenFinal = resumen.map(row => ({
      ...row,
      imagen_url:    (imageUrls[row.ticket_id] || {}).url    || "",
      imagen_nombre: (imageUrls[row.ticket_id] || {}).nombre || "",
    }));

    // ── 3. Guardar en Sheets ──
    const sheetsResult = await callAppsScript({
      action: "append_rows",
      productos,
      resumen: resumenFinal,
      cruce,
    });

    console.log("sheets_result", JSON.stringify(sheetsResult).slice(0, 200));
    if (!sheetsResult.ok) throw new Error("Apps Script Sheets error: " + (sheetsResult.error || JSON.stringify(sheetsResult)));

    res.json({
      ok:               true,
      tickets_saved:    resumen.length,
      images_uploaded:  Object.keys(imageUrls).length,
    });
  } catch (err) {
    console.error("save_tickets_error", err.message);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    cleanupFiles(req.files || []);
  }
});

// ─── Eliminar un ticket de Sheets ─────────────────────────────────────────

app.post("/delete-ticket", async (req, res) => {
  try {
    const { ticket_id } = req.body;
    if (!ticket_id) throw new Error("ticket_id requerido");
    const result = await callAppsScript({ action: "delete_ticket", ticket_id });
    if (!result.ok) throw new Error(result.error || "Apps Script error");
    res.json({ ok: true });
  } catch (err) {
    console.error("delete_ticket_error", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Actualizar clasificación de un ticket existente ──────────────────────

app.post("/update-ticket", async (req, res) => {
  try {
    const { ticket_id, clasificacion } = req.body;
    if (!ticket_id) throw new Error("ticket_id requerido");

    const result = await callAppsScript({
      action: "update_ticket_classification",
      ticket_id,
      clasificacion,
    });

    if (!result.ok) throw new Error(result.error || "Apps Script error");
    res.json({ ok: true });
  } catch (err) {
    console.error("update_ticket_error", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Prompt de extracción ──────────────────────────────────────────────────

const EXTRACTION_PROMPT = `Eres un extractor experto de tickets de compra mexicanos.
Analiza la imagen y responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional ni markdown.

Estructura exacta requerida:
{
  "store": "NOMBRE DE LA TIENDA",
  "rfc": null,
  "date": null,
  "time": null,
  "folio": null,
  "payment_method": null,
  "card_last4": null,
  "subtotal": 0,
  "iva": 0,
  "ieps": 0,
  "descuentos": 0,
  "total": 0,
  "productos": [
    { "descripcion": "NOMBRE DEL PRODUCTO", "cantidad": 1, "precio_unitario": 0, "monto": 0 }
  ]
}

Reglas:
- "productos": ÚNICAMENTE artículos o servicios comprados. Excluye nombre de tienda, dirección, RFC, teléfono, fecha, cajero, folio, impuestos, totales, formas de pago y cualquier mensaje.
- "date": formato YYYY-MM-DD o null.
- "time": formato HH:MM o null.
- "payment_method": VISA, MASTERCARD, AMEX, TARJETA_DEBITO, TARJETA_CREDITO, TARJETA_BANCO, EFECTIVO, TRANSFERENCIA, QR — o null.
- "card_last4": solo los 4 últimos dígitos de la tarjeta, o null.
- Todos los montos deben ser números (no strings). Si no se ve el valor, usa 0.
- Si un campo no está en el ticket, usa null.`;

// ─── Extracción con Claude Vision ──────────────────────────────────────────

function getMediaType(filename) {
  const ext = path.extname(filename || "").toLowerCase();
  return { ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" }[ext] || "image/jpeg";
}

async function extractWithClaude(imagePath, originalName) {
  const base64 = fs.readFileSync(imagePath).toString("base64");
  const ext    = path.extname(originalName || "").toLowerCase();
  const isPdf  = ext === ".pdf";

  const fileBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
    : { type: "image",    source: { type: "base64", media_type: getMediaType(originalName), data: base64 } };

  const msg = await anthropic.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    messages: [{
      role: "user",
      content: [ fileBlock, { type: "text", text: EXTRACTION_PROMPT } ]
    }]
  });

  const raw  = msg.content[0].text.trim();
  const json = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  return JSON.parse(json);
}

// ─── Endpoints ─────────────────────────────────────────────────────────────

app.post("/process", upload.array("files"), async (req, res) => {
  try {
    const context = buildContext(req.body);
    const result  = await processFiles(req.files || [], context);

    if (process.env.SAVE_TO_SHEETS === "true") await sendRowsToAppsScript(result.productRows);

    res.setHeader("Content-Disposition", "attachment; filename=tickets_transcripcion.xlsx");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buildExcel(result));
  } catch (err) {
    console.error("process_error", err.message);
    res.status(500).json({ ok: false, error: "Error procesando ticket", detail: err.message });
  } finally {
    cleanupFiles(req.files || []);
  }
});

app.post("/process-json", upload.array("files"), async (req, res) => {
  try {
    const context = buildContext(req.body);
    const result  = await processFiles(req.files || [], context);

    let sheetsResult = null;
    if (req.body.saveToSheets === "true" || process.env.SAVE_TO_SHEETS === "true") {
      sheetsResult = await sendRowsToAppsScript(result.productRows);
    }

    res.json({
      ok:              true,
      total_productos: result.productRows.length,
      productos:       result.productRows,
      resumen:         result.resumenRows,
      cruce_bancario:  result.cruceRows,
      saved_to_sheets: !!sheetsResult,
      sheets_result:   sheetsResult
    });
  } catch (err) {
    console.error("process_json_error", err.message);
    res.status(500).json({ ok: false, error: "Error procesando ticket", detail: err.message });
  } finally {
    cleanupFiles(req.files || []);
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildContext(body = {}) {
  return {
    cuenta:       body.cuenta       || "",
    subcuenta:    body.subcuenta    || "",
    categoria:    body.categoria    || "",
    concepto:     body.concepto     || "",
    propiedad:    body.propiedad    || "",
    departamento: body.departamento || "",
    comprador:    body.comprador    || "",
    comentarios:  body.comentarios  || "",
  };
}

async function processFiles(files, context) {
  if (!files.length) throw new Error("No se recibió ningún archivo.");

  const productRows = [];
  const resumenRows = [];
  const cruceRows   = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    if (!file.path || !fs.existsSync(file.path)) throw new Error("Archivo temporal no encontrado.");

    const parsed   = await extractWithClaude(file.path, file.originalname || "ticket.jpg");
    const now      = new Date().toISOString();
    const ticketId = `${Date.now()}-${i + 1}`;

    // ── Productos ──────────────────────────────────────────────────────────
    (parsed.productos || []).forEach((p, idx) => {
      const clasif = classifyExpense(p.descripcion || "", parsed.store || "");
      productRows.push({
        ticket_id:               ticketId,
        tienda:                  parsed.store  || "",
        fecha:                   parsed.date   || "",
        linea_numero:            idx + 1,
        descripcion:             p.descripcion      || "",
        cantidad:                p.cantidad         ?? "",
        precio_unitario:         p.precio_unitario  ?? "",
        monto:                   p.monto            ?? "",
        categoria_operativa:     clasif.categoria_operativa,
        categoria_contable:      clasif.categoria_contable,
        clave_sat:               clasif.clave_sat,
        deducible_sugerido:      clasif.deducible_sugerido,
        requiere_revision:       clasif.requiere_revision,
        confianza_clasificacion: clasif.confianza_clasificacion,
        cuenta:                  context.cuenta,
        subcuenta:               context.subcuenta,
        categoria_gasto:         context.categoria,
        concepto:                context.concepto,
        propiedad:               context.propiedad,
        departamento:            context.departamento,
        comprador:               context.comprador,
        comentarios:             context.comentarios
      });
    });

    // ── Resumen tickets ────────────────────────────────────────────────────
    resumenRows.push({
      ticket_id:        ticketId,
      archivo:          file.originalname      || "",
      tienda:           parsed.store           || "",
      rfc:              parsed.rfc             || "",
      fecha:            parsed.date            || "",
      hora:             parsed.time            || "",
      folio:            parsed.folio           || "",
      metodo_pago:      parsed.payment_method  || "",
      tarjeta_ultimos4: parsed.card_last4      || "",
      num_productos:    (parsed.productos      || []).length,
      subtotal:         parsed.subtotal        || 0,
      iva:              parsed.iva             || 0,
      ieps:             parsed.ieps            || 0,
      descuentos:       parsed.descuentos      || 0,
      total:            parsed.total           || 0,
      cuenta:           context.cuenta,
      subcuenta:        context.subcuenta,
      categoria_gasto:  context.categoria,
      concepto:         context.concepto,
      propiedad:        context.propiedad,
      departamento:     context.departamento,
      comprador:        context.comprador,
      comentarios:      context.comentarios,
      fecha_captura:    now
    });

    // ── Cruce bancario ─────────────────────────────────────────────────────
    cruceRows.push({
      fecha:            parsed.date           || "",
      hora:             parsed.time           || "",
      comercio:         parsed.store          || "",
      rfc:              parsed.rfc            || "",
      folio:            parsed.folio          || "",
      metodo_pago:      parsed.payment_method || "",
      tarjeta_ultimos4: parsed.card_last4     || "",
      monto_cruce:      parsed.total          || 0,
      total_ticket:     parsed.total          || 0,
      cuenta:           context.cuenta,
      subcuenta:        context.subcuenta,
      propiedad:        context.propiedad,
      departamento:     context.departamento
    });
  }

  return { productRows, resumenRows, cruceRows };
}

function buildExcel(result) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(result.productRows), "Transcripcion");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(result.resumenRows), "Resumen tickets");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(result.cruceRows),   "Cruce bancario");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function cleanupFiles(files) {
  for (const f of files) {
    try { if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch (_) {}
  }
}

// ─── Start ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Ticket Vision v7 — Claude Vision — port ${PORT}`));
