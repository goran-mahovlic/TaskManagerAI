/**
 * davateljiAI — katalog AI servisa na koje se čvor može prijaviti (plan Mac v3 P12.1).
 *
 * Odluka 6 (20. 10. 2026.): korisnik čvora sam bira servis i model; instalacija ne smije
 * pretpostaviti jedan. Zato ovdje stoji SVIH 14 davatelja koje vozi model-config kompleta
 * (isti kao na node-A), s tokom prijave po OS-u. Katalog ne nosi nijednu vrijednost — samo
 * IMENA tajni; vrijednosti žive u spremištu čvora (0600).
 *
 * Davatelj iz model-configa kojeg katalog ne zna (npr. vlastiti `custom`) i dalje se
 * prikazuje: ime tajne se čita iz `apiKey: "env:IME"`.
 */
export type NacinPrijave = 'pretplata' | 'kljuc' | 'oauth-cli' | 'lokalno'

export interface DavateljAI {
  id: string
  ime: string
  nacin: NacinPrijave
  /** Ime tajne u spremištu (prvo = ono koje se upisuje). */
  tajne: string[]
  /** Gdje se dobiva ključ ili pretplata. */
  adresa?: string
  /** CLI koji se prijavljuje OAuth-om (pretplata, oauth-cli). */
  cli?: string
  /** Datoteka koju CLI piše nakon prijave (u ~). */
  prijavaDatoteka?: string
  /** Kako se CLI instalira u korisničku mapu. */
  instalacija?: string
  napomena?: string
}

export const DAVATELJI_AI: DavateljAI[] = [
  { id: 'claude', ime: 'Claude — pretplata (Pro/Max)', nacin: 'pretplata', tajne: ['CLAUDE_CODE_OAUTH_TOKEN'],
    adresa: 'https://claude.ai', cli: 'claude', prijavaDatoteka: '~/.claude/.credentials.json',
    instalacija: 'službena skripta https://claude.ai/install.sh (install.sh --claude)',
    napomena: 'na macOS-u prijava ide u Keychain koji usluga ne vidi → claude setup-token, token u spremište' },
  { id: 'anthropic', ime: 'Anthropic — API ključ', nacin: 'kljuc', tajne: ['ANTHROPIC_API_KEY'], adresa: 'https://console.anthropic.com' },
  { id: 'openrouter', ime: 'OpenRouter', nacin: 'kljuc', tajne: ['OPENROUTER_API_KEY'], adresa: 'https://openrouter.ai/keys',
    napomena: 'preporuka: limit potrošnje na ključu' },
  { id: 'kimi', ime: 'Kimi (Moonshot)', nacin: 'kljuc', tajne: ['KIMI_API_KEY'], adresa: 'https://platform.moonshot.ai' },
  { id: 'kimicli', ime: 'Kimi CLI', nacin: 'oauth-cli', tajne: [], cli: 'kimi', prijavaDatoteka: '~/.kimi-code/oauth',
    instalacija: 'uv tool install kimi-cli', napomena: 'prijava: kimi login' },
  { id: 'glm', ime: 'GLM (Z.ai)', nacin: 'kljuc', tajne: ['GLM_API_KEY'], adresa: 'https://z.ai' },
  { id: 'minimax', ime: 'MiniMax', nacin: 'kljuc', tajne: ['MINIMAX_API_KEY'], adresa: 'https://www.minimax.io' },
  { id: 'qwen', ime: 'Qwen (Alibaba DashScope)', nacin: 'kljuc', tajne: ['QWEN_API_KEY'], adresa: 'https://dashscope.console.aliyun.com' },
  { id: 'deepseek', ime: 'DeepSeek', nacin: 'kljuc', tajne: ['DEEPSEEK_API_KEY'], adresa: 'https://platform.deepseek.com' },
  { id: 'geminicli', ime: 'Gemini CLI (Google)', nacin: 'oauth-cli', tajne: ['GEMINI_API_KEY'], cli: 'gemini',
    prijavaDatoteka: '~/.gemini/oauth_creds.json', instalacija: 'bash scripts/install.sh --gemini-cli (Node u ~/.local/node + npm i -g @google/gemini-cli)',
    napomena: 'OAuth „Login with Google" ili ključ' },
  { id: 'google', ime: 'Google Gemini — API ključ', nacin: 'kljuc', tajne: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], adresa: 'https://aistudio.google.com' },
  { id: 'openai', ime: 'OpenAI', nacin: 'kljuc', tajne: ['OPENAI_API_KEY'], adresa: 'https://platform.openai.com' },
  { id: 'ollama', ime: 'Ollama (lokalno)', nacin: 'lokalno', tajne: [], adresa: 'https://ollama.com/download',
    napomena: 'bez prijave; na čvoru isključen dok Ollama nije instalirana' },
  { id: 'custom', ime: 'Vlastiti (OpenAI-kompatibilan)', nacin: 'kljuc', tajne: [],
    napomena: 'baseUrl i ime ključa (*_API_KEY) po izboru — tajna.ts podesi --dodatno IME' },
]

/** Imena tajni iz `apiKey: "env:A|B"` u model-configu. */
export function tajneIzApiKey(apiKey: unknown): string[] {
  if (typeof apiKey !== 'string' || !apiKey.startsWith('env:')) return []
  return apiKey.slice(4).split('|').map(s => s.trim()).filter(s => /^[A-Z][A-Z0-9_]*$/.test(s))
}

export interface StavkaPopisa extends DavateljAI { ukljucen: boolean | null; uModelConfigu: boolean }

/** Katalog spojen s model-configom: katalog daje tok prijave, model-config uključenost i dodatne davatelje. */
export function spojiSModelConfigom(modelConfig: { providers?: Record<string, { apiKey?: unknown; enabled?: boolean; name?: string }> } | null): StavkaPopisa[] {
  const pr = modelConfig?.providers || {}
  const van: StavkaPopisa[] = DAVATELJI_AI.map(d => {
    const p = pr[d.id]
    const izMc = p ? tajneIzApiKey(p.apiKey) : []
    return { ...d, tajne: [...new Set([...d.tajne, ...izMc])], ukljucen: p ? p.enabled !== false : null, uModelConfigu: !!p }
  })
  for (const [id, p] of Object.entries(pr)) {
    if (van.some(v => v.id === id)) continue
    van.push({ id, ime: p.name || id, nacin: 'kljuc', tajne: tajneIzApiKey(p.apiKey), ukljucen: p.enabled !== false, uModelConfigu: true })
  }
  return van
}

/** Koraci prijave za čovjeka, po OS-u (darwin = LaunchDaemon bez GUI sesije, P12.2). */
export function koraciPrijave(d: DavateljAI, os: string, paket = '~/TaskManagerAI'): string[] {
  const tajna = (ime: string) => `bun ${paket}/scripts/tajna.ts postavi ${ime}   (vrijednost na upit, ne kao argument)`
  switch (d.nacin) {
    case 'pretplata':
      return os === 'darwin'
        ? ['claude setup-token   (otvori poveznicu, prijavi se u pregledniku; CLI ispiše dugotrajni token)',
            tajna('CLAUDE_CODE_OAUTH_TOKEN'), 'restart usluge daemona da token vidi (Config → Usluge ili launchctl kickstart)']
        : ['claude auth login --claudeai   (ili Config → Prijava → Claude)',
            `bez preglednika na stroju: claude setup-token, pa ${tajna('CLAUDE_CODE_OAUTH_TOKEN')}`]
    case 'kljuc':
      if (!d.tajne.length) return [d.napomena || 'ime ključa po izboru']
      return [`ključ: ${d.adresa || 'konzola davatelja'}`, `Config → Tajne → ${d.tajne[0]}  ili  ${tajna(d.tajne[0])}`]
    case 'oauth-cli':
      return [`instalacija CLI-ja: ${d.instalacija || d.cli}`, `prijava: Config → Prijava → ${d.ime} (ili u terminalu: ${d.napomena || d.cli})`,
        ...(d.tajne.length ? [`ili ključ: ${tajna(d.tajne[0])}`] : [])]
    case 'lokalno':
      return [d.napomena || 'bez prijave']
  }
}
