const https = require('https');
const fs = require('fs');
const path = require('path');

const outputDir = path.join(__dirname, '..', 'output');
const tempFile = path.join(outputDir, 'news-data-temp.json');
const outputFile = path.join(outputDir, 'news-data.json');

const TRANSLATE_API = 'https://translate.argosopentech.com';

// تابع ترجمه ساده
async function translateText(text, sourceLang) {
    if (!text || text.length < 2) return text;
    if (sourceLang === 'fa') return text;
    
    const truncatedText = text.length > 500 ? text.substring(0, 500) : text;
    
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
            port: 443,
            path: urlObj.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 20000
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
                        resolve(`[${sourceLang}] ${text}`);
                    }
                } catch (e) {
                    resolve(`[${sourceLang}] ${text}`);
                }
            });
        });
        
        req.on('error', () => resolve(`[${sourceLang}] ${text}`));
        req.on('timeout', () => {
            req.destroy();
            resolve(`[${sourceLang}] ${text}`);
        });
        
        req.write(postData);
        req.end();
    });
}

async function main() {
    console.log('🤖 Starting translation...');
    
    if (!fs.existsSync(tempFile)) {
        console.error('❌ Temp file not found!');
        // ایجاد فایل خالی برای جلوگیری از خطا
        const dummyData = { news: [], lastUpdated: new Date().toISOString() };
        fs.writeFileSync(outputFile, JSON.stringify(dummyData, null, 2));
        return;
    }
    
    const data = JSON.parse(fs.readFileSync(tempFile, 'utf8'));
    console.log(`📊 Loaded ${data.news.length} items`);
    
    // ترجمه اخبار
    let translatedCount = 0;
    for (const news of data.news) {
        if (news.needsTranslation && news.originalLang !== 'fa') {
            console.log(`🔄 Translating: ${news.originalTitle.substring(0, 40)}...`);
            
            news.title = await translateText(news.originalTitle, news.originalLang);
            news.summary = await translateText(news.originalSummary, news.originalLang);
            news.translated = true;
            news.translationNote = 'ترجمه شده با ماشین';
            
            translatedCount++;
            await new Promise(r => setTimeout(r, 1000)); // تأخیر 1 ثانیه
        } else {
            news.translated = false;
        }
    }
    
    const finalOutput = {
        ...data,
        lastUpdated: new Date().toISOString(),
        translationStats: {
            totalTranslated: translatedCount,
            engine: 'LibreTranslate'
        }
    };
    
    fs.writeFileSync(outputFile, JSON.stringify(finalOutput, null, 2));
    fs.unlinkSync(tempFile);
    
    console.log(`✅ Done! Translated ${translatedCount} items`);
}

main().catch(console.error);
