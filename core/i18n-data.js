// BERSERKERMOD — traducciones de los DATOS
// =====================================================================
// Ejercicios, biblioteca, notas del generador de rutinas, deportes y frases
// se guardan en español (así quedan en el historial, en las rutinas y en los
// links del Coach) y se traducen recién al mostrarlos, según el idioma elegido.
// Clave: el texto en español tal cual está en BERSERKERMOD.html → [inglés, portugués].
//
// Si agregás un ejercicio, un consejo, una nota o un deporte en español,
// agregá acá su traducción: test/i18n-data.test.mjs falla si falta.
// Se carga con <script src> (globales en el browser) y en Node con require.
// =====================================================================
(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') { Object.assign(window, api); }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Grupos musculares, días de Libre y palabras sueltas de los datos
    var LABELS = {
        'Pecho': ['Chest', 'Peito'], 'Espalda': ['Back', 'Costas'], 'Piernas': ['Legs', 'Pernas'],
        'Hombros': ['Shoulders', 'Ombros'], 'Brazos': ['Arms', 'Braços'], 'Core': ['Core', 'Core'],
        'Bíceps': ['Biceps', 'Bíceps'], 'Tríceps': ['Triceps', 'Tríceps'], 'Cuádriceps': ['Quads', 'Quadríceps'],
        'Glúteo': ['Glutes', 'Glúteos'], 'Glúteos': ['Glutes', 'Glúteos'], 'Femoral': ['Hamstrings', 'Posterior de coxa'],
        'Posterior': ['Posterior chain', 'Cadeia posterior'],
        'EMPUJES': ['PUSH', 'EMPURRAR'], 'TRACCIÓN': ['PULL', 'PUXAR'], 'PIERNAS 1': ['LEGS 1', 'PERNAS 1'],
        'PIERNAS 2': ['LEGS 2', 'PERNAS 2'], 'BRAZOS': ['ARMS', 'BRAÇOS'], 'CORE': ['CORE', 'CORE'], 'FULL BODY': ['FULL BODY', 'CORPO INTEIRO'],
        'lado': ['side', 'lado'], 'Otro': ['Other', 'Outro'], 'Importado': ['Imported', 'Importado']
    };
    // "Día 3" (rutinas importadas de PDF, días sin nombre) → "Day 3" / "Dia 3"
    var PATTERNS = [
        [/^Día (\d+)$/, ['Day $1', 'Dia $1']],
        [/^DÍA (\d+)$/, ['DAY $1', 'DIA $1']]
    ];

    // Nombres de ejercicios (Libre, generador de rutinas y biblioteca)
    var EXERCISES = {
        'Press Banca Plano': ['Flat Bench Press', 'Supino Reto'],
        'Press Banca': ['Bench Press', 'Supino'],
        'Press Banca Inclinado': ['Incline Bench Press', 'Supino Inclinado'],
        'Press Inclinado': ['Incline Press', 'Supino Inclinado'],
        'Press Inclinado con Barra': ['Barbell Incline Press', 'Supino Inclinado com Barra'],
        'Press Inclinado Mancuernas': ['Incline Dumbbell Press', 'Supino Inclinado com Halteres'],
        'Press Banca Mancuernas': ['Dumbbell Bench Press', 'Supino com Halteres'],
        'Press Militar': ['Overhead Press', 'Desenvolvimento Militar'],
        'Press Militar de Pie': ['Standing Overhead Press', 'Desenvolvimento Militar em Pé'],
        'Press Arnold': ['Arnold Press', 'Desenvolvimento Arnold'],
        'Fondos Paralelas': ['Parallel Bar Dips', 'Mergulho nas Paralelas'],
        'Fondos en Paralelas': ['Parallel Bar Dips', 'Mergulho nas Paralelas'],
        'Fondos Banco': ['Bench Dips', 'Mergulho no Banco'],
        'Aperturas Pec Deck': ['Pec Deck Fly', 'Voador (Pec Deck)'],
        'Cruces Polea': ['Cable Crossover', 'Crossover na Polia'],
        'Cruces con Polea': ['Cable Crossover', 'Crossover na Polia'],
        'Press Francés': ['Skull Crusher', 'Tríceps Testa'],
        'Pushdown': ['Triceps Pushdown', 'Tríceps na Polia'],
        'Pushdown Polea': ['Cable Pushdown', 'Tríceps na Polia'],
        'Pushdown con Polea': ['Cable Pushdown', 'Tríceps na Polia'],
        'Pushdown Cuerda': ['Rope Pushdown', 'Tríceps Corda'],
        'Pushdown Tríceps': ['Triceps Pushdown', 'Tríceps na Polia'],
        'Extensión Overhead': ['Overhead Triceps Extension', 'Tríceps Francês'],
        'Dominadas': ['Pull-ups', 'Barra Fixa'],
        'Jalón Polea': ['Lat Pulldown', 'Puxada Alta'],
        'Jalón Polea al Pecho': ['Lat Pulldown to Chest', 'Puxada Alta na Frente'],
        'Remo Barra': ['Barbell Row', 'Remada Curvada'],
        'Remo con Barra': ['Barbell Row', 'Remada Curvada'],
        'Remo Mancuerna': ['Dumbbell Row', 'Remada Unilateral'],
        'Remo con Mancuerna': ['One-Arm Dumbbell Row', 'Remada Unilateral com Halter'],
        'Remo Polea Baja': ['Seated Cable Row', 'Remada Baixa'],
        'Peso Muerto': ['Deadlift', 'Levantamento Terra'],
        'Peso Muerto Convencional': ['Conventional Deadlift', 'Levantamento Terra Convencional'],
        'Peso Muerto Rumano': ['Romanian Deadlift', 'Levantamento Terra Romeno'],
        'Curl Bíceps': ['Biceps Curl', 'Rosca Bíceps'],
        'Curl Bíceps Barra': ['Barbell Curl', 'Rosca Direta'],
        'Curl con Barra': ['Barbell Curl', 'Rosca Direta'],
        'Curl Mancuernas': ['Dumbbell Curl', 'Rosca com Halteres'],
        'Curl Martillo': ['Hammer Curl', 'Rosca Martelo'],
        'Curl Predicador': ['Preacher Curl', 'Rosca Scott'],
        'Curl Femoral': ['Leg Curl', 'Mesa Flexora'],
        'Sentadilla': ['Squat', 'Agachamento'],
        'Sentadilla con Barra': ['Barbell Back Squat', 'Agachamento Livre'],
        'Sentadilla Búlgara': ['Bulgarian Split Squat', 'Agachamento Búlgaro'],
        'Zancadas': ['Lunges', 'Afundo'],
        'Zancadas Búlgaras': ['Bulgarian Split Squats', 'Agachamento Búlgaro'],
        'Prensa Piernas': ['Leg Press', 'Leg Press'],
        'Prensa de Piernas': ['Leg Press', 'Leg Press'],
        'Extensión Cuádriceps': ['Leg Extension', 'Cadeira Extensora'],
        'Hip Thrust con Barra': ['Barbell Hip Thrust', 'Elevação Pélvica com Barra'],
        'Pantorrilla Pie': ['Standing Calf Raise', 'Panturrilha em Pé'],
        'Pantorrilla Sentado': ['Seated Calf Raise', 'Panturrilha Sentado'],
        'Abductor': ['Hip Abduction', 'Abdutora'],
        'Abductor en Máquina': ['Hip Abduction Machine', 'Cadeira Abdutora'],
        'Aductor': ['Hip Adduction', 'Adutora'],
        'Elevaciones Laterales': ['Lateral Raises', 'Elevação Lateral'],
        'Elevaciones Posteriores': ['Rear Delt Raises', 'Crucifixo Inverso'],
        'Encogimientos': ['Shrugs', 'Encolhimento'],
        'Plancha': ['Plank', 'Prancha'],
        'Plancha Lateral': ['Side Plank', 'Prancha Lateral'],
        'Crunch Clásico': ['Crunch', 'Abdominal Tradicional'],
        'Crunch en Polea': ['Cable Crunch', 'Abdominal na Polia'],
        'Elevación de Piernas Tumbado': ['Lying Leg Raise', 'Elevação de Pernas Deitado'],
        'Elevación de Piernas Colgado': ['Hanging Leg Raise', 'Elevação de Pernas na Barra'],
        'Elevación de Rodillas Colgado': ['Hanging Knee Raise', 'Elevação de Joelhos na Barra'],
        'Saltar la Cuerda': ['Jump Rope', 'Pular Corda'],
        'Boxeo (Shadow / Bag)': ['Boxing (Shadow / Bag)', 'Boxe (Sombra / Saco)']
    };

    // Deportes de Cardio
    var SPORTS = {
        'Ciclismo': ['Cycling', 'Ciclismo'], 'Caminata': ['Walking', 'Caminhada'], 'Boxeo': ['Boxing', 'Boxe'],
        'Natación': ['Swimming', 'Natação'], 'Saltar Cuerda': ['Jump Rope', 'Pular Corda'], 'Fútbol': ['Soccer', 'Futebol'],
        'Basketball': ['Basketball', 'Basquete'], 'Remo': ['Rowing', 'Remo'], 'Tenis': ['Tennis', 'Tênis'],
        'Artes Marciales': ['Martial Arts', 'Artes Marciais'], 'Pádel': ['Padel', 'Padel'], 'Elíptica': ['Elliptical', 'Elíptico'],
        'Escaladora': ['Stair Climber', 'Escada'], 'Funcional': ['Functional Training', 'Funcional'], 'Baile': ['Dance', 'Dança'],
        'Senderismo': ['Hiking', 'Trilha'], 'Vóley': ['Volleyball', 'Vôlei'], 'Patín': ['Skating', 'Patinação'],
        'Escalada': ['Climbing', 'Escalada']
    };

    // Frases de Inicio
    var QUOTES = {
        'El dolor que sientes hoy será la fuerza que sientas mañana.': ["The pain you feel today will be the strength you feel tomorrow.", 'A dor que você sente hoje será a força que vai sentir amanhã.'],
        'No pares cuando llegue el cansancio. Pará cuando hayas terminado.': ["Don't stop when you're tired. Stop when you're done.", 'Não pare quando bater o cansaço. Pare quando tiver terminado.'],
        'Tu cuerpo puede soportar casi todo. Es tu mente la que tenés que convencer.': ['Your body can handle almost anything. It’s your mind you have to convince.', 'Seu corpo aguenta quase tudo. É a sua mente que você precisa convencer.'],
        'La disciplina supera a la motivación.': ['Discipline beats motivation.', 'Disciplina supera motivação.'],
        'Cada repetición te acerca a tu mejor versión.': ['Every rep brings you closer to your best self.', 'Cada repetição te aproxima da sua melhor versão.'],
        'El único entrenamiento malo es el que no se hizo.': ['The only bad workout is the one you skipped.', 'O único treino ruim é o que não foi feito.'],
        'Sé más fuerte que tus excusas.': ['Be stronger than your excuses.', 'Seja mais forte que suas desculpas.'],
        'Hoy es un buen día para ser mejor que ayer.': ['Today is a good day to be better than yesterday.', 'Hoje é um bom dia para ser melhor que ontem.'],
        'La constancia vence al talento.': ['Consistency beats talent.', 'A constância vence o talento.'],
        'No busques resultados rápidos. Buscá resultados duraderos.': ["Don't chase quick results. Chase lasting ones.", 'Não busque resultados rápidos. Busque resultados duradouros.'],
        'El gimnasio no te pide explicaciones, solo constancia.': ["The gym doesn't ask for explanations, only consistency.", 'A academia não pede explicações, só constância.'],
        'Entrená como si tu futuro dependiera de eso. Porque depende.': ['Train like your future depends on it. Because it does.', 'Treine como se o seu futuro dependesse disso. Porque depende.'],
        'Los límites solo existen en tu mente.': ['Limits only exist in your mind.', 'Os limites só existem na sua mente.'],
        'Cada día que entrenás estás invirtiendo en vos.': ['Every day you train, you invest in yourself.', 'Cada dia que você treina é um investimento em você.'],
        'No se trata de ser el mejor. Se trata de ser mejor que ayer.': ["It's not about being the best. It's about being better than yesterday.", 'Não se trata de ser o melhor. Se trata de ser melhor que ontem.']
    };

    // Generador de rutinas: nombres de los días, focos y notas de cada ejercicio
    var ROUTINE = {
        'FULL BODY A': ['FULL BODY A', 'CORPO INTEIRO A'], 'FULL BODY B': ['FULL BODY B', 'CORPO INTEIRO B'], 'FULL BODY C': ['FULL BODY C', 'CORPO INTEIRO C'],
        'UPPER A — Push': ['UPPER A — Push', 'SUPERIOR A — Empurrar'], 'UPPER B — Pull': ['UPPER B — Pull', 'SUPERIOR B — Puxar'],
        'LOWER A — Cuádriceps': ['LOWER A — Quads', 'INFERIOR A — Quadríceps'], 'LOWER B — Posterior': ['LOWER B — Posterior', 'INFERIOR B — Posterior'],
        'UPPER A': ['UPPER A', 'SUPERIOR A'], 'UPPER B': ['UPPER B', 'SUPERIOR B'],
        // Métodos de la versión anterior del generador: siguen guardados en rutinas existentes
        'Hipertrofia · Tempo controlado 2-0-1': ['Hypertrophy · Controlled tempo 2-0-1', 'Hipertrofia · Tempo controlado 2-0-1'],
        'Definición · Descansos cortos 30-45s': ['Cutting · Short rest 30-45s', 'Definição · Descanso curto 30-45s'],
        'Fuerza · Descansos largos 3-5min · Compuestos pesados': ['Strength · Long rest 3-5min · Heavy compounds', 'Força · Descanso longo 3-5min · Compostos pesados'],
        'Resistencia · Alto volumen · Bajo descanso': ['Endurance · High volume · Short rest', 'Resistência · Alto volume · Descanso curto'],
        'PUSH': ['PUSH', 'EMPURRAR'], 'PULL': ['PULL', 'PUXAR'], 'LEGS': ['LEGS', 'PERNAS'], 'UPPER': ['UPPER', 'SUPERIOR'], 'LOWER': ['LOWER', 'INFERIOR'],
        'PUSH A': ['PUSH A', 'EMPURRAR A'], 'PULL A': ['PULL A', 'PUXAR A'], 'LEGS A': ['LEGS A', 'PERNAS A'],
        'PUSH B': ['PUSH B', 'EMPURRAR B'], 'PULL B': ['PULL B', 'PUXAR B'], 'LEGS B': ['LEGS B', 'PERNAS B'],
        'Lower emphasis': ['Lower emphasis', 'Ênfase inferior'], 'Upper emphasis': ['Upper emphasis', 'Ênfase superior'], 'Posterior chain': ['Posterior chain', 'Cadeia posterior'],
        'Pecho/Hombros/Tríceps': ['Chest/Shoulders/Triceps', 'Peito/Ombros/Tríceps'], 'Espalda/Bíceps': ['Back/Biceps', 'Costas/Bíceps'],
        'Femoral/Glúteo': ['Hamstrings/Glutes', 'Posterior/Glúteos'], 'Posterior/Glúteo': ['Posterior/Glutes', 'Posterior/Glúteos'],
        'Cuádriceps dominante': ['Quad dominant', 'Dominante de quadríceps'], 'Piernas completo': ['Full legs', 'Pernas completo'],
        'Volumen accesorios': ['Accessory volume', 'Volume de acessórios'], 'Glúteo + accesorios': ['Glutes + accessories', 'Glúteos + acessórios'],
        'Pecho fuerte': ['Heavy chest', 'Peito pesado'], 'Espalda gruesa': ['Thick back', 'Costas densas'], 'Pecho ancho': ['Wide chest', 'Peito amplo'],
        'Espalda ancha': ['Wide back', 'Costas largas'],
        'Subí con el abdomen — no tires del cuello': ["Lift with your abs — don't pull your neck", 'Suba com o abdômen — não puxe o pescoço'],
        'Lumbar pegada al piso todo el tiempo': ['Lower back pressed to the floor the whole time', 'Lombar colada no chão o tempo todo'],
        'Cadera alineada, no la dejes caer': ["Hips aligned, don't let them drop", 'Quadril alinhado, não deixe cair'],
        'Línea recta de cabeza a talones': ['Straight line from head to heels', 'Linha reta da cabeça aos calcanhares'],
        'Lento y controlado, lumbar pegada al piso': ['Slow and controlled, lower back on the floor', 'Lento e controlado, lombar colada no chão'],
        'Flexioná desde el abdomen, no desde la cadera': ['Bend from your abs, not your hips', 'Flexione pelo abdômen, não pelo quadril'],
        'Sin impulso — subí con el core': ['No swinging — lift with your core', 'Sem impulso — suba com o core'],
        'Girá desde el torso, pies apenas apoyados': ['Rotate from your torso, feet barely touching', 'Gire pelo tronco, pés mal apoiados'],
        'Glúteos y core apretados, respiración constante': ['Glutes and core tight, steady breathing', 'Glúteos e core contraídos, respiração constante'],
        'De rodillas, pelvis en retroversión': ['From your knees, pelvis tucked', 'De joelhos, pelve em retroversão'],
        'Agregá peso progresivamente': ['Add weight progressively', 'Aumente a carga aos poucos'],
        'Piernas rectas, sin swing': ['Straight legs, no swinging', 'Pernas retas, sem balanço'],
        'Con disco o mancuerna': ['With a plate or dumbbell', 'Com anilha ou halter'],
        'Progresá hacia de pie': ['Progress toward standing', 'Progrida até fazer em pé'],
        'Bajada controlada — el ejercicio más exigente del core': ['Controlled lowering — the toughest core exercise', 'Descida controlada — o exercício de core mais exigente'],
        'Bisagra de cadera estricta — no redondees la espalda': ["Strict hip hinge — don't round your back", 'Dobradiça de quadril estrita — não arredonde as costas'],
        'Profundidad por debajo de paralela': ['Depth below parallel', 'Profundidade abaixo da paralela'],
        'Usá banda elástica si hace falta': ['Use a resistance band if needed', 'Use elástico se precisar'],
        'Si la espalda baja se redondea, bajá peso': ['If your lower back rounds, drop the weight', 'Se a lombar arredondar, diminua a carga'],
        'Bisagra estricta': ['Strict hinge', 'Dobradiça estrita'],
        'Pausa 1s arriba apretando glúteos': ['1s pause at the top squeezing your glutes', 'Pausa de 1s em cima contraindo os glúteos']
    };

    // Biblioteca de ejercicios: descripción, consejos, errores, progresión, reps y variantes
    var LIBRARY = {
        // Press banca plano
        'Press fundamental con barra en banco plano. Trabaja pecho, tríceps y hombro anterior.': ['The fundamental barbell press on a flat bench. Works chest, triceps and front delts.', 'Supino básico com barra no banco reto. Trabalha peito, tríceps e ombro anterior.'],
        'Escápulas retractadas y deprimidas durante todo el movimiento': ['Shoulder blades retracted and depressed throughout the movement', 'Escápulas retraídas e deprimidas durante todo o movimento'],
        'Bajá controlado, sin rebote en el pecho': ['Lower under control, no bouncing off the chest', 'Desça controlado, sem quicar no peito'],
        'Codos a ~45° respecto al torso (no abiertos a 90°)': ['Elbows at ~45° to your torso (not flared to 90°)', 'Cotovelos a ~45° do tronco (não abertos a 90°)'],
        'Pies firmes en el piso, glúteos apretados': ['Feet planted on the floor, glutes tight', 'Pés firmes no chão, glúteos contraídos'],
        'Codos demasiado abiertos (riesgo de hombro)': ['Elbows flared too wide (shoulder risk)', 'Cotovelos abertos demais (risco para o ombro)'],
        'Rebote en el pecho': ['Bouncing off the chest', 'Quicar a barra no peito'],
        'Escápulas sueltas (hombros adelante)': ['Loose shoulder blades (shoulders rolling forward)', 'Escápulas soltas (ombros para frente)'],
        'Rango de movimiento incompleto': ['Partial range of motion', 'Amplitude de movimento incompleta'],
        'Subí 2.5kg semanalmente mientras puedas completar 4×8 con técnica limpia': ['Add 2.5kg each week as long as you can complete 4×8 with clean form', 'Suba 2,5kg por semana enquanto conseguir fazer 4×8 com técnica limpa'],
        '6-8 reps para hipertrofia · 1-5 reps para fuerza': ['6-8 reps for hypertrophy · 1-5 reps for strength', '6-8 reps para hipertrofia · 1-5 reps para força'],
        // Press inclinado con barra
        'Press en banco inclinado 30-45°. Énfasis en pecho superior y hombro anterior.': ['Press on a 30-45° incline bench. Emphasis on upper chest and front delts.', 'Supino no banco inclinado a 30-45°. Ênfase no peitoral superior e ombro anterior.'],
        'Banco a 30° (mejor que 45° para pecho)': ['Bench at 30° (better than 45° for chest)', 'Banco a 30° (melhor que 45° para o peito)'],
        'Misma técnica de escápulas que press plano': ['Same shoulder-blade setup as the flat press', 'Mesma técnica de escápulas do supino reto'],
        'La barra baja a clavícula alta': ['The bar comes down to your upper chest/collarbone', 'A barra desce até a clavícula alta'],
        'Mantené glúteos en contacto con el banco': ['Keep your glutes on the bench', 'Mantenha os glúteos em contato com o banco'],
        'Banco demasiado vertical (~60°+) → trabaja hombros': ['Bench too upright (~60°+) → it becomes a shoulder press', 'Banco muito vertical (~60°+) → vira exercício de ombro'],
        'Arquear espalda excesivamente': ['Arching your back too much', 'Arquear demais as costas'],
        'Codos muy abiertos': ['Elbows flared too wide', 'Cotovelos muito abertos'],
        'Hacer reps explosivos sin control': ['Explosive reps without control', 'Fazer reps explosivas sem controle'],
        'Más lento que en plano — subí cada 2-3 semanas': ['Slower than the flat press — add weight every 2-3 weeks', 'Mais lento que o reto — suba a carga a cada 2-3 semanas'],
        '8-12 reps · enfoque hipertrofia': ['8-12 reps · hypertrophy focus', '8-12 reps · foco em hipertrofia'],
        // Press con mancuernas
        'Press con mancuernas. Mayor ROM que la barra, exige más estabilidad.': ['Dumbbell press. Greater range of motion than the barbell, demands more stability.', 'Supino com halteres. Mais amplitude que a barra e exige mais estabilidade.'],
        'Codos a 45°, no perpendiculares': ['Elbows at 45°, not perpendicular', 'Cotovelos a 45°, não perpendiculares'],
        'Las mancuernas bajan a costados del pecho': ['The dumbbells come down beside your chest', 'Os halteres descem nas laterais do peito'],
        'Pequeña rotación de muñecas al subir': ['Slight wrist rotation on the way up', 'Leve rotação dos punhos ao subir'],
        'Controlá la bajada (3 segundos eccéntrico)': ['Control the descent (3-second eccentric)', 'Controle a descida (3 segundos de excêntrica)'],
        'Chocar las mancuernas arriba (sin tensión)': ['Clanking the dumbbells at the top (losing tension)', 'Bater os halteres em cima (sem tensão)'],
        'Mancuernas muy adentro': ['Dumbbells too far in', 'Halteres muito para dentro'],
        'Rango corto por miedo a la profundidad': ['Short range out of fear of going deep', 'Amplitude curta por medo de descer'],
        'No estabilizar antes de empezar': ['Not stabilizing before you start', 'Não estabilizar antes de começar'],
        'Mancuernas suelen ir 2-2.5kg cada paso (escalado)': ['Dumbbells usually go up 2-2.5kg per step', 'Halteres costumam subir de 2-2,5kg por vez'],
        '8-12 reps hipertrofia': ['8-12 reps hypertrophy', '8-12 reps hipertrofia'],
        // Fondos en paralelas
        'Compuesto para pecho inferior y tríceps. Mayor inclinación adelante = más pecho.': ['Compound for lower chest and triceps. Leaning further forward = more chest.', 'Composto para peitoral inferior e tríceps. Inclinar mais à frente = mais peito.'],
        'Inclinarte adelante para énfasis en pecho': ['Lean forward to emphasize the chest', 'Incline o tronco à frente para enfatizar o peito'],
        'Bajá hasta 90° de hombro (no más)': ['Lower until your shoulders reach 90° (no further)', 'Desça até 90° no ombro (não mais)'],
        'Codos no demasiado abiertos': ["Don't flare your elbows too much", 'Cotovelos não muito abertos'],
        'Mantené core apretado': ['Keep your core tight', 'Mantenha o core contraído'],
        'Hombros demasiado abajo (estiramiento excesivo)': ['Dropping the shoulders too low (overstretching)', 'Ombros baixos demais (alongamento excessivo)'],
        'Codos completamente abiertos': ['Elbows fully flared', 'Cotovelos totalmente abertos'],
        'Balance descontrolado': ['Uncontrolled swinging', 'Balanço descontrolado'],
        'Reps explosivas sin pausa': ['Explosive reps with no pause', 'Reps explosivas sem pausa'],
        'Dips con peso': ['Weighted dips', 'Paralelas com peso'],
        'Cuando hagas 3×12 con bodyweight, agregá lastre': ['Once you can do 3×12 with bodyweight, add weight', 'Quando fizer 3×12 com o peso do corpo, adicione carga'],
        '6-12 reps según objetivo': ['6-12 reps depending on your goal', '6-12 reps conforme o objetivo'],
        // Cruces con polea
        'Aislamiento de pecho. Mantiene tensión constante en todo el ROM.': ['Chest isolation. Keeps constant tension through the full range of motion.', 'Isolador de peito. Mantém tensão constante em toda a amplitude.'],
        'Ligera flexión de codo (no rígido)': ['Slight bend in the elbow (not locked)', 'Leve flexão do cotovelo (sem travar)'],
        'Movimiento desde el hombro, no del codo': ['The movement comes from the shoulder, not the elbow', 'O movimento vem do ombro, não do cotovelo'],
        'Pausa 1s al juntar las manos': ['1s pause when your hands meet', 'Pausa de 1s ao juntar as mãos'],
        'Poleas a media altura para pecho medio': ['Pulleys at mid height for the middle chest', 'Polias na altura média para o peito médio'],
        'Demasiado peso (compensás con el cuerpo)': ['Too much weight (you compensate with your body)', 'Peso demais (você compensa com o corpo)'],
        'Codos completamente extendidos': ['Elbows fully locked out', 'Cotovelos totalmente estendidos'],
        'Movimiento estilo "press" en vez de fly': ['Pressing instead of flying', 'Movimento de "supino" em vez de crucifixo'],
        'Sin pausa en el pico': ['No pause at the peak', 'Sem pausa no pico'],
        'Aislamiento → priorizá técnica sobre peso': ['Isolation → technique over weight', 'Isolador → priorize técnica sobre carga'],
        '12-15 reps hipertrofia': ['12-15 reps hypertrophy', '12-15 reps hipertrofia'],
        // Peso muerto convencional
        'Compuesto rey. Trabaja toda la cadena posterior: espalda baja, glúteos, isquios.': ['The king of compounds. Works the whole posterior chain: lower back, glutes, hamstrings.', 'O rei dos compostos. Trabalha toda a cadeia posterior: lombar, glúteos e posteriores.'],
        'Barra cerca del cuerpo (rozando piernas)': ['Bar close to your body (brushing your legs)', 'Barra perto do corpo (raspando nas pernas)'],
        'Caderas y hombros suben al mismo tiempo': ['Hips and shoulders rise together', 'Quadril e ombros sobem ao mesmo tempo'],
        'Espalda neutra — nunca redondeada': ['Neutral back — never rounded', 'Coluna neutra — nunca arredondada'],
        'Brace abdominal antes de tirar': ['Brace your core before you pull', 'Trave o abdômen antes de puxar'],
        'Espalda baja redondeada (riesgo de hernia)': ['Rounded lower back (risk of disc injury)', 'Lombar arredondada (risco de hérnia)'],
        'Caderas suben primero (Good Morning)': ['Hips shooting up first (Good Morning)', 'Quadril subindo primeiro (Good Morning)'],
        'Barra alejada del cuerpo': ['Bar drifting away from your body', 'Barra longe do corpo'],
        'Hiperextender arriba': ['Hyperextending at the top', 'Hiperestender em cima'],
        'Subí 5kg cuando hagas 3×5 con forma perfecta. Deload cada 6-8 semanas.': ['Add 5kg once you hit 3×5 with perfect form. Deload every 6-8 weeks.', 'Suba 5kg quando fizer 3×5 com forma perfeita. Deload a cada 6-8 semanas.'],
        '3-6 reps fuerza · 6-8 hipertrofia': ['3-6 reps strength · 6-8 hypertrophy', '3-6 reps força · 6-8 hipertrofia'],
        // Dominadas
        'Ejercicio fundamental de tracción vertical. Trabaja dorsal, bíceps y core.': ['The fundamental vertical pull. Works lats, biceps and core.', 'Exercício básico de puxada vertical. Trabalha dorsais, bíceps e core.'],
        'Empezá con escápulas activadas (no colgando muerto)': ['Start with active shoulder blades (not a dead hang)', 'Comece com as escápulas ativadas (não pendurado solto)'],
        'Pecho hacia la barra (no mentón)': ['Chest to the bar (not just your chin)', 'Peito em direção à barra (não o queixo)'],
        'Bajá controlado hasta extensión total': ['Lower under control to full extension', 'Desça controlado até a extensão total'],
        'Evitá impulsarte con piernas (kipping)': ['Avoid swinging your legs (kipping)', 'Evite pegar impulso com as pernas (kipping)'],
        'Rango incompleto (no llegar a mentón sobre barra)': ['Partial range (chin not over the bar)', 'Amplitude incompleta (queixo não passa da barra)'],
        'Kipping descontrolado': ['Uncontrolled kipping', 'Kipping descontrolado'],
        'Codos hacia adelante (chin-up grip implícito)': ['Elbows drifting forward (turning it into a chin-up)', 'Cotovelos para frente (vira uma barra supinada)'],
        'Encoger hombros': ['Shrugging your shoulders', 'Encolher os ombros'],
        'Chin-up (supino)': ['Chin-up (underhand)', 'Barra supinada'],
        'Cuando hagas 3×8 con bodyweight, agregá lastre': ['Once you can do 3×8 with bodyweight, add weight', 'Quando fizer 3×8 com o peso do corpo, adicione carga'],
        '5-10 reps según nivel': ['5-10 reps depending on your level', '5-10 reps conforme o nível'],
        // Jalón al pecho
        'Tracción vertical en máquina. Excelente para aprender el patrón antes de dominadas.': ['Machine vertical pull. Great for learning the pattern before pull-ups.', 'Puxada vertical na máquina. Ótima para aprender o padrão antes da barra fixa.'],
        'Pecho arriba, no encogerte hacia adelante': ["Chest up, don't hunch forward", 'Peito para cima, sem se curvar para frente'],
        'Tirá con los codos hacia abajo y atrás': ['Pull your elbows down and back', 'Puxe com os cotovelos para baixo e para trás'],
        'La barra toca alto del pecho': ['The bar touches your upper chest', 'A barra encosta na parte alta do peito'],
        'Mantené torso casi vertical': ['Keep your torso almost upright', 'Mantenha o tronco quase vertical'],
        'Echarse muy atrás (usar el peso del cuerpo)': ['Leaning way back (using body weight)', 'Jogar o corpo para trás (usar o peso do corpo)'],
        'Tirar con los brazos en lugar de la espalda': ['Pulling with your arms instead of your back', 'Puxar com os braços em vez das costas'],
        'Barra muy abajo (al abdomen)': ['Pulling the bar too low (to your stomach)', 'Barra baixa demais (até o abdômen)'],
        'Hombros encogidos al tirar': ['Shrugged shoulders as you pull', 'Ombros encolhidos ao puxar'],
        'Aumentá peso cuando hagas 3×10 con forma estricta': ['Add weight once you hit 3×10 with strict form', 'Aumente a carga quando fizer 3×10 com forma estrita'],
        // Remo con barra
        'Tracción horizontal con barra. Construye espalda gruesa.': ['Horizontal barbell pull. Builds a thick back.', 'Remada horizontal com barra. Constrói costas densas.'],
        'Torso a ~45° (Bent-Over) o ~15° (Pendlay)': ['Torso at ~45° (bent-over) or ~15° (Pendlay)', 'Tronco a ~45° (curvada) ou ~15° (Pendlay)'],
        'Barra a abdomen bajo (no al pecho)': ['Bar to your lower stomach (not your chest)', 'Barra no baixo abdômen (não no peito)'],
        'Codos cerca del cuerpo': ['Elbows close to your body', 'Cotovelos perto do corpo'],
        'Pausa 1s en contracción': ['1s pause at peak contraction', 'Pausa de 1s na contração'],
        'Torso muy vertical (se convierte en encogimiento)': ['Torso too upright (it turns into a shrug)', 'Tronco muito vertical (vira encolhimento)'],
        'Espalda baja redondeada': ['Rounded lower back', 'Lombar arredondada'],
        'Subir el cuerpo con la barra (compensación)': ['Heaving your body up with the bar', 'Levantar o corpo junto com a barra (compensação)'],
        'Subí 2.5kg semanalmente': ['Add 2.5kg each week', 'Suba 2,5kg por semana'],
        // Remo con mancuerna
        'Tracción unilateral con mancuerna apoyado en banco. Excelente para corregir desbalances.': ['One-arm dumbbell row braced on a bench. Great for fixing imbalances.', 'Remada unilateral com halter apoiado no banco. Ótima para corrigir desequilíbrios.'],
        'Una mano y rodilla en el banco para estabilidad': ['One hand and knee on the bench for stability', 'Uma mão e um joelho no banco para estabilidade'],
        'Tirá la mancuerna hacia la cadera (no al pecho)': ['Pull the dumbbell toward your hip (not your chest)', 'Puxe o halter em direção ao quadril (não ao peito)'],
        'Pausa 1s arriba': ['1s pause at the top', 'Pausa de 1s em cima'],
        'Espalda neutra durante todo el movimiento': ['Neutral back throughout the movement', 'Coluna neutra durante todo o movimento'],
        'Rotar el torso al subir el peso': ['Twisting your torso as you lift', 'Girar o tronco ao subir o peso'],
        'Brazo muy abierto (sale el codo)': ['Arm flaring out (elbow drifts away)', 'Braço muito aberto (cotovelo sai)'],
        'Velocidad explosiva sin control': ['Explosive speed without control', 'Velocidade explosiva sem controle'],
        'Rango incompleto': ['Partial range', 'Amplitude incompleta'],
        'Mancuernas escalan 2-2.5kg': ['Dumbbells go up in 2-2.5kg steps', 'Halteres sobem de 2-2,5kg'],
        '8-12 reps por lado': ['8-12 reps per side', '8-12 reps por lado'],
        // Sentadilla
        'Reina de los ejercicios. Trabaja cuádriceps, glúteos, isquios y core.': ['The queen of exercises. Works quads, glutes, hamstrings and core.', 'A rainha dos exercícios. Trabalha quadríceps, glúteos, posteriores e core.'],
        'Pies a la altura de hombros o un poco más': ['Feet shoulder-width apart or slightly wider', 'Pés na largura dos ombros ou um pouco mais'],
        'Pecho arriba, mirada al frente': ['Chest up, eyes forward', 'Peito para cima, olhar à frente'],
        'Rodillas rastrean los dedos': ['Knees track over your toes', 'Joelhos acompanham a direção dos pés'],
        'Bajá hasta romper paralelo (cadera bajo rodilla)': ['Go below parallel (hips below knees)', 'Desça além da paralela (quadril abaixo do joelho)'],
        'Rodillas colapsando hacia adentro': ['Knees caving in', 'Joelhos caindo para dentro'],
        'Subir la cadera primero (Good Morning Squat)': ['Hips rising first (Good Morning squat)', 'Subir o quadril primeiro (agachamento Good Morning)'],
        'Talones levantándose': ['Heels lifting off', 'Calcanhares saindo do chão'],
        'Rango incompleto (quarter squats)': ['Partial range (quarter squats)', 'Amplitude incompleta (quarter squats)'],
        'Principiantes: 2.5-5kg/semana · Intermedios: 1.25-2.5kg/semana': ['Beginners: 2.5-5kg/week · Intermediate: 1.25-2.5kg/week', 'Iniciantes: 2,5-5kg/semana · Intermediários: 1,25-2,5kg/semana'],
        '5-8 reps fuerza · 8-12 hipertrofia': ['5-8 reps strength · 8-12 hypertrophy', '5-8 reps força · 8-12 hipertrofia'],
        // Peso muerto rumano
        'Peso muerto desde arriba con énfasis en isquios y glúteos. Bisagra de cadera pura.': ['Deadlift from the top with emphasis on hamstrings and glutes. A pure hip hinge.', 'Terra a partir de cima com ênfase em posteriores e glúteos. Dobradiça de quadril pura.'],
        'Mínima flexión de rodilla (casi rectas)': ['Minimal knee bend (almost straight)', 'Flexão mínima do joelho (quase retas)'],
        'Empujá las caderas hacia atrás (bisagra)': ['Push your hips back (hinge)', 'Empurre o quadril para trás (dobradiça)'],
        'Sentí estiramiento en isquios al bajar': ['Feel the stretch in your hamstrings on the way down', 'Sinta o alongamento dos posteriores ao descer'],
        'Espalda 100% neutra': ['Back 100% neutral', 'Coluna 100% neutra'],
        'Demasiada flexión de rodilla (se convierte en deadlift)': ['Too much knee bend (it becomes a regular deadlift)', 'Flexão de joelho demais (vira terra convencional)'],
        'Bajar demasiado (sacrificio de forma)': ['Going too low (sacrificing form)', 'Descer demais (sacrificando a forma)'],
        'Subí 2.5kg cuando hagas 3×8 con buena bisagra': ['Add 2.5kg once you hit 3×8 with a good hinge', 'Suba 2,5kg quando fizer 3×8 com boa dobradiça'],
        '8-12 reps · enfoque isquios': ['8-12 reps · hamstring focus', '8-12 reps · foco em posteriores'],
        // Prensa
        'Máquina segura para volumen en cuádriceps. Ideal para principiantes y como accesorio.': ['A safe machine for quad volume. Ideal for beginners and as an accessory.', 'Máquina segura para volume de quadríceps. Ideal para iniciantes e como acessório.'],
        'Pies a altura de cadera para énfasis cuádriceps': ['Feet hip-width apart for quad emphasis', 'Pés na largura do quadril para enfatizar quadríceps'],
        'Bajá controlado, sin rebote': ['Lower under control, no bouncing', 'Desça controlado, sem quicar'],
        'No bloquees las rodillas arriba': ["Don't lock your knees at the top", 'Não trave os joelhos em cima'],
        'Pies más altos = más glúteo · más bajos = más cuádriceps': ['Feet higher = more glutes · lower = more quads', 'Pés mais altos = mais glúteo · mais baixos = mais quadríceps'],
        'Despegar las caderas (curvar espalda baja)': ['Hips lifting off (lower back rounding)', 'Tirar o quadril do banco (curvar a lombar)'],
        'Bajar muy poco (rango corto)': ['Not going low enough (short range)', 'Descer pouco (amplitude curta)'],
        'Bloquear rodillas con golpe': ['Slamming your knees into lockout', 'Travar os joelhos com tranco'],
        'Demasiado peso → forma horrible': ['Too much weight → terrible form', 'Peso demais → forma horrível'],
        'Aumentá peso semanalmente con técnica perfecta': ['Add weight each week with perfect technique', 'Aumente a carga toda semana com técnica perfeita'],
        '10-15 reps hipertrofia': ['10-15 reps hypertrophy', '10-15 reps hipertrofia'],
        // Hip thrust
        'Mejor ejercicio aislado para glúteo. Trabajo unilateral del extensor de cadera.': ['The best glute isolation exercise. Pure hip-extension work.', 'Melhor exercício isolado para glúteo. Trabalho direto da extensão do quadril.'],
        'Espalda apoyada en banco a altura de escápulas': ['Upper back on the bench at shoulder-blade height', 'Costas apoiadas no banco na altura das escápulas'],
        'Pies firmes, alineados con hombros': ['Feet planted, in line with your shoulders', 'Pés firmes, alinhados com os ombros'],
        'Mentón hacia el pecho (no extender cuello)': ["Chin tucked (don't extend your neck)", 'Queixo em direção ao peito (não estenda o pescoço)'],
        'Hiperextensión lumbar arriba': ['Arching your lower back at the top', 'Hiperextensão lombar em cima'],
        'Rango corto (no llegar a cadera neutra)': ['Short range (not reaching neutral hips)', 'Amplitude curta (não chegar ao quadril neutro)'],
        'Pies muy cerca → cuádriceps domina': ['Feet too close → quads take over', 'Pés muito perto → quadríceps domina'],
        'Sin pausa arriba': ['No pause at the top', 'Sem pausa em cima'],
        'Subí 5-10kg cuando hagas 3×10 con pausa': ['Add 5-10kg once you hit 3×10 with a pause', 'Suba 5-10kg quando fizer 3×10 com pausa'],
        // Zancadas
        'Unilateral excelente para corregir desbalances. Trabaja cuádriceps, glúteos e isquios.': ['A great unilateral move for fixing imbalances. Works quads, glutes and hamstrings.', 'Unilateral ótimo para corrigir desequilíbrios. Trabalha quadríceps, glúteos e posteriores.'],
        'Paso largo (>1.5 longitud de tu pie)': ['Long step (more than 1.5 of your foot lengths)', 'Passo longo (mais de 1,5 do comprimento do seu pé)'],
        'Rodilla delantera no pasa los dedos': ["Front knee doesn't pass your toes", 'Joelho da frente não passa dos dedos'],
        'Rodilla trasera baja casi al piso': ['Back knee drops almost to the floor', 'Joelho de trás desce quase até o chão'],
        'Torso vertical durante todo el movimiento': ['Torso upright throughout the movement', 'Tronco vertical durante todo o movimento'],
        'Paso muy corto (toda la carga en rodilla)': ['Step too short (all the load on the knee)', 'Passo muito curto (toda a carga no joelho)'],
        'Rodilla delantera colapsa adentro': ['Front knee caving in', 'Joelho da frente cai para dentro'],
        'Inclinarse hacia adelante': ['Leaning forward', 'Inclinar o tronco à frente'],
        'Velocidad alta sin control': ['Going fast without control', 'Velocidade alta sem controle'],
        'Sumá peso cuando hagas 3×12 por pierna estables': ['Add weight once you can do 3×12 per leg with good balance', 'Aumente a carga quando fizer 3×12 por perna com estabilidade'],
        '8-15 reps por pierna': ['8-15 reps per leg', '8-15 reps por perna'],
        // Sentadilla búlgara
        'Variante avanzada de zancada con pie trasero elevado. Brutal para cuádriceps y glúteos.': ['An advanced lunge variation with the rear foot elevated. Brutal for quads and glutes.', 'Variação avançada do afundo com o pé de trás elevado. Brutal para quadríceps e glúteos.'],
        'Pie trasero apoyado en banco bajo (~30cm)': ['Rear foot on a low bench (~30cm)', 'Pé de trás apoiado em banco baixo (~30cm)'],
        'Casi todo el peso en pierna delantera': ['Almost all the weight on the front leg', 'Quase todo o peso na perna da frente'],
        'Torso casi vertical (énfasis cuádriceps) o ligeramente adelante (glúteo)': ['Torso almost upright (quad focus) or leaning slightly forward (glute focus)', 'Tronco quase vertical (ênfase em quadríceps) ou levemente à frente (glúteo)'],
        'Rodilla delantera rastreando los dedos': ['Front knee tracking over your toes', 'Joelho da frente acompanhando os dedos'],
        'Pierna trasera ayuda mucho': ['Back leg doing too much of the work', 'Perna de trás ajudando demais'],
        'Distancia muy corta (rodilla pasa los dedos)': ['Stance too short (knee goes past your toes)', 'Distância muito curta (joelho passa dos dedos)'],
        'Balance perdido (mucho peso, poca estabilidad)': ['Losing balance (too much weight, too little stability)', 'Perder o equilíbrio (muito peso, pouca estabilidade)'],
        'Bajar muy poco': ['Not going low enough', 'Descer pouco'],
        'Dominalo con bodyweight antes de cargar': ['Master it with bodyweight before loading it', 'Domine com o peso do corpo antes de colocar carga'],
        '8-12 reps por pierna': ['8-12 reps per leg', '8-12 reps por perna'],
        // Press militar
        'Compuesto vertical para hombros. Trabaja todo el deltoides + tríceps + core.': ['Vertical compound for shoulders. Works all three delt heads + triceps + core.', 'Composto vertical para ombros. Trabalha todo o deltoide + tríceps + core.'],
        'Barra apoyada en clavícula al inicio': ['Bar resting on your collarbone to start', 'Barra apoiada na clavícula no início'],
        'Glúteos y core apretados (no usar piernas)': ["Glutes and core tight (don't use your legs)", 'Glúteos e core contraídos (sem usar as pernas)'],
        'La barra termina sobre tu cabeza, no adelante': ['The bar finishes over your head, not in front', 'A barra termina sobre a cabeça, não à frente'],
        'Pasá la cabeza hacia adelante al final (no atrás)': ['Push your head through at the top (not back)', 'Leve a cabeça para frente no final (não para trás)'],
        'Usar las piernas (Push Press)': ['Using your legs (push press)', 'Usar as pernas (push press)'],
        'Codos demasiado adelante': ['Elbows too far forward', 'Cotovelos muito à frente'],
        'Hiperextender lumbar arriba': ['Overarching your lower back at the top', 'Hiperestender a lombar em cima'],
        'Barra termina demasiado adelante': ['Bar finishing too far forward', 'Barra terminando muito à frente'],
        'Más lento que bench. Subí 1.25kg cuando puedas': ['Slower than the bench. Add 1.25kg when you can', 'Mais lento que o supino. Suba 1,25kg quando puder'],
        '5-8 fuerza · 8-12 hipertrofia': ['5-8 strength · 8-12 hypertrophy', '5-8 força · 8-12 hipertrofia'],
        // Elevaciones laterales
        'Aislamiento para deltoides medio. La mejor herramienta para anchura de hombros.': ['Isolation for the side delts. The best tool for wider shoulders.', 'Isolador para o deltoide médio. A melhor ferramenta para ombros largos.'],
        'Ligera inclinación hacia adelante (~15°)': ['Lean slightly forward (~15°)', 'Leve inclinação à frente (~15°)'],
        'Codos ligeramente flexionados, no rectos': ['Elbows slightly bent, not straight', 'Cotovelos levemente flexionados, não retos'],
        'Subí los codos primero (no las manos)': ['Lead with your elbows (not your hands)', 'Suba primeiro os cotovelos (não as mãos)'],
        'Pico a la altura del hombro, no más': ['Top out at shoulder height, no higher', 'Pico na altura do ombro, não mais'],
        'Demasiado peso (compensás con todo el cuerpo)': ['Too much weight (you compensate with your whole body)', 'Peso demais (você compensa com o corpo todo)'],
        'Subir las manos en vez de los codos': ['Leading with your hands instead of your elbows', 'Subir as mãos em vez dos cotovelos'],
        'Encoger hombros al subir': ['Shrugging as you lift', 'Encolher os ombros ao subir'],
        'Velocidad alta sin pausa': ['Going fast with no pause', 'Velocidade alta sem pausa'],
        'Aislamiento → priorizá técnica. Mancuernas suben de a 1-2kg': ['Isolation → technique first. Dumbbells go up 1-2kg at a time', 'Isolador → priorize técnica. Halteres sobem de 1-2kg'],
        '12-20 reps · enfoque conexión mente-músculo': ['12-20 reps · mind-muscle connection focus', '12-20 reps · foco na conexão mente-músculo'],
        // Face pull
        'Tracción horizontal con énfasis en deltoides posterior + rotadores. Salud del hombro.': ['Horizontal pull emphasizing rear delts + rotator cuff. Great for shoulder health.', 'Puxada horizontal com ênfase no deltoide posterior + manguito rotador. Saúde do ombro.'],
        'Cable a altura de la cara': ['Cable at face height', 'Polia na altura do rosto'],
        'Tirá hacia la frente, separando las manos': ['Pull toward your forehead, spreading your hands apart', 'Puxe em direção à testa, afastando as mãos'],
        'Codos altos, paralelos al piso': ['Elbows high, parallel to the floor', 'Cotovelos altos, paralelos ao chão'],
        'Pausa 1s en contracción con rotación externa': ['1s pause at peak contraction with external rotation', 'Pausa de 1s na contração com rotação externa'],
        'Demasiado peso (perdés rotación externa)': ['Too much weight (you lose the external rotation)', 'Peso demais (você perde a rotação externa)'],
        'Tirar hacia el pecho en vez de la cara': ['Pulling to your chest instead of your face', 'Puxar até o peito em vez do rosto'],
        'Codos caídos': ['Elbows dropping', 'Cotovelos caídos'],
        'Volumen alto, peso bajo. 3-5×15-20 ideal': ['High volume, low weight. 3-5×15-20 is ideal', 'Volume alto, peso baixo. 3-5×15-20 é o ideal'],
        // Curl con barra
        'Aislamiento clásico de bíceps. Excelente para masa.': ['The classic biceps isolation move. Great for size.', 'Isolador clássico de bíceps. Ótimo para massa.'],
        'Codos pegados al torso (no se mueven adelante)': ["Elbows pinned to your sides (they don't move forward)", 'Cotovelos colados ao tronco (não vão para frente)'],
        'Subí con bíceps, sin balancear el cuerpo': ['Curl with your biceps, no body swing', 'Suba com o bíceps, sem balançar o corpo'],
        'Bajá controlado (3 segundos)': ['Lower under control (3 seconds)', 'Desça controlado (3 segundos)'],
        'Rango completo: estiramiento abajo, contracción arriba': ['Full range: stretch at the bottom, squeeze at the top', 'Amplitude completa: alongamento embaixo, contração em cima'],
        'Balancear cuerpo (kipping)': ['Swinging your body (kipping)', 'Balançar o corpo (kipping)'],
        'Codos hacia adelante al subir': ['Elbows drifting forward as you curl', 'Cotovelos para frente ao subir'],
        'Solo medio rango': ['Only half range', 'Só meia amplitude'],
        'Demasiado peso': ['Too much weight', 'Peso demais'],
        'Subí 1.25-2.5kg cuando hagas 3×10 estrictos': ['Add 1.25-2.5kg once you hit 3×10 strict', 'Suba 1,25-2,5kg quando fizer 3×10 estritos'],
        // Pushdown
        'Aislamiento de tríceps con polea. Tensión constante en todo el ROM.': ['Cable triceps isolation. Constant tension through the full range.', 'Isolador de tríceps na polia. Tensão constante em toda a amplitude.'],
        'Codos pegados al torso (no se mueven)': ["Elbows pinned to your sides (they don't move)", 'Cotovelos colados ao tronco (não se movem)'],
        'Extendé hasta bloqueo (sin hiperextender)': ['Extend to lockout (without hyperextending)', 'Estenda até travar (sem hiperestender)'],
        'Mantené muñecas neutras': ['Keep your wrists neutral', 'Mantenha os punhos neutros'],
        'Pausa breve en extensión': ['Brief pause at full extension', 'Pausa breve na extensão'],
        'Codos saliendo adelante': ['Elbows drifting forward', 'Cotovelos indo para frente'],
        'Usar el peso del cuerpo': ['Using your body weight', 'Usar o peso do corpo'],
        'Rango corto': ['Short range', 'Amplitude curta'],
        'Encoger hombros al bajar': ['Shrugging as you push down', 'Encolher os ombros ao descer'],
        'Subí semanalmente con técnica limpia': ['Add weight each week with clean technique', 'Suba toda semana com técnica limpa'],
        // Curl martillo
        'Curl con agarre neutro. Trabaja bíceps + braquial + braquiorradial (antebrazo).': ['Neutral-grip curl. Works biceps + brachialis + brachioradialis (forearm).', 'Rosca com pegada neutra. Trabalha bíceps + braquial + braquiorradial (antebraço).'],
        'Palmas mirando entre sí (agarre neutro)': ['Palms facing each other (neutral grip)', 'Palmas voltadas uma para a outra (pegada neutra)'],
        'Codos pegados al torso': ['Elbows pinned to your sides', 'Cotovelos colados ao tronco'],
        'Una mancuerna a la vez o ambas': ['One dumbbell at a time or both together', 'Um halter por vez ou os dois juntos'],
        'Bajá controlado': ['Lower under control', 'Desça controlado'],
        'Balancear cuerpo': ['Swinging your body', 'Balançar o corpo'],
        'Codos hacia adelante': ['Elbows drifting forward', 'Cotovelos para frente'],
        'Muñecas quebradas': ['Bent wrists', 'Punhos dobrados'],
        'Mancuernas suben de a 1-2kg': ['Dumbbells go up 1-2kg at a time', 'Halteres sobem de 1-2kg'],
        // Press francés
        'Extensión de tríceps acostado. Trabaja la cabeza larga del tríceps.': ['Lying triceps extension. Works the long head of the triceps.', 'Extensão de tríceps deitado. Trabalha a cabeça longa do tríceps.'],
        'Codos fijos apuntando al techo': ['Elbows fixed, pointing at the ceiling', 'Cotovelos fixos apontando para o teto'],
        'Bajá la barra hacia la frente o detrás de la cabeza': ['Lower the bar to your forehead or behind your head', 'Desça a barra até a testa ou atrás da cabeça'],
        'No mover los hombros': ["Don't move your shoulders", 'Não mova os ombros'],
        'Pausa 1s arriba apretando tríceps': ['1s pause at the top squeezing your triceps', 'Pausa de 1s em cima contraindo o tríceps'],
        'Codos abriéndose': ['Elbows flaring out', 'Cotovelos abrindo'],
        'Bajar a la nariz (riesgo)': ['Lowering to your nose (risky)', 'Descer até o nariz (risco)'],
        'Mover los hombros (se convierte en press)': ['Moving your shoulders (it turns into a press)', 'Mover os ombros (vira um supino)'],
        'Subí cuando hagas 3×10 estrictos': ['Add weight once you hit 3×10 strict', 'Suba a carga quando fizer 3×10 estritos'],
        // Plancha
        'Estabilización isométrica del core. Trabaja transverso, oblicuos y rectos.': ['Isometric core stabilization. Works the transverse abdominis, obliques and rectus.', 'Estabilização isométrica do core. Trabalha transverso, oblíquos e reto abdominal.'],
        'Línea recta desde cabeza hasta talones': ['Straight line from head to heels', 'Linha reta da cabeça aos calcanhares'],
        'Codos bajo hombros, antebrazos paralelos': ['Elbows under your shoulders, forearms parallel', 'Cotovelos abaixo dos ombros, antebraços paralelos'],
        'Apretá glúteos y core durante todo el tiempo': ['Squeeze your glutes and core the whole time', 'Contraia glúteos e core o tempo todo'],
        'Respiración constante (no apnea)': ["Keep breathing (don't hold your breath)", 'Respiração constante (sem prender)'],
        'Cadera muy alta (cuelga)': ['Hips too high (piking)', 'Quadril muito alto'],
        'Cadera muy baja (lumbar pierde tensión)': ['Hips too low (lower back sags)', 'Quadril muito baixo (lombar perde tensão)'],
        'Cuello extendido': ['Neck craned up', 'Pescoço estendido'],
        'Aguantar la respiración': ['Holding your breath', 'Prender a respiração'],
        'Empezá con 20-30s, llegá a 60-90s antes de progresar a variantes': ['Start with 20-30s and build to 60-90s before moving to variations', 'Comece com 20-30s e chegue a 60-90s antes de passar às variações'],
        'Hold hasta perder forma — quality over time': ['Hold until your form breaks — quality over time', 'Segure até perder a forma — qualidade acima do tempo'],
        // Rueda abdominal
        'Anti-extensión brutal para core. Trabaja todo el abdomen + dorsal.': ['Brutal anti-extension for the core. Works the whole abdomen + lats.', 'Anti-extensão brutal para o core. Trabalha todo o abdômen + dorsais.'],
        'Empezá de rodillas (más fácil)': ['Start from your knees (easier)', 'Comece de joelhos (mais fácil)'],
        'Rodá lo más lejos que puedas sin que caiga la cadera': ['Roll out as far as you can without your hips sagging', 'Role o mais longe que puder sem o quadril cair'],
        'Mantené pelvis en retroversión': ['Keep your pelvis tucked', 'Mantenha a pelve em retroversão'],
        'Volvé apretando core, no brazos': ['Come back by squeezing your core, not your arms', 'Volte contraindo o core, não os braços'],
        'Hiperextender lumbar al rodar': ['Arching your lower back as you roll out', 'Hiperestender a lombar ao rolar'],
        'Empujar con brazos al volver': ['Pushing back with your arms', 'Empurrar com os braços ao voltar'],
        'Velocidad alta (perdés tensión)': ['Going fast (you lose tension)', 'Velocidade alta (perde tensão)'],
        'Rango demasiado largo si no estás listo': ["Rolling too far before you're ready", 'Amplitude longa demais se ainda não estiver pronto'],
        'De rodillas → standing → declined': ['From the knees → standing → decline', 'De joelhos → em pé → declinado'],
        '5-10 reps con forma perfecta': ['5-10 reps with perfect form', '5-10 reps com forma perfeita'],
        // Elevación de piernas colgado
        'Avanzado para abdomen inferior. Requiere fuerza de agarre y core.': ['Advanced move for the lower abs. Requires grip and core strength.', 'Avançado para o abdômen inferior. Exige força de pegada e de core.'],
        'Agarre activo (escápulas deprimidas)': ['Active grip (shoulder blades depressed)', 'Pegada ativa (escápulas deprimidas)'],
        'Subí las piernas con el core, no impulso': ['Raise your legs with your core, not momentum', 'Suba as pernas com o core, não no impulso'],
        'Pelvis en retroversión al subir': ['Tuck your pelvis as you raise', 'Pelve em retroversão ao subir'],
        'Usar swing (impulso)': ['Swinging (using momentum)', 'Usar balanço (impulso)'],
        'Solo subir las rodillas (rango corto si querías piernas rectas)': ['Only raising your knees (short range if you meant straight legs)', 'Só subir os joelhos (amplitude curta se a ideia era pernas retas)'],
        'Hiperextender lumbar abajo': ['Arching your lower back at the bottom', 'Hiperestender a lombar embaixo'],
        'Hombros pasivos': ['Passive shoulders', 'Ombros passivos'],
        'Knee Raises (más fácil)': ['Knee Raises (easier)', 'Elevação de joelhos (mais fácil)'],
        'Knee raises → leg raises rectas → toes to bar': ['Knee raises → straight-leg raises → toes to bar', 'Elevação de joelhos → pernas retas → toes to bar'],
        // Crunch clásico
        'Flexión de tronco para el recto abdominal superior. La base del entrenamiento de abdominales.': ['Trunk flexion for the upper abs. The foundation of ab training.', 'Flexão de tronco para o reto abdominal superior. A base do treino de abdômen.'],
        'Subí con el abdomen, no tires del cuello': ["Lift with your abs, don't pull your neck", 'Suba com o abdômen, não puxe o pescoço'],
        'Manos suaves detrás de la cabeza o cruzadas en el pecho': ['Hands lightly behind your head or crossed on your chest', 'Mãos leves atrás da cabeça ou cruzadas no peito'],
        'Rango corto: despegá solo las escápulas': ['Short range: just lift your shoulder blades', 'Amplitude curta: tire só as escápulas do chão'],
        'Exhalá al subir, apretando el abdomen': ['Exhale as you come up, squeezing your abs', 'Expire ao subir, contraindo o abdômen'],
        'Tirar del cuello con las manos': ['Pulling your neck with your hands', 'Puxar o pescoço com as mãos'],
        'Subir todo el torso (eso es sit-up, más flexor de cadera)': ["Sitting all the way up (that's a sit-up, more hip flexor)", 'Subir o tronco todo (isso é sit-up, mais flexor do quadril)'],
        'No exhalar arriba': ['Not exhaling at the top', 'Não expirar em cima'],
        'Crunch con Peso': ['Weighted Crunch', 'Abdominal com Peso'],
        'Crunch Bicicleta': ['Bicycle Crunch', 'Abdominal Bicicleta'],
        'Crunch en Fitball': ['Stability Ball Crunch', 'Abdominal na Bola'],
        'Dominá 15+ reps limpias → agregá peso o pasá a polea': ['Master 15+ clean reps → add weight or move to the cable', 'Domine 15+ reps limpas → adicione peso ou passe para a polia'],
        '12-20 reps con contracción sentida': ['12-20 reps with a strong squeeze', '12-20 reps sentindo a contração'],
        // Elevación de piernas tumbado
        'Elevación de piernas acostado para el abdomen inferior. Progresión previa a la versión colgado.': ['Lying leg raise for the lower abs. The step before the hanging version.', 'Elevação de pernas deitado para o abdômen inferior. Etapa antes da versão na barra.'],
        'Lumbar PEGADA al piso todo el tiempo': ['Lower back PRESSED to the floor the whole time', 'Lombar COLADA no chão o tempo todo'],
        'Manos bajo la cadera si hace falta soporte': ['Hands under your hips if you need support', 'Mãos sob o quadril se precisar de apoio'],
        'Bajá lento sin que la espalda se arquee': ['Lower slowly without arching your back', 'Desça devagar sem arquear as costas'],
        'Rodillas flexionadas = más fácil': ['Bent knees = easier', 'Joelhos flexionados = mais fácil'],
        'Arquear la zona lumbar al bajar': ['Arching your lower back on the way down', 'Arquear a lombar ao descer'],
        'Usar impulso': ['Using momentum', 'Usar impulso'],
        'Bajar las piernas más allá del control': ['Lowering your legs past the point of control', 'Descer as pernas além do controle'],
        'Contener la respiración': ['Holding your breath', 'Prender a respiração'],
        'Rodillas al Pecho (más fácil)': ['Knees to Chest (easier)', 'Joelhos ao Peito (mais fácil)'],
        'Piernas Rectas': ['Straight Legs', 'Pernas Retas'],
        'Rodillas flexionadas → piernas rectas → colgado en barra': ['Bent knees → straight legs → hanging from a bar', 'Joelhos flexionados → pernas retas → na barra'],
        '10-15 reps controladas': ['10-15 controlled reps', '10-15 reps controladas'],
        // Plancha lateral
        'Isométrico anti-flexión lateral. El mejor punto de partida para oblicuos y estabilidad.': ['Isometric anti-lateral-flexion. The best starting point for obliques and stability.', 'Isométrico anti-flexão lateral. O melhor ponto de partida para oblíquos e estabilidade.'],
        'Codo directamente bajo el hombro': ['Elbow directly under your shoulder', 'Cotovelo logo abaixo do ombro'],
        'Cuerpo en línea recta (cadera arriba)': ['Body in a straight line (hips up)', 'Corpo em linha reta (quadril para cima)'],
        'Apretá el oblicuo del lado de abajo': ['Squeeze the oblique on the bottom side', 'Contraia o oblíquo do lado de baixo'],
        'Mirada al frente, cuello neutro': ['Eyes forward, neutral neck', 'Olhar à frente, pescoço neutro'],
        'Cadera caída': ['Hips sagging', 'Quadril caído'],
        'Rotar el torso hacia adelante': ['Rotating your torso forward', 'Girar o tronco para frente'],
        'Hombro colapsado (sin empujar el piso)': ['Collapsed shoulder (not pushing the floor away)', 'Ombro colapsado (sem empurrar o chão)'],
        'Con rodillas apoyadas (más fácil)': ['With knees down (easier)', 'Com joelhos apoiados (mais fácil)'],
        'Con elevación de cadera': ['With hip raises', 'Com elevação de quadril'],
        'Con rotación (thread the needle)': ['With rotation (thread the needle)', 'Com rotação (thread the needle)'],
        '20-30s por lado → 45-60s → variantes dinámicas': ['20-30s per side → 45-60s → dynamic variations', '20-30s por lado → 45-60s → variações dinâmicas'],
        'Hold hasta perder la línea — calidad sobre tiempo': ['Hold until you lose the line — quality over time', 'Segure até perder o alinhamento — qualidade acima do tempo'],
        // Russian twist
        'Rotación de torso sentado para oblicuos. Cargable con disco o mancuerna.': ['Seated torso rotation for the obliques. Can be loaded with a plate or dumbbell.', 'Rotação de tronco sentado para oblíquos. Dá para usar anilha ou halter.'],
        'Girá desde el TORSO, no solo los brazos': ['Rotate from your TORSO, not just your arms', 'Gire pelo TRONCO, não só os braços'],
        'Espalda recta, pecho abierto (no redondear)': ["Back straight, chest open (don't round)", 'Costas retas, peito aberto (sem arredondar)'],
        'Pies apenas apoyados o elevados (más difícil)': ['Feet barely touching or raised (harder)', 'Pés mal apoiados ou elevados (mais difícil)'],
        'Tocá el piso a cada lado con control': ['Touch the floor on each side with control', 'Toque o chão de cada lado com controle'],
        'Mover solo los brazos sin rotar el tronco': ['Moving only your arms without rotating your trunk', 'Mexer só os braços sem girar o tronco'],
        'Redondear la espalda baja': ['Rounding your lower back', 'Arredondar a lombar'],
        'Apoyar los pies con las piernas relajadas': ['Resting your feet with relaxed legs', 'Apoiar os pés com as pernas relaxadas'],
        'Sin peso (más fácil)': ['No weight (easier)', 'Sem peso (mais fácil)'],
        'Con disco/mancuerna': ['With a plate/dumbbell', 'Com anilha/halter'],
        'Pies elevados': ['Feet raised', 'Pés elevados'],
        'En decline bench': ['On a decline bench', 'No banco declinado'],
        'Sin peso → con peso → pies elevados + peso': ['No weight → weighted → feet raised + weight', 'Sem peso → com peso → pés elevados + peso'],
        '12-16 giros por lado': ['12-16 twists per side', '12-16 giros por lado'],
        // Dead bug
        'Anti-extensión con coordinación contralateral. Estabilidad profunda del core sin cargar la lumbar.': ['Anti-extension with opposite-limb coordination. Deep core stability without loading your lower back.', 'Anti-extensão com coordenação contralateral. Estabilidade profunda do core sem sobrecarregar a lombar.'],
        'Lumbar pegada al piso TODO el tiempo': ['Lower back pressed to the floor the WHOLE time', 'Lombar colada no chão o TEMPO TODO'],
        'Extendé brazo y pierna contrarios, lento': ['Extend the opposite arm and leg, slowly', 'Estenda braço e perna opostos, devagar'],
        'Exhalá al extender, apretando el abdomen': ['Exhale as you extend, squeezing your abs', 'Expire ao estender, contraindo o abdômen'],
        'Movimiento lento y deliberado': ['Slow, deliberate movement', 'Movimento lento e deliberado'],
        'Que la lumbar se despegue al extender': ['Letting your lower back lift as you extend', 'Deixar a lombar descolar ao estender'],
        'Ir rápido (pierde todo el sentido)': ['Going fast (defeats the purpose)', 'Ir rápido (perde todo o sentido)'],
        'Extender brazo y pierna del mismo lado': ['Extending the arm and leg on the same side', 'Estender braço e perna do mesmo lado'],
        'Cuello tensionado': ['Tense neck', 'Pescoço tenso'],
        'Solo piernas (más fácil)': ['Legs only (easier)', 'Só pernas (mais fácil)'],
        'Con banda entre manos y rodillas': ['With a band between your hands and knees', 'Com elástico entre mãos e joelhos'],
        'Con disco en las manos': ['Holding a plate', 'Com anilha nas mãos'],
        'Solo piernas → contralateral completo → con resistencia': ['Legs only → full opposite-limb → with resistance', 'Só pernas → contralateral completo → com resistência'],
        '8-12 por lado, tempo lento': ['8-12 per side, slow tempo', '8-12 por lado, ritmo lento'],
        // Dragon flag
        'Anti-extensión de cuerpo completo estilo Bruce Lee. El ejercicio más exigente del core — también activa serrato y dorsal.': ['Bruce Lee-style full-body anti-extension. The toughest core exercise — it also hits the serratus and lats.', 'Anti-extensão de corpo inteiro estilo Bruce Lee. O exercício de core mais exigente — também ativa serrátil e dorsais.'],
        'Agarrá el banco detrás de la cabeza firme': ['Grip the bench firmly behind your head', 'Segure firme o banco atrás da cabeça'],
        'Cuerpo rígido como tabla de hombros a pies': ['Body rigid like a board from shoulders to feet', 'Corpo rígido como uma tábua dos ombros aos pés'],
        'Bajá LENTO sin quebrar la cadera': ['Lower SLOWLY without breaking at the hips', 'Desça DEVAGAR sem quebrar o quadril'],
        'Apoyá solo la parte alta de la espalda (no el cuello)': ['Rest only on your upper back (not your neck)', 'Apoie só a parte alta das costas (não o pescoço)'],
        'Quebrar la cadera (pierde la línea)': ['Breaking at the hips (losing the line)', 'Quebrar o quadril (perde o alinhamento)'],
        'Caer sin control en la bajada': ['Dropping without control on the way down', 'Cair sem controle na descida'],
        'Apoyar el cuello en vez de los hombros': ['Resting on your neck instead of your shoulders', 'Apoiar o pescoço em vez dos ombros'],
        'Intentarlo sin base previa (plancha + ab wheel primero)': ['Trying it without a base (plank + ab wheel first)', 'Tentar sem base (prancha + roda abdominal antes)'],
        'Negativas solamente (empezá acá)': ['Negatives only (start here)', 'Só negativas (comece por aqui)'],
        'Con rodillas flexionadas': ['With bent knees', 'Com joelhos flexionados'],
        'Una pierna': ['One leg', 'Uma perna'],
        'Completo': ['Full', 'Completo'],
        'Negativas con rodillas → negativas rectas → reps completas': ['Bent-knee negatives → straight-leg negatives → full reps', 'Negativas com joelhos → negativas retas → reps completas'],
        '5-8 reps o 3-5 negativas lentas': ['5-8 reps or 3-5 slow negatives', '5-8 reps ou 3-5 negativas lentas'],
        // Crunch en polea
        'Crunch arrodillado en polea alta. La mejor forma de cargar progresivamente el recto abdominal.': ['Kneeling crunch on a high cable. The best way to progressively load the abs.', 'Abdominal ajoelhado na polia alta. A melhor forma de aumentar a carga no reto abdominal.'],
        'Cadera quieta — flexioná solo el tronco': ['Hips still — flex only your trunk', 'Quadril parado — flexione só o tronco'],
        'Llevá los codos hacia las rodillas': ['Bring your elbows toward your knees', 'Leve os cotovelos em direção aos joelhos'],
        'La resistencia la mueve el abdomen, no los brazos': ['Your abs move the weight, not your arms', 'Quem move a carga é o abdômen, não os braços'],
        'Estirá bien arriba para rango completo': ['Stretch fully at the top for a full range', 'Alongue bem em cima para a amplitude completa'],
        'Flexionar desde la cadera (parece remo)': ['Bending from the hips (looks like a row)', 'Flexionar pelo quadril (parece remada)'],
        'Tirar con los brazos': ['Pulling with your arms', 'Puxar com os braços'],
        'Peso excesivo que rompe la técnica': ['Too much weight, breaking your technique', 'Carga excessiva que quebra a técnica'],
        'De pie contra la polea': ['Standing at the cable', 'Em pé na polia'],
        'Con giro (oblicuos)': ['With a twist (obliques)', 'Com rotação (oblíquos)'],
        'En banco declinado con disco': ['On a decline bench with a plate', 'No banco declinado com anilha'],
        'Subí peso cuando hagas 15 reps limpias — es un músculo más: sobrecarga progresiva': ["Add weight once you hit 15 clean reps — it's a muscle like any other: progressive overload", 'Suba a carga quando fizer 15 reps limpas — é um músculo como outro: sobrecarga progressiva'],
        '10-15 reps con contracción fuerte': ['10-15 reps with a hard squeeze', '10-15 reps com contração forte'],
        // Running
        'Cardio fundamental. Mejora capacidad aeróbica y resistencia muscular.': ['Fundamental cardio. Improves aerobic capacity and muscular endurance.', 'Cardio fundamental. Melhora a capacidade aeróbica e a resistência muscular.'],
        'Pisada media (no muy talón ni puntera)': ['Midfoot strike (not too much heel or toe)', 'Pisada média (nem muito calcanhar nem ponta)'],
        'Cadencia ~170-180 pasos/min': ['Cadence ~170-180 steps/min', 'Cadência ~170-180 passos/min'],
        'Postura erguida, mirada al frente': ['Upright posture, eyes forward', 'Postura ereta, olhar à frente'],
        'Brazos relajados, no cruzar línea media': ["Relaxed arms, don't cross your midline", 'Braços relaxados, sem cruzar a linha média'],
        'Pisada muy de talón (impacto alto)': ['Heavy heel strike (high impact)', 'Pisada muito de calcanhar (impacto alto)'],
        'Zancada muy larga (overstriding)': ['Stride too long (overstriding)', 'Passada muito longa (overstriding)'],
        'Hombros encogidos': ['Hunched shoulders', 'Ombros encolhidos'],
        'Mirar el piso': ['Looking down at the ground', 'Olhar para o chão'],
        'Regla del 10% — no aumentar volumen más del 10% por semana': ["The 10% rule — don't increase volume by more than 10% a week", 'Regra dos 10% — não aumente o volume mais de 10% por semana'],
        'Zone 2 conversacional la mayoría · Sprints al 90%+': ['Mostly conversational Zone 2 · Sprints at 90%+', 'Maioria em Zona 2 conversável · Sprints a 90%+'],
        // Ciclismo
        'Cardio de bajo impacto. Excelente para construir base aeróbica.': ['Low-impact cardio. Great for building an aerobic base.', 'Cardio de baixo impacto. Ótimo para construir base aeróbica.'],
        'Sillín a altura correcta (rodilla casi extendida en punto bajo)': ['Saddle at the right height (knee almost straight at the bottom)', 'Selim na altura certa (joelho quase estendido no ponto baixo)'],
        'Cadencia 80-90 RPM': ['Cadence 80-90 RPM', 'Cadência 80-90 RPM'],
        'Espalda recta o ligeramente inclinada': ['Back straight or slightly leaning forward', 'Costas retas ou levemente inclinadas'],
        'Hidratación constante': ['Stay hydrated', 'Hidratação constante'],
        'Sillín muy bajo (estrés en rodilla)': ['Saddle too low (stress on the knee)', 'Selim muito baixo (estresse no joelho)'],
        'Cadencia muy baja (fuerza, no aeróbico)': ['Cadence too low (strength, not aerobic)', 'Cadência muito baixa (força, não aeróbico)'],
        'Mala postura (espalda redondeada)': ['Poor posture (rounded back)', 'Postura ruim (costas arredondadas)'],
        'Sin hidratarse': ['Not drinking enough', 'Não se hidratar'],
        'Aumentá duración o intensidad gradualmente': ['Increase duration or intensity gradually', 'Aumente a duração ou a intensidade aos poucos'],
        'Zone 2 mayoría · intervalos al 85%+': ['Mostly Zone 2 · intervals at 85%+', 'Maioria em Zona 2 · intervalos a 85%+'],
        // Saltar la cuerda
        'Cardio de alto rendimiento. Coordinación + condición + pantorrillas.': ['High-output cardio. Coordination + conditioning + calves.', 'Cardio de alto rendimento. Coordenação + condicionamento + panturrilhas.'],
        'Saltos bajos (5cm es suficiente)': ['Low jumps (5cm is enough)', 'Saltos baixos (5cm é suficiente)'],
        'Aterrizaje en planta del pie (no talón)': ['Land on the balls of your feet (not your heels)', 'Aterrisse na ponta dos pés (não no calcanhar)'],
        'Codos cerca del torso, muñecas hacen el trabajo': ['Elbows close to your body, wrists do the work', 'Cotovelos perto do tronco, os punhos fazem o trabalho'],
        'Mirá al frente, no a la cuerda': ['Look ahead, not at the rope', 'Olhe à frente, não para a corda'],
        'Saltos demasiado altos (fatiga rápida)': ['Jumping too high (you tire fast)', 'Saltos altos demais (cansa rápido)'],
        'Caer en talones': ['Landing on your heels', 'Cair nos calcanhares'],
        'Brazos abiertos': ['Arms out wide', 'Braços abertos'],
        'Tensión en hombros': ['Tension in your shoulders', 'Tensão nos ombros'],
        'Empezá con 30s on / 30s off, llegá a 3 min continuos': ['Start with 30s on / 30s off and build to 3 minutes straight', 'Comece com 30s sim / 30s não e chegue a 3 min seguidos'],
        'Intervalos cortos al 80-90%': ['Short intervals at 80-90%', 'Intervalos curtos a 80-90%'],
        // Boxeo
        'Cardio + coordinación + fuerza. Combina condición con técnica.': ['Cardio + coordination + strength. Combines conditioning with technique.', 'Cardio + coordenação + força. Combina condicionamento com técnica.'],
        'Guardia siempre arriba': ['Guard up at all times', 'Guarda sempre alta'],
        'Movimiento de piernas constante (no plantado)': ['Keep your feet moving (not planted)', 'Pernas em movimento constante (não parado)'],
        'Combinaciones cortas con buena técnica': ['Short combinations with good technique', 'Combinações curtas com boa técnica'],
        'Respiración explosiva al golpear': ['Explosive breath as you strike', 'Respiração explosiva ao golpear'],
        'Manos bajas': ['Dropping your hands', 'Mãos baixas'],
        'Pies cruzados': ['Crossing your feet', 'Pés cruzados'],
        'Tirar fuerza sin técnica': ['Throwing power without technique', 'Bater forte sem técnica'],
        'Rondas de 1-2 min con descanso · llegá a 3 min': ['1-2 min rounds with rest · build to 3 min', 'Rounds de 1-2 min com descanso · chegue a 3 min'],
        'Intervalos de alta intensidad': ['High-intensity intervals', 'Intervalos de alta intensidade']
    };

    var TR = Object.assign({}, LABELS, EXERCISES, SPORTS, QUOTES, ROUTINE, LIBRARY);
    var IDX = { en: 0, pt: 1 };
    var SEPARATORS = [' · ', '/', ' — ', ' + '];

    function lookup(s, i) {
        var hit = TR[s];
        if (hit) return hit[i] || s;
        for (var p = 0; p < PATTERNS.length; p++) if (PATTERNS[p][0].test(s)) return s.replace(PATTERNS[p][0], PATTERNS[p][1][i]);
        // "PECHO" → "Pecho" (los títulos en mayúsculas)
        if (s.length > 2 && s === s.toUpperCase() && s !== s.toLowerCase()) {
            var cap = s.charAt(0) + s.slice(1).toLowerCase();
            if (TR[cap]) return (TR[cap][i] || cap).toUpperCase();
        }
        return null;
    }

    // Texto de datos en el idioma pedido ('en' | 'pt'). Lo que no está en la
    // tabla (lo que escribió el usuario, nombres propios) vuelve tal cual.
    // Tolera prefijos/sufijos que no son letras ("🏆 Press Banca Plano") y
    // compuestos con " · ", "/", " — " o " + " ("Pecho/Hombros/Tríceps").
    function trData(s, lang) {
        var i = IDX[lang];
        if (i === undefined || typeof s !== 'string' || !s) return s;
        var direct = lookup(s, i);
        if (direct !== null) return direct;
        // Primero solo comillas/espacios alrededor ('"Frase."'); después también puntuación ('Sentadilla:').
        var wraps = [/^([^A-Za-zÀ-ÿ¿¡]*)(.*?)(["”»\s]*)$/, /^([^A-Za-zÀ-ÿ¿¡]*)(.*?)([\s.:!?)"”»]*)$/];
        for (var w = 0; w < wraps.length; w++) {
            var m = s.match(wraps[w]);
            if (m && m[2] && m[2] !== s) {
                var core = lookup(m[2], i);
                if (core !== null) return m[1] + core + m[3];
            }
        }
        for (var k = 0; k < SEPARATORS.length; k++) {
            var sep = SEPARATORS[k];
            if (s.indexOf(sep) <= 0) continue;
            var changed = false;
            var parts = s.split(sep).map(function (p) {
                var tp = trData(p, lang);
                if (tp !== p) changed = true;
                return tp;
            });
            if (changed) return parts.join(sep);
        }
        return s;
    }

    // La app suma acá los valores en español de su diccionario I18N: algunos
    // quedan guardados dentro de los datos (el método y la nota de progresión de
    // la rutina generada) y tienen que poder traducirse igual. No pisa lo que ya está.
    function addDataTr(map) {
        for (var k in map) {
            if (Object.prototype.hasOwnProperty.call(map, k) && !TR[k] && map[k] && map[k][0] && map[k][1]) TR[k] = map[k];
        }
    }

    return { DATA_TR: TR, trData: trData, addDataTr: addDataTr };
});
