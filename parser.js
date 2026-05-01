function normalizeText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function normalizeLine(line) {
  return String(line || "").replace(/[ \t]+/g, " ").trim();
}

function detectStore(text) {
  const t = text.toUpperCase();

  if (t.includes("VEMEX")) return "VEMEX";
  if (t.includes("HOME DEPOT") || t.includes("THE HOME DEPOT")) return "HOME DEPOT";
  if (t.includes("WALMART")) return "WALMART";
  if (t.includes("HEB") || t.includes("H-E-B")) return "HEB";
  if (t.includes("COSTCO")) return "COSTCO";
  if (t.includes("SAMS") || t.includes("SAM'S") || t.includes("SAM S")) return "SAMS";
  if (t.includes("LOWE")) return "LOWES";
  if (t.includes("STEREN")) return "STEREN";
  if (t.includes("OFFICE DEPOT")) return "OFFICE DEPOT";

  return "OTRO";
}

function parseAmount(value) {
  if (!value) return 0;
  const clean = String(value)
    .replace(/[$,\s]/g, "")
    .replace(/[^\d.-]/g, "");
  return Number(clean) || 0;
}

function formatAmount(value) {
  const n = Number(value) || 0;
  return Number(n.toFixed(2));
}

function extractDate(text) {
  const patterns = [
    /\b(\d{2}\/\d{2}\/\d{4})\b/,
    /\b(\d{2}-\d{2}-\d{4})\b/,
    /\b(\d{4}-\d{2}-\d{2})\b/,
    /\b(\d{2}\/\d{2}\/\d{2})\b/
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }

  return "";
}

function extractTime(text) {
  const m = text.match(/\b([01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/);
  return m ? m[0] : "";
}

function extractRFC(text) {
  const matches = text.toUpperCase().match(/\b[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/g);
  if (!matches || !matches.length) return "";
  return matches[0];
}

function extractFolio(text) {
  const patterns = [
    /(?:folio|ticket|transacci[oó]n|operaci[oó]n|venta|recibo|orden)[:\s#-]*([A-Z0-9-]{4,})/i,
    /\b(?:TC|TR|OP|TX)[-:\s]*([A-Z0-9-]{4,})\b/i
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }

  return "";
}

function extractPaymentMethod(text) {
  const t = text.toUpperCase();

  if (t.includes("EFECTIVO")) return "Efectivo";
  if (t.includes("TARJETA") || t.includes("VISA") || t.includes("MASTERCARD") || t.includes("CREDITO") || t.includes("CRÉDITO") || t.includes("DEBITO") || t.includes("DÉBITO")) return "Tarjeta";
  if (t.includes("TRANSFERENCIA") || t.includes("SPEI")) return "Transferencia";
  if (t.includes("PAYPAL")) return "PayPal";

  return "";
}

function extractSummaryAmounts(text) {
  const summary = {
    subtotal: 0,
    iva: 0,
    ieps: 0,
    impuestos: 0,
    descuentos: 0,
    total: 0
  };

  const lines = text.split("\n").map(normalizeLine).filter(Boolean);

  for (const line of lines) {
    const l = line.toUpperCase();
    const amounts = [...line.matchAll(/\$?\s*([\d,]+\.\d{2})/g)].map(m => parseAmount(m[1]));
    if (!amounts.length) continue;
    const value = amounts[amounts.length - 1];

    if (/\bSUB\s*TOTAL\b|\bSUBTOTAL\b/.test(l)) {
      summary.subtotal = value;
    } else if (/\bIVA\b/.test(l)) {
      summary.iva = value;
    } else if (/\bIEPS\b/.test(l)) {
      summary.ieps = value;
    } else if (/IMPUEST/.test(l)) {
      summary.impuestos = value;
    } else if (/DESCUENTO|DESC\./.test(l)) {
      summary.descuentos = value;
    } else if (/\bTOTAL\b|TOTAL A PAGAR|GRAN TOTAL|IMPORTE TOTAL/.test(l)) {
      summary.total = Math.max(summary.total || 0, value);
    }
  }

  if (!summary.impuestos) {
    summary.impuestos = formatAmount((summary.iva || 0) + (summary.ieps || 0));
  }

  if (!summary.total) {
    const candidates = [];
    const regexes = [
      /(?:TOTAL|TOTAL\s+A\s+PAGAR|IMPORTE\s+TOTAL|GRAN\s+TOTAL)[^\d$]*\$?\s*([\d,]+\.\d{2})/gi,
      /\bTOTAL\b[^\n]*?([\d,]+\.\d{2})/gi
    ];

    for (const rx of regexes) {
      let m;
      while ((m = rx.exec(text)) !== null) {
        candidates.push(parseAmount(m[1]));
      }
    }

    if (candidates.length) summary.total = Math.max(...candidates);
  }

  return {
    subtotal: formatAmount(summary.subtotal),
    iva: formatAmount(summary.iva),
    ieps: formatAmount(summary.ieps),
    impuestos: formatAmount(summary.impuestos),
    descuentos: formatAmount(summary.descuentos),
    total: formatAmount(summary.total)
  };
}

function isNoiseLine(line) {
  const l = line.toUpperCase();

  return (
    l.length < 3 ||
    /RFC|REGIMEN|RÉGIMEN|FACTURA|UUID|SAT|CERTIFICADO|LUGAR DE EXPEDICI|GRACIAS|WWW\.|HTTP|TEL\.|TELEFONO|TELÉFONO|CLIENTE|CAJERO|SUCURSAL|DOMICILIO/.test(l) ||
    /SUBTOTAL|SUB TOTAL|TOTAL|IVA|IEPS|IMPUEST|CAMBIO|PAGO|PAGADO|EFECTIVO|TARJETA|AUTORIZ|APROBADA|BANCO|CUENTA|DEBITO|DÉBITO|CREDITO|CRÉDITO/.test(l)
  );
}

function looksLikeItemLine(line) {
  if (isNoiseLine(line)) return false;
  return /\d[\d,]*\.\d{2}/.test(line);
}

function parseItemsGeneric(lines) {
  const items = [];

  for (let i = 0; i < lines.length; i++) {
    const line = normalizeLine(lines[i]);
    if (!looksLikeItemLine(line)) continue;

    const amountMatches = [...line.matchAll(/\$?\s*([\d,]+\.\d{2})/g)];
    if (!amountMatches.length) continue;

    const importe = parseAmount(amountMatches[amountMatches.length - 1][1]);
    if (!importe || importe < 0.01) continue;

    let rawBeforeAmount = line.slice(0, amountMatches[amountMatches.length - 1].index).trim();

    let cantidad = 1;
    let precio_unitario = importe;

    const qtyStart = rawBeforeAmount.match(/^(\d+(?:\.\d{1,3})?)\s+(.*)$/);
    if (qtyStart) {
      const possibleQty = Number(qtyStart[1]);
      if (possibleQty > 0 && possibleQty < 999) {
        cantidad = possibleQty;
        rawBeforeAmount = qtyStart[2].trim();
      }
    }

    // Detecta líneas tipo: "PRODUCTO 2 99.00 198.00"
    const embeddedNumbers = [...rawBeforeAmount.matchAll(/\b(\d+(?:\.\d{1,3})?)\b/g)];
    if (embeddedNumbers.length) {
      const lastNum = Number(embeddedNumbers[embeddedNumbers.length - 1][1]);
      if (lastNum > 0 && lastNum < 999 && importe / lastNum > 1) {
        // No sobreescribir si parece código de producto.
      }
    }

    precio_unitario = cantidad ? formatAmount(importe / cantidad) : importe;

    let descripcion = rawBeforeAmount
      .replace(/^\*+/, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (!descripcion || descripcion.length < 2) {
      descripcion = "Partida detectada sin descripción clara";
    }

    items.push({
      linea_original: line,
      codigo: extractPossibleCode(line, descripcion),
      descripcion,
      cantidad: formatAmount(cantidad),
      precio_unitario: formatAmount(precio_unitario),
      importe: formatAmount(importe),
      impuesto_estimado: 0,
      total_linea: formatAmount(importe)
    });
  }

  return mergeContinuationLines(items);
}

function extractPossibleCode(line, descripcion) {
  const firstToken = descripcion.split(" ")[0] || "";
  if (/^[A-Z0-9-]{4,}$/.test(firstToken) && /\d/.test(firstToken)) return firstToken;
  const m = line.match(/\b(\d{5,14})\b/);
  return m ? m[1] : "";
}

function mergeContinuationLines(items) {
  // En OCR complejo, algunas tiendas parten descripción e importe.
  // Por ahora se conserva cada partida encontrada sin fusionar agresivamente para evitar perder datos.
  return items;
}

function distributeTaxes(items, summary) {
  if (!items.length) return items;

  const iva = Number(summary.iva || 0);
  const impuestos = Number(summary.impuestos || 0);
  const taxToUse = iva || impuestos;

  if (!taxToUse) return items;

  const base = items.reduce((acc, item) => acc + Number(item.importe || 0), 0);
  if (!base) return items;

  let assigned = 0;

  return items.map((item, index) => {
    let impuesto = formatAmount(taxToUse * (Number(item.importe || 0) / base));

    if (index === items.length - 1) {
      impuesto = formatAmount(taxToUse - assigned);
    } else {
      assigned += impuesto;
    }

    return {
      ...item,
      impuesto_estimado: impuesto,
      total_linea: formatAmount(Number(item.importe || 0) + impuesto)
    };
  });
}

function parseTicket(textRaw) {
  const text = normalizeText(textRaw);
  const lines = text.split("\n").map(normalizeLine).filter(Boolean);
  const store = detectStore(text);
  const summary = extractSummaryAmounts(text);
  const itemsRaw = parseItemsGeneric(lines);
  const items = distributeTaxes(itemsRaw, summary);

  return {
    store,
    rfc: extractRFC(text),
    date: extractDate(text),
    time: extractTime(text),
    folio: extractFolio(text),
    payment_method: extractPaymentMethod(text),
    subtotal: summary.subtotal,
    iva: summary.iva,
    ieps: summary.ieps,
    impuestos: summary.impuestos,
    descuentos: summary.descuentos,
    total: summary.total,
    items,
    raw_text: text
  };
}

module.exports = parseTicket;
