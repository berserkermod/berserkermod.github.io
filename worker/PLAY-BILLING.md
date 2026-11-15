# Play Billing — Suscripción Premium dentro de la app (TWA)

Modelo (desde 2026-11-15):

- **App de Google Play (TWA)**: Premium se compra SOLO con Google Play
  (suscripción con renovación automática). La app nunca manda a pagar afuera ni
  nombra la compra por fuera: la política de pagos de Play lo prohíbe para algo
  digital como Premium. Coach no se vende ahí (solo se activa con código).
- **Web, iPhone y PC**: la ventana de Premium (la que abre cualquier candado)
  muestra los planes de Mercado Pago, avisa que sale de la app y, al volver, se
  activa sola. Coach también se compra ahí. La landing sigue vendiendo igual.

## Cómo funciona la compra de Google

1. La app detecta que corre dentro de la TWA (`window.getDigitalGoodsService`).
   Fuera de la TWA (web/iOS) todo esto es invisible.
2. La ventana de Premium (y Perfil) muestran los 4 planes con el precio que
   informa Play. El usuario compra con la hoja de pago nativa de Google
   (PaymentRequest + Digital Goods API), sin salir de la app.
3. El cliente manda `{sku, purchaseToken, deviceId}` a `POST /api/play/verify`.
4. El Worker verifica el token contra la Play Developer API (service account,
   JWT RS256), hace **acknowledge** (obligatorio: sin ack Google reembolsa a los
   3 días) y emite una licencia normal con `exp` = fin del período.
5. Renovación: Google renueva sola; la app re-verifica el purchaseToken guardado
   (`bm-play-sub`) al abrir cuando la licencia está a <48h o vencida, y recibe
   el `exp` nuevo. Cancelada y vencida → 403 → la app baja a free (los datos
   NUNCA se tocan). "Administrar suscripción" abre la pantalla de Play.

Mientras falte algún paso de abajo, en la app de Google la ventana de Premium
muestra solo "Tengo un código" y "Probar gratis".

## Configuración en Play Console (una vez) — pasos del usuario

### 0. Perfil de pagos (cuenta de comerciante)
Play Console → Configuración → **Perfil de pagos**: crear o vincular el perfil
de pagos de Google con los datos fiscales y bancarios (los carga el dueño de la
cuenta; Claude no los escribe). Sin esto Play no deja crear productos pagos.
Google se queda con el **15 %** de las suscripciones.

### 1. Crear los 4 productos de suscripción
Play Console → la app → Monetizar → Productos → **Suscripciones** → Crear.
IDs EXACTOS (no se pueden cambiar después):

| ID de producto | Plan base: período | Precio ARS |
|---|---|---|
| `premium_1m`  | 1 mes   | 7.500  |
| `premium_3m`  | 3 meses | 19.500 |
| `premium_6m`  | 6 meses | 36.000 |
| `premium_12m` | 1 año   | 60.000 |

Cada una: **un solo plan base, renovación automática**, marcado como
**compatible con versiones anteriores** (si hay un solo plan base suele quedar
así solo; si no, en el plan base → "Usar como compatible con versiones
anteriores"). Sin ese plan base compatible, la Digital Goods API no devuelve el
precio y el Worker no puede verificar la compra. Nombre visible sugerido:
"Premium 1 mes", etc. **Activar** cada plan base.

### 2. Cuenta de servicio (para que el Worker verifique compras)
1. Google Cloud Console → proyecto `berserkermod` → APIs y servicios →
   habilitar **Google Play Android Developer API**.
2. IAM → Cuentas de servicio → Crear (sin roles de proyecto) → Claves →
   Agregar clave → JSON → se descarga un archivo. Guardarlo fuera de git
   (por ejemplo en `play-store-keys/`).
3. Play Console → **Usuarios y permisos** → Invitar usuarios → pegar el email de
   la cuenta de servicio (termina en `iam.gserviceaccount.com`) → permisos de la
   app: **Ver información financiera** y **Administrar pedidos y suscripciones**.
   (La vieja pantalla "Acceso a API" ya no hace falta.) Puede tardar hasta 24 h
   en empezar a funcionar.
4. Subir el JSON como secreto del Worker, desde `deploy/worker` en PowerShell:
   `Get-Content "RUTA\al\archivo.json" -Raw | npx wrangler secret put PLAY_SA_JSON`
   (`PLAY_PACKAGE` ya está en wrangler.toml). El archivo nunca va al repo ni al chat.

### 3. Regenerar el AAB con la compra de Google encendida
En PWABuilder, mismo formulario de Android pero **Google Play billing: ON**
(el AAB del 2026-07-18 se generó con billing OFF y no expone la Digital Goods
API — la grilla de planes no aparecería). Mismo paquete
`io.github.berserkermod.twa`, **misma clave de firma** (subir la guardada en
`play-store-keys/`, opción "Use mine"), **código de versión 2** y nombre
`1.0.1`. Así se actualiza encima de la instalada y nadie pierde sus datos.
Subirlo a la prueba cerrada con notas de versión entre `<es-419>…</es-419>`.
Reemplazar el AAB guardado en `play-store-keys/` por el nuevo.

### 4. Probar sin gastar
Play Console → Configuración → **Testers de licencias** → agregar tu email.
Los testers de licencia compran con tarjeta de prueba (no se cobra) y las
suscripciones de prueba renuevan acelerado (ej. 1 mes = 5 minutos).

## Notas técnicas

- SKUs válidos hardcodeados en worker (`PLAY_SKUS`) y cliente (`PLAY_PLANS`).
- El token de licencia lleva `product: 'premium_play'` — el Perfil muestra
  "se renueva automáticamente" + administrar, sin input de renovación manual.
- Sin `PLAY_SA_JSON` el endpoint responde 503 y la app no rompe nada.
- Tests: sección "Google Play Billing" en worker/test/worker.test.mjs (service
  account RSA generado al vuelo, Google mockeado).
- Compra con Mercado Pago desde la app (web/iPhone/PC): `POST /api/checkout`
  con `{ret:'app', nonce}` → vuelve a `BERSERKERMOD.html` y el webhook deja
  `buy:{nonce}`; la app guarda el número en `bm-mp-buy` y lo retira con
  `GET /api/license/retrieve?ref=` (sirve aunque el pago termine en Safari y
  la app instalada sea otra).
