// BERSERKERMOD API — Cloudflare Worker
// =====================================================================
// Único backend de producción. Reemplaza a serve.ps1 (que solo corría en
// localhost). Surface:
//
//   Coach (KV):       POST/GET            /api/routines
//                     GET/PUT/DELETE      /api/routines/{id}
//                     POST                /api/routines/{id}/review
//                     GET                 /api/shares/{token}
//                     POST                /api/shares/{token}/edits
//   Licencias:        POST                /api/license/activate
//                     POST                /api/license/verify
//                     POST                /api/license/trial
//                     GET                 /api/license/retrieve
//                     POST                /api/admin/codes      (ADMIN_SECRET)
//   Checkout:         GET                 /api/products
//                     POST                /api/checkout
//   Mercado Pago:     POST                /api/webhook/mercadopago
//   Oracle (IA):      POST                /api/oracle
//   Importar rutina:  POST                /api/parse-routine    (premium, lee PDF con Workers AI)
//   Observabilidad:   POST                /api/errors
//                     GET                 /api/admin/errors     (ADMIN_SECRET)
//   Salud / varios:   POST                /api/health-data      (off por defecto)
//                     GET                 /api/server-info
//                     GET                 /api/health           (ping)
//
// KV key schema (un solo namespace, prefijos):
//   routine:{coachId}:{routineId}  → routine
//   token:{token}                  → { coachId, routineId }   (índice inverso)
//   edit:{routineId}:{editId}      → edit
//   code:{CODE}                    → { product, used, deviceId, payment_id, created_at }
//   payment:{paymentId}            → CODE          (retrieval tras redirect MP)
//   trial:{product}:{deviceId}     → { issued_at }  (anti-reinstall de trials)
//   error:{ts}:{rand}              → error (TTL 30d)
// =====================================================================

const TOKEN_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // sin chars ambiguos (igual que serve.ps1)
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // mayúsculas, sin O/0/I/1
const ERROR_TTL = 30 * 24 * 60 * 60;   // 30 días
const TRIAL_DAYS = { coach: 7, premium: 3 };
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

// ── Utilidades ───────────────────────────────────────────────────────
const enc = new TextEncoder();
const dec = new TextDecoder();

function randToken(alphabet, len) {
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
}
function newShareToken() { return randToken(TOKEN_ALPHABET, 10); }
function newCode() {
    // BMOD-XXXX-XXXX
    return 'BMOD-' + randToken(CODE_ALPHABET, 4) + '-' + randToken(CODE_ALPHABET, 4);
}
function uuid() { return crypto.randomUUID(); }
function nowISO() { return new Date().toISOString(); }

function b64urlFromBytes(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}
function b64urlEncodeJSON(obj) { return b64urlFromBytes(enc.encode(JSON.stringify(obj))); }
function b64urlDecodeJSON(s) { return JSON.parse(dec.decode(b64urlToBytes(s))); }

// HMAC-SHA256 sobre un string, devuelve bytes
async function hmac(secret, msg) {
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
    return new Uint8Array(sig);
}
// Comparación de tiempo constante
function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

// Licencia = base64url(payload) + "." + base64url(hmac(payload))
// payload: { product, tier, deviceId, iat, exp|null, code }
async function signLicense(secret, payload) {
    const head = b64urlEncodeJSON(payload);
    const sig = await hmac(secret, head);
    return head + '.' + b64urlFromBytes(sig);
}
async function verifyLicense(secret, token) {
    if (typeof token !== 'string' || token.indexOf('.') < 0) return null;
    const [head, sigPart] = token.split('.');
    if (!head || !sigPart) return null;
    let payload;
    try { payload = b64urlDecodeJSON(head); } catch { return null; }
    const expected = await hmac(secret, head);
    let given;
    try { given = b64urlToBytes(sigPart); } catch { return null; }
    if (!timingSafeEqual(expected, given)) return null;
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
}

// ── Respuestas / CORS ────────────────────────────────────────────────
function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-api-key, x-coach-id, x-admin-secret, anthropic-version'
    };
}
function json(obj, status = 200, extra = {}) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(), ...extra }
    });
}
function err(msg, status = 400) { return json({ error: msg }, status); }

async function readBody(req) {
    try { return await req.json(); } catch { return null; }
}
function coachIdFrom(req, url, body) {
    return req.headers.get('x-coach-id') || (body && body.coach_id) || url.searchParams.get('coach_id') || null;
}

// ── Coach: helpers KV ────────────────────────────────────────────────
async function kvGet(env, key) {
    const v = await env.BMOD_KV.get(key);
    return v ? JSON.parse(v) : null;
}
function kvPut(env, key, obj, opts) { return env.BMOD_KV.put(key, JSON.stringify(obj), opts); }

async function listByPrefix(env, prefix) {
    const out = [];
    let cursor;
    do {
        const res = await env.BMOD_KV.list({ prefix, cursor });
        for (const k of res.keys) {
            const v = await env.BMOD_KV.get(k.name);
            if (v) out.push(JSON.parse(v));
        }
        cursor = res.list_complete ? null : res.cursor;
    } while (cursor);
    return out;
}
function routineKey(coachId, id) { return `routine:${coachId}:${id}`; }
function editPrefix(routineId) { return `edit:${routineId}:`; }

// =====================================================================
//  Handlers
// =====================================================================

// ── Coach: rutinas ───────────────────────────────────────────────────
async function createRoutine(req, env, url) {
    const body = await readBody(req);
    const coachId = coachIdFrom(req, url, body);
    if (!coachId) return err('Missing coach_id', 401);
    if (!body || !body.name || !body.plan) return err('Missing name or plan', 400);

    let token = newShareToken();
    // colisión improbable; reintenta una vez
    if (await kvGet(env, `token:${token}`)) token = newShareToken();
    const now = nowISO();
    const routine = {
        id: uuid(),
        coach_id: coachId,
        coach_name: body.coach_name || null,
        name: body.name,
        plan: body.plan,
        alumno_name: body.alumno_name || null,
        alumno_email: body.alumno_email || null,
        share_token: token,
        created_at: now,
        updated_at: now,
        last_coach_update_at: now,
        last_seen_by_alumno_at: null
    };
    await kvPut(env, routineKey(coachId, routine.id), routine);
    await kvPut(env, `token:${token}`, { coachId, routineId: routine.id });
    return json(routine, 201);
}

async function listRoutines(env, url) {
    const coachId = url.searchParams.get('coach_id');
    if (!coachId) return err('Missing coach_id', 400);
    const routines = await listByPrefix(env, `routine:${coachId}:`);
    const enriched = [];
    for (const r of routines) {
        const edits = await listByPrefix(env, editPrefix(r.id));
        const alumnoEdits = edits.filter((e) => e.edited_by === 'alumno');
        const unreviewed = alumnoEdits.filter((e) => !e.reviewed_by_coach).length;
        const lastEdit = alumnoEdits.length
            ? alumnoEdits.map((e) => e.edited_at).sort().slice(-1)[0] : null;
        enriched.push({
            id: r.id, name: r.name, alumno_name: r.alumno_name, alumno_email: r.alumno_email,
            share_token: r.share_token, created_at: r.created_at,
            last_alumno_edit_at: lastEdit, edit_count: alumnoEdits.length,
            unreviewed_count: unreviewed, last_seen_by_alumno_at: r.last_seen_by_alumno_at
        });
    }
    return json(enriched);
}

async function getRoutine(env, url, id) {
    const coachId = url.searchParams.get('coach_id');
    // Necesitamos coachId para construir la key; si no viene, buscamos por scan corto.
    let r = coachId ? await kvGet(env, routineKey(coachId, id)) : null;
    if (!r) {
        // fallback: no sabemos el coach → no podemos listar todo el KV barato.
        return err('Not found', 404);
    }
    if (coachId && r.coach_id !== coachId) return err('Forbidden', 403);
    const edits = (await listByPrefix(env, editPrefix(id))).sort((a, b) => (a.edited_at < b.edited_at ? 1 : -1));
    return json({ routine: r, edits });
}

async function updateRoutine(req, env, url, id) {
    const body = await readBody(req);
    const coachId = coachIdFrom(req, url, body);
    if (!coachId) return err('Missing coach_id', 401);
    const r = await kvGet(env, routineKey(coachId, id));
    if (!r) return err('Not found', 404);
    if (r.coach_id !== coachId) return err('Forbidden', 403);
    const now = nowISO();
    if (body.name) r.name = body.name;
    if (body.plan) r.plan = body.plan;
    r.updated_at = now;
    r.last_coach_update_at = now;
    await kvPut(env, routineKey(coachId, id), r);
    return json(r);
}

async function deleteRoutine(req, env, url, id) {
    const coachId = coachIdFrom(req, url, null);
    if (!coachId) return err('Missing coach_id', 401);
    const r = await kvGet(env, routineKey(coachId, id));
    if (!r) return err('Not found', 404);
    if (r.coach_id !== coachId) return err('Forbidden', 403);
    await env.BMOD_KV.delete(routineKey(coachId, id));
    if (r.share_token) await env.BMOD_KV.delete(`token:${r.share_token}`);
    // borrar edits
    const res = await env.BMOD_KV.list({ prefix: editPrefix(id) });
    for (const k of res.keys) await env.BMOD_KV.delete(k.name);
    return json({ ok: true });
}

async function reviewRoutine(req, env, url, id) {
    const body = await readBody(req);
    const coachId = coachIdFrom(req, url, body);
    if (!coachId) return err('Missing coach_id', 401);
    const r = await kvGet(env, routineKey(coachId, id));
    if (!r) return err('Not found', 404);
    if (r.coach_id !== coachId) return err('Forbidden', 403);
    const res = await env.BMOD_KV.list({ prefix: editPrefix(id) });
    for (const k of res.keys) {
        const e = await kvGet(env, k.name);
        if (e && !e.reviewed_by_coach) { e.reviewed_by_coach = true; await kvPut(env, k.name, e); }
    }
    return json({ ok: true });
}

// ── Coach: shares (público, por token) ───────────────────────────────
async function getShare(env, token) {
    const idx = await kvGet(env, `token:${token}`);
    if (!idx) return err('Routine not found', 404);
    const r = await kvGet(env, routineKey(idx.coachId, idx.routineId));
    if (!r) return err('Routine not found', 404);
    r.last_seen_by_alumno_at = nowISO();
    await kvPut(env, routineKey(idx.coachId, idx.routineId), r);
    const edits = (await listByPrefix(env, editPrefix(r.id)))
        .sort((a, b) => (a.edited_at < b.edited_at ? 1 : -1)).slice(0, 20);
    const publicRoutine = {
        id: r.id, name: r.name, plan: r.plan, coach_name: r.coach_name,
        alumno_name: r.alumno_name, share_token: r.share_token,
        last_coach_update_at: r.last_coach_update_at, created_at: r.created_at
    };
    return json({ routine: publicRoutine, edits });
}

async function postEdit(req, env, token) {
    const idx = await kvGet(env, `token:${token}`);
    if (!idx) return err('Routine not found', 404);
    const body = await readBody(req);
    if (!body || !body.changes_json) return err('Missing changes_json', 400);
    const edit = {
        id: uuid(),
        routine_id: idx.routineId,
        share_token: token,
        changes_json: body.changes_json,
        edited_by: body.edited_by || 'alumno',
        editor_name: body.editor_name || null,
        edited_at: nowISO(),
        reviewed_by_coach: false
    };
    await kvPut(env, `edit:${idx.routineId}:${edit.id}`, edit);
    return json(edit, 201);
}

// ── Licencias ────────────────────────────────────────────────────────
async function activateLicense(req, env) {
    const secret = env.LICENSE_SECRET;
    if (!secret) return err('Server not configured (LICENSE_SECRET)', 500);
    const body = await readBody(req);
    const code = body && String(body.code || '').trim().toUpperCase();
    const deviceId = body && String(body.deviceId || '').trim();
    if (!code || !deviceId) return err('Missing code or deviceId', 400);

    const rec = await kvGet(env, `code:${code}`);
    if (!rec) return err('Código inválido', 404);
    if (rec.revoked) return err('Código revocado', 403);
    if (!rec.used) {
        // primera activación
        rec.used = true; rec.deviceId = deviceId; rec.activated_at = nowISO();
        await kvPut(env, `code:${code}`, rec);
    } else if (rec.deviceId && rec.deviceId !== deviceId) {
        // re-binding: el usuario cambió de teléfono. Movemos la licencia al
        // nuevo device (last-device-wins). Tope de movimientos para frenar que
        // un mismo código circule entre muchas personas.
        rec.rebinds = (rec.rebinds || 0) + 1;
        if (rec.rebinds > 10) return err('Este código se usó en demasiados dispositivos', 409);
        rec.deviceId = deviceId; rec.activated_at = nowISO();
        await kvPut(env, `code:${code}`, rec);
    }
    // mismo device → idempotente, no toca nada

    const product = rec.product || 'premium';
    const tier = 'premium'; // ambos productos desbloquean premium hoy; product distingue para futuro
    const iat = Date.now();
    const exp = rec.expires_at ? new Date(rec.expires_at).getTime() : null; // null = lifetime (one-time)
    const token = await signLicense(secret, { product, tier, deviceId, code, iat, exp });
    return json({ ok: true, token, product, tier, expiresAt: exp ? new Date(exp).toISOString() : null });
}

async function verifyLicenseHandler(req, env) {
    const secret = env.LICENSE_SECRET;
    if (!secret) return err('Server not configured (LICENSE_SECRET)', 500);
    const body = await readBody(req);
    const payload = await verifyLicense(secret, body && body.token);
    if (!payload) return json({ valid: false }, 200);
    // chequear revocación: el código sigue existiendo y atado al mismo device
    if (payload.code) {
        const rec = await kvGet(env, `code:${payload.code}`);
        if (!rec || rec.revoked) return json({ valid: false, reason: 'revoked' }, 200);
        if (rec.deviceId && payload.deviceId && rec.deviceId !== payload.deviceId) {
            return json({ valid: false, reason: 'device_mismatch' }, 200);
        }
    }
    return json({ valid: true, product: payload.product, tier: payload.tier, expiresAt: payload.exp ? new Date(payload.exp).toISOString() : null });
}

async function startTrial(req, env) {
    const secret = env.LICENSE_SECRET;
    if (!secret) return err('Server not configured (LICENSE_SECRET)', 500);
    const body = await readBody(req);
    const deviceId = body && String(body.deviceId || '').trim();
    const product = body && ['coach', 'premium'].includes(body.product) ? body.product : 'premium';
    if (!deviceId) return err('Missing deviceId', 400);
    const key = `trial:${product}:${deviceId}`;
    if (await kvGet(env, key)) return err('Ya usaste la prueba gratuita en este dispositivo', 409);
    const days = TRIAL_DAYS[product] || 3;
    const iat = Date.now();
    const exp = iat + days * 86400000;
    await kvPut(env, key, { issued_at: nowISO() });
    const token = await signLicense(secret, { product, tier: 'premium', deviceId, code: null, iat, exp, trial: true });
    return json({ ok: true, token, product, tier: 'premium', trial: true, days, expiresAt: new Date(exp).toISOString() });
}

async function retrieveCode(env, url) {
    const payment = url.searchParams.get('payment');
    if (!payment) return err('Missing payment', 400);
    const code = await env.BMOD_KV.get(`payment:${payment}`);
    if (!code) return json({ status: 'pending' }, 200);
    return json({ status: 'ready', code });
}

// admin: generar códigos a mano (antes de tener MP, o para regalar)
async function adminCreateCodes(req, env) {
    if (!env.ADMIN_SECRET || req.headers.get('x-admin-secret') !== env.ADMIN_SECRET) return err('Unauthorized', 401);
    const body = await readBody(req);
    const count = Math.min(Math.max(parseInt(body && body.count, 10) || 1, 1), 100);
    const product = body && ['coach', 'premium'].includes(body.product) ? body.product : 'coach';
    const expires_at = body && body.expires_at ? body.expires_at : null;
    const codes = [];
    for (let i = 0; i < count; i++) {
        let code = newCode();
        while (await kvGet(env, `code:${code}`)) code = newCode();
        await kvPut(env, `code:${code}`, { product, used: false, deviceId: null, expires_at, created_at: nowISO(), source: 'admin' });
        codes.push(code);
    }
    return json({ ok: true, product, codes });
}

// ── Checkout (Mercado Pago Checkout Pro) ─────────────────────────────
// Config del producto Coach. El precio SIEMPRE sale del server (env), nunca
// del cliente — así nadie puede pagar menos manipulando el request.
function coachConfig(env) {
    return {
        price: Number(env.COACH_PRICE_ARS) || 0,
        currency: env.COACH_CURRENCY || 'ARS',
        title: env.COACH_TITLE || 'BERSERKERMOD — Modo Coach'
    };
}
// GET /api/products — precio actual para que la landing lo muestre (single source of truth).
function productsInfo(env) {
    const c = coachConfig(env);
    return json({ coach: { price: c.price, currency: c.currency, title: c.title, available: !!env.MP_ACCESS_TOKEN && c.price > 0 } });
}
// POST /api/checkout — crea la preferencia de pago del Coach y devuelve la URL
// del checkout de MP. El webhook (más abajo) genera el código al aprobarse.
async function createCheckout(req, env) {
    if (!env.MP_ACCESS_TOKEN) return err('Checkout no disponible (MP sin configurar)', 503);
    const c = coachConfig(env);
    if (!c.price || c.price <= 0) return err('Precio del Coach sin configurar', 503);
    const origin = new URL(req.url).origin;
    const landing = (env.LANDING_URL || env.APP_ORIGIN || '').replace(/\/+$/, '');
    const pref = {
        items: [{ title: c.title, quantity: 1, unit_price: c.price, currency_id: c.currency }],
        external_reference: 'coach',
        notification_url: origin + '/api/webhook/mercadopago',
        back_urls: {
            success: landing + '/?purchase=coach',
            pending: landing + '/?purchase=pending',
            failure: landing + '/?purchase=failure'
        },
        auto_return: 'approved'
    };
    try {
        const mp = await fetch('https://api.mercadopago.com/checkout/preferences', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + env.MP_ACCESS_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify(pref)
        });
        const data = await mp.json();
        if (!mp.ok || !data.init_point) return err('No se pudo crear el checkout', 502);
        return json({ ok: true, init_point: data.init_point, sandbox_init_point: data.sandbox_init_point || null, id: data.id });
    } catch {
        return err('Checkout upstream error', 502);
    }
}

// ── Mercado Pago webhook ─────────────────────────────────────────────
// MP manda notificaciones de pago. Cuando un pago queda 'approved',
// generamos un código y lo guardamos contra el payment id para que la app
// lo recupere tras el redirect.
async function mercadoPagoWebhook(req, env, url) {
    // Respondemos 200 rápido siempre (MP reintenta si no): el trabajo va adentro.
    try {
        if (!env.MP_ACCESS_TOKEN) return json({ ok: true, note: 'MP no configurado' }, 200);
        const body = await readBody(req);
        const type = (body && (body.type || body.topic)) || url.searchParams.get('type') || url.searchParams.get('topic');
        let paymentId = (body && body.data && body.data.id) || url.searchParams.get('data.id') || url.searchParams.get('id');
        if (type !== 'payment' || !paymentId) return json({ ok: true, ignored: true }, 200);

        const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` }
        });
        if (!mpRes.ok) return json({ ok: true, note: 'payment lookup failed' }, 200);
        const payment = await mpRes.json();
        if (payment.status !== 'approved') return json({ ok: true, status: payment.status }, 200);

        // idempotencia: si ya generamos código para este pago, no dupliques
        const existing = await env.BMOD_KV.get(`payment:${paymentId}`);
        if (existing) return json({ ok: true, code: existing, dup: true }, 200);

        // producto desde external_reference ("coach" | "premium"); default coach
        const product = ['coach', 'premium'].includes(payment.external_reference) ? payment.external_reference : 'coach';
        let code = newCode();
        while (await kvGet(env, `code:${code}`)) code = newCode();
        await kvPut(env, `code:${code}`, { product, used: false, deviceId: null, expires_at: null, created_at: nowISO(), source: 'mercadopago', payment_id: String(paymentId) });
        await env.BMOD_KV.put(`payment:${paymentId}`, code, { expirationTtl: 90 * 86400 });
        return json({ ok: true, code }, 200);
    } catch (e) {
        return json({ ok: true, error: String(e && e.message) }, 200);
    }
}

// ── Oracle (proxy a Anthropic, nunca loguea la key) ──────────────────
async function oracleProxy(req) {
    const body = await readBody(req);
    if (!body || !body.apiKey || !body.prompt) return err('Missing apiKey or prompt', 400);
    try {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': body.apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: ANTHROPIC_MODEL,
                max_tokens: 1024,
                messages: [{ role: 'user', content: body.prompt }]
            })
        });
        const data = await resp.json();
        return json(data, resp.ok ? 200 : resp.status);
    } catch {
        return err('Oracle upstream error', 502);
    }
}

// ── Importar rutina desde PDF (Cloudflare Workers AI, gratis) ─────────
// 1) env.AI.toMarkdown() convierte el PDF a texto (gratis para PDFs de texto).
// 2) un modelo Llama de Workers AI estructura ese texto en la rutina JSON.
// Sin API key ni cuenta de terceros: corre en la misma cuenta de Cloudflare,
// dentro del tier gratuito (10.000 neuronas/día). Gateado a premium/coach.
const PARSE_SYSTEM = [
    'Sos un parser de rutinas de entrenamiento. Recibís una rutina en texto/markdown y devolvés SOLO un objeto JSON válido,',
    'sin texto extra ni markdown ni ```json ni explicaciones. El formato EXACTO es:',
    '{"name": string, "days": [{"name": string, "exercises": [EX]}]}',
    'donde cada EX de fuerza es: {"type":"strength","name":string,"sets":int|null,"reps":string|null,"kg":number|null,"rir":int|null,"notes":string|null}',
    'y cada EX de cardio es: {"type":"cardio","name":string,"distance_km":number|null,"duration_min":int|null,"intensity":"low"|"medium"|"high"|null,"notes":string|null}',
    'Reglas:',
    '- Cardio = correr, trotar, caminar, cinta, bici/ciclismo/spinning, eliptica, nadar, remo ergometro, escalador. El resto es strength.',
    '- reps va como string para permitir rangos ("8-10", "12", "AMRAP", "al fallo").',
    '- Si un dato NO esta en el texto, poné null. No inventes numeros.',
    '- Normaliza los nombres de ejercicios a español claro, en mayuscula inicial.',
    '- Agrupá por DÍA o SESIÓN de entrenamiento, NO por bloque. Una "Sesión A" (o "Día 1") con varios bloques (calentamiento, potencia, fuerza, hipertrofia, acondicionamiento, etc.) es UN SOLO dia con TODOS sus ejercicios juntos.',
    '- "Bloque", "Parte", "Calentamiento", "Principal", "Accesorios", "HIIT" NO son dias: son secciones del MISMO dia.',
    '- Resultado tipico: POCOS dias (2 a 6). Si te salen mas de 7 dias casi seguro estas separando bloques de mas: reagrupalos por sesion/dia.',
    '- Si el mismo dia/sesion aparece resumido en una pagina y detallado en otra, usá la version detallada y NO lo dupliques.',
    '- Solo si NO hay ninguna separacion de dias/sesiones, poné todo en un solo dia ("Dia 1").',
    '- intensity: suave/baja=low, moderada/media=medium, alta/fuerte/intensa=high.',
    '- Si no hay nombre de rutina, inventa uno corto descriptivo.',
    'Devolvé unicamente el JSON, empezando con "{" y terminando con "}".'
].join('\n');

function sanitizeParsedRoutine(p) {
    const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max || 80) : null);
    const numOrNull = (v) => (typeof v === 'number' && isFinite(v) ? v : (v != null && !isNaN(parseFloat(v)) ? parseFloat(v) : null));
    const intOrNull = (v) => { const n = numOrNull(v); return n == null ? null : Math.round(n); };
    const out = { name: str(p && p.name, 60) || 'Rutina importada', days: [] };
    const days = (p && Array.isArray(p.days)) ? p.days.slice(0, 14) : [];
    days.forEach((d, i) => {
        const exsIn = (d && Array.isArray(d.exercises)) ? d.exercises.slice(0, 40) : [];
        const exercises = [];
        for (const e of exsIn) {
            if (!e || !str(e.name, 80)) continue;
            if (e.type === 'cardio') {
                exercises.push({ type: 'cardio', name: str(e.name, 80),
                    distance_km: numOrNull(e.distance_km), duration_min: intOrNull(e.duration_min),
                    intensity: ['low', 'medium', 'high'].includes(e.intensity) ? e.intensity : null,
                    notes: str(e.notes, 200) });
            } else {
                exercises.push({ type: 'strength', name: str(e.name, 80),
                    sets: intOrNull(e.sets), reps: str(e.reps, 24), kg: numOrNull(e.kg),
                    rir: intOrNull(e.rir), notes: str(e.notes, 200) });
            }
        }
        out.days.push({ name: str(d && d.name, 60) || ('Día ' + (i + 1)), exercises });
    });
    if (!out.days.length) out.days.push({ name: 'Día 1', exercises: [] });
    return out;
}

// base64 → Uint8Array (atob es global en Workers y en Node). Necesario para
// armar el Blob del PDF que toma env.AI.toMarkdown().
function base64ToBytes(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

// Modelo de visión para PDFs de imágenes/diseño (el cliente rasteriza las
// páginas con PDF.js y manda los PNG/JPEG acá). OCR puro: transcribe el texto.
const VISION_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const OCR_PROMPT = [
    'Sos un OCR. Transcribí EXACTAMENTE el texto que VES en esta imagen, palabra por palabra,',
    'en orden de lectura (arriba→abajo, izquierda→derecha, columna por columna).',
    'NO completes, NO interpretes, NO inventes: no agregues ejercicios, números ni filas que no estén escritos.',
    'Si una celda está vacía o no se lee, omitila. Copiá días, ejercicios, series, reps, kg, RIR, descansos y notas tal como aparecen.',
    'Si la imagen no tiene texto de rutina, respondé exactamente "(sin texto)".'
].join(' ');

// OCR de una imagen (base64) con un modelo de visión → texto plano.
// Llama 4 Scout usa formato multimodal (messages con image_url), más capaz
// que el 11B. temperature baja para minimizar alucinaciones.
async function ocrImage(env, b64) {
    const clean = b64.replace(/^data:image\/\w+;base64,/, '');
    const r = await env.AI.run(VISION_MODEL, {
        messages: [{ role: 'user', content: [
            { type: 'text', text: OCR_PROMPT },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + clean } }
        ] }],
        max_tokens: 2048,
        temperature: 0.1
    });
    return (r && (r.response || r.description || r.text)) || '';
}

async function parseRoutine(req, env) {
    if (!env.AI) return err('Importador de PDF no configurado (falta el binding AI de Workers AI)', 503);
    const body = await readBody(req);
    // Gate: solo licencias válidas (premium o coach).
    const payload = env.LICENSE_SECRET ? await verifyLicense(env.LICENSE_SECRET, body && body.token) : null;
    if (!payload) return err('Función premium: activá tu código para importar rutinas', 403);

    // Aceptación única de la licencia del modelo de visión (Meta exige enviar
    // 'agree' una vez por cuenta antes de usarlo). Gateado, se llama una sola vez.
    if (body && body.agree_vision) {
        try { const a = await env.AI.run(VISION_MODEL, { prompt: 'agree' }); return json({ ok: true, agreed: true, resp: a }); }
        catch (e) { return json({ error: 'agree falló', detail: String((e && e.message) || e).slice(0, 300) }, 502); }
    }

    // Dos fuentes posibles: imágenes rasterizadas (PDF de diseño/imágenes) o el
    // PDF crudo (texto). El cliente intenta texto primero y cae a imágenes si vuelve vacío.
    let sourceText = '';
    const images = (body && Array.isArray(body.images)) ? body.images.slice(0, 8) : null;
    if (images && images.length) {
        try {
            const valid = images.filter((img) => typeof img === 'string' && img.length <= 4000000); // ~3 MB/imagen
            // OCR de las páginas en paralelo (mucho más rápido que en serie).
            const parts = await Promise.all(valid.map((img) => ocrImage(env, img).catch(() => '')));
            // Marcamos cada página para que el estructurador separe días/sesiones.
            sourceText = parts.map((tx, i) => '=== Página ' + (i + 1) + ' ===\n' + tx).join('\n\n');
        } catch (e) {
            return json({ error: 'No se pudieron leer las imágenes del PDF', detail: String((e && e.message) || e).slice(0, 200) }, 502);
        }
    } else {
        let pdf = body && body.pdf_base64;
        if (!pdf || typeof pdf !== 'string') return err('Falta el PDF', 400);
        pdf = pdf.replace(/^data:application\/pdf;base64,/, '');
        if (pdf.length > 9000000) return err('El PDF es demasiado grande (máx ~6 MB)', 413);
        try {
            const blob = new Blob([base64ToBytes(pdf)], { type: 'application/pdf' });
            const docs = await env.AI.toMarkdown([{ name: 'rutina.pdf', blob }]);
            const doc = Array.isArray(docs) ? docs[0] : docs;
            sourceText = (doc && doc.data) || '';
        } catch (e) {
            return json({ error: 'No se pudo leer el PDF', detail: String((e && e.message) || e).slice(0, 200) }, 502);
        }
    }

    // Debug gateado (solo si el caller manda debug:true): ver el texto crudo.
    if (body && body.debug) return json({ ok: true, debug: true, src: images ? 'vision' : 'text', md_chars: sourceText.length, md_preview: sourceText.slice(0, 4000) });
    if (!sourceText.trim()) return err('El PDF no tiene texto legible (¿es una imagen escaneada?)', 422);
    sourceText = sourceText.slice(0, 24000); // acotamos lo que va al modelo

    // Estructurar con el 70B (texto → JSON), igual para ambas fuentes.
    const model = env.PARSE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
    try {
        const aiResp = await env.AI.run(model, {
            messages: [
                { role: 'system', content: PARSE_SYSTEM },
                { role: 'user', content: 'Rutina (en texto/markdown):\n\n' + sourceText + '\n\nDevolvé SOLO el JSON.' }
            ],
            max_tokens: 4096
        });
        // Workers AI devuelve la respuesta como string (lo normal) o, según el
        // modelo (ej. Llama 70B), como objeto JSON ya parseado. Normalizamos ambos.
        const raw = aiResp ? (aiResp.response != null ? aiResp.response : aiResp.text) : null;
        let parsed = null;
        if (raw && typeof raw === 'object') {
            parsed = raw;
        } else {
            const txt = typeof raw === 'string' ? raw : (raw != null ? String(raw) : '');
            const m = txt.match(/\{[\s\S]*\}/);
            try { parsed = JSON.parse(m ? m[0] : txt); } catch { parsed = null; }
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return err('No se pudo interpretar la rutina del PDF', 422);
        return json({ ok: true, routine: sanitizeParsedRoutine(parsed) });
    } catch (e) {
        return json({ error: 'Error al contactar la IA', detail: String((e && e.message) || e).slice(0, 200) }, 502);
    }
}

// ── Observabilidad ───────────────────────────────────────────────────
async function ingestErrors(req, env) {
    const body = await readBody(req);
    const list = body && Array.isArray(body.errors) ? body.errors : (body ? [body] : []);
    let stored = 0;
    for (const e of list.slice(0, 20)) {
        const key = `error:${Date.now()}:${randToken(TOKEN_ALPHABET, 6)}`;
        await kvPut(env, key, {
            at: (e && e.at) || nowISO(),
            source: (e && e.source) || 'unknown',
            msg: String((e && e.msg) || '').slice(0, 300),
            stack: String((e && e.stack) || '').slice(0, 800),
            ua: (req.headers.get('user-agent') || '').slice(0, 200),
            v: (e && e.v) || null
        }, { expirationTtl: ERROR_TTL });
        stored++;
    }
    return json({ ok: true, stored });
}
async function adminErrors(req, env) {
    if (!env.ADMIN_SECRET || req.headers.get('x-admin-secret') !== env.ADMIN_SECRET) return err('Unauthorized', 401);
    const list = (await listByPrefix(env, 'error:')).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 200);
    return json({ ok: true, count: list.length, errors: list });
}

// ── Salud (off por defecto: privacidad) + server-info + ping ─────────
async function healthData(req, env) {
    if (String(env.ENABLE_HEALTH_SYNC) !== 'true') {
        return json({ ok: false, note: 'health sync disabled' }, 501);
    }
    const body = await readBody(req);
    if (!body || !body.user_id) return err('Missing user_id', 400);
    if (!body.snapshots || !body.snapshots.length) return err('Missing snapshots', 400);
    let accepted = 0;
    for (const snap of body.snapshots) {
        if (!snap || !snap.date) continue;
        await kvPut(env, `health:${body.user_id}:${snap.date}`, { user_id: body.user_id, date: snap.date, data: snap, updated_at: nowISO() }, { expirationTtl: 180 * 86400 });
        accepted++;
    }
    return json({ ok: true, accepted });
}
function serverInfo(env) {
    // En prod no hay LAN; el share_origin es la URL pública de la app.
    const origin = (env.APP_ORIGIN || '') + (env.APP_PATH || '');
    return json({ lan_ip: null, has_lan: false, bound_external: true, share_origin: origin, prod: true, setup_cmds: [] });
}

// =====================================================================
//  Router
// =====================================================================
export default {
    async fetch(req, env) {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
        const url = new URL(req.url);
        const p = url.pathname.replace(/\/+$/, '') || '/';
        const m = req.method;
        let mt;

        try {
            if (p === '/' || p === '/api/health') return json({ ok: true, service: 'berserkermod-api' });

            // Coach
            if (p === '/api/routines' && m === 'POST') return await createRoutine(req, env, url);
            if (p === '/api/routines' && m === 'GET') return await listRoutines(env, url);
            if ((mt = p.match(/^\/api\/routines\/([a-f0-9-]+)\/review$/)) && m === 'POST') return await reviewRoutine(req, env, url, mt[1]);
            if ((mt = p.match(/^\/api\/routines\/([a-f0-9-]+)$/)) && m === 'GET') return await getRoutine(env, url, mt[1]);
            if ((mt = p.match(/^\/api\/routines\/([a-f0-9-]+)$/)) && m === 'PUT') return await updateRoutine(req, env, url, mt[1]);
            if ((mt = p.match(/^\/api\/routines\/([a-f0-9-]+)$/)) && m === 'DELETE') return await deleteRoutine(req, env, url, mt[1]);
            if ((mt = p.match(/^\/api\/shares\/([a-z0-9]+)\/edits$/)) && m === 'POST') return await postEdit(req, env, mt[1]);
            if ((mt = p.match(/^\/api\/shares\/([a-z0-9]+)$/)) && m === 'GET') return await getShare(env, mt[1]);

            // Licencias
            if (p === '/api/license/activate' && m === 'POST') return await activateLicense(req, env);
            if (p === '/api/license/verify' && m === 'POST') return await verifyLicenseHandler(req, env);
            if (p === '/api/license/trial' && m === 'POST') return await startTrial(req, env);
            if (p === '/api/license/retrieve' && m === 'GET') return await retrieveCode(env, url);
            if (p === '/api/admin/codes' && m === 'POST') return await adminCreateCodes(req, env);

            // Checkout / productos
            if (p === '/api/products' && m === 'GET') return productsInfo(env);
            if (p === '/api/checkout' && m === 'POST') return await createCheckout(req, env);

            // Mercado Pago
            if (p === '/api/webhook/mercadopago' && (m === 'POST' || m === 'GET')) return await mercadoPagoWebhook(req, env, url);

            // Oracle
            if (p === '/api/oracle' && m === 'POST') return await oracleProxy(req);
            if (p === '/api/parse-routine' && m === 'POST') return await parseRoutine(req, env);

            // Observabilidad
            if (p === '/api/errors' && m === 'POST') return await ingestErrors(req, env);
            if (p === '/api/admin/errors' && m === 'GET') return await adminErrors(req, env);

            // Salud / varios
            if (p === '/api/health-data' && m === 'POST') return await healthData(req, env);
            if (p === '/api/server-info' && m === 'GET') return serverInfo(env);

            return err('Not found', 404);
        } catch (e) {
            return err('Internal error: ' + String(e && e.message), 500);
        }
    }
};
