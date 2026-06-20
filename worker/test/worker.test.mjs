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
    ok('trial de otro producto sí (3 días)', t3.status === 200 && t3.body.days === 3, t3.body);
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

// ── Oracle proxy (fetch stubeado) ──
{
    console.log('\nOracle proxy');
    const realFetch = globalThis.fetch;
    let sentKey = null, sentModel = null;
    globalThis.fetch = async (u, opts) => {
        sentKey = opts.headers['x-api-key'];
        sentModel = JSON.parse(opts.body).model;
        return new Response(JSON.stringify({ content: [{ text: '{"insights":[]}' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const noKey = await call('POST', '/api/oracle', { prompt: 'hola' });
    ok('sin apiKey → 400', noKey.status === 400);
    const proxied = await call('POST', '/api/oracle', { apiKey: 'sk-ant-xxx', prompt: 'analizá' });
    ok('proxy 200 + pasa la key a Anthropic', proxied.status === 200 && sentKey === 'sk-ant-xxx', { sentKey });
    ok('usa el modelo haiku', sentModel === 'claude-haiku-4-5-20251001', { sentModel });
    globalThis.fetch = realFetch;
}

// ── Importar rutina desde PDF (IA) ──
{
    console.log('\nImportar rutina (PDF + IA)');
    const noKey = await call('POST', '/api/parse-routine', { pdf_base64: 'JVBERi0=' });
    ok('sin ANTHROPIC_KEY → 503', noKey.status === 503, noKey.status);

    env.ANTHROPIC_KEY = 'test-anthropic-key';
    const noLic = await call('POST', '/api/parse-routine', { pdf_base64: 'JVBERi0=' });
    ok('sin licencia válida → 403', noLic.status === 403, noLic.status);

    const gen = await call('POST', '/api/admin/codes', { count: 1, product: 'coach' }, { 'x-admin-secret': 'test-admin' });
    const act = await call('POST', '/api/license/activate', { code: gen.body.codes[0], deviceId: 'pdf-dev' });
    const token = act.body.token;

    const realFetch = globalThis.fetch;
    let sentBody = null;
    globalThis.fetch = async (u, opts) => {
        if (String(u).includes('/v1/messages')) {
            sentBody = JSON.parse(opts.body);
            // Claude responde el JSON SIN la primera llave (por el prefill '{')
            const ai = '"name":"Full Body","days":[{"name":"Día 1","exercises":['
                + '{"type":"strength","name":"Sentadilla","sets":4,"reps":"8-10","kg":60,"rir":2,"notes":null},'
                + '{"type":"cardio","name":"Correr","distance_km":5,"duration_min":30,"intensity":"medium","notes":null}]}]}';
            return new Response(JSON.stringify({ content: [{ text: ai }] }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    };
    const r = await call('POST', '/api/parse-routine', { token, pdf_base64: 'data:application/pdf;base64,JVBERi0xLjQK' });
    ok('parse 200 + rutina', r.status === 200 && r.body.ok && r.body.routine.name === 'Full Body', r.body);
    ok('manda el PDF como document block', !!sentBody && sentBody.messages[0].content[0].type === 'document', sentBody && sentBody.messages[0].content[0].type);
    ok('strip del prefijo data: → base64 limpio', sentBody.messages[0].content[0].source.data === 'JVBERi0xLjQK', sentBody.messages[0].content[0].source.data);
    ok('prefill assistant con {', sentBody.messages[1].role === 'assistant' && sentBody.messages[1].content === '{');
    const ex = r.body.routine.days[0].exercises;
    ok('strength parseado (sets/kg/rir)', ex[0].type === 'strength' && ex[0].sets === 4 && ex[0].kg === 60 && ex[0].rir === 2, ex[0]);
    ok('cardio parseado (km/min/intensidad)', ex[1].type === 'cardio' && ex[1].distance_km === 5 && ex[1].duration_min === 30 && ex[1].intensity === 'medium', ex[1]);
    globalThis.fetch = realFetch;
    delete env.ANTHROPIC_KEY;
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
    ok('products devuelve coach (ARS)', p0.body && p0.body.coach && p0.body.coach.currency === 'ARS', p0.body);
    ok('coach NO disponible sin config', p0.body.coach.available === false);

    const c0 = await call('POST', '/api/checkout', {});
    ok('checkout sin MP token → 503', c0.status === 503, c0.status);

    // con token + precio + fetch a MP stubeado
    env.MP_ACCESS_TOKEN = 'TEST-mp-token';
    env.COACH_PRICE_ARS = '21600';
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
    ok('coach disponible con config (precio 21600)', p1.body.coach.available === true && p1.body.coach.price === 21600, p1.body);
    const c1 = await call('POST', '/api/checkout', { price: 1 }); // intento de mandar precio del cliente
    ok('checkout → init_point', c1.status === 200 && c1.body.init_point === 'https://mp/checkout/abc', c1.body);
    ok('usa precio del SERVER, no del cliente', sentPref && sentPref.items[0].unit_price === 21600, sentPref && sentPref.items[0]);
    ok('external_reference = coach', sentPref.external_reference === 'coach');
    ok('notification_url → webhook', sentPref.notification_url.endsWith('/api/webhook/mercadopago'), sentPref.notification_url);
    ok('back_url success → landing ?purchase=coach', /\/\?purchase=coach$/.test(sentPref.back_urls.success), sentPref.back_urls.success);
    globalThis.fetch = realFetch;
    delete env.MP_ACCESS_TOKEN; delete env.COACH_PRICE_ARS;
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
