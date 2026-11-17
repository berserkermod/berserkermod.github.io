// BERSERKERMOD — Almacén del coach (vive dentro de su Durable Object)
// =====================================================================
// Cada coach tiene un objeto ('coach:{coachId}') que guarda todo lo de sus alumnos. El objeto
// atiende de a un pedido por vez (la fila la pone Notifier.lock) y este almacén le da a cada
// pedido tres cosas:
//
//   1. Guardar todo junto o nada: lo que escribe un pedido queda en memoria hasta commit().
//      Si el pedido falla antes, no se guarda nada.
//   2. Migración de a poco: si un alumno todavía no está en el objeto, se trae de KV (formato
//      viejo) la primera vez que alguien lo necesita. KV no se toca.
//   3. Espejo: con KV_MIRROR prendido, cada cambio se copia a KV con la key y el formato de
//      siempre, para poder volver atrás publicando el Worker anterior. Las copias salen de a
//      una, adentro de la fila y siempre con el valor MÁS NUEVO del objeto: un cambio viejo
//      nunca puede pisar a uno nuevo. Si KV rechaza la copia (429), queda anotada ('mq:') y
//      se reintenta sola; el pedido del usuario igual sale bien.
//
// Filas del objeto (cada una es una fila de su SQLite):
//   routine:{id}                      registro del alumno (texto JSON, igual que en KV)
//   sessions|checkins|edits|evals|videos|review:{id}   igual que en KV
//   cfg                               configuración del coach (en KV: coachcfg:{coachId})
//   sum:{id}                          lo que muestra el panel (sin el plan ni lo pesado) + "visto"
//   imp:{id}  'r' | 'f'               ya se trajo de KV el registro / todo lo del alumno
//   imp:cfg, imp:all, imp:cur         configuración traída / panel completo / por dónde va
//   gone:{id}                         alumno dado de baja: no volver a traerlo de KV
//   mq:{fila}  'p' | 'P' | 'd'        copia a KV pendiente (poner / poner sí o sí / borrar)
//   mq:retry                          cuándo reintentar las copias pendientes
//   epoch, coach                      número de migración y de quién es el objeto
// =====================================================================

const AGG_KINDS = ['sessions', 'checkins', 'edits', 'evals', 'videos', 'review'];
const AGG_RE = /^(sessions|checkins|edits|evals|videos|review):([A-Za-z0-9-]{1,64})$/;
const COACH_KEY_RE = /^(routine|coachcfg|sessions|checkins|edits|evals|videos|review):/;
// Reintentos del espejo: 5 s (KV admite una escritura por segundo a la misma key), 1 min,
// 10 min, 1 h y después cada 6 h (la cuota diaria de KV se renueva a las 00:00 UTC).
const RETRY_STEPS = [5000, 60000, 600000, 3600000, 6 * 3600000];
const PUT_CHUNK = 120;   // el almacenamiento admite hasta 128 filas por llamada

export function mirrorOn(env) { return String((env && env.KV_MIRROR) || 'on') !== 'off'; }
export function dataEpoch(env) { return String((env && env.DATA_EPOCH) || '1'); }
// ¿Es una key con datos de un coach? (para avisar si algo las toca por fuera de su objeto)
export function isCoachKey(key) { return COACH_KEY_RE.test(String(key)); }

// Lo que el panel y las alertas necesitan de un alumno, sin lo pesado (plan, historial de
// volumen, ficha completa, direcciones de los avisos). Queda en ~1 KB por alumno.
export function routineLite(r) {
    const o = Object.assign({}, r);
    o.plan = Array.isArray(r.plan) ? r.plan.map(() => 0) : [];   // las alertas solo usan cuántos días tiene
    if (r.intake) o.intake = 1;
    if (r.profile && typeof r.profile === 'object') {
        o.profile = Object.assign({}, r.profile);
        delete o.profile.notes; delete o.profile.goals;
    }
    delete o.ex_first; delete o.vol_log; delete o.goal_history;
    delete o.push_subs; delete o.moved_tokens; delete o.terms;
    return o;
}

export class CoachStore {
    // pre: keys de KV que el Worker ya leyó (el índice del link), para no leerlas dos veces.
    constructor(storage, env, coachId, pre) {
        this.storage = storage;
        this.env = env;
        this.kv = env.BMOD_KV;
        this.coachId = String(coachId);
        this.pre = pre || new Map();
        this.w = new Map();        // escrituras de este pedido: fila → texto | null (borrar)
        this.after = [];           // lo que se hace después de soltar la fila (avisar a otros objetos)
        this.metaOk = false;
    }

    // ── Nombres: key de KV ⇄ fila del objeto ──
    local(kvKey) {
        const key = String(kvKey);
        const rp = 'routine:' + this.coachId + ':';
        if (key.startsWith(rp)) return 'routine:' + key.slice(rp.length);
        if (key === 'coachcfg:' + this.coachId) return 'cfg';
        if (AGG_RE.test(key)) return key;
        if (key.startsWith('routine:') || key.startsWith('coachcfg:')) throw new Error('dato de otro coach: ' + key.slice(0, 40));
        return null;
    }
    owns(kvKey) { return this.local(kvKey) !== null; }
    kvName(row) {
        if (row === 'cfg') return 'coachcfg:' + this.coachId;
        if (row.startsWith('routine:')) return 'routine:' + this.coachId + ':' + row.slice(8);
        return row;
    }

    // ── Al empezar cada pedido ──
    async open(now = Date.now()) {
        const ep = await this.storage.get('epoch');
        const want = dataEpoch(this.env);
        if (ep !== undefined && ep !== want) {
            if (mirrorOn(this.env)) {
                // Se publicó el Worker anterior un rato y KV quedó más nuevo que el objeto:
                // se descarta lo del objeto y se vuelve a traer todo de KV.
                console.warn('[coach] migración nueva (' + ep + ' → ' + want + '): se vuelve a traer de KV', this.coachId);
                await this.storage.deleteAll();
            } else {
                console.error('[coach] DATA_EPOCH cambió con el espejo apagado: se ignora (KV no está al día)', this.coachId);
                this.metaOk = true;
            }
        } else if (ep === want) this.metaOk = true;
        await this.retryPending(now);
    }
    meta(puts) {
        if (!this.metaOk) { puts.epoch = dataEpoch(this.env); puts.coach = this.coachId; this.metaOk = true; }
        return puts;
    }

    // ── Lecturas y escrituras de un pedido ──
    async get(kvKey) {
        const row = this.local(kvKey);
        if (this.w.has(row)) return this.w.get(row);
        if (row === 'cfg') await this.ensureCfg();
        else if (row.startsWith('routine:')) await this.ensure(row.slice(8), false);
        else await this.ensure(row.slice(row.indexOf(':') + 1), true);
        const v = await this.storage.get(row);
        return v === undefined ? null : v;
    }
    put(kvKey, text) { this.w.set(this.local(kvKey), String(text)); }
    del(kvKey) { this.w.set(this.local(kvKey), null); }

    // ── Migración: traer de KV lo que falte de un alumno ──
    // full = false: solo el registro. full = true: también entrenamientos, controles, etc.
    // Si una lectura de KV falla, no se anota nada (no queda un alumno a medio traer).
    async ensure(id, full) {
        const lvl = await this.storage.get('imp:' + id);
        if (lvl === 'f' || (lvl === 'r' && !full)) return;
        if (await this.storage.get('gone:' + id)) return;
        const puts = {};
        if (!lvl) {
            const raw = await this.kv.get('routine:' + this.coachId + ':' + id);
            if (raw == null) return;   // no existe: no se anota nada (igual que hoy, una lectura)
            const sum = liteFromText(raw);
            if (!sum) return;
            puts['routine:' + id] = raw;
            puts['sum:' + id] = sum;
        }
        if (full) {
            const vals = await Promise.all(AGG_KINDS.map((k) => this.kv.get(k + ':' + id)));
            AGG_KINDS.forEach((k, i) => { if (vals[i] != null) puts[k + ':' + id] = vals[i]; });
        }
        puts['imp:' + id] = full ? 'f' : 'r';
        await this.storage.put(this.meta(puts));
    }
    async ensureCfg() {
        if (await this.storage.get('imp:cfg')) return;
        const raw = await this.kv.get('coachcfg:' + this.coachId);
        const puts = { 'imp:cfg': 1 };
        if (raw != null) puts.cfg = raw;
        await this.storage.put(this.meta(puts));
    }

    // ── Guardar todo junto ──
    async commit() {
        if (!this.w.size) return;
        const puts = {}, dels = [], dirty = [];
        const mirror = mirrorOn(this.env);
        let allImported;
        for (const [row, v] of this.w) {
            const rid = row.startsWith('routine:') ? row.slice(8) : null;
            if (v === null) {
                // Los borrados van siempre a KV, con espejo o sin él: dar de baja a un alumno
                // es un pedido de borrar sus datos.
                dels.push(row);
                puts['mq:' + row] = 'd';
                dirty.push(row);
                if (rid) { dels.push('sum:' + rid); puts['gone:' + rid] = 1; }
                continue;
            }
            puts[row] = v;
            let mark = mirror ? 'p' : null;
            if (rid) {
                const sum = liteFromText(v);
                const old = await this.storage.get('sum:' + rid);
                if (sum) {
                    if (old && old.last_seen_by_alumno_at && !(sum.last_seen_by_alumno_at >= old.last_seen_by_alumno_at)) sum.last_seen_by_alumno_at = old.last_seen_by_alumno_at;
                    puts['sum:' + rid] = sum;
                }
                if (!(await this.storage.get('imp:' + rid))) {
                    // Alumno nuevo. Mientras el panel de este coach no terminó de migrarse, el
                    // panel se arma listando KV: el alumno nuevo tiene que figurar ahí.
                    puts['imp:' + rid] = 'f';
                    if (allImported === undefined) allImported = !!(await this.storage.get('imp:all'));
                    if (!allImported) mark = 'P';
                }
            }
            if (mark) { puts['mq:' + row] = mark; dirty.push(row); }
        }
        this.meta(puts);
        // Sin esperar entre una llamada y la otra: el objeto las guarda juntas o no guarda ninguna.
        const ops = [];
        const keys = Object.keys(puts);
        if (keys.length > PUT_CHUNK) throw new Error('demasiadas filas en un pedido');
        if (keys.length) ops.push(this.storage.put(puts));
        if (dels.length) ops.push(this.storage.delete(dels));
        await Promise.all(ops);
        this.w.clear();
        await this.flush(dirty);
    }

    // ── Espejo a KV ──
    // Siempre adentro de la fila y siempre con el valor actual del objeto. Devuelve false si
    // KV falló (lo que falta queda anotado y se reintenta).
    async flush(rows, now = Date.now()) {
        const mirror = mirrorOn(this.env);
        for (const row of rows) {
            const mark = await this.storage.get('mq:' + row);
            if (!mark) continue;
            try {
                const cur = await this.storage.get(row);
                if (cur === undefined) await this.kv.delete(this.kvName(row));
                else if (mirror || mark === 'P') await this.kv.put(this.kvName(row), cur);
                await this.storage.delete('mq:' + row);
            } catch (e) {
                console.error('[coach] espejo a KV pendiente', this.kvName(row), String((e && e.message) || e).slice(0, 120));
                await this.scheduleRetry(now);
                return false;
            }
        }
        return true;
    }
    async scheduleRetry(now) {
        const prev = await this.storage.get('mq:retry');
        if (prev && prev.at > now) return;   // ya hay un reintento programado: una falla más por tanda, no por pedido
        const n = ((prev && prev.n) || 0) + 1;
        const at = now + RETRY_STEPS[Math.min(n - 1, RETRY_STEPS.length - 1)];
        await this.storage.put('mq:retry', { n, at });
        const alarm = await this.storage.getAlarm();
        if (!alarm || alarm > at) await this.storage.setAlarm(at);
    }
    // Copias que quedaron pendientes: se reintentan cuando toca (al llegar un pedido o con la alarma).
    async retryPending(now = Date.now()) {
        const rt = await this.storage.get('mq:retry');
        if (!rt || now < rt.at) return;
        const rows = [...(await this.storage.list({ prefix: 'mq:', limit: 40 })).keys()].filter((k) => k !== 'mq:retry').map((k) => k.slice(3));
        if (!rows.length) { await this.storage.delete('mq:retry'); return; }
        if (!(await this.flush(rows, now))) return;   // KV sigue sin responder: flush() ya anotó el próximo intento
        if (rows.length < 39) { await this.storage.delete('mq:retry'); return; }
        // Quedan más: sigue en 2 segundos, sin contarlo como falla
        await this.storage.put('mq:retry', { n: 0, at: now + 2000 });
        await this.storage.setAlarm(now + 2000);
    }
    async pendingCount() {
        return [...(await this.storage.list({ prefix: 'mq:', limit: 200 })).keys()].filter((k) => k !== 'mq:retry').length;
    }

    // ── "Visto por el alumno": no reescribe el registro ni va a KV ──
    async seen(id) {
        const s = await this.storage.get('sum:' + id);
        return (s && s.last_seen_by_alumno_at) || null;
    }
    async markSeen(id, iso) {
        const s = await this.storage.get('sum:' + id);
        if (!s) return;
        s.last_seen_by_alumno_at = iso;
        await this.storage.put('sum:' + id, s);
    }

    // ── Una página del panel del coach ──
    // Con el panel ya migrado (imp:all): sale del objeto, sin tocar KV.
    // Antes: se arma listando KV, como siempre (un listado + una lectura por alumno que falte),
    // y lo que se lee queda en el objeto. Cuando una pasada llega al final, queda migrado.
    async listPage(cursor, limit) {
        cursor = cursor || '';
        const all = await this.storage.get('imp:all');
        if (cursor.startsWith('d:') && !all) throw new Error('cursor');
        if (all && (!cursor || cursor.startsWith('d:'))) {
            const opts = { prefix: 'sum:', limit: limit + 1 };
            if (cursor) opts.startAfter = 'sum:' + cursor.slice(2);
            const rows = [...(await this.storage.list(opts))];
            const page = rows.slice(0, limit);
            return { items: page.map((x) => x[1]), next: rows.length > limit ? 'd:' + page[page.length - 1][0].slice(4) : null };
        }
        const prefix = 'routine:' + this.coachId + ':';
        const res = await this.kv.list({ prefix, cursor: cursor || undefined, limit });
        const ids = res.keys.map((k) => k.name.slice(prefix.length));
        const have = ids.length ? await this.storage.get(ids.map((id) => 'sum:' + id)) : new Map();
        const gone = ids.length ? await this.storage.get(ids.map((id) => 'gone:' + id)) : new Map();
        const missing = ids.filter((id) => !have.has('sum:' + id) && !gone.has('gone:' + id));
        const raws = await Promise.all(missing.map((id) => this.kv.get(prefix + id)));
        let puts = {}, n = 0;
        const writes = [];
        missing.forEach((id, i) => {
            const sum = raws[i] != null ? liteFromText(raws[i]) : null;
            if (!sum) return;
            puts['routine:' + id] = raws[i]; puts['sum:' + id] = sum; puts['imp:' + id] = 'r';
            have.set('sum:' + id, sum);
            if ((n += 3) >= PUT_CHUNK - 6) { writes.push(puts); puts = {}; n = 0; }
        });
        // ¿Esta página sigue a la anterior? Solo una pasada completa y en orden da el panel por migrado.
        const last = await this.storage.get('imp:cur');
        const next = res.list_complete ? null : (res.cursor || null);
        if (!cursor || cursor === last) {
            if (next) puts['imp:cur'] = next; else puts['imp:all'] = 1;
        }
        if (Object.keys(puts).length) writes.push(puts);
        for (const p of writes) await this.storage.put(this.meta(p));
        return { items: ids.map((id) => have.get('sum:' + id)).filter(Boolean), next };
    }
}

function liteFromText(raw) {
    try {
        const r = JSON.parse(raw);
        return r && typeof r === 'object' ? routineLite(r) : null;
    } catch { return null; }
}

// KV para el código de las rutas cuando corre adentro del objeto del coach: lo que es del
// coach va a su almacén; el resto (índice de links, licencias, reportes) sigue en KV.
export function coachKV(store) {
    const kv = store.kv;
    return {
        async get(key, opts) {
            if (store.owns(key)) return store.get(key);
            if (store.pre.has(key)) return store.pre.get(key);
            return kv.get(key, opts);
        },
        async put(key, val, opts) {
            if (store.owns(key)) return store.put(key, val);
            store.pre.delete(key);
            return kv.put(key, val, opts);
        },
        async delete(key) {
            if (store.owns(key)) return store.del(key);
            store.pre.delete(key);
            return kv.delete(key);
        },
        list(opts) { return kv.list(opts); }
    };
}

// KV para el código de las rutas cuando corre en el Worker con los datos del coach ya en su
// objeto: ahí no se tiene que tocar ninguna key del coach. Si pasa, es un error de programa
// y conviene que salte en vez de leer una copia que puede estar vieja.
export function guardKV(kv) {
    const stop = (key) => { if (isCoachKey(key)) throw new Error('dato del coach fuera de su objeto: ' + String(key).slice(0, 40)); };
    return {
        get(key, opts) { stop(key); return kv.get(key, opts); },
        put(key, val, opts) { stop(key); return kv.put(key, val, opts); },
        delete(key) { stop(key); return kv.delete(key); },
        list(opts) { stop((opts && opts.prefix) || ''); return kv.list(opts); }
    };
}
