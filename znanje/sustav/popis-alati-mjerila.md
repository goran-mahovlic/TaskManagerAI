# Alati domene mjerila

Kanonski alati domene mjerila. Prije pisanja nove skripte pokreni `katalog trazi <svrha>`; ako alat postoji, nadogradi ga.
- `mjeri-agent-output.ts` (cli, vlasnik jelena): MJERNI HARNESS — NIJE produkcijski parser. Poziv: `bun ${SUSTAV_DIR}/tools/mjerila/mjeri-agent-output.ts [--dani N] [--uzorak N]`. Stare putanje: `${SUSTAV_DIR}/tools/mjeri-agent-output.ts`.
- `step-schema-mjera.ts` (cli, vlasnik jelena): step-schema-mjera.ts — mjerilo za W3. Poziv: `bun ${SUSTAV_DIR}/tools/mjerila/step-schema-mjera.ts                 # zadnjih 50 dovršenih`. Stare putanje: `${SUSTAV_DIR}/tools/step-schema-mjera.ts`.
- `tijek-isplativost.ts` (cli, vlasnik dora): tijek-isplativost.ts — W6: isplati li se tijek rada naprama jednom izvršitelju; mjesečno trošak, vrijeme do dovršetka, broj vraćanja; presuda po tijeku (NEDOVOLJNO/ZADRŽATI/ZA BRISANJE). Poziv: `bun ${SUSTAV_DIR}/tools/mjerila/tijek-isplativost.ts --mjesec 2026-10 --spremi`. Stare putanje: `${SUSTAV_DIR}/tools/tijek-isplativost.ts`.
- `workflow-odluke-mjera.ts` (cli, vlasnik jelena): workflow-odluke-mjera.ts — mjerilo za W1. Poziv: `bun ${SUSTAV_DIR}/tools/mjerila/workflow-odluke-mjera.ts              # zadnjih 7 dana`. Stare putanje: `${SUSTAV_DIR}/tools/workflow-odluke-mjera.ts`.
