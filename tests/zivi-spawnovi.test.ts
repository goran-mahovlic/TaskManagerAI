// tests/zivi-spawnovi.test.ts — TASK-5323 (prijenos s glavnog, TASK-5029): značka živih spawnova
// i oznaka „BEZ PROCESA" na ploči paketa.
//
// „Aktivno" = živi spawnovi po NAJMOVIMA (pid provjeren kroz /proc), ne broj zadataka in_progress.
// Najmove piše daemon: paketov orkestrator u mapu stanja paketa, a izvorni sustav (komplet na
// čvoru) u svoju mapu, koju ploča dobiva kroz TM_IZVORNI_NAJMOVI. Izvor „najmovi" vrijedi SAMO kad bar jedna mapa
// postoji — inače nijedan daemon na stroju ne piše najmove i svaki in_progress bi lažno bio
// „bez procesa" (nalaz TASK-5311: node-A ih tada nije pisao).

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let sandbox: string
const najam = (taskId: string, pid: number, startedAt = new Date().toISOString()) =>
  JSON.stringify({ taskId, agent: 'jelena', pid, startedAt })

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'zivi-spawnovi-'))
  process.env.REGOC_SPAWN_LEASE_DIR = join(sandbox, 'paket')
})
afterEach(() => {
  delete process.env.REGOC_SPAWN_LEASE_DIR
  try { rmSync(sandbox, { recursive: true, force: true }) } catch {}
})

async function ucitaj() {
  return await import(`../src/core/TaskCloser.ts?t=${Date.now()}${Math.random()}`)
}

describe('ziviNajmovi', () => {
  test('broji samo najmove sa živim pidom, iz svih zadanih mapa, bez duplikata', async () => {
    const { ziviNajmovi } = await ucitaj()
    const a = join(sandbox, 'paket'), b = join(sandbox, 'izvorni')
    mkdirSync(a); mkdirSync(b)
    writeFileSync(join(a, 'TASK-1.json'), najam('TASK-1', process.pid))
    writeFileSync(join(b, 'TASK-2.json'), najam('TASK-2', process.pid))
    writeFileSync(join(b, 'TASK-1.json'), najam('TASK-1', process.pid))      // isti zadatak u obje
    writeFileSync(join(b, 'TASK-3.json'), najam('TASK-3', 2 ** 22 + 12345)) // mrtav pid
    writeFileSync(join(b, 'TASK-4.json'), najam('TASK-4', process.pid, '2000-01-01T00:00:00Z')) // prestar
    writeFileSync(join(b, 'smece.json'), '{ nije json')
    const n = ziviNajmovi(Date.now(), [a, b])
    expect(n.map((x: any) => x.taskId)).toEqual(['TASK-1', 'TASK-2'])
  })
  test('mapa koje nema → prazno, bez iznimke', async () => {
    const { ziviNajmovi } = await ucitaj()
    expect(ziviNajmovi(Date.now(), [join(sandbox, 'nema')])).toEqual([])
  })
})

describe('izvoriNajmova', () => {
  test('vraća samo mape koje postoje (paketova + TM_IZVORNI_NAJMOVI)', async () => {
    const { izvoriNajmova } = await ucitaj()
    const izv = join(sandbox, 'domacin', 'najmovi')
    expect(izvoriNajmova(izv)).toEqual([])
    mkdirSync(izv, { recursive: true })
    expect(izvoriNajmova(izv)).toEqual([izv])
    mkdirSync(join(sandbox, 'paket'))
    expect(izvoriNajmova(izv)).toEqual([join(sandbox, 'paket'), izv])
    expect(izvoriNajmova('')).toEqual([join(sandbox, 'paket')])
  })
  test('zadano čita TM_IZVORNI_NAJMOVI iz okoline', async () => {
    const { izvoriNajmova } = await ucitaj()
    const izv = join(sandbox, 'okolina')
    mkdirSync(izv)
    process.env.TM_IZVORNI_NAJMOVI = izv
    try { expect(izvoriNajmova()).toEqual([izv]) } finally { delete process.env.TM_IZVORNI_NAJMOVI }
  })
})

describe('stanjeSpawnova (payload /api/config/concurrency)', () => {
  test('bez ijedne mape najmova → izvor in_progress, bez popisa (ploča ne pokazuje BEZ PROCESA)', async () => {
    const { stanjeSpawnova } = await ucitaj()
    const s = stanjeSpawnova(3, [], () => [])
    expect(s).toEqual({ active: 3, activeSource: 'in_progress' })
  })
  test('s mapom najmova → aktivno = živi najmovi i popis za oznaku', async () => {
    const { stanjeSpawnova } = await ucitaj()
    const zivi = [{ taskId: 'TASK-9', agent: 'potjeh', pid: 42, startedAt: 'x' }]
    const s = stanjeSpawnova(2, ['/neka/mapa'], () => zivi)
    expect(s.active).toBe(1)
    expect(s.activeSource).toBe('najmovi')
    expect(s.liveSpawns).toEqual([{ taskId: 'TASK-9', agent: 'potjeh', pid: 42, startedAt: 'x' }])
  })
})
