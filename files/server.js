const express   = require("express");
const compression = require("compression");
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
app.use(compression()); // gzip de respuestas — reduce 8.7MB → ~700KB en lodgify-list
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
  const TIMEOUT_MS = 120_000;
  // User-Agent Mozilla es CRÍTICO: Apps Script rechaza con 403 cualquier UA
  // no-navegador. redirect:'follow' maneja automáticamente el 302 a googleusercontent.
  async function _attempt() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url.toString(), {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
        headers: { "Accept": "application/json, text/plain, */*", "User-Agent": "Mozilla/5.0 (compatible; ticket-vision)" },
      });
      return await r.text();
    } finally { clearTimeout(timer); }
  }
  // Reintenta hasta 2 veces si la respuesta es HTML (Apps Script flaky)
  let text = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      text = await _attempt();
      try { return JSON.parse(text); } catch (_) {
        if (text.startsWith("<") && attempt === 0) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        return { ok: false, raw: text.slice(0, 500) };
      }
    } catch (err) {
      if (err.name === "AbortError") throw new Error(`Timeout: Apps Script tardó más de ${TIMEOUT_MS/1000}s`);
      if (attempt === 0) { await new Promise(r => setTimeout(r, 1000)); continue; }
      throw err;
    }
  }
  return { ok: false, raw: (text || "").slice(0, 500) };
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
// Cache en memoria del listado completo (5 min = 300 s). Reduce round-trips a
// Apps Script (que agrega 500-2000 ms) — con min-instances=1 el contenedor
// mantiene esta cache viva y las peticiones se resuelven en <100ms.
let _alojCache = { ts: 0, payload: null };
const ALOJ_CACHE_MS = 5 * 60 * 1000;

app.get("/alojamientos-list", async (req, res) => {
  try {
    const now = Date.now();
    if (!_alojCache.payload || (now - _alojCache.ts) > ALOJ_CACHE_MS) {
      _alojCache.payload = await callCheckinAppsScript("list_alojamientos");
      _alojCache.ts = now;
    }
    let payload = _alojCache.payload;
    const wantId = String(req.query.id || "").trim().toLowerCase();
    // Cache-Control agresivo por-id: la guía pública se puede cachear en el
    // navegador y en cualquier CDN intermedio (Cloudflare/proxies del ISP)
    // sin miedo — los datos de una guía cambian raro. Si el admin edita,
    // basta con esperar 10 min o refrescar hard (Ctrl+Shift+R).
    // stale-while-revalidate=86400: sirve stale por hasta 24h mientras
    // revalida en background → cellular con conexión intermitente ve la
    // guía al instante desde cache y refresca cuando puede.
    if (wantId) {
      res.set("Cache-Control", "public, max-age=600, s-maxage=600, stale-while-revalidate=86400");
      res.set("CDN-Cache-Control", "public, max-age=600");
      res.set("Vary", "Accept-Encoding");
    } else {
      // Lista completa: cache más corto (admin la usa; datos cambian más seguido)
      res.set("Cache-Control", "public, max-age=60, s-maxage=60, stale-while-revalidate=300");
    }
    if (wantId && payload && payload.ok && Array.isArray(payload.rows)) {
      const filtered = payload.rows.filter(r =>
        String(r.HouseId || r.HouseID || r.ID || "").trim().toLowerCase() === wantId
      );
      return res.json({ ...payload, rows: filtered, total: filtered.length, cached: true });
    }
    res.json(payload);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ║ WhatsApp Business (vía Twilio)                                          ║
// ║ Env vars requeridas en Cloud Run:                                        ║
// ║   TWILIO_ACCOUNT_SID   (ACxxxx…)                                        ║
// ║   TWILIO_AUTH_TOKEN    (secret)                                          ║
// ║   TWILIO_WA_FROM       (formato "whatsapp:+14155238886" sandbox         ║
// ║                          o "whatsapp:+17542903346" producción)          ║
// ║ Modelo: mensaje libre (dentro de ventana 24h del huésped) o template   ║
// ║ pre-aprobado por Meta (fuera de ventana). Twilio expone template       ║
// ║ mediante ContentSid del Content Template Builder.                       ║
// ═══════════════════════════════════════════════════════════════════════════

/** Normaliza destino a formato "whatsapp:+52…". Acepta "8115569120",
 *  "5218115569120", "+528115569120", "+52 811 556 9120", etc. */
function _waFormatToSingle(to) {
  let s = String(to || "").trim().replace(/[^\d+]/g, "");
  if (!s) return "";
  if (s.startsWith("whatsapp:")) return s;
  if (!s.startsWith("+")) {
    if (s.length === 10) s = "+521" + s;
    else if (s.length === 12 && s.startsWith("52")) s = "+521" + s.slice(2);
    else if (s.length === 13 && s.startsWith("521")) s = "+" + s;
    else s = "+" + s;
  } else {
    if (/^\+52\d{10}$/.test(s)) s = "+521" + s.slice(3);
  }
  return "whatsapp:" + s;
}
/** Devuelve un array de recipients normalizados (acepta CSV o array). */
function _waFormatToList(to) {
  if (!to) return [];
  const arr = Array.isArray(to) ? to : String(to).split(/[,;]+/);
  return arr.map(_waFormatToSingle).filter(Boolean);
}
/** Compat: devuelve solo el primero (para endpoints que aún esperan string). */
function _waFormatTo(to) {
  const arr = _waFormatToList(to);
  return arr[0] || "";
}

async function _twilioSendMessage(params) {
  const sid    = process.env.TWILIO_ACCOUNT_SID;
  const keySid = process.env.TWILIO_API_KEY_SID;
  const keySec = process.env.TWILIO_API_KEY_SECRET;
  const token  = process.env.TWILIO_AUTH_TOKEN; // fallback si aún no hay API Key
  const from   = process.env.TWILIO_WA_FROM;
  const user = keySid || sid;
  const pass = keySec || token;
  if (!sid || !user || !pass || !from) {
    throw new Error("Twilio env vars faltantes (necesito TWILIO_ACCOUNT_SID + TWILIO_API_KEY_SID/SECRET o TWILIO_AUTH_TOKEN + TWILIO_WA_FROM)");
  }
  const body = new URLSearchParams();
  body.set("From", from);
  body.set("To",   params.to);
  if (params.body)          body.set("Body", params.body);
  if (params.contentSid)    body.set("ContentSid", params.contentSid);
  if (params.contentVars)   body.set("ContentVariables", JSON.stringify(params.contentVars));
  const auth = Buffer.from(user + ":" + pass).toString("base64");
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { "Authorization": "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Twilio ${r.status}: ${j.message || JSON.stringify(j).slice(0,200)}`);
  // MIRROR a WA_ChatContext (fire-and-forget) — así los envíos outbound
  // (templates, cron, /wa/send manual) también aparecen en el hilo del
  // panel bot-chats. Skip si el destino no tiene formato válido o si el
  // caller pasó skipMirror:true (bot/admin ya loguean por su cuenta y
  // duplicarían el mensaje).
  try {
    const phone10 = String(params.to || "").replace(/\D/g,"").slice(-10);
    if (!params.skipMirror && phone10.length === 10) {
      const bodyForLog = String(params.body || (params.contentSid ? `(template ${params.contentSid})` : ""));
      if (bodyForLog) {
        fetch(CHECKIN_APPS_SCRIPT_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({
            action: "wa_chat_context_append",
            phone: phone10,
            role: params.tipo ? "template" : "admin",
            body: bodyForLog,
            meta: { sid: j.sid, tipo: params.tipo || "", contentSid: params.contentSid || "" }
          })
        }).catch(()=>{});
      }
    }
  } catch(_) {}
  return j;
}

// POST /wa/send — envía WhatsApp (freeform si "body", o template si "contentSid").
// Body: { to, body?, contentSid?, contentVars?, bookingId? (para log), tipo? }
// ═══════════════════════════════════════════════════════════════════════════
// ║ BOT IA WHATSAPP — Webhook inbound + Claude Haiku + tools               ║
// ║                                                                          ║
// ║ Flujo: Twilio webhook → /wa/webhook-inbound → identifica reserva →     ║
// ║   arma contexto alojamiento → llama Claude → responde vía Twilio →      ║
// ║   loguea en WA_ChatContext (Apps Script).                                ║
// ║                                                                          ║
// ║ Piloto restringido: solo responde a huéspedes cuya reserva tiene un     ║
// ║ HouseId con bot_enabled=TRUE en la hoja alojamientos.                    ║
// ═══════════════════════════════════════════════════════════════════════════
const BOT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const BOT_ANTHROPIC_MAX_TOKENS = 500;

// Cache in-memory (5 min TTL) para reducir round-trips a Apps Script.
// Estos datos cambian raramente durante la vida de una conversación.
const _botAlojEnabledCache = { ts: 0, map: null }; // HouseId → bool
const _botAlojRowsCache    = { ts: 0, rows: null };
const _BOT_CACHE_TTL       = 5 * 60_000;
async function _botGetEnabledMap() {
  if (_botAlojEnabledCache.map && (Date.now() - _botAlojEnabledCache.ts) < _BOT_CACHE_TTL) {
    return _botAlojEnabledCache.map;
  }
  try {
    const r = await fetch(`${CHECKIN_APPS_SCRIPT_URL}?action=wa_bot_alojamientos`);
    const j = await r.json();
    const map = {};
    for (const a of ((j && j.alojamientos) || [])) map[String(a.HouseId)] = !!a.bot_enabled;
    _botAlojEnabledCache.map = map; _botAlojEnabledCache.ts = Date.now();
    return map;
  } catch (_) { return _botAlojEnabledCache.map || {}; }
}
async function _botGetAlojRows() {
  if (_botAlojRowsCache.rows && (Date.now() - _botAlojRowsCache.ts) < _BOT_CACHE_TTL) {
    return _botAlojRowsCache.rows;
  }
  try {
    const r = await fetch(`https://api.check-inn.mx/alojamientos-list`);
    const j = await r.json();
    const rows = (j && j.rows) || [];
    _botAlojRowsCache.rows = rows; _botAlojRowsCache.ts = Date.now();
    return rows;
  } catch (_) { return _botAlojRowsCache.rows || []; }
}

/** Llama Claude Messages API. Devuelve { text, stop_reason, usage, tool_use }. */
async function _llmChat({ system, history, userMsg, tools }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY faltante");
  // history = [{role:'user|assistant', content:'...'}, ...] (últimos N msgs)
  const messages = (history || []).map(m => ({ role: m.role, content: String(m.body || m.content || "") }));
  messages.push({ role: "user", content: String(userMsg || "") });
  const body = {
    model: BOT_ANTHROPIC_MODEL,
    max_tokens: BOT_ANTHROPIC_MAX_TOKENS,
    system: String(system || ""),
    messages,
  };
  if (Array.isArray(tools) && tools.length) body.tools = tools;
  // Timeout 30s para no colgar el webhook si Anthropic no responde.
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), 30_000);
  let r, j;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    j = await r.json();
  } finally { clearTimeout(tm); }
  if (!r.ok) throw new Error(`Claude HTTP ${r.status}: ${j.error?.message || JSON.stringify(j).slice(0,200)}`);
  // Response shape: { content: [{type:'text',text:'...'} | {type:'tool_use',...}] }
  const parts = j.content || [];
  const textPart = parts.find(p => p.type === "text");
  const toolPart = parts.find(p => p.type === "tool_use");
  return {
    text: textPart ? String(textPart.text || "") : "",
    tool_use: toolPart || null,
    stop_reason: j.stop_reason || "",
    usage: j.usage || {},
  };
}

/** Detecta intents "sensibles" que exigen escalado a humano inmediato. */
function _botDetectSensitive(msgLower) {
  const patterns = [
    /\b(queja|reclam|molest|inconform|indignad|denuncia)\b/i,
    /\b(reembolso|devoluci[oó]n|refund)\b/i,
    /\b(demanda|abogad|legal|juzgad|profeco)\b/i,
    /\b(cobrar|cobraron|cargo|charge).*\b(mal|extra|incorrect|de m[aá]s)\b/i,
    /\b(hablar|comunicar).*(persona|human|gerente|due[ñn]o|jef)/i,
    /\b(emergencia|urgente|urgencia|robo|acciden|incendio|inund)/i,
  ];
  for (const re of patterns) if (re.test(msgLower)) return re.source;
  return null;
}

/** Arma el bloque de contexto del alojamiento a partir de una row de la hoja alojamientos. */
function _botBuildAlojamientoContext(alojRow, booking, allBookings) {
  if (!alojRow) return "(sin info de alojamiento resoluble)";
  const lines = [];
  const push = (label, value) => {
    const v = String(value || "").trim();
    if (v && v !== "—") lines.push(`- ${label}: ${v}`);
  };
  const prop = String(alojRow.Propiedad || "").trim();
  const dep = String(alojRow["# Departamento"] || "").trim();
  push("Alojamiento", `${prop}${dep ? ` #${dep}` : ""}`);
  push("Dirección", alojRow.direccion);
  push("Referencia", alojRow.referencia);
  push("Google Maps", alojRow.url_google_maps);
  push("Método de llegada / acceso", alojRow.metodo_llegada);
  push("Detalles de ubicación", alojRow.ubicacion_txt);
  push("Clave de acceso / puerta", alojRow.clave_acceso);
  push("WiFi (red)", alojRow.wifi_red || alojRow.wifi_name_1);
  push("WiFi (contraseña)", alojRow.wifi_contrasena);
  push("Instrucciones WiFi", alojRow.wifi_txt);
  push("Hora entrada (default)", alojRow.hora_llegada);
  push("Hora salida (default)", alojRow.hora_salida);
  push("Estacionamiento", `${alojRow.estacionamiento_tipo || ""} ${alojRow.estacionamiento_instrucciones || ""}`.trim());
  push("Lavandería", alojRow.lavanderia_ubicacion);
  push("Reglas lavandería", alojRow.lavanderia_reglamento);
  push("Insumos ubicación", alojRow.insumos_ubicacion);
  push("Insumos disponibles", alojRow.insumos);
  push("Reglamento", alojRow.reglamento);
  push("Instrucciones de salida", alojRow.salida_instrucciones);
  push("Contacto emergencia 1", `${alojRow.contacto_emergencia_1_nombre || ""} ${alojRow.contacto_emergencia_1_numero || ""}`.trim());
  push("Contacto emergencia 2", `${alojRow.contacto_emergencia_2_nombre || ""} ${alojRow.contacto_emergencia_2_numero || ""}`.trim());
  push("Guía completa", alojRow.url_guia);
  if (booking) {
    lines.push("\n--- Reserva ACTUAL (por prioridad Activa > Próxima > Reciente) ---");
    push("Nombre del huésped", booking.GuestName);
    push("Alojamiento reserva", `${booking.PropertyName || ""} ${booking.RoomTypeName ? "· " + booking.RoomTypeName : ""}`.trim());
    push("Llegada", (booking.DateArrival || "").slice(0,10));
    push("Salida", (booking.DateDeparture || "").slice(0,10));
    push("# Huéspedes", booking.NumberOfGuests);
    push("Fuente", booking.Source);
  }
  // Historial COMPLETO de reservas del huésped (mismo phone) — permite al
  // bot contestar preguntas del tipo "cuál es mi próxima reserva", "cuántas
  // veces me he hospedado", "mi reserva pasada fue en dónde".
  if (Array.isArray(allBookings) && allBookings.length) {
    const toIso = (v) => {
      if (!v) return "";
      const s = String(v);
      let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
      m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (m) return `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
      const d = new Date(s); return isNaN(d) ? "" : d.toISOString().slice(0,10);
    };
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Mexico_City' });
    const classify = (b) => {
      const a = toIso(b.DateArrival), d = toIso(b.DateDeparture);
      if (a && d && a <= today && today <= d) return "ACTIVA";
      if (a && a > today) return "PRÓXIMA";
      return "PASADA";
    };
    // Ordenar por arrival ascendente
    const sorted = allBookings.slice().sort((a,b) => toIso(a.DateArrival).localeCompare(toIso(b.DateArrival)));
    lines.push(`\n--- Historial de reservas del huésped (total ${sorted.length}) ---`);
    for (const b of sorted) {
      const arr = toIso(b.DateArrival), dep = toIso(b.DateDeparture);
      const prop = b.RoomTypeName || b.PropertyName || "?";
      const extras = [];
      if (b.MontoTotal) extras.push(`Monto: ${b.MontoTotal}`);
      if (b.FolioFacturapi || b.TicketUrl) {
        const parts = [];
        if (b.FolioFacturapi) parts.push(`Ticket facturapi #${b.FolioFacturapi}`);
        if (b.TicketUrl)      parts.push(`Link ticket: ${b.TicketUrl}`);
        if (b.TicketFolderUrl) parts.push(`Carpeta ticket: ${b.TicketFolderUrl}`);
        extras.push(parts.join(' · '));
      } else if (/s[ií]/i.test(String(b.RequiereFactura))) {
        extras.push(`Factura solicitada (aún sin emitir)`);
      }
      const extrasStr = extras.length ? ` · ${extras.join(' · ')}` : '';
      lines.push(`- [${classify(b)}] ${prop} · ${arr || "?"} → ${dep || "?"}${b.NumberOfGuests ? ` · ${b.NumberOfGuests} huésp` : ""}${extrasStr}`);
    }
  }
  return lines.join("\n");
}

const BOT_SYSTEM_PROMPT_BASE = `Eres un asistente de atención a huéspedes de Check-inn Saltillo, una empresa de hospedaje en Saltillo, Coahuila, México. Respondes por WhatsApp.

REGLAS DE RESPUESTA:
- Escribe corto, natural, amable. Máximo 3-4 oraciones.
- Usa el mismo tono con el que te escriben (casual si casual, formal si formal).
- Si el huésped pide algo que requiere acción (limpieza extra, mantenimiento, cambio de horario), usa la herramienta correspondiente en vez de solo responder texto.
- Si el mensaje suena a queja, reclamo, emergencia, mención de dinero/cobros, o pide hablar con humano, NO respondas — el sistema escalará automáticamente.
- No des precios, no negocies, no prometas descuentos.
- Usa emojis con moderación (uno cada 2-3 respuestas, no en cada frase).
- Firma solo si presentas info nueva: "Check-inn Saltillo 🏠"

REGLA CRÍTICA — CERO ALUCINACIONES (LA MÁS IMPORTANTE):
- SOLO puedes afirmar hechos que estén LITERALMENTE escritos en el CONTEXTO DEL ALOJAMIENTO más abajo.
- Está PROHIBIDO inventar, inferir, suponer o dar por sentado servicios, amenities, políticas, horarios, ubicaciones o características que no aparezcan explícitamente en el contexto. Ejemplos de lo que NO debes hacer:
  * Mencionar "estacionamiento incluido", "cochera", "parking" si esas palabras no están en el contexto.
  * Suponer que hay wifi, alberca, aire acondicionado, cocina equipada, elevador, mascotas permitidas, etc., sin verlo escrito.
  * Confirmar reglas o restricciones (fumar, fiestas, ruido, huéspedes extra) que no estén en el contexto.
  * Dar direcciones, referencias, indicaciones cerca del alojamiento si no vienen en el contexto.
- NO uses frases ambiguas que sugieran conocimiento como "sí, tenemos", "sí está incluido", "claro que sí" cuando NO tienes el dato.
- Si no tienes la información en el contexto, responde EXACTAMENTE con este patrón (o parecido):
  "No tengo esa información a la mano. En un momento el equipo te confirma. 🙏"
  Y NADA MÁS. No agregues suposiciones ni preguntas guiadas ("¿lo tienes incluido?" es también inventar contexto).
- Ante duda entre responder o escalar, SIEMPRE escala.

CONTEXTO DEL ALOJAMIENTO DEL HUÉSPED:
`;

/** Trae contexto de conversación previa desde Apps Script. */
async function _botFetchConversation(phone10, limit = 15) {
  const url = `${CHECKIN_APPS_SCRIPT_URL}?action=wa_chat_context_get&phone=${encodeURIComponent(phone10)}&limit=${limit}`;
  const r = await fetch(url);
  const j = await r.json();
  return j && j.ok ? j : { messages: [], state: { control: "bot" } };
}

/** Persiste un mensaje al historial via Apps Script. */
async function _botAppendMessage(phone10, role, body, meta) {
  await fetch(CHECKIN_APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      action: "wa_chat_context_append",
      phone: phone10, role, body, meta: meta || {},
    }),
  }).catch(e => console.warn("[bot] append msg falló:", e.message));
}

/** Marca la conversación como escalada (human control). */
async function _botEscalate(phone10, reason) {
  await fetch(CHECKIN_APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      action: "wa_chat_set_control",
      phone: phone10, control: "human", reason,
    }),
  }).catch(e => console.warn("[bot] escalate falló:", e.message));
}

/** Encuentra la reserva ACTIVA del huésped (hoy entre arrival y departure).
 *  Fallback a la más próxima si no hay activa. Devuelve { booking, alojRow } o null. */
async function _botFindActiveBooking(phone10) {
  try {
    // Paralelizar: bookings + alojamientos (cached) desde el arranque.
    const [bkJ, rows] = await Promise.all([
      fetch(`${CHECKIN_APPS_SCRIPT_URL}?action=bookings_by_guest&phone=${encodeURIComponent(phone10)}`).then(r => r.json()).catch(()=>null),
      _botGetAlojRows(),
    ]);
    const lgBookings = (bkJ && bkJ.ok && Array.isArray(bkJ.bookings)) ? bkJ.bookings : [];
    const huRows = (bkJ && bkJ.ok && Array.isArray(bkJ.huRows)) ? bkJ.huRows : [];
    // ISO YYYY-MM-DD normalizer (acepta ISO, Date serializada, MM/DD/YYYY).
    const toIso = (v) => {
      if (!v) return "";
      const s = String(v);
      let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
      m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (m) return `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
      const d = new Date(s);
      return isNaN(d) ? "" : d.toISOString().slice(0,10);
    };
    // Convertir huRow → shape booking-like. Solo campos que consume
    // _botBuildAlojamientoContext + el pick. Skip si ya está cubierto por
    // Lodgify (LodgifyId o fechas+propiedad).
    const bookings = lgBookings.slice();
    const seen = new Set(bookings.map(b => String(b.Id || b.LodgifyId || "") || `F:${toIso(b.DateArrival)}|${toIso(b.DateDeparture)}|${String(b.RoomTypeName||b.PropertyName||"").toLowerCase()}`));
    for (const r of huRows) {
      const lodId = String(r["Lodgify Id"] || "").trim();
      const arrIso = toIso(r["Fecha de ingreso"]);
      const depIso = toIso(r["Fecha de salida"]);
      const prop = String(r["Propiedad"] || "").trim();
      const dep  = String(r["# Departamento"] || r["Departamento"] || "").trim();
      const propFull = dep ? `${prop} - #${dep}` : prop;
      const k = lodId || `F:${arrIso}|${depIso}|${propFull.toLowerCase()}`;
      if (seen.has(k) || seen.has(lodId)) continue;
      seen.add(k);
      // HouseId no vive en Reservaciones — se resuelve contra alojamientos
      // (Propiedad + Departamento) más abajo, antes de usar el booking.
      bookings.push({
        Id: String(r["ID"] || r["Id"] || r["row_number"] || `hu-${phone10}-${arrIso}`),
        LodgifyId: lodId,
        DateArrival: arrIso,
        DateDeparture: depIso,
        GuestName: String(r["Nombre"] || ""),
        GuestPhone: phone10,
        PropertyName: prop,
        RoomTypeName: propFull,
        HouseId: "", // se resuelve abajo
        NumberOfGuests: Number(r["# Huéspedes"] || r["Huéspedes"] || 0),
        Source: String(r["Medio de reservación"] || r["Medio"] || "Manual"),
        // Facturación / ticket auto-facturación (viene en huRow si emitido).
        FolioFacturapi: String(r["Folio facturapi"] || r["Folio Facturapi"] || r["Folio"] || "").trim(),
        // El campo canónico en Reservaciones es 'Ticket facturapi url' (con
        // minúscula final). Aceptamos alias por robustez.
        TicketUrl: String(
          r["Ticket facturapi url"] || r["Ticket_facturapi_url"] ||
          r["Ticket URL"] || r["ticket_url"] || r["Facturapi URL"] || ""
        ).trim(),
        TicketFolderUrl: String(r["Ticket facturapi carpeta url"] || r["Ticket_facturapi_carpeta_url"] || "").trim(),
        RequiereFactura: String(r["¿Requiere factura?"] || "").trim(),
        MontoTotal: String(r["Monto"] || r["Total"] || "").trim(),
        __fromHuRow: true,
        __prop: prop,
        __depto: dep,
      });
    }
    if (!bookings.length) return null;
    // Hoy en zona local (America/Mexico_City ≈ UTC-6): usar toLocaleDateString
    // con locale sv-SE (formato ISO) para YYYY-MM-DD.
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Mexico_City' });
    const active = bookings.find(b => {
      const arr = toIso(b.DateArrival);
      const dep = toIso(b.DateDeparture);
      return arr && dep && arr <= today && today <= dep;
    });
    const proxima = bookings
      .filter(b => toIso(b.DateArrival) >= today)
      .sort((a,b) => toIso(a.DateArrival).localeCompare(toIso(b.DateArrival)))[0];
    const reciente = bookings.slice()
      .sort((a,b) => toIso(b.DateDeparture).localeCompare(toIso(a.DateDeparture)))[0];
    const booking = active || proxima || reciente || bookings[bookings.length - 1];
    if (!booking) return null;
    console.info(`[bot-in] ${phone10}: pick=${active ? 'ACTIVA' : proxima ? 'PROXIMA' : 'RECIENTE'} ${booking.RoomTypeName || booking.PropertyName || ''} ${toIso(booking.DateArrival)}→${toIso(booking.DateDeparture)}`);
    // HouseId puede venir vacío en huRow — buscar por Propiedad+Departamento
    // contra alojamientos. El endpoint waBotAlojamientosList_ ya devuelve
    // {HouseId, Propiedad, Departamento, bot_enabled} normalizado.
    let alojRow = rows.find(r => String(r.HouseId || "").trim() === String(booking.HouseId || "").trim() && booking.HouseId);
    if (!alojRow && booking.__fromHuRow) {
      const bp = String(booking.__prop || booking.PropertyName || "").toLowerCase().trim();
      const bd = String(booking.__depto || "").trim();
      alojRow = rows.find(r => {
        const p = String(r.Propiedad || r.propiedad || "").toLowerCase().trim();
        // /alojamientos-list devuelve la columna con nombre canónico
        // "# Departamento" (waBotAlojamientosList_ la renombra a "Departamento";
        // aquí usamos el endpoint directo con nombres crudos).
        const d = String(r["# Departamento"] || r.Departamento || r.departamento || "").trim();
        return p === bp && d === bd;
      });
      if (alojRow) {
        booking.HouseId = String(alojRow.HouseId || "").trim();
        console.info(`[bot-in] ${phone10}: HouseId resuelto por Propiedad+Departamento → ${booking.HouseId}`);
      } else {
        // Log sample de alojamientos para diagnosticar el mismatch.
        const sample = rows.slice(0, 5).map(r => `"${String(r.Propiedad||"").toLowerCase().trim()}"#${String(r.Departamento||"").trim()}`).join(", ");
        console.warn(`[bot-in] ${phone10}: NO match alojamiento para "${bp}" #${bd}. Sample rows (${rows.length}): ${sample}`);
      }
    }
    return { booking, alojRow: alojRow || null, allBookings: bookings };
  } catch (e) {
    console.warn("[bot] findActiveBooking falló:", e.message);
    return null;
  }
}

/** ¿El bot está habilitado para este alojamiento? Usa cache 5min. */
async function _botIsAlojamientoEnabled(houseId) {
  const map = await _botGetEnabledMap();
  return !!map[String(houseId)];
}

// ─── Modo Prueba (in-memory) — el bot solo responde a números whitelisted ─
// Predeterminado ENABLED para evitar responder a números no autorizados.
let _BOT_TEST_MODE = { enabled: true, phones: ["+528444443922"] };
function _botTestNormalizePhone(s) {
  return String(s || "").replace(/\D/g, "").slice(-10);
}
function _botTestGetAllowedSet() {
  const set = new Set();
  for (const p of (_BOT_TEST_MODE.phones || [])) {
    const n = _botTestNormalizePhone(p);
    if (n) set.add(n);
  }
  return set;
}
app.get("/wa/bot/test-mode", (req, res) => {
  res.json({
    ok: true,
    enabled: !!_BOT_TEST_MODE.enabled,
    phones: (_BOT_TEST_MODE.phones || []).slice(),
    // Retro-compat: primer número también en `phone`.
    phone: (_BOT_TEST_MODE.phones && _BOT_TEST_MODE.phones[0]) || "",
  });
});
app.post("/wa/bot/test-mode", (req, res) => {
  const b = req.body || {};
  if (typeof b.enabled === "boolean") _BOT_TEST_MODE.enabled = b.enabled;
  // Nuevo campo `phones` (array) preferido sobre `phone` (string) legacy.
  if (Array.isArray(b.phones)) {
    _BOT_TEST_MODE.phones = b.phones.map(p => String(p||'').trim()).filter(Boolean);
  } else if (typeof b.phone === "string") {
    _BOT_TEST_MODE.phones = [b.phone.trim()].filter(Boolean);
  }
  console.info(`[bot-test] enabled=${_BOT_TEST_MODE.enabled} phones=${JSON.stringify(_BOT_TEST_MODE.phones)}`);
  res.json({ ok: true, ..._BOT_TEST_MODE });
});

/** POST /wa/webhook-inbound — Twilio manda aquí los mensajes entrantes. */
app.post("/wa/webhook-inbound", express.urlencoded({ extended: false }), async (req, res) => {
  // Responder 200 rápido para no timeout Twilio — procesamos async.
  res.status(200).type("text/xml").send("<Response></Response>");
  const b = req.body || {};
  const fromRaw = String(b.From || b.WaId || "");
  const bodyMsg = String(b.Body || "").trim();
  if (!fromRaw || !bodyMsg) return;
  const phone10 = fromRaw.replace(/\D/g, "").slice(-10);
  if (!phone10) return;
  const t0 = Date.now();
  console.info(`[bot-in] ${phone10}: ${bodyMsg.slice(0,80)}`);
  // Modo Prueba: si activo, ignorar mensajes de números no incluidos en la
  // lista whitelisted. Aún guardamos el user msg para verlo en el panel.
  if (_BOT_TEST_MODE.enabled) {
    const allowed = _botTestGetAllowedSet();
    if (!allowed.has(phone10)) {
      console.info(`[bot-in] ${phone10}: TEST MODE — solo responde a [${Array.from(allowed).join(', ')}], skip`);
      _botAppendMessage(phone10, "user", bodyMsg, { from: fromRaw });
      return;
    }
  }
  try {
    // OPT: fire-and-forget para loguear msg entrante (no bloquea respuesta)
    _botAppendMessage(phone10, "user", bodyMsg, { from: fromRaw });
    // Detectar intent sensible ANTES de fetches (barato, síncrono)
    const sensitive = _botDetectSensitive(bodyMsg);
    if (sensitive) {
      console.info(`[bot-in] ${phone10}: escalar por sensitive: ${sensitive}`);
      _botEscalate(phone10, `Sensitive intent: ${sensitive}`);
      const msg = "Recibimos tu mensaje. En un momento te contactamos personalmente. 🙏";
      await _twilioSendMessage({ to: fromRaw, body: msg, skipMirror: true }).catch(()=>{});
      _botAppendMessage(phone10, "assistant", msg, { auto_escalate: true });
      return;
    }
    // OPT: PARALELIZAR — conversación + reserva activa simultáneas.
    // Antes: 4 requests secuenciales (append user, conv, bookings, alojamientos)
    // = ~25-30s. Ahora: 1 fire-and-forget + 2 en paralelo = ~8-10s.
    const [ctxResp, ctx] = await Promise.all([
      _botFetchConversation(phone10, 15),
      _botFindActiveBooking(phone10),
    ]);
    console.info(`[bot-in] ${phone10}: fetches paralelos en ${Date.now()-t0}ms`);
    const state = ctxResp.state || { control: "bot" };
    console.info(`[bot-in] ${phone10}: state.control="${state.control}" msgs=${(ctxResp.messages||[]).length}`);
    if (String(state.control) === "human") {
      console.info(`[bot-in] ${phone10}: skip (human control)`);
      return;
    }
    if (!ctx || !ctx.booking) {
      // Lead entrante sin reserva. En vez de escalar directamente, generamos
      // una respuesta de captura de datos (nombre, alojamiento de interés,
      // fechas). NO accede a datos privados de otros huéspedes.
      console.info(`[bot-in] ${phone10}: sin reserva → lead entrante (modo captura)`);
      const leadSystem = BOT_SYSTEM_PROMPT_BASE + `

CONTEXTO ESPECIAL — LEAD ENTRANTE SIN RESERVA
No tenemos una reserva asociada a este número. Tu objetivo es SOLO capturar los datos mínimos para poder cotizar y armar la reserva:
- Nombre del huésped.
- Alojamiento o zona de interés (Cumbres, Baja California, José Cárdenas, Matamoros, etc — pregunta cuál le interesa).
- Fechas tentativas (llegada y salida) o número de noches.
- Número de huéspedes.

REGLAS ESTRICTAS
- NO menciones ni compartas datos de OTROS huéspedes, reservas ajenas ni información privada.
- Si el huésped ya se identificó por su nombre en el chat, no vuelvas a pedirlo.
- Sé breve, cordial y directo. Máximo 2-3 líneas por mensaje.
- Si el huésped pide precios sin dar fechas, pídele fechas y personas antes de cotizar.
- Cuando tengas los 4 datos básicos, dile que en un momento el equipo de reservas le confirma disponibilidad y precio final.`;
      const historyForLlm = (ctxResp.messages || []).slice(-10, -1)
        .filter(m => m.role !== 'system')
        .map(m => ({ role: (m.role === 'admin' || m.role === 'template') ? 'assistant' : (m.role === 'user' ? 'user' : 'assistant'), body: m.body }));
      try {
        const tLlm = Date.now();
        const llm = await _llmChat({ system: leadSystem, history: historyForLlm, userMsg: bodyMsg });
        console.info(`[bot-in] ${phone10}: LLM lead en ${Date.now()-tLlm}ms`);
        const replyText = String(llm.text || "").trim() ||
          "¡Hola! Gracias por contactar Check-inn Saltillo. Para poder ayudarte, ¿me compartes tu nombre, el alojamiento o zona que te interesa, fechas tentativas y número de huéspedes? 🏠";
        // Modo SUPERVISED: guardar como draft para revisión humana.
        if (String(state.control) === "supervised") {
          try {
            await fetch(CHECKIN_APPS_SCRIPT_URL, {
              method: "POST",
              headers: { "Content-Type": "text/plain;charset=utf-8" },
              body: JSON.stringify({ action: "wa_chat_set_draft", phone: phone10, body: replyText }),
            });
          } catch (e) { console.warn("[bot-in] set_draft error:", e.message); }
          console.info(`[bot-out] ${phone10}: lead supervised draft guardado`);
          return;
        }
        await _twilioSendMessage({ to: fromRaw, body: replyText, skipMirror: true });
        _botAppendMessage(phone10, "assistant", replyText, { model: BOT_ANTHROPIC_MODEL, lead: true, usage: llm.usage });
        console.info(`[bot-out] ${phone10}: lead reply en total ${Date.now()-t0}ms`);
      } catch (e) {
        console.warn("[bot-in] lead LLM error:", e.message);
        const fallback = "¡Hola! Gracias por contactar Check-inn Saltillo. Para poder ayudarte, ¿me compartes tu nombre, el alojamiento o zona que te interesa, fechas tentativas y número de huéspedes? 🏠";
        await _twilioSendMessage({ to: fromRaw, body: fallback, skipMirror: true }).catch(()=>{});
        _botAppendMessage(phone10, "assistant", fallback, { lead: true, fallback: true });
      }
      return;
    }
    console.info(`[bot-in] ${phone10}: booking Id=${ctx.booking.Id} HouseId=${ctx.booking.HouseId}`);
    // El filtro de piloto (bot_enabled) SOLO aplica en modo Automático.
    // En Supervisado el admin aprueba cada respuesta manualmente — no hay
    // riesgo de mandar algo indebido, entonces generamos draft sin importar
    // si el alojamiento está en el piloto.
    if (String(state.control) === "bot") {
      const enabled = await _botIsAlojamientoEnabled(ctx.booking.HouseId);
      console.info(`[bot-in] ${phone10}: enabled=${enabled}`);
      if (!enabled) {
        console.info(`[bot-in] ${phone10}: aloj ${ctx.booking.HouseId} no en piloto — skip (modo bot)`);
        return;
      }
    } else {
      console.info(`[bot-in] ${phone10}: modo ${state.control} — skip check de piloto`);
    }
    // System prompt + Claude
    const context = _botBuildAlojamientoContext(ctx.alojRow, ctx.booking, ctx.allBookings);
    const system = BOT_SYSTEM_PROMPT_BASE + context;
    const history = (ctxResp.messages || []).slice(-10, -1); // excluir el user actual (ya guardado)
    // Anthropic solo acepta roles 'user' | 'assistant'. Nuestros roles
    // internos incluyen 'admin' (envío manual del panel), 'template'
    // (mensajes programados) y 'system'. Mapeamos:
    //   admin / template → assistant  (mensaje saliente al huésped)
    //   system            → skip
    const historyForLlm = history
      .filter(m => m.role !== 'system')
      .map(m => ({ role: (m.role === 'admin' || m.role === 'template') ? 'assistant' : (m.role === 'user' ? 'user' : 'assistant'), body: m.body }));
    const tLlm = Date.now();
    const llm = await _llmChat({ system, history: historyForLlm, userMsg: bodyMsg });
    console.info(`[bot-in] ${phone10}: LLM en ${Date.now()-tLlm}ms`);
    const replyText = String(llm.text || "").trim();
    if (!replyText) {
      console.warn(`[bot-in] ${phone10}: respuesta vacía del LLM — escalar`);
      _botEscalate(phone10, "respuesta vacía del LLM");
      return;
    }
    // Modo SUPERVISED: no enviar. Guardar como pending draft para que el
    // admin lo revise en el panel bot-chats y decida (send/edit/skip).
    if (String(state.control) === "supervised") {
      try {
        await fetch(CHECKIN_APPS_SCRIPT_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ action: "wa_chat_set_draft", phone: phone10, body: replyText }),
        });
      } catch (e) { console.warn("[bot-in] set_draft error:", e.message); }
      console.info(`[bot-out] ${phone10}: supervised draft guardado (${replyText.length} chars)`);
      return;
    }
    // Enviar respuesta (bloqueante) + persistir en background
    await _twilioSendMessage({ to: fromRaw, body: replyText, skipMirror: true });
    _botAppendMessage(phone10, "assistant", replyText, { model: BOT_ANTHROPIC_MODEL, usage: llm.usage });
    console.info(`[bot-out] ${phone10}: total ${Date.now()-t0}ms · "${replyText.slice(0,80)}"`);
  } catch (err) {
    console.error("[bot] error:", err.message);
    _botEscalate(phone10, "error interno: " + err.message);
  }
});

/** GET /wa/webhook-inbound — solo para verificación de Twilio (echo simple). */
app.get("/wa/webhook-inbound", (req, res) => {
  res.type("text/plain").send("wa/webhook-inbound OK — configure Twilio para POST aquí.");
});

// ═══════════════════════════════════════════════════════════════════════════
// ║ ENDPOINTS del PANEL ADMIN Bot Chats                                     ║
// ═══════════════════════════════════════════════════════════════════════════

// Cache in-memory para reducir presión sobre Apps Script (saturable).
// Convs cache 20s por filter; context cache 8s por phone.
const _wa_cache = { convs: new Map(), context: new Map() };
const _CONVS_TTL = 20_000, _CONTEXT_TTL = 8_000;

/** GET /wa/bot/conversations — lista conversaciones activas del bot. */
app.get("/wa/bot/conversations", async (req, res) => {
  try {
    const filter = String(req.query.filter || "all");
    const limit = String(req.query.limit || "100");
    const key = `${filter}|${limit}`;
    const now = Date.now();
    const hit = _wa_cache.convs.get(key);
    if (hit && (now - hit.t) < _CONVS_TTL) return res.json(hit.j);
    const url = `${CHECKIN_APPS_SCRIPT_URL}?action=wa_chat_conversations&filter=${encodeURIComponent(filter)}&limit=${encodeURIComponent(limit)}`;
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (j && j.ok) _wa_cache.convs.set(key, { t: now, j });
      res.json(j);
    } catch (fetchErr) {
      // Fallback: si hay respuesta cacheada aunque expirada, servirla stale.
      if (hit) return res.json(hit.j);
      throw fetchErr;
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** POST /wa/bot/sys-ia — el admin le pide al LLM una sugerencia para
 *  responder al huésped. Devuelve texto sugerido; NO envía nada. */
app.post("/wa/bot/sys-ia", async (req, res) => {
  try {
    const phone = String(req.body?.phone || "").replace(/\D/g, "").slice(-10);
    const prompt = String(req.body?.prompt || "").trim();
    if (!phone) return res.status(400).json({ ok:false, error:"phone requerido" });
    if (!prompt) return res.status(400).json({ ok:false, error:"prompt requerido" });
    // Cargar contexto (conversación previa + reserva si existe) en paralelo.
    const [ctxResp, ctx] = await Promise.all([
      _botFetchConversation(phone, 20),
      _botFindActiveBooking(phone),
    ]);
    let alojContext = "";
    if (ctx && ctx.booking) {
      alojContext = _botBuildAlojamientoContext(ctx.alojRow, ctx.booking, ctx.allBookings);
    } else {
      alojContext = "\n[No hay reserva registrada para este número — lead sin contexto de alojamiento.]";
    }
    const sysIaPrompt = `Eres un asistente para el ADMIN de Check-inn Saltillo. El admin está atendiendo a un huésped por WhatsApp y necesita tu ayuda para redactar una respuesta.

REGLAS ESTRICTAS:
- NO inventes datos. Solo puedes afirmar lo que está en el contexto abajo.
- Redacta la respuesta EN PRIMERA PERSONA como si el admin la fuera a mandar tal cual al huésped.
- Sé breve, natural y cordial. Máximo 3-4 oraciones.
- Si el admin te pide algo que requiere info que no tenemos, dilo en la respuesta: "No tengo el dato exacto, en un momento te confirmo" — no inventes.
- No incluyas explicaciones al admin, solo la respuesta lista para copiar y enviar al huésped.

INSTRUCCIÓN DEL ADMIN: ${prompt}
${alojContext}`;
    const history = (ctxResp.messages || []).slice(-10)
      .filter(m => m.role !== 'system')
      .map(m => ({ role: (m.role === 'admin' || m.role === 'template') ? 'assistant' : (m.role === 'user' ? 'user' : 'assistant'), body: m.body }));
    const llm = await _llmChat({ system: sysIaPrompt, history, userMsg: prompt });
    const reply = String(llm.text || "").trim();
    res.json({ ok: true, reply });
  } catch (err) {
    console.error("[sys-ia] error:", err.message);
    res.status(500).json({ ok:false, error: err.message });
  }
});

/** GET /wa/bot/context?phone=X&limit=N — historial de una conversación + estado. */
app.get("/wa/bot/context", async (req, res) => {
  try {
    const phone = String(req.query.phone || "").replace(/\D/g,"").slice(-10);
    if (!phone) return res.status(400).json({ ok: false, error: "phone requerido" });
    const limit = String(req.query.limit || "50");
    const key = `${phone}|${limit}`;
    const now = Date.now();
    const hit = _wa_cache.context.get(key);
    if (hit && (now - hit.t) < _CONTEXT_TTL) return res.json(hit.j);
    const url = `${CHECKIN_APPS_SCRIPT_URL}?action=wa_chat_context_get&phone=${encodeURIComponent(phone)}&limit=${encodeURIComponent(limit)}`;
    let r, j;
    try {
      r = await fetch(url);
      j = await r.json();
      if (j && j.ok) _wa_cache.context.set(key, { t: now, j });
    } catch (fetchErr) {
      if (hit) return res.json(hit.j);
      throw fetchErr;
    }
    res.json(j);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** POST /wa/bot/set-control { phone, control: 'bot'|'human', reason? }
 *  Cambia control del chat (Tomar control / Devolver al bot). */
app.post("/wa/bot/set-control", async (req, res) => {
  try {
    const p = req.body || {};
    const phone = String(p.phone || "").replace(/\D/g,"").slice(-10);
    const control = String(p.control || "");
    if (!phone || !/^(bot|human|supervised)$/.test(control)) return res.status(400).json({ ok: false, error: "phone + control (bot|human|supervised) requeridos" });
    const r = await fetch(CHECKIN_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "wa_chat_set_control", phone, control, reason: p.reason || "", notes: p.notes || "" }),
    });
    const j = await r.json();
    res.json(j);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** POST /wa/bot/send-as-admin { phone, body }
 *  Admin envía msg manual al huésped desde el panel. Marca control=human
 *  automáticamente para que el bot no responda encima. */
app.post("/wa/bot/send-as-admin", async (req, res) => {
  try {
    const p = req.body || {};
    const phone = String(p.phone || "").replace(/\D/g,"").slice(-10);
    const body = String(p.body || "").trim();
    if (!phone || !body) return res.status(400).json({ ok: false, error: "phone + body requeridos" });
    // 1) Enviar por Twilio
    const to = `whatsapp:+52${phone}`;
    const msg = await _twilioSendMessage({ to, body, skipMirror: true });
    // 2) Loguear como 'admin' y asegurar control=human
    fetch(CHECKIN_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "wa_chat_context_append", phone, role: "admin", body, meta: { sid: msg.sid } }),
    }).catch(()=>{});
    fetch(CHECKIN_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "wa_chat_set_control", phone, control: "human", reason: "admin envió msg manual" }),
    }).catch(()=>{});
    res.json({ ok: true, sid: msg.sid, status: msg.status });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** POST /wa/bot/draft-action { phone, action: 'send'|'edit'|'skip', body? }
 *  Procesa la decisión del admin sobre el pending draft (modo supervised):
 *   - send: envía el draft actual como assistant, limpia draft.
 *   - edit: envía body nuevo como assistant, limpia draft.
 *   - skip: descarta el draft sin enviar. */
app.post("/wa/bot/draft-action", async (req, res) => {
  try {
    const p = req.body || {};
    const phone = String(p.phone || "").replace(/\D/g,"").slice(-10);
    const action = String(p.action || "");
    if (!phone || !/^(send|edit|skip)$/.test(action)) {
      return res.status(400).json({ ok: false, error: "phone + action (send|edit|skip) requeridos" });
    }
    if (action === "skip") {
      await fetch(CHECKIN_APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "wa_chat_set_draft", phone, body: "" }),
      });
      return res.json({ ok: true, skipped: true });
    }
    // send / edit → necesito el body a enviar
    let outBody = String(p.body || "").trim();
    if (action === "send" && !outBody) {
      // Traer del state actual (pending_draft_body)
      const r = await fetch(`${CHECKIN_APPS_SCRIPT_URL}?action=wa_chat_context_get&phone=${encodeURIComponent(phone)}&limit=1`);
      const j = await r.json();
      outBody = String(j && j.state && j.state.pending_draft_body || "").trim();
    }
    if (!outBody) return res.status(400).json({ ok: false, error: "sin body para enviar" });
    const to = `whatsapp:+52${phone}`;
    const msg = await _twilioSendMessage({ to, body: outBody, skipMirror: true });
    // Log como assistant + limpiar draft (fire-and-forget)
    fetch(CHECKIN_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "wa_chat_context_append", phone, role: "assistant", body: outBody, meta: { sid: msg.sid, supervised: true, action } }),
    }).catch(()=>{});
    fetch(CHECKIN_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "wa_chat_set_draft", phone, body: "" }),
    }).catch(()=>{});
    res.json({ ok: true, sid: msg.sid, status: msg.status, action });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** GET /wa/bot/alojamientos — lista alojamientos con flag bot_enabled. */
/** POST /wa/bot/summarize { phone } — genera un resumen sintético de toda
 *  la conversación (bot + admin + huésped) para que el agente entienda
 *  rápido el estado, con énfasis en el último tema o asunto pendiente. */
app.post("/wa/bot/summarize", async (req, res) => {
  try {
    const phone = String(req.body?.phone || "").replace(/\D/g,"").slice(-10);
    if (!phone) return res.status(400).json({ ok: false, error: "phone requerido" });
    // Traer TODO el historial combinado (context + logs) para máximo contexto.
    const r = await fetch(`${CHECKIN_APPS_SCRIPT_URL}?action=wa_all_messages&phone=${encodeURIComponent(phone)}`);
    const j = await r.json();
    const msgs = (j && j.ok && Array.isArray(j.messages)) ? j.messages : [];
    if (!msgs.length) return res.json({ ok: true, summary: "Sin mensajes en la conversación." });
    // Ordenar cronológicamente por timestamp.
    msgs.sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
    // Truncar a los últimos 100 msgs para no explotar tokens.
    const recent = msgs.slice(-100);
    const transcript = recent.map(m => {
      const who = m.role === 'user' ? 'HUÉSPED'
                : m.role === 'assistant' ? 'BOT'
                : m.role === 'admin' ? 'ADMIN'
                : m.role === 'template' ? 'TEMPLATE'
                : String(m.role || '?').toUpperCase();
      const ts = String(m.timestamp || '').slice(0, 16).replace('T', ' ');
      return `[${ts}] ${who}: ${String(m.body || '').slice(0, 500)}`;
    }).join("\n");
    const system = `Eres un asistente que resume conversaciones de WhatsApp entre huéspedes de un hotel y el equipo (bot + admin humano).

Genera un resumen SINTÉTICO (máx. 220 palabras) para que un agente entienda de un vistazo. El resumen SIEMPRE debe tener EXACTAMENTE estas 4 secciones (headings h2 en markdown), en este orden:

## Contexto
Quién es el huésped y sobre qué alojamiento habla (si se menciona). 1-2 líneas.

## Temas tratados
Bullets breves de asuntos discutidos. **Cada bullet empieza con \`[DD-mmm HH:MM]\`** extraído del timestamp del primer mensaje del tema. Ejemplo: \`[23-ago 15:28]\`.

## Último tema / pendiente
Qué es lo último que quedó abierto. **Incluye la fecha y hora del último mensaje relevante** al inicio (\`[DD-mmm HH:MM]\`). Marca claramente si el huésped está esperando respuesta. Si todo está cerrado, escribe: "Sin pendientes — última interacción [fecha-hora] fue…".

## Riesgos
**SIEMPRE incluye esta sección** aunque sea para decir "Ninguno detectado". Menciona quejas, reembolsos, molestias, menciones de dinero, tono agresivo o temas sensibles, con \`[DD-mmm HH:MM]\`.

Formato fecha: día-mes hh:mm (24h). Meses cortos español: ene, feb, mar, abr, may, jun, jul, ago, sep, oct, nov, dic.

Escribe en español, tono profesional. Nunca omitas una sección — si no aplica, dilo explícitamente. El agente tiene 10 segundos para leer.`;
    const llm = await _llmChat({
      system,
      history: [],
      userMsg: `Resume esta conversación:\n\n${transcript}`,
    });
    const summary = String(llm.text || "").trim() || "No se pudo generar resumen.";
    res.json({ ok: true, summary, msgs_analizados: recent.length, msgs_total: msgs.length });
  } catch (err) {
    console.error("[summarize]", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/wa/bot/alojamientos", async (req, res) => {
  try {
    const r = await fetch(`${CHECKIN_APPS_SCRIPT_URL}?action=wa_bot_alojamientos`);
    const j = await r.json();
    res.json(j);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** GET /wa/bot/all-messages?phone=X — historial COMPLETO WA (bot + logs). */
app.get("/wa/bot/all-messages", async (req, res) => {
  try {
    const phone = String(req.query.phone || "").replace(/\D/g,"").slice(-10);
    if (!phone) return res.status(400).json({ ok: false, error: "phone requerido" });
    const url = `${CHECKIN_APPS_SCRIPT_URL}?action=wa_all_messages&phone=${encodeURIComponent(phone)}&limit=500`;
    const r = await fetch(url);
    const j = await r.json();
    res.json(j);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** POST /wa/bot/alojamientos-set { houseIds: [...] }
 *  Actualiza masivamente qué alojamientos tienen bot_enabled=TRUE. Los que
 *  NO están en la lista quedan desactivados. Invalida el cache in-memory
 *  para que el próximo mensaje entrante refleje los cambios inmediatamente. */
app.post("/wa/bot/alojamientos-set", async (req, res) => {
  try {
    const p = req.body || {};
    if (!Array.isArray(p.houseIds)) return res.status(400).json({ ok: false, error: "houseIds (array) requerido" });
    const r = await fetch(CHECKIN_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "wa_bot_alojamientos_set", houseIds: p.houseIds }),
    });
    const j = await r.json();
    // Invalidar cache in-memory del webhook para que aplique de inmediato
    _botAlojEnabledCache.map = null; _botAlojEnabledCache.ts = 0;
    res.json(j);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/wa/send", async (req, res) => {
  try {
    const p = req.body || {};
    const to = _waFormatTo(p.to);
    if (!to) return res.status(400).json({ ok: false, error: "to requerido" });
    if (!p.body && !p.contentSid) return res.status(400).json({ ok: false, error: "body o contentSid requerido" });
    const msg = await _twilioSendMessage({ to, body: p.body, contentSid: p.contentSid, contentVars: p.contentVars });
    // Log no-bloqueante (falla del log no debe romper el envío)
    _waLog({
      booking_id: p.bookingId || "",
      tipo: p.tipo || (p.contentSid ? "manual-template" : "manual-freeform"),
      origin: "manual-admin",
      to, sid: msg.sid, status: msg.status,
      body_preview: p.body || (p.contentVars ? JSON.stringify(p.contentVars) : ""),
    });
    res.json({ ok: true, sid: msg.sid, status: msg.status, to: msg.to });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

function _waLog(entry) {
  callCheckinAppsScriptPost("wa_log_add", entry).catch(e => console.warn("[wa-log]", e.message));
}

// POST /wa/config-get — batch de config para varias reservas
// Body: { bookingIds: [id1, id2, …] }  (vacío = todos)
// Response: { ok: true, config: { id: { auto_enabled, updated_at, updated_by }, ... }, logs: { id: [...] } }
app.post("/wa/config-get", async (req, res) => {
  try {
    const p = req.body || {};
    const ids = Array.isArray(p.bookingIds) ? p.bookingIds : [];
    const [cfg, log] = await Promise.all([
      callCheckinAppsScriptPost("wa_config_get_batch", { booking_ids: ids }),
      callCheckinAppsScriptPost("wa_log_get_batch",    { booking_ids: ids, limit_per_booking: 5 }),
    ]);
    res.json({ ok: true, config: (cfg && cfg.config) || {}, logs: (log && log.logs) || {} });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /wa/url-guia — devuelve la URL de guía real desde alojamientos.
// Body: { houseId: "605555" } → { ok: true, url_guia: "https://..." }
app.post("/wa/url-guia", async (req, res) => {
  try {
    const houseId = String((req.body && req.body.houseId) || "").trim();
    if (!houseId) return res.status(400).json({ ok: false, error: "houseId requerido" });
    const r = await callCheckinAppsScriptPost("wa_url_guia_get", { house_id: houseId });
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /wa/scheduled-add — programa un mensaje personalizado para envío futuro.
// Body: { bookingId, to (string CSV o array), scheduledAt (ISO), body, asunto?, createdBy? }
app.post("/wa/scheduled-add", async (req, res) => {
  try {
    const p = req.body || {};
    const list = _waFormatToList(p.to);
    if (!list.length) return res.status(400).json({ ok: false, error: "to requerido (al menos 1 destinatario)" });
    if (!p.scheduledAt) return res.status(400).json({ ok: false, error: "scheduledAt requerido" });
    if (!p.body || !String(p.body).trim()) return res.status(400).json({ ok: false, error: "body requerido" });
    // Guardar como CSV para que el cron/send iteren.
    const toCsv = list.join(",");
    const r = await callCheckinAppsScriptPost("wa_scheduled_add", {
      booking_id: p.bookingId || "",
      tipo: p.tipo || "custom",
      to: toCsv,
      scheduled_at: p.scheduledAt,
      body: p.body,
      asunto: p.asunto || "",
      created_by: p.createdBy || "admin",
    });
    res.json({ ...r, to: toCsv, recipients_count: list.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /wa/scheduled-delete — borra fila del sheet.
app.post("/wa/scheduled-delete", async (req, res) => {
  try {
    const id = String((req.body && req.body.id) || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "id requerido" });
    const r = await callCheckinAppsScriptPost("wa_scheduled_delete", { id });
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Templates (Configuración Admin) ─────────────────────────────────────
app.post("/wa/templates-list", async (req, res) => {
  try {
    const r = await callCheckinAppsScriptPost("wa_templates_list", {});
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/wa/templates-upsert", async (req, res) => {
  try {
    const p = req.body || {};
    if (!p.nombre || !String(p.nombre).trim()) {
      return res.status(400).json({ ok: false, error: "nombre requerido" });
    }
    const r = await callCheckinAppsScriptPost("wa_templates_upsert", {
      id: p.id || "",
      nombre: p.nombre,
      body: p.body || "",
      asunto: p.asunto || "",
      schedule_type: p.schedule_type || "never",
      schedule_time: p.schedule_time || "",
      schedule_event: p.schedule_event || "",
      schedule_offset: (p.schedule_offset || p.schedule_offset === 0) ? String(p.schedule_offset) : "",
      alojamientos: p.alojamientos || "",
      enabled: p.enabled === true,
      responsivo: p.responsivo === true,
      updated_by: p.updated_by || "admin",
      // JSON string (array de {name, value}) — passthrough al Apps Script.
      placeholders_custom: (p.placeholders_custom != null)
        ? (typeof p.placeholders_custom === "string" ? p.placeholders_custom : JSON.stringify(p.placeholders_custom))
        : undefined,
    });
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/wa/templates-delete", async (req, res) => {
  try {
    const id = String((req.body && req.body.id) || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "id requerido" });
    const r = await callCheckinAppsScriptPost("wa_templates_delete", { id });
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Llaves (control de llaves y códigos por alojamiento) ────────────────
app.post("/llaves-list", async (req, res) => {
  try {
    const r = await callCheckinAppsScriptPost("llaves_list", {});
    res.json(r);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Body: { houseId, alojamiento, cell, state, date, updated_by }
//  - cell: 'puerta'|'caja_seguridad'|'claudia'|'damariz'|'mantenimiento'|'oficina'
//  - state: 'V' (verificado) | 'F' (falta) | '' (default/no set)
//  - date: 'YYYY-MM-DD'
app.post("/llaves-upsert", async (req, res) => {
  try {
    const p = req.body || {};
    if (!p.houseId) return res.status(400).json({ ok: false, error: "houseId requerido" });
    const r = await callCheckinAppsScriptPost("llaves_upsert", {
      houseId: String(p.houseId),
      alojamiento: p.alojamiento || "",
      cell: (p.cell || "").toLowerCase(),
      state: (p.state || "").toUpperCase(),
      date: p.date || "",
      updated_by: p.updated_by || "admin",
    });
    res.json(r);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /wa/scheduled-list — lista mensajes programados de una reserva.
// Body: { bookingId } → { ok: true, items: [...] }
app.post("/wa/scheduled-list", async (req, res) => {
  try {
    const bookingId = String((req.body && req.body.bookingId) || "").trim();
    const r = await callCheckinAppsScriptPost("wa_scheduled_list", { booking_id: bookingId });
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /wa/scheduled-omit — cancela un mensaje programado (marca status=omitted).
app.post("/wa/scheduled-omit", async (req, res) => {
  try {
    const id = String((req.body && req.body.id) || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "id requerido" });
    const r = await callCheckinAppsScriptPost("wa_scheduled_omit", { id });
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /wa/scheduled-update — actualiza body/scheduledAt/status de un scheduled.
// Body: { id, body?, scheduledAt?, status?  (pending|omitted) }
app.post("/wa/scheduled-update", async (req, res) => {
  try {
    const p = req.body || {};
    if (!p.id) return res.status(400).json({ ok: false, error: "id requerido" });
    const payload = { id: p.id };
    if (Object.prototype.hasOwnProperty.call(p, "body"))        payload.body = p.body;
    if (Object.prototype.hasOwnProperty.call(p, "scheduledAt")) payload.scheduled_at = p.scheduledAt;
    if (Object.prototype.hasOwnProperty.call(p, "status"))      payload.status = p.status;
    const r = await callCheckinAppsScriptPost("wa_scheduled_update", payload);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /wa/scheduled-send-now — envía un programado inmediatamente y marca sent.
app.post("/wa/scheduled-send-now", async (req, res) => {
  try {
    const id = String((req.body && req.body.id) || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "id requerido" });
    const list = await callCheckinAppsScriptPost("wa_scheduled_list", { booking_id: "" });
    const item = ((list && list.items) || []).find(x => x.id === id);
    if (!item) return res.status(404).json({ ok: false, error: "no encontrado" });
    // Re-enviar permitido: si ya fue enviado antes, se envía de nuevo.
    // Solo omitidos NO se pueden enviar.
    if (item.status === "omitted") return res.status(409).json({ ok: false, error: "status=omitted" });
    const rcps = _waFormatToList(item.to);
    if (!rcps.length) return res.status(400).json({ ok: false, error: "sin destinatarios válidos" });
    let ok = 0, failed = 0, sids = [], lastErr = "";
    for (const to of rcps) {
      try {
        const m = await _twilioSendMessage({ to, body: item.body });
        _waLog({
          booking_id: item.booking_id, tipo: "custom-scheduled", origin: "manual-admin",
          to, sid: m.sid, status: m.status || "sent", body_preview: item.body,
        });
        ok++; sids.push(m.sid);
      } catch (e) { failed++; lastErr = e.message; }
    }
    const finalStatus = ok === rcps.length ? "sent" : (ok === 0 ? "failed" : "partial");
    await callCheckinAppsScriptPost("wa_scheduled_mark_sent", {
      id, sid: sids.join(","), status: finalStatus,
    });
    if (ok === 0) throw new Error(lastErr || "todos fallaron");
    res.json({ ok: true, sid: sids[0], status: finalStatus, sent: ok, failed });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /wa/cron-scheduled-tick — Cloud Scheduler cada 15 min: envía todos
// los mensajes programados con scheduled_at <= now.
app.post("/wa/cron-scheduled-tick", async (req, res) => {
  try {
    const secret = req.get("X-Sync-Secret") || "";
    if (!process.env.SYNC_SECRET || secret !== process.env.SYNC_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    const p = await callCheckinAppsScriptPost("wa_scheduled_pending", {});
    const items = (p && p.items) || [];
    let sent = 0, failed = 0;
    for (const it of items) {
      const rcps = _waFormatToList(it.to);
      if (!rcps.length) { failed++; continue; }
      let ok = 0, itFail = 0, sids = [];
      for (const to of rcps) {
        try {
          const m = await _twilioSendMessage({ to, body: it.body });
          _waLog({
            booking_id: it.booking_id, tipo: "custom-scheduled", origin: "auto-cron",
            to, sid: m.sid, status: m.status || "sent", body_preview: it.body,
          });
          ok++; sids.push(m.sid);
        } catch (e) { itFail++; }
      }
      const finalStatus = ok === rcps.length ? "sent" : (ok === 0 ? "failed" : "partial");
      await callCheckinAppsScriptPost("wa_scheduled_mark_sent", { id: it.id, sid: sids.join(","), status: finalStatus });
      if (ok > 0) sent++; else failed++;
    }
    res.json({ ok: true, total: items.length, sent, failed });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /wa/config-set — toggle auto_enabled y/o disabled_templates para una reserva
// Body: { bookingId, autoEnabled?: bool, disabledTemplates?: [templateId,...], updatedBy? }
app.post("/wa/config-set", async (req, res) => {
  try {
    const p = req.body || {};
    if (!p.bookingId) return res.status(400).json({ ok: false, error: "bookingId requerido" });
    const payload = { booking_id: p.bookingId, updated_by: p.updatedBy || "admin" };
    if (Object.prototype.hasOwnProperty.call(p, "autoEnabled"))       payload.auto_enabled = !!p.autoEnabled;
    if (Object.prototype.hasOwnProperty.call(p, "disabledTemplates")) payload.disabled_templates = p.disabledTemplates;
    if (Object.prototype.hasOwnProperty.call(p, "recipients"))        payload.recipients = p.recipients;
    const r = await callCheckinAppsScriptPost("wa_config_set", payload);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /wa/toggle-template — habilita/deshabilita un template individual para
// esa reserva (no afecta a otras reservas ni al toggle global Auto).
// Body: { bookingId, templateId, enabled: bool }
app.post("/wa/toggle-template", async (req, res) => {
  try {
    const p = req.body || {};
    if (!p.bookingId || !p.templateId) return res.status(400).json({ ok: false, error: "bookingId y templateId requeridos" });
    // Leer config actual → mutar array → guardar
    const cur = await callCheckinAppsScriptPost("wa_config_get_batch", { booking_ids: [p.bookingId] });
    const cfg = (cur && cur.config && cur.config[p.bookingId]) || { disabled_templates: [] };
    const disabled = Array.isArray(cfg.disabled_templates) ? cfg.disabled_templates.slice() : [];
    const idx = disabled.indexOf(p.templateId);
    if (p.enabled === false) {
      if (idx < 0) disabled.push(p.templateId);
    } else {
      if (idx >= 0) disabled.splice(idx, 1);
    }
    const r = await callCheckinAppsScriptPost("wa_config_set", {
      booking_id: p.bookingId, disabled_templates: disabled, updated_by: "admin",
    });
    res.json({ ok: true, disabled_templates: disabled });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /wa/inbound — webhook para respuestas de huéspedes (Twilio lo llama).
// Registra el mensaje en Google Sheets vía Apps Script para historial + trigger
// automatizaciones (ej: "cancelar" liberar reserva).
app.post("/wa/inbound", express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const p = req.body || {};
    console.log("[WA inbound]", p.From, "→", p.To, ":", (p.Body || "").slice(0, 200));
    // Delegar registro a Apps Script (no bloqueante).
    callCheckinAppsScriptPost("wa_inbound_log", {
      from: p.From, to: p.To, body: p.Body, sid: p.MessageSid,
      profileName: p.ProfileName, ts: new Date().toISOString(),
    }).catch(e => console.warn("[WA inbound] log falló:", e.message));
    // Twilio espera TwiML vacío para no auto-responder.
    res.set("Content-Type", "text/xml").send("<Response></Response>");
  } catch (err) {
    console.warn("[WA inbound] error:", err.message);
    res.set("Content-Type", "text/xml").send("<Response></Response>");
  }
});

// POST /wa/cron-guest-reminders — dispara recordatorios WhatsApp masivos.
// Body: { type: "checkin"|"checkout", daysAhead?: number, dryRun?: bool,
//          overrideTo?: string (fuerza destinatario, útil para pruebas Sandbox) }
// Header: X-Sync-Secret
// Templates (aprobados en Meta para producción):
//   checkin  → HX71192c768d8240f08daf76f94c501f2c (recordatorio_checkin_24h)
//   checkout → HXcd62e32ae21e80655192928e522d01b8 (recordatorio_checkout)
const _WA_TEMPLATE_SIDS = {
  checkin:  "HX71192c768d8240f08daf76f94c501f2c",
  checkout: "HXcd62e32ae21e80655192928e522d01b8",
};

function _mesEs(m) {
  return ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"][m] || "";
}
function _fechaHoraEs(iso, hora) {
  try {
    const d = iso ? new Date(iso + "T00:00:00") : null;
    const f = d ? `${d.getDate()} de ${_mesEs(d.getMonth())}` : "";
    const h = String(hora || "").trim();
    return h ? `${f}, ${h}` : (f || "próximo");
  } catch (_) { return "próximo"; }
}
function _todayIso(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + Number(offsetDays || 0));
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,"0"), day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}

async function _fetchLodgifyBookingsForDate(dateIso, kind /* "arrival"|"departure" */) {
  const apiKey = process.env.LODGIFY_API_KEY;
  if (!apiKey) throw new Error("LODGIFY_API_KEY faltante");
  // stayFilter:
  //   arrival (recordatorio check-in): Upcoming (bookings que aún no empiezan)
  //   departure (recordatorio check-out): Current (bookings dentro de estancia)
  const stayFilter = (kind === "arrival") ? "Upcoming" : "Current";
  const all = [];
  let page = 1;
  const maxPages = 5; // hasta 500 bookings por corrida, suficiente
  for (; page <= maxPages; page++) {
    const url = `https://api.lodgify.com/v2/reservations/bookings?stayFilter=${stayFilter}&page=${page}&size=100&includeCount=false`;
    const r = await fetch(url, { headers: { "X-ApiKey": apiKey, accept: "application/json" }});
    if (!r.ok) throw new Error(`Lodgify ${r.status} (page ${page})`);
    const j = await r.json();
    const items = Array.isArray(j.items) ? j.items : (Array.isArray(j) ? j : []);
    if (!items.length) break;
    all.push(...items);
    if (items.length < 100) break; // última página
  }
  // Filtro exacto por fecha + status válido (excluye Declined/Cancelled/Open tentativos)
  const VALID_STATUS = new Set(["Booked", "Confirmed", "InHouse", "CheckedIn"]);
  return all.filter(b => {
    const dateField = kind === "arrival" ? b.arrival : b.departure;
    if (String(dateField || "").slice(0, 10) !== dateIso) return false;
    const st = String(b.status || "");
    return VALID_STATUS.has(st);
  });
}

app.post("/wa/cron-guest-reminders", async (req, res) => {
  try {
    const secret = req.get("X-Sync-Secret") || "";
    if (!process.env.SYNC_SECRET || secret !== process.env.SYNC_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    const p = req.body || {};
    const type = String(p.type || "").toLowerCase();
    if (!["checkin","checkout"].includes(type)) {
      return res.status(400).json({ ok: false, error: "type debe ser 'checkin' o 'checkout'" });
    }
    const daysAhead = Number(p.daysAhead != null ? p.daysAhead : (type === "checkin" ? 1 : 0));
    const dateIso = _todayIso(daysAhead);
    const kind = type === "checkin" ? "arrival" : "departure";
    const contentSid = _WA_TEMPLATE_SIDS[type];
    const dryRun = !!p.dryRun;
    const overrideTo = p.overrideTo ? _waFormatTo(p.overrideTo) : null;

    console.log(`[wa-cron] type=${type} dateIso=${dateIso} dryRun=${dryRun} override=${overrideTo||"-"}`);

    const bookings = await _fetchLodgifyBookingsForDate(dateIso, kind);
    console.log(`[wa-cron] bookings encontrados: ${bookings.length}`);

    // Config batch: solo enviar a bookings con auto_enabled=true.
    // Los que no tienen fila en WA_Config quedan como auto_enabled=false (default).
    // Excepción: si dryRun O overrideTo, ignoramos el toggle (para pruebas).
    let waConfig = {};
    try {
      const bookingIds = bookings.map(b => String(b.id));
      const cfgRes = await callCheckinAppsScriptPost("wa_config_get_batch", { booking_ids: bookingIds });
      waConfig = (cfgRes && cfgRes.config) || {};
    } catch (e) { console.warn("[wa-cron] config falló:", e.message); }
    const bypassToggle = dryRun || !!overrideTo;

    // Map property_id → nombre desde el cache de alojamientos (BANCOS/Apps Script).
    // Reusa el mismo _alojCache que alimenta /alojamientos-list.
    let alojIdx = new Map();
    try {
      const now = Date.now();
      if (!_alojCache.payload || (now - _alojCache.ts) > ALOJ_CACHE_MS) {
        _alojCache.payload = await callCheckinAppsScript("list_alojamientos");
        _alojCache.ts = now;
      }
      const rows = (_alojCache.payload && _alojCache.payload.rows) || [];
      for (const r of rows) {
        const id = String(r.HouseId || r.HouseID || r.ID || "").trim();
        if (id) alojIdx.set(id, r);
      }
    } catch (e) { console.warn("[wa-cron] alojamientos map falló:", e.message); }

    const results = [];
    let sent = 0, failed = 0, skipped = 0;
    for (const b of bookings) {
      const guest = b.guest || {};
      const nombre = String(guest.name || "").trim();
      const firstName = nombre.split(/\s+/)[0] || "Huésped";
      const phoneRaw = guest.phone || (b.messaging && b.messaging.guest_phone) || "";
      const houseId = String(b.property_id || "");
      // Nombre alojamiento: preferir HouseName del cache; fallback a "tu alojamiento".
      const alojRow = alojIdx.get(houseId);
      const propReal = alojRow && (alojRow.Propiedad || "");
      const deptReal = alojRow && (alojRow["# Departamento"] || "");
      const houseNameFull = alojRow && (alojRow.HouseName || "");
      const alojamiento = (propReal && deptReal) ? `${propReal} #${deptReal}` : (houseNameFull || propReal || "tu alojamiento");
      const guiaUrl = houseId ? `https://www.check-inn.mx/public/guia/?id=${encodeURIComponent(houseId)}` : "https://www.check-inn.mx";

      const to = overrideTo || _waFormatTo(phoneRaw);
      if (!to) { skipped++; results.push({ bookingId: b.id, skipped: "sin teléfono" }); continue; }

      // Chequeo toggle: si NO está auto_enabled y NO es dryRun/override → skip.
      const cfg = waConfig[String(b.id)];
      const autoEnabled = !!(cfg && cfg.auto_enabled);
      if (!bypassToggle && !autoEnabled) {
        skipped++;
        results.push({ bookingId: b.id, skipped: "auto_enabled=false" });
        continue;
      }
      // Chequeo template individual: si está en disabled_templates → skip.
      const disabledArr = (cfg && Array.isArray(cfg.disabled_templates)) ? cfg.disabled_templates : [];
      const tplKey = (type === "checkin") ? "recordatorio_checkin_24h" : "recordatorio_checkout";
      if (!bypassToggle && disabledArr.indexOf(tplKey) >= 0) {
        skipped++;
        results.push({ bookingId: b.id, skipped: `template ${tplKey} deshabilitado` });
        continue;
      }

      const contentVars = (type === "checkin")
        ? { "1": firstName, "2": alojamiento, "3": _fechaHoraEs(dateIso, ""), "4": guiaUrl }
        : { "1": firstName, "2": alojamiento, "3": "12:00 pm", "4": guiaUrl };

      if (dryRun) {
        results.push({ bookingId: b.id, to, dryRun: true, autoEnabled, contentVars });
        continue;
      }
      try {
        const m = await _twilioSendMessage({ to, contentSid, contentVars });
        sent++;
        results.push({ bookingId: b.id, to, sid: m.sid, status: m.status });
        _waLog({
          booking_id: String(b.id), tipo: type, origin: "auto-cron",
          to, sid: m.sid, status: m.status,
          body_preview: JSON.stringify(contentVars),
        });
      } catch (e) {
        failed++;
        results.push({ bookingId: b.id, to, error: e.message });
        _waLog({
          booking_id: String(b.id), tipo: type, origin: "auto-cron",
          to, sid: "", status: "failed",
          body_preview: "ERR: " + e.message,
        });
      }
    }

    res.json({ ok: true, type, dateIso, bookingsTotal: bookings.length, sent, failed, skipped, dryRun, results });
  } catch (err) {
    console.error("[wa-cron] ERROR:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Sync guías → GitHub Pages ─────────────────────────────────────────────
// Genera un JSON estático por alojamiento en el repo checkin-app
// (public/guia/data/<HouseId>.json). El frontend público lee desde ahí
// (Fastly IPs) en vez del backend (Google Cloud IPs que Telcel bloquea).
// Se llama desde Cloud Scheduler cada hora con header X-Sync-Secret.
// Usa Git Data API para hacer 1 commit con TODOS los archivos (mucho
// más rápido y limpio que 50 PUTs individuales).
// Endpoint público para botón "Actualizar" del módulo Guías (admin).
// Delega al endpoint interno inyectando el secret desde env. Sin secret
// requerido del cliente — el server actúa como proxy autorizado.
app.post("/guias/sync-now", async (req, res) => {
  try {
    if (!process.env.SYNC_SECRET) {
      return res.status(500).json({ ok: false, error: "SYNC_SECRET no configurado" });
    }
    // Reusar lógica del endpoint interno: forward con el secret propio.
    const port = process.env.PORT || 8080;
    const r = await fetch(`http://127.0.0.1:${port}/internal/sync-guias-to-github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sync-Secret": process.env.SYNC_SECRET,
      },
      body: "{}",
    });
    const j = await r.json();
    res.status(r.status).json(j);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/internal/sync-guias-to-github", async (req, res) => {
  try {
    const secret = req.get("X-Sync-Secret") || "";
    if (!process.env.SYNC_SECRET || secret !== process.env.SYNC_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    const ghToken = process.env.GH_TOKEN;
    if (!ghToken) return res.status(500).json({ ok: false, error: "GH_TOKEN missing" });
    const owner  = process.env.GH_OWNER  || "checkinnsaltillo-byte";
    const repo   = process.env.GH_REPO   || "checkin-app";
    const branch = process.env.GH_BRANCH || "main";
    const baseDir = "public/guia/data";

    // 1) Datos frescos desde Apps Script (Cloud Run → Apps Script SÍ funciona,
    //    a diferencia de GitHub Actions → Apps Script que Google bloquea).
    const payload = await callCheckinAppsScript("list_alojamientos");
    const rows = Array.isArray(payload && payload.rows) ? payload.rows : [];
    if (!rows.length) return res.status(502).json({ ok: false, error: "backend devolvió 0 rows" });

    const generatedAt = new Date().toISOString();
    const files = [];
    const summary = [];

    // Traer fotos de Lodgify por alojamiento (galería del botón "Ver fotos").
    // Guardamos las URLs junto al row para que el JSON estático las incluya —
    // así el móvil arma el lightbox sin depender de fetch a Google Cloud.
    const lodgifyKey = process.env.LODGIFY_API_KEY || "";
    async function fetchLodgifyPhotos(propertyId) {
      if (!lodgifyKey) return [];
      try {
        const r = await fetch(`https://api.lodgify.com/v2/properties/${encodeURIComponent(propertyId)}/rooms`, {
          headers: { "X-ApiKey": lodgifyKey, "accept": "application/json" },
        });
        if (!r.ok) return [];
        const rooms = await r.json();
        if (!Array.isArray(rooms)) return [];
        const photos = [];
        for (const room of rooms) {
          const imgs = Array.isArray(room && room.images) ? room.images : [];
          for (const im of imgs) {
            if (!im || !im.url) continue;
            // URL sin protocolo (//l.icdbcdn.com/...) — sacar ?f=32 para servir
            // el original grande en el lightbox (Lodgify sirve el ancho nativo).
            const clean = String(im.url).replace(/^\/\//, "https://").replace(/\?f=\d+$/i, "");
            photos.push({ url: clean, alt: String(im.text || "") });
          }
        }
        return photos;
      } catch (_) { return []; }
    }

    for (const row of rows) {
      const id = String(row.HouseId || row.HouseID || row.ID || "").trim();
      if (!id) continue;
      const photos = await fetchLodgifyPhotos(id);
      const rowWithPhotos = Object.assign({}, row, { photos });
      files.push({
        path: `${baseDir}/${id}.json`,
        content: JSON.stringify({ ok: true, generatedAt, rows: [rowWithPhotos] }),
      });
      summary.push({ id, name: row.HouseName || "", photos: photos.length });
    }
    files.push({
      path: `${baseDir}/index.json`,
      content: JSON.stringify({ ok: true, generatedAt, count: files.length, items: summary }, null, 2),
    });

    // 2) Git Data API — 1 commit atómico con todos los archivos.
    const gh = async (path, opts = {}) => {
      const r = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
        method: opts.method || "GET",
        headers: {
          "Authorization": `token ${ghToken}`,
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "ticket-vision-sync",
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const txt = await r.text();
      if (!r.ok) throw new Error(`GH ${opts.method || "GET"} ${path}: ${r.status} ${txt.slice(0,200)}`);
      return txt ? JSON.parse(txt) : {};
    };

    const ref = await gh(`/git/ref/heads/${branch}`);
    const parentSha = ref.object.sha;
    const parentCommit = await gh(`/git/commits/${parentSha}`);
    const baseTreeSha = parentCommit.tree.sha;

    // Crear blobs (uno por archivo)
    const treeEntries = [];
    for (const f of files) {
      const blob = await gh(`/git/blobs`, {
        method: "POST",
        body: { content: f.content, encoding: "utf-8" },
      });
      treeEntries.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
    }

    // Crear tree con base_tree para preservar el resto del repo
    const newTree = await gh(`/git/trees`, {
      method: "POST",
      body: { base_tree: baseTreeSha, tree: treeEntries },
    });

    // Si el árbol es idéntico al parent (nada cambió), no crear commit
    if (newTree.sha === baseTreeSha) {
      return res.json({ ok: true, changed: false, files: files.length, generatedAt });
    }

    const newCommit = await gh(`/git/commits`, {
      method: "POST",
      body: {
        message: `chore(guias): snapshot horario JSON ${generatedAt}`,
        tree: newTree.sha,
        parents: [parentSha],
      },
    });
    await gh(`/git/refs/heads/${branch}`, {
      method: "PATCH",
      body: { sha: newCommit.sha, force: false },
    });

    res.json({ ok: true, changed: true, files: files.length, commit: newCommit.sha, generatedAt });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Persistencia de cambios del catálogo "alojamientos" desde el panel admin
// de Guías de bienvenida.
app.post("/alojamientos/save", async (req, res) => {
  try {
    const payload = req.body?.payload || req.body || {};
    const result = await callCheckinAppsScriptPost("save_alojamiento", { payload });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/dispositivos-list", async (req, res) => {
  try {
    const result = await callCheckinAppsScript("list_dispositivos");
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

// ─── RECURSOS HUMANOS ────────────────────────────────────────────────────────
// Genérico: GET list → action sin payload; POST save → action con {payload}.
function rhMakeListEndpoint(action) {
  return async (req, res) => {
    try {
      const result = await callCheckinAppsScript(action);
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  };
}
function rhMakeSaveEndpoint(action) {
  return async (req, res) => {
    try {
      const payload = req.body?.payload || req.body || {};
      const result = await callCheckinAppsScriptPost(action, { payload });
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  };
}

// ─── INQUILINOS: perfiles + pagos + upload de contratos/fotos ─────────
app.get("/inquilinos", async (req, res) => {
  try { res.json(await callCheckinAppsScript("inquilinos_list")); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/inquilinos", async (req, res) => {
  try { res.json(await callCheckinAppsScriptPost("inquilinos_save", req.body || {})); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/inquilinos/delete", async (req, res) => {
  try { res.json(await callCheckinAppsScriptPost("inquilinos_delete", { ID: (req.body||{}).ID })); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/inquilinos/upload", async (req, res) => {
  try { res.json(await callCheckinAppsScriptPost("inquilinos_upload_file", req.body || {})); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.get("/inquilinos-pagos", async (req, res) => {
  try {
    const iid = String(req.query.inquilino_id || '').trim();
    const params = iid ? { inquilino_id: iid } : {};
    res.json(await callCheckinAppsScript("inquilinos_pagos_list", params));
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/inquilinos-pagos", async (req, res) => {
  try { res.json(await callCheckinAppsScriptPost("inquilinos_pagos_save", req.body || {})); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/inquilinos-pagos/delete", async (req, res) => {
  try { res.json(await callCheckinAppsScriptPost("inquilinos_pagos_delete", { ID: (req.body||{}).ID })); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Inventarios ────────────────────────────────────────────────────────
app.get("/inventarios/productos", async (_req, res) => {
  try { res.json(await callCheckinAppsScriptPost("inventarios_productos_list", {})); }
  catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});
app.post("/inventarios/productos", async (req, res) => {
  try { res.json(await callCheckinAppsScriptPost("inventarios_producto_save", req.body || {})); }
  catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});
app.post("/inventarios/productos/delete", async (req, res) => {
  try { res.json(await callCheckinAppsScriptPost("inventarios_producto_delete", { ID: (req.body||{}).ID })); }
  catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});
app.post("/inventarios/productos/upload", async (req, res) => {
  try { res.json(await callCheckinAppsScriptPost("inventarios_producto_upload", req.body || {})); }
  catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});
app.get("/inventarios/stock", async (req, res) => {
  try {
    const iid = String(req.query.producto_id || '').trim();
    res.json(await callCheckinAppsScriptPost("inventarios_stock_list", iid ? { producto_id: iid } : {}));
  } catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});
app.post("/inventarios/stock", async (req, res) => {
  try { res.json(await callCheckinAppsScriptPost("inventarios_stock_save", req.body || {})); }
  catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});
app.post("/inventarios/stock/delete", async (req, res) => {
  try { res.json(await callCheckinAppsScriptPost("inventarios_stock_delete", { ID: (req.body||{}).ID })); }
  catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});
app.post("/inventarios/movimiento", async (req, res) => {
  try { res.json(await callCheckinAppsScriptPost("inventarios_movimiento_save", req.body || {})); }
  catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});
app.get("/inventarios/movimientos", async (req, res) => {
  try {
    const filters = {};
    if (req.query.stock_id) filters.stock_id = String(req.query.stock_id);
    if (req.query.producto_id) filters.producto_id = String(req.query.producto_id);
    res.json(await callCheckinAppsScriptPost("inventarios_movimientos_list", filters));
  } catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});
app.get("/inventarios/ordenes", async (_req, res) => {
  try { res.json(await callCheckinAppsScriptPost("inventarios_ordenes_list", {})); }
  catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});
app.post("/inventarios/ordenes", async (req, res) => {
  try { res.json(await callCheckinAppsScriptPost("inventarios_orden_save", req.body || {})); }
  catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});
app.post("/inventarios/ordenes/delete", async (req, res) => {
  try { res.json(await callCheckinAppsScriptPost("inventarios_orden_delete", { ID: (req.body||{}).ID })); }
  catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});

app.get("/rh/empleados",      rhMakeListEndpoint("rh_list_empleados"));
app.post("/rh/empleados",     rhMakeSaveEndpoint("rh_save_empleado"));
app.get("/rh/asistencia",     rhMakeListEndpoint("rh_list_asistencia"));
app.post("/rh/asistencia",    rhMakeSaveEndpoint("rh_save_asistencia"));
app.get("/rh/ausencias",      rhMakeListEndpoint("rh_list_ausencias"));
app.post("/rh/ausencias",     rhMakeSaveEndpoint("rh_save_ausencia"));
app.get("/rh/compensaciones", rhMakeListEndpoint("rh_list_compensaciones"));
app.post("/rh/compensaciones", rhMakeSaveEndpoint("rh_save_compensacion"));
function rhMakeDeleteEndpoint(action) {
  return async (req, res) => {
    try {
      const id = req.params.id;
      const result = await callCheckinAppsScriptPost(action, { payload: { ID: id } });
      res.json(result);
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  };
}
app.delete("/rh/compensaciones/:id", rhMakeDeleteEndpoint("rh_delete_compensacion"));
app.delete("/rh/asistencia/:id",     rhMakeDeleteEndpoint("rh_delete_asistencia"));
app.delete("/rh/ausencias/:id",      rhMakeDeleteEndpoint("rh_delete_ausencia"));

// Obligaciones (cuotas IMSS + recibos de nómina por empleado)
app.get("/rh/obligaciones", async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || (new Date()).getFullYear();
    const result = await callCheckinAppsScriptPost("rh_list_obligaciones", { year });
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.get("/rh/obligacion/totales", async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || (new Date()).getFullYear();
    const result = await callCheckinAppsScriptPost("rh_list_obligacion_totales", { year });
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/rh/obligacion/total", async (req, res) => {
  try {
    const b = req.body || {};
    const result = await callCheckinAppsScriptPost("rh_set_obligacion_total", {
      year: b.year, month: b.month, total: b.total,
    });
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/rh/obligacion/delete", async (req, res) => {
  try {
    const fileId = String(req.body?.fileId || '').trim();
    if (!fileId) return res.status(400).json({ ok: false, error: 'Falta fileId' });
    const result = await callCheckinAppsScriptPost("rh_delete_obligacion", { fileId });
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/rh/obligacion/upload", async (req, res) => {
  try {
    const b = req.body || {};
    const result = await callCheckinAppsScriptPost("rh_upload_obligacion", {
      year: b.year, month: b.month, kind: b.kind,
      empleadoId: b.empleadoId || '', empleadoNombre: b.empleadoNombre || '',
      file: b.file || null,
    });
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post("/sys/login", async (req, res) => {
  try {
    const result = await callCheckinAppsScriptPost("sys_login", { payload: req.body || {} });
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Actualizar una incidencia existente ─────────────────────────────────────
// Acepta: { id, fields, fotos?: [{name,base64,mimeType}], keepUrls?: [string] }
// Si vienen fotos nuevas: las sube a Drive vía Apps Script y compone el CSV
// final Fotos_URLs = keepUrls + nuevas URLs subidas, que se inyecta en fields.
app.post("/update-incidencia", async (req, res) => {
  try {
    const id = String(req.body?.id || '').trim();
    const fields = Object.assign({}, req.body?.fields || {});
    const newFotos = Array.isArray(req.body?.fotos) ? req.body.fotos : null;
    const keepUrls = Array.isArray(req.body?.keepUrls) ? req.body.keepUrls : null;
    if (!id) return res.status(400).json({ ok: false, error: 'Falta id' });
    let finalUrls = null;
    if (newFotos !== null || keepUrls !== null) {
      // El frontend está controlando las fotos → calcular el CSV final
      const uploaded = [];
      for (const f of (newFotos || [])) {
        if (!f || !f.base64) continue;
        const up = await callCheckinAppsScriptPost("upload_incidencia_image", {
          fecha: fields.fecha || '',
          alojamiento: fields.alojamiento || '',
          file: { fileName: f.name || 'foto.jpg', mimeType: f.mimeType || 'image/jpeg', base64: f.base64 },
        });
        if (up && up.ok && up.url) uploaded.push(up.url);
        else console.warn("update_incidencia: foto fallida", JSON.stringify(up).slice(0, 300));
      }
      finalUrls = (keepUrls || []).concat(uploaded);
      fields.fotos_urls = finalUrls.join(', ');
      fields.fotos_count = finalUrls.length;
    }
    const result = await callCheckinAppsScriptPost("update_incidencia", {
      payload: { id, fields },
    });
    if (!result || !result.ok) throw new Error(result?.error || 'Apps Script update error');
    if (finalUrls !== null) {
      result.fotos_urls = fields.fotos_urls;
      result.fotos_count = fields.fotos_count;
    }
    res.json(result);
  } catch (err) {
    console.error("update_incidencia_error", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── OBJETOS OLVIDADOS — paralelo a Incidencias ──────────────────────────────
app.get("/objetos-list", async (req, res) => {
  try {
    const result = await callCheckinAppsScript("list_objetos");
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/save-objeto", async (req, res) => {
  try {
    const payload = req.body?.payload || {};
    const fotos = Array.isArray(req.body?.fotos) ? req.body.fotos : [];
    const fotosUrls = [];
    for (const f of fotos) {
      if (!f || !f.base64) continue;
      const up = await callCheckinAppsScriptPost("upload_objeto_image", {
        fecha: payload.fecha_encontrado || '',
        alojamiento: payload.alojamiento || '',
        file: { fileName: f.name || 'foto.jpg', mimeType: f.mimeType || 'image/jpeg', base64: f.base64 },
      });
      if (up && up.ok && up.url) fotosUrls.push(up.url);
      else console.warn("save_objeto: foto fallida", JSON.stringify(up).slice(0, 300));
    }
    const saveResult = await callCheckinAppsScriptPost("save_objeto", {
      payload: { ...payload, fotos_urls: fotosUrls },
    });
    if (!saveResult || !saveResult.ok) throw new Error(saveResult?.error || 'Apps Script save error');
    res.json({ ok: true, id: saveResult.id, timestamp: saveResult.timestamp, fotos_uploaded: fotosUrls.length });
  } catch (err) {
    console.error("save_objeto_error", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/update-objeto", async (req, res) => {
  try {
    const id = String(req.body?.id || '').trim();
    const fields = Object.assign({}, req.body?.fields || {});
    const newFotos = Array.isArray(req.body?.fotos) ? req.body.fotos : null;
    const keepUrls = Array.isArray(req.body?.keepUrls) ? req.body.keepUrls : null;
    if (!id) return res.status(400).json({ ok: false, error: 'Falta id' });
    let finalUrls = null;
    if (newFotos !== null || keepUrls !== null) {
      const uploaded = [];
      for (const f of (newFotos || [])) {
        if (!f || !f.base64) continue;
        const up = await callCheckinAppsScriptPost("upload_objeto_image", {
          fecha: fields.fecha_encontrado || '',
          alojamiento: fields.alojamiento || '',
          file: { fileName: f.name || 'foto.jpg', mimeType: f.mimeType || 'image/jpeg', base64: f.base64 },
        });
        if (up && up.ok && up.url) uploaded.push(up.url);
      }
      finalUrls = (keepUrls || []).concat(uploaded);
      fields.fotos_urls = finalUrls.join(', ');
      fields.fotos_count = finalUrls.length;
    }
    const result = await callCheckinAppsScriptPost("update_objeto", { payload: { id, fields } });
    if (!result || !result.ok) throw new Error(result?.error || 'Apps Script update error');
    if (finalUrls !== null) {
      result.fotos_urls = fields.fotos_urls;
      result.fotos_count = fields.fotos_count;
    }
    res.json(result);
  } catch (err) {
    console.error("update_objeto_error", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Listar reportes de incidencias guardados ────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
// ║ REPORTES TÉCNICOS (MVP F1) — passthrough a Apps Script                  ║
// ═══════════════════════════════════════════════════════════════════════════
app.get("/reportes-tecnicos-list", async (req, res) => {
  try {
    const r = await callCheckinAppsScriptPost("rt_list", {});
    res.json(r);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/reportes-tecnicos-upsert", async (req, res) => {
  try {
    const payload = req.body?.payload || {};
    const fotosAntes = Array.isArray(req.body?.fotos_antes) ? req.body.fotos_antes : [];
    const fotosDespues = Array.isArray(req.body?.fotos_despues) ? req.body.fotos_despues : [];
    const uploadAll = async (list) => {
      const urls = [];
      for (const f of list) {
        if (!f || !f.base64) continue;
        const up = await callCheckinAppsScriptPost("rt_upload_image", {
          name: f.name || `rt_${Date.now()}.jpg`,
          mimeType: f.mimeType || "image/jpeg",
          base64: f.base64,
        });
        if (up && up.ok && up.url) urls.push(up.url);
        else console.warn("rt upload failed:", JSON.stringify(up).slice(0, 200));
      }
      return urls;
    };
    const antes = await uploadAll(fotosAntes);
    const despues = await uploadAll(fotosDespues);
    // Preservar URLs previas si vienen (edición) + append de nuevas.
    // Solo tocar Fotos_*_urls si el payload las trae o si hay fotos nuevas —
    // patches parciales (ej. cambio de Fecha) NO deben borrar fotos existentes.
    const prevAntes = String(payload.Fotos_antes_urls || "").split(",").map(s => s.trim()).filter(Boolean);
    const prevDespues = String(payload.Fotos_despues_urls || "").split(",").map(s => s.trim()).filter(Boolean);
    const finalPayload = { ...payload };
    if (antes.length || "Fotos_antes_urls" in payload) {
      finalPayload.Fotos_antes_urls = [...prevAntes, ...antes].join(",");
    }
    if (despues.length || "Fotos_despues_urls" in payload) {
      finalPayload.Fotos_despues_urls = [...prevDespues, ...despues].join(",");
    }
    const r = await callCheckinAppsScriptPost("rt_upsert", finalPayload);
    if (!r || !r.ok) throw new Error(r?.error || "upsert failed");
    res.json({ ...r, fotos_antes_uploaded: antes.length, fotos_despues_uploaded: despues.length });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/reportes-tecnicos-delete", async (req, res) => {
  try {
    const id = String(req.body?.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "id requerido" });
    const r = await callCheckinAppsScriptPost("rt_delete", { id });
    res.json(r);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

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
// Llama directo a Lodgify v2 /reservations/bookings — devuelve TODAS las
// reservas incluyendo manuales sin presupuesto (que /api/otc omite).
// Formato de salida = mismo shape que /api/otc para drop-in del Apps Script.
const _lodgifyBookingsCache = new Map();
app.get("/lodgify-bookings-all", async (req, res) => {
  try {
    const apiKey = process.env.LODGIFY_API_KEY;
    if (!apiKey) return res.status(500).json({ ok:false, error:"LODGIFY_API_KEY no configurada" });
    const from = String(req.query.from || "").slice(0,10);
    const to   = String(req.query.to   || "").slice(0,10);
    if (!from || !to) return res.status(400).json({ ok:false, error:"params from y to son requeridos (YYYY-MM-DD)" });
    const cacheKey = `${from}|${to}`;
    const now = Date.now();
    const cached = _lodgifyBookingsCache.get(cacheKey);
    if (cached && (now - cached.ts) < 60_000) return res.json({ ok:true, rows: cached.rows, cached:true });

    // Lodgify v2 /reservations/bookings: pagina y filtra por updatedSince para
    // traer solo las reservas modificadas/creadas recientemente. El "from" del
    // request se mapea a updatedSince (ej. desde hace 90 días).
    // size=100 (max permitido), page hasta agotar.
    const updatedSince = req.query.updatedSince || from; // YYYY-MM-DD
    const items = [];
    let page = 1;
    let hasMore = true;
    const MAX_PAGES = 100;
    while (hasMore && page <= MAX_PAGES) {
      const url = `https://api.lodgify.com/v2/reservations/bookings?stayFilter=All&page=${page}&size=100&includeCount=true&updatedSince=${encodeURIComponent(updatedSince)}T00:00:00`;
      const r = await fetch(url, { headers: { "X-ApiKey": apiKey, accept:"application/json" }});
      if (!r.ok) {
        const txt = await r.text();
        return res.status(502).json({ ok:false, error:`Lodgify HTTP ${r.status}`, raw: txt.slice(0,300) });
      }
      const j = await r.json();
      const pageItems = j.items || j.Items || [];
      items.push(...pageItems);
      hasMore = pageItems.length === 100;
      page++;
    }
    // Filtra por rango de fechas de estancia (arrival entre from y to+buffer)
    const fromTs = new Date(from + 'T00:00:00').getTime();
    const toTs = new Date(to + 'T23:59:59').getTime();
    const inRange = items.filter(b => {
      const arr = b.arrival ? new Date(b.arrival).getTime() : 0;
      const dep = b.departure ? new Date(b.departure).getTime() : 0;
      // Reserva toca el rango si dep >= fromTs && arr <= toTs
      if (!arr && !dep) return false;
      return (dep || arr) >= fromTs && (arr || dep) <= toTs;
    });
    // Para el aggregateLodgifyRows_ usamos las filtradas; el cliente paginará todo si quiere
    items.length = 0;
    items.push(...inRange);

    // Convierte cada booking → 1+ "rows" con el shape que aggregateLodgifyRows_
    // del Apps Script espera (mismo que /api/otc).
    const rows = [];
    const fmtDate = (s) => {
      if (!s) return "";
      const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
      return m ? `${m[2]}/${m[3]}/${m[1]}` : String(s);
    };
    function _normalizeSource(b) {
      // Lodgify v2: b.source puede ser "Manual", "Lodgify", o un JSON string con
      // metadata cuando la reserva vino de un OTA externo (Airbnb, Booking, etc.).
      const raw = b.source_text || b.source || "";
      if (!raw) return "";
      const s = String(raw);
      // Si parece JSON con listingId → es OTA. Tratamos de identificar cuál
      // por el campo `channel` o `channel_booking_id` o por la presencia de
      // confirmationCode tipo "HMxxx" (Airbnb usa códigos así).
      if (s.startsWith("{") && s.includes("listingId")) {
        try {
          const meta = JSON.parse(s);
          const cc = String(meta.confirmationCode || "");
          // Heurística: Airbnb confirmation codes empiezan con "HM"
          if (cc.startsWith("HM")) return "Airbnb";
          // Pista por channel_booking_id en el booking raíz
          const cbi = String(b.channel_booking_id || "");
          if (cbi.startsWith("HM")) return "Airbnb";
          if (/booking\.com|booking_com/i.test(cbi)) return "Booking.com";
          if (/vrbo/i.test(cbi)) return "Vrbo";
          if (/expedia/i.test(cbi)) return "Expedia";
          // Por defecto si tiene listingId asumimos Airbnb (caso más común)
          return "Airbnb";
        } catch (_) { return s.slice(0, 30); }
      }
      // Limpia URLs como "www.check-inn-saltillo.com" → "Direct"
      if (/check-inn-saltillo|checkinnsaltillo/i.test(s)) return "Direct";
      return s;
    }
    for (const b of items) {
      const room = (b.rooms && b.rooms[0]) || {};
      const guest = (b.guest) || {};
      const baseRow = {
        Id: b.id,
        Source: _normalizeSource(b),
        SourceText: JSON.stringify({ confirmationCode: b.confirmation_code || "", listingId: b.listing_id || "", threadId: b.thread_id || "" }),
        ChannelBooking: b.channel_booking_id || "",
        Status: b.status || "",
        DateCancelled: b.date_cancelled || "",
        DateArrival: fmtDate(b.arrival),
        DateDeparture: fmtDate(b.departure),
        Nights: Number(b.nights) || 0,
        HouseName: room.name || room.room_type_name || "",
        HouseId: b.property_id || room.property_id || "",
        RoomTypeNames: room.room_type_name || "",
        RoomTypeIds: room.room_type_id || "",
        GuestName: guest.name || guest.display_name || "",
        GuestEmail: guest.email || "",
        GuestPhone: guest.phone || "",
        GuestCountryCode: guest.country_code || "",
        NumberOfGuests: Number(b.people) || 0,
        Adults: Number(room.people) || Number(b.people) || 0,
        Children: 0,
        Infants: 0,
        Pets: 0,
        Currency: b.currency_code || "MXN",
      };
      const tx = Array.isArray(b.quote && b.quote.amounts_breakdown) ? b.quote.amounts_breakdown
              : Array.isArray(b.amount_breakdown) ? b.amount_breakdown
              : Array.isArray(b.transactions) ? b.transactions : [];
      if (!tx.length) {
        // Reserva sin presupuesto/line-items — emite UNA fila con totales en 0
        rows.push({ ...baseRow, LineItem: "", LineItemDescription: "", GrossAmount: Number(b.total_amount) || 0, NetAmount: 0, VatAmount: 0 });
      } else {
        for (const t of tx) {
          rows.push({
            ...baseRow,
            LineItem: t.type || t.kind || "",
            LineItemDescription: t.description || t.note || "",
            GrossAmount: Number(t.gross_amount ?? t.amount ?? t.gross) || 0,
            NetAmount: Number(t.net_amount ?? t.net) || 0,
            VatAmount: Number(t.vat_amount ?? t.vat) || 0,
          });
        }
      }
    }

    _lodgifyBookingsCache.set(cacheKey, { ts: now, rows });
    res.json({ ok:true, rows, totalBookings: items.length });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// Cache server-side de la lista completa (60s TTL) + filtro por rango fechas
// para evitar transferir 8.7 MB cada vez. Frontend puede pasar from/to (YYYY-MM-DD).
const _lodgifyListCache = { ts: 0, payload: null };
// Normaliza un Source contaminado con JSON blob (de syncs anteriores que
// guardaron mal el campo) a una etiqueta legible: Airbnb / Booking.com / Direct
function _normalizeBookingSource(b) {
  const raw = b && b.Source;
  if (raw == null) return "";
  const s = String(raw);
  if (!s.startsWith("{")) {
    if (/check-inn-saltillo|checkinnsaltillo/i.test(s)) return "Direct";
    return s;
  }
  try {
    const meta = JSON.parse(s);
    const cc = String(meta.confirmationCode || "");
    if (cc.startsWith("HM")) return "Airbnb";
    if (/booking/i.test(cc)) return "Booking.com";
    if (/vrbo/i.test(cc))    return "Vrbo";
    if (/expedia/i.test(cc)) return "Expedia";
    // Si tiene listingId pero no codeshipping, asumimos Airbnb (caso más común)
    if (meta.listingId) return "Airbnb";
    return "Other";
  } catch (_) { return "Other"; }
}
// ═══════════════════════════════════════════════════════════════════════════
// GET /lodgify-availability
// Consulta disponibilidad + precio para TODAS las propiedades activas usando
// la Lodgify API v2 (endpoint /v2/quote). Retorna solo las que están disponibles.
//
// Query params:
//   arrival    (YYYY-MM-DD)  requerido
//   departure  (YYYY-MM-DD)  requerido
//   guests     (int)         default 1
//
// Response:
//   {
//     ok, arrival, departure, guests, queried, available: [
//       { propertyId, propertyName, roomTypeId, price, currency, nights,
//         capacity, checkoutUrl, propertyUrl }
//     ], errors: [ { propertyId, message } ]
//   }
//
// Cache de roomTypeId por propertyId (permanente en memoria del proceso).
// ═══════════════════════════════════════════════════════════════════════════
const _lodgifyRoomTypeCache = new Map(); // propertyId → { roomTypeId, capacity, propertyName }
const _lodgifyAvailCache = new Map();    // key(arrival|departure|guests) → { ts, payload }

app.get("/lodgify-availability", async (req, res) => {
  try {
    const apiKey = process.env.LODGIFY_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: "LODGIFY_API_KEY faltante" });
    const arrival = String(req.query.arrival || "").trim();
    const departure = String(req.query.departure || "").trim();
    const guests = Math.max(1, parseInt(String(req.query.guests || "1"), 10) || 1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(arrival) || !/^\d{4}-\d{2}-\d{2}$/.test(departure)) {
      return res.status(400).json({ ok: false, error: "arrival/departure YYYY-MM-DD requeridos" });
    }
    if (new Date(arrival) >= new Date(departure)) {
      return res.status(400).json({ ok: false, error: "departure debe ser posterior a arrival" });
    }

    // Cache 5 min
    const cacheKey = `${arrival}|${departure}|${guests}`;
    const cached = _lodgifyAvailCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < 5 * 60_000) {
      return res.json({ ok: true, cached: true, ...cached.payload });
    }

    // 1. Obtener lista de propiedades activas del catálogo local
    //    (usamos alojamientos-list pasando por Apps Script)
    let alojRows = [];
    try {
      const alojR = await callCheckinAppsScript("alojamientos_list", {});
      alojRows = (alojR && alojR.rows) || [];
    } catch (e) {
      return res.status(500).json({ ok: false, error: "alojamientos_list falló: " + e.message });
    }
    const properties = alojRows
      .filter(r => r && r.HouseId && String(r.HouseId).trim())
      .map(r => ({
        propertyId: String(r.HouseId).trim(),
        propertyName: `${r.Propiedad || ""} #${r["# Departamento"] || ""}`.trim(),
      }));
    if (!properties.length) {
      return res.status(500).json({ ok: false, error: "Sin propiedades con HouseId en el catálogo" });
    }

    // 2. Para cada propiedad, obtener roomTypeId (cache) y luego consultar quote.
    const lodgifyHeaders = { "X-ApiKey": apiKey, "accept": "application/json" };

    async function ensureRoomTypeId(propertyId) {
      const c = _lodgifyRoomTypeCache.get(propertyId);
      if (c) return c;
      const r = await fetch(`https://api.lodgify.com/v2/properties/${encodeURIComponent(propertyId)}/rooms`, { headers: lodgifyHeaders });
      if (!r.ok) throw new Error(`rooms HTTP ${r.status}`);
      const rooms = await r.json();
      if (!Array.isArray(rooms) || !rooms.length) throw new Error("sin rooms");
      const first = rooms[0];
      const info = {
        roomTypeId: String(first.id || first.Id || ""),
        capacity: Number(first.max_people || first.Max_People || first.people || 1),
      };
      if (!info.roomTypeId) throw new Error("sin roomTypeId");
      _lodgifyRoomTypeCache.set(propertyId, info);
      return info;
    }

    async function fetchQuote(propertyId, roomTypeId) {
      // Endpoint quote: GET /v2/quote/{propertyId}?RoomTypes[0].Id=X&RoomTypes[0].People=N&Arrival=Y&Departure=Z
      const qs = new URLSearchParams();
      qs.set("Arrival", arrival);
      qs.set("Departure", departure);
      qs.set("RoomTypes[0].Id", roomTypeId);
      qs.set("RoomTypes[0].People", String(guests));
      const url = `https://api.lodgify.com/v2/quote/${encodeURIComponent(propertyId)}?${qs.toString()}`;
      const r = await fetch(url, { headers: lodgifyHeaders });
      const text = await r.text();
      if (r.status === 400 || r.status === 404) return { available: false, reason: text.slice(0, 100) };
      if (!r.ok) throw new Error(`quote HTTP ${r.status}: ${text.slice(0, 100)}`);
      const arr = JSON.parse(text);
      const q = Array.isArray(arr) ? arr[0] : arr;
      if (!q) return { available: false, reason: "empty quote" };
      const total = Number(q.total_including_vat || q.total || q.Total || 0);
      const currency = String(q.currency_code || q.Currency || q.currency || "MXN");
      return { available: total > 0, total, currency };
    }

    // Throttle: max 10 concurrent
    const concurrency = 10;
    const results = [];
    const errors = [];
    const queue = properties.slice();
    async function worker() {
      while (queue.length) {
        const p = queue.shift();
        try {
          const rt = await ensureRoomTypeId(p.propertyId);
          const q = await fetchQuote(p.propertyId, rt.roomTypeId);
          if (q.available) {
            const nights = Math.round((new Date(departure) - new Date(arrival)) / 86400000);
            results.push({
              propertyId: p.propertyId,
              propertyName: p.propertyName,
              roomTypeId: rt.roomTypeId,
              capacity: rt.capacity,
              price: q.total,
              currency: q.currency,
              nights,
              // URL público con dates pre-llenadas (formato Lodgify booknow)
              checkoutUrl: `https://checkout.lodgify.com/es/check-inn/booknow?PropertyId=${encodeURIComponent(p.propertyId)}&Arrival=${arrival}&Departure=${departure}&RoomTypes[0].Id=${encodeURIComponent(rt.roomTypeId)}&RoomTypes[0].People=${guests}`,
            });
          }
        } catch (e) {
          errors.push({ propertyId: p.propertyId, propertyName: p.propertyName, message: e.message });
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));

    // Ordenar por precio asc
    results.sort((a, b) => a.price - b.price);

    const payload = {
      arrival, departure, guests,
      queried: properties.length,
      available: results,
      errors,
    };
    _lodgifyAvailCache.set(cacheKey, { ts: Date.now(), payload });
    res.json({ ok: true, cached: false, ...payload });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.get("/lodgify-list", async (req, res) => {
  try {
    const TTL = 60_000;
    const now = Date.now();
    let payload = _lodgifyListCache.payload;
    if (!payload || (now - _lodgifyListCache.ts) > TTL) {
      const params = {
        source: req.query.source || "",
        status: req.query.status || "",
        name_contains: req.query.name_contains || "",
        limit: req.query.limit || "",
      };
      payload = await callCheckinAppsScript("lodgify_list", params);
      if (payload && payload.ok && Array.isArray(payload.bookings)) {
        // Limpia Sources contaminados con JSON blob de syncs previos
        payload.bookings.forEach(b => { if (b) b.Source = _normalizeBookingSource(b); });
        _lodgifyListCache.ts = now;
        _lodgifyListCache.payload = payload;
      }
    }
    // Filtra por rango de estancia si vienen from/to
    const from = String(req.query.from || "").slice(0,10);
    const to   = String(req.query.to   || "").slice(0,10);
    if ((from || to) && payload && payload.ok && Array.isArray(payload.bookings)) {
      const fromTs = from ? new Date(from + "T00:00:00").getTime() : -Infinity;
      const toTs   = to   ? new Date(to   + "T23:59:59").getTime() :  Infinity;
      const _parse = (s) => {
        if (!s) return 0;
        const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m) return new Date(+m[3], +m[1]-1, +m[2]).getTime();
        const t = Date.parse(s);
        return isFinite(t) ? t : 0;
      };
      const filtered = payload.bookings.filter(b => {
        const arr = _parse(b.DateArrival);
        const dep = _parse(b.DateDeparture);
        if (!arr && !dep) return false;
        // Que el rango de estancia TOQUE el rango pedido
        return (dep || arr) >= fromTs && (arr || dep) <= toTs;
      });
      return res.json({ ...payload, bookings: filtered, total: filtered.length, cached: true });
    }
    res.json(payload);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /perfiles-kpis-list
// Devuelve { phone10 → { noches, visitas, monto, updated_at } } leyendo los
// KPIs pre-computados de la hoja Perfiles. Cache 5 min.
// ═══════════════════════════════════════════════════════════════════════════
const _perfilesKpisCache = { ts: 0, payload: null };
app.get("/perfiles-kpis-list", async (req, res) => {
  try {
    const now = Date.now();
    if (_perfilesKpisCache.payload && (now - _perfilesKpisCache.ts) < 5 * 60_000) {
      return res.json({ ok: true, cached: true, ...(_perfilesKpisCache.payload) });
    }
    // perfiles_kpis en Apps Script devuelve el mapa ligero {by_phone, total}
    const url = `${CHECKIN_APPS_SCRIPT_URL}?action=perfiles_kpis`;
    const r = await fetch(url);
    const text = await r.text();
    const j = JSON.parse(text);
    if (!j.ok) {
      return res.status(500).json({ ok: false, error: j.error || "perfiles_kpis falló" });
    }
    const payload = { by_phone: j.by_phone || {}, total: j.total || 0 };
    _perfilesKpisCache.ts = now;
    _perfilesKpisCache.payload = payload;
    res.json({ ok: true, cached: false, ...payload });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /perfiles-recalc-kpis  (llamado por Cloud Scheduler diario ~03:00)
// Recalcula kpi_noches/kpi_visitas/kpi_monto en hoja Perfiles a partir de
// Reservas_Lodgify Status=Booked. Evita que Gestión de reservas recompute
// KPIs en cada carga.
// ═══════════════════════════════════════════════════════════════════════════
app.post("/perfiles-recalc-kpis", async (req, res) => {
  try {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 3 * 60 * 1000);
    const r = await fetch(CHECKIN_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "perfiles_recalc_kpis" }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(tm));
    const text = await r.text();
    try { res.json(JSON.parse(text)); }
    catch { res.status(500).json({ ok: false, error: "Respuesta no-JSON del Apps Script: " + text.slice(0, 200) }); }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /bookings-by-guest?phone=<10dig>
// Devuelve historial COMPLETO de bookings del huésped (sin filtro fecha).
// Usado on-demand al expandir una card en Gestión de reservas.
// ═══════════════════════════════════════════════════════════════════════════
app.get("/bookings-by-guest", async (req, res) => {
  try {
    const phone = String(req.query.phone || "").replace(/\D/g, "");
    if (phone.length < 10) return res.status(400).json({ ok: false, error: "phone (10+ dígitos) requerido" });
    const url = `${CHECKIN_APPS_SCRIPT_URL}?action=bookings_by_guest&phone=${encodeURIComponent(phone)}`;
    const r = await fetch(url);
    const text = await r.text();
    try { res.json(JSON.parse(text)); }
    catch { res.status(500).json({ ok: false, error: "Respuesta no-JSON del Apps Script: " + text.slice(0, 200) }); }
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

// ─── Update bulk de filas en BANCOS (edición desde Efectivo) ────────────────
app.post("/bn/update-rows", async (req, res) => {
  try {
    const updates = req.body?.updates || [];
    if (!Array.isArray(updates) || !updates.length) throw new Error('updates vacío');
    const result = await callAppsScript({ action: "bn_update_rows_bulk", updates });
    if (!result.ok) throw new Error(result.error || "Apps Script error");
    res.json({ ok: true, written: result.written });
  } catch (err) {
    console.error("bn_update_rows_error", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Delete single row en BANCOS (desde Efectivo, botón ✕) ─────────────────
app.post("/bn/delete-row", async (req, res) => {
  try {
    const rowNum = Number(req.body?.rowNum);
    if (!rowNum || rowNum < 2) throw new Error('rowNum inválido');
    const result = await callAppsScript({ action: "bn_bancos_delete_row", rowNum });
    if (!result.ok) throw new Error(result.error || "Apps Script error");
    res.json({ ok: true, deleted: result.deleted });
  } catch (err) {
    console.error("bn_delete_row_error", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Persistir matches Banco↔Ticket en columnas de BANCOS ───────────────────

app.post("/bn/set-ticket-matches", async (req, res) => {
  try {
    const updates = req.body?.updates || [];
    if (!Array.isArray(updates) || !updates.length) throw new Error('updates vacío');
    const result = await callAppsScript({
      action: "bn_set_ticket_matches_bulk",
      updates,
    });
    if (!result.ok) throw new Error(result.error || "Apps Script error");
    res.json({ ok: true, written: result.written });
  } catch (err) {
    console.error("bn_set_ticket_matches_error", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Enviar ticket emitido en Facturapi por correo ──────────────────────────
// Necesita env vars FACTURAPI_SECRET_KEY_ORG1 y/o FACTURAPI_SECRET_KEY_ORG2
// configurados en Cloud Run. Sin ellos, devuelve error claro.
app.post("/facturapi/send-email", async (req, res) => {
  try {
    const { folio, email, org, kind } = req.body || {};
    if (!folio) throw new Error('folio requerido');
    const orgN = String(org || '2');
    const key = orgN === '1'
      ? (process.env.FACTURAPI_SECRET_KEY_ORG1 || process.env.FACTURAPI_SECRET_KEY)
      : (process.env.FACTURAPI_SECRET_KEY_ORG2 || process.env.FACTURAPI_SECRET_KEY);
    if (!key) throw new Error('FACTURAPI_SECRET_KEY no configurada en Cloud Run (org ' + orgN + ')');
    const auth = 'Basic ' + Buffer.from(key + ':').toString('base64');
    // Puede ser una FACTURA (invoice) o un RECIBO (receipt). Los recibos son
    // los "tickets" que se generan para inquilinos — viven en un endpoint
    // distinto. Estrategia: si viene kind='receipt' probamos receipts primero;
    // en cualquier otro caso probamos invoices y caemos a receipts si no
    // hay match. Permite mantener compatibilidad con reservas (invoices) y
    // agregar soporte para recibos de inquilinos sin cambiar el frontend.
    async function searchAt(collection) {
      const url = `https://www.facturapi.io/v2/${collection}?folio_number=${encodeURIComponent(folio)}&limit=1`;
      const r = await fetch(url, { headers: { 'Authorization': auth } });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`Facturapi search ${collection} ${r.status}: ${t.slice(0, 200)}`);
      }
      const j = await r.json();
      return { hit: (j?.data || [])[0] || null };
    }
    const primary = String(kind || '').toLowerCase() === 'receipt' ? 'receipts' : 'invoices';
    const fallback = primary === 'receipts' ? 'invoices' : 'receipts';
    let collection = primary;
    let { hit } = await searchAt(primary);
    if (!hit) {
      const other = await searchAt(fallback);
      hit = other.hit;
      if (hit) collection = fallback;
    }
    if (!hit) throw new Error(`No se encontró invoice ni receipt con folio ${folio} en Facturapi`);
    // La API acepta { email: [string] } para sobrescribir; sin body usa el
    // del cliente. Endpoint distinto según sea recibo o factura.
    const body = email ? JSON.stringify({ email: [email] }) : '{}';
    const eResp = await fetch(`https://www.facturapi.io/v2/${collection}/${hit.id}/email`, {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
      body,
    });
    if (!eResp.ok) {
      const t = await eResp.text().catch(() => '');
      throw new Error(`Facturapi send ${collection} ${eResp.status}: ${t.slice(0, 200)}`);
    }
    res.json({
      ok: true, sent_to: email || (hit.customer?.email || ''),
      resource_id: hit.id, folio, kind: collection === 'receipts' ? 'receipt' : 'invoice',
    });
  } catch (err) {
    console.error("facturapi_send_email_error", err.message);
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

// ─── Tuya Cloud (Smart Life) ──────────────────────────────────────────────
// Devices view-only: lista por Home/Room + historial de eventos.
// Secretos en env vars: TUYA_ACCESS_ID, TUYA_ACCESS_SECRET, TUYA_UID, TUYA_REGION.
// Firma v2: ver https://developer.tuya.com/en/docs/iot/new-singnature

const crypto = require("crypto");

const TUYA_HOSTS = {
  wa: "https://openapi.tuyaus.com",
  ue: "https://openapi-ueaz.tuyaus.com",
  eu: "https://openapi.tuyaeu.com",
  weu: "https://openapi-weaz.tuyaeu.com",
  in: "https://openapi.tuyain.com",
  cn: "https://openapi.tuyacn.com",
  sg: "https://openapi.tuyasg.com",
};
const TUYA_HOST = TUYA_HOSTS[process.env.TUYA_REGION || "wa"] || TUYA_HOSTS.wa;
const TUYA_ID = process.env.TUYA_ACCESS_ID || "";
const TUYA_SECRET = process.env.TUYA_ACCESS_SECRET || "";
const TUYA_UID = process.env.TUYA_UID || "";

let _tuyaToken = null; // { access_token, expires_at }
let _tuyaListCache = null; // { ts, data } — TTL 5 min

function tuyaSha256(s) { return crypto.createHash("sha256").update(s).digest("hex"); }
function tuyaSign(str) { return crypto.createHmac("sha256", TUYA_SECRET).update(str).digest("hex").toUpperCase(); }

// Tuya v2 sign: query params ORDENADOS alfabéticamente tanto en StringToSign
// como en la URL real (deben coincidir). Sin esto: "sign invalid".
function tuyaCanonPath(path) {
  const i = path.indexOf("?");
  if (i < 0) return path;
  const base = path.substring(0, i);
  const qs = path.substring(i + 1);
  const parts = qs.split("&").filter(Boolean)
    .map(p => { const eq = p.indexOf("="); return eq < 0 ? [p, ""] : [p.substring(0, eq), p.substring(eq + 1)]; })
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => v === "" ? k : `${k}=${v}`);
  return base + "?" + parts.join("&");
}

async function tuyaRequest(method, path, { body = "", withToken = true } = {}) {
  if (!TUYA_ID || !TUYA_SECRET) throw new Error("TUYA_ACCESS_ID/SECRET no configurados");
  if (withToken) await tuyaEnsureToken();
  path = tuyaCanonPath(path);
  const t = Date.now().toString();
  const nonce = "";
  const contentHash = tuyaSha256(body || "");
  const stringToSign = `${method.toUpperCase()}\n${contentHash}\n\n${path}`;
  const signStr = withToken
    ? `${TUYA_ID}${_tuyaToken.access_token}${t}${nonce}${stringToSign}`
    : `${TUYA_ID}${t}${nonce}${stringToSign}`;
  const headers = {
    "client_id": TUYA_ID,
    "sign": tuyaSign(signStr),
    "t": t,
    "sign_method": "HMAC-SHA256",
    "nonce": nonce,
    "Content-Type": "application/json",
  };
  if (withToken) headers["access_token"] = _tuyaToken.access_token;
  const url = TUYA_HOST + path;
  const opts = { method, headers };
  if (body) opts.body = body;
  const r = await fetch(url, opts);
  const j = await r.json();
  if (!j.success) throw new Error(`Tuya ${path}: ${j.msg || j.code || "error"}`);
  return j.result;
}

async function tuyaEnsureToken() {
  if (_tuyaToken && Date.now() < _tuyaToken.expires_at - 60_000) return;
  const r = await tuyaRequest("GET", "/v1.0/token?grant_type=1", { withToken: false });
  _tuyaToken = {
    access_token: r.access_token,
    expires_at: Date.now() + (r.expire_time * 1000),
  };
}

// Devuelve { homes:[{id,name,rooms:[{id,name}]}], devices:[{id,name,category,product_name,online,status,home_id,room_id,update_time}] }
app.get("/tuya/devices", async (req, res) => {
  try {
    if (_tuyaListCache && (Date.now() - _tuyaListCache.ts) < 5 * 60 * 1000 && !req.query.fresh) {
      return res.json({ ok: true, ...(_tuyaListCache.data), cached: true });
    }
    if (!TUYA_UID) throw new Error("TUYA_UID no configurado");
    const homes = await tuyaRequest("GET", `/v1.0/users/${TUYA_UID}/homes`);
    const out = { homes: [], devices: [] };
    for (const h of (homes || [])) {
      const rooms = await tuyaRequest("GET", `/v1.0/homes/${h.home_id}/rooms`).catch(() => []);
      out.homes.push({
        id: String(h.home_id),
        name: h.name || "",
        rooms: (rooms?.rooms || rooms || []).map(rm => ({ id: String(rm.room_id), name: rm.name || "" })),
      });
      const devs = await tuyaRequest("GET", `/v1.0/homes/${h.home_id}/devices`);
      for (const d of (devs || [])) {
        out.devices.push({
          id: d.id,
          name: d.name || d.product_name || d.id,
          category: d.category || "",
          product_name: d.product_name || "",
          online: !!d.online,
          status: d.status || [],
          home_id: String(h.home_id),
          room_id: d.room_id ? String(d.room_id) : "",
          update_time: d.update_time || d.active_time || 0,
        });
      }
    }
    _tuyaListCache = { ts: Date.now(), data: out };
    res.json({ ok: true, ...out, cached: false });
  } catch (e) {
    console.error("tuya_devices_error", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Detalle de un device (status detallado)
app.get("/tuya/device/:id", async (req, res) => {
  try {
    const r = await tuyaRequest("GET", `/v1.0/devices/${encodeURIComponent(req.params.id)}`);
    res.json({ ok: true, device: r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Bulk: últimos N logs para varios dispositivos a la vez. Concurrencia limitada
// para no saturar Tuya. Caché 60s por device para evitar refetches en re-render.
const _tuyaLogsCache = new Map(); // id → { ts, logs }
// Diagnóstico: una sola llamada a Tuya logs y devuelve la respuesta cruda
app.get("/tuya/_diag/logs/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const days = Math.min(30, Number(req.query.days) || 7);
    const size = Math.min(100, Number(req.query.size) || 100);
    const end = Date.now();
    const start = end - days * 24 * 60 * 60 * 1000;
    const lrk = req.query.lrk ? `&start_row_key=${(req.query.lrk)}` : "";
    const path = `/v1.0/devices/${encodeURIComponent(id)}/logs?start_time=${start}&end_time=${end}&type=1,2,3,4,5,6,7&size=${size}${lrk}`;
    const r = await tuyaRequest("GET", path);
    res.json({ ok: true, path, keys: Object.keys(r||{}), has_next: r?.has_next, next_row_key: r?.next_row_key, current_row_key: r?.current_row_key, logs_count: (r?.logs||[]).length, first_ts: (r?.logs||[]).slice(-1)[0]?.event_time, last_ts: (r?.logs||[])[0]?.event_time });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/tuya/logs-bulk", async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const size = Math.min(5000, Number(req.body?.size) || 2);
    const days = Math.min(30, Number(req.body?.days) || 2);
    const explicitStart = Number(req.body?.start_time) || 0;
    const explicitEnd = Number(req.body?.end_time) || 0;
    // Cache TAMBIÉN para rangos explícitos: la clave incluye start+end.
    // Beneficia las re-aperturas del panel de detalle (Ocupación/Gestión).
    const useCache = true;
    const cacheKey = explicitStart && explicitEnd ? `${explicitStart}-${explicitEnd}` : 'all';
    const ttlMs = 5 * 60_000; // 5 min para rangos explícitos
    const now = Date.now();
    const out = {};
    const pending = [];
    if (useCache) {
      for (const id of ids) {
        const c = _tuyaLogsCache.get(`${id}|${cacheKey}`);
        if (c && (now - c.ts) < ttlMs) out[id] = c.logs.slice(0, size);
        else pending.push(id);
      }
    } else {
      pending.push(...ids);
    }
    const end = explicitEnd || now;
    const start = explicitStart || (end - days * 24 * 60 * 60 * 1000);
    // Tuya devuelve hasta 100 por página y los más recientes primero.
    // Para cubrir el rango completo, paginamos hasta acumular `size` logs
    // o hasta agotar (~10 páginas como guardia).
    const PAGE = 100;
    const MAX_PAGES = 30;
    const HARD_DEADLINE = Date.now() + 45_000;
    const fetchOne = async (id) => {
      try {
        const collected = [];
        let nextRowKey = "";
        let hasMore = true;
        let pages = 0;
        while (hasMore && collected.length < size && pages < MAX_PAGES && Date.now() < HARD_DEADLINE) {
          const need = Math.min(PAGE, size - collected.length);
          // Tuya: el cursor de paginación se llama next_row_key/start_row_key.
          const params = `start_time=${start}&end_time=${end}&type=1,2,3,4,5,6,7&size=${need}` + (nextRowKey ? `&start_row_key=${(nextRowKey)}` : "");
          const path = `/v1.0/devices/${encodeURIComponent(id)}/logs?${params}`;
          const r = await tuyaRequest("GET", path);
          const page = r?.logs || [];
          collected.push(...page);
          nextRowKey = r?.next_row_key || "";
          hasMore = !!r?.has_next && nextRowKey;
          pages++;
          if (!page.length) break;
        }
        if (useCache) _tuyaLogsCache.set(`${id}|${cacheKey}`, { ts: now, logs: collected });
        out[id] = collected.slice(0, size);
      } catch (e) {
        out[id] = [];
      }
    };
    const queue = pending.slice();
    const workers = Array.from({ length: 8 }, async () => {
      while (queue.length) { const id = queue.shift(); if (id) await fetchOne(id); }
    });
    await Promise.all(workers);
    res.json({ ok: true, byId: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Historial de eventos. Por defecto últimos 7 días, size=50.
// type=7 = report state (cambios). Puede combinarse: type=1,7 (online + state).
app.get("/tuya/device/:id/logs", async (req, res) => {
  try {
    const days = Math.min(30, Number(req.query.days) || 7);
    const size = Math.min(100, Number(req.query.size) || 50);
    const type = req.query.type || "1,2,3,4,5,6,7";
    const end = Date.now();
    const start = end - days * 24 * 60 * 60 * 1000;
    const path = `/v1.0/devices/${encodeURIComponent(req.params.id)}/logs?start_time=${start}&end_time=${end}&type=${type}&size=${size}`;
    const r = await tuyaRequest("GET", path);
    res.json({ ok: true, logs: r?.logs || [], has_next: !!r?.has_next });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ║ KOMMO — POC Timeline WhatsApp por contacto                              ║
// ║   Env: KOMMO_SUBDOMAIN (ej. "checkinnsaltillo"), KOMMO_TOKEN (long-lived) ║
// ║   Flujo: recibe {phone} → busca contacto Kommo → arma cronología desde   ║
// ║   WA_Scheduled/WA_Log/WA_Templates en Sheets → upsert nota en Kommo.     ║
// ═══════════════════════════════════════════════════════════════════════════

function _kommoBase() {
  const sub = process.env.KOMMO_SUBDOMAIN || "checkinnsaltillo";
  return `https://${sub}.kommo.com`;
}
async function _kommoFetch(path, opts = {}) {
  const tok = process.env.KOMMO_TOKEN;
  if (!tok) throw new Error("KOMMO_TOKEN no configurado");
  const url = `${_kommoBase()}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${tok}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch(_) {}
  if (!res.ok) {
    const msg = (json && (json.detail || json.title || json.message)) || text || `HTTP ${res.status}`;
    throw new Error(`Kommo ${res.status}: ${msg}`);
  }
  return json;
}

/** Encuentra el contacto Kommo por teléfono (últimos 10 dígitos). */
async function _kommoFindContactByPhone(phone) {
  const tail = String(phone || "").replace(/\D/g, "").slice(-10);
  if (!tail) return null;
  const j = await _kommoFetch(`/api/v4/contacts?query=${encodeURIComponent(tail)}&limit=10`);
  const contacts = (j && j._embedded && j._embedded.contacts) || [];
  for (const c of contacts) {
    for (const cf of (c.custom_fields_values || [])) {
      if (cf.field_code === "PHONE") {
        for (const v of (cf.values || [])) {
          const t = String(v.value || "").replace(/\D/g, "").slice(-10);
          if (t === tail) return c;
        }
      }
    }
  }
  return contacts[0] || null;
}

function _kFmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  let h = d.getHours(), m = d.getMinutes();
  const ampm = h >= 12 ? 'p.m.' : 'a.m.'; h = h % 12; if (h === 0) h = 12;
  return `${d.getDate()} ${meses[d.getMonth()]}, ${h}:${String(m).padStart(2,'0')} ${ampm}`;
}

/** Consulta el estado real de mensajes WhatsApp del teléfono via Apps Script
 *  y construye el texto de la nota Kommo. Reusa WA_Scheduled + WA_Log. */
async function _kommoBuildTimelineText(phone) {
  const tail = String(phone || "").replace(/\D/g, "").slice(-10);
  const lines = [`📩 Timeline WhatsApp — Check-inn`, ``];
  lines.push(`Teléfono: +${String(phone).replace(/\D/g, '')}`);
  lines.push(`Actualizado: ${_kFmtWhen(new Date().toISOString())}`);
  lines.push(``);
  // 1) Programados custom + templates ya persistidos (WA_Scheduled del sheet)
  try {
    const sch = await callCheckinAppsScriptPost("wa_scheduled_list", { booking_id: "" });
    const items = ((sch && sch.items) || []).filter(it => {
      const toTail = String(it.to || "").replace(/\D/g, "").slice(-10);
      return toTail && toTail === tail;
    });
    items.sort((a, b) => (a.scheduled_at || "").localeCompare(b.scheduled_at || ""));
    if (items.length) {
      lines.push(`═══ MENSAJES PROGRAMADOS ═══`);
      for (const it of items) {
        const status = String(it.status || "").toLowerCase();
        let icon = "🕐";
        if (status === "sent") icon = "✓";
        else if (status === "omitted") icon = "✕";
        else if (status === "failed") icon = "⚠";
        const when = it.sent_at ? `enviado ${_kFmtWhen(it.sent_at)}` : (it.scheduled_at ? `programado ${_kFmtWhen(it.scheduled_at)}` : "");
        const asunto = it.asunto ? `[${it.asunto}] ` : "";
        const body = String(it.body || "").replace(/\s+/g, " ").slice(0, 120);
        lines.push(`${icon} ${asunto}${when}`);
        if (body) lines.push(`   ${body}${body.length >= 120 ? "…" : ""}`);
      }
      lines.push(``);
    }
  } catch (e) {
    lines.push(`(No pude leer WA_Scheduled: ${e.message})`);
  }
  // 2) Log histórico (WA_Log del sheet) — últimos 10 relevantes al teléfono.
  //    Nota: WA_Log se indexa por booking_id, no por teléfono. Filtramos por
  //    coincidencia del 'to' (últimos 10 dígitos).
  try {
    const logRes = await callCheckinAppsScriptPost("wa_log_get_batch", { booking_ids: [] });
    // wa_log_get_batch normalmente devuelve por booking; para este POC lo
    // omitimos si el shape no es amigable — el resumen ya está en scheduled.
  } catch (_) {}
  if (lines.length <= 4) {
    lines.push(`(Sin mensajes programados ni enviados para este teléfono)`);
  }
  lines.push(``);
  lines.push(`—`);
  lines.push(`Fuente: Check-inn Saltillo · Auto-generado`);
  return lines.join("\n");
}

// POST /kommo/refresh-contact-timeline — Body: { phone } o { contactId }.
// Efecto: crea una nueva nota tipo "common" en el contacto con la cronología
// actualizada. (Kommo no permite editar notas existentes vía API pública, así
// que se agrega una nueva cada refresh; el usuario ve la más reciente arriba.)
app.post("/kommo/refresh-contact-timeline", async (req, res) => {
  try {
    const p = req.body || {};
    let contact = null;
    if (p.contactId) {
      contact = await _kommoFetch(`/api/v4/contacts/${encodeURIComponent(p.contactId)}`);
    } else if (p.phone) {
      contact = await _kommoFindContactByPhone(p.phone);
    } else {
      return res.status(400).json({ ok: false, error: "phone o contactId requerido" });
    }
    if (!contact) return res.status(404).json({ ok: false, error: "contacto no encontrado" });
    const contactId = contact.id;
    // Extraer el teléfono del contacto (para armar la cronología).
    let phone = p.phone || "";
    if (!phone) {
      for (const cf of (contact.custom_fields_values || [])) {
        if (cf.field_code === "PHONE" && Array.isArray(cf.values) && cf.values[0]) {
          phone = cf.values[0].value; break;
        }
      }
    }
    const text = await _kommoBuildTimelineText(phone);
    const note = await _kommoFetch(`/api/v4/contacts/${contactId}/notes`, {
      method: "POST",
      body: JSON.stringify([{ note_type: "common", params: { text } }]),
    });
    const noteId = ((note && note._embedded && note._embedded.notes) || [])[0]?.id;
    res.json({ ok: true, contact_id: contactId, note_id: noteId, phone, chars: text.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// MÓDULO RESERVAS — Proxy a Lodgify Public API v2 (X-ApiKey)
// GET  /reservas/properties        → lista de propiedades (cache 5min)
// GET  /reservas/search?arrival&departure&adults[&location][&children][&pets]
//   → propiedades disponibles con precio del rango consultado
// ═══════════════════════════════════════════════════════════════════════
const LODGIFY_API = "https://api.lodgify.com";
let _lodgifyPropsCache = { t: 0, data: null };
async function _lodgifyFetch(path, params) {
  const key = process.env.LODGIFY_API_KEY;
  if (!key) throw new Error("LODGIFY_API_KEY no configurada");
  const url = new URL(LODGIFY_API + path);
  if (params) Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") url.searchParams.append(k, String(v));
  });
  const r = await fetch(url.toString(), {
    headers: { "X-ApiKey": key, "Accept": "application/json" },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Lodgify ${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}
app.get("/reservas/properties", async (_req, res) => {
  try {
    const now = Date.now();
    if (_lodgifyPropsCache.data && (now - _lodgifyPropsCache.t) < 5 * 60_000) {
      return res.json({ ok: true, cached: true, properties: _lodgifyPropsCache.data });
    }
    const j = await _lodgifyFetch("/v2/properties", { size: 100, includeInOut: false });
    const list = Array.isArray(j) ? j : (j.items || j.results || []);
    _lodgifyPropsCache = { t: now, data: list };
    res.json({ ok: true, cached: false, properties: list });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
// Diagnóstico: retorna el error/response crudo del quote para 1 propiedad.
// Diagnóstico: raw completo de una propiedad (para ver si trae slug/hosted_url).
app.get("/reservas/prop-raw", async (req, res) => {
  try {
    const id = String(req.query.id || "");
    if (!id) return res.status(400).json({ ok:false, error:"id requerido" });
    const j = await _lodgifyFetch(`/v2/properties/${id}`, {});
    res.json({ ok: true, data: j });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});
app.get("/reservas/quote-debug", async (req, res) => {
  try {
    const propId = String(req.query.propertyId || "");
    const arrival = String(req.query.arrival || "");
    const departure = String(req.query.departure || "");
    const roomId = String(req.query.roomId || "0");
    const people = String(req.query.people || "2");
    const qParams = {
      arrival, departure,
      "roomTypes[0].Id": roomId,
      "roomTypes[0].People": people,
      includeExtras: false,
    };
    try {
      const q = await _lodgifyFetch(`/v2/quote/${propId}`, qParams);
      res.json({ ok: true, quote: q });
    } catch (e) {
      res.json({ ok: false, error: e.message, params: qParams });
    }
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.get("/reservas/search", async (req, res) => {
  try {
    const arrival   = String(req.query.arrival || "").slice(0, 10);
    const departure = String(req.query.departure || "").slice(0, 10);
    const adults    = Math.max(1, parseInt(req.query.adults || "2", 10) || 2);
    const children  = Math.max(0, parseInt(req.query.children || "0", 10) || 0);
    const pets      = Math.max(0, parseInt(req.query.pets || "0", 10) || 0);
    const locationQ = String(req.query.location || "").trim().toLowerCase();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(arrival) || !/^\d{4}-\d{2}-\d{2}$/.test(departure)) {
      return res.status(400).json({ ok: false, error: "arrival y departure requeridos (YYYY-MM-DD)" });
    }
    // 1) Listar propiedades (Lodgify) + catálogo local de alojamientos
    //    (Google Sheets) en paralelo. El catálogo trae url_lodgify oficial
    //    por HouseId — evita construir slugs a mano.
    let props = null;
    const now = Date.now();
    const [pjOrCache, alojRows] = await Promise.all([
      (_lodgifyPropsCache.data && (now - _lodgifyPropsCache.t) < 5 * 60_000)
        ? Promise.resolve(_lodgifyPropsCache.data)
        : _lodgifyFetch("/v2/properties", { size: 100 }).then(pj => {
            const list = Array.isArray(pj) ? pj : (pj.items || pj.results || []);
            _lodgifyPropsCache = { t: now, data: list };
            return list;
          }),
      _botGetAlojRows().catch(() => []),
    ]);
    props = pjOrCache;
    // HouseId (Lodgify id) → fila del catálogo.
    const alojById = {};
    for (const a of (alojRows || [])) {
      const id = String(a.HouseId || "").trim();
      if (id) alojById[id] = a;
    }
    // 2) Filtro suave por ubicación (nombre / ciudad / dirección).
    const inLoc = (p) => {
      if (!locationQ) return true;
      const hay = [p.name, p.city, p.address, p.state, p.subdivision]
        .filter(Boolean).map(x => String(x).toLowerCase()).join(" | ");
      return hay.indexOf(locationQ) >= 0;
    };
    const candidates = props.filter(inLoc);
    // 3) Para cada candidato pedir quote en paralelo.
    const totalPeople = adults + children;
    const settled = await Promise.allSettled(candidates.map(async (p) => {
      const propId = p.id;
      // Room type: intentar el primero de la propiedad.
      const rooms = Array.isArray(p.rooms) ? p.rooms : [];
      const rtId = (rooms[0] && (rooms[0].id || rooms[0].room_type_id)) || null;
      // Endpoint quote v2. Usamos "roomTypes" con Id + People.
      const qParams = {
        arrival, departure,
        "roomTypes[0].Id": rtId || 0,
        "roomTypes[0].People": totalPeople,
        includeExtras: false,
      };
      try {
        const q = await _lodgifyFetch(`/v2/quote/${propId}`, qParams);
        const first = Array.isArray(q) ? q[0] : q;
        if (!first) return null;
        // Lodgify: total_including_vat suele venir null cuando el IVA=0.
        // Fallback a amount_gross / total_excluding_vat / total.
        const total = Number(
          first.amount_gross ||
          first.total_including_vat ||
          first.total_excluding_vat ||
          first.total ||
          0
        );
        if (!(total > 0)) return null;
        // Normalizar image_url de Lodgify (viene como //l.icdbcdn.com/...)
        const normImg = (u) => u ? (u.startsWith('//') ? 'https:' + u : u) : '';
        const rawImg = p.image_url || (p.image && p.image.url) || (Array.isArray(p.images) && p.images[0] && (p.images[0].url || p.images[0].image_url)) || '';
        // Enrich con el catálogo local si tenemos match por HouseId (=id Lodgify).
        const aloj = alojById[String(propId)] || null;
        // URL oficial del sitio hosted — viene ya lista del sheet.
        let hostedUrl = aloj && String(aloj.url_lodgify || '').trim();
        if (hostedUrl) {
          // El sheet a veces trae "?adults=1" pegado; limpiar querystring
          // para agregar la nuestra desde el frontend sin duplicar.
          const q = hostedUrl.indexOf('?');
          if (q >= 0) hostedUrl = hostedUrl.slice(0, q);
        }
        return {
          id: propId,
          name: p.name || "",
          type: (aloj && aloj.tipo) || p.property_type || p.type || "",
          city: p.city || "",
          address: (aloj && aloj.direccion) || p.address || "",
          latitude: p.latitude || null,
          longitude: p.longitude || null,
          image: normImg(rawImg),
          images: (Array.isArray(p.images) ? p.images.map(x => normImg(x.url || x.image_url)).filter(Boolean) : []),
          amenities: aloj && aloj.amenidades
            ? String(aloj.amenidades).split(/[,;·|]/).map(s => s.trim()).filter(Boolean).slice(0, 8)
            : (Array.isArray(p.amenities) ? p.amenities : []).map(a => a.name || a).filter(Boolean).slice(0, 8),
          bedrooms: (aloj && aloj.recamaras) || p.bedrooms || null,
          bathrooms: (aloj && aloj.banos) || p.bathrooms || null,
          max_people: (aloj && aloj.capacidad) || p.max_people || (rooms[0] && rooms[0].max_people) || null,
          currency: first.currency_code || first.currency || p.currency_code || "MXN",
          total,
          nights: Math.max(1, Math.round((new Date(departure) - new Date(arrival)) / 86_400_000)),
          quote_raw: first,
          hostedUrl: hostedUrl || null,
        };
      } catch (e) {
        // 400 típicamente = no hay disponibilidad para el rango. Ignorar.
        return null;
      }
    }));
    const results = settled
      .map(s => s.status === "fulfilled" ? s.value : null)
      .filter(Boolean);
    res.json({ ok: true, count: results.length, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Ticket Vision v7 — Claude Vision — port ${PORT}`));
