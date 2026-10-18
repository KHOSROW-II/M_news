const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const outputDir = path.join(__dirname, '..', 'output');
const tempFile = path.join(outputDir, 'news-data-temp.json');
const outputFile = path.join(outputDir, 'news-data.json');

const GOOGLE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || '';
const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';
const GOOGLE_FREE_URL = 'https://translate.googleapis.com/translate_a/single';
const CONCURRENCY = Math.max(1, parseInt(process.env.TRANSLATE_CONCURRENCY || '2', 10));
const MAX_LEN = 450;
const TIMEOUT = 15000;

// ---------- http helper ----------
function request(url, method = 'GET', body = null) {
  return new Promise((resolve) => {
    let urlObj;
    try { urlObj = new URL(url); }
    catch { return resolve({ ok: false, error: 'invalid url' }); }

    const lib = urlObj.protocol === 'https:' ? https : http;
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;

    const req = lib.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      timeout: TIMEOUT,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ ok: true, json: JSON.parse(raw), raw }); }
        catch { resolve({ ok: false, error: 'invalid json', raw }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    if (data) req.write(data);
    req.end();
  });
}

// ---------- engines ----------
async function tryGoogleCloud(text, src) {
  if (!GOOGLE_API_KEY) return { ok: false, error: 'no api key' };
  const url = `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_API_KEY}`;
  const res = await request(url, 'POST', { q: text, source: src, target: 'fa', format: 'text' });
  const t = res.ok && res.json?.data?.translations?.[0]?.translatedText;
  if (t) return { ok: true, text: t, engine: 'google-cloud' };
  return { ok: false, error: 'google-cloud failed' };
}

async function tryGoogleFree(text, src) {
  const url = `${GOOGLE_FREE_URL}?client=gtx&sl=${src}&tl=fa&dt=t&q=${encodeURIComponent(text)}`;
  const res = await request(url);
  if (res.ok && Array.isArray(res.json) && Array.isArray(res.json[0])) {
    const t = res.json[0].map(x => x?.[0] || '').join('');
    if (t) return { ok: true, text: t, engine: 'google-free' };
  }
  return { ok: false, error: 'google-free failed' };
}

async function tryMyMemory(text, src) {
  const lang = src === 'he' ? 'he' : src;
  const url = `${MYMEMORY_URL}?q=${encodeURIComponent(text)}&langpair=${lang}|fa`;
  const res = await request(url);
  const t = res.ok && res.json?.responseData?.translatedText;
  if (t && typeof t === 'string' && !/MYMEMORY WARNING/i.test(t) && !/QUERY LENGTH LIMIT/i.test(t)) {
    return { ok: true, text: t, engine: 'mymemory' };
  }
  return { ok: false, error: 'mymemory failed' };
}

// ترتیب: Google Cloud (اگه کلید هست) → Google Free → MyMemory
async function translateChunk(text, src) {
  if (!text || src === 'fa') return { ok: true, text };
  const t = text.length > MAX_LEN ? text.slice(0, MAX_LEN) : text;

  const engines = [];
  if (GOOGLE_API_KEY) engines.push(tryGoogleCloud);
  engines.push(tryGoogleFree);
  engines.push(tryMyMemory);

  for (const fn of engines) {
    try {
      const r = await fn(t, src);
      if (r.ok) return r;
    } catch (e) { /* continue */ }
  }
  return { ok: false, text, error: 'all engines failed' };
}

// متن بلند رو به جمله‌های کوتاه بشکن
async function translateLong(text, src) {
  if (!text) return { ok: true, text: '' };
  if (src === 'fa') return { ok: true, text };
  if (text.length <= MAX_LEN) return translateChunk(text, src);

  const parts = text.match(/[^.!?\n]+[.!?\n]?/g) || [text];
  const chunks = [];
  let buf = '';
  for (const p of parts) {
    if ((buf + p).length > MAX_LEN) {
      if (buf) chunks.push(buf);
      buf = p;
    } else buf += p;
  }
  if (buf) chunks.push(buf);

  const out = [];
  let anyOk = false;
  let engine = 'none';
  for (const c of chunks.slice(0, 8)) {
    const r = await translateChunk(c, src);
    if (r.ok) { anyOk = true; engine = r.engine || engine; }
    out.push(r.ok ? r.text : c);
  }
  if (!anyOk) return { ok: false, text, error: 'all engines failed' };
  return { ok: true, text: out.join(' '), engine };
}

// ---------- item ----------
async function translateItem(item) {
  if (!item.needsTranslation || item.originalLang === 'fa') {
    item.translated = false;
    return;
  }

  const t = await translateLong(item.originalTitle || '', item.originalLang);
  const c = await translateLong((item.originalContent || '').slice(0, 1500), item.originalLang);

  item.title = t.ok ? t.text : item.originalTitle;
  item.content = c.ok ? c.text : (item.originalContent || '');
  item.summary = (c.ok ? c.text : (item.originalContent || '')).slice(0, 280);

  const ok = t.ok && c.ok;
  item.translated = ok;
  item.translationError = !ok;
  item.translationNote = ok ? 'ترجمه ماشینی' : 'ترجمه ناموفق';
  if (ok) item.translationEngine = c.engine || t.engine;
}

// ---------- concurrency ----------
async function mapLimit(items, limit, fn) {
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---------- main ----------
async function main() {
  console.log('[start] translate');
  console.log(`[info] google-cloud: ${GOOGLE_API_KEY ? 'yes' : 'no'}`);

  let data = null;
  try {
    if (fs.existsSync(tempFile)) data = JSON.parse(fs.readFileSync(tempFile, 'utf8'));
    else if (fs.existsSync(outputFile)) data = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  } catch (e) { console.error('[err] read:', e.message); }

  if (!data || !Array.isArray(data.news)) {
    console.error('[err] no input');
    fs.writeFileSync(outputFile, JSON.stringify({
      lastUpdated: new Date().toISOString(),
      totalNews: 0, news: [], stats: {},
      translationStats: { totalTranslated: 0, totalFailed: 0, engine: 'none', error: 'no input' },
    }, null, 2));
    return;
  }

  console.log(`[load] ${data.news.length} items`);

  let translated = 0;
  await mapLimit(data.news, CONCURRENCY, async (item) => {
    await translateItem(item);
    if (item.translated) translated++;
  });

  const failed = data.news.filter(n => n.translationError === true).length;

  fs.writeFileSync(outputFile, JSON.stringify({
    ...data,
    lastUpdated: new Date().toISOString(),
    translationStats: {
      totalTranslated: translated,
      totalFailed: failed,
      engine: GOOGLE_API_KEY ? 'google-cloud+google-free+mymemory' : 'google-free+mymemory',
      concurrency: CONCURRENCY,
    },
  }, null, 2));

  if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  console.log(`[done] translated=${translated} failed=${failed}`);
}

main().catch(err => {
  console.error('[fatal]', err);
  process.exit(0);
});