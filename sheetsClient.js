async function sendRowsToAppsScript(rows) {
  const url = process.env.APPS_SCRIPT_WEBAPP_URL;
  const token = process.env.APPS_SCRIPT_TOKEN || "";

  if (!url) {
    throw new Error("Falta APPS_SCRIPT_WEBAPP_URL en variables de entorno");
  }

  const payload = {
    action: "appendTicketExpenses",
    token,
    rows
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload)
  });

  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch (_) {
    return { ok: response.ok, raw: text };
  }
}

module.exports = { sendRowsToAppsScript };
