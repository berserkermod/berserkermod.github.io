// Dobles de prueba de Cloudflare: Durable Objects (almacenamiento + alarma) y KV.
// Imitan la API real que usa el Worker y suman perillas para probar lo que en la vida real
// pasa de vez en cuando: demoras, KV respondiendo 429 y lecturas viejas de KV.
//
// Ojo: el doble NO pone en fila los pedidos a un mismo objeto. Eso lo tiene que hacer el
// propio Worker (Notifier.lock); si no lo hace, las pruebas de carreras lo muestran.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => (typeof v === 'string' || v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)));

// Almacenamiento de un Durable Object (API de claves y valores de los objetos con SQLite).
export function makeStorage(opts = {}) {
    const m = new Map();
    const st = {
        _m: m, alarm: null, rowsWritten: 0, rowsRead: 0,
        delay: opts.delay || 0,
        async _wait() { if (st.delay) await sleep(st.delay); else await null; },
        async get(k) {
            await st._wait();
            if (Array.isArray(k)) {
                const out = new Map();
                for (const x of k) { st.rowsRead++; if (m.has(x)) out.set(x, clone(m.get(x))); }
                return out;
            }
            st.rowsRead++;
            return clone(m.get(k));
        },
        async put(k, v) {
            await st._wait();
            const entries = typeof k === 'string' ? [[k, v]] : Object.entries(k);
            if (entries.length > 128) throw new Error('put: más de 128 claves');
            for (const [kk, vv] of entries) { m.set(kk, clone(vv)); st.rowsWritten++; }
        },
        async delete(k) {
            await st._wait();
            const keys = Array.isArray(k) ? k : [k];
            if (keys.length > 128) throw new Error('delete: más de 128 claves');
            let n = 0;
            for (const x of keys) { if (m.delete(x)) n++; st.rowsWritten++; }
            return Array.isArray(k) ? n : n > 0;
        },
        async list(o = {}) {
            await st._wait();
            let keys = [...m.keys()].sort();
            if (o.prefix) keys = keys.filter((x) => x.startsWith(o.prefix));
            if (o.start) keys = keys.filter((x) => x >= o.start);
            if (o.startAfter) keys = keys.filter((x) => x > o.startAfter);
            if (o.end) keys = keys.filter((x) => x < o.end);
            if (o.reverse) keys.reverse();
            if (o.limit) keys = keys.slice(0, o.limit);
            st.rowsRead += keys.length;
            return new Map(keys.map((x) => [x, clone(m.get(x))]));
        },
        async deleteAll() { await st._wait(); m.clear(); },
        async getAlarm() { return st.alarm; },
        async setAlarm(t) { st.alarm = Number(t); st.rowsWritten++; },
        async deleteAlarm() { st.alarm = null; }
    };
    return st;
}

// Espacio de nombres de Durable Objects: un objeto (con su almacenamiento) por nombre.
// _dos: nombre → { storage, obj }. calls: pedidos hechos (para medir costo).
export function makeDONamespace(NotifierClass, env, opts = {}) {
    const dos = new Map();
    const ns = {
        _dos: dos, calls: 0, down: false,
        idFromName: (name) => ({ name }),
        get(id) {
            if (!dos.has(id.name)) {
                const storage = makeStorage(opts);
                dos.set(id.name, { storage, obj: new NotifierClass({ storage }, env) });
            }
            const d = dos.get(id.name);
            return {
                fetch: async (u, init) => {
                    ns.calls++;
                    if (ns.down) throw new Error('Durable Object no disponible');
                    return d.obj.fetch(new Request(u, init));
                }
            };
        },
        // Dispara la alarma de un objeto si ya le toca (o sí o sí con force).
        async fire(name, force) {
            const d = dos.get(name);
            if (!d || d.storage.alarm == null || (!force && d.storage.alarm > Date.now())) return false;
            d.storage.alarm = null;   // como el runtime: la alarma que se dispara ya no está programada
            await d.obj.alarm();
            return true;
        }
    };
    return ns;
}

// KV en memoria con perillas:
//   delay      demora de cada operación (ms)
//   failPut    true → put/delete tiran "429 Too Many Requests" (cuota diaria agotada)
//   failGet    true → get tira error
//   stale      key → valor viejo que devuelve la PRÓXIMA lectura (consistencia eventual)
//   log        cada put/delete, en orden de llegada (para revisar el orden del espejo)
export function makeKV(opts = {}) {
    const m = new Map(), meta = new Map();
    const kv = {
        _m: m, w: 0, r: 0, l: 0, d: 0, log: [],
        delay: opts.delay || 0, failPut: false, failGet: false, stale: new Map(),
        delayFor: null,   // (op, key) → ms: demora distinta por operación
        async _wait(op, key) {
            const ms = kv.delayFor ? kv.delayFor(op, key) : kv.delay;
            if (ms) await sleep(ms); else await null;
        },
        async get(k) {
            kv.r++;
            await kv._wait('get', k);
            if (kv.failGet) throw new Error('KV GET failed: 500');
            if (kv.stale.has(k)) { const v = kv.stale.get(k); kv.stale.delete(k); return v; }
            return m.has(k) ? m.get(k) : null;
        },
        async put(k, v, o) {
            kv.w++;
            await kv._wait('put', k);
            if (kv.failPut) throw new Error('KV PUT failed: 429 Too Many Requests');
            m.set(k, String(v));
            if (o && o.metadata) meta.set(k, o.metadata); else meta.delete(k);
            kv.log.push(['put', k, String(v)]);
        },
        async delete(k) {
            kv.d++;
            await kv._wait('delete', k);
            if (kv.failPut) throw new Error('KV DELETE failed: 429 Too Many Requests');
            m.delete(k); meta.delete(k);
            kv.log.push(['delete', k]);
        },
        async list({ prefix = '', cursor, limit = 1000 } = {}) {
            kv.l++;
            await kv._wait('list', prefix);
            if (kv.failGet) throw new Error('KV LIST failed: 500');
            const all = [...m.keys()].filter((k) => k.startsWith(prefix)).sort();
            const from = cursor ? all.filter((k) => k <= cursor).length : 0;
            const page = all.slice(from, from + limit);
            const done = from + page.length >= all.length;
            return { keys: page.map((name) => (meta.has(name) ? { name, metadata: meta.get(name) } : { name })), list_complete: done, cursor: done ? null : page[page.length - 1] };
        },
        counts() { return { w: kv.w, r: kv.r, l: kv.l, d: kv.d }; }
    };
    return kv;
}
