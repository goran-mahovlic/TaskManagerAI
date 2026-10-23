/**
 * Dežurni — most do rezervnog modela, U PAKETU (TASK-5359).
 *
 * vlasnik, 08.10.2026.: na node-A Test dežurnog je javljao „most dežurnog nije na ovom stroju"
 * jer je ploča uvozila most našeg glavnog sustava (`tools/Telegram/dezurni.ts` pod $HOME).
 * Paket ga nije nosio, pa ni razgovor ni agenti u zadatcima na tuđoj instalaciji nisu imali
 * rezervu. Ovdje je isti posao, ali sve putanje dolaze iz paketa:
 *   postavke   → `DEZURNI_CONFIG_PATH` (`TM_DEZURNI_CONFIG` → $TM_HOME/config → config/)
 *   davatelji  → `MODEL_CONFIG_PATH`
 *   ključevi   → `procitajTajnu` (okolina, pa spremište tajni paketa)
 *   stanje     → `$TM_HOME/data/dezurni.stanje.json` (isto čita kartica na ploči)
 *
 * PRAVILO IZ MOSTA (TASK-4709) OSTAJE: davatelj koji ne odgovori daje `null`, nikad izmišljen
 * tekst i nikad potiho drugog davatelja.
 *
 * Dva puta rezerve:
 *   • `ciljDezurnog()` — davatelj s Anthropic-kompatibilnim endpointom (OpenRouter, GLM, Kimi…)
 *     vozi ISTI `claude` CLI preusmjeren preko ANTHROPIC_BASE_URL: agent i razgovorni asistent zadržavaju
 *     alate i identitet.
 *   • `pitajModel()` — pet oblika poziva (Ollama, OpenAI, Anthropic-poruke, Google, claude-cli),
 *     samo tekst: za Test na ploči i za razgovor kad CLI puta nema (npr. Ollama).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { DEZURNI_CONFIG_PATH, MODEL_CONFIG_PATH, loadDezurniConfig, nacinPoziva, type NacinPoziva } from './DezurniConfig'
import { procitajTajnu } from './core/ConfigModul'
import { stanjePutanja } from './core/paths'
import { ciljRazgovora, jeAnthropicProvider, type CiljRazgovora } from './core/models/PrebaciSve'

const ROK_MS = 120_000

/** Sve što most čita s diska ili mreže — zadano iz paketa, u testu podmetnuto. */
export interface DezurniOpcije {
  dezPut?: string
  mcPut?: string
  stanjePut?: string
  citajTajnu?: (ime: string) => string | null
  /** Nadjačaj adresu OpenAI oblika (test); zadano po davatelju. */
  openaiUrl?: string
  fetchImpl?: typeof fetch
  sat?: () => number
}

function postavke(o: DezurniOpcije) { return loadDezurniConfig(o.dezPut || DEZURNI_CONFIG_PATH) }
const stanjeDatoteka = (o: DezurniOpcije) => o.stanjePut || stanjePutanja('dezurni.stanje.json')
const tajna = (o: DezurniOpcije, ime: string) => (o.citajTajnu || ((i: string) => procitajTajnu(i)))(ime) || ''

function davatelji(o: DezurniOpcije): Record<string, any> {
  try { return JSON.parse(readFileSync(o.mcPut || MODEL_CONFIG_PATH, 'utf-8'))?.providers || {} } catch { return {} }
}

// ── Pad primarnog modela ─────────────────────────────────────────────────────────────────
// Samo greške koje kažu „model/davatelj ne može" — rok i prekid NISU pad (dug posao ili
// vlasnikov stop), a „0 poteza" je blokiran spawn, koji rezervni model ne bi popravio.

export interface PadPrimarnog { vrsta: 'limit' | 'prijava' | 'nedostupan'; razlog: string }

const PADOVI: [PadPrimarnog['vrsta'], RegExp][] = [
  ['limit', /\b429\b|rate.?limit|usage limit|limit reached|hit your limit|too many requests|quota|credit balance/i],
  ['prijava', /\b401\b|unauthori[sz]ed|authentication_error|invalid (x-)?api.?key|please run \/login|not logged in|oauth token (has )?expired/i],
  ['nedostupan', /overloaded|\b529\b|\b50[0234]\b|service unavailable|ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|network error|mrežna greška|naredba se ne može pokrenuti/i],
]

export function jePadPrimarnog(tekst: string | null | undefined): PadPrimarnog | null {
  const t = String(tekst || '')
  if (!t.trim()) return null
  for (const [vrsta, re] of PADOVI) {
    const m = t.match(re)
    if (m) return { vrsta, razlog: m[0] }
  }
  return null
}

// ── Stanje dežurstva (preživi restart; isto čita kartica na ploči) ───────────────────────

export interface StanjeDezurstva {
  uzastopnihGresaka: number
  dezurstvo: boolean
  od?: string
  /** Do kada se pad primarnog SIMULIRA (ISO) — za provjeru rezerve bez stvarnog kvara. */
  simulacijaDo?: string
}

export function citajStanje(o: DezurniOpcije = {}): StanjeDezurstva {
  try {
    const s = JSON.parse(readFileSync(stanjeDatoteka(o), 'utf-8'))
    return { uzastopnihGresaka: Number(s.uzastopnihGresaka) || 0, dezurstvo: !!s.dezurstvo, ...(s.od ? { od: s.od } : {}), ...(s.simulacijaDo ? { simulacijaDo: s.simulacijaDo } : {}) }
  } catch { return { uzastopnihGresaka: 0, dezurstvo: false } }
}

function pisiStanje(o: DezurniOpcije, s: StanjeDezurstva): void {
  const put = stanjeDatoteka(o)
  try {
    mkdirSync(dirname(put), { recursive: true })
    writeFileSync(put + '.tmp', JSON.stringify(s, null, 1))
    renameSync(put + '.tmp', put)
  } catch { /* zapis stanja ne smije srušiti odgovor korisniku */ }
}

/** Primarni je pao. `pocinje` = prag dosegnut upravo sada. */
export function zabiljeziGresku(o: DezurniOpcije = {}): { pocinje: boolean; broj: number } {
  const p = postavke(o)
  const s = citajStanje(o)
  s.uzastopnihGresaka += 1
  const pocinje = !!p.ukljucen && !s.dezurstvo && s.uzastopnihGresaka >= Number(p.okidac_uzastopnih_gresaka || 1)
  if (pocinje) { s.dezurstvo = true; s.od = new Date((o.sat || Date.now)()).toISOString() }
  pisiStanje(o, s)
  return { pocinje, broj: s.uzastopnihGresaka }
}

/** Primarni je uspio: brojač na nulu, dežurstvo prestaje. */
export function zabiljeziUspjeh(o: DezurniOpcije = {}): { zavrsilo: boolean } {
  const s = citajStanje(o)
  const zavrsilo = s.dezurstvo
  if (s.uzastopnihGresaka || s.dezurstvo) {
    pisiStanje(o, { uzastopnihGresaka: 0, dezurstvo: false, ...(s.simulacijaDo ? { simulacijaDo: s.simulacijaDo } : {}) })
  }
  return { zavrsilo }
}

/** Simuliraj pad primarnog `minuta` minuta (0 = ugasi). Strop 60 — zaboravljena simulacija ne smije trajati. */
export function simulirajPad(minuta: number, o: DezurniOpcije = {}): StanjeDezurstva {
  const s = citajStanje(o)
  const m = Math.max(0, Math.min(60, Number(minuta) || 0))
  if (m) s.simulacijaDo = new Date((o.sat || Date.now)() + m * 60_000).toISOString()
  else delete s.simulacijaDo
  pisiStanje(o, s)
  return s
}

export function simulacijaPada(o: DezurniOpcije = {}): boolean {
  const s = citajStanje(o)
  return !!s.simulacijaDo && Date.parse(s.simulacijaDo) > (o.sat || Date.now)()
}

// ── Put kroz claude CLI (alati ostaju) ───────────────────────────────────────────────────

/**
 * `--model` + okolina za dežurnog kroz `claude` CLI. `null` kad davatelj nema
 * Anthropic-kompatibilan endpoint ili ključ, ili je i sam Anthropic (njegov pad je razlog
 * dežurstva, pa ga isti CLI ne može zamijeniti).
 */
export function ciljDezurnog(o: DezurniOpcije = {}): (CiljRazgovora & { spec: string }) | null {
  const p = postavke(o)
  if (!p.ukljucen || !p.provider || !p.model || jeAnthropicProvider(p.provider)) return null
  const spec = `${p.provider}:${p.model}`
  const c = ciljRazgovora(spec, davatelji(o), ime => tajna(o, ime) || null)
  if (c.greska || c.anthropic || !c.env.ANTHROPIC_BASE_URL) return null
  return { ...c, spec }
}

// ── Pet oblika poziva (isto kao most glavnog sustava, TASK-4709) ─────────────────────────

/**
 * OpenRouterovo polje `reasoning` iz postavke `reasoning` u dezurni.json (TASK-5631, isto pravilo
 * kao most glavnog sustava). Zadano ISKLJUČENO: izmjereno (TASK-5627) Mistral Large 4 inače potroši
 * sav max_tokens na razmišljanje (finish=length, prazan odgovor, ~120 s); s {enabled:false} 4,4 s.
 * `model` = polje se ne šalje; low/medium/high = effort.
 */
export function reasoningTijelo(v: unknown): { enabled: false } | { effort: string } | undefined {
  const t = String(v ?? 'off').toLowerCase()
  if (t === 'model') return undefined
  if (t === 'low' || t === 'medium' || t === 'high') return { effort: t }
  return { enabled: false }
}

/** `banke_dodatne` iz dezurni.json: valjana imena banaka [a-z0-9_], 1–64 znaka. Zadano prazno. */
export function dodatneBanke(v: unknown): string[] {
  return (Array.isArray(v) ? v : []).map(x => String(x)).filter(b => /^[a-z0-9_]{1,64}$/.test(b))
}

interface Zahtjev { p: Record<string, any>; sustav: string; pitanje: string; tokena: number; konf: Record<string, any>; o: DezurniOpcije; samoSadrzaj?: boolean }

export const NACIN_POZIVA_MOSTA: Record<NacinPoziva, (z: Zahtjev) => Promise<string | null>> = {
  ollama: async ({ p, sustav, pitanje, tokena, o }) => {
    if (!p.baseUrl) return null
    const r = await (o.fetchImpl || fetch)(`${String(p.baseUrl).replace(/\/+$/, '')}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(ROK_MS),
      body: JSON.stringify({
        model: p.model, stream: false, think: false, options: { temperature: 0, num_predict: tokena },
        messages: [{ role: 'system', content: sustav }, { role: 'user', content: pitanje }],
      }),
    })
    if (!r.ok) return null
    return String((await r.json())?.message?.content || '').trim() || null
  },

  // Pretplata preko `claude -p`: ima smisla samo kad uzrok kvara nije bio Anthropic.
  'claude-cli': async ({ p, sustav, pitanje }) => {
    try {
      const proc = Bun.spawn(['claude', '-p', `${sustav}\n\n${pitanje}`, ...(p.model ? ['--model', p.model] : [])],
        { stdout: 'pipe', stderr: 'ignore' })
      const izlaz = await new Response(proc.stdout).text()
      await proc.exited
      if (/operation blocked by hook:/i.test(izlaz)) return null
      return izlaz.trim() || null
    } catch { return null }
  },

  openai: async ({ p, sustav, pitanje, tokena, o, samoSadrzaj }) => {
    const ime = String(p.provider).toLowerCase()
    const reasoning = ime === 'openrouter' ? reasoningTijelo(p.reasoning) : undefined
    const url = o.openaiUrl || (ime === 'openrouter'
      ? 'https://openrouter.ai/api/v1/chat/completions'
      : 'https://api.openai.com/v1/chat/completions')
    const kljuc = tajna(o, ime === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY')
    if (!kljuc) return null
    const r = await (o.fetchImpl || fetch)(url, {
      method: 'POST', signal: AbortSignal.timeout(ROK_MS),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + kljuc },
      body: JSON.stringify({
        model: p.model, max_tokens: tokena, temperature: 0,
        ...(reasoning ? { reasoning } : {}),
        messages: [{ role: 'system', content: sustav }, { role: 'user', content: pitanje }],
      }),
    })
    if (!r.ok) return null
    const por = ((await r.json())?.choices || [{}])[0]?.message || {}
    // Neki modeli vrate `content: null`, a odgovor stave u `reasoning` (izmjereno na OpenRouteru:
    // Mistral Large 4, node-A 08.10.2026.). Za probu to znači „davatelj radi"; korisniku se
    // razmišljanje modela NE šalje (`samoSadrzaj`).
    return String(por.content || (samoSadrzaj ? '' : por.reasoning) || '').trim() || null
  },

  anthropic: async ({ p, sustav, pitanje, tokena, konf, o }) => {
    const baseUrl = String(konf.baseUrl || '')
    const env = String(konf.apiKey || '')
    const kljuc = tajna(o, env.startsWith('env:') ? env.slice(4) : '')
    if (!baseUrl || !kljuc) return null
    const r = await (o.fetchImpl || fetch)(baseUrl.replace(/\/+$/, '') + '/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(ROK_MS),
      headers: { 'Content-Type': 'application/json', 'x-api-key': kljuc, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: p.model, max_tokens: tokena, system: sustav, messages: [{ role: 'user', content: pitanje }] }),
    })
    if (!r.ok) return null
    const dijelovi = ((await r.json())?.content || []).filter((c: any) => c?.type === 'text').map((c: any) => c.text || '')
    return dijelovi.join('\n').trim() || null
  },

  google: async ({ p, sustav, pitanje, tokena, konf, o }) => {
    // Ključ AI Studija stoji pod GEMINI_API_KEY (stranica Tajne, Gemini CLI) ili GOOGLE_API_KEY;
    // `apiKey: "env:A|B"` iz model-config.json ima prednost (TASK-5730).
    const env = String(konf.apiKey || '')
    const imena = [...new Set([...(env.startsWith('env:') ? env.slice(4).split('|') : []), 'GEMINI_API_KEY', 'GOOGLE_API_KEY']
      .map(x => x.trim()).filter(Boolean))]
    let kljuc = ''
    for (const ime of imena) { kljuc = tajna(o, ime); if (kljuc) break }
    if (!kljuc) return null
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(p.model || 'gemini-3.8-flash') + ':generateContent?key=' + encodeURIComponent(kljuc)
    const r = await (o.fetchImpl || fetch)(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(ROK_MS),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sustav }] },
        contents: [{ parts: [{ text: pitanje }] }],
        generationConfig: { temperature: 0, maxOutputTokens: tokena },
      }),
    })
    if (!r.ok) return null
    const kand = ((await r.json())?.candidates || [{}])[0]
    return ((kand?.content || {}).parts || []).map((x: any) => x.text || '').join('\n').trim() || null
  },
}

/** Pošalji sustavnu poruku i pitanje dežurnom. `null` = nije odgovorio. */
export async function pitajModel(
  sustav: string, pitanje: string, tokena = 400, o: DezurniOpcije = {}, opcije: { samoSadrzaj?: boolean } = {},
): Promise<string | null> {
  const p = postavke(o)
  const ime = String(p.provider || 'ollama').toLowerCase()
  const konf = davatelji(o)[ime] || {}
  const nacin = nacinPoziva(ime, konf)
  if (!nacin) return null
  try { return await NACIN_POZIVA_MOSTA[nacin]({ p, sustav, pitanje, tokena, konf, o, samoSadrzaj: opcije.samoSadrzaj }) } catch { return null }
}

export interface ProbaIshod { ok: boolean; provider: string; model: string; odgovor?: string; greska?: string; ms: number; nacin?: string }

/** Probni poziv postavljenog dežurnog — Test na ploči. Mjeri STVARNI prolaz do modela. */
export async function probaModela(o: DezurniOpcije = {}, pitanje = 'Odgovori jednom rijecju: radi.'): Promise<ProbaIshod> {
  const p = postavke(o)
  const t0 = Date.now()
  const nacin = nacinPoziva(String(p.provider || ''), davatelji(o)[String(p.provider || '').toLowerCase()] || {})
  if (!nacin) return { ok: false, provider: p.provider, model: p.model, ms: 0, greska: `most dežurnog ne zna pozvati davatelja "${p.provider}"` }
  // 200 tokena: modeli koji „misle naglas" potroše mali proračun i vrate prazan `content`.
  const odgovor = await pitajModel('Ti si dezurni agent. Odgovaraj kratko.', pitanje, 200, o)
  const ms = Date.now() - t0
  return odgovor
    ? { ok: true, provider: p.provider, model: p.model, odgovor, ms, nacin }
    : { ok: false, provider: p.provider, model: p.model, ms, nacin, greska: `davatelj "${p.provider}" nije odgovorio (model "${p.model}", oblik ${nacin})` }
}

// ── Razina konteksta (TASK-5626) ─────────────────────────────────────────────────────────
// Isto pravilo kao most glavnog sustava (`tools/Telegram/lib/DezurniKontekst.ts`): slab model
// (lokalni ili ≤ 30 mlrd. parametara / mini, nano, small, tiny, lite) dobiva kratku sistemsku
// poruku; jak model dobiva identitet razgovora. Postavka `kontekst` (auto|kratki|puni) u
// dezurni.json nadjačava prepoznavanje.

export type RazinaKonteksta = 'kratki' | 'puni'

/** max_tokens tekstnog dežurnog. Izmjereno (TASK-5626): Mistral Large 4 potroši ~1000 tokena
 *  na razmišljanje i na trivijalno pitanje, pa puni kontekst treba više. */
export const TOKENA_DEZURNOG: Record<RazinaKonteksta, number> = { kratki: 2000, puni: 4000 }

export function jeSlabModel(provider: string, model: string): boolean {
  const p = String(provider || '').toLowerCase()
  const m = String(model || '').toLowerCase()
  if (p === 'ollama') return true
  if (/(?:^|[^\d.])(?:[1-9]|[12]\d|30)(?:\.\d+)?b\b/.test(m)) return true
  return /\b(?:mini|nano|small|tiny|lite)\b/.test(m.replace(/[-_:/.]/g, ' '))
}

export function razinaKonteksta(p: { provider?: string; model?: string; kontekst?: unknown }): RazinaKonteksta {
  const k = String(p?.kontekst ?? 'auto').toLowerCase()
  if (k === 'kratki' || k === 'puni') return k
  return jeSlabModel(String(p?.provider ?? ''), String(p?.model ?? '')) ? 'kratki' : 'puni'
}

// ── Sučelje za razgovor i orkestrator ────────────────────────────────────────────────────

export interface DezurniRazgovora {
  /** Je li dežurni uopće uključen u postavkama. */
  ukljucen(): boolean
  opis(): string
  simulacija(): boolean
  jePad(tekst: string): PadPrimarnog | null
  cilj(): (CiljRazgovora & { spec: string }) | null
  pitaj(sustav: string, pitanje: string, tokena?: number): Promise<string | null>
  /** TASK-5626: koliko konteksta tekstni dežurni dobiva. */
  razina(): RazinaKonteksta
  /** TASK-5631: banke Hindsighta uz glavnu za puni kontekst (`banke_dodatne`, zadano prazno). */
  dodatneBanke(): string[]
  greska(): { pocinje: boolean; broj: number }
  uspjeh(): { zavrsilo: boolean }
}

export function dezurniRazgovora(o: DezurniOpcije = {}): DezurniRazgovora {
  return {
    ukljucen: () => !!postavke(o).ukljucen,
    opis: () => { const p = postavke(o); return `${p.provider}/${p.model}` },
    simulacija: () => simulacijaPada(o),
    jePad: jePadPrimarnog,
    cilj: () => ciljDezurnog(o),
    // 2000 tokena: modeli koji „misle naglas" potroše dio na razmišljanje prije odgovora.
    pitaj: (sustav, pitanje, tokena) => pitajModel(sustav, pitanje, tokena ?? TOKENA_DEZURNOG.kratki, o, { samoSadrzaj: true }),
    razina: () => razinaKonteksta(postavke(o)),
    dodatneBanke: () => dodatneBanke((postavke(o) as Record<string, unknown>).banke_dodatne),
    greska: () => zabiljeziGresku(o),
    uspjeh: () => zabiljeziUspjeh(o),
  }
}
