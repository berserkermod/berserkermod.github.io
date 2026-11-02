// Landing (index.html) en español, inglés y portugués: el español es el HTML y
// las traducciones están en <script id="landing-i18n"> con el texto en español
// como clave. Este test falla si un texto marcado no tiene traducción (o se
// cambió el español sin actualizarla), si queda texto visible sin marcar, o si
// falta una captura de la app en algún idioma.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra && extra.length ? '\n      ' + extra.slice(0, 15).join('\n      ') : '')); } };
const norm = (s) => s.replace(/\s+/g, ' ').trim();

console.log('\n=== landing: idiomas ===\n');

const block = html.match(/<script type="application\/json" id="landing-i18n">([\s\S]*?)<\/script>/);
ok('hay diccionario', !!block);
const raw = block ? block[1] : '{}';
let dict = {};
try { dict = JSON.parse(raw); ok('el diccionario es JSON válido', true); } catch (e) { ok('el diccionario es JSON válido', false, [e.message]); }
ok('el JSON no corta el <script> (</ escapado)', !raw.includes('</'));

const bad = Object.entries(dict).filter(([, v]) => !Array.isArray(v) || v.length !== 2 || v.some((x) => typeof x !== 'string' || !x.trim()));
ok('cada texto tiene inglés y portugués', bad.length === 0, bad.map(([k]) => k));
const tags = (s) => (s.match(/<[^>]+>/g) || []).sort().join(' ');
const tagDiff = Object.entries(dict).filter(([k, v]) => v.some((x) => tags(x) !== tags(k)));
ok('mismas etiquetas HTML en los tres idiomas', tagDiff.length === 0, tagDiff.map(([k]) => k));

// Lo que usa la página
const body = html.slice(html.indexOf('<body>'), html.indexOf('<script type="application/json" id="landing-i18n">'));
const used = new Set();
const missing = [];
const need = (k, where) => { used.add(k); if (!(k in dict)) missing.push(where + ': ' + k.slice(0, 100)); };
const MARKED = /<([a-z0-9]+)\b[^>]*\sdata-i18n(?=[\s>])[^>]*>([\s\S]*?)<\/\1>/g;
for (const m of body.matchAll(MARKED)) need(norm(m[2]), 'data-i18n');
for (const m of body.matchAll(/<img\b[^>]*>/g)) {
    const alt = (m[0].match(/\balt="([^"]*)"/) || [])[1];
    if (alt) { if (/data-i18n-alt/.test(m[0])) need(alt, 'alt'); else missing.push('alt sin data-i18n-alt: ' + alt); }
}
for (const m of body.matchAll(/<[a-z]+\b[^>]*\baria-label="([^"]*)"[^>]*>/g)) {
    if (/data-i18n-aria/.test(m[0])) need(m[1], 'aria-label'); else missing.push('aria-label sin data-i18n-aria: ' + m[1]);
}
need(norm(html.match(/<title>([^<]*)<\/title>/)[1]), 'title');
need(html.match(/<meta name="description" content="([^"]*)">/)[1], 'meta description');
// Textos de los scripts: T('…') / bmT('…') y T(cond ? '…' : '…')
const scripts = html.slice(html.indexOf('<script type="application/json" id="landing-i18n">'));
for (const m of scripts.matchAll(/\b(?:bmT|T)\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) need(m[1], 'script');
for (const m of scripts.matchAll(/\b(?:bmT|T)\([^()']*\?\s*'([^']*)'\s*:\s*'([^']*)'\s*\)/g)) { need(m[1], 'script'); need(m[2], 'script'); }
ok('todo lo marcado tiene traducción', missing.length === 0, missing);
const unused = Object.keys(dict).filter((k) => !used.has(k));
ok('no sobran traducciones (texto en español que ya no está)', unused.length === 0, unused);

// Texto visible que quedó sin marcar
const rest = body
    .replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<select[\s\S]*?<\/select>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ').replace(MARKED, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
const ALLOW = new Set(['BERSERKER', 'MOD', 'Free', 'Premium']);
const loose = [...new Set((rest.match(/[A-Za-zÁ-ú]{2,}/g) || []).filter((w) => !ALLOW.has(w)))];
ok('no queda texto visible sin marcar', loose.length === 0, loose);

// Capturas de la app en cada idioma
const shots = [...body.matchAll(/data-shot="([^"]+)"/g)].map((m) => m[1]);
ok('hay capturas marcadas con data-shot', shots.length >= 6);
const noShot = [];
for (const dir of ['', 'en/', 'pt/']) for (const f of shots) if (!existsSync(path.join(root, 'img', 'landing', dir + f))) noShot.push('img/landing/' + dir + f);
ok('cada captura existe en español, inglés y portugués', noShot.length === 0, noShot);

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===\n');
process.exit(fail === 0 ? 0 : 1);
