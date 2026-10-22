#!/usr/bin/env bun
/**
 * openrouter-agent — agentski tool-loop runner za OpenRouter modele.
 *
 *   bun openrouter-agent.ts --model z-ai/glm-5.2 --prompt-file /path/to/prompt.txt
 *
 * Daje modelu prave alate (bash, read_file, write_file) i vrti OpenAI-style
 * tool-calling petlju dok model ne vrati finalni tekst. Finalni odgovor → stdout
 * (kao `claude --print`), pa daemon isti downstream (task update, sendResponse).
 * Log (iteracije, trošak) → stderr.
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { procitajTajnuSpremista } from '../../lib/spremiste-tajni'

const HOME = process.env.HOME || homedir()
const MAX_ITERS = Number(process.env.OPENROUTER_AGENT_MAX_ITERS || 60)   // TASK-3082: 20 je bilo pretijesno za lancane zadatke (11 iteracija odlazilo na navigaciju)
const CALL_TIMEOUT = 150000
const BASH_TIMEOUT = 120000

function getKey(): string {
  try {
    const mc = JSON.parse(readFileSync(join(HOME, '.claude/regoc/models/model-config.json'), 'utf-8'))
    const k = mc?.providers?.openrouter?.apiKey
    if (typeof k === 'string' && k && !k.startsWith('env:')) return k
  } catch {}
  // TASK-5705: zajednički čitač spremišta (i zapis ploče paketa `IME='…'`)
  return procitajTajnuSpremista('OPENROUTER_API_KEY') || process.env.OPENROUTER_API_KEY || ''
}

const args = process.argv.slice(2)
const model = args[args.indexOf('--model') + 1]
const promptFile = args[args.indexOf('--prompt-file') + 1]
if (!model || !promptFile) { console.error('Usage: --model <id> --prompt-file <path>'); process.exit(1) }
const prompt = readFileSync(promptFile, 'utf-8')
const KEY = getKey()
if (!KEY) { console.error('Nema OPENROUTER_API_KEY'); process.exit(1) }

const TOOLS = [
  { type: 'function', function: { name: 'bash', description: 'Pokreni shell (bash -lc) naredbu i vrati stdout+stderr. Koristi za sve: rag-query, git, curl TaskManager, čitanje/pisanje, pokretanje skripti.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'bash naredba' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Pročitaj tekstualnu datoteku (do 12k znakova).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Zapiši sadržaj u datoteku (kreira/prepisuje).', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
]

async function runTool(name: string, a: any): Promise<string> {
  try {
    if (name === 'bash') {
      const p = Bun.spawnSync(['bash', '-lc', String(a.command ?? '')], { stdout: 'pipe', stderr: 'pipe', timeout: BASH_TIMEOUT, env: { ...process.env } })
      const out = (p.stdout?.toString() || '') + (p.stderr?.toString() || '')
      return out.slice(0, 8000) || '(bez izlaza, exit ' + p.exitCode + ')'
    }
    if (name === 'read_file') return readFileSync(String(a.path), 'utf-8').slice(0, 12000)
    if (name === 'write_file') { writeFileSync(String(a.path), String(a.content ?? '')); return 'OK zapisano: ' + a.path }
  } catch (e: any) { return 'GREŠKA: ' + (e?.message || e) }
  return 'nepoznat alat'
}

const messages: any[] = [
  { role: 'system', content: 'Ti si REGOČ agent koji radi na hostu. Imaš alate: bash, read_file, write_file — koristi ih za stvarno izvršavanje zadatka (ne samo opisuj). Radi korak po korak; kad je zadatak GOTOV, vrati finalni tekstualni odgovor BEZ poziva alata. Jezik: hrvatski standardni.' },
  { role: 'user', content: prompt },
]

let totalCost = 0
let totalTools = 0
// Neki modeli (npr. qwen/qwen3.8-27b:free) odbijaju reasoning:{enabled:false} s 400
// „Reasoning is mandatory for this endpoint” — tada ponovi poziv s uključenim reasoningom.
let reasoningOn = /minimax/i.test(model)
const doneFiles: string[] = []
const doneCmds: string[] = []
for (let i = 0; i < MAX_ITERS; i++) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT)
  let d: any
  const poziv = async () => {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: 'auto', usage: { include: true }, temperature: 0.4, max_tokens: 8000, reasoning: { enabled: reasoningOn } }),
    })
    return res.json()
  }
  try {
    d = await poziv()
    if (d.error && !reasoningOn && /reasoning is mandatory/i.test(String(d.error?.message || ''))) {
      console.error(`[openrouter-agent] ${model}: reasoning je obavezan — ponavljam s reasoning:{enabled:true}`)
      reasoningOn = true
      d = await poziv()
    }
    clearTimeout(timer)
  } catch (e: any) {
    clearTimeout(timer)
    console.error(`[openrouter-agent] fetch fail (iter ${i}): ${e?.message || e}`)
    console.log('⚠️ OpenRouter poziv nije uspio: ' + (e?.message || e))
    process.exit(2)
  }
  if (d.error) { console.error('[openrouter-agent] OpenRouter error:', JSON.stringify(d.error)); console.log('⚠️ OpenRouter error: ' + (d.error?.message || '')); process.exit(2) }
  totalCost += d.usage?.cost || 0
  const msg = d.choices?.[0]?.message
  if (!msg) { console.log('⚠️ Prazan odgovor modela.'); process.exit(2) }
  messages.push(msg)
  if (msg.tool_calls?.length) {
    for (const tc of msg.tool_calls) {
      let a: any = {}
      try { a = JSON.parse(tc.function?.arguments || '{}') } catch {}
      totalTools++
      // TASK-3082: vodi trag ucinjenog. Kad se dosegne MAX_ITERS, posao je cesto VEC napravljen
      // (datoteke na disku), ali se dosad vracalo samo "Dosegnut limit iteracija" — bez ijednog
      // dokaza. completion-guard je to s pravom odbijao, pa je stvarni rad zavrsavao kao blocked.
      if (tc.function?.name === 'write_file' && a?.path) doneFiles.push(String(a.path))
      else if (tc.function?.name === 'bash' && a?.command) doneCmds.push(String(a.command).slice(0, 120))
      console.error(`[openrouter-agent] tool #${totalTools}: ${tc.function?.name}(${JSON.stringify(a).slice(0, 100)})`)
      const result = await runTool(tc.function?.name, a)
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result })
    }
    continue
  }
  console.error(`[openrouter-agent] DONE model=${model} iters=${i + 1} tools=${totalTools} cost=$${totalCost.toFixed(5)}`)
  console.log(msg.content || '(prazan finalni odgovor)')
  process.exit(0)
}
console.error(`[openrouter-agent] MAX_ITERS(${MAX_ITERS}) cost=$${totalCost.toFixed(5)} files=${doneFiles.length} cmds=${doneCmds.length}`)
{
  const uniq = (xs: string[]) => xs.filter((v, i, a) => a.indexOf(v) === i)
  const files = uniq(doneFiles)
  const cmds = uniq(doneCmds)
  const lines: string[] = []
  lines.push(`Dosegnut strop od ${MAX_ITERS} koraka — posao NIJE dovrsen, ali OVO JE STVARNO NAPRAVLJENO:`)
  if (files.length) {
    lines.push(``, `Zapisane datoteke (${files.length}):`)
    for (const f of files.slice(0, 60)) lines.push(`  - ${f}`)
    if (files.length > 60) lines.push(`  …i jos ${files.length - 60}`)
  }
  if (cmds.length) {
    lines.push(``, `Pokrenute naredbe (${cmds.length}, zadnjih 10):`)
    for (const c of cmds.slice(-10)) lines.push(`  $ ${c}`)
  }
  if (!files.length && !cmds.length) lines.push(``, `Nijedna datoteka nije zapisana ni naredba pokrenuta — nema isporuke.`)
  lines.push(``, `REGOC-STATUS: ${files.length || cmds.length ? 'BLOCKED — djelomicno isporuceno, treba nastavak (strop koraka)' : 'BLOCKED — strop koraka bez isporuke'}`)
  console.log(lines.join('\n'))
}
process.exit(0)
