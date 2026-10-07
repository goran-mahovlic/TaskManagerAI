# Alati domene daemon (dio 2)

Kanonski alati domene daemon, dio 2. Prije pisanja nove skripte pokreni `katalog trazi <svrha>`; ako alat postoji, nadogradi ga.
- `HealthSnapshot.ts` (modul, vlasnik jelena): REGOČ HealthSnapshot — Automatic System Health Monitoring. Poziv: `import iz ${SUSTAV_DIR}/HealthSnapshot.ts`.
- `HelpPipeline.ts` (cli, vlasnik jelena): REGOČ Help Pipeline (F6.1). Poziv: `bun ${SUSTAV_DIR}/HelpPipeline.ts`.
- `HookBlockGuard.ts` (modul, vlasnik jelena): HookBlockGuard — klasifikacija ishoda spawna `claude --print` PRIJE upisa rezultata. Poziv: `import iz ${SUSTAV_DIR}/HookBlockGuard.ts`.
- `IdentityBlock.ts` (cli, vlasnik jelena): Blok identiteta agenta (I1 /). Poziv: `bun ${SUSTAV_DIR}/IdentityBlock.ts`.
- `index.ts` (modul, vlasnik jelena): Zod: zajednički izvoz shema REGOČ-a (validacija ulaza). Poziv: `import iz ${SUSTAV_DIR}/zod/index.ts`.
- `IngestGateLive.ts` (modul, vlasnik jelena): IngestGateLive — ulazna vrata u položaju UŽIVO. Poziv: `import iz ${SUSTAV_DIR}/IngestGateLive.ts`.
- `IngestGateShadow.ts` (modul, vlasnik jelena): IngestGateShadow — ulazna vrata u položaju SJENA. Poziv: `import iz ${SUSTAV_DIR}/IngestGateShadow.ts`.
- `init-tasks-db.ts` (cli, vlasnik jelena): Initialize REGOČ Tasks Database. Poziv: `bun ${SUSTAV_DIR}/data/init-tasks-db.ts`.
- `IzvrsiteljFit.ts` (modul, vlasnik jelena): IzvrsiteljFit — agent-agnostičnost: uspoređivanje `treba` koraka sa sposobnostima. Poziv: `import iz ${SUSTAV_DIR}/IzvrsiteljFit.ts`.
- `KlaudioLiveness.ts` (cli, vlasnik jelena): KlaudioLiveness — JEDINI IZVOR ISTINE za pitanje "vrti li se Klaudio?". Poziv: `bun ${SUSTAV_DIR}/KlaudioLiveness.ts`.
- `KnowledgeGraph.ts` (cli, vlasnik jelena): REGOČ Knowledge Graph (F7.1). Poziv: `bun ${SUSTAV_DIR}/KnowledgeGraph.ts`.
- `KnowledgeHarvester.ts` (modul, vlasnik jelena): REGOČ KnowledgeHarvester — Automatic Knowledge Capture. Poziv: `import iz ${SUSTAV_DIR}/KnowledgeHarvester.ts`.
- `LiveDbGuard.ts` (modul, vlasnik jelena): ${SUSTAV_DIR}/LiveDbGuard.ts. Poziv: `import iz ${SUSTAV_DIR}/LiveDbGuard.ts`.
<!-- uvjet-redak: ollama --> - `LocalOffload.ts` (modul, vlasnik jelena): LocalOffload.ts — mehanički koraci na LOKALNOJ Ollami umjesto na Anthropic kvoti. Poziv: `import iz ${SUSTAV_DIR}/LocalOffload.ts`.
- `LogPaths.ts` (modul, vlasnik jelena): LogPaths — jedan izvor istine za putanje logova + rotacija. Poziv: `import iz ${SUSTAV_DIR}/LogPaths.ts`.
- `MergeGate.ts` (cli, vlasnik jelena): MergeGate — A4 /: vrata prije spajanja. Poziv: `bun ${SUSTAV_DIR}/MergeGate.ts sign`.
- `MessageQueue.ts` (cli, vlasnik jelena): REGOČ Message Queue. Poziv: `bun ${SUSTAV_DIR}/MessageQueue.ts`.
- `ModeClassifier.ts` (modul, vlasnik jelena): ${SUSTAV_DIR}/ModeClassifier.ts. Poziv: `import iz ${SUSTAV_DIR}/ModeClassifier.ts`.
- `ModuleInterface.ts` (modul, vlasnik jelena): REGOČ Module System — Base Interface. Poziv: `import iz ${SUSTAV_DIR}/modules/ModuleInterface.ts`.
- `ModuleRegistry.ts` (modul, vlasnik jelena): REGOČ ModuleRegistry — Plug & Play Component Manager. Poziv: `import iz ${SUSTAV_DIR}/modules/ModuleRegistry.ts`.
- `MonitorLoop.ts` (modul, vlasnik jelena): REGOČ MONITORMODELOOP v4.0 — 7-Phase Algorithm Execution Loop. Poziv: `import iz ${SUSTAV_DIR}/MonitorLoop.ts`.
- `ObservabilityLogger.ts` (cli, vlasnik jelena): REGOC ObservabilityLogger (F5.1). Poziv: `bun ${SUSTAV_DIR}/ObservabilityLogger.ts`.
- `OdluciteljPogon.ts` (modul, vlasnik jelena): OdluciteljPogon.ts — pogon za „neka model odluci umjesto mene". Poziv: `import iz ${SUSTAV_DIR}/OdluciteljPogon.ts`.
- `OdlukaPitanje.ts` (modul, vlasnik jelena): OdlukaPitanje.ts — strukturirano pitanje uz zadatak koji ceka ljudsku odluku. Poziv: `import iz ${SUSTAV_DIR}/OdlukaPitanje.ts`.
- `PauseControl.ts` (modul, vlasnik jelena): PauseControl — ručna kočnica nad radom REGOČ-a. Poziv: `import iz ${SUSTAV_DIR}/PauseControl.ts`.
- `ProjectDetect.ts` (modul, vlasnik jelena): ProjectDetect — prepoznavanje naredbe o projektu („raditi na X projektu"). Poziv: `import iz ${SUSTAV_DIR}/ProjectDetect.ts`.
- `ProjectGuess.ts` (modul, vlasnik jelena): ProjectGuess — koji je projekt iza poruke. Poziv: `import iz ${SUSTAV_DIR}/ProjectGuess.ts`.
- `ProjectInheritance.ts` (cli, vlasnik jelena): Nasljeđivanje projekta niz lanac pokretanja (Z2 /). Poziv: `bun ${SUSTAV_DIR}/ProjectInheritance.ts`.
- `ProjectManager.ts` (cli, vlasnik jelena): REGOC ProjectManager. Poziv: `bun ${SUSTAV_DIR}/ProjectManager.ts`.
- `PromptProjectBlock.ts` (cli, vlasnik jelena): Projekt zadatka u prompt-predlošku agenata (Z3 /). Poziv: `bun ${SUSTAV_DIR}/PromptProjectBlock.ts`.
- `QuotaWakeup.ts` (modul, vlasnik jelena): QuotaWakeup — okidač na obnovu kvote (A7 /, DIO 1). Poziv: `import iz ${SUSTAV_DIR}/QuotaWakeup.ts`.
