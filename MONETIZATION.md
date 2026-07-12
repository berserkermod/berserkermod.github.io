# BERSERKERMOD — Monetización

Dos productos, dos canales (cada uno donde mejor rinde).

## Coach — pago único, por Mercado Pago (web)

- **Producto**: modo entrenador (crear rutinas, compartirlas por link con alumnos, ver sus ediciones).
- **Precio sugerido**: ~USD 18 (pago único). Se cobra en **ARS** al cambio del día → se setea en `worker/wrangler.toml` (`COACH_PRICE_ARS`), sin tocar código.
- **Canal**: Mercado Pago Checkout Pro desde la landing. Comisión MP en AR ~6% + IVA (mucho menor que Google Play).
- **Entrega**: pantalla de éxito muestra el código `BMOD-XXXX-XXXX` + auto-activación por redirect. El usuario lo canjea en la app (Perfil → Activar código).
- **Estado**: implementado y testeado. Falta que el dueño cargue `MP_ACCESS_TOKEN` y `COACH_PRICE_ARS`.

## Premium — planes por duración (1/3/6/12 meses), por Mercado Pago

- **Producto**: features premium de la app (Oracle IA, plan nutricional, rutinas custom, importar PDF, stats avanzadas, idiomas, etc.). NO incluye modo Coach.
- **Canal (IMPLEMENTADO jul 2026)**: Mercado Pago Checkout Pro desde la landing, igual que el Coach. No es suscripción recurrente: son **compras únicas de un período** — el usuario compra 1, 3, 6 o 12 meses y el código vence.
- **Mecánica**: el webhook genera un código con `duration_days` (31/92/183/366 — con changüí); **el reloj arranca cuando el usuario ACTIVA el código**, no al comprar. Re-activar o cambiar de teléfono no extiende. Vencido, la app degrada sola a Free (misma maquinaria que los trials). Renovación: comprar otro código — la app muestra el vencimiento en Perfil y, en los últimos 7 días, el input para renovar.

### Escalera vigente (ARS, configurada en `worker/wrangler.toml`)

Base USD 4,99/mes al oficial ~1500 ARS/USD (jul 2026). Ajustar los `PREMIUM_PRICE_ARS_*M` cuando se mueva el dólar.

| Plan | ARS | ≈ USD | Equivale a | Ahorro |
|---|---|---|---|---|
| 1 mes | $7.500 | 5,0 | $7.500/mes | — |
| 3 meses | $19.500 | 13 | $6.500/mes | –13% |
| 6 meses | $36.000 | 24 | $6.000/mes | –20% |
| **12 meses** | **$60.000** | **40** | **$5.000/mes** | **–33%** ⭐ |

> ⚠️ **INCOHERENCIA DE PRECIOS A RESOLVER (decisión del dueño)**: el Coach está
> en $25.000 pago único VITALICIO e incluye todo el Premium + modo entrenador.
> Hoy queda más barato que 6 meses de Premium — nadie racional compraría 6/12
> meses pudiendo llevarse el Coach vitalicio por menos. Opciones: **subir
> `COACH_PRICE_ARS` a ~$90.000–120.000** (≈ USD 60–80, ~2× el anual de Premium)
> o pasar el Coach también a planes por duración.

### Google Play (futuro)

Cuando se retome Play, la misma escalera se arma como **una suscripción** con planes base (mensual/trimestral/semestral/anual) en Play Console — Google gestiona la recurrencia real. Los códigos por duración de MP siguen conviviendo (venta web) sin conflicto con la política anti-steering (la app no linkea al checkout).

## Por qué este split

- La **recurrencia** (lo difícil de operar) la absorbe Google Play, que está hecho para eso.
- El **Coach** (ticket alto, pago único) va por Mercado Pago: simple, barato de comisión, y un pago único convierte mejor en un producto nuevo sin reputación.
- La app de Android **no** debe tener un botón de compra que abra Mercado Pago (política anti-steering de Google): la venta del Coach ocurre en la **web/landing**, y dentro de la app solo se **canjea el código**.
