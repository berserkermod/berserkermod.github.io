// BERSERKERMOD — Publicar el Worker de forma segura (auditoría 2026-11, T-4).
// =====================================================================
// Uso (desde deploy/worker):
//   node publicar.mjs            hace todo y pide confirmación antes de publicar
//   node publicar.mjs --ensayo   hace todo MENOS publicar (para probar el camino)
//   node publicar.mjs --si       no pregunta (solo cuando el dueño ya dio el OK)
//   --sin-copia                  publica sin copia de seguridad (solo si la carpeta no existe)
//
// Pasos:
//   1. El código a publicar está guardado en git (sin cambios sueltos en worker/).
//   2. Corre las tres tandas de tests del Worker.
//   3. Verifica que wrangler está en la cuenta de BerserkerMOD (si no, frena).
//   4. Copia de seguridad cifrada de KV y prueba de restauración (carpeta copias-kv,
//      fuera del repo).
//   5. Anota la versión publicada ahora (para volver atrás) y los nombres de las claves.
//   6. Ensayo de armado (wrangler deploy --dry-run).
//   7. Publica.
//   8. Compara las claves (mismos nombres que antes), prueba rutas sin tocar datos y
//      escucha los registros ~75 s (incluye una corrida del recordatorio).
//   9. Deja una línea en .publicaciones.log (no va a git) y el comando para volver atrás.
//
// Volver atrás:  npx wrangler@<versión> rollback <id de la versión anterior>
//   (lo imprime el script). Con el espejo prendido (KV_MIRROR = "on") los datos de KV
//   están al día. Si después se vuelve a publicar el Worker nuevo: subir DATA_EPOCH.
// =====================================================================
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const WRANGLER = 'wrangler@4.164.0';        // versión fija (auditoría T-5)
const ACCOUNT = '0a8cc9f61d77cd06dd7fb75d825e3aa1';
const API = 'https://berserkermod-api.berserkermod.workers.dev';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const COPIAS = path.resolve(HERE, '..', '..', 'copias-kv');
const LOG = path.join(HERE, '.publicaciones.log');
const args = process.argv.slice(2);
const ENSAYO = args.includes('--ensayo');
const SI = args.includes('--si');
const SIN_COPIA = args.includes('--sin-copia');

const step = (n, t) => console.log('\n[' + n + '] ' + t);
const okLine = (t) => console.log('    ✓ ' + t);
const warn = (t) => console.log('    ⚠ ' + t);
function stop(msg) { console.error('\n✗ FRENADO: ' + msg + '\n  No se publicó nada.'); process.exit(1); }
function run(cmd, opts = {}) {
    return execSync(cmd, { cwd: opts.cwd || HERE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } });
}
function wr(cmdArgs) { return run('npx --yes ' + WRANGLER + ' ' + cmdArgs); }
function jsonOf(out) { const i = out.search(/[[{]/); if (i < 0) throw new Error('sin JSON: ' + out.slice(0, 200)); return JSON.parse(out.slice(i)); }
function secretNames() { return jsonOf(wr('secret list')).map((s) => s.name).sort(); }
function currentVersion() {
    try { const st = jsonOf(wr('deployments status --json')); return (st.versions || []).map((v) => v.version_id + (v.percentage !== 100 ? ' (' + v.percentage + '%)' : '')).join(', '); }
    catch { return null; }
}
async function getJSON(url, init) {
    const r = await fetch(url, init);
    let j = null; try { j = await r.json(); } catch { /* sin JSON */ }
    return { status: r.status, body: j };
}

// Escucha los registros `secs` segundos y resume: { total, porRuta, conErrores[] }.
function tailFor(secs) {
    return new Promise((resolve) => {
        const child = spawn('npx --yes ' + WRANGLER + ' tail berserkermod-api --format json', { cwd: HERE, shell: true, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } });
        let raw = '';
        child.stdout.on('data', (d) => { raw += d; });
        child.stderr.on('data', () => { });
        const finish = () => {
            const dec = [];
            let i = 0;
            while (i < raw.length) {
                while (i < raw.length && /\s/.test(raw[i])) i++;
                if (i >= raw.length) break;
                let depth = 0, j = i, inStr = false, esc = false;
                for (; j < raw.length; j++) {
                    const c = raw[j];
                    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
                    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { j++; break; } }
                }
                try { dec.push(JSON.parse(raw.slice(i, j))); } catch { break; }
                i = j;
            }
            const porRuta = {}, conErrores = [];
            for (const o of dec) {
                const ev = o.event || {};
                const kind = ev.cron ? 'cron' : String((ev.request && ev.request.url) || '?').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
                const key = (o.outcome || '?') + ' ' + kind;
                porRuta[key] = (porRuta[key] || 0) + 1;
                const errs = (o.logs || []).filter((l) => l.level === 'error' || l.level === 'warn').map((l) => (l.message || []).join(' '));
                if (o.outcome !== 'ok' || errs.length || (o.exceptions || []).length) conErrores.push({ outcome: o.outcome, kind, errs: errs.slice(0, 2) });
            }
            resolve({ total: dec.length, porRuta, conErrores });
        };
        setTimeout(() => {
            if (process.platform === 'win32') { try { execSync('taskkill /pid ' + child.pid + ' /T /F', { stdio: 'ignore' }); } catch { /* ya terminó */ } }
            else child.kill('SIGTERM');
            setTimeout(finish, 500);
        }, secs * 1000);
    });
}

async function main() {
    console.log('BERSERKERMOD — publicar el Worker' + (ENSAYO ? '  (ENSAYO: no se publica nada)' : ''));

    step(1, 'Código guardado en git');
    const dirty = run('git status --porcelain -- .').trim();
    if (dirty && !ENSAYO) stop('hay cambios sin guardar en worker/:\n' + dirty + '\n  Hacé commit antes de publicar.');
    if (dirty) warn('hay cambios sin guardar (en un ensayo se permite):\n' + dirty);
    const commit = run('git rev-parse --short HEAD').trim();
    const branch = run('git rev-parse --abbrev-ref HEAD').trim();
    if (branch !== 'main') warn('estás en la rama "' + branch + '", no en main');
    okLine('commit ' + commit + ' (' + branch + ')');

    step(2, 'Tests del Worker');
    for (const t of ['node test/worker.test.mjs', 'node test/worker.test.mjs --do', 'node test/coach-data.test.mjs']) {
        let out;
        try { out = run(t); } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
        const m = out.match(/=== (\d+) passed, (\d+) failed ===/);
        if (!m || m[2] !== '0') stop('falló "' + t + '": ' + (m ? m[2] + ' tests en rojo' : 'no terminó'));
        okLine(t + ' → ' + m[1] + ' en verde');
    }

    step(3, 'Cuenta de Cloudflare');
    const who = wr('whoami');
    if (!who.includes(ACCOUNT)) stop('wrangler no está en la cuenta de BerserkerMOD (' + ACCOUNT + ').');
    okLine('cuenta ' + ACCOUNT);

    step(4, 'Copia de seguridad de KV');
    if (fs.existsSync(path.join(COPIAS, 'copia-kv.mjs'))) {
        try {
            const c = run('node copia-kv.mjs', { cwd: COPIAS });
            okLine((c.match(/Copia hecha[^\n]*/) || ['copia hecha'])[0]);
            const p = run('node restaurar-kv.mjs --probar', { cwd: COPIAS });
            if (!/OK/.test(p)) stop('la prueba de restauración no dio OK:\n' + p);
            okLine((p.match(/prueba de restauración[^\n]*/) || ['restauración probada'])[0]);
        } catch (e) { stop('la copia de seguridad falló: ' + String(e.stderr || e.stdout || e.message).split('\n').filter(Boolean).slice(-2).join(' ')); }
    } else if (SIN_COPIA) warn('sin copia de seguridad (no existe ' + COPIAS + ')');
    else stop('no encuentro ' + COPIAS + '. Si de verdad querés publicar sin copia: --sin-copia');

    step(5, 'Estado actual (para volver atrás)');
    const before = currentVersion();
    const secretsBefore = secretNames();
    okLine('versión publicada ahora: ' + (before || 'no se pudo leer'));
    okLine('claves secretas: ' + secretsBefore.join(', '));

    step(6, 'Ensayo de armado');
    const dry = wr('deploy --dry-run --outdir "' + path.join(HERE, '.wrangler', 'ensayo') + '"');
    okLine((dry.match(/Total Upload[^\n]*/) || ['armado ok'])[0]);

    if (ENSAYO) {
        step(7, 'Publicar: SALTEADO (ensayo)');
    } else {
        if (!SI) {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const a = await rl.question('\n¿Publicar el commit ' + commit + ' en producción? Escribí SI para seguir: ');
            rl.close();
            if (a.trim().toUpperCase() !== 'SI') stop('no se confirmó.');
        }
        step(7, 'Publicar');
        const out = wr('deploy');
        const vid = (out.match(/Current Version ID:\s*([a-f0-9-]+)/) || [])[1];
        if (!vid) stop('wrangler no informó la versión nueva:\n' + out.slice(-600));
        okLine('versión nueva: ' + vid);
    }

    step(8, 'Comprobaciones en producción');
    const secretsAfter = secretNames();
    if (secretsAfter.join(',') !== secretsBefore.join(',')) warn('¡las claves secretas cambiaron! antes: ' + secretsBefore.join(', ') + ' · ahora: ' + secretsAfter.join(', '));
    else okLine('claves secretas iguales que antes');
    const tailP = tailFor(75);
    await new Promise((r) => setTimeout(r, 8000));   // que el registro esté escuchando
    const checks = [
        ['salud', await getJSON(API + '/api/health'), (r) => r.status === 200],
        ['vigía (/api/health/deep)', await getJSON(API + '/api/health/deep'), (r) => r.status === 200],
        ['precios', await getJSON(API + '/api/products'), (r) => r.status === 200 && r.body && Array.isArray(r.body.premium_plans)],
        ['aviso de pago ajeno a la app', await getJSON(API + '/api/webhook/mercadopago', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":"payment","data":{"id":"x"}}' }), (r) => r.status === 200 && r.body && r.body.ignored],
        ['Google Play (sku inválido)', await getJSON(API + '/api/play/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"sku":"x","purchaseToken":"t","deviceId":"d"}' }), (r) => r.status === 400]
    ];
    let bad = 0;
    for (const [name, r, test] of checks) { if (test(r)) okLine(name + ' → ' + r.status); else { bad++; warn(name + ' → ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 160)); } }
    console.log('    … escuchando los registros 75 s (incluye una corrida del recordatorio)');
    const t = await tailP;
    for (const [k, n] of Object.entries(t.porRuta)) console.log('      ' + n + ' × ' + k);
    if (!t.porRuta['ok cron']) warn('no se vio ninguna corrida del recordatorio en ese rato');
    if (t.conErrores.length) { bad++; warn('registros con errores: ' + JSON.stringify(t.conErrores.slice(0, 4))); }
    else okLine('sin errores en los registros');

    step(9, 'Resultado');
    const now = currentVersion();
    const line = [new Date().toISOString(), ENSAYO ? 'ENSAYO' : 'PUBLICADO', 'commit ' + commit, 'antes ' + before, 'ahora ' + now, bad ? bad + ' aviso(s)' : 'todo ok'].join('  ');
    fs.appendFileSync(LOG, line + '\n');
    console.log('    ' + line);
    if (!ENSAYO && before) console.log('\n  Para volver atrás:  npx ' + WRANGLER + ' rollback ' + before.split(' ')[0]);
    if (bad) { console.log('\n⚠ Revisá los avisos de arriba antes de subir el código a GitHub.'); process.exit(2); }
    console.log('\n✓ Listo.' + (ENSAYO ? ' (ensayo: no se publicó nada)' : ' Ahora se puede subir el código a GitHub (git push).'));
}

main().catch((e) => stop(String((e && e.message) || e)));
