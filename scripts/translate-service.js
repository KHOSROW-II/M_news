const https = require('https');
const fs = require('fs');
const path = require('path');

const outputDir = path.join(__dirname, '..', 'output');
const tempFile = path.join(outputDir, 'news-data-temp.json');
const outputFile = path.join(outputDir, 'news-data.json');

const TRANSLATE_API = (process.env.TRANSLATE_API_URL || 'https://translate.argosopentech.com').replace(/\/+$/, '');
const TRANSLATE_CONCURRENCY = Math.max(1, parseInt(process.env.TRANSLATE_CONCURRENCY || '2', 10));
const REQUEST_TIMEOUT = 20000;
const MAX_TEXT_LENGTH = 500;
const DELAY_BETWEEN_CALLS = 250;

async function translateText(text, sourceLang) {
    if (!text || text.length < 2) return { ok: true, text };
    if (sourceLang === 'fa') return { ok: true, text };

    const truncatedText = text.length > MAX_TEXT_LENGTH ? text.substring(0, MAX_TEXT_LENGTH) : text;

    return new Promise((resolve) => {
        const postData = JSON.stringify({
            q: truncatedText,
            source: sourceLang,
            target: 'fa',
            format: 'text'
        });

        const urlObj = new URL(TRANSLATE_API + '/translate');
        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || 443,
            path: urlObj.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: REQUEST_TIMEOUT
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.translatedText && typeof json.translatedText === 'string') {
                        resolve({ ok: true, text: json.translatedText });
                    } else {
                        resolve({ ok: false, text, error: 'no translatedText in response' });
                    }
                } catch (e) {
                    resolve({ ok: false, text, error: 'invalid JSON response' });
                }
            });
        });

        req.on('error', (err) => resolve({ ok: false, text, error: err.message }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ ok: false, text, error: 'timeout' });
        });

        req.write(postData);
        req.end();
    });
}

async function translateNewsItem(news) {
    if (!news.needsTranslation || news.originalLang === 'fa') {
        news.translated = false;
        return;
    }

    const titleResult = await translateText(news.originalTitle, news.originalLang);
    await new Promise(r => setTimeout(r, DELAY_BETWEEN_CALLS));
    const summaryResult = await translateText(news.originalSummary, news.originalLang);

    news.title = titleResult.ok ? titleResult.text : news.originalTitle;
    news.summary = summaryResult.ok ? summaryResult.text : news.originalSummary;

    const allOk = titleResult.ok && summaryResult.ok;
    news.translated = allOk;
    news.translationError = !allOk;

    if (allOk) {
        news.translationNote = 'ترجمه شده با ماشین';
    } else {
        news.translationNote = 'ترجمه ناموفق — متن اصلی نمایش داده می‌شود';
        const errs = [];
        if (!titleResult.ok) errs.push(`title: ${titleResult.error}`);
        if (!summaryResult.ok) errs.push(`summary: ${summaryResult.error}`);
        news.translationErrorDetail = errs.join(' | ');
    }
}

async function mapWithConcurrency(items, fn, concurrency) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (true) {
            const i = nextIndex++;
            if (i >= items.length) return;
            try {
                results[i] = await fn(items[i], i);
            } catch (err) {
                results[i] = { error: err.message };
            }
        }
    }

    const workers = Array.from(
        { length: Math.min(concurrency, items.length) },
        () => worker()
    );
    await Promise.all(workers);
    return results;
}

function writeEmptyOutput(reason) {
    const dummy = {
        lastUpdated: new Date().toISOString(),
        totalNews: 0,
        news: [],
        stats: {},
        translationStats: { totalTranslated: 0, totalFailed: 0, engine: 'none', fallback: true, error: reason }
    };
    fs.writeFileSync(outputFile, JSON.stringify(dummy, null, 2));
}

async function main() {
    console.log('🤖 Starting translation...');
    console.log(`   API: ${TRANSLATE_API}`);
    console.log(`   Concurrency: ${TRANSLATE_CONCURRENCY}`);

    let data = null;
    let source = 'none';

    try {
        if (fs.existsSync(tempFile)) {
            data = JSON.parse(fs.readFileSync(tempFile, 'utf8'));
            source = 'temp';
        } else if (fs.existsSync(outputFile)) {
            data = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
            source = 'existing output (re-translate)';
        }
    } catch (err) {
        console.error(`❌ Failed to read input: ${err.message}`);
        data = null;
    }

    if (!data || !Array.isArray(data.news)) {
        console.error('❌ No valid news data found');
        writeEmptyOutput('no input data');
        return;
    }

    console.log(`📊 Loaded ${data.news.length} items from ${source}`);

    const needsTranslationCount = data.news.filter(
        n => n.needsTranslation && n.originalLang !== 'fa'
    ).length;
    console.log(`🔄 ${needsTranslationCount} items need translation`);

    let translatedCount = 0;
    await mapWithConcurrency(
        data.news,
        async (item) => {
            await translateNewsItem(item);
            if (item.translated) translatedCount++;
        },
        TRANSLATE_CONCURRENCY
    );

    const failedCount = data.news.filter(n => n.translationError === true).length;

    const finalOutput = {
        ...data,
        lastUpdated: new Date().toISOString(),
        translationStats: {
            totalTranslated: translatedCount,
            totalFailed: failedCount,
            engine: 'LibreTranslate',
            apiUrl: TRANSLATE_API,
            concurrency: TRANSLATE_CONCURRENCY
        }
    };

    fs.writeFileSync(outputFile, JSON.stringify(finalOutput, null, 2));

    if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
    }

    console.log(`✅ Done! Translated ${translatedCount}, failed ${failedCount}`);
}

main().catch((err) => {
    console.error('❌ Translation step crashed:', err);
    // اگر خروجی وجود نداشت، از temp fallback بساز
    try {
        if (!fs.existsSync(outputFile) && fs.existsSync(tempFile)) {
            const data = JSON.parse(fs.readFileSync(tempFile, 'utf8'));
            data.translationStats = { totalTranslated: 0, engine: 'none', fallback: true, error: err.message };
            fs.writeFileSync(outputFile, JSON.stringify(data, null, 2));
            console.log('🛟 Fallback news-data.json written from temp');
        }
    } catch (e) {
        console.error('❌ Failed to write fallback:', e);
        writeEmptyOutput('crash + fallback failed');
    }
    // continue-on-error در workflow، پس exit code مهم نیست؛ ولی 0 صادقانه‌تره چون handle شده
    process.exit(0);
});