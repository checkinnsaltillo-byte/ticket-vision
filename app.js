const BACKEND = "https://ticket-vision-957627511957.northamerica-south1.run.app";

// ─── Catálogo de clasificaciones ───────────────────────────────────────────
// CATALOG[cuenta][subcuenta] = Object{categoria:[conceptos]} | Array[conceptos]

let CATALOG = {
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

let SEARCH_INDEX = buildSearchIndex();
let searchMatches = {};

// ─── State ─────────────────────────────────────────────────────────────────

let selectedFiles     = [];
let ticketResults     = [];
let dashboardTickets  = [];   // todos los tickets cargados desde Sheets
let dashboardFiltered = [];   // subset filtrado
let dbFiltersOpen     = true;
let dbPageSize        = 50;   // registros por página (25 | 50 | 100)
let dbCurrentPage     = 1;    // página actual
const DB_IDX          = 20000; // offset de índice para paneles de clasificar del dashboard
let classifyAutoPopulating = false; // suprime markClassifyDirty durante auto-relleno
let currentUser       = "";   // usuario activo (acl | ccl | admin)

// ─── Contraseñas válidas ────────────────────────────────────────────────────
const VALID_PASSWORDS = { acl: "acl", ccl: "ccl", admin: "admin" };
let lightboxBlobUrl  = null;
let lightboxZoomed   = false;
const LB_ZOOM        = 2.4;
let lbPanX = 0, lbPanY = 0;
let lbDragging = false, lbHasDragged = false, lbLx = 0, lbLy = 0;
let fileHashes    = [];   // SHA-256 por índice de selectedFiles
let ticketsIndex  = null; // null = no cargado; [] = cargado (vacío o con datos)
const pdfThumbCache = new Map(); // File → blob URL (página 1 rasterizada)

// ─── PDF helpers ───────────────────────────────────────────────────────────

function isPdf(file) {
  return !!(file && (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")));
}

/** Renderiza una sola página de un PDF a Blob JPEG */
async function renderPdfPageToBlob(file, pageNum = 1, scale = 1.5) {
  const data  = await file.arrayBuffer();
  const pdf   = await pdfjsLib.getDocument({ data }).promise;
  const page  = await pdf.getPage(Math.min(pageNum, pdf.numPages));
  const vp    = page.getViewport({ scale });
  const cvs   = document.createElement("canvas");
  cvs.width   = vp.width;
  cvs.height  = vp.height;
  await page.render({ canvasContext: cvs.getContext("2d"), viewport: vp }).promise;
  return new Promise(res => cvs.toBlob(res, "image/jpeg", 0.92));
}

/** Renderiza todas las páginas de un PDF en un único canvas vertical → Blob JPEG */
async function renderPdfAllPagesToBlob(file, scale = 2.0) {
  const data  = await file.arrayBuffer();
  const pdf   = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const vp   = page.getViewport({ scale });
    const cvs  = document.createElement("canvas");
    cvs.width  = vp.width; cvs.height = vp.height;
    await page.render({ canvasContext: cvs.getContext("2d"), viewport: vp }).promise;
    pages.push(cvs);
  }
  if (pages.length === 1) return new Promise(res => pages[0].toBlob(res, "image/jpeg", 0.92));
  const gap    = 18;
  const maxW   = Math.max(...pages.map(c => c.width));
  const totalH = pages.reduce((h, c, i) => h + c.height + (i > 0 ? gap : 0), 0);
  const out    = document.createElement("canvas");
  out.width    = maxW; out.height = totalH;
  const ctx    = out.getContext("2d");
  ctx.fillStyle = "#d1d5db"; ctx.fillRect(0, 0, maxW, totalH);
  let y = 0;
  for (const c of pages) {
    ctx.drawImage(c, Math.floor((maxW - c.width) / 2), y);
    y += c.height + gap;
  }
  return new Promise(res => out.toBlob(res, "image/jpeg", 0.92));
}

/** Thumbnail de página 1 con caché por File object */
async function getPdfThumbUrl(file) {
  if (pdfThumbCache.has(file)) return pdfThumbCache.get(file);
  const blob = await renderPdfPageToBlob(file, 1, 0.6);
  const url  = URL.createObjectURL(blob);
  pdfThumbCache.set(file, url);
  return url;
}

/** Abre el lightbox con todas las páginas del PDF renderizadas */
async function openPdfLightbox(file) {
  showLoading("Cargando PDF…", "");
  try {
    const blob = await renderPdfAllPagesToBlob(file);
    hideLoading();
    openImageLightbox(URL.createObjectURL(blob), true);
  } catch { hideLoading(); }
}

// ─── Detección de duplicados ────────────────────────────────────────────────

async function sha256(file) {
  const buf  = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function ensureTicketsIndex() {
  if (ticketsIndex !== null) return ticketsIndex;
  try {
    const res  = await fetch(`${BACKEND}/tickets-index`);
    const data = await res.json();
    ticketsIndex = data.ok ? (data.tickets || []) : [];
  } catch (_) {
    ticketsIndex = [];
  }
  return ticketsIndex;
}

function dupByHash(hash) {
  if (!hash || !ticketsIndex?.length) return null;
  return ticketsIndex.find(t => t.archivo_hash && t.archivo_hash === hash) || null;
}

function dupByFields(resumen) {
  if (!ticketsIndex?.length) return null;
  const tienda = (resumen.tienda || "").toLowerCase().trim();
  const fecha  =  resumen.fecha  || "";
  const total  = Math.round(Number(resumen.total  || 0) * 100);
  const folio  = (resumen.folio  || "").trim();
  return ticketsIndex.find(t => {
    const tTotal  = Math.round(Number(t.total  || 0) * 100);
    const tFolio  = (t.folio  || "").trim();
    const tFecha  =  t.fecha  || "";
    const tTienda = (t.tienda || "").toLowerCase().trim();
    if (folio && tFolio && folio === tFolio && fecha === tFecha) return true;
    if (fecha && fecha === tFecha && total > 0 && total === tTotal && tienda && tTienda)
      return tienda === tTienda || tienda.includes(tTienda) || tTienda.includes(tienda);
    return false;
  }) || null;
}

// Computa hashes desde startIdx y re-renderiza el strip cuando termina
async function computeHashes(startIdx) {
  await ensureTicketsIndex();
  for (let i = startIdx; i < selectedFiles.length; i++) {
    if (!fileHashes[i]) fileHashes[i] = await sha256(selectedFiles[i]);
  }
  renderImageStrip();
}

// ─── Init ──────────────────────────────────────────────────────────────────

// ─── Login ─────────────────────────────────────────────────────────────────

function tryLogin() {
  const pw  = (document.getElementById("loginPassword")?.value || "").trim();
  const err = document.getElementById("loginError");
  const user = VALID_PASSWORDS[pw];
  if (!user) {
    if (err) { err.textContent = "Contraseña incorrecta."; err.classList.remove("hidden"); }
    return;
  }
  currentUser = user;
  document.getElementById("loginOverlay")?.classList.add("hidden");
  document.getElementById("app-root")?.classList.remove("hidden");
  document.getElementById("current-user-badge").textContent = currentUser.toUpperCase();
  // Módulo predeterminado: Registros contables
  switchModule("registros");
}

function handleLoginKey(e) {
  if (e.key === "Enter") tryLogin();
}

window.addEventListener("DOMContentLoaded", () => {
  // ── LOGIN — cambiar DEV_MODE a false para reactivar contraseña ──────────
  const DEV_MODE = true;
  if (DEV_MODE) {
    currentUser = "admin";
    document.getElementById("loginOverlay")?.classList.add("hidden");
    document.getElementById("app-root")?.classList.remove("hidden");
    document.getElementById("current-user-badge").textContent = "ADMIN (dev)";
  } else {
    document.getElementById("loginOverlay")?.classList.remove("hidden");
    document.getElementById("app-root")?.classList.add("hidden");
    document.getElementById("loginPassword")?.focus();
  }

  // Configurar PDF.js worker
  if (typeof pdfjsLib !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  ensureTicketsIndex();

  // ── Cerrar lightbox con Escape ─────────────────────────────────────────
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !document.getElementById("imageLightbox").classList.contains("hidden")) {
      closeLightbox();
    }
  });

  // ── Drag/pan en el lightbox ────────────────────────────────────────────
  const lbImg = document.getElementById("lightboxImg");

  // Desktop — mouse
  lbImg.addEventListener("mousedown", e => {
    if (!lightboxZoomed) return;
    e.preventDefault();
    lbDragging = true; lbHasDragged = false;
    lbLx = e.clientX; lbLy = e.clientY;
    lbImg.style.cursor = "grabbing"; lbImg.style.transition = "none";
  });
  document.addEventListener("mousemove", e => {
    if (!lbDragging) return;
    const dx = e.clientX - lbLx, dy = e.clientY - lbLy;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) lbHasDragged = true;
    lbPanX += dx; lbPanY += dy;
    lbLx = e.clientX; lbLy = e.clientY;
    lbImg.style.transform = `translate(${lbPanX}px,${lbPanY}px) scale(${LB_ZOOM})`;
  });
  document.addEventListener("mouseup", () => {
    if (!lbDragging) return;
    lbDragging = false;
    if (lightboxZoomed) { lbImg.style.cursor = "grab"; lbImg.style.transition = "transform .22s ease"; }
  });

  // Móvil — touch (un dedo para arrastrar, toque corto para zoom)
  let ltx = 0, lty = 0;
  lbImg.addEventListener("touchstart", e => {
    if (!lightboxZoomed || e.touches.length !== 1) return;
    ltx = e.touches[0].clientX; lty = e.touches[0].clientY;
    lbHasDragged = false;
  }, { passive: true });
  lbImg.addEventListener("touchmove", e => {
    if (!lightboxZoomed || e.touches.length !== 1) return;
    e.preventDefault();
    const dx = e.touches[0].clientX - ltx, dy = e.touches[0].clientY - lty;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) lbHasDragged = true;
    lbPanX += dx; lbPanY += dy;
    ltx = e.touches[0].clientX; lty = e.touches[0].clientY;
    lbImg.style.transform = `translate(${lbPanX}px,${lbPanY}px) scale(${LB_ZOOM})`;
  }, { passive: false });

  ["files-camera","files-gallery","files-files",
   "sheet-camera","sheet-gallery","sheet-files"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", handleFilesAdded);
  });
  // Actualizar hint según dispositivo
  if (!isMobile()) {
    const hint = document.getElementById("uploadHint");
    if (hint) hint.textContent = "Haz clic para seleccionar imágenes";
  }
});

function isMobile() {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

function openUploadSheet() {
  if (isMobile()) {
    document.getElementById("uploadSheetOverlay").classList.remove("hidden");
    requestAnimationFrame(() => document.getElementById("uploadSheet").classList.add("open"));
  } else {
    // Desktop: abrir selector de archivos directamente
    document.getElementById("files-files").click();
  }
}
function closeUploadSheet() {
  document.getElementById("uploadSheet").classList.remove("open");
  setTimeout(() => document.getElementById("uploadSheetOverlay").classList.add("hidden"), 280);
}

// ─── Accordion panels ──────────────────────────────────────────────────────

function openPanel(n) {
  document.getElementById(`panel-body-${n}`).classList.remove("collapsed");
  document.getElementById(`panel-arrow-${n}`).classList.add("open");
}
function closePanel(n) {
  document.getElementById(`panel-body-${n}`).classList.add("collapsed");
  document.getElementById(`panel-arrow-${n}`).classList.remove("open");
}
function togglePanel(n) {
  const body = document.getElementById(`panel-body-${n}`);
  if (body.classList.contains("collapsed")) openPanel(n); else closePanel(n);
}

// ─── File management ───────────────────────────────────────────────────────

function handleFilesAdded(e) {
  addFiles(Array.from(e.target.files));
  e.target.value = "";
}

function addFiles(newFiles) {
  if (!newFiles.length) return;
  const startIdx = selectedFiles.length;
  selectedFiles  = [...selectedFiles, ...newFiles];
  renderImageStrip();
  document.getElementById("analyzeWrap").classList.remove("hidden");
  setStep(1);
  computeHashes(startIdx); // detectar duplicados por hash en segundo plano
}

function removeFile(idx) {
  selectedFiles.splice(idx, 1);
  if (!selectedFiles.length) {
    document.getElementById("analyzeWrap").classList.add("hidden");
    document.getElementById("limpiarWrap").classList.add("hidden");
  }
  renderImageStrip();
}

function limpiarTickets() {
  ticketResults.forEach(t => { if (t.imageUrl) URL.revokeObjectURL(t.imageUrl); });
  pdfThumbCache.forEach(url => URL.revokeObjectURL(url));
  pdfThumbCache.clear();
  selectedFiles = [];
  ticketResults = [];
  fileHashes    = [];
  const strip = document.getElementById("imagePreview");
  strip.innerHTML = "";
  strip.classList.add("hidden");
  document.getElementById("analyzeWrap").classList.add("hidden");
  document.getElementById("limpiarWrap").classList.add("hidden");
  document.getElementById("analyzeStatus").textContent = "";
  document.getElementById("ticketsContainer").innerHTML = "";
  document.getElementById("panel-3").classList.add("hidden");
  const sub = document.getElementById("panel-2-subtitle");
  if (sub) sub.textContent = "Sin tickets analizados";
  openPanel(1);
  closePanel(2);
}

function renderImageStrip() {
  const strip = document.getElementById("imagePreview");
  if (!selectedFiles.length) { strip.classList.add("hidden"); return; }
  strip.classList.remove("hidden");
  document.getElementById("limpiarWrap").classList.remove("hidden");
  strip.innerHTML = "";

  selectedFiles.forEach((file, i) => {
    const dup   = fileHashes[i] ? dupByHash(fileHashes[i]) : null;
    const thumb = document.createElement("div");
    thumb.className = "image-thumb" + (dup ? " thumb-has-dup" : "");

    const img = document.createElement("img");
    if (isPdf(file)) {
      img.src   = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect width='80' height='80' rx='8' fill='%23fee2e2'/%3E%3Ctext x='40' y='42' text-anchor='middle' font-size='28' font-family='sans-serif'%3E%F0%9F%93%84%3C/text%3E%3C/svg%3E";
      img.style.objectFit = "contain"; img.style.background = "#fee2e2";
      getPdfThumbUrl(file).then(url => { img.src = url; img.style.objectFit = ""; img.style.background = ""; });
      img.onclick = (e) => { e.stopPropagation(); openPdfLightbox(selectedFiles[i]); };
    } else {
      const previewUrl = URL.createObjectURL(file);
      img.src = previewUrl;
      img.onload = () => URL.revokeObjectURL(img.src);
      img.onclick = (e) => {
        e.stopPropagation();
        const url = URL.createObjectURL(selectedFiles[i]);
        openImageLightbox(url, true);
      };
    }

    const lbl = document.createElement("div");
    lbl.className   = "thumb-label";
    lbl.textContent = String(i + 1);

    const btn = document.createElement("button");
    btn.className   = "thumb-remove";
    btn.textContent = "×";
    btn.onclick     = (e) => { e.stopPropagation(); removeFile(i); };

    thumb.append(img, lbl, btn);

    if (dup) {
      const badge = document.createElement("div");
      badge.className = "thumb-dup-badge";
      badge.title     = `Ya existe: ${dup.tienda || ""}${dup.fecha ? " · " + dup.fecha : ""}`;
      badge.textContent = "⚠️";
      thumb.appendChild(badge);
    }

    strip.appendChild(thumb);
  });

  // Botón "+" para agregar más imágenes (abre el sheet)
  const addBtn = document.createElement("button");
  addBtn.className = "image-thumb thumb-add";
  addBtn.type      = "button";
  addBtn.innerHTML = `<span class="thumb-add-icon">＋</span>`;
  addBtn.onclick   = openUploadSheet;
  strip.appendChild(addBtn);
}

// ─── Loading ───────────────────────────────────────────────────────────────

function showLoading(title = "Analizando...", sub = "Extrayendo productos y datos") {
  document.getElementById("loadingTitle").textContent    = title;
  document.getElementById("loadingSubtitle").textContent = sub;
  document.getElementById("loadingOverlay").classList.remove("hidden");
}
function hideLoading() {
  document.getElementById("loadingOverlay").classList.add("hidden");
}

// ─── Step indicator ────────────────────────────────────────────────────────

function setStep(n) {
  if (n === 2) {
    closePanel(1);
    openPanel(2);
    const count = ticketResults.length;
    const sub = document.getElementById("panel-2-subtitle");
    if (sub) sub.textContent = `${count} ticket${count !== 1 ? "s" : ""} analizados`;
  } else {
    openPanel(1);
  }
}

// ─── Analyze ───────────────────────────────────────────────────────────────

async function analyzeTickets() {
  if (!selectedFiles.length) return;
  try {
    setStatus("analyzeStatus", "");
    await ensureTicketsIndex();

    // ── Separar: analizar vs omitir (duplicado por hash) ──────────────────
    const toAnalyze = [];
    const toSkip    = [];
    selectedFiles.forEach((file, i) => {
      const hash = fileHashes[i] || "";
      const dup  = dupByHash(hash);
      if (dup) toSkip.push({ file, fileHash: hash, imageUrl: URL.createObjectURL(file), duplicate: dup });
      else     toAnalyze.push({ file, fileHash: hash, originalIndex: i });
    });

    let analyzedResults = [];

    if (toAnalyze.length) {
      showLoading("Analizando…", `Procesando ${toAnalyze.length} ticket${toAnalyze.length > 1 ? "s" : ""}…`);
      const form = new FormData();
      toAnalyze.forEach(item => form.append("files", item.file));

      const res  = await fetch(`${BACKEND}/process-json`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "No se pudo procesar.");

      analyzedResults = (data.resumen || []).map((r, i) => {
        const item = toAnalyze[i];
        const hash = item?.fileHash || "";
        return {
          file:      item?.file,
          fileHash:  hash,
          imageUrl:  item?.file ? URL.createObjectURL(item.file) : null,
          resumen:   r,
          productos: (data.productos      || []).filter(p => p.ticket_id === r.ticket_id),
          cruce:     (data.cruce_bancario || [])[i] || {},
          duplicate: dupByHash(hash) || dupByFields(r),
          skipped:   false,
        };
      });
    }

    // ── Resultados omitidos (sin tokens) ───────────────────────────────────
    const skippedResults = toSkip.map(item => ({
      file:      item.file,
      fileHash:  item.fileHash,
      imageUrl:  item.imageUrl,
      resumen:   null,
      productos: [],
      cruce:     {},
      duplicate: item.duplicate,
      skipped:   true,
    }));

    // ── Rasterizar thumbnails de PDFs (imageUrl debe ser imagen, no PDF blob) ─
    for (const result of [...analyzedResults, ...skippedResults]) {
      if (result.file && isPdf(result.file)) {
        if (result.imageUrl) URL.revokeObjectURL(result.imageUrl);
        const blob = await renderPdfPageToBlob(result.file, 1, 1.5);
        result.imageUrl = URL.createObjectURL(blob);
      }
    }

    ticketResults = [...analyzedResults, ...skippedResults];

    renderTicketCards();
    setStep(2);

    // Subtítulo con desglose
    const nA = analyzedResults.length;
    const nS = skippedResults.length;
    const sub = document.getElementById("panel-2-subtitle");
    if (sub) sub.textContent =
      (nA ? `${nA} analizado${nA !== 1 ? "s" : ""}` : "") +
      (nA && nS ? " · " : "") +
      (nS ? `${nS} omitido${nS !== 1 ? "s" : ""} (duplicado${nS !== 1 ? "s" : ""})` : "");

    setStatus("analyzeStatus", "");
    setTimeout(() => document.getElementById("panel-2").scrollIntoView({ behavior: "smooth" }), 200);
  } catch (err) {
    setStatus("analyzeStatus", "Error: " + err.message);
  } finally {
    hideLoading();
  }
}

// ─── Render ticket cards ────────────────────────────────────────────────────

// Mapeo de método detectado por Claude → valor en los recuadros de Clasificar
const METODO_A_CLASIF = {
  VISA:            "Tarjeta crédito",
  MASTERCARD:      "Tarjeta crédito",
  AMEX:            "Tarjeta crédito",
  TARJETA_CREDITO: "Tarjeta crédito",
  TARJETA_BANCO:   "Tarjeta crédito",
  TARJETA_DEBITO:  "Tarjeta débito",
  EFECTIVO:        "Efectivo",
  TRANSFERENCIA:   "Transferencia",
  QR:              "Transferencia",
};

function autoSelectMetodoPago(i, rawMethod) {
  if (!rawMethod) return;
  const key      = normalizePaymentKey(rawMethod);
  const clasifVal = METODO_A_CLASIF[key];
  if (!clasifVal) return;
  const grid = document.getElementById(`metodo-grid-${i}`);
  if (!grid) return;
  const card = Array.from(grid.querySelectorAll(".cuenta-card"))
    .find(c => c.dataset.value === clasifVal);
  if (!card) return;
  grid.querySelectorAll(".cuenta-card").forEach(c => c.classList.remove("active"));
  card.classList.add("active");
  document.getElementById(`metodo-clasif-${i}`).value = clasifVal;
}

function renderTicketCards() {
  const container = document.getElementById("ticketsContainer");
  container.innerHTML = ticketResults.map((t, i) => createTicketCard(t, i)).join("");
  const hasReal = ticketResults.some(t => !t.skipped);
  document.getElementById("panel-3").classList.toggle("hidden", !hasReal);
  // Auto-seleccionar método de pago y deducible detectados
  ticketResults.forEach((t, i) => {
    if (!t.skipped) {
      if (t.resumen?.metodo_pago) autoSelectMetodoPago(i, t.resumen.metodo_pago);
      autoSelectDeducible(i, t.productos);
    }
  });
}

/** Auto-selecciona el toggle Deducible según deducible_sugerido de los productos */
function autoSelectDeducible(i, productos) {
  if (!productos?.length) return;
  const siCount = productos.filter(p => p.deducible_sugerido === "Sí").length;
  // Marcar deducible si la mayoría de productos lo sugiere
  if (siCount === 0 || siCount < Math.ceil(productos.length / 2)) return;
  const inner  = document.getElementById(`deducible-${i}`);
  if (inner && !inner.checked) { inner.checked = true; updateDeducibleLabel(i, true); }
}

/** Actualiza el texto de ruta de clasificación debajo del buscador */
function updateClasiPath(i) {
  const el = document.getElementById(`clasif-path-${i}`);
  if (!el) return;
  const cuenta    = document.getElementById(`cuenta-${i}`)?.value    || "";
  const subcuenta = document.getElementById(`subcuenta-${i}`)?.value || "";
  const categoria = document.getElementById(`categoria-${i}`)?.value || "";
  const concepto  = document.getElementById(`concepto-${i}`)?.value  || "";
  const parts = [cuenta, subcuenta, categoria, concepto].filter(Boolean);
  if (!parts.length) { el.textContent = ""; return; }
  const emoji = CUENTA_EMOJIS[cuenta] || "";
  el.textContent = (emoji ? emoji + " " : "") + parts.join(" › ");
}

/** Despliega / contrae la sección Cuenta→Concepto */
function toggleClasiDetail(i) {
  const section = document.getElementById(`cuenta-section-${i}`);
  const btn     = document.getElementById(`clasif-toggle-${i}`);
  if (!section) return;
  const isHidden = section.classList.toggle("hidden");
  if (btn) btn.classList.toggle("active", !isHidden);
}

function removeTicket(i) {
  if (ticketResults[i]?.imageUrl) URL.revokeObjectURL(ticketResults[i].imageUrl);
  ticketResults.splice(i, 1);
  renderTicketCards();
  // Actualizar subtítulo
  const nA = ticketResults.filter(t => !t.skipped).length;
  const nS = ticketResults.filter(t =>  t.skipped).length;
  const sub = document.getElementById("panel-2-subtitle");
  if (sub) {
    if (!ticketResults.length) { sub.textContent = "Sin tickets analizados"; return; }
    sub.textContent =
      (nA ? `${nA} analizado${nA !== 1 ? "s" : ""}` : "") +
      (nA && nS ? " · " : "") +
      (nS ? `${nS} omitido${nS !== 1 ? "s" : ""}` : "");
  }
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
  // ── Tarjeta simplificada para duplicados omitidos ──────────────────────
  if (ticket.skipped) {
    const dup = ticket.duplicate || {};
    const info = [dup.tienda, dup.fecha, dup.total ? "$" + Number(dup.total).toLocaleString("es-MX") : ""].filter(Boolean).join(" · ");
    return `
      <div class="ticket-card ticket-card--skipped" id="ticket-${i}">
        <div class="ticket-card-header" style="cursor:default">
          <button class="btn-x" title="Eliminar" onclick="removeTicket(${i})">×</button>
          ${ticket.imageUrl ? `<img class="skipped-thumb" src="${esc(ticket.imageUrl)}"
              onclick="openTicketImageLightbox(${i})" alt="Ticket ${i+1}">` : ""}
          <div class="ticket-info" style="flex:1">
            <div class="dup-banner" style="margin:0">
              ⚠️ Omitido — ya existe en Sheets · <strong>${esc(dup.tienda || "")}</strong>${dup.fecha ? " · " + esc(dup.fecha) : ""}${dup.total ? " · $" + Number(dup.total).toLocaleString("es-MX") : ""}
            </div>
          </div>
        </div>
      </div>`;
  }

  const r = ticket.resumen;
  const metaParts = [r.fecha || "", r.hora || ""].filter(Boolean);

  const rawSummary = (ticket.productos || [])
    .map(p => p.descripcion || "").filter(Boolean).join(", ");
  const productSummary = rawSummary.length > 95 ? rawSummary.slice(0, 92) + "…" : rawSummary;

  const deptOptions = Array.from({length: 14}, (_, j) => `<option>${j + 1}</option>`).join("");

  return `
    <div class="ticket-card" id="ticket-${i}">
      <div class="ticket-card-header" onclick="toggleTable(${i})" id="header-${i}">
        <button class="btn-x" title="Eliminar" onclick="event.stopPropagation(); removeTicket(${i})">×</button>
        <div class="ticket-info">
          <div class="header-chips">
            <span class="info-chip hidden" id="cuenta-chip-${i}"></span>
            <span class="info-chip hidden" id="encargado-chip-${i}"></span>
            <span class="info-chip hidden" id="propiedad-chip-${i}"></span>
            <span class="info-chip hidden" id="dept-chip-${i}"></span>
            <span class="info-chip chip-reembolso hidden" id="reembolso-chip-${i}"></span>
          </div>
          <div class="ticket-store-row">
            <span class="ticket-store">${esc(r.tienda || "Ticket " + (i + 1))}</span>
            ${ticket.imageUrl ? `<button class="btn-ver-ticket" onclick="event.stopPropagation(); openTicketImageLightbox(${i})">Ver ticket</button>` : ""}
          </div>
          <div class="ticket-meta" id="ticket-meta-${i}">
            ${esc(metaParts.join(" · "))}${metaParts.length ? " · " : ""}🧾 ${r.num_productos || 0} producto${(r.num_productos || 0) !== 1 ? "s" : ""}
          </div>
          ${productSummary ? `<div class="product-summary">${esc(productSummary)}</div>` : ""}
        </div>
        <div class="ticket-header-right">
          <span id="payment-chip-${i}">${paymentChip(r.metodo_pago, r.tarjeta_ultimos4)}</span>
          <div class="ticket-total-badge" id="total-badge-${i}">
            <span class="total-main">${money(r.total)}</span>
            ${r.iva ? `<span class="total-iva">IVA ${money(r.iva)}</span>` : ""}
          </div>
          <div class="header-deducible" onclick="event.stopPropagation()">
            <label class="toggle-switch toggle-switch--dark">
              <input type="checkbox" id="deducible-header-${i}"
                     onchange="syncDeducible(${i}, this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <span class="fhl" id="fhl-${i}">No deducible</span>
          </div>
        </div>
      </div>

      ${ticket.duplicate ? `<div class="dup-banner">
        ⚠️ Posible duplicado — <strong>${esc(ticket.duplicate.tienda || "")}</strong>${ticket.duplicate.fecha ? " · " + esc(ticket.duplicate.fecha) : ""}${ticket.duplicate.total ? " · $" + Number(ticket.duplicate.total).toLocaleString("es-MX") : ""}
      </div>` : ""}

      <div class="ticket-table-wrap hidden" id="table-${i}" data-tidx="${i}" data-tmod="analysis">
        <div class="ticket-tabs">
          <button class="ticket-tab active" onclick="showTicketTab(${i},'transcripcion',this)">Transcripción</button>
          <button class="ticket-tab" onclick="showTicketTab(${i},'resumen',this)">Resumen</button>
          <button class="ticket-tab" onclick="showTicketTab(${i},'cruce',this)">Cruce bancario</button>
        </div>
        <div id="tab-transcripcion-${i}" class="ticket-tab-content">
          ${buildProductTable(ticket.productos)}
          <button class="btn-add-row" onclick="addAnalysisProductRow(${i})">＋ Agregar producto</button>
        </div>
        <div id="tab-resumen-${i}" class="ticket-tab-content hidden">${buildResumenTable(ticket.resumen)}</div>
        <div id="tab-cruce-${i}" class="ticket-tab-content hidden">${buildCruceTable(ticket.cruce)}</div>
        <div class="table-actions-bar hidden" id="tact-analysis-${i}">
          <button class="btn-clasificar-ticket" style="padding:10px 28px;font-size:13px" onclick="saveTableChanges(${i})">💾 Guardar cambios</button>
          <button class="btn-limpiar-ticket" onclick="resetTableChanges(${i})">Limpiar</button>
        </div>
      </div>

      <div class="classify-tab" id="btn-classify-${i}" onclick="toggleClassify(${i})">
        <span class="classify-tab-arrow">›</span>
        <span class="classify-tab-label">Clasificar</span>
      </div>

      ${buildClassifyPanel(i, r.fecha, deptOptions, "✓ Clasificar", `clasificarTicket(${i})`, `limpiarClasificacion(${i})`)}
    </div>
  `;
}


// ─── Panel de clasificación reutilizable ───────────────────────────────────

function buildClassifyPanel(idx, fecha, deptOpts, saveLabel, saveOnclick, limpiarOnclick, fechaLabel) {
  return `
    <div class="classify-panel hidden" id="classify-${idx}">

      <div class="clasif-fecha-row">
        <label class="clasif-fecha-label">📅 ${fechaLabel || 'Fecha del ticket'}</label>
        <input type="date" id="fecha-clasif-${idx}" class="clasif-fecha-input"
          value="${esc(fecha || '')}" onchange="markClassifyDirty('${idx}')">
      </div>

      <div class="classify-search-wrap">
        <button class="btn-clasif-toggle" type="button"
                onclick="toggleClasiDetail('${idx}')"
                id="clasif-toggle-${idx}"
                title="Cuenta / Subcuenta / Categoría / Concepto">≡</button>
        <input type="text" id="search-${idx}" class="classify-search"
               placeholder="🔍 Buscar por cuenta, subcuenta, categoría o concepto..."
               oninput="onClassifySearch('${idx}', this.value)"
               onblur="setTimeout(()=>hideSearchResults('${idx}'), 180)">
        <div class="search-results hidden" id="search-results-${idx}"></div>
      </div>
      <div class="clasif-path-text" id="clasif-path-${idx}"></div>

      <div class="clasif-cuenta-section hidden" id="cuenta-section-${idx}">
        <div class="cuenta-field">
          <label>Cuenta</label>
          <div class="cuenta-grid" id="cuenta-grid-${idx}">
            <div class="cuenta-card active" data-value="" onclick="selectCuenta(this,'${idx}')">
              <div class="cuenta-icon">🏠</div><div class="cuenta-label">Sin cuenta</div><div class="cuenta-sub">General</div>
            </div>
            <div class="cuenta-card" data-value="Egresos" onclick="selectCuenta(this,'${idx}')">
              <div class="cuenta-icon">💸</div><div class="cuenta-label">Egresos</div><div class="cuenta-sub">Gastos y pagos</div>
            </div>
            <div class="cuenta-card" data-value="Ingresos" onclick="selectCuenta(this,'${idx}')">
              <div class="cuenta-icon">💰</div><div class="cuenta-label">Ingresos</div><div class="cuenta-sub">Cobros y entradas</div>
            </div>
            <div class="cuenta-card" data-value="Pasivos" onclick="selectCuenta(this,'${idx}')">
              <div class="cuenta-icon">📋</div><div class="cuenta-label">Pasivos</div><div class="cuenta-sub">Obligaciones</div>
            </div>
            <div class="cuenta-card" data-value="Activos" onclick="selectCuenta(this,'${idx}')">
              <div class="cuenta-icon">📈</div><div class="cuenta-label">Activos</div><div class="cuenta-sub">Inversión / CAPEX</div>
            </div>
            <div class="cuenta-card" data-value="Capital" onclick="selectCuenta(this,'${idx}')">
              <div class="cuenta-icon">💼</div><div class="cuenta-label">Capital</div><div class="cuenta-sub">Utilidad / Familiar</div>
            </div>
          </div>
          <input type="hidden" id="cuenta-${idx}" value="">
        </div>
        <div class="cuenta-field hidden" id="subcuenta-field-${idx}">
          <label>Subcuenta</label>
          <div class="cuenta-grid cuenta-grid--sub" id="subcuenta-grid-${idx}"></div>
          <input type="hidden" id="subcuenta-${idx}" value="">
        </div>
        <div class="cuenta-field hidden" id="categoria-field-${idx}">
          <label>Categoría</label>
          <div class="cuenta-grid cuenta-grid--cat" id="categoria-grid-${idx}"></div>
          <input type="hidden" id="categoria-${idx}" value="">
        </div>
        <div class="cuenta-field hidden" id="concepto-field-${idx}">
          <label>Concepto</label>
          <div class="cuenta-grid" id="concepto-grid-${idx}"></div>
          <input type="hidden" id="concepto-${idx}" value="">
        </div>
      </div><!-- /clasif-cuenta-section -->

      <div class="grid">
        <div class="field">
          <label>Propiedad</label>
          <select id="propiedad-${idx}" onchange="togglePropiedadOtro('${idx}', this.value); markClassifyDirty('${idx}')">
            <option value="">— Seleccionar —</option>
            <option>Calle Cumbres</option><option>Calle Baja California</option>
            <option>Calle Oaxaca</option><option>Calle José Cárdenas</option>
            <option>Calle Matamoros</option><option value="Otro">Otro</option>
          </select>
          <div class="hidden" id="propiedad-otro-wrap-${idx}" style="margin-top:8px">
            <input type="text" id="propiedad-otro-${idx}" class="field-select"
                   placeholder="Especificar propiedad..." style="appearance:none" oninput="markClassifyDirty('${idx}')">
          </div>
        </div>
        <div class="field">
          <label># Departamento</label>
          <select id="departamento-${idx}" onchange="markClassifyDirty('${idx}')">
            <option value="">— Seleccionar —</option>${deptOpts}
          </select>
        </div>
      </div>

      <div class="cuenta-field">
        <label>Encargado de operación</label>
        <div class="cuenta-grid cuenta-grid--compact" id="comprador-grid-${idx}">
          <div class="cuenta-card" data-value="Andrés"   onclick="selectComprador(this,'${idx}')"><div class="cuenta-icon">👨</div><div class="cuenta-label">Andrés</div></div>
          <div class="cuenta-card" data-value="Claudia"  onclick="selectComprador(this,'${idx}')"><div class="cuenta-icon">👩</div><div class="cuenta-label">Claudia</div></div>
          <div class="cuenta-card" data-value="Papá"     onclick="selectComprador(this,'${idx}')"><div class="cuenta-icon">👨‍👧</div><div class="cuenta-label">Papá</div></div>
          <div class="cuenta-card" data-value="Francisco" onclick="selectComprador(this,'${idx}')"><div class="cuenta-icon">👨</div><div class="cuenta-label">Francisco</div></div>
          <div class="cuenta-card" data-value="Brenda"   onclick="selectComprador(this,'${idx}')"><div class="cuenta-icon">👩</div><div class="cuenta-label">Brenda</div></div>
          <div class="cuenta-card" data-value="Alma"     onclick="selectComprador(this,'${idx}')"><div class="cuenta-icon">👩</div><div class="cuenta-label">Alma</div></div>
          <div class="cuenta-card" data-value="Gaby"     onclick="selectComprador(this,'${idx}')"><div class="cuenta-icon">👩</div><div class="cuenta-label">Gaby</div></div>
          <div class="cuenta-card" data-value="Juanita"  onclick="selectComprador(this,'${idx}')"><div class="cuenta-icon">👩</div><div class="cuenta-label">Juanita</div></div>
          <div class="cuenta-card" data-value="Damariz"  onclick="selectComprador(this,'${idx}')"><div class="cuenta-icon">👩</div><div class="cuenta-label">Damariz</div></div>
        </div>
        <input type="hidden" id="comprador-${idx}" value="">
      </div>

      <div class="cuenta-field" id="deducible-field-${idx}">
        <label>Deducible</label>
        <div class="toggle-row">
          <label class="toggle-switch">
            <input type="checkbox" id="deducible-${idx}" onchange="updateDeducibleLabel('${idx}', this.checked); markClassifyDirty('${idx}')">
            <span class="toggle-slider"></span>
          </label>
          <span class="toggle-label-text" id="deducible-label-${idx}">No</span>
        </div>
      </div>

      <div class="cuenta-field">
        <label>Reembolso</label>
        <div class="toggle-row">
          <label class="toggle-switch">
            <input type="checkbox" id="reembolso-${idx}" onchange="toggleReembolso('${idx}', this.checked); markClassifyDirty('${idx}')">
            <span class="toggle-slider"></span>
          </label>
          <span class="toggle-label-text" id="reembolso-label-${idx}">No</span>
        </div>
        <div class="hidden" id="reembolso-a-field-${idx}" style="margin-top:10px">
          <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:6px">Reembolsar a:</label>
          <select id="reembolso-a-${idx}" class="field-select" onchange="toggleReembolsoOtro('${idx}', this.value); markClassifyDirty('${idx}')">
            <option value="">— Seleccionar —</option>
            <option>Andrés</option><option>Claudia</option><option>Papá</option>
            <option>Francisco</option><option>Brenda</option><option>Alma</option>
            <option>Gaby</option><option>Juanita</option><option>Damariz</option>
            <option value="Otro">Otro</option>
          </select>
          <div class="hidden" id="reembolso-otro-wrap-${idx}" style="margin-top:8px">
            <input type="text" id="reembolso-otro-${idx}" class="field-select"
                   placeholder="Especificar persona..." style="appearance:none" oninput="markClassifyDirty('${idx}')">
          </div>
          <div style="margin-top:12px">
            <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:6px">Detalles de la operación</label>
            <textarea id="detalles-${idx}" class="classify-textarea" rows="3"
                      placeholder="Descripción libre de la operación..." oninput="markClassifyDirty('${idx}')"></textarea>
          </div>
        </div>
      </div>

      <div class="cuenta-field">
        <label>Método de pago</label>
        <div class="cuenta-grid cuenta-grid--compact" id="metodo-grid-${idx}">
          <div class="cuenta-card" data-value="Tarjeta crédito"    onclick="selectMetodoPago(this,'${idx}')"><div class="cuenta-icon">💳</div><div class="cuenta-label">Crédito</div></div>
          <div class="cuenta-card" data-value="Tarjeta débito"     onclick="selectMetodoPago(this,'${idx}')"><div class="cuenta-icon">🏦</div><div class="cuenta-label">Débito</div></div>
          <div class="cuenta-card" data-value="Efectivo"           onclick="selectMetodoPago(this,'${idx}')"><div class="cuenta-icon">💵</div><div class="cuenta-label">Efectivo</div></div>
          <div class="cuenta-card" data-value="Transferencia"      onclick="selectMetodoPago(this,'${idx}')"><div class="cuenta-icon">🔄</div><div class="cuenta-label">Transferencia</div></div>
          <div class="cuenta-card" data-value="Retiro sin tarjeta" onclick="selectMetodoPago(this,'${idx}')"><div class="cuenta-icon">🏧</div><div class="cuenta-label">Retiro</div></div>
          <div class="cuenta-card" data-value="Cheque"             onclick="selectMetodoPago(this,'${idx}')"><div class="cuenta-icon">📝</div><div class="cuenta-label">Cheque</div></div>
        </div>
        <input type="hidden" id="metodo-clasif-${idx}" value="">
      </div>

      <div class="cuenta-field">
        <label>Comentarios</label>
        <textarea id="comentarios-${idx}" class="classify-textarea"
                  placeholder="Notas adicionales sobre este ticket..." oninput="markClassifyDirty('${idx}')"></textarea>
      </div>

      <div class="classify-actions hidden" id="classify-actions-${idx}">
        <button class="btn-clasificar-ticket" onclick="${saveOnclick}">${saveLabel}</button>
        <button class="btn-limpiar-ticket" onclick="${limpiarOnclick}">Limpiar</button>
      </div>
    </div>`;
}

// ─── Product table ─────────────────────────────────────────────────────────

function buildProductTable(productos) {
  if (!productos?.length) {
    return `<div class="empty-state"><div class="empty-icon">🧾</div><p>Sin productos detectados</p></div>`;
  }
  const cols = [
    { key: "linea_numero",            label: "#",         ro: true },
    { key: "descripcion",             label: "Descripción" },
    { key: "cantidad",                label: "Cant." },
    { key: "precio_unitario",         label: "P.Unit." },
    { key: "monto",                   label: "Monto" },
    { key: "categoria_operativa",     label: "Categoría" },
    { key: "deducible_sugerido",      label: "Deducible" },
    { key: "confianza_clasificacion", label: "Confianza" },
  ];
  return `<table>
    <thead><tr>${cols.map(c => `<th>${c.label}</th>`).join("")}<th></th></tr></thead>
    <tbody>${productos.map((r, rowIdx) =>
      `<tr data-row="${rowIdx}">${cols.map(c =>
        c.ro
          ? `<td>${esc(String(r[c.key] ?? ""))}</td>`
          : `<td contenteditable="true" spellcheck="false" data-field="${c.key}" oninput="onTableCellInput(this)">${esc(String(r[c.key] ?? ""))}</td>`
      ).join("")}<td class="btn-del-cell"><button class="btn-del-row" onclick="deleteProductRow(this)" title="Eliminar fila">✕</button></td></tr>`
    ).join("")}</tbody>
  </table>`;
}

// Campos manejados por el panel Clasificar — NO editables en tabla
const CLASIF_FIELDS = new Set(["fecha","metodo_pago","cuenta","subcuenta",
  "categoria_gasto","concepto","propiedad","departamento","fecha_captura","clasificado_por"]);

function buildResumenTable(r) {
  if (!r) return `<div class="empty-state"><p>Sin datos de resumen</p></div>`;
  const rows = [
    ["Tienda",            "tienda",            r.tienda],
    ["RFC",               "rfc",               r.rfc],
    ["Fecha",             "fecha",             r.fecha],
    ["Hora",              "hora",              formatHora(r.hora)],
    ["Folio",             "folio",             r.folio],
    ["Método de pago",    "metodo_pago",       r.metodo_pago],
    ["Últimos 4 dígitos", "tarjeta_ultimos4",  r.tarjeta_ultimos4],
    ["# Productos",       "num_productos",     r.num_productos],
    ["Subtotal",          "subtotal",          r.subtotal  || null],
    ["IVA",               "iva",               r.iva       || null],
    ["IEPS",              "ieps",              r.ieps      || null],
    ["Descuentos",        "descuentos",        r.descuentos|| null],
    ["Total",             "total",             r.total     || null],
    ["Cuenta",            "cuenta",            r.cuenta],
    ["Subcuenta",         "subcuenta",         r.subcuenta],
    ["Categoría",         "categoria_gasto",   r.categoria_gasto],
    ["Concepto",          "concepto",          r.concepto],
    ["Propiedad",         "propiedad",         r.propiedad],
    ["Departamento",      "departamento",      r.departamento],
    ["Clasificado por",   "clasificado_por",   r.clasificado_por],
    ["Fecha captura",     "fecha_captura",     r.fecha_captura],
  ].filter(([,, v]) => v !== "" && v != null);
  return `<table>
    <thead><tr><th>Campo</th><th>Valor</th></tr></thead>
    <tbody>${rows.map(([label, field, val]) => {
      const ro = CLASIF_FIELDS.has(field);
      const td = ro
        ? `<td>${esc(String(val))}</td>`
        : `<td contenteditable="true" spellcheck="false" data-field="${field}" oninput="onTableCellInput(this)">${esc(String(val))}</td>`;
      return `<tr data-field="${field}"><td class="resumen-key">${label}</td>${td}</tr>`;
    }).join("")}</tbody>
  </table>`;
}

function buildCruceTable(c) {
  if (!c || !Object.keys(c).length) return `<div class="empty-state"><div class="empty-icon">🏦</div><p>Sin datos de cruce bancario</p></div>`;
  const CRUCE_RO = new Set(["fecha","metodo_pago","cuenta","subcuenta","propiedad","departamento"]);
  const rows = [
    ["Fecha",             "fecha",            c.fecha],
    ["Hora",              "hora",             formatHora(c.hora)],
    ["Comercio",          "comercio",         c.comercio],
    ["RFC",               "rfc",              c.rfc],
    ["Folio",             "folio",            c.folio],
    ["Método de pago",    "metodo_pago",      c.metodo_pago],
    ["Últimos 4 dígitos", "tarjeta_ultimos4", c.tarjeta_ultimos4],
    ["Monto cruce",       "monto_cruce",      c.monto_cruce  || null],
    ["Total ticket",      "total_ticket",     c.total_ticket || null],
    ["Cuenta",            "cuenta",           c.cuenta],
    ["Subcuenta",         "subcuenta",        c.subcuenta],
    ["Propiedad",         "propiedad",        c.propiedad],
    ["Departamento",      "departamento",     c.departamento],
  ].filter(([,, v]) => v !== "" && v != null);
  return `<table>
    <thead><tr><th>Campo</th><th>Valor</th></tr></thead>
    <tbody>${rows.map(([label, field, val]) => {
      const ro = CRUCE_RO.has(field);
      const td = ro
        ? `<td>${esc(String(val))}</td>`
        : `<td contenteditable="true" spellcheck="false" data-field="${field}" oninput="onTableCellInput(this)">${esc(String(val))}</td>`;
      return `<tr data-field="${field}"><td class="resumen-key">${label}</td>${td}</tr>`;
    }).join("")}</tbody>
  </table>`;
}

function buildDashboardCruceTable(ticket) {
  const r = ticket.resumen || {};
  const s = k => String(r[k] || "");
  const CRUCE_RO = new Set(["fecha","metodo_pago","cuenta","subcuenta","propiedad","departamento"]);
  const rows = [
    ["Fecha",             "fecha",            s("fecha")],
    ["Hora",              "hora",             formatHora(s("hora"))],
    ["Comercio",          "comercio",         s("tienda")],
    ["RFC",               "rfc",              s("rfc")],
    ["Folio",             "folio",            s("folio")],
    ["Método de pago",    "metodo_pago",      s("metodo_pago")],
    ["Últimos 4 dígitos", "tarjeta_ultimos4", s("tarjeta_ultimos4")],
    ["Monto cruce",       "monto_cruce",      r.total  || null],
    ["Total ticket",      "total_ticket",     r.total  || null],
    ["Cuenta",            "cuenta",           s("cuenta")],
    ["Subcuenta",         "subcuenta",        s("subcuenta")],
    ["Propiedad",         "propiedad",        s("propiedad")],
    ["Departamento",      "departamento",     s("departamento")],
  ].filter(([,, v]) => v !== "" && v != null);
  if (!rows.length) return `<div class="empty-state"><div class="empty-icon">🏦</div><p>Sin datos de cruce bancario</p></div>`;
  return `<table>
    <thead><tr><th>Campo</th><th>Valor</th></tr></thead>
    <tbody>${rows.map(([label, field, val]) => {
      const ro = CRUCE_RO.has(field);
      const td = ro
        ? `<td>${esc(String(val))}</td>`
        : `<td contenteditable="true" spellcheck="false" data-field="${field}" oninput="onTableCellInput(this)">${esc(String(val))}</td>`;
      return `<tr data-field="${field}"><td class="resumen-key">${label}</td>${td}</tr>`;
    }).join("")}</tbody>
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
  "Ingresos": "ci-ingresos", "Ingreso":  "ci-ingresos",
  "Egresos":  "ci-egresos",  "Egreso":   "ci-egresos",
  "Capital":  "ci-capital",
  "Activos":  "ci-activos",  "Activo":   "ci-activos",
  "Pasivos":  "ci-pasivos",  "Pasivo":   "ci-pasivos",
};

const ALL_CI = ["ci-ingresos","ci-egresos","ci-capital","ci-activos","ci-pasivos","ci-sincuenta"];


async function guardarResultados() {
  if (!ticketResults.length) return;

  const btn        = document.getElementById("btnGuardar");
  const statusEl   = document.getElementById("saveStatus");
  const subtitleEl = document.getElementById("saveSubtitle");

  try {
    if (btn) btn.style.pointerEvents = "none";
    if (statusEl) { statusEl.textContent = ""; statusEl.classList.add("hidden"); }

    showLoading("Guardando tickets…", "Subiendo imágenes y guardando en Sheets…");

    const productos = [];
    const resumen   = [];
    const cruce     = [];
    const metadata  = [];

    ticketResults.forEach((t, i) => {
      if (t.skipped) return; // omitir duplicados detectados por hash

      const c     = getClassify(i);
      const clasif = {
        cuenta:             c.cuenta,
        subcuenta:          c.subcuenta,
        categoria_gasto:    c.categoria,
        concepto:           c.concepto,
        propiedad:          c.propiedad,
        departamento:       c.departamento,
        comprador:          c.comprador,
        deducible:          c.deducible   ? "Sí" : "No",
        reembolso:          c.reembolso   ? "Sí" : "No",
        reembolso_a:        c.reembolso_a,
        metodo_pago_clasif: c.metodo_pago_clasif,
        detalles_operacion: c.detalles_operacion,
        comentarios:        c.comentarios,
      };

      const fechaFinal = c.fecha || t.resumen.fecha || "";
      metadata.push({ ticket_id: t.resumen.ticket_id, fecha: fechaFinal, tienda: t.resumen.tienda });

      // Leer estado actual de las tablas (ediciones, nuevos y eliminados)
      const resEdits   = readResumenEditsFromDOM(`#tab-resumen-${i}`);
      const prodsFinal = readAllProductsFromDOM(`#tab-transcripcion-${i}`, t.productos, t.resumen.ticket_id);

      prodsFinal.forEach(p => {
        productos.push({
          ticket_id:               p.ticket_id,
          tienda:                  resEdits.tienda ?? t.resumen.tienda,
          fecha:                   fechaFinal,
          linea_numero:            p.linea_numero,
          descripcion:             p.descripcion,
          cantidad:                p.cantidad,
          precio_unitario:         p.precio_unitario,
          monto:                   p.monto,
          categoria_operativa:     p.categoria_operativa,
          deducible_sugerido:      p.deducible_sugerido,
          confianza_clasificacion: p.confianza_clasificacion,
          ...clasif,
        });
      });

      resumen.push({
        ticket_id:        t.resumen.ticket_id,
        archivo:          t.resumen.archivo,
        tienda:           resEdits.tienda           ?? t.resumen.tienda,
        rfc:              resEdits.rfc              ?? t.resumen.rfc,
        fecha:            fechaFinal,
        hora:             resEdits.hora             ?? t.resumen.hora,
        folio:            resEdits.folio            ?? t.resumen.folio,
        metodo_pago:      t.resumen.metodo_pago,
        tarjeta_ultimos4: resEdits.tarjeta_ultimos4 ?? t.resumen.tarjeta_ultimos4,
        num_productos:    t.resumen.num_productos,
        subtotal:         numEdit(resEdits.subtotal,  t.resumen.subtotal),
        iva:              numEdit(resEdits.iva,        t.resumen.iva),
        ieps:             numEdit(resEdits.ieps,       t.resumen.ieps),
        descuentos:       numEdit(resEdits.descuentos, t.resumen.descuentos),
        total:            numEdit(resEdits.total,      t.resumen.total),
        ...clasif,
        clasificado_por:  currentUser,
        fecha_captura:    t.resumen.fecha_captura || new Date().toISOString(),
        imagen_nombre:    "",
        imagen_url:       "",
        archivo_hash:     t.fileHash || "",
      });

      cruce.push({
        fecha:            fechaFinal,
        hora:             t.cruce.hora,
        comercio:         t.cruce.comercio,
        rfc:              t.cruce.rfc,
        folio:            t.cruce.folio,
        metodo_pago:      t.cruce.metodo_pago,
        tarjeta_ultimos4: t.cruce.tarjeta_ultimos4,
        monto_cruce:      t.cruce.monto_cruce,
        total_ticket:     t.cruce.total_ticket,
        cuenta:           c.cuenta,
        subcuenta:        c.subcuenta,
        categoria_gasto:  c.categoria,
        concepto:         c.concepto,
        propiedad:        c.propiedad,
        departamento:     c.departamento,
      });
    });

    // Una sola llamada al backend — él sube imágenes a Drive y guarda en Sheets
    const form = new FormData();
    form.append("metadata",  JSON.stringify(metadata));
    form.append("productos", JSON.stringify(productos));
    form.append("resumen",   JSON.stringify(resumen));
    form.append("cruce",     JSON.stringify(cruce));
    ticketResults.forEach(t => { if (t.file) form.append("files", t.file); });

    const saveRes  = await fetch(`${BACKEND}/save-tickets`, { method: "POST", body: form });
    const saveData = await saveRes.json();
    if (!saveRes.ok || !saveData.ok) throw new Error(saveData.error || "Error al guardar");

    const dupCount = ticketResults.filter(t => t.duplicate).length;
    const dupNote  = dupCount ? ` · ⚠️ ${dupCount} posible${dupCount > 1 ? "s" : ""} duplicado${dupCount > 1 ? "s" : ""}` : "";
    const msg = `✅ ${saveData.tickets_saved} ticket${saveData.tickets_saved !== 1 ? "s" : ""} guardados · ${saveData.images_uploaded} imagen${saveData.images_uploaded !== 1 ? "es" : ""} subida${saveData.images_uploaded !== 1 ? "s" : ""} a Drive${dupNote}`;
    if (statusEl)   { statusEl.textContent = msg; statusEl.classList.remove("hidden"); statusEl.className = "save-status save-ok"; }
    if (subtitleEl) subtitleEl.textContent = "Enviado correctamente";
  } catch (err) {
    const msg = "❌ Error: " + err.message;
    if (statusEl) { statusEl.textContent = msg; statusEl.classList.remove("hidden"); statusEl.className = "save-status save-err"; }
  } finally {
    hideLoading();
    if (btn) btn.style.pointerEvents = "";
  }
}

/** Abre el lightbox para un ticket: imágenes directo, PDFs con todas las páginas */
async function openTicketImageLightbox(i) {
  const ticket = ticketResults[i];
  if (!ticket) return;
  if (ticket.file && isPdf(ticket.file)) {
    await openPdfLightbox(ticket.file);
  } else {
    openImageLightbox(ticket.imageUrl);
  }
}

function openImageLightbox(url, isTemporaryBlob = false) {
  if (!url) return;
  if (lightboxBlobUrl) { URL.revokeObjectURL(lightboxBlobUrl); lightboxBlobUrl = null; }
  if (isTemporaryBlob) lightboxBlobUrl = url;
  document.getElementById("lightboxImg").src = url;
  document.getElementById("imageLightbox").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function lbApplyTransform() {
  const img = document.getElementById("lightboxImg");
  if (lightboxZoomed) {
    img.style.transform = `translate(${lbPanX}px,${lbPanY}px) scale(${LB_ZOOM})`;
    img.style.cursor    = "grab";
    img.style.transition = lbDragging ? "none" : "transform .22s ease";
  } else {
    img.style.transform = "";
    img.style.cursor    = "zoom-in";
    img.style.transition = "transform .22s ease";
  }
}

function toggleLightboxZoom(e) {
  e.stopPropagation();
  if (lbHasDragged) return; // fue un arrastre, no un clic
  lightboxZoomed = !lightboxZoomed;
  if (lightboxZoomed) { lbPanX = 0; lbPanY = 0; } // centrar al entrar
  lbApplyTransform();
}

function closeLightbox() {
  lightboxZoomed = false; lbDragging = false; lbHasDragged = false;
  lbPanX = 0; lbPanY = 0;
  const img = document.getElementById("lightboxImg");
  img.style.transform = ""; img.style.cursor = ""; img.style.transition = "";
  document.getElementById("imageLightbox").classList.add("hidden");
  img.src = "";
  if (lightboxBlobUrl) { URL.revokeObjectURL(lightboxBlobUrl); lightboxBlobUrl = null; }
  document.body.style.overflow = "";
}

function clasificarTicket(i) {
  markAsClassified(i);
  hideClassifyActions(i);
  // Cerrar el panel después de clasificar
  document.getElementById(`classify-${i}`).classList.add("hidden");
  document.getElementById(`btn-classify-${i}`).classList.remove("open");
}

function limpiarClasificacion(i) {
  // Buscador
  const search = document.getElementById(`search-${i}`);
  if (search) search.value = "";
  hideSearchResults(i);

  // Cuenta → volver a "Sin cuenta"
  const cuentaGrid = document.getElementById(`cuenta-grid-${i}`);
  if (cuentaGrid) {
    const cards = cuentaGrid.querySelectorAll(".cuenta-card");
    cards.forEach(c => c.classList.remove("active"));
    const sinCuenta = Array.from(cards).find(c => c.dataset.value === "");
    if (sinCuenta) sinCuenta.classList.add("active");
    document.getElementById(`cuenta-${i}`).value = "";
  }
  resetSubcuenta(i);

  // Ruta de clasificación
  updateClasiPath(i);

  // Propiedad
  const prop = document.getElementById(`propiedad-${i}`);
  if (prop) { prop.value = ""; togglePropiedadOtro(i, ""); }

  // Departamento
  const dept = document.getElementById(`departamento-${i}`);
  if (dept) dept.value = "";

  // Encargado de operación
  document.getElementById(`comprador-grid-${i}`)
    ?.querySelectorAll(".cuenta-card").forEach(c => c.classList.remove("active"));
  const comprador = document.getElementById(`comprador-${i}`);
  if (comprador) comprador.value = "";

  // Deducible
  const ded = document.getElementById(`deducible-${i}`);
  if (ded && ded.checked) { ded.checked = false; updateDeducibleLabel(i, false); }

  // Reembolso
  const reem = document.getElementById(`reembolso-${i}`);
  if (reem && reem.checked) { reem.checked = false; toggleReembolso(i, false); }

  // Método de pago
  document.getElementById(`metodo-grid-${i}`)
    ?.querySelectorAll(".cuenta-card").forEach(c => c.classList.remove("active"));
  const metodo = document.getElementById(`metodo-clasif-${i}`);
  if (metodo) metodo.value = "";

  // Campos de texto libres
  ["detalles", "comentarios"].forEach(id => {
    const el = document.getElementById(`${id}-${i}`);
    if (el) el.value = "";
  });

  // Fecha — restaurar a la detectada automáticamente
  const fechaInput = document.getElementById(`fecha-clasif-${i}`);
  if (fechaInput) fechaInput.value = ticketResults[i]?.resumen?.fecha || "";
  hideClassifyActions(i);
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

  // 6. Reembolso chip
  const reembolsoChipEl = document.getElementById(`reembolso-chip-${i}`);
  if (reembolsoChipEl) {
    if (c.reembolso && c.reembolso_a) {
      reembolsoChipEl.textContent = "↩ Reembolso a " + c.reembolso_a;
      reembolsoChipEl.classList.remove("hidden");
    } else {
      reembolsoChipEl.classList.add("hidden");
    }
  }

  // Path in tab label
  const parts    = [c.cuenta, c.subcuenta, c.categoria, c.concepto].filter(Boolean);
  const pathText = parts.join(" › ") || "Sin clasificar";
  const labelEl  = tab.querySelector(".classify-tab-label");
  labelEl.textContent = pathText;
  labelEl.style.cssText = "font-size:10px;text-transform:none;letter-spacing:.01em;font-weight:700;color:#fff;";

  // ── Sincronizar ticketResults en memoria ──────────────────────────────────
  const ticket = ticketResults[i];
  if (ticket) {
    // Resumen
    const r = ticket.resumen || {};
    if (c.fecha)            r.fecha         = c.fecha;
    if (c.metodo_pago_clasif) r.metodo_pago = c.metodo_pago_clasif;
    r.cuenta          = c.cuenta;
    r.subcuenta       = c.subcuenta;
    r.categoria_gasto = c.categoria;
    r.concepto        = c.concepto;
    r.propiedad       = c.propiedad;
    r.departamento    = c.departamento;
    // Actualizar fecha visible en el encabezado
    const metaEl = document.getElementById(`ticket-meta-${i}`);
    if (metaEl && c.fecha) {
      const parts = [c.fecha, r.hora || ""].filter(Boolean);
      metaEl.textContent = parts.join(" · ") + (parts.length ? " · " : "") +
        "🧾 " + (r.num_productos || 0) + " producto" + ((r.num_productos || 0) !== 1 ? "s" : "");
    }

    // Cruce bancario
    const cr = ticket.cruce || {};
    if (c.metodo_pago_clasif) cr.metodo_pago = c.metodo_pago_clasif;
    cr.cuenta       = c.cuenta;
    cr.subcuenta    = c.subcuenta;
    cr.propiedad    = c.propiedad;
    cr.departamento = c.departamento;

    // Rebuild tablas
    const resumenTab = document.getElementById(`tab-resumen-${i}`);
    if (resumenTab) resumenTab.innerHTML = buildResumenTable(r);
    const cruceTab = document.getElementById(`tab-cruce-${i}`);
    if (cruceTab) cruceTab.innerHTML = buildCruceTable(cr);

    // Actualizar chip de método de pago en encabezado
    const chipWrap = document.getElementById(`payment-chip-${i}`);
    if (chipWrap) {
      chipWrap.innerHTML = paymentChip(r.metodo_pago, r.tarjeta_ultimos4);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  MÓDULO: Registros contables  (Bancos + Presupuesto_sys)
// ══════════════════════════════════════════════════════════════════════════════

// ─── Estado global ───────────────────────────────────────────────────────────
let BN_RAW    = [];
let BN_BUDGET = [];
let BN_TIPO   = 'T';   // 'T' Todos | 'E' Egresos | 'I' Ingresos | 'A' Alertas | 'F' Indicadores
let BN_LOADED = false;
const bn_st   = { año: '', mes: '', cuenta: '', categoria: '', concepto: '' };
const BN_BCACHE = { E: null, I: null };
let BN_CATALOG = {};           // catálogo construido desde Presupuesto_sys
let _BN_ORIG_CATALOG = null;   // respaldo del CATALOG de tickets

// ─── Helpers ─────────────────────────────────────────────────────────────────
const bn_fmt$  = (x) => Number(x || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
const bn_fmtPct= (x) => isFinite(x) ? (x * 100).toFixed(1) + '%' : '—';
const bn_norm  = (s) => String(s ?? '').trim();
const bn_canon = (s) => bn_norm(s).normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,' ').toLowerCase();
const bn_cc    = (s) => bn_canon(s).replace(/[^a-z0-9]+/g,'');
const bn_uniq  = (arr) => [...new Set(arr.map(bn_norm).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'es'));

/** Devuelve el valor de Día formateado como d/m/AAAA (ej. 2/1/2025).
 *  Acepta YYYY-MM-DD o Date.toString() de Apps Script. */
function bn_formatDia(d) {
  const s = String(d || '').trim();
  if (!s) return '';
  // Ya es YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const [y, m, dy] = s.substring(0, 10).split('-');
    return `${Number(dy)}/${Number(m)}/${y}`;
  }
  // "Wed Jan 01 2025 00:00:00 GMT-0600..." — Date.toString() de Apps Script
  if (s.includes('GMT') || /^\w{3}\s+\w{3}\s+\d/.test(s)) {
    const dt = new Date(s);
    if (!isNaN(dt.getTime())) {
      return `${dt.getDate()}/${dt.getMonth() + 1}/${dt.getFullYear()}`;
    }
  }
  return s;
}

/** Construye BN_CATALOG desde BN_BUDGET (Presupuesto_sys).
 *  Soporta las estructuras:
 *    4 niveles: cuenta > subcuenta > categoria > concepto
 *    3 niveles: cuenta > subcuenta > concepto   (sin categoria)
 *    3 niveles: cuenta > categoria > concepto   (sin subcuenta)
 */
function bn_buildBnCatalog() {
  const cat = {};
  for (const b of (BN_BUDGET || [])) {
    const cuenta = (b.TIPO      || '').trim();
    const sub    = (b.SUBCUENTA || '').trim();
    const catg   = (b.CATEGORIA || '').trim();
    const con    = (b.CONCEPTO  || '').trim();
    if (!cuenta) continue;
    if (!cat[cuenta]) cat[cuenta] = {};

    if (sub && catg) {
      // 4-nivel: cuenta > sub > catg > concepto
      if (Array.isArray(cat[cuenta][sub])) {
        // estaba como array 3-nivel; promover a objeto
        const prev = cat[cuenta][sub];
        cat[cuenta][sub] = {};
        if (prev.length) cat[cuenta][sub][''] = prev;
      }
      if (!cat[cuenta][sub]) cat[cuenta][sub] = {};
      if (!cat[cuenta][sub][catg]) cat[cuenta][sub][catg] = [];
      if (con && !cat[cuenta][sub][catg].includes(con)) cat[cuenta][sub][catg].push(con);
    } else if (sub) {
      // 3-nivel: cuenta > sub > concepto (sin catg)
      if (!cat[cuenta][sub] || (typeof cat[cuenta][sub] === 'object' && !Array.isArray(cat[cuenta][sub]) && Object.keys(cat[cuenta][sub]).length === 0)) {
        cat[cuenta][sub] = [];
      }
      if (Array.isArray(cat[cuenta][sub]) && con && !cat[cuenta][sub].includes(con)) {
        cat[cuenta][sub].push(con);
      }
    } else if (catg) {
      // 3-nivel: cuenta > catg > concepto (sin sub)
      if (!cat[cuenta][catg]) cat[cuenta][catg] = [];
      if (Array.isArray(cat[cuenta][catg]) && con && !cat[cuenta][catg].includes(con)) {
        cat[cuenta][catg].push(con);
      }
    }
  }
  BN_CATALOG = cat;
}

/** Activa el catálogo de Presupuesto_sys para el panel Clasificar de Bancos. */
function bn_activateCatalog() {
  if (!_BN_ORIG_CATALOG) _BN_ORIG_CATALOG = CATALOG;
  CATALOG = BN_CATALOG;
  // Construir índice de búsqueda DIRECTO desde BN_BUDGET (lista plana).
  // Esto garantiza que TODOS los renglones de Presupuesto_sys sean buscables
  // independientemente de la estructura jerárquica del catálogo.
  SEARCH_INDEX = (BN_BUDGET || [])
    .filter(b => b.TIPO)
    .map(b => ({
      cuenta:    (b.TIPO      || '').trim(),
      subcuenta: (b.SUBCUENTA || '').trim(),
      categoria: (b.CATEGORIA || '').trim(),
      concepto:  (b.CONCEPTO  || '').trim()
    }));
}
/** Restaura el catálogo original de tickets. */
function bn_deactivateCatalog() {
  if (_BN_ORIG_CATALOG) {
    CATALOG = _BN_ORIG_CATALOG;
    SEARCH_INDEX = buildSearchIndex(); // reconstruir índice con catálogo de Tickets
  }
}

/** Extrae solo el nombre del mes ("Enero 2025" → "Enero", "01/2025" → "Enero"). */
function bn_mesLabel(m) {
  const NAMES = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio',
                 'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const s = String(m || '').trim();
  // Número al inicio: "01/2025", "3-2026"
  const numPfx = s.match(/^(\d{1,2})\s*[.\-\/]/);
  if (numPfx) return NAMES[Number(numPfx[1])] || s;
  // Nombre de mes en español al inicio: "enero 2026", "Febrero"
  const MAP = {enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,
               julio:7,agosto:8,septiembre:9,setiembre:9,octubre:10,noviembre:11,diciembre:12};
  const key = bn_canon(s).split(' ')[0];
  if (MAP[key]) return NAMES[MAP[key]];
  // Date string de Sheets: "Wed Jan 01 2026 00:00:00 GMT-0600..."
  const dt = new Date(s);
  if (!isNaN(dt.getTime()) && dt.getFullYear() > 1900) return NAMES[dt.getMonth() + 1];
  return s;
}

function bn_monthOrd(m) {
  const mm = String(m||'').match(/^\s*(\d{1,2})\s*[.\-\/]/);
  if (mm) return Number(mm[1]);
  const map = {enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,
    julio:7,agosto:8,septiembre:9,setiembre:9,octubre:10,noviembre:11,diciembre:12};
  return map[bn_canon(String(m||'')).split(' ')[0]] || 99;
}
function bn_yearOf(val) { const m=String(val||'').match(/\b(20\d{2})\b/); return m?m[1]:''; }

/**
 * Parsea el campo Día (ya normalizado a ISO) y devuelve { año, mes }.
 * Sin filtros de año/mes — función mantenida por compatibilidad.
 */
function bn_parseDia(dia) { return { año: '', mes: '' }; }

function bn_sevOver(av)  {
  if(!isFinite(av))   return {label:'—',       cls:'bn-pill'};
  if(av<=1.0)         return {label:'OK',       cls:'bn-pill bn-good'};
  if(av<=1.10)        return {label:'Alerta',   cls:'bn-pill bn-warn'};
                      return {label:'Crítico',  cls:'bn-pill bn-bad'};
}
function bn_sevUnder(av) {
  if(!isFinite(av))   return {label:'—',       cls:'bn-pill'};
  if(av>=1.0)         return {label:'OK',       cls:'bn-pill bn-good'};
  if(av>=0.90)        return {label:'Alerta',   cls:'bn-pill bn-warn'};
                      return {label:'Crítico',  cls:'bn-pill bn-bad'};
}

// ─── Budget index ─────────────────────────────────────────────────────────────
function bn_buildBIdx(tipo) {
  const m1=new Map(), m2=new Map();
  for (const b of (BN_BUDGET||[])) {
    const t = bn_canon(String(b.TIPO??b.CUENTA??''));
    const isE = t.includes('egr')||t.includes('gasto');
    const isI = t.includes('ing')||t.includes('venta');
    if (t && tipo==='E' && !isE) continue;
    if (t && tipo==='I' && !isI) continue;
    const cat=String(b.CATEGORIA??''), con=String(b.CONCEPTO??'');
    const val=Number(b.MENSUAL??0)||0;
    const k1=bn_canon(cat)+'||'+bn_canon(con);
    const k2=bn_cc(cat)+'||'+bn_cc(con);
    m1.set(k1,(m1.get(k1)||0)+val);
    m2.set(k2,(m2.get(k2)||0)+val);
  }
  return {m1,m2};
}

function bn_getBud(tipo,cat,con) {
  if (!BN_BCACHE[tipo]) BN_BCACHE[tipo]=bn_buildBIdx(tipo);
  const {m1,m2}=BN_BCACHE[tipo];
  const k1=bn_canon(cat)+'||'+bn_canon(con);
  const k2=bn_cc(cat)+'||'+bn_cc(con);
  return m1.get(k1)??m2.get(k2)??0;
}
function bn_resetBCache() { BN_BCACHE.E=null; BN_BCACHE.I=null; }
function bn_txt(id,v) { const el=document.getElementById(id); if(el) el.textContent=v; }

// ─── Load ─────────────────────────────────────────────────────────────────────
async function bn_loadData() {
  const lbl   = document.getElementById('bn-status-label');
  const empty = document.getElementById('bn-empty');
  const emMsg = document.getElementById('bn-empty-msg');
  if (lbl) lbl.textContent='Cargando…';
  if (empty) { empty.style.display='flex'; if(emMsg) emMsg.textContent='Cargando datos…'; }
  document.getElementById('bn-table-wrap')?.classList.add('hidden');
  document.getElementById('bn-indicadores')?.classList.add('hidden');
  document.getElementById('bn-kpi-row')?.classList.add('hidden');
  try {
    const res  = await fetch(BACKEND+'/get-bancos',{cache:'no-store'});
    const data = await res.json();
    if (!data.ok) throw new Error(data.error||'Error al obtener datos');
    BN_RAW=(data.records||[]).map((r,i)=>{
      const rec = r.rowNum ? {...r} : {...r, rowNum: i+2};
      // Inicializar campos _ desde valores ya clasificados en el sheet
      rec._cuenta          = rec.CUENTA    || '';
      rec._subcuenta       = rec.SUBCUENTA || '';
      rec._categoria_gasto = rec.CATEGORIA || '';
      rec._concepto        = rec.CONCEPTO  || '';
      // _tipo: clasificación manual > TIPO del sheet > signo del monto
      // Normalizar a forma canónica para que CUENTA_COLOR_CLASS y filtros funcionen
      const monto = Number(rec.Monto) || 0;
      const _rawTipo = rec._cuenta || rec.TIPO || (monto < 0 ? 'Egresos' : monto > 0 ? 'Ingresos' : '');
      const _ct = bn_canon(_rawTipo);
      rec._tipo = _ct.includes('egr') ? 'Egresos' : _ct.includes('ing') ? 'Ingresos' :
                  _ct.includes('activ') ? 'Activos' : _ct.includes('pasiv') ? 'Pasivos' :
                  _ct.includes('capital') ? 'Capital' : _rawTipo;
      return rec;
    });
    BN_BUDGET=data.budget||[];
    BN_LOADED=true; bn_resetBCache();
    bn_buildBnCatalog();
    bn_activateCatalog(); // Usa el catálogo de Presupuesto_sys mientras el módulo está activo
    if (lbl) {
      const ssId  = data.spreadsheetId  || '1f_rdwQncSUXRNEvp5kM_kjyX1S-NnY7UE2z4HGvFL3Q';
      const ssUrl = data.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${ssId}/edit`;
      lbl.innerHTML = `Registros contables — ${BN_RAW.length.toLocaleString('es-MX')} movimientos` +
        `&nbsp;&nbsp;📄 <a href="${ssUrl}" target="_blank" style="font-size:11px;color:var(--text-soft);text-decoration:underline">Ver Spreadsheet fuente</a>`;
    }
    if (empty) empty.style.display='none';
    bn_populateFilters();
    bn_setDefaultFilters();
    bn_render();
  } catch(e) {
    if (lbl) lbl.textContent='Error al cargar';
    if (empty) { empty.style.display='flex'; if(emMsg) emMsg.textContent='Error: '+e.message; }
  }
}

// ─── Filters ─────────────────────────────────────────────────────────────────
function bn_populateFilters() {
  const fill=(id,vals,blank)=>{
    const sel=document.getElementById(id); if(!sel) return;
    const cur=sel.value;
    sel.innerHTML=`<option value="">${blank}</option>`+
      vals.map(v=>`<option${v===cur?' selected':''}>${esc(v)}</option>`).join('');
  };
  fill('bn-f-cuenta',    bn_uniq(BN_RAW.map(r=>bn_norm(r['Cuenta bancaria']||''))), 'Todas');
  fill('bn-f-categoria', bn_uniq(BN_RAW.map(r=>bn_norm(r.CATEGORIA||''))),          'Todas');
  fill('bn-f-concepto',  bn_uniq(BN_RAW.map(r=>bn_norm(r.CONCEPTO ||''))),          'Todos');
}

function bn_setDefaultFilters() {
  bn_st.año=bn_st.mes='';
  bn_st.cuenta=bn_st.categoria=bn_st.concepto='';
}

function bn_onFilterChange() {
  bn_st.cuenta    = document.getElementById('bn-f-cuenta')?.value    || '';
  bn_st.categoria = document.getElementById('bn-f-categoria')?.value || '';
  bn_st.concepto  = document.getElementById('bn-f-concepto')?.value  || '';
  bn_render();
}

function bn_clearFilters() {
  ['bn-f-cuenta','bn-f-categoria','bn-f-concepto','bn-f-text']
    .forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  bn_st.año=bn_st.mes=bn_st.cuenta=bn_st.categoria=bn_st.concepto='';
  bn_render();
}

function bn_toggleFilters() {
  const body=document.getElementById('bn-filter-body');
  const btn=document.getElementById('bn-btn-filter-toggle');
  if(!body) return;
  const hidden=body.classList.toggle('hidden');
  btn?.classList.toggle('active',!hidden);
}

// ─── Filtered records ─────────────────────────────────────────────────────────
function bn_filteredRecs(tipo) {
  const s=bn_st;
  const q=(document.getElementById('bn-f-text')?.value||'').toLowerCase().trim();
  return BN_RAW.filter(r=>{
    const cta=bn_norm(r['Cuenta bancaria']||'');
    const sub=bn_norm(r.SUBCUENTA ||'');
    const cat=bn_norm(r.CATEGORIA ||'');
    const con=bn_norm(r.CONCEPTO  ||'');
    const t = bn_canon(r._tipo || ''); // 'egresos','ingresos','activos','pasivos','capital'
    if(s.cuenta    && cta!==s.cuenta)    return false;
    if(s.categoria && cat!==s.categoria) return false;
    if(s.concepto  && con!==s.concepto)  return false;
    if(tipo==='E'  && !t.includes('egr'))     return false;
    if(tipo==='I'  && !t.includes('ing'))     return false;
    if(tipo==='AC' && !t.includes('activ'))   return false;
    if(tipo==='PA' && !t.includes('pasiv'))   return false;
    if(tipo==='CA' && !t.includes('capital')) return false;
    // 'T' = Todos: no filtra por tipo
    if(q){ const h=(sub+' '+cat+' '+con+' '+bn_norm(r.DESCRIPCION||'')).toLowerCase(); if(!h.includes(q)) return false; }
    return true;
  });
}

// ─── Aggregation ─────────────────────────────────────────────────────────────
function bn_aggregate(tipo) {
  const recs=bn_filteredRecs(tipo);
  const g=new Map();
  for(const r of recs){
    const mes=bn_norm(r.Mes), cat=bn_norm(r.CATEGORIA||''), con=bn_norm(r.CONCEPTO||'');
    const key=cat+'||'+con+'||'+mes;
    const bud=bn_getBud(tipo,cat,con);
    if(!g.has(key)) g.set(key,{key,cat,con,mes,real:0,bud});
    g.get(key).real+=Number(r.Monto||0);
  }
  const rows=[...g.values()].map(row=>{
    const realAbs=Math.abs(row.real), budAbs=Math.abs(Number(row.bud||0));
    const av=budAbs>0?(realAbs/budAbs):NaN;
    const sev=(tipo==='E')?bn_sevOver(av):bn_sevUnder(av);
    return{...row,realAbs,budAbs,av,sev};
  });
  rows.sort((a,b)=>{
    const c=a.cat.localeCompare(b.cat,'es'); if(c) return c;
    const d=a.con.localeCompare(b.con,'es'); if(d) return d;
    return a.mes.localeCompare(b.mes,'es');
  });
  const realM=recs.reduce((s,r)=>s+Math.abs(Number(r.Monto||0)),0);
  const seen=new Set(); let budM=0;
  for(const r of recs){
    const k=bn_canon(r.CATEGORIA||'')+'||'+bn_canon(r.CONCEPTO||'')+'||'+bn_norm(r.Mes);
    if(seen.has(k)) continue; seen.add(k);
    budM+=Math.abs(bn_getBud(tipo,bn_norm(r.CATEGORIA||''),bn_norm(r.CONCEPTO||'')));
  }
  const avM=budM>0?(realM/budM):NaN;
  const alerts=tipo==='E'?rows.filter(r=>r.budAbs>0&&r.av>1.0).length:0;
  return{rows,realM,budM,avM,alerts};
}

// ─── Monthly series ────────────────────────────────────────────────────────────
function bn_monthly() {
  const eR=bn_filteredRecs('E'), iR=bn_filteredRecs('I');
  const sum=(recs)=>{ const m=new Map(); for(const r of recs){ const mes=bn_norm(r.Mes); m.set(mes,(m.get(mes)||0)+Math.abs(Number(r.Monto||0))); } return m; };
  const mE=sum(eR), mI=sum(iR);
  const months=[...new Set([...mE.keys(),...mI.keys()])];
  months.sort((a,b)=>{
    const ya=bn_yearOf(a),yb=bn_yearOf(b); if(ya!==yb) return ya.localeCompare(yb,'es');
    return bn_monthOrd(a)-bn_monthOrd(b);
  });
  const rows=months.map(m=>{const I=mI.get(m)||0,E=mE.get(m)||0,U=I-E,M=I>0?(U/I):NaN;return{Mes:m,I,E,U,M};});
  const ytdI=rows.reduce((s,r)=>s+r.I,0), ytdE=rows.reduce((s,r)=>s+r.E,0);
  const ytdU=ytdI-ytdE, ytdM=ytdI>0?(ytdU/ytdI):NaN;
  const n=rows.filter(r=>r.I>0||r.E>0).length||0;
  return{rows,ytdI,ytdE,ytdU,ytdM,n,avgI:n?ytdI/n:0,avgE:n?ytdE/n:0,avgU:n?ytdU/n:0};
}

// ─── Tab switching ────────────────────────────────────────────────────────────
function bn_setTipo(t) {
  BN_TIPO=t;
  ['T','E','I','AC','PA','CA','A','F'].forEach(x=>document.getElementById('bn-tab-'+x)?.classList.toggle('active',x===t));
  bn_render();
}

// ─── Main render ──────────────────────────────────────────────────────────────
function bn_render() {
  if(!BN_LOADED) return;
  const sE=bn_aggregate('E'), sI=bn_aggregate('I');

  // KPIs
  bn_txt('bn-k-egr-real',       bn_fmt$(sE.realM));
  bn_txt('bn-k-egr-sub',        'Presup. '+bn_fmt$(sE.budM));
  bn_txt('bn-k-ing-real',       bn_fmt$(sI.realM));
  bn_txt('bn-k-ing-sub',        sI.rows.length+' movimientos');
  bn_txt('bn-k-avance-egr',     isFinite(sE.avM)?bn_fmtPct(sE.avM):'—');
  bn_txt('bn-k-avance-egr-sub', 'Real '+bn_fmt$(sE.realM)+' / '+bn_fmt$(sE.budM));
  const util=sI.realM-sE.realM;
  bn_txt('bn-k-utilidad',       bn_fmt$(util));
  const marg=sI.realM>0?(util/sI.realM):NaN;
  bn_txt('bn-k-utilidad-sub',   isFinite(marg)?'Margen '+bn_fmtPct(marg):'Sin ingresos');

  // Color KPI
  const kAv=document.getElementById('bn-k-avance-egr');
  if(kAv){ kAv.className='bn-kpi-value'; if(isFinite(sE.avM)){
    if(sE.avM>1.10) kAv.classList.add('bn-val-bad');
    else if(sE.avM>1.0) kAv.classList.add('bn-val-warn');
    else kAv.classList.add('bn-val-good');
  }}
  const kU=document.getElementById('bn-k-utilidad');
  if(kU) kU.className='bn-kpi-value '+(util>=0?'bn-val-good':'bn-val-bad');

  document.getElementById('bn-kpi-row')?.classList.remove('hidden');

  // Subtitle — en Todos usa el total filtrado; en E/I solo suma ambos
  const visLen = BN_TIPO==='T' ? bn_filteredRecs('T').length : (bn_filteredRecs('E').length+bn_filteredRecs('I').length);
  bn_txt('bn-filter-subtitle', visLen.toLocaleString('es-MX')+' de '+BN_RAW.length.toLocaleString('es-MX')+' movimientos');

  const tw=document.getElementById('bn-table-wrap');
  const cw=document.getElementById('bn-cards-container');
  const pw=document.getElementById('bn-card-pagination');
  const iw=document.getElementById('bn-indicadores');

  if(BN_TIPO==='F'){
    tw?.classList.add('hidden'); cw?.classList.add('hidden'); pw?.classList.add('hidden');
    iw?.classList.remove('hidden'); bn_renderInd(); return;
  }
  iw?.classList.add('hidden');

  if(BN_TIPO==='A'){
    tw?.classList.remove('hidden'); cw?.classList.add('hidden'); pw?.classList.add('hidden');
    bn_renderTable('A',sE,sI); return;
  }

  // E o I → tarjetas individuales
  tw?.classList.add('hidden'); cw?.classList.remove('hidden'); pw?.classList.remove('hidden');
  BN_CUR_RECS = bn_filteredRecs(BN_TIPO);
  BN_CARD_PAGE = 1;
  bn_renderCards();
}

// ─── Table render ─────────────────────────────────────────────────────────────
function bn_renderTable(tipo,sE,sI) {
  const thead=document.getElementById('bn-thead-row');
  const tbody=document.getElementById('bn-tbody');
  const title=document.getElementById('bn-table-title');
  const sub=document.getElementById('bn-table-sub');
  if(!thead||!tbody) return;

  if(tipo==='E'){
    title.textContent='💸 Egresos — Presupuesto vs Real';
    sub.textContent='Click en una fila para ver los movimientos detallados';
    thead.innerHTML='<th>Categoría</th><th>Concepto</th><th>Mes</th><th class="num">Real</th><th class="num">Presupuesto</th><th>Avance</th><th>Estado</th>';
  } else if(tipo==='I'){
    title.textContent='💰 Ingresos';
    sub.textContent='Click en una fila para ver movimientos detallados';
    thead.innerHTML='<th>Categoría</th><th>Concepto</th><th>Mes</th><th class="num">Real</th>';
  } else {
    title.textContent='⚠️ Alertas — Partidas fuera de umbral';
    sub.textContent='Egresos > 100% presupuesto · Ingresos < 90% esperado';
    thead.innerHTML='<th>Tipo</th><th>Categoría</th><th>Concepto</th><th>Mes</th><th class="num">%</th><th>Severidad</th>';
  }
  tbody.innerHTML='';

  let rows;
  if(tipo==='A'){
    rows=[];
    sE.rows.forEach(r=>{ if(r.budAbs>0&&r.av>1.0) rows.push({...r,tipoSrc:'E',sev:bn_sevOver(r.av)}); });
    sI.rows.forEach(r=>{ if(r.budAbs>0&&r.av<1.0) rows.push({...r,tipoSrc:'I',sev:bn_sevUnder(r.av)}); });
    const ord={'bn-pill bn-bad':0,'bn-pill bn-warn':1,'bn-pill bn-good':2,'bn-pill':3};
    rows.sort((a,b)=>(ord[a.sev.cls]||3)-(ord[b.sev.cls]||3));
  } else {
    rows=tipo==='E'?sE.rows:sI.rows;
  }

  if(!rows.length){
    tbody.innerHTML=`<tr><td colspan="8" style="color:var(--text-soft);padding:20px;text-align:center">Sin movimientos para los filtros seleccionados</td></tr>`;
    return;
  }

  for(const r of rows){
    const tr=document.createElement('tr');
    tr.style.cursor='pointer';
    if(tipo==='E'){
      const pct=isFinite(r.av)?Math.min(Math.max(r.av,0),2):0;
      const barCls=r.av>1.10?'bn-bar-bad':r.av>1.0?'bn-bar-warn':'bn-bar-good';
      tr.innerHTML=`
        <td>${esc(r.cat)}</td>
        <td>${esc(r.con)||'<span style="color:var(--text-soft)">(sin concepto)</span>'}</td>
        <td>${esc(r.mes)}</td>
        <td class="num">${bn_fmt$(r.realAbs)}</td>
        <td class="num">${r.budAbs?bn_fmt$(r.budAbs):'<span style="color:var(--text-soft)">—</span>'}</td>
        <td>
          <div class="bn-avance-wrap">
            <div class="bn-avance-bar ${barCls}">
              <div class="bn-avance-fill" style="width:${(pct*100).toFixed(1)}%"></div>
              <div class="bn-avance-marker"></div>
            </div>
            <span class="bn-avance-pct">${isFinite(r.av)?bn_fmtPct(r.av):'—'}</span>
          </div>
        </td>
        <td><span class="${r.sev.cls}">${r.sev.label}</span></td>`;
    } else if(tipo==='I'){
      tr.innerHTML=`
        <td>${esc(r.cat)}</td>
        <td>${esc(r.con)||'<span style="color:var(--text-soft)">(sin concepto)</span>'}</td>
        <td>${esc(r.mes)}</td>
        <td class="num">${bn_fmt$(r.realAbs)}</td>`;
    } else {
      const badge=r.tipoSrc==='E'?'<span class="bn-pill bn-bad">Egreso</span>':'<span class="bn-pill bn-warn">Ingreso</span>';
      tr.innerHTML=`
        <td>${badge}</td>
        <td>${esc(r.cat)}</td>
        <td>${esc(r.con)||'(sin concepto)'}</td>
        <td>${esc(r.mes)}</td>
        <td class="num">${isFinite(r.av)?bn_fmtPct(r.av):'—'}</td>
        <td><span class="${r.sev.cls}">${r.sev.label}</span></td>`;
    }
    tr.addEventListener('click',()=>bn_showDetail(r.cat,r.con,r.mes,(tipo==='A'?r.tipoSrc:tipo)));
    tbody.appendChild(tr);
  }
}

// ─── Detail modal ─────────────────────────────────────────────────────────────
function bn_showDetail(cat,con,mes,tipo) {
  const overlay=document.getElementById('bn-modal-overlay');
  const tbody=document.getElementById('bn-modal-tbody');
  if(!overlay||!tbody) return;
  document.getElementById('bn-modal-title').textContent=(tipo==='E'?'Egreso':'Ingreso')+' — '+cat+(con?' › '+con:'');
  document.getElementById('bn-modal-sub').textContent=mes;
  const rows=BN_RAW.filter(r=>{
    const tip=bn_canon(r.CUENTA||r.TIPO||'');
    if(tipo==='E'&&!tip.includes('egr')) return false;
    if(tipo==='I'&&!tip.includes('ing')) return false;
    return bn_norm(r.CATEGORIA||'')===cat && bn_norm(r.CONCEPTO||'')===con && bn_norm(r.Mes)===mes;
  });
  tbody.innerHTML='';
  if(!rows.length){
    tbody.innerHTML='<tr><td colspan="8" style="color:var(--text-soft);padding:16px;text-align:center">Sin movimientos</td></tr>';
  } else {
    for(const r of rows){
      const fac=bn_norm(r.Factura||'');
      const tr=document.createElement('tr');
      tr.innerHTML=`
        <td>${esc(bn_norm(r.Mes))}</td>
        <td>${esc(bn_norm(r['Cuenta bancaria']||''))}</td>
        <td><span class="bn-pill">${esc(bn_norm(r.CUENTA||''))}</span></td>
        <td>${esc(bn_norm(r.SUBCUENTA||''))}</td>
        <td>${esc(bn_norm(r.CATEGORIA||''))}</td>
        <td>${esc(bn_norm(r.CONCEPTO||''))}</td>
        <td><span class="bn-pill ${fac?'bn-good':'bn-warn'}">${fac||'Sin factura'}</span></td>
        <td class="num">${bn_fmt$(Number(r.Monto||0))}</td>`;
      tbody.appendChild(tr);
    }
  }
  overlay.classList.remove('hidden');
  document.body.style.overflow='hidden';
}

function bn_closeDetail() {
  document.getElementById('bn-modal-overlay')?.classList.add('hidden');
  document.body.style.overflow='';
}

// ─── Indicadores ──────────────────────────────────────────────────────────────
function bn_renderInd() {
  const s=bn_monthly();
  bn_txt('bn-k-egr-real',     bn_fmt$(s.ytdE));
  bn_txt('bn-k-egr-sub',      'Prom. mensual: '+bn_fmt$(s.avgE)+' ('+s.n+' meses)');
  bn_txt('bn-k-ing-real',     bn_fmt$(s.ytdI));
  bn_txt('bn-k-ing-sub',      'Prom. mensual: '+bn_fmt$(s.avgI));
  bn_txt('bn-k-avance-egr',   bn_fmt$(s.ytdU));
  bn_txt('bn-k-avance-egr-sub','Utilidad YTD');
  bn_txt('bn-k-utilidad',     isFinite(s.ytdM)?bn_fmtPct(s.ytdM):'—');
  bn_txt('bn-k-utilidad-sub', 'Margen neto YTD');
  try{ bn_drawTrend('bn-trend-canvas','bn-trend-tip',s); }catch(e){}
  try{ bn_drawMargin('bn-margin-canvas','bn-margin-tip',s); }catch(e){}

  const list=document.getElementById('bn-alerts-list');
  if(!list) return; list.innerHTML='';
  const add=(lvl,title,det)=>{
    const d=document.createElement('div');
    d.className='bn-fin-alert '+lvl;
    d.innerHTML=`<div class="bn-alert-title">${esc(title)}</div><div class="bn-alert-detail">${esc(det)}</div>`;
    list.appendChild(d);
  };
  if(isFinite(s.ytdM)){
    if(s.ytdM<0.20) add('bad','Margen neto bajo (< 20%)','Margen actual: '+bn_fmtPct(s.ytdM)+'. Revisa costos.');
    else if(s.ytdM<0.30) add('warn','Margen moderado (< 30%)','Margen actual: '+bn_fmtPct(s.ytdM)+'.');
    else add('good','Margen saludable (≥ 30%)','Margen actual: '+bn_fmtPct(s.ytdM)+'.');
  } else { add('warn','Margen no calculable','Sin ingresos suficientes en el período.'); }
  const rows=s.rows||[];
  if(rows.length>=2){
    const a=rows[rows.length-2],b=rows[rows.length-1];
    const gE=a.E>0?(b.E-a.E)/a.E:(b.E>0?1:0);
    const gI=a.I>0?(b.I-a.I)/a.I:(b.I>0?1:0);
    if(gE>gI+0.05&&b.E>0)
      add('bad','Egresos creciendo más rápido que ingresos',
        b.Mes+': Egresos '+bn_fmt$(b.E)+' vs Ingresos '+bn_fmt$(b.I));
    else add('good','Crecimiento de egresos controlado','Cambio último mes: E '+bn_fmtPct(gE)+' vs I '+bn_fmtPct(gI));
  }
  if(s.ytdI>0&&s.ytdE>s.ytdI)
    add('bad','Egresos superan ingresos YTD','E '+bn_fmt$(s.ytdE)+' > I '+bn_fmt$(s.ytdI));
}

// ─── Chart: Trend line ────────────────────────────────────────────────────────
function bn_drawTrend(canvasId,tipId,series) {
  const host=document.getElementById(canvasId), tip=document.getElementById(tipId);
  if(!host) return;
  const rows=(series&&series.rows)?series.rows:[];
  const DPR=Math.max(1,Math.min(2,window.devicePixelRatio||1));
  const W=Math.max(320,host.parentElement?.clientWidth||600);
  const Hcss=240;
  host.width=Math.round(W*DPR); host.height=Math.round(Hcss*DPR);
  host.style.height=Hcss+'px';
  const ctx=host.getContext('2d');
  ctx.setTransform(DPR,0,0,DPR,0,0); ctx.clearRect(0,0,W,Hcss);
  const pL=56,pR=16,pT=14,pB=44,plotW=W-pL-pR,plotH=Hcss-pT-pB;
  if(!rows.length){ ctx.font='12px system-ui'; ctx.fillStyle='rgba(0,0,0,.4)'; ctx.fillText('Sin datos.',pL,pT+20); return; }
  const maxV=Math.max(1,...rows.map(r=>Math.max(r.I||0,r.E||0,Math.abs(r.U||0))));
  const xAt=(i)=>pL+(rows.length===1?plotW/2:i*(plotW/(rows.length-1)));
  const yAt=(v)=>pT+(1-(v/maxV))*plotH;

  const drawAxes=()=>{
    ctx.lineWidth=1; ctx.strokeStyle='rgba(0,0,0,.10)';
    ctx.beginPath(); ctx.moveTo(pL,pT); ctx.lineTo(pL,pT+plotH); ctx.lineTo(pL+plotW,pT+plotH); ctx.stroke();
    ctx.font='9px system-ui'; ctx.fillStyle='rgba(0,0,0,.40)'; ctx.textAlign='right';
    [0,.25,.5,.75,1].forEach(f=>{
      const y=pT+(1-f)*plotH;
      const lbl=maxV*f>=1000?(bn_fmt$(maxV*f)).replace('MX$','$'):bn_fmt$(maxV*f).replace('MX$','$');
      ctx.fillText(lbl,pL-3,y+3);
      ctx.strokeStyle='rgba(0,0,0,.05)'; ctx.beginPath(); ctx.moveTo(pL,y); ctx.lineTo(pL+plotW,y); ctx.stroke();
    });
    ctx.textAlign='center'; ctx.fillStyle='rgba(0,0,0,.50)';
    rows.forEach((r,i)=>{
      if(rows.length>12&&i%2===1) return;
      const lab=String(r.Mes||'').replace(/^\s*\d{1,2}\s*[.\-\/]\s*/,'').slice(0,10);
      ctx.fillText(lab,xAt(i),pT+plotH+18);
    });
  };
  const drawSeries=(key,color)=>{
    ctx.lineWidth=2.5; ctx.strokeStyle=color;
    ctx.beginPath();
    rows.forEach((r,i)=>{ const v=Math.max(0,Number(r[key]||0)); i===0?ctx.moveTo(xAt(i),yAt(v)):ctx.lineTo(xAt(i),yAt(v)); });
    ctx.stroke();
    ctx.fillStyle=color;
    rows.forEach((r,i)=>{ ctx.beginPath(); ctx.arc(xAt(i),yAt(Math.max(0,r[key]||0)),3,0,Math.PI*2); ctx.fill(); });
  };
  const drawLegend=()=>{
    const leg=[['Ingresos','#10b981'],['Egresos','#f59e0b'],['Utilidad','#6366f1']];
    ctx.font='11px system-ui'; ctx.textAlign='left';
    leg.forEach(([nm,col],k)=>{ const ox=pL+k*110; ctx.fillStyle=col; ctx.beginPath(); ctx.arc(ox,pT+10,4,0,Math.PI*2); ctx.fill(); ctx.fillStyle='rgba(0,0,0,.65)'; ctx.fillText(nm,ox+10,pT+14); });
  };
  const redraw=()=>{ ctx.clearRect(0,0,W,Hcss); drawAxes(); drawSeries('I','#10b981'); drawSeries('E','#f59e0b'); drawSeries('U','#6366f1'); drawLegend(); };
  redraw();

  const near=(cx)=>{ const rect=host.getBoundingClientRect(),px=cx-rect.left; let b=0,bd=Infinity; for(let i=0;i<rows.length;i++){const d=Math.abs(px-xAt(i));if(d<bd){bd=d;b=i;}} return{idx:b,rect}; };
  const showAt=(idx,rect,cx,cy)=>{
    redraw();
    ctx.strokeStyle='rgba(0,0,0,.18)'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(xAt(idx),pT); ctx.lineTo(xAt(idx),pT+plotH); ctx.stroke();
    [['I','#10b981'],['E','#f59e0b'],['U','#6366f1']].forEach(([key,col])=>{ ctx.fillStyle=col; ctx.beginPath(); ctx.arc(xAt(idx),yAt(Math.max(0,rows[idx][key]||0)),5,0,Math.PI*2); ctx.fill(); });
    if(tip){ const r=rows[idx]; tip.innerHTML=`<div class="bn-tip-title">${esc(r.Mes)}</div><div>Ingresos: <b>${bn_fmt$(r.I)}</b></div><div>Egresos: <b>${bn_fmt$(r.E)}</b></div><div>Utilidad: <b>${bn_fmt$(r.U)}</b></div>`; tip.style.display='block'; const bx=Math.min(Math.max(8,cx-rect.left+12),rect.width-200),by=Math.min(Math.max(8,cy-rect.top-10),rect.height-100); tip.style.left=bx+'px'; tip.style.top=by+'px'; }
  };
  const hide=()=>{ if(tip) tip.style.display='none'; redraw(); };
  host.onmousemove=(ev)=>{ const {idx,rect}=near(ev.clientX); showAt(idx,rect,ev.clientX,ev.clientY); };
  host.onmouseleave=hide;
  host.addEventListener('touchstart',(ev)=>{ const t=ev.touches[0]; if(!t) return; const {idx,rect}=near(t.clientX); showAt(idx,rect,t.clientX,t.clientY); },{passive:true});
  host.addEventListener('touchmove',(ev)=>{ const t=ev.touches[0]; if(!t) return; const {idx,rect}=near(t.clientX); showAt(idx,rect,t.clientX,t.clientY); },{passive:true});
  host.addEventListener('touchend',hide,{passive:true});
}

// ─── Chart: Margin bars ───────────────────────────────────────────────────────
function bn_drawMargin(canvasId,tipId,series) {
  const host=document.getElementById(canvasId), tip=document.getElementById(tipId);
  if(!host) return;
  const rows=(series&&series.rows)?series.rows:[];
  const DPR=Math.max(1,Math.min(2,window.devicePixelRatio||1));
  const W=Math.max(320,host.parentElement?.clientWidth||600), Hcss=220;
  host.width=Math.round(W*DPR); host.height=Math.round(Hcss*DPR); host.style.height=Hcss+'px';
  const ctx=host.getContext('2d');
  ctx.setTransform(DPR,0,0,DPR,0,0); ctx.clearRect(0,0,W,Hcss);
  const pL=56,pR=16,pT=14,pB=44,plotW=W-pL-pR,plotH=Hcss-pT-pB,baseY=pT+plotH/2;
  ctx.lineWidth=1; ctx.strokeStyle='rgba(0,0,0,.10)';
  ctx.beginPath(); ctx.moveTo(pL,baseY); ctx.lineTo(pL+plotW,baseY); ctx.stroke();
  ctx.font='9px system-ui'; ctx.fillStyle='rgba(0,0,0,.40)'; ctx.textAlign='right';
  ctx.fillText('+100%',pL-3,pT+12); ctx.fillText('0%',pL-3,baseY+4); ctx.fillText('-100%',pL-3,pT+plotH+4);
  if(!rows.length) return;
  const clamp=(v)=>Math.max(-1,Math.min(1,v));
  const band=plotW/rows.length, barW=Math.max(8,band*0.55);
  rows.forEach((r,i)=>{
    const m=clamp(isFinite(r.M)?r.M:0);
    const x0=pL+i*band+(band-barW)/2, h=Math.abs(m)*(plotH/2), y0=m>=0?(baseY-h):baseY;
    ctx.fillStyle=m>=0?'rgba(16,185,129,.65)':'rgba(245,158,11,.75)';
    ctx.beginPath(); bn_rrect(ctx,x0,y0,barW,h||1,4); ctx.fill();
    if(rows.length<=12||i%2===0){
      const lab=String(r.Mes||'').replace(/^\s*\d{1,2}\s*[.\-\/]\s*/,'').slice(0,10);
      ctx.font='9px system-ui'; ctx.fillStyle='rgba(0,0,0,.50)'; ctx.textAlign='center';
      ctx.fillText(lab,pL+i*band+band/2,pT+plotH+18);
    }
  });
  const showAt=(cx,cy)=>{
    const rect=host.getBoundingClientRect(), px=cx-rect.left-pL;
    const idx=Math.max(0,Math.min(rows.length-1,Math.floor(px/band)));
    const r=rows[idx];
    if(tip&&r){ tip.innerHTML=`<div class="bn-tip-title">${esc(r.Mes)}</div><div>Margen: <b>${isFinite(r.M)?bn_fmtPct(r.M):'—'}</b></div><div>Ingresos: <b>${bn_fmt$(r.I)}</b></div><div>Egresos: <b>${bn_fmt$(r.E)}</b></div><div>Utilidad: <b>${bn_fmt$(r.U)}</b></div>`; tip.style.display='block'; const bx=Math.min(Math.max(8,cx-rect.left+12),rect.width-200),by=Math.min(Math.max(8,cy-rect.top-10),rect.height-120); tip.style.left=bx+'px'; tip.style.top=by+'px'; }
  };
  const hide=()=>{ if(tip) tip.style.display='none'; };
  host.onmousemove=(ev)=>showAt(ev.clientX,ev.clientY);
  host.onmouseleave=hide;
  host.addEventListener('touchstart',(ev)=>{ const t=ev.touches[0]; if(t) showAt(t.clientX,t.clientY); },{passive:true});
  host.addEventListener('touchend',hide,{passive:true});
}

function bn_rrect(ctx,x,y,w,h,r) {
  const rr=Math.min(r,w/2,h/2);
  ctx.beginPath(); ctx.moveTo(x+rr,y); ctx.lineTo(x+w-rr,y); ctx.quadraticCurveTo(x+w,y,x+w,y+rr);
  ctx.lineTo(x+w,y+h-rr); ctx.quadraticCurveTo(x+w,y+h,x+w-rr,y+h);
  ctx.lineTo(x+rr,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-rr);
  ctx.lineTo(x,y+rr); ctx.quadraticCurveTo(x,y,x+rr,y); ctx.closePath();
}

// ─── Bancos: Card-based view ──────────────────────────────────────────────────
let BN_CUR_RECS  = [];
let BN_CARD_PAGE = 1;
const BN_CARD_SIZE = 25;

/** Tabla Resumen para un registro bancario. CONCEPTO es editable. */
function bn_buildBnResumenTable(r, idx) {
  // Orden y campos fijos — siempre se muestran todos, con o sin valor
  // Descripción es el único campo editable de texto libre
  const rows = [
    ['Descripción',      'DESC',    r.DESCRIPCION,                                               true ],
    ['Día',              'DÍA',     bn_formatDia(r.Día || r.Dia || '') || r.Mes || r.Año || '', false],
    ['Cuenta bancaria',  'CUENTA_B', r['Cuenta bancaria'],                                      false],
    ['Monto',            'MONTO',   r.Monto != null ? bn_fmt$(Number(r.Monto || 0)) : '',       false],
    ['Factura',          'FACTURA', r.FacturaFlag || '',                                         false],
    ['Deducible',        '_ded',    r._deducible    || '',                                       false],
    ['Reembolso',        '_reem',   r._reembolso    || '',                                       false],
    ['Reembolso a',      '_reema',  r._reembolso_a  || '',                                       false],
    ['Cuenta',           '_cuenta', r._cuenta       || '',                                       false],
    ['Subcuenta',        '_sub',    r._subcuenta     || '',                                       false],
    ['Categoría gasto',  '_cat',    r._categoria_gasto || '',                                    false],
    ['Concepto clasif.', '_con',    r._concepto     || '',                                       false],
    ['Propiedad',        '_prop',   r._propiedad    || '',                                       false],
    ['Departamento',     '_depto',  r._departamento !== undefined ? String(r._departamento) : '', false],
    ['Encargado',        '_enc',    r._encargado    || '',                                       false],
    ['Clasificado por',  '_clasif', r._clasificado_por || '',                                    false],
  ];

  return `<table>
    <thead><tr><th>Campo</th><th>Valor</th></tr></thead>
    <tbody>${rows.map(([label, field, val, editable]) => {
      const display = val != null ? String(val) : '';
      const td = editable
        ? `<td contenteditable="true" spellcheck="false" data-field="${field}"
              oninput="showTableActions('bnr',${idx})">${esc(display)}</td>`
        : `<td>${esc(display)}</td>`;
      return `<tr><td class="resumen-key">${label}</td>${td}</tr>`;
    }).join('')}</tbody>
  </table>`;
}

/** Crea el HTML de una tarjeta individual de registro bancario. */
function bn_createCard(rec, idx) {
  const montoN      = Number(rec.Monto || 0);
  const cuentaClasif = rec._cuenta || '';
  // _tipo siempre tiene un valor (cuenta clasificada o E/I por signo del monto)
  const tipoEfectivo = rec._tipo || (montoN < 0 ? 'Egresos' : montoN > 0 ? 'Ingresos' : '');
  const colorCls = CUENTA_COLOR_CLASS[tipoEfectivo] || '';
  const clsCls   = colorCls ? `classified ${colorCls}` : '';
  const tip      = bn_canon(tipoEfectivo);
  const isE      = tip.includes('egr');
  const isI      = tip.includes('ing');
  const ci       = 'bn' + idx;

  const name   = bn_norm(rec.DESCRIPCION || rec.Concepto || rec['Cuenta bancaria'] || 'Movimiento');
  const diaFmt = bn_formatDia(rec.Día || rec.Dia || '') || bn_norm(rec.Mes || rec.Año || '');
  const desc   = bn_norm(rec.DESCRIPCION || '');
  const monto  = Number(rec.Monto || 0);
  const cat    = bn_norm(rec.CATEGORIA || '');
  const con    = bn_norm(rec.CONCEPTO  || '');
  const cuenta = bn_norm(rec['Cuenta bancaria'] || '');
  const fac    = bn_norm(rec.Factura || '');
  const tipoLbl = cuentaClasif || (montoN < 0 ? 'Egreso' : montoN > 0 ? 'Ingreso' : '—');

  // Presupuesto y avance
  const tipo4bud = isE ? 'E' : 'I';
  const bud      = bn_getBud(tipo4bud, cat, con);
  const av       = bud > 0 ? monto / bud : NaN;
  const sev      = isE ? bn_sevOver(av) : bn_sevUnder(av);

  // Chips de encabezado — emoji por cuenta clasificada
  const CUENTA_EMOJI = {'Egresos':'💸','Ingresos':'💰','Activos':'📈','Pasivos':'📋','Capital':'💼'};
  const tipoEmoji  = CUENTA_EMOJI[cuentaClasif] || '🏦';
  const tipoChip   = `<span class="info-chip ${colorCls}">${tipoEmoji} ${esc(tipoLbl)}</span>`;
  const cuentaChip = cuenta ? `<span class="info-chip">🏦 ${esc(cuenta)}</span>` : '';
  const facChip    = fac
    ? `<span class="info-chip" style="color:var(--success,#16a34a)">🧾 ${esc(fac)}</span>`
    : `<span class="info-chip" style="color:var(--text-soft);font-style:italic">Sin factura</span>`;

  // Tab Clasificar
  const isClasif  = !!rec._cuenta;
  const pathParts = [rec._cuenta, rec._subcuenta, rec._categoria_gasto, rec._concepto].filter(Boolean);
  const pathText  = pathParts.join(' › ');
  const clasifColorCls = CUENTA_COLOR_CLASS[rec._cuenta] || '';
  const tabHtml = isClasif
    ? `<div class="classify-tab classified ${clasifColorCls}" id="bn-btn-classify-${idx}" onclick="bn_toggleBnClassify(${idx})">
         <span class="classify-tab-arrow" style="color:#fff">›</span>
         <span class="classify-tab-label" style="font-size:10px;text-transform:none;letter-spacing:.01em;font-weight:700;color:#fff;">${esc(pathText)}</span>
       </div>`
    : `<div class="classify-tab" id="bn-btn-classify-${idx}" onclick="bn_toggleBnClassify(${idx})">
         <span class="classify-tab-arrow">›</span>
         <span class="classify-tab-label">Clasificar</span>
       </div>`;

  const deptOptions = Array.from({length:14},(_,j)=>`<option>${j+1}</option>`).join('');

  // Mini barra de avance en encabezado
  const avPct  = isFinite(av) ? Math.min(Math.max(av, 0), 2) : 0;
  const barCls = av > 1.10 ? 'bn-bar-bad' : av > 1.0 ? 'bn-bar-warn' : 'bn-bar-good';
  const avanceHtml = `
    <div class="bn-hdr-avance">
      ${bud > 0 ? `
      <div class="bn-avance-wrap" style="min-width:90px">
        <div class="bn-avance-bar ${barCls}" style="height:5px;border-radius:3px">
          <div class="bn-avance-fill" style="width:${(avPct*100).toFixed(1)}%"></div>
          <div class="bn-avance-marker"></div>
        </div>
        <span class="bn-avance-pct" style="font-size:10px">${isFinite(av) ? bn_fmtPct(av) : '—'} presup.</span>
      </div>
      <div class="bn-hdr-presup">${bn_fmt$(bud)}</div>` : ''}
      <span class="${sev.cls}" style="font-size:10px;padding:2px 7px">${sev.label}</span>
    </div>`;

  return `
    <div class="ticket-card" id="bn-card-${idx}">
      <div class="ticket-card-header ${clsCls}" id="bn-hdr-${idx}" onclick="bn_toggleBnCard(${idx})">
        <div class="ticket-info">
          <div class="header-chips">${tipoChip}${cuentaChip}${facChip}</div>
          <div class="ticket-store-row">
            <span class="ticket-store ${colorCls}">${esc(name)}</span>
          </div>
          <div class="ticket-meta">${esc(diaFmt)}</div>
          ${desc ? `<div class="product-summary">${esc(desc.length > 120 ? desc.slice(0, 117) + '…' : desc)}</div>` : ''}
        </div>
        <div class="ticket-header-right">
          <div class="ticket-total-badge ${clsCls}">
            <span class="total-main">${bn_fmt$(monto)}</span>
          </div>
          ${avanceHtml}
        </div>
      </div>

      <div class="ticket-table-wrap hidden" id="bn-tbl-${idx}" data-tidx="${idx}" data-tmod="bnr">
        <div class="ticket-tabs">
          <button class="ticket-tab active" onclick="bn_showBnTab(${idx},'resumen',this)">Resumen</button>
        </div>
        <div id="bn-tab-resumen-${idx}" class="ticket-tab-content">${bn_buildBnResumenTable(rec, idx)}</div>
        <div class="table-actions-bar hidden" id="tact-bnr-${idx}">
          <button class="btn-clasificar-ticket" style="padding:10px 28px;font-size:13px"
                  onclick="bn_saveBnResumenEdit(${idx})">💾 Guardar cambios</button>
          <button class="btn-limpiar-ticket" onclick="bn_resetBnResumenEdit(${idx})">Limpiar</button>
        </div>
      </div>

      ${tabHtml}
      ${buildClassifyPanel(ci, bn_norm(rec.Día || rec.Dia || rec.Mes || ''), deptOptions,
          isClasif ? '💾 Guardar cambios' : '✓ Clasificar',
          `bn_saveBnClassification(${idx})`,
          `bn_limpiarBnClassification(${idx})`,
          'Fecha del registro')}
    </div>`;
}

function bn_toggleBnCard(idx) {
  const wrap   = document.getElementById(`bn-tbl-${idx}`);
  const header = document.getElementById(`bn-hdr-${idx}`);
  if (!wrap) return;
  const hidden = wrap.classList.toggle('hidden');
  header.classList.toggle('collapsed', hidden);
}

function bn_showBnTab(idx, tab, btn) {
  ['resumen'].forEach(t =>
    document.getElementById(`bn-tab-${t}-${idx}`)?.classList.toggle('hidden', t !== tab)
  );
  btn.closest('.ticket-tabs').querySelectorAll('.ticket-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function bn_toggleBnClassify(idx) {
  const ci    = 'bn' + idx;
  const panel = document.getElementById(`classify-${ci}`);
  const tab   = document.getElementById(`bn-btn-classify-${idx}`);
  if (!panel) return;
  const isHidden = panel.classList.toggle('hidden');
  tab?.classList.toggle('open', !isHidden);
  if (!isHidden) {
    bn_activateCatalog();

    // ── Renderizar tarjetas de Cuenta dinámicamente desde BN_CATALOG ──────
    // (no hardcoded — toma los valores reales de Presupuesto_sys)
    const cuentaGrid = document.getElementById(`cuenta-grid-${ci}`);
    if (cuentaGrid) {
      const CUENTA_ICONS = { Egresos:'💸', Ingresos:'💰', Pasivos:'📋', Activos:'📈', Capital:'💼' };
      const CUENTA_SUBS  = { Egresos:'Gastos y pagos', Ingresos:'Cobros y entradas',
                             Pasivos:'Obligaciones',   Activos:'Inversión / CAPEX',  Capital:'Utilidad / Familiar' };
      const cuentas = Object.keys(BN_CATALOG);
      cuentaGrid.innerHTML = [
        `<div class="cuenta-card" data-value="" onclick="selectCuenta(this,'${ci}')">` +
          `<div class="cuenta-icon">🏠</div><div class="cuenta-label">Sin cuenta</div>` +
          `<div class="cuenta-sub">General</div></div>`,
        ...cuentas.map(c =>
          `<div class="cuenta-card" data-value="${esc(c)}" onclick="selectCuenta(this,'${ci}')">` +
          `<div class="cuenta-icon">${CUENTA_ICONS[c] || '📁'}</div>` +
          `<div class="cuenta-label">${esc(c)}</div>` +
          (CUENTA_SUBS[c] ? `<div class="cuenta-sub">${CUENTA_SUBS[c]}</div>` : '') +
          `</div>`)
      ].join('');
    }

    const rec = BN_CUR_RECS[idx];
    bn_autoPopulateBnClassify(ci, rec);
    // Pre-seleccionar Cuenta por tipo o signo de monto si aún no está clasificado
    if (rec && !rec._cuenta) {
      const tip = bn_canon(rec.CUENTA || rec.TIPO || '');
      const mN  = Number(rec.Monto || 0);
      const autoAcc = tip.includes('egr') ? 'Egresos'
                    : tip.includes('ing') ? 'Ingresos'
                    : mN < 0 ? 'Egresos' : 'Ingresos';
      const grid = document.getElementById(`cuenta-grid-${ci}`);
      const card = Array.from(grid?.querySelectorAll('.cuenta-card') || [])
        .find(c => c.dataset.value === autoAcc);
      if (card) selectCuenta(card, ci);
    }
  }
}

/** Guarda las ediciones del campo Concepto de la tabla Resumen en memoria. */
function bn_saveBnResumenEdit(idx) {
  const rec = BN_CUR_RECS[idx];
  if (!rec) return;
  const tabEl = document.getElementById(`bn-tab-resumen-${idx}`);
  const concepEl = tabEl?.querySelector('[data-field="CONCEPTO"]');
  if (concepEl) rec.CONCEPTO = concepEl.textContent.trim();
  hideTableActions('bnr', idx);
  // Re-render para reflejar el nuevo concepto en el encabezado
  const card = document.getElementById(`bn-card-${idx}`);
  if (card) {
    card.outerHTML = bn_createCard(rec, idx);
    // Re-abrir la sección de detalles
    document.getElementById(`bn-tbl-${idx}`)?.classList.remove('hidden');
  }
}

/** Revierte las ediciones sin guardar del Concepto. */
function bn_resetBnResumenEdit(idx) {
  const rec = BN_CUR_RECS[idx];
  if (!rec) return;
  const tabEl = document.getElementById(`bn-tab-resumen-${idx}`);
  const concepEl = tabEl?.querySelector('[data-field="CONCEPTO"]');
  if (concepEl) concepEl.textContent = rec.CONCEPTO || '';
  hideTableActions('bnr', idx);
}

/** Rellena el panel Clasificar con los datos guardados del registro. */
function bn_autoPopulateBnClassify(ci, rec) {
  if (!rec) return;
  classifyAutoPopulating = true;

  const cuentaVal = rec._cuenta || '';
  if (cuentaVal) {
    const grid = document.getElementById(`cuenta-grid-${ci}`);
    const card = Array.from(grid?.querySelectorAll('.cuenta-card') || [])
      .find(c => c.dataset.value === cuentaVal);
    if (card) {
      selectCuenta(card, ci);
      const subVal = rec._subcuenta || '';
      if (subVal) {
        const subCard = Array.from(document.getElementById(`subcuenta-grid-${ci}`)?.querySelectorAll('.cuenta-card') || [])
          .find(c => c.dataset.value === subVal);
        if (subCard) {
          selectSubcuenta(subCard, ci);
          const catVal = rec._categoria_gasto || '';
          if (catVal) {
            const catCard = Array.from(document.getElementById(`categoria-grid-${ci}`)?.querySelectorAll('.cuenta-card') || [])
              .find(c => c.dataset.value === catVal);
            if (catCard) {
              selectCategoria(catCard, ci);
              const conVal = rec._concepto || '';
              if (conVal) {
                const conCard = Array.from(document.getElementById(`concepto-grid-${ci}`)?.querySelectorAll('.cuenta-card') || [])
                  .find(c => c.dataset.value === conVal);
                if (conCard) selectConcepto(conCard, ci);
              }
            }
          }
        }
      }
    }
  }

  // Propiedad
  const propSel = document.getElementById(`propiedad-${ci}`);
  if (propSel && rec._propiedad) {
    const exists = Array.from(propSel.options).some(o => o.value === rec._propiedad);
    if (exists) propSel.value = rec._propiedad;
    else { propSel.value = 'Otro'; togglePropiedadOtro(ci, 'Otro');
      const oEl = document.getElementById(`propiedad-otro-${ci}`); if (oEl) oEl.value = rec._propiedad; }
  }

  // Departamento
  const dEl = document.getElementById(`departamento-${ci}`);
  if (dEl && rec._departamento) dEl.value = rec._departamento;

  // Encargado (comprador)
  if (rec._encargado) {
    const compGrid = document.getElementById(`comprador-grid-${ci}`);
    const compCard = Array.from(compGrid?.querySelectorAll('.cuenta-card') || [])
      .find(c => c.dataset.value === rec._encargado);
    if (compCard) selectComprador(compCard, ci);
  }

  // Deducible
  const dedEl = document.getElementById(`deducible-${ci}`);
  const dedChecked = rec._deducible === 'Sí';
  if (dedEl) { dedEl.checked = dedChecked; updateDeducibleLabel(ci, dedChecked); }

  // Reembolso
  if (rec._reembolso === 'Sí') {
    const reemEl = document.getElementById(`reembolso-${ci}`);
    if (reemEl) { reemEl.checked = true; toggleReembolso(ci, true); }
    if (rec._reembolso_a) {
      const reemSel = document.getElementById(`reembolso-a-${ci}`);
      if (reemSel) {
        const exists = Array.from(reemSel.options).some(o => o.value === rec._reembolso_a);
        if (exists) reemSel.value = rec._reembolso_a;
        else { reemSel.value = 'Otro'; toggleReembolsoOtro(ci, 'Otro');
          const oEl = document.getElementById(`reembolso-otro-${ci}`); if (oEl) oEl.value = rec._reembolso_a; }
      }
    }
  }

  // Método de pago
  if (rec._metodo_pago) {
    const metGrid = document.getElementById(`metodo-grid-${ci}`);
    const metCard = Array.from(metGrid?.querySelectorAll('.cuenta-card') || [])
      .find(c => c.dataset.value === rec._metodo_pago);
    if (metCard) selectMetodoPago(metCard, ci);
  }

  updateClasiPath(ci);
  classifyAutoPopulating = false;
}

/** Guarda la clasificación del panel en el registro en memoria y en el backend. */
async function bn_saveBnClassification(idx) {
  const rec = BN_CUR_RECS[idx];
  if (!rec) return;
  if (!rec.rowNum) {
    alert(`Error: el registro no tiene número de fila (rowNum=${rec.rowNum}).\nPor favor recarga los datos con el botón ↺ y vuelve a intentarlo.`);
    return;
  }
  const ci = 'bn' + idx;
  const c  = getClassify(ci);

  rec._cuenta          = c.cuenta;
  rec._subcuenta       = c.subcuenta;
  rec._categoria_gasto = c.categoria;
  rec._concepto        = c.concepto;
  rec._propiedad       = c.propiedad;
  rec._departamento    = c.departamento;
  rec._encargado       = c.comprador;
  rec._deducible       = c.deducible  ? 'Sí' : 'No';
  rec._reembolso       = c.reembolso  ? 'Sí' : 'No';
  rec._reembolso_a     = c.reembolso_a;
  rec._metodo_pago     = c.metodo_pago_clasif;
  rec._clasificado_por = currentUser || '';
  // Sincronizar campos raw y _tipo para que filtros y colores sean correctos
  rec.CUENTA    = c.cuenta;
  rec.SUBCUENTA = c.subcuenta;
  rec.CATEGORIA = c.categoria;
  rec.CONCEPTO  = c.concepto;
  const monto   = Number(rec.Monto) || 0;
  const _rawT2  = rec._cuenta || rec.TIPO || (monto < 0 ? 'Egresos' : monto > 0 ? 'Ingresos' : '');
  const _ct2    = bn_canon(_rawT2);
  rec._tipo     = _ct2.includes('egr') ? 'Egresos' : _ct2.includes('ing') ? 'Ingresos' :
                  _ct2.includes('activ') ? 'Activos' : _ct2.includes('pasiv') ? 'Pasivos' :
                  _ct2.includes('capital') ? 'Capital' : _rawT2;

  // Re-render tarjeta en el DOM (el panel queda contraído por defecto)
  const card = document.getElementById(`bn-card-${idx}`);
  if (card) card.outerHTML = bn_createCard(rec, idx);

  // Guardar clasificación en Google Sheets (hoja BANCOS)
  try {
    showLoading('Guardando clasificación…', 'Actualizando registro en Sheets…');
    const resp = await fetch(`${BACKEND}/save-banco-clasificacion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rowNum:          rec.rowNum,
        mes:             bn_norm(rec.Mes),
        cuenta_bancaria: bn_norm(rec['Cuenta bancaria'] || ''),
        cuenta:          bn_norm(rec.CUENTA     || ''),
        subcuenta:       bn_norm(rec.SUBCUENTA  || ''),
        categoria:       bn_norm(rec.CATEGORIA  || ''),
        concepto:        bn_norm(rec.CONCEPTO   || ''),
        descripcion:     bn_norm(rec.DESCRIPCION|| ''),
        monto:           Number(rec.Monto || 0),
        clasificacion: {
          cuenta:          c.cuenta,
          subcuenta:       c.subcuenta,
          categoria_gasto: c.categoria,
          concepto:        c.concepto,
          propiedad:       c.propiedad,
          departamento:    c.departamento,
          encargado:       c.comprador,
          deducible:       c.deducible ? 'Sí' : 'No',
          reembolso:       c.reembolso ? 'Sí' : 'No',
          reembolso_a:     c.reembolso_a,
          metodo_pago:     c.metodo_pago_clasif,
          clasificado_por: currentUser || '',
        }
      }),
    });
    const result = await resp.json();
    if (!result.ok) throw new Error(result.error || 'Error desconocido');
  } catch(e) {
    console.warn('Error guardando clasificación en Sheets:', e.message);
    alert('Error al guardar clasificación: ' + e.message);
  } finally {
    hideLoading();
  }
}

/** Limpia la clasificación del registro y re-renderiza la tarjeta. */
function bn_limpiarBnClassification(idx) {
  const rec = BN_CUR_RECS[idx];
  if (!rec) return;
  ['_cuenta','_subcuenta','_categoria_gasto','_concepto','_propiedad',
   '_departamento','_encargado','_deducible','_reembolso','_reembolso_a',
   '_metodo_pago','_clasificado_por'].forEach(k => delete rec[k]);
  const card = document.getElementById(`bn-card-${idx}`);
  if (card) card.outerHTML = bn_createCard(rec, idx);
}

/** Renderiza las tarjetas de la página actual. */
function bn_renderCards() {
  const container = document.getElementById('bn-cards-container');
  const pagEl     = document.getElementById('bn-card-pagination');
  if (!container) return;

  const recs  = BN_CUR_RECS;
  const total = recs.length;

  if (!total) {
    container.innerHTML = `<div class="empty-state" style="padding:50px 20px">
      <div class="empty-icon">📭</div>
      <p style="color:var(--text-soft);margin:0">Sin movimientos para los filtros seleccionados</p>
    </div>`;
    if (pagEl) pagEl.innerHTML = '';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(total / BN_CARD_SIZE));
  BN_CARD_PAGE     = Math.min(BN_CARD_PAGE, totalPages);
  const start      = (BN_CARD_PAGE - 1) * BN_CARD_SIZE;
  const pageRecs   = recs.slice(start, start + BN_CARD_SIZE);

  container.innerHTML = pageRecs.map((rec, j) => bn_createCard(rec, start + j)).join('');

  // Paginación
  if (!pagEl) return;
  if (totalPages <= 1) { pagEl.innerHTML = ''; return; }
  let btns = '';
  for (let p = Math.max(1, BN_CARD_PAGE - 2); p <= Math.min(totalPages, BN_CARD_PAGE + 2); p++) {
    btns += `<button class="pag-btn${p === BN_CARD_PAGE ? ' active' : ''}" onclick="bn_goToCardPage(${p})">${p}</button>`;
  }
  pagEl.innerHTML = `
    <div class="pagination-row" style="margin:12px 0 24px">
      <button class="pag-btn" onclick="bn_goToCardPage(${BN_CARD_PAGE - 1})" ${BN_CARD_PAGE <= 1 ? 'disabled' : ''}>‹</button>
      ${btns}
      <button class="pag-btn" onclick="bn_goToCardPage(${BN_CARD_PAGE + 1})" ${BN_CARD_PAGE >= totalPages ? 'disabled' : ''}>›</button>
      <span style="color:var(--text-soft);font-size:12px;margin-left:10px">
        ${total.toLocaleString('es-MX')} movimientos · Pág. ${BN_CARD_PAGE}/${totalPages}
      </span>
    </div>`;
}

function bn_goToCardPage(p) {
  const totalPages = Math.max(1, Math.ceil(BN_CUR_RECS.length / BN_CARD_SIZE));
  BN_CARD_PAGE = Math.max(1, Math.min(p, totalPages));
  bn_renderCards();
  document.getElementById('bn-cards-container')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── Auto-load when switching to Registros contables ─────────────────────────
(function(){
  const _orig=window.switchModule;
  window.switchModule=function(mod){
    if (mod !== 'registros') bn_deactivateCatalog(); // restaurar catálogo de tickets
    _orig(mod);
    if (mod === 'registros') {
      if (!BN_LOADED) bn_loadData();
      else bn_activateCatalog(); // ya cargado: reactivar catálogo Bancos
    }
  };
})();

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

// Desplaza el card seleccionado al borde izquierdo del carrusel
function scrollCardIntoView(el) {
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
}

// ─── Cuenta / Subcuenta / Categoría / Concepto (cascading cards) ───────────

const FACTURABLE_CUENTAS = new Set(["", "Egresos", "Activos", "Pasivos"]);

function selectCuenta(el, i) {
  el.closest(".cuenta-grid").querySelectorAll(".cuenta-card").forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  scrollCardIntoView(el);
  const cuenta = el.dataset.value;
  document.getElementById(`cuenta-${i}`).value = cuenta;
  resetSubcuenta(i);

  const deducibleField = document.getElementById(`deducible-field-${i}`);
  if (deducibleField) deducibleField.classList.toggle("hidden", !FACTURABLE_CUENTAS.has(cuenta));

  const subs = cuenta && CATALOG[cuenta] ? Object.keys(CATALOG[cuenta]) : [];
  if (!subs.length) return;

  document.getElementById(`subcuenta-grid-${i}`).innerHTML =
    subs.map(n => makeCard(n, SUBCUENTA_EMOJIS[n] || "📌", `selectSubcuenta(this,'${i}')`)).join("");
  document.getElementById(`subcuenta-field-${i}`).classList.remove("hidden");
  updateClasiPath(i);
  markClassifyDirty(i);
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
  scrollCardIntoView(el);
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
      cats.map(n => makeCard(n, CATEGORIA_EMOJIS[n] || "📂", `selectCategoria(this,'${i}')`)).join("");
    document.getElementById(`categoria-field-${i}`).classList.remove("hidden");
  }
  updateClasiPath(i);
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
    conceptos.map(n => makeCard(n, CONCEPTO_EMOJIS[n] || "🔹", `selectConcepto(this,'${i}')`)).join("");
  document.getElementById(`concepto-field-${i}`).classList.remove("hidden");
}

function selectConcepto(el, i) {
  el.closest(".cuenta-grid").querySelectorAll(".cuenta-card").forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  scrollCardIntoView(el);
  document.getElementById(`concepto-${i}`).value = el.dataset.value;
  updateClasiPath(i);
  markClassifyDirty(i);
}

function selectCategoria(el, i) {
  el.closest(".cuenta-grid").querySelectorAll(".cuenta-card").forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  scrollCardIntoView(el);
  const categoria = el.dataset.value;
  document.getElementById(`categoria-${i}`).value = categoria;
  resetConcepto(i);

  const cuenta    = document.getElementById(`cuenta-${i}`).value;
  const subcuenta = document.getElementById(`subcuenta-${i}`).value;
  const conceptos = CATALOG[cuenta]?.[subcuenta]?.[categoria] || [];
  if (conceptos.length) renderConceptos(conceptos, i);
  updateClasiPath(i);
  markClassifyDirty(i);
}

function selectMetodoPago(el, i) {
  el.closest(".cuenta-grid").querySelectorAll(".cuenta-card").forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  scrollCardIntoView(el);
  document.getElementById(`metodo-clasif-${i}`).value = el.dataset.value;
  markClassifyDirty(i);
}

function toggleReembolso(i, checked) {
  const field = document.getElementById(`reembolso-a-field-${i}`);
  const label = document.getElementById(`reembolso-label-${i}`);
  field.classList.toggle("hidden", !checked);
  label.textContent = checked ? "Sí" : "No";
  label.classList.toggle("on", checked);
  if (checked) {
    const encargado = document.getElementById(`comprador-${i}`)?.value || "";
    const sel = document.getElementById(`reembolso-a-${i}`);
    if (sel && encargado) sel.value = encargado;
  }
}

function togglePropiedadOtro(i, value) {
  const wrap = document.getElementById(`propiedad-otro-wrap-${i}`);
  if (!wrap) return;
  wrap.classList.toggle("hidden", value !== "Otro");
  if (value !== "Otro") document.getElementById(`propiedad-otro-${i}`).value = "";
}

function toggleReembolsoOtro(i, value) {
  const wrap = document.getElementById(`reembolso-otro-wrap-${i}`);
  if (!wrap) return;
  wrap.classList.toggle("hidden", value !== "Otro");
  if (value !== "Otro") document.getElementById(`reembolso-otro-${i}`).value = "";
}

function selectComprador(el, i) {
  el.closest(".cuenta-grid").querySelectorAll(".cuenta-card").forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  scrollCardIntoView(el);
  document.getElementById(`comprador-${i}`).value = el.dataset.value;
  markClassifyDirty(i);
}

// Llamado desde el toggle dentro del panel "Clasificar"
function updateDeducibleLabel(i, checked) {
  const lbl = document.getElementById(`deducible-label-${i}`);
  if (lbl) { lbl.textContent = checked ? "Sí" : "No"; lbl.classList.toggle("on", checked); }
  // Sincronizar el toggle del encabezado (mantiene texto "Deducible"/"No deducible")
  const hCheck = document.getElementById(`deducible-header-${i}`);
  if (hCheck) hCheck.checked = checked;
  const hLbl = document.getElementById(`fhl-${i}`);
  if (hLbl) { hLbl.textContent = checked ? "Deducible" : "No deducible"; hLbl.classList.toggle("on", checked); }
}

// Llamado desde el toggle del encabezado
function syncDeducible(i, checked) {
  const inner = document.getElementById(`deducible-${i}`);
  if (inner) inner.checked = checked;
  updateDeducibleLabel(i, checked);
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
    return `<div class="search-result-item" onmousedown="applySearchResult('${i}',${idx})">${html}</div>`;
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

  // Actualizar texto de ruta de clasificación bajo la barra de búsqueda
  updateClasiPath(i);

  // Limpiar buscador
  document.getElementById(`search-${i}`).value = "";
  hideSearchResults(i);
  markClassifyDirty(i);
}

// ─── Get classification values ──────────────────────────────────────────────

function getClassify(i) {
  return {
    fecha:             document.getElementById(`fecha-clasif-${i}`)?.value   || "",
    cuenta:            document.getElementById(`cuenta-${i}`)?.value         || "",
    subcuenta:         document.getElementById(`subcuenta-${i}`)?.value      || "",
    categoria:         document.getElementById(`categoria-${i}`)?.value      || "",
    concepto:          document.getElementById(`concepto-${i}`)?.value       || "",
    propiedad:         (() => {
      const sel = document.getElementById(`propiedad-${i}`);
      if (!sel) return "";
      if (sel.value === "Otro") return document.getElementById(`propiedad-otro-${i}`)?.value?.trim() || "Otro";
      return sel.value;
    })(),
    departamento:      document.getElementById(`departamento-${i}`)?.value   || "",
    comprador:         document.getElementById(`comprador-${i}`)?.value      || "",
    deducible:         document.getElementById(`deducible-${i}`)?.checked    || false,
    reembolso:         document.getElementById(`reembolso-${i}`)?.checked    || false,
    reembolso_a:       (() => {
      const sel = document.getElementById(`reembolso-a-${i}`);
      if (!sel) return "";
      if (sel.value === "Otro") return document.getElementById(`reembolso-otro-${i}`)?.value?.trim() || "Otro";
      return sel.value;
    })(),
    metodo_pago_clasif:document.getElementById(`metodo-clasif-${i}`)?.value  || "",
    detalles_operacion:document.getElementById(`detalles-${i}`)?.value?.trim()|| "",
    comentarios:       document.getElementById(`comentarios-${i}`)?.value?.trim() || "",
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

// ─── Formato de hora ───────────────────────────────────────────────────────

/** Convierte valores de Sheets (1899-12-30...) a HH:mm legible */
function formatHora(val) {
  if (!val) return "";
  const s = String(val).trim();
  // Fecha-tiempo 1899-12-30T16:30... → extraer sólo la hora
  const dtMatch = s.match(/^1899-12-30[T ](\d{2}:\d{2})/);
  if (dtMatch) return dtMatch[1];
  // Fecha sin tiempo 1899-12-30 → dato perdido, mostrar vacío
  if (/^1899-12-30/.test(s)) return "";
  // Cualquier ISO con T → extraer hora
  const isoMatch = s.match(/T(\d{2}:\d{2})/);
  if (isoMatch) return isoMatch[1];
  return s; // ya es HH:mm u otro formato legible
}

// ─── Leer ediciones de tablas desde el DOM ─────────────────────────────────

/**
 * Lee el estado actual de la tabla de productos desde el DOM.
 * Maneja filas editadas, eliminadas y nuevas.
 * Devuelve array de objetos producto listos para guardar.
 */
function readAllProductsFromDOM(selector, originalProds, ticketId) {
  const tbody = document.querySelector(`${selector} tbody`);
  if (!tbody) return (originalProds || []);
  return [...tbody.querySelectorAll("tr")].map((tr, domIdx) => {
    const origIdx = parseInt(tr.dataset.row ?? "", 10);
    const orig    = isNaN(origIdx) ? {} : ((originalProds || [])[origIdx] || {});
    const fields  = {};
    tr.querySelectorAll("td[data-field]").forEach(td => {
      fields[td.dataset.field] = td.innerText.trim();
    });
    // Ignorar filas completamente vacías (nuevas sin datos)
    if (!orig.descripcion && !fields.descripcion && !fields.monto) return null;
    return {
      ticket_id:               orig.ticket_id    || ticketId || "",
      linea_numero:            domIdx + 1,
      descripcion:             fields.descripcion             ?? orig.descripcion             ?? "",
      cantidad:                numEdit(fields.cantidad,        orig.cantidad),
      precio_unitario:         numEdit(fields.precio_unitario, orig.precio_unitario),
      monto:                   numEdit(fields.monto,           orig.monto),
      categoria_operativa:     fields.categoria_operativa     ?? orig.categoria_operativa     ?? "",
      deducible_sugerido:      fields.deducible_sugerido      ?? orig.deducible_sugerido      ?? "",
      confianza_clasificacion: fields.confianza_clasificacion ?? orig.confianza_clasificacion ?? "",
    };
  }).filter(Boolean);
}

/** Devuelve {field: value} de las filas editables de la tabla de resumen/cruce */
function readResumenEditsFromDOM(selector) {
  const tbody = document.querySelector(`${selector} tbody`);
  if (!tbody) return {};
  const obj = {};
  tbody.querySelectorAll("tr[data-field]").forEach(tr => {
    const td = tr.querySelector("td[contenteditable]");
    if (td) obj[tr.dataset.field] = td.innerText.trim();
  });
  return obj;
}

// ─── Agregar / eliminar renglones en tabla Transcripción ──────────────────

function addAnalysisProductRow(i) {
  addProductRowToTable(`#tab-transcripcion-${i}`, true);
}
function addDashboardProductRow(i) {
  addProductRowToTable(`#db-tab-transcripcion-${i}`, false);
}

function addProductRowToTable(selector, isAnalysis) {
  const tbody = document.querySelector(`${selector} tbody`);
  if (!tbody) return;
  const rowIdx = tbody.querySelectorAll("tr").length;
  const editCols = isAnalysis
    ? ["descripcion","cantidad","precio_unitario","monto","categoria_operativa","deducible_sugerido","confianza_clasificacion"]
    : ["descripcion","cantidad","precio_unitario","monto"];
  const tr = document.createElement("tr");
  tr.dataset.row = "new";
  let html = isAnalysis ? `<td style="background:#f1f5f9;color:#94a3b8">${rowIdx + 1}</td>` : "";
  html += editCols.map(k =>
    `<td contenteditable="true" spellcheck="false" data-field="${k}" oninput="onTableCellInput(this)"></td>`
  ).join("");
  html += `<td class="btn-del-cell"><button class="btn-del-row" onclick="deleteProductRow(this)" title="Eliminar fila">✕</button></td>`;
  tr.innerHTML = html;
  tbody.appendChild(tr);
  tr.querySelector("[contenteditable]")?.focus();
  // Marcar dirty
  const wrap = tbody.closest(".ticket-table-wrap");
  if (wrap) showTableActions(wrap.dataset.tmod, parseInt(wrap.dataset.tidx));
}

function deleteProductRow(btn) {
  const wrap = btn.closest(".ticket-table-wrap");
  btn.closest("tr")?.remove();
  if (wrap) showTableActions(wrap.dataset.tmod, parseInt(wrap.dataset.tidx));
}

// ─── Custom confirm dialog ─────────────────────────────────────────────────

function showConfirm({ icon = "🗑", title, msg, okLabel = "Eliminar" }) {
  return new Promise(resolve => {
    document.getElementById("confirmModalIcon").textContent  = icon;
    document.getElementById("confirmModalTitle").textContent = title;
    document.getElementById("confirmModalMsg").textContent   = msg;
    document.getElementById("confirmModalOk").textContent    = okLabel;
    document.getElementById("confirmModal").classList.remove("hidden");

    const ok = document.getElementById("confirmModalOk");
    const cancel = document.getElementById("confirmModalCancel");
    const close = result => {
      document.getElementById("confirmModal").classList.add("hidden");
      ok.onclick = cancel.onclick = null;
      resolve(result);
    };
    ok.onclick     = () => close(true);
    cancel.onclick = () => close(false);
  });
}
function confirmModalOverlayClick(e) {
  if (e.target === e.currentTarget) {
    document.getElementById("confirmModal").classList.add("hidden");
  }
}

// ─── Classify dirty tracking ───────────────────────────────────────────────

function markClassifyDirty(idx) {
  if (classifyAutoPopulating) return;
  document.getElementById(`classify-actions-${idx}`)?.classList.remove("hidden");
}
function hideClassifyActions(idx) {
  document.getElementById(`classify-actions-${idx}`)?.classList.add("hidden");
}

// ─── Dirty tracking de tablas ──────────────────────────────────────────────

/** Llamado por oninput en cualquier celda editable de una tabla */
function onTableCellInput(cell) {
  const wrap = cell.closest(".ticket-table-wrap");
  if (!wrap) return;
  showTableActions(wrap.dataset.tmod, parseInt(wrap.dataset.tidx));
}

function showTableActions(mod, i) {
  document.getElementById(`tact-${mod}-${i}`)?.classList.remove("hidden");
}
function hideTableActions(mod, i) {
  document.getElementById(`tact-${mod}-${i}`)?.classList.add("hidden");
}

// ── Análisis: guardar cambios de tabla en memoria (sin llamada al backend) ──
function saveTableChanges(i) {
  const ticket = ticketResults[i];
  if (!ticket) return;
  const prodsFinal = readAllProductsFromDOM(`#tab-transcripcion-${i}`, ticket.productos, ticket.resumen.ticket_id);
  ticket.productos = prodsFinal;
  const resEdits = readResumenEditsFromDOM(`#tab-resumen-${i}`);
  Object.assign(ticket.resumen, resEdits);
  hideTableActions("analysis", i);
}

// ── Análisis: revertir tablas al estado en memoria ──────────────────────────
function resetTableChanges(i) {
  const ticket = ticketResults[i];
  if (!ticket) return;
  const tDiv = document.getElementById(`tab-transcripcion-${i}`);
  if (tDiv) tDiv.innerHTML = buildProductTable(ticket.productos) +
    `<button class="btn-add-row" onclick="addAnalysisProductRow(${i})">＋ Agregar producto</button>`;
  const rDiv = document.getElementById(`tab-resumen-${i}`);
  if (rDiv) rDiv.innerHTML = buildResumenTable(ticket.resumen);
  const cDiv = document.getElementById(`tab-cruce-${i}`);
  if (cDiv) cDiv.innerHTML = buildCruceTable(ticket.cruce);
  hideTableActions("analysis", i);
}

// ── Dashboard: guardar cambios de tabla en Sheets ───────────────────────────
async function saveDbTableChanges(i) {
  const ticket = dashboardFiltered[i];
  if (!ticket) return;
  const r = ticket.resumen || {};

  const resEdits = readResumenEditsFromDOM(`#db-tab-resumen-${i}`);
  const productosEditados = readAllProductsFromDOM(
    `#db-tab-transcripcion-${i}`, ticket.productos, ticket.ticket_id
  ).map(p => ({
    linea_numero:    p.linea_numero,
    descripcion:     p.descripcion,
    cantidad:        p.cantidad,
    precio_unitario: p.precio_unitario,
    monto:           p.monto,
  }));

  // Preservar clasificación existente en memoria, solo sobreescribir campos de tabla
  const clasificacion = {
    fecha:              r.fecha              || "",
    cuenta:             r.cuenta             || "",
    subcuenta:          r.subcuenta          || "",
    categoria_gasto:    r.categoria_gasto    || "",
    concepto:           r.concepto           || "",
    propiedad:          r.propiedad          || "",
    departamento:       r.departamento       || "",
    comprador:          r.comprador          || "",
    deducible:          r.deducible          || "No",
    reembolso:          r.reembolso          || "No",
    reembolso_a:        r.reembolso_a        || "",
    metodo_pago:        r.metodo_pago        || "",
    detalles_operacion: r.detalles_operacion || "",
    comentarios:        r.comentarios        || "",
    clasificado_por:    currentUser,
    tienda:           resEdits.tienda           ?? r.tienda           ?? "",
    rfc:              resEdits.rfc              ?? r.rfc              ?? "",
    hora:             resEdits.hora             ?? r.hora             ?? "",
    folio:            resEdits.folio            ?? r.folio            ?? "",
    tarjeta_ultimos4: resEdits.tarjeta_ultimos4 ?? r.tarjeta_ultimos4 ?? "",
    subtotal:  numEdit(resEdits.subtotal,   r.subtotal   ?? 0),
    iva:       numEdit(resEdits.iva,        r.iva        ?? 0),
    ieps:      numEdit(resEdits.ieps,       r.ieps       ?? 0),
    descuentos:numEdit(resEdits.descuentos, r.descuentos ?? 0),
    total:     numEdit(resEdits.total,      r.total      ?? 0),
  };

  try {
    showLoading("Guardando cambios…", "Actualizando tablas en Sheets…");
    const res  = await fetch(`${BACKEND}/update-ticket`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ ticket_id: ticket.ticket_id, clasificacion, productos_editados: productosEditados }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Error al guardar");
    Object.assign(ticket.resumen, clasificacion);
    ticket.productos = productosEditados;
    hideTableActions("db", i);
  } catch (err) {
    alert("Error al guardar: " + err.message);
  } finally {
    hideLoading();
  }
}

// ── Dashboard: revertir tablas al estado en memoria ─────────────────────────
function resetDbTableChanges(i) {
  const ticket = dashboardFiltered[i];
  if (!ticket) return;
  const tDiv = document.getElementById(`db-tab-transcripcion-${i}`);
  if (tDiv) tDiv.innerHTML = buildDashboardProductTable(ticket.productos || []) +
    `<button class="btn-add-row" onclick="addDashboardProductRow(${i})">＋ Agregar producto</button>`;
  const rDiv = document.getElementById(`db-tab-resumen-${i}`);
  if (rDiv) rDiv.innerHTML = buildResumenTable(ticket.resumen);
  const cDiv = document.getElementById(`db-tab-cruce-${i}`);
  if (cDiv) cDiv.innerHTML = buildDashboardCruceTable(ticket);
  hideTableActions("db", i);
}

/** Convierte un valor editado a número; si falla devuelve el fallback */
function numEdit(val, fallback) {
  if (val === undefined || val === "") return fallback;
  const n = Number(val);
  return isNaN(n) ? fallback : n;
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

/** Convierte cualquier representación de número a float.
 *  Maneja: números, strings con $ o comas ("2,796.89"), y formato español ("2.796,89"). */
function parseTotal(v) {
  if (v === null || v === undefined || v === "" || v === false) return 0;
  if (typeof v === "number") return isNaN(v) ? 0 : v;
  let s = String(v).replace(/[$\s%]/g, "");
  // Formato español: punto como miles, coma como decimal  →  "2.796,89"
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    // Formato anglosajón: coma como miles, punto como decimal  →  "2,796.89"
    s = s.replace(/,/g, "");
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

/** Total definitivo de un ticket: intenta resumen.total, luego cruce.total_ticket */
function ticketTotal(t) {
  const a = parseTotal(t.resumen?.total);
  if (a > 0) return a;
  return parseTotal(t.cruce?.total_ticket) || parseTotal(t.cruce?.monto_cruce) || 0;
}

function money(value) {
  const n = parseTotal(value);
  if (!Number.isFinite(n) || n === 0) return "";
  return esc(n.toLocaleString("es-MX", { style: "currency", currency: "MXN" }));
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, s =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[s])
  );
}

// ─── Sección switcher ──────────────────────────────────────────────────────

/** Cambia entre módulos de nivel superior */
function switchModule(mod) {
  ["tickets", "registros"].forEach(m => {
    document.getElementById(`module-${m}`)?.classList.toggle("hidden", m !== mod);
    document.getElementById(`tab-module-${m}`)?.classList.toggle("active", m === mod);
    document.getElementById(`nav-item-${m}`)?.classList.toggle("active", m === mod);
  });
}

// ─── Hamburger nav menu ───────────────────────────────────────────────────────
function toggleNavMenu() {
  const sidebar = document.getElementById('nav-sidebar');
  const overlay = document.getElementById('nav-overlay');
  const open = sidebar.classList.toggle('open');
  overlay.classList.toggle('hidden', !open);
}
function closeNavMenu() {
  document.getElementById('nav-sidebar')?.classList.remove('open');
  document.getElementById('nav-overlay')?.classList.add('hidden');
}

/** Cambia entre sub-secciones dentro del módulo Tickets */
function switchSection(sec) {
  ["capturados", "captura"].forEach(s => {
    document.getElementById(`section-${s}`)?.classList.toggle("hidden", s !== sec);
    document.getElementById(`subtab-${s}`)?.classList.toggle("active", s === sec);
  });
  if (sec === "capturados") loadDashboard();
}

// ─── Dashboard: carga desde Sheets ────────────────────────────────────────

async function loadDashboard() {
  const container = document.getElementById("dbContainer");
  const countBar  = document.getElementById("db-count-bar");
  container.innerHTML = `
    <div class="empty-state" style="padding:40px 20px">
      <div class="thinking-dots" style="margin:0 auto 16px">
        <div class="dot"></div><div class="dot"></div><div class="dot"></div>
      </div>
      <p>Cargando tickets desde Sheets…</p>
    </div>`;
  countBar.textContent = "";
  try {
    const res  = await fetch(`${BACKEND}/get-tickets`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Error al cargar tickets");
    dashboardTickets = data.tickets || [];
    populateDashboardFilters();
    // Siempre resetear al cargar: limpiar inputs y encender el switch
    clearDashboardFiltersInternal();
    const todasEl = document.getElementById("db-f-todas");
    if (todasEl) todasEl.checked = true;
    dbCurrentPage = 1;
    applyDashboardFilters();
  } catch (err) {
    container.innerHTML = `
      <div class="empty-state" style="padding:40px 20px">
        <div class="empty-icon">⚠️</div>
        <p>Error: ${esc(err.message)}</p>
        <button class="btn-analizar" style="margin-top:14px;width:auto;padding:12px 28px"
          onclick="dashboardTickets=[];loadDashboard()">Reintentar</button>
      </div>`;
  }
}

// ─── Dashboard: filtros ────────────────────────────────────────────────────

function populateDashboardFilters() {
  const unique = key =>
    [...new Set(dashboardTickets.map(t => String(t.resumen[key] || "")).filter(Boolean))].sort();

  const fillSelect = (id, values) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const current = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    values.forEach(v => {
      const o = document.createElement("option");
      o.value = o.textContent = v;
      sel.appendChild(o);
    });
    if (values.includes(current)) sel.value = current;
  };

  fillSelect("db-f-metodo",          unique("metodo_pago"));
  fillSelect("db-f-propiedad",       unique("propiedad"));
  fillSelect("db-f-departamento",    unique("departamento"));
  fillSelect("db-f-comprador",       unique("comprador"));
  fillSelect("db-f-tienda",          unique("tienda"));
  fillSelect("db-f-clasificado-por", unique("clasificado_por"));

  // Descripciones únicas de productos (todos los tickets)
  const descs = [...new Set(
    dashboardTickets.flatMap(t => (t.productos || []).map(p => String(p.descripcion || "").trim()))
    .filter(Boolean)
  )].sort();
  fillSelect("db-f-descripcion", descs);

  // Ajustar el máximo del slider según el "Total ticket" más alto (resumen.total con fallback a cruce)
  const maxTotal   = dashboardTickets.reduce((mx, t) => Math.max(mx, ticketTotal(t)), 0);
  const sliderMax  = Math.max(1000, Math.ceil(maxTotal / 500) * 500);  // múltiplo de 500
  // Step: ~1% del máximo, redondeado a múltiplo de 100, mínimo 100  (da ~100 posiciones)
  const sliderStep = Math.max(100, Math.round(sliderMax * 0.01 / 100) * 100);
  const loEl = document.getElementById("db-f-total-min");
  const hiEl = document.getElementById("db-f-total-max");
  if (loEl) { loEl.max = sliderMax; loEl.step = sliderStep; loEl.value = 0; }
  if (hiEl) { hiEl.max = sliderMax; hiEl.step = sliderStep; hiEl.value = sliderMax; }
  updateTotalRangeFill();
}

function getDashboardFilters() {
  const v  = id => document.getElementById(id)?.value || "";
  // Range slider: null when at boundary (no filter effect)
  const getRangeMin = () => {
    const el = document.getElementById("db-f-total-min");
    if (!el) return null;
    const val = Number(el.value), min = Number(el.min) || 0;
    return val <= min ? null : val;
  };
  const getRangeMax = () => {
    const el = document.getElementById("db-f-total-max");
    if (!el) return null;
    const val = Number(el.value), max = Number(el.max) || 50000;
    return val >= max ? null : val;
  };
  return {
    text:           v("db-f-text").trim().toLowerCase(),
    fechaDesde:     v("db-f-desde"),
    fechaHasta:     v("db-f-hasta"),
    cuenta:         v("db-f-cuenta"),
    metodoPago:     v("db-f-metodo"),
    propiedad:      v("db-f-propiedad"),
    departamento:   v("db-f-departamento"),
    comprador:      v("db-f-comprador"),
    deducible:      v("db-f-deducible"),
    reembolso:      v("db-f-reembolso"),
    tienda:         v("db-f-tienda"),
    clasificadoPor: v("db-f-clasificado-por"),
    descripcion:    v("db-f-descripcion"),
    totalMin:       getRangeMin(),
    totalMax:       getRangeMax(),
  };
}

/** Activa/desactiva el switch "Todos los tickets" */
function syncTodasSwitch(checked) {
  if (checked) {
    // Activar = limpiar todos los filtros y mostrar todos
    clearDashboardFiltersInternal();
    const el = document.getElementById("db-f-todas");
    if (el) el.checked = true;
    applyDashboardFilters();
  } else {
    // Desactivar = abrir panel de filtros como pista al usuario (nada más)
    if (!dbFiltersOpen) toggleDbFilters();
  }
}

/** Devuelve true si hay algún filtro activo */
function hasActiveFilters() {
  const f = getDashboardFilters();
  return !!(f.text || f.fechaDesde || f.fechaHasta || f.cuenta || f.metodoPago ||
            f.propiedad || f.departamento || f.comprador || f.deducible || f.reembolso ||
            f.tienda || f.clasificadoPor || f.descripcion || f.totalMin !== null || f.totalMax !== null);
}

/** Llamado desde cada input/select de filtro: desactiva el switch y filtra */
function onFilterChange() {
  const todasEl = document.getElementById("db-f-todas");
  if (todasEl) todasEl.checked = false;
  dbCurrentPage = 1;
  applyDashboardFilters();
}

function applyDashboardFilters() {
  // applyDashboardFilters NO toca el switch — ese estado lo manejan
  // onFilterChange / clearDashboardFilters / syncTodasSwitch / loadDashboard
  const active = hasActiveFilters();

  // Sin filtros activos — mostrar todos
  if (!active) {
    dashboardFiltered = [...dashboardTickets];
    const n = dashboardFiltered.length;
    const sub = document.getElementById("db-filter-subtitle");
    if (sub) sub.textContent = `${n} ticket${n !== 1 ? "s" : ""} (todos)`;
    renderDashboardCards();
    return;
  }

  const f = getDashboardFilters();
  dashboardFiltered = dashboardTickets.filter(t => {
    const r = t.resumen || {};
    const str = k => String(r[k] || "");
    if (f.text) {
      const hay = [r.tienda, r.concepto, r.comprador, r.cuenta,
                   r.subcuenta, r.categoria_gasto].join(" ").toLowerCase();
      if (!hay.includes(f.text)) return false;
    }
    if (f.fechaDesde && str("fecha") < f.fechaDesde) return false;
    if (f.fechaHasta && str("fecha") > f.fechaHasta) return false;
    if (f.cuenta      && str("cuenta")      !== f.cuenta)      return false;
    if (f.metodoPago  && str("metodo_pago") !== f.metodoPago)  return false;
    if (f.propiedad   && str("propiedad")   !== f.propiedad)   return false;
    if (f.departamento&& str("departamento")!== f.departamento) return false;
    if (f.comprador   && str("comprador")   !== f.comprador)   return false;
    if (f.deducible === "si" && str("deducible") !== "Sí") return false;
    if (f.deducible === "no" && str("deducible") === "Sí") return false;
    if (f.reembolso === "si" && str("reembolso") !== "Sí") return false;
    if (f.reembolso === "no" && str("reembolso") === "Sí") return false;
    if (f.tienda         && str("tienda")          !== f.tienda)         return false;
    if (f.clasificadoPor && str("clasificado_por") !== f.clasificadoPor) return false;
    if (f.descripcion) {
      const hasDesc = (t.productos || []).some(p =>
        String(p.descripcion || "").trim() === f.descripcion
      );
      if (!hasDesc) return false;
    }
    const total = ticketTotal(t);
    if (f.totalMin !== null && total < f.totalMin) return false;
    if (f.totalMax !== null && total > f.totalMax) return false;
    return true;
  });

  // Actualizar subtítulo del filtro
  const n = dashboardFiltered.length;
  const t = dashboardTickets.length;
  const sub = document.getElementById("db-filter-subtitle");
  if (sub) sub.textContent = t ? (n === t ? `${t} ticket${t!==1?"s":""}` : `${n} de ${t} tickets`) : "Filtra por cualquier campo";

  renderDashboardCards();
}

function resetRangeSliders() {
  const loEl = document.getElementById("db-f-total-min");
  const hiEl = document.getElementById("db-f-total-max");
  if (loEl) { loEl.value = loEl.min || 0; loEl.style.zIndex = 4; }
  if (hiEl) { hiEl.value = hiEl.max || 50000; hiEl.style.zIndex = 5; }
  updateTotalRangeFill();
}

/** Limpia solo los inputs (sin tocar el switch ni re-renderizar) */
function clearDashboardFiltersInternal() {
  ["db-f-text","db-f-desde","db-f-hasta"].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = "";
  });
  ["db-f-cuenta","db-f-metodo","db-f-propiedad","db-f-departamento","db-f-comprador",
   "db-f-deducible","db-f-reembolso","db-f-tienda","db-f-clasificado-por","db-f-descripcion"].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = "";
  });
  resetRangeSliders();
}

/** Botón "✕ Limpiar": limpia filtros, activa switch y muestra todos */
function clearDashboardFilters() {
  clearDashboardFiltersInternal();
  const el = document.getElementById("db-f-todas");
  if (el) el.checked = true;
  dbCurrentPage = 1;
  applyDashboardFilters();
}

function toggleDbFilters() {
  dbFiltersOpen = !dbFiltersOpen;
  const panel = document.getElementById("db-filter-body");
  const btn   = document.getElementById("btn-filter-toggle");
  panel?.classList.toggle("hidden", !dbFiltersOpen);
  btn?.classList.toggle("active", dbFiltersOpen);
}

/** Actualiza el fill visual y etiquetas del dual-range slider */
function updateTotalRangeFill() {
  const loEl   = document.getElementById("db-f-total-min");
  const hiEl   = document.getElementById("db-f-total-max");
  const fill   = document.getElementById("dual-range-fill");
  const minLbl = document.getElementById("range-total-min-lbl");
  const maxLbl = document.getElementById("range-total-max-lbl");
  if (!loEl || !hiEl || !fill) return;

  const min = Number(loEl.min) || 0;
  const max = Number(loEl.max) || 50000;
  const lo  = Number(loEl.value);
  const hi  = Number(hiEl.value);

  const pLo = ((lo - min) / (max - min)) * 100;
  const pHi = ((hi - min) / (max - min)) * 100;
  fill.style.left  = pLo + "%";
  fill.style.width = (pHi - pLo) + "%";

  const fmt = n => n >= 1000 ? "$" + (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + "k" : "$" + n.toLocaleString("es-MX");
  if (minLbl) minLbl.textContent = lo === min ? "$0" : fmt(lo);
  if (maxLbl) maxLbl.textContent = hi >= max ? "Máx." : fmt(hi);
}

function onTotalRangeInput(which) {
  const loEl = document.getElementById("db-f-total-min");
  const hiEl = document.getElementById("db-f-total-max");
  if (!loEl || !hiEl) return;

  // Evitar cruce
  if (which === 'lo' && Number(loEl.value) > Number(hiEl.value)) loEl.value = hiEl.value;
  if (which === 'hi' && Number(hiEl.value) < Number(loEl.value)) hiEl.value = loEl.value;

  // Z-index dinámico: cuando el thumb lo está muy a la derecha, ponerlo encima
  const range = (Number(loEl.max) || 50000) - (Number(loEl.min) || 0);
  const loFrac = range > 0 ? (Number(loEl.value) - (Number(loEl.min) || 0)) / range : 0;
  loEl.style.zIndex = loFrac >= 0.9 ? 5 : 4;
  hiEl.style.zIndex = loFrac >= 0.9 ? 4 : 5;

  updateTotalRangeFill();
  onFilterChange();
}

// ─── Dashboard: render ─────────────────────────────────────────────────────

function renderDashboardCards() {
  const container = document.getElementById("dbContainer");
  const countBar  = document.getElementById("db-count-bar");

  if (!dashboardFiltered.length) {
    container.innerHTML = `
      <div class="empty-state" style="padding:40px 20px">
        <div class="empty-icon">${dashboardTickets.length ? "🔍" : "📋"}</div>
        <p>${dashboardTickets.length ? "Sin resultados para los filtros aplicados" : "No hay tickets guardados aún"}</p>
      </div>`;
    countBar.innerHTML = "";
    renderPagination(0, 0);
    return;
  }

  // Ordenar: sin clasificar primero
  const sinClasif = dashboardFiltered.filter(t => !String(t.resumen?.cuenta || "").trim());
  const clasif    = dashboardFiltered.filter(t =>  String(t.resumen?.cuenta || "").trim());
  const sorted    = [...sinClasif, ...clasif];

  // Paginación
  const totalItems  = sorted.length;
  const totalPages  = Math.max(1, Math.ceil(totalItems / dbPageSize));
  dbCurrentPage     = Math.min(dbCurrentPage, totalPages);
  const start       = (dbCurrentPage - 1) * dbPageSize;
  const pageItems   = sorted.slice(start, start + dbPageSize);

  // Barra de conteo
  const nSin = sinClasif.length;
  countBar.innerHTML = nSin
    ? `<span class="db-count-warn">⚠️ ${nSin} sin clasificar</span> · ${totalItems} total`
    : `<span class="db-count-ok">✅ ${totalItems} clasificado${totalItems !== 1 ? "s" : ""}</span>`;

  container.innerHTML = pageItems.map((t, i) => createDashboardCard(t, start + i)).join("");
  renderPagination(totalItems, totalPages);
}

function renderPagination(totalItems, totalPages) {
  const bar = document.getElementById("db-pagination");
  if (!bar) return;
  if (totalPages <= 1 && totalItems <= 25) { bar.innerHTML = ""; return; }

  const sizes = [25, 50, 100];
  const sizeOpts = sizes.map(s =>
    `<option value="${s}"${s === dbPageSize ? " selected" : ""}>${s}</option>`
  ).join("");

  // Páginas visibles: siempre primera, última, y ±2 alrededor de la actual
  const pages = new Set([1, totalPages]);
  for (let p = Math.max(1, dbCurrentPage - 2); p <= Math.min(totalPages, dbCurrentPage + 2); p++) pages.add(p);
  const pageArr = [...pages].sort((a, b) => a - b);

  let pageBtns = "";
  let prev = 0;
  for (const p of pageArr) {
    if (p - prev > 1) pageBtns += `<span class="pag-ellipsis">…</span>`;
    pageBtns += `<button class="pag-btn${p === dbCurrentPage ? " active" : ""}" onclick="goToPage(${p})">${p}</button>`;
    prev = p;
  }

  bar.innerHTML = `
    <div class="pag-left">
      <select class="pag-size-sel" onchange="changePageSize(Number(this.value))">${sizeOpts}</select>
      <span class="pag-info">por página</span>
    </div>
    <div class="pag-right">
      <button class="pag-btn" onclick="goToPage(${dbCurrentPage - 1})" ${dbCurrentPage <= 1 ? "disabled" : ""}>‹</button>
      ${pageBtns}
      <button class="pag-btn" onclick="goToPage(${dbCurrentPage + 1})" ${dbCurrentPage >= totalPages ? "disabled" : ""}>›</button>
    </div>`;
}

function goToPage(p) {
  const totalPages = Math.max(1, Math.ceil(dashboardFiltered.length / dbPageSize));
  dbCurrentPage = Math.max(1, Math.min(p, totalPages));
  renderDashboardCards();
  // Scroll suave al top de la lista
  document.getElementById("db-count-bar")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function changePageSize(size) {
  dbPageSize    = size;
  dbCurrentPage = 1;
  renderDashboardCards();
}

function createDashboardCard(ticket, i) {
  const r        = ticket.resumen || {};
  const str      = k => String(r[k] || "");
  const isClasif = !!str("cuenta").trim();
  const colorCls = CUENTA_COLOR_CLASS[str("cuenta")] || "";
  const clsCls   = isClasif ? `classified ${colorCls}` : "";
  const ci       = DB_IDX + i; // índice para el panel de clasificar

  const metaParts   = [str("fecha"), formatHora(str("hora"))].filter(Boolean);
  const numProd     = Number(r.num_productos) || (ticket.productos || []).length || 0;
  const rawSummary  = (ticket.productos || []).map(p => p.descripcion || "").filter(Boolean).join(", ");
  const prodSummary = rawSummary.length > 95 ? rawSummary.slice(0, 92) + "…" : rawSummary;
  const deptOptions = Array.from({length: 14}, (_, j) => `<option>${j + 1}</option>`).join("");

  // Chips
  const sinClasifChip = !isClasif
    ? `<span class="info-chip chip-sin-clasif">⚠️ Sin clasificar</span>` : "";
  const cuentaChip    = isClasif
    ? `<span class="info-chip ${colorCls}">${CUENTA_EMOJIS[str("cuenta")] || ""} ${esc(str("cuenta"))}</span>` : "";
  const compradorChip = str("comprador")  ? `<span class="info-chip">👤 ${esc(str("comprador"))}</span>` : "";
  const propiedadChip = str("propiedad")  ? `<span class="info-chip">🏠 ${esc(str("propiedad"))}</span>` : "";
  const deptChip      = str("departamento") ? `<span class="info-chip">🚪 Depto. ${esc(str("departamento"))}</span>` : "";
  const reembolsoChip = (str("reembolso") === "Sí" && str("reembolso_a"))
    ? `<span class="info-chip chip-reembolso">↩ Reembolso a ${esc(str("reembolso_a"))}</span>` : "";

  const verTicket   = str("imagen_url")
    ? `<a class="btn-ver-ticket" href="${esc(str("imagen_url"))}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Ver ticket</a>` : "";
  const isDeducible = str("deducible") === "Sí";
  const deducibleHtml = `
    <div class="header-deducible" onclick="event.stopPropagation()">
      <label class="toggle-switch toggle-switch--dark">
        <input type="checkbox" id="db-deducible-header-${i}"
               ${isDeducible ? "checked" : ""}
               onchange="syncDbDeducible(${i}, this.checked)">
        <span class="toggle-slider"></span>
      </label>
      <span class="fhl${isDeducible ? " on" : ""}" id="db-fhl-${i}">${isDeducible ? "Deducible" : "No deducible"}</span>
    </div>`;

  // Pestaña inferior
  const pathParts = [str("cuenta"), str("subcuenta"), str("categoria_gasto"), str("concepto")].filter(Boolean);
  const pathText  = pathParts.join(" › ");
  const tabHtml   = isClasif
    ? `<div class="classify-tab classified ${colorCls}" id="db-btn-classify-${i}" onclick="toggleDbClassify(${i})">
         <span class="classify-tab-arrow" style="color:#fff">›</span>
         <span class="classify-tab-label" style="font-size:10px;text-transform:none;letter-spacing:.01em;font-weight:700;color:#fff;">${esc(pathText)}</span>
       </div>`
    : `<div class="classify-tab" id="db-btn-classify-${i}" onclick="toggleDbClassify(${i})">
         <span class="classify-tab-arrow">›</span>
         <span class="classify-tab-label">Clasificar</span>
       </div>`;

  return `
    <div class="ticket-card" id="db-ticket-${i}">
      <div class="ticket-card-header ${clsCls}" id="db-header-${i}" onclick="toggleDbTable(${i})">
        <button class="btn-x" title="Eliminar registro" onclick="event.stopPropagation(); deleteDbTicket(${i})">×</button>
        <div class="ticket-info">
          <div class="header-chips">${sinClasifChip}${cuentaChip}${compradorChip}${propiedadChip}${deptChip}${reembolsoChip}</div>
          <div class="ticket-store-row">
            <span class="ticket-store">${esc(str("tienda") || "Ticket " + (i + 1))}</span>
            ${verTicket}
          </div>
          <div class="ticket-meta">
            ${esc(metaParts.join(" · "))}${metaParts.length ? " · " : ""}🧾 ${numProd} producto${numProd !== 1 ? "s" : ""}
          </div>
          ${prodSummary ? `<div class="product-summary">${esc(prodSummary)}</div>` : ""}
        </div>
        <div class="ticket-header-right">
          <span>${paymentChip(str("metodo_pago"), str("tarjeta_ultimos4"))}</span>
          <div class="ticket-total-badge ${clsCls}">
            <span class="total-main">${money(r.total)}</span>
            ${r.iva ? `<span class="total-iva">IVA ${money(r.iva)}</span>` : ""}
          </div>
          ${deducibleHtml}
        </div>
      </div>

      <div class="ticket-table-wrap hidden" id="db-table-${i}" data-tidx="${i}" data-tmod="db">
        <div class="ticket-tabs">
          <button class="ticket-tab active" onclick="showDbTab(${i},'transcripcion',this)">Transcripción</button>
          <button class="ticket-tab" onclick="showDbTab(${i},'resumen',this)">Resumen</button>
          <button class="ticket-tab" onclick="showDbTab(${i},'cruce',this)">Cruce bancario</button>
        </div>
        <div id="db-tab-transcripcion-${i}" class="ticket-tab-content">
          ${buildDashboardProductTable(ticket.productos || [])}
          <button class="btn-add-row" onclick="addDashboardProductRow(${i})">＋ Agregar producto</button>
        </div>
        <div id="db-tab-resumen-${i}" class="ticket-tab-content hidden">${buildResumenTable(r)}</div>
        <div id="db-tab-cruce-${i}" class="ticket-tab-content hidden">${buildDashboardCruceTable(ticket)}</div>
        <div class="table-actions-bar hidden" id="tact-db-${i}">
          <button class="btn-clasificar-ticket" style="padding:10px 28px;font-size:13px" onclick="saveDbTableChanges(${i})">💾 Guardar cambios</button>
          <button class="btn-limpiar-ticket" onclick="resetDbTableChanges(${i})">Limpiar</button>
        </div>
      </div>

      ${tabHtml}
      ${buildClassifyPanel(ci, str("fecha"), deptOptions,
          isClasif ? "💾 Guardar cambios" : "✓ Clasificar",
          `saveDbClassification(${i})`,
          `limpiarDbClassificacion(${i})`)}
    </div>`;
}

function buildDashboardProductTable(productos) {
  if (!productos?.length)
    return `<div class="empty-state"><div class="empty-icon">🧾</div><p>Sin productos registrados</p></div>`;
  const cols = [
    { key: "descripcion",     label: "Descripción" },
    { key: "cantidad",        label: "Cant." },
    { key: "precio_unitario", label: "P.Unit." },
    { key: "monto",           label: "Monto" },
  ];
  return `<table>
    <thead><tr>${cols.map(c => `<th>${c.label}</th>`).join("")}<th></th></tr></thead>
    <tbody>${productos.map((p, rowIdx) =>
      `<tr data-row="${rowIdx}">${cols.map(c =>
        `<td contenteditable="true" spellcheck="false" data-field="${c.key}" oninput="onTableCellInput(this)">${esc(String(p[c.key] ?? ""))}</td>`
      ).join("")}<td class="btn-del-cell"><button class="btn-del-row" onclick="deleteProductRow(this)" title="Eliminar fila">✕</button></td></tr>`
    ).join("")}</tbody>
  </table>`;
}

function toggleDbTable(i) {
  const wrap   = document.getElementById(`db-table-${i}`);
  const header = document.getElementById(`db-header-${i}`);
  const hidden = wrap.classList.toggle("hidden");
  header.classList.toggle("collapsed", hidden);
}

function showDbTab(i, tab, btn) {
  ["transcripcion", "resumen", "cruce"].forEach(t => {
    document.getElementById(`db-tab-${t}-${i}`)?.classList.toggle("hidden", t !== tab);
  });
  btn.closest(".ticket-tabs").querySelectorAll(".ticket-tab")
    .forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
}

// ─── Dashboard: panel clasificar ──────────────────────────────────────────

/** Sincroniza el toggle Deducible del encabezado con el panel de Clasificar */
async function syncDbDeducible(i, checked) {
  const ci     = DB_IDX + i;
  const ticket = dashboardFiltered[i];
  if (!ticket) return;

  // 1. Actualizar UI inmediatamente (optimista)
  const inner = document.getElementById(`deducible-${ci}`);
  if (inner) { inner.checked = checked; updateDeducibleLabel(ci, checked); }
  const lbl = document.getElementById(`db-fhl-${i}`);
  if (lbl) { lbl.textContent = checked ? "Deducible" : "No deducible"; lbl.classList.toggle("on", checked); }

  // 2. Actualizar en memoria
  const prevDeducible = ticket.resumen.deducible;
  ticket.resumen.deducible = checked ? "Sí" : "No";
  const orig = dashboardTickets.find(t => t.ticket_id === ticket.ticket_id);
  if (orig) orig.resumen.deducible = ticket.resumen.deducible;

  // 3. Guardar en Sheets inmediatamente usando clasificación existente en memoria
  const r = ticket.resumen;
  const clasificacion = {
    fecha:              r.fecha              || "",
    cuenta:             r.cuenta             || "",
    subcuenta:          r.subcuenta          || "",
    categoria_gasto:    r.categoria_gasto    || "",
    concepto:           r.concepto           || "",
    propiedad:          r.propiedad          || "",
    departamento:       r.departamento       || "",
    comprador:          r.comprador          || "",
    deducible:          checked ? "Sí" : "No",
    reembolso:          r.reembolso          || "No",
    reembolso_a:        r.reembolso_a        || "",
    metodo_pago:        r.metodo_pago        || "",
    detalles_operacion: r.detalles_operacion || "",
    comentarios:        r.comentarios        || "",
    clasificado_por:    currentUser          || r.clasificado_por || "",
    tienda:             r.tienda             || "",
    rfc:                r.rfc                || "",
    hora:               r.hora               || "",
    folio:              r.folio              || "",
    tarjeta_ultimos4:   r.tarjeta_ultimos4   || "",
    subtotal:           r.subtotal  ?? 0,
    iva:                r.iva       ?? 0,
    ieps:               r.ieps      ?? 0,
    descuentos:         r.descuentos ?? 0,
    total:              r.total     ?? 0,
  };

  try {
    const res  = await fetch(`${BACKEND}/update-ticket`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ ticket_id: ticket.ticket_id, clasificacion, productos_editados: [] }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Error");
  } catch (err) {
    // Revertir en caso de error
    ticket.resumen.deducible = prevDeducible;
    if (orig) orig.resumen.deducible = prevDeducible;
    const prevChecked = prevDeducible === "Sí";
    const headerToggle = document.getElementById(`db-deducible-header-${i}`);
    if (headerToggle) headerToggle.checked = prevChecked;
    if (inner) { inner.checked = prevChecked; updateDeducibleLabel(ci, prevChecked); }
    if (lbl) { lbl.textContent = prevChecked ? "Deducible" : "No deducible"; lbl.classList.toggle("on", prevChecked); }
    console.error("deducible_save_error", err.message);
  }
}

/** Elimina un ticket del dashboard y de Google Sheets */
async function deleteDbTicket(i) {
  const ticket = dashboardFiltered[i];
  if (!ticket) return;
  const tienda = ticket.resumen?.tienda || `Ticket ${i + 1}`;
  const confirmed = await showConfirm({
    icon:    "🗑",
    title:   `¿Eliminar "${tienda}"?`,
    msg:     "Esta acción borrará el ticket de Sheets (Transcripción, Resumen y Cruce bancario). No se puede deshacer.",
    okLabel: "Sí, eliminar",
  });
  if (!confirmed) return;
  try {
    showLoading("Eliminando ticket…", "Borrando registros de Sheets…");
    const res  = await fetch(`${BACKEND}/delete-ticket`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ ticket_id: ticket.ticket_id }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Error al eliminar");
    // Quitar de ambos arrays en memoria
    const tid = ticket.ticket_id;
    dashboardTickets  = dashboardTickets.filter(t => t.ticket_id !== tid);
    dashboardFiltered = dashboardFiltered.filter(t => t.ticket_id !== tid);
    renderDashboardCards();
  } catch (err) {
    alert("Error al eliminar: " + err.message);
  } finally {
    hideLoading();
  }
}

function toggleDbClassify(i) {
  const panel = document.getElementById(`classify-${DB_IDX + i}`);
  const tab   = document.getElementById(`db-btn-classify-${i}`);
  if (!panel) return;
  const isHidden = panel.classList.toggle("hidden");
  tab?.classList.toggle("open", !isHidden);
  if (!isHidden) autoPopulateDbClassify(DB_IDX + i, dashboardFiltered[i]);
}

/** Rellena el panel de clasificar del dashboard con los datos guardados */
function autoPopulateDbClassify(ci, ticket) {
  if (!ticket) return;
  classifyAutoPopulating = true;
  const r  = ticket.resumen || {};
  const s  = k => String(r[k] || "");

  // Fecha
  const fEl = document.getElementById(`fecha-clasif-${ci}`);
  if (fEl) fEl.value = s("fecha");

  // Cuenta → subcuenta → categoría → concepto (cascade)
  const cuentaVal = s("cuenta");
  if (cuentaVal) {
    const grid = document.getElementById(`cuenta-grid-${ci}`);
    const card = Array.from(grid?.querySelectorAll(".cuenta-card") || [])
      .find(c => c.dataset.value === cuentaVal);
    if (card) {
      selectCuenta(card, ci);
      const subVal = s("subcuenta");
      if (subVal) {
        const subGrid = document.getElementById(`subcuenta-grid-${ci}`);
        const subCard = Array.from(subGrid?.querySelectorAll(".cuenta-card") || [])
          .find(c => c.dataset.value === subVal);
        if (subCard) {
          selectSubcuenta(subCard, ci);
          const catVal = s("categoria_gasto");
          if (catVal) {
            const catGrid = document.getElementById(`categoria-grid-${ci}`);
            const catCard = Array.from(catGrid?.querySelectorAll(".cuenta-card") || [])
              .find(c => c.dataset.value === catVal);
            if (catCard) {
              selectCategoria(catCard, ci);
              const concVal = s("concepto");
              if (concVal) {
                const concGrid = document.getElementById(`concepto-grid-${ci}`);
                const concCard = Array.from(concGrid?.querySelectorAll(".cuenta-card") || [])
                  .find(c => c.dataset.value === concVal);
                if (concCard) selectConcepto(concCard, ci);
              }
            }
          }
        }
      }
    }
  }

  // Propiedad
  const propSel = document.getElementById(`propiedad-${ci}`);
  if (propSel) {
    const pv = s("propiedad");
    const exists = Array.from(propSel.options).some(o => o.value === pv);
    if (exists && pv) { propSel.value = pv; }
    else if (pv) {
      propSel.value = "Otro"; togglePropiedadOtro(ci, "Otro");
      const oEl = document.getElementById(`propiedad-otro-${ci}`); if (oEl) oEl.value = pv;
    }
  }

  // Departamento
  const dEl = document.getElementById(`departamento-${ci}`);
  if (dEl) dEl.value = s("departamento");

  // Comprador
  const compVal = s("comprador");
  if (compVal) {
    const compGrid = document.getElementById(`comprador-grid-${ci}`);
    const compCard = Array.from(compGrid?.querySelectorAll(".cuenta-card") || [])
      .find(c => c.dataset.value === compVal);
    if (compCard) selectComprador(compCard, ci);
  }

  // Deducible
  const dedEl = document.getElementById(`deducible-${ci}`);
  const dedChecked = s("deducible") === "Sí";
  if (dedEl) { dedEl.checked = dedChecked; updateDeducibleLabel(ci, dedChecked); }
  // Sincronizar toggle del encabezado
  const dbI = ci - DB_IDX;
  const headerToggle = document.getElementById(`db-deducible-header-${dbI}`);
  if (headerToggle) {
    headerToggle.checked = dedChecked;
    const hLbl = document.getElementById(`db-fhl-${dbI}`);
    if (hLbl) { hLbl.textContent = dedChecked ? "Deducible" : "No deducible"; hLbl.classList.toggle("on", dedChecked); }
  }

  // Reembolso
  if (s("reembolso") === "Sí") {
    const reemEl = document.getElementById(`reembolso-${ci}`);
    if (reemEl) { reemEl.checked = true; toggleReembolso(ci, true); }
    const reemSel = document.getElementById(`reembolso-a-${ci}`);
    if (reemSel) {
      const rv = s("reembolso_a");
      const exists = Array.from(reemSel.options).some(o => o.value === rv);
      if (exists && rv) { reemSel.value = rv; }
      else if (rv) {
        reemSel.value = "Otro"; toggleReembolsoOtro(ci, "Otro");
        const oEl = document.getElementById(`reembolso-otro-${ci}`); if (oEl) oEl.value = rv;
      }
    }
  }

  // Método de pago
  autoSelectMetodoPago(ci, s("metodo_pago_clasif") || s("metodo_pago"));

  // Comentarios
  const comEl = document.getElementById(`comentarios-${ci}`);
  if (comEl) comEl.value = s("comentarios");

  updateClasiPath(ci);
  classifyAutoPopulating = false;
}

function limpiarDbClassificacion(i) {
  const ci = DB_IDX + i;
  // Buscador y cuenta
  const search = document.getElementById(`search-${ci}`); if (search) search.value = "";
  hideSearchResults(ci);
  const grid = document.getElementById(`cuenta-grid-${ci}`);
  if (grid) {
    grid.querySelectorAll(".cuenta-card").forEach(c => c.classList.remove("active"));
    const sin = grid.querySelector('[data-value=""]'); if (sin) sin.classList.add("active");
  }
  const cuentaH = document.getElementById(`cuenta-${ci}`); if (cuentaH) cuentaH.value = "";
  resetSubcuenta(ci); updateClasiPath(ci);
  // Propiedad / Depto
  const p = document.getElementById(`propiedad-${ci}`); if (p) p.value = "";
  const d = document.getElementById(`departamento-${ci}`); if (d) d.value = "";
  // Comprador
  document.getElementById(`comprador-grid-${ci}`)
    ?.querySelectorAll(".cuenta-card").forEach(c => c.classList.remove("active"));
  const comp = document.getElementById(`comprador-${ci}`); if (comp) comp.value = "";
  // Deducible
  const ded = document.getElementById(`deducible-${ci}`);
  if (ded && ded.checked) { ded.checked = false; updateDeducibleLabel(ci, false); }
  // Reembolso
  const reem = document.getElementById(`reembolso-${ci}`);
  if (reem && reem.checked) { reem.checked = false; toggleReembolso(ci, false); }
  // Método de pago
  document.getElementById(`metodo-grid-${ci}`)
    ?.querySelectorAll(".cuenta-card").forEach(c => c.classList.remove("active"));
  const metodo = document.getElementById(`metodo-clasif-${ci}`); if (metodo) metodo.value = "";
  // Textos
  ["detalles", "comentarios"].forEach(id => {
    const el = document.getElementById(`${id}-${ci}`); if (el) el.value = "";
  });
  // Restaurar fecha detectada
  const fechaEl = document.getElementById(`fecha-clasif-${ci}`);
  if (fechaEl) fechaEl.value = dashboardFiltered[i]?.resumen?.fecha || "";
  hideClassifyActions(ci);
}

async function saveDbClassification(i) {
  const ci     = DB_IDX + i;
  const ticket = dashboardFiltered[i];
  if (!ticket) return;
  const c = getClassify(ci);

  // Leer ediciones del usuario en tablas del dashboard
  const resEdits = readResumenEditsFromDOM(`#db-tab-resumen-${i}`);

  const clasificacion = {
    fecha:              c.fecha,
    cuenta:             c.cuenta,
    subcuenta:          c.subcuenta,
    categoria_gasto:    c.categoria,
    concepto:           c.concepto,
    propiedad:          c.propiedad,
    departamento:       c.departamento,
    comprador:          c.comprador,
    deducible:          c.deducible  ? "Sí" : "No",
    reembolso:          c.reembolso  ? "Sí" : "No",
    reembolso_a:        c.reembolso_a,
    metodo_pago_clasif: c.metodo_pago_clasif,
    metodo_pago:        c.metodo_pago_clasif || ticket.resumen.metodo_pago || "",
    detalles_operacion: c.detalles_operacion,
    comentarios:        c.comentarios,
    clasificado_por:    currentUser,
    // Campos de resumen editables por el usuario
    tienda:           resEdits.tienda           ?? ticket.resumen.tienda           ?? "",
    rfc:              resEdits.rfc              ?? ticket.resumen.rfc              ?? "",
    hora:             resEdits.hora             ?? ticket.resumen.hora             ?? "",
    folio:            resEdits.folio            ?? ticket.resumen.folio            ?? "",
    tarjeta_ultimos4: resEdits.tarjeta_ultimos4 ?? ticket.resumen.tarjeta_ultimos4 ?? "",
    subtotal:  numEdit(resEdits.subtotal,  ticket.resumen.subtotal  ?? 0),
    iva:       numEdit(resEdits.iva,       ticket.resumen.iva       ?? 0),
    ieps:      numEdit(resEdits.ieps,      ticket.resumen.ieps      ?? 0),
    descuentos:numEdit(resEdits.descuentos,ticket.resumen.descuentos ?? 0),
    total:     numEdit(resEdits.total,     ticket.resumen.total     ?? 0),
  };

  // Productos: estado final desde DOM (incluye nuevos y elimina borrados)
  const productosEditados = readAllProductsFromDOM(
    `#db-tab-transcripcion-${i}`, ticket.productos, ticket.ticket_id
  ).map(p => ({
    linea_numero:    p.linea_numero,
    descripcion:     p.descripcion,
    cantidad:        p.cantidad,
    precio_unitario: p.precio_unitario,
    monto:           p.monto,
  }));

  try {
    showLoading("Guardando clasificación…", "Actualizando registro en Sheets…");
    const res  = await fetch(`${BACKEND}/update-ticket`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ ticket_id: ticket.ticket_id, clasificacion, productos_editados: productosEditados }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Error al guardar");

    // Actualizar en memoria
    Object.assign(ticket.resumen, clasificacion);
    const orig = dashboardTickets.find(t => t.ticket_id === ticket.ticket_id);
    if (orig) Object.assign(orig.resumen, clasificacion);

    hideClassifyActions(DB_IDX + i);
    // Re-renderizar para reflejar nuevo estado (sort + chips + pestaña)
    renderDashboardCards();
  } catch (err) {
    alert("Error al guardar: " + err.message);
  } finally {
    hideLoading();
  }
}
