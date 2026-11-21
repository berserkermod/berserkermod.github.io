// BERSERKERMOD — capa de cálculo pura
// =====================================================================
// Funciones de negocio SIN dependencias del DOM, de `state`, ni de i18n:
// entran datos, salen números. Único punto de verdad de la matemática de la
// app, así se puede testear en Node (test/calc.test.mjs) y a la vez correr en
// el browser. Sin build step: este archivo se carga con <script src> y expone
// las funciones como globales (para que el código inline las use tal cual) y,
// en Node, vía module.exports.
//
// Si cambiás una fórmula acá, los tests la cubren y la app la usa sin duplicar.
// =====================================================================
(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;        // Node / tests
    if (typeof window !== 'undefined') { Object.assign(window, api); window.BMCalc = api; } // browser
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // TDEE = Mifflin-St Jeor BMR × factor de actividad (según días de entrenamiento/semana).
    function calcTDEE(u) {
        if (!u) return 2000;
        var bmr = u.sex === 'M'
            ? (10 * u.weight + 6.25 * u.height - 5 * u.age + 5)
            : (10 * u.weight + 6.25 * u.height - 5 * u.age - 161);
        var factors = { 3: 1.375, 4: 1.55, 5: 1.725, 6: 1.9 };
        return Math.round(bmr * (factors[u.days] || 1.55));
    }

    // Mantenimiento que usa la app: el gasto ajustado con los datos reales del
    // usuario (ver adaptiveTDEE) si ya lo aceptó; si no, la fórmula.
    function maintenanceOf(u) {
        return u && u.tdeeAdaptive > 0 ? Math.round(u.tdeeAdaptive) : calcTDEE(u);
    }

    // Peso sobre el que se calcula la proteína. Con obesidad (IMC ≥ 30) se usa el peso
    // ajustado, como en las guías clínicas: el peso con IMC 25 más el 25 % del exceso. Con
    // el peso total, alguien de 120 kg y 1,75 m recibía 264 g; con el ajuste, 192 g, que
    // sigue por encima de la meseta de ~1,6 g/kg (Morton 2018; Wycherley 2012).
    function proteinWeight(u) {
        var w = Number(u && u.weight) || 0, hm = (Number(u && u.height) || 0) / 100;
        if (!(w > 0) || !(hm > 0)) return w;
        var ref = 25 * hm * hm;
        return w / (hm * hm) >= 30 ? ref + 0.25 * (w - ref) : w;
    }

    // TDEE + ajuste calórico por objetivo + split proteína/grasa/carbo.
    // Devuelve { tdee, adj, targetCals, protein, carbs, fat }.
    function calcMacros(u) {
        if (!u) return { tdee: 2000, adj: 0, targetCals: 2000, protein: 150, carbs: 200, fat: 70 };
        var tdee = maintenanceOf(u);
        var adj = { muscle: 400, fat_loss: -400, strength: 300, recomp: 0, endurance: 200 }[u.goal] || 0;
        var targetCals = Math.max(1200, tdee + adj);

        var proteinPerKg = { muscle: 2.0, fat_loss: 2.2, strength: 2.0, recomp: 2.2, endurance: 1.6 }[u.goal] || 2.0;
        var protein = Math.round(proteinWeight(u) * proteinPerKg);

        var fatPct = { muscle: 0.25, fat_loss: 0.20, strength: 0.30, recomp: 0.25, endurance: 0.25 }[u.goal] || 0.25;
        var fat = Math.max(40, Math.round((targetCals * fatPct) / 9));

        var carbCal = targetCals - (protein * 4) - (fat * 9);
        var carbs = Math.max(50, Math.round(carbCal / 4));

        return { tdee: tdee, adj: adj, targetCals: targetCals, protein: protein, carbs: carbs, fat: fat };
    }

    // Muestra una porción en su unidad natural: contables (huevos) por unidad,
    // líquidos en ml, el resto en gramos. Los macros se calculan siempre desde
    // gramos — esto solo cambia cómo se lee la porción.
    // lang ('es'|'en'|'pt', opcional) elige labelEn/labelPt de la unidad si
    // existen; sin lang o sin traducción cae al label base (español).
    function formatPortion(grams, unit, lang) {
        if (unit && unit.kind === 'count') {
            var n = Math.max(1, Math.round(grams / (unit.g || 50)));
            var one = unit.label, many = unit.labelP;
            if (lang === 'en') { one = unit.labelEn || one; many = unit.labelPEn || many; }
            else if (lang === 'pt') { one = unit.labelPt || one; many = unit.labelPPt || many; }
            var lbl = n === 1 ? (one || 'u') : (many || one || 'u');
            return n + ' ' + lbl;
        }
        if (unit && unit.kind === 'ml') {
            return Math.round(grams / (unit.density || 1)) + ' ml';
        }
        return Math.round(grams) + ' g';
    }

    // Balance energético diario: neto = consumido − quemado (cardio), clasificado
    // contra el mantenimiento (TDEE) y contra lo que pide el objetivo. BAND evita
    // el parpadeo cerca de la línea de mantenimiento.
    // maint (opcional): mantenimiento a usar. Con el gasto real del ajuste semanal, la app
    // pasa ese gasto MENOS el cardio promedio que ya trae adentro: si no, el cardio de hoy
    // se contaría dos veces (una en el gasto real y otra acá).
    function calcDailyBalance(u, consumed, burned, maint) {
        var maintenance = maint > 0 ? Math.round(maint) : maintenanceOf(u);
        var net = Math.round(consumed - burned);
        var diff = net - maintenance;
        var BAND = 100;
        var status = diff > BAND ? 'surplus' : (diff < -BAND ? 'deficit' : 'maintenance');
        var adj = { muscle: 400, fat_loss: -400, strength: 300, recomp: 0, endurance: 200 }[u.goal] || 0;
        var goalWants = adj > 100 ? 'surplus' : (adj < -100 ? 'deficit' : 'maintenance');
        var aligned = status === goalWants;
        return {
            maintenance: maintenance, consumed: Math.round(consumed), burned: Math.round(burned),
            net: net, diff: diff, status: status, goalWants: goalWants, aligned: aligned
        };
    }

    // 1RM estimado (fórmula de Epley). Con 1 rep el 1RM es el peso mismo.
    function calc1RM(w, r) { return r === 1 ? w : Math.round(w * (1 + r / 30)); }

    // kcal de cardio = (MET × factor_intensidad − 1) × peso(kg) × horas. Se resta 1 MET,
    // el gasto en reposo, que ya está dentro del mantenimiento: si no, se cuenta dos veces.
    // Es lo que los relojes llaman "calorías activas". (Compendium of Physical Activities.)
    function cardioKcal(met, intensity, weightKg, seconds) {
        var net = Math.max(0, (met || 0) * (intensity || 1) - 1);
        return Math.round(net * (weightKg || 0) * ((seconds || 0) / 3600));
    }

    // Gasto ESTIMADO de una sesión de pesas, solo informativo: no se suma al balance porque
    // el mantenimiento ya incluye el entrenamiento (factor de actividad por días de gimnasio).
    // Compendio de Actividades Físicas 2024: pesas de 3,5 MET (moderado, 02054) a 6 MET
    // (vigoroso, 02050). Se resta 1 MET de reposo como en el cardio y se informa el punto
    // medio (3,75 MET netos) con su rango (2,5-5). kcal = MET × kg × horas, de a 10.
    function strengthKcal(minutes, weightKg) {
        var hours = (Number(minutes) || 0) / 60, kg = Number(weightKg) || 0;
        if (!(hours > 0) || !(kg > 0)) return null;
        var r10 = function (x) { return Math.round(x / 10) * 10; };
        return { kcal: r10(3.75 * kg * hours), low: r10(2.5 * kg * hours), high: r10(5 * kg * hours) };
    }

    // Discos por lado para armar `total` con una barra de `bar`, usando los discos
    // disponibles de mayor a menor. Devuelve { perSide: [25, 10, 2.5], rest } donde
    // rest es lo que no se pudo armar con esos discos (0 si cierra justo).
    function platesPerSide(total, bar, plates) {
        var r = function (x) { return Math.round(x * 1000) / 1000; };
        var left = r((total - bar) / 2);
        if (!(left > 0)) return { perSide: [], rest: 0 };
        var out = [];
        plates.slice().sort(function (a, b) { return b - a; }).forEach(function (p) {
            while (left + 1e-9 >= p) { out.push(p); left = r(left - p); }
        });
        return { perSide: out, rest: r(left * 2) };
    }

    // Series de aproximación hasta el peso de trabajo: barra sola (si hay barra) y
    // escalones al 40/60/80 % redondeados a `step`, sin repetir pesos ni llegar al
    // de trabajo. Con poco peso quedan menos escalones (o ninguno).
    function warmupSets(work, opts) {
        opts = opts || {};
        var bar = opts.bar || 0, step = opts.step || 2.5;
        var out = [];
        if (!(work > 0)) return out;
        if (bar > 0 && work > bar) out.push({ kg: bar, reps: 10 });
        [[0.4, 8], [0.6, 5], [0.8, 3]].forEach(function (s) {
            var kg = Math.round(work * s[0] / step) * step;
            var prev = out.length ? out[out.length - 1].kg : 0;
            if (kg <= Math.max(prev, bar) || kg >= work) return;
            out.push({ kg: kg, reps: s[1] });
        });
        return out;
    }

    // ── Carga sugerida (auditoría de progresión, nov 2026) ─────────────────
    // Tipo de equipo según el nombre: decide de a cuánto se puede subir. El orden importa:
    // "Press Banca Mancuernas" es de mancuernas aunque diga "press banca", "Hack Squat" es una
    // máquina de discos aunque diga "squat" y "Crunch en Polea" es de polea.
    var GEAR_RULES = [
        ['machine', /m[áa]quina|machine|polea|cable|pec deck|jal[óo]n|pulldown|pushdown|face pull|cruces|crossover|extensi[óo]n (de )?cu[áa]driceps|leg extension|curl femoral|leg curl|abductor|aductor|pantorrilla|gemelo|calf/],
        ['plates', /prensa|leg press|hack|smith|t-?bar|landmine/],
        ['dumbbell', /mancuerna|dumbbell|martillo|hammer|arnold|zancada|lunge|b[úu]lgara|goblet|kettlebell|elevaci[óo]n(es)? lateral|lateral raise|elevaci[óo]n(es)? posterior|rear delt|concentrad/],
        ['bodyweight', /dominada|pull-?up|chin-?up|fondos|\bdips?\b|flexi[óo]n|push-?up|plancha|plank|dead bug|dragon flag|elevaci[óo]n de (piernas|rodillas)|leg raise|ab wheel|rueda abdominal|russian twist|burpee|crunch/],
        ['barbell', /barra|barbell|sentadilla|squat|peso muerto|deadlift|press banca|press plano|bench|press militar|overhead press|hip thrust|good morning|press franc[ée]s|skull|\bez\b/]
    ];
    function exerciseGear(name) {
        var n = String(name || '').toLowerCase();
        for (var i = 0; i < GEAR_RULES.length; i++) if (GEAR_RULES[i][1].test(n)) return GEAR_RULES[i][0];
        return 'other';
    }
    function r2(x) { return Math.round(x * 100) / 100; }

    // Peso de trabajo: el que más se repite (empate → el más pesado). Si son todos distintos,
    // el más pesado, salvo que se despegue más de 1,5 veces del siguiente (error de tipeo:
    // 600 entre series de 60). Así no mandan una serie de calentamiento anotada ni un tipeo.
    function workingWeight(sets) {
        var count = {}, list = [];
        (sets || []).forEach(function (s) {
            var kg = Number(s && s.kg) || 0, reps = Number(s && s.reps) || 0;
            if (kg > 0 && reps > 0) { if (!count[kg]) list.push(kg); count[kg] = (count[kg] || 0) + 1; }
        });
        if (!list.length) return 0;
        var best = 0, bestN = 0;
        list.forEach(function (kg) { var n = count[kg]; if (n > bestN || (n === bestN && kg > best)) { best = kg; bestN = n; } });
        if (bestN > 1) return best;
        list.sort(function (a, b) { return b - a; });
        return list.length > 1 && list[0] > list[1] * 1.5 ? list[1] : list[0];
    }

    // Última vez que hizo el ejercicio (sesiones de la más nueva a la más vieja). Con `day`,
    // la última vez en ese día del plan: el día pesado y el liviano del mismo ejercicio no se
    // mezclan. Si nunca lo hizo ese día, devuelve la última vez con `otherDay: true`.
    function lastExerciseEntry(sessions, name, day) {
        var any = null, list = sessions || [];
        for (var i = 0; i < list.length; i++) {
            var s = list[i], exs = (s && s.exercises) || [];
            for (var j = 0; j < exs.length; j++) {
                var e = exs[j];
                if ((e.exercise || e.name) !== name || !e.sets || !e.sets.length) continue;
                var hit = { sets: e.sets, date: s.date, day: s.day };
                if (!day || s.day === day) return hit;
                if (!any) { any = hit; any.otherDay = true; }
            }
        }
        return any;
    }

    // Escalón de las mancuernas del gimnasio, deducido de lo que anotó: 2,5 si usa 12,5 /
    // 17,5 / 22,5…; 2 si usa 12 / 14 / 16…; sin datos, 2.
    function dumbbellGrid(sessions) {
        var c2 = 0, c25 = 0;
        (sessions || []).slice(0, 120).forEach(function (s) {
            ((s && s.exercises) || []).forEach(function (e) {
                if (exerciseGear(e.exercise || e.name) !== 'dumbbell') return;
                (e.sets || []).forEach(function (x) {
                    var kg = Number(x && x.kg) || 0;
                    if (kg < 10) return;
                    var m2 = Math.abs(kg / 2 - Math.round(kg / 2)) < 1e-6, m25 = Math.abs(kg / 2.5 - Math.round(kg / 2.5)) < 1e-6;
                    if (m25 && !m2) c25++; else if (m2 && !m25) c2++;
                });
            });
        });
        return c25 > c2 ? 2.5 : 2;
    }

    // El salto más chico entre los pesos que ya usó en ese ejercicio (placas de una máquina:
    // 40 → 45 dice 5). 0 si no hay al menos dos pesos distintos o el salto es raro.
    function seenStep(sessions, name, unit) {
        var vals = {};
        (sessions || []).slice(0, 120).forEach(function (s) {
            ((s && s.exercises) || []).forEach(function (e) {
                if ((e.exercise || e.name) !== name) return;
                (e.sets || []).forEach(function (x) { var kg = Number(x && x.kg) || 0; if (kg > 0) vals[kg] = 1; });
            });
        });
        var list = Object.keys(vals).map(Number).sort(function (a, b) { return a - b; }), d = 0;
        for (var i = 1; i < list.length; i++) { var g = r2(list[i] - list[i - 1]); if (g > 0 && (!d || g < d)) d = g; }
        var lo = unit === 'lbs' ? 2 : 1, hi = unit === 'lbs' ? 20 : 10;
        return d >= lo && d <= hi ? d : 0;
    }

    // De a cuánto se puede subir (en la unidad de la app). Barra y discos: el disco más
    // chico de cada lado (1,25 → 2,5 en total). Mancuernas: de a 1 kg hasta 10 y después
    // el escalón del gimnasio. Máquinas y el resto: el salto que ya usó, o uno típico.
    function loadStep(gear, kg, unit, opts) {
        var lb = unit === 'lbs', o = opts || {};
        if (gear === 'barbell' || gear === 'plates' || gear === 'bodyweight') return lb ? 5 : 2.5;
        if (gear === 'dumbbell') {
            if (lb) return 5;
            if (kg < 10) return 1;
            // El peso que usa dice el escalón de su gimnasio: 26 → de a 2, 27,5 → de a 2,5,
            // 17 → de a 1. Solo si encaja en los dos (10, 20, 30) manda lo que anotó en general.
            var on2 = Math.abs(kg / 2 - Math.round(kg / 2)) < 1e-6, on25 = Math.abs(kg / 2.5 - Math.round(kg / 2.5)) < 1e-6;
            if (on2 && !on25) return 2;
            if (on25 && !on2) return 2.5;
            if (!on2 && !on25) return 1;
            return o.dbGrid || 2;
        }
        if (o.seenStep) return o.seenStep;
        return gear === 'machine' ? (lb ? 10 : 5) : (lb ? 5 : 2.5);
    }
    // Siguiente peso que existe: las mancuernas van a la próxima del escalón (22 → 24);
    // lo demás suma el escalón al peso que viene usando (respeta su propia grilla).
    function stepUp(kg, step, gear) {
        if (gear === 'dumbbell') return r2(Math.floor(kg / step + 1e-9) * step + step);
        return r2(kg + step);
    }
    function stepDown(kg, step, gear) {
        if (gear === 'dumbbell') return r2(Math.ceil(kg / step - 1e-9) * step - step);
        return r2(kg - step);
    }
    // El peso que existe más cerca por debajo de `target`, partiendo de `from`.
    function floorTo(target, from, step, gear) {
        if (gear === 'dumbbell') return r2(Math.floor(target / step + 1e-9) * step);
        return r2(from - Math.ceil((from - target) / step - 1e-9) * step);
    }

    // Carga sugerida para hoy (doble progresión). ex = { name, reps: '8-10', kind }.
    // opts = { today, unit, day, dbGrid }. Devuelve null o { kind, kg, inc, targetReps, weeks, addKg }:
    //   first   — nunca lo hizo: elegir el peso por las reps en reserva
    //   up      — completó el tope del rango en todas las series de trabajo: subir un escalón
    //   extend  — el escalón es > 10 % del peso: primero 2 reps más (regla "2 por 2")
    //   same    — repetir el peso y completar el rango
    //   down    — quedó debajo del rango en todas las series: bajar un escalón
    //   restart — más de 28 días sin hacerlo: volver con ~90 % (en peso que existe)
    //   bw      — con su peso: progresar en reps; addKg cuando ya puede sumar lastre
    function nextLoad(sessions, ex, opts) {
        var o = opts || {};
        if (!ex || ex.kind === 'cardio') return null;
        var rs = String(ex.reps || '').trim();
        if (!/^\d+(-\d+)?$/.test(rs)) return null;   // "30-45s", "10/lado", "al fallo": no
        var parts = rs.split('-'), top = parseInt(parts[parts.length - 1], 10);
        if (!top) return null;
        var bottom = parts.length > 1 ? parseInt(parts[0], 10) : Math.max(1, top - 2);
        var unit = o.unit === 'lbs' ? 'lbs' : 'kg', gear = exerciseGear(ex.name);
        var last = lastExerciseEntry(sessions, ex.name, o.day);
        if (!last) return { kind: 'first', kg: 0, targetReps: top, gear: gear };
        if (last.otherDay) return null;   // solo lo hizo otro día del plan, con otro rango
        var reps = function (s) { return parseInt(s && s.reps, 10) || 0; };
        var w = workingWeight(last.sets);
        var work = last.sets.filter(function (s) { return reps(s) > 0 && (!(w > 0) || (Number(s.kg) || 0) >= w - 1e-9); });
        if (!work.length) return null;
        var rr = work.map(reps), minR = Math.min.apply(null, rr);
        if (!(w > 0)) {   // con su peso
            if (minR >= top + 2) return { kind: 'bw', kg: 0, targetReps: top + 2, addKg: unit === 'lbs' ? 5 : 2.5, gear: gear };
            if (minR >= top) return { kind: 'bw', kg: 0, targetReps: top + 2, gear: gear };
            return { kind: 'bw', kg: 0, targetReps: rr.every(function (r) { return r < bottom; }) ? bottom : top, gear: gear };
        }
        var step = loadStep(gear, w, unit, { dbGrid: o.dbGrid, seenStep: seenStep(sessions, ex.name, unit) });
        var days = o.today && last.date ? dayNum(o.today) - dayNum(last.date) : 0;
        if (days > 28) {
            var back = floorTo(w * 0.9, w, step, gear);
            if (back > 0 && back < w) return { kind: 'restart', kg: back, weeks: Math.round(days / 7), gear: gear };
        }
        if (rr.every(function (r) { return r < bottom; })) {
            var dn = stepDown(w, step, gear);
            if (dn > 0) return { kind: 'down', kg: dn, targetReps: bottom, inc: r2(dn - w), gear: gear };
            return { kind: 'same', kg: w, targetReps: top, gear: gear };
        }
        if (minR >= top) {
            var up = stepUp(w, step, gear), inc = r2(up - w), ext = top + 2;
            // Con lastre el salto se mide contra el peso del cuerpo + lastre: no se estira el rango.
            if (gear !== 'bodyweight' && inc / w > 0.10 && minR < ext) return { kind: 'extend', kg: w, targetReps: ext, gear: gear };
            return { kind: 'up', kg: up, inc: inc, gear: gear };
        }
        return { kind: 'same', kg: w, targetReps: top, gear: gear };
    }

    // Empujón tras un estancamiento (se mantiene desde la auditoría del 3-nov): subir ~pct,
    // pero a un peso que exista. Devuelve { newKg, pct } con el % real.
    function pushLoad(w, pct, gear, unit, opts) {
        var step = loadStep(gear, w, unit, opts), target = w * (1 + pct);
        var kg = stepUp(w, step, gear), guard = 0;
        while (stepUp(kg, step, gear) - step / 2 <= target && guard++ < 20) kg = stepUp(kg, step, gear);
        return { newKg: kg, pct: Math.round((kg - w) / w * 100) };
    }

    // ── Peso corporal y gasto real ──────────────────────────────────────
    var DAY_MS = 86400000;
    function dayNum(iso) { return Math.round(Date.parse(iso + 'T12:00:00Z') / DAY_MS); }

    // Peso de tendencia: media móvil exponencial del 10 % por día (la del Hacker's
    // Diet). Filtra el ruido de agua y sal; si faltan días, se acerca al dato nuevo
    // como si esos días hubieran pasado. Entrada [{date, kg}] en cualquier orden.
    function weightTrend(entries) {
        var list = (entries || []).filter(function (e) { return e && e.date && e.kg > 0; })
            .slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
        var out = [], trend = null, prev = null;
        list.forEach(function (e) {
            if (trend === null) trend = e.kg;
            else {
                var gap = Math.max(1, dayNum(e.date) - dayNum(prev));
                trend = trend + (1 - Math.pow(0.9, gap)) * (e.kg - trend);
            }
            prev = e.date;
            out.push({ date: e.date, kg: e.kg, trend: Math.round(trend * 100) / 100 });
        });
        return out;
    }

    // Gasto real estimado a partir de lo que comiste y cómo se movió tu peso:
    // gasto = ingesta media − cambio de peso × 7700 kcal/kg ÷ días (como MacroFactor).
    // Usa los últimos `window` días sin contar hoy (que todavía no terminó).
    // Pide datos suficientes; con pocos días registrados confía más en la fórmula,
    // y nunca se aleja más de ±25 % de ella (un registro incompleto no lo dispara).
    // opts: { weights:[{date,kg}], intakes:[{date,kcal}], formula, today:'YYYY-MM-DD', window }
    // Devuelve null si faltan datos, o { tdee, raw, avgIntake, change, days, loggedDays }.
    function adaptiveTDEE(opts) {
        var o = opts || {}, win = o.window || 21, formula = o.formula || 0;
        if (!o.today || !(formula > 0)) return null;
        var end = dayNum(o.today), start = end - win;
        var inWin = function (d) { var n = dayNum(d); return n >= start && n < end; };
        // Días con comida registrada en serio (con menos de 800 kcal seguro faltó anotar).
        var logged = (o.intakes || []).filter(function (x) { return x && x.date && inWin(x.date) && x.kcal >= 800; });
        var trend = weightTrend(o.weights).filter(function (t) { return inWin(t.date); });
        if (logged.length < 10 || trend.length < 4) return null;
        var days = dayNum(trend[trend.length - 1].date) - dayNum(trend[0].date);
        if (days < 10) return null;
        var avgIntake = logged.reduce(function (a, x) { return a + x.kcal; }, 0) / logged.length;
        var change = trend[trend.length - 1].trend - trend[0].trend;
        var raw = avgIntake - change * 7700 / days;
        var confidence = Math.min(1, logged.length / win);
        var est = formula + (raw - formula) * confidence;
        est = Math.max(formula * 0.75, Math.min(formula * 1.25, est));
        return {
            tdee: Math.round(est / 10) * 10, raw: Math.round(raw), avgIntake: Math.round(avgIntake),
            change: Math.round(change * 100) / 100, days: days, loggedDays: logged.length
        };
    }

    // ── Músculos que trabaja cada ejercicio (para el mapa del cuerpo) ──────
    // 13 zonas. Cada serie suma 1 al músculo principal y 0,5 a los secundarios
    // (la convención de conteo de volumen semanal). Reglas por nombre, en orden:
    // la primera que coincide gana. Nombres en español (los de la app) e inglés.
    var MUSCLES = ['chest', 'shoulders', 'biceps', 'forearms', 'abs', 'quads', 'traps', 'lats', 'triceps', 'lowback', 'glutes', 'hamstrings', 'calves'];
    var MUSCLE_RULES = [
        [/plancha|crunch|abdominal|ab wheel|rueda|russian|dead bug|dragon|pallof|oblicuo|elevaci[oó]n de (piernas|rodillas)|leg raise|plank|sit-?up/, [['abs', 1]]],
        [/gemelo|pantorrilla|calf|calves/, [['calves', 1]]],
        [/curl femoral|femoral|leg curl|nordic/, [['hamstrings', 1]]],
        [/rumano|romanian|piernas r[ií]gidas|stiff|buenos d[ií]as|good morning/, [['hamstrings', 1], ['glutes', 0.5], ['lowback', 0.5]]],
        [/peso muerto|deadlift/, [['glutes', 1], ['hamstrings', 1], ['lowback', 0.5], ['quads', 0.5], ['traps', 0.5]]],
        [/hip thrust|puente de gl[uú]teo|glute bridge|patada de gl[uú]teo|abductor|gl[uú]teo|glute/, [['glutes', 1], ['hamstrings', 0.5]]],
        [/hiperextensi|lumbar|back extension/, [['lowback', 1], ['glutes', 0.5], ['hamstrings', 0.5]]],
        [/extensi[oó]n(es)? (de )?(cu[aá]driceps|piernas)|leg extension|sill[oó]n de cu[aá]driceps/, [['quads', 1]]],
        [/sentadilla|squat|prensa|leg press|hack|zancada|estocada|lunge|b[uú]lgara|step.?up|aductor/, [['quads', 1], ['glutes', 0.5]]],
        [/encogimiento|shrug/, [['traps', 1]]],
        [/face pull|p[aá]jaro|posterior|reverse fly|rear delt/, [['shoulders', 1], ['traps', 0.5]]],
        [/laterales|lateral raise|elevaci[oó]n lateral|elevaciones frontales|frontal/, [['shoulders', 1]]],
        [/press militar|press de hombro|press hombro|arnold|overhead press|shoulder press|military/, [['shoulders', 1], ['triceps', 0.5]]],
        [/franc[eé]s|skull|pushdown|tr[ií]ceps|triceps|patada de tr|extensi[oó]n de codo|extensi[oó]n overhead|overhead extension|press cerrado|close.?grip/, [['triceps', 1]]],
        [/fondos|dips?\b/, [['triceps', 1], ['chest', 0.5], ['shoulders', 0.5]]],
        [/antebrazo|mu[nñ]eca|wrist|farmer|forearm/, [['forearms', 1]]],
        [/martillo|hammer/, [['biceps', 1], ['forearms', 0.5]]],
        [/curl|b[ií]ceps|biceps/, [['biceps', 1]]],
        [/dominada|pull.?up|chin.?up|jal[oó]n|pulldown|pullover/, [['lats', 1], ['biceps', 0.5]]],
        [/remo|row/, [['lats', 1], ['traps', 0.5], ['biceps', 0.5]]],
        [/apertura|cruce|pec deck|fly|crossover/, [['chest', 1]]],
        [/press inclinado|incline/, [['chest', 1], ['shoulders', 0.5], ['triceps', 0.5]]],
        [/press banca|press plano|press de banca|bench|pecho|chest|flexion|push.?up|press declinado/, [['chest', 1], ['triceps', 0.5], ['shoulders', 0.5]]]
    ];
    function muscleTargets(name) {
        var n = String(name || '').toLowerCase();
        for (var i = 0; i < MUSCLE_RULES.length; i++) if (MUSCLE_RULES[i][0].test(n)) return MUSCLE_RULES[i][1];
        return [];
    }
    // Series por músculo de una lista de sesiones [{exercises:[{exercise, sets:[…]}]}].
    // Ejercicios que no se reconocen van a `unknown` (para no inventar músculos).
    function muscleSets(sessions) {
        var out = { unknown: 0 };
        MUSCLES.forEach(function (m) { out[m] = 0; });
        (sessions || []).forEach(function (s) {
            (s && s.exercises || []).forEach(function (e) {
                var n = (e && e.sets || []).length;
                if (!n) return;
                var t = muscleTargets(e.exercise);
                if (!t.length) { out.unknown += n; return; }
                t.forEach(function (mw) { out[mw[0]] += n * mw[1]; });
            });
        });
        return out;
    }

    // ── Ajuste por rendimiento: fatiga, descarga y volumen ──────────────────
    // Rendimiento de un ejercicio en una sesión: 1RM estimado de la mejor serie (Epley,
    // como calc1RM); si es con el peso del cuerpo (0 kg), las reps de la mejor serie.
    function sessionPerf(sets) {
        var bestKg = 0, bestReps = 0;
        (sets || []).forEach(function (s) {
            var kg = Number(s && s.kg) || 0, r = Number(s && s.reps) || 0;
            if (r <= 0) return;
            if (kg > 0) bestKg = Math.max(bestKg, kg * (1 + r / 30));
            else bestReps = Math.max(bestReps, r);
        });
        return bestKg > 0 ? { value: bestKg, kind: 'kg' } : bestReps > 0 ? { value: bestReps, kind: 'reps' } : null;
    }

    // Señales del historial (auditoría nov 2026, cambio 7). Solo con registro constante:
    // al menos 2 sesiones en cada una de las últimas 3 semanas (bloques de 7 días hacia
    // atrás desde hoy). Sin eso no hay señales: no se distingue fatiga de falta de datos.
    // · Fatiga en un ejercicio: sus 2 últimas sesiones quedaron 5 % o más por debajo de su
    //   mejor marca de las 3 semanas anteriores, y la última fue hace 10 días o menos. Una
    //   caída sostenida del rendimiento es la única señal confiable de sobrecarga (Grandou
    //   2020); el 1RM varía ~4 % entre mediciones (Grgic 2020) y una sola sesión mala puede
    //   ser el sueño (Craven 2022): por eso 5 % y dos sesiones.
    // · Progreso: el rendimiento subió 2,5 % o más contra la sesión de hace 3 a 5 semanas.
    // Devuelve { dataOk, fatigued: [nombres], progressing: [nombres] }.
    function performanceSignals(sessions, today) {
        var t = dayNum(today);
        var list = (sessions || []).filter(function (s) { return s && s.date && dayNum(s.date) <= t; });
        var blocks = [0, 0, 0];
        list.forEach(function (s) { var d = t - dayNum(s.date); if (d < 21) blocks[Math.floor(d / 7)]++; });
        var out = { dataOk: blocks[0] >= 2 && blocks[1] >= 2 && blocks[2] >= 2, fatigued: [], progressing: [] };
        if (!out.dataOk) return out;
        var byEx = {};
        list.forEach(function (s) {
            var n = dayNum(s.date);
            if (t - n > 42) return;
            (s.exercises || []).forEach(function (e) {
                var name = String((e && (e.exercise || e.name)) || '').trim();
                var p = name && sessionPerf(e.sets);
                if (!p) return;
                var key = name.toLowerCase();
                (byEx[key] = byEx[key] || { name: name, occ: [] }).occ.push({ n: n, v: p.value, kind: p.kind });
            });
        });
        Object.keys(byEx).forEach(function (k) {
            var ex = byEx[k];
            var occ = ex.occ.sort(function (a, b) { return b.n - a.n; });
            occ = occ.filter(function (o) { return o.kind === occ[0].kind; });
            var last = occ[0];
            if (t - last.n > 10) return;
            if (occ.length >= 3) {
                var ref = 0;
                occ.slice(2).forEach(function (o) { if (last.n - o.n <= 21) ref = Math.max(ref, o.v); });
                if (ref > 0 && last.v <= ref * 0.95 && occ[1].v <= ref * 0.95) { out.fatigued.push(ex.name); return; }
            }
            var old = null;
            occ.forEach(function (o) { var d = last.n - o.n; if (d >= 21 && d <= 35 && (!old || o.n < old.n)) old = o; });
            if (old && last.v >= old.v * 1.025) out.progressing.push(ex.name);
        });
        return out;
    }

    // Series fraccionales por músculo de una rutina ([{ exercises: [{ name, sets }] }]).
    function planMuscleSets(plan) {
        return muscleSets((plan || []).map(function (d) {
            return { exercises: (d.exercises || []).map(function (e) { return { exercise: e.name, sets: new Array(Math.max(0, e.sets | 0)) }; }) };
        }));
    }

    // Suma o resta `delta` series semanales a un músculo, de a 1 serie por ejercicio, en
    // los ejercicios donde es el principal. Empieza por los accesorios (los últimos del
    // día); al restar no baja de 2 series por ejercicio; al sumar no pasa de 5 series por
    // ejercicio ni de `cap` series fraccionales semanales para ese músculo. Cambia la
    // rutina recibida y devuelve cuántas series aplicó.
    function adjustMuscleVolume(plan, muscle, delta, cap) {
        var step = delta > 0 ? 1 : -1, need = Math.abs(delta | 0), applied = 0;
        var cands = [];
        (plan || []).forEach(function (d) {
            (d.exercises || []).forEach(function (e, i) {
                if (muscleTargets(e.name).some(function (mw) { return mw[0] === muscle && mw[1] === 1; })) cands.push({ e: e, i: i });
            });
        });
        cands.sort(function (a, b) { return b.i - a.i; });
        for (var round = 0; round < 4 && applied < need; round++) {
            for (var k = 0; k < cands.length && applied < need; k++) {
                var e = cands[k].e;
                if (step < 0 && e.sets > 2) { e.sets--; applied++; }
                else if (step > 0 && e.sets < 5 && (!(cap > 0) || (planMuscleSets(plan)[muscle] || 0) + 1 <= cap)) { e.sets++; applied++; }
            }
        }
        return applied;
    }

    // Fecha 'YYYY-MM-DD' del día LOCAL, según la zona horaria del teléfono (que
    // ya sabe país y región: Madrid y Canarias, Nueva York y Los Ángeles).
    // toISOString() da el día en UTC: en España la medianoche local cae el día
    // anterior y en Argentina, después de las 21 h, ya es "mañana". Toda fecha
    // de calendario de la app sale de acá.
    function localDateStr(d) {
        var x = d instanceof Date ? d : new Date(d === undefined ? Date.now() : d);
        if (isNaN(x)) return '';
        var m = x.getMonth() + 1, day = x.getDate();
        return x.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
    }

    // ── Modo Coach: resultados que registra el alumno desde su link ──
    // Semana ISO (lunes a domingo) de 'YYYY-MM-DD' → 'YYYY-Www'. Misma cuenta que el Worker.
    function isoWeek(dateStr) {
        var d = new Date(dateStr + 'T00:00:00Z');
        if (isNaN(d)) return '';
        d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));   // el jueves define el año
        var week = Math.ceil(((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
        return d.getUTCFullYear() + '-W' + (week < 10 ? '0' : '') + week;
    }

    function sameExercise(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }

    // Mejor serie: la de más kg; a igual kg, la de más reps. null si no hay series con reps.
    function topSet(sets) {
        var best = null;
        (sets || []).forEach(function (s) {
            var kg = Number(s && s.kg) || 0, reps = Number(s && s.reps) || 0;
            if (reps <= 0) return;
            if (!best || kg > best.kg || (kg === best.kg && reps > best.reps)) best = { kg: kg, reps: reps };
        });
        return best;
    }

    // Cómo le fue en un ejercicio de la sesión `idx` frente a la vez anterior que
    // lo hizo (sesiones en orden desc): 1 subió, -1 bajó, 0 igual, null sin referencia.
    // Manda la mejor serie (kg, después reps); si empata, el volumen total (kg × reps),
    // así subir una serie de 77,5 a 80 con la misma mejor serie también cuenta.
    function exerciseTrend(sessions, idx, name) {
        var list = sessions || [];
        var find = function (s) {
            var exs = (s && s.exercises) || [];
            for (var i = 0; i < exs.length; i++) {
                if (!sameExercise(exs[i].name, name) || !exs[i].sets) continue;
                var top = topSet(exs[i].sets);
                if (!top) return null;
                var vol = 0;
                exs[i].sets.forEach(function (x) { vol += (Number(x.kg) || 0) * (Number(x.reps) || 0); });
                return { kg: top.kg, reps: top.reps, vol: Math.round(vol * 10) / 10 };
            }
            return null;
        };
        var sign = function (a, b) { return a === b ? 0 : (a > b ? 1 : -1); };
        var cur = find(list[idx]);
        if (!cur) return null;
        for (var j = idx + 1; j < list.length; j++) {
            var prev = find(list[j]);
            if (!prev) continue;
            return sign(cur.kg, prev.kg) || sign(cur.reps, prev.reps) || sign(cur.vol, prev.vol);
        }
        return null;
    }

    // Meta semanal de cardio (objetivos perder grasa y resistencia). Semana de lunes a
    // domingo, en minutos. Arranca en 150: con menos, el efecto sobre el peso es mínimo
    // (ACSM 2009) y es el piso de la OMS 2020. Después sube de a poco: 10 % más que el
    // promedio de las 4 semanas completas anteriores, en pasos de 10 min, hasta 300.
    // sessions: [{ date: 'YYYY-MM-DD', duration: segundos }], today: 'YYYY-MM-DD'.
    // opts.weightOf(sesión) → cuánto vale cada minuto (por defecto 1). La app usa
    // cardioMinuteWeight: como la OMS, el minuto vigoroso vale doble y el liviano no cuenta.
    // Devuelve { minutes, target, remaining, done, daysLeft (contando hoy), avgPrev }.
    function cardioWeek(sessions, today, opts) {
        var o = opts || {}, lo = o.min || 150, hi = o.max || 300;
        var weightOf = typeof o.weightOf === 'function' ? o.weightOf : function () { return 1; };
        var t = dayNum(today);
        // dayNum('1970-01-01') es 1 (redondea al mediodía) y fue jueves: (n + 2) % 7 = 0 el lunes
        var monday = function (n) { return n - ((n + 2) % 7); };
        var cur = monday(t), byWeek = {};
        (sessions || []).forEach(function (s) {
            if (!s || !s.date || !(s.duration > 0)) return;
            var n = dayNum(s.date);
            if (n > t) return;
            var w = monday(n), k = Number(weightOf(s));
            if (!(k > 0)) return;
            byWeek[w] = (byWeek[w] || 0) + s.duration / 60 * k;
        });
        var sum = 0;
        for (var k = 1; k <= 4; k++) sum += byWeek[cur - 7 * k] || 0;
        var avg = sum / 4;
        var target = Math.max(lo, Math.min(hi, Math.round(avg * 1.1 / 10) * 10));
        var minutes = Math.round(byWeek[cur] || 0);
        return {
            minutes: minutes, target: target, remaining: Math.max(0, target - minutes),
            done: minutes >= target, daysLeft: 7 - ((t + 2) % 7), avgPrev: Math.round(avg)
        };
    }

    // Cuánto vale un minuto de cardio para la meta semanal, según su MET (OMS 2020: 150-300
    // min moderados o 75-150 vigorosos, o una combinación equivalente). Moderado = 3 a <6 MET
    // (vale 1); vigoroso = 6 MET o más (vale 2); liviano, menos de 3 MET (yoga, pilates,
    // caminar despacio), no cuenta para la meta aeróbica.
    function cardioMinuteWeight(met) {
        var m = Number(met) || 0;
        return m >= 6 ? 2 : (m >= 3 ? 1 : 0);
    }

    // Promedio de kcal de cardio por día en los `days` días ANTERIORES a `today` (los días sin
    // cardio cuentan como 0). Es el cardio que ya viene adentro del gasto real del ajuste semanal,
    // que mira los 21 días anteriores. sessions: [{ date, calories }].
    function cardioDailyAvg(sessions, today, days) {
        var d = days || 21, end = dayNum(today), start = end - d, sum = 0;
        if (!today) return 0;
        (sessions || []).forEach(function (s) {
            if (!s || !s.date || !(s.calories > 0)) return;
            var n = dayNum(s.date);
            if (n >= start && n < end) sum += s.calories;
        });
        return Math.round(sum / d);
    }

    // ── Cardio: velocidad, esfuerzo, carga, totales y récords ──────────────
    // MET según la velocidad (km/h), del Compendio de Actividades Físicas 2024 (cada rango en mph
    // pasado a km/h por su punto medio; se interpola entre puntos y no se pasa de los extremos).
    // Solo correr, caminar y bici al aire libre: ahí la distancia estima mejor que el nivel elegido.
    var SPEED_METS = {
        // 12028, 12029, 12030, 12045, 12050, 12060, 12070, 12080, 12090, 12100, 12110, 12115, 12120, 12130, 12132, 12134, 12135
        running: [[6.6, 6.5], [7.3, 7.8], [8.2, 8.5], [9.1, 9.0], [9.9, 9.3], [10.8, 10.5], [11.3, 11.0], [12.1, 11.8], [12.9, 12.0],
            [13.8, 12.5], [14.5, 13.0], [15.2, 14.8], [16.1, 14.8], [17.7, 16.8], [19.3, 18.5], [20.9, 19.8], [22.5, 23.0]],
        // 17170, 17190, 17200, 17220, 17230
        walking: [[4.0, 3.0], [5.0, 3.8], [6.0, 4.8], [6.8, 5.5], [7.6, 7.0]],
        // 01018, 01019, 01020, 01030, 01040, 01050, 01060
        cycling: [[8.9, 3.5], [15.1, 5.8], [17.7, 6.8], [20.9, 8.0], [24.1, 10.0], [28.2, 12.0], [32.2, 16.8]]
    };
    function cardioMetFromSpeed(sport, kmh) {
        var tb = SPEED_METS[sport], v = Number(kmh);
        if (!tb || !(v > 0)) return null;
        if (v <= tb[0][0]) return tb[0][1];
        for (var i = 1; i < tb.length; i++) {
            if (v <= tb[i][0]) {
                var a = tb[i - 1], b = tb[i];
                return Math.round((a[1] + (b[1] - a[1]) * (v - a[0]) / (b[0] - a[0])) * 10) / 10;
            }
        }
        return tb[tb.length - 1][1];
    }

    // Esfuerzo 1-10 de una sesión (escala CR-10): el que anotó o, si no, uno típico de su nivel
    // (baja 3, media 5, alta 7) o de su MET.
    function sessionRpe(s) {
        var r = Number(s && s.rpe);
        if (r >= 1 && r <= 10) return Math.round(r);
        if (s && [0, 1, 2].indexOf(s.level) >= 0) return [3, 5, 7][s.level];
        var m = Number(s && s.met) || 0;
        return m > 0 ? (m < 3 ? 3 : (m < 6 ? 5 : 7)) : 5;
    }
    // Carga de una sesión (método de Foster, 2001; validado en decenas de estudios, Haddad 2017):
    // esfuerzo × minutos, en unidades arbitrarias.
    function sessionLoad(s) { return Math.round(sessionRpe(s) * ((Number(s && s.duration) || 0) / 60)); }

    function isoOfDay(n) { return new Date((n - 1) * DAY_MS).toISOString().slice(0, 10); }

    // Totales de cardio entre dos fechas (incluidas): { count, minutes, km, kcal, load }.
    // sessions: [{ date, duration (s), distance (km), calories, rpe, level, met }].
    function cardioTotals(sessions, from, to) {
        var a = dayNum(from), b = dayNum(to), r = { count: 0, minutes: 0, km: 0, kcal: 0, load: 0 };
        (sessions || []).forEach(function (s) {
            if (!s || !s.date || !(s.duration > 0)) return;
            var n = dayNum(s.date);
            if (n < a || n > b) return;
            r.count++; r.minutes += s.duration / 60; r.km += Number(s.distance) || 0;
            r.kcal += Number(s.calories) || 0; r.load += sessionLoad(s);
        });
        r.minutes = Math.round(r.minutes); r.km = Math.round(r.km * 10) / 10; r.kcal = Math.round(r.kcal);
        return r;
    }
    // Últimas n semanas (lunes a domingo), de la más vieja a la actual: [{ start, ...totales }].
    function cardioWeeks(sessions, today, n) {
        var tn = dayNum(today), mon = tn - ((tn + 2) % 7), out = [];
        for (var k = (n || 8) - 1; k >= 0; k--) {
            var st = mon - 7 * k, r = cardioTotals(sessions, isoOfDay(st), isoOfDay(st + 6));
            r.start = isoOfDay(st); out.push(r);
        }
        return out;
    }
    // Últimos n meses calendario, del más viejo al actual: [{ month: 'YYYY-MM', ...totales }].
    function cardioMonths(sessions, today, n) {
        var y = +String(today).slice(0, 4), m = +String(today).slice(5, 7), out = [];
        for (var k = (n || 6) - 1; k >= 0; k--) {
            var yy = y, mm = m - k;
            while (mm < 1) { mm += 12; yy--; }
            var ms = yy + '-' + (mm < 10 ? '0' : '') + mm, last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
            var r = cardioTotals(sessions, ms + '-01', ms + '-' + (last < 10 ? '0' : '') + last);
            r.month = ms; out.push(r);
        }
        return out;
    }
    // Carga de los últimos 7 días contra el promedio semanal de las 4 semanas anteriores (días 8 a
    // 35). weeks = cuántas de esas semanas tuvieron cardio; pct = cuánto más (o menos) que el promedio.
    function cardioLoadTrend(sessions, today) {
        var tn = dayNum(today), acute = cardioTotals(sessions, isoOfDay(tn - 6), today).load, sum = 0, weeks = 0;
        for (var k = 1; k <= 4; k++) {
            var w = cardioTotals(sessions, isoOfDay(tn - 6 - 7 * k), isoOfDay(tn - 7 * k)).load;
            sum += w; if (w > 0) weeks++;
        }
        var avg = Math.round(sum / 4);
        return { acute: acute, avg: avg, weeks: weeks, pct: avg > 0 ? Math.round((acute / avg - 1) * 100) : null };
    }
    // Récords por deporte: { [sport]: { min, km, pace5, pace10, speed20 } }, cada uno { value, date }.
    // min = sesión más larga; km = distancia más larga; pace5 / pace10 = mejor ritmo (min/km, menos
    // es mejor) corriendo 5 o 10 km o más; speed20 = mejor velocidad (km/h) en bici en 20 km o más.
    function cardioRecords(sessions) {
        var rec = {};
        (sessions || []).forEach(function (s) {
            if (!s || !s.sport || !(s.duration > 0)) return;
            var r = rec[s.sport] || (rec[s.sport] = {}), min = s.duration / 60, km = Number(s.distance) || 0;
            var better = function (key, v, lower) {
                var cur = r[key];
                if (!cur || (lower ? v < cur.value : v > cur.value)) r[key] = { value: v, date: s.date };
            };
            better('min', Math.round(min), false);
            if (km > 0) {
                better('km', Math.round(km * 100) / 100, false);
                if (s.sport === 'running' && km >= 5) better('pace5', Math.round(min / km * 100) / 100, true);
                if (s.sport === 'running' && km >= 10) better('pace10', Math.round(min / km * 100) / 100, true);
                if (s.sport === 'cycling' && km >= 20) better('speed20', Math.round(km / (min / 60) * 10) / 10, false);
            }
        });
        return rec;
    }

    // ── Planes de running guiados ─────────────────────────────────────────
    // Cada sesión: calentamiento (warm) + `reps` veces un bloque de tramos + vuelta a la calma (cool).
    // Tramo = [tipo, segundos]. MET de cada tipo (Compendio 2024): caminar firme 3,8 (17190), trote
    // suave 7,5 (12020), correr suave 8,5 (12030, ~8 km/h), a ritmo 10,5 (12060), rápido 11,0 (12070).
    var RUN_KIND_MET = { walk: 3.8, jog: 7.5, easy: 8.5, tempo: 10.5, fast: 11.0 };
    var RS = function (warm, reps, block, cool) { return { warm: warm, reps: reps, block: block, cool: cool }; };
    var WALK5 = ['walk', 300];
    // De 0 a 5 km: 8 semanas, 3 sesiones iguales por semana. El tiempo trotando sube de 8 a 30 min
    // sin pasar de +25 % por semana: subir más de ~30 % por semana se asoció a más lesiones en
    // corredores novatos (Nielsen et al., J Orthop Sports Phys Ther 2014).
    var PLAN_5K = [
        RS(WALK5, 8, [['jog', 60], ['walk', 90]], WALK5),     //  8 min trotando
        RS(WALK5, 5, [['jog', 120], ['walk', 120]], WALK5),   // 10
        RS(WALK5, 4, [['jog', 180], ['walk', 90]], WALK5),    // 12
        RS(WALK5, 3, [['jog', 300], ['walk', 120]], WALK5),   // 15
        RS(WALK5, 3, [['jog', 360], ['walk', 90]], WALK5),    // 18
        RS(WALK5, 2, [['jog', 660], ['walk', 120]], WALK5),   // 22
        RS(WALK5, 2, [['jog', 780], ['walk', 90]], WALK5),    // 26
        RS(WALK5, 1, [['jog', 1800]], WALK5)                  // 30 seguidos
    ].map(function (x) { return [x, x, x]; });
    // De 5 a 10 km: 8 semanas, 3 salidas (suave, calidad, larga), la mayor parte suave (como el 80/20
    // de los corredores de fondo, Seiler 2010), semana 4 más liviana y la larga llega a 65 min (~10 km).
    var EASY = function (min) { return RS(null, 1, [['easy', min * 60]], null); };
    var INT = function (reps, fast, rec) { return RS(['easy', 600], reps, [['fast', fast * 60], ['jog', rec * 60]], ['easy', 300]); };
    var TEMPO = function (min) { return RS(['easy', 600], 1, [['tempo', min * 60]], ['easy', 300]); };
    var PLAN_10K = [
        [EASY(25), INT(4, 2, 2), EASY(35)],
        [EASY(28), INT(5, 2, 2), EASY(40)],
        [EASY(30), INT(4, 3, 2), EASY(45)],
        [EASY(25), INT(3, 3, 2), EASY(40)],   // más liviana
        [EASY(30), INT(5, 3, 2), EASY(50)],
        [EASY(32), TEMPO(15), EASY(55)],
        [EASY(35), TEMPO(20), EASY(60)],
        [EASY(30), INT(4, 3, 2), EASY(65)]
    ];
    var RUN_PLANS = { '5k': { id: '5k', weeks: PLAN_5K, next: '10k' }, '10k': { id: '10k', weeks: PLAN_10K } };

    // Tramos de una sesión, en orden: [[tipo, segundos], ...]
    function runSegments(sess) {
        var out = [];
        if (!sess) return out;
        if (sess.warm) out.push(sess.warm);
        for (var r = 0; r < (sess.reps || 1); r++) (sess.block || []).forEach(function (b) { out.push(b); });
        if (sess.cool) out.push(sess.cool);
        return out;
    }
    function runSessionSec(sess) { return runSegments(sess).reduce(function (a, x) { return a + x[1]; }, 0); }
    // Segundos corriendo (todo lo que no es caminar)
    function runSessionRunSec(sess) { return runSegments(sess).reduce(function (a, x) { return a + (x[0] === 'walk' ? 0 : x[1]); }, 0); }
    // MET promedio de la sesión, ponderado por tiempo (para las kcal: mezcla trote y caminata)
    function runSessionMet(sess) {
        var tot = runSessionSec(sess);
        if (!tot) return 0;
        var w = runSegments(sess).reduce(function (a, x) { return a + (RUN_KIND_MET[x[0]] || 0) * x[1]; }, 0);
        return Math.round(w / tot * 10) / 10;
    }
    // En qué tramo va a los `elapsed` segundos: { idx, left (s que le quedan), done }
    function runSegmentAt(segs, elapsed) {
        var t0 = 0, e = Math.max(0, Number(elapsed) || 0);
        for (var i = 0; i < (segs || []).length; i++) {
            if (e < t0 + segs[i][1]) return { idx: i, left: t0 + segs[i][1] - e, done: false };
            t0 += segs[i][1];
        }
        return { idx: (segs || []).length, left: 0, done: true };
    }
    // Próxima sesión del plan (la primera que no está hecha): { week, day } desde 1, o null si terminó.
    // done: ['1-1', '1-2', ...] (semana-sesión).
    function runPlanNext(planId, done) {
        var plan = RUN_PLANS[planId], set = {};
        if (!plan) return null;
        (done || []).forEach(function (k) { set[k] = true; });
        for (var w = 0; w < plan.weeks.length; w++) {
            for (var d = 0; d < plan.weeks[w].length; d++) {
                if (!set[(w + 1) + '-' + (d + 1)]) return { week: w + 1, day: d + 1 };
            }
        }
        return null;
    }
    function runPlanSession(planId, week, day) {
        var plan = RUN_PLANS[planId];
        return plan && plan.weeks[week - 1] ? plan.weeks[week - 1][day - 1] || null : null;
    }

    // ── Importar entrenamientos (archivos GPX / TCX de Strava, Garmin y otros relojes) ──
    function isPos(p) { return p && isFinite(p.lat) && isFinite(p.lon) && p.lat !== null && p.lon !== null && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180; }
    function haversineM(a, b) {
        var R = 6371000, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
        var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
    }
    // Resumen de un recorrido. points: [{ t (ms), lat, lon, hr, d (metros acumulados del reloj, opcional) }].
    // Tiempo en movimiento como las apps: suma los tramos de hasta 30 s que van a 0,5 m/s o más (las
    // paradas no cuentan). Sin posición ni distancia (cinta), todo el tiempo cuenta. Pulso promedio
    // ponderado por tiempo. Devuelve { km, elapsedSec, movingSec, hrAvg, hrMax, start } o null.
    function trackSummary(points) {
        var pts = (points || []).filter(function (p) { return p && p.t > 0; }).sort(function (a, b) { return a.t - b.t; });
        if (pts.length < 2) return null;
        var hasD = pts.some(function (p) { return p.d >= 0 && p.d !== null; }), hasPos = pts.some(isPos);
        var dist = 0, moving = 0, hrSum = 0, hrT = 0, hrMax = pts[0].hr > 0 ? pts[0].hr : 0;
        for (var i = 1; i < pts.length; i++) {
            var a = pts[i - 1], b = pts[i], dt = (b.t - a.t) / 1000;
            var dd = (hasD && a.d >= 0 && b.d >= 0 && a.d !== null && b.d !== null) ? Math.max(0, b.d - a.d) : (isPos(a) && isPos(b) ? haversineM(a, b) : 0);
            dist += dd;
            if (dt > 0 && dt <= 30 && (!(hasD || hasPos) || dd / dt >= 0.5)) moving += dt;
            if (b.hr > 0 && dt > 0 && dt <= 30) { hrSum += b.hr * dt; hrT += dt; }
            if (b.hr > hrMax) hrMax = b.hr;
        }
        return {
            km: Math.round(dist / 10) / 100, elapsedSec: Math.round((pts[pts.length - 1].t - pts[0].t) / 1000),
            movingSec: Math.round(moving), hrAvg: hrT ? Math.round(hrSum / hrT) : null, hrMax: hrMax || null, start: pts[0].t
        };
    }
    // Deporte del archivo: por el tipo que trae (Strava: 9 correr, 1 bici, 10 caminar; TCX: Running,
    // Biking) o, si no dice, por la velocidad promedio.
    function importSport(type, kmh) {
        var x = String(type || '').toLowerCase().trim();
        if (/run|corr|trail|^9$/.test(x)) return 'running';
        if (/bik|cycl|ride|bici|^1$/.test(x)) return 'cycling';
        if (/walk|camin|^10$/.test(x)) return 'walking';
        if (/hik|sender/.test(x)) return 'hiking';
        if (/swim|nata/.test(x)) return 'swimming';
        if (/row|remo/.test(x)) return 'rowing';
        var v = Number(kmh) || 0;
        return v >= 16 ? 'cycling' : (v >= 7 ? 'running' : 'walking');
    }

    // ── Oracle: el diagnóstico lo calcula la app; la IA solo lo explica ──────────
    // Auditoría del 19-nov-2026: con datos sueltos la IA confundía el mantenimiento con el objetivo,
    // inventaba desbalances, tomaba registros incompletos como reales y no veía la fatiga. Acá se
    // decide QUÉ decir con las reglas de la app; el Worker le pide a la IA que lo cuente.
    // o = { user, sessions, cardio, food, weights, today, wantsNutrition }.
    // Devuelve hasta 5 hallazgos { code, sev: 'warn'|'info'|'good', facts }, los importantes primero.
    var ORACLE_ORDER = ['fast_load', 'deficit_too_big', 'fatigue', 'no_deficit', 'below_maint_gain', 'loss_fast', 'volume_high',
        'adherence_low', 'protein_low', 'food_incomplete', 'food_none', 'stalled', 'imbalance', 'volume_low', 'weight_flat', 'cardio_short',
        'progress', 'holding_strength', 'deficit_ok', 'loss_ok', 'surplus_ok', 'adherence_good', 'cardio_done'];
    function oracleFindings(o) {
        var u = (o && o.user) || {}, today = o && o.today;
        if (!today) return [];
        var t = dayNum(today), goal = u.goal || 'muscle', age = Number(u.age) || 0, bw = Number(u.weight) || 0;
        var all = [], add = function (code, sev, facts) { all.push({ code: code, sev: sev, facts: facts || {} }); };
        var sessions = ((o && o.sessions) || []).filter(function (x) { return x && x.date && dayNum(x.date) <= t; });
        var win = sessions.filter(function (x) { return t - dayNum(x.date) < 28; });
        var r1 = function (x) { return Math.round(x * 10) / 10; };

        // Constancia: semanas completas (lunes a domingo) antes de la actual, desde la primera sesión
        var monday = t - ((t + 2) % 7), planned = Math.max(1, Math.min(7, Number(u.days) || 3));
        var first = sessions.reduce(function (m, x) { return Math.min(m, dayNum(x.date)); }, Infinity);
        var done = 0, weeks = 0;
        for (var w = 1; w <= 4; w++) {
            var ws = monday - 7 * w, we = ws + 6;
            if (we < first) break;
            weeks++;
            var days = {};
            sessions.forEach(function (x) { var n = dayNum(x.date); if (n >= ws && n <= we) days[x.date] = true; });
            done += Math.min(planned, Object.keys(days).length);
        }
        if (weeks >= 2) {
            var ratio = done / (planned * weeks);
            if (ratio < 0.7) add('adherence_low', 'warn', { done: done, planned: planned * weeks, weeks: weeks });
            else if (ratio >= 0.9) add('adherence_good', 'good', { done: done, planned: planned * weeks, weeks: weeks });
        }

        // Ejercicios: 1RM estimado (peso y repeticiones) de las 2 primeras semanas contra las 2 últimas
        var perf = performanceSignals(sessions, today);
        var fatigued = {};
        perf.fatigued.forEach(function (n) { fatigued[n.toLowerCase()] = true; });
        var byEx = {};
        win.forEach(function (x) {
            var d = t - dayNum(x.date);
            (x.exercises || []).forEach(function (e) {
                var name = String((e && (e.exercise || e.name)) || '').trim(), pf = name && sessionPerf(e.sets);
                if (!pf) return;
                var k = name.toLowerCase(), r = byEx[k] || (byEx[k] = { name: name, n: 0, a: null, b: null, kind: pf.kind });
                if (pf.kind !== r.kind) return;
                r.n++;
                if (d >= 14) r.a = Math.max(r.a || 0, pf.value); else r.b = Math.max(r.b || 0, pf.value);
            });
        });
        var lifts = Object.keys(byEx).map(function (k) { return byEx[k]; })
            .filter(function (r) { return r.n >= 3 && r.a > 0 && r.b > 0; })
            .sort(function (x, y) { return y.n - x.n; }).slice(0, 6)
            .map(function (r) { return { name: r.name, pct: Math.round((r.b / r.a - 1) * 100), fatigued: !!fatigued[r.name.toLowerCase()] }; });
        var fast = lifts.filter(function (l) { return l.pct >= 15; }).sort(function (x, y) { return y.pct - x.pct; })[0];
        if (age >= 60 && fast) add('fast_load', 'warn', { ex: fast.name, pct: fast.pct, age: age });
        if (perf.fatigued.length >= 2) add('fatigue', 'warn', { exs: perf.fatigued.slice(0, 3) });
        var up = lifts.filter(function (l) { return l.pct >= 3; }).slice(0, 3);
        // Con el aviso de prudencia (60+ subiendo rápido) no se festeja la misma suba
        if (up.length && !(age >= 60 && fast)) add('progress', 'good', { exs: up.map(function (l) { return l.name; }), pct: up[0].pct });
        var flat = lifts.filter(function (l) { return l.pct < 1 && !l.fatigued; }).map(function (l) { return l.name; });
        // "Mantener" (con déficit o en resistencia): ni sube ni baja más de un 3 %
        var held = lifts.filter(function (l) { return l.pct > -3 && l.pct < 3 && !l.fatigued; }).map(function (l) { return l.name; });

        // Volumen por semana de cada músculo (series fraccionales, como el mapa del cuerpo)
        var span = win.length ? Math.max(1, Math.min(4, Math.ceil((t - win.reduce(function (m, x) { return Math.min(m, dayNum(x.date)); }, t) + 1) / 7))) : 1;
        var ms = muscleSets(win), perWeek = {};
        MUSCLES.forEach(function (m) { perWeek[m] = r1(ms[m] / span); });
        var high = MUSCLES.filter(function (m) { return perWeek[m] > 22; });
        if (win.length >= 4 && high.length) add('volume_high', 'warn', { muscles: high.slice(0, 3), sets: Math.round(Math.max.apply(null, high.map(function (m) { return perWeek[m]; }))) });
        if (win.length >= 4 && span >= 2) {
            var pairs = [['chest', 'lats', 1.6], ['quads', 'hamstrings', 2.5]];
            for (var i = 0; i < pairs.length; i++) {
                var a = perWeek[pairs[i][0]], b = perWeek[pairs[i][1]];
                if (a >= 6 && a / Math.max(b, 0.5) >= pairs[i][2]) { add('imbalance', 'info', { a: pairs[i][0], aSets: Math.round(a), b: pairs[i][1], bSets: Math.round(b) }); break; }
            }
            if ((goal === 'muscle' || goal === 'recomp') && !high.length && !all.some(function (f) { return f.code === 'adherence_low'; })) {   // con poca constancia, lo que falta es ir más seguido
                var low = ['chest', 'lats', 'quads', 'glutes', 'shoulders'].filter(function (m) { return perWeek[m] < 4; });
                if (low.length >= 2) add('volume_low', 'info', { muscles: low.slice(0, 3) });
            }
        }

        // Comida: los 7 días anteriores a hoy, solo los registrados en serio (800 kcal o más)
        var nutrition = o.wantsNutrition !== false;
        var deficit = false;
        if (nutrition) {
            var foodDays = {};
            ((o && o.food) || []).forEach(function (e) {
                if (!e || !e.date) return;
                var d = t - dayNum(e.date);
                if (d < 1 || d > 7) return;
                var r = foodDays[e.date] || (foodDays[e.date] = { kcal: 0, prot: 0 });
                r.kcal += Number(e.kcal) || 0; r.prot += Number(e.protein) || 0;
            });
            var logged = Object.keys(foodDays).map(function (k) { return foodDays[k]; }).filter(function (r) { return r.kcal >= 800; });
            var anyFood = ((o && o.food) || []).length > 0;
            if (!logged.length) add(anyFood ? 'food_incomplete' : 'food_none', 'info', { days: 0 });
            else if (logged.length < 4) add('food_incomplete', 'info', { days: logged.length });
            else {
                var kcal = Math.round(logged.reduce(function (s2, r) { return s2 + r.kcal; }, 0) / logged.length);
                var prot = Math.round(logged.reduce(function (s2, r) { return s2 + r.prot; }, 0) / logged.length);
                var maint = maintenanceOf(u), mac = calcMacros(u), diff = kcal - maint;
                var floor = u.sex === 'F' ? 1200 : 1500;
                if (diff < -1000 || kcal < floor) { add('deficit_too_big', 'warn', { kcal: kcal, maint: maint }); deficit = true; }
                else if (goal === 'fat_loss') {
                    if (diff > -100) add('no_deficit', 'warn', { kcal: kcal, maint: maint, target: mac.targetCals });
                    else { add('deficit_ok', 'good', { kcal: kcal, maint: maint }); deficit = true; }
                } else if (goal === 'muscle' || goal === 'strength') {
                    if (diff < -100) { add('below_maint_gain', 'warn', { kcal: kcal, maint: maint, target: mac.targetCals }); deficit = true; }
                    else if (diff <= 700) add('surplus_ok', 'good', { kcal: kcal, maint: maint });
                }
                if (bw > 0 && prot < mac.protein * 0.8) add('protein_low', 'warn', { prot: prot, perKg: r1(prot / bw), target: mac.protein });
            }
        }

        // Peso de tendencia (si hay al menos 4 pesadas en 14 días o más del último mes)
        var tr = weightTrend(((o && o.weights) || []).filter(function (x) { return x && x.date && t - dayNum(x.date) < 28 && dayNum(x.date) <= t; }));
        if (tr.length >= 4) {
            var daysW = dayNum(tr[tr.length - 1].date) - dayNum(tr[0].date);
            if (daysW >= 14 && bw > 0) {
                var rate = (tr[tr.length - 1].trend - tr[0].trend) / daysW * 7, pctW = rate / bw * 100;
                if (goal === 'fat_loss') {
                    if (pctW < -1) add('loss_fast', 'warn', { rate: r1(rate) });
                    else if (pctW <= -0.2) { add('loss_ok', 'good', { rate: r1(rate) }); deficit = true; }
                    else if (!all.some(function (f) { return f.code === 'no_deficit'; })) add('weight_flat', 'info', { rate: r1(rate) });
                }
            }
        }
        // Estancados: con déficit (o en resistencia) mantener la fuerza ya es un buen resultado
        if ((goal === 'fat_loss' && deficit) || goal === 'endurance') {
            if (held.length >= 2) add('holding_strength', 'good', { exs: held.slice(0, 3) });
        } else if (flat.length >= 2 && !up.length && perf.fatigued.length < 2) add('stalled', 'info', { exs: flat.slice(0, 3) });   // si algo sube, los accesorios quietos no son un problema

        // Cardio de la semana pasada contra la meta (perder grasa y resistencia)
        if (goal === 'fat_loss' || goal === 'endurance') {
            var sun = monday - 1, cw = cardioWeek((o && o.cardio) || [], isoOfDay(sun), { weightOf: function (x) { return Number(x && x.met) > 0 ? cardioMinuteWeight(x.met) : 1; } });
            if (cw.minutes >= cw.target) add('cardio_done', 'good', { min: cw.minutes, target: cw.target });
            else if (cw.minutes < cw.target * 0.6) add('cardio_short', 'info', { min: cw.minutes, target: cw.target });
        }

        // Orden: lo que pide atención primero; como mucho 2 cosas buenas y 5 en total
        all.sort(function (x, y) { return ORACLE_ORDER.indexOf(x.code) - ORACLE_ORDER.indexOf(y.code); });
        var bad = all.filter(function (f) { return f.sev !== 'good'; }), good = all.filter(function (f) { return f.sev === 'good'; });
        // Con 0 o 1 aviso entran hasta 3 cosas buenas (si todo va bien, que se diga qué)
        var pick = bad.slice(0, good.length ? 4 : 5);
        return pick.concat(good.slice(0, Math.min(bad.length >= 2 ? 2 : 3, 5 - pick.length)));
    }

    // Frecuencia cardíaca máxima estimada (Tanaka, Monahan y Seals 2001): 208 − 0,7 × edad.
    // Menos sesgada que 220 − edad, que se queda corta en mayores; las dos erran ±7-12 lpm,
    // por eso el usuario puede poner la suya.
    function maxHrEstimate(age) {
        var a = Number(age) > 0 ? Number(age) : 30;
        return Math.round(208 - 0.7 * a);
    }

    // Series para precargar al registrar: las de la última vez que hizo ese
    // ejercicio o, si nunca lo registró, las del plan (series × reps @ kg; '8-12' → 8).
    function prefillSets(name, sessions, plan) {
        var list = sessions || [];
        for (var i = 0; i < list.length; i++) {
            var exs = (list[i] && list[i].exercises) || [];
            for (var j = 0; j < exs.length; j++) {
                if (sameExercise(exs[j].name, name) && exs[j].sets && exs[j].sets.length) {
                    return exs[j].sets.map(function (s) { return { kg: Number(s.kg) || 0, reps: Number(s.reps) || 0 }; });
                }
            }
        }
        var n = Math.min(Math.max(parseInt(plan && plan.sets, 10) || 3, 1), 12);
        var m = String((plan && plan.reps) || '').match(/\d+/);
        var reps = m ? parseInt(m[0], 10) : 0, kg = Number(plan && plan.kg) || 0;
        var out = [];
        for (var k = 0; k < n; k++) out.push({ kg: kg, reps: reps });
        return out;
    }

    // ── Registro del período (opcional, solo mujeres; los datos quedan en el teléfono) ──
    // No cambia el entrenamiento: entrenar según la fase no dio ventaja en músculo ni
    // fuerza (D'Souza…Phillips, MSSE 2026; Colenso-Semple 2023). Sirve para la salud:
    // que el período falte 3 meses o más (amenorrea) es señal de comer poco para lo que se
    // entrena (consenso REDs del COI, 2023), y ciclos de más de 35 días también se
    // consultan. starts: fechas 'YYYY-MM-DD' de inicio. Devuelve null sin datos o
    // { last, daysSince, avg, lastLen, next, missing, long }.
    var CYCLE_MISSING_DAYS = 90, CYCLE_LONG_DAYS = 35;
    function cycleStatus(starts, today) {
        var seen = {}, list = [];
        (starts || []).forEach(function (s) {
            if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(dayNum(s)) || seen[s]) return;
            seen[s] = 1; list.push(s);
        });
        var t = dayNum(today);
        list = list.filter(function (s) { return dayNum(s) <= t; }).sort().reverse();
        if (!list.length) return null;
        var lens = [];
        for (var i = 0; i + 1 < list.length && lens.length < 6; i++) lens.push(dayNum(list[i]) - dayNum(list[i + 1]));
        // Para el promedio, solo ciclos plausibles (un período sin registrar duplica el largo)
        var ok = lens.filter(function (n) { return n >= 15 && n <= 60; });
        var avg = ok.length ? Math.round(ok.reduce(function (a, b) { return a + b; }, 0) / ok.length) : null;
        var daysSince = t - dayNum(list[0]);
        var next = null;
        if (avg) { var d = new Date(Date.parse(list[0] + 'T12:00:00Z') + avg * DAY_MS); next = d.toISOString().slice(0, 10); }
        return {
            last: list[0], daysSince: daysSince, avg: avg, lastLen: lens.length ? lens[0] : null, next: next,
            missing: daysSince >= CYCLE_MISSING_DAYS,
            long: lens.length > 0 && lens[0] > CYCLE_LONG_DAYS && lens[0] < CYCLE_MISSING_DAYS
        };
    }

    return {
        cycleStatus: cycleStatus,
        localDateStr: localDateStr,
        isoWeek: isoWeek,
        topSet: topSet,
        exerciseTrend: exerciseTrend,
        prefillSets: prefillSets,
        cardioWeek: cardioWeek,
        cardioMinuteWeight: cardioMinuteWeight,
        cardioDailyAvg: cardioDailyAvg,
        maxHrEstimate: maxHrEstimate,
        cardioMetFromSpeed: cardioMetFromSpeed,
        sessionRpe: sessionRpe,
        sessionLoad: sessionLoad,
        cardioTotals: cardioTotals,
        cardioWeeks: cardioWeeks,
        cardioMonths: cardioMonths,
        cardioLoadTrend: cardioLoadTrend,
        cardioRecords: cardioRecords,
        RUN_PLANS: RUN_PLANS,
        RUN_KIND_MET: RUN_KIND_MET,
        runSegments: runSegments,
        runSessionSec: runSessionSec,
        runSessionRunSec: runSessionRunSec,
        runSessionMet: runSessionMet,
        runSegmentAt: runSegmentAt,
        runPlanNext: runPlanNext,
        runPlanSession: runPlanSession,
        trackSummary: trackSummary,
        oracleFindings: oracleFindings,
        ORACLE_ORDER: ORACLE_ORDER,
        importSport: importSport,
        sessionPerf: sessionPerf,
        performanceSignals: performanceSignals,
        planMuscleSets: planMuscleSets,
        adjustMuscleVolume: adjustMuscleVolume,
        MUSCLES: MUSCLES,
        muscleTargets: muscleTargets,
        muscleSets: muscleSets,
        maintenanceOf: maintenanceOf,
        weightTrend: weightTrend,
        adaptiveTDEE: adaptiveTDEE,
        platesPerSide: platesPerSide,
        warmupSets: warmupSets,
        exerciseGear: exerciseGear,
        workingWeight: workingWeight,
        lastExerciseEntry: lastExerciseEntry,
        dumbbellGrid: dumbbellGrid,
        seenStep: seenStep,
        loadStep: loadStep,
        nextLoad: nextLoad,
        pushLoad: pushLoad,
        calcTDEE: calcTDEE,
        calcMacros: calcMacros,
        proteinWeight: proteinWeight,
        formatPortion: formatPortion,
        calcDailyBalance: calcDailyBalance,
        calc1RM: calc1RM,
        cardioKcal: cardioKcal,
        strengthKcal: strengthKcal
    };
});
