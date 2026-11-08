// Священный таймлайн — ядро, v0.9.
// Узнаёт эпоху и дату открытого чата по Реестру мира (лорбук на сервере, имя кончается на «Реестр») и:
//  • пускает в промпт только лорбуки и записи своей эпохи (книги по эпохам, записи Хроники из будущего — вон);
//  • тайны — только тем, кто их знает (gc.knows говорящего на дату), и не раньше, чем персона их прожила (gc.personal);
//  • правит персону прямо в промпте под эпоху (возраст, «сейчас», внешность) — сама персона в ST не меняется;
//  • убирает из Закулисья тех, кого в этой эпохе нет: умер, пыль, лёд, ещё не родился;
//  • «кто есть кто» — короткая шпаргалка эпохи на дату сюжета в промпт (строки эпохи + кого здесь нет и почему);
//  • книги эпохи (era.lore) — сам подключает их в чатах отмеченной эпохи, без глобальных настроек ST;
//  • аватар персоны по эпохе: у обличья эпохи свой файл в User Avatars — ядро заводит персону-двойника
//    (то же имя, описание — уже с правками эпохи) и переключает на неё в чатах эпохи; уходя — возвращает базовую;
//  • расширки: SacredTimeline.context() и событие «sacred-timeline:changed» (мир, эпоха, дата, говорящий, состав,
//    персона, режимы); режимы расширок по эпохам из Реестра — глушит их промпт и прячет кнопки, настроек не трогает;
//  • канон: Страж (графа в Летописце Life, 🚩 под постом), Хронист (память канон-чата → подзаписи Хроники 🟡),
//    Ревизор (сильная модель сверяет с Хроникой), решение — вписать / только память / своё / подрезать.
// Лора в коде нет — он весь в Реестре и Хронике.

const MODULE = 'sacred_timeline';
const VERSION = '0.9.6';
const TAG = '[Священный таймлайн]';
const DEFAULTS = { filterLore: true, persona: true, who: true, chronicle: true, strazh: true, chronist: true, reviser: '' };
const WHO_KEY = 'sacred_timeline_who';
const CHRON_KEY = 'sacred_timeline_chronicle';
const IN_PROMPT = 0;     // extension_prompt_types.IN_PROMPT
const WHO_DEPTH = 1;     // перед последним сообщением чата
const IN_CHAT = 1;       // extension_prompt_types.IN_CHAT
const ROLE_SYSTEM = 0;   // extension_prompt_roles.SYSTEM

const ctx = () => SillyTavern.getContext();

let current = { chatId: null, era: null, explicit: false, date: null, dateSource: '', world: null, registry: null };
let lastLore = null;     // что срезали в последний раз
let lastPersona = null;  // сколько правок персоны применили в последний раз
let lastWho = null;      // сколько строк «кто есть кто» ушло в промпт в последний раз
let lastBooks = null;    // книги эпохи: { added: [имена], missing: [имена], entries: n }
let lastAvatar = null;   // аватар персоны: { avatar, base, missing, switched }
let lastMemory = null;   // память эпохи: { book, bound, missing, other }
let lastHistory = null;  // память прошлых эпох в промпте: { added: [книги], entries: n }
let lastChron = null;    // Хроника под дату: { past, ahead } — сколько строк ушло
let lastCanon = null;    // строки «Канон» для Стража (Летописец Life): { input, chatId }
let lastDrafts = [];     // подзаписи Хроники этой эпохи на проверке: [{ uid, title, status, who, review }]
let switchingPersona = false;

function settings() {
    const ext = ctx().extensionSettings;
    if (!ext[MODULE]) ext[MODULE] = {};
    for (const [k, v] of Object.entries(DEFAULTS)) if (ext[MODULE][k] === undefined) ext[MODULE][k] = v;
    return ext[MODULE];
}

// ───────────── Реестр ─────────────

/** Лорбук-реестр: из настроек расширения или первый, чьё имя кончается на «Реестр». */
export function registryName(names, override) {
    if (override) return override;
    return (names || []).find(n => /реестр\s*$/i.test(String(n))) || null;
}

async function loadRegistry() {
    const name = registryName(ctx().getWorldInfoNames?.(), ctx().extensionSettings?.[MODULE]?.registry);
    current.registry = name;
    if (!name) return null;
    try {
        const data = await ctx().loadWorldInfo(name);
        return data && data.entries ? data : null;
    } catch (e) {
        console.warn(TAG, 'Реестр не прочитался', e);
        return null;
    }
}

function records(data, type) {
    return Object.values(data?.entries || {}).map(e => e?.gc).filter(g => g && g.type === type);
}

export function worldRecord(data) {
    return records(data, 'world')[0] || null;
}

const norm = s => String(s ?? '').trim().toLowerCase().replace(/ё/g, 'е');

/** Эпоха чата: метка в chat_metadata → чат в списке эпохи → группа эпохи. */
export function findEra(data, { marker, chatId, groupId } = {}) {
    const eras = records(data, 'era');
    if (marker) {
        const e = eras.find(x => String(x.id) === String(marker));
        if (e) return e;
    }
    if (chatId) {
        const e = eras.find(x => (x.chats || []).includes(chatId));
        if (e) return e;
    }
    if (groupId !== undefined && groupId !== null && groupId !== '') {
        const e = eras.find(x => x.group && String(x.group) === String(groupId));
        if (e) return e;
    }
    return null;
}

export function eraById(data, id) {
    return records(data, 'era').find(x => String(x.id) === String(id)) || null;
}

/** Дата, на которую смотрим состав эпохи: её начало. */
export function eraDate(era) {
    return era?.from || era?.to || null;
}

// ───────────── миры ─────────────

/** Карточки чата: персонаж 1:1 или участники группы. */
function chatCards(c) {
    if (c?.groupId !== undefined && c?.groupId !== null && c?.groupId !== '') {
        const g = (c.groups || []).find(x => String(x.id) === String(c.groupId));
        return (g?.members || []).map(av => (c.characters || []).find(x => x.avatar === av) || { avatar: av });
    }
    const ch = c?.characters?.[c?.characterId];
    return ch ? [ch] : [];
}

/**
 * Чат из этого мира? Кто-то из его персонажей — личность мира (по карточке обличья или по имени).
 * Отмеченные в Реестре чаты (эпохи) — в мире всегда; это для остальных.
 */
export function inWorld(data, cards) {
    const ids = records(data, 'identity');
    for (const ch of cards || []) {
        if (!ch) continue;
        if (ch.avatar && ids.some(g => (g.slices || []).some(s => s.card === ch.avatar))) return true;
        if (ch.name && findIdentity(data, ch.name)) return true;
    }
    return false;
}

/** Книги мира: всё, что Реестр знает как свои (книги с эпохами, ownBooks, Хроника, сам Реестр). */
export function worldBooks(data) {
    const w = worldRecord(data);
    if (!w) return new Set();
    return new Set([...Object.keys(w.books || {}), ...(w.ownBooks || []), w.chronicle, w.registry].filter(Boolean));
}

/** Чат чужого мира: записи книг этого мира — вон (глобальные лорбуки мира в чужие ролки не текут). */
export function hideWorldBooks(payload, books) {
    const stats = { dropped: 0, enabled: 0, byBook: {}, outside: true };
    for (const key of LORE_KEYS) {
        const arr = payload?.[key];
        if (!Array.isArray(arr)) continue;
        for (let i = arr.length - 1; i >= 0; i--) {
            const w = arr[i]?.world;
            if (!w || !books.has(w)) continue;
            if (!arr[i].disable) { stats.dropped++; stats.byBook[w] = (stats.byBook[w] || 0) + 1; }
            arr.splice(i, 1);
        }
    }
    return stats;
}

// ───────────── дата чата ─────────────

const MONTHS = {
    январ: 1, феврал: 2, март: 3, апрел: 4, ма: 5, июн: 6, июл: 7, август: 8, сентябр: 9, октябр: 10, ноябр: 11, декабр: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const pad = n => String(n).padStart(2, '0');

function monthOf(word) {
    const w = norm(word);
    if (/^ма[йяе]$/.test(w)) return 5;
    for (const [k, v] of Object.entries(MONTHS)) if (k !== 'ма' && w.startsWith(k)) return v;
    return null;
}

/** «Среда, 15 марта 1961», «15.03.1961», «1961-03-15», «March 15, 1961», «октябрь 1962» → «1961-03-15» / «1962-10». */
export function parseStoryDate(text) {
    const s = String(text ?? '');
    let m = s.match(/(\d{4})-(\d{2})(?:-(\d{2}))?/);
    if (m) return m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`;
    m = s.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
    if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
    m = s.match(/(\d{1,2})\s+([а-яёa-z]+)\.?,?\s+(\d{4})/i);
    if (m && monthOf(m[2])) return `${m[3]}-${pad(monthOf(m[2]))}-${pad(m[1])}`;
    m = s.match(/([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/i);
    if (m && monthOf(m[1])) return `${m[3]}-${pad(monthOf(m[1]))}-${pad(m[2])}`;
    m = s.match(/([а-яёa-z]+)\s+(\d{4})/i);
    if (m && monthOf(m[1])) return `${m[2]}-${pad(monthOf(m[1]))}`;
    return null;
}

function infoBoxDate(ib) {
    if (!ib) return null;
    if (typeof ib === 'object') return ib?.date?.value || null;
    const m = String(ib).match(/"date"\s*:\s*\{\s*"value"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
}

/** Где сейчас сюжет: метка в чате → трекер RPG Companion → трекер в тексте ответа → Horae → ничего. */
export function storyDate(md, chat) {
    const mark = md?.[MODULE]?.date;
    if (mark) return { date: String(mark), source: 'метка чата' };
    const rc = md?.rpg_companion;
    for (const box of [rc?.committedTrackerData?.infoBox, rc?.lastGeneratedData?.infoBox]) {
        const d = parseStoryDate(infoBoxDate(box));
        if (d) return { date: d, source: 'трекер' };
    }
    const list = Array.isArray(chat) ? chat : [];
    for (let i = list.length - 1; i >= Math.max(0, list.length - 40); i--) {
        const msg = list[i];
        const sw = msg?.extra?.rpg_companion_swipes;
        const box = sw && (sw[String(msg.swipe_id ?? 0)] || sw['0'])?.infoBox;
        let d = parseStoryDate(infoBoxDate(box));
        if (d) return { date: d, source: 'трекер' };
        d = parseStoryDate(infoBoxDate(msg?.mes));
        if (d) return { date: d, source: 'трекер в ответе' };
        d = parseStoryDate(msg?.horae_meta?.timestamp?.story_date);
        if (d) return { date: d, source: 'Horae' };
    }
    return { date: null, source: '' };
}

/** Дата не выходит за рамки эпохи (трекеры иногда уползают). */
export function clampDate(date, era) {
    if (!date || !era) return date;
    if (era.from && date < era.from) return era.from;
    if (era.to && date > era.to) return era.to;
    return date;
}

// ───────────── личности ─────────────

/** Личность по имени из ростера: точное имя или алиас, иначе — первое слово («Имя Фамилия» → «Имя»). */
export function findIdentity(data, name) {
    const ids = records(data, 'identity');
    const match = n => ids.filter(g => norm(g.name) === n || (g.aliases || []).some(a => norm(a) === n));
    const n = norm(name);
    if (!n) return null;
    let hits = match(n);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null; // неоднозначно — не трогаем
    const first = n.split(/\s+/)[0];
    if (first && first !== n) {
        hits = match(first);
        if (hits.length === 1) return hits[0];
    }
    return null;
}

/** Есть ли личность в мире на дату: дата попадает в один из отрезков её линии жизни. */
export function presentAt(identity, date) {
    const tl = identity?.timeline || [];
    if (!tl.length || !date) return true;
    return tl.some(s => (s.from == null || s.from <= date) && (s.to == null || date < s.to));
}

/** Регэксп упоминаний личности — только по своим алиасам: общие с кем-то (один титул на двоих) не берём. */
export function mentionRegex(data, identity, rosterName) {
    const owners = new Map();
    for (const g of records(data, 'identity')) {
        for (const a of [g.name, ...(g.aliases || [])]) {
            const k = norm(a);
            if (!owners.has(k)) owners.set(k, new Set());
            owners.get(k).add(g.id);
        }
    }
    const words = [rosterName, identity.name, ...(identity.aliases || [])]
        .filter(a => a && a.length >= 4)
        .filter(a => (owners.get(norm(a))?.size || 0) <= 1);
    if (!words.length) return null;
    const parts = [...new Set(words)].map(a => {
        const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const stem = /[аяоеыиуьй]$/i.test(a) && !/[иуы]$/i.test(a) ? esc.slice(0, -1) : esc;
        return /[а-яё]$/i.test(a) ? `${stem}[а-яё]{0,3}` : stem;
    });
    return new RegExp(`(^|[^\\p{L}])(${parts.join('|')})(?!\\p{L})`, 'iu');
}

// ───────────── лорбуки ─────────────

const covers = (s, at) => (s.from == null || s.from <= at) && (s.to == null || at < s.to);
/** gc.public: true — знают все; дата — тайна до неё, дальше знают все (силы стали новостью и т. п.). */
const isPublic = (g, at) => g?.public === true || (typeof g?.public === 'string' && !!at && String(g.public) <= String(at));

/**
 * Решение по записи лорбука для эпохи и даты.
 * Книга со списком эпох — только в них. Запись с gc.eras — только в своих эпохах (gc.inject — ядро её включает).
 * Запись Хроники, которая начинается позже даты чата, — из будущего, вон.
 * Тайна с картой знания (gc.knows) — только если говорящий знает её на эту дату; «обрывки» — не знание;
 * gc.public (true или дата) — с этой даты тайну знают все;
 * говорящий не опознан — тайну не даём (кому она известна, записано явно, а его в списке нет).
 * Без карты знания: событие из личного времени персоны (gc.personal) позже её «сейчас» в этой эпохе — она его
 * ещё не прожила, вон. Карта знания важнее: если говорящий знает, а персона ещё нет — это петля, ему можно.
 * Часть книги личности из другой эпохи (gc.part) на стыке эпох — строго: кончилась к началу этой эпохи (to ≤ from
 * эпохи) или начинается с её конца (from ≥ to эпохи) — вон, хотя месяц стыка общий («по 2014-04» — включительно).
 * Возвращает 'keep' | 'drop' | 'enable'.
 */
export function judgeEntry(entry, { eraId, date, eraFrom, eraTo, speaker, personaId, personaNow }, books) {
    const scope = books?.[entry?.world];
    if (scope && Array.isArray(scope.eras) && !scope.eras.includes(eraId)) return 'drop';
    const g = entry?.gc;
    if (!g || typeof g !== 'object') return 'keep';
    if (Array.isArray(g.eras)) {
        if (!g.eras.includes(eraId)) return 'drop';
        if (g.inject && entry.disable) return 'enable';
    }
    if (entry.disable) return 'keep';
    if (date && g.from && String(g.from) > date) return 'drop';
    if (g.part && eraId && String(g.part) !== String(eraId)) {
        if (g.to && eraFrom && String(g.to) <= String(eraFrom)) return 'drop';
        if (g.from && eraTo && String(g.from) >= String(eraTo)) return 'drop';
    }
    // книга личности (одна на человека): часть эпохи без даты чата меряем началом эпохи — чужие годы не смешиваются
    const at = date || (g.part ? eraFrom : null);
    if (!date && at && g.from && String(g.from) > at) return 'drop';
    // состояние видно только внутри своего отрезка (с from по to)
    if (at && g.kind === 'state' && g.to && String(at) > String(g.to) && !String(at).startsWith(String(g.to))) return 'drop';
    if (g.secret && g.knows && typeof g.knows === 'object' && !isPublic(g, date || eraFrom)) {
        // память своей эпохи: рассказчику и неопознанным NPC видна — сцены рассказывали они
        if (g.kind === 'memory' && String(g.era) === String(eraId) && !speaker) return 'keep';
        const at = date || eraFrom;
        const spans = speaker ? g.knows[speaker] : null;
        return at && Array.isArray(spans) && spans.some(s => s.mode === 'knows' && covers(s, at)) ? 'keep' : 'drop';
    }
    const lived = personaId && g.personal?.[personaId];
    if (lived && personaNow && String(lived).split('/')[0] > personaNow) return 'drop';
    return 'keep';
}

const LORE_KEYS = ['globalLore', 'characterLore', 'chatLore', 'personaLore'];

/** Книги эпохи (era.lore), которых ещё нет среди загруженных ST, — без повторов и пустых имён. */
export function eraBooksToAdd(payload, era) {
    const names = Array.isArray(era?.lore) ? era.lore.filter(n => typeof n === 'string' && n.trim()) : [];
    if (!names.length) return [];
    const have = new Set();
    for (const key of LORE_KEYS) {
        for (const e of payload?.[key] || []) if (e?.world) have.add(e.world);
    }
    return [...new Set(names)].filter(n => !have.has(n));
}

/** Записи книги — в globalLore, в той же форме, что у ST: { uid, world, ...rest }. Возвращает число записей. */
export function addBook(payload, name, data, pick = null) {
    const entries = data?.entries;
    if (!entries || typeof entries !== 'object' || !Array.isArray(payload?.globalLore)) return 0;
    let n = 0;
    for (const key of Object.keys(entries)) {
        const raw = entries[key];
        if (!raw || typeof raw !== 'object') continue;
        if (pick && !pick(raw)) continue;
        const { uid, ...rest } = raw;
        payload.globalLore.push({ uid, world: name, ...rest });
        n++;
    }
    return n;
}

/** Подключить книги эпохи. Книги, которых нет на сервере, — в missing (их видно в статусе). */
async function joinEraBooks(payload, era) {
    const out = { added: [], missing: [], entries: 0 };
    const todo = eraBooksToAdd(payload, era);
    if (!todo.length) return out;
    const known = ctx().getWorldInfoNames?.();
    for (const name of todo) {
        if (Array.isArray(known) && !known.includes(name)) { out.missing.push(name); continue; }
        let data = null;
        try { data = await ctx().loadWorldInfo(name); } catch (e) { console.warn(TAG, `книга «${name}» не прочиталась`, e); }
        const n = addBook(payload, name, data);
        if (data?.entries) { out.added.push(name); out.entries += n; } else out.missing.push(name);
    }
    return out;
}

/** Кто и когда смотрит: эпоха, дата, говорящий, персона — для judgeEntry. */
export function scopeFor(data, era, date, c) {
    return {
        eraId: era.id,
        date,
        eraFrom: era.from || null,
        eraTo: era.to || null,
        speaker: speakerOf(data, c?.characters?.[c?.characterId], c?.name2),
        personaId: personaIdentity(data),
        personaNow: era.personaTime || date || era.from || null,
    };
}

/**
 * Что из записей книги видно отсюда — для расширок, которые сами читают лорбуки (поиск по памяти и т. п.).
 * Выключенные записи судим как включённые: ST их сам не вставит, а поиск — может.
 */
export function visibleEntries(entries, world, scope, books) {
    const at = scope?.date || scope?.eraFrom || null;
    return (entries || []).filter(e => e && judgeEntry({ ...e, world, disable: false }, scope, books) !== 'drop')
        .map(e => entryAt(e, at).entry);
}

/** Память прошлых эпох — только размеченные записи (дата и кто знает); дальше их режет общий фильтр. */
async function joinHistory(payload, data, era) {
    const out = { added: [], entries: 0 };
    const have = new Set();
    for (const key of LORE_KEYS) for (const e of payload?.[key] || []) if (e?.world) have.add(e.world);
    const known = ctx().getWorldInfoNames?.();
    for (const name of historyBooks(data, era)) {
        if (have.has(name) || (Array.isArray(known) && !known.includes(name))) continue;
        let book = null;
        try { book = await ctx().loadWorldInfo(name); } catch { /* нет книги — нет истории */ }
        const n = addBook(payload, name, book, isTaggedMemory);
        if (n) { out.added.push(name); out.entries += n; }
    }
    return out;
}

// ───────────── отрывки по дате ─────────────

const SEG_DATE = '(\\d{4}(?:-\\d{2}){0,2})';
// «с» — и кириллицей, и латиницей (так набирается на телефоне)
const SEG_RE = new RegExp(`⟦\\s*(?:(?:с|c|from)\\s+${SEG_DATE}(?:\\s+(?:по|до|to|until)\\s+${SEG_DATE})?|(?:до|по|until|to)\\s+${SEG_DATE})\\s*:[ \\t]?([\\s\\S]*?)⟧`, 'g');

/**
 * Отрывки внутри текста записи: ⟦с 2018-04: …⟧ — видно с этой даты, ⟦до 2020-06: …⟧ — по эту дату включительно
 * (как to у состояния), ⟦с 2016-04 по 2023-10: …⟧ — внутри отрезка; можно и from / until / to. Одна запись на все
 * годы, а знание, которого на эту дату ещё нет (или уже нет), — вон из текста; там, где оно есть, текст тот же, что
 * без скобок. Без даты — всё как есть, только без скобок. Возвращает { text, hidden } — сколько отрывков скрыто.
 */
export function atDate(text, at) {
    const s = String(text ?? '');
    if (!s.includes('⟦')) return { text: s, hidden: 0 };
    const when = at ? String(at) : '';
    let out = '';
    let last = 0;
    let hidden = 0;
    SEG_RE.lastIndex = 0;
    for (let m; (m = SEG_RE.exec(s));) {
        const [all, since, till1, till2, body] = m;
        const till = till1 || till2;
        const show = !when
            || ((!since || since <= when) && (!till || !(when > till && !when.startsWith(till))));
        out += s.slice(last, m.index);
        last = m.index + all.length;
        if (show) { out += body; continue; }
        hidden++;
        // скрытый отрывок не оставляет двойных пробелов, пробела перед знаком препинания и в начале строки
        const next = s.charAt(last);
        if (/[ \t]$/.test(out) && (next === '' || /[\s,.;:!?)\]»…]/.test(next))) out = out.replace(/[ \t]+$/, '');
        else if ((out === '' || out.endsWith('\n')) && /[ \t]/.test(next)) while (/[ \t]/.test(s.charAt(last))) last++;
    }
    return { text: out + s.slice(last), hidden };
}

/** Текст записи на дату (копия записи, если что-то поменялось) — для промпта и для расширок, читающих книги. */
function entryAt(entry, at) {
    if (typeof entry?.content !== 'string' || !entry.content.includes('⟦')) return { entry, hidden: 0 };
    const r = atDate(entry.content, at);
    return { entry: { ...entry, content: r.text }, hidden: r.hidden };
}

export function filterLore(payload, scope, books) {
    const stats = { dropped: 0, enabled: 0, trimmed: 0, byBook: {} };
    const at = scope?.date || scope?.eraFrom || null;
    for (const key of LORE_KEYS) {
        const arr = payload?.[key];
        if (!Array.isArray(arr)) continue;
        for (let i = arr.length - 1; i >= 0; i--) {
            const verdict = judgeEntry(arr[i], scope, books);
            if (verdict === 'drop') {
                if (!arr[i].disable) {
                    stats.dropped++;
                    stats.byBook[arr[i].world] = (stats.byBook[arr[i].world] || 0) + 1;
                }
                arr.splice(i, 1);
                continue;
            }
            if (verdict === 'enable') {
                arr[i].disable = false;
                stats.enabled++;
            }
            const r = entryAt(arr[i], at);
            if (r.entry !== arr[i]) {
                arr[i] = r.entry;
                if (r.hidden && !r.entry.disable) stats.trimmed++;
            }
        }
    }
    return stats;
}

// ───────────── персона ─────────────

/** Правки персоны эпохи — внутри текста персоны в промпте. Возвращает число применённых правок. */
/** Правки эпохи (find → replace) к тексту персоны. Возвращает новый текст и число сработавших правок. */
export function patchText(text, patches) {
    let fixed = String(text ?? '');
    let n = 0;
    for (const p of Array.isArray(patches) ? patches : []) {
        if (p?.find && fixed.includes(p.find)) {
            fixed = fixed.split(p.find).join(p.replace ?? '');
            n++;
        }
    }
    return { text: fixed, n };
}

export function patchPersona(messages, description, patches) {
    const desc = String(description || '').trim();
    if (!desc || !Array.isArray(patches) || !patches.length) return 0;
    const { text: fixed, n } = patchText(desc, patches);
    if (!n) return 0;
    let hit = false;
    for (const m of messages || []) {
        if (typeof m?.content === 'string' && m.content.includes(desc)) {
            m.content = m.content.split(desc).join(fixed);
            hit = true;
        } else if (Array.isArray(m?.content)) {
            for (const part of m.content) {
                if (typeof part?.text === 'string' && part.text.includes(desc)) {
                    part.text = part.text.split(desc).join(fixed);
                    hit = true;
                }
            }
        }
    }
    return hit ? n : 0;
}

// ───────────── кто говорит ─────────────

/** Личность говорящего: по аватару карточки (обличья Реестра знают свои карточки), иначе по имени. */
export function speakerOf(data, character, fallbackName) {
    const avatar = character?.avatar;
    if (avatar) {
        const hit = records(data, 'identity').find(g => (g.slices || []).some(s => s.card === avatar));
        if (hit) return hit.id;
    }
    return findIdentity(data, character?.name || fallbackName)?.id || null;
}

/** Персона пользователя в Реестре — личность с полем persona. */
export function personaIdentity(data) {
    return records(data, 'identity').find(g => g.persona)?.id || null;
}

/** Аватар персоны на эпоху: у обличья эпохи (era.persona) свой файл — иначе базовый аватар личности-персоны. */
export function eraPersonaAvatar(data, era) {
    const id = records(data, 'identity').find(g => g.persona);
    if (!id) return null;
    const slice = (id.slices || []).find(sl => sl.id === era?.persona);
    return { base: id.persona, target: slice?.persona || id.persona };
}

/**
 * Какой аватар персоны нужен этому чату. В отмеченном чате — аватар эпохи. В неотмеченном трогаем только
 * своих двойников (mine): с них возвращаем на базовый; чужие персоны не трогаем. null — ничего не делать.
 */
export function wantedPersona(av, explicit, current, mine = []) {
    if (!av?.base) return null;
    const target = explicit ? av.target : (mine.includes(current) ? av.base : null);
    return target && target !== current ? target : null;
}

/**
 * Двойник базовой персоны под аватар эпохи: то же имя, описание — базовое с правками эпохи (его видят и другие
 * расширки, читающие персону), без привязок к персонажам.
 */
/**
 * ST сам заводит персону «[Unnamed Persona]» с пустым описанием для каждой новой картинки в User Avatars.
 * Это заглушка, а не персона, которую завели руками, — двойник её спокойно заменяет.
 */
export function isPlaceholderPersona(pu, avatar) {
    if (!pu?.personas || !(avatar in pu.personas)) return false;
    const name = String(pu.personas[avatar] ?? '').trim();
    const desc = String(pu.persona_descriptions?.[avatar]?.description ?? '').trim();
    return !desc && (!name || /^\[.*\]$/.test(name));
}

export function clonePersona(pu, base, avatar, patches = []) {
    const desc = pu?.persona_descriptions?.[base];
    if (!pu?.personas?.[base] || !desc) return false;
    pu.personas[avatar] = pu.personas[base];
    const copy = JSON.parse(JSON.stringify(desc));
    copy.description = patchText(copy.description, patches).text;
    pu.persona_descriptions[avatar] = { ...copy, connections: [] };
    return true;
}

let personasModule = null;
/** Функции персон ST (setUserAvatar, user_avatar). В тестах подменяется. */
export function _setPersonasApi(api) { personasModule = api; }
async function personasApi() {
    if (personasModule) return personasModule;
    for (const path of ['../../../personas.js', '/scripts/personas.js']) {
        try {
            const m = await import(path);
            if (typeof m?.setUserAvatar === 'function') { personasModule = m; return m; }
        } catch { /* следующий путь */ }
    }
    return null;
}

async function userAvatarFiles() {
    try {
        const c = ctx();
        const r = await fetch('/api/avatars/get', { method: 'POST', headers: c.getRequestHeaders?.() || {} });
        if (!r.ok) return null;
        const list = await r.json();
        return Array.isArray(list) ? list : null;
    } catch { return null; }
}

/** Переключить персону под эпоху чата (только при смене чата). */
async function syncPersonaAvatar(data, era, explicit) {
    if (!settings().persona || switchingPersona || !data || !era) return;
    const av = eraPersonaAvatar(data, era);
    if (!av) return;
    const api = await personasApi();
    if (!api) return;
    const st = settings();
    const mine = Array.isArray(st.eraPersonas) ? st.eraPersonas : (st.eraPersonas = []);
    const current = api.user_avatar;
    const target = wantedPersona(av, explicit, current, mine);
    // двойник эпохи, на котором должен стоять этот чат (отмеченный чат эпохи со своим аватаром)
    const twin = explicit && av.target !== av.base ? av.target : null;
    lastAvatar = { avatar: current, base: av.base, missing: null, switched: false };
    // ST мог уже сам выбрать двойника по закреплению чата — тогда переключать нечего, но двойника проверить надо
    if (!target && !(twin && current === twin)) return;
    const want = target || twin;
    const files = await userAvatarFiles();
    if (files && !files.includes(want)) { lastAvatar.missing = want; return; }
    const c = ctx();
    const pu = c.powerUserSettings;
    if (want === twin && pu && (!pu.personas?.[twin] || mine.includes(twin) || isPlaceholderPersona(pu, twin))) {
        // двойник держится в ногу с базовой персоной: правишь её — двойник обновится при следующем входе
        if (clonePersona(pu, av.base, twin, era.personaPatches) && !mine.includes(twin)) mine.push(twin);
        c.saveSettingsDebounced?.();
    }
    if (!target) {
        // уже на двойнике: перевыбрать, только если ST держит в памяти старое имя или старый текст персоны
        const stale = pu && (c.name1 !== pu.personas?.[twin]
            || String(pu.persona_description ?? '') !== String(pu.persona_descriptions?.[twin]?.description ?? ''));
        if (!stale) return;
    }
    switchingPersona = true;
    try {
        await api.setUserAvatar(want, { toastPersonaNameChange: false });
    } finally {
        switchingPersona = false;
    }
    lastAvatar = { avatar: want, base: av.base, missing: null, switched: true };
    // ST мог перечитать чат после смены персоны — берём свежие метаданные
    const fresh = ctx();
    if (explicit && want !== av.base && fresh.chatMetadata && fresh.chatMetadata.persona !== want) {
        fresh.chatMetadata.persona = want;   // закрепить за чатом: ST и сам выберет её при следующем входе
        await fresh.saveMetadata?.();
    }
}

// ───────────── Хроника под дату ─────────────

const CHRON_KINDS = ['fixed', 'event', 'arc', 'state'];
const CHRON_SYM = { fixed: '◆', event: '●', arc: '▬', state: '▬' };

/** ★ХРОНОЛОГИЯ (legacy → render:chronicle) живёт в этой эпохе? Тогда сводку не собираем — не дублируем. */
export function legacyChronicleActive(book, eraId) {
    return Object.values(book?.entries || {}).some(e => e?.gc?.kind === 'legacy' && !e.disable
        && (e.gc.replacedBy || []).includes('render:chronicle') && (!Array.isArray(e.gc.eras) || e.gc.eras.includes(String(eraId))));
}

/**
 * Хроника под дату — вместо ★ХРОНОЛОГИИ. Прошлое: события, отрезки и фиксированные точки до даты сюжета, только
 * видимые говорящему (дата, знание); состояние — только пока длится; далёкое — сводкой родителя (подсобытия
 * закрытых до эпохи отрезков не дублируем). Впереди: ближайшие фиксированные точки — режиссёрской пометкой «не
 * ломать», персонажи о них не знают.
 */
/** Сыграно ли событие: gc.played (true или дата сцены) или пришло из чата (src.chat / src.stmb). */
const playedEvent = (g) => !!g?.played || (typeof g?.src === 'object' && !!(g.src?.chat || g.src?.stmb));
/** Событие своей эпохи позже её начала (или крупнее: год, с которого она начинается) и ещё не сыгранное. */
export function heldInEra(g, eraFrom) {
    if (!g || g.kind !== 'event' || playedEvent(g) || !eraFrom) return false;
    const f = String(g.from);
    const from = String(eraFrom);
    return f > from || (f !== from && from.startsWith(f));
}

export function chronicleBlock(book, scope, books, { world, eraFrom, ahead = 4, maxPast = 40 } = {}) {
    const at = scope?.date || scope?.eraFrom;
    const out = { text: '', past: 0, ahead: 0, held: 0 };
    if (!book?.entries || !at) return out;
    const all = Object.entries(book.entries)
        .map(([k, e]) => ({ ...e, uid: e?.uid ?? Number(k) }))
        .filter(e => e && CHRON_KINDS.includes(e.gc?.kind) && e.gc.from && (!e.gc.status || e.gc.status === 'canon'));
    const byUid = new Map(all.map(e => [Number(e.uid), e]));
    const line = e => {
        const t = String(e.comment || '').trim();
        return /^[◆●▬▭■]/.test(t) ? t : `${CHRON_SYM[e.gc.kind] || '•'} ${t}`;
    };
    const from = String(eraFrom || at);
    const sp = scope?.speaker || null;
    const memo = new Map();
    // кто что знает: мировые фиксированные точки и public — всем; личная история — участникам (who) и тем, кому
    // известно (knows); рассказчику — всё несекретное; подсобытия тайного отрезка — только если виден сам отрезок
    const knowsAt = (g) => !!sp && Array.isArray(g?.knows?.[sp]) && g.knows[sp].some(s => s.mode === 'knows' && covers(s, at));
    const visible = (e) => {
        const id = Number(e.uid);
        if (memo.has(id)) return memo.get(id);
        const g = e.gc;
        const open = g.kind === 'fixed' || isPublic(g, at);
        // сыграно раньше расчётной даты — судим по дате сцены
        const gg = typeof g.played === 'string' && g.played ? { ...g, from: g.played } : g;
        let ok = judgeEntry({ ...e, gc: gg, world, disable: false }, scope, books) !== 'drop';
        if (ok && !open && g.parent != null) {
            const p = byUid.get(Number(g.parent));
            if (p?.gc?.secret && !knowsAt(p.gc)) ok = false;   // подсобытие тайного отрезка — тайна и само
        }
        if (ok && !open) ok = sp ? ((g.who || []).includes(sp) || knowsAt(g)) : !g.secret;
        memo.set(id, ok);
        return ok;
    };
    // событие своей эпохи — позже её начала (или крупнее: год, в котором она начинается) — в «что было», только когда
    // сыграно: gc.played (true или дата сцены) или пришло из чата (src.chat / src.stmb). Ролка могла до него ещё не
    // дойти — сводка не должна обгонять чат. Дата ровно в начало эпохи — завязка, она уже была.
    const held = (g) => heldInEra(g, from);
    const when = (g) => (typeof g.played === 'string' && g.played ? g.played : String(g.from));
    const seen = all.filter(e => when(e.gc) <= at
        && !held(e.gc)
        && !(e.gc.kind === 'state' && e.gc.to && !(at < String(e.gc.to)))
        && visible(e));
    out.held = all.filter(e => held(e.gc) && String(e.gc.from) <= at && visible(e)).length;
    const keep = new Set(seen);
    const past = seen.filter(e => {
        const p = e.gc.parent != null ? byUid.get(Number(e.gc.parent)) : null;
        return !(p && keep.has(p) && p.gc.to && String(p.gc.to) <= from);   // далёкий отрезок — одной строкой родителя
    }).sort((a, b) => when(a.gc).localeCompare(when(b.gc)));
    const tail = past.slice(-maxPast);
    const next = all.filter(e => e.gc.kind === 'fixed' && String(e.gc.from) > at)
        .sort((a, b) => String(a.gc.from).localeCompare(String(b.gc.from))).slice(0, ahead);
    const parts = [];
    if (tail.length) parts.push(`[Хроника мира — что было до ${fmtDate(at)} и что из этого известно говорящему]\n` + tail.map(line).join('\n'));
    if (next.length) parts.push('[Режиссёру, не знание персонажей: впереди фиксированные точки — сюжет к ним придёт, ломать нельзя, персонажи о них не знают]\n' + next.map(line).join('\n'));
    out.text = parts.join('\n\n');
    out.past = tail.length;
    out.ahead = next.length;
    return out;
}

/**
 * Обрывки памяти (карта знания, mode «fragments»): что у говорящего на эту дату всплывает без имён. Текст — gc.hint
 * события (строка или { id говорящего | '*': строка }); без подсказки обрывок не показываем — в заголовках имена.
 * Для персонажа это не знание, а подтекст: тело, запах, слово, дежавю; узнавания быть не может. Кто знает — не обрывки.
 */
export function fragmentsBlock(book, scope, { max = 5 } = {}) {
    const at = scope?.date || scope?.eraFrom;
    const sp = scope?.speaker || null;
    const out = { text: '', count: 0 };
    if (!book?.entries || !at || !sp) return out;
    const seen = new Set();
    const lines = Object.values(book.entries)
        .filter(e => e?.gc && (!e.gc.status || e.gc.status === 'canon'))
        .map(e => {
            const g = e.gc;
            const spans = g.knows?.[sp];
            if (!Array.isArray(spans) || spans.some(s => s.mode === 'knows' && covers(s, at))) return null;
            if (!spans.some(s => s.mode === 'fragments' && covers(s, at))) return null;
            const h = typeof g.hint === 'string' ? g.hint : (g.hint?.[sp] || g.hint?.['*']);
            return h && String(h).trim() ? { from: String(g.from || ''), text: String(h).trim() } : null;
        })
        .filter(x => x && !seen.has(x.text) && seen.add(x.text))
        .sort((a, b) => a.from.localeCompare(b.from))
        .slice(0, max);
    if (!lines.length) return out;
    out.count = lines.length;
    out.text = '[Подтекст — обрывки памяти говорящего: всплывают без имён и без смысла — телом, запахом, словом, дежавю. '
        + 'Он не знает, откуда они, и ни с кем их не связывает. Не объясняй и не превращай в узнавание]\n'
        + lines.map(l => `— ${l.text}`).join('\n');
    return out;
}

/** Кто из сцены на эту дату носит обрывки (для Стража): id → есть хоть один отрезок «fragments». */
export function fragmentHolders(book, at, ids = []) {
    if (!book?.entries || !at) return [];
    const has = id => Object.values(book.entries).some(e => {
        const spans = e?.gc?.knows?.[id];
        return Array.isArray(spans) && spans.some(s => s.mode === 'fragments' && covers(s, at))
            && !spans.some(s => s.mode === 'knows' && covers(s, at));
    });
    return [...new Set(ids.filter(Boolean))].filter(has);
}

// ───────────── кто есть кто ─────────────

/** Строки эпохи на дату: у строки бывают from/to (как у записей Хроники) и speaker — только на его ходу. */
export function whoLines(era, at, speaker) {
    if (!Array.isArray(era?.who)) return [];
    return era.who
        .filter(w => w && w.text && (!w.speaker || w.speaker === speaker)
            && (at ? covers(w, at) : w.from == null && w.to == null))
        .map(w => String(w.text).trim());
}

/** Кого ядро закомментировало в составе Закулисья (и ты не вернула) — их нет в этом времени. */
export function absentNames(roster) {
    return String(roster || '').split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('#') && l.includes('← нет в эпохе'))
        .map(l => l.replace(/^#\s*/, '').split('|')[0].trim())
        .filter(Boolean);
}

/** Почему личности нет на дату: её gc.gone (с from/to), иначе по died / born, иначе «нет в этом времени». */
export function goneReason(identity, at) {
    const hit = (identity?.gone || []).find(s => s && s.text && covers(s, at));
    if (hit) return hit.text;
    if (identity?.died && at && at >= String(identity.died)) return `нет в живых с ${fmtDate(identity.died)}`;
    if (identity?.born && at && at < String(identity.born)) return 'ещё не на свете';
    return 'нет в этом времени';
}

/**
 * Шпаргалка «кто есть кто» на дату. Только для эпох, у которых в Реестре есть список who (пусть пустой):
 * строки эпохи + кого нет в этом времени и почему. Пусто — ''.
 */
export function whoBlock(data, era, date, speaker, roster) {
    if (!Array.isArray(era?.who)) return '';
    const at = date || era.from || null;
    const lines = whoLines(era, at, speaker);
    const gone = new Map();
    for (const name of absentNames(roster)) {
        const id = findIdentity(data, name);
        if (!id) continue;
        const why = at ? goneReason(id, at) : 'нет в этом времени';
        if (!gone.has(why)) gone.set(why, []);
        if (!gone.get(why).includes(id.name)) gone.get(why).push(id.name);
    }
    if (gone.size) lines.push('Нет в этом времени: ' + [...gone].map(([why, names]) => `${names.join(', ')} — ${why}`).join('; ') + '.');
    if (!lines.length) return '';
    return `[Хроника — кто есть кто${date ? ` на ${fmtDate(date)}` : ''}]\n` + lines.map(l => `— ${l}`).join('\n');
}

// ───────────── состояние чата ─────────────

/** Эпоха и дата открытого чата. explicit — эпоха отмечена в Реестре, а не взята по умолчанию. */
async function resolve() {
    const c = ctx();
    const chatId = c.getCurrentChatId?.() || null;
    const data = await loadRegistry();
    const md = c.chatMetadata;
    let era = null;
    let explicit = false;
    let world = null;   // id мира чата; null — чат чужого мира (или Реестра нет)
    if (data && chatId) {
        era = findEra(data, { marker: md?.[MODULE]?.era, chatId, groupId: c.groupId });
        explicit = !!era;
        if (era || inWorld(data, chatCards(c))) world = worldRecord(data)?.id || 'world';
        if (!era && world) era = eraById(data, worldRecord(data)?.defaultEra);
    }
    let date = null;
    let dateSource = '';
    if (era) {
        const sd = storyDate(md, c.chat);
        date = clampDate(sd.date, era);
        dateSource = sd.source;
        if (!date && era.to) { date = era.from; dateSource = 'начало эпохи'; }
    }
    current = { chatId, era, explicit, date, dateSource, world, registry: current.registry };
    return { data, era, explicit, date, md, world };
}

// ───────────── память эпохи ─────────────

/**
 * Какую книгу поставить книгой чата, чтобы память эпохи писалась в её меморибук. STMB пишет в книгу чата, ST её же
 * подаёт в промпт. Только у эпох с bindMemory и только в каноничном чате; чужую книгу чата не перебиваем — меняем
 * только пустую или одну из книг эпохи (их ядро и так подключает само). null — ничего не делать.
 */
export function memoryBinding(era, explicit, chatId, current) {
    if (!explicit || !era?.bindMemory || !era.memoryBook || !chatId || chatId !== era.canonChat) return null;
    if (current === era.memoryBook) return null;
    if (current && !(era.lore || []).includes(current)) return null;
    return era.memoryBook;
}

async function bindEraMemory(era, explicit, chatId) {
    const md = ctx().chatMetadata;
    lastMemory = null;
    if (!explicit || !era?.memoryBook || !md) return;
    const isCanon = chatId === era.canonChat;
    lastMemory = { book: era.memoryBook, bound: md.world_info === era.memoryBook, missing: false,
        other: md.world_info && md.world_info !== era.memoryBook ? md.world_info : null, canon: isCanon };
    const want = memoryBinding(era, explicit, chatId, md.world_info);
    if (!want) return;
    const known = ctx().getWorldInfoNames?.();
    if (Array.isArray(known) && !known.includes(want)) { lastMemory.missing = true; return; }
    md.world_info = want;
    await ctx().saveMetadata?.();
    lastMemory.bound = true;
    lastMemory.other = null;
    const msg = `Память эпохи ${era.id}: книга чата теперь «${want}» — STMB пишет туда.`;
    console.log(TAG, msg);
    try { window.toastr?.info(msg, 'Священный таймлайн', { timeOut: 8000 }); } catch { /* ignore */ }
}

/**
 * Меморибуки эпох раньше этой (у которых ядро ведёт память, bindMemory) — их эта эпоха видит как историю:
 * размеченные записи (дата, кто знает) идут в промпт через тот же фильтр, что и всё остальное.
 */
export function historyBooks(data, era) {
    if (!era?.from) return [];
    return records(data, 'era')
        .filter(e => e.bindMemory && e.memoryBook && String(e.id) !== String(era.id) && e.from && String(e.from) < String(era.from))
        .sort((a, b) => String(a.from).localeCompare(String(b.from)))
        .map(e => e.memoryBook);
}

/** Запись STMemoryBooks — память сцены. */
export const isMemoryEntry = e => !!e && (e.STMB_start !== undefined || e.stmemorybooks !== undefined);

/** В историю других эпох уходит только размеченная память: без даты и знания запись остаётся в своей эпохе. */
export const isTaggedMemory = e => e?.gc?.kind === 'memory' && (!e.gc.status || e.gc.status === 'canon') && !e.disable;

/**
 * Разметить свежие записи STMB в меморибуке эпохи: дата сцены (по трекеру/Horae у последнего сообщения сцены,
 * иначе дата чата), эпоха, кто был в сцене — те и знают, откуда (чат, сообщения). Размеченные не трогает.
 * Возвращает число размеченных.
 */
export function tagMemories(book, { data, era, chat, md, chatId }) {
    let n = 0;
    const list = Array.isArray(chat) ? chat : [];
    const persona = personaIdentity(data);
    for (const e of Object.values(book?.entries || {})) {
        if (!isMemoryEntry(e) || e.gc) continue;
        const b = Number(e.STMB_end);
        const end = Number.isFinite(b) ? Math.min(b, list.length - 1) : list.length - 1;
        const a = Number(e.STMB_start);
        const start = Number.isFinite(a) ? Math.max(0, a) : Math.max(0, end);
        const scene = list.slice(0, end + 1);
        const date = clampDate(storyDate({}, scene).date || storyDate(md, list).date, era) || era.from || null;
        const who = [];
        for (const m of scene.slice(start)) {
            if (!m || m.is_system) continue;
            const id = m.is_user ? persona : speakerOf(data, { avatar: m.original_avatar, name: m.name }, m.name);
            if (id && !who.includes(id)) who.push(id);
        }
        const knows = {};
        for (const id of who) knows[id] = [{ from: date, mode: 'knows' }];
        e.gc = { v: 1, kind: 'memory', era: String(era.id), from: date, who, secret: true, knows,
            src: { era: String(era.id), chat: chatId || null, msgs: [start, end] }, status: 'canon' };
        n++;
    }
    return n;
}

let tagging = false;
/**
 * Разметить память эпохи в её каноничном чате (после записи STMB и при входе в чат). Хронист: свежая размеченная
 * память — подзаписью Хроники 🟡 на проверке (только каноничный чат эпохи).
 */
async function tagEraMemory(name, book) {
    if (tagging) return 0;
    const c = ctx();
    const chatId = c.getCurrentChatId?.();
    const { data, era, explicit } = await resolve();
    if (!data || !explicit || !era?.bindMemory || !era.memoryBook || chatId !== era.canonChat) return 0;
    if (name && name !== era.memoryBook) return 0;
    if (c.chatMetadata?.world_info !== era.memoryBook) return 0;
    tagging = true;
    try {
        const b = book || await c.loadWorldInfo?.(era.memoryBook);
        if (!b?.entries) return 0;
        const n = tagMemories(b, { data, era, chat: c.chat, md: c.chatMetadata, chatId });
        let drafts = [];
        const w = worldRecord(data);
        if (settings().chronist && w?.chronicle) {
            const chron = await c.loadWorldInfo?.(w.chronicle);
            if (chron?.entries) {
                drafts = chronicleDrafts(b, era.memoryBook, chron, era, chatId);
                if (drafts.length) await c.saveWorldInfo?.(w.chronicle, chron, true);
            }
        }
        if (n || drafts.length) {
            await c.saveWorldInfo?.(era.memoryBook, b, true);
            console.log(TAG, `память эпохи ${era.id}: размечено записей — ${n}, подзаписей Хроники на проверке — ${drafts.length}`);
        }
        if (drafts.length) processDrafts(drafts).catch(e => console.warn(TAG, 'Хронист и Ревизор', e));
        return n;
    } finally {
        tagging = false;
    }
}

// ───────────── канон: Страж, Хронист, Ревизор (план 07.11) ─────────────
//
// Страж — графа «canon» в Летописце Life (LifeBridge): после поста дешёвая модель Летописца сверяет пост с каноном
// эпохи — фиксированные точки впереди, кого нет в этом времени, кто в сцене каких тайн не знает — и ставит 🚩.
// Хронист — память STMB каноничного чата эпохи (уже с датой и знанием) становится подзаписью Хроники 🟡 «на проверке».
// Ревизор — сильная модель (свой профиль подключения) сверяет подзапись с Хроникой: в рамках или нексус.
// Решаешь ты: ✓ вписать в таймлайн · ○ только память · ⑂ своё (ветка: в историю других эпох не идёт) · ✂ подрезать.
// В Хронику пишет только каноничный чат эпохи.

export const DRAFT_MARK = { review: '🟡', nexus: '🚩', canon: '✓', own: '⑂' };
const DRAFT_OPEN = ['review', 'nexus', 'own'];

export const STRAZH_RULE = `

canon — Страж канона по ЭТОМУ посту, по строкам «Канон»: {"flag":"ok"}, если пост в рамках. Иначе {"flag":"warn" или "break","what":"что не так, 6–16 слов","fix":"как поправить, 6–14 слов"}. break — пост ломает фиксированную точку или в сцене действует тот, кого в этом времени нет; warn — кто-то знает то, чего знать не может (тайну из списка, будущее), или пост расходится с каноном. Стиль, мелочи и выдумки, которые канону не мешают, — не твоё. Сомневаешься — ok.`;

const cleanTitle = (t) => String(t || '').replace(/^[◆●▬▭■•]\s*/, '').trim();

/** Строки «Канон» для Стража: дата, фиксированные точки впереди, кого нет, тайны среди тех, кто в сцене. */
export function canonBrief({ data, era, date, book, cast = [] }) {
    const at = date || era?.from || null;
    if (!era || !at) return '';
    const ids = records(data, 'identity');
    const nameOf = id => ids.find(g => g.id === id)?.name || id;
    const lines = [`Канон (Священный таймлайн): эпоха «${era.label || era.id}», дата сюжета — ${fmtDate(at)}. Никто не знает будущего — того, что случится позже этой даты.`];
    const entries = Object.values(book?.entries || {}).filter(e => e?.gc && CHRON_KINDS.includes(e.gc.kind) && e.gc.from
        && (!e.gc.status || e.gc.status === 'canon'));
    const ahead = entries.filter(e => e.gc.kind === 'fixed' && String(e.gc.from) > at)
        .sort((a, b) => String(a.gc.from).localeCompare(String(b.gc.from))).slice(0, 4);
    if (ahead.length) lines.push(`Канон — впереди, ломать нельзя (в сцене о них не знают): ${ahead.map(e => cleanTitle(e.comment)).join('; ')}.`);
    const gone = ids.filter(g => (g.slices || []).length && !presentAt(g, at)).map(g => `${g.name} — ${goneReason(g, at)}`);
    if (gone.length) lines.push(`Канон — в этом времени нет (не могут быть в сцене): ${gone.slice(0, 10).join('; ')}.`);
    const who = [...new Set(cast.filter(Boolean))];
    const frag = fragmentHolders(book, at, who);
    if (frag.length) lines.push(`Канон — обрывки памяти (только подтекст, без имён; узнавания быть не может): ${frag.map(nameOf).join(', ')}.`);
    if (who.length > 1) {
        const knowsAt = (g, id) => (g.knows && typeof g.knows === 'object'
            ? (g.knows[id] || []).some(s => s.mode === 'knows' && covers(s, at))
            : (g.who || []).includes(id));
        const secrets = [];
        for (const e of entries) {
            const g = e.gc;
            if (!g.secret || String(g.from) > at || isPublic(g, at) || heldInEra(g, era.from)) continue;
            if (g.kind === 'state' && g.to && at > String(g.to) && !at.startsWith(String(g.to))) continue;
            const yes = who.filter(id => knowsAt(g, id));
            const no = who.filter(id => !yes.includes(id));
            // в сцене был, а не знает (обманутый участник) — проговориться тут проще всего, такие — первыми
            const blind = no.some(id => (g.who || []).includes(id)) ? 1 : 0;
            if (yes.length && no.length) secrets.push({ e, yes, no, blind });
        }
        secrets.sort((a, b) => (b.blind - a.blind) || String(b.e.gc.from).localeCompare(String(a.e.gc.from)));
        if (secrets.length) {
            lines.push('Канон — тайны среди тех, кто в сцене (кто не знает, тот проговориться не может):\n' + secrets.slice(0, 8)
                .map(({ e, yes, no }) => `- ${cleanTitle(e.comment)} — знает: ${yes.map(nameOf).join(', ')}; НЕ знает: ${no.map(nameOf).join(', ')}`).join('\n'));
        }
    }
    return lines.join('\n');
}

/** Ключ флажка Стража у поста: номер, свайп, хэш текста — свайпнули или поправили, флажок старого текста не висит. */
export function strazhKey(m, i) {
    let h = 0;
    const s = String(m?.mes || '');
    for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) | 0;
    return `${i}:${m?.swipe_id ?? 0}:${(h >>> 0).toString(36)}`;
}

/** Ответ Летописца по графе canon → запись флажка (или null, если ответа нет). */
export function strazhRecord(j) {
    const c = j?.canon;
    if (!c || typeof c !== 'object') return null;
    const flag = ['warn', 'break'].includes(String(c.flag)) ? String(c.flag) : 'ok';
    if (flag === 'ok') return { flag };
    return { flag, what: String(c.what || '').slice(0, 200), fix: String(c.fix || '').slice(0, 200), at: Date.now() };
}

function strazhStore(md) {
    const s = md && (md[MODULE] ||= {});
    if (!s) return {};
    if (!s.strazh || typeof s.strazh !== 'object') s.strazh = {};
    return s.strazh;
}

/** Подзаписи Хроники 🟡 из свежей памяти каноничного чата эпохи. Память получает ссылку gc.draft. Возвращает uid'ы. */
export function chronicleDrafts(memBook, memName, chron, era, chatId) {
    const out = [];
    if (!memBook?.entries || !chron?.entries || !era) return out;
    let next = Math.max(-1, ...Object.keys(chron.entries).map(Number).filter(Number.isFinite)) + 1;
    for (const e of Object.values(memBook.entries)) {
        const g = e?.gc;
        if (!g || g.kind !== 'memory' || g.draft != null || e.disable) continue;
        if (g.status && g.status !== 'canon') continue;
        if (String(g.era) !== String(era.id) || (chatId && g.src?.chat && g.src.chat !== chatId)) continue;
        const uid = next++;
        const title = cleanTitle(e.comment) || String(e.content || '').split('\n')[0].slice(0, 80) || 'сцена';
        chron.entries[String(uid)] = {
            uid,
            gc: { v: 1, kind: 'event', from: g.from, ...(g.who?.length ? { who: [...g.who] } : {}), secret: true,
                ...(g.knows ? { knows: JSON.parse(JSON.stringify(g.knows)) } : {}), status: 'review',
                src: { era: String(era.id), chat: g.src?.chat || chatId || null, msgs: g.src?.msgs || null, stmb: `${memName}#${e.uid}` } },
            key: [], keysecondary: [], comment: `● ${fmtDate(g.from)} — ${title}`, content: String(e.content || ''),
            constant: false, vectorized: false, selective: true, selectiveLogic: 0, addMemo: true, order: 100, position: 0,
            disable: true, excludeRecursion: false, preventRecursion: false, delayUntilRecursion: false, probability: 100,
            useProbability: true, depth: 4, group: '', groupOverride: false, groupWeight: 100, scanDepth: null,
            caseSensitive: false, matchWholeWords: false, useGroupScoring: false, automationId: '', role: 0, sticky: 0,
            cooldown: 0, delay: 0, display_index: uid,
        };
        g.draft = uid;
        out.push(uid);
    }
    return out;
}

const today = () => new Date().toISOString().slice(0, 10);
const jsonOf = (text) => {
    const s = String(text || '');
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    try { return a >= 0 && b > a ? JSON.parse(s.slice(a, b + 1)) : null; } catch { return null; }
};
const whoLine = (data, ids) => (ids || []).map(id => `${id} — ${records(data, 'identity').find(g => g.id === id)?.name || id}`).join('; ');

/** Хронисту (модель Летописца): подзапись из памяти сцены — по личностям, с последствиями для будущего. */
export function chronistPrompt(entry, data, era) {
    const g = entry.gc;
    const system = 'Ты — Летописец-хронист ролевой истории на русском. Из памяти сцены делаешь подзапись в Хронику мира. '
        + 'Ответь только JSON: {"title":"событие, 4–9 слов","content":"что случилось — 1–3 предложения; затем строка «По личностям:» '
        + 'и по строке на человека — что он узнал, почувствовал, решил; затем «Последствия для будущего:» — 1–2 предложения",'
        + '"who":["id из списка «Кто был»"]}. Только то, что есть в памяти, — ничего не выдумывай.';
    const user = [`Эпоха: ${era?.label || era?.id || '?'}. Дата сцены: ${fmtDate(g.from)}.`,
        `Кто был (id — имя): ${whoLine(data, g.who) || '—'}`,
        `Память сцены «${cleanTitle(entry.comment)}»:`, String(entry.content || '').slice(0, 6000)].join('\n');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Ответ Хрониста → подзапись (заголовок, текст, кто — только из тех, кто был в сцене). */
export function applyChronist(entry, text) {
    const j = jsonOf(text);
    if (!j || !String(j.content || '').trim()) throw new Error('Хронист ответил не по форме');
    const title = cleanTitle(j.title) || cleanTitle(entry.comment).replace(/^\S+\s+—\s+/, '');
    entry.comment = `● ${fmtDate(entry.gc.from)} — ${title}`;
    entry.content = String(j.content).trim();
    const was = entry.gc.who || [];
    const who = Array.isArray(j.who) ? j.who.map(String).filter(id => was.includes(id)) : [];
    if (who.length) entry.gc.who = who;
    entry.gc.chronist = today();
    return true;
}

function canonRows(book, at) {
    const year = Number(String(at).slice(0, 4)) || 0;
    const all = Object.entries(book?.entries || {}).filter(([, e]) => e?.gc && CHRON_KINDS.includes(e.gc.kind) && e.gc.from
        && (!e.gc.status || e.gc.status === 'canon'));
    const row = ([, e]) => {
        const x = e.gc;
        const bits = [x.to ? `${x.from}…${x.to}` : x.from, x.who?.length ? `кто: ${x.who.join(', ')}` : '',
            x.secret ? `тайна${x.knows ? `; знают: ${Object.entries(x.knows).map(([id, sp]) => `${id} с ${sp.map(s => s.from).join('/')}`).join(', ')}` : ''}` : ''];
        return `- ${cleanTitle(e.comment)} (${bits.filter(Boolean).join('; ')})${x.kind === 'fixed' ? '' : `: ${String(e.content || '').replace(/\s+/g, ' ').slice(0, 220)}`}`;
    };
    return {
        fixed: all.filter(([, e]) => e.gc.kind === 'fixed').map(row),
        near: all.filter(([, e]) => e.gc.kind !== 'fixed' && Math.abs((Number(String(e.gc.from).slice(0, 4)) || 0) - year) <= 3).map(row),
    };
}

const postsText = (posts) => (posts || []).map(p => `[${p.i}] ${p.name || ''}: ${String(p.mes || '').slice(0, 2500)}`).join('\n\n');

/**
 * Ревизору (сильная модель, свой профиль): подзапись сверить с постами-источником (ошибка Хрониста — правит сам) и с
 * каноном (ролка ему противоречит — только нексус). posts — [{ i, name, mes }] сцены, если чат-источник открыт.
 */
export function reviserPrompt(entry, book, era, posts = []) {
    const g = entry.gc;
    const at = String(g.from || era?.from || '');
    const { fixed, near } = canonRows(book, at);
    const system = 'Ты — Ревизор Священного таймлайна (служба надзора за временем) для ролевой истории на русском. Канон решает автор; '
        + 'ты сверяешь подзапись Хроники: (1) с постами-источником — если Хронист приписал то, чего в постах нет, или перепутал, '
        + 'исправь подзапись сам (fix); (2) с каноном — Хроникой мира: фиксированные точки, даты, кто где и жив ли, кто что знает и '
        + 'с какого времени. Ответь только JSON: {"fix":null или {"title":"…","content":"…"},"verdict":"ok" или "nexus",'
        + '"why":"коротко","conflicts":[{"with":"запись Хроники","what":"в чём расхождение"}],"touched":["что ещё задето, если '
        + 'вписать новое: записи Хроники, лорбуки, память, посты других эпох"]}. nexus — только если сама ролка противоречит канону; '
        + 'ошибка Хрониста — это fix, не нексус. Подробности сцены, которых в Хронике просто нет, — не расхождение.';
    const user = [`Эпоха: ${era?.label || era?.id || '?'}. Дата события: ${fmtDate(at)}.`,
        `Подзапись Хроники: ${cleanTitle(entry.comment)}`, g.who?.length ? `Кто был: ${g.who.join(', ')}` : '',
        String(entry.content || '').slice(0, 3000),
        posts.length ? `\nПосты-источник:\n${postsText(posts)}` : '\n(Постов-источника под рукой нет — сверяй только с каноном.)',
        '', 'Канон — фиксированные точки:', ...fixed, '', 'Канон — события рядом по времени (±3 года):', ...near].filter(Boolean).join('\n');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function setText(entry, fix) {
    if (!fix || !String(fix.content || '').trim()) return false;
    entry.gc.prev = { comment: entry.comment, content: entry.content };
    if (cleanTitle(fix.title)) entry.comment = `● ${fmtDate(entry.gc.from)} — ${cleanTitle(fix.title)}`;
    entry.content = String(fix.content).trim();
    entry.gc.fixed = today();
    return true;
}

/** Ответ Ревизора → подзапись: правка Хрониста (с откатом), в рамках — сразу в канон, расхождение — нексус. */
export function applyReview(entry, text) {
    const j = jsonOf(text);
    if (!j || !['ok', 'nexus'].includes(j.verdict)) throw new Error('Ревизор ответил не по форме');
    setText(entry, j.fix);
    entry.gc.review = { verdict: j.verdict, why: String(j.why || '').slice(0, 400),
        conflicts: Array.isArray(j.conflicts) ? j.conflicts.slice(0, 6).map(c => ({ with: String(c?.with || ''), what: String(c?.what || '') })) : [],
        touched: Array.isArray(j.touched) ? j.touched.slice(0, 10).map(String) : [], at: today() };
    if (j.verdict === 'nexus') {
        entry.gc.status = 'nexus';
        entry.gc.nexus = [{ note: entry.gc.review.why, refs: entry.gc.review.conflicts.map(c => c.with) }];
    } else {
        entry.gc.status = 'canon';
        delete entry.gc.nexus;
    }
    return j.verdict;
}

/** Откатить правку Ревизора. */
export function revertFix(entry) {
    const p = entry?.gc?.prev;
    if (!p) return false;
    entry.comment = p.comment;
    entry.content = p.content;
    delete entry.gc.prev;
    delete entry.gc.fixed;
    return true;
}

/**
 * Нексус решает она: 'canon' — вписать в таймлайн (побеждает новое; что задето — списком в gc.touched, разгребём);
 * 'own' — своё: её слова, как разрулить (gc.resolution), пока Ревизор их не применит.
 */
export function decideNexus(entry, act, words = '') {
    if (!entry?.gc) return false;
    if (act === 'canon') {
        entry.gc.status = 'canon';
        entry.gc.decided = today();
        entry.gc.touched = [...new Set([...(entry.gc.review?.touched || []), ...(entry.gc.review?.conflicts || []).map(c => c.with).filter(Boolean)])];
        return true;
    }
    if (act === 'own' && String(words).trim()) {
        entry.gc.status = 'own';
        entry.gc.resolution = String(words).trim().slice(0, 1500);
        entry.gc.decided = today();
        return true;
    }
    return false;
}

/** Ревизору — применить её слова: переписать подзапись так, как она решила, и сказать, что ещё задето. */
export function resolvePrompt(entry, book, era) {
    const [sys, usr] = reviserPrompt(entry, book, era);
    return [{ role: 'system', content: sys.content + ' Сейчас автор уже решила, как разрулить нексус, — её решение главнее: перепиши '
        + 'подзапись по нему (fix обязателен), verdict — "ok", в touched — что ещё поправить в каноне, чтобы сошлось.' },
    { role: 'user', content: `${usr.content}\n\nНексус: ${entry.gc.nexus?.[0]?.note || entry.gc.review?.why || '—'}\nРешение автора: «${entry.gc.resolution}»` }];
}

/** Ответ на её решение → подзапись в канон. */
export function applyResolve(entry, text) {
    const j = jsonOf(text);
    if (!j?.fix || !setText(entry, j.fix)) throw new Error('Ревизор не переписал подзапись');
    entry.gc.status = 'canon';
    entry.gc.touched = Array.isArray(j.touched) ? j.touched.slice(0, 10).map(String) : [];
    delete entry.gc.nexus;
    return true;
}

/** Подрезать: Ревизор переписывает посты ветки под хронологию — минимально, без смены голосов. */
export function prunePrompt(entry, book, era, posts) {
    const at = String(entry.gc.from || era?.from || '');
    const { fixed, near } = canonRows(book, at);
    const system = 'Ты — Ревизор Священного таймлайна. Ветка ролевой истории разошлась с каноном — подрежь её: перепиши посты сцены '
        + 'так, чтобы канон не ломался. Меняй минимально — только то, что расходится; язык, стиль, голоса и длину сохраняй. Ответь '
        + 'только JSON: {"posts":[{"i":номер поста,"mes":"новый текст целиком"}],"title":"событие после правки, 4–9 слов",'
        + '"content":"подзапись Хроники для исправленной сцены","note":"что поменял, одной фразой"}. Посты, которые менять не надо, — не пиши.';
    const user = [`Эпоха: ${era?.label || era?.id || '?'}. Дата: ${fmtDate(at)}.`,
        `Нексус: ${entry.gc.nexus?.[0]?.note || entry.gc.review?.why || '—'}`,
        ...(entry.gc.review?.conflicts || []).map(c => `- расходится с «${c.with}»: ${c.what}`),
        `\nПосты сцены:\n${postsText(posts)}`, '', 'Канон — фиксированные точки:', ...fixed, '', 'Канон — рядом по времени:', ...near].join('\n');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Ответ на «подрезать» → { posts: [{ i, mes }], title, content, note } — только посты из сцены. */
export function parsePrune(text, posts) {
    const j = jsonOf(text);
    const ids = new Set((posts || []).map(p => Number(p.i)));
    const out = (Array.isArray(j?.posts) ? j.posts : []).filter(p => ids.has(Number(p?.i)) && String(p?.mes || '').trim())
        .map(p => ({ i: Number(p.i), mes: String(p.mes) }));
    if (!out.length) throw new Error('Ревизор не предложил правок постов');
    return { posts: out, title: cleanTitle(j.title), content: String(j.content || '').trim(), note: String(j.note || '').slice(0, 300) };
}

/** Подрезано: подзапись — в канон по исправленной сцене; память сцены устарела (перегенерировать в STMB). */
export function applyPruned(entry, plan) {
    setText(entry, { title: plan.title, content: plan.content || entry.content });
    entry.gc.status = 'canon';
    entry.gc.pruned = { at: today(), note: plan.note, posts: plan.posts.map(p => p.i) };
    delete entry.gc.nexus;
    return true;
}

// ───────────── Хронограф (для Фойе) ─────────────

/**
 * Модель ленты: эпохи (с чатами, составом и очередью канона) и события Хроники — для Хронографа в Фойе. Это вид
 * автора: тайное не прячется, а помечено. События — только канон.
 */
export function chronographModel(data, book) {
    const ids = records(data, 'identity');
    const nameOf = id => ids.find(g => g.id === id)?.name || id;
    const w = worldRecord(data);
    const entries = Object.entries(book?.entries || {}).map(([k, e]) => ({ ...e, uid: Number(e?.uid ?? k) }));
    const eras = records(data, 'era').map(e => {
        const mine = entries.filter(x => String(x?.gc?.src?.era || '') === String(e.id) && x.gc.src?.stmb);
        return {
            id: String(e.id), label: e.label || String(e.id), from: e.from || null, to: e.to || null, status: e.status || 'active',
            canonChat: e.canonChat || null, group: e.group || null, chats: Array.isArray(e.chats) ? [...e.chats] : [],
            cast: (e.cast || []).map(sid => sliceById(data, sid)?.identity?.name).filter(Boolean),
            persona: e.persona ? (sliceById(data, e.persona)?.slice?.label || null) : null,
            note: e.note ? String(e.note).split(/(?<=[.!?])\s/)[0].slice(0, 220) : '',
            queue: { review: mine.filter(x => x.gc.status === 'review').length, nexus: mine.filter(x => x.gc.status === 'nexus').length },
        };
    }).sort((a, b) => String(a.from || '9999').localeCompare(String(b.from || '9999')));
    const eraAt = (d) => {
        const at = String(d || '');
        return eras.find(e => e.from && at >= e.from && (!e.to || at <= e.to || at.startsWith(e.to)))?.id || null;
    };
    const events = entries
        .filter(e => e.gc && CHRON_KINDS.includes(e.gc.kind) && e.gc.from && (!e.gc.status || e.gc.status === 'canon'))
        .map(e => ({
            uid: e.uid, kind: e.gc.kind, from: String(e.gc.from), to: e.gc.to ? String(e.gc.to) : null, approx: !!e.gc.approx,
            sym: CHRON_SYM[e.gc.kind] || '•', title: cleanTitle(e.comment), who: (e.gc.who || []).map(nameOf),
            secret: !!e.gc.secret && !isPublic(e.gc, '9999'), played: playedEvent(e.gc), era: eraAt(e.gc.from),
            text: String(e.content || '').slice(0, 1200),
        }))
        .sort((a, b) => a.from.localeCompare(b.from) || a.uid - b.uid);
    return { world: w ? { id: w.id, name: w.name || w.id } : null, defaultEra: w?.defaultEra ? String(w.defaultEra) : null,
        span: ['1917', '2025'], eras, events };
}

/** Войти в эпоху: открыть её каноничный (или указанный) чат — группу или чат карточки из состава эпохи. */
async function enterEra(eraId, chatId = null) {
    const data = await loadRegistry();
    const era = data ? eraById(data, eraId) : null;
    if (!era) throw new Error('нет такой эпохи');
    const chat = chatId || era.canonChat || era.chats?.[0];
    if (!chat) throw new Error('у эпохи ещё нет чата');
    const c = ctx();
    if (era.group) {
        if (typeof c.openGroupChat !== 'function') throw new Error('в таверне нет openGroupChat');
        await c.openGroupChat(era.group, chat);
        return true;
    }
    const cards = (era.cast || []).map(sid => sliceById(data, sid)?.slice?.card).filter(Boolean);
    const idx = (c.characters || []).findIndex(ch => cards.includes(ch?.avatar));
    if (idx < 0) throw new Error(`нет карточки эпохи: ${cards.join(', ') || '—'}`);
    if (String(c.characterId) !== String(idx)) await c.selectCharacterById(idx);
    if (typeof c.openCharacterChat !== 'function') throw new Error('в таверне нет openCharacterChat');
    await c.openCharacterChat(chat);
    return true;
}

// ───────────── контракт для расширок ─────────────
//
// Ядро не лезет в настройки чужих расширок. Три рычага:
//  • context() + событие «sacred-timeline:changed» — свои расширки сами подстраиваются под эпоху и облик;
//  • режимы расширок по эпохам в Реестре (gc.type "ext" — каталог, era.ext — режимы): off — промпт расширки
//    глушится, кнопки прячутся, а главный выключатель (gate в каталоге) расширка видит закрытым; quiet — только
//    промпт, hidden — только кнопки;
//  • body[data-st-era] / [data-st-year] — темы и CSS могут смотреть на эпоху без кода.

/** Обличье по id обличья: { identity, slice }. */
export function sliceById(data, sliceId) {
    if (!sliceId) return null;
    for (const g of records(data, 'identity')) {
        const s = (g.slices || []).find(x => x.id === sliceId);
        if (s) return { identity: g, slice: s };
    }
    return null;
}

/** Обличье личности: по карточке, иначе по дате. */
export function sliceOf(data, identityId, { avatar, date } = {}) {
    const g = records(data, 'identity').find(x => x.id === identityId);
    const slices = g?.slices || [];
    return (avatar && slices.find(s => s.card === avatar)) || (date && slices.find(s => covers(s, date))) || null;
}

const MUTE_MODES = ['off', 'quiet'];
const HIDE_MODES = ['off', 'hidden'];

/** Режимы расширок в эпохе: из каталога (default, иначе 'on'), поверх — era.ext. Только в отмеченных эпохах. */
export function extModes(data, era, explicit, outside = false) {
    const out = {};
    for (const x of records(data, 'ext')) if (x.id) out[x.id] = String(x.default || 'on');
    if (outside) {
        // чат чужого мира: расширки этого мира (world.outside) — выкл
        for (const [id, mode] of Object.entries(worldRecord(data)?.outside || {})) out[id] = String(mode);
        return out;
    }
    if (explicit && era?.ext && typeof era.ext === 'object') {
        for (const [id, mode] of Object.entries(era.ext)) out[id] = String(mode);
    }
    return out;
}

/** Ключи extension_prompts расширок, которые в этих режимах глушатся. */
export function mutedKeys(data, modes) {
    const keys = new Set();
    for (const x of records(data, 'ext')) {
        if (MUTE_MODES.includes(modes?.[x.id])) for (const k of x.prompts || []) if (k) keys.add(String(k));
    }
    return keys;
}

/** Все ключи промптов из каталога — под охрану (охрана прозрачна, пока ключ не заглушён). */
export function catalogKeys(data) {
    return [...new Set(records(data, 'ext').flatMap(x => x.prompts || []).filter(Boolean).map(String))];
}

const GUARD = Symbol.for('sacredTimeline.promptGuard');

/**
 * Поставить охрану на ключи extension_prompts: расширка пишет как обычно, значение хранится целиком, а при
 * глушении ST читает его пустым — и не вставляет. Ключ, которого ещё нет, берём под охрану, когда появится.
 * Настройки расширки не трогаются — уйдёшь из эпохи, всё вернётся само.
 */
export function guardPrompts(store, keys, isMuted) {
    let armed = 0;
    if (!store || typeof store !== 'object') return armed;
    for (const key of keys || []) {
        const d = Object.getOwnPropertyDescriptor(store, key);
        if (!d || !d.configurable) continue;
        if (d.get) continue;                       // уже под охраной (или чужой геттер — не трогаем)
        let value = d.value;
        const get = () => (value && typeof value === 'object' && value.value && isMuted(key)) ? { ...value, value: '' } : value;
        get[GUARD] = true;
        Object.defineProperty(store, key, { configurable: true, enumerable: true, get, set: v => { value = v; } });
        armed++;
    }
    return armed;
}

const GATE = Symbol.for('sacredTimeline.gate');

/**
 * Заслонка на главный выключатель расширки (поле её настроек, например isEnabled): пока эпоха расширку
 * выключает, та читает false и ничего не делает (не считает, не кидает кубики, не шлёт тосты). Настоящее значение
 * хранится и уходит в сохранение настроек (toJSON) — в файле настроек ничего не меняется. Поле, которого ещё нет,
 * не трогаем.
 */
export function gateSetting(obj, key, isClosed) {
    return guardSetting(obj, key, v => (isClosed() ? false : v));
}

/**
 * Поле настроек расширки под присмотром ядра: расширка читает show(значение), пишет — через unshow (снимаем свои
 * пометки), а в сохранение настроек уходит настоящее значение (toJSON). Поле, которого ещё нет, не трогаем.
 */
export function guardSetting(obj, key, show, unshow = v => v) {
    if (!obj || typeof obj !== 'object' || !key) return false;
    const d = Object.getOwnPropertyDescriptor(obj, key);
    if (!d || d.get || d.set || !d.configurable) return false;
    let value = d.value;
    const get = () => show(value);
    get[GATE] = () => value;
    Object.defineProperty(obj, key, { configurable: true, enumerable: true, get, set: v => { value = unshow(v, value); } });
    if (!Object.prototype.hasOwnProperty.call(obj, 'toJSON')) {
        Object.defineProperty(obj, 'toJSON', {
            configurable: true, enumerable: false, writable: true,
            value: function () {
                const out = {};
                for (const k of Object.keys(this)) {
                    const dd = Object.getOwnPropertyDescriptor(this, k);
                    out[k] = dd?.get?.[GATE] ? dd.get[GATE]() : this[k];
                }
                return out;
            },
        });
    }
    return true;
}

const ABSENT_MARK = '← нет в эпохе (ядро)';

/**
 * Список персонажей строками («Имя = …» или «Имя | …»): тех, кого на дату нет в мире (умер, пыль, лёд, не родился),
 * расширка видит закомментированными. Это только взгляд — сам список в настройках не меняется.
 */
export function rosterView(text, data, date) {
    if (typeof text !== 'string' || !data || !date) return text;
    return text.split('\n').map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line;
        const name = t.split(/[=|]/)[0].trim();
        const id = name ? findIdentity(data, name) : null;
        return id && !presentAt(id, date) ? `# ${t}   ${ABSENT_MARK}` : line;
    }).join('\n');
}

/** Снять пометки ядра (если расширка сохранила то, что видела). */
export function rosterUnview(text) {
    if (typeof text !== 'string' || !text.includes(ABSENT_MARK)) return text;
    return text.split('\n').map(line => {
        const i = line.indexOf(ABSENT_MARK);
        return i < 0 ? line : line.slice(0, i).replace(/^\s*#\s?/, '').replace(/\s+$/, '');
    }).join('\n');
}

/** Списки персонажей в настройках расширок (views в каталоге): [{ id, settings, key }]. */
export function catalogViews(data) {
    return records(data, 'ext').flatMap(x => (x.views || [])
        .filter(v => v && v.settings && v.key && ['roster', 'eras'].includes(v.kind || 'roster'))
        .map(v => ({ id: x.id, settings: String(v.settings), key: String(v.key), kind: v.kind || 'roster',
            eras: Array.isArray(v.eras) ? v.eras.map(String) : [] })));
}

/** Поле, нужное только в своих эпохах (kind 'eras'): в остальных расширка видит пустое; пустое не записывается. */
export function erasView(value, eraId, eras) {
    return eraId && eras.includes(String(eraId)) ? value : '';
}

/** Заслонки из каталога: [{ id, settings, key }] — у расширок с главным выключателем (gate). */
export function catalogGates(data) {
    return records(data, 'ext')
        .filter(x => x.id && x.gate && x.gate.settings && x.gate.key)
        .map(x => ({ id: x.id, settings: String(x.gate.settings), key: String(x.gate.key) }));
}

const cssAttr = s => String(s).replace(/["\\]/g, '\\$&');

/** CSS, который прячет кнопки расширок в эпохах, где они выключены. */
export function policyCss(data) {
    const exts = Object.fromEntries(records(data, 'ext').filter(x => x.id).map(x => [x.id, x]));
    const sels = [];
    for (const era of records(data, 'era')) {
        for (const [id, mode] of Object.entries(era.ext || {})) {
            if (!HIDE_MODES.includes(String(mode))) continue;
            for (const sel of exts[id]?.ui || []) {
                if (sel && !/[{}]/.test(sel)) sels.push(`body[data-st-era="${cssAttr(era.id)}"] ${sel}`);
            }
        }
    }
    for (const [id, mode] of Object.entries(worldRecord(data)?.outside || {})) {
        if (!HIDE_MODES.includes(String(mode))) continue;
        for (const sel of exts[id]?.ui || []) if (sel && !/[{}]/.test(sel)) sels.push(`body[data-st-world="none"] ${sel}`);
    }
    return sels.length ? `${sels.join(',\n')} { display: none !important; }` : '';
}

/** Снимок для расширок: мир, эпоха, дата, кто говорит, состав, персона, режимы расширок. null — чат вне мира. */
export function buildContext(data, cur, c) {
    const era = cur?.era;
    if (data && cur?.chatId && !era && !cur.world) {
        // чат чужого мира: мира и эпохи нет, расширки этого мира — по world.outside
        return { v: 1, world: null, era: null, explicit: false, chatId: cur.chatId, date: null, dateSource: '',
            speaker: null, cast: [], persona: null, ext: extModes(data, null, false, true) };
    }
    if (!data || !era) return null;
    const w = worldRecord(data);
    const short = id => {
        const hit = sliceById(data, id);
        return hit ? { identity: hit.identity.id, slice: hit.slice.id, name: hit.identity.name || hit.identity.id,
            card: hit.slice.card || null } : null;
    };
    const ch = c?.characters?.[c?.characterId];
    const speakerId = speakerOf(data, ch, c?.name2);
    const sp = speakerId ? sliceOf(data, speakerId, { avatar: ch?.avatar, date: cur.date || era.from }) : null;
    const pr = sliceById(data, era.persona);
    // кто есть кто в этом чате по именам — для расширок, которые хранят данные по имени персонажа (шкаф, жизнь):
    // имя → личность, её облик на дату чата и card — карточка, которой человек представлен в этом чате (у одного
    // человека бывает несколько карточек с одним именем, по эпохам; расширкам, ищущим карточку по имени, — сюда).
    // Несколько его карточек в одной группе (эпоха через годы) — облик по дате, card — карточка этого облика.
    // Персона (name1) — облик эпохи.
    const people = {};
    const at = cur.date || era.from;
    const here = new Map();
    const note = (name, avatar) => { if (name && avatar) here.set(name, [...(here.get(name) || []), avatar]); };
    const group = c?.groupId ? (c.groups || []).find(g => g.id === c.groupId) : null;
    for (const av of group?.members || []) note((c?.characters || []).find(x => x.avatar === av)?.name, av);
    if (!group && ch) note(ch.name, ch.avatar);
    for (const [name, avatars] of here) {
        const id = speakerOf(data, { avatar: avatars[0], name }, name);
        if (!id) continue;
        const sl = avatars.length > 1
            ? (sliceOf(data, id, { date: at }) || sliceOf(data, id, { avatar: avatars[0] }))
            : sliceOf(data, id, { avatar: avatars[0], date: at });
        people[name] = { identity: id, slice: sl?.id || null, label: sl?.label || null,
            card: avatars.includes(sl?.card) ? sl.card : avatars[0] };
    }
    if (pr && c?.name1) people[c.name1] = { identity: pr.identity.id, slice: pr.slice.id, label: pr.slice.label || null };
    return {
        v: 1,
        world: w ? { id: w.id || null, name: w.name || null, chronicle: w.chronicle || null, defaultEra: w.defaultEra ? String(w.defaultEra) : null } : null,
        era: { id: String(era.id), label: era.label || '', from: era.from || null, to: era.to || null,
            status: era.status || null, memoryBook: era.memoryBook || null, history: historyBooks(data, era),
            lore: [...(era.lore || [])] },
        explicit: !!cur.explicit,
        chatId: cur.chatId || null,
        date: cur.date || null,
        dateSource: cur.dateSource || '',
        speaker: speakerId ? { identity: speakerId, slice: sp?.id || null, avatar: ch?.avatar || null } : null,
        cast: (era.cast || []).map(short).filter(Boolean),
        persona: pr ? { identity: pr.identity.id, slice: pr.slice.id, avatar: pr.slice.persona || pr.identity.persona || null } : null,
        people,
        ext: extModes(data, era, cur.explicit),
    };
}

let lastContext = null;
let lastContextJson = '';
let muted = new Set();
let guardKeys = [];
let closed = new Set();   // расширки, выключенные в эпохе (режим off) — для заслонок
let gates = [];
let views = [];          // списки персонажей в настройках расширок
let viewState = { data: null, date: null, eraId: null };

/** Охрана промптов и заслонки: на всё из каталога (расширки заводят ключи по ходу — зовётся перед каждой генерацией). */
function armGuard() {
    try {
        const c = ctx();
        const store = c.extensionPrompts;
        if (store && guardKeys.length) guardPrompts(store, guardKeys, key => muted.has(key));
        for (const g of gates) gateSetting(c.extensionSettings?.[g.settings], g.key, () => closed.has(g.id));
        for (const v of views) {
            const obj = c.extensionSettings?.[v.settings];
            if (v.kind === 'eras') {
                const inEra = () => !!viewState.eraId && v.eras.includes(String(viewState.eraId));
                guardSetting(obj, v.key, t => erasView(t, viewState.eraId, v.eras), (t, real) => (t === '' && !inEra() ? real : t));
            } else {
                guardSetting(obj, v.key, t => rosterView(t, viewState.data, viewState.date), t => rosterUnview(t));
            }
        }
    } catch (e) { console.warn(TAG, 'охрана расширок не встала', e); }
}

function applyPolicyCss(data) {
    if (typeof document === 'undefined') return;
    const css = data ? policyCss(data) : '';
    let el = document.getElementById('sacred-timeline-policy');
    if (!css) { el?.remove(); return; }
    if (!el) {
        el = document.createElement('style');
        el.id = 'sacred-timeline-policy';
        document.head.appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
}

function applyBodyAttrs(cx) {
    if (typeof document === 'undefined' || !document.body) return;
    const ds = document.body.dataset;
    if (cx) ds.stWorld = cx.world?.id || 'none'; else delete ds.stWorld;
    if (cx?.explicit) {
        ds.stEra = cx.era.id;
        if (cx.date) ds.stYear = cx.date.slice(0, 4); else delete ds.stYear;
    } else {
        delete ds.stEra;
        delete ds.stYear;
    }
}

/** Пересчитать снимок; если он поменялся — разослать «sacred-timeline:changed». */
async function publish(data) {
    if (data === undefined) data = await loadRegistry();
    const cx = buildContext(data, current, ctx());
    muted = cx ? mutedKeys(data, cx.ext) : new Set();
    closed = new Set(cx ? Object.entries(cx.ext).filter(([, mode]) => mode === 'off').map(([id]) => id) : []);
    guardKeys = data ? catalogKeys(data) : [];
    gates = data ? catalogGates(data) : [];
    views = data ? catalogViews(data) : [];
    viewState = { data, date: cx?.era ? (current.date || cx.era.from || null) : null, eraId: cx?.era?.id || null };
    armGuard();
    applyPolicyCss(data);
    applyBodyAttrs(cx);
    const json = JSON.stringify(cx);
    if (json === lastContextJson) return cx;
    lastContextJson = json;
    lastContext = cx;
    const copy = () => (cx ? JSON.parse(json) : null);
    try { ctx().eventSource?.emit?.('sacred-timeline:changed', copy()); } catch (e) { console.warn(TAG, e); }
    try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
            window.dispatchEvent(new CustomEvent('sacred-timeline:changed', { detail: copy() }));
        }
    } catch (e) { console.warn(TAG, e); }
    return cx;
}

// ───────────── Закулисье ─────────────

/** Закомментировать в ростере Закулисья тех, кого нет на дату. Уже убранные раньше (skip) не трогаем. */
export function pruneRoster(text, data, date, skip = [], label = '') {
    const removed = [];
    const out = String(text || '').split('\n').map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line;
        const name = t.split('|')[0].trim();
        if (!name || skip.includes(name)) return line;
        const id = findIdentity(data, name);
        if (!id || presentAt(id, date)) return line;
        removed.push({ name, id });
        return `# ${t}   ← нет в эпохе ${label || date} (по Реестру)`;
    });
    return { text: out.join('\n'), removed };
}

async function guardBackstage(data, era, date, md) {
    const bs = md?.backstage;
    if (!bs || typeof bs.roster !== 'string') return [];
    const done = Array.isArray(md[MODULE]?.backstagePruned) ? md[MODULE].backstagePruned : [];
    const { text, removed } = pruneRoster(bs.roster, data, date || eraDate(era), done, era.id);
    if (!removed.length) return [];

    bs.roster = text;
    if (bs.agendas && typeof bs.agendas === 'object') {
        for (const r of removed) delete bs.agendas[r.name];
    }
    if (Array.isArray(bs.offscreen) && bs.offscreen.length) {
        const rx = removed.map(r => mentionRegex(data, r.id, r.name)).filter(Boolean);
        bs.offscreen = bs.offscreen.filter(e => !rx.some(x => x.test(typeof e === 'string' ? e : JSON.stringify(e))));
    }
    md[MODULE] = { ...(md[MODULE] || {}), backstagePruned: [...done, ...removed.map(r => r.name)] };
    await ctx().saveMetadata();
    return removed;
}

async function onChatChanged({ reset = true } = {}) {
    const chatId = ctx().getCurrentChatId?.();
    if (reset) {
        lastLore = null;
        lastPersona = null;
        lastWho = null;
        lastBooks = null;
        lastAvatar = null;
        lastMemory = null;
        lastHistory = null;
        lastChron = null;
        ctx().setExtensionPrompt?.(WHO_KEY, '', IN_CHAT, WHO_DEPTH, false, ROLE_SYSTEM);
        ctx().setExtensionPrompt?.(CHRON_KEY, '', IN_PROMPT, 0, false, ROLE_SYSTEM);
    }
    const { data, era, explicit, date, md } = await resolve();
    if (reset && ctx().getCurrentChatId?.() === chatId) {
        // в чужом мире эпохи нет — персону всё равно возвращаем с двойника на базовую (как в неотмеченном чате)
        const personaEra = era || (data ? eraById(data, worldRecord(data)?.defaultEra) : null);
        try { await syncPersonaAvatar(data, personaEra, explicit); } catch (e) { console.warn(TAG, 'аватар персоны не переключён', e); }
    }
    if (reset && ctx().getCurrentChatId?.() === chatId) {
        try { await bindEraMemory(era, explicit, chatId); } catch (e) { console.warn(TAG, 'память эпохи не привязана', e); }
        try { await tagEraMemory(); } catch (e) { console.warn(TAG, 'память эпохи не размечена', e); }
    }
    if (ctx().getCurrentChatId?.() === chatId) {
        try { await publish(data); } catch (e) { console.warn(TAG, 'снимок для расширок не разослан', e); }
        if (reset) {
            await refreshCanon();
            await refreshDrafts();
            setTimeout(paintStrazh, 600);
        }
    }
    renderStatus();
    if (!data || !era || !explicit || ctx().getCurrentChatId?.() !== chatId) return;
    const removed = await guardBackstage(data, era, date, md);
    if (removed.length) {
        const who = removed.map(r => r.id.name || r.name).join(', ');
        const msg = `Эпоха ${era.id}: убрала из Закулисья — ${who}. Их нет в этом времени.`;
        console.log(TAG, msg);
        try { window.toastr?.info(msg, 'Священный таймлайн', { timeOut: 9000 }); } catch { /* ignore */ }
        renderStatus();
    }
}

async function onEntriesLoaded(payload) {
    armGuard();   // последняя точка перед тем, как ST читает промпты расширок: ключи, заведённые на этом ходу
    try {
        if (!settings().filterLore) return;
        const { data, era, explicit, date, world } = await resolve();
        if (data && !world && current.chatId) {
            lastLore = hideWorldBooks(payload, worldBooks(data));   // чужой мир: книги этого мира — вон
            lastLore.speaker = null;
            renderStatus();
            return;
        }
        if (!data || !era) return;
        // книги эпохи — только в чатах, отмеченных в Реестре; дальше они проходят тот же фильтр, что и все
        lastBooks = explicit ? await joinEraBooks(payload, era) : null;
        lastHistory = explicit ? await joinHistory(payload, data, era) : null;
        const scope = scopeFor(data, era, date, ctx());
        lastLore = filterLore(payload, scope, worldRecord(data)?.books || {});
        lastLore.speaker = scope.speaker ? (records(data, 'identity').find(g => g.id === scope.speaker)?.name || scope.speaker) : null;
        renderStatus();
    } catch (e) {
        console.warn(TAG, 'фильтр лорбуков пропущен', e);
    }
}

/** Перед каждой генерацией (в группе — на ходу каждого участника): «кто есть кто» в промпт или пусто. */
async function onGenerationStarted() {
    let r = {};
    try {
        r = await resolve();
        await publish(r.data);   // в группе на каждом ходу свой говорящий
        await refreshCanon(r);   // строки «Канон» для Стража — Летописец Life спросит после поста
    } catch (e) {
        console.warn(TAG, 'снимок для расширок не разослан', e);
    }
    if (typeof ctx().setExtensionPrompt !== 'function') return;
    try {
        let block = '';
        if (settings().who) {
            const { data, era, explicit, date, md } = r;
            if (data && era && explicit) {
                const c = ctx();
                block = whoBlock(data, era, date, speakerOf(data, c.characters?.[c.characterId], c.name2), md?.backstage?.roster);
            }
        }
        ctx().setExtensionPrompt(WHO_KEY, block, IN_CHAT, WHO_DEPTH, false, ROLE_SYSTEM);
        lastWho = block ? block.split('\n').length - 1 : 0;
        renderStatus();
    } catch (e) {
        console.warn(TAG, '«кто есть кто» пропущен', e);
    }
    try {
        let text = '';
        lastChron = null;
        const { data, era, explicit, date } = r;
        const w = data ? worldRecord(data) : null;
        if (settings().chronicle && data && era && explicit && w?.chronicle) {
            const book = await ctx().loadWorldInfo?.(w.chronicle);
            if (book?.entries && !legacyChronicleActive(book, era.id)) {
                const scope = scopeFor(data, era, date, ctx());
                const res = chronicleBlock(book, scope, w.books || {}, { world: w.chronicle, eraFrom: era.from });
                const frag = fragmentsBlock(book, scope);
                text = [res.text, frag.text].filter(Boolean).join('\n\n');
                lastChron = { past: res.past, ahead: res.ahead, held: res.held, fragments: frag.count };
            }
        }
        ctx().setExtensionPrompt(CHRON_KEY, text, IN_PROMPT, 0, false, ROLE_SYSTEM);
        renderStatus();
    } catch (e) {
        console.warn(TAG, 'Хроника под дату пропущена', e);
    }
}

async function onPromptReady(event) {
    try {
        if (!settings().persona || !event?.chat) return;
        const { era } = await resolve();
        if (!era) return;
        const desc = ctx().powerUserSettings?.persona_description;
        lastPersona = patchPersona(event.chat, desc, era.personaPatches);
        renderStatus();
    } catch (e) {
        console.warn(TAG, 'персона не поправлена', e);
    }
}

// ───────────── интерфейс ─────────────

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function plural(n, one, few, many) {
    const a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return one;
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
    return many;
}

function fmtDate(d) {
    const m = String(d || '').match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
    if (!m) return d || '';
    return [m[3], m[2], m[1]].filter(Boolean).join('.');
}

function statusLines() {
    const out = [];
    const reg = current.registry || registryName(ctx().getWorldInfoNames?.(), ctx().extensionSettings?.[MODULE]?.registry);
    out.push(reg ? `Реестр: «${esc(reg)}»` : 'Реестр не найден — нужен лорбук с именем на «Реестр».');
    if (!current.chatId) {
        out.push('Чат не открыт.');
        return out;
    }
    if (!current.era) {
        if (!current.world && lastLore?.outside) {
            const books = Object.entries(lastLore.byBook).map(([b, n]) => `${esc(b)}: ${n}`).join('; ');
            out.push(`Мир: чужой — книги этого мира скрыты${lastLore.dropped ? ` (${lastLore.dropped}${books ? `: ${books}` : ''})` : ''}`);
            const off = Object.entries(lastContext?.ext || {}).filter(([, m]) => m === 'off').map(([id]) => id);
            if (off.length) out.push(`Расширки этого мира выключены: ${esc(off.join(', '))}`);
        } else {
            out.push('Эпоха: в Реестре не отмечена.');
        }
        return out;
    }
    const how = current.explicit ? '' : ' (по умолчанию — чат в Реестре не отмечен)';
    out.push(`Эпоха: <b>${esc(current.era.id)}</b> — ${esc(current.era.label || '')}${how}`);
    out.push(current.date ? `Дата сюжета: ${esc(fmtDate(current.date))}${current.dateSource ? ` (${esc(current.dateSource)})` : ''}` : 'Дата сюжета: не видна — лорбуки по датам не режу.');
    const pruned = ctx().chatMetadata?.[MODULE]?.backstagePruned;
    if (Array.isArray(pruned) && pruned.length) out.push(`Закулисье: убраны ${esc(pruned.join(', '))}`);
    if (lastBooks && (lastBooks.added.length || lastBooks.missing.length)) {
        const parts = [];
        if (lastBooks.added.length) parts.push(`подключено ${esc(lastBooks.added.join(', '))}`);
        if (lastBooks.missing.length) parts.push(`нет на сервере: ${esc(lastBooks.missing.join(', '))}`);
        out.push(`Книги эпохи: ${parts.join('; ')}`);
    }
    if (lastLore) {
        const books = Object.entries(lastLore.byBook).map(([b, n]) => `${esc(b)}: ${n}`).join('; ');
        out.push(`Лорбуки: скрыто ${lastLore.dropped}${books ? ` (${books})` : ''}${lastLore.enabled ? `, включено срезов эпохи: ${lastLore.enabled}` : ''}${lastLore.trimmed ? `, отрывков по дате срезано в ${lastLore.trimmed}` : ''} · говорящий: ${lastLore.speaker ? esc(lastLore.speaker) : 'не опознан — тайны скрыты'}`);
    } else {
        out.push('Лорбуки: покажу после первой генерации.');
    }
    const twin = lastAvatar?.avatar && lastAvatar.avatar !== lastAvatar.base;
    if (twin && !lastPersona) out.push('Персона: двойник эпохи — описание уже под эпоху');
    else if (lastPersona !== null) out.push(lastPersona ? `Персона: срез эпохи — правок ${lastPersona}` : 'Персона: без правок');
    if (lastAvatar?.missing) out.push(`Аватар персоны эпохи «${esc(lastAvatar.missing)}» не найден в User Avatars — оставила как есть`);
    else if (lastAvatar?.avatar && lastAvatar.avatar !== lastAvatar.base) out.push(`Аватар персоны: ${esc(lastAvatar.avatar)} (эпоха)`);
    if (lastMemory) {
        if (lastMemory.missing) out.push(`Память эпохи «${esc(lastMemory.book)}» — нет на сервере, книгу чата не трогала`);
        else if (lastMemory.bound) out.push(`Память эпохи: «${esc(lastMemory.book)}» — книга чата, STMB пишет туда`);
        else if (lastMemory.other) out.push(`Память эпохи — «${esc(lastMemory.book)}», а у чата своя книга «${esc(lastMemory.other)}»${lastMemory.canon ? ' (не трогаю)' : ''}`);
        else if (!lastMemory.canon) out.push(`Память эпохи — «${esc(lastMemory.book)}» (этот чат не каноничный — книгу не ставлю)`);
    }
    if (lastHistory?.added?.length) out.push(`Память прошлых эпох: ${esc(lastHistory.added.join(', '))} — записей ${lastHistory.entries} (дальше — по дате и кто знает)`);
    if (!settings().chronicle) out.push('Хроника под дату: выключено');
    else if (lastChron) out.push(`Хроника под дату: прошлое — ${lastChron.past} ${plural(lastChron.past, 'строка', 'строки', 'строк')}, впереди фиксированных точек — ${lastChron.ahead} (режиссёру)${lastChron.held ? `; событий этой эпохи ждут игры — ${lastChron.held}` : ''}${lastChron.fragments ? `; обрывков памяти у говорящего — ${lastChron.fragments}` : ''}`);
    if (!settings().who) out.push('Кто есть кто: выключено');
    else if (lastWho !== null) out.push(lastWho ? `Кто есть кто: ${lastWho} ${plural(lastWho, 'строка', 'строки', 'строк')} в промпте` : 'Кто есть кто: для этой эпохи нет');
    return out;
}

function renderStatus() {
    if (typeof $ !== 'function') return;
    $('#sacred_timeline_status').html(statusLines().map(l => `<div>${l}</div>`).join(''));
}

function renderSettings() {
    if (typeof $ !== 'function' || !$('#extensions_settings2').length) return;
    const s = settings();
    const html = `
    <div class="sacred-timeline-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>Священный таймлайн</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <div id="sacred_timeline_status" class="sacred-timeline-status"></div>
          <label class="checkbox_label"><input type="checkbox" id="sacred_timeline_lore" ${s.filterLore ? 'checked' : ''}>
            <span>Лорбуки по эпохе чата</span></label>
          <label class="checkbox_label"><input type="checkbox" id="sacred_timeline_persona" ${s.persona ? 'checked' : ''}>
            <span>Персона по эпохе чата</span></label>
          <label class="checkbox_label"><input type="checkbox" id="sacred_timeline_who" ${s.who ? 'checked' : ''}>
            <span>«Кто есть кто» в промпте</span></label>
          <label class="checkbox_label"><input type="checkbox" id="sacred_timeline_chron" ${s.chronicle ? 'checked' : ''}>
            <span>Хроника под дату и фиксированные точки впереди</span></label>
          <label class="checkbox_label"><input type="checkbox" id="sacred_timeline_strazh" ${s.strazh ? 'checked' : ''}>
            <span>Страж канона — графа в Летописце Life, 🚩 под постом</span></label>
          <label class="checkbox_label"><input type="checkbox" id="sacred_timeline_chronist" ${s.chronist ? 'checked' : ''}>
            <span>Хронист — память канон-чата эпохи → подзаписи Хроники 🟡</span></label>
          <label class="sacred-timeline-row"><span>Ревизор — профиль:</span>
            <select id="sacred_timeline_reviser" class="text_pole"></select></label>
          <div id="sacred_timeline_canon"></div>
          <div class="menu_button" id="sacred_timeline_check">Проверить этот чат</div>
          <small>v${VERSION} · /era — эпоха чата</small>
        </div>
      </div>
    </div>`;
    $('#extensions_settings2').append(html);
    $('#sacred_timeline_lore').on('change', function () { settings().filterLore = this.checked; ctx().saveSettingsDebounced(); });
    $('#sacred_timeline_persona').on('change', function () { settings().persona = this.checked; ctx().saveSettingsDebounced(); });
    $('#sacred_timeline_who').on('change', function () {
        settings().who = this.checked;
        if (!this.checked) ctx().setExtensionPrompt?.(WHO_KEY, '', IN_CHAT, WHO_DEPTH, false, ROLE_SYSTEM);
        ctx().saveSettingsDebounced();
        renderStatus();
    });
    $('#sacred_timeline_chron').on('change', function () {
        settings().chronicle = this.checked;
        if (!this.checked) ctx().setExtensionPrompt?.(CHRON_KEY, '', IN_PROMPT, 0, false, ROLE_SYSTEM);
        ctx().saveSettingsDebounced();
        renderStatus();
    });
    $('#sacred_timeline_check').on('click', () => { onChatChanged({ reset: false }).catch(e => console.warn(TAG, e)); });
    $('#sacred_timeline_strazh').on('change', function () { settings().strazh = this.checked; ctx().saveSettingsDebounced(); refreshCanon(); });
    $('#sacred_timeline_chronist').on('change', function () { settings().chronist = this.checked; ctx().saveSettingsDebounced(); });
    const fillProfiles = () => {
        const list = ctx().extensionSettings?.connectionManager?.profiles || [];
        const cur = settings().reviser || '';
        $('#sacred_timeline_reviser').html(['<option value="">— не выбран —</option>',
            ...list.map(p => `<option value="${esc(p.name)}" ${p.name === cur || p.id === cur ? 'selected' : ''}>${esc(p.name)}</option>`)].join(''));
    };
    fillProfiles();
    $('#sacred_timeline_reviser').on('focus', fillProfiles).on('change', function () { settings().reviser = this.value; ctx().saveSettingsDebounced(); });
    renderStatus();
    renderCanon();
}

function eraReport() {
    if (!current.chatId) return 'Чат не открыт.';
    if (!current.era) return 'Эпоха этого чата в Реестре не отмечена.';
    const date = current.date ? `, сюжет — ${fmtDate(current.date)}` : '';
    return `Эпоха ${current.era.id} — ${current.era.label || ''}${current.explicit ? '' : ' (по умолчанию)'}${date}.`;
}

// ───────────── канон: живая часть (Летописец Life, флажки, очередь) ─────────────

/** Строки «Канон» на этот чат — для графы Стража в Летописце (он спрашивает синхронно, считаем заранее). */
async function refreshCanon(r) {
    lastCanon = null;
    try {
        const { data, era, explicit, date, world } = r || await resolve();
        const w = data ? worldRecord(data) : null;
        if (!settings().strazh || !data || !era || !explicit || !world || !w?.chronicle) return;
        const book = await ctx().loadWorldInfo?.(w.chronicle);
        const cast = (lastContext?.cast || []).map(x => x.identity);
        if (lastContext?.persona?.identity) cast.push(lastContext.persona.identity);
        const input = canonBrief({ data, era, date, book, cast });
        if (input) lastCanon = { input, chatId: current.chatId };
    } catch (e) {
        console.warn(TAG, 'строки «Канон» для Стража пропущены', e);
    }
}

/** Очередь этой эпохи: на проверке 🟡, нексусы 🚩, её решения ⑂ и свежие правки Ревизора (можно откатить). */
async function refreshDrafts() {
    lastDrafts = [];
    try {
        const { data, era, explicit } = await resolve();
        const w = data ? worldRecord(data) : null;
        if (data && era && explicit && w?.chronicle) {
            const book = await ctx().loadWorldInfo?.(w.chronicle);
            const name = id => records(data, 'identity').find(g => g.id === id)?.name || id;
            lastDrafts = Object.entries(book?.entries || {})
                .filter(([, e]) => String(e?.gc?.src?.era || '') === String(era.id) && e.gc.src?.stmb
                    && (DRAFT_OPEN.includes(e.gc.status) || (e.gc.status === 'canon' && e.gc.prev && !e.gc.fixSeen)))
                .map(([k, e]) => ({ uid: Number(e.uid ?? k), title: cleanTitle(e.comment), status: e.gc.status, from: e.gc.from,
                    who: (e.gc.who || []).map(name), review: e.gc.review || null, fixed: !!e.gc.prev,
                    resolution: e.gc.resolution || '', text: String(e.content || '').slice(0, 400) }))
                .sort((a, b) => String(b.from).localeCompare(String(a.from)));
        }
    } catch (e) {
        console.warn(TAG, 'очередь Хроники не прочиталась', e);
    }
    renderCanon();
}

function draftHtml(d) {
    const rv = d.review;
    const note = rv && d.status !== 'canon'
        ? `<div class="st-draft-n st-draft-n--${rv.verdict}">${rv.verdict === 'ok' ? 'Ревизор: в рамках' : '🚩 Нексус'}${rv.why ? ` — ${esc(rv.why)}` : ''}${(rv.conflicts || []).map(c => `<br>· «${esc(c.with)}»: ${esc(c.what)}`).join('')}${rv.touched?.length ? `<br><i>Если вписать, задето: ${esc(rv.touched.join('; '))}</i>` : ''}</div>`
        : '';
    let acts;
    if (d.status === 'nexus') acts = [['prune', '✂ Подрезать'], ['nexus-canon', '✓ Вписать в таймлайн'], ['own', '⑂ Своё']];
    else if (d.status === 'own') acts = [['own-apply', 'Ревизор: применить'], ['nexus-canon', '✓ Вписать как есть']];
    else if (d.status === 'canon') acts = [['fix-ok', 'ок'], ['fix-revert', '↶ откатить правку']];
    else acts = [['revise', 'Ревизор'], ['accept', '✓ Вписать']];
    const head = d.status === 'canon' ? '✓ Ревизор поправил:' : (DRAFT_MARK[d.status] || '');
    return `<div class="st-draft" data-uid="${d.uid}">
      <div class="st-draft-t">${head} ${esc(d.title)}</div>
      ${d.who.length ? `<div class="st-draft-m">кто: ${esc(d.who.join(', '))}</div>` : ''}
      ${d.status === 'canon' || d.status === 'own' ? `<div class="st-draft-m">${esc(d.text)}</div>` : ''}
      ${d.resolution ? `<div class="st-draft-n">⑂ Твоё решение: ${esc(d.resolution)}</div>` : ''}
      ${note}
      <div class="st-draft-b">${acts.map(([a, t]) => `<button class="menu_button st-draft-act" data-act="${a}">${t}</button>`).join('')}</div>
      <div class="st-draft-x"></div>
    </div>`;
}

function reviserProfile() {
    const c = ctx();
    return (c.extensionSettings?.connectionManager?.profiles || []).find(p => p.name === settings().reviser || p.id === settings().reviser) || null;
}

async function askReviser(messages, tokens = 1200) {
    const c = ctx();
    const prof = reviserProfile();
    if (!prof) throw new Error('Выбери профиль Ревизора: Расширения → Священный таймлайн');
    if (!c.ConnectionManagerRequestService?.sendRequest) throw new Error('В таверне нет Connection Manager');
    const r = await c.ConnectionManagerRequestService.sendRequest(prof.id, messages, tokens, {});
    return typeof r === 'string' ? r : (r?.content ?? '');
}

/** Посты сцены подзаписи — если открыт её чат-источник. */
function sourcePosts(entry) {
    const c = ctx();
    const src = entry?.gc?.src;
    if (!src?.chat || src.chat !== c.getCurrentChatId?.() || !Array.isArray(src.msgs)) return [];
    const [a, b] = src.msgs.map(Number);
    const out = [];
    for (let i = Math.max(0, a); i <= Math.min(b, (c.chat || []).length - 1); i++) {
        const m = c.chat[i];
        if (m && !m.is_system) out.push({ i, name: m.name, mes: m.mes });
    }
    return out;
}

async function withChronicle(fn) {
    const { data, era } = await resolve();
    const w = data ? worldRecord(data) : null;
    const c = ctx();
    if (!w?.chronicle) throw new Error('у мира нет Хроники');
    const chron = await c.loadWorldInfo?.(w.chronicle);
    const res = await fn(chron, { data, era, w });
    if (res !== false) await c.saveWorldInfo?.(w.chronicle, chron, true);
    return res;
}

const entryByUid = (book, uid) => Object.values(book?.entries || {}).find(e => Number(e?.uid) === Number(uid)) || null;

async function setMemoryStatus(entry, status) {
    const [book, muid] = String(entry?.gc?.src?.stmb || '').split('#');
    if (!book || muid === undefined) return;
    const c = ctx();
    const mb = await c.loadWorldInfo?.(book);
    const me = Object.values(mb?.entries || {}).find(e => String(e?.uid) === String(muid));
    if (!me?.gc) return;
    me.gc.status = status;
    await c.saveWorldInfo?.(book, mb, true);
}

/**
 * Хронист и Ревизор по свежим подзаписям — в фоне, по одной: модель Летописца Life пишет подзапись (по личностям, с
 * последствиями), Ревизор (если выбран профиль) сверяет — в рамках сразу в канон, расхождение — нексус.
 */
async function processDrafts(uids) {
    const life = globalThis.LifeBridge?.api;
    let wrote = 0, ok = 0, nexus = 0;
    for (const uid of uids || []) {
        try {
            await withChronicle(async (chron, { data, era }) => {
                const e = entryByUid(chron, uid);
                if (!e?.gc || e.gc.status !== 'review') return false;
                if (typeof life?.askModel === 'function' && !e.gc.chronist) {
                    try { applyChronist(e, await life.askModel(chronistPrompt(e, data, era), 900)); wrote++; } catch (x) { console.warn(TAG, 'Хронист', x); }
                }
                if (reviserProfile()) {
                    const v = applyReview(e, await askReviser(reviserPrompt(e, chron, era, sourcePosts(e))));
                    if (v === 'ok') ok++; else nexus++;
                }
                return true;
            });
        } catch (x) {
            console.warn(TAG, 'подзапись', uid, x);
        }
    }
    if (ok || nexus) {
        try { window.toastr?.[nexus ? 'warning' : 'success'](`Хроника: вписано — ${ok}${nexus ? `, 🚩 нексус — ${nexus}: реши в «Каноне»` : ''}`, 'Ревизор'); } catch { /* */ }
    } else if (wrote) {
        try { window.toastr?.info(`Хронист написал подзаписи — ${wrote}; Ревизор не выбран, ждут проверки 🟡`, 'Хроника'); } catch { /* */ }
    }
    await refreshDrafts();
}

/** Подрезать: показать правки постов (было → стало) и спросить. */
function showPrune(uid, plan) {
    const c = ctx();
    const box = $(`.st-draft[data-uid="${uid}"] .st-draft-x`);
    box.html(`<div class="st-prune"><div class="st-draft-n">✂ ${esc(plan.note || 'правки постов')}</div>
      ${plan.posts.map(p => `<details class="st-prune-p"><summary>Пост ${p.i}: было → стало</summary>
        <div class="st-prune-old">${esc(String(c.chat?.[p.i]?.mes || ''))}</div><div class="st-prune-new">${esc(p.mes)}</div></details>`).join('')}
      <div class="st-draft-b"><button class="menu_button st-draft-act" data-act="prune-apply">Применить</button>
        <button class="menu_button st-draft-act" data-act="prune-cancel">Отмена</button></div></div>`);
    pendingPrune.set(Number(uid), plan);
}
const pendingPrune = new Map();

function strazhCount() {
    const store = ctx().chatMetadata?.[MODULE]?.strazh || {};
    const chat = ctx().chat || [];
    let n = 0;
    chat.forEach((m, i) => { const r = store[strazhKey(m, i)]; if (r && r.flag !== 'ok' && !r.dismissed) n++; });
    return n;
}

function canonHtml() {
    const flags = strazhCount();
    if (!lastDrafts.length && !flags) return '';
    const head = `Канон: ${lastDrafts.length ? `на проверке — ${lastDrafts.length}` : 'очередь пуста'}${flags ? ` · 🚩 Страж — ${flags} в этом чате` : ''}`;
    return `<div class="st-canon"><div class="st-canon-h">${head}</div>${lastDrafts.slice(0, 12).map(draftHtml).join('')}</div>`;
}

function renderCanon() {
    if (typeof $ !== 'function') return;
    $('#sacred_timeline_canon').html(canonHtml());
    try { globalThis.LifeBridge?.api?.renderSoon?.(); } catch { /* */ }
}

async function actDraft(uid, act, words = '') {
    const c = ctx();
    if (act === 'own') {
        $(`.st-draft[data-uid="${uid}"] .st-draft-x`).html(`<textarea class="text_pole st-own-text" rows="3" placeholder="Как разрулить — своими словами"></textarea>
          <div class="st-draft-b"><button class="menu_button st-draft-act" data-act="own-save">Сохранить</button></div>`);
        return;
    }
    if (act === 'prune-cancel') { pendingPrune.delete(Number(uid)); $(`.st-draft[data-uid="${uid}"] .st-draft-x`).html(''); return; }
    if (act === 'prune') {
        let plan = null;
        await withChronicle(async (chron, { era }) => {
            const e = entryByUid(chron, uid);
            const posts = sourcePosts(e);
            if (!posts.length) throw new Error('Открой чат, из которого эта сцена, — подрезать можно только там');
            window.toastr?.info('Переписываю посты под канон…', 'Ревизор');
            plan = parsePrune(await askReviser(prunePrompt(e, chron, era, posts), 6000), posts);
            return false;
        });
        if (plan) showPrune(uid, plan);
        return;
    }
    if (act === 'prune-apply') {
        const plan = pendingPrune.get(Number(uid));
        if (!plan) return;
        for (const p of plan.posts) {
            const m = c.chat?.[p.i];
            if (!m) continue;
            m.mes = p.mes;
            if (Array.isArray(m.swipes) && Number.isInteger(m.swipe_id)) m.swipes[m.swipe_id] = p.mes;
        }
        await c.saveChat?.();
        await withChronicle(async (chron) => { const e = entryByUid(chron, uid); if (!e) return false; applyPruned(e, plan); await setMemoryStatus(e, 'stale'); return true; });
        pendingPrune.delete(Number(uid));
        try { await c.reloadCurrentChat?.(); } catch { /* */ }
        window.toastr?.info('Подрезано: посты переписаны, подзапись — в каноне. Память этой сцены устарела — перегенерируй её в STMB.', 'Канон', { timeOut: 9000 });
        await refreshDrafts();
        return;
    }
    await withChronicle(async (chron, { era }) => {
        const e = entryByUid(chron, uid);
        if (!e?.gc) return false;
        if (act === 'revise') {
            window.toastr?.info('Сверяю с Хроникой…', 'Ревизор');
            const v = applyReview(e, await askReviser(reviserPrompt(e, chron, era, sourcePosts(e))));
            window.toastr?.[v === 'ok' ? 'success' : 'warning'](v === 'ok' ? 'В рамках — вписано в таймлайн' : 'Нексус — реши: подрезать, вписать или своё', 'Ревизор');
        } else if (act === 'accept') {
            e.gc.status = 'canon';
            e.gc.decided = today();
        } else if (act === 'nexus-canon') {
            decideNexus(e, 'canon');
            window.toastr?.info(e.gc.touched?.length ? `Вписано. Задето: ${e.gc.touched.join('; ')}` : 'Вписано в таймлайн', 'Канон', { timeOut: 9000 });
        } else if (act === 'own-save') {
            if (!decideNexus(e, 'own', words)) return false;
            if (reviserProfile()) { applyResolve(e, await askReviser(resolvePrompt(e, chron, era))); window.toastr?.success('Сделано по-твоему — в каноне', 'Ревизор'); }
        } else if (act === 'own-apply') {
            applyResolve(e, await askReviser(resolvePrompt(e, chron, era)));
        } else if (act === 'fix-ok') {
            e.gc.fixSeen = true;
        } else if (act === 'fix-revert') {
            revertFix(e);
            e.gc.fixSeen = true;
        } else {
            return false;
        }
        return true;
    });
    await refreshDrafts();
}

/** 🚩 под постами, где Страж увидел поломку канона. */
function paintStrazh() {
    try { paintStrazhNow(); } catch (e) { console.warn(TAG, 'флажки Стража', e); }
}

function paintStrazhNow() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    const c = ctx();
    const store = c.chatMetadata?.[MODULE]?.strazh || {};
    for (const el of document.querySelectorAll('#chat .mes[mesid]')) {
        const i = Number(el.getAttribute('mesid'));
        const m = c.chat?.[i];
        const key = m ? strazhKey(m, i) : '';
        const rec = key ? store[key] : null;
        const old = el.querySelector('.st-strazh');
        if (!rec || rec.flag === 'ok' || rec.dismissed) { old?.remove(); continue; }
        if (old?.dataset.key === key) continue;
        old?.remove();
        const box = document.createElement('div');
        box.className = `st-strazh st-strazh--${rec.flag}`;
        box.dataset.key = key;
        box.innerHTML = `<div class="st-strazh-h">🚩 Страж: ${esc(rec.what || 'расходится с каноном')}</div>
          <div class="st-strazh-d">${rec.fix ? `Как поправить: ${esc(rec.fix)}<br>` : ''}<span class="st-strazh-ok">✕ так задумано</span></div>`;
        (el.querySelector('.mes_text')?.parentElement || el).appendChild(box);
    }
}

function onStrazh(i, j, m) {
    const rec = strazhRecord(j);
    const c = ctx();
    if (!rec || c.chat?.[i] !== m) return;
    const store = strazhStore(c.chatMetadata);
    store[strazhKey(m, i)] = rec;
    const keys = Object.keys(store);
    if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete store[k];
    c.saveMetadata?.();
    paintStrazh();
    renderCanon();
    if (rec.flag === 'break') { try { window.toastr?.warning(esc(rec.what), '🚩 Страж: канон сломан'); } catch { /* */ } }
}

const lifeModule = {
    id: 'timeline',
    chron() {
        if (!settings().strazh || !lastCanon?.input || lastCanon.chatId !== current.chatId) return null;
        return { key: '"canon": {"flag": "ok"}', rule: STRAZH_RULE, input: lastCanon.input, tokens: 120 };
    },
    afterPost(i, j, m) { onStrazh(i, j, m); },
    sceneHtml() { return canonHtml(); },
};

let lifeJoined = false;
function joinLife() {
    if (lifeJoined) return true;
    const bridge = globalThis.LifeBridge;
    if (!bridge?.register) return false;
    lifeJoined = bridge.register(lifeModule) || (bridge.modules?.() || []).includes(lifeModule.id);
    return lifeJoined;
}

function bindCanonUi() {
    if (typeof $ !== 'function') return;
    $(document).on('click', '.st-draft-act', function () {
        const card = $(this).closest('.st-draft');
        const uid = card.data('uid');
        const act = $(this).data('act');
        const words = String(card.find('.st-own-text').val() || '');
        $(this).prop('disabled', true);
        actDraft(uid, act, words).catch(e => { console.warn(TAG, e); window.toastr?.error(esc(String(e?.message || e)), 'Канон'); })
            .finally(() => $(this).prop('disabled', false));
    });
    $(document).on('click', '.st-strazh-h', function () { $(this).closest('.st-strazh').toggleClass('open'); });
    $(document).on('click', '.st-strazh-ok', function () {
        const key = $(this).closest('.st-strazh').data('key');
        const store = strazhStore(ctx().chatMetadata);
        if (store[key]) { store[key].dismissed = true; ctx().saveMetadata?.(); }
        paintStrazh();
        renderCanon();
    });
}

function registerSlash() {
    try {
        const { SlashCommandParser, SlashCommand } = ctx();
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'era',
            helpString: 'Священный таймлайн: какая эпоха и дата у этого чата.',
            callback: async () => {
                await resolve();
                const text = eraReport();
                try { window.toastr?.info(text, 'Священный таймлайн'); } catch { /* ignore */ }
                return text;
            },
        }));
    } catch (e) {
        console.warn(TAG, 'команда /era не зарегистрирована', e);
    }
}

if (typeof jQuery === 'function') {
    jQuery(async () => {
        settings();
        renderSettings();
        const { eventSource, eventTypes } = ctx();
        const safe = fn => (...a) => { Promise.resolve(fn(...a)).catch(e => console.warn(TAG, e)); };
        eventSource.on(eventTypes.CHAT_CHANGED, safe(onChatChanged));
        // Закулисье заводит состав лениво и обновляет повестки после сообщений — проверяем и тут
        eventSource.on(eventTypes.MESSAGE_RECEIVED, safe(() => onChatChanged({ reset: false })));
        // эти два ST ждёт — правки успевают попасть в промпт
        eventSource.on(eventTypes.WORLDINFO_ENTRIES_LOADED, onEntriesLoaded);
        eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
        if (eventTypes.GENERATION_STARTED) eventSource.on(eventTypes.GENERATION_STARTED, onGenerationStarted);
        // STMB сохранил память сцены — разметить дату и кто знает
        if (eventTypes.WORLDINFO_UPDATED) eventSource.on(eventTypes.WORLDINFO_UPDATED, safe((name, book) => tagEraMemory(name, book)));
        registerSlash();
        bindCanonUi();
        // Life грузится рядом — подключаем Стража, как только появится её мост
        if (!joinLife()) {
            let t = 0;
            const iv = setInterval(() => { if (joinLife() || ++t > 60) clearInterval(iv); }, 1000);
            iv?.unref?.();   // вне браузера (тесты) таймер не держит процесс
        }
        const paintSoon = () => setTimeout(paintStrazh, 300);
        for (const ev of ['CHARACTER_MESSAGE_RENDERED', 'MORE_MESSAGES_LOADED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED']) {
            if (eventTypes[ev]) eventSource.on(eventTypes[ev], paintSoon);
        }
        if (eventTypes.APP_READY) eventSource.on(eventTypes.APP_READY, () => { joinLife(); paintSoon(); });
        window.SacredTimeline = {
            version: VERSION,
            /** Снимок для расширок (копия) или null, если чат вне мира. Меняется — событие «sacred-timeline:changed». */
            context: () => (lastContext ? JSON.parse(lastContextJson) : null),
            /** Режим расширки в этой эпохе: 'on' | 'off' | 'quiet' | 'hidden' | свой. Вне эпох — 'on'. */
            mode: (id) => (lastContext?.ext?.[id]) || 'on',
            /**
             * Записи книги, которые видно отсюда (эпоха, дата сюжета, кто сейчас говорит, что знает) — для расширок,
             * которые сами читают лорбуки. Вне мира — все как есть.
             */
            visible: async (entries, world) => {
                const { data, era, date } = await resolve();
                if (!data || !era) return [...(entries || [])];
                const list = historyBooks(data, era).includes(world) ? (entries || []).filter(isTaggedMemory) : entries;
                return visibleEntries(list, world, scopeFor(data, era, date, ctx()), worldRecord(data)?.books || {});
            },
            era: () => ({ ...current }),
            registry: loadRegistry,
            /** Хронограф: эпохи и события Хроники для ленты (вид автора; тайное помечено). Нет мира — null. */
            chronograph: async () => {
                const data = await loadRegistry();
                const w = data ? worldRecord(data) : null;
                if (!data || !w) return null;
                const book = w.chronicle ? await ctx().loadWorldInfo?.(w.chronicle) : null;
                return chronographModel(data, book);
            },
            /** Войти в эпоху: открыть её каноничный чат (или chatId) — дальше ядро переключит всё само. */
            enter: (eraId, chatId) => enterEra(eraId, chatId),
            /** Облик человека на дату (по имени или алиасу личности, необязательно — по карточке): { identity, slice, label } | null. */
            sliceAt: async (name, date, avatar) => {
                const data = await loadRegistry();
                const id = data ? speakerOf(data, { avatar, name }, name) || findIdentity(data, name)?.id : null;
                if (!id) return null;
                const sl = sliceOf(data, id, { avatar, date });
                return { identity: id, slice: sl?.id || null, label: sl?.label || null };
            },
            present: async (name, date) => {
                const data = await loadRegistry();
                const id = data && findIdentity(data, name);
                return id ? presentAt(id, date || current.date) : null;
            },
        };
        if (ctx().getCurrentChatId?.()) onChatChanged().catch(e => console.warn(TAG, e));
        console.log(TAG, 'загружено', VERSION);
    });
}
