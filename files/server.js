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

async function callAppsScript(payload, _intento, _timeoutMs) {
  const intento = _intento || 1;
  const timeoutMs = _timeoutMs || 25000; // 25s por defecto; los callers pesados pasan más
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let parsed;
  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method:  "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body:    JSON.stringify(payload),
      signal:  controller.signal,
    });
    const text = await res.text();
    try { parsed = JSON.parse(text); } catch { return { ok: false, raw: text }; }
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Timeout: Apps Script tardó más de ${Math.round(timeoutMs/1000)}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  // Respuesta por defecto de doGet: el POST llegó como GET y la acción no se
  // ejecutó. Es un "ok" falso → reintentar (hasta 3 intentos).
  if (parsed && parsed.ok === true && /^Web app activo/.test(String(parsed.message || ""))) {
    if (intento < 3) {
      console.warn(`[callAppsScript] respuesta de doGet (${intento}/3) — action=${payload && payload.action}, reintento`);
      await new Promise(r => setTimeout(r, 700 * intento));
      return callAppsScript(payload, intento + 1, timeoutMs);
    }
    return { ok: false, error: 'Apps Script no ejecutó la acción (respondió como lectura). Intenta de nuevo.' };
  }
  return parsed;
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

// ─── Registros contables: copia en memoria de BANCOS (stale-while-revalidate) ──
// Medido 2026-10-02: Apps Script tarda 11-18 s desde fuera, pero desde Cloud
// Run falla seguido (HTML / doGet / >60 s) → el módulo esperaba 80-140 s.
// Ahora /get-bancos responde AL INSTANTE con la copia en memoria y la refresca
// en segundo plano (1 sola consulta a la vez). ?fresh=1 espera la versión
// nueva (se usa tras insertar movimientos de efectivo).
const BANCOS_TTL_MS = 2 * 60 * 1000;
const _bancos = { payload: null, ts: 0, inflight: null, dirty: false, lastError: "", lastMs: 0 };
function _bancosRefresh(reason) {
  if (_bancos.inflight) return _bancos.inflight;
  const t0 = Date.now();
  _bancos.dirty = false;
  _bancos.inflight = (async () => {
    let lastErr = "";
    for (let a = 1; a <= 3; a++) {
      try {
        const r = await callAppsScript({ action: "get_bancos_data" }, 1, 90000);
        if (r && r.ok !== false && Array.isArray(r.records)) {
          _bancos.payload = r; _bancos.ts = Date.now(); _bancos.lastError = ""; _bancos.lastMs = Date.now() - t0;
          _appsScriptFallbackCache.set("get_bancos_data", { ts: _bancos.ts, payload: r });
          console.log(`[bancos] refresco OK (${reason}) en ${_bancos.lastMs} ms, intento ${a}, ${r.records.length} registros`);
          return r;
        }
        lastErr = (r && (r.error || (r.raw ? "HTML: " + String(r.raw).replace(/\s+/g, " ").slice(0, 200) : ""))) || "respuesta sin datos";
      } catch (e) { lastErr = e.message; }
      console.warn(`[bancos] refresco intento ${a} falló (${reason}): ${lastErr}`);
      if (a < 3) await new Promise(r => setTimeout(r, 2000 * a));
    }
    _bancos.lastError = lastErr;
    throw new Error(lastErr);
  })().finally(() => { _bancos.inflight = null; });
  return _bancos.inflight;
}
function _bancosMarkDirty() { _bancos.dirty = true; _bancosRefresh("cambio").catch(() => {}); }

app.get("/get-bancos", async (req, res) => {
  const t0 = Date.now();
  try {
    const fresh = String(req.query.fresh || "") === "1";
    const age = _bancos.payload ? Date.now() - _bancos.ts : Infinity;
    if (_bancos.payload && !fresh) {
      if (age > BANCOS_TTL_MS || _bancos.dirty) _bancosRefresh("antigüedad").catch(() => {});
      res.set("Server-Timing", `bancos-cache;dur=${Date.now() - t0}`);
      return res.json({ ..._bancos.payload, cached: true, cached_age_ms: age });
    }
    // Sin copia (arranque) o ?fresh=1 → esperar la versión nueva.
    try {
      const r = await _bancosRefresh(fresh ? "fresh" : "sin-copia");
      return res.json({ ...r, cached: false });
    } catch (e) {
      if (_bancos.payload) return res.json({ ..._bancos.payload, cached: true, stale: true, cached_age_ms: age, refresh_error: e.message });
      return res.status(502).json({ ok: false, error: "Google Sheets no respondió (" + e.message + "). Intenta de nuevo en unos segundos." });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.get("/bancos-cache-status", (_req, res) => {
  res.json({ ok: true, loaded: !!_bancos.payload, age_ms: _bancos.payload ? Date.now() - _bancos.ts : null,
    registros: _bancos.payload ? _bancos.payload.records.length : 0, refrescando: !!_bancos.inflight,
    dirty: _bancos.dirty, ultimo_refresco_ms: _bancos.lastMs, ultimo_error: _bancos.lastError });
});
// El navegador inserta en BANCOS directo contra Apps Script: avisa aquí.
app.post("/bn/invalidate", (_req, res) => { _bancosMarkDirty(); res.json({ ok: true }); });

// ─── Información de huéspedes: proxy al Apps Script del check-in ─────────────
// El check-in tiene su PROPIO Apps Script (code_1.gs) con la lógica completa
// de listGuestRecords_, getGuestFilterOptions_ y getGuestRecordDetail_.
// Lo reutilizamos vía GET en lugar de duplicar la lógica.
const CHECKIN_APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwqMfC6tITLXlhEwYzQ5mKzw-KD6-nV7XVKIuekj6pK4Po50oRfVKClZeHcr-si3ppB/exec";

// ═══════════════════════════════════════════════════════════════════════════
// ║  Fix PERMANENTE al glitch "Apps Script devuelve HTML"                    ║
// ║                                                                          ║
// ║  Apps Script tiene glitches transitorios donde devuelve la página HTML   ║
// ║  "Sorry, unable to open the file" en vez del JSON esperado. Esto es una  ║
// ║  falla conocida y crónica de Google, sin fecha de resolución.            ║
// ║                                                                          ║
// ║  Estrategia de blindaje en 3 capas:                                       ║
// ║  1) REINTENTOS: 4 intentos con backoff exponencial (0.5s→1s→2s→4s)       ║
// ║     cubren ~7.5s de glitch. Cubre el 99% de los casos.                   ║
// ║  2) STALE-WHILE-REVALIDATE: cada respuesta buena queda persistida en     ║
// ║     memoria por 24h. Si tras los reintentos aún falla, servimos la      ║
// ║     última respuesta buena con {cached_stale:true, cached_age_ms:N}.    ║
// ║     El frontend NUNCA ve el error crudo — recibe datos siempre.         ║
// ║  3) COALESCING: dos requests simultáneos con el mismo (action,params)   ║
// ║     comparten la misma promise para no golpear Apps Script en paralelo. ║
// ═══════════════════════════════════════════════════════════════════════════

// Cache de fallback: última respuesta buena por (action + params). No expira
// hasta 24h — usada solo como red de seguridad si Apps Script está flaky.
const _appsScriptFallbackCache = new Map();
const APPS_SCRIPT_FALLBACK_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Coalescing: dedupe requests concurrentes al mismo endpoint.
const _appsScriptInflight = new Map();

function _appsScriptCacheKey(action, paramsObj) {
  if (!paramsObj) return action;
  // Estable: keys ordenadas para que {a:1,b:2} y {b:2,a:1} den la misma key.
  const sortedKeys = Object.keys(paramsObj).sort();
  const parts = sortedKeys
    .filter(k => paramsObj[k] != null && paramsObj[k] !== "")
    .map(k => `${k}=${paramsObj[k]}`);
  return parts.length ? `${action}?${parts.join("&")}` : action;
}

async function callCheckinAppsScript(action, paramsObj) {
  const cacheKey = _appsScriptCacheKey(action, paramsObj);
  // Coalescing: si ya hay una llamada en vuelo, reutilizamos su promesa.
  const inflight = _appsScriptInflight.get(cacheKey);
  if (inflight) return inflight;
  const promise = _callCheckinAppsScriptInner(action, paramsObj, cacheKey)
    .finally(() => _appsScriptInflight.delete(cacheKey));
  _appsScriptInflight.set(cacheKey, promise);
  return promise;
}

async function _callCheckinAppsScriptInner(action, paramsObj, cacheKey) {
  const url = new URL(CHECKIN_APPS_SCRIPT_URL);
  url.searchParams.set("action", action);
  if (paramsObj) {
    for (const [k, v] of Object.entries(paramsObj)) {
      if (v == null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  const TIMEOUT_MS = 120_000;
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
  // Reintentos con backoff exponencial (500ms, 1s, 2s, 4s = 7.5s total).
  let text = "";
  const MAX = 4;
  for (let attempt = 0; attempt < MAX; attempt++) {
    try {
      text = await _attempt();
      try {
        const parsed = JSON.parse(text);
        // Éxito: persistir en fallback cache y devolver.
        if (parsed && parsed.ok !== false) {
          _appsScriptFallbackCache.set(cacheKey, { ts: Date.now(), payload: parsed });
        }
        return parsed;
      } catch (_) {
        if (text.startsWith("<") && attempt < MAX - 1) {
          const wait = 500 * Math.pow(2, attempt);
          console.warn(`[callCheckinAppsScript] HTML transitorio (${attempt + 1}/${MAX}), reintento en ${wait}ms — key=${cacheKey}`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        return _appsScriptStaleFallback(cacheKey, 'HTML tras reintentos');
      }
    } catch (err) {
      if (err.name === "AbortError") {
        console.warn(`[callCheckinAppsScript] AbortError — key=${cacheKey}`);
        const stale = _appsScriptStaleFallback(cacheKey, 'Timeout Apps Script');
        if (stale) return stale;
        throw new Error(`Timeout: Apps Script tardó más de ${TIMEOUT_MS/1000}s`);
      }
      if (attempt < MAX - 1) {
        const wait = 500 * Math.pow(2, attempt);
        console.warn(`[callCheckinAppsScript] error (${attempt + 1}/${MAX}) — ${err.message}, reintento en ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      const stale = _appsScriptStaleFallback(cacheKey, err.message);
      if (stale) return stale;
      throw err;
    }
  }
  return _appsScriptStaleFallback(cacheKey, 'sin respuesta válida') ||
    { ok: false, error: 'Apps Script devolvió HTML tras varios reintentos', raw: (text || "").slice(0, 200) };
}

function _appsScriptStaleFallback(cacheKey, reason) {
  const cached = _appsScriptFallbackCache.get(cacheKey);
  if (!cached) return null;
  const age = Date.now() - cached.ts;
  if (age > APPS_SCRIPT_FALLBACK_TTL_MS) {
    _appsScriptFallbackCache.delete(cacheKey);
    return null;
  }
  console.warn(`[callCheckinAppsScript] sirviendo STALE (${Math.round(age/1000)}s) por ${reason} — key=${cacheKey}`);
  // Devolvemos una COPIA anotada para no mutar el cache original.
  return { ...cached.payload, _stale: true, _stale_age_ms: age, _stale_reason: reason };
}

// Variante POST con body JSON para payloads grandes (base64 de imágenes,
// arrays de filas). GET trunca URLs largas → fotos llegan corruptas y
// nunca suben. doPost en Apps Script parsea e.postData.contents.
// Aplica el mismo patrón de reintentos con backoff exponencial que el GET,
// pero NO usa cache stale (los POST son escrituras — no queremos idempotencia
// engañosa). Solo maneja el glitch HTML de Apps Script.
async function callCheckinAppsScriptPost(action, dataObj) {
  const body = JSON.stringify(Object.assign({ action }, dataObj || {}));
  const TIMEOUT_MS = 60000;
  async function _postAttempt() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(CHECKIN_APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body,
        signal: controller.signal,
        redirect: "follow",
      });
      return await r.text();
    } finally { clearTimeout(timer); }
  }
  let text = "";
  const MAX = 4;
  for (let attempt = 0; attempt < MAX; attempt++) {
    try {
      text = await _postAttempt();
      try {
        const parsed = JSON.parse(text);
        // Respuesta por defecto de doGet: Google entregó el POST como GET y
        // la acción NO se ejecutó. Es un "ok" falso → reintentar.
        if (parsed && parsed.ok === true && /^Web app activo/.test(String(parsed.message || ""))) {
          if (attempt < MAX - 1) {
            const wait = 500 * Math.pow(2, attempt);
            console.warn(`[callCheckinAppsScriptPost] respuesta de doGet (${attempt+1}/${MAX}) — action=${action}, reintento en ${wait}ms`);
            await new Promise(r => setTimeout(r, wait));
            continue;
          }
          return { ok: false, error: 'Apps Script no ejecutó la acción (respondió como lectura). Intenta de nuevo.' };
        }
        return parsed;
      }
      catch (_) {
        if (text.startsWith("<") && attempt < MAX - 1) {
          const wait = 500 * Math.pow(2, attempt);
          console.warn(`[callCheckinAppsScriptPost] HTML transitorio (${attempt+1}/${MAX}) — action=${action}, reintento en ${wait}ms`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        return { ok: false, error: 'Apps Script devolvió HTML tras reintentos', raw: text.slice(0, 200) };
      }
    } catch (err) {
      if (err.name === "AbortError") throw new Error(`Timeout: Apps Script tardó más de ${TIMEOUT_MS/1000}s`);
      if (attempt < MAX - 1) {
        const wait = 500 * Math.pow(2, attempt);
        console.warn(`[callCheckinAppsScriptPost] error (${attempt+1}/${MAX}) — ${err.message}, reintento en ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  return { ok: false, error: 'Apps Script devolvió HTML tras varios reintentos', raw: (text || "").slice(0, 200) };
}

// ═══════════════════════════════════════════════════════════════════════════
// ║ /huespedes-list — cache SWR + trim + persistencia a disco               ║
// ║                                                                          ║
// ║ Optimizaciones para eliminar el "wait" del usuario:                     ║
// ║ 1. TRIM: elimina fields vacíos ("") de las 8k+ filas → -40% payload.    ║
// ║ 2. SWR agresivo: fresh 15min, stale 30 días. Siempre servimos algo.     ║
// ║ 3. Persistencia a /tmp: al arrancar Cloud Run, carga el cache desde     ║
// ║    disco (sobrevive reinicios de instancia).                             ║
// ║ 4. Coalescing: requests concurrentes comparten misma promise.           ║
// ╚═══════════════════════════════════════════════════════════════════════════
const _huespedesCache = new Map();
const _huespedesInflight = new Map();
const HU_LIST_FRESH_MS = 15 * 60_000;
const HU_LIST_STALE_MS = 30 * 24 * 60 * 60_000; // 30 días
const HU_CACHE_DIR = '/tmp/hu_cache';
try { fs.mkdirSync(HU_CACHE_DIR, { recursive: true }); } catch(_){}

function _huespedesCacheKey(params) { return JSON.stringify(params); }
function _huCachePath(key) {
  const safe = require('crypto').createHash('md5').update(key).digest('hex');
  return path.join(HU_CACHE_DIR, safe + '.json');
}

// Refresca en segundo plano las consultas usadas recientemente SIN borrar la
// caché: mientras Apps Script responde (35-60 s), los usuarios reciben la
// versión anterior al instante.
function _huespedesCacheRefreshInBackground(reason) {
  const recent = Array.from(_huespedesCache.entries())
    .sort((a, b) => b[1].ts - a[1].ts)
    .slice(0, 3);
  for (const [key] of recent) {
    if (_huespedesInflight.get(key)) continue;
    let params;
    try { params = JSON.parse(key); } catch (_) { continue; }
    const t0 = Date.now();
    const p = _huespedesFetchAndCache(key, params)
      .then(() => console.log(`[huespedes-cache] ${reason}: refrescado en ${Date.now() - t0}ms`))
      .catch(e => console.warn(`[huespedes-cache] ${reason} falló:`, e.message))
      .finally(() => _huespedesInflight.delete(key));
    _huespedesInflight.set(key, p);
  }
}

function _huespedesCacheInvalidate() {
  _huespedesCache.clear();
  _huespedesInflight.clear();
  try {
    for (const f of fs.readdirSync(HU_CACHE_DIR)) fs.unlinkSync(path.join(HU_CACHE_DIR, f));
  } catch(_){}
}

// Elimina fields con string vacío para reducir payload dramáticamente.
// Preserva campos numéricos 0 y valores no-string.
function _trimEmptyFields(row) {
  const out = {};
  for (const k in row) {
    const v = row[k];
    if (v === '' || v == null) continue;
    out[k] = v;
  }
  return out;
}

// Precarga cache desde disco al arrancar. Los archivos guardan
// { ts, payload } serializado. Si algo falla, se ignora silenciosamente.
function _huespedesLoadCacheFromDisk() {
  try {
    const files = fs.readdirSync(HU_CACHE_DIR);
    let loaded = 0;
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(HU_CACHE_DIR, f), 'utf8');
        const obj = JSON.parse(raw);
        if (obj && obj.key && obj.ts && obj.payload) {
          _huespedesCache.set(obj.key, { ts: obj.ts, payload: obj.payload });
          loaded++;
        }
      } catch(_){}
    }
    if (loaded > 0) console.log(`[huespedes-cache] cargados ${loaded} entradas desde disco`);
  } catch(_){}
}
_huespedesLoadCacheFromDisk();

function _huespedesCacheSet(key, payload) {
  const entry = { ts: Date.now(), payload };
  _huespedesCache.set(key, entry);
  // Persistir a disco async (no bloquea la respuesta).
  setImmediate(() => {
    try {
      fs.writeFileSync(_huCachePath(key), JSON.stringify({ key, ts: entry.ts, payload }));
    } catch(e) { console.warn('[huespedes-cache] disco write falló:', e.message); }
  });
}

async function _huespedesFetchAndCache(key, params) {
  const result = await callCheckinAppsScript("list_records", params);
  if (result && result.ok && Array.isArray(result.rows)) {
    // TRIM: elimina fields vacíos de cada row antes de cachear.
    // Los 31 fields por row bajan a ~8-12 en promedio.
    result.rows = result.rows.map(_trimEmptyFields);
    _huespedesCacheSet(key, result);
  } else if (result && result.ok) {
    _huespedesCacheSet(key, result);
  }
  return result;
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
    const key = _huespedesCacheKey(params);
    const now = Date.now();
    const cached = _huespedesCache.get(key);
    // Fresh → instantáneo
    if (cached && (now - cached.ts) < HU_LIST_FRESH_MS) {
      return res.json({ ...cached.payload, cached: true, cached_age_ms: now - cached.ts });
    }
    // Stale utilizable → servir + refresh async
    if (cached && (now - cached.ts) < HU_LIST_STALE_MS) {
      res.json({ ...cached.payload, cached: true, stale: true, cached_age_ms: now - cached.ts });
      if (!_huespedesInflight.get(key)) {
        const p = _huespedesFetchAndCache(key, params)
          .catch(e => console.warn('[huespedes-list bg refresh]', e.message))
          .finally(() => _huespedesInflight.delete(key));
        _huespedesInflight.set(key, p);
      }
      return;
    }
    // Sin cache utilizable → coalesce + esperar
    let inflight = _huespedesInflight.get(key);
    if (!inflight) {
      inflight = _huespedesFetchAndCache(key, params)
        .finally(() => _huespedesInflight.delete(key));
      _huespedesInflight.set(key, inflight);
    }
    const result = await inflight;
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

// Stale-while-revalidate: responde con la copia guardada al instante y, si
// tiene más de 5 min, la refresca en segundo plano. Solo espera a Apps Script
// (25-100 s en horas saturadas) si nunca hubo copia.
let _alojRefreshing = null;
function _alojRefresh() {
  if (!_alojRefreshing) {
    const t0 = Date.now();
    _alojRefreshing = callCheckinAppsScript("list_alojamientos")
      .then(fresh => {
        if (fresh && fresh.ok && Array.isArray(fresh.rows)) {
          _alojCache.payload = fresh;
          _alojCache.ts = Date.now();
        } else if (!_alojCache.payload) {
          _alojCache.payload = fresh;
          _alojCache.ts = Date.now();
        } else {
          console.warn("[alojamientos-list] Apps Script devolvió no-ok — mantengo copia anterior");
        }
        console.log(`[alojamientos-list] refrescado en ${Date.now() - t0}ms`);
        return _alojCache.payload;
      })
      .finally(() => { _alojRefreshing = null; });
  }
  return _alojRefreshing;
}
async function _alojGetPayload() {
  if (!_alojCache.payload) return await _alojRefresh();
  if (Date.now() - _alojCache.ts > ALOJ_CACHE_MS) {
    _alojRefresh().catch(e => console.warn("[alojamientos-list] refresco falló:", e.message));
  }
  return _alojCache.payload;
}

app.get("/alojamientos-list", async (req, res) => {
  try {
    await _alojGetPayload();
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

// Cache in-memory (5 min) de WA_Templates para lookup por nombre desde
// código servidor. El endpoint /wa/templates-list hace POST a Apps Script.
const _waTplCache = { ts: 0, byName: null };
async function _getWaTemplateBody(nombre) {
  const TTL = 5 * 60_000;
  const need = String(nombre || '').toLowerCase().trim();
  if (!need) return '';
  if (_waTplCache.byName && (Date.now() - _waTplCache.ts) < TTL) {
    return _waTplCache.byName[need] || '';
  }
  try {
    const r = await callCheckinAppsScriptPost('wa_templates_list', {});
    const items = (r && Array.isArray(r.items)) ? r.items : (r && r.rows || []);
    const map = {};
    for (const t of items) {
      const nom = String(t.nombre || t.Nombre || '').trim().toLowerCase();
      if (nom) map[nom] = String(t.body || t.Body || '');
    }
    _waTplCache.byName = map;
    _waTplCache.ts = Date.now();
    return map[need] || '';
  } catch(_) { return ''; }
}

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

TAXONOMÍA — ANTES DE ELEGIR HERRAMIENTA, CLASIFICA EL MENSAJE (OBLIGATORIO):
Todo mensaje del huésped que requiera acción cae en UNA de estas 4 categorías. Elige la correcta ANTES de invocar cualquier tool:

A) REPORTE TÉCNICO (tool: crear_reporte_mantenimiento) — fallas de mantenimiento, mobiliario, servicios, cortes o desperfectos que requieren intervención técnica del equipo:
   · Cortes de luz, agua, gas, internet, cable, teléfono.
   · Fugas de agua, humedad, problemas de plomería, sanitario tapado.
   · Fallas de electrodomésticos (refri, estufa, boiler, aire, minisplit, TV, lavadora).
   · Cerraduras rotas, chapas atascadas, llaves que no funcionan.
   · Muebles rotos, dañados, inestables (cama, sofá, sillas, mesa).
   · Focos fundidos, contactos que no dan corriente, apagadores rotos.
   · Ventanas / puertas que no cierran, plagas (hormigas, cucarachas).
   · Ruido de electrodoméstico ("el refri hace ruido raro").
   Cualquier cosa que necesite técnico, plomero, electricista, cerrajero, exterminador → REPORTE TÉCNICO.

B) REPORTE DE INCIDENCIA (tool: crear_incidencia — cuando disponible) — errores u omisiones del personal de limpieza/supervisor al preparar la unidad:
   · Falta de insumos: papel higiénico, jabón, shampoo, café, sal, azúcar.
   · Falta de utensilios de cocina que sí forman parte del inventario (ollas, sartenes, cubiertos, platos).
   · Falta de blancos: sábanas, fundas, toallas, cobijas, almohadas.
   · Sábanas / fundas / toallas SUCIAS (no se hizo el cambio).
   · Baños sucios / no aseados al llegar / basura no sacada.
   · Falta de limpieza al llegar / departamento desordenado al ingreso.
   · Falta de llaves en la cajita o kit de bienvenida incompleto.
   · Requerimiento especial ordenado (ej. cuna) que no fue provisto.
   Nota: falta de limpieza y suciedad al llegar TAMBIÉN dispara la clasificación P1/crítico ya definida abajo — pero SIGUE siendo INCIDENCIA (no técnico), porque no requiere técnico, requiere volver a hacer aseo.

C) REPORTE DE OBJETO OLVIDADO (tool: solicitar_accion_admin con tipo="objeto_olvidado" y detalle completo — hasta que exista tool específica) — el huésped avisa que dejó algo en la unidad y quiere recuperarlo:
   · "Olvidé mi cargador / mi celular / mi laptop / mis lentes / mi ropa".
   · "Se me quedó [X] en el depa".
   · "Puedes revisar si dejé [X]".
   Datos que debes recopilar ANTES de crear el reporte: qué objeto, en qué habitación/lugar del depa, cuándo se hospedó (si no es reserva reciente), cómo prefiere recibirlo (recoger / envío).

D) SOLICITUD (tools: solicitar_late_checkout / solicitar_early_checkin / solicitar_extension / solicitar_insumos / solicitar_metodo_pago / solicitar_ticket_admin / solicitar_accion_admin) — petición del huésped ADICIONAL al buen funcionamiento del alojamiento; no es una falla ni un olvido:
   · Blancos adicionales (toalla extra, cobija extra) — solicitar_insumos.
   · Ollas / utensilios EXTRA que no vienen incluidos por default.
   · Limpieza adicional durante la estancia — solicitar_accion_admin (limpieza extra).
   · Late check-out — solicitar_late_checkout.
   · Early check-in — solicitar_early_checkin.
   · Extensión de estancia — solicitar_extension.
   · Ticket de auto-facturación — solicitar_ticket_admin.
   · Cambio de método de pago — solicitar_metodo_pago.
   · Cotización con condiciones especiales que no cubre cotizar_disponibilidad — solicitar_accion_admin.

REGLA DE DESAMBIGUACIÓN CLAVE:
   · Si el problema es porque ALGO SE ROMPIÓ o DEJÓ DE FUNCIONAR → REPORTE TÉCNICO.
   · Si el problema es porque el PERSONAL NO HIZO / NO PUSO / NO CAMBIÓ algo que debía → REPORTE DE INCIDENCIA.
   · Si el huésped DEJÓ un objeto → REPORTE DE OBJETO OLVIDADO.
   · Si el huésped PIDE algo ADICIONAL → SOLICITUD.

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
2) crear_reporte_mantenimiento — cuando el huésped reporte algo roto, que no funciona, fuga, ruido de electrodoméstico, etc.
   CLASIFICACIÓN CRÍTICA OBLIGATORIA (prioridad = P1, criticidad = critico) — si el mensaje del huésped o del admin menciona CUALQUIERA de los siguientes temas, DEBES asignar P1/critico sin excepción:
     · Electricidad: "se fue la luz", "se cortó la luz", "se fue la electricidad", "no hay electricidad", "apagón", "sin luz", "sin corriente".
     · Agua: "se fue el agua", "no hay agua", "hay fuga", "se está tirando el agua", "no sale agua", "sin agua", "está goteando fuerte", "reventó tubería".
     · Gas / cocina: "huele a gas", "olor a gas", "no hay gas", "no prende la estufa", "no hay agua caliente", "sin gas", "boiler no enciende".
     · Limpieza/blancos deficiente al llegar: "encontramos sucio el departamento", "no se realizó la limpieza", "está desordenado el departamento", "no se hizo cambio de sábanas", "no se cambiaron blancos", "hay mucha suciedad", "los baños están sucios", "no se realizó el aseo", "el depa está sucio".
     · Ruido / conducta molesta: "se escucha mucho ruido", "hay ruido excesivo", "alguien hace mucho ruido", "hay música muy fuerte", "están hablando demasiado fuerte", "no dejan dormir", "no dejan descansar", "vecinos ruidosos".
     · Violencia / seguridad: "se escuchan gritos", "hay violencia", "se están peleando", "gente agresiva", "gente problemática", "personas golpeándose", "hay una pelea", "riña".
   Estas situaciones tienen impacto directo en salud, seguridad o habitabilidad — SIEMPRE P1/critico. NUNCA las clasifiques P2/alto ni menor.
   Nota terminológica: aunque la tool acepta "P1"/"P2"/"P3", en la conversación con el huésped/admin no digas el código — di "urgente" o describe la acción. ANTES de proponer crear el reporte, LLAMA consultar_reportes_reserva con un filtro relevante ("hormigas", "aire", "agua", etc.) para saber si ya existe uno. Si YA hay reporte activo del mismo tema (Estado ≠ 'resuelto' / 'cancelado'), NO crees duplicado: infórmale al huésped el estado del reporte existente ("Ya tenemos un reporte de hormigas abierto, folio X, en estado 'en_proceso' — el equipo lo está atendiendo"). Si NO hay reporte previo, FLUJO OBLIGATORIO: (a) resume lo que entendiste ("Entiendo: [problema] en [lugar]. ¿Quieres que abra un reporte para que el equipo lo revise?"), (b) espera confirmación explícita del huésped ("sí", "adelante", "confirmo"), (c) SOLO ENTONCES llama crear_reporte_mantenimiento.
3) agendar_late_checkout — cuando el huésped pida salir más tarde de la hora estándar. FLUJO OBLIGATORIO: (a) pregunta la nueva hora deseada si no la dio, (b) resume "Voy a solicitar tu salida a las HH:MM. Queda pendiente de confirmación por el equipo. ¿Adelante?", (c) espera "sí", (d) llama la tool. NO prometas que está aprobado — solo queda como solicitud pendiente.
4) listar_reservas_sin_ticket / solicitar_ticket_admin — cuando el huésped pida ticket de auto-facturación / factura / CFDI:
   TERMINOLOGÍA OBLIGATORIA — NUNCA digas "facturar", "factura", "vamos a facturar", "ya se facturó", "recibirás tu factura":
   • Nosotros NO emitimos facturas timbradas por el SAT — solo emitimos un TICKET DE AUTO-FACTURACIÓN. El huésped luego usa el código/link del ticket para auto-facturarse llenando SUS datos fiscales en el portal correspondiente.
   • Decir "factura" confunde al huésped: cree que ya tiene su CFDI timbrado, pero NO — apenas tiene el insumo para hacerlo él mismo.
   • VOCABULARIO CORRECTO: "ticket de auto-facturación", "ticket para auto-facturar", "te llegará un ticket con el código para que tú puedas auto-facturarte", "ya se emitió el ticket".
   • VOCABULARIO PROHIBIDO: "facturar", "factura", "CFDI ya emitido", "factura timbrada", "SAT".
   • Cuando el huésped te diga "quiero facturar" / "necesito mi factura" — RESPONDES con lenguaje correcto: "Con gusto te envío el TICKET DE AUTO-FACTURACIÓN para que tú puedas auto-facturarte. ¿Cuál reserva?".
   • Al confirmar la solicitud al huésped: "Listo, ya avisé al equipo. En unos minutos te llega el ticket por correo — con ese código podrás auto-facturarte en el portal 📄".
   REGLA DE PERIODO VÁLIDO (obligatoria):
   • El ticket SOLO se puede tramitar desde el DÍA DE ENTRADA de la estancia en adelante (arrival <= hoy). Estancias en curso o ya terminadas: OK. Estancias FUTURAS (arrival > hoy): NO.
   • listar_reservas_sin_ticket devuelve dos arreglos: "items" (elegibles) y "futuras" (Booked pero aún no inicia).
   • Si el huésped identifica UNA reserva de "items" y confirma, invoca solicitar_ticket_admin con esa reservaId.
   • Si el huésped identifica UNA reserva de "futuras" (ej. "la de noviembre" cuando estamos en agosto) o pide una reserva cuyo arrival > hoy, RESPONDE con la NOTA "ticket_no_iniciado" (texto abajo). NO invoques solicitar_ticket_admin.
   • Si "items" está vacío y "futuras" tiene entradas, ofrece la lista de futuras aclarando que estarán disponibles a partir de su fecha de entrada.
   NOTA "ticket_no_iniciado" (usa este texto tal cual, sustituyendo {alojamiento} y {arrival}):
   "El ticket de auto-facturación se puede generar únicamente a partir del día de entrada. Tu reserva {alojamiento} inicia el {arrival} — vuelve a solicitarlo desde esa fecha en adelante y con gusto lo tramitamos. 📄"
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
- REGLA DE ORO ADMIN: ejecuta directo. NUNCA preguntes por prioridad, categoría, ni confirmación. Si el admin no dio criticidad, DECIDE tú y crea. (ÚNICAS EXCEPCIONES: tareas programadas y recordatorios de la pizarra, abajo.)
- ¿TAREA o RECORDATORIO? Si dice "tarea", "programa", "agenda", "asigna la tarea" → TAREA PROGRAMADA. Si dice "recordatorio", "recuérdame/recuérdale", "anota", "apunta", "pizarra", "pendiente de hoy" → RECORDATORIO DE PIZARRA. Si no queda claro, pregunta en UNA línea: "¿Lo registro como tarea programada o como recordatorio en la pizarra?".
- TAREAS PROGRAMADAS — si el admin pide programar/agendar/asignar una tarea ("tarea: …", "programa que …", "agenda para el viernes …", "que Juana revise … mañana"):
  · Extrae: descripcion (OBLIGATORIA: qué hay que hacer, redactada clara y breve), fecha (OBLIGATORIA, una sola fecha — la naturaleza siempre es "Único"), personal (OPCIONAL: nombres tal cual los escribió, aunque sean cortos o incompletos: "Juani", "Paco", "la de limpieza Alma").
  · FECHA en lenguaje natural → conviértela tú a YYYY-MM-DD con el CONTEXTO TEMPORAL: "hoy", "mañana", "pasado mañana", "el viernes" (= el próximo viernes), "el lunes que viene", "en 3 días", "15/10", "15-oct", "15 de octubre", "el 3", "fin de mes". Si NO hay fecha, pregúntala en UNA línea. Nunca inventes fecha.
  · NO pidas clasificación ni subclasificación: el sistema las asigna solo.
  · SIEMPRE llama preparar_tarea_programada ANTES de escribir el resumen (nunca lo redactes sin la herramienta: sin borrador no se puede guardar). Con su resultado envía este resumen y pregunta:
    "📋 Tarea programada (por confirmar)
    • Tarea: <nombre>
    • Fecha: <fecha_texto>
    • Clasificación: <clasificacion> › <subclasificacion>
    • Personal: <personal o 'Sin asignar'>
    • Fecha límite: <Sí/No>
    ¿Confirmas para guardarla? (sí / no / cambios)"
  · Si el admin dice "fecha límite", "a más tardar", "antes del", "tiene hasta el" → fecha_limite=true.
  · Si pide una tarea RECURRENTE ("cada viernes", "semanal", "diario", "cada mes"): por WhatsApp solo se registran tareas de una sola fecha. Dile en una línea que la recurrente se da de alta en el módulo Tareas programadas, y ofrece registrar la próxima fecha como tarea única.
    Si hay no_encontrados o ambiguos, dilo en una línea (ej. "No encontré a 'Paco' en Personal" o "'Ana' puede ser: Ana López, Ana Ruiz — ¿cuál?").
  · AQUÍ SÍ debes esperar confirmación: SOLO cuando el admin responda afirmativamente en un mensaje POSTERIOR ("sí", "ok", "dale", "confirmo", "guárdala") llama confirmar_tarea_programada con el draft_id. Si pide cambios, vuelve a llamar preparar_tarea_programada con todo corregido y muestra el resumen nuevo. Si dice "no"/"cancela", no guardes y responde "Cancelada.".
  · Tras confirmar, responde en 1 línea con el folio: "✅ Tarea guardada (folio X) para <fecha_texto>."
- PENDIENTES DEL DÍA — si el admin pide sus pendientes, las tareas o recordatorios de hoy (o de otro día), "¿qué hay que hacer hoy?", "pendientes de mañana", "mis pendientes", "pendientes de Paco":
  · Llama consultar_pendientes_del_dia (fecha YYYY-MM-DD si menciona otro día, por defecto hoy; solo_mios=true si dice "mis/míos"; personal si nombra a alguien; incluir_resueltos=true solo si pide también lo ya hecho).
  · Responde con el campo formatted_message TAL CUAL (sin resumirlo ni reordenarlo). Si no hay pendientes, dilo en 1 línea.
- RECORDATORIOS (se guardan en Tareas programadas con tipo "Recordatorio": siempre únicos, aparecen cada día en "Pendientes del día" hasta resolverse; NO llevan programación ni recurrencia) — "recordatorio: …", "anota en la pizarra …", "recuérdale a Paco que …", "apunta que hay que …":
  · Extrae: texto (OBLIGATORIO, breve y claro), prioridad (INFIERE, no preguntes: "crítico/emergencia/ya mismo" → critica; "urgente/hoy sin falta/importante" → alta; "cuando se pueda/sin prisa/no urge" → baja; resto → media), personal (OPCIONAL, nombres tal cual), fecha (OPCIONAL: por defecto HOY; si dice "mañana", "el viernes", conviértela a YYYY-MM-DD con el CONTEXTO TEMPORAL).
  · SIEMPRE llama preparar_recordatorio_pizarra ANTES de escribir el resumen (nunca lo redactes sin la herramienta: sin borrador no se puede guardar). Con su resultado envía este resumen y pregunta:
    "📌 Recordatorio (por confirmar)
    • Recordatorio: <texto>
    • Clasificación: <clasificacion> › <subclasificacion>
    • Prioridad: <Crítico/Alto/Medio/Bajo>
    • Para: <personal o 'Sin asignar'>
    • Día: <fecha_texto>
    ¿Lo agrego? (sí / no / cambios)"
    Si hay no_encontrados o ambiguos, dilo en una línea.
  · Igual que en tareas: SOLO cuando el admin confirme en un mensaje POSTERIOR llama confirmar_recordatorio_pizarra (directo, sin volver a preparar). Si responde que no hay borrador, llama preparar_recordatorio_pizarra con los datos del resumen y luego confirmar_recordatorio_pizarra en ese mismo turno. Si pide cambios, vuelve a preparar con todo corregido. Si dice "no", responde "Cancelado.".
  · Tras confirmar: "✅ Recordatorio guardado (folio X); aparece en Pendientes del día." (1 línea).
- LIMPIEZAS DE HOY — "resumen de limpieza", "limpiezas de hoy", "lista de limpiezas", "limpiezas hoy", "¿cómo va el aseo?": llama consultar_limpiezas_hoy y responde con formatted_message TAL CUAL. "mis limpiezas", "qué me toca", "mis aseos/inspecciones" → solo_mias=true; "limpiezas de Alma" → persona="Alma". No expliques cómo filtra.
- ESTADO DE ASEO — "cu2 listo", "Jc1 terminado Alma", "ox1 inspeccionado", "Cumbres 2 terminado y validado", "bc7 empezando":
  · Llama preparar_estado_aseo con los alojamientos TAL CUAL (el backend los reconoce aunque vengan abreviados o mal escritos), el estado (listo/terminado = terminado · inspeccionado/revisado = inspeccionado · empezando/limpiando = en_proceso), validado=true solo si lo dice explícitamente, y persona si nombra a alguien.
  · Envía el campo resumen TAL CUAL. SOLO cuando responda "sí" en un mensaje POSTERIOR llama confirmar_estado_aseo. Si corrige algo, vuelve a preparar con todo corregido. Si dice "no", responde "Cancelado.".
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
    name: "preparar_estado_aseo",
    description: "ADMIN o PERSONAL. Prepara (NO guarda) la actualización del ESTADO DE ASEO de uno o varios alojamientos (ej. 'cu2 listo', 'Jc1 terminado Alma', 'ox1 inspeccionado', 'Cumbres 2 terminado y validado'). El backend reconoce el alojamiento aunque venga abreviado o con errores (cu2, jc2, 'jose cardenas 2', 'oaxaca1', 'oxaca 1'…), busca la reserva que salió, y asigna a la persona (la del celular, o la que se nombre en el texto). Devuelve draft_id + resumen para mostrar y pedir confirmación.",
    input_schema: {
      type: "object",
      properties: {
        alojamientos: { type: "array", items: { type: "string" }, description: "Alojamientos TAL CUAL los escribió el usuario (ej. ['cu2'], ['jose cardenas 2','ox1'])." },
        estado: { type: "string", enum: ["en_proceso", "terminado", "inspeccionado"], description: "listo/lista/terminado/terminé/acabé/limpio = terminado · inspeccionado/revisado/checado/supervisado = inspeccionado · empezando/limpiando/en proceso = en_proceso." },
        validado: { type: "boolean", description: "true SOLO si dice explícitamente validado/validar/publicado/publícalo. 'inspeccionado' siempre se publica solo." },
        persona: { type: "string", description: "Opcional. Nombre de quien hizo el aseo/inspección SI lo menciona (ej. 'Alma'). Si no lo menciona, se usa el dueño del celular." },
      },
      required: ["alojamientos", "estado"],
    },
  },
  {
    name: "consultar_limpiezas_hoy",
    description: "ADMIN o PERSONAL. Lista de limpiezas de HOY (las mismas cards de Control de aseo): cada alojamiento con su estado de aseo y quién hizo aseo e inspección; primero los que tienen entrada hoy. Usar ante 'resumen de limpieza', 'limpiezas de hoy', 'lista de limpiezas', 'limpiezas hoy', '¿cómo va el aseo?' o similares. Con solo_mias=true ('mis limpiezas', 'qué me toca', 'mis aseos') filtra a lo asignado a quien escribe (según su número de WhatsApp); con persona ('limpiezas de Alma') filtra a esa persona.",
    input_schema: { type: "object", properties: {
      solo_mias: { type: "boolean", description: "true si pide SUS limpiezas ('mis limpiezas', 'qué me toca', 'mis inspecciones')." },
      persona: { type: "string", description: "Opcional. Nombre (aunque sea corto) para ver solo lo asignado a esa persona." },
    }, required: [] },
  },
  {
    name: "confirmar_estado_aseo",
    description: "ADMIN o PERSONAL. Guarda la actualización de estado de aseo preparada con preparar_estado_aseo. Llamar ÚNICAMENTE después de que el usuario confirmó ('sí') en un mensaje posterior al resumen.",
    input_schema: { type: "object", properties: { draft_id: { type: "string" } }, required: [] },
  },
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
    name: "preparar_tarea_programada",
    description: "SOLO modo ADMIN. Prepara (NO guarda) una tarea programada de naturaleza 'Único' para el módulo Tareas programadas. El backend asigna clasificación y subclasificación del catálogo a partir de la descripción y resuelve el personal contra la hoja Personal (acepta nombres cortos o incompletos). Devuelve draft_id + resumen para que se lo muestres al admin y le pidas confirmación.",
    input_schema: {
      type: "object",
      properties: {
        descripcion: { type: "string", description: "Qué hay que hacer (nombre de la tarea), claro y breve." },
        fecha:       { type: "string", description: "Fecha única YYYY-MM-DD ya convertida desde el lenguaje natural del admin." },
        personal:    { type: "array", items: { type: "string" }, description: "Opcional. Nombres tal como los escribió el admin (pueden ser cortos/incompletos)." },
        fecha_limite: { type: "boolean", description: "true si la fecha es un LÍMITE para tenerla resuelta ('fecha límite', 'a más tardar', 'antes del', 'tiene hasta el', 'para el … sin falta')." },
      },
      required: ["descripcion", "fecha"],
    },
  },
  {
    name: "consultar_pendientes_del_dia",
    description: "SOLO modo ADMIN. Devuelve los pendientes de un día (tareas programadas y recordatorios del módulo Tareas programadas, igual que 'Pendientes del día' del Panel de control) agrupados por estado y ordenados por prioridad, con un formatted_message listo para enviar por WhatsApp.",
    input_schema: {
      type: "object",
      properties: {
        fecha: { type: "string", description: "Opcional. Día YYYY-MM-DD; por defecto hoy." },
        solo_mios: { type: "boolean", description: "true si el admin pide SUS pendientes (filtra por su nombre)." },
        personal: { type: "string", description: "Opcional. Nombre (aunque sea corto) para ver solo los pendientes de esa persona." },
        incluir_resueltos: { type: "boolean", description: "true para listar también lo resuelto/cancelado ese día (por defecto solo se cuenta)." },
      },
      required: [],
    },
  },
  {
    name: "preparar_recordatorio_pizarra",
    description: "SOLO modo ADMIN. Prepara (NO guarda) un RECORDATORIO: se guarda en Tareas programadas con tipo Recordatorio (siempre único, aparece cada día en Pendientes del día hasta resolverse). El backend asigna clasificación y subclasificación del catálogo. Resuelve el personal contra la hoja Personal (acepta nombres cortos o incompletos). Devuelve draft_id + resumen para mostrar al admin y pedir confirmación.",
    input_schema: {
      type: "object",
      properties: {
        texto:     { type: "string", description: "El recordatorio, breve y claro." },
        prioridad: { type: "string", enum: ["critica", "alta", "media", "baja"], description: "Urgencia inferida del mensaje (critica = emergencia/ya mismo/crítico; alta = urgente/importante/hoy sin falta; baja = sin prisa; media = resto)." },
        personal:  { type: "array", items: { type: "string" }, description: "Opcional. Nombres tal como los escribió el admin." },
        fecha:     { type: "string", description: "Opcional. Día YYYY-MM-DD; por defecto hoy." },
      },
      required: ["texto"],
    },
  },
  {
    name: "confirmar_recordatorio_pizarra",
    description: "SOLO modo ADMIN. Guarda (en Tareas programadas, tipo Recordatorio) el recordatorio preparado con preparar_recordatorio_pizarra. Llamar ÚNICAMENTE después de que el admin confirmó en un mensaje posterior al resumen.",
    input_schema: {
      type: "object",
      properties: { draft_id: { type: "string", description: "Opcional: draft_id devuelto por preparar_recordatorio_pizarra." } },
      required: [],
    },
  },
  {
    name: "confirmar_tarea_programada",
    description: "SOLO modo ADMIN. Guarda la tarea preparada con preparar_tarea_programada. Llamar ÚNICAMENTE después de que el admin confirmó en un mensaje posterior al resumen.",
    input_schema: {
      type: "object",
      properties: { draft_id: { type: "string", description: "Opcional: draft_id devuelto por preparar_tarea_programada (si no lo tienes, se usa la tarea pendiente del admin)." } },
      required: [],
    },
  },
  {
    name: "listar_reservas_sin_ticket",
    description: "Lista las reservas DEL HUÉSPED ACTUAL que aún no tienen ticket de auto-facturación emitido (no tienen 'Folio facturapi'). Devuelve dos arreglos: `items` (elegibles: arrival <= hoy, estadía iniciada o completada) y `futuras` (Booked pero cuyo arrival aún NO llega — NO se pueden facturar todavía). Úsalo cuando el huésped pregunte por su ticket / factura / autofacturación / CFDI. NO requiere confirmación. Si el huésped pide facturar una reserva de `futuras`, RESPONDE con el mensaje exacto de la nota 'ticket_no_iniciado' (ver instrucciones abajo). Si `items` y `futuras` están vacíos, dile que todas están facturadas.",
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
    name: "solicitar_extension",
    description: "Registra una solicitud de EXTENSIÓN DE RESERVA (el huésped quiere quedarse más noches). El admin la coordina y marca 'atendida' cuando queda arreglada. Responde al huésped: 'registrado, el equipo revisa disponibilidad y te contacta'.",
    input_schema: {
      type: "object",
      properties: {
        nueva_salida: { type: "string", description: "Fecha nueva de salida en formato YYYY-MM-DD (si el huésped la mencionó explícita)." },
        noches_extra: { type: "integer", description: "Número de noches adicionales que solicita (si el huésped lo mencionó así en vez de fecha)." },
        notas:        { type: "string", description: "Cualquier detalle relevante (motivo, huéspedes adicionales, etc.)." },
      },
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
// ─── Bot admin → Tareas programadas ─────────────────────────────────────────
// ─── Bot admin → Pendientes del día (misma lógica que el módulo Tareas) ─────
async function _botRhListCached(action) {
  const c = _rhListCache.get(action);
  if (c && Date.now() - c.ts < 60 * 1000) return (c.payload && c.payload.rows) || [];
  const r = await callCheckinAppsScript(action);
  if (r && r.ok && Array.isArray(r.rows)) { _rhListCache.set(action, { ts: Date.now(), payload: r }); return r.rows; }
  return (c && c.payload && c.payload.rows) || [];
}
function _botIsoDay(v) { const m = String(v || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : ""; }
function _botTarProg(r) {
  let p = null; try { p = JSON.parse(String(r.Programacion || "") || "null"); } catch (_) {}
  p = Object.assign({ tipo: r.Naturaleza === "Recurrente" ? "semanal" : "unica", fechas: [], dias_semana: [], dias_mes: [], inicio: "", fin: "" }, p || {});
  ["fechas", "dias_semana", "dias_mes"].forEach(k => { if (!Array.isArray(p[k])) p[k] = []; });
  return p;
}
function _botTarDelDia(rows, ocur, iso, hoy) {
  const byTar = new Map();
  ocur.forEach(o => { if (!byTar.has(o.Tarea_ID)) byTar.set(o.Tarea_ID, []); byTar.get(o.Tarea_ID).push(o); });
  byTar.forEach(a => a.sort((x, y) => _botIsoDay(x.Fecha).localeCompare(_botIsoDay(y.Fecha))));
  const out = [];
  for (const r of rows) {
    if (!r.ID) continue;
    const rec = String(r.Tipo || "") === "Recordatorio";
    const vig = /paus/i.test(r.Estado || "") ? "Pausada" : /cancel/i.test(r.Estado || "") ? "Cancelada" : "Activa";
    const p = _botTarProg(r), a = byTar.get(r.ID) || [];
    let toca = false, oc = null;
    if (rec) {
      const ini = p.fechas.slice().sort()[0] || _botIsoDay(r.Timestamp) || hoy;
      const last = a[a.length - 1];
      const cierre = last && /^(Resuelto|Cancelado)$/.test(last.Estado) ? _botIsoDay(last.Fecha) : "";
      toca = iso >= ini && iso <= (cierre || hoy);
      for (const x of a) { if (_botIsoDay(x.Fecha) <= iso) oc = x; else break; }
    } else {
      const d = new Date(iso + "T12:00:00");
      if (p.tipo === "unica") toca = p.fechas.includes(iso);
      else {
        const inicio = p.inicio || _botIsoDay(r.Timestamp);
        if (!(inicio && iso < inicio) && !(p.fin && iso > p.fin)) {
          if (p.tipo === "semanal") toca = p.dias_semana.map(Number).includes(d.getDay());
          else {
            const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(), day = d.getDate();
            toca = p.dias_mes.some(x => Number(x) === day || (day === dim && Number(x) > dim));
            if (toca && p.tipo === "bimestral") { const b = inicio ? new Date(inicio + "T12:00:00") : d; const diff = (d.getFullYear() - b.getFullYear()) * 12 + (d.getMonth() - b.getMonth()); toca = ((diff % 2) + 2) % 2 === 0; }
          }
        }
      }
      oc = a.find(x => _botIsoDay(x.Fecha) === iso) || null;
    }
    if (!toca || (vig !== "Activa" && !oc)) continue;
    out.push({ r, rec, estado: (oc && oc.Estado) || "Pendiente", por: (oc && oc.Atendido_por) || "" });
  }
  return out;
}
const _BOT_PRIO_W = { "Crítico": 4, "Alto": 3, "Medio": 2, "Bajo": 1 };
const _BOT_PRIO_E = { "Crítico": "🔴", "Alto": "🟠", "Medio": "🟡", "Bajo": "🔵" };
const _BOT_ADMIN_ONLY_TOOLS = new Set(["consultar_limpiezas_hoy", "preparar_estado_aseo", "confirmar_estado_aseo", "consultar_pendientes_del_dia", "crear_incidencia", "preparar_tarea_programada", "confirmar_tarea_programada", "preparar_recordatorio_pizarra", "confirmar_recordatorio_pizarra"]);
const _botPzDrafts = new Map(); // phone10 → recordatorio de pizarra pendiente de confirmar
const _botAseoDrafts = new Map(); // phone10 → actualización de estado de aseo pendiente de confirmar
const _ASEO_EST_TXT = { en_proceso: "En proceso", terminado: "Terminado", inspeccionado: "Inspeccionado" };
// ¿El mensaje actual es un "sí" a un resumen "(por confirmar)" que el bot YA envió?
// Cubre el caso en que el modelo escribió el resumen sin preparar el borrador y,
// al recibir el "sí", prepara y confirma en el mismo turno (el candado lo bloqueaba
// y el bot se ciclaba repitiendo el resumen).
function _botEsSiAResumen(ctx, marca) {
  const t = _botNorm(ctx.userMsg || "");
  const si = /^(si|sip|simon|ok|okay|va|vale|dale|claro|correcto|confirmo|confirmado|de acuerdo|adelante|hazlo|agregalo|agregala|guardalo|guardala|registralo|registrala|si (agregalo|agregala|guardalo|guardala|por favor|porfa|confirmo|hazlo|dale|adelante|correcto|claro|registralo|registrala))( por favor| porfa| gracias)?$/.test(t);
  return si && /por confirmar/i.test(ctx.lastAssistant || "") && marca.test(ctx.lastAssistant || "");
}
const _botTarDrafts = new Map(); // phone10 → borrador pendiente de confirmar
const _BOT_TAR_DEFAULT_CLASIF = { "Recursos humanos": [], "Servicios": [], "Limpieza": [], "Mantenimiento": [], "Inventarios": [], "Proveedores": [] };
function _botNorm(s) { return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9ñ ]/g, " ").replace(/\s+/g, " ").trim(); }
function _botFechaLarga(iso) {
  const t = new Date(iso + "T12:00:00").toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return t.charAt(0).toUpperCase() + t.slice(1);
}
let _botPersCache = { ts: 0, list: [] };
async function _botPersonalActivo() {
  if (_botPersCache.list.length && Date.now() - _botPersCache.ts < 10 * 60 * 1000) return _botPersCache.list;
  const r = await callCheckinAppsScript("list_personal");
  const full = pr => {
    const nom = String(pr.Nombre || "").trim(), ap = String(pr.Apellido_paterno || "").trim(), am = String(pr.Apellido_materno || "").trim();
    const n = _botNorm(nom);
    if ((!ap || n.includes(_botNorm(ap))) && (!am || n.includes(_botNorm(am)))) return nom;
    return [nom, ap, am].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  };
  const list = Array.from(new Set(((r && r.rows) || []).filter(x => !x.Estado || /activo/i.test(String(x.Estado))).map(full).filter(Boolean)));
  _botPersCache = { ts: Date.now(), list };
  return list;
}
// Nombres cortos/incompletos → nombre completo del Personal. "Juani"→"Juana …", "Paco"→"Francisco …".
const _BOT_APODOS = { paco: "francisco", pancho: "francisco", pepe: "jose", chuy: "jesus", lupe: "guadalupe", lalo: "eduardo", memo: "guillermo", toño: "antonio", tono: "antonio", nacho: "ignacio", beto: "alberto", juani: "juana", gaby: "gabriela", lety: "leticia", male: "maria elena", rosy: "rosa", cris: "cristina", fer: "fernanda", ale: "alejandra", dany: "daniela" };
function _botResolverPersonal(qs, nombres) {
  const ok = [], no = [], amb = {};
  const idx = nombres.map(n => ({ n, toks: _botNorm(n).split(" ") }));
  for (const raw of qs) {
    const q = _botNorm(raw).replace(/^(la|el|a|de|del)\s+/, "");
    if (!q) continue;
    const variantes = [q, _BOT_APODOS[q.split(" ")[0]] ? q.replace(q.split(" ")[0], _BOT_APODOS[q.split(" ")[0]]) : null].filter(Boolean);
    let cands = [];
    for (const v of variantes) {
      const qt = v.split(" ").filter(t => t.length > 1);
      // 1) cada palabra del nombre buscado es inicio de alguna palabra del nombre completo
      cands = idx.filter(x => qt.every(t => x.toks.some(w => w.startsWith(t))));
      // 2) si no hay, prefijo de 3+ letras (ej. "juani" → "juana")
      if (!cands.length) cands = idx.filter(x => qt.every(t => t.length >= 3 && x.toks.some(w => w.startsWith(t.slice(0, Math.max(3, t.length - 2))))));
      if (cands.length) break;
    }
    // 3) frases con palabras de relleno ("la de limpieza Alma"): basta una palabra que identifique a una sola persona.
    if (!cands.length) {
      const RELL = new Set(["la", "el", "de", "del", "los", "las", "y", "a", "con", "limpieza", "mantenimiento", "senora", "senor", "sra", "sr", "don", "dona", "chica", "chico", "muchacha", "muchacho", "tecnico", "supervisor", "supervisora"]);
      for (const t of q.split(" ").filter(t => t.length >= 3 && !RELL.has(t))) {
        const c = idx.filter(x => x.toks.some(w => w.startsWith(t)));
        if (c.length === 1) { cands = c; break; }
        if (c.length > 1 && !cands.length) cands = c;
      }
    }
    if (cands.length === 1) { if (!ok.includes(cands[0].n)) ok.push(cands[0].n); }
    else if (cands.length > 1) amb[raw] = cands.map(c => c.n).slice(0, 5);
    else no.push(raw);
  }
  return { ok, no, amb };
}
async function _botTarCatalogo() {
  try {
    const r = await callCheckinAppsScript("tareas_config_list");
    const row = ((r && r.rows) || []).find(x => x.ID === "CATALOGO");
    const c = row ? JSON.parse(row.Clasificaciones_json || "null") : null;
    if (c && typeof c === "object" && Object.keys(c).length) return c;
  } catch (_) {}
  return _BOT_TAR_DEFAULT_CLASIF;
}
async function _botTarClasificar(desc, cat) {
  const enumTxt = Object.entries(cat).map(([k, subs]) => `${k}: ${(subs || []).join(" | ") || "(sin sub-clasificaciones)"}`).join("\n");
  try {
    const out = await _llmChat({
      system: `Eres un clasificador. Recibes la descripción de una tarea operativa de un negocio de rentas vacacionales y devuelves JSON estricto {"clasificacion":"…","subclasificacion":"…"} usando SOLO valores del catálogo. Si ninguna sub-clasificación aplica, usa "". Sin texto extra.\n\nCATÁLOGO (clasificación: sub-clasificaciones):\n${enumTxt}`,
      history: [], userMsg: `Tarea: "${desc}"\nDevuelve JSON.`,
    });
    const p = JSON.parse(String(out.text || "").trim().replace(/^```json?\s*|\s*```$/g, ""));
    const cl = Object.keys(cat).find(k => _botNorm(k) === _botNorm(p.clasificacion)) || "";
    const sub = cl ? ((cat[cl] || []).find(x => _botNorm(x) === _botNorm(p.subclasificacion)) || "") : "";
    return { clasificacion: cl, subclasificacion: sub };
  } catch (e) { console.warn("[bot-tarea] clasificar:", e.message); return { clasificacion: "", subclasificacion: "" }; }
}
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
      // Solo Booked (Lodgify) — igual que _botFindActiveBooking.
      const bookingsRaw = (j && j.ok && Array.isArray(j.bookings)) ? j.bookings : [];
      const bookings = bookingsRaw.filter(b => {
        // Manual/huRows heredan Status vacío o 'Manual' → los conservamos.
        const st = String(b.Status || '').toLowerCase();
        if (!st || st === 'manual') return true;
        return st === 'booked';
      });
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
        const elegibles = [];
        const futuras = [];
        for (const x of items) {
          if (!x.DateArrival) continue;
          const st = String(x.Status || '').toLowerCase();
          if (st && st !== 'booked' && st !== 'manual') continue;
          if (x.FolioFacturapi || x.TicketUrl) continue;
          const clean = ({ Status, ...rest }) => rest;
          if (x.DateArrival > hoy) futuras.push(clean(x));
          else elegibles.push(clean(x));
        }
        return { content: JSON.stringify({ ok: true, count: elegibles.length, items: elegibles, futuras }) };
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
    // Helper: registra en Solicitudes_Pendientes + arma notifyText común +
    // envía mensaje automático "SOL: registro" al huésped (fire-and-forget).
    async function _regSolicitud(tipo, resumen, reservaId) {
      const nombre = String(bk.GuestName || '').trim();
      const notifyText = `📌 SOLICITUD (${tipo}) vía bot\nPhone: +${ctx.phone10}${nombre?` · ${nombre}`:''}${reservaId?`\nReserva: ${reservaId}`:''}\n\n${resumen}`;
      try {
        fetch(`http://127.0.0.1:${PORT}/solicitudes`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ payload: { Phone: ctx.phone10, Tipo: tipo, ReservaId: reservaId || '', Resumen: resumen } }),
        }).catch(()=>{});
      } catch(_){}
      // NOTA: no enviamos acuse determinístico aquí — el LLM (siguiendo el
      // prompt del proceso) responde al huésped después de que la tool
      // termina. Enviar acuse aquí + reply del LLM = mensaje duplicado.
      // Si en el futuro Claude devuelve vacío con frecuencia, considerar
      // acuse fallback SOLO cuando reply.text === '' en el webhook.
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
    if (name === "solicitar_extension") {
      const nuevaSalida = String(args.nueva_salida || '').trim();
      const nochesExtra = Number(args.noches_extra || 0);
      if (!nuevaSalida && !nochesExtra) return { content: JSON.stringify({ ok:false, error:'nueva_salida o noches_extra requerida' }) };
      const notas = String(args.notas || '').trim();
      const arrival = String(bk.DateArrival || bk['Fecha de ingreso'] || '').slice(0,10);
      const departureActual = String(bk.DateDeparture || bk['Fecha de salida'] || '').slice(0,10);
      const reservaId = String(bk.Id || '');
      const detalle = nuevaSalida ? `hasta ${nuevaSalida}` : `${nochesExtra} noche${nochesExtra===1?'':'s'} extra`;
      const resumen = `Extensión de reserva: ${detalle}${departureActual?` (salida actual ${departureActual})`:''}${arrival?`, arrival ${arrival}`:''}${notas?`\nNotas: ${notas}`:''}`;
      const notifyText = await _regSolicitud('extension', resumen, reservaId);
      return { content: JSON.stringify({ ok:true, mensaje:'Solicitud registrada. El equipo coordina y te contacta.' }), notifyText };
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
      let bkArrIso = '';
      let bkDepIso = '';
      let bkAlojLabel = '';
      let bkStatus = '';
      let bkFound = false;
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/lodgify-list`);
        const j = await r.json();
        const bk = (j && Array.isArray(j.bookings) ? j.bookings : []).find(x => String(x.Id) === reservaId);
        if (bk) {
          bkFound = true;
          bkStatus = String(bk.Status || '');
          const aloj = String(bk.HouseName || `HouseId ${bk.HouseId || '?'}`);
          bkAlojLabel = aloj;
          const arr = String(bk.DateArrival || '').slice(0,10);
          const dep = String(bk.DateDeparture || '').slice(0,10);
          const toIso = s => { const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}` : s; };
          bkArrIso = toIso(arr);
          bkDepIso = toIso(dep);
          const tot = Number(bk.TotalAmount) || 0;
          const cur = String(bk.Currency || 'MXN');
          const nombre = String(bk.GuestName || '').trim();
          bkResumen = `${aloj} · ${arr} → ${dep} · Total $${tot.toLocaleString('es-MX',{minimumFractionDigits:2,maximumFractionDigits:2})} ${cur}${nombre?` · Huésped: ${nombre}`:''} · Id: ${reservaId}`;
        }
      } catch(_){}
      // Guard: reserva Lodgify NO Booked (Open/Tentative/Declined/Cancelled/Deleted)
      // NO puede facturarse — no importa la fecha. Bloquea antes de crear solicitud.
      if (bkFound && bkStatus && bkStatus.toLowerCase() !== 'booked') {
        return { content: JSON.stringify({
          ok: false, error: 'reserva_no_confirmada',
          mensaje: `Esa reserva no está confirmada (estado: ${bkStatus}). Solo se pueden emitir tickets de reservas confirmadas. Si crees que es un error, avísale al equipo. 🙏`,
        }) };
      }
      // Regla: solo se puede solicitar el ticket a partir del día de entrada.
      const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Mexico_City' });
      if (bkArrIso && bkArrIso > hoy) {
        return { content: JSON.stringify({
          ok: false, error: 'estancia_no_iniciada',
          mensaje: `El ticket de auto-facturación se puede generar únicamente a partir del día de entrada (${bkArrIso}). Vuelve a solicitarlo desde esa fecha en adelante y con gusto lo tramitamos. 📄`,
          arrival: bkArrIso, departure: bkDepIso, alojamiento: bkAlojLabel,
        }) };
      }
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
    if (name === "preparar_tarea_programada") {
      if (!ctx.isAdmin) return { content: JSON.stringify({ ok: false, error: "Solo administradores" }), notifyText: null };
      const desc = String(args.descripcion || "").trim();
      const fecha = String(args.fecha || "").trim();
      if (!desc) return { content: JSON.stringify({ ok: false, error: "Falta la descripción de la tarea" }), notifyText: null };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || isNaN(new Date(fecha + "T12:00:00"))) return { content: JSON.stringify({ ok: false, error: "Fecha inválida: usa YYYY-MM-DD" }), notifyText: null };
      const hoy = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Mexico_City" });
      if (fecha < hoy) return { content: JSON.stringify({ ok: false, error: `La fecha ${fecha} ya pasó (hoy es ${hoy}). Pide otra fecha.` }), notifyText: null };
      const [cat, nombres] = await Promise.all([_botTarCatalogo(), _botPersonalActivo().catch(() => [])]);
      const per = _botResolverPersonal(Array.isArray(args.personal) ? args.personal : (args.personal ? [String(args.personal)] : []), nombres);
      const clas = await _botTarClasificar(desc, cat);
      const nombre = desc.charAt(0).toUpperCase() + desc.slice(1);
      const id = "TD" + Date.now().toString(36);
      const yaConfirmo = _botEsSiAResumen(ctx, /tarea programada/i);
      const draft = { id, msgTs: yaConfirmo ? 0 : (ctx.msgTs || Date.now()), exp: Date.now() + 30 * 60 * 1000, nombre, fecha, clasificacion: clas.clasificacion, subclasificacion: clas.subclasificacion, personal: per.ok, limite: args.fecha_limite === true };
      _botTarDrafts.set(ctx.phone10, draft);
      // El "sí" ya llegó: se guarda aquí mismo (no dependemos de que el modelo llame confirmar).
      if (yaConfirmo) {
        const rc = await _botExecTool({ name: "confirmar_tarea_programada", input: { draft_id: id } }, ctx);
        let jr = {}; try { jr = JSON.parse(rc.content || "{}"); } catch (_) {}
        return { content: JSON.stringify(Object.assign(jr, { instruccion: jr.ok ? "Tarea GUARDADA. Responde en 1 línea con el folio: ✅ Tarea guardada (folio X) para <fecha_texto>. No vuelvas a mostrar el resumen." : "No se pudo guardar: explica el error en 1 línea." })), notifyText: null };
      }
      return { content: JSON.stringify({ ok: true, draft_id: id, nombre, fecha_iso: fecha, fecha_texto: _botFechaLarga(fecha),
        clasificacion: clas.clasificacion || "Sin clasificación", subclasificacion: clas.subclasificacion || "—",
        personal_asignado: per.ok, no_encontrados: per.no, ambiguos: per.amb, fecha_limite: draft.limite ? "Sí — debe quedar resuelta a más tardar en esa fecha" : "No",
        instruccion: yaConfirmo ? "El admin YA confirmó el resumen anterior con este mensaje: llama confirmar_tarea_programada ahora, sin volver a mostrar el resumen." : "Muestra el resumen al admin y pregunta si confirma. NO llames confirmar_tarea_programada hasta que responda en un mensaje nuevo." }), notifyText: null };
    }
    if (name === "consultar_pendientes_del_dia") {
      if (!ctx.isAdmin) return { content: JSON.stringify({ ok: false, error: "Solo administradores" }), notifyText: null };
      const hoy = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Mexico_City" });
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(args.fecha || "")) ? String(args.fecha) : hoy;
      const [rows, ocur] = await Promise.all([_botRhListCached("tareas_list"), _botRhListCached("tareas_ocur_list")]);
      let items = _botTarDelDia(rows, ocur, fecha, hoy);
      // Filtro por persona (solo_mios → nombre del admin; personal → nombre corto/apodo)
      let quien = "";
      const pedidos = args.solo_mios ? [ctx.adminNombre || ""] : (args.personal ? [String(args.personal)] : []);
      if (pedidos.filter(Boolean).length) {
        const nombres = Array.from(new Set(rows.flatMap(r => String(r.Personal || "").split(",").map(x => x.trim()).filter(Boolean))));
        const res = _botResolverPersonal(pedidos.filter(Boolean), nombres);
        const objetivo = res.ok.length ? res.ok : [];
        if (!objetivo.length) return { content: JSON.stringify({ ok: true, fecha, formatted_message: `No encontré pendientes asignados a "${pedidos[0]}" para ${fecha === hoy ? "hoy" : _botFechaLarga(fecha)}.` }), notifyText: null };
        quien = objetivo.join(", ");
        items = items.filter(x => String(x.r.Personal || "").split(",").map(n => n.trim()).some(n => objetivo.includes(n)));
      }
      const abiertos = items.filter(x => x.estado === "Pendiente" || x.estado === "En proceso");
      const cerrados = items.filter(x => !(x.estado === "Pendiente" || x.estado === "En proceso"));
      const sortP = (a, b) => (_BOT_PRIO_W[b.r.Prioridad] || 2) - (_BOT_PRIO_W[a.r.Prioridad] || 2) || String(a.r.Nombre).localeCompare(String(b.r.Nombre), "es");
      const linea = x => {
        const per = String(x.r.Personal || "").split(",").map(n => n.trim()).filter(Boolean).map(n => n.split(" ")[0]).join(", ");
        const lim = String(x.r.Fecha_limite || "") === "Sí" ? " ⏳" : "";
        return `${_BOT_PRIO_E[x.r.Prioridad] || "🟡"} ${x.rec ? "📌" : "📋"} ${x.r.Nombre}${per ? ` — ${per}` : ""}${lim}`;
      };
      const tit = fecha === hoy ? "hoy" : _botFechaLarga(fecha);
      const partes = [`📋 *Pendientes ${fecha === hoy ? "del día" : "de " + tit}*${quien ? ` · ${quien}` : ""}`, `${abiertos.length} abierto${abiertos.length === 1 ? "" : "s"} · ${cerrados.length} cerrado${cerrados.length === 1 ? "" : "s"}`];
      const enProc = abiertos.filter(x => x.estado === "En proceso").sort(sortP), pend = abiertos.filter(x => x.estado === "Pendiente").sort(sortP);
      if (enProc.length) partes.push("", "⏳ *En proceso*", ...enProc.map(linea));
      if (pend.length) partes.push("", "📝 *Pendientes*", ...pend.map(linea));
      if (!abiertos.length) partes.push("", "✨ No hay pendientes abiertos.");
      if (args.incluir_resueltos && cerrados.length) partes.push("", "✅ *Resueltos / cancelados*", ...cerrados.sort(sortP).map(x => `${x.estado === "Cancelado" ? "✖️" : "✅"} ${x.rec ? "📌" : "📋"} ${x.r.Nombre}`));
      partes.push("", "🔴 Crítico · 🟠 Alto · 🟡 Medio · 🔵 Bajo · 📌 Recordatorio · 📋 Tarea · ⏳ Fecha límite");
      return { content: JSON.stringify({ ok: true, fecha, total: items.length, abiertos: abiertos.length, formatted_message: partes.join("\n") }), notifyText: null };
    }
    if (name === "consultar_limpiezas_hoy") {
      if (!ctx.isAdmin && !ctx.isStaff) return { content: JSON.stringify({ ok: false, error: "Solo personal autorizado" }), notifyText: null };
      let quien = "";
      if (args.persona) {
        const rp = _botResolverPersonal([String(args.persona)], await _botPersonalActivo().catch(() => []));
        if (!rp.ok.length) return { content: JSON.stringify({ ok: false, error: (rp.amb && Object.keys(rp.amb).length) ? `"${args.persona}" puede ser: ${Object.values(rp.amb)[0].join(", ")}` : `No encontré a "${args.persona}" en Personal` }), notifyText: null };
        quien = rp.ok[0];
      } else if (args.solo_mias) {
        quien = ctx.staffNombre || ctx.adminNombre || "";
        if (!quien) return { content: JSON.stringify({ ok: false, error: "No identifiqué a quién pertenece este número de WhatsApp en Personal." }), notifyText: null };
      }
      if (quien) {
        const txt = await _aseoListaEmpleado(quien, { consulta: true });
        return { content: JSON.stringify({ ok: true, persona: quien, formatted_message: txt || `🧽 ${quien.split(" ")[0]}, no ${args.persona ? "tiene" : "tienes"} limpiezas ni inspecciones asignadas hoy.`, instruccion: "Responde con formatted_message TAL CUAL, sin agregar explicaciones." }), notifyText: null };
      }
      const r = await _aseoResumenHoy();
      return { content: JSON.stringify({ ok: true, total: r.total, formatted_message: r.formatted_message, instruccion: "Responde con formatted_message TAL CUAL, sin resumirlo ni reordenarlo ni agregar explicaciones." }), notifyText: null };
    }
    if (name === "preparar_estado_aseo") {
      if (!ctx.isAdmin && !ctx.isStaff) return { content: JSON.stringify({ ok: false, error: "Solo personal autorizado" }), notifyText: null };
      const estado = ["en_proceso", "terminado", "inspeccionado"].includes(args.estado) ? args.estado : "";
      if (!estado) return { content: JSON.stringify({ ok: false, error: "No identifiqué el estado (en proceso / terminado / inspeccionado)" }), notifyText: null };
      const qs = (Array.isArray(args.alojamientos) ? args.alojamientos : [args.alojamientos]).map(x => String(x || "").trim()).filter(Boolean).slice(0, 10);
      if (!qs.length) return { content: JSON.stringify({ ok: false, error: "Falta el alojamiento" }), notifyText: null };
      const cat = await _aseoCatalogo();
      const items = [], errores = [];
      for (const q of qs) {
        const m = _aseoMatchAloj(q, cat);
        if (!m.ok) { errores.push(m.error); continue; }
        if (!m.aloj.hid) { errores.push(`${m.aloj.nombre}: no tiene número de Lodgify en el catálogo de alojamientos`); continue; }
        // Sin salida registrada: el estado se guarda a nombre del alojamiento ("H<hid>").
        const t = await _aseoTurnover(m.aloj.hid);
        items.push({ q, hid: m.aloj.hid, nombre: m.aloj.nombre, code: m.aloj.code.toUpperCase(), booking: t ? t.id : "H" + m.aloj.hid, salida: t ? t.dep : "", huesped: t ? (t.guest || "") : "", seguro: m.seguro });
      }
      // Persona: la nombrada en el texto (tolerante a nombres cortos) o el dueño del celular.
      let persona = ctx.staffNombre || ctx.adminNombre || "", personaNota = "";
      if (args.persona) {
        const r = _botResolverPersonal([String(args.persona)], await _botPersonalActivo().catch(() => []));
        if (r.ok.length) persona = r.ok[0];
        else personaNota = (r.amb && Object.keys(r.amb).length) ? `"${args.persona}" puede ser: ${Object.values(r.amb)[0].join(", ")}` : `No encontré a "${args.persona}" en Personal`;
      }
      if (!items.length) return { content: JSON.stringify({ ok: false, errores, instruccion: "Explica el problema en 1-2 líneas y pide el alojamiento correcto (ej. CU2, JC1, OX3)." }), notifyText: null };
      const validar = estado !== "terminado" || !!args.validado;
      const id = "AS" + Date.now().toString(36);
      const yaConfirmo = _botEsSiAResumen(ctx, /aseo/i);
      const draft = { id, msgTs: yaConfirmo ? 0 : (ctx.msgTs || Date.now()), exp: Date.now() + 30 * 60 * 1000, estado, validar, persona, items };
      _botAseoDrafts.set(ctx.phone10, draft);
      if (yaConfirmo) {
        const rc = await _botExecTool({ name: "confirmar_estado_aseo", input: { draft_id: id } }, ctx);
        let jr = {}; try { jr = JSON.parse(rc.content || "{}"); } catch (_) {}
        return { content: JSON.stringify(Object.assign(jr, { instruccion: jr.ok ? "GUARDADO. Responde en 1-2 líneas con lo guardado. No vuelvas a mostrar el resumen." : "No se pudo guardar: explica el error en 1 línea." })), notifyText: null };
      }
      if (!_aseo.estados || Date.now() - (_aseo.estadosTs || 0) > 15_000) { _aseo.estados = await _rhdGetJson(_ASEO_ESTADOS_OBJ).catch(() => _aseo.estados || {}); _aseo.estadosTs = Date.now(); }
      const yaVal = x => { const p = _aseoPub((_aseo.estados || {})[x.booking]); return !!p && _ASEO_ETAPAS.indexOf(p.estado) >= _ASEO_ETAPAS.indexOf(estado); };
      const todosYa = items.every(yaVal), algunoYa = items.some(yaVal);
      const pub = estado === "terminado" ? (validar ? "Sí (validado)" : todosYa ? "Sí (ya estaba validado)" : algunoYa ? `Solo ${items.filter(yaVal).map(x => x.code).join(", ")} (ya estaba validado); el resto queda pendiente de validar` : "No — queda pendiente de validar en el sistema") : "Sí";
      const fmtD = iso => { const d = new Date(iso + "T12:00:00"); return d.toLocaleDateString("es-MX", { day: "numeric", month: "short" }); };
      const resumen = ["🧽 Estado de aseo (por confirmar)",
        ...items.map(x => `• ${x.nombre} (${x.code})${x.huesped ? ` · salió ${x.huesped} (${fmtD(x.salida)})` : ""}`),
        `• Estado: ${_ASEO_EST_TXT[estado]}`,
        `• Publicar en guía: ${pub}`,
        `• ${estado === "inspeccionado" ? "Inspeccionó" : "Realizó"}: ${persona || "Sin asignar"}`,
        ...(errores.length ? [`⚠️ ${errores.join(" · ")}`] : []),
        ...(personaNota ? [`⚠️ ${personaNota}`] : []),
        "¿Confirmas? (sí / no / corrige lo que haga falta)"].join("\n");
      return { content: JSON.stringify({ ok: true, draft_id: id, resumen, instruccion: "Envía el campo resumen TAL CUAL y espera la respuesta. NO llames confirmar_estado_aseo hasta que conteste 'sí' en un mensaje nuevo. Si corrige algo (otro alojamiento, estado o persona), vuelve a llamar preparar_estado_aseo con todo corregido." }), notifyText: null };
    }
    if (name === "confirmar_estado_aseo") {
      if (!ctx.isAdmin && !ctx.isStaff) return { content: JSON.stringify({ ok: false, error: "Solo personal autorizado" }), notifyText: null };
      const d = _botAseoDrafts.get(ctx.phone10);
      if (!d) return { content: JSON.stringify({ ok: false, error: "No hay una actualización de aseo pendiente. Vuelve a prepararla." }), notifyText: null };
      if (Date.now() > d.exp) { _botAseoDrafts.delete(ctx.phone10); return { content: JSON.stringify({ ok: false, error: "El borrador venció (30 min). Vuelve a prepararlo." }), notifyText: null }; }
      if (!(ctx.msgTs > d.msgTs)) return { content: JSON.stringify({ ok: false, error: "Aún no hay confirmación. Muestra el resumen y espera su respuesta." }), notifyText: null };
      const user = `${d.persona || ctx.staffNombre || ctx.adminNombre || ctx.phone10} (WhatsApp)`;
      const rol = d.estado === "inspeccionado" ? "inspeccion" : "aseo";
      const hechos = [], pend = [];
      for (const x of d.items) {
        const reg = await _aseoGuardarEstado({ id: x.booking, hid: x.hid, estado: d.estado, validar: d.validar, user });
        if (d.persona) await _aseoAsignarRol(x.booking, rol, d.persona, user).catch(() => {});
        hechos.push(`${x.code}`);
        if (reg && reg.validado === false) pend.push(x.code); // mismo dato que muestran las cards
      }
      _botAseoDrafts.delete(ctx.phone10);
      const nota = !pend.length ? " (validado · publicado en la guía)" : pend.length === hechos.length ? " (pendiente de validar)" : ` (pendiente de validar: ${pend.join(", ")})`;
      return { content: JSON.stringify({ ok: true, guardados: hechos, estado: _ASEO_EST_TXT[d.estado], pendientes_de_validar: pend, persona: d.persona,
        instruccion: `Responde en 1 línea: ✅ ${hechos.join(", ")} → ${_ASEO_EST_TXT[d.estado]}${nota}${d.persona ? " · " + d.persona : ""}.` }), notifyText: null };
    }
    if (name === "preparar_recordatorio_pizarra") {
      if (!ctx.isAdmin) return { content: JSON.stringify({ ok: false, error: "Solo administradores" }), notifyText: null };
      const texto = String(args.texto || "").trim().slice(0, 500);
      if (!texto) return { content: JSON.stringify({ ok: false, error: "Falta el texto del recordatorio" }), notifyText: null };
      const hoy = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Mexico_City" });
      let fecha = String(args.fecha || "").trim() || hoy;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || isNaN(new Date(fecha + "T12:00:00"))) return { content: JSON.stringify({ ok: false, error: "Fecha inválida: usa YYYY-MM-DD" }), notifyText: null };
      if (fecha < hoy) fecha = hoy;
      const prioridad = ["critica", "alta", "media", "baja"].includes(args.prioridad) ? args.prioridad : "media";
      const [cat, nombres] = await Promise.all([_botTarCatalogo(), _botPersonalActivo().catch(() => [])]);
      const per = _botResolverPersonal(Array.isArray(args.personal) ? args.personal : (args.personal ? [String(args.personal)] : []), nombres);
      const clas = await _botTarClasificar(texto, cat);
      const id = "PD" + Date.now().toString(36);
      const yaConfirmo = _botEsSiAResumen(ctx, /recordatorio/i);
      const draft = { id, msgTs: yaConfirmo ? 0 : (ctx.msgTs || Date.now()), exp: Date.now() + 30 * 60 * 1000, texto: texto.charAt(0).toUpperCase() + texto.slice(1), prioridad, personal: per.ok, fecha, clasificacion: clas.clasificacion || "", subclasificacion: clas.subclasificacion || "" };
      _botPzDrafts.set(ctx.phone10, draft);
      if (yaConfirmo) {
        const rc = await _botExecTool({ name: "confirmar_recordatorio_pizarra", input: { draft_id: id } }, ctx);
        let jr = {}; try { jr = JSON.parse(rc.content || "{}"); } catch (_) {}
        return { content: JSON.stringify(Object.assign(jr, { instruccion: jr.ok ? "Recordatorio GUARDADO. Responde en 1 línea: ✅ Recordatorio guardado (folio X); aparece en Pendientes del día. No vuelvas a mostrar el resumen." : "No se pudo guardar: explica el error en 1 línea." })), notifyText: null };
      }
      return { content: JSON.stringify({ ok: true, draft_id: id, texto: draft.texto, clasificacion: draft.clasificacion || "Sin clasificación", subclasificacion: draft.subclasificacion || "—", urgencia: { critica: "Crítico", alta: "Alto", media: "Medio", baja: "Bajo" }[prioridad],
        personal_asignado: per.ok, no_encontrados: per.no, ambiguos: per.amb, fecha_iso: fecha, fecha_texto: fecha === hoy ? "Hoy" : _botFechaLarga(fecha),
        instruccion: yaConfirmo ? "El admin YA confirmó el resumen anterior con este mensaje: llama confirmar_recordatorio_pizarra ahora, sin volver a mostrar el resumen." : "Muestra el resumen al admin y pregunta si lo agrega. NO llames confirmar_recordatorio_pizarra hasta que responda en un mensaje nuevo." }), notifyText: null };
    }
    if (name === "confirmar_recordatorio_pizarra") {
      if (!ctx.isAdmin) return { content: JSON.stringify({ ok: false, error: "Solo administradores" }), notifyText: null };
      const d = _botPzDrafts.get(ctx.phone10);
      if (!d) return { content: JSON.stringify({ ok: false, error: "No hay un recordatorio pendiente de confirmar. Vuelve a prepararlo." }), notifyText: null };
      if (Date.now() > d.exp) { _botPzDrafts.delete(ctx.phone10); return { content: JSON.stringify({ ok: false, error: "El borrador venció (30 min). Vuelve a preparar el recordatorio." }), notifyText: null }; }
      if (!(ctx.msgTs > d.msgTs)) return { content: JSON.stringify({ ok: false, error: "Aún no hay confirmación del admin. Muestra el resumen y espera su respuesta." }), notifyText: null };
      // Los recordatorios son Tareas programadas con Tipo = "Recordatorio" (siempre "Único";
      // aparecen cada día desde su fecha hasta que se resuelven).
      const user = ctx.adminNombre || `Bot · ${ctx.phone10}`;
      const MES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
      const dd = new Date(d.fecha + "T12:00:00");
      const payload = {
        Tipo: "Recordatorio", Nombre: d.texto, Clasificacion: d.clasificacion || "", Subclasificacion: d.subclasificacion || "",
        Prioridad: { critica: "Crítico", alta: "Alto", media: "Medio", baja: "Bajo" }[d.prioridad] || "Medio", Naturaleza: "Único",
        Programacion: JSON.stringify({ tipo: "unica", fechas: [d.fecha], dias_semana: [], dias_mes: [], inicio: "", fin: "" }),
        Programacion_texto: `Recordatorio · desde ${dd.getDate()} ${MES[dd.getMonth()]} ${dd.getFullYear()}`,
        Personal: d.personal.join(", "), WhatsApp: "No", Mensaje: "", Template_ID: "", Estado: "Activa", Fecha_limite: "No",
        Comentarios: `Creado por WhatsApp (bot) · ${ctx.adminNombre || ctx.phone10}`, Creado_por: user, Origen: "Bot WhatsApp", Updated_at: new Date().toISOString(),
      };
      const r = await callCheckinAppsScriptPost("tareas_save", { payload });
      if (!r || !r.ok) return { content: JSON.stringify({ ok: false, error: (r && r.error) || "No se pudo guardar el recordatorio" }), notifyText: null };
      for (const k of Array.from(_rhListCache.keys())) if (k.startsWith("tareas_")) _rhListCache.delete(k);
      callCheckinAppsScriptPost("tareas_hist_add", { payload: { rows: [{ Tarea_ID: r.id, Fecha: "", Campo: "Creación", Antes: "", Despues: `${d.texto} (recordatorio vía bot WhatsApp)`, Usuario: ctx.adminNombre || ctx.phone10 }] } }).catch(() => {});
      _botPzDrafts.delete(ctx.phone10);
      return { content: JSON.stringify({ ok: true, id: r.id, texto: d.texto, prioridad: d.prioridad, personal: d.personal }), notifyText: null };
    }
    if (name === "confirmar_tarea_programada") {
      if (!ctx.isAdmin) return { content: JSON.stringify({ ok: false, error: "Solo administradores" }), notifyText: null };
      const d = _botTarDrafts.get(ctx.phone10);
      // Un solo borrador por admin: se usa el pendiente aunque el modelo no recuerde el draft_id.
      if (!d) return { content: JSON.stringify({ ok: false, error: "No hay una tarea pendiente de confirmar. Vuelve a preparar la tarea." }), notifyText: null };
      if (Date.now() > d.exp) { _botTarDrafts.delete(ctx.phone10); return { content: JSON.stringify({ ok: false, error: "El borrador venció (30 min). Vuelve a preparar la tarea." }), notifyText: null }; }
      // Candado: la confirmación debe venir en un mensaje POSTERIOR al del resumen.
      if (!(ctx.msgTs > d.msgTs)) return { content: JSON.stringify({ ok: false, error: "Aún no hay confirmación del admin. Muestra el resumen y espera su respuesta." }), notifyText: null };
      const MES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
      const dd = new Date(d.fecha + "T12:00:00");
      const prog = { tipo: "unica", fechas: [d.fecha], dias_semana: [], dias_mes: [], inicio: "", fin: "" };
      const payload = {
        Nombre: d.nombre, Clasificacion: d.clasificacion || "", Subclasificacion: d.subclasificacion || "",
        Prioridad: "Medio", Naturaleza: "Único",
        Programacion: JSON.stringify(prog), Programacion_texto: `Única · ${dd.getDate()} ${MES[dd.getMonth()]} ${dd.getFullYear()}`,
        Personal: d.personal.join(", "), WhatsApp: "No", Mensaje: "", Template_ID: "", Estado: "Activa",
        Comentarios: `Creada por WhatsApp (bot) · ${ctx.adminNombre || ctx.phone10}`,
        Creado_por: ctx.adminNombre || `Bot · ${ctx.phone10}`, Origen: "Bot WhatsApp", Fecha_limite: d.limite ? "Sí" : "No", Updated_at: new Date().toISOString(),
      };
      const r = await callCheckinAppsScriptPost("tareas_save", { payload });
      if (!r || !r.ok) return { content: JSON.stringify({ ok: false, error: (r && r.error) || "No se pudo guardar en Tareas" }), notifyText: null };
      _botTarDrafts.delete(ctx.phone10);
      for (const k of Array.from(_rhListCache.keys())) if (k.startsWith("tareas_")) _rhListCache.delete(k);
      callCheckinAppsScriptPost("tareas_hist_add", { payload: { rows: [{ Tarea_ID: r.id, Fecha: "", Campo: "Creación", Antes: "", Despues: `${d.nombre} (vía bot WhatsApp)`, Usuario: ctx.adminNombre || ctx.phone10 }] } }).catch(() => {});
      return { content: JSON.stringify({ ok: true, id: r.id, nombre: d.nombre, fecha_texto: _botFechaLarga(d.fecha), personal: d.personal }), notifyText: null };
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

// ═══ Control de Asistencia por WhatsApp ═══
// Map phone10 → { tipo: 'entrada'|'salida', ts: Date.now() }
// Se llena cuando el empleado manda "ya llegué" y expira en 10 min.
const _asistenciaPending = new Map();
const _ASIST_PENDING_TTL_MS = 10 * 60 * 1000;
// Cache de lookup empleado por celular (5 min) para no golpear el sheet
// en cada mensaje recibido de un mismo número.
const _asistenciaEmpCache = new Map();
const _ASIST_EMP_TTL_MS = 5 * 60 * 1000;

function _detectAsistenciaIntent(text) {
  const t = String(text || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").trim();
  // Regex tolerantes a typos comunes:
  //   "entrada" | "entranda" | "entardo" | "entardo" | "entrado" | "entradad"
  //   Cualquier palabra que empiece con "entra" y termine cerca del stem "da/do".
  //   Cubre: entrada, entranda, entar da, entrado, entrando.
  // "SALIR" del trabajo también debería contar como intent de salida — mismo criterio.
  const hasEntradaLike = /\bentra[a-z]{0,5}\b/.test(t);
  const hasSalidaLike  = /\bsali[a-z]{0,5}\b/.test(t);
  // Entrada
  if (/\b(ya\s+)?llegu[eé]\b/.test(t)) return "entrada";
  if (hasEntradaLike && !hasSalidaLike) return "entrada";
  if (/^(check[\s-]?in|checkin)$/.test(t)) return "entrada";
  // Salida
  if (/\b(ya\s+)?me\s+voy\b/.test(t)) return "salida";
  if (hasSalidaLike && !hasEntradaLike) return "salida";
  if (/^(check[\s-]?out|checkout)$/.test(t)) return "salida";
  if (/\btermin[eé]\b/.test(t)) return "salida";
  return null;
}

async function _asistenciaLookupEmpleado(phone10) {
  const cached = _asistenciaEmpCache.get(phone10);
  if (cached && (Date.now() - cached.ts) < _ASIST_EMP_TTL_MS) return cached.data;
  // Reintenta 1 vez si la respuesta es HTML (Apps Script hipos).
  async function _once() {
    const r = await fetch(`${CHECKIN_APPS_SCRIPT_URL}?action=asistencia_lookup_empleado&cel=${encodeURIComponent(phone10)}`, { redirect: 'follow' });
    return await r.text();
  }
  let txt = "";
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      txt = await _once();
      try {
        const j = JSON.parse(txt);
        _asistenciaEmpCache.set(phone10, { data: j, ts: Date.now() });
        return j;
      } catch(_) {
        if (txt.startsWith("<") && attempt === 0) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        // Segundo intento tampoco parseó — si tenemos cache EXPIRADA para este
        // teléfono, la usamos como fallback antes de dejar al empleado sin
        // respuesta. Evita el hueco "el bot no me respondió" cuando el
        // empleado ya está registrado y solo hubo un hipo de AS.
        if (cached && cached.data && cached.data.empleado) {
          console.warn("[asistencia] lookup HTML tras retry — uso cache expirada para " + phone10);
          return cached.data;
        }
        console.warn("[asistencia] lookup HTML tras retry, sin cache. phone=" + phone10);
        return {};
      }
    }
  } catch(e) {
    console.warn("[asistencia] lookup falló:", e.message);
    // Fallback: cache expirada si existe
    if (cached && cached.data) return cached.data;
    return null;
  }
  return {};
}

async function _asistenciaMarcarEnSheet(phone10, tipo, lat, lng, accuracy) {
  // Reintenta hasta 2 veces si la respuesta es HTML (Apps Script intermitente
  // devuelve la interstitial ppConfig). Cuando persiste el HTML tras el
  // retry, NO gritamos "falló" al empleado — asumimos que la escritura pudo
  // haber pasado y devolvemos { ok:true, degraded:true } para que el flujo
  // marque pending y no envíe el mensaje "⚠️ No pude registrar".
  async function _once() {
    const r = await fetch(CHECKIN_APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'asistencia_marcar',
        cel: phone10, tipo: tipo,
        lat: lat, lng: lng, accuracy: accuracy,
      }),
      redirect: 'follow',
    });
    return await r.text();
  }
  let txt = "";
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      txt = await _once();
      try { return JSON.parse(txt); } catch(_) {
        if (txt.startsWith("<") && attempt === 0) {
          // AS interstitial → reintenta tras 1s.
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        // Segundo intento también HTML — asumimos éxito degradado.
        console.warn("[asistencia] AS devolvió HTML tras retry — asumo éxito degradado. phone=" + phone10 + " tipo=" + tipo);
        return { ok:true, degraded:true, hora: new Date().toISOString().slice(11,16), empleado: "" };
      }
    }
  } catch(e) {
    console.warn("[asistencia] marcar falló:", e.message);
    return { ok:false, error: e.message };
  }
  return { ok:false, error: "no response" };
}


// ─── Detección admin por teléfono (cachea 5min) ────────────────────────────
const _bot_admin_cache = new Map(); // phone10 → { isAdmin, nombre, t }
async function _botIsAdminPhone(phone10) {
  const cached = _bot_admin_cache.get(phone10);
  if (cached && (Date.now() - cached.t) < 5 * 60_000) return cached;
  // Apps Script a veces responde una página HTML (error temporal / mientras se
  // publica una versión nueva). Reintentamos y, si sigue fallando, NO degradamos
  // a un admin conocido a "huésped": usamos su último estado conocido o, para los
  // números del dueño (ADMIN_NOTIFY_PHONE / VAULT_PHONE), lo tratamos como admin.
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const url = `${CHECKIN_APPS_SCRIPT_URL}?action=bot_is_admin_phone&phone10=${encodeURIComponent(phone10)}`;
      const r = await fetch(url);
      const j = await r.json();
      const rec = { isAdmin: !!j.isAdmin, nombre: String(j.nombre || ""), t: Date.now() };
      _bot_admin_cache.set(phone10, rec);
      return rec;
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
  }
  console.warn("[bot-admin] check fallo tras 3 intentos:", lastErr && lastErr.message);
  if (cached) return { ...cached, t: Date.now() - 4 * 60_000 }; // estado previo; reintenta en ~1 min
  const duenos = String(process.env.ADMIN_NOTIFY_PHONE || "") + ";" + String(process.env.VAULT_PHONE || "");
  const esDueno = duenos.split(/[;,]/).map(x => x.replace(/\D/g, "").slice(-10)).filter(Boolean).includes(phone10);
  return { isAdmin: esDueno, nombre: "", t: Date.now() };
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
    : BOT_TOOLS.filter(t => !_BOT_ADMIN_ONLY_TOOLS.has(t.name));
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
    // Solo reservas Lodgify con Status === 'Booked' — excluye Open, Tentative,
    // Declined, Cancelled, etc. Cualquier acción del bot (reportes, solicitudes,
    // tickets) debe basarse únicamente en reservas confirmadas.
    const lgBookingsRaw = (bkJ && bkJ.ok && Array.isArray(bkJ.bookings)) ? bkJ.bookings : [];
    const lgBookings = lgBookingsRaw.filter(b => String(b.Status || '').toLowerCase() === 'booked');
    if (lgBookingsRaw.length !== lgBookings.length) {
      const dropped = lgBookingsRaw.filter(b => String(b.Status || '').toLowerCase() !== 'booked')
        .map(b => `${b.Id}(${b.Status})`).join(', ');
      console.info(`[bot-in] ${phone10}: filtered ${lgBookingsRaw.length - lgBookings.length} non-Booked bookings: ${dropped}`);
    }
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
// Cache en memoria (5min) del sheet Emergency_Contacts — evita hit a
// Apps Script en cada request; se refresca cuando el POST reescribe.
let _BOT_EMERGENCY = { phones: [], contacts: [], ts: 0 };
async function _emergencyLoadFromSheet() {
  try {
    const url = `${CHECKIN_APPS_SCRIPT_URL}?action=emergency_contacts_list`;
    const r = await fetch(url, { redirect: "follow" });
    const j = await r.json();
    _BOT_EMERGENCY = {
      phones: (j && Array.isArray(j.phones)) ? j.phones : [],
      contacts: (j && Array.isArray(j.contacts)) ? j.contacts : [],
      ts: Date.now(),
    };
  } catch (e) { console.warn("[bot-emergency] load sheet fallo:", e.message); }
}
app.get("/wa/bot/emergency-phones", async (req, res) => {
  const stale = !_BOT_EMERGENCY.ts || (Date.now() - _BOT_EMERGENCY.ts) > 5*60*1000;
  if (stale) await _emergencyLoadFromSheet();
  res.json({ ok: true, phones: (_BOT_EMERGENCY.phones || []).slice(), contacts: (_BOT_EMERGENCY.contacts || []).slice() });
});
app.post("/wa/bot/emergency-phones", async (req, res) => {
  try {
    const b = req.body || {};
    const payload = {};
    if (Array.isArray(b.phones))   payload.phones = b.phones.map(p => String(p||'').trim()).filter(Boolean);
    if (Array.isArray(b.contacts)) payload.contacts = b.contacts;
    if (b.updated_by) payload.updated_by = String(b.updated_by);
    const r = await callCheckinAppsScriptPost("emergency_contacts_set", { payload });
    if (!r || !r.ok) throw new Error((r && r.error) || "Apps Script fallo");
    _BOT_EMERGENCY = { phones: r.phones || [], contacts: [], ts: 0 }; // invalida cache; próximo GET recarga contactos
    console.info(`[bot-emergency] phones=${JSON.stringify(_BOT_EMERGENCY.phones)}`);
    res.json({ ok: true, phones: _BOT_EMERGENCY.phones });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
/** Reenvía un texto a TODOS los números de la lista de emergencia. */
async function _botNotifyEmergency(text) {
  if (!_BOT_EMERGENCY.ts || (Date.now() - _BOT_EMERGENCY.ts) > 5*60*1000) await _emergencyLoadFromSheet();
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
  // ─── Ubicación adjunta (Twilio manda Latitude / Longitude cuando el      ───
  // ─── usuario comparte 📍). Si tenemos una marca pendiente, la aplicamos. ───
  const latRaw = b.Latitude != null ? String(b.Latitude).trim() : "";
  const lngRaw = b.Longitude != null ? String(b.Longitude).trim() : "";
  const hasLocation = latRaw && lngRaw && !isNaN(Number(latRaw)) && !isNaN(Number(lngRaw));
  if (hasLocation) {
    const pending = _asistenciaPending.get(phone10);
    if (pending && (Date.now() - pending.ts) < _ASIST_PENDING_TTL_MS) {
      _asistenciaPending.delete(phone10);
      const resp = await _asistenciaMarcarEnSheet(phone10, pending.tipo, latRaw, lngRaw, "");
      if (resp && resp.ok) {
        const emoji = pending.tipo === "entrada" ? "🕘" : "🕕";
        const verbo = pending.tipo === "entrada" ? "Entrada" : "Salida";
        const reply = `${emoji} ${verbo} registrada · ${resp.hora}\n📍 Ubicación guardada\nGracias, ${resp.empleado.split(" ")[0]}!`;
        await _twilioSendMessage({ to: fromRaw, body: reply, skipMirror: true }).catch(()=>{});
        // Registro de ENTRADA completo (con ubicación) → lista de limpiezas/inspecciones asignadas hoy.
        if (pending.tipo === "entrada") {
          try { await _aseoEnviarLista(String(resp.empleado || ""), fromRaw, phone10, "limpiezas_al_llegar"); }
          catch (e) { console.warn("[aseo] lista al registrar llegada:", e.message); }
        }
      }
      return;
    }
    // Ubicación llegó sin intent previo — la ignoramos silenciosamente
    // (podría ser una ubicación mandada por error). Bot huésped no maneja loc.
    return;
  }
  if (!bodyMsg) return;
  // ─── Control de asistencia: intent de entrada / salida ──────────────────
  const _asistIntent = _detectAsistenciaIntent(bodyMsg);
  if (_asistIntent) {
    const emp = await _asistenciaLookupEmpleado(phone10);
    if (emp && emp.ok && emp.empleado) {
      // Marca directamente sin ubicación (llegará luego, o no)
      const resp = await _asistenciaMarcarEnSheet(phone10, _asistIntent, "", "", "");
      if (resp && resp.ok) {
        _asistenciaPending.set(phone10, { tipo: _asistIntent, ts: Date.now() });
        const emoji = _asistIntent === "entrada" ? "🕘" : "🕕";
        const verbo = _asistIntent === "entrada" ? "Entrada" : "Salida";
        const nombre = String(resp.empleado || "").split(" ")[0];
        const reply = `${emoji} ${verbo} registrada · ${resp.hora}\n\n📍 Ahora comparte tu ubicación (obligatoria) — sin ella el registro queda incompleto.\n\nGracias, ${nombre}!`;
        await _twilioSendMessage({ to: fromRaw, body: reply, skipMirror: true }).catch(()=>{});

      } else {
        await _twilioSendMessage({ to: fromRaw, body: `⚠️ No pude registrar tu ${_asistIntent}. Contacta al admin.`, skipMirror: true }).catch(()=>{});
      }
      return;  // NO caemos al flujo huésped/admin
    }
    // Si el celular NO está en sys_users, seguimos al flujo normal (huésped)
  }

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
        const hoyLargo = new Date().toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        const dynSystem = BOT_SYSTEM_PROMPT_ADMIN + adminPromptsBlock + `\n\nCONTEXTO TEMPORAL:\n- HOY es: ${today} (${hoyLargo}, América/Mexico_City).\n- AÑO ACTUAL: ${nowYear}. Úsalo por defecto cuando no se mencione año.`;
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
          ctx: { phone10, fromRaw, booking: {}, alojRow: {}, isAdmin: true, msgTs: t0, adminNombre: adm.nombre || "", userMsg: cmd,
                 lastAssistant: ((adminHistory.filter(m => m.role === 'assistant').slice(-1)[0]) || {}).body || "" },
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
  // ─── PERSONAL (no admin): actualización del ESTADO DE ASEO por WhatsApp ───
  // "cu2 listo", "Jc1 terminado Alma", "ox1 inspeccionado"… Solo si el celular es
  // de un empleado (hoja Personal) y el mensaje habla de aseo o hay un borrador
  // pendiente de confirmar (para el "sí / no / corrección").
  {
    const _aseoKw = /\b(listo|lista|listos|listas|terminad\w*|termine|acabe|acabamos|limpi\w*|inspecci\w*|revisad\w*|checad\w*|supervisad\w*|en proceso|empezando|empece|validad\w*|aseo)\b/;
    const _aseoDraft = _botAseoDrafts.get(phone10);
    const _aseoPend = _aseoDraft && Date.now() < _aseoDraft.exp;
    if (!admCheck.isAdmin && (_aseoKw.test(_botNorm(bodyMsg)) || _aseoPend)) {
      const emp = await _asistenciaLookupEmpleado(phone10).catch(() => null);
      if (emp && emp.ok && emp.empleado) {
        const nombre = String(emp.empleado || "").trim();
        if (!bodyAlreadyPersisted) { await _botAppendMessage(phone10, "user", bodyMsg, { from: fromRaw, staff: true }); bodyAlreadyPersisted = true; }
        try {
          let hist = [];
          try {
            const cr = await _botFetchConversation(phone10, 20);
            hist = (cr.messages || []).filter(m => m && m.meta && m.meta.staff === true).slice(-8, -1)
              .map(m => ({ role: m.role === "user" ? "user" : "assistant", body: m.body }));
          } catch (_) {}
          const hoyL = new Date().toLocaleDateString("es-MX", { timeZone: "America/Mexico_City", weekday: "long", day: "numeric", month: "long", year: "numeric" });
          const sys = `Eres el asistente de operación de Check-inn Saltillo. Hablas con ${nombre}, miembro del PERSONAL (no es huésped). Hoy es ${hoyL}.
Tus funciones en este chat: registrar el ESTADO DE ASEO de los alojamientos y dar la lista de limpiezas de hoy.
- "resumen de limpieza", "limpiezas de hoy", "lista de limpiezas", "limpiezas hoy", "¿cómo va el aseo?" → llama consultar_limpiezas_hoy y responde con formatted_message TAL CUAL. "mis limpiezas", "qué me toca", "mis aseos/inspecciones" → solo_mias=true; "limpiezas de Alma" → persona="Alma". No expliques cómo filtra.
- Mensajes como "cu2 listo", "Jc1 terminado Alma", "ox1 inspeccionado", "Cumbres 2 terminado y validado", "bc7 empezando", "jose cardenas 3 y ox1 listos":
  · Llama preparar_estado_aseo con: alojamientos TAL CUAL los escribió (el sistema los reconoce aunque estén abreviados o con errores), estado (listo/lista/terminado/terminé/acabé = terminado · inspeccionado/revisado/checado = inspeccionado · empezando/limpiando/en proceso = en_proceso), validado=true SOLO si dice validado/publicado, y persona SOLO si nombra a alguien distinto de quien escribe (ej. "Alma").
  · Envía el campo resumen TAL CUAL y espera respuesta.
  · SOLO si contesta afirmativamente ("sí", "ok", "correcto", "dale") en un mensaje POSTERIOR, llama confirmar_estado_aseo y responde en 1 línea.
  · Si corrige algo ("no, es cu3", "fue Brenda", "nada más terminado"), vuelve a llamar preparar_estado_aseo con TODO corregido y muestra el nuevo resumen.
  · Si dice "no" / "cancela", responde "Cancelado." y no guardes.
- Si no reconoces el alojamiento, pide que lo escriba como CU2, JC1, OX3, BC7, MT4.
- Si el mensaje no es sobre aseo, responde en 1 línea que por este medio solo registras estados de aseo (ej. "cu2 listo") o das la lista de limpiezas de hoy.
- Sé breve, sin cortesías ni emojis extra.`;
          const ASEO_TOOLS = BOT_TOOLS.filter(t => ["preparar_estado_aseo", "confirmar_estado_aseo", "consultar_limpiezas_hoy"].includes(t.name));
          const llm = await _botLlmLoop({
            system: sys, history: hist, userMsg: bodyMsg,
            ctx: { phone10, fromRaw, booking: {}, alojRow: {}, isAdmin: false, isStaff: true, staffNombre: nombre, msgTs: t0, userMsg: bodyMsg,
                   lastAssistant: ((hist.filter(m => m.role === "assistant").slice(-1)[0]) || {}).body || "" },
            tools: ASEO_TOOLS,
          });
          const reply = String(llm.text || "").trim() || "OK.";
          await _twilioSendMessage({ to: fromRaw, body: reply, skipMirror: true });
          _botAppendMessage(phone10, "assistant", reply, { model: BOT_ANTHROPIC_MODEL, staff: true, tools: (llm.toolsUsed || []).map(t => t.name) });
          console.info(`[bot-staff] ${phone10} (${nombre}): reply en ${Date.now() - t0}ms · "${reply.slice(0, 80)}"`);
        } catch (e) {
          console.error("[bot-staff] error:", e.message);
          await _twilioSendMessage({ to: fromRaw, body: `No pude registrar el aseo (${e.message}). Intenta de nuevo.`, skipMirror: true }).catch(() => {});
        }
        return;
      }
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
      await _alojGetPayload();
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
// Cache in-memory de las listas RH — evita re-leer las hojas en cada
// entrada al módulo. TTL 45s, invalidación automática al guardar/borrar.
const _rhListCache = new Map(); // action → { ts, payload }
const RH_LIST_TTL_MS = 45_000;
function _rhListCacheInvalidate() { _rhListCache.clear(); }
// Write-through para RH_Asistencia: en vez de tirar la lista cacheada tras
// guardar/borrar (lo que obligaba a re-leer la hoja en Apps Script, ~5s),
// aplicamos el cambio a la copia en memoria. Las demás listas RH sí se
// invalidan. Si el cambio no se puede aplicar con certeza → invalidar todo.
function _rhAsistCachePatch(fn) {
  const cached = _rhListCache.get("rh_list_asistencia");
  const others = Array.from(_rhListCache.keys()).filter(k => k !== "rh_list_asistencia");
  others.forEach(k => _rhListCache.delete(k));
  if (!cached || !Array.isArray(cached.payload?.rows)) return;
  try { if (fn(cached.payload.rows) === false) _rhListCache.delete("rh_list_asistencia"); }
  catch (_) { _rhListCache.delete("rh_list_asistencia"); }
}
// Refrescos en vuelo por acción (evita disparar varias revalidaciones a la vez).
const _rhListRefreshing = new Set();
function _rhListRevalidate(action) {
  if (_rhListRefreshing.has(action)) return;
  _rhListRefreshing.add(action);
  callCheckinAppsScript(action)
    .then(r => { if (r && r.ok && !r._stale) _rhListCache.set(action, { ts: Date.now(), payload: r }); })
    .catch(() => {})
    .finally(() => _rhListRefreshing.delete(action));
}
// Stale-while-revalidate: algunas hojas RH (sobre todo RH_Asistencia, ~2 min en
// Apps Script) son lentísimas de leer. Para que el módulo NUNCA se quede
// "cargando": si ya hay copia en cache se devuelve AL INSTANTE, y si está
// vieja se revalida en segundo plano. Solo la PRIMERA carga (cache frío) espera
// la lectura completa. Las escrituras siguen parchando el cache (write-through),
// así que los cambios propios se reflejan de inmediato.
function rhMakeListEndpoint(action) {
  return async (req, res) => {
    try {
      const now = Date.now();
      const cached = _rhListCache.get(action);
      if (cached) {
        const fresh = (now - cached.ts) < RH_LIST_TTL_MS;
        if (!fresh) _rhListRevalidate(action); // refresca en background, no bloquea
        return res.json({ ...cached.payload, cached: true, stale: !fresh });
      }
      // Sin cache aún (primer arranque / instancia fría): lectura síncrona.
      const result = await callCheckinAppsScript(action);
      // Sin "rows" = Apps Script aún no conoce la acción (responde el doGet por defecto): no cachear.
      if (result && result.ok && Array.isArray(result.rows)) _rhListCache.set(action, { ts: now, payload: result });
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
      const mode = result && result.ok ? String(result.mode || "") : "";
      if (action === "rh_save_asistencia" && (mode === "update" || mode === "insert")) {
        _rhAsistCachePatch(rows => {
          const id = String(result.id || "");
          if (!id) return false;
          const vals = {};
          for (const k of Object.keys(payload)) vals[k] = payload[k] == null ? "" : String(payload[k]);
          vals.ID = id;
          const row = rows.find(r => String(r.ID || "") === id);
          if (row) Object.assign(row, vals);
          else if (mode === "insert") rows.push(vals);
          else return false;
        });
      } else if (action.startsWith("tareas_") || action.startsWith("procesos_")) {
        // Tareas / Procesos: solo invalida sus listas (no tirar RH_Asistencia, que es lenta).
        const pref = action.split("_")[0] + "_";
        for (const k of Array.from(_rhListCache.keys())) if (k.startsWith(pref)) _rhListCache.delete(k);
      } else {
        _rhListCacheInvalidate();
      }
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
// Pagos semanales de nómina (Método + Fecha + Comentarios por Empleado × Semana)
app.get("/rh/pagos-semanal", async (_req, res) => {
  try { res.json(await callCheckinAppsScript("rh_pago_semanal_list")); }
  catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});
app.post("/rh/pagos-semanal", async (req, res) => {
  try { res.json(await callCheckinAppsScriptPost("rh_pago_semanal_upsert", req.body || {})); }
  catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});
app.get("/rh/ausencias",      rhMakeListEndpoint("rh_list_ausencias"));
app.post("/rh/ausencias",     rhMakeSaveEndpoint("rh_save_ausencia"));
app.get("/rh/compensaciones", rhMakeListEndpoint("rh_list_compensaciones"));
app.post("/rh/compensaciones", rhMakeSaveEndpoint("rh_save_compensacion"));
function rhMakeDeleteEndpoint(action) {
  return async (req, res) => {
    try {
      const id = req.params.id;
      // Apps Script handler lee data.ID directamente (no data.payload.ID).
      // Pasamos también force/reason/actor para el soft-delete/protección WhatsApp.
      const force  = String(req.query.force || '').toLowerCase() === 'true';
      const reason = String(req.query.reason || '').slice(0, 300);
      const actor  = String(req.query.actor  || '').slice(0, 120);
      const result = await callCheckinAppsScriptPost(action, { ID: id, force, reason, actor });
      if (action === "tareas_delete" || action === "procesos_delete") {
        const pref = action.split("_")[0] + "_";
        for (const k of Array.from(_rhListCache.keys())) if (k.startsWith(pref)) _rhListCache.delete(k);
      } else if (action === "rh_delete_asistencia" && result && result.ok) {
        _rhAsistCachePatch(rows => {
          const i = rows.findIndex(r => String(r.ID || "") === String(id));
          if (i >= 0) rows.splice(i, 1);
        });
      } else {
        _rhListCacheInvalidate();
      }
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
    // skipMirror:false → el mensaje se guarda en WA_ChatContext (bitácora del
    // chat). Se usaba true antes; cambio a false para que las solicitudes
    // (programada, atendida) y mensajes reenviados aparezcan en el historial.
    await _twilioSendMessage({ to, body, skipMirror: false });
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
    // Si se pasa ProgramadaAt, se incluye — el handler Apps Script actualiza
    // la columna 11 solo si viene.
    if (req.body && req.body.ProgramadaAt) payload.ProgramadaAt = String(req.body.ProgramadaAt);
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
// ─── Programación de tareas recurrentes ───────────────────────────────────
app.get("/tareas",            rhMakeListEndpoint("tareas_list"));
app.post("/tareas",           rhMakeSaveEndpoint("tareas_save"));
app.delete("/tareas/:id",     rhMakeDeleteEndpoint("tareas_delete"));
app.get("/tareas/config",     rhMakeListEndpoint("tareas_config_list"));
app.post("/tareas/config",    rhMakeSaveEndpoint("tareas_config_save"));
app.get("/tareas/ocurrencias",  rhMakeListEndpoint("tareas_ocur_list"));
app.post("/tareas/ocurrencias", rhMakeSaveEndpoint("tareas_ocur_save"));
app.get("/tareas/historial",    rhMakeListEndpoint("tareas_hist_list"));
app.post("/tareas/historial",   rhMakeSaveEndpoint("tareas_hist_add"));
// ─── Documentación de procesos (Configuración admin) ──────────────────
app.get("/procesos",              rhMakeListEndpoint("procesos_list"));
app.post("/procesos",             rhMakeSaveEndpoint("procesos_save"));
app.delete("/procesos/:id",       rhMakeDeleteEndpoint("procesos_delete"));
app.get("/procesos/historial",    rhMakeListEndpoint("procesos_hist_list"));
app.post("/procesos/historial",   rhMakeSaveEndpoint("procesos_hist_add"));
app.post("/procesos/upload", async (req, res) => {
  try { res.json(await callCheckinAppsScriptPost("procesos_upload_file", req.body || {})); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.delete("/rh/ausencias/:id",      rhMakeDeleteEndpoint("rh_delete_ausencia"));

// Obligaciones (cuotas IMSS + recibos de nómina por empleado)
// Cache in-memory para /rh/obligaciones y /rh/obligacion/totales — el handler
// de Apps Script recorre el árbol de Drive (año/mes/tipo/empleado/archivo)
// haciendo una llamada por carpeta y archivo; puede tardar 3-8 min en frío.
// TTL 5 min: subsecuentes cargas del módulo son ~instantáneas.
const _rhObCache = new Map(); // key(year) → { ts, payload }
const _rhObInflight = new Map();
const RH_OB_TTL_MS = 5 * 60 * 1000;
function _rhObCacheInvalidate() { _rhObCache.clear(); _rhObInflight.clear(); }
async function _rhObFetch(action, cacheKey) {
  const now = Date.now();
  const cached = _rhObCache.get(cacheKey);
  if (cached && (now - cached.ts) < RH_OB_TTL_MS) {
    return { ...cached.payload, cached: true };
  }
  let inflight = _rhObInflight.get(cacheKey);
  if (!inflight) {
    inflight = (async () => {
      try {
        const [scriptAction, params] = action;
        const result = await callCheckinAppsScriptPost(scriptAction, params);
        if (result && result.ok) _rhObCache.set(cacheKey, { ts: Date.now(), payload: result });
        return result;
      } finally { _rhObInflight.delete(cacheKey); }
    })();
    _rhObInflight.set(cacheKey, inflight);
  }
  return inflight;
}

app.get("/rh/obligaciones", async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || (new Date()).getFullYear();
    const result = await _rhObFetch(["rh_list_obligaciones", { year }], `ob-${year}`);
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.get("/rh/obligacion/totales", async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || (new Date()).getFullYear();
    const result = await _rhObFetch(["rh_list_obligacion_totales", { year }], `tot-${year}`);
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/rh/obligacion/total", async (req, res) => {
  try {
    const b = req.body || {};
    const result = await callCheckinAppsScriptPost("rh_set_obligacion_total", {
      year: b.year, month: b.month, total: b.total,
    });
    _rhObCacheInvalidate();
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post("/rh/obligacion/delete", async (req, res) => {
  try {
    const fileId = String(req.body?.fileId || '').trim();
    if (!fileId) return res.status(400).json({ ok: false, error: 'Falta fileId' });
    const result = await callCheckinAppsScriptPost("rh_delete_obligacion", { fileId });
    _rhObCacheInvalidate();
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
    _rhObCacheInvalidate();
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post("/sys/login", async (req, res) => {
  try {
    const result = await callCheckinAppsScriptPost("sys_login", { payload: req.body || {} });
    if (result && result.ok && !(result.user && result.user.Nombre)) {
      return res.json({ ok: false, error: 'No se pudo verificar la contraseña. Intenta de nuevo.' });
    }
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

// Caché stale-while-revalidate para endpoints de una sola consulta: responde
// al instante con la última respuesta buena y refresca en segundo plano.
// Solo espera a Apps Script si nunca ha habido respuesta buena.
function _swrCache(fetcher, freshMs, staleMs) {
  const st = { ts: 0, payload: null, inflight: null };
  const refresh = () => {
    if (!st.inflight) {
      st.inflight = fetcher()
        .then(p => { if (p && p.ok !== false) { st.payload = p; st.ts = Date.now(); } return p; })
        .finally(() => { st.inflight = null; });
    }
    return st.inflight;
  };
  const get = async () => {
    const age = Date.now() - st.ts;
    if (st.payload && age < freshMs) return { ...st.payload, cached: true, cached_age_ms: age };
    if (st.payload && age < staleMs) {
      refresh().catch(() => {});
      return { ...st.payload, cached: true, stale: true, cached_age_ms: age };
    }
    return await refresh();
  };
  return { get, refresh };
}

const _huFilterOptionsCache = _swrCache(() => callCheckinAppsScript("list_filter_options"), 30 * 60_000, 7 * 24 * 60 * 60_000);
app.get("/huespedes-filter-options", async (req, res) => {
  try {
    res.json(await _huFilterOptionsCache.get());
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
        // Extrae confirmationCode/listingId/threadId del JSON que Lodgify manda
        // en b.source_text. Los campos snake_case (b.confirmation_code, etc.)
        // NO existen en la respuesta v2 — antes salían "" y por eso el sync
        // dejaba ConfirmationCode vacío en el sheet.
        SourceText: (() => {
          const raw = String(b.source_text || "");
          let meta = {};
          if (raw.startsWith("{")) { try { meta = JSON.parse(raw); } catch(_){} }
          return JSON.stringify({
            confirmationCode: meta.confirmationCode || meta.confirmation_code || "",
            listingId:        meta.listingId        || meta.listing_id        || "",
            threadId:         meta.threadId         || meta.thread_id         || "",
          });
        })(),
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
        // Lodgify v2 con OTA (Airbnb, Booking, Vrbo) a veces no manda
        // b.people. Fallback: usa room.people o suma adults+children+infants.
        NumberOfGuests: (function(){
          const p = Number(b.people) || 0;
          if (p > 0) return p;
          const rp = Number(room.people) || 0;
          if (rp > 0) return rp;
          const a = Number(b.adults) || Number(room.adults) || 0;
          const c = Number(b.children) || Number(room.children) || 0;
          const i = Number(b.infants) || Number(room.infants) || 0;
          return a + c + i;
        })(),
        Adults: Number(room.adults) || Number(b.adults) || Number(room.people) || Number(b.people) || 0,
        Children: Number(room.children) || Number(b.children) || 0,
        Infants: Number(room.infants) || Number(b.infants) || 0,
        Pets: Number(b.pets) || 0,
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

// Cache SWR + persistencia a disco para /lodgify-list.
// Igual pattern que /huespedes-list — sobrevive reinicios de instancia.
const _lodgifyListRangeCache = new Map();
const _lodgifyListInflight = new Map();
const LG_LIST_TTL_MS = 15 * 60_000;
const LG_LIST_MAX_STALE_MS = 30 * 24 * 60 * 60_000;
const LG_CACHE_DIR = '/tmp/lg_cache';
try { fs.mkdirSync(LG_CACHE_DIR, { recursive: true }); } catch(_){}
function _lgCachePath(key) {
  const safe = require('crypto').createHash('md5').update(key).digest('hex');
  return path.join(LG_CACHE_DIR, safe + '.json');
}
function _lodgifyListCacheSet(key, payload) {
  _lodgifyListRangeCache.set(key, { ts: Date.now(), payload });
  setImmediate(() => {
    try { fs.writeFileSync(_lgCachePath(key), JSON.stringify({ key, ts: Date.now(), payload })); } catch(_){}
  });
}
function _lodgifyLoadCacheFromDisk() {
  try {
    const files = fs.readdirSync(LG_CACHE_DIR);
    let loaded = 0;
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(LG_CACHE_DIR, f), 'utf8');
        const obj = JSON.parse(raw);
        if (obj && obj.key && obj.ts && obj.payload) {
          _lodgifyListRangeCache.set(obj.key, { ts: obj.ts, payload: obj.payload });
          loaded++;
        }
      } catch(_){}
    }
    if (loaded > 0) console.log(`[lodgify-cache] cargados ${loaded} entradas desde disco`);
  } catch(_){}
}
_lodgifyLoadCacheFromDisk();

function _lgFilterRange(bookings, from, to) {
  if (!from && !to) return bookings;
  const fromTs = from ? new Date(from + 'T00:00:00').getTime() : -Infinity;
  const toTs   = to   ? new Date(to   + 'T23:59:59').getTime() :  Infinity;
  const _p = (s) => {
    if (!s) return 0;
    const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return new Date(+m[3], +m[1]-1, +m[2]).getTime();
    const t = Date.parse(s);
    return isFinite(t) ? t : 0;
  };
  return bookings.filter(b => {
    const arr = _p(b.DateArrival);
    const dep = _p(b.DateDeparture);
    if (!arr && !dep) return false;
    return (dep || arr) >= fromTs && (arr || dep) <= toTs;
  });
}

async function _lodgifyFetchAndCache(key, params) {
  const payload = await callCheckinAppsScript("lodgify_list", params);
  if (payload && payload.ok && Array.isArray(payload.bookings)) {
    payload.bookings.forEach(b => { if (b) b.Source = _normalizeBookingSource(b); });
    const from = params.from || params.from_iso || '';
    const to   = params.to   || params.to_iso   || '';
    if (from || to) {
      payload.bookings = _lgFilterRange(payload.bookings, from, to);
      payload.total = payload.bookings.length;
    }
    _lodgifyListCacheSet(key, payload);
  }
  return payload;
}

// ── Snapshot único de reservas: hoy−LG_SNAP_BACK_DAYS → futuro ─────────────
// Apps Script tarda 35-60 s en CADA lectura (lee la hoja completa). Por eso
// ninguna petición de usuario debe esperarlo: el servidor mantiene UNA copia
// refrescada en segundo plano y cualquier rango dentro de la ventana se
// responde filtrando en memoria. La instancia no acepta tráfico hasta tener
// la copia (ver arranque al final del archivo).
// 25 meses: Gestión de reservas pide 2 meses atrás y el Dashboard 24 meses.
const LG_SNAP_BACK_DAYS = 760;
const LG_SNAP_TO = '2099-12-31';
const LG_SNAP_REFRESH_MS = 10 * 60_000;
const LG_SNAP_FILE = path.join(LG_CACHE_DIR, 'snapshot_v2.json');
const _lgSnap = { ts: 0, from: '', payload: null, inflight: null, lastMs: 0, lastErr: '', lastReason: '' };

function _lgSnapFromIso() {
  return new Date(Date.now() - LG_SNAP_BACK_DAYS * 86400000).toISOString().slice(0, 10);
}

function _lgSnapLoadFromDisk() {
  try {
    const obj = JSON.parse(fs.readFileSync(LG_SNAP_FILE, 'utf8'));
    if (obj && obj.payload && Array.isArray(obj.payload.bookings)) {
      Object.assign(_lgSnap, { ts: obj.ts, from: obj.from, payload: obj.payload });
      console.log(`[lg-snap] cargado de disco: ${obj.payload.bookings.length} bookings`);
    }
  } catch (_) {}
}

function _lgSnapRefresh(reason) {
  if (_lgSnap.inflight) return _lgSnap.inflight;
  const from = _lgSnapFromIso();
  const t0 = Date.now();
  _lgSnap.inflight = (async () => {
    try {
      const payload = await callCheckinAppsScript("lodgify_list", { from, to: LG_SNAP_TO, from_iso: from, to_iso: LG_SNAP_TO });
      if (!payload || !payload.ok || !Array.isArray(payload.bookings)) {
        throw new Error((payload && payload.error) || 'respuesta inválida de Apps Script');
      }
      // Fallback viejo del helper de Apps Script: no pisar una copia más nueva.
      if (payload.cached_stale && _lgSnap.payload) throw new Error('Apps Script falló; se conserva la copia actual');
      payload.bookings.forEach(b => { if (b) b.Source = _normalizeBookingSource(b); });
      payload.bookings = _lgFilterRange(payload.bookings, from, LG_SNAP_TO);
      try { _lgDetectExtensiones(_lgSnap.payload, payload); } catch (e) { console.warn('[lg-ext] detección falló:', e.message); }
      Object.assign(_lgSnap, { payload, ts: Date.now(), from, lastMs: Date.now() - t0, lastErr: '', lastReason: reason });
      console.log(`[lg-snap] ${reason}: ${payload.bookings.length} bookings en ${_lgSnap.lastMs}ms`);
      setImmediate(() => {
        try { fs.writeFileSync(LG_SNAP_FILE, JSON.stringify({ ts: _lgSnap.ts, from, payload })); } catch (_) {}
      });
    } catch (e) {
      _lgSnap.lastErr = e.message;
      console.warn(`[lg-snap] ${reason} falló en ${Date.now() - t0}ms: ${e.message}`);
    } finally {
      _lgSnap.inflight = null;
    }
  })();
  return _lgSnap.inflight;
}

// ─── Extensiones de reservas ────────────────────────────────────────────
// Lodgify sobrescribe DateDeparture/TotalAmount en cada sync (no hay
// historial). Al refrescar el snapshot comparamos contra la copia anterior:
// si la salida de una reserva activa se movió a una fecha POSTERIOR, se
// registra la extensión en la hoja Reservas_Extensiones (vía Apps Script).
function _lgIso(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  return '';
}
const _lgExt = { rows: null, ts: 0, inflight: null };
function _lgDetectExtensiones(oldPayload, newPayload) {
  if (!oldPayload || !Array.isArray(oldPayload.bookings)) return;
  const prev = new Map();
  oldPayload.bookings.forEach(b => { if (b && b.Id) prev.set(String(b.Id), b); });
  const nuevas = [];
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  for (const b of newPayload.bookings || []) {
    if (!b || !b.Id || !/^(booked|tentative)$/i.test(String(b.Status || ''))) continue;
    const o = prev.get(String(b.Id)); if (!o) continue;
    const dOld = _lgIso(o.DateDeparture), dNew = _lgIso(b.DateDeparture);
    if (!dOld || !dNew || dNew <= dOld) continue;
    if (_lgIso(o.DateArrival) !== _lgIso(b.DateArrival)) continue; // cambio de llegada = re-programación, no extensión
    const tot = x => Number(x.TotalAmount) || Number(x.GrossTotal) || 0;
    nuevas.push({ Lodgify_Id: String(b.Id), Huesped: b.GuestName || '', Fuente: b.Source || '',
      Salida_anterior: dOld, Salida_nueva: dNew, Total_anterior: tot(o), Total_nuevo: tot(b), Detectado: now });
  }
  if (!nuevas.length) return;
  console.log(`[lg-ext] ${nuevas.length} extensión(es) detectada(s): ${nuevas.map(x => x.Lodgify_Id).join(', ')}`);
  if (Array.isArray(_lgExt.rows)) nuevas.forEach(x => _lgExt.rows.push({ ...x, ID: 'tmp' }));
  callCheckinAppsScriptPost('reservas_ext_add', { payload: { rows: nuevas } })
    .then(r => { if (!r || !r.ok) console.warn('[lg-ext] no se guardó:', r && r.error); })
    .catch(e => console.warn('[lg-ext] no se guardó:', e.message));
}
async function _lgExtLoad(force) {
  if (_lgExt.inflight) return _lgExt.inflight;
  if (_lgExt.rows && !force && Date.now() - _lgExt.ts < 10 * 60_000) return _lgExt.rows;
  _lgExt.inflight = (async () => {
    try {
      const r = await callCheckinAppsScript('reservas_ext_list');
      if (r && r.ok && Array.isArray(r.rows)) { _lgExt.rows = r.rows; _lgExt.ts = Date.now(); }
      else if (!_lgExt.rows) _lgExt.rows = [];
    } catch (e) { if (!_lgExt.rows) _lgExt.rows = []; }
    return _lgExt.rows;
  })().finally(() => { _lgExt.inflight = null; });
  return _lgExt.inflight;
}
app.get("/lodgify-extensiones", async (_req, res) => {
  try {
    if (_lgExt.rows) { res.json({ ok: true, rows: _lgExt.rows }); if (Date.now() - _lgExt.ts > 10 * 60_000) _lgExtLoad(true).catch(() => {}); return; }
    const rows = await _lgExtLoad();
    res.json({ ok: true, rows: rows || [] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

_lgSnapLoadFromDisk();
setInterval(() => {
  if (Date.now() - _lgSnap.ts >= LG_SNAP_REFRESH_MS - 60_000) _lgSnapRefresh('intervalo');
}, 60_000);

app.get("/lodgify-snapshot-status", (_req, res) => {
  res.json({
    ok: true,
    loaded: !!_lgSnap.payload,
    bookings: _lgSnap.payload ? _lgSnap.payload.bookings.length : 0,
    window_from: _lgSnap.from,
    age_ms: _lgSnap.ts ? Date.now() - _lgSnap.ts : null,
    last_refresh_ms: _lgSnap.lastMs,
    last_reason: _lgSnap.lastReason,
    last_error: _lgSnap.lastErr,
    refreshing: !!_lgSnap.inflight,
  });
});

app.get("/lodgify-list", async (req, res) => {
  try {
    const t0 = Date.now();
    const from = String(req.query.from || "").slice(0,10);
    const to   = String(req.query.to   || "").slice(0,10);
    const source = req.query.source || "";
    const status = req.query.status || "";
    const name_contains = req.query.name_contains || "";
    const limit = req.query.limit || "";
    const key = `${from}|${to}|${source}|${status}|${name_contains}|${limit}`;
    const now = Date.now();

    // Rango dentro de la ventana del snapshot → filtro en memoria (ms).
    const plain = !source && !status && !name_contains && !limit;
    if (plain && from) {
      if (!_lgSnap.payload) await _lgSnapRefresh('primera-peticion');
      if (_lgSnap.payload && from >= _lgSnap.from) {
        let bookings = _lgFilterRange(_lgSnap.payload.bookings, from, to);
        // view=dash: Dashboard (24 meses) — solo Booked/Tentative y los campos
        // que usa. Baja de ~12.8 MB a una fracción.
        if (String(req.query.view || "") === "dash") {
          const F = ["Id","Status","Source","DateArrival","DateDeparture","DateCancelled","HouseId","HouseName",
                     "TotalAmount","GrossTotal","Gross","NetTotal","Net","VatTotal","Vat","Currency",
                     "NumberOfGuests","GuestName","GuestPhone","Nights","last_synced_at"];
          bookings = bookings
            .filter(b => /^(booked|tentative)$/i.test(String(b.Status || "")))
            .map(b => { const o = {}; for (const k of F) if (b[k] !== undefined && b[k] !== "") o[k] = b[k]; return o; });
        }
        res.set('Server-Timing', `snapshot;dur=${Date.now() - t0}`);
        return res.json({
          ..._lgSnap.payload,
          bookings,
          total: bookings.length,
          cached: true,
          snapshot: true,
          cached_age_ms: now - _lgSnap.ts,
        });
      }
    }

    const cached = _lodgifyListRangeCache.get(key);
    const params = { source, status, name_contains, limit, from, to, from_iso: from, to_iso: to };

    // Cache fresh → servir instantáneo.
    if (cached && (now - cached.ts) < LG_LIST_TTL_MS) {
      return res.json({ ...cached.payload, cached: true, cached_age_ms: now - cached.ts });
    }

    // Cache stale pero utilizable → servir y refrescar en background.
    if (cached && (now - cached.ts) < LG_LIST_MAX_STALE_MS) {
      res.json({ ...cached.payload, cached: true, stale: true, cached_age_ms: now - cached.ts });
      // Refetch en background si no hay otro ya corriendo.
      if (!_lodgifyListInflight.get(key)) {
        const p = _lodgifyFetchAndCache(key, params).catch(e => console.warn('[lodgify-list bg refresh]', e.message))
          .finally(() => _lodgifyListInflight.delete(key));
        _lodgifyListInflight.set(key, p);
      }
      return;
    }

    // Sin cache útil → coalesce y esperar el fetch fresco.
    let inflight = _lodgifyListInflight.get(key);
    if (!inflight) {
      inflight = _lodgifyFetchAndCache(key, params).finally(() => _lodgifyListInflight.delete(key));
      _lodgifyListInflight.set(key, inflight);
    }
    const payload = await inflight;
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
// Los KPIs se recalculan una vez al día (perfiles-kpis-daily), así que una
// copia de hasta 24 h es válida mientras se refresca en segundo plano.
const _perfilesKpisCache = _swrCache(async () => {
  const j = await callCheckinAppsScript("perfiles_kpis");
  if (!j || !j.ok) throw new Error((j && j.error) || "perfiles_kpis falló");
  return { ok: true, by_phone: j.by_phone || {}, total: j.total || 0 };
}, 5 * 60_000, 24 * 60 * 60_000);
app.get("/perfiles-kpis-list", async (req, res) => {
  try {
    res.json(await _perfilesKpisCache.get());
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /perfiles-list
// Lee SOLO Perfiles + Vehículos (2 scans) y devuelve la lista completa de
// personas lista para renderizar en el módulo Huéspedes/Inquilinos.
// NO joins con Reservaciones. Típicamente <3s en frío, <100ms cacheada.
// Cache 5 min.
// ═══════════════════════════════════════════════════════════════════════════
const _perfilesListCache = { ts: 0, payload: null };
const _PERFILES_LIST_TTL_MS = 5 * 60_000;
function _perfilesListCacheInvalidate() { _perfilesListCache.ts = 0; _perfilesListCache.payload = null; }
app.get("/perfiles-list", async (req, res) => {
  try {
    const now = Date.now();
    if (_perfilesListCache.payload && (now - _perfilesListCache.ts) < _PERFILES_LIST_TTL_MS) {
      return res.json({ ok: true, cached: true, ..._perfilesListCache.payload });
    }
    const result = await callCheckinAppsScript("perfiles_list_full");
    if (!result || !result.ok) {
      return res.status(500).json({ ok: false, error: result?.error || 'perfiles_list_full falló' });
    }
    const payload = { personas: result.personas || [], total: result.total || 0, elapsed_ms: result.elapsed_ms || null };
    // Solo cachear cuando hay datos reales (evita persistir respuestas vacías
    // del Apps Script pre-redeploy que se quedaban cacheadas 5min).
    if (payload.total > 0) {
      _perfilesListCache.ts = now;
      _perfilesListCache.payload = payload;
    }
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

// ─── Perfil (por teléfono) — usado por Chats bot → editar perfil ──────────
app.get("/perfil/by-phone", async (req, res) => {
  try {
    const phone = String(req.query.phone || "").replace(/\D/g,"").slice(-10);
    if (phone.length < 10) return res.status(400).json({ ok:false, error:"phone (10 dígitos) requerido" });
    const r = await callCheckinAppsScriptPost("perfil_get_by_phone", { phone });
    res.json(r);
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});
app.post("/perfil/upsert", async (req, res) => {
  try {
    const payload = (req.body && req.body.payload) || req.body || {};
    const r = await callCheckinAppsScriptPost("perfil_upsert_by_phone", { payload });
    res.json(r);
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ─── Llaves — notas libres por propiedad ─────────────────────────────────
app.get("/llaves/notas", async (req, res) => {
  try {
    const url = `${CHECKIN_APPS_SCRIPT_URL}?action=llaves_notas_list`;
    const r = await fetch(url, { redirect: "follow" });
    const j = await r.json();
    res.json(j);
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});
app.post("/llaves/notas", async (req, res) => {
  try {
    const payload = (req.body && req.body.payload) || req.body || {};
    const r = await callCheckinAppsScriptPost("llaves_notas_set", { payload });
    res.json(r);
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
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
    // Un sync de Lodgify propaga filas nuevas/actualizadas a Reservaciones.
    // El scheduler lo llama cada pocos minutos: NO borramos cachés (eso
    // obligaba al siguiente usuario a esperar 40 s+ a Apps Script). Solo si
    // hubo cambios, refrescamos en segundo plano sirviendo lo anterior.
    const changed = !(json && json.ok
      && Number(json.updated || 0) === 0 && Number(json.inserted || 0) === 0
      && (json.updated != null || json.inserted != null));
    if (changed) {
      _huespedesCacheRefreshInBackground('post-sync');
      _lgSnapRefresh('post-sync');
    }
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
    _huespedesCacheInvalidate();
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
    _huespedesCacheInvalidate();
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
    _bancosMarkDirty();
    res.json({ ok: true, rowNum, columnsWritten: result.columnsWritten, archivado: result.archivado });
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
    _bancosMarkDirty();
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
    _bancosMarkDirty();
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
    _bancosMarkDirty();
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

// GET /facturapi/ticket-url?folio=X[&org=2] — devuelve self_invoice_url de un
// receipt de Facturapi. Usado por el popup Auto-facturación de la guía para
// abrir el ticket al hacer click en el chip "Ver Ticket · Folio #X".
app.get("/facturapi/ticket-url", async (req, res) => {
  try {
    const folio = String(req.query.folio || '').trim();
    const orgN = String(req.query.org || '2');
    if (!folio) throw new Error('folio requerido');
    const key = orgN === '1'
      ? (process.env.FACTURAPI_SECRET_KEY_ORG1 || process.env.FACTURAPI_SECRET_KEY)
      : (process.env.FACTURAPI_SECRET_KEY_ORG2 || process.env.FACTURAPI_SECRET_KEY);
    if (!key) throw new Error('FACTURAPI_SECRET_KEY no configurada');
    const auth = 'Basic ' + Buffer.from(key + ':').toString('base64');
    // Busca primero en receipts, luego en invoices como fallback
    async function searchAt(collection) {
      const r = await fetch(`https://www.facturapi.io/v2/${collection}?folio_number=${encodeURIComponent(folio)}&limit=1`, {
        headers: { 'Authorization': auth }
      });
      if (!r.ok) return null;
      const j = await r.json();
      return (j?.data || [])[0] || null;
    }
    let hit = await searchAt('receipts');
    let kind = 'receipt';
    if (!hit) { hit = await searchAt('invoices'); kind = 'invoice'; }
    if (!hit) return res.status(404).json({ ok:false, error:`Folio ${folio} no encontrado` });
    const url = String(hit.self_invoice_url || hit.verification_url || hit.url || '');
    res.json({ ok:true, folio, id: hit.id, kind, url });
  } catch (err) {
    console.error("facturapi_ticket_url_error", err.message);
    res.status(500).json({ ok:false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ║  POST /facturapi/emit-auto — Emisión automática one-click (Pieza A)     ║
// ║  Body: { reservaId, phone, correo, monto, currency, propiedad, arrival, ║
// ║         departure, razon?, rfc?, regimen?, cp?, org? }                   ║
// ║  Flujo: crea receipt en Facturapi → actualiza folio en Reservaciones →  ║
// ║         envía email → envía WhatsApp con el link para auto-facturar.    ║
// ║  Devuelve: { ok, folio, url, id, mail_sent, wa_sent }                    ║
// ═══════════════════════════════════════════════════════════════════════════
app.post("/facturapi/emit-auto", async (req, res) => {
  try {
    const b = req.body || {};
    const reservaId = String(b.reservaId || '').trim();
    const phone = String(b.phone || '').replace(/\D/g,'').slice(-10);
    const correo = String(b.correo || '').trim();
    const correoCopia = String(b.correo_copia || '').trim();
    const monto = Number(b.monto || 0);
    const currency = String(b.currency || 'MXN').toUpperCase();
    const propiedad = String(b.propiedad || '').trim();
    const arrival = String(b.arrival || '').trim();
    const departure = String(b.departure || '').trim();
    if (!reservaId) throw new Error('reservaId requerido');
    if (!monto || monto <= 0) throw new Error('monto inválido');
    if (!correo) throw new Error('correo requerido');
    const orgN = String(b.org || '2');
    const key = orgN === '1'
      ? (process.env.FACTURAPI_SECRET_KEY_ORG1 || process.env.FACTURAPI_SECRET_KEY)
      : (process.env.FACTURAPI_SECRET_KEY_ORG2 || process.env.FACTURAPI_SECRET_KEY);
    if (!key) throw new Error('FACTURAPI_SECRET_KEY no configurada en Cloud Run');
    const auth = 'Basic ' + Buffer.from(key + ':').toString('base64');
    // 1) Emitir receipt (ticket de auto-facturación)
    const description = `Hospedaje ${propiedad || 'Check-inn Saltillo'}${arrival && departure ? ` · ${arrival} → ${departure}` : ''} · Reserva ${reservaId}`;
    const receiptBody = {
      items: [{
        quantity: 1,
        product: {
          description: description.slice(0, 250),
          product_key: '90121500', // Servicio de hospedaje
          price: Number(monto.toFixed(2)),
          tax_included: true,
          taxes: [{ type: 'IVA', rate: 0.16 }],
        },
      }],
      payment_form: '03', // transferencia electrónica
      currency,
    };
    const rResp = await fetch('https://www.facturapi.io/v2/receipts', {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(receiptBody),
    });
    const rText = await rResp.text();
    if (!rResp.ok) throw new Error(`Facturapi receipt ${rResp.status}: ${rText.slice(0,300)}`);
    const receipt = JSON.parse(rText);
    const folio = String(receipt.folio_number || '');
    const receiptId = String(receipt.id || '');
    const receiptUrl = String(receipt.self_invoice_url || receipt.url || '');
    // ⚡ OPTIMIZACIÓN: responde INMEDIATAMENTE con folio+url para que el
    // usuario no espere los 60-120s que tardan Apps Script + Drive.
    // Los pasos 2 (folio en sheet), 2b (PDF a Drive), 3 (email), 4 (WA)
    // se disparan en background — el usuario ya tiene su ticket confirmado.
    if (!res.headersSent) {
      res.json({
        ok: true, folio, id: receiptId, url: receiptUrl,
        sheet_updated: false, pdf_saved: false,
        ticket_url_drive: "", pdf_error: "",
        mail_sent: false, wa_sent: false,
        _async: true, // indicador para el frontend: el resto va en background
      });
    }
    // 2) Actualizar folio + montos en Reservaciones (Apps Script action)
    // Cálculo de montos: si el frontend pasó isAirbnb + totales, los usamos.
    // Si no, derivamos: base=monto (ya facturado), monto_antes=monto/1.16.
    const isAirbnb = !!b.isAirbnb;
    const totalReserva = Number(b.totalReserva || monto);
    const totalAirbnb    = isAirbnb ? Number(b.totalAirbnb || totalReserva) : "";
    const comisionAirbnb = isAirbnb ? Number(b.comisionAirbnb || +(totalReserva * 0.155).toFixed(2)) : "";
    const totalPagado    = Number(b.totalPagado || (isAirbnb ? totalReserva : monto));
    const montoFacturado = Number(b.montoFacturado || monto);
    const montoAntes     = +(montoFacturado / 1.16).toFixed(2);
    let sheetUpdated = false;
    let sheetRowNumber = "";
    let sheetRaw = "";
    try {
      const upd = await fetch(CHECKIN_APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          action: 'reservacion_set_folio_by_lodgify_id',
          lodgify_id: reservaId,
          folio: folio,
          total_airbnb: totalAirbnb,
          comision_airbnb: comisionAirbnb,
          monto_antes: montoAntes,
          total_pagado: totalPagado,
          monto_facturado: montoFacturado,
          medio_emision: 'auto-facturación',
        }),
        redirect: 'follow',
      });
      sheetRaw = await upd.text();
      let uj = {};
      try { uj = JSON.parse(sheetRaw); } catch(_) {}
      sheetUpdated = !!(uj && uj.ok);
      sheetRowNumber = (uj && (uj.row_number || uj.row)) || "";
      console.log('[emit-auto] set_folio resp:', sheetRaw.slice(0,300));
    } catch (e) { console.warn('[emit-auto] sheet update falló:', e.message); }
    // 2b) Descargar PDF de Facturapi y guardarlo en Drive vía Apps Script.
    // Rellena Ticket facturapi url/id archivo/nombre/carpeta url/carpeta ruta.
    let pdfSaved = false;
    let ticketUrlDrive = "";
    let pdfError = "";
    try {
      const pdfResp = await fetch(`https://www.facturapi.io/v2/receipts/${receiptId}/pdf`, {
        method: 'GET',
        headers: { 'Authorization': auth, 'Accept': 'application/pdf' },
        redirect: 'follow',
      });
      if (pdfResp.ok) {
        const buf = Buffer.from(await pdfResp.arrayBuffer());
        const base64 = buf.toString('base64');
        const savePayload = {
          action: 'save_facturapi_pdf',
          lodgify_id: reservaId, // handler resuelve la fila por 'Lodgify Id'
          receipt_id: receiptId,
          folio_facturapi: folio,
          file: {
            fileName: `ticket-${folio || receiptId}.pdf`,
            mimeType: 'application/pdf',
            base64,
          },
        };
        if (sheetRowNumber) savePayload.row_number = sheetRowNumber;
        const saveResp = await fetch(CHECKIN_APPS_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(savePayload),
          redirect: 'follow',
          signal: AbortSignal.timeout(90000),
        });
        const txt = await saveResp.text();
        let sj = {};
        try { sj = JSON.parse(txt); } catch(_) { sj = { ok:false, error:'non-JSON: ' + txt.slice(0,200) }; }
        pdfSaved = !!(sj && sj.ok);
        ticketUrlDrive = String((sj && sj.ticket_facturapi_url) || "");
        if (!pdfSaved) pdfError = 'save: ' + (sj.error || sj.message || 'unknown');
        console.log('[emit-auto] save_facturapi_pdf resp:', txt.slice(0,300));
      } else {
        pdfError = `fapi pdf HTTP ${pdfResp.status}`;
      }
    } catch (e) { pdfError = 'exc: ' + e.message; }
    // 3) Enviar email vía Facturapi
    let mailSent = false;
    try {
      const emailList = [correo];
      if (correoCopia) emailList.push(correoCopia);
      const eResp = await fetch(`https://www.facturapi.io/v2/receipts/${receiptId}/email`, {
        method: 'POST',
        headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailList }),
      });
      mailSent = eResp.ok;
    } catch(e) { console.warn('[emit-auto] email falló:', e.message); }
    // 4) Enviar WhatsApp con el link
    let waSent = false;
    if (phone && receiptUrl) {
      try {
        const waBody = `📄 Tu ticket de auto-facturación de Check-inn Saltillo:\n\nFolio: ${folio}\nMonto: $${monto.toFixed(2)} ${currency}\n\nCompleta tu factura aquí:\n${receiptUrl}\n\nTambién te lo enviamos por correo a ${correo}.`;
        const waResp = await fetch(`http://127.0.0.1:${PORT}/wa/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: `+52${phone}`, body: waBody, tipo: 'ticket_autofact' }),
        });
        waSent = waResp.ok;
      } catch(e) { console.warn('[emit-auto] wa falló:', e.message); }
    }
    // Ya respondimos al frontend arriba (justo tras el paso 1). Log final:
    console.log('[emit-auto] async done:', JSON.stringify({
      folio, sheetUpdated, pdfSaved, mailSent, waSent, pdfError
    }));
  } catch (err) {
    console.error("facturapi_emit_auto_error", err.message);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: err.message });
    }
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
    _bancosMarkDirty();
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

// ═══════════════════════════════════════════════════════════════════════════
// ║ BÓVEDA — Control de contraseñas y accesos (Configuración admin)          ║
// ║ • Acceso SOLO con código de 6 dígitos enviado por WhatsApp a VAULT_PHONE ║
// ║   (cada ingreso; ni el admin entra sin código).                          ║
// ║ • Sesión firmada (HMAC) de 15 min deslizante; vive solo en memoria del   ║
// ║   navegador.                                                              ║
// ║ • Datos cifrados con AES-256-GCM (llave VAULT_KEY) en un bucket privado  ║
// ║   de Cloud Storage (VAULT_BUCKET) con versiones. Nunca pasan por Sheets  ║
// ║   ni Apps Script. Nunca se registra el código ni el contenido en logs.   ║
// ═══════════════════════════════════════════════════════════════════════════
const _V_OBJ = "boveda.json";
const _V_SESSION_MS = 15 * 60 * 1000;
const _V_CODE_MS = 5 * 60 * 1000;
const _V_ORIGINS = /^https:\/\/(www\.)?check-inn\.mx$|^http:\/\/localhost(:\d+)?$/;
function _vKeys() {
  const raw = String(process.env.VAULT_KEY || "");
  if (!raw) throw new Error("VAULT_KEY no configurada");
  const master = Buffer.from(raw, "base64");
  if (master.length !== 32) throw new Error("VAULT_KEY inválida");
  const derive = info => Buffer.from(crypto.hkdfSync("sha256", master, Buffer.alloc(0), Buffer.from(info), 32));
  return { enc: derive("checkinn-boveda-enc"), mac: derive("checkinn-boveda-mac") };
}
function _vSign(obj) {
  const p = Buffer.from(JSON.stringify(obj)).toString("base64url");
  const s = crypto.createHmac("sha256", _vKeys().mac).update(p).digest("base64url");
  return `${p}.${s}`;
}
function _vUnsign(tok) {
  const [p, s] = String(tok || "").split(".");
  if (!p || !s) return null;
  const exp = crypto.createHmac("sha256", _vKeys().mac).update(p).digest();
  const got = Buffer.from(s, "base64url");
  if (got.length !== exp.length || !crypto.timingSafeEqual(got, exp)) return null;
  try { return JSON.parse(Buffer.from(p, "base64url").toString()); } catch (_) { return null; }
}
function _vEncrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", _vKeys().enc, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}
function _vDecrypt(box) {
  const d = crypto.createDecipheriv("aes-256-gcm", _vKeys().enc, Buffer.from(box.iv, "base64"));
  d.setAuthTag(Buffer.from(box.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(box.ct, "base64")), d.final()]).toString("utf8"));
}
async function _vGcsToken() {
  const r = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } });
  if (!r.ok) throw new Error("No hay credenciales de Cloud Storage");
  return (await r.json()).access_token;
}
async function _vRead() {
  const bucket = process.env.VAULT_BUCKET;
  if (!bucket) throw new Error("VAULT_BUCKET no configurado");
  const tok = await _vGcsToken();
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(_V_OBJ)}?alt=media`, { headers: { Authorization: `Bearer ${tok}` } });
  if (r.status === 404) return { data: { records: [], log: [] }, gen: "0" };
  if (!r.ok) throw new Error(`Cloud Storage ${r.status}`);
  const gen = r.headers.get("x-goog-generation") || "0";
  const data = _vDecrypt(await r.json());
  data.records = data.records || []; data.log = data.log || [];
  return { data, gen };
}
async function _vWrite(data, gen) {
  const bucket = process.env.VAULT_BUCKET;
  const tok = await _vGcsToken();
  const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(_V_OBJ)}&ifGenerationMatch=${gen}`, {
    method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(_vEncrypt(data)),
  });
  if (r.status === 412) { const e = new Error("conflicto"); e.conflict = true; throw e; }
  // 429/503: Cloud Storage limita ~1 escritura por segundo al mismo objeto → reintentar.
  if (r.status === 429 || r.status === 503) { const e = new Error(`Cloud Storage ${r.status}`); e.retry = true; throw e; }
  if (!r.ok) throw new Error(`Cloud Storage ${r.status}`);
}
// Lee → aplica cambio → escribe, con reintento si otra sesión escribió en medio.
// Además serializa las escrituras de esta instancia (cola) para no rebasar el límite.
let _vQueue = Promise.resolve();
function _vMutate(fn) {
  const run = _vQueue.then(() => _vMutateNow(fn));
  _vQueue = run.catch(() => {});
  return run;
}
async function _vMutateNow(fn) {
  for (let i = 0; i < 7; i++) {
    const { data, gen } = await _vRead();
    const out = fn(data);
    if (data.log.length > 2000) data.log = data.log.slice(-2000);
    try { await _vWrite(data, gen); return out; }
    catch (e) {
      if (!e.conflict && !e.retry) throw e;
      await new Promise(r => setTimeout(r, Math.min(8000, 1100 * Math.pow(1.6, i)) + Math.random() * 300));
    }
  }
  throw new Error("No se pudo guardar (conflicto). Intenta de nuevo.");
}
function _vOriginOk(req) { const o = String(req.headers.origin || ""); return !o || _V_ORIGINS.test(o); }
function _vSession(req) {
  const s = _vUnsign(req.headers["x-vault-token"]);
  if (!s || s.t !== "s" || Date.now() > s.exp) return null;
  return s;
}
function _vNewSession(s) { const exp = Date.now() + _V_SESSION_MS; return { token: _vSign({ t: "s", u: s.u, exp, n: crypto.randomBytes(6).toString("hex") }), exp }; }
const _vCodeSends = [];            // marcas de tiempo de envíos (límite global)
// SMS directo con Twilio (sin plantillas ni ventana de 24 h). From: TWILIO_SMS_FROM o el número del WhatsApp.
async function _vSendSms(to, body) {
  const acct = process.env.TWILIO_ACCOUNT_SID, user = process.env.TWILIO_API_KEY_SID || acct, pass = process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_AUTH_TOKEN;
  const from = String(process.env.TWILIO_SMS_FROM || process.env.TWILIO_WA_FROM || "").replace(/^whatsapp:/, "");
  if (!acct || !pass || !from) throw new Error("Twilio SMS no configurado");
  const f = new URLSearchParams(); f.set("From", from); f.set("To", to); f.set("Body", body);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${acct}/Messages.json`, { method: "POST", headers: { Authorization: "Basic " + Buffer.from(user + ":" + pass).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" }, body: f.toString() });
  const j = await r.json();
  if (!r.ok) throw new Error(`Twilio ${r.status}: ${j.message || ""}`);
  return j;
}
const _vAttempts = new Map();      // nonce → intentos fallidos
// 1) Enviar código
app.post("/vault/code", async (req, res) => {
  try {
    if (!_vOriginOk(req)) return res.status(403).json({ ok: false, error: "Origen no permitido" });
    // VAULT_PHONE admite varios números separados por ";" o ",". El mismo código va a todos.
    const phones = String(process.env.VAULT_PHONE || "").split(/[;,]/).map(x => x.trim()).filter(Boolean);
    if (!phones.length) return res.status(500).json({ ok: false, error: "VAULT_PHONE no configurado" });
    const now = Date.now();
    while (_vCodeSends.length && now - _vCodeSends[0] > 3600e3) _vCodeSends.shift();
    if (_vCodeSends.length && now - _vCodeSends[_vCodeSends.length - 1] < 30e3) return res.status(429).json({ ok: false, error: "Espera 30 segundos antes de pedir otro código." });
    if (_vCodeSends.length >= 12) return res.status(429).json({ ok: false, error: "Demasiados códigos en la última hora. Intenta más tarde." });
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
    const nonce = crypto.randomBytes(12).toString("hex");
    const user = String((req.body || {}).user || "").slice(0, 80);
    const h = crypto.createHmac("sha256", _vKeys().mac).update(`${nonce}:${code}`).digest("base64url");
    const challenge = _vSign({ t: "c", n: nonce, h, u: user, exp: now + _V_CODE_MS });
    const sms = String((req.body || {}).channel || "") === "sms";
    const body = sms
      ? `Check Inn: tu codigo de acceso a Control de contrasenas es ${code}. Vence en 5 min. Solicitado por: ${user || "usuario del sistema"}. Si no fuiste tu, ignoralo.`
      : `🔐 Check Inn · Código de acceso a "Control de contraseñas y accesos": *${code}*\n\nVence en 5 minutos. Solicitado por: ${user || "usuario del sistema"}. Si no fuiste tú, ignóralo.`;
    const send = ph => sms ? _vSendSms(ph, body) : _twilioSendMessage({ to: `whatsapp:${ph}`, body, skipMirror: true });
    const sent = await Promise.all(phones.map(ph => send(ph)
      .then(m => ({ to: "•••• " + ph.slice(-4), sid: m && m.sid }), e => ({ to: "•••• " + ph.slice(-4), error: e.message }))));
    const ok = sent.filter(x => x.sid);
    if (!ok.length) throw new Error(sent.map(x => `${x.to}: ${x.error}`).join(" · "));
    _vCodeSends.push(now);
    res.json({ ok: true, challenge, channel: sms ? "sms" : "whatsapp", to: ok.map(x => x.to).join(" y "), sent });
  } catch (e) { console.warn("[vault] code:", e.message); res.status(500).json({ ok: false, error: e.message }); }
});
// 1b) Estado de entrega del WhatsApp (para avisar si no llegó)
app.get("/vault/code-status", async (req, res) => {
  try {
    const sid = String(req.query.sid || "");
    if (!/^SM[0-9a-f]{32}$|^MM[0-9a-f]{32}$/i.test(sid)) return res.status(400).json({ ok: false });
    const acct = process.env.TWILIO_ACCOUNT_SID, user = process.env.TWILIO_API_KEY_SID || acct, pass = process.env.TWILIO_API_KEY_SECRET || process.env.TWILIO_AUTH_TOKEN;
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${acct}/Messages/${sid}.json`, { headers: { Authorization: "Basic " + Buffer.from(user + ":" + pass).toString("base64") } });
    const j = await r.json();
    res.json({ ok: true, status: j.status, errorCode: j.error_code || null });
  } catch (e) { res.status(500).json({ ok: false }); }
});
// 2) Verificar código → sesión
app.post("/vault/verify", async (req, res) => {
  try {
    if (!_vOriginOk(req)) return res.status(403).json({ ok: false, error: "Origen no permitido" });
    const { challenge, code } = req.body || {};
    const c = _vUnsign(challenge);
    if (!c || c.t !== "c") return res.status(400).json({ ok: false, error: "Solicitud inválida. Pide un código nuevo." });
    if (Date.now() > c.exp) return res.status(400).json({ ok: false, error: "El código venció. Pide uno nuevo." });
    const n = _vAttempts.get(c.n) || 0;
    if (n >= 5) return res.status(429).json({ ok: false, error: "Demasiados intentos. Pide un código nuevo." });
    const h = crypto.createHmac("sha256", _vKeys().mac).update(`${c.n}:${String(code || "").trim()}`).digest("base64url");
    if (h.length !== c.h.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(c.h))) {
      _vAttempts.set(c.n, n + 1);
      return res.status(401).json({ ok: false, error: `Código incorrecto (${4 - n} intento${4 - n === 1 ? "" : "s"} restante${4 - n === 1 ? "" : "s"}).` });
    }
    _vAttempts.set(c.n, 99); // un código sirve una sola vez
    const ses = _vNewSession({ u: c.u });
    _vMutate(d => { d.log.push({ ts: new Date().toISOString(), u: c.u, a: "Ingresó a la bóveda" }); }).catch(e => console.warn("[vault] log:", e.message));
    res.json({ ok: true, ...ses });
  } catch (e) { console.warn("[vault] verify:", e.message); res.status(500).json({ ok: false, error: e.message }); }
});
function _vGuard(req, res) {
  if (!_vOriginOk(req)) { res.status(403).json({ ok: false, error: "Origen no permitido" }); return null; }
  const s = _vSession(req);
  if (!s) { res.status(401).json({ ok: false, error: "Sesión vencida", locked: true }); return null; }
  return s;
}
// Campos sensibles por tipo (espejo de VA_TIPOS en app.js). 'p' = se muestra últimos 4.
const _V_SECRET = {
  banco: { tarjeta: "p", clabe: "p", cuenta: "p", nip: "s", pass: "s", passOp: "s" },
  cuenta: { pass: "s" }, servicio: { pass: "s" }, dispositivo: { pass: "s" },
  acceso: { clave: "s" }, internet: { pass: "s" }, otro: { pass: "s" },
};
function _vRestringido(r) { return r.restringido !== false; } // registros previos sin bandera = restringidos
// Versión SIN sesión: los registros restringidos van sin sus datos sensibles.
function _vPublicRecord(r) {
  if (!_vRestringido(r)) return r;
  const o = JSON.parse(JSON.stringify(r)); o._masked = {};
  const sec = _V_SECRET[o.tipo] || { pass: "s", nip: "s", clave: "s" };
  Object.keys(o.f || {}).forEach(k => {
    const kind = sec[k] || (/^(pass|nip|clave|pin)/i.test(k) ? "s" : "");
    if (!kind || !o.f[k]) return;
    o._masked[k] = kind === "p" ? "•••• " + String(o.f[k]).replace(/\s/g, "").slice(-4) : "••••••••";
    delete o.f[k];
  });
  (o.extras || []).forEach((x, i) => { if (x.secret && x.v) { o._masked["x" + i] = "••••••••"; x.v = ""; } });
  return o;
}
// 3a) Leer SIN código: registros no restringidos completos + restringidos sin datos sensibles.
app.get("/vault/list", async (req, res) => {
  if (!_vOriginOk(req)) return res.status(403).json({ ok: false, error: "Origen no permitido" });
  try {
    const { data } = await _vRead();
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, records: data.records.map(_vPublicRecord) });
  } catch (e) { console.warn("[vault] list:", e.message); res.status(500).json({ ok: false, error: e.message }); }
});
// 3) Leer
app.get("/vault/data", async (req, res) => {
  const s = _vGuard(req, res); if (!s) return;
  try {
    const { data } = await _vRead();
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, records: data.records, log: data.log.slice(-300).reverse(), ...(_vNewSession(s)) });
  } catch (e) { console.warn("[vault] read:", e.message); res.status(500).json({ ok: false, error: e.message }); }
});
// 4) Guardar / eliminar / bitácora
app.post("/vault/save", async (req, res) => {
  const s = _vGuard(req, res); if (!s) return;
  try {
    const rec = (req.body || {}).record;
    if (!rec || typeof rec !== "object") return res.status(400).json({ ok: false, error: "record requerido" });
    const id = await _vMutate(d => {
      const now = new Date().toISOString();
      const r = { ...rec, id: rec.id || ("V" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex")), updatedAt: now, updatedBy: s.u };
      const i = d.records.findIndex(x => x.id === r.id);
      if (i >= 0) { r.createdAt = d.records[i].createdAt; d.records[i] = r; } else { r.createdAt = now; d.records.push(r); }
      d.log.push({ ts: now, u: s.u, a: i >= 0 ? "Editó registro" : "Creó registro", r: r.id, t: String(r.titulo || "").slice(0, 80) });
      return r.id;
    });
    res.json({ ok: true, id, ...(_vNewSession(s)) });
  } catch (e) { console.warn("[vault] save:", e.message); res.status(500).json({ ok: false, error: e.message }); }
});
// Alta masiva (importaciones): todos los registros en UNA sola escritura.
app.post("/vault/save-many", async (req, res) => {
  const s = _vGuard(req, res); if (!s) return;
  try {
    const list = Array.isArray((req.body || {}).records) ? req.body.records.filter(r => r && typeof r === "object").slice(0, 500) : [];
    if (!list.length) return res.status(400).json({ ok: false, error: "records requerido" });
    const ids = await _vMutate(d => {
      const now = new Date().toISOString();
      const out = list.map(rec => {
        const r = { ...rec, id: rec.id || ("V" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex")), createdAt: now, updatedAt: now, updatedBy: s.u };
        d.records.push(r);
        return r.id;
      });
      d.log.push({ ts: now, u: s.u, a: `Importó ${out.length} registros`, t: String((req.body || {}).origen || "").slice(0, 80) });
      return out;
    });
    res.json({ ok: true, ids, ...(_vNewSession(s)) });
  } catch (e) { console.warn("[vault] save-many:", e.message); res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/vault/delete", async (req, res) => {
  const s = _vGuard(req, res); if (!s) return;
  try {
    const id = String((req.body || {}).id || "");
    await _vMutate(d => {
      const r = d.records.find(x => x.id === id);
      d.records = d.records.filter(x => x.id !== id);
      d.log.push({ ts: new Date().toISOString(), u: s.u, a: "Eliminó registro", r: id, t: r ? String(r.titulo || "").slice(0, 80) : "" });
    });
    res.json({ ok: true, ...(_vNewSession(s)) });
  } catch (e) { console.warn("[vault] delete:", e.message); res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/vault/log", async (req, res) => {
  const s = _vGuard(req, res); if (!s) return;
  try {
    const b = req.body || {};
    await _vMutate(d => { d.log.push({ ts: new Date().toISOString(), u: s.u, a: String(b.a || "").slice(0, 60), r: String(b.r || "").slice(0, 40), t: String(b.t || "").slice(0, 120) }); });
    res.json({ ok: true, ...(_vNewSession(s)) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ║ SEÑALÉTICA — kit editable de señales para impresión                     ║
// ║ Datos (marca + diseños) en gs://check-in-493804-senaletica/datos/…json   ║
// ║ Imágenes públicas en …/media/ (las lee el editor y el PDF).              ║
// ═══════════════════════════════════════════════════════════════════════════
const _SN_BUCKET = "check-in-493804-senaletica";
const _SN_OBJ = "datos/senaletica.json";
async function _snRead() {
  const tok = await _vGcsToken();
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${_SN_BUCKET}/o/${encodeURIComponent(_SN_OBJ)}?alt=media`, { headers: { Authorization: `Bearer ${tok}` } });
  if (r.status === 404) return { data: { v: 1, marca: {}, disenos: [] }, gen: "0" };
  if (!r.ok) throw new Error(`Cloud Storage ${r.status}`);
  return { data: await r.json(), gen: r.headers.get("x-goog-generation") || "0" };
}
async function _snWriteObj(name, body, contentType, gen, cache) {
  const tok = await _vGcsToken();
  const meta = { name, contentType, cacheControl: cache || "no-store" };
  const boundary = "sn" + crypto.randomBytes(8).toString("hex");
  const pre = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`);
  const post = Buffer.from(`\r\n--${boundary}--`);
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${_SN_BUCKET}/o?uploadType=multipart${gen != null ? `&ifGenerationMatch=${gen}` : ""}`;
  const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body: Buffer.concat([pre, Buffer.isBuffer(body) ? body : Buffer.from(body), post]) });
  if (r.status === 412) { const e = new Error("conflicto"); e.conflict = true; throw e; }
  if (r.status === 429 || r.status === 503) { const e = new Error(`Cloud Storage ${r.status}`); e.retry = true; throw e; }
  if (!r.ok) throw new Error(`Cloud Storage ${r.status}`);
  return r.json();
}
let _snQueue = Promise.resolve();
function _snMutate(fn) {
  const run = _snQueue.then(async () => {
    for (let i = 0; i < 7; i++) {
      const { data, gen } = await _snRead();
      const out = fn(data);
      try { await _snWriteObj(_SN_OBJ, JSON.stringify(data), "application/json", gen); return out; }
      catch (e) { if (!e.conflict && !e.retry) throw e; await new Promise(r => setTimeout(r, Math.min(8000, 1100 * Math.pow(1.6, i)))); }
    }
    throw new Error("No se pudo guardar (conflicto). Intenta de nuevo.");
  });
  _snQueue = run.catch(() => {});
  return run;
}
function _snOrigin(req, res) { if (_vOriginOk(req)) return true; res.status(403).json({ ok: false, error: "Origen no permitido" }); return false; }
app.get("/senal/data", async (req, res) => {
  if (!_snOrigin(req, res)) return;
  try { const { data } = await _snRead(); res.set("Cache-Control", "no-store"); res.json({ ok: true, base: `https://storage.googleapis.com/${_SN_BUCKET}/`, ...data }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/senal/save", async (req, res) => {
  if (!_snOrigin(req, res)) return;
  try {
    const d = (req.body || {}).diseno;
    if (!d || typeof d !== "object" || !Array.isArray(d.els)) return res.status(400).json({ ok: false, error: "diseno inválido" });
    const user = String((req.body || {}).user || "").slice(0, 80);
    const id = await _snMutate(data => {
      data.disenos = data.disenos || [];
      const now = new Date().toISOString();
      const r = { ...d, id: d.id || ("D" + Date.now().toString(36)), updatedAt: now, updatedBy: user };
      const i = data.disenos.findIndex(x => x.id === r.id);
      if (i >= 0) data.disenos[i] = r; else { r.orden = (Math.max(0, ...data.disenos.map(x => x.orden || 0)) + 1); data.disenos.push(r); }
      return r.id;
    });
    res.json({ ok: true, id });
  } catch (e) { console.warn("[senal] save:", e.message); res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/senal/delete", async (req, res) => {
  if (!_snOrigin(req, res)) return;
  try { const id = String((req.body || {}).id || ""); await _snMutate(data => { data.disenos = (data.disenos || []).filter(x => x.id !== id); }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/senal/marca", async (req, res) => {
  if (!_snOrigin(req, res)) return;
  try {
    const m = (req.body || {}).marca;
    if (!m || typeof m !== "object") return res.status(400).json({ ok: false, error: "marca inválida" });
    await _snMutate(data => { data.marca = m; data.marcaUpdatedAt = new Date().toISOString(); });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Sube una imagen (dataURL PNG/JPG/SVG/WebP) a media/ y devuelve su ruta relativa.
app.post("/senal/upload", async (req, res) => {
  if (!_snOrigin(req, res)) return;
  try {
    const { data, name } = req.body || {};
    const m = String(data || "").match(/^data:(image\/(png|jpeg|svg\+xml|webp));base64,(.+)$/);
    if (!m) return res.status(400).json({ ok: false, error: "Formato no soportado (PNG, JPG, SVG o WebP)" });
    const buf = Buffer.from(m[3], "base64");
    if (buf.length > 12 * 1024 * 1024) return res.status(400).json({ ok: false, error: "Imagen mayor a 12 MB" });
    const ext = { "image/png": "png", "image/jpeg": "jpg", "image/svg+xml": "svg", "image/webp": "webp" }[m[1]];
    const safe = String(name || "imagen").normalize("NFD").replace(/[^\w.-]+/g, "-").replace(/\.[a-z0-9]+$/i, "").slice(0, 40) || "imagen";
    const obj = `media/u-${Date.now().toString(36)}-${safe}.${ext}`;
    await _snWriteObj(obj, buf, m[1], null, "public, max-age=31536000");
    res.json({ ok: true, path: obj });
  } catch (e) { console.warn("[senal] upload:", e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// ── Generar una señal con Claude a partir de una descripción ─────────────
// Claude devuelve una escena simplificada (JSON con esquema estricto) que aquí
// se valida y se convierte al formato del editor. Íconos: Lucide (ISC).
let _snIcons = {};
try { _snIcons = require("./senal_icons.json").iconos || {}; } catch (e) { console.warn("[senal] sin catálogo de íconos:", e.message); }
app.get("/senal/icons", (req, res) => { res.set("Cache-Control", "public, max-age=86400"); res.json({ ok: true, vb: 24, iconos: _snIcons }); });
const _snGenHits = new Map();
function _snGenSchema() {
  const num = { type: "number" };
  const run = { type: "object", additionalProperties: false, required: ["text", "size", "bold", "color", "font"],
    properties: { text: { type: "string" }, size: num, bold: { type: "boolean" }, color: { type: "string" }, font: { type: "string", enum: ["$fTitulo", "$fTexto"] } } };
  const el = { type: "object", additionalProperties: false, required: ["t", "x", "y", "w", "h"], properties: {
    t: { type: "string", enum: ["rect", "ellipse", "poly", "line", "text", "icon", "qr", "logo"] },
    x: num, y: num, w: num, h: num,
    fill: { type: "string" }, stroke: { type: "string" }, sw: num, r: num,
    pts: { type: "array", items: { type: "object", additionalProperties: false, required: ["x", "y"], properties: { x: num, y: num } } },
    align: { type: "string", enum: ["left", "center", "right"] },
    anchor: { type: "string", enum: ["top", "middle", "bottom"] },
    paras: { type: "array", items: { type: "object", additionalProperties: false, required: ["runs"], properties: { runs: { type: "array", items: run } } } },
    icon: { type: "string", enum: Object.keys(_snIcons).length ? Object.keys(_snIcons) : ["info"] },
    data: { type: "string" },
  } };
  return { type: "object", additionalProperties: false, required: ["nombre", "cat", "els"],
    properties: { nombre: { type: "string" }, cat: { type: "string" }, els: { type: "array", items: el } } };
}
function _snGenSystem(marca, op, W, H, pieH) {
  const col = marca.colores || {};
  const tokens = Object.keys(col).map(k => `$${k} = ${col[k]}`).join(", ");
  const iconos = Object.entries(_snIcons).map(([n, v]) => `${n} (${v.k})`).join("; ");
  const altoUtil = (H - pieH).toFixed(2);
  const k = Math.min(W, H) / 7.5, kf = x => Math.round(x * k * 10) / 10;
  return `Eres diseñador gráfico experto en señalética e impresos para alojamientos de renta corta (${marca.nombre || "la marca"}).
Diseñas UNA pieza ${W > H ? "horizontal" : W < H ? "vertical" : "cuadrada"} de ${W} × ${H} pulgadas (${(W * 2.54).toFixed(1)} × ${(H * 2.54).toFixed(1)} cm).
ESCALA: los tamaños de referencia de abajo ya están ajustados a este formato (factor ${k.toFixed(2)} respecto a una hoja de 7.5 × 10 in). Todas las coordenadas y medidas (x, y, w, h, r, pts) son en PULGADAS desde la esquina superior izquierda. Los tamaños de texto (size) son en PUNTOS (72 pt = 1 pulgada).
${pieH ? `La franja inferior desde y = ${altoUtil} hasta ${H} está RESERVADA para el pie de marca (se agrega automáticamente): no pongas nada ahí. Tu área útil es de y = 0 a y = ${altoUtil}.` : "No incluyas pie de marca."}

ELEMENTOS (el orden del arreglo es el orden de dibujo: el primero queda al fondo):
- rect: rectángulo. fill (relleno), stroke + sw (borde, sw en pt), r (radio de esquina en pulgadas).
- ellipse: círculo/elipse dentro de la caja x,y,w,h. fill, stroke, sw.
- poly: polígono; pts = vértices en pulgadas RELATIVOS a la esquina (x,y) de la caja. fill.
- line: línea recta de (x, y) a (x + w, y + h) (w o h pueden ser 0 o negativos). stroke, sw.
- text: cuadro de texto que hace salto de línea automático dentro del ancho w. align (left/center/right), anchor (top/middle/bottom: alineación vertical dentro de h). paras = párrafos; cada uno con runs (fragmentos con su estilo). Deja h suficiente: cada renglón ocupa ≈ size × 1.2 / 72 pulgadas.
- icon: ícono de línea simple (estilo pictograma) dentro de una caja cuadrada; icon = nombre del catálogo; stroke = color del trazo; sw = grosor relativo (1.5 a 2.5; 2 normal).
- qr: código QR; data = URL o texto; fill = color de los módulos. Mínimo ${Math.max(0.7, 1.6 * k).toFixed(2)} in de lado.
- logo: logotipo de la marca (pin), proporción ancho:alto = 676:980.

COLORES: usa "#RRGGBB" o un token de la marca (${tokens || "sin tokens"}). Fondo: si la señal debe tener color de fondo, pon primero un rect que cubra toda la hoja (0,0,${W},${altoUtil}).
${op.marca ? "Prefiere los tokens de color de la marca, salvo que la descripción del usuario pida otros colores." : "Elige la paleta que pida el usuario; si no la especifica, usa una paleta sobria."}
"Colores ejecutivos" = azul marino (#0B1F3A / #1E3A5F), gris carbón (#334155), grises claros (#E2E8F0 / #F1F5F9), blanco y un solo color de acento (p. ej. rojo #C62828 para prohibiciones, ámbar #F59E0B para precaución, verde #15803D para permitido).
FUENTES: font = "$fTitulo" (${(marca.fuentes || {}).fTitulo || "Poppins"}, para títulos) o "$fTexto" (${(marca.fuentes || {}).fTexto || "Carlito"}, para textos).

REGLAS DE DISEÑO:
- Márgenes mínimos de ${Math.max(0.12, 0.4 * k).toFixed(2)} in. Nada fuera de la hoja.
- Jerarquía clara: un mensaje principal grande (título ${kf(60)}–${kf(110)} pt en mayúsculas si es aviso), un pictograma o ícono protagonista (${kf(2.5)}–${kf(4)} in), y texto secundario breve (${kf(20)}–${kf(32)} pt). ${k < 0.6 ? "Es un impreso pequeño: se lee de cerca, prioriza claridad y poco texto." : "Debe leerse a 3 metros."}
- Aprovecha la proporción de la hoja: en formatos horizontales acomoda ícono y texto lado a lado.
- Para prohibiciones usa el símbolo universal: un ícono del objeto y encima un círculo (ellipse sin relleno, stroke rojo, sw ${kf(18)}–${kf(26)} pt) con una diagonal (line del mismo color y grosor) de arriba-izquierda a abajo-derecha, inscrita en el círculo; o usa los íconos "ban", "cigarette-off", "volume-off" cuando existan.
- Textos en el idioma que pida el usuario (por defecto español de México). Sin faltas de ortografía. Mensajes cortos y amables pero firmes.
- Puedes usar los textos {{marca}}, {{web}} y {{tel}}: se reemplazan por los datos de la marca (${marca.nombre || ""} · ${marca.web || ""} · ${marca.tel || ""}).
- Estilo limpio, mucho espacio en blanco, alineaciones consistentes, máximo 3 colores además de blanco/negro.
- No inventes elementos que no existan en el esquema; para dibujos complejos usa íconos del catálogo.

CATÁLOGO DE ÍCONOS (nombre (significado)): ${iconos}

Devuelve: nombre (título corto de la señal), cat (categoría: Reglamentos, Seguridad, Estacionamiento, Áreas comunes, Bienvenida, Mapas u otra breve) y els.`;
}
function _snGenColor(v, marca, def) {
  const s = String(v || "").trim();
  if (/^\$\w+$/.test(s) && (marca.colores || {})[s.slice(1)]) return s;
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return ("#" + s.slice(1).split("").map(c => c + c).join("")).toUpperCase();
  return def;
}
function _snGenConvert(out, marca, W, H) {
  const n = (v, d) => (typeof v === "number" && isFinite(v) ? v : d);
  const clampBox = e => { e.w = Math.max(0.05, Math.min(W, n(e.w, 1))); e.h = Math.max(0.05, Math.min(H, n(e.h, 1))); e.x = Math.max(-0.1, Math.min(W - 0.05, n(e.x, 0))); e.y = Math.max(-0.1, Math.min(H - 0.05, n(e.y, 0))); return e; };
  const els = [];
  for (const raw of (out.els || []).slice(0, 80)) {
    const e = clampBox({ ...raw });
    const fill = _snGenColor(e.fill, marca, null), stroke = _snGenColor(e.stroke, marca, null);
    const sw = Math.max(0, Math.min(60, n(e.sw, 0)));
    if (e.t === "rect") els.push({ t: "rect", x: e.x, y: e.y, w: e.w, h: e.h, fill, stroke, sw: stroke ? sw || 2 : 0, r: Math.max(0, Math.min(Math.min(e.w, e.h) / 2, n(e.r, 0))) });
    else if (e.t === "ellipse") els.push({ t: "ellipse", x: e.x, y: e.y, w: e.w, h: e.h, fill, stroke, sw: stroke ? sw || 2 : 0 });
    else if (e.t === "poly" && Array.isArray(e.pts) && e.pts.length >= 3) {
      const xs = e.pts.map(p => n(p.x, 0)), ys = e.pts.map(p => n(p.y, 0));
      const mx = Math.min(...xs), my = Math.min(...ys), w = Math.max(...xs) - mx, h = Math.max(...ys) - my;
      if (w > 0.02 && h > 0.02) els.push({ t: "poly", x: e.x + mx, y: e.y + my, w, h, fill: fill || "#000000", stroke, sw: stroke ? sw || 2 : 0, pts: xs.map((x, i) => [x - mx, ys[i] - my]) });
    } else if (e.t === "line") {
      const w = n(raw.w, 0), h = n(raw.h, 0);
      els.push({ t: "line", x1: n(raw.x, 0), y1: n(raw.y, 0), x2: n(raw.x, 0) + w, y2: n(raw.y, 0) + h, stroke: stroke || fill || "#000000", sw: sw || 4 });
    } else if (e.t === "text" && Array.isArray(e.paras) && e.paras.length) {
      const align = ["left", "center", "right"].includes(e.align) ? e.align : "center";
      const paras = e.paras.slice(0, 20).map(p => ({ align, runs: (p.runs || []).slice(0, 20).map(r => ({
        text: String(r.text || "").slice(0, 400), size: Math.max(6, Math.min(220, n(r.size, 24))), bold: !!r.bold,
        color: _snGenColor(r.color, marca, "#000000"), font: r.font === "$fTexto" ? "$fTexto" : "$fTitulo" })).filter(r => r.text) })).filter(p => p.runs.length);
      if (paras.length) els.push({ t: "text", x: e.x, y: e.y, w: e.w, h: e.h, anchor: ["top", "middle", "bottom"].includes(e.anchor) ? e.anchor : "middle", wrap: true, pad: [0, 0, 0, 0], paras });
    } else if (e.t === "icon" && _snIcons[e.icon]) {
      const s = Math.min(e.w, e.h);
      els.push({ t: "icon", name: e.icon, x: e.x + (e.w - s) / 2, y: e.y + (e.h - s) / 2, w: s, h: s, color: stroke || fill || "#000000", sw: Math.max(0.75, Math.min(4, n(e.sw, 2) || 2)) });
    } else if (e.t === "qr" && e.data) {
      const s = Math.max(Math.min(1.2, W / 3, H / 3), Math.min(e.w, e.h));
      els.push({ t: "qr", x: e.x + (e.w - s) / 2, y: e.y + (e.h - s) / 2, w: s, h: s, data: String(e.data).slice(0, 600), fill: fill || "#000000" });
    } else if (e.t === "logo") {
      const r = 676 / 980; let w = e.w, h = w / r; if (h > e.h) { h = e.h; w = h * r; }
      els.push({ t: "image", x: e.x + (e.w - w) / 2, y: e.y + (e.h - h) / 2, w, h, src: "$logo", nat: [676, 980] });
    }
  }
  return els;
}
app.post("/senal/generar", async (req, res) => {
  if (!_snOrigin(req, res)) return;
  const b = req.body || {};
  const prompt = String(b.prompt || "").trim().slice(0, 2000);
  if (prompt.length < 5) return res.status(400).json({ ok: false, error: "Describe la señal que quieres crear." });
  const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
  const now = Date.now(), hits = (_snGenHits.get(ip) || []).filter(t => now - t < 3600e3);
  if (hits.length >= 30) return res.status(429).json({ ok: false, error: "Límite de 30 señales por hora alcanzado. Intenta más tarde." });
  hits.push(now); _snGenHits.set(ip, hits);
  const op = { marca: b.marca !== false, pie: b.pie !== false };
  const dim = v => Math.round(Math.max(1, Math.min(120, Number(v) || 0)) * 100) / 100;
  const W = b.w ? dim(b.w) : 7.5, H = b.h ? dim(b.h) : 10, k = Math.min(W, H) / 7.5, pieH = op.pie ? 1.14 * k : 0;
  try {
    const { data } = await _snRead();
    const marca = data.marca || {};
    const params = {
      model: "claude-opus-5-5",
      max_tokens: 24000,
      output_config: { effort: "medium", format: { type: "json_schema", schema: _snGenSchema() } },
      system: _snGenSystem(marca, op, W, H, pieH),
      messages: [{ role: "user", content: `Crea esta señal: ${prompt}` }],
    };
    let msg;
    try { msg = await anthropic.beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }).finalMessage(); }
    catch (e) {
      if (e && e.status === 400 && /fallback/i.test(String(e.message))) msg = await anthropic.messages.stream(params).finalMessage();
      else throw e;
    }
    if (msg.stop_reason === "refusal") return res.status(422).json({ ok: false, error: "Claude no pudo generar esta señal con esa descripción. Prueba redactarla de otra forma." });
    if (msg.stop_reason === "max_tokens") return res.status(422).json({ ok: false, error: "La señal resultó demasiado compleja. Simplifica la descripción." });
    const txt = (msg.content || []).filter(c => c.type === "text").map(c => c.text).pop() || "";
    let out; try { out = JSON.parse(txt); } catch (_) { return res.status(502).json({ ok: false, error: "Respuesta inválida de Claude. Intenta de nuevo." }); }
    const els = _snGenConvert(out, marca, W, H);
    if (!els.length) return res.status(502).json({ ok: false, error: "Claude no devolvió elementos. Intenta de nuevo." });
    if (op.pie) els.push(
      { t: "rect", x: 0, y: H - pieH, w: W, h: pieH, fill: (marca.colores || {}).amarillo ? "$amarillo" : "#F1F5F9" },
      { t: "image", x: 0.25 * k, y: H - 1.05 * k, w: 0.66 * k, h: 0.96 * k, src: "$logo", nat: [676, 980] },
      { t: "text", x: 1 * k, y: H - 1.05 * k, w: W - 1.2 * k, h: 0.9 * k, anchor: "middle", wrap: true, pad: [0.05 * k, 0, 0.05 * k, 0], paras: [
        { align: "left", runs: [{ text: "{{marca}}", size: Math.round(40 * k * 10) / 10, color: "#000000", font: "$fTitulo" }] },
        { align: "left", runs: [{ text: "{{web}}", size: Math.round(14 * k * 10) / 10, color: "#000000", font: "$fTitulo" }] }] });
    console.log(`[senal] generar ok · ${els.length} elementos · ${msg.usage?.input_tokens}+${msg.usage?.output_tokens} tokens · ${msg.model}`);
    res.json({ ok: true, diseno: { id: "", nombre: String(out.nombre || "Señal generada").slice(0, 80), cat: String(out.cat || "Generadas con IA").slice(0, 40), w: W, h: H, els, ia: { prompt, at: new Date().toISOString() } } });
  } catch (e) {
    console.warn("[senal] generar:", e.status || "", e.message);
    res.status(500).json({ ok: false, error: e.status === 529 || e.status === 503 ? "Claude está saturado en este momento; intenta en un minuto." : e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ║ PIZARRA del Panel de control — recordatorios del día (no son tareas).    ║
// ║ gs://check-in-493804-panel/pizarra.json (versionado). Compartida.        ║
// ═══════════════════════════════════════════════════════════════════════════
const _PZ_BUCKET = "check-in-493804-panel", _PZ_OBJ = "pizarra.json";
async function _pzRead() {
  const tok = await _vGcsToken();
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${_PZ_BUCKET}/o/${encodeURIComponent(_PZ_OBJ)}?alt=media`, { headers: { Authorization: `Bearer ${tok}` } });
  if (r.status === 404) return { data: { items: [] }, gen: "0" };
  if (!r.ok) throw new Error(`Cloud Storage ${r.status}`);
  return { data: await r.json(), gen: r.headers.get("x-goog-generation") || "0" };
}
async function _pzWrite(data, gen) {
  const tok = await _vGcsToken();
  const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${_PZ_BUCKET}/o?uploadType=media&name=${encodeURIComponent(_PZ_OBJ)}&ifGenerationMatch=${gen}`,
    { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  if (r.status === 412) { const e = new Error("conflicto"); e.retry = true; throw e; }
  if (r.status === 429 || r.status === 503) { const e = new Error(`Cloud Storage ${r.status}`); e.retry = true; throw e; }
  if (!r.ok) throw new Error(`Cloud Storage ${r.status}`);
}
let _pzQueue = Promise.resolve();
function _pzMutate(fn) {
  const run = _pzQueue.then(async () => {
    for (let i = 0; i < 7; i++) {
      const { data, gen } = await _pzRead();
      data.items = Array.isArray(data.items) ? data.items : [];
      const out = fn(data);
      // Limpieza: hechos con más de 30 días se archivan fuera de la lista.
      const lim = new Date(Date.now() - 30 * 864e5).toISOString();
      data.items = data.items.filter(x => !(x.hecho || x.estado === "cancelado") || (x.estadoAt || x.hechoAt || x.creadoAt || "") > lim);
      try { await _pzWrite(data, gen); return out; }
      catch (e) { if (!e.retry) throw e; await new Promise(r => setTimeout(r, Math.min(6000, 700 * Math.pow(1.6, i)))); }
    }
    throw new Error("No se pudo guardar (conflicto). Intenta de nuevo.");
  });
  _pzQueue = run.catch(() => {});
  return run;
}
function _pzOrigin(req, res) { if (_vOriginOk(req)) return true; res.status(403).json({ ok: false, error: "Origen no permitido" }); return false; }
const _pzClean = (v, n) => String(v == null ? "" : v).slice(0, n);
app.get("/pizarra/list", async (req, res) => {
  if (!_pzOrigin(req, res)) return;
  try { const { data } = await _pzRead(); res.set("Cache-Control", "no-store"); res.json({ ok: true, items: data.items || [] }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Crea o actualiza un recordatorio (merge de campos permitidos).
app.post("/pizarra/save", async (req, res) => {
  if (!_pzOrigin(req, res)) return;
  try {
    const b = req.body || {}, it = b.item || {}, user = _pzClean(b.user, 80);
    const now = new Date().toISOString();
    const item = await _pzMutate(data => {
      let x = it.id ? data.items.find(y => y.id === it.id) : null;
      if (!x) {
        if (!String(it.texto || "").trim()) throw new Error("Escribe el recordatorio.");
        x = { id: "PZ" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex"), creadoPor: user, creadoAt: now, hecho: false };
        data.items.push(x);
      }
      if (it.texto != null) x.texto = _pzClean(it.texto, 500).trim();
      if (it.prioridad != null) x.prioridad = ["critica", "alta", "media", "baja"].includes(it.prioridad) ? it.prioridad : "media";
      if (!x.prioridad) x.prioridad = "media";
      if (it.asignados != null) x.asignados = (Array.isArray(it.asignados) ? it.asignados : []).map(n => _pzClean(n, 80).trim()).filter(Boolean).slice(0, 12);
      if (it.fecha != null) x.fecha = /^\d{4}-\d{2}-\d{2}$/.test(it.fecha) ? it.fecha : now.slice(0, 10);
      if (!x.fecha) x.fecha = now.slice(0, 10);
      // Estado (columnas de la pizarra): pendiente | proceso | resuelto | cancelado. `hecho` = resuelto (compatibilidad).
      if (!x.estado) x.estado = x.hecho ? "resuelto" : "pendiente";
      let est = it.estado != null ? String(it.estado) : (it.hecho != null ? (it.hecho ? "resuelto" : "pendiente") : null);
      if (est && ["pendiente", "proceso", "resuelto", "cancelado"].includes(est) && est !== x.estado) {
        x.estado = est; x.estadoPor = user; x.estadoAt = now;
        x.hecho = est === "resuelto"; x.hechoPor = x.hecho ? user : ""; x.hechoAt = x.hecho ? now : "";
      }
      x.updatedAt = now; x.updatedBy = user;
      return x;
    });
    res.json({ ok: true, item });
  } catch (e) { res.status(/Escribe/.test(e.message) ? 400 : 500).json({ ok: false, error: e.message }); }
});
app.post("/pizarra/delete", async (req, res) => {
  if (!_pzOrigin(req, res)) return;
  try { const id = String((req.body || {}).id || ""); await _pzMutate(data => { data.items = data.items.filter(x => x.id !== id); }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ║ DOCUMENTOS DEL PERSONAL (INE, CIF, comprobante de domicilio, NSS)        ║
// ║ Privados: gs://check-in-493804-panel/rh-docs/<empleado>/… + manifest.json ║
// ║ Se ven con un link firmado (HMAC) que entrega /rh/docs.                   ║
// ═══════════════════════════════════════════════════════════════════════════
const _RHD_KINDS = { ine: "INE", domicilio: "Comprobante de domicilio", cif: "Certificado de Identificación Fiscal (CIF)", nss: "No. Seguro Social" };
const _RHD_SECRET = process.env.SYNC_SECRET || process.env.GH_TOKEN || "rh-docs";
const _rhdEmp = v => String(v || "").replace(/[^\w-]/g, "").slice(0, 60);
const _rhdSig = (emp, kind, path) => crypto.createHmac("sha256", _RHD_SECRET).update(`${emp}|${kind}|${path}`).digest("hex").slice(0, 32);
async function _rhdGetJson(name) {
  const tok = await _vGcsToken();
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${_PZ_BUCKET}/o/${encodeURIComponent(name)}?alt=media`, { headers: { Authorization: `Bearer ${tok}` } });
  if (r.status === 404) return {};
  if (!r.ok) throw new Error(`Cloud Storage ${r.status}`);
  return r.json();
}
async function _rhdPut(name, body, contentType) {
  const tok = await _vGcsToken();
  const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${_PZ_BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}`,
    { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": contentType }, body });
  if (!r.ok) throw new Error(`Cloud Storage ${r.status}`);
}
const _rhdQueue = new Map(); // un manifest por empleado → escrituras en serie
function _rhdMutate(emp, fn) {
  const prev = _rhdQueue.get(emp) || Promise.resolve();
  const run = prev.then(async () => {
    const name = `rh-docs/${emp}/manifest.json`;
    const m = await _rhdGetJson(name);
    const out = fn(m);
    await _rhdPut(name, JSON.stringify(m), "application/json");
    return out;
  });
  _rhdQueue.set(emp, run.catch(() => {}));
  return run;
}
function _rhdPublic(emp, m) {
  const out = {};
  for (const k of Object.keys(_RHD_KINDS)) {
    const d = m[k]; if (!d || !d.path) continue;
    out[k] = { name: d.name, mime: d.mime, size: d.size, at: d.at, by: d.by,
      url: `/rh/docs/file?emp=${encodeURIComponent(emp)}&kind=${k}&t=${_rhdSig(emp, k, d.path)}` };
  }
  return out;
}
// Resumen para la tabla de personal: { emp: { ine: true, cif: true, ... } }. Cache 2 min.
let _rhdRes = { ts: 0, data: null, inflight: null };
async function _rhdResumen(force) {
  if (!force && _rhdRes.data && Date.now() - _rhdRes.ts < 120000) return _rhdRes.data;
  if (_rhdRes.inflight) return _rhdRes.inflight;
  _rhdRes.inflight = (async () => {
    const tok = await _vGcsToken();
    const names = []; let pageToken = "";
    do {
      const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${_PZ_BUCKET}/o?prefix=rh-docs/&fields=items(name),nextPageToken${pageToken ? "&pageToken=" + pageToken : ""}`, { headers: { Authorization: `Bearer ${tok}` } });
      if (!r.ok) throw new Error(`Cloud Storage ${r.status}`);
      const j = await r.json();
      (j.items || []).forEach(it => { if (/\/manifest\.json$/.test(it.name)) names.push(it.name); });
      pageToken = j.nextPageToken || "";
    } while (pageToken);
    const out = {};
    await Promise.all(names.map(async n => {
      const emp = n.split("/")[1];
      try { const m = await _rhdGetJson(n); const o = {}; Object.keys(_RHD_KINDS).forEach(k => { if (m[k] && m[k].path) o[k] = true; }); out[emp] = o; } catch (_) {}
    }));
    _rhdRes = { ts: Date.now(), data: out, inflight: null };
    return out;
  })().finally(() => { _rhdRes.inflight = null; });
  return _rhdRes.inflight;
}
app.get("/rh/docs/resumen", async (req, res) => {
  if (!_vOriginOk(req)) return res.status(403).json({ ok: false, error: "Origen no permitido" });
  try { res.set("Cache-Control", "no-store"); res.json({ ok: true, emps: await _rhdResumen(req.query.fresh === "1") }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get("/rh/docs", async (req, res) => {
  if (!_vOriginOk(req)) return res.status(403).json({ ok: false, error: "Origen no permitido" });
  const emp = _rhdEmp(req.query.emp); if (!emp) return res.status(400).json({ ok: false, error: "Falta empleado" });
  try { res.set("Cache-Control", "no-store"); res.json({ ok: true, docs: _rhdPublic(emp, await _rhdGetJson(`rh-docs/${emp}/manifest.json`)) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/rh/docs/upload", async (req, res) => {
  if (!_vOriginOk(req)) return res.status(403).json({ ok: false, error: "Origen no permitido" });
  try {
    const b = req.body || {}, emp = _rhdEmp(b.emp), kind = String(b.kind || "");
    if (!emp || !_RHD_KINDS[kind]) return res.status(400).json({ ok: false, error: "Datos incompletos" });
    const m = String(b.data || "").match(/^data:(image\/(?:png|jpeg|webp|heic|heif)|application\/pdf);base64,(.+)$/);
    if (!m) return res.status(400).json({ ok: false, error: "Solo se aceptan imágenes (JPG, PNG, WebP) o PDF" });
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 15 * 1024 * 1024) return res.status(400).json({ ok: false, error: "El archivo pesa más de 15 MB" });
    const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif", "application/pdf": "pdf" }[m[1]];
    const path = `rh-docs/${emp}/${kind}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
    await _rhdPut(path, buf, m[1]);
    const user = String(b.user || "").slice(0, 80);
    _rhdRes.ts = 0;
    const docs = await _rhdMutate(emp, man => {
      man[kind] = { path, name: String(b.name || `${kind}.${ext}`).slice(0, 120), mime: m[1], size: buf.length, at: new Date().toISOString(), by: user };
      (man._hist = man._hist || []).push({ a: "subió", kind, path, at: man[kind].at, by: user });
      return _rhdPublic(emp, man);
    });
    res.json({ ok: true, docs });
  } catch (e) { console.warn("[rh-docs] upload:", e.message); res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/rh/docs/delete", async (req, res) => {
  if (!_vOriginOk(req)) return res.status(403).json({ ok: false, error: "Origen no permitido" });
  try {
    const b = req.body || {}, emp = _rhdEmp(b.emp), kind = String(b.kind || "");
    if (!emp || !_RHD_KINDS[kind]) return res.status(400).json({ ok: false, error: "Datos incompletos" });
    // El archivo se conserva (bucket versionado); solo se quita del expediente.
    _rhdRes.ts = 0;
    const docs = await _rhdMutate(emp, man => {
      if (man[kind]) (man._hist = man._hist || []).push({ a: "quitó", kind, path: man[kind].path, at: new Date().toISOString(), by: String(b.user || "").slice(0, 80) });
      delete man[kind]; return _rhdPublic(emp, man);
    });
    res.json({ ok: true, docs });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get("/rh/docs/file", async (req, res) => {
  try {
    const emp = _rhdEmp(req.query.emp), kind = String(req.query.kind || "");
    const man = await _rhdGetJson(`rh-docs/${emp}/manifest.json`);
    const d = man[kind];
    if (!d || !d.path || String(req.query.t || "") !== _rhdSig(emp, kind, d.path)) return res.status(404).send("No encontrado");
    const tok = await _vGcsToken();
    const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${_PZ_BUCKET}/o/${encodeURIComponent(d.path)}?alt=media`, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) return res.status(404).send("No encontrado");
    res.set("Content-Type", d.mime || "application/octet-stream");
    res.set("Content-Disposition", `inline; filename="${String(d.name || "documento").replace(/[^\w.\- ]/g, "_")}"`);
    res.set("Cache-Control", "private, max-age=300");
    res.set("X-Robots-Tag", "noindex");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(500).send("Error"); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ║ REGLAS DE CLASIFICACIÓN DE HUÉSPEDES (Directorio › Huéspedes)            ║
// ║ gs://check-in-493804-panel/config/hu-reglas.json — compartidas.         ║
// ═══════════════════════════════════════════════════════════════════════════
const _HUR_OBJ = "config/hu-reglas.json";
const _HUR_KEYS = ["oro", "plata", "bronce", "recurrente", "w_noches", "w_visitas", "w_monto", "ref_noches", "ref_visitas", "ref_monto", "primera_max_visitas", "larga_noches", "mensual_noches"];
app.get("/config/hu-reglas", async (req, res) => {
  try { res.set("Cache-Control", "no-store"); res.json({ ok: true, reglas: await _rhdGetJson(_HUR_OBJ) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/config/hu-reglas", async (req, res) => {
  if (!_vOriginOk(req)) return res.status(403).json({ ok: false, error: "Origen no permitido" });
  try {
    const b = (req.body || {}).reglas || {}, out = {};
    for (const k of _HUR_KEYS) { const v = Number(b[k]); if (isFinite(v) && v >= 0) out[k] = v; }
    out.updated_at = new Date().toISOString(); out.updated_by = String((req.body || {}).user || "").slice(0, 80);
    await _rhdPut(_HUR_OBJ, JSON.stringify(out), "application/json");
    res.json({ ok: true, reglas: out });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ║ PROVEEDORES (Directorio › Proveedores)                                   ║
// ║ gs://check-in-493804-panel/datos/proveedores.json → { items: [...] }     ║
// ═══════════════════════════════════════════════════════════════════════════
const _PRV_OBJ = "datos/proveedores.json";
const _PRV_KEYS = ["Empresa", "Giro", "Contacto", "Puesto", "Telefono", "Whatsapp", "Correo", "Sitio_web", "RFC", "Razon_social", "Direccion", "Banco", "Clabe", "Condiciones_pago", "Estado", "Notas"];
let _prvQ = Promise.resolve();
function _prvMutate(fn) {
  const run = _prvQ.then(async () => {
    const d = await _rhdGetJson(_PRV_OBJ);
    if (!Array.isArray(d.items)) d.items = [];
    const out = fn(d);
    await _rhdPut(_PRV_OBJ, JSON.stringify(d), "application/json");
    return out;
  });
  _prvQ = run.catch(() => {});
  return run;
}
app.get("/proveedores/list", async (req, res) => {
  try { res.set("Cache-Control", "no-store"); const d = await _rhdGetJson(_PRV_OBJ); res.json({ ok: true, items: Array.isArray(d.items) ? d.items : [] }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/proveedores/save", async (req, res) => {
  if (!_vOriginOk(req)) return res.status(403).json({ ok: false, error: "Origen no permitido" });
  try {
    const b = (req.body || {}).item || {}, user = String((req.body || {}).user || "").slice(0, 80);
    const clean = {};
    for (const k of _PRV_KEYS) clean[k] = String(b[k] == null ? "" : b[k]).slice(0, 2000).trim();
    if (!clean.Empresa && !clean.Contacto) return res.status(400).json({ ok: false, error: "Captura el nombre del proveedor o del contacto" });
    const item = await _prvMutate(d => {
      const now = new Date().toISOString();
      let it = b.ID ? d.items.find(x => x.ID === String(b.ID)) : null;
      if (it) Object.assign(it, clean, { updated_at: now, updated_by: user });
      else { it = Object.assign({ ID: "PRV-" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex") }, clean, { created_at: now, created_by: user }); d.items.push(it); }
      return it;
    });
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/proveedores/delete", async (req, res) => {
  if (!_vOriginOk(req)) return res.status(403).json({ ok: false, error: "Origen no permitido" });
  try {
    const id = String((req.body || {}).id || "");
    const n = await _prvMutate(d => { const a = d.items.length; d.items = d.items.filter(x => x.ID !== id); return a - d.items.length; });
    res.json({ ok: true, deleted: n });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ║ ASEO / MOVIMIENTOS DEL DÍA EN (CASI) TIEMPO REAL                          ║
// ║ El snapshot de reservas se actualiza cada ~10 min (sync Apps Script).     ║
// ║ Aquí se consulta Lodgify directo (reservas modificadas en los últimos 3   ║
// ║ días, ~0.5 s) cada minuto y se detectan cambios: cancelación, extensión,  ║
// ║ acortamiento y cambio de fechas → gs://…-panel/aseo/cambios.json.         ║
// ║ Personal asignado por reserva → gs://…-panel/aseo/asignaciones.json.      ║
// ═══════════════════════════════════════════════════════════════════════════
const _ASEO_CAMBIOS_OBJ = "aseo/cambios.json", _ASEO_ASIG_OBJ = "aseo/asignaciones.json";
// Último estado conocido de cada reserva (persistido): si el servidor se reinicia
// (nueva versión, mantenimiento) se compara contra esto y no se pierde ningún cambio.
const _ASEO_BASE_OBJ = "aseo/base.json";
const _aseo = { rows: null, ts: 0, okTs: 0, inflight: null, prev: null, cambios: null, asig: null, err: "", baseSavedTs: 0 };
const _aseoQ = {};
function _aseoMutate(obj, key, fn) {
  const prev = _aseoQ[obj] || Promise.resolve();
  const run = prev.then(async () => {
    const d = await _rhdGetJson(obj);
    const out = fn(d);
    await _rhdPut(obj, JSON.stringify(d), "application/json");
    _aseo[key] = d;
    return out;
  });
  _aseoQ[obj] = run.catch(() => {});
  return run;
}
function _aseoLiveRow(b) {
  const g = b.guest || {};
  let src = String(b.source || "");
  const st = String(b.source_text || "");
  if (/airbnb/i.test(src + st) || (st.startsWith("{") && st.includes("listingId"))) src = "Airbnb";
  else if (/booking/i.test(src + st)) src = "Booking.com";
  else if (/vrbo|homeaway/i.test(src + st)) src = "Vrbo";
  else if (/expedia/i.test(src + st)) src = "Expedia";
  else if (/manual/i.test(src)) src = "Manual";
  else if (!src || /lodgify|website|direct/i.test(src)) src = "Direct";
  return {
    Id: Number(b.id), Status: String(b.status || ""), DateArrival: String(b.arrival || "").slice(0, 10), DateDeparture: String(b.departure || "").slice(0, 10),
    HouseId: b.property_id, GuestName: g.name || "", GuestPhone: g.phone || "", GuestEmail: g.email || "", Source: src,
    TotalAmount: Number(b.total_amount) || 0, AmountPaid: Number(b.amount_paid) || 0, AmountDue: Number(b.amount_due) || 0,
    DateCancelled: b.canceled_at || "", UpdatedAt: b.updated_at || "", Deleted: !!b.is_deleted,
  };
}
const _aseoViva = s => /^(booked|tentative)$/i.test(String(s || ""));
async function _aseoLiveLoad() {
  if (_aseo.inflight) return _aseo.inflight;
  _aseo.inflight = (async () => {
    try {
      const apiKey = process.env.LODGIFY_API_KEY;
      if (!apiKey) throw new Error("LODGIFY_API_KEY faltante");
      const since = _todayIso(-7);
      const items = [];
      for (let page = 1; page <= 10; page++) {
        const r = await fetch(`https://api.lodgify.com/v2/reservations/bookings?stayFilter=All&page=${page}&size=100&includeCount=false&updatedSince=${since}T00:00:00`,
          { headers: { "X-ApiKey": apiKey, accept: "application/json" } });
        if (!r.ok) throw new Error(`Lodgify ${r.status}`);
        const j = await r.json();
        const it = Array.isArray(j.items) ? j.items : [];
        items.push(...it);
        if (it.length < 100) break;
      }
      const rows = items.map(_aseoLiveRow).filter(x => x.Id);
      // La copia completa (snapshot) sirve de respaldo para reservas que no estén en la línea base.
      if (!_lgSnap.payload) { try { await _lgSnapRefresh('aseo-base'); } catch (_) {} }
      const snapPrev = new Map();
      ((_lgSnap.payload && _lgSnap.payload.bookings) || []).forEach(b => {
        if (b && b.Id) snapPrev.set(Number(b.Id), { Status: String(b.Status || ""), DateArrival: _lgIso(b.DateArrival), DateDeparture: _lgIso(b.DateDeparture) });
      });
      // Línea base para comparar: la consulta anterior; tras un reinicio, el último
      // estado guardado en Cloud Storage; si no existe, el snapshot.
      let base = _aseo.prev;
      if (!base) {
        try {
          const g = await _rhdGetJson(_ASEO_BASE_OBJ);
          if (g && g.rows && Object.keys(g.rows).length) {
            base = new Map(Object.entries(g.rows).map(([id, v]) => [Number(id), { Status: v[0], DateArrival: v[1], DateDeparture: v[2] }]));
            console.log(`[aseo] línea base restaurada de Cloud Storage (${base.size} reservas, guardada ${g.ts})`);
          }
        } catch (e) { console.warn("[aseo] no se pudo leer la línea base:", e.message); }
      }
      if (!base) base = new Map(snapPrev);
      const nuevos = [];
      const now = new Date().toISOString();
      for (const x of rows) {
        const o = base.get(x.Id) || snapPrev.get(x.Id); if (!o) continue;
        let tipo = "";
        if (_aseoViva(o.Status) && !_aseoViva(x.Status) && /declin|cancel/i.test(x.Status)) tipo = "cancelada";
        else if (_aseoViva(x.Status) && o.DateArrival && o.DateDeparture && x.DateArrival && x.DateDeparture) {
          if (o.DateArrival !== x.DateArrival) tipo = "reprogramada";
          else if (x.DateDeparture > o.DateDeparture) tipo = "extendida";
          else if (x.DateDeparture < o.DateDeparture) tipo = "acortada";
        }
        if (tipo) nuevos.push({ id: String(x.Id), tipo, antes: { arr: o.DateArrival, dep: o.DateDeparture, st: o.Status }, ahora: { arr: x.DateArrival, dep: x.DateDeparture, st: x.Status }, at: now, huesped: x.GuestName });
      }
      const next = new Map(base);
      let difiere = false;
      rows.forEach(x => {
        const o = next.get(x.Id);
        if (!o || o.Status !== x.Status || o.DateArrival !== x.DateArrival || o.DateDeparture !== x.DateDeparture) difiere = true;
        next.set(x.Id, { Status: x.Status, DateArrival: x.DateArrival, DateDeparture: x.DateDeparture });
      });
      _aseo.prev = next;
      Object.assign(_aseo, { rows, ts: Date.now(), okTs: Date.now(), err: "" });
      // Persiste la línea base (solo reservas recientes/futuras) cuando cambia algo o cada 10 min.
      if (difiere || Date.now() - _aseo.baseSavedTs > 10 * 60_000) {
        const lim = _todayIso(-15), out = {};
        next.forEach((v, id) => { if (!v.DateDeparture || v.DateDeparture >= lim) out[id] = [v.Status, v.DateArrival, v.DateDeparture]; });
        _aseo.baseSavedTs = Date.now();
        _rhdPut(_ASEO_BASE_OBJ, JSON.stringify({ ts: new Date().toISOString(), rows: out }), "application/json")
          .catch(e => { _aseo.baseSavedTs = 0; console.warn("[aseo] línea base no guardada:", e.message); });
      }
      if (nuevos.length) {
        console.log(`[aseo] cambios: ${nuevos.map(c => c.id + ":" + c.tipo).join(", ")}`);
        const lim = Date.now() - 21 * 864e5;
        await _aseoMutate(_ASEO_CAMBIOS_OBJ, "cambios", d => {
          for (const k of Object.keys(d)) if (!Array.isArray(d[k]) || !d[k].length || Date.parse(d[k][d[k].length - 1].at) < lim) delete d[k];
          // Sin duplicados (p. ej. dos instancias del servidor detectando lo mismo durante un cambio de versión).
          nuevos.forEach(c => {
            const l = d[c.id] = d[c.id] || [], u = l[l.length - 1];
            if (u && u.tipo === c.tipo && JSON.stringify(u.ahora) === JSON.stringify(c.ahora)) return;
            l.push(c);
          });
        }).catch(e => console.warn("[aseo] cambios no guardados:", e.message));
      }
    } catch (e) { _aseo.err = e.message; _aseo.ts = Date.now(); console.warn("[aseo] live:", e.message); }
    return _aseo.rows;
  })().finally(() => { _aseo.inflight = null; });
  return _aseo.inflight;
}
setInterval(() => { _aseoLiveLoad().catch(() => {}); }, 60_000);
setTimeout(() => { _aseoLiveLoad().catch(() => {}); }, 15_000);
app.get("/aseo/live", async (req, res) => {
  try {
    // ?force=1 (botón "Actualizar"): consulta Lodgify y Cloud Storage en este momento.
    const force = req.query.force === "1" && Date.now() - (_aseo.forceTs || 0) > 3000;
    if (force) { _aseo.forceTs = Date.now(); _aseo.cambiosTs = 0; _aseo.asigTs = 0; _aseo.estadosTs = 0; if (_aseo.inflight) await _aseo.inflight; }
    if (force || !_aseo.rows || Date.now() - _aseo.ts > 20_000) await _aseoLiveLoad();
    if (!_aseo.cambios || Date.now() - (_aseo.cambiosTs || 0) > 60_000) { _aseo.cambios = await _rhdGetJson(_ASEO_CAMBIOS_OBJ).catch(() => _aseo.cambios || {}); _aseo.cambiosTs = Date.now(); }
    if (!_aseo.asig || Date.now() - (_aseo.asigTs || 0) > 30_000) { _aseo.asig = await _rhdGetJson(_ASEO_ASIG_OBJ).catch(() => _aseo.asig || {}); _aseo.asigTs = Date.now(); }
    res.set("Cache-Control", "no-store");
    if (!_aseo.estados || Date.now() - (_aseo.estadosTs || 0) > 15_000) { _aseo.estados = await _rhdGetJson(_ASEO_ESTADOS_OBJ).catch(() => _aseo.estados || {}); _aseo.estadosTs = Date.now(); }
    let guias = {}; try { guias = _aseoGuiasTodas(); } catch (e) { console.warn("[aseo] guías:", e.message); }
    if (!_aseo.temprana || Date.now() - (_aseo.tempTs || 0) > 30_000) { _aseo.temprana = await _rhdGetJson(_ASEO_TEMP_OBJ).catch(() => _aseo.temprana || {}); _aseo.tempTs = Date.now(); }
    if (!_aseo.sms || Date.now() - (_aseo.smsTs || 0) > 30_000) { _aseo.sms = await _rhdGetJson(_ASEO_SMS_OBJ).catch(() => _aseo.sms || {}); _aseo.smsTs = Date.now(); }
    if (!_aseo.tardia || Date.now() - (_aseo.tardTs || 0) > 30_000) { _aseo.tardia = await _rhdGetJson(_ASEO_TARD_OBJ).catch(() => _aseo.tardia || {}); _aseo.tardTs = Date.now(); }
    res.json({ tardia: _aseo.tardia || {}, ok: true, ts: _aseo.okTs, now: Date.now(), err: _aseo.err, rows: _aseo.rows || [], cambios: _aseo.cambios || {}, asig: _aseo.asig || {}, estados: _aseo.estados || {}, guias,
      temprana: _aseo.temprana || {}, sms: _aseo.sms || {} });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/aseo/asignar", async (req, res) => {
  if (!_vOriginOk(req)) return res.status(403).json({ ok: false, error: "Origen no permitido" });
  try {
    const id = String((req.body || {}).id || "").replace(/[^\w-]/g, "").slice(0, 40);
    if (!id) return res.status(400).json({ ok: false, error: "Falta id" });
    // Dos roles por reserva: personal de aseo y personal de inspección.
    const rol = String(req.body.rol || "aseo") === "inspeccion" ? "inspeccion" : "aseo";
    const personal = (Array.isArray(req.body.personal) ? req.body.personal : []).map(n => String(n || "").trim().slice(0, 80)).filter(Boolean).slice(0, 20);
    const user = String(req.body.user || "").slice(0, 80);
    const out = await _aseoMutate(_ASEO_ASIG_OBJ, "asig", d => {
      const cur = d[id] || {};
      if (cur.personal && !cur.aseo) cur.aseo = cur.personal; // formato anterior → aseo
      delete cur.personal;
      cur[rol] = personal;
      if (!(cur.aseo || []).length && !(cur.inspeccion || []).length) { delete d[id]; return null; }
      Object.assign(cur, { by: user, at: new Date().toISOString() });
      d[id] = cur;
      return cur;
    });
    res.json({ ok: true, asig: out });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─── Estado de aseo por salida (reserva que sale) ───────────────────────────
// Etapas en orden: en_proceso → terminado → inspeccionado (= listo para recibir
// huéspedes). Marcar una etapa completa las anteriores; regresar borra las posteriores.
const _ASEO_ESTADOS_OBJ = "aseo/estados.json";
const _ASEO_ETAPAS = ["en_proceso", "terminado", "inspeccionado"];
const _ASEO_ETQ = { pendiente: "Aseo pendiente", en_proceso: "Aseo en proceso", terminado: "Aseo terminado", inspeccionado: "Inspeccionado · listo para recibir huéspedes" };
const _mxHoy = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Monterrey" });
// Dos pasos: (1) se ELIGE el estado (combobox) → queda sin validar; (2) se VALIDA con
// la palomita → solo entonces se publica (campo `pub`, el que leen las guías).
// Registros anteriores a este esquema (sin `validado`) cuentan como publicados.
function _aseoPub(reg) {
  if (!reg) return null;
  if (reg.validado === undefined) return reg.estado ? { estado: reg.estado, at: reg.at, by: reg.by } : null;
  return reg.pub || null;
}
// Guarda el estado de aseo de una salida. Solo "terminado" requiere validación;
// "en_proceso", "inspeccionado" y "pendiente" se publican directo.
async function _aseoGuardarEstado({ id, hid, estado, validar, user }) {
  validar = !!validar || estado !== "terminado";
  const now = new Date().toISOString();
  const out = await _aseoMutate(_ASEO_ESTADOS_OBJ, "estados", d => {
    const cur = d[id] || { hist: {} };
    if (cur.validado === undefined && cur.estado) { cur.validado = true; cur.pub = { estado: cur.estado, at: cur.at, by: cur.by }; }
    cur.hist = cur.hist || {};
    // Si esa etapa (o una posterior) ya se validó antes, se conserva validada: no se pierde
    // la validación por volver a reportar "terminado" (card, bot y guía quedan iguales).
    if (!validar && cur.pub && _ASEO_ETAPAS.indexOf(cur.pub.estado) >= _ASEO_ETAPAS.indexOf(estado)) {
      Object.assign(cur, { estado, at: now, by: user || "", hid: hid || cur.hid || "", validado: true });
      d[id] = cur;
      return cur;
    }
    Object.assign(cur, { estado, at: now, by: user || "", hid: hid || cur.hid || "", validado: validar });
    if (validar) {
      // Validar publica el estado; las etapas previas quedan registradas, las posteriores se borran.
      const n = _ASEO_ETAPAS.indexOf(estado);
      _ASEO_ETAPAS.forEach((e, i) => { if (i <= n) { if (!cur.hist[e]) cur.hist[e] = { at: now, by: user || "" }; } else delete cur.hist[e]; });
      if (estado === "pendiente") delete cur.pub; else cur.pub = { estado, at: now, by: user || "" };
    }
    if (estado === "pendiente" && !cur.pub) { delete d[id]; return null; }
    d[id] = cur;
    return cur;
  });
  _aseo.estadosTs = Date.now();
  return out;
}
// Agrega a una persona al rol (aseo | inspeccion) de la reserva, sin quitar a los demás.
async function _aseoAsignarRol(id, rol, nombre, user) {
  if (!nombre) return null;
  return _aseoMutate(_ASEO_ASIG_OBJ, "asig", d => {
    const cur = d[id] || {};
    if (cur.personal && !cur.aseo) cur.aseo = cur.personal;
    delete cur.personal;
    const l = Array.isArray(cur[rol]) ? cur[rol] : [];
    if (!l.includes(nombre)) l.push(nombre);
    cur[rol] = l;
    Object.assign(cur, { by: user || "", at: new Date().toISOString() });
    d[id] = cur;
    return cur;
  });
}
// Reserva cuya salida corresponde al aseo de un alojamiento: la que sale HOY o, si no, la última que salió.
async function _aseoTurnover(hid) {
  if (!_aseo.rows || Date.now() - _aseo.ts > 30_000) await _aseoLiveLoad();
  const hoy = _mxHoy(), m = new Map();
  ((_lgSnap.payload && _lgSnap.payload.bookings) || []).forEach(b => { if (b && String(b.HouseId) === String(hid)) m.set(String(b.Id), { Status: String(b.Status || ""), dep: _lgIso(b.DateDeparture), arr: _lgIso(b.DateArrival), guest: b.GuestName || "" }); });
  (_aseo.rows || []).forEach(x => { if (String(x.HouseId) === String(hid)) m.set(String(x.Id), { Status: x.Status, dep: x.DateDeparture, arr: x.DateArrival, guest: x.GuestName || (m.get(String(x.Id)) || {}).guest || "" }); });
  let ult = null;
  m.forEach((v, id) => { if (_aseoViva(v.Status) && v.dep && v.dep <= hoy && (!ult || v.dep > ult.dep)) ult = { id, ...v }; });
  return ult;
}
// ── Búsqueda tolerante de alojamientos: "cu2", "CU 2", "cumbres 2", "Calle Cumbres #2",
//    "jose cardenas 2", "jc2", "oaxaca1", "oaxca 1" (errores de dedo), "cu4a"…
function _aseoLev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
async function _aseoCatalogo() {
  const pl = await _alojGetPayload().catch(() => null);
  return ((pl && pl.rows) || []).map(r => {
    const prop = String(r.Propiedad || "").trim(), dep = String(r["# Departamento"] || "").trim().replace(/^#\s*/, "");
    const code = String(r.device_name || r.Device_name || "").trim();
    const hid = String(r.HouseId || r.id_lodgify || "").replace(/\D/g, "");
    const pn = _botNorm(prop).replace(/^(calle|av|avenida|plaza|privada)\s+/, "");
    return { prop, dep: dep.toLowerCase(), code: code.toLowerCase(), hid, nombre: `${prop} #${dep}`,
      pref: code.toLowerCase().replace(/[0-9].*$/, ""), pn: pn.replace(/\s+/g, ""), words: pn.split(" ").filter(Boolean),
      ini: pn.split(" ").filter(Boolean).map(w => w[0]).join("") };
  }).filter(x => x.prop && x.dep);
}
function _aseoMatchAloj(q, cat) {
  let t = _botNorm(q).replace(/\b(calle|plaza|av|avenida|privada|depto|departamento|dpto|numero|num|no|el|la|del|de|alojamiento|depa)\b/g, " ").replace(/\s+/g, " ").trim();
  // número de depto al final (acepta "4 a" → "4a")
  const mm = t.match(/(\d+)\s*([a-z])?$/);
  if (!mm) return { ok: false, error: `No identifiqué el número de departamento en "${q}"` };
  const dep = (mm[1] + (mm[2] || "")).toLowerCase();
  const p = t.slice(0, mm.index).replace(/\s+/g, "");
  if (!p) return { ok: false, error: `No identifiqué la propiedad en "${q}"` };
  const score = c => {
    if (p === c.pref || p === c.pn || p === c.ini) return 0;
    if (p.length >= 3 && (c.pn.startsWith(p) || c.words.some(w => w.startsWith(p)))) return 0.2;
    if (p.length >= 4 && c.words.some(w => _aseoLev(p, w) <= 1)) return 0.4;
    const d = Math.min(_aseoLev(p, c.pn), ...c.words.map(w => _aseoLev(p, w)));
    const rel = d / Math.max(p.length, 1);
    if (p.length >= 4 && rel <= 0.34) return 0.5 + rel;
    if (p.length <= 3 && (_aseoLev(p, c.pref) <= 1 && p[0] === c.pref[0])) return 0.8;
    return 9;
  };
  const props = new Map();
  cat.forEach(c => { const k = c.prop; if (!props.has(k)) props.set(k, score(c)); });
  const best = Math.min(...props.values());
  if (best >= 9) return { ok: false, error: `No reconozco la propiedad de "${q}"` };
  const top = [...props.entries()].filter(([, v]) => v === best).map(([k]) => k);
  const cands = cat.filter(c => top.includes(c.prop) && c.dep === dep);
  if (!cands.length) {
    const sug = cat.filter(c => top.includes(c.prop) && c.dep.startsWith(dep)).map(c => c.code.toUpperCase());
    return { ok: false, error: `${top.join(" / ")} no tiene el departamento ${dep.toUpperCase()}${sug.length ? ` — ¿${sug.join(" o ")}?` : ""}` };
  }
  if (cands.length > 1) return { ok: false, ambiguo: cands.map(c => `${c.nombre} (${c.code.toUpperCase()})`), error: `"${q}" puede ser: ${cands.map(c => c.nombre).join(" o ")}` };
  return { ok: true, aloj: cands[0], seguro: best <= 0.2 };
}
// ── Resumen de limpiezas de HOY (mismas cards que Control de aseo › Por alojamiento):
// salidas de hoy, entradas sin salida y alojamientos con estado actualizado hoy. Solo Booked.
async function _aseoResumenHoy() {
  if (!_aseo.rows || Date.now() - _aseo.ts > 20_000) await _aseoLiveLoad();
  if (!_aseo.estados || Date.now() - (_aseo.estadosTs || 0) > 15_000) { _aseo.estados = await _rhdGetJson(_ASEO_ESTADOS_OBJ).catch(() => _aseo.estados || {}); _aseo.estadosTs = Date.now(); }
  if (!_aseo.asig || Date.now() - (_aseo.asigTs || 0) > 30_000) { _aseo.asig = await _rhdGetJson(_ASEO_ASIG_OBJ).catch(() => _aseo.asig || {}); _aseo.asigTs = Date.now(); }
  if (!_aseo.temprana || Date.now() - (_aseo.tempTs || 0) > 30_000) { _aseo.temprana = await _rhdGetJson(_ASEO_TEMP_OBJ).catch(() => _aseo.temprana || {}); _aseo.tempTs = Date.now(); }
  if (!_aseo.tardia || Date.now() - (_aseo.tardTs || 0) > 30_000) { _aseo.tardia = await _rhdGetJson(_ASEO_TARD_OBJ).catch(() => _aseo.tardia || {}); _aseo.tardTs = Date.now(); }
  const hoy = _mxHoy();
  const bk = new Map();
  ((_lgSnap.payload && _lgSnap.payload.bookings) || []).forEach(b => { if (b && b.Id) bk.set(String(b.Id), { id: String(b.Id), st: String(b.Status || ""), arr: _lgIso(b.DateArrival), dep: _lgIso(b.DateDeparture), hid: String(b.HouseId || ""), guest: b.GuestName || "" }); });
  (_aseo.rows || []).forEach(x => { const o = bk.get(String(x.Id)) || {}; bk.set(String(x.Id), { id: String(x.Id), st: x.Status, arr: x.DateArrival, dep: x.DateDeparture, hid: String(x.HouseId || ""), guest: x.GuestName || o.guest || "" }); });
  const booked = [...bk.values()].filter(b => /^booked$/i.test(b.st) && b.hid);
  const cat = await _aseoCatalogo();
  const porHid = new Map(cat.map(c => [c.hid, c]));
  const casas = new Map(); // hid → { sal, ent, estId }
  const casa = hid => { if (!casas.has(hid)) casas.set(hid, { hid, sal: null, ent: null, estId: "" }); return casas.get(hid); };
  booked.filter(b => b.dep === hoy).forEach(b => { const c = casa(b.hid); c.sal = b; c.estId = b.id; });
  booked.filter(b => b.arr === hoy).forEach(b => { const c = casa(b.hid); if (!c.ent) c.ent = b; });
  const turnover = hid => { let u = null; booked.forEach(b => { if (b.hid === hid && b.dep && b.dep <= hoy && (!u || b.dep > u.dep)) u = b; }); return u ? u.id : "H" + hid; };
  casas.forEach(c => { if (!c.estId) c.estId = turnover(c.hid); });
  // Estado actualizado hoy sin salida/entrada hoy
  Object.entries(_aseo.estados || {}).forEach(([id, r]) => {
    if (!r || !r.hid || !r.at) return;
    if (new Date(r.at).toLocaleDateString("en-CA", { timeZone: "America/Monterrey" }) !== hoy || casas.has(String(r.hid))) return;
    const c = casa(String(r.hid)); c.estId = id;
  });
  const horaMx = Number(new Date().toLocaleString("en-US", { timeZone: "America/Monterrey", hour: "numeric", hour12: false })) % 24;
  const limpia = n => String(n || "").replace(/\s*\(WhatsApp\)\s*$/, "").trim();
  const items = [...casas.values()].map(c => {
    const a = porHid.get(c.hid);
    const r = (_aseo.estados || {})[c.estId] || null;
    const pub = _aseoPub(r);
    const sel = r ? r.estado : "pendiente";
    const as = (_aseo.asig || {})[c.estId] || {};
    const aseoP = (as.aseo || as.personal || []).join(", ") || limpia(r && r.hist && (r.hist.terminado || r.hist.en_proceso) && (r.hist.terminado || r.hist.en_proceso).by);
    const inspP = (as.inspeccion || []).join(", ") || limpia(r && r.hist && r.hist.inspeccionado && r.hist.inspeccionado.by);
    let estado = { pendiente: "⏳ Pendiente", en_proceso: "🧽 En proceso", terminado: "🧹 Terminado", inspeccionado: "✅ Inspeccionado" }[sel] || sel;
    // "(validado)" se refiere al ÚLTIMO registro, no a una validación anterior que siga publicada.
    if (sel === "terminado") estado += (r && (r.validado === undefined || r.validado)) ? " (validado)" : " (sin validar)";
    let aviso = "";
    if (c.sal && c.ent && sel === "pendiente" && horaMx >= 14) aviso = "🚨 Urge validación";
    else if (!c.sal && c.ent && !(pub && /^(terminado|inspeccionado)$/.test(pub.estado))) aviso = "⚠️ Requiere validación";
    return { code: a ? a.code.toUpperCase() : "", nombre: a ? a.nombre : `Alojamiento ${c.hid}`, entra: !!c.ent, sale: !!c.sal, estado, sel, aviso, aseo: aseoP, insp: inspP,
      temprana: !!(c.ent && ((_aseo.temprana || {})[c.ent.id] || {}).on),
      tempAceptada: !!(c.ent && ((_aseo.temprana || {})[c.ent.id] || {}).aceptada),
      tardia: (c.sal && ((_aseo.tardia || {})[c.sal.id] || {}).on) ? ((_aseo.tardia || {})[c.sal.id]) : null,
      aseoArr: (as.aseo || as.personal || []).slice(), inspArr: (as.inspeccion || []).slice(),
      salio: c.sal ? c.sal.guest : "", entra_huesped: c.ent ? c.ent.guest : "" };
  });
  const ordenE = { pendiente: 0, en_proceso: 1, terminado: 2, inspeccionado: 3 };
  const tardA = i => (i.tardia && i.tardia.aceptada) ? 1 : 0;
  items.sort((x, y) => (y.tempAceptada - x.tempAceptada) || (tardA(x) - tardA(y)) || (y.entra - x.entra) || (y.temprana - x.temprana) || ((ordenE[x.sel] ?? 0) - (ordenE[y.sel] ?? 0)) || String(x.code || x.nombre).localeCompare(String(y.code || y.nombre), "es", { numeric: true }));
  const fecha = new Date(hoy + "T12:00:00").toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });
  // Marca de prioridad "✱" (un "* " al inicio de renglón WhatsApp lo convierte en viñeta).
  const lineas = [`🧽 *Limpiezas de hoy* — ${fecha.charAt(0).toUpperCase() + fecha.slice(1)}`, `${items.length} alojamiento${items.length === 1 ? "" : "s"} · ${items.filter(i => i.entra).length} con entrada hoy (✱)`, ""];
  items.forEach((i, n) => {
    lineas.push(`${i.entra ? "✱ " : ""}${n + 1}. ${i.code ? i.code + " · " : ""}${i.nombre}${i.entra ? " — 🔑 Entran hoy" : ""}${i.tempAceptada ? " · *PRIORITARIA*" : ""}`);
    if (i.temprana) lineas.push(`   ⏰ *ENTRADA TEMPRANA* — prioridad${i.tempAceptada ? " (solicitud aceptada ✓)" : ""}`);
    if (i.tardia) lineas.push(`   🕚 Salida tardía ${i.tardia.hora || "11:00"} h${i.tardia.aceptada ? " (aceptada ✓ · su aseo va al final)" : " (solicitud)"}`);
    lineas.push(`   ${i.estado}${i.aviso ? " · " + i.aviso : ""}`);
    lineas.push(`   🧹 Aseo: ${i.aseo || "—"} · 🔍 Inspección: ${i.insp || "—"}`);
  });
  if (!items.length) lineas.push("No hay salidas ni entradas hoy.");
  return { fecha: hoy, total: items.length, items, formatted_message: lineas.join("\n") };
}
// ¿Es la misma persona? (nombre del registro de asistencia vs nombre asignado en la card)
function _aseoMismaPersona(a, b) {
  const ta = _botNorm(a).split(" ").filter(t => t.length > 1), tb = _botNorm(b).split(" ").filter(t => t.length > 1);
  if (!ta.length || !tb.length) return false;
  const [cortos, largos] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return cortos.every(t => largos.includes(t));
}
// Lista de limpiezas/inspecciones de HOY asignadas a un empleado (null si no tiene).
function _aseoMiasDe(r, nombre) {
  return r.items.map(i => ({ ...i, roles: [i.aseoArr.some(n => _aseoMismaPersona(n, nombre)) ? "Aseo" : "", i.inspArr.some(n => _aseoMismaPersona(n, nombre)) ? "Inspección" : ""].filter(Boolean) }))
    .filter(i => i.roles.length);
}
async function _aseoListaEmpleado(nombre, opts) {
  const r = (opts && opts.resumen) || await _aseoResumenHoy();
  const mias = _aseoMiasDe(r, nombre);
  if (!mias.length) return null;
  const pila = String(nombre || "").split(" ")[0];
  const l = [`🧽 *${pila}, tus limpiezas de hoy* (${mias.length})`, mias.some(i => i.entra) ? "✱ = entra huésped hoy (prioridad)" : "", ""];
  mias.forEach((i, n) => {
    l.push(`${i.entra ? "✱ " : ""}${n + 1}. ${i.code ? i.code + " · " : ""}${i.nombre}${i.entra ? " — 🔑 Entran hoy" : ""}${i.tempAceptada ? " · *PRIORITARIA*" : ""}`);
    if (i.temprana) l.push(`   ⏰ *ENTRADA TEMPRANA* — prioridad${i.tempAceptada ? " (solicitud aceptada ✓)" : ""}`);
    if (i.tardia) l.push(`   🕚 Salida tardía ${i.tardia.hora || "11:00"} h${i.tardia.aceptada ? " (aceptada ✓ · su aseo va al final)" : " (solicitud)"}`);
    l.push(`   ${i.estado}${i.aviso ? " · " + i.aviso : ""}`);
    l.push(`   Tipo de tarea: ${i.roles.join(" e ")}`);
  });
  l.push("", `Para actualizar escribe, por ejemplo: «${mias[0].code || "CU2"} listo» o «${mias[0].code || "CU2"} inspeccionado».`);
  return l.filter((x, k) => x !== "" || k > 0).join("\n");
}
// ── Registro de lo ENVIADO a cada persona hoy (para "Notificar actualizaciones") ──
// gs://…-panel/aseo/notificados.json → { fecha, personas: { <nombre>: { items:[{code,roles}], at } } }
const _ASEO_NOTIF_OBJ = "aseo/notificados.json";
const _aseoSig = it => `${it.code || it.nombre}:${[...(it.roles || [])].sort().join("+")}`;
async function _aseoNotifLeer() {
  const d = await _rhdGetJson(_ASEO_NOTIF_OBJ).catch(() => ({}));
  return d && d.fecha === _mxHoy() ? d : { fecha: _mxHoy(), personas: {} };
}
async function _aseoNotifGuardar(nombre, items) {
  return _aseoMutate(_ASEO_NOTIF_OBJ, "notif", d => {
    if (d.fecha !== _mxHoy()) { d.fecha = _mxHoy(); d.personas = {}; }
    d.personas = d.personas || {};
    // Una sola entrada por persona aunque el nombre venga escrito distinto.
    const k = Object.keys(d.personas).find(x => _aseoMismaPersona(x, nombre)) || nombre;
    d.personas[k] = { items: items.map(i => ({ code: i.code || i.nombre, nombre: i.nombre, roles: i.roles, temprana: !!i.temprana })), at: new Date().toISOString() };
  });
}
// Envía la lista del día a un empleado y registra lo enviado.
async function _aseoEnviarLista(nombre, to, phone10, auto) {
  const r = await _aseoResumenHoy();
  const mias = _aseoMiasDe(r, nombre);
  if (!mias.length) return false;
  const txt = await _aseoListaEmpleado(nombre, { resumen: r });
  await _twilioSendMessage({ to, body: txt, skipMirror: true });
  _botAppendMessage(phone10, "assistant", txt, { staff: true, auto });
  await _aseoNotifGuardar(nombre, mias).catch(() => {});
  return true;
}
// Celulares del Personal activo (nombre completo → 10 dígitos).
async function _aseoTelPersonal() {
  const r = await callCheckinAppsScript("list_personal");
  return ((r && r.rows) || []).filter(x => !x.Estado || /activo/i.test(String(x.Estado))).map(x => {
    const nom = String(x.Nombre || "").trim(), ap = String(x.Apellido_paterno || "").trim(), am = String(x.Apellido_materno || "").trim();
    const n = _botNorm(nom);
    const nombre = ((!ap || n.includes(_botNorm(ap))) && (!am || n.includes(_botNorm(am)))) ? nom : [nom, ap, am].filter(Boolean).join(" ");
    const tel = String(x.Celular || x.Telefono || "").replace(/\D/g, "").slice(-10);
    return { nombre: nombre.replace(/\s+/g, " ").trim(), tel: tel.length === 10 ? tel : "" };
  }).filter(x => x.nombre);
}
// Cambios de asignación por persona desde el último envío de hoy.
async function _aseoCambiosAsignacion() {
  const [r, notif, tels] = await Promise.all([_aseoResumenHoy(), _aseoNotifLeer(), _aseoTelPersonal().catch(() => [])]);
  const nombres = new Map(); // persona canónica → items actuales
  r.items.forEach(i => [...i.aseoArr, ...i.inspArr].forEach(n => { if (n && ![...nombres.keys()].some(k => _aseoMismaPersona(k, n))) nombres.set(n, null); }));
  Object.keys(notif.personas || {}).forEach(n => { if (![...nombres.keys()].some(k => _aseoMismaPersona(k, n))) nombres.set(n, null); });
  const out = [];
  for (const nombre of nombres.keys()) {
    const ahora = _aseoMiasDe(r, nombre);
    const kPrev = Object.keys(notif.personas || {}).find(x => _aseoMismaPersona(x, nombre));
    const antes = kPrev ? notif.personas[kPrev].items || [] : [];
    const sA = new Set(antes.map(_aseoSig)), sN = new Set(ahora.map(_aseoSig));
    const agregados = ahora.filter(i => !sA.has(_aseoSig(i))).map(i => `${i.code || i.nombre} (${i.roles.join(" e ")})${i.temprana ? " ⏰" : ""}`);
    const quitados = antes.filter(i => !sN.has(_aseoSig(i))).map(i => `${i.code || i.nombre} (${(i.roles || []).join(" e ")})`);
    // Cambio de prioridad: se marcó/desmarcó "Entrada temprana" en algo que ya tenía asignado.
    const temprana = ahora.filter(i => { const p = antes.find(a => _aseoSig(a) === _aseoSig(i)); return p && !!p.temprana !== !!i.temprana; })
      .map(i => `${i.code || i.nombre}${i.temprana ? " ahora con ⏰ entrada temprana" : " ya sin entrada temprana"}`);
    if (!agregados.length && !quitados.length && !temprana.length) continue;
    const t = tels.find(x => _aseoMismaPersona(x.nombre, nombre));
    out.push({ persona: nombre, tel: t ? t.tel : "", primerEnvio: !kPrev, agregados, quitados, temprana, total: ahora.length });
  }
  return { resumen: r, cambios: out.sort((a, b) => a.persona.localeCompare(b.persona, "es")) };
}
// ── Entrada temprana (por reserva) y SMS "tu alojamiento está listo" ──────────
const _ASEO_TEMP_OBJ = "aseo/temprana.json", _ASEO_SMS_OBJ = "aseo/sms.json", _ASEO_TARD_OBJ = "aseo/tardia.json";
// Salida tardía (por reserva que sale): { on, hora "HH:MM", aceptada, … }. Aceptada → su aseo va al final.
app.post("/aseo/tardia", async (req, res) => {
  if (!_vOriginOk(req)) return res.status(403).json({ ok: false, error: "Origen no permitido" });
  try {
    const b = req.body || {};
    const id = String(b.id || "").replace(/[^\w-]/g, "").slice(0, 40);
    if (!id) return res.status(400).json({ ok: false, error: "Falta id" });
    const on = !!b.on, user = String(b.user || "").slice(0, 80);
    const hora = /^\d{2}:\d{2}$/.test(String(b.hora || "")) ? String(b.hora) : "";
    const out = await _aseoMutate(_ASEO_TARD_OBJ, "tardia", d => {
      if (!on) { delete d[id]; return null; }
      const cur = d[id] || { on: true, hora: "11:00", by: user, at: new Date().toISOString() };
      cur.on = true;
      if (hora) cur.hora = hora;
      if (b.aceptada === true) Object.assign(cur, { aceptada: true, aceptadaPor: user, aceptadaAt: new Date().toISOString() });
      else if (b.aceptada === false) { delete cur.aceptada; delete cur.aceptadaPor; delete cur.aceptadaAt; }
      d[id] = cur; return cur;
    });
    _aseo.tardTs = Date.now();
    res.json({ ok: true, tardia: out });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/aseo/temprana", async (req, res) => {
  if (!_vOriginOk(req)) return res.status(403).json({ ok: false, error: "Origen no permitido" });
  try {
    const id = String((req.body || {}).id || "").replace(/[^\w-]/g, "").slice(0, 40);
    if (!id) return res.status(400).json({ ok: false, error: "Falta id" });
    const on = !!req.body.on, user = String(req.body.user || "").slice(0, 80);
    // aceptada: true/false = el admin aceptó (o retiró la aceptación de) la solicitud del huésped.
    const acep = req.body.aceptada;
    const out = await _aseoMutate(_ASEO_TEMP_OBJ, "temprana", d => {
      if (!on) { delete d[id]; return null; }
      const cur = d[id] || { on: true, by: user, at: new Date().toISOString() };
      cur.on = true;
      if (acep === true) Object.assign(cur, { aceptada: true, aceptadaPor: user, aceptadaAt: new Date().toISOString() });
      else if (acep === false) { delete cur.aceptada; delete cur.aceptadaPor; delete cur.aceptadaAt; }
      d[id] = cur; return cur;
    });
    _aseo.tempTs = Date.now();
    res.json({ ok: true, temprana: out });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Teléfono del huésped de una reserva → E.164 (+52 para números de 10 dígitos).
function _aseoTelHuesped(id) {
  const b = ((_lgSnap.payload && _lgSnap.payload.bookings) || []).find(x => x && String(x.Id) === String(id));
  const l = (_aseo.rows || []).find(x => String(x.Id) === String(id));
  const raw = String((b && b.GuestPhone) || (l && l.GuestPhone) || "").trim();
  let d = raw.replace(/\D/g, "");
  if (!d) return { tel: "", nombre: (b && b.GuestName) || (l && l.GuestName) || "", hid: String((b && b.HouseId) || (l && l.HouseId) || "") };
  let tel;
  if (raw.startsWith("+")) tel = "+" + d;
  else if (d.length === 10) tel = "+52" + d;
  else if (d.length === 13 && d.startsWith("521")) tel = "+52" + d.slice(3);
  else tel = "+" + d;
  return { tel, nombre: (b && b.GuestName) || (l && l.GuestName) || "", hid: String((b && b.HouseId) || (l && l.HouseId) || "") };
}
app.get("/aseo/sms/destino", async (req, res) => {
  if (!_vOriginOk(req)) return res.status(403).json({ ok: false, error: "Origen no permitido" });
  const t = _aseoTelHuesped(String(req.query.id || ""));
  res.json({ ok: true, tel: t.tel, nombre: t.nombre });
});
app.post("/aseo/sms", async (req, res) => {
  if (!_vOriginOk(req)) return res.status(403).json({ ok: false, error: "Origen no permitido" });
  try {
    const id = String((req.body || {}).id || "").replace(/[^\w-]/g, "").slice(0, 40);
    const body = String((req.body || {}).body || "").trim().slice(0, 600);
    const user = String((req.body || {}).user || "").slice(0, 80);
    if (!id || !body) return res.status(400).json({ ok: false, error: "Faltan datos" });
    const t = _aseoTelHuesped(id);
    if (!t.tel) return res.status(400).json({ ok: false, error: "La reserva no tiene teléfono del huésped" });
    const j = await _vSendSms(t.tel, body);
    const rec = { at: new Date().toISOString(), by: user, to: "••••" + t.tel.slice(-4), sid: j && j.sid || "" };
    await _aseoMutate(_ASEO_SMS_OBJ, "sms", d => { (d[id] = d[id] || []).push(rec); });
    _aseo.smsTs = Date.now();
    res.json({ ok: true, sms: rec });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get("/aseo/notificar/preview", async (req, res) => {
  if (!_vOriginOk(req)) return res.status(403).json({ ok: false, error: "Origen no permitido" });
  try {
    const { cambios } = await _aseoCambiosAsignacion();
    res.json({ ok: true, cambios: cambios.map(c => ({ ...c, tel: c.tel ? "••••" + c.tel.slice(-4) : "" })) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/aseo/notificar", async (req, res) => {
  if (!_vOriginOk(req)) return res.status(403).json({ ok: false, error: "Origen no permitido" });
  try {
    const pedidas = (Array.isArray((req.body || {}).personas) ? req.body.personas : []).map(String);
    const { resumen, cambios } = await _aseoCambiosAsignacion();
    const resultados = [];
    for (const c of cambios.filter(c => pedidas.some(p => _aseoMismaPersona(p, c.persona)))) {
      if (!c.tel) { resultados.push({ persona: c.persona, ok: false, error: "Sin celular registrado en Personal" }); continue; }
      const mias = _aseoMiasDe(resumen, c.persona);
      const cab = [`🔄 *Actualización de tus limpiezas de hoy*`,
        ...(c.agregados.length ? [`➕ Se agregó: ${c.agregados.join(", ")}`] : []),
        ...(c.quitados.length ? [`➖ Ya no te toca: ${c.quitados.join(", ")}`] : []),
        ...(c.temprana.length ? [`⏰ Prioridad: ${c.temprana.join(", ")}`] : [])].join("\n");
      const cuerpo = mias.length ? await _aseoListaEmpleado(c.persona, { resumen }) : `🧽 ${c.persona.split(" ")[0]}, ya no tienes limpiezas ni inspecciones asignadas hoy.`;
      const txt = `${cab}\n\n${cuerpo}`;
      try {
        await _twilioSendMessage({ to: _waFormatTo(c.tel), body: txt, skipMirror: true });
        _botAppendMessage(c.tel, "assistant", txt, { staff: true, auto: "limpiezas_actualizacion" });
        await _aseoNotifGuardar(c.persona, mias);
        resultados.push({ persona: c.persona, ok: true });
      } catch (e) { resultados.push({ persona: c.persona, ok: false, error: e.message }); }
    }
    res.json({ ok: true, resultados });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get("/aseo/resumen-hoy", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    if (req.query.para) return res.json({ ok: true, mensaje: await _aseoListaEmpleado(String(req.query.para)) }); // vista previa del mensaje al llegar
    res.json(Object.assign({ ok: true }, await _aseoResumenHoy()));
  }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/aseo/estado", async (req, res) => {
  if (!_vOriginOk(req)) return res.status(403).json({ ok: false, error: "Origen no permitido" });
  try {
    const b = req.body || {};
    const id = String(b.id || "").replace(/[^\w-]/g, "").slice(0, 40);
    const estado = String(b.estado || "");
    if (!id) return res.status(400).json({ ok: false, error: "Falta id" });
    if (estado !== "pendiente" && !_ASEO_ETAPAS.includes(estado)) return res.status(400).json({ ok: false, error: "Estado inválido" });
    const user = String(b.user || "").slice(0, 80), hid = String(b.hid || "").replace(/\D/g, "").slice(0, 20);
    const out = await _aseoGuardarEstado({ id, hid, estado, validar: !!b.validar, user });
    res.json({ ok: true, estado: out });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Público (guía de bienvenida): estado de aseo del alojamiento = el de su salida
// más reciente (hoy o antes). Sin registro → "pendiente" solo si la salida es hoy.
// ── Qué muestra la GUÍA de cada alojamiento HOY (regla única: la usan la guía pública
//    y las cards del sistema, para que siempre digan lo mismo). Solo reservas Booked.
const _ASEO_GUIA_TXT = {
  ocupado: "Este alojamiento está actualmente ocupado",
  desocupa: "Este alojamiento se desocupa hoy. Te avisaremos en cuanto esté listo para el ingreso.",
  en_proceso: "Aseo en proceso",
  terminado: "Ya puedes ingresar a tu alojamiento",
  inspeccionado: "Ya puedes ingresar a tu alojamiento",
};
function _aseoIdxCasas() {
  const idx = new Map();
  const put = (hid, id, v) => { hid = String(hid || ""); if (!hid) return; if (!idx.has(hid)) idx.set(hid, new Map()); idx.get(hid).set(String(id), v); };
  ((_lgSnap.payload && _lgSnap.payload.bookings) || []).forEach(b => { if (b && b.Id) put(b.HouseId, b.Id, { Status: String(b.Status || ""), dep: _lgIso(b.DateDeparture), arr: _lgIso(b.DateArrival) }); });
  (_aseo.rows || []).forEach(x => put(x.HouseId, x.Id, { Status: x.Status, dep: x.DateDeparture, arr: x.DateArrival }));
  return idx;
}
function _aseoGuiaCalc(hid, m, hoy, horaMx) {
  // · Sale hoy: estado de aseo; si sigue pendiente → "se desocupa hoy", salvo que también
  //   entre alguien hoy y ya sean las 2:00 p.m. (entonces nada; las cards avisan "urge validación").
  // · Solo entra hoy: nada hasta que se valide "terminado" o "inspeccionado".
  // · Huésped hospedado (ni entra ni sale hoy) → "ocupado". · Vacío → nada.
  const vivas = [...(m || new Map()).entries()].filter(([, v]) => /^booked$/i.test(String(v.Status || "").trim()) && v.arr && v.dep).map(([id, v]) => ({ id, ...v }));
  const salHoy = vivas.find(v => v.dep === hoy) || null;
  const entHoy = vivas.find(v => v.arr === hoy) || null;
  const ocupado = vivas.find(v => v.arr < hoy && v.dep > hoy) || null;
  let ult = salHoy;
  if (!ult) vivas.forEach(v => { if (v.dep < hoy && (!ult || v.dep > ult.dep)) ult = v; });
  const regH = (_aseo.estados || {})["H" + hid] || null; // estado guardado a nombre del alojamiento
  let reg = ult ? (_aseo.estados || {})[ult.id] : null;
  if (regH && (!reg || String(regH.at) > String(reg.at))) reg = regH;
  const pub = _aseoPub(reg); // solo lo VALIDADO se muestra en la guía
  const est = pub ? pub.estado : "pendiente";
  let modo = "";
  if (salHoy) modo = est !== "pendiente" ? "aseo" : (entHoy && horaMx >= 14 ? "" : "desocupa");
  else if (entHoy) modo = (est === "terminado" || est === "inspeccionado") ? "aseo" : "";
  else if (ocupado) modo = "ocupado";
  const estado = modo === "aseo" ? est : "";
  const texto = modo === "aseo" ? (_ASEO_GUIA_TXT[estado] || "") : (_ASEO_GUIA_TXT[modo] || "");
  return { modo, estado, texto, pub, reg, ult, salHoy, entHoy };
}
const _aseoHoraMx = () => Number(new Date().toLocaleString("en-US", { timeZone: "America/Monterrey", hour: "numeric", hour12: false })) % 24;
function _aseoGuiasTodas() {
  const idx = _aseoIdxCasas(), hoy = _mxHoy(), h = _aseoHoraMx(), out = {};
  idx.forEach((m, hid) => { const g = _aseoGuiaCalc(hid, m, hoy, h); out[hid] = { modo: g.modo, estado: g.estado, texto: g.texto }; });
  return out;
}
app.get("/aseo/estado-aloj", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const hid = String(req.query.hid || "").replace(/\D/g, "");
    if (!hid) return res.status(400).json({ ok: false, error: "Falta hid" });
    if (!_aseo.estados || Date.now() - (_aseo.estadosTs || 0) > 15_000) { _aseo.estados = await _rhdGetJson(_ASEO_ESTADOS_OBJ).catch(() => _aseo.estados || {}); _aseo.estadosTs = Date.now(); }
    if (!_aseo.rows || Date.now() - _aseo.ts > 30_000) await _aseoLiveLoad();
    const g = _aseoGuiaCalc(hid, _aseoIdxCasas().get(hid), _mxHoy(), _aseoHoraMx());
    res.json({ ok: true, hid, modo: g.modo, estado: g.estado, texto: g.texto, label: g.estado ? _ASEO_ETQ[g.estado] : "", listo: g.estado === "terminado" || g.estado === "inspeccionado",
      at: g.modo === "aseo" && g.pub ? g.pub.at : "", salida: g.ult ? g.ult.dep : "", entradaHoy: !!g.entHoy, salidaHoy: !!g.salHoy, hist: g.reg ? g.reg.hist : {}, ts: _aseo.okTs, now: Date.now() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

const PORT = process.env.PORT || 8080;
// Cloud Run no manda tráfico a la instancia hasta que abre el puerto. Esperamos
// a tener el snapshot de reservas (máx 220 s) para que ningún usuario pague la
// lectura lenta de Apps Script tras un deploy o un escalado.
(async () => {
  const t0 = Date.now();
  const pending = [];
  if (!_lgSnap.payload) pending.push(_lgSnapRefresh('arranque'));
  else _lgSnapRefresh('arranque-refresco');
  // Consulta por defecto de huespedes-list (la que usa el frontend).
  const huParams = {
    page: "1", page_size: "10000", nombre_reservacion: "", medio_reservacion: "",
    celular_principal: "", requiere_factura: "", razon_social: "", forma_pago: "",
    correo: "", fecha_entrada_desde: "", fecha_entrada_hasta: "",
    fecha_salida_desde: "", fecha_salida_hasta: "",
  };
  const huKey = _huespedesCacheKey(huParams);
  if (!_huespedesCache.get(huKey)) {
    const p = _huespedesFetchAndCache(huKey, huParams).catch(e => console.warn('[huespedes-cache] arranque falló:', e.message))
      .finally(() => _huespedesInflight.delete(huKey));
    _huespedesInflight.set(huKey, p);
    pending.push(p);
  }
  if (!_alojCache.payload) pending.push(_alojRefresh().catch(e => console.warn('[alojamientos-list] arranque falló:', e.message)));
  if (pending.length) {
    await Promise.race([Promise.all(pending), new Promise(r => setTimeout(r, 220_000))]);
  }
  console.log(`[arranque] cachés listas en ${Date.now() - t0}ms (reservas=${!!_lgSnap.payload}, huespedes=${!!_huespedesCache.get(huKey)})`);
  app.listen(PORT, _onListen);
  // Copia de respaldo de BANCOS (no bloquea el arranque): si Google Sheets
  // falla en una petición de Registros contables, /get-bancos sirve esta copia.
  _bancosRefresh("arranque").catch(e => console.warn('[bancos] precarga falló:', e.message));
})();

function _onListen() {
  console.log(`Ticket Vision v7 — Claude Vision — port ${PORT}`);
  // Warm-up: precalienta cache de endpoints críticos al arrancar. Con
  // min-instances=1 en Cloud Run, esto asegura que los usuarios nunca
  // esperen el "cold call" de Apps Script después del primer deploy.
  // Corre en background 2s después para no bloquear el arranque.
  setTimeout(async () => {
    const warmups = [
      { name: 'huespedes-list', url: `http://127.0.0.1:${PORT}/huespedes-list?page_size=10000` },
      { name: 'alojamientos-list', url: `http://127.0.0.1:${PORT}/alojamientos-list` },
      { name: 'perfiles-kpis-list', url: `http://127.0.0.1:${PORT}/perfiles-kpis-list` },
      { name: 'huespedes-filter-options', url: `http://127.0.0.1:${PORT}/huespedes-filter-options` },
      { name: 'perfiles-list', url: `http://127.0.0.1:${PORT}/perfiles-list` },
    ];
    for (const w of warmups) {
      const t0 = Date.now();
      try {
        const r = await fetch(w.url);
        await r.text();
        console.log(`[warmup] ${w.name}: ${Date.now() - t0}ms`);
      } catch (e) {
        console.warn(`[warmup] ${w.name} falló: ${e.message}`);
      }
    }
    console.log('[warmup] done — cache precaliente para primer usuario');
  }, 2000);
}
