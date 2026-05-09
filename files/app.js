let lastRows    = [];
let lastTickets = [];
let lastCruce   = [];
let activeTab   = "transcripcion";

function getBackendUrl() {
  const val = document.getElementById("backendUrl").value.trim().replace(/\/$/, "");
  localStorage.setItem("ticket_backend_url", val);
  return val;
}

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("backendUrl").value =
    localStorage.getItem("ticket_backend_url") || "";

  const fileInput = document.getElementById("files");
  if (fileInput) fileInput.addEventListener("change", handleFilesSelected);

  // tabs
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
});

// ─── Construcción de form ──────────────────────────────────────────────────

function buildFormData(saveToSheets) {
  const files = document.getElementById("files").files;
  if (!files.length) throw new Error("Selecciona al menos una imagen de ticket.");

  const form = new FormData();
  for (const f of files) form.append("files", f);

  form.append("propiedad",    document.getElementById("propiedad").value    || "");
  form.append("departamento", document.getElementById("departamento").value || "");
  form.append("huesped",      document.getElementById("huesped").value      || "");
  form.append("notas",        document.getElementById("notas").value        || "");
  form.append("saveToSheets", saveToSheets ? "true" : "false");

  return form;
}

// ─── Selección de imágenes ─────────────────────────────────────────────────

async function handleFilesSelected() {
  lastRows = []; lastTickets = []; lastCruce = [];
  renderImagePreview();
  clearPreviews();
  await processPreviewOnly();
}

function renderImagePreview() {
  const files     = document.getElementById("files").files;
  const container = document.getElementById("imagePreview");
  if (!container) return;

  if (!files.length) {
    container.className   = "imagePreview empty";
    container.textContent = "Aún no has seleccionado imágenes.";
    return;
  }

  container.className = "imagePreview";
  container.innerHTML = "";

  Array.from(files).forEach((file, index) => {
    const card = document.createElement("div");
    card.className = "ticketImageCard";

    const img   = document.createElement("img");
    img.src     = URL.createObjectURL(file);
    img.alt     = `Ticket ${index + 1}`;
    img.onload  = () => URL.revokeObjectURL(img.src);

    const caption       = document.createElement("div");
    caption.className   = "ticketImageCaption";
    caption.textContent = `${index + 1}. ${file.name}`;

    card.appendChild(img);
    card.appendChild(caption);
    container.appendChild(card);
  });
}

// ─── Preview automático al seleccionar imágenes ────────────────────────────

async function processPreviewOnly() {
  try {
    const backendUrl = getBackendUrl();
    if (!backendUrl) {
      setStatus("Pega la URL de Cloud Run para generar la tabla.");
      return;
    }

    setStatus("Leyendo tickets...");
    const form = buildFormData(false);

    const res  = await fetch(`${backendUrl}/process-json`, { method: "POST", body: form });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(`${data.error || "No se pudo procesar el ticket."}${data.detail ? " — " + data.detail : ""}`);
    }

    lastRows    = data.rows    || [];
    lastTickets = data.tickets || [];
    lastCruce   = data.cruce_bancario || [];

    renderTicketSummary(lastTickets);
    renderTranscripcion(lastRows);
    renderCruceBancario(lastCruce);

    setStatus(`Transcripción lista. Renglones: ${data.total_rows || lastRows.length}.`);
  } catch (err) {
    setStatus("⚠ " + err.message);
  }
}

// ─── Excel ─────────────────────────────────────────────────────────────────

async function processExcel() {
  try {
    const backendUrl = getBackendUrl();
    if (!backendUrl) throw new Error("Pega la URL de Cloud Run.");

    setStatus("Generando Excel...");
    const form = buildFormData(false);

    const res = await fetch(`${backendUrl}/process`, { method: "POST", body: form });

    if (!res.ok) {
      let msg = "No se pudo procesar el ticket.";
      try { const d = await res.json(); msg = d.error || msg; } catch (_) {}
      throw new Error(msg);
    }

    const blob = await res.blob();
    const url  = window.URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = "tickets_transcripcion.xlsx";
    a.click();
    window.URL.revokeObjectURL(url);

    setStatus("Excel descargado (4 hojas: Transcripcion, Resumen, Cruce bancario, OCR).");
  } catch (err) {
    setStatus("⚠ " + err.message);
  }
}

// ─── Guardar en Sheets ─────────────────────────────────────────────────────

async function processAndSave() {
  try {
    const backendUrl = getBackendUrl();
    if (!backendUrl) throw new Error("Pega la URL de Cloud Run.");

    setStatus("Guardando en Google Sheets...");
    const form = buildFormData(true);

    const res  = await fetch(`${backendUrl}/process-json`, { method: "POST", body: form });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(`${data.error || "No se pudo guardar."}${data.detail ? " — " + data.detail : ""}`);
    }

    lastRows    = data.rows    || [];
    lastTickets = data.tickets || [];
    lastCruce   = data.cruce_bancario || [];

    renderTicketSummary(lastTickets);
    renderTranscripcion(lastRows);
    renderCruceBancario(lastCruce);

    setStatus(`Guardado en Sheets. Renglones: ${data.total_rows || lastRows.length}.`);
  } catch (err) {
    setStatus("⚠ " + err.message);
  }
}

// ─── Render resumen ────────────────────────────────────────────────────────

function renderTicketSummary(tickets) {
  const el = document.getElementById("ticketSummary");
  if (!el) return;

  if (!tickets?.length) { el.innerHTML = ""; return; }

  el.innerHTML = tickets.map(t => `
    <div class="summaryBox">
      <div><strong>Tienda:</strong>     ${esc(t.tienda)}</div>
      <div><strong>Fecha:</strong>      ${esc(t.fecha_ticket)}</div>
      <div><strong>Hora:</strong>       ${esc(t.hora_ticket)}</div>
      <div><strong>Folio:</strong>      ${esc(t.folio)}</div>
      <div><strong>RFC:</strong>        ${esc(t.rfc_emisor)}</div>
      <div><strong>Pago:</strong>       ${esc(t.metodo_pago)}${t.ultimos_4_tarjeta ? " *" + esc(t.ultimos_4_tarjeta) : ""}</div>
      <div><strong>Total:</strong>      ${money(t.total_detectado)}</div>
      <div><strong>Monto cruce:</strong>${money(t.monto_cruce)}</div>
      <div><strong>Renglones:</strong>  ${esc(t.renglones_detectados)}</div>
    </div>
  `).join("");
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
    el.innerHTML = "<p>Aún no hay datos procesados.</p>";
    return;
  }

  const cols = [
    { key: "linea_numero",           label: "#" },
    { key: "texto_original",         label: "Texto original" },
    { key: "cantidad",               label: "Cant." },
    { key: "precio_unitario",        label: "P.Unit." },
    { key: "monto_detectado",        label: "Monto", fmt: "money" },
    { key: "tipo_linea",             label: "Tipo" },
    { key: "categoria_operativa",    label: "Categoría" },
    { key: "deducible_sugerido",     label: "Deducible" },
    { key: "confianza_clasificacion",label: "Confianza" },
  ];

  el.innerHTML = buildTable(rows.slice(0, 300), cols);
}

// ─── Render Cruce Bancario ─────────────────────────────────────────────────

function renderCruceBancario(rows) {
  const el = document.getElementById("previewCruce");
  if (!rows?.length) {
    el.innerHTML = "<p>Aún no hay datos de cruce.</p>";
    return;
  }

  const cols = [
    { key: "fecha_iso",        label: "Fecha ISO" },
    { key: "hora",             label: "Hora" },
    { key: "comercio",         label: "Comercio" },
    { key: "rfc",              label: "RFC" },
    { key: "folio",            label: "Folio" },
    { key: "metodo_pago",      label: "Forma pago" },
    { key: "tarjeta_ultimos4", label: "Tarjeta" },
    { key: "monto_cruce",      label: "Monto cruce", fmt: "money" },
    { key: "total_ticket",     label: "Total ticket", fmt: "money" },
    { key: "propiedad",        label: "Propiedad" },
    { key: "departamento",     label: "Depto." },
    { key: "busqueda_banco",   label: "Búsqueda banco" },
  ];

  el.innerHTML = buildTable(rows, cols);
}

// ─── Tabla genérica ────────────────────────────────────────────────────────

function buildTable(rows, cols) {
  return `
    <table>
      <thead>
        <tr>${cols.map(c => `<th>${c.label}</th>`).join("")}</tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>${cols.map(c => {
            const v = r[c.key];
            return `<td>${c.fmt === "money" ? money(v) : esc(v)}</td>`;
          }).join("")}</tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

// ─── Limpiar vistas previas ────────────────────────────────────────────────

function clearPreviews() {
  const t = document.getElementById("previewTranscripcion");
  const c = document.getElementById("previewCruce");
  const s = document.getElementById("ticketSummary");
  if (t) t.innerHTML = "<p>Selecciona una imagen para generar la tabla.</p>";
  if (c) c.innerHTML = "<p>Selecciona una imagen para generar el cruce.</p>";
  if (s) s.innerHTML = "";
}

// ─── Utilidades ───────────────────────────────────────────────────────────

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
