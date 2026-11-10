// «Ход» — кто ответит. Кнопка у поля ввода → панель с участниками группы (аватарка и имя); тап по персонажу — он
// пишет ответ. Если в поле ввода есть текст, он уходит твоим сообщением и сразу отвечает выбранный — как /trigger,
// только текст не теряется. Пока кто-то пишет, выбранный встаёт в очередь (номер на кнопке и на аватарке).
//
// Модуль лежит в ядре «Священный таймлайн», но от ядра берёт только публичное — SacredTimeline.context()/present():
// кого нет в этом времени, тот бледнее и в конце; если у человека в группе несколько карточек (по годам), ярче та,
// что на дату сюжета. Без ядра и вне мира — просто все участники группы. Работает в любом групповом чате.

const KEY = 'hod';
const TAG = '[Ход]';
const DEFAULTS = { enabled: true, tidy: true };

const ctx = () => SillyTavern.getContext();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// тонкий контур, как у остальных значков ряда (lucide «users»)
const ICON = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.7" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>'
    + '<circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';

export function settings() {
    const ext = ctx().extensionSettings;
    if (!ext[KEY] || typeof ext[KEY] !== 'object') ext[KEY] = {};
    for (const [k, v] of Object.entries(DEFAULTS)) if (ext[KEY][k] === undefined) ext[KEY][k] = v;
    return ext[KEY];
}

function group() {
    const c = ctx();
    if (!c.groupId) return null;
    return (c.groups || []).find(g => String(g.id) === String(c.groupId)) || null;
}

function lastSpeaker() {
    const chat = ctx().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && !m.is_system) return m.original_avatar || null;
    }
    return null;
}

const shortName = (name) => String(name || '').trim().split(/\s+/)[0] || '?';

/**
 * Участники группы для панели: { av, chid, name, short, sub, dim, last }. dim — почему бледный: 'muted' (выключен в
 * группе), 'other' (у человека тут несколько карточек, на эту дату — не эта), 'absent' (нет в этом времени).
 * Бледные — в конце, внутри порядок группы.
 */
export async function members() {
    const c = ctx();
    const g = group();
    if (!g) return [];
    const chars = c.characters || [];
    const list = (g.members || []).map(av => ({ av, ch: chars.find(x => x.avatar === av) })).filter(x => x.ch);
    const ST = globalThis.SacredTimeline;
    let cx = null;
    try { cx = ST?.context?.() || null; } catch { cx = null; }
    const date = cx?.era ? cx.date || cx.era.from || null : null;
    const count = {};
    for (const { ch } of list) count[ch.name] = (count[ch.name] || 0) + 1;
    const last = lastSpeaker();
    const out = [];
    for (const { av, ch } of list) {
        const name = ch.name;
        const dup = count[name] > 1;
        // карточка «Имя 2016.png» при имени «Имя» → подпись «2016»
        const tail = dup ? String(av).replace(/\.[^.]+$/, '').slice(name.length).trim() : '';
        let dim = '';
        let sub = tail;
        if ((g.disabled_members || []).includes(av)) { dim = 'muted'; sub = sub ? `${sub} · выкл` : 'выкл'; }
        const want = cx?.people?.[name]?.card;
        if (!dim && dup && want && want !== av) dim = 'other';
        if (!dim && date && typeof ST?.present === 'function') {
            try {
                if ((await ST.present(name, date)) === false) { dim = 'absent'; sub = 'нет в это время'; }
            } catch { /* ядро не ответило — не бледним */ }
        }
        out.push({ av, chid: chars.indexOf(ch), name, short: shortName(name), sub, dim, last: av === last });
    }
    return [...out.filter(m => !m.dim), ...out.filter(m => m.dim)];
}

// ───────────── кто пишет и очередь ─────────────

// { chid, own }: own — ход по тапу, когда никто не пишет: он забирает текст из поля ввода (твоя реплика перед ответом).
// Ходы из очереди текст не трогают — пока кто-то пишет, в поле ввода, скорее всего, уже твоя следующая реплика:
// на время такого хода она прячется и возвращается, когда ответ готов.
const queue = [];
let pumping = false;

/** Таверна сейчас пишет ответ (видна кнопка «стоп»). */
function busy() {
    const s = document.getElementById('mes_stop');
    return !!s && s.offsetParent !== null && getComputedStyle(s).display !== 'none';
}

const textarea = () => document.getElementById('send_textarea');

function setText(v) {
    const ta = textarea();
    if (!ta) return;
    ta.value = v;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}

async function speak(chid) {
    const c = ctx();
    if (typeof c.generate === 'function') {
        // как /trigger, но текст из поля ввода не стирается — уходит твоим сообщением перед ответом
        await c.generate('normal', { force_chid: chid });
        return;
    }
    const g = group();
    const idx = (g?.members || []).indexOf(c.characters?.[chid]?.avatar);
    if (idx < 0) return;
    if (String(textarea()?.value || '').trim()) {
        globalThis.toastr?.warning?.('Сначала отправь сообщение — эта таверна не умеет отправить и позвать разом.', 'Ход');
        return;
    }
    await c.executeSlashCommandsWithOptions?.(`/trigger await=true ${idx}`);
}

async function pump() {
    if (pumping) return;
    pumping = true;
    try {
        while (queue.length) {
            for (let t = 0; busy() && t < 1200; t++) await sleep(250);   // ждём, пока допишет (до пяти минут)
            const item = queue.shift();
            if (!item) break;   // пока ждали, очередь сняли («стоп» или сменили чат)
            paintBadge();
            const draft = !item.own && String(textarea()?.value || '').trim() ? textarea().value : null;
            if (draft !== null) setText('');
            try {
                await speak(item.chid);
            } catch (e) {
                console.warn(TAG, e);
                globalThis.toastr?.error?.(String(e?.message || e), 'Ход');
            } finally {
                if (draft !== null) {
                    const now = String(textarea()?.value || '');
                    setText(now.trim() ? `${draft} ${now}` : draft);
                }
            }
            await sleep(400);
        }
    } finally {
        pumping = false;
        paintBadge();
    }
}

const queuedAt = (chid) => queue.findIndex(q => q.chid === chid);

function pick(m) {
    const at = queuedAt(m.chid);
    if (at >= 0) {   // уже в очереди — тап убирает
        queue.splice(at, 1);
        paintBadge();
        return;
    }
    const later = busy() || pumping;
    queue.push({ chid: m.chid, own: !later });
    paintBadge();
    if (later) globalThis.toastr?.info?.(`${m.short} — следом`, 'Ход', { timeOut: 1800 });
    pump().catch(e => console.warn(TAG, e));
}

function clearQueue() {
    queue.length = 0;
    paintBadge();
}

// ───────────── кнопка и панель ─────────────

function paintBadge() {
    const b = document.getElementById('hod-btn');
    if (!b) return;
    let n = b.querySelector('.hod-badge');
    if (!queue.length) { n?.remove(); return; }
    if (!n) { n = document.createElement('span'); n.className = 'hod-badge'; b.append(n); }
    n.textContent = String(queue.length);
}

function thumb(av) {
    const c = ctx();
    try { if (typeof c.getThumbnailUrl === 'function') return c.getThumbnailUrl('avatar', av); } catch { /* ниже */ }
    return `/thumbnail?type=avatar&file=${encodeURIComponent(av)}`;
}

function tileHtml(m) {
    const q = queuedAt(m.chid);
    const cls = ['hod-tile', m.dim ? `hod-dim hod-${m.dim}` : '', m.last ? 'hod-last' : '', q >= 0 ? 'hod-queued' : ''].filter(Boolean).join(' ');
    const title = [m.name, m.sub].filter(Boolean).join(' — ');
    return `<button type="button" class="${cls}" data-chid="${m.chid}" title="${esc(title)}">`
        + `<span class="hod-ava"><i>${esc(m.short.charAt(0).toUpperCase())}</i>`
        + `<img src="${esc(thumb(m.av))}" alt="" loading="lazy" onerror="this.remove()">`
        + (q >= 0 ? `<b class="hod-num">${q + 1}</b>` : '') + '</span>'
        + `<span class="hod-name">${esc(m.name)}</span>`
        + (m.sub ? `<span class="hod-sub">${esc(m.sub)}</span>` : '')
        + '</button>';
}

function close() {
    document.getElementById('hod-panel')?.remove();
    document.getElementById('hod-btn')?.classList.remove('hod-open');
}

async function open() {
    if (!group()) return;
    close();
    const list = await members();
    const host = document.getElementById('form_sheld');
    const form = document.getElementById('send_form');
    const panel = document.createElement('div');
    panel.id = 'hod-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Кто ответит');
    const typed = !!String(textarea()?.value || '').trim();
    const hint = busy() || pumping ? 'сейчас пишут — встанет в очередь' : typed ? 'твой текст уйдёт первым' : '';
    panel.innerHTML = '<div class="hod-head"><b>Кто ответит</b>'
        + `<span class="hod-hint">${hint}</span>`
        + '<button type="button" class="hod-x" title="Закрыть">✕</button></div>'
        + (list.length ? `<div class="hod-grid">${list.map(tileHtml).join('')}</div>` : '<div class="hod-empty">В группе никого нет.</div>');
    panel.querySelector('.hod-x').addEventListener('click', close);
    panel.querySelectorAll('.hod-tile').forEach(el => el.addEventListener('click', () => {
        const m = list.find(x => String(x.chid) === el.dataset.chid);
        close();
        if (m) pick(m);
    }));
    if (host && form && form.parentElement === host) host.insertBefore(panel, form);
    else document.body.append(panel);
    document.getElementById('hod-btn')?.classList.add('hod-open');
}

function toggle() {
    if (document.getElementById('hod-panel')) close();
    else open().catch(e => console.warn(TAG, e));
}

function placeButton() {
    const left = document.getElementById('leftSendForm');
    if (!left) return null;
    let b = document.getElementById('hod-btn');
    if (!b) {
        b = document.createElement('div');
        b.id = 'hod-btn';
        b.className = 'interactable';
        b.title = 'Кто ответит';
        b.tabIndex = 0;
        b.innerHTML = ICON;
        b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggle(); });
        b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    }
    // перед «гамбургером» таверны — в ряд с остальными кнопками у поля ввода
    const anchor = document.getElementById('options_button');
    if (anchor && anchor.parentElement === left) { if (b.nextElementSibling !== anchor) left.insertBefore(b, anchor); }
    else if (b.parentElement !== left) left.append(b);
    return b;
}

function sync() {
    const s = settings();
    document.body.classList.toggle('hod-tidy', !!s.tidy);
    const b = s.enabled ? placeButton() : document.getElementById('hod-btn');
    if (b) b.style.display = s.enabled && group() ? '' : 'none';
    if (!s.enabled || !group()) close();
    paintBadge();
}

function renderSettings() {
    const box = document.getElementById('extensions_settings2');
    if (!box || document.getElementById('hod-settings')) return;
    const s = settings();
    const el = document.createElement('div');
    el.id = 'hod-settings';
    el.innerHTML = `<div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header"><b>Ход — кто ответит</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
        <div class="inline-drawer-content">
          <label class="checkbox_label"><input type="checkbox" id="hod_enabled" ${s.enabled ? 'checked' : ''}>
            <span>Кнопка «кто ответит» у поля ввода (в группах)</span></label>
          <label class="checkbox_label"><input type="checkbox" id="hod_tidy" ${s.tidy ? 'checked' : ''}>
            <span>Убрать из поля ввода гардероб SLAY и стрелку Кабинета</span></label>
          <small>Тап по персонажу — он пишет ответ; текст из поля ввода уходит первым. Пока кто-то пишет — встаёт в очередь.</small>
        </div></div>`;
    box.append(el);
    el.querySelector('#hod_enabled').addEventListener('change', function () { settings().enabled = this.checked; ctx().saveSettingsDebounced(); sync(); });
    el.querySelector('#hod_tidy').addEventListener('change', function () { settings().tidy = this.checked; ctx().saveSettingsDebounced(); sync(); });
}

const hasDom = () => typeof document !== 'undefined' && typeof document.getElementById === 'function'
    && typeof document.addEventListener === 'function' && typeof document.createElement === 'function';

export function initHod() {
    if (!hasDom()) return;
    settings();
    renderSettings();
    const { eventSource, eventTypes } = ctx();
    const on = (name, fn) => { if (eventTypes?.[name]) eventSource.on(eventTypes[name], fn); };
    on('CHAT_CHANGED', () => { clearQueue(); sync(); });
    on('GROUP_UPDATED', () => setTimeout(sync, 50));
    on('GENERATION_STOPPED', clearQueue);   // нажала «стоп» — очередь тоже отменяется
    on('APP_READY', sync);
    document.addEventListener('click', (e) => {
        const p = document.getElementById('hod-panel');
        if (!p || p.contains(e.target) || document.getElementById('hod-btn')?.contains(e.target)) return;
        close();
    }, true);
    sync();
    // чужие расширки дописывают свои кнопки в ряд позже — держим свою на месте
    let n = 0;
    const iv = setInterval(() => {
        try { sync(); } catch (e) { console.warn(TAG, e); }
        if (++n > 20) clearInterval(iv);
    }, 1500);
    iv?.unref?.();
}
