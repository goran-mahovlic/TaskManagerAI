# Alati domene daemon (dio 3)

Kanonski alati domene daemon, dio 3. Prije pisanja nove skripte pokreni `katalog trazi <svrha>`; ako alat postoji, nadogradi ga.
<!-- uvjet-redak: rag --> - `RagCollections.ts` (modul, vlasnik jelena): Vlastita RAG kolekcija agenta (I6 /). Poziv: `import iz ${SUSTAV_DIR}/RagCollections.ts`.
- `regoc-setup.ts` (cli, vlasnik jelena): regoc-setup — RegocMobile instalacijski/konfiguracijski GUI. Poziv: `bun ${SUSTAV_DIR}/setup/regoc-setup.ts`.
- `RegocClient.ts` (cli, vlasnik jelena): REGOČ Client. Poziv: `bun ${SUSTAV_DIR}/RegocClient.ts`.
- `RegocDaemon.ts` (cli, vlasnik jelena): REGOČ Daemon - Background Message Processor. Poziv: `bun ${SUSTAV_DIR}/RegocDaemon.ts              # Run in foreground`.
- `ReportBackSweepLive.ts` (modul, vlasnik jelena): ReportBackSweepLive — pogonske ovisnosti za pometnju dojava (U4 /). Poziv: `import iz ${SUSTAV_DIR}/ReportBackSweepLive.ts`.
- `ReportBackTask.ts` (modul, vlasnik jelena): ReportBackTask — ZADATAK DOJAVE: niz zadataka daje JEDNU poruku korisniku (U4 /). Poziv: `import iz ${SUSTAV_DIR}/ReportBackTask.ts`.
- `ResearchRagGate.ts` (modul, vlasnik jelena): ResearchRagGate — istraživanje mora završiti u RAG-u (R2 /). Poziv: `import iz ${SUSTAV_DIR}/ResearchRagGate.ts`.
- `ReviewCheckpoint.ts` (modul, vlasnik jelena): ReviewCheckpoint — kontrolne točke za ručni pregled (A5 /). Poziv: `import iz ${SUSTAV_DIR}/ReviewCheckpoint.ts`.
- `run-all-tests.sh` (cli, vlasnik jelena): ${SUSTAV_DIR}/Regoč TaskManagerMD/run-all-tests.sh. Poziv: `bash ${SUSTAV_DIR}/TaskManagerMD/run-all-tests.sh`.
- `RunOutcome.ts` (modul, vlasnik jelena): RunOutcome — taksonomija ishoda jednog spawna. Poziv: `import iz ${SUSTAV_DIR}/RunOutcome.ts`.
- `seed-appliance.ts` (cli, vlasnik jelena): seed-appliance — prvi ingest Tier 0 memorije u Tier 1 (RAG). Poziv: `bun ${SUSTAV_DIR}/seed-appliance.ts                 # seed u kolekciju iz configa`.
- `SendBreaker.ts` (modul, vlasnik jelena): SendBreaker.ts — Self-circuit-breaker NA STRANI POŠILJATELJA (R5 /). Poziv: `import iz ${SUSTAV_DIR}/SendBreaker.ts`.
- `ShutdownResume.ts` (cli, vlasnik jelena): ShutdownResume — M4 „uredno gašenje: spawnovi se ne ubijaju restartom". Poziv: `bun ${SUSTAV_DIR}/ShutdownResume.ts`.
- `SpawnBreaker.ts` (modul, vlasnik jelena): ─── SpawnBreaker ────────────────────────────────────────────────────────────. Poziv: `import iz ${SUSTAV_DIR}/SpawnBreaker.ts`.
- `SpawnExitDiagnostics.ts` (cli, vlasnik jelena): SpawnExitDiagnostics — forenzika izlaza `claude --print` spawnova. Poziv: `bun ${SUSTAV_DIR}/SpawnExitDiagnostics.ts`.
- `SpawnFinalizer.ts` (modul, vlasnik jelena): ${SUSTAV_DIR}/SpawnFinalizer.ts. Poziv: `import iz ${SUSTAV_DIR}/SpawnFinalizer.ts`.
- `SpawnRagEnv.ts` (cli, vlasnik jelena): Pripis RAG upisa kroz okolinu spawna. Poziv: `bun ${SUSTAV_DIR}/SpawnRagEnv.ts`.
- `SpawnTelemetry.ts` (cli, vlasnik jelena): SpawnTelemetry — što je JEDAN spawn stvarno potrošio (K7 /). Poziv: `bun ${SUSTAV_DIR}/SpawnTelemetry.ts`.
- `SpawnVerificationBlock.ts` (modul, vlasnik jelena): SpawnVerificationBlock.ts — (ADR-0004, odluke O2 i O3). Poziv: `import iz ${SUSTAV_DIR}/SpawnVerificationBlock.ts`.
- `StaleReaper.ts` (cli, vlasnik jelena): StaleReaper — odluka „je li in_progress task napušten?" (stari F3 čistač) na JEDNOM mjestu. Poziv: `bun ${SUSTAV_DIR}/StaleReaper.ts`.
- `StaleWatchdog.ts` (cli, vlasnik jelena): StaleWatchdog — pravila nadzornika zastoja na JEDNOM mjestu: zaglavljen in_progress (R2) i naknadna revizija blokiranih. Poziv: `bun ${SUSTAV_DIR}/StaleWatchdog.ts`.
- `StepSchema.ts` (modul, vlasnik jelena): StepSchema — strukturirani izlaz koraka (W3 /). Poziv: `import iz ${SUSTAV_DIR}/StepSchema.ts`.
- `StrojniOkidac.ts` (modul, vlasnik jelena): StrojniOkidac.ts — brava za zadatke čiji je okidač STROJNO PROVJERLJIV. Poziv: `import iz ${SUSTAV_DIR}/StrojniOkidac.ts`.
- `Sudac.ts` (modul, vlasnik jelena): Sudac — JEDAN sastavljač poziva agenta-vratara, za oba ušća. Poziv: `import iz ${SUSTAV_DIR}/Sudac.ts`.
- `SystemAwarenessBlock.ts` (cli, vlasnik jelena): REGOČ System Awareness Block (A2). Poziv: `bun ${SUSTAV_DIR}/SystemAwarenessBlock.ts`.
- `TaskCloser.ts` (modul, vlasnik jelena): ${SUSTAV_DIR}/TaskCloser.ts. Poziv: `import iz ${SUSTAV_DIR}/TaskCloser.ts`.
- `TaskCreateBreaker.ts` (modul, vlasnik jelena): ─── TaskCreateBreaker ───────────────────────────────────────────────────────. Poziv: `import iz ${SUSTAV_DIR}/TaskCreateBreaker.ts`.
- `TaskCreateSource.ts` (modul, vlasnik jelena): ─── TaskCreateSource ────────────────────────────────────────────────────────. Poziv: `import iz ${SUSTAV_DIR}/TaskCreateSource.ts`.
- `TaskFieldAliases.ts` (modul, vlasnik jelena): Jedan izvor istine za NAZIVE polja zadatka na HTTP ulazu (D6 /). Poziv: `import iz ${SUSTAV_DIR}/TaskFieldAliases.ts`.
- `TaskIdAllocator.ts` (cli, vlasnik jelena): TaskIdAllocator - JEDINI IZVOR ISTINE (SSOT) za dodjelu TASK-NNN ID-eva. Poziv: `bun ${SUSTAV_DIR}/TaskIdAllocator.ts`.
