// Священный таймлайн — ядро, v0.8.
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
//    персона, режимы); режимы расширок по эпохам из Реестра — глушит их промпт и прячет кнопки, настроек не трогает.
// Лора в коде нет — он весь в Реестре и Хронике.

const MODULE = 'sacred_timeline';
const VERSION = '0.8.2';
const TAG = '[Священный таймлайн]';
const DEFAULTS = { filterLore: true, persona: true, who: true, chronicle: true };
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

/**
 * Решение по записи лорбука для эпохи и даты.
 * Книга со списком эпох — только в них. Запись с gc.eras — только в своих эпохах (gc.inject — ядро её включает).
 * Запись Хроники, которая начинается позже даты чата, — из будущего, вон.
 * Тайна с картой знания (gc.knows) — только если говорящий знает её на эту дату; «обрывки» — не знание;
 * говорящий не опознан — тайну не даём (кому она известна, записано явно, а его в списке нет).
 * Без карты знания: событие из личного времени персоны (gc.personal) позже её «сейчас» в этой эпохе — она его
 * ещё не прожила, вон. Карта знания важнее: если говорящий знает, а персона ещё нет — это петля, ему можно.
 * Возвращает 'keep' | 'drop' | 'enable'.
 */
export function judgeEntry(entry, { eraId, date, eraFrom, speaker, personaId, personaNow }, books) {
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
    // книга личности (одна на человека): часть эпохи без даты чата меряем началом эпохи — чужие годы не смешиваются
    const at = date || (g.part ? eraFrom : null);
    if (!date && at && g.from && String(g.from) > at) return 'drop';
    // состояние видно только внутри своего отрезка («Наташа жива» — до 10.2023)
    if (at && g.kind === 'state' && g.to && String(at) > String(g.to) && !String(at).startsWith(String(g.to))) return 'drop';
    if (g.secret && g.knows && typeof g.knows === 'object') {
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
    return (entries || []).filter(e => e && judgeEntry({ ...e, world, disable: false }, scope, books) !== 'drop');
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

export function filterLore(payload, scope, books) {
    const stats = { dropped: 0, enabled: 0, byBook: {} };
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
            } else if (verdict === 'enable') {
                arr[i].disable = false;
                stats.enabled++;
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
export function chronicleBlock(book, scope, books, { world, eraFrom, ahead = 4, maxPast = 40 } = {}) {
    const at = scope?.date || scope?.eraFrom;
    const out = { text: '', past: 0, ahead: 0 };
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
        const open = g.kind === 'fixed' || g.public;
        let ok = judgeEntry({ ...e, world, disable: false }, scope, books) !== 'drop';
        if (ok && !open && g.parent != null) {
            const p = byUid.get(Number(g.parent));
            if (p?.gc?.secret && !knowsAt(p.gc)) ok = false;   // подсобытие тайного отрезка — тайна и само
        }
        if (ok && !open) ok = sp ? ((g.who || []).includes(sp) || knowsAt(g)) : !g.secret;
        memo.set(id, ok);
        return ok;
    };
    const seen = all.filter(e => String(e.gc.from) <= at
        && !(e.gc.kind === 'state' && e.gc.to && !(at < String(e.gc.to)))
        && visible(e));
    const keep = new Set(seen);
    const past = seen.filter(e => {
        const p = e.gc.parent != null ? byUid.get(Number(e.gc.parent)) : null;
        return !(p && keep.has(p) && p.gc.to && String(p.gc.to) <= from);   // далёкий отрезок — одной строкой родителя
    }).sort((a, b) => String(a.gc.from).localeCompare(String(b.gc.from)));
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
export const isTaggedMemory = e => e?.gc?.kind === 'memory';

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
/** Разметить память эпохи в её каноничном чате (после записи STMB и при входе в чат). */
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
        if (n) {
            await c.saveWorldInfo?.(era.memoryBook, b, true);
            console.log(TAG, `память эпохи ${era.id}: размечено записей — ${n}`);
        }
        return n;
    } finally {
        tagging = false;
    }
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
    return {
        v: 1,
        world: w ? { id: w.id || null, name: w.name || null, chronicle: w.chronicle || null } : null,
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
                const res = chronicleBlock(book, scopeFor(data, era, date, ctx()), w.books || {}, { world: w.chronicle, eraFrom: era.from });
                text = res.text;
                lastChron = { past: res.past, ahead: res.ahead };
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
        out.push(`Лорбуки: скрыто ${lastLore.dropped}${books ? ` (${books})` : ''}${lastLore.enabled ? `, включено срезов эпохи: ${lastLore.enabled}` : ''} · говорящий: ${lastLore.speaker ? esc(lastLore.speaker) : 'не опознан — тайны скрыты'}`);
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
    else if (lastChron) out.push(`Хроника под дату: прошлое — ${lastChron.past} ${plural(lastChron.past, 'строка', 'строки', 'строк')}, впереди фиксированных точек — ${lastChron.ahead} (режиссёру)`);
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
    renderStatus();
}

function eraReport() {
    if (!current.chatId) return 'Чат не открыт.';
    if (!current.era) return 'Эпоха этого чата в Реестре не отмечена.';
    const date = current.date ? `, сюжет — ${fmtDate(current.date)}` : '';
    return `Эпоха ${current.era.id} — ${current.era.label || ''}${current.explicit ? '' : ' (по умолчанию)'}${date}.`;
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
