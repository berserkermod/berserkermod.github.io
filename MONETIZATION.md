# BERSERKERMOD — Monetización

Dos productos, dos canales (cada uno donde mejor rinde).

## Coach — pago único, por Mercado Pago (web)

- **Producto**: modo entrenador (crear rutinas, compartirlas por link con alumnos, ver sus ediciones).
- **Precio sugerido**: ~USD 18 (pago único). Se cobra en **ARS** al cambio del día → se setea en `worker/wrangler.toml` (`COACH_PRICE_ARS`), sin tocar código.
- **Canal**: Mercado Pago Checkout Pro desde la landing. Comisión MP en AR ~6% + IVA (mucho menor que Google Play).
- **Entrega**: pantalla de éxito muestra el código `BMOD-XXXX-XXXX` + auto-activación por redirect. El usuario lo canjea en la app (Perfil → Activar código).
- **Estado**: implementado y testeado. Falta que el dueño cargue `MP_ACCESS_TOKEN` y `COACH_PRICE_ARS`.

## Premium — suscripción, por Google Play

- **Producto**: features premium de la app (Oracle IA, stats avanzadas, idiomas, etc.).
- **Canal**: Google Play Billing — Google gestiona cobros mensuales, reintentos de tarjeta, recibos y cancelaciones (gratis del lado nuestro). Es la forma correcta de recurrencia dentro de una app de Play.
- **Estado**: PENDIENTE (fase futura — requiere integrar Play Billing en la TWA + crear los productos en Play Console).

### Escalera de precios sugerida (configurar en Play Console)

El objetivo es que el **anual** sea la opción obvia (descuento fuerte) → ingreso recurrente predecible.

| Plan | Precio | Equivale a | Ahorro |
|---|---|---|---|
| Mensual | USD 4,99 | $4,99/mes | — |
| 3 meses | USD 12,99 | $4,33/mes | –13% |
| 6 meses | USD 23,99 | $4,00/mes | –20% |
| **Anual** | **USD 39,99** | **$3,33/mes** | **–33%** ⭐ |

Notas:
- En Play Console esto se arma como **una suscripción** ("Premium") con varios **planes base** (mensual / trimestral / semestral / anual). Google muestra el ahorro automáticamente.
- Conviene ofta una **prueba gratuita** de 3-7 días en el plan mensual para bajar la fricción de entrada (el sistema de trials del cliente ya existe, pero la prueba de la suscripción la maneja Play).
- Precios en USD; Play los convierte y redondea por país automáticamente.

## Por qué este split

- La **recurrencia** (lo difícil de operar) la absorbe Google Play, que está hecho para eso.
- El **Coach** (ticket alto, pago único) va por Mercado Pago: simple, barato de comisión, y un pago único convierte mejor en un producto nuevo sin reputación.
- La app de Android **no** debe tener un botón de compra que abra Mercado Pago (política anti-steering de Google): la venta del Coach ocurre en la **web/landing**, y dentro de la app solo se **canjea el código**.
