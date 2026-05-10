let allNews = [];
let currentFilter = 'all';
let currentSearch = '';

async function loadNews() {
    try {
        const response = await fetch('news-data.json?t=' + Date.now());
        if (!response.ok) throw new Error('Failed to load');
        const data = await response.json();
        allNews = data.news || [];
        updateStats();
        renderNews();
        renderSourceFilters();
    } catch (error) {
        console.error('Error loading news:', error);
        document.getElementById('newsGrid').innerHTML = '<div style="text-align:center;padding:60px;">⚠️ خطا در بارگذاری اخبار<br><small>لطفاً دوباره تلاش کنید</small></div>';
    }
    
    try {
        const commits = await fetch('https://api.github.com/repos/' + (window.location.pathname.split('/')[1] || '') + '/' + (window.location.pathname.split('/')[2] || '') + '/commits?path=news-data.json&per_page=1');
        if (commits.ok) {
            const data = await commits.json();
            if (data[0]?.commit?.committer?.date) {
                const date = new Date(data[0].commit.committer.date);
                document.getElementById('lastFetchTime').innerText = date.toLocaleString('fa-IR');
            }
        }
    } catch(e) {}
}

function renderNews() {
    const grid = document.getElementById('newsGrid');
    let filtered = [...allNews];
    
    if (currentFilter !== 'all') {
        filtered = filtered.filter(n => n.sourceId === currentFilter);
    }
    
    if (currentSearch.trim()) {
        const searchLower = currentSearch.toLowerCase();
        filtered = filtered.filter(n => 
            n.title?.toLowerCase().includes(searchLower) || 
            n.summary?.toLowerCase().includes(searchLower)
        );
    }
    
    if (filtered.length === 0) {
        grid.innerHTML = '<div style="text-align:center;padding:60px;">📭 خبری یافت نشد</div>';
        return;
    }
    
    grid.innerHTML = filtered.map(news => `
        <div class="news-card" data-id="${news.id}" onclick="showNewsModal(${JSON.stringify(news).replace(/"/g, '&quot;')})">
            <div class="card-header">
                <span class="source-badge" style="background: ${getSourceColor(news.sourceId)}">${news.sourceName}</span>
                ${news.translated ? '<span class="translate-badge">🤖 ترجمه ماشینی</span>' : ''}
            </div>
            <h3 class="news-title">${escapeHtml(news.title)}</h3>
            <p class="news-summary">${escapeHtml(news.summary || 'جهت مشاهده جزئیات کلیک کنید...')}</p>
            <div class="card-footer">
                <span>🕒 ${formatTime(news.pubDate)}</span>
                <span>🔗 مطالعه</span>
            </div>
        </div>
    `).join('');
}

function showModal(news) {
    const modal = document.getElementById('newsModal');
    const modalBody = document.getElementById('modalBody');
    modalBody.innerHTML = `
        <h2 style="margin-bottom:16px;">${escapeHtml(news.title)}</h2>
        <div style="display:flex;gap:12px;margin-bottom:24px;">
            <span class="source-badge">${news.sourceName}</span>
            ${news.translated ? '<span class="translate-badge">🤖 ترجمه شده با ماشین</span>' : ''}
        </div>
        <div style="line-height:1.7; font-size:1rem;">${escapeHtml(news.content || news.summary || 'متن خبر موجود نیست')}</div>
        <hr style="margin:20px 0; border-color:rgba(255,255,255,0.1);">
        <a href="${news.link}" target="_blank" style="color:var(--primary);">🔗 مشاهده منبع اصلی</a>
    `;
    modal.style.display = 'flex';
}

function renderSourceFilters() {
    const sources = {};
    allNews.forEach(n => { sources[n.sourceId] = n.sourceName; });
    const container = document.getElementById('sourceFilters');
    container.innerHTML = `
        <div class="filter-chip ${currentFilter === 'all' ? 'active' : ''}" data-source="all">همه</div>
        ${Object.entries(sources).map(([id, name]) => `
            <div class="filter-chip ${currentFilter === id ? 'active' : ''}" data-source="${id}">${name}</div>
        `).join('')}
    `;
    document.querySelectorAll('.filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            currentFilter = chip.dataset.source;
            renderSourceFilters();
            renderNews();
        });
    });
}

function updateStats() {
    document.getElementById('totalCount').innerText = allNews.length;
    const translatedCount = allNews.filter(n => n.translated).length;
    document.getElementById('translatedCount').innerText = translatedCount;
}

function formatTime(dateStr) {
    if (!dateStr) return 'جدید';
    try {
        const date = new Date(dateStr);
        return date.toLocaleTimeString('fa-IR', { hour:'2-digit', minute:'2-digit' });
    } catch(e) { return 'جدید'; }
}

function getSourceColor(sourceId) {
    const colors = { c14: '#e63946', iranintl: '#1e88e5', rezapahlavi: '#43aa8b' };
    return colors[sourceId] || '#6366f1';
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

document.getElementById('refreshBtn').addEventListener('click', () => {
    loadNews();
    document.getElementById('refreshBtn').innerHTML = '🔄 در حال بروزرسانی...';
    setTimeout(() => {
        document.getElementById('refreshBtn').innerHTML = '🔄 بروزرسانی';
    }, 2000);
});

document.getElementById('searchInput').addEventListener('input', (e) => {
    currentSearch = e.target.value;
    renderNews();
});

document.querySelector('.close-modal').addEventListener('click', () => {
    document.getElementById('newsModal').style.display = 'none';
});

window.onclick = (e) => {
    const modal = document.getElementById('newsModal');
    if (e.target === modal) modal.style.display = 'none';
};

loadNews();
