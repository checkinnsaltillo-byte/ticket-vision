function getBackendUrl() {
  const val = document.getElementById("backendUrl").value.trim().replace(/\/$/, "");
  localStorage.setItem("ticket_backend_url", val);
  return val;
}

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("backendUrl").value = localStorage.getItem("ticket_backend_url") || "";
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

async function processExcel() {
  try {
    const backendUrl = getBackendUrl();
    if (!backendUrl) throw new Error("Pega la URL de Cloud Run.");

    setStatus("Procesando OCR y generando Excel...");
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
    a.download = "gastos_tickets.xlsx";
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

    setStatus("Procesando OCR y guardando en Google Sheets...");
    const form = buildFormData(true);

    const res = await fetch(`${backendUrl}/process-json`, {
      method: "POST",
      body: form
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(`${data.error || "No se pudo guardar en Sheets."}${data.detail ? " — " + data.detail : ""}`);
    }

    renderPreview(data.rows || []);
    setStatus(`Listo. Registros procesados: ${data.total_rows}.`);
  } catch (err) {
    setStatus(err.message);
  }
}

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

function renderPreview(rows) {
  const el = document.getElementById("preview");
  if (!rows.length) {
    el.textContent = "No se detectaron partidas.";
    return;
  }

  const head = ["tienda", "fecha_ticket", "producto", "categoria_operativa", "importe", "propiedad"];
  el.innerHTML = `
    <table>
      <thead><tr>${head.map(h => `<th>${h}</th>`).join("")}</tr></thead>
      <tbody>
        ${rows.slice(0, 50).map(r => `
          <tr>${head.map(h => `<td>${escapeHtml(r[h] ?? "")}</td>`).join("")}</tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, s => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[s]));
}
