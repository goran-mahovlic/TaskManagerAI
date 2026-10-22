/**
 * StaleCodeCheck — „popravak na disku ≠ popravak u pogonu" (TASK-2987)
 *
 * ZAŠTO POSTOJI (dokaz iz runa 2026-07-28):
 *   TASK-2953 zatvoren kao DONE u 10:47 i u samom rezultatu piše „NIJE JOŠ DEPLOYAN".
 *   RegocDaemon.ts spremljen u 11:02, ali proces je startao u 10:40 — bun NE učitava
 *   kod ponovno. Posljedica: u 11:03–11:04 su TASK-2974 i TASK-2983 zatvoreni kao
 *   COMPLETED s result_summary koji je doslovno poruka hook-blokade. Točno onaj kvar
 *   koji je popravak trebao spriječiti, jer popravak nije bio u pogonu.
 *
 * ŠTO RADI:
 *   Za zadani PID i ulaznu .ts datoteku razriješi tranzitivne LOKALNE importe,
 *   usporedi njihov mtime s vremenom starta procesa (platforma.startProcesaMs:
 *   Linux procfs stat polje 22, macOS `ps -o lstart` uz toleranciju 1 s)
 *   i javi GLASAN alarm ako je bilo koja izvorna datoteka novija od procesa.
 *
 * CLI:
 *   bun StaleCodeCheck.ts --entry RegocDaemon.ts --pid 3711359 [--label X] [--json] [--top N]
 *   exit 0 = kod u pogonu == kod na disku
 *   exit 3 = STALE CODE (proces vrti stari kod)
 *   exit 2 = greška (nema procesa, putanja nije razriješena, prazan graf uvoza…)
 *
 *   `--entry` MORA biti apsolutna putanja kad se alat zove iz tuđeg cwd-a (TASK-4785).
 */

import { readFileSync, statSync, existsSync } from 'fs'
import { dirname, join, resolve, relative, isAbsolute } from 'path'
import { bootMs, otkucajiUSekundi, rezolucijaStartaMs, startProcesaMs } from './lib/platforma'

// ─── Tipovi ────────────────────────────────────────────────────────

export interface FileMtime {
  path: string
  mtimeMs: number
}

export interface StaleReport {
  pid: number
  label: string
  entry: string
  /** Epoch ms kad je proces startao (platforma.startProcesaMs). */
  startedAtMs: number
  /** Sve razriješene lokalne .ts datoteke koje proces (može) učitavati. */
  files: FileMtime[]
  /** Datoteke novije od starta procesa — te NISU u pogonu. */
  stale: FileMtime[]
  isStale: boolean
}

export interface ProcTimeOptions {
  /** Korijen procfs-a (test injektira lažni). */
  procRoot?: string
  /** Otkucaja u sekundi (Linux default 100). */
  clockTicks?: number
  /** Epoch ms boot-a; ako nije zadan, računa ga platforma.bootMs (procfs uptime | kern.boottime). */
  bootMs?: number
}

// ─── Vrijeme starta procesa ────────────────────────────────────────

/** getconf CLK_TCK s fallbackom na 100 (Linux default na svim našim hostovima). */
export function clockTicksPerSecond(): number {
  return otkucajiUSekundi()
}

/** Epoch ms trenutka boot-a (platforma.bootMs). */
/**
 * TASK-3092: koliko datoteka smije biti „novija" od procesa a da to NIJE stale.
 * Pokriva nepreciznost `bootTimeMs()` (±1 s) i normalan deploy u kojem se zadnji zapis
 * dogodi sekundu-dvije prije restarta. Podesivo za dijagnostiku.
 */
export const STALE_TOLERANCE_MS = Number(process.env.REGOC_STALE_TOLERANCE_MS || 5000)

export function bootTimeMs(procRoot?: string): number {
  return bootMs(procRoot ? { procRoot } : undefined)
}

/**
 * Epoch ms kad je proces startao (platforma.startProcesaMs). Na Linuxu polje 22
 * (`starttime`, otkucaji OD BOOT-a) parsirano od ZADNJE ')' jer `comm` smije imati
 * razmake i zagrade; na macOS-u `LC_ALL=C ps -o lstart=` (sekundna rezolucija).
 */
export function processStartMs(pid: number, opts: ProcTimeOptions = {}): number | null {
  return startProcesaMs(pid, {
    ...(opts.procRoot ? { procRoot: opts.procRoot } : {}),
    clockTicks: opts.clockTicks, bootMs: opts.bootMs,
  })
}

// ─── Razrješavanje lokalnih importa ────────────────────────────────

// Pokriva: `from './X'`, `export … from './X'`, `import('./X')`, `require('./X')`
// i side-effect `import './X'` (bez njega bi se propustila cijela grana ovisnosti).
//
// TASK-4696: uzorak hvata I APSOLUTNE specifikatore (`from '<dom>/.claude/regoc/X'`).
// Prije je tražio samo `./` i `../`, pa je `TaskWebUI.ts:38`
// (`import { mozdaZapisiOdluku } from '<dom>/.claude/regoc/WorkflowGate'`) — i još
// 25 apsolutnih uvoza iz iste datoteke — bio nevidljiv grafu. Posljedica 05.09.2026.:
// PID 626175 (start 12:36:32) vrtio je WorkflowGate.ts izmijenjen 12:37:59, a alat je
// javio „✅ kod na disku == kod u pogonu", exit 0, „izvor: 11 datoteka".
// Bare specifikatori (`fs`, `bun:sqlite`, npm paketi) i dalje NE prolaze — nemaju `/` na početku.
const IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]((?:\.{1,2}\/|\/)[^'"]+)['"]/g

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '.js', '/index.ts', '/index.js']

function resolveSpecifier(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec)
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = base + suffix
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    } catch {
      /* nedostupno — preskoči */
    }
  }
  return null
}

/** Je li `target` unutar bilo kojeg poznatog korijena? */
function withinAnyRoot(target: string, roots: Set<string>): boolean {
  for (const r of roots) {
    const rel = relative(r, target)
    if (!rel.startsWith('..') && !isAbsolute(rel)) return true
  }
  return false
}

/**
 * Tranzitivni skup lokalnih izvornih datoteka dosežnih iz `entry`.
 *
 * NAMJERNO KONZERVATIVNO: hvata i `await import('./X')` (lijeni import). Takva
 * datoteka se učita TEK pri prvom pozivu, pa se ne zna vrti li se stara ili nova
 * verzija — dvojba je sama po sebi razlog za alarm.
 *
 * `root` (default: direktorij ulazne datoteke) je POLAZNI korijen, ne ograda.
 *
 * TASK-4696: ranije je bio ograda — svaki modul izvan njega ispadao je iz grafa. To je
 * uz relativni-only uzorak dalo lažno zeleno na TaskWebUI-ju (entry je u
 * `TaskManagerMD/src`, a 26 uvezenih modula živi u `~/.claude/regoc`). Ograda je bila
 * pogrešna po definiciji: datoteku koju proces STVARNO uvozi ne smije se izuzeti iz
 * provjere zato što leži u drugom direktoriju. Korijeni zato RASTU — kad se uvoz
 * razriješi izvan svih poznatih korijena, njegov direktorij postaje novi korijen pa se
 * prate i njegove relativne ovisnosti. Izvan grafa ostaju samo `node_modules` i
 * nepostojeće datoteke.
 *
 * `maxFiles` je zaštita od runaway-obilaska (graf preko praga = alarm, ne tiho skraćivanje).
 */
export function collectLocalSources(entry: string, root?: string, maxFiles = 5000): string[] {
  const entryAbs = resolve(entry)
  // TASK-4785: nerazriješena ulazna putanja NE SMIJE proći kao prazan graf.
  // `resolve()` relativnu putanju veže uz cwd — pozvan iz tuđeg direktorija
  // (`deploy_node_a.sh` korak 9: `--entry RegocDaemon.ts`) dobiva se putanja koja ne
  // postoji, petlja je odmah preskoči (`if (!existsSync(file)) continue`), skup ostane
  // prazan → `stale` prazan → „✅ kod na disku == kod u pogonu", exit 0. Vrata koja brane
  // od lažnog DONE tako sama postaju fail-open. Neprovjereno nije prolaz.
  if (!existsSync(entryAbs)) {
    throw new Error(
      `ulazna putanja nije razriješena: '${entry}' → ${entryAbs} ne postoji ` +
        `(cwd: ${process.cwd()}). Predaj APSOLUTNU putanju, npr. ` +
        `${process.env.HOME ?? '~'}/.claude/regoc/RegocDaemon.ts`
    )
  }
  const roots = new Set<string>([resolve(root ?? dirname(entryAbs))])
  const seen = new Set<string>()
  const queue: string[] = [entryAbs]

  while (queue.length > 0) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    if (!existsSync(file)) continue
    seen.add(file)

    let src: string
    try {
      src = readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    IMPORT_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const target = resolveSpecifier(file, m[1])
      if (!target || seen.has(target)) continue
      if (target.includes('/node_modules/')) continue
      if (!withinAnyRoot(target, roots)) roots.add(dirname(target)) // novi korijen, NE odbacivanje
      queue.push(target)
    }
    if (seen.size > maxFiles) {
      throw new Error(
        `collectLocalSources: graf uvoza prešao ${maxFiles} datoteka iz ${entryAbs} — ` +
          `provjera prekinuta (suzi --root ili podigni prag), radije nego tiho skratiti graf`
      )
    }
  }
  return [...seen].sort()
}

// ─── Provjera ──────────────────────────────────────────────────────

export function checkStaleCode(
  entry: string,
  pid: number,
  opts: ProcTimeOptions & { label?: string; root?: string } = {}
): StaleReport {
  const entryAbs = resolve(entry)
  const startedAtMs = processStartMs(pid, opts)
  if (startedAtMs === null) {
    throw new Error(`PID ${pid} ne postoji (nema vremena starta procesa; ${process.platform})`)
  }
  // Raw `entry` (ne entryAbs) — poruka o nerazriješenoj putanji tako pokazuje ŠTO je
  // korisnik napisao i U ŠTO se to razriješilo (TASK-4785).
  const files: FileMtime[] = collectLocalSources(entry, opts.root).map((p) => ({
    path: p,
    mtimeMs: statSync(p).mtimeMs,
  }))
  // TASK-4785: pojas i tregeri — i da graf ostane prazan iz nekog drugog razloga
  // (nečitljiva ulazna datoteka), izvještaj se NE smije roditi zelen.
  if (files.length === 0) {
    throw new Error(
      `graf uvoza je prazan — putanja nije razriješena u nijednu izvornu datoteku: ${entryAbs}. ` +
        `Nijedna datoteka nije uspoređena, pa provjera NIJE prolaz.`
    )
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  // TASK-3092: tolerancija na nepreciznost mjerenja starta procesa.
  //
  // `processStartMs` računa boot + starttime, a `bootTimeMs()` je `Date.now() - uptime` —
  // to je nestabilno na ±sekundu (dva čitanja u različitim trenucima daju različit boot).
  // Zato je start procesa znao ispasti do sekunde RANIJI nego što stvarno jest, pa je
  // datoteka zapisana neposredno PRIJE restarta izgledala kao da je novija od procesa.
  //
  // Izmjereno na node-B 30.07.: systemd `ExecMainStartTimestamp` = 15:08:18, `ps lstart`
  // = 15:08:17, mtime datoteke = 15:08:18.071 — patch je zapisao datoteku 0,26 s PRIJE
  // SIGTERM-a, dakle redoslijed je bio ispravan, a alarm lažan i trajan (servis pritom
  // NIJE padao: NRestarts=0).
  //
  // Prag je 5 s: deploy (patch → build → restart) stane u sekundu-dvije, dok se stvarna
  // izmjena koda nakon starta događa minutama ili satima kasnije. Prava detekcija ostaje.
  // macOS: `lstart` ima sekundnu rezoluciju → +1 s (rezolucijaStartaMs), Linux +0.
  const stale = files.filter((f) => f.mtimeMs > startedAtMs + STALE_TOLERANCE_MS + rezolucijaStartaMs())
  return {
    pid,
    label: opts.label ?? entryAbs.split('/').pop()!,
    entry: entryAbs,
    startedAtMs,
    files,
    stale,
    isStale: stale.length > 0,
  }
}

// ─── Ispis ─────────────────────────────────────────────────────────

const C = {
  ok: '\x1b[0;32m',
  err: '\x1b[1;31m',
  warn: '\x1b[0;33m',
  dim: '\x1b[0;90m',
  off: '\x1b[0m',
}

function ts(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function humanDelta(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}min`
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`
  return `${(s / 86400).toFixed(1)}d`
}

/** Glasan, jednoznačan izvještaj za `status` ispis. `color=false` za testove/logove. */
export function formatStaleReport(r: StaleReport, opts: { color?: boolean; top?: number } = {}): string {
  const color = opts.color ?? true
  const c = (code: string) => (color ? code : '')
  const top = opts.top ?? 3
  const L: string[] = []
  const short = (p: string) => p.replace(/^.*\/\.claude\/regoc\//, '')

  L.push(`── kod u pogonu: ${r.label} (PID ${r.pid}) ──`)
  L.push(`   proces startan : ${ts(r.startedAtMs)}  (prije ${humanDelta(Date.now() - r.startedAtMs)})`)
  L.push(`   izvor          : ${r.files.length} datoteka iz ${short(r.entry)}`)

  if (!r.isStale) {
    const newest = r.files[0]
    if (newest) {
      L.push(
        `   najnovija       : ${ts(newest.mtimeMs)}  ${short(newest.path)}  ${c(C.dim)}(${humanDelta(r.startedAtMs - newest.mtimeMs)} prije starta)${c(C.off)}`
      )
    }
    L.push(`${c(C.ok)}   ✅ kod na disku == kod u pogonu${c(C.off)}`)
    return L.join('\n')
  }

  L.push('')
  L.push(`${c(C.err)}   ❌❌❌ STALE CODE — proces vrti STARI kod! ❌❌❌${c(C.off)}`)
  L.push(`${c(C.err)}   ${r.stale.length} izvorna datoteka novija od procesa — popravak NIJE u pogonu:${c(C.off)}`)
  for (const f of r.stale.slice(0, top)) {
    L.push(
      `${c(C.err)}     +${humanDelta(f.mtimeMs - r.startedAtMs).padEnd(6)} ${ts(f.mtimeMs)}  ${short(f.path)}${c(C.off)}`
    )
  }
  if (r.stale.length > top) L.push(`${c(C.err)}     … i još ${r.stale.length - top}${c(C.off)}`)
  L.push(`${c(C.warn)}   → RESTARTAJ pa ponovi provjeru; do tada nijedan „fix" nije isporučen.${c(C.off)}`)
  L.push(`${c(C.dim)}     ~/.claude/regoc/regoc-services.sh restart-service <regoc|daemon|taskwebui|klaudio|team|AGENT>   (iz spawna agenta: tools/servisi/restart_kad_mirno.sh)${c(C.off)}`)
  return L.join('\n')
}

// ─── CLI ───────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i++
    } else out[key] = true
  }
  return out
}

if (import.meta.main) {
  const a = parseArgs(process.argv.slice(2))
  const entry = typeof a.entry === 'string' ? a.entry : ''
  const pid = Number(a.pid)
  if (!entry || !Number.isFinite(pid)) {
    console.error('Uporaba: bun StaleCodeCheck.ts --entry <fajl.ts> --pid <pid> [--label X] [--json] [--top N]')
    process.exit(2)
  }
  try {
    const report = checkStaleCode(entry, pid, {
      label: typeof a.label === 'string' ? a.label : undefined,
      root: typeof a.root === 'string' ? a.root : undefined,
    })
    if (a.json) {
      console.log(
        JSON.stringify(
          {
            pid: report.pid,
            label: report.label,
            entry: report.entry,
            started_at: new Date(report.startedAtMs).toISOString(),
            file_count: report.files.length,
            is_stale: report.isStale,
            stale: report.stale.map((f) => ({ path: f.path, mtime: new Date(f.mtimeMs).toISOString() })),
          },
          null,
          2
        )
      )
    } else {
      console.log(
        formatStaleReport(report, {
          color: !a['no-color'],
          top: Number.isFinite(Number(a.top)) ? Number(a.top) : undefined,
        })
      )
    }
    process.exit(report.isStale ? 3 : 0)
  } catch (e) {
    console.error(`❌ StaleCodeCheck: ${e instanceof Error ? e.message : e}`)
    process.exit(2)
  }
}
