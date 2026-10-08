/**
 * KonzolaVrata — tko smije pokrenuti naredbu kroz `/api/konzola/exec` i `/api/konzola/mode`,
 * i koju (TASK-5352, nalaz QA TASK-5344, ADR-0007).
 *
 * Konzola nema prijavu, a bila je dostupna s LAN-a; `cat`/`grep`/`tail` + `ps e` čitali su
 * spremište tajni i okolinu servisa u čistom tekstu — čime je samo-za-pisanje (ADR-0007) bio
 * prazan. Dvije brane, obje potrebne:
 *
 *  (b) vrata: peer mora biti loopback ili Tailscale (isti `odlukaPrijenosa` kao tajne, ali BEZ
 *      `dopustiLanHttp` i bez HTTPS-iznimke — tajne iza toga imaju kod u Telegramu, konzola nema
 *      ništa), plus CSRF zaglavlje `X-TM-Konzola: 1` + JSON + vlastiti Origin;
 *  (a) naredba: nema čitača sadržaja datoteka, `ps` bez okoline, `git` bez izlaza iz
 *      repozitorija, i nijedan argument ne smije ciljati spremište tajni ni `/proc/<pid>/environ`.
 *
 * `bun`/`node` u WORK načinu i dalje izvode proizvoljan kod — zato (b) nije opcionalna.
 * Čiste funkcije: TaskWebUI prosljeđuje, test zove izravno.
 */
import { odlukaPrijenosa } from './TajneApi'

export interface ZahtjevKonzole { metoda: string; zaglavlja: Headers; ip: string | null }
export interface Odbijeno { status: number; greska: string; error: string }

const odbij = (status: number, greska: string, error: string): Odbijeno => ({ status, greska, error })

export function vrataKonzole(z: ZahtjevKonzole): Odbijeno | null {
  const p = odlukaPrijenosa(z.ip, false, { dopustiLanHttp: false })
  if (!p.dopusten || (p.vrsta !== 'loopback' && p.vrsta !== 'tailscale')) {
    return odbij(403, `konzola_prijenos_${p.vrsta}`,
      'Konzola izvodi naredbe samo s ovog stroja (localhost) ili preko Tailscalea — s LAN-a je zatvorena (ADR-0007). Koristi SSH tunel: ssh -L 17781:localhost:17781 <stroj>.')
  }
  const h = z.zaglavlja
  // DNS rebinding (tuđe ime u Host-u, peer loopback) odbija već `isHostAllowed` u TaskWebUI-ju.
  const csrf = odbij(403, 'konzola_csrf', 'Zahtjev konzole bez zaglavlja X-TM-Konzola ili s tuđeg izvora odbijen.')
  if (h.get('x-tm-konzola') !== '1') return csrf
  const sfs = h.get('sec-fetch-site')
  if (sfs && sfs !== 'same-origin') return csrf
  const origin = h.get('origin')
  if (origin) {
    try { if (new URL(origin).host !== (h.get('host') || '')) return csrf } catch { return csrf }
  }
  if (z.metoda !== 'GET' && !(h.get('content-type') || '').toLowerCase().startsWith('application/json')) return csrf
  return null
}

// ─── Naredba ─────────────────────────────────────────────────────────────────

/** Bez čitača sadržaja (cat, head, tail, grep, find…): `ls`/`wc` ne ispisuju sadržaj. */
export const ALLOWED_COMMANDS = new Set([
  'ls', 'wc',
  'git', 'bun', 'node',
  'date', 'uptime', 'whoami', 'hostname', 'df', 'free',
  'ps', 'top',
])

/** Naredbe dopuštene SAMO u WORK načinu. */
export const WORK_MODE_COMMANDS = new Set(['bun', 'node'])

const BLOCKED_PATTERNS = [
  /rm\s+-rf/i,
  /sudo/i,
  /chmod/i,
  /chown/i,
  /curl.*\|\s*(bash|sh)/i,
  /wget.*\|\s*(bash|sh)/i,
  />\s*\/etc\//i,
  /\.\.\/\.\.\//,
  /\$\(/,
  /`[^`]+`/,
  /[;&|]{2,}/,
]

/** Argument koji cilja spremište tajni, okolinu procesa ili `.env` — za SVAKU naredbu. */
const PUT_TAJNI = [/\/proc\//i, /environ/i, /credentials/i, /(^|[\/~])\.env\b/i, /\.netrc/i, /\.ssh/i]

/** `ps` samo s ovim oblicima: BSD „e" i `-o/--format environ` ispisuju okolinu procesa. */
const PS_DOPUSTENO = new Set(['aux', 'auxf', 'ax', 'axf', 'x', '-ef', '-eF', '-e', '-A', '-f', '-F', '-H', '-eH', '-efH'])

const GIT_SAMO_CITA = ['status', 'log', 'diff', 'show', 'branch', 'remote', 'tag']
/** Opcije kojima git čita/piše izvan repozitorija ili pokreće vanjski program. Git prihvaća i
 *  jedinstven PREFIKS duge opcije (`--no-ind`, `--out=`), pa se uspoređuje prefiks. */
const GIT_DUGE_ZABRANJENE = ['--no-index', '--output', '--ext-diff', '--textconv', '--git-dir', '--work-tree',
  '--exec-path', '--namespace', '--super-prefix', '--config-env', '--src-prefix', '--dst-prefix', '--output-directory']
const GIT_KRATKE_ZABRANJENE = /^-(c|C|o|O)/

function gitArgZabranjen(a: string): boolean {
  if (GIT_KRATKE_ZABRANJENE.test(a)) return true
  const [opcija, ...vrijednost] = a.split('=')
  if (opcija!.startsWith('--') && opcija!.length > 3 && GIT_DUGE_ZABRANJENE.some(z => z.startsWith(opcija!))) return true
  return [opcija!, vrijednost.join('=')].some(d => /^[\/~]/.test(d) || /(^|[\/:])\.\.(\/|$)/.test(d))
}

/** Opcije koje čitaju datoteku i njen sadržaj ispišu u poruci o grešci (wc --files0-from,
 *  date -f, hostname -F) — zato bijela lista opcija, ne crna. */
const OPCIJE: Record<string, RegExp> = {
  wc: /^(-[lcwmL]+|--(lines|bytes|chars|words|max-line-length))$/,
  date: /^(\+.*|-[uR]|-I\w*|--utc|--universal|--rfc-email|--iso-8601(=\w+)?|--rfc-3339=\w+)$/,
  hostname: /^(-[IifsdA]|--(fqdn|short|domain|all-fqdns|all-ip-addresses|ip-address|long))$/,
}

export function odlukaNaredbe(
  sirovo: string, nacin: 'plan' | 'work', aliasi: Record<string, string[]>,
): { argv: string[] } | Odbijeno {
  const naredba = String(sirovo ?? '').trim()
  if (!naredba) return odbij(400, 'konzola_prazno', 'No command provided')
  const blok = odbij(403, 'konzola_blokirano', 'Command blocked by security policy')
  for (const uzorak of BLOCKED_PATTERNS) if (uzorak.test(naredba)) return blok

  const alias = aliasi[naredba]
  if (alias) return { argv: alias }

  const [izvrsna, ...arg] = naredba.split(/\s+/)
  if (!ALLOWED_COMMANDS.has(izvrsna!) && !naredba.startsWith('regoc-services')) {
    return odbij(403, 'konzola_nije_dopusteno', `Command not allowed: "${izvrsna}". Type 'help' for allowed commands.`)
  }
  if (arg.some(a => PUT_TAJNI.some(u => u.test(a)))) {
    return odbij(403, 'konzola_put_tajni', 'Konzola ne čita spremište tajni ni okolinu procesa (ADR-0007).')
  }
  if (nacin === 'plan' && WORK_MODE_COMMANDS.has(izvrsna!)) {
    return odbij(403, 'konzola_plan', `Command "${izvrsna}" requires WORK mode. Switch with: mode work`)
  }
  if (izvrsna === 'ps' && !arg.every(a => PS_DOPUSTENO.has(a))) {
    return odbij(403, 'konzola_ps', `ps je dopušten samo kao: ps [${[...PS_DOPUSTENO].join(' | ')}] (bez okoline procesa).`)
  }
  const opcije = OPCIJE[izvrsna!]
  if (opcije && arg.some(a => (a.startsWith('-') || izvrsna !== 'wc') && !opcije.test(a))) {
    return odbij(403, 'konzola_opcija', `Opcija nije dopuštena za ${izvrsna} (konzola ne čita sadržaj datoteka).`)
  }
  if (izvrsna === 'git') {
    if (arg.some(gitArgZabranjen)) return blok
    if (nacin === 'plan' && arg[0] && !GIT_SAMO_CITA.includes(arg[0])) {
      return odbij(403, 'konzola_plan', `Git "${arg[0]}" requires WORK mode.`)
    }
  }
  return { argv: [izvrsna!, ...arg] }
}
