# TASK-5359 — dežurni (rezervni model) u paketu, deploy na node-A (08.10.2026.)

## Uzrok
`handleDezurniProba` je uvozio most glavnog sustava `~/.claude/tools/Telegram/dezurni.ts`. Na node-A ta datoteka ne postoji, pa je Test javljao „NOT WORKING". Ni razgovor (Šaban) ni orkestrator paketa nisu imali prijelaz na rezervni model.

## Popravak (780d690)
- `src/Dezurni.ts`: most u paketu. Postavke, model-config, tajne i stanje uzima iz putanja paketa, uz pet oblika poziva. `ciljDezurnog()` vraća CLI put preko ANTHROPIC_BASE_URL (alati ostaju), a `jePadPrimarnog()` prepoznaje 429/401/limit/nedostupan (ne rok ni prekid).
- Razgovor (`src/razgovor/Razgovor.ts`): kad primarni padne, potez ide na dežurnog kroz CLI, a ako CLI puta nema, ide obični poziv modela (samo `content`). Odgovor dobiva oznaku 🔻, a u konzolu ide red „primarni model pao … dežurni … preuzima".
- Orkestrator paketa: kad primarni padne, spawn se ponavlja na dežurnom modelu (bilješka 🔻 u zadatku).
- Ploča: Test ide kroz `src/Dezurni.ts` i upisuje red u konzolu. Dodani su `POST /api/dezurni/simuliraj {minuta 0..60}` i gumb „Simuliraj pad (5 min)".

## Provjere
- `bun test`: 1969 pass, 0 fail (uz node_modules paketa). Novi testovi `tests/dezurni-paket.test.ts` i `tests/dezurni-ploca.test.ts` prolaze 34/34.
- Suhi prolaz: `tm-cvor-azuriraj.sh svi --suho` → node-A i node-B 7b6f62bb → 780d690, ništa nije promijenjeno.
- Deploy na node-A (10:31Z, 0 zadataka u radu): MainPID 1083756 → 1092342, StaleCodeCheck exit 0, bootcheck M1–M4 PASS, zadataka 288=288.
- Test na node-A: `POST /api/dezurni/proba` → HTTP 200, `ok:true`, openrouter/mistralai/mistral-large-4-0, 2704 ms.
- Simulirani pad (10:31:50Z) i potpisana LAN poruka Klaudio→Šaban dali su u konzoli node-A:
  - `🔻 Šaban … primarni model pao (SIMULIRAN pad: 429) — dežurni openrouter/mistralai/mistral-large-4-0 preuzima (claude CLI, alati ostaju)`
  - `💬 ⇠ Šaban … (8,3 s): „🔻 ✅ Odgovara Mistral Large 4 (mistral-large-4-0)." · 🔻 dežurni openrouter/…`
  - Simulacija je ugašena u 10:32:34Z.

## Zasebni zadatci
- TASK-5361: `telegram.json` u `~/.claude` (ReportBackSweepLive) i `rag-gate.ts` (znanje-cvora). To su preostale ovisnosti o glavnom sustavu. Grep `~/.claude/(tools|regoc)` u kodu paketa nakon popravka nalazi samo komentare.
- TASK-5362: na node-A agente spawna stari `~/.claude/regoc/RegocDaemon.ts`, ne orkestrator paketa, pa prijelaz na dežurnog za agente tamo još ne djeluje.
