function parseAmount(line) {
  const match = line.match(/\$?\s*([\d,]+\.\d{2})/);
  if (!match) return 0;

  return Number(
    match[1]
      .replace(/,/g, "")
  );
}

function detectLineType(line) {
  const l = line.toUpperCase();

  if (l.includes("TOTAL")) return "TOTAL";
  if (l.includes("IVA")) return "IVA";
  if (l.includes("SUBTOTAL")) return "SUBTOTAL";
  if (l.includes("IMPORTE")) return "IMPORTE";
  if (l.includes("IEPS")) return "IEPS";
  if (l.includes("DESCUENTO")) return "DESCUENTO";

  return "LINEA";
}

function parseTicket(textRaw) {
  const lines = String(textRaw)
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const items = [];

  lines.forEach((line, index) => {
    const amount = parseAmount(line);

    items.push({
      linea_numero: index + 1,
      texto_original: line,          // 🔥 EXACTO como viene
      monto_detectado: amount,       // sólo si existe
      tipo_linea: detectLineType(line)
    });
  });

  return {
    store: "",
    rfc: "",
    date: "",
    folio: "",
    total: 0,
    items,
    raw_text: textRaw
  };
}

module.exports = parseTicket;
