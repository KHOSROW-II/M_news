const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const cheerio = require('cheerio');

const outputDir = path.join(__dirname, '..', 'output');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const tempFile = path.join(outputDir, 'news-data-temp.json');
const fallbackFile = path.join(outputDir, 'news-data.json');

const MAX_ITEMS_PER_SOURCE = 8;
const MAX_ARTICLE_FETCHES = 4;
const ARTICLE_TIMEOUT = 12000;

// ---------- sources ----------
const SOURCES = [
  { id: 'bbcpersian', name: 'BBC Persian', lang: 'fa', type: 'rss',
    url: 'https://feeds.bbci.co.uk/persian/rss.xml' },
  { id: 'radiofarda', name: 'Radio Farda', lang: 'fa', type: 'google',
    query: 'site:radiofarda.com', gl: 'IR', hl: 'fa' },
  { id: 'iranintl', name: 'Iran International', lang: 'fa', type: 'google',
    query: 'site:iranintl.com', gl: 'IR', hl: 'fa' },
  { id: 'timesofisrael', name: 'Times of Israel', lang: 'en', type: 'rss',
    url: 'https://www.timesofisrael.com/feed/' },
  { id: 'jpost', name: 'Jerusalem Post', lang: 'en', type: 'rss',
    url: 'https://rss.jpost.com/rss/rssfeedsheadlines.aspx' },
  { id: 'c14', name: 'C14', lang: 'he', type: 'google',
    query: 'site:c14.co.il', gl: 'IL', hl: 'he' },
  { id: 'rezapahlavi', name: 'Reza Pahlavi', lang: 'en', type: 'google',
    query: 'site:rezapahlavi.org', gl: 'US', hl: 'en' },
];

// ---------- http ----------
function fetchUrl(url, opts = {}) {
  const { retries = 2, timeout = 15000, maxRedirects = 4 } = opts;
  return new Promise((resolve, reject) => {
    let attempt = 0;
    let redirects = 0;

    const go = (u) => {
      const urlObj = new URL(u);
      const lib = urlObj.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,fa;q=0.8',
        },
        timeout,
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < maxRedirects) {
          redirects++;
          res.resume();
          return go(new URL(res.headers.location, u).href);
        }
        if (res.statusCode !== 200) {
          if (attempt < retries) { attempt++; return setTimeout(() => go(u), 1500); }
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
      });
      req.on('error', (err) => {
        if (attempt < retries) { attempt++; return setTimeout(() => go(u), 1500); }
        reject(err);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    };
    go(url);
  });
}

// ---------- rss ----------
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  cdataPropName: '__cdata',
  trimValues: true,
});

const toArray = (x) => (Array.isArray(x) ? x : (x == null ? [] : [x]));
const textOf = (x) => {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'number') return String(x);
  if (x.__cdata) return String(x.__cdata);
  if (x['#text']) return String(x['#text']);
  return '';
};

function parseRss(xml) {
  const doc = parser.parse(xml);
  const channel = doc?.rss?.channel;
  if (channel) {
    return toArray(channel.item).map(item => ({
      title: textOf(item.title),
      link: textOf(item.link) || (item.link && item.link['@_href']) || '',
      pubDate: textOf(item.pubDate),
      description: textOf(item.description),
      content: textOf(item['content:encoded']),
      image: pickImage(item),
    }));
  }
  const feed = doc?.feed;
  if (feed) {
    return toArray(feed.entry).map(entry => ({
      title: textOf(entry.title),
      link: (entry.link && (entry.link['@_href'] || (Array.isArray(entry.link) && entry.link.find(l => l['@_href'])?.['@_href']))) || '',
      pubDate: textOf(entry.updated || entry.published),
      description: textOf(entry.summary),
      content: textOf(entry.content),
      image: pickImage(entry),
    }));
  }
  return [];
}

function pickImage(item) {
  const enc = item.enclosure;
  if (enc) {
    const arr = toArray(enc);
    for (const e of arr) {
      if (typeof e === 'object' && e['@_url'] && (e['@_type'] || '').startsWith('image')) return e['@_url'];
    }
  }
  const mediaContent = item['media:content'];
  if (mediaContent) {
    const m = toArray(mediaContent)[0];
    if (m && m['@_url']) return m['@_url'];
  }
  const mediaThumb = item['media:thumbnail'];
  if (mediaThumb) {
    const m = toArray(mediaThumb)[0];
    if (m && m['@_url']) return m['@_url'];
  }
  return '';
}

function googleNewsUrl(query, gl, hl) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${gl}:${hl}`;
}

function extractOriginalLinkFromGoogle(description) {
  if (!description) return '';
  const m = description.match(/href="([^"]+)"/);
  return m ? m[1] : '';
}

// ---------- article extraction ----------
function stripHtml(html) {
  if (!html) return '';
  return String(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function extractFromArticleHtml(html, articleUrl) {
  const $ = cheerio.load(html);
  const ogTitle = $('meta[property="og:title"]').attr('content') || '';
  const title = ogTitle || $('h1').first().text().trim() || $('title').text().trim();

  let image = $('meta[property="og:image"]').attr('content')
    || $('meta[name="twitter:image"]').attr('content')
    || $('meta[property="twitter:image"]').attr('content')
    || '';

  // content heuristics
  const selectors = [
    'article', 'main', '[role="main"]',
    '.article-body', '.article__body', '.post-content', '.entry-content',
    '.story-body', '.story', '.content', '#content',
  ];
  let bestText = '';
  for (const sel of selectors) {
    const el = $(sel).first();
    if (el.length) {
      const t = el.text().replace(/\s+/g, ' ').trim();
      if (t.length > bestText.length) bestText = t;
    }
  }
  if (bestText.length < 200) {
    // fallback: collect paragraphs
    const ps = $('p').map((i, el) => $(el).text().trim()).get().filter(t => t.length > 30);
    const joined = ps.join('\n\n');
    if (joined.length > bestText.length) bestText = joined;
  }

  if (!image) {
    const firstImg = $('article img, main img, .content img').first().attr('src');
    if (firstImg) image = firstImg;
  }

  // resolve relative URLs
  if (image && !/^https?:\/\//.test(image)) {
    try { image = new URL(image, articleUrl).href; } catch (e) {}
  }

  return { title: title.trim(), content: bestText.trim(), image };
}

async function enrichItem(item) {
  const rawContent = item.content || item.description || '';
  const clean = stripHtml(rawContent);

  // if RSS already has enough content, don't fetch the page
  if (clean.length > 300 && item.image) {
    return { ...item, content: clean, image: item.image };
  }

  if (!item.link) {
    return { ...item, content: clean, image: item.image || '' };
  }

  try {
    const html = await fetchUrl(item.link, { timeout: ARTICLE_TIMEOUT, retries: 1 });
    const extracted = extractFromArticleHtml(html, item.link);
    return {
      ...item,
      content: extracted.content || clean,
      image: item.image || extracted.image || '',
      title: item.title || extracted.title,
    };
  } catch (err) {
    return { ...item, content: clean, image: item.image || '' };
  }
}

// ---------- concurrency ----------
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try { results[idx] = await fn(items[idx], idx); }
      catch (e) { results[idx] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------- main ----------
async function fetchSource(source) {
  const url = source.type === 'google'
    ? googleNewsUrl(source.query, source.gl, source.hl)
    : source.url;

  let xml;
  try {
    xml = await fetchUrl(url, { timeout: 15000 });
  } catch (err) {
    console.error(`[err] ${source.id}: ${err.message}`);
    return { source, items: [], error: err.message };
  }

  let items = parseRss(xml).slice(0, MAX_ITEMS_PER_SOURCE);

  if (source.type === 'google') {
    items = items.map(it => ({
      ...it,
      link: extractOriginalLinkFromGoogle(it.description) || it.link,
    })).filter(it => it.link);
  }

  // enrich top items with full content + image
  const enriched = [];
  const toEnrich = items.slice(0, MAX_ARTICLE_FETCHES);
  const rest = items.slice(MAX_ARTICLE_FETCHES);
  const detailed = await mapLimit(toEnrich, 2, enrichItem);
  for (const d of detailed) if (d) enriched.push(d);
  for (const r of rest) {
    const clean = stripHtml(r.content || r.description || '');
    enriched.push({ ...r, content: clean, image: r.image || '' });
  }

  console.log(`[ok] ${source.id}: ${enriched.length}`);
  return { source, items: enriched, error: null };
}

async function main() {
  console.log('[start] fetch');
  const results = await Promise.all(SOURCES.map(fetchSource));

  const allNews = [];
  const bySource = {};
  const failedSources = [];

  for (const r of results) {
    bySource[r.source.id] = r.items.length;
    if (r.error) failedSources.push({ source: r.source.id, error: r.error });

    for (const item of r.items) {
      const pubDate = item.pubDate && !isNaN(new Date(item.pubDate)) ? new Date(item.pubDate).toISOString() : new Date().toISOString();
      allNews.push({
        id: `${r.source.id}-${Buffer.from(item.link || item.title).toString('base64').slice(0, 16)}`,
        sourceId: r.source.id,
        sourceName: r.source.name,
        originalTitle: item.title || '',
        title: item.title || '',
        originalSummary: (item.content || '').slice(0, 400),
        summary: (item.content || '').slice(0, 400),
        originalContent: item.content || '',
        content: item.content || '',
        image: item.image || '',
        link: item.link || '',
        pubDate,
        originalLang: r.source.lang,
        needsTranslation: r.source.lang !== 'fa',
      });
    }
  }

  // dedupe by title
  const seen = new Set();
  const unique = allNews.filter(n => {
    const key = (n.originalTitle || '').toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // sort newest first
  unique.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  const output = {
    lastUpdated: new Date().toISOString(),
    totalNews: unique.length,
    news: unique,
    stats: {
      bySource,
      needsTranslation: unique.filter(n => n.needsTranslation).length,
      failedSources,
    },
  };

  fs.writeFileSync(tempFile, JSON.stringify(output, null, 2));
  fs.writeFileSync(fallbackFile, JSON.stringify({
    ...output,
    translationStats: { totalTranslated: 0, totalFailed: output.stats.needsTranslation, engine: 'none', fallback: true },
  }, null, 2));

  console.log(`[save] ${unique.length} items`);
  if (failedSources.length) console.warn(`[warn] failed: ${failedSources.map(f => f.source).join(', ')}`);
}

main().catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});