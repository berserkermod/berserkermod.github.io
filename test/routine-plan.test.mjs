// Reglas del generador de rutinas (getRoutinePlan), según la auditoría científica de
// noviembre 2026. Corre las 60 combinaciones (5 objetivos × 4 opciones de días × 3
// niveles) y cuenta las series como el mapa del cuerpo: 1 por músculo principal y 0,5
// por secundario (muscleTargets de core/calc.js, el método de Pelland 2026).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const calc = require(path.join(here, '..', 'core', 'calc.js'));
const html = readFileSync(path.join(here, '..', 'BERSERKERMOD.html'), 'utf8');
const a = html.indexOf('        function getRoutinePlan(');
const b = html.indexOf('        function finishOnboarding');
const getRoutinePlan = new Function('t', 'muscleTargets', html.slice(a, b) + '; return getRoutinePlan;')((k) => k, calc.muscleTargets);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra && extra.length ? '\n      ' + extra.slice(0, 12).join('\n      ') : '')); } };

const GOALS = ['muscle', 'fat_loss', 'strength', 'recomp', 'endurance'];
const LEVELS = ['principiante', 'intermedio', 'avanzado'];
const MAJOR = ['chest', 'lats', 'shoulders', 'biceps', 'triceps', 'quads', 'hamstrings', 'glutes'];
const isCore = (e) => { const tg = calc.muscleTargets(e.name); return tg.length === 1 && tg[0][0] === 'abs'; };
const load = (exs) => {
    const o = {};
    exs.forEach((e) => calc.muscleTargets(e.name).forEach(([m, w]) => { if (m !== 'abs') o[m] = (o[m] || 0) + e.sets * w; }));
    return o;
};

const errs = { unknown: [], week: [], session: [], min: [], freq: [], rir: [], sets: [], str: [], end: [], fat: [], core: [] };
for (const goal of GOALS) for (const days of [3, 4, 5, 6]) for (const level of LEVELS) {
    const id = `${goal} ${days}d ${level}`;
    const plan = getRoutinePlan(goal, days, level);
    const all = plan.flatMap((d) => d.exercises);
    all.forEach((e) => { if (!calc.muscleTargets(e.name).length) errs.unknown.push(`${id}: ${e.name}`); });
    all.forEach((e) => { if (!(e.sets >= 2)) errs.sets.push(`${id}: ${e.name} ${e.sets}`); });
    all.filter((e) => !isCore(e)).forEach((e) => { if (!/^\d-\d$/.test(e.rir || '')) errs.rir.push(`${id}: ${e.name} rir=${e.rir}`); });
    const wk = load(all);
    Object.entries(wk).forEach(([m, v]) => { if (v > 22) errs.week.push(`${id}: ${m} ${v}`); });
    MAJOR.forEach((m) => { if (!((wk[m] || 0) >= 4)) errs.min.push(`${id}: ${m} ${wk[m] || 0}`); });
    plan.forEach((d) => Object.entries(load(d.exercises)).forEach(([m, v]) => { if (v > 12) errs.session.push(`${id} ${d.name}: ${m} ${v}`); }));
    if (days >= 4) {
        for (const m of ['chest', 'lats', 'quads', 'hamstrings']) {
            const f = plan.filter((d) => d.exercises.some((e) => calc.muscleTargets(e.name).some(([mm, w]) => mm === m && w === 1))).length;
            if (f < 2) errs.freq.push(`${id}: ${m} ${f}x`);
        }
        if (days >= 5) plan.forEach((d) => { const n = d.exercises.filter(isCore).length; if (n !== 1) errs.core.push(`${id} ${d.name}: ${n} de core`); });
    }
    if (goal === 'strength') {
        for (const lift of ['Press Banca Plano', 'Sentadilla']) {
            const n = plan.filter((d) => d.exercises.some((e) => e.name === lift)).length;
            if (n < 2) errs.str.push(`${id}: ${lift} ${n}x`);
        }
    }
    if (goal === 'endurance') plan.forEach((d) => { if (d.exercises[0].reps !== '4-6') errs.end.push(`${id} ${d.name}: ${d.exercises[0].name} ${d.exercises[0].reps}`); });
    if (goal === 'fat_loss') all.filter((e) => !isCore(e)).forEach((e) => { if (e.rest_s < 45) errs.fat.push(`${id}: ${e.name} ${e.rest_s}s`); });
}

console.log('\n=== generador de rutinas ===\n');
ok('todo ejercicio cuenta para algún músculo (mapa del cuerpo)', !errs.unknown.length, errs.unknown);
ok('ningún ejercicio con menos de 2 series', !errs.sets.length, errs.sets);
ok('cada ejercicio (menos core) indica reps en reserva', !errs.rir.length, errs.rir);
ok('ningún músculo pasa de 22 series fraccionales por semana (tope inicial)', !errs.week.length, errs.week);
ok('ningún músculo pasa de 12 series fraccionales por sesión', !errs.session.length, errs.session);
ok('cada músculo grande tiene al menos 4 series por semana (dosis mínima)', !errs.min.length, errs.min);
ok('de 4 a 6 días: pecho, dorsales, cuádriceps e isquios 2 veces por semana', !errs.freq.length, errs.freq);
ok('de 5 a 6 días: 1 ejercicio de core por día', !errs.core.length, errs.core);
ok('fuerza: banca y sentadilla 2 veces por semana', !errs.str.length, errs.str);
ok('resistencia: cada día arranca con fuerza pesada (4-6 reps)', !errs.end.length, errs.end);
ok('pérdida de grasa: descansos de 45 s o más', !errs.fat.length, errs.fat);
console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===\n');
process.exit(fail === 0 ? 0 : 1);
