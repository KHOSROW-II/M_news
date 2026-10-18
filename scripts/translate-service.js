const https = require('https');
const fs = require('fs');
const path = require('path');

const outputDir = path.join(__dirname, '..', 'output');
const tempFile = path.join(outputDir, 'news-data-temp.json');
const outputFile = path.join(outputDir, 'news-data.json');

const TRANSLATE_API = (process.env.TRANSLATE_API_URL || 'https://translate.argosopentech.com').replace(/\/+$/, '');
const CONCURRENCY = Math.max(1, parseInt(process.env.TRANSLATE_CONCURRENCY || '2', 10));
const MAX_LEN = 450;
const TIMEOUT = 15000;

function requestJson(url, method = 'GET', body = null) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const lib = urlObj.protocol === 'https:' ? https : require('http');
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
        try { resolve({ ok: true, json: JSON.parse(raw) }); }
        catch { resolve({ ok: false, error: 'invalid json' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    if (data) req.write(data);
    req.end();
  });
}

async function tryLibre(text, source) {
  if (!TRANSLATE_API) return { ok: false };
  const res = await requestJson(TRANSLATE_API + '/translate', 'POST', {
    q: text, source, target: 'fa', format: 'text',
  });
  if (res.ok && res.json?.translatedText && typeof res.json.translatedText === 'string') {
    return { ok: true, text: res.json.translatedText, engine: 'libre' };
  }
  return { ok: false };
}

async function tryMyMemory(text, source) {
  const lang = source === 'he' ? 'he' : source;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${lang}|fa`;
  const res = await requestJson(url);
  const t = res.ok && res.json?.responseData?.translatedText;
  if (t && typeof t === 'string' && !/MYMEMORY WARNING/i.test(t)) {
    return { ok: true, text: t, engine: 'mymemory' };
  }
  return { ok: false };
}

async function tryGoogle(text, source) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source}&tl=fa&dt=t&q=${encodeURIComponent(text)}`;
  const res = await requestJson(url);
  if (res.ok && Array.isArray(res.json) && Array.isArray(res.json[0])) {
    const t = res.json[0].map(x => x?.[0] || '').join('');
    if (t) return { ok: true, text: t, engine: 'google' };
  }
  return { ok: false };
}

async function translateChunk(text, source) {
  if (!text) return { ok: true, text: '' };
  if (source === 'fa') return { ok: true, text };
  const truncated = text.length > MAX_LEN ? text.slice(0, MAX_LEN) : text;
  for (const fn of [tryLibre, tryMyMemory, tryGoogle]) {
    try {
      const r = await fn(truncated, source);
      if (r.ok) return r;
    } catch (e) { /* continue */ }
  }
  return { ok: false, text, error: 'all engines failed' };
}

async function translateLong(text, source) {
  if (!text) return { ok: true, text: '' };
  if (source === 'fa') return { ok: true, text };
  if (text.length <= MAX_LEN) return translateChunk(text, source);

  // split into sentences/lines, translate each, join
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
  for (const c of chunks.slice(0, 6)) { // cap per article
    const r = await translateChunk(c, source);
    if (r.ok) anyOk = true;
    out.push(r.ok ? r.text : c);
  }
  if (!anyOk) return { ok: false, text, error: 'all engines failed' };
  return { ok: true, text: out.join(' ') };
}

async function translateItem(item) {
  if (!item.needsTranslation || item.originalLang === 'fa') {
    item.translated = false;
    return;
  }

  const titleRes = await translateLong(item.originalTitle || '', item.originalLang);
  const contentChunk = (item.originalContent || item.originalSummary || '').slice(0, 1500);
  const contentRes = await translateLong(contentChunk, item.originalLang);

  item.title = titleRes.ok ? titleRes.text : item.originalTitle;
  item.content = contentRes.ok ? contentRes.text : (item.originalContent || contentChunk);
  item.summary = (contentRes.ok ? contentRes.text : (item.originalSummary || contentChunk)).slice(0, 280);

  item.translated = titleRes.ok && contentRes.ok;
  item.translationError = !item.translated;
  item.translationNote = item.translated ? 'ترجمه ماشینی' : 'ترجمه ناموفق - متن اصلی';
}

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

function writeEmpty(reason) {
  fs.writeFileSync(outputFile, JSON.stringify({
    lastUpdated: new Date().toISOString(),
    totalNews: 0, news: [], stats: {},
    translationStats: { totalTranslated: 0, totalFailed: 0, engine: 'none', fallback: true, error: reason },
  }, null, 2));
}

async function main() {
  console.log('[start] translate');
  let data = null;
  try {
    if (fs.existsSync(tempFile)) data = JSON.parse(fs.readFileSync(tempFile, 'utf8'));
    else if (fs.existsSync(outputFile)) data = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  } catch (err) { console.error('[err] read:', err.message); }

  if (!data || !Array.isArray(data.news)) {
    console.error('[err] no input');
    writeEmpty('no input');
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
      engine: 'libre+mymemory+google',
      concurrency: CONCURRENCY,
    },
  }, null, 2));

  if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  console.log(`[done] translated=${translated} failed=${failed}`);
}

main().catch(err => {
  console.error('[fatal]', err);
  try {
    if (!fs.existsSync(outputFile) && fs.existsSync(tempFile)) {
      const d = JSON.parse(fs.readFileSync(tempFile, 'utf8'));
      d.translationStats = { totalTranslated: 0, engine: 'none', fallback: true, error: err.message };
      fs.writeFileSync(outputFile, JSON.stringify(d, null, 2));
    }
  } catch (e) { writeEmpty('crash'); }
  process.exit(0);
});