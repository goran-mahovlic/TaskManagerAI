# QA nalaz — TASK-207 (potjeh) · lanac "testirati GLM5.2"

Izvor zahtjeva: telegram -5112799687:109 · Goran · 2026-10-06T17:50:07Z
Grana: `zadatak/TASK-194` · QA izvršen: 2026-10-06
Metoda: IDENTIFY → RUN → READ → VERIFY → CLAIM. Sve tvrdnje lanca neovisno pokrenute na stroju.

## PASS/FAIL po stavci (stvarno pokrenuto)

| # | Tvrdnja lanca | Naredba / dokaz | Ishod |
|---|---|---|---|
| 1 | grana `zadatak/TASK-194` postoji, stablo čisto | `git status --porcelain` (prazno), `git rev-parse --abbrev-ref HEAD` | ✅ PASS |
| 2 | dora commit `6a587ecb` postoji | `git log --oneline -1 6a587ecb` | ✅ PASS |
| 3 | dorina datoteka `data/analize/TASK-194-analiza-dora.md` = 77 redaka | `wc -l` → 77 | ✅ PASS |
| 4 | `providers.glm` enabled + anthropicCompatible | `model-config.json` r.50–56: enabled=true, anthropicCompatible=true, baseUrl=https://api.z.ai/api/anthropic, apiKey=env:GLM_API_KEY | ✅ PASS |
| 5 | `GLM_API_KEY` nedostaje (tvrdi bloker R1) | `secret_probe.py --name GLM_API_KEY` → "nije nađena ni u jednom storeu" | ✅ PASS (potvrđen bloker) |
| 6 | `allow_internet` ON (dorin ispravak R3) | `cat /etc/regoc/capabilities.state` → allow_internet.on=true (updated 22:35Z) | ✅ PASS |
| 7 | GLM endpoint dostupan | `curl -X POST https://api.z.ai/api/anthropic/v1/messages` → HTTP 401 (živ, traži ključ), ip 47.245.170.100, 0.9s | ✅ PASS (reachable) |
| 8 | Postoji izvedbeni zadatak "Jelena testira GLM5.2" | ploča: jelena ima TASK-209/210/211 = generički "doradi rad", NE izvedba GLM testa | ❌ FAIL → riješeno (vidi dolje) |

## Ključni QA nalaz
Jezgra Goranova zahtjeva — **otvoren, izvediv zadatak za Jelenu da TESTIRA GLM5.2** — prije ovog QA
NIJE postojao. Na ploči su za jelenu bili samo auto-spawnani "doradi rad" follow-upovi
(TASK-209 pending, TASK-210 pending, TASK-211 blocked) — nijedan nije izvedba testa.
Da report-back javi Goranu "gotovo", to bi bio lažni ✅.

**Radnja (potjeh):** stvoren **TASK-212** (assignee=jelena, PRJ-001, priority 2) —
izvedbeni zadatak s QA-potvrđenim preduvjetima, uputom na plan TASK-205, dorin negativni test (F3),
i upozorenjem na model-id (config navodi glm-4.6, NE glm-5.2 → provjeriti stvarni string prije testa).

## Preostali blokeri za sam test (za vlasnika/Jelenu, ne za ovaj QA)
- **R1 (tvrdi):** vlasnik mora unijeti `GLM_API_KEY` (Setup GUI / tab Sigurnost). Bez ključa test = 401.
- **Model-id:** potvrditi "GLM-5.2" vs `glm-4.6`/varijanta na z.ai prije pokretanja.
- **Negativni test:** nevaljan ključ MORA dati blocked/grešku, ne tihi fallback na anthropic.

## Opseg QA
Provjereni su PREDUVJETI i deliverabli lanca (analiza/plan/config/konektivnost). Sam GLM test (T0–T7)
NIJE izvediv iz QA koraka jer nema ključa (R1) — to je TASK-212, ne ovaj zadatak.
