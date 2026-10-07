// TASK-5308 — kuka konzole ploče `hooks/RegocConsoleLog.hook.ts` (ADR-0004 §13.2.3, izvor `regoc`).
// Pokreće se kao pravi proces (kao što ga pokreće Claude Code), s privremenim HOME-om.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const KUKA = join(import.meta.dir, '..', 'hooks', 'RegocConsoleLog.hook.ts')
let home: string

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tmai-konzola-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

async function pokreni(dogadjaj: unknown, env: Record<string, string> = {}): Promise<number> {
  const p = Bun.spawn(['bun', 'run', KUKA], {
    stdin: new Blob([typeof dogadjaj === 'string' ? dogadjaj : JSON.stringify(dogadjaj)]),
    stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env.PATH || '', HOME: home, ...env },
  })
  return p.exited
}
const log = () => join(home, '.tmp', 'regoc_logs', 'regoc.log')

describe('RegocConsoleLog — rad agenta u konzoli ploče', () => {
  test('agent daemona: redak nosi agenta i zadatak, opis naredbe, u $HOME/.tmp/regoc_logs/regoc.log', async () => {
    const kod = await pokreni({ tool_name: 'Bash', tool_input: { command: 'bun test', description: 'Pokreni testove' } },
      { REGOC_AGENT_ID: 'inzenjer', REGOC_TASK_ID: 'TASK-7' })
    expect(kod).toBe(0)
    const t = readFileSync(log(), 'utf-8')
    expect(t).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] ⚙️ inzenjer · TASK-7 · Bash: Pokreni testove\n$/)
  })

  test('ručna sesija bez agenta: oznaka „sesija"', async () => {
    await pokreni({ tool_name: 'Write', tool_input: { file_path: '/x/y.ts', content: 'TAJNA-NE-SMIJE-VAN' } })
    const t = readFileSync(log(), 'utf-8')
    expect(t).toContain('⚙️ sesija · Write: pišem /x/y.ts')
    expect(t).not.toContain('TAJNA-NE-SMIJE-VAN')      // sadržaj datoteke se nikad ne zapisuje
  })

  test('čitanje (Read) se ne zapisuje; smeće na ulazu → izlaz 0 bez zapisa', async () => {
    expect(await pokreni({ tool_name: 'Read', tool_input: { file_path: '/x' } })).toBe(0)
    expect(await pokreni('nije json')).toBe(0)
    expect(existsSync(log())).toBe(false)
  })
})
