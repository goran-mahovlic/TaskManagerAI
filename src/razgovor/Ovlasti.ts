// ─── Ovlasti razgovorne sesije (ADR-0002 §7) ─────────────────────────────────
// Razgovor je ulaz koji piše BILO TKO tko smije pisati u chat. Zato zadana razina
// (`citanje`) ne smije moći ništa promijeniti ni ništa iznijeti. Zastavice za `claude -p`
// se slažu ovdje i samo ovdje; okolina procesa se prepisuje BIJELOM listom, da tajne
// kanala (bot token) nikad ne dođu u okolinu modela.
//
// ⚠ Pregled sigurnosti prije uključivanja razgovora (ADR §7).
//
// Autorica: Jelena (Engineer), TASK-5277; izolacija sesije i straža ljuske Malik, TASK-5279.

import { join, resolve, sep } from 'path'
import type { Ovlasti } from './RazgovorPostavke'

export interface OvlastiOpcije {
  port: number
  radniDir: string
  tmHome: string
  home: string
  /** Izvršna datoteka za stražu ljuske (zadano: bun koji vrti ovaj proces). */
  bun?: string
  /** Korijen zapisa razgovora (`$TM_HOME/data/razgovor`) — uz `rad` samo za čitanje (TASK-5285). */
  korijen?: string
  /** Dnevnik ulaza (`ingest.jsonl`) — uz `rad` samo za čitanje (TASK-5285). */
  ingestLog?: string
  /** Kanal i chat poteza — zapis razgovora smije se čitati samo za OVAJ chat. */
  kanal?: string
  chatId?: string
  /** Datoteke koje sesija ne smije pisati ni na jednoj razini (vodič vlasnika, TASK-5293). */
  zasticene?: string[]
}

/**
 * Zapisi koje sesija uz `rad` smije ČITATI (TASK-5285): dnevni zapis razgovora OVOG chata,
 * zadnji pošiljatelji i dnevnik ulaza — da bot zna tko je pisao i što je odlučeno (vlasnik je
 * tražio „tko su zadnji nepoznati pošiljatelji"). `rad` vrijedi samo kad su svi pošiljatelji u
 * potezu dopušteni. Ne zapisi drugih chatova, ne `sesije.json` ni `radni/`, ne konfiguracija
 * bota i tajne (one ostaju u `zabrane`).
 */
export function zapisiZaCitanje(o: Pick<OvlastiOpcije, 'korijen' | 'ingestLog' | 'kanal' | 'chatId'>): string[] {
  const out: string[] = []
  if (o.korijen) {
    if (o.kanal && o.chatId) out.push(`/${o.korijen}/${sigurnoIme(o.kanal)}/${sigurnoIme(o.chatId)}/**`)
    out.push(`/${o.korijen}/posiljatelji.json`)
  }
  if (o.ingestLog) out.push(`/${o.ingestLog}`)
  return out
}

/** Skripta PreToolUse straže (v. BashStraza.ts). */
export const BASH_STRAZA = join(import.meta.dir, 'BashStraza.ts')

/**
 * Pravila `permissions.deny` — vrijede za SVE razine, i za `puno`. Apsolutna putanja u
 * pravilu dopuštenja piše se s dvije kose crte (`//apsolutno/…`).
 */
export function zabrane(o: Pick<OvlastiOpcije, 'tmHome' | 'home'>): string[] {
  const putanje = [
    `/${o.tmHome}/config/credentials.env`,
    `/${o.tmHome}/config/telegram.json`,
    `/${o.tmHome}/config/signal.json`,
    `/${o.home}/.claude/.credentials.json`,
    `/${o.home}/.ssh/**`,
    `/${o.home}/.gnupg/**`,
    `/${o.home}/.config/gh/**`,
    `/${o.home}/.git-credentials`,
    `/${o.home}/.netrc`,
    `/${o.home}/.docker/config.json`,
    '**/*.env',
  ]
  return ['Read', 'Edit', 'Write'].flatMap(alat => putanje.map(p => `${alat}(${p})`))
}

/**
 * Datoteke kojima bi model s pravom pisanja u radnoj mapi sam sebi dao veća prava ili trajni
 * nalog u sljedećoj sesiji (projektne postavke, MCP, CLAUDE.md) — zabranjeno na svim razinama.
 */
export function zabranePisanja(radniDir: string, zasticene: string[] = []): string[] {
  const putanje = [`/${radniDir}/.claude/**`, `/${radniDir}/.mcp.json`, `/${radniDir}/CLAUDE.md`, `/${radniDir}/CLAUDE.local.md`,
    ...zasticene.filter(Boolean).map(z => `/${z}`)]
  return ['Edit', 'Write'].flatMap(alat => putanje.map(p => `${alat}(${p})`))
}

/** Statusi za koje model smije pročitati popis zadataka s ploče. */
export const STATUSI_PLOCE = ['pending', 'in_progress', 'blocked', 'completed', 'cancelled'] as const

/**
 * TOČNE naredbe za čitanje ploče — bez zamjenskog znaka. Pravilo `Bash(curl -s …/api/tasks*)`
 * pristaje i uz `curl -s …/api/tasks file:///bilo/sto` ili `… -d @tajna -X POST`, dakle uz
 * čitanje proizvoljne datoteke i njezino iznošenje (sigurnosni pregled TASK-5277).
 */
export function naredbePloce(port: number): string[] {
  const baza = `curl -s http://127.0.0.1:${port}/api/tasks`
  return [baza, ...STATUSI_PLOCE.map(st => `${baza}?status=${st}`)]
}

/** Ugrađeni alati po razini; sve ostalo (WebFetch, Agent, Skill, SendMessage, MCP…) sesija ne vidi. */
export const ALATI_RAZINE: Record<Exclude<Ovlasti, 'puno'>, string[]> = {
  citanje: ['Read', 'Glob', 'Grep', 'Bash'],
  rad: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'],
}

/**
 * Za SVE razine: samo postavke iz `--settings`, bez MCP poslužitelja. Inače sesija učita
 * `~/.claude` korisnika usluge (hookovi i njihov kontekst, allow liste koje bi proširile
 * `citanje`) i `radniDir/CLAUDE.md` — a njega `rad` smije napisati, pa bi postao trajna
 * uputa za sve buduće poteze, i one na `citanje` (Malikov pregled, TASK-5280).
 */
const IZOLACIJA = ['--setting-sources', '', '--strict-mcp-config']

export function argumentiOvlasti(razina: Ovlasti, o: OvlastiOpcije): string[] {
  const deny = [...zabrane(o), ...zabranePisanja(o.radniDir, o.zasticene)]
  if (razina === 'puno') {
    return [...IZOLACIJA, '--dangerously-skip-permissions', '--settings', JSON.stringify({ permissions: { deny } })]
  }
  // Izmjereno 06.10.2026. (TASK-5279): bez `--tools` sesija na razini `citanje` vidi i bez
  // pitanja koristi ListAgents/SendMessage (poruka drugoj lokalnoj Claude sesiji punih prava),
  // Skill i Agent — `--tools` ih uklanja. A `--allowedTools` nije bijela lista za Bash: CLI sam
  // propušta „read-only" naredbe (`ps aux`, `id`), pa Bash ide kroz stražu (BashStraza.ts).
  const straza = `'${o.bun || process.execPath}' '${BASH_STRAZA}' ${o.port}`
  const settings = JSON.stringify({
    permissions: { deny },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: straza, timeout: 15 }] }] },
  })
  // Pravilo `Read(...)` vrijedi i za Glob i Grep — čitanje samo unutar radne mape.
  const alati = [`Read(/${o.radniDir}/**)`, ...naredbePloce(o.port).map(n => `Bash(${n})`)]
  if (razina === 'rad') {
    alati.push(`Edit(/${o.radniDir}/**)`, `Write(/${o.radniDir}/**)`)
    alati.push(...zapisiZaCitanje(o).map(x => `Read(${x})`))
  }
  return [
    ...IZOLACIJA,
    '--permission-mode', 'default',
    '--tools', ALATI_RAZINE[razina].join(','),
    '--allowedTools', alati.join(' '),
    '--settings', settings,
  ]
}

const sigurnoIme = (x: string) => String(x).replace(/[^\w.-]/g, '_').replace(/^\.+/, '_').slice(0, 80) || '_'

/**
 * Radna mapa razgovora. Prazna postavka → zasebna mapa PO CHATU (`<korijen>/radni/<kanal>_<chat>`),
 * da datoteke jednog chata ne čita drugi. Postavka koja bi otvorila tajne ili tuđe zapise
 * (`/`, mapa iznad HOME, TM_HOME ili korijena razgovora, ~/.ssh, ~/.claude, ~/.config,
 * $TM_HOME/config) se ne poštuje — vrijedi mapa po chatu. API ploče nema prijavu, pa
 * `radniDir` može upisati bilo tko s mreže (TASK-5279).
 */
export function radniDirRazgovora(
  postavka: string, o: { korijen: string; home: string; tmHome: string; kanal: string; chatId: string },
): { dir: string; upozorenje: string | null } {
  const poChatu = join(o.korijen, 'radni', `${sigurnoIme(o.kanal)}_${sigurnoIme(o.chatId)}`)
  if (!postavka) return { dir: poChatu, upozorenje: null }
  const d = resolve(postavka)
  const unutar = (a: string, b: string) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
  const iznad = [o.home, o.tmHome, o.korijen].filter(Boolean).some(x => unutar(resolve(x), d))
  const osjetljivo = ['.ssh', '.claude', '.config', '.gnupg'].map(x => join(o.home, x)).concat(join(o.tmHome, 'config'))
    .some(x => unutar(d, resolve(x)))
  if (iznad || osjetljivo) {
    return { dir: poChatu, upozorenje: `radniDir ${postavka} otvara tajne ili tuđe zapise — vrijedi ${poChatu}` }
  }
  return { dir: d, upozorenje: null }
}

const DOPUSTENE_VARIJABLE = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'TMPDIR', 'SHELL']
/**
 * Autentikacija SAMOG CLI-ja modela (bez nje `claude -p` ne radi na instalaciji koja ne
 * koristi prijavu u datoteci). Na razini `citanje`/`rad` model nema ljusku kojom bi je
 * pročitao (Bash je ograničen na curl prema ploči).
 */
const AUTENTIKACIJA_MODELA = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL']
const TAJNA = /TOKEN|SECRET|KEY|PASS|PWD|CRED/i

export function okolinaRazgovora(env: Record<string, string | undefined>, oznaka: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if (DOPUSTENE_VARIJABLE.includes(k) || AUTENTIKACIJA_MODELA.includes(k)) out[k] = v
    else if (k.startsWith('TM_') && !TAJNA.test(k)) out[k] = v
  }
  out.TM_RAZGOVOR = oznaka
  return out
}

/**
 * TASK-5365: na `citanje`/`rad` straža ljuske odbija sve osim naredbi ploče — i `glas`, PDF,
 * skripte. Model to mora znati unaprijed, inače neuspjeh prepriča izmišljenim uzrokom.
 */
const LJUSKA_OGRANICENA = ' Ljuska ti je ograničena na naredbe ploče: datoteke naredbama (glas/mp3, PDF, skripte) ne možeš izraditi. Kad se to traži, reci istinito: „straža mi ne da pokrenuti tu naredbu u razgovoru — neka to zatraži vlasnik (čovjek) ili zadatak na ploči". Ne nagađaj drugi uzrok (venv, instalacija, kvar).'

export const OPIS_OVLASTI: Record<Ovlasti, string> = {
  citanje: 'samo čita: smiješ čitati datoteke u radnoj mapi i čitati popis zadataka s ploče. Ne smiješ ništa mijenjati ni pokretati.' + LJUSKA_OGRANICENA,
  rad: 'čitanje i rad u radnoj mapi: smiješ čitati popis zadataka s ploče te čitati i pisati datoteke u radnoj mapi; smiješ ČITATI zapise razgovora, popis zadnjih pošiljatelja i dnevnik ulaza.' + LJUSKA_OGRANICENA,
  puno: 'puna prava na ovom stroju, osim čitanja tajni (vjerodajnice, ključevi, konfiguracija kanala).',
}
