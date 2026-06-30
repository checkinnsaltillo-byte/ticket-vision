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
app.get("/alojamientos-list", async (req, res) => {
  try {
    const result = await callCheckinAppsScript("list_alojamientos");
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
    const { folio, email, org } = req.body || {};
    if (!folio) throw new Error('folio requerido');
    const orgN = String(org || '2');
    const key = orgN === '1'
      ? (process.env.FACTURAPI_SECRET_KEY_ORG1 || process.env.FACTURAPI_SECRET_KEY)
      : (process.env.FACTURAPI_SECRET_KEY_ORG2 || process.env.FACTURAPI_SECRET_KEY);
    if (!key) throw new Error('FACTURAPI_SECRET_KEY no configurada en Cloud Run (org ' + orgN + ')');
    const auth = 'Basic ' + Buffer.from(key + ':').toString('base64');
    // 1) Buscar invoice por folio_number
    const searchUrl = `https://www.facturapi.io/v2/invoices?folio_number=${encodeURIComponent(folio)}&limit=1`;
    const sResp = await fetch(searchUrl, { headers: { 'Authorization': auth } });
    if (!sResp.ok) {
      const t = await sResp.text().catch(() => '');
      throw new Error(`Facturapi search ${sResp.status}: ${t.slice(0, 200)}`);
    }
    const search = await sResp.json();
    const inv = (search?.data || [])[0];
    if (!inv) throw new Error(`No se encontró invoice con folio ${folio} en Facturapi`);
    // 2) Enviar email — la API acepta { email: [string] } para sobrescribir; sin body usa el del cliente
    const body = email ? JSON.stringify({ email: [email] }) : '{}';
    const eResp = await fetch(`https://www.facturapi.io/v2/invoices/${inv.id}/email`, {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
      body,
    });
    if (!eResp.ok) {
      const t = await eResp.text().catch(() => '');
      throw new Error(`Facturapi send ${eResp.status}: ${t.slice(0, 200)}`);
    }
    res.json({ ok: true, sent_to: email || (inv.customer?.email || ''), invoice_id: inv.id, folio });
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
    // Si vienen start/end explícitos, NO se cachea (rango arbitrario por reserva).
    const useCache = !explicitStart && !explicitEnd;
    const ttlMs = 60_000;
    const now = Date.now();
    const out = {};
    const pending = [];
    if (useCache) {
      for (const id of ids) {
        const c = _tuyaLogsCache.get(id);
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
        if (useCache) _tuyaLogsCache.set(id, { ts: now, logs: collected });
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

// ─── Start ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Ticket Vision v7 — Claude Vision — port ${PORT}`));
