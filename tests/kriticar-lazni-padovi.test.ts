/**
 * Kritičar — preostali LAŽNI CRITIC_FAILED (TASK-5670, vlasnik 20.10.2026.)
 *
 * „ako je zadatak prošao treba kritičara doraditi pa da prođe jer izgleda da puno zadataka
 * ode u blok bez razloga". Opseg (TASK-5235) je uključen, a u tragu (data/critic_gate.jsonl)
 * i dalje ostaju padovi koji NISU dokaz kvara zadatka:
 *   K1 istek roka auto-testa (daemon-keeper-boot/env, restart-kad-mirno; TASK-5654 ×3, 5397…)
 *   K2 worktree bez node_modules („Could not resolve: "zod". Maybe you need to "bun install"")
 *   K3 okolina: ENOSPC i „Unhandled error between tests" iz istog uzroka
 *   K4 isti tuđi pad na više zadataka (trajna-sesija-spawn: 5615 → 5623/5625/5626)
 *   K5 snimke koda pod docs/architecture/** (TASK-5259, 5414)
 * PRAVILO koje ovi testovi čuvaju jednako kao i popravke: stvarni pad u datoteci koju je OVAJ
 * spawn dirao i dalje blokira (fail-closed za vlastiti kod).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, statfsSync } from 'fs'
import { join } from 'path'
import {
  jeSnimkaKoda,
  okolinaIzIzlaza,
  normalizirajPotpis,
  jeIstekRokaPotpis,
  jeVisestrukiTudjiPad,
  spominjeIzvjestaj,
  diraoTest,
  gitDirao,
  diskNizak,
  presudiZapisReplay,
  type LedgerZapis,
} from '../src/core/KriticarOpseg'
import {
  DEFAULT_CRITIC_CONFIG,
  loadCriticConfig,
  critiqueSpawn,
  critiqueSpawnAsync,
  runChecks,
  judge,
  failureSignature,
  explainUnverified,
  type CriticConfig,
  type PlannedCheck,
  type RunOutput,
  type CheckResult,
} from '../src/core/CriticGate'

const HOME = process.env.HOME || '/home/korisnik'
let TMP = ''
let LEDGER = ''
const stariLedger = process.env.REGOC_CRITIC_LEDGER

beforeAll(() => {
  mkdirSync(join(HOME, '.tmp'), { recursive: true })
  TMP = mkdtempSync(join(HOME, '.tmp', 'kriticar-lazni-'))
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

function transkript(put: string, cwd: string, alati: Array<{ name: string; input: Record<string, unknown> }>): string {
  mkdirSync(join(put, '..'), { recursive: true })
  const redci = alati.map((a, i) => JSON.stringify({
    type: 'assistant', cwd,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: a.name, input: a.input }] },
  }))
  writeFileSync(put, redci.join('\n') + '\n')
  return put
}

function stablo(ime: string): string {
  const d = join(TMP, ime)
  mkdirSync(join(d, 'tests'), { recursive: true })
  return d
}

function cfgZa(root: string, over: Partial<CriticConfig> = {}): CriticConfig {
  return { ...DEFAULT_CRITIC_CONFIG, watchRoots: [root], docMode: 'off', opsegMode: 'on', ...over }
}

const OK: RunOutput = { exitCode: 0, stdout: ' 3 pass\n 0 fail', stderr: '', timedOut: false }
const ISTEK: RunOutput = { exitCode: null, stdout: '', stderr: 'tests/spori.test.ts:\n', timedOut: true }

function res(over: Partial<CheckResult> = {}): CheckResult {
  return {
    kind: 'test', target: '/x/tests/a.test.ts', cmd: ['bun', 'test', '/x/tests/a.test.ts'], cwd: '/x',
    ok: false, exitCode: 1, ms: 5, timedOut: false, skipped: false, errorLine: 'error: expect(received).toBe(expected)', ...over,
  } as CheckResult
}
const prazanScan = { files: [], truncated: 0, missingRoots: [] }

// ─── K1 istek roka ───────────────────────────────────────────────────────────

describe('K1 istek roka auto-provjere = neprovjereno, nikad pad', () => {
  const plan: PlannedCheck[] = [{ kind: 'test', target: '/x/tests/spori.test.ts', cmd: ['bun', 'test', '/x/tests/spori.test.ts'], cwd: '/x' }]

  test('istekao rok → JEDAN ponovni pokušaj s duljim rokom; prošao → ok', () => {
    const rokovi: number[] = []
    const runner = (_c: PlannedCheck, t: number): RunOutput => { rokovi.push(t); return rokovi.length === 1 ? ISTEK : OK }
    const r = runChecks(plan, { ...DEFAULT_CRITIC_CONFIG, timeoutRetryMs: 60_000 }, runner)
    expect(rokovi.length).toBe(2)
    expect(rokovi[1]).toBeGreaterThan(rokovi[0])
    expect(r[0].ok).toBe(true)
    expect(r[0].ponovljeno).toBe(true)
  })

  test('i ponovni pokušaj istekao → sud unverifiable, ne fail; razlog imenuje istek', () => {
    let n = 0
    const r = runChecks(plan, { ...DEFAULT_CRITIC_CONFIG, timeoutRetryMs: 60_000 }, () => { n++; return ISTEK })
    expect(n).toBe(2)
    const v = judge(r, prazanScan as any, [], [], DEFAULT_CRITIC_CONFIG)
    expect(v.status).toBe('unverifiable')
    expect(v.blocking).toBe(false)
    expect(v.failed.length).toBe(0)
    expect(v.neprovjereno[0].reason).toContain('istekao rok')
    expect(explainUnverified(v, DEFAULT_CRITIC_CONFIG).join(' ')).toContain('istekao rok')
  })

  test('ASINKRONI put (daemon): isto — ponovni pokušaj, pa unverifiable', async () => {
    const root = stablo('k1-async')
    writeFileSync(join(root, 'Sporo.ts'), 'export const s = 1\n')
    let n = 0
    const o = await critiqueSpawnAsync(
      { taskId: 'TASK-K1A', agentId: 'jelena', sinceMs: Date.now() - 60_000, live: true },
      cfgZa(root, { opsegMode: 'off' }), async () => { n++; return ISTEK },
    )
    expect(n).toBe(2)
    expect(o.verdict.status).toBe('unverifiable')
    expect(o.enforce).toBe(false)
  })

  test('PRAVI pad vlastitog testa i dalje blokira (exit 1 nije istek)', () => {
    const v = judge([res()], prazanScan as any, [], [], DEFAULT_CRITIC_CONFIG)
    expect(v.status).toBe('fail')
    expect(v.blocking).toBe(true)
  })

  test('lazniPadMode=off → staro ponašanje (istek je pad, bez ponovnog pokušaja)', () => {
    let n = 0
    const cfg = { ...DEFAULT_CRITIC_CONFIG, lazniPadMode: 'off' as const }
    const r = runChecks(plan, cfg, () => { n++; return ISTEK })
    expect(n).toBe(1)
    expect(judge(r, prazanScan as any, [], [], cfg).status).toBe('fail')
  })

  test('replay: potpis `tests<put>:` (bun ispisao samo zaglavlje) prepoznaje se kao istek', () => {
    expect(jeIstekRokaPotpis('test:.sustav/jezgra/tests/daemon-keeper-boot.test.ts:tests<put>:')).toBe(true)
    expect(jeIstekRokaPotpis('test:.sustav/jezgra/tests/x.test.ts:error: expect(received).toBe(expected)')).toBe(false)
    expect(jeIstekRokaPotpis('task:app/x$bun test tests/a.test.ts:tests<put>:')).toBe(false)
  })
})

// ─── K2/K3 okolina ───────────────────────────────────────────────────────────

describe('K2/K3 okolina (worktree bez ovisnosti, ENOSPC) = neprovjereno + dojava', () => {
  test('okolinaIzIzlaza: ENOSPC i bare paket bez node_modules; relativni import nije okolina', () => {
    const wt = stablo('wt-bez-nm')
    writeFileSync(join(wt, 'package.json'), '{}')
    mkdirSync(join(wt, 'src'), { recursive: true })
    const t = join(wt, 'src', 'TaskWebUI.ts')
    expect(okolinaIzIzlaza('error: ENOSPC: no space left on device, write', t)).toContain('ENOSPC')
    expect(okolinaIzIzlaza('error: Could not resolve: "zod". Maybe you need to "bun install"?', t)).toContain('node_modules')
    expect(okolinaIzIzlaza('error: Could not resolve: "./Nesto"', t)).toBeNull()
    expect(okolinaIzIzlaza('error: expect(received).toBe(expected)', t)).toBeNull()
  })

  test('uz nerazriješen paket i PRAVA greška u izlazu → nije okolina (pad ostaje)', () => {
    const wt = stablo('wt-mjesano')
    writeFileSync(join(wt, 'package.json'), '{}')
    const izlaz = 'error: Could not resolve: "zod". Maybe you need to "bun install"?\nerror: Expected ";" but found "x"\n    at src/TaskWebUI.ts:12:3'
    expect(okolinaIzIzlaza(izlaz, join(wt, 'TaskWebUI.ts'))).toBeNull()
  })

  test('stablo IMA node_modules, a paketa nema → pravi kvar (ovisnost nije upisana), ne okolina', () => {
    const wt = stablo('wt-s-nm')
    writeFileSync(join(wt, 'package.json'), '{}')
    mkdirSync(join(wt, 'node_modules'), { recursive: true })
    expect(okolinaIzIzlaza('error: Could not resolve: "zod". Maybe you need to "bun install"?', join(wt, 'x.ts'))).toBeNull()
  })

  test('TASK-5509: worktree bez node_modules posudi ga iz matičnog stabla za vrijeme suda, pa ga makne', () => {
    const glavno = stablo('glavno-5509')
    mkdirSync(join(glavno, '.git', 'worktrees', 'wt'), { recursive: true })
    mkdirSync(join(glavno, 'node_modules', 'zod'), { recursive: true })
    const wt = stablo('wt-posudba')
    writeFileSync(join(wt, '.git'), `gitdir: ${join(glavno, '.git', 'worktrees', 'wt')}\n`)
    writeFileSync(join(wt, 'package.json'), '{}')
    writeFileSync(join(wt, 'tests', 'posta-ulaz.test.ts'), 'test("p", () => {})\n')
    const t = transkript(join(TMP, 'tr-posudba', 's.jsonl'), wt, [{ name: 'Write', input: { file_path: join(wt, 'tests', 'posta-ulaz.test.ts') } }])
    const vidjeno: boolean[] = []
    const runner = (c: PlannedCheck): RunOutput => {
      const ima = existsSync(join(wt, 'node_modules', 'zod'))
      vidjeno.push(ima)
      return ima ? OK : { exitCode: 1, stdout: '', stderr: 'error: expect(received).toEqual(expected)', timedOut: false }
    }
    const o = critiqueSpawn({
      taskId: 'TASK-K2P', agentId: 'jelena', sinceMs: Date.now() - 60_000, live: true, transcripts: [t],
      extraRoots: [{ path: wt, sinceMs: Date.now() - 60_000, vlastiti: true }],
    }, cfgZa(join(TMP, 'prazno-k2p')), runner)
    expect(vidjeno.length).toBeGreaterThan(0)
    expect(vidjeno.every(Boolean)).toBe(true)
    expect(o.verdict.status).toBe('pass')
    expect(existsSync(join(wt, 'node_modules'))).toBe(false)
    expect(o.verdict.notes.join(' ')).toContain('posuđen node_modules')
  })

  test('TASK-5509: parse TaskWebUI.ts u worktreeju bez node_modules → unverifiable, ne CRITIC_FAILED', () => {
    const wt = stablo('wt-5509')
    writeFileSync(join(wt, 'package.json'), '{}')
    mkdirSync(join(wt, 'src'), { recursive: true })
    writeFileSync(join(wt, 'src', 'TaskWebUI.ts'), "import { z } from 'zod'\nexport const a = z\n")
    const t = transkript(join(TMP, 'tr-5509', 's.jsonl'), wt, [{ name: 'Edit', input: { file_path: join(wt, 'src', 'TaskWebUI.ts') } }])
    const runner = (c: PlannedCheck): RunOutput => c.target.endsWith('TaskWebUI.ts')
      ? { exitCode: 1, stdout: '', stderr: 'error: Could not resolve: "zod". Maybe you need to "bun install"?', timedOut: false }
      : OK
    const o = critiqueSpawn({ taskId: 'TASK-K2', agentId: 'jelena', sinceMs: Date.now() - 60_000, live: true, transcripts: [t] }, cfgZa(wt), runner)
    expect(o.verdict.status).toBe('unverifiable')
    expect(o.enforce).toBe(false)
    expect(o.reasons.join(' ')).toContain('OKOLINA')
  })

  test('ENOSPC u vlastitom testu (i „Unhandled error between tests" s ENOSPC u izlazu) → unverifiable', () => {
    const r1 = res({ errorLine: 'error: ENOSPC: no space left on device, write', okolina: 'ENOSPC' } as any)
    const v = judge([r1], prazanScan as any, [], [], DEFAULT_CRITIC_CONFIG)
    expect(v.status).toBe('unverifiable')
    const root = stablo('k3-unhandled')
    writeFileSync(join(root, 'tests', 'a.test.ts'), 'test("a", () => {})\n')
    const t = transkript(join(TMP, 'tr-k3', 's.jsonl'), root, [{ name: 'Write', input: { file_path: join(root, 'tests', 'a.test.ts') } }])
    const runner = (): RunOutput => ({ exitCode: 1, stdout: '# Unhandled error between tests\nerror: ENOSPC: no space left on device, write', stderr: '', timedOut: false })
    const o = critiqueSpawn({ taskId: 'TASK-K3', agentId: 'jelena', sinceMs: Date.now() - 60_000, live: true, transcripts: [t], diskNizak: () => true }, cfgZa(root), runner)
    expect(o.verdict.status).toBe('unverifiable')
  })

  test('diskNizak: prag 5 % / 512 MiB po statfs; nepostojeći put se penje do postojećeg', () => {
    // Sud ovisi o stvarnom disku (glavni stroj je 21.10.2026. bio na 97 % → „pun"), pa se
    // očekivanje računa iz istog statfs-a, a ne pretpostavlja prazan disk.
    const s = statfsSync(TMP)
    const slobodno = Number(s.bavail) * Number(s.bsize), ukupno = Number(s.blocks) * Number(s.bsize)
    const pun = slobodno / ukupno < 0.05 || (ukupno >= 10 * 1024 ** 3 && slobodno < 512 * 1024 ** 2)
    expect(diskNizak(TMP)).toBe(pun)
    expect(diskNizak(join(TMP, 'nema', 'ovoga.ts'))).toBe(pun)
  })

  test('ENOSPC u izlazu VLASTITOG testa, a disk NIJE pun → ostaje pad (tekst ispisa nije dokaz okoline)', () => {
    const root = stablo('k3-lazni-enospc')
    writeFileSync(join(root, 'tests', 'c.test.ts'), 'test("c", () => {})\n')
    const t = transkript(join(TMP, 'tr-k3e', 's.jsonl'), root, [{ name: 'Write', input: { file_path: join(root, 'tests', 'c.test.ts') } }])
    const runner = (c: PlannedCheck): RunOutput => c.kind === 'test'
      ? { exitCode: 1, stdout: 'error: ENOSPC: no space left on device, write', stderr: '', timedOut: false } : OK
    const o = critiqueSpawn({ taskId: 'TASK-K3E', agentId: 'jelena', sinceMs: Date.now() - 60_000, live: true, transcripts: [t], diskNizak: () => false }, cfgZa(root), runner)
    expect(o.verdict.status).toBe('fail')
    expect(o.enforce).toBe(true)
  })

  test('„Unhandled error between tests" BEZ okolinskog uzroka u vlastitom testu ostaje pad', () => {
    const root = stablo('k3-pravi')
    writeFileSync(join(root, 'tests', 'b.test.ts'), "import '../Nema'\n")
    const t = transkript(join(TMP, 'tr-k3p', 's.jsonl'), root, [{ name: 'Write', input: { file_path: join(root, 'tests', 'b.test.ts') } }])
    const runner = (c: PlannedCheck): RunOutput => c.kind === 'test'
      ? { exitCode: 1, stdout: '# Unhandled error between tests\nerror: Cannot find module "../Nema"', stderr: '', timedOut: false }
      : OK
    const o = critiqueSpawn({ taskId: 'TASK-K3P', agentId: 'jelena', sinceMs: Date.now() - 60_000, live: true, transcripts: [t] }, cfgZa(root), runner)
    expect(o.verdict.status).toBe('fail')
    expect(o.enforce).toBe(true)
  })
})

// ─── K4 isti tuđi pad na više zadataka ───────────────────────────────────────

describe('K4 isti tuđi pad na ≥2 zadatka = zatečen + JEDAN zadatak popravka', () => {
  const SIG = 'test:.sustav/jezgra/tests/trajna-sesija-spawn.test.ts:error: expect(received).toEqual(expected)'
  const sad = Date.parse('2026-10-19T23:33:30Z')
  const rows: LedgerZapis[] = [
    { ts: '2026-10-19T22:59:00Z', taskId: 'TASK-5623', status: 'pass', signatures: [] },
    { ts: '2026-10-19T23:32:00Z', taskId: 'TASK-5615', status: 'fail', signatures: [SIG] },
  ]

  test('drugi zadatak pao s istim potpisom u prozoru, ovaj nije dirao → zatečen (5623 nakon 5615)', () => {
    const z = jeVisestrukiTudjiPad({ signature: SIG, taskId: 'TASK-5623', rows, nowMs: sad, prozorMs: 24 * 3600_000, dirao: false })
    expect(z.zatecen).toBe(true)
    expect(z.zadaci).toEqual(['TASK-5615'])
  })

  test('ovaj ga JE dirao → nije zatečen (5615 je stvarno pokvario test — mora ostati blokiran)', () => {
    expect(jeVisestrukiTudjiPad({ signature: SIG, taskId: 'TASK-5615', rows: [], nowMs: sad, prozorMs: 86_400_000, dirao: true }).zatecen).toBe(false)
    expect(jeVisestrukiTudjiPad({ signature: SIG, taskId: 'TASK-5623', rows, nowMs: sad, prozorMs: 86_400_000, dirao: true }).zatecen).toBe(false)
  })

  test('ovaj je zadatak VEĆ pao s istim potpisom (krug popravka) → nije zatečen', () => {
    const r2 = [...rows, { ts: '2026-10-19T23:20:00Z', taskId: 'TASK-5623', status: 'fail', signatures: [SIG] }]
    expect(jeVisestrukiTudjiPad({ signature: SIG, taskId: 'TASK-5623', rows: r2, nowMs: sad, prozorMs: 86_400_000, dirao: false }).zatecen).toBe(false)
  })

  test('krivac je dirao MODUL koji test uvozi (ne sam test) → diraoTest kaže da, pad ostaje njegov', () => {
    const root = stablo('k4-modul')
    writeFileSync(join(root, 'Modul.ts'), 'export const m = 1\n')
    writeFileSync(join(root, 'tests', 'm.test.ts'), "import { m } from '../Modul'\n")
    const atrib = { izvori: ['x'], pisano: new Set([join(root, 'Modul.ts')]), bash: [] }
    expect(diraoTest(join(root, 'tests', 'm.test.ts'), atrib, '')).toBe(true)
    expect(diraoTest(join(root, 'tests', 'm.test.ts'), null, 'promijenila sam Modul.ts')).toBe(true)
    expect(diraoTest(join(root, 'tests', 'm.test.ts'), { izvori: ['x'], pisano: new Set([join(root, 'Drugo.ts')]), bash: [] }, '')).toBe(false)
  })

  test('izvan prozora ili drukčiji potpis → nije zatečen', () => {
    expect(jeVisestrukiTudjiPad({ signature: SIG, taskId: 'TASK-5623', rows, nowMs: sad + 30 * 3600_000, prozorMs: 24 * 3600_000, dirao: false }).zatecen).toBe(false)
    expect(jeVisestrukiTudjiPad({ signature: SIG + 'x', taskId: 'TASK-5623', rows, nowMs: sad, prozorMs: 86_400_000, dirao: false }).zatecen).toBe(false)
  })

  test('potpisi iz različitih worktreejeva istog repozitorija se poklapaju (posta-ulaz 5367/5371/5509)', () => {
    const a = 'test:app/.regoc-worktrees/TaskManagerAI/TASK-5367__jelena__1791467895652/tests/posta-ulaz.test.ts:error: expect(received).toEqual(expected)'
    const b = 'test:app/.regoc-worktrees/TaskManagerAI/TASK-5509__jelena__1791976374350/tests/posta-ulaz.test.ts:error: expect(received).toEqual(expected)'
    expect(normalizirajPotpis(a)).toBe(normalizirajPotpis(b))
    expect(normalizirajPotpis(a)).toContain('wt:TaskManagerAI/tests/posta-ulaz.test.ts')
  })

  test('zatečeni (zateceniSig) drugog zadatka NIJE dokaz — broje se samo stvarni padovi', () => {
    const r = [{ ts: '2026-10-19T23:32:00Z', taskId: 'TASK-B', status: 'pass', signatures: [], zateceniSig: [SIG] }]
    expect(jeVisestrukiTudjiPad({ signature: SIG, taskId: 'TASK-C', rows: r, nowMs: sad, prozorMs: 86_400_000, dirao: false }).zatecen).toBe(false)
  })

  test('bez transkripta git odlučuje: commit s ID-om OVOG zadatka ili neuvrštena izmjena = dirao; tuđi commit = nije', () => {
    const repo = stablo('k4-git')
    const g = (...a: string[]) => Bun.spawnSync(['git', '-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a])
    g('init', '-q')
    const testPut = join(repo, 'tests', 'g.test.ts')
    writeFileSync(testPut, 'test("g", () => {})\n')
    g('add', '-A'); g('commit', '-q', '-m', 'TASK-KRIVAC: pokvarila sam test')
    const since = Date.now() - 3600_000
    expect(gitDirao(testPut, 'TASK-NEDUZAN', since)).toBe(false)
    expect(gitDirao(testPut, 'TASK-KRIVAC', since)).toBe(true)
    expect(diraoTest(testPut, null, '', { taskId: 'TASK-NEDUZAN', sinceMs: since })).toBe(false)
    expect(diraoTest(testPut, null, '', { taskId: 'TASK-KRIVAC', sinceMs: since })).toBe(true)
    writeFileSync(testPut, 'test("g2", () => {})\n')
    expect(gitDirao(testPut, 'TASK-NEDUZAN', since)).toBe(true)   // neuvršteno: ne zna se čije → fail-closed
    expect(gitDirao(join(TMP, 'nije-u-gitu.ts'), 'TASK-X', since)).toBeNull()
  })

  test('spominjeIzvjestaj: ime datoteke kao riječ', () => {
    expect(spominjeIzvjestaj('/h/.sustav/jezgra/tests/trajna-sesija-spawn.test.ts', 'popravila sam tests/trajna-sesija-spawn.test.ts')).toBe(true)
    expect(spominjeIzvjestaj('/h/.sustav/jezgra/tests/trajna-sesija-spawn.test.ts', 'ništa o tome')).toBe(false)
  })

  function slucaj(ime: string, resultText: string, prijave: any[]) {
    const root = stablo(ime)
    const testPut = join(root, 'tests', 'trajna.test.ts')
    writeFileSync(testPut, 'test("t", () => {})\n')
    const pao: CheckResult = res({ target: testPut, cmd: ['bun', 'test', testPut], cwd: root })
    const sinceMs = Date.now() - 60 * 60_000
    writeFileSync(LEDGER, [
      { ts: new Date(sinceMs - 60_000).toISOString(), taskId: 'TASK-K4', status: 'pass', signatures: [] },
      { ts: new Date(Date.now() - 5 * 60_000).toISOString(), taskId: 'TASK-KRIVAC', status: 'fail', signatures: [failureSignature(pao)] },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n')
    const runner = (c: PlannedCheck): RunOutput => c.kind === 'test'
      ? { exitCode: 1, stdout: '', stderr: 'error: expect(received).toBe(expected)', timedOut: false } : OK
    // Bez transkripta (put zahtjeva zatvaranja): atribucija nedostupna, kao 5623/5625/5626.
    return critiqueSpawn({ taskId: 'TASK-K4', agentId: 'potjeh', sinceMs, live: true, resultText, prijaviPopravakTesta: (z) => prijave.push(z) }, cfgZa(root), runner)
  }

  test('critiqueSpawn bez transkripta, izvještaj ne spominje test → pass uz napomenu + jedna prijava popravka', () => {
    const prijave: any[] = []
    const o = slucaj('k4-tudji', 'Napravila sam X.', prijave)
    expect(o.verdict.status).toBe('pass')
    expect(o.enforce).toBe(false)
    expect(o.verdict.notes.join(' ')).toContain('zatečen')
    expect(prijave.length).toBe(1)
    expect(prijave[0].zadaci).toContain('TASK-KRIVAC')
    const red = readFileSync(LEDGER, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)).pop()
    expect(red.zateceniSig.length).toBe(1)
  })

  test('izvještaj spominje taj test → fail-closed (pad ostaje)', () => {
    const prijave: any[] = []
    const o = slucaj('k4-spomenut', 'Dorađen tests/trajna.test.ts.', prijave)
    expect(o.verdict.status).toBe('fail')
    expect(prijave.length).toBe(0)
  })
})

// ─── K5 snimke pod docs/architecture ─────────────────────────────────────────

describe('K5 snimke koda pod docs/architecture/**', () => {
  test('docs/architecture/<zadatak>/*.ts je snimka (TASK-5259, 5414)', () => {
    expect(jeSnimkaKoda('/home/korisnik/app/sustav_repo/docs/architecture/pozadina_povrat_5259/pozadina-povrat.test.ts')).toBe(true)
    expect(jeSnimkaKoda('/home/korisnik/app/sustav_repo/docs/architecture/radna_mapa_5414/tmp-okolina.test.ts')).toBe(true)
    expect(jeSnimkaKoda('/home/korisnik/.sustav/jezgra/architecture/Pravi.ts')).toBe(false)
  })
})

// ─── Replay i konfiguracija ──────────────────────────────────────────────────

describe('replay i konfiguracija', () => {
  test('replay K5: obrisana snimka pod docs/ s relativnim „Could not resolve" (TASK-5107) otpada, i njezin test', () => {
    const row: LedgerZapis = { ts: '2026-10-01T23:52:00Z', taskId: 'TASK-5107', status: 'fail', signatures: [
      'parse:app/sustav_repo/docs/katalog/adr0016_kod/nema-me.test.ts:error: Could not resolve: "../TaskToolkit"',
      'test:app/sustav_repo/docs/katalog/adr0016_kod/nema-me.test.ts:# Unhandled error between tests',
    ] }
    const atrib = { izvori: ['x'], pisano: new Set([join(HOME, 'app/sustav_repo/docs/katalog/adr0016_kod/nema-me.test.ts')]), bash: [] }
    const p = presudiZapisReplay(row, atrib, [], HOME)
    expect(p.novo).toBe('pass')
    expect(p.otpalo.every((o) => o.razlog === 'snimka-koda')).toBe(true)
  })

  test('lazniPadMode: zadano on, tipfeler pada na on; timeoutRetryMs i visestrukiProzorH imaju zadano', () => {
    const p = join(TMP, 'cfg.json')
    writeFileSync(p, JSON.stringify({ lazniPadMode: 'ukljuceno' }))
    const c = loadCriticConfig(p, true)
    expect(c.lazniPadMode).toBe('on')
    expect(DEFAULT_CRITIC_CONFIG.timeoutRetryMs).toBeGreaterThan(DEFAULT_CRITIC_CONFIG.perCheckTimeoutMs)
    expect(DEFAULT_CRITIC_CONFIG.visestrukiProzorH).toBeGreaterThan(0)
  })

  test('presudiZapisReplay: istek, ENOSPC, worktree bez ovisnosti i docs/architecture otpadaju; pravi pad ostaje', () => {
    const row: LedgerZapis = {
      ts: '2026-10-20T20:35:58Z', taskId: 'TASK-5654', status: 'fail', signatures: [
        'test:.sustav/jezgra/tests/daemon-keeper-boot.test.ts:tests<put>:',
        'test:.sustav/jezgra/tests/samorestart-brana.test.ts:error: ENOSPC: no space left on device, write',
        'parse:app/.regoc-worktrees/TaskManagerAI/TASK-9999__jelena__1/src/TaskWebUI.ts:error: Could not resolve: "zod". Maybe you need to "bun install"?',
        'parse:app/sustav_repo/docs/architecture/radna_mapa_5414/tmp-okolina.test.ts:error: Could not resolve: "../TmpOkolina"',
        'test:.sustav/jezgra/tests/pravi.test.ts:error: expect(received).toBe(expected)',
      ],
    }
    const atrib = { izvori: ['x'], pisano: new Set([join(HOME, '.sustav/jezgra/tests/pravi.test.ts'), join(HOME, '.sustav/jezgra/tests/daemon-keeper-boot.test.ts'), join(HOME, '.sustav/jezgra/tests/samorestart-brana.test.ts'), join(HOME, 'app/.regoc-worktrees/TaskManagerAI/TASK-9999__jelena__1/src/TaskWebUI.ts')]), bash: [] }
    const p = presudiZapisReplay(row, atrib, [], HOME)
    expect(p.novo).toBe('fail')
    expect(p.zadrzano).toEqual(['test:.sustav/jezgra/tests/pravi.test.ts:error: expect(received).toBe(expected)'])
    const razlozi = p.otpalo.map((o) => o.razlog).sort()
    expect(razlozi).toEqual(['istek-roka', 'okolina', 'okolina', 'snimka-koda'])
  })
})
