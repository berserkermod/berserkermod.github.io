// Paridad de claves i18n entre ES/EN/PT. Previene el bug clase `bal_s_maint`
// (una clave que existe en un idioma pero falta en otro → el usuario ve la key
// cruda o el fallback). Lee el HTML real y compara los sets de claves de cada
// diccionario. Sin dependencias: node test/i18n-parity.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', 'BERSERKERMOD.html'), 'utf8');

// Encuentra el objeto literal que sigue a `marker` y devuelve su texto {...},
// haciendo balance de llaves pero ignorando llaves dentro de strings y comentarios.
function extractObjectLiteral(src, marker) {
    const at = src.indexOf(marker);
    if (at < 0) throw new Error('marcador no encontrado: ' + marker);
    let i = src.indexOf('{', at);
    if (i < 0) throw new Error('no hay { tras: ' + marker);
    const start = i;
    let depth = 0, str = null, esc = false;
    for (; i < src.length; i++) {
        const ch = src[i], nx = src[i + 1];
        if (str) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === str) str = null;
            continue;
        }
        if (ch === '/' && nx === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
        if (ch === '/' && nx === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { str = ch; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error('objeto sin cerrar tras: ' + marker);
}

function parseDict(marker) {
    const text = extractObjectLiteral(html, marker);
    // El objeto es data pura (claves: strings). Lo evaluamos en un contexto limpio.
    // eslint-disable-next-line no-new-func
    return Function('"use strict"; return (' + text + ');')();
}

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + extra : '')); } }

function checkParity(label, dict) {
    const langs = Object.keys(dict);
    console.log('\n' + label + ' — idiomas: ' + langs.join(', '));
    // unión de todas las claves
    const all = new Set();
    for (const l of langs) for (const k of Object.keys(dict[l])) all.add(k);
    for (const l of langs) {
        const keys = new Set(Object.keys(dict[l]));
        const missing = [...all].filter((k) => !keys.has(k));
        ok(label + ' · ' + l + ' completo (' + keys.size + '/' + all.size + ')', missing.length === 0, missing.length ? 'faltan: ' + missing.join(', ') : undefined);
    }
}

console.log('\n=== i18n parity ===');
try {
    checkParity('I18N (global)', parseDict('const I18N = '));
    checkParity('STR (salud)', parseDict('const STR = '));
} catch (e) {
    fail++;
    console.log('  ✗ error extrayendo diccionarios → ' + e.message);
}

// ── Alimentos: cada item debe tener en + pt (los nombres no viven en I18N) ──
// Extrae el array/objeto literal que sigue al marcador (balance de corchetes).
function extractArrayLiteral(src, marker) {
    const at = src.indexOf(marker);
    if (at < 0) throw new Error('marcador no encontrado: ' + marker);
    let i = src.indexOf('[', at);
    if (i < 0) throw new Error('no hay [ tras: ' + marker);
    const start = i;
    let depth = 0, str = null, esc = false;
    for (; i < src.length; i++) {
        const ch = src[i], nx = src[i + 1];
        if (str) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === str) str = null;
            continue;
        }
        if (ch === '/' && nx === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
        if (ch === '/' && nx === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { str = ch; continue; }
        if (ch === '[') depth++;
        else if (ch === ']') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error('array sin cerrar tras: ' + marker);
}

console.log('\n=== alimentos trilingües (en/pt) ===');
try {
    const healthy = Function('"use strict"; return (' + extractArrayLiteral(html, 'const HEALTHY_FOODS = ') + ');')();
    const missH = healthy.filter((f) => !f.en || !f.pt).map((f) => f.id);
    ok('HEALTHY_FOODS con en+pt (' + healthy.length + ' items)', missH.length === 0, missH.length ? 'faltan: ' + missH.join(', ') : undefined);

    const pool = Function('"use strict"; return (' + extractObjectLiteral(html, 'const FOOD_POOL = ') + ');')();
    const poolItems = Object.values(pool).flat();
    const missP = poolItems.filter((f) => !f.en || !f.pt).map((f) => f.id);
    ok('FOOD_POOL con en+pt (' + poolItems.length + ' items)', missP.length === 0, missP.length ? 'faltan: ' + missP.join(', ') : undefined);
    const missT = poolItems.filter((f) => !f.tipEn || !f.tipPt).map((f) => f.id);
    ok('FOOD_POOL con tipEn+tipPt', missT.length === 0, missT.length ? 'faltan: ' + missT.join(', ') : undefined);
} catch (e) {
    fail++;
    console.log('  ✗ error extrayendo alimentos → ' + e.message);
}

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===\n');
process.exit(fail === 0 ? 0 : 1);
