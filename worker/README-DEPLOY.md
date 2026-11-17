# BERSERKERMOD API — Worker de Cloudflare

Backend único de producción (`berserkermod-api`, cuenta de BerserkerMOD). Maneja:

- **Licencias**: códigos `BMOD-XXXX-XXXX`, pruebas gratis, Mercado Pago (checkout +
  webhook) y Google Play Billing (suscripciones dentro de la app de Play).
- **Modo Coach**: rutinas, links de alumnos, entrenamientos, controles, videos,
  evaluaciones, Premium del coach, huéspedes. Los datos de cada coach viven en su
  **Durable Object** (`coach:{id}`), con copia a KV mientras `KV_MIRROR = "on"`.
- **Avisos**: recordatorio diario (cron cada minuto, objeto `pushsubs`), fin del
  descanso, recordatorio del control y resumen del coach (Durable Objects con alarma).
- **IA** (Workers AI, gratis): Oracle, importar rutina desde PDF, fotos de comida, con
  cuota diaria por licencia.
- **Vigía**: registros del Worker, `/api/health/deep` y la tarea de GitHub
  `.github/workflows/vigia.yml` (mail si algo falla).

Tests: `npm test` (desde esta carpeta) corre las tres tandas del Worker: datos en KV,
datos en Durable Objects y la tanda específica del Coach.

---

## Publicar (cada vez)

Siempre **el Worker primero y después la app** (push a GitHub Pages).

```bash
cd deploy/worker
npm run ensayo     # hace todo menos publicar: para ver que el camino está limpio
npm run deploy     # lo mismo y publica (pide escribir SI)
```

`publicar.mjs` hace, en orden, y frena ante cualquier problema:

1. Que el código esté guardado en git (sin cambios sueltos en `worker/`).
2. Las tres tandas de tests.
3. Que wrangler esté en la cuenta de BerserkerMOD (`0a8cc9f61d77cd06dd7fb75d825e3aa1`).
4. Copia de seguridad cifrada de KV y prueba de restauración (carpeta `copias-kv`,
   al lado de `deploy`, **fuera del repo**).
5. Anota la versión publicada (para volver atrás) y los nombres de las claves secretas.
6. Ensayo de armado. 7. Publica. 8. Compara las claves, prueba rutas sin tocar datos
   y escucha los registros ~75 s (incluye una corrida del cron).
9. Deja una línea en `.publicaciones.log` (no va a git) y el comando para volver atrás.

La versión de wrangler está fija (`wrangler@4.164.0`) para que una versión nueva de
la herramienta no cambie nada sin aviso.

Después: revisar que no se suban claves (`git diff`), `git push`, y mirar el CI.

## Volver atrás

```bash
npx wrangler@4.164.0 rollback <id-de-la-versión-anterior>   # el script lo imprime
```

- Con `KV_MIRROR = "on"` KV tiene todo al día: el Worker anterior funciona.
- Si después se vuelve a publicar el Worker nuevo, **subir `DATA_EPOCH`** (2, 3…): cada
  objeto descarta lo suyo y vuelve a traer todo de KV.
- No se puede volver atrás cruzando un cambio de clases de Durable Objects (por eso no
  hay clases nuevas: todo usa `Notifier` con nombres de objeto distintos).

## Variables importantes (`wrangler.toml`)

| Variable | Qué hace |
|----------|----------|
| `DO_DATA` | `"on"`: datos del Coach, contadores y suscripciones en Durable Objects. `"off"`: todo en KV, como antes. |
| `KV_MIRROR` | `"on"`: cada cambio se copia a KV (vuelta atrás posible). Apagarlo es sin vuelta atrás: solo con OK del dueño, tras dos semanas sin errores, con copia de KV **y de los Durable Objects** de ese día. |
| `DATA_EPOCH` | Subirlo solo al republicar este Worker después de una vuelta atrás. |
| `TESTERS_CLAIM_OPEN` / `_MAX` | Premium para testers de la prueba cerrada de Play. |
| `*_PRICE_ARS_*` | Precios de Mercado Pago (en `"0"`, el plan desaparece). |

Claves secretas (solo en Cloudflare, nunca en el repo): `LICENSE_SECRET` (firma las
licencias: si se pierde o cambia, todas dejan de valer; hay una copia fuera del repo),
`ADMIN_SECRET`, `MP_ACCESS_TOKEN`, `PLAY_SA_JSON`, `VAPID_PRIVATE_JWK`.
Se cargan con `npx wrangler@4.164.0 secret put NOMBRE`.

## Vigía y registros

- `GET /api/health/deep`: 200 si KV y los Durable Objects responden y KV no llegó a su
  tope en la última hora; 503 con el detalle si no.
- Registros: panel de Cloudflare → Workers → berserkermod-api → Logs (3 días).
- En vivo: `npx wrangler@4.164.0 tail berserkermod-api`.

## Operación

```bash
# errores que reportó la app
curl https://berserkermod-api.berserkermod.workers.dev/api/admin/errors -H "x-admin-secret: …"
```

Los testers se ven con `marketing/ver-testers.cmd` (fuera del repo).

**Anular una licencia a mano** (fraude): en la próxima revalidación (≤ 7 días) la app
baja al usuario a la versión gratis. Ojo: en wrangler 4 los comandos de KV van al KV
LOCAL salvo que se pida `--remote`.

```bash
npx wrangler@4.164.0 kv key get "code:BMOD-XXXX-XXXX" --binding BMOD_KV --remote
# copiar el JSON, agregarle "revoked": true y volver a guardarlo:
npx wrangler@4.164.0 kv key put "code:BMOD-XXXX-XXXX" '{…,"revoked":true}' --binding BMOD_KV --remote
```

Las devoluciones y contracargos de Mercado Pago anulan el código solos (webhook), y
los reembolsos de Google Play se detectan en la revisión semanal.

## Mercado Pago

El checkout lo arma el Worker (`POST /api/checkout`): precio del servidor,
`external_reference = "{coach|premium}_{1|3|6|12}m"` (+ `.{número}` si viene de la app)
y `notification_url` al webhook. El webhook solo acepta pagos de la app (referencia,
monto y moneda), no devuelve el código en la respuesta y responde 500 si algo falla
de nuestro lado para que Mercado Pago reintente.

## Primera instalación (histórico, ya hecho)

`wrangler login` → crear el KV `BMOD_KV` (id en `wrangler.toml`) → cargar las claves
secretas → `wrangler deploy` → la URL del Worker quedó en `WORKER_API_BASE_DEFAULT` del
HTML.

## Notas de diseño

- **Licencias**: token firmado con HMAC-SHA256. El cliente lee el contenido (para usar
  la app sin internet) pero no puede falsificarlo. Revalida online cada 7 días; sin
  internet mantiene el acceso.
- **Cambio de teléfono**: un código pasa al último teléfono, con tope de 10 cambios.
  Una compra de Google Play sirve en 2 teléfonos a la vez, con tope de 10 cambios.
- **Pruebas gratis**: atadas al teléfono y con tope por red.
- **Datos de salud**: `/api/health-data` está apagado (`ENABLE_HEALTH_SYNC=false`) a
  propósito: se quedan en el teléfono.
- **Sin secretos en el repo**: `.dev.vars` y las claves locales están en `.gitignore`.
