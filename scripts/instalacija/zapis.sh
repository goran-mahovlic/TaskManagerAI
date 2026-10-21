# zapis.sh — log instalacije (plan Mac v3 P3.1). Uključuje ga scripts/install.sh (`.`).
#
# Mjesto: $LOG_RODITELJ/<YYYYMMDD-HHMMSS>/ (zadano $TM_HOME/log/install), simlink `zadnji`:
#   koraci.jsonl           jedan redak po koraku (i preskočenom) s izlaznim kodom
#   install.log            puni izlaz svake naredbe, s vremenom (tajne zatamnjene)
#   okolina.txt            OS, verzije alata, disk, RAM, zauzeta vrata (bez varijabli okoline)
#   install-rezultat.json  sažetak — piše se UVIJEK: uspjeh, pad, prekid (INT/TERM)
# Uz --suho ništa se ne zapisuje: retci koraka idu samo na izlaz (prefiks „KORAK ").
# Isti zapis koriste deinstaliraj.sh i nadogradi.sh: ZAPIS_IME=deinstalacija daje
# deinstalacija.log i deinstalacija-rezultat.json (zadano: install).
#
# Ovisi samo o bash, sed, awk, date (postoje na Debianu i macOS-u prije buna i Pythona).

# JSON niz: \ " i kontrolni znakovi; ostalo (UTF-8) prolazi.
json_s() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"; s="${s//$'\r'/\\r}"; s="${s//$'\t'/\\t}"
  s="$(printf '%s' "$s" | tr -d '\000-\010\013\014\016-\037')"
  printf '"%s"' "$s"
}

# Tajne nikad u log: KLJUČ=vrijednost za *TOKEN*/*KEY*/*PASSWORD*/*SECRET* (i u navodnicima),
# lozinka u postgres://korisnik:lozinka@, Bearer, sk-… ključevi, lozinka iza -P/--password,
# Telegram token i bez imena varijable (api.telegram.org/bot<broj>:<35>/…) i GitHub tokeni.
# Nezatvoren navodnik skriva do kraja retka. Uzorak imena i jednostruki navod stoje u varijablama — "…" i '…' se ne mogu ugnijezditi doslovno.
zatamni() {
  local ime='([A-Za-z0-9_]*(TOKEN|KEY|PASSWORD|PASSWD|SECRET|PASS)[A-Za-z0-9_]*)([[:space:]]*[=:][[:space:]]*)'
  local n="'"
  sed -E \
    -e "s/${ime}\"[^\"]*\"/\\1\\3«skriveno»/g" \
    -e "s/${ime}${n}[^${n}]*${n}/\\1\\3«skriveno»/g" \
    -e "s/${ime}[\"${n}].*$/\\1\\3«skriveno»/" \
    -e "s/${ime}[^[:space:]]+/\\1\\3«skriveno»/g" \
    -e 's#(postgres(ql)?|pg0|mysql|redis)://([^:/@[:space:]]+):[^@[:space:]]+@#\1://\3:«skriveno»@#g' \
    -e 's/([Bb]earer[[:space:]]+)[A-Za-z0-9._~+\/=-]+/\1«skriveno»/g' \
    -e 's/sk-[A-Za-z0-9_-]{16,}/«skriveno»/g' \
    -e 's/[0-9]{8,12}:[A-Za-z0-9_-]{35}/«skriveno»/g' \
    -e 's/gh[pousr]_[A-Za-z0-9]{36,}/«skriveno»/g' \
    -e 's/github_pat_[A-Za-z0-9_]{22,}/«skriveno»/g' \
    -e 's/(^|[[:space:]])(-P|--password)([[:space:]=]+)[^[:space:]]+/\1\2\3«skriveno»/g'
}

sad_iso() { date '+%Y-%m-%dT%H:%M:%S%z' | sed -E 's/([0-9]{2})([0-9]{2})$/\1:\2/'; }
# sekunde s decimalama: GNU date (%N), inače perl (macOS); Debian bez libperl nema Time::HiRes
sad_s() {
  local n; n="$(date +%s.%N 2>/dev/null)"
  case "$n" in *N*|'') perl -MTime::HiRes=time -e 'printf "%.3f", time' 2>/dev/null || date +%s ;; *) printf '%.3f' "$n" ;; esac
}
razlika_s() { awk -v a="$1" -v b="$2" -v f="${3:-%.2f}" 'BEGIN { printf f, b - a }'; }

# log_otvori <roditelj> — stvori mapu kruga (osim uz --suho) i postavi KORACI/INSTALL_LOG/…
log_otvori() {
  LOG_RODITELJ="$1"
  LOG_POCETAK_S="$(sad_s)"
  LOG_POCETAK="$(sad_iso)"
  if [ "${SUHO:-0}" = 1 ]; then LOG_DIR=""; KORACI=""; INSTALL_LOG=""; return 0; fi
  local ime; ime="$(date '+%Y%m%d-%H%M%S')"
  LOG_DIR="$LOG_RODITELJ/$ime"
  local n=2; while [ -e "$LOG_DIR" ]; do LOG_DIR="$LOG_RODITELJ/$ime-$n"; n=$((n + 1)); done
  mkdir -p "$LOG_DIR" || { echo "GREŠKA: ne mogu stvoriti mapu loga $LOG_DIR" >&2; return 1; }
  chmod 700 "$LOG_RODITELJ" "$LOG_DIR" 2>/dev/null
  KORACI="$LOG_DIR/koraci.jsonl"; INSTALL_LOG="$LOG_DIR/${ZAPIS_IME:-install}.log"
  : > "$KORACI"; : > "$INSTALL_LOG"
  ln -sfn "$(basename "$LOG_DIR")" "$LOG_RODITELJ/zadnji"
}

# zapis_log <tekst…> — na izlaz i u install.log (s vremenom), zatamnjeno
zapis_log() {
  local t; t="$(printf '%s\n' "$*" | zatamni)"
  printf '%s\n' "$t"
  [ -n "${INSTALL_LOG:-}" ] && printf '%s\n' "$t" | sed "s/^/[$(date '+%H:%M:%S')] /" >> "$INSTALL_LOG"
  return 0
}

# zapis_korak id opis naredba izlaz trajanje promijenjeno razlog stderr_rep [upozorenje]
zapis_korak() {
  local red
  red="{\"t\":$(json_s "$(sad_iso)"),\"korak\":$(json_s "$1"),\"opis\":$(json_s "$2"),\"naredba\":$(json_s "$(printf '%s' "$3" | zatamni)"),\"izlaz\":$4,\"trajanje_s\":$5,\"promijenjeno\":$6"
  [ -n "$7" ] && red="$red,\"razlog\":$(json_s "$7")"
  [ -n "${9:-}" ] && red="$red,\"upozorenje\":$(json_s "$9")"
  red="$red,\"stderr_rep\":$(json_s "$8")}"
  if [ -n "${KORACI:-}" ]; then printf '%s\n' "$red" >> "$KORACI"; else printf 'KORAK %s\n' "$red"; fi
}

# zapis_rezultat ishod korak izlaz poruka — install-rezultat.json (i uz pad i uz prekid)
zapis_rezultat() {
  local trajanje commit
  trajanje="$(razlika_s "$LOG_POCETAK_S" "$(sad_s)" '%.1f')"
  commit="$(git -C "${PAKET:-.}" rev-parse HEAD 2>/dev/null || echo nepoznat)"
  local j
  j="{\"ishod\":$(json_s "$1"),\"korak\":$(json_s "$2"),\"izlaz\":$3,\"poruka\":$(json_s "$(printf '%s' "$4" | zatamni)"),"
  j="$j\"promijenjeno\":${N_PROMIJENJENO:-0},\"preskoceno\":${N_PRESKOCENO:-0},\"koraka\":${N_KORAKA:-0},"
  j="$j\"pocetak\":$(json_s "$LOG_POCETAK"),\"kraj\":$(json_s "$(sad_iso)"),\"trajanje_s\":$trajanje,"
  j="$j\"os\":$(json_s "${OS_OPIS:-nepoznat}"),\"paket\":$(json_s "${PAKET:-}"),\"paket_commit\":$(json_s "$commit"),"
  j="$j\"argumenti\":$(json_s "${ARGUMENTI:-}"),\"ploca\":$(json_s "${PLOCA_URL:-}"),"
  j="$j\"koraci\":$(json_s "${KORACI:-}"),\"install_log\":$(json_s "${INSTALL_LOG:-}")}"
  if [ -n "${LOG_DIR:-}" ]; then printf '%s\n' "$j" > "$LOG_DIR/${ZAPIS_IME:-install}-rezultat.json"; else printf 'REZULTAT %s\n' "$j"; fi
}

# okolina.txt — samo ono što pomaže pri dijagnozi pada; NIKAD `env`/`set` (tajne).
zapis_okolinu() {
  [ -n "${LOG_DIR:-}" ] || return 0
  {
    echo "vrijeme: $(sad_iso)"
    echo "uname: $(uname -a 2>/dev/null)"
    if command -v sw_vers >/dev/null 2>&1; then sw_vers 2>/dev/null; fi
    [ -f /etc/os-release ] && grep -E '^(PRETTY_NAME|VERSION_ID|ID)=' /etc/os-release
    echo "korisnik: $(id -un 2>/dev/null) uid=$(id -u) HOME=$HOME"
    echo "TM_HOME: ${TM_HOME:-}"
    echo "PATH: $PATH"
    for a in git curl perl python3 bun claude uv sqlite3 plutil tailscale brew; do
      if command -v "$a" >/dev/null 2>&1; then
        printf '%-10s %s  (%s)\n' "$a" "$("$a" --version 2>/dev/null | head -1)" "$(command -v "$a")"
      else printf '%-10s —\n' "$a"; fi
    done
    echo "disk (HOME): $(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {printf "%.1f GiB slobodno od %.1f GiB", $4/1048576, $2/1048576}')"
    if command -v sysctl >/dev/null 2>&1 && sysctl -n hw.memsize >/dev/null 2>&1; then
      echo "RAM: $(( $(sysctl -n hw.memsize) / 1073741824 )) GiB"
    elif getconf _PHYS_PAGES >/dev/null 2>&1; then
      echo "RAM: $(awk -v s="$(getconf _PHYS_PAGES)" -v p="$(getconf PAGESIZE)" 'BEGIN {printf "%.1f GiB", s*p/1073741824}')"
    fi
    echo "zauzeta vrata (17781 15433 17796 17797):"
    for v in 17781 15433 17796 17797; do
      if command -v bun >/dev/null 2>&1; then p="$(bun "$PAKET/src/core/platforma.ts" pid-na-vratima "$v" 2>/dev/null)"
      elif command -v lsof >/dev/null 2>&1; then p="$(lsof -nP -iTCP:"$v" -sTCP:LISTEN -t 2>/dev/null | head -1)"; else p="? (još nema buna)"; fi
      echo "  $v: ${p:-slobodno}"
    done
  } 2>&1 | zatamni > "$LOG_DIR/okolina.txt"
}
