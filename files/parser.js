/**
 * parser.js — Ticket Parser PRO v6
 * Detección de sección de productos por marcadores estructurales.
 */

// ─── Normalización ─────────────────────────────────────────────────────────

function normalizeText(str) {
  return String(str || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

function normalizeUpper(str) {
  return normalizeText(str).toUpperCase();
}

// ─── Detección de monto ────────────────────────────────────────────────────

function parseAmount(line) {
  const s = String(line || "").replace(/\s+/g, " ");
  const patterns = [
    /\$\s*(-?\d{1,3}(?:,\d{3})*\.\d{2})/,
    /\$\s*(-?\d+\.\d{2})/,
    /\$\s*(-?\d{1,3}(?:,\d{3})+)/,
    /(-?\d{1,3}(?:,\d{3})*\.\d{2})(?:\s*$|(?=\s))/,
    /(-?\d+\.\d{2})(?:\s*$|(?=\s))/,
    /(-?\d{1,3}(?:,\d{3})+)(?:\s*$|(?=\s))/,
  ];
  let raw = null;
  for (const pat of patterns) {
    const m = s.match(pat);
    if (m) { raw = m[1]; break; }
  }
  if (!raw) {
    const all = [...s.matchAll(/(-?\d[\d,.]*\d|-?\d)/g)];
    if (all.length) raw = all[all.length - 1][1];
  }
  if (!raw) return 0;
  let clean = raw.replace(/[$\s]/g, "");
  const hasComma = clean.includes(","), hasDot = clean.includes(".");
  if (hasComma && hasDot) {
    clean = clean.lastIndexOf(",") > clean.lastIndexOf(".")
      ? clean.replace(/\./g, "").replace(",", ".")
      : clean.replace(/,/g, "");
  } else if (hasComma && !hasDot) {
    const last = clean.split(",").pop();
    clean = last.length === 2 ? clean.replace(",", ".") : clean.replace(/,/g, "");
  }
  const n = Number(clean.replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

// ─── Extracción de cantidad × precio unitario ──────────────────────────────

function extractQuantityAndUnit(line) {
  const l = normalizeText(line);
  const patterns = [
    /^(\d+(?:\.\d+)?)\s*[xX*]\s*(?:\w+\s+)?\$?([\d,.]+)/,
    /^(\d+(?:\.\d+)?)\s*(?:pz|pza|pzas?|kg|lt|lts?|mts?|ml|gr|cu|pza?)\.?\s+\$?([\d,.]+)/i,
    /^(\d+(?:\.\d+)?)\s*@\s*\$?([\d,.]+)/,
  ];
  for (const pat of patterns) {
    const m = l.match(pat);
    if (m) return { cantidad: Number(m[1]) || 1, precio_unitario: parseAmount(m[2]) };
  }
  return { cantidad: null, precio_unitario: null };
}

// ─── Helpers de detección de metadata ─────────────────────────────────────

function extractCardLast4(text) {
  const patterns = [
    /(?:VISA|MASTERCARD|AMEX|DEBITO|CREDITO|TARJETA|BANC)[^\d]*(\d{4})/i,
    /\*{3,}\s*(\d{4})/,
    /X{3,}\s*(\d{4})/i,
  ];
  for (const pat of patterns) {
    const m = String(text || "").match(pat);
    if (m) return m[1];
  }
  return "";
}

function detectPaymentMethod(text) {
  const t = normalizeUpper(text);
  if (/VISA/.test(t))                  return "VISA";
  if (/MASTERCARD/.test(t))            return "MASTERCARD";
  if (/AMEX|AMERICAN EXPRESS/.test(t)) return "AMEX";
  if (/DEBITO/.test(t))                return "TARJETA_DEBITO";
  if (/CREDITO/.test(t))               return "TARJETA_CREDITO";
  if (/\bBANC\b/.test(t))              return "TARJETA_BANCO";
  if (/TARJETA/.test(t))               return "TARJETA";
  if (/EFECTIVO/.test(t))              return "EFECTIVO";
  if (/TRANSFERENCIA|SPEI/.test(t))    return "TRANSFERENCIA";
  if (/QR|CODI/.test(t))              return "QR";
  return "";
}

function extractFolio(text) {
  const patterns = [
    /(?:FOLIO|TICKET|FACTURA|TRANSACCION|NO\.?\s*TRANSACC?)[^\d]*([A-Z0-9-]{4,20})/i,
    /(?:NO\.?|NUM\.?|#)\s*([A-Z0-9-]{4,20})/i,
  ];
  for (const pat of patterns) {
    const m = String(text || "").match(pat);
    if (m) return m[1].trim();
  }
  return "";
}

const STORE_PATTERNS = [
  { name: "HOME DEPOT",     pattern: /HOME\s*DEPOT/ },
  { name: "SODIMAC",        pattern: /SODIMAC/ },
  { name: "WALMART",        pattern: /WALMART|WAL\s*MART/ },
  { name: "HEB",            pattern: /\bHEB\b|H-E-B/ },
  { name: "COSTCO",         pattern: /COSTCO/ },
  { name: "SAMS",           pattern: /SAM'?S\s*CLUB/ },
  { name: "STEREN",         pattern: /STEREN/ },
  { name: "FERRETERIA",     pattern: /FERRET/ },
  { name: "OXXO",           pattern: /\bOXXO\b/ },
  { name: "7-ELEVEN",       pattern: /7[- ]?ELEVEN/ },
  { name: "LIVERPOOL",      pattern: /LIVERPOOL/ },
  { name: "COPPEL",         pattern: /COPPEL/ },
  { name: "SORIANA",        pattern: /SORIANA/ },
  { name: "CHEDRAUI",       pattern: /CHEDRAUI/ },
  { name: "BODEGA AURRERA", pattern: /BODEGA\s*AURRERA|AURRERA/ },
  { name: "LA COMER",       pattern: /LA\s*COMER/ },
  { name: "ACE HARDWARE",   pattern: /ACE\s*HARDWARE/ },
];

function detectStore(text) {
  const t = normalizeUpper(text);
  for (const s of STORE_PATTERNS) {
    if (s.pattern.test(t)) return s.name;
  }
  const lines = text.replace(/\r/g, "\n").split("\n").map(l => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 5)) {
    const clean = line.replace(/[^A-Za-zÀ-ÿ0-9 ]/g, "").trim();
    if (clean.length >= 3 && clean.length <= 40 && /[A-Za-z]{3,}/.test(clean))
      return clean.toUpperCase();
  }
  return "OTRO";
}

function extractDate(text) {
  const t = String(text || "");
  const patterns = [
    { r: /(\d{4})-(\d{2})-(\d{2})/,                iso: m => `${m[1]}-${m[2]}-${m[3]}` },
    { r: /(\d{2})[/\-.](\d{2})[/\-.](\d{4})/,      iso: m => `${m[3]}-${m[2]}-${m[1]}` },
    { r: /(\d{2})[/\-.](\d{2})[/\-.](\d{2})(?!\d)/, iso: m => {
      const y = parseInt(m[3]) < 50 ? `20${m[3]}` : `19${m[3]}`;
      return `${y}-${m[2]}-${m[1]}`;
    }},
  ];
  for (const { r, iso } of patterns) {
    const m = t.match(r);
    if (m) { try { if (!isNaN(new Date(iso(m)))) return iso(m); } catch (_) {} }
  }
  return "";
}

function extractTime(text) {
  const m = String(text || "").match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!m) return "";
  return `${m[1].padStart(2, "0")}:${m[2]}${m[3] ? ":" + m[3] : ""}${m[4] ? " " + m[4].toUpperCase() : ""}`;
}

function extractRFC(text) {
  const m = String(text || "").toUpperCase().match(/\b([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})\b/);
  return m ? m[1] : "";
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16).padStart(8, "0");
}

// ─── Limpiar descripción ───────────────────────────────────────────────────

function cleanDescription(text) {
  let s = text.trim();
  s = s.replace(/\s*\$?\s*-?\d{1,3}(?:[,.]\d{3})*(?:[,.]\d{2})?\s*-?\s*$/, "");
  s = s.replace(/^\d+(?:\.\d+)?\s*(?:[xX*]|pz|pza|pzas?|kg|lt|cu)\s*/i, "");
  return s.trim();
}

// ─── Detección de sección de productos ────────────────────────────────────
// Identifica el rango de líneas donde están los productos, no la metadata.

function findProductSection(lines) {
  // Encabezados de tabla que señalan el inicio de la lista de productos
  const tableHeaders = [
    /\bSKU\b.*\b(?:CANTIDAD|PRECIO)\b/i,
    /\bDESCRIPCI[OÓ]N\b.*\b(?:PRECIO|MONTO|IMPORTE)\b/i,
    /\b(?:ARTICULO|PRODUCTO)\b.*\b(?:CANTIDAD|PRECIO|TOTAL)\b/i,
    /\bCONCEPTO\b.*\b(?:PRECIO|IMPORTE|MONTO)\b/i,
    /\bCANTIDAD\b.*\b(?:PRECIO|IMPORTE)\b/i,
  ];

  // Marcadores de fin de sección de productos
  const sectionEnd = [
    /TOTAL\s+ARTICULOS?/i,
    /SUB\s*TOTAL/i,
    /TOTAL\s+(?:M\.?N\.?|\$|IVA)/i,
    /FORMAS?\s+DE\s+PAGO/i,
    /SON\s+[A-Z]{4,}/i,
  ];

  let startIdx = -1;
  let endIdx   = lines.length;

  // 1. Buscar encabezado de tabla explícito (Sodimac, HEB, Walmart, etc.)
  for (let i = 0; i < lines.length; i++) {
    if (tableHeaders.some(p => p.test(lines[i]))) {
      startIdx = i + 1;
      // Saltar líneas separadoras inmediatamente después del encabezado
      while (startIdx < lines.length && /^[-=.\s]{3,}$/.test(lines[startIdx])) startIdx++;
      break;
    }
  }

  // 2. Fallback: usar el último separador de la zona de encabezado (Home Depot, OXXO, etc.)
  if (startIdx === -1) {
    let lastSep = -1;
    for (let i = 0; i < lines.length; i++) {
      if (sectionEnd.some(p => p.test(lines[i]))) break; // no buscar más allá del final
      if (/^[*\-=]{5,}$/.test(lines[i].trim())) lastSep = i;
    }
    if (lastSep !== -1) startIdx = lastSep + 1;
  }

  if (startIdx === -1) startIdx = 0;

  // Encontrar el fin de la sección de productos
  for (let i = startIdx; i < lines.length; i++) {
    if (sectionEnd.some(p => p.test(lines[i]))) { endIdx = i; break; }
  }

  return { startIdx, endIdx };
}

// ─── Extracción de productos dentro de la sección ─────────────────────────

function extractProductsFromSection(sectionLines) {
  const products  = [];
  const tieneDesc = txt => /[A-Za-záéíóúÁÉÍÓÚñÑ]{3,}/.test(txt);
  const soloNum   = txt => /^[\d,.\s$]+$/.test(txt.trim()) && parseAmount(txt) > 0;

  let i = 0;
  while (i < sectionLines.length) {
    const raw = sectionLines[i].trim();
    if (!raw) { i++; continue; }

    const l = normalizeUpper(raw);

    // Saltar separadores visuales
    if (/^[-=.*\s]{3,}$/.test(raw)) { i++; continue; }

    // Saltar códigos de barra (TOME, números largos)
    if (/[-\s]TOME\s*$/.test(l) || /^\d{8,}$/.test(raw)) { i++; continue; }

    // Saltar líneas de solo símbolo "$" o equivalentes
    if (/^[\$\s]+$/.test(raw)) { i++; continue; }

    // ── Formato con SKU explícito (Sodimac, HEB) ──────────────────────────
    // Línea: SKU + "N x UNIDAD PRECIO" — ej. "25415    2 x  CU   33.40"
    const skuLine = raw.match(/^(\d{4,6})\s+(\d+)\s*[xX]\s*(\w{1,4})\s+([\d,.]+)\s*$/);
    if (skuLine) {
      const cantidad        = Number(skuLine[2]) || 1;
      const precio_unitario = parseAmount(skuLine[4]);
      i++;

      // Siguiente línea no numérica = descripción
      let descripcion = "";
      while (i < sectionLines.length) {
        const nx = sectionLines[i].trim();
        if (!nx || /^[-=.*]{3,}$/.test(nx)) { i++; continue; }
        if (tieneDesc(nx) && !/^\d{4,6}/.test(nx)) {
          descripcion = cleanDescription(nx);
          i++;
        }
        break;
      }

      // Siguiente línea numérica = total de la línea
      let monto = 0;
      if (i < sectionLines.length && soloNum(sectionLines[i])) {
        monto = parseAmount(sectionLines[i]);
        i++;
      }

      // Saltar línea de marca (una sola palabra mayúscula, sin números)
      if (i < sectionLines.length && /^[A-ZÁÉÍÓÚ]{3,}$/.test(sectionLines[i].trim())) i++;

      if (descripcion || precio_unitario) {
        products.push({
          descripcion:     descripcion || `SKU ${skuLine[1]}`,
          cantidad,
          precio_unitario,
          monto:           monto || precio_unitario * cantidad
        });
      }
      continue;
    }

    // ── Formato libre (Home Depot, OXXO, genérico) ────────────────────────
    if (tieneDesc(raw)) {
      // El código de modelo empieza con letra+dígitos (D47, P123...) → saltar
      if (/^[A-Z]\d{2,}\s+[A-Z]/.test(raw)) { i++; continue; }

      let descripcion     = cleanDescription(raw);
      let monto           = parseAmount(raw); // a veces el precio está en la misma línea
      let cantidad        = null;
      let precio_unitario = null;

      const { cantidad: q, precio_unitario: p } = extractQuantityAndUnit(raw);
      if (q) { cantidad = q; precio_unitario = p; }

      // Si no hay monto en la misma línea, buscar en las siguientes (máx 3)
      if (!monto) {
        for (let j = i + 1; j < Math.min(i + 4, sectionLines.length); j++) {
          const nx = sectionLines[j].trim();
          if (!nx || /^[\$\s]+$/.test(nx)) continue;
          if (tieneDesc(nx) && !/^[A-Z]\d{2,}/.test(nx)) break; // siguiente producto
          const a = parseAmount(nx);
          if (a > 0) { monto = a; break; }
        }
      }

      // Saltar si la descripción quedó vacía después de limpiar
      if (descripcion.length >= 2) {
        products.push({
          descripcion,
          cantidad:        cantidad        ?? "",
          precio_unitario: precio_unitario ?? "",
          monto:           monto           || ""
        });
      }
    }

    i++;
  }

  return products;
}

// ─── Extracción financiera con lookahead ───────────────────────────────────

function resolveFinancials(lines) {
  const usados = new Set();

  function buscarMonto(patron) {
    for (let i = 0; i < lines.length; i++) {
      if (!patron.test(normalizeUpper(lines[i]))) continue;
      const inline = parseAmount(lines[i]);
      if (inline > 0) return inline;
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const a = parseAmount(lines[j]);
        if (a > 0) { usados.add(j); return a; }
      }
    }
    return 0;
  }

  const subtotal  = buscarMonto(/SUB\s*TOTAL/i);
  const iva       = buscarMonto(/\bIVA\b/i);
  const ieps      = buscarMonto(/\bIEPS\b/i);
  const total     = buscarMonto(/\bTOTAL\b(?!\s+ARTICULO)/i);
  const descuentos = lines.reduce((s, l) => {
    if (/DESCUENTO|AHORRO/i.test(l)) { const a = parseAmount(l); return s + a; }
    return s;
  }, 0);

  return { subtotal, iva, ieps, total, descuentos, usados };
}

// ─── Parser principal ──────────────────────────────────────────────────────

function parseTicket(textRaw) {
  const raw = String(textRaw || "");

  const lines = raw
    .replace(/\r/g, "\n")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0);

  // Metadatos globales (se extraen del texto completo)
  const store          = detectStore(raw);
  const rfc            = extractRFC(raw);
  const date           = extractDate(raw);
  const time           = extractTime(raw);
  const folio          = extractFolio(raw);
  const payment_method = detectPaymentMethod(raw);
  const card_last4     = extractCardLast4(raw);

  // Finanzas con lookahead sobre todas las líneas
  const { subtotal, iva, ieps, total, descuentos } = resolveFinancials(lines);

  const monto_pagado = 0; // calculado desde finanzas si aplica
  const monto_cruce  = total;
  const referencia_cruce = [store, date, card_last4 ? `*${card_last4}` : "", total ? `$${total}` : ""]
    .filter(Boolean).join(" | ");

  // Detectar sección de productos y extraer solo de ahí
  const { startIdx, endIdx } = findProductSection(lines);
  const sectionLines = lines.slice(startIdx, endIdx);
  const rawProductos = extractProductsFromSection(sectionLines);

  // Agregar número de línea relativo
  const productos = rawProductos.map((p, i) => ({
    linea_numero:    startIdx + i + 1,
    descripcion:     p.descripcion,
    cantidad:        p.cantidad,
    precio_unitario: p.precio_unitario,
    monto:           p.monto
  }));

  return {
    store, rfc, date, time, folio, payment_method, card_last4,
    subtotal, iva, ieps, descuentos, total,
    monto_pagado, monto_cruce, referencia_cruce,
    hash_ticket: simpleHash(raw.slice(0, 500)),
    productos,
    raw_text: raw
  };
}

module.exports = { parseTicket, parseAmount, detectStore, extractDate, extractRFC };
