// Datos del Coach en Durable Objects (auditoría 2026-11: K-1, L-1 de fondo, L-3).
// Prueba lo que la tanda general no ve: carreras entre coach y alumno, KV respondiendo 429,
// el orden del espejo a KV, la fila de espera cubriendo las esperas a KV, la migración desde
// el formato viejo, la vuelta atrás al Worker anterior, los contadores y el costo.
//
// El Worker anterior se saca del historial de git al correr (BASE_COMMIT). Sin historial
// (por ejemplo, un clone superficial), esas pruebas se saltean avisando.
// Correr con: node worker/test/coach-data.test.mjs
import worker, { Notifier } from '../src/index.js';
import { makeDONamespace, makeKV } from './do-fake.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BASE_COMMIT = '852caff';   // Worker publicado antes de esta obra (tanda 1 de la auditoría)
// Campos que se sumaron a propósito después de ese Worker (fases 2 y 3 del Coach, nov 2026): el viejo no los tiene
const NEW_FIELDS = ['announce', 'plan_days', 'push_on', 'billing', 'targets', 'photos_link', 'brand'];
const here = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0, skipped = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 600) : '')); } }
function skip(name, why) { skipped++; console.log('  ⚠ SALTEADO: ' + name + ' (' + why + ')'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const dayAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// ── Entornos ──
async function vapid(env) {
    const vk = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    env.VAPID_PRIVATE_JWK = JSON.stringify(await crypto.subtle.exportKey('jwk', vk.privateKey));
    env.VAPID_PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey('raw', vk.publicKey)).toString('base64url');
}
async function makeEnv({ kv, doData = true, NotifierClass = Notifier, mirror = 'on', epoch, doDelay } = {}) {
    const env = { BMOD_KV: kv || makeKV(), LICENSE_SECRET: 'test-secret-local', ADMIN_SECRET: 'test-admin', APP_ORIGIN: 'https://example.test', KV_MIRROR: mirror };
    if (epoch) env.DATA_EPOCH = epoch;
    if (!doData) env.DO_DATA = 'off';
    env.NOTIFIER = makeDONamespace(NotifierClass, env, { delay: doDelay || 0 });
    await vapid(env);
    return env;
}
function caller(w, env) {
    return async (method, p, body, headers = {}) => {
        const init = { method, headers: { 'Content-Type': 'application/json', ...headers } };
        if (body !== undefined) init.body = JSON.stringify(body);
        const res = await w.fetch(new Request('https://api.test' + p, init), env);
        let j = null; try { j = await res.json(); } catch { /* sin cuerpo */ }
        return { status: res.status, body: j };
    };
}
const coachDO = (env, coach) => env.NOTIFIER._dos.get('coach:' + coach);
const kvRec = (env, key) => { const v = env.BMOD_KV._m.get(key); return v ? JSON.parse(v) : null; };
const pendingMirror = (env, coach) => { const d = coachDO(env, coach); return d ? [...d.storage._m.keys()].filter((k) => k.startsWith('mq:') && k !== 'mq:retry') : []; };
async function withNow(t, fn) { const real = Date.now; Date.now = () => t; try { return await fn(); } finally { Date.now = real; } }
// Corre la alarma de un objeto como si ya hubiera llegado su hora
async function fireAlarm(env, name) {
    const d = env.NOTIFIER._dos.get(name);
    const at = d && d.storage.alarm;
    if (!at) return false;
    await withNow(at + 1, () => env.NOTIFIER.fire(name, true));
    return true;
}
// Mientras corre algo, el servicio de push responde 201 y no sale nada a la red
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('', { status: 201 });

console.log('\n=== Datos del Coach en Durable Objects ===\n');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Carreras entre coach y alumno (K-1)
// ─────────────────────────────────────────────────────────────────────────────
{
    console.log('Carreras: coach y alumno escribiendo a la vez');
    const env = await makeEnv({ doDelay: 2 });
    env.BMOD_KV.delay = 3;
    const call = caller(worker, env);
    const C = 'coach-race-0001';
    const r = (await call('POST', '/api/routines', { coach_id: C, name: 'Plan', plan: [{ name: 'VIEJO', exercises: [] }], alumno_name: 'Vale' })).body;
    const tk = r.share_token, key = 'routine:' + C + ':' + r.id;

    // El caso de la auditoría: el coach guarda mientras el alumno abre, entrena y manda el control
    const [up, , ses, chk, terms] = await Promise.all([
        call('PUT', '/api/routines/' + r.id, { coach_id: C, plan: [{ name: 'NUEVO', exercises: [{ name: 'Press' }] }] }),
        call('GET', '/api/shares/' + tk),
        call('POST', '/api/shares/' + tk + '/sessions', { date: today(), exercises: [{ name: 'Press', sets: [{ kg: 40, reps: 8 }] }] }),
        call('POST', '/api/shares/' + tk + '/checkins', { date: today(), weight: 70 }),
        call('POST', '/api/shares/' + tk + '/terms', { version: '2026-11-14' })
    ]);
    ok('todos los pedidos salen bien', up.status === 200 && ses.status === 201 && chk.status === 201 && terms.status === 200, [up.status, ses.status, chk.status, terms.status]);
    const det = (await call('GET', '/api/routines/' + r.id + '?coach_id=' + C)).body;
    ok('queda el plan nuevo del coach', det.routine.plan[0].name === 'NUEVO', det.routine.plan);
    ok('y también el entrenamiento, el control y los términos del alumno', det.routine.session_count === 1 && !!det.routine.last_checkin_at && det.sessions.length === 1 && det.checkins.length === 1 && (det.routine.terms && det.routine.terms.v) === '2026-11-14', det.routine);
    const k = kvRec(env, key);
    ok('la copia en KV tiene lo mismo (plan nuevo + entrenamiento)', k.plan[0].name === 'NUEVO' && k.session_count === 1 && !!k.last_checkin_at, [k.plan, k.session_count]);

    // Lectura vieja de KV (hasta un minuto): ya no pisa nada, porque el objeto no lee KV
    env.BMOD_KV.stale.set(key, JSON.stringify(Object.assign({}, k, { plan: [{ name: 'MUY-VIEJO' }] })));
    await call('PUT', '/api/routines/' + r.id, { coach_id: C, plan: [{ name: 'OTRO', exercises: [] }] });
    await withNow(Date.now() + 2 * 3600000, () => call('GET', '/api/shares/' + tk));   // "visto" de nuevo
    ok('una lectura vieja de KV no vuelve atrás el plan', kvRec(env, key).plan[0].name === 'OTRO' && coachDO(env, C).storage._m.get('routine:' + r.id).includes('OTRO'));

    // Dos teléfonos del coach: uno cambia el plan, el otro la ficha
    await Promise.all([
        call('PUT', '/api/routines/' + r.id, { coach_id: C, plan: [{ name: 'TEL1', exercises: [] }] }),
        call('PUT', '/api/routines/' + r.id, { coach_id: C, profile: { goals: 'Fuerza', start_date: dayAgo(10) } })
    ]);
    const d2 = (await call('GET', '/api/routines/' + r.id + '?coach_id=' + C)).body.routine;
    ok('dos teléfonos del coach: quedan el plan y la ficha', d2.plan[0].name === 'TEL1' && d2.profile.goals === 'Fuerza', [d2.plan, d2.profile]);

    // Diez alumnos del mismo coach entrenando a la vez
    const studs = [];
    for (let i = 0; i < 10; i++) studs.push((await call('POST', '/api/routines', { coach_id: C, name: 'P' + i, plan: [{ name: 'A', exercises: [] }], alumno_name: 'A' + i })).body);
    const outs = await Promise.all(studs.map((s) => call('POST', '/api/shares/' + s.share_token + '/sessions', { date: today() })));
    const lst = (await call('GET', '/api/routines?coach_id=' + C)).body;
    ok('diez alumnos a la vez: los diez quedan registrados', outs.every((o) => o.status === 201) && studs.every((s) => (lst.find((x) => x.id === s.id) || {}).session_count === 1), outs.map((o) => o.status));

    // Cupo Premium: dos asignaciones a la vez con un solo acceso libre
    const cc = (await call('POST', '/api/admin/codes', { count: 1, product: 'coach', months: 1 }, { 'x-admin-secret': 'test-admin' })).body.codes[0];
    await call('POST', '/api/license/activate', { code: cc, deviceId: 'dev-coach-race', coach_id: C });
    const one = (await call('POST', '/api/admin/codes', { count: 1, product: 'premium', months: 1, coach_pack: true, coach_code: cc }, { 'x-admin-secret': 'test-admin' })).body;
    const [s1, s2] = await Promise.all([
        call('POST', '/api/routines/' + studs[0].id + '/premium', { coach_id: C }),
        call('POST', '/api/routines/' + studs[1].id + '/premium', { coach_id: C })
    ]);
    const code = kvRec(env, 'code:' + one.codes[0]);
    ok('un solo acceso libre y dos pedidos a la vez: uno lo recibe y el otro no', [s1.status, s2.status].sort().join() === '201,409' && [studs[0].id, studs[1].id].includes(code.routine_id), [s1.status, s2.status, code.routine_id]);
    const cfg = (await call('GET', '/api/coach/config?coach_id=' + C)).body;
    ok('el cupo queda en 1 asignado y 0 libres', cfg.seats.total === 1 && cfg.seats.free === 0, cfg.seats);

    // Control: sin la fila de espera, la misma carrera sí pierde un cambio (la prueba sirve)
    const realLock = Notifier.prototype.lock;
    Notifier.prototype.lock = function (fn) { return fn(); };
    const env2 = await makeEnv({ doDelay: 3 });
    env2.BMOD_KV.delay = 3;
    const call2 = caller(worker, env2);
    const r2 = (await call2('POST', '/api/routines', { coach_id: C, name: 'Plan', plan: [{ name: 'VIEJO', exercises: [] }], alumno_name: 'X' })).body;
    await Promise.all([
        call2('PUT', '/api/routines/' + r2.id, { coach_id: C, plan: [{ name: 'NUEVO', exercises: [] }] }),
        call2('POST', '/api/shares/' + r2.share_token + '/checkins', { date: today(), weight: 70 })
    ]);
    const lost = JSON.parse(coachDO(env2, C).storage._m.get('routine:' + r2.id));
    Notifier.prototype.lock = realLock;
    ok('control: sin la fila, coach y alumno se pisan (por eso está la fila)', !(lost.plan[0].name === 'NUEVO' && lost.last_checkin_at), [lost.plan[0].name, lost.last_checkin_at]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. La fila de espera cubre las esperas a KV (migración y espejo)
// ─────────────────────────────────────────────────────────────────────────────
{
    console.log('\nLa fila cubre las esperas a KV adentro del objeto');
    // Alumno en el formato viejo (solo en KV): lo crea el Worker con DO_DATA = "off"
    const kv = makeKV();
    const old = await makeEnv({ kv, doData: false });
    const callOld = caller(worker, old);
    const C = 'coach-lock-0001';
    const r = (await callOld('POST', '/api/routines', { coach_id: C, name: 'Plan', plan: [{ name: 'VIEJO', exercises: [] }], alumno_name: 'Lu' })).body;
    await callOld('POST', '/api/shares/' + r.share_token + '/sessions', { date: dayAgo(1) });
    // Ahora con los datos en Durable Objects y KV lento: la primera vez se trae todo de KV
    const env = await makeEnv({ kv });
    kv.delay = 0;
    kv.delayFor = (op) => (op === 'get' || op === 'put' ? 15 : 0);
    const call = caller(worker, env);
    const outs = await Promise.all([
        call('PUT', '/api/routines/' + r.id, { coach_id: C, plan: [{ name: 'NUEVO', exercises: [] }] }),
        call('POST', '/api/shares/' + r.share_token + '/sessions', { date: today() }),
        call('POST', '/api/shares/' + r.share_token + '/checkins', { date: today(), energy: 4 }),
        call('POST', '/api/shares/' + r.share_token + '/edits', { changes_json: { a: 1 }, edited_by: 'alumno' })
    ]);
    kv.delayFor = null;
    const rec = JSON.parse(coachDO(env, C).storage._m.get('routine:' + r.id));
    ok('migración con KV lento y 4 pedidos a la vez: no se pierde ninguno', outs.every((o) => o.status < 300) && rec.plan[0].name === 'NUEVO' && rec.session_count === 2 && !!rec.last_checkin_at && rec.edit_count === 1, [outs.map((o) => o.status), rec.plan[0].name, rec.session_count, rec.edit_count]);
    const sess = JSON.parse(coachDO(env, C).storage._m.get('sessions:' + r.id));
    ok('las sesiones viejas (de KV) y la nueva quedan juntas', sess.items.length === 2, sess.items.map((s) => s.date));
    ok('la copia en KV quedó igual al objeto', kv._m.get('routine:' + C + ':' + r.id) === coachDO(env, C).storage._m.get('routine:' + r.id));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Espejo a KV: en orden, nunca un cambio viejo sobre uno nuevo
// ─────────────────────────────────────────────────────────────────────────────
{
    console.log('\nEspejo a KV en orden');
    const env = await makeEnv();
    const kv = env.BMOD_KV;
    const call = caller(worker, env);
    const C = 'coach-mirror-01';
    const r = (await call('POST', '/api/routines', { coach_id: C, name: 'Plan', plan: [{ name: 'V0', exercises: [] }], alumno_name: 'Ro' })).body;
    const key = 'routine:' + C + ':' + r.id;

    // Dos cambios seguidos del mismo alumno, con la primera copia a KV mucho más lenta
    let n = 0;
    kv.delayFor = (op, k) => (op === 'put' && k === key ? (++n === 1 ? 60 : 1) : 0);
    kv.log.length = 0;
    await Promise.all([
        call('PUT', '/api/routines/' + r.id, { coach_id: C, plan: [{ name: 'V1', exercises: [] }] }),
        call('PUT', '/api/routines/' + r.id, { coach_id: C, plan: [{ name: 'V2', exercises: [] }] })
    ]);
    kv.delayFor = null;
    const order = kv.log.filter((x) => x[1] === key).map((x) => JSON.parse(x[2]).plan[0].name);
    ok('KV lento: las copias llegan en orden (V1 y después V2)', order.join() === 'V1,V2', order);
    ok('y en KV queda el más nuevo', kvRec(env, key).plan[0].name === 'V2');

    // La primera copia falla (429) y la segunda sale: el reintento no vuelve atrás
    let calls = 0;
    const realPut = kv.put;
    kv.put = async (k, v, o) => { if (k === key && ++calls === 1) throw new Error('KV PUT failed: 429 Too Many Requests'); return realPut.call(kv, k, v, o); };
    const a = await call('PUT', '/api/routines/' + r.id, { coach_id: C, plan: [{ name: 'V3', exercises: [] }] });
    ok('si la copia a KV falla, el pedido igual sale bien', a.status === 200 && kvRec(env, key).plan[0].name === 'V2' && pendingMirror(env, C).length === 1, [a.status, pendingMirror(env, C)]);
    await call('PUT', '/api/routines/' + r.id, { coach_id: C, plan: [{ name: 'V4', exercises: [] }] });
    kv.put = realPut;
    ok('el cambio siguiente copia el valor más nuevo', kvRec(env, key).plan[0].name === 'V4' && pendingMirror(env, C).length === 0, pendingMirror(env, C));
    await fireAlarm(env, 'coach:' + C);
    ok('y el reintento posterior no lo pisa con uno viejo', kvRec(env, key).plan[0].name === 'V4');

    // Las dos fallan y KV vuelve: el reintento copia el más nuevo
    kv.failPut = true;
    await call('PUT', '/api/routines/' + r.id, { coach_id: C, plan: [{ name: 'V5', exercises: [] }] });
    await call('PUT', '/api/routines/' + r.id, { coach_id: C, plan: [{ name: 'V6', exercises: [] }] });
    const pend = pendingMirror(env, C).length;
    const retry = coachDO(env, C).storage._m.get('mq:retry');
    kv.failPut = false;
    ok('KV caído: el cambio queda anotado y con reintento programado', pend === 1 && retry && retry.n === 1 && coachDO(env, C).storage.alarm, [pend, retry]);
    await fireAlarm(env, 'coach:' + C);
    ok('KV vuelve: el reintento copia el valor más nuevo y limpia la lista', kvRec(env, key).plan[0].name === 'V6' && pendingMirror(env, C).length === 0 && !coachDO(env, C).storage._m.get('mq:retry'));

    // Reintentos espaciados (5 s, 1 min, 10 min, 1 h, 6 h) y KV con una escritura por segundo por key
    kv.failPut = true;
    await call('PUT', '/api/routines/' + r.id, { coach_id: C, plan: [{ name: 'V7', exercises: [] }] });
    const steps = [];
    for (let i = 0; i < 6; i++) {
        const before = coachDO(env, C).storage.alarm;
        await fireAlarm(env, 'coach:' + C);
        steps.push(Math.round((coachDO(env, C).storage.alarm - before) / 1000));
    }
    kv.failPut = false;
    ok('KV sigue caído: los reintentos se espacian hasta 6 h', steps.slice(0, 5).join() === '60,600,3600,21600,21600', steps);
    await fireAlarm(env, 'coach:' + C);
    ok('y cuando vuelve, copia todo', kvRec(env, key).plan[0].name === 'V7' && pendingMirror(env, C).length === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. KV respondiendo 429 (cuota diaria agotada)
// ─────────────────────────────────────────────────────────────────────────────
{
    console.log('\nKV sin cuota de escritura (429)');
    const env = await makeEnv();
    const kv = env.BMOD_KV;
    const call = caller(worker, env);
    const C = 'coach-kv429-01';
    const r = (await call('POST', '/api/routines', { coach_id: C, name: 'Plan', plan: [{ name: 'A', exercises: [] }], alumno_name: 'Mar' })).body;
    const tk = r.share_token;
    kv.failPut = true;
    const out = {
        abre: await call('GET', '/api/shares/' + tk),
        entrena: await call('POST', '/api/shares/' + tk + '/sessions', { date: today(), exercises: [{ name: 'Press', sets: [{ kg: 40, reps: 8 }] }] }),
        control: await call('POST', '/api/shares/' + tk + '/checkins', { date: today(), weight: 70 }),
        video: await call('POST', '/api/shares/' + tk + '/videos', { exercise: 'Press', url: 'https://youtu.be/x1' }),
        ficha: await call('PUT', '/api/routines/' + r.id, { coach_id: C, profile: { goals: 'X' } }),
        rutina: await call('PUT', '/api/routines/' + r.id, { coach_id: C, plan: [{ name: 'B', exercises: [] }] }),
        panel: await call('GET', '/api/routines?paged=1&coach_id=' + C),
        config: await call('PUT', '/api/coach/config', { coach_id: C, intake_questions: ['¿Deporte?'] })
    };
    ok('con KV en 429, el Coach sigue andando (alumno y coach)', Object.values(out).every((o) => o.status < 300), Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.status])));
    const sh = (await call('GET', '/api/shares/' + tk)).body;
    ok('lo guardado se ve enseguida (sale del objeto, no de KV)', sh.sessions.length === 1 && sh.checkins.length === 1 && sh.videos.length === 1 && sh.routine.plan[0].name === 'B');
    const crea = await call('POST', '/api/routines', { coach_id: C, name: 'Nuevo', plan: [{ name: 'A', exercises: [] }], alumno_name: 'Nuevo' });
    const doRows = [...coachDO(env, C).storage._m.keys()].filter((k) => k.startsWith('routine:'));
    ok('crear un alumno sí necesita KV (el link vive ahí): falla entero, sin dejar nada a medias', crea.status === 500 && doRows.length === 1, [crea.status, doRows.length]);
    kv.failPut = false;
    await fireAlarm(env, 'coach:' + C);
    const k = kvRec(env, 'routine:' + C + ':' + r.id);
    ok('cuando KV vuelve, la copia se pone al día sola', k.plan[0].name === 'B' && k.session_count === 1 && pendingMirror(env, C).length === 0 && !!kvRec(env, 'videos:' + r.id), pendingMirror(env, C));

    // Lecturas de KV que fallan durante la migración: no queda un alumno a medio traer
    const kv2 = makeKV();
    const old = await makeEnv({ kv: kv2, doData: false });
    const r2 = (await caller(worker, old)('POST', '/api/routines', { coach_id: C, name: 'Plan', plan: [{ name: 'A', exercises: [] }], alumno_name: 'Ana' })).body;
    await caller(worker, old)('POST', '/api/shares/' + r2.share_token + '/sessions', { date: dayAgo(2) });
    const env2 = await makeEnv({ kv: kv2 });
    const call2 = caller(worker, env2);
    let gets = 0;
    const realGet = kv2.get;
    kv2.get = async (key) => { if (key.startsWith('sessions:') && ++gets === 1) throw new Error('KV GET failed: 500'); return realGet.call(kv2, key); };
    const fails = await call2('POST', '/api/shares/' + r2.share_token + '/sessions', { date: today() });
    const imp = coachDO(env2, C).storage._m.get('imp:' + r2.id);
    const again = await call2('POST', '/api/shares/' + r2.share_token + '/sessions', { date: today() });
    kv2.get = realGet;
    const s2 = JSON.parse(coachDO(env2, C).storage._m.get('sessions:' + r2.id));
    ok('si KV falla en medio de la migración, el pedido falla sin marcar al alumno como traído', fails.status === 500 && imp !== 'f', [fails.status, imp]);
    ok('y el siguiente pedido trae todo bien (la sesión vieja no se pierde)', again.status === 201 && s2.items.length === 2, s2.items.map((x) => x.date));
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Migración, vuelta atrás y "misma respuesta que hoy" contra el Worker anterior
// ─────────────────────────────────────────────────────────────────────────────
let OldWorker = null, OldNotifier = null, oldWhy = '';
try {
    const src = execFileSync('git', ['show', BASE_COMMIT + ':worker/src/index.js'], { cwd: here, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const dir = mkdtempSync(path.join(tmpdir(), 'bm-worker-' + BASE_COMMIT + '-'));
    const file = path.join(dir, 'index.mjs');
    writeFileSync(file, src);
    const mod = await import(pathToFileURL(file).href);
    OldWorker = mod.default; OldNotifier = mod.Notifier;
} catch (e) { oldWhy = 'sin historial de git para ' + BASE_COMMIT + ': ' + String((e && e.message) || e).split('\n')[0]; }

// Recorrido completo de un coach con sus alumnos: lo que la app hace de punta a punta.
async function journey(call, C, phoneSub) {
    const out = [];
    const step = async (name, method, p, body, headers) => { const r = await call(method, p, body, headers); out.push({ name, status: r.status, body: r.body }); return r; };
    await step('config', 'PUT', '/api/coach/config', { coach_id: C, intake_questions: ['¿Deporte?'], terms: '2026-11-14', invite: { text: 'Seguí online', link: 'https://example.test/plan' } });
    const A = (await step('crea A', 'POST', '/api/routines', { coach_id: C, coach_name: 'Profe', name: 'Plan A', plan: [{ name: 'Día 1', exercises: [{ name: 'Sentadilla', rest_s: 90 }] }], alumno_name: 'Ana', alumno_email: 'a@example.test' })).body;
    const B = (await step('crea B', 'POST', '/api/routines', { coach_id: C, name: 'Plan B', plan: [{ name: 'Día 1', exercises: [] }], alumno_name: 'Beto' })).body;
    const Cc = (await step('crea C', 'POST', '/api/routines', { coach_id: C, name: 'Plan C', plan: [{ name: 'Día 1', exercises: [] }], alumno_name: 'Caro' })).body;
    await step('A abre', 'GET', '/api/shares/' + A.share_token);
    await step('A términos', 'POST', '/api/shares/' + A.share_token + '/terms', { version: '2026-11-14' });
    await step('A ficha', 'POST', '/api/shares/' + A.share_token + '/intake', { goals: ['fuerza'], experience: 'nuevo', days: 3, extra: ['Fútbol'] });
    if (phoneSub) await step('A avisos', 'POST', '/api/shares/' + A.share_token + '/push', { subscription: phoneSub, tz: 'America/Argentina/Buenos_Aires', lang: 'es' });
    for (const d of [12, 9, 5, 2]) await step('A entrena ' + d, 'POST', '/api/shares/' + A.share_token + '/sessions', { date: dayAgo(d), exercises: [{ name: 'Sentadilla', sets: [{ kg: 60 + d, reps: 8 }] }] });
    await step('A control', 'POST', '/api/shares/' + A.share_token + '/checkins', { date: dayAgo(1), weight: 70, energy: 2, change: true, ex_trouble: ['Sentadilla'] });
    await step('A cambio', 'POST', '/api/shares/' + A.share_token + '/edits', { changes_json: { ex: 'Sentadilla' }, edited_by: 'alumno', editor_name: 'Ana' });
    const v = (await step('A video', 'POST', '/api/shares/' + A.share_token + '/videos', { exercise: 'Sentadilla', url: 'https://youtu.be/abc' })).body;
    await step('lista simple', 'GET', '/api/routines?coach_id=' + C);
    await step('lista paginada', 'GET', '/api/routines?paged=1&coach_id=' + C);
    await step('detalle A', 'GET', '/api/routines/' + A.id + '?coach_id=' + C);
    await step('rutina A', 'PUT', '/api/routines/' + A.id, { coach_id: C, plan: [{ name: 'Día 1', exercises: [{ name: 'Sentadilla' }, { name: 'Press' }] }] });
    await step('ficha A', 'PUT', '/api/routines/' + A.id, { coach_id: C, profile: { start_date: dayAgo(40), goals: 'Fuerza', modality: 'online', status: 'activo' } });
    await step('revisado A', 'POST', '/api/routines/' + A.id + '/review', { coach_id: C });
    await step('responde video', 'PUT', '/api/routines/' + A.id + '/videos/' + v.video.id, { coach_id: C, reply: 'Bajá lento' });
    await step('evaluación', 'PUT', '/api/routines/' + A.id + '/evals/1', { coach_id: C, results: 'Bien' });
    await step('balance', 'PUT', '/api/routines/' + A.id + '/review', { coach_id: C, results: 'Muy bien' });
    await step('recordatorio', 'PUT', '/api/routines/' + A.id, { coach_id: C, chk_remind: { mode: 'custom', dow: 3, hour: 7 } });
    // Premium del cupo del coach
    const cc = (await step('código coach', 'POST', '/api/admin/codes', { count: 1, product: 'coach', months: 1 }, { 'x-admin-secret': 'test-admin' })).body.codes[0];
    await step('activa coach', 'POST', '/api/license/activate', { code: cc, deviceId: 'dev-coach-journey', coach_id: C });
    await step('cupo', 'POST', '/api/admin/codes', { count: 2, product: 'premium', months: 1, coach_pack: true, coach_code: cc }, { 'x-admin-secret': 'test-admin' });
    await step('da premium', 'POST', '/api/routines/' + A.id + '/premium', { coach_id: C });
    await step('A recibe premium', 'POST', '/api/shares/' + A.share_token + '/premium-auto', { deviceId: 'dev-alumna-ana-01' });
    await step('detalle A con premium', 'GET', '/api/routines/' + A.id + '?coach_id=' + C);
    await step('saca premium', 'DELETE', '/api/routines/' + A.id + '/premium?coach_id=' + C);
    // Código de coach (pack) activado desde el link de B: queda atado a B
    const pack = (await step('pack', 'POST', '/api/admin/codes', { count: 1, product: 'premium', months: 1, coach_pack: true }, { 'x-admin-secret': 'test-admin' })).body.codes[0];
    await step('B activa pack', 'POST', '/api/license/activate', { code: pack, deviceId: 'dev-beto-000001', share: B.share_token });
    // Huésped de hotel: acceso hasta ayer
    await step('B huésped', 'PUT', '/api/routines/' + B.id, { coach_id: C, profile: { guest: true, access_until: dayAgo(1), start_date: dayAgo(4), tz: 'America/Argentina/Buenos_Aires' } });
    await step('B cerrado', 'GET', '/api/shares/' + B.share_token);
    await step('B no carga', 'POST', '/api/shares/' + B.share_token + '/sessions', { date: today() });
    await step('B interés', 'POST', '/api/shares/' + B.share_token + '/interest', { contact: '@beto', note: 'Quiero seguir' });
    await step('detalle B', 'GET', '/api/routines/' + B.id + '?coach_id=' + C);
    // Link nuevo, reportes y baja
    const nl = (await step('link nuevo A', 'POST', '/api/routines/' + A.id + '/new-link', { coach_id: C })).body;
    await step('link viejo A', 'GET', '/api/shares/' + A.share_token);
    await step('link nuevo A abre', 'GET', '/api/shares/' + nl.share_token);
    await step('reporte alumno', 'POST', '/api/shares/' + nl.share_token + '/report', { reason: 'spam', detail: 'x' });
    await step('reporte coach', 'POST', '/api/routines/' + Cc.id + '/report', { coach_id: C, reason: 'otro' });
    await step('C se va', 'POST', '/api/shares/' + Cc.share_token + '/leave', { confirm: true });
    await step('C ya no está', 'GET', '/api/shares/' + Cc.share_token);
    await step('config final', 'GET', '/api/coach/config?coach_id=' + C);
    await step('borra evaluación', 'DELETE', '/api/routines/' + A.id + '/evals/1?coach_id=' + C);
    await step('lista final', 'GET', '/api/routines?paged=1&coach_id=' + C);
    await step('detalle final A', 'GET', '/api/routines/' + A.id + '?coach_id=' + C);
    return { out, A: Object.assign({}, A, { share_token: nl.share_token }), B, C: Cc };
}
// Para comparar dos corridas: ids, links, códigos y fechas cambian en cada una.
function normalize(steps, ignore = []) {
    const vals = [];
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
    const walk = (x, k) => {
        if (Array.isArray(x)) {
            // listas de alumnos: por nombre (los ids son al azar y deciden el orden)
            if (x.length && x.every((y) => y && typeof y === 'object' && 'alumno_name' in y)) x.sort((a, b) => String(a.alumno_name).localeCompare(String(b.alumno_name)));
            x.forEach((y) => walk(y));
            return;
        }
        if (x && typeof x === 'object') {
            // Cambio a propósito (26-nov-2026): el cumplimiento del balance cuenta todo el programa,
            // no un ciclo de 28 días como el Worker de la comparación
            if ((k === 'review' || k === 'review_draft') && x.stats) { delete x.stats.planned; delete x.stats.adherence; delete x.stats.days; }
            for (const kk of Object.keys(x)) {
                if (ignore.includes(kk)) { delete x[kk]; continue; }
                walk(x[kk], kk);
            }
            return;
        }
        if (typeof x === 'string' && !ISO.test(x) && (['id', 'share_token', 'routine_id', 'coach_id', 'code', 'token', 'next'].includes(k) || /^BMOD-|^[0-9a-f]{8}-[0-9a-f]{4}-/.test(x))) if (!vals.includes(x)) vals.push(x);
    };
    const copy = JSON.parse(JSON.stringify(steps));
    copy.forEach((s) => walk(s.body));
    let txt = JSON.stringify(copy);
    // Cada valor al azar pasa a <v0>, <v1>… por orden de aparición: si dos corridas usan el
    // mismo id en lugares distintos, la comparación lo nota.
    const order = new Map(vals.map((v, i) => [v, i]));
    [...vals].sort((a, b) => b.length - a.length).forEach((v) => { txt = txt.split(v).join('<v' + order.get(v) + '>'); });
    txt = txt.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<ts>').replace(/"(next|at)":\d{12,}/g, '"$1":"<n>"');
    return JSON.parse(txt);
}
function firstDiff(a, b, p = '') {
    if (JSON.stringify(a) === JSON.stringify(b)) return null;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], p + '.' + k); if (d) return d; }
    }
    return { path: p, antes: a, ahora: b };
}
async function phone() {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    return { endpoint: 'https://fcm.googleapis.com/fcm/send/journey', keys: { p256dh: Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('base64url'), auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url') } };
}

{
    console.log('\nMisma respuesta que el Worker anterior (' + BASE_COMMIT + ')');
    if (!OldWorker) skip('comparación con el Worker anterior', oldWhy);
    else {
        const sub = await phone();
        const envOld = await makeEnv({ NotifierClass: OldNotifier });
        const envNew = await makeEnv();
        const C = 'coach-contract-0001';
        const jo = await journey(caller(OldWorker, envOld), C, sub);
        const jn = await journey(caller(worker, envNew), C, sub);
        ok('recorrido completo: mismos pasos', jo.out.length === jn.out.length && jo.out.length > 40, [jo.out.length, jn.out.length]);
        const bad = [];
        const no = normalize(jo.out, NEW_FIELDS), nn = normalize(jn.out, NEW_FIELDS);
        for (let i = 0; i < no.length; i++) {
            const d = firstDiff(no[i], nn[i]);
            if (d) bad.push({ paso: jo.out[i].name, d });
        }
        ok('cada respuesta tiene la misma forma y los mismos datos que hoy (' + no.length + ' pasos: alumno, coach, huésped, Premium, link nuevo, baja)', bad.length === 0, bad.slice(0, 3));
        ok('las respuestas no muestran datos de los avisos ni los códigos del alumno', !JSON.stringify(jn.out).includes('fcm.googleapis.com/fcm/send/journey'));
    }
}

{
    console.log('\nMigración desde el formato viejo y vuelta atrás');
    if (!OldWorker) skip('migración y vuelta atrás', oldWhy);
    else {
        const sub = await phone();
        // a) Datos escritos por el Worker anterior → el nuevo los lee igual
        const kv = makeKV();
        const envOld = await makeEnv({ kv, NotifierClass: OldNotifier });
        const C = 'coach-migrate-001';
        const j = await journey(caller(OldWorker, envOld), C, sub);
        const reads = async (call) => [
            await call('GET', '/api/shares/' + j.A.share_token),
            await call('GET', '/api/routines/' + j.A.id + '?coach_id=' + C),
            await call('GET', '/api/routines/' + j.B.id + '?coach_id=' + C),
            await call('GET', '/api/shares/' + j.B.share_token),
            await call('GET', '/api/routines?paged=1&coach_id=' + C),
            await call('GET', '/api/routines?coach_id=' + C),
            await call('GET', '/api/coach/config?coach_id=' + C)
        ].map((r) => ({ status: r.status, body: r.body }));
        const IGN = ['last_seen_by_alumno_at'].concat(NEW_FIELDS);   // "visto" ya no se copia a KV en cada apertura (ver diseño)
        const before = normalize(await reads(caller(OldWorker, envOld)), IGN);
        const envNew = await makeEnv({ kv });
        const callNew = caller(worker, envNew);
        const migrated = normalize(await reads(callNew), IGN);
        ok('el Worker nuevo lee los datos viejos y responde lo mismo (sin borrar nada de KV)', JSON.stringify(before) === JSON.stringify(migrated), firstDiff(before, migrated));
        ok('los datos quedaron en el objeto del coach', [...coachDO(envNew, C).storage._m.keys()].some((k) => k === 'sum:' + j.A.id) && coachDO(envNew, C).storage._m.get('imp:all') === 1);

        // b) El nuevo escribe; se publica el anterior: lee KV y ve lo mismo
        await callNew('POST', '/api/shares/' + j.A.share_token + '/sessions', { date: today(), exercises: [{ name: 'Press', sets: [{ kg: 50, reps: 5 }] }] });
        await callNew('PUT', '/api/routines/' + j.A.id, { coach_id: C, plan: [{ name: 'NUEVO', exercises: [] }] });
        await callNew('POST', '/api/shares/' + j.A.share_token + '/checkins', { date: today(), weight: 71 });
        const nuevo = normalize(await reads(callNew), IGN);
        const atras = normalize(await reads(caller(OldWorker, envOld)), IGN);
        ok('vuelta atrás: el Worker anterior lee KV y ve exactamente lo mismo', JSON.stringify(nuevo) === JSON.stringify(atras), firstDiff(nuevo, atras));

        // c) Mientras se usa el anterior, alguien cambia algo; se vuelve a publicar el nuevo
        await caller(OldWorker, envOld)('PUT', '/api/routines/' + j.A.id, { coach_id: C, plan: [{ name: 'CAMBIO-CON-EL-ANTERIOR', exercises: [] }] });
        const sinEpoch = (await callNew('GET', '/api/shares/' + j.A.share_token)).body.routine.plan[0].name;
        ok('sin cambiar DATA_EPOCH, el objeto no se entera del cambio hecho con el anterior (por eso existe DATA_EPOCH)', sinEpoch === 'NUEVO', sinEpoch);
        envNew.DATA_EPOCH = '2';
        const conEpoch = (await callNew('GET', '/api/shares/' + j.A.share_token)).body.routine.plan[0].name;
        ok('con DATA_EPOCH = 2, el objeto vuelve a traer todo de KV y ve el cambio', conEpoch === 'CAMBIO-CON-EL-ANTERIOR', conEpoch);
        const tras = normalize(await reads(callNew), IGN);
        const viejo = normalize(await reads(caller(OldWorker, envOld)), IGN);
        ok('y responde igual que el anterior sobre los mismos datos', JSON.stringify(tras) === JSON.stringify(viejo), firstDiff(viejo, tras));
    }
}

// Panel: la primera vez lista KV (como hoy); después, nunca más
{
    console.log('\nPanel del coach sin listados de KV');
    const kv = makeKV();
    const old = await makeEnv({ kv, doData: false });
    const callOld = caller(worker, old);
    const C = 'coach-panel-0001';
    const ids = [];
    for (let i = 0; i < 100; i++) ids.push((await callOld('POST', '/api/routines', { coach_id: C, name: 'P', plan: [{ name: 'A', exercises: [] }], alumno_name: 'Alumno ' + String(i).padStart(3, '0') })).body.id);
    const env = await makeEnv({ kv });
    const call = caller(worker, env);
    const allPages = async () => {
        const items = []; let cursor = '', pages = 0;
        do {
            const r = await call('GET', '/api/routines?paged=1&coach_id=' + C + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
            items.push(...r.body.items); cursor = r.body.next; pages++;
        } while (cursor && pages < 10);
        return { items, pages };
    };
    let l0 = kv.l;
    const first = await allPages();
    const lists1 = kv.l - l0;
    ok('primera vez: 100 alumnos en 3 páginas, listando KV como hoy (3 listados)', first.items.length === 100 && first.pages === 3 && lists1 === 3, [first.items.length, first.pages, lists1]);
    l0 = kv.l; const r0 = kv.r;
    const second = await allPages();
    ok('después: los mismos 100, sin listados ni lecturas de KV', second.items.length === 100 && kv.l === l0 && kv.r === r0 && second.items.map((x) => x.id).join() === first.items.map((x) => x.id).join(), [kv.l - l0, kv.r - r0]);
    // Un alumno dado de baja no vuelve aunque una lista vieja de KV lo traiga
    const kv2 = makeKV();
    const old2 = await makeEnv({ kv: kv2, doData: false });
    const a = (await caller(worker, old2)('POST', '/api/routines', { coach_id: C, name: 'P', plan: [], alumno_name: 'Se va' })).body;
    await caller(worker, old2)('POST', '/api/routines', { coach_id: C, name: 'P', plan: [], alumno_name: 'Se queda' });
    const env2 = await makeEnv({ kv: kv2 });
    const snapshot = kv2._m.get('routine:' + C + ':' + a.id);
    await caller(worker, env2)('DELETE', '/api/routines/' + a.id + '?coach_id=' + C);
    kv2._m.set('routine:' + C + ':' + a.id, snapshot);   // lista de KV atrasada
    const lst = (await caller(worker, env2)('GET', '/api/routines?paged=1&coach_id=' + C)).body.items;
    ok('un alumno dado de baja no vuelve por una lista atrasada de KV', lst.length === 1 && lst[0].alumno_name === 'Se queda', lst.map((x) => x.alumno_name));
    // Alumno nuevo durante la migración (antes de que el panel termine): figura en la lista
    const env3 = await makeEnv({ kv: makeKV(), mirror: 'off' });
    const call3 = caller(worker, env3);
    for (let i = 0; i < 50; i++) await caller(worker, Object.assign(Object.create(env3), { DO_DATA: 'off' }))('POST', '/api/routines', { coach_id: C, name: 'P', plan: [], alumno_name: 'V' + i });
    const pass = async () => {
        const out = []; let cursor = '';
        do { const r = (await call3('GET', '/api/routines?paged=1&coach_id=' + C + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''))).body; out.push(...r.items); cursor = r.next; } while (cursor);
        return out.map((x) => x.alumno_name);
    };
    await call3('GET', '/api/routines?paged=1&coach_id=' + C);   // el coach abre la primera página y se va
    await call3('POST', '/api/routines', { coach_id: C, name: 'P', plan: [], alumno_name: 'Recién llegado' });
    const migrated = !!coachDO(env3, C).storage._m.get('imp:all');
    const inKV = [...env3.BMOD_KV._m.keys()].filter((k) => k.startsWith('routine:' + C + ':')).length;
    const names = await pass();
    ok('espejo apagado y panel a medio migrar: el alumno nuevo va igual a KV y aparece en el panel', !migrated && inKV === 51 && names.length === 51 && names.includes('Recién llegado'), [migrated, inKV, names.length]);
    await call3('POST', '/api/routines', { coach_id: C, name: 'P', plan: [], alumno_name: 'Después de migrar' });
    const inKV2 = [...env3.BMOD_KV._m.keys()].filter((k) => k.startsWith('routine:' + C + ':')).length;
    const names2 = await pass();
    ok('con el panel ya migrado y el espejo apagado, el alumno nuevo ya no se copia a KV (y aparece igual)', !!coachDO(env3, C).storage._m.get('imp:all') && inKV2 === 51 && names2.length === 52, [inKV2, names2.length]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Contadores: cuota de IA, pruebas por red y "hoy ya entrené"
// ─────────────────────────────────────────────────────────────────────────────
{
    console.log('\nContadores en el objeto "counters"');
    const env = await makeEnv({ doDelay: 1 });
    env.BMOD_KV.delay = 1;
    env.AI = { run: async () => ({ response: { insights: [{ title: 'a', text: 'b' }] } }) };
    const call = caller(worker, env);
    const code = (await call('POST', '/api/admin/codes', { count: 1, product: 'premium', months: 1 }, { 'x-admin-secret': 'test-admin' })).body.codes[0];
    const tok = (await call('POST', '/api/license/activate', { code, deviceId: 'dev-ia-00000001' })).body.token;
    const w0 = env.BMOD_KV.w;
    const r30 = await Promise.all(Array.from({ length: 30 }, () => call('POST', '/api/oracle', { token: tok, lang: 'es', goal: 'muscle', findings: [{ code: 'progress', facts: { exs: ['Sentadilla'], pct: 5 } }] })));
    ok('30 consultas de IA a la vez: pasan justo 20 (la cuota del día)', r30.filter((r) => r.status === 200).length === 20 && r30.filter((r) => r.status === 429).length === 10, r30.map((r) => r.status).join(''));
    ok('la cuota de IA no gasta escrituras de KV', env.BMOD_KV.w === w0, env.BMOD_KV.w - w0);
    const t10 = await Promise.all(Array.from({ length: 10 }, (_, i) => call('POST', '/api/license/trial', { deviceId: 'dev-tr-par-' + i }, { 'CF-Connecting-IP': '9.9.9.9' })));
    ok('10 pruebas gratis a la vez desde la misma red: pasan justo 5', t10.filter((r) => r.status === 200).length === 5, t10.map((r) => r.status).join());
    // El contador viejo de KV cuenta la primera vez que aparece la red
    const ipH = (await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ip:7.7.7.7')));
    const ipKey = Buffer.from(new Uint8Array(ipH)).toString('base64url').slice(0, 22);
    await env.BMOD_KV.put('trial-ip:premium:' + ipKey, JSON.stringify({ n: 4 }));
    const t2 = [];
    for (let i = 0; i < 3; i++) t2.push((await call('POST', '/api/license/trial', { deviceId: 'dev-tr-old-' + i }, { 'CF-Connecting-IP': '7.7.7.7' })).status);
    ok('una red que ya tenía 4 pruebas (contador viejo en KV) recibe solo 1 más', t2.join() === '200,429,429', t2);

    // Si el objeto de contadores no responde: la IA sigue (mejor regalar unas consultas) y queda en los registros
    const errs = [];
    const realErr = console.error;
    console.error = (...a) => errs.push(a.join(' '));
    env.NOTIFIER.down = true;
    const code2 = (await caller(worker, Object.assign(Object.create(env), { NOTIFIER: undefined }))('POST', '/api/admin/codes', { count: 1, product: 'premium', months: 1 }, { 'x-admin-secret': 'test-admin' })).body.codes[0];
    const tok2 = (await call('POST', '/api/license/activate', { code: code2, deviceId: 'dev-ia-00000002' })).body.token;
    const down = [];
    for (let i = 0; i < 3; i++) down.push((await call('POST', '/api/oracle', { token: tok2, lang: 'es', goal: 'muscle', findings: [{ code: 'progress', facts: { exs: ['Sentadilla'], pct: 5 } }] })).status);
    const trial = await call('POST', '/api/license/trial', { deviceId: 'dev-tr-down-01' }, { 'CF-Connecting-IP': '5.5.5.5' });
    env.NOTIFIER.down = false;
    console.error = realErr;
    ok('contadores sin responder: la IA sigue andando', down.every((s) => s === 200), down);
    ok('y queda en los registros', errs.some((e) => e.includes('[contadores]') && e.includes('IA')), errs.slice(0, 2));
    ok('la prueba gratis también sale (sin contar la red) y queda registrado', trial.status === 200 && errs.some((e) => e.includes('[contadores]') && e.includes('prueba')));

    // "Hoy ya entrené": marcas nuevas en el objeto y las viejas de KV mientras duran
    const tz = 'America/Argentina/Buenos_Aires';
    let at18 = null;
    for (let h = 0; h < 48 && !at18; h++) {
        const t = new Date(Date.now() + h * 3600000);
        t.setUTCMinutes(10, 0, 0);
        if (Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(t)) === 18) at18 = t;
    }
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(at18);
    const subs = ['ep-nuevo', 'ep-viejo', 'ep-nada'].map((x) => 'https://fcm.googleapis.com/fcm/send/' + x);
    for (const s of subs) await call('POST', '/api/push/subscribe', { subscription: { endpoint: s }, tz });
    await withNow(at18.getTime() - 3600000, () => call('POST', '/api/push/trained', { endpoint: subs[0], date: day }));
    const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await env.BMOD_KV.put('pushtr:' + await sha(subs[1]), '1', { metadata: { d: day } });   // marca de antes del cambio
    const sent = [];
    globalThis.fetch = async (u) => { sent.push(String(u)); return new Response('', { status: 201 }); };
    const run = async (when) => { const w = []; await worker.scheduled({ scheduledTime: when.getTime() }, env, { waitUntil: (p) => w.push(p) }); await Promise.all(w); };
    await run(at18);
    ok('a las 18: no le llega a quien entrenó (marca nueva ni marca vieja de KV)', sent.length === 1 && sent[0].endsWith('ep-nada'), sent);
    const l0 = env.BMOD_KV.l;
    await run(new Date(at18.getTime() + 5 * 86400000));
    ok('pasados los 3 días de las marcas viejas, el cron ya no lista KV', env.BMOD_KV.l === l0, env.BMOD_KV.l - l0);
    globalThis.fetch = async () => new Response('', { status: 201 });
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Costo por acción (lo que promete el diseño) y CPU del panel
// ─────────────────────────────────────────────────────────────────────────────
for (const mirror of ['on', 'off']) {
    console.log('\nCosto por acción (espejo ' + (mirror === 'on' ? 'prendido: etapa A' : 'apagado: etapa B') + ')');
    const env = await makeEnv({ mirror });
    env.AI = { run: async () => ({ response: { insights: [{ title: 'a', text: 'b' }] } }) };
    const kv = env.BMOD_KV;
    const call = caller(worker, env);
    const C = 'coach-cost-000' + (mirror === 'on' ? 'A' : 'B');
    const r = (await call('POST', '/api/routines', { coach_id: C, name: 'Plan', plan: [{ name: 'A', exercises: [{ name: 'Press' }] }], alumno_name: 'Vale' })).body;
    for (let i = 0; i < 9; i++) await call('POST', '/api/routines', { coach_id: C, name: 'P', plan: [], alumno_name: 'A' + i });
    await call('GET', '/api/routines?paged=1&coach_id=' + C);   // primera apertura: migra el panel
    const cost = async (fn) => { const a = kv.counts(); await fn(); const b = kv.counts(); return { w: b.w - a.w, r: b.r - a.r, l: b.l - a.l, d: b.d - a.d }; };
    const tk = r.share_token;
    await call('GET', '/api/shares/' + tk);   // la primera vez se trae de KV la configuración del coach (una sola vez)
    const m = {
        abre: await withNow(Date.now() + 2 * 3600000, () => cost(() => call('GET', '/api/shares/' + tk))),   // otra hora: anota "visto"
        entrena: await cost(() => call('POST', '/api/shares/' + tk + '/sessions', { date: today() })),
        control: await cost(() => call('POST', '/api/shares/' + tk + '/checkins', { date: today(), weight: 70 })),
        panel: await cost(() => call('GET', '/api/routines?paged=1&coach_id=' + C)),
        detalle: await cost(() => call('GET', '/api/routines/' + r.id + '?coach_id=' + C)),
        rutina: await cost(() => call('PUT', '/api/routines/' + r.id, { coach_id: C, plan: [{ name: 'B', exercises: [] }] }))
    };
    const code = (await call('POST', '/api/admin/codes', { count: 1, product: 'premium', months: 1 }, { 'x-admin-secret': 'test-admin' })).body.codes[0];
    const tok = (await call('POST', '/api/license/activate', { code, deviceId: 'dev-cost-' + mirror + '-01' })).body.token;
    m.ia = await cost(() => call('POST', '/api/oracle', { token: tok, lang: 'es', goal: 'muscle', findings: [{ code: 'progress', facts: { exs: ['Sentadilla'], pct: 5 } }] }));
    m.prueba = await cost(() => call('POST', '/api/license/trial', { deviceId: 'dev-cost-tr-' + mirror }, { 'CF-Connecting-IP': '3.3.3.3' }));
    m.entrene = await cost(() => call('POST', '/api/push/trained', { endpoint: 'https://fcm.googleapis.com/fcm/send/c1', date: today() }));
    const f = (x) => 'E' + x.w + ' L' + x.r + ' Li' + x.l + ' B' + x.d;
    for (const [k, v] of Object.entries(m)) console.log('    ' + k.padEnd(9) + f(v));
    const A = mirror === 'on';
    ok('el alumno abre su link: 0 escrituras de KV y 1 lectura (el índice del link)', m.abre.w === 0 && m.abre.r === 1, m.abre);
    ok('entrena y manda el control: ' + (A ? '2 escrituras (copia)' : '0 escrituras'), m.entrena.w === (A ? 2 : 0) && m.control.w === (A ? 2 : 0) && m.entrena.r === 1, [m.entrena, m.control]);
    ok('el coach abre el panel y un alumno: 0 listados y 0 lecturas de KV', m.panel.l === 0 && m.panel.r === 0 && m.detalle.r === 0 && m.detalle.l === 0, [m.panel, m.detalle]);
    ok('guardar la rutina: ' + (A ? '1 escritura' : '0 escrituras'), m.rutina.w === (A ? 1 : 0) && m.rutina.r === 0, m.rutina);
    ok('IA y "hoy ya entrené": 0 escrituras de KV; prueba gratis: 1', m.ia.w === 0 && m.entrene.w === 0 && m.prueba.w === 1, [m.ia, m.entrene, m.prueba]);
}
{
    console.log('\nCPU del panel con 300 alumnos (tope del plan gratis: 10 ms por pedido)');
    const env = await makeEnv();
    const call = caller(worker, env);
    const C = 'coach-cpu-00001';
    for (let i = 0; i < 300; i++) {
        const r = (await call('POST', '/api/routines', { coach_id: C, name: 'Plan', plan: Array.from({ length: 5 }, (_, d) => ({ name: 'Día ' + d, exercises: Array.from({ length: 8 }, (_, e) => ({ name: 'Ejercicio ' + e, sets: 4, reps: '8-10' })) })), alumno_name: 'Alumno ' + i })).body;
        if (i % 10 === 0) for (let s = 0; s < 14; s++) await call('POST', '/api/shares/' + r.share_token + '/sessions', { date: dayAgo(s), exercises: [{ name: 'Ejercicio 1', sets: [{ kg: 60, reps: 8 }] }] });
    }
    await call('GET', '/api/routines?paged=1&coach_id=' + C);
    // Tiempo real con todo en memoria (sin red ni demoras): es una cota de la CPU. El reloj de
    // CPU de Node en Windows salta de a 15,6 ms y no sirve para medir esto.
    const page = async () => {
        let cursor = '', pages = 0;
        do { const r = await call('GET', '/api/routines?paged=1&coach_id=' + C + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')); cursor = r.body.next; pages++; } while (cursor && pages < 10);
        return pages;
    };
    for (let i = 0; i < 3; i++) await page();   // calentar
    const t0 = performance.now();
    let pages = 0;
    for (let i = 0; i < 20; i++) pages += await page();
    const per = (performance.now() - t0) / pages;
    console.log('    por página de 45 alumnos (Worker + objeto, en esta PC): ' + per.toFixed(2) + ' ms');
    ok('una página del panel queda bajo 10 ms', per < 10, per);
    const sumSize = JSON.stringify([...coachDO(env, C).storage._m.entries()].filter(([k]) => k.startsWith('sum:')).map(([, v]) => v)).length / 300;
    ok('lo que guarda el panel por alumno es chico (< 2 KB, sin el plan)', sumSize < 2048, Math.round(sumSize));
}

globalThis.fetch = realFetch;
console.log('\n=== ' + pass + ' passed, ' + fail + ' failed' + (skipped ? ', ' + skipped + ' salteados' : '') + ' ===\n');
process.exit(fail === 0 ? 0 : 1);
