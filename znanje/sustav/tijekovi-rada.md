# Tijekovi rada u sustavu REGOČ

## Od poruke do agenta
Poruka (s Telegrama, iz konzole ili od drugog agenta) upisuje se u bazu poruka `${SUSTAV_DIR}/messages.db`. RegocDaemon čita red poruka, a funkcija `classifyAndRoute` razvrstava poruku po razini napora (E1–E5, preko `ModeClassifier.ts`) i odlučuje kojem agentu ide. Daemon zatim pokreće agenta funkcijom `spawnAgentOnDemand` kao zaseban proces `claude --print`, s novim `--session-id` za svaki spawn. Prije svakog spawna daemon provjerava ručnu kočnicu, vrata autonomije i strop usporednih agenata. Spawnani agent ima rok od nekoliko minuta za kratke poruke, a duge zadatke vodi TaskManager.

## TaskManager
TaskManager je potpuno SQL-ov (SQLite u WAL načinu) u `${SUSTAV_DIR}/data/regoc.db`. Među tablicama su `tasks`, `projects`, `execution_queue`, `task_history`, `task_instructions`, `settings`, `settings_history`, `cost_log`, `knowledge`. REST API je `http://localhost:17781/api/tasks`.

Statusi zadatka su `pending`, `in_progress`, `blocked`, `completed` i `cancelled`. Dopušteni prijelazi su: iz `pending` u `in_progress`, `blocked` ili `cancelled`; iz `in_progress` u `completed`, `blocked` ili `cancelled`; iz `blocked` u `pending`, `in_progress` ili `cancelled`; iz `completed` i `cancelled` samo natrag u `pending`. Izravan prijelaz `pending → completed` nije dopušten.

Zadatak s prioritetom 1 okidač `auto_queue_p1_tasks` sam stavlja u `execution_queue`, a daemon ga preuzima. Zadatak koji ima `assignee` s imenom agenta spawna se automatski i s prioritetom 2. Kad glavna sesija radi sama, stavlja `assignee: regoc` i oznaku `no-watchdog`.

Od ADR-0012 agent ne postavlja status sam. Agent na kraju odgovora piše redak `REGOC-STATUS: DONE|BLOCKED|NEEDS_CONTEXT — …` i blok `REGOC-IZLAZ` s dokazima. Daemon pokreće neovisnog kritičara (vrata, `CriticGate.ts`) nad onim što je ostalo na disku i tek onda zatvara zadatak. DONE bez dokaza završava u `blocked`. Pitanje za odluku postavlja se samo preko `POST /api/tasks/<ID>/pitanje` s poljima `ekspert`, `pitanje` i barem dvije `opcije`.

Uputa agentu koji već radi šalje se preko `POST /api/tasks/<ID>/uputa`. Kuka `TaskInstructionsInject.hook.ts` predaje je modelu uz sljedeći poziv alata u istoj sesiji, a agent potvrđuje primitak bilješkom „uputa #N primljena”. Napredak agent javlja preko `PUT /api/tasks/<ID>` s poljem `progressNotes`.

Ručna kočnica ima dvije razine. Globalna pauza (`POST /api/pause`, stanje u `data/pause.state.json`) odbija svaki spawn. Pauza po zadatku (`POST /api/tasks/<ID>/pause` i `/resume`) ne mijenja status. Rad se nikad ne zaustavlja statusom `cancelled`, jer je terminalan.

Strop usporednih agenata je postavka `agents.max_concurrent` u tablici `settings` i mijenja se bez restarta na Config stranici ili preko `PUT /api/config/concurrency`.

## Vrata autonomije
Autonomija (sustav sam vuče posao iz reda) ovisi o potrošnji kvote koju mjeri `tools/session_usage.py` svakih 5 minuta. Pragovi su u `WorkStateJournal.ts`: do 70 % sesije autonomija radi; od 70 % do 85 % radi se zadatak po zadatak na vlasnikov nalog; 85 % je razina opreza; na 95 % je blokada. Tjedni strop je 90 % (`WEEKLY_BLOCK_PERCENT`) i gasi samo autonomiju — vlasnikov nalog s Telegrama ili iz konzole i dalje prolazi. Stara ili neuspjela mjera zatvara vrata (fail-closed). Kad prijava vraća 401 dulje od 15 minuta, daemon pokreće jedan minimalni `claude --print` na Haikuu da obnovi prijavu.

## Lanac i kontekst razgovora
Za zadatke razine E4 lanac je Kosjenka → Jelena → Potjeh → Malik. Višeagentski tijekovi s koracima su u `popis/tijek-<id>.md`. Zadatak koji nosi oznaku `chat:<chat_id>` u svakom spawnu automatski dobiva sažetak zadnjeg razgovora iz te Telegram grupe, a odgovor se vraća u isti razgovor. Oznaka putuje niz cijeli lanac.

## RAG
<!-- uvjet: rag -->
RAG čitanje: `bun ~/.claude/skills/CORE/Tools/rag-query.ts -c <kolekcija> -q "<tema>" -n 5`. RAG upis: `rag-store.ts -c <kolekcija> -t "<tekst>" -p <projekt> --type <istrazivanje|odluka|nalaz|spec|lekcija> --task <TASK-ID>`; za `istrazivanje` treba i `--source`. Popis: `rag-list.ts`. Pozadina je pgvector, a dana 1. 10. 2026. postojalo je 40 kolekcija (npr. `pai_learning_system`, `hrvatski_pravopis`, `regoc_znanje`, `agent_*`). Pravilo je RAG-FIRST: prije odgovora „ne znam” treba pretražiti RAG.

## Slanje dokumenata na Telegram
Telegram sesija ne šalje poruke sama; tekst prosljeđuje Klaudio. Dokument se šalje oznakom `[[SEND_DOC: /apsolutna/putanja.pdf | opis]]` u odgovoru: `SendDoc.ts` je prepozna, pošalje datoteku s `bot.sendDocument()` i ukloni oznaku iz teksta. Drugi put je `python3 ${SUSTAV_DIR}/tools/telegram_send_document.py <putanja> --chat <id> --caption "…"`. Nikad se ne koristi `adminId`.
