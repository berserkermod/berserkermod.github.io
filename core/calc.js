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
    // Devuelve { minutes, target, remaining, done, daysLeft (contando hoy), avgPrev }.
    function cardioWeek(sessions, today, opts) {
        var o = opts || {}, lo = o.min || 150, hi = o.max || 300;
        var t = dayNum(today);
        // dayNum('1970-01-01') es 1 (redondea al mediodía) y fue jueves: (n + 2) % 7 = 0 el lunes
        var monday = function (n) { return n - ((n + 2) % 7); };
        var cur = monday(t), byWeek = {};
        (sessions || []).forEach(function (s) {
            if (!s || !s.date || !(s.duration > 0)) return;
            var n = dayNum(s.date);
            if (n > t) return;
            var w = monday(n);
            byWeek[w] = (byWeek[w] || 0) + s.duration / 60;
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
