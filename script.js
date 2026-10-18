const CONFIG = {
    refreshIntervalMs: 60000,
};

let allNews = [];
let currentSource = 'all';
let currentSearch = '';
let showOriginal = false;
let lastKnownTimestamp = null;
const cardMode = new Map(); // id -> 'translated' | 'original'

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
    if (diff < 60) return 'now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h';
    return Math.floor(diff / 86400) + 'd';
}

function getMode(item) {
    if (cardMode.has(item.id)) return cardMode.get(item.id);
    return showOriginal ? 'original' : 'translated';
}

function shouldShowToggle(item) {
    return item.needsTranslation && (item.translated || item.translationError);
}

function textFor(item, field, useOriginal) {
    const translated = item[field];
    const original = item[field + 'Original'];
    if (useOriginal) return original || translated || '';
    return translated || original || '';
}

/* ---------- data ---------- */
async function loadData() {
    try {
        const res = await fetch('output/news-data.json?t=' + Date.now());
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        allNews = Array.isArray(data.news) ? data.news : [];
        lastKnownTimestamp = data.lastUpdated || null;
        render();
        updateStatusBar(data);
    } catch (err) {
        console.error('load:', err);
        $('grid').innerHTML = '<div class="loading">Failed to load news</div>';
    }
}

function updateStatusBar(data) {
    // no visible status bar in this minimal layout; log only
    console.log('[status]', data.lastUpdated, data.translationStats);
}

/* ---------- render ---------- */
function render() {
    renderFilters();
    renderGrid();
}

function renderFilters() {
    const sources = {};
    for (const n of allNews) if (n.sourceId) sources[n.sourceId] = n.sourceName;

    const html = [
        `<button class="chip ${currentSource === 'all' ? 'active' : ''}" data-source="all" type="button">All</button>`,
        ...Object.entries(sources).map(([id, name]) =>
            `<button class="chip ${currentSource === id ? 'active' : ''}" data-source="${escapeHtml(id)}" type="button">${escapeHtml(name)}</button>`),
    ].join('');
    $('filters').innerHTML = html;
}

function getFiltered() {
    return allNews.filter(n => {
        if (!n) return false;
        if (currentSource !== 'all' && n.sourceId !== currentSource) return false;
        if (currentSearch) {
            const hay = `${n.title || ''} ${n.titleOriginal || ''} ${n.summary || ''}`.toLowerCase();
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
    const toggleLabel = useOriginal ? 'Show Persian' : 'Show original';
    const langLabel = (item.originalLang || '').toUpperCase();

    const img = item.image
        ? `<img class="card-image" src="${escapeHtml(item.image)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : '<div class="card-image empty"></div>';

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
                    <span class="source">${escapeHtml(item.sourceName || '')}</span>
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
    btn.textContent = showOriginal ? 'Persian' : 'Original';
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

    const toggleBtn = showToggle ? `
        <button class="btn ${useOriginal ? 'active' : ''}" id="readerToggle" type="button">
            ${useOriginal ? 'Show Persian' : 'Show original'}
        </button>
    ` : '';

    const openBtn = item.link ? `
        <button class="btn" id="readerOpen" type="button">Open source</button>
    ` : '';

    $('readerContent').innerHTML = `
        ${item.image ? `<img class="reader-image" src="${escapeHtml(item.image)}" alt="" onerror="this.style.display='none'">` : ''}
        <div class="reader-body">
            <div class="reader-source">${escapeHtml(item.sourceName || '')} · ${escapeHtml((item.originalLang || '').toUpperCase())}</div>
            <h2 class="reader-title">${escapeHtml(title)}</h2>
            <div class="reader-text">
                ${paragraphs.map(p => `<p>${escapeHtml(p)}</p>`).join('')}
            </div>
        </div>
        <div class="reader-actions">
            ${toggleBtn}
            ${openBtn}
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
async function refresh() {
    const btn = $('refreshBtn');
    btn.textContent = 'Refreshing...';
    btn.disabled = true;

    // try desktop API first, then direct fetch
    try {
        await fetch('/api/refresh', { cache: 'no-store' }).catch(() => null);
    } catch (e) { /* ignore */ }

    try {
        const res = await fetch('output/news-data.json?t=' + Date.now(), { cache: 'no-store' });
        if (res.ok) {
            const data = await res.json();
            if (data.lastUpdated !== lastKnownTimestamp) {
                allNews = Array.isArray(data.news) ? data.news : [];
                lastKnownTimestamp = data.lastUpdated;
                cardMode.clear();
                render();
            }
        }
    } catch (e) {
        console.error('refresh:', e);
    }

    btn.textContent = 'Refresh';
    btn.disabled = false;
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
    $('refreshBtn').addEventListener('click', refresh);
    $('readerClose').addEventListener('click', closeReader);
    $('reader').addEventListener('click', (e) => {
        if (e.target === $('reader')) closeReader();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !$('reader').hidden) closeReader();
    });

    loadData();
    setInterval(refresh, CONFIG.refreshIntervalMs);
}

document.addEventListener('DOMContentLoaded', init);