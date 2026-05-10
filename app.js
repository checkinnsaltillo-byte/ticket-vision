const BACKEND = "https://ticket-vision-957627511957.northamerica-south1.run.app";

// ─── Catálogo de clasificaciones ───────────────────────────────────────────

const CATALOG = {
  "Gastos Operativos": {
    "Sueldos":        ["Limpieza", "Mantenimiento", "Administracion", "IMSS Personal"],
    "Servicios":      ["Lavanderia", "Agua", "Luz", "Gas", "Internet", "Pipas de agua", "Fumigacion", "Plataformas"],
    "Insumos":        ["Limpieza", "Blancos"],
    "Equipamiento":   ["Depa nuevo", "Decoracion", "Reemplazo de Minisplit", "Hidro nuevo", "Lavadora / secadora nueva", "Colchon", "Mesa", "Silla", "Sillon", "Refrigerador nuevo", "Abanico", "Smart tv"],
    "Mantenimiento":  ["Ferreteria", "Aparatos Electronicos y Focos", "Limpieza de colchones, sillones", "Gas de minisplit", "Hidro", "Boiler nuevo", "Lavadora / secadora"],
    "Administrativo": ["Impresiones / Señalitica", "Papeleria", "Equipo de computo"],
    "Autos":          ["Gasolina", "Seguros", "Mantenimiento", "Tenencia"],
    "Predial":        [],
    "Impuestos":      [],
    "Otros Gastos":   [],
    "Construccion":   []
  },
  "Movimientos Bancarios": {
    "Movimientos Bancarios": ["Inversion", "Pago TC", "Devoluciones"]
  },
  "Gastos Familiares": {
    "Gastos familiares": ["Viajes", "Gatos casa", "Sueldo Papa", "Gastos médicos"]
  }
};

// ─── State ─────────────────────────────────────────────────────────────────

let selectedFiles  = [];
let ticketResults  = []; // [{file, resumen, productos, cruce}, ...]

// ─── Init ──────────────────────────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("files-camera").addEventListener("change", handleFilesAdded);
  document.getElementById("files-gallery").addEventListener("change", handleFilesAdded);
});

// ─── File management ───────────────────────────────────────────────────────

function handleFilesAdded(e) {
  addFiles(Array.from(e.target.files));
  e.target.value = "";
}

function addFiles(newFiles) {
  if (!newFiles.length) return;
  selectedFiles = [...selectedFiles, ...newFiles];
  renderImageStrip();
  document.getElementById("analyzeWrap").classList.remove("hidden");
  setStep(1);
}

function renderImageStrip() {
  const strip = document.getElementById("imagePreview");
  if (!selectedFiles.length) { strip.classList.add("hidden"); return; }
  strip.classList.remove("hidden");
  strip.innerHTML = "";
  selectedFiles.forEach((file, i) => {
    const thumb = document.createElement("div");
    thumb.className = "image-thumb";
    const img = document.createElement("img");
    img.src = URL.createObjectURL(file);
    img.onload = () => URL.revokeObjectURL(img.src);
    const lbl = document.createElement("div");
    lbl.className   = "thumb-label";
    lbl.textContent = String(i + 1);
    thumb.append(img, lbl);
    strip.appendChild(thumb);
  });
}

// ─── Loading ───────────────────────────────────────────────────────────────

function showLoading(title = "Claude está analizando...", sub = "Extrayendo productos y datos") {
  document.getElementById("loadingTitle").textContent    = title;
  document.getElementById("loadingSubtitle").textContent = sub;
  document.getElementById("loadingOverlay").classList.remove("hidden");
}
function hideLoading() {
  document.getElementById("loadingOverlay").classList.add("hidden");
}

// ─── Step indicator ────────────────────────────────────────────────────────

function setStep(n) {
  for (let i = 1; i <= 2; i++) {
    const el = document.getElementById(`step-ind-${i}`);
    if (!el) continue;
    el.classList.remove("active", "done");
    if (i < n)  el.classList.add("done");
    if (i === n) el.classList.add("active");
  }
}

// ─── Analyze (all files at once) ───────────────────────────────────────────

async function analyzeTickets() {
  if (!selectedFiles.length) return;
  try {
    showLoading("Claude está analizando...", `Procesando ${selectedFiles.length} ticket${selectedFiles.length > 1 ? "s" : ""}...`);
    setStatus("analyzeStatus", "");

    const form = new FormData();
    selectedFiles.forEach(f => form.append("files", f));

    const res  = await fetch(`${BACKEND}/process-json`, { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "No se pudo procesar.");

    // Agrupar resultados por ticket
    ticketResults = (data.resumen || []).map((res, i) => ({
      file:      selectedFiles[i],
      resumen:   res,
      productos: (data.productos || []).filter(p => p.ticket_id === res.ticket_id),
      cruce:     (data.cruce_bancario || [])[i] || {}
    }));

    renderTicketCards();
    setStep(2);
    setStatus("analyzeStatus", `${ticketResults.length} ticket${ticketResults.length > 1 ? "s" : ""} analizados.`);

    setTimeout(() => {
      document.getElementById("ticketsContainer").scrollIntoView({ behavior: "smooth" });
    }, 200);
  } catch (err) {
    setStatus("analyzeStatus", "Error: " + err.message);
  } finally {
    hideLoading();
  }
}

// ─── Render all ticket cards ────────────────────────────────────────────────

function renderTicketCards() {
  const container = document.getElementById("ticketsContainer");
  container.innerHTML = ticketResults.map((t, i) => createTicketCard(t, i)).join("");
}

function createTicketCard(ticket, i) {
  const r = ticket.resumen;
  const metaParts = [
    r.fecha || "",
    r.hora  || "",
    r.metodo_pago ? (r.metodo_pago + (r.tarjeta_ultimos4 ? " *" + r.tarjeta_ultimos4 : "")) : "",
    r.num_productos ? `${r.num_productos} producto${r.num_productos !== 1 ? "s" : ""}` : "",
    r.iva ? `IVA $${Number(r.iva).toFixed(2)}` : ""
  ].filter(Boolean);

  return `
    <div class="ticket-card" id="ticket-${i}">
      <div class="ticket-card-header">
        <div class="ticket-info">
          <div class="ticket-store">${esc(r.tienda || "Ticket " + (i + 1))}</div>
          <div class="ticket-meta">${esc(metaParts.join(" · "))}</div>
        </div>
        <div class="ticket-total-badge">${money(r.total)}</div>
      </div>

      <div class="ticket-action-bar">
        <button class="btn-toggle active" id="btn-table-${i}" onclick="toggleTable(${i})">
          📋 Ocultar tabla
        </button>
        <button class="btn-toggle btn-toggle-classify" id="btn-classify-${i}" onclick="toggleClassify(${i})">
          🏷 Clasificar ▾
        </button>
      </div>

      <div class="ticket-table-wrap" id="table-${i}">
        ${buildProductTable(ticket.productos)}
      </div>

      <div class="classify-panel hidden" id="classify-${i}">
        <div class="proyecto-field">
          <label>Proyecto</label>
          <div class="proyecto-grid">
            <div class="proyecto-card active" data-value="Ninguno" onclick="selectProyecto(this, ${i})">
              <div class="proyecto-icon">🏠</div>
              <div class="proyecto-label">Ninguno</div>
              <div class="proyecto-sub">Gasto operativo</div>
            </div>
            <div class="proyecto-card" data-value="Construcción" onclick="selectProyecto(this, ${i})">
              <div class="proyecto-icon">🏗</div>
              <div class="proyecto-label">Construcción</div>
              <div class="proyecto-sub">Obra nueva</div>
            </div>
            <div class="proyecto-card" data-value="Remodelación" onclick="selectProyecto(this, ${i})">
              <div class="proyecto-icon">🔨</div>
              <div class="proyecto-label">Remodelación</div>
              <div class="proyecto-sub">Mejoras a unidad</div>
            </div>
          </div>
          <input type="hidden" id="proyecto-${i}" value="Ninguno">
        </div>

        <div class="field">
          <label>Subcuenta</label>
          <select id="subcuenta-${i}" onchange="onSubcuentaChange(${i})">
            <option value="">— Seleccionar subcuenta —</option>
            <option>Gastos Operativos</option>
            <option>Movimientos Bancarios</option>
            <option>Gastos Familiares</option>
          </select>
        </div>
        <div class="field">
          <label>Categoría</label>
          <select id="categoria-${i}" onchange="onCategoriaChange(${i})" disabled>
            <option value="">— Primero selecciona subcuenta —</option>
          </select>
        </div>
        <div class="field">
          <label>Concepto</label>
          <select id="concepto-${i}" disabled>
            <option value="">— Primero selecciona categoría —</option>
          </select>
        </div>
        <div class="grid">
          <div class="field">
            <label>Propiedad</label>
            <select id="propiedad-${i}">
              <option value="">— Seleccionar —</option>
              <option>Calle Cumbres</option>
              <option>Calle Baja California</option>
              <option>Calle Oaxaca</option>
              <option>Calle José Cárdenas</option>
              <option>Calle Matamoros</option>
            </select>
          </div>
          <div class="field">
            <label># Departamento</label>
            <select id="departamento-${i}">
              <option value="">— Seleccionar —</option>
              ${Array.from({length: 14}, (_, j) => `<option>${j + 1}</option>`).join("")}
            </select>
          </div>
        </div>

        <div class="classify-actions">
          <button class="btn-primary"   onclick="downloadExcelForTicket(${i})">⬇ Descargar Excel</button>
          <button class="btn-secondary" onclick="saveToSheetsForTicket(${i})">📊 Guardar en Sheets</button>
        </div>
        <div class="status-inline" id="status-${i}"></div>
      </div>
    </div>
  `;
}

// ─── Product table ─────────────────────────────────────────────────────────

function buildProductTable(productos) {
  if (!productos?.length) {
    return `<div class="empty-state"><div class="empty-icon">🧾</div><p>Sin productos detectados</p></div>`;
  }
  const cols = [
    { key: "linea_numero",            label: "#" },
    { key: "descripcion",             label: "Descripción" },
    { key: "cantidad",                label: "Cant." },
    { key: "precio_unitario",         label: "P.Unit.", fmt: "money" },
    { key: "monto",                   label: "Monto",   fmt: "money" },
    { key: "categoria_operativa",     label: "Categoría" },
    { key: "deducible_sugerido",      label: "Deducible" },
    { key: "confianza_clasificacion", label: "Confianza" },
  ];
  return `<table>
    <thead><tr>${cols.map(c => `<th>${c.label}</th>`).join("")}</tr></thead>
    <tbody>${productos.map(r =>
      `<tr>${cols.map(c => `<td>${c.fmt === "money" ? money(r[c.key]) : esc(r[c.key])}</td>`).join("")}</tr>`
    ).join("")}</tbody>
  </table>`;
}

// ─── Toggle table ──────────────────────────────────────────────────────────

function toggleTable(i) {
  const wrap = document.getElementById(`table-${i}`);
  const btn  = document.getElementById(`btn-table-${i}`);
  const hidden = wrap.classList.toggle("hidden");
  btn.textContent = hidden ? "📋 Mostrar tabla" : "📋 Ocultar tabla";
  btn.classList.toggle("active", !hidden);
}

// ─── Toggle classify ───────────────────────────────────────────────────────

function toggleClassify(i) {
  const panel = document.getElementById(`classify-${i}`);
  const btn   = document.getElementById(`btn-classify-${i}`);
  const open  = panel.classList.toggle("hidden");
  btn.textContent = open ? "🏷 Clasificar ▾" : "🏷 Clasificar ▴";
  btn.classList.toggle("open", !open);
}

// ─── Proyecto selector (per ticket) ────────────────────────────────────────

function selectProyecto(el, i) {
  el.closest(".proyecto-grid").querySelectorAll(".proyecto-card")
    .forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  document.getElementById(`proyecto-${i}`).value = el.dataset.value;
}

// ─── Cascading dropdowns (per ticket) ──────────────────────────────────────

function populateSelect(selectEl, options, placeholder) {
  selectEl.innerHTML = `<option value="">${placeholder}</option>`;
  options.forEach(opt => {
    const o = document.createElement("option");
    o.value = o.textContent = opt;
    selectEl.appendChild(o);
  });
}

function onSubcuentaChange(i) {
  const sub  = document.getElementById(`subcuenta-${i}`).value;
  const catEl = document.getElementById(`categoria-${i}`);
  const conEl = document.getElementById(`concepto-${i}`);

  if (!sub || !CATALOG[sub]) {
    populateSelect(catEl, [], "— Primero selecciona subcuenta —");
    populateSelect(conEl, [], "— Primero selecciona categoría —");
    catEl.disabled = true; conEl.disabled = true;
    return;
  }

  const cats = Object.keys(CATALOG[sub]);
  populateSelect(catEl, cats, "— Selecciona categoría —");
  catEl.disabled = false;
  populateSelect(conEl, [], "— Primero selecciona categoría —");
  conEl.disabled = true;

  if (cats.length === 1) { catEl.value = cats[0]; onCategoriaChange(i); }
}

function onCategoriaChange(i) {
  const sub   = document.getElementById(`subcuenta-${i}`).value;
  const cat   = document.getElementById(`categoria-${i}`).value;
  const conEl = document.getElementById(`concepto-${i}`);

  const conceptos = CATALOG[sub]?.[cat] || [];
  if (!conceptos.length) {
    populateSelect(conEl, [], "— Sin conceptos disponibles —");
    conEl.disabled = true;
    return;
  }
  populateSelect(conEl, conceptos, "— Selecciona concepto —");
  conEl.disabled = false;
}

// ─── Get classification fields for ticket i ────────────────────────────────

function getClassify(i) {
  return {
    proyecto:     document.getElementById(`proyecto-${i}`)?.value     || "Ninguno",
    subcuenta:    document.getElementById(`subcuenta-${i}`)?.value    || "",
    categoria:    document.getElementById(`categoria-${i}`)?.value    || "",
    concepto:     document.getElementById(`concepto-${i}`)?.value     || "",
    propiedad:    document.getElementById(`propiedad-${i}`)?.value    || "",
    departamento: document.getElementById(`departamento-${i}`)?.value || "",
  };
}

// ─── Per-ticket Excel ──────────────────────────────────────────────────────

async function downloadExcelForTicket(i) {
  try {
    showLoading("Generando Excel...", "Preparando archivo...");
    setStatus(`status-${i}`, "");

    const c    = getClassify(i);
    const form = new FormData();
    form.append("files",       ticketResults[i].file);
    form.append("proyecto",    c.proyecto);
    form.append("subcuenta",   c.subcuenta);
    form.append("categoria",   c.categoria);
    form.append("concepto",    c.concepto);
    form.append("propiedad",   c.propiedad);
    form.append("departamento", c.departamento);

    const res = await fetch(`${BACKEND}/process`, { method: "POST", body: form });
    if (!res.ok) {
      let msg = "Error al generar archivo.";
      try { const d = await res.json(); msg = d.error || msg; } catch (_) {}
      throw new Error(msg);
    }

    const blob     = await res.blob();
    const tienda   = ticketResults[i].resumen.tienda || `ticket_${i + 1}`;
    const filename = `${tienda.replace(/[^a-z0-9]/gi, "_")}_transcripcion.xlsx`;
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(blob), download: filename
    });
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus(`status-${i}`, "Excel descargado correctamente.");
  } catch (err) {
    setStatus(`status-${i}`, "Error: " + err.message);
  } finally {
    hideLoading();
  }
}

// ─── Per-ticket Sheets ─────────────────────────────────────────────────────

async function saveToSheetsForTicket(i) {
  try {
    showLoading("Guardando en Sheets...", "Enviando datos...");
    setStatus(`status-${i}`, "");

    const c    = getClassify(i);
    const form = new FormData();
    form.append("files",        ticketResults[i].file);
    form.append("saveToSheets", "true");
    form.append("proyecto",     c.proyecto);
    form.append("subcuenta",    c.subcuenta);
    form.append("categoria",    c.categoria);
    form.append("concepto",     c.concepto);
    form.append("propiedad",    c.propiedad);
    form.append("departamento", c.departamento);

    const res  = await fetch(`${BACKEND}/process-json`, { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "No se pudo guardar.");

    setStatus(`status-${i}`, "Guardado en Sheets correctamente.");
  } catch (err) {
    setStatus(`status-${i}`, "Error: " + err.message);
  } finally {
    hideLoading();
  }
}

// ─── Utilities ─────────────────────────────────────────────────────────────

function setStatus(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg;
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
