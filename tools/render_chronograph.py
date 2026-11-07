"""Хронограф (черновик): HTML-страница из Реестра и Хроники в st-data."""
import html
import json
import re

ST = '/home/claude/st-data'
REG = json.load(open(f'{ST}/worlds/GC — Реестр.json', encoding='utf-8'))
TL = json.load(open(f'{ST}/worlds/Hedy MCU Canon Timeline RU.json', encoding='utf-8'))
OUT = '/home/claude/work/chronograph.html'

E = html.escape

ids = {e['gc']['id']: e['gc'] for e in REG['entries'].values() if e['gc']['type'] == 'identity'}
eras = [e['gc'] for e in REG['entries'].values() if e['gc']['type'] == 'era']
events = sorted(TL['entries'].values(), key=lambda e: e['uid'])


def name(i):
    return ids[i]['name'] if i in ids else i


def short(i):
    n = name(i)
    return n.split()[0] if i in ids else n


def sortkey(d):
    if not d:
        return '9999'
    return d


def fmt(d):
    if not d:
        return ''
    m = re.match(r'(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?', d)
    if not m:
        return d
    y, mo, da = m.groups()
    if da:
        return f'{da}.{mo}.{y}'
    if mo:
        return f'{mo}.{y}'
    return y


def when(g):
    a, b = g.get('from'), g.get('to')
    p = '≈' if g.get('approx') else ''
    if a and b and a != b:
        return f'{p}{fmt(a)} – {fmt(b)}'
    return p + fmt(a or b or '')


KIND = {'fixed': ('◆', 'фикс. точка'), 'event': ('●', 'событие'), 'state': ('▬', 'состояние'),
        'arc': ('▭', 'отрезок'), 'rule': ('§', 'правило'), 'legacy': ('↺', 'заменяется')}

timeline_events = [e for e in events if e['gc']['kind'] not in ('rule', 'legacy')]
timeline_events.sort(key=lambda e: (sortkey(e['gc'].get('from')), e['uid']))

nexus = [e for e in events if e['gc'].get('status') == 'nexus' or e['gc'].get('nexus')]
questions = [e for e in events if e['gc'].get('question')]
suggestions = [e for e in events if e['gc'].get('suggestion')]

OUTSIDE = [
    ('Карточка Сэма', '«2023, ~6 месяцев после Битвы» — Битва была в 10.2023, значит это апрель 2024.',
     'Поправить год в описании и сценарии карточки.'),
    ('Hedy Tony Relationship RU · «Примирение в Скачке»', 'Хеди вернула на Землю «Тони и Гамору», а в Хронике — '
     '«Тони и Небулу». По канону с Тони была Небула.', 'Заменить Гамору на Небулу.'),
    ('Hedy Barlow Lorebook v3 · «Red Room»', 'Имя «Yadira Barlova», а везде — Jadwiga / Ядвига.',
     'Исправить на Jadwiga.'),
    ('Персона «Hedy Barlow»', 'Одна на все эпохи, и в ней написано «2023, после «Сокола», 34 года». Она же сейчас '
     'подаётся в чат 1944 и в чат с Наташей.', 'Ядро сделает персону вневременной, а срез будет подставлять по '
     'эпохе. До тех пор — знать, что она протекает.'),
    ('Глобальные лорбуки', 'Включены для всех чатов: квартира, Хроника (с ★ХРОНОЛОГИЕЙ «сейчас — зима 2024/25»), '
     'MCU-канон на конец 2024 и беременность. В чат 1944 сейчас летит будущее Баки.', 'Это ровно то, что '
     'отфильтрует ядро. Руками в ST глобальный лорбук для одного чата не выключить.'),
]

# --- кто знает Тео: режим на дату эпохи ---
THEO = next(e for e in events if e['uid'] == 10)['gc']['knows']
ERA_AT = [('1944', '1944-06', 'Сороковые'), ('2014', '2014-06', 'Бруклин'), ('2017', '2017-06', 'Скиталец'),
          ('2018', '2020-01', 'Скачок'), ('2024', '2024-12', 'Свадьба')]


def alive(i, d):
    g = ids.get(i)
    if not g:
        return True
    for seg in g['timeline']:
        a, b = seg.get('from'), seg.get('to')
        if (a is None or a <= d) and (b is None or d < b):
            return True
    return False


def mode(i, d, eid):
    if i == 'hedy':
        return {'1944': ('self', 'она и есть Тео'), '2014': ('none', 'ещё не была'),
                '2017': ('none', 'ещё не была'), '2018': ('none', 'до ухода — нет, после — была'),
                '2024': ('knows', 'была дважды')}[eid]
    if i == 'jack3' and d < '2014':
        return ('none', '—')
    if not alive(i, d):
        g = ids.get(i, {})
        if g.get('died') and g['died'] <= d:
            return ('dead', 'нет в живых')
        later = any((s.get('from') or '0') > d for s in g.get('timeline', []))
        return ('dead', 'пыль / лёд' if later else 'нет в сюжете')
    for s in THEO.get(i, []):
        a, b = s.get('from'), s.get('to')
        if (a is None or a <= d) and (b is None or d < b):
            txt = {'knows': 'помнит', 'fragments': 'обрывки', 'none': 'не знает'}[s['mode']]
            if i == 'bucky' and eid == '2024':
                txt += ' (?)'
            if i == 'jack3':
                txt = 'подозревает'
            return (s['mode'], txt)
    return ('none', 'не знает')


theo_rows = ['hedy', 'bucky', 'steve', 'peggy', 'howard', 'jack_sr', 'jack3']


def chip(i):
    return f'<span class="chip">{E(short(i))}</span>'


def badges(g):
    b = []
    if g.get('secret'):
        b.append('<span class="badge b-secret" title="тайна: знают только участники">тайна</span>')
    if g.get('personal'):
        p = ', '.join(f'{short(k)} ≈{v}' for k, v in g['personal'].items())
        b.append(f'<span class="badge b-personal" title="личное время путешественника">личное: {E(p)}</span>')
    if g.get('status') == 'nexus' or g.get('nexus'):
        b.append('<span class="badge b-nexus">нексус</span>')
    elif g.get('status') == 'review':
        b.append('<span class="badge b-review">на проверке</span>')
    if g.get('decided'):
        b.append('<span class="badge b-ok">решено</span>')
    return ''.join(b)


def event_row(e):
    g = e['gc']
    sym, label = KIND[g['kind']]
    title = re.sub(r'^[◆●▬]\s*[^—]*—\s*', '', e['comment']) if e['uid'] >= 16 else e['comment']
    who = ''.join(chip(w) for w in g.get('who', [])[:7])
    knows = ''
    if g.get('knows'):
        parts = []
        for k, spans in g['knows'].items():
            seg = '; '.join(f"{fmt(s.get('from'))}{'–' + fmt(s['to']) if s.get('to') else '+'} "
                            f"{ {'knows': 'знает', 'fragments': 'обрывки', 'none': 'не знает'}[s['mode']]}"
                            for s in spans)
            parts.append(f'<b>{E(short(k))}</b>: {E(seg)}')
        knows = f'<p class="knows">Кто знает — {" · ".join(parts)}</p>'
    extra = []
    for key, cls in (('note', 'note'), ('question', 'q'), ('suggestion', 'sugg')):
        if g.get(key):
            pref = {'note': '', 'question': 'Вопрос: ', 'suggestion': 'Предложение: '}[key]
            extra.append(f'<p class="{cls}">{E(pref + g[key])}</p>')
    for n in g.get('nexus', []):
        extra.append(f'<p class="nx">⚠ {E(n["note"])}</p>')
    return f'''
    <details class="ev k-{g['kind']}">
      <summary>
        <span class="when">{E(when(g))}</span>
        <span class="sym" title="{E(label)}">{sym}</span>
        <span class="title">{E(title)}</span>
        <span class="meta">{who}{badges(g)}</span>
      </summary>
      <div class="body"><p>{E(e['content'])}</p>{knows}{''.join(extra)}</div>
    </details>'''


def era_card(er):
    status = 'играется' if er['status'] == 'active' else 'запланирована'
    cast = ', '.join(E(f"{name(s.split('.')[0])} · {next(x['label'] for x in ids[s.split('.')[0]]['slices'] if x['id'] == s)}")
                     for s in er['cast'])
    hedy = next(x for x in ids['hedy']['slices'] if x['id'] == er['persona'])
    mb = f'<div><dt>Память</dt><dd>{E(er["memoryBook"])}</dd></div>' if er.get('memoryBook') else ''
    chats = ', '.join(E(c) for c in er['chats']) or '—'
    return f'''
    <article class="era s-{er['status']}">
      <header><span class="era-id">{E(er['id'])}</span><span class="pill">{status}</span></header>
      <h3>{E(er['label'])}</h3>
      <dl>
        <div><dt>Когда</dt><dd>{E(when({'from': er['from'], 'to': er['to']}))}</dd></div>
        <div><dt>Хеди</dt><dd>{E(hedy['label'])}</dd></div>
        <div><dt>Каст</dt><dd>{cast}</dd></div>
        {mb}
        <div><dt>Чаты</dt><dd class="mono">{chats}</dd></div>
      </dl>
    </article>'''


def person_card(i):
    g = ids[i]
    rows = ''.join(
        f'<li><span class="when">{E(when(s))}</span><span>{E(s["label"])}'
        f'{" · <em>" + E(s["card"]) + "</em>" if s.get("card") else ""}</span></li>' for s in g['slices'])
    tl = ''
    if g.get('traveller') or len(g['timeline']) > 1:
        segs = ' → '.join(f"{fmt(s.get('from')) or '…'}–{fmt(s.get('to')) or 'сейчас'}" for s in g['timeline'])
        tl = f'<p class="segs"><span>Личное время:</span> {E(segs)}</p>'
    return f'''
    <article class="person">
      <h3>{E(g['name'])}</h3>
      {tl}
      <ul class="slices">{rows}</ul>
    </article>'''


nx_cards = []
for e in nexus:
    for n in e['gc'].get('nexus', []):
        nx_cards.append((e['comment'], n['note'], 'Хроника'))
outside_cards = ''.join(
    f'<li class="nx-card"><h4>{E(t)}</h4><p>{E(p)}</p><p class="fix">Что сделать: {E(f)}</p></li>' for t, p, f in OUTSIDE)
chron_nx = ''.join(f'<li class="nx-card"><h4>{E(t)}</h4><p>{E(n)}</p></li>' for t, n, _ in nx_cards)
q_items = ''.join(f'<li><b>{E(e["comment"])}</b><br>{E(e["gc"]["question"])}</li>' for e in questions)
q_items += ''.join(f'<li><b>{E(e["comment"])}</b><br>{E(e["gc"]["suggestion"])}</li>' for e in suggestions)
q_items += ('<li><b>Баки в 2024-м</b><br>Знает ли он уже, что капитан Тео Эрскин — это Хеди? '
            'В v3 сказано, что «какое-то время» не знал.</li>'
            '<li><b>Каноничные ветки</b><br>Какие чаты считать каноном в эпохах 1944 и 2018 '
            '(в Хронику пишет только каноничная ветка)?</li>')

theo_head = ''.join(f'<th>{E(lbl)}<br><span class="mono">{E(eid)}</span></th>' for eid, _, lbl in ERA_AT)
theo_body = ''
for i in theo_rows:
    cells = ''
    for eid, d, _ in ERA_AT:
        m, txt = mode(i, d, eid)
        cells += f'<td class="m-{m}">{E(txt)}</td>'
    theo_body += f'<tr><th scope="row">{E(name(i))}</th>{cells}</tr>'

n_ids = sum(1 for g in ids.values() if not g.get('minor'))
counts = [(len(timeline_events), 'событий на шкале'), (len(eras), 'эпох'), (n_ids, 'личностей'),
          (len(nx_cards) + len(OUTSIDE), 'нексусов')]
tiles = ''.join(f'<div class="tile"><b>{n}</b><span>{E(t)}</span></div>' for n, t in counts)

# группировка шкалы по периодам
PERIODS = [('до 1946', '0000', '1946'), ('1946–2013', '1946', '2014'), ('2014–2018', '2014', '2018-05'),
           ('Скачок 2018–2023', '2018-05', '2023-10'), ('2023–2024', '2023-10', '9999')]
tl_html = ''
for label, a, b in PERIODS:
    rows = ''.join(event_row(e) for e in timeline_events if a <= sortkey(e['gc'].get('from')) < b)
    tl_html += f'<section class="period"><h3 class="period-h">{E(label)}</h3>{rows}</section>'

main_ids = ['hedy', 'bucky', 'steve', 'tony', 'natasha', 'loki', 'sam', 'yelena', 'zemo', 'valden']
people = ''.join(person_card(i) for i in main_ids)
era_cards = ''.join(era_card(er) for er in eras)

page = f'''<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Хронограф God Complex</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
/* Архив ТВА: холодная бумага досье, янтарь отметок, моноширинные даты. Одна колонка, шкала сверху вниз. */
:root {{
  --paper: #eef0f3;
  --sheet: #fbfbfc;
  --ink: #1b2230;
  --muted: #5d6676;
  --rule: #d5d9e0;
  --amber: #b86e00;
  --amber-soft: #f6e6c9;
  --nexus: #b3261e;
  --nexus-soft: #f8dedb;
  --review: #1f5fa8;
  --review-soft: #dde8f6;
  --knows: #2d7a4b;
  --knows-soft: #d9efe1;
  --frag: #8a6d00;
  --frag-soft: #f4eccd;
  --font-body: "IBM Plex Sans", "Segoe UI", Roboto, Arial, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
  color-scheme: light;
}}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{
    --paper: #10141b; --sheet: #171c25; --ink: #e6e9ef; --muted: #9aa3b2; --rule: #2a313d;
    --amber: #f2a93b; --amber-soft: #3a2c14; --nexus: #ff8a80; --nexus-soft: #3d1d1b;
    --review: #8ab8ff; --review-soft: #1a2a40; --knows: #7fd19f; --knows-soft: #173225;
    --frag: #e6c35c; --frag-soft: #352d12; color-scheme: dark;
  }}
}}
:root[data-theme="dark"] {{
  --paper: #10141b; --sheet: #171c25; --ink: #e6e9ef; --muted: #9aa3b2; --rule: #2a313d;
  --amber: #f2a93b; --amber-soft: #3a2c14; --nexus: #ff8a80; --nexus-soft: #3d1d1b;
  --review: #8ab8ff; --review-soft: #1a2a40; --knows: #7fd19f; --knows-soft: #173225;
  --frag: #e6c35c; --frag-soft: #352d12; color-scheme: dark;
}}
* {{ box-sizing: border-box; }}
body {{ margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.5 var(--font-body); }}
main {{ max-width: 760px; margin: 0 auto; padding: 24px 16px 64px; display: grid; gap: 32px; grid-template-columns: minmax(0, 1fr); }}
main > * {{ min-width: 0; }}
h1, h2, h3, h4 {{ text-wrap: balance; margin: 0; }}
h1 {{ font: 600 28px/1.15 var(--font-mono); letter-spacing: -0.01em; }}
h2 {{ font: 600 13px/1.2 var(--font-mono); text-transform: uppercase; letter-spacing: 0.12em; color: var(--amber);
     padding-bottom: 8px; border-bottom: 2px solid var(--amber); margin-bottom: 14px; }}
h3 {{ font-size: 17px; font-weight: 600; }}
p {{ margin: 0; }}
.mono, .when {{ font-family: var(--font-mono); font-variant-numeric: tabular-nums; }}
.lede {{ color: var(--muted); max-width: 62ch; margin-top: 8px; }}
.tiles {{ display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 18px; }}
.tile {{ background: var(--sheet); border: 1px solid var(--rule); border-radius: 6px; padding: 10px 12px; display: grid; }}
.tile b {{ font: 600 22px/1.1 var(--font-mono); }}
.tile span {{ color: var(--muted); font-size: 13px; }}
@media (max-width: 480px) {{ .tiles {{ grid-template-columns: repeat(2, minmax(0, 1fr)); }} }}
.nx-list, .q-list {{ list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }}
.nx-card {{ background: var(--sheet); border: 1px solid var(--rule); border-left: 4px solid var(--nexus);
           border-radius: 6px; padding: 12px 14px; display: grid; gap: 6px; }}
.nx-card h4 {{ font-size: 15px; }}
.nx-card .fix {{ color: var(--muted); font-size: 14px; }}
.sub {{ font: 600 12px/1.2 var(--font-mono); color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em;
        margin: 18px 0 8px; }}
.q-list li {{ background: var(--sheet); border: 1px solid var(--rule); border-left: 4px solid var(--review);
             border-radius: 6px; padding: 12px 14px; }}
.eras {{ display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }}
.era {{ background: var(--sheet); border: 1px solid var(--rule); border-radius: 6px; padding: 12px 14px; display: grid; gap: 6px; }}
.era header {{ display: flex; justify-content: space-between; align-items: center; }}
.era-id {{ font: 600 20px/1 var(--font-mono); color: var(--amber); }}
.pill {{ font-size: 12px; border-radius: 999px; padding: 2px 8px; border: 1px solid var(--rule); color: var(--muted); }}
.s-active .pill {{ color: var(--knows); border-color: var(--knows); }}
.era dl {{ margin: 0; display: grid; gap: 4px; font-size: 14px; }}
.era dl div {{ display: grid; grid-template-columns: 64px 1fr; gap: 6px; }}
.era dt {{ color: var(--muted); }}
.era dd {{ margin: 0; overflow-wrap: anywhere; }}
.theo-wrap {{ overflow-x: auto; background: var(--sheet); border: 1px solid var(--rule); border-radius: 6px; }}
table {{ border-collapse: collapse; width: 100%; min-width: 560px; font-size: 13px; }}
th, td {{ padding: 8px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }}
thead th {{ font-weight: 600; color: var(--muted); }}
tbody th {{ font-weight: 600; white-space: nowrap; }}
.m-knows {{ background: var(--knows-soft); color: var(--knows); }}
.m-fragments {{ background: var(--frag-soft); color: var(--frag); }}
.m-self {{ background: var(--amber-soft); color: var(--amber); font-weight: 600; }}
.m-none {{ color: var(--muted); }}
.m-dead {{ color: var(--muted); font-style: italic; }}
.legend {{ display: flex; flex-wrap: wrap; gap: 12px; color: var(--muted); font-size: 13px; margin-top: 8px; }}
.period {{ display: grid; gap: 6px; }}
.period + .period {{ margin-top: 18px; }}
.period-h {{ font: 600 13px/1.2 var(--font-mono); color: var(--muted); }}
.ev {{ background: var(--sheet); border: 1px solid var(--rule); border-radius: 6px; }}
.ev summary {{ list-style: none; cursor: pointer; padding: 10px 12px; display: grid;
              grid-template-columns: 112px 18px 1fr; gap: 4px 8px; align-items: baseline; }}
.ev summary::-webkit-details-marker {{ display: none; }}
.ev summary:focus-visible {{ outline: 2px solid var(--amber); outline-offset: 2px; border-radius: 6px; }}
.ev .when {{ font-size: 13px; color: var(--muted); }}
.ev .sym {{ color: var(--muted); }}
.ev.k-fixed .sym {{ color: var(--amber); }}
.ev .title {{ font-weight: 500; }}
.ev .meta {{ grid-column: 3; display: flex; flex-wrap: wrap; gap: 4px; }}
@media (max-width: 480px) {{
  .ev summary {{ grid-template-columns: 18px 1fr; }}
  .ev .when {{ grid-column: 1 / -1; }}
  .ev .meta {{ grid-column: 2; }}
}}
.chip {{ font-size: 12px; padding: 1px 7px; border-radius: 999px; background: var(--paper); border: 1px solid var(--rule); }}
.badge {{ font-size: 12px; padding: 1px 7px; border-radius: 4px; font-family: var(--font-mono); }}
.b-secret {{ background: var(--ink); color: var(--sheet); }}
.b-personal {{ background: var(--amber-soft); color: var(--amber); }}
.b-nexus {{ background: var(--nexus-soft); color: var(--nexus); }}
.b-review {{ background: var(--review-soft); color: var(--review); }}
.b-ok {{ background: var(--knows-soft); color: var(--knows); }}
.ev .body {{ padding: 0 12px 12px; display: grid; gap: 8px; font-size: 15px; max-width: 65ch; }}
.ev .knows {{ font-size: 13px; color: var(--muted); }}
.ev .note {{ font-size: 13px; color: var(--muted); }}
.ev .q {{ font-size: 14px; color: var(--review); }}
.ev .sugg {{ font-size: 14px; color: var(--amber); }}
.ev .nx {{ font-size: 14px; color: var(--nexus); }}
.people {{ display: grid; gap: 10px; }}
.person {{ background: var(--sheet); border: 1px solid var(--rule); border-radius: 6px; padding: 12px 14px; display: grid; gap: 8px; }}
.segs {{ font: 13px/1.4 var(--font-mono); color: var(--amber); }}
.segs span {{ color: var(--muted); }}
.slices {{ list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; font-size: 14px; }}
.slices li {{ display: grid; grid-template-columns: 150px 1fr; gap: 8px; }}
.slices .when {{ font-size: 12px; color: var(--muted); }}
@media (max-width: 480px) {{ .slices li {{ grid-template-columns: 1fr; gap: 0; }} }}
footer {{ color: var(--muted); font-size: 13px; }}
@media (prefers-reduced-motion: reduce) {{ * {{ transition: none !important; }} }}
</style>
</head>
<body>
<main>
  <header>
    <h1>Священный таймлайн</h1>
    <p class="lede">Хроника God Complex после первой разметки. Реестр личностей и эпох, события с датами и кто что
      знает. В ST это пока выключено и на игру не влияет: ждёт ядра расширения.</p>
    <div class="tiles">{tiles}</div>
  </header>

  <section>
    <h2>Нексусы — решаешь ты</h2>
    <p class="sub">В Хронике</p>
    <ul class="nx-list">{chron_nx}</ul>
    <p class="sub">В карточках, лорбуках и настройках</p>
    <ul class="nx-list">{outside_cards}</ul>
  </section>

  <section>
    <h2>Открытые вопросы</h2>
    <ul class="q-list">{q_items}</ul>
  </section>

  <section>
    <h2>Эпохи</h2>
    <div class="eras">{era_cards}</div>
  </section>

  <section>
    <h2>Кто знает Тео</h2>
    <div class="theo-wrap"><table>
      <thead><tr><th></th>{theo_head}</tr></thead>
      <tbody>{theo_body}</tbody>
    </table></div>
    <div class="legend"><span class="m-knows">&nbsp;помнит&nbsp;</span><span class="m-fragments">&nbsp;обрывки&nbsp;</span>
      <span>не знает</span><span class="m-dead">нет в живых / пыль / лёд</span></div>
  </section>

  <section>
    <h2>Шкала</h2>
    {tl_html}
  </section>

  <section>
    <h2>Обличья по годам</h2>
    <div class="people">{people}</div>
  </section>

  <footer>Собрано из «GC — Реестр» и «Hedy MCU Canon Timeline RU» в репе st-data, 07.11.2026.
    ◆ фиксированная точка · ● событие · ▬ состояние · ▭ отрезок.</footer>
</main>
</body>
</html>'''

open(OUT, 'w', encoding='utf-8').write(page)
print('written', OUT, len(page), 'bytes;', len(timeline_events), 'events,', len(nx_cards), 'chron nexus,',
      len(OUTSIDE), 'outside')
