/**
 * Kritičar sudi u STABLU ZADATKA, a nula izvedenih testova nije pad (TASK-5674, 21.10.2026.)
 *
 * Kvar: TASK-5657 je drugi put pao na kritičaru s „bun test tests/install-sh.test.ts …
 * The following filters did not match any test files" (3/3). Prvi spawn je dobio worktree
 * (collision) i ostavio rad u njemu (preserved); ponovni spawn istog zadatka dobio je
 * „shared (solo)" = glavno stablo repozitorija, pa je kritičar propisane provjere pokrenuo
 * na grani main, gdje testova još nema. Pad bez ijednog izvedenog testa → CRITIC_FAILED.
 *   (a) ponovni spawn zadatka nastavlja u SAČUVANOM worktreeju tog zadatka → `cwd` spawna
 *       i korijen propisanih provjera kritičara je to stablo (sacuvaniWorktreeZadatka);
 *   (b) „filters did not match any test files" / „Ran 0 tests" = 0 izvedenih testova →
 *       neprovjereno (okolina), NIKAD fail protiv izvođača.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { okolinaIzIzlaza } from '../src/core/KriticarOpseg'
import {
  DEFAULT_CRITIC_CONFIG,
  critiqueSpawn,
  parseDeclaredChecks,
  type CriticConfig,
  type PlannedCheck,
  type RunOutput,
} from '../src/core/CriticGate'

const HOME = process.env.HOME || '/home/korisnik'
let TMP = ''
const stariLedger = process.env.REGOC_CRITIC_LEDGER

beforeAll(() => {
  mkdirSync(join(HOME, '.tmp'), { recursive: true })
  TMP = mkdtempSync(join(HOME, '.tmp', 'kriticar-stablo-'))
  process.env.REGOC_CRITIC_LEDGER = join(TMP, 'ledger.jsonl')
})
afterAll(() => {
  if (stariLedger === undefined) delete process.env.REGOC_CRITIC_LEDGER
  else process.env.REGOC_CRITIC_LEDGER = stariLedger
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
})

const NEMA_TESTA = 'bun test v1.3.6 (d530ed99)\nThe following filters did not match any test files in --cwd="/home/korisnik/app/TaskManager/TaskManagerAI":\n tests/install-sh.test.ts\n3 files were searched [20.00ms]\n'

function cfgZa(root: string, over: Partial<CriticConfig> = {}): CriticConfig {
  return { ...DEFAULT_CRITIC_CONFIG, watchRoots: [root], docMode: 'off', doc2Mode: 'off', ...over } as CriticConfig
}

// ─── (b) nula izvedenih testova ──────────────────────────────────────────────

describe('(b) 0 izvedenih testova = neprovjereno, ne pad', () => {
  test('okolinaIzIzlaza prepoznaje „filters did not match any test files"', () => {
    const r = okolinaIzIzlaza(NEMA_TESTA, '/x/_')
    expect(r).not.toBeNull()
    expect(r!).toContain('0 izvedenih testova')
  })

  test('„Ran 0 tests" bez ijednog pada je okolina; stvarni pad s „1 fail" nije', () => {
    expect(okolinaIzIzlaza(' 0 pass\n 0 fail\nRan 0 tests across 1 file. [31.00ms]', '/x/_')).toContain('0 izvedenih testova')
    expect(okolinaIzIzlaza(' 2 pass\n 1 fail\nRan 3 tests across 1 file.', '/x/_')).toBeNull()
    expect(okolinaIzIzlaza('error: expect(received).toBe(expected)\n 0 pass\n 1 fail\nRan 1 test', '/x/_')).toBeNull()
  })

  test('propisana provjera koja nije našla test (TASK-5657 ×3) → unverifiable, enforce=false', () => {
    const root = join(TMP, 'main-bez-testova')
    mkdirSync(join(root, 'tests'), { recursive: true })
    const opis = '[PROVJERA] cmd: bun test tests/install-sh.test.ts\n[PROVJERA] cmd: bun test tests/deinstalacija-do-nule.test.ts'
    const cfg = cfgZa(root)
    const declared = parseDeclaredChecks(opis, cfg)
    expect(declared.checks.length).toBe(2)
    const runner = (c: PlannedCheck): RunOutput => c.kind === 'task'
      ? { exitCode: 1, stdout: '', stderr: NEMA_TESTA, timedOut: false }
      : { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    const o = critiqueSpawn({ taskId: 'TASK-B0', agentId: 'jelena', sinceMs: Date.now() - 60_000, live: true, declared, rootDir: root }, cfg, runner)
    expect(o.verdict.status).toBe('unverifiable')
    expect(o.enforce).toBe(false)
    expect(o.verdict.failed.length).toBe(0)
    expect(o.reasons.join(' ')).toContain('0 izvedenih testova')
  })

  test('propisani bun test koji je PROŠAO s „Ran 0 tests" nije dokaz → unverifiable, ne pass', () => {
    const root = join(TMP, 'nula-prolaz')
    mkdirSync(join(root, 'tests'), { recursive: true })
    const cfg = cfgZa(root)
    const declared = parseDeclaredChecks('[PROVJERA] cmd: bun test tests/prazan.test.ts', cfg)
    const runner = (c: PlannedCheck): RunOutput => c.kind === 'task'
      ? { exitCode: 0, stdout: ' 0 pass\n 0 fail\nRan 0 tests across 1 file. [31.00ms]', stderr: '', timedOut: false }
      : { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    const o = critiqueSpawn({ taskId: 'TASK-B1', agentId: 'jelena', sinceMs: Date.now() - 60_000, live: true, declared, rootDir: root }, cfg, runner)
    expect(o.verdict.status).toBe('unverifiable')
    expect(o.enforce).toBe(false)
  })

  test('sigurnost: test koji POSTOJI u stablu i sam ispiše „did not match…" uz exit 1 ostaje pad', () => {
    const root = join(TMP, 'lazna-poruka')
    mkdirSync(join(root, 'tests'), { recursive: true })
    writeFileSync(join(root, 'tests', 'zao.test.ts'), "test('z', () => {})\n")
    const cfg = cfgZa(root)
    const declared = parseDeclaredChecks('[PROVJERA] cmd: bun test tests/zao.test.ts', cfg)
    const runner = (c: PlannedCheck): RunOutput => c.kind === 'task'
      ? { exitCode: 1, stdout: NEMA_TESTA, stderr: '', timedOut: false }
      : { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    const o = critiqueSpawn({ taskId: 'TASK-B3', agentId: 'jelena', sinceMs: Date.now() - 60_000, live: true, declared, rootDir: root }, cfg, runner)
    expect(o.verdict.status).toBe('fail')
    expect(o.enforce).toBe(true)
  })

  test('pravi pad propisanog testa (izvedeni test pada) i dalje blokira', () => {
    const root = join(TMP, 'pravi-pad')
    mkdirSync(join(root, 'tests'), { recursive: true })
    const cfg = cfgZa(root)
    const declared = parseDeclaredChecks('[PROVJERA] cmd: bun test tests/a.test.ts', cfg)
    const runner = (c: PlannedCheck): RunOutput => c.kind === 'task'
      ? { exitCode: 1, stdout: '(fail) a > b\nerror: expect(received).toBe(expected)\n 0 pass\n 1 fail\nRan 1 test across 1 file.', stderr: '', timedOut: false }
      : { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    const o = critiqueSpawn({ taskId: 'TASK-B2', agentId: 'jelena', sinceMs: Date.now() - 60_000, live: true, declared, rootDir: root }, cfg, runner)
    expect(o.verdict.status).toBe('fail')
    expect(o.enforce).toBe(true)
  })
})

// ─── (a) stablo zadatka ──────────────────────────────────────────────────────

const gitAvailable = spawnSync('git', ['--version']).status === 0
const realGit = (args: string[], cwd: string) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

function makeRepo(name: string): string {
  const dir = join(TMP, name)
  mkdirSync(join(dir, 'tests'), { recursive: true })
  realGit(['init', '-q', '-b', 'main'], dir)
  realGit(['config', 'user.email', 'test@example.com'], dir)
  realGit(['config', 'user.name', 'Test'], dir)
  writeFileSync(join(dir, 'package.json'), '{}\n')
  writeFileSync(join(dir, 'tests', 'stari.test.ts'), "import { test, expect } from 'bun:test'\ntest('s', () => expect(1).toBe(1))\n")
  realGit(['add', '-A'], dir)
  realGit(['commit', '-qm', 'init'], dir)
  return dir
}

// Paket nema REGOČ-ov WorktreeIsolation (sačuvani worktree bira orkestrator domaćina, TASK-5674 (a));
// ovdje se drži ugovor kritičara: korijen propisanih provjera je stablo zadatka (`rootDir`).
describe.if(gitAvailable)('(a) kritičar sudi u stablu zadatka (rootDir), ne u glavnom stablu', () => {
  test('TASK-5657 replay: propisani test postoji samo u worktreeju — u main nije izveden, u worktreeju prolazi', () => {
    const repo = makeRepo('repo-5657')
    const wt = join(TMP, 'wt-5657', 'TASK-5657__jelena__1')
    realGit(['worktree', 'add', '-q', '-b', 'zadatak/TASK-5657', wt], repo)
    writeFileSync(join(wt, 'tests', 'install-sh.test.ts'), "import { test, expect } from 'bun:test'\ntest('i', () => expect(2).toBe(2))\n")
    realGit(['add', '-A'], wt)
    realGit(['commit', '-qm', 'TASK-5657: test'], wt)
    const stablo = { worktreePath: wt }

    const opis = '[PROVJERA] cmd: bun test tests/install-sh.test.ts'
    const krivo = critiqueSpawn({
      taskId: 'TASK-5657', agentId: 'jelena', sinceMs: Date.now() - 60_000, live: true,
      declared: parseDeclaredChecks(opis, cfgZa(repo)), rootDir: repo,
    }, cfgZa(repo))
    // Stari put (main): pravi bun, 0 izvedenih testova → neprovjereno, nikad fail.
    expect(krivo.verdict.status).toBe('unverifiable')
    expect(krivo.enforce).toBe(false)

    const pravo = critiqueSpawn({
      taskId: 'TASK-5657', agentId: 'jelena', sinceMs: Date.now() - 60_000, live: true,
      declared: parseDeclaredChecks(opis, cfgZa(stablo!.worktreePath)), rootDir: stablo!.worktreePath,
      extraRoots: [{ path: stablo!.worktreePath, sinceMs: Date.now(), vlastiti: true }],
    }, cfgZa(stablo!.worktreePath))
    const task = pravo.verdict.checks.filter((c) => c.kind === 'task')
    expect(task.length).toBe(1)
    expect(task[0].ok).toBe(true)
    expect(task[0].cwd).toBe(stablo!.worktreePath)
    expect(pravo.verdict.status).toBe('pass')
  })
})
