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

function isSummaryOrPaymentLine(line) {
  const l = line.toUpperCase();
  return /SUBTOTAL|SUB TOTAL|TOTAL|IVA|IEPS|IMPUEST|CAMBIO|PAGO|PAGADO|EFECTIVO|TARJETA|AUTORIZ|APROBADA|BANCO|CUENTA|DEBITO|DÉBITO|CREDITO|CRÉDITO|AHORRO|MONEDERO/.test(l);
}

function isHeaderOrNoiseLine(line) {
  const l = line.toUpperCase();
  return (
    l.length < 2 ||
    /RFC|REGIMEN|RÉGIMEN|FACTURA|UUID|SAT|CERTIFICADO|LUGAR DE EXPEDICI|GRACIAS|WWW\.|HTTP|TEL\.|TELEFONO|TELÉFONO|CLIENTE|CAJERO|SUCURSAL|DOMICILIO|AV\.|COL\.|C\.P\.|CP\s|FECHA|HORA|FOLIO|TICKET|RECIBO/.test(l)
  );
}

function isNoiseLine(line) {
  return isHeaderOrNoiseLine(line) || isSummaryOrPaymentLine(line);
}

function hasAmount(line) {
  return /\$?\s*[\d,]+\.\d{2}/.test(line);
}

function extractAmounts(line) {
  return [...line.matchAll(/\$?\s*([\d,]+\.\d{2})/g)].map(m => ({
    value: parseAmount(m[1]),
    raw: m[0],
    index: m.index
  }));
}

function cleanDescription(desc) {
  let d = normalizeLine(desc)
    .replace(/^\*+/, "")
    .replace(/^[-–—]+/, "")
    .replace(/^\d+\s+X\s+/i, "")
    .replace(/\b\d+\.\d{2}\b/g, "")
    .replace(/\$\s*/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Quita códigos largos al inicio, pero conserva descripción posterior.
  d = d.replace(/^(?:SKU|COD|CÓD|ART|ITEM)?\s*[:#-]?\s*[A-Z0-9-]{6,}\s+/i, "").trim();

  return d;
}

function isLikelyDescriptionLine(line) {
  if (!line) return false;
  if (isNoiseLine(line)) return false;

  const l = line.trim();

  // Evita líneas que son solo importes, fechas, horas, cantidades o códigos.
  if (/^\$?\s*[\d,]+\.\d{2}$/.test(l)) return false;
  if (/^\d{1,4}$/.test(l)) return false;
  if (/^\d{2}[\/-]\d{2}[\/-]\d{2,4}$/.test(l)) return false;
  if (/^\d{1,2}:\d{2}/.test(l)) return false;
  if (/^[A-Z0-9-]{5,}$/.test(l) && !/[AEIOUÁÉÍÓÚÜÑ]/i.test(l)) return false;

  // Debe tener letras.
  if (!/[A-ZÁÉÍÓÚÜÑ]/i.test(l)) return false;

  return true;
}

function collectDescriptionFromPreviousLines(lines, amountLineIndex, currentBeforeAmount) {
  const parts = [];

  const currentClean = cleanDescription(currentBeforeAmount || "");
  if (isLikelyDescriptionLine(currentClean)) {
    parts.push(currentClean);
  }

  // Busca hasta 4 líneas anteriores; esto corrige OCR donde descripción queda arriba y monto abajo.
  for (let j = amountLineIndex - 1; j >= 0 && j >= amountLineIndex - 4; j--) {
    const candidate = normalizeLine(lines[j]);
    if (!candidate) continue;

    // Si aparece otra línea con monto antes, normalmente ya es otra partida.
    if (hasAmount(candidate) && j !== amountLineIndex - 1) break;

    if (!isLikelyDescriptionLine(candidate)) continue;

    const cleaned = cleanDescription(candidate);
    if (!cleaned) continue;

    // Evita repetir la misma línea.
    if (!parts.includes(cleaned)) {
      parts.unshift(cleaned);
    }
  }

  return cleanDescription(parts.join(" "));
}

function extractPossibleCode(line, descripcion) {
  const firstToken = String(descripcion || "").split(" ")[0] || "";
  if (/^[A-Z0-9-]{4,}$/.test(firstToken) && /\d/.test(firstToken)) return firstToken;

  const m = String(line || "").match(/\b(\d{5,14})\b/);
  return m ? m[1] : "";
}

function inferQuantityAndDescription(beforeAmount, importe) {
  let raw = normalizeLine(beforeAmount);
  let cantidad = 1;

  // Ej: "2 CINTA AISLAR" o "2.000 CINTA AISLAR"
  const qtyStart = raw.match(/^(\d+(?:\.\d{1,3})?)\s+(.*)$/);
  if (qtyStart) {
    const possibleQty = Number(qtyStart[1]);
    const rest = qtyStart[2].trim();

    // Evita tomar códigos de producto como cantidad.
    if (possibleQty > 0 && possibleQty < 1000 && rest.length > 2 && /[A-ZÁÉÍÓÚÜÑ]/i.test(rest)) {
      cantidad = possibleQty;
      raw = rest;
    }
  }

  return {
    cantidad: formatAmount(cantidad),
    descripcionParcial: cleanDescription(raw),
    precio_unitario: cantidad ? formatAmount(importe / cantidad) : importe
  };
}

function parseItemsGeneric(lines) {
  const items = [];

  for (let i = 0; i < lines.length; i++) {
    const line = normalizeLine(lines[i]);
    if (!line || isNoiseLine(line)) continue;

    const amounts = extractAmounts(line);
    if (!amounts.length) continue;

    // En una línea con varios montos, normalmente el último es importe de línea.
    const amountObj = amounts[amounts.length - 1];
    const importe = formatAmount(amountObj.value);

    if (!importe || importe < 0.01) continue;

    const beforeAmount = line.slice(0, amountObj.index).trim();
    const inferred = inferQuantityAndDescription(beforeAmount, importe);

    let descripcion = inferred.descripcionParcial;

    // Si la descripción está vacía o es demasiado débil, usa líneas anteriores.
    if (!isLikelyDescriptionLine(descripcion) || descripcion.length < 4) {
      descripcion = collectDescriptionFromPreviousLines(lines, i, beforeAmount);
    }

    // Si aún no hay descripción, intenta combinar línea anterior inmediata + actual.
    if (!descripcion || descripcion.length < 4) {
      const prev = i > 0 ? cleanDescription(lines[i - 1]) : "";
      const currentNoAmount = cleanDescription(beforeAmount);
      const combined = cleanDescription(`${prev} ${currentNoAmount}`);
      if (isLikelyDescriptionLine(combined)) descripcion = combined;
    }

    // Si de plano no hubo descripción, usa línea original limpia antes del monto o la línea completa sin el monto.
    if (!descripcion || descripcion.length < 4) {
      descripcion = cleanDescription(line.replace(amountObj.raw, ""));
    }

    if (!descripcion || descripcion.length < 4) {
      descripcion = "Descripción no detectada - revisar OCR";
    }

    items.push({
      linea_original: line,
      codigo: extractPossibleCode(line, descripcion),
      descripcion,
      cantidad: inferred.cantidad,
      precio_unitario: inferred.precio_unitario,
      importe,
      impuesto_estimado: 0,
      total_linea: importe
    });
  }

  return deduplicateItems(items);
}

function deduplicateItems(items) {
  const result = [];
  const seen = new Set();

  for (const item of items) {
    const key = `${item.descripcion}|${item.importe}|${item.linea_original}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
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
