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
//                     POST                /api/shares/{token}/sessions  (adherencia + kg/reps del alumno)
//                     POST                /api/shares/{token}/checkins  (control semanal del alumno)
//                     POST                /api/shares/{token}/premium-claim (ata un código de coach al alumno)
//                     POST                /api/shares/{token}/intake    (cuestionario inicial del alumno)
//                     POST                /api/shares/{token}/terms     (el alumno aceptó los términos de uso)
//                     POST                /api/shares/{token}/push      (el alumno activa los avisos de su coach)
//                     POST                /api/routines/{id}/remind     (el coach le recuerda el control ahora)
//                     PUT/DELETE          /api/routines/{id}/review     (balance del programa)
//   Avisos a horario: POST                /api/push/rest                (fin del descanso con la app cerrada)
//                     POST                /api/shares/{token}/report    (el alumno reporta a su coach o su contenido)
//                     POST                /api/shares/{token}/leave     (el alumno deja a su coach y borra sus datos)
//                     POST                /api/routines/{id}/new-link   (el coach le cambia el link al alumno)
//                     POST                /api/shares/{token}/interest  (el huésped quiere seguir con el programa del coach)
//                     POST/DELETE         /api/routines/{id}/premium    (el coach le da o le saca un acceso de su cupo)
//                     POST                /api/shares/{token}/premium-auto (el teléfono del alumno recibe ese Premium, sin código)
//                     POST                /api/transfer, /api/transfer/claim (pasar los datos de Safari a la app instalada)
//                     POST                /api/routines/{id}/report     (el coach reporta a un alumno o su contenido)
//                     GET                 /api/admin/reports            (ADMIN_SECRET)
//                     POST                /api/coach/bind               (ata el panel del coach a su código)
//                     GET/PUT             /api/coach/config             (preguntas propias del coach)
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
//   Comida por foto:  POST                /api/food-vision      (premium, tabla nutricional o plato; la foto no se guarda)
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
//
// Datos del Coach (routine:, coachcfg:, sessions:, checkins:, edits:, evals:, videos:,
// review:): con DO_DATA en "on" los guarda el objeto de cada coach ('coach:{coachId}', ver
// coach-store.js) y KV queda como copia mientras KV_MIRROR esté en "on". Los contadores
// pasajeros (aiq:, trial-ip:, pushtr:) pasan al objeto 'counters'.
// =====================================================================

import { CoachStore, coachKV, guardKV, mirrorOn, dataEpoch } from './coach-store.js';
import { FOOD_DB } from './food-db.js';

const TOKEN_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // sin chars ambiguos (igual que serve.ps1)
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // mayúsculas, sin O/0/I/1
const ERROR_TTL = 30 * 24 * 60 * 60;   // 30 días
// 7 días para ambos: 3 días de premium no alcanzan para formar hábito (el valor
// real —stats, plan nutricional, rutinas custom— se siente recién en la semana).
const TRIAL_DAYS = { coach: 10, premium: 7 };   // Coach: 10 días para ver 2 controles semanales antes de decidir (20-nov-2026)

// ── Límites contra abuso ──
// Contexto: en Workers cada operación de KV cuenta como subrequest y el plan
// Free permite 50 por invocación y 1.000 escrituras de KV por día. Por eso
// (a) nada lista "todas las keys" de un prefijo en rutas públicas, (b) los
// datos por rutina viven en UNA key agregada, y (c) toda ruta pública tiene
// tope de tamaño y rate limit. Detalle en SEGURIDAD-THREAT-MODEL.md (privado).
const MAX_BODY = 256 * 1024;            // body JSON por defecto
const MAX_BODY_PDF = 16 * 1024 * 1024;  // /api/parse-routine (PDF en base64)
const MAX_BODY_IMG = 1536 * 1024;        // /api/food-vision (una foto JPEG chica en base64)
const MAX_PLAN_JSON = 100 * 1024;       // plan de una rutina serializado
const MAX_EDIT_JSON = 4 * 1024;         // changes_json de un edit del alumno
const EDITS_MAX = 50;                   // edits guardados por rutina (los viejos se pisan)
const SESSIONS_MAX = 120;               // sesiones de adherencia guardadas por rutina
const SESSIONS_DETAIL_MAX = 40;         // las más nuevas guardan kg/reps; las viejas quedan solo con fecha
const SESSION_EX_MAX = 20;              // ejercicios por sesión registrada
const SESSION_SETS_MAX = 12;            // series por ejercicio
const MAX_SESSION_JSON = 10 * 1024;     // red de seguridad: el peor caso válido (20 × 12 + nota) ronda 8 KB
const CHECKINS_MAX = 26;
const EVALS_MAX = 24;                    // evaluaciones de ciclo por alumno (~2 años)
const VIDEOS_MAX = 30;                   // videos de técnica por alumno (links, no archivos)
const VIDEOS_PENDING_MAX = 6;            // sin respuesta del coach, como mucho
const REPORTS_MAX = 200;                 // reportes guardados para revisar (los más nuevos)
const REPORTS_PER_DAY = 5;               // por alumno-coach, para que no se pueda inundar                // controles semanales por rutina (~6 meses)
const ROUTINES_LIST_MAX = 45;           // rutinas por coach en cada página de /api/routines (Free: 50 subrequests)
const ERRORS_RING_MAX = 150;            // errores recientes (una sola key)
const PUSH_MAX = 1000;                  // suscripciones push
const PUSH_BATCH = 40;                  // pushes por corrida del cron (corre cada minuto: 2.400 por hora y zona ≥ PUSH_MAX)
const REMINDER_HOUR = 18;               // el recordatorio sale a las 18 de la hora LOCAL de cada usuario
const DEFAULT_TZ = 'America/Argentina/Buenos_Aires'; // suscripciones previas a guardar la zona
const TRAINED_TTL = 3 * 86400;          // marca "hoy ya entrenó" (pushtr:{id}); vence sola
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
const AI_QUOTA = { oracle: 20, parse: 5, food: 15 };
// Ticket de retiro del código tras pagar: vive hasta 7 días sin retirar (pagos
// en efectivo) y 15 minutos después del primer retiro (refrescar la página no
// lo pierde; enumerar payment_ids ajenos ya no sirve).
const PAYMENT_TICKET_TTL = 7 * 24 * 3600;
// Número al azar que la app manda al pagar (ver createCheckout): 16-64 caracteres seguros para URL
const BUY_NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PAYMENT_TICKET_GRACE = 15 * 60;
// Rutas caras o abusables: 5 req/min por IP (RL_STRICT). El resto: 60/min (RL_OPEN).
const STRICT_ROUTES = ['/api/transfer', '/api/transfer/claim', '/api/errors', '/api/checkout', '/api/license/trial', '/api/testers/claim', '/api/oracle', '/api/parse-routine', '/api/food-vision', '/api/push/subscribe', '/api/push/trained', '/api/health/deep'];

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
// no-store: son datos personales y en vivo. Sin esto el navegador puede guardarse un rato
// un 404/410 (o una respuesta con datos) y mostrar algo viejo después de un cambio.
function json(obj, status = 200, extra = {}) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(), ...extra }
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

// ── Datos del Coach en un Durable Object por coach (auditoría 2026-11: K-1, L-1, L-3) ──
// Con el binding NOTIFIER y DO_DATA distinto de "off", todo lo de un coach y sus alumnos
// vive en su objeto ('coach:{coachId}', ver coach-store.js) y los contadores pasajeros en el
// objeto 'counters'. El código de las rutas es el mismo de siempre: adentro del objeto,
// env.BMOD_KV es una fachada que manda las keys del coach a su almacén y deja el resto en KV;
// env.__coach es ese almacén. Sin el binding (o con DO_DATA = "off") todo sigue en KV, como antes.
function doData(env) { return !!(env && env.NOTIFIER) && String(env.DO_DATA || 'on') !== 'off'; }
// Registro de un alumno. Adentro del objeto se le suma el último "visto", que ya no se
// guarda en el registro (así abrir el link no lo reescribe entero ni gasta una escritura de KV).
async function kvGetRoutine(env, key) {
    const r = await kvGet(env, key);
    if (r && env.__coach && r.id) {
        const seen = await env.__coach.seen(r.id);
        if (seen && !(r.last_seen_by_alumno_at >= seen)) r.last_seen_by_alumno_at = seen;
    }
    return r;
}
async function touchSeen(env, idx, r) {
    r.last_seen_by_alumno_at = nowISO();
    if (env.__coach) return env.__coach.markSeen(r.id, r.last_seen_by_alumno_at);
    return kvPut(env, routineKey(idx.coachId, idx.routineId), r);
}
// Una función del coach, adentro de su objeto (para lo que no llega como pedido de la API:
// alarmas de avisos, cargar cupo desde el admin, atar un código al activar una licencia).
async function runInCoach(env, coachId, fn, args) {
    const stub = env.NOTIFIER.get(env.NOTIFIER.idFromName('coach:' + coachId));
    const resp = await stub.fetch('https://notifier/op', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'c-run', coachId, fn, args: args || [] }) });
    const out = await resp.json();
    if (!out || !out.ok) throw new Error('coach: ' + ((out && out.error) || 'sin respuesta'));
    return out.result;
}

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
//   checkins:{routineId} = { items: [chk, ...] }     semana desc, uno por semana, tope CHECKINS_MAX
// Los contadores que muestra la lista del coach viven denormalizados en el
// registro de la rutina (edit_count, unreviewed_count, session_count, ...).
function editsKey(routineId) { return `edits:${routineId}`; }
function sessionsKey(routineId) { return `sessions:${routineId}`; }
function checkinsKey(routineId) { return `checkins:${routineId}`; }
//   evals:{routineId}    = { items: [ev, ...] }     ciclo desc, una por ciclo, tope EVALS_MAX
function evalsKey(routineId) { return `evals:${routineId}`; }
//   videos:{routineId}   = { items: [vid, ...] }    más nuevo primero, tope VIDEOS_MAX
function videosKey(routineId) { return `videos:${routineId}`; }
// Links que se muestran como enlace (video del coach por ejercicio, videos de técnica
// del alumno): solo https, sin espacios ni comillas (nada de javascript: ni data:).
const LINK_RE = /^https:\/\/[^\s<>"'`]{4,290}$/i;
// El plan lo arma el coach: se limpian el link del video y el descanso de cada ejercicio.
function cleanPlanLinks(plan) {
    const days = Array.isArray(plan) ? plan : [];
    for (const d of days) {
        for (const e of (d && Array.isArray(d.exercises) ? d.exercises : [])) {
            if (!e || typeof e !== 'object') continue;
            if (e.video_url !== undefined) {
                const u = typeof e.video_url === 'string' ? e.video_url.trim() : '';
                if (LINK_RE.test(u)) e.video_url = u; else delete e.video_url;
            }
            if (e.rest_s !== undefined && e.rest_s !== '') {
                const n = Math.round(Number(e.rest_s));
                if (n >= 10 && n <= 900) e.rest_s = n; else delete e.rest_s;
            }
        }
    }
    return plan;
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : null);
// Número dentro de [min, max] con un decimal, o null. Los datos del link del alumno son públicos.
const num = (v, min, max) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 10) / 10 : null;
};

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
// Reserva un uso: { ok, undo }. undo() lo devuelve si la IA falló o no sirvió (auditoría L-5:
// antes cada intento fallido se descontaba y se podía llegar al tope sin una sola respuesta).
async function aiQuotaTake(env, payload, kind) {
    const id = (payload && (payload.code || payload.deviceId)) || 'anon';
    const key = `aiq:${new Date().toISOString().slice(0, 10)}:${id}`;
    const free = { ok: true, undo: async () => { } };
    if (doData(env)) {
        // En el objeto de contadores: no gasta escrituras de KV y cuenta bien con pedidos a la vez.
        const res = await callNotifier(env, 'counters', { op: 'ctr-hit', key, field: kind, max: AI_QUOTA[kind], ttl: 2 * 86400 });
        if (res && res.ok) {
            if (!res.allowed) return { ok: false };
            return { ok: true, undo: async () => { await callNotifier(env, 'counters', { op: 'ctr-undo', key, field: kind }); } };
        }
        // Sin contador no se le corta la IA a quien pagó: mejor regalar unas consultas.
        console.error('[contadores] sin respuesta: la IA sigue sin contar', kind, res && res.error);
        return free;
    }
    const rec = (await kvGet(env, key)) || {};
    if ((rec[kind] || 0) >= AI_QUOTA[kind]) return { ok: false };
    rec[kind] = (rec[kind] || 0) + 1;
    await kvPut(env, key, rec, { expirationTtl: 2 * 86400 });
    return {
        ok: true,
        undo: async () => {
            try {
                const r = (await kvGet(env, key)) || {};
                if ((r[kind] || 0) > 0) { r[kind]--; await kvPut(env, key, r, { expirationTtl: 2 * 86400 }); }
            } catch { /* se pierde un uso, no más */ }
        }
    };
}
// K-5: la IA no acepta licencias que dejaron de valer aunque la firma siga bien: código
// anulado (devolución, contracargo, baja del coach) o pasado a otro teléfono, o compra de
// Google Play terminada o usada en otro teléfono. Una lectura de KV por consulta.
// Dispositivos de un código. El Coach usa su panel en 2 (el celular y la compu); el resto, en 1.
const COACH_DEVICES = 2;
function codeHasDevice(rec, deviceId) {
    if (!rec || !deviceId) return false;
    if (rec.deviceId === deviceId) return true;
    return rec.product === 'coach' && Array.isArray(rec.devices) && rec.devices.some((d) => d && d.id === deviceId);
}
// Suma un dispositivo a un código de Coach. Si ya tiene 2, sale el más viejo (eso sí cuenta como
// cambio de teléfono). Devuelve true si fue un cambio.
function coachAddDevice(rec, deviceId, at) {
    const devs = (Array.isArray(rec.devices) ? rec.devices : (rec.deviceId ? [{ id: rec.deviceId, at: rec.activated_at || at }] : []))
        .filter((d) => d && d.id && d.id !== deviceId);
    const moved = devs.length >= COACH_DEVICES;
    rec.devices = devs.slice(moved ? devs.length - COACH_DEVICES + 1 : 0).concat([{ id: deviceId, at }]);
    return moved;
}

async function licenseStillValid(env, payload) {
    if (payload.code) {
        const rec = await kvGet(env, `code:${payload.code}`);
        if (!rec || rec.revoked) return false;
        if (rec.deviceId && payload.deviceId && !codeHasDevice(rec, payload.deviceId)) return false;
    }
    if (payload.product === 'premium_play' && typeof payload.pt === 'string' && payload.pt) {
        const rec = await kvGet(env, `play:${await playHash(payload.pt)}`);
        if (rec && (rec.ended || (Array.isArray(rec.devices) && payload.deviceId && !rec.devices.some((d) => d.id === payload.deviceId)))) return false;
    }
    return true;
}
const LICENSE_GONE_MSG = 'Tu plan ya no está activo en este teléfono. Revisalo en Perfil.';
const INTERNAL_ERR_MSG = 'Error interno del servidor. Probá de nuevo en un rato.';
// Corre el trabajo de IA y, si no salió bien (error o respuesta inútil), devuelve el uso.
async function aiCharged(quota, work) {
    let resp;
    try { resp = await work(); } catch (e) { resp = aiErrorResponse(e); }
    if (!resp || resp.status >= 400) { try { await quota.undo(); } catch { /* sin más */ } }
    return resp;
}
// Opciones por familia de modelo. Los modelos que "piensan" (DeepSeek, Qwen, Inkling) lo traen
// prendido por defecto: se apaga (si no, gastan miles de tokens por foto) y se pide JSON.
// reasoning ('low'|'high') solo lo usa el banco de pruebas.
function visionOpts(model, reasoning) {
    if (!/deepseek|qwen|inkling|kimi|glm/i.test(model)) return {};
    const think = reasoning === 'low' || reasoning === 'high';
    return {
        chat_template_kwargs: { enable_thinking: think },
        reasoning_effort: think ? reasoning : 'none',
        response_format: { type: 'json_object' },
        max_tokens: think ? 3000 : 900
    };
}
// Respuesta de Workers AI → objeto JSON. Los modelos devuelven { response } (Llama), { text } o el
// formato de OpenAI ({ choices: [{ message: { content } }] }); algunos "piensan" antes
// (<think>…</think>). Se toma el primer objeto JSON del texto que queda.
function aiJson(r) {
    if (!r) return null;
    let raw = r.response != null ? r.response : (r.text != null ? r.text : null);
    if (raw == null && Array.isArray(r.choices) && r.choices[0] && r.choices[0].message) raw = r.choices[0].message.content;
    if (raw && typeof raw === 'object') return raw;
    let txt = typeof raw === 'string' ? raw : (raw != null ? String(raw) : '');
    txt = txt.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '');
    const start = txt.indexOf('{');
    if (start < 0) return null;
    // El objeto que empieza en la primera llave, contando llaves (no el último "}" del texto).
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < txt.length; i++) {
        const c = txt[i];
        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) { try { return JSON.parse(txt.slice(start, i + 1)); } catch { return null; } }
    }
    return null;
}
// Error de Workers AI → respuesta para la app, sin el detalle interno (queda en los registros).
// Cupo diario de neuronas agotado (para toda la cuenta): mensaje propio, sin hora fija: Cloudflare
// suma más o menos las últimas 24 h (se vio el 18-nov-2026), no se reinicia limpio a las 00:00 UTC.
function aiErrorResponse(e, fallback) {
    const msg = String((e && e.message) || e);
    console.error('[ia] falló', msg.slice(0, 300));
    if (/\b3036\b|daily free allocation|neurons/i.test(msg)) {
        return json({ error: 'La IA llegó a su tope por ahora. Volvé a probar en unas horas.', code: 'ai_daily_limit' }, 503);
    }
    return json({ error: fallback || 'Error al contactar la IA. Probá de nuevo en un rato.' }, 502);
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
        plan: cleanPlanLinks(body.plan),
        alumno_name: str(body.alumno_name, 80),
        alumno_email: str(body.alumno_email, 120),
        share_token: token,
        created_at: now,
        updated_at: now,
        last_coach_update_at: now,
        last_seen_by_alumno_at: null,
        // contadores denormalizados (los mantiene postEdit / postShareSession / reviewRoutine)
        edit_count: 0, unreviewed_count: 0, last_alumno_edit_at: null,
        session_count: 0, last_session_at: null, recent_session_dates: [],
        last_checkin_at: null, coach_seen_checkin_at: null
    };
    await kvPut(env, routineKey(coachId, routine.id), routine);
    await kvPut(env, `token:${token}`, { coachId, routineId: routine.id });
    return json(routine, 201);
}

// Una página de rutinas del coach: hasta ROUTINES_LIST_MAX (1 list + N gets entra en las 50
// subrequests del plan Free) y el cursor para pedir la que sigue. Así el panel no tiene tope
// de alumnos sin depender de un plan pago: la app pide las páginas de a una.
async function listRoutinesPage(env, prefix, cursor) {
    const res = await env.BMOD_KV.list({ prefix, cursor: cursor || undefined, limit: ROUTINES_LIST_MAX });
    const items = [];
    for (const k of res.keys) {
        const v = await env.BMOD_KV.get(k.name);
        if (v) items.push(JSON.parse(v));
    }
    return { items, next: res.list_complete ? null : (res.cursor || null) };
}
async function listRoutines(env, url) {
    const coachId = url.searchParams.get('coach_id');
    if (!coachId) return err('Missing coach_id', 400);
    // ?paged=1 → { items, next }. Sin eso responde la lista simple de siempre (primeras 45),
    // para las apps que todavía no se actualizaron. Todo lo demás sale del registro.
    const paged = url.searchParams.get('paged') === '1';
    let routines, next = null;
    if (env.__coach) {
        // Adentro del objeto del coach: la página sale de ahí (sin listar KV una vez migrado).
        // Lo que devuelve alcanza para el panel y las alertas (ver routineLite).
        const cur = paged ? (url.searchParams.get('cursor') || '') : '';
        if (cur.length > 1024) return err('Cursor inválido', 400);
        let pg;
        try { pg = await env.__coach.listPage(cur, ROUTINES_LIST_MAX); } catch { return err('Cursor inválido', 400); }
        routines = pg.items;
        next = pg.next;
    } else if (paged) {
        const cur = url.searchParams.get('cursor') || '';
        if (cur.length > 1024) return err('Cursor inválido', 400);
        let pg;
        try { pg = await listRoutinesPage(env, `routine:${coachId}:`, cur); } catch { return err('Cursor inválido', 400); }
        routines = pg.items;
        next = pg.next;
    } else {
        routines = await listByPrefix(env, `routine:${coachId}:`, ROUTINES_LIST_MAX);
    }
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const today = reqToday(url, null);
    const items = routines.map((r) => ({
        id: r.id, name: r.name, alumno_name: r.alumno_name, alumno_email: r.alumno_email,
        share_token: r.share_token, created_at: r.created_at,
        last_alumno_edit_at: r.last_alumno_edit_at || null, edit_count: r.edit_count || 0,
        unreviewed_count: r.unreviewed_count || 0, last_seen_by_alumno_at: r.last_seen_by_alumno_at,
        session_count: r.session_count || 0,
        last_session_at: r.last_session_at || null,
        week_sessions: (r.recent_session_dates || []).filter((d) => d >= weekAgo).length,
        last_checkin_at: r.last_checkin_at || null,
        new_checkin: !!r.last_checkin_at && (!r.coach_seen_checkin_at || r.last_checkin_at > r.coach_seen_checkin_at),
        premium: Array.isArray(r.premium_codes) && r.premium_codes.length > 0,
        status: (r.profile && r.profile.status) || 'activo',
        modality: (r.profile && r.profile.modality) || '',
        start_date: (r.profile && r.profile.start_date) || '',
        intake_done: !!r.intake,
        guest: !!(r.profile && r.profile.guest),
        access_until: (r.profile && r.profile.access_until) || '',
        closed: !!closedAt(r.access_end_at),
        interest_at: r.interest ? r.interest.at : null,
        seat: seatState(r),
        plan_days: Array.isArray(r.plan) ? r.plan.length : 0,
        push_on: (Array.isArray(r.push_subs) ? r.push_subs.length : (r.push_n || 0)) > 0,
        billing: billingLite(r.billing),
        alerts: studentAlerts(r, today)
    }));
    return json(paged ? { items, next } : items);
}

// ── Alertas del panel del coach ──
// Salen solo del registro del alumno (la lista no puede leer más keys: 1 list + N gets
// en el plan Free). Para eso las sesiones y los controles dejan resúmenes en el registro.
const DAY_MS = 86400000;
// Fecha local del coach que manda la app (si difiere a lo sumo 1 día de la UTC del servidor).
function reqToday(url, body) {
    const utc = new Date().toISOString().slice(0, 10);
    const v = (url && url.searchParams.get('today')) || (body && body.today);
    return /^\d{4}-\d{2}-\d{2}$/.test(v || '') && Math.abs(dayDiff(utc, v)) <= 1 ? v : utc;
}
function dayDiff(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS); }
function addDaysISO(d, n) { return new Date(Date.parse(d + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10); }
// Mejor serie de un ejercicio: 1RM estimado (Epley) o, sin peso, las repeticiones.
function setScore(s) {
    const kg = Number(s && s.kg) || 0, reps = Number(s && s.reps) || 0;
    if (!reps) return 0;
    return kg > 0 ? kg * (1 + reps / 30) : reps;
}
// Ejercicios con las cargas para revisar: en sus últimas 3 sesiones bajó (dos caídas
// seguidas o más de 8 % en total) o se estancó (las dos últimas no superan a la anterior).
function loadsReview(items) {
    const by = new Map();
    for (const s of items) {
        if (!Array.isArray(s.exercises)) continue;
        for (const e of s.exercises) {
            if (!e || e.kind === 'cardio' || !Array.isArray(e.sets) || !e.sets.length) continue;
            const best = Math.max(...e.sets.map(setScore));
            if (!(best > 0)) continue;
            const arr = by.get(e.name) || [];
            if (arr.length < 3 && !arr.some((x) => x.date === s.date)) { arr.push({ best, date: s.date, at: s.at }); by.set(e.name, arr); }
        }
    }
    const out = [];
    for (const [name, arr] of by) {
        if (arr.length < 3) continue;
        const [a, b, c] = arr.map((x) => x.best);   // a = la más nueva
        const base = { name, date: arr[0].date, at: arr[0].at || null };
        if ((a < b * 0.97 && b < c * 0.97) || a < c * 0.92) out.push(Object.assign({ trend: 'drop' }, base));
        else if (a <= c * 1.005 && b <= c * 1.005) out.push(Object.assign({ trend: 'stall' }, base));
    }
    return out.slice(0, 8);
}
// Resúmenes que guarda el registro (los recalculan las sesiones, los controles y el detalle).
function deriveFromSessions(r, items) {
    r.recent_session_dates = items.slice(0, 14).map((s) => s.date);
    r.last_session_at = r.recent_session_dates[0] || null;
    r.recent_quick_dates = items.slice(0, 14).filter((s) => !Array.isArray(s.exercises) || !s.exercises.length).map((s) => s.date);
    r.loads_review = loadsReview(items);
    // Para el balance del programa: el detalle (kg/reps) solo queda en las 40 sesiones más
    // nuevas, así que se guarda aparte la primera marca de cada ejercicio (no se pisa nunca)
    // y el volumen y las series de cada sesión.
    const first = Object.assign({}, r.ex_first || {});
    const vol = Object.assign({}, r.vol_log || {});
    for (let i = items.length - 1; i >= 0; i--) {
        const s = items[i];
        if (!s || !Array.isArray(s.exercises) || !s.exercises.length) continue;
        let v = 0, n = 0;
        for (const e of s.exercises) {
            if (!e || !Array.isArray(e.sets)) continue;
            for (const x of e.sets) { n++; v += (Number(x.kg) || 0) * (Number(x.reps) || 0); }
            if (e.kind === 'cardio' || !e.sets.length || first[e.name] || Object.keys(first).length >= 30) continue;
            const best = e.sets.reduce((m, x) => (setScore(x) > setScore(m) ? x : m), e.sets[0]);
            if (setScore(best) > 0) first[e.name] = { kg: Number(best.kg) || 0, reps: Number(best.reps) || 0, date: s.date };
        }
        vol[s.date] = [Math.round(v), n];
    }
    const dates = Object.keys(vol).sort();
    for (const d of dates.slice(0, Math.max(0, dates.length - 150))) delete vol[d];
    r.ex_first = first;
    r.vol_log = vol;
}
function deriveFromCheckins(r, items) {
    r.chk_recent = items.slice(0, 3).map((c) => ({
        week: c.week, date: c.date, at: c.at, ex: c.ex_trouble || [], change: !!c.change,
        low: !!((c.energy && c.energy <= 2) || (c.recovery && c.recovery <= 2) || c.sleep === 'lt6')
    }));
}
const DERIVED_KEYS = ['recent_session_dates', 'last_session_at', 'recent_quick_dates', 'loads_review', 'chk_recent', 'ex_first', 'vol_log'];
const derivedSig = (r) => JSON.stringify(DERIVED_KEYS.map((k) => (r[k] === undefined ? null : r[k])));

function studentAlerts(r, today) {
    const pf = r.profile || {};
    // Quiere seguir con el programa (sobre todo huéspedes): se avisa aunque ya haya terminado
    const lead = r.interest && r.interest.at && r.interest_seen !== r.interest.at ? [{ type: 'interest', at: r.interest.at }] : [];
    if (pf.status === 'pausado' || pf.status === 'finalizado' || closedAt(r.access_end_at)) return lead;
    const guest = !!pf.guest;   // estadía corta: sin control semanal ni ciclos de 4 semanas
    const created = String(r.created_at || '').slice(0, 10) || today;
    const start = /^\d{4}-\d{2}-\d{2}$/.test(pf.start_date || '') ? pf.start_date : null;
    const ref = start && start > created ? start : created;     // desde cuándo corre el programa
    const since = dayDiff(ref, today);
    if (!(since >= 0)) return lead;                              // todavía no empezó
    const out = [];
    const coachUpd = String(r.last_coach_update_at || '');
    const dates = (Array.isArray(r.recent_session_dates) ? r.recent_session_dates : []).filter((d) => d <= today);
    const last = dates.reduce((m, d) => (d > m ? d : m), '');
    const planDays = Array.isArray(r.plan) ? r.plan.length : 0;
    // 1. No entrena, o entrena bastante menos de lo planificado (últimas 2 semanas)
    const idle = last ? dayDiff(last, today) : since;
    if (since >= 7 && idle >= 7) out.push({ type: 'no_training', days: last ? idle : null });
    else if (!guest && planDays && since >= 14) {
        const done = dates.filter((d) => dayDiff(d, today) < 14).length;
        if (done < planDays * 2 * 0.6) out.push({ type: 'low_adherence', done, planned: planDays * 2 });
    }
    // 2. Pidió un cambio en el plan (se apaga cuando el coach toca la rutina)
    const chk = (Array.isArray(r.chk_recent) ? r.chk_recent : []).filter((c) => c.date && dayDiff(c.date, today) <= 35);
    const c0 = chk[0];
    if (c0 && c0.change && dayDiff(c0.date, today) <= 14 && !(coachUpd && c0.at && coachUpd >= c0.at)) out.push({ type: 'plan_change' });
    // 3. Dificultad con el mismo ejercicio en 2 de los últimos 3 controles
    const count = {};
    chk.forEach((c) => (c.ex || []).forEach((n) => { count[n] = (count[n] || 0) + 1; }));
    const rep = Object.keys(count).filter((n) => count[n] >= 2);
    if (rep.length) out.push({ type: 'repeat_trouble', names: rep.slice(0, 3) });
    // 4. Cargas para revisar (se apaga si el coach cambió la rutina después)
    const loads = (Array.isArray(r.loads_review) ? r.loads_review : [])
        .filter((l) => l.date && dayDiff(l.date, today) <= 21 && !(coachUpd && (l.at ? coachUpd >= l.at : coachUpd.slice(0, 10) > l.date)));
    if (loads.length) out.push({ type: 'loads', items: loads.slice(0, 3).map((l) => ({ name: l.name, trend: l.trend })), more: Math.max(0, loads.length - 3) });
    // 5. Descanso o ánimo bajos en los dos últimos controles
    if (chk.length >= 2 && chk[0].low && chk[1].low && dayDiff(chk[0].date, today) <= 14) out.push({ type: 'repeat_low' });
    // 6. Marca entrenamientos sin anotar pesos (2 o más en 14 días y ninguno con detalle)
    const quick = (Array.isArray(r.recent_quick_dates) ? r.recent_quick_dates : []).filter((d) => d <= today && dayDiff(d, today) < 14);
    const logged = dates.filter((d) => dayDiff(d, today) < 14 && !quick.includes(d));
    if (quick.length >= 2 && !logged.length) out.push({ type: 'no_logs', count: quick.length });
    // 7. Sin control semanal
    const lastChk = r.last_checkin_at ? String(r.last_checkin_at).slice(0, 10) : '';
    const chkIdle = lastChk ? dayDiff(lastChk, today) : since;
    if (!guest && since >= 7 && chkIdle >= 8) out.push({ type: 'no_checkin', days: lastChk ? chkIdle : null });
    // 8. Videos de técnica esperando respuesta del coach
    if (r.videos_pending > 0) out.push({ type: 'video', count: r.videos_pending });
    // 9. Evaluación de fin de ciclo (cada 4 semanas desde el inicio): desde 3 días antes de
    // que termine el ciclo hasta que la hace (o hasta que se acerca el fin del siguiente).
    if (start && !guest) {
        const d = dayDiff(start, today);
        const c = Math.floor((d + 3) / 28);
        const done = Array.isArray(r.eval_cycles) ? r.eval_cycles : [];
        if (d > 0 && c >= 1 && !done.includes(c)) {
            const left = 28 * c - d;
            out.push({ type: 'eval', cycle: c, in: Math.max(0, left), late: Math.max(0, -left), date: addDaysISO(today, left) });
        }
    }
    // 10. Cobro anotado por el coach: por vencer (3 días o menos) o vencido
    const bill = r.billing;
    if (bill && bill.on && /^\d{4}-\d{2}-\d{2}$/.test(bill.due || '')) {
        const d = dayDiff(today, bill.due);
        if (d < 0) out.push({ type: 'pay_late', days: -d, due: bill.due });
        else if (d <= 3) out.push({ type: 'pay_due', in: d, due: bill.due });
    }
    return out.concat(lead);
}

// ── Cobros (anotador del coach: no mueve plata) ──
// Cuánto le cobra al alumno, cada cuánto y cuándo vence. "Pagó" lo anota y corre el vencimiento
// un período (desde el vencimiento, no desde el día del pago: así no se corre el día de cobro).
// Es privado del coach: no viaja al link del alumno.
const BILL_PERIODS = { w1: [7, 0], w2: [14, 0], m1: [0, 1], m3: [0, 3], m6: [0, 6] };
function addPeriod(date, period, anchorDay) {
    const p = BILL_PERIODS[period] || BILL_PERIODS.m1;
    if (p[0]) return addDaysISO(date, p[0]);
    const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)) - 1 + p[1];
    const ny = y + Math.floor(m / 12), nm = ((m % 12) + 12) % 12;
    const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    const day = Math.min(anchorDay || Number(date.slice(8, 10)), last);
    return ny + '-' + String(nm + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}
// Fecha real y a menos de ~13 meses de hoy (para atrás o para adelante)
function validBillDate(v) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v || '')) return false;
    const t = Date.parse(v + 'T12:00:00Z');
    return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === v && Math.abs(t - Date.now()) < 400 * 86400000;
}
function cleanBilling(b, prev) {
    if (!b || typeof b !== 'object' || !validBillDate(b.due)) return null;
    const amount = num(b.amount, 0, 100000000);
    return {
        on: b.on !== false, amount: amount === null ? null : Math.round(amount * 100) / 100,
        period: BILL_PERIODS[b.period] ? b.period : 'm1', due: b.due, day: Number(b.due.slice(8, 10)),
        note: str(b.note, 120) || '', paid: Array.isArray(prev && prev.paid) ? prev.paid : []
    };
}
// Metas de comida que pone el coach: calorías y proteína por día (no son planes de comida).
function cleanTargets(t) {
    if (!t || typeof t !== 'object') return null;
    const kcal = num(t.kcal, 800, 6000), protein = num(t.protein, 20, 400);
    if (kcal === null && protein === null) return null;
    const out = {};
    if (kcal !== null) out.kcal = Math.round(kcal);
    if (protein !== null) out.protein = Math.round(protein);
    const note = str(t.note, 160);
    if (note) out.note = note;
    out.at = nowISO();
    return out;
}
// Marca del coach en el link de sus alumnos: nombre, un color de la lista y un logo chico
// (la app lo achica a 256 px). Solo colores que se leen bien sobre el fondo de la app.
const BRAND_COLORS = ['#00D4AA', '#FF4D57', '#4D9FFF', '#FFB020', '#B07CFF', '#FF7A3D', '#3DDC84'];
function cleanBrand(b) {
    if (!b || typeof b !== 'object') return null;
    const name = str(b.name, 60) || '';
    const c = String(b.color || '').toUpperCase();
    const color = BRAND_COLORS.includes(c) ? c : '';
    const logo = typeof b.logo === 'string' ? b.logo : '';
    if (logo && !(logo.length <= 120000 && /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(logo))) return false;
    if (!name && !color && !logo) return null;
    return { name, color, logo };
}
function brandOf(cfg) { const b = cfg && cfg.brand; return b ? { name: b.name || '', color: b.color || '', logo: b.logo || '' } : null; }
function billingLite(b) { return b ? { on: !!b.on, amount: b.amount, period: b.period, due: b.due } : null; }

// ── Evaluación de ciclo (cada 4 semanas) ──
// El sistema arma los datos del ciclo y el coach escribe la devolución; el alumno la ve
// en su link y en la app. Los datos quedan fijos al guardar (se recalculan si la edita).
function programStart(r) {
    const s = r.profile && r.profile.start_date;
    return /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : null;
}
function cyclePeriod(start, cycle) { return { from: addDaysISO(start, (cycle - 1) * 28), to: addDaysISO(start, cycle * 28 - 1) }; }
// Ciclo a evaluar: el último que terminó (o termina en 3 días) y no tiene evaluación;
// si ya está hecha, el ciclo en curso (evaluación anticipada).
function evalTarget(r, today) {
    const start = programStart(r);
    if (!start) return null;
    const d = dayDiff(start, today);
    if (d < 0) return null;
    const current = Math.floor(d / 28) + 1;
    const done = Array.isArray(r.eval_cycles) ? r.eval_cycles : [];
    for (let c = Math.max(1, Math.floor((d + 3) / 28)); c <= current; c++) {
        if (!done.includes(c)) return Object.assign({ cycle: c }, cyclePeriod(start, c));
    }
    return null;
}
function evalStats(r, sessions, checkins, from, to, today) {
    const inP = (d) => d >= from && d <= to;
    const ss = sessions.filter((s) => s && inP(s.date)).sort((a, b) => (a.date < b.date ? -1 : 1));
    const planDays = Array.isArray(r.plan) ? r.plan.length : 0;
    const days = Math.max(1, Math.min(28, dayDiff(from, today) + 1));     // si el ciclo sigue en curso, lo transcurrido
    const planned = Math.round(planDays * days / 7);
    const st = {
        sessions: ss.length, planned, days,
        adherence: planned ? Math.min(100, Math.round((ss.length / planned) * 100)) : null,
        logged: ss.filter((s) => Array.isArray(s.exercises) && s.exercises.length).length
    };
    // Ejercicios principales: los que más se repitieron; mejor serie la primera y la última vez
    const by = new Map();
    for (const s of ss) {
        for (const e of (Array.isArray(s.exercises) ? s.exercises : [])) {
            if (!e || e.kind === 'cardio' || !Array.isArray(e.sets) || !e.sets.length) continue;
            const best = e.sets.reduce((m, x) => (setScore(x) > setScore(m) ? x : m), e.sets[0]);
            const score = setScore(best);
            if (!(score > 0)) continue;
            const o = by.get(e.name) || { name: e.name, n: 0 };
            o.n++;
            const pt = { kg: Number(best.kg) || 0, reps: Number(best.reps) || 0, score };
            if (!o.first) o.first = pt;
            o.last = pt;
            by.set(e.name, o);
        }
    }
    st.exercises = [...by.values()].filter((o) => o.n >= 2).sort((a, b) => b.n - a.n).slice(0, 6).map((o) => ({
        name: o.name, n: o.n, first: { kg: o.first.kg, reps: o.first.reps }, last: { kg: o.last.kg, reps: o.last.reps },
        change: Math.round((o.last.score / o.first.score - 1) * 100)
    }));
    // Controles del ciclo
    const cc = checkins.filter((c) => c && inP(c.date)).sort((a, b) => (a.date < b.date ? -1 : 1));
    st.checkins = cc.length;
    const ws = cc.filter((c) => c.weight);
    const before = checkins.filter((c) => c && c.weight && c.date < from).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    if (ws.length) {
        st.weight_to = ws[ws.length - 1].weight;
        st.weight_from = ws.length > 1 ? ws[0].weight : (before ? before.weight : null);
    }
    const avg = (k) => {
        const v = cc.map((c) => c[k]).filter((x) => typeof x === 'number');
        return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
    };
    st.energy = avg('energy');
    st.recovery = avg('recovery');
    const tr = {};
    cc.forEach((c) => (c.ex_trouble || []).forEach((n) => { tr[n] = (tr[n] || 0) + 1; }));
    st.trouble = Object.entries(tr).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => ({ name, n }));
    st.change_requests = cc.filter((c) => c.change).length;
    // Objetivo: el actual y los que se reemplazaron desde que empezó el ciclo (el coach
    // suele cambiarlo justo al evaluar, unos días después de que termina)
    st.goal = (r.profile && r.profile.goals) || '';
    st.goal_prev = (Array.isArray(r.goal_history) ? r.goal_history : []).filter((g) => g.until && g.until >= from).map((g) => g.goals).slice(0, 3);
    return st;
}
const EVAL_TEXTS = ['results', 'difficulties', 'goals', 'next'];

// ── Balance del programa (punto de partida contra hoy) ──
// Lo arma el coach desde las 4 semanas (pensado para el cierre de las 12): cumplimiento total
// y por ciclo, progresión desde la primera marca de cada ejercicio, peso, volumen, cómo se
// sintió al principio y ahora, y el objetivo con el que arrancó. El alumno lo ve con una
// imagen para guardar o compartir.
const REVIEW_TEXTS = ['results', 'technique', 'pending', 'new_goals', 'next'];
function reviewKey(id) { return `review:${id}`; }
function reviewPeriod(r, today) {
    const start = programStart(r);
    if (!start) return null;
    const d = dayDiff(start, today);
    return d >= 0 ? { from: start, to: today, days: d + 1 } : null;
}
function programStats(r, sessions, checkins, from, to, today) {
    const st = evalStats(r, sessions, checkins, from, to, today);
    const planDays = Array.isArray(r.plan) ? r.plan.length : 0;
    st.weeks = Math.max(1, Math.ceil((dayDiff(from, to) + 1) / 7));
    // Cumplimiento y ánimo de cada ciclo de 4 semanas
    st.cycles = [];
    const nCycles = Math.min(12, Math.max(1, Math.ceil((dayDiff(from, to) + 1) / 28)));
    for (let c = 1; c <= nCycles; c++) {
        const p = cyclePeriod(from, c);
        const ct = p.to > to ? to : p.to;
        const days = Math.max(1, dayDiff(p.from, ct) + 1);
        const n = sessions.filter((s) => s && s.date >= p.from && s.date <= ct).length;
        const planned = Math.round(planDays * days / 7);
        const en = checkins.filter((x) => x && x.date >= p.from && x.date <= ct).map((x) => x.energy).filter((x) => typeof x === 'number');
        st.cycles.push({ c, sessions: n, planned, adherence: planned ? Math.min(100, Math.round((n / planned) * 100)) : null,
            energy: en.length ? Math.round((en.reduce((a, b) => a + b, 0) / en.length) * 10) / 10 : null });
    }
    // Progresión: desde la primera marca registrada (aunque esa sesión ya no guarde el detalle)
    const by = new Map();
    for (const s of sessions.filter((x) => x && x.date >= from && x.date <= to).sort((a, b) => (a.date < b.date ? -1 : 1))) {
        for (const e of (Array.isArray(s.exercises) ? s.exercises : [])) {
            if (!e || e.kind === 'cardio' || !Array.isArray(e.sets) || !e.sets.length) continue;
            const best = e.sets.reduce((m, x) => (setScore(x) > setScore(m) ? x : m), e.sets[0]);
            const score = setScore(best);
            if (!(score > 0)) continue;
            const o = by.get(e.name) || { name: e.name, n: 0 };
            o.n++;
            const pt = { kg: Number(best.kg) || 0, reps: Number(best.reps) || 0, score, date: s.date };
            if (!o.first) o.first = pt;
            o.last = pt;
            by.set(e.name, o);
        }
    }
    const base = r.ex_first || {};
    st.exercises = [...by.values()].map((o) => {
        const b = base[o.name];
        if (b && b.date >= from && b.date < o.first.date) { o.first = { kg: b.kg, reps: b.reps, score: setScore(b), date: b.date }; o.n++; }
        return o;
    }).filter((o) => o.n >= 2 && o.first.date < o.last.date).sort((a, b) => b.n - a.n).slice(0, 8).map((o) => ({
        name: o.name, n: o.n, first: { kg: o.first.kg, reps: o.first.reps }, last: { kg: o.last.kg, reps: o.last.reps },
        change: Math.round((o.last.score / o.first.score - 1) * 100)
    }));
    // Volumen total levantado y series registradas en el período
    let vol = 0, sets = 0;
    for (const [d, x] of Object.entries(r.vol_log || {})) { if (d >= from && d <= to) { vol += x[0] || 0; sets += x[1] || 0; } }
    st.total_volume = vol;
    st.total_sets = sets;
    // Objetivo con el que arrancó (el más viejo del historial) y lo que contó en su ficha
    const gh = Array.isArray(r.goal_history) ? r.goal_history : [];
    st.goal_start = gh.length ? gh[gh.length - 1].goals : (st.goal || '');
    st.intake_goals = r.intake ? { goals: r.intake.goals || [], text: r.intake.goals_text || '' } : null;
    return st;
}
// PUT /api/routines/{id}/review — el coach guarda (o edita) el balance del programa
async function putReview(req, env, url, id) {
    const body = await readBody(req);
    const coachId = coachIdFrom(req, url, body);
    if (!coachId) return err('Missing coach_id', 401);
    const r = await kvGetRoutine(env, routineKey(coachId, id));
    if (!r) return err('Not found', 404);
    if (r.coach_id !== coachId) return err('Forbidden', 403);
    const today = reqToday(url, body);
    const per = reviewPeriod(r, today);
    if (!per) return err('Cargá el inicio del programa en la ficha del alumno', 400);
    if (per.days < 28) return err('El balance se arma después de las primeras 4 semanas', 400);
    const texts = {};
    for (const k of REVIEW_TEXTS) { const v = str(body && body[k], 1500); if (v) texts[k] = v; }
    if (!Object.keys(texts).length) return err('Escribí al menos una parte del balance', 400);
    const sessions = ((await kvGet(env, sessionsKey(id))) || { items: [] }).items;
    const checkins = ((await kvGet(env, checkinsKey(id))) || { items: [] }).items;
    const prev = await kvGet(env, reviewKey(id));
    const now = nowISO();
    const rv = Object.assign({ from: per.from, to: per.to, stats: programStats(r, sessions, checkins, per.from, per.to, today),
        created_at: prev ? prev.created_at : now, updated_at: now }, texts);
    await kvPut(env, reviewKey(id), rv);
    r.review_at = now;
    await kvPut(env, routineKey(coachId, id), r);
    if (!prev) await notifyStudent(env, r, 'review', {}, true);
    return json({ ok: true, review: rv }, prev ? 200 : 201);
}
// DELETE /api/routines/{id}/review
async function deleteReview(req, env, url, id) {
    const coachId = coachIdFrom(req, url, null);
    if (!coachId) return err('Missing coach_id', 401);
    const r = await kvGetRoutine(env, routineKey(coachId, id));
    if (!r) return err('Not found', 404);
    if (r.coach_id !== coachId) return err('Forbidden', 403);
    if (!(await kvGet(env, reviewKey(id)))) return err('Not found', 404);
    await env.BMOD_KV.delete(reviewKey(id));
    delete r.review_at;
    await kvPut(env, routineKey(coachId, id), r);
    return json({ ok: true });
}
// PUT /api/routines/{id}/evals/{cycle} — el coach guarda (o edita) la evaluación del ciclo
async function putEval(req, env, url, id, cycleStr) {
    const body = await readBody(req);
    const coachId = coachIdFrom(req, url, body);
    if (!coachId) return err('Missing coach_id', 401);
    const r = await kvGetRoutine(env, routineKey(coachId, id));
    if (!r) return err('Not found', 404);
    if (r.coach_id !== coachId) return err('Forbidden', 403);
    const start = programStart(r);
    if (!start) return err('Cargá el inicio del programa en la ficha del alumno', 400);
    const today = reqToday(url, body);
    const d = dayDiff(start, today);
    const cycle = parseInt(cycleStr, 10);
    if (!(d >= 0) || !(cycle >= 1 && cycle <= Math.floor(d / 28) + 1)) return err('Ciclo inválido', 400);
    const texts = {};
    for (const k of EVAL_TEXTS) { const v = str(body && body[k], 1000); if (v) texts[k] = v; }
    if (!Object.keys(texts).length) return err('Escribí al menos una parte de la devolución', 400);
    const sessions = ((await kvGet(env, sessionsKey(id))) || { items: [] }).items;
    const checkins = ((await kvGet(env, checkinsKey(id))) || { items: [] }).items;
    const per = cyclePeriod(start, cycle);
    const agg = (await kvGet(env, evalsKey(id))) || { items: [] };
    const prev = agg.items.find((e) => e.cycle === cycle);
    const now = nowISO();
    const ev = Object.assign({ cycle, from: per.from, to: per.to, stats: evalStats(r, sessions, checkins, per.from, per.to, today),
        created_at: prev ? prev.created_at : now, updated_at: now }, texts);
    agg.items = [ev].concat(agg.items.filter((e) => e.cycle !== cycle)).sort((a, b) => b.cycle - a.cycle).slice(0, EVALS_MAX);
    await kvPut(env, evalsKey(id), agg);
    r.eval_cycles = [...new Set((r.eval_cycles || []).concat(cycle))].sort((a, b) => a - b).slice(-60);
    r.last_eval_at = now;
    await kvPut(env, routineKey(coachId, id), r);
    if (!prev) await notifyStudent(env, r, 'eval', { c: cycle }, true);
    return json({ ok: true, eval: ev }, prev ? 200 : 201);
}
// DELETE /api/routines/{id}/evals/{cycle}
async function deleteEval(req, env, url, id, cycleStr) {
    const coachId = coachIdFrom(req, url, null);
    if (!coachId) return err('Missing coach_id', 401);
    const r = await kvGetRoutine(env, routineKey(coachId, id));
    if (!r) return err('Not found', 404);
    if (r.coach_id !== coachId) return err('Forbidden', 403);
    const cycle = parseInt(cycleStr, 10);
    const agg = (await kvGet(env, evalsKey(id))) || { items: [] };
    if (!agg.items.some((e) => e.cycle === cycle)) return err('Not found', 404);
    agg.items = agg.items.filter((e) => e.cycle !== cycle);
    await kvPut(env, evalsKey(id), agg);
    r.eval_cycles = (r.eval_cycles || []).filter((c) => c !== cycle);
    await kvPut(env, routineKey(coachId, id), r);
    return json({ ok: true });
}

async function getRoutine(env, url, id) {
    const coachId = url.searchParams.get('coach_id');
    // Necesitamos coachId para construir la key; sin él no se puede buscar.
    const r = coachId ? await kvGetRoutine(env, routineKey(coachId, id)) : null;
    if (!r) return err('Not found', 404);
    if (r.coach_id !== coachId) return err('Forbidden', 403);
    const edits = ((await kvGet(env, editsKey(id))) || { items: [] }).items;
    // Sesiones del alumno (últimas 30) para que el coach vea la adherencia real.
    const sessAll = ((await kvGet(env, sessionsKey(id))) || { items: [] }).items;
    const sessions = sessAll.slice(0, 30);
    const checkins = ((await kvGet(env, checkinsKey(id))) || { items: [] }).items;
    // Los resúmenes de las alertas se completan acá para alumnos de antes (o si quedaron viejos).
    const before = derivedSig(r);
    deriveFromSessions(r, sessAll);
    deriveFromCheckins(r, checkins);
    let dirty = derivedSig(r) !== before;
    // Abrir el detalle marca el control como visto (exportar no cuenta como verlo).
    const exporting = url.searchParams.get('export') === '1';
    if (!exporting && r.last_checkin_at && (!r.coach_seen_checkin_at || r.last_checkin_at > r.coach_seen_checkin_at)) {
        r.coach_seen_checkin_at = r.last_checkin_at;
        dirty = true;
    }
    if (!exporting && r.interest && r.interest.at && r.interest_seen !== r.interest.at) {
        r.interest_seen = r.interest.at;
        dirty = true;
    }
    if (dirty) await kvPut(env, routineKey(coachId, id), r);
    const today = reqToday(url, null);
    const alerts = studentAlerts(r, today);
    const pf = r.profile || {};
    const closed = closedAt(r.access_end_at);
    const sper = pf.guest || pf.access_until ? stayPeriod(r, closed, today) : null;
    const stay = sper ? stayStats(r, sessAll, sper.from, sper.to) : null;
    const evals = ((await kvGet(env, evalsKey(id))) || { items: [] }).items;
    const tgt = evalTarget(r, today);
    const eval_draft = tgt ? Object.assign(tgt, { stats: evalStats(r, sessAll, checkins, tgt.from, tgt.to, today) }) : null;
    const videos = ((await kvGet(env, videosKey(id))) || { items: [] }).items;
    const review = await kvGet(env, reviewKey(id));
    const rper = reviewPeriod(r, today);
    const review_draft = rper && rper.days >= 28 ? { from: rper.from, to: rper.to, stats: programStats(r, sessAll, checkins, rper.from, rper.to, today) } : null;
    return json({ routine: Object.assign(stripPush(r), { alerts, chk_remind: chkRemindOf(r), closed_at: closed }), edits, sessions: exporting ? sessAll : sessions, checkins, evals, eval_draft, videos, review, review_draft, stay });
}

async function updateRoutine(req, env, url, id) {
    const body = await readBody(req);
    const coachId = coachIdFrom(req, url, body);
    if (!coachId) return err('Missing coach_id', 401);
    const r = await kvGetRoutine(env, routineKey(coachId, id));
    if (!r) return err('Not found', 404);
    if (r.coach_id !== coachId) return err('Forbidden', 403);
    if (body.plan && (typeof body.plan !== 'object' || planTooBig(body.plan))) return err('Plan inválido o demasiado grande', 413);
    const now = nowISO();
    if (body.name) r.name = str(body.name, 80);
    if (body.plan) r.plan = cleanPlanLinks(body.plan);
    let chkChanged = false, accessChanged = false;
    // Cobro, metas de comida y carpeta de fotos no cuentan como "tu coach actualizó tu rutina"
    const billingTouched = body.billing !== undefined || !!body.billing_paid || !!body.billing_undo || body.targets !== undefined || body.photos_link !== undefined;
    if (body.targets === null) delete r.targets;
    else if (body.targets !== undefined) {
        const tg = cleanTargets(body.targets);
        if (!tg) return err('Datos inválidos', 400);
        r.targets = tg;
    }
    if (body.photos_link !== undefined) {
        const link = str(body.photos_link, 300) || '';
        if (link && !LINK_RE.test(link)) return err('El link tiene que empezar con https://', 400);
        if (link) r.photos_link = link; else delete r.photos_link;
    }
    if (body.billing === null) delete r.billing;
    else if (body.billing !== undefined) {
        const b = cleanBilling(body.billing, r.billing);
        if (!b) return err('Fecha inválida', 400);
        r.billing = b;
    }
    if (body.billing_paid && r.billing) {
        const b = r.billing, pd = body.billing_paid;
        const date = validSessionDate(pd.date) ? pd.date : new Date().toISOString().slice(0, 10);
        const amount = num(pd.amount, 0, 100000000);
        b.paid = [{ date, amount: amount === null ? b.amount : Math.round(amount * 100) / 100, due: b.due }].concat(b.paid || []).slice(0, 12);
        b.due = addPeriod(b.due, b.period, b.day);
    }
    if (body.billing_undo && r.billing && (r.billing.paid || []).length) {
        const last = r.billing.paid.shift();
        if (last && /^\d{4}-\d{2}-\d{2}$/.test(last.due || '')) r.billing.due = last.due;
    }
    if (body.chk_remind) {
        const c = cleanChkRemind(body.chk_remind);
        if (!c) return err('Recordatorio inválido', 400);
        r.chk_remind = c;
        chkChanged = true;
    }
    // Ficha que completa el coach (privada: no viaja al link del alumno). Si cambian los
    // objetivos, el anterior queda en el historial con su fecha.
    if (body.profile && typeof body.profile === 'object') {
        const p = body.profile, prev = r.profile || {};
        const goals = str(p.goals, 300);
        const next = {
            modality: str(p.modality, 60) || '',
            start_date: /^\d{4}-\d{2}-\d{2}$/.test(p.start_date || '') ? p.start_date : '',
            status: STATUSES.includes(p.status) ? p.status : (prev.status || 'activo'),
            goals: goals === null ? (prev.goals || '') : goals,
            notes: str(p.notes, 800) || '',
            // Huésped de hotel y último día de acceso (una app vieja no los manda: quedan los de antes)
            guest: typeof p.guest === 'boolean' ? p.guest : !!prev.guest,
            access_until: p.access_until === undefined ? (prev.access_until || '') : (/^\d{4}-\d{2}-\d{2}$/.test(p.access_until || '') ? p.access_until : '')
        };
        if (next.access_until) next.access_tz = validTz(p.tz) || prev.access_tz || DEFAULT_TZ;
        if (prev.goals && next.goals !== prev.goals) {
            r.goal_history = [{ date: (prev.goals_since || (r.created_at || now).slice(0, 10)), goals: prev.goals, until: now.slice(0, 10) }]
                .concat(Array.isArray(r.goal_history) ? r.goal_history : []).slice(0, 20);
            next.goals_since = now.slice(0, 10);
        } else if (prev.goals_since) next.goals_since = prev.goals_since;
        else if (next.goals) next.goals_since = now.slice(0, 10);
        r.profile = next;
        const endAt = next.access_until ? accessEndAt(next.access_until, next.access_tz) : null;
        if ((r.access_end_at || null) !== endAt) {
            if (endAt) r.access_end_at = endAt; else delete r.access_end_at;
            accessChanged = true;
        }
    } else if (body.plan || body.name || (!body.chk_remind && !billingTouched)) {
        r.last_coach_update_at = now;   // solo un cambio de la rutina avisa al alumno (no un cobro)
    }
    // Aviso "tu coach actualizó tu rutina": como mucho uno por hora (el coach guarda varias veces)
    const planPush = !!body.plan && (r.push_subs || []).length > 0 && !(r.push_plan_at && Date.now() - Date.parse(r.push_plan_at) < 3600000);
    if (planPush) r.push_plan_at = now;
    r.updated_at = now;
    await kvPut(env, routineKey(coachId, id), r);
    if (accessChanged && r.share_token) await kvPut(env, `token:${r.share_token}`, tokenIndex(coachId, id, r.access_end_at));
    if (planPush) await notifyStudent(env, r, 'plan', {}, true);
    if (chkChanged && (r.push_subs || []).length) await callNotifier(env, 'chk:' + r.share_token, { op: 'chk-set', token: r.share_token, at: chkNextAt(r, Date.now()) });
    return json(Object.assign(stripPush(r), { chk_remind: chkRemindOf(r) }));
}

async function deleteRoutine(req, env, url, id) {
    const coachId = coachIdFrom(req, url, null);
    if (!coachId) return err('Missing coach_id', 401);
    const r = await kvGetRoutine(env, routineKey(coachId, id));
    if (!r) return err('Not found', 404);
    if (r.coach_id !== coachId) return err('Forbidden', 403);
    return json({ ok: true, revoked: await purgeRoutine(env, coachId, r, 'coach_baja') });
}

// Borra del servidor todo lo del alumno. Lo usan la baja que hace el coach y la salida
// que hace el propio alumno desde su link. El Premium que le dio este coach (códigos de
// coach atados a ese alumno) se anula; uno que compró el alumno no se toca.
async function purgeRoutine(env, coachId, r, reason) {
    const id = r.id;
    let revoked = 0;
    if (r.premium_seat && (await releaseSeat(env, coachId, r, reason)) === 'revoked') revoked++;   // sin usar, vuelve al cupo
    for (const code of (Array.isArray(r.premium_codes) ? r.premium_codes : [])) {
        if (code === r.premium_seat) continue;
        const rec = await kvGet(env, `code:${code}`);
        if (rec && rec.coach_pack && rec.routine_id === id && !rec.revoked) {
            rec.revoked = true; rec.revoked_at = nowISO(); rec.revoked_reason = reason;
            await kvPut(env, `code:${code}`, rec);
            revoked++;
        }
    }
    await env.BMOD_KV.delete(routineKey(coachId, id));
    if (r.share_token) await env.BMOD_KV.delete(`token:${r.share_token}`);
    await env.BMOD_KV.delete(editsKey(id));
    await env.BMOD_KV.delete(sessionsKey(id));
    await env.BMOD_KV.delete(checkinsKey(id));
    await env.BMOD_KV.delete(evalsKey(id));
    await env.BMOD_KV.delete(videosKey(id));
    await env.BMOD_KV.delete(reviewKey(id));
    for (const old of (Array.isArray(r.moved_tokens) ? r.moved_tokens : [])) await env.BMOD_KV.delete(movedKey(old));
    if ((r.push_subs || []).length && r.share_token) await callNotifier(env, 'chk:' + r.share_token, { op: 'off' });
    return revoked;
}

// ── Acceso con fecha de fin (huéspedes de hotel o planes que terminan) ──
// El coach elige el último día; el acceso cierra a la medianoche de ese día en su zona, sin
// que tenga que hacer nada. El instante queda en el registro (access_end_at) y en el índice
// del link (token:{t}.until), así cada pedido del alumno lo chequea sin leer nada más.
// Cerrado, el link no deja cargar nada y muestra un resumen de lo que entrenó; sigue
// pudiendo reportar o borrar sus datos. Los datos no se borran solos: decide el coach o el alumno.
function accessEndAt(date, tz) { return new Date(zonedTime(addDaysISO(date, 1), 0, validTz(tz) || DEFAULT_TZ)).toISOString(); }
function closedAt(until, now = Date.now()) { return until && now >= Date.parse(until) ? until : null; }
function closedErr() { return json({ error: 'Tu acceso a esta rutina terminó', closed: true }, 403); }
function tokenIndex(coachId, routineId, until) { return until ? { coachId, routineId, until } : { coachId, routineId }; }
// Resumen de la estadía (o del período de acceso): lo que entrenó y sus mejores marcas.
function stayStats(r, sessions, from, to) {
    const ss = sessions.filter((s) => s && s.date >= from && s.date <= to);
    let vol = 0, sets = 0;
    for (const [d, x] of Object.entries(r.vol_log || {})) { if (d >= from && d <= to) { vol += x[0] || 0; sets += x[1] || 0; } }
    const by = new Map();
    for (const s of ss.slice().sort((a, b) => (a.date < b.date ? -1 : 1))) {
        for (const e of (Array.isArray(s.exercises) ? s.exercises : [])) {
            if (!e || e.kind === 'cardio' || !Array.isArray(e.sets) || !e.sets.length) continue;
            const best = e.sets.reduce((m, x) => (setScore(x) > setScore(m) ? x : m), e.sets[0]);
            const score = setScore(best);
            if (!(score > 0)) continue;
            const o = by.get(e.name) || { name: e.name, n: 0, first: null, best: null };
            o.n++;
            const pt = { kg: Number(best.kg) || 0, reps: Number(best.reps) || 0, score };
            if (!o.first) o.first = pt;
            if (!o.best || score > o.best.score) o.best = pt;
            by.set(e.name, o);
        }
    }
    const exercises = [...by.values()].sort((a, b) => b.n - a.n || b.best.score - a.best.score).slice(0, 6).map((o) => ({
        name: o.name, n: o.n, best: { kg: o.best.kg, reps: o.best.reps },
        change: o.n >= 2 && o.first.score > 0 ? Math.round((o.best.score / o.first.score - 1) * 100) : 0
    }));
    return { from, to, days: Math.max(1, dayDiff(from, to) + 1), sessions: ss.length, total_sets: sets, total_volume: vol, exercises };
}
function stayPeriod(r, closed, today) {
    const pf = r.profile || {};
    const from = programStart(r) || String(r.created_at || '').slice(0, 10) || today;
    const to = closed ? (pf.access_until || closed.slice(0, 10)) : (pf.access_until && pf.access_until < today ? pf.access_until : today);
    return { from, to };
}
// La invitación al programa digital que el coach les deja a sus huéspedes
function inviteOf(cfg) { const i = (cfg && cfg.invite) || {}; return { text: i.text || '', link: i.link || '' }; }
// GET /api/shares/{token} con el acceso cerrado: sin la rutina ni nada para cargar; el resumen
// de lo que entrenó y, si es huésped, la invitación del coach.
async function closedShare(env, idx, r, closed) {
    const pf = r.profile || {};
    const sessions = ((await kvGet(env, sessionsKey(r.id))) || { items: [] }).items;
    const cfg = pf.guest ? ((await kvGet(env, `coachcfg:${idx.coachId}`)) || {}) : {};
    const per = stayPeriod(r, closed, closed.slice(0, 10));
    return json({
        closed: true, closed_at: closed, guest: !!pf.guest, access_until: pf.access_until || '',
        routine: { id: r.id, name: r.name, coach_name: r.coach_name, alumno_name: r.alumno_name, share_token: r.share_token,
            created_at: r.created_at, last_coach_update_at: r.last_coach_update_at },
        summary: stayStats(r, sessions, per.from, per.to),
        invite: pf.guest ? inviteOf(cfg) : null,
        interest: r.interest ? { at: r.interest.at } : null,
        terms_v: (r.terms && r.terms.v) || ''
    });
}
// POST /api/shares/{token}/interest — el alumno (sobre todo el huésped al terminar su estadía)
// avisa que quiere seguir con el programa del coach y, si quiere, deja un contacto. Al coach le
// aparece como alerta y en su resumen diario. Funciona aunque el acceso esté cerrado.
async function postShareInterest(req, env, token) {
    const got = await loadShareRoutine(env, token);
    if (!got) return err('Routine not found', 404);
    const { idx, r } = got;
    const body = (await readBody(req)) || {};
    const contact = str(body.contact, 80) || '', note = str(body.note, 300) || '';
    // Tocar dos veces seguidas no vuelve a avisar (sí, si deja un contacto o un mensaje)
    if (r.interest && Date.now() - Date.parse(r.interest.at) < 6 * 3600000 && !contact && !note) return json({ ok: true, at: r.interest.at });
    r.interest = { at: nowISO() };
    if (contact) r.interest.contact = contact;
    if (note) r.interest.note = note;
    await kvPut(env, routineKey(idx.coachId, idx.routineId), r);
    return json({ ok: true, at: r.interest.at }, 201);
}

// ── Accesos Premium del coach (cupo) ──
// Los códigos de coach que se cargan a un panel (admin con coach_code) son su cupo. El coach
// le da Premium a un alumno con un toque: el código se ata a su rutina y el alumno lo recibe
// solo, al abrir su link o su app (premium-auto), sin ver ni tipear ningún código. Queda atado
// al primer teléfono que lo usa; pasar a otro tiene un tope (SEAT_MOVES) y el coach lo ve.
const SEAT_MOVES = 3;
function seatCounts(cfg) {
    const live = (Array.isArray(cfg && cfg.seats) ? cfg.seats : []).filter((s) => s && !s.gone);
    return { total: live.length, free: live.filter((s) => !s.routine_id).length };
}
function seatExpired(rec) { return !!(rec && rec.expires_at && Date.parse(rec.expires_at) < Date.now()); }
function seatState(r) {
    if (!r.premium_seat) return null;
    const st = r.premium_state || {};
    return { status: st.activated_at ? 'active' : 'assigned', assigned_at: st.assigned_at || null, activated_at: st.activated_at || null, moves: st.moves || 0, blocked: !!st.blocked };
}
// POST /api/routines/{id}/premium — darle Premium (un acceso del cupo). Con { reset: true },
// habilita que el acceso pase a otro teléfono (si cambió de celular y llegó al tope).
async function assignSeat(req, env, url, id) {
    const body = (await readBody(req)) || {};
    const coachId = coachIdFrom(req, url, body);
    if (!coachId) return err('Missing coach_id', 401);
    const r = await kvGetRoutine(env, routineKey(coachId, id));
    if (!r) return err('Not found', 404);
    if (r.coach_id !== coachId) return err('Forbidden', 403);
    if (closedAt(r.access_end_at)) return err('El acceso de este alumno ya terminó', 409);
    const cfgKey = `coachcfg:${coachId}`;
    const cfg = (await kvGet(env, cfgKey)) || {};
    const now = nowISO();
    if (r.premium_seat) {
        if (body.reset) {
            const rec = await kvGet(env, `code:${r.premium_seat}`);
            if (rec && rec.routine_id === id) { rec.rebinds = 0; rec.deviceId = null; await kvPut(env, `code:${r.premium_seat}`, rec); }
            r.premium_state = Object.assign({}, r.premium_state || {}, { moves: 0, blocked: false, reset_at: now });
            await kvPut(env, routineKey(coachId, id), r);
        }
        return json({ ok: true, seat: seatState(r), seats: seatCounts(cfg) });
    }
    const seats = Array.isArray(cfg.seats) ? cfg.seats : [];
    let pick = null, dirty = false;
    for (const s of seats) {
        if (!s || s.gone || s.routine_id) continue;
        const rec = await kvGet(env, `code:${s.code}`);
        // Un intento anterior que ató el código a ESTE alumno y no llegó a guardar el resto: se retoma.
        const resume = rec && rec.routine_id === id && !rec.used && !rec.revoked && !seatExpired(rec);
        // un código que ya no sirve (anulado, vencido o usado por fuera del cupo) sale del cupo
        if (!resume && (!rec || rec.revoked || seatExpired(rec) || rec.routine_id || rec.used)) { s.gone = true; dirty = true; continue; }
        rec.routine_id = id; rec.coach_id = coachId;
        await kvPut(env, `code:${s.code}`, rec);
        s.routine_id = id; s.at = now;
        pick = s.code;
        break;
    }
    if (!pick) {
        if (dirty) await kvPut(env, cfgKey, cfg);
        return json({ error: 'No te quedan accesos Premium', no_seats: true, seats: seatCounts(cfg) }, 409);
    }
    await kvPut(env, cfgKey, cfg);
    r.premium_seat = pick;
    r.premium_codes = (Array.isArray(r.premium_codes) ? r.premium_codes : []).concat(pick).slice(-5);
    r.premium_state = { assigned_at: now };
    await kvPut(env, routineKey(coachId, id), r);
    return json({ ok: true, seat: seatState(r), seats: seatCounts(cfg) }, 201);
}
// DELETE /api/routines/{id}/premium — quitarle el Premium. Si nunca lo usó, el acceso vuelve
// al cupo; si ya lo estaba usando, se anula (ese acceso ya se gastó).
async function removeSeat(req, env, url, id) {
    const coachId = coachIdFrom(req, url, null);
    if (!coachId) return err('Missing coach_id', 401);
    const r = await kvGetRoutine(env, routineKey(coachId, id));
    if (!r) return err('Not found', 404);
    if (r.coach_id !== coachId) return err('Forbidden', 403);
    if (!r.premium_seat) return err('Not found', 404);
    const freed = (await releaseSeat(env, coachId, r, 'coach_quita')) === 'freed';
    r.premium_codes = (r.premium_codes || []).filter((c) => c !== r.premium_seat);
    delete r.premium_seat; delete r.premium_state;
    await kvPut(env, routineKey(coachId, id), r);
    const cfg = (await kvGet(env, `coachcfg:${coachId}`)) || {};
    return json({ ok: true, freed, seats: seatCounts(cfg) });
}
// Suelta el acceso de un alumno: sin usar vuelve al cupo (true); usado se anula (false).
async function releaseSeat(env, coachId, r, reason) {
    const code = r.premium_seat;
    const rec = code ? await kvGet(env, `code:${code}`) : null;
    let out = null;
    if (rec && rec.routine_id === r.id && !rec.revoked) {
        if (!rec.used) { delete rec.routine_id; delete rec.coach_id; out = 'freed'; }
        else { rec.revoked = true; rec.revoked_at = nowISO(); rec.revoked_reason = reason; out = 'revoked'; }
        await kvPut(env, `code:${code}`, rec);
    }
    const freed = out === 'freed';
    const cfgKey = `coachcfg:${coachId}`;
    const cfg = await kvGet(env, cfgKey);
    const s = cfg && Array.isArray(cfg.seats) ? cfg.seats.find((x) => x && x.code === code) : null;
    if (s) {
        if (freed) { delete s.routine_id; delete s.at; } else s.gone = true;
        await kvPut(env, cfgKey, cfg);
    }
    return out;
}
// POST /api/shares/{token}/premium-auto — el teléfono del alumno recibe el Premium que le dio
// su coach, sin código. Devuelve la misma licencia firmada que una activación normal.
async function postSharePremiumAuto(req, env, token) {
    const secret = env.LICENSE_SECRET;
    if (!secret) return err('Server not configured (LICENSE_SECRET)', 500);
    const got = await loadShareRoutine(env, token);
    if (!got) return err('Routine not found', 404);
    const { idx, r } = got;
    if (closedAt(idx.until)) return closedErr();
    const body = (await readBody(req)) || {};
    const deviceId = String(body.deviceId || '').trim();
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(deviceId)) return err('Missing deviceId', 400);
    const code = r.premium_seat;
    const rec = code ? await kvGet(env, `code:${code}`) : null;
    if (!rec || rec.revoked || rec.routine_id !== r.id || seatExpired(rec)) return json({ ok: true, none: true });
    const now = nowISO();
    const st = Object.assign({}, r.premium_state || {});
    let touched = false;
    if (!rec.used) {
        rec.used = true; rec.deviceId = deviceId; rec.activated_at = now;
        if (rec.duration_days && !rec.expires_at) rec.expires_at = new Date(Date.now() + rec.duration_days * 86400000).toISOString();
        await kvPut(env, `code:${code}`, rec);
        st.activated_at = now; touched = true;
        track(env, req, 'activate', 'premium', { s: 'seat' });
    } else if (rec.deviceId !== deviceId) {
        if ((rec.rebinds || 0) >= SEAT_MOVES) {
            if (!st.blocked) { st.blocked = true; r.premium_state = st; await kvPut(env, routineKey(idx.coachId, idx.routineId), r); }
            return json({ error: 'Este Premium ya se usa en otro teléfono. Pedile a tu coach que lo pase a este.', moved_max: true }, 409);
        }
        rec.rebinds = (rec.rebinds || 0) + 1;
        rec.deviceId = deviceId;
        await kvPut(env, `code:${code}`, rec);
        st.moves = rec.rebinds; st.moved_at = now; st.activated_at = st.activated_at || now; touched = true;
    }
    if (touched) { st.blocked = false; r.premium_state = st; await kvPut(env, routineKey(idx.coachId, idx.routineId), r); }
    const exp = rec.expires_at ? Date.parse(rec.expires_at) : null;
    const tok = await signLicense(secret, { product: 'premium', tier: 'premium', deviceId, code, iat: Date.now(), exp });
    return json({ ok: true, token: tok, product: 'premium', tier: 'premium', expiresAt: exp ? new Date(exp).toISOString() : null });
}

// ── Pasar los datos de Safari a la app instalada (iPhone) ──
// En iPhone, la app instalada ("Agregar a inicio") no comparte nada con Safari. Safari sube
// una copia cifrada (la clave va en la dirección, después del #, y nunca llega acá) y deja un
// pase invisible en la dirección que el iPhone guarda al instalar. La app, al abrirse por
// primera vez, la trae. Dura 30 minutos, sirve una vez y solo se entrega si es el mismo
// teléfono (modelo, iOS, pantalla, zona horaria y red); si algo no coincide, hace falta el
// código de 6 dígitos que se ve en Safari (3 intentos). Sin pase, el código solo alcanza (plan B).
const XFER_TTL = 1800, XFER_MAX = 8 * 1024 * 1024, XFER_TRIES = 3;
const XFER_LIVE_MAX = 30;   // copias por media hora para toda la app (L-6)
function xferFp(fp) {
    const f = fp && typeof fp === 'object' ? fp : {};
    const v = ['os', 'dev', 'scr', 'dpr', 'tz'].map((k) => String(f[k] == null ? '' : f[k]).slice(0, 40));
    return v[0] && v[2] ? v.join('|') : '';   // sin datos del teléfono no hay comparación posible
}
function ipPrefix(ip) {
    if (!ip || ip === 'unknown') return '';
    return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip.split('.').slice(0, 3).join('.');
}
async function sha256b64(s) { const d = await crypto.subtle.digest('SHA-256', enc.encode(s)); return b64urlFromBytes(new Uint8Array(d)); }
// POST /api/transfer — Safari sube la copia cifrada. El código (6 dígitos) lo elige el teléfono,
// porque con él se envuelve la clave para el plan B.
async function postTransfer(req, env) {
    const body = await readBody(req, XFER_MAX);
    const data = body && typeof body.data === 'string' ? body.data : '';
    const wrap = body && typeof body.wrap === 'string' ? body.wrap : '';
    const code = body && /^\d{6}$/.test(String(body.code || '')) ? String(body.code) : '';
    if (!data || !wrap || wrap.length > 2000 || !code) return err('Copia inválida', 400);
    if (await env.BMOD_KV.get(`xcode:${code}`)) return json({ error: 'Código en uso', code_taken: true }, 409);
    // L-6: tope global de copias vivas (cada una puede pesar 8 MB y vive 30 min): sin esto, unas
    // pocas IP podían llenar el GB gratis de KV. 30 por media hora alcanza de sobra hoy.
    if (doData(env)) {
        const hit = await callNotifier(env, 'counters', { op: 'ctr-hit', key: 'xf:' + Math.floor(Date.now() / (XFER_TTL * 1000)), field: 'n', max: XFER_LIVE_MAX, ttl: XFER_TTL * 2 });
        if (hit && hit.ok && !hit.allowed) return err('Hay muchas copias en curso. Probá de nuevo en unos minutos.', 503);
        if (!hit || !hit.ok) console.error('[contadores] sin respuesta: la copia sale sin contar', hit && hit.error);
    }
    const id = newShareToken() + newShareToken();
    const exp = Math.floor(Date.now() / 1000) + XFER_TTL;
    const rec = { data, wrap, fp: xferFp(body.fp), ip: await ipHash(ipPrefix(clientIp(req))), ch: await sha256b64(id + ':' + code), tries: 0, exp };
    await kvPut(env, `xfer:${id}`, rec, { expiration: exp });
    await env.BMOD_KV.put(`xcode:${code}`, id, { expiration: exp });
    return json({ ok: true, id, ttl: XFER_TTL }, 201);
}
// POST /api/transfer/claim — la app instalada pide la copia: { id, fp } (pase), { id, fp, code }
// (pase en otro teléfono o red) o { code } (plan B, sin pase). Se borra al entregarla.
async function postTransferClaim(req, env) {
    const body = (await readBody(req)) || {};
    const code = /^\d{6}$/.test(String(body.code || '')) ? String(body.code) : '';
    const viaPass = /^[a-z0-9]{20}$/.test(String(body.id || ''));
    const id = viaPass ? String(body.id) : (code ? (await env.BMOD_KV.get(`xcode:${code}`)) || '' : '');
    const rec = id ? await kvGet(env, `xfer:${id}`) : null;
    if (!rec) return err('El pase venció o ya se usó', 404);
    const byCode = !!code && (await sha256b64(id + ':' + code)) === rec.ch;
    const fp = xferFp(body.fp);
    const same = viaPass && !!rec.fp && rec.fp === fp && rec.ip === await ipHash(ipPrefix(clientIp(req)));
    if (!byCode && !same) {
        if (code) {
            rec.tries = (rec.tries || 0) + 1;
            if (rec.tries >= XFER_TRIES) { await env.BMOD_KV.delete(`xfer:${id}`); return json({ error: 'El pase se anuló por intentos fallidos', dead: true }, 410); }
            await kvPut(env, `xfer:${id}`, rec, { expiration: Math.max(rec.exp, Math.floor(Date.now() / 1000) + 61) });
            return json({ error: 'Código incorrecto', need_code: true, left: XFER_TRIES - rec.tries }, 403);
        }
        return json({ error: 'Falta el código', need_code: true }, 403);
    }
    await env.BMOD_KV.delete(`xfer:${id}`);
    // Con el pase, la clave está en la dirección. Con el código (sin pase, o si el iPhone
    // recortó la clave de la dirección), además va la clave envuelta con ese código.
    return json(byCode ? { ok: true, data: rec.data, wrap: rec.wrap } : { ok: true, data: rec.data });
}

// POST /api/routines/{id}/new-link — el coach le cambia el link al alumno (por ejemplo, si
// llegó a alguien que no corresponde). Todo lo del alumno queda igual: solo cambia la llave.
// El link viejo deja de andar y, por MOVED_DAYS días, responde 410 "cambió" (sin decir cuál
// es el nuevo) para que la app del alumno no lo tome como una baja y le pida el link nuevo.
// Los avisos del alumno se apagan: cada aviso lleva el link adentro, y un teléfono ajeno
// suscripto con el link viejo recibiría el nuevo. El alumno los activa de nuevo.
const MOVED_DAYS = 120, MOVED_KEEP = 5;
function movedKey(token) { return `moved:${token}`; }
async function newShareLink(req, env, url, id) {
    const body = await readBody(req);
    const coachId = coachIdFrom(req, url, body);
    if (!coachId) return err('Missing coach_id', 401);
    const r = await kvGetRoutine(env, routineKey(coachId, id));
    if (!r) return err('Not found', 404);
    if (r.coach_id !== coachId) return err('Forbidden', 403);
    let token = newShareToken();
    if (await kvGet(env, `token:${token}`)) token = newShareToken();
    const old = r.share_token;
    const hadPush = (r.push_subs || []).length > 0;
    const now = nowISO();
    r.share_token = token;
    r.link_changed_at = now;
    r.push_subs = [];
    if (old) r.moved_tokens = [old].concat(Array.isArray(r.moved_tokens) ? r.moved_tokens : []).slice(0, MOVED_KEEP);
    // Primero la llave nueva y el registro; recién después se apaga la vieja
    await kvPut(env, `token:${token}`, tokenIndex(coachId, id, r.access_end_at));
    await kvPut(env, routineKey(coachId, id), r);
    if (old) {
        await env.BMOD_KV.delete(`token:${old}`);
        await kvPut(env, movedKey(old), { at: now, coachId, routineId: id }, { expirationTtl: MOVED_DAYS * 86400 });
        if (hadPush) await callNotifier(env, 'chk:' + old, { op: 'off' });
    }
    return json(Object.assign(stripPush(r), { chk_remind: chkRemindOf(r) }));
}

// POST /api/shares/{token}/leave — el alumno deja a su coach y borra todo lo suyo del
// servidor (lo mismo que "Dar de baja"). Pide { confirm: true }. Al coach solo le queda
// un aviso con el nombre que él mismo cargó, que se borra solo a los LEFT_DAYS días.
const LEFT_MAX = 20, LEFT_DAYS = 30;
function leftRecent(list) {
    const since = new Date(Date.now() - LEFT_DAYS * 86400000).toISOString();
    return (Array.isArray(list) ? list : []).filter((x) => x && typeof x.at === 'string' && x.at > since);
}
async function postShareLeave(req, env, token) {
    const idx = await kvGet(env, `token:${token}`);
    if (!idx) return err('Routine not found', 404);
    const body = (await readBody(req)) || {};
    if (body.confirm !== true) return err('Falta confirmar', 400);
    const r = await kvGetRoutine(env, routineKey(idx.coachId, idx.routineId));
    if (!r) { await env.BMOD_KV.delete(`token:${token}`); return err('Routine not found', 404); }
    const revoked = await purgeRoutine(env, idx.coachId, r, 'alumno_baja');
    const cfgKey = `coachcfg:${idx.coachId}`;
    const cfg = (await kvGet(env, cfgKey)) || {};
    cfg.left = [{ name: str(r.alumno_name || r.name, 60) || '', at: nowISO() }].concat(leftRecent(cfg.left)).slice(0, LEFT_MAX);
    await kvPut(env, cfgKey, cfg);
    return json({ ok: true, revoked });
}

async function reviewRoutine(req, env, url, id) {
    const body = await readBody(req);
    const coachId = coachIdFrom(req, url, body);
    if (!coachId) return err('Missing coach_id', 401);
    const r = await kvGetRoutine(env, routineKey(coachId, id));
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
    if (!idx) {
        // ¿El coach le cambió el link? (mientras el alumno siga en su panel)
        const mv = await kvGet(env, movedKey(token));
        if (mv && await kvGetRoutine(env, routineKey(mv.coachId, mv.routineId))) return json({ error: 'Link changed', moved: true }, 410);
        return err('Routine not found', 404);
    }
    const r = await kvGetRoutine(env, routineKey(idx.coachId, idx.routineId));
    if (!r) return err('Routine not found', 404);
    const closed = closedAt(r.access_end_at);
    if (closed) return closedShare(env, idx, r, closed);
    // "visto por el alumno": como mucho una escritura por hora (cada put gasta
    // cuota de KV; sin esto, refrescar el link en loop la agota).
    const seen = r.last_seen_by_alumno_at ? new Date(r.last_seen_by_alumno_at).getTime() : 0;
    if (Date.now() - seen > 3600000) await touchSeen(env, idx, r);
    const edits = ((await kvGet(env, editsKey(r.id))) || { items: [] }).items.slice(0, 20);
    // Sesiones del alumno (para que vea su propia adherencia y el check de hoy)
    const sessions = ((await kvGet(env, sessionsKey(r.id))) || { items: [] }).items.slice(0, 30);
    // Sus últimos controles semanales (para ver si ya mandó el de esta semana y su peso).
    const checkins = ((await kvGet(env, checkinsKey(r.id))) || { items: [] }).items.slice(0, 8);
    const publicRoutine = {
        id: r.id, name: r.name, plan: r.plan, coach_name: r.coach_name,
        alumno_name: r.alumno_name, share_token: r.share_token,
        last_coach_update_at: r.last_coach_update_at, created_at: r.created_at
    };
    const cfg = (await kvGet(env, `coachcfg:${idx.coachId}`)) || {};
    const evals = ((await kvGet(env, evalsKey(r.id))) || { items: [] }).items.slice(0, 6);
    const videos = ((await kvGet(env, videosKey(r.id))) || { items: [] }).items.slice(0, 10);
    const review = await kvGet(env, reviewKey(r.id));
    const pf = r.profile || {};
    return json({ routine: publicRoutine, edits, sessions, checkins, evals, videos, review, terms_v: (r.terms && r.terms.v) || '', chk_remind: chkRemindOf(r), intake: r.intake || null,
        intake_questions: Array.isArray(cfg.intake_questions) ? cfg.intake_questions : [],
        guest: !!pf.guest, access_until: pf.access_until || '', premium_seat: !!r.premium_seat, announce: announceRecent(cfg.announce),
        targets: r.targets ? { kcal: r.targets.kcal || null, protein: r.targets.protein || null, note: r.targets.note || '' } : null, photos_link: r.photos_link || '', brand: brandOf(cfg) });
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

// Lo que el alumno hizo en cada ejercicio. Fuerza: series de kg × reps (las
// series sin reps no cuentan). Cardio: minutos y km. Todo validado y recortado.
function cleanSessionExercises(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, SESSION_EX_MAX).map((e) => {
        const name = str(e && e.name, 60);
        if (!name) return null;
        if (e.kind === 'cardio') {
            const min = num(e.min, 0, 600), km = num(e.km, 0, 500);
            if (!min && !km) return null;
            const c = { name, kind: 'cardio' };
            if (min) c.min = min;
            if (km) c.km = km;
            return c;
        }
        const sets = (Array.isArray(e.sets) ? e.sets : []).slice(0, SESSION_SETS_MAX)
            .map((s) => ({ kg: num(s && s.kg, 0, 1000) || 0, reps: num(s && s.reps, 0, 200) || 0 }))
            .filter((s) => s.reps > 0);
        return sets.length ? { name, sets } : null;
    }).filter(Boolean);
}

// POST /api/shares/{token}/sessions — el alumno registra que entrenó (adherencia)
// y, opcionalmente, lo que hizo: exercises [{name, sets:[{kg,reps}]} | {name, kind:'cardio', min, km}],
// rpe (esfuerzo 1-10) y una nota. Una por fecha (idempotente): si registra dos veces el mismo día, se pisa.
async function postShareSession(req, env, token) {
    const idx = await kvGet(env, `token:${token}`);
    if (!idx) return err('Routine not found', 404);
    if (closedAt(idx.until)) return closedErr();   // acceso cerrado: no se carga nada
    const body = await readBody(req);
    const date = (body && body.date) ? body.date : new Date().toISOString().slice(0, 10);
    if (!validSessionDate(date)) return err('Fecha inválida', 400);
    const sess = { date, day_name: str(body && body.day_name, 60) || '', at: nowISO() };
    const exercises = cleanSessionExercises(body && body.exercises);
    if (exercises.length) sess.exercises = exercises;
    const rpe = num(body && body.rpe, 1, 10);
    if (rpe !== null) sess.rpe = Math.round(rpe);
    const note = str(body && body.note, 280);
    if (note) sess.note = note;
    if (JSON.stringify(sess).length > MAX_SESSION_JSON) return err('Sesión demasiado grande', 413);

    const agg = (await kvGet(env, sessionsKey(idx.routineId))) || { items: [] };
    const isNew = !agg.items.some((s) => s.date === date);
    agg.items = [sess].concat(agg.items.filter((s) => s.date !== date))
        .sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, SESSIONS_MAX);
    // Tope de tamaño de la key: el detalle se guarda solo en las más nuevas.
    agg.items.forEach((s, i) => { if (i >= SESSIONS_DETAIL_MAX) { delete s.exercises; delete s.note; } });
    await kvPut(env, sessionsKey(idx.routineId), agg);

    const r = await kvGetRoutine(env, routineKey(idx.coachId, idx.routineId));
    if (r) {
        const before = derivedSig(r);
        if (isNew) r.session_count = (r.session_count || 0) + 1;
        deriveFromSessions(r, agg.items);
        // Se escribe solo si cambió algo (el plan Free tiene 1.000 escrituras por día).
        if (isNew || derivedSig(r) !== before) await kvPut(env, routineKey(idx.coachId, idx.routineId), r);
    }
    return json({ ok: true, session: sess }, 201);
}

// Semana ISO (lunes a domingo) de una fecha YYYY-MM-DD → 'YYYY-Www'.
function isoWeek(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));   // jueves de esa semana define el año
    const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
    const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return d.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

// POST /api/shares/{token}/checkins — control semanal del alumno. Uno por semana:
// el segundo de la misma semana pisa. Las seis preguntas del seguimiento, con
// respuestas rápidas: entrenamientos hechos (trained), cómo se sintió (energy 1-5),
// dificultades con ejercicios (ex_trouble + ex_text), descanso (sleep + recovery 1-5),
// hábitos (meals, water + habits_text) y si quiere cambiar algo del plan
// (change + change_text). Además peso y un mensaje libre (note).
const CHK_SLEEP = ['lt6', '6a7', '7a8', 'gt8'];
const CHK_HABIT = ['si', 'medias', 'no'];
async function postCheckin(req, env, token) {
    const idx = await kvGet(env, `token:${token}`);
    if (!idx) return err('Routine not found', 404);
    if (closedAt(idx.until)) return closedErr();   // acceso cerrado: no se carga nada
    const body = await readBody(req);
    const date = (body && body.date) ? body.date : new Date().toISOString().slice(0, 10);
    if (!validSessionDate(date)) return err('Fecha inválida', 400);
    const chk = { date, week: isoWeek(date), at: nowISO() };
    const weight = num(body && body.weight, 20, 400);
    if (weight !== null) chk.weight = weight;
    const energy = num(body && body.energy, 1, 5);
    if (energy !== null) chk.energy = Math.round(energy);
    const note = str(body && body.note, 500);
    if (note) chk.note = note;
    const b = body || {};
    const trained = num(b.trained, 0, 14);
    if (trained !== null) chk.trained = Math.round(trained);
    if (Array.isArray(b.ex_trouble)) {
        const names = [...new Set(b.ex_trouble.map((x) => str(x, 60)).filter(Boolean))].slice(0, 8);
        if (names.length) chk.ex_trouble = names;
    }
    const exText = str(b.ex_text, 300);
    if (exText) chk.ex_text = exText;
    if (CHK_SLEEP.includes(b.sleep)) chk.sleep = b.sleep;
    const recovery = num(b.recovery, 1, 5);
    if (recovery !== null) chk.recovery = Math.round(recovery);
    if (CHK_HABIT.includes(b.meals)) chk.meals = b.meals;
    if (CHK_HABIT.includes(b.water)) chk.water = b.water;
    const habitsText = str(b.habits_text, 300);
    if (habitsText) chk.habits_text = habitsText;
    const changeText = str(b.change_text, 300);
    if (b.change === true || changeText) { chk.change = true; if (changeText) chk.change_text = changeText; }
    if (b.photos === true) chk.photos = true;   // subió fotos nuevas a la carpeta del coach
    const filled = ['weight', 'energy', 'note', 'trained', 'ex_trouble', 'ex_text', 'sleep', 'recovery', 'meals', 'water', 'habits_text', 'change', 'photos'];
    if (!filled.some((k) => chk[k] !== undefined)) return err('Control vacío', 400);

    const agg = (await kvGet(env, checkinsKey(idx.routineId))) || { items: [] };
    // Si corrige el control de la semana, la respuesta que ya le dio el coach se conserva
    const old = agg.items.find((c) => c.week === chk.week);
    if (old && old.reply) { chk.reply = old.reply; chk.reply_at = old.reply_at; }
    agg.items = [chk].concat(agg.items.filter((c) => c.week !== chk.week))
        .sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, CHECKINS_MAX);
    await kvPut(env, checkinsKey(idx.routineId), agg);

    const r = await kvGetRoutine(env, routineKey(idx.coachId, idx.routineId));
    if (r) {
        r.last_checkin_at = chk.at;
        deriveFromCheckins(r, agg.items);
        await kvPut(env, routineKey(idx.coachId, idx.routineId), r);
    }
    return json({ ok: true, checkin: chk }, 201);
}

// ── Videos de técnica (por link) ──
// El alumno sube su video a Drive o YouTube (oculto) y manda el link con el ejercicio;
// el coach lo ve en el panel y le responde. No se guarda ningún archivo.
const pendingVideos = (items) => items.filter((v) => !v.reply).length;
async function syncVideosPending(env, idx, items) {
    const r = await kvGetRoutine(env, routineKey(idx.coachId, idx.routineId));
    if (!r) return;
    const n = pendingVideos(items);
    if ((r.videos_pending || 0) !== n) { r.videos_pending = n; await kvPut(env, routineKey(idx.coachId, idx.routineId), r); }
}
// POST /api/shares/{token}/videos
async function postVideo(req, env, token) {
    const idx = await kvGet(env, `token:${token}`);
    if (!idx) return err('Routine not found', 404);
    if (closedAt(idx.until)) return closedErr();   // acceso cerrado: no se carga nada
    const body = (await readBody(req)) || {};
    const exercise = str(body.exercise, 60);
    const link = str(body.url, 300) || '';
    if (!exercise) return err('Elegí el ejercicio del video', 400);
    if (!LINK_RE.test(link)) return err('El link tiene que empezar con https://', 400);
    const agg = (await kvGet(env, videosKey(idx.routineId))) || { items: [] };
    if (pendingVideos(agg.items) >= VIDEOS_PENDING_MAX) return err('Tenés varios videos esperando la respuesta de tu coach', 429);
    const date = validSessionDate(body.date) ? body.date : new Date().toISOString().slice(0, 10);
    const vid = { id: newShareToken(), exercise, url: link, date, at: nowISO() };
    const note = str(body.note, 300);
    if (note) vid.note = note;
    agg.items = [vid].concat(agg.items).slice(0, VIDEOS_MAX);
    await kvPut(env, videosKey(idx.routineId), agg);
    await syncVideosPending(env, idx, agg.items);
    return json({ ok: true, video: vid }, 201);
}
// DELETE /api/shares/{token}/videos/{id} — el alumno saca su video
async function deleteVideo(env, token, vidId) {
    const idx = await kvGet(env, `token:${token}`);
    if (!idx) return err('Routine not found', 404);
    const agg = (await kvGet(env, videosKey(idx.routineId))) || { items: [] };
    if (!agg.items.some((v) => v.id === vidId)) return err('Not found', 404);
    agg.items = agg.items.filter((v) => v.id !== vidId);
    await kvPut(env, videosKey(idx.routineId), agg);
    await syncVideosPending(env, idx, agg.items);
    return json({ ok: true });
}
// PUT /api/routines/{id}/videos/{vid} — el coach responde (o corrige su respuesta)
async function replyVideo(req, env, url, id, vidId) {
    const body = await readBody(req);
    const coachId = coachIdFrom(req, url, body);
    if (!coachId) return err('Missing coach_id', 401);
    const r = await kvGetRoutine(env, routineKey(coachId, id));
    if (!r) return err('Not found', 404);
    if (r.coach_id !== coachId) return err('Forbidden', 403);
    const reply = str(body && body.reply, 1000);
    if (!reply) return err('Escribí la respuesta', 400);
    const agg = (await kvGet(env, videosKey(id))) || { items: [] };
    const v = agg.items.find((x) => x.id === vidId);
    if (!v) return err('Not found', 404);
    const firstReply = !v.reply;
    v.reply = reply;
    v.reply_at = nowISO();
    await kvPut(env, videosKey(id), agg);
    const n = pendingVideos(agg.items);
    if ((r.videos_pending || 0) !== n) { r.videos_pending = n; await kvPut(env, routineKey(coachId, id), r); }
    if (firstReply) await notifyStudent(env, r, 'video', { ex: v.exercise }, true);
    return json({ ok: true, video: v });
}

// PUT /api/routines/{id}/checkins/{semana} — el coach responde el control semanal (o corrige su
// respuesta). El alumno la ve en su link y en su app; la primera vez le llega un aviso.
async function replyCheckin(req, env, url, id, week) {
    const body = await readBody(req);
    const coachId = coachIdFrom(req, url, body);
    if (!coachId) return err('Missing coach_id', 401);
    const r = await kvGetRoutine(env, routineKey(coachId, id));
    if (!r) return err('Not found', 404);
    if (r.coach_id !== coachId) return err('Forbidden', 403);
    const reply = str(body && body.reply, 1000);
    if (!reply) return err('Escribí la respuesta', 400);
    const agg = (await kvGet(env, checkinsKey(id))) || { items: [] };
    const c = agg.items.find((x) => x.week === week);
    if (!c) return err('Not found', 404);
    const firstReply = !c.reply;
    c.reply = reply;
    c.reply_at = nowISO();
    await kvPut(env, checkinsKey(id), agg);
    if (firstReply) await notifyStudent(env, r, 'chkreply', {}, true);
    return json({ ok: true, checkin: c });
}

// ── Ficha del alumno ──
const INTAKE_GOALS = ['fuerza', 'musculo', 'grasa', 'salud', 'rendimiento', 'tecnica'];
const INTAKE_EQUIP = ['gimnasio', 'casa', 'sin_equipo', 'otro'];
const INTAKE_EXP = ['nuevo', 'menos1', '1a3', 'mas3'];
const STATUSES = ['activo', 'pausado', 'finalizado'];
const pickList = (v, allowed) => (Array.isArray(v) ? [...new Set(v.filter((x) => allowed.includes(x)))] : []);

// POST /api/shares/{token}/intake — cuestionario inicial que completa el alumno desde su link
// o su app. Antecedentes y limitaciones son datos de salud: sin consentimiento expreso no se
// guardan. Se puede volver a mandar (se pisa) para corregir.
async function postIntake(req, env, token) {
    const idx = await kvGet(env, `token:${token}`);
    if (!idx) return err('Routine not found', 404);
    if (closedAt(idx.until)) return closedErr();   // acceso cerrado: no se carga nada
    const r = await kvGetRoutine(env, routineKey(idx.coachId, idx.routineId));
    if (!r) return err('Routine not found', 404);
    const body = (await readBody(req)) || {};
    const limitations = str(body.limitations, 500) || '';
    if (limitations && body.consent !== true) return err('Para guardar antecedentes o limitaciones hace falta tu consentimiento', 400);
    const cfg = (await kvGet(env, `coachcfg:${idx.coachId}`)) || {};
    const qs = Array.isArray(cfg.intake_questions) ? cfg.intake_questions : [];
    const extra = Array.isArray(body.extra) ? body.extra : [];
    const intake = {
        goals: pickList(body.goals, INTAKE_GOALS),
        goals_text: str(body.goals_text, 300) || '',
        experience: INTAKE_EXP.includes(body.experience) ? body.experience : '',
        days: num(body.days, 1, 7),
        schedule: str(body.schedule, 120) || '',
        equipment: pickList(body.equipment, INTAKE_EQUIP),
        equipment_text: str(body.equipment_text, 200) || '',
        limitations,
        contact: str(body.contact, 80) || '',
        extra: qs.map((q, i) => ({ q, a: str(extra[i], 300) || '' })).filter((x) => x.a),
        submitted_at: nowISO()
    };
    if (limitations) { intake.consent = true; intake.consent_at = intake.submitted_at; }
    if (!intake.goals.length && !intake.goals_text && !intake.experience && !intake.days) return err('Ficha vacía', 400);
    r.intake = intake;
    await kvPut(env, routineKey(idx.coachId, idx.routineId), r);
    return json({ ok: true, intake }, 201);
}

// Coach: preguntas propias para la ficha (hasta 3). Una key por coach.
async function getCoachConfig(env, url) {
    const coachId = url.searchParams.get('coach_id');
    if (!validPanelId(coachId)) return err('Missing coach_id', 401);
    const cfg = (await kvGet(env, `coachcfg:${coachId}`)) || {};
    return json({ intake_questions: Array.isArray(cfg.intake_questions) ? cfg.intake_questions : [], terms_v: (cfg.terms && cfg.terms.v) || '',
        digest: cfg.digest ? { on: !!cfg.digest.on, hour: cfg.digest.hour } : { on: false, hour: 9 },
        left: leftRecent(cfg.left), invite: inviteOf(cfg), seats: seatCounts(cfg), announce: announceRecent(cfg.announce), brand: brandOf(cfg) });
}
const ANNOUNCE_DAYS = 14, ANNOUNCE_GAP_MS = 10 * 60000;
function announceRecent(a) { return a && a.at && Date.now() - Date.parse(a.at) < ANNOUNCE_DAYS * 86400000 ? { id: a.id, text: a.text, at: a.at } : null; }
// POST /api/routines/{id}/announce — avisa por notificación a un alumno del último aviso del coach
// (la app lo pide alumno por alumno: el plan Free no deja mandar decenas desde un solo pedido).
async function announceStudent(req, env, url, id) {
    const body = await readBody(req);
    const coachId = coachIdFrom(req, url, body);
    if (!coachId) return err('Missing coach_id', 401);
    const r = await kvGetRoutine(env, routineKey(coachId, id));
    if (!r) return err('Not found', 404);
    if (r.coach_id !== coachId) return err('Forbidden', 403);
    const cfg = (await kvGet(env, `coachcfg:${coachId}`)) || {};
    const a = cfg.announce;
    if (!a || Date.now() - Date.parse(a.at) > 3600000) return err('Not found', 404);   // solo el aviso recién publicado
    const pf = r.profile || {};
    if (pf.status === 'pausado' || pf.status === 'finalizado' || closedAt(r.access_end_at)) return json({ ok: true, sent: 0, skipped: true });
    if (r.announce_pushed === a.id) return json({ ok: true, sent: 0, dup: true });
    r.announce_pushed = a.id;
    await kvPut(env, routineKey(coachId, id), r);
    const short = a.text.length > 110 ? a.text.slice(0, 109) + '…' : a.text;
    const res = await notifyStudent(env, r, 'announce', { text: short }, true);
    return json({ ok: true, sent: res.sent || 0 });
}
async function putCoachConfig(req, env, url) {
    const body = (await readBody(req)) || {};
    const coachId = coachIdFrom(req, url, body);
    if (!validPanelId(coachId)) return err('Missing coach_id', 401);
    const cfg = (await kvGet(env, `coachcfg:${coachId}`)) || {};
    if (Array.isArray(body.intake_questions)) {
        cfg.intake_questions = body.intake_questions.map((q) => str(q, 120)).filter(Boolean).slice(0, 3);
    }
    // Aceptación de los términos de uso (versión = fecha de los términos)
    if (TERMS_V_RE.test(body.terms || '')) cfg.terms = { v: body.terms, at: nowISO() };
    // Invitación al programa digital que ven sus huéspedes al terminar la estadía
    if (body.invite && typeof body.invite === 'object') {
        const link = str(body.invite.link, 300) || '';
        if (link && !LINK_RE.test(link)) return err('El link tiene que empezar con https://', 400);
        cfg.invite = { text: str(body.invite.text, 400) || '', link };
    }
    // Resumen diario de alumnos para revisar, a la hora que elige el coach (en su zona)
    let digestChanged = false;
    if (body.digest && typeof body.digest === 'object') {
        const d = body.digest, prev = cfg.digest || {};
        const hour = Number(d.hour);
        const next = {
            on: !!d.on,
            hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : (prev.hour != null ? prev.hour : 9),
            tz: validTz(d.tz) || prev.tz || null,
            lang: PUSH_MSG[d.lang] ? d.lang : (prev.lang || 'es'),
            subs: Array.isArray(prev.subs) ? prev.subs : []
        };
        const sub = cleanSub(d.subscription);
        if (sub) next.subs = [sub].concat(next.subs.filter((s) => s.endpoint !== sub.endpoint)).slice(0, 3);
        if (next.on && !next.subs.length) return err('Activá las notificaciones en este teléfono', 400);
        cfg.digest = next;
        digestChanged = true;
    }
    if (body.brand === null) delete cfg.brand;
    else if (body.brand !== undefined) {
        const br = cleanBrand(body.brand);
        if (br === false) return err('Datos inválidos', 400);
        if (br) cfg.brand = br; else delete cfg.brand;
    }
    // Aviso a todos los alumnos: queda uno (el último) y lo ven en su link y su app durante 14 días.
    // Las notificaciones las pide la app alumno por alumno (POST /api/routines/{id}/announce).
    if (body.announce === null) delete cfg.announce;
    else if (body.announce && typeof body.announce === 'object') {
        const text = str(body.announce.text, 300);
        if (!text) return err('Escribí el aviso', 400);
        if (cfg.announce && Date.now() - Date.parse(cfg.announce.at) < ANNOUNCE_GAP_MS) return err('Ya mandaste un aviso hace un rato. Probá en unos minutos.', 429);
        cfg.announce = { id: newShareToken(), text, at: nowISO() };
    }
    cfg.updated_at = nowISO();
    await kvPut(env, `coachcfg:${coachId}`, cfg);
    if (digestChanged) {
        const dg = cfg.digest;
        const at = dg && dg.on && (dg.subs || []).length ? nextLocalTime(Date.now(), null, dg.hour, validTz(dg.tz) || DEFAULT_TZ) : null;
        await callNotifier(env, 'digest:' + coachId, { op: 'digest-set', coachId, at });
    }
    return json({ ok: true, intake_questions: cfg.intake_questions || [], terms_v: (cfg.terms && cfg.terms.v) || '',
        digest: cfg.digest ? { on: !!cfg.digest.on, hour: cfg.digest.hour } : { on: false, hour: 9 }, invite: inviteOf(cfg), seats: seatCounts(cfg),
        announce: announceRecent(cfg.announce), brand: brandOf(cfg) });
}

// ── Términos de uso y reportes ──
// Lo que coach y alumno se escriben es contenido generado por usuarios: antes de cargarlo
// aceptan los términos (queda la versión y la fecha) y cualquiera de los dos puede reportar
// al otro o a su contenido desde la app. Los reportes los revisa el administrador.
const TERMS_V_RE = /^\d{4}-\d{2}-\d{2}$/;
const REPORT_REASONS = ['acoso', 'sexual', 'spam', 'ilegal', 'otro'];
// POST /api/shares/{token}/terms — el alumno aceptó los términos (se escribe una vez por versión)
async function postShareTerms(req, env, token) {
    const idx = await kvGet(env, `token:${token}`);
    if (!idx) return err('Routine not found', 404);
    const body = (await readBody(req)) || {};
    if (!TERMS_V_RE.test(body.version || '')) return err('Versión inválida', 400);
    const r = await kvGetRoutine(env, routineKey(idx.coachId, idx.routineId));
    if (!r) return err('Routine not found', 404);
    if (!r.terms || r.terms.v !== body.version) {
        r.terms = { v: body.version, at: nowISO() };
        await kvPut(env, routineKey(idx.coachId, idx.routineId), r);
    }
    return json({ ok: true, terms_v: r.terms.v });
}
async function saveReport(env, r, by, body) {
    const reason = REPORT_REASONS.includes(body && body.reason) ? body.reason : null;
    if (!reason) return err('Elegí el motivo del reporte', 400);
    const ring = (await kvGet(env, 'reports:ring')) || { items: [] };
    const dayAgo = new Date(Date.now() - 86400000).toISOString();
    if (ring.items.filter((x) => x.routine_id === r.id && x.at > dayAgo).length >= REPORTS_PER_DAY) {
        return err('Ya recibimos varios reportes de esta rutina hoy. Los estamos revisando.', 429);
    }
    const rep = { id: newShareToken(), at: nowISO(), by, reason, routine_id: r.id, coach_id: r.coach_id, share_token: r.share_token,
        coach_name: r.coach_name || '', alumno_name: r.alumno_name || '' };
    const detail = str(body.detail, 600);
    if (detail) rep.detail = detail;
    ring.items = [rep].concat(ring.items).slice(0, REPORTS_MAX);
    await kvPut(env, 'reports:ring', ring);
    return json({ ok: true, id: rep.id }, 201);
}
// POST /api/shares/{token}/report — el alumno reporta a su coach o su contenido
async function postShareReport(req, env, token) {
    const idx = await kvGet(env, `token:${token}`);
    if (!idx) return err('Routine not found', 404);
    const r = await kvGetRoutine(env, routineKey(idx.coachId, idx.routineId));
    if (!r) return err('Routine not found', 404);
    return saveReport(env, r, 'alumno', await readBody(req));
}
// POST /api/routines/{id}/report — el coach reporta a un alumno o su contenido
async function postRoutineReport(req, env, url, id) {
    const body = await readBody(req);
    const coachId = coachIdFrom(req, url, body);
    if (!coachId) return err('Missing coach_id', 401);
    const r = await kvGetRoutine(env, routineKey(coachId, id));
    if (!r) return err('Not found', 404);
    if (r.coach_id !== coachId) return err('Forbidden', 403);
    return saveReport(env, r, 'coach', body);
}
// GET /api/admin/reports — reportes para revisar
async function adminReports(req, env) {
    if (!env.ADMIN_SECRET || req.headers.get('x-admin-secret') !== env.ADMIN_SECRET) return err('Unauthorized', 401);
    const ring = (await kvGet(env, 'reports:ring')) || { items: [] };
    return json({ ok: true, count: ring.items.length, reports: ring.items });
}

async function postEdit(req, env, token) {
    const idx = await kvGet(env, `token:${token}`);
    if (!idx) return err('Routine not found', 404);
    if (closedAt(idx.until)) return closedErr();   // acceso cerrado: no se carga nada
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
        const r = await kvGetRoutine(env, routineKey(idx.coachId, idx.routineId));
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

    // K-2: la primera activación (y el panel de un código de Coach) la decide el objeto del
    // código ('act:{código}'), que atiende de a un pedido por vez. Con dos teléfonos a la vez
    // (o una lectura vieja de KV) ya no quedan dos "primeras" activaciones con vencimientos
    // distintos ni dos paneles de alumnos. Solo en la primera vez: después manda KV.
    const panelWant = validPanelId(body && body.coach_id);
    let claim = null;
    if (env.NOTIFIER && (!rec.used || (rec.product === 'coach' && !rec.panel_id && panelWant))) {
        claim = await callNotifier(env, 'act:' + code, { op: 'act-claim', deviceId, panel: rec.product === 'coach' ? panelWant : null });
        if (!claim || !claim.ok) { console.error('[licencias] sin objeto del código: se activa como antes', claim && claim.error); claim = null; }
    }
    if (!rec.used && claim && claim.deviceId !== deviceId) {
        // Otro teléfono lo activó hace un momento: para este es un cambio de teléfono (el Coach
        // puede tener los dos: el celular y la compu).
        rec.used = true;
        if (rec.duration_days && !rec.expires_at) rec.expires_at = new Date(claim.at + rec.duration_days * 86400000).toISOString();
        if (rec.product === 'coach') {
            rec.devices = [{ id: claim.deviceId, at: new Date(claim.at).toISOString() }];
            coachAddDevice(rec, deviceId, nowISO());
        } else rec.rebinds = (rec.rebinds || 0) + 1;
        rec.deviceId = deviceId; rec.activated_at = nowISO();
        await kvPut(env, `code:${code}`, rec);
    } else if (!rec.used) {
        // primera activación. Si el código es por duración (premium 1/3/6/12
        // meses), el reloj arranca ACÁ — no en la compra — y queda fijado en el
        // código: re-activar o cambiar de teléfono no lo extiende.
        const at = claim ? claim.at : Date.now();
        rec.used = true; rec.deviceId = deviceId; rec.activated_at = new Date(at).toISOString();
        if (rec.product === 'coach') rec.devices = [{ id: deviceId, at: rec.activated_at }];
        track(env, req, 'activate', rec.product || 'premium', { s: surfaceOf(body) });
        if (rec.duration_days && !rec.expires_at) {
            rec.expires_at = new Date(at + rec.duration_days * 86400000).toISOString();
        }
        await kvPut(env, `code:${code}`, rec);
    } else if (rec.deviceId && rec.product === 'coach' && !codeHasDevice(rec, deviceId)) {
        // Coach: el segundo dispositivo (celular y compu) se suma sin contar como cambio; con un
        // tercero sale el más viejo y eso sí cuenta para el tope de movimientos.
        const moved = coachAddDevice(rec, deviceId, nowISO());
        if (moved) {
            rec.rebinds = (rec.rebinds || 0) + 1;
            if (rec.rebinds > 10) return err('Este código se usó en demasiados dispositivos', 409);
        }
        rec.deviceId = deviceId; rec.activated_at = nowISO();
        await kvPut(env, `code:${code}`, rec);
    } else if (rec.deviceId && rec.deviceId !== deviceId && rec.product !== 'coach') {
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

    // Activado desde el link de un alumno: si es un código de coach, queda atado a él
    const share = body && typeof body.share === 'string' ? body.share.trim().toLowerCase() : '';
    if (share && rec.coach_pack) await bindCoachCode(env, code, rec, share);

    // Código de Coach: el panel de alumnos queda atado al código. La primera vez se anota
    // el panel del teléfono; en un teléfono nuevo, el mismo código devuelve ese panel.
    if (rec.product === 'coach' && !rec.panel_id && panelWant) {
        rec.panel_id = (claim && claim.panel) || panelWant;   // K-2: gana el primer panel
        await kvPut(env, `code:${code}`, rec);
    }

    const product = rec.product || 'premium';
    const tier = 'premium'; // ambos productos desbloquean premium hoy; product distingue para futuro
    const iat = Date.now();
    const exp = rec.expires_at ? new Date(rec.expires_at).getTime() : null; // null = lifetime (one-time)
    const token = await signLicense(secret, { product, tier, deviceId, code, iat, exp });
    const out = { ok: true, token, product, tier, expiresAt: exp ? new Date(exp).toISOString() : null };
    if (rec.product === 'coach' && rec.panel_id) out.coach_id = rec.panel_id;
    return json(out);
}

// Identificador del panel del coach (el que genera la app: un UUID)
function validPanelId(v) { return typeof v === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(v) ? v : null; }

// POST /api/coach/bind — coaches que ya tenían su código activado: ata su panel al código
// (o devuelve el que ya estaba atado, para recuperarlo en otro teléfono).
async function coachBind(req, env) {
    const body = await readBody(req);
    const payload = env.LICENSE_SECRET ? await verifyLicense(env.LICENSE_SECRET, body && body.license) : null;
    if (!payload || !payload.code) return err('Licencia inválida', 401);
    const rec = await kvGet(env, `code:${payload.code}`);
    if (!rec || rec.revoked || rec.product !== 'coach' || !codeHasDevice(rec, payload.deviceId)) return err('Licencia inválida', 401);
    const want = validPanelId(body && body.coach_id);
    if (!rec.panel_id && want) {
        rec.panel_id = want;
        await kvPut(env, `code:${payload.code}`, rec);
    }
    return json({ ok: true, coach_id: rec.panel_id || null });
}

// Códigos de coach (coach_pack): el entrenador los reparte entre sus alumnos. Cada uno
// queda atado al alumno (su rutina) desde cuyo link se activó o se reclamó, para que al
// darlo de baja se anule ese y ningún otro: un Premium comprado por el alumno no se toca,
// y un código ya atado a un alumno no se pasa a otro.
async function bindCoachCode(env, code, rec, shareToken) {
    if (!rec || !rec.coach_pack || rec.revoked || !/^[a-z0-9]{6,32}$/.test(shareToken || '')) return false;
    const idx = await kvGet(env, `token:${shareToken}`);
    if (!idx || closedAt(idx.until)) return false;
    if (doData(env) && !env.__coach) {
        // Llamado desde afuera del objeto del coach (al activar una licencia desde el link de
        // un alumno): el registro del alumno se toca adentro de su objeto.
        const out = await runInCoach(env, idx.coachId, 'bind', [code, rec, shareToken]);
        if (out && out.rec) Object.assign(rec, out.rec);
        return !!(out && out.ok);
    }
    if (rec.routine_id && rec.routine_id !== idx.routineId) return false;
    const r = await kvGetRoutine(env, routineKey(idx.coachId, idx.routineId));
    if (!r) return false;
    if (rec.routine_id !== idx.routineId) {
        rec.routine_id = idx.routineId; rec.coach_id = idx.coachId;
        await kvPut(env, `code:${code}`, rec);
    }
    const list = Array.isArray(r.premium_codes) ? r.premium_codes : [];
    if (!list.includes(code)) {
        r.premium_codes = list.concat(code).slice(-5);
        await kvPut(env, routineKey(idx.coachId, idx.routineId), r);
    }
    return true;
}

// POST /api/shares/{token}/premium-claim — el alumno vincula la rutina en la app con un
// Premium ya activo: si su licencia es de un código de coach, se ata a este alumno.
async function claimSharePremium(req, env, shareToken) {
    const body = await readBody(req);
    const payload = env.LICENSE_SECRET ? await verifyLicense(env.LICENSE_SECRET, body && body.license) : null;
    if (!payload || !payload.code) return json({ ok: true, bound: false });
    const rec = await kvGet(env, `code:${payload.code}`);
    if (!rec || !codeHasDevice(rec, payload.deviceId)) return json({ ok: true, bound: false });
    return json({ ok: true, bound: await bindCoachCode(env, payload.code, rec, shareToken) });
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
        if (rec.deviceId && payload.deviceId && !codeHasDevice(rec, payload.deviceId)) {
            return json({ valid: false, reason: 'device_mismatch' }, 200);
        }
    }
    // Compra de Google Play: el teléfono sigue entre los de esa compra y, una vez por semana,
    // Google confirma que sigue activa (reembolso o suspensión → no válida). Auditoría P-6/P-7.
    if (payload.product === 'premium_play' && typeof payload.pt === 'string' && payload.pt) {
        const why = await playLicenseCheck(env, payload);
        if (why) return json({ valid: false, reason: why }, 200);
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
    const tooMany = () => err('Demasiadas pruebas gratuitas desde esta red. Si es un error, escribinos.', 429);
    const days = TRIAL_DAYS[product] || 3;
    const iat = Date.now();
    const exp = iat + days * 86400000;
    if (doData(env)) {
        // El tope por red vive en el objeto de contadores. El contador viejo de KV (vence solo
        // a los 30 días) es el punto de partida la primera vez que aparece esa red.
        const hit = await callNotifier(env, 'counters', { op: 'ctr-hit', key: 'tip:' + ipKey.slice(9), field: 'n', max: TRIAL_IP_MAX, ttl: TRIAL_IP_TTL, seed: ipRec.n });
        if (hit && hit.ok) { if (!hit.allowed) return tooMany(); }
        else console.error('[contadores] sin respuesta: la prueba sale sin contar la red', hit && hit.error);
        await kvPut(env, key, { issued_at: nowISO() });
    } else {
        if (ipRec.n >= TRIAL_IP_MAX) return tooMany();
        await kvPut(env, key, { issued_at: nowISO() });
        await kvPut(env, ipKey, { n: ipRec.n + 1 }, { expirationTtl: TRIAL_IP_TTL });
    }
    track(env, req, 'trial', product, { s: surfaceOf(body) });
    const token = await signLicense(secret, { product, tier: 'premium', deviceId, code: null, iat, exp, trial: true });
    return json({ ok: true, token, product, tier: 'premium', trial: true, days, expiresAt: new Date(exp).toISOString() });
}

// Devuelve el código de un pago aprobado. Al PRIMER retiro el ticket pasa a
// vivir solo PAYMENT_TICKET_GRACE más (refrescar la página lo sigue mostrando;
// alguien que adivine el payment_id después, no). Si el comprador lo perdió,
// el código sigue en code:{...} con payment_id → soporte por mail.
async function retrieveCode(env, url) {
    const ref = url.searchParams.get('ref');
    const payment = url.searchParams.get('payment');
    let key;
    if (ref != null) {
        if (!BUY_NONCE_RE.test(ref)) return err('Bad ref', 400);
        key = `buy:${ref}`;
    } else {
        if (!payment || payment.length > 40) return err('Missing payment', 400);
        key = `payment:${payment}`;
    }
    const raw = await env.BMOD_KV.get(key);
    if (!raw) return json({ status: 'pending' }, 200);
    let ticket;
    try { ticket = JSON.parse(raw); } catch { ticket = null; }
    if (!ticket || typeof ticket !== 'object') ticket = { code: raw, retrieved_at: null }; // formato viejo: string
    if (!ticket.retrieved_at) {
        ticket.retrieved_at = nowISO();
        await kvPut(env, key, ticket, { expirationTtl: PAYMENT_TICKET_GRACE });
    }
    return json({ status: 'ready', code: ticket.code });
}

// admin: generar códigos a mano (regalos, promos). `months` (1|3|6|12) genera
// un código por duración (coach o premium) — el reloj arranca al activarse.
// Sin months → código vitalicio (regalos permanentes).
async function adminCreateCodes(req, env) {
    if (!env.ADMIN_SECRET || req.headers.get('x-admin-secret') !== env.ADMIN_SECRET) return err('Unauthorized', 401);
    const body = await readBody(req);
    // Hasta 20 por pedido (L-7): cada código es una lectura y una escritura, y un pedido que se
    // corta a mitad de camino dejaría códigos creados que nunca se devuelven. El script de
    // marketing ya pide de a 20.
    const count = Math.min(Math.max(parseInt(body && body.count, 10) || 1, 1), 20);
    const product = body && ['coach', 'premium'].includes(body.product) ? body.product : 'coach';
    const expires_at = body && body.expires_at ? body.expires_at : null;
    const months = body && PLAN_MONTHS.includes(Number(body.months)) ? Number(body.months) : null;
    const duration_days = months ? PLAN_DURATION_DAYS[months] : null;
    // coach_pack: Premium que un entrenador reparte entre sus alumnos (se anula si los da de baja)
    const coach_pack = product === 'premium' && !!(body && body.coach_pack);
    const label = body && typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '';
    // coach_code: los códigos van al cupo del panel de ese coach (los da desde la app, sin tipear)
    let pool = null;
    if (coach_pack && body.coach_code) {
        const cc = await kvGet(env, `code:${String(body.coach_code).trim().toUpperCase()}`);
        if (!cc || cc.product !== 'coach' || !cc.panel_id) return err('Ese código de Coach no existe o todavía no abrió su panel', 400);
        pool = cc.panel_id;
    }
    const codes = [];
    for (let i = 0; i < count; i++) {
        let code = newCode();
        while (await kvGet(env, `code:${code}`)) code = newCode();
        const rec = { product, duration_days, used: false, deviceId: null, expires_at, created_at: nowISO(), source: 'admin' };
        if (coach_pack) rec.coach_pack = true;
        if (label) rec.label = label;
        if (pool) rec.pool = pool;
        await kvPut(env, `code:${code}`, rec);
        codes.push(code);
    }
    let seats = null;
    if (pool && doData(env)) {
        seats = await runInCoach(env, pool, 'seatsAdd', [codes]);   // el cupo vive en el objeto de ese coach
    } else if (pool) {
        const cfg = (await kvGet(env, `coachcfg:${pool}`)) || {};
        cfg.seats = (Array.isArray(cfg.seats) ? cfg.seats : []).concat(codes.map((code) => ({ code })));
        await kvPut(env, `coachcfg:${pool}`, cfg);
        seats = seatCounts(cfg);
    }
    return json({ ok: true, product, months, coach_pack, codes, seats });
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
    const plan = product + '_' + months + 'm';
    // Compra iniciada dentro de la app: vuelve a la app (no a la landing) y lleva un
    // número al azar que solo conoce ese teléfono; con él la app retira el código
    // aunque el pago termine en otro navegador (iPhone: Safari ≠ app instalada).
    const fromApp = !!(body && body.ret === 'app');
    const nonce = (body && typeof body.nonce === 'string' && BUY_NONCE_RE.test(body.nonce)) ? body.nonce : '';
    const extRef = plan + (nonce ? '.' + nonce : '');
    const purchaseTag = product;
    if (!c.price || c.price <= 0) return err('Precio de ' + plan + ' sin configurar', 503);
    const origin = new URL(req.url).origin;
    const landing = (env.LANDING_URL || env.APP_ORIGIN || '').replace(/\/+$/, '');
    const back = landing + (fromApp ? '/BERSERKERMOD.html' : '/');
    const pref = {
        items: [{ title: c.title, quantity: 1, unit_price: c.price, currency_id: c.currency }],
        external_reference: extRef,
        notification_url: origin + '/api/webhook/mercadopago',
        back_urls: {
            success: back + '?purchase=' + purchaseTag,
            pending: back + '?purchase=pending',
            failure: back + '?purchase=failure'
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
        track(env, req, 'checkout', plan, { s: fromApp ? 'app' : 'web' });
        return json({ ok: true, init_point: data.init_point, sandbox_init_point: data.sandbox_init_point || null, id: data.id });
    } catch {
        return err('Checkout upstream error', 502);
    }
}

// ── Mercado Pago webhook ─────────────────────────────────────────────
// MP manda notificaciones de pago. Cuando un pago de la app queda 'approved',
// generamos un código y lo guardamos contra el payment id (y el número de la
// app) para que la app lo recupere tras el redirect.
//
// Reglas (auditoría 2026-11):
// - MP solo reintenta si NO respondemos 2xx. Si algo falla de nuestro lado (consultar el
//   pago, KV, el Durable Object) respondemos 500 y MP vuelve a avisar solo. Lo que no es
//   nuestro, no existe o no está aprobado: 200 (no tiene sentido que reintente).
// - Solo cuentan los pagos que salieron del checkout de la app ("{coach|premium}_{N}m"):
//   la cuenta de MP también recibe transferencias y pagos que no tienen nada que ver.
// - El código nunca viaja en la respuesta (MP no lo usa; cualquiera puede llamar acá).
// - Un solo código por pago aunque lleguen dos avisos a la vez: decide el Durable Object
//   del pago (consistente, a diferencia de KV).
const MP_REF_RE = /^(coach|premium)_(1|3|6|12)m(?:\.([A-Za-z0-9_-]{16,64}))?$/;
// Devolución o contracargo de un pago de la app: se anula su código (auditoría P-5). El
// código se busca en paid:{id} y, si esa marca ya venció, en el objeto del pago ('pay:{id}').
// Si falla la escritura, tira error y el webhook responde 500 para que MP reintente.
async function mpRevokeForPayment(env, paymentId, payment) {
    const reason = payment.status === 'refunded' ? 'mp_refund' : 'mp_chargeback';
    let code = await env.BMOD_KV.get(`paid:${paymentId}`);
    if (!code && env.NOTIFIER) {
        const c = await callNotifier(env, 'pay:' + paymentId, { op: 'pay-get' });
        if (c && c.ok && c.code) code = c.code;
    }
    if (!code) return json({ ok: true, status: payment.status, note: 'sin código' }, 200);
    const rec = await kvGet(env, `code:${code}`);
    if (!rec || (rec.payment_id && String(rec.payment_id) !== paymentId)) return json({ ok: true, status: payment.status, note: 'sin código' }, 200);
    if (rec.revoked) return json({ ok: true, status: payment.status, already: true }, 200);
    rec.revoked = true; rec.revoked_at = nowISO(); rec.revoked_reason = reason;
    await kvPut(env, `code:${code}`, rec);
    console.warn('[webhook mp] código anulado', reason, paymentId);
    return json({ ok: true, status: payment.status, revoked: true }, 200);
}
async function mercadoPagoWebhook(req, env, url) {
    let paymentId = '';
    const retry = async (why) => {
        console.error('[webhook mp] reintentar', paymentId, why);
        await noteKvLimit(env, why);
        return json({ ok: false, error: 'retry' }, 500);
    };
    try {
        if (!env.MP_ACCESS_TOKEN) return json({ ok: true, note: 'MP no configurado' }, 200);
        const body = await readBody(req);
        const type = (body && (body.type || body.topic)) || url.searchParams.get('type') || url.searchParams.get('topic');
        paymentId = String((body && body.data && body.data.id) || url.searchParams.get('data.id') || url.searchParams.get('id') || '');
        // Los números de pago de MP son solo dígitos (y así no se puede armar otra URL de la API).
        if (type !== 'payment' || !/^\d{1,20}$/.test(paymentId)) return json({ ok: true, ignored: true }, 200);

        const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` }
        });
        if (mpRes.status === 404) return json({ ok: true, note: 'payment not found' }, 200);
        if (!mpRes.ok) return retry('consulta del pago ' + mpRes.status);
        const payment = await mpRes.json();
        // Devolución total o contracargo perdido: el código de ese pago deja de valer (P-5).
        // "reimbursed" = el contracargo se resolvió a favor del vendedor: no se anula.
        if (payment.status === 'refunded' || (payment.status === 'charged_back' && payment.status_detail !== 'reimbursed')) {
            return await mpRevokeForPayment(env, paymentId, payment);
        }
        if (payment.status !== 'approved') return json({ ok: true, status: payment.status }, 200);

        // Producto desde external_reference: "{coach|premium}_{N}m" (N = 1|3|6|12), con el
        // número de la app opcional. Cualquier otra cosa no salió de la app: se ignora.
        const extRef = String(payment.external_reference || '');
        const pm = extRef.match(MP_REF_RE);
        if (!pm) { console.warn('[webhook mp] pago ajeno a la app', paymentId); return json({ ok: true, ignored: 'not_app' }, 200); }
        const product = pm[1], months = Number(pm[2]);
        const plan = planConfig(env, product, months);
        // Precio y moneda: los fija nuestro checkout, así que esto es solo una red de seguridad.
        // Margen de la mitad: si el precio sube mientras un pago en efectivo está pendiente,
        // ese pago se honra igual.
        const amount = Number(payment.transaction_amount);
        if ((payment.currency_id && payment.currency_id !== plan.currency) || (plan.price > 0 && !(amount >= plan.price * 0.5))) {
            console.error('[webhook mp] monto o moneda no coinciden', paymentId, payment.currency_id, amount, plan.price);
            return json({ ok: true, ignored: 'amount' }, 200);
        }

        // idempotencia: paid:{id} es el marcador durable (90 días); payment:{id} es el ticket
        // de retiro, que se acorta al primer retiro (ver retrieveCode).
        if (await env.BMOD_KV.get(`paid:${paymentId}`)) return json({ ok: true, dup: true }, 200);

        let code = newCode();
        while (await kvGet(env, `code:${code}`)) code = newCode();
        let fresh = true;
        if (env.NOTIFIER) {
            const claim = await callNotifier(env, 'pay:' + paymentId, { op: 'pay-claim', code });
            if (!claim || !claim.ok) return retry('pay-claim ' + (claim && claim.error));
            if (claim.done) return json({ ok: true, dup: true }, 200);
            fresh = claim.code === code;
            code = claim.code;
        }
        // Si un aviso anterior ya escribió este código (y después falló), no se pisa: pudo activarse.
        if (fresh || !(await kvGet(env, `code:${code}`))) {
            await kvPut(env, `code:${code}`, { product, duration_days: PLAN_DURATION_DAYS[months] || null, used: false, deviceId: null, expires_at: null, created_at: nowISO(), source: 'mercadopago', payment_id: paymentId });
        }
        // 400 días: un contracargo puede llegar meses después del pago (P-5).
        await env.BMOD_KV.put(`paid:${paymentId}`, code, { expirationTtl: 400 * 86400 });
        await kvPut(env, `payment:${paymentId}`, { code, retrieved_at: null }, { expirationTtl: PAYMENT_TICKET_TTL });
        if (pm[3]) await kvPut(env, `buy:${pm[3]}`, { code, retrieved_at: null }, { expirationTtl: PAYMENT_TICKET_TTL });
        if (env.NOTIFIER) await callNotifier(env, 'pay:' + paymentId, { op: 'pay-done' });   // si falla, el próximo aviso rehace sin duplicar
        track(env, req, 'paid', product + '_' + months + 'm', { server: true });
        return json({ ok: true }, 200);
    } catch (e) {
        return retry(String((e && e.message) || e));
    }
}

// ── Oracle (proxy a Anthropic, nunca loguea la key) ──────────────────
// Oracle: dos caminos.
// 1) DEFAULT (sin fricción): {token, prompt} — licencia premium/coach válida →
//    Workers AI (Llama 70B, gratis). Devuelve {ok, insights} ya parseado.
// 2) LEGACY (opcional): {apiKey, prompt} — la key Anthropic del usuario →
//    proxy a Claude (respuesta cruda de Anthropic, como siempre). Nunca se loguea.
// ── Oracle (análisis del entrenamiento, Premium) ─────────────────────────
// Auditoría del 19-nov-2026: con datos sueltos la IA daba consejos equivocados (trataba un déficit
// correcto como problema, se creía registros de comida incompletos, no veía la fatiga). Ahora la app
// calcula los hallazgos (core/calc.js, oracleFindings) y manda { token, lang, goal, level, age,
// findings }. Este Worker arma el pedido y la IA solo los cuenta con sus palabras; después se revisa
// cada consejo: si trae números que no están en su hallazgo o palabras internas, va el texto fijo
// de ese hallazgo. Si la IA falla o no hay cupo, van los textos fijos y no se gasta la consulta.
// El pedido ya no lo arma el teléfono: así nadie usa el Oracle como chat libre.
const ORACLE_CODES = ['fast_load', 'deficit_too_big', 'fatigue', 'no_deficit', 'below_maint_gain', 'loss_fast', 'volume_high',
    'adherence_low', 'protein_low', 'food_incomplete', 'food_none', 'stalled', 'imbalance', 'volume_low', 'weight_flat', 'cardio_short',
    'progress', 'holding_strength', 'deficit_ok', 'loss_ok', 'surplus_ok', 'adherence_good', 'cardio_done'];
const ORACLE_GOOD = new Set(['progress', 'holding_strength', 'deficit_ok', 'loss_ok', 'surplus_ok', 'adherence_good', 'cardio_done']);
const ORACLE_ICON = {
    fast_load: '🐢', deficit_too_big: '⚠️', fatigue: '🔋', no_deficit: '🍽️', below_maint_gain: '🍽️', loss_fast: '⚠️', volume_high: '📉',
    adherence_low: '📅', protein_low: '🥩', food_incomplete: '📝', food_none: '📝', stalled: '⏸️', imbalance: '⚖️', volume_low: '📈',
    weight_flat: '⚖️', cardio_short: '🏃', progress: '📈', holding_strength: '💪', deficit_ok: '✅', loss_ok: '✅', surplus_ok: '✅',
    adherence_good: '🔥', cardio_done: '🏃'
};
const ORACLE_GOALS = ['muscle', 'fat_loss', 'strength', 'recomp', 'endurance'];
const ORACLE_LEVELS = ['beginner', 'intermediate', 'advanced'];
const ORACLE_MUSCLES = ['chest', 'shoulders', 'biceps', 'forearms', 'abs', 'quads', 'traps', 'lats', 'triceps', 'lowback', 'glutes', 'hamstrings', 'calves'];
const ORACLE_WORDS = {
    es: {
        muscle: { chest: 'pecho', shoulders: 'hombros', biceps: 'bíceps', forearms: 'antebrazos', abs: 'abdominales', quads: 'cuádriceps', traps: 'trapecios', lats: 'espalda', triceps: 'tríceps', lowback: 'zona lumbar', glutes: 'glúteos', hamstrings: 'isquiotibiales', calves: 'pantorrillas' },
        goal: { muscle: 'ganar músculo', fat_loss: 'bajar grasa', strength: 'ganar fuerza', recomp: 'recomposición corporal', endurance: 'resistencia' },
        level: { beginner: 'principiante', intermediate: 'intermedio', advanced: 'avanzado' }, and: 'y'
    },
    en: {
        muscle: { chest: 'chest', shoulders: 'shoulders', biceps: 'biceps', forearms: 'forearms', abs: 'abs', quads: 'quads', traps: 'traps', lats: 'back', triceps: 'triceps', lowback: 'lower back', glutes: 'glutes', hamstrings: 'hamstrings', calves: 'calves' },
        goal: { muscle: 'build muscle', fat_loss: 'lose fat', strength: 'get stronger', recomp: 'body recomposition', endurance: 'endurance' },
        level: { beginner: 'beginner', intermediate: 'intermediate', advanced: 'advanced' }, and: 'and'
    },
    pt: {
        muscle: { chest: 'peito', shoulders: 'ombros', biceps: 'bíceps', forearms: 'antebraços', abs: 'abdômen', quads: 'quadríceps', traps: 'trapézio', lats: 'costas', triceps: 'tríceps', lowback: 'lombar', glutes: 'glúteos', hamstrings: 'posteriores de coxa', calves: 'panturrilhas' },
        goal: { muscle: 'ganhar músculo', fat_loss: 'perder gordura', strength: 'ganhar força', recomp: 'recomposição corporal', endurance: 'resistência' },
        level: { beginner: 'iniciante', intermediate: 'intermediário', advanced: 'avançado' }, and: 'e'
    }
};
// Textos fijos de cada hallazgo [título, texto]. Son el respaldo si la IA falla y lo que se le da
// a la IA (en castellano) para que lo cuente con sus palabras.
const ORACLE_TEXT = {
    es: {
        fast_load: (f) => ['Subí de a poco', `Subiste ${f.pct} % en ${f.ex} en pocas semanas. A los ${f.age} años conviene subir de a poco y dejar 2 o 3 repeticiones en reserva en cada serie.`],
        deficit_too_big: (f) => ['Déficit demasiado grande', `Comés unas ${f.kcal} kcal por día y tu mantenimiento ronda las ${f.maint}. Un déficit tan grande hace perder músculo y energía: subí un poco las calorías.`],
        fatigue: (f) => ['Toca semana de descarga', `${f.exs} vienen rindiendo menos en las últimas sesiones. Hacé una semana con el mismo peso y la mitad de las series, y después retomá.`],
        no_deficit: (f) => ['Sin déficit no baja la grasa', `Comés unas ${f.kcal} kcal por día y tu mantenimiento ronda las ${f.maint}. Para bajar grasa apuntá a unas ${f.target} kcal.`],
        below_maint_gain: (f) => ['Comés poco para crecer', `Comés unas ${f.kcal} kcal por día, por debajo de tu mantenimiento (${f.maint}). Para ganar músculo apuntá a unas ${f.target} kcal.`],
        loss_fast: (f) => ['Bajás demasiado rápido', `Estás bajando unos ${f.rateAbs} kg por semana. Bajar más de 1 % del peso por semana se lleva músculo: comé un poco más.`],
        volume_high: (f) => ['Demasiadas series', `Hacés unas ${f.sets} series por semana de ${f.muscles}. Más de 22 por semana no suma y cansa: recortá algunas.`],
        adherence_low: (f) => ['La clave es la constancia', `En las últimas ${f.weeks} semanas entrenaste ${f.done} de los ${f.planned} días que planeaste. Antes que cambiar la rutina, sostené los días.`],
        protein_low: (f) => ['Sumá proteína', `Comés unos ${f.prot} g de proteína por día (${f.perKg} g por kilo). Tu meta es ${f.target} g: repartila entre las comidas.`],
        food_incomplete: (f) => f.days > 0 ? ['Faltan días de comida', `Registraste la comida ${f.days} de los últimos 7 días: con tan pocos no puedo evaluar tus calorías. Probá registrar todo durante una semana.`]
            : ['Registrá toda tu comida', 'En los últimos 7 días no hay días con la comida completa, así que no puedo evaluar tus calorías. Probá registrar todo durante una semana.'],
        food_none: () => ['Registrá tu comida', 'Todavía no registraste comidas. Con una semana registrada te digo si tus calorías y tu proteína van con tu objetivo.'],
        stalled: (f) => ['Ejercicios estancados', `${f.exs} no avanzan hace unas semanas, contando peso y repeticiones. Probá sumar repeticiones antes que peso y revisá descanso y comida.`],
        imbalance: (f) => ['Equilibrá el entrenamiento', `Hacés unas ${f.aSets} series por semana de ${f.a} y ${f.bSets === '0' ? 'ninguna' : f.bSets} de ${f.b}. Sumá ejercicios de ${f.b} para compensar.`],
        volume_low: (f) => ['Poco volumen', `${f.muscles} reciben menos de 4 series por semana. Para crecer conviene sumar series de a poco.`],
        weight_flat: () => ['El peso no baja', 'Tu peso de tendencia casi no cambió en las últimas semanas. Revisá las porciones o sumá un poco de actividad.'],
        cardio_short: (f) => ['Sumá cardio', `La semana pasada hiciste ${f.min} de ${f.target} minutos de cardio. Sumá caminatas o salidas cortas para llegar.`],
        progress: (f) => ['Vas progresando', `${f.exs} vienen subiendo (+${f.pct} % en el mejor caso). Seguí así.`],
        holding_strength: (f) => ['Mantenés la fuerza', `${f.exs} se mantienen mientras ${f.goalKey === 'endurance' ? 'hacés mucho cardio' : 'bajás grasa'}: es un muy buen resultado.`],
        deficit_ok: (f) => ['Déficit en su punto', `Comés unas ${f.kcal} kcal por día, por debajo de tu mantenimiento (${f.maint}): es lo que hace falta para bajar grasa.`],
        loss_ok: (f) => ['Bajás a buen ritmo', `Estás bajando unos ${f.rateAbs} kg por semana: un ritmo que cuida el músculo.`],
        surplus_ok: (f) => ['Calorías en su punto', `Comés unas ${f.kcal} kcal por día, un poco arriba de tu mantenimiento (${f.maint}): justo para ganar músculo.`],
        adherence_good: (f) => ['Muy constante', `Entrenaste ${f.done} de los ${f.planned} días planeados en las últimas ${f.weeks} semanas. Así se progresa.`],
        cardio_done: (f) => ['Meta de cardio cumplida', `La semana pasada hiciste ${f.min} minutos de cardio y tu meta era ${f.target}. ¡Bien ahí!`]
    },
    en: {
        fast_load: (f) => ['Go up gradually', `You went up ${f.pct}% on ${f.ex} in a few weeks. At ${f.age}, it's better to add weight gradually and leave 2 or 3 reps in reserve on every set.`],
        deficit_too_big: (f) => ['Deficit too large', `You eat about ${f.kcal} kcal a day and your maintenance is around ${f.maint}. A deficit this large costs muscle and energy: eat a bit more.`],
        fatigue: (f) => ['Time for a deload week', `${f.exs} have been going down in your last sessions. Do one week with the same weight and half the sets, then pick it back up.`],
        no_deficit: (f) => ['No deficit, no fat loss', `You eat about ${f.kcal} kcal a day and your maintenance is around ${f.maint}. To lose fat, aim for about ${f.target} kcal.`],
        below_maint_gain: (f) => ['Eating too little to grow', `You eat about ${f.kcal} kcal a day, below your maintenance (${f.maint}). To build muscle, aim for about ${f.target} kcal.`],
        loss_fast: (f) => ['Losing too fast', `You're losing about ${f.rateAbs} kg a week. Losing more than 1% of your weight a week costs muscle: eat a bit more.`],
        volume_high: (f) => ['Too many sets', `You do about ${f.sets} sets a week for ${f.muscles}. More than 22 a week doesn't add up and wears you out: cut a few.`],
        adherence_low: (f) => ['Consistency is key', `In the last ${f.weeks} weeks you trained ${f.done} of the ${f.planned} days you planned. Before changing the routine, keep the days.`],
        protein_low: (f) => ['Add protein', `You eat about ${f.prot} g of protein a day (${f.perKg} g per kg). Your target is ${f.target} g: spread it across your meals.`],
        food_incomplete: (f) => f.days > 0 ? ['Missing food days', `You logged your food ${f.days} of the last 7 days: that's too few to judge your calories. Try logging everything for a week.`]
            : ['Log all your food', 'There are no fully logged days in the last 7 days, so I can\'t judge your calories. Try logging everything for a week.'],
        food_none: () => ['Log your food', 'You haven\'t logged any meals yet. With one week logged I can tell you whether your calories and protein match your goal.'],
        stalled: (f) => ['Stalled exercises', `${f.exs} haven't moved in a few weeks, counting weight and reps. Try adding reps before weight and check your rest and food.`],
        imbalance: (f) => ['Balance your training', `You do about ${f.aSets} sets a week for ${f.a} and ${f.bSets === '0' ? 'none' : f.bSets} for ${f.b}. Add ${f.b} exercises to even it out.`],
        volume_low: (f) => ['Low volume', `${f.muscles} get fewer than 4 sets a week. To grow, add sets gradually.`],
        weight_flat: () => ['Weight isn\'t moving', 'Your trend weight has barely changed in the last weeks. Check your portions or add a bit of activity.'],
        cardio_short: (f) => ['Add cardio', `Last week you did ${f.min} of ${f.target} minutes of cardio. Add walks or short sessions to get there.`],
        progress: (f) => ['You\'re progressing', `${f.exs} keep going up (+${f.pct}% at best). Keep it up.`],
        holding_strength: (f) => ['You\'re keeping your strength', `${f.exs} are holding steady while you ${f.goalKey === 'endurance' ? 'do a lot of cardio' : 'lose fat'}: that's a great result.`],
        deficit_ok: (f) => ['Deficit on point', `You eat about ${f.kcal} kcal a day, below your maintenance (${f.maint}): that's what fat loss needs.`],
        loss_ok: (f) => ['Good pace', `You're losing about ${f.rateAbs} kg a week: a pace that protects muscle.`],
        surplus_ok: (f) => ['Calories on point', `You eat about ${f.kcal} kcal a day, a bit above your maintenance (${f.maint}): right for building muscle.`],
        adherence_good: (f) => ['Very consistent', `You trained ${f.done} of the ${f.planned} planned days in the last ${f.weeks} weeks. That's how you progress.`],
        cardio_done: (f) => ['Cardio goal reached', `Last week you did ${f.min} minutes of cardio and your goal was ${f.target}. Well done!`]
    },
    pt: {
        fast_load: (f) => ['Suba aos poucos', `Você subiu ${f.pct}% em ${f.ex} em poucas semanas. Aos ${f.age} anos, é melhor subir aos poucos e deixar 2 ou 3 repetições em reserva em cada série.`],
        deficit_too_big: (f) => ['Déficit grande demais', `Você come umas ${f.kcal} kcal por dia e sua manutenção fica em torno de ${f.maint}. Um déficit tão grande faz perder músculo e energia: coma um pouco mais.`],
        fatigue: (f) => ['Hora de uma semana leve', `${f.exs} vêm rendendo menos nas últimas sessões. Faça uma semana com o mesmo peso e metade das séries, e depois retome.`],
        no_deficit: (f) => ['Sem déficit a gordura não cai', `Você come umas ${f.kcal} kcal por dia e sua manutenção fica em torno de ${f.maint}. Para perder gordura, mire em umas ${f.target} kcal.`],
        below_maint_gain: (f) => ['Comendo pouco para crescer', `Você come umas ${f.kcal} kcal por dia, abaixo da sua manutenção (${f.maint}). Para ganhar músculo, mire em umas ${f.target} kcal.`],
        loss_fast: (f) => ['Perdendo rápido demais', `Você está perdendo uns ${f.rateAbs} kg por semana. Perder mais de 1% do peso por semana leva músculo: coma um pouco mais.`],
        volume_high: (f) => ['Séries demais', `Você faz umas ${f.sets} séries por semana de ${f.muscles}. Mais de 22 por semana não soma e cansa: corte algumas.`],
        adherence_low: (f) => ['A chave é a constância', `Nas últimas ${f.weeks} semanas você treinou ${f.done} dos ${f.planned} dias planejados. Antes de mudar a rotina, mantenha os dias.`],
        protein_low: (f) => ['Mais proteína', `Você come uns ${f.prot} g de proteína por dia (${f.perKg} g por quilo). Sua meta é ${f.target} g: distribua entre as refeições.`],
        food_incomplete: (f) => f.days > 0 ? ['Faltam dias de comida', `Você registrou a comida em ${f.days} dos últimos 7 dias: poucos para avaliar suas calorias. Tente registrar tudo durante uma semana.`]
            : ['Registre toda a comida', 'Não há dias com a comida completa nos últimos 7 dias, então não dá para avaliar suas calorias. Tente registrar tudo durante uma semana.'],
        food_none: () => ['Registre sua comida', 'Você ainda não registrou refeições. Com uma semana registrada eu digo se suas calorias e sua proteína combinam com seu objetivo.'],
        stalled: (f) => ['Exercícios estagnados', `${f.exs} não avançam há algumas semanas, contando peso e repetições. Tente somar repetições antes de peso e revise descanso e alimentação.`],
        imbalance: (f) => ['Equilibre o treino', `Você faz umas ${f.aSets} séries por semana de ${f.a} e ${f.bSets === '0' ? 'nenhuma' : f.bSets} de ${f.b}. Some exercícios de ${f.b} para compensar.`],
        volume_low: (f) => ['Pouco volume', `${f.muscles} recebem menos de 4 séries por semana. Para crescer, some séries aos poucos.`],
        weight_flat: () => ['O peso não cai', 'Seu peso de tendência quase não mudou nas últimas semanas. Revise as porções ou some um pouco de atividade.'],
        cardio_short: (f) => ['Mais cardio', `Na semana passada você fez ${f.min} de ${f.target} minutos de cardio. Some caminhadas ou treinos curtos para chegar.`],
        progress: (f) => ['Você está progredindo', `${f.exs} vêm subindo (+${f.pct}% no melhor caso). Continue assim.`],
        holding_strength: (f) => ['Você mantém a força', `${f.exs} se mantêm enquanto você ${f.goalKey === 'endurance' ? 'faz muito cardio' : 'perde gordura'}: é um ótimo resultado.`],
        deficit_ok: (f) => ['Déficit no ponto', `Você come umas ${f.kcal} kcal por dia, abaixo da sua manutenção (${f.maint}): é o que precisa para perder gordura.`],
        loss_ok: (f) => ['Bom ritmo', `Você está perdendo uns ${f.rateAbs} kg por semana: um ritmo que preserva o músculo.`],
        surplus_ok: (f) => ['Calorias no ponto', `Você come umas ${f.kcal} kcal por dia, um pouco acima da sua manutenção (${f.maint}): ideal para ganhar músculo.`],
        adherence_good: (f) => ['Muito constante', `Você treinou ${f.done} dos ${f.planned} dias planejados nas últimas ${f.weeks} semanas. É assim que se progride.`],
        cardio_done: (f) => ['Meta de cardio cumprida', `Na semana passada você fez ${f.min} minutos de cardio e sua meta era ${f.target}. Muito bem!`]
    }
};

// Lo que llega de la app, limpio: hallazgos con código conocido y datos simples (números, textos
// cortos, listas cortas). null si no hay hallazgos válidos.
function cleanOracleInput(body) {
    if (!body || !Array.isArray(body.findings)) return null;
    const lang = ['es', 'en', 'pt'].includes(body.lang) ? body.lang : 'es';
    const goal = ORACLE_GOALS.includes(body.goal) ? body.goal : 'muscle';
    const level = ORACLE_LEVELS.includes(body.level) ? body.level : null;
    const age = Number(body.age) >= 12 && Number(body.age) <= 100 ? Math.round(Number(body.age)) : null;
    const txt = (v) => String(v).split('').filter((c) => c.charCodeAt(0) >= 32 && c !== '<' && c !== '>').join('').trim().slice(0, 40);
    const findings = [];
    const seen = new Set();
    for (const f of body.findings.slice(0, 8)) {
        if (!f || !ORACLE_CODES.includes(f.code) || seen.has(f.code)) continue;
        seen.add(f.code);
        const facts = {};
        for (const [k, v] of Object.entries((f.facts && typeof f.facts === 'object') ? f.facts : {})) {
            if (!/^[a-zA-Z]{1,12}$/.test(k)) continue;
            if (typeof v === 'number' && isFinite(v) && Math.abs(v) <= 100000) facts[k] = Math.round(v * 100) / 100;
            else if (typeof v === 'string' && txt(v)) facts[k] = txt(v);
            else if (Array.isArray(v)) { const a = v.filter((x) => typeof x === 'string' && txt(x)).slice(0, 4).map(txt); if (a.length) facts[k] = a; }
        }
        findings.push({ code: f.code, facts });
        if (findings.length >= 5) break;
    }
    return findings.length ? { lang, goal, level, age, findings } : null;
}
// Los datos de un hallazgo listos para el texto: listas con "y", músculos con nombre, números con
// la coma o el punto de cada idioma.
function oracleFacts(f, lang, goal) {
    const W = ORACLE_WORDS[lang];
    const num = (n) => lang === 'en' ? String(n) : String(n).replace('.', ',');
    const name = (x) => ORACLE_MUSCLES.includes(x) ? W.muscle[x] : x;
    const list = (a) => { const xs = (Array.isArray(a) ? a : [a]).map(name); return xs.length > 1 ? xs.slice(0, -1).join(', ') + ' ' + W.and + ' ' + xs[xs.length - 1] : (xs[0] || ''); };
    const out = { goalKey: goal };
    for (const [k, v] of Object.entries(f.facts || {})) {
        if (Array.isArray(v)) out[k] = list(v);
        else if (typeof v === 'number') out[k] = num(v);
        else out[k] = name(v);
    }
    if (typeof f.facts.rate === 'number') out.rateAbs = num(Math.abs(f.facts.rate));
    for (const k of ['pct', 'ex', 'age', 'kcal', 'maint', 'target', 'exs', 'sets', 'muscles', 'weeks', 'done', 'planned', 'prot', 'perKg', 'days', 'a', 'b', 'aSets', 'bSets', 'min', 'rateAbs']) {
        if (out[k] === undefined) out[k] = '—';
    }
    return out;
}
function oracleFixed(input, f) {
    const [title, text] = ORACLE_TEXT[input.lang][f.code](oracleFacts(f, input.lang, input.goal));
    return { icon: ORACLE_ICON[f.code] || '💡', title, text };
}
// Números de un texto (acepta 2.150 o 2,150 como miles y 1,2 o 1.2 como decimales)
function oracleNums(text) {
    return (String(text).match(/\d+(?:[.,]\d+)*/g) || []).map((m) => {
        if (/^\d{1,3}([.,]\d{3})+$/.test(m)) return Number(m.replace(/[.,]/g, ''));
        return Number(m.replace(',', '.'));
    }).filter((n) => isFinite(n));
}
// ¿El consejo de la IA sirve? Sin números que no estén en su hallazgo (los chicos, hasta 10, se
// permiten: "2 o 3 repeticiones") y sin palabras internas de la app.
function oracleAiOk(ins, input, f) {
    if (!ins || typeof ins !== 'object') return false;
    const title = String(ins.title || '').trim(), text = String(ins.text || '').trim();
    if (!title || !text || title.length > 80 || text.length > 400) return false;
    const fixed = oracleFixed(input, f), es = ORACLE_TEXT.es[f.code](oracleFacts(f, 'es', input.goal));
    const allowed = new Set(oracleNums(fixed.title + ' ' + fixed.text + ' ' + es.join(' ')).map((n) => Math.round(n * 10) / 10));
    if (oracleNums(title + ' ' + text).some((n) => n > 10 && !allowed.has(Math.round(n * 10) / 10))) return false;
    const banned = input.lang === 'en' ? /\b(fat_loss|recomp|tdee)\b/i : /\b(fat[_ ]?loss|muscle|recomp|endurance|strength|beginner|intermediate|advanced|tdee)\b/i;
    return !banned.test(title + ' ' + text);
}
function oraclePrompt(input) {
    const W = ORACLE_WORDS.es;
    const who = 'quiere ' + W.goal[input.goal] + (input.level ? ', nivel ' + W.level[input.level] : '') + (input.age ? ', ' + input.age + ' años' : '');
    const lines = input.findings.map((f, i) => {
        const [title, text] = ORACLE_TEXT.es[f.code](oracleFacts(f, 'es', input.goal));
        return (i + 1) + '. [' + (ORACLE_GOOD.has(f.code) ? 'bien' : 'atención') + '] ' + title + ': ' + text;
    });
    const langRule = input.lang === 'en' ? 'Escribí en inglés (los hallazgos están en castellano: traducilos).'
        : input.lang === 'pt' ? 'Escribí en portugués de Brasil (los hallazgos están en castellano: traducilos).'
            : 'Escribí en castellano rioplatense, con voseo: los consejos en imperativo (sumá, comé, probá, seguí, mantené, registrá; nunca "suma", "sigue" ni "mantén") y el presente como "comés" o "entrenaste". No escribas el pronombre "vos" ni uses "tú" o "usted".';
    const example = input.lang === 'es'
        ? '\nEjemplo de estilo (es otro caso, no lo copies): hallazgo "Bajás muy rápido: estás bajando unos 1,3 kg por semana; más del 1 % de tu peso por semana se lleva músculo: comé un poco más." → {"icon":"🐢","title":"Frená un poco la bajada","text":"Estás bajando unos 1,3 kg por semana, más rápido de lo que conviene. Comé un poco más para cuidar el músculo."}\n'
        : '';
    return 'Sos el Oracle de BerserkerMOD, un coach de entrenamiento cálido y directo. La app ya analizó las últimas 4 semanas de esta persona con reglas basadas en evidencia y encontró estos hallazgos, en orden de importancia. Tu trabajo es contarlos con tus palabras, no diagnosticar de nuevo.\n\n'
        + 'Persona: ' + who + '.\n\nHALLAZGOS:\n' + lines.join('\n') + '\n\n'
        + 'Reglas:\n'
        + '- Escribí exactamente ' + input.findings.length + ' consejos: uno por hallazgo, en el mismo orden. No agregues otros temas ni consejos.\n'
        + '- Mantené en el texto los números importantes de cada hallazgo (calorías, gramos, series, días); no los cambies ni inventes otros.\n'
        + '- Cada consejo: un título de hasta 6 palabras y un texto de 1 o 2 oraciones que diga qué hacer.\n'
        + '- ' + langRule + '\n'
        + '- No uses palabras en inglés ni nombres técnicos de la app.\n'
        + '- Si algo ya está bien, decilo como logro y que siga así; si hay que cambiar algo, decí qué hacer desde ahora.\n'
        + example
        + 'Respondé SOLO con JSON, sin texto antes ni después: {"insights":[{"icon":"un emoji","title":"...","text":"..."}]}';
}

// El modelo a veces se pasa al tuteo en los imperativos ("Mantén la constancia"). Se corrige la
// primera palabra de cada oración (ahí va el imperativo; en medio de una frase "sigue" puede ser
// "tu peso sigue bajando" y queda como está).
const ORACLE_TU = {
    'mantén': 'mantené', 'manten': 'mantené', 'sigue': 'seguí', 'registra': 'registrá', 'suma': 'sumá', 'prueba': 'probá',
    'comienza': 'comenzá', 'empieza': 'empezá', 'entrena': 'entrená', 'come': 'comé', 'descansa': 'descansá', 'ajusta': 'ajustá',
    'haz': 'hacé', 'revisa': 'revisá', 'aumenta': 'aumentá', 'reduce': 'reducí', 'recorta': 'recortá', 'intenta': 'intentá',
    'cuida': 'cuidá', 'apunta': 'apuntá', 'agrega': 'agregá', 'incluye': 'incluí', 'equilibra': 'equilibrá', 'continúa': 'continuá',
    'controla': 'controlá', 'reparte': 'repartí', 'mejora': 'mejorá', 'sube': 'subí', 'baja': 'bajá', 'frena': 'frená', 'busca': 'buscá'
};
function oracleVoseo(s) {
    return String(s).replace(/(^|[.!?¡]\s*)([A-Za-zÁÉÍÓÚáéíóúñÑ]+)/g, (m, pre, w) => {
        const v = ORACLE_TU[w.toLowerCase()];
        if (!v) return m;
        return pre + (w[0] !== w[0].toLowerCase() ? v[0].toUpperCase() + v.slice(1) : v);
    });
}

async function oracleProxy(req, env) {
    const body = await readBody(req);
    const input = cleanOracleInput(body);
    if (!input) {
        // La app vieja mandaba el pedido armado (o una clave de Anthropic): ya no se acepta
        if (body && (body.prompt || body.apiKey)) return json({ error: 'Actualizá la app para usar el análisis nuevo del Oracle.', code: 'oracle_update' }, 400);
        return err('Faltan los datos del análisis', 400);
    }
    const payload = env.LICENSE_SECRET ? await verifyLicense(env.LICENSE_SECRET, body.token) : null;
    if (!payload) return err('Función premium: activá tu código para usar el Oracle', 403);
    if (!(await licenseStillValid(env, payload))) return err(LICENSE_GONE_MSG, 403);   // K-5
    const quota = await aiQuotaTake(env, payload, 'oracle');
    if (!quota.ok) return err('Llegaste al límite diario del Oracle (' + AI_QUOTA.oracle + ' consultas). Mañana se renueva.', 429);
    const fixed = input.findings.map((f) => oracleFixed(input, f));
    // Sin IA (sin el binding, error o sin cupo de la cuenta): los textos fijos, sin gastar la consulta
    const withoutAi = async (why) => {
        if (why) console.error('[oracle] sin IA, textos fijos:', String(why).slice(0, 200));
        try { await quota.undo(); } catch { /* sin más */ }
        return json({ ok: true, insights: fixed, source: 'fijo' });
    };
    if (!env.AI) return withoutAi('sin binding AI');
    return aiCharged(quota, async () => {
        let parsed = null;
        try {
            const aiResp = await env.AI.run(env.PARSE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
                messages: [{ role: 'user', content: oraclePrompt(input) }],
                max_tokens: 900,
                temperature: 0.4
            });
            const raw = aiResp ? (aiResp.response != null ? aiResp.response : aiResp.text) : null;
            if (raw && typeof raw === 'object') parsed = raw;
            else {
                const txt = typeof raw === 'string' ? raw : (raw != null ? String(raw) : '');
                const m = txt.match(/\{[\s\S]*\}/);
                try { parsed = JSON.parse(m ? m[0] : txt); } catch { parsed = null; }
            }
        } catch (e) {
            return withoutAi(e && e.message);
        }
        const ai = parsed && Array.isArray(parsed.insights) ? parsed.insights : null;
        if (!ai || !ai.length) return withoutAi('respuesta sin consejos');
        let replaced = 0;
        const insights = input.findings.map((f, i) => {
            const x = ai[i];
            if (!oracleAiOk(x, input, f)) { replaced++; return fixed[i]; }
            const fix = input.lang === 'es' ? oracleVoseo : String;
            return { icon: String(x.icon || fixed[i].icon).slice(0, 8), title: fix(String(x.title).trim().slice(0, 80)), text: fix(String(x.text).trim().slice(0, 400)) };
        });
        if (replaced) console.log('[oracle] consejos de la IA reemplazados por el texto fijo:', replaced, 'de', insights.length);
        return json({ ok: true, insights, source: replaced === insights.length ? 'fijo' : 'ia' });
    });
}

// ── Importar rutina desde PDF (Cloudflare Workers AI, gratis) ─────────
// 1) env.AI.toMarkdown() convierte el PDF a texto (gratis para PDFs de texto).
// 2) un modelo Llama de Workers AI estructura ese texto en la rutina JSON.
// Sin API key ni cuenta de terceros: corre en la misma cuenta de Cloudflare,
// dentro del tier gratuito (10.000 neuronas/día). Gateado a premium/coach.
const PARSE_SYSTEM = [
    'Sos un parser de rutinas de entrenamiento. Recibís el texto de un PDF y devolvés SOLO un objeto JSON válido, sin texto antes ni después.',
    'Formato: {"name": string, "days": [{"name": string, "exercises": [EX]}]}',
    'EX de fuerza: {"name": string, "sets": int|null, "reps": string|null, "kg": number|null, "rir": int|null, "rest_s": int|null, "notes": string|null}',
    'EX de cardio: {"type": "cardio", "name": string, "duration_min": int|null, "distance_km": number|null, "intensity": "low"|"medium"|"high"|null, "notes": string|null}',
    'Si un dato NO está escrito en el PDF, poné null: nunca 0 ni un valor típico (no pongas rir 2 ni descanso 90 si el PDF no los dice). No inventes números.',
    '',
    'Estructura:',
    '- Un día es una sesión de entrenamiento ("Día 1", "Lunes", "Sesión A", "Torso A"). Los bloques de una sesión (entrada en calor, bloque 1, A1/A2, superserie, circuito, core, finisher) van todos en el MISMO día, en orden.',
    '- Si un plan semanal dice qué rutina toca cada día (Lunes: Rutina A, Miércoles: Rutina B, Viernes: Rutina A), los días son las rutinas (Rutina A, Rutina B), cada una UNA sola vez; no armes un día por cada día de la semana.',
    '- Si el programa tiene varias semanas (columnas "Semana 1, 2, 3..."), armá cada día UNA sola vez con los valores de la semana 1 y anotá en notes cómo sigue (ej. "S2 4x5 @77%, S3 5x4 @82%, S4 descarga 3x5 @65%").',
    '- Si una página resume los días y otra los detalla, usá el detalle y no dupliques.',
    '- Las marcas [Página N] son cortes de página, no días: una página puede tener varios días y un día puede seguir en la página siguiente. Guiate por los títulos de cada día.',
    '- Si el texto no es una rutina de entrenamiento (una guía, un artículo, una factura), devolvé {"name": "", "days": []}.',
    '',
    'Cada ejercicio:',
    '- Cada ejercicio va por separado, con su propio nombre (nunca "Circuito" ni "Abdominales" como nombre). Un circuito o una superserie se separa en sus ejercicios: las vueltas son las series y en notes va "circuito". "Abdominales: crunch 3x20, plancha 3x40 s" son dos ejercicios: Crunch y Plancha.',
    '- reps es texto: "10", "8-12", "12-10-8-6", "al fallo", "AMRAP". Si son segundos (40\'\', 30 s), poné "40 s". "Por pierna", "por lado" o "c/brazo" van en notes.',
    '- rir = repeticiones en reserva. Si el PDF da RPE, rir = 10 - RPE (RPE 8 = rir 2). "Al fallo" = rir 0.',
    '- kg = carga en kilos. Si está en libras (lb, lbs), convertí: kg = lb x 0,4536, redondeado a 0,5. Si es un % del 1RM y el PDF da el 1RM de ese ejercicio, calculá los kg y redondeá a 2,5; si no, no pongas kg y anotá el % en notes. Un lastre (+10 kg) va en kg. Pirámide con varias cargas: kg = la primera y todas en notes.',
    '- rest_s = descanso entre series en segundos (90\'\' = 90, 2\' = 120, 1\'30\'\' = 90, "2-3 min" = 150). Si hay un descanso general para todos, ponelo en cada ejercicio.',
    '- Cardio = correr, trotar, caminar, cinta, bici, spinning, elíptica, escaladora, remo ergómetro, natación, soga. Con intervalos calculá el total: 8 x 250 m = distance_km 2; 10 x (15\'\' + 45\'\') = duration_min 10. Suave = low, moderado = medium, fuerte o a tope = high.',
    '- Nombres en el IDIOMA indicado, con mayúscula inicial. Si el ejercicio es exactamente el mismo que uno de los NOMBRES CONOCIDOS (mismo movimiento y mismo implemento), usá ese nombre exacto. Si no hay uno igual, dejá el nombre del PDF (traducido al IDIOMA si está en otro): no lo cambies por uno parecido.',
    '- Del inglés al español: bench press = press banca, overhead press = press militar, row = remo, pull-up = dominadas, deadlift = peso muerto, leg curl = curl femoral, calf raise = pantorrilla, face pull = face pull. "Prensa" es solo la prensa de piernas.',
    '- Si es una rutina sin nombre, poné uno corto descriptivo.'
].join('\n');

// Nombres de ejercicios que la app ya conoce (catálogo e historial del usuario): la IA los usa
// cuando es el mismo ejercicio, así el historial y la carga sugerida quedan conectados.
function cleanKnownNames(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set(), out = [];
    for (const v of list.slice(0, 300)) {
        if (typeof v !== 'string') continue;
        const n = v.replace(/[^\p{L}\p{N} ().,/+-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
        if (!n || seen.has(n.toLowerCase())) continue;
        seen.add(n.toLowerCase()); out.push(n);
        if (out.length >= 200) break;
    }
    return out;
}

// Texto útil de toMarkdown: sin el bloque de metadatos ni los títulos de página que agrega.
function pdfContentText(md) {
    const t = String(md || ''), k = t.indexOf('## Contents');
    return (k >= 0 ? t.slice(k + 11) : t).replace(/^#{1,3} Page \d+\s*$/gm, '').trim();
}

function sanitizeParsedRoutine(p) {
    const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max || 80) : null);
    const numOrNull = (v) => (typeof v === 'number' && isFinite(v) ? v : (v != null && !isNaN(parseFloat(v)) ? parseFloat(v) : null));
    const intOrNull = (v) => { const n = numOrNull(v); return n == null ? null : Math.round(n); };
    const inRange = (n, lo, hi) => (n != null && n >= lo && n <= hi ? n : null);
    const out = { name: str(p && p.name, 60) || 'Rutina importada', days: [] };
    const days = (p && Array.isArray(p.days)) ? p.days.slice(0, 14) : [];
    days.forEach((d, i) => {
        const exsIn = (d && Array.isArray(d.exercises)) ? d.exercises.slice(0, 40) : [];
        const exercises = [];
        for (const e of exsIn) {
            if (!e || !str(e.name, 80)) continue;
            if (e.type === 'cardio') {
                exercises.push({ type: 'cardio', name: str(e.name, 80),
                    distance_km: inRange(numOrNull(e.distance_km), 0.1, 300), duration_min: inRange(intOrNull(e.duration_min), 1, 600),
                    intensity: ['low', 'medium', 'high'].includes(e.intensity) ? e.intensity : null,
                    notes: str(e.notes, 200) });
            } else {
                // RIR de 6 a 10 en una rutina es casi seguro un RPE copiado: RIR = 10 − RPE
                let rir = intOrNull(e.rir);
                if (rir != null && rir >= 6 && rir <= 10) rir = 10 - rir;
                exercises.push({ type: 'strength', name: str(e.name, 80),
                    sets: inRange(intOrNull(e.sets), 1, 20), reps: str(e.reps, 24), kg: inRange(numOrNull(e.kg), 0.5, 600),   // 0 kg = sin carga
                    rir: inRange(rir, 0, 5), rest_s: inRange(intOrNull(e.rest_s), 5, 900), notes: str(e.notes, 200) });
            }
        }
        out.days.push({ name: str(d && d.name, 60) || ('Día ' + (i + 1)), exercises });
    });
    // Días sin ejercicios no sirven (salvo que no haya ninguno: la app lo toma como "vacía")
    const full = out.days.filter((d) => d.exercises.length);
    out.days = full.length ? full : [{ name: 'Día 1', exercises: [] }];
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

// Modelo de visión de la tabla nutricional (Llama 4 Scout).
const VISION_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
// PDFs de imágenes o diseño (la app rasteriza las páginas con PDF.js y manda los JPEG): OCR puro, transcribe
// el texto. Mistral Small 3.1: en el banco de PDFs (20-nov-2026) leyó las 3 rutinas de imagen igual o mejor
// que Scout (la foto torcida del celular, 100 % de los datos contra 98 %) en 19-25 s contra 40-80 s.
const OCR_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
// Foto del plato: Mistral Small 3.1. En el banco de 30 platos (18-nov-2026) dio el mismo error que Scout
// en calorías (32 % contra 31 %), las mismas neuronas y 4,5 s por foto contra 14-26 s (picos de 49 s).
// La tabla nutricional sigue con Scout: no se probó con Mistral.
const MEAL_VISION_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
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
async function ocrImage(env, b64, model) {
    const clean = b64.replace(/^data:image\/\w+;base64,/, '');
    const r = await env.AI.run(model || OCR_MODEL, {
        messages: [{ role: 'user', content: [
            { type: 'text', text: OCR_PROMPT },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + clean } }
        ] }],
        max_tokens: 2048,
        temperature: 0.1
    });
    if (!r) return '';
    const msg = Array.isArray(r.choices) && r.choices[0] && r.choices[0].message ? r.choices[0].message.content : null;
    return String(r.response || msg || r.description || r.text || '');
}

async function parseRoutine(req, env) {
    if (!env.AI) return err('Importador de PDF no configurado (falta el binding AI de Workers AI)', 503);
    const body = await readBody(req, MAX_BODY_PDF);
    // Gate: solo licencias válidas (premium o coach).
    const payload = env.LICENSE_SECRET ? await verifyLicense(env.LICENSE_SECRET, body && body.token) : null;
    if (!payload) return err('Función premium: activá tu código para importar rutinas', 403);
    if (!(await licenseStillValid(env, payload))) return err(LICENSE_GONE_MSG, 403);   // K-5
    const quota = await aiQuotaTake(env, payload, 'parse');
    if (!quota.ok) return err('Llegaste al límite diario de importaciones (' + AI_QUOTA.parse + ' por día). Mañana se renueva.', 429);
    // Banco de pruebas (solo con FOOD_BENCH = "1", que en producción no existe): permite elegir el
    // modelo que lee las imágenes. Ver bench-pdf/ (fuera del repo).
    const bench = String(env.FOOD_BENCH || '') === '1';
    const ocrModel = (bench && typeof body.ocr_model === 'string' && /^@cf\/[\w.\-/]+$/.test(body.ocr_model)) ? body.ocr_model : (env.OCR_MODEL || OCR_MODEL);
    const known = cleanKnownNames(body && body.known);
    const langName = { en: 'inglés', pt: 'portugués de Brasil' }[body && body.lang] || 'español';   // idioma de la app
    // L-5: si la IA falla o no sirve, el uso se devuelve.
    return aiCharged(quota, async () => {

        // Aceptación única de la licencia del modelo de visión (Meta exige enviar
        // 'agree' una vez por cuenta antes de usarlo). Gateado, se llama una sola vez.
        if (body && body.agree_vision) {
            try { const a = await env.AI.run(VISION_MODEL, { prompt: 'agree' }); return json({ ok: true, agreed: true, resp: a }); }
            catch (e) { return aiErrorResponse(e, 'agree falló'); }
        }

        // Dos fuentes posibles: imágenes de las páginas (PDF de diseño o escaneado) o el PDF
        // crudo (texto). La app prueba el texto primero y pasa a imágenes si no hay texto.
        let sourceText = '';
        const images = (body && Array.isArray(body.images)) ? body.images.slice(0, 8) : null;
        if (images && images.length) {
            try {
                const valid = images.filter((img) => typeof img === 'string' && img.length <= 4000000); // ~3 MB/imagen
                // OCR de las páginas en paralelo (mucho más rápido que en serie).
                const parts = await Promise.all(valid.map((img) => ocrImage(env, img, ocrModel).catch(() => '')));
                sourceText = parts.map((tx, i) => '[Página ' + (i + 1) + ']\n' + tx).join('\n\n');
            } catch (e) {
                return aiErrorResponse(e, 'No se pudieron leer las imágenes del PDF');
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
                sourceText = pdfContentText((doc && doc.data) || '');
            } catch (e) {
                return aiErrorResponse(e, 'No se pudo leer el PDF');
            }
        }

        // Debug gateado (solo si el caller manda debug:true): ver el texto crudo.
        if (body && body.debug) return json({ ok: true, debug: true, src: images ? 'vision' : 'text', md_chars: sourceText.length, md_preview: sourceText.slice(0, 4000) });
        const textChars = sourceText.replace(/\[Página \d+\]/g, '').replace(/\s/g, '').length;
        // Sin texto (PDF hecho de imágenes): no se llama al modelo ni se descuenta la importación;
        // la app sigue con las fotos de las páginas.
        if (!images && textChars < 20) {
            try { await quota.undo(); } catch { /* sin más */ }
            return json({ ok: true, routine: sanitizeParsedRoutine({ days: [] }), text_chars: textChars, empty: 'no_text' });
        }
        if (!textChars) return err('No se pudo leer texto en las imágenes del PDF', 422);
        sourceText = sourceText.slice(0, 24000); // acotamos lo que va al modelo

        // Estructurar con el 70B (texto → JSON), igual para ambas fuentes.
        const model = env.PARSE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
        try {
            const aiResp = await env.AI.run(model, {
                messages: [
                    { role: 'system', content: PARSE_SYSTEM },
                    { role: 'user', content: 'IDIOMA: ' + langName + '\n' + (known.length ? 'NOMBRES CONOCIDOS: ' + known.join(', ') + '\n' : '') + '\nTexto del PDF:\n\n' + sourceText + '\n\nDevolvé SOLO el JSON.' }
                ],
                max_tokens: 4096,
                temperature: 0.1
            });
            const parsed = aiJson(aiResp);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return err('No se pudo interpretar la rutina del PDF', 422);
            const routine = sanitizeParsedRoutine(parsed);
            const n = routine.days.reduce((a, d) => a + d.exercises.length, 0);
            // Con texto de sobra y sin ejercicios: el PDF no es una rutina (la app no prueba con imágenes)
            return json({ ok: true, routine, text_chars: textChars, empty: n ? undefined : (images ? 'no_routine' : (textChars >= 300 ? 'no_routine' : 'little_text')), raw: bench && body.raw ? parsed : undefined });
        } catch (e) {
            return aiErrorResponse(e);
        }
    });
}

// ── Comida por foto (Workers AI, visión) ─────────────────────────────
// Premium. 'label' lee la tabla nutricional de un envase (para los productos que
// no están en Open Food Facts) y 'meal' estima un plato. La foto se analiza y se
// descarta: no se guarda en ningún lado.
const LABEL_PROMPT = [
    'Leé la TABLA NUTRICIONAL (información nutricional) del envase de alimento de esta foto.',
    'Devolvé SOLO un objeto JSON, sin texto extra:',
    '{"name": string|null, "basis_g": number, "kcal": number|null, "kj": number|null, "protein": number, "carbs": number, "fat": number, "portion_g": number|null}',
    'Reglas:',
    '- Si la tabla tiene una columna "por 100 g" (o 100 ml), copiá esos valores y poné basis_g = 100.',
    '- Si solo tiene valores por porción, copiá los de la porción y poné basis_g = gramos de esa porción.',
    '- kcal = valor energético en kcal; si solo figura en kJ, poné kcal null y el número en kj.',
    '- carbs = carbohidratos totales; fat = grasas totales; protein = proteínas. Números, sin unidades.',
    '- portion_g = gramos (o ml) de la porción que indica la tabla, o null.',
    '- name = nombre del producto si se lee en la foto, si no null.',
    '- Copiá los números tal como están escritos. No inventes: si un dato no se lee, poné null.',
    '- Si en la foto no hay una tabla nutricional, devolvé {"error":"no_label"}.'
].join('\n');
// Foto del plato (2026-11, mejora de precisión). La IA identifica los alimentos y estima los
// gramos; las calorías y los macros salen de la base del USDA (food-db.js) cuando el alimento
// está ahí, y solo si no está se usa lo que estimó la IA. Ver groundMealItems.
function mealPrompt(note) {
    const lines = [
        'Sos nutricionista. Mirá la foto del plato. Primero identificá cada alimento por separado y después estimá cuántos gramos hay de cada uno.',
        'Devolvé SOLO un objeto JSON, sin texto extra:',
        '{"items": [{"name": string, "grams": number, "kcal": number, "protein": number, "carbs": number, "fat": number}]}',
        'Reglas para los nombres:',
        '- Nombre genérico en español rioplatense, con la forma de cocción si se ve: "Pechuga de pollo a la plancha", "Papas fritas", "Arroz blanco", "Brócoli hervido", "Salmón al horno", "Milanesa de carne", "Huevos revueltos".',
        '- Un item por alimento: no juntes en un solo item cosas distintas (la ensalada va aparte del pollo).',
        'Reglas para los gramos (lo más importante):',
        '- Usá referencias de tamaño: un plato playo mide unos 26 cm, un plato de postre 20 cm, un bowl 15 cm; un tenedor mide 19 cm. Fijate qué parte del plato ocupa cada alimento y qué altura tiene.',
        '- Medí cada porción por lo que se ve (superficie y altura), no por lo que suele servirse: las porciones de la foto pueden ser chicas. Referencias de densidad: una taza de arroz o fideos cocidos pesa 160 g, una cucharada de aceite 13 g, un huevo 50 g.',
        '- Las IA suelen pasarse con los gramos: si dudás entre dos cantidades, elegí la menor.',
        '- grams = cantidad de esa porción en el plato; kcal y macros son de ESA cantidad (no por 100 g).',
        'Grasas (las calorías que más se escapan):',
        '- Si ves aceite (brillo, charco en el plato), aderezo, manteca, mayonesa, queso derretido o salsa, ponelos como items aparte con sus gramos (ej. "Aceite de oliva" 10 g).',
        '- Si algo está frito o salteado y brilla, sumá el aceite que absorbió como item "Aceite".',
        '- Como máximo 10 items. Si en la foto no hay comida, devolvé {"items": []}.'
    ];
    // La nota dice QUÉ es, no CUÁNTO: en el banco de pruebas, al nombrar alimentos la IA les ponía una porción entera a cada uno.
    if (note) lines.push('El usuario contó qué hay en el plato: "' + note + '". Sirve solo para saber QUÉ es cada cosa que ves (por ejemplo, si la milanesa es de pollo o de carne). No cambia CUÁNTO hay: los gramos salen únicamente de la foto, con las mismas reglas. No agregues un alimento porque esté nombrado si no se ve; si se ve poco, ponele pocos gramos. Que nombre varios alimentos no quiere decir que haya una porción entera de cada uno.');
    return lines.join('\n');
}
// Lo que el usuario escribió sobre el plato: texto corto, sin saltos de línea ni comillas.
function cleanMealNote(v) {
    if (typeof v !== 'string') return '';
    let out = '';
    for (const ch of v.slice(0, 400)) out += (ch.charCodeAt(0) < 32 || '"“”«»\\'.includes(ch)) ? ' ' : ch;
    return out.replace(/\s+/g, ' ').trim().slice(0, 200);
}
// ── Base de alimentos (USDA) para la foto del plato ──
const FOOD_DB_VERSION = 2;   // subirlo cuando cambie food-db.js (la app vuelve a pedir la lista)
function normFoodName(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ]+/g, ' ').replace(/ñ/g, 'n').trim();
}
// El alimento de la base que corresponde a un nombre. En español lo que define el alimento va
// primero ("Atún en aceite" es atún, "Pan de lentejas" es pan): gana el que aparece antes en el
// nombre y, a igual posición, el sinónimo más largo ("milanesa de pollo" sobre "milanesa").
// Si el nombre junta varios alimentos ("Penne con carne y brócoli"), no se ancla: es un plato
// mixto y la base no sabe las proporciones. null en esos casos y si no hay ninguno.
const MIXED_RE = /\b(con|y|with|and)\b/;
function matchFood(name) {
    const norm = normFoodName(name);
    const n = ' ' + norm + ' ';
    if (norm.length < 2) return null;
    const found = [];
    for (const f of FOOD_DB) {
        for (const s of f.s) {   // del más largo al más corto: el primero que aparece es el mejor de ese alimento
            const i = n.indexOf(' ' + s + ' ');
            if (i >= 0) { found.push({ i, len: s.length, f }); break; }
        }
    }
    if (!found.length) return null;
    found.sort((a, b) => a.i - b.i || b.len - a.len);
    const head = found[0];
    // ¿Otro alimento distinto que no esté contenido en el principal? ("pechuga de pollo" contiene "pollo")
    const others = found.filter((x) => x.f.k !== head.f.k && !(x.i >= head.i && x.i + x.len <= head.i + head.len));
    if (others.length && MIXED_RE.test(norm)) return null;
    return head.f;
}
// Aceite de cocción que no se ve. En el banco de pruebas (30 platos pesados de Nutrition5k), a la
// estimación le faltaban ~10 g de grasa por plato: sumar el 4 % del peso de lo cocinado a la
// plancha, salteado o al horno deja el sesgo de calorías en ~0 (de −8 %). Lo frito ya trae su
// aceite en la base, y si la IA ya puso aceite o manteca no se suma (no contarlo dos veces).
// Va como un renglón visible y editable: el usuario lo saca si cocinó sin aceite.
const COOKED_RE = /\b(plancha|salteado|salteada|salteados|salteadas|asado|asada|asados|asadas|horno|grillado|grillada|grillados|dorado|dorada|dorados|sauteed|roasted|grilled|seared|parrilla)\b/;
const FAT_RE = /\b(aceite|manteca|mayonesa|aderezo|vinagreta|oil|butter|dressing|mayonnaise)\b/;
const COOKING_OIL_PCT = 4;
function cookingOil(items) {
    if (items.some((i) => FAT_RE.test(normFoodName(i.name)))) return null;
    const cooked = items.filter((i) => COOKED_RE.test(normFoodName(i.name))).reduce((a, i) => a + i.grams, 0);
    const grams = Math.round(cooked * COOKING_OIL_PCT / 100);
    if (grams < 2) return null;
    return { name: 'Aceite de cocción (estimado)', grams, kcal: grams * 9, protein: 0, carbs: 0, fat: grams, src: 'base', food: 'aceite', per100: { kcal: 900, protein: 0, carbs: 0, fat: 100 }, estimated: true };
}
// Reemplaza los macros que inventó la IA por los de la base cuando el alimento está ahí.
function groundMealItems(items) {
    return items.map((it) => {
        const f = matchFood(it.name);
        if (!f) return Object.assign({}, it, { src: 'ia' });
        const k = it.grams / 100;
        return Object.assign({}, it, {
            kcal: Math.round(f.kcal * k), protein: Math.round(f.p * k * 10) / 10, carbs: Math.round(f.c * k * 10) / 10, fat: Math.round(f.f * k * 10) / 10,
            src: 'base', food: f.k, per100: { kcal: f.kcal, protein: f.p, carbs: f.c, fat: f.f }
        });
    });
}

function sanitizeFoodVision(kind, p) {
    const num = (v, max) => { const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) && n >= 0 && n <= max ? n : null; };
    const r1 = (n) => Math.round(n * 10) / 10;
    const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    if (!p || typeof p !== 'object') return null;
    if (kind === 'meal') {
        const items = (Array.isArray(p.items) ? p.items : []).slice(0, 10).map((i) => {
            const name = str(i && i.name, 60), grams = num(i && i.grams, 2000), kcal = num(i && i.kcal, 3000);
            if (!name || !grams || kcal == null) return null;
            return { name, grams: Math.round(grams), kcal: Math.round(kcal), protein: r1(num(i.protein, 300) || 0), carbs: r1(num(i.carbs, 500) || 0), fat: r1(num(i.fat, 300) || 0) };
        }).filter(Boolean);
        return items.length ? { items } : null;
    }
    if (p.error) return null;
    const basis = num(p.basis_g, 1000) || 100;
    let kcal = num(p.kcal, 5000);
    if (kcal == null && num(p.kj, 20000) != null) kcal = num(p.kj, 20000) / 4.184;
    const protein = num(p.protein, 1000), carbs = num(p.carbs, 1000), fat = num(p.fat, 1000);
    if (kcal == null || protein == null || carbs == null || fat == null) return null;
    const k = 100 / basis;
    const per100 = { kcal: Math.round(kcal * k), protein: r1(protein * k), carbs: r1(carbs * k), fat: r1(fat * k) };
    // Plausible para 100 g: hasta 900 kcal y macros que no suman más que el peso.
    if (per100.kcal > 900 || per100.protein + per100.carbs + per100.fat > 105) return null;
    const portion = num(p.portion_g, 2000);
    return { name: str(p.name, 60), per100, portion_g: portion ? Math.round(portion) : null };
}

async function foodVision(req, env) {
    if (!env.AI) return err('Fotos de comida no configuradas (falta el binding AI)', 503);
    const body = await readBody(req, MAX_BODY_IMG);
    const payload = env.LICENSE_SECRET ? await verifyLicense(env.LICENSE_SECRET, body && body.token) : null;
    if (!payload) return err('Función premium: activá tu código para analizar fotos de comida', 403);
    if (!(await licenseStillValid(env, payload))) return err(LICENSE_GONE_MSG, 403);   // K-5
    const kind = body && body.kind === 'meal' ? 'meal' : 'label';
    const img = body && typeof body.image === 'string' ? body.image.replace(/^data:image\/\w+;base64,/, '') : '';
    if (!img || img.length > 1400000 || !/^[A-Za-z0-9+/]+=*$/.test(img)) return err('Falta la foto o no es válida', 400);
    const quota = await aiQuotaTake(env, payload, 'food');
    if (!quota.ok) return err('Llegaste al límite diario de fotos (' + AI_QUOTA.food + '). Mañana se renueva.', 429);
    // Banco de pruebas de comida (solo con FOOD_BENCH = "1", que en producción no existe): permite
    // elegir el modelo por pedido y devuelve los tokens gastados. Ver bench-comida/ (fuera del repo).
    const bench = String(env.FOOD_BENCH || '') === '1';
    const model = (bench && typeof body.model === 'string' && /^@cf\/[\w.\-/]+$/.test(body.model)) ? body.model
        : (kind === 'meal' ? (env.MEAL_VISION_MODEL || MEAL_VISION_MODEL) : (env.FOOD_VISION_MODEL || VISION_MODEL));
    // L-5: si la IA falla o no sirve, el uso se devuelve.
    return aiCharged(quota, async () => {
        try {
            const r = await env.AI.run(model, Object.assign({
                messages: [{ role: 'user', content: [
                    { type: 'text', text: kind === 'meal' ? mealPrompt(cleanMealNote(body.note)) : LABEL_PROMPT },
                    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + img } }
                ] }],
                max_tokens: 800,
                temperature: 0.1
            }, visionOpts(model, bench ? body.reasoning : null)));
            const parsed = aiJson(r);
            const clean = sanitizeFoodVision(kind, parsed);
            if (clean && kind === 'meal') {
                clean.items = groundMealItems(clean.items);
                const oil = cookingOil(clean.items);
                if (oil) clean.items.push(oil);
            }
            if (!clean) return err(kind === 'meal' ? 'No pude reconocer comida en la foto. Probá con el plato entero y buena luz.' : 'No pude leer la tabla nutricional. Probá con la tabla entera, derecha y con buena luz.', 422);
            const out = Object.assign({ ok: true, kind }, clean);
            if (bench) { out.usage = (r && r.usage) || null; out.model = model; out.raw = parsed; }
            return json(out);
        } catch (e) {
            return aiErrorResponse(e);
        }
    });
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

// Zona horaria IANA válida (la que da el teléfono: 'Europe/Madrid', 'Atlantic/Canary'…) o null.
function validTz(tz) {
    if (typeof tz !== 'string' || !tz || tz.length > 64) return null;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
}
// Día ('YYYY-MM-DD') y hora (0-23) locales de una zona en un instante dado.
function localClock(tz, when) {
    const p = {};
    for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(when)) p[x.type] = x.value;
    return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

// ═════════ Avisos con texto y a horario (Web Push cifrado + Durable Object) ═════════
// iPhone congela las apps web en segundo plano: lo que tiene que sonar con la app cerrada
// (fin del descanso, recordatorio del control, avisos del coach, resumen del coach) lo manda
// el servidor. El texto viaja cifrado para cada teléfono (RFC 8291, aes128gcm). El
// recordatorio diario de entrenar sigue como push vacío (el teléfono pone el texto).
const PUSH_MSG = {
    es: { coach: 'Tu coach', rest: '¡Terminó el descanso! A la próxima serie 💪', chk: '📝 {coach}: es momento de tu control semanal', remind: '🔔 {coach} te recuerda mandar tu control semanal', eval: '📋 {coach} te dejó la evaluación del ciclo {c}', video: '📹 {coach} respondió tu video de {ex}', chkreply: '💬 {coach} respondió tu control semanal', announce: '📣 {coach}: {text}', plan: '🔄 {coach} actualizó tu rutina', review: '🏁 {coach} te dejó el balance de tu programa', digest: '📋 Alumnos para revisar: {names}', more: ' y {n} más' },
    en: { coach: 'Your coach', rest: 'Rest is over! On to the next set 💪', chk: '📝 {coach}: time for your weekly check-in', remind: '🔔 {coach} reminds you to send your weekly check-in', eval: '📋 {coach} left your cycle {c} review', video: '📹 {coach} replied to your {ex} video', chkreply: '💬 {coach} replied to your weekly check-in', announce: '📣 {coach}: {text}', plan: '🔄 {coach} updated your routine', review: '🏁 {coach} left your program summary', digest: '📋 Students to review: {names}', more: ' and {n} more' },
    pt: { coach: 'Seu coach', rest: 'Acabou o descanso! Bora para a próxima série 💪', chk: '📝 {coach}: hora do seu check-in semanal', remind: '🔔 {coach} lembra você de enviar seu check-in semanal', eval: '📋 {coach} deixou a avaliação do ciclo {c}', video: '📹 {coach} respondeu seu vídeo de {ex}', chkreply: '💬 {coach} respondeu seu check-in semanal', announce: '📣 {coach}: {text}', plan: '🔄 {coach} atualizou sua rotina', review: '🏁 {coach} deixou o balanço do seu programa', digest: '📋 Alunos para revisar: {names}', more: ' e mais {n}' }
};
function pushText(lang, key, vars) {
    const L = PUSH_MSG[lang] || PUSH_MSG.es;
    let s = L[key] || PUSH_MSG.es[key] || '';
    for (const [k, v] of Object.entries(vars || {})) s = s.split('{' + k + '}').join(String(v));
    return s;
}
function concatBytes(...parts) {
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}
async function hkdf(salt, ikm, info, len) {
    const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}
// Cifra el texto para una suscripción: RFC 8291 + RFC 8188, un solo registro (rs 4096).
// `test` fija la clave efímera y la sal (para comparar con el ejemplo del RFC).
async function encryptPushPayload(keys, plain, test) {
    const uaPublic = b64urlToBytes(keys.p256dh), authSecret = b64urlToBytes(keys.auth);
    const salt = (test && test.salt) || crypto.getRandomValues(new Uint8Array(16));
    let asPrivate, asPublic;
    if (test && test.asPrivate) { asPrivate = test.asPrivate; asPublic = test.asPublic; }
    else {
        const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        asPrivate = kp.privateKey;
        asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    }
    const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));
    const zero = new Uint8Array([0]);
    const ikm = await hkdf(authSecret, ecdh, concatBytes(enc.encode('WebPush: info'), zero, uaPublic, asPublic), 32);
    const cek = await hkdf(salt, ikm, concatBytes(enc.encode('Content-Encoding: aes128gcm'), zero), 16);
    const nonce = await hkdf(salt, ikm, concatBytes(enc.encode('Content-Encoding: nonce'), zero), 12);
    const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concatBytes(plain, new Uint8Array([2]))));
    const header = new Uint8Array(21 + asPublic.length);
    header.set(salt, 0);
    new DataView(header.buffer).setUint32(16, 4096);
    header[20] = asPublic.length;
    header.set(asPublic, 21);
    return concatBytes(header, ct);
}
// Suscripción completa (dirección + claves) de un servicio de push conocido, o null.
function cleanSub(s) {
    if (!s || typeof s.endpoint !== 'string' || s.endpoint.length > 1024 || !pushHostAllowed(s.endpoint)) return null;
    const k = s.keys || {};
    if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || k.p256dh.length > 120 || k.auth.length > 40) return null;
    try { if (b64urlToBytes(k.p256dh).length !== 65 || b64urlToBytes(k.auth).length !== 16) return null; } catch { return null; }
    return { endpoint: s.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } };
}
// Manda un push (con texto cifrado si hay payload). Devuelve el estado HTTP (0 = no salió).
async function sendPush(env, sub, payload, opts = {}) {
    if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC_KEY || !sub || !sub.endpoint) return 0;
    try {
        const origin = new URL(sub.endpoint).origin;
        const jwts = opts.jwts || {};
        if (!jwts[origin]) jwts[origin] = await vapidJwt(env, origin);
        const headers = { TTL: String(opts.ttl || 86400), Authorization: 'vapid t=' + jwts[origin] + ', k=' + env.VAPID_PUBLIC_KEY };
        if (opts.urgency) headers.Urgency = opts.urgency;
        let body;
        if (payload && sub.keys) {
            body = await encryptPushPayload(sub.keys, enc.encode(JSON.stringify(payload)));
            headers['Content-Encoding'] = 'aes128gcm';
            headers['Content-Type'] = 'application/octet-stream';
        }
        // Con tope de tiempo: un servicio de avisos colgado no puede dejar esperando a quien llamó
        // (el objeto del coach manda estos avisos con su fila tomada).
        const resp = await fetch(sub.endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
        return resp.status;
    } catch { return 0; }
}
async function pushMany(env, subs, payload, opts) {
    const jwts = {};
    let sent = 0;
    const dead = [];
    for (const s of subs) {
        const st = await sendPush(env, s, payload, Object.assign({ jwts }, opts || {}));
        if (st === 404 || st === 410) dead.push(s.endpoint);       // suscripción muerta → se borra
        else if (st > 0 && st < 400) sent++;
    }
    return { sent, dead };
}

// ── Horarios en la zona del teléfono ──
function localParts(tz, when) {
    const p = {};
    for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(when)) p[x.type] = x.value;
    return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}
// Instante (ms) en que en `tz` es el día `date` a las `hour`:00 (con horario de verano).
function zonedTime(date, hour, tz) {
    const want = Date.parse(date + 'T00:00:00Z') + hour * 3600000;
    let t = want;
    for (let i = 0; i < 3; i++) {
        const lp = localParts(tz, new Date(t));
        const got = Date.parse(lp.date + 'T00:00:00Z') + lp.hour * 3600000 + lp.minute * 60000;
        if (got === want) break;
        t += want - got;
    }
    return t;
}
// Próxima vez (después de `now`) que en `tz` es el día `dow` (0 = domingo; null = cualquiera) a las `hour`.
function nextLocalTime(now, dow, hour, tz) {
    const today = localParts(tz, new Date(now)).date;
    for (let d = 0; d <= 8; d++) {
        const date = addDaysISO(today, d);
        if (dow != null && new Date(date + 'T00:00:00Z').getUTCDay() !== dow) continue;
        const t = zonedTime(date, hour, tz);
        if (t > now + 30000) return t;
    }
    return now + 7 * 86400000;
}

// ── Recordatorio semanal del control: el coach elige día y hora; si no, domingo 18 h ──
function cleanChkRemind(c) {
    if (!c || typeof c !== 'object') return null;
    if (c.mode === 'off' || c.mode === 'auto') return { mode: c.mode };
    if (c.mode !== 'custom') return null;
    const dow = Number(c.dow), hour = Number(c.hour);
    if (!(Number.isInteger(dow) && dow >= 0 && dow <= 6 && Number.isInteger(hour) && hour >= 0 && hour <= 23)) return null;
    return { mode: 'custom', dow, hour };
}
function chkRemindOf(r) {
    const c = r.chk_remind || { mode: 'auto' };
    if (c.mode === 'off') return { mode: 'off' };
    if (c.mode === 'custom') return { mode: 'custom', dow: c.dow, hour: c.hour };
    return { mode: 'auto', dow: 0, hour: 18 };
}
// Lo que ve el coach del registro del alumno: si tiene avisos, no las direcciones ni las claves.
function stripPush(r) {
    const o = Object.assign({}, r);
    o.push_on = Array.isArray(r.push_subs) ? r.push_subs.length : 0;
    delete o.push_subs;
    o.seat = seatState(r);
    o.premium_count = Array.isArray(r.premium_codes) ? r.premium_codes.length : 0;   // cuántos, nunca los códigos
    delete o.premium_seat; delete o.premium_state; delete o.premium_codes;
    return o;
}
async function loadShareRoutine(env, token) {
    const idx = token ? await kvGet(env, `token:${token}`) : null;
    if (!idx) return null;
    // Desde otro objeto (la alarma del recordatorio): el registro se le pide al objeto del coach.
    const r = doData(env) && !env.__coach
        ? await runInCoach(env, idx.coachId, 'load', [idx.routineId])
        : await kvGetRoutine(env, routineKey(idx.coachId, idx.routineId));
    return r ? { idx, r } : null;
}
// Lo que las alarmas de avisos leen y escriben del coach: en su objeto o, sin él, en KV.
async function pruneStudentSubs(env, idx, r, dead) {
    if (doData(env) && !env.__coach) return runInCoach(env, idx.coachId, 'prune', [idx.routineId, dead]);
    r.push_subs = (r.push_subs || []).filter((s) => !dead.includes(s.endpoint));
    return kvPut(env, routineKey(idx.coachId, idx.routineId), r);
}
async function coachCfgOf(env, coachId) {
    return doData(env) && !env.__coach ? runInCoach(env, coachId, 'cfg', []) : kvGet(env, `coachcfg:${coachId}`);
}
// Una página de alumnos para el resumen diario: cuántos tienen algo para revisar y sus nombres.
async function digestPage(env, coachId, cursor, today) {
    if (doData(env) && !env.__coach) return runInCoach(env, coachId, 'digestPage', [cursor || '', today, DIGEST_PAGE]);
    const res = await env.BMOD_KV.list({ prefix: `routine:${coachId}:`, cursor: cursor || undefined, limit: DIGEST_PAGE });
    const names = [];
    let count = 0;
    for (const k of res.keys) {
        const r = await kvGet(env, k.name);
        if (r && studentAlerts(r, today).length) { count++; names.push(r.alumno_name || '—'); }
    }
    return { count, names: names.slice(0, 3), next: res.list_complete ? null : res.cursor };
}
async function pruneDigestSubs(env, coachId, cfg, dead) {
    if (doData(env) && !env.__coach) return runInCoach(env, coachId, 'digestPrune', [dead]);
    cfg.digest.subs = cfg.digest.subs.filter((s) => !dead.includes(s.endpoint));
    return kvPut(env, `coachcfg:${coachId}`, cfg);
}
// Funciones que corren adentro del objeto del coach (ver runInCoach). env ya es el del objeto.
const COACH_FNS = {
    async load(env, routineId) {
        const r = await kvGetRoutine(env, routineKey(env.__coach.coachId, routineId));
        if (!r) return null;
        const o = Object.assign({}, r);
        delete o.plan; delete o.vol_log; delete o.ex_first;   // las alarmas no lo usan
        return o;
    },
    async prune(env, routineId, dead) {
        const key = routineKey(env.__coach.coachId, routineId);
        const r = await kvGetRoutine(env, key);
        if (!r || !Array.isArray(dead) || !dead.length) return false;
        const left = (r.push_subs || []).filter((s) => !dead.includes(s.endpoint));
        if (left.length === (r.push_subs || []).length) return false;
        r.push_subs = left;
        await kvPut(env, key, r);
        return true;
    },
    async bind(env, code, rec, shareToken) {
        const ok = await bindCoachCode(env, code, rec, shareToken);
        return { ok, rec };
    },
    async seatsAdd(env, codes) {
        const key = `coachcfg:${env.__coach.coachId}`;
        const cfg = (await kvGet(env, key)) || {};
        cfg.seats = (Array.isArray(cfg.seats) ? cfg.seats : []).concat((codes || []).map((code) => ({ code })));
        await kvPut(env, key, cfg);
        return seatCounts(cfg);
    },
    async cfg(env) { return kvGet(env, `coachcfg:${env.__coach.coachId}`); },
    async digestPage(env, cursor, today, limit) {
        const pg = await env.__coach.listPage(cursor || '', Math.min(Number(limit) || DIGEST_PAGE, ROUTINES_LIST_MAX));
        const names = [];
        let count = 0;
        for (const r of pg.items) if (studentAlerts(r, today).length) { count++; names.push(r.alumno_name || '—'); }
        return { count, names: names.slice(0, 3), next: pg.next };
    },
    async digestPrune(env, dead) {
        const key = `coachcfg:${env.__coach.coachId}`;
        const cfg = await kvGet(env, key);
        if (!cfg || !cfg.digest || !Array.isArray(dead)) return false;
        cfg.digest.subs = (cfg.digest.subs || []).filter((s) => !dead.includes(s.endpoint));
        await kvPut(env, key, cfg);
        return true;
    }
};
function chkNextAt(r, now) {
    if ((r.profile && r.profile.guest) || closedAt(r.access_end_at, now)) return null;
    const c = chkRemindOf(r);
    if (c.mode === 'off' || !(r.push_subs || []).length || (r.profile && r.profile.status === 'finalizado')) return null;
    return nextLocalTime(now, c.dow, c.hour, validTz(r.push_tz) || DEFAULT_TZ);
}

// ── Notifier: un Durable Object por aviso (por nombre), con su alarma ──
// rest:{hash}   fin del descanso de un teléfono (una vez)
// chk:{token}   recordatorio semanal del control de un alumno
// digest:{coach} resumen diario del coach
// send:{id}     manda avisos con texto (cifrar acá: 30 s de CPU en vez de 10 ms)
// coach:{coachId} todo lo de un coach y sus alumnos (ver coach-store.js)
// counters      contadores pasajeros: cuota de IA, pruebas por red, "hoy ya entrené"
//
// La clase se llama Notifier por historia: es la única clase de Durable Object del Worker y
// no se agregan otras a propósito, porque una vuelta atrás no puede cruzar un cambio de clases.
export class Notifier {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; this._q = Promise.resolve(); }
    // Fila de espera del objeto: un pedido por vez, de punta a punta. Cubre también las
    // esperas a KV y a otros servicios (ahí el objeto, solo, dejaría entrar otro pedido en
    // el medio, entre leer y guardar).
    lock(fn) {
        const run = this._q.then(fn);
        this._q = run.then(() => { }, () => { });
        return run;
    }
    async fetch(req) {
        let body = {};
        try { body = await req.json(); } catch { /* vacío */ }
        const jsonResp = (o) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
        if (body && (body.op === 'c-http' || body.op === 'c-run')) {
            let out;
            try { out = await this.lock(() => coachOp(this.ctx.storage, this.env, body)); }
            catch (e) {
                console.error('[coach] pedido falló', body.op, body.path || body.fn, (e && e.message) || e);
                await noteKvLimit(this.env, (e && e.message) || e);   // ya fuera de la fila
                if (body.op === 'c-run') return jsonResp({ ok: false, error: String((e && e.message) || e) });
                return e instanceof PayloadTooLarge ? err('Payload too large', 413) : err(INTERNAL_ERR_MSG, 500);   // S-3: el detalle queda en el registro
            }
            // Avisos a otros objetos (recordatorio, resumen): después de soltar la fila, así
            // este objeto nunca espera a otro con la fila tomada.
            // callNotifier no tira error: devuelve { ok: false }. Un reintento y, si sigue fallando,
            // queda en el registro (antes se perdía sin rastro: auditoría D-2).
            for (const fx of out.after) {
                try {
                    let r = await fx();
                    if (r && r.ok === false) r = await fx();
                    if (r && r.ok === false) console.error('[coach] aviso posterior no quedó programado', r.error);
                } catch (e) { console.error('[coach] aviso posterior falló', (e && e.message) || e); }
            }
            // El espejo a KV falló adentro de la fila (el pedido salió bien): señal para el vigía.
            if (out.kvError) await noteKvLimit(this.env, out.kvError);
            return body.op === 'c-run' ? jsonResp({ ok: true, result: out.result === undefined ? null : out.result }) : out.resp;
        }
        const res = await this.lock(() => notifierOp(this.ctx.storage, this.env, body, Date.now()));
        // Una copia a KV que falló adentro de la fila (p. ej. push:all): señal para el vigía.
        if (res && res.kvError) await noteKvLimit(this.env, res.kvError);
        return jsonResp(res);
    }
    async alarm() {
        // Sin throw: una alarma que falla se reintenta sola y podría mandar el aviso dos veces.
        // Pero tampoco se puede quedar callada: si falló antes de programar la próxima, se
        // reintenta más tarde (auditoría 2026-11, D-1).
        await this.lock(async () => {
            try { await notifierAlarm(this.ctx.storage, this.env, Date.now()); }
            catch (e) {
                console.error('[notifier] alarma falló', (e && e.message) || e);
                try { await notifierAlarmRetry(this.ctx.storage, Date.now()); } catch { /* sin más salida */ }
            }
            try { await objectUpkeep(this.ctx.storage, this.env, Date.now()); }
            catch (e) { console.error('[notifier] mantenimiento falló', (e && e.message) || e); }
        });
    }
}
// Un pedido del coach adentro de su objeto: 'c-http' es un pedido de la API tal cual llegó
// al Worker; 'c-run' es una función suelta (COACH_FNS). Corre con la fila tomada. Si el
// código tira un error, no se guarda nada de lo que escribió.
async function coachOp(storage, env, b) {
    const coachId = String(b.coachId || '');
    if (!coachId) throw new Error('falta el coach');
    const store = new CoachStore(storage, env, coachId, new Map(Array.isArray(b.pre) ? [b.pre] : []));
    await store.open();
    const cenv = Object.create(env);
    cenv.BMOD_KV = coachKV(store);
    cenv.__coach = store;
    const out = { after: store.after };
    if (b.op === 'c-run') {
        const fn = Object.prototype.hasOwnProperty.call(COACH_FNS, b.fn) ? COACH_FNS[b.fn] : null;
        if (!fn) throw new Error('función desconocida');
        out.result = await fn(cenv, ...(Array.isArray(b.args) ? b.args : []));
    } else {
        const init = { method: b.method, headers: b.headers || {} };
        if (typeof b.body === 'string' && b.method !== 'GET' && b.method !== 'HEAD') init.body = b.body;
        const req = new Request('https://api.internal' + b.path + (b.search || ''), init);
        out.resp = (await coachRoutes(req, cenv, new URL(req.url), b.path, b.method)) || err('Not found', 404);
    }
    await store.commit();
    out.kvError = store.kvError || null;
    return out;
}
// Mantenimiento con la alarma del objeto: copias a KV que quedaron pendientes (objeto de un
// coach) y limpieza de contadores vencidos (objeto 'counters').
const COUNTER_PREFIXES = ['aiq:', 'tip:', 'tr:', 'xf:'];

// ═════════ Vigía (auditoría M-1) ═════════
// Lo que hoy fallaría en silencio deja una señal que ve /api/health/deep:
//   kv-limit  KV rechazó una operación por tope (429 / "Too Many Requests"): con el plan
//             gratis pasa al gastar las 1.000 escrituras del día, y entonces fallan
//             activaciones, pruebas y pagos hasta las 00:00 UTC.
// Una tarea de GitHub (.github/workflows/vigia.yml) consulta esa ruta cada 30 minutos y,
// si no da 200, GitHub le manda un mail al dueño del repo.
const HEALTH_FLAGS = ['kv-limit'];
const HEALTH_KV_WINDOW = 60 * 60000;   // la señal cuenta durante una hora
let kvLimitNotedAt = 0;                // por isolate: como mucho una señal por minuto
function isKvLimit(msg) { return /KV[^\n]{0,40}(429|too many requests)|too many requests[^\n]{0,40}KV/i.test(String(msg || '')); }
async function noteKvLimit(env, msg) {
    if (!isKvLimit(msg) || !env || !env.NOTIFIER) return;
    const now = Date.now();
    if (now - kvLimitNotedAt < 60000) return;
    kvLimitNotedAt = now;
    try { await callNotifier(env, 'counters', { op: 'flag-set', name: 'kv-limit', why: String(msg).slice(0, 160) }); } catch { /* el registro ya lo tiene */ }
}
// GET /api/health/deep — para el vigía. 200 si todo anda; 503 (con el detalle) si no.
async function healthDeep(env) {
    const now = Date.now();
    const checks = {};
    try { await env.BMOD_KV.get('health:probe'); checks.kv_reads = true; } catch { checks.kv_reads = false; }
    const f = env.NOTIFIER ? await callNotifier(env, 'counters', { op: 'flag-get' }) : { ok: false };
    checks.durable_objects = !!(f && f.ok);
    const kv = f && f.ok && f.flags && f.flags['kv-limit'];
    checks.kv_limit_at = kv ? new Date(kv.at).toISOString() : null;
    checks.kv_writes = !(kv && now - kv.at < HEALTH_KV_WINDOW);
    const ok = checks.kv_reads && checks.durable_objects && checks.kv_writes;
    return json({ ok, service: 'berserkermod-api', checks }, ok ? 200 : 503);
}
async function objectUpkeep(storage, env, now) {
    const who = await storage.get(['coach', 'ctr']);
    if (who.get('coach')) {
        const store = new CoachStore(storage, env, who.get('coach'));
        await store.open(now);
    }
    if (who.get('ctr')) {
        for (const prefix of COUNTER_PREFIXES) {
            const rows = await storage.list({ prefix, limit: 500 });
            const dead = [...rows].filter((x) => !(x[1] && x[1].exp > now)).map((x) => x[0]);
            for (let i = 0; i < dead.length; i += 100) await storage.delete(dead.slice(i, i + 100));
        }
        if (!(await storage.getAlarm())) await storage.setAlarm(now + 86400000);
    }
}
// Lo que los pedidos del coach le avisan a otros objetos (recordatorio y resumen). Adentro
// del objeto del coach no se llama en el momento: queda para después de soltar la fila.
const DEFERRED_OPS = ['chk-set', 'digest-set', 'off'];
// Reintento de una alarma que falló: 15 min, 30, 1 h, 2 h… hasta 6 h entre intentos, sin
// rendirse. Solo si la falla fue ANTES de dejar programada la próxima (notifierAlarm la
// programa apenas manda el aviso), así un error después de mandar no lo duplica. El fin del
// descanso no se reintenta: ya pasó.
async function notifierAlarmRetry(storage, now) {
    const job = await storage.get('job');
    if (!job || job.kind === 'rest') return null;
    if (await storage.getAlarm()) return null;
    const fails = (Number(job.fails) || 0) + 1;
    const at = now + Math.min(15 * 60000 * 2 ** Math.min(fails - 1, 10), 6 * 3600000);
    await storage.put('job', Object.assign({}, job, { fails }));
    await storage.setAlarm(at);
    return at;
}
async function callNotifier(env, name, body) {
    if (!env.NOTIFIER) return { ok: false, error: 'sin notifier' };
    if (env.__coach && body && DEFERRED_OPS.includes(body.op)) {
        const real = Object.getPrototypeOf(env);
        env.__coach.after.push(() => callNotifier(real, name, body));
        return { ok: true, next: body.at || null };
    }
    try {
        const stub = env.NOTIFIER.get(env.NOTIFIER.idFromName(name));
        const resp = await stub.fetch('https://notifier/op', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return await resp.json();
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
async function notifierOp(storage, env, b, now) {
    switch (b && b.op) {
        case 'send': {
            const subs = (Array.isArray(b.subs) ? b.subs : []).map(cleanSub).filter(Boolean).slice(0, 5);
            return Object.assign({ ok: true }, await pushMany(env, subs, b.payload || null, { ttl: b.ttl, urgency: b.urgency }));
        }
        case 'rest': {
            const sub = cleanSub(b.sub);
            const at = Number(b.at);
            if (!sub || !(at >= now + 3000 && at <= now + 15 * 60000)) return { ok: false, error: 'invalid' };
            await storage.put('job', { kind: 'rest', sub, at, lang: PUSH_MSG[b.lang] ? b.lang : 'es' });
            await storage.setAlarm(at);
            return { ok: true, at };
        }
        case 'chk-sync': {
            const got = await loadShareRoutine(env, String(b.token || ''));
            const at = got ? chkNextAt(got.r, now) : null;
            if (!at) { await storage.delete('job'); await storage.deleteAlarm(); return { ok: true, next: null }; }
            await storage.put('job', { kind: 'chk', token: String(b.token) });
            await storage.setAlarm(at);
            return { ok: true, next: at };
        }
        // Igual que chk-sync y digest-sync, pero el horario ya viene calculado por quien
        // acaba de guardar el dato (no hay que volver a leerlo).
        case 'chk-set': {
            const at = Number(b.at) || 0;
            if (!(at > now)) { await storage.delete('job'); await storage.deleteAlarm(); return { ok: true, next: null }; }
            await storage.put('job', { kind: 'chk', token: String(b.token) });
            await storage.setAlarm(at);
            return { ok: true, next: at };
        }
        case 'digest-set': {
            const at = Number(b.at) || 0;
            const coachId = String(b.coachId || '');
            if (!(at > now) || !validPanelId(coachId)) { await storage.delete('job'); await storage.deleteAlarm(); return { ok: true, next: null }; }
            await storage.put('job', { kind: 'digest', coachId });
            await storage.setAlarm(at);
            return { ok: true, next: at };
        }
        // ── Contadores pasajeros (un solo objeto: 'counters') ──
        // Sumar uno si no se llegó al tope. Cuenta bien aunque lleguen muchos a la vez.
        case 'ctr-hit': {
            const key = String(b.key || ''), field = String(b.field || 'n');
            const max = Number(b.max) || 0, ttl = Number(b.ttl) || 86400;
            if (!COUNTER_PREFIXES.some((p) => key.startsWith(p)) || key.length > 200) return { ok: false, error: 'invalid' };
            await counterInit(storage, now);
            let rec = await storage.get(key);
            if (rec && !(rec.exp > now)) rec = null;
            const f = rec ? Object.assign({}, rec.f) : {};
            const n = rec ? (Number(f[field]) || 0) : Math.max(0, Number(b.seed) || 0);   // seed: lo que había en el contador viejo de KV
            if (n >= max) return { ok: true, allowed: false, n };
            f[field] = n + 1;
            await storage.put(key, { f, exp: rec ? rec.exp : now + ttl * 1000 });
            return { ok: true, allowed: true, n: n + 1 };
        }
        // Devolver un uso (la IA falló o no sirvió: auditoría L-5).
        case 'ctr-undo': {
            const key = String(b.key || ''), field = String(b.field || 'n');
            if (!COUNTER_PREFIXES.some((p) => key.startsWith(p)) || key.length > 200) return { ok: false, error: 'invalid' };
            const rec = await storage.get(key);
            if (!rec || !(rec.exp > now)) return { ok: true, n: 0 };
            const f = Object.assign({}, rec.f);
            f[field] = Math.max(0, (Number(f[field]) || 0) - 1);
            await storage.put(key, { f, exp: rec.exp });
            return { ok: true, n: f[field] };
        }
        // "Hoy ya entrené": una marca por suscripción, que vence sola.
        case 'tr-set': {
            const id = String(b.id || '');
            if (!/^[a-f0-9]{16,64}$/.test(id) || typeof b.d !== 'string') return { ok: false, error: 'invalid' };
            await counterInit(storage, now);
            await storage.put('tr:' + id, { d: b.d.slice(0, 10), exp: now + (Number(b.ttl) || 3 * 86400) * 1000 });
            return { ok: true };
        }
        case 'tr-list': {
            const since = await counterInit(storage, now);
            const marks = {};
            let startAfter;
            for (let page = 0; page < 5; page++) {   // hasta 5.000 marcas (el tope de suscripciones es 1.000)
                const rows = [...(await storage.list(startAfter ? { prefix: 'tr:', limit: 1000, startAfter } : { prefix: 'tr:', limit: 1000 }))];
                for (const [k, v] of rows) if (v && v.exp > now) marks[k.slice(3)] = v.d;
                if (rows.length < 1000) break;
                startAfter = rows[rows.length - 1][0];
            }
            return { ok: true, marks, since };
        }
        // ── Acknowledge de Google Play pendiente (un objeto por compra: 'playack:{huella}') ──
        // Lo reintenta la alarma hasta que Google lo acepte o pasen los 3 días (auditoría P-8).
        case 'play-ack': {
            const pt = String(b.pt || ''), sku = String(b.sku || '');
            if (!pt || pt.length > 1024 || !PLAY_SKUS.includes(sku)) return { ok: false, error: 'invalid' };
            const prev = await storage.get('job');
            if (prev && prev.kind === 'play-ack') return { ok: true, already: true };
            await storage.put('job', { kind: 'play-ack', pt, sku, until: Math.min(Number(b.until) || 0, now + PLAY_ACK_WINDOW_MS) });
            await storage.setAlarm(now + 5 * 60000);
            return { ok: true };
        }
        // ── Señales para el vigía (objeto 'counters') ──
        // Se escriben solo cuando algo falla (nunca en un pedido normal) y las lee
        // /api/health/deep, que consulta una tarea de GitHub cada 30 minutos (auditoría M-1).
        case 'flag-set': {
            const name = String(b.name || '');
            if (!HEALTH_FLAGS.includes(name)) return { ok: false, error: 'invalid' };
            const prev = await storage.get('flag:' + name);
            await storage.put('flag:' + name, { at: now, n: ((prev && prev.n) || 0) + 1, why: String(b.why || '').slice(0, 160) });
            return { ok: true };
        }
        case 'flag-get': {
            const flags = {};
            for (const name of HEALTH_FLAGS) { const v = await storage.get('flag:' + name); if (v) flags[name] = v; }
            return { ok: true, flags };
        }
        case 'digest-sync': {
            const coachId = String(b.coachId || '');
            const cfg = validPanelId(coachId) ? await coachCfgOf(env, coachId) : null;
            const dg = cfg && cfg.digest;
            if (!dg || !dg.on || !(dg.subs || []).length) { await storage.delete('job'); await storage.deleteAlarm(); return { ok: true, next: null }; }
            const at = nextLocalTime(now, null, dg.hour, validTz(dg.tz) || DEFAULT_TZ);
            await storage.put('job', { kind: 'digest', coachId });
            await storage.setAlarm(at);
            return { ok: true, next: at };
        }
        case 'off':
            await storage.delete('job');
            await storage.deleteAlarm();
            return { ok: true };
        // ── Un pago de Mercado Pago = un código (un objeto por pago: 'pay:{id}') ──
        // El Durable Object atiende de a un pedido por vez y su almacenamiento es consistente:
        // si llegan dos avisos del mismo pago a la vez, el segundo recibe el código del primero.
        case 'pay-claim': {
            const cur = await storage.get('pay');
            if (cur) return { ok: true, code: cur.code, done: !!cur.done };
            const code = String(b.code || '');
            if (!/^BMOD-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return { ok: false, error: 'invalid' };
            await storage.put('pay', { code, done: false, at: now });
            return { ok: true, code, done: false };
        }
        // ── Primera activación de un código (un objeto por código: 'act:{código}'; auditoría K-2) ──
        case 'act-claim': {
            const deviceId = String(b.deviceId || '').slice(0, 80);
            if (!deviceId) return { ok: false, error: 'invalid' };
            const panel = validPanelId(b.panel);
            let cur = await storage.get('act');
            if (!cur) { cur = { deviceId, panel: panel || null, at: now }; await storage.put('act', cur); }
            else if (!cur.panel && panel) { cur = Object.assign({}, cur, { panel }); await storage.put('act', cur); }
            return { ok: true, deviceId: cur.deviceId, panel: cur.panel, at: cur.at };
        }
        case 'pay-get': {
            const cur = await storage.get('pay');
            return { ok: true, code: cur ? cur.code : null };
        }
        // ── Suscripciones al recordatorio diario (un solo objeto: 'pushsubs'; auditoría K-6) ──
        case 'ps-put': case 'ps-del': case 'ps-due': case 'ps-mark':
            return await pushSubsOp(storage, env, b, now);
        case 'pay-done': {
            const cur = await storage.get('pay');
            if (cur && !cur.done) await storage.put('pay', Object.assign({}, cur, { done: true }));
            return { ok: true };
        }
        // ── Cupo de testers (un solo objeto: 'testers') ──
        // Antes el tope vivía en KV: con pedidos simultáneos se salteaba. Acá cuenta bien.
        case 'tester-slot': {
            const max = Number(b.max) || 0, ipMax = Number(b.ipMax) || 0;
            const deviceId = String(b.deviceId || '').slice(0, 80);
            if (!deviceId) return { ok: false, error: 'invalid' };
            let n = await storage.get('n');
            if (typeof n !== 'number') n = Math.max(0, Number(b.seed) || 0);   // arranca desde el contador viejo de KV
            const devKey = 'dev:' + deviceId;
            const prevDev = await storage.get(devKey);
            if (prevDev) {
                // Ya tiene lugar: si fue hace un momento, es el mismo reclamo repetido; si fue
                // hace más, el intento anterior falló antes de guardarse y puede seguir sin contar de nuevo.
                if (now - prevDev < 120000) return { ok: false, error: 'busy' };
                await storage.put(devKey, now);
                return { ok: true, n, again: true };
            }
            if (n >= max) return { ok: false, error: 'full', n };
            const ipKey = typeof b.ipKey === 'string' && b.ipKey ? 'ip:' + b.ipKey.slice(0, 80) : null;
            if (ipKey) {
                let ipRec = await storage.get(ipKey);
                if (ipRec && !(ipRec.exp > now)) ipRec = null;
                if (ipRec && ipRec.n >= ipMax) return { ok: false, error: 'ip' };
                await storage.put(ipKey, { n: (ipRec ? ipRec.n : 0) + 1, exp: ipRec ? ipRec.exp : now + (Number(b.ipTtl) || 0) * 1000 });
            }
            await storage.put(devKey, now);
            await storage.put('n', n + 1);
            return { ok: true, n: n + 1 };
        }
        case 'tester-count': {
            const n = await storage.get('n');
            return { ok: true, n: typeof n === 'number' ? n : null };
        }
        default:
            return { ok: false, error: 'op' };
    }
}
// Primera vez que se usa el objeto de contadores: se anota desde cuándo (las marcas viejas de
// KV se siguen mirando unos días) y se programa la limpieza diaria.
async function counterInit(storage, now) {
    let since = await storage.get('ctr');
    if (!since) {
        since = now;
        await storage.put('ctr', since);
        if (!(await storage.getAlarm())) await storage.setAlarm(now + 86400000);
    }
    return since;
}
const DIGEST_PAGE = 40;   // alumnos por corrida del resumen (list + 40 gets + avisos < 50 subrequests)
async function notifierAlarm(storage, env, now) {
    const job = await storage.get('job');
    if (!job) return { none: true };
    if (job.kind === 'play-ack') {
        // Si falla tira error: Notifier.alarm lo reintenta (15 min, 30, 1 h… hasta cada 6 h).
        if (now > job.until) {
            await storage.delete('job');
            console.error('[play] no se pudo confirmar la compra en los 3 días: Google la reembolsa', job.sku);
            return { kind: 'play-ack', gaveUp: true };
        }
        const got = await playFetchSub(env, job.pt);
        if (got.status === 'gone') { await storage.delete('job'); return { kind: 'play-ack', gone: true }; }
        if (got.status !== 'ok') throw new Error('play-ack: Google no respondió (' + got.code + ')');
        const ent = playEntitlement(got.sub, now);
        if (!ent.ackPending) { await storage.delete('job'); return { kind: 'play-ack', done: true }; }
        if (!(await playAck(env, job.pt, ent.sku || job.sku))) throw new Error('play-ack: Google rechazó el acknowledge');
        await storage.delete('job');
        return { kind: 'play-ack', acked: true };
    }
    if (job.kind === 'rest') {
        await storage.delete('job');
        const res = await pushMany(env, [job.sub], { title: 'BERSERKERMOD', body: pushText(job.lang, 'rest'), tag: 'bm-rest', url: './BERSERKERMOD.html' }, { ttl: 120, urgency: 'high' });
        return { kind: 'rest', sent: res.sent };
    }
    if (job.kind === 'chk') {
        const got = await loadShareRoutine(env, job.token);
        if (!got) { await storage.delete('job'); return { kind: 'chk', gone: true }; }
        const { idx, r } = got;
        const tz = validTz(r.push_tz) || DEFAULT_TZ;
        const week = isoWeek(localParts(tz, new Date(now)).date);
        const done = !!r.last_checkin_at && isoWeek(localParts(tz, new Date(r.last_checkin_at)).date) === week;
        const paused = !!(r.profile && r.profile.status === 'pausado');
        let sent = 0, dead = [];
        if (!done && !paused && (r.push_subs || []).length) {
            const lang = r.push_lang || 'es';
            const res = await pushMany(env, r.push_subs, { title: 'BERSERKERMOD', body: pushText(lang, 'chk', { coach: r.coach_name || pushText(lang, 'coach') }), tag: 'bm-coach-chk', url: './BERSERKERMOD.html?r=' + r.share_token }, { ttl: 43200 });
            sent = res.sent;
            if (res.dead.length) {
                dead = res.dead;
                r.push_subs = r.push_subs.filter((s) => !dead.includes(s.endpoint));   // para calcular la próxima alarma
            }
        }
        // Primero la próxima alarma (así, si después falla la limpieza, no se reintenta ni se duplica).
        const at = chkNextAt(r, now);
        if (at) {
            await storage.setAlarm(at);
            if (job.fails) await storage.put('job', { kind: 'chk', token: job.token });
        } else await storage.delete('job');
        if (dead.length) await pruneStudentSubs(env, idx, r, dead);
        return { kind: 'chk', sent, skipped: done || paused, next: at };
    }
    if (job.kind === 'digest') {
        const cfg = await coachCfgOf(env, job.coachId);
        const dg = cfg && cfg.digest;
        if (!dg || !dg.on || !(dg.subs || []).length) { await storage.delete('job'); return { kind: 'digest', off: true }; }
        const tz = validTz(dg.tz) || DEFAULT_TZ;
        const today = localParts(tz, new Date(now)).date;
        const pg = await digestPage(env, job.coachId, job.cursor, today);
        const names = (job.names || []).concat(pg.names || []).slice(0, 3);
        const count = (job.count || 0) + (pg.count || 0);
        if (pg.next) {   // más de 40 alumnos: sigue en 2 segundos con la página que viene
            await storage.put('job', { kind: 'digest', coachId: job.coachId, cursor: pg.next, names, count });
            await storage.setAlarm(now + 2000);
            return { kind: 'digest', partial: true };
        }
        let sent = 0, dead = [];
        if (count) {
            const lang = dg.lang || 'es';
            const list = names.join(', ') + (count > names.length ? pushText(lang, 'more', { n: count - names.length }) : '');
            const r2 = await pushMany(env, dg.subs, { title: 'BERSERKERMOD', body: pushText(lang, 'digest', { names: list }), tag: 'bm-coach-digest', url: './BERSERKERMOD.html' }, { ttl: 43200 });
            sent = r2.sent;
            dead = r2.dead;
        }
        // Primero la próxima alarma (así, si después falla la limpieza, no se reintenta ni se duplica).
        await storage.put('job', { kind: 'digest', coachId: job.coachId });
        await storage.setAlarm(nextLocalTime(now, null, dg.hour, tz));
        if (dead.length) await pruneDigestSubs(env, job.coachId, cfg, dead);
        return { kind: 'digest', sent, count };
    }
    await storage.delete('job');
    return { unknown: true };
}
// Aviso con texto a un alumno (todos sus teléfonos con avisos activos).
async function notifyStudent(env, r, kind, vars, persist) {
    const subs = Array.isArray(r.push_subs) ? r.push_subs : [];
    if (!subs.length) return { sent: 0, no_subs: true };
    const lang = r.push_lang || 'es';
    const payload = { title: 'BERSERKERMOD', body: pushText(lang, kind, Object.assign({ coach: r.coach_name || pushText(lang, 'coach') }, vars || {})), tag: 'bm-coach-' + kind, url: './BERSERKERMOD.html?r=' + r.share_token };
    const res = await callNotifier(env, 'send:' + r.id, { op: 'send', subs, payload, ttl: kind === 'remind' ? 43200 : 86400 });
    if (res && Array.isArray(res.dead) && res.dead.length) {
        r.push_subs = subs.filter((s) => !res.dead.includes(s.endpoint));
        if (persist) await kvPut(env, routineKey(r.coach_id, r.id), r);
    }
    return { sent: (res && res.sent) || 0, no_subs: !(r.push_subs || []).length };
}
// POST /api/push/rest — fin del descanso aunque la app esté cerrada (o cancelarlo al volver)
async function pushRest(req, env) {
    const body = (await readBody(req)) || {};
    const sub = cleanSub(body.subscription);
    if (!sub) return err('Suscripción inválida', 400);
    const name = 'rest:' + await sha256hex(sub.endpoint);
    const res = body.cancel ? await callNotifier(env, name, { op: 'off' }) : await callNotifier(env, name, { op: 'rest', sub, at: Number(body.at), lang: body.lang });
    if (res && res.error === 'invalid') return err('Horario inválido', 400);
    if (!res || !res.ok) return err('No se pudo programar el aviso', 503);
    return json({ ok: true });
}
// POST /api/shares/{token}/push — el alumno activa (o apaga con off) los avisos de su coach
async function postSharePush(req, env, token) {
    const got = await loadShareRoutine(env, token);
    if (!got) return err('Routine not found', 404);
    const { idx, r } = got;
    const body = (await readBody(req)) || {};
    if (!body.off && closedAt(idx.until)) return closedErr();
    const subs = Array.isArray(r.push_subs) ? r.push_subs : [];
    if (body.off) {
        r.push_subs = subs.filter((s) => s.endpoint !== body.endpoint);
    } else {
        const sub = cleanSub(body.subscription);
        if (!sub) return err('Suscripción inválida', 400);
        r.push_subs = [sub].concat(subs.filter((s) => s.endpoint !== sub.endpoint)).slice(0, 3);
        r.push_lang = PUSH_MSG[body.lang] ? body.lang : (r.push_lang || 'es');
        r.push_tz = validTz(body.tz) || r.push_tz || null;
    }
    await kvPut(env, routineKey(idx.coachId, idx.routineId), r);
    // El horario se calcula acá, con el registro recién guardado (antes el objeto del aviso
    // lo volvía a leer de KV, que puede devolver una copia vieja).
    const op = { op: 'chk-set', token, at: chkNextAt(r, Date.now()) };
    let sync = await callNotifier(env, 'chk:' + token, op);
    if (!sync || sync.ok === false) sync = await callNotifier(env, 'chk:' + token, op);   // D-2: un reintento
    if (!sync || sync.ok === false) console.error('[avisos] el recordatorio del control no quedó programado', token, sync && sync.error);
    return json({ ok: true, on: r.push_subs.length > 0, next: (sync && sync.ok !== false && sync.next) || null, chk_remind: chkRemindOf(r) });
}
// POST /api/routines/{id}/remind — el coach le recuerda el control al alumno ahora
async function remindRoutine(req, env, url, id) {
    const body = await readBody(req);
    const coachId = coachIdFrom(req, url, body);
    if (!coachId) return err('Missing coach_id', 401);
    const r = await kvGetRoutine(env, routineKey(coachId, id));
    if (!r) return err('Not found', 404);
    if (r.coach_id !== coachId) return err('Forbidden', 403);
    if (closedAt(r.access_end_at)) return err('El acceso de este alumno ya terminó', 409);
    if (!(r.push_subs || []).length) return json({ ok: true, sent: 0, no_subs: true });
    if (r.remind_at && Date.now() - Date.parse(r.remind_at) < 12 * 3600000) return err('Ya le mandaste un recordatorio hace menos de 12 horas', 429);
    const res = await notifyStudent(env, r, 'remind', {}, false);
    if (res.sent > 0) r.remind_at = nowISO();
    await kvPut(env, routineKey(coachId, id), r);
    return json({ ok: true, sent: res.sent, no_subs: res.no_subs });
}
Notifier._test = { encryptPushPayload, nextLocalTime, notifierAlarm, notifierAlarmRetry, notifierOp, localParts, isKvLimit, resetKvNote: () => { kvLimitNotedAt = 0; } };

async function pushSubscribe(req, env) {
    const body = await readBody(req);
    const sub = body && body.subscription;
    if (!sub || typeof sub.endpoint !== 'string' || sub.endpoint.length > 1024) return err('Missing subscription', 400);
    if (!pushHostAllowed(sub.endpoint)) return err('Servicio de notificaciones no soportado', 400);
    const id = await sha256hex(sub.endpoint);
    if (doData(env)) {
        // En el objeto 'pushsubs' (auditoría K-6): el cron ya no puede pisar esta alta.
        const r = await callNotifier(env, 'pushsubs', { op: 'ps-put', id, endpoint: sub.endpoint, lang: body.lang, tz: body.tz });
        if (r && r.ok) return json({ ok: true });
        if (r && r.error === 'full') return err('Cupo de recordatorios completo', 409);
        console.error('[avisos] no se guardó la suscripción', r && r.error);
        return err('No se pudo guardar. Probá de nuevo.', 503);
    }
    const all = (await kvGet(env, 'push:all')) || { subs: {} };
    if (!all.subs[id] && Object.keys(all.subs).length >= PUSH_MAX) return err('Cupo de recordatorios completo', 409);
    const prev = all.subs[id] || {};
    all.subs[id] = {
        endpoint: sub.endpoint,
        lang: (body.lang === 'en' || body.lang === 'pt') ? body.lang : 'es',
        tz: validTz(body.tz) || prev.tz || null,
        sent: prev.sent || null,                        // re-suscribirse no repite el aviso del día
        created_at: prev.created_at || nowISO()
    };
    await kvPut(env, 'push:all', all);
    return json({ ok: true });
}

// POST /api/push/trained — la app avisa que hoy (día local) ya entrenó: ese día
// no se le manda el recordatorio. Va en una key chica por suscripción que vence
// sola (no toca push:all, así no compite con el cron); el cron las lee todas con
// un solo list (la fecha viaja en la metadata).
async function pushTrained(req, env) {
    const body = await readBody(req);
    const endpoint = body && body.endpoint;
    if (!endpoint || typeof endpoint !== 'string' || endpoint.length > 1024 || !pushHostAllowed(endpoint)) return err('Missing endpoint', 400);
    if (!validSessionDate(body.date)) return err('Fecha inválida', 400);
    const id = await sha256hex(endpoint);
    if (doData(env)) {
        const res = await callNotifier(env, 'counters', { op: 'tr-set', id, d: body.date, ttl: TRAINED_TTL });
        if (!res || !res.ok) { console.error('[contadores] no se guardó "hoy ya entrené"', res && res.error); return err('No se pudo guardar. Probá de nuevo.', 503); }
        return json({ ok: true });
    }
    await env.BMOD_KV.put('pushtr:' + id, '1', { metadata: { d: body.date }, expirationTtl: TRAINED_TTL });
    return json({ ok: true });
}

async function pushUnsubscribe(req, env) {
    const body = await readBody(req);
    const endpoint = body && body.endpoint;
    if (!endpoint || typeof endpoint !== 'string' || endpoint.length > 1024) return err('Missing endpoint', 400);
    const id = await sha256hex(endpoint);
    if (doData(env)) {
        const r = await callNotifier(env, 'pushsubs', { op: 'ps-del', id });
        if (r && r.ok) return json({ ok: true });
        console.error('[avisos] no se borró la suscripción', r && r.error);
        return err('No se pudo guardar. Probá de nuevo.', 503);
    }
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

    // tope global (lectura rápida en KV; el que decide de verdad es el Durable Object)
    const max = parseInt(env.TESTERS_CLAIM_MAX, 10) || TESTERS_CLAIM_MAX_DEFAULT;
    const counter = (await kvGet(env, 'testers:count')) || { n: 0 };
    if (counter.n >= max) return err('Cupo de testers completo', 409);

    // tope blando por IP (hash, no se guarda la IP)
    const ip = req.headers.get('CF-Connecting-IP') || '';
    const ipH = ip ? await ipHash(ip) : null;
    let n;
    if (env.NOTIFIER) {
        // Tope global, por red y por teléfono en un solo lugar consistente: con pedidos
        // simultáneos ya no se pasa del cupo (auditoría 2026-11, K-3).
        const slot = await callNotifier(env, 'testers', { op: 'tester-slot', deviceId, ipKey: ipH, max, ipMax: TESTERS_IP_MAX, ipTtl: TESTERS_IP_TTL, seed: counter.n });
        if (!slot || !slot.ok) {
            const why = slot && slot.error;
            if (why === 'full') return err('Cupo de testers completo', 409);
            if (why === 'ip') return err('Demasiados reclamos desde esta red', 429);
            if (why === 'busy') return err('Ya estamos procesando tu reclamo. Probá de nuevo en un minuto.', 429);
            console.error('[testers] cupo no disponible', why);
            return err('No se pudo reclamar ahora', 503);
        }
        n = slot.n;
    } else {
        if (ipH) {
            const ipKey = 'tester-ip:' + ipH;
            const ipRec = (await kvGet(env, ipKey)) || { n: 0 };
            if (ipRec.n >= TESTERS_IP_MAX) return err('Demasiados reclamos desde esta red', 429);
            await kvPut(env, ipKey, { n: ipRec.n + 1 }, { expirationTtl: TESTERS_IP_TTL });
        }
        n = counter.n + 1;
    }

    let code = newCode();
    while (await kvGet(env, `code:${code}`)) code = newCode();
    const rec = {
        product: 'premium', duration_days: null, used: true, deviceId, expires_at: null,
        created_at: nowISO(), activated_at: nowISO(), source: 'tester-auto'
    };
    await kvPut(env, `code:${code}`, rec);
    await kvPut(env, `tester:${deviceId}`, { code, claimed_at: rec.created_at });
    await kvPut(env, 'testers:count', { n });
    track(env, req, 'tester_claim', 'premium', { s: surfaceOf(body) });
    return issue(code, rec);
}

// admin: cuántos testers reclamaron (para cruzar con el panel de Play)
async function adminTesters(req, env) {
    if (!env.ADMIN_SECRET || req.headers.get('x-admin-secret') !== env.ADMIN_SECRET) return err('Unauthorized', 401);
    const counter = (await kvGet(env, 'testers:count')) || { n: 0 };
    // El número que vale es el del Durable Object (la copia en KV puede quedar uno abajo
    // si dos reclamos terminan a la vez).
    let count = counter.n;
    if (env.NOTIFIER) {
        const c = await callNotifier(env, 'testers', { op: 'tester-count' });
        if (c && c.ok && typeof c.n === 'number') count = c.n;
    }
    const claims = await listByPrefix(env, 'tester:');
    return json({ ok: true, count, open: String(env.TESTERS_CLAIM_OPEN || '') === 'true', claims });
}

// ─────────────────────────────────────────────
// GOOGLE PLAY BILLING — suscripción Premium comprada DENTRO de la TWA.
// El cliente manda {sku, purchaseToken, deviceId}; acá se verifica contra la
// API de Google Play (service account, JWT RS256, API subscriptionsv2), se hace
// acknowledge (sin eso Google devuelve la plata a los 3 días) y se emite una
// licencia normal con exp = fin del período. La renovación es transparente:
// Google renueva, el cliente re-verifica al abrir y recibe el exp nuevo.
// Secrets/vars: PLAY_SA_JSON (service account, secret) + PLAY_PACKAGE (var).
//
// Auditoría 2026-11 (tanda 3):
//   P-6  Una compra sirve en hasta 2 teléfonos a la vez (celular + tablet de la misma
//        cuenta de Google). Un teléfono nuevo reemplaza al que hace más que no se usa,
//        hasta PLAY_MOVES_MAX cambios (como un código). Registro: play:{huella del token}.
//   P-7  La revisión semanal de la app (/api/license/verify) le vuelve a preguntar a
//        Google cada PLAY_RECHECK_MS: un reembolso o una suscripción suspendida corta
//        el Premium en la semana, no al fin del período.
//   P-8  Si el acknowledge falla, el objeto 'playack:{huella}' lo reintenta solo durante
//        los 3 días que da Google (15 min, 30, 1 h… hasta cada 6 h).
//   P-9  Se usa purchases.subscriptionsv2 (la API vieja de suscripciones está en retiro).
// ─────────────────────────────────────────────
const PLAY_SKUS = ['premium_1m', 'premium_3m', 'premium_6m', 'premium_12m'];
const PLAY_DEVICES_MAX = 2;
const PLAY_MOVES_MAX = 10;
const PLAY_RECHECK_MS = 6 * 86400000;
const PLAY_ACK_WINDOW_MS = 3 * 86400000;
// Con acceso hasta lineItems[].expiryTime: activa, en período de gracia o cancelada (sigue
// hasta el fin de lo pagado). Suspendida, pausada, vencida o pendiente de pago: sin acceso.
const PLAY_OK_STATES = ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_CANCELED'];

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
function playBase(env) {
    return 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' + encodeURIComponent(env.PLAY_PACKAGE) + '/purchases/';
}
// Huella del token de compra (para el registro play:{…}; el token no se guarda en KV).
async function playHash(purchaseToken) {
    const d = await crypto.subtle.digest('SHA-256', enc.encode('play:' + purchaseToken));
    return b64urlFromBytes(new Uint8Array(d)).slice(0, 32);
}
// Consulta la suscripción a Google: { status: 'ok', sub } | { status: 'gone' } | { status: 'error', code }.
async function playFetchSub(env, purchaseToken) {
    let access;
    try { access = await playAccessToken(env); } catch { return { status: 'error', code: 'oauth' }; }
    let r;
    try { r = await fetch(playBase(env) + 'subscriptionsv2/tokens/' + encodeURIComponent(purchaseToken), { headers: { Authorization: 'Bearer ' + access } }); }
    catch { return { status: 'error', code: 'fetch' }; }
    if (r.status === 404 || r.status === 400 || r.status === 410) return { status: 'gone' };
    if (!r.ok) return { status: 'error', code: r.status };
    return { status: 'ok', sub: await r.json() };
}
// Qué dice Google de esa suscripción: si da acceso, hasta cuándo y de qué plan.
function playEntitlement(sub, now) {
    const items = Array.isArray(sub && sub.lineItems) ? sub.lineItems : [];
    const li = items.find((x) => x && PLAY_SKUS.includes(x.productId)) || null;
    const expMs = li && li.expiryTime ? Date.parse(li.expiryTime) || 0 : 0;
    const state = String((sub && sub.subscriptionState) || '');
    return {
        ok: !!li && PLAY_OK_STATES.includes(state) && expMs > now,
        expMs, sku: li ? li.productId : null, state,
        pending: state === 'SUBSCRIPTION_STATE_PENDING',
        ackPending: (sub && sub.acknowledgementState) === 'ACKNOWLEDGEMENT_STATE_PENDING'
    };
}
async function playAck(env, purchaseToken, sku) {
    try {
        const access = await playAccessToken(env);
        const r = await fetch(playBase(env) + 'subscriptions/' + encodeURIComponent(sku) + '/tokens/' + encodeURIComponent(purchaseToken) + ':acknowledge', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
            body: '{}'
        });
        return r.ok;
    } catch { return false; }
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
    if (purchaseToken.length > 1024 || deviceId.length > 80) return err('Datos inválidos', 400);

    const got = await playFetchSub(env, purchaseToken);
    if (got.status === 'gone') return err('Compra no encontrada', 404);
    if (got.status !== 'ok') return got.code === 'oauth' ? err('No se pudo autenticar con Google Play', 502) : err('Error consultando Google Play', 502);
    const now = Date.now();
    const ent = playEntitlement(got.sub, now);
    if (ent.pending) return err('Pago pendiente', 403);
    if (!ent.ok) return err('Suscripción vencida', 403);

    // P-6: la compra queda atada a este teléfono (hasta 2 a la vez)
    const ph = await playHash(purchaseToken);
    let rec = null;
    try { rec = await kvGet(env, `play:${ph}`); } catch (e) { console.error('[play] no se pudo leer el registro', String((e && e.message) || e).slice(0, 160)); }
    const devices = rec && Array.isArray(rec.devices) ? rec.devices.slice() : [];
    let changed = !rec;
    if (!devices.some((d) => d.id === deviceId)) {
        let moves = (rec && rec.moves) || 0;
        if (devices.length >= PLAY_DEVICES_MAX) {
            if (moves >= PLAY_MOVES_MAX) return err('Esta compra ya se usó en demasiados teléfonos. Escribinos y lo resolvemos.', 409);
            devices.sort((a, b) => (a.at < b.at ? -1 : 1)).shift();   // sale el que hace más que no se usa
            moves++;
        }
        devices.push({ id: deviceId, at: nowISO() });
        rec = Object.assign({ first_at: nowISO() }, rec || {}, { devices, moves });
        changed = true;
    }
    if (rec.ended) { delete rec.ended; changed = true; }   // Google la vuelve a dar por activa
    if (changed) {
        rec.sku = ent.sku; rec.checked_at = nowISO();
        if (got.sub.testPurchase) rec.test = true;
        // El registro es para frenar el abuso: si KV falla, la compra legítima sigue igual.
        try { await kvPut(env, `play:${ph}`, rec); } catch (e) { console.error('[play] no se pudo guardar el registro', String((e && e.message) || e).slice(0, 160)); }
    }

    // P-8: acknowledge; si falla, lo reintenta el servidor solo (Google da 3 días)
    if (ent.ackPending && !(await playAck(env, purchaseToken, ent.sku))) {
        console.error('[play] acknowledge falló; queda para reintentar', ph);
        const q = await callNotifier(env, 'playack:' + ph, { op: 'play-ack', pt: purchaseToken, sku: ent.sku, until: now + PLAY_ACK_WINDOW_MS });
        if (!q || !q.ok) console.error('[play] no se pudo programar el reintento del acknowledge', q && q.error);
    }

    // pt: el token de compra viaja en la licencia (el teléfono ya lo tiene) para que la
    // revisión semanal pueda volver a preguntarle a Google sin guardarlo en el servidor.
    const token = await signLicense(env.LICENSE_SECRET, {
        product: 'premium_play', tier: 'premium', deviceId, play_sku: ent.sku, pt: purchaseToken, iat: now, exp: ent.expMs
    });
    return json({ ok: true, token, product: 'premium_play', tier: 'premium', expiresAt: new Date(ent.expMs).toISOString() });
}

// P-6 y P-7: lo que /api/license/verify chequea de una licencia de Play. Devuelve el motivo
// para darla por no válida, o null. Si Google no responde, la licencia se mantiene.
async function playLicenseCheck(env, payload) {
    const ph = await playHash(payload.pt);
    const rec = await kvGet(env, `play:${ph}`);
    if (rec && Array.isArray(rec.devices) && payload.deviceId && !rec.devices.some((d) => d.id === payload.deviceId)) return 'device_mismatch';
    if (rec && rec.ended) return 'play_inactive';
    const last = rec ? Date.parse(rec.checked_at || rec.first_at || '') || 0 : 0;
    if (!env.PLAY_SA_JSON || !env.PLAY_PACKAGE || Date.now() - last < PLAY_RECHECK_MS) return null;
    const got = await playFetchSub(env, payload.pt);
    if (got.status === 'error') return null;
    const ent = got.status === 'ok' ? playEntitlement(got.sub, Date.now()) : { ok: false, state: 'NOT_FOUND' };
    const next = Object.assign({ first_at: nowISO(), devices: payload.deviceId ? [{ id: payload.deviceId, at: nowISO() }] : [], moves: 0, sku: payload.play_sku || null }, rec || {}, { checked_at: nowISO() });
    if (!ent.ok) next.ended = ent.state || 'inactive';
    try { await kvPut(env, `play:${ph}`, next); } catch (e) { console.error('[play] no se pudo guardar la revisión', String((e && e.message) || e).slice(0, 160)); }
    return ent.ok ? null : 'play_inactive';
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

// Cron cada hora: a cada suscripción le toca el recordatorio cuando en SU zona
// horaria son las REMINDER_HOUR (18), una vez por día local, y solo si ese día no
// registró un entrenamiento (pushtr:{id}). Push vacío; 404/410 = suscripción
// muerta → se borra. El plan Free permite 50 subrequests por invocación, así que
// cada corrida manda como mucho PUSH_BATCH: wrangler.toml dispara el cron cada
// minuto (60 × 40 = 2.400 por hora y zona, más que PUSH_MAX) y lo resuelto queda
// en sent = día local. Sin nadie a las 18 locales, la corrida lee una key y termina.
// A quién le toca el recordatorio en `when` (las REMINDER_HOUR locales y todavía no se le
// mandó hoy). skipLeasedAt: no devolver los que otra corrida apartó hace un momento.
// Una hora local por ZONA, no por suscripción: crear un Intl.DateTimeFormat cuesta
// ~0,1-0,5 ms y el plan Free da 10 ms de CPU por corrida. Ojo: validTz también crea uno,
// así que la zona se valida una vez por texto de zona (auditoría L-2).
function dueSubs(subs, when, skipLeasedAt) {
    const due = [];
    const clockByTz = {};
    for (const id of Object.keys(subs).sort()) {
        const s = subs[id];
        if (!s || !s.endpoint) continue;
        if (skipLeasedAt && s.lease && s.lease > skipLeasedAt) continue;
        const raw = typeof s.tz === 'string' ? s.tz : '';
        const clock = clockByTz[raw] || (clockByTz[raw] = localClock(validTz(raw) || DEFAULT_TZ, when));
        if (clock.hour === REMINDER_HOUR && s.sent !== clock.date) due.push({ id, date: clock.date, endpoint: s.endpoint });
    }
    return due;
}

// Suscripciones al recordatorio diario en el objeto 'pushsubs' (auditoría K-6). Antes vivían
// en una key de KV que reescribían el cron y las altas y bajas: si coincidían, una pisaba a
// la otra (y KV puede leer una copia de hasta un minuto atrás). El objeto atiende de a un
// pedido por vez. Mismo formato que push:all y en UNA fila: el cron la lee cada minuto (una
// fila, no una por suscripción). Con KV_MIRROR prendido, cada cambio se copia a push:all para
// poder volver a publicar un Worker anterior. Devuelve kvError si la copia falló (vigía).
async function pushSubsLoad(storage, env) {
    const epoch = dataEpoch(env);
    const cur = await storage.get('all');
    if (cur && cur.epoch === epoch) return cur;
    // Primera vez, o volver a publicar después de una vuelta atrás: se trae de KV.
    const kv = (await kvGet(env, 'push:all')) || { subs: {} };
    const all = { epoch, subs: (kv && kv.subs) || {} };
    await storage.put('all', all);
    return all;
}
async function pushSubsSave(storage, env, all, mirror) {
    if (mirror && mirrorOn(env)) {
        try {
            const subs = {};
            for (const [id, s] of Object.entries(all.subs)) { const c = Object.assign({}, s); delete c.lease; subs[id] = c; }
            await kvPut(env, 'push:all', { subs });
            delete all.mirrorPending;
        } catch (e) {
            const msg = String((e && e.message) || e).slice(0, 200);
            console.error('[avisos] copia de push:all a KV pendiente', msg);
            all.mirrorPending = true;
            await storage.put('all', all);
            return msg;
        }
    }
    await storage.put('all', all);
    return null;
}
async function pushSubsOp(storage, env, b, now) {
    const all = await pushSubsLoad(storage, env);
    const id = String(b.id || '');
    switch (b.op) {
        case 'ps-put': {
            const endpoint = String(b.endpoint || '');
            if (!/^[a-f0-9]{64}$/.test(id) || !endpoint || endpoint.length > 1024 || !pushHostAllowed(endpoint)) return { ok: false, error: 'invalid' };
            if (!all.subs[id] && Object.keys(all.subs).length >= PUSH_MAX) return { ok: false, error: 'full' };
            const prev = all.subs[id] || {};
            all.subs[id] = {
                endpoint,
                lang: (b.lang === 'en' || b.lang === 'pt') ? b.lang : 'es',
                tz: validTz(b.tz) || prev.tz || null,
                sent: prev.sent || null,                        // re-suscribirse no repite el aviso del día
                created_at: prev.created_at || nowISO()
            };
            return { ok: true, kvError: await pushSubsSave(storage, env, all, true) };
        }
        case 'ps-del': {
            if (!all.subs[id]) return { ok: true };
            delete all.subs[id];
            return { ok: true, kvError: await pushSubsSave(storage, env, all, true) };
        }
        case 'ps-due': {
            // at: la hora del cron. Los que se devuelven quedan apartados `lease` ms: si una
            // corrida tarda (servicio de avisos lento), la siguiente no les manda otro aviso.
            const at = Number(b.at) || now;
            const lease = Math.min(Math.max(Number(b.lease) || 300000, 60000), 3600000);
            const due = dueSubs(all.subs, new Date(at), at);
            let kvError = null;
            if (due.length) {
                for (const d of due) all.subs[d.id].lease = at + lease;
                kvError = await pushSubsSave(storage, env, all, !!all.mirrorPending);
            } else if (all.mirrorPending) kvError = await pushSubsSave(storage, env, all, true);
            return { ok: true, due, kvError };
        }
        case 'ps-mark': {
            const sent = b.sent && typeof b.sent === 'object' ? b.sent : {};
            const dead = Array.isArray(b.dead) ? b.dead : [];
            const release = Array.isArray(b.release) ? b.release : [];
            let changed = false, mirror = false;
            for (const [sid, d] of Object.entries(sent)) {
                const s = all.subs[sid];
                if (s && typeof d === 'string') { s.sent = d.slice(0, 10); delete s.lease; changed = mirror = true; }
            }
            for (const sid of dead) if (all.subs[sid]) { delete all.subs[sid]; changed = mirror = true; }
            for (const sid of release) if (all.subs[sid] && all.subs[sid].lease) { delete all.subs[sid].lease; changed = true; }
            if (!changed) return { ok: true };
            return { ok: true, kvError: await pushSubsSave(storage, env, all, mirror || !!all.mirrorPending) };
        }
    }
    return { ok: false, error: 'op' };
}

async function sendDueReminders(env, when = new Date()) {
    if (!env.VAPID_PRIVATE_JWK || !env.VAPID_PUBLIC_KEY) return { sent: 0, note: 'VAPID sin configurar' };
    const viaDO = doData(env);
    let all = null, due;
    if (viaDO) {
        const r = await callNotifier(env, 'pushsubs', { op: 'ps-due', at: when.getTime(), lease: 5 * 60000 });
        if (!r || !r.ok) throw new Error('pushsubs sin respuesta: ' + (r && r.error));   // lo registra el cron
        due = r.due || [];
    } else {
        all = (await kvGet(env, 'push:all')) || { subs: {} };
        due = dueSubs(all.subs, when, 0);
    }
    if (!due.length) return { sent: 0, due: 0 };

    // Quién ya entrenó hoy: un solo list de las marcas (sin un get por suscripción).
    const trained = {};
    let legacyMarks = true;
    if (doData(env)) {
        // Las marcas viven en el objeto de contadores. Las de KV (de antes de este cambio) duran
        // 3 días: se siguen mirando ese tiempo y después ya no se lista KV.
        const res = await callNotifier(env, 'counters', { op: 'tr-list' });
        if (res && res.ok) {
            Object.assign(trained, res.marks || {});
            legacyMarks = when.getTime() < (Number(res.since) || 0) + (TRAINED_TTL + 3600) * 1000;
        } else {
            console.error('[contadores] sin respuesta para "hoy ya entrené"', res && res.error);
            // Se reintenta en la corrida que viene (el cron corre cada minuto). Sobre el final
            // de la hora se manda igual: peor que un aviso de más es que no le llegue a nadie.
            if (when.getUTCMinutes() < 50) {
                if (viaDO) await callNotifier(env, 'pushsubs', { op: 'ps-mark', release: due.map((d) => d.id) });
                return { sent: 0, due: due.length, note: 'contadores sin respuesta' };
            }
            legacyMarks = false;
        }
    }
    if (legacyMarks) {
        let cursor;
        do {
            const res = await env.BMOD_KV.list({ prefix: 'pushtr:', cursor });
            for (const k of res.keys) if (k.metadata && k.metadata.d && !trained[k.name.slice(7)]) trained[k.name.slice(7)] = k.metadata.d;
            cursor = res.list_complete ? undefined : res.cursor;
        } while (cursor);
    }

    let sent = 0, removed = 0, skipped = 0, failed = 0, tried = 0;
    const sentMap = {}, dead = [], release = [];
    const jwtByOrigin = {}; // un JWT VAPID por servicio de push (casi todos son FCM)
    for (const d of due) {
        if (trained[d.id] === d.date) { sentMap[d.id] = d.date; skipped++; continue; }   // ya entrenó: hoy no
        if (tried >= PUSH_BATCH) { release.push(d.id); continue; }   // los sigue la corrida que viene
        tried++;
        try {
            const origin = new URL(d.endpoint).origin;
            if (!jwtByOrigin[origin]) jwtByOrigin[origin] = await vapidJwt(env, origin);
            const resp = await fetch(d.endpoint, {
                method: 'POST',
                headers: { TTL: '3600', Authorization: 'vapid t=' + jwtByOrigin[origin] + ', k=' + env.VAPID_PUBLIC_KEY }
            });
            if (resp.status === 404 || resp.status === 410) { dead.push(d.id); removed++; }
            else if (resp.status < 400) { sentMap[d.id] = d.date; sent++; }
            // Otro error (p. ej. 403 por clave VAPID vieja): hoy no se reintenta.
            // Si no, 40 suscripciones rotas ocuparían el lote de cada corrida y
            // las que vienen detrás nunca recibirían el aviso.
            else { sentMap[d.id] = d.date; failed++; }
        } catch { release.push(d.id); /* push service caído → la próxima corrida de esta hora reintenta */ }
    }
    if (viaDO) {
        if (sent || removed || skipped || failed || release.length) {
            const m = await callNotifier(env, 'pushsubs', { op: 'ps-mark', sent: sentMap, dead, release });
            if (!m || !m.ok) console.error('[cron] no se pudo anotar a quién se le mandó el recordatorio', m && m.error);
        }
    } else if (sent || removed || skipped || failed) {
        for (const [id, date] of Object.entries(sentMap)) if (all.subs[id]) all.subs[id].sent = date;
        for (const id of dead) delete all.subs[id];
        await kvPut(env, 'push:all', all);
    }
    return { sent, removed, skipped, failed, due: due.length };
}

// ─────────────────────────────────────────────
// MÉTRICAS ANÓNIMAS (Workers Analytics Engine — no usa KV)
// Para saber qué canal de marketing trae gente sin romper la promesa de la
// landing: sin cookies, sin IP, sin identificadores. Cada evento guarda solo
// [evento, nombre, ruta, origen, país, m|d, sistema, superficie]. La web manda
// 'view' y 'cta' a /api/e; el server suma conversiones (trial, checkout, pago,
// tester, activación) desde los endpoints que ya existen. La app instalada NO
// manda eventos: en sus pedidos de licencia solo agrega surface 'app' | 'web'.
// sistema = android | ios | otro, sacado del user-agent que ya llega.
// Lectura: GET /api/admin/stats (admin) → consulta el SQL API de Analytics
// Engine con CF_ACCOUNT_ID (var) + CF_ANALYTICS_TOKEN (secret, solo lectura).
// ─────────────────────────────────────────────
const EVENT_NAMES = ['view', 'cta'];
const SAFE_TOKEN = /^[a-z0-9._-]{1,32}$/;

const SURFACES = ['web', 'app'];
// Desde dónde vino un pedido de la app: 'app' (TWA de Play) o 'web'; '' si no lo dice (versiones viejas).
const surfaceOf = (body) => (body && SURFACES.includes(body.surface) ? body.surface : '');

// extra: p ruta, r origen, s superficie; server: true = pedido de otro servidor (webhook de MP), sin sistema.
function track(env, req, e, n, extra) {
    if (!env.EVENTS || typeof env.EVENTS.writeDataPoint !== 'function') return;
    try {
        const ua = (req && req.headers.get('user-agent')) || '';
        const country = (req && req.cf && req.cf.country) || (req && req.headers.get('x-bm-country')) || '';
        const server = !!(extra && extra.server);
        const os = server ? '' : /Android/i.test(ua) ? 'android' : /iPhone|iPad|iPod/i.test(ua) ? 'ios' : 'otro';
        env.EVENTS.writeDataPoint({
            blobs: [e, n || '', (extra && extra.p) || '', (extra && extra.r) || '', String(country).slice(0, 2), /Mobile|Android|iPhone|iPad/i.test(ua) ? 'm' : 'd', os, (extra && extra.s) || ''],
            doubles: [1],
            indexes: [e]
        });
    } catch { /* las métricas nunca rompen una ruta */ }
}

async function ingestEvent(req, env) {
    const b = await readBody(req, 2048);
    const e = b && String(b.e || '');
    if (!EVENT_NAMES.includes(e)) return err('bad event', 400);
    const n = String((b && b.n) || '').toLowerCase();
    const r = String((b && b.r) || 'direct').toLowerCase();
    const path = String((b && b.p) || '/');
    track(env, req, e, SAFE_TOKEN.test(n) ? n : '', {
        p: /^\/[A-Za-z0-9._/-]{0,63}$/.test(path) ? path : '/',
        r: SAFE_TOKEN.test(r) ? r : 'other',
        s: 'web'
    });
    return new Response(null, { status: 204, headers: corsHeaders() });
}

async function aeQuery(env, sql) {
    const resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + env.CF_ANALYTICS_TOKEN }, body: sql
    });
    if (!resp.ok) throw new Error('Analytics Engine ' + resp.status);
    return (await resp.json()).data || [];
}

async function adminStats(req, env, url) {
    if (!env.ADMIN_SECRET || req.headers.get('x-admin-secret') !== env.ADMIN_SECRET) return err('Unauthorized', 401);
    if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) return err('Falta CF_ANALYTICS_TOKEN (secret de solo lectura de Analytics)', 503);
    const days = Math.min(Math.max(parseInt(url.searchParams.get('days'), 10) || 7, 1), 90);
    const since = `timestamp > NOW() - INTERVAL '${days}' DAY`;
    // _sample_interval: AE muestrea con mucho volumen; sumarlo da el conteo real.
    const [porOrigen, porDia, porSistema] = await Promise.all([
        aeQuery(env, `SELECT blob1 AS evento, blob2 AS nombre, blob4 AS origen, SUM(_sample_interval) AS total FROM bm_events WHERE ${since} GROUP BY evento, nombre, origen ORDER BY total DESC LIMIT 300 FORMAT JSON`),
        aeQuery(env, `SELECT toStartOfDay(timestamp) AS dia, blob1 AS evento, SUM(_sample_interval) AS total FROM bm_events WHERE ${since} GROUP BY dia, evento ORDER BY dia FORMAT JSON`),
        aeQuery(env, `SELECT blob1 AS evento, blob7 AS sistema, blob8 AS superficie, SUM(_sample_interval) AS total FROM bm_events WHERE ${since} GROUP BY evento, sistema, superficie ORDER BY total DESC LIMIT 300 FORMAT JSON`)
    ]);
    return json({ ok: true, days, por_origen: porOrigen, por_dia: porDia, por_sistema: porSistema });
}

// ── Rutas del Coach ──
// Las mismas de siempre. Con los datos en Durable Objects corren adentro del objeto del coach
// (coachOp); sin ellos, acá mismo sobre KV. Devuelve null si ninguna coincide.
async function coachRoutes(req, env, url, p, m) {
    let mt;
    if (p === '/api/routines' && m === 'POST') return await createRoutine(req, env, url);
    if (p === '/api/routines' && m === 'GET') return await listRoutines(env, url);
    if ((mt = p.match(/^\/api\/routines\/([a-f0-9-]+)\/review$/)) && m === 'POST') return await reviewRoutine(req, env, url, mt[1]);
    if ((mt = p.match(/^\/api\/routines\/([a-f0-9-]+)\/evals\/(\d{1,2})$/)) && m === 'PUT') return await putEval(req, env, url, mt[1], mt[2]);
    if ((mt = p.match(/^\/api\/routines\/([a-f0-9-]+)\/videos\/([a-z0-9]{6,40})$/)) && m === 'PUT') return await replyVideo(req, env, url, mt[1], mt[2]);
    if ((mt = p.match(/^\/api\/routines\/([a-f0-9-]+)\/checkins\/(\d{4}-W\d{2})$/)) && m === 'PUT') return await replyCheckin(req, env, url, mt[1], mt[2]);
    if ((mt = p.match(/^\/api\/routines\/([a-f0-9-]+)\/announce$/)) && m === 'POST') return await announceStudent(req, env, url, mt[1]);
    if ((mt = p.match(/^\/api\/routines\/([a-f0-9-]+)\/report$/)) && m === 'POST') return await postRoutineReport(req, env, url, mt[1]);
    if ((mt = p.match(/^\/api\/routines\/([a-f0-9-]+)\/remind$/)) && m === 'POST') return await remindRoutine(req, env, url, mt[1]);
    if ((mt = p.match(/^\/api\/routines\/([a-f0-9-]+)\/new-link$/)) && m === 'POST') return await newShareLink(req, env, url, mt[1]);
    if ((mt = p.match(/^\/api\/routines\/([a-f0-9-]+)\/premium$/)) && m === 'POST') return await assignSeat(req, env, url, mt[1]);
    if ((mt = p.match(/^\/api\/routines\/([a-f0-9-]+)\/premium$/)) && m === 'DELETE') return await removeSeat(req, env, url, mt[1]);
    if ((mt = p.match(/^\/api\/routines\/([a-f0-9-]+)\/review$/)) && m === 'PUT') return await putReview(req, env, url, mt[1]);
    if ((mt = p.match(/^\/api\/routines\/([a-f0-9-]+)\/review$/)) && m === 'DELETE') return await deleteReview(req, env, url, mt[1]);
    if ((mt = p.match(/^\/api\/routines\/([a-f0-9-]+)\/evals\/(\d{1,2})$/)) && m === 'DELETE') return await deleteEval(req, env, url, mt[1], mt[2]);
    if ((mt = p.match(/^\/api\/routines\/([a-f0-9-]+)$/)) && m === 'GET') return await getRoutine(env, url, mt[1]);
    if ((mt = p.match(/^\/api\/routines\/([a-f0-9-]+)$/)) && m === 'PUT') return await updateRoutine(req, env, url, mt[1]);
    if ((mt = p.match(/^\/api\/routines\/([a-f0-9-]+)$/)) && m === 'DELETE') return await deleteRoutine(req, env, url, mt[1]);
    if ((mt = p.match(/^\/api\/shares\/([a-z0-9]+)\/edits$/)) && m === 'POST') return await postEdit(req, env, mt[1]);
    if ((mt = p.match(/^\/api\/shares\/([a-z0-9]+)\/sessions$/)) && m === 'POST') return await postShareSession(req, env, mt[1]);
    if ((mt = p.match(/^\/api\/shares\/([a-z0-9]+)\/checkins$/)) && m === 'POST') return await postCheckin(req, env, mt[1]);
    if ((mt = p.match(/^\/api\/shares\/([a-z0-9]+)\/videos$/)) && m === 'POST') return await postVideo(req, env, mt[1]);
    if ((mt = p.match(/^\/api\/shares\/([a-z0-9]+)\/terms$/)) && m === 'POST') return await postShareTerms(req, env, mt[1]);
    if ((mt = p.match(/^\/api\/shares\/([a-z0-9]+)\/push$/)) && m === 'POST') return await postSharePush(req, env, mt[1]);
    if ((mt = p.match(/^\/api\/shares\/([a-z0-9]+)\/report$/)) && m === 'POST') return await postShareReport(req, env, mt[1]);
    if ((mt = p.match(/^\/api\/shares\/([a-z0-9]+)\/leave$/)) && m === 'POST') return await postShareLeave(req, env, mt[1]);
    if ((mt = p.match(/^\/api\/shares\/([a-z0-9]+)\/interest$/)) && m === 'POST') return await postShareInterest(req, env, mt[1]);
    if ((mt = p.match(/^\/api\/shares\/([a-z0-9]+)\/premium-auto$/)) && m === 'POST') return await postSharePremiumAuto(req, env, mt[1]);
    if ((mt = p.match(/^\/api\/shares\/([a-z0-9]+)\/videos\/([a-z0-9]{6,40})$/)) && m === 'DELETE') return await deleteVideo(env, mt[1], mt[2]);
    if ((mt = p.match(/^\/api\/shares\/([a-z0-9]+)\/premium-claim$/)) && m === 'POST') return await claimSharePremium(req, env, mt[1]);
    if ((mt = p.match(/^\/api\/shares\/([a-z0-9]+)\/intake$/)) && m === 'POST') return await postIntake(req, env, mt[1]);
    if (p === '/api/coach/config' && m === 'GET') return await getCoachConfig(env, url);
    if (p === '/api/coach/config' && m === 'PUT') return await putCoachConfig(req, env, url);
    if ((mt = p.match(/^\/api\/shares\/([a-z0-9]+)$/)) && m === 'GET') return await getShare(env, mt[1]);
    return null;
}
function coachRouteKind(p) {
    if (p === '/api/routines' || p === '/api/coach/config' || /^\/api\/routines\/[a-f0-9-]+(\/|$)/.test(p)) return 'coach';
    if (/^\/api\/shares\/[a-z0-9]+(\/|$)/.test(p)) return 'share';
    return null;
}
// Le pasa el pedido al objeto del coach que corresponde. El coach sale del pedido (rutas del
// coach) o del índice del link (rutas del alumno). Sin coach, la ruta responde acá mismo su
// error de siempre (falta coach_id, link inexistente), sin tocar datos de ningún coach.
const FORWARD_HEADERS = ['content-type', 'x-coach-id', 'user-agent', 'sec-ch-ua-mobile', 'sec-ch-ua-platform'];
async function forwardToCoach(req, env, url, p, m, kind) {
    let text = '';
    if (m !== 'GET' && m !== 'HEAD') {
        try { text = await req.text(); } catch { text = ''; }
        if (text.length > MAX_BODY) throw new PayloadTooLarge();
    }
    let coachId = null, pre = null;
    if (kind === 'coach') {
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = null; }
        // Igual que cada ruta: las GET leen coach_id de la dirección; el resto, header → body → dirección.
        coachId = m === 'GET' ? url.searchParams.get('coach_id') : coachIdFrom(req, url, body);
    } else {
        const token = p.split('/')[3];
        const raw = await env.BMOD_KV.get('token:' + token);
        if (raw) {
            try { coachId = JSON.parse(raw).coachId || null; pre = ['token:' + token, raw]; } catch { coachId = null; }
        } else {
            const mv = await kvGet(env, movedKey(token));   // link cambiado: el objeto del coach responde 410
            if (mv && mv.coachId) coachId = mv.coachId;
        }
    }
    if (!coachId || typeof coachId !== 'string') {
        const again = new Request(req.url, { method: m, headers: req.headers, body: text || undefined });
        return (await coachRoutes(again, env, url, p, m)) || err('Not found', 404);
    }
    const headers = {};
    for (const h of FORWARD_HEADERS) { const v = req.headers.get(h); if (v) headers[h] = v; }
    if (req.cf && req.cf.country) headers['x-bm-country'] = String(req.cf.country).slice(0, 2);
    try {
        const stub = env.NOTIFIER.get(env.NOTIFIER.idFromName('coach:' + coachId));
        return await stub.fetch('https://notifier/op', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ op: 'c-http', coachId, method: m, path: p, search: url.search, headers, body: text, pre })
        });
    } catch (e) {
        // Objeto sin responder (o tope diario de Durable Objects): la app lo toma como "sin conexión"
        // y reintenta después (los entrenamientos del alumno quedan en cola).
        console.error('[coach] objeto sin respuesta', p, (e && e.message) || e);
        return err('Servicio ocupado. Probá de nuevo en un rato.', 503);
    }
}

export default {
    async scheduled(controller, env, ctx) {
        ctx.waitUntil(sendDueReminders(env, new Date((controller && controller.scheduledTime) || Date.now())).catch(async (e) => {
            const msg = String((e && e.message) || e);
            console.error('[cron] recordatorio diario falló', msg.slice(0, 300));
            await noteKvLimit(env, msg);
        }));
    },
    async fetch(req, env) {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
        const url = new URL(req.url);
        const p = url.pathname.replace(/\/+$/, '') || '/';
        const m = req.method;

        // Tope de tamaño declarado (el real se mide en readBody) y rate limit por IP.
        const declared = parseInt(req.headers.get('content-length') || '0', 10) || 0;
        if (declared > (p === '/api/parse-routine' ? MAX_BODY_PDF : p === '/api/food-vision' ? MAX_BODY_IMG : p === '/api/transfer' ? XFER_MAX : MAX_BODY)) return err('Payload too large', 413);
        const strict = STRICT_ROUTES.includes(p) || p.startsWith('/api/admin/') || /\/(report|leave|new-link|interest|premium-auto)$/.test(p);
        if (await rateLimited(env, strict ? 'RL_STRICT' : 'RL_OPEN', (strict ? 's:' : 'o:') + clientIp(req))) {
            return json({ error: 'Demasiadas solicitudes. Esperá un minuto y probá de nuevo.' }, 429, { 'Retry-After': '60' });
        }
        // Crear una rutina gasta 2 de las 1.000 escrituras diarias de KV y no pide licencia:
        // 5 por minuto por IP, con su propio contador (un gimnasio que usa la IA no se lo
        // come al coach). Antes entraban 60 por minuto (auditoría 2026-11, L-1).
        if (p === '/api/routines' && m === 'POST' && await rateLimited(env, 'RL_STRICT', 'r:' + clientIp(req))) {
            return json({ error: 'Demasiadas solicitudes. Esperá un minuto y probá de nuevo.' }, 429, { 'Retry-After': '60' });
        }
        // Con los datos del Coach en sus objetos, el Worker no toca esas keys de KV: si algo
        // lo intenta, salta (en vez de leer una copia que puede estar vieja).
        if (doData(env)) env = Object.assign(Object.create(env), { BMOD_KV: guardKV(env.BMOD_KV) });

        try {
            if (p === '/' || p === '/api/health') return json({ ok: true, service: 'berserkermod-api' });
            if (p === '/api/health/deep' && m === 'GET') return await healthDeep(env);

            // Coach
            // Coach: todo lo de un coach y sus alumnos se resuelve en el objeto de ese coach
            const ckind = coachRouteKind(p);
            if (ckind && doData(env)) return await forwardToCoach(req, env, url, p, m, ckind);
            if (ckind) { const cr = await coachRoutes(req, env, url, p, m); if (cr) return cr; }
            if (p === '/api/push/rest' && m === 'POST') return await pushRest(req, env);
            if (p === '/api/transfer' && m === 'POST') return await postTransfer(req, env);
            if (p === '/api/transfer/claim' && m === 'POST') return await postTransferClaim(req, env);
            if (p === '/api/coach/bind' && m === 'POST') return await coachBind(req, env);

            // Licencias
            if (p === '/api/license/activate' && m === 'POST') return await activateLicense(req, env);
            if (p === '/api/license/verify' && m === 'POST') return await verifyLicenseHandler(req, env);
            if (p === '/api/license/trial' && m === 'POST') return await startTrial(req, env);
            if (p === '/api/license/retrieve' && m === 'GET') return await retrieveCode(env, url);
            if (p === '/api/admin/codes' && m === 'POST') return await adminCreateCodes(req, env);
            if (p === '/api/testers/claim' && m === 'POST') return await testersClaim(req, env);
            if (p === '/api/admin/testers' && m === 'GET') return await adminTesters(req, env);
            if (p === '/api/admin/stats' && m === 'GET') return await adminStats(req, env, url);
            if (p === '/api/e' && m === 'POST') return await ingestEvent(req, env);

            // Checkout / productos
            if (p === '/api/products' && m === 'GET') return productsInfo(env);
            if (p === '/api/checkout' && m === 'POST') return await createCheckout(req, env);

            // Mercado Pago
            if (p === '/api/webhook/mercadopago' && (m === 'POST' || m === 'GET')) return await mercadoPagoWebhook(req, env, url);

            // Oracle
            if (p === '/api/oracle' && m === 'POST') return await oracleProxy(req, env);
            if (p === '/api/parse-routine' && m === 'POST') return await parseRoutine(req, env);
            if (p === '/api/food-vision' && m === 'POST') return await foodVision(req, env);
            // Base de alimentos (USDA) para la pantalla de revisión del plato: elegir el alimento
            // correcto o agregar uno. No usa IA ni KV; la app la guarda y la pide una vez por semana.
            if (p === '/api/foods' && m === 'GET') return json({ v: FOOD_DB_VERSION, items: FOOD_DB.map((f) => ({ k: f.k, n: f.n, ne: f.ne, np: f.np, i: f.i, s: f.s, kcal: f.kcal, p: f.p, c: f.c, f: f.f, u: f.u, d: f.d })) });

            // Push (recordatorio diario)
            if (p === '/api/push/subscribe' && m === 'POST') return await pushSubscribe(req, env);
            if (p === '/api/push/unsubscribe' && m === 'POST') return await pushUnsubscribe(req, env);
            if (p === '/api/push/trained' && m === 'POST') return await pushTrained(req, env);
            if (p === '/api/play/verify' && m === 'POST') return await playVerify(req, env);

            // Observabilidad
            if (p === '/api/errors' && m === 'POST') return await ingestErrors(req, env);
            if (p === '/api/admin/errors' && m === 'GET') return await adminErrors(req, env);
            if (p === '/api/admin/reports' && m === 'GET') return await adminReports(req, env);

            // Salud / varios
            if (p === '/api/health-data' && m === 'POST') return await healthData(req, env);
            if (p === '/api/server-info' && m === 'GET') return serverInfo(env);

            return err('Not found', 404);
        } catch (e) {
            if (e instanceof PayloadTooLarge) return err('Payload too large', 413);
            const msg = String((e && e.message) || e);
            console.error('[worker] error', m, p, msg.slice(0, 300));
            await noteKvLimit(env, msg);
            return err(INTERNAL_ERR_MSG, 500);   // S-3: el detalle queda en el registro, no le llega al usuario
        }
    }
};
