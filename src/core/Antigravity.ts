// ─── Antigravity CLI (`agy`) kao AI servis (TASK-5738) ───────────────────────────────────────
// Prijava Google računom (OAuth, besplatna razina), pozivi `agy -p` — agent s alatima.
//
// Pohrana tokena: agy token sprema u Keychain (macOS) ili secret-service (Linux) — usluga pod
// launchd/systemd taj spremnik ne vidi. Kad u okolini postoji SSH_CONNECTION, SSH_CLIENT ili
// SSH_TTY, agy prelazi na DATOTEČNU pohranu (izmjereno 23.10.2026., agy 1.4.6: „Using file-based
// token storage because SSH session detected"). Zato i prijava (Config → Prijava) i svaki poziv
// nose istu oznaku: token je u datoteci u ~/.gemini/antigravity-cli i vidi ga svaka usluga.
//
// Dva načina (uputa #458): `kljuc` = GEMINI_API_KEY i `modelProvider: "gemini"` u
// ~/.gemini/antigravity-cli/settings.json (bez prijave, bez rizika za račun; besplatna razina
// 20 upita/dan po modelu, Pro 0 — mjereno 23.10.); `google` = OAuth prijava Google računom.
//
// Uvjeti: Google navodi da omatanje agy u tuđe aplikacije na potrošačkim planovima nije
// podržano i može dovesti do blokade računa. Vlasnik je rizik prihvatio (TASK-5738, odluka
// 23.10.2026.); preporuka korisniku je zaseban Google račun. Pričuva: GEMINI_API_KEY.
//
// Modul je bez putanja i bez okoline — isti u paketu i u pogonu.
// Autorica: Jelena (Engineer), TASK-5738.

/** Mapa podataka agy-ja (u ~). */
export const AGY_MAPA = '.gemini/antigravity-cli'
/** Model `antigravity:zadano` = bez --model, agy bira svoj (prati Googleovu zadanu ponudu). */
export const AGY_MODEL_ZADANO = 'zadano'
/** PTY prijava s ploče: bez prijave ispiše URL i čeka kod; nakon prijave odgovori i izađe. */
export const AGY_NAREDBA_PRIJAVE = 'agy -p "Odgovori samo: OK"'
/** Službena instalacija u ~/.local/bin (bez Homebrewa). */
export const AGY_INSTALACIJA = 'curl -fsSL https://antigravity.google/cli/install.sh | bash'

const SSH_OZNAKE = ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']
/** Vrijednost oznake: lokalna petlja, bez stvarne veze (agy gleda samo postoji li varijabla). */
const SSH_OZNAKA = '127.0.0.1 0 127.0.0.1 0'

/**
 * Okolina poziva agy-ja: datotečna pohrana tokena (SSH oznaka), ~/.local/bin na PATH-u, bez
 * prijave u Claude. Vraća NOVI objekt.
 */
export function okolinaAgyja(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const o = { ...env }
  if (!SSH_OZNAKE.some(k => o[k])) o.SSH_CONNECTION = SSH_OZNAKA
  if (o.HOME) {
    const bin = `${o.HOME}/.local/bin`
    const put = (o.PATH || '').split(':').filter(Boolean)
    if (!put.includes(bin)) o.PATH = [bin, ...put].join(':')
  }
  delete o.CLAUDE_CODE_OAUTH_TOKEN
  delete o.ANTHROPIC_API_KEY
  return o
}

/**
 * Argumenti `agy` (bez imena programa). `agent` = alati bez potvrde (kao claude/gemini u
 * daemonu); `razgovor` = samo čitanje (način plan, dozvole se ne preskaču) — razgovor nema
 * stražu ljuske ni popis zabrana kakav ima claude put.
 */
export function argumentiAgyja(o: { prompt: string; model?: string; nacin: 'agent' | 'razgovor' }): string[] {
  const a = ['-p', o.prompt, '--output-format', 'text']
  if (o.model && o.model !== AGY_MODEL_ZADANO) a.push('--model', o.model)
  if (o.nacin === 'agent') a.push('--dangerously-skip-permissions')
  else a.push('--mode', 'plan')
  return a
}

/** settings.json agy-ja (u ~): `modelProvider: "gemini"` = način ključa (agy 1.1.13+). */
export const AGY_POSTAVKE = `${AGY_MAPA}/settings.json`

export type NacinAgyja = 'kljuc' | 'google'

export function nacinAgyja(postavke: any): NacinAgyja {
  return postavke && typeof postavke === 'object' && postavke.modelProvider === 'gemini' ? 'kljuc' : 'google'
}

/** Postavke s odabranim načinom; ostala polja ostaju. Vraća NOVI objekt. */
export function postaviNacinAgyja(postavke: any, nacin: NacinAgyja): Record<string, unknown> {
  const o: Record<string, unknown> = postavke && typeof postavke === 'object' ? { ...postavke } : {}
  if (nacin === 'kljuc') o.modelProvider = 'gemini'
  else delete o.modelProvider
  return o
}

/** Prijavljenost: u načinu ključa vrijedi samo ključ, u načinu Googlea samo token. */
export function stanjeAgyja(o: { nacin: NacinAgyja; kljuc: boolean; token: boolean }): { prijavljen: boolean; kako: string } {
  if (o.nacin === 'kljuc') return o.kljuc ? { prijavljen: true, kako: 'Gemini ključ (GEMINI_API_KEY)' } : { prijavljen: false, kako: 'način ključa, a GEMINI_API_KEY nema' }
  return o.token ? { prijavljen: true, kako: 'Google prijava' } : { prijavljen: false, kako: 'nije prijavljen (Config → Prijava)' }
}

/** Ime datoteke tokena: točno ime datotečne pohrane nije dokumentirano — kandidati iz binarke. */
const RE_TOKEN = /^(authstore|auth|token|oauth|credential)s?[._-]?/i

/** Datoteke prijave u mapi agy-ja (puni putevi). `ls` čita mapu — podmeće ga test. */
export function agyDatotekePrijave(home: string, ls: (mapa: string) => string[]): string[] {
  const mapa = `${home}/${AGY_MAPA}`
  try { return ls(mapa).filter(f => RE_TOKEN.test(f)).map(f => `${mapa}/${f}`) } catch { return [] }
}

export function agyPrijavljen(home: string, ls: (mapa: string) => string[]): boolean {
  return agyDatotekePrijave(home, ls).length > 0
}

/** Je li agy u izlazu javio uspješnu prijavu. */
export function agyPrijavaUspjela(izlaz: string): boolean {
  return /authentication completed successfully/i.test(izlaz)
}

export interface AgyModel { spec: string; provider: 'antigravity'; model: string; tier: string; label: string; spawnable: boolean }

const MODELI: Array<[string, string, string]> = [
  [AGY_MODEL_ZADANO, 'good', 'Antigravity — zadani model'],
  ['gemini-3.8-flash', 'good', 'Antigravity — Gemini 3.8 Flash'],
  ['gemini-3.7-flash', 'good', 'Antigravity — Gemini 3.7 Flash'],
  ['gemini-3.6-flash', 'good', 'Antigravity — Gemini 3.6 Flash'],
]

/** Modeli za izbornike (agent, razgovor, Model sustava) — tek nakon prijave. */
export function modeliAgyja(prijavljen: boolean): AgyModel[] {
  if (!prijavljen) return []
  return MODELI.map(([model, tier, label]) => ({ spec: `antigravity:${model}`, provider: 'antigravity', model, tier, label, spawnable: true }))
}

/**
 * „Model sustava" na `antigravity:*`: provjeriCilj traži davatelja u `providers`. Kad je agy
 * prijavljen (token ili ključ u načinu ključa), odabir ga dodaje/uključuje — isto kao
 * ukljuciGoogleZaCilj (GeminiModeli.ts). Vraća je li mijenjao.
 */
export function ukljuciAgyZaCilj(mc: any, spec: string, prijavljen: boolean): boolean {
  if (!prijavljen || !String(spec).startsWith('antigravity:') || !mc || typeof mc !== 'object') return false
  if (!mc.providers || typeof mc.providers !== 'object') mc.providers = {}
  const p = mc.providers.antigravity
  if (p && p.enabled !== false) return false
  mc.providers.antigravity = { ...(p || { name: 'Antigravity CLI (agy)' }), enabled: true }
  return true
}

/**
 * Login s ploče ide kroz PTY (platforma.ptyNaredba). Izmjereno na macOS-u 23.10.2026.: `agy -p` u
 * PTY-u pošalje sekundarni DA upit (ESC[>c) i čeka odgovor terminala — bez njega visi bez izlaza,
 * s njim ispiše URL i traži kod (potvrda '\r', kao ostali CLI-jevi). Bez PTY-a (cijev na stdinu)
 * odustaje: „authentication required. Run 'agy' to log in".
 */
export function odgovorTerminaluAgyja(izlaz: string): string {
  return izlaz.includes('\x1b[>c') ? '\x1b[>0;390;0c' : ''
}
