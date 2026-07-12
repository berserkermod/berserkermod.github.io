// Test del Worker sin servidor: importa el módulo real y lo ejerce con un env
// mock (KV en memoria). Node 24 ya trae crypto.subtle, Request/Response, btoa,
// crypto.randomUUID/getRandomValues globalmente. Corré con: node test/worker.test.mjs
import worker from '../src/index.js';

// ── KV mock (Map) con get/put/delete/list(prefix,cursor) ──
function makeKV() {
    const m = new Map();
    return {
        _m: m,
        async get(k) { return m.has(k) ? m.get(k) : null; },
        async put(k, v) { m.set(k, v); },
        async delete(k) { m.delete(k); },
        async list({ prefix = '', cursor } = {}) {
            const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name }));
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
    const s3 = await call('POST', '/api/shares/' + token + '/sessions', { date: '2020-01-01', day_name: 'Legs' });
    ok('sesión antigua registrada', s3.status === 201 && s3.body.session.date === '2020-01-01');
    const s4 = await call('POST', '/api/shares/badtoken00/sessions', { day_name: 'x' });
    ok('token inválido → 404', s4.status === 404);

    const listS = await call('GET', '/api/routines?coach_id=coachA');
    ok('coach ve adherencia (2 sesiones, 1 esta semana)', listS.body[0].session_count === 2 && listS.body[0].week_sessions === 1 && listS.body[0].last_session_at === today, listS.body[0]);
    const shareS = await call('GET', '/api/shares/' + token);
    ok('share devuelve sesiones al alumno', Array.isArray(shareS.body.sessions) && shareS.body.sessions.length === 2 && shareS.body.sessions[0].date === today, shareS.body.sessions);

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
