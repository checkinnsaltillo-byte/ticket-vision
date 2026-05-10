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

  const zone = document.getElementById("stepCaptura");
  zone.addEventListener("dragover",  e => { e.preventDefault(); });
  zone.addEventListener("drop", e => {
    e.preventDefault();
    const imgs = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
    addFiles(imgs);
  });
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
}

// ─── Proyecto selector ─────────────────────────────────────────────────────

function selectProyecto(el) {
  document.querySelectorAll(".proyecto-card").forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  document.getElementById("proyecto").value = el.dataset.value;
}

// ─── Cascading dropdowns ────────────────────────────────────────────────────

function populateSelect(selectEl, options, placeholder) {
  selectEl.innerHTML = `<option value="">${placeholder}</option>`;
  options.forEach(opt => {
    const o = document.createElement("option");
    o.value = o.textContent = opt;
    selectEl.appendChild(o);
  });
}

function onSubcuentaChange() {
  const sub  = document.getElementById("subcuenta").value;
  const cat  = document.getElementById("categoria");
  const con  = document.getElementById("concepto");

  if (!sub || !CATALOG[sub]) {
    populateSelect(cat, [], "— Primero selecciona subcuenta —");
    populateSelect(con, [], "— Primero selecciona categoría —");
    cat.disabled = true;
    con.disabled = true;
    return;
  }

  const cats = Object.keys(CATALOG[sub]);
  populateSelect(cat, cats, "— Selecciona categoría —");
  cat.disabled = false;

  populateSelect(con, [], "— Primero selecciona categoría —");
  con.disabled = true;

  // Si solo hay una categoría, seleccionarla automáticamente
  if (cats.length === 1) {
    cat.value = cats[0];
    onCategoriaChange();
  }
}

function onCategoriaChange() {
  const sub     = document.getElementById("subcuenta").value;
  const cat     = document.getElementById("categoria").value;
  const conEl   = document.getElementById("concepto");

  if (!sub || !cat || !CATALOG[sub]?.[cat]) {
    populateSelect(conEl, [], "— Primero selecciona categoría —");
    conEl.disabled = true;
    return;
  }

  const conceptos = CATALOG[sub][cat];
  if (!conceptos.length) {
    populateSelect(conEl, [], "— Sin conceptos disponibles —");
    conEl.disabled = true;
    return;
  }

  populateSelect(conEl, conceptos, "— Selecciona concepto —");
  conEl.disabled = false;
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

function showLoading(title = "Claude está analizando...") {
  document.getElementById("loadingTitle").textContent = title;
  document.getElementById("loadingOverlay").classList.remove("hidden");
}
function hideLoading() {
  document.getElementById("loadingOverlay").classList.add("hidden");
}

// ─── Build form ────────────────────────────────────────────────────────────

function buildFormData() {
  if (!selectedFiles.length) throw new Error("Selecciona al menos una imagen de ticket.");
  const form = new FormData();
  selectedFiles.forEach(f => form.append("files", f));
  form.append("subcuenta",    document.getElementById("subcuenta")?.value    || "");
  form.append("categoria",    document.getElementById("categoria")?.value    || "");
  form.append("concepto",     document.getElementById("concepto")?.value     || "");
  form.append("proyecto",     document.getElementById("proyecto")?.value     || "Ninguno");
  form.append("propiedad",    document.getElementById("propiedad")?.value    || "");
  form.append("departamento", document.getElementById("departamento")?.value || "");
  return form;
}

// ─── Analizar ──────────────────────────────────────────────────────────────

async function analyzeTickets() {
  try {
    showLoading("Claude está analizando...");
    setStatus("Leyendo tickets...");

    const res  = await fetch(`${BACKEND}/process-json`, { method: "POST", body: buildFormData() });
    const data = await res.json();

    if (!res.ok || !data.ok) throw new Error(data.error || "No se pudo procesar.");

    lastRows    = data.productos      || [];
    lastTickets = data.resumen        || [];
    lastCruce   = data.cruce_bancario || [];

    const count = data.total_productos || lastRows.length;
    document.getElementById("resultsSubtitle").textContent =
      `${count} producto${count !== 1 ? "s" : ""} detectado${count !== 1 ? "s" : ""} · ${lastTickets.length} ticket${lastTickets.length !== 1 ? "s" : ""}`;

    renderTicketSummary(lastTickets);
    renderTranscripcion(lastRows);
    renderCruceBancario(lastCruce);

    document.getElementById("resultsSection").classList.remove("hidden");
    document.getElementById("stepClasificar").classList.remove("hidden");

    setStep(2);
    setStatus(`${count} productos detectados.`);

    setTimeout(() => {
      document.getElementById("stepClasificar").scrollIntoView({ behavior: "smooth" });
    }, 200);
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

    const form = buildFormData();
    form.append("saveToSheets", "false");

    const res = await fetch(`${BACKEND}/process`, { method: "POST", body: form });
    if (!res.ok) {
      let msg = "No se pudo generar el archivo.";
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
    setStatus("Excel descargado correctamente.");
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

    const form = buildFormData();
    form.append("saveToSheets", "true");

    const res  = await fetch(`${BACKEND}/process-json`, { method: "POST", body: form });
    const data = await res.json();

    if (!res.ok || !data.ok) throw new Error(data.error || "No se pudo guardar.");

    lastRows    = data.productos      || [];
    lastTickets = data.resumen        || [];
    lastCruce   = data.cruce_bancario || [];

    renderTicketSummary(lastTickets);
    renderTranscripcion(lastRows);
    renderCruceBancario(lastCruce);

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
      ${srow("Fecha",    t.fecha)}
      ${srow("Hora",     t.hora)}
      ${srow("RFC",      t.rfc)}
      ${srow("Folio",    t.folio)}
      ${t.metodo_pago ? srow("Pago", t.metodo_pago + (t.tarjeta_ultimos4 ? " *" + t.tarjeta_ultimos4 : "")) : ""}
      ${srow("Productos", t.num_productos)}
      ${srow("Subtotal",  money(t.subtotal))}
      ${srow("IVA",       money(t.iva))}
      ${t.ieps       ? srow("IEPS",       money(t.ieps))       : ""}
      ${t.descuentos ? srow("Descuentos", money(t.descuentos)) : ""}
      <div class="total-row">
        <span class="t-label">TOTAL</span>
        <span class="t-amount">${money(t.total)}</span>
      </div>
    </div>
  `).join("");
}

function srow(label, value) {
  if (value === undefined || value === null || value === "") return "";
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
    { key: "monto_cruce",      label: "Monto",  fmt: "money" },
    { key: "total_ticket",     label: "Total",  fmt: "money" },
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

// ─── Utilities ─────────────────────────────────────────────────────────────

function emptyState(icon, text) {
  return `<div class="empty-state"><div class="empty-icon">${icon}</div><p>${esc(text)}</p></div>`;
}

function setStatus(msg) {
  const el = document.getElementById("status");
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
