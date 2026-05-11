const express  = require("express");
const multer   = require("multer");
const Anthropic = require("@anthropic-ai/sdk");
const XLSX     = require("xlsx");
const fs       = require("fs");
const path     = require("path");
const cors     = require("cors");

const classifyExpense          = require("./classifier");
const { sendRowsToAppsScript } = require("./sheetsClient");

const app       = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const UPLOAD_DIR = "/tmp/uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({ dest: UPLOAD_DIR });

app.use(cors({ origin: true }));
app.use(express.json({ limit: "20mb" }));

// ─── Health ────────────────────────────────────────────────────────────────

app.get("/", (req, res) => res.json({
  ok: true, service: "Ticket Vision v7 — Claude Vision", endpoints: ["/process", "/process-json", "/health"]
}));
app.get("/health", (req, res) => res.json({ ok: true }));

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
  const base64    = fs.readFileSync(imagePath).toString("base64");
  const mediaType = getMediaType(originalName);

  const msg = await anthropic.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        { type: "text",  text: EXTRACTION_PROMPT }
      ]
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
        departamento:            context.departamento
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
