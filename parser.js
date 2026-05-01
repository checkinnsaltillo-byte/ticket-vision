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

function stripAccents(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normKey(str) {
  return stripAccents(str)
    .toUpperCase()
    .replace(/[^\w$%. ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectStore(text) {
  const t = normKey(text);

  if (t.includes("VEMEX")) return "VEMEX";
  if (t.includes("HOME DEPOT") || t.includes("THE HOME DEPOT")) return "HOME DEPOT";
  if (t.includes("WALMART")) return "WALMART";
  if (t.includes("HEB") || t.includes("H E B")) return "HEB";
  if (t.includes("COSTCO")) return "COSTCO";
  if (t.includes("SAMS") || t.includes("SAM S")) return "SAMS";
  if (t.includes("LOWE")) return "LOWES";
  if (t.includes("STEREN")) return "STEREN";
  if (t.includes("OFFICE DEPOT")) return "OFFICE DEPOT";

  return "OTRO";
}

function parseAmount(value) {
  if (!value) return 0;
  const raw = String(value).trim();

  // Soporta 1,234.56 y 1.234,56, aunque tickets MX suelen venir como 1,234.56
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
  const t = normKey(text);

  if (t.includes("EFECTIVO")) return "Efectivo";
  if (t.includes("TARJETA") || t.includes("VISA") || t.includes("MASTERCARD") || t.includes("CREDITO") || t.includes("DEBITO")) return "Tarjeta";
  if (t.includes("TRANSFERENCIA") || t.includes("SPEI")) return "Transferencia";
  if (t.includes("PAYPAL")) return "PayPal";

  return "";
}

function extractAmounts(line) {
  // Detecta $1,234.56, 1234.56, 1,234, 123,00
  const matches = [];
  const rx = /\$?\s*(-?\d{1,3}(?:,\d{3})*(?:\.\d{2})|-?\d+(?:\.\d{2})|-?\d+,\d{2})/g;
  let m;

  while ((m = rx.exec(line)) !== null) {
    const value = parseAmount(m[1]);
    if (!Number.isNaN(value)) {
      matches.push({
        value,
        raw: m[0],
        index: m.index
      });
    }
  }

  return matches;
}

function getLastAmount(line) {
  const amounts = extractAmounts(line);
  if (!amounts.length) return null;
  return amounts[amounts.length - 1];
}

function looksLikeSummaryLabel(line) {
  const l = normKey(line);

  return (
    /\bSUB\s*TOTAL\b/.test(l) ||
    /\bSUBTOTAL\b/.test(l) ||
    /\bTOTAL\b/.test(l) ||
    /\bTOTAL\s+A\s+PAGAR\b/.test(l) ||
    /\bGRAN\s+TOTAL\b/.test(l) ||
    /\bIMPORTE\s+TOTAL\b/.test(l) ||
    /\bIMPORTE\b/.test(l) ||
    /\bIVA\b/.test(l) ||
    /\bI\s*V\s*A\b/.test(l) ||
    /\bIEPS\b/.test(l) ||
    /\bIMPUESTO\b/.test(l) ||
    /\bIMPUESTOS\b/.test(l) ||
    /\bDESCUENTO\b/.test(l) ||
    /\bDESC\b/.test(l) ||
    /\bRETENCION\b/.test(l) ||
    /\bRET IVA\b/.test(l) ||
    /\bRET ISR\b/.test(l)
  );
}

function classifySummaryLine(line, previousLine = "", nextLine = "") {
  const combined = normKey(`${previousLine} ${line} ${nextLine}`);
  const current = normKey(line);

  if (/\bSUB\s*TOTAL\b/.test(combined) || /\bSUBTOTAL\b/.test(combined)) return "subtotal";
  if (/\bRET\s*IVA\b/.test(combined) || /IVA\s+RETENIDO|RETENCION\s+IVA/.test(combined)) return "iva_retenido";
  if (/\bRET\s*ISR\b/.test(combined) || /ISR\s+RETENIDO|RETENCION\s+ISR/.test(combined)) return "isr_retenido";
  if (/\bIVA\b/.test(combined) || /\bI\s*V\s*A\b/.test(combined)) return "iva";
  if (/\bIEPS\b/.test(combined)) return "ieps";
  if (/\bIMPUESTO\b/.test(combined) || /\bIMPUESTOS\b/.test(combined)) return "impuestos";
  if (/\bDESCUENTO\b/.test(combined) || /\bDESC\b/.test(combined)) return "descuentos";

  // IMPORTANTE: "Importe" a veces es etiqueta de total, pero no siempre.
  if (/\bIMPORTE\s+TOTAL\b/.test(combined)) return "total";
  if (/\bTOTAL\s+A\s+PAGAR\b/.test(combined) || /\bGRAN\s+TOTAL\b/.test(combined)) return "total";
  if (/\bTOTAL\b/.test(current)) return "total";
  if (/\bIMPORTE\b/.test(current) && !/\bUNITARIO\b|\bPRECIO\b/.test(current)) return "importe";

  return "";
}

function extractSummaryAmounts(text) {
  const summary = {
    subtotal: 0,
    iva: 0,
    ieps: 0,
    impuestos: 0,
    iva_retenido: 0,
    isr_retenido: 0,
    descuentos: 0,
    importe: 0,
    total: 0,
    resumen_lineas: []
  };

  const lines = text.split("\n").map(normalizeLine).filter(Boolean);

  // 1) Detecta líneas con etiqueta y monto en la misma línea.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = i > 0 ? lines[i - 1] : "";
    const next = i < lines.length - 1 ? lines[i + 1] : "";
    const label = classifySummaryLine(line, prev, next);

    if (!label) continue;

    let amountObj = getLastAmount(line);

    // 2) Si la etiqueta está separada del monto, busca en la línea siguiente.
    if (!amountObj && next) {
      const nextAmount = getLastAmount(next);
      const nextHasLabel = looksLikeSummaryLabel(next);
      if (nextAmount && !nextHasLabel) amountObj = nextAmount;
    }

    // 3) Si el OCR puso monto arriba y etiqueta abajo.
    if (!amountObj && prev) {
      const prevAmount = getLastAmount(prev);
      const prevHasLabel = looksLikeSummaryLabel(prev);
      if (prevAmount && !prevHasLabel) amountObj = prevAmount;
    }

    if (!amountObj) continue;

    const value = formatAmount(amountObj.value);

    if (label === "subtotal") summary.subtotal = value;
    if (label === "iva") summary.iva = value;
    if (label === "ieps") summary.ieps = value;
    if (label === "impuestos") summary.impuestos = value;
    if (label === "iva_retenido") summary.iva_retenido = value;
    if (label === "isr_retenido") summary.isr_retenido = value;
    if (label === "descuentos") summary.descuentos = value;
    if (label === "importe") summary.importe = Math.max(summary.importe || 0, value);
    if (label === "total") summary.total = Math.max(summary.total || 0, value);

    summary.resumen_lineas.push({
      tipo: label,
      descripcion: line,
      monto: value,
      linea_original: line
    });
  }

  if (!summary.impuestos) {
    summary.impuestos = formatAmount((summary.iva || 0) + (summary.ieps || 0));
  }

  // Si no encontró total pero sí importe, usa importe como total candidato.
  if (!summary.total && summary.importe) {
    summary.total = summary.importe;
  }

  // Último recurso: tomar el mayor monto cercano a una línea de total.
  if (!summary.total) {
    const candidates = [];
    for (let i = 0; i < lines.length; i++) {
      const l = normKey(lines[i]);
      if (!/\bTOTAL\b|TOTAL A PAGAR|GRAN TOTAL|IMPORTE TOTAL/.test(l)) continue;

      for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j++) {
        const amount = getLastAmount(lines[j]);
        if (amount) candidates.push(amount.value);
      }
    }
    if (candidates.length) summary.total = formatAmount(Math.max(...candidates));
  }

  return {
    subtotal: formatAmount(summary.subtotal),
    iva: formatAmount(summary.iva),
    ieps: formatAmount(summary.ieps),
    impuestos: formatAmount(summary.impuestos),
    iva_retenido: formatAmount(summary.iva_retenido),
    isr_retenido: formatAmount(summary.isr_retenido),
    descuentos: formatAmount(summary.descuentos),
    importe: formatAmount(summary.importe),
    total: formatAmount(summary.total),
    resumen_lineas: summary.resumen_lineas
  };
}

function isSummaryOrPaymentLine(line) {
  const l = normKey(line);
  return (
    looksLikeSummaryLabel(line) ||
    /CAMBIO|PAGO|PAGADO|EFECTIVO|TARJETA|AUTORIZ|APROBADA|BANCO|CUENTA|DEBITO|CREDITO|AHORRO|MONEDERO|SALDO|VISA|MASTERCARD/.test(l)
  );
}

function isHeaderOrNoiseLine(line) {
  const l = normKey(line);
  return (
    l.length < 2 ||
    /RFC|REGIMEN|FACTURA|UUID|SAT|CERTIFICADO|LUGAR DE EXPEDICI|GRACIAS|WWW|HTTP|TEL|TELEFONO|CLIENTE|CAJERO|SUCURSAL|DOMICILIO|AV |COL |C P |CP |FECHA|HORA|FOLIO|TICKET|RECIBO/.test(l)
  );
}

function isNoiseLine(line) {
  return isHeaderOrNoiseLine(line) || isSummaryOrPaymentLine(line);
}

function hasAmount(line) {
  return extractAmounts(line).length > 0;
}

function cleanDescription(desc) {
  let d = normalizeLine(desc)
    .replace(/^\*+/, "")
    .replace(/^[-–—]+/, "")
    .replace(/^\d+\s+X\s+/i, "")
    .replace(/\$?\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})/g, "")
    .replace(/\$?\s*\d+(?:\.\d{2})/g, "")
    .replace(/\$\s*/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  d = d.replace(/^(?:SKU|COD|CÓD|ART|ITEM)?\s*[:#-]?\s*[A-Z0-9-]{6,}\s+/i, "").trim();

  return d;
}

function isLikelyDescriptionLine(line) {
  if (!line) return false;
  if (isNoiseLine(line)) return false;

  const l = line.trim();

  if (/^\$?\s*[\d,]+\.\d{2}$/.test(l)) return false;
  if (/^\d{1,4}$/.test(l)) return false;
  if (/^\d{2}[\/-]\d{2}[\/-]\d{2,4}$/.test(l)) return false;
  if (/^\d{1,2}:\d{2}/.test(l)) return false;
  if (/^[A-Z0-9-]{5,}$/.test(l) && !/[AEIOUÁÉÍÓÚÜÑ]/i.test(l)) return false;
  if (!/[A-ZÁÉÍÓÚÜÑ]/i.test(l)) return false;

  return true;
}

function collectDescriptionFromPreviousLines(lines, amountLineIndex, currentBeforeAmount) {
  const parts = [];

  const currentClean = cleanDescription(currentBeforeAmount || "");
  if (isLikelyDescriptionLine(currentClean)) {
    parts.push(currentClean);
  }

  for (let j = amountLineIndex - 1; j >= 0 && j >= amountLineIndex - 5; j--) {
    const candidate = normalizeLine(lines[j]);
    if (!candidate) continue;

    if (looksLikeSummaryLabel(candidate)) break;

    if (hasAmount(candidate) && j !== amountLineIndex - 1) break;

    if (!isLikelyDescriptionLine(candidate)) continue;

    const cleaned = cleanDescription(candidate);
    if (!cleaned) continue;

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

  const qtyStart = raw.match(/^(\d+(?:\.\d{1,3})?)\s+(.*)$/);
  if (qtyStart) {
    const possibleQty = Number(qtyStart[1]);
    const rest = qtyStart[2].trim();

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
    if (!line) continue;

    // Muy importante: líneas de Total / Importe / IVA se excluyen de partidas
    // porque se procesan como resumen del ticket.
    if (isNoiseLine(line)) continue;

    const amounts = extractAmounts(line);
    if (!amounts.length) continue;

    const amountObj = amounts[amounts.length - 1];
    const importe = formatAmount(amountObj.value);

    if (!importe || importe < 0.01) continue;

    const beforeAmount = line.slice(0, amountObj.index).trim();
    const inferred = inferQuantityAndDescription(beforeAmount, importe);

    let descripcion = inferred.descripcionParcial;

    if (!isLikelyDescriptionLine(descripcion) || descripcion.length < 4) {
      descripcion = collectDescriptionFromPreviousLines(lines, i, beforeAmount);
    }

    if (!descripcion || descripcion.length < 4) {
      const prev = i > 0 ? cleanDescription(lines[i - 1]) : "";
      const currentNoAmount = cleanDescription(beforeAmount);
      const combined = cleanDescription(`${prev} ${currentNoAmount}`);
      if (isLikelyDescriptionLine(combined)) descripcion = combined;
    }

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
    iva_retenido: summary.iva_retenido,
    isr_retenido: summary.isr_retenido,
    descuentos: summary.descuentos,
    importe: summary.importe,
    total: summary.total,
    resumen_lineas: summary.resumen_lineas,

    items,
    raw_text: text
  };
}

module.exports = parseTicket;
