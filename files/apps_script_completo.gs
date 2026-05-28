const SHEET_ID  = "1f_rdwQncSUXRNEvp5kM_kjyX1S-NnY7UE2z4HGvFL3Q";
const MESES_ES  = ["Enero","Febrero","Marzo","Abril","Mayo","Junio",
                   "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

// ─── Punto de entrada ─────────────────────────────────────────────────────────
function doPost(e) {
  try {
    var data   = JSON.parse(e.postData.contents);
    var action = data.action;
    if (action === "upload_ticket_image")          return respond(uploadTicketImage_(data));
    if (action === "append_rows")                  return respond(appendRows_(data));
    if (action === "get_tickets_index")            return respond(getTicketsIndex_());
    if (action === "get_all_tickets")              return respond(getAllTickets_());
    if (action === "update_ticket_classification") return respond(updateTicketClassification_(data));
    if (action === "delete_ticket")                return respond(deleteTicket_(data));
    if (action === "get_bancos_data")              return respond(getBancosData_(SpreadsheetApp.openById(SHEET_ID)));
    if (action === "save_banco_clasificacion")     return respond(saveBancoClasificacion_(SpreadsheetApp.openById(SHEET_ID), data));
    if (action === "save_presupuesto")             return respond(savePresupuesto_(SpreadsheetApp.openById(SHEET_ID), data));
    if (action === "get_huespedes_data")           return respond(getHuespedesData_(SpreadsheetApp.openById(SHEET_ID)));
    return respond({ ok: false, error: "Acción desconocida: " + action });
  } catch (err) {
    return respond({ ok: false, error: err.message });
  }
}

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── Subir imagen de ticket a Drive ──────────────────────────────────────────
function uploadTicketImage_(data) {
  var fileObj = data.file;
  if (!fileObj || !fileObj.base64) return { ok: false, error: "Sin base64" };
  var rawFecha = data.fecha || new Date().toISOString().slice(0, 10);
  var parts    = rawFecha.split("-");
  var anio     = parts[0] || String(new Date().getFullYear());
  var mes      = parseInt(parts[1] || "1", 10);
  var mesStr   = MESES_ES[mes - 1] || "Enero";
  var tienda   = (data.tienda || "sin_tienda").slice(0, 50).replace(/[\/\\:*?"<>|]/g, "_");
  var ts   = Utilities.formatDate(new Date(), "America/Monterrey", "yyyyMMdd_HHmmss");
  var ext  = (fileObj.fileName || ".jpg").split(".").pop().toLowerCase();
  var name = tienda.replace(/\s+/g, "_").slice(0, 30) + "_" + ts + "." + ext;
  var folder = DriveApp.getRootFolder();
  folder = getOrCreate_(folder, "Check Inn - Sistemas");
  folder = getOrCreate_(folder, "Ticket vision");
  folder = getOrCreate_(folder, "Codigo");
  folder = getOrCreate_(folder, "tickets_images");
  folder = getOrCreate_(folder, anio);
  folder = getOrCreate_(folder, mesStr);
  folder = getOrCreate_(folder, tienda);
  var bytes = Utilities.base64Decode(fileObj.base64);
  var blob  = Utilities.newBlob(bytes, fileObj.mimeType || "image/jpeg", name);
  var file  = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { ok: true, url: file.getUrl(), id: file.getId(), name: file.getName() };
}

function getOrCreate_(parent, name) {
  var iter = parent.getFoldersByName(name);
  if (iter.hasNext()) return iter.next();
  return parent.createFolder(name);
}

// ─── Agregar filas a Sheets ───────────────────────────────────────────────────
function appendRows_(data) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  if (data.productos && data.productos.length) appendToSheet_(ss, "Transcripcion",   data.productos);
  if (data.resumen   && data.resumen.length)   appendToSheet_(ss, "Resumen tickets", data.resumen);
  if (data.cruce     && data.cruce.length)     appendToSheet_(ss, "Cruce bancario",  data.cruce);
  return { ok: true };
}

function appendToSheet_(ss, sheetName, rows) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(Object.keys(rows[0]));
  } else {
    var lastCol = sheet.getLastColumn();
    var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    Object.keys(rows[0]).forEach(function(k) {
      if (headers.indexOf(k) === -1) {
        lastCol++;
        sheet.getRange(1, lastCol).setValue(k);
        headers.push(k);
      }
    });
  }
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  rows.forEach(function(row) {
    var values = headers.map(function(h) {
      var v = row[h];
      return (v === undefined || v === null) ? "" : v;
    });
    sheet.appendRow(values);
  });
}

// ─── Índice para detección de duplicados ─────────────────────────────────────
function getTicketsIndex_() {
  var ss    = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName("Resumen tickets");
  if (!sheet || sheet.getLastRow() < 2) return { ok: true, tickets: [] };
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var rows    = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var idx = {};
  ["tienda","fecha","total","folio","archivo_hash"].forEach(function(k) {
    idx[k] = headers.indexOf(k);
  });
  var tickets = rows.map(function(row) {
    var rawFecha = idx.fecha >= 0 ? row[idx.fecha] : "";
    var fecha = rawFecha instanceof Date
      ? Utilities.formatDate(rawFecha, "America/Monterrey", "yyyy-MM-dd")
      : String(rawFecha || "");
    return {
      tienda:       idx.tienda       >= 0 ? String(row[idx.tienda]       || "") : "",
      fecha:        fecha,
      total:        idx.total        >= 0 ? Number(row[idx.total]        || 0)  : 0,
      folio:        idx.folio        >= 0 ? String(row[idx.folio]        || "") : "",
      archivo_hash: idx.archivo_hash >= 0 ? String(row[idx.archivo_hash] || "") : "",
    };
  }).filter(function(t) { return t.tienda || t.fecha || t.archivo_hash; });
  return { ok: true, tickets: tickets };
}

// ─── Dashboard: todos los tickets ────────────────────────────────────────────
function getAllTickets_() {
  var ss           = SpreadsheetApp.openById(SHEET_ID);
  var resumenSheet = ss.getSheetByName("Resumen tickets");
  if (!resumenSheet || resumenSheet.getLastRow() < 2) return { ok: true, tickets: [] };

  var lastCol = resumenSheet.getLastColumn();
  var headers = resumenSheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var rows    = resumenSheet.getRange(2, 1, resumenSheet.getLastRow() - 1, lastCol).getValues();

  var productsByTicket = {};
  var transcSheet = ss.getSheetByName("Transcripcion");
  if (transcSheet && transcSheet.getLastRow() > 1) {
    var tLastCol = transcSheet.getLastColumn();
    var tHeaders = transcSheet.getRange(1, 1, 1, tLastCol).getValues()[0];
    var tRows    = transcSheet.getRange(2, 1, transcSheet.getLastRow() - 1, tLastCol).getValues();
    var tidIdx   = tHeaders.indexOf("ticket_id");
    var lineaIdx = tHeaders.indexOf("linea_numero");
    var descIdx  = tHeaders.indexOf("descripcion");
    var cantIdx  = tHeaders.indexOf("cantidad");
    var puIdx    = tHeaders.indexOf("precio_unitario");
    var montoIdx = tHeaders.indexOf("monto");
    tRows.forEach(function(tr) {
      var tid = String(tr[tidIdx] || "");
      if (!tid) return;
      if (!productsByTicket[tid]) productsByTicket[tid] = [];
      productsByTicket[tid].push({
        linea_numero:    lineaIdx >= 0 ? tr[lineaIdx]               : "",
        descripcion:     descIdx  >= 0 ? String(tr[descIdx]  || "") : "",
        cantidad:        cantIdx  >= 0 ? tr[cantIdx]               : "",
        precio_unitario: puIdx    >= 0 ? tr[puIdx]                 : "",
        monto:           montoIdx >= 0 ? tr[montoIdx]              : ""
      });
    });
  }

  var tickets = rows.map(function(row) {
    var resumen = {};
    headers.forEach(function(h, j) {
      var v = row[j];
      if (v instanceof Date) {
        if (v.getFullYear() <= 1900) {
          v = Utilities.formatDate(v, "America/Monterrey", "HH:mm");
        } else {
          v = Utilities.formatDate(v, "America/Monterrey", "yyyy-MM-dd");
        }
      }
      resumen[h] = (v === null || v === undefined) ? "" : v;
    });
    var tid = String(resumen.ticket_id || "");
    return { ticket_id: tid, resumen: resumen, productos: productsByTicket[tid] || [] };
  }).filter(function(t) { return t.ticket_id; });

  return { ok: true, tickets: tickets };
}

// ─── Dashboard: actualizar clasificación de ticket existente ─────────────────
function updateTicketClassification_(data) {
  var ticketId = String(data.ticket_id || "");
  var clasif   = data.clasificacion      || {};
  var prodsEd  = data.productos_editados || [];
  if (!ticketId) return { ok: false, error: "ticket_id requerido" };

  var ss = SpreadsheetApp.openById(SHEET_ID);

  // ── Resumen tickets ──────────────────────────────────────────────────────
  var sheetR = ss.getSheetByName("Resumen tickets");
  if (sheetR && sheetR.getLastRow() > 1) {
    var lastColR = sheetR.getLastColumn();
    var headR    = sheetR.getRange(1, 1, 1, lastColR).getValues()[0];
    var rowsR    = sheetR.getRange(2, 1, sheetR.getLastRow() - 1, lastColR).getValues();
    var idColR   = headR.indexOf("ticket_id");
    var CAMPOS_R = [
      "fecha","cuenta","subcuenta","categoria_gasto","concepto",
      "propiedad","departamento","comprador","deducible","reembolso",
      "reembolso_a","metodo_pago","detalles_operacion","comentarios",
      "tienda","rfc","hora","folio","tarjeta_ultimos4",
      "subtotal","iva","ieps","descuentos","total","clasificado_por"
    ];
    for (var r = 0; r < rowsR.length; r++) {
      if (String(rowsR[r][idColR]) === ticketId) {
        CAMPOS_R.forEach(function(campo) {
          if (clasif.hasOwnProperty(campo)) {
            var col = headR.indexOf(campo);
            if (col >= 0) sheetR.getRange(r + 2, col + 1).setValue(clasif[campo]);
          }
        });
        break;
      }
    }
  }

  // ── Transcripcion: clasificación + ediciones de productos ────────────────
  var sheetP = ss.getSheetByName("Transcripcion");
  if (sheetP && sheetP.getLastRow() > 1) {
    var lastColP = sheetP.getLastColumn();
    var headP    = sheetP.getRange(1, 1, 1, lastColP).getValues()[0];
    var rowsP    = sheetP.getRange(2, 1, sheetP.getLastRow() - 1, lastColP).getValues();
    var idColP   = headP.indexOf("ticket_id");
    var lineaCol = headP.indexOf("linea_numero");
    var CAMPOS_P = ["cuenta","subcuenta","categoria_gasto","concepto",
                    "propiedad","departamento","comprador","comentarios"];
    var editMap = {};
    prodsEd.forEach(function(pe) {
      editMap[String(pe.linea_numero)] = pe;
    });
    for (var p = 0; p < rowsP.length; p++) {
      if (String(rowsP[p][idColP]) === ticketId) {
        CAMPOS_P.forEach(function(campo) {
          if (clasif.hasOwnProperty(campo)) {
            var col = headP.indexOf(campo);
            if (col >= 0) sheetP.getRange(p + 2, col + 1).setValue(clasif[campo]);
          }
        });
        if (lineaCol >= 0) {
          var lineaNum = String(rowsP[p][lineaCol] || "");
          var pe = editMap[lineaNum];
          if (pe) {
            ["descripcion","cantidad","precio_unitario","monto"].forEach(function(campo) {
              if (pe.hasOwnProperty(campo)) {
                var col = headP.indexOf(campo);
                if (col >= 0) sheetP.getRange(p + 2, col + 1).setValue(pe[campo]);
              }
            });
          }
        }
      }
    }
  }

  return { ok: true };
}

// ─── Eliminar un ticket de Sheets ─────────────────────────────────────────────
function deleteTicket_(data) {
  var ticketId = String(data.ticket_id || "");
  if (!ticketId) return { ok: false, error: "ticket_id requerido" };

  var ss         = SpreadsheetApp.openById(SHEET_ID);
  var sheetNames = ["Transcripcion", "Resumen tickets", "Cruce bancario"];

  sheetNames.forEach(function(name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) return;
    var values = sheet.getDataRange().getValues();
    if (values.length < 2) return;
    var col = values[0].indexOf("ticket_id");
    if (col === -1) return;
    for (var r = values.length - 1; r >= 1; r--) {
      if (String(values[r][col]) === ticketId) {
        sheet.deleteRow(r + 1);
      }
    }
  });

  return { ok: true };
}

// ─── Registros contables: leer BANCOS + Presupuesto_sys ───────────────────────
function getBancosData_(ss) {
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

  // Formatea cualquier valor de fecha a "YYYY-MM-DD" (ISO)
  // Usa Utilities.formatDate para Date objects — evita errores de timezone
  const TZ = Session.getScriptTimeZone();
  const fmtDate = (v) => {
    if (!v && v !== 0) return "";
    if (v instanceof Date) {
      // Utilities.formatDate respeta el timezone del script (no hay bug de UTC vs local)
      return Utilities.formatDate(v, TZ, "yyyy-MM-dd");
    }
    const s = String(v).trim();
    if (!s) return "";
    // Ya es YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
    // DD/MM/YYYY o D/M/YYYY (formato mexicano en texto)
    const ddmm = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (ddmm) return `${ddmm[3]}-${ddmm[2].padStart(2,"0")}-${ddmm[1].padStart(2,"0")}`;
    // "Wed Jan 01 2025 00:00:00 GMT-0600..." — string de Date.toString()
    if (s.includes("GMT") || /^\w{3}\s\w{3}\s\d/.test(s)) {
      try { return Utilities.formatDate(new Date(s), TZ, "yyyy-MM-dd"); } catch(e) {}
    }
    return s;
  };

  // Formatea celda de mes a "enero 2026"
  const MESES_MIN = ["","enero","febrero","marzo","abril","mayo","junio",
                     "julio","agosto","septiembre","octubre","noviembre","diciembre"];
  const fmtMes = (v) => {
    if (!v) return "";
    if (v instanceof Date) return `${MESES_MIN[v.getMonth() + 1]} ${v.getFullYear()}`;
    return String(v).trim();
  };

  const shB = pickSheet(["BANCOS"]);
  const shP = pickSheet(["PRESUPUESTO_SYS", "PRESUPUESTO SYS", "PRESUPUESTO", "PRESUPUESTOS"]);

  if (!shB || !shP) {
    return {
      ok: false,
      error: "sheet_not_found",
      message: "No se encontraron las hojas BANCOS o Presupuesto_sys"
    };
  }

  // Migración + ensure de columnas de clasificación.
  //   - Antes: VALIDADO (botón ⚠/duda) y REVISADO (botón ✓)
  //   - Ahora: DUDA (botón ?) y VALIDADO (botón ✓)
  // Si las columnas antiguas existen, se renombran preservando los datos.
  (function migrateAndEnsureCols(){
    const lastCol = shB.getLastColumn();
    if (lastCol < 1) return;
    let headers = shB.getRange(1, 1, 1, shB.getLastColumn()).getValues()[0]
      .map(h => String(h ?? "").trim().toUpperCase());

    // Migración paso 1: si no existe DUDA y sí existe VALIDADO viejo,
    // renombrar VALIDADO → DUDA (datos preservados).
    if (!headers.includes("DUDA") && headers.includes("VALIDADO")) {
      const idx = headers.indexOf("VALIDADO");
      shB.getRange(1, idx + 1).setValue("DUDA");
      headers[idx] = "DUDA";
    }
    // Migración paso 2: ahora VALIDADO no existe → renombrar REVISADO → VALIDADO
    if (!headers.includes("VALIDADO") && headers.includes("REVISADO")) {
      const idx = headers.indexOf("REVISADO");
      shB.getRange(1, idx + 1).setValue("VALIDADO");
      headers[idx] = "VALIDADO";
    }

    // Crear las que falten
    const REQ = ["CUENTA","SUBCUENTA","CATEGORIA","CONCEPTO","PROPIEDAD","DEPARTAMENTO",
                 "ENCARGADO","DEDUCIBLE","REEMBOLSO","REEMBOLSO_A","METODO_PAGO",
                 "CLASIFICADO_POR","FECHA_CLASIF","DUDA","VALIDADO"];
    REQ.forEach(name => {
      if (!headers.includes(name)) {
        const newCol = shB.getLastColumn() + 1;
        shB.getRange(1, newCol).setValue(name);
        headers.push(name);
      }
    });
  })();

  const bancos        = shB.getDataRange().getValues();
  const bancosDisplay = shB.getDataRange().getDisplayValues(); // texto tal como aparece en celda
  const pres          = shP.getDataRange().getValues();
  const hB = bancos[0] || [];
  const hP = pres[0]   || [];

  // ── Índices columnas BANCOS — todos por nombre exacto (sin posición) ──────
  const iAno    = pickIdx(hB, ["AÑO", "ANO", "ANIO", "YEAR"]);
  const iMes    = pickIdx(hB, ["MES"]);
  const iDia    = pickIdx(hB, ["DÍA", "DIA", "DIA DE OPERACION", "FECHA"]);
  const iCta    = pickIdx(hB, ["CUENTA BANCARIA"]);
  const iCuenta = pickIdx(hB, ["CUENTA"]);
  const iSub    = pickIdx(hB, ["SUBCUENTA", "SUB-CUENTA"]);
  const iCat    = pickIdx(hB, ["CATEGORIA", "CATEGORÍA"]);
  // Descripción bancaria: "DESCRIPCION" es el título principal del registro
  const iDes    = pickIdx(hB, ["DESCRIPCION", "DESCRIPCIÓN"]);
  // Concepto de referencia bancaria (columna renombrada de "Concepto / Referencia")
  const iConRef = pickIdx(hB, ["CONCEPTO / REFERENCIA", "CONCEPTO/REFERENCIA",
                                "CONCEPTO REFERENCIA", "REFERENCIA", "CONCEPTO"]);
  // Clasificación contable (columna CONCEPTO después de SUBCUENTA/CATEGORIA)
  const iCon    = pickIdx(hB, ["CONCEPTO"]);
  const iFac    = pickIdx(hB, ["FACTURA"]);
  const iMon    = pickIdx(hB, ["MONTO"]);
  const iDud    = pickIdx(hB, ["DUDA"]);
  const iDudN   = pickIdx(hB, ["DUDA_NOTA", "DUDA NOTA", "NOTA_DUDA"]);
  const iVal    = pickIdx(hB, ["VALIDADO"]);
  const iComB   = pickIdx(hB, ["COMENTARIOS", "COMENTARIO"]);

  const records = bancos.slice(1)
    .map((r, i) => ({ r, rowNum: i + 2 }))           // rowNum = índice real en Sheet (antes del filter)
    .filter(({ r }) => r.join("").toString().trim() !== "")
    .map(({ r, rowNum }) => {
      const factura = (iFac >= 0 ? r[iFac] : "") || "";
      // Para Día: usar displayValue (texto exacto de la celda) → evita Date objects
      // bancosDisplay[rowNum-1] porque bancosDisplay incluye header en índice 0
      const diaDisplay = iDia >= 0 ? String(bancosDisplay[rowNum - 1][iDia]).trim() : "";
      return {
        Año:               iAno    >= 0 ? String(r[iAno]).trim()    : "",
        Mes:               iMes    >= 0 ? fmtMes(r[iMes])           : "",
        Día:               diaDisplay,
        "Cuenta bancaria": iCta    >= 0 ? String(r[iCta]).trim()    : "",
        CUENTA:            iCuenta >= 0 ? String(r[iCuenta]).trim() : "",
        SUBCUENTA:         iSub    >= 0 ? String(r[iSub]).trim()    : "",
        CATEGORIA:         iCat    >= 0 ? String(r[iCat]).trim()    : "",
        Concepto:          iConRef >= 0 ? String(r[iConRef]).trim() : "",  // descripción bancaria
        CONCEPTO:          iCon    >= 0 ? String(r[iCon]).trim()    : "",  // clasificación contable
        DESCRIPCION:       iDes    >= 0 ? String(r[iDes]).trim()    : "",
        Factura:           String(factura).trim(),
        FacturaFlag:       String(factura).trim().length ? "Con factura" : "Sin factura",
        Monto:             toNumber(iMon >= 0 ? r[iMon] : 0),
        DUDA:              iDud    >= 0 ? String(r[iDud]).trim()    : "",
        DUDA_NOTA:         iDudN   >= 0 ? String(r[iDudN]).trim()   : "",
        VALIDADO:          iVal    >= 0 ? String(r[iVal]).trim()    : "",
        COMENTARIOS:       iComB   >= 0 ? String(r[iComB]).trim()   : "",
        rowNum:            rowNum
      };
    });

  // ── Índices columnas PRESUPUESTO_SYS ────────────────────────────────────
  const iCuentaP = pickIdx(hP, ["CUENTA"]);
  const iTipoP   = pickIdx(hP, ["TIPO"]);
  const iPerP    = pickIdx(hP, ["PERIODICIDAD"]);
  const iNatP    = pickIdx(hP, ["NATURALEZA"]);
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
      const cuenta = norm(iCuentaP >= 0 ? r[iCuentaP] : "");
      const cat    = norm(iCatP    >= 0 ? r[iCatP]    : "");
      const con    = norm(iConP    >= 0 ? r[iConP]    : "");
      return !(cuenta.startsWith("SUBTOTAL") || cat.startsWith("SUBTOTAL") || con.startsWith("SUBTOTAL"));
    })
    .map(r => ({
      CUENTA:       iCuentaP >= 0 ? String(r[iCuentaP]).trim() : "",
      TIPO:         iTipoP   >= 0 ? String(r[iTipoP]).trim()   : "",
      PERIODICIDAD: iPerP    >= 0 ? String(r[iPerP]).trim()    : "",
      NATURALEZA:   iNatP    >= 0 ? String(r[iNatP]).trim()    : "",
      SUBCUENTA:    iSubP    >= 0 ? String(r[iSubP]).trim()    : "",
      CATEGORIA:    iCatP    >= 0 ? String(r[iCatP]).trim()    : "",
      CONCEPTO:     iConP    >= 0 ? String(r[iConP]).trim()    : "",
      DESCRIPCION:  iDesP    >= 0 ? String(r[iDesP]).trim()    : "",
      CONCATENADO:  iConcP   >= 0 ? String(r[iConcP]).trim()   : "",
      SEMANAL:      toNumber(iSemP >= 0 ? r[iSemP] : 0),
      MENSUAL:      toNumber(iMenP >= 0 ? r[iMenP] : 0),
      BIMESTRAL:    toNumber(iBimP >= 0 ? r[iBimP] : 0),
      ANUAL:        toNumber(iAnuP >= 0 ? r[iAnuP] : 0)
    }))
    .filter(r => r.CUENTA);  // incluir todo renglón que tenga CUENTA

  return {
    ok: true,
    spreadsheetId:  ss.getId(),
    spreadsheetUrl: ss.getUrl(),
    sourceSheets: { bancos: shB.getName(), presupuesto: shP.getName() },
    counts:       { records: records.length, budget: budget.length },
    records,
    budget
  };
}

// ─── Guardar clasificación de un registro bancario en hoja BANCOS ────────────
function saveBancoClasificacion_(ss, data) {
  const norm = (s) => (s ?? "").toString()
    .replace(/[​-‍﻿]/g, "")
    .replace(/ /g, " ")
    .trim()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase();

  // Buscar la hoja BANCOS
  const shB = ss.getSheets().find(sh => norm(sh.getName()) === "BANCOS") ||
              ss.getSheets().find(sh => norm(sh.getName()).includes("BANCOS"));
  if (!shB) {
    return { ok: false, error: "sheet_not_found", message: "No se encontró la hoja BANCOS" };
  }

  // Validar rowNum
  const rowNum = Number(data.rowNum);
  if (!rowNum || rowNum < 2) {
    return { ok: false, error: "invalid_row", message: "rowNum inválido: " + data.rowNum };
  }

  // Columnas destino — usan los nombres EXACTOS que ya existen en la hoja BANCOS.
  // Si alguna no existe aún, se crea al final de las columnas.
  const CLASIF_COLS = [
    "CUENTA", "SUBCUENTA", "CATEGORIA", "CONCEPTO",
    "PROPIEDAD", "DEPARTAMENTO", "ENCARGADO",
    "DEDUCIBLE", "REEMBOLSO", "REEMBOLSO_A",
    "METODO_PAGO", "CLASIFICADO_POR", "FECHA_CLASIF",
    "DUDA", "DUDA_NOTA", "VALIDADO", "COMENTARIOS"
  ];

  // Leer el header actual
  const lastCol   = shB.getLastColumn();
  const headerRow = shB.getRange(1, 1, 1, lastCol).getValues()[0];

  // Obtener o crear columna (devuelve índice 1-based)
  const getOrCreateCol = (colName) => {
    const normName = norm(colName);
    let idx = headerRow.findIndex(h => norm(h) === normName);
    if (idx >= 0) return idx + 1;
    const newCol = shB.getLastColumn() + 1;
    shB.getRange(1, newCol).setValue(colName);
    headerRow.push(colName);
    return newCol;
  };

  // Construir mapa de columnas
  const colMap = {};
  for (const col of CLASIF_COLS) {
    colMap[col] = getOrCreateCol(col);
  }

  const c   = data.clasificacion || {};
  const now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");

  const writeCell = (colName, value) => {
    const col = colMap[colName];
    if (col) shB.getRange(rowNum, col).setValue(value ?? "");
  };

  // Si el frontend pidió actualizar la Descripción, escribirla en columna DESCRIPCION
  if (data.descripcion_edit) {
    const descCol = getOrCreateCol("DESCRIPCION");
    if (descCol) shB.getRange(rowNum, descCol).setValue(data.descripcion || "");
  }

  // Si el frontend pidió actualizar Duda, escribirlo en columna DUDA (+ nota)
  // sin sobrescribir el resto de la clasificación (return temprano)
  if (data.duda_edit) {
    const dudCol = getOrCreateCol("DUDA");
    if (dudCol) shB.getRange(rowNum, dudCol).setValue(data.duda || "");
    if (data.duda_nota !== undefined) {
      const ndCol = getOrCreateCol("DUDA_NOTA");
      if (ndCol) shB.getRange(rowNum, ndCol).setValue(data.duda_nota || "");
    }
    return { ok: true, rowNum: rowNum, duda: data.duda, duda_nota: data.duda_nota || "" };
  }

  // Edición aislada de DUDA_NOTA (sin tocar DUDA ni el resto)
  if (data.duda_nota_edit) {
    const ndCol = getOrCreateCol("DUDA_NOTA");
    if (ndCol) shB.getRange(rowNum, ndCol).setValue(data.duda_nota || "");
    return { ok: true, rowNum: rowNum, duda_nota: data.duda_nota || "" };
  }

  // Si el frontend pidió actualizar Validado, escribirlo en columna VALIDADO
  // sin sobrescribir el resto de la clasificación (return temprano)
  if (data.validado_edit) {
    const valCol = getOrCreateCol("VALIDADO");
    if (valCol) shB.getRange(rowNum, valCol).setValue(data.validado || "");
    return { ok: true, rowNum: rowNum, validado: data.validado };
  }

  // Edición de Fecha del registro (bulk) — escribe en columna DÍA si existe
  if (data.fecha_edit) {
    const headerRow2 = shB.getRange(1, 1, 1, shB.getLastColumn()).getValues()[0];
    let diaCol = -1;
    for (let i = 0; i < headerRow2.length; i++) {
      const n = norm(headerRow2[i]);
      if (n === "DIA" || n === "DÍA" || n === "FECHA") { diaCol = i + 1; break; }
    }
    if (diaCol > 0) {
      // data.descripcion holds the new date in YYYY-MM-DD or rec.Día
      const newDate = data.dia || (data.clasificacion && data.clasificacion.dia) || "";
      shB.getRange(rowNum, diaCol).setValue(newDate);
    }
    return { ok: true, rowNum: rowNum, dia_updated: true };
  }

  writeCell("CUENTA",          c.cuenta          || "");
  writeCell("SUBCUENTA",       c.subcuenta        || "");
  writeCell("CATEGORIA",       c.categoria_gasto  || "");
  writeCell("CONCEPTO",        c.concepto         || "");
  writeCell("PROPIEDAD",       c.propiedad        || "");
  writeCell("DEPARTAMENTO",    c.departamento     || "");
  writeCell("ENCARGADO",       c.encargado        || "");
  writeCell("DEDUCIBLE",       c.deducible        || "");
  writeCell("REEMBOLSO",       c.reembolso        || "");
  writeCell("REEMBOLSO_A",     c.reembolso_a      || "");
  writeCell("METODO_PAGO",     c.metodo_pago      || "");
  writeCell("CLASIFICADO_POR", c.clasificado_por  || "");
  writeCell("FECHA_CLASIF",    now);
  if (c.duda     !== undefined) writeCell("DUDA",     c.duda     || "");
  if (c.duda_nota !== undefined) writeCell("DUDA_NOTA", c.duda_nota || "");
  if (c.validado !== undefined) writeCell("VALIDADO", c.validado || "");
  if (c.comentarios !== undefined) writeCell("COMENTARIOS", c.comentarios || "");

  return { ok: true, rowNum: rowNum, columnsWritten: CLASIF_COLS.length };
}

// ─── Prueba de conexión ───────────────────────────────────────────────────────
function testFinal() {
  var pixel = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=";
  var result = uploadTicketImage_({
    ticket_id: "test-001",
    fecha:     new Date().toISOString().slice(0, 10),
    tienda:    "TEST_STORE",
    file:      { fileName: "test.jpg", mimeType: "image/jpeg", base64: pixel }
  });
  Logger.log(JSON.stringify(result));
}

// ─── Guardar Presupuesto_sys (reescribe la hoja con las filas dadas) ─────────
function savePresupuesto_(ss, data) {
  const norm = (s) => (s ?? "").toString().trim().normalize("NFD").replace(/[̀-ͯ]/g,"").toUpperCase();
  const sh = ss.getSheets().find(s => norm(s.getName()).includes("PRESUPUESTO"));
  if (!sh) return { ok: false, error: "sheet_not_found", message: "No se encontró la hoja Presupuesto_sys" };

  const columns = Array.isArray(data.columns) ? data.columns : [];
  const rows    = Array.isArray(data.rows)    ? data.rows    : [];
  if (!columns.length) return { ok: false, error: "no_columns" };

  // Asegurar que los headers existen y obtener el índice para cada columna
  const lastCol = Math.max(sh.getLastColumn(), columns.length);
  const headerRow = sh.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(h => String(h ?? "").trim());

  const colIdx = {};
  columns.forEach(name => {
    let idx = headerRow.findIndex(h => h.toUpperCase() === String(name).toUpperCase());
    if (idx < 0) {
      const newCol = sh.getLastColumn() + 1;
      sh.getRange(1, newCol).setValue(name);
      headerRow.push(name);
      idx = newCol - 1;
    }
    colIdx[name] = idx;
  });

  // Borrar TODAS las filas de datos existentes (preservando el header)
  const totalLastRow = sh.getLastRow();
  if (totalLastRow >= 2) {
    sh.getRange(2, 1, totalLastRow - 1, Math.max(1, sh.getLastColumn())).clearContent();
  }

  // Escribir las nuevas filas
  if (rows.length) {
    const width = sh.getLastColumn();
    const matrix = rows.map(r => {
      const out = new Array(width).fill("");
      for (const col of columns) {
        const v = r[col];
        out[colIdx[col]] = (v == null) ? "" : v;
      }
      return out;
    });
    sh.getRange(2, 1, matrix.length, width).setValues(matrix);
  }

  return { ok: true, rowsWritten: rows.length };
}

// ─── Información de huéspedes: lee Perfiles + Vehículos + Reservaciones ──────
// Las 3 hojas están en "Ticket Vision — Resultados" (mismo SHEET_ID).
// Devuelve los registros de cada una más una vista unificada por reservación.
function getHuespedesData_(ss) {
  const norm = (s) => (s ?? "").toString()
    .replace(/[​-‍﻿]/g, "")
    .replace(/ /g, " ")
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

  // Lee una hoja completa como array de objetos {header: value}
  const readSheet = (sh) => {
    if (!sh || sh.getLastRow() < 2) return { headers: [], rows: [] };
    const lastCol = sh.getLastColumn();
    const lastRow = sh.getLastRow();
    const values  = sh.getRange(1, 1, lastRow, lastCol).getValues();
    const display = sh.getRange(1, 1, lastRow, lastCol).getDisplayValues();
    const headers = values[0].map(h => String(h ?? "").trim());
    const TZ = Session.getScriptTimeZone();
    const rows = [];
    for (let r = 1; r < values.length; r++) {
      const row = {};
      let anyContent = false;
      for (let c = 0; c < headers.length; c++) {
        if (!headers[c]) continue;
        let v = values[r][c];
        // Fechas → ISO usando displayValue para evitar bug de timezone
        if (v instanceof Date) {
          if (v.getFullYear() <= 1900) {
            v = display[r][c]; // sólo hora (HH:mm)
          } else {
            v = Utilities.formatDate(v, TZ, "yyyy-MM-dd");
          }
        } else if (v == null) {
          v = "";
        } else {
          v = String(v).trim();
        }
        if (v !== "" && v != null) anyContent = true;
        row[headers[c]] = v;
      }
      if (anyContent) {
        row._rowNum = r + 1;
        rows.push(row);
      }
    }
    return { headers, rows };
  };

  const shPerfiles      = pickSheet(["PERFILES", "PERFIL"]);
  const shVehiculos     = pickSheet(["VEHICULOS", "VEHÍCULOS"]);
  const shReservaciones = pickSheet(["RESERVACIONES", "RESERVACION"]);

  if (!shReservaciones) {
    return {
      ok: false,
      error: "sheet_not_found",
      message: "No se encontró la hoja Reservaciones",
      sheets_available: ss.getSheets().map(s => s.getName())
    };
  }

  const perfiles      = readSheet(shPerfiles);
  const vehiculos     = readSheet(shVehiculos);
  const reservaciones = readSheet(shReservaciones);

  return {
    ok: true,
    spreadsheetId:  ss.getId(),
    spreadsheetUrl: ss.getUrl(),
    sourceSheets: {
      perfiles:      shPerfiles      ? shPerfiles.getName()      : null,
      vehiculos:     shVehiculos     ? shVehiculos.getName()     : null,
      reservaciones: shReservaciones ? shReservaciones.getName() : null,
    },
    counts: {
      perfiles:      perfiles.rows.length,
      vehiculos:     vehiculos.rows.length,
      reservaciones: reservaciones.rows.length,
    },
    perfiles:      perfiles.rows,
    vehiculos:     vehiculos.rows,
    reservaciones: reservaciones.rows,
    headers: {
      perfiles:      perfiles.headers,
      vehiculos:     vehiculos.headers,
      reservaciones: reservaciones.headers,
    },
  };
}
