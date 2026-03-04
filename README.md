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

## Guía rápida: cuando un perfil muestra métricas en `0` aunque hay partidos

Si en el perfil del equipo aparece algo como **"pulse 0 pts"** pero en el historial sí existen partidos calculados, normalmente hay un problema de conexión entre capas de datos (no de cálculo puro). Esta checklist te ayuda a entrenar y estabilizar el flujo:

1. **Validar misma clave de equipo/competición en todos los pasos**
   - Usa una clave canónica única por equipo (ej: `arsenal|premier_league`).
   - Evita mezclar variantes (`Arsenal`, `arsenal`, `Premier League`, `premier-league`, `EPL`).

2. **Separar claramente `raw` vs `features`**
   - Guarda por partido los datos base (`stats`) y también el vector final (`features`) en campos distintos.
   - El perfil debe leer `features.pulse` (u otro campo final), no un campo transitorio de auditoría.

3. **Recalcular y luego refrescar el perfil**
   - Flujo recomendado: `guardar partido -> calcular métricas -> persistir -> refrescar perfil`.
   - Si el refresco ocurre antes de persistir, el perfil puede quedarse con `0` por estado viejo.

4. **Aplicar fallback controlado cuando falta un dato**
   - Si no hay suficientes partidos, usar un fallback explícito (ej: promedio de últimos N disponibles).
   - Registrar en auditoría cuándo se usa fallback para no confundir `0 real` con `dato faltante`.

5. **Agregar trazabilidad de lectura**
   - Al cargar perfil, loguear: clave usada, cantidad de partidos leídos, última fecha y valor final de `pulse`.
   - Con eso se detecta rápido si el problema es clave, filtro temporal o lectura de campo incorrecto.

6. **Entrenamiento/ajuste del modelo (si aplica IA)**
   - Entrenar solo con filas ya consolidadas (métricas calculadas y auditadas).
   - Excluir partidos incompletos del set de entrenamiento.
   - Versionar el pipeline (`snapshot_v1`, `snapshot_v2`, etc.) para comparar salidas.

> Recomendación práctica: antes de entrenar, construir una validación automática que compare `perfil actual` vs `último partido calculado` para `pulse/fatiga/resiliencia/agresividad/volatilidad`. Si difieren más de un umbral pequeño, bloquear entrenamiento y mostrar alerta.
