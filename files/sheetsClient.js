/**
 * sheetsClient.js — Envío a Google Apps Script con retry
 */

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1200;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendRowsToAppsScript(rows) {
  const url   = process.env.APPS_SCRIPT_WEBAPP_URL;
  const token = process.env.APPS_SCRIPT_TOKEN || "";

  if (!url) {
    throw new Error("Falta APPS_SCRIPT_WEBAPP_URL en variables de entorno.");
  }

  const payload = {
    action: "appendTicketExpenses",
    token,
    rows
  };

  const body = JSON.stringify(payload);

  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body,
        signal: AbortSignal.timeout(15000) // 15 s timeout
      });

      const text = await response.text();

      if (!response.ok) {
        throw new Error(`Apps Script respondió ${response.status}: ${text.slice(0, 200)}`);
      }

      try {
        return JSON.parse(text);
      } catch (_) {
        return { ok: true, raw: text };
      }
    } catch (err) {
      lastError = err;
      console.warn(`sheetsClient: intento ${attempt}/${MAX_RETRIES} falló — ${err.message}`);
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  throw new Error(`No se pudo enviar a Sheets tras ${MAX_RETRIES} intentos: ${lastError?.message}`);
}

module.exports = { sendRowsToAppsScript };
