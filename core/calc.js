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

    // TDEE + ajuste calórico por objetivo + split proteína/grasa/carbo.
    // Devuelve { tdee, adj, targetCals, protein, carbs, fat }.
    function calcMacros(u) {
        if (!u) return { tdee: 2000, adj: 0, targetCals: 2000, protein: 150, carbs: 200, fat: 70 };
        var tdee = maintenanceOf(u);
        var adj = { muscle: 400, fat_loss: -400, strength: 300, recomp: 0, endurance: 200 }[u.goal] || 0;
        var targetCals = Math.max(1200, tdee + adj);

        var proteinPerKg = { muscle: 2.0, fat_loss: 2.2, strength: 2.0, recomp: 2.2, endurance: 1.6 }[u.goal] || 2.0;
        var protein = Math.round(u.weight * proteinPerKg);

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
    function calcDailyBalance(u, consumed, burned) {
        var maintenance = maintenanceOf(u);
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

    // kcal de cardio = MET × factor_intensidad × peso(kg) × horas.
    // (Compendium of Physical Activities, valores de intensidad media.)
    function cardioKcal(met, intensity, weightKg, seconds) {
        return Math.round((met || 0) * (intensity || 1) * (weightKg || 0) * ((seconds || 0) / 3600));
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

    return {
        isoWeek: isoWeek,
        topSet: topSet,
        exerciseTrend: exerciseTrend,
        prefillSets: prefillSets,
        MUSCLES: MUSCLES,
        muscleTargets: muscleTargets,
        muscleSets: muscleSets,
        maintenanceOf: maintenanceOf,
        weightTrend: weightTrend,
        adaptiveTDEE: adaptiveTDEE,
        platesPerSide: platesPerSide,
        warmupSets: warmupSets,
        calcTDEE: calcTDEE,
        calcMacros: calcMacros,
        formatPortion: formatPortion,
        calcDailyBalance: calcDailyBalance,
        calc1RM: calc1RM,
        cardioKcal: cardioKcal
    };
});
