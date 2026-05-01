/**
 * Apps Script para recibir gastos de tickets desde Cloud Run
 * y guardarlos en Google Sheets.
 *
 * 1) Pega este código en Extensiones > Apps Script del Google Sheet.
 * 2) Cambia SHEET_NAME si quieres otro nombre.
 * 3) Define SCRIPT_TOKEN igual que en Cloud Run.
 * 4) Deploy > New deployment > Web app.
 */

const SHEET_NAME = 'Gastos';
const SCRIPT_TOKEN = 'cambia-este-token';

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents || '{}');

    if (payload.token !== SCRIPT_TOKEN) {
      return jsonOutput({ ok: false, error: 'Token inválido' });
    }

    if (payload.action === 'appendTicketExpenses') {
      return jsonOutput(appendTicketExpenses(payload.rows || []));
    }

    return jsonOutput({ ok: false, error: 'Acción no reconocida' });
  } catch (err) {
    return jsonOutput({ ok: false, error: err.message });
  }
}

function appendTicketExpenses(rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);

  if (!sh) sh = ss.insertSheet(SHEET_NAME);

  const headers = [
    'fecha_captura',
    'tienda',
    'rfc_emisor',
    'fecha_ticket',
    'folio_ticket',
    'producto',
    'cantidad',
    'precio_unitario',
    'importe',
    'total_ticket',
    'categoria_operativa',
    'categoria_contable',
    'tratamiento_fiscal',
    'deducible_sugerido',
    'requiere_revision',
    'razon_clasificacion',
    'propiedad',
    'departamento',
    'huesped',
    'reservacion_id',
    'fuente',
    'notas',
    'ticket_linea'
  ];

  ensureHeaders(sh, headers);

  if (!rows.length) {
    return { ok: true, inserted: 0 };
  }

  const values = rows.map(row => headers.map(h => row[h] ?? ''));
  sh.getRange(sh.getLastRow() + 1, 1, values.length, headers.length).setValues(values);

  return {
    ok: true,
    sheet: SHEET_NAME,
    inserted: values.length
  };
}

function ensureHeaders(sh, headers) {
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    return;
  }

  const current = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), headers.length)).getValues()[0];
  const missing = headers.filter(h => !current.includes(h));

  if (missing.length) {
    sh.getRange(1, current.length + 1, 1, missing.length).setValues([missing]);
  }
}

function jsonOutput(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
