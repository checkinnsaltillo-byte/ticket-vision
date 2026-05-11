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

const CONCEPTO_EMOJIS = {
  // Personas
  "Brenda":"👩","Alma":"👩","Gaby":"👩","Juanita":"👩","Damariz":"👩",
  "Francisco":"👨","Auxiliar administrativo":"👔","Andres":"👨","Claudia":"👩","Papa":"👨‍👧",
  // Oficina
  "Impresiones / Señalítica":"🖨️","Papelería":"📄","Equipo de cómputo":"💻",
  // Servicios
  "Lavandería":"👕","Agua":"💧","Luz":"💡","Gas":"🔥","Internet":"🌐",
  "Pipas de agua":"🚛","Fumigación":"🪲",
  // Insumos
  "Limpieza":"🧹","Blancos":"🛏️",
  // Mantenimiento
  "Ferreteria":"🔧","Aparatos electrónicos y focos":"💡","Limpieza de colchones sillones":"🛋️",
  "Gas de minisplit":"❄️","Hidro":"🛁","Lavadora / secadora":"🫧",
  // Autos
  "Gasolina":"⛽","Seguros":"🛡️","Mantenimiento":"🔧",
  // Plataformas
  "Lodgify":"🏨","Leadsales":"📱","Amazon prime":"📦","Netflix":"🎬",
  "GoogleOne":"☁️","Breezeway":"🏠","Kommo":"💬","Microsoft":"🪟",
  // Ingresos
  "Trato directo":"🤝","Stripe":"💳","Airbnb":"🏡","Contratos":"📋",
  // Capital
  "Viajes":"✈️","Gatos casa":"🏠","Gastos médicos":"🏥","Otros gastos":"📦",
  // Activos CAPEX
  "General":"📦","Depa nuevo":"🏗️","Decoración":"🖼️","Reemplazo de minisplit":"❄️",
  "Hidro nuevo":"🛁","Lavadora / secadora nueva":"🫧","Colchón":"🛏️",
  "Mesa":"🪑","Silla":"🪑","Sillón":"🛋️","Refrigerador nuevo":"🧊",
  "Abanico":"💨","Smart tv":"📺","Boiler nuevo":"🚿",
  // Construcción
  "Material":"🧱","Mano de obra":"👷","Eléctrico":"⚡","Plomería":"🔩",
  "Pintura":"🎨","Herrería":"⚒️","Carpintería":"🪵","Yesería":"🏛️",
  "Puertas y ventanas":"🚪","Otros Gastos":"📦","Otros gastos":"📦",
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
  document.getElementById("btnGuardarResultados").classList.toggle("hidden", !ticketResults.length);
}

const PAYMENT_CHIP = {
  VISA:            { emoji: "💳", color: "#1a56db", bg: "#e8f0fe" },
  MASTERCARD:      { emoji: "💳", color: "#c0392b", bg: "#fde8e8" },
  AMEX:            { emoji: "💳", color: "#1f7a4c", bg: "#d1fae5" },
  TARJETA_DEBITO:  { emoji: "🏦", color: "#6d28d9", bg: "#ede9fe" },
  TARJETA_CREDITO: { emoji: "💳", color: "#b45309", bg: "#fef3c7" },
  TARJETA_BANCO:   { emoji: "🏦", color: "#1e40af", bg: "#dbeafe" },
  EFECTIVO:        { emoji: "💵", color: "#065f46", bg: "#d1fae5" },
  TRANSFERENCIA:   { emoji: "🔄", color: "#0e7490", bg: "#cffafe" },
  QR:              { emoji: "📱", color: "#7c3aed", bg: "#f3e8ff" },
};

const PAYMENT_LABEL = {
  VISA:            "Visa",
  MASTERCARD:      "Mastercard",
  AMEX:            "Amex",
  TARJETA_DEBITO:  "Tarjeta débito",
  TARJETA_CREDITO: "Tarjeta crédito",
  TARJETA_BANCO:   "Tarjeta banco",
  EFECTIVO:        "Efectivo",
  TRANSFERENCIA:   "Transferencia",
  QR:              "Pago QR",
};

const PAYMENT_ALIASES = {
  TARJETA_DE_DEBITO:  "TARJETA_DEBITO",
  TARJETA_DE_CREDITO: "TARJETA_CREDITO",
  DEBITO:             "TARJETA_DEBITO",
  CREDITO:            "TARJETA_CREDITO",
  DEBIT:              "TARJETA_DEBITO",
  CREDIT:             "TARJETA_CREDITO",
  CASH:               "EFECTIVO",
};

function normalizePaymentKey(method) {
  if (!method) return "";
  const clean = method.toUpperCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return PAYMENT_ALIASES[clean] || clean;
}

function paymentChip(method, last4) {
  if (!method) return "";
  const key   = normalizePaymentKey(method);
  const p     = PAYMENT_CHIP[key] || { emoji: "💳", color: "#374151", bg: "#f3f4f6" };
  const label = (PAYMENT_LABEL[key] || key.replace(/_/g, " ")) + (last4 ? " *" + last4 : "");
  return `<span class="info-chip" style="color:${p.color};background:${p.bg}">${p.emoji} ${label}</span>`;
}

function createTicketCard(ticket, i) {
  const r = ticket.resumen;
  const metaParts = [r.fecha || "", r.hora || ""].filter(Boolean);

  const rawSummary = (ticket.productos || [])
    .map(p => p.descripcion || "").filter(Boolean).join(", ");
  const productSummary = rawSummary.length > 95 ? rawSummary.slice(0, 92) + "…" : rawSummary;

  const deptOptions = Array.from({length: 14}, (_, j) => `<option>${j + 1}</option>`).join("");

  return `
    <div class="ticket-card" id="ticket-${i}">
      <div class="ticket-card-header" onclick="toggleTable(${i})" id="header-${i}">
        <div class="ticket-info">
          <div class="header-chips">
            <span class="info-chip hidden" id="cuenta-chip-${i}"></span>
            <span class="info-chip hidden" id="encargado-chip-${i}"></span>
            <span class="info-chip hidden" id="propiedad-chip-${i}"></span>
            <span class="info-chip hidden" id="dept-chip-${i}"></span>
          </div>
          <div class="ticket-store">${esc(r.tienda || "Ticket " + (i + 1))}</div>
          <div class="ticket-meta">
            ${esc(metaParts.join(" · "))}${metaParts.length ? " · " : ""}🧾 ${r.num_productos || 0} producto${(r.num_productos || 0) !== 1 ? "s" : ""}
          </div>
          ${productSummary ? `<div class="product-summary">${esc(productSummary)}</div>` : ""}
        </div>
        <div class="ticket-header-right">
          ${paymentChip(r.metodo_pago, r.tarjeta_ultimos4)}
          <div class="ticket-total-badge" id="total-badge-${i}">
            <span class="total-main">${money(r.total)}</span>
            ${r.iva ? `<span class="total-iva">IVA ${money(r.iva)}</span>` : ""}
          </div>
        </div>
      </div>

      <div class="ticket-table-wrap hidden" id="table-${i}">
        <div class="ticket-tabs">
          <button class="ticket-tab active" onclick="showTicketTab(${i},'transcripcion',this)">Transcripción</button>
          <button class="ticket-tab" onclick="showTicketTab(${i},'resumen',this)">Resumen</button>
          <button class="ticket-tab" onclick="showTicketTab(${i},'cruce',this)">Cruce bancario</button>
        </div>
        <div id="tab-transcripcion-${i}" class="ticket-tab-content">${buildProductTable(ticket.productos)}</div>
        <div id="tab-resumen-${i}" class="ticket-tab-content hidden">${buildResumenTable(ticket.resumen)}</div>
        <div id="tab-cruce-${i}" class="ticket-tab-content hidden">${buildCruceTable(ticket.cruce)}</div>
      </div>

      <div class="classify-tab" id="btn-classify-${i}" onclick="toggleClassify(${i})">
        <span class="classify-tab-arrow">›</span>
        <span class="classify-tab-label">Clasificar</span>
      </div>

      <div class="classify-panel hidden" id="classify-${i}">

        <div class="classify-search-wrap">
          <input type="text" id="search-${i}" class="classify-search"
                 placeholder="🔍 Buscar por cuenta, subcuenta, categoría o concepto..."
                 oninput="onClassifySearch(${i}, this.value)"
                 onblur="setTimeout(()=>hideSearchResults(${i}), 180)">
          <div class="search-results hidden" id="search-results-${i}"></div>
        </div>

        <div class="cuenta-field">
          <label>Cuenta</label>
          <div class="cuenta-grid" id="cuenta-grid-${i}">
            <div class="cuenta-card active" data-value="" onclick="selectCuenta(this,${i})">
              <div class="cuenta-icon">🏠</div>
              <div class="cuenta-label">Sin cuenta</div>
              <div class="cuenta-sub">General</div>
            </div>
            <div class="cuenta-card" data-value="Egresos" onclick="selectCuenta(this,${i})">
              <div class="cuenta-icon">💸</div>
              <div class="cuenta-label">Egresos</div>
              <div class="cuenta-sub">Gastos y pagos</div>
            </div>
            <div class="cuenta-card" data-value="Ingresos" onclick="selectCuenta(this,${i})">
              <div class="cuenta-icon">💰</div>
              <div class="cuenta-label">Ingresos</div>
              <div class="cuenta-sub">Cobros y entradas</div>
            </div>
            <div class="cuenta-card" data-value="Pasivos" onclick="selectCuenta(this,${i})">
              <div class="cuenta-icon">📋</div>
              <div class="cuenta-label">Pasivos</div>
              <div class="cuenta-sub">Obligaciones</div>
            </div>
            <div class="cuenta-card" data-value="Activos" onclick="selectCuenta(this,${i})">
              <div class="cuenta-icon">📈</div>
              <div class="cuenta-label">Activos</div>
              <div class="cuenta-sub">Inversión / CAPEX</div>
            </div>
            <div class="cuenta-card" data-value="Capital" onclick="selectCuenta(this,${i})">
              <div class="cuenta-icon">💼</div>
              <div class="cuenta-label">Capital</div>
              <div class="cuenta-sub">Utilidad / Familiar</div>
            </div>
          </div>
          <input type="hidden" id="cuenta-${i}" value="">
        </div>

        <div class="cuenta-field hidden" id="subcuenta-field-${i}">
          <label>Subcuenta</label>
          <div class="cuenta-grid cuenta-grid--sub" id="subcuenta-grid-${i}"></div>
          <input type="hidden" id="subcuenta-${i}" value="">
        </div>

        <div class="cuenta-field hidden" id="categoria-field-${i}">
          <label>Categoría</label>
          <div class="cuenta-grid cuenta-grid--cat" id="categoria-grid-${i}"></div>
          <input type="hidden" id="categoria-${i}" value="">
        </div>

        <div class="cuenta-field hidden" id="concepto-field-${i}">
          <label>Concepto</label>
          <div class="cuenta-grid" id="concepto-grid-${i}"></div>
          <input type="hidden" id="concepto-${i}" value="">
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

        <div class="cuenta-field">
          <label>Encargado de operación</label>
          <div class="cuenta-grid cuenta-grid--compact" id="comprador-grid-${i}">
            <div class="cuenta-card" data-value="ACR" onclick="selectComprador(this,${i})">
              <div class="cuenta-icon">👤</div><div class="cuenta-label">ACR</div>
            </div>
            <div class="cuenta-card" data-value="ACL" onclick="selectComprador(this,${i})">
              <div class="cuenta-icon">👤</div><div class="cuenta-label">ACL</div>
            </div>
            <div class="cuenta-card" data-value="CCL" onclick="selectComprador(this,${i})">
              <div class="cuenta-icon">👤</div><div class="cuenta-label">CCL</div>
            </div>
            <div class="cuenta-card" data-value="Otro" onclick="selectComprador(this,${i})">
              <div class="cuenta-icon">✏️</div><div class="cuenta-label">Otro</div>
            </div>
          </div>
          <input type="hidden" id="comprador-${i}" value="">
          <div class="hidden" id="comprador-otro-${i}" style="margin-top:8px">
            <input type="text" id="comprador-otro-text-${i}" class="classify-search"
                   placeholder="Especifica el comprador..." style="font-size:13px;padding:10px 14px">
          </div>
        </div>

        <div class="cuenta-field">
          <label>Comentarios</label>
          <textarea id="comentarios-${i}" class="classify-textarea"
                    placeholder="Notas adicionales sobre este ticket..."></textarea>
        </div>

        <div class="classify-actions">
          <button class="btn-clasificar-ticket" onclick="clasificarTicket(${i})">✓ Clasificar</button>
        </div>
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

function buildResumenTable(r) {
  if (!r) return `<div class="empty-state"><p>Sin datos de resumen</p></div>`;
  const rows = [
    ["Tienda",             r.tienda],
    ["RFC",                r.rfc],
    ["Fecha",              r.fecha],
    ["Hora",               r.hora],
    ["Folio",              r.folio],
    ["Método de pago",     r.metodo_pago],
    ["Últimos 4 dígitos",  r.tarjeta_ultimos4],
    ["# Productos",        r.num_productos],
    ["Subtotal",           r.subtotal ? money(r.subtotal) : null],
    ["IVA",                r.iva       ? money(r.iva)      : null],
    ["IEPS",               r.ieps      ? money(r.ieps)     : null],
    ["Descuentos",         r.descuentos? money(r.descuentos): null],
    ["Total",              r.total     ? money(r.total)    : null],
    ["Cuenta",             r.cuenta],
    ["Subcuenta",          r.subcuenta],
    ["Categoría",          r.categoria_gasto],
    ["Concepto",           r.concepto],
    ["Propiedad",          r.propiedad],
    ["Departamento",       r.departamento],
    ["Fecha captura",      r.fecha_captura],
  ].filter(([, v]) => v !== "" && v != null);
  return `<table>
    <thead><tr><th>Campo</th><th>Valor</th></tr></thead>
    <tbody>${rows.map(([k, v]) => `<tr><td class="resumen-key">${k}</td><td>${esc(String(v))}</td></tr>`).join("")}</tbody>
  </table>`;
}

function buildCruceTable(c) {
  if (!c || !Object.keys(c).length) return `<div class="empty-state"><div class="empty-icon">🏦</div><p>Sin datos de cruce bancario</p></div>`;
  const rows = [
    ["Fecha",              c.fecha],
    ["Hora",               c.hora],
    ["Comercio",           c.comercio],
    ["RFC",                c.rfc],
    ["Folio",              c.folio],
    ["Método de pago",     c.metodo_pago],
    ["Últimos 4 dígitos",  c.tarjeta_ultimos4],
    ["Monto cruce",        c.monto_cruce ? money(c.monto_cruce) : null],
    ["Total ticket",       c.total_ticket? money(c.total_ticket): null],
    ["Cuenta",             c.cuenta],
    ["Subcuenta",          c.subcuenta],
    ["Propiedad",          c.propiedad],
    ["Departamento",       c.departamento],
  ].filter(([, v]) => v !== "" && v != null);
  return `<table>
    <thead><tr><th>Campo</th><th>Valor</th></tr></thead>
    <tbody>${rows.map(([k, v]) => `<tr><td class="resumen-key">${k}</td><td>${esc(String(v))}</td></tr>`).join("")}</tbody>
  </table>`;
}

function showTicketTab(i, tab, btn) {
  ["transcripcion", "resumen", "cruce"].forEach(t => {
    document.getElementById(`tab-${t}-${i}`).classList.toggle("hidden", t !== tab);
  });
  btn.closest(".ticket-tabs").querySelectorAll(".ticket-tab").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
}

// ─── Toggle table / classify ────────────────────────────────────────────────

function toggleTable(i) {
  const wrap   = document.getElementById(`table-${i}`);
  const header = document.getElementById(`header-${i}`);
  const hidden = wrap.classList.toggle("hidden");
  header.classList.toggle("collapsed", hidden);
}

function toggleClassify(i) {
  const panel = document.getElementById(`classify-${i}`);
  const tab   = document.getElementById(`btn-classify-${i}`);
  const open  = panel.classList.toggle("hidden");
  tab.classList.toggle("open", !open);
}

const CUENTA_COLOR_CLASS = {
  "Ingresos": "ci-ingresos",
  "Egresos":  "ci-egresos",
  "Capital":  "ci-capital",
  "Activos":  "ci-activos",
  "Pasivos":  "ci-pasivos",
};

const ALL_CI = ["ci-ingresos","ci-egresos","ci-capital","ci-activos","ci-pasivos","ci-sincuenta"];

function guardarResultados() {
  // Por vincular con Google Sheets
}

function clasificarTicket(i) {
  markAsClassified(i);
  // Cerrar el panel después de clasificar
  document.getElementById(`classify-${i}`).classList.add("hidden");
  document.getElementById(`btn-classify-${i}`).classList.remove("open");
}

function markAsClassified(i) {
  const c        = getClassify(i);
  const header   = document.getElementById(`header-${i}`);
  const tab      = document.getElementById(`btn-classify-${i}`);
  const colorCls = CUENTA_COLOR_CLASS[c.cuenta] || "ci-sincuenta";

  // Header color
  ALL_CI.forEach(cls => header.classList.remove(cls));
  header.classList.add("classified", colorCls);

  // Tab color (same clase, CSS defines darker shade)
  ALL_CI.forEach(cls => tab.classList.remove(cls));
  tab.classList.add("classified", colorCls);

  // Badge color — same cuenta color as tab
  const badge = document.getElementById(`total-badge-${i}`);
  ALL_CI.forEach(cls => badge.classList.remove(cls));
  badge.classList.add("classified", colorCls);

  // 1. Cuenta chip
  const cuentaChipEl = document.getElementById(`cuenta-chip-${i}`);
  if (c.cuenta) {
    cuentaChipEl.textContent = (CUENTA_EMOJIS[c.cuenta] || "") + " " + c.cuenta;
    ALL_CI.forEach(cls => cuentaChipEl.classList.remove(cls));
    cuentaChipEl.classList.remove("hidden");
    cuentaChipEl.classList.add(colorCls);
  } else {
    cuentaChipEl.classList.add("hidden");
  }

  // 3. Encargado de operación chip
  const encargadoEl = document.getElementById(`encargado-chip-${i}`);
  if (c.comprador) {
    encargadoEl.textContent = "👤 " + c.comprador;
    encargadoEl.classList.remove("hidden");
  } else {
    encargadoEl.classList.add("hidden");
  }

  // 4. Propiedad chip
  const propiedadEl = document.getElementById(`propiedad-chip-${i}`);
  if (c.propiedad) {
    propiedadEl.textContent = "🏠 " + c.propiedad;
    propiedadEl.classList.remove("hidden");
  } else {
    propiedadEl.classList.add("hidden");
  }

  // 5. Departamento chip
  const deptEl = document.getElementById(`dept-chip-${i}`);
  if (c.departamento) {
    deptEl.textContent = "🚪 Depto. " + c.departamento;
    deptEl.classList.remove("hidden");
  } else {
    deptEl.classList.add("hidden");
  }

  // Path in tab label
  const parts    = [c.cuenta, c.subcuenta, c.categoria, c.concepto].filter(Boolean);
  const pathText = parts.join(" › ") || "Sin clasificar";
  const labelEl  = tab.querySelector(".classify-tab-label");
  labelEl.textContent = pathText;
  labelEl.style.cssText = "font-size:10px;text-transform:none;letter-spacing:.01em;font-weight:700;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px;";
}

// ─── Emojis por categoría ──────────────────────────────────────────────────

const CATEGORIA_EMOJIS = {
  "Limpieza":        "🧹",
  "Mantenimiento":   "🔧",
  "Administración":  "📝",
  "Oficina":         "🖊️",
  "Otros gastos":    "📦",
  "Otros Gastos":    "📦",
  "Servicios":       "⚡",
  "Insumos":         "🛍️",
  "Autos":           "🚗",
  "Plataformas":     "💻",
  "SAT":             "🏛️",
  "IMSS":            "🏥",
  "Tenencia":        "📄",
  "Predial":         "🏘️",
  "Equipamiento":    "🛋️",
  "Herramienta":     "🔨",
  "Construcción":    "🏗️",
};

// ─── Card HTML helper ──────────────────────────────────────────────────────

function makeCard(name, emoji, onclick) {
  return `<div class="cuenta-card" data-value="${esc(name)}" onclick="${onclick}">` +
    `<div class="cuenta-icon">${emoji}</div>` +
    `<div class="cuenta-label">${esc(name)}</div>` +
    `</div>`;
}

// ─── Cuenta / Subcuenta / Categoría / Concepto (cascading cards) ───────────

function selectCuenta(el, i) {
  el.closest(".cuenta-grid").querySelectorAll(".cuenta-card").forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  document.getElementById(`cuenta-${i}`).value = el.dataset.value;
  resetSubcuenta(i);

  const cuenta = el.dataset.value;
  const subs   = cuenta && CATALOG[cuenta] ? Object.keys(CATALOG[cuenta]) : [];
  if (!subs.length) return;

  document.getElementById(`subcuenta-grid-${i}`).innerHTML =
    subs.map(n => makeCard(n, SUBCUENTA_EMOJIS[n] || "📌", `selectSubcuenta(this,${i})`)).join("");
  document.getElementById(`subcuenta-field-${i}`).classList.remove("hidden");
}

function resetSubcuenta(i) {
  document.getElementById(`subcuenta-${i}`).value = "";
  document.getElementById(`subcuenta-field-${i}`).classList.add("hidden");
  document.getElementById(`subcuenta-grid-${i}`).innerHTML = "";
  resetCategoria(i);
}

function selectSubcuenta(el, i) {
  el.closest(".cuenta-grid").querySelectorAll(".cuenta-card").forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  const subcuenta = el.dataset.value;
  document.getElementById(`subcuenta-${i}`).value = subcuenta;
  resetCategoria(i);

  const cuenta = document.getElementById(`cuenta-${i}`).value;
  const sub    = CATALOG[cuenta]?.[subcuenta];

  if (Array.isArray(sub)) {
    // Ingresos / Capital: sin nivel Categoría, concepto directo
    if (sub.length) renderConceptos(sub, i);
  } else if (sub) {
    const cats = Object.keys(sub);
    if (!cats.length) return;
    document.getElementById(`categoria-grid-${i}`).innerHTML =
      cats.map(n => makeCard(n, CATEGORIA_EMOJIS[n] || "📂", `selectCategoria(this,${i})`)).join("");
    document.getElementById(`categoria-field-${i}`).classList.remove("hidden");
  }
}

function resetCategoria(i) {
  document.getElementById(`categoria-${i}`).value = "";
  document.getElementById(`categoria-field-${i}`).classList.add("hidden");
  document.getElementById(`categoria-grid-${i}`).innerHTML = "";
  resetConcepto(i);
}

function resetConcepto(i) {
  document.getElementById(`concepto-${i}`).value = "";
  document.getElementById(`concepto-field-${i}`).classList.add("hidden");
  document.getElementById(`concepto-grid-${i}`).innerHTML = "";
}

function renderConceptos(conceptos, i) {
  document.getElementById(`concepto-grid-${i}`).innerHTML =
    conceptos.map(n => makeCard(n, CONCEPTO_EMOJIS[n] || "🔹", `selectConcepto(this,${i})`)).join("");
  document.getElementById(`concepto-field-${i}`).classList.remove("hidden");
}

function selectConcepto(el, i) {
  el.closest(".cuenta-grid").querySelectorAll(".cuenta-card").forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  document.getElementById(`concepto-${i}`).value = el.dataset.value;
}

function selectCategoria(el, i) {
  el.closest(".cuenta-grid").querySelectorAll(".cuenta-card").forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  const categoria = el.dataset.value;
  document.getElementById(`categoria-${i}`).value = categoria;
  resetConcepto(i);

  const cuenta    = document.getElementById(`cuenta-${i}`).value;
  const subcuenta = document.getElementById(`subcuenta-${i}`).value;
  const conceptos = CATALOG[cuenta]?.[subcuenta]?.[categoria] || [];
  if (conceptos.length) renderConceptos(conceptos, i);
}

function selectComprador(el, i) {
  el.closest(".cuenta-grid").querySelectorAll(".cuenta-card").forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  const val = el.dataset.value;
  document.getElementById(`comprador-${i}`).value = val;
  document.getElementById(`comprador-otro-${i}`).classList.toggle("hidden", val !== "Otro");
}

// ─── Buscador ──────────────────────────────────────────────────────────────

function onClassifySearch(i, q) {
  const resEl = document.getElementById(`search-results-${i}`);
  if (!q.trim()) { resEl.classList.add("hidden"); return; }

  const lower   = q.toLowerCase();
  const matches = SEARCH_INDEX.filter(e =>
    [e.cuenta, e.subcuenta, e.categoria, e.concepto].some(f => f.toLowerCase().includes(lower))
  ).slice(0, 12);

  searchMatches[i] = matches;

  if (!matches.length) {
    resEl.innerHTML = `<div class="search-no-results">Sin resultados para "${esc(q)}"</div>`;
    resEl.classList.remove("hidden");
    return;
  }

  resEl.innerHTML = matches.map((m, idx) => {
    const parts = [m.cuenta, m.subcuenta, m.categoria, m.concepto].filter(Boolean);
    const html  = parts.map(p => `<span>${esc(p)}</span>`).join(`<span class="search-sep"> › </span>`);
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

  // Seleccionar tarjeta de Cuenta
  const cuentaCard = Array.from(
    document.getElementById(`cuenta-grid-${i}`).querySelectorAll(".cuenta-card")
  ).find(c => c.dataset.value === m.cuenta);
  if (cuentaCard) selectCuenta(cuentaCard, i);

  // Seleccionar tarjeta de Subcuenta (ya renderizada por selectCuenta)
  if (m.subcuenta) {
    const subCard = Array.from(
      document.getElementById(`subcuenta-grid-${i}`).querySelectorAll(".cuenta-card")
    ).find(c => c.dataset.value === m.subcuenta);
    if (subCard) selectSubcuenta(subCard, i);
  }

  // Seleccionar tarjeta de Categoría (ya renderizada por selectSubcuenta)
  if (m.categoria) {
    const catCard = Array.from(
      document.getElementById(`categoria-grid-${i}`).querySelectorAll(".cuenta-card")
    ).find(c => c.dataset.value === m.categoria);
    if (catCard) selectCategoria(catCard, i);
  }

  // Seleccionar tarjeta de Concepto (ya renderizada por selectCategoria / selectSubcuenta)
  if (m.concepto) {
    const conCard = Array.from(
      document.getElementById(`concepto-grid-${i}`).querySelectorAll(".cuenta-card")
    ).find(c => c.dataset.value === m.concepto);
    if (conCard) selectConcepto(conCard, i);
  }

  // Limpiar buscador
  document.getElementById(`search-${i}`).value = "";
  hideSearchResults(i);
}

// ─── Get classification values ──────────────────────────────────────────────

function getClassify(i) {
  const compradorVal  = document.getElementById(`comprador-${i}`)?.value || "";
  const compradorOtro = document.getElementById(`comprador-otro-text-${i}`)?.value?.trim() || "";
  return {
    cuenta:       document.getElementById(`cuenta-${i}`)?.value       || "",
    subcuenta:    document.getElementById(`subcuenta-${i}`)?.value    || "",
    categoria:    document.getElementById(`categoria-${i}`)?.value    || "",
    concepto:     document.getElementById(`concepto-${i}`)?.value     || "",
    propiedad:    document.getElementById(`propiedad-${i}`)?.value    || "",
    departamento: document.getElementById(`departamento-${i}`)?.value || "",
    comprador:    compradorVal === "Otro" ? (compradorOtro || "Otro") : compradorVal,
    comentarios:  document.getElementById(`comentarios-${i}`)?.value?.trim() || "",
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
    form.append("propiedad",    c.propiedad);
    form.append("departamento", c.departamento);
    form.append("comprador",    c.comprador);
    form.append("comentarios",  c.comentarios);

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
    form.append("propiedad",    c.propiedad);
    form.append("departamento", c.departamento);
    form.append("comprador",    c.comprador);
    form.append("comentarios",  c.comentarios);

    const res  = await fetch(`${BACKEND}/process-json`, { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "No se pudo guardar.");

    markAsClassified(i);
    setStatus(`status-${i}`, "Guardado correctamente.");
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
