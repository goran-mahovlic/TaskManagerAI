#!/usr/bin/env bun
/**
 * consult-potjeh — sinkroni "QA sparring" poziv Potjehu (lokalni model).
 *
 *   bun ~/.claude/regoc/tools/consult-potjeh.ts "opis problema + kontekst"
 *
 * Bilo koji REGOČ agent s alatima ga zovne kad ZAPNE ili treba ŠIRU SLIKU.
 * Potjeh (model iz agentOverrides.potjeh, npr. qwen3:8b) vrati strukturirani uvid.
 *
 * ROBUSNOST (po zahtjevu):
 *  - GPU QUEUE: dijeli lock s RAG-om (ista mašina) — ne idu istovremeno, čekaju red.
 *  - TIMEOUT 5 min: ako ne odgovori (čekanje GPU-a + inferencija), NASTAVI bez njega,
 *    ali SIGNALIZIRAJ (miss log) da model nije odgovorio.
 *  - LOGGING: svaki poziv (i uspjeh i miss) → JSONL, pa se Potjehov input kasnije provjeri.
 */
import { OllamaProvider } from '../../models/providers/OllamaProvider'
import { withGpuLock } from './ollama-gpu-lock'
import { readFileSync, appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { ollamaUrl } from '../../lib/okolina-sustava' // TASK-5700 (K3a)

const HOME = process.env.HOME || homedir()
const LOG_DIR = join(HOME, '.claude/regoc/logs')
const LOG = join(LOG_DIR, 'consult-potjeh.jsonl')
const MISS_LOG = join(LOG_DIR, 'consult-potjeh-misses.log')
const BUDGET_MS = 5 * 60 * 1000  // 5 min ukupno (čekanje GPU-a + inferencija)

const PERSONA = `Ti si POTJEH — REGOČ QA/Intern, briljantni overachiever koji pita „zašto?" dok ne dođe do KORIJENA. Simbolički: tragač za istinom.
JEZIK: hrvatski standardni jezik.
ULOGA: idejni QA partner. Zovnuli su te jer trebaju ŠIRI pogled i KORISNIČKU perspektivu na bug/dizajn. NE koristiš alate i NE pišeš kod — RAZMIŠLJAŠ naglas i vraćaš strukturiran uvid koji naručitelj provjeri svojim alatima.
KAKO: pitaj se što KORISNIK stvarno doživljava (spor stroj, loša mreža, brzi klikovi, mobitel, stara verzija) — developer na brzom stroju to ne vidi; rangiraj hipoteze po vjerojatnosti (s mehanizmom, ne samo simptomom); nađi edge-caseove „radi kod mene vs ne radi kod korisnika"; predloži repro-korake i pitanja. Budi skroman ali uporan.
FORMAT:
### Korisnička perspektiva
### Hipoteze (rangirane)  [3-5, svaka s kratkim ZAŠTO/mehanizmom]
### Edge-caseovi i scenariji za reprodukciju
### Pitanja (korisnicima / naručitelju)
### Preporučeni sljedeći korak`

function resolvePotjehModel() {
  let provider = 'ollama', model = 'qwen3:8b', baseUrl = ollamaUrl()
  try {
    const mc = JSON.parse(readFileSync(join(HOME, '.claude/regoc/models/model-config.json'), 'utf-8'))
    baseUrl = mc?.providers?.ollama?.baseUrl || baseUrl
    const spec = mc?.agentOverrides?.potjeh
    if (typeof spec === 'string' && spec.includes(':')) {
      const i = spec.indexOf(':'); provider = spec.slice(0, i); model = spec.slice(i + 1)
    }
  } catch {}
  return { provider, model, baseUrl }
}

function logConsult(rec: Record<string, unknown>) {
  try { mkdirSync(LOG_DIR, { recursive: true }) } catch {}
  try { appendFileSync(LOG, JSON.stringify(rec) + '\n') } catch {}
}
function signalMiss(line: string) {
  try { mkdirSync(LOG_DIR, { recursive: true }) } catch {}
  try { appendFileSync(MISS_LOG, line + '\n') } catch {}
}

const caller = process.env.REGOC_AGENT_ID || 'unknown'
const problem = process.argv.slice(2).join(' ').trim()
if (!problem) {
  console.error('Usage: bun consult-potjeh.ts "<opis problema + kontekst>"')
  process.exit(1)
}

const { provider, model, baseUrl } = resolvePotjehModel()
const nowIso = () => new Date().toISOString()

if (provider !== 'ollama') {
  console.error(`Potjeh je na '${provider}:${model}', ovaj alat radi s lokalnim Ollama modelom. Nastavi bez njega.`)
  logConsult({ ts: nowIso(), caller, model: `${provider}:${model}`, status: 'skipped-nonollama', problem: problem.slice(0, 400) })
  process.exit(0)  // ne rušimo agenta — nastavi bez Potjeha
}

const deadline = Date.now() + BUDGET_MS
const t0 = Date.now()
try {
  const result = await withGpuLock('potjeh', { maxWaitMs: BUDGET_MS }, async ({ waitedMs }) => {
    const remaining = deadline - Date.now()
    if (remaining < 8000) throw Object.assign(new Error('budget potrošen na čekanje GPU-a'), { code: 'gpu-timeout', waitedMs })
    const p = new OllamaProvider(baseUrl)
    const r = await p.chat([{ role: 'user', content: problem }],
      { model, systemPrompt: PERSONA, temperature: 0.5, maxTokens: 2000, timeout: remaining })
    return { r, waitedMs }
  })
  const out = (result.r.content || '').trim()
  const latencyMs = Date.now() - t0
  console.log(`🧭 POTJEH (${model}, ${Math.round(latencyMs / 1000)}s, čekao GPU ${Math.round(result.waitedMs / 1000)}s) — QA uvid:\n`)
  console.log(out)
  logConsult({ ts: nowIso(), caller, model, status: 'ok', waitMs: result.waitedMs, latencyMs, problem: problem.slice(0, 400), response: out })
} catch (e: any) {
  const latencyMs = Date.now() - t0
  const status = e?.code === 'gpu-timeout' ? 'gpu-timeout' : (/(abort|timeout|timed out)/i.test(String(e?.message)) ? 'timeout' : 'error')
  const msg = e?.message || String(e)
  // Nastavi BEZ Potjeha, ali signaliziraj miss.
  console.error(`⏱️ Potjeh nije odgovorio (${status}, ${Math.round(latencyMs / 1000)}s): ${msg}. Nastavljam BEZ njegovog mišljenja.`)
  logConsult({ ts: nowIso(), caller, model, status, latencyMs, problem: problem.slice(0, 400), error: msg })
  signalMiss(`[${nowIso()}] MISS status=${status} caller=${caller} model=${model} ${Math.round(latencyMs / 1000)}s :: ${problem.slice(0, 120)}`)
  process.exit(0)  // exit 0: agent nastavlja bez Potjeha (miss je signaliziran, ne rušimo tok)
}
