const https = require('https');
const fs = require('fs');
const path = require('path');

const outputDir = path.join(__dirname, '..', 'output');
const tempFile = path.join(outputDir, 'news-data-temp.json');
const outputFile = path.join(outputDir, 'news-data.json');

const TRANSLATE_API = process.env.TRANSLATE_API_URL || 'https://translate.argosopentech.com';
const CONCURRENCY = parseInt(process.env.TRANSLATE_CONCURRENCY) || 2;

async function translateText(text, sourceLang, targetLang = 'fa') {
    if (!text || text.length < 2) return text;
    if (sourceLang === 'fa') return text;
    
    const truncatedText = text.length > 500 ? text.substring(0, 500) + '...' : text;
    
    return new Promise((resolve) => {
        const postData = JSON.stringify({
            q: truncatedText,
            source: sourceLang,
            target: targetLang,
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
            timeout: 30000
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.translatedText) {
                        resolve(json.translatedText);
                    } else {
                        console.warn(`⚠️ Translation failed for: ${text.substring(0, 50)}`);
                        resolve(`[${sourceLang}] ${text}`);
                    }
                } catch (e) {
                    console.warn(`⚠️ Translation parse error: ${e.message}`);
                    resolve(`[${sourceLang}] ${text}`);
                }
            });
        });
        
        req.on('error', (err) => {
            console.warn(`⚠️ Translation network error: ${err.message}`);
            resolve(`[${sourceLang}] ${text}`);
        });
        req.on('timeout', () => {
            req.destroy();
            resolve(`[${sourceLang}] ${text}`);
        });
        
        req.write(postData);
        req.end();
    });
}

async function translateBatch(items, batchSize = CONCURRENCY) {
    const results = [];
    const queue = [...items];
    
    async function worker() {
        while (queue.length > 0) {
            const item = queue.shift();
            if (item && item.needsTranslation && item.originalLang !== 'fa') {
                console.log(`🔄 Translating: "${item.originalTitle.substring(0, 40)}..." (${item.originalLang} → fa)`);
                
                const [translatedTitle, translatedSummary] = await Promise.all([
                    translateText(item.originalTitle, item.originalLang),
                    translateText(item.originalSummary, item.originalLang)
                ]);
                
                item.title = translatedTitle;
                item.summary = translatedSummary;
                item.translated = true;
                item.translationNote = 'ترجمه شده با ماشین (LibreTranslate)';
                
                await new Promise(r => setTimeout(r, 500));
            }
            results.push(item);
        }
    }
    
    const workers = Array(Math.min(batchSize, queue.length)).fill().map(() => worker());
    await Promise.all(workers);
    
    return results;
}

async function main() {
    console.log('🤖 Starting translation service...');
    
    if (!fs.existsSync(tempFile)) {
        console.error('❌ Temp file not found. Run fetch-news.js first.');
        process.exit(1);
    }
    
    const data = JSON.parse(fs.readFileSync(tempFile, 'utf8'));
    console.log(`📊 Loaded ${data.news.length} items, ${data.stats.needsTranslation} need translation`);
    
    const translatedNews = await translateBatch(data.news);
    
    const finalOutput = {
        ...data,
        lastUpdated: new Date().toISOString(),
        news: translatedNews,
        translationStats: {
            totalTranslated: translatedNews.filter(n => n.translated).length,
            engine: 'LibreTranslate (Open Source)',
            note: 'اخبار غیرفارسی با استفاده از ترجمه ماشینی به فارسی برگردانده شده‌اند'
        }
    };
    
    fs.writeFileSync(outputFile, JSON.stringify(finalOutput, null, 2));
    console.log(`✅ Translation complete! Saved to ${outputFile}`);
    console.log(`📈 Stats: ${finalOutput.translationStats.totalTranslated} items translated`);
    
    fs.unlinkSync(tempFile);
}

main().catch(console.error);
