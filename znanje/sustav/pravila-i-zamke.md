# Pravila i zamke

## Pravila koja vrijede
<!--u:rag-->RAG-FIRST: prije odgovora „ne znam” agent pretražuje RAG.<!--/u-->

U sustavu rade samo REGOČ agenti s hrvatskim imenima, nikad generički PAI agenti. Imenovani agent dobiva puni identitet pri spawnu preko `IdentityBlock.ts`.

Agent ne tvrdi da je posao gotov bez dokaza. Vrata provjere imaju pet koraka: IDENTIFY → RUN → READ → VERIFY → CLAIM. Završni status je DONE, DONE_WITH_CONCERNS, BLOCKED ili NEEDS_CONTEXT, a od ADR-0012 ga upisuje daemon nakon kritičara, ne agent.

Popravak na disku nije popravak u pogonu. Nakon izmjene koda dugotrajnog procesa treba `StaleCodeCheck.ts`, restart u prvom planu i navesti novi PID.

Napredak živi u gitu, bazi i datoteci, nikad samo u memoriji agenta. Pozadinski podagent (`Agent` s `run_in_background`) je efemeran i umire pri sažimanju konteksta; za dug rad koristi se daemon put. Podagent nikad ne pokreće vlastito pozadinsko dijete.

Više specijalista znači TaskManager (CLAUDE.md pravilo 25, vlasnik 03.10.2026.). Kriterij složenosti je broj različitih struka koje nalog traži, a ne trajanje posla. Nalog koji traži više struka (npr. istraživanje + dizajn + izrada + provjera) REGOČ ne radi sam. Razbija ga na zadatke po potrebnim skillovima i dodjeljuje ih agentima (`assignee`, `projectId`, `chat:<id>`, lanac preko `blockedBy`), npr. Manda → Grga → Gita → Potjeh. Zadatak na `regoc` nije zamjena za dodjelu. I dorada isporuke dobiva vlastiti zadatak prije rada. Inline ostaje samo za kratko i jednostručno. Ovo je mjerodavno tumačenje GEMINI pravila 19; ranija tvrdnja „kratko se radi inline, pravilo 19 ne vrijedi doslovno” je ukinuta.

Ulazna vrata (`config/ingest-gate.json`, položaj po grupi `off`/`shadow`/`on`) ocjenjuju težinu Telegram naloga (E1–E5, pragovi A 16 / B 36 / C 81). Kad je položaj za grupu `on`, nalog ide kroz TaskManager prema pragu i taj se put ne smije zaobići radom inline. Kad je `shadow`, ocjena je savjet: postupak „lanac” (težina ≥ 36) znači da posao ide agentima i tada (pravilo 25). Zapis ocjena je u `data/ingest_gate.jsonl`.

Status zadatka prati stvarnost: zadatak na kojem se radi je `in_progress`; `pending → completed` nije dopušten. Rad se zaustavlja pauzom, nikad statusom `cancelled`.

Hrvatski standardni jezik je službeni jezik izlaza; SSOT je `docs/HRVATSKI_JEZIK_SSOT.md`.

Tajne smiju biti samo u `${SUSTAV_DIR}/credentials.env` (600) i `~/.claude/.credentials.json`. Na VM-ove RegocMobile tajna ide samo uz vlasnikovo izričito odobrenje. Ključevi se ne rotiraju bez vlasnikova naloga. U dokumente, memoriju i RAG ide samo ime varijable.

Tjedni strop 90 % gasi samo autonomiju; sesijski pragovi su 70/85/95 %. Mjerilo je fail-closed.

Strop usporednih agenata mijenja se samo kao postavka TaskManagera (`PUT /api/config/concurrency`), ne preko okoline.

Uputa agentu u radu ide preko `POST /api/tasks/<ID>/uputa`, ne preko `progressNotes` ni pauze.

Model se ne hardkodira; bira ga ModelRouter i `model-config.json`.

Gita i Grga od 03.10.2026. smiju znati putanje, IP adrese i portove; sigurnosna izolacija je ukinuta. Za vjerodajnice vrijedi opće pravilo: samo ime varijable, nikad vrijednost.

Linkovi u izlazu pišu se bez navodnika.

## Lekcije iz memorije i LESSONS koje još vrijede
`pkill -f <uzorak>` može ubiti vlastiti shell; u pozadinskim naredbama koriste se apsolutne putanje.

Kad je `/tmp` pun, bash prestaje raditi; privremene datoteke idu u `~/.tmp`. Za `~/backup` se ne pretpostavlja ni da je samo za čitanje ni da je pisiv; 1. 10. 2026. bio je pisiv, iako memorija kaže suprotno (vidi `NESUKLADNOSTI.md` #23).

Daemon se nikad ne restarta u pozadini, a daemon keeper mora raditi (`tools/daemon-keeper.sh status`).

Mrtvi agenti iz git worktreeja znaju držati port; prije pokretanja poslužitelja treba provjeriti tko drži port.

„Čitanje radi” ne znači da pisanje radi (nedostajuća baza vraćala je 503 samo na pisanje).

Ispit ne smije ovisiti o pokvarenom pogonu; fixture se gradi, ne posuđuje. Testovi ne pune pravu ploču TaskManagera (oznaka `x-regoc-proba:1`).

Povijest se ne briše nego arhivira (`[ARHIVA] …`).

Kod hardvera: tvrdnja o verziji ploče provjerava se iz izvora (git pull, README, `project_version`). Firmware bez toolchaina i hardvera dobiva status `NEEDS_HW_TEST`, nikad „popravljeno”. FPGA zadaci: samo `-r`, bez isključivanja napajanja, ILA umjesto pitanja vlasniku.

SecurityValidator blokira naredbe koje u istoj liniji učitavaju spremište tajni i rade pipe, `cd` ili heredoc. Spremište se učitava s `set -a; . credentials.env 2>/dev/null; set +a` iz skripte, jer bez `2>/dev/null` pokvaren redak procuri u transkript ili dnevnik; 1. 10. 2026. to se stvarno dogodilo (`NESUKLADNOSTI.md` #24).

Telegram dijeli duge poruke u fragmente; MessageQueue ih spaja ako stignu od istog korisnika unutar 3 sekunde.

Restart daemona SIGTERM-om stavlja aktivne zadatke u `cancelled`; zato restart samo kad je `in_progress` = 0.
