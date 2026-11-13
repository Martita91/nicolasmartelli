// Web Audit: scores the pages returned by /api/audit. All scoring runs in the browser.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const CATS = { seo: { name: 'SEO', w: 35 }, aeo: { name: 'AI visibility', w: 30 }, a11y: { name: 'Accessibility', w: 20 }, bp: { name: 'Best practices', w: 15 } };
  const AI_BOTS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'Amazonbot', 'CCBot', 'Bytespider', 'meta-externalagent', 'DuckAssistBot'];

  /* ---------- parsing ---------- */
  function parseRobots(txt) {
    const groups = [], sitemaps = []; let cur = null, lastUA = false;
    for (const raw of txt.split(/\r?\n/)) {
      const m = raw.replace(/#.*/, '').trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
      if (!m) continue;
      const k = m[1].toLowerCase(), v = m[2].trim();
      if (k === 'user-agent') { if (!lastUA) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastUA = true; }
      else { lastUA = false; if (k === 'sitemap') sitemaps.push(v); else if (cur && (k === 'allow' || k === 'disallow')) cur.rules.push({ k, v }); }
    }
    return { groups, sitemaps };
  }
  function botStatus(r, bot) {
    const b = bot.toLowerCase();
    let g = r.groups.find((x) => x.agents.includes(b)); const named = !!g;
    if (!g) g = r.groups.find((x) => x.agents.includes('*'));
    if (!g) return { allowed: true, named: false };
    const blocked = g.rules.some((x) => x.k === 'disallow' && x.v === '/') && !g.rules.some((x) => x.k === 'allow' && x.v === '/');
    return { allowed: !blocked, named };
  }
  function ctxOf(p) {
    const doc = new DOMParser().parseFromString(p.html, 'text/html');
    const ld = []; let ldBad = 0;
    const walk = (n) => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { if (n['@type']) ld.push(n); Object.values(n).forEach(walk); } };
    doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => { try { walk(JSON.parse(s.textContent)); } catch (e) { ldBad++; } });
    const body = doc.body ? doc.body.cloneNode(true) : null;
    if (body) body.querySelectorAll('script,style,noscript,template,svg').forEach((n) => n.remove());
    const text = body ? body.textContent.replace(/\s+/g, ' ').trim() : '';
    const types = ld.flatMap((n) => [].concat(n['@type']));
    return { p, doc, html: p.html, ld, ldBad, types, text, words: text ? text.split(' ').length : 0 };
  }
  const meta = (c, n) => (c.doc.querySelector(`meta[name="${n}" i]`)?.getAttribute('content') || '').trim();
  const prop = (c, n) => (c.doc.querySelector(`meta[property="${n}" i]`)?.getAttribute('content') || '').trim();
  const nameOf = (el) => (el.textContent.trim() || el.getAttribute('aria-label') || el.getAttribute('title') || el.querySelector('img[alt]')?.getAttribute('alt') || '').trim();
  const hasAny = (c, list) => c.types.some((t) => list.includes(t));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /* ---------- checks: run(ctx) -> [score 0..1 | null, detail] ---------- */
  const PAGE = [
    { id: 'title', cat: 'seo', w: 3, name: 'Page title', fix: 'Write a unique <title> of 15 to 60 characters, with the main keyword near the start.',
      run: (c) => { const t = (c.doc.title || '').trim(); if (!t) return [0, 'No <title>']; return [t.length >= 15 && t.length <= 60 ? 1 : .5, `${t.length} characters`]; } },
    { id: 'desc', cat: 'seo', w: 3, name: 'Meta description', fix: 'Add a meta description of 70 to 160 characters that sums up the page.',
      run: (c) => { const d = meta(c, 'description'); if (!d) return [0, 'No description']; return [d.length >= 70 && d.length <= 160 ? 1 : .5, `${d.length} characters`]; } },
    { id: 'h1', cat: 'seo', w: 3, name: 'One H1', fix: 'Keep exactly one <h1> that says what the page is about.',
      run: (c) => { const n = c.doc.querySelectorAll('h1').length; return [n === 1 ? 1 : 0, `${n} H1`]; } },
    { id: 'horder', cat: 'seo', w: 1, name: 'Heading order', fix: "Don't skip levels: an H2 is followed by an H3, not an H4.",
      run: (c) => { let prev = 0, jumps = 0; c.doc.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => { const l = +h.tagName[1]; if (prev && l > prev + 1) jumps++; prev = l; }); return [jumps ? .5 : 1, jumps ? plural(jumps, 'skipped level', 'skipped levels') : 'In order']; } },
    { id: 'canonical', cat: 'seo', w: 2, name: 'Canonical URL', fix: 'Add <link rel="canonical"> with the definitive address of the page.',
      run: (c) => { const h = c.doc.querySelector('link[rel="canonical" i]')?.getAttribute('href'); return [h ? 1 : 0, h || 'No canonical']; } },
    { id: 'index', cat: 'seo', w: 3, name: 'Indexable', fix: 'Remove "noindex" from the robots meta tag if this page should appear in search.',
      run: (c) => { const r = meta(c, 'robots').toLowerCase(); return [r.includes('noindex') ? 0 : 1, r.includes('noindex') ? 'Has noindex' : 'Not blocked']; } },
    { id: 'viewport', cat: 'seo', w: 2, name: 'Mobile ready', fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
      run: (c) => { const v = meta(c, 'viewport'); return [v.includes('width=device-width') ? 1 : 0, v || 'No viewport meta']; } },
    { id: 'og', cat: 'seo', w: 2, name: 'Share preview', fix: 'Fill in og:title, og:description and og:image, plus twitter:card.',
      run: (c) => { const miss = ['og:title', 'og:description', 'og:image'].filter((k) => !prop(c, k)); if (!meta(c, 'twitter:card') && !prop(c, 'twitter:card')) miss.push('twitter:card'); return [miss.length === 0 ? 1 : miss.length >= 3 ? 0 : .5, miss.length ? 'Missing ' + miss.join(', ') : 'Complete']; } },
    { id: 'linktext', cat: 'seo', w: 1, name: 'Link text', fix: 'Replace "click here" and "read more" with text that describes the destination.',
      run: (c) => { const bad = [...c.doc.querySelectorAll('a[href]')].filter((a) => /^(click here|here|read more|more|learn more|link)$/i.test(a.textContent.trim())).length; return [bad ? .5 : 1, bad ? plural(bad, 'generic link', 'generic links') : 'Descriptive']; } },

    { id: 'jsonld', cat: 'aeo', w: 3, name: 'Structured data (JSON-LD)', fix: 'Add a schema.org JSON-LD block that describes the page (Person, Organization, Article, FAQPage, Product…).',
      run: (c) => { if (c.ldBad) return [.5, plural(c.ldBad, 'block has', 'blocks have') + ' invalid JSON']; return [c.ld.length ? 1 : 0, c.ld.length ? [...new Set(c.types)].slice(0, 8).join(', ') : 'No JSON-LD']; } },
    { id: 'nojs', cat: 'aeo', w: 3, name: 'Readable without JavaScript', fix: 'AI crawlers rarely run JavaScript: the main text has to be in the HTML the server sends.',
      run: (c) => [c.words >= 150 ? 1 : c.words >= 50 ? .5 : 0, `${c.words} words in the HTML`] },
    { id: 'landmarks', cat: 'aeo', w: 2, name: 'Semantic structure', fix: 'Use <header>, <nav>, <main> and <footer> so models can tell content from navigation.',
      run: (c) => { const miss = ['header', 'nav', 'main', 'footer'].filter((t) => !c.doc.querySelector(t)); return [miss.length === 0 ? 1 : miss.length <= 2 ? .5 : 0, miss.length ? 'Missing ' + miss.map((m) => `<${m}>`).join(', ') : 'Complete']; } },
    { id: 'lead', cat: 'aeo', w: 2, name: 'Direct answer up front', fix: 'Right after the H1, add a paragraph of one to three sentences that says what the page is about.',
      run: (c) => { const h = c.doc.querySelector('h1'); if (!h) return [0, 'No H1']; const scope = c.doc.querySelector('main') || c.doc.body; const p = [...scope.querySelectorAll('p')].filter((x) => h.compareDocumentPosition(x) & 4).find((x) => x.textContent.trim().length >= 40); if (!p) return [0, 'No opening paragraph']; const n = p.textContent.trim().length; return [n >= 60 && n <= 320 ? 1 : .5, `${n} characters`]; } },
    { id: 'lists', cat: 'aeo', w: 1, name: 'Lists or tables', fix: 'Turn steps, comparisons and features into lists or tables: they are easy to quote.',
      run: (c) => { const scope = c.doc.querySelector('main') || c.doc.body; const n = scope ? scope.querySelectorAll('ul,ol,table,dl').length : 0; return [n ? 1 : .5, n ? plural(n, 'list or table', 'lists or tables') : 'Paragraphs only']; } },

    { id: 'lang', cat: 'a11y', w: 2, name: 'Language declared', fix: 'Add the lang attribute to <html>, for example lang="en".',
      run: (c) => { const l = c.doc.documentElement.getAttribute('lang'); return [l ? 1 : 0, l ? `lang="${l}"` : 'No lang']; } },
    { id: 'alt', cat: 'a11y', w: 3, name: 'Image alt text', fix: 'Give every <img> an alt. If it is decorative, use alt="".',
      run: (c) => { const imgs = [...c.doc.querySelectorAll('img')]; if (!imgs.length) return [null, 'No images']; const bad = imgs.filter((i) => !i.hasAttribute('alt')).length; return [bad ? Math.max(0, 1 - bad / imgs.length) * .5 : 1, bad ? `${bad} of ${imgs.length} without alt` : `${imgs.length} with alt`]; } },
    { id: 'names', cat: 'a11y', w: 2, name: 'Buttons and links have names', fix: 'Buttons or links that only show an icon need an aria-label.',
      run: (c) => { const els = [...c.doc.querySelectorAll('a[href],button')]; const bad = els.filter((e) => !nameOf(e)).length; return [bad ? 0 : 1, bad ? `${bad} without an accessible name` : `${els.length} checked`]; } },
    { id: 'labels', cat: 'a11y', w: 2, name: 'Form fields have labels', fix: 'Connect each field to a <label for> or give it an aria-label.',
      run: (c) => { const f = [...c.doc.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]),select,textarea')]; if (!f.length) return [null, 'No form fields']; const bad = f.filter((e) => !(e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.getAttribute('title') || e.closest('label') || (e.id && c.doc.querySelector(`label[for="${CSS.escape(e.id)}"]`)))).length; return [bad ? 0 : 1, bad ? `${bad} of ${f.length} without a label` : `${f.length} labelled`]; } },
    { id: 'main', cat: 'a11y', w: 1, name: 'Main region', fix: 'Wrap the page content in <main>.',
      run: (c) => { const ok = !!c.doc.querySelector('main,[role=main]'); return [ok ? 1 : 0, ok ? 'Has <main>' : 'No <main>']; } },
    { id: 'skip', cat: 'a11y', w: 1, name: 'Skip link', fix: 'Add a "Skip to content" link as the first link on the page.',
      run: (c) => { const ok = [...c.doc.querySelectorAll('a[href^="#"]')].slice(0, 3).some((a) => /skip|jump|content|saltar|contenido/i.test(a.textContent)); return [ok ? 1 : .5, ok ? 'Present' : 'Not found']; } },
    { id: 'zoom', cat: 'a11y', w: 2, name: 'Zoom allowed', fix: 'Remove user-scalable=no and maximum-scale=1 from the viewport meta tag.',
      run: (c) => { const v = meta(c, 'viewport').replace(/\s/g, ''); const bad = /user-scalable=(no|0)|maximum-scale=1(\.0)?(,|$)/.test(v); return [bad ? 0 : 1, bad ? 'The viewport blocks zoom' : 'Not blocked']; } },
    { id: 'tabindex', cat: 'a11y', w: 1, name: 'Natural tab order', fix: "Don't use tabindex values above 0.",
      run: (c) => { const n = [...c.doc.querySelectorAll('[tabindex]')].filter((e) => +e.getAttribute('tabindex') > 0).length; return [n ? 0 : 1, n ? `${n} with a positive tabindex` : 'Correct']; } },

    { id: 'doctype', cat: 'bp', w: 2, name: 'Doctype and encoding', fix: 'Start with <!doctype html> and declare <meta charset="utf-8">.',
      run: (c) => { const d = /^\s*<!doctype html/i.test(c.html), ch = !!c.doc.querySelector('meta[charset]'); return [d && ch ? 1 : d || ch ? .5 : 0, `${d ? 'Has' : 'No'} doctype, ${ch ? 'has' : 'no'} charset`]; } },
    { id: 'favicon', cat: 'bp', w: 1, name: 'Favicon', fix: 'Add <link rel="icon">.',
      run: (c) => { const ok = !!c.doc.querySelector('link[rel~="icon" i]'); return [ok ? 1 : .5, ok ? 'Declared' : 'Not declared']; } },
    { id: 'mixed', cat: 'bp', w: 3, name: 'Resources over HTTPS', fix: 'Change http:// resources to https://.',
      run: (c) => { const n = [...c.doc.querySelectorAll('script[src],link[href],img[src],iframe[src],source[src]')].filter((e) => /^http:\/\//i.test(e.getAttribute('src') || e.getAttribute('href'))).length; return [n ? 0 : 1, n ? plural(n, 'insecure resource', 'insecure resources') : 'No http:// resources']; } },
    { id: 'imgsize', cat: 'bp', w: 2, name: 'Images declare their size', fix: 'Set width and height on every <img> so the page does not jump while loading.',
      run: (c) => { const imgs = [...c.doc.querySelectorAll('img')]; if (!imgs.length) return [null, 'No images']; const bad = imgs.filter((i) => !(i.hasAttribute('width') && i.hasAttribute('height'))).length; return [bad ? .5 : 1, bad ? `${bad} of ${imgs.length} without dimensions` : 'All have dimensions']; } },
    { id: 'blocking', cat: 'bp', w: 2, name: 'Scripts do not block loading', fix: 'Add defer or async to the <script src> tags in the <head>.',
      run: (c) => { const n = c.doc.querySelectorAll('head script[src]:not([defer]):not([async]):not([type=module])').length; return [n ? .5 : 1, n ? plural(n, 'blocking script', 'blocking scripts') : 'None']; } },
    { id: 'inlinejs', cat: 'bp', w: 1, name: 'No inline event handlers', fix: 'Move onclick="" and similar attributes into a JavaScript file.',
      run: (c) => { const n = c.doc.querySelectorAll('[onclick],[onload],[onerror],[onmouseover],[onchange],[onsubmit]').length; return [n ? .5 : 1, n ? plural(n, 'on* attribute', 'on* attributes') : 'None']; } },
    { id: 'blank', cat: 'bp', w: 1, name: 'Safe new-tab links', fix: 'Add rel="noopener" to links with target="_blank".',
      run: (c) => { const n = [...c.doc.querySelectorAll('a[target="_blank"]')].filter((a) => !/noopener|noreferrer/.test(a.getAttribute('rel') || '')).length; return [n ? .5 : 1, n ? `${n} without rel="noopener"` : 'Correct']; } },
    { id: 'weight', cat: 'bp', w: 1, name: 'HTML size', fix: 'Trim the HTML: remove repeated inline code and hidden content.',
      run: (c) => { const kb = Math.round(new Blob([c.html]).size / 1024); return [kb <= 150 ? 1 : kb <= 400 ? .5 : 0, `${kb} KB`]; } },
    { id: 'deprecated', cat: 'bp', w: 1, name: 'No obsolete tags', fix: 'Replace <font>, <center> and <marquee> with CSS.',
      run: (c) => { const n = c.doc.querySelectorAll('font,center,marquee,blink').length; return [n ? 0 : 1, n ? plural(n, 'obsolete tag', 'obsolete tags') : 'None']; } },
  ];

  const SITE = [
    { id: 'robots', cat: 'seo', w: 3, name: 'robots.txt', fix: 'Publish a robots.txt that allows crawling and declares the Sitemap.',
      run: (cx, s) => { if (!s.robots.trim()) return [0, 'No robots.txt found']; const r = parseRobots(s.robots); if (!botStatus(r, 'googlebot').allowed) return [0, 'Blocks search engines']; return [r.sitemaps.length ? 1 : .5, r.sitemaps.length ? 'Allows crawling and declares the sitemap' : 'Allows crawling, no Sitemap line']; } },
    { id: 'unique', cat: 'seo', w: 2, name: 'Unique titles and descriptions', fix: 'Each page needs its own title and its own description.',
      run: (cx) => { if (cx.length < 2) return [null, 'Needs more than one page']; const dup = (arr) => arr.filter(Boolean).length - new Set(arr.filter(Boolean)).size; const d = dup(cx.map((c) => c.doc.title.trim())) + dup(cx.map((c) => meta(c, 'description'))); return [d ? 0 : 1, d ? `${d} repeated` : 'All different']; } },
    { id: 'aibots', cat: 'aeo', w: 4, name: 'AI crawlers allowed', fix: 'Name GPTBot, ClaudeBot, PerplexityBot and the rest in robots.txt with "Allow: /".',
      run: (cx, s) => { if (!s.robots.trim()) return [0, 'No robots.txt found']; const r = parseRobots(s.robots); const st = AI_BOTS.map((b) => [b, botStatus(r, b)]); const allowed = st.filter((x) => x[1].allowed).length, named = st.filter((x) => x[1].allowed && x[1].named).length; const blocked = st.filter((x) => !x[1].allowed).map((x) => x[0]); const share = allowed / AI_BOTS.length; return [share === 1 ? (named >= 8 ? 1 : .5) : share * .5, `${allowed}/${AI_BOTS.length} allowed, ${named} named explicitly` + (blocked.length ? `. Blocked: ${blocked.join(', ')}` : '')]; } },
    { id: 'llms', cat: 'aeo', w: 3, name: 'llms.txt', fix: 'Publish /llms.txt: a Markdown summary of the site with links to the key pages.',
      run: (cx, s) => { const t = s.llms.trim(); if (!t) return [0, 'No llms.txt found']; const h1 = /^#\s+\S/m.test(t), links = (t.match(/\]\(https?:\/\//g) || []).length; return [h1 && links >= 3 ? 1 : .5, `${h1 ? 'Has a' : 'No'} title, ${plural(links, 'link', 'links')}`]; } },
    { id: 'identity', cat: 'aeo', w: 2, name: 'Entity identified', fix: 'Say who is behind the site with a Person or Organization schema.',
      run: (cx) => { const ok = cx.some((c) => hasAny(c, ['Person', 'Organization', 'LocalBusiness', 'ProfilePage', 'Corporation', 'OnlineBusiness', 'OnlineStore'])); return [ok ? 1 : 0, ok ? 'Person or Organization present' : 'No identity schema']; } },
    { id: 'sameas', cat: 'aeo', w: 1, name: 'Linked profiles (sameAs)', fix: 'Add sameAs with your profiles (LinkedIn, GitHub, Instagram) to the identity schema.',
      run: (cx) => { const ok = cx.some((c) => c.ld.some((n) => n.sameAs) || c.doc.querySelector('a[rel~="me"]')); return [ok ? 1 : .5, ok ? 'Present' : 'Not found']; } },
    { id: 'contentschema', cat: 'aeo', w: 2, name: 'Content schema', fix: 'Mark up articles, FAQs, products or services with their schema (Article, FAQPage, Product…).',
      run: (cx) => { const list = ['Article', 'BlogPosting', 'NewsArticle', 'FAQPage', 'HowTo', 'Product', 'Service', 'BreadcrumbList', 'ItemList', 'CreativeWork', 'SoftwareApplication', 'WebApplication', 'Recipe', 'Event']; const found = [...new Set(cx.flatMap((c) => c.types.filter((t) => list.includes(t))))]; return [found.length ? 1 : .5, found.length ? found.join(', ') : 'Identity schema only, or none']; } },
    { id: 'qa', cat: 'aeo', w: 2, name: 'Questions and answers', fix: 'Add an FAQ section with the headings written as questions.',
      run: (cx) => { const n = cx.reduce((a, c) => a + [...c.doc.querySelectorAll('h2,h3,h4,summary')].filter((h) => /\?\s*$/.test(h.textContent)).length, 0); return [n >= 3 ? 1 : n ? .5 : 0, plural(n, 'heading written as a question', 'headings written as questions')]; } },
    { id: 'fresh', cat: 'aeo', w: 1, name: 'Author and date', fix: 'State the author and publication date in an Article schema or with <time datetime>.',
      run: (cx) => { const ok = cx.some((c) => c.ld.some((n) => n.datePublished || n.dateModified) || c.doc.querySelector('time[datetime],meta[property="article:published_time"]')); return [ok ? 1 : .5, ok ? 'Date declared' : 'No dates']; } },
  ];

  /* ---------- scoring ---------- */
  function audit(site) {
    const cx = site.pages.filter((p) => p.html.trim()).map(ctxOf);
    const res = [];
    for (const k of PAGE) {
      const per = cx.map((c) => { let r; try { r = k.run(c); } catch (e) { r = [null, 'Could not be checked']; } return { page: c.p.url, s: r[0], d: r[1] }; });
      const ok = per.filter((x) => x.s !== null);
      const score = ok.length ? ok.reduce((a, x) => a + x.s, 0) / ok.length : null;
      res.push({ ...k, score, detail: ok.length === 1 ? ok[0].d : ok.length ? `${ok.filter((x) => x.s === 1).length} of ${ok.length} pages pass` : per[0]?.d || '', pages: ok.length > 1 ? ok.filter((x) => x.s < 1) : [] });
    }
    for (const k of SITE) { let r; try { r = k.run(cx, site); } catch (e) { r = [null, 'Could not be checked']; } res.push({ ...k, score: r[0], detail: r[1], pages: [] }); }
    res.forEach((r) => { r.status = r.score === null ? 'na' : r.score >= .999 ? 'pass' : r.score >= .5 ? 'warn' : 'fail'; });
    const cats = {};
    for (const id in CATS) { const rs = res.filter((r) => r.cat === id && r.score !== null); const W = rs.reduce((a, r) => a + r.w, 0); cats[id] = W ? Math.round(100 * rs.reduce((a, r) => a + r.w * r.score, 0) / W) : 0; }
    const total = Math.round(Object.keys(CATS).reduce((a, id) => a + cats[id] * CATS[id].w, 0) / 100);
    return { res, cats, total, n: cx.length };
  }

  /* ---------- render ---------- */
  const tone = (n) => (n >= 90 ? 'good' : n >= 50 ? 'warn' : 'bad');
  const STATUS = { pass: 'Pass', warn: 'Warning', fail: 'Fail', na: 'N/A' };
  const C = 2 * Math.PI * 42;
  const ring = (n) => `<svg viewBox="0 0 100 100" role="img" aria-label="${n} out of 100"><circle class="ring-track" cx="50" cy="50" r="42" fill="none" stroke-width="7"/><circle class="ring" data-n="${n}" cx="50" cy="50" r="42" fill="none" stroke="var(--${tone(n)})" stroke-width="7" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C}" transform="rotate(-90 50 50)"/><text class="num" x="50" y="56" text-anchor="middle">${n}</text><text class="of" x="50" y="69" text-anchor="middle">OUT OF 100</text></svg>`;
  function rowHtml(r) {
    const pages = r.pages.length ? `<ul>${r.pages.slice(0, 8).map((p) => `<li>${esc(p.page)}: ${esc(p.d)}</li>`).join('')}${r.pages.length > 8 ? `<li>and ${r.pages.length - 8} more</li>` : ''}</ul>` : '';
    return `<li class="row s-${r.status}"><span class="pill">${STATUS[r.status]}</span><div><h3>${esc(r.name)}</h3><p class="detail">${esc(r.detail)}</p>${r.status === 'pass' || r.status === 'na' ? '' : `<p class="fix">${esc(r.fix)}</p>`}${pages}</div><span class="rmeta">${esc(CATS[r.cat].name)}</span></li>`;
  }

  let site = null, out = null, tab = 'all';
  function renderRows() {
    $('#tabs').innerHTML = [['all', 'All'], ...Object.keys(CATS).map((id) => [id, CATS[id].name])].map(([id, n]) => `<button type="button" data-tab="${id}" aria-pressed="${tab === id}">${esc(n)}</button>`).join('');
    const only = $('#onlyissues').checked, order = { fail: 0, warn: 1, pass: 2, na: 3 };
    const list = out.res.filter((r) => (tab === 'all' || r.cat === tab) && (!only || r.status === 'fail' || r.status === 'warn')).sort((a, b) => order[a.status] - order[b.status] || b.w - a.w);
    $('#rows').innerHTML = list.length ? list.map(rowHtml).join('') : '<li class="empty">Nothing to show with this filter.</li>';
  }
  function render() {
    out = audit(site);
    const host = new URL(site.site).host;
    $('#r-site').textContent = host;
    $('#r-sub').textContent = `${plural(out.n, 'page', 'pages')} audited` + (site.found > site.limit ? `, the first ${site.limit} of ${site.found} found` : '');
    $('#psi').href = 'https://pagespeed.web.dev/analysis?url=' + encodeURIComponent(site.site);
    const count = (id) => { const rs = out.res.filter((r) => id === 'all' || r.cat === id); const n = (s) => rs.filter((r) => r.status === s).length; return `<div class="counts"><span class="c-good"><b>${n('pass')}</b> passed</span><span class="c-warn"><b>${n('warn')}</b> warnings</span><span class="c-bad"><b>${n('fail')}</b> failed</span></div>`; };
    $('#dials').innerHTML = `<div class="dial main"><span class="dlabel">Site health</span>${ring(out.total)}${count('all')}</div>` + Object.keys(CATS).map((id) => `<div class="dial"><span class="dlabel">${esc(CATS[id].name)}</span>${ring(out.cats[id])}${count(id)}</div>`).join('');
    const issues = out.res.filter((r) => r.status === 'fail' || r.status === 'warn').sort((a, b) => b.w * (1 - b.score) - a.w * (1 - a.score));
    $('#top').innerHTML = issues.length ? issues.slice(0, 5).map(rowHtml).join('') : '<li class="empty">Nothing to fix: every check passed.</li>';
    renderRows();
    $('#results').hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelectorAll('.ring').forEach((el) => { el.style.strokeDashoffset = C * (1 - el.dataset.n / 100); })));
  }
  function report() {
    const L = [`# Web audit of ${site.site}`, '', `Site health: ${out.total}/100`, ...Object.keys(CATS).map((id) => `- ${CATS[id].name}: ${out.cats[id]}/100`), '', '## To fix'];
    out.res.filter((r) => r.status === 'fail' || r.status === 'warn').forEach((r) => { L.push(`- [${STATUS[r.status]}] ${r.name}: ${r.detail}. ${r.fix}`); r.pages.forEach((p) => L.push(`  - ${p.page}: ${p.d}`)); });
    return L.join('\n');
  }

  /* ---------- run ---------- */
  const form = $('#audit-form'), input = $('#audit-url'), btn = $('#audit-run'), status = $('#audit-status');
  const say = (t, err) => { status.textContent = t; status.classList.toggle('error', !!err); };
  async function run(url) {
    btn.disabled = true; say('Fetching the site and its pages. This takes a few seconds…');
    try {
      const r = await fetch('/api/audit?url=' + encodeURIComponent(url));
      const data = await r.json().catch(() => null);
      if (!r.ok || !data || data.error) throw new Error((data && data.error) || 'The audit service is not available right now. Try again in a minute.');
      site = data; tab = 'all'; render(); say('');
      $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      say(e.message || 'Something went wrong. Try again.', true);
    } finally {
      btn.disabled = false;
    }
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) { say('Enter a website address first.', true); return; }
    history.replaceState(null, '', '?url=' + encodeURIComponent(v));
    run(v);
  });
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; renderRows(); } });
  $('#onlyissues').addEventListener('change', renderRows);
  $('#copy-report').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    try { await navigator.clipboard.writeText(report()); b.textContent = 'Copied ✓'; } catch (err) { b.textContent = 'Copy failed'; }
    setTimeout(() => (b.textContent = 'Copy report'), 1800);
  });
  const preset = new URLSearchParams(location.search).get('url');
  if (preset) { input.value = preset; run(preset); }
})();
