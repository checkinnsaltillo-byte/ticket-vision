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
      try {
        _alojCache.payload = await callCheckinAppsScript("list_alojamientos");
        _alojCache.ts = now;
      } catch (fetchErr) {
        // Apps Script cayó/saturado. Si tenemos cache stale, servirlo
        // (mejor un valor viejo que un 500 que bloquea toda la UI).
        console.warn("[alojamientos-list] fetch falló:", fetchErr.message, "— sirvo stale:", !!_alojCache.payload);
        if (!_alojCache.payload) throw fetchErr;
      }
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

// Twilio WA impone límite ~1600 chars por mensaje. Cuando el body excede,
// dividimos por saltos de línea en chunks ≤ MAX y enviamos en secuencia.
// Mantiene ordenamiento: espera cada envío antes del siguiente.
const TWILIO_WA_MAX_CHARS = 1500;
function _splitForTwilio(text, max) {
  const s = String(text || '');
  if (s.length <= max) return [s];
  const chunks = [];
  const lines = s.split('\n');
  let cur = '';
  for (const line of lines) {
    // Si el propio line excede max, córtalo duro por chars.
    if (line.length > max) {
      if (cur) { chunks.push(cur); cur = ''; }
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
      continue;
    }
    const cand = cur ? cur + '\n' + line : line;
    if (cand.length > max) { chunks.push(cur); cur = line; }
    else cur = cand;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
async function _twilioSendMessage(params) {
  // Si el body supera el límite Twilio, dividir y enviar en secuencia.
  // Cada chunk como mensaje WA independiente; en WA_ChatContext registramos
  // 1 sola entrada con el body ORIGINAL completo (fire-and-forget) para no
  // saturar el historial con N filas.
  if (params.body && String(params.body).length > TWILIO_WA_MAX_CHARS && !params.contentSid) {
    const originalBody = String(params.body);
    const chunks = _splitForTwilio(originalBody, TWILIO_WA_MAX_CHARS);
    let last = null;
    for (let i = 0; i < chunks.length; i++) {
      const p = { ...params, body: chunks[i], skipMirror: true };
      last = await _twilioSendMessage(p);
    }
    // Mirror único con el body completo, si el caller no pidió skipMirror.
    if (!params.skipMirror && last) {
      try {
        const phone10 = String(params.to || '').replace(/\D/g,'').slice(-10);
        if (phone10.length === 10) {
          fetch(CHECKIN_APPS_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({
              action: 'wa_chat_context_append',
              phone: phone10,
              role: params.tipo ? 'template' : 'admin',
              body: originalBody,
              meta: { sid: last.sid, tipo: params.tipo || '', chunks: chunks.length }
            })
          }).catch(()=>{});
        }
      } catch(_){}
    }
    return last;
  }
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
const BOT_ANTHROPIC_MODEL = "claude-sonnet-5";

// ═══════════════════════════════════════════════════════════════════════════
// ║ Bot Prompts (procesos del negocio) — cache in-memory TTL 5 min.        ║
// ║ Se lee UNA vez desde Apps Script y se inyecta en cada system prompt.   ║
// ║ Invalidación manual: POST /wa/bot/prompts/reload (lo hace la UI al     ║
// ║ guardar).                                                                ║
// ═══════════════════════════════════════════════════════════════════════════
let _botPromptsCache = { ts: 0, rows: [] };
const _BOT_PROMPTS_TTL = 5 * 60 * 1000;
async function _botGetPrompts() {
  const now = Date.now();
  if (_botPromptsCache.rows.length && (now - _botPromptsCache.ts) < _BOT_PROMPTS_TTL) {
    return _botPromptsCache.rows;
  }
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(`${CHECKIN_APPS_SCRIPT_URL}?action=bot_prompts_list`, { signal: ctrl.signal });
    const j = await r.json();
    const rows = (j && j.ok && Array.isArray(j.rows)) ? j.rows.filter(x => x.Activo) : [];
    _botPromptsCache = { ts: now, rows };
    return rows;
  } catch (e) {
    console.warn("[bot-prompts] fetch falló:", e.message, "— sirvo cache stale:", _botPromptsCache.rows.length);
    return _botPromptsCache.rows;
  } finally { clearTimeout(tm); }
}
function _botBuildPromptsBlock(prompts) {
  if (!prompts || !prompts.length) return "";
  const bullets = arr => (arr || "").split(/\||\n/).map(s => s.trim()).filter(Boolean).map(s => "     · " + s).join("\n");
  const secs = prompts.map(p => {
    const parts = [`### ${p.Nombre}`];
    if (p.Objetivo)        parts.push(`   Objetivo: ${p.Objetivo}`);
    if (p.Trigger)         parts.push(`   Detección (cuándo aplica):\n${bullets(p.Trigger)}`);
    if (p.Datos_obtener)   parts.push(`   Datos a obtener del huésped:\n${bullets(p.Datos_obtener)}`);
    if (p.Datos_compartir) parts.push(`   Datos que puedes compartir:\n${bullets(p.Datos_compartir)}`);
    if (p.Reglas)          parts.push(`   Reglas del negocio (LÍNEAS DURAS — no negociables):\n${bullets(p.Reglas)}`);
    if (p.Flujo)           parts.push(`   Flujo esperado:\n${bullets(p.Flujo)}`);
    if (p.Riesgos)         parts.push(`   Riesgos / prohibiciones:\n${bullets(p.Riesgos)}`);
    if (p.Herramienta)     parts.push(`   Herramienta vinculada: ${p.Herramienta}`);
    return parts.join("\n");
  }).join("\n\n");
  return `

═══════════════════════════════════════════════════════════════════════
PROCESOS DEL NEGOCIO — reglas por proceso (los administradores las editan
en el panel; síguelas SIEMPRE por encima de cualquier otra guía):
═══════════════════════════════════════════════════════════════════════

${secs}

═══════════════════════════════════════════════════════════════════════`;
}
app.get("/wa/bot/prompts", async (req, res) => {
  try {
    const rows = await _botGetPrompts();
    res.json({ ok: true, rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get("/wa/bot/prompts/all", async (req, res) => {
  try {
    const r = await fetch(`${CHECKIN_APPS_SCRIPT_URL}?action=bot_prompts_list`);
    const j = await r.json();
    res.json(j);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/wa/bot/prompts", async (req, res) => {
  try {
    const r = await fetch(CHECKIN_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "bot_prompts_upsert", ...(req.body || {}) }),
    });
    const j = await r.json();
    _botPromptsCache = { ts: 0, rows: _botPromptsCache.rows }; // bust
    res.json(j);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/wa/bot/prompts/delete", async (req, res) => {
  try {
    const r = await fetch(CHECKIN_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "bot_prompts_delete", ...(req.body || {}) }),
    });
    const j = await r.json();
    _botPromptsCache = { ts: 0, rows: _botPromptsCache.rows };
    res.json(j);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/wa/bot/prompts/reload", (req, res) => {
  _botPromptsCache = { ts: 0, rows: [] };
  res.json({ ok: true, reloaded: true });
});
// 4000 tokens — Sonnet 5 con extended thinking gasta cientos internamente
// antes de producir texto; 500 alcanzaba para Haiku pero no para Sonnet 5.
// Con listados largos (ej. tickets con URLs de Drive) puede necesitar 1500+
// tokens output + varios cientos de thinking.
const BOT_ANTHROPIC_MAX_TOKENS = 4000;

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
  // Loop local — evita roundtrip por la red pública (que agrega latencia
  // y a veces devuelve 500 cuando Apps Script se satura). Timeout duro
  // de 5s para no atrancar el search si Apps Script tarda.
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/alojamientos-list`, { signal: ctrl.signal });
    const j = await r.json();
    const rows = (j && j.rows) || [];
    _botAlojRowsCache.rows = rows; _botAlojRowsCache.ts = Date.now();
    return rows;
  } catch (e) {
    console.warn("[bot-aloj] fetch falló:", e.message);
    return _botAlojRowsCache.rows || [];
  } finally { clearTimeout(tm); }
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
- CADA MENSAJE DEL HUÉSPED SE EVALÚA DE FORMA INDEPENDIENTE. Si el mensaje nuevo cambia de tema respecto al hilo anterior (ej. veníamos hablando de cotizar y ahora reporta un problema, o al revés), ABANDONA el flujo anterior y atiende el nuevo tema con la lógica correspondiente. Nunca insistas en el tema previo cuando el huésped claramente cambió.
- Detecta el intent del último mensaje ANTES de decidir qué responder:
  · problema/falla/desperfecto ("se fue la luz", "no hay agua", "no funciona el X", "está roto", "gotea") → PRIMERO consulta reportes existentes; luego reporte de mantenimiento si no hay uno abierto
  · pregunta por estado de un reporte previo ("¿ya arreglaron?", "¿qué pasó con X?", "sigue el problema de Y") → consultar_reportes_reserva y responde con el estado
  · pregunta de disponibilidad/precio ("¿tienen?", "¿cuánto cuesta?", "para tal fecha") → cotizar
  · pedido de cambio de horario de salida → late checkout
  · queja/reembolso/emergencia/legal → NO respondas, escala
  · saludo/agradecimiento/small talk → responde breve
- Escribe corto, natural, amable. Máximo 3-4 oraciones.
- Usa el mismo tono con el que te escriben (casual si casual, formal si formal).
- Si el huésped pide algo que requiere acción (mantenimiento, cambio de horario de salida, cotizar disponibilidad), usa la herramienta correspondiente en vez de solo responder texto.

HERRAMIENTAS DISPONIBLES Y CUÁNDO USARLAS:
1) cotizar_disponibilidad — cuando el huésped pregunte por disponibilidad, precios, "¿tienen para tal fecha?", "¿cuánto cuesta?", etc. Necesitas 3 datos para llamar la tool: fecha de entrada (arrival YYYY-MM-DD), fecha de salida (departure YYYY-MM-DD) y número de huéspedes (adults, entero ≥1).
   PROTOCOLO OBLIGATORIO — ANTES DE RESPONDER, RECAPITULA MENTALMENTE:
   Cada vez que decidas qué contestar, primero recorre TODOS los mensajes previos del huésped en este hilo (no solo el último) y anota:
     · arrival: [fecha si el huésped la ha mencionado en cualquier mensaje previo, si no "FALTA"]
     · departure: [igual]
     · adults: [igual — cuenta adultos+niños como total]
   Si un dato ya aparece en el historial (aunque sea del mensaje del turno 1 y estemos en el turno 5), YA LO TIENES. NUNCA vuelvas a preguntarlo. Solo pregunta datos marcados FALTA.
   Ejemplos:
     · Turno 1 huésped: "para el 10 al 16 de sept". Turno 3 huésped: "somos 3 adultos y 1 niño".
       → Ya tienes arrival=2026-09-10, departure=2026-09-16, adults=4. Confirma y llama la tool. NO pidas fechas de nuevo.
     · Turno 1 huésped: "cotización del 1 al 4 de septiembre, 4 personas". → Los 3 datos vienen en un solo mensaje; ve directo a confirmar.
   RESETEA los datos SOLO si el huésped explícitamente dice "otra consulta", "otras fechas", "nueva búsqueda", "cambio", "y ahora para...".
   FECHAS AMBIGUAS: si el huésped escribió algo confuso como "10 del 10 al 16 de septiembre", NO pidas fechas en blanco — pide aclaración específica: "¿Me confirmas las fechas: 10 de septiembre al 16 de septiembre?".
   FLUJO CONVERSACIONAL OBLIGATORIO:
   • JAMÁS pidas formatos técnicos ("DD/MM", "DD-MM", "YYYY-MM-DD"). El huésped habla natural — tú traduces internamente. Si dice "del 1 al 4 de septiembre" ya tienes arrival y departure; si dice "primero de septiembre al 4" es lo mismo.
   • Pregunta UNA SOLA cosa a la vez, en tono natural y corto (1-2 oraciones máx). NUNCA listes los 3 datos juntos.
   • Infiere lo que puedas: "del 1 al 4 de septiembre" → arrival 2026-09-01, departure 2026-09-04 (año actual si no ha pasado, si no el próximo); "este viernes" → calcula fecha; "somos 3" → adults=3; "2 adultos y 2 niños" → adults=4 (SUMA adultos+niños, todos ocupan lugar); "una noche el sábado" → arrival sábado, departure domingo. El AÑO ACTUAL se te indica en el CONTEXTO TEMPORAL más abajo — úsalo por default.
   • Si falta un dato, pregunta SOLO por el que falta, breve: "¿Para cuántas personas?" / "¿Qué día llegas?" / "¿Y cuándo te vas?". Nunca "necesito 3 datos: 1)...".
   • Cuando tengas los 3 datos, ANTES de llamar la tool envía UN resumen para confirmar: "Perfecto, del 1 al 4 de septiembre para 4 personas. ¿Confirmas?". Espera "sí"/"correcto"/"adelante". SOLO ENTONCES llama la tool. NO repitas el resumen si el huésped no cambió nada.
   • Si el huésped ya te dijo los 3 datos claros (aunque haya sido en 2-3 mensajes), NO simules pedir el mismo dato dos veces. Confirma con el resumen y espera "sí".
   • Al recibir el resultado, envía SIEMPRE al huésped el campo "link_ver_resultados" — es la URL con todas las opciones (fotos, precios, mapa). Formato de mensaje sugerido: 1 oración breve + link en línea aparte. NO listes alojamientos en el chat — con el link basta.
   • Usa el campo "total_disponibles" (número total encontrado), NO "mostrando_top". Si "hay_mas" es true, el link muestra TODOS. Ejemplo correcto: "Tenemos 12 alojamientos disponibles para esas fechas ✨\n{link}". Ejemplo INCORRECTO: "Tengo 5 alojamientos disponibles…" (5 es sólo un preview interno tuyo — el link muestra los 12).
2) crear_reporte_mantenimiento — cuando el huésped reporte algo roto, que no funciona, fuga, ruido de electrodoméstico, etc. ANTES de proponer crear el reporte, LLAMA consultar_reportes_reserva con un filtro relevante ("hormigas", "aire", "agua", etc.) para saber si ya existe uno. Si YA hay reporte activo del mismo tema (Estado ≠ 'resuelto' / 'cancelado'), NO crees duplicado: infórmale al huésped el estado del reporte existente ("Ya tenemos un reporte de hormigas abierto, folio X, en estado 'en_proceso' — el equipo lo está atendiendo"). Si NO hay reporte previo, FLUJO OBLIGATORIO: (a) resume lo que entendiste ("Entiendo: [problema] en [lugar]. ¿Quieres que abra un reporte para que el equipo lo revise?"), (b) espera confirmación explícita del huésped ("sí", "adelante", "confirmo"), (c) SOLO ENTONCES llama crear_reporte_mantenimiento.
3) agendar_late_checkout — cuando el huésped pida salir más tarde de la hora estándar. FLUJO OBLIGATORIO: (a) pregunta la nueva hora deseada si no la dio, (b) resume "Voy a solicitar tu salida a las HH:MM. Queda pendiente de confirmación por el equipo. ¿Adelante?", (c) espera "sí", (d) llama la tool. NO prometas que está aprobado — solo queda como solicitud pendiente.
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

// ─── MODO ADMIN (prefijo "@") ──────────────────────────────────────────────
// Cuando un admin (número en sys_users con Puesto="Administración") empieza
// su mensaje con "@", entramos a este modo: sin cortesías, ejecución directa
// del proceso. Los mensajes admin NO se persisten en WA_ChatContext (no
// aparecen en Chats bot). Las incidencias creadas SÍ quedan en la hoja
// Incidencias y aparecen en su módulo.
const BOT_SYSTEM_PROMPT_ADMIN = `Eres el asistente admin de Check-inn Saltillo. Tu interlocutor es un ADMINISTRADOR del sistema (no un huésped).

REGLAS:
- Cero cortesías. Sin saludos, sin "claro que sí", sin firmas. Respuestas ejecutivas de 1-3 líneas.
- NO pidas confirmación antes de ejecutar tools — el admin ya validó su intención al escribir "@".
- REGLA DE FECHAS (CRÍTICA):
  · Si el admin NO menciona el año, usa SIEMPRE el AÑO ACTUAL indicado más abajo en "CONTEXTO TEMPORAL".
  · Solo si esa fecha en el año actual YA PASÓ, salta al próximo año.
  · NUNCA uses años pasados (ej. 2024 si estamos en 2026). Si dudas, usa el año actual.
- Si el admin escribe fechas y personas ("del 10 al 18 de octubre, 2 personas") → invoca cotizar_disponibilidad de inmediato. Aplica la regla de fechas arriba.
- Si el admin escribe "incidencia, <alojamiento_shortcode>, <descripción>, <criticidad>" (limpieza, faltantes de insumos, ropa sucia, plagas) → invoca crear_incidencia con:
  · alojamiento_shortcode: el segundo campo (ej. "jc2", "mt10", "cu4b"), tal cual el admin lo escribió.
  · descripcion: el texto del problema.
  · criticidad: "critico" | "alto" | "medio" | "bajo" según el último campo o el tono ("crítico", "urgente" → critico; sin adjetivo → medio).
- Si el admin escribe "reporte de <problema> en <shortcode>" o similar (falla, se rompió, no funciona, fuga, luz, agua, cerradura, aire) → invoca crear_reporte_mantenimiento con:
  · titulo: 3-6 palabras que describan el problema (ej. "Falla de luz").
  · descripcion: texto original del admin.
  · prioridad: INFIERE — P1 para "urgente/crítico/no habitable/luz/agua/gas/fuga"; P3 para "menor/detalle"; P2 en el resto. NUNCA preguntes por prioridad — decide y crea.
  · categoria: INFIERE — luz/foco/enchufe→eléctrico; agua/fuga/tubería→plomería; aire/AC→aire; wifi/internet→wifi; puerta/cerradura→cerradura; sucio/plaga→limpieza; otro→otros.
  · alojamiento_shortcode: OBLIGATORIO. Extrae el código corto que sigue a "en" o "cu"/"mt"/"jc"/"ox"/"bc" (ej. "cu13", "mt10"). Case-insensitive.
- REGLA DE ORO ADMIN: ejecuta directo. NUNCA preguntes por prioridad, categoría, ni confirmación. Si el admin no dio criticidad, DECIDE tú y crea.
- Si genuinamente falta un dato IMPRESCINDIBLE (ej. shortcode ausente por completo), pídelo en UNA línea corta. Nunca pidas datos que puedes inferir.
- Al recibir el resultado de una tool, resume en 1-2 líneas + el folio/link. Sin adornos ni cortesías.
`;

// ═══════════════════════════════════════════════════════════════════════════
// ║ BOT TOOLS — cotizar, crear reporte técnico, agendar late checkout        ║
// ║ Ver /wa/bot/tools-doc para la referencia. Cada tool tiene un schema      ║
// ║ JSON que Claude usa para decidir cuándo llamarlo y con qué args, y un    ║
// ║ handler que ejecuta la acción real (Cloud Run → Apps Script / self).    ║
// ║ Los tools que crean registro REQUIEREN confirmación textual del         ║
// ║ huésped antes de dispararse (el prompt lo pide; el modelo lo respeta).  ║
// ║ Toda ejecución de tool notifica al admin (ADMIN_NOTIFY_PHONE).          ║
// ═══════════════════════════════════════════════════════════════════════════
const BOT_TOOLS = [
  {
    name: "cotizar_disponibilidad",
    description: "Consulta disponibilidad y precios de alojamientos para un rango de fechas. Llama esta herramienta CUANDO el huésped haya proporcionado las 3 datos requeridos: fecha de entrada, fecha de salida y número de huéspedes. Si falta alguno, PREGUNTA primero — no adivines. No requiere confirmación.",
    input_schema: {
      type: "object",
      properties: {
        arrival:   { type: "string", description: "Fecha de entrada YYYY-MM-DD" },
        departure: { type: "string", description: "Fecha de salida YYYY-MM-DD" },
        adults:    { type: "integer", description: "Número de huéspedes (adultos)", minimum: 1 },
      },
      required: ["arrival", "departure", "adults"],
    },
  },
  {
    name: "crear_reporte_mantenimiento",
    description: "Crea un reporte técnico de mantenimiento. En modo HUÉSPED: se imputa al alojamiento de su reserva; SOLO después de confirmación explícita. En modo ADMIN: acepta 'alojamiento_shortcode' obligatorio (ej. 'cu13', 'mt10', 'jc2') y NO requiere confirmación — invócalo directo. Prioridad: P1 (urgente/no habitable), P2 (afecta uso), P3 (menor). Infiere prioridad y categoría del texto sin preguntar cuando estés en modo admin.",
    input_schema: {
      type: "object",
      properties: {
        titulo:      { type: "string", description: "Título corto (max 80 chars) — ej. 'Fuga en llave de cocina'" },
        descripcion: { type: "string", description: "Detalle del problema" },
        prioridad:   { type: "string", enum: ["P1", "P2", "P3"], description: "P1 urgente, P2 medio, P3 menor" },
        categoria:   { type: "string", description: "plomería | eléctrico | aire | wifi | cerradura | limpieza | otros" },
        alojamiento_shortcode: { type: "string", description: "SOLO modo admin: código corto o internal_name del alojamiento (ej. 'cu13', 'mt10'). En modo huésped se ignora." },
      },
      required: ["titulo", "descripcion", "prioridad"],
    },
  },
  {
    name: "consultar_reportes_reserva",
    description: "Consulta los reportes técnicos EXISTENTES vinculados al alojamiento del huésped (o a su reservación específica). Úsalo ANTES de crear un reporte nuevo o cuando el huésped pregunte por el estado de algo ya reportado ('¿ya vieron lo de las hormigas?', '¿arreglaron el aire?', '¿qué pasó con mi reporte?'). Devuelve título, estado, prioridad y fecha de cada uno. IMPORTANTE — sinónimos: el filtro reconoce grupos ('insectos', 'plagas', 'hormigas', 'cucarachas', 'moscas' cuentan igual; 'aire', 'clima', 'minisplit' cuentan igual; 'luz', 'apagón', 'corriente' cuentan igual; etc.). Si tu primera consulta devuelve 0 resultados, LLÁMALA DE NUEVO SIN FILTRO para ver toda la lista del alojamiento y busca tú mismo por relación semántica antes de decir 'no hay reporte'. No requiere confirmación.",
    input_schema: {
      type: "object",
      properties: {
        filtro: { type: "string", description: "Opcional: palabra clave para filtrar por título/descripción (ej. 'hormigas', 'aire', 'agua'). Vacío = todos los del alojamiento." },
      },
    },
  },
  {
    name: "crear_incidencia",
    description: "Crea una incidencia (limpieza / mantenimiento / insumos) en el módulo Incidencias. SÓLO se expone en modo ADMIN. La incidencia queda registrada SIN reserva asignada. Los campos 'Motivos' y 'Clasificacion' se autoclasifican en el backend a partir de la descripción — tú solo pasa alojamiento_shortcode, descripcion y criticidad.",
    input_schema: {
      type: "object",
      properties: {
        alojamiento_shortcode: { type: "string", description: "Código corto o internal_name del alojamiento tal como lo escribió el admin (ej. 'jc2', 'mt10', 'cu4b'). Case-insensitive." },
        descripcion:           { type: "string", description: "Descripción de la incidencia tal como la reportó el admin, sin adornos." },
        criticidad:            { type: "string", enum: ["critico","alto","medio","bajo"], description: "Nivel de severidad." },
      },
      required: ["alojamiento_shortcode", "descripcion", "criticidad"],
    },
  },
  {
    name: "listar_reservas_sin_ticket",
    description: "Lista las reservas DEL HUÉSPED ACTUAL que aún no tienen ticket de auto-facturación emitido (no tienen 'Folio facturapi'). Solo incluye reservas con estadía iniciada o completada (arrival <= hoy). Devuelve Id, Alojamiento, fechas y total. Úsalo cuando el huésped pregunte por su ticket / factura / autofacturación / CFDI. NO requiere confirmación. Si el resultado es vacío, dile al huésped que todas sus reservas ya están facturadas o que aún no puede facturar una que no ha ocurrido.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "listar_tickets_emitidos",
    description: "Devuelve el ESTADO DE FACTURACIÓN de TODAS las reservas del huésped en UNA sola respuesta: las que ya tienen ticket emitido (con folio+URL) Y las que aún no. Cada item trae 'estado': 'emitido' | 'pendiente' | 'no_elegible' (no elegible = arrival futuro, cancelada o sin cargo). Úsalo cuando el huésped pida un resumen de sus tickets/facturas, quiera saber cuáles ya tiene y cuáles faltan, o pregunte por folios/URLs. Presenta la lista completa al huésped en un solo mensaje (marca claramente cuáles ya emitidas y cuáles pendientes, ofreciendo tramitar las pendientes si aplica).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "solicitar_late_checkout",
    description: "Registra una solicitud de LATE CHECKOUT (salida más tarde de la hora habitual). Requiere APROBACIÓN del admin — no confirmes al huésped que está aprobado; solo di 'se envió al equipo para revisar disponibilidad'. Usa después de confirmar la hora deseada con el huésped.",
    input_schema: {
      type: "object",
      properties: {
        hora_nueva: { type: "string", description: "Nueva hora de salida en formato HH:MM (24h). Ej: '15:00'." },
        notas:      { type: "string", description: "Cualquier detalle relevante que el huésped mencionó." },
      },
      required: ["hora_nueva"],
    },
  },
  {
    name: "solicitar_early_checkin",
    description: "Registra una solicitud de EARLY CHECK-IN (llegar antes de la hora habitual). Requiere APROBACIÓN del admin — no confirmes al huésped que está aprobado; solo di 'se envió al equipo para revisar disponibilidad'. Usa después de confirmar la hora deseada con el huésped.",
    input_schema: {
      type: "object",
      properties: {
        hora_llegada: { type: "string", description: "Hora de llegada solicitada en formato HH:MM (24h). Ej: '11:00'." },
        fecha:        { type: "string", description: "Fecha de llegada YYYY-MM-DD (si difiere de la reserva)." },
        notas:        { type: "string", description: "Cualquier detalle relevante." },
      },
      required: ["hora_llegada"],
    },
  },
  {
    name: "solicitar_insumos",
    description: "Registra una solicitud de INSUMOS extra (toallas, sábanas, café, jabón, papel, almohadas, etc.). NO requiere aprobación — solo el admin marca 'atendido' cuando entrega. Usa después de listar exactamente qué pide el huésped.",
    input_schema: {
      type: "object",
      properties: {
        articulos: { type: "string", description: "Lista concreta de artículos pedidos (ej. '2 toallas de baño + 1 juego de sábanas matrimoniales')." },
      },
      required: ["articulos"],
    },
  },
  {
    name: "solicitar_metodo_pago",
    description: "Registra una solicitud de MÉTODO DE PAGO distinto al default de la reserva (efectivo, transferencia SPEI, pagos en parcialidades, etc.). NO requiere aprobación — el admin coordina y marca 'atendido'.",
    input_schema: {
      type: "object",
      properties: {
        metodo: { type: "string", description: "Método propuesto (ej. 'efectivo', 'transferencia SPEI', 'pagos en 2 exhibiciones')." },
        notas:  { type: "string", description: "Detalle: monto, fechas, referencias, etc." },
      },
      required: ["metodo"],
    },
  },
  {
    name: "solicitar_accion_admin",
    description: "Registra una SOLICITUD GENÉRICA para el admin cuando el huésped pide algo que necesita intervención humana y NO existe una tool específica para ese caso. Ejemplos: early check-in, cambio de reserva, cuna/silla infantil, artículos extra (toallas, sábanas), ajuste de precio, refacturación, etc. Usa SIEMPRE esta tool después de confirmar con el huésped (obtén todos los datos relevantes primero). Persiste en Solicitudes_Pendientes y notifica al admin. NO uses esta tool si el caso tiene tool específica: cotizar_disponibilidad, crear_reporte_mantenimiento, agendar_late_checkout, listar_reservas_sin_ticket, solicitar_ticket_admin, extra_cleaning — ya cubren esos casos.",
    input_schema: {
      type: "object",
      properties: {
        tipo:      { type: "string", description: "Slug corto en snake_case que identifique el tipo (ej. 'early_checkin', 'cambio_reserva', 'articulos_extra', 'ajuste_precio', 'cuna_infantil'). No inventes uno complicado — usa el más corto que describa la petición." },
        resumen:   { type: "string", description: "Descripción completa y auto-contenida de lo que pide el huésped: qué, cuándo, dónde, condiciones. Incluye datos concretos (hora exacta, fechas, cantidades). El admin debe poder entender toda la petición leyendo SOLO este campo." },
        reservaId: { type: "string", description: "Id de reserva Lodgify si aplica (opcional). Extráelo de las reservas activas del huésped." },
      },
      required: ["tipo", "resumen"],
    },
  },
  {
    name: "solicitar_ticket_admin",
    description: "Solicita al admin (vía notificación) que emita el ticket de auto-facturación para UNA reserva específica. Úsalo SÓLO después de que el huésped confirmó explícitamente cuál reserva quiere facturar (elección por Id, no por nombre). NO emite el ticket directamente — solo señaliza al admin. El bot debe responder al huésped 'listo, ya avisé al equipo; en unos minutos te llega el ticket por correo'. No prometas tiempos exactos.",
    input_schema: {
      type: "object",
      properties: {
        reservaId: { type: "string", description: "Lodgify Id (o Id de la reserva) que el huésped eligió facturar." },
      },
      required: ["reservaId"],
    },
  },
  {
    name: "agendar_late_checkout",
    description: "Registra la solicitud de late checkout (salida más tarde) del huésped. Usa esta herramienta SOLO después de que el huésped confirmó explícitamente. ANTES de llamarla, DEBES enviar un mensaje del tipo 'Voy a solicitar tu salida a las HH:MM del DD/MM. ¿Confirmas?' y esperar el 'sí'. NO prometas que está aprobado — sólo queda como solicitud pendiente para que el equipo confirme.",
    input_schema: {
      type: "object",
      properties: {
        hora_nueva: { type: "string", description: "Nueva hora de salida en formato HH:MM (24h). Ej: '15:00'" },
      },
      required: ["hora_nueva"],
    },
  },
];

/** Ejecuta un tool_use devuelto por Claude. Devuelve { content, notifyText }.
 *  ctx = { phone10, fromRaw, booking, alojRow } — el contexto de la reserva
 *  activa del huésped, para saber a qué alojamiento imputar la acción. */
async function _botExecTool(toolUse, ctx) {
  const name = String(toolUse.name || "");
  const args = toolUse.input || {};
  const bk = ctx.booking || {};
  const aloj = ctx.alojRow || {};
  const propiedad = String(bk.Propiedad || aloj.Propiedad || "").trim();
  const depto = String(bk["# Departamento"] || aloj["# Departamento"] || "").trim();
  // Preferir "Propiedad #Depto" (humano) sobre HouseName (a veces trae solo
  // el HouseId numérico) y sobre el HouseId como último recurso.
  const humanoPropDepto = propiedad && depto ? `${propiedad} #${depto}` : (propiedad || "");
  const alojLabel = String(
    bk.Alojamiento
    || humanoPropDepto
    || aloj.HouseName
    || `HouseId ${bk.HouseId || aloj.HouseId || "?"}`
  );
  try {
    if (name === "cotizar_disponibilidad") {
      const url = new URL(`http://127.0.0.1:${PORT}/reservas/search`);
      url.searchParams.set("arrival",   String(args.arrival || ""));
      url.searchParams.set("departure", String(args.departure || ""));
      url.searchParams.set("adults",    String(args.adults || 1));
      const r = await fetch(url.toString(), { cache: "no-store" });
      const j = await r.json();
      if (!j.ok) return { content: `Error consultando disponibilidad: ${j.error || "desconocido"}`, notifyText: null };
      const allResults = j.results || [];
      const top = allResults.slice(0, 5).map(x => ({
        alojamiento: x.name,
        tipo: x.type || "",
        capacidad: x.max_people || null,
        precio_total_mxn: x.total,
        noches: x.nights,
        link_reservar: x.hostedUrl || null,
      }));
      // Link a la página pública /reservas/ con los mismos filtros — para
      // que el huésped abra la vista completa (cards + mapa) en el navegador.
      const publicUrl = new URL("https://www.check-inn.mx/reservas/");
      publicUrl.searchParams.set("rsv_arrival", String(args.arrival || ""));
      publicUrl.searchParams.set("rsv_departure", String(args.departure || ""));
      publicUrl.searchParams.set("rsv_adults", String(args.adults || 1));
      publicUrl.searchParams.set("rsv_go", "1");
      return {
        content: JSON.stringify({
          total_disponibles: allResults.length,
          mostrando_top: top.length,
          hay_mas: allResults.length > top.length,
          fechas: `${args.arrival} → ${args.departure}`,
          huespedes: args.adults,
          alojamientos_top: top,
          link_ver_resultados: publicUrl.toString(),
        }),
        notifyText: null, // cotizar no notifica
      };
    }
    if (name === "consultar_reportes_reserva") {
      const filtro = String(args.filtro || "").trim().toLowerCase();
      const rvId = String(bk.Id || "").trim();
      const propN = String(propiedad || "").toLowerCase().replace(/\s+/g,' ').trim();
      const deptN = String(depto || "").trim();
      const r = await fetch(`http://127.0.0.1:${PORT}/reportes-tecnicos-list`, { cache: "no-store" });
      const j = await r.json();
      const rows = Array.isArray(j.rows) ? j.rows : [];
      // Grupos de sinónimos: si el filtro cae en un grupo, hace match con
      // cualquier término del grupo (evita "insectos" no matchee "hormigas").
      const SYN_GROUPS = [
        ["plaga","plagas","insecto","insectos","bicho","bichos","hormiga","hormigas","cucaracha","cucarachas","mosca","moscas","mosquito","mosquitos","zancudo","zancudos","aran","alacran","alacran","piojo","pulga","pulgas","chinche","chinches","fumigacion"],
        ["aire","clima","ac","a/c","minisplit","aire acondicionado","enfriar"],
        ["agua","fuga","gotera","tuberia","tinaco","boiler","calentador","caliente","fria"],
        ["luz","electrico","electrica","corriente","apagon","apagón","foco","lampara","enchufe","contacto","breaker"],
        ["wifi","internet","red","modem","router","señal","senal"],
        ["gas","estufa","fugagas","fuga de gas"],
        ["ruido","ruidos","musica","fiesta","vecino","vecinos"],
        ["limpieza","sucio","polvo","aseo","cabellos","olor","olores"],
      ];
      const filtroTerms = filtro
        ? (SYN_GROUPS.find(g => g.some(t => filtro.includes(t))) || [filtro])
        : [];
      const matches = rows.filter(row => {
        const rId = String(row.Reservacion_id || "").trim();
        if (rvId && rId && rId === rvId) return true;
        const rp = String(row.Propiedad || "").toLowerCase().replace(/\s+/g,' ').trim();
        const rd = String(row["# Departamento"] || "").trim();
        return propN && rp === propN && (!deptN || rd === deptN);
      }).filter(row => {
        if (!filtroTerms.length) return true;
        const hay = (String(row.Titulo || "") + " " + String(row.Descripcion || "") + " " + String(row.Categoria || "")).toLowerCase();
        return filtroTerms.some(t => hay.includes(t));
      });
      const compact = matches.slice(0, 10).map(r => ({
        folio: r.Folio,
        titulo: r.Titulo,
        descripcion: String(r.Descripcion || "").slice(0, 140),
        estado: r.Estado,
        prioridad: r.Prioridad,
        categoria: r.Categoria,
        fecha: String(r.Fecha || r.Timestamp || "").slice(0, 10),
        solucion: r.Descripcion_solucion || "",
      }));
      return {
        content: JSON.stringify({
          encontrados: matches.length,
          alojamiento: alojLabel,
          filtro: filtro || null,
          reportes: compact,
        }),
        notifyText: null,
      };
    }
    if (name === "crear_reporte_mantenimiento") {
      // Modo admin: si viene alojamiento_shortcode, resolvemos el alojamiento
      // vía catálogo Lodgify + hoja Alojamientos (equivalente a crear_incidencia).
      let rProp = propiedad, rDep = depto, rAloj = alojLabel;
      const sc = String(args.alojamiento_shortcode || "").trim();
      if (ctx.isAdmin && sc) {
        const propsAll = await _lodgifyFetchAllProperties().catch(() => []);
        const scLow = sc.toLowerCase().replace(/\s+/g, "");
        const alojRowsAll = await _botGetAlojRows().catch(() => []);
        const propMatch = propsAll.find(p => String(p.internal_name || "").toLowerCase().replace(/\s+/g,"") === scLow)
                       || propsAll.find(p => String(p.id) === sc);
        if (!propMatch) {
          return { content: JSON.stringify({ ok:false, error: `Shortcode '${sc}' no encontrado` }), notifyText: null };
        }
        const houseId = String(propMatch.id);
        const rowMatch = alojRowsAll.find(r => String(r.HouseId || "") === houseId);
        rProp = (rowMatch && rowMatch.Propiedad) || propMatch.name || sc;
        rDep = (rowMatch && rowMatch["# Departamento"]) || "";
        rAloj = rProp + (rDep ? ` #${rDep}` : "");
      }
      const payload = {
        action: "rt_upsert",
        Fecha: new Date().toISOString().slice(0, 10),
        Estado: "nuevo",
        Prioridad: String(args.prioridad || "P3"),
        Tipo: "correctivo",
        Categoria: String(args.categoria || "otros"),
        Propiedad: rProp,
        "# Departamento": rDep,
        Alojamiento: rAloj,
        Titulo: String(args.titulo || "").slice(0, 80),
        Descripcion: String(args.descripcion || ""),
        Reservacion_id: ctx.isAdmin ? "" : String(bk.Id || ""),
        Huesped_nombre: ctx.isAdmin ? "" : String(bk.GuestName || ""),
        Huesped_contacto: String(ctx.phone10 || ""),
        Reportado_por: ctx.isAdmin ? `Admin (bot) · ${ctx.phone10}` : `bot · huésped ${ctx.phone10}`,
        Updated_by: "wa-bot",
      };
      const r = await fetch(CHECKIN_APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) return { content: `Error al crear reporte: ${j.error || "desconocido"}`, notifyText: null };
      const folio = String(j.folio || j.id || "");
      const nombre = String(bk.GuestName || bk["Nombre reservación"] || "").trim();
      const arr = String(bk.DateArrival || bk["Fecha de ingreso"] || "").slice(0, 10);
      const dep = String(bk.DateDeparture || bk["Fecha de salida"] || "").slice(0, 10);
      const fechas = (arr && dep) ? `${arr} → ${dep}` : (arr || dep || "");
      const medio = String(bk.Source || bk.SourceText || bk.source || "").trim();
      const resumen = `${alojLabel} · ${payload.Prioridad}\n${payload.Titulo}${nombre ? `\nHuésped: ${nombre} (${ctx.phone10})` : `\nHuésped: ${ctx.phone10}`}${fechas ? `\nReserva: ${fechas}` : ""}${medio ? `\nMedio: ${medio}` : ""}${folio ? `\nFolio: ${folio}` : ""}`;
      // Si es P1 (crítico), dispara ADEMÁS la lista de emergencia.
      if (String(payload.Prioridad).toUpperCase() === "P1") {
        _botNotifyEmergency(`🚨 REPORTE CRÍTICO (P1) vía bot\n${resumen}`);
      }
      return {
        content: JSON.stringify({ ok: true, folio, mensaje: "Reporte creado. El equipo lo atenderá pronto." }),
        notifyText: `🔧 Nuevo reporte de mantenimiento vía bot\n${resumen}`,
      };
    }
    // Helper compartido para tickets. Combina bookings (Reservas_Lodgify) con
    // huRows (Reservaciones). Los datos de facturación viven en huRows —
    // se indexan por 'Lodgify Id' o por (fechas + tel).
    async function _factReservasMerged(phone10) {
      const r = await fetch(`http://127.0.0.1:${PORT}/bookings-by-guest?phone=${encodeURIComponent(phone10)}`);
      const j = await r.json();
      const bookings = (j && j.ok && Array.isArray(j.bookings)) ? j.bookings : [];
      const huRows = Array.isArray(j.huRows) ? j.huRows : [];
      function _toIso(v) {
        const s = String(v || '');
        const m1 = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;
        const m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (m2) return `${m2[3]}-${String(m2[1]).padStart(2,'0')}-${String(m2[2]).padStart(2,'0')}`;
        return '';
      }
      // Indexar huRows por Lodgify Id — la vía autoritativa.
      const huById = {};
      for (const h of huRows) {
        const lid = String(h['Lodgify Id'] || h['lodgify_id'] || '').trim();
        if (lid) huById[lid] = h;
      }
      // También mantenemos huRows "huérfanos" (sin Lodgify Id) — son manuales
      // que no matchean con Reservas_Lodgify. Los devolvemos aparte para que
      // no se pierdan cuando el huésped pregunte por sus tickets.
      const items = bookings.map(b => {
        const id = String(b.Id || b.LodgifyId || '');
        const hu = huById[id] || {};
        const folio = String(hu['Folio facturapi'] || hu['Folio Facturapi'] || '').trim();
        const url   = String(hu['Ticket facturapi url'] || hu['ticket facturapi url'] || '').trim();
        return {
          Id: id,
          Alojamiento: String(b.HouseName || (b.Propiedad ? `${b.Propiedad}${b['# Departamento'] ? ' #' + b['# Departamento'] : ''}` : '') || `HouseId ${b.HouseId || '?'}`),
          DateArrival: _toIso(b.DateArrival),
          DateDeparture: _toIso(b.DateDeparture),
          TotalAmount: Number(b.TotalAmount) || 0,
          Currency: String(b.Currency || 'MXN'),
          Status: String(b.Status || ''),
          FolioFacturapi: folio,
          TicketUrl: url,
        };
      });
      // Agregar huRows huérfanos con folio como items "manuales".
      for (const h of huRows) {
        const lid = String(h['Lodgify Id'] || h['lodgify_id'] || '').trim();
        if (lid) continue;
        const folio = String(h['Folio facturapi'] || h['Folio Facturapi'] || '').trim();
        const url   = String(h['Ticket facturapi url'] || '').trim();
        if (!folio && !url) continue;
        items.push({
          Id: '',
          Alojamiento: String(h['Propiedad'] || h['Alojamiento'] || 'Manual'),
          DateArrival: _toIso(h['Fecha de ingreso'] || h['Ingreso']),
          DateDeparture: _toIso(h['Fecha de salida'] || h['Salida']),
          TotalAmount: Number(h['$ Monto facturado Total'] || h['Monto']) || 0,
          Currency: 'MXN',
          Status: 'Manual',
          FolioFacturapi: folio,
          TicketUrl: url,
        });
      }
      return items;
    }
    if (name === "listar_reservas_sin_ticket") {
      try {
        const items = await _factReservasMerged(ctx.phone10);
        const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Mexico_City' });
        const elegibles = items.filter(x => {
          if (!x.DateArrival || x.DateArrival > hoy) return false; // aún no inicia
          const st = String(x.Status || '').toLowerCase();
          if (['declined','cancelled','canceled','deleted','tentative'].includes(st)) return false;
          return !x.FolioFacturapi && !x.TicketUrl;
        }).map(({ Status, ...rest }) => rest);
        return { content: JSON.stringify({ ok: true, count: elegibles.length, items: elegibles }) };
      } catch (e) {
        return { content: JSON.stringify({ ok: false, error: e.message }) };
      }
    }
    if (name === "listar_tickets_emitidos") {
      try {
        const items = await _factReservasMerged(ctx.phone10);
        const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Mexico_City' });
        const enriched = items.map(x => {
          let estado;
          if (x.FolioFacturapi || x.TicketUrl) estado = 'emitido';
          else {
            const st = String(x.Status || '').toLowerCase();
            const cancel = ['declined','cancelled','canceled','deleted','tentative'].includes(st);
            const futuro = !x.DateArrival || x.DateArrival > hoy;
            estado = (cancel || futuro) ? 'no_elegible' : 'pendiente';
          }
          const { Status, ...rest } = x;
          return { ...rest, estado };
        });
        // Construir formatted_message determinístico — Claude Sonnet 5 tiende a
        // comprimir listas largas; entregamos el texto ya armado y en el prompt
        // le decimos que lo envíe verbatim.
        const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
        function fmtRango(a, b) {
          if (!a && !b) return '';
          const p = (s) => { const m = String(s||'').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? { y:+m[1], mo:+m[2], d:+m[3] } : null; };
          const A = p(a), B = p(b);
          if (A && B && A.y === B.y && A.mo === B.mo) return `${String(A.d).padStart(2,'0')}-${String(B.d).padStart(2,'0')} ${meses[A.mo-1]}`;
          if (A && B) return `${String(A.d).padStart(2,'0')} ${meses[A.mo-1]} - ${String(B.d).padStart(2,'0')} ${meses[B.mo-1]}`;
          if (A) return `${String(A.d).padStart(2,'0')} ${meses[A.mo-1]}`;
          return '';
        }
        function fmtMonto(n) {
          const v = Number(n) || 0;
          if (v === 0) return '$0';
          return '$' + v.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
        const linesText = enriched.map((x, i) => {
          const parts = [String(x.Alojamiento || '').trim()];
          const rango = fmtRango(x.DateArrival, x.DateDeparture);
          if (rango) parts.push(rango);
          if (x.TotalAmount != null && x.TotalAmount !== '') parts.push(fmtMonto(x.TotalAmount));
          if (x.FolioFacturapi) parts.push('Folio ' + String(x.FolioFacturapi));
          if (x.TicketUrl) parts.push(String(x.TicketUrl));
          let line = `${i + 1}. ${parts.filter(Boolean).join(' — ')}`;
          if (x.estado === 'pendiente') line += ' (pendiente)';
          else if (x.estado === 'no_elegible') line += ' (no aplica)';
          return line;
        });
        const hayPendientes = enriched.some(x => x.estado === 'pendiente');
        const formatted_message = [
          'Aquí tienes tus tickets emitidos:',
          '',
          ...linesText,
          ...(hayPendientes ? ['', '¿Quieres que tramite ticket para alguna de las pendientes?'] : []),
        ].join('\n');
        // Devolvemos SOLO formatted_message (+count) para minimizar tokens
        // que Claude tiene que procesar en la vuelta 2 (el items array duplicaba
        // la información y aumentaba el riesgo de exceder max_tokens).
        return { content: JSON.stringify({ ok: true, count: enriched.length, formatted_message }) };
      } catch (e) {
        return { content: JSON.stringify({ ok: false, error: e.message }) };
      }
    }
    // Helper: registra en Solicitudes_Pendientes + arma notifyText común
    async function _regSolicitud(tipo, resumen, reservaId) {
      const nombre = String(bk.GuestName || '').trim();
      const notifyText = `📌 SOLICITUD (${tipo}) vía bot\nPhone: +${ctx.phone10}${nombre?` · ${nombre}`:''}${reservaId?`\nReserva: ${reservaId}`:''}\n\n${resumen}`;
      try {
        fetch(`http://127.0.0.1:${PORT}/solicitudes`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payload: { Phone: ctx.phone10, Tipo: tipo, ReservaId: reservaId || '', Resumen: resumen } }),
        }).catch(()=>{});
      } catch(_){}
      return notifyText;
    }
    if (name === "solicitar_late_checkout") {
      const hora = String(args.hora_nueva || '').trim();
      if (!hora) return { content: JSON.stringify({ ok:false, error:'hora_nueva requerida' }) };
      const notas = String(args.notas || '').trim();
      const arrival = String(bk.DateArrival || bk['Fecha de ingreso'] || '').slice(0,10);
      const departure = String(bk.DateDeparture || bk['Fecha de salida'] || '').slice(0,10);
      const reservaId = String(bk.Id || '');
      const resumen = `Late check-out hasta ${hora}${departure?` el ${departure}`:''}${arrival?` (reserva ${arrival}→${departure})`:''}${notas?`\nNotas: ${notas}`:''}`;
      const notifyText = await _regSolicitud('late_checkout', resumen, reservaId);
      return { content: JSON.stringify({ ok:true, mensaje:'Solicitud registrada. Requiere aprobación del equipo.' }), notifyText };
    }
    if (name === "solicitar_early_checkin") {
      const hora = String(args.hora_llegada || '').trim();
      if (!hora) return { content: JSON.stringify({ ok:false, error:'hora_llegada requerida' }) };
      const fecha = String(args.fecha || bk.DateArrival || bk['Fecha de ingreso'] || '').slice(0,10);
      const notas = String(args.notas || '').trim();
      const reservaId = String(bk.Id || '');
      const resumen = `Early check-in a las ${hora}${fecha?` el ${fecha}`:''}${notas?`\nNotas: ${notas}`:''}`;
      const notifyText = await _regSolicitud('early_checkin', resumen, reservaId);
      return { content: JSON.stringify({ ok:true, mensaje:'Solicitud registrada. Requiere aprobación del equipo.' }), notifyText };
    }
    if (name === "solicitar_insumos") {
      const articulos = String(args.articulos || '').trim();
      if (!articulos) return { content: JSON.stringify({ ok:false, error:'articulos requerido' }) };
      const reservaId = String(bk.Id || '');
      const resumen = `Insumos solicitados: ${articulos}`;
      const notifyText = await _regSolicitud('insumos', resumen, reservaId);
      return { content: JSON.stringify({ ok:true, mensaje:'Solicitud registrada.' }), notifyText };
    }
    if (name === "solicitar_metodo_pago") {
      const metodo = String(args.metodo || '').trim();
      if (!metodo) return { content: JSON.stringify({ ok:false, error:'metodo requerido' }) };
      const notas = String(args.notas || '').trim();
      const reservaId = String(bk.Id || '');
      const resumen = `Método de pago propuesto: ${metodo}${notas?`\nNotas: ${notas}`:''}`;
      const notifyText = await _regSolicitud('metodo_pago', resumen, reservaId);
      return { content: JSON.stringify({ ok:true, mensaje:'Solicitud registrada.' }), notifyText };
    }
    if (name === "solicitar_accion_admin") {
      const tipo = String(args.tipo || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g,'_').replace(/^_+|_+$/g,'') || 'otro';
      const resumen = String(args.resumen || '').trim();
      const reservaId = String(args.reservaId || '').trim();
      if (!resumen) return { content: JSON.stringify({ ok: false, error: 'resumen requerido' }) };
      const nombre = String(bk.GuestName || '').trim();
      const notifyText = `📌 SOLICITUD (${tipo}) vía bot\nPhone: +${ctx.phone10}${nombre?` · ${nombre}`:''}${reservaId?`\nReserva: ${reservaId}`:''}\n\n${resumen}`;
      try {
        fetch(`http://127.0.0.1:${PORT}/solicitudes`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payload: {
            Phone: ctx.phone10,
            Tipo: tipo,
            ReservaId: reservaId,
            Resumen: resumen,
          }}),
        }).catch(()=>{});
      } catch(_){}
      return {
        content: JSON.stringify({ ok: true, mensaje: "Solicitud registrada. El admin recibió la notificación." }),
        notifyText,
      };
    }
    if (name === "solicitar_ticket_admin") {
      const reservaId = String(args.reservaId || '').trim();
      if (!reservaId) return { content: JSON.stringify({ ok: false, error: 'reservaId requerido' }) };
      // Enriquecer con datos de la reserva para el resumen del admin.
      let bkResumen = 'Reserva ' + reservaId;
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/lodgify-list`);
        const j = await r.json();
        const bk = (j && Array.isArray(j.bookings) ? j.bookings : []).find(x => String(x.Id) === reservaId);
        if (bk) {
          const aloj = String(bk.HouseName || `HouseId ${bk.HouseId || '?'}`);
          const arr = String(bk.DateArrival || '').slice(0,10);
          const dep = String(bk.DateDeparture || '').slice(0,10);
          const tot = Number(bk.TotalAmount) || 0;
          const cur = String(bk.Currency || 'MXN');
          const nombre = String(bk.GuestName || '').trim();
          bkResumen = `${aloj} · ${arr} → ${dep} · Total $${tot.toLocaleString('es-MX',{minimumFractionDigits:2,maximumFractionDigits:2})} ${cur}${nombre?` · Huésped: ${nombre}`:''} · Id: ${reservaId}`;
        }
      } catch(_){}
      const notifyText = `📄 SOLICITUD de ticket auto-facturación vía bot\nPhone: +${ctx.phone10}\n${bkResumen}\n\nAcción sugerida: emitir el ticket en Facturapi y verificar envío por correo.`;
      // Persistir en hoja Solicitudes_Pendientes (fire-and-forget — no bloquea
      // el reply al huésped si Apps Script tarda).
      try {
        fetch(`http://127.0.0.1:${PORT}/solicitudes`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payload: {
            Phone: ctx.phone10,
            Tipo: 'ticket_autofacturacion',
            ReservaId: reservaId,
            Resumen: bkResumen,
          }}),
        }).catch(()=>{});
      } catch(_){}
      return {
        content: JSON.stringify({ ok: true, mensaje: "Solicitud registrada. El admin recibió la notificación." }),
        notifyText,
      };
    }
    if (name === "agendar_late_checkout") {
      const hora = String(args.hora_nueva || "").trim();
      const arrival = String(bk["Fecha de ingreso"] || "").slice(0, 10);
      const payload = {
        action: "wa_set_late_checkout",
        phone: ctx.phone10,
        arrival,
        hora_nueva: hora,
      };
      const r = await fetch(CHECKIN_APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      });
      const rawTxt = await r.text();
      let j; try { j = JSON.parse(rawTxt); } catch(_) { j = { ok:false, error: "respuesta no-JSON: " + rawTxt.slice(0,120) }; }
      console.info(`[bot-tool late_checkout] AS response: ${JSON.stringify(j).slice(0,300)}`);
      if (!j.ok) return { content: `No pude registrar el cambio: ${j.error || "desconocido"}`, notifyText: null };
      const nombreLc = String(bk.GuestName || bk["Nombre reservación"] || "").trim();
      const arrLc = String(bk.DateArrival || bk["Fecha de ingreso"] || "").slice(0, 10);
      const depLc = String(bk.DateDeparture || bk["Fecha de salida"] || "").slice(0, 10);
      const fechasLc = (arrLc && depLc) ? `${arrLc} → ${depLc}` : (arrLc || depLc || "");
      const medioLc = String(bk.Source || bk.SourceText || bk.source || "").trim();
      return {
        content: JSON.stringify({ ok: true, hora, mensaje: "Solicitud registrada. Queda pendiente de confirmación por el equipo." }),
        notifyText: `🕐 Solicitud de late checkout vía bot\n${alojLabel}\nNueva hora: ${hora}${nombreLc ? `\nHuésped: ${nombreLc} (${ctx.phone10})` : `\nHuésped: ${ctx.phone10}`}${fechasLc ? `\nReserva: ${fechasLc}` : ""}${medioLc ? `\nMedio: ${medioLc}` : ""}`,
      };
    }
    if (name === "crear_incidencia") {
      const shortcode = String(args.alojamiento_shortcode || "").trim();
      const descripcion = String(args.descripcion || "").trim();
      const criticidad = String(args.criticidad || "medio").toLowerCase();
      if (!shortcode || !descripcion) {
        return { content: JSON.stringify({ ok:false, error:"Faltan alojamiento_shortcode o descripcion" }), notifyText: null };
      }
      // 1) Resolver alojamiento por internal_name (Lodgify) contra el
      //    catálogo local. Usamos la lista completa paginada.
      const propsAll = await _lodgifyFetchAllProperties().catch(() => []);
      const scLow = shortcode.toLowerCase().replace(/\s+/g, "");
      const alojRows = await _botGetAlojRows().catch(() => []);
      // Matcheo por internal_name (Lodgify) y por HouseId como fallback.
      const propMatch = propsAll.find(p => String(p.internal_name || "").toLowerCase().replace(/\s+/g,"") === scLow)
                     || propsAll.find(p => String(p.id) === shortcode);
      const houseId = propMatch ? String(propMatch.id) : "";
      const rowMatch = houseId
        ? alojRows.find(r => String(r.HouseId || "") === houseId)
        : null;
      const propiedad = (rowMatch && rowMatch.Propiedad) || (propMatch && propMatch.name) || shortcode;
      const depto = (rowMatch && rowMatch["# Departamento"]) || "";
      const alojLabel = propiedad + (depto ? ` #${depto}` : "");
      if (!propMatch) {
        const validos = alojRows
          .map(r => String(r.internal_name || r.HouseName || "").trim())
          .filter(Boolean).slice(0, 20).join(", ");
        return { content: JSON.stringify({ ok:false, error:`Shortcode '${shortcode}' no encontrado. Válidos (parcial): ${validos}` }), notifyText: null };
      }
      // 2) Autoclasificar Motivos + Clasificacion via LLM.
      const clas = await _botAutoClasificarIncidencia(descripcion);
      // 3) Mapear criticidad al enum del módulo (Baja/Media/Alta/Crítica).
      const nivelMap = { critico: "Crítica", alto: "Alta", medio: "Media", bajo: "Baja" };
      const nivel = nivelMap[criticidad] || "Media";
      // 4) Guardar via /save-incidencia (Apps Script). Sin reserva asignada.
      const payload = {
        Fecha: new Date().toISOString().slice(0,10),
        Propiedad: propiedad,
        "# Departamento": depto,
        Alojamiento: alojLabel,
        Personas: "",
        Motivos: (clas.motivos || []).join(", "),
        Clasificacion: (clas.clasificaciones || []).join(", "),
        Nivel: nivel,
        Estatus: "Abierta",
        Reportante: `Admin (bot) · ${ctx.phone10}`,
        Descripcion: descripcion,
        Acciones: "",
        Seguimiento: "",
      };
      const r = await fetch(`http://127.0.0.1:${PORT}/save-incidencia`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload }),
      });
      const j = await r.json();
      if (!j.ok) return { content: JSON.stringify({ ok:false, error: j.error || "Error backend" }), notifyText: null };
      const id = j.id || "";
      return {
        content: JSON.stringify({
          ok: true, id, alojamiento: alojLabel, nivel,
          motivos: clas.motivos, clasificaciones: clas.clasificaciones,
          mensaje: `Incidencia ${id} registrada.`,
        }),
        notifyText: `📋 Incidencia via bot admin\n${alojLabel} · ${nivel}\n${(clas.motivos||[]).join(", ")} · ${(clas.clasificaciones||[]).join(", ")}\n${descripcion.slice(0,140)}\nFolio: ${id}`,
      };
    }
    return { content: `Tool desconocida: ${name}`, notifyText: null };
  } catch (e) {
    console.error(`[bot-tool ${name}] error:`, e.message);
    return { content: `Error ejecutando ${name}: ${e.message}`, notifyText: null };
  }
}

// ─── Autoclasificación Motivos/Clasificacion ───────────────────────────────
// Enum canónico — DEBE mantenerse sincronizado con app.js INC_CLASIF_POR_MOTIVO.
const _BOT_INC_ENUM = {
  Limpieza:     ["Baño sucio","Sábanas sucias","Basura detectada","Plaga o insectos"],
  Mantenimiento:["Fuga de agua","Falla eléctrica","Falla de electrodomésticos","Ausencia de controles"],
  Insumos:      ["Toallas faltantes","Pilas faltantes","Productos de limpieza faltantes"],
};
async function _botAutoClasificarIncidencia(descripcion) {
  const enumTxt = Object.entries(_BOT_INC_ENUM)
    .map(([m, list]) => `${m}: ${list.join(" | ")}`).join("\n");
  const system = `Eres un clasificador. Recibes la descripción de una incidencia y devuelves JSON estricto con los motivos y clasificaciones aplicables del enum. Sin texto extra.

ENUM:
${enumTxt}

Reglas:
- "motivos" es un subconjunto de: Limpieza, Mantenimiento, Insumos.
- "clasificaciones" solo puede contener valores del ENUM de los motivos elegidos.
- Puedes elegir múltiples si la descripción cubre varios (ej. "baño sucio y sin papel" → motivos:[Limpieza,Insumos]).
- Si NADA aplica claramente, devuelve {"motivos":[],"clasificaciones":[]}.
- Respuesta EXCLUSIVA: JSON válido, sin markdown.`;
  try {
    const out = await _llmChat({
      system,
      history: [],
      userMsg: `Descripción: "${descripcion}"\nDevuelve JSON.`,
    });
    const txt = String(out.text || "").trim();
    const json = txt.replace(/^```json?\s*|\s*```$/g, "");
    const parsed = JSON.parse(json);
    return {
      motivos: Array.isArray(parsed.motivos) ? parsed.motivos.filter(m => _BOT_INC_ENUM[m]) : [],
      clasificaciones: Array.isArray(parsed.clasificaciones) ? parsed.clasificaciones.filter(c =>
        Object.values(_BOT_INC_ENUM).some(list => list.includes(c))
      ) : [],
    };
  } catch (e) {
    console.warn("[bot-autoclas] fallo:", e.message);
    return { motivos: [], clasificaciones: [] };
  }
}

// ─── Transcripción audio WhatsApp (Google Cloud Speech-to-Text) ────────────
// Descarga el audio de Twilio (basic auth), lo pasa a Speech-to-Text v1
// en modelo "latest_long" con español y devuelve el texto.
let _gcpSpeechClient = null;
function _getSpeechClient() {
  if (_gcpSpeechClient) return _gcpSpeechClient;
  // Lazy require para no penalizar el cold-start del container si nunca
  // llega un audio.
  const { SpeechClient } = require("@google-cloud/speech");
  _gcpSpeechClient = new SpeechClient();
  return _gcpSpeechClient;
}
async function _transcribeTwilioAudio(mediaUrl, mimeType) {
  // Twilio media URLs requieren basic auth. Aceptamos dos esquemas:
  //   (a) Account SID + Auth Token (clásico).
  //   (b) API Key SID + API Key Secret (mejor, se puede rotar sin tumbar
  //       el account). En este proyecto usamos (b).
  const keySid  = process.env.TWILIO_API_KEY_SID;
  const keySec  = process.env.TWILIO_API_KEY_SECRET;
  const acctSid = process.env.TWILIO_ACCOUNT_SID;
  const token   = process.env.TWILIO_AUTH_TOKEN;
  let user, pass;
  if (keySid && keySec) { user = keySid; pass = keySec; }
  else if (acctSid && token) { user = acctSid; pass = token; }
  else throw new Error("Twilio creds faltan (API_KEY_SID+SECRET o ACCOUNT_SID+AUTH_TOKEN)");
  const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  const r = await fetch(mediaUrl, { headers: { Authorization: auth }, redirect: "follow" });
  if (!r.ok) throw new Error(`Twilio media ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  // Twilio WhatsApp manda audio en ogg/opus. Google Speech acepta OGG_OPUS
  // sin sampleRateHertz (lo detecta del header). Para otros formatos
  // (mpeg, wav) usamos ENCODING_UNSPECIFIED + autoDecodingConfig.
  const mt = String(mimeType || "").toLowerCase();
  const encoding = mt.includes("ogg") ? "OGG_OPUS"
                 : mt.includes("wav") ? "LINEAR16"
                 : mt.includes("mpeg") || mt.includes("mp3") ? "MP3"
                 : "ENCODING_UNSPECIFIED";
  const client = _getSpeechClient();
  const config = {
    encoding,
    languageCode: "es-MX",
    alternativeLanguageCodes: ["es-US", "es-ES"],
    enableAutomaticPunctuation: true,
    model: "latest_long",
  };
  // WhatsApp/Twilio: notas de voz vienen como Opus mono 48 kHz. Google
  // exige sampleRateHertz explícito para OGG_OPUS.
  if (encoding === "OGG_OPUS") config.sampleRateHertz = 48000;
  const [resp] = await client.recognize({
    audio: { content: buf.toString("base64") },
    config,
  });
  const text = (resp.results || [])
    .map(r => (r.alternatives && r.alternatives[0] && r.alternatives[0].transcript) || "")
    .filter(Boolean).join(" ").trim();
  return text;
}

// ─── Mutex por teléfono ────────────────────────────────────────────────────
// Serializa el procesamiento de mensajes entrantes por número. Sin esto,
// dos notas de voz consecutivas del mismo huésped se procesan en paralelo:
// la 2da leve el historial ANTES de que la 1ra haya persistido su
// respuesta, así el bot "olvida" datos y repregunta.
const _bot_phone_locks = new Map(); // phone10 → Promise
async function _botLockPhone(phone10, fn) {
  const prev = _bot_phone_locks.get(phone10) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  _bot_phone_locks.set(phone10, next);
  try { return await next; }
  finally {
    if (_bot_phone_locks.get(phone10) === next) _bot_phone_locks.delete(phone10);
  }
}

// ─── Modo prueba por admin ─────────────────────────────────────────────────
// Un admin puede activar temporalmente que se le trate como huésped
// enviando "modo prueba" (útil para probar el flujo huésped desde su
// propio número). "modo admin" lo restaura. Estado en memoria — se
// pierde en restart del container y vuelve a admin (default).
const _bot_admin_guest_mode = new Map(); // phone10 → boolean

// ─── Detección admin por teléfono (cachea 5min) ────────────────────────────
const _bot_admin_cache = new Map(); // phone10 → { isAdmin, nombre, t }
async function _botIsAdminPhone(phone10) {
  const cached = _bot_admin_cache.get(phone10);
  if (cached && (Date.now() - cached.t) < 5 * 60_000) return cached;
  try {
    const url = `${CHECKIN_APPS_SCRIPT_URL}?action=bot_is_admin_phone&phone10=${encodeURIComponent(phone10)}`;
    const r = await fetch(url);
    const j = await r.json();
    const rec = { isAdmin: !!j.isAdmin, nombre: String(j.nombre || ""), t: Date.now() };
    _bot_admin_cache.set(phone10, rec);
    return rec;
  } catch (e) {
    console.warn("[bot-admin] check fallo:", e.message);
    return { isAdmin: false, nombre: "", t: Date.now() };
  }
}

/** Notifica al admin (WhatsApp) sobre una acción automática del bot.
 *  Requiere env ADMIN_NOTIFY_PHONE (formato E.164, ej: +528444443922).
 *  Si falta, solo loguea. */
async function _botNotifyAdmin(text) {
  const to = String(process.env.ADMIN_NOTIFY_PHONE || "").trim();
  if (!to) { console.info("[bot-notify] ADMIN_NOTIFY_PHONE no configurado — solo log:", text); return; }
  try {
    await _twilioSendMessage({ to: `whatsapp:${to}`, body: text, skipMirror: true });
  } catch (e) { console.warn("[bot-notify] falló:", e.message); }
}

/** Loop de resolución de tools: llama LLM, ejecuta tool si Claude lo pide,
 *  vuelve a llamar con el resultado, hasta obtener respuesta de texto
 *  (o hit del cap de 4 iteraciones). Devuelve { text, toolsUsed }. */
async function _botLlmLoop({ system, history, userMsg, ctx, tools }) {
  const runMessages = (history || []).map(m => ({ role: m.role, content: String(m.body || m.content || "") }));
  runMessages.push({ role: "user", content: String(userMsg || "") });
  const toolsUsed = [];
  // Si no se pasa tools, exponemos BOT_TOOLS excepto crear_incidencia
  // (esa es exclusiva del modo admin — el modo huésped no debe verla).
  const activeTools = Array.isArray(tools) && tools.length
    ? tools
    : BOT_TOOLS.filter(t => t.name !== "crear_incidencia");
  for (let iter = 0; iter < 4; iter++) {
    const body = {
      model: BOT_ANTHROPIC_MODEL,
      max_tokens: BOT_ANTHROPIC_MAX_TOKENS,
      system: String(system || ""),
      messages: runMessages,
      tools: activeTools,
    };
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Claude HTTP ${r.status}: ${j.error?.message || JSON.stringify(j).slice(0,200)}`);
    const parts = j.content || [];
    if (j.stop_reason !== "tool_use") {
      const txt = parts.filter(p => p.type === "text").map(p => p.text).join("\n").trim();
      if (!txt) {
        // Log detallado para diagnosticar texto vacío persistente.
        try {
          console.warn(`[llm-empty] stop=${j.stop_reason} parts=${JSON.stringify(parts).slice(0,500)} usage=${JSON.stringify(j.usage||{})} msgs=${runMessages.length}`);
        } catch(_){}
      }
      return { text: txt, toolsUsed, stopReason: j.stop_reason || "" };
    }
    // Agregar la respuesta del assistant tal cual (con tool_use blocks).
    runMessages.push({ role: "assistant", content: parts });
    const toolResults = [];
    for (const p of parts) {
      if (p.type !== "tool_use") continue;
      const exec = await _botExecTool(p, ctx);
      toolsUsed.push({ name: p.name, args: p.input, notifyText: exec.notifyText });
      toolResults.push({
        type: "tool_result",
        tool_use_id: p.id,
        content: String(exec.content || ""),
      });
    }
    runMessages.push({ role: "user", content: toolResults });
  }
  return { text: "", toolsUsed };
}

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
// Lista predeterminada del piloto — se restaura en cada arranque del
// servicio (memoria in-memory). Editable desde la UI "Modo prueba" y esos
// cambios sobreviven hasta el próximo redeploy de Cloud Run.
let _BOT_TEST_MODE = { enabled: true, phones: ["+528444443922", "+528115569120", "+528110208743", "+528442798802"] };
// Lista in-memory de números que reciben notificación EXTRA cuando un
// proceso crítico se ejecuta (por ahora: reporte P1). Se administra
// desde la UI del módulo Chats bot (barra "Emergencia").
let _BOT_EMERGENCY = { phones: [] };
app.get("/wa/bot/emergency-phones", (req, res) => {
  res.json({ ok: true, phones: (_BOT_EMERGENCY.phones || []).slice() });
});
app.post("/wa/bot/emergency-phones", (req, res) => {
  const b = req.body || {};
  if (Array.isArray(b.phones)) {
    _BOT_EMERGENCY.phones = b.phones.map(p => String(p||'').trim()).filter(Boolean);
  }
  console.info(`[bot-emergency] phones=${JSON.stringify(_BOT_EMERGENCY.phones)}`);
  res.json({ ok: true, phones: _BOT_EMERGENCY.phones });
});
/** Reenvía un texto a TODOS los números de la lista de emergencia. */
async function _botNotifyEmergency(text) {
  const list = (_BOT_EMERGENCY.phones || []).filter(Boolean);
  if (!list.length) { console.info("[bot-emergency] lista vacía — skip"); return; }
  for (const p of list) {
    try { await _twilioSendMessage({ to: `whatsapp:${p}`, body: text, skipMirror: true }); }
    catch (e) { console.warn(`[bot-emergency] falló ${p}:`, e.message); }
  }
}
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
  let bodyMsg = String(b.Body || "").trim();
  if (!fromRaw) return;
  const phone10 = fromRaw.replace(/\D/g, "").slice(-10);
  if (!phone10) return;
  // Serializar por teléfono: garantiza que mensajes del mismo huésped se
  // procesen en orden estricto (crítico para que el bot vea el historial
  // completo antes de responder al siguiente turno).
  await _botLockPhone(phone10, async () => {
  // Multimedia: si Twilio manda audio, lo transcribimos y usamos el
  // texto como si el usuario lo hubiera escrito. Para imagen/video
  // dejamos aviso (aún sin procesar) para no perder el mensaje.
  let bodyAlreadyPersisted = false;
  const numMedia = parseInt(String(b.NumMedia || "0"), 10) || 0;
  if (!bodyMsg && numMedia > 0) {
    const mediaType = String(b.MediaContentType0 || "").toLowerCase();
    const mediaUrl = String(b.MediaUrl0 || "");
    if (/audio/.test(mediaType) && mediaUrl) {
      try {
        const t = Date.now();
        const texto = await _transcribeTwilioAudio(mediaUrl, mediaType);
        console.info(`[bot-in] ${phone10}: audio transcrito en ${Date.now()-t}ms · "${(texto||'').slice(0,80)}"`);
        if (texto) {
          // Persistimos el mensaje con la transcripción visible en el panel
          // y le prependemos "🎙" para que el admin sepa que vino de audio.
          _botAppendMessage(phone10, "user", `🎙 ${texto}`, { from: fromRaw, media: true, media_type: mediaType, media_url: mediaUrl, transcribed: true });
          bodyMsg = texto; // continúa el flujo normal (admin o huésped)
          bodyAlreadyPersisted = true; // evita duplicar el user msg abajo
        } else {
          _botAppendMessage(phone10, "user", "[Nota de voz sin voz reconocible]", { from: fromRaw, media: true, media_type: mediaType, media_url: mediaUrl });
          const aviso = "No pude escuchar bien tu nota de voz. ¿Podrías reenviarla o escribir el mensaje? 🙏";
          await _twilioSendMessage({ to: fromRaw, body: aviso, skipMirror: true }).catch(()=>{});
          _botAppendMessage(phone10, "assistant", aviso, { media_notice: true });
          return;
        }
      } catch (e) {
        console.warn("[bot-in] transcripción falló:", e.message);
        _botAppendMessage(phone10, "user", "[Nota de voz — error al transcribir]", { from: fromRaw, media: true, media_type: mediaType, media_url: mediaUrl, error: e.message });
        const aviso = "Recibí tu nota de voz pero no pude transcribirla. ¿Podrías escribirla? 🙏";
        await _twilioSendMessage({ to: fromRaw, body: aviso, skipMirror: true }).catch(()=>{});
        _botAppendMessage(phone10, "assistant", aviso, { media_notice: true });
        return;
      }
    } else {
      const isImage = /image/.test(mediaType);
      const kind = isImage ? "Imagen"
                 : /video/.test(mediaType) ? "Video"
                 : "Archivo adjunto";
      _botAppendMessage(phone10, "user", `[${kind}]`, { from: fromRaw, media: true, media_type: mediaType, media_url: mediaUrl });
      // Imágenes: NO responder al huésped — el admin la analiza desde el
      // panel Chats bot (multi-select → Comprobante de pago, etc.).
      if (!isImage) {
        const aviso = `Recibimos tu ${kind.toLowerCase()}. Por ahora solo procesamos audio y texto — un miembro del equipo lo revisará. 🙏`;
        await _twilioSendMessage({ to: fromRaw, body: aviso, skipMirror: true }).catch(()=>{});
        _botAppendMessage(phone10, "assistant", aviso, { media_notice: true });
      }
      return;
    }
  }
  if (!bodyMsg) return;
  const t0 = Date.now();
  console.info(`[bot-in] ${phone10}: ${bodyMsg.slice(0,80)}`);
  // ─── Modo ADMIN: mensajes que empiezan con "@" desde un número admin ──
  // Ejecución directa sin cortesías. NO se persiste en WA_ChatContext
  // (nunca aparece en Chats bot). Los tools que ejecuta (crear_incidencia,
  // cotizar_disponibilidad, etc.) sí dejan su rastro en sus módulos.
  // Modo ADMIN: DEFAULT para números admin. Cualquier mensaje del admin
  // se procesa en modo admin (con o sin "@").
  // Toggle "modo prueba" → el admin se trata como huésped hasta que diga
  // "modo admin". Estado en memoria (Map global) — se resetea en restart.
  const admCheck = await _botIsAdminPhone(phone10);
  if (admCheck.isAdmin) {
    const low = bodyMsg.toLowerCase().trim();
    // Toggles de modo — cualquiera funciona (mensaje ENTERO, case-insensitive):
    //   Ir a huésped: "@huesped" / "@huésped" / "modo prueba" / "modo test" / "modo huésped" / "modo guest"
    //   Volver a admin: "@admin"   / "modo admin"  / "modo prod" / "modo real" / "modo producción"
    if (/^@?\s*hu[eé]sped$/i.test(low) || /^@?\s*guest$/i.test(low) || /^modo\s+(prueba|test|hu[eé]sped|guest)$/i.test(low)) {
      _bot_admin_guest_mode.set(phone10, true);
      const reply = `OK — ahora te trato como HUÉSPED. Envía "@admin" para volver.`;
      await _twilioSendMessage({ to: fromRaw, body: reply, skipMirror: true }).catch(()=>{});
      if (!bodyAlreadyPersisted) { _botAppendMessage(phone10, "user", bodyMsg, { from: fromRaw, admin: true }); bodyAlreadyPersisted = true; }
      _botAppendMessage(phone10, "assistant", reply, { admin: true, mode_toggle: "guest" });
      return;
    }
    if (/^@?\s*admin$/i.test(low) || /^modo\s+(admin|prod|real|producci[oó]n)$/i.test(low)) {
      _bot_admin_guest_mode.set(phone10, false);
      const reply = `OK — ahora te trato como ADMIN. Envía "@huesped" para probar el flujo huésped.`;
      await _twilioSendMessage({ to: fromRaw, body: reply, skipMirror: true }).catch(()=>{});
      if (!bodyAlreadyPersisted) { _botAppendMessage(phone10, "user", bodyMsg, { from: fromRaw, admin: true }); bodyAlreadyPersisted = true; }
      _botAppendMessage(phone10, "assistant", reply, { admin: true, mode_toggle: "admin" });
      return;
    }
    const isGuestMode = _bot_admin_guest_mode.get(phone10) === true;
    if (!isGuestMode) {
      const adm = admCheck;
      {
      const cmd = bodyMsg.replace(/^@\s*/, "").trim();
      console.info(`[bot-admin] ${phone10} (${adm.nombre}): ${cmd.slice(0,80)}`);
      // Persiste el mensaje admin en WA_ChatContext para que aparezca en
      // el panel Chats bot (con flag admin:true para que el frontend
      // pueda estilizarlo si lo desea).
      if (!bodyAlreadyPersisted) { _botAppendMessage(phone10, "user", bodyMsg, { from: fromRaw, admin: true }); bodyAlreadyPersisted = true; }
      try {
        // Inyecta fecha actual en el system prompt (Claude no la sabe
        // por sí mismo; sin esto interpreta "octubre" como cualquier año).
        const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Mexico_City' });
        const nowYear = new Date().toLocaleDateString('en-US', { timeZone: 'America/Mexico_City', year: 'numeric' });
        const adminPromptsBlock = _botBuildPromptsBlock(await _botGetPrompts());
        const dynSystem = BOT_SYSTEM_PROMPT_ADMIN + adminPromptsBlock + `\n\nCONTEXTO TEMPORAL:\n- HOY es: ${today} (América/Mexico_City).\n- AÑO ACTUAL: ${nowYear}. Úsalo por defecto cuando no se mencione año.`;
        // Historial: solo mensajes admin previos del MISMO teléfono para
        // permitir seguimientos ("Urgente" tras "@reporte..."). Filtramos
        // fuera cualquier mensaje que no sea admin (protege de contaminar
        // el hilo si el mismo número también escribe como huésped).
        let adminHistory = [];
        try {
          const ctxResp = await _botFetchConversation(phone10, 20);
          adminHistory = (ctxResp.messages || [])
            .filter(m => m && m.meta && m.meta.admin === true)
            .slice(-10, -1) // excluir el user actual (recién guardado)
            .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', body: m.body }));
        } catch (_) { adminHistory = []; }
        const llm = await _botLlmLoop({
          system: dynSystem,
          history: adminHistory,
          userMsg: cmd,
          ctx: { phone10, fromRaw, booking: {}, alojRow: {}, isAdmin: true },
          tools: BOT_TOOLS, // modo admin: expone todos, incluida crear_incidencia
        });
        for (const t of (llm.toolsUsed || [])) { if (t.notifyText) _botNotifyAdmin(t.notifyText); }
        const reply = String(llm.text || "").trim() || "OK.";
        await _twilioSendMessage({ to: fromRaw, body: reply, skipMirror: true });
        _botAppendMessage(phone10, "assistant", reply, { model: BOT_ANTHROPIC_MODEL, admin: true, tools: (llm.toolsUsed || []).map(t => t.name) });
        console.info(`[bot-admin] ${phone10}: reply en ${Date.now()-t0}ms · "${reply.slice(0,80)}"`);
      } catch (e) {
        console.error("[bot-admin] error:", e.message);
        await _twilioSendMessage({ to: fromRaw, body: `Error: ${e.message}`, skipMirror: true }).catch(()=>{});
      }
      return;
      }
    } // fin if (!isGuestMode) — admin en modo prueba cae al flujo huésped abajo.
    else {
      console.info(`[bot-in] ${phone10}: admin en modo prueba → flujo huésped`);
    }
  }
  // Modo Prueba: si activo, ignorar mensajes de números no incluidos en la
  // lista whitelisted. Aún guardamos el user msg para verlo en el panel.
  if (_BOT_TEST_MODE.enabled) {
    const allowed = _botTestGetAllowedSet();
    if (!allowed.has(phone10)) {
      console.info(`[bot-in] ${phone10}: TEST MODE — solo responde a [${Array.from(allowed).join(', ')}], skip`);
      if (!bodyAlreadyPersisted) { _botAppendMessage(phone10, "user", bodyMsg, { from: fromRaw }); bodyAlreadyPersisted = true; }
      return;
    }
  }
  try {
    // AWAIT el append del user actual: sin esto, el fetch de conversación
    // corre en paralelo y puede NO ver este mensaje ni los previos si el
    // huésped manda varios mensajes en pocos segundos. Race típica que
    // hacía al bot "olvidar" fechas ya dadas.
    if (!bodyAlreadyPersisted) { await _botAppendMessage(phone10, "user", bodyMsg, { from: fromRaw }); bodyAlreadyPersisted = true; }
    // Intent sensible (queja / reembolso / legal): sólo AUTO-escala si el
    // modo actual es 'bot'. Si el admin ya está en supervised/manual/human,
    // respetamos su modo y sólo dejamos el mensaje visible en el panel.
    const sensitive = _botDetectSensitive(bodyMsg);
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
    // Sensitive + modo bot → auto-escala. En supervised/manual dejamos que
    // el admin lo revise y decida (el mensaje ya está en el panel).
    if (sensitive && String(state.control) === "bot") {
      console.info(`[bot-in] ${phone10}: escalar por sensitive: ${sensitive}`);
      _botEscalate(phone10, `Sensitive intent: ${sensitive}`);
      const msg = "Recibimos tu mensaje. En un momento te contactamos personalmente. 🙏";
      await _twilioSendMessage({ to: fromRaw, body: msg, skipMirror: true }).catch(()=>{});
      _botAppendMessage(phone10, "assistant", msg, { auto_escalate: true });
      return;
    }
    if (sensitive) {
      console.info(`[bot-in] ${phone10}: sensitive detectado pero modo=${state.control} — respeta modo, no escala`);
    }
    if (!ctx || !ctx.booking) {
      // Lead entrante sin reserva. En vez de escalar directamente, generamos
      // una respuesta de captura de datos (nombre, alojamiento de interés,
      // fechas). NO accede a datos privados de otros huéspedes.
      console.info(`[bot-in] ${phone10}: sin reserva → lead entrante (modo captura)`);
      const leadPromptsBlock = _botBuildPromptsBlock(await _botGetPrompts());
      const _todayL = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Mexico_City' });
      const _yearL  = new Date().toLocaleDateString('en-US', { timeZone: 'America/Mexico_City', year: 'numeric' });
      const _tempoL = `\n\nCONTEXTO TEMPORAL:\n- HOY es: ${_todayL} (América/Mexico_City).\n- AÑO ACTUAL: ${_yearL}. Úsalo por default si no se menciona año.`;
      const leadSystem = BOT_SYSTEM_PROMPT_BASE + leadPromptsBlock + _tempoL + `

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
        // Usa loop de tools también en lead — cotizar_disponibilidad
        // funciona sin reserva (solo requiere fechas + huéspedes). Si NO se
        // pasa el loop, el modelo alucina la llamada como texto JSON.
        const llm = await _botLlmLoop({ system: leadSystem, history: historyForLlm, userMsg: bodyMsg, ctx: { phone10, fromRaw, booking: {}, alojRow: {} } });
        console.info(`[bot-in] ${phone10}: LLM lead+tools en ${Date.now()-tLlm}ms (${(llm.toolsUsed||[]).length} tools)`);
        for (const t of (llm.toolsUsed || [])) { if (t.notifyText) _botNotifyAdmin(t.notifyText); }
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
        await _botAppendMessage(phone10, "assistant", replyText, { model: BOT_ANTHROPIC_MODEL, lead: true, usage: llm.usage });
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
    const promptsBlock = _botBuildPromptsBlock(await _botGetPrompts());
    // Fecha actual explícita — evita que Claude interprete "1 al 4 de
    // septiembre" con un año arbitrario.
    const _today = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Mexico_City' });
    const _year  = new Date().toLocaleDateString('en-US', { timeZone: 'America/Mexico_City', year: 'numeric' });
    const _tempo = `\n\nCONTEXTO TEMPORAL:\n- HOY es: ${_today} (América/Mexico_City).\n- AÑO ACTUAL: ${_year}. Úsalo por default si el huésped no menciona año; si esa fecha ya pasó, salta al año siguiente.`;
    const system = BOT_SYSTEM_PROMPT_BASE + promptsBlock + _tempo + context;
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
    // Loop de tools: cotizar / crear reporte / late checkout. Cada tool
    // resuelta se aplica antes de que Claude emita el texto final.
    const llm = await _botLlmLoop({ system, history: historyForLlm, userMsg: bodyMsg, ctx: { phone10, fromRaw, booking: ctx.booking, alojRow: ctx.alojRow } });
    console.info(`[bot-in] ${phone10}: LLM+tools en ${Date.now()-tLlm}ms (${llm.toolsUsed.length} tool${llm.toolsUsed.length===1?'':'s'})`);
    // Notifica al admin por cada tool ejecutada que dejó un resumen.
    for (const t of (llm.toolsUsed || [])) {
      if (t.notifyText) _botNotifyAdmin(t.notifyText);
    }
    const replyText = String(llm.text || "").trim();
    if (!replyText) {
      console.warn(`[bot-in] ${phone10}: respuesta vacía del LLM (modo=${state.control}) — no cambia modo`);
      // No escalamos automáticamente — respetamos el modo del admin.
      // El mensaje del huésped ya está guardado y visible en el panel.
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
    await _botAppendMessage(phone10, "assistant", replyText, { model: BOT_ANTHROPIC_MODEL, tools: (llm.toolsUsed || []).map(t => t.name) });
    console.info(`[bot-out] ${phone10}: total ${Date.now()-t0}ms · "${replyText.slice(0,80)}"`);
  } catch (err) {
    console.error("[bot] error:", err.message);
    // Error interno: NO cambiar modo. El admin ya eligió su modo — si algo
    // falla, el mensaje del huésped queda en el panel y el admin decide.
  }
  }); // fin _botLockPhone
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
- NO inventes datos. Solo puedes afirmar lo que está en el contexto abajo o lo que devuelvan las herramientas.
- Redacta la respuesta EN PRIMERA PERSONA como si el admin la fuera a mandar tal cual al huésped.
- Sé breve, natural y cordial. Máximo 3-4 oraciones.
- No incluyas explicaciones al admin, solo la respuesta lista para copiar y enviar al huésped.

HERRAMIENTAS DISPONIBLES:
Tienes acceso a las MISMAS herramientas que el bot cuando atiende al huésped. La instrucción del admin ES la autorización — no pidas confirmación adicional antes de ejecutar. Interpreta lo que pide y llámalas directamente:
- cotizar_disponibilidad(arrival YYYY-MM-DD, departure YYYY-MM-DD, adults N): consulta disponibilidad real. Ej: "dame la disponibilidad del 5 al 10 de octubre para 1 persona" → INTERPRETA fechas (año actual/próximo si ya pasó) y llama la tool. Con el resultado redacta una respuesta corta al huésped que incluya el campo "link_ver_resultados" en línea aparte.
- crear_reporte_mantenimiento(titulo, descripcion, prioridad P1|P2|P3, categoria): crea reporte técnico. Ej: "levanta un reporte de que se fue la luz, urgente" → INTERPRETA (título corto, prioridad P1 por urgente, categoría eléctrico) y llama la tool. Con el resultado (folio) redacta un mensaje al huésped confirmando el reporte y su folio.
- agendar_late_checkout(hora_nueva HH:MM): registra la solicitud. Ej: "agenda late checkout a las 3pm" → llama la tool con "15:00". Con el resultado redacta un mensaje al huésped confirmando que quedó solicitado.
Cuando llames herramientas que crean registro (reporte, late checkout), el sistema notifica automáticamente al admin en WhatsApp. No lo menciones en el texto para el huésped.

INSTRUCCIÓN DEL ADMIN: ${prompt}
${alojContext}
${_botBuildPromptsBlock(await _botGetPrompts())}`;
    const history = (ctxResp.messages || []).slice(-10)
      .filter(m => m.role !== 'system')
      .map(m => ({ role: (m.role === 'admin' || m.role === 'template') ? 'assistant' : (m.role === 'user' ? 'user' : 'assistant'), body: m.body }));
    // Usa el loop de tools — permite que Sys-IA llame cotizar_disponibilidad
    // igual que el bot. Los otros tools (crear_reporte, late_checkout) están
    // desalentados en el prompt para que no persistan cambios desde aquí.
    const llm = await _botLlmLoop({ system: sysIaPrompt, history, userMsg: prompt, ctx: { phone10: phone, fromRaw: `whatsapp:+52${phone}`, booking: ctx?.booking || {}, alojRow: ctx?.alojRow || {} } });
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
 *  Admin envía msg manual al huésped desde el panel. NO cambia el modo
 *  de control — el admin ya eligió su modo (bot/supervised/manual/human)
 *  explícitamente con los toggles del panel, y ese modo se preserva. */
app.post("/wa/bot/send-as-admin", async (req, res) => {
  try {
    const p = req.body || {};
    const phone = String(p.phone || "").replace(/\D/g,"").slice(-10);
    const body = String(p.body || "").trim();
    if (!phone || !body) return res.status(400).json({ ok: false, error: "phone + body requeridos" });
    // 1) Enviar por Twilio
    const to = `whatsapp:+52${phone}`;
    const msg = await _twilioSendMessage({ to, body, skipMirror: true });
    // 2) Loguear como 'admin'. NO tocar wa_chat_set_control — respeta el
    //    modo ya seleccionado por el usuario en el panel.
    fetch(CHECKIN_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "wa_chat_context_append", phone, role: "admin", body, meta: { sid: msg.sid } }),
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
// ─── Set draft supervised en WA_ChatContext ───────────────────────────────
// Pasa un mensaje generado (ej. auto-pago) como draft que el admin puede
// aceptar/editar/omitir en la caja supervised del chat.
app.post("/wa/chat-set-draft", async (req, res) => {
  try {
    const phone = String(req.body?.phone || "").replace(/\D/g, "").slice(-10);
    const body  = String(req.body?.body || "");
    if (!phone) return res.status(400).json({ ok: false, error: "phone requerido" });
    const r = await fetch(CHECKIN_APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "wa_chat_set_draft", phone, body }),
    });
    const j = await r.json().catch(() => ({ ok: true }));
    // Además: si el estado control es 'bot', escalamos a 'supervised' para
    // que la caja del draft aparezca en el panel.
    try {
      await fetch(CHECKIN_APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "wa_chat_set_control", phone, control: "supervised", reason: "auto-pago draft" }),
      });
    } catch(_){}
    res.json(j || { ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── Proxy de media de Twilio (imágenes de WhatsApp) ────────────────────────
// Twilio requiere basic auth para descargar MediaUrl. El frontend NO puede
// pasar credenciales, así que proxeamos: GET /wa/media?url=<encoded>.
app.get("/wa/media", async (req, res) => {
  try {
    const url = String(req.query.url || "");
    if (!/^https:\/\/api\.twilio\.com\//.test(url)) return res.status(400).send("url inválida");
    const keySid = process.env.TWILIO_API_KEY_SID, keySec = process.env.TWILIO_API_KEY_SECRET;
    const acctSid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN;
    const user = (keySid && keySec) ? keySid : acctSid;
    const pass = (keySid && keySec) ? keySec : token;
    if (!user || !pass) return res.status(500).send("Twilio creds faltan");
    const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
    const r = await fetch(url, { headers: { Authorization: auth }, redirect: "follow" });
    if (!r.ok) return res.status(r.status).send("upstream " + r.status);
    const ct = r.headers.get("content-type") || "application/octet-stream";
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=86400"); // 1 día
    res.send(buf);
  } catch (e) { res.status(500).send("err: " + e.message); }
});

// ─── Reenvío de mensajes a otro WhatsApp ─────────────────────────────────────
app.post("/wa/send-forward", async (req, res) => {
  try {
    const to = String(req.body?.to || "").trim();
    const body = String(req.body?.body || "").trim();
    if (!to.startsWith("whatsapp:+")) return res.status(400).json({ ok: false, error: "to inválido (esperado whatsapp:+E164)" });
    if (!body) return res.status(400).json({ ok: false, error: "body vacío" });
    if (body.length > 4000) return res.status(400).json({ ok: false, error: "body demasiado largo" });
    await _twilioSendMessage({ to, body, skipMirror: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── Analizar comprobante de pago (Claude Vision + texto) ────────────────────
app.post("/wa/analizar-comprobante", async (req, res) => {
  try {
    const phone10 = String(req.body?.phone || "").replace(/\D/g, "").slice(-10);
    const media = Array.isArray(req.body?.media) ? req.body.media : [];
    const texts = Array.isArray(req.body?.texts) ? req.body.texts : [];
    if (!media.length && !texts.length) return res.status(400).json({ ok: false, error: "sin contenido" });
    // Descarga y base64 de las imágenes de Twilio (basic auth).
    const keySid = process.env.TWILIO_API_KEY_SID, keySec = process.env.TWILIO_API_KEY_SECRET;
    const acctSid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN;
    const user = (keySid && keySec) ? keySid : acctSid;
    const pass = (keySid && keySec) ? keySec : token;
    const authTw = user && pass ? "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") : null;
    const imgBlocks = [];
    for (const m of media) {
      const mt = String(m.type || "").toLowerCase();
      if (!/image/.test(mt)) continue;
      const url = String(m.url || "");
      if (!url) continue;
      try {
        const rr = await fetch(url, authTw ? { headers: { Authorization: authTw }, redirect: "follow" } : {});
        if (!rr.ok) continue;
        const buf = Buffer.from(await rr.arrayBuffer());
        imgBlocks.push({
          type: "image",
          source: { type: "base64", media_type: mt || "image/jpeg", data: buf.toString("base64") },
        });
      } catch (_) { /* skip */ }
    }
    const textBlock = texts.filter(Boolean).join("\n---\n").slice(0, 3000);
    // Consulta reserva activa del phone (para asociar el pago).
    let reservaId = "", reservaLabel = "";
    try {
      const ctx = await _botFindActiveBooking(phone10);
      if (ctx && ctx.booking) {
        reservaId = String(ctx.booking.Id || "");
        const arr = String(ctx.booking.DateArrival || "").slice(0, 10);
        const dep = String(ctx.booking.DateDeparture || "").slice(0, 10);
        const nombre = String(ctx.booking.GuestName || "");
        reservaLabel = `${reservaId} · ${nombre} · ${arr} → ${dep}`.trim();
      }
    } catch (_) {}
    // Prompt Vision
    const sys = `Eres un extractor de datos de comprobantes de pago mexicanos (SPEI, transferencia, depósito, terminal POS). Devuelve JSON estricto (sin texto extra) con estos campos:
{
  "monto": number,                 // el monto en MXN, solo el número
  "banco": string,                 // banco emisor o receptor (BBVA, Santander, etc.)
  "metodo": string,                // "SPEI" | "Transferencia" | "Depósito" | "POS" | "Efectivo" | "Otro"
  "fecha": "YYYY-MM-DD",           // fecha del movimiento
  "referencia": string,            // clave de rastreo, folio o concepto
  "asunto": string,                // beneficiario u observación breve
  "confianza": "alta" | "media" | "baja"
}
Si un dato NO se ve claro devuélvelo vacío ("" o 0). Si la imagen o texto NO es un comprobante, devuelve {"confianza":"baja","monto":0}. Respuesta EXCLUSIVA JSON válido.`;
    const userBlocks = [];
    for (const ib of imgBlocks) userBlocks.push(ib);
    if (textBlock) userBlocks.push({ type: "text", text: `Texto adjunto del huésped:\n${textBlock}` });
    if (!userBlocks.length) userBlocks.push({ type: "text", text: "(sin contenido — devuelve confianza:baja)" });
    const call = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 500,
        system: sys,
        messages: [{ role: "user", content: userBlocks }],
      }),
    });
    const j = await call.json();
    if (!call.ok) return res.status(502).json({ ok: false, error: `Claude ${call.status}: ${(j.error && j.error.message) || ""}` });
    const raw = (j.content || []).filter(p => p.type === "text").map(p => p.text).join("\n").trim();
    const clean = raw.replace(/^```json?\s*|\s*```$/g, "");
    let data = null;
    try { data = JSON.parse(clean); } catch (e) { return res.json({ ok: true, data: { confianza: "baja" }, reservaId, reservaLabel, raw }); }
    res.json({ ok: true, data, reservaId, reservaLabel });
  } catch (e) {
    console.error("[comprobante] error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Reservas · phones extra ────────────────────────────────────────────────
app.get("/reservas/phone-extras", async (req, res) => {
  try {
    const params = {};
    const p = String(req.query.phone || "").trim();
    const rid = String(req.query.reservaId || "").trim();
    if (p) params.phone = p;
    if (rid) params.reservaId = rid;
    const r = await callCheckinAppsScript("list_reserva_phones_extra", params);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/reservas/attach-phone", async (req, res) => {
  try {
    const payload = req.body?.payload || req.body || {};
    const r = await callCheckinAppsScriptPost("save_reserva_phone_extra", { payload });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.delete("/reservas/phone-extras/:id", async (req, res) => {
  try {
    const r = await callCheckinAppsScriptPost("delete_reserva_phone_extra", { payload: { id: String(req.params.id) } });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── Solicitudes pendientes (bot notifications persistidas) ────────────
app.get("/solicitudes", async (req, res) => {
  try {
    const params = {};
    if (req.query.phone) params.phone = String(req.query.phone);
    if (req.query.estado) params.estado = String(req.query.estado);
    const r = await callCheckinAppsScript("list_solicitudes", params);
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/solicitudes", async (req, res) => {
  try {
    const payload = req.body?.payload || req.body || {};
    const r = await callCheckinAppsScriptPost("save_solicitud", { payload });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/solicitudes/:id/estado", async (req, res) => {
  try {
    const payload = {
      id: String(req.params.id),
      estado: String((req.body || {}).estado || ""),
      AtendidoPor: String((req.body || {}).AtendidoPor || ""),
      Notas: String((req.body || {}).Notas || ""),
    };
    const r = await callCheckinAppsScriptPost("update_solicitud_estado", { payload });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── Pagos manuales (fuera de Stripe/Lodgify) ────────────────────────────────
app.get("/pagos-manuales", async (req, res) => {
  try {
    const reservaId = String(req.query.reservaId || "").trim();
    const r = await callCheckinAppsScript("list_pagos_manuales", reservaId ? { reservaId } : {});
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/pagos-manuales", async (req, res) => {
  try {
    const payload = req.body?.payload || req.body || {};
    const r = await callCheckinAppsScriptPost("save_pago_manual", { payload });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.delete("/pagos-manuales/:id", async (req, res) => {
  try {
    const r = await callCheckinAppsScriptPost("delete_pago_manual", { payload: { id: String(req.params.id) } });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

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
    // MAX_PAGES=500 (× 100 size = 50k bookings). Suficiente para varios
    // años de operación. Antes era 100 → cortaba a los 10k bookings
    // ordenados por Lodgify y dejaba fuera el resto.
    const MAX_PAGES = 500;
    while (hasMore && page <= MAX_PAGES) {
      const url = `https://api.lodgify.com/v2/reservations/bookings?stayFilter=All&page=${page}&size=100&includeCount=true&includeTransactions=true&updatedSince=${encodeURIComponent(updatedSince)}T00:00:00`;
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
    // Deriva PaymentStatus del estado numérico de pagos. Reglas:
    //   Sin pago  → amount_paid == 0 && total_amount > 0
    //   Pagada    → amount_due <= 0 && amount_paid >= total_amount
    //   Parcial   → 0 < amount_paid < total_amount
    //   Reembolsada → amount_paid < 0 (o hay transactions Refund netos)
    //   Sin cargo → total_amount == 0 (Declined/canceladas sin cobro)
    function _derivePaymentStatus(total, paid, due, status) {
      const t = Number(total) || 0, p = Number(paid) || 0, d = Number(due) || 0;
      const st = String(status || "").toLowerCase();
      if (st === "declined" && p === 0) return "Sin cargo";
      if (t === 0 && p === 0) return "Sin cargo";
      if (p < 0) return "Reembolsada";
      if (t > 0 && p === 0) return "Sin pago";
      if (d <= 0 && p > 0) return "Pagada";
      if (p > 0 && p < t) return "Parcial";
      return "—";
    }
    for (const b of items) {
      const room = (b.rooms && b.rooms[0]) || {};
      const guest = (b.guest) || {};
      const totalAmount = Number(b.total_amount) || 0;
      const amountPaid  = Number(b.amount_paid)  || 0;
      const amountDue   = Number(b.amount_due)   || 0;
      const paymentStatus = _derivePaymentStatus(totalAmount, amountPaid, amountDue, b.status);
      const paymentPolicy = String(((b.quote || {}).policy || {}).payments || "").slice(0, 500);
      // Guardamos solo campos clave de cada transacción para acotar payload.
      const txCompact = Array.isArray(b.transactions) ? b.transactions.map(t => ({
        id: t.id, type: t.type, status: t.status, payment_type: t.payment_type,
        amount: t.amount, processed_at: t.processed_at,
        description: String(t.description || "").slice(0, 120),
      })) : [];
      const baseRow = {
        Id: b.id,
        TotalAmount: totalAmount,
        AmountPaid: amountPaid,
        AmountDue: amountDue,
        PaymentStatus: paymentStatus,
        PaymentPolicy: paymentPolicy,
        TransactionsJSON: JSON.stringify(txCompact),
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
      // Lodgify v2 devuelve el desglose en `subtotals` — NO en
      // `amount_breakdown` (siempre null) ni en `transactions` (pagos).
      // Mapeamos: stay→RoomRate, fees→Fee, taxes→Tax. Ignoramos promotions
      // (descuentos) y addons/vat aparte para no duplicar.
      let tx = [];
      const st = (b && b.subtotals) || {};
      const stayN  = Number(st.stay)  || 0;
      const feesN  = Number(st.fees)  || 0;
      const taxesN = Number(st.taxes) || 0;
      const promoN = Number(st.promotions) || 0;
      const addonsN= Number(st.addons) || 0;
      if (stayN)   tx.push({ type: "RoomRate",   description: "Tarifa hospedaje", gross_amount: stayN });
      if (feesN)   tx.push({ type: "Fee",        description: "Tarifa limpieza",  gross_amount: feesN });
      if (taxesN)  tx.push({ type: "Tax",        description: "Impuestos",        gross_amount: taxesN });
      if (addonsN) tx.push({ type: "Addon",      description: "Extras",            gross_amount: addonsN });
      if (promoN)  tx.push({ type: "Promotion",  description: "Descuento",         gross_amount: -promoN });
      // Fallback si subtotals no está: intentar amount_breakdown o transactions.
      if (!tx.length) {
        tx = Array.isArray(b.quote && b.quote.amounts_breakdown) ? b.quote.amounts_breakdown
           : Array.isArray(b.amount_breakdown) ? b.amount_breakdown
           : Array.isArray(b.transactions) ? b.transactions : [];
      }
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
    const p10 = phone.slice(-10);

    async function _lodgify() {
      try {
        const lodR = await fetch(`http://127.0.0.1:${PORT}/lodgify-list`);
        const lodJ = await lodR.json();
        const map = {};
        if (lodJ && Array.isArray(lodJ.bookings)) {
          lodJ.bookings.forEach(b => { if (b && b.Id != null) map[String(b.Id)] = b; });
        }
        return { map, all: (lodJ && lodJ.bookings) || [] };
      } catch (_) { return { map: {}, all: [] }; }
    }
    async function _extraIds() {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/reservas/phone-extras?phone=${encodeURIComponent(p10)}`);
        const j = await r.json();
        if (!j || !j.ok || !Array.isArray(j.rows)) return [];
        return j.rows.map(x => String(x.ReservaId || "").trim()).filter(Boolean);
      } catch (_) { return []; }
    }
    const [extraIds, lodgify] = await Promise.all([_extraIds(), _lodgify()]);
    const extraBookings = extraIds.map(id => lodgify.map[id]).filter(Boolean);
    function _mergeUnique(base, extras) {
      const seen = new Set((base || []).map(b => String(b && b.Id || "")));
      const out = (base || []).slice();
      extras.forEach(b => {
        const id = String(b && b.Id || "");
        if (id && !seen.has(id)) { seen.add(id); out.push(b); }
      });
      return out;
    }

    const url = `${CHECKIN_APPS_SCRIPT_URL}?action=bookings_by_guest&phone=${encodeURIComponent(phone)}`;
    let lastText = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url, { redirect: "follow" });
        const text = await r.text();
        lastText = text;
        try {
          const j = JSON.parse(text);
          if (j && j.ok && Array.isArray(j.bookings)) {
            j.bookings = _mergeUnique(j.bookings, extraBookings);
            if (extraBookings.length) j.extras_added = extraBookings.length;
          }
          return res.json(j);
        } catch (_) { /* HTML — retry */ }
      } catch (_) { /* network — retry */ }
      if (attempt === 0) await new Promise(rs => setTimeout(rs, 800));
    }
    // Fallback Apps Script caído
    const lgMatches = lodgify.all.filter(b => String(b.GuestPhone || "").replace(/\D/g, "").slice(-10) === p10);
    const bookings = _mergeUnique(lgMatches, extraBookings);
    if (bookings.length) return res.json({ ok: true, bookings, fallback: "lodgify-list", extras_added: extraBookings.length });
    res.status(502).json({ ok: false, error: "Apps Script no respondió JSON (2 intentos): " + String(lastText).slice(0, 200) });
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
// Trae TODAS las propiedades paginando /v2/properties. Lodgify tope
// por página = 100. Sin esto solo devolvía las primeras 100, dejando
// fuera propiedades nuevas (ej. Matamoros #10 id 704167).
async function _lodgifyFetchAllProperties() {
  const all = [];
  const MAX_PAGES = 40;
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const j = await _lodgifyFetch("/v2/properties", { size: 100, page });
    const list = Array.isArray(j) ? j : (j.items || j.results || []);
    if (!list.length) break;
    let added = 0;
    for (const p of list) {
      const id = String(p && p.id);
      if (seen.has(id)) continue;
      seen.add(id); all.push(p); added++;
    }
    if (added === 0) break;
  }
  return all;
}
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
    const list = await _lodgifyFetchAllProperties();
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
        : _lodgifyFetchAllProperties().then(list => {
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
    // Solo propiedades asignadas al sitio web público (is_active=true).
    // Las inactivas existen en Lodgify pero no están publicadas — mostrar
    // aquí crearía discrepancia con el sitio hosted que ve el huésped.
    const candidates = props.filter(p => p && p.is_active !== false).filter(inLoc);
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
    // ── Split Stay (DEMO) ──────────────────────────────────────────────
    // Combinación ficticia de 2 alojamientos que juntos cubran el periodo.
    // OFF por default para prod — activar temporalmente con:
    //   gcloud run services update ticket-vision --update-env-vars SPLIT_STAY_DEMO=1
    // desactivar de vuelta: --update-env-vars SPLIT_STAY_DEMO=0
    // En v2 reemplazar por algoritmo real que consulte /v2/availability.
    const splitStays = [];
    if (String(process.env.SPLIT_STAY_DEMO || '') === '1' && results.length >= 2) {
      const nights = Math.max(2, Math.round((new Date(departure) - new Date(arrival)) / 86_400_000));
      const halfN = Math.max(1, Math.floor(nights / 2));
      const mid = new Date(new Date(arrival).getTime() + halfN * 86_400_000).toISOString().slice(0, 10);
      const p1 = results[0], p2 = results[1];
      const perNight1 = (p1.total || 0) / Math.max(1, (p1.nights || nights));
      const perNight2 = (p2.total || 0) / Math.max(1, (p2.nights || nights));
      const sub1 = Math.round(perNight1 * halfN);
      const sub2 = Math.round(perNight2 * (nights - halfN));
      splitStays.push({
        id: "ss-demo-1",
        isDemo: true,
        currency: p1.currency || "MXN",
        nights,
        total: sub1 + sub2,
        legs: [
          { step: 1, alojamiento: p1, arrival, departure: mid, nights: halfN, subtotal: sub1 },
          { step: 2, alojamiento: p2, arrival: mid, departure, nights: nights - halfN, subtotal: sub2 },
        ],
      });
    }
    res.json({ ok: true, count: results.length, results, splitStays });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Ticket Vision v7 — Claude Vision — port ${PORT}`));
