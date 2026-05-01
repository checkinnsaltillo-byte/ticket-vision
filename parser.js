function parseAmount(line) {
  const matches = [...String(line || "").matchAll(/\$?\s*(-?\d{1,3}(?:,\d{3})*(?:\.\d{2})|-?\d+(?:\.\d{2})|-?\d+,\d{2})/g)];

  if (!matches.length) return 0;

  const raw = matches[matches.length - 1][1];
  let clean = raw.replace(/[$\s]/g, "");

  const hasComma = clean.includes(",");
  const hasDot = clean.includes(".");

  if (hasComma && hasDot) {
    clean = clean.replace(/,/g, "");
  } else if (hasComma && !hasDot) {
    clean = clean.replace(",", ".");
  }

  clean = clean.replace(/[^\d.-]/g, "");

  return Number(clean) || 0;
}

function detectLineType(line) {
  const l = String(line || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();

  if (l.includes("SUBTOTAL") || l.includes("SUB TOTAL")) return "SUBTOTAL";
  if (l.includes("TOTAL")) return "TOTAL";
  if (l.includes("IVA")) return "IVA";
  if (l.includes("IEPS")) return "IEPS";
  if (l.includes("IMPORTE")) return "IMPORTE";
  if (l.includes("DESCUENTO") || l.includes("DESC")) return "DESCUENTO";
  if (l.includes("EFECTIVO") || l.includes("TARJETA") || l.includes("VISA") || l.includes("MASTERCARD")) return "PAGO";

  return "RENGLON";
}

function detectStore(text) {
  const t = String(text || "").toUpperCase();

  if (t.includes("VEMEX")) return "VEMEX";
  if (t.includes("HOME DEPOT")) return "HOME DEPOT";
  if (t.includes("WALMART")) return "WALMART";
  if (t.includes("HEB") || t.includes("H-E-B")) return "HEB";
  if (t.includes("COSTCO")) return "COSTCO";
  if (t.includes("SAMS") || t.includes("SAM'S")) return "SAMS";

  return "OTRO";
}

function extractDate(text) {
  const m = String(text || "").match(/\b\d{2}[\/-]\d{2}[\/-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/);
  return m ? m[0] : "";
}

function extractRFC(text) {
  const m = String(text || "").toUpperCase().match(/\b[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/);
  return m ? m[0] : "";
}

function extractTotalFromLines(items) {
  const totals = items
    .filter(x => x.tipo_linea === "TOTAL" && x.monto_detectado > 0)
    .map(x => x.monto_detectado);

  if (totals.length) return Math.max(...totals);

  const amounts = items
    .map(x => x.monto_detectado)
    .filter(x => x > 0);

  return amounts.length ? Math.max(...amounts) : 0;
}

function parseTicket(textRaw) {
  const raw = String(textRaw || "");

  const lines = raw
    .replace(/\r/g, "\n")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const items = lines.map((line, index) => {
    const amount = parseAmount(line);
    const type = detectLineType(line);

    return {
      linea_numero: index + 1,
      texto_original: line,
      monto_detectado: amount,
      tipo_linea: type,

      // Compatibilidad con el server/frontend anterior
      descripcion: line,
      concepto: line,
      cantidad: "",
      precio_unitario: "",
      importe: amount,
      impuesto_estimado: "",
      total_linea: amount,
      linea_original: line,
      codigo: ""
    };
  });

  return {
    store: detectStore(raw),
    rfc: extractRFC(raw),
    date: extractDate(raw),
    time: "",
    folio: "",
    payment_method: "",
    subtotal: 0,
    iva: 0,
    ieps: 0,
    impuestos: 0,
    descuentos: 0,
    importe: 0,
    total: extractTotalFromLines(items),
    resumen_lineas: items.filter(x => ["SUBTOTAL", "TOTAL", "IVA", "IEPS", "IMPORTE", "DESCUENTO", "PAGO"].includes(x.tipo_linea)),
    items,
    raw_text: raw
  };
}

module.exports = parseTicket;
