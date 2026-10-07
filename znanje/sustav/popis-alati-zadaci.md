# Alati domene zadaci

Kanonski alati domene zadaci. Prije pisanja nove skripte pokreni `katalog trazi <svrha>`; ako alat postoji, nadogradi ga.
- `checkpoint.ts` (cli, vlasnik jelena): checkpoint.ts — alat za kontrolne točke ručnog pregleda (A5 /). Poziv: `bun ${SUSTAV_DIR}/tools/zadaci/checkpoint.ts list                    # što čeka pregled`. Stare putanje: `${SUSTAV_DIR}/tools/checkpoint.ts`.
- `sesija_zadatak.ts` (cli, vlasnik jelena): Zadatak Telegram sesije jednom naredbom: otvori (regoc + projekt grupe + chat:<id>, odmah in_progress; --dorada-od TASK-X ide kroz /dorada), zatvori (PUT completed → pod B zahtjev 202 i kritičar), stanje. Par kuke RadBezZadatka. Poziv: `bun ${SUSTAV_DIR}/tools/zadaci/sesija_zadatak.ts otvori "<naslov>" [--dorada-od TASK-X]`.
- `task-create-queue.ts` (cli, vlasnik jelena): ─── task-create-queue ───────────────────────────────────────────────────────. Poziv: `bun ${SUSTAV_DIR}/tools/zadaci/task-create-queue.ts --status`. Stare putanje: `${SUSTAV_DIR}/tools/task-create-queue.ts`.
