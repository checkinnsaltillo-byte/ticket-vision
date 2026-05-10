const BACKEND = "https://ticket-vision-957627511957.northamerica-south1.run.app";

let lastRows      = [];
let lastTickets   = [];
let lastCruce     = [];
let selectedFiles = [];
let activeTab     = "transcripcion";

// ─── Init ──────────────────────────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("files-camera").addEventListener("change", handleFilesAdded);
  document.getElementById("files-gallery").addEventListener("change", handleFilesAdded);

  document.querySelectorAll(".tab-btn").forEach(btn =>
    btn.addEventListener("click", () => switchTab(btn.dataset.tab))
  );

  const zone = document.getElementById("uploadZone");
  zone.addEventListener("dragover",  e => { e.preventDefault(); zone.classList.add("drag-over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
  zone.addEventListener("drop", e => {
    e.preventDefault();
    zone.classList.remove("drag-over");
    const imgs = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
    addFiles(imgs);
  });

  setStep(1);
});

// ─── File management ───────────────────────────────────────────────────────

function handleFilesAdded(e) {
  addFiles(Array.from(e.target.files));
  e.target.value = "";
}

function addFiles(newFiles) {
  if (!newFiles.length) return;
  selectedFiles = [...selectedFiles, ...newFiles];
  lastRows = []; lastTickets = []; lastCruce = [];
  renderImageStrip();
  clearPreviews();
  setStep(2);
}

// ─── Step indicator ────────────────────────────────────────────────────────

function setStep(n) {
  for (let i = 1; i <= 3; i++) {
    const el = document.getElementById(`step-ind-${i}`);
    if (!el) continue;
    el.classList.remove("active", "done");
    if (i < n)  el.classList.add("done");
    if (i === n) el.classList.add("active");
  }
}

// ─── Image strip ───────────────────────────────────────────────────────────

function renderImageStrip() {
  const strip = document.getElementById("imagePreview");
  if (!selectedFiles.length) { strip.classList.add("hidden"); return; }
  strip.classList.remove("hidden");
  strip.innerHTML = "";
  selectedFiles.forEach((file, i) => {
    const thumb = document.createElement("div");
    thumb.className = "image-thumb";

    const img = document.createElement("img");
    img.src   = URL.createObjectURL(file);
    img.onload = () => URL.revokeObjectURL(img.src);

    const lbl = document.createElement("div");
    lbl.className   = "thumb-label";
    lbl.textContent = `${i + 1}`;

    thumb.append(img, lbl);
    strip.appendChild(thumb);
  });
}

// ─── Loading ───────────────────────────────────────────────────────────────

function showLoading(title = "Claude está analizando...") {
  document.getElementById("loadingTitle").textContent = title;
  document.getElementById("loadingOverlay").classList.remove("hidden");
}
function hideLoading() {
  document.getElementById("loadingOverlay").classList.add("hidden");
}

// ─── Form ──────────────────────────────────────────────────────────────────

function buildFormData(saveToSheets) {
  if (!selectedFiles.length) throw new Error("Selecciona al menos una imagen de ticket.");
  const form = new FormData();
  selectedFiles.forEach(f => form.append("files", f));
  form.append("propiedad",    document.getElementById("propiedad").value    || "");
  form.append("departamento", document.getElementById("departamento").value || "");
  form.append("huesped",      document.getElementById("huesped").value      || "");
  form.append("notas",        document.getElementById("notas").value        || "");
  form.append("saveToSheets", saveToSheets ? "true" : "false");
  return form;
}

// ─── Analyze ───────────────────────────────────────────────────────────────

async function analyzeTickets() {
  try {
    showLoading("Claude está analizando...");
    setStatus("Leyendo tickets...");

    const res  = await fetch(`${BACKEND}/process-json`, { method: "POST", body: buildFormData(false) });
    const data = await res.json();

    if (!res.ok || !data.ok) throw new Error(data.error || "No se pudo procesar.");

    lastRows    = data.productos      || [];
    lastTickets = data.resumen        || [];
    lastCruce   = data.cruce_bancario || [];

    renderTicketSummary(lastTickets);
    renderTranscripcion(lastRows);
    renderCruceBancario(lastCruce);
    setStep(3);
    setStatus(`${data.total_productos || lastRows.length} productos detectados.`);
    document.getElementById("step3").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    setStatus("Error: " + err.message);
  } finally {
    hideLoading();
  }
}

// ─── Excel ─────────────────────────────────────────────────────────────────

async function processExcel() {
  try {
    showLoading("Generando Excel...");
    setStatus("Preparando archivo...");

    const res = await fetch(`${BACKEND}/process`, { method: "POST", body: buildFormData(false) });
    if (!res.ok) {
      let msg = "No se pudo procesar.";
      try { const d = await res.json(); msg = d.error || msg; } catch (_) {}
      throw new Error(msg);
    }

    const blob = await res.blob();
    const a    = Object.assign(document.createElement("a"), {
      href:     URL.createObjectURL(blob),
      download: "tickets_transcripcion.xlsx"
    });
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus("Excel descargado.");
  } catch (err) {
    setStatus("Error: " + err.message);
  } finally {
    hideLoading();
  }
}

// ─── Sheets ────────────────────────────────────────────────────────────────

async function processAndSave() {
  try {
    showLoading("Guardando en Sheets...");
    setStatus("Enviando datos...");

    const res  = await fetch(`${BACKEND}/process-json`, { method: "POST", body: buildFormData(true) });
    const data = await res.json();

    if (!res.ok || !data.ok) throw new Error(data.error || "No se pudo guardar.");

    lastRows    = data.productos      || [];
    lastTickets = data.resumen        || [];
    lastCruce   = data.cruce_bancario || [];

    renderTicketSummary(lastTickets);
    renderTranscripcion(lastRows);
    renderCruceBancario(lastCruce);
    setStep(3);
    setStatus(`Guardado en Sheets. ${data.total_productos || lastRows.length} productos.`);
  } catch (err) {
    setStatus("Error: " + err.message);
  } finally {
    hideLoading();
  }
}

// ─── Render ticket summary ─────────────────────────────────────────────────

function renderTicketSummary(tickets) {
  const el = document.getElementById("ticketSummary");
  if (!tickets?.length) { el.innerHTML = ""; return; }

  el.innerHTML = tickets.map(t => `
    <div class="summary-card">
      <div class="store-name">${esc(t.tienda || "Ticket")}</div>
      ${field("Fecha",    t.fecha)}
      ${field("Hora",     t.hora)}
      ${field("RFC",      t.rfc)}
      ${field("Folio",    t.folio)}
      ${t.metodo_pago ? field("Pago", t.metodo_pago + (t.tarjeta_ultimos4 ? " *" + t.tarjeta_ultimos4 : "")) : ""}
      ${field("Productos", t.num_productos)}
      ${field("Subtotal",  money(t.subtotal))}
      ${field("IVA",       money(t.iva))}
      ${t.ieps       ? field("IEPS",       money(t.ieps))       : ""}
      ${t.descuentos ? field("Descuentos", money(t.descuentos)) : ""}
      <div class="total-row">
        <span class="t-label">TOTAL</span>
        <span class="t-amount">${money(t.total)}</span>
      </div>
    </div>
  `).join("");
}

function field(label, value) {
  if (!value && value !== 0) return "";
  return `<div class="s-row">
    <span class="s-label">${esc(label)}</span>
    <span class="s-val">${esc(String(value))}</span>
  </div>`;
}

// ─── Tabs ──────────────────────────────────────────────────────────────────

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".tab-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === tab)
  );
  document.querySelectorAll(".tab-pane").forEach(p =>
    p.classList.toggle("hidden", p.dataset.pane !== tab)
  );
}

// ─── Render Transcripción ──────────────────────────────────────────────────

function renderTranscripcion(rows) {
  const el = document.getElementById("previewTranscripcion");
  if (!rows?.length) {
    el.innerHTML = emptyState("🛒", "Sin productos detectados.");
    return;
  }
  el.innerHTML = buildTable(rows.slice(0, 300), [
    { key: "linea_numero",            label: "#" },
    { key: "descripcion",             label: "Descripción" },
    { key: "cantidad",                label: "Cant." },
    { key: "precio_unitario",         label: "P.Unit.", fmt: "money" },
    { key: "monto",                   label: "Monto",   fmt: "money" },
    { key: "categoria_operativa",     label: "Categoría" },
    { key: "deducible_sugerido",      label: "Deducible" },
    { key: "confianza_clasificacion", label: "Confianza" },
  ]);
}

// ─── Render Cruce Bancario ─────────────────────────────────────────────────

function renderCruceBancario(rows) {
  const el = document.getElementById("previewCruce");
  if (!rows?.length) {
    el.innerHTML = emptyState("🏦", "Sin datos de cruce bancario.");
    return;
  }
  el.innerHTML = buildTable(rows, [
    { key: "fecha",            label: "Fecha" },
    { key: "hora",             label: "Hora" },
    { key: "comercio",         label: "Comercio" },
    { key: "rfc",              label: "RFC" },
    { key: "folio",            label: "Folio" },
    { key: "metodo_pago",      label: "Forma pago" },
    { key: "tarjeta_ultimos4", label: "Tarjeta" },
    { key: "monto_cruce",      label: "Monto",   fmt: "money" },
    { key: "total_ticket",     label: "Total",   fmt: "money" },
    { key: "propiedad",        label: "Propiedad" },
    { key: "departamento",     label: "Depto." },
  ]);
}

// ─── Generic table ─────────────────────────────────────────────────────────

function buildTable(rows, cols) {
  return `<table>
    <thead><tr>${cols.map(c => `<th>${c.label}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(r =>
      `<tr>${cols.map(c => `<td>${c.fmt === "money" ? money(r[c.key]) : esc(r[c.key])}</td>`).join("")}</tr>`
    ).join("")}</tbody>
  </table>`;
}

// ─── Clear ─────────────────────────────────────────────────────────────────

function clearPreviews() {
  document.getElementById("previewTranscripcion").innerHTML = emptyState("🔍", "Analiza un ticket para ver los productos aquí.");
  document.getElementById("previewCruce").innerHTML         = emptyState("🏦", "Sin datos de cruce bancario.");
  document.getElementById("ticketSummary").innerHTML        = "";
}

// ─── Utilities ─────────────────────────────────────────────────────────────

function emptyState(icon, text) {
  return `<div class="empty-state"><div class="empty-icon">${icon}</div><p>${esc(text)}</p></div>`;
}

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

function money(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n === 0) return "";
  return esc(n.toLocaleString("es-MX", { style: "currency", currency: "MXN" }));
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, s =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[s])
  );
}
