// Textos de interfaz escritos en español directo en el código (sin t()): se ven
// sin traducir en inglés y portugués. Este test los busca en las llamadas que
// muestran algo en pantalla y falla si aparece uno nuevo. Si un texto tiene que
// quedar así a propósito, va en ALLOW con el motivo.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const L = readFileSync(path.join(here, '..', 'BERSERKERMOD.html'), 'utf8').split('\n');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '\n      ' + extra.join('\n      ') : '')); } };

// Zonas que no son interfaz o que ya traduce core/i18n-data.js
const zone = (startPat, endTest) => {
    const s = L.findIndex((l) => l.includes(startPat));
    if (s < 0) return [0, -1];
    const e = L.findIndex((l, i) => i > s && endTest(l));
    return [s, e];
};
const closes = (l) => /^ {8}[\]}];?$/.test(l.trimEnd());
const SKIP = [
    zone('const I18N = {', closes),                       // el diccionario
    zone('const EX_DB = {', closes), zone('const SPORTS = [', closes), zone('const EXERCISE_LIBRARY = [', closes),
    zone('const QUOTES = [', closes), zone('const HEALTHY_FOODS = [', closes), zone('const FOOD_POOL = {', closes),
    zone('const COUNTRIES = [', closes),
    zone('function getRoutinePlan(', (l) => /^ {8}function \w+\(/.test(l)),
];
// Módulo de salud y sus autotests (HealthService … HealthDev): no se muestran en la app
{
    const s = L.findIndex((l) => l.startsWith('        const HealthService = (function'));
    const dev = L.findIndex((l) => l.startsWith('        const HealthDev = (function'));
    const e = dev < 0 ? -1 : L.findIndex((l, i) => i > dev && /^ {8}\}\)\(\);/.test(l));
    if (s >= 0 && e > s) SKIP.push([s, e]);
}

const ALLOW = [
    /localhost|serve\.ps1|file:\/\//,          // avisos que solo ve quien desarrolla en esta PC
    /🇪🇸 Español|Entrenador personal inteligente/, // cada idioma se presenta en su propia lengua
];
const UI_CALL = /\bh\(|flash\(|textContent\s*=|innerHTML\s*=|confirm\(|alert\(|fillText\(|doc\.text\(|placeholder\s*=|new Error\(/;
const STR = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
const SPANISH = /[áéíóúñ¿¡]|\b(de|del|la|las|los|el|tu|tus|para|con|sin|por|que|hoy|días?|entrenamiento|rutina|ejercicios?|guardar|agregar|cargando|nuevo|nueva|volver|cerrar|crear|elegir|alumno|siguiente|anterior|listo|error)\b/i;

const found = [];
let inScript = false;
for (let i = 0; i < L.length; i++) {
    const st = L[i].trim();
    if (st.startsWith('<script') && !st.includes('src=')) inScript = true;
    if (st.startsWith('</script>')) inScript = false;
    if (!inScript || SKIP.some(([s, e]) => i >= s && i <= e)) continue;
    const line = L[i];
    if (/^\s*(\/\/|\*)/.test(line) || /console\.\w+\(|logAppError\(|DEBUG_APP/.test(line) || !UI_CALL.test(line)) continue;
    if (ALLOW.some((re) => re.test(line))) continue;
    const code = line.split(' // ')[0];
    for (const m of code.matchAll(STR)) {
        const v = m[1] ?? m[2] ?? m[3] ?? '';
        if (!/[A-Za-zÁ-ú]{3}/.test(v) || /^[\w-]+$/.test(v) && !/[áéíóúñ]/i.test(v)) continue;     // ids, clases
        if (/^(bm-|https?:|data:|var\(|#|\.)/.test(v) || /<\/?[a-z]+[^>]*>$/.test(v.trim()) && !SPANISH.test(v.replace(/<[^>]+>/g, ''))) continue;
        if (SPANISH.test(v.replace(/<[^>]+>|\$\{[^}]*\}/g, ' '))) found.push(`${i + 1}: ${v.slice(0, 90)}`);
    }
}

console.log('\n=== i18n de interfaz ===\n');
ok('sin textos de interfaz en español fuera de t()', found.length === 0, found);
console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===\n');
process.exit(fail === 0 ? 0 : 1);
