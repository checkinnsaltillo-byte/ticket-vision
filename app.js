const BACKEND = "https://ticket-vision-957627511957.northamerica-south1.run.app";

// ─── Catálogo de clasificaciones ───────────────────────────────────────────
// CATALOG[cuenta][subcuenta] = Object{categoria:[conceptos]} | Array[conceptos]

const CATALOG = {
  "Egresos": {
    "Recursos Humanos": {
      "Limpieza":        ["Brenda", "Alma", "Gaby", "Juanita", "Damariz"],
      "Mantenimiento":   ["Francisco"],
      "Administración":  ["Auxiliar administrativo", "Andres", "Claudia", "Papa"]
    },
    "Gastos Administrativos": {
      "Oficina":       ["Impresiones / Señalítica", "Papelería", "Equipo de cómputo"],
      "Otros gastos":  []
    },
    "Gastos Operativos": {
      "Servicios":     ["Lavandería", "Agua", "Luz", "Gas", "Internet", "Pipas de agua", "Fumigación"],
      "Insumos":       ["Limpieza", "Blancos"],
      "Mantenimiento": ["Ferreteria", "Aparatos electrónicos y focos", "Limpieza de colchones sillones", "Gas de minisplit", "Hidro", "Lavadora / secadora"],
      "Autos":         ["Gasolina", "Seguros", "Mantenimiento"],
      "Otros Gastos":  []
    },
    "Tecnología y automatización": {
      "Plataformas":   ["Lodgify", "Leadsales", "Amazon prime", "Netflix", "GoogleOne", "Breezeway", "Kommo", "Microsoft"],
      "Otros gastos":  []
    },
    "Impuestos y obligaciones": {
      "SAT":      [],
      "IMSS":     [],
      "Tenencia": [],
      "Predial":  []
    }
  },
  "Ingresos": {
    "BBVA ACR Empresarial": ["Trato directo", "Stripe", "Airbnb", "Contratos"],
    "BBVA ACL Libreton":    ["Trato directo", "Stripe", "Airbnb", "Contratos"],
    "Efectivo":             ["Contratos", "Trato directo"]
  },
  "Pasivos": {
    "Devolución de depósitos en garantía": [],
    "Depósitos en garantía":               [],
    "Pago de tarjetas de crédito":         []
  },
  "Activos": {
    "CAPEX / Inversión": {
      "Equipamiento":  ["General", "Depa nuevo", "Decoración", "Reemplazo de minisplit", "Hidro nuevo", "Lavadora / secadora nueva", "Colchón", "Mesa", "Silla", "Sillón", "Refrigerador nuevo", "Abanico", "Smart tv", "Boiler nuevo"],
      "Herramienta":   [],
      "Construcción":  ["Material", "Mano de obra", "Eléctrico", "Plomería", "Otros gastos", "Pintura", "Herrería", "Carpintería", "Yesería", "Puertas y ventanas"]
    },
    "Inversiones financieras": []
  },
  "Capital": {
    "Utilidad":          [],
    "Gastos Familiares": ["Viajes", "Gatos casa", "Gastos médicos", "Otros gastos"]
  }
};

const CUENTA_EMOJIS = {
  "Egresos":  "💸",
  "Ingresos": "💰",
  "Pasivos":  "📋",
  "Activos":  "📈",
  "Capital":  "💼"
};

const SUBCUENTA_EMOJIS = {
  "Recursos Humanos":                     "👥",
  "Gastos Administrativos":               "📁",
  "Gastos Operativos":                    "🏢",
  "Tecnología y automatización":          "💻",
  "Impuestos y obligaciones":             "🧾",
  "BBVA ACR Empresarial":                 "🏦",
  "BBVA ACL Libreton":                    "🏦",
  "Efectivo":                             "💵",
  "Devolución de depósitos en garantía":  "↩️",
  "Depósitos en garantía":                "🔒",
  "Pago de tarjetas de crédito":          "💳",
  "CAPEX / Inversión":                    "🏗",
  "Inversiones financieras":              "📊",
  "Utilidad":                             "✨",
  "Gastos Familiares":                    "🏠"
};

// ─── Search index ─────────────────────────────────────────────────────────

function buildSearchIndex() {
  const index = [];
  for (const cuenta of Object.keys(CATALOG)) {
    for (const subcuenta of Object.keys(CATALOG[cuenta])) {
      const sub = CATALOG[cuenta][subcuenta];
      if (Array.isArray(sub)) {
        if (sub.length === 0) {
          index.push({ cuenta, subcuenta, categoria: "", concepto: "" });
        } else {
          for (const concepto of sub) {
            index.push({ cuenta, subcuenta, categoria: "", concepto });
          }
        }
      } else {
        for (const categoria of Object.keys(sub)) {
          const conceptos = sub[categoria];
          if (conceptos.length === 0) {
            index.push({ cuenta, subcuenta, categoria, concepto: "" });
          } else {
            for (const concepto of conceptos) {
              index.push({ cuenta, subcuenta, categoria, concepto });
            }
          }
        }
      }
    }
  }
  return index;
}

const SEARCH_INDEX = buildSearchIndex();
let searchMatches = {};

// ─── State ─────────────────────────────────────────────────────────────────

let selectedFiles = [];
let ticketResults = [];

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

// ─── Analyze ───────────────────────────────────────────────────────────────

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

// ─── Render ticket cards ────────────────────────────────────────────────────

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

  const deptOptions = Array.from({length: 14}, (_, j) => `<option>${j + 1}</option>`).join("");

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

        <div class="classify-search-wrap">
          <input type="text" id="search-${i}" class="classify-search"
                 placeholder="🔍 Buscar cuenta, subcuenta, categoría, concepto..."
                 oninput="onClassifySearch(${i}, this.value)"
                 onblur="setTimeout(() => hideSearchResults(${i}), 180)">
          <div class="search-results hidden" id="search-results-${i}"></div>
        </div>

        <div class="cuenta-field">
          <label>Cuenta</label>
          <div class="cuenta-grid" id="cuenta-grid-${i}">
            ${buildCuentaCards(i)}
          </div>
          <input type="hidden" id="cuenta-${i}" value="">
        </div>

        <div class="subcuenta-field hidden" id="subcuenta-field-${i}">
          <label>Subcuenta</label>
          <div class="cuenta-grid cuenta-grid--sub" id="subcuenta-grid-${i}"></div>
          <input type="hidden" id="subcuenta-${i}" value="">
        </div>

        <div class="field hidden" id="categoria-field-${i}">
          <label>Categoría</label>
          <select id="categoria-${i}" onchange="onCategoriaChange(${i})">
            <option value="">— Selecciona categoría —</option>
          </select>
        </div>

        <div class="field hidden" id="concepto-field-${i}">
          <label>Concepto</label>
          <select id="concepto-${i}">
            <option value="">— Selecciona concepto —</option>
          </select>
        </div>

        <div class="field">
          <label>Descripción <span class="label-opt">(opcional)</span></label>
          <input type="text" id="descripcion-${i}" placeholder="Notas o descripción adicional...">
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
              ${deptOptions}
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

function buildCuentaCards(i) {
  return Object.keys(CATALOG).map(name => {
    const emoji = CUENTA_EMOJIS[name] || "📂";
    return `<div class="cuenta-card" data-value="${esc(name)}" onclick="selectCuenta(this,${i})"><div class="cuenta-icon">${emoji}</div><div class="cuenta-label">${esc(name)}</div></div>`;
  }).join("");
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

// ─── Toggle table / classify ────────────────────────────────────────────────

function toggleTable(i) {
  const wrap   = document.getElementById(`table-${i}`);
  const btn    = document.getElementById(`btn-table-${i}`);
  const hidden = wrap.classList.toggle("hidden");
  btn.textContent = hidden ? "📋 Mostrar tabla" : "📋 Ocultar tabla";
  btn.classList.toggle("active", !hidden);
}

function toggleClassify(i) {
  const panel = document.getElementById(`classify-${i}`);
  const btn   = document.getElementById(`btn-classify-${i}`);
  const open  = panel.classList.toggle("hidden");
  btn.textContent = open ? "🏷 Clasificar ▾" : "🏷 Clasificar ▴";
  btn.classList.toggle("open", !open);
}

// ─── Cuenta / Subcuenta selection ──────────────────────────────────────────

function selectCuenta(el, i) {
  el.closest(".cuenta-grid").querySelectorAll(".cuenta-card").forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  const cuenta = el.dataset.value;
  document.getElementById(`cuenta-${i}`).value = cuenta;
  renderSubcuentas(cuenta, i);
  resetFromCategoria(i);
  document.getElementById(`subcuenta-${i}`).value = "";
}

function renderSubcuentas(cuenta, i) {
  const field = document.getElementById(`subcuenta-field-${i}`);
  const grid  = document.getElementById(`subcuenta-grid-${i}`);
  const subs  = CATALOG[cuenta] ? Object.keys(CATALOG[cuenta]) : [];

  if (!subs.length) { field.classList.add("hidden"); return; }

  grid.innerHTML = subs.map(name => {
    const emoji = SUBCUENTA_EMOJIS[name] || "📌";
    return `<div class="cuenta-card" data-value="${esc(name)}" onclick="selectSubcuenta(this,${i})"><div class="cuenta-icon">${emoji}</div><div class="cuenta-label">${esc(name)}</div></div>`;
  }).join("");

  field.classList.remove("hidden");
}

function selectSubcuenta(el, i) {
  el.closest(".cuenta-grid").querySelectorAll(".cuenta-card").forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  const subcuenta = el.dataset.value;
  document.getElementById(`subcuenta-${i}`).value = subcuenta;

  const cuenta = document.getElementById(`cuenta-${i}`).value;
  const sub    = CATALOG[cuenta]?.[subcuenta];

  resetFromCategoria(i);

  if (Array.isArray(sub)) {
    if (sub.length > 0) {
      populateSelect(document.getElementById(`concepto-${i}`), sub, "— Selecciona concepto —");
      document.getElementById(`concepto-field-${i}`).classList.remove("hidden");
    }
  } else if (sub && typeof sub === "object") {
    const cats = Object.keys(sub);
    if (cats.length > 0) {
      populateSelect(document.getElementById(`categoria-${i}`), cats, "— Selecciona categoría —");
      document.getElementById(`categoria-field-${i}`).classList.remove("hidden");
    }
  }
}

function onCategoriaChange(i) {
  const cuenta    = document.getElementById(`cuenta-${i}`).value;
  const subcuenta = document.getElementById(`subcuenta-${i}`).value;
  const categoria = document.getElementById(`categoria-${i}`).value;
  const conEl     = document.getElementById(`concepto-${i}`);
  const conField  = document.getElementById(`concepto-field-${i}`);

  const conceptos = CATALOG[cuenta]?.[subcuenta]?.[categoria] || [];
  if (conceptos.length > 0) {
    populateSelect(conEl, conceptos, "— Selecciona concepto —");
    conField.classList.remove("hidden");
  } else {
    conField.classList.add("hidden");
  }
}

function resetFromCategoria(i) {
  document.getElementById(`categoria-field-${i}`)?.classList.add("hidden");
  document.getElementById(`concepto-field-${i}`)?.classList.add("hidden");
  populateSelect(document.getElementById(`categoria-${i}`), [], "— Selecciona categoría —");
  populateSelect(document.getElementById(`concepto-${i}`),  [], "— Selecciona concepto —");
}

// ─── Search ────────────────────────────────────────────────────────────────

function onClassifySearch(i, q) {
  const resEl = document.getElementById(`search-results-${i}`);
  if (!q.trim()) { resEl.classList.add("hidden"); return; }

  const lower   = q.toLowerCase();
  const matches = SEARCH_INDEX.filter(e =>
    [e.cuenta, e.subcuenta, e.categoria, e.concepto].some(f => f.toLowerCase().includes(lower))
  ).slice(0, 10);

  searchMatches[i] = matches;

  if (!matches.length) {
    resEl.innerHTML = `<div class="search-no-results">Sin resultados para "${esc(q)}"</div>`;
    resEl.classList.remove("hidden");
    return;
  }

  resEl.innerHTML = matches.map((m, idx) => {
    const parts = [m.cuenta, m.subcuenta, m.categoria, m.concepto].filter(Boolean);
    const html  = parts.map(p => `<span>${esc(p)}</span>`).join(`<span class="search-sep">›</span>`);
    return `<div class="search-result-item" onmousedown="applySearchResult(${i},${idx})">${html}</div>`;
  }).join("");
  resEl.classList.remove("hidden");
}

function hideSearchResults(i) {
  document.getElementById(`search-results-${i}`)?.classList.add("hidden");
}

function applySearchResult(i, idx) {
  const m = (searchMatches[i] || [])[idx];
  if (!m) return;

  // Apply cuenta
  const cuentaGrid = document.getElementById(`cuenta-grid-${i}`);
  const cuentaCard = Array.from(cuentaGrid.querySelectorAll(".cuenta-card")).find(c => c.dataset.value === m.cuenta);
  if (cuentaCard) selectCuenta(cuentaCard, i);

  // Apply subcuenta (subcuenta grid must be rendered first)
  if (m.subcuenta) {
    const subGrid = document.getElementById(`subcuenta-grid-${i}`);
    const subCard = subGrid ? Array.from(subGrid.querySelectorAll(".cuenta-card")).find(c => c.dataset.value === m.subcuenta) : null;
    if (subCard) selectSubcuenta(subCard, i);
  }

  // Apply categoria
  if (m.categoria) {
    const catEl = document.getElementById(`categoria-${i}`);
    if (catEl) { catEl.value = m.categoria; onCategoriaChange(i); }
  }

  // Apply concepto
  if (m.concepto) {
    const conEl = document.getElementById(`concepto-${i}`);
    if (conEl) conEl.value = m.concepto;
  }

  // Clear search input and close dropdown
  document.getElementById(`search-${i}`).value = "";
  hideSearchResults(i);
}

// ─── Get classification values ──────────────────────────────────────────────

function getClassify(i) {
  return {
    cuenta:       document.getElementById(`cuenta-${i}`)?.value       || "",
    subcuenta:    document.getElementById(`subcuenta-${i}`)?.value    || "",
    categoria:    document.getElementById(`categoria-${i}`)?.value    || "",
    concepto:     document.getElementById(`concepto-${i}`)?.value     || "",
    descripcion:  document.getElementById(`descripcion-${i}`)?.value  || "",
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
    form.append("files",        ticketResults[i].file);
    form.append("cuenta",       c.cuenta);
    form.append("subcuenta",    c.subcuenta);
    form.append("categoria",    c.categoria);
    form.append("concepto",     c.concepto);
    form.append("descripcion",  c.descripcion);
    form.append("propiedad",    c.propiedad);
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
    form.append("cuenta",       c.cuenta);
    form.append("subcuenta",    c.subcuenta);
    form.append("categoria",    c.categoria);
    form.append("concepto",     c.concepto);
    form.append("descripcion",  c.descripcion);
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

function populateSelect(selectEl, options, placeholder) {
  if (!selectEl) return;
  selectEl.innerHTML = `<option value="">${placeholder}</option>`;
  options.forEach(opt => {
    const o = document.createElement("option");
    o.value = o.textContent = opt;
    selectEl.appendChild(o);
  });
}

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
