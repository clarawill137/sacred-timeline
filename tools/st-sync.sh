#!/usr/bin/env bash
# st-sync — мост между SillyTavern (docker) и приватной репой на GitHub.
#
#   st-sync setup   — первый запуск: ключ, связь с GitHub, первый снимок
#   st-sync         — снимок сервера → забрать правки Claude → показать → применить
#   st-sync undo    — откатить последнее применение (свежие записи STMB не трогает)
#   st-sync status  — что сейчас происходит
#   st-sync update  — обновить сам st-sync с GitHub
#   st-sync ext     — только расширки: подтянуть свои с GitHub по списку (то же делает и обычный st-sync)
#
# Синкаются только: worlds/*.json, OpenAI Settings/*.json, groups/*.json, characters/*.png,
# User Avatars/*.png (аватарки персон: картинки, без настроек персон).
# Из settings.json уезжает только выжимка (_export/settings-safe.json): персоны, привязки
# лорбуков, теги. Ключи API (secrets.json, токены расширений) и бэкапы никогда не уезжают.
# Чаты: всегда уезжает только их список (_export/chats-index.json). Сами чаты — лишь те, что
# Claude попросил в _request/chats.txt (в _chats/). Чаты от Claude (_out/) ставятся только
# НОВЫМИ файлами — существующий чат мост не перезапишет никогда.
# Расширки: список своих расширок — extensions.txt в репе (пишет Claude): строка — ссылка на репу GitHub
# (подтянуть, если стоит), «+ ссылка» (ещё и поставить, если нет), «- папка» (убрать в бэкап). Только свои репы
# (github.com/clarawill137), только fast-forward; папку с твоими правками не трогает. Чужие пропатченные
# расширки мост не обновляет никогда.
# Свои расширки без репы: строка «= папка» в extensions.txt — файлы папки extensions/<папка> (верхний уровень) ходят
# через эту же репу, как лорбуки: снимок с сервера → правки Claude → на сервер. Только код и тексты (js, css, json,
# html, md…), без бэкапов и файлов с «secret/token» в имени. Папку-клон git так не берёт.

set -Eeuo pipefail
trap 'printf "❌ Сбой в строке %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR

CT="${ST_CONTAINER:-sillytavern}"
DATA="${ST_DATA:-/home/node/app/data/default-user}"
REPO="${ST_SYNC_REPO:-clarawill137/st-data}"
MIRROR="${ST_SYNC_DIR:-$HOME/st-data}"
KEY="${ST_SYNC_KEY:-$HOME/.ssh/st_data_key}"
HOST_ALIAS="github-st-data"
REMOTE="${ST_SYNC_REMOTE:-git@${HOST_ALIAS}:${REPO}.git}"
BRANCH="main"
SPECS=("worlds|*.json" "OpenAI Settings|*.json" "groups|*.json" "characters|*.png" "User Avatars|*.png")
EXPORT_DIR="_export"   # только для чтения Claude; на сервер никогда не применяется
CHATS_DIR="_chats"     # снимки запрошенных чатов — только для чтения Claude
REQUEST_FILE="_request/chats.txt"
OUT_DIR="_out"         # новые чаты от Claude: только новыми файлами
EXT_LIST="extensions.txt"                 # свои расширки: что держать на сервере (пишет Claude)
EXT_INDEX="extensions-index.json"         # что стоит на сервере — в _export, только для чтения
EXT_ALLOW="${ST_SYNC_EXT_ALLOW:-^https://github\.com/clarawill137/[A-Za-z0-9._-]+$}"
EXT_TRASH="backups/extensions-removed"    # куда уезжают убранные расширки (от DATA)
SELF_URL="https://raw.githubusercontent.com/clarawill137/sacred-timeline/main/tools/st-sync.sh"
MAX_BYTES=$((90 * 1024 * 1024))   # GitHub не берёт файлы больше 100 МБ
FAKE="${ST_SYNC_FAKE_ROOT:-}"     # только для тестов: папка вместо контейнера
YES="${ST_SYNC_YES:-}"

DIRS=()
for _s in "${SPECS[@]}"; do DIRS+=("${_s%%|*}"); done

TMPD=""
cleanup() { [[ -n $TMPD && -d $TMPD ]] && rm -rf "$TMPD"; return 0; }
trap cleanup EXIT

say()  { printf '%s\n' "$*"; }
die()  { printf '❌ %s\n' "$*" >&2; exit 1; }
warn() { printf '⚠️  %s\n' "$*" >&2; }

# ---------- доступ к контейнеру ----------

ct_check() {
  [[ -n $FAKE ]] && return 0
  command -v docker >/dev/null || die "Нет docker на этой машине."
  local r
  r=$(docker inspect -f '{{.State.Running}}' "$CT" 2>/dev/null || true)
  [[ $r == true ]] || die "Контейнер $CT не запущен."
}

# имена файлов верхнего уровня в папке (через \0)
ct_list() {
  if [[ -n $FAKE ]]; then
    [[ -d "$FAKE$DATA/$1" ]] || return 0
    find "$FAKE$DATA/$1" -mindepth 1 -maxdepth 1 -type f -printf '%f\0'
  else
    docker exec "$CT" sh -c 'cd "$1" 2>/dev/null || exit 0; for f in *; do [ -f "$f" ] && printf "%s\0" "$f"; done; exit 0' sh "$DATA/$1"
  fi
}

# забрать файлы (пути от DATA) в папку $1
ct_fetch() {
  local dest=$1; shift
  (( $# )) || return 0
  if [[ -n $FAKE ]]; then
    tar -C "$FAKE$DATA" -cf - -- "$@" | tar -C "$dest" -xf -
  elif docker exec "$CT" sh -c 'command -v tar' >/dev/null 2>&1; then
    docker exec "$CT" tar -C "$DATA" -cf - "$@" | tar -C "$dest" -xf -
  else
    local rel
    for rel in "$@"; do
      mkdir -p "$dest/$(dirname -- "$rel")"
      docker cp "$CT:$DATA/$rel" "$dest/$rel" >/dev/null
    done
  fi
}

ct_put() { # $1 файл на хосте, $2 путь от DATA
  if [[ -n $FAKE ]]; then
    mkdir -p "$(dirname -- "$FAKE$DATA/$2")"; cp -- "$1" "$FAKE$DATA/$2"
  else
    docker cp "$1" "$CT:$DATA/$2" >/dev/null
  fi
}

ct_rm() {
  if [[ -n $FAKE ]]; then rm -f -- "$FAKE$DATA/$1"
  else docker exec -u 0 "$CT" rm -f "$DATA/$1"; fi
}

# ST 1.18 пересобирает миниатюру, только если её нет: подмену картинки мимо самого ST
# (как делает мост) он не замечает и показывает старую. Поэтому миниатюру сносим — ST
# соберёт свежую при следующем показе.
thumb_of() { # путь картинки → путь её миниатюры (или пусто)
  case $1 in
    characters/*)     printf 'thumbnails/avatar/%s' "${1#characters/}" ;;
    "User Avatars/"*) printf 'thumbnails/persona/%s' "${1#User Avatars/}" ;;
    backgrounds/*)    printf 'thumbnails/bg/%s' "${1#backgrounds/}" ;;
  esac
}

# снести все миниатюры старше своей картинки (или без картинки); печатает их число
ct_fix_thumbs() {
  local script='cd "$1" 2>/dev/null || { echo 0; exit 0; }
n=0
for pair in "characters|thumbnails/avatar" "User Avatars|thumbnails/persona" "backgrounds|thumbnails/bg"; do
  src=${pair%%|*}; th=${pair#*|}
  [ -d "$th" ] || continue
  for t in "$th"/*; do
    [ -f "$t" ] || continue
    o="$src/${t##*/}"
    if [ ! -f "$o" ] || [ "$o" -nt "$t" ]; then rm -f "$t" && n=$((n+1)); fi
  done
done
echo "$n"'
  if [[ -n $FAKE ]]; then sh -c "$script" sh "$FAKE$DATA" 2>/dev/null || echo 0
  else docker exec -u 0 "$CT" sh -c "$script" sh "$DATA" 2>/dev/null || echo 0; fi
}

fix_thumbs() {
  local n; n=$(ct_fix_thumbs | tail -n 1)
  [[ $n =~ ^[0-9]+$ ]] || n=0
  if (( n > 0 )); then say "🖼  Обновила устаревшие миниатюры карточек/аватарок: $n — ST соберёт их заново."; fi
  return 0
}

# строки «размер|mtime|путь» для chats/*/*.jsonl и group chats/*.jsonl
ct_chat_index() {
  if [[ -n $FAKE ]]; then
    (cd "$FAKE$DATA" 2>/dev/null || exit 0
     for f in chats/*/*.jsonl "group chats"/*.jsonl; do [ -f "$f" ] && stat -c '%s|%Y|%n' "$f"; done; exit 0)
  else
    docker exec "$CT" sh -c 'cd "$1" 2>/dev/null || exit 0; for f in chats/*/*.jsonl "group chats"/*.jsonl; do [ -f "$f" ] && stat -c "%s|%Y|%n" "$f"; done; exit 0' sh "$DATA"
  fi
}

ct_mkdir() {
  if [[ -n $FAKE ]]; then mkdir -p "$FAKE$DATA/$1"
  else docker exec -u 0 "$CT" mkdir -p "$DATA/$1"; fi
}

ct_owner() {
  if [[ -n $FAKE ]]; then stat -c '%u:%g' "$FAKE$DATA"
  else docker exec "$CT" sh -c 'stat -c %u:%g "$1" 2>/dev/null || ls -nd "$1" | awk "{print \$3\":\"\$4}"' sh "$DATA"; fi
}

ct_chown() { # $1 владелец, $2 путь от DATA
  [[ -n $FAKE ]] && return 0
  docker exec -u 0 "$CT" chown "$1" "$DATA/$2"
}

# ---------- git ----------

g() { git -C "$MIRROR" "$@"; }

has_origin_main() { g rev-parse -q --verify "refs/remotes/origin/$BRANCH" >/dev/null; }

mirror_ready() { [[ -d "$MIRROR/.git" ]]; }

recover_git() {
  if [[ -f "$MIRROR/.git/MERGE_HEAD" ]]; then g merge --abort 2>/dev/null || true; fi
  if [[ -f "$MIRROR/.git/REVERT_HEAD" ]]; then g revert --abort 2>/dev/null || true; fi
  if g rev-parse -q --verify HEAD >/dev/null; then g reset -q --hard HEAD; fi
}

# Прошлый запуск оборвался между слиянием «применить правки Claude» и отправкой в репу (вопрос остался без
# ответа, окно закрылось, запись на сервер сорвалась). Тогда на сервере старые файлы, а снимок поверх такого
# слияния записал бы их как правку на сервере — и молча откатил бы правки Claude. Возвращаю зеркало к снимку до
# слияния: правки Claude ждут в origin и применятся в этот раз.
drop_unsent_merge() {
  g rev-parse -q --verify HEAD >/dev/null || return 0
  has_origin_main || return 0
  [[ $(g log -1 --format=%s HEAD) == "применить правки Claude" ]] || return 0
  g rev-parse -q --verify 'HEAD^2' >/dev/null || return 0
  if g merge-base --is-ancestor HEAD "origin/$BRANCH"; then return 0; fi
  local merge; merge=$(g rev-parse HEAD)
  g reset -q --hard 'HEAD^1'
  if [[ -s "$MIRROR/.git/st-sync-last" && $(<"$MIRROR/.git/st-sync-last") == "$merge" ]]; then
    rm -f "$MIRROR/.git/st-sync-last"
  fi
  warn "Прошлый st-sync не дошёл до конца — правки Claude применю заново."
}

# Сторож откатов. После применения правок Claude страницу ST надо обновить: иначе таверна (или расширка) при первом же
# сохранении лорбука запишет свою старую копию поверх — и правки Claude молча пропадут. Здесь это видно: в свежем
# снимке ($1 — что было до него) запись лорбука (или целый файл) стояла как у Claude и вернулась к тому, что было ДО
# одного из последних применений. Такое возвращаю сам: в зеркале — коммитом «вернуть откатившиеся правки Claude» поверх
# снимка (записи — по одной, остальное в файле как на сервере: свежая память STMB и свои правки целы), на сервер — вместе
# с остальными правками, после того же вопроса. REVERT_NOTE — что откатилось (для пометки в истории, если не вернули).
RESTORE_MSG="вернуть откатившиеся правки Claude"
REVERT_NOTE=""
restore_reverts() {
  local before=${1:-} snap out
  REVERT_NOTE=""
  command -v python3 >/dev/null || return 0
  [[ -n $before ]] || return 0
  snap=$(g rev-parse -q --verify HEAD) || return 0
  [[ $snap != "$before" ]] || return 0
  local -a merges=()
  mapfile -t merges < <(g log --first-parent -5 --format=%H --grep='^применить правки Claude$' "$before" 2>/dev/null || true)
  (( ${#merges[@]} )) || return 0
  out=$(python3 - "$MIRROR" "$before" "$snap" "${#merges[@]}" "${merges[@]}" "${DIRS[@]}" <<'PYEOF' 2>/dev/null || true
import json, os, re, subprocess, sys
mirror, before, snap, n = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
merges, dirs = sys.argv[5:5 + n], sys.argv[5 + n:]

def git(*a):
    return subprocess.run(['git', '-C', mirror, *a], capture_output=True)

def names(a, b):
    out = git('diff', '--no-renames', '--name-only', '-z', a, b, '--', *dirs).stdout.decode('utf-8', 'replace')
    return {n for n in out.split('\0') if n}

def blob(rev, path):
    r = git('rev-parse', '-q', '--verify', f'{rev}:{path}')
    return r.stdout.decode().strip() if r.returncode == 0 else None

def show(rev, path):
    r = git('show', f'{rev}:{path}')
    return r.stdout if r.returncode == 0 else None

def entries(rev, path):
    raw = show(rev, path)
    if raw is None:
        return None
    try:
        e = json.loads(raw.decode('utf-8')).get('entries')
        return e if isinstance(e, dict) else {}
    except Exception:
        return None

changed = names(before, snap)
whole = {}     # путь → ревизия, из которой вернуть файл целиком
fix = {}       # путь → {'set': {ключ: запись}, 'del': {ключи}, 'order': порядок ключей у Claude}
for last in merges:
    pre = f'{last}^1'
    for path in sorted(names(pre, last) & changed):
        if path in whole:
            continue
        # файл стоял как после применения — и целиком вернулся к тому, что было до него
        if blob(before, path) == blob(last, path) and blob(snap, path) == blob(pre, path):
            whole[path] = last
            fix.pop(path, None)
            continue
        if not (path.startswith('worlds/') and path.endswith('.json')):
            continue
        a, b, c, d = (entries(r, path) for r in (pre, last, before, snap))
        if b is None or d is None:
            continue
        a, c = a or {}, c or {}
        f = fix.setdefault(path, {'set': {}, 'del': set(), 'order': list(b)})
        for k, v in b.items():
            # запись, которую менял (или добавил) Claude, стояла как у него — и вернулась к старой (или пропала)
            if a.get(k) != v and c.get(k) == v and d.get(k) == a.get(k) and k not in f['set']:
                f['set'][k] = v
        for k, v in a.items():
            # запись, которую Claude убрал, вернулась
            if k not in b and k not in c and d.get(k) == v:
                f['del'].add(k)

for path, rev in sorted(whole.items()):
    full = os.path.join(mirror, path)
    raw = show(rev, path)
    if raw is None:
        if os.path.exists(full):
            os.remove(full)
    else:
        os.makedirs(os.path.dirname(full), exist_ok=True)
        open(full, 'wb').write(raw)
    print(f'{path}\tцеликом')

for path, f in sorted(fix.items()):
    count = len(f['set']) + len(f['del'])
    if not count:
        continue
    text = show(snap, path).decode('utf-8')
    obj = json.loads(text)
    ent = obj.get('entries') or {}
    keys = [k for k in ent if k not in f['del']]
    for k in f['set']:
        if k in keys:
            continue
        # пропавшая запись встаёт туда же, где стояла у Claude: после ближайшей соседки сверху
        order = f['order']
        at = 0
        for prev in reversed(order[:order.index(k)] if k in order else []):
            if prev in keys:
                at = keys.index(prev) + 1
                break
        keys.insert(at, k)
    obj['entries'] = {k: (f['set'][k] if k in f['set'] else ent[k]) for k in keys}
    m = re.search(r'\n([ \t]+)"', text)
    out = json.dumps(obj, ensure_ascii=False, indent=m.group(1)) if m else json.dumps(obj, ensure_ascii=False, separators=(',', ':'))
    open(os.path.join(mirror, path), 'w', encoding='utf-8', newline='').write(out + ('\n' if text.endswith('\n') else ''))
    print(f'{path}\tзаписей: {count}')
PYEOF
  )
  if [[ -z $out ]]; then g reset -q --hard "$snap" 2>/dev/null || true; return 0; fi
  warn "На сервере откатились правки Claude (похоже, страницу ST не обновили после прошлого применения):"
  local line n
  while IFS=$'\t' read -r line n; do
    [[ -n $line ]] || continue
    printf '   %s — %s\n' "$line" "$n" >&2
    REVERT_NOTE+="${line##*/} — $n; "
  done <<<"$out"
  REVERT_NOTE=${REVERT_NOTE%; }
  g add -A -- "${DIRS[@]}"
  if g diff --cached --quiet; then note_reverts; return 0; fi
  g commit -q -m "$RESTORE_MSG — $REVERT_NOTE"
  say "   Верну их на сервер — остальное в этих файлах (свежая память, твои правки) не трону."
  return 0
}

# не вернули (отказ, сбой) — пометка в истории репы: её увидит Claude
note_reverts() {
  [[ -n $REVERT_NOTE ]] || return 0
  g commit -q --allow-empty -m "⚠ сервер: откатились правки Claude — $REVERT_NOTE" 2>/dev/null || true
  say "   Откат остался. Скажи Claude: «откат» — он вернёт. Перед этим обнови страницу ST."
  REVERT_NOTE=""
}

lock() {
  exec 9>"$MIRROR/.git/st-sync.lock"
  command -v flock >/dev/null && { flock -n 9 || die "st-sync уже запущен в другом окне."; }
  return 0
}

push_main() { g push -q origin "HEAD:refs/heads/$BRANCH"; }
push_server_branch() { g push -q -f origin "HEAD:refs/heads/server" 2>/dev/null || warn "Не вышло отправить ветку server."; }

# ---------- расширки ----------

# sh в контейнере от root, рабочая папка — DATA ($1 — скрипт, дальше аргументы); в тестах — в FAKE-папке
ct_sh() {
  local script=$1; shift
  if [[ -n $FAKE ]]; then (cd "$FAKE$DATA" && sh -c "$script" sh "$@")
  else docker exec -u 0 -w "$DATA" "$CT" sh -c "$script" sh "$@"; fi
}

# общее для скриптов в контейнере: git без «dubious ownership», ссылки без хвостов и паролей, все клоны расширок
EXT_SH_LIB='
G() { git -c safe.directory="*" "$@"; }
norm() { printf "%s" "$1" | sed -e "s#://[^/@]*@#://#" -e "s#\.git\$##" -e "s#/*\$##" | tr "A-Z" "a-z"; }
roots() { echo extensions; [ -d ../../../public/scripts/extensions/third-party ] && echo ../../../public/scripts/extensions/third-party; }
'

# что стоит на сервере: папка, ссылка репы, коммит, свои правки, версия — строками через таб
ct_ext_index() {
  ct_sh "$EXT_SH_LIB"'
command -v git >/dev/null 2>&1 || HAVE_GIT=0
for r in $(roots); do
  for d in "$r"/*/; do
    d=${d%/}; [ -f "$d/manifest.json" ] || continue
    url=""; head=""; dirty=""
    if [ -d "$d/.git" ] && [ "${HAVE_GIT:-1}" = 1 ]; then
      url=$(norm "$(G -C "$d" config --get remote.origin.url 2>/dev/null)")
      head=$(G -C "$d" rev-parse --short HEAD 2>/dev/null)
      [ -n "$(G -C "$d" status --porcelain --untracked-files=no 2>/dev/null | head -n 1)" ] && dirty=1
    fi
    ver=$(sed -n "s/.*\"version\"[^\"]*\"\([^\"]*\)\".*/\1/p" "$d/manifest.json" | head -n 1)
    printf "%s\t%s\t%s\t%s\t%s\n" "$d" "$url" "$head" "$dirty" "$ver"
  done
done'
}

export_extensions() {
  command -v python3 >/dev/null || return 0
  ct_ext_index > "$TMPD/extidx" 2>/dev/null || { warn "Не вышло прочитать список расширок."; return 0; }
  mkdir -p "$TMPD/export"
  python3 - "$TMPD/extidx" "$TMPD/export/$EXT_INDEX" <<'PYEOF' || { warn "Список расширок не собрался."; return 0; }
import json, sys
rows = []
for line in open(sys.argv[1], encoding='utf-8', errors='replace'):
    p = line.rstrip('\n').split('\t')
    if len(p) < 5:
        continue
    folder, url, head, dirty, ver = p[:5]
    rows.append({'path': folder, 'repo': url or None, 'commit': head or None, 'localChanges': dirty == '1', 'version': ver or None})
rows.sort(key=lambda r: r['path'].lower())
open(sys.argv[2], 'w', encoding='utf-8').write(json.dumps(rows, ensure_ascii=False, indent=2) + '\n')
PYEOF
  mkdir -p "$MIRROR/$EXPORT_DIR"
  cp -- "$TMPD/export/$EXT_INDEX" "$MIRROR/$EXPORT_DIR/"
}

# одна строка списка → в контейнере: подтянуть / поставить / убрать. Печатает итог одним словом и подробности.
ct_ext_apply() { # $1 pull|install|remove, $2 ссылка или папка, $3 владелец uid:gid, $4 папка для бэкапа
  ct_sh "$EXT_SH_LIB"'
act=$1; arg=$2; owner=$3; trash=$4
command -v git >/dev/null 2>&1 || { echo "nogit"; exit 0; }
mkdir -p extensions
stamp=$(date +%Y%m%d-%H%M%S)
if [ "$act" = remove ]; then
  [ -d "extensions/$arg" ] || { echo "absent"; exit 0; }
  mkdir -p "$trash" && mv "extensions/$arg" "$trash/$arg-$stamp" && echo "removed $trash/$arg-$stamp"; exit 0
fi
url=$(norm "$arg")
found=""
for r in $(roots); do
  for d in "$r"/*/; do
    d=${d%/}; [ -d "$d/.git" ] || continue
    [ "$(norm "$(G -C "$d" config --get remote.origin.url 2>/dev/null)")" = "$url" ] && { found=$d; break 2; }
  done
done
if [ -n "$found" ]; then
  if [ -n "$(G -C "$found" status --porcelain --untracked-files=no 2>/dev/null | head -n 1)" ]; then echo "dirty $found"; exit 0; fi
  old=$(G -C "$found" rev-parse --short HEAD 2>/dev/null)
  if ! G -C "$found" pull -q --ff-only >/dev/null 2>&1; then echo "pullfail $found"; exit 0; fi
  new=$(G -C "$found" rev-parse --short HEAD 2>/dev/null)
  chown -R "$owner" "$found" 2>/dev/null
  if [ "$old" = "$new" ]; then echo "same $found $new"; else echo "updated $found $old $new"; fi
  exit 0
fi
[ "$act" = install ] || { echo "notfound $url"; exit 0; }
name=${url##*/}
if [ -e "extensions/$name" ]; then echo "busy extensions/$name"; exit 0; fi
if ! G clone -q --depth 1 "$arg" "extensions/$name" >/dev/null 2>&1; then rm -rf "extensions/$name"; echo "clonefail $name"; exit 0; fi
chown -R "$owner" "extensions/$name" 2>/dev/null
echo "cloned extensions/$name $(G -C "extensions/$name" rev-parse --short HEAD 2>/dev/null)"' "$@"
}

ext_sync() {
  local list owner line a b res word rest changed=0
  local -a missing=()
  if [[ -n ${EXT_FROM_ORIGIN:-} ]]; then
    list=$(g show "origin/$BRANCH:$EXT_LIST" 2>/dev/null || g show "HEAD:$EXT_LIST" 2>/dev/null || true)
  else
    list=$(g show "HEAD:$EXT_LIST" 2>/dev/null || g show "origin/$BRANCH:$EXT_LIST" 2>/dev/null || true)
  fi
  [[ -n $list ]] || return 0
  owner=$(ct_owner)
  while IFS= read -r line; do
    line=${line%%#*}; read -r a b _ <<<"$line" || true
    [[ -n ${a:-} ]] || continue
    [[ $a == "=" ]] && continue   # своя расширка без репы — её файлы ходят вместе с данными (load_local_exts)
    local act=pull
    if [[ $a == + ]]; then act=install; a=${b:-}; b=""; fi
    if [[ $a == - ]]; then
      if [[ ! ${b:-} =~ ^[A-Za-z0-9._-]+$ || $b == . || $b == .. ]]; then warn "Расширки: странное имя папки «${b:-}» — пропускаю."; continue; fi
      res=$(ct_ext_apply remove "$b" "$owner" "$EXT_TRASH" | tail -n 1) || res="fail"
    else
      if [[ ! $a =~ $EXT_ALLOW ]]; then warn "Расширки: не своя ссылка «$a» — не ставлю."; continue; fi
      res=$(ct_ext_apply "$act" "$a" "$owner" "$EXT_TRASH" | tail -n 1) || res="fail"
    fi
    word=${res%% *}; rest=${res#"$word"}; rest=${rest# }
    case $word in
      updated)   a=${rest%% *}; b=${rest#* }; say "🧩 Обновлена: ${a##*/} (${b/ / → })"; changed=1 ;;
      cloned)    a=${rest%% *}; say "🧩 Поставлена: ${a##*/}"; changed=1 ;;
      removed)   say "🧩 Убрана: $b (лежит в ${rest})"; changed=1 ;;
      notfound)  missing+=("${rest##*/}") ;;
      same|absent) ;;
      dirty)     warn "Расширки: в ${rest} есть свои правки — не обновляю." ;;
      busy)      warn "Расширки: папка ${rest} уже занята другим — не ставлю." ;;
      pullfail)  warn "Расширки: ${rest} не обновилась (git pull) — проверь сеть." ;;
      clonefail) warn "Расширки: ${rest} не скачалась — проверь сеть." ;;
      nogit)     warn "Расширки: в контейнере нет git — пропускаю."; return 0 ;;
      *)         warn "Расширки: ${a} ${b:-} — непонятный ответ: ${res}" ;;
    esac
  done <<<"$list"
  if (( ${#missing[@]} )); then say "   Расширки из списка, которых на сервере нет (сама не ставлю): ${missing[*]}"; fi
  if (( changed )); then say "   Расширки поменялись — обнови страницу ST."; fi
  return 0
}

cmd_ext() {
  mirror_ready || die "Сначала: st-sync setup"
  ct_check
  lock
  g fetch -q origin 2>/dev/null || warn "Нет связи с GitHub — беру список расширок из последней репы."
  local list
  list=$(g show "origin/$BRANCH:$EXT_LIST" 2>/dev/null || true)
  if [[ -n $list ]] && ! g merge-base --is-ancestor "origin/$BRANCH" HEAD 2>/dev/null; then
    say "Есть и правки данных от Claude — их применит обычный st-sync. Здесь — только расширки."
  fi
  # в «только расширки» берём список из свежей репы, даже если данные ещё не слиты
  EXT_FROM_ORIGIN=1 ext_sync
}

# Свои расширки без репы («= папка» в списке): добавляю их папки к тому, что синкается. Список — из свежей репы:
# так просьба Claude срабатывает в тот же запуск. Папку с .git (клон) не беру — её обновляют по ссылке. Папки на
# сервере нет, а в зеркале её файлы есть — не трогаю ничего (иначе снимок записал бы «всё удалено»).
LOCAL_EXTS_LOADED=""
load_local_exts() {
  [[ -z $LOCAL_EXTS_LOADED ]] || return 0
  LOCAL_EXTS_LOADED=1
  local list line a b dir
  list=$(g show "origin/$BRANCH:$EXT_LIST" 2>/dev/null || g show "HEAD:$EXT_LIST" 2>/dev/null || true)
  [[ -n $list ]] || return 0
  while IFS= read -r line; do
    line=${line%%#*}; a=""; b=""; read -r a b _ <<<"$line" || true
    [[ ${a:-} == "=" ]] || continue
    if [[ ! ${b:-} =~ ^[A-Za-z0-9._-]+$ || $b == . || $b == .. ]]; then warn "Расширки: странное имя папки «${b:-}» — пропускаю."; continue; fi
    dir="extensions/$b"
    if [[ " ${DIRS[*]} " == *" $dir "* ]]; then continue; fi
    if [[ $(ct_sh '[ -d "$1/.git" ] && echo git || true' "$dir" 2>/dev/null) == git ]]; then
      warn "Расширки: $dir — клон git, её обновляют по ссылке; строку «= $b» пропускаю."; continue
    fi
    if [[ -z $(ct_list "$dir" | tr -d '\0') && -n $(g ls-files -- "$dir" 2>/dev/null) ]]; then
      warn "Расширки: на сервере нет файлов в $dir, а в репе они есть — не трогаю. Вернуть — скажи Claude; не нужна — пусть уберёт строку «= $b»."; continue
    fi
    SPECS+=("$dir|*"); DIRS+=("$dir")
  done <<<"$list"
  return 0
}

# ---------- снимок сервера ----------

snapshot() { # $1 — текст коммита
  local msg=$1 spec dir glob name n
  local -a rels=()
  TMPD=$(mktemp -d)
  mkdir -p "$TMPD/new"
  for spec in "${SPECS[@]}"; do
    dir=${spec%%|*}; glob=${spec#*|}
    mkdir -p "$TMPD/new/$dir"
    ct_list "$dir" > "$TMPD/list"
    while IFS= read -r -d '' name; do
      # в папке расширки — только код и тексты: без скрытых файлов, бэкапов, картинок и всего, что похоже на ключи
      if [[ $dir == extensions/* ]]; then
        [[ $name =~ \.(js|mjs|cjs|css|html|json|md|txt|svg)$ ]] || continue
        if [[ $name == .* || $name == *.bak* || ${name,,} == *secret* || ${name,,} == *token* || ${name,,} == *credential* ]]; then continue; fi
      fi
      # shellcheck disable=SC2053
      if [[ $name == $glob ]]; then rels+=("$dir/$name"); fi
    done < "$TMPD/list"
  done
  ct_fetch "$TMPD/new" "${rels[@]}"

  local rel
  for rel in "${rels[@]}"; do
    [[ -f "$TMPD/new/$rel" ]] || die "Не удалось забрать с сервера: $rel"
    if (( $(stat -c %s "$TMPD/new/$rel") > MAX_BYTES )); then
      warn "Пропускаю $rel — больше 90 МБ, GitHub такое не возьмёт."
      rm -f -- "$TMPD/new/$rel"
      if [[ -f "$MIRROR/$rel" ]]; then cp -- "$MIRROR/$rel" "$TMPD/new/$rel"; fi  # держим старую версию
    fi
  done

  for spec in "${SPECS[@]}"; do
    dir=${spec%%|*}
    n=$(find "$TMPD/new/$dir" -type f | wc -l)
    if (( n == 0 )) && [[ -n $(g ls-files -- "$dir") ]]; then
      die "На сервере пустая папка «$dir», а раньше там были файлы. Не трогаю ничего — проверь сервер."
    fi
  done

  for spec in "${SPECS[@]}"; do
    dir=${spec%%|*}
    rm -rf -- "${MIRROR:?}/$dir"
    mkdir -p "$MIRROR/$dir"
    cp -a "$TMPD/new/$dir/." "$MIRROR/$dir/"
  done
  export_settings
  export_chats
  export_extensions
  rm -rf "$TMPD"; TMPD=""

  g add -A -- "${DIRS[@]}"
  if [[ -e "$MIRROR/$EXPORT_DIR" ]]; then g add -A -- "$EXPORT_DIR"; fi
  g add -A -- "$CHATS_DIR" 2>/dev/null || true
  if ! g diff --cached --quiet; then
    g commit -q -m "$msg"
    return 0
  fi
  return 0
}

# безопасная выжимка settings.json: персоны, привязки лорбуков, теги — без ключей и токенов
export_settings() {
  command -v python3 >/dev/null || { warn "Нет python3 — персоны не выгружаю."; return 0; }
  mkdir -p "$TMPD/raw" "$TMPD/export"
  if ! ct_fetch "$TMPD/raw" settings.json 2>/dev/null || [[ ! -f "$TMPD/raw/settings.json" ]]; then
    warn "Не вышло прочитать settings.json — персоны не выгружаю."; return 0
  fi
  if python3 - "$TMPD/raw/settings.json" "$TMPD/export/settings-safe.json" <<'PYEOF'
import json, sys
s = json.load(open(sys.argv[1], encoding='utf-8'))
pu = s.get('power_user') or {}
wi = (s.get('world_info_settings') or {}).get('world_info') or {}
out = {
    'personas': pu.get('personas', {}),
    'persona_descriptions': pu.get('persona_descriptions', {}),
    'default_persona': pu.get('default_persona'),
    'world_info': {'globalSelect': wi.get('globalSelect', []), 'charLore': wi.get('charLore', [])},
    'tags': s.get('tags', []),
    'tag_map': s.get('tag_map', {}),
    'extensions': sorted((s.get('extension_settings') or {}).keys()),
}
open(sys.argv[2], 'w', encoding='utf-8').write(json.dumps(out, ensure_ascii=False, indent=2) + '\n')
PYEOF
  then
    mkdir -p "$MIRROR/$EXPORT_DIR"
    cp -- "$TMPD/export/settings-safe.json" "$MIRROR/$EXPORT_DIR/"
  else
    warn "Персоны не выгрузились."
  fi
  return 0
}

# список чатов + запрошенные Claude чаты (_request/chats.txt) → _chats/
export_chats() {
  command -v python3 >/dev/null || return 0
  local idx="$TMPD/chatidx"
  if ! ct_chat_index > "$idx" 2>/dev/null; then warn "Не вышло прочитать список чатов."; return 0; fi
  mkdir -p "$TMPD/export"
  if python3 - "$idx" "$TMPD/export/chats-index.json" <<'PYEOF'
import json, sys
rows = []
for line in open(sys.argv[1], encoding='utf-8', errors='replace'):
    parts = line.rstrip('\n').split('|', 2)
    if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
        rows.append({'path': parts[2], 'size': int(parts[0]), 'mtime': int(parts[1])})
rows.sort(key=lambda r: r['path'])
open(sys.argv[2], 'w', encoding='utf-8').write(json.dumps(rows, ensure_ascii=False, indent=2) + '\n')
PYEOF
  then
    mkdir -p "$MIRROR/$EXPORT_DIR"
    cp -- "$TMPD/export/chats-index.json" "$MIRROR/$EXPORT_DIR/"
  else
    warn "Список чатов не собрался."
  fi

  # запросы берём из свежей origin/main: так просьба Claude срабатывает в тот же запуск
  { g show "origin/$BRANCH:$REQUEST_FILE" 2>/dev/null || g show "HEAD:$REQUEST_FILE" 2>/dev/null || true; } > "$TMPD/req"
  python3 - "$idx" "$TMPD/req" "$TMPD/want" "$MAX_BYTES" <<'PYEOF' || { warn "Запросы чатов не разобрались."; return 0; }
import sys
idx = []
for line in open(sys.argv[1], encoding='utf-8', errors='replace'):
    parts = line.rstrip('\n').split('|', 2)
    if len(parts) == 3 and parts[0].isdigit():
        idx.append((int(parts[0]), parts[2]))
reqs = [l.strip() for l in open(sys.argv[2], encoding='utf-8', errors='replace')]
mx = int(sys.argv[4])
out = []
for r in reqs:
    if not r or r.startswith('#'):
        continue
    if '..' in r or not (r.startswith('chats/') or r.startswith('group chats/')):
        print('⚠️  Пропускаю запрос не из чатов: ' + r, file=sys.stderr)
        continue
    hit = False
    for size, path in idx:
        if path == r or (r.endswith('/') and path.startswith(r)):
            hit = True
            if size > mx:
                print('⚠️  Чат больше 90 МБ, пропускаю: ' + path, file=sys.stderr)
            elif path not in out:
                out.append(path)
    if not hit:
        print('⚠️  Не нашла на сервере чат из запроса: ' + r, file=sys.stderr)
open(sys.argv[3], 'w', encoding='utf-8').write(''.join(p + '\0' for p in out))
PYEOF
  local -a want=()
  mapfile -d '' -t want < "$TMPD/want"
  rm -rf -- "${MIRROR:?}/$CHATS_DIR"
  (( ${#want[@]} )) || return 0
  mkdir -p "$TMPD/chats"
  if ! ct_fetch "$TMPD/chats" "${want[@]}"; then warn "Запрошенные чаты не забрались."; return 0; fi
  mkdir -p "$MIRROR/$CHATS_DIR"
  cp -a "$TMPD/chats/." "$MIRROR/$CHATS_DIR/"
  say "💬 Чатов для Claude в снимке: ${#want[@]}"
  return 0
}

# ---------- изменения ----------

# заполняет массивы CH_ST и CH_PATH изменениями $1..$2 в синк-папках
collect_changes() {
  CH_ST=(); CH_PATH=()
  local tmp; tmp=$(mktemp)
  g diff --no-renames --name-status -z "$1" "$2" -- "${DIRS[@]}" > "$tmp"
  local -a parts=()
  mapfile -d '' -t parts < "$tmp"
  rm -f "$tmp"
  local i
  for (( i=0; i+1<${#parts[@]}; i+=2 )); do
    CH_ST+=("${parts[i]:0:1}"); CH_PATH+=("${parts[i+1]}")
  done
}

show_changes() {
  local i mark
  for i in "${!CH_PATH[@]}"; do
    case ${CH_ST[i]} in A) mark="+ новый   ";; D) mark="− удалить ";; *) mark="~ правка  ";; esac
    say "   $mark ${CH_PATH[i]}"
  done
}

validate_changes() {
  local i f bad=0
  for i in "${!CH_PATH[@]}"; do
    [[ ${CH_ST[i]} == D ]] && continue
    f="$MIRROR/${CH_PATH[i]}"
    case $f in
      *.json)
        if command -v python3 >/dev/null; then
          python3 -c 'import json,sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$f" 2>/dev/null \
            || { warn "Битый JSON: ${CH_PATH[i]}"; bad=1; }
        elif command -v node >/dev/null; then
          node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$f" 2>/dev/null \
            || { warn "Битый JSON: ${CH_PATH[i]}"; bad=1; }
        else
          warn "Нет python3/node — JSON не проверен: ${CH_PATH[i]}"
        fi;;
      *.png)
        [[ $(head -c 8 "$f" | od -An -tx1 | tr -d ' \n') == 89504e470d0a1a0a ]] \
          || { warn "Не PNG: ${CH_PATH[i]}"; bad=1; };;
    esac
  done
  return $bad
}

# CO_PATH: новые чаты от Claude в _out/ между $1 и $2
collect_out() {
  CO_PATH=()
  local tmp; tmp=$(mktemp)
  g diff --no-renames --name-only -z --diff-filter=AM "$1" "$2" -- "$OUT_DIR" > "$tmp" 2>/dev/null || true
  mapfile -d '' -t CO_PATH < "$tmp"
  rm -f "$tmp"
}

show_out() {
  local p
  for p in "${CO_PATH[@]}"; do say "   + новый чат ${p#"$OUT_DIR"/}"; done
}

validate_out() {
  local p rel name dir listing bad=0
  for p in "${CO_PATH[@]}"; do
    rel=${p#"$OUT_DIR"/}
    if [[ ! $rel =~ ^chats/[^/]+/[^/]+\.jsonl$ && ! $rel =~ ^group\ chats/[^/]+\.jsonl$ ]]; then
      warn "Чат не туда: $rel"; bad=1; continue
    fi
    dir=$(dirname -- "$rel"); name=$(basename -- "$rel")
    listing=$(ct_list "$dir" | tr '\0' '\n')
    if grep -Fxq -- "$name" <<<"$listing"; then
      warn "Такой чат уже есть — не перезаписываю: $rel"; bad=1; continue
    fi
    if command -v python3 >/dev/null; then
      python3 - "$MIRROR/$p" <<'PYEOF' || { warn "Битый чат (JSONL): $rel"; bad=1; }
import json, sys
try:
    lines = [l for l in open(sys.argv[1], encoding='utf-8') if l.strip()]
    assert lines and isinstance(json.loads(lines[0]), dict)
    for l in lines:
        json.loads(l)
except Exception:
    sys.exit(1)
PYEOF
    fi
  done
  return $bad
}

apply_out() {
  local p rel owner
  owner=$(ct_owner)
  for p in "${CO_PATH[@]}"; do
    rel=${p#"$OUT_DIR"/}
    ct_mkdir "$(dirname -- "$rel")"
    ct_put "$MIRROR/$p" "$rel"
    ct_chown "$owner" "$rel"
  done
}

confirm() {
  [[ -n $YES ]] && return 0
  local ans=""
  read -r -p "$1 [y/N] " ans || true
  [[ $ans == [yYдД]* ]]
}

apply_changes() {
  local i owner rel
  owner=$(ct_owner)
  for i in "${!CH_PATH[@]}"; do
    rel=${CH_PATH[i]}
    if [[ ${CH_ST[i]} == D ]]; then
      ct_rm "$rel"
    else
      if [[ $rel == extensions/* ]]; then ct_mkdir "$(dirname -- "$rel")"; ct_chown "$owner" "$(dirname -- "$rel")"; fi
      ct_put "$MIRROR/$rel" "$rel"
      ct_chown "$owner" "$rel"
    fi
    local th; th=$(thumb_of "$rel")
    if [[ -n $th ]]; then ct_rm "$th"; fi
  done
  # проверка: на сервере ровно то, что в зеркале
  local -a put=()
  for i in "${!CH_PATH[@]}"; do if [[ ${CH_ST[i]} != D ]]; then put+=("${CH_PATH[i]}"); fi; done
  TMPD=$(mktemp -d)
  ct_fetch "$TMPD" "${put[@]}"
  local ok=1
  for rel in "${put[@]}"; do
    cmp -s -- "$TMPD/$rel" "$MIRROR/$rel" || { warn "Не совпало после записи: $rel"; ok=0; }
  done
  rm -rf "$TMPD"; TMPD=""
  local listing
  for i in "${!CH_PATH[@]}"; do
    [[ ${CH_ST[i]} == D ]] || continue
    listing=$(ct_list "$(dirname -- "${CH_PATH[i]}")" | tr '\0' '\n')
    if grep -Fxq -- "$(basename -- "${CH_PATH[i]}")" <<<"$listing"; then
      warn "Не удалилось: ${CH_PATH[i]}"; ok=0
    fi
  done
  (( ok )) || die "Применилось не всё. Запусти «st-sync undo» и напиши Claude."
}

after_apply_hint() {
  say "✅ Готово. Теперь обнови страницу ST в Safari — до этого ничего не жми в лорбуках."
  local p
  for p in "${CH_PATH[@]}"; do
    if [[ $p == "OpenAI Settings/"* ]]; then
      say "   Менялся пресет — после обновления выбери его заново в списке пресетов."
      break
    fi
  done
  for p in "${CH_PATH[@]}"; do
    if [[ $p == extensions/* ]]; then
      say "   Менялись файлы расширки — она подхватится после обновления страницы."
      break
    fi
  done
  for p in "${CH_PATH[@]}"; do
    if [[ $p == characters/* || $p == "User Avatars/"* ]]; then
      say "   Менялись картинки — их миниатюры я снесла, ST соберёт свежие. Если Safari упрямится — обнови страницу ещё раз."
      break
    fi
  done
}

# ---------- команды ----------

cmd_sync() {
  cmd_sync_data
  ext_sync
}

cmd_sync_data() {
  mirror_ready || die "Сначала: st-sync setup"
  ct_check
  lock
  recover_git
  fix_thumbs
  say "⏳ Снимаю сервер…"
  g fetch -q origin 2>/dev/null || die "Нет связи с GitHub. Запусти: st-sync setup"
  drop_unsent_merge
  load_local_exts
  local before; before=$(g rev-parse -q --verify HEAD 2>/dev/null || true)
  snapshot "сервер: снимок $(date '+%Y-%m-%d %H:%M')"
  g rev-parse -q --verify HEAD >/dev/null || die "На сервере не нашлось ни лорбуков, ни пресетов — проверь контейнер $CT."
  # snap — сервер как есть; возврат откатившегося ложится коммитом поверх и едет на сервер как обычная правка
  local snap; snap=$(g rev-parse HEAD)
  restore_reverts "$before"

  if ! has_origin_main; then
    push_main; g branch -q -u "origin/$BRANCH" 2>/dev/null || true
    say "✅ Первый снимок отправлен. Новых правок от Claude пока нет."
    return 0
  fi

  if g merge-base --is-ancestor "origin/$BRANCH" HEAD; then
    if [[ $(g rev-parse HEAD) != "$snap" ]]; then
      # новых правок нет, но есть что вернуть
      collect_changes "$snap" HEAD
      say "↩️  Возвращаю откатившееся:"
      show_changes
      if validate_changes && confirm "Вернуть на сервер?"; then
        apply_changes
        REVERT_NOTE=""
        push_main
        after_apply_hint
      else
        g reset -q --hard "$snap"; note_reverts
        push_main
      fi
      return 0
    fi
    push_main
    say "✅ Снимок отправлен. Новых правок от Claude нет."
    return 0
  fi

  local mout
  if ! mout=$(g merge -q --no-ff --no-edit --allow-unrelated-histories -m "применить правки Claude" "origin/$BRANCH" 2>&1); then
    local conflicted
    conflicted=$(g diff --name-only --diff-filter=U 2>/dev/null || true)
    g merge --abort 2>/dev/null || true
    g reset -q --hard "$snap"; note_reverts
    push_server_branch
    if [[ -n $conflicted ]]; then
      say "⚠️  Правки Claude конфликтуют с тем, что изменилось на сервере:"
      printf '   %s\n' "$conflicted"
    else
      say "⚠️  Git не смог свести правки: $mout"
    fi
    say "Ничего не применено. Напиши Claude «конфликт» — он сведёт и пришлёт заново."
    exit 2
  fi

  local merge; merge=$(g rev-parse HEAD)
  collect_changes "$snap" "$merge"
  collect_out "$snap" "$merge"
  if (( ${#CH_PATH[@]} == 0 && ${#CO_PATH[@]} == 0 )); then
    push_main
    say "✅ Снимок отправлен. В правках Claude нет файлов для сервера."
    return 0
  fi

  if [[ -n $REVERT_NOTE ]]; then say "📦 Правки от Claude (и то, что откатилось, — верну заодно):"; else say "📦 Правки от Claude:"; fi
  show_changes
  show_out
  if ! validate_changes || ! validate_out; then
    g reset -q --hard "$snap"; note_reverts; push_server_branch
    die "Что-то из правок применить нельзя (см. выше) — ничего не применено. Напиши Claude."
  fi
  if ! confirm "Применить на сервер?"; then
    g reset -q --hard "$snap"; note_reverts; push_server_branch
    say "Ок, не применяю. Правки ждут в репе."
    return 0
  fi

  printf '%s\n' "$merge" > "$MIRROR/.git/st-sync-last"
  if (( ${#CH_PATH[@]} )); then apply_changes; fi
  if (( ${#CO_PATH[@]} )); then apply_out; fi
  REVERT_NOTE=""
  push_main
  after_apply_hint
  if (( ${#CO_PATH[@]} )); then
    say "   Новый чат — в списке чатов персонажа; старый остался как был. Не понравится — удали новый в ST."
  fi
}

cmd_undo() {
  mirror_ready || die "Сначала: st-sync setup"
  ct_check
  lock
  recover_git
  [[ -s "$MIRROR/.git/st-sync-last" ]] || die "Нечего откатывать."
  local merge; merge=$(<"$MIRROR/.git/st-sync-last")
  g cat-file -e "$merge^{commit}" 2>/dev/null || die "Не нашла последнее применение."
  g fetch -q origin 2>/dev/null || warn "Нет связи с GitHub — откат сделаю, отправлю позже."
  load_local_exts
  say "⏳ Снимаю сервер перед откатом…"
  snapshot "сервер: снимок перед откатом $(date '+%Y-%m-%d %H:%M')"
  local before; before=$(g rev-parse HEAD)
  if ! g revert --no-edit -m 1 "$merge" >/dev/null 2>&1; then
    g revert --abort 2>/dev/null || true
    die "Откат конфликтует со свежими изменениями на сервере. Ничего не тронуто — напиши Claude."
  fi
  collect_changes "$before" HEAD
  if (( ${#CH_PATH[@]} == 0 )); then
    g reset -q --hard "$before"
    rm -f "$MIRROR/.git/st-sync-last"
    say "Откатывать нечего — сервер уже в том состоянии."
    return 0
  fi
  say "↩️  Откат вернёт:"
  show_changes
  if ! confirm "Откатить?"; then g reset -q --hard "$before"; say "Ок, не трогаю."; return 0; fi
  apply_changes
  rm -f "$MIRROR/.git/st-sync-last"
  g push -q origin "HEAD:refs/heads/$BRANCH" 2>/dev/null || warn "Откат на сервере есть, а в репу не ушёл — запусти st-sync позже."
  after_apply_hint
}

cmd_status() {
  mirror_ready || die "Сначала: st-sync setup"
  g fetch -q origin 2>/dev/null || warn "Нет связи с GitHub."
  say "Последний снимок: $(g log -1 --format='%cd' --date=format:'%d.%m %H:%M' 2>/dev/null || echo —)"
  if has_origin_main && ! g merge-base --is-ancestor "origin/$BRANCH" HEAD; then
    say "Ждут правки от Claude: $(g rev-list --count "HEAD..origin/$BRANCH") коммит(ов) — запусти st-sync"
  else
    say "Новых правок от Claude нет."
  fi
  if [[ -s "$MIRROR/.git/st-sync-last" ]]; then say "Последнее применение можно откатить: st-sync undo"; fi
  return 0
}

cmd_update() {
  command -v curl >/dev/null || die "Нет curl."
  local self tmp
  self=$(readlink -f "$0")
  tmp=$(mktemp)
  curl -fsSL "$SELF_URL?t=$(date +%s)" -o "$tmp" || { rm -f "$tmp"; die "Не скачалось обновление."; }
  bash -n "$tmp" || { rm -f "$tmp"; die "Скачанный скрипт битый — оставляю старый."; }
  install -m 755 "$tmp" "$self"
  rm -f "$tmp"
  say "✅ st-sync обновлён."
}

cmd_setup() {
  local c
  for c in git ssh ssh-keygen; do
    command -v "$c" >/dev/null || die "Нет $c. Поставь: apt-get install -y git openssh-client"
  done
  ct_check
  mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
  [[ -f $KEY ]] || ssh-keygen -q -t ed25519 -N "" -C "st-data deploy key" -f "$KEY"
  touch "$HOME/.ssh/config"
  if ! grep -q "^Host $HOST_ALIAS\$" "$HOME/.ssh/config"; then
    printf '\nHost %s\n  HostName github.com\n  User git\n  IdentityFile %s\n  IdentitiesOnly yes\n' \
      "$HOST_ALIAS" "$KEY" >> "$HOME/.ssh/config"
  fi
  chmod 600 "$HOME/.ssh/config"
  ssh-keygen -F github.com >/dev/null 2>&1 || ssh-keyscan -t ed25519,ecdsa,rsa github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null

  local out; out=$(ssh -T -o BatchMode=yes "git@$HOST_ALIAS" 2>&1 || true)
  if ! grep -q "successfully authenticated" <<<"$out"; then
    say ""
    say "🔑 Ключ для GitHub (скопируй всю строку):"
    say ""
    cat "$KEY.pub"
    say ""
    say "Дальше: github.com/$REPO → Settings → Deploy keys → Add deploy key"
    say "Title: st-server, Key: строка выше, галочка «Allow write access» → Add key."
    say "Потом снова: st-sync setup"
    return 0
  fi
  say "🔗 GitHub на связи."

  if ! mirror_ready; then
    git clone -q "$REMOTE" "$MIRROR" 2>/dev/null || die "Не клонируется $REPO — репа точно создана?"
  fi
  g config user.name "ST server"
  g config user.email "st-server@localhost"
  g config core.quotepath false
  g config pull.rebase false
  if ! g rev-parse -q --verify HEAD >/dev/null; then
    g symbolic-ref HEAD "refs/heads/$BRANCH"
  fi
  cmd_sync
}

case "${1:-sync}" in
  sync|"") shift || true; [[ ${1:-} == -y ]] && YES=1; cmd_sync ;;
  -y)      YES=1; cmd_sync ;;
  undo)    shift; [[ ${1:-} == -y ]] && YES=1; cmd_undo ;;
  status)  cmd_status ;;
  setup)   cmd_setup ;;
  update)  cmd_update ;;
  ext)     cmd_ext ;;
  help|-h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "Не знаю команду «$1». Есть: st-sync, st-sync ext, st-sync undo, st-sync status, st-sync update, st-sync setup" ;;
esac
