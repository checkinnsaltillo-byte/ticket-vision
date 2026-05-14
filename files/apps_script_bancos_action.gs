// ─────────────────────────────────────────────────────────────────────────────
// FRAGMENTO PARA AGREGAR AL APPS SCRIPT DE TICKET VISION
// Agrega este case dentro del switch(action) de tu función doPost(e)
// ─────────────────────────────────────────────────────────────────────────────

// En tu doPost(e), dentro del switch(action), agrega:
//
//   case "get_bancos_data":
//     return getBancosData(ss);
//
// Y pega la función getBancosData aquí abajo, fuera del doPost.

// ─────────────────────────────────────────────────────────────────────────────
// CASE para agregar al switch(action) del doPost:
//   case "save_banco_clasificacion":
//     return saveBancoClasificacion(ss, JSON.parse(e.postData.contents));
// ─────────────────────────────────────────────────────────────────────────────

function saveBancoClasificacion(ss, data) {
  const norm = (s) => (s ?? "").toString()
    .replace(/[​-‍﻿]/g, "")
    .replace(/ /g, " ")
    .trim()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase();

  const shB = ss.getSheets().find(sh => norm(sh.getName()) === "BANCOS") ||
              ss.getSheets().find(sh => norm(sh.getName()).includes("BANCOS"));
  if (!shB) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: "sheet_not_found", message: "No se encontró la hoja BANCOS" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const rowNum = Number(data.rowNum);
  if (!rowNum || rowNum < 2) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: "invalid_row", message: "rowNum inválido: " + data.rowNum }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const lastCol    = shB.getLastColumn();
  const headerRow  = shB.getRange(1, 1, 1, lastCol).getValues()[0];

  // Columnas de clasificación a garantizar en el header
  const CLASIF_COLS = [
    "CUENTA_CONTABLE", "SUBCUENTA_CLASIF", "CATEGORIA_GASTO",
    "CONCEPTO_CLASIF", "PROPIEDAD", "DEPARTAMENTO",
    "ENCARGADO", "DEDUCIBLE", "REEMBOLSO", "REEMBOLSO_A",
    "METODO_PAGO", "CLASIFICADO_POR", "FECHA_CLASIF"
  ];

  // Asegurar que existan los headers; si no, crearlos al final
  const getOrCreateCol = (name) => {
    const normName = norm(name);
    let idx = headerRow.findIndex(h => norm(h) === normName);
    if (idx >= 0) return idx + 1; // 1-based
    // Agregar columna nueva al final
    const newCol = shB.getLastColumn() + 1;
    shB.getRange(1, newCol).setValue(name);
    headerRow.push(name); // mantener sincronía local
    return newCol;
  };

  const colMap = {};
  for (const col of CLASIF_COLS) {
    colMap[col] = getOrCreateCol(col);
  }

  const c  = data.clasificacion || {};
  const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");

  const writeCell = (colName, value) => {
    const col = colMap[colName];
    if (col) shB.getRange(rowNum, col).setValue(value ?? "");
  };

  writeCell("CUENTA_CONTABLE",  c.cuenta          || "");
  writeCell("SUBCUENTA_CLASIF", c.subcuenta        || "");
  writeCell("CATEGORIA_GASTO",  c.categoria_gasto  || "");
  writeCell("CONCEPTO_CLASIF",  c.concepto         || "");
  writeCell("PROPIEDAD",        c.propiedad        || "");
  writeCell("DEPARTAMENTO",     c.departamento     || "");
  writeCell("ENCARGADO",        c.encargado        || "");
  writeCell("DEDUCIBLE",        c.deducible        || "");
  writeCell("REEMBOLSO",        c.reembolso        || "");
  writeCell("REEMBOLSO_A",      c.reembolso_a      || "");
  writeCell("METODO_PAGO",      c.metodo_pago      || "");
  writeCell("CLASIFICADO_POR",  c.clasificado_por  || "");
  writeCell("FECHA_CLASIF",     now);

  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, rowNum, columnsWritten: Object.keys(colMap).length }))
    .setMimeType(ContentService.MimeType.JSON);
}

function getBancosData(ss) {
  const norm = (s) => (s ?? "").toString()
    .replace(/[​-‍﻿]/g, "")
    .replace(/ /g, " ")
    .trim()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase();

  const pickSheet = (names) => {
    const sheets = ss.getSheets();
    const wanted = names.map(norm);
    for (const sh of sheets) {
      const n = norm(sh.getName());
      if (wanted.includes(n)) return sh;
    }
    for (const sh of sheets) {
      const n = norm(sh.getName());
      if (wanted.some(w => n.includes(w) || w.includes(n))) return sh;
    }
    return null;
  };

  const pickIdx = (headers, names) => {
    const H = headers.map(norm);
    for (const n of names) {
      const i = H.indexOf(norm(n));
      if (i >= 0) return i;
    }
    for (const n of names) {
      const key = norm(n);
      const j = H.findIndex(h => h.includes(key));
      if (j >= 0) return j;
    }
    return -1;
  };

  const toNumber = (v) => {
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    const s = (v ?? "").toString().trim();
    if (!s) return 0;
    const n = Number(s.replace(/[^0-9\-\.]/g, ""));
    return Number.isFinite(n) ? n : 0;
  };

  const shB = pickSheet(["BANCOS"]);
  const shP = pickSheet(["PRESUPUESTO_SYS", "PRESUPUESTO SYS", "PRESUPUESTO", "PRESUPUESTOS"]);

  if (!shB || !shP) {
    return ContentService
      .createTextOutput(JSON.stringify({
        ok: false,
        error: "sheet_not_found",
        message: "No se encontraron las hojas BANCOS o Presupuesto_sys en el Google Sheet"
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const bancos = shB.getDataRange().getValues();
  const pres   = shP.getDataRange().getValues();
  const hB = bancos[0] || [];
  const hP = pres[0]   || [];

  // ── BANCOS ──────────────────────────────────────────────────────────────────
  const iAno  = pickIdx(hB, ["AÑO", "ANO", "ANIO", "YEAR"]);
  const iMes  = pickIdx(hB, ["MES"]);
  const iDia  = pickIdx(hB, ["DÍA", "DIA", "DIA DE OPERACION", "FECHA"]);
  const iCta  = pickIdx(hB, ["CUENTA BANCARIA", "CUENTA"]);
  const iTipo = pickIdx(hB, ["TIPO"]);
  const iCat  = pickIdx(hB, ["CATEGORIA", "CATEGORÍA"]);
  const iCon  = pickIdx(hB, ["CONCEPTO"]);
  const iDes  = pickIdx(hB, ["DESCRIPCION", "DESCRIPCIÓN"]);
  const iFac  = pickIdx(hB, ["FACTURA"]);
  const iMon  = pickIdx(hB, ["MONTO"]);

  const records = bancos.slice(1)
    .filter(r => r.join("").toString().trim() !== "")
    .map((r, i) => {
      const rowNum = i + 2; // fila real en el sheet (fila 1 = encabezados)
      // Helper: formatea una celda fecha a string legible
      const fmtDate = (v) => {
        if (!v && v !== 0) return "";
        if (v instanceof Date) {
          const yy = v.getFullYear(), mm = String(v.getMonth()+1).padStart(2,"0"), dd = String(v.getDate()).padStart(2,"0");
          return `${yy}-${mm}-${dd}`;
        }
        return String(v).trim();
      };
      const MESES_ES = ["","enero","febrero","marzo","abril","mayo","junio",
                        "julio","agosto","septiembre","octubre","noviembre","diciembre"];
      const fmtMes = (v) => {
        if (!v) return "";
        if (v instanceof Date) return `${MESES_ES[v.getMonth()+1]} ${v.getFullYear()}`;
        return String(v).trim();
      };
      const factura = (iFac >= 0 ? r[iFac] : "") || "";
      return {
        Año:              iAno  >= 0 ? String(r[iAno]).trim()  : "",
        Mes:              iMes  >= 0 ? fmtMes(r[iMes])         : "",
        Día:              iDia  >= 0 ? fmtDate(r[iDia])        : "",
        "Cuenta bancaria": iCta >= 0 ? String(r[iCta]).trim()  : "",
        TIPO:             iTipo >= 0 ? String(r[iTipo]).trim() : "",
        CATEGORIA:        iCat  >= 0 ? String(r[iCat]).trim()  : "",
        CONCEPTO:         iCon  >= 0 ? String(r[iCon]).trim()  : "",
        DESCRIPCION:      iDes  >= 0 ? String(r[iDes]).trim()  : "",
        Factura:          String(factura).trim(),
        FacturaFlag:      String(factura).trim().length ? "Con factura" : "Sin factura",
        Monto:            toNumber(iMon >= 0 ? r[iMon] : 0),
        rowNum:           rowNum   // número de fila en el sheet para actualizaciones
      };
    });

  // ── PRESUPUESTO_SYS ─────────────────────────────────────────────────────────
  // Columnas esperadas: CUENTA, TIPO, PERIODICIDAD, NATURALEZA, SUBCUENTA,
  //                     CATEGORIA, CONCEPTO, DESCRIPCION, CONCATENADO,
  //                     SEMANAL, MENSUAL, BIMESTRAL, ANUAL
  const iCuentaP = pickIdx(hP, ["CUENTA"]);           // Egresos / Ingresos / Activos…
  const iTipoP   = pickIdx(hP, ["TIPO"]);             // Fijo / Variable
  const iSubP    = pickIdx(hP, ["SUBCUENTA", "SUB-CUENTA"]);
  const iCatP    = pickIdx(hP, ["CATEGORIA", "CATEGORÍA"]);
  const iConP    = pickIdx(hP, ["CONCEPTO"]);
  const iDesP    = pickIdx(hP, ["DESCRIPCION", "DESCRIPCIÓN"]);
  const iConcP   = pickIdx(hP, ["CONCATENADO"]);
  const iSemP    = pickIdx(hP, ["SEMANAL"]);
  const iMenP    = pickIdx(hP, ["MENSUAL", "PRESUPUESTO MENSUAL"]);
  const iBimP    = pickIdx(hP, ["BIMESTRAL"]);
  const iAnuP    = pickIdx(hP, ["ANUAL", "PRESUPUESTO ANUAL"]);

  const budget = pres.slice(1)
    .filter(r => r.join("").toString().trim() !== "")
    .filter(r => {
      // Excluir filas de subtotal
      const cuenta = norm(iCuentaP >= 0 ? r[iCuentaP] : "");
      const cat    = norm(iCatP    >= 0 ? r[iCatP]    : "");
      const con    = norm(iConP    >= 0 ? r[iConP]    : "");
      return !(cuenta.startsWith("SUBTOTAL") || cat.startsWith("SUBTOTAL") || con.startsWith("SUBTOTAL"));
    })
    .map(r => ({
      TIPO:       iCuentaP >= 0 ? String(r[iCuentaP]).trim() : "",  // Egresos/Ingresos
      SUBCUENTA:  iSubP    >= 0 ? String(r[iSubP]).trim()    : "",
      CATEGORIA:  iCatP    >= 0 ? String(r[iCatP]).trim()    : "",
      CONCEPTO:   iConP    >= 0 ? String(r[iConP]).trim()    : "",
      DESCRIPCION:iDesP    >= 0 ? String(r[iDesP]).trim()    : "",
      CONCATENADO:iConcP   >= 0 ? String(r[iConcP]).trim()   : "",
      SEMANAL:    toNumber(iSemP >= 0 ? r[iSemP] : 0),
      MENSUAL:    toNumber(iMenP >= 0 ? r[iMenP] : 0),
      BIMESTRAL:  toNumber(iBimP >= 0 ? r[iBimP] : 0),
      ANUAL:      toNumber(iAnuP >= 0 ? r[iAnuP] : 0)
    }))
    .filter(r => r.CATEGORIA || r.CONCEPTO || r.MENSUAL || r.ANUAL);

  return ContentService
    .createTextOutput(JSON.stringify({
      ok: true,
      sourceSheets: { bancos: shB.getName(), presupuesto: shP.getName() },
      counts:       { records: records.length, budget: budget.length },
      records,
      budget
    }))
    .setMimeType(ContentService.MimeType.JSON);
}
