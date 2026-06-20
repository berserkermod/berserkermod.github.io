# BERSERKERMOD API — Deploy del Worker (Cloudflare)

Backend único de producción. Reemplaza a `serve.ps1` (que solo corría en tu
máquina). Maneja:

- **Modo Coach**: crear rutinas, compartir por link/token, recibir ediciones del
  alumno, marcarlas como revisadas (antes muerto en prod).
- **Licencias**: códigos de activación (`BMOD-XXXX-XXXX`) + Mercado Pago.
- **Oracle**: proxy a Anthropic con la API key del usuario (nunca se loguea).
- **Errores**: ingest de los errores que captura la app (Fase 0).

Todo el código fue testeado localmente: `npm test` → **43/43**.

---

## 0. Requisitos (ya los tenés)

- Node ≥ 20 y `npx` (tenés Node 24 ✓).
- Cuenta de Cloudflare (ya creada ✓).

Desde la carpeta `worker/`:

```bash
cd worker
npm install        # baja wrangler local (opcional; podés usar npx)
```

---

## 1. Login en Cloudflare

```bash
npx wrangler login
```

Se abre el navegador, autorizás, y wrangler queda logueado en tu cuenta.

## 2. Crear el KV namespace

```bash
npx wrangler kv namespace create BMOD_KV
```

Devuelve algo como:

```
[[kv_namespaces]]
binding = "BMOD_KV"
id = "a1b2c3d4e5f6...."
```

Copiá ese **id** y pegalo en `wrangler.toml` reemplazando los dos
`REEMPLAZAR_CON_EL_ID_DE_KV` (en `id` y en `preview_id`).

## 3. Cargar los secrets

```bash
# Secreto para firmar las licencias (HMAC). Inventá una cadena larga y random.
# Generá una con: node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"
npx wrangler secret put LICENSE_SECRET

# Secreto para el panel admin (generar/listar códigos y ver errores).
npx wrangler secret put ADMIN_SECRET

# (Opcional, cuando conectes Mercado Pago) Access Token de tu cuenta MP.
npx wrangler secret put MP_ACCESS_TOKEN

# (Opcional, para "Importar rutina desde PDF") API key de Anthropic/Claude.
# Crearla en https://console.anthropic.com -> API Keys. La paga el dueño
# (centavos por importacion). Sin esto, el importador devuelve 503.
npx wrangler secret put ANTHROPIC_KEY
```

> ⚠️ Guardá `LICENSE_SECRET` en un lugar seguro. Si lo cambiás, **todas las
> licencias ya emitidas dejan de validar** (los usuarios tendrían que reactivar).

## 4. Deploy

```bash
npx wrangler deploy
```

Al terminar imprime la URL del Worker, p.ej.:

```
https://berserkermod-api.TU-SUBDOMINIO.workers.dev
```

**Copiá esa URL.**

## 5. Conectar la app con el Worker

Dos opciones (elegí una):

**A) Editar el HTML (definitivo, para todos los usuarios)**
En `BERSERKERMOD.html` buscá `WORKER_API_BASE_DEFAULT` y reemplazá el
placeholder por tu URL:

```js
const WORKER_API_BASE_DEFAULT = 'https://berserkermod-api.TU-SUBDOMINIO.workers.dev';
```

Después redeployá el HTML a GitHub Pages (copiar a `deploy/`, commit, push).
La TWA toma la URL viva, así que no hay que resubir el AAB.

**B) Probar rápido sin tocar código (solo tu dispositivo)**
En la consola del navegador:

```js
localStorage.setItem('bm-api-base', 'https://berserkermod-api.TU-SUBDOMINIO.workers.dev');
location.reload();
```

> Hasta que configures la URL, la app degrada con elegancia: el Coach, el Oracle
> y la activación de códigos muestran "no se pudo conectar" en vez de romperse.

---

## 6. Probar que anda

```bash
# ping
curl https://berserkermod-api.TU-SUBDOMINIO.workers.dev/api/health
# → {"ok":true,"service":"berserkermod-api"}

# generar 3 códigos Coach (usá tu ADMIN_SECRET)
curl -X POST https://berserkermod-api.TU-SUBDOMINIO.workers.dev/api/admin/codes \
  -H "x-admin-secret: TU_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"count":3,"product":"coach"}'
# → {"ok":true,"product":"coach","codes":["BMOD-XXXX-XXXX", ...]}
```

Esos códigos los podés activar en la app (Perfil → Activar código) para validar
el flujo completo end-to-end.

---

## 7. Mercado Pago (cuando quieras automatizar la venta)

1. En tu panel de Mercado Pago → **Tus integraciones** → creá una aplicación.
2. Copiá el **Access Token** de producción → `npx wrangler secret put MP_ACCESS_TOKEN`.
3. En la preferencia de pago (checkout) configurá:
   - `external_reference`: `"coach"` o `"premium"` (define qué desbloquea el código).
   - `notification_url`: `https://berserkermod-api.TU-SUBDOMINIO.workers.dev/api/webhook/mercadopago`
   - `back_urls.success`: la URL de la app, p.ej.
     `https://berserkermod.github.io/BERSERKERMOD.html`
     (Mercado Pago le agrega `?payment_id=...&status=approved` al volver, y la
     app recupera el código y lo activa sola.)
4. Flujo automático: pago aprobado → MP llama al webhook → el Worker genera un
   código y lo guarda contra el `payment_id` → la app, al volver del redirect, lo
   recupera (`/api/license/retrieve`) y activa Premium sin intervención tuya.

> Probalo primero en el **sandbox** de Mercado Pago (credenciales de prueba)
> antes de pasar a producción.

---

## 8. Operación

```bash
# ver errores reportados por la app
curl https://berserkermod-api.TU-SUBDOMINIO.workers.dev/api/admin/errors \
  -H "x-admin-secret: TU_ADMIN_SECRET"

# logs en vivo del Worker
npx wrangler tail
```

### Revocar una licencia (anti-fraude)
Marcá el código como revocado en KV; en la próxima revalidación (≤7 días) la app
baja al usuario a free:

```bash
npx wrangler kv key put --binding BMOD_KV "code:BMOD-XXXX-XXXX" \
  '{"product":"coach","used":true,"revoked":true}'
```

---

## Notas de diseño

- **Licencias**: token tipo JWT-lite firmado con HMAC-SHA256. El cliente lee el
  payload (para UX offline) pero **no puede forjarlo**. Revalida online cada 7
  días; offline mantiene el acceso (gracia generosa: un usuario que pagó nunca
  queda afuera sin internet).
- **Cambio de teléfono**: un código se "mueve" al último dispositivo
  (last-device-wins), con tope de 10 movimientos para frenar que circule entre
  muchas personas. Así el upgrade de teléfono no bloquea a nadie.
- **Trials**: 7 días Coach / 3 días Premium, atados al `deviceId` para que
  reinstalar no resetee la prueba.
- **Sync de salud**: `/api/health-data` viene **apagado** (`ENABLE_HEALTH_SYNC=false`)
  a propósito — los datos de salud se quedan en el dispositivo (privacidad). Si
  algún día querés sync server-side, poné la var en `true` y actualizá la
  política de privacidad / Data Safety de Play.
- **Sin secretos en el repo**: `LICENSE_SECRET`, `ADMIN_SECRET` y
  `MP_ACCESS_TOKEN` viven solo en Cloudflare. `.dev.vars` (valores de prueba
  local) está en `.gitignore`.
