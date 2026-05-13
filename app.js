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

let selectedFiles   = [];
let ticketResults   = [];
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

window.addEventListener("DOMContentLoaded", () => {
  // Configurar PDF.js worker
  if (typeof pdfjsLib !== "undefined") {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  ensureTicketsIndex();

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
        ${ticket.imageUrl ? `<img class="skipped-thumb" src="${esc(ticket.imageUrl)}"
            onclick="event.stopPropagation(); openTicketImageLightbox(${i})"
            alt="Ticket ${i + 1}" title="Ver imagen">` : ""}
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
          <button class="btn-clasif-toggle" type="button"
                  onclick="toggleClasiDetail(${i})"
                  id="clasif-toggle-${i}"
                  title="Cuenta / Subcuenta / Categoría / Concepto">≡</button>
          <input type="text" id="search-${i}" class="classify-search"
                 placeholder="🔍 Buscar por cuenta, subcuenta, categoría o concepto..."
                 oninput="onClassifySearch(${i}, this.value)"
                 onblur="setTimeout(()=>hideSearchResults(${i}), 180)">
          <div class="search-results hidden" id="search-results-${i}"></div>
        </div>
        <div class="clasif-path-text" id="clasif-path-${i}"></div>

        <div class="clasif-cuenta-section hidden" id="cuenta-section-${i}">

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

        </div><!-- /clasif-cuenta-section -->

        <div class="grid">
          <div class="field">
            <label>Propiedad</label>
            <select id="propiedad-${i}" onchange="togglePropiedadOtro(${i}, this.value)">
              <option value="">— Seleccionar —</option>
              <option>Calle Cumbres</option>
              <option>Calle Baja California</option>
              <option>Calle Oaxaca</option>
              <option>Calle José Cárdenas</option>
              <option>Calle Matamoros</option>
              <option value="Otro">Otro</option>
            </select>
            <div class="hidden" id="propiedad-otro-wrap-${i}" style="margin-top:8px">
              <input type="text" id="propiedad-otro-${i}" class="field-select"
                     placeholder="Especificar propiedad..." style="appearance:none">
            </div>
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
            <div class="cuenta-card" data-value="Andrés" onclick="selectComprador(this,${i})">
              <div class="cuenta-icon">👨</div><div class="cuenta-label">Andrés</div>
            </div>
            <div class="cuenta-card" data-value="Claudia" onclick="selectComprador(this,${i})">
              <div class="cuenta-icon">👩</div><div class="cuenta-label">Claudia</div>
            </div>
            <div class="cuenta-card" data-value="Papá" onclick="selectComprador(this,${i})">
              <div class="cuenta-icon">👨‍👧</div><div class="cuenta-label">Papá</div>
            </div>
            <div class="cuenta-card" data-value="Francisco" onclick="selectComprador(this,${i})">
              <div class="cuenta-icon">👨</div><div class="cuenta-label">Francisco</div>
            </div>
            <div class="cuenta-card" data-value="Brenda" onclick="selectComprador(this,${i})">
              <div class="cuenta-icon">👩</div><div class="cuenta-label">Brenda</div>
            </div>
            <div class="cuenta-card" data-value="Alma" onclick="selectComprador(this,${i})">
              <div class="cuenta-icon">👩</div><div class="cuenta-label">Alma</div>
            </div>
            <div class="cuenta-card" data-value="Gaby" onclick="selectComprador(this,${i})">
              <div class="cuenta-icon">👩</div><div class="cuenta-label">Gaby</div>
            </div>
            <div class="cuenta-card" data-value="Juanita" onclick="selectComprador(this,${i})">
              <div class="cuenta-icon">👩</div><div class="cuenta-label">Juanita</div>
            </div>
            <div class="cuenta-card" data-value="Damariz" onclick="selectComprador(this,${i})">
              <div class="cuenta-icon">👩</div><div class="cuenta-label">Damariz</div>
            </div>
          </div>
          <input type="hidden" id="comprador-${i}" value="">
        </div>

        <div class="cuenta-field" id="deducible-field-${i}">
          <label>Deducible</label>
          <div class="toggle-row">
            <label class="toggle-switch">
              <input type="checkbox" id="deducible-${i}" onchange="updateDeducibleLabel(${i}, this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <span class="toggle-label-text" id="deducible-label-${i}">No</span>
          </div>
        </div>

        <div class="cuenta-field">
          <label>Reembolso</label>
          <div class="toggle-row">
            <label class="toggle-switch">
              <input type="checkbox" id="reembolso-${i}" onchange="toggleReembolso(${i}, this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <span class="toggle-label-text" id="reembolso-label-${i}">No</span>
          </div>
          <div class="hidden" id="reembolso-a-field-${i}" style="margin-top:10px">
            <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:6px">Reembolsar a:</label>
            <select id="reembolso-a-${i}" class="field-select" onchange="toggleReembolsoOtro(${i}, this.value)">
              <option value="">— Seleccionar —</option>
              <option>Andrés</option><option>Claudia</option><option>Papá</option>
              <option>Francisco</option><option>Brenda</option><option>Alma</option>
              <option>Gaby</option><option>Juanita</option><option>Damariz</option>
              <option value="Otro">Otro</option>
            </select>
            <div class="hidden" id="reembolso-otro-wrap-${i}" style="margin-top:8px">
              <input type="text" id="reembolso-otro-${i}" class="field-select"
                     placeholder="Especificar persona..." style="appearance:none">
            </div>
            <div style="margin-top:12px">
              <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:6px">Detalles de la operación</label>
              <textarea id="detalles-${i}" class="classify-textarea" rows="3"
                        placeholder="Descripción libre de la operación..."></textarea>
            </div>
          </div>
        </div>

        <div class="cuenta-field">
          <label>Método de pago</label>
          <div class="cuenta-grid cuenta-grid--compact" id="metodo-grid-${i}">
            <div class="cuenta-card" data-value="Tarjeta crédito" onclick="selectMetodoPago(this,${i})">
              <div class="cuenta-icon">💳</div><div class="cuenta-label">Crédito</div>
            </div>
            <div class="cuenta-card" data-value="Tarjeta débito" onclick="selectMetodoPago(this,${i})">
              <div class="cuenta-icon">🏦</div><div class="cuenta-label">Débito</div>
            </div>
            <div class="cuenta-card" data-value="Efectivo" onclick="selectMetodoPago(this,${i})">
              <div class="cuenta-icon">💵</div><div class="cuenta-label">Efectivo</div>
            </div>
            <div class="cuenta-card" data-value="Transferencia" onclick="selectMetodoPago(this,${i})">
              <div class="cuenta-icon">🔄</div><div class="cuenta-label">Transferencia</div>
            </div>
            <div class="cuenta-card" data-value="Retiro sin tarjeta" onclick="selectMetodoPago(this,${i})">
              <div class="cuenta-icon">🏧</div><div class="cuenta-label">Retiro</div>
            </div>
            <div class="cuenta-card" data-value="Cheque" onclick="selectMetodoPago(this,${i})">
              <div class="cuenta-icon">📝</div><div class="cuenta-label">Cheque</div>
            </div>
          </div>
          <input type="hidden" id="metodo-clasif-${i}" value="">
        </div>

        <div class="cuenta-field">
          <label>Comentarios</label>
          <textarea id="comentarios-${i}" class="classify-textarea"
                    placeholder="Notas adicionales sobre este ticket..."></textarea>
        </div>

        <div class="classify-actions">
          <button class="btn-clasificar-ticket" onclick="clasificarTicket(${i})">✓ Clasificar</button>
          <button class="btn-eliminar-ticket" onclick="removeTicket(${i})">Eliminar</button>
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

      metadata.push({ ticket_id: t.resumen.ticket_id, fecha: t.resumen.fecha, tienda: t.resumen.tienda });

      (t.productos || []).forEach(p => productos.push({
        ticket_id:               p.ticket_id,
        tienda:                  p.tienda,
        fecha:                   p.fecha,
        linea_numero:            p.linea_numero,
        descripcion:             p.descripcion,
        cantidad:                p.cantidad,
        precio_unitario:         p.precio_unitario,
        monto:                   p.monto,
        categoria_operativa:     p.categoria_operativa,
        deducible_sugerido:      p.deducible_sugerido,
        confianza_clasificacion: p.confianza_clasificacion,
        ...clasif,
      }));

      resumen.push({
        ticket_id:        t.resumen.ticket_id,
        archivo:          t.resumen.archivo,
        tienda:           t.resumen.tienda,
        rfc:              t.resumen.rfc,
        fecha:            t.resumen.fecha,
        hora:             t.resumen.hora,
        folio:            t.resumen.folio,
        metodo_pago:      t.resumen.metodo_pago,
        tarjeta_ultimos4: t.resumen.tarjeta_ultimos4,
        num_productos:    t.resumen.num_productos,
        subtotal:         t.resumen.subtotal,
        iva:              t.resumen.iva,
        ieps:             t.resumen.ieps,
        descuentos:       t.resumen.descuentos,
        total:            t.resumen.total,
        ...clasif,
        fecha_captura:    t.resumen.fecha_captura || new Date().toISOString(),
        imagen_nombre:    "",
        imagen_url:       "",
        archivo_hash:     t.fileHash || "",
      });

      cruce.push({
        fecha:            t.cruce.fecha,
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
    subs.map(n => makeCard(n, SUBCUENTA_EMOJIS[n] || "📌", `selectSubcuenta(this,${i})`)).join("");
  document.getElementById(`subcuenta-field-${i}`).classList.remove("hidden");
  updateClasiPath(i);
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
      cats.map(n => makeCard(n, CATEGORIA_EMOJIS[n] || "📂", `selectCategoria(this,${i})`)).join("");
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
    conceptos.map(n => makeCard(n, CONCEPTO_EMOJIS[n] || "🔹", `selectConcepto(this,${i})`)).join("");
  document.getElementById(`concepto-field-${i}`).classList.remove("hidden");
}

function selectConcepto(el, i) {
  el.closest(".cuenta-grid").querySelectorAll(".cuenta-card").forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  scrollCardIntoView(el);
  document.getElementById(`concepto-${i}`).value = el.dataset.value;
  updateClasiPath(i);
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
}

function selectMetodoPago(el, i) {
  el.closest(".cuenta-grid").querySelectorAll(".cuenta-card").forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  scrollCardIntoView(el);
  document.getElementById(`metodo-clasif-${i}`).value = el.dataset.value;
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

  // Actualizar texto de ruta de clasificación bajo la barra de búsqueda
  updateClasiPath(i);

  // Limpiar buscador
  document.getElementById(`search-${i}`).value = "";
  hideSearchResults(i);
}

// ─── Get classification values ──────────────────────────────────────────────

function getClassify(i) {
  return {
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
