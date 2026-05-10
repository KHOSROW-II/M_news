let allNews = [];
let currentSource = 'all';
let currentSearch = '';

async function loadNews() {
    try {
        const response = await fetch('output/news-data.json?t=' + Date.now());
        if (!response.ok) throw new Error('فایل پیدا نشد');
        const data = await response.json();
        allNews = data.news;
        
        displayStats(data);
        renderFilters();
        renderNews();
        
        document.getElementById('status').innerHTML = `
            ✅ آخرین بروزرسانی: ${new Date(data.lastUpdated).toLocaleString('fa-IR')}
            | 📊 ${data.translationStats.totalTranslated} خبر ترجمه شده
        `;
    } catch (error) {
        document.getElementById('newsContainer').innerHTML = `
            <div class="loading" style="color:red;">
                ❌ خطا در بارگذاری اخبار<br>
                <small>لطفاً فایل output/news-data.json را بررسی کنید</small>
            </div>
        `;
    }
}

function renderFilters() {
    const sources = {};
    allNews.forEach(news => {
        sources[news.sourceId] = news.sourceName;
    });
    
    const filtersDiv = document.getElementById('filters');
    filtersDiv.innerHTML = `
        <button class="filter-btn ${currentSource === 'all' ? 'active' : ''}" data-source="all">📰 همه</button>
        ${Object.entries(sources).map(([id, name]) => `
            <button class="filter-btn ${currentSource === id ? 'active' : ''}" data-source="${id}">${name}</button>
        `).join('')}
    `;
    
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            currentSource = btn.dataset.source;
            renderFilters();
            renderNews();
        });
    });
}

function renderNews() {
    let filtered = allNews.filter(news => {
        if (currentSource !== 'all' && news.sourceId !== currentSource) return false;
        if (currentSearch && !news.title.includes(currentSearch) && !news.summary.includes(currentSearch)) return false;
        return true;
    });
    
    const container = document.getElementById('newsContainer');
    
    if (filtered.length === 0) {
        container.innerHTML = '<div class="loading">📭 خبری یافت نشد</div>';
        return;
    }
    
    container.innerHTML = filtered.map(news => `
        <div class="news-card" onclick="window.open('${news.link}', '_blank')">
            <div class="card-header">
                <span class="source">${news.sourceName}</span>
                ${news.translated ? '<span class="translated-badge">🌐 ترجمه ماشینی</span>' : ''}
            </div>
            <h3 class="news-title">${escapeHtml(news.title)}</h3>
            <p class="news-summary">${escapeHtml(news.summary)}</p>
            <div class="news-footer">
                <span>🕒 ${new Date(news.pubDate).toLocaleTimeString('fa-IR')}</span>
                <span>🔗 کلیک برای مشاهده منبع</span>
            </div>
            ${news.translated ? `<div class="translation-note">⚠️ این خبر از زبان ${news.originalLang} ترجمه شده است</div>` : ''}
        </div>
    `).join('');
}

function displayStats(data) {
    console.log('📊 Statistics:', data.stats);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

document.getElementById('search').addEventListener('input', (e) => {
    currentSearch = e.target.value;
    renderNews();
});

loadNews();
setInterval(() => loadNews(), 60000);
