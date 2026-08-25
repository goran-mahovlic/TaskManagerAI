#!/usr/bin/env bash
# Brza provjera da poslužitelj radi i da baza odgovara.
#
#   bash scripts/health.sh
#   TM_PORT=17800 bash scripts/health.sh
set -uo pipefail

VRATA="${TM_PORT:-17781}"
OSNOVA="http://127.0.0.1:${VRATA}"

echo "Provjeravam ${OSNOVA}"

ODGOVOR=$(curl -s -m 5 "${OSNOVA}/health" 2>/dev/null || true)
if [ -z "$ODGOVOR" ]; then
  echo "  poslužitelj ne odgovara — je li pokrenut? (bun run start)"
  exit 1
fi
echo "  health:    ${ODGOVOR}"

BROJ=$(curl -s -m 5 "${OSNOVA}/api/tasks" 2>/dev/null \
  | grep -o '"id"' | wc -l | tr -d ' ')
echo "  zadataka:  ${BROJ}"

PLOCA=$(curl -s -m 5 -o /dev/null -w "%{http_code}" "${OSNOVA}/" 2>/dev/null || echo "000")
echo "  ploča:     HTTP ${PLOCA}"

[ "$PLOCA" = "200" ] || { echo "  ploča ne odgovara ispravno"; exit 1; }
echo "U redu."
