# TASK-5309 — QA node-A paritet + suhi prolaz novog čvora (Potjeh, 07.10.2026.)

Ulaz: TASK-5308 (Jelena, grana `regoc/TASK-5308-jelena-1791361567017`, be58c94).
Node-A: daemon PID 768884, ploča PID 768883 (restart 09:26:28 UTC, `TZ=UTC`), bez restarta u ovom QA.
Sirovi dokazi: `nodeA_dokazi.txt`, `suho_provjeri.txt`, `suho_primijeni___suho.txt`, `probeA.json`, `probeB.json`.

## A. Node-A — pet provjera (sve uživo, 09:55–10:07 UTC)

| # | Provjera | Kako | Ishod |
|---|---|---|---|
| 1 | Uputa dostavljena agentu | Proba **TASK-270** (oznaka `nalog`); dok agent radi, `POST /api/tasks/TASK-270/uputa` (09:56:29, HTTP 201) | ✅ `delivered_at 09:58:13.868Z`, `delivered_session` = sesija agenta, `undelivered 0`; agent u odgovoru doslovno navodi „KRAFNA-5309” |
| 2 | Siroče vraćeno | Proba **TASK-271**: agent PID 778250 ubijen `kill -9` u 10:03:01.820 | ✅ `exit 137 … UBIJEN IZVANA` → `↻ [neuspjeh→red] TASK-271 pokušaj 1/3` u 10:03:01.869; status `pending` izmjeren u 10:03:05 (≈4 s). Ponovni spawn preskočen (backoff 21 s), zadatak zatim ručno `cancelled` (HTTP 200) |
| 3 | CriticGate pokreće provjere | TASK-270 nosi `[PROVJERA] cmd: bun build …` | ✅ `critic-gate: PASS task=TASK-270 checks=1 failed=0 … propisano=[✓ bun build …] live` (critic_gate.jsonl: `declared`) |
| 4 | Konzola prikazuje izlaze | Pasivni WS klijent na `ws://localhost:17781/stream` | ✅ izvor `regoc` (rad agenata, TASK-270 redovi u regoc.log + WS `PRIMLJENO … source:"regoc"`) i izvor `daemon` (`PRIMLJENO … 🤖 [odlucitelj] … source:"daemon"`) |
| 5 | `df -h` ne otvara tim | ModeClassifier čvora + log teamChain | ✅ `df -h` → MINIMAL/E1, agenti `[]`; `free -h` → E1; „provjeri koliko je zauzet disk (df -h /)” → E2 → `[teamChain] … E1/E2 — trivijalno/jednostručno, bez tima` (TASK-264/266/268); nalog s chata → „nalog — bez tima” (TASK-204) |

### Nalazi uz put (node-A)
- **N1 — auto-exec stavi `in_progress` i kad je agent u backoffu** (10:03:08: „⚡ Auto-exec P2: TASK-271” pa „u backoff-u … preskačem spawn”). Isti kvar koji je Jelena prijavila (TASK-268); glavni ga ima popravljenog (TASK-5029). Do punog kompleta koda to pokriva siroče-oporavak (10 min).
- **N2 — dojava o ubijenom agentu ide u Telegram grupu** (`[user-flush] isporučeno chat=-1001234567890`: „TASK-271 vraćen u red …”). Ispravno ponašanje, ali probni zadaci QA-a stvaraju poruku u grupi.
- **N3 — `verificationGate`, `modeClassifyLive`, `tierRouting`, `sendBreakerLive`, `fileScopeGate(+Live)`, `reviewCheckpoint(+Live)`, `userFlushBacklog`, `staleReaperLive` i dalje OFF** na node-A. To je u skladu s odlukom profila „van / uvjetno” (TASK-5308: `znacajke 75/75`), a ne regresija. `ollamaClassifier`, `zombieRecoveryLive`, `deadAgentReaperLive`, `staleWatchdogLive`, `siroceOporavak` i `criticGate(+Live)` su ON.
- **N4 — sesija na node-A je na 78–82 %**, pa vrata autonomije drže auto-exec. Probe su prošle samo zahvaljujući oznaci `nalog`.
- Kuke na node-A sada: **14** (PreToolUse 1, UserPromptSubmit 2, SessionStart 1, PostToolUse 2, Stop 5, Notification 2, SubagentStop 1), prije 2.

## B. Node-B — suhi prolaz

**Stvarni node-B NIJE dostupan:** `ssh -p 2222 regoc@10.0.0.11` vraća „No route to host” i s glavnog stroja i s node-A (`ip neigh`: `10.0.0.11 … FAILED`). Na node-B ništa nije pokrenuto ni promijenjeno.

Zamjena: suhi prolaz paketa (grana TASK-5308) nad **praznim HOME-om** (`/home/klaudio/app/tmp/TASK-5309/sandbox_nodeB`), s instancom `profili/upravitelj-cvora/instanca.primjer.env` i `--bez-sustava`:

```
provjeri          → izlaz 3 (PREDUVJET)
primijeni --suho  → izlaz 3; ZBROJ: OK 16 · RAZLIKA 41 · NEDOSTAJE 12 · TAJNA-NEDOSTAJE 2 · ČOVJEK 2 · PRESKOČENO 16 · PREDUVJET 3
                    „SUHO: primijenilo bi se 41 stavki (ništa nije zapisano)”
```

Napomena: vrijednosti iz modula `razgovor`/`memorija`/`glas` u sandboxu je alat čitao s ploče na `localhost:17781`, a to je ploča glavnog sustava (TM_PORT nije zadan). Te stavke zato ne opisuju prazan čvor. Ostali moduli čitaju datoteke pod HOME-om i vrijede.

### Broj koraka: INSTALL §10.1 kaže „5 koraka + tajne”, suhi prolaz pokazuje 9

| # | Korak | U §10.1? | Nalaz suhog prolaza |
|---|---|---|---|
| 0 | Tajne/ljudske stavke (bot token, `claude auth login`, TM_RAZGOVOR_PUNO, capguard) | da | TAJNA-NEDOSTAJE 2, ČOVJEK 2, capguard NEDOSTAJE (root) — očekivano |
| 0b | `scripts/install.sh` (baza) | ne (samo §1 INSTALL-a) | PREDUVJET „baza … ne postoji (scripts/init-db.ts)” |
| 1a | **Spojiti značajke u main** | ne | **B1: PREDUVJET 2/9** — „kanal bot↔bot (ADR-0003)” i „glas u razgovoru (TASK-5294)” nisu u main ni u grani TASK-5308 (`od-bota`=0, `glasPrepoznavanje`=0). Žive na granama `isporuka/TASK-5290-nodea`, `isporuka/TASK-5299-nodea`, `regoc/TASK-5294-jelena-…` i u nepredanom stablu node-A (`od-bota`=5, `glas`=4). TASK-5308 također nije u main (main..be58c94 = 10 commita) |
| 1b | Kod na čvor | da | **B2:** §10.1 propisuje `tm-cvor-azuriraj.sh <čvor> --s-kompletom`, ali skripta tu zastavicu **nema** (grep „kompletom” = 0; zna samo `--suho`, `--prevedi`). Uz to su čvorovi upisani tvrdo (`ADRESA=([node-A]… [node-B]…)`), a skripta je u `~/.claude/regoc`, ne u paketu. Komplet izvornog sustava (SecurityValidator i 13 datoteka `izvorniSustavSadrzi`) zato nema svoj put |
| 2 | Instanca | da | **B3:** `instanca.primjer.env` ima prazan `SUSTAV_DIR=`. Tada su moduli `znacajke` i `oporavak` **PRESKOČENO**, a ne greška, pa novi čvor po primjeru tiho preskače upravo paritet za koji je TASK-5307/5308 rađen |
| 3 | `primijeni --suho` → `--pisi` | da | 41 stavka (kuke 5 RAZLIKA + 2 NEDOSTAJE zbog kompleta, konzola 2 drop-ina, telegram 21, okolina 3) |
| 4 | Restart (in_progress=0) | da | drop-in konzole traži daemon-reload + restart |
| 5 | `provjeri` → 0/2 | da | — |

Zaključak: kad se B1–B3 poprave, dobiva se 5 koraka + tajne. Danas je stvarni broj 9 (0, 0b, 1a, 1b, 2, 3, 4, 5, ručni komplet), a korak 1 se ne može izvesti kako je napisan.

## C. Preporuke (za Jelenu/Kosjenku, nisu izvedene)
1. Spojiti TASK-5290/5299/5294 i TASK-5308 u main (vrata spajanja), pa ponoviti `provjeri` → očekivano `[paket] 6/6` bez PREDUVJET.
2. Dodati `--s-kompletom` i generički čvor (`korisnik@stroj:port`) u `tm-cvor-azuriraj.sh` i premjestiti ga u paket (`scripts/`). Inače ispraviti §10.1.
3. U `instanca.primjer.env` uz `SUSTAV_DIR` napisati da je obavezan za paritet. Alat neka javi PREDUVJET, a ne PRESKOČENO, kad su `znacajke`/`oporavak` u profilu, a `SUSTAV_DIR` je prazan.
4. U §10.1 dodati korak 0b `bash scripts/install.sh`.
5. Kad node-B bude dostupan: `profil-cvora.ts provjeri --ssh regoc@10.0.0.11 …`, samo čitanje, uz vlasnikovo odobrenje za sve dalje.
