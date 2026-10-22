/**
 * adversarial-pozivac — TKO odgovara na pitanje leće (W5 / TASK-4837).
 *
 * ZAŠTO POSTOJI: do 12.09.2026. je i `adversarial-provjeri.ts` i `adversarial-kalibracija.ts`
 * imao Ollamu uživljenu u kod — prvi je svaki spec koji ne počinje s „ollama:" bacao kao
 * nepodržan, drugi je prefiks samo odrezao i svejedno otišao Ollami. Panel se zato nije mogao
 * izmjeriti ničim osim lokalnim 8B modelima, a baš su oni 05.09.2026. oborili SVIH 12
 * kalibracijskih nalaza (i 6 zdravih) doslovno istom rečenicom „dokaz ne pokriva tvrdnju".
 * Dispatch je sada na JEDNOM mjestu, pa oba alata gledaju isti spisak providera.
 *
 * GRANICA: ovdje su mreža i procesi. `AdversarialVerify.ts` ostaje čista prosudba bez ijednog
 * izlaza prema van — isto pravilo kao prije, samo je izlaz sada zajednički za dva alata.
 *
 * POŠTENA USPOREDBA: Claude CLI se poziva s `--restricted` (sesija BEZ ugrađenih alata), jer
 * kalibracijski skup izričito pretpostavlja provjeravatelja koji „nema alate — ne može
 * pokrenuti naredbu i utvrditi je li broj u dokazu izmišljen". Sudac s Read/Bash alatima ne bi
 * mjerio istu stvar kao lokalni model kojemu je dan samo tekst.
 *
 * Autor: Jelena (Engineer), TASK-4837.
 */
import { readFileSync } from 'fs'
import { join } from 'path'

import type { IdLece, PozivIzlaz, PozivUlaz, ProvjeraDeps } from '../../AdversarialVerify'
import type { RazinaSuca, Sudac, SudacSpec } from '../../Sudac'
import { homedir } from 'os'
import { ollamaUrl } from '../../lib/okolina-sustava' // TASK-5700 (K3a)

const HOME = process.env.HOME || homedir()

/** Minimum koji pozivač traži od providera — dovoljno za lažnjaka u testu. */
export interface ChatLike {
  chat(poruke: Array<{ role: 'user'; content: string }>, opcije: {
    model: string; temperature?: number; maxTokens?: number; timeout?: number
  }): Promise<{ content?: string; costUsd?: number; usage?: { inputTokens: number; outputTokens: number } }>
}

export interface Tvornice {
  ollama?: (baseUrl: string) => ChatLike
  anthropic?: () => ChatLike
  /** TASK-4839: `agent:<id>` ide ovdje — Sudac, ne sirovi provider. */
  sudac?: (spec: SudacSpec) => Sudac
}

export interface PozivacOpts {
  modeli: Record<IdLece, string>
  ollamaBaseUrl?: string
  /** Dodatni argumenti za `claude --print`; zadano `--restricted` (bez ugrađenih alata). */
  anthropicArgumenti?: string[]
  tvornice?: Tvornice
  /** Serijalizacija poziva. Zadano true: GPU brava je PID-vezana, a i CLI voli red. */
  uRedu?: boolean
  /** Osigurač po pozivu sucu → `--max-budget-usd`. Zadano 0,25 USD (dizajn §7.1). */
  proracunUsdPoLeci?: number
}

export interface TrosakZapis {
  leca: IdLece
  nalazId: string
  spec: string
  /** Samo za `agent:` spec — je li sudac imao alate ili je bio tekstualni (§5). */
  razina?: RazinaSuca
  /** Popunjeno kad sud nije stigao (rok, osigurač, brana) — nikad tiho (§7.4). */
  greska?: string | null
  cijenaUsd: number | null
  latencyMs: number
  ulazTokena: number | null
  izlazTokena: number | null
}

export interface Pozivac {
  deps: ProvjeraDeps
  trosak: TrosakZapis[]
  /** Zbroj POZNATIH cijena. Pozivi bez cijene se ne broje kao nula — vidi `bezCijene()`. */
  ukupnoUsd(): number
  bezCijene(): number
  koristiOllamu(): boolean
}

/**
 * „ollama:qwen3:8b" → { ollama, qwen3:8b }; „anthropic:opus" → { anthropic, opus }.
 * Spec bez providera i dalje znači Ollamu — tako je stajala produkcijska konfiguracija
 * prije ovog zadatka i nijedan zatečeni zapis ne smije promijeniti značenje.
 */
/** Imena providera iz `ModelInterface.ProviderId`. Sve izvan popisa je oznaka inačice modela. */
const PROVIDERI = new Set(['anthropic', 'openai', 'google', 'ollama', 'custom', 'agent'])

export function razlomiModel(spec: string): { provider: string; model: string } {
  const i = spec.indexOf(':')
  if (i < 0) return { provider: 'ollama', model: spec }
  const p = spec.slice(0, i).toLowerCase()
  const model = spec.slice(i + 1)
  if (p === 'claude') return { provider: 'anthropic', model }   // alias: nalog i registar ga tako zovu
  if (PROVIDERI.has(p)) return { provider: p, model }
  // Nije ime providera nego oznaka inačice („qwen3:8b", „mistral:instruct") — dvotočka
  // pripada imenu modela, a takav spec je oduvijek značio Ollamu.
  return { provider: 'ollama', model: spec }
}

/**
 * CLI override modela. NE dira `config/adversarial-verify.json` — ručno mjerenje smije
 * promijeniti panel za jedan prolaz, ali zadano ponašanje sustava ostaje `nacin: off` s
 * lokalnim modelima dok Goran ne odluči drugačije.
 *
 *   --modeli "anthropic:opus"                     → sve tri leće
 *   --modeli "dokaz=claude:opus,doseg=ollama:x"   → po leći
 */
export function primijeniOverride(
  modeli: Record<IdLece, string>,
  izraz?: string | null,
): { modeli: Record<IdLece, string>; dirnuto: boolean } {
  const out = { ...modeli }
  const s = String(izraz || '').trim()
  if (!s) return { modeli: out, dirnuto: false }
  if (!s.includes('=')) {
    for (const k of Object.keys(out) as IdLece[]) out[k] = s
    return { modeli: out, dirnuto: true }
  }
  for (const dio of s.split(',')) {
    const j = dio.indexOf('=')
    if (j < 0) continue
    const leca = dio.slice(0, j).trim() as IdLece
    if (!(leca in out)) throw new Error(`override: nepoznata leća „${leca}" (poznate: ${Object.keys(out).join(', ')})`)
    out[leca] = dio.slice(j + 1).trim()
  }
  return { modeli: out, dirnuto: true }
}

export function baseUrlOllame(): string {
  try {
    const mc = JSON.parse(readFileSync(join(HOME, '.claude/regoc/models/model-config.json'), 'utf-8'))
    return mc?.providers?.ollama?.baseUrl || ollamaUrl()
  } catch { return ollamaUrl() }
}

export function napraviPozivac(opts: PozivacOpts): Pozivac {
  const modeli = opts.modeli
  const trosak: TrosakZapis[] = []
  let ollama: ChatLike | null = null
  let anthropic: ChatLike | null = null

  const dajOllamu = (): ChatLike => {
    if (!ollama) {
      ollama = opts.tvornice?.ollama
        ? opts.tvornice.ollama(opts.ollamaBaseUrl || baseUrlOllame())
        : new (require('../../models/providers/OllamaProvider').OllamaProvider)(opts.ollamaBaseUrl || baseUrlOllame())
    }
    return ollama!
  }
  const dajAnthropic = (): ChatLike => {
    if (!anthropic) {
      anthropic = opts.tvornice?.anthropic
        ? opts.tvornice.anthropic()
        : new (require('../../models/providers/AnthropicProvider').AnthropicProvider)(undefined, undefined, {
            dodatniArgumenti: opts.anthropicArgumenti || ['--restricted'],
            mjeriTrosak: true,
          })
    }
    return anthropic!
  }

  /**
   * Sudac po (agent, razina) — napravi se najviše jednom po kombinaciji, jer svaki nosi
   * VLASTITI red usporednosti 1 i vlastito brojilo troška.
   */
  const suci = new Map<string, Sudac>()
  const dajSudca = (agentId: string, razina: RazinaSuca, rokMs: number, korijeniDokaza?: string[]): Sudac => {
    const kljuc = `${agentId}/${razina}`
    let s = suci.get(kljuc)
    if (!s) {
      const spec: SudacSpec = {
        agentId, razina, rokMs,
        proracunUsd: opts.proracunUsdPoLeci ?? 0.25,
        ...(korijeniDokaza && korijeniDokaza.length ? { korijeniDokaza } : {}),
      }
      s = opts.tvornice?.sudac
        ? opts.tvornice.sudac(spec)
        : (require('../../Sudac').napraviSuca as (x: SudacSpec) => Sudac)(spec)
      suci.set(kljuc, s)
    }
    return s
  }

  /**
   * Razina alata po PRAVILU, ne po ukusu (dizajn §5): leća `protuobjasnjenje` pita o
   * rasuđivanju, ne o stanju diska — ondje alati troše i ne donose, pa je uvijek `tekst`.
   * Ostale leće slušaju spec: `agent:<id>/alati` traži alate, `agent:<id>` ne traži.
   */
  function razinaZaLecu(model: string, leca: IdLece): { agentId: string; razina: RazinaSuca } {
    const kosa = model.indexOf('/')
    const agentId = kosa >= 0 ? model.slice(0, kosa) : model
    const trazeniAlati = kosa >= 0 && model.slice(kosa + 1).toLowerCase() === 'alati'
    return { agentId, razina: trazeniAlati && leca !== 'protuobjasnjenje' ? 'alati' : 'tekst' }
  }

  let red: Promise<unknown> = Promise.resolve()
  const uRedu = <T,>(fn: () => Promise<T>): Promise<T> => {
    if (opts.uRedu === false) return fn()
    const p = red.then(fn, fn)
    red = p.catch(() => {})
    return p
  }

  const pozovi = (u: PozivUlaz): Promise<PozivIzlaz> => uRedu(async () => {
    const spec = modeli[u.leca as IdLece]
    if (!spec) throw new Error(`leća ${u.leca}: nema modela u konfiguraciji`)
    const { provider, model } = razlomiModel(spec)
    const t0 = Date.now()
    let r: Awaited<ReturnType<ChatLike['chat']>>
    if (provider === 'ollama') {
      r = await dajOllamu().chat([{ role: 'user', content: u.prompt }], {
        // temperature 0 — provjeravatelj koji na isti nalaz dva puta odgovori različito
        // nije neovisan glas nego šum, a šum bi napuhao mjerilo pada.
        model, temperature: 0, maxTokens: 700, timeout: Math.max(30_000, u.rokMs - 5_000),
      })
    } else if (provider === 'anthropic') {
      r = await dajAnthropic().chat([{ role: 'user', content: u.prompt }], {
        model, temperature: 0, maxTokens: 700, timeout: Math.max(30_000, u.rokMs - 5_000),
      })
    } else if (provider === 'agent') {
      // Agent-vratar (TASK-4839). Sud je POVRATNA VRIJEDNOST, ne poruka na ploči — zato
      // `Sudac.pitaj`, a nikad `spawnAgentOnDemand` (vatra-i-zaboravi, utor, ADR-0012 §2).
      const { agentId, razina } = razinaZaLecu(model, u.leca as IdLece)
      const s = dajSudca(agentId, razina, Math.max(30_000, u.rokMs))
      const o = await s.pitaj({ prompt: u.prompt, oznaka: `${u.leca}/${u.nalazId}`, rokMs: u.rokMs })
      trosak.push({
        leca: u.leca as IdLece, nalazId: u.nalazId, spec, razina, greska: o.greska,
        cijenaUsd: o.cijenaUsd, latencyMs: o.latencyMs, ulazTokena: null, izlazTokena: null,
      })
      // Ishod bez suda (rok, osigurač, brana, dirnuo-dokaz) vraća PRAZAN tekst: `parsirajSud`
      // ga tada čita kao `nema_json` → `ne-znam`, pa nalaz ostaje neprovjeren umjesto da
      // vlastiti kvar vratara ispadne kao presuda o tuđem radu (§7.4).
      return { tekst: o.greska ? '' : o.tekst, model: spec }
    } else {
      throw new Error(`leća ${u.leca}: provider „${provider}" nije podržan (poznati: ollama, anthropic/claude, agent)`)
    }
    trosak.push({
      leca: u.leca as IdLece, nalazId: u.nalazId, spec,
      cijenaUsd: Number.isFinite(Number(r.costUsd)) ? Number(r.costUsd) : null,
      latencyMs: Date.now() - t0,
      ulazTokena: r.usage?.inputTokens ?? null, izlazTokena: r.usage?.outputTokens ?? null,
    })
    return { tekst: r.content || '', model: spec }
  })

  return {
    deps: { pozovi } as ProvjeraDeps,
    trosak,
    ukupnoUsd: () => trosak.reduce((a, t) => a + (t.cijenaUsd ?? 0), 0),
    bezCijene: () => trosak.filter((t) => t.cijenaUsd === null).length,
    koristiOllamu: () => Object.values(modeli).some((s) => razlomiModel(s).provider === 'ollama'),
  }
}
