# BERSERKERMOD — Monetización

Dos productos, dos canales (cada uno donde mejor rinde).

## Coach — planes por duración (1/3/6/12 meses), por Mercado Pago (web)

- **Producto**: TODO el Premium + modo entrenador (rutinas para alumnos por link/QR, adherencia en tiempo real, plantillas, importar PDF→alumno). Tier profesional.
- **Precio**: **2× el Premium** (multiplicador clásico de tier pro), misma estructura de promos. Configurado en `worker/wrangler.toml` (`COACH_PRICE_ARS_{1,3,6,12}M`).

| Plan | ARS | ≈ USD | Equivale a | Ahorro |
|---|---|---|---|---|
| 1 mes | $15.000 | 10 | $15.000/mes | — |
| 3 meses | $39.000 | 26 | $13.000/mes | –13% |
| 6 meses | $72.000 | 48 | $12.000/mes | –20% |
| **12 meses** | **$120.000** | **80** | **$10.000/mes** | **–33%** ⭐ |

- **Canal**: Mercado Pago Checkout Pro desde la landing (selector de planes). Comisión MP en AR ~6% + IVA.
- **Mecánica**: idéntica al Premium — código con `duration_days`, el reloj arranca al ACTIVAR, sin renovación automática. Legacy: los códigos coach viejos (pago único) siguen siendo vitalicios.
- **Entrega**: pantalla de éxito muestra el código `BMOD-XXXX-XXXX`. El usuario lo canjea en la app (Perfil → Activar código).
- **Estado**: implementado, testeado y VIVO (jul 2026).

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

> ✅ **Coherencia resuelta (jul 2026)**: el Coach pasó también a planes por
> duración a exactamente **2× cada plan Premium** — la relación de precios es
> consistente en toda la escalera y el vitalicio barato desapareció.

### Google Play (futuro)

Cuando se retome Play, la misma escalera se arma como **una suscripción** con planes base (mensual/trimestral/semestral/anual) en Play Console — Google gestiona la recurrencia real. Los códigos por duración de MP siguen conviviendo (venta web) sin conflicto con la política anti-steering (la app no linkea al checkout).

## Por qué este split

- Ambos productos van por **Mercado Pago con códigos por duración**: sin recurrencia que operar (no hay débitos automáticos que gestionar, reintentos ni cancelaciones), comisión baja (~6% vs 15-30% de Play), y "sin suscripción automática" es un argumento de venta en Argentina.
- La renovación es manual: la app avisa el vencimiento (Perfil muestra los días restantes y el input de renovación en los últimos 7 días). Cuando haya volumen, un recordatorio push de vencimiento cierra el loop.
- La app de Android **no** debe tener un botón de compra que abra Mercado Pago (política anti-steering de Google): la venta ocurre en la **web/landing**, y dentro de la app solo se **canjea el código**.
