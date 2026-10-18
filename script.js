let allNews = [];
let currentSource = 'all';
let currentSearch = '';

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function loadNews() {
    try {
        const response = await fetch('output/news-data.json?t=' + Date.now());
        if (!response.ok) throw new Error('فایل پیدا نشد');
        const data = await response.json();

        allNews = Array.isArray(data.news) ? data.news : [];

        displayStats(data);
        renderFilters();
        renderNews();

        const totalTranslated = data.translationStats?.totalTranslated ?? 0;
        const totalFailed = data.translationStats?.totalFailed ?? 0;
        const lastUpdated = data.lastUpdated
            ? new Date(data.lastUpdated).toLocaleString('fa-IR')
            : 'نامشخص';

        let statusHtml = `✅ آخرین بروزرسانی: ${lastUpdated} | 📊 ${totalTranslated} خبر ترجمه شده`;
        if (totalFailed > 0) {
            statusHtml += ` | ⚠️ ${totalFailed} ترجمهٔ ناموفق`;
        }
        if (data.translationStats?.fallback) {
            statusHtml += ' | 🛟 حالت fallback (بدون ترجمه)';
        }
        document.getElementById('status').innerHTML = statusHtml;
    } catch (error) {
        console.error('Load error:', error);
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
        if (news?.sourceId && news?.sourceName) {
            sources[news.sourceId] = news.sourceName;
        }
    });

    const filtersDiv = document.getElementById('filters');
    filtersDiv.innerHTML = `
        <button class="filter-btn ${currentSource === 'all' ? 'active' : ''}" data-source="all">📰 همه</button>
        ${Object.entries(sources).map(([id, name]) => `
            <button class="filter-btn ${currentSource === id ? 'active' : ''}" data-source="${escapeHtml(id)}">${escapeHtml(name)}</button>
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
        if (!news) return false;
        if (currentSource !== 'all' && news.sourceId !== currentSource) return false;
        if (currentSearch) {
            const haystack = `${news.title || ''} ${news.summary || ''} ${news.originalTitle || ''}`;
            if (!haystack.includes(currentSearch)) return false;
        }
        return true;
    });

    const container = document.getElementById('newsContainer');

    if (filtered.length === 0) {
        container.innerHTML = '<div class="loading">📭 خبری یافت نشد</div>';
        return;
    }

    container.innerHTML = filtered.map(news => {
        const timeStr = news.pubDate
            ? new Date(news.pubDate).toLocaleTimeString('fa-IR')
            : '—';

        const translatedBadge = news.translated
            ? '<span class="translated-badge">🌐 ترجمه ماشینی</span>'
            : '';
        const errorBadge = news.translationError
            ? '<span class="failed-badge">⚠️ ترجمه ناموفق</span>'
            : '';
        const translationNote = news.translated
            ? `<div class="translation-note">⚠️ این خبر از زبان ${escapeHtml(news.originalLang || '?')} ترجمه شده است</div>`
            : (news.translationError
                ? `<div class="translation-note" style="color:#e53935;">⚠️ ترجمه انجام نشد — متن اصلی نمایش داده می‌شود</div>`
                : '');

        return `
            <div class="news-card" data-link="${escapeHtml(news.link || '')}">
                <div class="card-header">
                    <span class="source">${escapeHtml(news.sourceName || 'منبع')}</span>
                    <div style="display:flex; gap:6px;">${translatedBadge}${errorBadge}</div>
                </div>
                <h3 class="news-title">${escapeHtml(news.title || '')}</h3>
                <p class="news-summary">${escapeHtml(news.summary || '')}</p>
                <div class="news-footer">
                    <span>🕒 ${timeStr}</span>
                    <span>${news.link ? '🔗 کلیک برای مشاهده منبع' : 'بدون لینک'}</span>
                </div>
                ${translationNote}
            </div>
        `;
    }).join('');

    // event listener به‌جای onclick inline
    container.querySelectorAll('.news-card').forEach(card => {
        const link = card.dataset.link;
        if (link) {
            card.addEventListener('click', () => {
                window.open(link, '_blank', 'noopener,noreferrer');
            });
        }
    });
}

function displayStats(data) {
    console.log('📊 Statistics:', data.stats);
}

const searchInput = document.getElementById('search');
if (searchInput) {
    searchInput.addEventListener('input', (e) => {
        currentSearch = e.target.value;
        renderNews();
    });
}

loadNews();
setInterval(() => loadNews(), 60000);