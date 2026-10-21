// Ovisnosti paketa za testove koji pokreću install.sh s --posudi (TM_POSUDI_IZ=<korijen>/node_modules).
// Svježa kopija stabla (git worktree, klon) nema node_modules → bez ovoga install.sh pada s izlazom 8.
import { existsSync } from 'fs'
import { join } from 'path'

type Pokretac = (argv: string[], cwd: string) => number | null

const bunInstall: Pokretac = (argv, cwd) =>
  Bun.spawnSync(argv, { cwd, stdout: 'inherit', stderr: 'inherit', timeout: 180_000 } as any).exitCode

/** Vrati <korijen>/node_modules; ako u njemu nema `zod`, prvo pokrene `bun install --frozen-lockfile`. */
export function osigurajOvisnosti(korijen: string, pokreni: Pokretac = bunInstall): string {
  const nm = join(korijen, 'node_modules')
  if (existsSync(join(nm, 'zod'))) return nm
  const kod = pokreni(['bun', 'install', '--frozen-lockfile'], korijen)
  if (kod !== 0 || !existsSync(join(nm, 'zod')))
    throw new Error(`instalacijski testovi trebaju node_modules: 'bun install --frozen-lockfile' u ${korijen} nije uspio (izlaz ${kod}) — pokreni ga ručno`)
  return nm
}
