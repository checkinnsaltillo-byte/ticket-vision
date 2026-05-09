/**
 * classifier.js — Clasificador contable-fiscal v3
 * Con score de confianza, categorías SAT/LISR y lógica por tienda.
 */

const RULES = [
  {
    categoria_operativa:  "Mantenimiento",
    categoria_contable:   "Reparaciones y mantenimiento",
    clave_sat:            "MN",
    tratamiento_fiscal:   "Gasto deducible operativo (Art. 27 LISR)",
    keywords: [
      "mezcladora", "fregadero", "cespol", "manguera", "gas", "plomeria",
      "llave", "valvula", "tubo", "cinta", "aislar", "silicon", "sellador",
      "pintura", "impermeabilizante", "chapas", "cerradura", "resane",
      "cemento", "yeso", "masilla", "brochas", "rodillo", "solvente",
      "thinner", "lija", "tornillo", "clavo", "taquete", "ancla", "bisagra",
      "puerta", "ventana", "vidrio", "herraje", "candado", "clave",
      "bomba agua", "manguera", "coladera", "registro", "drenaje",
      "cable", "clavija", "interruptor", "contacto electrico", "foco",
      "foco led", "lampara led", "extension", "multicontacto", "braker",
      "breaker", "fusible", "tierra fisica", "tablero", "cableado",
      "malla", "teja", "impermeabilizar", "impermeabilizante", "mortero",
      "varilla", "block", "ladrillo", "tabique", "relleno", "grava",
      "arena", "mezcla", "concreto", "fierro"
    ]
  },
  {
    categoria_operativa:  "CAPEX / Equipamiento",
    categoria_contable:   "Inversión en activo fijo",
    clave_sat:            "AF",
    tratamiento_fiscal:   "Revisar capitalización o depreciación (Art. 34 LISR)",
    keywords: [
      "colgante", "lampara decorativa", "mueble", "silla", "mesa",
      "colchon", "base cama", "frigobar", "refrigerador", "microondas",
      "estufa", "boiler", "calentador", "minisplit", "aire acondicionado",
      "tv", "pantalla", "sofa", "cama", "cabecera", "buro", "comoda",
      "closet", "armario", "ventilador techo", "tinaco", "cisterna",
      "extractora", "campana", "lavadora", "secadora", "lavavajillas",
      "horno", "cafetera", "licuadora", "tostador", "router", "modem",
      "telefono", "tablet", "laptop", "computadora", "impresora", "camara",
      "sensor", "cerradura electrica", "timbre", "alarma", "cctv"
    ]
  },
  {
    categoria_operativa:  "Limpieza",
    categoria_contable:   "Materiales de limpieza y aseo",
    clave_sat:            "LC",
    tratamiento_fiscal:   "Gasto deducible operativo (Art. 27 LISR)",
    keywords: [
      "cloro", "fabuloso", "pinol", "jabon", "detergente", "suavitel",
      "escoba", "trapeador", "fibra", "esponja", "desinfectante",
      "toalla cocina", "papel higienico", "aromatizante", "ambientador",
      "lysol", "multiusos", "flash", "windex", "brasso", "ajax",
      "bold", "ariel", "persil", "downy", "vim", "cif", "limpiol",
      "mop", "cubeta", "jalador", "recogedor", "bolsa basura",
      "guantes latex", "guantes hule", "franela", "microfibra"
    ]
  },
  {
    categoria_operativa:  "Amenidades huésped",
    categoria_contable:   "Insumos para huéspedes",
    clave_sat:            "HS",
    tratamiento_fiscal:   "Gasto deducible operativo (Art. 27 LISR)",
    keywords: [
      "shampoo", "acondicionador", "gel ducha", "jabon hotel", "jabon tocador",
      "cafe", "cafe soluble", "azucar", "sobre azucar", "agua purificada",
      "botella agua", "jugo", "te", "te de manzanilla", "papas",
      "snack", "bienvenida", "amenidad", "kit bano", "toalla individual",
      "cubrecolchon", "almohada extra", "cobija extra", "funda",
      "sal", "pimienta", "aceite", "vinagre", "condimento"
    ]
  },
  {
    categoria_operativa:  "Papelería / Administración",
    categoria_contable:   "Gastos de papelería y administración",
    clave_sat:            "PA",
    tratamiento_fiscal:   "Gasto deducible operativo (Art. 27 LISR)",
    keywords: [
      "hoja bond", "papel bond", "toner", "tinta", "folder", "pluma",
      "lapiz", "office", "impresora", "clip", "engrapadora", "grapa",
      "post-it", "cuaderno", "libreta", "archivero", "caja archivo",
      "boligrafo", "marcador", "resaltador", "tijeras", "regla", "calculadora"
    ]
  },
  {
    categoria_operativa:  "Herramientas",
    categoria_contable:   "Herramientas y equipo menor",
    clave_sat:            "HE",
    tratamiento_fiscal:   "Gasto deducible o depreciación según valor (Art. 34 LISR)",
    keywords: [
      "taladro", "desarmador", "llave inglesa", "llave allen", "pinzas",
      "martillo", "cincel", "segueta", "sierra", "flexometro", "cinta metrica",
      "nivel", "cutter", "navaja", "brocha", "pistola silicona",
      "remachadora", "soldadora", "esmeriladora", "lijadora", "compresor",
      "hidrolavadora", "escalera", "andamio", "caja herramientas"
    ]
  },
  {
    categoria_operativa:  "Consumibles / Servicios básicos",
    categoria_contable:   "Consumibles y servicios",
    clave_sat:            "CS",
    tratamiento_fiscal:   "Gasto deducible operativo (Art. 27 LISR)",
    keywords: [
      "gas lp", "tanque gas", "cilindro gas", "gasolina", "diesel",
      "pila", "bateria", "foco", "cinta adhesiva", "plástico", "bolsa",
      "caja carton", "unicel", "espuma"
    ]
  }
];

// ─── Normalización ─────────────────────────────────────────────────────────

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Score de coincidencia ─────────────────────────────────────────────────

function scoreRule(text, rule) {
  const t = normalize(text);
  let score = 0;
  const matches = [];

  for (const kw of rule.keywords) {
    const nkw = normalize(kw);
    if (t.includes(nkw)) {
      // palabras más largas pesan más
      score += nkw.split(" ").length + nkw.length / 10;
      matches.push(kw);
    }
  }
  return { score, matches };
}

// ─── Clasificador principal ─────────────────────────────────────────────────

/**
 * @param {string} producto - texto del renglón o descripción del producto
 * @param {string} [tienda]  - nombre de tienda detectado
 * @returns {object} clasificación con score de confianza
 */
function classifyExpense(producto, tienda = "") {
  const combined = `${producto} ${tienda}`;

  let best       = null;
  let bestScore  = 0;

  for (const rule of RULES) {
    const { score, matches } = scoreRule(combined, rule);
    if (score > bestScore) {
      bestScore = score;
      best      = { rule, matches };
    }
  }

  // Confianza: alta (>2), media (>0.5), baja/nula
  let confianza;
  if (bestScore >= 2)   confianza = "Alta";
  else if (bestScore > 0) confianza = "Media";
  else                  confianza = "Sin clasificar";

  if (!best || bestScore === 0) {
    return {
      categoria_operativa:  "Otros / Por clasificar",
      categoria_contable:   "Pendiente de clasificar",
      clave_sat:            "",
      tratamiento_fiscal:   "Revisión contable requerida",
      deducible_sugerido:   "Revisar",
      requiere_revision:    "Sí",
      confianza_clasificacion: "Sin clasificar",
      razon: "No se encontró coincidencia con las reglas definidas"
    };
  }

  const { rule, matches } = best;

  return {
    categoria_operativa:     rule.categoria_operativa,
    categoria_contable:      rule.categoria_contable,
    clave_sat:               rule.clave_sat,
    tratamiento_fiscal:      rule.tratamiento_fiscal,
    deducible_sugerido:      "Sí",
    requiere_revision:       rule.categoria_operativa.includes("CAPEX") || rule.categoria_operativa.includes("Herramientas") ? "Sí" : "No",
    confianza_clasificacion: confianza,
    razon: `Coincidencia [${matches.slice(0, 3).join(", ")}] → ${rule.categoria_operativa}`
  };
}

module.exports = classifyExpense;
