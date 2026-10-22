#!/bin/bash
# okolina-servisa.sh — JEDAN izvor istine za privremene putanje servisa (TASK-5338).
#
# ZAŠTO POSTOJI
#   /tmp je tmpfs od 100 MB i nestaje s kontejnerom (CLAUDE.md pravilo 26). TASK-5336 je TMPDIR
#   dodao samo u regoc-services.sh, a daemon nakon pada diže daemon-keeper.sh pod `env -i`:
#   07.10.2026. živi RegocDaemon (PID 463541) nije imao TMPDIR u okolini procesa i
#   kritičarovi `bun test` padali su s ENOSPC. Tri kopije = tri mjesta da jedna zaostane;
#   zato je ovo jedino mjesto, a keeper, restart_kad_mirno.sh i oba regoc-services.sh ga učitavaju.
#
# Korijen je isti kao u TmpOkolina.ts: REGOC_TMP_ROOT ili $HOME/app/tmp.
#   servisi  → <korijen>/servisi/tmp   (TMPDIR, BUN_TMPDIR, TMP, TEMP)
#   pip      → <korijen>/predmemorija/pip   (PIP_CACHE_DIR; ADR-0020 §3.1 — do 09.10.2026. <korijen>/pip-cache)
# Spawnovi i kritičar dobivaju vlastitu mapu po zadatku u RegocDaemon/CriticGate (TmpOkolina.ts).
#
# Uporaba (datoteka samo definira funkcije, ništa ne mijenja dok se ne pozove):
#   . okolina-servisa.sh; okolina_servisa_izvezi    # izvezi u tekuću ljusku
#   . okolina-servisa.sh; okolina_servisa_parovi    # KLJUC=vrijednost po retku (za `env -i`)
#
# Fail-open: ako se mapa ne može stvoriti, ne ispisuje/izvozi ništa — servis se diže dalje,
# a daemon tada sam sebi postavi TMPDIR (RegocDaemon.ts mainLoop). Pun disk ne smije zaustaviti ploču.
# Ispit: ~/.claude/regoc/tests/okolina-servisa.test.ts

okolina_servisa_parovi() {
  local korijen="${REGOC_TMP_ROOT:-$HOME/app/tmp}"
  local tmp="$korijen/servisi/tmp" pip="$korijen/predmemorija/pip"
  mkdir -p "$tmp" "$pip" 2>/dev/null || return 0
  printf '%s\n' "TMPDIR=$tmp" "BUN_TMPDIR=$tmp" "TMP=$tmp" "TEMP=$tmp" "PIP_CACHE_DIR=$pip"
}

okolina_servisa_izvezi() {
  local par
  while IFS= read -r par; do
    [ -n "$par" ] && export "$par"
  done < <(okolina_servisa_parovi)
  return 0
}
