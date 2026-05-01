function normalizeText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function detectStore(text) {
  const t = text.toUpperCase();

  if (t.includes("VEMEX")) return "VEMEX";
  if (t.includes("HOME DEPOT") || t.includes("THE HOME DEPOT")) return "HOME DEPOT";
  if (t.includes("WALMART")) return "WALMART";
  if (t.includes("HEB") || t.includes("H-E-B")) return "HEB";
  if (t.includes("COSTCO")) return "COSTCO";
  if (t.includes("SAMS") || t.includes("SAM'S")) return "SAMS";
  if (t.includes("LOWE")) return "LOWES";
  if (t.includes("STEREN")) return "STEREN";
  if (t.includes("OFFICE DEPOT")) return "OFFICE DEPOT";

  return "OTRO";
}

function extractDate(text) {
  const patterns = [
    /\b(\d{2}\/\d{2}\/\d{4})\b/,
    /\b(\d{2}-\d{2}-\d{4})\b/,
    /\b(\d{4}-\d{2}-\d{2})\b/
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return "";
}

function extractRFC(text) {
  const m = text.toUpperCase().match(/\b[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/);
  return m ? m[0] : "";
}

function extractFolio(text) {
  const m = text.match(/(?:folio|ticket|transacci[oó]n|operaci[oó]n|venta)[:\s#-]*([A-Z0-9-]{4,})/i);
  return m ? m[1] : "";
}

function parseAmount(value) {
  if (!value) return 0;
  return Number(String(value).replace(/[$,\s]/g, "")) || 0;
}

function extractTotal(text) {
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

  if (candidates.length) return Math.max(...candidates);
  return 0;
}

function shouldIgnoreLine(line) {
  const l = line.toUpperCase();
  return (
    l.length < 4 ||
    l.includes("TOTAL") ||
    l.includes("SUBTOTAL") ||
    l.includes("IVA") ||
    l.includes("CAMBIO") ||
    l.includes("PAGO") ||
    l.includes("TARJETA") ||
    l.includes("AUTORIZ") ||
    l.includes("RFC") ||
    l.includes("REGIMEN") ||
    l.includes("GRACIAS") ||
    l.includes("FACTURA") ||
    l.includes("WWW.") ||
    l.includes("HTTP")
  );
}

function parseItemsGeneric(lines) {
  const items = [];

  for (const line of lines) {
    if (shouldIgnoreLine(line)) continue;

    // Casos: "1 PRODUCTO 99.00", "PRODUCTO $99.00", "PRODUCTO 1 99.00"
    const amountMatches = [...line.matchAll(/\$?\s*([\d,]+\.\d{2})/g)];
    if (!amountMatches.length) continue;

    const lastAmount = amountMatches[amountMatches.length - 1][1];
    const importe = parseAmount(lastAmount);
    if (!importe || importe < 0.01) continue;

    let producto = line
      .replace(amountMatches[amountMatches.length - 1][0], "")
      .replace(/^\d+\s+/, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (!producto || producto.length < 3) continue;

    let cantidad = 1;
    const qty = line.match(/^\s*(\d+(?:\.\d+)?)\s+/);
    if (qty) cantidad = Number(qty[1]) || 1;

    items.push({
      producto,
      cantidad,
      precio_unitario: cantidad ? Number((importe / cantidad).toFixed(2)) : importe,
      importe
    });
  }

  return items;
}

function parseTicket(textRaw) {
  const text = normalizeText(textRaw);
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const store = detectStore(text);

  return {
    store,
    rfc: extractRFC(text),
    date: extractDate(text),
    folio: extractFolio(text),
    total: extractTotal(text),
    items: parseItemsGeneric(lines)
  };
}

module.exports = parseTicket;
