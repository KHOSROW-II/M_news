const https = require('https');
const fs = require('fs');
const path = require('path');

const outputDir = path.join(__dirname, '..', 'output');
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

function fetchUrl(url, retries = 2) {
    return new Promise((resolve, reject) => {
        const fetchWithRetry = (attempt) => {
            const urlObj = new URL(url);
            const options = {
                hostname: urlObj.hostname,
                path: urlObj.pathname + urlObj.search,
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)',
                    'Accept': 'text/html,application/xhtml+xml',
                    'Accept-Language': 'en-US,en;q=0.9'
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
        
        const patterns = [
            /<h[1-3][^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)<\/h[1-3]>/gi,
            /<a[^>]*class="[^"]*headline[^"]*"[^>]*>([^<]+)<\/a>/gi,
            /<div[^>]*class="[^"]*news-title[^"]*"[^>]*>([^<]+)<\/div>/gi
        ];
        
        let allMatches = [];
        for (const pattern of patterns) {
            const matches = [...html.matchAll(pattern)];
            allMatches.push(...matches);
        }
        
        const uniqueTitles = [...new Set(allMatches.map(m => m[1].trim()))];
        
        for (let i = 0; i < Math.min(8, uniqueTitles.length); i++) {
            let title = uniqueTitles[i]
                .replace(/<[^>]*>/g, '')
                .replace(/&[a-z]+;/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            
            if (title && title.length > 5 && title.length < 200) {
                news.push({
                    id: `c14-${Date.now()}-${i}`,
                    sourceId: 'c14',
                    sourceName: 'C14 (اسرائیل)',
                    originalTitle: title,
                    title: title,
                    originalSummary: title.substring(0, 150),
                    summary: title.substring(0, 150),
                    link: 'https://www.c14.co.il',
                    pubDate: new Date().toISOString(),
                    originalLang: 'he',  // عبری
                    translated: false,
                    needsTranslation: true
                });
            }
        }
        
        console.log(`✅ C14: ${news.length} news found`);
    } catch (err) {
        console.error(`❌ C14 error: ${err.message}`);
    }
    
    return news;
}

async function fetchIranIntl() {
    console.log('📡 Fetching from Iran International...');
    const news = [];
    
    try {
        const html = await fetchUrl('https://www.iranintl.com/fa/latest');
        
        const titleRegex = /<h[2-4][^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)<\/h[2-4]>/gi;
        const summaryRegex = /<p[^>]*class="[^"]*summary[^"]*"[^>]*>([^<]+)<\/p>/gi;
        
        const titles = [...html.matchAll(titleRegex)].map(m => m[1].trim());
        const summaries = [...html.matchAll(summaryRegex)].map(m => m[1].trim());
        
        for (let i = 0; i < Math.min(10, titles.length); i++) {
            const title = titles[i].replace(/<[^>]*>/g, '').trim();
            const summary = summaries[i]?.replace(/<[^>]*>/g, '').trim() || title;
            
            if (title && title.length > 3) {
                news.push({
                    id: `iran-${Date.now()}-${i}`,
                    sourceId: 'iranintl',
                    sourceName: 'ایران اینترنشنال',
                    originalTitle: title,
                    title: title,
                    originalSummary: summary.substring(0, 200),
                    summary: summary.substring(0, 200),
                    link: 'https://www.iranintl.com/fa/latest',
                    pubDate: new Date().toISOString(),
                    originalLang: 'fa',
                    translated: false,
                    needsTranslation: false
                });
            }
        }
        
        console.log(`✅ IranIntl: ${news.length} news found`);
    } catch (err) {
        console.error(`❌ IranIntl error: ${err.message}`);
    }
    
    return news;
}

async function fetchRezaPahlavi() {
    console.log('📡 Fetching from Reza Pahlavi...');
    const news = [];
    
    try {
        const html = await fetchUrl('https://rezapahlavi.org/en');
        
        const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
        const paragraphs = [...html.matchAll(/<p[^>]*>([^<]+)<\/p>/gi)];
        
        if (titleMatch) {
            const title = titleMatch[1].trim();
            const summary = paragraphs.length > 0 ? paragraphs[0][1].trim() : title;
            
            news.push({
                id: `reza-${Date.now()}-0`,
                sourceId: 'rezapahlavi',
                sourceName: 'رضا پهلوی',
                originalTitle: title,
                title: title,
                originalSummary: summary.substring(0, 250),
                summary: summary.substring(0, 250),
                link: 'https://rezapahlavi.org/en',
                pubDate: new Date().toISOString(),
                originalLang: 'en',
                translated: false,
                needsTranslation: true
            });
        }
        
        const h2Matches = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/gi)];
        for (let i = 0; i < Math.min(3, h2Matches.length); i++) {
            const title = h2Matches[i][1].trim();
            if (title && !title.includes('Event')) {
                news.push({
                    id: `reza-${Date.now()}-${i+1}`,
                    sourceId: 'rezapahlavi',
                    sourceName: 'رضا پهلوی',
                    originalTitle: title,
                    title: title,
                    originalSummary: title,
                    summary: title,
                    link: 'https://rezapahlavi.org/en',
                    pubDate: new Date().toISOString(),
                    originalLang: 'en',
                    translated: false,
                    needsTranslation: true
                });
            }
        }
        
        console.log(`✅ RezaPahlavi: ${news.length} news found`);
    } catch (err) {
        console.error(`❌ RezaPahlavi error: ${err.message}`);
    }
    
    return news;
}

async function main() {
    console.log('🚀 Starting news aggregation:', new Date().toISOString());
    
    const [c14News, iranNews, rezaNews] = await Promise.all([
        fetchC14(),
        fetchIranIntl(),
        fetchRezaPahlavi()
    ]);
    
    const allNews = [...c14News, ...iranNews, ...rezaNews];
    
    const output = {
        lastUpdated: new Date().toISOString(),
        totalNews: allNews.length,
        news: allNews,
        stats: {
            bySource: {
                c14: c14News.length,
                iranintl: iranNews.length,
                rezapahlavi: rezaNews.length
            },
            needsTranslation: allNews.filter(n => n.needsTranslation).length
        }
    };
    
    const tempPath = path.join(outputDir, 'news-data-temp.json');
    fs.writeFileSync(tempPath, JSON.stringify(output, null, 2));
    console.log(`💾 Temporary data saved: ${allNews.length} items`);
}

main().catch(console.error);
