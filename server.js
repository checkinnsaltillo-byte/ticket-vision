const express = require("express");
const multer = require("multer");
const vision = require("@google-cloud/vision");
const XLSX = require("xlsx");
const fs = require("fs");
const cors = require("cors");

const parseTicket = require("./parser");
const classifyExpense = require("./classifier");
const { sendRowsToAppsScript } = require("./sheetsClient");

const app = express();

const UPLOAD_DIR = "/tmp/uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({ dest: UPLOAD_DIR });
const client = new vision.ImageAnnotatorClient();

app.use(cors({ origin: true }));
app.use(express.json({ limit: "20mb" }));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Ticket Parser PRO Integrado",
    endpoints: ["/process", "/process-json", "/health"]
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/process", upload.array("files"), async (req, res) => {
  try {
    const context = buildContext(req.body);
    const rows = await processFiles(req.files || [], context);

    if (process.env.SAVE_TO_SHEETS === "true") {
      await sendRowsToAppsScript(rows);
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, "Gastos");

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Disposition", "attachment; filename=gastos_tickets.xlsx");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buffer);
  } catch (err) {
    console.error("process_error", {
      message: err.message,
      code: err.code,
      stack: err.stack
    });

    res.status(500).json({
      ok: false,
      error: "Error procesando tickets",
      detail: err.message,
      code: err.code || ""
    });
  } finally {
    cleanupFiles(req.files || []);
  }
});

app.post("/process-json", upload.array("files"), async (req, res) => {
  try {
    const context = buildContext(req.body);
    const rows = await processFiles(req.files || [], context);

    let sheetsResult = null;
    if (req.body.saveToSheets === "true" || process.env.SAVE_TO_SHEETS === "true") {
      sheetsResult = await sendRowsToAppsScript(rows);
    }

    res.json({
      ok: true,
      total_rows: rows.length,
      saved_to_sheets: !!sheetsResult,
      sheets_result: sheetsResult,
      rows
    });
  } catch (err) {
    console.error("process_json_error", {
      message: err.message,
      code: err.code,
      stack: err.stack
    });

    res.status(500).json({
      ok: false,
      error: "Error procesando tickets",
      detail: err.message,
      code: err.code || ""
    });
  } finally {
    cleanupFiles(req.files || []);
  }
});

function buildContext(body = {}) {
  return {
    propiedad: body.propiedad || "",
    departamento: body.departamento || "",
    huesped: body.huesped || "",
    reservacion_id: body.reservacion_id || "",
    fuente: body.fuente || "Ticket Scanner PRO",
    notas: body.notas || ""
  };
}

async function processFiles(files, context) {
  if (!files.length) {
    throw new Error("No se recibió ningún archivo. Verifica que el campo form-data se llame files.");
  }

  const allRows = [];

  for (const file of files) {
    if (!file.path || !fs.existsSync(file.path)) {
      throw new Error("El archivo subido no se encontró temporalmente en Cloud Run.");
    }

    const [result] = await client.textDetection(file.path);
    const rawText = result.textAnnotations?.[0]?.description || "";

    if (!rawText.trim()) {
      allRows.push(buildManualReviewRow({
        context,
        rawText: "",
        reason: "Google Vision no detectó texto suficiente",
        store: "NO_DETECTADO"
      }));
      continue;
    }

    const parsed = parseTicket(rawText);
    const now = new Date().toISOString();

    if (!parsed.items.length) {
      allRows.push(buildManualReviewRow({
        context,
        rawText,
        reason: "Texto detectado, pero no se identificaron partidas automáticamente",
        store: parsed.store || "OTRO",
        total: parsed.total || 0,
        fecha: parsed.date || "",
        rfc: parsed.rfc || "",
        folio: parsed.folio || "",
        fecha_captura: now
      }));
      continue;
    }

    parsed.items.forEach((item, index) => {
      const classification = classifyExpense(item.producto, parsed.store);

      allRows.push({
        fecha_captura: now,
        tienda: parsed.store,
        rfc_emisor: parsed.rfc || "",
        fecha_ticket: parsed.date || "",
        folio_ticket: parsed.folio || "",
        producto: item.producto,
        cantidad: item.cantidad || 1,
        precio_unitario: item.precio_unitario || item.importe || 0,
        importe: item.importe || 0,
        total_ticket: parsed.total || 0,
        categoria_operativa: classification.categoria_operativa,
        categoria_contable: classification.categoria_contable,
        tratamiento_fiscal: classification.tratamiento_fiscal,
        deducible_sugerido: classification.deducible_sugerido,
        requiere_revision: classification.requiere_revision,
        razon_clasificacion: classification.razon,
        propiedad: context.propiedad,
        departamento: context.departamento,
        huesped: context.huesped,
        reservacion_id: context.reservacion_id,
        fuente: context.fuente,
        notas: context.notas,
        ticket_linea: index + 1,
        texto_ocr: rawText
      });
    });
  }

  return allRows;
}

function buildManualReviewRow({ context, rawText, reason, store, total = 0, fecha = "", rfc = "", folio = "", fecha_captura = new Date().toISOString() }) {
  return {
    fecha_captura,
    tienda: store,
    rfc_emisor: rfc,
    fecha_ticket: fecha,
    folio_ticket: folio,
    producto: reason,
    cantidad: 1,
    precio_unitario: 0,
    importe: 0,
    total_ticket: total,
    categoria_operativa: "Revisión manual",
    categoria_contable: "Pendiente de clasificar",
    tratamiento_fiscal: "Revisión contable requerida",
    deducible_sugerido: "Revisar",
    requiere_revision: "Sí",
    razon_clasificacion: reason,
    propiedad: context.propiedad,
    departamento: context.departamento,
    huesped: context.huesped,
    reservacion_id: context.reservacion_id,
    fuente: context.fuente,
    notas: context.notas,
    ticket_linea: 1,
    texto_ocr: rawText
  };
}

function cleanupFiles(files) {
  for (const file of files) {
    try {
      if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch (_) {}
  }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Ticket Parser PRO Integrado running on ${PORT}`));
