const express = require("express");
const multer = require("multer");
const vision = require("@google-cloud/vision");
const XLSX = require("xlsx");
const fs = require("fs");
const cors = require("cors");

const parseTicket = require("./parser");
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
    const result = await processFiles(req.files || [], context);

    if (process.env.SAVE_TO_SHEETS === "true") {
      await sendRowsToAppsScript(result.rows);
    }

    const wb = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(result.rows), "Transcripcion");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(result.tickets), "Resumen tickets");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(result.ocr), "OCR completo");

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Disposition", "attachment; filename=tickets_transcripcion_lineal.xlsx");
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
    const result = await processFiles(req.files || [], context);

    let sheetsResult = null;
    if (req.body.saveToSheets === "true" || process.env.SAVE_TO_SHEETS === "true") {
      sheetsResult = await sendRowsToAppsScript(result.rows);
    }

    res.json({
      ok: true,
      total_rows: result.rows.length,
      tickets: result.tickets,
      rows: result.rows,
      ocr: result.ocr,
      saved_to_sheets: !!sheetsResult,
      sheets_result: sheetsResult
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

  const rows = [];
  const tickets = [];
  const ocr = [];

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex];

    if (!file.path || !fs.existsSync(file.path)) {
      throw new Error("El archivo subido no se encontró temporalmente en Cloud Run.");
    }

    const [result] = await client.textDetection(file.path);
    const rawText = result.textAnnotations?.[0]?.description || "";
    const parsed = parseTicket(rawText);
    const now = new Date().toISOString();
    const ticketId = `${Date.now()}-${fileIndex + 1}`;

    const ticketSummary = {
      ticket_id: ticketId,
      fecha_captura: now,
      archivo: file.originalname || "",
      tienda: parsed.store || "",
      rfc_emisor: parsed.rfc || "",
      fecha_ticket: parsed.date || "",
      total_detectado: parsed.total || 0,
      renglones_detectados: parsed.items?.length || 0,
      propiedad: context.propiedad,
      departamento: context.departamento,
      huesped: context.huesped,
      reservacion_id: context.reservacion_id,
      fuente: context.fuente,
      notas: context.notas
    };

    tickets.push(ticketSummary);
    ocr.push({
      ticket_id: ticketId,
      archivo: file.originalname || "",
      texto_ocr: rawText
    });

    if (!rawText.trim()) {
      rows.push({
        ticket_id: ticketId,
        fecha_captura: now,
        archivo: file.originalname || "",
        linea_numero: 1,
        texto_original: "Google Vision no detectó texto suficiente",
        monto_detectado: 0,
        tipo_linea: "REVISION",
        tienda: parsed.store || "",
        propiedad: context.propiedad,
        departamento: context.departamento,
        huesped: context.huesped,
        notas: context.notas
      });
      continue;
    }

    parsed.items.forEach((item) => {
      rows.push({
        ticket_id: ticketId,
        fecha_captura: now,
        archivo: file.originalname || "",
        tienda: parsed.store || "",
        rfc_emisor: parsed.rfc || "",
        fecha_ticket: parsed.date || "",

        linea_numero: item.linea_numero,
        texto_original: item.texto_original,
        monto_detectado: item.monto_detectado,
        tipo_linea: item.tipo_linea,

        propiedad: context.propiedad,
        departamento: context.departamento,
        huesped: context.huesped,
        reservacion_id: context.reservacion_id,
        fuente: context.fuente,
        notas: context.notas
      });
    });
  }

  return { rows, tickets, ocr };
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
