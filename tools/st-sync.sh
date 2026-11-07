#!/usr/bin/env bash
# st-sync — мост между SillyTavern (docker) и приватной репой на GitHub.
#
#   st-sync setup   — первый запуск: ключ, связь с GitHub, первый снимок
#   st-sync         — снимок сервера → забрать правки Claude → показать → применить
#   st-sync undo    — откатить последнее применение (свежие записи STMB не трогает)
#   st-sync status  — что сейчас происходит
#   st-sync update  — обновить сам st-sync с GitHub
#
# Синкаются только: worlds/*.json, OpenAI Settings/*.json, groups/*.json, characters/*.png.
# Из settings.json уезжает только выжимка (_export/settings-safe.json): персоны, привязки
# лорбуков, теги. Чаты, бэкапы, ключи API (secrets.json, токены расширений) никогда не уезжают.

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
SPECS=("worlds|*.json" "OpenAI Settings|*.json" "groups|*.json" "characters|*.png")
EXPORT_DIR="_export"   # только для чтения Claude; на сервер никогда не применяется
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
  rm -rf "$TMPD"; TMPD=""

  g add -A -- "${DIRS[@]}"
  if [[ -e "$MIRROR/$EXPORT_DIR" ]]; then g add -A -- "$EXPORT_DIR"; fi
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
    if [[ $p == characters/* ]]; then
      say "   Менялись карточки — если ST покажет старое, перезапусти: docker restart $CT"
      break
    fi
  done
}

# ---------- команды ----------

cmd_sync() {
  mirror_ready || die "Сначала: st-sync setup"
  ct_check
  lock
  recover_git
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
  if (( ${#CH_PATH[@]} == 0 )); then
    push_main
    say "✅ Снимок отправлен. В правках Claude нет файлов для сервера."
    return 0
  fi

  say "📦 Правки от Claude:"
  show_changes
  if ! validate_changes; then
    g reset -q --hard "$snap"; push_server_branch
    die "Есть битые файлы — ничего не применено. Напиши Claude."
  fi
  if ! confirm "Применить на сервер?"; then
    g reset -q --hard "$snap"; push_server_branch
    say "Ок, не применяю. Правки ждут в репе."
    return 0
  fi

  printf '%s\n' "$merge" > "$MIRROR/.git/st-sync-last"
  apply_changes
  push_main
  after_apply_hint
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
  help|-h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "Не знаю команду «$1». Есть: st-sync, st-sync undo, st-sync status, st-sync update, st-sync setup" ;;
esac
