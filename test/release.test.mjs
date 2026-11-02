// Coherencia de la publicación: el Service Worker sirve core/calc.js desde su
// caché, así que la URL con que lo carga el HTML tiene que llevar la versión del
// SW. Si no coinciden, la primera apertura tras publicar mezcla HTML nuevo con
// calc.js viejo y la app se rompe cuando el HTML usa una función nueva.
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
const htmlVersions = [...html.matchAll(/<script src="core\/calc\.js(?:\?v=([^"]*))?"><\/script>/g)].map((m) => m[1] || '');
ok('sw.js declara VERSION', !!swVersion, swVersion);
ok('el HTML carga calc.js una sola vez', htmlVersions.length === 1, htmlVersions);
ok('la versión de calc.js en el HTML coincide con la del SW', htmlVersions[0] === swVersion, { html: htmlVersions[0], sw: swVersion });
ok('el SW precachea calc.js con esa misma versión', /'\.\/core\/calc\.js\?v=' \+ VERSION/.test(sw));
ok('la caché del SW se nombra con la versión', /const CACHE = 'berserkermod-v' \+ VERSION/.test(sw));

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===\n');
process.exit(fail === 0 ? 0 : 1);
