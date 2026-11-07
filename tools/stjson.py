"""Чтение/запись JSON SillyTavern с сохранением исходного стиля файла (отступ, ASCII, перевод строки)."""
import json
import re


def detect_style(raw):
    m = re.search(r'\n( +)"', raw)
    return {
        'indent': len(m.group(1)) if m else 4,
        'ascii': bool(re.search(r'\\u04[0-9a-fA-F]{2}', raw)),
        'nl': raw.endswith('\n'),
    }


def load(path):
    raw = open(path, encoding='utf-8').read()
    return json.loads(raw), detect_style(raw)


def dumps(obj, style):
    return json.dumps(obj, ensure_ascii=style['ascii'], indent=style['indent']) + ('\n' if style['nl'] else '')


def save(path, obj, style):
    open(path, 'w', encoding='utf-8').write(dumps(obj, style))


ST_STYLE = {'indent': 4, 'ascii': False, 'nl': False}  # как пишет сам ST: JSON.stringify(x, null, 4)


def insert_after(d, after_key, key, value):
    """Вернуть новый dict, где key стоит сразу после after_key (или заменяет существующий на том же месте)."""
    out = {}
    placed = False
    for k, v in d.items():
        if k == key:
            continue
        out[k] = v
        if k == after_key:
            out[key] = value
            placed = True
    if not placed:
        out[key] = value
    return out


def entry(uid, comment, content, keys=(), *, disable=True, constant=False, order=100, display_index=None, gc=None):
    """Запись World Info в полях как у лорбука-таймлайна; gc — сразу после uid."""
    e = {'uid': uid}
    if gc is not None:
        e['gc'] = gc
    e.update({
        'key': list(keys),
        'keysecondary': [],
        'comment': comment,
        'content': content,
        'constant': constant,
        'vectorized': False,
        'selective': True,
        'selectiveLogic': 0,
        'addMemo': True,
        'order': order,
        'position': 0,
        'disable': disable,
        'excludeRecursion': False,
        'preventRecursion': False,
        'delayUntilRecursion': False,
        'probability': 100,
        'useProbability': True,
        'depth': 4,
        'group': '',
        'groupOverride': False,
        'groupWeight': 100,
        'scanDepth': None,
        'caseSensitive': False,
        'matchWholeWords': False,
        'useGroupScoring': False,
        'automationId': '',
        'role': 0,
        'sticky': 0,
        'cooldown': 0,
        'delay': 0,
        'display_index': uid if display_index is None else display_index,
    })
    return e
