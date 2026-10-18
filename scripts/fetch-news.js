const https = require('https');
const fs = require('fs');
const path = require('path');

const outputDir = path.join(__dirname, '..', 'output');
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

const tempFile = path.join(outputDir, 'news-data-temp.json');
const fallbackFile = path.join(outputDir, 'news-data.json');

function fetchUrl(url, retries = 2) {
    return new Promise((resolve, reject) => {
        const fetchWithRetry = (attempt) => {
            const urlObj = new URL(url);
            const options = {
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 15000
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        resolve(data);
                    } else if (attempt < retries) {
                        setTimeout(() => fetchWithRetry(attempt + 1), 2000);
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}`));
                    }
                });
            });

            req.on('error', (err) => {
                if (attempt < retries) {
                    setTimeout(() => fetchWithRetry(attempt + 1), 2000);
                } else {
                    reject(err);
                }
            });
            req.on('timeout', () => req.destroy());
            req.end();
        };

        fetchWithRetry(0);
    });
}

async function fetchC14() {
    console.log('📡 Fetching from C14...');
    const news = [];

    try {
        const html = await fetchUrl('https://www.c14.co.il');

        const titleMatches = html.match(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/gi) || [];
        const titles = [...new Set(titleMatches.map(m => m.replace(/<[^>]*>/g, '').trim()))];

        for (let i = 0; i < Math.min(5, titles.length); i++) {
            if (titles[i] && titles[i].length > 3) {
                news.push({
                    id: `c14-${Date.now()}-${i}`,
                    sourceId: 'c14',
                    sourceName: 'C14',
                    originalTitle: titles[i],
                    title: titles[i],
                    originalSummary: titles[i].substring(0, 150),
                    summary: titles[i].substring(0, 150),
                    link: 'https://www.c14.co.il',
                    pubDate: new Date().toISOString(),
                    originalLang: 'he',
                    needsTranslation: true
                });
            }
        }

        console.log(`✅ C14: ${news.length} news`);
        return { news, error: null };
    } catch (err) {
        console.error(`❌ C14 error: ${err.message}`);
        return { news: [], error: err.message };
    }
}

async function fetchIranIntl() {
    console.log('📡 Fetching from Iran International...');
    const news = [];

    try {
        const html = await fetchUrl('https://www.iranintl.com/fa/latest');

        const titleMatches = html.match(/<h[2-4][^>]*>([^<]+)<\/h[2-4]>/gi) || [];
        const titles = titleMatches.map(m => m.replace(/<[^>]*>/g, '').trim());

        for (let i = 0; i < Math.min(8, titles.length); i++) {
            if (titles[i] && titles[i].length > 3) {
                news.push({
                    id: `iran-${Date.now()}-${i}`,
                    sourceId: 'iranintl',
                    sourceName: 'ایران اینترنشنال',
                    originalTitle: titles[i],
                    title: titles[i],
                    originalSummary: titles[i].substring(0, 200),
                    summary: titles[i].substring(0, 200),
                    link: 'https://www.iranintl.com/fa/latest',
                    pubDate: new Date().toISOString(),
                    originalLang: 'fa',
                    needsTranslation: false
                });
            }
        }

        console.log(`✅ IranIntl: ${news.length} news`);
        return { news, error: null };
    } catch (err) {
        console.error(`❌ IranIntl error: ${err.message}`);
        return { news: [], error: err.message };
    }
}

async function fetchRezaPahlavi() {
    console.log('📡 Fetching from Reza Pahlavi...');
    const news = [];

    try {
        const html = await fetchUrl('https://rezapahlavi.org/en');

        const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
        const h2Matches = html.match(/<h2[^>]*>([^<]+)<\/h2>/gi) || [];

        if (titleMatch) {
            const title = titleMatch[1].trim();
            news.push({
                id: `reza-${Date.now()}-0`,
                sourceId: 'rezapahlavi',
                sourceName: 'رضا پهلوی',
                originalTitle: title,
                title,
                originalSummary: title.substring(0, 200),
                summary: title.substring(0, 200),
                link: 'https://rezapahlavi.org/en',
                pubDate: new Date().toISOString(),
                originalLang: 'en',
                needsTranslation: true
            });
        }

        for (let i = 0; i < Math.min(3, h2Matches.length); i++) {
            const title = h2Matches[i].replace(/<[^>]*>/g, '').trim();
            if (title && title.length > 3) {
                news.push({
                    id: `reza-${Date.now()}-${i + 1}`,
                    sourceId: 'rezapahlavi',
                    sourceName: 'رضا پهلوی',
                    originalTitle: title,
                    title,
                    originalSummary: title,
                    summary: title,
                    link: 'https://rezapahlavi.org/en',
                    pubDate: new Date().toISOString(),
                    originalLang: 'en',
                    needsTranslation: true
                });
            }
        }

        console.log(`✅ RezaPahlavi: ${news.length} news`);
        return { news, error: null };
    } catch (err) {
        console.error(`❌ RezaPahlavi error: ${err.message}`);
        return { news: [], error: err.message };
    }
}

async function main() {
    console.log('🚀 Starting news aggregation:', new Date().toISOString());

    const [c14, iran, reza] = await Promise.all([
        fetchC14(),
        fetchIranIntl(),
        fetchRezaPahlavi()
    ]);

    const allNews = [...c14.news, ...iran.news, ...reza.news];

    const failedSources = [];
    if (c14.error) failedSources.push({ source: 'c14', error: c14.error });
    if (iran.error) failedSources.push({ source: 'iranintl', error: iran.error });
    if (reza.error) failedSources.push({ source: 'rezapahlavi', error: reza.error });

    const output = {
        lastUpdated: new Date().toISOString(),
        totalNews: allNews.length,
        news: allNews,
        stats: {
            bySource: {
                c14: c14.news.length,
                iranintl: iran.news.length,
                rezapahlavi: reza.news.length
            },
            needsTranslation: allNews.filter(n => n.needsTranslation).length,
            failedSources
        }
    };

    // ۱) temp برای مرحلهٔ ترجمه
    fs.writeFileSync(tempFile, JSON.stringify(output, null, 2));

    // ۲) fallback خام — تضمین تولید news-data.json حتی اگر ترجمه کرش کنه
    const fallbackOutput = {
        ...output,
        translationStats: {
            totalTranslated: 0,
            totalFailed: allNews.filter(n => n.needsTranslation).length,
            engine: 'none',
            fallback: true
        }
    };
    fs.writeFileSync(fallbackFile, JSON.stringify(fallbackOutput, null, 2));

    console.log(`💾 Saved ${allNews.length} news items to temp + fallback`);
    if (failedSources.length > 0) {
        console.warn(`⚠️ Failed sources: ${failedSources.map(f => f.source).join(', ')}`);
    }
}

main().catch((err) => {
    console.error('❌ Fatal fetch error:', err);
    process.exit(1);
});