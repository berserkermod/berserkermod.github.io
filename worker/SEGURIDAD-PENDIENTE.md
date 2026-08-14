# Endurecimiento de seguridad — hacer ANTES del lanzamiento público

Auditoría del 2026-08-11 (repo público, superficie de ataque de la API).
**Nada de esto afecta a los testers ni es un bug**: son vectores de abuso que
importan recién cuando la app sea pública. Hacerlo todo junto, en un solo
deploy, después de que termine la prueba cerrada.

## Lo que YA está bien (no tocar)

- `MP_ACCESS_TOKEN`, `LICENSE_SECRET`, `ADMIN_SECRET`, `VAPID_PRIVATE_JWK`:
  secrets de Cloudflare, nunca en el repo ni en el cliente.
- Webhook de Mercado Pago: no confía en el payload, consulta el pago contra la
  API de MP, exige `status === 'approved'`, idempotente por `payment:{id}`.
- Precios: siempre del servidor (`planConfig`), el cliente no puede alterarlos.
- Licencias firmadas HMAC-SHA256; endpoints admin con `ADMIN_SECRET`;
  `/api/oracle` y `/api/parse-routine` exigen licencia válida.
- Tokens de share del coach: 10 chars con `crypto.getRandomValues` — no enumerables.

## 1. Trial infinito (PRIORIDAD ALTA — afecta ingresos)

**Problema**: `startTrial` bloquea por `trial:{product}:{deviceId}`, pero el
`deviceId` lo genera el cliente. Borrando `bm-device-id` del localStorage (o
mandando uno inventado) se obtienen trials de 7 días ilimitados.

**Opciones de arreglo** (de menor a mayor fricción):
- a) Sumar al bloqueo una huella del lado del servidor: hash de
  `CF-Connecting-IP` + `User-Agent`, con TTL de ~30 días. Frena el 95% de los
  casos sin pedirle nada al usuario. **Recomendada.**
- b) Limitar trials por IP (ej. 3 por IP cada 30 días) — cuidado con redes
  compartidas (gimnasios, universidades).
- c) Pedir email para el trial — máxima protección, pero rompe la promesa de
  "sin cuenta" que es un diferencial del producto. NO recomendada.

## 2. Sin rate limiting en toda la API (PRIORIDAD MEDIA — afecta costos)

`grep -c rateLimit` = 0. Endpoints abiertos que se pueden inundar:
- `POST /api/errors` — sin auth, escribe en KV. Riesgo: agotar cuota/costo.
- `POST /api/routines` — sin auth, crea registros en KV.
- `POST /api/checkout` — crea preferencias basura en la cuenta de MP.
- `POST /api/oracle` y `/api/parse-routine` — con licencia, pero un usuario
  puede agotar las 10.000 neuronas/día de Workers AI.

**Arreglo**: limitador simple en KV por IP
(`rl:{ruta}:{ip}` con `expirationTtl`), ej. 30 req/min en los abiertos y
20 llamadas de IA por día por licencia. Cloudflare también tiene Rate Limiting
Rules a nivel de red (gratis hasta cierto volumen) — evaluar si conviene más.

## 3. `payment_id` como contraseña (PRIORIDAD BAJA)

`GET /api/license/retrieve?payment=X` devuelve el código a cualquiera que sepa
el ID de pago. Es necesario para entregar el código al volver de MP, pero el
número es la única llave.

**Arreglo**: borrar la clave `payment:{id}` después del primer retrieve exitoso
(el código ya queda en el dispositivo del comprador), o bajar el TTL de 90 días
a 7. Ojo: si el comprador limpia el navegador antes de canjearlo, pierde el
código — dejar el canal de soporte por email como respaldo.

## Cómo ejecutarlo

Un solo deploy del Worker con los tres cambios + tests nuevos
(`worker/test/worker.test.mjs`) que cubran: trial rechazado al repetir huella,
429 al pasar el límite, y retrieve que solo funciona una vez.
