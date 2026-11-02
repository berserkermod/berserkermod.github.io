// Coherencia de la publicación: el Service Worker sirve los scripts de core/
// desde su caché, así que la URL con que los carga el HTML tiene que llevar la
// versión del SW. Si no coinciden, la primera apertura tras publicar mezcla HTML
// nuevo con un script viejo y la app se rompe cuando el HTML usa algo nuevo.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', 'BERSERKERMOD.html'), 'utf8');
const sw = readFileSync(path.join(here, '..', 'sw.js'), 'utf8');

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

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===\n');
process.exit(fail === 0 ? 0 : 1);
