// Páginas de la landing para buscadores y asistentes de IA: /en/ y /pt/ ya traducidas,
// JSON-LD, robots.txt, sitemap.xml y llms.txt. Las copias las arma tools/landing-langs.mjs.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generate } from '../tools/landing-langs.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const SITE = 'https://berserkermod.github.io/';
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 400) : '')); } };
const strip = (h) => h.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi, ' ');

console.log('\n=== landing para buscadores (/en/, /pt/, JSON-LD, robots, sitemap, llms.txt) ===\n');

const want = generate();
for (const [rel, body] of Object.entries(want)) {
    ok(`${rel} al día (si falla: node tools/landing-langs.mjs)`, existsSync(path.join(root, rel)) && read(rel) === body);
}

const dict = JSON.parse(read('index.html').match(/id="landing-i18n">([\s\S]*?)<\/script>/)[1]);
const PAGES = { 'index.html': { url: SITE, lang: 'es-AR', idx: -1 }, 'en/index.html': { url: SITE + 'en/', lang: 'en', idx: 0 }, 'pt/index.html': { url: SITE + 'pt/', lang: 'pt-BR', idx: 1 } };
const hreflangs = {};
for (const [rel, P] of Object.entries(PAGES)) {
    const h = want[rel], body = strip(h), dir = path.dirname(path.join(root, rel));
    ok(`${rel}: <html lang="${P.lang}">`, h.includes(`<html lang="${P.lang}">`));
    ok(`${rel}: canonical a su propia dirección`, h.includes(`<link rel="canonical" href="${P.url}">`));
    ok(`${rel}: og:url a su propia dirección`, h.includes(`<meta property="og:url" content="${P.url}">`));
    hreflangs[rel] = [...h.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((m) => m[1] + '=' + m[2]).join(' ');
    ok(`${rel}: se indexa (sin noindex)`, !/name="robots" content="[^"]*noindex/.test(h));

    // Todos los links y archivos relativos existen desde esa carpeta
    const broken = [...body.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1])
        .filter((v) => v && !/^(#|[a-z][a-z0-9+.-]*:)/i.test(v))
        .filter((v) => { const f = v.split(/[?#]/)[0]; return f && !existsSync(path.join(dir, f)); });
    ok(`${rel}: links y capturas relativos existen`, broken.length === 0, broken);

    // JSON-LD
    let g = null;
    try { g = JSON.parse(h.match(/<script type="application\/ld\+json" id="ld-main">([\s\S]*?)<\/script>/)[1])['@graph']; } catch (e) { g = null; }
    ok(`${rel}: JSON-LD válido`, Array.isArray(g));
    if (!g) continue;
    const types = g.map((x) => x['@type']);
    ok(`${rel}: JSON-LD con app, organización, sitio, página y FAQ`, ['SoftwareApplication', 'Organization', 'WebSite', 'WebPage', 'FAQPage'].every((t) => types.includes(t)), types);
    const app = g.find((x) => x['@type'] === 'SoftwareApplication'), faq = g.find((x) => x['@type'] === 'FAQPage');
    const nFaq = (body.match(/<details class="faq-item/g) || []).length;
    ok(`${rel}: el FAQ del JSON-LD tiene todas las preguntas (${nFaq})`, faq.mainEntity.length === nFaq && faq.mainEntity.every((q) => q.name && q.acceptedAnswer.text.length > 40));
    ok(`${rel}: la app tiene descripción, oferta gratis y capturas del idioma`, app.description && app.offers.price === '0' && app.screenshot.every((u) => u.includes('/img/landing/' + (P.idx >= 0 ? rel.slice(0, 3) : '')) && existsSync(path.join(root, u.slice(SITE.length)))));
    if (P.idx < 0) continue;

    // Nada en español en lo que se ve (textos largos que tienen otra traducción)
    const plain = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const left = Object.entries(dict).filter(([es, v]) => es.length > 30 && !/[<&]/.test(es) && v[P.idx] !== es && plain.includes(es)).map(([es]) => es);
    ok(`${rel}: no quedan textos en español a la vista`, left.length === 0, left);
    ok(`${rel}: título y descripción traducidos`, !dict[h.match(/<title>([^<]*)<\/title>/)[1]] && !dict[h.match(/<meta name="description" content="([^"]*)">/)[1]]);
    // El idioma fijo va antes del script que elige el idioma
    ok(`${rel}: idioma fijo antes de elegir idioma`, h.indexOf(`window.__bmForceLang = '${rel.slice(0, 2)}'`) > 0 && h.indexOf('window.__bmForceLang') < h.indexOf('var forced = window.__bmForceLang'));
}
ok('las 3 páginas declaran los mismos idiomas alternativos', new Set(Object.values(hreflangs)).size === 1, hreflangs);
ok('alternativos: es, en, pt-BR y x-default', hreflangs['index.html'] === `es=${SITE} en=${SITE}en/ pt-BR=${SITE}pt/ x-default=${SITE}`, hreflangs['index.html']);

// robots.txt: todo abierto salvo lo privado, con el sitemap
const robots = read('robots.txt');
ok('robots.txt: no bloquea el sitio', !/^Disallow:\s*\/\s*$/m.test(robots) && /^Allow: \/$/m.test(robots));
for (const bot of ['Googlebot', 'Bingbot', 'OAI-SearchBot', 'GPTBot', 'ChatGPT-User', 'PerplexityBot', 'ClaudeBot', 'Claude-SearchBot', 'Google-Extended']) ok(`robots.txt: ${bot} habilitado`, new RegExp('^User-agent: ' + bot + '$', 'm').test(robots));
ok('robots.txt: links de alumno y de pago cerrados', ['/*?r=', '/*&r=', '/*?xfer=', '/*?purchase='].every((x) => robots.includes('Disallow: ' + x)));
ok('robots.txt: apunta al sitemap', robots.includes(`Sitemap: ${SITE}sitemap.xml`));

// sitemap.xml: cada dirección existe y se puede indexar
const sm = read('sitemap.xml');
const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
ok('sitemap: /, /en/, /pt/ y testers', [SITE, SITE + 'en/', SITE + 'pt/', SITE + 'testers.html'].every((u) => locs.includes(u)), locs);
const smBad = locs.filter((u) => {
    if (!u.startsWith(SITE)) return true;
    const rel = u.slice(SITE.length) || 'index.html', f = rel.endsWith('/') ? rel + 'index.html' : rel;
    return !existsSync(path.join(root, f)) || /name="robots" content="[^"]*noindex/.test(read(f));
});
ok('sitemap: solo páginas que existen y se indexan', smBad.length === 0, smBad);

// llms.txt: formato y links propios que existen; sin mails ni claves
const llms = read('llms.txt');
ok('llms.txt: título y resumen', /^# BERSERKERMOD\n\n> .{80,}/.test(llms));
const llmsBad = [...llms.matchAll(/\]\((https:\/\/berserkermod\.github\.io\/[^)]*)\)/g)].map((m) => m[1])
    .filter((u) => { const rel = u.slice(SITE.length) || 'index.html'; return !existsSync(path.join(root, rel.endsWith('/') ? rel + 'index.html' : rel)); });
ok('llms.txt: los links existen', llmsBad.length === 0, llmsBad);
ok('llms.txt, robots.txt y sitemap: sin mails ni claves', ![llms, robots, sm].some((x) => /[\w.+-]+@[\w-]+\.[a-z]|api[_-]?key\s*[:=]|bearer\s|sk-[a-z0-9]{8}|AKIA[0-9A-Z]{8}|eyJ[a-zA-Z0-9_-]{10}|-----BEGIN/i.test(x)));

// La app no se indexa
ok('BERSERKERMOD.html: noindex', /<meta name="robots" content="noindex/.test(read('BERSERKERMOD.html')));

console.log(`\n${pass} ok, ${fail} con error\n`);
if (fail) process.exit(1);
