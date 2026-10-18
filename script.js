const CONFIG = {
    refreshIntervalMs: 60000,
};

let allNews = [];
let currentSource = 'latest';
let currentSearch = '';
let showOriginal = false;
let lastKnownTimestamp = null;
const cardMode = new Map();

const $ = (id) => document.getElementById(id);

function escapeHtml(t) {
    return String(t ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function timeAgo(iso) {
    if (!iso) return '';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 0) return 'now';
    if (diff < 60) return 'now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h';
    return Math.floor(diff / 86400) + 'd';
}

function normalizeTitle(title) {
    if (!title) return '';
    return String(title)
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\s*[-–—|]\s*(jpost|jerusalem post|times of israel|ynet.*|bbc.*|dw.*|rferl.*|al jazeera.*|iran international|iran intl.*|c14|reza pahlavi.*)\s*$/i, '')
        .trim()
        .slice(0, 100);
}

function getMode(item) {
    if (cardMode.has(item.id)) return cardMode.get(item.id);
    return showOriginal ? 'original' : 'translated';
}

function shouldShowToggle(item) {
    return item.needsTranslation && (item.translated || item.translationError);
}

function textFor(item, field, useOriginal) {
    const originalKey = 'original' + field.charAt(0).toUpperCase() + field.slice(1);
    const translated = item[field];
    const original = item[originalKey];
    if (useOriginal) return original || translated || '';
    return translated || original || '';
}

/* ---------- data ---------- */
async function loadData(force = false) {
    try {
        const curRes = await fetch('output/news-data.json?t=' + Date.now());
        if (!curRes.ok) throw new Error('HTTP ' + curRes.status);
        const currentData = await curRes.json();

        if (!force && currentData.lastUpdated && currentData.lastUpdated === lastKnownTimestamp) {
            return;
        }

        const archRes = await fetch('output/archive.json?t=' + Date.now()).catch(() => null);
        const archiveData = (archRes && archRes.ok) ? await archRes.json() : { news: [] };

        const currentNews = Array.isArray(currentData.news) ? currentData.news : [];
        const archivedRaw = Array.isArray(archiveData.news) ? archiveData.news : [];

        const combined = [
            ...currentNews,
            ...archivedRaw.map(n => ({ ...n, archived: true })),
        ];

        const currentIds = new Set(currentNews.map(n => n.id));
        const merged = [];
        const seenIds = new Set();
        const seenKeys = new Set();

        for (const n of combined) {
            if (!n || !n.id) continue;
            if (seenIds.has(n.id)) continue;
            if (n.archived && currentIds.has(n.id)) continue;
            const key = `${n.sourceId || ''}::${normalizeTitle(n.originalTitle || n.title || '')}`;
            if (seenKeys.has(key)) continue;
            seenIds.add(n.id);
            seenKeys.add(key);
            merged.push(n);
        }

        allNews = merged;
        allNews.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));

        lastKnownTimestamp = currentData.lastUpdated || null;
        render();
        updateCountBadge(currentData);
    } catch (err) {
        console.error('load:', err);
        $('grid').innerHTML = '<div class="loading">Failed to load news</div>';
    }
}

function updateCountBadge(data) {
    const brand = document.querySelector('.brand');
    if (!brand) return;
    let badge = document.getElementById('countBadge');
    if (!badge) {
        badge = document.createElement('span');
        badge.id = 'countBadge';
        badge.className = 'count';
        brand.appendChild(badge);
    }
    const current = (data.news || []).length;
    const archived = allNews.filter(n => n.archived).length;
    const parts = [`${current} latest`];
    if (archived > 0) parts.push(`${archived} archived`);
    const failed = (data.stats?.failedSources || []).length;
    if (failed > 0) parts.push(`${failed} failed`);
    badge.textContent = parts.join(' · ');
}

/* ---------- render ---------- */
function render() {
    renderFilters();
    renderGrid();
}

function renderFilters() {
    const sources = {};
    for (const n of allNews) {
        if (n.sourceId && !n.archived) sources[n.sourceId] = n.sourceName;
    }
    const hasArchived = allNews.some(n => n.archived);

    const chips = [
        `<button class="chip ${currentSource === 'latest' ? 'active' : ''}" data-source="latest" type="button">Latest</button>`,
        `<button class="chip ${currentSource === 'all' ? 'active' : ''}" data-source="all" type="button">All</button>`,
    ];
    if (hasArchived) {
        chips.push(`<button class="chip ${currentSource === 'archived' ? 'active' : ''}" data-source="archived" type="button">Archive</button>`);
    }
    for (const [id, name] of Object.entries(sources)) {
        chips.push(`<button class="chip ${currentSource === id ? 'active' : ''}" data-source="${escapeHtml(id)}" type="button">${escapeHtml(name)}</button>`);
    }
    $('filters').innerHTML = chips.join('');
}

function getFiltered() {
    return allNews.filter(n => {
        if (!n) return false;

        // Latest: فقط خبرهای غیرآرشیوی
        if (currentSource === 'latest') {
            if (n.archived) return false;
        }
        // Archive: فقط خبرهای آرشیوی
        else if (currentSource === 'archived') {
            if (!n.archived) return false;
        }
        // All: همه
        else if (currentSource === 'all') {
            // بدون فیلتر
        }
        // Source chip: فقط همون منبع (چه latest چه archived)
        else if (n.sourceId !== currentSource) {
            return false;
        }

        if (currentSearch) {
            const hay = `${n.title || ''} ${n.originalTitle || ''} ${n.summary || ''}`.toLowerCase();
            if (!hay.includes(currentSearch.toLowerCase())) return false;
        }
        return true;
    });
}

function renderGrid() {
    const list = getFiltered();
    if (!list.length) {
        $('grid').innerHTML = '<div class="loading">No stories found</div>';
        return;
    }
    $('grid').innerHTML = list.map(renderCard).join('');
}

function renderCard(item) {
    const useOriginal = getMode(item) === 'original';
    const title = textFor(item, 'title', useOriginal);
    const summary = textFor(item, 'summary', useOriginal);
    const showToggle = shouldShowToggle(item);
    const toggleLabel = useOriginal ? 'نمایش فارسی' : 'Show original';
    const langLabel = (item.originalLang || '').toUpperCase();

    const img = item.image
        ? `<img class="card-image" src="${escapeHtml(item.image)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : '<div class="card-image empty"></div>';

    const badges = [];
    if (item.archived) badges.push('<span class="badge archived">Archive</span>');
    if (item.translationError) badges.push('<span class="badge failed">Failed</span>');
    const badgeHtml = badges.join(' ');

    const footer = showToggle ? `
        <div class="card-footer">
            <span class="card-lang">${escapeHtml(langLabel)}</span>
            <button class="card-toggle ${useOriginal ? 'active' : ''}" data-toggle="1" type="button">${toggleLabel}</button>
        </div>` : '';

    return `
        <article class="card" data-id="${escapeHtml(item.id)}">
            ${img}
            <div class="card-body">
                <div class="card-meta">
                    <span class="source">${escapeHtml(item.sourceName || '')} ${badgeHtml}</span>
                    <span class="card-time">${timeAgo(item.pubDate)}</span>
                </div>
                <h3 class="card-title">${escapeHtml(title)}</h3>
                <p class="card-summary">${escapeHtml(summary)}</p>
                ${footer}
            </div>
        </article>
    `;
}

/* ---------- interactions ---------- */
function toggleCard(id) {
    const item = allNews.find(n => n.id === id);
    if (!item) return;
    const current = getMode(item);
    cardMode.set(id, current === 'original' ? 'translated' : 'original');
    renderGrid();
}

function toggleGlobal() {
    showOriginal = !showOriginal;
    cardMode.clear();
    const btn = $('langBtn');
    btn.textContent = showOriginal ? 'نمایش فارسی' : 'Show original';
    btn.classList.toggle('active', showOriginal);
    renderGrid();
}

/* ---------- reader ---------- */
function openReader(item) {
    const useOriginal = getMode(item) === 'original';
    const title = textFor(item, 'title', useOriginal);
    const content = textFor(item, 'content', useOriginal);
    const showToggle = shouldShowToggle(item);
    const paragraphs = splitParagraphs(content);
    const pubDateLabel = item.pubDate
        ? new Date(item.pubDate).toLocaleString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '';

    $('readerContent').innerHTML = `
        ${item.image ? `<img class="reader-image" src="${escapeHtml(item.image)}" alt="" onerror="this.style.display='none'">` : ''}
        <div class="reader-body">
            <div class="reader-source">${escapeHtml(item.sourceName || '')} · ${escapeHtml((item.originalLang || '').toUpperCase())}${pubDateLabel ? ' · ' + escapeHtml(pubDateLabel) : ''}</div>
            <h2 class="reader-title">${escapeHtml(title)}</h2>
            <div class="reader-text">
                ${paragraphs.map(p => `<p>${escapeHtml(p)}</p>`).join('')}
            </div>
        </div>
        <div class="reader-actions">
            ${showToggle ? `<button class="btn ${useOriginal ? 'active' : ''}" id="readerToggle" type="button">${useOriginal ? 'نمایش فارسی' : 'Show original'}</button>` : ''}
            ${item.link ? `<button class="btn" id="readerOpen" type="button">منبع اصلی</button>` : ''}
        </div>
    `;

    $('reader').hidden = false;
    document.body.style.overflow = 'hidden';

    if (showToggle) {
        $('readerToggle').addEventListener('click', () => {
            toggleCard(item.id);
            closeReader();
            openReader(item);
        });
    }
    if (item.link) {
        $('readerOpen').addEventListener('click', () => {
            window.open(item.link, '_blank', 'noopener,noreferrer');
        });
    }
}

function splitParagraphs(text) {
    if (!text) return [];
    const blocks = text.split(/\n{2,}/).map(t => t.trim()).filter(Boolean);
    if (blocks.length > 1) return blocks;
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    const out = [];
    let buf = '';
    for (const s of sentences) {
        if ((buf + s).length > 320) {
            if (buf) out.push(buf.trim());
            buf = s;
        } else buf += s;
    }
    if (buf) out.push(buf.trim());
    return out.length ? out : [text];
}

function closeReader() {
    $('reader').hidden = true;
    document.body.style.overflow = '';
}

/* ---------- refresh ---------- */
async function refresh(manual = false) {
    const btn = $('refreshBtn');
    if (btn) {
        btn.textContent = 'Refreshing...';
        btn.disabled = true;
    }
    try {
        await fetch('/api/refresh', { cache: 'no-store' }).catch(() => null);
    } catch (e) { /* ignore */ }
    await loadData(manual);
    if (btn) {
        btn.textContent = 'Refresh';
        btn.disabled = false;
    }
}

/* ---------- init ---------- */
function init() {
    $('filters').addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        currentSource = chip.dataset.source;
        render();
    });

    $('grid').addEventListener('click', (e) => {
        const toggle = e.target.closest('[data-toggle]');
        const card = e.target.closest('.card');
        if (!card) return;
        const id = card.dataset.id;
        if (toggle) {
            e.stopPropagation();
            toggleCard(id);
            return;
        }
        const item = allNews.find(n => n.id === id);
        if (item) openReader(item);
    });

    $('search').addEventListener('input', (e) => {
        currentSearch = e.target.value;
        renderGrid();
    });

    $('langBtn').addEventListener('click', toggleGlobal);
    $('refreshBtn').addEventListener('click', () => refresh(true));
    $('readerClose').addEventListener('click', closeReader);
    $('reader').addEventListener('click', (e) => {
        if (e.target === $('reader')) closeReader();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !$('reader').hidden) closeReader();
    });

    loadData();
    setInterval(() => refresh(false), CONFIG.refreshIntervalMs);
}

document.addEventListener('DOMContentLoaded', init);