# Fergis Assistant (v0.1)

Webapp estática (GitHub Pages) con **guardado local** y una cola de eventos lista para sincronizar con **Google Sheets (Apps Script)** cuando lo activemos.

## Qué incluye (MVP)
- Misiones del día (máximo 3)
- Sesión con timer (Terminé / Me pauso + razón opcional)
- Clientes (CRM mini)
- Ideas/Investigación (inbox)
- Guardado local (localStorage) + `eventQueue` para sync
- Export/Import de respaldo JSON
- PWA básica (manifest + service worker)

## Deploy en GitHub Pages
1. Crea un repo (ej: `fergis-assistant`)
2. Sube estos archivos a la raíz del repo.
3. GitHub > Settings > Pages
   - Source: Deploy from a branch
   - Branch: `main` / `/ (root)`
4. Abre la URL de Pages.

## Sync a Google Sheets (siguiente update)
En `Ajustes` vas a poner el `Apps Script URL` tipo:
`https://script.google.com/macros/s/XXXX/exec`

La app enviará POST JSON con:
```json
{
  "app": "FergisAssistant",
  "v": "0.1",
  "apiKey": "",
  "deviceTs": "ISO",
  "events": [ { "id": "...", "type": "...", "payload": {}, "ts":"ISO", "syncedAt": null } ]
}
```

La respuesta esperada:
```json
{ "ok": true, "acked": ["evt_...","evt_..."] }
```

Con eso marcamos los eventos como sincronizados.

## Notas
- Si la app se oculta o se cierra durante una sesión, se registra un evento (`app_hidden_during_session`, `app_unload_during_session`) para analizar interrupciones.
- No hay juicios ni “fallaste”: esto es estructura suave.
