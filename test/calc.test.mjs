// Tests de la capa de cálculo pura (core/calc.js). Sin dependencias: node test/calc.test.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// calc.js es un módulo UMD (no ESM): lo cargamos con require.
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const calc = require(path.join(here, '..', 'core', 'calc.js'));
const { sessionPerf, performanceSignals, planMuscleSets, adjustMuscleVolume, strengthKcal, proteinWeight, calcTDEE, calcMacros, formatPortion, calcDailyBalance, calc1RM, cardioKcal, platesPerSide, warmupSets, weightTrend, adaptiveTDEE, maintenanceOf, muscleTargets, muscleSets, isoWeek, topSet, exerciseTrend, prefillSets, localDateStr, cardioWeek } = calc;

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
    // IMC ≥ 30: proteína sobre peso ajustado (peso con IMC 25 + 25 % del exceso)
    const big = calcMacros({ sex: 'M', weight: 120, height: 175, age: 35, days: 3, goal: 'fat_loss' });
    ok('IMC 39: 120 kg y 1,75 m → 192 g (no 264)', big.protein === 192, big.protein);
    ok('IMC 39 mujer: 100 kg y 1,60 m → 161 g (no 220)', calcMacros({ sex: 'F', weight: 100, height: 160, age: 35, days: 3, goal: 'fat_loss' }).protein === 161);
    ok('IMC < 30: sin cambios (peso total)', proteinWeight({ weight: 80, height: 180 }) === 80 && proteinWeight({ weight: 95, height: 178 }) === 95);
    ok('sin altura: usa el peso total', proteinWeight({ weight: 110 }) === 110);
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

console.log('\ncardioKcal ((MET × intensidad − 1) × peso × horas: calorías activas)');
{
    ok('MET8 80kg 30min media → 280 (sin el gasto en reposo)', cardioKcal(8, 1, 80, 1800) === 280, cardioKcal(8, 1, 80, 1800));
    ok('intensidad alta escala', cardioKcal(8, 1.3, 80, 1800) > cardioKcal(8, 1, 80, 1800));
    ok('1h MET10 80kg → 720', cardioKcal(10, 1, 80, 3600) === 720, cardioKcal(10, 1, 80, 3600));
    ok('actividad por debajo del reposo → 0, nunca negativo', cardioKcal(0.9, 1, 80, 3600) === 0);
    const sk = strengthKcal(60, 80);
    ok('pesas 60 min 80 kg → ~300 kcal (rango 200-400)', sk.kcal === 300 && sk.low === 200 && sk.high === 400, sk);
    ok('pesas 45 min 62 kg → redondeado de a 10', strengthKcal(45, 62).kcal === 170, strengthKcal(45, 62));
    ok('pesas sin duración o sin peso → null', strengthKcal(0, 80) === null && strengthKcal(60, 0) === null && strengthKcal() === null);
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

console.log('Fecha local (zona horaria del teléfono)');
{
    // Node cambia de zona al cambiar process.env.TZ: se prueba la app "en" varios países.
    const prevTz = process.env.TZ;
    const zones = ['America/Argentina/Buenos_Aires', 'Europe/Madrid', 'Atlantic/Canary', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'];
    const bad = [];
    for (const tz of zones) {
        process.env.TZ = tz;
        const early = new Date(2026, 10, 2, 0, 30), late = new Date(2026, 10, 2, 23, 30);
        if (localDateStr(early) !== '2026-11-02' || localDateStr(late) !== '2026-11-02') bad.push(tz);
    }
    ok('00:30 y 23:30 locales caen en el mismo día en ' + zones.length + ' zonas (incl. España, Canarias, UTC+14 y UTC-11)', bad.length === 0, bad);
    process.env.TZ = 'Europe/Madrid';
    ok('el error que corrige: en Madrid, 00:30 local con toISOString daba el día anterior', new Date(2026, 10, 2, 0, 30).toISOString().slice(0, 10) === '2026-11-01');
    process.env.TZ = 'America/Argentina/Buenos_Aires';
    ok('y en Argentina, 22:00 local con toISOString daba el día siguiente', new Date(2026, 10, 2, 22, 0).toISOString().slice(0, 10) === '2026-11-03' && localDateStr(new Date(2026, 10, 2, 22, 0)) === '2026-11-02');
    ok('fecha inválida → vacío; sin argumento → hoy', localDateStr('nada') === '' && /^\d{4}-\d{2}-\d{2}$/.test(localDateStr()));
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
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

console.log('Ajuste por rendimiento (fatiga, progreso y volumen)');
{
    const today = '2026-11-20';
    const day = (n) => { const d = new Date(Date.UTC(2026, 10, 20 - n)); return d.toISOString().slice(0, 10); };
    const S = (n, exs) => ({ date: day(n), exercises: Object.entries(exs).map(([exercise, [kg, reps]]) => ({ exercise, sets: [{ kg, reps }, { kg, reps: reps - 1 }] })) });
    const hist = [
        S(1, { 'Press Banca Plano': [92.5, 5], 'Sentadilla': [105, 5], 'Remo Barra': [52.5, 10], 'Dominadas': [0, 8] }),
        S(3, { 'Press Banca Plano': [92.5, 5], 'Remo Barra': [60, 10], 'Dominadas': [0, 8] }),
        S(8, { 'Sentadilla': [102.5, 5] }),
        S(10, { 'Sentadilla': [100, 5] }),
        S(15, { 'Press Banca Plano': [100, 5], 'Remo Barra': [60, 10], 'Dominadas': [0, 10] }),
        S(18, { 'Press Banca Plano': [100, 5], 'Remo Barra': [60, 10], 'Dominadas': [0, 10] }),
        S(30, { 'Sentadilla': [100, 5] })
    ];
    const sig = performanceSignals(hist, today);
    ok('registro constante (2+ sesiones en cada una de las 3 semanas) → hay señales', sig.dataOk === true);
    ok('fatiga: 2 sesiones seguidas ≥5 % por debajo de la mejor marca (con kg y con peso corporal)', sig.fatigued.includes('Press Banca Plano') && sig.fatigued.includes('Dominadas'), sig);
    ok('una sola sesión mala no es fatiga', !sig.fatigued.includes('Remo Barra'), sig);
    ok('progreso: +5 % contra hace 3-5 semanas', sig.progressing.includes('Sentadilla') && !sig.fatigued.includes('Sentadilla'), sig);
    const few = performanceSignals(hist.filter((s) => s.date !== day(8)), today);
    ok('sin registro constante (1 sesión en una semana) → sin señales', few.dataOk === false && few.fatigued.length === 0 && few.progressing.length === 0);
    ok('rendimiento: 1RM estimado de la mejor serie; con 0 kg, reps', Math.round(sessionPerf([{ kg: 100, reps: 5 }, { kg: 90, reps: 8 }]).value) === 117 && sessionPerf([{ kg: 0, reps: 12 }]).value === 12 && sessionPerf([]) === null);

    const plan = () => [
        { exercises: [{ name: 'Press Banca Plano', sets: 4 }, { name: 'Aperturas Pec Deck', sets: 3 }, { name: 'Press Francés', sets: 3 }] },
        { exercises: [{ name: 'Press Inclinado', sets: 4 }, { name: 'Cruces Polea', sets: 3 }] }
    ];
    const p1 = plan();
    ok('bajar 2 series de pecho: primero los accesorios', adjustMuscleVolume(p1, 'chest', -2) === 2 && p1[0].exercises[1].sets === 2 && p1[1].exercises[1].sets === 2 && p1[0].exercises[0].sets === 4, p1);
    ok('nunca por debajo de 2 series por ejercicio', adjustMuscleVolume(p1, 'chest', -10) === 4 && p1.every((d) => d.exercises.every((e) => e.sets >= 2)));
    ok('no toca ejercicios donde el músculo es secundario', p1[0].exercises[2].sets === 3);
    const p2 = plan(), before = planMuscleSets(p2).chest;
    ok('subir respeta el tope semanal', adjustMuscleVolume(p2, 'chest', 2, before + 1) === 1 && planMuscleSets(p2).chest === before + 1, planMuscleSets(p2).chest);
}

console.log('Meta semanal de cardio');
{
    const S = (date, min) => ({ date, duration: min * 60 });
    const today = '2026-11-04';   // miércoles; la semana arrancó el lunes 2/11
    const none = cardioWeek([], today);
    ok('sin historial: meta 150, faltan 150, quedan 5 días (mié → dom)', none.target === 150 && none.minutes === 0 && none.remaining === 150 && none.daysLeft === 5 && !none.done);
    const wk = cardioWeek([S('2026-11-02', 30), S('2026-11-04', 45.4), S('2026-11-01', 60), S('2026-11-05', 99), { date: '2026-11-03' }], today);
    ok('cuenta solo esta semana (lun-dom), sin días futuros ni sesiones sin duración', wk.minutes === 75 && wk.remaining === 75);
    const prev = (min) => ['2026-10-26', '2026-10-19', '2026-10-12', '2026-10-05'].map((d) => S(d, min));
    ok('sube 10 % sobre el promedio de 4 semanas (200 → 220)', cardioWeek(prev(200), today).target === 220 && cardioWeek(prev(200), today).avgPrev === 200);
    ok('piso 150 y techo 300', cardioWeek(prev(100), today).target === 150 && cardioWeek(prev(400), today).target === 300);
    ok('semanas sin cardio cuentan como 0 en el promedio', cardioWeek([S('2026-10-26', 400)], today).target === 150);
    ok('meta cumplida', cardioWeek([S('2026-11-03', 160)], today).done === true);
    ok('lunes quedan 7 días; domingo, 1', cardioWeek([], '2026-11-02').daysLeft === 7 && cardioWeek([], '2026-11-08').daysLeft === 1);
    // Minutos equivalentes (OMS): vigoroso vale doble, liviano no cuenta
    const W = calc.cardioMinuteWeight;
    ok('peso del minuto: <3 MET 0, 3-5,9 MET 1, ≥6 MET 2', W(2.3) === 0 && W(3) === 1 && W(5.9) === 1 && W(6) === 2 && W(9.3) === 2 && W() === 0);
    const M = (date, min, met) => ({ date, duration: min * 60, met });
    const eq = cardioWeek([M('2026-11-02', 30, 9.3), M('2026-11-03', 40, 3.8), M('2026-11-04', 60, 2.3)], today, { weightOf: (x) => W(x.met) });
    ok('30 min corriendo (×2) + 40 caminando (×1) + 60 de yoga (×0) = 100 min equivalentes', eq.minutes === 100 && eq.remaining === 50, eq);
    ok('sin weightOf, todo vale 1 (como antes)', cardioWeek([M('2026-11-02', 30, 9.3)], today).minutes === 30);
}

console.log('Cardio de todos los días (para no contarlo dos veces con el gasto real)');
{
    const avg = calc.cardioDailyAvg;
    const C = (date, calories) => ({ date, calories });
    ok('promedio de los 21 días anteriores, días sin cardio = 0 (2 × 420 / 21 = 40)', avg([C('2026-11-01', 420), C('2026-10-20', 420)], '2026-11-04', 21) === 40);
    ok('no cuenta hoy ni lo anterior a la ventana', avg([C('2026-11-04', 900), C('2026-10-13', 900)], '2026-11-04', 21) === 0);
    ok('sin sesiones o sin fecha → 0', avg([], '2026-11-04') === 0 && avg(null, '2026-11-04') === 0 && avg([C('2026-11-01', 100)]) === 0);
    const u = { weight: 70, height: 175, age: 30, sex: 'male', goal: 'fat_loss', days: 4, tdeeAdaptive: 2500 };
    const normal = calcDailyBalance(u, 2000, 400);
    const fixed = calcDailyBalance(u, 2000, 400, 2500 - 150);
    ok('balance: sin mantenimiento aparte usa el gasto real (2500)', normal.maintenance === 2500);
    ok('balance: con el mantenimiento sin el cardio de siempre (2350), el cardio de hoy no se cuenta dos veces', fixed.maintenance === 2350 && fixed.diff === 2000 - 400 - 2350, fixed);
    ok('balance: mantenimiento 0 o vacío → el de siempre', calcDailyBalance(u, 2000, 0, 0).maintenance === 2500);
}

console.log('Cardio: velocidad, esfuerzo, carga, totales y récords');
{
    const sp = calc.cardioMetFromSpeed;
    ok('correr a 9,9 km/h → 9,3 MET (Compendio 12050); entre puntos interpola', sp('running', 9.9) === 9.3 && sp('running', 10.35) === 9.9, sp('running', 10.35));
    ok('extremos: no se pasa del primero ni del último punto', sp('running', 3) === 6.5 && sp('running', 40) === 23.0 && sp('walking', 2) === 3.0 && sp('cycling', 50) === 16.8);
    ok('caminar 5 km/h → 3,8; bici 20,9 km/h → 8,0', sp('walking', 5) === 3.8 && sp('cycling', 20.9) === 8.0);
    ok('deporte sin tabla o sin velocidad → null', sp('boxing', 10) === null && sp('running', 0) === null && sp('running') === null);
    const R = calc.sessionRpe, L = calc.sessionLoad;
    ok('esfuerzo: el anotado; si no, por nivel (3/5/7) o por MET', R({ rpe: 8 }) === 8 && R({ level: 0 }) === 3 && R({ level: 2 }) === 7 && R({ met: 2.5 }) === 3 && R({ met: 9.3 }) === 7 && R({}) === 5 && R({ rpe: 11, level: 1 }) === 5);
    ok('carga = esfuerzo × minutos (6 × 45 = 270)', L({ rpe: 6, duration: 2700 }) === 270);
    const S = (date, min, extra) => Object.assign({ date, duration: min * 60, sport: 'running' }, extra || {});
    const list = [S('2026-11-16', 30, { distance: 5, calories: 300, rpe: 6 }), S('2026-11-18', 45, { distance: 7.2, calories: 450, rpe: 5 }), S('2026-11-10', 60, { calories: 500, level: 1 }), S('2026-10-02', 20, { calories: 100 })];
    const tot = calc.cardioTotals(list, '2026-11-16', '2026-11-22');
    ok('totales de la semana: 2 sesiones, 75 min, 12,2 km, 750 kcal, carga 405', tot.count === 2 && tot.minutes === 75 && tot.km === 12.2 && tot.kcal === 750 && tot.load === 405, tot);
    const wk = calc.cardioWeeks(list, '2026-11-18', 3);
    ok('semanas: de la más vieja a la actual, empiezan el lunes', wk.length === 3 && wk[2].start === '2026-11-16' && wk[1].start === '2026-11-09' && wk[2].minutes === 75 && wk[1].minutes === 60 && wk[0].minutes === 0, wk.map((x) => x.start + ':' + x.minutes));
    const mo = calc.cardioMonths(list, '2026-11-18', 3);
    ok('meses: sep, oct, nov 2026 (cruza el año bien)', mo.map((x) => x.month).join() === '2026-09,2026-10,2026-11' && mo[1].minutes === 20 && mo[2].minutes === 135 && calc.cardioMonths([], '2026-01-10', 2)[0].month === '2025-12');
    const trendList = [S('2026-11-17', 60, { rpe: 7 }), S('2026-11-08', 40, { rpe: 5 }), S('2026-11-01', 40, { rpe: 5 }), S('2026-10-25', 40, { rpe: 5 })];
    const tr = calc.cardioLoadTrend(trendList, '2026-11-18');
    ok('carga de 7 días (420) contra el promedio de las 4 semanas anteriores (600 / 4 = 150)', tr.acute === 420 && tr.avg === 150 && tr.weeks === 3 && tr.pct === 180, tr);
    ok('sin historia previa no hay porcentaje', calc.cardioLoadTrend([S('2026-11-17', 30)], '2026-11-18').pct === null);
    const rec = calc.cardioRecords([S('2026-11-01', 30, { distance: 5 }), S('2026-11-08', 52, { distance: 10 }), S('2026-11-12', 60, { distance: 10.5 }), S('2026-11-15', 25, { distance: 5 }), { date: '2026-11-15', duration: 3600, sport: 'cycling', distance: 25 }, { date: '2026-11-16', duration: 1800, sport: 'boxing' }]);
    ok('récords de correr: más larga 10,5 km y 60 min; mejor ritmo 5 km 5:00 (25 min); 10 km 5:12', rec.running.km.value === 10.5 && rec.running.min.value === 60 && rec.running.pace5.value === 5 && rec.running.pace5.date === '2026-11-15' && rec.running.pace10.value === 5.2, rec.running);
    ok('bici: velocidad en 20 km o más (25 km/h); boxeo solo la sesión más larga', rec.cycling.speed20.value === 25 && rec.boxing.min.value === 30 && !rec.boxing.km);
}

console.log('Planes de running guiados');
{
    const P = calc.RUN_PLANS, runMin = (x) => calc.runSessionRunSec(x) / 60, totMin = (x) => calc.runSessionSec(x) / 60;
    ok('dos planes de 8 semanas y 3 sesiones por semana', ['5k', '10k'].every((id) => P[id].weeks.length === 8 && P[id].weeks.every((w) => w.length === 3)));
    const r5 = P['5k'].weeks.map((w) => runMin(w[0]));
    ok('0 a 5 km: el trote va de 8 a 30 min', r5[0] === 8 && r5[7] === 30, r5);
    ok('0 a 5 km: nunca sube más de 25 % por semana (Nielsen 2014: >30 % = más lesiones)', r5.every((m, i) => i === 0 || m <= r5[i - 1] * 1.25), r5);
    ok('0 a 5 km: la última semana son 30 min seguidos (un solo tramo de trote)', calc.runSegments(P['5k'].weeks[7][0]).filter((x) => x[0] !== 'walk').length === 1);
    const tw10 = P['10k'].weeks.map((w) => w.reduce((a, x) => a + totMin(x), 0));
    ok('5 a 10 km: el volumen semanal nunca sube más de 30 % y la semana 4 es más liviana', tw10.every((m, i) => i === 0 || m <= tw10[i - 1] * 1.3) && tw10[3] < tw10[2], tw10);
    ok('5 a 10 km: la larga llega a 65 min', totMin(P['10k'].weeks[7][2]) === 65);
    const easyShare = P['10k'].weeks.flat().reduce((a, x) => a + calc.runSegments(x).filter((g) => g[0] === 'easy' || g[0] === 'jog').reduce((b, g) => b + g[1], 0), 0) / P['10k'].weeks.flat().reduce((a, x) => a + calc.runSessionSec(x), 0);
    ok('5 a 10 km: al menos 80 % del tiempo es suave', easyShare >= 0.8, Math.round(easyShare * 100));
    const s1 = P['5k'].weeks[0][0], segs = calc.runSegments(s1);
    ok('semana 1: 5 min caminando + 8 × (1 trote + 1:30 caminata) + 5 min = 30 min y 18 tramos', segs.length === 18 && calc.runSessionSec(s1) === 1800 && segs[1][0] === 'jog');
    ok('MET de la sesión ponderado por tiempo (semana 1: 8 min a 7,5 y 22 a 3,8 → 4,8)', calc.runSessionMet(s1) === 4.8, calc.runSessionMet(s1));
    const at = calc.runSegmentAt;
    ok('tramo actual: a los 0 s el primero (le quedan 300 s); a los 300 s el segundo; a los 359 s le queda 1 s', at(segs, 0).idx === 0 && at(segs, 0).left === 300 && at(segs, 300).idx === 1 && at(segs, 359).left === 1);
    ok('al pasar el total: terminado', at(segs, 1800).done && at(segs, 99999).idx === 18 && !at(segs, 1799).done);
    ok('próxima sesión: la primera sin hacer; null al terminar; plan desconocido null', JSON.stringify(calc.runPlanNext('5k', [])) === '{"week":1,"day":1}' && JSON.stringify(calc.runPlanNext('5k', ['1-1', '1-3'])) === '{"week":1,"day":2}' && calc.runPlanNext('5k', Array.from({ length: 24 }, (_, i) => (Math.floor(i / 3) + 1) + '-' + (i % 3 + 1))) === null && calc.runPlanNext('x', []) === null);
    ok('sesión por semana y día; fuera de rango null', calc.runPlanSession('10k', 6, 2).block[0][0] === 'tempo' && calc.runPlanSession('10k', 9, 1) === null);
}

console.log('Importar entrenamientos (GPX / TCX)');
{
    const T = calc.trackSummary;
    // 11 puntos cada 10 s, 0,0005° de latitud (~55,6 m) por tramo → ~556 m en 100 s; luego una parada de 60 s
    const base = Date.UTC(2026, 10, 18, 9, 0, 0);
    const run = Array.from({ length: 11 }, (_, i) => ({ t: base + i * 10000, lat: -34.6 + i * 0.0005, lon: -58.4, hr: 140 + i }));
    const stop = run.concat([{ t: base + 160000, lat: -34.6 + 10 * 0.0005, lon: -58.4, hr: 120 }]);
    const r = T(stop);
    ok('distancia por GPS (~0,56 km), tiempo total 160 s y en movimiento 100 s (la parada no cuenta)', r.km === 0.56 && r.elapsedSec === 160 && r.movingSec === 100, r);
    ok('pulso promedio ponderado (solo tramos de hasta 30 s) y máximo', r.hrAvg === 146 && r.hrMax === 150, r);
    const tcx = [{ t: base, d: 0, hr: 150 }, { t: base + 5000, d: 15 }, { t: base + 10000, d: 30 }];
    ok('con la distancia del reloj (TCX) la usa en vez del GPS: 30 m', T(tcx).km === 0.03 && T(tcx).movingSec === 10);
    const tread = [{ t: base, hr: 130 }, { t: base + 20000, hr: 132 }, { t: base + 40000, hr: 134 }];
    ok('sin posición ni distancia (cinta): todo el tiempo cuenta como movimiento', T(tread).km === 0 && T(tread).movingSec === 40 && T(tread).hrAvg === 133);
    ok('menos de 2 puntos con hora → null; desordenados se ordenan', T([{ t: base }]) === null && T([]) === null && T(run.slice().reverse()).movingSec === 100);
    const S = calc.importSport;
    ok('deporte por el tipo del archivo (Strava 9/1/10, TCX Running/Biking)', S('9') === 'running' && S('Running') === 'running' && S('1') === 'cycling' && S('Biking') === 'cycling' && S('10') === 'walking' && S('hiking') === 'hiking' && S('Swim') === 'swimming');
    ok('sin tipo, por la velocidad: 25 km/h bici, 10 correr, 5 caminar', S('', 25) === 'cycling' && S('Other', 10) === 'running' && S(null, 5) === 'walking');
}

console.log('Oracle: diagnóstico calculado por la app');
{
    const OF = calc.oracleFindings;
    const today = '2026-11-19';   // jueves
    const day = (n) => { const d = new Date(Date.UTC(2026, 10, 19 - n)); return d.toISOString().slice(0, 10); };
    const S = (n, list) => ({ date: day(n), exercises: list.map(([exercise, kg, reps, sets]) => ({ exercise, sets: Array.from({ length: sets || 3 }, () => ({ kg, reps })) })) });
    const U = (extra) => Object.assign({ weight: 80, height: 178, age: 30, sex: 'M', goal: 'muscle', days: 3, level: 'intermediate' }, extra || {});
    const codes = (f) => f.map((x) => x.code);
    // Constancia: plan de 4 días, 1 por semana durante 5 semanas
    const few = [3, 10, 17, 24, 31].map((n) => S(n, [['Sentadilla', 100, 5]]));
    ok('constancia baja: 4 de 16 días planeados en 4 semanas completas', OF({ user: U({ days: 4 }), sessions: few, today }).some((f) => f.code === 'adherence_low' && f.facts.done === 4 && f.facts.planned === 16));
    ok('una persona nueva (1 semana) no se marca como poco constante', !codes(OF({ user: U(), sessions: [S(2, [['Sentadilla', 60, 8]]), S(4, [['Sentadilla', 60, 8]]), S(6, [['Sentadilla', 60, 8]])], today })).includes('adherence_low'));
    // Fatiga: dos ejercicios con las 2 últimas sesiones 10 % abajo de su mejor marca
    const tired = [];
    for (let n = 34; n >= 1; n -= 3) { const late = n <= 4; tired.push(S(n, [['Press Banca', late ? 90 : 100, 5], ['Sentadilla', late ? 117 : 130, 5]])); }
    const fT = OF({ user: U({ days: 4 }), sessions: tired, today });
    ok('fatiga en 2 ejercicios → aviso de descarga (y no "estancado")', fT.some((f) => f.code === 'fatigue' && f.facts.exs.length === 2) && !codes(fT).includes('stalled'), codes(fT));
    // Mayor de 60 que sube rápido
    const fast = [26, 23, 19, 16, 12, 9, 5, 2].map((n, i) => S(n, [['Sentadilla', 40 + i * 3, 8]]));
    ok('mayor de 60 subiendo más de 15 % → prudencia (con el ejercicio y el %)', OF({ user: U({ age: 63, goal: 'strength' }), sessions: fast, today }).some((f) => f.code === 'fast_load' && f.facts.ex === 'Sentadilla' && f.facts.pct >= 15));
    ok('la misma suba a los 30 años no lleva ese aviso (y cuenta como progreso)', !codes(OF({ user: U({ goal: 'strength' }), sessions: fast, today })).includes('fast_load') && codes(OF({ user: U({ goal: 'strength' }), sessions: fast, today })).includes('progress'));
    // Comida: se promedian solo los días registrados (≥ 800 kcal), los 7 anteriores a hoy
    const u = U(), maint = calc.maintenanceOf(u), food = (kcal, prot, days) => Array.from({ length: days }, (_, i) => ({ date: day(i + 1), kcal, protein: prot }));
    ok('2 días registrados → "faltan días", nunca "comés 860 kcal"', JSON.stringify(OF({ user: u, sessions: [], food: food(2600, 150, 2), today }).filter((f) => f.code.startsWith('food'))) === '[{"code":"food_incomplete","sev":"info","facts":{"days":2}}]');
    ok('sin comida registrada nunca → sugerir registrar', codes(OF({ user: u, sessions: [], food: [], today })).includes('food_none'));
    ok('si no quiere usar la nutrición, no se habla de comida', !OF({ user: u, sessions: [], food: [], today, wantsNutrition: false }).length);
    const fl = U({ goal: 'fat_loss' }), mFl = calc.maintenanceOf(fl);
    ok('bajar grasa con déficit de 450 → "déficit bien", no un problema', codes(OF({ user: fl, sessions: [], food: food(mFl - 450, 170, 6), today })).includes('deficit_ok'));
    ok('bajar grasa comiendo por encima del mantenimiento → "no hay déficit" con mantenimiento y objetivo', OF({ user: fl, sessions: [], food: food(mFl + 300, 170, 6), today }).some((f) => f.code === 'no_deficit' && f.facts.maint === mFl && f.facts.target === calc.calcMacros(fl).targetCals));
    ok('ganar músculo comiendo 600 por debajo → aviso con el objetivo', OF({ user: u, sessions: [], food: food(maint - 600, 170, 6), today }).some((f) => f.code === 'below_maint_gain' && f.facts.target === calc.calcMacros(u).targetCals));
    ok('ganar músculo con superávit chico → bien', codes(OF({ user: u, sessions: [], food: food(maint + 300, 170, 6), today })).includes('surplus_ok'));
    ok('1.000 kcal por debajo del mantenimiento → déficit demasiado grande', codes(OF({ user: fl, sessions: [], food: food(mFl - 1100, 170, 6), today })).includes('deficit_too_big'));
    const woman = U({ goal: 'fat_loss', sex: 'F', weight: 58, height: 162, age: 35 });
    ok('mujer con 1.150 kcal (piso 1.200, la app guarda el sexo como "F") → déficit demasiado grande; con 1.300 no', calc.maintenanceOf(woman) - 1150 < 1000 && codes(OF({ user: woman, sessions: [], food: food(1150, 100, 6), today })).includes('deficit_too_big') && !codes(OF({ user: woman, sessions: [], food: food(1300, 100, 6), today })).includes('deficit_too_big'), calc.maintenanceOf(woman));
    ok('proteína baja: 95 g con 80 kg (1,2 g/kg) contra la meta de la app', OF({ user: u, sessions: [], food: food(maint + 200, 95, 6), today }).some((f) => f.code === 'protein_low' && f.facts.perKg === 1.2 && f.facts.target === calc.calcMacros(u).protein));
    // Volumen y desbalance (por semana, con los músculos de la app)
    const heavy = [];
    for (let n = 27; n >= 0; n -= 2) heavy.push(S(n, [['Press Banca', 80, 8, 5], ['Aperturas', 20, 12, 4]]));
    ok('más de 22 series por semana de pecho → volumen alto', OF({ user: u, sessions: heavy, today }).some((f) => f.code === 'volume_high' && f.facts.muscles.includes('chest')));
    const push = [];
    for (let n = 27; n >= 0; n -= 3) push.push(S(n, [['Press Banca', 80, 8, 4], ['Press Inclinado', 60, 8, 3], ['Remo con Barra', 60, 8, 2]]));
    const fP = OF({ user: u, sessions: push, today });
    ok('pecho ~16 por semana contra espalda ~6 → desbalance con las series por semana', fP.some((f) => f.code === 'imbalance' && f.facts.a === 'chest' && f.facts.b === 'lats' && f.facts.aSets >= 14 && f.facts.bSets <= 7), fP);
    // Bajar grasa: con déficit, los ejercicios quietos son "mantener la fuerza" (bueno), no "estancado"
    const flatS = [26, 22, 19, 15, 12, 8, 5, 1].map((n) => S(n, [['Sentadilla', 80, 6], ['Press Banca', 55, 6]]));
    const fH = OF({ user: fl, sessions: flatS, food: food(mFl - 450, 170, 6), today });
    ok('bajar grasa con déficit y la fuerza quieta → "mantenés la fuerza", no "estancado"', codes(fH).includes('holding_strength') && !codes(fH).includes('stalled'), codes(fH));
    ok('ganar músculo con la fuerza quieta → estancado', codes(OF({ user: u, sessions: flatS, food: food(maint + 200, 170, 6), today })).includes('stalled'));
    ok('accesorios con el mismo peso mientras los básicos suben → no es "estancado"', !codes(OF({ user: u, sessions: [26, 22, 19, 15, 12, 8, 5, 1].map((n, i) => S(n, [['Sentadilla', 80 + i * 2.5, 6], ['Prensa', 150, 10], ['Curl con Barra', 25, 10]])), food: food(maint + 200, 170, 6), today })).includes('stalled'));
    // Peso de tendencia al bajar grasa
    const wts = (k0, perDay) => Array.from({ length: 22 }, (_, i) => ({ date: day(21 - i), kg: k0 + perDay * i }));
    ok('bajar grasa: −0,5 kg por semana → bien; −1,5 kg → demasiado rápido', codes(OF({ user: fl, sessions: [], weights: wts(85, -0.5 / 7), today, wantsNutrition: false })).includes('loss_ok') && codes(OF({ user: fl, sessions: [], weights: wts(85, -1.5 / 7), today, wantsNutrition: false })).includes('loss_fast'));
    // Cardio de la semana pasada (lunes 9 a domingo 15)
    const cardio = [{ date: '2026-11-10', duration: 3600, met: 9.3 }, { date: '2026-11-12', duration: 1800, met: 9.3 }];
    ok('cardio de la semana pasada: corto o cumplido según la meta', codes(OF({ user: fl, sessions: [], cardio: cardio.slice(1), today, wantsNutrition: false })).includes('cardio_short') && codes(OF({ user: fl, sessions: [], cardio: cardio.concat([{ date: '2026-11-14', duration: 1800, met: 9.3 }]), today, wantsNutrition: false })).includes('cardio_done'));
    // Selección: como mucho 5, lo importante primero y 2 buenas como máximo
    const many = OF({ user: U({ days: 4, age: 64, goal: 'muscle' }), sessions: few.concat(fast), food: food(maint - 600, 90, 5), today });
    const firstGood = many.findIndex((f) => f.sev === 'good');
    ok('como mucho 5 hallazgos, los avisos antes que lo bueno, y no más de 2 buenos', many.length <= 5 && many.filter((f) => f.sev === 'good').length <= 2 && (firstGood === -1 || firstGood >= many.filter((f) => f.sev !== 'good').length), codes(many));
    ok('sin fecha de hoy → nada', OF({ user: u, sessions: few }).length === 0);
    ok('al mayor de 60 que sube rápido no se le festeja la misma suba como progreso', !codes(OF({ user: U({ age: 63, goal: 'strength' }), sessions: fast, today })).includes('progress'));
    const goodS = [26, 22, 19, 15, 12, 8, 5, 1].map((n, i) => S(n, [['Press Banca', 55, 6], ['Remo con Barra', 60 + i * 0.8, 8], ['Peso Muerto', 100, 5]]));
    const goodC = [{ date: day(6), duration: 2700, met: 8 }, { date: day(9), duration: 2700, met: 8 }];
    const okAll = OF({ user: U({ goal: 'fat_loss', days: 2 }), sessions: goodS, cardio: goodC, food: food(mFl - 450, 170, 6), today });
    ok('si todo va bien entran hasta 3 cosas buenas (progreso, mantener la fuerza y el déficit)', okAll.every((f) => f.sev === 'good') && okAll.length === 3 && codes(okAll).includes('deficit_ok'), codes(okAll));
    const endu = [26, 22, 19, 15, 12, 8, 5, 1].map((n, i) => S(n, [['Sentadilla', 70, 6], ['Peso Muerto', 90 + (i >= 4 ? 2 : 0), 5]]));
    ok('resistencia: dos ejercicios que se mueven menos de 3 % → "mantenés la fuerza"', codes(OF({ user: U({ goal: 'endurance' }), sessions: endu, today, wantsNutrition: false })).includes('holding_strength'));
}

console.log('Frecuencia cardíaca máxima (Tanaka)');
{
    const mx = calc.maxHrEstimate;
    ok('208 − 0,7 × edad: 20 → 194, 40 → 180, 60 → 166', mx(20) === 194 && mx(40) === 180 && mx(60) === 166);
    ok('sin edad usa 30 años (187)', mx() === 187 && mx(0) === 187);
}

console.log('Registro del período');
{
    const cs = calc.cycleStatus;
    const today = '2026-11-04';
    ok('sin fechas → null', cs([], today) === null && cs(null, today) === null);
    const one = cs(['2026-10-20'], today);
    ok('una sola fecha: días desde el inicio, sin promedio ni próxima', one.daysSince === 15 && one.avg === null && one.next === null && !one.missing && !one.long);
    const reg = cs(['2026-08-14', '2026-09-11', '2026-10-09', '2026-10-09', 'basura', '2026-11-20'], today);
    ok('ciclos de 28 días: promedio 28, próxima el 6/11 (ignora duplicados, basura y fechas futuras)', reg.avg === 28 && reg.last === '2026-10-09' && reg.next === '2026-11-06' && reg.lastLen === 28, reg);
    const miss = cs(['2026-06-01', '2026-06-29'], today);
    ok('90 días o más sin período → missing', miss.missing === true && miss.daysSince === 128);
    ok('89 días todavía no', cs(['2026-08-07'], today).missing === false && cs(['2026-08-06'], today).missing === true);
    const lng = cs(['2026-08-20', '2026-10-01'], today);
    ok('último ciclo de 42 días → long (más de 35)', lng.long === true && lng.lastLen === 42);
    const gap = cs(['2026-05-01', '2026-05-29', '2026-10-01'], today);
    ok('un hueco de 125 días no entra al promedio ni cuenta como ciclo largo', gap.avg === 28 && gap.long === false && gap.lastLen === 125, gap);
}

console.log('\nCarga sugerida (auditoría de progresión, nov 2026)');
{
    const { exerciseGear, workingWeight, nextLoad, pushLoad, dumbbellGrid, seenStep } = calc;
    const G = { 'Sentadilla': 'barbell', 'Press Banca Plano': 'barbell', 'Remo Barra': 'barbell', 'Press Francés': 'barbell', 'Curl Bíceps Barra': 'barbell',
        'Hack Squat': 'plates', 'Prensa Piernas': 'plates', 'Press Banca Mancuernas': 'dumbbell', 'Sentadilla Búlgara': 'dumbbell', 'Elevaciones Laterales': 'dumbbell',
        'Remo Polea Baja': 'machine', 'Jalón Polea': 'machine', 'Extensión Cuádriceps': 'machine', 'Crunch en Polea': 'machine', 'Pantorrilla Pie': 'machine',
        'Dominadas': 'bodyweight', 'Fondos Paralelas': 'bodyweight', 'Crunch Clásico': 'bodyweight', 'Curl Bíceps': 'other', 'Encogimientos': 'other' };
    const bad = Object.entries(G).filter(([n, g]) => exerciseGear(n) !== g).map(([n]) => n + '=' + exerciseGear(n));
    ok('tipo de equipo por nombre (barra, discos, mancuernas, máquina, con tu peso)', bad.length === 0, bad);
    const S = (kg, reps) => ({ kg, reps });
    ok('peso de trabajo: ignora el calentamiento y el tipeo', workingWeight([S(20, 10), S(60, 10), S(60, 10), S(60, 10)]) === 60 && workingWeight([S(60, 10), S(600, 10), S(60, 10)]) === 60 && workingWeight([S(60, 10), S(600, 10)]) === 60 && workingWeight([S(50, 10), S(55, 10), S(60, 10)]) === 60);
    const today = '2026-11-21';
    const hist = (name, sets, date = '2026-11-18', day) => [{ date, day, exercises: [{ exercise: name, sets: sets.map(([kg, reps]) => S(kg, reps)) }] }];
    const top3 = (kg, r = 10) => [[kg, r], [kg, r], [kg, r]];
    const nl = (name, reps, sessions, o = {}) => nextLoad(sessions, { name, reps }, Object.assign({ today, unit: 'kg' }, o));
    // Pesos que existen
    let r = nl('Press Banca Plano', '8-10', hist('Press Banca Plano', top3(60)));
    ok('barra: 60 → 62,5', r.kind === 'up' && r.kg === 62.5 && r.inc === 2.5, r);
    r = nl('Remo Polea Baja', '8-10', hist('Remo Polea Baja', top3(60)));
    ok('máquina: 60 → 65 (no 61,25)', r.kind === 'up' && r.kg === 65, r);
    r = nl('Extensión Cuádriceps', '10-12', hist('Extensión Cuádriceps', top3(40, 12)));
    ok('máquina liviana: el salto de 5 es > 10 % → primero 14 reps', r.kind === 'extend' && r.kg === 40 && r.targetReps === 14, r);
    r = nl('Extensión Cuádriceps', '10-12', hist('Extensión Cuádriceps', top3(40, 14)));
    ok('… y con 14 reps en todas → 45', r.kind === 'up' && r.kg === 45, r);
    r = nl('Press Banca Mancuernas', '8-10', hist('Press Banca Mancuernas', top3(22)));
    ok('mancuernas: 22 → 24 (no 24,5)', r.kind === 'up' && r.kg === 24, r);
    r = nl('Press Banca Mancuernas', '8-10', hist('Press Banca Mancuernas', top3(27.5)), { dbGrid: 2.5 });
    ok('mancuernas de a 2,5: 27,5 → 30', r.kind === 'up' && r.kg === 30, r);
    r = nl('Curl Martillo', '10-12', hist('Curl Martillo', top3(26, 12)), { dbGrid: 2.5 });
    ok('mancuernas: el peso que usa manda sobre el escalón general (26 → 28)', r.kind === 'up' && r.kg === 28, r);
    r = nl('Elevaciones Laterales', '10-12', hist('Elevaciones Laterales', top3(11, 12)), { dbGrid: 2.5 });
    ok('mancuernas de a 1 kg: 11 → 12', r.kind === 'up' && r.kg === 12, r);
    r = nl('Elevaciones Laterales', '10-12', hist('Elevaciones Laterales', top3(9, 14)));
    ok('mancuernas livianas: 9 → 10', r.kind === 'up' && r.kg === 10, r);
    r = nl('Curl Bíceps Barra', '8-10', hist('Curl Bíceps Barra', top3(30)));
    ok('barra de curl: 30 → 32,5 (no 31,25)', r.kind === 'up' && r.kg === 32.5, r);
    const machHist = [...hist('Jalón Polea', top3(52), '2026-11-18'), ...hist('Jalón Polea', top3(48), '2026-11-11')];
    r = nl('Jalón Polea', '8-10', machHist);
    ok('máquina: usa el salto que ya usaste (48 → 52 → 56)', r.kind === 'up' && r.kg === 56, r);
    ok('escalón de mancuernas deducido del registro', dumbbellGrid(hist('Curl Mancuernas', top3(12.5))) === 2.5 && dumbbellGrid(hist('Curl Mancuernas', top3(14))) === 2 && dumbbellGrid([]) === 2 && seenStep(machHist, 'Jalón Polea', 'kg') === 4);
    r = nl('Press Banca Plano', '8-10', hist('Press Banca Plano', top3(135)), { unit: 'lbs' });
    ok('libras: 135 → 140', r.kind === 'up' && r.kg === 140, r);
    r = nl('Elevaciones Laterales', '10-12', hist('Elevaciones Laterales', top3(24.5, 14)), { unit: 'lbs' });
    ok('mancuernas en libras fuera de la grilla (24,5 lb): la siguiente es 30, no 25', r.kind === 'up' && r.kg === 30, r);
    // Mismo día del plan
    const hl = [...hist('Sentadilla', [[85, 8], [85, 8], [85, 8]], '2026-11-19', 'LOWER B'), ...hist('Sentadilla', [[100, 6], [100, 6], [100, 6], [100, 6]], '2026-11-17', 'LOWER A')];
    r = nl('Sentadilla', '4-6', hl, { day: 'LOWER A' });
    ok('día pesado: se compara con el pesado (100 → 102,5), no con el liviano', r.kind === 'up' && r.kg === 102.5, r);
    r = nl('Sentadilla', '6-8', hist('Sentadilla', [[100, 5], [100, 5]], '2026-11-17', 'LOWER A'), { day: 'LOWER B' });
    ok('día liviano sin historial propio: no sugiere el peso del pesado', r === null, r);
    // Volver atrás
    r = nl('Press Banca Plano', '8-10', hist('Press Banca Plano', [[62.5, 6], [62.5, 5], [62.5, 5]]));
    ok('quedó debajo del rango → bajar un escalón (62,5 → 60)', r.kind === 'down' && r.kg === 60 && r.targetReps === 8, r);
    r = nl('Press Banca Plano', '8-10', hist('Press Banca Plano', [[62.5, 8], [62.5, 7], [62.5, 6]]));
    ok('si alguna serie entró al rango, repetir el peso', r.kind === 'same' && r.kg === 62.5 && r.targetReps === 10, r);
    r = nl('Press Banca Plano', '8-10', hist('Press Banca Plano', top3(60), '2026-08-15'));
    ok('3 meses sin hacerlo → volver con ~90 % (52,5)', r.kind === 'restart' && r.kg === 52.5 && r.weeks === 14, r);
    r = nl('Press Banca Mancuernas', '8-10', hist('Press Banca Mancuernas', top3(24), '2026-09-01'));
    ok('… con mancuernas, a una que existe (24 → 20)', r.kind === 'restart' && r.kg === 20, r);
    r = nl('Press Banca Plano', '8-10', hist('Press Banca Plano', [[60, 10], [600, 10], [60, 10]]));
    ok('un tipeo de 600 no manda (60 → 62,5)', r.kind === 'up' && r.kg === 62.5, r);
    // Con su peso y primera vez
    r = nl('Dominadas', '8-10', hist('Dominadas', [[0, 8], [0, 8], [0, 7]]));
    ok('dominadas: buscar 10 reps', r.kind === 'bw' && r.targetReps === 10 && !r.addKg, r);
    r = nl('Dominadas', '8-10', hist('Dominadas', [[0, 5], [0, 4], [0, 4]]));
    ok('dominadas debajo del rango: buscar 8', r.kind === 'bw' && r.targetReps === 8, r);
    r = nl('Dominadas', '8-10', hist('Dominadas', top3(0, 12)));
    ok('dominadas con 12 en todas: ya puede sumar lastre', r.kind === 'bw' && r.addKg === 2.5, r);
    r = nl('Dominadas', '8-10', hist('Dominadas', top3(5)));
    ok('dominadas con lastre: suben de a 2,5', r.kind === 'up' && r.kg === 7.5, r);
    r = nl('Press Militar', '8-10', []);
    ok('primera vez → elegir el peso por reps en reserva', r.kind === 'first' && r.targetReps === 10, r);
    ok('cardio, tiempo y "por lado" no llevan sugerencia', nl('Plancha', '30-45s', []) === null && nl('Dead Bug', '10/lado', []) === null && nextLoad([], { name: 'Cinta', reps: '20', kind: 'cardio' }, {}) === null);
    // Empujón tras estancarse: a un peso que exista
    ok('empujón: 45 +7,5 % → 47,5 (no 48,75)', pushLoad(45, 0.075, 'barbell', 'kg', {}).newKg === 47.5 && pushLoad(45, 0.075, 'barbell', 'kg', {}).pct === 6);
    ok('empujón: 100 +5 % → 105; mancuernas 22 +10 % → 24; máquina 40 +10 % → 45', pushLoad(100, 0.05, 'barbell', 'kg', {}).newKg === 105 && pushLoad(22, 0.10, 'dumbbell', 'kg', { dbGrid: 2 }).newKg === 24 && pushLoad(40, 0.10, 'machine', 'kg', {}).newKg === 45);
}

console.log('\nUnidad de las cargas (kg / lb)');
{
    const { convertLoad, convertSessionsUnit } = calc;
    ok('kg → lb de a 0,5 y lb → kg de a 0,25', convertLoad(100, 'kg', 'lbs') === 220.5 && convertLoad(62.5, 'kg', 'lbs') === 138 && convertLoad(135, 'lbs', 'kg') === 61.25 && convertLoad(0, 'kg', 'lbs') === 0 && convertLoad(80, 'kg', 'kg') === 80);
    const mk = () => [{ date: '2026-11-18', exercises: [{ exercise: 'Press Banca Plano', sets: [{ kg: 62.5, reps: 10 }, { kg: 61.3, reps: 8 }, { kg: 0, reps: 12 }] }, { exercise: 'Curl', sets: [{ kg: 12, reps: 10, unit: 'kg' }] }] }];
    const ss = mk();
    convertSessionsUnit(ss, 'kg', 'lbs');
    const a = ss[0].exercises[0].sets, c = ss[0].exercises[1].sets[0];
    ok('a libras: 62,5 → 138, 0 sigue en 0 y la unidad anotada se actualiza', a[0].kg === 138 && a[2].kg === 0 && c.kg === 26.5 && c.unit === 'lbs', ss);
    for (let i = 0; i < 5; i++) { convertSessionsUnit(ss, 'lbs', 'kg'); convertSessionsUnit(ss, 'kg', 'lbs'); }
    convertSessionsUnit(ss, 'lbs', 'kg');
    ok('ir y volver 5 veces devuelve los números exactos (61,3 no se corre)', a[0].kg === 62.5 && a[1].kg === 61.3 && c.kg === 12 && c.unit === 'kg', a);
    const ed = mk(); convertSessionsUnit(ed, 'kg', 'lbs'); ed[0].exercises[0].sets[0].kg = 140; convertSessionsUnit(ed, 'lbs', 'kg');
    ok('una serie editada en libras: el valor editado pasa a ser el original (140 lb → 63,5 kg)', ed[0].exercises[0].sets[0].kg === 63.5, ed[0].exercises[0].sets[0]);
}

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===\n');
process.exit(fail === 0 ? 0 : 1);
