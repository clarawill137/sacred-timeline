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
    rm -rf -- "${MIRROR:?}/$EXPORT_DIR"
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
  snapshot "сервер: снимок $(date '+%Y-%m-%d %H:%M')"
  g rev-parse -q --verify HEAD >/dev/null || die "На сервере не нашлось ни лорбуков, ни пресетов — проверь контейнер $CT."
  local snap; snap=$(g rev-parse HEAD)

  if ! has_origin_main; then
    push_main; g branch -q -u "origin/$BRANCH" 2>/dev/null || true
    say "✅ Первый снимок отправлен. Новых правок от Claude пока нет."
    return 0
  fi

  if g merge-base --is-ancestor "origin/$BRANCH" HEAD; then
    push_main
    say "✅ Снимок отправлен. Новых правок от Claude нет."
    return 0
  fi

  local mout
  if ! mout=$(g merge -q --no-ff --no-edit --allow-unrelated-histories -m "применить правки Claude" "origin/$BRANCH" 2>&1); then
    local conflicted
    conflicted=$(g diff --name-only --diff-filter=U 2>/dev/null || true)
    g merge --abort 2>/dev/null || g reset -q --hard "$snap"
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

  say "📦 Правки от Claude:"
  show_changes
  show_out
  if ! validate_changes || ! validate_out; then
    g reset -q --hard "$snap"; push_server_branch
    die "Что-то из правок применить нельзя (см. выше) — ничего не применено. Напиши Claude."
  fi
  if ! confirm "Применить на сервер?"; then
    g reset -q --hard "$snap"; push_server_branch
    say "Ок, не применяю. Правки ждут в репе."
    return 0
  fi

  printf '%s\n' "$merge" > "$MIRROR/.git/st-sync-last"
  if (( ${#CH_PATH[@]} )); then apply_changes; fi
  if (( ${#CO_PATH[@]} )); then apply_out; fi
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
  help|-h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "Не знаю команду «$1». Есть: st-sync, st-sync ext, st-sync undo, st-sync status, st-sync update, st-sync setup" ;;
esac
