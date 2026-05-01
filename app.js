let lastRows = [];
let lastTickets = [];

function getBackendUrl() {
  const val = document.getElementById("backendUrl").value.trim().replace(/\/$/, "");
  localStorage.setItem("ticket_backend_url", val);
  return val;
}

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("backendUrl").value = localStorage.getItem("ticket_backend_url") || "";

  const fileInput = document.getElementById("files");
  if (fileInput) {
    fileInput.addEventListener("change", handleFilesSelected);
  }
});

function buildFormData(saveToSheets) {
  const files = document.getElementById("files").files;
  if (!files.length) throw new Error("Selecciona al menos una imagen de ticket.");

  const form = new FormData();
  for (const f of files) form.append("files", f);

  form.append("propiedad", document.getElementById("propiedad").value || "");
  form.append("departamento", document.getElementById("departamento").value || "");
  form.append("huesped", document.getElementById("huesped").value || "");
  form.append("notas", document.getElementById("notas").value || "");
  form.append("saveToSheets", saveToSheets ? "true" : "false");

  return form;
}

async function handleFilesSelected() {
  lastRows = [];
  lastTickets = [];
  renderImagePreview();
  renderPreview([]);
  await processPreviewOnly();
}

function renderImagePreview() {
  const files = document.getElementById("files").files;
  const container = document.getElementById("imagePreview");

  if (!container) return;

  if (!files.length) {
    container.className = "imagePreview empty";
    container.textContent = "Aún no has seleccionado imágenes.";
    return;
  }

  container.className = "imagePreview";
  container.innerHTML = "";

  Array.from(files).forEach((file, index) => {
    const card = document.createElement("div");
    card.className = "ticketImageCard";

    const img = document.createElement("img");
    img.src = URL.createObjectURL(file);
    img.alt = `Ticket ${index + 1}`;
    img.onload = () => URL.revokeObjectURL(img.src);

    const caption = document.createElement("div");
    caption.className = "ticketImageCaption";
    caption.textContent = `${index + 1}. ${file.name}`;

    card.appendChild(img);
    card.appendChild(caption);
    container.appendChild(card);
  });
}

async function processPreviewOnly() {
  try {
    const backendUrl = getBackendUrl();
    if (!backendUrl) {
      setStatus("Pega la URL de Cloud Run para generar la tabla.");
      return;
    }

    setStatus("Leyendo ticket renglón por renglón...");
    const form = buildFormData(false);

    const res = await fetch(`${backendUrl}/process-json`, {
      method: "POST",
      body: form
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(`${data.error || "No se pudo procesar el ticket."}${data.detail ? " — " + data.detail : ""}`);
    }

    lastRows = data.rows || [];
    lastTickets = data.tickets || [];

    renderTicketSummary(lastTickets);
    renderPreview(lastRows);

    setStatus(`Transcripción generada. Renglones detectados: ${data.total_rows || lastRows.length}.`);
  } catch (err) {
    setStatus(err.message);
  }
}

async function processExcel() {
  try {
    const backendUrl = getBackendUrl();
    if (!backendUrl) throw new Error("Pega la URL de Cloud Run.");

    setStatus("Generando Excel de transcripción lineal...");
    const form = buildFormData(false);

    const res = await fetch(`${backendUrl}/process`, {
      method: "POST",
      body: form
    });

    if (!res.ok) {
      let msg = "No se pudo procesar el ticket.";
      try {
        const data = await res.json();
        msg = `${data.error || msg}${data.detail ? " — " + data.detail : ""}`;
      } catch (_) {}
      throw new Error(msg);
    }

    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "tickets_transcripcion_lineal.xlsx";
    a.click();

    setStatus("Excel descargado.");
  } catch (err) {
    setStatus(err.message);
  }
}

async function processAndSave() {
  try {
    const backendUrl = getBackendUrl();
    if (!backendUrl) throw new Error("Pega la URL de Cloud Run.");

    setStatus("Guardando transcripción en Google Sheets...");
    const form = buildFormData(true);

    const res = await fetch(`${backendUrl}/process-json`, {
      method: "POST",
      body: form
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(`${data.error || "No se pudo guardar en Sheets."}${data.detail ? " — " + data.detail : ""}`);
    }

    lastRows = data.rows || [];
    lastTickets = data.tickets || [];
    renderTicketSummary(lastTickets);
    renderPreview(lastRows);

    setStatus(`Guardado en Sheets. Renglones procesados: ${data.total_rows || lastRows.length}.`);
  } catch (err) {
    setStatus(err.message);
  }
}

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

function renderTicketSummary(tickets) {
  const existing = document.getElementById("ticketSummary");
  if (!existing) return;

  if (!tickets || !tickets.length) {
    existing.innerHTML = "";
    return;
  }

  existing.innerHTML = tickets.map(t => `
    <div class="summaryBox">
      <div><strong>Tienda:</strong> ${escapeHtml(t.tienda || "")}</div>
      <div><strong>Fecha:</strong> ${escapeHtml(t.fecha_ticket || "")}</div>
      <div><strong>RFC:</strong> ${escapeHtml(t.rfc_emisor || "")}</div>
      <div><strong>Total detectado:</strong> ${money(t.total_detectado)}</div>
      <div><strong>Renglones:</strong> ${escapeHtml(t.renglones_detectados || 0)}</div>
    </div>
  `).join("");
}

function renderPreview(rows) {
  const el = document.getElementById("preview");

  if (!rows || !rows.length) {
    el.innerHTML = "Aún no hay datos procesados.";
    return;
  }

  const head = [
    ["linea_numero", "#"],
    ["texto_original", "Texto original del renglón"],
    ["monto_detectado", "Monto detectado"],
    ["tipo_linea", "Tipo"]
  ];

  el.innerHTML = `
    <table>
      <thead>
        <tr>${head.map(([_, label]) => `<th>${label}</th>`).join("")}</tr>
      </thead>
      <tbody>
        ${rows.slice(0, 250).map(r => `
          <tr>${head.map(([key]) => `<td>${formatCell(key, r[key])}</td>`).join("")}</tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function formatCell(key, value) {
  if (value === null || value === undefined || value === "") return "";
  if (key === "monto_detectado") return money(value);
  return escapeHtml(value);
}

function money(value) {
  const num = Number(value || 0);
  if (Number.isNaN(num)) return "";
  return escapeHtml(num.toLocaleString("es-MX", {
    style: "currency",
    currency: "MXN"
  }));
}

function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, s => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[s]));
}
