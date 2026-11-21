// Test del Worker sin servidor: importa el módulo real y lo ejerce con un env
// mock (KV en memoria). Node 24 ya trae crypto.subtle, Request/Response, btoa,
// crypto.randomUUID/getRandomValues globalmente. Corré con: node test/worker.test.mjs
import worker, { Notifier } from '../src/index.js';
import { routineLite } from '../src/coach-store.js';
import { makeDONamespace } from './do-fake.mjs';

// Se corre dos veces: sin --do, los datos del Coach quedan en KV (DO_DATA = "off", como el
// Worker anterior); con --do, en el objeto de cada coach (lo que corre en producción).
const RUN_DO = process.argv.includes('--do');

// ── KV mock (Map) con get/put/delete/list(prefix,cursor) ──
function makeKV() {
    const m = new Map(), meta = new Map();
    return {
        _m: m,
        async get(k) { return m.has(k) ? m.get(k) : null; },
        async put(k, v, opts) { m.set(k, v); if (opts && opts.metadata) meta.set(k, opts.metadata); else meta.delete(k); },
        async delete(k) { m.delete(k); meta.delete(k); },
        async list({ prefix = '', cursor, limit = 1000 } = {}) {
            // Como el KV real: páginas de hasta `limit` y un cursor mientras queden más
            // (acá el cursor es la última key devuelta).
            const all = [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
            const from = cursor ? all.filter((k) => k <= cursor).length : 0;
            const page = all.slice(from, from + limit);
            const done = from + page.length >= all.length;
            const keys = page.map((name) => (meta.has(name) ? { name, metadata: meta.get(name) } : { name }));
            return { keys, list_complete: done, cursor: done ? null : page[page.length - 1] };
        }
    };
}

const env = {
    BMOD_KV: makeKV(),
    LICENSE_SECRET: 'test-secret-local',
    ADMIN_SECRET: 'test-admin',
    APP_ORIGIN: 'https://example.github.io',
    APP_PATH: '/berserkermod/BERSERKERMOD.html',
    ENABLE_HEALTH_SYNC: 'false'
};

if (RUN_DO) env.NOTIFIER = makeDONamespace(Notifier, env); else env.DO_DATA = 'off';
const coachData = () => !!env.NOTIFIER && env.DO_DATA !== 'off';
// Cambiar a mano un registro guardado (para simular fechas viejas o alumnos de antes). Con los
// datos en el objeto del coach, el cambio va también ahí (KV es solo la copia).
async function setRec(key, rec) {
    env.BMOD_KV._m.set(key, JSON.stringify(rec));
    if (!coachData()) return;
    const [, coach, id] = key.split(':');
    const d = env.NOTIFIER._dos.get('coach:' + coach);
    if (d && d.storage._m.has('routine:' + id)) await d.storage.put({ ['routine:' + id]: JSON.stringify(rec), ['sum:' + id]: routineLite(rec) });
}

// Borrar a mano un alumno (como una baja vieja hecha antes de este cambio).
async function delRec(key) {
    env.BMOD_KV._m.delete(key);
    if (!coachData()) return;
    const [, coach, id] = key.split(':');
    const d = env.NOTIFIER._dos.get('coach:' + coach);
    if (d) { await d.storage.delete(['routine:' + id, 'sum:' + id]); await d.storage.put('gone:' + id, 1); }
}
const counterRows = () => (coachData() && env.NOTIFIER._dos.get('counters') ? env.NOTIFIER._dos.get('counters').storage._m : new Map());

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); } }

function req(method, path, body, headers = {}) {
    const init = { method, headers: { 'Content-Type': 'application/json', ...headers } };
    if (body !== undefined) init.body = JSON.stringify(body);
    return new Request('https://api.test' + path, init);
}
const call = async (method, path, body, headers) => {
    const res = await worker.fetch(req(method, path, body, headers), env);
    let j = null; try { j = await res.json(); } catch {}
    return { status: res.status, body: j, cors: res.headers.get('Access-Control-Allow-Origin') };
};

console.log('\n=== BERSERKERMOD Worker tests (' + (RUN_DO ? 'datos del Coach en Durable Objects' : 'datos del Coach en KV') + ') ===\n');

// ── Ping + CORS ──
{
    console.log('Ping & CORS');
    const r = await call('GET', '/api/health');
    ok('ping ok', r.status === 200 && r.body.ok === true, r.body);
    ok('CORS header presente', r.cors === '*');
    const raw = await worker.fetch(req('GET', '/api/shares/noexistenuncaxx'), env);
    ok('las respuestas no se guardan en el navegador (no-store), tampoco un 404', raw.status === 404 && raw.headers.get('Cache-Control') === 'no-store');
    const opt = await worker.fetch(req('OPTIONS', '/api/routines'), env);
    ok('preflight 204', opt.status === 204 && opt.headers.get('Access-Control-Allow-Methods').includes('DELETE'));
}

// ── Coach: ciclo completo ──
let token, routineId;
{
    console.log('\nCoach: rutinas / shares / edits');
    const create = await call('POST', '/api/routines', { coach_id: 'coachA', name: 'Plan Hipertrofia', plan: [{ day: 'Push' }], alumno_name: 'Juan' });
    ok('crear rutina 201', create.status === 201 && !!create.body.share_token, create.body);
    token = create.body.share_token; routineId = create.body.id;

    const noCoach = await call('POST', '/api/routines', { name: 'x', plan: [] });
    ok('sin coach_id → 401', noCoach.status === 401);

    const list = await call('GET', '/api/routines?coach_id=coachA');
    ok('listar = 1 rutina', Array.isArray(list.body) && list.body.length === 1 && list.body[0].edit_count === 0, list.body);

    const otherCoach = await call('GET', '/api/routines?coach_id=coachB');
    ok('coachB no ve nada', Array.isArray(otherCoach.body) && otherCoach.body.length === 0);

    const share = await call('GET', '/api/shares/' + token);
    ok('share por token público', share.status === 200 && share.body.routine.name === 'Plan Hipertrofia', share.body);
    ok('share NO expone coach_id', share.body.routine.coach_id === undefined);

    const edit = await call('POST', '/api/shares/' + token + '/edits', { changes_json: { type: 'edit_kg', exercise: 'Press', payload: { from: 60, to: 65 } }, editor_name: 'Juan' });
    ok('alumno postea edit 201', edit.status === 201 && edit.body.reviewed_by_coach === false, edit.body);

    const list2 = await call('GET', '/api/routines?coach_id=coachA');
    ok('coach ve 1 edit sin revisar', list2.body[0].edit_count === 1 && list2.body[0].unreviewed_count === 1, list2.body[0]);

    // Adherencia: el alumno registra sesiones desde su link
    const today = new Date().toISOString().slice(0, 10);
    const s1 = await call('POST', '/api/shares/' + token + '/sessions', { day_name: 'Push' });
    ok('alumno registra sesión 201 (fecha = hoy)', s1.status === 201 && s1.body.session.date === today, s1.body);
    const s2 = await call('POST', '/api/shares/' + token + '/sessions', { date: today, day_name: 'Push otra vez' });
    ok('misma fecha → idempotente (pisa)', s2.status === 201);
    const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const s3 = await call('POST', '/api/shares/' + token + '/sessions', { date: monthAgo, day_name: 'Legs' });
    ok('sesión de hace un mes registrada', s3.status === 201 && s3.body.session.date === monthAgo);
    const s4 = await call('POST', '/api/shares/badtoken00/sessions', { day_name: 'x' });
    ok('token inválido → 404', s4.status === 404);

    const listS = await call('GET', '/api/routines?coach_id=coachA');
    ok('coach ve adherencia (2 sesiones, 1 esta semana)', listS.body[0].session_count === 2 && listS.body[0].week_sessions === 1 && listS.body[0].last_session_at === today, listS.body[0]);
    const shareS = await call('GET', '/api/shares/' + token);
    ok('share devuelve sesiones al alumno', Array.isArray(shareS.body.sessions) && shareS.body.sessions.length === 2 && shareS.body.sessions[0].date === today, shareS.body.sessions);
    const detS = await call('GET', '/api/routines/' + routineId + '?coach_id=coachA');
    ok('detalle coach devuelve sesiones (desc)', Array.isArray(detS.body.sessions) && detS.body.sessions.length === 2 && detS.body.sessions[0].date === today && detS.body.sessions[1].date === monthAgo, detS.body.sessions);

    const review = await call('POST', '/api/routines/' + routineId + '/review', { coach_id: 'coachA' });
    ok('review 200', review.status === 200 && review.body.ok === true);

    const list3 = await call('GET', '/api/routines?coach_id=coachA');
    ok('tras review: 0 sin revisar', list3.body[0].unreviewed_count === 0, list3.body[0]);

    const put = await call('PUT', '/api/routines/' + routineId, { coach_id: 'coachA', name: 'Plan v2' });
    ok('PUT actualiza nombre', put.status === 200 && put.body.name === 'Plan v2');

    // Seguridad: un coach ajeno no puede tocar la rutina. Con el aislamiento por
    // clave KV el acceso cruzado da 404 (mejor que 403: no revela existencia).
    // Lo que importa es que el dato quede INTACTO.
    const putForbidden = await call('PUT', '/api/routines/' + routineId, { coach_id: 'coachB', name: 'hack' });
    ok('PUT de otro coach denegado (403/404)', putForbidden.status === 403 || putForbidden.status === 404, putForbidden.status);
    const stillOk = await call('GET', '/api/routines?coach_id=coachA');
    ok('rutina intacta tras PUT ajeno', stillOk.body[0].name === 'Plan v2', stillOk.body[0]);

    const delForbidden = await call('DELETE', '/api/routines/' + routineId + '?coach_id=coachB');
    ok('DELETE de otro coach denegado (403/404)', delForbidden.status === 403 || delForbidden.status === 404, delForbidden.status);
    const stillExists = await call('GET', '/api/routines?coach_id=coachA');
    ok('rutina sigue existiendo tras DELETE ajeno', stillExists.body.length === 1);
}

// ── Coach: sesiones con kg/reps y control semanal (bloque 4) ──
{
    console.log('\nCoach: resultados por sesión y control semanal');
    const cr = await call('POST', '/api/routines', { coach_id: 'coachR', name: 'Fuerza', plan: [{ name: 'A' }], alumno_name: 'Ana' });
    const tk = cr.body.share_token, rid = cr.body.id;
    const today = new Date().toISOString().slice(0, 10);
    const s = await call('POST', '/api/shares/' + tk + '/sessions', {
        day_name: 'A', rpe: 8.4, note: '  Me costó la última serie  ',
        exercises: [
            { name: 'Sentadilla', sets: [{ kg: 80, reps: 8 }, { kg: '82.5', reps: 7 }, { kg: 80, reps: 0 }] },
            { name: 'Cinta', kind: 'cardio', min: 20, km: 3.2 },
            { name: 'Vacío', sets: [] },
            { name: '', sets: [{ kg: 10, reps: 10 }] },
            { name: 'Trucho', sets: [{ kg: 99999, reps: 5 }] }
        ]
    });
    const ex = s.body.session.exercises;
    ok('sesión con resultados 201', s.status === 201 && Array.isArray(ex), s.body);
    ok('series sin reps descartadas, kg en texto aceptado', ex[0].name === 'Sentadilla' && ex[0].sets.length === 2 && ex[0].sets[1].kg === 82.5, ex[0]);
    ok('cardio guarda min y km', ex[1].kind === 'cardio' && ex[1].min === 20 && ex[1].km === 3.2, ex[1]);
    ok('ejercicio vacío o sin nombre no se guarda; kg absurdo queda en 0', ex.length === 3 && ex[2].name === 'Trucho' && ex[2].sets[0].kg === 0, ex);
    ok('rpe redondeado y nota recortada', s.body.session.rpe === 8 && s.body.session.note === 'Me costó la última serie', s.body.session);
    const rpeBad = await call('POST', '/api/shares/' + tk + '/sessions', { date: today, rpe: 42, exercises: 'no-array' });
    ok('rpe fuera de rango y exercises inválido → se ignoran (sigue siendo adherencia)', rpeBad.status === 201 && rpeBad.body.session.rpe === undefined && rpeBad.body.session.exercises === undefined, rpeBad.body);
    const many = Array.from({ length: 30 }, (_, i) => ({ name: 'Ej ' + i, sets: Array.from({ length: 20 }, () => ({ kg: 100, reps: 10 })) }));
    const capped = await call('POST', '/api/shares/' + tk + '/sessions', { date: today, exercises: many });
    ok('tope: 20 ejercicios × 12 series', capped.status === 201 && capped.body.session.exercises.length === 20 && capped.body.session.exercises[0].sets.length === 12, capped.body.session && capped.body.session.exercises.length);
    const fat = await call('POST', '/api/shares/' + tk + '/sessions', { date: today, note: 'x'.repeat(400), exercises: Array.from({ length: 20 }, (_, i) => ({ name: 'N'.repeat(80) + i, sets: Array.from({ length: 12 }, () => ({ kg: 999.9, reps: 199.9 })) })) });
    ok('peor caso válido entra y queda acotado (< 10 KB)', fat.status === 201 && JSON.stringify(fat.body.session).length < 10 * 1024, fat.status);

    // Las 40 más nuevas guardan el detalle; las viejas quedan solo con fecha
    for (let i = 1; i <= 45; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
        await call('POST', '/api/shares/' + tk + '/sessions', { date: d, day_name: 'A', exercises: [{ name: 'Press', sets: [{ kg: 50, reps: 5 }] }] });
    }
    const agg = JSON.parse(env.BMOD_KV._m.get('sessions:' + rid));
    ok('detalle solo en las 40 más nuevas', agg.items.length === 46 && !!agg.items[39].exercises && agg.items[40].exercises === undefined && agg.items[45].date, agg.items.length);

    // Control semanal
    const c0 = await call('POST', '/api/shares/' + tk + '/checkins', {});
    ok('control vacío → 400', c0.status === 400);
    const c1 = await call('POST', '/api/shares/' + tk + '/checkins', { weight: '78.46', energy: 4, note: 'Bien, dormí poco' });
    ok('control 201 (peso con un decimal, semana ISO)', c1.status === 201 && c1.body.checkin.weight === 78.5 && /^\d{4}-W\d{2}$/.test(c1.body.checkin.week), c1.body);
    const lst = await call('GET', '/api/routines?coach_id=coachR');
    ok('lista del coach marca control nuevo', lst.body[0].new_checkin === true && !!lst.body[0].last_checkin_at, lst.body[0]);
    const c2 = await call('POST', '/api/shares/' + tk + '/checkins', { date: today, weight: 78.1, energy: 9 });
    ok('misma semana pisa; energía fuera de rango se ignora', c2.status === 201 && c2.body.checkin.energy === undefined, c2.body);
    const lastWeek = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10);
    await call('POST', '/api/shares/' + tk + '/checkins', { date: lastWeek, weight: 79 });
    const det = await call('GET', '/api/routines/' + rid + '?coach_id=coachR');
    ok('coach ve 2 controles (desc) y las sesiones con detalle', det.body.checkins.length === 2 && det.body.checkins[0].weight === 78.1 && det.body.checkins[1].weight === 79 && !!det.body.sessions[0].exercises, det.body.checkins);
    const lst2 = await call('GET', '/api/routines?coach_id=coachR');
    ok('abrir el detalle marca el control como visto', lst2.body[0].new_checkin === false, lst2.body[0]);
    const sh = await call('GET', '/api/shares/' + tk);
    ok('el alumno ve sus controles', Array.isArray(sh.body.checkins) && sh.body.checkins.length === 2, sh.body.checkins);
    // El coach responde el control de la semana
    const wk = c1.body.checkin.week;
    const rEmpty = await call('PUT', '/api/routines/' + rid + '/checkins/' + wk, { coach_id: 'coachR', reply: '  ' });
    const rOther = await call('PUT', '/api/routines/' + rid + '/checkins/' + wk, { coach_id: 'coachOtro', reply: 'x' });
    const rNoWeek = await call('PUT', '/api/routines/' + rid + '/checkins/2020-W01', { coach_id: 'coachR', reply: 'x' });
    ok('responder el control: vacío → 400, otro coach → no, semana sin control → 404', rEmpty.status === 400 && (rOther.status === 403 || rOther.status === 404) && rNoWeek.status === 404, [rEmpty.status, rOther.status, rNoWeek.status]);
    const rOk = await call('PUT', '/api/routines/' + rid + '/checkins/' + wk, { coach_id: 'coachR', reply: 'Bien la semana. Dormí más: apuntá a 7 h.' });
    ok('responder el control → queda en el control con la fecha', rOk.status === 200 && rOk.body.checkin.reply === 'Bien la semana. Dormí más: apuntá a 7 h.' && !!rOk.body.checkin.reply_at, rOk.body);
    const shR = await call('GET', '/api/shares/' + tk);
    ok('el alumno ve la respuesta en su link', shR.body.checkins[0].reply === 'Bien la semana. Dormí más: apuntá a 7 h.', shR.body.checkins[0]);
    await call('POST', '/api/shares/' + tk + '/checkins', { date: today, weight: 78.0, note: 'Corrijo el peso' });
    const shR2 = await call('GET', '/api/shares/' + tk);
    ok('si el alumno corrige el control de la semana, la respuesta se conserva', shR2.body.checkins[0].weight === 78 && shR2.body.checkins[0].reply === 'Bien la semana. Dormí más: apuntá a 7 h.', shR2.body.checkins[0]);
    const bad = await call('POST', '/api/shares/nonexist00/checkins', { weight: 70 });
    ok('control con token inválido → 404', bad.status === 404);

    // Control ampliado: las seis preguntas y los hábitos
    const full = await call('POST', '/api/shares/' + tk + '/checkins', {
        date: today, trained: 3.4, energy: 4, ex_trouble: ['Sentadilla', 'Sentadilla', 'Press banca', '', 7], ex_text: 'Me molesta la rodilla al bajar',
        sleep: '6a7', recovery: 2, meals: 'medias', water: 'si', habits_text: 'Comí tarde', change: true, change_text: 'Pasar el jueves al viernes', note: 'Todo bien'
    });
    const fc = full.body.checkin || {};
    ok('control ampliado 201 con todos los campos', full.status === 201 && fc.trained === 3 && fc.energy === 4 && fc.sleep === '6a7' && fc.recovery === 2 && fc.meals === 'medias' && fc.water === 'si' && fc.change === true && fc.change_text === 'Pasar el jueves al viernes', fc);
    ok('ejercicios con dificultad: sin repetidos ni vacíos', JSON.stringify(fc.ex_trouble) === JSON.stringify(['Sentadilla', 'Press banca']) && fc.ex_text === 'Me molesta la rodilla al bajar', fc.ex_trouble);
    const junk = await call('POST', '/api/shares/' + tk + '/checkins', { date: today, trained: 40, sleep: '20h', recovery: 9, meals: 'siempre', water: true, ex_trouble: 'Sentadilla', change: 'si' });
    ok('valores fuera de rango o inventados → control vacío (400)', junk.status === 400, junk.body);
    const onlyHabits = await call('POST', '/api/shares/' + tk + '/checkins', { date: today, meals: 'no' });
    ok('solo un hábito alcanza para enviar', onlyHabits.status === 201 && onlyHabits.body.checkin.meals === 'no' && onlyHabits.body.checkin.trained === undefined, onlyHabits.body);
    const onlyText = await call('POST', '/api/shares/' + tk + '/checkins', { date: today, change_text: 'Menos días' });
    ok('texto de cambio sin el sí también marca change', onlyText.status === 201 && onlyText.body.checkin.change === true, onlyText.body);
    const many8 = await call('POST', '/api/shares/' + tk + '/checkins', { date: today, ex_trouble: Array.from({ length: 20 }, (_, i) => 'Ejercicio ' + i + 'x'.repeat(100)) });
    ok('tope: 8 ejercicios de 60 caracteres', many8.status === 201 && many8.body.checkin.ex_trouble.length === 8 && many8.body.checkin.ex_trouble[0].length === 60, many8.body.checkin);
    const otherCoach = await call('GET', '/api/routines/' + rid + '?coach_id=coachB');
    ok('otro coach no ve los controles', otherCoach.status === 404 || otherCoach.status === 403, otherCoach.status);
    await call('DELETE', '/api/routines/' + rid + '?coach_id=coachR');
    ok('borrar la rutina borra sesiones y controles', !env.BMOD_KV._m.has('checkins:' + rid) && !env.BMOD_KV._m.has('sessions:' + rid));
}

// ── Coach: baja del alumno y Premium de coach ──
{
    console.log('\nCoach: baja del alumno y Premium de coach');
    const ADMIN = { 'x-admin-secret': 'test-admin' };
    const code = (c) => JSON.parse(env.BMOD_KV._m.get('code:' + c));
    const lu = (await call('POST', '/api/routines', { coach_id: 'coachZ', name: 'Plan Lu', plan: [{ name: 'A' }], alumno_name: 'Lu' })).body;
    const mati = (await call('POST', '/api/routines', { coach_id: 'coachZ', name: 'Plan Mati', plan: [{ name: 'A' }], alumno_name: 'Mati' })).body;
    const gen = await call('POST', '/api/admin/codes', { count: 3, product: 'premium', months: 3, coach_pack: true, label: 'Entrenador Z' }, ADMIN);
    ok('admin: genera códigos de coach (Premium de 3 meses, con etiqueta)', gen.body.coach_pack === true && gen.body.codes.length === 3 && code(gen.body.codes[0]).coach_pack === true && code(gen.body.codes[0]).label === 'Entrenador Z', gen.body);
    const notCoach = await call('POST', '/api/admin/codes', { count: 1, product: 'coach', coach_pack: true }, ADMIN);
    ok('un código del plan Coach nunca es "de coach para alumnos"', notCoach.body.coach_pack === false && !code(notCoach.body.codes[0]).coach_pack);
    const [c1, c2] = gen.body.codes;
    const own = (await call('POST', '/api/admin/codes', { count: 1, product: 'premium', months: 3 }, ADMIN)).body.codes[0];

    const a1 = await call('POST', '/api/license/activate', { code: c1, deviceId: 'devLu', share: lu.share_token });
    ok('activarlo desde el link del alumno lo ata a ese alumno', a1.status === 200 && code(c1).routine_id === lu.id && code(c1).coach_id === 'coachZ', code(c1));
    const a2 = await call('POST', '/api/license/activate', { code: own, deviceId: 'devLu2', share: lu.share_token });
    ok('un Premium comprado por el alumno no se ata al coach', a2.status === 200 && !code(own).routine_id);

    const a3 = await call('POST', '/api/license/activate', { code: c2, deviceId: 'devMati' });
    ok('activado en Perfil (sin link) todavía no está atado', a3.status === 200 && !code(c2).routine_id);
    const cl = await call('POST', '/api/shares/' + mati.share_token + '/premium-claim', { license: a3.body.token });
    ok('al vincular la rutina en la app, el código se ata al alumno', cl.status === 200 && cl.body.bound === true && code(c2).routine_id === mati.id);
    const cl2 = await call('POST', '/api/shares/' + lu.share_token + '/premium-claim', { license: a3.body.token });
    ok('un código ya atado a un alumno no se pasa a otro', cl2.body.bound === false && code(c2).routine_id === mati.id);
    const cl3 = await call('POST', '/api/shares/' + lu.share_token + '/premium-claim', { license: 'abc.def' });
    const cl4 = await call('POST', '/api/shares/' + lu.share_token + '/premium-claim', { license: a2.body.token });
    ok('licencia inventada o comprada → no se ata', cl3.body.bound === false && cl4.body.bound === false && !code(own).routine_id);

    const list = await call('GET', '/api/routines?coach_id=coachZ');
    ok('el panel marca qué alumnos tienen el Premium del coach', list.body.find((r) => r.id === lu.id).premium === true && list.body.find((r) => r.id === mati.id).premium === true);

    const del = await call('DELETE', '/api/routines/' + lu.id + '?coach_id=coachZ');
    ok('baja: anula el Premium de coach de ese alumno', del.status === 200 && del.body.revoked === 1 && code(c1).revoked === true && code(c1).revoked_reason === 'coach_baja', del.body);
    ok('baja: no toca el Premium comprado ni el de otro alumno', !code(own).revoked && !code(c2).revoked);
    const ver = await call('POST', '/api/license/verify', { token: a1.body.token });
    ok('la licencia anulada deja de verificar (la app vuelve a Free)', ver.body.valid === false, ver.body);
    const re = await call('POST', '/api/license/activate', { code: c1, deviceId: 'devLu' });
    ok('el código anulado no se puede volver a activar', re.status === 403);
    const sh = await call('GET', '/api/shares/' + lu.share_token);
    ok('su link deja de funcionar', sh.status === 404);
    const verOwn = await call('POST', '/api/license/verify', { token: a2.body.token });
    ok('el Premium comprado sigue valiendo', verOwn.body.valid === true);
    await call('DELETE', '/api/routines/' + mati.id + '?coach_id=coachZ');
}

// ── Coach: alertas del panel ──
{
    console.log('\nCoach: alertas del panel');
    const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const C = 'coachAL';
    const mk = async (name, ageDays, plan) => {
        const r = (await call('POST', '/api/routines', { coach_id: C, name, plan: plan || [{ day: 'A' }, { day: 'B' }, { day: 'C' }], alumno_name: name })).body;
        const key = 'routine:' + C + ':' + r.id;
        const rec = JSON.parse(env.BMOD_KV._m.get(key));
        rec.created_at = rec.updated_at = rec.last_coach_update_at = new Date(Date.now() - ageDays * 86400000).toISOString();
        await setRec(key, rec);
        return r;
    };
    const alertsOf = async (id) => ((await call('GET', '/api/routines?coach_id=' + C)).body.find((x) => x.id === id) || {}).alerts || [];
    const has = (al, type) => al.find((a) => a.type === type);

    const nuevo = await mk('Nuevo', 2);
    ok('alumno de 2 días: sin alertas', (await alertsOf(nuevo.id)).length === 0, await alertsOf(nuevo.id));

    const ana = await mk('Ana', 20);
    let al = await alertsOf(ana.id);
    ok('20 días sin registrar nada: no entrena (nunca) y sin control', has(al, 'no_training') && has(al, 'no_training').days === null && has(al, 'no_checkin') && has(al, 'no_checkin').days === null, al);

    // Marca dos entrenamientos sin anotar pesos
    await call('POST', '/api/shares/' + ana.share_token + '/sessions', { date: day(1) });
    await call('POST', '/api/shares/' + ana.share_token + '/sessions', { date: day(3) });
    al = await alertsOf(ana.id);
    ok('sesiones sin pesos: "no registra" y entrena menos de lo planificado (2 de 6)', has(al, 'no_logs') && !has(al, 'no_training') && has(al, 'low_adherence') && has(al, 'low_adherence').done === 2 && has(al, 'low_adherence').planned === 6, al);

    // Tres sesiones con Sentadilla que no mejora → cargas para revisar
    const sq = (kg) => ({ exercises: [{ name: 'Sentadilla', sets: [{ kg, reps: 5 }, { kg: kg - 10, reps: 8 }] }, { name: 'Press', sets: [{ kg: 40, reps: 8 }] }] });
    await call('POST', '/api/shares/' + ana.share_token + '/sessions', Object.assign({ date: day(10) }, sq(100)));
    await call('POST', '/api/shares/' + ana.share_token + '/sessions', Object.assign({ date: day(6) }, sq(100)));
    await call('POST', '/api/shares/' + ana.share_token + '/sessions', Object.assign({ date: day(2) }, sq(97.5)));
    al = await alertsOf(ana.id);
    const ld = has(al, 'loads');
    ok('cargas para revisar: Sentadilla estancada', ld && ld.items.some((x) => x.name === 'Sentadilla' && x.trend === 'stall'), al);
    ok('con sesiones con pesos ya no dice "no registra"', !has(al, 'no_logs'), al);
    const rec = JSON.parse(env.BMOD_KV._m.get('routine:' + C + ':' + ana.id));
    ok('el registro guarda los resúmenes (sesiones rápidas y cargas)', Array.isArray(rec.recent_quick_dates) && rec.recent_quick_dates.length === 2 && rec.loads_review.length >= 1, rec.recent_quick_dates);
    await call('PUT', '/api/routines/' + ana.id, { coach_id: C, plan: [{ day: 'A' }, { day: 'B' }, { day: 'C' }, { day: 'D' }] });
    al = await alertsOf(ana.id);
    ok('si el coach cambia la rutina, la alerta de cargas se apaga', !has(al, 'loads'), al);

    // Bajó de verdad en otro ejercicio
    const bob = await mk('Bob', 30, [{ day: 'A' }]);
    for (const [d, kg] of [[12, 80], [8, 76], [4, 72]]) await call('POST', '/api/shares/' + bob.share_token + '/sessions', { date: day(d), exercises: [{ name: 'Press banca', sets: [{ kg, reps: 6 }] }] });
    al = await alertsOf(bob.id);
    ok('cargas: Press banca bajó', has(al, 'loads') && has(al, 'loads').items[0].trend === 'drop', al);
    ok('3 sesiones de 4 previstas en 2 semanas con plan de 1 día: sin alerta de adherencia', !has(al, 'low_adherence'), al);

    // Controles: dificultad repetida, ánimo bajo dos semanas y pedido de cambio
    await call('POST', '/api/shares/' + ana.share_token + '/checkins', { date: day(8), ex_trouble: ['Sentadilla'], energy: 2 });
    await call('POST', '/api/shares/' + ana.share_token + '/checkins', { date: day(0), ex_trouble: ['Sentadilla', 'Press'], recovery: 1, change: true, change_text: 'Menos días' });
    al = await alertsOf(ana.id);
    ok('dificultad repetida con Sentadilla', has(al, 'repeat_trouble') && JSON.stringify(has(al, 'repeat_trouble').names) === '["Sentadilla"]', al);
    ok('ánimo o descanso bajos dos controles seguidos', !!has(al, 'repeat_low'), al);
    ok('pidió un cambio en el plan', !!has(al, 'plan_change'), al);
    ok('con control reciente no hay "sin control"', !has(al, 'no_checkin'), al);
    await call('PUT', '/api/routines/' + ana.id, { coach_id: C, plan: [{ day: 'A' }, { day: 'B' }, { day: 'C' }] });
    al = await alertsOf(ana.id);
    ok('el pedido de cambio se apaga cuando el coach toca la rutina', !has(al, 'plan_change') && !!has(al, 'repeat_trouble'), al);

    // Evaluación de fin de ciclo
    await call('PUT', '/api/routines/' + bob.id, { coach_id: C, profile: { start_date: day(26) } });
    al = await alertsOf(bob.id);
    ok('evaluación en 2 días (ciclo 1)', has(al, 'eval') && has(al, 'eval').in === 2 && has(al, 'eval').cycle === 1 && has(al, 'eval').date === day(-2), al);
    await call('PUT', '/api/routines/' + bob.id, { coach_id: C, profile: { start_date: day(28) } });
    al = await alertsOf(bob.id);
    ok('evaluación hoy al cumplir 4 semanas', has(al, 'eval') && has(al, 'eval').in === 0, al);
    await call('PUT', '/api/routines/' + bob.id, { coach_id: C, profile: { start_date: day(-5) } });
    ok('programa que empieza en el futuro: sin alertas', (await alertsOf(bob.id)).length === 0);
    await call('PUT', '/api/routines/' + bob.id, { coach_id: C, profile: { start_date: day(26), status: 'pausado' } });
    ok('alumno pausado: sin alertas', (await alertsOf(bob.id)).length === 0);

    // Alumno de antes (sin resúmenes): el detalle los completa y devuelve las alertas
    const key = 'routine:' + C + ':' + ana.id;
    const old = JSON.parse(env.BMOD_KV._m.get(key));
    delete old.recent_quick_dates; delete old.loads_review; delete old.chk_recent;
    await setRec(key, old);
    const det = await call('GET', '/api/routines/' + ana.id + '?coach_id=' + C);
    const after = JSON.parse(env.BMOD_KV._m.get(key));
    ok('el detalle completa los resúmenes de alumnos viejos', Array.isArray(after.chk_recent) && after.chk_recent.length === 2 && Array.isArray(after.loads_review), after.chk_recent);
    ok('el detalle trae las alertas', Array.isArray(det.body.routine.alerts) && !!det.body.routine.alerts.find((a) => a.type === 'repeat_trouble'), det.body.routine.alerts);
    const lst = (await call('GET', '/api/routines?coach_id=' + C)).body;
    ok('lista con alertas para los 3 alumnos sin romper lo demás', lst.length === 3 && lst.every((x) => Array.isArray(x.alerts)), lst.length);
    for (const x of lst) await call('DELETE', '/api/routines/' + x.id + '?coach_id=' + C);
}

// ── Coach: descanso y video por ejercicio, videos de técnica y exportación ──
{
    console.log('\nCoach: video por ejercicio, videos de técnica y exportación');
    const C = 'coachVID';
    const plan = [{ name: 'Día 1', exercises: [
        { name: 'Sentadilla', sets: 3, reps: '8', rest_s: '120', video_url: ' https://youtu.be/abc123 ' },
        { name: 'Press', sets: 3, reps: '10', rest_s: 3, video_url: 'javascript:alert(1)' },
        { name: 'Remo', sets: 3, reps: '10', rest_s: 5000, video_url: 'http://inseguro.com/v' },
        { name: 'Plancha', sets: 3, reps: '30s', video_url: 'https://drive.google.com/file/d/x "onmouseover=alert(1)' }
    ] }];
    const r = (await call('POST', '/api/routines', { coach_id: C, name: 'Plan', plan, alumno_name: 'Vic' })).body;
    const ex = r.plan[0].exercises;
    ok('video del coach: https se guarda (sin espacios)', ex[0].video_url === 'https://youtu.be/abc123' && ex[0].rest_s === 120, ex[0]);
    ok('links peligrosos o sin https se descartan', ex[1].video_url === undefined && ex[2].video_url === undefined && ex[3].video_url === undefined, ex);
    ok('descanso fuera de rango se descarta', ex[1].rest_s === undefined && ex[2].rest_s === undefined, ex);
    const up = await call('PUT', '/api/routines/' + r.id, { coach_id: C, plan: [{ name: 'Día 1', exercises: [{ name: 'Sentadilla', rest_s: 90, video_url: 'data:text/html,hola' }] }] });
    ok('editar la rutina también limpia el plan', up.status === 200 && up.body.plan[0].exercises[0].video_url === undefined && up.body.plan[0].exercises[0].rest_s === 90, up.body.plan);

    const tk = r.share_token;
    const noEx = await call('POST', '/api/shares/' + tk + '/videos', { url: 'https://youtu.be/x1' });
    ok('video sin ejercicio → 400', noEx.status === 400);
    const bad = await call('POST', '/api/shares/' + tk + '/videos', { exercise: 'Sentadilla', url: 'javascript:alert(1)' });
    ok('video con link no https → 400', bad.status === 400);
    const v1 = await call('POST', '/api/shares/' + tk + '/videos', { exercise: 'Sentadilla', url: 'https://youtu.be/sq1', note: 'Me cuesta bajar' });
    ok('video de técnica 201', v1.status === 201 && v1.body.video.exercise === 'Sentadilla' && !!v1.body.video.id && v1.body.video.note === 'Me cuesta bajar', v1.body);
    let lst = (await call('GET', '/api/routines?coach_id=' + C)).body[0];
    ok('alerta: 1 video sin responder', !!lst.alerts.find((a) => a.type === 'video' && a.count === 1), lst.alerts);
    let det = await call('GET', '/api/routines/' + r.id + '?coach_id=' + C);
    ok('el coach ve el video en el detalle', det.body.videos.length === 1 && det.body.videos[0].url === 'https://youtu.be/sq1', det.body.videos);
    const empty = await call('PUT', '/api/routines/' + r.id + '/videos/' + v1.body.video.id, { coach_id: C });
    ok('respuesta vacía → 400', empty.status === 400);
    const other = await call('PUT', '/api/routines/' + r.id + '/videos/' + v1.body.video.id, { coach_id: 'coachOtro', reply: 'x' });
    ok('otro coach no responde', other.status === 404 || other.status === 403, other.status);
    const rep = await call('PUT', '/api/routines/' + r.id + '/videos/' + v1.body.video.id, { coach_id: C, reply: 'Bajá más lento y empujá el piso' });
    ok('el coach responde', rep.status === 200 && rep.body.video.reply === 'Bajá más lento y empujá el piso' && !!rep.body.video.reply_at, rep.body);
    lst = (await call('GET', '/api/routines?coach_id=' + C)).body[0];
    ok('respondido, la alerta se va', !lst.alerts.find((a) => a.type === 'video'), lst.alerts);
    const sh = await call('GET', '/api/shares/' + tk);
    ok('el alumno ve la respuesta por el link', sh.body.videos[0].reply === 'Bajá más lento y empujá el piso', sh.body.videos);
    for (let i = 0; i < 6; i++) await call('POST', '/api/shares/' + tk + '/videos', { exercise: 'Press', url: 'https://youtu.be/p' + i });
    const tope = await call('POST', '/api/shares/' + tk + '/videos', { exercise: 'Press', url: 'https://youtu.be/p9' });
    ok('tope de 6 sin responder → 429', tope.status === 429, tope.status);
    const someId = (await call('GET', '/api/shares/' + tk)).body.videos[0].id;
    const del = await call('DELETE', '/api/shares/' + tk + '/videos/' + someId);
    lst = (await call('GET', '/api/routines?coach_id=' + C)).body[0];
    ok('el alumno saca un video y baja el contador', del.status === 200 && lst.alerts.find((a) => a.type === 'video').count === 5, lst.alerts);

    // Exportación: todas las sesiones y no marca el control como visto
    for (let i = 0; i < 35; i++) await call('POST', '/api/shares/' + tk + '/sessions', { date: new Date(Date.now() - i * 86400000).toISOString().slice(0, 10) });
    await call('POST', '/api/shares/' + tk + '/checkins', { weight: 70 });
    const exp = await call('GET', '/api/routines/' + r.id + '?coach_id=' + C + '&export=1');
    lst = (await call('GET', '/api/routines?coach_id=' + C)).body[0];
    ok('exportar trae todas las sesiones (35) y no marca el control como visto', exp.body.sessions.length === 35 && lst.new_checkin === true, [exp.body.sessions.length, lst.new_checkin]);
    det = await call('GET', '/api/routines/' + r.id + '?coach_id=' + C);
    ok('el detalle normal sigue trayendo 30', det.body.sessions.length === 30);
    await call('DELETE', '/api/routines/' + r.id + '?coach_id=' + C);
    ok('dar de baja borra los videos', !env.BMOD_KV._m.has('videos:' + r.id));
}

// ── Coach: listado de alumnos por páginas (sin tope) ──
{
    console.log('\nCoach: listado de alumnos por páginas');
    const C = 'coachPAG';
    for (let i = 0; i < 52; i++) await call('POST', '/api/routines', { coach_id: C, name: 'Plan ' + i, plan: [{ name: 'A', exercises: [] }], alumno_name: 'Alumno ' + String(i).padStart(2, '0') });
    const old = await call('GET', '/api/routines?coach_id=' + C);
    ok('sin paged: lista simple con las primeras 45 (apps sin actualizar)', Array.isArray(old.body) && old.body.length === 45, old.body && old.body.length);
    const p1 = await call('GET', '/api/routines?paged=1&coach_id=' + C);
    ok('página 1: 45 alumnos y cursor para seguir', p1.status === 200 && p1.body.items.length === 45 && !!p1.body.next && Array.isArray(p1.body.items[0].alerts), [p1.body.items && p1.body.items.length, p1.body.next]);
    const p2 = await call('GET', '/api/routines?paged=1&coach_id=' + C + '&cursor=' + encodeURIComponent(p1.body.next));
    ok('página 2: los 7 que faltan y sin cursor', p2.status === 200 && p2.body.items.length === 7 && p2.body.next === null, [p2.body.items && p2.body.items.length, p2.body.next]);
    const ids = new Set(p1.body.items.concat(p2.body.items).map((x) => x.id));
    ok('entre las dos páginas están los 52, sin repetidos', ids.size === 52, ids.size);
    const longCur = await call('GET', '/api/routines?paged=1&coach_id=' + C + '&cursor=' + 'x'.repeat(2000));
    ok('cursor demasiado largo → 400', longCur.status === 400);
    const other = await call('GET', '/api/routines?paged=1&coach_id=coachSinAlumnos');
    ok('coach sin alumnos: página vacía', other.status === 200 && other.body.items.length === 0 && other.body.next === null, other.body);
    for (const id of ids) await call('DELETE', '/api/routines/' + id + '?coach_id=' + C);
}

// ── Términos de uso y reportes ──
{
    console.log('\nTérminos de uso y reportes');
    const C = '77777777-aaaa-bbbb-cccc-000000000001';
    const ADMIN = { 'x-admin-secret': 'test-admin' };
    const r = (await call('POST', '/api/routines', { coach_id: C, name: 'Plan', plan: [{ name: 'A', exercises: [] }], alumno_name: 'Tere', coach_name: 'Profe' })).body;
    const tk = r.share_token;
    let sh = await call('GET', '/api/shares/' + tk);
    ok('rutina nueva: el alumno todavía no aceptó los términos', sh.body.terms_v === '', sh.body.terms_v);
    const badV = await call('POST', '/api/shares/' + tk + '/terms', { version: 'v1' });
    ok('versión de términos inválida → 400', badV.status === 400);
    const acc = await call('POST', '/api/shares/' + tk + '/terms', { version: '2026-11-14' });
    sh = await call('GET', '/api/shares/' + tk);
    ok('el alumno acepta los términos y queda registrado', acc.status === 200 && sh.body.terms_v === '2026-11-14', sh.body.terms_v);
    const rec1 = JSON.parse(env.BMOD_KV._m.get('routine:' + C + ':' + r.id));
    await call('POST', '/api/shares/' + tk + '/terms', { version: '2026-11-14' });
    const rec2 = JSON.parse(env.BMOD_KV._m.get('routine:' + C + ':' + r.id));
    ok('aceptar de nuevo la misma versión no reescribe la fecha', rec1.terms.at === rec2.terms.at && !!rec1.terms.at, rec2.terms);
    await call('PUT', '/api/coach/config', { coach_id: C, intake_questions: ['¿Deporte?'] });
    const ct = await call('PUT', '/api/coach/config', { coach_id: C, terms: '2026-11-14' });
    const cg = await call('GET', '/api/coach/config?coach_id=' + C);
    ok('el coach acepta los términos sin perder sus preguntas', ct.body.terms_v === '2026-11-14' && cg.body.terms_v === '2026-11-14' && cg.body.intake_questions.length === 1, cg.body);

    const noReason = await call('POST', '/api/shares/' + tk + '/report', { detail: 'algo' });
    ok('reporte sin motivo → 400', noReason.status === 400);
    const badTk = await call('POST', '/api/shares/nonexist00/report', { reason: 'acoso' });
    ok('reporte con link inexistente → 404', badTk.status === 404);
    const rp = await call('POST', '/api/shares/' + tk + '/report', { reason: 'acoso', detail: 'Me escribe cosas fuera de lugar' });
    ok('el alumno reporta a su coach', rp.status === 201 && !!rp.body.id, rp.body);
    const rc = await call('POST', '/api/routines/' + r.id + '/report', { coach_id: C, reason: 'spam', detail: 'x'.repeat(900) });
    ok('el coach reporta a un alumno', rc.status === 201, rc.body);
    const rOther = await call('POST', '/api/routines/' + r.id + '/report', { coach_id: 'coach-de-otro-lado', reason: 'spam' });
    ok('otro coach no puede reportar sobre esta rutina', rOther.status === 404 || rOther.status === 403, rOther.status);
    const noAdmin = await call('GET', '/api/admin/reports');
    ok('la lista de reportes exige la clave de administrador', noAdmin.status === 401);
    const lst = await call('GET', '/api/admin/reports', undefined, ADMIN);
    const mine = lst.body.reports.filter((x) => x.routine_id === r.id);
    ok('el administrador ve los dos reportes con quién, motivo y nombres', mine.length === 2 && mine[0].by === 'coach' && mine[1].by === 'alumno' && mine[1].reason === 'acoso' && mine[1].coach_name === 'Profe' && mine[1].alumno_name === 'Tere' && mine[0].detail.length === 600, mine);
    for (let i = 0; i < 3; i++) await call('POST', '/api/shares/' + tk + '/report', { reason: 'otro' });
    const tope = await call('POST', '/api/shares/' + tk + '/report', { reason: 'otro' });
    ok('tope de 5 reportes por día para la misma rutina → 429', tope.status === 429, tope.status);
    const shAfter = await call('GET', '/api/shares/' + tk);
    ok('el link del alumno no muestra los reportes', !JSON.stringify(shAfter.body).includes('fuera de lugar'));
    await call('DELETE', '/api/routines/' + r.id + '?coach_id=' + C);
    const kept = (await call('GET', '/api/admin/reports', undefined, ADMIN)).body.reports.filter((x) => x.routine_id === r.id);
    ok('los reportes se conservan aunque el alumno ya no esté', kept.length === 5, kept.length);
}

// ── Coach: evaluación de ciclo ──
{
    console.log('\nCoach: evaluación de ciclo');
    const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const C = 'coachEV';
    const r = (await call('POST', '/api/routines', { coach_id: C, name: 'Plan', plan: [{ day: 'A' }, { day: 'B' }], alumno_name: 'Eva' })).body;
    const tk = r.share_token;
    const sinInicio = await call('PUT', '/api/routines/' + r.id + '/evals/1', { coach_id: C, results: 'Bien' });
    ok('sin inicio del programa → 400', sinInicio.status === 400, sinInicio.body);
    let det = await call('GET', '/api/routines/' + r.id + '?coach_id=' + C);
    ok('sin inicio no hay evaluación para armar', det.body.eval_draft === null && Array.isArray(det.body.evals) && det.body.evals.length === 0, det.body.eval_draft);

    await call('PUT', '/api/routines/' + r.id, { coach_id: C, profile: { start_date: day(30), goals: 'Fuerza' } });
    await call('PUT', '/api/routines/' + r.id, { coach_id: C, profile: { start_date: day(30), goals: 'Fuerza y bajar 2 kg' } });
    // Ciclo 1 = day(30) .. day(3): sesiones con Sentadilla que progresa y controles
    for (const [d, kg] of [[29, 60], [22, 62.5], [15, 65], [8, 67.5]]) {
        await call('POST', '/api/shares/' + tk + '/sessions', { date: day(d), exercises: [{ name: 'Sentadilla', sets: [{ kg, reps: 8 }, { kg: kg - 10, reps: 10 }] }, { name: 'Remo', sets: [{ kg: 40, reps: 10 }] }] });
    }
    await call('POST', '/api/shares/' + tk + '/sessions', { date: day(26) });
    await call('POST', '/api/shares/' + tk + '/sessions', { date: day(1), exercises: [{ name: 'Sentadilla', sets: [{ kg: 70, reps: 8 }] }] });   // ya es ciclo 2
    await call('POST', '/api/shares/' + tk + '/checkins', { date: day(28), weight: 70, energy: 3, recovery: 4 });
    await call('POST', '/api/shares/' + tk + '/checkins', { date: day(14), weight: 69.2, energy: 4, ex_trouble: ['Sentadilla'] });
    await call('POST', '/api/shares/' + tk + '/checkins', { date: day(7), weight: 68.6, energy: 5, recovery: 3, ex_trouble: ['Sentadilla'], change: true });

    let lst = (await call('GET', '/api/routines?coach_id=' + C)).body[0];
    const ea = lst.alerts.find((a) => a.type === 'eval');
    ok('alerta: evaluación del ciclo 1 atrasada 2 días', ea && ea.cycle === 1 && ea.late === 2 && ea.in === 0, lst.alerts);
    det = await call('GET', '/api/routines/' + r.id + '?coach_id=' + C);
    const dr = det.body.eval_draft;
    ok('el detalle arma la evaluación del ciclo 1 con su período', dr && dr.cycle === 1 && dr.from === day(30) && dr.to === day(3), dr);
    const st = dr.stats;
    ok('cumplimiento: 5 de 8 (62 %), 4 con pesos', st.sessions === 5 && st.planned === 8 && st.adherence === 63 && st.logged === 4, st);
    const sq = st.exercises.find((e) => e.name === 'Sentadilla');
    ok('progresión: Sentadilla 60 → 67,5 kg (+13 %)', sq && sq.first.kg === 60 && sq.last.kg === 67.5 && sq.change === 13 && sq.n === 4, sq);
    ok('Remo sin cambios: 0 %', st.exercises.find((e) => e.name === 'Remo').change === 0, st.exercises);
    ok('peso 70 → 68,6, ánimo y recuperación promedio', st.weight_from === 70 && st.weight_to === 68.6 && st.energy === 4 && st.recovery === 3.5, st);
    ok('dificultades y pedidos de cambio del ciclo', st.trouble[0].name === 'Sentadilla' && st.trouble[0].n === 2 && st.change_requests === 1, st.trouble);
    ok('objetivo actual y el que reemplazó', st.goal === 'Fuerza y bajar 2 kg' && st.goal_prev[0] === 'Fuerza', st);

    const vacia = await call('PUT', '/api/routines/' + r.id + '/evals/1', { coach_id: C });
    ok('devolución vacía → 400', vacia.status === 400);
    const futura = await call('PUT', '/api/routines/' + r.id + '/evals/3', { coach_id: C, results: 'x' });
    ok('ciclo que no empezó → 400', futura.status === 400);
    const otro = await call('PUT', '/api/routines/' + r.id + '/evals/1', { coach_id: 'coachX', results: 'x' });
    ok('otro coach no puede evaluar', otro.status === 404 || otro.status === 403, otro.status);
    const sv = await call('PUT', '/api/routines/' + r.id + '/evals/1', { coach_id: C, results: 'Subiste 7,5 kg en sentadilla', difficulties: 'Molestia en la rodilla', goals: 'Sumamos bajar 2 kg', next: 'Ciclo 2: más volumen de piernas', extra: 'no' });
    ok('evaluación guardada 201 con datos fijos y textos', sv.status === 201 && sv.body.eval.cycle === 1 && sv.body.eval.stats.sessions === 5 && sv.body.eval.next === 'Ciclo 2: más volumen de piernas' && sv.body.eval.extra === undefined, sv.body);
    lst = (await call('GET', '/api/routines?coach_id=' + C)).body[0];
    ok('hecha la evaluación, la alerta se va', !lst.alerts.find((a) => a.type === 'eval'), lst.alerts);
    det = await call('GET', '/api/routines/' + r.id + '?coach_id=' + C);
    ok('el detalle trae la evaluación y ofrece la del ciclo 2 (en curso)', det.body.evals.length === 1 && det.body.eval_draft.cycle === 2 && det.body.eval_draft.stats.days === 3, det.body.eval_draft);
    const sh = await call('GET', '/api/shares/' + tk);
    ok('el alumno ve su evaluación por el link', Array.isArray(sh.body.evals) && sh.body.evals[0].results === 'Subiste 7,5 kg en sentadilla' && !!sh.body.evals[0].stats, sh.body.evals);
    const created = sv.body.eval.created_at;
    const ed = await call('PUT', '/api/routines/' + r.id + '/evals/1', { coach_id: C, results: 'Editada' });
    ok('editar: 200, conserva la fecha de creación y reemplaza los textos', ed.status === 200 && ed.body.eval.created_at === created && ed.body.eval.results === 'Editada' && ed.body.eval.next === undefined, ed.body);
    const del = await call('DELETE', '/api/routines/' + r.id + '/evals/1?coach_id=' + C);
    lst = (await call('GET', '/api/routines?coach_id=' + C)).body[0];
    ok('borrar la evaluación vuelve a pedirla', del.status === 200 && !!lst.alerts.find((a) => a.type === 'eval' && a.cycle === 1), lst.alerts);
    await call('PUT', '/api/routines/' + r.id + '/evals/1', { coach_id: C, results: 'Otra vez' });
    // La fecha local del coach manda (dentro de ±1 día de la del servidor)
    const lstLocal = (await call('GET', '/api/routines?coach_id=' + C + '&today=' + day(-1))).body[0];
    const lstFar = (await call('GET', '/api/routines?coach_id=' + C + '&today=' + day(-9))).body[0];
    ok('today del coach: ±1 día se acepta, más lejos se ignora', !lstLocal.alerts.find((a) => a.type === 'eval') && !lstFar.alerts.find((a) => a.type === 'eval' && a.cycle === 2), [lstLocal.alerts, lstFar.alerts]);
    await call('DELETE', '/api/routines/' + r.id + '?coach_id=' + C);
    ok('dar de baja borra las evaluaciones', !env.BMOD_KV._m.has('evals:' + r.id));
}

// ── Coach: panel atado al código y ficha del alumno ──
{
    console.log('\nCoach: panel atado al código y ficha del alumno');
    const ADMIN = { 'x-admin-secret': 'test-admin' };
    const code = (c) => JSON.parse(env.BMOD_KV._m.get('code:' + c));
    const coachCode = (await call('POST', '/api/admin/codes', { count: 1, product: 'coach', months: 3 }, ADMIN)).body.codes[0];
    const PANEL = '11111111-2222-3333-4444-555555555555', OTRO = '99999999-8888-7777-6666-555555555555';
    const a1 = await call('POST', '/api/license/activate', { code: coachCode, deviceId: 'celViejo', coach_id: PANEL });
    ok('al activar el código de Coach, el panel queda atado', a1.status === 200 && a1.body.coach_id === PANEL && code(coachCode).panel_id === PANEL, a1.body);
    const a2 = await call('POST', '/api/license/activate', { code: coachCode, deviceId: 'celNuevo', coach_id: OTRO });
    ok('en un teléfono nuevo, el mismo código devuelve el mismo panel', a2.status === 200 && a2.body.coach_id === PANEL && code(coachCode).panel_id === PANEL, a2.body);
    const prem = (await call('POST', '/api/admin/codes', { count: 1, product: 'premium', months: 1 }, ADMIN)).body.codes[0];
    const a3 = await call('POST', '/api/license/activate', { code: prem, deviceId: 'devP', coach_id: OTRO });
    ok('un código Premium no ata ningún panel', a3.status === 200 && !a3.body.coach_id && !code(prem).panel_id);

    const legacy = (await call('POST', '/api/admin/codes', { count: 1, product: 'coach', months: 3 }, ADMIN)).body.codes[0];
    const la = await call('POST', '/api/license/activate', { code: legacy, deviceId: 'devL' });
    const b1 = await call('POST', '/api/coach/bind', { license: la.body.token, coach_id: OTRO });
    ok('un coach que ya tenía el código activado ata su panel con /coach/bind', b1.status === 200 && b1.body.coach_id === OTRO && code(legacy).panel_id === OTRO);
    const b2 = await call('POST', '/api/coach/bind', { license: la.body.token, coach_id: PANEL });
    ok('/coach/bind no pisa un panel ya atado (devuelve el original)', b2.body.coach_id === OTRO);
    const b3 = await call('POST', '/api/coach/bind', { license: a3.body.token, coach_id: PANEL });
    const b4 = await call('POST', '/api/coach/bind', { license: 'x.y', coach_id: PANEL });
    ok('/coach/bind rechaza licencias Premium o inventadas', b3.status === 401 && b4.status === 401);

    // Dos dispositivos para el Coach (celular y compu); un tercero saca al más viejo
    const valid = async (tok) => (await call('POST', '/api/license/verify', { token: tok })).body.valid === true;
    ok('Coach: el celular y la compu quedan activos a la vez (sin contar como cambio de teléfono)', await valid(a1.body.token) && await valid(a2.body.token) && !code(coachCode).rebinds, [code(coachCode).devices, code(coachCode).rebinds]);
    const a4 = await call('POST', '/api/license/activate', { code: coachCode, deviceId: 'compu3', coach_id: OTRO });
    ok('Coach: un tercer dispositivo saca al más viejo y cuenta como cambio', a4.status === 200 && a4.body.coach_id === PANEL && !(await valid(a1.body.token)) && await valid(a2.body.token) && await valid(a4.body.token) && code(coachCode).rebinds === 1, code(coachCode).devices);
    const b5 = await call('POST', '/api/coach/bind', { license: a2.body.token, coach_id: OTRO });
    ok('Coach: el segundo dispositivo también recupera su panel', b5.status === 200 && b5.body.coach_id === PANEL, b5.body);
    const prem2 = await call('POST', '/api/license/activate', { code: prem, deviceId: 'devP2' });
    ok('Premium sigue en un solo teléfono: activarlo en otro saca al anterior', prem2.status === 200 && !(await valid(a3.body.token)) && await valid(prem2.body.token));

    const cfg0 = await call('PUT', '/api/coach/config', { coach_id: PANEL, intake_questions: ['¿Practicás otro deporte?', '', '¿Qué horario preferís?', 'cuarta', 'quinta'] });
    ok('el coach guarda hasta 3 preguntas propias', cfg0.status === 200 && cfg0.body.intake_questions.length === 3 && cfg0.body.intake_questions[0] === '¿Practicás otro deporte?', cfg0.body);
    const r = (await call('POST', '/api/routines', { coach_id: PANEL, name: 'Plan Caro', plan: [{ name: 'A' }], alumno_name: 'Caro' })).body;

    // Cobros (anotador del coach, sin mover plata)
    {
        const iso = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
        const itemOf = async () => (await call('GET', '/api/routines?coach_id=' + PANEL + '&paged=1')).body.items.find((x) => x.id === r.id);
        const bad = await call('PUT', '/api/routines/' + r.id, { coach_id: PANEL, billing: { amount: 15000, period: 'm1', due: '2026-02-30' } });
        ok('cobro con una fecha que no existe → 400', bad.status === 400);
        const late = await call('PUT', '/api/routines/' + r.id, { coach_id: PANEL, billing: { amount: 15000, period: 'm1', due: '2026-01-31', note: 'Transferencia' } });
        ok('anotar el cobro no cuenta como "tu coach actualizó la rutina"', late.status === 200 && late.body.billing.amount === 15000 && late.body.last_coach_update_at === r.last_coach_update_at, late.body.billing);
        let it = await itemOf();
        ok('la lista trae el cobro y la alerta de vencido con los días', it.billing && it.billing.due === '2026-01-31' && it.alerts.some((a) => a.type === 'pay_late' && a.days > 100), it.alerts);
        const sh = await call('GET', '/api/shares/' + r.share_token);
        ok('el cobro no viaja al link del alumno', !JSON.stringify(sh.body).includes('15000') && !JSON.stringify(sh.body).includes('billing'));
        await call('PUT', '/api/routines/' + r.id, { coach_id: PANEL, billing_paid: { date: iso(0) } });
        const p2 = await call('PUT', '/api/routines/' + r.id, { coach_id: PANEL, billing_paid: { date: iso(0), amount: 16000 } });
        ok('"pagó" corre el vencimiento un mes y respeta el día 31 (31-ene → 28-feb → 31-mar)', p2.body.billing.due === '2026-03-31' && p2.body.billing.paid.length === 2 && p2.body.billing.paid[0].amount === 16000 && p2.body.billing.paid[1].amount === 15000, p2.body.billing);
        const un = await call('PUT', '/api/routines/' + r.id, { coach_id: PANEL, billing_undo: true });
        ok('deshacer el último pago vuelve el vencimiento atrás', un.body.billing.due === '2026-02-28' && un.body.billing.paid.length === 1, un.body.billing);
        await call('PUT', '/api/routines/' + r.id, { coach_id: PANEL, billing: { amount: 9000, period: 'w2', due: iso(2) } });
        it = await itemOf();
        ok('cobro cada 15 días que vence en 2 → alerta "por vencer"', it.alerts.some((a) => a.type === 'pay_due' && a.in === 2) && !it.alerts.some((a) => a.type === 'pay_late'), it.alerts);
        const w2 = await call('PUT', '/api/routines/' + r.id, { coach_id: PANEL, billing_paid: {} });
        ok('cada 15 días: "pagó" corre el vencimiento 14 días', w2.body.billing.due === new Date(Date.parse(iso(2) + 'T00:00:00Z') + 14 * 86400000).toISOString().slice(0, 10), w2.body.billing.due);
        await call('PUT', '/api/routines/' + r.id, { coach_id: PANEL, billing: null });
        it = await itemOf();
        ok('borrar el cobro saca el dato y sus alertas', it.billing === null && !it.alerts.some((a) => /^pay_/.test(a.type)));
    }

    // Metas de comida, carpeta de fotos y marca del coach (fase 3)
    {
        const badT = await call('PUT', '/api/routines/' + r.id, { coach_id: PANEL, targets: { kcal: 50, protein: 5000 } });
        ok('metas fuera de rango → 400', badT.status === 400);
        const tg = await call('PUT', '/api/routines/' + r.id, { coach_id: PANEL, targets: { kcal: 2300.4, protein: 150, note: 'Priorizá la proteína en el desayuno' } });
        ok('el coach pone metas de comida (sin avisar "rutina actualizada")', tg.status === 200 && tg.body.targets.kcal === 2300 && tg.body.targets.protein === 150 && tg.body.last_coach_update_at === r.last_coach_update_at, tg.body.targets);
        const badL = await call('PUT', '/api/routines/' + r.id, { coach_id: PANEL, photos_link: 'javascript:alert(1)' });
        ok('carpeta de fotos que no es https → 400', badL.status === 400);
        await call('PUT', '/api/routines/' + r.id, { coach_id: PANEL, photos_link: 'https://drive.google.com/drive/folders/abc123' });
        const badB = await call('PUT', '/api/coach/config', { coach_id: PANEL, brand: { name: 'Caro Fit', logo: 'data:image/svg+xml;base64,PHN2Zz4=' } });
        ok('logo que no es una imagen png/jpeg/webp → 400', badB.status === 400);
        const br = await call('PUT', '/api/coach/config', { coach_id: PANEL, brand: { name: 'Caro Fit Studio', color: '#ff4d57', logo: 'data:image/webp;base64,UklGRg==' } });
        ok('el coach guarda su marca (color de la lista, en mayúsculas)', br.status === 200 && br.body.brand.name === 'Caro Fit Studio' && br.body.brand.color === '#FF4D57', br.body.brand);
        await call('PUT', '/api/coach/config', { coach_id: PANEL, brand: { name: 'Caro Fit Studio', color: '#123456' } });
        const cfgB = await call('GET', '/api/coach/config?coach_id=' + PANEL);
        ok('un color fuera de la lista no se guarda', cfgB.body.brand.color === '', cfgB.body.brand);
        await call('PUT', '/api/coach/config', { coach_id: PANEL, brand: { name: 'Caro Fit Studio', color: '#FF4D57', logo: 'data:image/webp;base64,UklGRg==' } });
        const ck = await call('POST', '/api/shares/' + r.share_token + '/checkins', { photos: true });
        ok('control con solo "subí fotos" → se guarda', ck.status === 201 && ck.body.checkin.photos === true, ck.body);
        const shT = await call('GET', '/api/shares/' + r.share_token);
        ok('el link del alumno trae metas, carpeta de fotos y la marca', shT.body.targets.kcal === 2300 && shT.body.targets.protein === 150 && shT.body.targets.note.includes('desayuno') && shT.body.photos_link.includes('drive.google.com') && shT.body.brand.name === 'Caro Fit Studio' && shT.body.brand.logo.startsWith('data:image/webp'), [shT.body.targets, shT.body.photos_link, shT.body.brand && shT.body.brand.name]);
        await call('PUT', '/api/routines/' + r.id, { coach_id: PANEL, targets: null, photos_link: '' });
        await call('PUT', '/api/coach/config', { coach_id: PANEL, brand: null });
        const shT2 = await call('GET', '/api/shares/' + r.share_token);
        ok('borrar metas, carpeta y marca los saca del link', shT2.body.targets === null && shT2.body.photos_link === '' && shT2.body.brand === null);
    }
    const sh0 = await call('GET', '/api/shares/' + r.share_token);
    ok('el link del alumno trae las preguntas del coach y la ficha vacía', sh0.body.intake === null && sh0.body.intake_questions.length === 3);
    const noConsent = await call('POST', '/api/shares/' + r.share_token + '/intake', { goals: ['fuerza'], limitations: 'Hernia lumbar' });
    ok('sin consentimiento no se guardan limitaciones de salud', noConsent.status === 400);
    const empty = await call('POST', '/api/shares/' + r.share_token + '/intake', { goals: ['inventado'] });
    ok('una ficha vacía se rechaza (y no acepta opciones inventadas)', empty.status === 400);
    const ik = await call('POST', '/api/shares/' + r.share_token + '/intake', { goals: ['fuerza', 'musculo', 'xx'], experience: '1a3', days: 4, schedule: 'mañanas', equipment: ['gimnasio'], limitations: 'Hernia lumbar', consent: true, contact: '+54 9 294 000', extra: ['Fútbol los sábados', '', 'Tarde'] });
    ok('el alumno manda su ficha con consentimiento', ik.status === 201 && ik.body.intake.goals.join() === 'fuerza,musculo' && ik.body.intake.consent === true && ik.body.intake.extra.length === 2, ik.body);
    const det = await call('GET', '/api/routines/' + r.id + '?coach_id=' + PANEL);
    ok('el coach ve la ficha en el detalle', det.body.routine.intake && det.body.routine.intake.limitations === 'Hernia lumbar');
    const list = await call('GET', '/api/routines?coach_id=' + PANEL);
    ok('la lista marca la ficha completa y el estado', list.body[0].intake_done === true && list.body[0].status === 'activo');

    const before = det.body.routine.last_coach_update_at;
    const p1 = await call('PUT', '/api/routines/' + r.id, { coach_id: PANEL, profile: { modality: 'Digital Seguimiento', start_date: '2026-11-10', status: 'activo', goals: 'Ganar fuerza', notes: 'Cuidar la zona lumbar' } });
    ok('el coach completa su parte de la ficha (sin avisar al alumno de un cambio de rutina)', p1.status === 200 && p1.body.profile.modality === 'Digital Seguimiento' && p1.body.last_coach_update_at === before);
    const p2 = await call('PUT', '/api/routines/' + r.id, { coach_id: PANEL, profile: { modality: 'Digital Seguimiento', start_date: '2026-11-10', status: 'activo', goals: 'Priorizar glúteos y piernas', notes: 'Cuidar la zona lumbar' } });
    ok('cambiar el objetivo guarda el anterior en el historial', p2.body.profile.goals === 'Priorizar glúteos y piernas' && p2.body.goal_history.length === 1 && p2.body.goal_history[0].goals === 'Ganar fuerza', p2.body.goal_history);
    const sh1 = await call('GET', '/api/shares/' + r.share_token);
    ok('las notas privadas del coach no llegan al link del alumno', !JSON.stringify(sh1.body).includes('Cuidar la zona') && JSON.stringify(sh1.body).includes('Hernia lumbar'));
    ok('el link no expone la ficha del coach', !('profile' in sh1.body.routine) && !JSON.stringify(sh1.body.routine).includes('Cuidar'));
    const bad = await call('PUT', '/api/coach/config', { coach_id: 'x', intake_questions: ['a'] });
    ok('config con un panel inválido → 401', bad.status === 401);
    await call('DELETE', '/api/routines/' + r.id + '?coach_id=' + PANEL);
}

// ── Licencias: admin codes + activate + verify + binding ──
let code, licToken;
{
    console.log('\nLicencias');
    const noauth = await call('POST', '/api/admin/codes', { count: 2, product: 'coach' });
    ok('admin sin secret → 401', noauth.status === 401);

    const gen = await call('POST', '/api/admin/codes', { count: 2, product: 'coach' }, { 'x-admin-secret': 'test-admin' });
    ok('admin genera 2 códigos', gen.status === 200 && gen.body.codes.length === 2, gen.body);
    code = gen.body.codes[0];
    ok('formato código BMOD-XXXX-XXXX', /^BMOD-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), code);

    const badCode = await call('POST', '/api/license/activate', { code: 'BMOD-ZZZZ-ZZZZ', deviceId: 'dev1' });
    ok('código inexistente → 404', badCode.status === 404);

    const act = await call('POST', '/api/license/activate', { code, deviceId: 'dev1' });
    ok('activar 200 + token + premium', act.status === 200 && !!act.body.token && act.body.tier === 'premium', act.body);
    licToken = act.body.token;

    const reactivateSame = await call('POST', '/api/license/activate', { code, deviceId: 'dev1' });
    ok('reactivar mismo device (idempotente) ok', reactivateSame.status === 200 && !!reactivateSame.body.token);

    // Coach: un segundo dispositivo (la compu) se suma; con un tercero sale el más viejo
    const otherDevice = await call('POST', '/api/license/activate', { code, deviceId: 'dev2' });
    ok('cambio de device → re-bind 200 (no bloquea)', otherDevice.status === 200 && !!otherDevice.body.token, otherDevice.body);
    const both = await call('POST', '/api/license/verify', { token: licToken });
    ok('Coach con 2 dispositivos: el primero sigue válido', both.body.valid === true, both.body);
    await call('POST', '/api/license/activate', { code, deviceId: 'dev3' });
    // con el tercero, el más viejo (dev1) ya no valida (device_mismatch)
    const oldDeviceVerify = await call('POST', '/api/license/verify', { token: licToken });
    ok('token del device viejo → inválido tras mover', oldDeviceVerify.body.valid === false && oldDeviceVerify.body.reason === 'device_mismatch', oldDeviceVerify.body);
    // re-activamos en dev1 para el resto de los asserts
    const back = await call('POST', '/api/license/activate', { code, deviceId: 'dev1' });
    licToken = back.body.token;

    const verify = await call('POST', '/api/license/verify', { token: licToken });
    ok('verify token válido', verify.status === 200 && verify.body.valid === true && verify.body.tier === 'premium', verify.body);

    const tampered = licToken.slice(0, -3) + (licToken.slice(-3) === 'AAA' ? 'BBB' : 'AAA');
    const verifyBad = await call('POST', '/api/license/verify', { token: tampered });
    ok('verify token manipulado → valid:false', verifyBad.body.valid === false, verifyBad.body);

    const verifyGarbage = await call('POST', '/api/license/verify', { token: 'no-es-un-token' });
    ok('verify basura → valid:false', verifyGarbage.body.valid === false);
}

// ── Trials (anti-reinstall) ──
{
    console.log('\nTrials');
    const t1 = await call('POST', '/api/license/trial', { deviceId: 'devTrial', product: 'coach' });
    ok('primer trial coach 200 (10 días)', t1.status === 200 && t1.body.trial === true && t1.body.days === 10, t1.body);
    const t2 = await call('POST', '/api/license/trial', { deviceId: 'devTrial', product: 'coach' });
    ok('segundo trial mismo device → 409', t2.status === 409, t2.body);
    const t3 = await call('POST', '/api/license/trial', { deviceId: 'devTrial', product: 'premium' });
    ok('trial de otro producto sí (7 días)', t3.status === 200 && t3.body.days === 7, t3.body);
}

// ── Mercado Pago: retrieve pendiente ──
{
    console.log('\nMercado Pago retrieve');
    const pend = await call('GET', '/api/license/retrieve?payment=99999');
    ok('retrieve sin pago → pending', pend.status === 200 && pend.body.status === 'pending', pend.body);
    // simular que el webhook ya guardó un código para el pago
    await env.BMOD_KV.put('payment:12345', 'BMOD-TEST-CODE');
    const ready = await call('GET', '/api/license/retrieve?payment=12345');
    ok('retrieve con pago → ready + code', ready.body.status === 'ready' && ready.body.code === 'BMOD-TEST-CODE', ready.body);
}

const oracleBody = (token) => ({ token, lang: 'es', goal: 'muscle', findings: [{ code: 'progress', facts: { exs: ['Sentadilla'], pct: 5 } }] });
// ── Oracle: la app manda los hallazgos (calc.js); el Worker arma el pedido y revisa la respuesta ──
{
    console.log('\nOracle');
    const empty = await call('POST', '/api/oracle', {});
    ok('sin hallazgos → 400', empty.status === 400);
    const old = await call('POST', '/api/oracle', { prompt: 'analizá', apiKey: 'sk-ant-x' });
    ok('app vieja (pedido armado o clave de Anthropic) → 400 "actualizá la app"', old.status === 400 && old.body.code === 'oracle_update', old.body);
    const F = [
        { code: 'below_maint_gain', facts: { kcal: 2150, maint: 2750, target: 3150 } },
        { code: 'protein_low', facts: { prot: 95, perKg: 1.2, target: 164 } },
        { code: 'progress', facts: { exs: ['Sentadilla', 'Press Banca'], pct: 6 } }
    ];
    const noLic = await call('POST', '/api/oracle', { findings: F });
    ok('sin licencia → 403', noLic.status === 403, noLic.status);
    const gen = await call('POST', '/api/admin/codes', { count: 1, product: 'premium' }, { 'x-admin-secret': 'test-admin' });
    const tk = (await call('POST', '/api/license/activate', { code: gen.body.codes[0], deviceId: 'oracle-dev' })).body.token;
    const ask = (extra) => call('POST', '/api/oracle', Object.assign({ token: tk, findings: F, goal: 'muscle', level: 'intermediate', age: 30, lang: 'es' }, extra || {}));
    const fx = await ask();
    ok('sin IA → 200 con el texto fijo de cada hallazgo, en castellano', fx.status === 200 && fx.body.source === 'fijo' && fx.body.insights.length === 3 && /Comés unas 2150 kcal/.test(fx.body.insights[0].text) && /3150/.test(fx.body.insights[0].text) && /Sentadilla y Press Banca/.test(fx.body.insights[2].text), fx.body);
    const fxEn = await ask({ lang: 'en' });
    ok('los decimales van con coma en castellano y con punto en inglés', /1,2 g por kilo/.test(fx.body.insights[1].text) && /1\.2 g per kg/.test(fxEn.body.insights[1].text) && /Sentadilla and Press Banca/.test(fxEn.body.insights[2].text), [fx.body.insights[1], fxEn.body.insights[1]]);
    let model = null, sent = null;
    env.AI = {
        async run(m, opts) {
            model = m; sent = opts.messages[0].content;
            return { response: 'Acá va:\n' + JSON.stringify({ insights: [
                { icon: '🍽️', title: 'Comé más para crecer', text: 'Comés 2150 kcal y tu mantenimiento es 2.750: subí a unas 3150.' },
                { icon: '🥩', title: 'Más proteína', text: 'Llegá a 164 g por día; hoy comés 95 g (1,2 g por kilo).' },
                { icon: '📈', title: 'Vas bien', text: 'Sentadilla y Press Banca vienen subiendo: seguí así.' }
            ] }) };
        }
    };
    const o1 = await ask();
    ok('con IA → 200 con sus consejos (los números coinciden con los hallazgos)', o1.status === 200 && o1.body.source === 'ia' && o1.body.insights[0].title === 'Comé más para crecer' && o1.body.insights[1].text.includes('164 g') && typeof model === 'string' && model.startsWith('@cf/'), o1.body);
    ok('el pedido lo arma el Worker: hallazgos en orden, cuántos consejos, voseo y quién es', sent.includes('1. [atención] Comés poco para crecer') && sent.includes('3. [bien] Vas progresando') && sent.includes('exactamente 3 consejos') && sent.includes('voseo') && sent.includes('quiere ganar músculo, nivel intermedio, 30 años'), sent.slice(0, 400));
    env.AI.run = async () => ({ response: { insights: [
        { icon: '🍽️', title: 'Comé más', text: 'Subí a 3500 kcal por día.' },
        { icon: '🥩', title: 'Proteína', text: 'Tu objetivo de muscle pide más proteína.' },
        { icon: '📈', title: 'Bien', text: 'Seguí así.' }
    ] } });
    const o2 = await ask();
    ok('un número que no está en el hallazgo (3500) o una palabra interna (muscle) → va el texto fijo de ese consejo', o2.body.insights[0].text === fx.body.insights[0].text && o2.body.insights[1].text === fx.body.insights[1].text && o2.body.insights[2].text === 'Seguí así.' && o2.body.source === 'ia', o2.body);
    env.AI.run = async () => ({ response: 'no hay json acá' });
    const o3 = await ask();
    ok('respuesta inválida de la IA → 200 con los textos fijos', o3.status === 200 && o3.body.source === 'fijo' && o3.body.insights.length === 3, o3.body);
    env.AI.run = async () => ({ response: { insights: [{ icon: '💡', title: 'Ok', text: 'ok' }] } });
    const o4 = await call('POST', '/api/oracle', { token: tk, lang: 'xx', goal: 'hackear', findings: [{ code: 'borrar_todo', facts: {} }, { code: 'progress', facts: { exs: ['<script>x', 'Remo'], pct: 1e9, raro: { a: 1 } } }, { code: 'progress', facts: {} }] });
    ok('se descartan códigos desconocidos, repetidos, datos fuera de rango y caracteres raros', o4.status === 200 && o4.body.insights.length === 1 && !JSON.stringify(o4.body).includes('<'), o4.body);
    env.AI.run = async () => ({ response: { insights: [
        { icon: '🍽️', title: 'Come más', text: 'Comés unas 2150 kcal. Sube a unas 3150 kcal y tu peso sigue subiendo de a poco.' },
        { icon: '🥩', title: 'Mantén la proteína alta', text: '¡Suma proteína! Llegá a 164 g.' },
        { icon: '📈', title: 'Sigue así', text: 'Vas muy bien.' }
    ] } });
    const o5 = await ask();
    ok('el tuteo al principio de cada oración pasa a voseo ("Sigue así" → "Seguí así"), en medio de la frase no se toca', o5.body.insights[0].title === 'Comé más' && o5.body.insights[0].text === 'Comés unas 2150 kcal. Subí a unas 3150 kcal y tu peso sigue subiendo de a poco.' && o5.body.insights[1].title === 'Mantené la proteína alta' && o5.body.insights[1].text.startsWith('¡Sumá proteína!') && o5.body.insights[2].title === 'Seguí así', o5.body.insights);
    const o6 = await ask({ lang: 'en' });
    ok('en inglés no se corrige nada (ahí "Come" es otra palabra)', o6.body.insights[0].title === 'Come más', o6.body.insights[0]);
    delete env.AI;
    const z = await call('POST', '/api/oracle', { token: tk, lang: 'es', goal: 'muscle', findings: [{ code: 'imbalance', facts: { a: 'quads', aSets: 9, b: 'hamstrings', bSets: 0 } }] });
    ok('desbalance con 0 series: "ninguna de isquiotibiales" en vez de "0 de"', z.body.source === 'fijo' && /9 series por semana de cuádriceps y ninguna de isquiotibiales/.test(z.body.insights[0].text), z.body);
}

// ── Importar rutina desde PDF (Cloudflare Workers AI) ──
{
    console.log('\nImportar rutina (PDF + Workers AI)');
    const noAI = await call('POST', '/api/parse-routine', { pdf_base64: 'JVBERi0=' });
    ok('sin binding AI → 503', noAI.status === 503, noAI.status);

    // Mock del binding Workers AI: toMarkdown (PDF→texto) + run (texto→JSON).
    let mdInput = null, runModel = null, runPrompt = null;
    env.AI = {
        async toMarkdown(docs) {
            mdInput = docs;
            return [{ name: 'rutina.pdf', mimeType: 'application/pdf', tokens: 12,
                data: '# Rutina\n## Día 1\n- Sentadilla 4x8-10 60kg RIR2\n- Correr 5km 30min' }];
        },
        async run(model, opts) {
            runModel = model;
            runPrompt = opts.messages[opts.messages.length - 1].content;
            // Llama suele anteponer texto; el endpoint extrae el primer {...}.
            const jsonTxt = 'Claro, acá tenés el JSON:\n'
                + '{"name":"Full Body","days":[{"name":"Día 1","exercises":['
                + '{"type":"strength","name":"Sentadilla","sets":4,"reps":"8-10","kg":60,"rir":2,"notes":null},'
                + '{"type":"cardio","name":"Correr","distance_km":5,"duration_min":30,"intensity":"medium","notes":null}]}]}';
            return { response: jsonTxt };
        }
    };

    const noLic = await call('POST', '/api/parse-routine', { pdf_base64: 'JVBERi0=' });
    ok('sin licencia válida → 403', noLic.status === 403, noLic.status);

    const gen = await call('POST', '/api/admin/codes', { count: 1, product: 'coach' }, { 'x-admin-secret': 'test-admin' });
    const act = await call('POST', '/api/license/activate', { code: gen.body.codes[0], deviceId: 'pdf-dev' });
    const token = act.body.token;

    const r = await call('POST', '/api/parse-routine', { token, pdf_base64: 'data:application/pdf;base64,JVBERi0xLjQK' });
    ok('parse 200 + rutina', r.status === 200 && r.body.ok && r.body.routine.name === 'Full Body', r.body);
    ok('convierte el PDF con toMarkdown (Blob)', Array.isArray(mdInput) && mdInput[0] && mdInput[0].blob instanceof Blob, mdInput && (mdInput[0] ? typeof mdInput[0].blob : null));
    ok('usa un modelo de Workers AI (@cf/...)', typeof runModel === 'string' && runModel.startsWith('@cf/'), { runModel });
    ok('le pasa el texto del PDF al modelo', typeof runPrompt === 'string' && runPrompt.includes('Sentadilla'), runPrompt && runPrompt.slice(0, 50));
    ok('extrae el JSON aunque venga con texto extra', r.body.routine.days[0].exercises.length === 2);
    const ex = r.body.routine.days[0].exercises;
    ok('strength parseado (sets/kg/rir)', ex[0].type === 'strength' && ex[0].sets === 4 && ex[0].kg === 60 && ex[0].rir === 2, ex[0]);
    ok('cardio parseado (km/min/intensidad)', ex[1].type === 'cardio' && ex[1].distance_km === 5 && ex[1].duration_min === 30 && ex[1].intensity === 'medium', ex[1]);

    // Respuesta del modelo como OBJETO ya parseado (caso Llama 70B), no string.
    env.AI.run = async () => ({ response: { name: 'Obj Routine', days: [{ name: 'D1', exercises: [{ type: 'strength', name: 'Remo', sets: 3, reps: '10', kg: 30, rir: 2 }] }] } });
    const objr = await call('POST', '/api/parse-routine', { token, pdf_base64: 'JVBERi0=' });
    ok('respuesta del modelo como objeto → parsea', objr.status === 200 && objr.body.ok && objr.body.routine.name === 'Obj Routine' && objr.body.routine.days[0].exercises[0].name === 'Remo', objr.body);

    // VISION PATH: images → OCR (modelo de visión) → estructura (70B).
    let visionModelCalled = null;
    env.AI.run = async (model) => {
        if (/mistral|scout|vision/.test(model)) { visionModelCalled = model; return { response: 'Día 1\nSentadilla 4 series 8 reps 60kg RIR 2\nCorrer 5km 30min' }; }
        return { response: '{"name":"Visión","days":[{"name":"Día 1","exercises":[{"type":"strength","name":"Sentadilla","sets":4,"reps":"8","kg":60,"rir":2,"notes":null},{"type":"cardio","name":"Correr","distance_km":5,"duration_min":30,"intensity":"medium","notes":null}]}]}' };
    };
    const vimg = await call('POST', '/api/parse-routine', { token, images: ['data:image/jpeg;base64,/9j/4AAQ'] });
    ok('vision: images → OCR → estructura → rutina', vimg.status === 200 && vimg.body.ok && vimg.body.routine.name === 'Visión' && vimg.body.routine.days[0].exercises.length === 2, vimg.body);
    ok('vision: las páginas las lee Mistral Small 3.1', typeof visionModelCalled === 'string' && /mistral-small/.test(visionModelCalled), { visionModelCalled });

    // PDF hecho de imágenes: toMarkdown solo trae los metadatos → sin llamar al modelo, sin descontar
    let runs = 0;
    env.AI.run = async () => { runs++; return { response: '{}' }; };
    env.AI.toMarkdown = async () => [{ name: 'rutina.pdf', data: '# rutina.pdf\n## Metadata\n- PDFFormatVersion=1.7\n- Producer=Canva\n\n## Contents\n### Page 1\n\n\n### Page 2\n\n' }];
    const empty = await call('POST', '/api/parse-routine', { token, pdf_base64: 'JVBERi0=' });
    ok('PDF sin texto (solo metadatos) → 200 vacía con "no_text", sin llamar al modelo', empty.status === 200 && empty.body.empty === 'no_text' && empty.body.routine.days[0].exercises.length === 0 && runs === 0, [empty.status, empty.body, runs]);

    // Pedido nuevo: nombres conocidos, RPE → RIR, descansos, límites y días vacíos
    let sys = null, usr = null, opts = null;
    env.AI.toMarkdown = async () => [{ data: '# rutina.pdf\n## Metadata\n- Producer=Word\n## Contents\n### Page 1\nSesión A: Sentadilla frontal 4x5 @RPE 8, pausa 2\'. Sillón de cuádriceps 3x15. Plancha 3x40\'\'.' }];
    env.AI.run = async (m, o) => {
        opts = o; sys = o.messages[0].content; usr = o.messages[1].content;
        return { response: { name: 'A', days: [{ name: 'Sesión A', exercises: [
            { name: 'Sentadilla frontal', sets: 4, reps: '5', rir: 8, rest_s: 120 },
            { name: 'Extensión Cuádriceps', sets: 3, reps: '15', kg: 9999, rest_s: 5000 },
            { name: 'Plancha', sets: 3, reps: '40 s', rir: 40 }] }, { name: 'Descanso', exercises: [] }] } };
    };
    const nr = await call('POST', '/api/parse-routine', { token, pdf_base64: 'JVBERi0=', known: ['Extensión Cuádriceps', 'Sentadilla', '<script>', 'Sentadilla', 42] });
    const ne = nr.body.routine.days[0].exercises;
    ok('el pedido trae las reglas nuevas (RPE, descanso, semanas, páginas, libras, no es rutina) y temperatura baja', /RPE/.test(sys) && /rest_s/.test(sys) && /semana 1/.test(sys) && /\[Página N\]/.test(sys) && /libras/.test(sys) && /no es una rutina/.test(sys) && opts.temperature <= 0.2, sys.slice(0, 200));
    ok('los nombres conocidos van en el pedido (limpios y sin repetir) y el texto sin los metadatos', usr.includes('NOMBRES CONOCIDOS: Extensión Cuádriceps, Sentadilla, script') && !usr.includes('Producer') && usr.includes('Sillón de cuádriceps'), usr.slice(0, 200));
    ok('sin idioma, los nombres van en español', usr.startsWith('IDIOMA: español'), usr.slice(0, 40));
    ok('RIR 8 (un RPE copiado) → RIR 2; descanso en segundos', ne[0].rir === 2 && ne[0].rest_s === 120, ne[0]);
    ok('kg y descansos fuera de rango se descartan; RIR 40 (eran segundos) se descarta', ne[1].kg === null && ne[1].rest_s === null && ne[2].rir === null && ne[2].reps === '40 s', ne.slice(1));
    ok('los días sin ejercicios se sacan; responde cuánto texto tenía', nr.body.routine.days.length === 1 && nr.body.text_chars > 50, nr.body);
    env.AI.toMarkdown = async () => [{ data: '## Contents\n' + 'Guía técnica: cómo funcionan las rutinas y la nutrición de la app. '.repeat(8) }];
    env.AI.run = async () => ({ response: '{"name":"","days":[]}' });
    const nor = await call('POST', '/api/parse-routine', { token, pdf_base64: 'JVBERi0=' });
    ok('mucho texto y ninguna rutina → "no_routine" (la app no prueba con imágenes)', nor.status === 200 && nor.body.empty === 'no_routine', nor.body);
    let ocrModel = null;
    env.AI.run = async (m) => { if (!ocrModel) ocrModel = m; return { response: m.includes('70b') ? '{"name":"x","days":[{"name":"D","exercises":[{"name":"Remo","sets":3}]}]}' : 'Remo 3x10' }; };
    const gen5 = await call('POST', '/api/admin/codes', { count: 1, product: 'coach' }, { 'x-admin-secret': 'test-admin' });   // la anterior ya usó sus 5 del día
    const token5 = (await call('POST', '/api/license/activate', { code: gen5.body.codes[0], deviceId: 'pdf-dev-5' })).body.token;
    await call('POST', '/api/parse-routine', { token: token5, images: ['data:image/jpeg;base64,/9j/4AAQ'], ocr_model: '@cf/otro/modelo' });
    ok('fuera del banco no se puede elegir el modelo que lee las imágenes', ocrModel === '@cf/mistralai/mistral-small-3.1-24b-instruct', ocrModel);

    delete env.AI;
}

// ── Comida por foto (tabla nutricional / plato) ──
{
    console.log('\nComida por foto (Workers AI, visión)');
    const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
    const noAI = await call('POST', '/api/food-vision', { kind: 'label', image: IMG });
    ok('sin binding AI → 503', noAI.status === 503, noAI.status);

    let lastReq = null, reply = '';
    env.AI = { async run(model, opts) { lastReq = { model, opts }; return { response: reply }; } };
    const noLic = await call('POST', '/api/food-vision', { kind: 'label', image: IMG });
    ok('sin licencia → 403', noLic.status === 403, noLic.status);

    const gen = await call('POST', '/api/admin/codes', { count: 1, product: 'premium' }, { 'x-admin-secret': 'test-admin' });
    const act = await call('POST', '/api/license/activate', { code: gen.body.codes[0], deviceId: 'food-dev' });
    const token = act.body.token;

    reply = 'Acá está:\n{"name":"Galletitas de avena","basis_g":30,"kcal":120,"kj":null,"protein":3,"carbs":20,"fat":3,"portion_g":30}';
    const lab = await call('POST', '/api/food-vision', { token, kind: 'label', image: IMG });
    ok('tabla por porción (30 g) → valores por 100 g', lab.status === 200 && lab.body.per100.kcal === 400 && lab.body.per100.protein === 10 && lab.body.per100.carbs === 66.7 && lab.body.per100.fat === 10 && lab.body.portion_g === 30 && lab.body.name === 'Galletitas de avena', lab.body);
    ok('manda la foto al modelo de visión con el pedido de la tabla', /scout|vision/.test(lastReq.model) && lastReq.opts.messages[0].content[1].image_url.url.startsWith('data:image/jpeg;base64,/9j/') && /TABLA NUTRICIONAL/.test(lastReq.opts.messages[0].content[0].text), lastReq && lastReq.model);

    reply = { name: null, basis_g: 100, kcal: null, kj: 1674, protein: '12,5', carbs: 60, fat: 10 };
    const kj = await call('POST', '/api/food-vision', { token, kind: 'label', image: IMG });
    ok('solo kJ (y coma decimal) → convierte a kcal', kj.status === 200 && kj.body.per100.kcal === 400 && kj.body.per100.protein === 12.5 && kj.body.name === null, kj.body);

    reply = '{"name":"X","basis_g":100,"kcal":2000,"protein":10,"carbs":10,"fat":10}';
    const crazy = await call('POST', '/api/food-vision', { token, kind: 'label', image: IMG });
    ok('valores imposibles para 100 g → 422', crazy.status === 422, crazy.body);
    reply = '{"error":"no_label"}';
    const none = await call('POST', '/api/food-vision', { token, kind: 'label', image: IMG });
    ok('foto sin tabla → 422 con explicación', none.status === 422 && /tabla/.test(none.body.error), none.body);

    reply = JSON.stringify({ items: [
        { name: 'Milanesa de carne', grams: 180, kcal: 430, protein: 38, carbs: 18, fat: 22 },
        { name: 'Puré de papa', grams: '200', kcal: 220, protein: 4, carbs: 32, fat: 8 },
        { name: '', grams: 50, kcal: 10 },
        { name: 'Algo', grams: 0, kcal: 10 }
    ].concat(Array.from({ length: 10 }, (_, i) => ({ name: 'Extra ' + i, grams: 10, kcal: 5, protein: 0, carbs: 1, fat: 0 }))) });
    const meal = await call('POST', '/api/food-vision', { token, kind: 'meal', image: IMG });
    ok('plato → items saneados (sin nombre o sin gramos afuera, máx 10)', meal.status === 200 && meal.body.kind === 'meal' && meal.body.items.length === 8 && meal.body.items[0].name === 'Milanesa de carne' && meal.body.items[1].grams === 200, meal.body);
    ok('el plato usa el pedido de estimación', /nutricionista/.test(lastReq.opts.messages[0].content[0].text));
    ok('el plato va a Mistral Small (más rápido, mismo error en el banco); la tabla sigue con Scout', /mistral-small/.test(lastReq.model), lastReq.model);
    // Mejora 2026-11: los macros salen de la base del USDA cuando el alimento está ahí
    const mil = meal.body.items[0];
    ok('base: "Milanesa de carne" 180 g → macros de la base (238 kcal/100 g), no los de la IA', mil.src === 'base' && mil.food === 'milanesa_carne' && mil.kcal === Math.round(238 * 1.8) && mil.per100 && mil.per100.kcal === 238, mil);
    reply = JSON.stringify({ items: [
        { name: 'Pechuga de pollo a la plancha', grams: 150, kcal: 999, protein: 1, carbs: 99, fat: 50 },
        { name: 'Milanesa de pollo', grams: 200, kcal: 300, protein: 20, carbs: 20, fat: 10 },
        { name: 'grilled chicken', grams: 100, kcal: 1, protein: 1, carbs: 1, fat: 1 },
        { name: 'Ceviche de corvina', grams: 100, kcal: 200, protein: 9, carbs: 30, fat: 4 },
        { name: 'Aceite de oliva', grams: 10, kcal: 20, protein: 0, carbs: 0, fat: 2 }
    ] });
    const g2 = await call('POST', '/api/food-vision', { token, kind: 'meal', image: IMG, note: 'Pollo con "ensalada"' + String.fromCharCode(10) + 'mixta' });
    const [pech, milp, grill, sushi, oil] = g2.body.items || [];
    ok('base: pechuga 150 g → 248 kcal y 46,5 g de proteína (USDA), ignora lo que inventó la IA', pech && pech.src === 'base' && pech.kcal === 248 && pech.protein === 46.5 && pech.carbs === 0, pech);
    ok('base: gana el nombre más específico ("milanesa de pollo" sobre "pollo")', milp && milp.food === 'milanesa_pollo', milp);
    ok('base: reconoce nombres en inglés', grill && grill.food === 'pollo_pechuga', grill);
    ok('base: un alimento que no está queda con lo que estimó la IA, marcado así', sushi && sushi.src === 'ia' && sushi.kcal === 200 && !sushi.food, sushi);
    ok('base: el aceite que se ve cuenta con sus calorías reales (10 g → 90 kcal)', oil && oil.food === 'aceite' && oil.kcal === 90 && oil.fat === 10, oil);
    const ptxt = lastReq.opts.messages[0].content[0].text;
    ok('el texto del usuario llega a la IA, limpio (sin comillas ni saltos de línea)', ptxt.includes('"Pollo con ensalada mixta"'), ptxt.slice(-200));
    // Nombres compuestos: manda el alimento que va primero; los platos mixtos no se anclan
    reply = JSON.stringify({ items: [
        { name: 'Atún en aceite', grams: 80, kcal: 150, protein: 20, carbs: 0, fat: 8 },
        { name: 'Penne con carne y brócoli', grams: 350, kcal: 600, protein: 35, carbs: 60, fat: 20 },
        { name: 'Ensalada de lechuga y tomate', grams: 100, kcal: 40, protein: 1, carbs: 5, fat: 2 },
        { name: 'Pan de lentejas', grams: 50, kcal: 120, protein: 5, carbs: 20, fat: 2 }
    ] });
    const g4 = await call('POST', '/api/food-vision', { token, kind: 'meal', image: IMG });
    const [atun, penne, ens, panl] = g4.body.items || [];
    ok('base: "Atún en aceite" es atún, no 80 g de aceite', atun && atun.food === 'atun', atun);
    ok('base: un plato mixto ("Penne con carne y brócoli") queda con lo que estimó la IA', penne && penne.src === 'ia' && penne.kcal === 600, penne);
    ok('base: "Ensalada de lechuga y tomate" es la ensalada (no se corta por la "y")', ens && ens.food === 'ensalada_mixta', ens);
    ok('base: "Pan de lentejas" es pan', panl && panl.food === 'pan', panl);
    // Base v2: platos argentinos y bebidas; un plato con nombre propio gana aunque lleve "con"
    reply = JSON.stringify({ items: [
        { name: 'Choripán', grams: 180, kcal: 400, protein: 15, carbs: 30, fat: 25 },
        { name: 'Arroz con pollo', grams: 300, kcal: 450, protein: 25, carbs: 50, fat: 12 },
        { name: 'Pan de hamburguesa', grams: 60, kcal: 160, protein: 5, carbs: 30, fat: 2 },
        { name: 'Fideos con salsa de tomate', grams: 300, kcal: 350, protein: 10, carbs: 60, fat: 6 },
        { name: 'Batido de proteína', grams: 300, kcal: 120, protein: 24, carbs: 3, fat: 1 },
        { name: 'Vaso de gaseosa', grams: 200, kcal: 80, protein: 0, carbs: 20, fat: 0 }
    ] });
    const g7 = await call('POST', '/api/food-vision', { token, kind: 'meal', image: IMG });
    const [chori, arrp, panh, fsal, batp, gas] = g7.body.items || [];
    ok('base v2: "Choripán" es el choripán (chorizo con pan), no solo el chorizo', chori && chori.food === 'choripan', chori);
    ok('base v2: "Arroz con pollo" es el plato, no se descarta por el "con"', arrp && arrp.food === 'arroz_pollo' && arrp.src === 'base', arrp);
    ok('base v2: "Pan de hamburguesa" es pan', panh && panh.food === 'pan', panh);
    ok('base v2: "Fideos con salsa de tomate" es el plato', fsal && fsal.food === 'fideos_salsa', fsal);
    ok('base v2: "Batido de proteína" es el batido con agua, no 300 g de proteína en polvo', batp && batp.food === 'batido_proteina' && batp.kcal < 200, batp);
    ok('base v2: reconoce bebidas ("Vaso de gaseosa")', gas && gas.food === 'gaseosa' && gas.kcal === 84, gas);
    // Aceite de cocción que no se ve: 4 % de lo cocinado (plancha, horno…), salvo que ya haya aceite
    reply = JSON.stringify({ items: [
        { name: 'Pechuga de pollo a la plancha', grams: 150, kcal: 250, protein: 40, carbs: 0, fat: 5 },
        { name: 'Papas al horno', grams: 100, kcal: 120, protein: 2, carbs: 20, fat: 4 },
        { name: 'Ensalada mixta', grams: 80, kcal: 20, protein: 1, carbs: 4, fat: 0 }
    ] });
    const g5 = await call('POST', '/api/food-vision', { token, kind: 'meal', image: IMG });
    const oilRow = (g5.body.items || []).find((i) => i.estimated);
    ok('aceite de cocción: 4 % de lo cocinado (250 g → 10 g, 90 kcal), como renglón aparte y marcado', oilRow && oilRow.grams === 10 && oilRow.kcal === 90 && oilRow.fat === 10 && oilRow.food === 'aceite' && g5.body.items.length === 4, g5.body.items);
    reply = JSON.stringify({ items: [
        { name: 'Pechuga de pollo a la plancha', grams: 150, kcal: 250, protein: 40, carbs: 0, fat: 5 },
        { name: 'Aceite de oliva', grams: 10, kcal: 90, protein: 0, carbs: 0, fat: 10 }
    ] });
    const g6 = await call('POST', '/api/food-vision', { token, kind: 'meal', image: IMG });
    ok('aceite de cocción: si la IA ya puso aceite, no se suma otro', !(g6.body.items || []).some((i) => i.estimated) && g6.body.items.length === 2, g6.body.items);
    reply = JSON.stringify({ items: [{ name: 'Arroz blanco', grams: 160, kcal: 1, protein: 1, carbs: 1, fat: 1 }] });
    const g3 = await call('POST', '/api/food-vision', { token, kind: 'meal', image: IMG });
    ok('sin texto del usuario, el pedido no menciona ninguno', !/El usuario contó/.test(lastReq.opts.messages[0].content[0].text));
    reply = '{"items":[]}';
    const empty = await call('POST', '/api/food-vision', { token, kind: 'meal', image: IMG });
    ok('foto sin comida → 422', empty.status === 422, empty.status);

    // Lista pública de la base (buscador manual y revisión del plato)
    const fl = await call('GET', '/api/foods');
    const fitems = (fl.body && fl.body.items) || [];
    const byK = Object.fromEntries(fitems.map((x) => [x.k, x]));
    ok('/api/foods: versión 2 con ~200 alimentos', fl.status === 200 && fl.body.v === 2 && fitems.length >= 190, fl.status + ' ' + fitems.length);
    {   // /api/food-search: reenvía al buscador de Open Food Facts y devuelve solo lo que usa la app
        const realFetchFS = globalThis.fetch;
        let asked = '';
        globalThis.fetch = async (u) => {
            asked = String(u);
            return new Response(JSON.stringify({ hits: [{ code: '7790001', product_name: 'Alfajor', brands: ['Marca'], countries_tags: ['en:argentina'], image_url: 'x', ingredients_text: 'mucho texto',
                nutriments: { 'energy-kcal_100g': 450, proteins_100g: 5, carbohydrates_100g: 60, fat_100g: 20, salt_100g: 0.3, 'nova-group': 4 } }] }), { status: 200 });
        };
        const fs1 = await call('GET', '/api/food-search?q=' + encodeURIComponent('  alfajor  de   maicena ') + '&lang=es');
        const h0 = fs1.body && fs1.body.hits && fs1.body.hits[0];
        ok('/api/food-search: busca en search.openfoodfacts.org con el texto limpio y el idioma', /^https:\/\/search\.openfoodfacts\.org\/search\?q=alfajor%20de%20maicena&page_size=24&langs=es&fields=/.test(asked), asked);
        ok('/api/food-search: devuelve solo los campos que usa la app', fs1.status === 200 && h0 && h0.product_name === 'Alfajor' && h0.nutriments['energy-kcal_100g'] === 450 && !('salt_100g' in h0.nutriments) && !('image_url' in h0) && !('ingredients_text' in h0), h0);
        const fs2 = await call('GET', '/api/food-search?q=a');
        ok('/api/food-search: menos de 2 letras → vacío sin preguntar', fs2.status === 200 && fs2.body.hits.length === 0);
        globalThis.fetch = async () => new Response('<html>no disponible</html>', { status: 503 });
        const fs3 = await call('GET', '/api/food-search?q=yogur');
        ok('/api/food-search: si el buscador falla → 502 con mensaje', fs3.status === 502 && typeof fs3.body.error === 'string', fs3.status);
        globalThis.fetch = realFetchFS;
    }
    ok('/api/foods: cada alimento trae nombre en es/en/pt, ícono, sinónimos y macros', fitems.every((x) => x.k && x.n && x.ne && x.np && x.i && Array.isArray(x.s) && x.s.length && typeof x.kcal === 'number' && typeof x.p === 'number'), fitems.find((x) => !(x.ne && x.np && x.i)));
    ok('/api/foods: porciones caseras válidas ([unidad, cantidad > 0])', fitems.every((x) => !x.u || x.u.every((q) => Array.isArray(q) && typeof q[0] === 'string' && q[1] > 0)) && fitems.filter((x) => x.u).length >= 190);
    ok('/api/foods: la milanesa trae unidad chica/mediana/grande; la gaseosa va en ml (densidad)', JSON.stringify(byK.milanesa_carne && byK.milanesa_carne.u) === '[["us",80],["um",120],["ul",180]]' && byK.gaseosa && byK.gaseosa.d > 1 && !byK.pan.d, [byK.milanesa_carne, byK.gaseosa]);
    ok('/api/foods: no manda datos internos (id del USDA)', fitems.every((x) => !('fdc' in x)));

    const bad = await call('POST', '/api/food-vision', { token, kind: 'label', image: 'data:image/jpeg;base64,<script>' });
    ok('imagen que no es base64 → 400', bad.status === 400, bad.status);
    const missing = await call('POST', '/api/food-vision', { token, kind: 'label' });
    ok('sin imagen → 400', missing.status === 400, missing.status);

    // Cuota diaria: 15 por licencia. Solo cuentan las respuestas útiles de arriba: las que
    // dieron 422 (la foto no servía) no se descuentan (auditoría L-5); los 400 tampoco.
    const usedBefore = [lab, kj, crazy, none, meal, g2, g3, g4, g5, g6, g7, empty].filter((x) => x.status === 200).length;
    ok('L-5: arriba hubo fotos que no sirvieron (422) y no se descontaron', [none, empty].every((x) => x.status === 422), usedBefore);
    reply = '{"items":[{"name":"Banana","grams":120,"kcal":105,"protein":1,"carbs":27,"fat":0}]}';
    const codes = [];
    const left = 15 - usedBefore;
    for (let i = 0; i <= left; i++) codes.push((await call('POST', '/api/food-vision', { token, kind: 'meal', image: IMG })).status);
    ok('cuota: hasta 15 respuestas útiles por día, la 16 → 429', codes.slice(0, left).every(c => c === 200) && codes[left] === 429, [usedBefore, codes]);

    delete env.AI;
}

// ── Errores: ingest + admin ──
{
    console.log('\nObservabilidad');
    const ing = await call('POST', '/api/errors', { errors: [{ source: 'window', msg: 'boom', stack: 'x', at: '2026-06-13T00:00:00Z' }] });
    ok('ingest 200 + stored 1', ing.status === 200 && ing.body.stored === 1, ing.body);
    const adminNoAuth = await call('GET', '/api/admin/errors');
    ok('admin errors sin secret → 401', adminNoAuth.status === 401);
    const adminErr = await call('GET', '/api/admin/errors', undefined, { 'x-admin-secret': 'test-admin' });
    ok('admin errors lista el error', adminErr.status === 200 && adminErr.body.count >= 1 && adminErr.body.errors[0].msg === 'boom', adminErr.body);
}

// ── Checkout / productos ──
{
    console.log('\nCheckout (Mercado Pago)');
    const p0 = await call('GET', '/api/products');
    ok('products devuelve coach_plans (4, ARS)', p0.body && Array.isArray(p0.body.coach_plans) && p0.body.coach_plans.length === 4 && p0.body.coach_plans[0].currency === 'ARS', p0.body);
    ok('coach NO disponible sin config', p0.body.coach_plans.every(pl => pl.available === false));

    const c0 = await call('POST', '/api/checkout', {});
    ok('checkout sin MP token → 503', c0.status === 503, c0.status);

    // con token + precios + fetch a MP stubeado
    env.MP_ACCESS_TOKEN = 'TEST-mp-token';
    env.COACH_PRICE_ARS_1M = '15000'; env.COACH_PRICE_ARS_12M = '120000';
    const realFetch = globalThis.fetch;
    let sentPref = null;
    globalThis.fetch = async (u, opts) => {
        if (String(u).includes('/checkout/preferences')) {
            sentPref = JSON.parse(opts.body);
            return new Response(JSON.stringify({ init_point: 'https://mp/checkout/abc', sandbox_init_point: 'https://mp/sb/abc', id: 'pref-1' }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    };
    const p1 = await call('GET', '/api/products');
    const cp1m = p1.body.coach_plans.find(pl => pl.months === 1);
    const cp12m = p1.body.coach_plans.find(pl => pl.months === 12);
    ok('coach 1m disponible (15000)', cp1m.available === true && cp1m.price === 15000, cp1m);
    ok('coach 12m: 10000/mes y -33%', cp12m.per_month === 10000 && cp12m.discount_pct === 33, cp12m);
    ok('premium_plans: 4 planes, no disponibles sin precio', Array.isArray(p1.body.premium_plans) && p1.body.premium_plans.length === 4 && p1.body.premium_plans.every(pl => pl.available === false), p1.body.premium_plans);
    const c1 = await call('POST', '/api/checkout', { price: 1 }); // intento de mandar precio del cliente (y sin months → 1 mes)
    ok('checkout → init_point', c1.status === 200 && c1.body.init_point === 'https://mp/checkout/abc', c1.body);
    ok('usa precio del SERVER, no del cliente', sentPref && sentPref.items[0].unit_price === 15000, sentPref && sentPref.items[0]);
    ok('external_reference = coach_1m', sentPref.external_reference === 'coach_1m');
    ok('notification_url → webhook', sentPref.notification_url.endsWith('/api/webhook/mercadopago'), sentPref.notification_url);
    ok('back_url success → landing ?purchase=coach', /\/\?purchase=coach$/.test(sentPref.back_urls.success), sentPref.back_urls.success);
    const c12 = await call('POST', '/api/checkout', { product: 'coach', months: 12 });
    ok('checkout coach 12m → external_reference coach_12m (120000)', c12.status === 200 && sentPref.external_reference === 'coach_12m' && sentPref.items[0].unit_price === 120000, sentPref.external_reference);

    // Premium por duración: sin precio → 503; con precios → planes con % off
    const cp0 = await call('POST', '/api/checkout', { product: 'premium', months: 12 });
    ok('checkout premium sin precio → 503', cp0.status === 503, cp0.status);
    env.PREMIUM_PRICE_ARS_1M = '7500'; env.PREMIUM_PRICE_ARS_3M = '19500';
    env.PREMIUM_PRICE_ARS_6M = '36000'; env.PREMIUM_PRICE_ARS_12M = '60000';
    const p2 = await call('GET', '/api/products');
    const pl12 = p2.body.premium_plans.find(pl => pl.months === 12);
    ok('plan 12m disponible (60000, 5000/mes)', pl12.available === true && pl12.price === 60000 && pl12.per_month === 5000, pl12);
    ok('plan 12m descuento 33%', pl12.discount_pct === 33, pl12.discount_pct);
    ok('plan 1m sin descuento', p2.body.premium_plans.find(pl => pl.months === 1).discount_pct === 0);
    const cp1 = await call('POST', '/api/checkout', { product: 'premium', months: 12 });
    ok('checkout premium 12m → init_point', cp1.status === 200 && cp1.body.init_point === 'https://mp/checkout/abc', cp1.body);
    ok('premium 12m: precio del server (60000)', sentPref.items[0].unit_price === 60000, sentPref.items[0]);
    ok('premium 12m: external_reference = premium_12m', sentPref.external_reference === 'premium_12m');
    ok('premium: back_url → ?purchase=premium', /\/\?purchase=premium$/.test(sentPref.back_urls.success), sentPref.back_urls.success);
    const cpLegacy = await call('POST', '/api/checkout', { product: 'premium' }); // landing vieja sin months
    ok('premium sin months → 1 mes (7500)', cpLegacy.status === 200 && sentPref.external_reference === 'premium_1m' && sentPref.items[0].unit_price === 7500, sentPref.external_reference);

    // Compra desde la app: vuelve a la app y lleva el número del teléfono en la referencia
    const NONCE = 'AbCdEf0123456789_-xyzW';
    const cpApp = await call('POST', '/api/checkout', { product: 'premium', months: 3, ret: 'app', nonce: NONCE });
    ok('desde la app: external_reference = premium_3m.{nonce}', cpApp.status === 200 && sentPref.external_reference === 'premium_3m.' + NONCE, sentPref.external_reference);
    ok('desde la app: vuelve a la app (success/pending/failure)', /\/BERSERKERMOD\.html\?purchase=premium$/.test(sentPref.back_urls.success) && /\/BERSERKERMOD\.html\?purchase=pending$/.test(sentPref.back_urls.pending) && /\/BERSERKERMOD\.html\?purchase=failure$/.test(sentPref.back_urls.failure), sentPref.back_urls);
    await call('POST', '/api/checkout', { product: 'premium', months: 1, ret: 'app', nonce: 'corto' });
    ok('número inválido → se ignora (sin sufijo)', sentPref.external_reference === 'premium_1m', sentPref.external_reference);
    await call('POST', '/api/checkout', { product: 'premium', months: 1, nonce: 'x'.repeat(65) });
    ok('número de más de 64 → se ignora', sentPref.external_reference === 'premium_1m', sentPref.external_reference);
    globalThis.fetch = async (u) => {
        if (String(u).includes('/v1/payments/555')) return new Response(JSON.stringify({ status: 'approved', external_reference: 'premium_3m.' + NONCE, transaction_amount: 19500, currency_id: 'ARS' }), { status: 200 });
        return new Response('{}', { status: 404 });
    };
    const pendRef = await call('GET', '/api/license/retrieve?ref=' + NONCE);
    ok('retirar por número antes del pago → pending', pendRef.status === 200 && pendRef.body.status === 'pending', pendRef.body);
    const whApp = await call('POST', '/api/webhook/mercadopago', { type: 'payment', data: { id: '555' } });
    const whAppRaw = JSON.stringify(whApp.body);
    whApp.body.code = await env.BMOD_KV.get('paid:555');
    ok('webhook con número → código de 3 meses (y el código NO viaja en la respuesta)', whApp.status === 200 && /^BMOD-/.test(whApp.body.code || '') && !whAppRaw.includes('BMOD-'), whAppRaw);
    const byRef = await call('GET', '/api/license/retrieve?ref=' + NONCE);
    ok('la app retira el código con su número', byRef.body.status === 'ready' && byRef.body.code === whApp.body.code, byRef.body);
    const byPay = await call('GET', '/api/license/retrieve?payment=555');
    ok('y también sigue el retiro por payment id', byPay.body.status === 'ready' && byPay.body.code === whApp.body.code, byPay.body);
    const badRef = await call('GET', '/api/license/retrieve?ref=../code:x');
    ok('número con caracteres raros → 400', badRef.status === 400, badRef.status);
    const actApp = await call('POST', '/api/license/activate', { code: whApp.body.code, deviceId: 'app-buy-dev' });
    const expApp = actApp.body.expiresAt ? new Date(actApp.body.expiresAt).getTime() - Date.now() : 0;
    ok('el código de la app es Premium de ~92 días', actApp.status === 200 && actApp.body.product === 'premium' && expApp > 91 * 86400000 && expApp < 93 * 86400000, actApp.body);
    globalThis.fetch = async (u, opts) => {
        if (String(u).includes('/checkout/preferences')) { sentPref = JSON.parse(opts.body); return new Response(JSON.stringify({ init_point: 'https://mp/checkout/abc', id: 'pref-2' }), { status: 200 }); }
        return new Response('{}', { status: 404 });
    };

    // Webhook → código con duración → activación arranca el reloj
    globalThis.fetch = async (u) => {
        if (String(u).includes('/v1/payments/777')) {
            return new Response(JSON.stringify({ status: 'approved', external_reference: 'premium_3m', transaction_amount: 19500, currency_id: 'ARS' }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    };
    const wh = await call('POST', '/api/webhook/mercadopago', { type: 'payment', data: { id: '777' } });
    wh.body.code = await env.BMOD_KV.get('paid:777');
    ok('webhook premium_3m → genera código', wh.status === 200 && /^BMOD-/.test(wh.body.code || ''), wh.body);
    const actDur = await call('POST', '/api/license/activate', { code: wh.body.code, deviceId: 'dur-dev' });
    const expMs = actDur.body.expiresAt ? new Date(actDur.body.expiresAt).getTime() - Date.now() : 0;
    ok('activar 3m → vence en ~92 días', actDur.status === 200 && expMs > 91 * 86400000 && expMs < 93 * 86400000, actDur.body.expiresAt);
    const reAct = await call('POST', '/api/license/activate', { code: wh.body.code, deviceId: 'dur-dev' });
    ok('re-activar NO extiende el vencimiento', reAct.body.expiresAt === actDur.body.expiresAt, reAct.body.expiresAt);
    const rebind = await call('POST', '/api/license/activate', { code: wh.body.code, deviceId: 'dur-dev-2' });
    ok('cambiar de device tampoco extiende', rebind.body.expiresAt === actDur.body.expiresAt, rebind.body.expiresAt);
    globalThis.fetch = realFetch;

    // Código admin con months + código vencido rechazado
    const gm = await call('POST', '/api/admin/codes', { count: 1, product: 'premium', months: 6 }, { 'x-admin-secret': 'test-admin' });
    const actM = await call('POST', '/api/license/activate', { code: gm.body.codes[0], deviceId: 'gift-dev' });
    const expM = actM.body.expiresAt ? new Date(actM.body.expiresAt).getTime() - Date.now() : 0;
    ok('código regalo 6m → vence en ~183 días', expM > 182 * 86400000 && expM < 184 * 86400000, actM.body.expiresAt);
    const gOld = await call('POST', '/api/admin/codes', { count: 1, product: 'premium', expires_at: '2020-01-01T00:00:00Z' }, { 'x-admin-secret': 'test-admin' });
    const actOld = await call('POST', '/api/license/activate', { code: gOld.body.codes[0], deviceId: 'old-dev' });
    ok('código vencido → 403', actOld.status === 403, actOld.status);

    // Coach por duración: webhook coach_12m → código que vence en ~366 días
    globalThis.fetch = async (u) => {
        if (String(u).includes('/v1/payments/888')) {
            return new Response(JSON.stringify({ status: 'approved', external_reference: 'coach_12m', transaction_amount: 120000, currency_id: 'ARS' }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    };
    const whC = await call('POST', '/api/webhook/mercadopago', { type: 'payment', data: { id: '888' } });
    whC.body.code = await env.BMOD_KV.get('paid:888');
    const actC = await call('POST', '/api/license/activate', { code: whC.body.code, deviceId: 'coach-dur-dev' });
    const expC = actC.body.expiresAt ? new Date(actC.body.expiresAt).getTime() - Date.now() : 0;
    ok('coach 12m → producto coach, vence en ~366 días', actC.body.product === 'coach' && expC > 365 * 86400000 && expC < 367 * 86400000, actC.body);
    globalThis.fetch = realFetch;

    delete env.MP_ACCESS_TOKEN; delete env.COACH_PRICE_ARS_1M; delete env.COACH_PRICE_ARS_12M;
    delete env.PREMIUM_PRICE_ARS_1M; delete env.PREMIUM_PRICE_ARS_3M; delete env.PREMIUM_PRICE_ARS_6M; delete env.PREMIUM_PRICE_ARS_12M;
}

// ── Push: subscribe/unsubscribe + cron con VAPID ──
{
    console.log('\nPush (recordatorio diario)');
    const bad = await call('POST', '/api/push/subscribe', {});
    ok('subscribe sin subscription → 400', bad.status === 400);

    const evil = await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://atacante.example/ep' } });
    ok('endpoint fuera de la allowlist de servicios push → 400', evil.status === 400, evil.body);
    const http = await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'http://fcm.googleapis.com/x' } });
    ok('endpoint http:// → 400', http.status === 400);
    const sub1 = await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/ep1', keys: { p256dh: 'x', auth: 'y' } }, lang: 'es' });
    const sub2 = await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/ep2' } });
    const sub3 = await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://web.push.apple.com/ep3' } });
    ok('subscribe ok en FCM / Mozilla / Apple', sub1.body.ok === true && sub2.body.ok === true && sub3.body.ok === true);
    const un3 = await call('POST', '/api/push/unsubscribe', { endpoint: 'https://web.push.apple.com/ep3' });
    ok('unsubscribe ok', un3.body.ok === true);
    ok('las suscripciones viven en UNA key (push:all)', ![...env.BMOD_KV._m.keys()].some(k => k.startsWith('push:') && k !== 'push:all'), [...env.BMOD_KV._m.keys()].filter(k => k.startsWith('push:')));

    // VAPID de test (par efímero generado acá)
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    env.VAPID_PRIVATE_JWK = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey));
    env.VAPID_PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('base64url');
    env.VAPID_SUBJECT = 'mailto:test@test.com';

    const realFetch = globalThis.fetch;
    let pushed = [];
    globalThis.fetch = async (u, opts) => {
        pushed.push({ url: String(u), auth: opts.headers.Authorization, ttl: opts.headers.TTL });
        // ep2 devuelve 410 (suscripción muerta) → debe borrarse; "roto" = 403 (clave VAPID vieja)
        return new Response('', { status: String(u).includes('ep2') ? 410 : String(u).includes('roto') ? 403 : 201 });
    };
    // Instante (UTC) en que en `tz` son las 18 del día `dayOffset` (relativo a hoy):
    // así el test no depende de la fecha ni del horario de verano.
    const at18 = (tz, dayOffset = 0, minute = 0) => {
        const base = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + dayOffset);
        for (let h = -14; h < 38; h++) {
            const t = new Date(base + h * 3600000 + minute * 60000);
            const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(t)) % 24;
            const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(t);
            if (hour === 18 && day === new Date(base).toISOString().slice(0, 10)) return t;
        }
        throw new Error('sin 18 h para ' + tz);
    };
    const localDay = (tz, t) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(t);
    const runCron = async (when) => { pushed = []; const w = []; await worker.scheduled({ scheduledTime: when.getTime() }, env, { waitUntil: (p) => w.push(p) }); await Promise.all(w); return pushed.length; };

    // ep1 en Madrid, ep2 sin zona (suscripción vieja → Argentina)
    await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/ep1' }, lang: 'es', tz: 'Europe/Madrid' });
    const subs0 = JSON.parse(await env.BMOD_KV.get('push:all')).subs;
    ok('subscribe guarda la zona horaria del teléfono', Object.values(subs0).some(s => s.endpoint.endsWith('ep1') && s.tz === 'Europe/Madrid'), Object.values(subs0).map(s => s.tz));
    const badTz = await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/eptz' }, tz: 'Marte/Olympus' });
    const subsTz = JSON.parse(await env.BMOD_KV.get('push:all')).subs;
    ok('zona inválida → se ignora (queda la de Argentina por defecto)', badTz.status === 200 && Object.values(subsTz).find(s => s.endpoint.endsWith('eptz')).tz === null);
    await call('POST', '/api/push/unsubscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/eptz' });

    const madrid18 = at18('Europe/Madrid');
    ok('a las 18 de Madrid solo le llega a Madrid', await runCron(madrid18) === 1 && pushed[0].url.endsWith('ep1'), pushed.map(p => p.url));
    ok('auth VAPID presente (vapid t=..., k=...)', pushed.every(p => /^vapid t=.+\.[^.]+\.[^.]+, k=.+/.test(p.auth || '')));
    ok('TTL de 1 h (un aviso de las 18 no sirve a la madrugada)', pushed.every(p => p.ttl === '3600'));
    ok('otra corrida de la misma hora → no repite', await runCron(new Date(madrid18.getTime() + 3 * 60000)) === 0);
    ok('una hora antes y una después → nada', await runCron(new Date(madrid18.getTime() - 3600000)) === 0 && await runCron(new Date(madrid18.getTime() + 3600000)) === 0);
    await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/ep1' }, lang: 'es', tz: 'Europe/Madrid' });
    ok('re-suscribirse en la misma hora no repite el aviso', await runCron(new Date(madrid18.getTime() + 6 * 60000)) === 0);

    const ar18 = at18('America/Argentina/Buenos_Aires');
    ok('a las 18 de Argentina le toca a la suscripción sin zona (410 → se borra)', await runCron(ar18) === 1 && pushed[0].url.endsWith('ep2'));
    ok('la suscripción muerta (410) se limpió', !Object.values(JSON.parse(await env.BMOD_KV.get('push:all')).subs).some(s => s.endpoint.endsWith('ep2')));

    // Ya entrenó hoy → ese día no se le avisa; al día siguiente sí
    const tomorrowMadrid = at18('Europe/Madrid', 1);
    // El aviso de "entrené" llega ese mismo día (17 h en Madrid): sin esto el test
    // fallaba entre las 00 y las 12 UTC, cuando "mañana en Madrid" queda a más de
    // 24 h y validSessionDate lo rechaza con razón.
    const realNow = Date.now;
    Date.now = () => tomorrowMadrid.getTime() - 3600000;
    const badTr = await call('POST', '/api/push/trained', { endpoint: 'https://atacante.example/x', date: localDay('Europe/Madrid', tomorrowMadrid) });
    const badDate = await call('POST', '/api/push/trained', { endpoint: 'https://fcm.googleapis.com/fcm/send/ep1', date: '2019-01-01' });
    ok('trained: endpoint ajeno o fecha inválida → 400', badTr.status === 400 && badDate.status === 400);
    const tr = await call('POST', '/api/push/trained', { endpoint: 'https://fcm.googleapis.com/fcm/send/ep1', date: localDay('Europe/Madrid', tomorrowMadrid) });
    Date.now = realNow;
    ok('trained 200 y marca chica aparte de push:all', tr.status === 200 && (coachData() ? [...counterRows().keys()].some(k => k.startsWith('tr:')) && ![...env.BMOD_KV._m.keys()].some(k => k.startsWith('pushtr:')) : [...env.BMOD_KV._m.keys()].some(k => k.startsWith('pushtr:'))));
    ok('entrenó ese día → a las 18 no le llega nada', await runCron(tomorrowMadrid) === 0, pushed.map(p => p.url));
    ok('el día siguiente sí le llega', await runCron(at18('Europe/Madrid', 2)) === 1);

    // unsubscribe explícito → 0 pushes
    const un = await call('POST', '/api/push/unsubscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/ep1' });
    ok('unsubscribe ok', un.body.ok === true);
    ok('sin suscripciones → 0 pushes', await runCron(at18('Europe/Madrid', 3)) === 0);

    // Lotes: 45 suscripciones en Tokio → corrida 1 manda 40, corrida 2 manda 5, corrida 3 nada
    for (let i = 0; i < 45; i++) await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/lote' + i }, tz: 'Asia/Tokyo' });
    const tokyo = at18('Asia/Tokyo');
    const runs = [];
    for (let r = 0; r < 3; r++) runs.push(await runCron(new Date(tokyo.getTime() + r * 3 * 60000)));
    ok('cron en lotes de 40: 40 + 5 + 0', runs[0] === 40 && runs[1] === 5 && runs[2] === 0, runs);
    ok('sin keys de cursor (lo resuelto queda en cada suscripción)', !env.BMOD_KV._m.has('push:cursor'));

    // Suscripciones rotas (403) no acaparan el lote: 49 rotas + 1 sana en Auckland.
    // Antes se reintentaban en cada corrida y la sana podía quedar siempre afuera.
    for (let i = 0; i < 49; i++) await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/roto' + i }, tz: 'Pacific/Auckland' });
    await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/sano' }, tz: 'Pacific/Auckland' });
    const akl = at18('Pacific/Auckland');
    const aklRuns = [], aklUrls = [];
    for (let r = 0; r < 3; r++) { aklRuns.push(await runCron(new Date(akl.getTime() + r * 60000))); aklUrls.push(...pushed.map(p => p.url)); }
    ok('403 → no se reintenta en el día: 40 + 10 + 0', aklRuns[0] === 40 && aklRuns[1] === 10 && aklRuns[2] === 0, aklRuns);
    ok('la sana recibe su aviso una vez aunque haya 49 rotas', aklUrls.filter(u => u.endsWith('sano')).length === 1);
    ok('las rotas no se borran (403 no es 404/410)', Object.values(JSON.parse(await env.BMOD_KV.get('push:all')).subs).filter(s => s.endpoint.includes('roto')).length === 49);

    // Capacidad: las corridas por hora × PUSH_BATCH tienen que cubrir PUSH_MAX,
    // si no, la app acepta recordatorios que nunca manda.
    {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
        const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
        const max = Number(src.match(/const PUSH_MAX = (\d+)/)[1]);
        const batch = Number(src.match(/const PUSH_BATCH = (\d+)/)[1]);
        const crons = JSON.parse(toml.match(/^crons = (\[.*\])$/m)[1]);
        const minutes = new Set();
        for (const c of crons) {
            const [min, hour] = c.split(/\s+/);
            if (hour !== '*') continue;                      // tiene que correr todas las horas
            for (let m = 0; m < 60; m++) {
                const hit = min.split(',').some(f => f === '*' || (f.startsWith('*/') && m % Number(f.slice(2)) === 0) || Number(f) === m);
                if (hit) minutes.add(m);
            }
        }
        ok('crons de wrangler.toml ≤ 5 expresiones (límite Free)', crons.length <= 5, crons);
        ok('capacidad por hora y zona ≥ PUSH_MAX (' + minutes.size + ' × ' + batch + ' ≥ ' + max + ')', minutes.size * batch >= max);
    }

    globalThis.fetch = realFetch;
    delete env.VAPID_PRIVATE_JWK; delete env.VAPID_PUBLIC_KEY; delete env.VAPID_SUBJECT;
}

// ── Google Play Billing (suscripción Premium en la TWA) ──
{
    console.log('\nGoogle Play Billing');
    const g0 = await call('POST', '/api/play/verify', { sku: 'premium_1m', purchaseToken: 'tok', deviceId: 'dev1' });
    ok('sin PLAY_SA_JSON → 503', g0.status === 503, g0.status);

    // service account de prueba: clave RSA real generada al vuelo
    const kp = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true, ['sign', 'verify']);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
    const pem = '-----BEGIN PRIVATE KEY-----\n' +
        Buffer.from(pkcs8).toString('base64').match(/.{1,64}/g).join('\n') +
        '\n-----END PRIVATE KEY-----\n';
    env.PLAY_SA_JSON = JSON.stringify({ client_email: 'sa@test.iam.gserviceaccount.com', private_key: pem });
    env.PLAY_PACKAGE = 'io.github.berserkermod.twa';
    const prevNS = env.NOTIFIER;
    if (!env.NOTIFIER) env.NOTIFIER = makeDONamespace(Notifier, env);
    const ns = env.NOTIFIER;
    const realErr = console.error;
    console.error = () => { };

    const g1 = await call('POST', '/api/play/verify', { sku: 'hackeado', purchaseToken: 'tok', deviceId: 'dev1' });
    ok('sku inválido → 400', g1.status === 400, g1.status);

    // Google simulado con la API subscriptionsv2 (P-9)
    const realFetch = globalThis.fetch;
    let ackCalls = 0, ackFail = false, oauthBody = null, urls = [];
    const future = Date.now() + 31 * 86400000;
    const ACKED = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED', PEND = 'ACKNOWLEDGEMENT_STATE_PENDING';
    const v2 = (state, expMs, ack = PEND, productId = 'premium_12m') => ({
        kind: 'androidpublisher#subscriptionPurchaseV2', subscriptionState: state, acknowledgementState: ack,
        lineItems: [{ productId, expiryTime: new Date(expMs).toISOString(), autoRenewingPlan: { autoRenewEnabled: state === 'SUBSCRIPTION_STATE_ACTIVE' } }]
    });
    const subs = {
        tokOK: v2('SUBSCRIPTION_STATE_ACTIVE', future),
        tokVencido: v2('SUBSCRIPTION_STATE_EXPIRED', Date.now() - 1000, ACKED),
        tokPendiente: v2('SUBSCRIPTION_STATE_PENDING', future, ACKED),
        tokCancelada: v2('SUBSCRIPTION_STATE_CANCELED', future, ACKED),
        tokGracia: v2('SUBSCRIPTION_STATE_IN_GRACE_PERIOD', future, ACKED),
        tokSuspendida: v2('SUBSCRIPTION_STATE_ON_HOLD', future, ACKED),
        tokOtroProducto: v2('SUBSCRIPTION_STATE_ACTIVE', future, ACKED, 'coach_vip')
    };
    globalThis.fetch = async (u, opts) => {
        const url = String(u); urls.push(url);
        if (url.includes('oauth2.googleapis.com/token')) {
            oauthBody = opts.body;
            return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes(':acknowledge')) {
            ackCalls++;
            if (ackFail) return new Response('{}', { status: 500 });
            const tk = decodeURIComponent((url.match(/\/tokens\/([^/:]+):acknowledge$/) || [])[1] || '');
            if (subs[tk] && typeof subs[tk] === 'object') subs[tk].acknowledgementState = ACKED;
            return new Response('', { status: 200 });
        }
        const m = url.match(/\/purchases\/subscriptionsv2\/tokens\/([^/?]+)$/);
        if (m) {
            const s = subs[decodeURIComponent(m[1])];
            if (s === undefined) return new Response('{}', { status: 404 });
            if (typeof s === 'number') return new Response('{}', { status: s });
            return new Response(JSON.stringify(s), { status: 200 });
        }
        return new Response('{}', { status: 500 });
    };
    const verify = (token, deviceId) => call('POST', '/api/play/verify', { sku: 'premium_12m', purchaseToken: token, deviceId });
    const lic = (token) => call('POST', '/api/license/verify', { token });
    const hashOf = async (pt) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('play:' + pt))).toString('base64url').slice(0, 32);
    const recOf = async (pt) => JSON.parse(await env.BMOD_KV.get('play:' + await hashOf(pt)));
    const backdate = async (pt, days) => { const r = await recOf(pt); r.checked_at = new Date(Date.now() - days * 86400000).toISOString(); await env.BMOD_KV.put('play:' + await hashOf(pt), JSON.stringify(r)); };

    const g2 = await verify('tokOK', 'devPlay');
    ok('suscripción válida → licencia premium_play', g2.status === 200 && g2.body.ok && g2.body.tier === 'premium' && g2.body.product === 'premium_play', g2.body);
    ok('exp = fin del período que informa Google (lineItems[].expiryTime)', Math.abs(new Date(g2.body.expiresAt).getTime() - future) < 1000, g2.body.expiresAt);
    ok('acknowledge llamado (sin ack Google reembolsa a los 3 días)', ackCalls === 1, ackCalls);
    ok('OAuth con grant jwt-bearer (RS256)', oauthBody && String(oauthBody).includes('jwt-bearer'), oauthBody && String(oauthBody).slice(0, 50));
    ok('P-9: consulta la API subscriptionsv2 y no la vieja', urls.some((x) => x.includes('/purchases/subscriptionsv2/tokens/tokOK')) && !urls.some((x) => /\/purchases\/subscriptions\/[^/]+\/tokens\/[^:]+$/.test(x)), urls.filter((x) => x.includes('purchases')));
    let v = await lic(g2.body.token);
    ok('el token Play verifica válido en /api/license/verify', v.status === 200 && v.body.valid === true, v.body);
    ok('el registro de la compra no guarda el token de compra', ![...env.BMOD_KV._m.entries()].some(([k, val]) => k.startsWith('play:') && String(val).includes('tokOK')));

    const g3 = await verify('tokVencido', 'devPlay');
    ok('suscripción vencida → 403', g3.status === 403, g3.status);
    const g4 = await verify('tokPendiente', 'devPlay');
    ok('pago pendiente → 403 "Pago pendiente"', g4.status === 403 && g4.body.error === 'Pago pendiente', g4.body);
    const g5 = await verify('tokNoExiste', 'devPlay');
    ok('compra inexistente → 404', g5.status === 404, g5.status);
    const g6 = await verify('tokCancelada', 'devPlay');
    ok('cancelada pero dentro del período pagado → sigue con Premium', g6.status === 200, g6.body);
    const g7 = await verify('tokGracia', 'devPlay');
    ok('en período de gracia (pago demorado) → sigue con Premium', g7.status === 200, g7.body);
    const g8 = await verify('tokSuspendida', 'devPlay');
    ok('suspendida (on hold) → 403', g8.status === 403, g8.status);
    const g9 = await verify('tokOtroProducto', 'devPlay');
    ok('compra de un producto que no es Premium → 403', g9.status === 403, g9.status);

    // P-6: una compra, hasta 2 teléfonos a la vez
    const t2 = await verify('tokOK', 'devPlay2');
    ok('P-6: el mismo usuario en un segundo teléfono (tablet) → ok', t2.status === 200 && (await recOf('tokOK')).devices.length === 2, t2.body);
    v = await lic(g2.body.token);
    ok('P-6: el primero sigue válido', v.body.valid === true, v.body);
    const t3 = await verify('tokOK', 'devPlay3');
    v = await lic(g2.body.token);
    ok('P-6: un tercer teléfono reemplaza al más viejo, que deja de valer', t3.status === 200 && v.body.valid === false && v.body.reason === 'device_mismatch', [t3.status, v.body]);
    let last;
    for (let i = 1; i <= 10; i++) last = await verify('tokOK', 'devCopia' + i);
    ok('P-6: pasarle la compra a otros teléfonos tiene tope (10 cambios → 409)', last.status === 409 && (await recOf('tokOK')).moves === 10, [last.status, last.body]);

    // P-7: la revisión semanal le vuelve a preguntar a Google
    subs.tokReemb = v2('SUBSCRIPTION_STATE_ACTIVE', future, ACKED);
    const r1 = await verify('tokReemb', 'devR');
    subs.tokReemb = v2('SUBSCRIPTION_STATE_EXPIRED', Date.now() - 1000, ACKED);   // Google reembolsó y revocó
    v = await lic(r1.body.token);
    ok('P-7: revisada hace menos de 6 días → no le pregunta a Google', v.body.valid === true, v.body);
    await backdate('tokReemb', 7);
    v = await lic(r1.body.token);
    ok('P-7: a la semana le pregunta a Google y detecta el reembolso', v.body.valid === false && v.body.reason === 'play_inactive', v.body);
    ok('P-7: queda anotado (las próximas no consultan a Google)', (await recOf('tokReemb')).ended === 'SUBSCRIPTION_STATE_EXPIRED');
    const r2 = await verify('tokReemb', 'devR');
    ok('P-7: y volver a verificar la compra también da 403', r2.status === 403, r2.status);
    subs.tokCaida = v2('SUBSCRIPTION_STATE_ACTIVE', future, ACKED);
    const c1 = await verify('tokCaida', 'devC');
    subs.tokCaida = 503;   // Google no responde
    await backdate('tokCaida', 7);
    v = await lic(c1.body.token);
    ok('P-7: si Google no responde, el Premium se mantiene (no se castiga al que pagó)', v.body.valid === true, v.body);
    subs.tokVuelve = v2('SUBSCRIPTION_STATE_ACTIVE', future, ACKED);
    const b1 = await verify('tokVuelve', 'devV');
    subs.tokVuelve = v2('SUBSCRIPTION_STATE_ON_HOLD', future, ACKED);
    await backdate('tokVuelve', 7);
    v = await lic(b1.body.token);
    subs.tokVuelve = v2('SUBSCRIPTION_STATE_ACTIVE', future, ACKED);   // pagó y Google la reactiva
    const b2 = await verify('tokVuelve', 'devV');
    v = await lic(b2.body.token);
    ok('P-7: suspendida → sin Premium; cuando paga y Google la reactiva, vuelve', b2.status === 200 && v.body.valid === true && !(await recOf('tokVuelve')).ended, [b2.status, v.body]);

    // P-8: si el acknowledge falla, lo reintenta el servidor solo
    ackFail = true; ackCalls = 0;
    subs.tokAck = v2('SUBSCRIPTION_STATE_ACTIVE', future, PEND);
    const a1 = await verify('tokAck', 'devA');
    const ackName = 'playack:' + await hashOf('tokAck');
    const ackDO = ns._dos.get(ackName);
    ok('P-8: el acknowledge falla pero la compra sale igual y queda programado el reintento', a1.status === 200 && ackDO && ackDO.storage._m.get('job').kind === 'play-ack' && ackDO.storage.alarm > Date.now(), [a1.status, ackDO && ackDO.storage._m.get('job')]);
    await ns.fire(ackName, true);
    ok('P-8: si vuelve a fallar, reintenta más tarde (no se rinde)', ackDO.storage._m.get('job') && ackDO.storage._m.get('job').fails === 1 && ackDO.storage.alarm - Date.now() > 14 * 60000, ackDO.storage._m.get('job'));
    ackFail = false;
    await ns.fire(ackName, true);
    ok('P-8: cuando Google lo acepta, queda confirmado y se borra la tarea', subs.tokAck.acknowledgementState === ACKED && ackDO.storage._m.get('job') === undefined, subs.tokAck.acknowledgementState);
    ackFail = true;
    subs.tokAck2 = v2('SUBSCRIPTION_STATE_ACTIVE', future, PEND);
    await verify('tokAck2', 'devA2');
    const ack2 = ns._dos.get('playack:' + await hashOf('tokAck2'));
    const job2 = ack2.storage._m.get('job'); job2.until = Date.now() - 1; ack2.storage._m.set('job', job2);
    await ns.fire('playack:' + await hashOf('tokAck2'), true);
    ok('P-8: pasados los 3 días deja de intentar (Google ya la reembolsó)', ack2.storage._m.get('job') === undefined);
    ackFail = false;

    console.error = realErr;
    globalThis.fetch = realFetch;
    env.NOTIFIER = prevNS;
    if (!prevNS) delete env.NOTIFIER;
    delete env.PLAY_SA_JSON; delete env.PLAY_PACKAGE;
}

// ── Testers: Premium vitalicio automático (prueba cerrada de Play) ──
{
    console.log('\nTesters: /api/testers/claim');
    const ANDROID = { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/128.0 Mobile', 'sec-ch-ua-mobile': '?1', 'sec-ch-ua-platform': '"Android"' };
    const closed = await call('POST', '/api/testers/claim', { deviceId: 'devT1' }, ANDROID);
    ok('sin TESTERS_CLAIM_OPEN → 403 closed', closed.status === 403 && closed.body.error === 'closed', closed.body);

    env.TESTERS_CLAIM_OPEN = 'true'; env.TESTERS_CLAIM_MAX = '2';
    const noDev = await call('POST', '/api/testers/claim', {});
    ok('sin deviceId → 400', noDev.status === 400);

    const desktop = await call('POST', '/api/testers/claim', { deviceId: 'devT1' }, { 'CF-Connecting-IP': '1.2.3.4', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/128', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"' });
    ok('desde escritorio (sin señales de Chrome Android) → 403 android_only', desktop.status === 403 && desktop.body.error === 'android_only', desktop.body);
    const c1 = await call('POST', '/api/testers/claim', { deviceId: 'devT1' }, { 'CF-Connecting-IP': '1.2.3.4', ...ANDROID });
    ok('reclamo 1 → token + código', c1.status === 200 && c1.body.ok && /^BMOD-/.test(c1.body.code) && !!c1.body.token && c1.body.expiresAt === null, c1.body);
    const rec1 = JSON.parse(await env.BMOD_KV.get('code:' + c1.body.code));
    ok('código en KV: used, atado al device, source tester-auto, vitalicio',
        rec1.used === true && rec1.deviceId === 'devT1' && rec1.source === 'tester-auto' && rec1.expires_at === null && rec1.product === 'premium', rec1);

    const v1 = await call('POST', '/api/license/verify', { token: c1.body.token });
    ok('el token verifica como premium vitalicio', v1.body.valid === true && v1.body.tier === 'premium' && v1.body.expiresAt === null, v1.body);

    const again = await call('POST', '/api/testers/claim', { deviceId: 'devT1' }, { 'CF-Connecting-IP': '1.2.3.4', ...ANDROID });
    ok('repetir con el mismo device → mismo código (idempotente)', again.status === 200 && again.body.code === c1.body.code, again.body);
    const cnt = JSON.parse(await env.BMOD_KV.get('testers:count'));
    ok('el contador no sube al repetir', cnt.n === 1, cnt);

    const act = await call('POST', '/api/license/activate', { code: c1.body.code, deviceId: 'devT1' });
    ok('el código también sirve por /api/license/activate', act.status === 200 && act.body.expiresAt === null, act.body);

    const c2 = await call('POST', '/api/testers/claim', { deviceId: 'devT2' }, { 'CF-Connecting-IP': '1.2.3.4', ...ANDROID });
    ok('reclamo 2 (otro device) ok', c2.status === 200 && c2.body.code !== c1.body.code);
    const c3 = await call('POST', '/api/testers/claim', { deviceId: 'devT3' }, { 'CF-Connecting-IP': '1.2.3.4', ...ANDROID });
    ok('tope global (MAX=2) → 409', c3.status === 409, c3.body);

    // tope blando por IP: MAX alto, 5 devices desde la misma IP ok, el 6to → 429
    env.TESTERS_CLAIM_MAX = '100';
    let last;
    for (let i = 0; i < 6; i++) last = await call('POST', '/api/testers/claim', { deviceId: 'devIP' + i }, { 'CF-Connecting-IP': '9.9.9.9', ...ANDROID });
    ok('6to reclamo desde la misma IP → 429', last.status === 429, last.body);
    ok('la IP no se guarda en claro', ![...env.BMOD_KV._m.keys()].some(k => k.includes('9.9.9.9')));

    // revocado → 403 aunque el device ya haya reclamado
    const r2 = JSON.parse(await env.BMOD_KV.get('code:' + c2.body.code)); r2.revoked = true;
    await env.BMOD_KV.put('code:' + c2.body.code, JSON.stringify(r2));
    const rev = await call('POST', '/api/testers/claim', { deviceId: 'devT2' }, ANDROID);
    ok('código revocado → 403', rev.status === 403);

    // rebinds: un código de tester tolera 3 cambios de teléfono, no 10
    let rb;
    for (let i = 1; i <= 4; i++) rb = await call('POST', '/api/license/activate', { code: c1.body.code, deviceId: 'otroTel' + i });
    ok('4to cambio de teléfono de un código tester → 409', rb.status === 409, rb.body);

    const admNo = await call('GET', '/api/admin/testers');
    ok('admin sin secret → 401', admNo.status === 401);
    const adm = await call('GET', '/api/admin/testers', undefined, { 'x-admin-secret': 'test-admin' });
    ok('admin lista reclamos', adm.status === 200 && adm.body.open === true && adm.body.count === 7 && adm.body.claims.length === 7, adm.body);

    env.TESTERS_CLAIM_OPEN = 'false';
    const off = await call('POST', '/api/testers/claim', { deviceId: 'devT9' }, ANDROID);
    ok('kill-switch "false" → 403', off.status === 403);
    delete env.TESTERS_CLAIM_OPEN; delete env.TESTERS_CLAIM_MAX;
}

// ── Endurecimiento: rate limit, tamaño de body, topes por rutina, ring de errores ──
{
    console.log('\nAbuso: rate limit / body / topes');
    // Rate limit: binding mockeado que deja pasar N llamadas por key
    const hits = {};
    const mkLimiter = (n) => ({ limit: async ({ key }) => { hits[key] = (hits[key] || 0) + 1; return { success: hits[key] <= n }; } });
    env.RL_OPEN = mkLimiter(3); env.RL_STRICT = mkLimiter(1);
    let last;
    for (let i = 0; i < 4; i++) last = await call('GET', '/api/health', undefined, { 'CF-Connecting-IP': '5.5.5.5' });
    ok('4ta request abierta desde la misma IP → 429', last.status === 429, last.status);
    const other = await call('GET', '/api/health', undefined, { 'CF-Connecting-IP': '6.6.6.6' });
    ok('otra IP no se ve afectada', other.status === 200);
    const e1 = await call('POST', '/api/errors', { errors: [{ msg: 'a' }] }, { 'CF-Connecting-IP': '7.7.7.7' });
    const e2 = await call('POST', '/api/errors', { errors: [{ msg: 'b' }] }, { 'CF-Connecting-IP': '7.7.7.7' });
    ok('/api/errors usa el limitador estricto (2da → 429)', e1.status === 200 && e2.status === 429, [e1.status, e2.status]);
    const a1 = await call('GET', '/api/admin/errors', undefined, { 'CF-Connecting-IP': '8.8.8.8', 'x-admin-secret': 'nope' });
    const a2 = await call('GET', '/api/admin/errors', undefined, { 'CF-Connecting-IP': '8.8.8.8', 'x-admin-secret': 'nope' });
    ok('fuerza bruta del admin secret → 401 y luego 429', a1.status === 401 && a2.status === 429, [a1.status, a2.status]);
    delete env.RL_OPEN; delete env.RL_STRICT;

    // Body demasiado grande: por Content-Length declarado y por tamaño real
    const bigDeclared = await worker.fetch(new Request('https://api.test/api/routines', { method: 'POST', headers: { 'Content-Type': 'application/json', 'content-length': String(300 * 1024) }, body: '{}' }), env);
    ok('Content-Length > 256 KB → 413', bigDeclared.status === 413, bigDeclared.status);
    const bigReal = await call('POST', '/api/routines', { coach_id: 'c', name: 'x', plan: { pad: 'x'.repeat(300 * 1024) } });
    ok('body real > 256 KB → 413', bigReal.status === 413, bigReal.status);
    const bigPlan = await call('POST', '/api/routines', { coach_id: 'c', name: 'x', plan: { pad: 'x'.repeat(120 * 1024) } });
    ok('plan > 100 KB → 413', bigPlan.status === 413, bigPlan.status);

    // Topes por rutina: edits (EDITS_MAX = 50) y sesiones (fecha válida, una key)
    const cr = await call('POST', '/api/routines', { coach_id: 'coachZ', name: 'Tope', plan: [{ day: 'A' }] });
    const tk = cr.body.share_token, rid = cr.body.id;
    const bigEdit = await call('POST', '/api/shares/' + tk + '/edits', { changes_json: { pad: 'x'.repeat(5000) } });
    ok('edit > 4 KB → 413', bigEdit.status === 413, bigEdit.status);
    for (let i = 0; i < 60; i++) await call('POST', '/api/shares/' + tk + '/edits', { changes_json: { i }, editor_name: 'Alumno ' + i });
    const det = await call('GET', '/api/routines/' + rid + '?coach_id=coachZ');
    ok('60 edits → se guardan 50 (los más nuevos), contador dice 60', det.body.edits.length === 50 && det.body.edits[0].changes_json.i === 59, det.body.edits.length);
    const lst = await call('GET', '/api/routines?coach_id=coachZ');
    ok('lista del coach: edit_count 60, unreviewed 60', lst.body[0].edit_count === 60 && lst.body[0].unreviewed_count === 60, lst.body[0]);
    ok('sin keys sueltas por edit (una key agregada)', ![...env.BMOD_KV._m.keys()].some(k => k.startsWith('edit:')));
    const badDate = await call('POST', '/api/shares/' + tk + '/sessions', { date: '9999-99-99' });
    const fakeDate = await call('POST', '/api/shares/' + tk + '/sessions', { date: '2026-02-30' });
    const oldDate = await call('POST', '/api/shares/' + tk + '/sessions', { date: '2019-01-01' });
    ok('fechas inválidas / inexistentes / muy viejas → 400', badDate.status === 400 && fakeDate.status === 400 && oldDate.status === 400, [badDate.status, fakeDate.status, oldDate.status]);
    const longName = await call('POST', '/api/shares/' + tk + '/edits', { changes_json: { x: 1 }, editor_name: 'N'.repeat(200) });
    ok('editor_name recortado a 40', longName.body.editor_name.length === 40);

    // Ring de errores: una sola key, tope 150, más nuevo primero
    for (let i = 0; i < 10; i++) await call('POST', '/api/errors', { errors: Array.from({ length: 20 }, (_, j) => ({ msg: 'e' + i + '-' + j, at: new Date().toISOString() })) });
    const ring = await call('GET', '/api/admin/errors', undefined, { 'x-admin-secret': 'test-admin' });
    ok('ring de errores acotado a 150 y sin keys sueltas', ring.body.count === 150 && ![...env.BMOD_KV._m.keys()].some(k => k.startsWith('error:')), ring.body.count);
    ok('el error más reciente va primero', ring.body.errors[0].msg === 'e9-0', ring.body.errors[0]);
}

// ── Pre-producción: trial por IP, cuota de IA, ticket de pago ──
{
    console.log('\nPre-producción: trial por IP / cuota IA / ticket de pago');
    // Trial: 5 por IP cada 30 días aunque cambie el deviceId
    let last;
    for (let i = 0; i < 6; i++) last = await call('POST', '/api/license/trial', { deviceId: 'ipdev' + i, product: 'premium' }, { 'CF-Connecting-IP': '44.44.44.44' });
    ok('6to trial desde la misma IP (deviceIds distintos) → 429', last.status === 429, last.body);
    const otherIp = await call('POST', '/api/license/trial', { deviceId: 'ipdevX', product: 'premium' }, { 'CF-Connecting-IP': '55.55.55.55' });
    ok('otra IP → trial ok', otherIp.status === 200 && otherIp.body.trial === true, otherIp.body);
    ok('la IP no queda en claro en KV', ![...env.BMOD_KV._m.keys()].some(k => k.includes('44.44.44.44')));
    const coachSameIp = await call('POST', '/api/license/trial', { deviceId: 'ipdevC', product: 'coach' }, { 'CF-Connecting-IP': '44.44.44.44' });
    ok('el tope es por producto (coach desde esa IP sigue ok)', coachSameIp.status === 200, coachSameIp.body);

    // Cuota diaria de IA por licencia: oracle 20, parse 5
    env.AI = {
        async run() { return { response: '{"insights":[{"icon":"📈","title":"t","text":"x"}]}' }; },
        async toMarkdown() { return [{ data: 'Día 1: Press banca 3x8 con 60 kg y sentadilla 4x6' }]; }
    };
    const gen = await call('POST', '/api/admin/codes', { count: 1, product: 'premium' }, { 'x-admin-secret': 'test-admin' });
    const act = await call('POST', '/api/license/activate', { code: gen.body.codes[0], deviceId: 'quota-dev' });
    let oracleLast;
    for (let i = 0; i < 21; i++) oracleLast = await call('POST', '/api/oracle', oracleBody(act.body.token));
    ok('Oracle: llamada 21 del día → 429', oracleLast.status === 429 && /límite diario/.test(oracleLast.body.error || ''), oracleLast.body);
    const gen2 = await call('POST', '/api/admin/codes', { count: 1, product: 'premium' }, { 'x-admin-secret': 'test-admin' });
    const act2 = await call('POST', '/api/license/activate', { code: gen2.body.codes[0], deviceId: 'quota-dev-2' });
    const otherLic = await call('POST', '/api/oracle', oracleBody(act2.body.token));
    ok('otra licencia tiene su propia cuota', otherLic.status === 200, otherLic.status);
    let parseLast;
    for (let i = 0; i < 6; i++) parseLast = await call('POST', '/api/parse-routine', { token: act.body.token, pdf_base64: 'JVBERi0=' });
    ok('Importar PDF: llamada 6 del día → 429', parseLast.status === 429, parseLast.body);
    const legacyKey = await call('POST', '/api/oracle', { apiKey: 'sk-ant-x', prompt: 'x' });
    ok('app vieja con clave propia → 400 y no consume cuota (no 429)', legacyKey.status === 400, legacyKey.status);
    // Con los datos en Durable Objects, la cuota vive en el objeto de contadores (sin escrituras de KV)
    const aiqRows = coachData() ? counterRows() : env.BMOD_KV._m;
    const dayKeys = [...aiqRows.keys()].filter(k => k.startsWith('aiq:') && (k.endsWith(gen.body.codes[0]) || k.endsWith(gen2.body.codes[0])));
    const q1raw = aiqRows.get('aiq:' + new Date().toISOString().slice(0, 10) + ':' + gen.body.codes[0]);
    const q1 = coachData() ? (q1raw && q1raw.f) : JSON.parse(q1raw);
    if (coachData()) ok('la cuota de IA no escribe en KV', ![...env.BMOD_KV._m.keys()].some(k => k.startsWith('aiq:')));
    ok('cuota: una key por licencia y día, con ambos contadores', dayKeys.length === 2 && q1.oracle === 20 && q1.parse === 5, [dayKeys, q1]);
    delete env.AI;

    // Ticket de pago: durable paid:{id} + ticket payment:{id} con gracia tras el primer retiro
    env.MP_ACCESS_TOKEN = 'TEST-mp-token';
    const realFetch2 = globalThis.fetch;
    globalThis.fetch = async (u) => String(u).includes('/v1/payments/889')
        ? new Response(JSON.stringify({ status: 'approved', external_reference: 'premium_1m', transaction_amount: 7500, currency_id: 'ARS' }), { status: 200 })
        : new Response('{}', { status: 404 });
    const wh1 = await call('POST', '/api/webhook/mercadopago', { type: 'payment', data: { id: '889' } });
    wh1.body.code = await env.BMOD_KV.get('paid:889');
    const ticketRaw = JSON.parse(await env.BMOD_KV.get('payment:889'));
    ok('webhook escribe ticket JSON sin retirar + marcador paid', wh1.body.code && ticketRaw.code === wh1.body.code && ticketRaw.retrieved_at === null && (await env.BMOD_KV.get('paid:889')) === wh1.body.code, ticketRaw);
    const r1 = await call('GET', '/api/license/retrieve?payment=889');
    const r2 = await call('GET', '/api/license/retrieve?payment=889');
    ok('retirar dos veces (refresh) devuelve el mismo código', r1.body.status === 'ready' && r1.body.code === wh1.body.code && r2.body.code === wh1.body.code, [r1.body, r2.body]);
    const ticketAfter = JSON.parse(await env.BMOD_KV.get('payment:889'));
    ok('el primer retiro marca retrieved_at (ticket pasa a gracia corta)', typeof ticketAfter.retrieved_at === 'string', ticketAfter);
    const wh2 = await call('POST', '/api/webhook/mercadopago', { type: 'payment', data: { id: '889' } });
    ok('webhook repetido → mismo código (idempotente por paid:)', wh2.body.dup === true && (await env.BMOD_KV.get('paid:889')) === wh1.body.code, wh2.body);
    await env.BMOD_KV.delete('payment:889'); // simula el vencimiento de la gracia
    const r3 = await call('GET', '/api/license/retrieve?payment=889');
    ok('vencida la gracia → pending (el código sigue en code:)', r3.body.status === 'pending' && !!(await env.BMOD_KV.get('code:' + wh1.body.code)), r3.body);
    await env.BMOD_KV.put('payment:legacy1', 'BMOD-LEGA-CY01');
    const rl = await call('GET', '/api/license/retrieve?payment=legacy1');
    ok('ticket con formato viejo (string) sigue funcionando', rl.body.status === 'ready' && rl.body.code === 'BMOD-LEGA-CY01', rl.body);
    globalThis.fetch = realFetch2;
    delete env.MP_ACCESS_TOKEN;
}

// ── Métricas anónimas (Analytics Engine) ──
{
    console.log('\nMétricas anónimas: /api/e + conversiones server-side');
    const points = [];
    env.EVENTS = { writeDataPoint: (dp) => points.push(dp) };

    const v = await call('POST', '/api/e', { e: 'view', p: '/testers.html', r: 'tiktok' }, { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Mobile', 'CF-Connecting-IP': '12.12.12.12' });
    ok('view → 204 y un data point', v.status === 204 && points.length === 1, v.status);
    ok('data point: [evento, nombre, ruta, origen, país, m|d, sistema, superficie], sin IP ni UA', JSON.stringify(points[0].blobs) === JSON.stringify(['view', '', '/testers.html', 'tiktok', '', 'm', 'android', 'web']) && !JSON.stringify(points[0]).includes('12.12.12.12') && !JSON.stringify(points[0]).includes('Android 14'), points[0]);

    await call('POST', '/api/e', { e: 'cta', n: 'buy_premium', p: '/', r: 'TikTok' });
    ok('cta con nombre; origen normalizado a minúsculas', points[1].blobs[0] === 'cta' && points[1].blobs[1] === 'buy_premium' && points[1].blobs[3] === 'tiktok', points[1].blobs);

    await call('POST', '/api/e', { e: 'view', p: '/x?email=a@b.com', r: '<script>', n: 'DROP TABLE' });
    ok('ruta/origen/nombre inválidos se sanean (no se guarda basura)', points[2].blobs[2] === '/' && points[2].blobs[3] === 'other' && points[2].blobs[1] === '', points[2].blobs);

    const bad = await call('POST', '/api/e', { e: 'purchase_hack' });
    ok('evento fuera de la lista → 400 y no escribe', bad.status === 400 && points.length === 3);
    const big = await call('POST', '/api/e', { e: 'view', p: '/' + 'a'.repeat(5000) });
    ok('beacon de más de 2 KB → 413', big.status === 413, big.status);

    // conversiones desde los endpoints existentes
    const before = points.length;
    await call('POST', '/api/license/trial', { deviceId: 'ev-trial-dev', product: 'premium' }, { 'CF-Connecting-IP': '77.77.77.77' });
    const gen = await call('POST', '/api/admin/codes', { count: 1, product: 'coach' }, { 'x-admin-secret': 'test-admin' });
    await call('POST', '/api/license/activate', { code: gen.body.codes[0], deviceId: 'ev-act-dev' });
    await call('POST', '/api/license/activate', { code: gen.body.codes[0], deviceId: 'ev-act-dev' }); // re-activar: no cuenta
    const conv = points.slice(before).map(dp => dp.blobs[0] + ':' + dp.blobs[1]);
    ok('trial y activación se registran una vez cada una', JSON.stringify(conv) === JSON.stringify(['trial:premium', 'activate:coach']), conv);
    const tr = points[before].blobs, act = points[before + 1].blobs;
    ok('conversión sin superficie (app vieja) → sistema del UA y superficie vacía', tr[6] === 'otro' && tr[7] === '' && act[7] === '', [tr, act]);

    await call('POST', '/api/license/trial', { deviceId: 'ev-trial-ios', product: 'premium', surface: 'web' }, { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1', 'CF-Connecting-IP': '77.77.77.78' });
    const ios = points[points.length - 1].blobs;
    ok('trial desde iPhone en la web → ios / web / m', ios[0] === 'trial' && ios[5] === 'm' && ios[6] === 'ios' && ios[7] === 'web', ios);
    await call('POST', '/api/license/trial', { deviceId: 'ev-trial-twa', product: 'premium', surface: 'app' }, { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Chrome/130.0', 'CF-Connecting-IP': '77.77.77.79' });
    const twa = points[points.length - 1].blobs;
    ok('trial desde la app de Play → android / app', twa[6] === 'android' && twa[7] === 'app', twa);
    await call('POST', '/api/license/trial', { deviceId: 'ev-trial-bad', product: 'premium', surface: '<script>' }, { 'CF-Connecting-IP': '77.77.77.80' });
    ok('superficie desconocida no se guarda', points[points.length - 1].blobs[7] === '', points[points.length - 1].blobs);

    const noAuth = await call('GET', '/api/admin/stats');
    ok('stats sin admin → 401', noAuth.status === 401);
    const noTok = await call('GET', '/api/admin/stats', undefined, { 'x-admin-secret': 'test-admin' });
    ok('stats sin token de Analytics → 503 explicativo', noTok.status === 503 && /CF_ANALYTICS_TOKEN/.test(noTok.body.error), noTok.body);

    env.CF_ACCOUNT_ID = 'acc123'; env.CF_ANALYTICS_TOKEN = 'tok';
    const realFetch3 = globalThis.fetch; const sqls = [];
    globalThis.fetch = async (u, o) => { sqls.push({ u: String(u), sql: o.body, auth: o.headers.Authorization }); return new Response(JSON.stringify({ data: [{ evento: 'view', total: 3 }] }), { status: 200 }); };
    const st = await call('GET', '/api/admin/stats?days=9999', undefined, { 'x-admin-secret': 'test-admin' });
    ok('stats consulta el SQL API con el token y acota días a 90', st.status === 200 && st.body.days === 90 && sqls.length === 3 && st.body.por_sistema && sqls[0].u.includes('/accounts/acc123/analytics_engine/sql') && sqls[0].auth === 'Bearer tok' && sqls.every(q => q.sql.includes("INTERVAL '90' DAY")), [st.body, sqls.map(q => q.u)]);
    globalThis.fetch = realFetch3;
    delete env.CF_ACCOUNT_ID; delete env.CF_ANALYTICS_TOKEN; delete env.EVENTS;

    const noBinding = await call('POST', '/api/e', { e: 'view', p: '/', r: 'x' });
    ok('sin binding (wrangler dev / tests) → 204 igual, no rompe', noBinding.status === 204);
}

// ── Salud off + server-info + 404 ──
{
    console.log('\nVarios');
    const hd = await call('POST', '/api/health-data', { user_id: 'u1', snapshots: [{ date: '2026-06-13' }] });
    ok('health-data off → 501', hd.status === 501, hd.body);
    const si = await call('GET', '/api/server-info');
    ok('server-info prod share_origin', si.status === 200 && si.body.share_origin.includes('github.io') && si.body.prod === true, si.body);
    const nf = await call('GET', '/api/nope');
    ok('ruta inexistente → 404', nf.status === 404);
}

// ── Balance del programa (12 semanas) ──
{
    console.log('\nBalance del programa');
    const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const C = 'coachBAL';
    const r = (await call('POST', '/api/routines', { coach_id: C, name: 'Plan', plan: [{ name: 'A', exercises: [] }, { name: 'B', exercises: [] }, { name: 'C', exercises: [] }, { name: 'D', exercises: [] }], alumno_name: 'Sol', coach_name: 'Profe' })).body;
    const tk = r.share_token;
    const sinInicio = await call('PUT', '/api/routines/' + r.id + '/review', { coach_id: C, results: 'x' });
    ok('sin inicio del programa → 400', sinInicio.status === 400);
    await call('PUT', '/api/routines/' + r.id, { coach_id: C, profile: { start_date: day(20), goals: 'Ganar fuerza' } });
    const pronto = await call('PUT', '/api/routines/' + r.id + '/review', { coach_id: C, results: 'x' });
    ok('antes de las 4 semanas → 400', pronto.status === 400);
    await call('PUT', '/api/routines/' + r.id, { coach_id: C, profile: { start_date: day(83), goals: 'Ganar fuerza' } });
    await call('PUT', '/api/routines/' + r.id, { coach_id: C, profile: { start_date: day(83), goals: 'Fuerza y bajar 3 kg' } });
    // 12 semanas a 4 días: 48 sesiones; las más viejas pierden el detalle (quedan las 40 nuevas)
    for (let i = 0; i < 48; i++) {
        const d = 82 - Math.floor(i * 82 / 48);
        await call('POST', '/api/shares/' + tk + '/sessions', { date: day(d), exercises: [{ name: 'Sentadilla', sets: [{ kg: 60 + Math.floor(i / 4) * 1.25, reps: 8 }] }, { name: 'Press', sets: [{ kg: 40, reps: 8 }, { kg: 40, reps: 8 }] }] });
    }
    await call('POST', '/api/shares/' + tk + '/checkins', { date: day(80), weight: 72, energy: 2 });
    await call('POST', '/api/shares/' + tk + '/checkins', { date: day(3), weight: 69.5, energy: 4 });
    const agg = JSON.parse(env.BMOD_KV._m.get('sessions:' + r.id));
    ok('las sesiones más viejas ya no guardan el detalle', agg.items.length === 48 && agg.items[47].exercises === undefined, agg.items.length);
    const rec = JSON.parse(env.BMOD_KV._m.get('routine:' + C + ':' + r.id));
    ok('pero queda la primera marca de cada ejercicio', rec.ex_first && rec.ex_first.Sentadilla && rec.ex_first.Sentadilla.kg === 60 && rec.ex_first.Sentadilla.date === day(82), rec.ex_first);
    ok('y el volumen de cada sesión', Object.keys(rec.vol_log || {}).length === 48 && rec.vol_log[day(82)][1] === 3, Object.keys(rec.vol_log || {}).length);
    const det = await call('GET', '/api/routines/' + r.id + '?coach_id=' + C);
    const dr = det.body.review_draft;
    ok('el detalle ofrece armar el balance (12 semanas, 3 ciclos)', dr && dr.from === day(83) && dr.stats.weeks === 12 && dr.stats.cycles.length === 3 && det.body.review === null, dr && dr.stats.cycles);
    const sq = dr.stats.exercises.find((e) => e.name === 'Sentadilla');
    ok('progresión desde la primera marca (60 kg), no desde la sesión 9', sq && sq.first.kg === 60 && sq.last.kg === 73.8 && sq.change === 23, sq);
    ok('cumplimiento total, volumen y series de las 48 sesiones', dr.stats.sessions === 48 && dr.stats.total_sets === 144 && dr.stats.total_volume > 0, [dr.stats.sessions, dr.stats.total_sets, dr.stats.total_volume]);
    ok('peso 72 → 69,5 y ánimo del primer y último ciclo', dr.stats.weight_from === 72 && dr.stats.weight_to === 69.5 && dr.stats.cycles[0].energy === 2 && dr.stats.cycles[2].energy === 4, dr.stats.cycles);
    ok('objetivo con el que arrancó y el de hoy', dr.stats.goal_start === 'Ganar fuerza' && dr.stats.goal === 'Fuerza y bajar 3 kg', [dr.stats.goal_start, dr.stats.goal]);
    const vacio = await call('PUT', '/api/routines/' + r.id + '/review', { coach_id: C });
    ok('balance sin texto → 400', vacio.status === 400);
    const otro = await call('PUT', '/api/routines/' + r.id + '/review', { coach_id: 'coachOtro', results: 'x' });
    ok('otro coach no puede', otro.status === 404 || otro.status === 403, otro.status);
    const sv = await call('PUT', '/api/routines/' + r.id + '/review', { coach_id: C, results: 'Subiste 15 kg en sentadilla', technique: 'Mejor profundidad', pending: 'Constancia', new_goals: 'Bajar 2 kg más', next: 'Bloque de fuerza', extra: 'no' });
    ok('balance guardado 201 con los datos y los cinco textos', sv.status === 201 && sv.body.review.stats.weeks === 12 && sv.body.review.next === 'Bloque de fuerza' && sv.body.review.extra === undefined, sv.body);
    const sh = await call('GET', '/api/shares/' + tk);
    ok('el alumno ve su balance por el link', sh.body.review && sh.body.review.results === 'Subiste 15 kg en sentadilla' && !!sh.body.review.stats, sh.body.review && Object.keys(sh.body.review));
    const created = sv.body.review.created_at;
    const ed = await call('PUT', '/api/routines/' + r.id + '/review', { coach_id: C, results: 'Editado' });
    ok('editar: 200, conserva la creación y reemplaza los textos', ed.status === 200 && ed.body.review.created_at === created && ed.body.review.results === 'Editado' && ed.body.review.next === undefined);
    const del = await call('DELETE', '/api/routines/' + r.id + '/review?coach_id=' + C);
    const sh2 = await call('GET', '/api/shares/' + tk);
    ok('borrar el balance', del.status === 200 && sh2.body.review === null);
    await call('PUT', '/api/routines/' + r.id + '/review', { coach_id: C, results: 'Otra vez' });
    await call('DELETE', '/api/routines/' + r.id + '?coach_id=' + C);
    ok('dar de baja borra el balance', !env.BMOD_KV._m.has('review:' + r.id));
}

// ── El alumno deja a su coach y borra sus datos ──
{
    console.log('\nEl alumno deja a su coach');
    const ADMIN = { 'x-admin-secret': 'test-admin' };
    const C = 'coachLEAVE1';
    const kv = env.BMOD_KV._m;
    const code = (c) => JSON.parse(kv.get('code:' + c));
    const today = new Date().toISOString().slice(0, 10);
    const r = (await call('POST', '/api/routines', { coach_id: C, name: 'Plan Ana', plan: [{ name: 'A', exercises: [] }], alumno_name: 'Ana' })).body;
    const otro = (await call('POST', '/api/routines', { coach_id: C, name: 'Plan Beto', plan: [{ name: 'A', exercises: [] }], alumno_name: 'Beto' })).body;
    const tk = r.share_token;
    await call('POST', '/api/shares/' + tk + '/sessions', { date: today, exercises: [{ name: 'Sentadilla', sets: [{ kg: 50, reps: 8 }] }] });
    await call('POST', '/api/shares/' + tk + '/checkins', { weight: '60', energy: 4 });
    await call('POST', '/api/shares/' + tk + '/edits', { changes_json: { a: 1 } });
    const c1 = (await call('POST', '/api/admin/codes', { count: 1, product: 'premium', months: 3, coach_pack: true }, ADMIN)).body.codes[0];
    await call('POST', '/api/license/activate', { code: c1, deviceId: 'devAnaLeave', share: tk });
    ok('antes de irse tiene datos y el Premium del coach atado', kv.has('sessions:' + r.id) && kv.has('checkins:' + r.id) && kv.has('edits:' + r.id) && code(c1).routine_id === r.id);
    const sinConf = await call('POST', '/api/shares/' + tk + '/leave', {});
    const confMal = await call('POST', '/api/shares/' + tk + '/leave', { confirm: 'si' });
    ok('sin { confirm: true } → 400 y no borra nada', sinConf.status === 400 && confMal.status === 400 && kv.has('routine:' + C + ':' + r.id) && kv.has('sessions:' + r.id));
    const lv = await call('POST', '/api/shares/' + tk + '/leave', { confirm: true });
    ok('se va: 200 y se anula el Premium que le dio el coach', lv.status === 200 && lv.body.revoked === 1 && code(c1).revoked === true && code(c1).revoked_reason === 'alumno_baja', lv.body);
    const quedan = [...kv.keys()].filter((k) => k.includes(r.id) || k.includes(tk));
    ok('se borra todo lo suyo del servidor', quedan.length === 0, quedan);
    ok('su link deja de funcionar', (await call('GET', '/api/shares/' + tk)).status === 404);
    const list = await call('GET', '/api/routines?coach_id=' + C);
    ok('el coach deja de verlo; el otro alumno sigue', list.body.length === 1 && list.body[0].id === otro.id, list.body.map((x) => x.id));
    const cfg = await call('GET', '/api/coach/config?coach_id=' + C);
    ok('al coach le queda un aviso con el nombre que él cargó', cfg.body.left.length === 1 && cfg.body.left[0].name === 'Ana' && !!cfg.body.left[0].at, cfg.body.left);
    ok('irse dos veces → 404', (await call('POST', '/api/shares/' + tk + '/leave', { confirm: true })).status === 404);
    const raw = JSON.parse(kv.get('coachcfg:' + C));
    raw.left.push({ name: 'Viejo', at: new Date(Date.now() - 31 * 86400000).toISOString() });
    kv.set('coachcfg:' + C, JSON.stringify(raw));
    const cfg2 = await call('GET', '/api/coach/config?coach_id=' + C);
    ok('los avisos de más de 30 días ya no se muestran', cfg2.body.left.length === 1 && cfg2.body.left[0].name === 'Ana', cfg2.body.left);
    const lv2 = await call('POST', '/api/shares/' + otro.share_token + '/leave', { confirm: true });
    const raw2 = JSON.parse(kv.get('coachcfg:' + C));
    ok('el segundo aviso va primero y los vencidos se limpian al guardar', lv2.status === 200 && raw2.left.length === 2 && raw2.left[0].name === 'Beto' && raw2.left[1].name === 'Ana', raw2.left);
    const del = await call('DELETE', '/api/routines/' + r.id + '?coach_id=' + C);
    ok('la baja del coach sigue funcionando igual (ya no existe → 404)', del.status === 404);
}

// ── Accesos Premium del coach: los da desde el panel y el alumno los recibe sin código ──
{
    console.log('\nAccesos Premium del coach (cupo)');
    const ADMIN = { 'x-admin-secret': 'test-admin' };
    const kv = env.BMOD_KV._m;
    const PANEL = 'panel-cupo-0001';
    const cc = (await call('POST', '/api/admin/codes', { count: 1, product: 'coach' }, ADMIN)).body.codes[0];
    await call('POST', '/api/license/activate', { code: cc, deviceId: 'devCoachCupo1', coach_id: PANEL });
    const malo = await call('POST', '/api/admin/codes', { count: 2, product: 'premium', months: 3, coach_pack: true, coach_code: 'BMOD-NOEX-ISTE' }, ADMIN);
    ok('cupo: un código de Coach que no existe → 400', malo.status === 400);
    const gen = await call('POST', '/api/admin/codes', { count: 2, product: 'premium', months: 3, coach_pack: true, label: 'Cupo', coach_code: cc }, ADMIN);
    ok('cupo: los accesos se cargan al panel del coach', gen.status === 200 && gen.body.seats.total === 2 && gen.body.seats.free === 2, gen.body);
    const cfg0 = await call('GET', '/api/coach/config?coach_id=' + PANEL);
    ok('el coach ve cuántos accesos tiene (sin ver los códigos)', cfg0.body.seats.total === 2 && cfg0.body.seats.free === 2 && !JSON.stringify(cfg0.body).includes(gen.body.codes[0]));
    const mk = async (n) => (await call('POST', '/api/routines', { coach_id: PANEL, name: 'Plan ' + n, plan: [{ name: 'A', exercises: [] }], alumno_name: n })).body;
    const a = await mk('Ana Cupo'), b = await mk('Beto Cupo'), c = await mk('Caro Cupo');
    const da = await call('POST', '/api/routines/' + a.id + '/premium', { coach_id: PANEL });
    ok('darle Premium: 201, queda asignado y baja el cupo', da.status === 201 && da.body.seat.status === 'assigned' && da.body.seats.free === 1, da.body);
    const det = await call('GET', '/api/routines/' + a.id + '?coach_id=' + PANEL);
    ok('el detalle muestra el estado, nunca el código', det.body.routine.seat.status === 'assigned' && !JSON.stringify(det.body).includes(gen.body.codes[0]) && !JSON.stringify(det.body).includes(gen.body.codes[1]));
    ok('el link del alumno avisa que tiene un Premium para activar', (await call('GET', '/api/shares/' + a.share_token)).body.premium_seat === true && (await call('GET', '/api/shares/' + b.share_token)).body.premium_seat === false);
    const sinCupo = await call('POST', '/api/shares/' + b.share_token + '/premium-auto', { deviceId: 'devBeto0001' });
    ok('un alumno sin acceso asignado no recibe nada', sinCupo.status === 200 && sinCupo.body.none === true);
    const au = await call('POST', '/api/shares/' + a.share_token + '/premium-auto', { deviceId: 'devAnaUno01' });
    const ver = await call('POST', '/api/license/verify', { token: au.body.token });
    ok('el teléfono del alumno recibe la licencia sin tipear nada', au.status === 200 && !!au.body.token && ver.body.valid === true && !!au.body.expiresAt, [au.body, ver.body]);
    const list1 = await call('GET', '/api/routines?coach_id=' + PANEL);
    ok('el panel muestra que ya lo activó', list1.body.find((x) => x.id === a.id).seat.status === 'active');
    const re = await call('POST', '/api/shares/' + a.share_token + '/premium-auto', { deviceId: 'devAnaUno01' });
    ok('mismo teléfono: vuelve a recibirla sin contar como cambio', re.status === 200 && JSON.parse(kv.get('code:' + gen.body.codes[0])).rebinds === undefined);
    for (const d of ['devAnaDos02', 'devAnaTres3', 'devAnaCuat4']) await call('POST', '/api/shares/' + a.share_token + '/premium-auto', { deviceId: d });
    const tope = await call('POST', '/api/shares/' + a.share_token + '/premium-auto', { deviceId: 'devAnaCinc5' });
    const det2 = await call('GET', '/api/routines/' + a.id + '?coach_id=' + PANEL);
    ok('pasar a otro teléfono tiene tope (3) y el coach lo ve', tope.status === 409 && tope.body.moved_max === true && det2.body.routine.seat.moves === 3 && det2.body.routine.seat.blocked === true, [tope.status, det2.body.routine.seat]);
    await call('POST', '/api/routines/' + a.id + '/premium', { coach_id: PANEL, reset: true });
    const tras = await call('POST', '/api/shares/' + a.share_token + '/premium-auto', { deviceId: 'devAnaCinc5' });
    ok('el coach lo habilita en el teléfono nuevo', tras.status === 200 && !!tras.body.token);
    await call('POST', '/api/routines/' + b.id + '/premium', { coach_id: PANEL });
    const lleno = await call('POST', '/api/routines/' + c.id + '/premium', { coach_id: PANEL });
    ok('sin accesos libres → 409', lleno.status === 409 && lleno.body.no_seats === true && lleno.body.seats.free === 0);
    const quita = await call('DELETE', '/api/routines/' + b.id + '/premium?coach_id=' + PANEL);
    ok('quitárselo a quien nunca lo usó lo devuelve al cupo', quita.status === 200 && quita.body.freed === true && quita.body.seats.free === 1);
    const baja = await call('DELETE', '/api/routines/' + a.id + '?coach_id=' + PANEL);
    const ver2 = await call('POST', '/api/license/verify', { token: tras.body.token });
    const cfg1 = await call('GET', '/api/coach/config?coach_id=' + PANEL);
    ok('dar de baja a quien lo usaba lo anula (ese acceso se gastó)', baja.body.revoked === 1 && ver2.body.valid === false && cfg1.body.seats.total === 1 && cfg1.body.seats.free === 1, [baja.body, cfg1.body.seats]);
    await call('POST', '/api/routines/' + c.id + '/premium', { coach_id: PANEL });
    await call('PUT', '/api/routines/' + c.id, { coach_id: PANEL, profile: { modality: '', start_date: '', status: 'activo', goals: '', notes: '', access_until: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10) } });
    const cerr = await call('POST', '/api/shares/' + c.share_token + '/premium-auto', { deviceId: 'devCaroUno1' });
    ok('con el acceso cerrado no se activa', cerr.status === 403 && cerr.body.closed === true);
    const bajaC = await call('DELETE', '/api/routines/' + c.id + '?coach_id=' + PANEL);
    const cfg2 = await call('GET', '/api/coach/config?coach_id=' + PANEL);
    ok('dar de baja a quien nunca lo usó lo devuelve al cupo', bajaC.status === 200 && bajaC.body.revoked === 0 && cfg2.body.seats.free === 1, cfg2.body.seats);
    await call('DELETE', '/api/routines/' + b.id + '?coach_id=' + PANEL);
}

// ── Pasar los datos de Safari a la app instalada (iPhone) ──
{
    console.log('\nPasar los datos de Safari a la app');
    const IP = (x) => ({ 'CF-Connecting-IP': x });
    const fp = { os: '18_1', dev: 'iphone', scr: '393x852', dpr: 3, tz: 'America/Argentina/Buenos_Aires' };
    const nuevo = async (code, f = fp, ip = '200.1.2.3') => call('POST', '/api/transfer', { data: 'CIFRADO-' + code, wrap: 'ENVUELTA-' + code, code, fp: f }, IP(ip));
    const t1 = await nuevo('111111');
    ok('Safari sube la copia cifrada y recibe el pase', t1.status === 201 && /^[a-z0-9]{20}$/.test(t1.body.id) && t1.body.ttl === 1800, t1.body);
    ok('un código que ya está en uso → 409 (el teléfono elige otro)', (await nuevo('111111')).status === 409);
    const c1 = await call('POST', '/api/transfer/claim', { id: t1.body.id, fp }, IP('200.1.2.77'));
    ok('mismo teléfono y misma red: la app recibe la copia sola (sin la clave envuelta)', c1.status === 200 && c1.body.data === 'CIFRADO-111111' && c1.body.wrap === undefined, c1.body);
    ok('sirve una sola vez', (await call('POST', '/api/transfer/claim', { id: t1.body.id, fp }, IP('200.1.2.77'))).status === 404);
    const t2 = await nuevo('222222');
    const otro = { ...fp, scr: '430x932' };
    const c2 = await call('POST', '/api/transfer/claim', { id: t2.body.id, fp: otro }, IP('200.1.2.3'));
    ok('otro teléfono con el link reenviado: no entrega nada y pide el código', c2.status === 403 && c2.body.need_code === true && !c2.body.data);
    const w1 = await call('POST', '/api/transfer/claim', { id: t2.body.id, fp: otro, code: '000001' }, IP('200.1.2.3'));
    const w2 = await call('POST', '/api/transfer/claim', { id: t2.body.id, fp: otro, code: '000002' }, IP('200.1.2.3'));
    const w3 = await call('POST', '/api/transfer/claim', { id: t2.body.id, fp: otro, code: '000003' }, IP('200.1.2.3'));
    ok('código equivocado 3 veces: el pase se anula', w1.status === 403 && w1.body.left === 2 && w2.status === 403 && w3.status === 410 && (await call('POST', '/api/transfer/claim', { id: t2.body.id, fp, code: '222222' }, IP('200.1.2.3'))).status === 404, [w1.body, w3.body]);
    const t3 = await nuevo('333333');
    const c3 = await call('POST', '/api/transfer/claim', { id: t3.body.id, fp }, IP('181.9.9.9'));
    const c3b = await call('POST', '/api/transfer/claim', { id: t3.body.id, fp, code: '333333' }, IP('181.9.9.9'));
    ok('mismo teléfono en otra red: pide el código y con el correcto la entrega (con la clave envuelta)', c3.status === 403 && c3.body.need_code === true && c3b.status === 200 && c3b.body.data === 'CIFRADO-333333' && c3b.body.wrap === 'ENVUELTA-333333');
    const t4 = await nuevo('444444');
    const c4 = await call('POST', '/api/transfer/claim', { code: '444444' }, IP('10.0.0.1'));
    ok('plan B: sin pase, el código solo trae la copia y la clave envuelta', c4.status === 200 && c4.body.data === 'CIFRADO-444444' && c4.body.wrap === 'ENVUELTA-444444' && !!t4.body.id);
    ok('plan B: un código inventado no trae nada', (await call('POST', '/api/transfer/claim', { code: '999999' }, IP('10.0.0.1'))).status === 404);
    const t5 = await nuevo('555555', {});
    ok('sin datos del teléfono nunca se entrega sola (pide el código)', (await call('POST', '/api/transfer/claim', { id: t5.body.id, fp: {} }, IP('200.1.2.3'))).body.need_code === true);
    ok('copia sin código o sin clave envuelta → 400', (await call('POST', '/api/transfer', { data: 'x', wrap: 'y', fp }, IP('200.1.2.3'))).status === 400 && (await call('POST', '/api/transfer', { data: 'x', code: '666666', fp }, IP('200.1.2.3'))).status === 400);
}

// ── Huéspedes de hotel: acceso hasta una fecha, resumen final e invitación ──
{
    console.log('\nHuéspedes de hotel');
    const C = 'coachHOTEL01';
    const kv = env.BMOD_KV._m;
    const rkey = (id) => 'routine:' + C + ':' + id;
    const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);   // n días atrás (negativo: adelante)
    const BA = 'America/Argentina/Buenos_Aires';
    const r = (await call('POST', '/api/routines', { coach_id: C, name: 'Hotel Ana', plan: [{ name: 'A', exercises: [] }], alumno_name: 'Ana Huésped', coach_name: 'Profe' })).body;
    const tk = r.share_token;
    // El coach la marca huésped, con inicio hace 5 días y acceso hasta pasado mañana
    const up = await call('PUT', '/api/routines/' + r.id, { coach_id: C, profile: { modality: 'Hotel', start_date: day(5), status: 'activo', goals: '', notes: '', guest: true, access_until: day(-2), tz: BA } });
    const rec = JSON.parse(kv.get(rkey(r.id)));
    ok('huésped con fecha de fin: cierra a la medianoche de ese día en la zona del coach', up.status === 200 && rec.profile.guest === true && rec.profile.access_until === day(-2)
        && rec.access_end_at === new Date(Date.parse(day(-3) + 'T03:00:00Z')).toISOString(), rec.access_end_at);
    ok('el índice del link guarda el cierre (cada pedido lo chequea sin leer más)', JSON.parse(kv.get('token:' + tk)).until === rec.access_end_at);
    const abierto = await call('GET', '/api/shares/' + tk);
    ok('abierto: el link avisa que es huésped y hasta cuándo, con su rutina', abierto.status === 200 && abierto.body.guest === true && abierto.body.access_until === day(-2) && Array.isArray(abierto.body.routine.plan));
    await call('POST', '/api/shares/' + tk + '/sessions', { date: day(3), exercises: [{ name: 'Sentadilla', sets: [{ kg: 40, reps: 10 }, { kg: 50, reps: 8 }] }] });
    await call('POST', '/api/shares/' + tk + '/sessions', { date: day(2), exercises: [{ name: 'Sentadilla', sets: [{ kg: 55, reps: 8 }] }, { name: 'Remo', sets: [{ kg: 30, reps: 12 }] }] });
    const list0 = await call('GET', '/api/routines?coach_id=' + C + '&today=' + day(0));
    const it0 = list0.body.find((x) => x.id === r.id);
    ok('huésped: sin alertas de control semanal ni de ciclo', it0.guest === true && it0.closed === false && !it0.alerts.some((a) => a.type === 'no_checkin' || a.type === 'eval' || a.type === 'low_adherence'), it0.alerts);

    // Una app vieja guarda la ficha sin los campos nuevos: no los borra
    await call('PUT', '/api/routines/' + r.id, { coach_id: C, profile: { modality: 'Hotel', start_date: day(5), status: 'activo', goals: '', notes: 'x' } });
    const rec1 = JSON.parse(kv.get(rkey(r.id)));
    ok('una app vieja que no manda huésped ni fecha no los pisa', rec1.profile.guest === true && rec1.profile.access_until === day(-2) && rec1.access_end_at === rec.access_end_at);

    // Termina la estadía (último día: hace 2 días)
    await call('PUT', '/api/routines/' + r.id, { coach_id: C, profile: { modality: 'Hotel', start_date: day(5), status: 'activo', goals: '', notes: '', guest: true, access_until: day(2), tz: BA } });
    const cerrado = await call('GET', '/api/shares/' + tk);
    const sm = cerrado.body.summary || {};
    ok('cerrado: el link no trae la rutina, trae el resumen de la estadía', cerrado.status === 200 && cerrado.body.closed === true && cerrado.body.routine.plan === undefined && !!cerrado.body.closed_at
        && sm.sessions === 2 && sm.days === 4 && sm.from === day(5) && sm.to === day(2), cerrado.body);
    const sq = (sm.exercises || []).find((e) => e.name === 'Sentadilla');
    ok('resumen: mejor serie de cada ejercicio y cuánto mejoró en la estadía', sq && sq.n === 2 && sq.best.kg === 55 && sq.best.reps === 8 && sq.change > 0 && sm.total_sets === 4 && sm.total_volume > 0, sm);
    ok('sin invitación cargada, el huésped igual recibe el bloque (vacío)', cerrado.body.invite && cerrado.body.invite.text === '' && cerrado.body.invite.link === '');
    const bloqueos = [
        await call('POST', '/api/shares/' + tk + '/sessions', { date: day(0) }),
        await call('POST', '/api/shares/' + tk + '/checkins', { weight: '60' }),
        await call('POST', '/api/shares/' + tk + '/videos', { exercise: 'Sentadilla', url: 'https://youtu.be/abc123' }),
        await call('POST', '/api/shares/' + tk + '/intake', { goals: ['fuerza'] }),
        await call('POST', '/api/shares/' + tk + '/edits', { changes_json: { a: 1 } }),
        await call('POST', '/api/shares/' + tk + '/push', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'a', auth: 'b' } } })
    ];
    ok('cerrado: no deja cargar sesiones, controles, videos, ficha, cambios ni avisos', bloqueos.every((x) => x.status === 403 && x.body.closed === true), bloqueos.map((x) => x.status));
    const terms = await call('POST', '/api/shares/' + tk + '/terms', { version: '2026-11-14' });
    const rep = await call('POST', '/api/shares/' + tk + '/report', { reason: 'otro' });
    ok('cerrado: sigue pudiendo aceptar términos y reportar', terms.status === 200 && rep.status === 201, [terms.status, rep.status]);
    const rem = await call('POST', '/api/routines/' + r.id + '/remind', { coach_id: C });
    ok('el coach no puede mandarle el recordatorio del control', rem.status === 409, rem.status);

    // Invitación del coach
    const malo = await call('PUT', '/api/coach/config', { coach_id: C, invite: { text: 'Seguí conmigo', link: 'http://inseguro.com' } });
    ok('invitación: el link tiene que ser https', malo.status === 400);
    const inv = await call('PUT', '/api/coach/config', { coach_id: C, invite: { text: 'Seguí entrenando conmigo a distancia', link: 'https://wa.me/5491112345678' } });
    const cfgG = await call('GET', '/api/coach/config?coach_id=' + C);
    const cer2 = await call('GET', '/api/shares/' + tk);
    ok('invitación guardada: la ve el coach y el huésped al terminar', inv.status === 200 && cfgG.body.invite.link === 'https://wa.me/5491112345678' && cer2.body.invite.text === 'Seguí entrenando conmigo a distancia', cer2.body.invite);

    // "Me interesa seguir"
    const want = await call('POST', '/api/shares/' + tk + '/interest', { contact: '+54 9 11 5555 1234', note: 'Me gustó' });
    const want2 = await call('POST', '/api/shares/' + tk + '/interest', {});
    const rec2 = JSON.parse(kv.get(rkey(r.id)));
    ok('me interesa: queda con su contacto, y tocar de nuevo no lo pisa', want.status === 201 && want2.status === 200 && rec2.interest.contact === '+54 9 11 5555 1234' && rec2.interest.note === 'Me gustó', rec2.interest);
    const list1 = await call('GET', '/api/routines?coach_id=' + C + '&today=' + day(0));
    const it1 = list1.body.find((x) => x.id === r.id);
    ok('panel: cerrado, y la única alerta es que quiere seguir', it1.closed === true && it1.interest_at === rec2.interest.at && it1.alerts.length === 1 && it1.alerts[0].type === 'interest', it1);
    const det = await call('GET', '/api/routines/' + r.id + '?coach_id=' + C + '&today=' + day(0));
    ok('detalle: el coach ve el contacto, el resumen de la estadía y la fecha de cierre', det.body.routine.interest.contact === '+54 9 11 5555 1234' && det.body.stay && det.body.stay.sessions === 2 && !!det.body.routine.closed_at && det.body.routine.alerts.length === 0, det.body.stay);
    const list2 = await call('GET', '/api/routines?coach_id=' + C + '&today=' + day(0));
    ok('abrir el detalle marca el interés como visto', list2.body.find((x) => x.id === r.id).alerts.length === 0);
    const cer3 = await call('GET', '/api/shares/' + tk);
    ok('el huésped ve que ya le avisó', cer3.body.interest && cer3.body.interest.at === rec2.interest.at);

    // Cambiar el link conserva el cierre; reabrir el acceso vuelve a mostrar la rutina
    const recC = JSON.parse(kv.get(rkey(r.id)));
    const nl = await call('POST', '/api/routines/' + r.id + '/new-link', { coach_id: C });
    ok('el link nuevo también está cerrado', JSON.parse(kv.get('token:' + nl.body.share_token)).until === recC.access_end_at && (await call('GET', '/api/shares/' + nl.body.share_token)).body.closed === true);
    await call('PUT', '/api/routines/' + r.id, { coach_id: C, profile: { modality: 'Hotel', start_date: day(5), status: 'activo', goals: '', notes: '', guest: true, access_until: '', tz: BA } });
    const reab = await call('GET', '/api/shares/' + nl.body.share_token);
    const ses = await call('POST', '/api/shares/' + nl.body.share_token + '/sessions', { date: day(0) });
    ok('sin fecha de fin, el acceso se reabre', reab.status === 200 && !reab.body.closed && Array.isArray(reab.body.routine.plan) && ses.status === 201 && !JSON.parse(kv.get('token:' + nl.body.share_token)).until && !JSON.parse(kv.get(rkey(r.id))).access_end_at, [reab.status, ses.status]);
    // Con el acceso cerrado, el huésped igual puede borrar sus datos
    await call('PUT', '/api/routines/' + r.id, { coach_id: C, profile: { modality: 'Hotel', start_date: day(5), status: 'activo', goals: '', notes: '', guest: true, access_until: day(2), tz: BA } });
    const lv = await call('POST', '/api/shares/' + nl.body.share_token + '/leave', { confirm: true });
    ok('cerrado: "dejar a este coach y borrar mis datos" sigue andando', lv.status === 200 && !kv.has(rkey(r.id)));
}

// ── Coach: cambiarle el link a un alumno sin darlo de baja ──
{
    console.log('\nCoach: cambiar el link del alumno');
    const C = 'coachNEWLINK1';
    const kv = env.BMOD_KV._m;
    const rkey = (id) => 'routine:' + C + ':' + id;
    const today = new Date().toISOString().slice(0, 10);
    const r = (await call('POST', '/api/routines', { coach_id: C, name: 'Plan Caro', plan: [{ name: 'A', exercises: [] }], alumno_name: 'Caro', coach_name: 'Profe' })).body;
    const t1 = r.share_token;
    await call('POST', '/api/shares/' + t1 + '/sessions', { date: today, exercises: [{ name: 'Sentadilla', sets: [{ kg: 50, reps: 8 }] }] });
    await call('POST', '/api/shares/' + t1 + '/checkins', { weight: '60', energy: 4 });
    const rec0 = JSON.parse(kv.get(rkey(r.id)));
    rec0.push_subs = [{ endpoint: 'https://fcm.googleapis.com/fcm/send/ajeno', keys: { p256dh: 'x', auth: 'y' } }];
    kv.set(rkey(r.id), JSON.stringify(rec0));

    const otro = await call('POST', '/api/routines/' + r.id + '/new-link', { coach_id: 'coachIntruso1' });
    ok('otro coach no puede cambiarlo', otro.status === 404 || otro.status === 403, otro.status);
    const nl = await call('POST', '/api/routines/' + r.id + '/new-link', { coach_id: C });
    const t2 = nl.body && nl.body.share_token;
    ok('link nuevo: 200, otro token y avisos apagados', nl.status === 200 && t2 && t2 !== t1 && nl.body.push_on === 0 && !!nl.body.chk_remind, nl.body);
    const recA = JSON.parse(kv.get(rkey(r.id)));
    ok('en el servidor: se borran los avisos (llevan el link adentro)', Array.isArray(recA.push_subs) && recA.push_subs.length === 0 && recA.share_token === t2 && !!recA.link_changed_at);
    ok('la llave vieja se borra y la nueva apunta al mismo alumno', !kv.has('token:' + t1) && JSON.parse(kv.get('token:' + t2)).routineId === r.id);
    const viejo = await call('GET', '/api/shares/' + t1);
    ok('el link viejo responde 410 "cambió", sin decir cuál es el nuevo', viejo.status === 410 && viejo.body.moved === true && !JSON.stringify(viejo.body).includes(t2), viejo.body);
    const nuevo = await call('GET', '/api/shares/' + t2);
    ok('el link nuevo trae todo lo del alumno', nuevo.status === 200 && nuevo.body.routine.id === r.id && nuevo.body.routine.share_token === t2 && nuevo.body.sessions.length === 1 && nuevo.body.checkins.length === 1, nuevo.body.routine);
    const escribeViejo = await call('POST', '/api/shares/' + t1 + '/sessions', { date: today });
    ok('con el link viejo ya no se puede cargar nada', escribeViejo.status === 404, escribeViejo.status);
    const det = await call('GET', '/api/routines/' + r.id + '?coach_id=' + C);
    ok('el coach ve el link nuevo en el detalle', det.status === 200 && det.body.routine.share_token === t2, det.body.routine && det.body.routine.share_token);

    const nl2 = await call('POST', '/api/routines/' + r.id + '/new-link', { coach_id: C });
    const t3 = nl2.body.share_token;
    ok('se puede cambiar otra vez: los dos links viejos responden 410', nl2.status === 200 && (await call('GET', '/api/shares/' + t1)).status === 410 && (await call('GET', '/api/shares/' + t2)).status === 410 && (await call('GET', '/api/shares/' + t3)).status === 200);
    const del = await call('DELETE', '/api/routines/' + r.id + '?coach_id=' + C);
    ok('dar de baja borra también los avisos de "link cambiado"', del.status === 200 && !kv.has('moved:' + t1) && !kv.has('moved:' + t2) && (await call('GET', '/api/shares/' + t1)).status === 404, [...kv.keys()].filter((k) => k.startsWith('moved:')));

    // Si el registro ya no existe (baja vieja), el aviso de "cambió" no se muestra
    const r2 = (await call('POST', '/api/routines', { coach_id: C, name: 'Plan Dani', plan: [{ name: 'A', exercises: [] }], alumno_name: 'Dani' })).body;
    const d1 = r2.share_token;
    await call('POST', '/api/routines/' + r2.id + '/new-link', { coach_id: C });
    await delRec(rkey(r2.id));
    ok('link viejo de un alumno que ya no está → 404 (no 410)', (await call('GET', '/api/shares/' + d1)).status === 404);
    kv.delete('moved:' + d1);
}

// ── Avisos con texto y a horario (Web Push cifrado + Durable Object) ──
{
    console.log('\nAvisos: cifrado, descanso, recordatorio del control, avisos del coach y resumen');
    const T = Notifier._test;
    const b64 = (u8) => Buffer.from(u8).toString('base64url');
    const unb64 = (x) => new Uint8Array(Buffer.from(x, 'base64url'));

    // 1) Cifrado: idéntico al ejemplo del RFC 8291 (apéndice A)
    const asPub = unb64('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
    const asPriv = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', x: b64(asPub.slice(1, 33)), y: b64(asPub.slice(33, 65)) }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const rfcOut = await T.encryptPushPayload(
        { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
        unb64('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
        { salt: unb64('DGv6ra1nlYgDCS1FRnbzlw'), asPrivate: asPriv, asPublic: asPub });
    ok('cifrado idéntico al ejemplo del RFC 8291', b64(rfcOut) === 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN', b64(rfcOut));

    // 2) Horarios con horario de verano (Madrid cambia el domingo 28 de marzo de 2027)
    ok('próximo domingo 18 h antes del cambio de hora (CET)', T.nextLocalTime(Date.UTC(2027, 2, 18, 12), 0, 18, 'Europe/Madrid') === Date.UTC(2027, 2, 21, 17));
    ok('próximo domingo 18 h el día del cambio de hora (CEST)', T.nextLocalTime(Date.UTC(2027, 2, 25, 12), 0, 18, 'Europe/Madrid') === Date.UTC(2027, 2, 28, 16));
    ok('todos los días a las 9 h de Buenos Aires', T.nextLocalTime(Date.UTC(2027, 0, 10, 15), null, 9, 'America/Argentina/Buenos_Aires') === Date.UTC(2027, 0, 11, 12));

    // Teléfonos de prueba (con su clave para descifrar lo que les llega)
    const makePhone = async (endpoint) => {
        const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
        const auth = crypto.getRandomValues(new Uint8Array(16));
        return { sub: { endpoint, keys: { p256dh: b64(pub), auth: b64(auth) } }, priv: kp.privateKey, pub, auth };
    };
    const hk = async (salt, ikm, info, len) => { const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']); return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8)); };
    const cat = (...ps) => { const o = new Uint8Array(ps.reduce((a, x) => a + x.length, 0)); let i = 0; for (const x of ps) { o.set(x, i); i += x.length; } return o; };
    const decrypt = async (phone, body) => {
        const salt = body.slice(0, 16), idlen = body[20], asPublic = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
        const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
        const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, phone.priv, 256));
        const te = new TextEncoder(), z = new Uint8Array([0]);
        const ikm = await hk(phone.auth, ecdh, cat(te.encode('WebPush: info'), z, phone.pub, asPublic), 32);
        const cek = await hk(salt, ikm, cat(te.encode('Content-Encoding: aes128gcm'), z), 16);
        const nonce = await hk(salt, ikm, cat(te.encode('Content-Encoding: nonce'), z), 12);
        const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
        const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
        return JSON.parse(new TextDecoder().decode(plain.slice(0, plain.length - 1)));
    };

    // Durable Objects de prueba (memoria + alarma) y servicio de push simulado
    const prevNotifier = env.NOTIFIER;
    if (!env.NOTIFIER) env.NOTIFIER = makeDONamespace(Notifier, env);
    const dos = env.NOTIFIER._dos;
    if (!env.VAPID_PRIVATE_JWK) {
        const vk = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        env.VAPID_PRIVATE_JWK = JSON.stringify(await crypto.subtle.exportKey('jwk', vk.privateKey));
        env.VAPID_PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey('raw', vk.publicKey)).toString('base64url');
    }
    const realFetch = globalThis.fetch;
    let pushes = [], statusFor = () => 201;
    globalThis.fetch = async (u, opts) => {
        pushes.push({ url: String(u), headers: (opts && opts.headers) || {}, body: opts && opts.body ? new Uint8Array(opts.body) : null });
        return new Response('', { status: statusFor(String(u)) });
    };
    const BA = 'America/Argentina/Buenos_Aires';
    const dowOf = (t) => new Date(T.localParts(BA, new Date(t)).date + 'T00:00:00Z').getUTCDay();

    // 3) El alumno activa los avisos de su coach
    const C = 'coachAVISOS';
    const r = (await call('POST', '/api/routines', { coach_id: C, name: 'Plan', plan: [{ name: 'A', exercises: [{ name: 'Sentadilla' }] }], alumno_name: 'Vale', coach_name: 'Profe Juan' })).body;
    const tk = r.share_token;
    const phone = await makePhone('https://fcm.googleapis.com/fcm/send/alumno1');
    const bad = await call('POST', '/api/shares/' + tk + '/push', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'abc', auth: 'def' } } });
    ok('suscripción sin claves válidas → 400', bad.status === 400);
    const evil = await call('POST', '/api/shares/' + tk + '/push', { subscription: Object.assign({}, phone.sub, { endpoint: 'https://evil.example.com/push' }) });
    ok('servicio de push desconocido → 400', evil.status === 400);
    const on = await call('POST', '/api/shares/' + tk + '/push', { subscription: phone.sub, lang: 'es', tz: BA });
    const chkDO = dos.get('chk:' + tk);
    const lpN = T.localParts(BA, new Date(on.body.next || 0));
    ok('activa los avisos: recordatorio automático el domingo a las 18 h del alumno', on.status === 200 && on.body.on === true && on.body.chk_remind.mode === 'auto' && dowOf(on.body.next) === 0 && lpN.hour === 18 && lpN.minute === 0 && chkDO.storage.alarm === on.body.next, [on.body, lpN]);
    const det = await call('GET', '/api/routines/' + r.id + '?coach_id=' + C);
    ok('el coach ve que tiene avisos, pero no la dirección ni las claves', det.body.routine.push_on === 1 && det.body.routine.push_subs === undefined && !JSON.stringify(det.body).includes('alumno1') && det.body.routine.chk_remind.mode === 'auto', det.body.routine.push_on);

    // 4) El coach elige el día y la hora
    const cr = await call('PUT', '/api/routines/' + r.id, { coach_id: C, chk_remind: { mode: 'custom', dow: 3, hour: 7 } });
    ok('el coach elige miércoles 7 h y se reprograma', cr.status === 200 && cr.body.chk_remind.dow === 3 && dowOf(chkDO.storage.alarm) === 3 && T.localParts(BA, new Date(chkDO.storage.alarm)).hour === 7, cr.body.chk_remind);

    // Aviso del coach a todos sus alumnos
    const an0 = await call('PUT', '/api/coach/config', { coach_id: C, announce: { text: '  ' } });
    ok('aviso vacío → 400', an0.status === 400);
    const an1 = await call('PUT', '/api/coach/config', { coach_id: C, announce: { text: 'El lunes 24 es feriado: entrenamos el martes.' } });
    const cfgA = await call('GET', '/api/coach/config?coach_id=' + C);
    ok('el coach publica un aviso', an1.status === 200 && cfgA.body.announce && cfgA.body.announce.text.includes('feriado'), cfgA.body.announce);
    const an2 = await call('PUT', '/api/coach/config', { coach_id: C, announce: { text: 'Otro aviso' } });
    ok('otro aviso enseguida → 429', an2.status === 429, an2.status);
    const shA = await call('GET', '/api/shares/' + tk);
    ok('el alumno ve el aviso en su link', !!shA.body.announce && shA.body.announce.text.includes('feriado'), shA.body.announce);
    pushes = [];
    const ps1 = await call('POST', '/api/routines/' + r.id + '/announce', { coach_id: C });
    const anMsg = pushes.length ? await decrypt(phone, pushes[0].body) : null;
    ok('la notificación del aviso le llega al alumno con el texto', ps1.status === 200 && ps1.body.sent === 1 && anMsg && anMsg.body.includes('feriado') && anMsg.body.includes('Profe Juan'), anMsg);
    pushes = [];
    const ps2 = await call('POST', '/api/routines/' + r.id + '/announce', { coach_id: C });
    ok('el mismo aviso no se manda dos veces', ps2.body.dup === true && pushes.length === 0);
    const psX = await call('POST', '/api/routines/' + r.id + '/announce', { coach_id: 'otroCoach' });
    ok('otro coach no puede avisarle a este alumno', psX.status === 403 || psX.status === 404, psX.status);
    await call('PUT', '/api/coach/config', { coach_id: C, announce: null });
    const shA2 = await call('GET', '/api/shares/' + tk);
    ok('borrar el aviso lo saca del link', shA2.body.announce === null, shA2.body.announce);
    const lstP = await call('GET', '/api/routines?coach_id=' + C + '&paged=1');
    const itP = lstP.body.items.find((x) => x.id === r.id);
    ok('la lista dice si el alumno tiene avisos y cuántos días tiene su plan', itP.push_on === true && itP.plan_days === 1, itP);
    ok('cambiar el recordatorio no cuenta como "tu coach actualizó la rutina"', cr.body.last_coach_update_at === r.last_coach_update_at && cr.body.push_subs === undefined);
    const badC = await call('PUT', '/api/routines/' + r.id, { coach_id: C, chk_remind: { mode: 'custom', dow: 9, hour: 7 } });
    ok('día inválido → 400', badC.status === 400);

    // 5) La alarma manda el recordatorio cifrado (y se reprograma a la semana siguiente)
    pushes = [];
    const firstAt = chkDO.storage.alarm;
    let res = await T.notifierAlarm(chkDO.storage, env, firstAt);
    const msg = pushes.length ? await decrypt(phone, pushes[0].body) : null;
    ok('la alarma manda el recordatorio cifrado con el nombre del coach y el link', res.sent === 1 && pushes[0].headers['Content-Encoding'] === 'aes128gcm' && msg && msg.body.includes('Profe Juan') && msg.body.includes('control') && msg.url === './BERSERKERMOD.html?r=' + tk, msg);
    ok('y queda programado para la semana siguiente', Math.abs(chkDO.storage.alarm - firstAt - 7 * 86400000) < 2 * 3600000, [firstAt, chkDO.storage.alarm]);
    await call('POST', '/api/shares/' + tk + '/checkins', { weight: 70 });
    pushes = [];
    res = await T.notifierAlarm(chkDO.storage, env, Date.now() + 60000);
    ok('si ya mandó el control de la semana, no le llega', res.skipped === true && pushes.length === 0, res);

    // 6) Botón "Recordarle ahora"
    pushes = [];
    const rm = await call('POST', '/api/routines/' + r.id + '/remind', { coach_id: C });
    const rmMsg = pushes.length ? await decrypt(phone, pushes[0].body) : null;
    ok('"Recordarle ahora" le manda el aviso', rm.status === 200 && rm.body.sent === 1 && rmMsg && rmMsg.body.startsWith('🔔') && rmMsg.body.includes('Profe Juan'), rm.body);
    const rm2 = await call('POST', '/api/routines/' + r.id + '/remind', { coach_id: C });
    ok('otro recordatorio antes de 12 horas → 429', rm2.status === 429);

    // 7) Evaluación, respuesta a video y rutina actualizada
    await call('PUT', '/api/routines/' + r.id, { coach_id: C, profile: { start_date: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10) } });
    pushes = [];
    await call('PUT', '/api/routines/' + r.id + '/evals/1', { coach_id: C, results: 'Bien' });
    ok('evaluación nueva → aviso', pushes.length === 1 && (await decrypt(phone, pushes[0].body)).body.includes('ciclo 1'));
    pushes = [];
    await call('PUT', '/api/routines/' + r.id + '/evals/1', { coach_id: C, results: 'Editada' });
    ok('editar la evaluación no vuelve a avisar', pushes.length === 0);
    const vd = await call('POST', '/api/shares/' + tk + '/videos', { exercise: 'Sentadilla', url: 'https://youtu.be/x1' });
    pushes = [];
    await call('PUT', '/api/routines/' + r.id + '/videos/' + vd.body.video.id, { coach_id: C, reply: 'Bajá lento' });
    ok('primera respuesta a un video → aviso con el ejercicio', pushes.length === 1 && (await decrypt(phone, pushes[0].body)).body.includes('Sentadilla'));
    pushes = [];
    await call('PUT', '/api/routines/' + r.id + '/videos/' + vd.body.video.id, { coach_id: C, reply: 'Corrijo' });
    ok('editar la respuesta no vuelve a avisar', pushes.length === 0);
    const ck = await call('POST', '/api/shares/' + tk + '/checkins', { weight: 80, energy: 3 });
    pushes = [];
    await call('PUT', '/api/routines/' + r.id + '/checkins/' + ck.body.checkin.week, { coach_id: C, reply: 'Vamos bien' });
    const ckMsg = pushes.length ? await decrypt(phone, pushes[0].body) : null;
    ok('primera respuesta al control → aviso', pushes.length === 1 && ckMsg && ckMsg.body.includes('control semanal'), ckMsg);
    pushes = [];
    await call('PUT', '/api/routines/' + r.id + '/checkins/' + ck.body.checkin.week, { coach_id: C, reply: 'Vamos muy bien' });
    ok('editar la respuesta al control no vuelve a avisar', pushes.length === 0);
    pushes = [];
    await call('PUT', '/api/routines/' + r.id, { coach_id: C, plan: [{ name: 'A', exercises: [{ name: 'Press' }] }] });
    const plMsg = pushes.length ? await decrypt(phone, pushes[0].body) : null;
    ok('rutina actualizada → aviso', pushes.length === 1 && plMsg && plMsg.body.includes('actualizó'), plMsg);
    pushes = [];
    await call('PUT', '/api/routines/' + r.id, { coach_id: C, plan: [{ name: 'A', exercises: [{ name: 'Remo' }] }] });
    ok('otro cambio de rutina en la misma hora no vuelve a avisar', pushes.length === 0);

    // 8) Suscripción muerta, recordatorio sin avisos y apagar
    statusFor = () => 410;
    pushes = [];
    // Una semana después de la próxima alarma: el control de arriba se mandó "esta semana" y,
    // si hoy es lunes o martes, el próximo miércoles cae en la misma semana y (bien) no avisa.
    res = await T.notifierAlarm(chkDO.storage, env, chkDO.storage.alarm + 7 * 86400000);
    const key = 'routine:' + C + ':' + r.id;
    let rec = JSON.parse(env.BMOD_KV._m.get(key));
    ok('suscripción muerta (410) → se borra y se apaga el recordatorio', pushes.length === 1 && rec.push_subs.length === 0 && chkDO.storage._m.get('job') === undefined && chkDO.storage.alarm === firstAt + 7 * 86400000 || (pushes.length === 1 && rec.push_subs.length === 0 && chkDO.storage._m.get('job') === undefined), [pushes.length, rec.push_subs.length]);
    statusFor = () => 201;
    delete rec.remind_at;
    await setRec(key, rec);
    const rm3 = await call('POST', '/api/routines/' + r.id + '/remind', { coach_id: C });
    ok('sin avisos activados: el coach se entera (para mandarlo por WhatsApp)', rm3.status === 200 && rm3.body.no_subs === true && rm3.body.sent === 0, rm3.body);
    await call('POST', '/api/shares/' + tk + '/push', { subscription: phone.sub, tz: BA });
    const off = await call('POST', '/api/shares/' + tk + '/push', { off: true, endpoint: phone.sub.endpoint });
    ok('el alumno apaga los avisos: sin suscripción y sin recordatorio', off.status === 200 && off.body.on === false && chkDO.storage.alarm === null, off.body);

    // 9) Fin del descanso con la app cerrada
    const restPhone = await makePhone('https://web.push.apple.com/rest1');
    const restAt = Date.now() + 90000;
    const rs = await call('POST', '/api/push/rest', { subscription: restPhone.sub, at: restAt, lang: 'es' });
    const restDO = dos.get([...dos.keys()].find((k) => k.startsWith('rest:')));
    ok('descanso con la app cerrada: queda programado al segundo', rs.status === 200 && restDO && restDO.storage.alarm === restAt, rs.body);
    const rsBad = await call('POST', '/api/push/rest', { subscription: restPhone.sub, at: Date.now() + 3600000 });
    ok('descanso de más de 15 minutos → 400', rsBad.status === 400);
    pushes = [];
    res = await T.notifierAlarm(restDO.storage, env, restAt);
    const restMsg = pushes.length ? await decrypt(restPhone, pushes[0].body) : null;
    ok('al terminar el descanso llega el aviso, urgente y de vida corta', res.sent === 1 && pushes[0].headers.Urgency === 'high' && pushes[0].headers.TTL === '120' && restMsg && restMsg.tag === 'bm-rest' && restMsg.body.includes('descanso'), restMsg);
    await call('POST', '/api/push/rest', { subscription: restPhone.sub, at: Date.now() + 60000 });
    const cancel = await call('POST', '/api/push/rest', { subscription: restPhone.sub, cancel: true });
    ok('si vuelve a la app antes, se cancela', cancel.status === 200 && restDO.storage.alarm === null && restDO.storage._m.get('job') === undefined);

    // 10) Resumen diario del coach
    const coachPhone = await makePhone('https://fcm.googleapis.com/fcm/send/coach1');
    const CP = '88888888-aaaa-bbbb-cccc-000000000002';
    const a1 = (await call('POST', '/api/routines', { coach_id: CP, name: 'P', plan: [{ name: 'A', exercises: [] }], alumno_name: 'Luz' })).body;
    const k1 = 'routine:' + CP + ':' + a1.id;
    const rec1 = JSON.parse(env.BMOD_KV._m.get(k1));
    rec1.created_at = rec1.updated_at = rec1.last_coach_update_at = new Date(Date.now() - 20 * 86400000).toISOString();
    await setRec(k1, rec1);
    await call('POST', '/api/routines', { coach_id: CP, name: 'P', plan: [{ name: 'A', exercises: [] }], alumno_name: 'Nuevo' });
    const dgBad = await call('PUT', '/api/coach/config', { coach_id: CP, digest: { on: true, hour: 9 } });
    ok('resumen sin notificaciones en el teléfono → 400', dgBad.status === 400);
    const dg = await call('PUT', '/api/coach/config', { coach_id: CP, digest: { on: true, hour: 9, subscription: coachPhone.sub, tz: BA, lang: 'es' } });
    const dgDO = dos.get('digest:' + CP);
    ok('el coach activa el resumen diario a las 9 h', dg.status === 200 && dg.body.digest.on === true && dgDO && T.localParts(BA, new Date(dgDO.storage.alarm)).hour === 9, dg.body);
    pushes = [];
    res = await T.notifierAlarm(dgDO.storage, env, dgDO.storage.alarm);
    const dgMsg = pushes.length ? await decrypt(coachPhone, pushes[0].body) : null;
    ok('el resumen nombra a quien hay que revisar (y no al recién llegado)', res.count === 1 && dgMsg && dgMsg.body.includes('Luz') && !dgMsg.body.includes('Nuevo'), dgMsg);
    const cfgG = await call('GET', '/api/coach/config?coach_id=' + CP);
    ok('la config del coach muestra el resumen sin exponer la suscripción', cfgG.body.digest.on === true && cfgG.body.digest.hour === 9 && !JSON.stringify(cfgG.body).includes('coach1'), cfgG.body);
    // 11) Una falla momentánea no apaga el resumen para siempre (auditoría D-1)
    const realGet = env.BMOD_KV.get;
    if (coachData()) env.NOTIFIER.down = true;   // el objeto del coach no responde
    else env.BMOD_KV.get = async () => { throw new Error('KV GET failed: 429'); };
    const tFail = Date.now();
    dgDO.storage.alarm = null;   // como en Cloudflare: mientras corre, la alarma ya no figura como programada
    await dgDO.obj.alarm();
    const retryAt1 = dgDO.storage.alarm;
    ok('si la alarma falla, se reintenta en ~15 minutos (no se pierde)', retryAt1 >= tFail + 15 * 60000 && retryAt1 < Date.now() + 15 * 60000 + 1000 && dgDO.storage._m.get('job').fails === 1, [retryAt1 - tFail, dgDO.storage._m.get('job')]);
    dgDO.storage.alarm = null;
    await dgDO.obj.alarm();
    ok('si vuelve a fallar, espera el doble (30 minutos)', dgDO.storage.alarm - Date.now() > 29 * 60000 && dgDO.storage._m.get('job').fails === 2, dgDO.storage._m.get('job'));
    env.BMOD_KV.get = realGet;
    if (coachData()) env.NOTIFIER.down = false;
    pushes = [];
    res = await T.notifierAlarm(dgDO.storage, env, dgDO.storage.alarm);
    ok('cuando KV vuelve, manda el resumen, borra la cuenta de fallas y vuelve a las 9 h', res.kind === 'digest' && pushes.length === 1 && !dgDO.storage._m.get('job').fails && T.localParts(BA, new Date(dgDO.storage.alarm)).hour === 9, [res, dgDO.storage._m.get('job')]);
    // Falla DESPUÉS de mandar (al limpiar una suscripción muerta): no se reintenta, así no se duplica
    statusFor = () => 410;
    const realPut = env.BMOD_KV.put;
    env.BMOD_KV.put = async (k, v, o) => { if (String(k).startsWith('coachcfg:')) throw new Error('KV PUT failed: 429'); return realPut.call(env.BMOD_KV, k, v, o); };
    pushes = [];
    dgDO.storage.alarm = null;
    await dgDO.obj.alarm();
    ok('si falla después de mandar, la próxima ya quedó programada (sin reintento ni aviso doble)', pushes.length === 1 && dgDO.storage.alarm > Date.now() && T.localParts(BA, new Date(dgDO.storage.alarm)).hour === 9 && !dgDO.storage._m.get('job').fails, [pushes.length, dgDO.storage.alarm, dgDO.storage._m.get('job')]);
    env.BMOD_KV.put = realPut;
    statusFor = () => 201;

    const dgOff = await call('PUT', '/api/coach/config', { coach_id: CP, digest: { on: false } });
    ok('apagar el resumen borra la alarma', dgOff.body.digest.on === false && dgDO.storage.alarm === null);

    globalThis.fetch = realFetch;
    env.NOTIFIER = prevNotifier;   // en la corrida --do sigue el de todo el archivo
}

// ── Auditoría de infraestructura 2026-11: tanda 1 ──
{
    console.log('\nAuditoría 2026-11 (tanda 1): pagos, testers, cron, avisos, límites');
    // Durable Objects de prueba (la fila de espera la pone el propio Worker: Notifier.lock)
    const prevNotifierT1 = env.NOTIFIER;
    const makeDONamespaceT1 = () => prevNotifierT1 || makeDONamespace(Notifier, env);
    const codesOfPayment = (id) => [...env.BMOD_KV._m.entries()].filter(([k, v]) => k.startsWith('code:') && JSON.parse(v).payment_id === id).map(([k]) => k.slice(5));

    // ── Mercado Pago ──
    env.MP_ACCESS_TOKEN = 'TEST-mp-token';
    env.COACH_PRICE_ARS_12M = '120000'; env.PREMIUM_PRICE_ARS_1M = '7500';
    const realFetch = globalThis.fetch;
    const pays = {}; let mpStatus = 200, mpCalls = [];
    globalThis.fetch = async (u) => {
        const s = String(u); mpCalls.push(s);
        const id = (s.match(/\/v1\/payments\/(.+)$/) || [])[1];
        if (id && mpStatus !== 200) return new Response('{}', { status: mpStatus });
        if (id && pays[id]) return new Response(JSON.stringify(pays[id]), { status: 200 });
        return new Response('{}', { status: 404 });
    };
    const hook = (id) => call('POST', '/api/webhook/mercadopago', { type: 'payment', data: { id } });
    const codesBefore = [...env.BMOD_KV._m.keys()].filter((k) => k.startsWith('code:')).length;
    const codesNow = () => [...env.BMOD_KV._m.keys()].filter((k) => k.startsWith('code:')).length;

    pays['2001'] = { status: 'approved', external_reference: '', transaction_amount: 10, currency_id: 'ARS', operation_type: 'money_transfer' };
    let w = await hook('2001');
    ok('P-2: transferencia o pago ajeno a la app → se ignora, sin código', w.status === 200 && w.body.ignored === 'not_app' && !(await env.BMOD_KV.get('paid:2001')) && codesNow() === codesBefore, w.body);
    pays['2002'] = { status: 'approved', external_reference: 'coach', transaction_amount: 15000, currency_id: 'ARS' };
    w = await hook('2002');
    ok('P-2: la referencia vieja "coach" ya no regala un Coach vitalicio', w.body.ignored === 'not_app' && codesNow() === codesBefore, w.body);
    pays['2003'] = { status: 'approved', external_reference: 'coach_12m', transaction_amount: 1, currency_id: 'ARS' };
    w = await hook('2003');
    ok('P-2: $1 con referencia de 12 meses → se ignora', w.body.ignored === 'amount' && codesNow() === codesBefore, w.body);
    pays['2004'] = { status: 'approved', external_reference: 'premium_1m', transaction_amount: 7500, currency_id: 'USD' };
    w = await hook('2004');
    ok('P-2: otra moneda → se ignora', w.body.ignored === 'amount' && codesNow() === codesBefore, w.body);
    pays['2005'] = { status: 'approved', external_reference: 'premium_1m', transaction_amount: 6000, currency_id: 'ARS' };
    w = await hook('2005');
    ok('precio que subió mientras el pago estaba pendiente (más de la mitad) → se honra', w.status === 200 && /^BMOD-/.test(await env.BMOD_KV.get('paid:2005') || ''), w.body);
    mpCalls = [];
    w = await call('POST', '/api/webhook/mercadopago', { type: 'payment', data: { id: '../checkout/preferences' } });
    ok('número de pago que no es solo dígitos → se ignora sin consultar a MP', w.status === 200 && w.body.ignored === true && mpCalls.length === 0, [w.body, mpCalls]);
    w = await hook('2999');
    ok('pago que no existe en MP (404) → 200, no hace falta reintentar', w.status === 200 && w.body.note === 'payment not found', w.body);

    pays['2006'] = { status: 'approved', external_reference: 'premium_1m', transaction_amount: 7500, currency_id: 'ARS' };
    mpStatus = 503;
    w = await hook('2006');
    ok('P-1: MP no responde → 500 para que MP reintente (antes: 200 y el pago se perdía)', w.status === 500 && !(await env.BMOD_KV.get('paid:2006')), w);
    mpStatus = 200;
    const realPut = env.BMOD_KV.put;
    env.BMOD_KV.put = async (k, v, o) => { if (String(k).startsWith('paid:')) throw new Error('KV PUT failed: 429 Too Many Requests'); return realPut.call(env.BMOD_KV, k, v, o); };
    w = await hook('2006');
    ok('P-1: KV sin cupo → 500 (MP reintenta)', w.status === 500 && w.body.error === 'retry' && !JSON.stringify(w.body).includes('KV'), w.body);
    env.BMOD_KV.put = realPut;
    w = await hook('2006');
    ok('P-1: el reintento genera el código', w.status === 200 && /^BMOD-/.test(await env.BMOD_KV.get('paid:2006') || ''), w.body);

    // Con el Durable Object (como en producción)
    env.NOTIFIER = makeDONamespaceT1();
    pays['3001'] = { status: 'approved', external_reference: 'premium_1m.' + 'N'.repeat(20), transaction_amount: 7500, currency_id: 'ARS' };
    const both = await Promise.all([hook('3001'), hook('3001')]);
    const c3001 = codesOfPayment('3001');
    const buy = JSON.parse(await env.BMOD_KV.get('buy:' + 'N'.repeat(20)));
    ok('P-3: dos avisos del mismo pago a la vez → UN solo código', both.every((x) => x.status === 200) && c3001.length === 1 && (await env.BMOD_KV.get('paid:3001')) === c3001[0] && buy.code === c3001[0], [both.map((x) => x.body), c3001]);
    ok('el objeto del pago queda marcado como terminado', env.NOTIFIER._dos.get('pay:3001').storage._m.get('pay').done === true);
    w = await hook('3001');
    ok('un tercer aviso, más tarde → dup, sin código nuevo', w.body.dup === true && codesOfPayment('3001').length === 1, w.body);

    pays['3002'] = { status: 'approved', external_reference: 'premium_1m', transaction_amount: 7500, currency_id: 'ARS' };
    env.BMOD_KV.put = async (k, v, o) => { if (String(k).startsWith('payment:')) throw new Error('KV PUT failed: 429'); return realPut.call(env.BMOD_KV, k, v, o); };
    w = await hook('3002');
    const first3002 = codesOfPayment('3002');
    env.BMOD_KV.put = realPut;
    // mientras tanto, alguien ya lo activó (no debería pasar sin ticket, pero no hay que pisarlo nunca)
    const rec3002 = JSON.parse(await env.BMOD_KV.get('code:' + first3002[0]));
    rec3002.used = true; rec3002.deviceId = 'tel-3002';
    await env.BMOD_KV.put('code:' + first3002[0], JSON.stringify(rec3002));
    await env.BMOD_KV.delete('paid:3002');
    const w2 = await hook('3002');
    const after3002 = JSON.parse(await env.BMOD_KV.get('code:' + first3002[0]));
    ok('falla a mitad de camino → 500; el reintento usa el MISMO código y no pisa una activación', w.status === 500 && w2.status === 200 && codesOfPayment('3002').length === 1 && after3002.used === true && after3002.deviceId === 'tel-3002' && JSON.parse(await env.BMOD_KV.get('payment:3002')).code === first3002[0], [w.status, w2.status, after3002]);
    globalThis.fetch = realFetch;
    delete env.MP_ACCESS_TOKEN; delete env.COACH_PRICE_ARS_12M; delete env.PREMIUM_PRICE_ARS_1M;

    // ── Testers: el tope cuenta bien con pedidos simultáneos (K-3) ──
    const ANDROID = { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/128.0 Mobile', 'sec-ch-ua-mobile': '?1', 'sec-ch-ua-platform': '"Android"' };
    env.TESTERS_CLAIM_OPEN = 'true';
    const startN = JSON.parse((await env.BMOD_KV.get('testers:count')) || '{"n":0}').n;
    env.TESTERS_CLAIM_MAX = String(startN + 2);
    const burst = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => call('POST', '/api/testers/claim', { deviceId: 'burst' + i }, { 'CF-Connecting-IP': '10.0.0.' + i, ...ANDROID })));
    const granted = burst.filter((x) => x.status === 200).length;
    ok('6 reclamos simultáneos con 2 lugares libres → exactamente 2 (antes: los 6)', granted === 2 && burst.filter((x) => x.status === 409).length === 4, burst.map((x) => x.status));
    ok('el contador de KV sigue al del Durable Object', JSON.parse(await env.BMOD_KV.get('testers:count')).n === startN + 2);
    env.TESTERS_CLAIM_MAX = '1000';
    const twice = await Promise.all([1, 2].map(() => call('POST', '/api/testers/claim', { deviceId: 'mismoTel' }, { 'CF-Connecting-IP': '10.1.0.1', ...ANDROID })));
    ok('el mismo teléfono dos veces a la vez → un lugar, el otro pide esperar', twice.filter((x) => x.status === 200).length === 1 && twice.filter((x) => x.status === 429).length === 1 && JSON.parse(await env.BMOD_KV.get('testers:count')).n === startN + 3, twice.map((x) => [x.status, x.body]));
    const again = await call('POST', '/api/testers/claim', { deviceId: 'mismoTel' }, { 'CF-Connecting-IP': '10.1.0.1', ...ANDROID });
    ok('y después, el mismo teléfono recibe su mismo código', again.status === 200 && again.body.code === twice.find((x) => x.status === 200).body.code, again.body);
    let lastIp;
    for (let i = 0; i < 6; i++) lastIp = await call('POST', '/api/testers/claim', { deviceId: 'red' + i }, { 'CF-Connecting-IP': '10.2.0.9', ...ANDROID });
    ok('el tope por red también vive en el Durable Object (6to → 429)', lastIp.status === 429, lastIp.body);
    await env.BMOD_KV.put('testers:count', JSON.stringify({ n: 1 }));   // copia de KV atrasada
    const admT = await call('GET', '/api/admin/testers', undefined, { 'x-admin-secret': 'test-admin' });
    ok('el panel admin muestra el número del Durable Object, no la copia de KV', admT.body.count === startN + 3 + 5, [admT.body.count, startN]);
    env.TESTERS_CLAIM_OPEN = 'false';
    env.NOTIFIER = prevNotifierT1;

    // ── Cron: la zona horaria se valida una vez por zona, no por suscripción (L-2) ──
    if (!env.VAPID_PRIVATE_JWK) {
        const vk = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        env.VAPID_PRIVATE_JWK = JSON.stringify(await crypto.subtle.exportKey('jwk', vk.privateKey));
        env.VAPID_PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey('raw', vk.publicKey)).toString('base64url');
    }
    const savedAll = await env.BMOD_KV.get('push:all');
    const zones = ['America/Argentina/Buenos_Aires', 'Europe/Madrid', 'America/Mexico_City', 'Zona/Inventada'];
    const subs = {};
    for (let i = 0; i < 1000; i++) subs['s' + i] = { endpoint: 'https://fcm.googleapis.com/fcm/send/cpu' + i, tz: zones[i % zones.length], sent: null };
    await env.BMOD_KV.put('push:all', JSON.stringify({ subs }));
    const RealDTF = Intl.DateTimeFormat;
    let made = 0;
    Intl.DateTimeFormat = function (...a) { made++; return new RealDTF(...a); };
    Intl.DateTimeFormat.prototype = RealDTF.prototype;
    const fetchCron = globalThis.fetch;
    globalThis.fetch = async () => new Response('', { status: 201 });
    const t0 = performance.now();
    try {
        const pend = [];
        await worker.scheduled({ scheduledTime: Date.UTC(2026, 10, 18, 12, 0) }, env, { waitUntil: (p) => pend.push(p) });
        await Promise.all(pend);
    } finally { Intl.DateTimeFormat = RealDTF; globalThis.fetch = fetchCron; }
    const ms = performance.now() - t0;
    ok('L-2: 1.000 suscripciones en 4 zonas → a lo sumo 8 relojes creados (antes: más de 1.000)', made <= 8, made);
    console.log('    (corrida del cron con 1.000 suscripciones en esta PC: ' + ms.toFixed(1) + ' ms)');
    if (savedAll === null) await env.BMOD_KV.delete('push:all'); else await env.BMOD_KV.put('push:all', savedAll);

    // ── Crear rutinas: 5 por minuto por IP, con su propio contador (L-1) ──
    const hits = {};
    const mkLimiter = (n) => ({ limit: async ({ key }) => { hits[key] = (hits[key] || 0) + 1; return { success: hits[key] <= n }; } });
    env.RL_OPEN = mkLimiter(100); env.RL_STRICT = mkLimiter(1);
    const IP = { 'CF-Connecting-IP': '11.11.11.11' };
    const cr1 = await call('POST', '/api/routines', { coach_id: 'coachRL', name: 'A', plan: [{ day: 'A' }] }, IP);
    const cr2 = await call('POST', '/api/routines', { coach_id: 'coachRL', name: 'B', plan: [{ day: 'B' }] }, IP);
    ok('L-1: crear rutinas usa el límite estricto (2da en el minuto → 429)', cr1.status === 201 && cr2.status === 429, [cr1.status, cr2.status]);
    const lst = await call('GET', '/api/routines?coach_id=coachRL', undefined, IP);
    const errs = await call('POST', '/api/errors', { errors: [{ msg: 'x' }] }, IP);
    ok('L-1: listar rutinas y las otras rutas estrictas no comparten ese contador', lst.status === 200 && errs.status === 200, [lst.status, errs.status]);
    delete env.RL_OPEN; delete env.RL_STRICT;
}

// ── Vigía: registros y /api/health/deep (auditoría M-1) ──
{
    console.log('\nVigía: /api/health/deep y señal de KV sin cupo');
    const T = Notifier._test;
    const prevNS = env.NOTIFIER;
    if (!env.NOTIFIER) env.NOTIFIER = makeDONamespace(Notifier, env);
    const ns = env.NOTIFIER;
    const realLog = console.error;
    const logged = [];
    console.error = (...a) => { logged.push(a.join(' ')); };
    try {
        ok('reconoce los errores de KV por tope', T.isKvLimit('KV PUT failed: 429 Too Many Requests') && T.isKvLimit('KV GET failed: 429') && !T.isKvLimit('KV GET failed: 500') && !T.isKvLimit('boom'));
        // Arranca limpio (otras pruebas de este archivo ya simularon KV en 429)
        const ctrs = ns._dos.get('counters');
        if (ctrs) ctrs.storage._m.delete('flag:kv-limit');
        T.resetKvNote();
        let h = await call('GET', '/api/health/deep');
        ok('todo sano → 200 con cada chequeo en true', h.status === 200 && h.body.ok === true && h.body.checks.kv_reads && h.body.checks.durable_objects && h.body.checks.kv_writes && h.body.checks.kv_limit_at === null, h.body);

        // KV se queda sin escrituras en una ruta común (prueba gratis)
        const realPut = env.BMOD_KV.put;
        env.BMOD_KV.put = async () => { throw new Error('KV PUT failed: 429 Too Many Requests'); };
        const tr = await call('POST', '/api/license/trial', { deviceId: 'vigia-dev-1', product: 'premium' });
        env.BMOD_KV.put = realPut;
        ok('el error queda en los registros con la ruta', tr.status === 500 && logged.some((l) => l.includes('[worker] error') && l.includes('/api/license/trial') && l.includes('429')), [tr.status, logged.slice(-2)]);
        h = await call('GET', '/api/health/deep');
        ok('después, el vigía ve KV sin cupo → 503', h.status === 503 && h.body.ok === false && h.body.checks.kv_writes === false && !!h.body.checks.kv_limit_at, h.body);
        // Pasada la hora, vuelve a dar sano
        const flag = ns._dos.get('counters').storage._m.get('flag:kv-limit');
        flag.at -= 2 * 3600000;
        ns._dos.get('counters').storage._m.set('flag:kv-limit', flag);
        h = await call('GET', '/api/health/deep');
        ok('una hora después de la última falla vuelve a 200', h.status === 200 && h.body.checks.kv_writes === true, h.body);

        // Un error que no es de cupo no dispara la señal
        T.resetKvNote();
        const realGet = env.BMOD_KV.get;
        env.BMOD_KV.get = async () => { throw new Error('boom'); };
        await call('POST', '/api/license/activate', { code: 'BMOD-XXXX-YYYY', deviceId: 'vigia-dev-2' });
        env.BMOD_KV.get = realGet;
        h = await call('GET', '/api/health/deep');
        ok('un error cualquiera queda registrado pero no marca KV sin cupo', h.status === 200, h.body);

        // El cron: si falla, lo registra y deja la señal (antes se perdía sin rastro)
        T.resetKvNote();
        if (!env.VAPID_PRIVATE_JWK) {
            const vk = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
            env.VAPID_PRIVATE_JWK = JSON.stringify(await crypto.subtle.exportKey('jwk', vk.privateKey));
            env.VAPID_PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey('raw', vk.publicKey)).toString('base64url');
        }
        env.BMOD_KV.get = async () => { throw new Error('KV GET failed: 429 Too Many Requests'); };
        // Con los Durable Objects el cron no lee KV cada minuto: se fuerza que el objeto de
        // suscripciones tenga que traer la lista de KV (como la primera vez después de publicar).
        if (RUN_DO && ns._dos.get('pushsubs')) ns._dos.get('pushsubs').storage._m.delete('all');
        const pend = [];
        let threw = false;
        try { await worker.scheduled({ scheduledTime: Date.now() }, env, { waitUntil: (p) => pend.push(p) }); await Promise.all(pend); } catch { threw = true; }
        env.BMOD_KV.get = realGet;
        h = await call('GET', '/api/health/deep');
        ok('cron con KV sin cupo: no revienta, lo registra y el vigía lo ve', !threw && logged.some((l) => l.includes('[cron]')) && h.status === 503, [threw, h.body]);

        // Durable Objects caídos → 503
        ns._dos.get('counters').storage._m.delete('flag:kv-limit');
        ns.down = true;
        h = await call('GET', '/api/health/deep');
        ns.down = false;
        ok('Durable Objects sin responder → 503', h.status === 503 && h.body.checks.durable_objects === false, h.body);

        // Datos del Coach en su objeto: si el espejo a KV falla por cupo, el pedido sale bien y el vigía se entera
        if (RUN_DO) {
            ns._dos.get('counters').storage._m.delete('flag:kv-limit');
            T.resetKvNote();
            const rt = (await call('POST', '/api/routines', { coach_id: 'coachVigia', name: 'P', plan: [{ day: 'A' }], alumno_name: 'Ana' })).body;
            env.BMOD_KV.put = async (k, v, o) => { if (String(k).startsWith('sessions:')) throw new Error('KV PUT failed: 429 Too Many Requests'); return realPut.call(env.BMOD_KV, k, v, o); };
            const ses = await call('POST', '/api/shares/' + rt.share_token + '/sessions', { date: new Date().toISOString().slice(0, 10), exercises: [] });
            env.BMOD_KV.put = realPut;
            h = await call('GET', '/api/health/deep');
            ok('espejo sin cupo: el entrenamiento se guarda igual y el vigía da 503', ses.status < 300 && h.status === 503, [ses.status, ses.body, h.body]);
        }
        ns._dos.get('counters').storage._m.delete('flag:kv-limit');
    } finally {
        console.error = realLog;
        env.NOTIFIER = prevNS;
        if (!prevNS) delete env.NOTIFIER;
        T.resetKvNote();
    }
}

// ── Auditoría 2026-11, tanda 4: reembolsos de MP (P-5), cuota de IA (L-5), avisos diarios (K-6) ──
{
    console.log('\nAuditoría 2026-11 (tanda 4): reembolsos, cuota de IA, suscripciones a avisos');
    const prevNS = env.NOTIFIER;
    if (!env.NOTIFIER) env.NOTIFIER = makeDONamespace(Notifier, env);
    const ns = env.NOTIFIER;
    const realFetch = globalThis.fetch;
    const realErr = console.error, realWarn = console.warn;
    console.error = () => { }; console.warn = () => { };
    try {
        // ── P-5: devolución o contracargo anulan el código ──
        env.MP_ACCESS_TOKEN = 'TEST-mp-token';
        env.PREMIUM_PRICE_ARS_1M = '7500';
        const pays = {};
        globalThis.fetch = async (u) => {
            const id = (String(u).match(/\/v1\/payments\/(\d+)$/) || [])[1];
            if (id && pays[id]) return new Response(JSON.stringify(pays[id]), { status: 200 });
            return new Response('{}', { status: 404 });
        };
        const hook = (id) => call('POST', '/api/webhook/mercadopago', { type: 'payment', data: { id } });
        const approved = { status: 'approved', external_reference: 'premium_1m', transaction_amount: 7500, currency_id: 'ARS' };
        pays['5001'] = Object.assign({}, approved);
        await hook('5001');
        const code5001 = await env.BMOD_KV.get('paid:5001');
        const act = await call('POST', '/api/license/activate', { code: code5001, deviceId: 'refund-dev' });
        let v = await call('POST', '/api/license/verify', { token: act.body.token });
        ok('P-5: compra aprobada y activada → licencia válida', act.status === 200 && v.body.valid === true, [act.status, v.body]);
        pays['5001'] = Object.assign({}, approved, { status: 'refunded', status_detail: 'refunded' });
        let w = await hook('5001');
        v = await call('POST', '/api/license/verify', { token: act.body.token });
        const rec5001 = JSON.parse(await env.BMOD_KV.get('code:' + code5001));
        ok('P-5: devolución → el código queda anulado y la licencia deja de valer', w.status === 200 && w.body.revoked === true && rec5001.revoked && rec5001.revoked_reason === 'mp_refund' && v.body.valid === false, [w.body, v.body]);
        const again = await call('POST', '/api/license/activate', { code: code5001, deviceId: 'otro-tel' });
        ok('P-5: y no se puede volver a activar en otro teléfono', again.status === 403, again.status);
        w = await hook('5001');
        ok('P-5: un aviso repetido de la devolución no hace nada más', w.status === 200 && w.body.already === true, w.body);

        pays['5002'] = Object.assign({}, approved);
        await hook('5002');
        pays['5002'] = Object.assign({}, approved, { status: 'charged_back', status_detail: 'reimbursed' });
        w = await hook('5002');
        ok('P-5: contracargo resuelto a favor del vendedor ("reimbursed") → el código sigue', !JSON.parse(await env.BMOD_KV.get('code:' + await env.BMOD_KV.get('paid:5002'))).revoked, w.body);
        pays['5003'] = Object.assign({}, approved);
        await hook('5003');
        pays['5003'] = Object.assign({}, approved, { status: 'charged_back', status_detail: 'settled' });
        w = await hook('5003');
        ok('P-5: contracargo perdido → código anulado', JSON.parse(await env.BMOD_KV.get('code:' + await env.BMOD_KV.get('paid:5003'))).revoked_reason === 'mp_chargeback', w.body);
        pays['5999'] = Object.assign({}, approved, { status: 'refunded' });
        w = await hook('5999');
        ok('P-5: devolución de un pago que no generó código (o ajeno a la app) → no hace nada', w.status === 200 && w.body.note === 'sin código', w.body);
        pays['5004'] = Object.assign({}, approved);
        await hook('5004');
        const code5004 = await env.BMOD_KV.get('paid:5004');
        await env.BMOD_KV.delete('paid:5004');   // la marca venció (contracargo meses después)
        pays['5004'] = Object.assign({}, approved, { status: 'refunded' });
        w = await hook('5004');
        ok('P-5: si la marca del pago ya venció, el código se encuentra en el objeto del pago', JSON.parse(await env.BMOD_KV.get('code:' + code5004)).revoked === true, w.body);
        pays['5005'] = Object.assign({}, approved);
        await hook('5005');
        pays['5005'] = Object.assign({}, approved, { status: 'refunded' });
        const realPut = env.BMOD_KV.put;
        env.BMOD_KV.put = async (k, val, o) => { if (String(k).startsWith('code:')) throw new Error('KV PUT failed: 429 Too Many Requests'); return realPut.call(env.BMOD_KV, k, val, o); };
        w = await hook('5005');
        env.BMOD_KV.put = realPut;
        ok('P-5: si no se puede anular (KV sin cupo) → 500 para que MP reintente', w.status === 500, w.status);
        w = await hook('5005');
        ok('P-5: y el reintento lo anula', w.body.revoked === true, w.body);
        delete env.MP_ACCESS_TOKEN; delete env.PREMIUM_PRICE_ARS_1M;

        // ── L-5: la cuota de IA cuenta solo respuestas útiles ──
        const gen = await call('POST', '/api/admin/codes', { count: 1, product: 'premium' }, { 'x-admin-secret': 'test-admin' });
        const lic = (await call('POST', '/api/license/activate', { code: gen.body.codes[0], deviceId: 'ia-dev' })).body.token;
        let aiMode = 'sin-cupo';
        env.AI = {
            run: async () => {
                if (aiMode === 'sin-cupo') throw new Error('3036: Capacity temporarily exceeded: daily free allocation of 10,000 neurons exceeded');
                if (aiMode === 'roto') throw new Error('upstream exploded at /internal/v4/models');
                return { response: { insights: [{ icon: '💪', title: 'Bien', text: 'Seguí así' }] } };
            }
        };
        const outs = [];
        for (let i = 0; i < 25; i++) outs.push(await call('POST', '/api/oracle', oracleBody(lic)));
        ok('L-5: sin neuronas en la cuenta → el Oracle igual responde con los textos fijos', outs.every((o) => o.status === 200 && o.body.source === 'fijo' && o.body.insights.length === 1), outs[0].body);
        ok('L-5: 25 consultas sin IA no gastan la cuota (nunca 429)', !outs.some((o) => o.status === 429));
        aiMode = 'roto';
        const broken = await call('POST', '/api/oracle', oracleBody(lic));
        ok('L-5: otro error de la IA → textos fijos, sin el mensaje interno', broken.status === 200 && broken.body.source === 'fijo' && !JSON.stringify(broken.body).includes('internal'), broken.body);
        aiMode = 'ok';
        const good = [];
        for (let i = 0; i < 21; i++) good.push((await call('POST', '/api/oracle', oracleBody(lic))).status);
        ok('L-5: las 20 consultas que funcionan sí cuentan; la 21 → 429', good.slice(0, 20).every((s) => s === 200) && good[20] === 429, good);
        delete env.AI;

        // ── K-6: suscripciones al recordatorio en su objeto (con los datos en Durable Objects) ──
        if (RUN_DO) {
            if (!env.VAPID_PRIVATE_JWK) {
                const vk = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
                env.VAPID_PRIVATE_JWK = JSON.stringify(await crypto.subtle.exportKey('jwk', vk.privateKey));
                env.VAPID_PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey('raw', vk.publicKey)).toString('base64url');
            }
            const at18 = (tz) => {
                const base = Date.UTC(2026, 10, 25);
                for (let h = 0; h < 48; h++) {
                    const t = new Date(base + h * 3600000);
                    if (Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(t)) % 24 === 18) return t;
                }
                throw new Error('sin 18 h');
            };
            const pushes = {};
            let delay = 0;
            globalThis.fetch = async (u) => {
                const s = String(u);
                if (s.includes('/fcm/send/k6')) { pushes[s] = (pushes[s] || 0) + 1; if (delay) await new Promise((r) => setTimeout(r, delay)); return new Response('', { status: 201 }); }
                return new Response('{}', { status: 404 });
            };
            const ep = (n) => 'https://fcm.googleapis.com/fcm/send/k6-' + n;
            const sub = (n, tz) => call('POST', '/api/push/subscribe', { subscription: { endpoint: ep(n) }, lang: 'es', tz });
            const cron = async (when) => { const w2 = []; await worker.scheduled({ scheduledTime: when.getTime() }, env, { waitUntil: (p) => w2.push(p) }); await Promise.all(w2); };
            const mirror = async () => JSON.parse(await env.BMOD_KV.get('push:all')).subs;
            const hasEp = (subs, n) => Object.values(subs).some((s) => s.endpoint === ep(n));

            for (let i = 0; i < 12; i++) await sub('m' + i, 'Europe/Madrid');
            const s0 = await sub('baja', 'Europe/Madrid');
            ok('K-6: la suscripción se guarda en su objeto y se copia a push:all (para poder volver atrás)', s0.status === 200 && hasEp(await mirror(), 'm0') && hasEp(ns._dos.get('pushsubs').storage._m.get('all').subs, 'baja'), s0.body);
            // Mientras el cron manda (lento), alguien se suscribe y otro se da de baja
            delay = 25;
            const running = cron(at18('Europe/Madrid'));
            await new Promise((r) => setTimeout(r, 30));
            const [alta, baja] = await Promise.all([sub('nueva', 'America/Bogota'), call('POST', '/api/push/unsubscribe', { endpoint: ep('baja') })]);
            await running;
            delay = 0;
            const subsDO = ns._dos.get('pushsubs').storage._m.get('all').subs;
            ok('K-6: un alta y una baja durante la corrida del cron no se pierden (antes el cron las pisaba)', alta.status === 200 && baja.status === 200 && hasEp(subsDO, 'nueva') && !hasEp(subsDO, 'baja') && hasEp(await mirror(), 'nueva') && !hasEp(await mirror(), 'baja'), Object.values(subsDO).map((s) => s.endpoint.slice(-8)));
            const marked = Object.values(subsDO).filter((s) => /k6-m\d/.test(s.endpoint) && s.sent);
            ok('K-6: y a los que les tocaba, el aviso les llegó y quedó anotado', marked.length === 12 && Object.keys(pushes).filter((k) => /k6-m\d/.test(k)).length === 12, marked.length);
            // Dos corridas del cron a la vez: nadie recibe dos avisos
            for (let i = 0; i < 8; i++) await sub('x' + i, 'America/Mexico_City');
            delay = 15;
            const tMx = at18('America/Mexico_City');
            await Promise.all([cron(tMx), cron(tMx)]);
            delay = 0;
            const mx = Object.keys(pushes).filter((k) => /k6-x\d/.test(k));
            ok('K-6: dos corridas del cron a la vez → cada uno recibe UN aviso', mx.length === 8 && mx.every((k) => pushes[k] === 1), mx.map((k) => pushes[k]));
            await cron(new Date(tMx.getTime() + 60000));
            ok('K-6: y la corrida siguiente no repite el aviso del día', mx.every((k) => pushes[k] === 1));
        }
    } finally {
        console.error = realErr; console.warn = realWarn;
        globalThis.fetch = realFetch;
        env.NOTIFIER = prevNS;
        if (!prevNS) delete env.NOTIFIER;
    }
}

// ── Auditoría 2026-11, tanda 5: K-5, S-3, L-6, L-7, D-2 ──
{
    console.log('\nAuditoría 2026-11 (tanda 5): licencias anuladas, errores internos, topes, avisos');
    const prevNS = env.NOTIFIER;
    if (!env.NOTIFIER) env.NOTIFIER = makeDONamespace(Notifier, env);
    const ns = env.NOTIFIER;
    const realErr = console.error;
    const logged = [];
    console.error = (...a) => { logged.push(a.join(' ')); };
    try {
        // K-5: la IA no acepta una licencia cuyo código fue anulado o pasó a otro teléfono
        env.AI = { run: async () => ({ response: { insights: [{ icon: '💡', title: 'Ok', text: 'ok' }] } }) };
        const g = await call('POST', '/api/admin/codes', { count: 1, product: 'premium' }, { 'x-admin-secret': 'test-admin' });
        const code = g.body.codes[0];
        const lic = (await call('POST', '/api/license/activate', { code, deviceId: 'k5-dev' })).body.token;
        let o = await call('POST', '/api/oracle', oracleBody(lic));
        ok('K-5: con el código vigente la IA responde', o.status === 200, o.body);
        await call('POST', '/api/license/activate', { code, deviceId: 'k5-otro-tel' });   // el código pasa a otro teléfono
        o = await call('POST', '/api/oracle', oracleBody(lic));
        ok('K-5: si el código pasó a otro teléfono, la licencia vieja ya no usa la IA', o.status === 403 && /no está activo/.test(o.body.error), o.body);
        const rec = JSON.parse(await env.BMOD_KV.get('code:' + code)); rec.revoked = true;
        await env.BMOD_KV.put('code:' + code, JSON.stringify(rec));
        const lic2 = (await call('POST', '/api/license/activate', { code: (await call('POST', '/api/admin/codes', { count: 1, product: 'premium' }, { 'x-admin-secret': 'test-admin' })).body.codes[0], deviceId: 'k5-dev2' })).body.token;
        const c2 = JSON.parse(Buffer.from(lic2.split('.')[0], 'base64url').toString()).code;
        const r2 = JSON.parse(await env.BMOD_KV.get('code:' + c2)); r2.revoked = true; await env.BMOD_KV.put('code:' + c2, JSON.stringify(r2));
        const foods = await call('POST', '/api/food-vision', { token: lic2, kind: 'label', image: 'iVBORw0KGgo=' });
        ok('K-5: código anulado (devolución, baja) → tampoco fotos de comida', foods.status === 403, foods.body);
        delete env.AI;

        // S-3: un error interno no le muestra el detalle al usuario (queda en el registro)
        const realGet = env.BMOD_KV.get;
        env.BMOD_KV.get = async () => { throw new Error('detalle-secreto-del-servidor en /internal'); };
        const e500 = await call('POST', '/api/license/activate', { code: 'BMOD-AAAA-BBBB', deviceId: 's3-dev' });
        env.BMOD_KV.get = realGet;
        ok('S-3: error interno → mensaje genérico, sin el detalle', e500.status === 500 && !JSON.stringify(e500.body).includes('detalle-secreto') && /Probá de nuevo/.test(e500.body.error), e500.body);
        ok('S-3: y el detalle queda en el registro del Worker', logged.some((l) => l.includes('detalle-secreto')));

        // L-7: hasta 20 códigos por pedido
        const many = await call('POST', '/api/admin/codes', { count: 50, product: 'premium' }, { 'x-admin-secret': 'test-admin' });
        ok('L-7: pedir 50 códigos de una vez → se crean 20', many.status === 200 && many.body.codes.length === 20, many.body.codes && many.body.codes.length);

        // L-6: tope global de copias Safari → app vivas (con el objeto de contadores)
        if (RUN_DO) {
            const bucket = 'xf:' + Math.floor(Date.now() / 1800000);
            const six = () => String(100000 + Math.floor(Math.random() * 899999));
            const first = await call('POST', '/api/transfer', { data: 'x', wrap: 'w', code: six() });   // crea el objeto de contadores si hace falta
            const ctr = ns._dos.get('counters');
            ctr.storage._m.set(bucket, { f: { n: 30 }, exp: Date.now() + 3600000 });
            const c6 = six();
            const t = await call('POST', '/api/transfer', { data: 'x', wrap: 'w', code: c6 });
            ok('L-6: llegado el tope de copias en curso → 503 con explicación (no se guarda nada)', first.status === 201 && t.status === 503 && /muchas copias/.test(t.body.error) && !(await env.BMOD_KV.get('xcode:' + c6)), [first.status, t.body]);
            ctr.storage._m.delete(bucket);
        }

        // D-2: si programar el recordatorio del control falla, se reintenta y, si no, queda registrado
        const R = (await call('POST', '/api/routines', { coach_id: 'coachD2-' + Date.now(), name: 'P', plan: [{ day: 'A' }], alumno_name: 'D2' })).body;
        const key = Buffer.from(new Uint8Array(65).fill(4)).toString('base64url'), auth = Buffer.from(new Uint8Array(16).fill(7)).toString('base64url');
        const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/d2-' + Date.now(), keys: { p256dh: key, auth } };
        const realNsGet = ns.get;
        let fails = 1;
        ns.get = (id) => (String(id.name).startsWith('chk:') && fails-- > 0 ? { fetch: async () => { throw new Error('objeto caído un momento'); } } : realNsGet.call(ns, id));
        const p1 = await call('POST', '/api/shares/' + R.share_token + '/push', { subscription: sub, tz: 'America/Argentina/Buenos_Aires' });
        const chk = ns._dos.get('chk:' + R.share_token);
        ok('D-2: una falla momentánea al programar el recordatorio → se reintenta y queda programado', p1.status === 200 && chk && chk.storage._m.get('job') && chk.storage.alarm > Date.now(), [p1.body, chk && chk.storage._m.get('job')]);
        fails = 2; logged.length = 0;
        const p2 = await call('POST', '/api/shares/' + R.share_token + '/push', { subscription: sub, tz: 'America/Argentina/Buenos_Aires' });
        ok('D-2: si sigue fallando, queda en el registro (antes se perdía sin rastro)', p2.status === 200 && logged.some((l) => /no quedó programado/.test(l)), logged.slice(-2));
        ns.get = realNsGet;
    } finally {
        console.error = realErr;
        env.NOTIFIER = prevNS;
        if (!prevNS) delete env.NOTIFIER;
    }
}

// ── K-2: dos teléfonos activan el mismo código a la vez ──
{
    console.log('\nK-2: activación simultánea del mismo código');
    const prevNS = env.NOTIFIER;
    if (!env.NOTIFIER) env.NOTIFIER = makeDONamespace(Notifier, env);
    const ns = env.NOTIFIER;
    try {
        const code = (await call('POST', '/api/admin/codes', { count: 1, product: 'premium', months: 3 }, { 'x-admin-secret': 'test-admin' })).body.codes[0];
        const [a, b] = await Promise.all([
            call('POST', '/api/license/activate', { code, deviceId: 'k2-tel-A' }),
            call('POST', '/api/license/activate', { code, deviceId: 'k2-tel-B' })
        ]);
        const claim = ns._dos.get('act:' + code).storage._m.get('act');
        const rec = JSON.parse(await env.BMOD_KV.get('code:' + code));
        ok('K-2: los dos reciben licencia con el MISMO vencimiento (el reloj arranca una sola vez)', a.status === 200 && b.status === 200 && a.body.expiresAt === b.body.expiresAt && !!a.body.expiresAt, [a.body.expiresAt, b.body.expiresAt]);
        ok('K-2: el segundo cuenta como cambio de teléfono (decide el objeto del código)', ['k2-tel-A', 'k2-tel-B'].includes(claim.deviceId) && rec.used === true && rec.expires_at === a.body.expiresAt, [claim, rec.rebinds]);
        const loser = claim.deviceId === 'k2-tel-A' ? 'k2-tel-B' : 'k2-tel-A';
        const again = await call('POST', '/api/license/activate', { code, deviceId: loser });
        ok('K-2: después, todo sigue la regla de siempre (último teléfono, mismo vencimiento)', again.status === 200 && again.body.expiresAt === a.body.expiresAt, again.body);

        // Código de Coach: celular y tablet a la vez, cada uno con su panel → los dos terminan en el mismo
        const coachCode = (await call('POST', '/api/admin/codes', { count: 1, product: 'coach', months: 1 }, { 'x-admin-secret': 'test-admin' })).body.codes[0];
        const PA = 'aaaaaaaa-1111-4111-8111-000000000001', PB = 'bbbbbbbb-2222-4222-8222-000000000002';
        const [c1, c2] = await Promise.all([
            call('POST', '/api/license/activate', { code: coachCode, deviceId: 'k2-celu', coach_id: PA }),
            call('POST', '/api/license/activate', { code: coachCode, deviceId: 'k2-tablet', coach_id: PB })
        ]);
        ok('K-2: código de Coach en dos aparatos a la vez → el mismo panel de alumnos en los dos', c1.status === 200 && c2.status === 200 && c1.body.coach_id && c1.body.coach_id === c2.body.coach_id, [c1.body.coach_id, c2.body.coach_id]);
        const c3 = await call('POST', '/api/license/activate', { code: coachCode, deviceId: 'k2-otro', coach_id: 'cccccccc-3333-4333-8333-000000000003' });
        ok('K-2: y un tercer aparato después también recibe ese panel', c3.body.coach_id === c1.body.coach_id, c3.body.coach_id);
    } finally {
        env.NOTIFIER = prevNS;
        if (!prevNS) delete env.NOTIFIER;
    }
}

// ── Espejo semanal (KV_MIRROR = "weekly"): la copia de KV cubre a los Durable Objects ──
if (RUN_DO) {
    console.log('\nEspejo semanal del Coach (KV_MIRROR = "weekly")');
    const ns = env.NOTIFIER;
    const prevMirror = env.KV_MIRROR;
    env.KV_MIRROR = 'weekly';
    const realErr = console.error; console.error = () => { };
    try {
        const C = 'coachSemanal-' + Date.now();
        const today = new Date().toISOString().slice(0, 10);
        const r = (await call('POST', '/api/routines', { coach_id: C, name: 'P', plan: [{ day: 'A' }], alumno_name: 'Sem' })).body;
        const obj = ns._dos.get('coach:' + C);
        ok('semanal: un alumno nuevo se copia a KV en el momento (el panel todavía lista desde KV)', !!(await env.BMOD_KV.get('routine:' + C + ':' + r.id)));
        await call('POST', '/api/shares/' + r.share_token + '/sessions', { date: today, exercises: [] });
        const rt = obj.storage._m.get('mq:retry');
        ok('semanal: el entrenamiento queda en el objeto, todavía no en KV, con la copia programada a 7 días', !(await env.BMOD_KV.get('sessions:' + r.id)) && obj.storage._m.has('sessions:' + r.id) && rt && rt.at - Date.now() > 6.9 * 86400000 && obj.storage.alarm <= rt.at, rt);
        await call('POST', '/api/shares/' + r.share_token + '/checkins', { weight: 70 });
        ok('semanal: más cambios en la semana no adelantan la copia', obj.storage._m.get('mq:retry').at === rt.at);
        rt.at = Date.now() - 1; obj.storage._m.set('mq:retry', rt);
        await ns.fire('coach:' + C, true);
        ok('semanal: al llegar la semana se copia todo a KV y queda al día', !!(await env.BMOD_KV.get('sessions:' + r.id)) && !!(await env.BMOD_KV.get('checkins:' + r.id)) && !obj.storage._m.has('mq:retry') && ![...obj.storage._m.keys()].some((k) => k.startsWith('mq:')), [...obj.storage._m.keys()].filter((k) => k.startsWith('mq:')));
        await call('POST', '/api/shares/' + r.share_token + '/sessions', { date: today, exercises: [{ name: 'Press', sets: [{ kg: 50, reps: 5 }] }] });
        env.KV_MIRROR = 'on';
        await call('GET', '/api/shares/' + r.share_token);
        ok('al volver al espejo inmediato, lo que quedó juntado sale enseguida', /Press/.test(await env.BMOD_KV.get('sessions:' + r.id) || ''));
        env.KV_MIRROR = 'weekly';
        const realDel = env.BMOD_KV.delete;
        let failDel = true;
        env.BMOD_KV.delete = async (k) => { if (failDel && String(k).startsWith('sessions:')) throw new Error('KV DELETE failed: 429 Too Many Requests'); return realDel.call(env.BMOD_KV, k); };
        const del = await call('DELETE', '/api/routines/' + r.id + '?coach_id=' + C, undefined, { 'x-coach-id': C });
        const rt2 = obj.storage._m.get('mq:retry');
        ok('semanal: una baja borra de KV en el momento; si un borrado falla, se reintenta en segundos (no en una semana)', del.status === 200 && !(await env.BMOD_KV.get('routine:' + C + ':' + r.id)) && rt2 && rt2.at - Date.now() < 60000, [del.status, rt2]);
        failDel = false;
        env.BMOD_KV.delete = realDel;
        rt2.at = Date.now() - 1; obj.storage._m.set('mq:retry', rt2);
        await ns.fire('coach:' + C, true);
        ok('semanal: y el reintento termina de borrar', !(await env.BMOD_KV.get('sessions:' + r.id)));
    } finally {
        console.error = realErr;
        if (prevMirror === undefined) delete env.KV_MIRROR; else env.KV_MIRROR = prevMirror;
    }
}

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===\n');
process.exit(fail === 0 ? 0 : 1);
