# TASK-5307 → Jelena: paritet node-A s glavnim + paritet u paketu

Odluke i razlozi: [ADR-0004 §13](../../adr/ADR-0004-profil-cvora.md#13-dopuna-task-5307-07102026--paritet-s-glavnim-sustavom-kuke-značajke-konzola-oporavak).
Mjerenje prije: `mjerenje_2026-10-07.txt` (99 razlika). Mjerilo poslije: `python3 docs/qa/TASK-5307/paritet.py regoc@192.168.10.20 --tsv`.

Pravilo redoslijeda: **prvo ono što čvor čini opreznijim, zatim ono što dostavlja i vidi, a tek na
kraju ono što samo stvara ili vraća zadatke u red.** Na čvoru je nedavno bila kaskada
`regoc-chain` (TASK-255). Reaper koji vrati smeće u red ponovno bi je zapalio.

## Faza A — na node-A odmah (bez koda, bez restarta)

`features.json` čita se uživo (TTL keš u `FeatureFlags.ts`). Kuke iz `settings.json` vrijede za
svaku **novu** sesiju agenta. Zato ova faza ne čeka `in_progress = 0`.
Prije svake izmjene napravi kopiju `<datoteka>.bak-task5307-<vrijeme>`.

| # | Što | Gdje | Provjera |
|---|---|---|---|
| A1 | `staleReaper` → `false`; `teamChainLive` → `false`; `autoResumeLive` → `false` (u `note` napiši „TASK-5307: paritet s glavnim") | `~/.claude/regoc/features.json` | `paritet.py`: tih ključeva više nema u „različito uključeno" |
| A2 | Spoji kuke: `SessionStart` i `PostToolUse` (bez matchera) → `$HOME/.bun/bin/bun run $HOME/TaskManagerAI/hooks/TaskInstructionsInject.hook.ts`; `PostToolUse` matcher `Bash\|Edit\|MultiEdit\|Write\|NotebookEdit\|Task` → `…/.claude/hooks/RegocConsoleLog.hook.ts`; `UserPromptSubmit`/`Stop` → `python3 $HOME/TaskManagerAI/tools/session_usage.py --hook prompt\|stop`. Tuđe kuke (SecurityValidator) ostaju. | `~/.claude/settings.json` | JSON valjan (`python3 -m json.tool`); **P6**: `POST /api/tasks/<id>/upute` na zadatak koji radi → agent je potvrdi; `~/.tmp/regoc_logs/regoc.log` nastaje |
| A3 | Kočnice i blokovi koje kod čvora već ima → `true`: `taskCreateBreaker`, `taskCreateBreakerLive`, `spawnBreaker`, `spawnBreakerLive`, `agentIdentityBlock(+Live)`, `spawnVerificationBlock(+Live)`, `criticUnverifiedAlert`, `verificationGateShadow`, `tierRecipesEnabled`, `earlyWorkGuard`, `criticRepairLoop`, `shutdownResume(+Live)` | `features.json` | `daemon.log` bez iznimki 10 min; `paritet.py` |
| A4 | `ollamaClassifier` → `true` **ako** `curl -s -o /dev/null -w '%{http_code}' $OLLAMA_URL/api/tags` = 200 s čvora | `features.json` | redak `[ollama]`/`LocalOffload` u `daemon.log` |

## Faza B — node-A nakon što je TASK-255 deployan i 46 smeće-zadataka zatvoreno

| # | Što | Uvjet |
|---|---|---|
| B1 | `staleWatchdogLive`, `deadAgentReaperLive`, `zombieRecoveryLive`, `failRequeue(+Live)`, `taskDecompose(+Live)` → `true` | `GET /api/tasks?status=blocked` na čvoru ne sadrži `createdBy=regoc-chain` „doradi rad" |
| B2 | `autonomyGate` → `true` | u `daemon.log` nema `probe odbijen: 401` u zadnjih 30 min |

## Faza C — paket (TaskManagerAI) i komplet: da novi čvor dobije sve ovo bez ruku

| # | Što | Mjerilo |
|---|---|---|
| C1 | `profil-cvora.ts`: moduli `znacajke`, `kuke`, `konzola`, `oporavak` + `paket.izvorniSustavSadrzi` (ADR §13.2, §13.3); vrijednosti iz tablica §13.2.1/§13.2.2 u `profili/upravitelj-cvora/profil.json`; paket kuka „pai-ucenje" kao popis koji instanca uključuje (`KUKE_PAKETI=jezgra,pai-ucenje`) | J13–J17 |
| C2 | `hooks/RegocConsoleLog.hook.ts` u paket (putanja iz `HOME`, ne `/home/klaudio`); `RadBezZadatka` prenijeti kao uvjetnu kuku | J15 |
| C3 | `config/features.example.json`: puni skup ključeva s odlukom iz §13.2.1 (sada ih je 6) i `note` s razlogom | `bun test` zelen; brana ADR-0001 §8 zelena |
| C4 | modul `konzola`: drop-in `~/.config/systemd/user/<unit>.service.d/konzola.conf` s `StandardOutput=append:%h/.tmp/regoc_logs/<izvor>.log` za `regoc-taskmanager` i `regoc-voice`; ploča prikazuje izvor bez datoteke kao „nije u pogonu" | J17 |
| C5 | **P5**: `tm-cvor-azuriraj.sh <čvor> --s-kompletom` (paket + komplet izvornog sustava po `MANIFEST.sha256`, uključivo popravak TASK-255). Na node-A tek kad je `in_progress = 0`, restart samo kroz `restart_kad_mirno` | `paritet.py` → „fale na čvoru (0)"; StaleCodeCheck exit 0 |
| C6 | Nakon C5 na node-A: `siroceOporavak`, `pozadinaPovrat`, `revizijaBlokiranih(+Live)`, `zatvaranjeKrozDaemon`, `r2IzricitaDodjela`, `sequentialHelpers` → `true` | **P7**: ubijen proces agenta → zadatak natrag u redu ≤ 15 min bez `/reclaim` |
| C7 | `docs/INSTALL.md` „Novi čvor": zamijeniti 7 koraka s 5 + tajne (ADR §13.5) | pregled teksta |

**Prije C5 odluči Goran:** P6, tj. pet nepredanih izmjena u `~/TaskManagerAI` na node-A
(`src/razgovor/*`, `tests/razgovor-dijelovi.test.ts`). `checkout -f` bi ih obrisao.

## Završno mjerilo (Potjeh)

`paritet.py regoc@192.168.10.20` smije javiti samo razlike koje §13.2 označava s „van" ili
„uvjetno, uvjet nije ispunjen". Nijedna stavka s odlukom „u paket" ne smije ostati u razlikama.
