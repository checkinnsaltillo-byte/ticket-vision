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
  const iCta  = pickIdx(hB, ["CUENTA BANCARIA", "CUENTA"]);
  const iTipo = pickIdx(hB, ["TIPO"]);
  const iCat  = pickIdx(hB, ["CATEGORIA", "CATEGORÍA"]);
  const iCon  = pickIdx(hB, ["CONCEPTO"]);
  const iDes  = pickIdx(hB, ["DESCRIPCION", "DESCRIPCIÓN"]);
  const iFac  = pickIdx(hB, ["FACTURA"]);
  const iMon  = pickIdx(hB, ["MONTO"]);

  const records = bancos.slice(1)
    .filter(r => r.join("").toString().trim() !== "")
    .map(r => {
      const factura = (iFac >= 0 ? r[iFac] : "") || "";
      return {
        Año:              iAno  >= 0 ? String(r[iAno]).trim()  : "",
        Mes:              iMes  >= 0 ? String(r[iMes]).trim()  : "",
        "Cuenta bancaria": iCta >= 0 ? String(r[iCta]).trim()  : "",
        TIPO:             iTipo >= 0 ? String(r[iTipo]).trim() : "",
        CATEGORIA:        iCat  >= 0 ? String(r[iCat]).trim()  : "",
        CONCEPTO:         iCon  >= 0 ? String(r[iCon]).trim()  : "",
        DESCRIPCION:      iDes  >= 0 ? String(r[iDes]).trim()  : "",
        Factura:          String(factura).trim(),
        FacturaFlag:      String(factura).trim().length ? "Con factura" : "Sin factura",
        Monto:            toNumber(iMon >= 0 ? r[iMon] : 0)
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
