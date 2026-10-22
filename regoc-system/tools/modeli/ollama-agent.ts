#!/usr/bin/env bun
/**
 * ollama-agent — agentski tool-loop runner za LOKALNE Ollama modele.
 *
 *   bun ollama-agent.ts --model qwen3-coder:30b --prompt-file /path/to/prompt.txt
 *
 * Gađa Ollama OpenAI-kompatibilni endpoint (/v1/chat/completions) — bez API ključa.
 * STREAMING (stream:true) da spore/velike generacije (30b) ne padnu na "operation timed out"
 * (idle konekcije) — chunkovi teku, konekcija ostaje živa.
 *
 * ALATI: dvije razine (sloj A+D iz docs/RegocMobile/190_TOOLS_FOR_WEAK_MODELS.md):
 *   VISOKORAZINSKI (za slabe modele — jedan glagol, jednostavan argument):
 *     rag_search, jlc_search, task_list, task_set, skill_find
 *   NISKORAZINSKI (moć/fallback): bash, read_file, write_file, make_diagram
 * Kurirani glagoli interno zovu `rt` (dispatcher, ~/.local/bin/rt) da slab model ne mora
 * sklapati duge putanje. Finalni tekst → stdout (kao claude --print). Log → stderr.
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { ollamaUrl } from '../../lib/okolina-sustava' // TASK-5700 (K3a)
import { procitajTajnuSpremista } from '../../lib/spremiste-tajni'

const HOME = process.env.HOME || homedir()
const MAX_ITERS = Number(process.env.OLLAMA_AGENT_MAX_ITERS) || 24
const CALL_TIMEOUT = Number(process.env.OLLAMA_AGENT_TIMEOUT) || 1800000  // per-call, default 30 min (spori 30b)
const BASH_TIMEOUT = 120000
const TOOL_PATH = join(HOME, '.bun/bin') + ':' + join(HOME, '.local/node/bin') + ':' + join(HOME, '.local/bin') + ':' + (process.env.PATH || '/usr/bin:/bin')

function getOllamaHost(): string {
  if (process.env.OLLAMA_HOST) return process.env.OLLAMA_HOST.replace(/\/+$/, '')
  const izSpremista = procitajTajnuSpremista('OLLAMA_HOST') // TASK-5705: zajednički čitač
  if (izSpremista) return izSpremista.replace(/\/+$/, '')
  try {
    const mc = JSON.parse(readFileSync(join(HOME, '.claude/regoc/models/model-config.json'), 'utf-8'))
    const u = mc?.providers?.ollama?.baseUrl
    if (typeof u === 'string' && u) return u.replace(/\/+$/, '')
  } catch {}
  return ollamaUrl()
}

const args = process.argv.slice(2)
const model = args[args.indexOf('--model') + 1]
const promptFile = args[args.indexOf('--prompt-file') + 1]
if (!model || !promptFile) { console.error('Usage: --model <id> --prompt-file <path>'); process.exit(1) }
const prompt = readFileSync(promptFile, 'utf-8')
const HOST = getOllamaHost()

// bash helper (dijele ga niskorazinski bash alat i kurirani glagoli)
function sh(command: string): string {
  const p = Bun.spawnSync(['bash', '-lc', command], { stdout: 'pipe', stderr: 'pipe', timeout: BASH_TIMEOUT, env: { ...process.env, PATH: TOOL_PATH } })
  const out = (p.stdout?.toString() || '') + (p.stderr?.toString() || '')
  return out.slice(0, 8000) || '(bez izlaza, exit ' + p.exitCode + ')'
}
// siguran shell-quote za argument iz modela
function q(s: string): string { return "'" + String(s ?? '').replace(/'/g, "'\\''") + "'" }

// ── Sloj C: pred-injekcija RAG konteksta za SLABE modele (ne tool-callaju pouzdano) ──
// OLLAMA_AGENT_PREINJECT=auto (default; ubaci samo za slabe modele) | always | never
const WEAK_MODEL = /(:0\.5b|:0\.6b|:1\.5b|:1b|:2b|:3b|llama3\.2:3b|gemma2?:2b|qwen2?\.?5?:0)/i.test(model)
const PREINJECT = (process.env.OLLAMA_AGENT_PREINJECT || 'auto').toLowerCase()
const SHOULD_PREINJECT = PREINJECT === 'always' || (PREINJECT !== 'never' && WEAK_MODEL)

// keyword → RAG kolekcija (isti duh kao autoRagCollections u daemonu); uvijek uključi regoc_mobile
function autoCollections(text: string): string[] {
  const c = (text || '').toLowerCase()
  const map: Array<[RegExp, string]> = [
    [/certifikat|prompting|micelij|spora|simbioza/, 'certifikat_prompting'],
    [/presa|zatik/, 'presa'], [/cube|kockic/, 'cubes'],
    [/kinemotion|skok|motka/, 'kinemotion'], [/sportai|dribler/, 'intergalaktik_sportai'],
    [/\bigor\b|gesture|bm20c|bmh20c/, 'igor'], [/serdes|ulx5m/, 'ulx5m_serdes'],
    [/ethernet|ksz9031|rgmii/, 'ulx5m-gs-ethernet'], [/\bpcie\b/, 'pcie'],
    [/pravopis/, 'hrvatski_pravopis'], [/telegram|nextcloud|gitlab|integracij/, 'integrations'],
    [/lifeos/, 'lifeos_research'],
  ]
  const hits = ['regoc_mobile']
  for (const [re, col] of map) if (re.test(c) && !hits.includes(col)) hits.push(col)
  if (hits.length === 1) hits.push('pai_learning_system')
  return hits
}

// Dohvati PUNE chunkove (RAG_FULL=1) i složi „## RAG KONTEKST" blok — belt-and-suspenders za modele bez tool-loopa.
function preloadRag(query: string): string {
  const cols = autoCollections(query).slice(0, 2)
  const blocks: string[] = []
  for (const col of cols) {
    const out = sh(`cd ~/.claude/skills/CORE/Tools && RAG_FULL=1 bun rag-query.ts -c ${col} -q ${q(query)} -n 3 2>/dev/null`)
    const chunks = out.split('\n').filter(l => /^\s*Content:/.test(l)).map(l => l.replace(/^\s*Content:\s?/, '').trim()).filter(Boolean)
    if (chunks.length) blocks.push(`### Kolekcija: ${col}\n` + chunks.map((t, i) => `(${i + 1}) ${t.slice(0, 1000)}`).join('\n'))
  }
  if (!blocks.length) return ''
  return `\n## RAG KONTEKST (unaprijed dohvaćeno iz baze znanja — za činjenice koristi ISKLJUČIVO ovo; ako odgovora nema ovdje, reci da nije pronađeno u RAG-u; ako je nevažno za zadatak, zanemari)\n` + blocks.join('\n\n') + '\n'
}

const TOOLS = [
  // — VISOKORAZINSKI (preporuka za slabe modele) —
  { type: 'function', function: { name: 'rag_search', description: 'Pretraži bazu znanja (RAG) i vrati relevantne odlomke. KORISTI OVO za činjenice o projektima/sustavu/pravilima umjesto da izmišljaš. Puno pouzdanije od bash.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'pitanje/tema' }, collection: { type: 'string', description: 'opcionalno: regoc_mobile, cubes, presa, igor, kinemotion, hrvatski_pravopis, integrations, pai_learning_system' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'jlc_search', description: 'Nađi JLCPCB elektronički dio (otpornik/kondenzator/...) — vrati LCSC šifru, paket i stock. Offline.', parameters: { type: 'object', properties: { value: { type: 'string', description: 'vrijednost, npr. 10k, 100nF, 4k7' }, package: { type: 'string', description: 'opcionalno paket, npr. 0402, 0805' } }, required: ['value'] } } },
  { type: 'function', function: { name: 'task_list', description: 'Popis zadataka iz TaskManagera.', parameters: { type: 'object', properties: { status: { type: 'string', description: 'opcionalno: pending, in_progress, completed' } } } } },
  { type: 'function', function: { name: 'task_set', description: 'Postavi status zadatka (pending→in_progress→completed).', parameters: { type: 'object', properties: { id: { type: 'string', description: 'npr. TASK-2644' }, status: { type: 'string', description: 'in_progress ili completed' } }, required: ['id', 'status'] } } },
  { type: 'function', function: { name: 'skill_find', description: 'Nađi koji skill/alat riješi zadatak (SkillSearch). Koristi kad ne znaš koji alat.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  // — NISKORAZINSKI (moć / fallback) —
  { type: 'function', function: { name: 'bash', description: 'Pokreni proizvoljnu bash -lc naredbu (git, curl, skripte, provjera ~/.claude/skills/). Koristi kad kurirani alat ne pokriva potrebu.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'bash naredba' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Pročitaj tekstualnu datoteku (do 12k znakova).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Zapiši sadržaj u datoteku (kreira/prepisuje). Za .excalidraw NE koristi ovo — koristi make_diagram.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'make_diagram', description: 'Napravi VALJAN .excalidraw dijagram iz jednostavnog spec-a. Uvijek OVO za excalidraw, nikad ručni JSON.', parameters: { type: 'object', properties: { spec: { type: 'object', description: 'Prvi node = orkestrator (gore). Oblik: {"title":"...","nodes":[{"id":"regoc","label":"REGOC","color":"#ffd166"}],"edges":[["regoc","a1"]]}' }, out: { type: 'string', description: 'Ciljna .excalidraw putanja' } }, required: ['spec', 'out'] } } },
]

async function runTool(name: string, a: any): Promise<string> {
  try {
    // — visokorazinski (interno preko rt dispatchera) —
    if (name === 'rag_search') {
      // Uvijek pretraži regoc_mobile (sistemsko znanje/cheat-sheet); slab model često pogodi krivu kolekciju.
      const extra = a.collection && a.collection !== 'regoc_mobile' ? ` ; echo '--- dodatna kolekcija: ' ${q(a.collection)} ; rt rag ${q(a.query)} ${q(a.collection)}` : ''
      return sh(`rt rag ${q(a.query)} regoc_mobile${extra}`)
    }
    if (name === 'jlc_search') return sh(`rt jlc ${q(a.value)} ${a.package ? q(a.package) : ''}`)
    if (name === 'task_list') return sh(`rt task list ${a.status ? q(a.status) : ''}`)
    if (name === 'task_set') return sh(`rt task set ${q(a.id)} ${q(a.status)}`)
    if (name === 'skill_find') return sh(`rt find ${q(a.query)}`)
    // — niskorazinski —
    if (name === 'bash') return sh(String(a.command ?? ''))
    if (name === 'read_file') return readFileSync(String(a.path), 'utf-8').slice(0, 12000)
    if (name === 'write_file') { writeFileSync(String(a.path), String(a.content ?? '')); return 'OK zapisano: ' + a.path }
    if (name === 'make_diagram') {
      const out = String(a.out || '').trim()
      if (!out) return 'GREŠKA: nedostaje "out" (ciljna .excalidraw putanja)'
      let spec = a.spec
      if (typeof spec === 'string') { try { spec = JSON.parse(spec) } catch { return 'GREŠKA: spec nije valjan JSON' } }
      if (!spec || !Array.isArray(spec.nodes) || !spec.nodes.length) return 'GREŠKA: spec mora imati "nodes" (barem 1 čvor)'
      const gen = join(HOME, '.claude/regoc/tools/mk-excalidraw.py')
      const p = Bun.spawnSync(['python3', gen, '--out', out], { stdin: new TextEncoder().encode(JSON.stringify(spec)), stdout: 'pipe', stderr: 'pipe', timeout: 30000 })
      const o = (p.stdout?.toString() || '') + (p.stderr?.toString() || '')
      return (p.exitCode === 0 ? 'OK dijagram: ' : 'GREŠKA generatora: ') + (o.trim() || '(bez izlaza)')
    }
  } catch (e: any) { return 'GREŠKA: ' + (e?.message || e) }
  return 'nepoznat alat'
}

// STREAMING poziv → skupi content + tool_calls iz delta chunkova (drži konekciju živom).
async function streamCall(messages: any[]): Promise<{ content: string, tool_calls: any[] }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT)
  try {
    const res = await fetch(`${HOST}/v1/chat/completions`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.3, max_tokens: 8000, stream: true }),
    })
    if (!res.ok) { const body = await res.text().catch(() => ''); throw new Error('HTTP ' + res.status + (body ? ': ' + body.slice(0, 300) : '')) }
    if (!res.body) throw new Error('HTTP ' + res.status + ' (bez tijela)')
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = '', content = ''
    const tcs: any[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]' || !data) continue
        let ch: any; try { ch = JSON.parse(data) } catch { continue }
        const delta = ch.choices?.[0]?.delta
        if (!delta) continue
        if (delta.content) content += delta.content
        if (Array.isArray(delta.tool_calls)) {
          for (const d of delta.tool_calls) {
            const i = d.index ?? 0
            if (!tcs[i]) tcs[i] = { id: d.id || ('call_' + i), type: 'function', function: { name: '', arguments: '' } }
            if (d.id) tcs[i].id = d.id
            if (d.function?.name) tcs[i].function.name += d.function.name
            if (d.function?.arguments) tcs[i].function.arguments += d.function.arguments
          }
        }
      }
    }
    return { content, tool_calls: tcs.filter(Boolean) }
  } finally { clearTimeout(timer) }
}

// Fallback: qwen3-coder / qwen2.5-coder i sl. emitiraju tool-pozive kao TEKST u
// <function=NAME><parameter=KEY>VALUE</parameter>...  formatu (Hermes/Qwen stil), a ne kao
// OpenAI tool_calls. Parsiraj ih iz contenta da bi se stvarno izvršili.
function parseXmlToolCalls(text: string): any[] {
  const calls: any[] = []
  const fnRe = /<function=([^>\s]+)\s*>([\s\S]*?)(?=<function=|<\/function>|$)/g
  let m: RegExpExecArray | null
  while ((m = fnRe.exec(text)) !== null) {
    const name = m[1].trim()
    const body = m[2]
    const params: Record<string, string> = {}
    const pRe = /<parameter=([^>\s]+)\s*>([\s\S]*?)(?=<\/parameter>|<parameter=|<\/function>|$)/g
    let p: RegExpExecArray | null
    while ((p = pRe.exec(body)) !== null) {
      params[p[1].trim()] = p[2].replace(/^\r?\n+/, '').replace(/\r?\n+\s*$/, '')
    }
    if (name) calls.push({ id: 'callx_' + calls.length, type: 'function', function: { name, arguments: JSON.stringify(params) } })
  }
  return calls
}

const messages: any[] = [
  { role: 'system', content: 'Ti si REGOČ agent koji radi na hostu. Imaš alate. Za činjenice o projektima/sustavu koristi rag_search (ne izmišljaj). Za dijelove jlc_search, za zadatke task_list/task_set, ako ne znaš koji alat skill_find. Za sve ostalo bash/read_file/write_file, za excalidraw make_diagram. PRAVILO: alat STVARNO izvrši (ne opisuj, ne tvrdi da si nešto pokrenuo ako nisi). Radi korak po korak; kad je GOTOVO, vrati kratki finalni tekst BEZ poziva alata. Jezik: hrvatski standardni.' },
  { role: 'user', content: prompt },
]

// Sloj C: za slabe modele (ili PREINJECT=always) daemon-stil pred-injekcija RAG konteksta u prompt.
if (SHOULD_PREINJECT) {
  try {
    const ctx = preloadRag(prompt)
    if (ctx) { messages.splice(1, 0, { role: 'system', content: ctx }); console.error(`[ollama-agent] pred-injektiran RAG kontekst (${ctx.length} zn., model=${model}, weak=${WEAK_MODEL})`) }
    else console.error(`[ollama-agent] pred-injekcija: nema RAG pogodaka`)
  } catch (e: any) { console.error(`[ollama-agent] pred-injekcija fail: ${e?.message || e}`) }
}

let totalTools = 0
const doneFiles: string[] = []
const doneCmds: string[] = []
let emptyNudges = 0
for (let i = 0; i < MAX_ITERS; i++) {
  let r: { content: string, tool_calls: any[] }
  try {
    r = await streamCall(messages)
  } catch (e: any) {
    console.error(`[ollama-agent] stream fail (iter ${i}): ${e?.message || e}`)
    console.log('⚠️ Ollama poziv nije uspio: ' + (e?.message || e))
    process.exit(2)
  }
  // Fallback: model je "pozvao" alat kao tekst (<function=..>) — parsiraj i izvrši.
  if (!r.tool_calls.length && r.content && r.content.includes('<function=')) {
    const xml = parseXmlToolCalls(r.content)
    if (xml.length) { r.tool_calls = xml; r.content = '' }
  }
  messages.push({ role: 'assistant', content: r.content || '', tool_calls: r.tool_calls.length ? r.tool_calls : undefined })
  if (r.tool_calls.length) {
    for (const tc of r.tool_calls) {
      let a: any = {}
      try { a = JSON.parse(tc.function?.arguments || '{}') } catch {}
      totalTools++
      // TASK-3082: isti trag kao u openrouter-agentu — strop koraka ne smije pojesti dokaz rada.
      if (tc.function?.name === 'write_file' && a?.path) doneFiles.push(String(a.path))
      else if (tc.function?.name === 'bash' && a?.command) doneCmds.push(String(a.command).slice(0, 120))
      console.error(`[ollama-agent] tool #${totalTools}: ${tc.function?.name}(${JSON.stringify(a).slice(0, 120)})`)
      const result = await runTool(tc.function?.name, a)
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result })
    }
    continue
  }
  // Model je vratio prazno i bez alata — vjerojatno je "zapeo" (qwen3:8b sampling).
  const finalTxt = (r.content || '').trim()
  if (!finalTxt && emptyNudges < 2) {
    emptyNudges++
    console.error(`[ollama-agent] prazan odgovor bez alata — nudge ${emptyNudges}`)
    messages.push({ role: 'user', content: 'Nisi ništa vratio ni pozvao alat. Ako je zadatak GOTOV, napiši kratki rezultat. Inače ODMAH pozovi odgovarajući alat (npr. rag_search za činjenicu) i izvrši ga — ne opisuj, izvrši.' })
    continue
  }
  console.error(`[ollama-agent] DONE model=${model} iters=${i + 1} tools=${totalTools}`)
  console.log(finalTxt || '(prazan finalni odgovor)')
  process.exit(0)
}
console.error(`[ollama-agent] MAX_ITERS(${MAX_ITERS})`)
{
  const uniq = (xs: string[]) => xs.filter((v, i, a) => a.indexOf(v) === i)
  const files = uniq(doneFiles), cmds = uniq(doneCmds)
  const lines: string[] = [`Dosegnut strop od ${MAX_ITERS} koraka — posao NIJE dovrsen, ali OVO JE STVARNO NAPRAVLJENO:`]
  if (files.length) { lines.push('', `Zapisane datoteke (${files.length}):`); for (const f of files.slice(0, 60)) lines.push(`  - ${f}`) }
  if (cmds.length) { lines.push('', `Pokrenute naredbe (${cmds.length}, zadnjih 10):`); for (const c of cmds.slice(-10)) lines.push(`  $ ${c}`) }
  if (!files.length && !cmds.length) lines.push('', 'Nijedna datoteka nije zapisana ni naredba pokrenuta — nema isporuke.')
  lines.push('', `REGOC-STATUS: BLOCKED — ${files.length || cmds.length ? 'djelomicno isporuceno, treba nastavak (strop koraka)' : 'strop koraka bez isporuke'}`)
  console.log(lines.join('\n'))
}
process.exit(0)
