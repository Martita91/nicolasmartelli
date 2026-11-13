// Cloudflare Pages Function: GET /api/audit?url=example.com
// Fetches a public site's home page, the pages it links to, robots.txt, llms.txt and
// the sitemap, and returns them as JSON for the browser to score. Nothing is stored.

const MAX_PAGES = 12;
const MAX_BYTES = 600_000;
const TIMEOUT_MS = 8000;
const UA = 'Mozilla/5.0 (compatible; WebAuditBot/1.0; +https://nicolasmartelli.pages.dev/audit)';
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|zip|gz|xml|json|txt|css|js|mjs|mp4|mp3|mov|woff2?|ttf|csv|docx?|xlsx?|pptx?)$/i;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': status === 200 ? 'public, max-age=600' : 'no-store',
      'x-robots-tag': 'noindex',
    },
  });

// Only public http(s) hostnames: no IPs, ports, credentials or internal names.
export function parseTarget(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (s.length > 2000) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.port || u.username || u.password) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h.includes(':') || /^[\d.]+$/.test(h)) return null;
  if (/(^|\.)(localhost|local|internal|lan|home|corp|test|invalid)$/.test(h)) return null;
  return u;
}

async function get(url, wantHtml) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, accept: wantHtml ? 'text/html,application/xhtml+xml' : 'text/plain,*/*' },
      redirect: 'follow',
      signal: ctl.signal,
    });
    if (!r.ok || !parseTarget(r.url)) return null;
    if (Number(r.headers.get('content-length') || 0) > MAX_BYTES * 4) return null;
    const text = (await r.text()).slice(0, MAX_BYTES);
    return { url: r.url, type: r.headers.get('content-type') || '', text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const isHtml = (r) => r && /html/i.test(r.type);
// Many sites answer any path with their HTML shell; that is not a real robots.txt or llms.txt.
const plainText = (r) => (r && !/html/i.test(r.type) && !/^\s*</.test(r.text) ? r.text : '');
const keyOf = (u) => u.origin + (u.pathname.replace(/\/+$/, '') || '/') + u.search;

export async function crawl(target) {
  const home = await get(target.href, true);
  if (!isHtml(home)) return { error: "Couldn't load that address as a web page. Check the spelling, or the site may block automated visits.", status: 502 };
  const homeUrl = new URL(home.url);
  const origin = homeUrl.origin;

  const [robots, llms] = await Promise.all([get(origin + '/robots.txt'), get(origin + '/llms.txt')]);
  const robotsTxt = plainText(robots);

  let sitemapUrl = origin + '/sitemap.xml';
  const declared = robotsTxt.match(/^\s*sitemap:\s*(\S+)/im);
  if (declared) { try { const u = new URL(declared[1]); if (u.origin === origin) sitemapUrl = u.href; } catch { /* keep default */ } }
  const sitemap = await get(sitemapUrl);

  const candidates = [];
  for (const m of home.text.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"'#]+)/gi)) candidates.push(m[1]);
  if (sitemap) for (const m of sitemap.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) candidates.push(m[1].replace(/&amp;/g, '&'));

  const seen = new Set([keyOf(homeUrl)]);
  const queue = [];
  for (const href of candidates) {
    let u;
    try { u = new URL(href, home.url); } catch { continue; }
    if (u.origin !== origin || SKIP_EXT.test(u.pathname)) continue;
    u.hash = '';
    const k = keyOf(u);
    if (seen.has(k)) continue;
    seen.add(k);
    queue.push(u.href);
  }

  const fetched = await Promise.all(queue.slice(0, MAX_PAGES - 1).map((u) => get(u, true)));
  const pages = [{ url: homeUrl.pathname + homeUrl.search, html: home.text }];
  const final = new Set([keyOf(homeUrl)]);
  for (const r of fetched) {
    if (!isHtml(r)) continue;
    const u = new URL(r.url);
    if (u.origin !== origin || final.has(keyOf(u))) continue;
    final.add(keyOf(u));
    pages.push({ url: u.pathname + u.search, html: r.text });
  }

  return { site: origin, pages, robots: robotsTxt, llms: plainText(llms), found: queue.length + 1, limit: MAX_PAGES };
}

export async function onRequestGet(context) {
  const { request } = context;
  const target = parseTarget(new URL(request.url).searchParams.get('url'));
  if (!target) return json({ error: 'Enter a valid public website address, like example.com.' }, 400);

  // Repeat audits of the same site within 10 minutes are served from the edge cache.
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const cacheKey = new Request(new URL('/api/audit?url=' + encodeURIComponent(target.origin + target.pathname), request.url).href);
  if (cache) { const hit = await cache.match(cacheKey); if (hit) return hit; }

  const result = await crawl(target);
  if (result.error) return json({ error: result.error }, result.status);
  const res = json(result);
  if (cache) context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
