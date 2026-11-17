// Coherencia de la publicación (auditoría de infraestructura 2026-11, W-1 y W-3).
//
// El Service Worker sirve desde su caché todo lo que no es una página (core/, íconos,
// fuentes, img/, pdfjs/, manifest.json) y solo lo vuelve a bajar cuando cambia VERSION.
// Por eso:
//   1. la URL con que el HTML carga los scripts de core/ lleva la versión del SW;
//   2. si cambia uno de esos archivos, VERSION tiene que cambiar. Para saberlo, este test
//      guarda la huella de cada archivo en release-manifest.json. Con la misma VERSION y una
//      huella distinta, falla. Con VERSION nueva, pide regenerar la lista:
//          node test/release.test.mjs --update
//   3. todo lo que el SW precarga existe: si falta uno, la versión nueva no se instala nunca.
// Las huellas de los archivos de texto ignoran el fin de línea (\r\n en Windows, \n en CI).
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const MANIFEST = path.join(here, 'release-manifest.json');
const html = readFileSync(path.join(root, 'BERSERKERMOD.html'), 'utf8');
const sw = readFileSync(path.join(root, 'sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); } };

console.log('\n=== release ===\n');
const swVersion = (sw.match(/const VERSION = '([^']+)'/) || [])[1];
ok('sw.js declara VERSION', !!swVersion, swVersion);
ok('la caché del SW se nombra con la versión', /const CACHE = 'berserkermod-v' \+ VERSION/.test(sw));

const scripts = [...html.matchAll(/<script src="(core\/[\w-]+\.js)(?:\?v=([^"]*))?"><\/script>/g)].map((m) => ({ file: m[1], v: m[2] || '' }));
ok('el HTML carga calc.js e i18n-data.js', ['core/calc.js', 'core/i18n-data.js'].every((f) => scripts.some((s) => s.file === f)), scripts);
for (const s of scripts) {
    ok(`${s.file} se carga una sola vez`, scripts.filter((x) => x.file === s.file).length === 1);
    ok(`${s.file}: la versión en el HTML coincide con la del SW`, s.v === swVersion, { html: s.v, sw: swVersion });
    ok(`${s.file}: el SW lo precachea con esa misma versión`, sw.includes(`'./${s.file}?v=' + VERSION`));
}

// ── Todo lo que el SW precarga existe (si no, la versión nueva no se instala nunca) ──
const shellBlock = (sw.match(/const SHELL = \[([\s\S]*?)\];/) || [])[1] || '';
const shell = [...shellBlock.matchAll(/'\.\/([^'?]*)/g)].map((m) => m[1]).filter(Boolean);
ok('el SW precarga una lista de archivos', shell.length >= 5, shell);
const missing = shell.filter((f) => !existsSync(path.join(root, f)));
ok('todos los archivos que precarga el SW existen en el repo', missing.length === 0, missing);

// ── Huellas de lo que el SW sirve desde la caché ──
const TEXT = /\.(js|mjs|json|css|svg|txt|html|webmanifest)$/i;
function walk(rel) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) return [];
    if (statSync(abs).isFile()) return [rel];
    return readdirSync(abs).sort().flatMap((n) => walk(rel + '/' + n));
}
function cachedFiles() {
    const top = readdirSync(root).filter((n) => /^icon-.*\.png$/.test(n) || n === 'manifest.json');
    return ['core', 'fonts', 'img', 'pdfjs'].flatMap(walk).concat(top).sort();
}
function fingerprint(rel) {
    let buf = readFileSync(path.join(root, rel));
    if (TEXT.test(rel)) buf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}
const now = { version: swVersion, files: Object.fromEntries(cachedFiles().map((f) => [f, fingerprint(f)])) };

if (process.argv.includes('--update')) {
    writeFileSync(MANIFEST, JSON.stringify(now, null, 2) + '\n');
    console.log('  → release-manifest.json actualizado para la versión ' + swVersion + ' (' + Object.keys(now.files).length + ' archivos)');
} else {
    let saved = null;
    try { saved = JSON.parse(readFileSync(MANIFEST, 'utf8')); } catch { saved = null; }
    ok('existe test/release-manifest.json (si no: node test/release.test.mjs --update)', !!saved);
    if (saved) {
        const changed = Object.keys(now.files).filter((f) => saved.files[f] !== now.files[f]);
        const gone = Object.keys(saved.files).filter((f) => !(f in now.files));
        const diff = changed.concat(gone);
        if (saved.version === swVersion) {
            ok('con la misma VERSION no cambió ningún archivo que se sirve desde la caché (si cambió, subí VERSION en sw.js y en el HTML)', diff.length === 0, diff);
        } else {
            ok('VERSION nueva (' + saved.version + ' → ' + swVersion + '): falta regenerar la lista con node test/release.test.mjs --update', false, diff);
        }
    }
}

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===\n');
process.exit(fail === 0 ? 0 : 1);
