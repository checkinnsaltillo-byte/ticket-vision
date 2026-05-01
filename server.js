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
    const result = await processFiles(req.files || [], context);
    const rows = result.rows;

    if (process.env.SAVE_TO_SHEETS === "true") {
      await sendRowsToAppsScript(rows);
    }

    const wb = XLSX.utils.book_new();

    const wsItems = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, wsItems, "Partidas");

    const wsTickets = XLSX.utils.json_to_sheet(result.tickets);
    XLSX.utils.book_append_sheet(wb, wsTickets, "Resumen tickets");

    const wsOCR = XLSX.utils.json_to_sheet(result.ocr);
    XLSX.utils.book_append_sheet(wb, wsOCR, "OCR completo");

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Disposition", "attachment; filename=tickets_estructurados.xlsx");
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
    const rows = result.rows;

    let sheetsResult = null;
    if (req.body.saveToSheets === "true" || process.env.SAVE_TO_SHEETS === "true") {
      sheetsResult = await sendRowsToAppsScript(rows);
    }

    res.json({
      ok: true,
      total_rows: rows.length,
      tickets: result.tickets,
      rows,
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
      tienda: parsed.store || "NO_DETECTADO",
      rfc_emisor: parsed.rfc || "",
      fecha_ticket: parsed.date || "",
      hora_ticket: parsed.time || "",
      folio_ticket: parsed.folio || "",
      metodo_pago: parsed.payment_method || "",
      subtotal: parsed.subtotal || 0,
      iva: parsed.iva || 0,
      ieps: parsed.ieps || 0,
      impuestos: parsed.impuestos || 0,
      descuentos: parsed.descuentos || 0,
      total_ticket: parsed.total || 0,
      total_partidas_detectadas: parsed.items?.length || 0,
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
      rows.push(buildManualReviewRow({
        ticketId,
        context,
        rawText: "",
        reason: "Google Vision no detectó texto suficiente",
        parsed: ticketSummary
      }));
      continue;
    }

    if (!parsed.items.length) {
      rows.push(buildManualReviewRow({
        ticketId,
        context,
        rawText,
        reason: "Texto detectado, pero no se identificaron partidas automáticamente",
        parsed: ticketSummary
      }));
      continue;
    }

    parsed.items.forEach((item, index) => {
      const classification = classifyExpense(item.descripcion || item.producto || "", parsed.store);

      rows.push({
        ticket_id: ticketId,
        fecha_captura: now,
        archivo: file.originalname || "",
        tienda: parsed.store || "OTRO",
        rfc_emisor: parsed.rfc || "",
        fecha_ticket: parsed.date || "",
        hora_ticket: parsed.time || "",
        folio_ticket: parsed.folio || "",
        metodo_pago: parsed.payment_method || "",

        numero_partida: index + 1,
        codigo_producto: item.codigo || "",
        descripcion: item.descripcion || item.producto || "",
        concepto: item.descripcion || item.producto || "",
        cantidad: item.cantidad || 1,
        precio_unitario: item.precio_unitario || 0,
        importe: item.importe || 0,
        impuesto_estimado: item.impuesto_estimado || 0,
        total_linea_estimado: item.total_linea || item.importe || 0,
        linea_original_ocr: item.linea_original || "",

        subtotal_ticket: parsed.subtotal || 0,
        iva_ticket: parsed.iva || 0,
        ieps_ticket: parsed.ieps || 0,
        impuestos_ticket: parsed.impuestos || 0,
        descuentos_ticket: parsed.descuentos || 0,
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

        texto_ocr: rawText
      });
    });
  }

  return { rows, tickets, ocr };
}

function buildManualReviewRow({ ticketId, context, rawText, reason, parsed }) {
  return {
    ticket_id: ticketId,
    fecha_captura: parsed.fecha_captura || new Date().toISOString(),
    archivo: parsed.archivo || "",
    tienda: parsed.tienda || "NO_DETECTADO",
    rfc_emisor: parsed.rfc_emisor || "",
    fecha_ticket: parsed.fecha_ticket || "",
    hora_ticket: parsed.hora_ticket || "",
    folio_ticket: parsed.folio_ticket || "",
    metodo_pago: parsed.metodo_pago || "",

    numero_partida: 1,
    codigo_producto: "",
    descripcion: reason,
    concepto: reason,
    cantidad: 1,
    precio_unitario: 0,
    importe: 0,
    impuesto_estimado: 0,
    total_linea_estimado: 0,
    linea_original_ocr: "",

    subtotal_ticket: parsed.subtotal || 0,
    iva_ticket: parsed.iva || 0,
    ieps_ticket: parsed.ieps || 0,
    impuestos_ticket: parsed.impuestos || 0,
    descuentos_ticket: parsed.descuentos || 0,
    total_ticket: parsed.total_ticket || 0,

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
