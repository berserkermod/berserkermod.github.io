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
const getRoutinePlan = new Function('t', 'muscleTargets', 'adjustMuscleVolume', html.slice(a, b) + '; return getRoutinePlan;')((k) => k, calc.muscleTargets, calc.adjustMuscleVolume);

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

const errs = { unknown: [], week: [], session: [], min: [], freq: [], rir: [], sets: [], str: [], end: [], fat: [], core: [], bw: [] };
const FOCUSES = [undefined, 'lower', 'upper'];
for (const focus of FOCUSES) for (const goal of GOALS) for (const days of [3, 4, 5, 6]) for (const level of LEVELS) {
    const id = `${goal} ${days}d ${level}${focus ? ' ' + focus : ''}`;
    const plan = getRoutinePlan(goal, days, level, focus);
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
    // Principiantes: nada de dominadas ni fondos con el propio peso (no se ajustan con la carga).
    if (level === 'principiante') all.forEach((e) => { if (/^(dominadas|fondos)/i.test(e.name)) errs.bw.push(`${id}: ${e.name}`); });
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
ok('principiantes: sin dominadas ni fondos con el propio peso', !errs.bw.length, errs.bw);
ok('todas las reglas anteriores valen también con prioridad en piernas y en torso', true);

// ── Prioridad muscular ──
{
    const UP = { lower: ['glutes', 'quads', 'hamstrings'], upper: ['chest', 'lats', 'shoulders', 'biceps', 'triceps'] };
    const DOWN = { lower: ['biceps', 'triceps', 'shoulders'], upper: ['quads', 'hamstrings', 'glutes'] };
    const total = (p) => p.flatMap((d) => d.exercises).reduce((x, e) => x + e.sets, 0);
    const e2 = { gain: [], drop: [], floor: [], hours: [], same: [] };
    for (const focus of ['lower', 'upper']) for (const goal of GOALS) for (const days of [3, 4, 5, 6]) for (const level of LEVELS) {
        const id = `${goal} ${days}d ${level} ${focus}`;
        const base = getRoutinePlan(goal, days, level), fp = getRoutinePlan(goal, days, level, focus);
        const wb = load(base.flatMap((d) => d.exercises)), wf = load(fp.flatMap((d) => d.exercises));
        const sum = (w, ms) => ms.reduce((x, m) => x + (w[m] || 0), 0);
        if (!(sum(wf, UP[focus]) >= sum(wb, UP[focus]) + 3)) e2.gain.push(`${id}: ${sum(wb, UP[focus])} → ${sum(wf, UP[focus])}`);
        UP[focus].forEach((m) => { if ((wf[m] || 0) < (wb[m] || 0)) e2.drop.push(`${id}: ${m} ${wb[m]} → ${wf[m]}`); });
        DOWN[focus].forEach((m) => { if ((wf[m] || 0) < Math.min(6, wb[m] || 0)) e2.floor.push(`${id}: ${m} ${wb[m]} → ${wf[m]}`); });
        if (total(fp) > total(base) + days) e2.hours.push(`${id}: ${total(base)} → ${total(fp)} series`);
    }
    // Sin prioridad (o con una desconocida) la rutina es exactamente la de siempre
    for (const goal of GOALS) for (const days of [3, 4, 5, 6]) for (const level of LEVELS) {
        const a1 = JSON.stringify(getRoutinePlan(goal, days, level)), a2 = JSON.stringify(getRoutinePlan(goal, days, level, 'balanced')), a3 = JSON.stringify(getRoutinePlan(goal, days, level, 'xx'));
        if (a1 !== a2 || a1 !== a3) e2.same.push(`${goal} ${days}d ${level}`);
    }
    ok('prioridad: los músculos elegidos suman 3 series semanales o más en total', !e2.gain.length, e2.gain);
    ok('prioridad: ningún músculo elegido pierde series', !e2.drop.length, e2.drop);
    ok('prioridad: los que ceden no bajan de 6 series (o de lo que tenían)', !e2.floor.length, e2.floor);
    ok('prioridad: como mucho 1 serie más por sesión en total (no suma horas)', !e2.hours.length, e2.hours);
    ok('sin prioridad: la rutina es idéntica a la de siempre (no toca a nadie)', !e2.same.length, e2.same);
}

// ── Sugerencia de carga (doble progresión) con cargas livianas ──
{
    const a2 = html.indexOf('        function suggestNextLoad(');
    const b2 = html.indexOf('        function checkProgression(');
    const state = { sessions: [], unit: 'kg' };
    const suggest = new Function('state', html.slice(a2, b2) + '; return suggestNextLoad;')(state);
    const run = (name, reps, kg, done) => {
        state.sessions = [{ exercises: [{ exercise: name, sets: done.map((r) => ({ kg, reps: r })) }] }];
        return suggest({ name, reps });
    };
    console.log('\n=== sugerencia de carga ===\n');
    const lat = run('Elevaciones Laterales', '10-12', 3, [12, 12, 12]);
    ok('3 kg con el rango completo: primero sumar reps hasta 14 (+1 kg sería +33 %)', lat && !lat.up && lat.extend && lat.targetReps === 14 && lat.kg === 3, [JSON.stringify(lat)]);
    const lat2 = run('Elevaciones Laterales', '10-12', 3, [14, 14, 14]);
    ok('3 kg con 14 reps en todas: sube a 4 kg (escalón real de mancuerna)', lat2 && lat2.up && lat2.kg === 4 && lat2.inc === 1, [JSON.stringify(lat2)]);
    const sq = run('Sentadilla', '8-10', 60, [10, 10, 10]);
    ok('60 kg en sentadilla: sube 2,5 kg como siempre (4 %)', sq && sq.up && sq.kg === 62.5, [JSON.stringify(sq)]);
    const bar = run('Sentadilla', '8-10', 20, [10, 10, 10]);
    ok('barra sola (20 kg): +2,5 sería 12,5 % → primero 12 reps', bar && bar.extend && bar.targetReps === 12, [JSON.stringify(bar)]);
    const part = run('Elevaciones Laterales', '10-12', 3, [12, 11, 10]);
    ok('sin el rango completo: mismo peso y buscar el tope (sin cambios)', part && !part.up && !part.extend && part.targetReps === 12, [JSON.stringify(part)]);
}

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===\n');
process.exit(fail === 0 ? 0 : 1);
