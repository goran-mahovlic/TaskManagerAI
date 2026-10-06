// ─── Ovlasti razgovorne sesije (ADR-0002 §7) ─────────────────────────────────
// Razgovor je ulaz koji piše BILO TKO tko smije pisati u chat. Zato zadana razina
// (`citanje`) ne smije moći ništa promijeniti ni ništa iznijeti. Zastavice za `claude -p`
// se slažu ovdje i samo ovdje; okolina procesa se prepisuje BIJELOM listom, da tajne
// kanala (bot token) nikad ne dođu u okolinu modela.
//
// ⚠ Pregled sigurnosti prije uključivanja razgovora (ADR §7).
//
// Autorica: Jelena (Engineer), TASK-5277.

import type { Ovlasti } from './RazgovorPostavke'

export interface OvlastiOpcije {
  port: number
  radniDir: string
  tmHome: string
  home: string
}

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
    '**/*.env',
  ]
  return ['Read', 'Edit', 'Write'].flatMap(alat => putanje.map(p => `${alat}(${p})`))
}

export function argumentiOvlasti(razina: Ovlasti, o: OvlastiOpcije): string[] {
  const settings = JSON.stringify({ permissions: { deny: zabrane(o) } })
  if (razina === 'puno') return ['--dangerously-skip-permissions', '--settings', settings]
  const ploca = `http://127.0.0.1:${o.port}/api/tasks`
  const alati = ['Read', 'Glob', 'Grep', `Bash(curl -s ${ploca}*)`]
  if (razina === 'rad') {
    alati.push(`Edit(/${o.radniDir}/**)`, `Write(/${o.radniDir}/**)`, `Bash(curl -s -X POST ${ploca}*)`)
  }
  return ['--permission-mode', 'default', '--allowedTools', alati.join(' '), '--settings', settings]
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

export const OPIS_OVLASTI: Record<Ovlasti, string> = {
  citanje: 'samo čita: smiješ čitati datoteke u radnoj mapi i čitati ploču zadataka (GET). Ne smiješ ništa mijenjati ni pokretati.',
  rad: 'čitanje i rad u radnoj mapi: smiješ čitati ploču, otvarati zadatke (POST na ploču) i pisati datoteke u radnoj mapi.',
  puno: 'puna prava na ovom stroju, osim čitanja tajni (vjerodajnice, ključevi, konfiguracija kanala).',
}
