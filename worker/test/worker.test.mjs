// Test del Worker sin servidor: importa el módulo real y lo ejerce con un env
// mock (KV en memoria). Node 24 ya trae crypto.subtle, Request/Response, btoa,
// crypto.randomUUID/getRandomValues globalmente. Corré con: node test/worker.test.mjs
import worker from '../src/index.js';

// ── KV mock (Map) con get/put/delete/list(prefix,cursor) ──
function makeKV() {
    const m = new Map(), meta = new Map();
    return {
        _m: m,
        async get(k) { return m.has(k) ? m.get(k) : null; },
        async put(k, v, opts) { m.set(k, v); if (opts && opts.metadata) meta.set(k, opts.metadata); else meta.delete(k); },
        async delete(k) { m.delete(k); meta.delete(k); },
        async list({ prefix = '', cursor, limit = 1000 } = {}) {
            const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => (meta.has(name) ? { name, metadata: meta.get(name) } : { name })).slice(0, limit);
            return { keys, list_complete: true, cursor: null };
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

console.log('\n=== BERSERKERMOD Worker tests ===\n');

// ── Ping + CORS ──
{
    console.log('Ping & CORS');
    const r = await call('GET', '/api/health');
    ok('ping ok', r.status === 200 && r.body.ok === true, r.body);
    ok('CORS header presente', r.cors === '*');
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
        env.BMOD_KV._m.set(key, JSON.stringify(rec));
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
    env.BMOD_KV._m.set(key, JSON.stringify(old));
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

    const cfg0 = await call('PUT', '/api/coach/config', { coach_id: PANEL, intake_questions: ['¿Practicás otro deporte?', '', '¿Qué horario preferís?', 'cuarta', 'quinta'] });
    ok('el coach guarda hasta 3 preguntas propias', cfg0.status === 200 && cfg0.body.intake_questions.length === 3 && cfg0.body.intake_questions[0] === '¿Practicás otro deporte?', cfg0.body);
    const r = (await call('POST', '/api/routines', { coach_id: PANEL, name: 'Plan Caro', plan: [{ name: 'A' }], alumno_name: 'Caro' })).body;
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

    // cambio de teléfono legítimo: la licencia se mueve al nuevo device
    const otherDevice = await call('POST', '/api/license/activate', { code, deviceId: 'dev2' });
    ok('cambio de device → re-bind 200 (no bloquea)', otherDevice.status === 200 && !!otherDevice.body.token, otherDevice.body);
    // tras moverse, el viejo token (dev1) ya no valida (device_mismatch)
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
    ok('primer trial coach 200 (7 días)', t1.status === 200 && t1.body.trial === true && t1.body.days === 7, t1.body);
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

// ── Oracle: camino Workers AI (default) + camino legacy con apiKey ──
{
    console.log('\nOracle');
    const noPrompt = await call('POST', '/api/oracle', {});
    ok('sin prompt → 400', noPrompt.status === 400);

    // Sin apiKey y sin binding AI → 503
    const noAI = await call('POST', '/api/oracle', { prompt: 'analizá' });
    ok('sin apiKey y sin binding AI → 503', noAI.status === 503, noAI.status);

    // Mock de Workers AI: el 70B devuelve el JSON con texto extra alrededor.
    let oracleModel = null, oraclePrompt = null;
    env.AI = {
        async run(model, opts) {
            oracleModel = model; oraclePrompt = opts.messages[0].content;
            return { response: 'Acá va tu análisis:\n{"insights":[{"icon":"📈","title":"Buen volumen","text":"Subiste 12% el volumen."},{"icon":"🦵","title":"Piernas flojas","text":"Solo 6 series semanales."}]}' };
        }
    };
    const noLic = await call('POST', '/api/oracle', { prompt: 'analizá' });
    ok('sin licencia → 403', noLic.status === 403, noLic.status);

    const gen = await call('POST', '/api/admin/codes', { count: 1, product: 'premium' }, { 'x-admin-secret': 'test-admin' });
    const act = await call('POST', '/api/license/activate', { code: gen.body.codes[0], deviceId: 'oracle-dev' });
    const o1 = await call('POST', '/api/oracle', { token: act.body.token, prompt: 'analizá mis 4 semanas' });
    ok('Workers AI → 200 + insights parseados', o1.status === 200 && o1.body.ok && o1.body.insights.length === 2 && o1.body.insights[0].title === 'Buen volumen', o1.body);
    ok('usa un modelo @cf/', typeof oracleModel === 'string' && oracleModel.startsWith('@cf/'), { oracleModel });
    ok('le pasa el prompt al modelo', typeof oraclePrompt === 'string' && oraclePrompt.includes('4 semanas'));

    // Respuesta objeto (sin string) también parsea
    env.AI.run = async () => ({ response: { insights: [{ icon: '💡', title: 'Obj', text: 'ok' }] } });
    const o2 = await call('POST', '/api/oracle', { token: act.body.token, prompt: 'x' });
    ok('respuesta-objeto → parsea', o2.status === 200 && o2.body.insights[0].title === 'Obj', o2.body);

    // Basura del modelo → 422
    env.AI.run = async () => ({ response: 'no hay json acá' });
    const o3 = await call('POST', '/api/oracle', { token: act.body.token, prompt: 'x' });
    ok('respuesta inválida → 422', o3.status === 422, o3.status);
    delete env.AI;

    // Camino legacy: con apiKey del usuario → proxy a Anthropic (Claude)
    const realFetch = globalThis.fetch;
    let sentKey = null, sentModel = null;
    globalThis.fetch = async (u, opts) => {
        sentKey = opts.headers['x-api-key'];
        sentModel = JSON.parse(opts.body).model;
        return new Response(JSON.stringify({ content: [{ text: '{"insights":[]}' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const proxied = await call('POST', '/api/oracle', { apiKey: 'sk-ant-xxx', prompt: 'analizá' });
    ok('legacy: proxy 200 + pasa la key a Anthropic', proxied.status === 200 && sentKey === 'sk-ant-xxx', { sentKey });
    ok('legacy: usa el modelo haiku', sentModel === 'claude-haiku-4-5-20251001', { sentModel });
    globalThis.fetch = realFetch;
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
        if (/scout|vision/.test(model)) { visionModelCalled = model; return { response: 'Día 1\nSentadilla 4 series 8 reps 60kg RIR 2\nCorrer 5km 30min' }; }
        return { response: '{"name":"Visión","days":[{"name":"Día 1","exercises":[{"type":"strength","name":"Sentadilla","sets":4,"reps":"8","kg":60,"rir":2,"notes":null},{"type":"cardio","name":"Correr","distance_km":5,"duration_min":30,"intensity":"medium","notes":null}]}]}' };
    };
    const vimg = await call('POST', '/api/parse-routine', { token, images: ['data:image/jpeg;base64,/9j/4AAQ'] });
    ok('vision: images → OCR → estructura → rutina', vimg.status === 200 && vimg.body.ok && vimg.body.routine.name === 'Visión' && vimg.body.routine.days[0].exercises.length === 2, vimg.body);
    ok('vision: usó el modelo de visión', typeof visionModelCalled === 'string' && /scout|vision/.test(visionModelCalled), { visionModelCalled });

    // PDF sin texto (imagen escaneada, sin fallback de imágenes) → 422, no rompe.
    env.AI.run = async () => ({ response: '{}' });
    env.AI.toMarkdown = async () => [{ name: 'rutina.pdf', data: '' }];
    const empty = await call('POST', '/api/parse-routine', { token, pdf_base64: 'JVBERi0=' });
    ok('PDF sin texto legible → 422', empty.status === 422, empty.status);

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
    ok('plato → items saneados (sin nombre o sin gramos afuera, máx 8)', meal.status === 200 && meal.body.kind === 'meal' && meal.body.items.length === 6 && meal.body.items[0].name === 'Milanesa de carne' && meal.body.items[1].grams === 200, meal.body);
    ok('el plato usa el pedido de estimación', /nutricionista/.test(lastReq.opts.messages[0].content[0].text));
    reply = '{"items":[]}';
    const empty = await call('POST', '/api/food-vision', { token, kind: 'meal', image: IMG });
    ok('foto sin comida → 422', empty.status === 422, empty.status);

    const bad = await call('POST', '/api/food-vision', { token, kind: 'label', image: 'data:image/jpeg;base64,<script>' });
    ok('imagen que no es base64 → 400', bad.status === 400, bad.status);
    const missing = await call('POST', '/api/food-vision', { token, kind: 'label' });
    ok('sin imagen → 400', missing.status === 400, missing.status);

    // Cuota diaria: 15 por licencia (6 ya se usaron arriba; los 400 no cuentan).
    reply = '{"items":[{"name":"Banana","grams":120,"kcal":105,"protein":1,"carbs":27,"fat":0}]}';
    const codes = [];
    for (let i = 0; i < 10; i++) codes.push((await call('POST', '/api/food-vision', { token, kind: 'meal', image: IMG })).status);
    ok('cuota: hasta 15 por día, la 16 → 429', codes.slice(0, 9).every(c => c === 200) && codes[9] === 429, codes);

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

    // Webhook → código con duración → activación arranca el reloj
    globalThis.fetch = async (u) => {
        if (String(u).includes('/v1/payments/777')) {
            return new Response(JSON.stringify({ status: 'approved', external_reference: 'premium_3m' }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    };
    const wh = await call('POST', '/api/webhook/mercadopago', { type: 'payment', data: { id: '777' } });
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
            return new Response(JSON.stringify({ status: 'approved', external_reference: 'coach_12m' }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    };
    const whC = await call('POST', '/api/webhook/mercadopago', { type: 'payment', data: { id: '888' } });
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
    ok('trained 200 y marca chica aparte de push:all', tr.status === 200 && [...env.BMOD_KV._m.keys()].some(k => k.startsWith('pushtr:')));
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

    const g1 = await call('POST', '/api/play/verify', { sku: 'hackeado', purchaseToken: 'tok', deviceId: 'dev1' });
    ok('sku inválido → 400', g1.status === 400, g1.status);

    const realFetch = globalThis.fetch;
    let ackCalled = 0; let oauthBody = null;
    const future = Date.now() + 31 * 86400000;
    globalThis.fetch = async (u, opts) => {
        const url = String(u);
        if (url.includes('oauth2.googleapis.com/token')) {
            oauthBody = opts.body;
            return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }), { status: 200 });
        }
        if (url.includes(':acknowledge')) { ackCalled++; return new Response('{}', { status: 200 }); }
        if (url.includes('/purchases/subscriptions/premium_12m/tokens/tokOK')) {
            return new Response(JSON.stringify({ expiryTimeMillis: String(future), paymentState: 1, acknowledgementState: 0 }), { status: 200 });
        }
        if (url.includes('/tokens/tokVencido')) {
            return new Response(JSON.stringify({ expiryTimeMillis: String(Date.now() - 1000), paymentState: 1, acknowledgementState: 1 }), { status: 200 });
        }
        if (url.includes('/tokens/tokPendiente')) {
            return new Response(JSON.stringify({ expiryTimeMillis: String(future), paymentState: 0, acknowledgementState: 1 }), { status: 200 });
        }
        if (url.includes('/tokens/tokNoExiste')) return new Response('{}', { status: 404 });
        return new Response('{}', { status: 500 });
    };

    const g2 = await call('POST', '/api/play/verify', { sku: 'premium_12m', purchaseToken: 'tokOK', deviceId: 'devPlay' });
    ok('suscripción válida → licencia premium_play', g2.status === 200 && g2.body.ok && g2.body.tier === 'premium' && g2.body.product === 'premium_play', g2.body);
    ok('exp = fin del período que informa Google', new Date(g2.body.expiresAt).getTime() === future, g2.body.expiresAt);
    ok('acknowledge llamado (sin ack Google reembolsa a los 3 días)', ackCalled === 1, ackCalled);
    ok('OAuth con grant jwt-bearer (RS256)', oauthBody && String(oauthBody).includes('jwt-bearer'), oauthBody && String(oauthBody).slice(0, 50));
    const v = await call('POST', '/api/license/verify', { token: g2.body.token });
    ok('el token Play verifica válido en /api/license/verify', v.status === 200 && v.body.valid === true, v.body);

    const g3 = await call('POST', '/api/play/verify', { sku: 'premium_12m', purchaseToken: 'tokVencido', deviceId: 'devPlay' });
    ok('suscripción vencida → 403', g3.status === 403, g3.status);
    const g4 = await call('POST', '/api/play/verify', { sku: 'premium_12m', purchaseToken: 'tokPendiente', deviceId: 'devPlay' });
    ok('pago pendiente → 403', g4.status === 403, g4.status);
    const g5 = await call('POST', '/api/play/verify', { sku: 'premium_12m', purchaseToken: 'tokNoExiste', deviceId: 'devPlay' });
    ok('compra inexistente → 404', g5.status === 404, g5.status);

    globalThis.fetch = realFetch;
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
        async toMarkdown() { return [{ data: 'Día 1: Press banca 3x8' }]; }
    };
    const gen = await call('POST', '/api/admin/codes', { count: 1, product: 'premium' }, { 'x-admin-secret': 'test-admin' });
    const act = await call('POST', '/api/license/activate', { code: gen.body.codes[0], deviceId: 'quota-dev' });
    let oracleLast;
    for (let i = 0; i < 21; i++) oracleLast = await call('POST', '/api/oracle', { token: act.body.token, prompt: 'x' });
    ok('Oracle: llamada 21 del día → 429', oracleLast.status === 429 && /límite diario/.test(oracleLast.body.error || ''), oracleLast.body);
    const gen2 = await call('POST', '/api/admin/codes', { count: 1, product: 'premium' }, { 'x-admin-secret': 'test-admin' });
    const act2 = await call('POST', '/api/license/activate', { code: gen2.body.codes[0], deviceId: 'quota-dev-2' });
    const otherLic = await call('POST', '/api/oracle', { token: act2.body.token, prompt: 'x' });
    ok('otra licencia tiene su propia cuota', otherLic.status === 200, otherLic.status);
    let parseLast;
    for (let i = 0; i < 6; i++) parseLast = await call('POST', '/api/parse-routine', { token: act.body.token, pdf_base64: 'JVBERi0=' });
    ok('Importar PDF: llamada 6 del día → 429', parseLast.status === 429, parseLast.body);
    const legacyKey = await call('POST', '/api/oracle', { apiKey: 'sk-ant-x', prompt: 'x' });
    ok('camino legacy con API key propia no consume cuota (no 429)', legacyKey.status !== 429, legacyKey.status);
    const dayKeys = [...env.BMOD_KV._m.keys()].filter(k => k.startsWith('aiq:') && (k.endsWith(gen.body.codes[0]) || k.endsWith(gen2.body.codes[0])));
    const q1 = JSON.parse(await env.BMOD_KV.get('aiq:' + new Date().toISOString().slice(0, 10) + ':' + gen.body.codes[0]));
    ok('cuota: una key por licencia y día, con ambos contadores', dayKeys.length === 2 && q1.oracle === 20 && q1.parse === 5, [dayKeys, q1]);
    delete env.AI;

    // Ticket de pago: durable paid:{id} + ticket payment:{id} con gracia tras el primer retiro
    env.MP_ACCESS_TOKEN = 'TEST-mp-token';
    const realFetch2 = globalThis.fetch;
    globalThis.fetch = async (u) => String(u).includes('/v1/payments/888')
        ? new Response(JSON.stringify({ status: 'approved', external_reference: 'premium_1m' }), { status: 200 })
        : new Response('{}', { status: 404 });
    const wh1 = await call('POST', '/api/webhook/mercadopago', { type: 'payment', data: { id: '888' } });
    const ticketRaw = JSON.parse(await env.BMOD_KV.get('payment:888'));
    ok('webhook escribe ticket JSON sin retirar + marcador paid', wh1.body.code && ticketRaw.code === wh1.body.code && ticketRaw.retrieved_at === null && (await env.BMOD_KV.get('paid:888')) === wh1.body.code, ticketRaw);
    const r1 = await call('GET', '/api/license/retrieve?payment=888');
    const r2 = await call('GET', '/api/license/retrieve?payment=888');
    ok('retirar dos veces (refresh) devuelve el mismo código', r1.body.status === 'ready' && r1.body.code === wh1.body.code && r2.body.code === wh1.body.code, [r1.body, r2.body]);
    const ticketAfter = JSON.parse(await env.BMOD_KV.get('payment:888'));
    ok('el primer retiro marca retrieved_at (ticket pasa a gracia corta)', typeof ticketAfter.retrieved_at === 'string', ticketAfter);
    const wh2 = await call('POST', '/api/webhook/mercadopago', { type: 'payment', data: { id: '888' } });
    ok('webhook repetido → mismo código (idempotente por paid:)', wh2.body.dup === true && wh2.body.code === wh1.body.code, wh2.body);
    await env.BMOD_KV.delete('payment:888'); // simula el vencimiento de la gracia
    const r3 = await call('GET', '/api/license/retrieve?payment=888');
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

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===\n');
process.exit(fail === 0 ? 0 : 1);
