const RULES = [
  {
    categoria_operativa: "Mantenimiento",
    categoria_contable: "Reparaciones y mantenimiento",
    tratamiento_fiscal: "Gasto deducible operativo",
    keywords: [
      "mezcladora", "fregadero", "cespol", "céspol", "manguera", "gas",
      "plomeria", "plomería", "llave", "valvula", "válvula", "tubo",
      "cinta", "aislar", "silicon", "silicón", "sellador", "pintura",
      "impermeabilizante", "chapas", "cerradura", "resane", "cemento"
    ]
  },
  {
    categoria_operativa: "CAPEX / Equipamiento",
    categoria_contable: "Inversión en activo / equipamiento",
    tratamiento_fiscal: "Revisar capitalización o depreciación",
    keywords: [
      "colgante", "lampara", "lámpara", "led", "mueble", "silla", "mesa",
      "colchon", "colchón", "base", "frigobar", "refrigerador", "microondas",
      "estufa", "boiler", "calentador", "minisplit", "aire acondicionado",
      "tv", "pantalla", "sofa", "sofá", "cama", "cabecera"
    ]
  },
  {
    categoria_operativa: "Limpieza",
    categoria_contable: "Materiales de limpieza",
    tratamiento_fiscal: "Gasto deducible operativo",
    keywords: [
      "cloro", "fabuloso", "pinol", "jabon", "jabón", "detergente",
      "escoba", "trapeador", "fibra", "esponja", "desinfectante",
      "toalla", "papel higienico", "papel higiénico", "aromatizante"
    ]
  },
  {
    categoria_operativa: "Amenidades huésped",
    categoria_contable: "Insumos para huéspedes",
    tratamiento_fiscal: "Gasto deducible operativo",
    keywords: [
      "shampoo", "acondicionador", "gel", "jabon hotel", "jabón hotel",
      "cafe", "café", "azucar", "azúcar", "agua", "botella"
    ]
  },
  {
    categoria_operativa: "Papelería / Administración",
    categoria_contable: "Gastos administrativos",
    tratamiento_fiscal: "Gasto deducible operativo",
    keywords: [
      "hoja", "papel", "toner", "tóner", "tinta", "folder", "pluma",
      "lapiz", "lápiz", "office", "impresora"
    ]
  }
];

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function classifyExpense(producto, tienda = "") {
  const p = normalize(`${producto} ${tienda}`);

  for (const rule of RULES) {
    if (rule.keywords.some(k => p.includes(normalize(k)))) {
      return {
        categoria_operativa: rule.categoria_operativa,
        categoria_contable: rule.categoria_contable,
        tratamiento_fiscal: rule.tratamiento_fiscal,
        deducible_sugerido: "Sí",
        requiere_revision: rule.categoria_operativa.includes("CAPEX") ? "Sí" : "No",
        razon: `Coincidencia por palabras clave: ${rule.categoria_operativa}`
      };
    }
  }

  return {
    categoria_operativa: "Otros / Por clasificar",
    categoria_contable: "Pendiente de clasificar",
    tratamiento_fiscal: "Revisión contable requerida",
    deducible_sugerido: "Revisar",
    requiere_revision: "Sí",
    razon: "No se encontró regla suficiente para clasificar automáticamente"
  };
}

module.exports = classifyExpense;
