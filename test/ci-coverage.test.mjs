// Que ninguna tanda de tests quede afuera de `npm test` (auditoría 2026-11, T-2: el CI
// corría 3 de 8). CI corre `npm test`; este test falla si hay un *.test.mjs en test/ o en
// worker/test/ que esa cadena no corre, o si la tanda del Worker no corre en los dos modos
// de datos (KV y Durable Objects).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); } };

console.log('\n=== cobertura de npm test ===\n');
// La cadena de `npm test`, con los `npm run x` expandidos
const expand = (cmd, depth = 0) => cmd.replace(/npm run ([\w:-]+)/g, (m, name) => (depth < 5 && pkg.scripts[name] ? expand(pkg.scripts[name], depth + 1) : m));
const chain = expand(pkg.scripts.test || '');
const files = ['test', 'worker/test'].flatMap((d) => readdirSync(path.join(root, d)).filter((f) => f.endsWith('.test.mjs')).map((f) => d + '/' + f));
const missing = files.filter((f) => !chain.includes(f));
ok('npm test corre todas las tandas (' + files.length + ' archivos)', missing.length === 0, missing);
ok('la tanda del Worker corre con los datos del Coach en KV y en Durable Objects', /worker\/test\/worker\.test\.mjs(?! --do)/.test(chain) && chain.includes('worker/test/worker.test.mjs --do'));
const ci = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
ok('el CI corre npm test', /run:\s*npm test\b/.test(ci));
ok('el CI baja todo el historial (las pruebas contra el Worker anterior lo usan)', /fetch-depth:\s*0/.test(ci));

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===\n');
process.exit(fail === 0 ? 0 : 1);
