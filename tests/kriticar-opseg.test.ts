/**
 * Kritičar — opseg provjera (TASK-5235, vlasnik, 04.10.2026.)
 *
 * Regresija koju čuva: četiri lažna CRITIC_FAILED u jednom danu (TASK-5210, 5215, 5217, 5220).
 * Kritičar je skup izmjena gradio samo po mtimeu, pa je pokretao:
 *   • snimke koda u docs/ (importi se izvan izvornog stabla ne razrješavaju),
 *   • tuđe testove koje je usporedno pisao drugi zadatak,
 *   • testove koji su padali i prije početka zadatka.
 * Pravilo: propisana provjera + samo ono što je OVAJ spawn dirao (transkript), bez snimki,
 * a zatečeni pad je napomena. Uvodi se u sjeni (`opsegMode`), uz dokaz da pravi pad ostaje pad.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import {
  jeSnimkaKoda,
  citajAtribuciju,
  nadjiTranskripte,
  pripadaSpawnu,
  razlogIzvanOpsega,
  jeZateceniPad,
  presudiZapisReplay,
  type LedgerZapis,
} from '../src/core/KriticarOpseg'
import {
  DEFAULT_CRITIC_CONFIG,
  loadCriticConfig,
  critiqueSpawn,
  failureSignature,
  type CriticConfig,
  type PlannedCheck,
  type RunOutput,
  type CheckResult,
} from '../src/core/CriticGate'

const HOME = process.env.HOME || '/home/klaudio'
let TMP = ''
let LEDGER = ''
const stariLedger = process.env.REGOC_CRITIC_LEDGER

beforeAll(() => {
  mkdirSync(join(HOME, '.tmp'), { recursive: true })
  TMP = mkdtempSync(join(HOME, '.tmp', 'kriticar-opseg-test-'))
})
afterAll(() => {
  if (stariLedger === undefined) delete process.env.REGOC_CRITIC_LEDGER
  else process.env.REGOC_CRITIC_LEDGER = stariLedger
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
})
beforeEach(() => {
  LEDGER = join(TMP, `ledger-${Math.random().toString(36).slice(2)}.jsonl`)
  process.env.REGOC_CRITIC_LEDGER = LEDGER
})

/** Transkript u obliku koji piše `claude --print` (jedan JSON po retku). */
function transkript(put: string, cwd: string, alati: Array<{ name: string; input: Record<string, unknown> }>): string {
  mkdirSync(join(put, '..'), { recursive: true })
  const redci = [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'prompt' }),
    ...alati.map((a, i) => JSON.stringify({
      type: 'assistant', cwd,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: a.name, input: a.input }] },
    })),
    'ovo nije json',
  ]
  writeFileSync(put, redci.join('\n') + '\n')
  return put
}

function stablo(ime: string): string {
  const d = join(TMP, ime)
  mkdirSync(d, { recursive: true })
  return d
}

function cfgZa(root: string, over: Partial<CriticConfig> = {}): CriticConfig {
  return { ...DEFAULT_CRITIC_CONFIG, watchRoots: [root], docMode: 'off', ...over }
}

/** Izvršitelj koji „pada" na svemu čiji cilj sadrži neki od zadanih isječaka. */
function runnerPada(...isjecci: string[]) {
  return (c: PlannedCheck, _t: number): RunOutput => {
    const pada = isjecci.some((s) => c.target.includes(s) || c.cmd.join(' ').includes(s))
    return pada
      ? { exitCode: 1, stdout: '', stderr: `error: Could not resolve: "./Nesto"\n 0 pass\n 1 fail`, timedOut: false }
      : { exitCode: 0, stdout: ' 3 pass\n 0 fail', stderr: '', timedOut: false }
  }
}

// ─── 1. Snimke koda u dokumentaciji ──────────────────────────────────────────

describe('jeSnimkaKoda', () => {
  test('izmjereni putovi (TASK-5210, TASK-5215) su snimke', () => {
    expect(jeSnimkaKoda('/srv/sustav/docs/prijedlozi/qa-5165/snimka-5210/RegocDaemon-isjecak-7800-7840.ts')).toBe(true)
    expect(jeSnimkaKoda('/srv/sustav/docs/kod/TASK-5215/TjedniPregledBlokiranih.ts')).toBe(true)
    expect(jeSnimkaKoda('/x/docs/izvjestaji/snimka/a.test.ts')).toBe(true)
    expect(jeSnimkaKoda('/x/docs/izvjestaji/snimka-koda-5100/a.py')).toBe(true)
  })
  test('pravi kod nije snimka', () => {
    expect(jeSnimkaKoda('/home/k/orkestrator/tests/tjedni-pregled-blokiranih.test.ts')).toBe(false)
    expect(jeSnimkaKoda('/home/k/orkestrator/TjedniPregledBlokiranih.ts')).toBe(false)
    expect(jeSnimkaKoda('/x/docs/system-map/generator.ts')).toBe(false)
    // „kod" bez docs/ ispred nije dokumentacija
    expect(jeSnimkaKoda('/x/kod/snimka.ts')).toBe(false)
  })
  test('mapa snimka*/snapshot* bilo gdje je snimka (replay: tools/telegram_identity_eval/snapshot/, TASK-5104)', () => {
    expect(jeSnimkaKoda('/srv/sustav/tools/telegram_identity_eval/snapshot/telegram-session-identity.test.ts')).toBe(true)
    expect(jeSnimkaKoda('/x/snimke/a.ts')).toBe(true)
    expect(jeSnimkaKoda('/x/tools/kpi-snapshot.ts')).toBe(false) // ime datoteke, ne mapa
  })
})

describe('kod pod docs/ s nerazriješenim importom = snimka (replay: TASK-5028, 5107, 5135, 5140)', () => {
  test('relativni import koji ne postoji → snimka-koda; razriješen → ulazi u provjeru', () => {
    const d = stablo('docs-import')
    mkdirSync(join(d, 'docs', 'architecture', 'siroce_5140'), { recursive: true })
    mkdirSync(join(d, 'docs', 'prototip'), { recursive: true })
    const snimka = join(d, 'docs', 'architecture', 'siroce_5140', 'OrphanRecovery.ts')
    writeFileSync(snimka, "import { x } from './StaleWatchdog'\nexport const y = x\n")
    const zivi = join(d, 'docs', 'prototip', 'proto.ts')
    writeFileSync(join(d, 'docs', 'prototip', 'pomoc.ts'), 'export const p = 1\n')
    writeFileSync(zivi, "import { p } from './pomoc'\nimport { readFileSync } from 'fs'\nexport const q = p\n")
    const a = citajAtribuciju([transkript(join(d, 's.jsonl'), d, [{ name: 'Write', input: { file_path: snimka } }, { name: 'Write', input: { file_path: zivi } }])])
    expect(razlogIzvanOpsega(snimka, a, [])).toBe('snimka-koda')
    expect(razlogIzvanOpsega(zivi, a, [])).toBeNull()
    // izvan docs/ se import NE provjerava (pravi kod s krivim importom je pravi kvar)
    const pravi = join(d, 'Modul.ts')
    writeFileSync(pravi, "import { z } from './NePostoji'\n")
    const a2 = citajAtribuciju([transkript(join(d, 's2.jsonl'), d, [{ name: 'Write', input: { file_path: pravi } }])])
    expect(razlogIzvanOpsega(pravi, a2, [])).toBeNull()
  })
})

// ─── 2. Atribucija iz transkripta ────────────────────────────────────────────

describe('citajAtribuciju / pripadaSpawnu', () => {
  test('Write/Edit/MultiEdit/NotebookEdit + relativan put prema cwd + Bash tekst', () => {
    const d = stablo('atrib1')
    const t = transkript(join(d, 'proj', 'sid-1.jsonl'), '/radni/dir', [
      { name: 'Write', input: { file_path: '/home/x/regoc/Modul.ts', content: '…' } },
      { name: 'Edit', input: { file_path: 'rel/Drugi.ts', old_string: 'a', new_string: 'b' } },
      { name: 'MultiEdit', input: { file_path: '/home/x/regoc/Treci.ts', edits: [] } },
      { name: 'NotebookEdit', input: { notebook_path: '/home/x/n.ipynb' } },
      { name: 'Read', input: { file_path: '/home/x/regoc/SamoCitano.ts' } },
      { name: 'Bash', input: { command: 'cat > /home/x/regoc/tests/novi.test.ts <<EOF\nEOF' } },
    ])
    const a = citajAtribuciju([t])!
    expect(a).not.toBeNull()
    expect(a.pisano.has('/home/x/regoc/Modul.ts')).toBe(true)
    expect(a.pisano.has('/radni/dir/rel/Drugi.ts')).toBe(true)
    expect(a.pisano.has('/home/x/regoc/Treci.ts')).toBe(true)
    expect(a.pisano.has('/home/x/n.ipynb')).toBe(true)
    expect(a.pisano.has('/home/x/regoc/SamoCitano.ts')).toBe(false)

    expect(pripadaSpawnu('/home/x/regoc/Modul.ts', a)).toBe(true)
    expect(pripadaSpawnu('/home/x/regoc/tests/novi.test.ts', a)).toBe(true) // iz Bash teksta
    expect(pripadaSpawnu('/home/x/regoc/SamoCitano.ts', a)).toBe(false)
    expect(pripadaSpawnu('/home/x/regoc/tests/tjedni-pregled-blokiranih.test.ts', a)).toBe(false)
  })

  test('ime datoteke u Bash naredbi (sed -i, cp u živo stablo) je dovoljno, podniz imena nije', () => {
    const d = stablo('atrib2')
    const t = transkript(join(d, 'sid-2.jsonl'), '/r', [
      { name: 'Bash', input: { command: "cd ~/orkestrator && sed -i 's/a/b/' Jezik.ts && cp ../x/Alat.ts ~/orkestrator/" } },
    ])
    const a = citajAtribuciju([t])!
    expect(pripadaSpawnu('/home/k/orkestrator/Jezik.ts', a)).toBe(true)
    expect(pripadaSpawnu('/home/k/orkestrator/Alat.ts', a)).toBe(true)
    // „PlocaJezik.ts" sadrži „Jezik.ts" kao podniz — to NIJE ista datoteka
    expect(pripadaSpawnu('/home/k/orkestrator/TaskManagerMD/PlocaJezik.ts', a)).toBe(false)
  })

  test('nema transkripta ili je nečitljiv → null (atribucija nedostupna)', () => {
    expect(citajAtribuciju([])).toBeNull()
    expect(citajAtribuciju([join(TMP, 'nepostoji.jsonl')])).toBeNull()
  })

  test('nadjiTranskripte: glavni + subagenti pod istim session-id', () => {
    const projekti = stablo('projekti')
    const sid = '11111111-2222-3333-4444-555555555555'
    transkript(join(projekti, '-home-a', `${sid}.jsonl`), '/a', [])
    transkript(join(projekti, '-home-a', sid, 'subagents', 'agent-x.jsonl'), '/a', [])
    transkript(join(projekti, '-home-b', 'drugi.jsonl'), '/b', [])
    const n = nadjiTranskripte(sid, projekti)
    expect(n.length).toBe(2)
    expect(n.some((p) => p.endsWith(`${sid}.jsonl`))).toBe(true)
    expect(n.some((p) => p.includes('subagents'))).toBe(true)
    expect(nadjiTranskripte('../../etc', projekti)).toEqual([])
  })

  test('razlogIzvanOpsega: snimka > vlastiti korijen > atribucija', () => {
    const d = stablo('atrib3')
    const a = citajAtribuciju([transkript(join(d, 's.jsonl'), '/r', [{ name: 'Write', input: { file_path: '/w/Moj.ts' } }])])
    expect(razlogIzvanOpsega('/w/docs/kod/T/Moj.ts', a, [])).toBe('snimka-koda')
    expect(razlogIzvanOpsega('/w/Moj.ts', a, [])).toBeNull()
    expect(razlogIzvanOpsega('/w/Tudji.ts', a, [])).toBe('nije-dirao')
    expect(razlogIzvanOpsega('/wt/Tudji.ts', a, ['/wt'])).toBeNull() // vlastiti worktree
    expect(razlogIzvanOpsega('/w/Tudji.ts', null, [])).toBeNull()     // bez atribucije: staro pravilo
    // .md u docs/kod/ nije kod — izuzeće snimke ga ne dira (doc-provjera ostaje)
    expect(razlogIzvanOpsega('/w/docs/kod/T/README.md', a, [])).toBe('nije-dirao')
  })
})

// ─── 3. Zatečeni pad ─────────────────────────────────────────────────────────

describe('jeZateceniPad', () => {
  const SIG = 'test:.orkestrator/TaskManagerMD/tests/unit/PlocaJezik.test.ts:error: expect(received).toEqual(expected)'
  const T = '.orkestrator/TaskManagerMD/tests/unit/PlocaJezik.test.ts'
  const since = Date.parse('2026-10-04T13:40:00Z')
  const z = (ts: string, taskId: string, over: Partial<LedgerZapis> = {}): LedgerZapis =>
    ({ ts, taskId, status: 'fail', signatures: [SIG], ...over })

  test('isti potpis kod DRUGOG zadatka prije starta → zatečen', () => {
    const r = jeZateceniPad({ signature: SIG, kind: 'test', relTarget: T, sinceMs: since, taskId: 'TASK-5220', rows: [z('2026-10-04T10:00:00Z', 'TASK-5211')] })
    expect(r.zatecen).toBe(true)
    expect(r.izvor).toContain('TASK-5211')
  })
  test('poslije toga je ista provjera PROŠLA → nije zatečen (pao pa popravljen)', () => {
    const rows = [z('2026-10-04T10:00:00Z', 'TASK-5211'), z('2026-10-04T11:00:00Z', 'TASK-5212', { status: 'pass', signatures: [], prosle: [T] })]
    expect(jeZateceniPad({ signature: SIG, kind: 'test', relTarget: T, sinceMs: since, taskId: 'TASK-5220', rows }).zatecen).toBe(false)
  })
  test('isti zadatak (prethodni krug) se ne računa', () => {
    expect(jeZateceniPad({ signature: SIG, kind: 'test', relTarget: T, sinceMs: since, taskId: 'TASK-5220', rows: [z('2026-10-04T10:00:00Z', 'TASK-5220')] }).zatecen).toBe(false)
  })
  test('vlastiti raniji pad istog potpisa → nije zatečen ni kad je tuđi zapis između krugova', () => {
    // A (TASK-5220) u 1. krugu pokvari test; B ga zabilježi; A-ov 2. krug počinje poslije B-a.
    const rows = [
      z('2026-10-04T12:00:00Z', 'TASK-5220'),
      z('2026-10-04T12:30:00Z', 'TASK-B'),
    ]
    expect(jeZateceniPad({ signature: SIG, kind: 'test', relTarget: T, sinceMs: since, taskId: 'TASK-5220', rows }).zatecen).toBe(false)
  })
  test('tuđi zapis nakon PRVOG zapisa istog zadatka ne dokazuje zatečenost', () => {
    const rows = [
      z('2026-10-04T12:00:00Z', 'TASK-5220', { status: 'pass', signatures: [] }),
      z('2026-10-04T12:30:00Z', 'TASK-B'),
    ]
    expect(jeZateceniPad({ signature: SIG, kind: 'test', relTarget: T, sinceMs: since, taskId: 'TASK-5220', rows }).zatecen).toBe(false)
  })
  test('zapis NAKON starta spawna se ne računa', () => {
    expect(jeZateceniPad({ signature: SIG, kind: 'test', relTarget: T, sinceMs: since, taskId: 'X', rows: [z('2026-10-04T14:00:00Z', 'TASK-5211')] }).zatecen).toBe(false)
  })
  test('više palih testova nego prije → nije zatečen (novi kvar uz stari)', () => {
    const rows = [z('2026-10-04T10:00:00Z', 'TASK-5211', { failCounts: { [SIG]: 3 } })]
    expect(jeZateceniPad({ signature: SIG, kind: 'test', relTarget: T, failCount: 5, sinceMs: since, taskId: 'X', rows }).zatecen).toBe(false)
    expect(jeZateceniPad({ signature: SIG, kind: 'test', relTarget: T, failCount: 3, sinceMs: since, taskId: 'X', rows }).zatecen).toBe(true)
  })
  test('drukčiji potpis, stariji od roka ili propisana provjera → nije zatečen', () => {
    const rows = [z('2026-10-04T10:00:00Z', 'TASK-5211')]
    expect(jeZateceniPad({ signature: SIG + 'x', kind: 'test', relTarget: T, sinceMs: since, taskId: 'X', rows }).zatecen).toBe(false)
    expect(jeZateceniPad({ signature: SIG, kind: 'test', relTarget: T, sinceMs: since, taskId: 'X', rows: [z('2026-09-01T10:00:00Z', 'T')], lookbackMs: 14 * 86400_000 }).zatecen).toBe(false)
    expect(jeZateceniPad({ signature: SIG, kind: 'task', relTarget: T, sinceMs: since, taskId: 'X', rows }).zatecen).toBe(false)
  })
})

// ─── 4. Cijeli sud — četiri izmjerena slučaja + pravi pad ────────────────────

describe('critiqueSpawn s opsegom', () => {
  function pripremi(ime: string) {
    const root = stablo(ime)
    mkdirSync(join(root, 'tests'), { recursive: true })
    const sinceMs = Date.now() - 1000
    return { root, sinceMs }
  }

  test('TASK-5210/5215: snimka u docs/kod i docs/prijedlozi/…/snimka-* — sjena kaže novo=pass, staro=fail', () => {
    const { root, sinceMs } = pripremi('slucaj-5215')
    mkdirSync(join(root, 'docs', 'kod', 'TASK-5215'), { recursive: true })
    mkdirSync(join(root, 'docs', 'prijedlozi', 'qa', 'snimka-5210'), { recursive: true })
    writeFileSync(join(root, 'docs', 'kod', 'TASK-5215', 'Tjedni.ts'), "import { x } from './StaleWatchdog'\n")
    writeFileSync(join(root, 'docs', 'prijedlozi', 'qa', 'snimka-5210', 'isjecak.ts'), 'a: b\n')
    writeFileSync(join(root, 'Tjedni.ts'), 'export const x = 1\n')
    const sid = 's-5215'
    const t = transkript(join(root, '..', 'tr-5215', `${sid}.jsonl`), root, [
      { name: 'Write', input: { file_path: join(root, 'Tjedni.ts') } },
      { name: 'Bash', input: { command: `mkdir -p docs/kod/TASK-5215 && cp Tjedni.ts docs/kod/TASK-5215/ && cp x docs/prijedlozi/qa/snimka-5210/isjecak.ts` } },
    ])
    const cfg = cfgZa(root, { opsegMode: 'shadow' } as any)
    const o = critiqueSpawn({ taskId: 'TASK-T5215', agentId: 'jelena', sinceMs, live: true, transcripts: [t] }, cfg, runnerPada('docs/'))
    expect(o.verdict.status).toBe('fail')           // sjena: stari sud i dalje odlučuje
    expect(o.opseg?.novo).toBe('pass')
    expect(o.opseg?.izbaceno.some((i) => i.razlog === 'snimka-koda')).toBe(true)
    const red = readFileSync(LEDGER, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)).pop()
    expect(red.opseg.nacin).toBe('shadow')
    expect(red.opseg.staro).toBe('fail')
    expect(red.opseg.novo).toBe('pass')
  })

  test('TASK-5217: tuđi test koji je usporedno pisao drugi zadatak — u načinu on se ni ne pokreće', () => {
    const { root, sinceMs } = pripremi('slucaj-5217')
    writeFileSync(join(root, 'tests', 'tjedni-pregled-blokiranih.test.ts'), "import '../TjedniPregledBlokiranih'\n")
    writeFileSync(join(root, 'MojModul.ts'), 'export const m = 1\n')
    const t = transkript(join(root, '..', 'tr-5217', 's.jsonl'), root, [{ name: 'Edit', input: { file_path: join(root, 'MojModul.ts') } }])
    const pokrenuto: string[] = []
    const r = (c: PlannedCheck, x: number) => { pokrenuto.push(c.target); return runnerPada('tjedni-pregled')(c, x) }
    const o = critiqueSpawn({ taskId: 'TASK-T5217', agentId: 'jelena', sinceMs, live: true, transcripts: [t] }, cfgZa(root, { opsegMode: 'on' } as any), r)
    expect(o.verdict.status).toBe('pass')
    expect(o.enforce).toBe(false)
    expect(pokrenuto.some((p) => p.includes('tjedni-pregled'))).toBe(false)
    expect(pokrenuto.some((p) => p.endsWith('MojModul.ts'))).toBe(true)
    expect(o.verdict.notes.join(' ')).toContain('izvan opsega')
  })

  test('TASK-5220: zatečeni pad tuđeg testa (dirao je modul) → napomena, ne CRITIC_FAILED', () => {
    const { root, sinceMs } = pripremi('slucaj-5220')
    writeFileSync(join(root, 'PlocaJezik.ts'), 'export const p = 1\n')
    writeFileSync(join(root, 'tests', 'ploca-jezik.test.ts'), "import '../PlocaJezik'\n")
    const testPut = join(root, 'tests', 'ploca-jezik.test.ts')
    // Prije starta je isti test kod DRUGOG zadatka pao s istim potpisom.
    const pao: CheckResult = { kind: 'test', target: testPut, cmd: ['bun', 'test', testPut], cwd: root, ok: false, exitCode: 1, ms: 1, timedOut: false, skipped: false, errorLine: 'error: Could not resolve: "./Nesto"' }
    writeFileSync(LEDGER, JSON.stringify({ ts: new Date(sinceMs - 3600_000).toISOString(), taskId: 'TASK-5211', agentId: 'jelena', round: 1, status: 'fail', signatures: [failureSignature(pao)], enforced: true }) + '\n')
    const t = transkript(join(root, '..', 'tr-5220', 's.jsonl'), root, [{ name: 'Write', input: { file_path: join(root, 'PlocaJezik.ts') } }])
    const o = critiqueSpawn({ taskId: 'TASK-T5220', agentId: 'stribor', sinceMs, live: true, transcripts: [t] }, cfgZa(root, { opsegMode: 'on' } as any), runnerPada('ploca-jezik.test'))
    expect(o.verdict.status).toBe('pass')
    expect(o.enforce).toBe(false)
    expect(o.verdict.notes.join(' ')).toContain('zatečen')
    expect(o.opseg?.zateceni.length).toBe(1)
  })

  test('PRAVI pad (spawn je napisao pokvaren modul) ostaje pad i u načinu on', () => {
    const { root, sinceMs } = pripremi('slucaj-pravi')
    writeFileSync(join(root, 'Pokvaren.ts'), 'const = ;\n')
    const t = transkript(join(root, '..', 'tr-pravi', 's.jsonl'), root, [{ name: 'Write', input: { file_path: join(root, 'Pokvaren.ts') } }])
    const o = critiqueSpawn({ taskId: 'TASK-TPRAVI', agentId: 'jelena', sinceMs, live: true, transcripts: [t] }, cfgZa(root, { opsegMode: 'on' } as any), runnerPada('Pokvaren'))
    expect(o.verdict.status).toBe('fail')
    expect(o.enforce).toBe(true)
  })

  test('pad propisane provjere ostaje pad (nikad zatečen, nikad izvan opsega)', () => {
    const { root, sinceMs } = pripremi('slucaj-propisano')
    writeFileSync(join(root, 'tests', 'kriticar.test.ts'), 'x\n')
    const t = transkript(join(root, '..', 'tr-prop', 's.jsonl'), root, [])
    const declared = { present: true, checks: [{ raw: 'bun test tests/kriticar.test.ts', cmd: ['bun', 'test', 'tests/kriticar.test.ts'], cwdRel: '' }], issues: [], sections: [], docTargets: [] } as any
    const o = critiqueSpawn({ taskId: 'TASK-TPROP', agentId: 'jelena', sinceMs, live: true, transcripts: [t], declared, rootDir: root }, cfgZa(root, { opsegMode: 'on' } as any), runnerPada('kriticar.test'))
    expect(o.verdict.status).toBe('fail')
    expect(o.verdict.failed.some((f) => f.kind === 'task')).toBe(true)
  })

  test('bez transkripta: atribucija nedostupna → tuđa datoteka i dalje ulazi (fail-closed), snimka i dalje van', () => {
    const { root, sinceMs } = pripremi('slucaj-bez')
    mkdirSync(join(root, 'docs', 'kod'), { recursive: true })
    writeFileSync(join(root, 'docs', 'kod', 'S.ts'), 'x\n')
    writeFileSync(join(root, 'Tudji.ts'), 'x\n')
    const o = critiqueSpawn({ taskId: 'TASK-TBEZ', agentId: 'jelena', sinceMs, live: true }, cfgZa(root, { opsegMode: 'on' } as any), runnerPada('Tudji', 'docs/kod'))
    expect(o.verdict.status).toBe('fail')
    expect(o.verdict.failed.map((f) => f.target).some((p) => p.includes('docs/kod'))).toBe(false)
    expect(o.verdict.notes.join(' ')).toContain('atribucija nedostupna')
  })

  test('opsegMode off = staro ponašanje bez polja opseg; trag bilježi prosle', () => {
    const { root, sinceMs } = pripremi('slucaj-off')
    writeFileSync(join(root, 'A.ts'), 'x\n')
    const o = critiqueSpawn({ taskId: 'TASK-TOFF', agentId: 'jelena', sinceMs, live: true }, cfgZa(root, { opsegMode: 'off' } as any), runnerPada('nista'))
    expect(o.verdict.status).toBe('pass')
    expect(o.opseg).toBeUndefined()
    const red = JSON.parse(readFileSync(LEDGER, 'utf-8').trim().split('\n').pop()!)
    expect(red.opseg).toBeUndefined()
    expect(red.prosle.some((p: string) => p.endsWith('A.ts'))).toBe(true)
  })
})

// ─── 5. Konfiguracija i replay ───────────────────────────────────────────────

describe('konfiguracija i replay', () => {
  test('opsegMode: zadano shadow, tipfeler pada na shadow', () => {
    expect((DEFAULT_CRITIC_CONFIG as any).opsegMode).toBe('shadow')
    const p = join(TMP, 'cfg.json')
    writeFileSync(p, JSON.stringify({ opsegMode: 'ukljuceno' }))
    expect((loadCriticConfig(p, true) as any).opsegMode).toBe('shadow')
    writeFileSync(p, JSON.stringify({ opsegMode: 'on' }))
    expect((loadCriticConfig(p, true) as any).opsegMode).toBe('on')
  })

  test('presudiZapisReplay: snimka/tuđe otpada, dirano ostaje', () => {
    const d = stablo('replay')
    const a = citajAtribuciju([transkript(join(d, 's.jsonl'), '/r', [{ name: 'Write', input: { file_path: `${HOME}/.orkestrator/Moj.ts` } }])])
    const row: LedgerZapis = {
      ts: '2026-10-04T08:00:00Z', taskId: 'TASK-X', status: 'fail',
      signatures: [
        'parse:app/sustav/docs/kod/TASK-5215/T.ts:error: Could not resolve',
        'test:.orkestrator/tests/tudji.test.ts:# Unhandled error between tests',
        'parse:.orkestrator/Moj.ts:error: Expected ";"',
      ],
    }
    const p = presudiZapisReplay(row, a, [], HOME)
    expect(p.novo).toBe('fail')
    expect(p.zadrzano).toEqual(['parse:.orkestrator/Moj.ts:error: Expected ";"'])
    expect(p.otpalo.map((x) => x.razlog).sort()).toEqual(['nije-dirao', 'snimka-koda'])
    const p2 = presudiZapisReplay({ ...row, signatures: row.signatures.slice(0, 2) }, a, [], HOME)
    expect(p2.novo).toBe('pass')
  })

  test('presudiZapisReplay: propisana (task) provjera se nikad ne izbacuje', () => {
    const row: LedgerZapis = { ts: '2026-10-04T08:00:00Z', taskId: 'T', status: 'fail', signatures: ['task:.orkestrator$bun test x.test.ts:exit=N'] }
    expect(presudiZapisReplay(row, null, [], HOME).novo).toBe('fail')
  })
})
