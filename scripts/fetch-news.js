const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const cheerio = require('cheerio');

// ---------- paths ----------
const outputDir = path.join(__dirname, '..', 'output');
const imagesDir = path.join(outputDir, 'images');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

const tempFile = path.join(outputDir, 'news-data-temp.json');
const fallbackFile = path.join(outputDir, 'news-data.json');
const archiveFile = path.join(outputDir, 'archive.json');

// ---------- config ----------
const MAX_ITEMS_PER_SOURCE = 10;
const MAX_ARTICLE_FETCHES = 8;
const ARTICLE_TIMEOUT = 12000;
const IMAGE_TIMEOUT = 10000;
const MAX_ARCHIVE = 500;

// ---------- sources ----------
const SOURCES = [
  // --- Persian ---
  { id: 'bbcpersian', name: 'BBC Persian', lang: 'fa', type: 'rss',
    url: 'https://feeds.bbci.co.uk/persian/rss.xml',
    maxAgeDays: 7 },

  { id: 'dw', name: 'DW Farsi', lang: 'fa', type: 'rss',
    url: 'https://rss.dw.com/rdf/rss-fa-all',
    maxAgeDays: 7 },

  { id: 'iranintl', name: 'Iran International', lang: 'fa', type: 'rss',
    url: 'https://www.iranintl.com/fa/rss',
    maxAgeDays: 7 },

  // --- Hebrew ---
  { id: 'c14', name: 'C14', lang: 'he', type: 'html',
    url: 'https://www.c14.co.il/',
    articleSelectors: ['article h2 a', 'article h3 a', 'h2 a', 'h3 a'],
    maxAgeDays: 14 },

  // --- English: Israel ---
  { id: 'ynet', name: 'Ynetnews', lang: 'en', type: 'rss',
    url: 'https://www.ynetnews.com/Integration/StoryRss3089.xml',
    maxAgeDays: 7 },

  { id: 'timesofisrael', name: 'Times of Israel', lang: 'en', type: 'rss',
    url: 'https://www.timesofisrael.com/feed/',
    maxAgeDays: 7 },

  // --- English: International ---
  { id: 'aljazeera', name: 'Al Jazeera', lang: 'en', type: 'rss',
    url: 'https://www.aljazeera.com/xml/rss/all.xml',
    maxAgeDays: 7 },

  { id: 'rferl', name: 'RFE/RL', lang: 'en', type: 'rss',
    url: 'https://www.rferl.org/api/zrqiteuuir',
    maxAgeDays: 14 },

  { id: 'rezapahlavi', name: 'Reza Pahlavi', lang: 'en', type: 'html',
    url: 'https://rezapahlavi.org/en/',
    articleSelectors: ['article h2 a', 'article h3 a', '.entry-title a'],
    maxAgeDays: 400 },

  // --- English: US (right-leaning) ---
  { id: 'foxnews', name: 'Fox News', lang: 'en', type: 'rss',
    url: 'https://moxie.foxnews.com/google-publisher/latest.xml',
    maxAgeDays: 7 },

  { id: 'nypost', name: 'New York Post', lang: 'en', type: 'rss',
    url: 'https://nypost.com/feed/',
    maxAgeDays: 7 },

  { id: 'washingtontimes', name: 'Washington Times', lang: 'en', type: 'rss',
    url: 'https://www.washingtontimes.com/rss/headlines/news/',
    maxAgeDays: 7 },

  { id: 'nationalreview', name: 'National Review', lang: 'en', type: 'rss',
    url: 'https://www.nationalreview.com/feed/',
    maxAgeDays: 7 },

  { id: 'dailycaller', name: 'The Daily Caller', lang: 'en', type: 'rss',
    url: 'https://dailycaller.com/feed/',
    maxAgeDays: 7 },
];

// ---------- helpers ----------
const toArray = (x) => (Array.isArray(x) ? x : (x == null ? [] : [x]));

const textOf = (x) => {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'number') return String(x);
  if (x.__cdata) return String(x.__cdata);
  if (x['#text']) return String(x['#text']);
  return '';
};

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveUrl(href, baseUrl) {
  try { return new URL(href, baseUrl).href; }
  catch { return ''; }
}

// ---------- date helpers ----------
function parseDateSafe(input) {
  if (!input) return '';
  if (input instanceof Date) return isNaN(input.getTime()) ? '' : input.toISOString();
  const s = String(input).trim();
  if (!s) return '';

  let d = new Date(s);
  if (!isNaN(d.getTime()) && d.getFullYear() > 1990 && d.getFullYear() < 2100) {
    return d.toISOString();
  }

  const isoish = s.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (isoish) {
    const [, y, mo, da, h, mi, se] = isoish;
    d = new Date(Date.UTC(+y, +mo - 1, +da, +h, +mi, +(se || 0)));
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return '';
}

function normalizeTitle(title) {
  if (!title) return '';
  return String(title)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*[-–—|]\s*(jpost|jerusalem post|times of israel|ynet.*|bbc.*|dw.*|rferl.*|al jazeera.*|iran international|iran intl.*|c14|reza pahlavi.*|fox news.*|new york post.*|nypost.*|washington times.*|national review.*|daily caller.*)\s*$/i, '')
    .trim()
    .slice(0, 100);
}

function dedupeKey(item) {
  if (!item) return '';
  return `${item.sourceId || ''}::${normalizeTitle(item.originalTitle || item.title || '')}`;
}

function stableId(sourceId, link, title) {
  const key = (link && String(link).trim()) || (title && String(title).trim()) || crypto.randomBytes(8).toString('hex');
  return `${sourceId}-${crypto.createHash('md5').update(key).digest('hex').slice(0, 10)}`;
}

function describeError(err) {
  if (err == null) return 'unknown (null)';
  if (typeof err === 'string') return err || 'empty string';
  if (err.code && err.message) return `${err.code}: ${err.message}`;
  if (err.code) return err.code;
  if (err.message) return err.message;
  try { return JSON.stringify(err); } catch { return 'unknown error'; }
}

// ---------- freshness check ----------
function checkFeedFreshness(items, maxAgeDays = 7) {
  if (!items || !items.length) return { fresh: false, reason: 'empty feed', ageDays: null };
  let newest = 0;
  for (const item of items) {
    const d = parseDateSafe(item.pubDate);
    if (d) {
      const t = new Date(d).getTime();
      if (t > newest) newest = t;
    }
  }
  if (!newest) return { fresh: false, reason: 'no valid dates', ageDays: null };
  const ageMs = Date.now() - newest;
  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
  return {
    fresh: ageDays <= maxAgeDays,
    ageDays,
    newest: new Date(newest).toISOString(),
    maxAgeDays,
  };
}

// ---------- http ----------
function fetchUrl(url, opts = {}) {
  const {
    retries = 2, timeout = 15000, binary = false, maxRedirects = 5, extraHeaders = {},
  } = opts;

  return new Promise((resolve, reject) => {
    let attempt = 0;
    let redirects = 0;

    const go = (u) => {
      let urlObj;
      try { urlObj = new URL(u); }
      catch { return reject(new Error('invalid url: ' + u)); }

      const lib = urlObj.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,fa;q=0.8,he;q=0.7',
          ...extraHeaders,
        },
        timeout,
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < maxRedirects) {
          redirects++;
          res.resume();
          return go(new URL(res.headers.location, u).href);
        }
        if (res.statusCode !== 200) {
          if (attempt < retries) {
            attempt++;
            return setTimeout(() => go(u), 1500);
          }
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve(binary ? buf : buf.toString('utf8'));
        });
      });

      req.on('error', (err) => {
        if (attempt < retries) {
          attempt++;
          return setTimeout(() => go(u), 1500);
        }
        reject(err);
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.end();
    };

    go(url);
  });
}

function cacheBust(url) {
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + '_=' + Date.now();
}

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  'Pragma': 'no-cache',
};

// ---------- JSON-LD extraction ----------
function extractJsonLdArticle(text) {
  if (!text || typeof text !== 'string') return null;
  if (!text.includes('articleBody') && !text.includes('datePublished')) return null;

  const blocks = [];
  let depth = 0, inString = false, escape = false, start = -1;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) { blocks.push(text.substring(start, i + 1)); start = -1; }
    }
  }

  for (const block of blocks) {
    let parsed;
    try { parsed = JSON.parse(block); } catch { continue; }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const type = item['@type'];
      const isArticle = type === 'NewsArticle' || type === 'Article' || type === 'ReportageNewsArticle';
      if (!isArticle) continue;
      if (!item.articleBody && !item.datePublished) continue;

      let image = '';
      if (Array.isArray(item.image)) image = item.image[0]?.url || item.image[0]?.contentUrl || '';
      else if (item.image && typeof item.image === 'object') image = item.image.url || item.image.contentUrl || '';
      else if (typeof item.image === 'string') image = item.image;
      image = String(image).replace(/\s+/g, '');

      return {
        title: (item.headline || '').trim(),
        content: item.articleBody ? String(item.articleBody).trim() : '',
        image,
        pubDate: parseDateSafe(item.datePublished || ''),
      };
    }
  }
  return null;
}

// ---------- RSS parser ----------
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  cdataPropName: '__cdata',
  trimValues: true,
});

function pickImageFromRss(item) {
  if (item.enclosure) {
    for (const e of toArray(item.enclosure)) {
      if (typeof e === 'object' && e['@_url'] && (e['@_type'] || '').startsWith('image')) return e['@_url'];
    }
  }
  if (item['media:content']) {
    const m = toArray(item['media:content'])[0];
    if (m && m['@_url']) return m['@_url'];
  }
  if (item['media:thumbnail']) {
    const m = toArray(item['media:thumbnail'])[0];
    if (m && m['@_url']) return m['@_url'];
  }
  const html = textOf(item['content:encoded']) || textOf(item.description) || '';
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (m) return m[1];
  return '';
}

function parseRss(xml) {
  const doc = parser.parse(xml);

  if (doc && doc.rss && doc.rss.channel) {
    return toArray(doc.rss.channel.item).map(item => ({
      title: textOf(item.title),
      link: textOf(item.link) || (item.link && item.link['@_href']) || '',
      pubDate: textOf(item.pubDate) || textOf(item['dc:date']) || '',
      description: textOf(item.description),
      content: textOf(item['content:encoded']),
      image: pickImageFromRss(item),
    }));
  }

  if (doc && doc.feed) {
    return toArray(doc.feed.entry).map(entry => {
      let link = '';
      if (typeof entry.link === 'string') link = entry.link;
      else if (Array.isArray(entry.link)) {
        const alt = entry.link.find(l => l['@_rel'] === 'alternate') || entry.link[0];
        link = alt && alt['@_href'] ? alt['@_href'] : '';
      } else if (entry.link && entry.link['@_href']) {
        link = entry.link['@_href'];
      }
      return {
        title: textOf(entry.title),
        link,
        pubDate: textOf(entry.updated || entry.published),
        description: textOf(entry.summary),
        content: textOf(entry.content),
        image: pickImageFromRss(entry),
      };
    });
  }
  return [];
}

// ---------- article extraction ----------
function extractPubDateFromPage($) {
  const candidates = [
    $('meta[property="article:published_time"]').attr('content'),
    $('meta[property="og:article:published_time"]').attr('content'),
    $('meta[name="article:published_time"]').attr('content'),
    $('meta[property="article:published"]').attr('content'),
    $('meta[itemprop="datePublished"]').attr('content'),
    $('meta[name="pubdate"]').attr('content'),
    $('meta[name="publish-date"]').attr('content'),
    $('meta[name="publish_date"]').attr('content'),
    $('meta[name="date"]').attr('content'),
    $('meta[name="dc.date"]').attr('content'),
    $('meta[name="DC.date.issued"]').attr('content'),
    $('meta[property="og:updated_time"]').attr('content'),
    $('time[datetime]').first().attr('datetime'),
  ];
  for (const c of candidates) {
    const d = parseDateSafe(c);
    if (d) return d;
  }
  return '';
}

function extractArticle(html, articleUrl) {
  const $ = cheerio.load(html);

  const ogTitle = $('meta[property="og:title"]').attr('content') || '';
  const h1 = $('h1').first().text().trim();
  const pageTitle = $('title').text().trim();
  const title = ogTitle || h1 || pageTitle;

  let image = $('meta[property="og:image"]').attr('content')
    || $('meta[name="twitter:image"]').attr('content')
    || $('meta[property="twitter:image"]').attr('content')
    || '';

  const candidates = [
    'article', 'main', '[role="main"]',
    '.article-body', '.article__body', '.post-content',
    '.entry-content', '.story-body', '.article-content',
    '.post-body', '#article-body', '.content',
  ];

  let bestText = '';
  for (const sel of candidates) {
    const el = $(sel).first();
    if (!el.length) continue;
    const paras = el.find('p').map((i, p) => $(p).text().trim()).get().filter(t => t.length > 25);
    const joined = paras.join('\n\n');
    if (joined.length > bestText.length) bestText = joined;
    if (bestText.length < 200) {
      const allText = el.text().replace(/\s+/g, ' ').trim();
      if (allText.length > bestText.length) bestText = allText;
    }
  }

  if (bestText.length < 200) {
    const paras = $('p').map((i, p) => $(p).text().trim()).get().filter(t => t.length > 30);
    bestText = paras.join('\n\n');
  }

  if (!image) {
    const firstImg = $('article img, main img, .content img').first().attr('src');
    if (firstImg) image = resolveUrl(firstImg, articleUrl);
  }
  if (image && !/^https?:\/\//.test(image)) image = resolveUrl(image, articleUrl);

  return {
    title: title.trim(),
    content: bestText.trim(),
    image,
    pubDate: extractPubDateFromPage($),
  };
}

// ---------- html scrape ----------
async function scrapeHtmlSource(source) {
  console.log(`[fetch] ${source.id} (html) ${source.url}`);
  const html = await fetchUrl(cacheBust(source.url), {
    timeout: ARTICLE_TIMEOUT,
    extraHeaders: NO_CACHE_HEADERS,
  });
  const $ = cheerio.load(html);

  const seen = new Set();
  const items = [];

  for (const sel of source.articleSelectors) {
    $(sel).each((i, el) => {
      if (items.length >= MAX_ITEMS_PER_SOURCE) return false;
      const $a = $(el);
      const href = $a.attr('href');
      if (!href) return;
      const link = resolveUrl(href, source.url);
      if (!link || seen.has(link)) return;
      try {
        const u = new URL(link);
        const s = new URL(source.url);
        if (u.hostname !== s.hostname) return;
      } catch { return; }
      const title = $a.text().trim();
      if (!title || title.length < 10) return;
      seen.add(link);
      items.push({ title, link, pubDate: '', description: '', content: '', image: '' });
    });
  }
  console.log(`[ok] ${source.id}: ${items.length} links`);
  return items;
}

// ---------- image download ----------
function extFromUrl(url) {
  try {
    const p = new URL(url).pathname;
    const m = p.match(/\.(jpe?g|png|webp|gif)$/i);
    return m ? m[1].toLowerCase() : 'jpg';
  } catch { return 'jpg'; }
}

async function downloadImage(imageUrl, id) {
  if (!imageUrl) return '';
  try {
    const ext = extFromUrl(imageUrl);
    const filename = `${id}.${ext}`;
    const filepath = path.join(imagesDir, filename);
    if (fs.existsSync(filepath)) return `images/${filename}`;
    const buf = await fetchUrl(imageUrl, { timeout: IMAGE_TIMEOUT, retries: 1, binary: true });
    fs.writeFileSync(filepath, buf);
    return `images/${filename}`;
  } catch (err) {
    console.log(`[img] skip ${String(imageUrl).slice(0, 60)}: ${describeError(err)}`);
    return '';
  }
}

// ---------- enrich ----------
async function enrichItem(item, source) {
  const originalLink = item.link || '';
  const originalTitle = item.title || '';

  let link = originalLink;
  let title = originalTitle;
  let content = '';
  let image = item.image || '';
  let pubDate = '';

  const rawRss = item.content || item.description || '';
  const rssJsonLd = extractJsonLdArticle(rawRss);

  if (rssJsonLd) {
    title = title || rssJsonLd.title;
    content = rssJsonLd.content || content;
    image = image || rssJsonLd.image;
    if (rssJsonLd.pubDate) pubDate = rssJsonLd.pubDate;
  } else {
    content = stripHtml(rawRss);
  }

  let pagePubDate = '';
  if (link) {
    try {
      const html = await fetchUrl(link, { timeout: ARTICLE_TIMEOUT, retries: 1 });

      const pageJsonLd = extractJsonLdArticle(html);
      if (pageJsonLd) {
        if (pageJsonLd.content && pageJsonLd.content.length > content.length) {
          content = pageJsonLd.content;
        }
        if (!image && pageJsonLd.image) image = pageJsonLd.image;
        if (!title && pageJsonLd.title) title = pageJsonLd.title;
        if (pageJsonLd.pubDate) pagePubDate = pageJsonLd.pubDate;
      }

      const ex = extractArticle(html, link);
      if (ex.content && ex.content.length > content.length) content = ex.content;
      if (!image && ex.image) image = ex.image;
      if (!title && ex.title) title = ex.title;
      if (!pagePubDate && ex.pubDate) pagePubDate = ex.pubDate;
    } catch (err) {
      console.log(`[enrich] fail ${String(link).slice(0, 60)}: ${describeError(err)}`);
    }
  }

  let finalDate = pagePubDate || pubDate;
  if (!finalDate) {
    const rssDate = parseDateSafe(item.pubDate);
    if (rssDate) finalDate = rssDate;
  }
  if (!finalDate) finalDate = new Date().toISOString();

  const id = stableId(source.id, originalLink, originalTitle);
  const localImage = await downloadImage(image, id);

  return {
    id,
    sourceId: source.id,
    sourceName: source.name,
    originalTitle: title,
    title,
    originalSummary: content.slice(0, 400),
    summary: content.slice(0, 400),
    originalContent: content,
    content,
    image: localImage,
    link,
    pubDate: finalDate,
    originalLang: source.lang,
    needsTranslation: source.lang !== 'fa',
  };
}

// ---------- fetch RSS with freshness check + fallback ----------
async function fetchRssWithFreshness(source) {
  const urls = [source.url, ...(source.fallbackUrls || [])];
  const maxAge = source.maxAgeDays || 7;

  let best = null;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      console.log(`[fetch] ${source.id} (rss) ${url}`);
      const xml = await fetchUrl(cacheBust(url), {
        timeout: 20000,
        extraHeaders: NO_CACHE_HEADERS,
      });
      const items = parseRss(xml).slice(0, MAX_ITEMS_PER_SOURCE);

      if (!items.length) {
        console.log(`[skip] ${source.id} empty feed at ${url}`);
        continue;
      }

      const freshness = checkFeedFreshness(items, maxAge);
      if (freshness.fresh) {
        console.log(`[ok] ${source.id}: ${items.length} items, newest ${freshness.ageDays}d old (${url})`);
        return items;
      }

      console.warn(
        `[warn] ${source.id} stale feed: newest ${freshness.ageDays}d old, ` +
        `threshold ${maxAge}d (${url})`
      );

      if (!best || (freshness.ageDays != null && best.ageDays != null && freshness.ageDays < best.ageDays)) {
        best = { url, items, ageDays: freshness.ageDays };
      }
    } catch (err) {
      console.error(`[err] ${source.id} fetch ${url}: ${describeError(err)}`);
    }
  }

  if (best) {
    console.warn(`[warn] ${source.id} using stale feed anyway: newest ${best.ageDays}d old (${best.url})`);
    return best.items;
  }
  throw new Error('all feed URLs failed or empty');
}

// ---------- source runner ----------
async function fetchSource(source) {
  try {
    let items;
    if (source.type === 'rss') {
      items = await fetchRssWithFreshness(source);
    } else {
      items = (await scrapeHtmlSource(source)).slice(0, MAX_ITEMS_PER_SOURCE);
    }

    const enriched = [];
    const toEnrich = items.slice(0, MAX_ARTICLE_FETCHES);
    const rest = items.slice(MAX_ARTICLE_FETCHES);

    for (let i = 0; i < toEnrich.length; i += 2) {
      const batch = toEnrich.slice(i, i + 2);
      const results = await Promise.all(batch.map(it => enrichItem(it, source)));
      for (const r of results) if (r) enriched.push(r);
    }

    for (const r of rest) {
      const id = stableId(source.id, r.link, r.title);
      const text = stripHtml(r.content || r.description || '');
      const pubDate = parseDateSafe(r.pubDate) || new Date().toISOString();
      enriched.push({
        id,
        sourceId: source.id,
        sourceName: source.name,
        originalTitle: r.title,
        title: r.title,
        originalSummary: text.slice(0, 400),
        summary: text.slice(0, 400),
        originalContent: text,
        content: text,
        image: r.image || '',
        link: r.link,
        pubDate,
        originalLang: source.lang,
        needsTranslation: source.lang !== 'fa',
      });
    }

    if (enriched.length) {
      const newest = enriched.reduce((acc, n) => {
        const t = new Date(n.pubDate).getTime();
        return t > acc ? t : acc;
      }, 0);
      const ageDays = Math.floor((Date.now() - newest) / (1000 * 60 * 60 * 24));
      const maxAge = source.maxAgeDays || 7;
      if (ageDays > maxAge) {
        console.warn(`[warn] ${source.id} overall newest is ${ageDays}d old (threshold ${maxAge}d)`);
      }
    }

    return { source, items: enriched, error: null };
  } catch (err) {
    const msg = describeError(err);
    console.error(`[err] ${source.id}: ${msg}`);
    return { source, items: [], error: msg };
  }
}

// ---------- dedupe ----------
function dedupeNews(items) {
  const seenIds = new Set();
  const seenKeys = new Set();
  const out = [];

  for (const n of items) {
    if (!n || !n.id) continue;
    if (seenIds.has(n.id)) continue;
    const k = dedupeKey(n);
    if (k && seenKeys.has(k)) continue;
    seenIds.add(n.id);
    if (k) seenKeys.add(k);
    out.push(n);
  }
  return out;
}

// ---------- archive ----------
function updateArchive(newItems) {
  let archive = { news: [] };
  if (fs.existsSync(archiveFile)) {
    try { archive = JSON.parse(fs.readFileSync(archiveFile, 'utf8')); }
    catch { archive = { news: [] }; }
  }
  if (!Array.isArray(archive.news)) archive.news = [];

  const combined = [...newItems, ...archive.news];
  const cleaned = dedupeNews(combined).slice(0, MAX_ARCHIVE);

  archive.news = cleaned;
  archive.lastUpdated = new Date().toISOString();
  archive.totalNews = cleaned.length;

  fs.writeFileSync(archiveFile, JSON.stringify(archive, null, 2));
  console.log(`[archive] total ${cleaned.length} (from ${combined.length} raw)`);
}

// ---------- main ----------
async function main() {
  console.log('[start] fetch');

  const results = await Promise.all(SOURCES.map(fetchSource));

  const allNews = [];
  const bySource = {};
  const failedSources = [];

  for (const r of results) {
    bySource[r.source.id] = r.items.length;
    if (r.error) failedSources.push({ source: r.source.id, error: r.error });
    allNews.push(...r.items);
  }

  const unique = dedupeNews(allNews);
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
    translationStats: {
      totalTranslated: 0,
      totalFailed: output.stats.needsTranslation,
      engine: 'none',
      fallback: true,
    },
  }, null, 2));

  updateArchive(unique);

  console.log(`[save] ${unique.length} items`);
  if (failedSources.length) {
    console.warn(`[warn] failed: ${failedSources.map(f => f.source).join(', ')}`);
  }
}

main().catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});