// Pravi poslužitelj ploče nad praznom instalacijom u privremenom TM_HOME.
// init-db → TaskWebUI na slučajnom portu → čeka se prvi 200 na /api/tasks.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const KORIJEN = join(import.meta.dir, '..', '..')

export interface Posluzitelj { url: string; proc: ReturnType<typeof Bun.spawn>; dom: string; najmovi: string }

export async function podigni(zastavice: Record<string, boolean> = {}, dodatnaOkolina: Record<string, string> = {}): Promise<Posluzitelj> {
  const dom = mkdtempSync(join(tmpdir(), 'tm-e2e-'))
  const najmovi = join(dom, 'najmovi')
  mkdirSync(join(dom, 'config'), { recursive: true })
  const features: Record<string, { enabled: boolean }> = {}
  for (const [k, v] of Object.entries(zastavice)) features[k] = { enabled: v }
  writeFileSync(join(dom, 'config', 'features.json'), JSON.stringify(features))
  const env = {
    ...process.env, TM_HOME: dom, REGOC_SPAWN_LEASE_DIR: najmovi,
    NODE_ENV: 'production', BUN_TEST: '', ...dodatnaOkolina,
  }
  const init = Bun.spawnSync(['bun', 'scripts/init-db.ts'], { cwd: KORIJEN, env })
  if (init.exitCode !== 0) throw new Error(`init-db: ${init.stderr.toString()}`)
  const port = 20000 + Math.floor(Math.random() * 20000)
  const proc = Bun.spawn(['bun', 'src/TaskWebUI.ts'], {
    cwd: KORIJEN, env: { ...env, TM_PORT: String(port), REGOC_TASKWEBUI_PORT: String(port) },
    stdout: 'ignore', stderr: 'ignore',
  })
  const url = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${url}/api/tasks`)).ok) return { url, proc, dom, najmovi } } catch { /* još se diže */ }
    await Bun.sleep(100)
  }
  proc.kill()
  throw new Error('ploča se nije podigla u 10 s')
}

export function spusti(p: Posluzitelj | null) {
  if (!p) return
  p.proc.kill()
  rmSync(p.dom, { recursive: true, force: true })
}

