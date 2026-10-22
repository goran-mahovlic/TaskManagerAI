#!/usr/bin/env bun
/**
 * decompose.ts — alat za razlaganje E4/E5 zadatka (P5c / TASK-2584, PRJ-030)
 *
 * Tok: plan → (Goran potvrdi) → approve → radnici vuku podzadatke iz inboxa.
 *
 *   bun tools/decompose.ts plan <TASK-ID> [--planner claude|ollama|file] [--model opus|sonnet]
 *                                         [--file plan.json] [--notify]
 *                                         [--agents a,b] [--razredi E3,E4,E5]
 *   bun tools/decompose.ts show <TASK-ID>
 *   bun tools/decompose.ts approve <TASK-ID> [--by goran] [--canary] [--waves N]
 *   bun tools/decompose.ts pump [<TASK-ID>|--all]
 *   bun tools/decompose.ts status
 *   bun tools/decompose.ts simulate [--limit N]     # koliko bi zadataka s ploče uopće ušlo u razlaganje
 *
 * SIGURNOST (plan §0):
 *   • `plan` NIKAD ne dira ploču — samo računa, zapiše i (uz --notify) javi.
 *   • `approve` materijalizira SAMO uz `taskDecomposeLive=true` ili izričit `--canary`
 *     (jednokratno, zapisano u data/task_decomposition.jsonl).
 *   • Podzadatak iz 1. vala ide odmah u `in_progress` (inače ga auto-exec pokupi kao
 *     pending i pokrene DRUGI, usporedni spawn); kasniji valovi se stvaraju kao
 *     `blocked` i `pump` ih prevodi blocked→in_progress (dopušten prijelaz).
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getModeClassifier } from '../../ModeClassifier'
import { isEnabled } from '../../FeatureFlags'
// TASK-4646: podzadatci razlaganja nose izvor `decomposer` — bez njega padaju u `user`
// i troše kvotu stropa stvaranja zadataka čovjeku (M2/TASK-4628, ADR-0007).
import { TASK_SOURCE, withCreatedBy } from '../../TaskCreateSource'
import {
  isDecomposable, normalizePlan, validatePlan, computeWaves, maxParallel, readySteps,
  buildPlannerPrompt, extractJson, buildSubtaskDescription, savePlan, loadPlan, listPlans,
  logDecision, dispatchSubtask, renderPlan, TIER_ORDER, TASK_API, isPumpable, DEP_HOLD_PREFIX,
  subtaskTags,
  type DecompositionPlan, type NormalizeCtx, type PlanStep, type Tier, type TaskFacts,
} from '../../TaskDecomposer'
import { ollamaUrl } from '../../lib/okolina-sustava' // TASK-5700 (K3a)

const HOME = process.env.HOME || ''
const REGOC = join(HOME, '.claude', 'regoc')

// ─── Registar agenata → tko smije biti izvršitelj i koji mu je strop tiera ────

function agentRegistry(): NormalizeCtx {
  const raw = JSON.parse(readFileSync(join(REGOC, 'REGOC_AGENTS.json'), 'utf-8'))
  const agents = raw.agents || raw
  // `regoc` je orkestrator, ne izvršitelj koraka; `klaudio` je Telegram-most.
  const skip = new Set(['regoc', 'klaudio'])
  const knownAgents: string[] = []
  const agentBaseline: Record<string, Tier> = {}
  for (const [id, cfg] of Object.entries<any>(agents)) {
    if (skip.has(id) || !cfg || typeof cfg !== 'object') continue
    knownAgents.push(id)
    const m = String(cfg.model || 'sonnet').toLowerCase()
    agentBaseline[id] = (m in TIER_ORDER ? m : 'sonnet') as Tier
  }
  return { knownAgents, agentBaseline, fallbackAgent: knownAgents.includes('jelena') ? 'jelena' : knownAgents[0] }
}

// ─── P3-stopgap: recept po tieru ─────────────────────────────────────────────
// Puni tier-recepti su TASK-2569 (još nisu isporučeni). Do tada podzadatak nosi
// minimalnu skelu — bez nje slabiji model improvizira format izlaza.
function recipeFor(tier: Tier): string {
  const common = [
    '1. Pročitaj SVE navedene ulaze prije prve izmjene.',
    '2. Napravi točno ono što piše pod TVOJ DIO — ni manje ni više.',
    '3. Pokreni provjeru iz odjeljka PROVJERA i zalijepi njezin izlaz u resultSummary.',
    '4. Zatvori zadatak s dokazom (naredba + izlaz/broj), inače status blocked.',
  ]
  if (tier === 'haiku') return [...common, '5. Ne istražuj šire, ne otvaraj nove datoteke izvan ulaza/izlaza.'].join('\n')
  if (tier === 'sonnet') return [...common, '5. Ako naiđeš na proturječje u ulazima, zapiši ga u resultSummary i nastavi s pretpostavkom.'].join('\n')
  return [...common, '5. Ako je korak i dalje prevelik, predloži pod-razlaganje u resultSummary — ne radi ga sam.'].join('\n')
}

// ─── TaskManager ─────────────────────────────────────────────────────────────

async function getTask(id: string): Promise<any | null> {
  try { const r = await fetch(`${TASK_API}/${id}`); return r.ok ? await r.json() : null } catch { return null }
}

async function putTask(id: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await fetch(`${TASK_API}/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!r.ok) console.error(`   ⚠️ PUT ${id} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
    return r.ok
  } catch (e) { console.error(`   ⚠️ PUT ${id} pao: ${e}`); return false }
}

async function createTask(body: Record<string, unknown>): Promise<string | null> {
  try {
    const r = await fetch(TASK_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(withCreatedBy(body, TASK_SOURCE.DECOMPOSER)) })
    if (!r.ok) { console.error(`   ⚠️ POST → HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`); return null }
    const j = await r.json() as any
    return j?.id || null
  } catch (e) { console.error(`   ⚠️ POST pao: ${e}`); return null }
}

function telegram(text: string): void {
  try { Bun.spawnSync(['python3', join(HOME, '.claude/regoc/tools/telegram_send_text.py'), '--group', 'regoc', '--max', '4000', text], { cwd: HOME, timeout: 20000 }) } catch {}
}

// ─── Planer ──────────────────────────────────────────────────────────────────

/**
 * `claude --print` koji hook blokira izlazi s **exit 0, is_error=false, subtype=success**
 * i vraćenim promptom — dakle „uspjeh" po svakom običnom mjerilu (TASK-2954/2955).
 * Planer bi to protumačio kao „nema JSON-a" i tiho odustao. Ovdje se blokada imenuje.
 */
async function runPlannerClaude(prompt: string, model: string): Promise<string> {
  const proc = Bun.spawn(['claude', '--print', '--dangerously-skip-permissions', '--output-format', 'json', '--model', model, '-p', prompt], {
    cwd: HOME, stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME, USER: process.env.USER || 'klaudio', SHELL: '/bin/bash',
           TERM: 'xterm-256color', BUN_INSTALL: process.env.BUN_INSTALL || join(HOME, '.bun'), CLAUDE_SUBAGENT: '1',
           CLAUDE_CODE_TMPDIR: join(HOME, '.tmp/claude-tmp') },
  })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  await proc.exited
  const { detectHookBlock } = await import('../../HookBlockGuard')
  const v = detectHookBlock(out, err)
  if (v.blocked) throw new Error(`planer blokiran hookom: ${v.reason || 'nepoznat razlog'}`)
  try {
    const j = JSON.parse(out)
    // num_turns === 0 je jedini pouzdan potpis „sesija nije ni krenula" (TASK-2988).
    if (j && j.num_turns === 0) throw new Error('planer nije napravio nijedan korak (num_turns=0) — spawn je odbijen prije rada')
    return j.result || out
  } catch (e: any) {
    if (String(e?.message || '').startsWith('planer ')) throw e
    return out
  }
}

async function runPlannerOllama(prompt: string, model: string): Promise<string> {
  const host = ollamaUrl()
  const r = await fetch(`${host}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.2 } }),
    // 30b model na hladno zna trebati >3 min samo za učitavanje (mjereno 02.09.: prvi
    // pokušaj je istekao na 180 s). Prag je podesiv da izbor modela ne diktira kod.
    signal: AbortSignal.timeout(Number(process.env.REGOC_OLLAMA_TIMEOUT_MS || 600_000)),
  })
  const j = await r.json() as any
  return j.response || ''
}

// ─── Naredba: plan ───────────────────────────────────────────────────────────

export async function cmdPlan(taskId: string, args: string[]): Promise<number> {
  const planner = argVal(args, '--planner') || 'claude'
  const model = argVal(args, '--model') || (planner === 'ollama' ? 'qwen2.5-coder:14b' : 'opus')
  const file = argVal(args, '--file')
  const notify = args.includes('--notify')

  const task = await getTask(taskId)
  if (!task) { console.error(`❌ Zadatak ${taskId} ne postoji na ploči.`); return 2 }

  const facts: TaskFacts = { id: task.id, title: task.title, description: task.description, tags: task.tags || [], assignee: task.assignee, status: task.status, projectId: task.projectId }
  const cls = getModeClassifier().classify({ title: facts.title, description: facts.description || '', tags: facts.tags || [] })
  // U5/TASK-4265: `--razredi E3,E4,E5` širi razlaganje na razred praga B (razrada §2/§3).
  // Bez zastavice vrijedi staro ponašanje (E4/E5) — nijedan postojeći pozivatelj se ne mijenja.
  const razrediArg = argVal(args, '--razredi')
  const razredi = razrediArg ? razrediArg.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : []
  const gate = isDecomposable(facts, cls.effort, razredi.length ? { allowedEfforts: razredi } : {})
  console.log(`📐 ${taskId} — napor ${cls.effort} (${cls.mode}) · prikladno za razlaganje: ${gate.eligible ? 'DA' : 'NE'} (${gate.reason})`)
  if (!gate.eligible) {
    logDecision({ event: 'skip', taskId, effort: cls.effort, reason: gate.reason })
    return 1
  }

  let ctx = agentRegistry()
  // `--agents` sužava izbor na radnike koji STVARNO imaju živ durabilni daemon.
  // Bez toga plan zna dodijeliti korak agentu bez daemona, pa taj korak padne na
  // auto-exec i dobije agentov puni model — točno ono što razlaganje izbjegava.
  const only = argVal(args, '--agents')
  if (only) {
    const allow = only.split(',').map(a => a.trim().toLowerCase()).filter(a => ctx.knownAgents.includes(a))
    if (allow.length) ctx = { ...ctx, knownAgents: allow, fallbackAgent: allow.includes(ctx.fallbackAgent) ? ctx.fallbackAgent : allow[0] }
  }
  let raw: any = null
  let plannerId = ''
  if (file) {
    plannerId = `file:${file}`
    raw = JSON.parse(readFileSync(file, 'utf-8'))
  } else {
    const prompt = buildPlannerPrompt(facts, ctx, cls.effort)
    console.log(`🧠 planer: ${planner}:${model} (radi SAMO plan, ništa ne izvršava)…`)
    const t0 = Date.now()
    const text = planner === 'ollama' ? await runPlannerOllama(prompt, model) : await runPlannerClaude(prompt, model)
    console.log(`   odgovor za ${((Date.now() - t0) / 1000).toFixed(1)} s, ${text.length} zn.`)
    plannerId = `${planner}:${model}`
    raw = extractJson(text)
    if (!raw) { console.error('❌ Planer nije vratio JSON — razlaganja nema (fail-safe: zadatak ide starim putem).'); logDecision({ event: 'planner-no-json', taskId, planner: plannerId }); return 3 }
  }

  const steps = normalizePlan(raw, ctx)
  // TASK-4672: utemeljenost (G1–G3) je dio provjere plana — halucinirani ULAZ/IZLAZ
  // (TASK-2563 → TASK-4668..4671) prolazi strukturnu provjeru bez ijedne greške.
  const issues = validatePlan(steps, { grounding: true })
  const errors = issues.filter(i => i.level === 'error')
  const plan: DecompositionPlan = {
    taskId, parentTitle: task.title, projectId: task.projectId || null, effort: cls.effort,
    planner: plannerId, createdAt: new Date().toISOString(), status: 'proposed', steps,
    notes: typeof raw?.notes === 'string' ? raw.notes.slice(0, 500) : undefined,
  }

  console.log('')
  console.log(renderPlan(plan))
  console.log('')
  for (const i of issues) console.log(`   ${i.level === 'error' ? '❌' : '⚠️'} ${i.msg}`)

  if (errors.length) {
    console.error(`\n❌ Plan ODBIJEN (${errors.length} grešaka) — zadatak ostaje na starom putu.`)
    logDecision({ event: 'plan-rejected', taskId, planner: plannerId, steps: steps.length, errors: errors.map(e => e.msg) })
    return 4
  }

  const waves = computeWaves(steps)
  savePlan(plan)
  logDecision({ event: 'plan-proposed', taskId, planner: plannerId, effort: cls.effort, steps: steps.length,
                waves: waves.length, maxParallel: maxParallel(waves), tiers: steps.map(s => `${s.agent}/${s.tier}`) })
  console.log(`\n✅ Plan zapisan: ${join(REGOC, 'data/decomposition_plans', taskId + '.json')}`)
  console.log(`   Potvrda: bun ~/.claude/regoc/tools/decompose.ts approve ${taskId} --by goran`)

  if (notify) {
    telegram(`📐 PLAN RAZLAGANJA za ${taskId}\n\n${renderPlan(plan)}\n\nODOBRI: bun ~/.claude/regoc/tools/decompose.ts approve ${taskId} --by goran\nODBIJ: obriši ${taskId}.json iz data/decomposition_plans/`)
    console.log('   📨 Plan poslan Goranu na potvrdu (Telegram).')
  }
  return 0
}

// ─── Naredba: approve (materijalizacija) ─────────────────────────────────────

export async function cmdApprove(taskId: string, args: string[]): Promise<number> {
  const by = argVal(args, '--by') || 'goran'
  const canary = args.includes('--canary')
  // `--waves N`: canary pusti samo prvih N valova, ostatak ostaje `blocked` do ljudske odluke.
  const maxWave = Number(argVal(args, '--waves') || '0') || undefined
  const plan = loadPlan(taskId)
  if (!plan) { console.error(`❌ Nema plana za ${taskId} (pokreni prvo: plan ${taskId}).`); return 2 }
  if (plan.status === 'materialized') { console.log(`ℹ️ Plan ${taskId} je već materijaliziran — pokreni pump.`); return 0 }

  const live = isEnabled('taskDecomposeLive')
  if (!live && !canary) {
    console.error(`❌ taskDecomposeLive = false. Materijalizacija odbijena.`)
    console.error(`   Jednokratni canary: dodaj --canary (bit će zapisan u task_decomposition.jsonl).`)
    return 5
  }

  const parent = await getTask(taskId)
  const originalRequest = (parent?.description || '').slice(0, 4000)
  const waves = computeWaves(plan.steps)
  const wave1 = new Set(waves[0] || [])
  const keyToTask: Record<string, string> = {}

  console.log(`🚧 Materijalizacija ${taskId}: ${plan.steps.length} podzadataka, ${waves.length} valova, 1. val = ${wave1.size} usporedno (${live ? 'LIVE' : 'CANARY'})`)

  // 1) Stvori zadatke redom (val po val) — ovisnosti moraju već imati TASK-ID.
  for (const [wi, wave] of waves.entries()) {
    const waveNo = wi + 1
    const aboveCap = !!maxWave && waveNo > maxWave
    for (const key of wave) {
      const s = plan.steps.find(x => x.key === key)!
      const desc = buildSubtaskDescription(s, {
        parentTaskId: taskId, parentTitle: plan.parentTitle, originalRequest,
        recipe: recipeFor(s.tier), depTaskIds: keyToTask,
        contextPack: await packFor(s, plan).catch(() => undefined),
      })
      const blockedBy = s.dependsOn.map(d => keyToTask[d]).filter(Boolean)
      const id = await createTask({
        title: `${taskId} · ${s.key} · ${s.agent}: ${s.title}`.slice(0, 120),
        description: desc, assignee: s.agent, priority: 2,
        // Korak iznad canary-stropa nosi i `waiting-for-human` — inače ga auto-unblock
        // vrati u `pending` čim mu ovisnosti završe, a auto-exec ga pokrene (kvar 02.09. 10:09).
        tags: subtaskTags(taskId, s, aboveCap),
        ...(blockedBy.length ? { blockedBy } : {}),
        ...(plan.projectId ? { projectId: plan.projectId } : {}),
      })
      if (!id) { console.error(`   ❌ ${s.key} nije stvoren — prekidam da lanac ne ostane pola.`); return 6 }
      keyToTask[s.key] = id
      s.taskId = id
      // Kasniji valovi idu u `blocked` da ih auto-exec ne pokupi kao pending prije reda.
      // Iznad canary-stropa razlog je LJUDSKA zadrška (a uz nju ide i oznaka gore) — takav
      // korak pumpa ne otpušta sama ni kad mu ovisnosti završe.
      if (!wave1.has(key)) {
        await putTask(id, aboveCap
          ? { status: 'blocked', blockedReason: `BLOCKED: canary-strop (razlaganje ${taskId}, val ${waveNo} > ${maxWave}) — čeka ljudsku potvrdu` }
          : { status: 'blocked', blockedReason: `${DEP_HOLD_PREFIX} ${s.dependsOn.map(d => keyToTask[d] || d).join(', ')} (razlaganje ${taskId})` })
      }
      console.log(`   ✅ ${s.key} → ${id} (${s.agent}/${s.tier})${blockedBy.length ? ` blockedBy ${blockedBy.join(',')}` : ''}${aboveCap ? ' [iznad stropa: waiting-for-human]' : ''}`)
    }
  }

  plan.status = 'materialized'
  if (maxWave) plan.maxWave = maxWave
  plan.approvedBy = by
  plan.approvedAt = new Date().toISOString()
  savePlan(plan)
  await putTask(taskId, { progressNotes: [`Razloženo na ${plan.steps.length} podzadataka (${waves.length} valova, ${maxParallel(waves)} usporedno): ${plan.steps.map(s => `${s.key}=${s.taskId}`).join(', ')}`] })
  logDecision({ event: 'materialized', taskId, by, canary, steps: plan.steps.map(s => ({ key: s.key, taskId: s.taskId, agent: s.agent, tier: s.tier })) })

  // 2) Otpremi 1. val durabilnim radnicima.
  const n = await pumpPlan(taskId)
  console.log(`🚀 Otpremljeno u 1. valu: ${n}`)
  if (maxWave) console.log(`🛑 Canary-strop: pumpa staje nakon ${maxWave}. vala — ostatak ostaje 'blocked' do ljudske odluke.`)
  return 0
}

async function packFor(s: PlanStep, plan: DecompositionPlan): Promise<string | undefined> {
  try {
    const { packContext } = await import('../../ContextPacker')
    const pack = await packContext({ title: s.title, description: s.brief, tags: ['subtask'], project: plan.projectId || undefined }, { maxMemory: 4, maxRag: 2 })
    const lines: string[] = []
    for (const m of pack.memory || []) lines.push(`- ${m.title} (~/.claude/projects/-home-klaudio/memory/${m.file}) — ${m.hook}`)
    for (const r of pack.rag || []) lines.push(`- [RAG ${r.collection}] ${String(r.snippet).slice(0, 200)}`)
    return lines.length ? lines.join('\n') : undefined
  } catch { return undefined }
}

// ─── Naredba: pump (otprema koraka kojima su ovisnosti gotove) ───────────────

export async function pumpPlan(taskId: string): Promise<number> {
  const plan = loadPlan(taskId)
  if (!plan || plan.status !== 'materialized') return 0
  const completed = new Set<string>()
  const dispatched = new Set<string>()
  for (const s of plan.steps) {
    if (!s.taskId) { dispatched.add(s.key); continue }   // nije materijaliziran — ne diramo
    const t = await getTask(s.taskId)
    if (!t) continue
    if (t.status === 'completed') completed.add(s.key)
    // „Ne diraj" = sve osim `pending` i VLASTITE zadrške pumpe. Ručni `blocked`
    // (npr. „isporučeno djelomično, fali X") mora držati — inače pumpa poništi
    // ljudsku odluku u sljedećoj minuti (kvar uhvaćen 02.09. na TASK-3583).
    if (!isPumpable(t.status, t.blockedReason)) dispatched.add(s.key)
  }
  const ready = readySteps(plan.steps, completed, dispatched, plan.maxWave)
  let n = 0
  for (const s of ready) {
    if (!s.taskId) continue
    const ok = await putTask(s.taskId, { status: 'in_progress' })
    if (!ok) continue
    const t = await getTask(s.taskId)
    const msgId = dispatchSubtask({
      agent: s.agent, content: (t?.description || s.brief), taskId: s.taskId,
      parentTaskId: taskId, stepKey: s.key, tier: s.tier,
    })
    logDecision({ event: 'dispatched', taskId, stepKey: s.key, subtask: s.taskId, agent: s.agent, tier: s.tier, msgId })
    console.log(`   📤 ${s.key} → ${s.agent} (${s.tier}) chain_next ${msgId} [${s.taskId}]`)
    n++
  }
  return n
}

// ─── Naredbe: show / status / simulate ───────────────────────────────────────

async function cmdShow(taskId: string): Promise<number> {
  const plan = loadPlan(taskId)
  if (!plan) { console.error(`❌ Nema plana za ${taskId}.`); return 2 }
  console.log(renderPlan(plan))
  console.log(`\nstatus plana: ${plan.status}${plan.approvedBy ? ` (odobrio ${plan.approvedBy} u ${plan.approvedAt})` : ''}`)
  if (plan.status === 'materialized') {
    console.log('\nstanje podzadataka:')
    for (const s of plan.steps) {
      const t = s.taskId ? await getTask(s.taskId) : null
      console.log(`  ${s.key} ${s.taskId || '—'} ${t?.status || '?'} ${t?.assignee || ''}`)
    }
  }
  return 0
}

async function cmdStatus(): Promise<number> {
  const plans = listPlans()
  console.log(`planova: ${plans.length}  ·  taskDecompose=${isEnabled('taskDecompose')}  taskDecomposeLive=${isEnabled('taskDecomposeLive')}`)
  for (const p of plans) {
    const w = computeWaves(p.steps)
    console.log(`  ${p.taskId.padEnd(11)} ${p.status.padEnd(13)} koraka=${p.steps.length} valova=${w.length} par=${maxParallel(w)} planer=${p.planner}`)
  }
  return 0
}

async function cmdSimulate(args: string[]): Promise<number> {
  const limit = Number(argVal(args, '--limit') || '400')
  const r = await fetch(`${TASK_API}?limit=${limit}`)
  const data = await r.json() as any
  const tasks: any[] = Array.isArray(data) ? data : (data.tasks || data.data || [])
  const mc = getModeClassifier()
  let eligible = 0
  const reasons: Record<string, number> = {}
  for (const t of tasks) {
    const cls = mc.classify({ title: t.title || '', description: t.description || '', tags: t.tags || [] })
    const g = isDecomposable({ id: t.id, title: t.title, description: t.description, tags: t.tags }, cls.effort)
    if (g.eligible) eligible++
    else reasons[g.reason.replace(/\d+/g, 'N')] = (reasons[g.reason.replace(/\d+/g, 'N')] || 0) + 1
  }
  console.log(`uzorak: ${tasks.length} zadataka · prikladno za razlaganje: ${eligible} (${(100 * eligible / Math.max(1, tasks.length)).toFixed(1)} %)`)
  for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${String(v).padStart(4)} × ${k}`)
  return 0
}

// ─── Ulaz ────────────────────────────────────────────────────────────────────

function argVal(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2)
  const arg0 = rest[0]
  const run = async (): Promise<number> => {
    switch (cmd) {
      case 'plan': return arg0 ? cmdPlan(arg0, rest) : (console.error('Nedostaje TASK-ID'), 2)
      case 'show': return arg0 ? cmdShow(arg0) : (console.error('Nedostaje TASK-ID'), 2)
      case 'approve': return arg0 ? cmdApprove(arg0, rest) : (console.error('Nedostaje TASK-ID'), 2)
      case 'pump': {
        if (rest.includes('--all')) {
          let n = 0
          for (const p of listPlans().filter(p => p.status === 'materialized')) n += await pumpPlan(p.taskId)
          console.log(`otpremljeno: ${n}`)
          return 0
        }
        if (!arg0) { console.error('Nedostaje TASK-ID ili --all'); return 2 }
        console.log(`otpremljeno: ${await pumpPlan(arg0)}`)
        return 0
      }
      case 'status': return cmdStatus()
      case 'simulate': return cmdSimulate(rest)
      default:
        console.log('Naredbe: plan | show | approve | pump | status | simulate  (v. zaglavlje datoteke)')
        return 2
    }
  }
  run().then(c => process.exit(c)).catch(e => { console.error(`decompose fatal: ${e}`); process.exit(1) })
}
