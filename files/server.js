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
  service: "Ticket Parser PRO v4",
  endpoints: ["/process", "/process-json", "/health"]
}));

app.get("/health", (req, res) => res.json({ ok: true }));

// ─── /process → devuelve Excel ────────────────────────────────────────────

app.post("/process", upload.array("files"), async (req, res) => {
  try {
    const context = buildContext(req.body);
    const result  = await processFiles(req.files || [], context);

    if (process.env.SAVE_TO_SHEETS === "true") {
      await sendRowsToAppsScript(result.productRows);
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
    throw new Error("No se recibió ningún archivo.");
  }

  const productRows = [];
  const resumenRows = [];
  const cruceRows   = [];

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

    // ── Productos ──────────────────────────────────────────────────────────
    if (!rawText.trim()) {
      productRows.push({
        ticket_id:   ticketId,
        tienda:      parsed.store || "",
        fecha:       parsed.date  || "",
        linea_numero: 1,
        descripcion: "Google Vision no detectó texto suficiente",
        cantidad:    "",
        precio_unitario: "",
        monto:       "",
        categoria_operativa:     "Revisar",
        categoria_contable:      "",
        clave_sat:               "",
        tratamiento_fiscal:      "",
        deducible_sugerido:      "",
        requiere_revision:       "Sí",
        confianza_clasificacion: "",
        propiedad:    context.propiedad,
        departamento: context.departamento,
        huesped:      context.huesped,
        notas:        context.notas
      });
    } else {
      parsed.productos.forEach(producto => {
        const clasif = classifyExpense(producto.descripcion, parsed.store);
        productRows.push({
          ticket_id:       ticketId,
          tienda:          parsed.store || "",
          fecha:           parsed.date  || "",
          linea_numero:    producto.linea_numero,
          descripcion:     producto.descripcion,
          cantidad:        producto.cantidad,
          precio_unitario: producto.precio_unitario,
          monto:           producto.monto,
          categoria_operativa:     clasif.categoria_operativa,
          categoria_contable:      clasif.categoria_contable,
          clave_sat:               clasif.clave_sat,
          tratamiento_fiscal:      clasif.tratamiento_fiscal,
          deducible_sugerido:      clasif.deducible_sugerido,
          requiere_revision:       clasif.requiere_revision,
          confianza_clasificacion: clasif.confianza_clasificacion,
          propiedad:    context.propiedad,
          departamento: context.departamento,
          huesped:      context.huesped,
          notas:        context.notas
        });
      });
    }

    // ── Resumen financiero (1 fila por ticket) ─────────────────────────────
    resumenRows.push({
      ticket_id:       ticketId,
      hash_ticket:     parsed.hash_ticket,
      archivo:         file.originalname || "",
      tienda:          parsed.store       || "",
      rfc:             parsed.rfc         || "",
      fecha:           parsed.date        || "",
      hora:            parsed.time        || "",
      folio:           parsed.folio       || "",
      metodo_pago:     parsed.payment_method || "",
      tarjeta_ultimos4: parsed.card_last4 || "",
      num_productos:   parsed.productos.length,
      subtotal:        parsed.subtotal,
      iva:             parsed.iva,
      ieps:            parsed.ieps,
      descuentos:      parsed.descuentos,
      total:           parsed.total,
      propiedad:       context.propiedad,
      departamento:    context.departamento,
      huesped:         context.huesped,
      reservacion_id:  context.reservacion_id,
      notas:           context.notas,
      fecha_captura:   now
    });

    // ── Cruce bancario ─────────────────────────────────────────────────────
    cruceRows.push({
      fecha:              parsed.date          || "",
      hora:               parsed.time          || "",
      comercio:           parsed.store         || "",
      rfc:                parsed.rfc           || "",
      folio:              parsed.folio         || "",
      metodo_pago:        parsed.payment_method || "",
      tarjeta_ultimos4:   parsed.card_last4    || "",
      monto_cruce:        parsed.monto_cruce   || 0,
      total_ticket:       parsed.total         || 0,
      propiedad:          context.propiedad,
      departamento:       context.departamento,
      huesped:            context.huesped,
      hash_ticket:        parsed.hash_ticket,
      busqueda_banco:     parsed.date
        ? `${parsed.store || "?"} ${parsed.date} ${parsed.monto_cruce ? "$" + parsed.monto_cruce : ""}`
        : ""
    });
  }

  return { productRows, resumenRows, cruceRows };
}

// ─── Construir Excel ────────────────────────────────────────────────────────

function buildExcel(result) {
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(result.productRows),
    "Productos"
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(result.resumenRows),
    "Resumen financiero"
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(result.cruceRows),
    "Cruce bancario"
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
  console.error(tag, { message: err.message, code: err.code, stack: err.stack });
}

// ─── Start ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Ticket Parser PRO v4 running on port ${PORT}`));
