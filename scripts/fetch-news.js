const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const cheerio = require('cheerio');
const crypto = require('crypto');

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
const MAX_ARTICLE_FETCHES = 6;
const ARTICLE_TIMEOUT = 12000;
const IMAGE_TIMEOUT = 10000;
const MAX_ARCHIVE = 500;

// ---------- sources ----------
// type 'rss' -> مستقیم از فید RSS
// type 'html' -> صفحه اصلی رو اسکرپ می‌کنیم
const SOURCES = [
  // --- RSS مستقیم (لینک‌ها از قبل معتبرن) ---
  { id: 'bbcpersian', name: 'BBC Persian', lang: 'fa', type: 'rss',
    url: 'https://feeds.bbci.co.uk/persian/rss.xml' },

  { id: 'dw', name: 'DW Farsi', lang: 'fa', type: 'rss',
    url: 'https://rss.dw.com/rdf/rss-fa-all' },

  { id: 'rferl', name: 'RFE/RL', lang: 'en', type: 'rss',
    url: 'https://www.rferl.org/api/zrqiteuuir' },

  { id: 'jpost', name: 'Jerusalem Post', lang: 'en', type: 'rss',
    url: 'https://www.jpost.com/rss/rssfeedsheadlines.aspx' },

  { id: 'aljazeera', name: 'Al Jazeera', lang: 'en', type: 'rss',
    url: 'https://www.aljazeera.com/xml/rss/all.xml' },

  { id: 'timesofisrael', name: 'Times of Israel', lang: 'en', type: 'rss',
    url: 'https://www.timesofisrael.com/feed/' },

  { id: 'iranintl', name: 'Iran International', lang: 'fa', type: 'rss',
    url: 'https://www.iranintl.com/fa/rss' },

  // --- HTML scrape ---
  { id: 'c14', name: 'C14', lang: 'he', type: 'html',
    url: 'https://www.c14.co.il/',
    articleSelectors: ['article h2 a', 'article h3 a', 'h2 a', 'h3 a'] },

  { id: 'rezapahlavi', name: 'Reza Pahlavi', lang: 'en', type: 'html',
    url: 'https://rezapahlavi.org/en/',
    articleSelectors: ['article h2 a', 'article h3 a', '.entry-title a'] },
];

// ---------- http ----------
function fetchUrl(url, opts = {}) {
  const { retries = 2, timeout = 15000, binary = false, maxRedirects = 5 } = opts;

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
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve(binary ? buf : buf.toString('utf8'));
        });
      });
      req.on('error', (err) => {
        const wrapped = (err instanceof Error && err.message)
          ? err
          : new Error(
              (err && (err.code || err.message)) ||
              'network error'
            );
        if (attempt < retries) {
          attempt++;
          return setTimeout(() => go(u), 1500);
        }
        reject(wrapped);
      });
      req.on('timeout', () => {
        req.destroy(new Error('timeout'));
      });

    go(url);
  });
}

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

function stableId(sourceId, link, title) {
  const key = link || title || Math.random().toString();
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

// اگر متن داخلش JSON-LD با articleBody داره، همون رو استخراج کن
function extractJsonLdArticle(text) {
  if (!text || typeof text !== 'string') return null;
  if (!text.includes('articleBody')) return null;

  // همه‌ی بلوک‌های {} سطح-بالا رو پیدا کن
  const blocks = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        blocks.push(text.substring(start, i + 1));
        start = -1;
      }
    }
  }

  for (const block of blocks) {
    let parsed;
    try { parsed = JSON.parse(block); }
    catch { continue; }

    // بعضی فیدها آرایه می‌دن
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const type = item['@type'];
      if (type !== 'NewsArticle' && type !== 'Article' && type !== 'ReportageNewsArticle') continue;
      if (!item.articleBody) continue;

      let image = '';
      if (Array.isArray(item.image)) {
        image = item.image[0]?.url || item.image[0]?.contentUrl || '';
      } else if (item.image && typeof item.image === 'object') {
        image = item.image.url || item.image.contentUrl || '';
      } else if (typeof item.image === 'string') {
        image = item.image;
      }
      // پاک کردن فاصله‌های اضافی که بعضی سایت‌ها می‌ذارن
      image = image.replace(/\s+/g, '');

      return {
        title: (item.headline || '').trim(),
        content: String(item.articleBody).trim(),
        image,
        pubDate: item.datePublished || '',
      };
    }
  }

  return null;
}

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

  if (doc?.rss?.channel) {
    return toArray(doc.rss.channel.item).map(item => ({
      title: textOf(item.title),
      link: textOf(item.link) || (item.link && item.link['@_href']) || '',
      pubDate: textOf(item.pubDate),
      description: textOf(item.description),
      content: textOf(item['content:encoded']),
      image: pickImageFromRss(item),
    }));
  }

  if (doc?.feed) {
    return toArray(doc.feed.entry).map(entry => {
      let link = '';
      if (typeof entry.link === 'string') link = entry.link;
      else if (Array.isArray(entry.link)) {
        const alt = entry.link.find(l => l['@_rel'] === 'alternate') || entry.link[0];
        link = alt?.['@_href'] || '';
      } else if (entry.link?.['@_href']) {
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

  // بهترین ظرف محتوا رو پیدا کن
  const candidates = [
    'article',
    'main',
    '[role="main"]',
    '.article-body',
    '.article__body',
    '.post-content',
    '.entry-content',
    '.story-body',
    '.article-content',
    '.post-body',
    '#article-body',
    '.content',
  ];

  let bestText = '';
  for (const sel of candidates) {
    const el = $(sel).first();
    if (!el.length) continue;
    // پاراگراف‌ها رو جدا کن
    const paras = el.find('p').map((i, p) => $(p).text().trim()).get().filter(t => t.length > 25);
    const joined = paras.join('\n\n');
    if (joined.length > bestText.length) bestText = joined;
    // اگه پاراگراف کم بود، کل متن
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

  return { title: title.trim(), content: bestText.trim(), image };
}

// ---------- html scraping ----------
async function scrapeHtmlSource(source) {
  console.log(`[fetch] ${source.id} (html)`);
  const html = await fetchUrl(source.url, { timeout: ARTICLE_TIMEOUT });
  const $ = cheerio.load(html);

  const seen = new Set();
  const items = [];

  for (const sel of source.articleSelectors) {
    $(sel).each((i, el) => {
      if (items.length >= MAX_ITEMS_PER_SOURCE) return;

      const $a = $(el);
      const href = $a.attr('href');
      if (!href) return;

      const link = resolveUrl(href, source.url);
      if (!link || seen.has(link)) return;
      // فقط لینک‌های داخل همون دامنه
      try {
        const u = new URL(link);
        const s = new URL(source.url);
        if (u.hostname !== s.hostname) return;
      } catch { return; }

      const title = $a.text().trim();
      if (!title || title.length < 10) return;

      seen.add(link);
      items.push({ title, link, pubDate: new Date().toISOString(), description: '', content: '', image: '' });
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
    console.log(`[img] skip ${imageUrl.slice(0, 60)}: ${err.message}`);
    return '';
  }
}

// ---------- enrich ----------
async function enrichItem(item, source) {
  let link = item.link;
  let title = item.title || '';
  let content = '';
  let image = item.image || '';

  // 1) اول ببین داخل RSS اصلاً JSON-LD هست یا نه
  const rawRss = item.content || item.description || '';
  const jsonLd = extractJsonLdArticle(rawRss);
  if (jsonLd) {
    title = title || jsonLd.title;
    content = jsonLd.content;
    image = image || jsonLd.image;
    if (!item.pubDate && jsonLd.pubDate) item.pubDate = jsonLd.pubDate;
  } else {
    content = stripHtml(rawRss);
  }

  // 2) اگه محتوا هنوز کم بود، صفحه مقاله رو بگیر
  if (link && content.length < 400) {
    try {
      const html = await fetchUrl(link, { timeout: ARTICLE_TIMEOUT, retries: 1 });

      // 2-الف) داخل HTML هم دنبال JSON-LD بگرد
      const jsonLdFromPage = extractJsonLdArticle(html);
      if (jsonLdFromPage && jsonLdFromPage.content.length > content.length) {
        title = title || jsonLdFromPage.title;
        content = jsonLdFromPage.content;
        image = image || jsonLdFromPage.image;
      } else {
        // 2-ب) در غیر این صورت از cheerio استفاده کن
        const ex = extractArticle(html, link);
        if (ex.content && ex.content.length > content.length) content = ex.content;
        if (!image && ex.image) image = ex.image;
        if (!title && ex.title) title = ex.title;
      }
    } catch (err) {
      console.log(`[enrich] fail ${link.slice(0, 60)}: ${describeError(err)}`);
    }
  }

  const id = stableId(source.id, link, title);
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
    pubDate: item.pubDate && !isNaN(new Date(item.pubDate)) ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
    originalLang: source.lang,
    needsTranslation: source.lang !== 'fa',
  };
}

function describeError(err) {
  if (!err) return 'unknown (empty error)';
  if (typeof err === 'string') return err;
  const code = err.code || err.errno || '';
  const msg = err.message || '';
  if (code && msg) return `${code}: ${msg}`;
  if (code) return code;
  if (msg) return msg;
  return String(err);
}

// ---------- source runner ----------
async function fetchSource(source) {
  try {
    let items;
    if (source.type === 'rss') {
      console.log(`[fetch] ${source.id} (rss) ${source.url}`);
      const xml = await fetchUrl(source.url, { timeout: 20000 });
      items = parseRss(xml).slice(0, MAX_ITEMS_PER_SOURCE);
      console.log(`[ok] ${source.id}: ${items.length} rss items`);
    } else {
      console.log(`[fetch] ${source.id} (html) ${source.url}`);
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
      enriched.push({
        id,
        sourceId: source.id,
        sourceName: source.name,
        originalTitle: r.title,
        title: r.title,
        originalSummary: stripHtml(r.content || r.description).slice(0, 400),
        summary: stripHtml(r.content || r.description).slice(0, 400),
        originalContent: stripHtml(r.content || r.description),
        content: stripHtml(r.content || r.description),
        image: r.image || '',
        link: r.link,
        pubDate: r.pubDate && !isNaN(new Date(r.pubDate)) ? new Date(r.pubDate).toISOString() : new Date().toISOString(),
        originalLang: source.lang,
        needsTranslation: source.lang !== 'fa',
      });
    }

    return { source, items: enriched, error: null };
  } catch (err) {
    const msg = describeError(err);
    console.error(`[err] ${source.id}: ${msg}`);
    return { source, items: [], error: msg };
  }
}

// ---------- archive ----------
function updateArchive(newItems) {
  let archive = { news: [] };
  if (fs.existsSync(archiveFile)) {
    try { archive = JSON.parse(fs.readFileSync(archiveFile, 'utf8')); }
    catch { archive = { news: [] }; }
  }
  if (!Array.isArray(archive.news)) archive.news = [];

  const existing = new Set(archive.news.map(n => n.id));
  const fresh = newItems.filter(n => !existing.has(n.id));

  archive.news = [...fresh, ...archive.news].slice(0, MAX_ARCHIVE);
  archive.lastUpdated = new Date().toISOString();
  archive.totalNews = archive.news.length;

  fs.writeFileSync(archiveFile, JSON.stringify(archive, null, 2));
  console.log(`[archive] added ${fresh.length}, total ${archive.news.length}`);
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

  // حذف تکراری بر اساس id
  const seen = new Set();
  const unique = allNews.filter(n => {
    if (!n.id || seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });

  // مرتب‌سازی جدیدترین‌ها اول
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