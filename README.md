# Священный таймлайн

Расширение SillyTavern: одна история — много эпох. Разводит лорбуки, обличья персонажей и расширки
по времени и сшивает всё в одну Хронику.

Здесь только код. Дизайн, лор и данные живут в приватной репе данных (`docs/DESIGN.md` там),
сами лорбуки — в SillyTavern.

Статус: мост `st-sync` работает; ядро расширения — следующим шагом.

## st-sync — правки без переустановок

Claude правит лорбуки, пресеты и карточки прямо в файлах сервера через приватную репу `clarawill137/st-data`.
Синкаются только `worlds/`, `OpenAI Settings/`, `groups/` и PNG из `characters/`.
Из `settings.json` — только выжимка для чтения (`_export/settings-safe.json`: персоны, привязки лорбуков, теги).
Чаты: всегда уезжает только их список (`_export/chats-index.json`), сами чаты — лишь те, что Claude попросил
в `_request/chats.txt` (кладутся в `_chats/`). Чаты от Claude (`_out/`) ставятся только новыми файлами —
существующий чат мост не перезапишет никогда. Бэкапы и ключи API (`secrets.json`, токены расширений) не уезжают.

**Установка** (один раз, в Termius на сервере ST):

```
curl -fsSL https://raw.githubusercontent.com/clarawill137/sacred-timeline/main/tools/st-sync.sh -o /usr/local/bin/st-sync && chmod +x /usr/local/bin/st-sync && st-sync setup
```

Команда выдаст ключ → github.com/clarawill137/st-data → Settings → Deploy keys → Add deploy key →
вставить, галочка «Allow write access» → Add key. Потом ещё раз `st-sync setup`.

**Каждый раз:**

| Команда | Что делает |
|---|---|
| `st-sync` | снимок сервера → забрать правки Claude → показать список → применить → обнови страницу ST |
| `st-sync undo` | откатить последнее применение (свежие записи STMB остаются) |
| `st-sync status` | ждут ли правки |
| `st-sync update` | обновить сам st-sync |

Защита: битый JSON не применяется, конфликт со свежими изменениями на сервере — тоже (Claude сводит и шлёт заново),
пустая папка на сервере — стоп. Вся история в git — ничего не теряется насовсем.

Обновить сам скрипт — `st-sync update` (или та же команда `curl`, без `&& st-sync setup`).
