const express = require("express");
const multer  = require("multer");
const vision  = require("@google-cloud/vision");
const XLSX    = require("xlsx");
const fs      = require("fs");
const cors    = require("cors");

const { parseTicket }         = require("./parser");
const classifyExpense          = require("./classifier");
const { sendRowsToAppsScript } = require("./sheetsClient");

const app = express();

const UPLOAD_DIR = "/tmp/uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({ dest: UPLOAD_DIR });
const client = new vision.ImageAnnotatorClient();

app.use(cors({ origin: true }));
app.use(express.json({ limit: "20mb" }));

// ─── Health ────────────────────────────────────────────────────────────────

app.get("/", (req, res) => res.json({
  ok: true,
  service: "Ticket Parser PRO v3",
  endpoints: ["/process", "/process-json", "/health"]
}));

app.get("/health", (req, res) => res.json({ ok: true }));

// ─── /process → devuelve Excel ────────────────────────────────────────────

app.post("/process", upload.array("files"), async (req, res) => {
  try {
    const context = buildContext(req.body);
    const result  = await processFiles(req.files || [], context);

    if (process.env.SAVE_TO_SHEETS === "true") {
      await sendRowsToAppsScript(result.rows);
    }

    const buffer = buildExcel(result);

    res.setHeader("Content-Disposition", "attachment; filename=tickets_transcripcion.xlsx");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buffer);
  } catch (err) {
    logError("process_error", err);
    res.status(500).json({ ok: false, error: "Error procesando tickets", detail: err.message });
  } finally {
    cleanupFiles(req.files || []);
  }
});

// ─── /process-json → devuelve JSON ────────────────────────────────────────

app.post("/process-json", upload.array("files"), async (req, res) => {
  try {
    const context = buildContext(req.body);
    const result  = await processFiles(req.files || [], context);

    let sheetsResult = null;
    if (req.body.saveToSheets === "true" || process.env.SAVE_TO_SHEETS === "true") {
      sheetsResult = await sendRowsToAppsScript(result.rows);
    }

    res.json({
      ok: true,
      total_rows:     result.rows.length,
      tickets:        result.tickets,
      rows:           result.rows,
      cruce_bancario: result.cruce,
      ocr:            result.ocr,
      saved_to_sheets: !!sheetsResult,
      sheets_result:  sheetsResult
    });
  } catch (err) {
    logError("process_json_error", err);
    res.status(500).json({ ok: false, error: "Error procesando tickets", detail: err.message });
  } finally {
    cleanupFiles(req.files || []);
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildContext(body = {}) {
  return {
    propiedad:      body.propiedad      || "",
    departamento:   body.departamento   || "",
    huesped:        body.huesped        || "",
    reservacion_id: body.reservacion_id || "",
    fuente:         body.fuente         || "Ticket Scanner PRO",
    notas:          body.notas          || ""
  };
}

async function processFiles(files, context) {
  if (!files.length) {
    throw new Error("No se recibió ningún archivo. El campo form-data debe llamarse 'files'.");
  }

  const rows    = [];
  const tickets = [];
  const cruce   = [];   // ← hoja específica para conciliación bancaria
  const ocr     = [];

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = files[fileIndex];

    if (!file.path || !fs.existsSync(file.path)) {
      throw new Error("El archivo temporal no se encontró en Cloud Run.");
    }

    const [visionResult] = await client.textDetection(file.path);
    const rawText = visionResult.textAnnotations?.[0]?.description || "";
    const parsed  = parseTicket(rawText);
    const now     = new Date().toISOString();
    const ticketId = `${Date.now()}-${fileIndex + 1}`;

    // ── Resumen por ticket ─────────────────────────────────────────────────
    const ticketSummary = {
      ticket_id:          ticketId,
      hash_ticket:        parsed.hash_ticket,
      fecha_captura:      now,
      archivo:            file.originalname || "",
      tienda:             parsed.store       || "",
      rfc_emisor:         parsed.rfc         || "",
      fecha_ticket:       parsed.date        || "",
      hora_ticket:        parsed.time        || "",
      folio:              parsed.folio       || "",
      metodo_pago:        parsed.payment_method || "",
      ultimos_4_tarjeta:  parsed.card_last4  || "",
      total_detectado:    parsed.total       || 0,
      monto_pagado:       parsed.monto_pagado || 0,
      monto_cruce:        parsed.monto_cruce  || 0,
      referencia_cruce:   parsed.referencia_cruce || "",
      renglones_detectados: parsed.items?.length || 0,
      propiedad:          context.propiedad,
      departamento:       context.departamento,
      huesped:            context.huesped,
      reservacion_id:     context.reservacion_id,
      fuente:             context.fuente,
      notas:              context.notas
    };

    tickets.push(ticketSummary);

    // ── Fila para conciliación bancaria ────────────────────────────────────
    cruce.push({
      fecha_iso:          parsed.date        || "",
      hora:               parsed.time        || "",
      comercio:           parsed.store       || "",
      rfc:                parsed.rfc         || "",
      folio:              parsed.folio       || "",
      metodo_pago:        parsed.payment_method || "",
      tarjeta_ultimos4:   parsed.card_last4  || "",
      monto_cruce:        parsed.monto_cruce  || 0,
      total_ticket:       parsed.total        || 0,
      propiedad:          context.propiedad,
      departamento:       context.departamento,
      huesped:            context.huesped,
      notas:              context.notas,
      hash_ticket:        parsed.hash_ticket,
      // columna de ayuda para Excel: fórmula de búsqueda sugerida
      busqueda_banco:     parsed.date
        ? `${parsed.store || "?"} ${parsed.date} ${parsed.monto_cruce ? "$" + parsed.monto_cruce : ""}`
        : ""
    });

    ocr.push({
      ticket_id: ticketId,
      archivo:   file.originalname || "",
      texto_ocr: rawText
    });

    if (!rawText.trim()) {
      rows.push({
        ticket_id:           ticketId,
        fecha_captura:       now,
        archivo:             file.originalname || "",
        linea_numero:        1,
        texto_original:      "Google Vision no detectó texto suficiente",
        monto_detectado:     0,
        tipo_linea:          "REVISION",
        tienda:              parsed.store || "",
        propiedad:           context.propiedad,
        departamento:        context.departamento,
        huesped:             context.huesped,
        notas:               context.notas,
        categoria_operativa: "",
        categoria_contable:  "",
        clave_sat:           "",
        tratamiento_fiscal:  "",
        deducible_sugerido:  "",
        requiere_revision:   "Sí",
        confianza_clasificacion: ""
      });
      continue;
    }

    // ── Renglones ──────────────────────────────────────────────────────────
    parsed.items.forEach((item) => {
      // Clasificar solo renglones de producto (no totales/encabezados)
      const clasificable = ["RENGLON"].includes(item.tipo_linea);
      const clasif = clasificable
        ? classifyExpense(item.texto_original, parsed.store)
        : {
            categoria_operativa:     "",
            categoria_contable:      "",
            clave_sat:               "",
            tratamiento_fiscal:      "",
            deducible_sugerido:      "",
            requiere_revision:       "",
            confianza_clasificacion: "",
            razon:                   ""
          };

      rows.push({
        ticket_id:           ticketId,
        hash_ticket:         parsed.hash_ticket,
        fecha_captura:       now,
        archivo:             file.originalname || "",
        tienda:              parsed.store       || "",
        rfc_emisor:          parsed.rfc         || "",
        fecha_ticket:        parsed.date        || "",
        hora_ticket:         parsed.time        || "",
        folio:               parsed.folio       || "",
        metodo_pago:         parsed.payment_method || "",
        ultimos_4_tarjeta:   parsed.card_last4  || "",
        total_ticket:        parsed.total        || 0,
        monto_cruce:         parsed.monto_cruce  || 0,

        linea_numero:        item.linea_numero,
        texto_original:      item.texto_original,
        cantidad:            item.cantidad,
        precio_unitario:     item.precio_unitario,
        monto_detectado:     item.monto_detectado,
        tipo_linea:          item.tipo_linea,

        categoria_operativa:     clasif.categoria_operativa,
        categoria_contable:      clasif.categoria_contable,
        clave_sat:               clasif.clave_sat,
        tratamiento_fiscal:      clasif.tratamiento_fiscal,
        deducible_sugerido:      clasif.deducible_sugerido,
        requiere_revision:       clasif.requiere_revision,
        confianza_clasificacion: clasif.confianza_clasificacion,

        propiedad:           context.propiedad,
        departamento:        context.departamento,
        huesped:             context.huesped,
        reservacion_id:      context.reservacion_id,
        fuente:              context.fuente,
        notas:               context.notas
      });
    });
  }

  return { rows, tickets, cruce, ocr };
}

// ─── Construir Excel ────────────────────────────────────────────────────────

function buildExcel(result) {
  const wb = XLSX.utils.book_new();

  // Hoja 1: Transcripción completa
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(result.rows),
    "Transcripcion"
  );

  // Hoja 2: Resumen por ticket
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(result.tickets),
    "Resumen tickets"
  );

  // Hoja 3: Cruce bancario ← nueva, clave para conciliación
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(result.cruce),
    "Cruce bancario"
  );

  // Hoja 4: OCR raw
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(result.ocr),
    "OCR completo"
  );

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// ─── Cleanup y logger ──────────────────────────────────────────────────────

function cleanupFiles(files) {
  for (const file of files) {
    try {
      if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch (_) {}
  }
}

function logError(tag, err) {
  console.error(tag, {
    message: err.message,
    code:    err.code,
    stack:   err.stack
  });
}

// ─── Start ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Ticket Parser PRO v3 running on port ${PORT}`));
