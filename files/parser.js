/**
 * parser.js — Ticket Parser PRO v3
 * Robusto para cruce / conciliación bancaria.
 */

// ─── Normalización de texto ────────────────────────────────────────────────

function normalizeText(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function normalizeUpper(str) {
  return normalizeText(str).toUpperCase();
}

// ─── Detección de monto ────────────────────────────────────────────────────
// Soporta: $1,234.56 | 1234.56 | 1,234 | 1.234,56 | -$45.00 | 45,00

function parseAmount(line) {
  const s = String(line || "").replace(/\s+/g, " ");

  // Patrón principal: captura el ÚLTIMO número de la línea (columna de importe)
  const patterns = [
    /\$\s*(-?\d{1,3}(?:,\d{3})*\.\d{2})/,   // $1,234.56
    /\$\s*(-?\d{1,3}(?:\.\d{3})*,\d{2})/,    // $1.234,56 (europeo)
    /\$\s*(-?\d+\.\d{2})/,                    // $123.45
    /\$\s*(-?\d+,\d{2}(?!\d))/,               // $123,45
    /\$\s*(-?\d{1,3}(?:,\d{3})+)/,            // $1,234
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
    // último número numérico de cualquier forma
    const all = [...s.matchAll(/(-?\d[\d,\.]*\d|-?\d)/g)];
    if (all.length) raw = all[all.length - 1][1];
  }

  if (!raw) return 0;

  let clean = raw.replace(/[$\s]/g, "");

  const hasComma = clean.includes(",");
  const hasDot   = clean.includes(".");

  if (hasComma && hasDot) {
    const dotIdx   = clean.lastIndexOf(".");
    const commaIdx = clean.lastIndexOf(",");
    if (commaIdx > dotIdx) {
      // formato europeo: 1.234,56
      clean = clean.replace(/\./g, "").replace(",", ".");
    } else {
      // formato MX/US: 1,234.56
      clean = clean.replace(/,/g, "");
    }
  } else if (hasComma && !hasDot) {
    // podría ser separador de miles (1,234) o decimal (1,45)
    const parts = clean.split(",");
    const last  = parts[parts.length - 1];
    clean = last.length === 2 ? clean.replace(",", ".") : clean.replace(/,/g, "");
  }

  clean = clean.replace(/[^\d.-]/g, "");
  const n = Number(clean);
  return Number.isFinite(n) ? n : 0;
}

// ─── Tipo de línea ─────────────────────────────────────────────────────────

function detectLineType(line) {
  const l = normalizeUpper(line);

  if (/SUB\s*TOTAL/.test(l))                                    return "SUBTOTAL";
  if (/\bTOTAL\b/.test(l))                                      return "TOTAL";
  if (/\bIVA\b/.test(l))                                        return "IVA";
  if (/\bIEPS\b/.test(l))                                       return "IEPS";
  if (/IMPORTE/.test(l))                                        return "IMPORTE";
  if (/DESCUENTO|AHORRO|DESC\.?\s/.test(l))                     return "DESCUENTO";
  if (/CAMBIO|VUELTO/.test(l))                                  return "CAMBIO";
  if (/EFECTIVO/.test(l))                                       return "PAGO_EFECTIVO";
  if (/TARJETA|VISA|MASTERCARD|AMEX|CARNET|DEBITO|CREDITO/.test(l)) return "PAGO_TARJETA";
  if (/TICKET|FOLIO|FACTURA|CAJA|CAJERO|OPERACION/.test(l))    return "ENCABEZADO";
  if (/RFC/.test(l))                                            return "RFC";
  if (/FECHA|DATE/.test(l))                                     return "FECHA";

  return "RENGLON";
}

// ─── Extracción de cantidad × precio unitario ──────────────────────────────
// Detecta patrones: "2 x $45.00", "3pz 120.00", "1 PZA $99"

function extractQuantityAndUnit(line) {
  const l = normalizeText(line);

  const patterns = [
    /^(\d+(?:\.\d+)?)\s*[xX\*]\s*\$?([\d,\.]+)/,
    /^(\d+(?:\.\d+)?)\s*(?:pz|pza|pzas?|kg|lt|lts?|mts?|ml|gr|grs?)\.?\s+\$?([\d,\.]+)/i,
    /^(\d+(?:\.\d+)?)\s*@\s*\$?([\d,\.]+)/,
  ];

  for (const pat of patterns) {
    const m = l.match(pat);
    if (m) {
      return {
        cantidad: Number(m[1]) || 1,
        precio_unitario: parseAmount(m[2])
      };
    }
  }
  return { cantidad: null, precio_unitario: null };
}

// ─── Detectar últimos 4 dígitos de tarjeta ─────────────────────────────────

function extractCardLast4(text) {
  const patterns = [
    /(?:VISA|MASTERCARD|AMEX|DEBITO|CREDITO|TARJETA)[^\d]*(\d{4})/i,
    /\*{3,}\s*(\d{4})/,
    /X{3,}\s*(\d{4})/i,
    /(?:NO\.?\s*TARJETA|CARD)[^\d]*(\d{4})/i,
  ];
  const t = String(text || "");
  for (const pat of patterns) {
    const m = t.match(pat);
    if (m) return m[1];
  }
  return "";
}

// ─── Detectar método de pago general ──────────────────────────────────────

function detectPaymentMethod(text) {
  const t = normalizeUpper(text);
  if (/VISA/.test(t))         return "VISA";
  if (/MASTERCARD/.test(t))   return "MASTERCARD";
  if (/AMEX|AMERICAN EXPRESS/.test(t)) return "AMEX";
  if (/DEBITO/.test(t))       return "TARJETA_DEBITO";
  if (/CREDITO/.test(t))      return "TARJETA_CREDITO";
  if (/TARJETA/.test(t))      return "TARJETA";
  if (/EFECTIVO/.test(t))     return "EFECTIVO";
  if (/TRANSFERENCIA|SPEI/.test(t)) return "TRANSFERENCIA";
  if (/QR|CoDi/.test(t))      return "QR";
  return "";
}

// ─── Detectar folio/ticket ─────────────────────────────────────────────────

function extractFolio(text) {
  const patterns = [
    /(?:FOLIO|TICKET|FACTURA|OPERACION|TRANS\.?|TRANSACCION)[^\d]*([A-Z0-9-]{4,20})/i,
    /(?:NO\.?|NUM\.?|#)\s*([A-Z0-9-]{4,20})/i,
  ];
  const t = String(text || "");
  for (const pat of patterns) {
    const m = t.match(pat);
    if (m) return m[1].trim();
  }
  return "";
}

// ─── Detectar tienda ──────────────────────────────────────────────────────

const STORE_PATTERNS = [
  { name: "HOME DEPOT",       pattern: /HOME\s*DEPOT/ },
  { name: "WALMART",          pattern: /WALMART|WAL\s*MART/ },
  { name: "HEB",              pattern: /\bHEB\b|H-E-B/ },
  { name: "COSTCO",           pattern: /COSTCO/ },
  { name: "SAMS",             pattern: /SAM'?S|SAMS CLUB/ },
  { name: "STEREN",           pattern: /STEREN/ },
  { name: "SODIMAC",          pattern: /SODIMAC/ },
  { name: "FERRETERIA",       pattern: /FERRET/ },
  { name: "OXXO",             pattern: /\bOXXO\b/ },
  { name: "7-ELEVEN",         pattern: /7[- ]?ELEVEN|SEVEN\s*ELEVEN/ },
  { name: "ELEKTRA",          pattern: /ELEKTRA/ },
  { name: "LIVERPOOL",        pattern: /LIVERPOOL/ },
  { name: "COPPEL",           pattern: /COPPEL/ },
  { name: "SORIANA",          pattern: /SORIANA/ },
  { name: "CHEDRAUI",         pattern: /CHEDRAUI/ },
  { name: "BODEGA AURRERA",   pattern: /BODEGA\s*AURRERA|AURRERA/ },
  { name: "SUPERAMA",         pattern: /SUPERAMA/ },
  { name: "LA COMER",         pattern: /LA\s*COMER/ },
  { name: "MEGA",             pattern: /\bMEGA\b/ },
  { name: "VEMEX",            pattern: /VEMEX/ },
  { name: "ACE HARDWARE",     pattern: /ACE\s*HARDWARE/ },
  { name: "DO IT CENTER",     pattern: /DO\s*IT\s*CENTER/ },
];

function detectStore(text) {
  const t = normalizeUpper(text);
  for (const s of STORE_PATTERNS) {
    if (s.pattern.test(t)) return s.name;
  }
  // Intentar extraer primera línea no vacía como nombre de tienda
  const lines = text.replace(/\r/g, "\n").split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length > 0) {
    const first = lines[0].replace(/[^A-Za-zÀ-ÿ0-9 ]/g, "").trim();
    if (first.length >= 3 && first.length <= 40) return first.toUpperCase();
  }
  return "OTRO";
}

// ─── Extraer fecha y normalizarla a ISO ────────────────────────────────────

function extractDate(text) {
  const t = String(text || "");

  // Formatos: DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, DD/MM/YY
  const patterns = [
    { r: /(\d{4})-(\d{2})-(\d{2})/, iso: (m) => `${m[1]}-${m[2]}-${m[3]}` },
    { r: /(\d{2})[\/\-\.](\d{2})[\/\-\.](\d{4})/, iso: (m) => `${m[3]}-${m[2]}-${m[1]}` },
    { r: /(\d{2})[\/\-\.](\d{2})[\/\-\.](\d{2})(?!\d)/, iso: (m) => {
      const y = parseInt(m[3]) < 50 ? `20${m[3]}` : `19${m[3]}`;
      return `${y}-${m[2]}-${m[1]}`;
    }},
  ];

  for (const { r, iso } of patterns) {
    const m = t.match(r);
    if (m) {
      try {
        const candidate = iso(m);
        const d = new Date(candidate);
        if (!isNaN(d)) return candidate;
      } catch (_) {}
    }
  }
  return "";
}

// ─── Extraer hora ──────────────────────────────────────────────────────────

function extractTime(text) {
  const m = String(text || "").match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!m) return "";
  return `${m[1].padStart(2, "0")}:${m[2]}${m[3] ? ":" + m[3] : ""}${m[4] ? " " + m[4].toUpperCase() : ""}`;
}

// ─── Extraer RFC ───────────────────────────────────────────────────────────

function extractRFC(text) {
  const m = String(text || "").toUpperCase().match(/\b([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})\b/);
  return m ? m[1] : "";
}

// ─── Total desde líneas ────────────────────────────────────────────────────

function extractTotalFromLines(items) {
  // Prioridad: línea TOTAL con monto mayor
  const totals = items
    .filter(x => x.tipo_linea === "TOTAL" && x.monto_detectado > 0)
    .map(x => x.monto_detectado);
  if (totals.length) return Math.max(...totals);

  // Fallback: mayor monto general
  const amounts = items.map(x => x.monto_detectado).filter(x => x > 0);
  return amounts.length ? Math.max(...amounts) : 0;
}

// ─── Extraer monto pagado (para cruce bancario) ─────────────────────────────
// Busca línea de PAGO_TARJETA o PAGO_EFECTIVO

function extractPaymentAmount(items) {
  const payLine = items.find(x =>
    ["PAGO_TARJETA", "PAGO_EFECTIVO"].includes(x.tipo_linea) && x.monto_detectado > 0
  );
  return payLine ? payLine.monto_detectado : 0;
}

// ─── Hash simple para deduplicación ────────────────────────────────────────

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16).padStart(8, "0");
}

// ─── Parser principal ──────────────────────────────────────────────────────

function parseTicket(textRaw) {
  const raw = String(textRaw || "");

  const lines = raw
    .replace(/\r/g, "\n")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const items = lines.map((line, index) => {
    const amount    = parseAmount(line);
    const type      = detectLineType(line);
    const { cantidad, precio_unitario } = extractQuantityAndUnit(line);

    return {
      linea_numero:     index + 1,
      texto_original:   line,
      monto_detectado:  amount,
      tipo_linea:       type,
      cantidad:         cantidad !== null ? cantidad : "",
      precio_unitario:  precio_unitario !== null ? precio_unitario : "",

      // campos legacy para compatibilidad
      descripcion:      line,
      concepto:         line,
      importe:          amount,
      total_linea:      amount,
      linea_original:   line,
      codigo:           ""
    };
  });

  const store          = detectStore(raw);
  const rfc            = extractRFC(raw);
  const date           = extractDate(raw);
  const time           = extractTime(raw);
  const folio          = extractFolio(raw);
  const payment_method = detectPaymentMethod(raw);
  const card_last4     = extractCardLast4(raw);
  const total          = extractTotalFromLines(items);
  const monto_pagado   = extractPaymentAmount(items);

  // Monto para cruce bancario: preferir monto_pagado si existe, si no total
  const monto_cruce    = monto_pagado > 0 ? monto_pagado : total;

  // Referencia bancaria: tienda + fecha + últimos 4 + total (útil para buscar en estado de cuenta)
  const referencia_cruce = [store, date, card_last4 ? `*${card_last4}` : "", total ? `$${total}` : ""]
    .filter(Boolean).join(" | ");

  return {
    store,
    rfc,
    date,               // formato ISO YYYY-MM-DD cuando se detecta
    time,
    folio,
    payment_method,
    card_last4,
    subtotal:           0,
    iva:                0,
    ieps:               0,
    impuestos:          0,
    descuentos:         0,
    importe:            0,
    total,
    monto_pagado,
    monto_cruce,
    referencia_cruce,
    hash_ticket:        simpleHash(raw.slice(0, 500)),

    resumen_lineas: items.filter(x =>
      ["SUBTOTAL", "TOTAL", "IVA", "IEPS", "IMPORTE", "DESCUENTO", "CAMBIO",
       "PAGO_TARJETA", "PAGO_EFECTIVO"].includes(x.tipo_linea)
    ),
    items,
    raw_text: raw
  };
}

module.exports = { parseTicket, parseAmount, detectLineType, detectStore, extractDate, extractRFC };
