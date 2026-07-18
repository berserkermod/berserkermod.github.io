# Play Billing — Suscripción Premium dentro de la app (TWA)

Modelo: **Premium** se vende adentro de la app Android (suscripción de Google
Play, renovación automática) Y afuera por Mercado Pago (landing, duración fija).
**Coach** se vende SOLO afuera por Mercado Pago. La app nunca linkea a la compra
externa (política de Play).

## Cómo funciona

1. La app detecta que corre dentro de la TWA (`window.getDigitalGoodsService`).
   Fuera de la TWA (web/iOS) todo esto es invisible.
2. Perfil muestra los 4 planes con el precio que informa Play. El usuario compra
   con la hoja de pago nativa de Google (PaymentRequest + Digital Goods API).
3. El cliente manda `{sku, purchaseToken, deviceId}` a `POST /api/play/verify`.
4. El Worker verifica el token contra la Play Developer API (service account,
   JWT RS256), hace **acknowledge** (obligatorio: sin ack Google reembolsa a los
   3 días) y emite una licencia normal con `exp` = fin del período.
5. Renovación: Google renueva sola; la app re-verifica el purchaseToken guardado
   (`bm-play-sub`) al abrir cuando la licencia está a <48h o vencida, y recibe
   el `exp` nuevo. Cancelada y vencida → 403 → la app baja a free (los datos
   NUNCA se tocan). "Administrar suscripción" abre la pantalla de Play.

## Configuración en Play Console (una vez) — pasos del usuario

### 1. Crear los 4 productos de suscripción
Play Console → Monetizar → Productos → Suscripciones → Crear. IDs EXACTOS:

| ID de producto | Período de facturación | Precio ARS |
|---|---|---|
| `premium_1m`  | 1 mes   | 7.500  |
| `premium_3m`  | 3 meses | 19.500 |
| `premium_6m`  | 6 meses | 36.000 |
| `premium_12m` | 12 meses (anual) | 60.000 |

Cada una: un solo plan base auto-renovable. Nombre visible sugerido:
"Premium 1 mes", etc. Activar cada producto.

### 2. Service account (para que el Worker verifique compras)
1. Google Cloud Console → crear proyecto (o usar uno) → IAM → Service Accounts
   → Create. Sin roles de proyecto. Crear KEY tipo JSON y descargarla.
2. Play Console → Configuración → Acceso a API → vincular el proyecto de Cloud
   → en "Cuentas de servicio" invitar la cuenta creada con permisos
   **"Ver datos financieros"** y **"Administrar pedidos y suscripciones"**.
3. Subir el JSON como secret del Worker:
   `Get-Content service-account.json -Raw | npx wrangler secret put PLAY_SA_JSON`
   (`PLAY_PACKAGE` ya está en wrangler.toml). `npx wrangler deploy`.

### 3. Regenerar el AAB con billing habilitado
En PWABuilder, mismo formulario de Android pero **Google Play billing: ON**
(el AAB del 2026-07-18 se generó con billing OFF y no expone la Digital Goods
API — la grilla de planes no aparecería). Mismos valores, MISMA signing key
(subir la guardada en play-store-keys/, opción "Use mine"). Reemplazar el AAB
guardado en play-store-keys/ por el nuevo.

### 4. Probar sin gastar
Play Console → Configuración → Testers de licencias → agregar tu email.
Los testers de licencia compran con tarjeta de prueba (no se cobra) y las
suscripciones de prueba renuevan acelerado (ej. 1 mes = 5 minutos).

## Notas técnicas

- SKUs válidos hardcodeados en worker (`PLAY_SKUS`) y cliente (`PLAY_PLANS`).
- El token de licencia lleva `product: 'premium_play'` — el Perfil muestra
  "se renueva automáticamente" + administrar, sin input de renovación manual.
- Sin `PLAY_SA_JSON` el endpoint responde 503 y la app no rompe nada.
- Tests: sección "Google Play Billing" en worker/test/worker.test.mjs (10 tests,
  service account RSA generado al vuelo, Google mockeado).
