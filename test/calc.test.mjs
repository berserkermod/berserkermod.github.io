// Tests de la capa de cálculo pura (core/calc.js). Sin dependencias: node test/calc.test.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// calc.js es un módulo UMD (no ESM): lo cargamos con require.
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const calc = require(path.join(here, '..', 'core', 'calc.js'));
const { calcTDEE, calcMacros, formatPortion, calcDailyBalance, calc1RM, cardioKcal } = calc;

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
}

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===\n');
process.exit(fail === 0 ? 0 : 1);
