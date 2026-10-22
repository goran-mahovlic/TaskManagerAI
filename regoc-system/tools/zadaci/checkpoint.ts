#!/usr/bin/env bun
/**
 * checkpoint.ts — alat za kontrolne točke ručnog pregleda (A5 / TASK-3004).
 *
 * Ovo je Goranovo sučelje prema mehanizmu iz `ReviewCheckpoint.ts`. Naredbe za odobrenje i
 * odbijanje ispisuju se doslovno u samoj Telegram obavijesti, pa se ne mora pamtiti ništa.
 *
 *   bun ~/.claude/regoc/tools/checkpoint.ts list                    # što čeka pregled
 *   bun ~/.claude/regoc/tools/checkpoint.ts brief CP-TASK-3004      # što je prethodilo
 *   bun ~/.claude/regoc/tools/checkpoint.ts approve CP-TASK-3004 --note "nastavi"
 *   bun ~/.claude/regoc/tools/checkpoint.ts reject  CP-TASK-3004 --note "plan ne valja"
 *   bun ~/.claude/regoc/tools/checkpoint.ts simulate                # što bi se ZADRŽALO sada
 *   bun ~/.claude/regoc/tools/checkpoint.ts declare TASK-3005 --scope tag:albert-ideja
 *
 * `simulate` je namjerno prvi korak uvođenja: čita živu ploču i ispisuje što bi vrata
 * zadržala, bez ijedne izmjene. Isti obrazac kao `tools/scope-report.ts` i `tools/tier-report.ts`.
 */

import {
  readCheckpointState, writeCheckpointState, appendCheckpointLog, loadCheckpointConfig,
  applyDecision, classifyHolds, dueNotification, formatCheckpointAlarm, formatResumeBrief,
  detectTriggers, parseStopAfter, pruneDecided,
  CHECKPOINT_STATE_PATH, CHECKPOINT_LOG_PATH, STOP_AFTER_TAG,
  type CheckpointRecord, type CheckpointTaskLike,
} from '../../ReviewCheckpoint'

const API = process.env.REGOC_TASK_API || 'http://localhost:17781/api/tasks'

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : null
}

async function fetchTasks(status: string): Promise<CheckpointTaskLike[]> {
  try {
    const r = await fetch(`${API}?status=${status}`)
    if (!r.ok) { console.error(`⚠️ ploča vraća HTTP ${r.status}`); return [] }
    const j = await r.json() as any
    return Array.isArray(j) ? j : (Array.isArray(j?.tasks) ? j.tasks : [])
  } catch (e) {
    console.error(`⚠️ ploča nedostupna (${e}) — bez nje se može samo čitati stanje`)
    return []
  }
}

const scopeText = (c: CheckpointRecord) =>
  c.scopeKind === 'all' ? 'SVE' : c.scopeKind === 'none' ? '(neizjavljen)' : `${c.scopeKind}:${c.scopeValue}`

const hours = (iso: string | null) => {
  if (!iso) return '—'
  const t = Date.parse(iso)
  return Number.isFinite(t) ? `${Math.round((Date.now() - t) / 3600_000)} h` : '—'
}

// ─────────────────────────────────────────────────────────────────────────────

async function cmdList(): Promise<number> {
  const { state, corrupt } = readCheckpointState()
  if (corrupt) console.error(`❌ zapis stanja je NEČITLJIV (${CHECKPOINT_STATE_PATH}) — vrata su u fail-open načinu`)

  const open = state.checkpoints.filter(c => c.status === 'open')
  const decided = state.checkpoints.filter(c => c.status !== 'open')

  console.log(`\n⏸️  KONTROLNE TOČKE — ${open.length} otvoreno, ${decided.length} odlučeno`)
  console.log(`    zapis: ${CHECKPOINT_STATE_PATH}\n`)

  if (open.length === 0) {
    console.log('  (ništa ne čeka pregled)')
  } else {
    for (const c of open) {
      console.log(`  ${c.id}  čeka ${hours(c.openedAt)}`)
      console.log(`     okinuo: ${c.taskId} — ${c.taskTitle}${c.agent ? ` (${c.agent})` : ''}`)
      console.log(`     zadržava: ${scopeText(c)} · trenutno ${c.heldIds.length} zadataka: ${c.heldIds.slice(0, 6).join(', ') || '—'}`)
      console.log(`     obaviješten: ${c.notifiedAt ? `da (${hours(c.notifiedAt)} prije, ${c.reminders} podsjetnika)` : 'NE — obavijest još nije prošla'}`)
      console.log(`     nastavi: bun ~/.claude/regoc/tools/checkpoint.ts approve ${c.id} --note "..."`)
      console.log('')
    }
  }
  for (const c of decided.slice(-5)) {
    console.log(`  ${c.status === 'approved' ? '✅' : '⛔'} ${c.id} — ${c.status} (${c.decidedBy || '?'}, ${c.decidedAt || '?'}) ${c.note || ''}`)
  }
  return 0
}

async function cmdDecide(decision: 'approved' | 'rejected'): Promise<number> {
  const id = process.argv[3]
  if (!id || id.startsWith('--')) { console.error('Treba id točke, npr. CP-TASK-3004 (vidi: checkpoint.ts list)'); return 2 }
  const by = arg('by') || 'goran'
  const note = arg('note')

  const { state, corrupt } = readCheckpointState()
  if (corrupt) { console.error('❌ zapis stanja je nečitljiv — odluka bi se izgubila. Popravi ili obriši zapis.'); return 3 }

  const res = applyDecision(state, id, decision, by, note)
  if (res.error) { console.error(`❌ ${res.error}`); return 4 }
  if (!res.changed) { console.log(`ℹ️ ${id} je već ${decision} — ništa se nije promijenilo.`); return 0 }
  if (!writeCheckpointState(res.state)) { console.error('❌ upis stanja nije uspio — odluka NIJE zapisana.'); return 5 }

  appendCheckpointLog({
    ts: new Date().toISOString(), event: 'decided', checkpointId: id,
    taskId: res.record?.taskId, decision, by, detail: note || '', source: 'cli',
  })

  if (decision === 'approved') {
    console.log(`✅ ${id} odobren. Zadržani zadatci vraćaju se u red u sljedećem prolazu auto-execa (≤15 s).`)
    console.log('   Nastavak dobiva sažetak prethodnog rada u promptu (checkpoint.ts brief ' + id + ').')
  } else {
    console.log(`⛔ ${id} odbijen. Zadatci iz opsega OSTAJU zadržani i točka prestaje zvoniti.`)
    console.log('   Ako ih treba otkazati ili izmijeniti, to je odluka s ploče — mehanizam ih namjerno ne dira sam.')
  }
  return 0
}

async function cmdBrief(): Promise<number> {
  const id = process.argv[3]
  const { state } = readCheckpointState()
  const cp = state.checkpoints.find(c => c.id === id)
  if (!cp) { console.error(`❌ nepoznata točka ${id}`); return 4 }
  console.log(formatResumeBrief(cp))
  return 0
}

async function cmdSimulate(): Promise<number> {
  const cfg = loadCheckpointConfig()
  const { state, corrupt } = readCheckpointState()
  const pending = await fetchTasks('pending')
  const completed = await fetchTasks('completed')

  console.log(`\n🔍 SIMULACIJA (ništa se ne mijenja) — policy=${cfg.policy}, ${pending.length} pending, ${completed.length} completed`)
  if (corrupt) console.log('   ❌ zapis stanja nečitljiv → vrata bi radila kao da točaka nema (fail-open)')

  const det = detectTriggers(completed, state, { now: Date.now(), cfg, pending })
  console.log(`\n  Zadataka koji IZJAVLJUJU točku: ${completed.filter(t => parseStopAfter(t, cfg)).length}`)
  console.log(`  Točaka koje bi se SADA otvorile: ${det.opened.length}`)
  for (const o of det.opened) console.log(`     + ${o.id} (${scopeText(o)}) — držao bi ${o.heldIds.length}`)
  for (const s of det.skipped) console.log(`     – ${s.taskId}: ${s.reason}`)

  const all = [...state.checkpoints, ...det.opened]
  const holds = classifyHolds(pending, all, cfg)
  const held = holds.filter(h => h.verdict === 'hold')
  console.log(`\n  Zadržalo bi se: ${held.length} od ${pending.length} pending zadataka`)
  for (const h of held) console.log(`     ⏸️ ${h.taskId} — ${h.reason}`)
  if (held.length === 0) console.log('     (ništa — autonomni rad teče normalno)')

  const due = all.filter(c => dueNotification(c, Date.now(), cfg))
  console.log(`\n  Obavijesti koje bi sada otišle: ${due.length}`)
  for (const c of due) console.log(`     📨 ${c.id} (${dueNotification(c, Date.now(), cfg)})`)
  console.log('')
  return 0
}

/**
 * Pomoć pri izjavljivanju: doda oznaku `stop-after:<opseg>` na postojeći zadatak preko API-ja.
 * Postoji da se izjava ne mora sastavljati ručno — kriva oznaka znači vrata koja ne rade.
 */
async function cmdDeclare(): Promise<number> {
  const taskId = process.argv[3]
  const scope = arg('scope')
  if (!taskId || taskId.startsWith('--')) { console.error('Treba id zadatka, npr. TASK-3005'); return 2 }

  const r = await fetch(`${API}/${taskId}`)
  if (!r.ok) { console.error(`❌ zadatak ${taskId} nije dohvatljiv (HTTP ${r.status})`); return 4 }
  const t = await r.json() as any
  const tags: string[] = Array.isArray(t.tags) ? t.tags : []
  const tag = scope ? `${STOP_AFTER_TAG}:${scope}` : STOP_AFTER_TAG
  if (tags.some(x => x.toLowerCase().startsWith(STOP_AFTER_TAG))) {
    console.log(`ℹ️ ${taskId} već izjavljuje kontrolnu točku (${tags.find(x => x.toLowerCase().startsWith(STOP_AFTER_TAG))})`)
    return 0
  }
  const put = await fetch(`${API}/${taskId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: [...tags, tag] }),
  })
  if (!put.ok) { console.error(`❌ upis oznake pao (HTTP ${put.status})`); return 5 }

  const parsed = parseStopAfter({ ...t, tags: [...tags, tag] }, loadCheckpointConfig())
  console.log(`✅ ${taskId} sada nosi "${tag}" → opseg ${parsed ? `${parsed.scope.kind}:${parsed.scope.value ?? '—'}` : '(neprepoznat!)'}`)
  if (parsed?.scope.kind === 'none') console.log('   ⚠️ opseg nije izjavljen — točka će javiti, ali NEĆE ništa zadržati. Dodaj --scope tag:<ime>.')
  return 0
}

async function cmdPrune(): Promise<number> {
  const { state } = readCheckpointState()
  const out = pruneDecided(state, Date.now(), Number(arg('days') || 30))
  const removed = state.checkpoints.length - out.checkpoints.length
  if (removed > 0 && writeCheckpointState(out)) console.log(`🧹 uklonjeno ${removed} starih odlučenih točaka`)
  else console.log('ništa za očistiti')
  return 0
}

async function main(): Promise<void> {
  const cmd = process.argv[2] || 'list'
  const map: Record<string, () => Promise<number>> = {
    list: cmdList,
    status: cmdList,
    approve: () => cmdDecide('approved'),
    reject: () => cmdDecide('rejected'),
    brief: cmdBrief,
    simulate: cmdSimulate,
    declare: cmdDeclare,
    prune: cmdPrune,
  }
  const fn = map[cmd]
  if (!fn) {
    console.error(`Nepoznata naredba "${cmd}".`)
    console.error('Dostupno: list | brief <ID> | approve <ID> | reject <ID> | simulate | declare <TASK> --scope <opseg> | prune')
    console.error(`Dnevnik: ${CHECKPOINT_LOG_PATH}`)
    process.exit(2)
  }
  process.exit(await fn())
}

if (import.meta.main) await main()
