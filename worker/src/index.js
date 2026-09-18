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
//                     POST                /api/shares/{token}/sessions  (adherencia alumno)
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
// 7 días para ambos: 3 días de premium no alcanzan para formar hábito (el valor
// real —stats, plan nutricional, rutinas custom— se siente recién en la semana).
const TRIAL_DAYS = { coach: 7, premium: 7 };
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

// ── Límites contra abuso ──
// Contexto: en Workers cada operación de KV cuenta como subrequest y el plan
// Free permite 50 por invocación y 1.000 escrituras de KV por día. Por eso
// (a) nada lista "todas las keys" de un prefijo en rutas públicas, (b) los
// datos por rutina viven en UNA key agregada, y (c) toda ruta pública tiene
// tope de tamaño y rate limit. Detalle en SEGURIDAD-THREAT-MODEL.md (privado).
const MAX_BODY = 256 * 1024;            // body JSON por defecto
const MAX_BODY_PDF = 16 * 1024 * 1024;  // /api/parse-routine (PDF en base64)
const MAX_PLAN_JSON = 100 * 1024;       // plan de una rutina serializado
const MAX_EDIT_JSON = 4 * 1024;         // changes_json de un edit del alumno
const EDITS_MAX = 50;                   // edits guardados por rutina (los viejos se pisan)
const SESSIONS_MAX = 120;               // sesiones de adherencia guardadas por rutina
const ROUTINES_LIST_MAX = 45;           // rutinas por coach que lista /api/routines (Free: 50 subrequests)
const ERRORS_RING_MAX = 150;            // errores recientes (una sola key)
const PUSH_MAX = 1000;                  // suscripciones push
const PUSH_BATCH = 40;                  // pushes por corrida del cron (5 corridas seguidas = 200/día)
// Solo servicios de push reales: sin esto cualquiera registra una URL propia y
// el cron le pega todos los días con nuestra firma VAPID.
const PUSH_HOSTS = ['googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com', 'samsungosp.com'];
// Trial: el deviceId lo elige el cliente (borrar localStorage = "dispositivo
// nuevo"), así que además se cuentan las pruebas por IP: TRIAL_IP_MAX cada 30
// días. Alcanza para un gimnasio detrás de un NAT y frena el trial infinito.
const TRIAL_IP_MAX = 5;
const TRIAL_IP_TTL = 30 * 24 * 3600;
// IA: cuota diaria por licencia (Workers AI da 10.000 neuronas/día para TODOS;
// sin esto una sola licencia —o un trial— puede dejar sin Oracle a los que pagan).
const AI_QUOTA = { oracle: 20, parse: 5 };
// Ticket de retiro del código tras pagar: vive hasta 7 días sin retirar (pagos
// en efectivo) y 15 minutos después del primer retiro (refrescar la página no
// lo pierde; enumerar payment_ids ajenos ya no sirve).
const PAYMENT_TICKET_TTL = 7 * 24 * 3600;
const PAYMENT_TICKET_GRACE = 15 * 60;
// Rutas caras o abusables: 5 req/min por IP (RL_STRICT). El resto: 60/min (RL_OPEN).
const STRICT_ROUTES = ['/api/errors', '/api/checkout', '/api/license/trial', '/api/testers/claim', '/api/oracle', '/api/parse-routine', '/api/push/subscribe'];

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

class PayloadTooLarge extends Error {}
// Lee JSON con tope de tamaño. Excederlo tira PayloadTooLarge → el router
// responde 413 (el header Content-Length se chequea antes, pero un cliente
// a medida puede omitirlo, así que se mide el texto real).
async function readBody(req, max = MAX_BODY) {
    let txt;
    try { txt = await req.text(); } catch { return null; }
    if (txt.length > max) throw new PayloadTooLarge();
    try { return JSON.parse(txt); } catch { return null; }
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

// Lista y lee hasta `max` registros de un prefijo. OJO: 1 list + N gets =
// N+1 subrequests; solo para rutas admin o listas acotadas (rutinas por coach).
async function listByPrefix(env, prefix, max = ROUTINES_LIST_MAX) {
    const out = [];
    let cursor;
    do {
        const res = await env.BMOD_KV.list({ prefix, cursor, limit: Math.min(max - out.length, 1000) });
        for (const k of res.keys) {
            if (out.length >= max) break;
            const v = await env.BMOD_KV.get(k.name);
            if (v) out.push(JSON.parse(v));
        }
        cursor = res.list_complete || out.length >= max ? null : res.cursor;
    } while (cursor);
    return out;
}
function routineKey(coachId, id) { return `routine:${coachId}:${id}`; }
// Datos por rutina en UNA key agregada cada uno (1 get + 1 put, sin listar):
//   edits:{routineId}    = { items: [edit, ...] }    más nuevo primero, tope EDITS_MAX
//   sessions:{routineId} = { items: [sess, ...] }    fecha desc, una por fecha, tope SESSIONS_MAX
// Los contadores que muestra la lista del coach viven denormalizados en el
// registro de la rutina (edit_count, unreviewed_count, session_count, ...).
function editsKey(routineId) { return `edits:${routineId}`; }
function sessionsKey(routineId) { return `sessions:${routineId}`; }
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : null);

// ── Rate limiting (binding nativo de Workers; no consume KV ni cuenta como subrequest) ──
// Sin binding (tests, wrangler dev) no limita. Key por IP: es lo único que hay
// en rutas anónimas; un gimnasio detrás de un NAT entra holgado en 60/min.
async function rateLimited(env, name, key) {
    const rl = env[name];
    if (!rl || typeof rl.limit !== 'function') return false;
    try { const { success } = await rl.limit({ key }); return !success; } catch { return false; }
}
function clientIp(req) { return req.headers.get('CF-Connecting-IP') || 'unknown'; }
// Huella de IP para contadores anti-abuso: hash con sal, nunca la IP en claro.
async function ipHash(ip) {
    const digest = await crypto.subtle.digest('SHA-256', enc.encode('ip:' + ip));
    return b64urlFromBytes(new Uint8Array(digest)).slice(0, 22);
}
// Cuota diaria de IA por licencia (1 get + 1 put por llamada). La identidad es
// el código de licencia o, en trials/Play, el deviceId del token.
async function aiQuotaOk(env, payload, kind) {
    const id = (payload && (payload.code || payload.deviceId)) || 'anon';
    const key = `aiq:${new Date().toISOString().slice(0, 10)}:${id}`;
    const rec = (await kvGet(env, key)) || {};
    if ((rec[kind] || 0) >= AI_QUOTA[kind]) return false;
    rec[kind] = (rec[kind] || 0) + 1;
    await kvPut(env, key, rec, { expirationTtl: 2 * 86400 });
    return true;
}

// =====================================================================
//  Handlers
// =====================================================================

// ── Coach: rutinas ───────────────────────────────────────────────────
function planTooBig(plan) { return JSON.stringify(plan).length > MAX_PLAN_JSON; }

async function createRoutine(req, env, url) {
    const body = await readBody(req);
    const coachId = coachIdFrom(req, url, body);
    if (!coachId || String(coachId).length > 80) return err('Missing coach_id', 401);
    if (!body || !body.name || !body.plan) return err('Missing name or plan', 400);
    if (typeof body.plan !== 'object' || planTooBig(body.plan)) return err('Plan inválido o demasiado grande', 413);

    let token = newShareToken();
    // colisión improbable; reintenta una vez
    if (await kvGet(env, `token:${token}`)) token = newShareToken();
    const now = nowISO();
    const routine = {
        id: uuid(),
        coach_id: coachId,
        coach_name: str(body.coach_name, 80),
        name: str(body.name, 80),
        plan: body.plan,
        alumno_name: str(body.alumno_name, 80),
        alumno_email: str(body.alumno_email, 120),
        share_token: token,
        created_at: now,
        updated_at: now,
        last_coach_update_at: now,
        last_seen_by_alumno_at: null,
        // contadores denormalizados (los mantiene postEdit / postShareSession / reviewRoutine)
        edit_count: 0, unreviewed_count: 0, last_alumno_edit_at: null,
        session_count: 0, last_session_at: null, recent_session_dates: []
    };
    await kvPut(env, routineKey(coachId, routine.id), routine);
    await kvPut(env, `token:${token}`, { coachId, routineId: routine.id });
    return json(routine, 201);
}

async function listRoutines(env, url) {
    const coachId = url.searchParams.get('coach_id');
    if (!coachId) return err('Missing coach_id', 400);
    // 1 list + N gets (N ≤ ROUTINES_LIST_MAX). Todo lo demás sale del registro.
    const routines = await listByPrefix(env, `routine:${coachId}:`, ROUTINES_LIST_MAX);
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    return json(routines.map((r) => ({
        id: r.id, name: r.name, alumno_name: r.alumno_name, alumno_email: r.alumno_email,
        share_token: r.share_token, created_at: r.created_at,
        last_alumno_edit_at: r.last_alumno_edit_at || null, edit_count: r.edit_count || 0,
        unreviewed_count: r.unreviewed_count || 0, last_seen_by_alumno_at: r.last_seen_by_alumno_at,
        session_count: r.session_count || 0,
        last_session_at: r.last_session_at || null,
        week_sessions: (r.recent_session_dates || []).filter((d) => d >= weekAgo).length
    })));
}

async function getRoutine(env, url, id) {
    const coachId = url.searchParams.get('coach_id');
    // Necesitamos coachId para construir la key; sin él no se puede buscar.
    const r = coachId ? await kvGet(env, routineKey(coachId, id)) : null;
    if (!r) return err('Not found', 404);
    if (r.coach_id !== coachId) return err('Forbidden', 403);
    const edits = ((await kvGet(env, editsKey(id))) || { items: [] }).items;
    // Sesiones del alumno (últimas 30) para que el coach vea la adherencia real.
    const sessions = ((await kvGet(env, sessionsKey(id))) || { items: [] }).items.slice(0, 30);
    return json({ routine: r, edits, sessions });
}

async function updateRoutine(req, env, url, id) {
    const body = await readBody(req);
    const coachId = coachIdFrom(req, url, body);
    if (!coachId) return err('Missing coach_id', 401);
    const r = await kvGet(env, routineKey(coachId, id));
    if (!r) return err('Not found', 404);
    if (r.coach_id !== coachId) return err('Forbidden', 403);
    if (body.plan && (typeof body.plan !== 'object' || planTooBig(body.plan))) return err('Plan inválido o demasiado grande', 413);
    const now = nowISO();
    if (body.name) r.name = str(body.name, 80);
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
    await env.BMOD_KV.delete(editsKey(id));
    await env.BMOD_KV.delete(sessionsKey(id));
    return json({ ok: true });
}

async function reviewRoutine(req, env, url, id) {
    const body = await readBody(req);
    const coachId = coachIdFrom(req, url, body);
    if (!coachId) return err('Missing coach_id', 401);
    const r = await kvGet(env, routineKey(coachId, id));
    if (!r) return err('Not found', 404);
    if (r.coach_id !== coachId) return err('Forbidden', 403);
    const agg = (await kvGet(env, editsKey(id))) || { items: [] };
    let changed = false;
    for (const e of agg.items) if (!e.reviewed_by_coach) { e.reviewed_by_coach = true; changed = true; }
    if (changed) await kvPut(env, editsKey(id), agg);
    if (r.unreviewed_count) { r.unreviewed_count = 0; await kvPut(env, routineKey(coachId, id), r); }
    return json({ ok: true });
}

// ── Coach: shares (público, por token) ───────────────────────────────
async function getShare(env, token) {
    const idx = await kvGet(env, `token:${token}`);
    if (!idx) return err('Routine not found', 404);
    const r = await kvGet(env, routineKey(idx.coachId, idx.routineId));
    if (!r) return err('Routine not found', 404);
    // "visto por el alumno": como mucho una escritura por hora (cada put gasta
    // cuota de KV; sin esto, refrescar el link en loop la agota).
    const seen = r.last_seen_by_alumno_at ? new Date(r.last_seen_by_alumno_at).getTime() : 0;
    if (Date.now() - seen > 3600000) {
        r.last_seen_by_alumno_at = nowISO();
        await kvPut(env, routineKey(idx.coachId, idx.routineId), r);
    }
    const edits = ((await kvGet(env, editsKey(r.id))) || { items: [] }).items.slice(0, 20);
    // Sesiones del alumno (para que vea su propia adherencia y el check de hoy)
    const sessions = ((await kvGet(env, sessionsKey(r.id))) || { items: [] }).items.slice(0, 30);
    const publicRoutine = {
        id: r.id, name: r.name, plan: r.plan, coach_name: r.coach_name,
        alumno_name: r.alumno_name, share_token: r.share_token,
        last_coach_update_at: r.last_coach_update_at, created_at: r.created_at
    };
    return json({ routine: publicRoutine, edits, sessions });
}

// Fecha real (no solo con forma de fecha) y dentro de una ventana razonable:
// hasta un año atrás y un día adelante (huso horario del alumno).
function validSessionDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
    const t = Date.parse(s + 'T12:00:00Z');
    if (isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) return false;
    const now = Date.now();
    return t >= now - 366 * 86400000 && t <= now + 86400000;
}

// POST /api/shares/{token}/sessions — el alumno registra que entrenó (adherencia).
// Una por fecha (idempotente): si registra dos veces el mismo día, se pisa.
async function postShareSession(req, env, token) {
    const idx = await kvGet(env, `token:${token}`);
    if (!idx) return err('Routine not found', 404);
    const body = await readBody(req);
    const date = (body && body.date) ? body.date : new Date().toISOString().slice(0, 10);
    if (!validSessionDate(date)) return err('Fecha inválida', 400);
    const sess = { date, day_name: str(body && body.day_name, 60) || '', at: nowISO() };

    const agg = (await kvGet(env, sessionsKey(idx.routineId))) || { items: [] };
    const isNew = !agg.items.some((s) => s.date === date);
    agg.items = [sess].concat(agg.items.filter((s) => s.date !== date))
        .sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, SESSIONS_MAX);
    await kvPut(env, sessionsKey(idx.routineId), agg);

    const r = await kvGet(env, routineKey(idx.coachId, idx.routineId));
    if (r && isNew) {
        r.session_count = (r.session_count || 0) + 1;
        r.recent_session_dates = agg.items.slice(0, 14).map((s) => s.date);
        r.last_session_at = r.recent_session_dates[0] || null;
        await kvPut(env, routineKey(idx.coachId, idx.routineId), r);
    }
    return json({ ok: true, session: sess }, 201);
}

async function postEdit(req, env, token) {
    const idx = await kvGet(env, `token:${token}`);
    if (!idx) return err('Routine not found', 404);
    const body = await readBody(req);
    if (!body || !body.changes_json) return err('Missing changes_json', 400);
    if (JSON.stringify(body.changes_json).length > MAX_EDIT_JSON) return err('Edit demasiado grande', 413);
    const edit = {
        id: uuid(),
        routine_id: idx.routineId,
        share_token: token,
        changes_json: body.changes_json,
        edited_by: body.edited_by === 'coach' ? 'coach' : 'alumno',
        editor_name: str(body.editor_name, 40),
        edited_at: nowISO(),
        reviewed_by_coach: false
    };
    const agg = (await kvGet(env, editsKey(idx.routineId))) || { items: [] };
    agg.items = [edit].concat(agg.items).slice(0, EDITS_MAX);
    await kvPut(env, editsKey(idx.routineId), agg);

    if (edit.edited_by === 'alumno') {
        const r = await kvGet(env, routineKey(idx.coachId, idx.routineId));
        if (r) {
            r.edit_count = (r.edit_count || 0) + 1;
            r.unreviewed_count = (r.unreviewed_count || 0) + 1;
            r.last_alumno_edit_at = edit.edited_at;
            await kvPut(env, routineKey(idx.coachId, idx.routineId), r);
        }
    }
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
    if (rec.expires_at && new Date(rec.expires_at).getTime() < Date.now()) return err('Código vencido', 403);
    if (!rec.used) {
        // primera activación. Si el código es por duración (premium 1/3/6/12
        // meses), el reloj arranca ACÁ — no en la compra — y queda fijado en el
        // código: re-activar o cambiar de teléfono no lo extiende.
        rec.used = true; rec.deviceId = deviceId; rec.activated_at = nowISO();
        if (rec.duration_days && !rec.expires_at) {
            rec.expires_at = new Date(Date.now() + rec.duration_days * 86400000).toISOString();
        }
        await kvPut(env, `code:${code}`, rec);
    } else if (rec.deviceId && rec.deviceId !== deviceId) {
        // re-binding: el usuario cambió de teléfono. Movemos la licencia al
        // nuevo device (last-device-wins). Tope de movimientos para frenar que
        // un mismo código circule entre muchas personas.
        rec.rebinds = (rec.rebinds || 0) + 1;
        // Los regalos de tester (vitalicios) toleran menos cambios de teléfono:
        // así un código no circula entre 10 personas.
        if (rec.rebinds > (rec.source === 'tester-auto' ? 3 : 10)) return err('Este código se usó en demasiados dispositivos', 409);
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
    // tope por red (ver TRIAL_IP_MAX); la IP se guarda hasheada
    const ipKey = `trial-ip:${product}:${await ipHash(clientIp(req))}`;
    const ipRec = (await kvGet(env, ipKey)) || { n: 0 };
    if (ipRec.n >= TRIAL_IP_MAX) return err('Demasiadas pruebas gratuitas desde esta red. Si es un error, escribinos.', 429);
    const days = TRIAL_DAYS[product] || 3;
    const iat = Date.now();
    const exp = iat + days * 86400000;
    await kvPut(env, key, { issued_at: nowISO() });
    await kvPut(env, ipKey, { n: ipRec.n + 1 }, { expirationTtl: TRIAL_IP_TTL });
    const token = await signLicense(secret, { product, tier: 'premium', deviceId, code: null, iat, exp, trial: true });
    return json({ ok: true, token, product, tier: 'premium', trial: true, days, expiresAt: new Date(exp).toISOString() });
}

// Devuelve el código de un pago aprobado. Al PRIMER retiro el ticket pasa a
// vivir solo PAYMENT_TICKET_GRACE más (refrescar la página lo sigue mostrando;
// alguien que adivine el payment_id después, no). Si el comprador lo perdió,
// el código sigue en code:{...} con payment_id → soporte por mail.
async function retrieveCode(env, url) {
    const payment = url.searchParams.get('payment');
    if (!payment || payment.length > 40) return err('Missing payment', 400);
    const raw = await env.BMOD_KV.get(`payment:${payment}`);
    if (!raw) return json({ status: 'pending' }, 200);
    let ticket;
    try { ticket = JSON.parse(raw); } catch { ticket = null; }
    if (!ticket || typeof ticket !== 'object') ticket = { code: raw, retrieved_at: null }; // formato viejo: string
    if (!ticket.retrieved_at) {
        ticket.retrieved_at = nowISO();
        await kvPut(env, `payment:${payment}`, ticket, { expirationTtl: PAYMENT_TICKET_GRACE });
    }
    return json({ status: 'ready', code: ticket.code });
}

// admin: generar códigos a mano (regalos, promos). `months` (1|3|6|12) genera
// un código por duración (coach o premium) — el reloj arranca al activarse.
// Sin months → código vitalicio (regalos permanentes).
async function adminCreateCodes(req, env) {
    if (!env.ADMIN_SECRET || req.headers.get('x-admin-secret') !== env.ADMIN_SECRET) return err('Unauthorized', 401);
    const body = await readBody(req);
    const count = Math.min(Math.max(parseInt(body && body.count, 10) || 1, 1), 100);
    const product = body && ['coach', 'premium'].includes(body.product) ? body.product : 'coach';
    const expires_at = body && body.expires_at ? body.expires_at : null;
    const months = body && PLAN_MONTHS.includes(Number(body.months)) ? Number(body.months) : null;
    const duration_days = months ? PLAN_DURATION_DAYS[months] : null;
    const codes = [];
    for (let i = 0; i < count; i++) {
        let code = newCode();
        while (await kvGet(env, `code:${code}`)) code = newCode();
        await kvPut(env, `code:${code}`, { product, duration_days, used: false, deviceId: null, expires_at, created_at: nowISO(), source: 'admin' });
        codes.push(code);
    }
    return json({ ok: true, product, months, codes });
}

// ── Checkout (Mercado Pago Checkout Pro) ─────────────────────────────
// Ambos productos van por DURACIÓN (1/3/6/12 meses): Premium (la app completa
// menos alumnos) y Coach (Premium + modo entrenador, tier profesional a 2×).
// El precio SIEMPRE sale del server (env), nunca del cliente — así nadie
// puede pagar menos manipulando el request.
const PLAN_MONTHS = [1, 3, 6, 12];
// Días con changüí (31/92/183/366): el vencimiento corre desde la ACTIVACIÓN.
const PLAN_DURATION_DAYS = { 1: 31, 3: 92, 6: 183, 12: 366 };

function planConfig(env, product, months) {
    const prefix = product === 'coach' ? 'COACH' : 'PREMIUM';
    const baseTitle = product === 'coach'
        ? (env.COACH_TITLE || 'BERSERKERMOD - Modo Coach')
        : (env.PREMIUM_TITLE || 'BERSERKERMOD - Premium');
    return {
        product, months,
        price: Number(env[prefix + '_PRICE_ARS_' + months + 'M']) || 0,
        currency: env.COACH_CURRENCY || 'ARS',
        title: baseTitle + ' · ' + months + (months === 1 ? ' mes' : ' meses'),
        duration_days: PLAN_DURATION_DAYS[months]
    };
}
function productPlans(env, product) {
    const mp = !!env.MP_ACCESS_TOKEN;
    const base = planConfig(env, product, 1);
    return PLAN_MONTHS.map((m) => {
        const p = planConfig(env, product, m);
        const perMonth = p.price > 0 ? Math.round(p.price / m) : 0;
        // % de ahorro vs pagar mes a mes al precio base
        const discount = (base.price > 0 && m > 1 && p.price > 0)
            ? Math.max(0, Math.round((1 - p.price / (base.price * m)) * 100)) : 0;
        return { id: product + '_' + m + 'm', months: m, price: p.price, per_month: perMonth, discount_pct: discount, currency: p.currency, title: p.title, available: mp && p.price > 0 };
    });
}
// GET /api/products — precios actuales para que la landing los muestre (single source of truth).
function productsInfo(env) {
    return json({
        coach_plans: productPlans(env, 'coach'),
        premium_plans: productPlans(env, 'premium')
    });
}
// POST /api/checkout — crea la preferencia de pago del plan pedido y devuelve
// la URL del checkout de MP: {product: 'coach'|'premium', months: 1|3|6|12}.
// Sin months (landing vieja cacheada) → 1 mes. El webhook (más abajo) genera
// el código con la duración al aprobarse el pago.
async function createCheckout(req, env) {
    if (!env.MP_ACCESS_TOKEN) return err('Checkout no disponible (MP sin configurar)', 503);
    const body = await readBody(req);
    const product = (body && body.product === 'premium') ? 'premium' : 'coach';
    const months = (body && PLAN_MONTHS.includes(Number(body.months))) ? Number(body.months) : 1;
    const c = planConfig(env, product, months);
    const extRef = product + '_' + months + 'm';
    const purchaseTag = product;
    if (!c.price || c.price <= 0) return err('Precio de ' + extRef + ' sin configurar', 503);
    const origin = new URL(req.url).origin;
    const landing = (env.LANDING_URL || env.APP_ORIGIN || '').replace(/\/+$/, '');
    const pref = {
        items: [{ title: c.title, quantity: 1, unit_price: c.price, currency_id: c.currency }],
        external_reference: extRef,
        notification_url: origin + '/api/webhook/mercadopago',
        back_urls: {
            success: landing + '/?purchase=' + purchaseTag,
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

        // idempotencia: si ya generamos código para este pago, no dupliques.
        // paid:{id} es el marcador durable (90 días); payment:{id} es el ticket
        // de retiro, que se acorta al primer retiro (ver retrieveCode).
        const existing = await env.BMOD_KV.get(`paid:${paymentId}`);
        if (existing) return json({ ok: true, code: existing, dup: true }, 200);

        // producto desde external_reference: "{coach|premium}_{N}m" (por
        // duración; N = 1|3|6|12). Legacy "coach"/"premium" a secas (preferencias
        // viejas pendientes de pago) → se honra como vitalicio, que es lo que
        // se compró en su momento.
        const extRef = String(payment.external_reference || '');
        let product = 'coach', duration_days = null;
        const pm = extRef.match(/^(coach|premium)_(1|3|6|12)m$/);
        if (pm) { product = pm[1]; duration_days = PLAN_DURATION_DAYS[Number(pm[2])] || null; }
        else if (extRef === 'premium') product = 'premium';
        let code = newCode();
        while (await kvGet(env, `code:${code}`)) code = newCode();
        await kvPut(env, `code:${code}`, { product, duration_days, used: false, deviceId: null, expires_at: null, created_at: nowISO(), source: 'mercadopago', payment_id: String(paymentId) });
        await env.BMOD_KV.put(`paid:${paymentId}`, code, { expirationTtl: 90 * 86400 });
        await kvPut(env, `payment:${paymentId}`, { code, retrieved_at: null }, { expirationTtl: PAYMENT_TICKET_TTL });
        return json({ ok: true, code }, 200);
    } catch (e) {
        return json({ ok: true, error: String(e && e.message) }, 200);
    }
}

// ── Oracle (proxy a Anthropic, nunca loguea la key) ──────────────────
// Oracle: dos caminos.
// 1) DEFAULT (sin fricción): {token, prompt} — licencia premium/coach válida →
//    Workers AI (Llama 70B, gratis). Devuelve {ok, insights} ya parseado.
// 2) LEGACY (opcional): {apiKey, prompt} — la key Anthropic del usuario →
//    proxy a Claude (respuesta cruda de Anthropic, como siempre). Nunca se loguea.
async function oracleProxy(req, env) {
    const body = await readBody(req);
    if (!body || !body.prompt) return err('Missing prompt', 400);

    if (body.apiKey) {
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

    // Camino Workers AI (gratis): gateado por licencia premium/coach.
    if (!env.AI) return err('Oracle no configurado (falta el binding AI)', 503);
    const payload = env.LICENSE_SECRET ? await verifyLicense(env.LICENSE_SECRET, body.token) : null;
    if (!payload) return err('Función premium: activá tu código para usar el Oracle', 403);
    if (!(await aiQuotaOk(env, payload, 'oracle'))) return err('Llegaste al límite diario del Oracle (' + AI_QUOTA.oracle + ' consultas). Mañana se renueva.', 429);
    const model = env.PARSE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
    try {
        const aiResp = await env.AI.run(model, {
            messages: [{ role: 'user', content: String(body.prompt).slice(0, 8000) }],
            max_tokens: 1024
        });
        // Igual que parse-routine: la respuesta puede venir como objeto ya parseado
        // (70B) o como string con el JSON adentro.
        const raw = aiResp ? (aiResp.response != null ? aiResp.response : aiResp.text) : null;
        let parsed = null;
        if (raw && typeof raw === 'object') parsed = raw;
        else {
            const txt = typeof raw === 'string' ? raw : (raw != null ? String(raw) : '');
            const m = txt.match(/\{[\s\S]*\}/);
            try { parsed = JSON.parse(m ? m[0] : txt); } catch { parsed = null; }
        }
        const insights = parsed && Array.isArray(parsed.insights) ? parsed.insights : null;
        if (!insights) return err('La IA no devolvió un análisis válido, probá de nuevo', 422);
        // Sanitizado: caps y solo los campos esperados.
        const clean = insights.slice(0, 6).map((i) => ({
            icon: String((i && i.icon) || '💡').slice(0, 8),
            title: String((i && i.title) || '').slice(0, 80),
            text: String((i && i.text) || '').slice(0, 400)
        })).filter((i) => i.title || i.text);
        return json({ ok: true, insights: clean });
    } catch (e) {
        return json({ error: 'Error al contactar la IA', detail: String((e && e.message) || e).slice(0, 200) }, 502);
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
    const body = await readBody(req, MAX_BODY_PDF);
    // Gate: solo licencias válidas (premium o coach).
    const payload = env.LICENSE_SECRET ? await verifyLicense(env.LICENSE_SECRET, body && body.token) : null;
    if (!payload) return err('Función premium: activá tu código para importar rutinas', 403);
    if (!(await aiQuotaOk(env, payload, 'parse'))) return err('Llegaste al límite diario de importaciones (' + AI_QUOTA.parse + ' por día). Mañana se renueva.', 429);

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
// Ring buffer en UNA key (errors:ring): 1 get + 1 put por request, sin importar
// cuántos errores traiga. Antes era una key por error (20 escrituras por
// request: 50 requests agotaban la cuota diaria de KV del plan Free).
// Dos ingests simultáneos pueden pisarse — para diagnóstico es aceptable.
async function ingestErrors(req, env) {
    const body = await readBody(req);
    const list = body && Array.isArray(body.errors) ? body.errors : (body ? [body] : []);
    if (!list.length) return json({ ok: true, stored: 0 });
    const ua = (req.headers.get('user-agent') || '').slice(0, 200);
    const incoming = list.slice(0, 20).map((e) => ({
        at: String((e && e.at) || nowISO()).slice(0, 40),
        source: String((e && e.source) || 'unknown').slice(0, 40),
        msg: String((e && e.msg) || '').slice(0, 300),
        stack: String((e && e.stack) || '').slice(0, 800),
        ua,
        v: (e && e.v) ? String(e.v).slice(0, 40) : null
    }));
    const ring = (await kvGet(env, 'errors:ring')) || { items: [] };
    const cutoff = new Date(Date.now() - ERROR_TTL * 1000).toISOString();
    ring.items = incoming.concat((ring.items || []).filter((x) => x.at >= cutoff)).slice(0, ERRORS_RING_MAX);
    await kvPut(env, 'errors:ring', ring);
    return json({ ok: true, stored: incoming.length });
}
async function adminErrors(req, env) {
    if (!env.ADMIN_SECRET || req.headers.get('x-admin-secret') !== env.ADMIN_SECRET) return err('Unauthorized', 401);
    const ring = (await kvGet(env, 'errors:ring')) || { items: [] };
    return json({ ok: true, count: ring.items.length, errors: ring.items });
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
// ── Push notifications (recordatorio diario de entrenamiento) ────────
// V1 sin payload: el cron manda un push VACÍO autenticado con VAPID (RFC 8292)
// y el Service Worker compone la notificación localmente. Así evitamos el
// cifrado de payload (RFC 8291) — menos código, cero secretos en tránsito.
async function sha256hex(s) {
    const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Suscripciones en UNA key (push:all = { subs: { [sha256(endpoint)]: {...} } }).
// Solo endpoints de servicios de push reales (PUSH_HOSTS): si no, cualquiera
// registra su propio servidor y el cron le pega a diario con nuestra firma.
function pushHostAllowed(endpoint) {
    let u; try { u = new URL(endpoint); } catch { return false; }
    if (u.protocol !== 'https:') return false;
    return PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
}

async function pushSubscribe(req, env) {
    const body = await readBody(req);
    const sub = body && body.subscription;
    if (!sub || typeof sub.endpoint !== 'string' || sub.endpoint.length > 1024) return err('Missing subscription', 400);
    if (!pushHostAllowed(sub.endpoint)) return err('Servicio de notificaciones no soportado', 400);
    const id = await sha256hex(sub.endpoint);
    const all = (await kvGet(env, 'push:all')) || { subs: {} };
    if (!all.subs[id] && Object.keys(all.subs).length >= PUSH_MAX) return err('Cupo de recordatorios completo', 409);
    all.subs[id] = {
        endpoint: sub.endpoint,
        lang: (body.lang === 'en' || body.lang === 'pt') ? body.lang : 'es',
        created_at: (all.subs[id] && all.subs[id].created_at) || nowISO()
    };
    await kvPut(env, 'push:all', all);
    return json({ ok: true });
}

async function pushUnsubscribe(req, env) {
    const body = await readBody(req);
    const endpoint = body && body.endpoint;
    if (!endpoint || typeof endpoint !== 'string' || endpoint.length > 1024) return err('Missing endpoint', 400);
    const id = await sha256hex(endpoint);
    const all = (await kvGet(env, 'push:all')) || { subs: {} };
    if (all.subs[id]) { delete all.subs[id]; await kvPut(env, 'push:all', all); }
    return json({ ok: true });
}

// ─────────────────────────────────────────────
// TESTERS (prueba cerrada de Google Play) — Premium vitalicio automático.
// La app llama a esto SOLO cuando corre dentro de la TWA de Android (durante
// la prueba cerrada, eso solo se consigue instalando desde Play como tester)
// y después del primer entrenamiento guardado. Acá se acuña un código real en
// KV (source 'tester-auto'), ya activado y atado al deviceId, y se devuelve el
// token firmado igual que /api/license/activate. Defensas: 1 por dispositivo
// (idempotente: repetir devuelve el mismo código), tope global, tope blando
// por IP y kill-switch por var (TESTERS_CLAIM_OPEN). Cerrar la canilla cuando
// termine la prueba: TESTERS_CLAIM_OPEN = "false" + redeploy.
// ─────────────────────────────────────────────
const TESTERS_CLAIM_MAX_DEFAULT = 25;
const TESTERS_IP_MAX = 5;               // tope blando por IP (una casa, varios testers)
const TESTERS_IP_TTL = 30 * 24 * 3600;  // 30 días

async function testersClaim(req, env) {
    const secret = env.LICENSE_SECRET;
    if (!secret) return err('Server not configured (LICENSE_SECRET)', 500);
    if (String(env.TESTERS_CLAIM_OPEN || '') !== 'true') return err('closed', 403);
    const body = await readBody(req);
    const deviceId = body && String(body.deviceId || '').trim();
    if (!deviceId || deviceId.length > 80) return err('Missing deviceId', 400);
    // La app solo muestra el reclamo dentro de la TWA, pero eso es un flag en
    // localStorage: acá se exige lo que Chrome Android manda solo en cada
    // request (client hints por defecto + UA). Un navegador de escritorio con
    // DevTools no pasa; falsificarlo exige un cliente a medida y saber esto.
    const ua = req.headers.get('user-agent') || '';
    const chMobile = req.headers.get('sec-ch-ua-mobile') || '';
    const chPlatform = req.headers.get('sec-ch-ua-platform') || '';
    if (!/Android/i.test(ua) || chMobile.trim() !== '?1' || !/android/i.test(chPlatform)) return err('android_only', 403);

    const issue = async (code, rec) => {
        const iat = Date.now();
        const token = await signLicense(secret, { product: 'premium', tier: 'premium', deviceId, code, iat, exp: null });
        return json({ ok: true, token, code, product: 'premium', tier: 'premium', expiresAt: null, created_at: rec.created_at });
    };

    // 1 por dispositivo — repetir es idempotente (mismo código, token nuevo)
    const prev = await kvGet(env, `tester:${deviceId}`);
    if (prev && prev.code) {
        const rec = await kvGet(env, `code:${prev.code}`);
        if (rec && !rec.revoked) return issue(prev.code, rec);
        return err('Código revocado', 403);
    }

    // tope global
    const max = parseInt(env.TESTERS_CLAIM_MAX, 10) || TESTERS_CLAIM_MAX_DEFAULT;
    const counter = (await kvGet(env, 'testers:count')) || { n: 0 };
    if (counter.n >= max) return err('Cupo de testers completo', 409);

    // tope blando por IP (hash, no se guarda la IP)
    const ip = req.headers.get('CF-Connecting-IP') || '';
    let ipKey = null;
    if (ip) {
        ipKey = 'tester-ip:' + await ipHash(ip);
        const ipRec = (await kvGet(env, ipKey)) || { n: 0 };
        if (ipRec.n >= TESTERS_IP_MAX) return err('Demasiados reclamos desde esta red', 429);
        await kvPut(env, ipKey, { n: ipRec.n + 1 }, { expirationTtl: TESTERS_IP_TTL });
    }

    let code = newCode();
    while (await kvGet(env, `code:${code}`)) code = newCode();
    const rec = {
        product: 'premium', duration_days: null, used: true, deviceId, expires_at: null,
        created_at: nowISO(), activated_at: nowISO(), source: 'tester-auto'
    };
    await kvPut(env, `code:${code}`, rec);
    await kvPut(env, `tester:${deviceId}`, { code, claimed_at: rec.created_at });
    await kvPut(env, 'testers:count', { n: counter.n + 1 });
    return issue(code, rec);
}

// admin: cuántos testers reclamaron (para cruzar con el panel de Play)
async function adminTesters(req, env) {
    if (!env.ADMIN_SECRET || req.headers.get('x-admin-secret') !== env.ADMIN_SECRET) return err('Unauthorized', 401);
    const counter = (await kvGet(env, 'testers:count')) || { n: 0 };
    const claims = await listByPrefix(env, 'tester:');
    return json({ ok: true, count: counter.n, open: String(env.TESTERS_CLAIM_OPEN || '') === 'true', claims });
}

// ─────────────────────────────────────────────
// GOOGLE PLAY BILLING — suscripción Premium comprada DENTRO de la TWA.
// El cliente manda {sku, purchaseToken, deviceId}; acá se verifica contra la
// API de Google Play (service account, JWT RS256), se hace acknowledge (sin
// eso Google devuelve la plata a los 3 días) y se emite una licencia normal
// con exp = fin del período. La renovación es transparente: Google renueva,
// el cliente re-verifica al abrir y recibe el exp nuevo.
// Secrets/vars: PLAY_SA_JSON (service account, secret) + PLAY_PACKAGE (var).
// ─────────────────────────────────────────────
const PLAY_SKUS = ['premium_1m', 'premium_3m', 'premium_6m', 'premium_12m'];

let _playToken = { v: null, exp: 0 }; // cache del access token (por isolate)
async function playAccessToken(env) {
    if (_playToken.v && Date.now() < _playToken.exp - 60000) return _playToken.v;
    const sa = JSON.parse(env.PLAY_SA_JSON);
    const now = Math.floor(Date.now() / 1000);
    const signingInput = b64urlEncodeJSON({ alg: 'RS256', typ: 'JWT' }) + '.' +
        b64urlEncodeJSON({
            iss: sa.client_email,
            scope: 'https://www.googleapis.com/auth/androidpublisher',
            aud: 'https://oauth2.googleapis.com/token',
            iat: now, exp: now + 3600
        });
    const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const keyBytes = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', keyBytes.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput)));
    const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
            '&assertion=' + (signingInput + '.' + b64urlFromBytes(sig))
    });
    if (!resp.ok) throw new Error('play oauth ' + resp.status);
    const j = await resp.json();
    _playToken = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return _playToken.v;
}

async function playVerify(req, env) {
    if (!env.LICENSE_SECRET) return err('Server not configured (LICENSE_SECRET)', 500);
    if (!env.PLAY_SA_JSON || !env.PLAY_PACKAGE) return err('Play Billing no configurado', 503);
    const body = await readBody(req);
    const sku = body && String(body.sku || '').trim();
    const purchaseToken = body && String(body.purchaseToken || '').trim();
    const deviceId = body && String(body.deviceId || '').trim();
    if (!PLAY_SKUS.includes(sku)) return err('SKU inválido', 400);
    if (!purchaseToken || !deviceId) return err('Missing purchaseToken or deviceId', 400);

    let access;
    try { access = await playAccessToken(env); } catch { return err('No se pudo autenticar con Google Play', 502); }

    const base = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' +
        encodeURIComponent(env.PLAY_PACKAGE) + '/purchases/subscriptions/' +
        encodeURIComponent(sku) + '/tokens/' + encodeURIComponent(purchaseToken);
    const vr = await fetch(base, { headers: { Authorization: 'Bearer ' + access } });
    if (vr.status === 404 || vr.status === 400) return err('Compra no encontrada', 404);
    if (!vr.ok) return err('Error consultando Google Play', 502);
    const sub = await vr.json();

    const expMs = Number(sub.expiryTimeMillis || 0);
    if (!expMs || expMs < Date.now()) return err('Suscripción vencida', 403);
    if (sub.paymentState === 0) return err('Pago pendiente', 403);

    if (sub.acknowledgementState === 0) {
        // best-effort: si falla, el próximo verify lo reintenta (hay 3 días)
        await fetch(base + ':acknowledge', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
            body: '{}'
        }).catch(() => { });
    }

    const token = await signLicense(env.LICENSE_SECRET, {
        product: 'premium_play', tier: 'premium', deviceId, play_sku: sku, iat: Date.now(), exp: expMs
    });
    return json({ ok: true, token, product: 'premium_play', tier: 'premium', expiresAt: new Date(expMs).toISOString() });
}

// JWT ES256 para VAPID: aud = origin del push service, exp 12h.
async function vapidJwt(env, audience) {
    const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const data = b64urlEncodeJSON({ typ: 'JWT', alg: 'ES256' }) + '.' +
        b64urlEncodeJSON({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:admin@berserkermod.app' });
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(data));
    return data + '.' + b64urlFromBytes(new Uint8Array(sig));
}

// Cron diario: un push vacío a cada suscripción. 404/410 = suscripción muerta → se borra.
// El plan Free permite 50 subrequests por invocación, así que cada corrida
// manda como mucho PUSH_BATCH y guarda por dónde va en push:cursor
// ({ date, next }; next = -1 → hoy ya terminó). wrangler.toml dispara el cron
// varias veces seguidas (21:00, :03, :06, :09, :12 UTC) para cubrir el resto.
async function sendDailyReminders(env) {
    if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC_KEY) return { sent: 0, note: 'VAPID sin configurar' };
    const today = new Date().toISOString().slice(0, 10);
    const cur = (await kvGet(env, 'push:cursor')) || {};
    const start = cur.date === today ? cur.next : 0;
    if (start < 0) return { sent: 0, note: 'hoy ya se mandó todo' };
    const all = (await kvGet(env, 'push:all')) || { subs: {} };
    const ids = Object.keys(all.subs).sort();
    const batch = ids.slice(start, start + PUSH_BATCH);
    let sent = 0, removed = 0;
    const jwtByOrigin = {}; // un JWT VAPID por servicio de push (casi todos son FCM)
    for (const id of batch) {
        const s = all.subs[id];
        if (!s || !s.endpoint) continue;
        try {
            const origin = new URL(s.endpoint).origin;
            if (!jwtByOrigin[origin]) jwtByOrigin[origin] = await vapidJwt(env, origin);
            const resp = await fetch(s.endpoint, {
                method: 'POST',
                headers: { TTL: '86400', Authorization: 'vapid t=' + jwtByOrigin[origin] + ', k=' + env.VAPID_PUBLIC_KEY }
            });
            if (resp.status === 404 || resp.status === 410) { delete all.subs[id]; removed++; }
            else if (resp.status < 400) sent++;
        } catch { /* push service caído → probamos mañana */ }
    }
    const next = start + PUSH_BATCH >= ids.length ? -1 : start + PUSH_BATCH;
    await kvPut(env, 'push:cursor', { date: today, next });
    if (removed) await kvPut(env, 'push:all', all);
    return { sent, removed, total: ids.length, next };
}

export default {
    async scheduled(controller, env, ctx) {
        ctx.waitUntil(sendDailyReminders(env));
    },
    async fetch(req, env) {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
        const url = new URL(req.url);
        const p = url.pathname.replace(/\/+$/, '') || '/';
        const m = req.method;
        let mt;

        // Tope de tamaño declarado (el real se mide en readBody) y rate limit por IP.
        const declared = parseInt(req.headers.get('content-length') || '0', 10) || 0;
        if (declared > (p === '/api/parse-routine' ? MAX_BODY_PDF : MAX_BODY)) return err('Payload too large', 413);
        const strict = STRICT_ROUTES.includes(p) || p.startsWith('/api/admin/');
        if (await rateLimited(env, strict ? 'RL_STRICT' : 'RL_OPEN', (strict ? 's:' : 'o:') + clientIp(req))) {
            return json({ error: 'Demasiadas solicitudes. Esperá un minuto y probá de nuevo.' }, 429, { 'Retry-After': '60' });
        }

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
            if ((mt = p.match(/^\/api\/shares\/([a-z0-9]+)\/sessions$/)) && m === 'POST') return await postShareSession(req, env, mt[1]);
            if ((mt = p.match(/^\/api\/shares\/([a-z0-9]+)$/)) && m === 'GET') return await getShare(env, mt[1]);

            // Licencias
            if (p === '/api/license/activate' && m === 'POST') return await activateLicense(req, env);
            if (p === '/api/license/verify' && m === 'POST') return await verifyLicenseHandler(req, env);
            if (p === '/api/license/trial' && m === 'POST') return await startTrial(req, env);
            if (p === '/api/license/retrieve' && m === 'GET') return await retrieveCode(env, url);
            if (p === '/api/admin/codes' && m === 'POST') return await adminCreateCodes(req, env);
            if (p === '/api/testers/claim' && m === 'POST') return await testersClaim(req, env);
            if (p === '/api/admin/testers' && m === 'GET') return await adminTesters(req, env);

            // Checkout / productos
            if (p === '/api/products' && m === 'GET') return productsInfo(env);
            if (p === '/api/checkout' && m === 'POST') return await createCheckout(req, env);

            // Mercado Pago
            if (p === '/api/webhook/mercadopago' && (m === 'POST' || m === 'GET')) return await mercadoPagoWebhook(req, env, url);

            // Oracle
            if (p === '/api/oracle' && m === 'POST') return await oracleProxy(req, env);
            if (p === '/api/parse-routine' && m === 'POST') return await parseRoutine(req, env);

            // Push (recordatorio diario)
            if (p === '/api/push/subscribe' && m === 'POST') return await pushSubscribe(req, env);
            if (p === '/api/push/unsubscribe' && m === 'POST') return await pushUnsubscribe(req, env);
            if (p === '/api/play/verify' && m === 'POST') return await playVerify(req, env);

            // Observabilidad
            if (p === '/api/errors' && m === 'POST') return await ingestErrors(req, env);
            if (p === '/api/admin/errors' && m === 'GET') return await adminErrors(req, env);

            // Salud / varios
            if (p === '/api/health-data' && m === 'POST') return await healthData(req, env);
            if (p === '/api/server-info' && m === 'GET') return serverInfo(env);

            return err('Not found', 404);
        } catch (e) {
            if (e instanceof PayloadTooLarge) return err('Payload too large', 413);
            return err('Internal error: ' + String(e && e.message), 500);
        }
    }
};
