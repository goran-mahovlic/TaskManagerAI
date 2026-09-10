# TaskManagerAI — put do pune samostalnosti

> Istraživanje naručeno 10.09.2026 (Goran). Cilj: korisnik skine paket s GitHuba, prijavi se na
> jedan ili više već podržanih modela, upiše podatke za spajanje na SVOJE servise (RAG, Telegram,
> Nextcloud, GitLab...) i radi jednako kako mi sada radimo — bez ijednog retka tuđeg koda za
> uređivanje, bez tuđih IP-ova/lozinki u repozitoriju.

## 1. RegocDaemon.ts — strojno-specifično vs generičko

Živi orkestrator (`~/.claude/regoc/RegocDaemon.ts`, 7 340 redaka) NIJE dio paketa. Paket ima samo
"ploču i baza" (TaskWebUI + gate-ovi), ne i dio koji sam pokreće agente na zadatku (sloj 1 iz
`docs/SUSTAV.md`). Prvi prolaz grepom (detaljna revizija ide u TASK, ovo je polazište):

**Strojno-specifično, mora ostati config/env, NE u kodu:**
- `resolveOllamaBaseUrl()` — zadana vrijednost `http://192.168.10.4:11434` upisana u kodu (postoji
  fallback na `model-config.json`, ali default je naš IP).
- Dva mjesta gdje se sustavni prompt svakog spawnanog agenta gradi s ugrađenim rečenicama
  "Ollama 192.168.10.4, ChromaDB/RAG 192.168.10.200" — to ide u svaki poziv modela, pa
  svaki treći stroj bez izmjene "vidi" naše IP-ove u vlastitom promptu.
- `GEMINI_PATH` je do TASK-4794 bio tvrdo upisan na `/home/klaudio/...` (popravljeno, sada
  `join(HOME, ...)` — primjer obrasca koji treba primijeniti posvuda gdje još nije).

**Generičko, kandidat za paket (bez izmjene ponašanja):**
- Sam ciklus klasifikacije/rutiranja poruke → zadatak (`classifyAndRoute`), gate-ovi
  (`CompletionGuard`, `CriticGate`, `WorkflowGate`, `GitCommitGate`, ...) — svi već postoje kao
  zasebni `.ts` moduli i (osim par mjesta) NE ovise o klaudio-specifičnim putanjama.
- Spawn-on-demand mehanika (red čekanja, max 3 concurrent, timeout) — generička po dizajnu.

**Ono što OSTAJE strojno-vezano i vjerojatno se NE pakira (treba Goranova potvrda):**
- Sam poziv `claude --print` CLI-ja (paket ne smije pretpostaviti da je Claude Code instaliran —
  DezurniConfig već rješava "koji god model korisnik ima" za dežurnog, ali glavni spawn put i
  dalje pretpostavlja `claude` CLI).
- IdentityBlock.ts / REGOC_AGENTS.json — naš specifičan popis od 11 imenovanih agenata. Paket može
  ponuditi PRAZAN predložak (shema + primjer), ne naše agente.

**Zaključak:** ne prenosi se cijeli `RegocDaemon.ts`. Prenosi se generički orkestracijski dio
(rutiranje + gate-ovi + spawn red) kao NOVI modul u paketu (`src/core/Orchestrator.ts` ili slično),
s Ollama/ChromaDB adresama i modelom spawna kao env/config (isti obrazac kao `DezurniConfig.ts`).
Instalacija (`docs/INSTALL.md`) mora dobiti korak "Sloj 1 — pokreni orkestrator" koji danas ne
postoji (SUSTAV.md samo OPISUJE kako bi se to složilo ručno).

## 2. Integracije (Nextcloud / Email / GitLab / GitHub) — samo dokumentacija, nula koda

`integrations/*/README.md` u `regoc_system` navode NAŠE stvarne vrijednosti (npr.
`regoc_ai@intergalaktik.hr`, `192.168.10.200`) — to je u redu u PRIVATNOM repozitoriju, ali te
datoteke se ne smiju kopirati u javni paket kakve jesu.

Provjereno po alatima: u `~/.claude/regoc/tools/` postoje samo zadatkom-vezani skripti
(`gitlab_api_audit.sh`, `gitlab_finish_4732.sh` — pisani za konkretan TASK, ne generički alat) i
`rclone_eu2026_*` (cloud sync za jedan projekt). **Nema nijednog reusable modula** za Nextcloud
WebDAV, IMAP/SMTP ili GitHub API poziv — GitHub ide isključivo kroz `gh` CLI (koji sam čuva svoju
prijavu, pa je zapravo već "donesi svoj nalog"-spreman i treba mu samo dokumentacija, ne kod).
`TaskManagerSQL` polje `nextcloudFolder` postoji, ali je samo tekstualna etiketa na zadatku — ništa
ne čita/piše na Nextcloud.

**Treba napraviti (za svaku od 4):** modul po uzoru na `DezurniConfig.ts`/`TelegramConfig.ts`
(config JSON s poljima bez zadanih tajni, GET/PUT API ruta, kartica na Config stranici, provjera
konekcije "Probaj"). Email i Nextcloud imaju jasan protokol (SMTP/IMAP, WebDAV) pa je posao
uglavnom pisanje klijenta; GitLab/GitHub su uglavnom "koristi CLI koji korisnik već ima" +
dokumentacija kako se prijaviti, ne novi HTTP klijent.

## 3. Telegram — VEĆI DIO VEĆ GOTOV (09.09.2026, Kosjenka, TASK-026/4797)

`src/TelegramConfig.ts` je već u paketu (deployano na node-A u ovoj sesiji): bot token + chat ID
kao config polja (bez zadane vrijednosti), kartica na Config stranici, `GET/PUT /api/telegram/config`,
`POST /api/telegram/proba`, automatska obavijest o completed/failed zadatku. Korisnik već MOŽE
koristiti Telegram sa svojim podacima za IZLAZNE obavijesti.

**Što nedostaje:** ULAZNI kanal (poruka → zadatak) i dalje postoji samo u živoj instalaciji
(`~/.claude/tools/Telegram/`, vezano za Klaudio agenta), nije u paketu. Paket već ima
kanal-agnostičan `POST /api/ingest` (TASK-4266) — treba samo lagani Telegram poller/webhook koji
poziva TAJ endpoint, ne novi klasifikacijski kod.

## 4. cohere-ai — provjereno, NIJE mrtav kod

`package.json` dependencies ima `cohere-ai@^8.1.0`. Nitko ga izravno ne uvozi u `src/` — ali commit
`36da968` (09.09.2026) kaže zašto je dodan: `chromadb`-ov OPCIONALNI uvoz interno pokušava učitati
`cohere-ai` kao jednog od embedding-providera, i BEZ paketa prisutnog `bun build` je pucao
("build nije davao izlaz"). Ostaje kao **posredna ovisnost koju treba `chromadb` da bi se paket
uopće izgradio**, ne kao nešto što sami zovemo. Preporuka: NE brisati; dodati jednorečeni komentar
u `package.json` (ili `docs/DATABASE.md`) da budući čitatelj ne pokuša "očistiti" i pokvari build.

## 5. `scripts/uskladi_s_regocem.sh` — ne smije biti na GitHubu

Skripta postoji da prenese izmjene IZ žive instalacije U paket, prepisujući apsolutne putanje.
To je interni alat održavanja (spominje `~/.claude/regoc`, naš raspored direktorija) — nema
smisla za korisnika koji NEMA živu instalaciju, i otkriva unutarnju strukturu privatnog sustava.
**Akcija:** izbaciti iz git indeksa javnog repozitorija (`git rm --cached`), zadržati lokalno kao
neopraćen alat ili premjestiti u `regoc_system/tools/` (privatni repo).

## 6. Implementacijski plan po agentima

1. ~~**Kosjenka (Arhitekt)** — puna revizija `RegocDaemon.ts` (redak po redak, ne samo grep), ADR:
   točan popis modula/funkcija koje se sele u paket kao "Orchestrator core", što ostaje env/config,
   dizajn config sheme za Nextcloud/Email/GitLab/GitHub (isti obrazac kao Dežurni/Telegram) i
   dizajn Telegram-poller adaptera na `/api/ingest`.~~ **GOTOVO 10.09.2026. (TASK-4799):**
   - `docs/adr/ADR-0001-orchestrator-core.md` — revizija svih 7 340 redaka, 24 nalaza kategorije S
     (naše vrijednosti u kodu), 13 kategorije L (pretpostavke o stroju), 3 kategorije D (mrtav kod),
     podjela O0–O6, config/env shema, portovi, redoslijed izvedbe;
   - `docs/DIZAJN-integracije.md` — shema za Nextcloud/e-poštu/GitLab/GitHub + `ProbeGuard` (SSRF);
   - `docs/DIZAJN-telegram-poller.md` — poller na `POST /api/ingest`;
   - `tests/bez-nasih-vrijednosti.test.ts` — brana (zapor) protiv naših vrijednosti u paketu.

   **Nalaz koji mijenja redoslijed:** paket VEĆ nosi naše vrijednosti — 148 pojava
   `.claude/regoc` u 47 datoteka, 73 pojave `/home/klaudio` u 25, naši IP-ovi u 10, Goranov
   git identitet kao konstanta u `src/core/WorkflowTemplate.ts:58`. Zato korak 2 (Jelena)
   **počinje čišćenjem (ADR-0001 O1)**, a tek onda seli orkestrator — inače novi modul
   nasljeđuje istu bolest. Otvoreno pitanje O0 (§7 ADR-a) čeka Goranovu potvrdu.
2. **Jelena (Inženjer)** — implementacija po Kosjenkinom dizajnu: Orchestrator core modul,
   4 nova integracijska modula + Config kartice, Telegram poller, uklanjanje
   `uskladi_s_regocem.sh` iz javnog indeksa, dopuna `docs/INSTALL.md` za sve novo, komentar o
   `cohere-ai`.
3. **Malik (Sigurnost)** — revizija PRIJE javnog pusha: nema tajni u kodu/testovima/docs, config
   stranica ne otvara SSRF (proizvoljan URL za "Probaj" konekciju), datoteke s tajnama ostaju 0600,
   `.gitignore` pokriva sve nove config datoteke ako sadrže korisnički unesene tajne.
4. **Potjeh (QA)** — E2E test plan + regresija (uklj. node-A i node-B) za sve novo; potvrditi da
   svježa instalacija (bez ijedne naše vrijednosti) radi od nule prema `docs/INSTALL.md`.
5. **Grga (Dizajner)** — ako opseg Config stranice naraste (4 nove kartice), pregled cjeline da
   ploča ostane pregledna, ne zbrka kartica.

Ako dio posla treba node (npr. provjera na drugom OS-u/mreži) koji se ne može odraditi s glavnog
stroja, zadatak se otvara na node-B; po završetku node-B otvara zadatak za pregled u OVOM
TaskManageru s detaljnim izvještajem, a naš agent ga evaluira i zatvara.
