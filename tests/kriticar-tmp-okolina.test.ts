/**
 * TASK-5618 (prijenos TASK-5336/5338 glavnog sustava): naredbe kritičara ne nasljeđuju TMPDIR
 * u /tmp. Na glavnom je /tmp tmpfs od 100 MB; 07.10.2026. bio je pun i kritičar je rušio
 * zadatke s ENOSPC umjesto zbog pravih kvarova. Svaka naredba suda dobiva mapu
 * <TM_TMP_ROOT|TM_HOME/tmp>/ispitno/kriticar/<taskId>, koja se nakon suda briše.
 */
import { describe, test, expect, afterAll } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { tmpKorijen, tmpMapaKriticara, tmpOkolina, pocistiTmp } from '../src/core/TmpOkolina'
import { critiqueSpawnAsync, realRunnerAsync, type PlannedCheck } from '../src/core/CriticGate'

// Ispitni korijen izvan /tmp (inače bi test sam sebe zavaravao).
const BAZA = join(process.env.HOME || tmpdir(), 'app', 'tmp', 'ispitno')
mkdirSync(BAZA, { recursive: true })
const KORIJEN = mkdtempSync(join(BAZA, 'tm-tmp-okolina-'))
afterAll(() => rmSync(KORIJEN, { recursive: true, force: true }))

describe('TmpOkolina — putanje i okolina', () => {
  test('TM_TMP_ROOT nadjačava zadani korijen', () => {
    expect(tmpKorijen({ TM_TMP_ROOT: '/drugo' })).toBe('/drugo')
    expect(tmpKorijen({}).endsWith('/tmp')).toBe(true)
  })

  test('kritičar: <korijen>/ispitno/kriticar/<taskId>; ID s .. ne izlazi iz korijena', () => {
    expect(tmpMapaKriticara('TASK-1', KORIJEN)).toBe(join(KORIJEN, 'ispitno', 'kriticar', 'TASK-1'))
    expect(tmpMapaKriticara(null, KORIJEN)).toBe(join(KORIJEN, 'ispitno', 'kriticar', 'bez-zadatka'))
    expect(tmpMapaKriticara('a/../../b', KORIJEN).startsWith(join(KORIJEN, 'ispitno', 'kriticar') + '/')).toBe(true)
  })

  test('tmpOkolina stvara mapu i vraća TMPDIR/BUN_TMPDIR/TMP/TEMP; nemoguća mapa → {}', () => {
    const d = join(KORIJEN, 'ispitno', 'kriticar', 'TASK-X')
    const env = tmpOkolina(d, KORIJEN)
    expect(existsSync(d)).toBe(true)
    for (const k of ['TMPDIR', 'BUN_TMPDIR', 'TMP', 'TEMP']) expect(env[k]).toBe(d)
    expect(tmpOkolina('/proc/nemoguce/tmp', KORIJEN)).toEqual({})
  })

  test('pocistiTmp briše samo unutar korijena', () => {
    const d = join(KORIJEN, 'ispitno', 'kriticar', 'T')
    tmpOkolina(d, KORIJEN)
    expect(pocistiTmp(d, KORIJEN)).toBe(true)
    expect(existsSync(d)).toBe(false)
    expect(pocistiTmp('/etc', KORIJEN)).toBe(false)
    expect(pocistiTmp(KORIJEN, KORIJEN)).toBe(false)
  })
})

describe('Kritičar — provjere se vrte s TMPDIR izvan /tmp (brana)', () => {
  test('izvršitelj predaje TMPDIR iz provjere procesu', async () => {
    const d = join(KORIJEN, 'ispitno', 'kriticar', 'TASK-R')
    const check: PlannedCheck = {
      kind: 'task', target: KORIJEN, cwd: KORIJEN, tmpDir: d,
      cmd: ['bun', '-e', 'console.log(require("os").tmpdir() + "|" + process.env.BUN_TMPDIR)'],
    }
    const out = await realRunnerAsync(check, 20_000)
    expect(out.exitCode).toBe(0)
    expect(out.stdout.trim()).toBe(`${d}|${d}`)
  })

  // TASK-5338: obrana u dubinu — roditelj (daemon iz keepera `env -i`) bez TMPDIR, a provjera
  // bez tmpDir (izravan poziv izvršitelja) → i dalje NE /tmp.
  for (const naslijedeno of [undefined, '/tmp', '/tmp/x']) {
    test(`provjera bez tmpDir, roditeljev TMPDIR=${naslijedeno ?? '(nema)'} → mapa kritičara izvan /tmp`, async () => {
      const staro = { TMPDIR: process.env.TMPDIR, BUN_TMPDIR: process.env.BUN_TMPDIR, R: process.env.TM_TMP_ROOT }
      if (naslijedeno) process.env.TMPDIR = naslijedeno; else delete process.env.TMPDIR
      delete process.env.BUN_TMPDIR
      process.env.TM_TMP_ROOT = KORIJEN
      try {
        const check: PlannedCheck = {
          kind: 'task', target: KORIJEN, cwd: KORIJEN,
          cmd: ['bun', '-e', 'console.log(require("os").tmpdir())'],
        }
        const out = await realRunnerAsync(check, 20_000)
        expect(out.exitCode).toBe(0)
        expect(out.stdout.trim()).toBe(join(KORIJEN, 'ispitno', 'kriticar', 'bez-zadatka'))
      } finally {
        for (const [k, v] of [['TMPDIR', staro.TMPDIR], ['BUN_TMPDIR', staro.BUN_TMPDIR], ['TM_TMP_ROOT', staro.R]] as const) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v
        }
      }
    })
  }

  test('provjera bez tmpDir uz ispravan naslijeđeni TMPDIR → ostaje naslijeđeni (ne dira se)', async () => {
    const d = join(KORIJEN, 'naslijedeno')
    const { mkdirSync } = await import('fs')
    mkdirSync(d, { recursive: true })
    const staro = process.env.TMPDIR
    process.env.TMPDIR = d
    try {
      const out = await realRunnerAsync({ kind: 'task', target: KORIJEN, cwd: KORIJEN,
        cmd: ['bun', '-e', 'console.log(require("os").tmpdir())'] }, 20_000)
      expect(out.stdout.trim()).toBe(d)
    } finally {
      if (staro === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = staro
    }
  })

  test('cijeli sud: `bun test` s mkdtemp ne ostavlja ništa novo u /tmp, a mapa kritičara se počisti', async () => {
    const prije = new Set(readdirSync('/tmp'))
    const opisZadatka = '[PROVJERA] cmd: bun test tests/curi.test.ts'
    const stablo = join(KORIJEN, 'stablo')
    const { mkdirSync, writeFileSync } = await import('fs')
    mkdirSync(join(stablo, 'tests'), { recursive: true })
    // Namjerno „curi": mkdtemp bez čišćenja — točno obrazac koji je punio /tmp.
    writeFileSync(join(stablo, 'tests', 'curi.test.ts'),
      "import { test, expect } from 'bun:test'\nimport { mkdtempSync } from 'fs'\nimport { join } from 'path'\nimport { tmpdir } from 'os'\n"
      + "test('curi', () => { expect(mkdtempSync(join(tmpdir(), 'tmp5336-curi-')).startsWith('/tmp')).toBe(false) })\n")
    const { parseDeclaredChecks } = await import('../src/core/CriticGate')
    const ishod = await critiqueSpawnAsync({
      taskId: 'TASK-5336-PROBA', agentId: 'inzenjer', sinceMs: Date.now() - 1000, live: false,
      declared: parseDeclaredChecks(opisZadatka), rootDir: stablo, taskDescription: opisZadatka,
      tmpRoot: KORIJEN,
    } as any)
    const zadatak = ishod.verdict.checks.find(c => c.kind === 'task')
    expect(zadatak?.ok).toBe(true)
    const novo = readdirSync('/tmp').filter(n => !prije.has(n) && n.startsWith('tmp5336'))
    expect(novo).toEqual([])
    expect(existsSync(join(KORIJEN, 'ispitno', 'kriticar', 'TASK-5336-PROBA'))).toBe(false)
  }, 60_000)
})
