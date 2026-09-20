// amdz-catalog scraper — jalan di GitHub Actions tiap 6 jam
// Scrape karanime.com → enrich tahun & genre dari AniList → tulis catalog.json + meta.json
const fs = require('fs');

const KARANIME = 'https://karanime.com/wp-json/wp/v2/animes';
const ANILIST = 'https://graphql.anilist.co';
const MAX_PAGES = 40;         // max 4000 anime (baca total halaman asli dari API)
const KARANIME_DELAY = 1000;  // delay antar halaman (hormatin server)
const AL_DELAY = 420;         // delay antar request AniList (hindari rate limit)
const AL_MAX_ENRICH = 200;     // max item yang di-enrich per jalan

function decodeEntities(t) {
    return String(t || '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
        .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(+n); } catch (e) { return m; } });
}

function sanitizeYear(y) {
    const n = parseInt(y, 10);
    if (isNaN(n)) return '';
    const max = new Date().getFullYear() + 1;
    if (n < 1960 || n > max) return '';
    return String(n);
}

function normalizeTitle(s) {
    return String(s || '').toLowerCase()
        .replace(/[:\-_!?,."'()[\]{}~`@#$%^&*+=<>/\\|]/g, ' ')
        .replace(/\s+/g, ' ').trim();
}

function isGenericGenres(g) {
    return !g || g.length === 0 || g.every(x => /^(anime|sub indo)$/i.test(String(x).trim()));
}

function parseItem(item) {
    const eps = (item.meta_box?.ab_cdngroup || []).map(ep => ({
        ep: ep.ab_namaep || '1',
        url: ep.ab_linkcdn || ''
    })).filter(e => e.url !== '');
    let synopsis = (item.meta_box?.synopsis || item.meta_box?.deskripsi || item.excerpt?.rendered || item.content?.rendered || '')
        .replace(/<[^>]+>/g, '').trim();
    let rawGenres = item.meta_box?.genre || item.meta_box?.genres || [];
    let genres = typeof rawGenres === 'string'
        ? rawGenres.split(',').map(g => g.trim()).filter(Boolean)
        : (Array.isArray(rawGenres) ? rawGenres.map(g => (typeof g === 'object' ? g.name : g)).filter(Boolean) : []);
    if (!genres.length) genres = ['Anime', 'Sub Indo'];
    let year = '';
    const rawYear = item.meta_box?.tahunrilis || item.meta_box?.tahun || item.meta_box?.release || item.meta_box?.tglrilis || '';
    if (rawYear) {
        const m = String(rawYear).match(/(19|20)\d{2}/);
        year = sanitizeYear(m ? m[0] : rawYear);
    }
    if (!year) {
        const tm = decodeEntities(item.title?.rendered || '').match(/(19|20)\d{2}/);
        if (tm) year = sanitizeYear(tm[0]);
    }
    return {
        id: item.id,
        latestUpdate: new Date(item.modified || item.date || Date.now()).getTime(),
        title: decodeEntities(item.title?.rendered || 'Anime'),
        poster: item.meta_box?.ero_image || 'https://via.placeholder.com/300x400/080808/ffffff?text=No+Poster',
        genres, year,
        episodes: eps,
        synopsis: synopsis ? decodeEntities(synopsis) : 'Sinopsis belum tersedia.'
    };
}

async function fetchKaranime() {
    const all = [];
    let totalPages = MAX_PAGES;
    for (let page = 1; page <= totalPages; page++) {
        process.stdout.write(`Scraping halaman ${page}/${totalPages}...\n`);
        const res = await fetch(`${KARANIME}?per_page=100&page=${page}&orderby=modified&order=desc&_fields=id,date,modified,title,meta_box,excerpt,content`);
        if (!res.ok) { console.log('Halaman', page, 'gagal:', res.status); break; }
        const tp = parseInt(res.headers.get('X-WP-TotalPages')) || 0;
        if (tp > 0 && tp !== totalPages) {
            totalPages = Math.min(tp, MAX_PAGES);
            console.log('Total halaman karanime:', tp, '→ scrape sampai halaman', totalPages);
        }
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) break;
        all.push(...data.map(parseItem));
        if (data.length < 100) break;
        await new Promise(r => setTimeout(r, KARANIME_DELAY));
    }
    return all.filter(a => {
        if (!a.title || a.episodes.length === 0) return false;
        const g = (a.genres || []).join(' ').toLowerCase();
        const t = a.title.toLowerCase();
        if (/live\s?action|dorama/.test(g) || /live\s?action|dorama/.test(t)) return false;
        return true;
    });
}

async function alQuery(q, vars) {
    const res = await fetch(ANILIST, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query: q, variables: vars || {} })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (j.errors) throw new Error(j.errors[0].message);
    return j.data;
}

function cleanSearchTitle(t) {
    // buang penanda season/part/cour biar search-nya kena ("...Season 2" -> "...")
    return String(t || '')
        .replace(/\b\d+(?:th|nd|rd|st)\s+season\b/gi, ' ')
        .replace(/\b(?:season|part|cour)\s*\d+\b/gi, ' ')
        .replace(/\bs\d+\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractSeasonNum(t) {
    const s = String(t || '');
    let m = s.match(/\bseason\s*(\d+)\b/i) ||
            s.match(/(\d+)(?:th|nd|rd|st)\s+season\b/i) ||
            s.match(/\bpart\s*(\d+)\b/i) ||
            s.match(/\bcour\s*(\d+)\b/i) ||
            s.match(/\bs(\d+)\b/i);
    return m ? parseInt(m[1], 10) : null;
}

function pickBest(baseTitle, wantSeason, media) {
    const words = normalizeTitle(baseTitle).split(' ').filter(Boolean);
    if (!words.length) return media[0] || null;
    let best = null, bestScore = 0;
    for (const m of media) {
        const mtFull = m.title?.english || m.title?.romaji || m.title?.native || '';
        const mt = normalizeTitle(mtFull);
        let hits = 0;
        for (const w of words) if (mt.includes(w)) hits++;
        let score = hits / words.length;
        const mSeason = extractSeasonNum(mtFull);
        if (wantSeason && mSeason === wantSeason) score += 0.5;              // season cocok → prioritas
        else if (wantSeason && mSeason && mSeason !== wantSeason) score -= 0.3; // beda season → penalti
        if (score > bestScore) { bestScore = score; best = m; }
    }
    return (best && bestScore >= 0.6) ? best : null;
}

function bestMatch(title, media) {
    return pickBest(cleanSearchTitle(title), extractSeasonNum(title), media);
}

function loadMeta() {
    try { return JSON.parse(fs.readFileSync('meta.json', 'utf8')); } catch (e) { return {}; }
}

function applyMeta(list, meta) {
    for (const a of list) {
        const m = meta[a.id];
        if (!m) continue;
        if (m.y && !a.year) a.year = m.y;
        if (m.g && m.g.length && isGenericGenres(a.genres)) a.genres = m.g;
    }
}

async function enrichAniList(list, meta) {
    const targets = list.filter(a => !a.year || isGenericGenres(a.genres)).slice(0, AL_MAX_ENRICH);
    console.log('Enrich AniList:', targets.length, 'item');
    for (const a of targets) {
        try {
            const q = `query($s:String){Page(page:1,perPage:5){media(type:ANIME,search:$s,isAdult:false){id title{romaji english native} genres seasonYear startDate{year}}}}`;
            const d = await alQuery(q, { s: a.title });
            const media = d?.Page?.media || [];
            const best = bestMatch(a.title, media);
            if (best) {
                const y = sanitizeYear(String(best.seasonYear || best.startDate?.year || ''));
                const g = (best.genres || []).filter(Boolean).slice(0, 4);
                meta[a.id] = meta[a.id] || {};
                if (y && !a.year) { a.year = y; meta[a.id].y = y; }
                if (g.length && isGenericGenres(a.genres)) { a.genres = g; meta[a.id].g = g; }
            }
        } catch (e) {
            console.error('Enrich gagal:', a.title, '-', e.message);
        }
        await new Promise(r => setTimeout(r, AL_DELAY));
    }
}

(async () => {
    console.log('=== amdz-catalog scraper ===');
    const list = await fetchKaranime();
    console.log('Total anime dari karanime:', list.length);
    if (list.length === 0) { console.error('KOSONG! abort biar gak nimpah data lama.'); process.exit(1); }

    const meta = loadMeta();
    applyMeta(list, meta);

    console.log('Mulai enrich AniList...');
    await enrichAniList(list, meta);

    list.sort((a, b) => (b.latestUpdate || b.id) - (a.latestUpdate || a.id));
    fs.writeFileSync('catalog.json', JSON.stringify(list));
    fs.writeFileSync('meta.json', JSON.stringify(meta));
    console.log('Selesai! catalog.json =', (fs.statSync('catalog.json').size / 1024).toFixed(1), 'KB |', list.length, 'anime');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
    
