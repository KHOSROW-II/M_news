const fs = require('fs');
const https = require('https');

function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 15000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ ok: res.statusCode === 200, data, status: res.statusCode }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

async function parseC14() {
    try {
        const response = await fetchUrl('https://www.c14.co.il');
        if (!response.ok) return [];
        const html = response.data;
        const headlines = [];
        const titleMatches = html.match(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/gi) || [];
        for (let i = 0; i < Math.min(5, titleMatches.length); i++) {
            let title = titleMatches[i].replace(/<[^>]*>/g, '').trim();
            if (title) {
                headlines.push({
                    id: `c14-${Date.now()}-${i}`,
                    sourceId: 'c14',
                    sourceName: 'C14',
                    title: title.substring(0, 120),
                    summary: title,
                    content: title,
                    link: 'https://www.c14.co.il',
                    pubDate: new Date().toISOString(),
                    translated: true,
                    originalLang: 'he'
                });
            }
        }
        return headlines;
    } catch(e) { return []; }
}

async function parseIranIntl() {
    try {
        const response = await fetchUrl('https://www.iranintl.com/fa/latest');
        if (!response.ok) return [];
        const html = response.data;
        const news = [];
        const articleMatches = html.match(/<article[^>]*>[\s\S]*?<\/article>/gi) || [];
        for (let i = 0; i < Math.min(6, articleMatches.length); i++) {
            let titleMatch = articleMatches[i].match(/<h[2-4][^>]*>([^<]+)<\/h/);
            let title = titleMatch ? titleMatch[1].trim() : '';
            if (title) {
                news.push({
                    id: `iran-${Date.now()}-${i}`,
                    sourceId: 'iranintl',
                    sourceName: 'ایران اینترنشنال',
                    title: title,
                    summary: title,
                    content: title,
                    link: 'https://www.iranintl.com/fa/latest',
                    pubDate: new Date().toISOString(),
                    translated: false
                });
            }
        }
        return news;
    } catch(e) { return []; }
}

async function parseRezaPahlavi() {
    try {
        const response = await fetchUrl('https://rezapahlavi.org/en');
        if (!response.ok) return [];
        const html = response.data;
        const items = [];
        let titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
        let title = titleMatch ? titleMatch[1].trim() : 'بیانیه جدید رضا پهلوی';
        let contentMatch = html.match(/<p>([^<]+)<\/p>/i);
        let summary = contentMatch ? contentMatch[1].trim() : 'متن خبر در سایت اصلی موجود است';
        
        items.push({
            id: `reza-${Date.now()}`,
            sourceId: 'rezapahlavi',
            sourceName: 'رضا پهلوی',
            title: title,
            summary: summary.substring(0, 200),
            content: summary,
            link: 'https://rezapahlavi.org/en',
            pubDate: new Date().toISOString(),
            translated: true,
            originalLang: 'en'
        });
        return items;
    } catch(e) { return []; }
}

function mockTranslate(text, fromLang) {
    if (!text || fromLang === 'fa') return text;
    return `[ترجمه ماشینی از ${fromLang}]: ${text.substring(0, 100)}...`;
}

async function main() {
    console.log('Fetching news...');
    const [c14News, iranNews, rezaNews] = await Promise.all([
        parseC14(),
        parseIranIntl(),
        parseRezaPahlavi()
    ]);
    
    let allNews = [...c14News, ...iranNews, ...rezaNews];
    
    allNews = allNews.map(news => {
        if (news.translated && news.originalLang) {
            news.title = mockTranslate(news.title, news.originalLang);
            news.summary = mockTranslate(news.summary, news.originalLang);
            news.content = mockTranslate(news.content, news.originalLang);
        }
        return news;
    });
    
    const output = { lastUpdated: new Date().toISOString(), news: allNews };
    fs.writeFileSync('news-data.json', JSON.stringify(output, null, 2));
    console.log(`Saved ${allNews.length} news items.`);
}

main().catch(console.error);
