/**
 * TASK-5654 (plan Mac v3, K1, R16): izvan src/core/platforma.ts i orchestrator/Liveness.ts
 * nema Linux-only poziva — procfs, `ss`, naredba `setsid`, `script -qfec`, `libc.so.6`,
 * `sed -i`, `stat -c`, `date -d`, goli GNU `timeout`. Novi takav poziv tiho pada na macOS-u
 * (npr. „mrtav” živi proces pa čistač ubije zadatak), zato ga ova brana hvata pri commitu.
 */
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

const KORIJEN = join(import.meta.dir, '..')
const MAPE = ['src', 'scripts', 'hooks', 'tools', 'agents', 'profili', 'templates']
const NASTAVCI = /\.(ts|js|sh|py)$|^[^.]+$/

/** Datoteke koje SMIJU znati za Linux. */
const DOPUSTENO = new Set(['src/core/platforma.ts', 'src/core/orchestrator/Liveness.ts'])
/**
 * Pojedinačne iznimke s razlogom: to nisu pozivi nego sigurnosni uzorak koji ODBIJA
 * naredbe konzole što ciljaju `/proc/<pid>/environ` (na macOS-u bezopasan, i dalje odbija).
 */
const IZNIMKE: Record<string, RegExp> = {
  'src/KonzolaVrata.ts': /PUT_TAJNI|\/proc\/<pid>\/environ/,
}

const UZORCI: [string, RegExp][] = [
  ['procfs', /\/proc\b/],
  ['ss', /(^|[\s'"`[(;|&])ss\s+-[a-zA-Z]|\[\s*['"]ss['"]/],
  ['setsid', /\bsetsid\b/],
  ['script -qfec', /script\s+-q?f?e?c|['"]-qfec['"]/],
  ['libc.so.6', /libc\.so\.6/],
  ['sed -i', /\bsed\s+-i\b/],
  ['stat -c', /\bstat\s+-c\b/],
  ['date -d', /\bdate\s+-d\b/],
  ['timeout', /(^|[\s;&|(])timeout\s+\d/],
]

function datoteke(mapa: string): string[] {
  const out: string[] = []
  let imena: string[] = []
  try { imena = readdirSync(mapa) } catch { return out }
  for (const ime of imena) {
    if (ime === 'node_modules' || ime.startsWith('.')) continue
    const p = join(mapa, ime)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...datoteke(p))
    else if (NASTAVCI.test(ime) && st.size < 2_000_000) out.push(p)
  }
  return out
}

describe('brana prenosivosti (K1 grep = 0)', () => {
  test('nema Linux-only poziva izvan platformnog sloja', () => {
    const nalazi: string[] = []
    for (const m of MAPE) for (const p of datoteke(join(KORIJEN, m))) {
      const rel = relative(KORIJEN, p)
      if (DOPUSTENO.has(rel)) continue
      const redovi = readFileSync(p, 'utf-8').split('\n')
      redovi.forEach((red, i) => {
        if (IZNIMKE[rel]?.test(red)) return
        for (const [ime, re] of UZORCI) if (re.test(red)) nalazi.push(`${rel}:${i + 1} [${ime}] ${red.trim().slice(0, 120)}`)
      })
    }
    expect(nalazi).toEqual([])
  })

  test('brana stvarno hvata (uzorci nad poznatim Linux pozivima)', () => {
    const lose = [
      "readFileSync(`/proc/${pid}/cmdline`)", "ss -ltnp 2>/dev/null", "Bun.spawn(['setsid', x])",
      "Bun.spawn(['script', '-qfec', c, '/dev/null'])", "dlopen('libc.so.6', {})", "sed -i 's/a/b/' f",
      "stat -c %Y f", "date -d '1 day ago'", "  timeout 25 bun add zod",
    ]
    for (const l of lose) expect(UZORCI.some(([, re]) => re.test(l))).toBe(true)
    for (const dobro of ['s_rokom 25 bun add zod', "AbortSignal.timeout(5000)", 'process.kill(pid, 0)', 'class Process'])
      expect(UZORCI.some(([, re]) => re.test(dobro))).toBe(false)
  })
})
