#!/usr/bin/env bash
# provjeri-cisto.sh — je li stroj čist od TaskManagerAI (plan Mac v3 P3.4, petlja L0/L5).
#
#   bash scripts/provjeri-cisto.sh [--vrata 17781,15433,…]
#   curl -fsSL <raw-adresa>/scripts/provjeri-cisto.sh | bash        # radi i bez repozitorija
#   ssh čvor 'bash -s' < scripts/provjeri-cisto.sh
#
# Ispisuje JEDAN redak po ostatku (vrsta<TAB>što), ništa drugo na stdout:
#   usluga    plistovi hr.regoc.* (LaunchDaemons/LaunchAgents) ili jedinice regoc-* (systemd --user)
#   ucitano   usluga koju upravitelj (launchd/systemd) još drži učitanom
#   proces    procesi ovog korisnika (bun|hindsight|postgres|ollama) pokrenuti iz $HOME
#   vrata     zauzeta vrata 17781 17792 17796 17797 15432 15433 11434 koja drži proces iz $HOME
#             (tuđi proces na tim vratima → samo napomena na stderr)
#   put       $TM_HOME i svaki put iz manifesta instalirano.json (i arhivirane kopije) koji postoji
#   rc        blok `# >>> TaskManagerAI >>>` u ~/.zprofile, ~/.zshrc, ~/.bashrc, ~/.profile…
#   kljuc     redak s oznakom tm-tunel u ~/.ssh/authorized_keys
# 0 redaka = čisto (izlaz 0), inače izlaz 1. Sažetak ide na stderr.
#
# NE broji: ~/.taskmanager-log-arhiva/ (logovi krugova, namjerno sačuvani) i ~/taskmanager-backup-*.tgz.
# Ne gleda ništa što instalacija nije stvorila (Homebrew, tailscale, tuđe datoteke) — tuđe nije ostatak.
# Ovisi samo o bash 3.2, sed, grep, ps, lsof ili ss (macOS i Debian bez buna i Pythona).
set -u

VRATA="${TM_CISTO_VRATA:-17781 17792 17796 17797 15432 15433 11434}"
while [ $# -gt 0 ]; do
  case "$1" in
    --vrata) VRATA="$(printf '%s' "${2:-}" | tr ',' ' ')"; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null || true; exit 0 ;;
    *) echo "provjeri-cisto: nepoznat argument: $1" >&2; exit 2 ;;
  esac
  shift
done

TM_HOME="${TM_HOME:-$HOME/.taskmanager}"
ARHIVA="${TM_LOG_ARHIVA:-$HOME/.taskmanager-log-arhiva}"
LAUNCHD_DIR="${TM_LAUNCHD_DIR:-/Library/LaunchDaemons}"
OS="${TM_INSTALL_OS:-$(uname -s)}"
case "$OS" in Darwin|darwin) OS=darwin ;; *) OS=linux ;; esac
N=0
ostatak() { printf '%s\t%s\n' "$1" "$2"; N=$((N + 1)); }

# ── usluge ────────────────────────────────────────────────────────────────────
for f in "$LAUNCHD_DIR"/hr.regoc.*.plist "$HOME/Library/LaunchAgents"/hr.regoc.*.plist \
         "$HOME/.config/systemd/user"/regoc-*.service "$HOME/.config/systemd/user"/regoc-*.timer; do
  [ -e "$f" ] && ostatak usluga "$f"
done
if [ "$OS" = darwin ]; then
  ucitane="$( { launchctl print system 2>/dev/null || sudo -n launchctl print system 2>/dev/null; } \
    | grep -oE 'hr\.regoc\.[A-Za-z0-9_.-]+' | sort -u)"
  for o in $ucitane; do ostatak ucitano "system/$o"; done
elif command -v systemctl >/dev/null 2>&1; then
  # samo jedinice iz OVOG HOME-a (isti korisnički upravitelj može nositi i druge instalacije)
  for u in $(systemctl --user list-units 'regoc-*' --all --no-legend --plain 2>/dev/null | awk '{print $1}'); do
    fp="$(systemctl --user show -p FragmentPath --value "$u" 2>/dev/null)"
    case "$fp" in "$HOME"/*) ostatak ucitano "$u ($fp)" ;; esac
  done
fi

# ── procesi i vrata ───────────────────────────────────────────────────────────
JA=$$
while read -r pid args; do
  [ "$pid" = "$JA" ] && continue
  case "$args" in *"$HOME/"*) ;; *) continue ;; esac
  # program = prvi član naredbe (python … hindsight-api: drugi); tekst argumenata se ne gleda
  set -- $args; prog="${1##*/}"
  case "$prog" in python*|env) prog="${2:-}"; prog="${prog##*/}" ;; esac
  case "$prog" in bun|postgres|pg0|ollama|hindsight*) ;; *) continue ;; esac
  ostatak proces "$pid $args"
done < <(ps -U "$(id -u)" -o pid=,args= 2>/dev/null)

# Vrata koja slušaju: „vrata PID" po retku; PID „?" kad proces nije vidljiv (tuđi korisnik).
# macOS: lsof; Linux: lsof, ss ili /proc/net/tcp (Debian bez lsof i iproute2) — jedan prolaz.
slusaju() {
  local v
  if command -v lsof >/dev/null 2>&1; then
    for v in $VRATA; do printf '%s %s\n' "$v" "$(lsof -nP -iTCP:"$v" -sTCP:LISTEN -t 2>/dev/null | head -1)"; done | awk 'NF == 2'
    return
  fi
  if command -v ss >/dev/null 2>&1; then
    for v in $VRATA; do
      ss -ltnpH "sport = :$v" 2>/dev/null | awk -v v="$v" '{ p = "?"; if (match($0, /pid=[0-9]+/)) p = substr($0, RSTART + 4, RLENGTH - 4); print v, p; exit }'
    done; return
  fi
  [ -r /proc/net/tcp ] || return 0
  local par; par="$(awk -v vrata=" $VRATA " 'function hex(h,  i, n) { n = 0; for (i = 1; i <= length(h); i++) n = n * 16 + index("0123456789ABCDEF", toupper(substr(h, i, 1))) - 1; return n }
    $4 == "0A" { split($2, a, ":"); d = hex(a[2]); if (index(vrata, " " d " ")) print $10, d }' /proc/net/tcp /proc/net/tcp6 2>/dev/null)"
  [ -n "$par" ] || return 0
  find /proc/[0-9]*/fd -maxdepth 1 -type l -lname 'socket:*' -printf '%h %l\n' 2>/dev/null \
    | awk -v par="$par" 'BEGIN { n = split(par, r, "\n"); for (i = 1; i <= n; i++) { split(r[i], x, " "); vr[x[1]] = x[2] } }
        { i = $2; gsub(/[^0-9]/, "", i); if (i in vr && !(i in nadjen)) { split($1, d, "/"); nadjen[i] = d[3] } }
        END { for (i in vr) print vr[i], ((i in nadjen) ? nadjen[i] : "?") }'
}
cwd_procesa() {
  if [ -e "/proc/$1/cwd" ]; then readlink "/proc/$1/cwd" 2>/dev/null
  else lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; fi
}
# Ostatak su samo vrata koja drži proces OVE instalacije (naredba ili radna mapa pod $HOME).
# Tuđi proces na istim vratima (drugi korisnik, druga instalacija na stroju) nije naš ostatak,
# ali smeta novom krugu — zato napomena na stderr, bez brojanja.
while read -r v p; do
  a=""; c=""
  [ "$p" != "?" ] && { a="$(ps -o args= -p "$p" 2>/dev/null)"; c="$(cwd_procesa "$p")"; }
  case "$a $c/" in *"$HOME/"*) ostatak vrata "$v (PID $p: $(printf '%s' "$a" | cut -c1-80))" ;;
    *) echo "napomena: vrata $v drži proces koji nije iz $HOME (PID $p${a:+: $(printf '%s' "$a" | cut -c1-60)}) — nije ostatak, ali novi krug instalacije ih treba slobodna" >&2 ;; esac
done < <(slusaju | sort -n)

# ── putevi: $TM_HOME i manifesti (živi i arhivirani) ─────────────────────────
[ -e "$TM_HOME" ] && ostatak put "$TM_HOME"
while IFS= read -r p; do
  case "$p" in ''|"$TM_HOME"|"$TM_HOME"/*) continue ;; esac   # $TM_HOME je već prijavljen
  { [ -e "$p" ] || [ -L "$p" ]; } && ostatak put "$p"
done < <( (
  for m in "$TM_HOME/instalirano.json" "$ARHIVA"/manifest/*.json; do
    [ -f "$m" ] || continue
    # manifest piše scripts/instalacija/manifest.ts (JSON.stringify, 2 razmaka): "put": "/…",
    sed -n 's/^[[:space:]]*"put":[[:space:]]*"\(.*\)",[[:space:]]*$/\1/p' "$m"
  done
  # stavke na čekanju: install.sh pao prije nego što je manifest upisan (QA K6 B3)
  [ -f "$TM_HOME/instalirano.ceka" ] && cut -d'|' -f1 "$TM_HOME/instalirano.ceka"
  ) | sort -u)

# ── retci koje je instalacija dodala u tuđe datoteke ──────────────────────────
for f in "$HOME/.zprofile" "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile" "$HOME/.config/fish/config.fish"; do
  [ -f "$f" ] && grep -q '^# >>> TaskManagerAI >>>' "$f" && ostatak rc "$f"
done
[ -f "$HOME/.ssh/authorized_keys" ] && grep -Eq '[[:space:]]tm-tunel$' "$HOME/.ssh/authorized_keys" \
  && ostatak kljuc "$HOME/.ssh/authorized_keys (tm-tunel)"

if [ "$N" = 0 ]; then echo "provjeri-cisto: čisto (0 ostataka)" >&2; exit 0; fi
echo "provjeri-cisto: $N ostataka" >&2
exit 1
