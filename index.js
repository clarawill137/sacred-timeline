// Священный таймлайн — ядро, v0.4.
// Узнаёт эпоху и дату открытого чата по Реестру мира (лорбук на сервере, имя кончается на «Реестр») и:
//  • пускает в промпт только лорбуки и записи своей эпохи (книги по эпохам, записи Хроники из будущего — вон);
//  • тайны — только тем, кто их знает (gc.knows говорящего на дату), и не раньше, чем персона их прожила (gc.personal);
//  • правит персону прямо в промпте под эпоху (возраст, «сейчас», внешность) — сама персона в ST не меняется;
//  • убирает из Закулисья тех, кого в этой эпохе нет: умер, пыль, лёд, ещё не родился;
//  • «кто есть кто» — короткая шпаргалка эпохи на дату сюжета в промпт (строки эпохи + кого здесь нет и почему).
// Лора в коде нет — он весь в Реестре и Хронике.

const MODULE = 'sacred_timeline';
const VERSION = '0.4.0';
const TAG = '[Священный таймлайн]';
const DEFAULTS = { filterLore: true, persona: true, who: true };
const WHO_KEY = 'sacred_timeline_who';
const WHO_DEPTH = 1;     // перед последним сообщением чата
const IN_CHAT = 1;       // extension_prompt_types.IN_CHAT
const ROLE_SYSTEM = 0;   // extension_prompt_roles.SYSTEM

const ctx = () => SillyTavern.getContext();

let current = { chatId: null, era: null, explicit: false, date: null, dateSource: '', registry: null };
let lastLore = null;     // что срезали в последний раз
let lastPersona = null;  // сколько правок персоны применили в последний раз
let lastWho = null;      // сколько строк «кто есть кто» ушло в промпт в последний раз

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
    if (g.secret && g.knows && typeof g.knows === 'object') {
        const at = date || eraFrom;
        const spans = speaker ? g.knows[speaker] : null;
        return at && Array.isArray(spans) && spans.some(s => s.mode === 'knows' && covers(s, at)) ? 'keep' : 'drop';
    }
    const lived = personaId && g.personal?.[personaId];
    if (lived && personaNow && String(lived).split('/')[0] > personaNow) return 'drop';
    return 'keep';
}

export function filterLore(payload, scope, books) {
    const stats = { dropped: 0, enabled: 0, byBook: {} };
    for (const key of ['globalLore', 'characterLore', 'chatLore', 'personaLore']) {
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
export function patchPersona(messages, description, patches) {
    const desc = String(description || '').trim();
    if (!desc || !Array.isArray(patches) || !patches.length) return 0;
    let fixed = desc;
    let n = 0;
    for (const p of patches) {
        if (p?.find && fixed.includes(p.find)) {
            fixed = fixed.split(p.find).join(p.replace ?? '');
            n++;
        }
    }
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
    if (data && chatId) {
        era = findEra(data, { marker: md?.[MODULE]?.era, chatId, groupId: c.groupId });
        explicit = !!era;
        if (!era) era = eraById(data, worldRecord(data)?.defaultEra);
    }
    let date = null;
    let dateSource = '';
    if (era) {
        const sd = storyDate(md, c.chat);
        date = clampDate(sd.date, era);
        dateSource = sd.source;
        if (!date && era.to) { date = era.from; dateSource = 'начало эпохи'; }
    }
    current = { chatId, era, explicit, date, dateSource, registry: current.registry };
    return { data, era, explicit, date, md };
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
        ctx().setExtensionPrompt?.(WHO_KEY, '', IN_CHAT, WHO_DEPTH, false, ROLE_SYSTEM);
    }
    const { data, era, explicit, date, md } = await resolve();
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
    try {
        if (!settings().filterLore) return;
        const { data, era, date } = await resolve();
        if (!data || !era) return;
        const c = ctx();
        const scope = {
            eraId: era.id,
            date,
            eraFrom: era.from || null,
            speaker: speakerOf(data, c.characters?.[c.characterId], c.name2),
            personaId: personaIdentity(data),
            personaNow: era.personaTime || date || era.from || null,
        };
        lastLore = filterLore(payload, scope, worldRecord(data)?.books || {});
        lastLore.speaker = scope.speaker ? (records(data, 'identity').find(g => g.id === scope.speaker)?.name || scope.speaker) : null;
        renderStatus();
    } catch (e) {
        console.warn(TAG, 'фильтр лорбуков пропущен', e);
    }
}

/** Перед каждой генерацией (в группе — на ходу каждого участника): «кто есть кто» в промпт или пусто. */
async function onGenerationStarted() {
    if (typeof ctx().setExtensionPrompt !== 'function') return;
    try {
        let block = '';
        if (settings().who) {
            const { data, era, explicit, date, md } = await resolve();
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
        out.push('Эпоха: в Реестре не отмечена.');
        return out;
    }
    const how = current.explicit ? '' : ' (по умолчанию — чат в Реестре не отмечен)';
    out.push(`Эпоха: <b>${esc(current.era.id)}</b> — ${esc(current.era.label || '')}${how}`);
    out.push(current.date ? `Дата сюжета: ${esc(fmtDate(current.date))}${current.dateSource ? ` (${esc(current.dateSource)})` : ''}` : 'Дата сюжета: не видна — лорбуки по датам не режу.');
    const pruned = ctx().chatMetadata?.[MODULE]?.backstagePruned;
    if (Array.isArray(pruned) && pruned.length) out.push(`Закулисье: убраны ${esc(pruned.join(', '))}`);
    if (lastLore) {
        const books = Object.entries(lastLore.byBook).map(([b, n]) => `${esc(b)}: ${n}`).join('; ');
        out.push(`Лорбуки: скрыто ${lastLore.dropped}${books ? ` (${books})` : ''}${lastLore.enabled ? `, включено срезов эпохи: ${lastLore.enabled}` : ''} · говорящий: ${lastLore.speaker ? esc(lastLore.speaker) : 'не опознан — тайны скрыты'}`);
    } else {
        out.push('Лорбуки: покажу после первой генерации.');
    }
    if (lastPersona !== null) out.push(lastPersona ? `Персона: срез эпохи — правок ${lastPersona}` : 'Персона: без правок');
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
        registerSlash();
        window.SacredTimeline = {
            version: VERSION,
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
