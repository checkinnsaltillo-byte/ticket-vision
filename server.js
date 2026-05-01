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
const upload = multer({ dest: "/tmp/uploads" });
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

/**
 * Devuelve Excel descargable.
 * También puede guardar en Google Sheets si SAVE_TO_SHEETS=true.
 */
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
    console.error("process_error", err);
    res.status(500).json({ ok: false, error: "Error procesando tickets" });
  } finally {
    cleanupFiles(req.files || []);
  }
});

/**
 * Devuelve JSON y guarda opcionalmente en Google Sheets.
 * Útil para integrarlo con tu frontend actual de Control de Huéspedes.
 */
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
    console.error("process_json_error", err);
    res.status(500).json({ ok: false, error: "Error procesando tickets" });
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
  const allRows = [];

  for (const file of files) {
    const [result] = await client.textDetection(file.path);
    const rawText = result.textAnnotations?.[0]?.description || "";

    const parsed = parseTicket(rawText);
    const now = new Date().toISOString();

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

function cleanupFiles(files) {
  for (const file of files) {
    try {
      if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch (_) {}
  }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Ticket Parser PRO Integrado running on ${PORT}`));
