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

    // TDEE + ajuste calórico por objetivo + split proteína/grasa/carbo.
    // Devuelve { tdee, adj, targetCals, protein, carbs, fat }.
    function calcMacros(u) {
        if (!u) return { tdee: 2000, adj: 0, targetCals: 2000, protein: 150, carbs: 200, fat: 70 };
        var tdee = calcTDEE(u);
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
    function formatPortion(grams, unit) {
        if (unit && unit.kind === 'count') {
            var n = Math.max(1, Math.round(grams / (unit.g || 50)));
            var lbl = n === 1 ? (unit.label || 'u') : (unit.labelP || unit.label || 'u');
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
        var maintenance = calcTDEE(u);
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

    return {
        calcTDEE: calcTDEE,
        calcMacros: calcMacros,
        formatPortion: formatPortion,
        calcDailyBalance: calcDailyBalance,
        calc1RM: calc1RM,
        cardioKcal: cardioKcal
    };
});
