// Tests de la capa de cálculo pura (core/calc.js). Sin dependencias: node test/calc.test.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// calc.js es un módulo UMD (no ESM): lo cargamos con require.
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const calc = require(path.join(here, '..', 'core', 'calc.js'));
const { calcTDEE, calcMacros, formatPortion, calcDailyBalance, calc1RM, cardioKcal, platesPerSide, warmupSets, weightTrend, adaptiveTDEE, maintenanceOf, muscleTargets, muscleSets, isoWeek, topSet, exerciseTrend, prefillSets } = calc;

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } }

console.log('\n=== core/calc tests ===\n');

console.log('calcTDEE (Mifflin-St Jeor × factor actividad)');
{
    // Hombre 80kg/180cm/30a, 4 días: BMR=10*80+6.25*180-5*30+5=1780; ×1.55=2759
    ok('hombre 4 días', calcTDEE({ sex: 'M', weight: 80, height: 180, age: 30, days: 4 }) === 2759, calcTDEE({ sex: 'M', weight: 80, height: 180, age: 30, days: 4 }));
    // Mujer 60kg/165cm/28a, 3 días: BMR=10*60+6.25*165-5*28-161=1330.25; ×1.375=1829
    ok('mujer 3 días', calcTDEE({ sex: 'F', weight: 60, height: 165, age: 28, days: 3 }) === 1829, calcTDEE({ sex: 'F', weight: 60, height: 165, age: 28, days: 3 }));
    // factores por días: 3→1.375, 4→1.55, 5→1.725, 6→1.9
    const base = { sex: 'M', weight: 80, height: 180, age: 30 };
    ok('factor 5 días > 4 días', calcTDEE({ ...base, days: 5 }) > calcTDEE({ ...base, days: 4 }));
    ok('factor 6 días el más alto', calcTDEE({ ...base, days: 6 }) > calcTDEE({ ...base, days: 5 }));
    ok('días desconocidos → factor 1.55 (default)', calcTDEE({ ...base, days: 99 }) === calcTDEE({ ...base, days: 4 }));
    ok('sin usuario → 2000', calcTDEE(null) === 2000);
}

console.log('\ncalcMacros (ajuste por objetivo + split)');
{
    const u = { sex: 'M', weight: 80, height: 180, age: 30, days: 4, goal: 'muscle' };
    const m = calcMacros(u);
    ok('muscle: superávit +400', m.targetCals === m.tdee + 400, m);
    ok('muscle: proteína 2.0 g/kg = 160', m.protein === 160, m.protein);
    const cut = calcMacros({ ...u, goal: 'fat_loss' });
    ok('fat_loss: déficit -400', cut.targetCals === cut.tdee - 400, cut);
    ok('fat_loss: proteína 2.2 g/kg = 176', cut.protein === 176, cut.protein);
    ok('targetCals nunca por debajo de 1200', calcMacros({ sex: 'F', weight: 45, height: 150, age: 60, days: 3, goal: 'fat_loss' }).targetCals >= 1200);
    ok('macros cierran ~ targetCals', Math.abs((m.protein * 4 + m.carbs * 4 + m.fat * 9) - m.targetCals) <= 12, m);
    ok('sin usuario → defaults', calcMacros(null).targetCals === 2000);
}

console.log('\ncalcDailyBalance (superávit / déficit / mantenimiento)');
{
    const u = { sex: 'M', weight: 80, height: 180, age: 30, days: 4, goal: 'muscle' }; // maint 2759
    const surplus = calcDailyBalance(u, 3300, 0);
    ok('come 3300 → superávit', surplus.status === 'surplus' && surplus.aligned === true, surplus);
    const cardio = calcDailyBalance(u, 3300, 600); // net 2700 → dentro de banda
    ok('cardio 600 lo saca del superávit', cardio.status === 'maintenance' && cardio.aligned === false, cardio);
    const deficit = calcDailyBalance(u, 2000, 300);
    ok('come poco → déficit', deficit.status === 'deficit', deficit);
    ok('neto = consumido − quemado', deficit.net === 2000 - 300);
    const cutter = calcDailyBalance({ ...u, goal: 'fat_loss' }, 2000, 300);
    ok('fat_loss en déficit → aligned', cutter.status === 'deficit' && cutter.aligned === true, cutter);
}

console.log('\ncalc1RM (Epley)');
{
    ok('1 rep → el peso mismo', calc1RM(100, 1) === 100);
    ok('100kg × 8 → 127', calc1RM(100, 8) === 127, calc1RM(100, 8));
    ok('60kg × 10 → 80', calc1RM(60, 10) === 80, calc1RM(60, 10));
    ok('más reps → más 1RM', calc1RM(100, 12) > calc1RM(100, 5));
}

console.log('\ncardioKcal (MET × intensidad × peso × horas)');
{
    ok('MET8 80kg 30min media → 320', cardioKcal(8, 1, 80, 1800) === 320, cardioKcal(8, 1, 80, 1800));
    ok('intensidad alta escala', cardioKcal(8, 1.3, 80, 1800) > cardioKcal(8, 1, 80, 1800));
    ok('1h MET10 80kg → 800', cardioKcal(10, 1, 80, 3600) === 800, cardioKcal(10, 1, 80, 3600));
    ok('args faltantes → 0 (sin crash)', cardioKcal() === 0);
}

console.log('\nformatPortion (unidad natural)');
{
    ok('huevos: 100g → "2 huevos"', formatPortion(100, { kind: 'count', g: 50, label: 'huevo', labelP: 'huevos' }) === '2 huevos');
    ok('huevo: 50g → "1 huevo" (singular)', formatPortion(50, { kind: 'count', g: 50, label: 'huevo', labelP: 'huevos' }) === '1 huevo');
    ok('líquido: 250g d=1 → "250 ml"', formatPortion(250, { kind: 'ml', density: 1 }) === '250 ml');
    ok('aceite: 91g d=0.91 → "100 ml"', formatPortion(91, { kind: 'ml', density: 0.91 }) === '100 ml');
    ok('sin unidad → gramos', formatPortion(150.6, null) === '151 g');
    ok('mínimo 1 unidad', formatPortion(10, { kind: 'count', g: 50, label: 'u' }) === '1 u');

    const eggUnit = { kind: 'count', g: 50, label: 'huevo', labelP: 'huevos', labelEn: 'egg', labelPEn: 'eggs', labelPt: 'ovo', labelPPt: 'ovos' };
    ok('en: 100g → "2 eggs"', formatPortion(100, eggUnit, 'en') === '2 eggs');
    ok('en: 50g → "1 egg" (singular)', formatPortion(50, eggUnit, 'en') === '1 egg');
    ok('pt: 100g → "2 ovos"', formatPortion(100, eggUnit, 'pt') === '2 ovos');
    ok('es explícito → "2 huevos"', formatPortion(100, eggUnit, 'es') === '2 huevos');
    ok('sin lang → español (retrocompat)', formatPortion(100, eggUnit) === '2 huevos');
    ok('en sin traducción → cae al label base', formatPortion(100, { kind: 'count', g: 50, label: 'huevo', labelP: 'huevos' }, 'en') === '2 huevos');
}

console.log('weightTrend / adaptiveTDEE / maintenanceOf (peso y gasto real)');
{
    const iso = (base, n) => new Date(Date.parse(base + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
    const tr = weightTrend([{ date: '2026-10-02', kg: 81 }, { date: '2026-10-01', kg: 80 }]);
    ok('ordena por fecha y suaviza 10 %/día (80 → 80,1)', tr.length === 2 && tr[0].trend === 80 && tr[1].trend === 80.1, tr);
    const gap = weightTrend([{ date: '2026-10-01', kg: 80 }, { date: '2026-10-04', kg: 81 }]);
    ok('con 3 días sin pesarse se acerca más (80,27)', gap[1].trend === 80.27, gap);
    ok('ignora entradas inválidas', weightTrend([{ date: '2026-10-01', kg: 0 }, null, { kg: 80 }]).length === 0);

    const today = '2026-11-01';
    const days = (n, f) => Array.from({ length: n }, (_, i) => f(iso(today, -n + i), i));
    const weights = days(21, (d) => ({ date: d, kg: 80 }));
    const eat = (kcal) => days(21, (d) => ({ date: d, kcal }));
    const a = adaptiveTDEE({ weights, intakes: eat(2600), formula: 2700, today });
    ok('peso estable comiendo 2600 → gasto 2600', a && a.tdee === 2600 && a.change === 0 && a.loggedDays === 21, a);
    const down = adaptiveTDEE({ weights: days(21, (d, i) => ({ date: d, kg: 80 - i * 0.07 })), intakes: eat(2400), formula: 2700, today });
    ok('bajando de peso → gasta más de lo que come', down && down.raw > 2400 && down.tdee > 2400, down);
    ok('pocos días con comida → null', adaptiveTDEE({ weights, intakes: eat(2600).slice(0, 9), formula: 2700, today }) === null);
    ok('días con menos de 800 kcal no cuentan', adaptiveTDEE({ weights, intakes: eat(500), formula: 2700, today }) === null);
    ok('pocas pesadas → null', adaptiveTDEE({ weights: weights.slice(0, 3), intakes: eat(2600), formula: 2700, today }) === null);
    const capped = adaptiveTDEE({ weights, intakes: eat(5000), formula: 2700, today });
    ok('nunca más de +25 % de la fórmula', capped && capped.tdee <= 3380 && capped.raw === 5000, capped);
    const half = adaptiveTDEE({ weights, intakes: eat(2600).filter((_, i) => i % 2 === 0), formula: 2800, today });
    ok('con la mitad de los días registrados confía a medias en el dato', half && half.tdee > 2600 && half.tdee < 2800, half);
    ok('hoy no cuenta (día sin terminar)', adaptiveTDEE({ weights, intakes: eat(2600).concat([{ date: today, kcal: 9000 }]), formula: 2700, today }).tdee === 2600);

    const u = { sex: 'M', weight: 80, height: 180, age: 30, days: 4, goal: 'muscle' };
    ok('maintenanceOf sin ajuste = fórmula', maintenanceOf(u) === calcTDEE(u));
    ok('maintenanceOf con ajuste aceptado', maintenanceOf({ ...u, tdeeAdaptive: 3000 }) === 3000);
    ok('calcMacros usa el gasto ajustado (+400 por ganar músculo)', calcMacros({ ...u, tdeeAdaptive: 3000 }).targetCals === 3400);
    ok('el balance del día compara contra el gasto ajustado', calcDailyBalance({ ...u, tdeeAdaptive: 3000 }, 3000, 0).status === 'maintenance');
}

console.log('muscleTargets / muscleSets (mapa del cuerpo)');
{
    const main = (n) => (muscleTargets(n)[0] || [])[0];
    const cases = {
        'Press Banca Plano': 'chest', 'Press Inclinado con mancuernas': 'chest', 'Aperturas Pec Deck': 'chest', 'Flexiones': 'chest',
        'Press Militar': 'shoulders', 'Elevaciones laterales': 'shoulders', 'Face Pull': 'shoulders',
        'Jalón al pecho': 'lats', 'Dominadas': 'lats', 'Remo con barra': 'lats',
        'Curl con barra': 'biceps', 'Curl martillo': 'biceps', 'Curl de muñeca': 'forearms',
        'Press francés': 'triceps', 'Fondos en paralelas': 'triceps', 'Patada de tríceps': 'triceps',
        'Sentadilla': 'quads', 'Sentadilla Búlgara': 'quads', 'Prensa': 'quads', 'Extensión de cuádriceps': 'quads',
        'Peso muerto rumano': 'hamstrings', 'Curl femoral': 'hamstrings', 'Peso muerto': 'glutes', 'Hip Thrust': 'glutes',
        'Elevación de Piernas Colgado': 'abs', 'Plancha': 'abs', 'Russian Twist': 'abs',
        'Gemelos de pie': 'calves', 'Encogimientos': 'traps', 'Hiperextensiones': 'lowback',
        'Extensión Cuádriceps': 'quads', 'Extensión Overhead': 'triceps'
    };
    const wrong = Object.entries(cases).filter(([n, m]) => main(n) !== m).map(([n, m]) => n + ' → ' + main(n) + ' (esperaba ' + m + ')');
    ok('cada ejercicio cae en su músculo principal (' + Object.keys(cases).length + ' casos)', wrong.length === 0, wrong);
    ok('"Jalón al pecho" es espalda aunque diga pecho', main('Jalón al pecho') === 'lats');
    ok('"Elevación de piernas" es abdomen, no piernas', main('Elevación de Piernas Tumbado') === 'abs');
    ok('ejercicio desconocido → sin músculos', muscleTargets('Bicicleta fija').length === 0);
    const ms = muscleSets([{ exercises: [
        { exercise: 'Press Banca Plano', sets: [{}, {}, {}, {}] },
        { exercise: 'Press Militar', sets: [{}, {}, {}] },
        { exercise: 'Bicicleta fija', sets: [{}] }
    ] }]);
    ok('principal 1 serie, secundarios 0,5 (pecho 4, hombros 3+2, tríceps 2+1,5)', ms.chest === 4 && ms.shoulders === 5 && ms.triceps === 3.5 && ms.unknown === 1, ms);
    ok('las 13 zonas siempre presentes', calc.MUSCLES.length === 13 && calc.MUSCLES.every(m => typeof ms[m] === 'number'));
}

console.log('platesPerSide (discos por lado)');
{
    const KG = [25, 20, 15, 10, 5, 2.5, 1.25];
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    ok('100 kg, barra 20 → 25 + 15 por lado', eq(platesPerSide(100, 20, KG), { perSide: [25, 15], rest: 0 }), platesPerSide(100, 20, KG));
    ok('82,5 kg → 25 + 5 + 1,25', eq(platesPerSide(82.5, 20, KG), { perSide: [25, 5, 1.25], rest: 0 }), platesPerSide(82.5, 20, KG));
    ok('barra sola o menos → sin discos', eq(platesPerSide(20, 20, KG), { perSide: [], rest: 0 }) && eq(platesPerSide(15, 20, KG), { perSide: [], rest: 0 }));
    ok('peso que no cierra → informa el resto', eq(platesPerSide(21, 20, KG), { perSide: [], rest: 1 }), platesPerSide(21, 20, KG));
    ok('repite discos si hace falta (180 kg → 25×3 + 5)', eq(platesPerSide(180, 20, KG).perSide, [25, 25, 25, 5]), platesPerSide(180, 20, KG));
    ok('libras (barra 45): 225 → 45 + 45', eq(platesPerSide(225, 45, [45, 35, 25, 10, 5, 2.5]).perSide, [45, 45]));
    ok('no modifica la lista de discos', (() => { const l = [5, 25, 10]; platesPerSide(100, 20, l); return eq(l, [5, 25, 10]); })());
}

console.log('warmupSets (series de aproximación)');
{
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    ok('100 kg con barra: barra×10, 40×8, 60×5, 80×3', eq(warmupSets(100, { bar: 20 }), [{ kg: 20, reps: 10 }, { kg: 40, reps: 8 }, { kg: 60, reps: 5 }, { kg: 80, reps: 3 }]), warmupSets(100, { bar: 20 }));
    ok('redondea al escalón (82,5 → 32,5 / 50 / 65)', eq(warmupSets(82.5, { bar: 20 }).map(s => s.kg), [20, 32.5, 50, 65]), warmupSets(82.5, { bar: 20 }));
    ok('poco peso: salta escalones por debajo de la barra', eq(warmupSets(30, { bar: 20 }), [{ kg: 20, reps: 10 }, { kg: 25, reps: 3 }]), warmupSets(30, { bar: 20 }));
    ok('trabajo = barra → sin aproximación', eq(warmupSets(20, { bar: 20 }), []));
    ok('sin barra (mancuernas): solo porcentajes', eq(warmupSets(30, { step: 2 }).map(s => s.kg), [12, 18, 24]), warmupSets(30, { step: 2 }));
    ok('sin peso → nada', eq(warmupSets(0, { bar: 20 }), []) && eq(warmupSets(NaN), []));
    ok('nunca llega al peso de trabajo ni repite', warmupSets(22.5, { bar: 20 }).every((s, i, a) => s.kg < 22.5 && (!i || s.kg > a[i - 1].kg)), warmupSets(22.5, { bar: 20 }));
}

console.log('Modo Coach: semana ISO, mejor serie, progreso y precarga');
{
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    ok('semana ISO (bordes de año incluidos)', isoWeek('2026-01-01') === '2026-W01' && isoWeek('2025-12-29') === '2026-W01' && isoWeek('2021-01-03') === '2020-W53' && isoWeek('2026-11-08') === '2026-W45' && isoWeek('2026-11-09') === '2026-W46');
    ok('semana ISO de fecha inválida → vacío', isoWeek('nada') === '');
    ok('mejor serie: más kg; a igual kg, más reps', eq(topSet([{ kg: 80, reps: 8 }, { kg: 82.5, reps: 5 }, { kg: 82.5, reps: 6 }]), { kg: 82.5, reps: 6 }));
    ok('series sin reps no cuentan', topSet([{ kg: 100, reps: 0 }]) === null && topSet([]) === null);
    const ses = [
        { date: '2026-11-09', exercises: [{ name: 'Sentadilla', sets: [{ kg: 85, reps: 5 }] }, { name: 'Press', sets: [{ kg: 60, reps: 6 }] }, { name: 'Remo', sets: [{ kg: 50, reps: 10 }] }] },
        { date: '2026-11-06' },
        { date: '2026-11-04', exercises: [{ name: 'sentadilla ', sets: [{ kg: 80, reps: 8 }] }, { name: 'Press', sets: [{ kg: 60, reps: 8 }] }, { name: 'Remo', sets: [{ kg: 50, reps: 10 }] }] }
    ];
    ok('progreso: subió kg → 1 (sin importar mayúsculas ni sesiones sin detalle)', exerciseTrend(ses, 0, 'Sentadilla') === 1);
    ok('progreso: mismo kg, menos reps → -1; igual → 0', exerciseTrend(ses, 0, 'Press') === -1 && exerciseTrend(ses, 0, 'Remo') === 0);
    ok('progreso sin vez anterior → null', exerciseTrend(ses, 2, 'Press') === null && exerciseTrend(ses, 0, 'Curl') === null);
    const vol = [
        { exercises: [{ name: 'Sentadilla', sets: [{ kg: 80, reps: 6 }, { kg: 80, reps: 6 }, { kg: 80, reps: 6 }] }] },
        { exercises: [{ name: 'Sentadilla', sets: [{ kg: 80, reps: 6 }, { kg: 80, reps: 6 }, { kg: 77.5, reps: 6 }] }] },
        { exercises: [{ name: 'Sentadilla', sets: [{ kg: 80, reps: 6 }, { kg: 80, reps: 6 }, { kg: 80, reps: 6 }] }] }
    ];
    ok('misma mejor serie: desempata el volumen (77,5 → 80 en la S3 = subió; al revés = bajó)', exerciseTrend(vol, 0, 'Sentadilla') === 1 && exerciseTrend(vol, 1, 'Sentadilla') === -1);
    ok('precarga: lo último que registró', eq(prefillSets('press', ses, { sets: 4, reps: '10', kg: 40 }), [{ kg: 60, reps: 6 }]));
    ok('precarga sin historial: el plan (8-12 → 8)', eq(prefillSets('Curl', ses, { sets: 3, reps: '8-12', kg: 12.5 }), [{ kg: 12.5, reps: 8 }, { kg: 12.5, reps: 8 }, { kg: 12.5, reps: 8 }]));
    ok('precarga sin plan: 3 series vacías; tope 12', prefillSets('X', [], null).length === 3 && prefillSets('X', [], { sets: 40 }).length === 12);
}

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===\n');
process.exit(fail === 0 ? 0 : 1);
