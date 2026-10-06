// ─── Glas — lokalni STT i TTS za razgovor (TASK-5294) ────────────────────────
// Glasovna poruka → `POST <url>/stt` (sirovi bajtovi) → tekst; odgovor → `POST <url>/tts`
// (`{text, voice?}`) → ogg/opus. Servis je LOKALAN (zadano 127.0.0.1:8899, faster-whisper +
// piper) — zvuk ne ide ni na glavni stroj ni u oblak.
//
// Sve funkcije vraćaju ishod, ne bacaju: glas je dodatak razgovoru, pa njegov kvar ne smije
// zaustaviti ni poller ni odgovor (fail-open, uz vidljivu oznaku na mjestu poziva).
//
// Autorica: Jelena (Engineer), TASK-5294.

export const GLAS_ZADANI_URL = 'http://127.0.0.1:8899'

export type GlasNacin = 'off' | 'na-glasovno' | 'uvijek'
export const GLAS_NACINI: readonly GlasNacin[] = ['off', 'na-glasovno', 'uvijek']

/** Najdulji tekst koji se izgovara — piper na CPU-u treba ~1 s po rečenici, ostatak je u tekstu. */
export const MAX_GOVOR_ZNAKOVA = 1200

export const OZNAKA_STT_KVAR = '🎙️🚫 transkript nije uspio'
export const OZNAKA_TTS_KVAR = '🔊🚫 glasovni odgovor nije uspio'

const bezKose = (url: string) => (url || GLAS_ZADANI_URL).replace(/\/+$/, '')

/** fetch s tvrdim rokom: servis koji visi ne smije zadržati poller duže od roka. */
async function sRokom(f: typeof fetch, url: string, init: RequestInit, rokMs: number): Promise<Response> {
  const ac = new AbortController()
  let tajmer: ReturnType<typeof setTimeout> | undefined
  const rok = new Promise<never>((_, odbij) => {
    tajmer = setTimeout(() => { ac.abort(); odbij(new Error(`rok ${Math.round(rokMs / 1000)} s istekao`)) }, rokMs)
  })
  try {
    return await Promise.race([f(url, { ...init, signal: ac.signal }), rok])
  } finally {
    clearTimeout(tajmer)
  }
}

async function greskaIz(r: Response): Promise<string> {
  const t = await r.text().catch(() => '')
  let poruka = t
  try { poruka = JSON.parse(t)?.error || t } catch { /* nije JSON */ }
  return `HTTP ${r.status}${poruka ? `: ${String(poruka).slice(0, 160)}` : ''}`
}

export type IshodStt = { ok: true; tekst: string; sekundi?: number } | { ok: false; greska: string }
export type IshodTts = { ok: true; ogg: Uint8Array } | { ok: false; greska: string }

export async function prepoznajGovor(o: {
  url: string; bajtovi: Uint8Array; vrsta: string; rokMs: number; fetchImpl?: typeof fetch
}): Promise<IshodStt> {
  try {
    const r = await sRokom(o.fetchImpl ?? fetch, `${bezKose(o.url)}/stt`, {
      method: 'POST', headers: { 'Content-Type': o.vrsta }, body: o.bajtovi,
    }, o.rokMs)
    if (!r.ok) return { ok: false, greska: await greskaIz(r) }
    const j: any = await r.json().catch(() => ({}))
    const tekst = String(j?.text ?? '').trim()
    if (!tekst) return { ok: false, greska: j?.error ? String(j.error).slice(0, 160) : 'prazan transkript' }
    return { ok: true, tekst, ...(typeof j.seconds === 'number' ? { sekundi: j.seconds } : {}) }
  } catch (e: any) {
    return { ok: false, greska: String(e?.message || e).slice(0, 200) }
  }
}

export async function sintetizirajGovor(o: {
  url: string; tekst: string; glas: string; rokMs: number; fetchImpl?: typeof fetch
}): Promise<IshodTts> {
  try {
    const r = await sRokom(o.fetchImpl ?? fetch, `${bezKose(o.url)}/tts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: o.tekst, ...(o.glas ? { voice: o.glas } : {}) }),
    }, o.rokMs)
    if (!r.ok) return { ok: false, greska: await greskaIz(r) }
    if (/json|text/i.test(r.headers.get('content-type') || '')) return { ok: false, greska: await greskaIz(r) }
    const ogg = new Uint8Array(await r.arrayBuffer())
    if (!ogg.byteLength) return { ok: false, greska: 'prazan zvuk' }
    return { ok: true, ogg }
  } catch (e: any) {
    return { ok: false, greska: String(e?.message || e).slice(0, 200) }
  }
}

export function trebaGlasovniOdgovor(nacin: GlasNacin, glasovnoPitanje: boolean): boolean {
  return nacin === 'uvijek' || (nacin === 'na-glasovno' && glasovnoPitanje)
}

/** Vrsta zvuka za servis (po njoj bira nastavak, a time i dekoder). */
export function vrstaZvuka(vrsta: 'voice' | 'audio' | 'video_note', mime?: string): string {
  if (vrsta === 'video_note') return 'video/mp4'
  if (mime && /^[\w.+-]+\/[\w.+-]+$/.test(mime)) return mime
  return vrsta === 'voice' ? 'audio/ogg' : 'audio/mpeg'
}

/**
 * Odgovor modela → tekst koji se izgovara: bez blokova koda, poveznica, markdowna i emojija
 * (piper ih čita slovo po slovo). Predugačak se reže na granici rečenice.
 */
export function tekstZaGovor(odgovor: string, max = MAX_GOVOR_ZNAKOVA): string {
  const t = odgovor
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]*?\S)\1/g, '$2')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/[ \t]*\n+[ \t]*/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!/[\p{L}\p{N}]/u.test(t)) return ''
  if (t.length <= max) return t
  const rez = t.slice(0, max)
  const kraj = Math.max(rez.lastIndexOf('. '), rez.lastIndexOf('! '), rez.lastIndexOf('? '))
  return kraj > max * 0.3 ? rez.slice(0, kraj + 1) : rez.slice(0, rez.lastIndexOf(' ') > 0 ? rez.lastIndexOf(' ') : max)
}

export interface StanjeGlasa {
  ok: boolean
  /** Zadani glas servisa (ime bez putanje i `.onnx`). */
  glas?: string
  /** Glasovi koje servis nudi za `voice` (ako ih javlja). */
  glasovi?: string[]
  sttModel?: string
  greska?: string
}

const imeGlasa = (v: unknown) => String(v ?? '').split('/').pop()!.replace(/\.onnx$/, '')

/** `GET <url>/health` za Config — kratak rok, jer ploča čeka odgovor. */
export async function stanjeGlasa(url: string, rokMs = 1500, fetchImpl?: typeof fetch): Promise<StanjeGlasa> {
  try {
    const r = await sRokom(fetchImpl ?? fetch, `${bezKose(url)}/health`, { method: 'GET' }, rokMs)
    if (!r.ok) return { ok: false, greska: await greskaIz(r) }
    const j: any = await r.json().catch(() => ({}))
    return {
      ok: j?.ok === true,
      ...(j?.voice ? { glas: imeGlasa(j.voice) } : {}),
      ...(Array.isArray(j?.voices) ? { glasovi: j.voices.map(imeGlasa).filter(Boolean) } : {}),
      ...(j?.stt_model ? { sttModel: String(j.stt_model) } : {}),
    }
  } catch (e: any) {
    return { ok: false, greska: String(e?.message || e).slice(0, 200) }
  }
}
