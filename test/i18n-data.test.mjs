// Cobertura de las traducciones de DATOS (core/i18n-data.js): todo texto en
// español de las tablas de BERSERKERMOD.html que se muestra en pantalla
// (ejercicios, biblioteca, notas del generador de rutinas, deportes, frases)
// tiene que tener su inglés y su portugués. Así lo nuevo no queda sin traducir.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { DATA_TR, trData, addDataTr } = require(path.join(here, '..', 'core', 'i18n-data.js'));
const L = readFileSync(path.join(here, '..', 'BERSERKERMOD.html'), 'utf8').split('\n');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 600) : '')); } };

// Nombres que se dicen igual en inglés (y se usan así en Brasil): no necesitan entrada.
const SAME_IN_ALL = new Set(['Hip Thrust', 'Face Pull', 'Good Morning', 'Hack Squat', 'Glute Ham Raise', 'Russian Twist', 'Ab Wheel Rollout',
    'Dead Bug', 'Dragon Flag', 'Running', 'HIIT', 'Spinning', 'CrossFit', 'Surf', 'Yoga', 'Pilates', 'Core', 'Cardio']);
const SPANISH = /[áéíóúñ¿¡]| y |\b(de|del|la|las|los|el|con|sin|para|por|que|en|al|tu|más|muy|hasta|desde|una?|según|cada|semana|lado|pierna|peso|reps? por)\b/i;
const NEUTRAL = /^[\d\s\-–×x/s:.,%+]*(reps?|min|seg|s)?[\d\s\-–×x/s:.,%+]*$/i;   // '10-15 reps', '20-30s', '5-8'

const STR = /'((?:[^'\\\n]|\\.)+)'|"((?:[^"\\\n]|\\.)+)"/g;
const lit = (line) => [...line.split(' // ')[0].matchAll(STR)].map((m) => ({ v: m[1] || m[2], before: line.slice(0, m.index) }));
const blockOf = (pat) => {
    const s = L.findIndex((l) => l.includes(pat));
    const e = L.findIndex((l, i) => i > s && /^ {8}[\]}];?$/.test(l.trimEnd()));
    return L.slice(s, e + 1);
};

const strict = new Map();      // texto → de dónde sale (tiene que estar traducido sí o sí)
const loose = new Map();       // texto → de dónde sale (solo si parece español)
const add = (map, v, where) => { if (v && !map.has(v)) map.set(v, where); };

// Libre (EX_DB): nombres de días y ejercicios
for (const l of blockOf('const EX_DB = {')) for (const { v } of lit(l)) add(strict, v, 'EX_DB');
// Deportes: el campo name
for (const l of blockOf('const SPORTS = [')) { const m = l.match(/name: "([^"]+)"/); if (m) add(strict, m[1], 'SPORTS'); }
// Frases de Inicio
for (const l of blockOf('const QUOTES = [')) for (const { v } of lit(l)) add(strict, v, 'QUOTES');
// Biblioteca: campos que se muestran (los youtube_* no)
for (const l of blockOf('const EXERCISE_LIBRARY = [')) {
    for (const { v, before } of lit(l)) {
        const field = (before.match(/(\w+):\s*\[?[^:]*$/) || [])[1] || '';
        if (/^(id|target|difficulty|equipment|youtube_video_id|youtube_creator|youtube_query)$/.test(field)) continue;
        if (field === 'variations' || field === 'rpe') add(loose, v, 'LIBRARY.' + field);
        else add(strict, v, 'LIBRARY.' + (field || '?'));
    }
}
// Generador de rutinas: nombres de días/ejercicios, focos y notas
{
    const s = L.findIndex((l) => l.includes('function getRoutinePlan('));
    const e = L.findIndex((l, i) => i > s && /^ {8}function \w+\(/.test(l));
    for (const l of L.slice(s, e)) {
        if (/^\s*\/\//.test(l)) continue;
        for (const { v } of lit(l)) {
            if (/^routine_/.test(v) || /^[a-z_]+$/.test(v) || NEUTRAL.test(v)) continue;
            add(strict, v, 'getRoutinePlan');
        }
    }
}

console.log('\n=== i18n de datos ===\n');
const missing = [];
for (const [v, where] of strict) {
    if (SAME_IN_ALL.has(v) || NEUTRAL.test(v)) continue;
    if (!DATA_TR[v] && trData(v, 'en') === v) missing.push(where + ': ' + v);
}
for (const [v, where] of loose) {
    if (!SPANISH.test(v) || NEUTRAL.test(v)) continue;
    if (!DATA_TR[v] && trData(v, 'en') === v) missing.push(where + ': ' + v);
}
ok(`todo texto de datos en español tiene traducción (${strict.size + loose.size} revisados)`, missing.length === 0, missing);
const bad = Object.entries(DATA_TR).filter(([, v]) => !Array.isArray(v) || v.length !== 2 || !v[0] || !v[1]);
ok(`cada entrada tiene inglés y portugués (${Object.keys(DATA_TR).length} entradas)`, bad.length === 0, bad.slice(0, 5));

// Comportamiento de trData
ok('traduce exacto', trData('Press Banca Plano', 'en') === 'Flat Bench Press' && trData('Press Banca Plano', 'pt') === 'Supino Reto');
ok('español y desconocido quedan igual', trData('Press Banca Plano', 'es') === 'Press Banca Plano' && trData('Mi ejercicio raro', 'en') === 'Mi ejercicio raro');
ok('respeta prefijos (emoji) y sufijos', trData('🏆 Press Banca Plano', 'en') === '🏆 Flat Bench Press' && trData('Sentadilla:', 'pt') === 'Agachamento:');
ok('frases entre comillas', trData('"Sé más fuerte que tus excusas."', 'en') === '"Be stronger than your excuses."');
ok('mayúsculas',trData('PECHO', 'en') === 'CHEST' && trData('ESPALDA', 'pt') === 'COSTAS');
ok('compuestos con / y ·', trData('Pecho/Hombros/Tríceps', 'en') === 'Chest/Shoulders/Triceps' && trData('Sunday · Pecho', 'en') === 'Sunday · Chest' && trData('12-16/lado', 'en') === '12-16/side');

ok('"Día N" de rutinas importadas', trData('Día 3', 'en') === 'Day 3' && trData('DÍA 2', 'pt') === 'DIA 2');
addDataTr({ 'Hipertrofia': ['Hypertrophy', 'Hipertrofia'], 'Press Banca Plano': ['NO', 'NO'] });
ok('addDataTr suma textos del diccionario sin pisar los existentes', trData('Hipertrofia', 'en') === 'Hypertrophy' && trData('Press Banca Plano', 'en') === 'Flat Bench Press');

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===\n');
process.exit(fail === 0 ? 0 : 1);
