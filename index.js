// Священный таймлайн — ядро, v0.1.
// Узнаёт эпоху открытого чата по Реестру мира (лорбук на сервере, имя кончается на «Реестр»)
// и убирает из Закулисья тех, кого в этой эпохе нет: умер, пыль, лёд, ещё не родился.
// Лора в коде нет — он весь в Реестре.
// Дальше сюда приедет остальное ядро: фильтр лорбуков по эпохе, «кто есть кто», Хронограф.

const MODULE = 'sacred_timeline';
const VERSION = '0.1.0';
const TAG = '[Священный таймлайн]';

const ctx = () => SillyTavern.getContext();

let current = { chatId: null, era: null, date: null, label: null };

// ───────────── Реестр ─────────────

/** Лорбук-реестр: из настроек расширения или первый, чьё имя кончается на «Реестр». */
export function registryName(names, override) {
    if (override) return override;
    return (names || []).find(n => /реестр\s*$/i.test(String(n))) || null;
}

async function loadRegistry() {
    const name = registryName(ctx().getWorldInfoNames?.(), ctx().extensionSettings?.[MODULE]?.registry);
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

/** Дата, на которую смотрим состав эпохи: её начало. */
export function eraDate(era) {
    return era?.from || era?.to || null;
}

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

// ───────────── Закулисье ─────────────

async function guardBackstage(data, era, md) {
    const bs = md?.backstage;
    if (!bs || typeof bs.roster !== 'string') return [];
    const done = Array.isArray(md[MODULE]?.backstagePruned) ? md[MODULE].backstagePruned : [];
    const date = eraDate(era);
    const { text, removed } = pruneRoster(bs.roster, data, date, done, era.id);
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

// ───────────── чат ─────────────

async function onChatChanged() {
    const chatId = ctx().getCurrentChatId?.();
    current = { chatId: chatId || null, era: null, date: null, label: null };
    if (!chatId) return;
    const data = await loadRegistry();
    if (!data || ctx().getCurrentChatId?.() !== chatId) return; // чат сменился, пока читали Реестр
    const md = ctx().chatMetadata;
    const era = findEra(data, { marker: md?.[MODULE]?.era, chatId, groupId: ctx().groupId });
    if (!era) return;
    current = { chatId, era: era.id, date: eraDate(era), label: era.label || '' };

    const removed = await guardBackstage(data, era, md);
    if (removed.length) {
        const who = removed.map(r => r.id.name || r.name).join(', ');
        const msg = `Эпоха ${era.id}: убрала из Закулисья — ${who}. Их нет в этом времени.`;
        console.log(TAG, msg);
        try { window.toastr?.info(msg, 'Священный таймлайн', { timeOut: 9000 }); } catch { /* ignore */ }
    }
}

function eraReport() {
    if (!current.chatId) return 'Чат не открыт.';
    if (!current.era) return 'Эпоха этого чата в Реестре не отмечена.';
    return `Эпоха ${current.era} — ${current.label} (с ${current.date}).`;
}

function registerSlash() {
    try {
        const { SlashCommandParser, SlashCommand } = ctx();
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'era',
            helpString: 'Священный таймлайн: какая эпоха у этого чата.',
            callback: async () => {
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
        const { eventSource, eventTypes } = ctx();
        eventSource.on(eventTypes.CHAT_CHANGED, () => { onChatChanged().catch(e => console.warn(TAG, e)); });
        // Закулисье заводит состав лениво и обновляет повестки после сообщений — проверяем и тут
        eventSource.on(eventTypes.MESSAGE_RECEIVED, () => { onChatChanged().catch(e => console.warn(TAG, e)); });
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
