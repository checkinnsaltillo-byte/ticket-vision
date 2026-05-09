/**
 * parser.js — Ticket Parser PRO v5
 */

// ─── Normalización ─────────────────────────────────────────────────────────

function normalizeText(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

function normalizeUpper(str) {
  return normalizeText(str).toUpperCase();
}

// ─── Detección de monto ────────────────────────────────────────────────────

function parseAmount(line) {
  const s = String(line || "").replace(/\s+/g, " ");
  const patterns = [
    /\$\s*(-?\d{1,3}(?:,\d{3})*\.\d{2})/,
    /\$\s*(-?\d{1,3}(?:\.\d{3})*,\d{2})/,
    /\$\s*(-?\d+\.\d{2})/,
    /\$\s*(-?\d+,\d{2}(?!\d))/,
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
  const hasComma = clean.includes(",");
  const hasDot   = clean.includes(".");
  if (hasComma && hasDot) {
    clean = clean.lastIndexOf(",") > clean.lastIndexOf(".")
      ? clean.replace(/\./g, "").replace(",", ".")
      : clean.replace(/,/g, "");
  } else if (hasComma && !hasDot) {
    const last = clean.split(",").pop();
    clean = last.length === 2 ? clean.replace(",", ".") : clean.replace(/,/g, "");
  }
  clean = clean.replace(/[^\d.-]/g, "");
  const n = Number(clean);
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

// ─── Tipo de línea ─────────────────────────────────────────────────────────

function detectLineType(line) {
  const l   = normalizeUpper(line);
  const raw = line.trim();

  // Separadores / muy cortas
  if (/^[*\-=_#~.]{3,}$/.test(raw))                                 return "METADATA";
  if (raw.length < 3)                                                return "METADATA";

  // Financieros (antes de metadata para no solapar)
  if (/SUB\s*TOTAL/.test(l))                                         return "SUBTOTAL";
  if (/\bTOTAL\b/.test(l))                                           return "TOTAL";
  if (/\bIVA\b/.test(l))                                             return "IVA";
  if (/\bIEPS\b/.test(l))                                            return "IEPS";
  if (/\bIMPORTE\b/.test(l))                                         return "IMPORTE";
  if (/DESCUENTO|AHORRO/.test(l))                                    return "DESCUENTO";
  if (/CAMBIO|VUELTO/.test(l))                                       return "CAMBIO";
  if (/EFECTIVO/.test(l))                                            return "PAGO_EFECTIVO";
  if (/TARJETA|VISA|MASTERCARD|AMEX|CARNET|DEBITO|CREDITO|\bBANC\b/.test(l)) return "PAGO_TARJETA";

  // Metadata: datos fiscales y de tienda
  if (/\bRFC\b/.test(l))                                             return "METADATA";
  if (/\b(AV\.|BLVD\.|COL\.|COLONIA|C\.P\.|CP\s+\d{5})/.test(l))  return "METADATA";
  if (/TEL[EF]?[:\s(]|TELS?\s|TELEFONO|\(\d{3}\)/.test(l))         return "METADATA";
  if (/\b(SUC\.|SUCURSAL)\b/.test(l))                                return "METADATA";
  if (/REGIMEN\s+(FISCAL|GENERAL|SIMPLIF)/.test(l))                  return "METADATA";
  if (/\b(CAJERO|CAJA\s+\d|AUTOCOBRO|CONTADO)\b/.test(l))           return "METADATA";
  if (/SON\s+[A-Z]{4,}/.test(l))                                     return "METADATA";
  if (/M\.N\.\s*$/.test(l))                                          return "METADATA";
  if (/FORMAS?\s+DE\s+PAGO/.test(l))                                 return "METADATA";
  if (/^[\$\s.]+$/.test(raw))                                        return "METADATA";
  if (/TOTAL\s+ART/.test(l))                                         return "METADATA";
  if (/[-\s]TOME\s*$/.test(l))                                       return "METADATA";
  if (/^\d{8,}/.test(raw))                                           return "METADATA";
  if (/S\.\s*DE\s*R\.L\.|S\.A\.\s*DE\s*C\.V\./.test(l))            return "METADATA";
  if (/^(FOLIO|FACTURA|TICKET\s+(NO|NUM|#)|OPERACION)\b/.test(l))   return "METADATA";
  if (/\b(RESIDENCIAL|RESIDENCI)\b/.test(l))                         return "METADATA";
  if (/^(THE|ESR|Mt|OK|ST)\s*$/.test(raw))                           return "METADATA";
  // Códigos de producto retail: letra + 2+ dígitos al inicio (D47, P123...)
  if (/^[A-Z]\d{2,}\s+[A-Z]/.test(raw))                             return "METADATA";
  // Pie de ticket: aprobación, códigos técnicos, URLs, agradecimientos
  if (/APROBADA|AID:|ARQC:|REVOLENTE|BINCNTRL/.test(l))             return "METADATA";
  if (/^https?:\/\/|^www\./i.test(raw))                              return "METADATA";
  if (/GRACIAS POR SU COMPRA|CUÉNTANOS|CUENTANOS|INGRESANDO|KIOSCOS|FACTURAS EN/.test(l)) return "METADATA";
  if (/SERVICIO AL CLIENTE|ATENCION A CLIENTES|VENTAS POR TELEFONO/.test(l)) return "METADATA";
  if (/AHORRA\s+\$|DESCUENTO\s+ACUMULADO/.test(l))                  return "METADATA";
  if (/[A-Z0-9]{16,}/.test(raw) && !/\s/.test(raw))                 return "METADATA";
  if (/@/.test(raw) && raw.length < 30)                              return "METADATA";

  return "RENGLON";
}

// ─── Extracción de cantidad × precio unitario ──────────────────────────────

function extractQuantityAndUnit(line) {
  const l = normalizeText(line);
  const patterns = [
    /^(\d+(?:\.\d+)?)\s*[xX*]\s*\$?([\d,.]+)/,
    /^(\d+(?:\.\d+)?)\s*(?:pz|pza|pzas?|kg|lt|lts?|mts?|ml|gr|grs?)\.?\s+\$?([\d,.]+)/i,
    /^(\d+(?:\.\d+)?)\s*@\s*\$?([\d,.]+)/,
  ];
  for (const pat of patterns) {
    const m = l.match(pat);
    if (m) return { cantidad: Number(m[1]) || 1, precio_unitario: parseAmount(m[2]) };
  }
  return { cantidad: null, precio_unitario: null };
}

// ─── Helpers de detección ──────────────────────────────────────────────────

function extractCardLast4(text) {
  const patterns = [
    /(?:VISA|MASTERCARD|AMEX|DEBITO|CREDITO|TARJETA|BANC)[^\d]*(\d{4})/i,
    /\*{3,}\s*(\d{4})/,
    /X{3,}\s*(\d{4})/i,
    /(?:NO\.?\s*TARJETA|CARD)[^\d]*(\d{4})/i,
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
    /(?:FOLIO|TICKET|FACTURA|OPERACION|TRANS\.?)[^\d]*([A-Z0-9-]{4,20})/i,
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
  { name: "WALMART",        pattern: /WALMART|WAL\s*MART/ },
  { name: "HEB",            pattern: /\bHEB\b|H-E-B/ },
  { name: "COSTCO",         pattern: /COSTCO/ },
  { name: "SAMS",           pattern: /SAM'?S|SAMS CLUB/ },
  { name: "STEREN",         pattern: /STEREN/ },
  { name: "SODIMAC",        pattern: /SODIMAC/ },
  { name: "FERRETERIA",     pattern: /FERRET/ },
  { name: "OXXO",           pattern: /\bOXXO\b/ },
  { name: "7-ELEVEN",       pattern: /7[- ]?ELEVEN|SEVEN\s*ELEVEN/ },
  { name: "ELEKTRA",        pattern: /ELEKTRA/ },
  { name: "LIVERPOOL",      pattern: /LIVERPOOL/ },
  { name: "COPPEL",         pattern: /COPPEL/ },
  { name: "SORIANA",        pattern: /SORIANA/ },
  { name: "CHEDRAUI",       pattern: /CHEDRAUI/ },
  { name: "BODEGA AURRERA", pattern: /BODEGA\s*AURRERA|AURRERA/ },
  { name: "SUPERAMA",       pattern: /SUPERAMA/ },
  { name: "LA COMER",       pattern: /LA\s*COMER/ },
  { name: "MEGA",           pattern: /\bMEGA\b/ },
  { name: "VEMEX",          pattern: /VEMEX/ },
  { name: "ACE HARDWARE",   pattern: /ACE\s*HARDWARE/ },
  { name: "DO IT CENTER",   pattern: /DO\s*IT\s*CENTER/ },
];

function detectStore(text) {
  const t = normalizeUpper(text);
  for (const s of STORE_PATTERNS) {
    if (s.pattern.test(t)) return s.name;
  }
  const lines = text.replace(/\r/g, "\n").split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length > 0) {
    const first = lines[0].replace(/[^A-Za-zÀ-ÿ0-9 ]/g, "").trim();
    if (first.length >= 3 && first.length <= 40) return first.toUpperCase();
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
    if (m) {
      try { if (!isNaN(new Date(iso(m)))) return iso(m); } catch (_) {}
    }
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
// Elimina montos y cantidades que el OCR puso en la misma línea que el nombre

function cleanDescription(text) {
  let s = text.trim();
  // Remover monto al final (ej. "DETERGENTE ARIEL    45.00" o "$1,234.56")
  s = s.replace(/\s*\$?\s*-?\d{1,3}(?:[,.]\d{3})*(?:[,.]\d{2})?\s*-?\s*$/, "");
  // Remover cantidad al inicio (ej. "2 x ", "3 PZA ")
  s = s.replace(/^\d+(?:\.\d+)?\s*(?:[xX*]|pz|pza|pzas?|kg|lt|lts?|mts?|ml|gr)\s*/i, "");
  return s.trim();
}

// ─── Extracción financiera con lookahead ───────────────────────────────────
// Muchos tickets ponen el monto en la línea siguiente al texto (ej. "IVA\n57.66")

function resolveFinancials(items) {
  const usados = new Set(); // índices ya consumidos como monto financiero

  function buscarMonto(tipo) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].tipo_linea !== tipo) continue;
      if (items[i].monto_detectado > 0) return items[i].monto_detectado;
      // Lookahead: buscar monto en las siguientes 2 líneas
      for (let j = i + 1; j < Math.min(i + 3, items.length); j++) {
        if (items[j].monto_detectado > 0) {
          usados.add(j);
          return items[j].monto_detectado;
        }
      }
    }
    return 0;
  }

  const subtotal  = buscarMonto("SUBTOTAL");
  const iva       = buscarMonto("IVA");
  const ieps      = buscarMonto("IEPS");
  const total     = buscarMonto("TOTAL") ||
    Math.max(0, ...items.filter(x => x.tipo_linea === "TOTAL" || x.monto_detectado > 0).map(x => x.monto_detectado));
  const descuentos = items
    .filter(x => x.tipo_linea === "DESCUENTO" && x.monto_detectado > 0)
    .reduce((s, x) => s + x.monto_detectado, 0);

  return { subtotal, iva, ieps, total, descuentos, usados };
}

// ─── Construir lista de productos ──────────────────────────────────────────

function buildProductos(items, financialUsados) {
  const tieneDesc  = txt => /[A-Za-záéíóúÁÉÍÓÚñÑ]{3,}/.test(txt);
  const tieneMonto = item => item.monto_detectado > 0;

  // Solo RENGLON no consumidos por financieros
  const renglones = items
    .map((x, i) => ({ ...x, _idx: i }))
    .filter(x => x.tipo_linea === "RENGLON" && !financialUsados.has(x._idx));

  const usadosEnProducto = new Set();
  const productos = [];

  for (let i = 0; i < renglones.length; i++) {
    if (usadosEnProducto.has(i)) continue;

    const item = renglones[i];

    // Saltar si no tiene descripción textual (solo números o ruido)
    if (!tieneDesc(item.texto_original)) continue;

    let monto = tieneMonto(item) ? item.monto_detectado : 0;

    // Si no tiene monto propio, buscar en la siguiente línea sin descripción
    if (!monto) {
      for (let j = i + 1; j < Math.min(i + 4, renglones.length); j++) {
        if (usadosEnProducto.has(j)) continue;
        const sig = renglones[j];
        if (tieneDesc(sig.texto_original)) break; // siguiente producto, parar
        if (tieneMonto(sig)) {
          monto = sig.monto_detectado;
          usadosEnProducto.add(j);
          break;
        }
      }
    }

    productos.push({
      linea_numero:    item.linea_numero,
      descripcion:     cleanDescription(item.texto_original),
      cantidad:        item.cantidad        !== null ? item.cantidad        : "",
      precio_unitario: item.precio_unitario !== null ? item.precio_unitario : "",
      monto:           monto || ""
    });
  }

  return productos;
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
    const amount = parseAmount(line);
    const type   = detectLineType(line);
    const { cantidad, precio_unitario } = extractQuantityAndUnit(line);
    return {
      linea_numero:    index + 1,
      texto_original:  line,
      monto_detectado: amount,
      tipo_linea:      type,
      cantidad:        cantidad        !== null ? cantidad        : "",
      precio_unitario: precio_unitario !== null ? precio_unitario : "",
    };
  });

  const store          = detectStore(raw);
  const rfc            = extractRFC(raw);
  const date           = extractDate(raw);
  const time           = extractTime(raw);
  const folio          = extractFolio(raw);
  const payment_method = detectPaymentMethod(raw);
  const card_last4     = extractCardLast4(raw);

  const { subtotal, iva, ieps, total, descuentos, usados: financialUsados } = resolveFinancials(items);

  const monto_pagado = (() => {
    const p = items.find(x => ["PAGO_TARJETA", "PAGO_EFECTIVO"].includes(x.tipo_linea) && x.monto_detectado > 0);
    return p ? p.monto_detectado : 0;
  })();

  const monto_cruce      = monto_pagado > 0 ? monto_pagado : total;
  const referencia_cruce = [store, date, card_last4 ? `*${card_last4}` : "", total ? `$${total}` : ""]
    .filter(Boolean).join(" | ");

  const productos = buildProductos(items, financialUsados);

  return {
    store, rfc, date, time, folio, payment_method, card_last4,
    subtotal, iva, ieps, descuentos, total, monto_pagado, monto_cruce,
    referencia_cruce, hash_ticket: simpleHash(raw.slice(0, 500)),
    productos, items, raw_text: raw
  };
}

module.exports = { parseTicket, parseAmount, detectLineType, detectStore, extractDate, extractRFC };
