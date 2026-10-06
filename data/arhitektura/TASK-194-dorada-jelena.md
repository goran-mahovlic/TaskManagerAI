# Izvršna dorada arhitekture GLM-5.2 — TASK-209 (jelena · engineer)

- **Dorađujem:** TASK-205 (kosjenka) `TASK-194-plan-test-glm52.md`; uvažena dora-analiza (TASK-206) i QA (TASK-207/potjeh).
- **Ulazni lanac:** jelena (istraživanje) → kosjenka (arhitektura) → dora (analiza) → potjeh (QA) → **jelena (izvršna dorada)**.
- **Datum:** 2026-10-06 · **Izvor:** Goran, telegram -5112799687:109 · **Projekt stvarni:** PRJ-001 (formalno PRJ-033).

> Dizajn je bio solidan, ali cijeli lanac dosad je **proza**. Inženjerska dorada = prvi **izvršni dokaz**:
> polovica kriterija prihvaćanja (§4.2 rezolucija) prolazi **danas, offline, bez ključa**.

## 1. Što sam dodao (izvršno)

`data/arhitektura/TASK-194-glm52-resolve.test.ts` — **6 testova, 6 pass / 0 fail** (`bun test`, 15 expect poziva):
1. `parseModelSpec("glm:glm-5.2")` → `{provider:'glm', model:'glm-5.2'}`.
2. **§4.2**: `ModelRouter.resolve({component:'glm52-test'})` s override `glm:glm-5.2` vraća glm/glm-5.2 i **ne pada na anthropic** (preko privremenog configa — produkcija netaknuta).
3. Produkcijski `providers.glm` je `enabled + anthropicCompatible + z.ai + env:GLM_API_KEY`.
4–5. **dora-F3 (negativni test)**: zrcalo token-gatea iz `RegocDaemon.getAnthropicCompatProvider` — prazan `GLM_API_KEY` → `null` (spawn se **preskače**, nema tihog fallbacka); prisutan ključ → z.ai baseUrl + token.
6. **T0-gate danas**: `process.env.GLM_API_KEY` je prazan → živi test i dalje blokiran na R1.

## 2. Ispravci plana (re-grounding na stroju, 2026-10-06)

- **R3 je ZATVOREN.** `cat /etc/regoc/capabilities.state` → `allow_internet.on=true` (i `allow_root.on=true`). Plan/kosjenka tretira R3 kao otvoren; danas je jedina tvrda prepreka **R1 (GLM_API_KEY)**. (dora je to već uočila — ovdje potvrđeno drugi put.)
- **Mehanizam keyless-fallbacka precizno utvrđen.** `getAnthropicCompatProvider` (RegocDaemon.ts r.1072–1085) vraća `null` i loga `"[PROVIDER] glm: nema tokena — preskačem"` kad ključa nema. Dakle keyless spawn **ne** dosegne z.ai kao glm — tiho se preusmjeri. **Posljedica za T3:** smoke-test ne smije zaključiti "GLM radi" iz HTTP 200; mora prvo tvrditi da je ključ prisutan (test #6 to pokriva prije živog poziva).

## 3. Sažeti grounding (potvrđeno čitanjem koda danas)

| Tvrdnja | Dokaz |
|---|---|
| Rezolucijski lanac agentOverride→componentOverride→defaults[tier] | `ModelRouter.ts` r.158–181 |
| compat spawn postavlja ANTHROPIC_BASE_URL/AUTH_TOKEN | `RegocDaemon.ts` r.3222–3223 |
| token iz `env:VAR`, prazan ⇒ skip | `RegocDaemon.ts` r.1072–1085 |
| `GLM_API_KEY` odsutan | `secret_probe.py --name GLM_API_KEY` → „nije nađena" |

## 4. Stanje izvedbe (preslikano na plan §5)

- **Izvršeno danas (ne traži ključ):** §4.2 rezolucija + dora-F3 negativni guard — zeleno, u testu.
- **I dalje blokirano na R1:** T3/T4/T5 (živa konektivnost, tekst, tool-use, stabilnost) — čekaju `GLM_API_KEY` od vlasnika.
- **T1 (model-id `glm-5.2` vs `glm-4.6`) ostaje najveća nepoznanica** — potvrditi kod Z.ai prije T2 (potpuno kao u planu/dora-F2).

**Zaključak:** kad vlasnik unese `GLM_API_KEY`, izvedbeni zadatak (TASK-212) kreće od T1; routing-sloj je već dokazano ispravan, pa se živi test svodi na konektivnost + ponašanje odgovora.
