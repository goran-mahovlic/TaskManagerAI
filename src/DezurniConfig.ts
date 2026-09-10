/**
 * DezurniConfig — postavke dežurnog (rezervnog) modela, čitanje i pisanje s ploče.
 *
 * D4 iz `docs/PLAN-dezurni-fallback.md` §4: datoteka `config/dezurni.json` postoji i u pogonu
 * je na sva tri stroja, ali se model dosad mijenjao ručnim uređivanjem te datoteke. Ovdje je
 * jedini put kojim ploča smije u nju pisati.
 *
 * ZAŠTO BEZ RESTARTA: i most (`tools/Telegram/dezurni.ts` → `postavke()`) i alat
 * (`tools/dezurni.py` → `postavke()`) čitaju datoteku pri SVAKOM pozivu — nitko je ne kešira
 * u memoriji procesa. Zato je zapis na disk dovoljan, i zato ovaj modul ne smije uvesti keš:
 * keš bi bio jedina stvar koja bi zahtijevala restart.
 *
 * Autor: Grga (Designer), TASK-4633.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { konfigPutanja } from './core/paths'

/**
 * ADR-0001 O1.4: `TM_DEZURNI_CONFIG` → `$TM_HOME/config/dezurni.json` → `config/` uz paket.
 * Prije je ovdje pisala mapa jednog konkretnog stroja; na tuđoj instalaciji je nema.
 */
export const DEZURNI_CONFIG_PATH = konfigPutanja('dezurni.json', 'TM_DEZURNI_CONFIG')

export interface DezurniPostavke {
  ukljucen: boolean
  provider: string
  model: string
  baseUrl: string
  okidac_uzastopnih_gresaka: number
  smije_podici: boolean
  razmak_straze_min: number
}

/** Zadano mora biti ISTO kao u `dezurni.py` (ZADANE_POSTAVKE) i `dezurni.ts` (ZADANE) —
 *  tri preslike zadanih vrijednosti su cijena toga što isti posao rade tri jezika. */
export const ZADANE_POSTAVKE: DezurniPostavke = {
  ukljucen: true,
  provider: 'ollama',
  model: 'qwen3:8b',
  // ADR-0001 §5.1: adresa NIKAD nije naša vrijednost. Prazno = dežurni nije podešen;
  // `TM_OLLAMA_URL` (env.example) je jedini zadani izvor.
  baseUrl: process.env.TM_OLLAMA_URL || '',
  okidac_uzastopnih_gresaka: 2,
  smije_podici: true,
  razmak_straze_min: 30,
}

// ── Davatelji (TASK-4709) ───────────────────────────────────────────────────────────────
// Goran, 06.09.2026.: ploča je nudila samo Ollamu jer je most znao samo njezin `/api/chat`.
// Most sada zna pet oblika poziva (`dezurni.ts → NACIN_POZIVA_MOSTA`), pa se popis davatelja
// više NE piše rukom nego IZVODI iz `models/model-config.json`. Ručni popis je jednom već
// zaostao za mostom; izvod ne može.

export const MODEL_CONFIG_PATH = konfigPutanja('model-config.json', 'TM_MODEL_CONFIG')
/** Datoteka s tajnama (`IME=vrijednost`). Prava 0600; nikad u repozitorij. */
export const CREDENTIALS_PATH = konfigPutanja('credentials.env', 'TM_CREDENTIALS')

/** Oblici poziva koje most implementira. Ista imena moraju postojati u `dezurni.ts`
 *  (`NACIN_POZIVA_MOSTA`) — to čuva test `DezurniDavatelji.test.ts → BRANA`. */
export type NacinPoziva = 'ollama' | 'claude-cli' | 'openai' | 'anthropic' | 'google'

/** Davatelji čiji oblik poziva ne piše u konfiguraciji nego ga znamo po imenu. */
const NACIN_PO_IMENU: Record<string, NacinPoziva> = {
  ollama: 'ollama',
  anthropic: 'claude-cli',   // pretplata preko `claude -p`, ne API ključ
  openrouter: 'openai',
  openai: 'openai',
  google: 'google',
}

/**
 * Jedino pravilo o tome koga most zna pozvati. `null` = ne zna → davatelj se NE nudi.
 * `anthropicCompatible` + `baseUrl` pokriva GLM, Kimi, MiniMax, Qwen i DeepSeek bez ijednog
 * novog retka koda; `kimicli` (OAuth CLI) i `custom` namjerno ostaju vani.
 */
export function nacinPoziva(ime: string, konf: Record<string, unknown> | undefined | null):
  NacinPoziva | null {
  const poImenu = NACIN_PO_IMENU[String(ime).toLowerCase()]
  if (poImenu) return poImenu
  if (konf && konf.anthropicCompatible && typeof konf.baseUrl === 'string' && konf.baseUrl) {
    return 'anthropic'
  }
  return null
}

/** Polazni model po davatelju. Nije ograda — ploča dopušta i vlastito ime modela — nego
 *  polazište, da promjena davatelja ne ostavi `qwen3:8b` upisan kod Anthropica. */
export const POZNATI_MODELI_DEZURNI: Record<string, string[]> = {
  ollama: ['qwen3:8b'],
  anthropic: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5'],
  openrouter: ['z-ai/glm-4.6', 'google/gemini-2.5-flash', 'deepseek/deepseek-chat'],
  openai: ['gpt-4o-mini', 'gpt-4o'],
  google: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  glm: ['glm-4.6', 'glm-4.7-flash'],
  kimi: ['kimi-k2-0905-preview', 'kimi-k2.6'],
  minimax: ['MiniMax-M2'],
  qwen: ['qwen3-coder-plus'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
}

export function zadaniModelZa(provider: string): string {
  return POZNATI_MODELI_DEZURNI[String(provider).toLowerCase()]?.[0] || ''
}

export interface DavateljDezurnog {
  ukljucen: boolean
  nacin: NacinPoziva | null
  spreman: boolean
  zasto: string
  /** Kljuc rjecnika za `zasto` — ploca prevodi razlog, a ne prikazuje tvrdi hrvatski
   *  (TASK-4721; isti obrazac kao `authNoteKey` u kartici Config). */
  zastoKey: string
  /** Podatci koji ulaze u prevedenu recenicu kao {oznake} — ne prevode se. */
  zastoVars?: Record<string, string>
  baseUrl: string | null
  kljucVarijabla: string | null
}

/** Postoji li ključ — provjerava se SAMO postojanje retka/varijable. Vrijednost se ne čita
 *  dalje, ne vraća i ne zapisuje: ploča nikad ne smije postati mjesto curenja tajne. */
function imaKljuc(ime: string, credPath: string): boolean {
  if (!ime) return true
  if (process.env[ime]) return true
  try {
    return new RegExp('^' + ime + '=\\S', 'm').test(readFileSync(credPath, 'utf-8'))
  } catch {
    return false
  }
}

/**
 * Svi davatelji iz `model-config.json` + je li svaki stvarno upotrebljiv.
 * Davatelj bez ključa se NE skriva nego pošteno prijavi — skriven bi izgledao kao da ga nema,
 * a prijavljen kaže Goranu točno koji redak fali u `credentials.env`.
 */
export function davateljiDezurnog(
  mcPath: string = MODEL_CONFIG_PATH,
  credPath: string = CREDENTIALS_PATH,
): Record<string, DavateljDezurnog> {
  let konf: Record<string, any> = {}
  try {
    konf = JSON.parse(readFileSync(mcPath, 'utf-8'))?.providers || {}
  } catch { /* bez konfiguracije ostaje samo lokalni put — vidi niže */ }

  const out: Record<string, DavateljDezurnog> = {}
  for (const [ime, v] of Object.entries(konf)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    const sirovi = String((v as any).apiKey || '')
    const env = sirovi.startsWith('env:') ? sirovi.slice(4) : ''
    const nacin = nacinPoziva(ime, v as Record<string, unknown>)
    // TASK-4721: uz razlog ide i kljuc rjecnika — ploca na engleskom ne smije ispisati
    // hrvatsku recenicu koju je sastavio posluzitelj.
    let zastoKey = 'dez_zasto_spreman'
    let zastoVars: Record<string, string> | undefined
    let spreman = env ? imaKljuc(env, credPath) : true
    let zasto = spreman ? 'spreman' : `treba ${env} (okolina ili credentials.env)`
    if (!spreman) { zastoKey = 'dez_zasto_treba_kljuc'; zastoVars = { env } }
    if (ime === 'ollama') {
      spreman = true; zasto = 'lokalno, bez ključa'
      zastoKey = 'dez_zasto_ollama'; zastoVars = undefined
    }
    if (ime === 'anthropic') {
      spreman = !!Bun.which('claude')
      zasto = spreman
        ? 'Claude CLI (pretplata) — POZOR: troši istu kvotu koja je dežurnog i pozvala'
        : 'nema Claude CLI na ovom stroju'
      zastoKey = spreman ? 'dez_zasto_anthropic_ok' : 'dez_zasto_anthropic_nema'
      zastoVars = undefined
    }
    if (!nacin) {
      spreman = false; zasto = 'most dežurnog ne zna pozvati ovog davatelja'
      zastoKey = 'dez_zasto_nema_nacina'; zastoVars = undefined
    }
    out[ime] = {
      ukljucen: (v as any).enabled === true,
      nacin, spreman, zasto, zastoKey, zastoVars,
      baseUrl: (v as any).baseUrl || null,
      kljucVarijabla: env || null,
    }
  }
  if (!out.ollama) {
    // Nečitljiva konfiguracija ne smije ostaviti ploču bez ijednog izbora: lokalni put je
    // jedini koji radi i bez ključa i bez interneta, pa je i jedini ispravan pad.
    out.ollama = {
      ukljucen: true, nacin: 'ollama', spreman: true,
      zasto: 'lokalno, bez ključa', zastoKey: 'dez_zasto_ollama',
      baseUrl: ZADANE_POSTAVKE.baseUrl, kljucVarijabla: null,
    }
  }
  return out
}

/** Redoslijed: ollama prva (jedina bez ključa i bez interneta), ostali abecedno. */
function poredaj(imena: string[]): string[] {
  return imena.sort((a, b) =>
    a === 'ollama' ? -1 : b === 'ollama' ? 1 : a.localeCompare(b))
}

/** Davatelji koje ploča smije PONUDITI: uključeni u konfiguraciji i s oblikom poziva. */
export function podrzaniProvideri(
  mcPath: string = MODEL_CONFIG_PATH,
  credPath: string = CREDENTIALS_PATH,
): string[] {
  const d = davateljiDezurnog(mcPath, credPath)
  return poredaj(Object.keys(d).filter(k => d[k].ukljucen && d[k].nacin))
}

/** Davatelji koje ploča smije SPREMITI: uz to i spremni (ključ/CLI postoji). */
export function upotrebljiviProvideri(
  mcPath: string = MODEL_CONFIG_PATH,
  credPath: string = CREDENTIALS_PATH,
): string[] {
  const d = davateljiDezurnog(mcPath, credPath)
  return poredaj(Object.keys(d).filter(k => d[k].ukljucen && d[k].nacin && d[k].spreman))
}

/** @deprecated Zadržano da stari pozivatelji ne puknu; popis je sada izvod, ne konstanta. */
export const PODRZANI_PROVIDERI = ['ollama'] as const

export const GRANICE = {
  okidac_uzastopnih_gresaka: { min: 1, max: 10 },
  razmak_straze_min: { min: 5, max: 240 },
} as const

/** Uvijek svjež pročitaj s diska. Nepoznata polja iz datoteke se ČUVAJU (netko ih je upisao
 *  s razlogom), pa vraćamo i njih — ploča prikazuje samo ona koja poznaje. */
export function loadDezurniConfig(path: string = DEZURNI_CONFIG_PATH):
  DezurniPostavke & Record<string, unknown> {
  try {
    const sirovo = JSON.parse(readFileSync(path, 'utf-8'))
    if (!sirovo || typeof sirovo !== 'object' || Array.isArray(sirovo)) return { ...ZADANE_POSTAVKE }
    return { ...ZADANE_POSTAVKE, ...sirovo }
  } catch {
    return { ...ZADANE_POSTAVKE }
  }
}

export interface Provjera {
  ok: boolean
  greske: string[]
  zakrpa: Partial<DezurniPostavke>
}

/**
 * Provjeri zakrpu s ploče. Prihvaća SAMO poznata polja — tipfeler u imenu polja tiho bi
 * stvorio mrtvu postavku koju nitko ne čita (isti kvar koji je `progress_notes` gutao).
 */
export interface OpcijeProvjere {
  mcPath?: string
  credPath?: string
}

export function validateDezurniPatch(tijelo: unknown, opcije: OpcijeProvjere = {}): Provjera {
  const mcPath = opcije.mcPath || MODEL_CONFIG_PATH
  const credPath = opcije.credPath || CREDENTIALS_PATH
  const greske: string[] = []
  const zakrpa: Record<string, unknown> = {}
  if (!tijelo || typeof tijelo !== 'object' || Array.isArray(tijelo)) {
    return { ok: false, greske: ['Očekivan je JSON objekt s postavkama'], zakrpa: {} }
  }
  const t = tijelo as Record<string, unknown>
  const dopustena = Object.keys(ZADANE_POSTAVKE)

  for (const kljuc of Object.keys(t)) {
    if (!dopustena.includes(kljuc)) {
      greske.push(`Nepoznato polje: ${kljuc} (dopušteno: ${dopustena.join(', ')})`)
    }
  }

  for (const kljuc of ['ukljucen', 'smije_podici'] as const) {
    if (kljuc in t) {
      if (typeof t[kljuc] !== 'boolean') greske.push(`${kljuc} mora biti true ili false`)
      else zakrpa[kljuc] = t[kljuc]
    }
  }

  if ('provider' in t) {
    const v = String(t.provider || '').trim().toLowerCase()
    const dav = davateljiDezurnog(mcPath, credPath)
    const d = dav[v]
    const ponudjeni = podrzaniProvideri(mcPath, credPath)
    if (!d || !d.nacin) {
      greske.push(`provider "${v}": most dežurnog ga ne zna pozvati. ` +
        `Ponuđeni: ${ponudjeni.join(', ')}`)
    } else if (!d.ukljucen) {
      greske.push(`provider "${v}" je isključen u models/model-config.json (enabled:false)`)
    } else if (!d.spreman) {
      // Spremiti davatelja bez ključa značilo bi da dežurni šuti baš u trenutku kvara —
      // a tišina je jedini ishod koji korisnik ne smije dobiti.
      greske.push(`provider "${v}" nije spreman: ${d.zasto}`)
    } else zakrpa.provider = v
  }

  if ('model' in t) {
    const v = String(t.model ?? '').trim()
    if (!v) greske.push('model ne smije biti prazan')
    else if (v.length > 120) greske.push('model je predugačak (najviše 120 znakova)')
    else zakrpa.model = v
  }

  if ('baseUrl' in t) {
    const v = String(t.baseUrl ?? '').trim().replace(/\/+$/, '')
    if (!/^https?:\/\/[^\s]+$/.test(v)) greske.push('baseUrl mora biti oblika http://host:port')
    else zakrpa.baseUrl = v
  }

  for (const kljuc of ['okidac_uzastopnih_gresaka', 'razmak_straze_min'] as const) {
    if (kljuc in t) {
      const v = Number(t[kljuc])
      const g = GRANICE[kljuc]
      if (!Number.isInteger(v) || v < g.min || v > g.max) {
        greske.push(`${kljuc} mora biti cijeli broj ${g.min}–${g.max}`)
      } else zakrpa[kljuc] = v
    }
  }

  if (!greske.length && !Object.keys(zakrpa).length) {
    greske.push('Nijedna postavka nije poslana')
  }
  return { ok: greske.length === 0, greske, zakrpa: zakrpa as Partial<DezurniPostavke> }
}

/**
 * Spoji zakrpu s onim što je na disku i zapiši. Zapis ide preko privremene datoteke pa
 * `rename` — dežurni tu datoteku čita u trenutku kvara, a napola zapisan JSON značio bi da
 * upravo tada padne na zadane vrijednosti.
 */
export function saveDezurniConfig(
  zakrpa: Partial<DezurniPostavke>,
  path: string = DEZURNI_CONFIG_PATH,
): DezurniPostavke & Record<string, unknown> {
  const trenutno = loadDezurniConfig(path)
  const novo = { ...trenutno, ...zakrpa }
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(novo, null, 2) + '\n', 'utf-8')
  renameSync(tmp, path)
  return novo
}
