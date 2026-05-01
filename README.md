# Ticket Parser PRO Integrado

Proyecto listo para GitHub + Cloud Run + Google Sheets.

## Qué hace

- Sube fotos de tickets desde celular.
- Extrae texto con Google Vision OCR.
- Detecta tienda: VEMEX, Home Depot, Walmart, HEB, Costco, Sams, Steren, etc.
- Extrae partidas, importes, fecha, RFC y total cuando el OCR lo permite.
- Clasifica gastos con lógica contable-operativa:
  - Mantenimiento
  - CAPEX / Equipamiento
  - Limpieza
  - Amenidades huésped
  - Papelería / Administración
  - Otros / Por clasificar
- Exporta Excel.
- Guarda directo en Google Sheets mediante Apps Script.

## Estructura

```text
backend/      API para Cloud Run
frontend/     UI para GitHub Pages
apps-script/  Código para pegar en Google Sheets
```

## Deploy Backend en Cloud Run desde GitHub

1. Sube este repo a GitHub.
2. En Google Cloud Run selecciona: Deploy from repository.
3. Elige la carpeta `backend`.
4. Build type: Dockerfile.
5. Permite acceso no autenticado.
6. Activa Vision API.
7. Variables de entorno recomendadas:

```text
APPS_SCRIPT_WEBAPP_URL=https://script.google.com/macros/s/TU_ID/exec
APPS_SCRIPT_TOKEN=cambia-este-token
SAVE_TO_SHEETS=false
```

Para guardar siempre en Sheets, cambia:

```text
SAVE_TO_SHEETS=true
```

## Permisos Vision API

La cuenta de servicio de Cloud Run necesita permiso:

```text
roles/vision.apiUser
```

## Apps Script

1. Abre tu Google Sheet.
2. Extensiones > Apps Script.
3. Pega el contenido de `apps-script/Code.gs`.
4. Cambia `SCRIPT_TOKEN`.
5. Deploy > New deployment > Web app.
6. Acceso: Anyone with the link.
7. Copia la URL y ponla en `APPS_SCRIPT_WEBAPP_URL` de Cloud Run.

## Frontend

En `frontend/index.html` puedes publicarlo con GitHub Pages.

En la pantalla pega tu URL de Cloud Run, por ejemplo:

```text
https://ticket-parser-xxxxx-uc.a.run.app
```

## Integración con Control de Huéspedes

El backend acepta estos campos extra junto con las imágenes:

- propiedad
- departamento
- huesped
- reservacion_id
- notas

Así puedes llamarlo desde tu módulo actual y guardar gastos ligados a una propiedad/departamento.
