// Arma las copias en inglés y portugués de la landing (en/index.html y pt/index.html)
// y los datos estructurados (JSON-LD) de los tres idiomas.
//
// Por qué: la landing traduce con JavaScript, pero los robots de los buscadores y de los
// asistentes de IA (ChatGPT, Claude, Perplexity…) leen el HTML sin ejecutarlo. Con esto cada
// idioma tiene su dirección y su texto ya escrito: /, /en/ y /pt/.
//
// Se edita solo index.html (español + diccionario landing-i18n). Después:
//     node tools/landing-langs.mjs           → escribe en/, pt/ y el JSON-LD de index.html
//     node tools/landing-langs.mjs --check   → no escribe; falla si algo quedó viejo (lo corre npm test)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://berserkermod.github.io/';
const LANGS = {
    es: { idx: -1, dir: '', html: 'es-AR', og: 'es_AR', ld: 'es' },
    en: { idx: 0, dir: 'en/', html: 'en', og: 'en_US', ld: 'en' },
    pt: { idx: 1, dir: 'pt/', html: 'pt-BR', og: 'pt_BR', ld: 'pt-BR' },
};
const OFFER_TEXT = {
    es: 'Plan Free gratis para siempre, sin tarjeta. Premium: 7 días de prueba gratis y después planes de 1 a 12 meses. Modo Coach para entrenadores: 10 días de prueba gratis. Sin renovación automática.',
    en: 'Free plan, free forever, no card. Premium: 7-day free trial, then 1 to 12-month plans. Coach mode for personal trainers: 10-day free trial. No automatic renewal.',
    pt: 'Plano Free grátis para sempre, sem cartão. Premium: 7 dias de teste grátis e depois planos de 1 a 12 meses. Modo Coach para personal trainers: 10 dias de teste grátis. Sem renovação automática.',
};

const norm = (x) => String(x).replace(/\s+/g, ' ').trim();
const decode = (x) => String(x).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const attr = (x) => String(x).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const text = (html) => norm(decode(String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')));
const crlf = (x) => x.replace(/\r\n/g, '\n');

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

// Scripts, estilos y comentarios quedan aparte mientras se toca el HTML (no se traducen ni se les cambian links)
function mask(html) {
    const parts = [];
    const out = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi, (m) => '\u0000' + (parts.push(m) - 1) + '\u0000');
    return { out, restore: (x) => x.replace(/\u0000(\d+)\u0000/g, (_, i) => parts[+i]) };
}

// Reemplaza el contenido de cada elemento con data-i18n por su traducción
function translateElements(html, idx, dict, missing) {
    const open = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\sdata-i18n(?![-\w])[^>]*>/g;
    let out = '', last = 0, m;
    while ((m = open.exec(html))) {
        const tag = m[1].toLowerCase(), start = m.index + m[0].length;
        const any = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi');
        any.lastIndex = start;
        let depth = 1, end = -1, close = '', t;
        while ((t = any.exec(html))) {
            depth += t[1] ? -1 : 1;
            if (!depth) { end = t.index; close = t[0]; break; }
        }
        if (end < 0) fail('sin cierre: ' + m[0]);
        const inner = html.slice(start, end), e = dict[norm(inner)];
        if (!e) missing.push(norm(inner).slice(0, 80));
        out += html.slice(last, start) + (e ? e[idx] : inner) + close;
        last = open.lastIndex = end + close.length;
    }
    return out + html.slice(last);
}

function translateAttr(html, marker, name, tr) {
    return html.replace(new RegExp('<[a-zA-Z][^>]*\\s' + marker + '(?![-\\w])[^>]*>', 'g'), (tag) =>
        tag.replace(new RegExp('(\\s' + name + '=")([^"]*)(")'), (_, a, v, b) => a + attr(tr(decode(v))) + b));
}

// Links relativos (manifest.json, BERSERKERMOD.html, img/…) → ../ desde /en/ y /pt/
function prefixLinks(html) {
    return html.replace(/(\s(?:href|src)=")([^"]*)(")/g, (all, a, v, b) =>
        /^(#|\/|\?|\.\.\/|[a-z][a-z0-9+.-]*:)/i.test(v) || v === '' ? all : a + '../' + v + b);
}

function setMeta(html, re, value, label) {
    if (!re.test(html)) fail('no encuentro ' + label);
    return html.replace(re, (_, a, b) => a + attr(value) + b);
}

function buildLd(page, lang) {
    const L = LANGS[lang], url = SITE + L.dir;
    const desc = decode((page.match(/<meta name="description" content="([^"]*)">/) || [])[1] || '');
    const feats = [...page.matchAll(/<h3 class="feat-title"[^>]*>([\s\S]*?)<\/h3>/g)].map((m) => text(m[1]));
    const faq = [...page.matchAll(/<summary class="faq-summary"[^>]*>([\s\S]*?)<\/summary>\s*<div class="faq-body"[^>]*>([\s\S]*?)<\/div>\s*<\/details>/g)]
        .map((m) => ({ '@type': 'Question', name: text(m[1]), acceptedAnswer: { '@type': 'Answer', text: text(m[2]) } }));
    const shots = [...new Set([...page.matchAll(/data-shot="([^"]+)"/g)].map((m) => m[1]))];
    if (!desc || feats.length < 5 || faq.length < 5 || shots.length < 5) fail(`${lang}: faltan datos para el JSON-LD (${feats.length} funciones, ${faq.length} preguntas, ${shots.length} capturas)`);
    const graph = [
        {
            '@type': 'Organization', '@id': SITE + '#org', name: 'BERSERKERMOD', url: SITE,
            logo: SITE + 'icon-512.png', address: { '@type': 'PostalAddress', addressCountry: 'AR' },
        },
        {
            '@type': 'WebSite', '@id': SITE + '#website', name: 'BERSERKERMOD', url: SITE,
            inLanguage: ['es', 'en', 'pt-BR'], publisher: { '@id': SITE + '#org' },
        },
        {
            '@type': 'SoftwareApplication', '@id': SITE + '#app', name: 'BERSERKERMOD', url,
            applicationCategory: 'HealthApplication', applicationSubCategory: 'Fitness',
            operatingSystem: 'Android, iOS, Windows, macOS (PWA, web)',
            installUrl: SITE + 'BERSERKERMOD.html', inLanguage: L.ld, description: desc,
            image: SITE + 'icon-512.png', screenshot: shots.map((f) => SITE + 'img/landing/' + L.dir + f),
            featureList: feats, isAccessibleForFree: true,
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'ARS', description: OFFER_TEXT[lang] },
            publisher: { '@id': SITE + '#org' },
        },
        { '@type': 'WebPage', '@id': url + '#page', url, name: decode((page.match(/<title>([^<]*)<\/title>/) || [])[1] || ''), inLanguage: L.ld, isPartOf: { '@id': SITE + '#website' }, about: { '@id': SITE + '#app' } },
        { '@type': 'FAQPage', '@id': url + '#faq', inLanguage: L.ld, mainEntity: faq },
    ];
    return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 1).replace(/<\//g, '<\\/');
}

const LD_RE = /(<script type="application\/ld\+json" id="ld-main">)[\s\S]*?(<\/script>)/;
const withLd = (page, lang) => {
    if (!LD_RE.test(page)) fail('no encuentro <script id="ld-main"> en index.html');
    return page.replace(LD_RE, (_, a, b) => a + buildLd(page, lang) + b);
};

function build(src, lang, dict) {
    const L = LANGS[lang];
    const tr = (es) => { const e = dict[norm(es)]; return (e && e[L.idx]) || es; };
    const missing = [];
    const { out, restore } = mask(src);
    let h = translateElements(out, L.idx, dict, missing);
    if (missing.length) fail(`${lang}: textos marcados sin traducción: ${JSON.stringify(missing.slice(0, 5))}`);
    h = translateAttr(h, 'data-i18n-alt', 'alt', tr);
    h = translateAttr(h, 'data-i18n-aria', 'aria-label', tr);
    h = h.replace(/(<img data-shot="[^"]+" src="img\/landing\/)/g, '$1' + L.dir);
    h = prefixLinks(h);
    h = restore(h);

    const title = tr(decode((src.match(/<title>([^<]*)<\/title>/) || [])[1] || ''));
    const desc = tr(decode((src.match(/<meta name="description" content="([^"]*)">/) || [])[1] || ''));
    if (dict[norm(title)] || dict[norm(desc)]) fail(`${lang}: el título o la descripción no tienen traducción`);
    h = h.replace(/<html lang="[^"]*">/, `<html lang="${L.html}">`);
    h = h.replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`);
    h = setMeta(h, /(<meta name="description" content=")[^"]*(">)/, desc, 'description');
    for (const p of ['og:title', 'twitter:title', 'og:image:alt']) h = setMeta(h, new RegExp(`(<meta (?:property|name)="${p}" content=")[^"]*(">)`), title, p);
    for (const p of ['og:description', 'twitter:description']) h = setMeta(h, new RegExp(`(<meta (?:property|name)="${p}" content=")[^"]*(">)`), desc, p);
    h = setMeta(h, /(<meta property="og:url" content=")[^"]*(">)/, SITE + L.dir, 'og:url');
    h = setMeta(h, /(<link rel="canonical" href=")[^"]*(">)/, SITE + L.dir, 'canonical');
    const locales = Object.values(LANGS).map((x) => x.og);
    h = h.replace(/<meta property="og:locale" content="[^"]*">\s*<meta property="og:locale:alternate" content="[^"]*">\s*<meta property="og:locale:alternate" content="[^"]*">/,
        [L.og, ...locales.filter((x) => x !== L.og)].map((x, i) => `<meta property="og:locale${i ? ':alternate' : ''}" content="${x}">`).join('\n    '));
    // CSS de las fuentes
    h = h.replace(/url\((fonts\/)/g, 'url(../$1');
    // Idioma fijo y base de los links que arma el JavaScript (capturas, service worker, link a la app)
    h = h.replace(/(<meta name="viewport"[^>]*>\n)/, `$1    <!-- Generado por tools/landing-langs.mjs a partir de index.html: no editar a mano -->\n    <script>window.__bmForceLang = '${lang}'; window.__bmBase = '../';</script>\n`);
    if (!h.includes(`window.__bmForceLang = '${lang}'`)) fail(lang + ': no pude fijar el idioma');
    return withLd(h, lang);
}

export function generate() {
    const file = path.join(ROOT, 'index.html');
    const src = crlf(readFileSync(file, 'utf8'));
    const m = src.match(/<script type="application\/json" id="landing-i18n">([\s\S]*?)<\/script>/);
    if (!m) fail('no encuentro el diccionario landing-i18n');
    const dict = JSON.parse(m[1]);
    // Un texto ya traducido no puede ser a la vez una clave con otra traducción (la página traduciría dos veces)
    for (const [es, v] of Object.entries(dict)) v.forEach((t, i) => {
        const again = dict[norm(t)];
        if (again && again[i] !== t) fail(`"${t}" (traducción de "${es.slice(0, 40)}") también es una clave en español`);
    });
    return {
        'index.html': withLd(src, 'es'),
        'en/index.html': build(src, 'en', dict),
        'pt/index.html': build(src, 'pt', dict),
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const check = process.argv.includes('--check');
    const files = generate();
    const stale = [];
    for (const [rel, body] of Object.entries(files)) {
        const abs = path.join(ROOT, rel);
        const now = existsSync(abs) ? crlf(readFileSync(abs, 'utf8')) : null;
        if (now === body) continue;
        stale.push(rel);
        if (!check) { mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, body); }
    }
    if (check && stale.length) fail('desactualizado: ' + stale.join(', ') + ' → correr: node tools/landing-langs.mjs');
    console.log(check ? '✓ /en/, /pt/ y el JSON-LD están al día' : stale.length ? '✓ escrito: ' + stale.join(', ') : '✓ ya estaba todo al día');
}
