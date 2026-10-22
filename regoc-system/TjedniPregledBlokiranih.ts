#!/usr/bin/env bun
/**
 * TjedniPregledBlokiranih — svaki ponedjeljak pregled blokiranih zadataka Goranu.
 *
 * TASK-5215 (Goranov nalog 04.10.2026.). Povod: ručna revizija 04.10. arhivirala je 39 zadataka
 * koji su trunuli od srpnja. StaleWatchdog ih je uredno OZNAČIO („zastarjelo → tjedni popis
 * [ARHIVA]”, „razina 2: > 14 d čeka Gorana”), ali taj popis nitko nije slao.
 *
 * Tri dijela, svaki čist i ispitan (fetch i slanje se ubrizgavaju):
 *   1. OKIDAČ  — ponedjeljak 09:00 Europe/Zagreb (+ prozor nadoknade 72 h) otvara JEDAN zadatak
 *                „Tjedni pregled blokiranih <datum>” za Jelenu. Idempotentno po tjednu: stanje u
 *                data/tjedni_pregled_blokiranih.json + provjera na ploči po oznaci (preživi gubitak
 *                stanja). Petlju vrti budilica.sh (ponavljanje), a nju diže EnsureRegocDaemon.
 *                Pričuva: ako agent ni 3 h nakon otvaranja nije poslao izvještaj, šalje se
 *                deterministički nacrt — izvještaj stiže i kad su vrata autonomije zatvorena.
 *   2. SADRŽAJ — iste presude kao daemon (StaleWatchdog.decideBlockedTask/evaluateBlockedTasks)
 *                + dnevnici revizije, siročadi i zombija → brojke, ZASTARJELO, ČEKA TEBE (opcije
 *                A/B/C + preporuka; opcije iz bloka „PITANJE ZA ODLUKU” kad postoji), anomalije.
 *                Izvještaj je MD datoteka (docs/izvjestaji/tjedni-pregled/TJEDNI-PREGLED-<datum>.md,
 *                + ZADNJI.md i README.md indeks); u grupu ide NAJVIŠE JEDNA poruka: brojke u 2–3
 *                retka kao opis dokumenta (sendDocument). Uputa #153, Goran 04.10.: ne 3 poruke × 4000.
 *   3. NAREDBE — Goranov odgovor u grupi REGOČ: „arhiviraj 2461, 2462”, „5136 B”, „pusti 3553”.
 *                Prepoznaje ih Klaudio (telegram_agent.ts) po obrascu TelegramUputa.ts (ADR-0013),
 *                ne daemon. Puštanje i odluka idu postojećim POST /api/tasks/<ID>/odluka (gumb
 *                „Nastavi” na ploči); arhiva = [ARHIVA] + oznaka arhiva + resultSummary + cancelled,
 *                isto kao ručna revizija 04.10. Projekti se NIKAD ne arhiviraju.
 *
 * CLI:
 *   bun TjedniPregledBlokiranih.ts okidac [--sada] [--dry-run]   # petlja; --sada = probni prolaz odmah
 *   bun TjedniPregledBlokiranih.ts nacrt [--json]                # deterministički izvještaj (MD na stdout)
 *   bun TjedniPregledBlokiranih.ts posalji [--datoteka F.md] [--stavke F.json] [--dry-run]  # 1 poruka + dokument
 *   bun TjedniPregledBlokiranih.ts stanje
 *
 * Autor: Jelena (Engineer) · 2026-10-04
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, readSync, closeSync, fstatSync, readdirSync } from 'fs'
import { join, dirname, basename } from 'path'
import {
  UVIJEK_GORANU, RIZICNE_KLASE, PUSTANJA, cekaNa,
  type BlockedDecision, type BlockedTask, type BlockedReviewConfig, type UzrokProvjera,
} from './StaleWatchdog'
import { rasclaniPitanje, type OdlukaOpcija } from './OdlukaPitanje'
import { homedir } from 'os'
import { okolina } from './lib/okolina-sustava' // TASK-5700 (K3a)

const HOME = process.env.HOME || homedir()
const REGOC = join(HOME, '.claude', 'regoc')
export const STANJE_PUT = join(REGOC, 'data', 'tjedni_pregled_blokiranih.json')
/** Gdje žive izvještaji (git repo regoc_system — povijest ostaje). */
export const IZVJESTAJ_DIR = join(HOME, 'app', 'regoc_system', 'docs', 'izvjestaji', 'tjedni-pregled')
export const CHAT_REGOC = okolina().telegram.chatRegoc  // TASK-5700: config/okolina.json
export const OZNAKA_PREGLEDA = 'tjedni-pregled'
/** Tko smije zadavati naredbe (Telegram user id) — Goran. */
export const DOPUSTENI_ZADANO = okolina().telegram.dopusteni
const D_MS = 86_400_000
const TZ = 'Europe/Zagreb'

// ─── 1. OKIDAČ ────────────────────────────────────────────────────────────────────────────

export interface ZagrebVrijeme { datum: string; dan: number; sat: number; minuta: number }

/** Zidni sat u Zagrebu (ljetno/zimsko računanje rješava Intl). dan: 1 = ponedjeljak … 7 = nedjelja. */
export function zagrebVrijeme(ms: number): ZagrebVrijeme {
  const dijelovi = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    weekday: 'short', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map(p => [p.type, p.value]))
  const dani: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
  return {
    datum: `${dijelovi.year}-${dijelovi.month}-${dijelovi.day}`,
    dan: dani[dijelovi.weekday] || 1, sat: Number(dijelovi.hour), minuta: Number(dijelovi.minute),
  }
}

/** Ključ tjedna = nadnevak ponedjeljka (Zagreb). Nedjelja pripada tjednu koji je počeo prije 6 dana. */
export function tjedniKljuc(ms: number): string {
  const z = zagrebVrijeme(ms)
  const [y, m, d] = z.datum.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d!) - (z.dan - 1) * D_MS).toISOString().slice(0, 10)
}

export function hrDatum(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}.${m}.${y}.`
}

export const naslovPregleda = (kljuc: string) => `Tjedni pregled blokiranih ${hrDatum(kljuc)}`

export interface StavkaStanja { sekcija: 'zastarjelo' | 'cekaGorana'; zasto: string; opcije: OdlukaOpcija[] }
export interface StanjePregleda {
  /** Tjedan za koji je zadatak otvoren (ključ = ponedjeljak). */
  zadnjiTjedan?: string
  taskId?: string
  otvorenoMs?: number
  /** Tjedan za koji je izvještaj poslan (agent kroz `posalji` ili pričuva). */
  poslanoTjedan?: string
  /** Opcije zadnjeg poslanog izvještaja — iz njih Klaudio razrješava „5136 B”. */
  zadnjiPregled?: { kljuc: string; ts: string; stavke: Record<string, StavkaStanja> }
}

/**
 * Okida ako je u Zagrebu ponedjeljak ≥ 09:00 (ili najviše `prozorSati` poslije — kontejner je
 * mogao biti ugašen) i za taj tjedan još nije otvoren zadatak.
 */
export function odlukaOkidaca(ms: number, stanje: StanjePregleda, o: { sat?: number; prozorSati?: number } = {}) {
  const sat = o.sat ?? 9
  const prozor = (o.prozorSati ?? 72) * 60
  const z = zagrebVrijeme(ms)
  const kljuc = tjedniKljuc(ms)
  const protekloMin = (z.dan - 1) * 1440 + (z.sat - sat) * 60 + z.minuta
  if (protekloMin < 0) return { okini: false, kljuc, razlog: `prije ponedjeljka ${sat}:00` }
  if (protekloMin >= prozor) return { okini: false, kljuc, razlog: `izvan prozora (${Math.floor(protekloMin / 60)} h od ponedjeljka ${sat}:00)` }
  if (stanje.zadnjiTjedan === kljuc) return { okini: false, kljuc, razlog: `tjedan ${kljuc} već otvoren (${stanje.taskId || '?'})` }
  return { okini: true, kljuc, razlog: `ponedjeljak ${kljuc}, ${Math.floor(protekloMin / 60)} h od ${sat}:00` }
}

export function citajStanje(put = STANJE_PUT): StanjePregleda {
  try { return JSON.parse(readFileSync(put, 'utf-8')) || {} } catch { return {} }
}

export function spremiStanje(s: StanjePregleda, put = STANJE_PUT): void {
  mkdirSync(dirname(put), { recursive: true })
  const tmp = `${put}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(s, null, 1))
  renameSync(tmp, put)
}

export interface ApiOkolina { apiBase: string; fetch: typeof fetch; timeoutMs?: number }

async function api(env: ApiOkolina, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), env.timeoutMs ?? 15_000)
  try {
    const r = await env.fetch(env.apiBase + path, {
      ...init, signal: ctrl.signal,
      headers: init?.body ? { 'Content-Type': 'application/json', ...(init.headers || {}) } : init?.headers,
    })
    let body: any = null
    try { body = await r.json() } catch { /* prazno */ }
    return { status: r.status, body }
  } finally { clearTimeout(t) }
}

/** tekst = cijeli izvještaj (Markdown, ide u datoteku); sazetak = 2–3 retka za opis dokumenta u grupi. */
export interface Nacrt { tekst: string; sazetak: string; stavke: Record<string, StavkaStanja> }

/** Jedna poruka u grupu: dokument + kratki opis. Vraća true ako je Telegram primio. */
export type PosaljiDokument = (o: { datoteka: string; opis: string }) => Promise<boolean>

const atomicno = (put: string, sadrzaj: string) => {
  const tmp = `${put}.${process.pid}.tmp`
  writeFileSync(tmp, sadrzaj)
  renameSync(tmp, put)
}

/**
 * Zapiše izvještaj u `<dir>/TJEDNI-PREGLED-<oznaka>.md`, osvježi ZADNJI.md i README.md (indeks
 * najnovije → najstarije) i pošalje JEDNU poruku: dokument s opisom `uvod + sazetak`.
 */
export async function objaviIzvjestaj(o: {
  nacrt: Nacrt; oznaka: string; dir?: string; uvod?: string; posalji: PosaljiDokument
}): Promise<{ ok: boolean; datoteka: string; opis: string }> {
  const dir = o.dir ?? IZVJESTAJ_DIR
  mkdirSync(dir, { recursive: true })
  const datoteka = join(dir, `TJEDNI-PREGLED-${o.oznaka}.md`)
  const tekst = (o.uvod ? `> ${o.uvod}\n\n` : '') + o.nacrt.tekst.trimEnd() + '\n'
  atomicno(datoteka, tekst)
  atomicno(join(dir, 'ZADNJI.md'), tekst)
  const svi = readdirSync(dir).filter(f => /^TJEDNI-PREGLED-.+\.md$/.test(f)).sort().reverse()
  atomicno(join(dir, 'README.md'), [
    '# Tjedni pregled blokiranih — indeks',
    '',
    'Svaki ponedjeljak 09:00 (Europe/Zagreb) `TjedniPregledBlokiranih.ts` (TASK-5215). Najnoviji: [ZADNJI.md](ZADNJI.md).',
    'Odgovor u grupi REGOČ: „arhiviraj 2461, 2462”, „5136 B”, „pusti 3553” (provodi Klaudio).',
    '',
    ...svi.map(f => `- [${f.replace(/^TJEDNI-PREGLED-|\.md$/g, '')}](${f})`),
    '',
  ].join('\n'))
  const opis = kratko(o.uvod ? `${o.uvod}\n${o.nacrt.sazetak}` : o.nacrt.sazetak, 1000, true)
  const ok = await o.posalji({ datoteka, opis })
  return { ok, datoteka, opis }
}

export function opisZadatka(kljuc: string, nacrt: Nacrt): string {
  return [
    `Tjedni pregled blokiranih za tjedan ${hrDatum(kljuc)} (Goranov nalog 04.10.2026., TASK-5215).`,
    '',
    'ŠTO NAPRAVITI',
    '1. Svježi podaci: `bun ~/.claude/regoc/TjedniPregledBlokiranih.ts nacrt` (i `--json`). Presude su iste kao u daemonu (StaleWatchdog).',
    '2. Doradi nacrt: za ZASTARJELO jedna rečenica što je zadatak i zašto je zastario; za ČEKA TEBE kratko objašnjenje,',
    '   opcije A/B/C i preporuka (pročitaj opis zadatka ako zadane opcije ne odgovaraju). Opcija koja počinje s',
    '   „pusti” pušta zadatak, s „arhiviraj” ga arhivira, s „ostavi/odgodi” samo bilježi; ostalo je odluka + puštanje.',
    '   Hrvatski standardni jezik, kratko, Markdown (bez punog PAI formata). Projekti se nikad ne arhiviraju.',
    '3. Pošalji: izvještaj u .md datoteku, opcije (ako si ih mijenjao) u JSON {"TASK-X":{"sekcija":"cekaGorana","zasto":"…","opcije":[{"oznaka":"A","tekst":"…"}]}}, pa',
    '   `bun ~/.claude/regoc/TjedniPregledBlokiranih.ts posalji --datoteka <f.md> [--stavke <f.json>]`.',
    '   To zapiše docs/izvjestaji/tjedni-pregled/TJEDNI-PREGLED-<datum>.md i u grupu pošalje JEDNU poruku',
    '   (brojke u 2–3 retka + datoteka). NE šalji ništa drugo na Telegram (Goran 04.10., uputa #153).',
    '   `stanje` pokazuje je li pričuva (automatski nacrt nakon 3 h) već poslana — tada pošalji samo doradu.',
    '4. Goran odgovara u grupi („arhiviraj 2461, 2462”, „5136 B”, „pusti 3553”) — to provodi Klaudio, ne ti.',
    '5. Dokaz u odgovoru: izlaz naredbe `posalji` (ok → datoteka, 1 poruka u chat …).',
    '',
    '── DETERMINISTIČKI NACRT (u trenutku otvaranja) ──',
    nacrt.tekst,
  ].join('\n')
}

export async function okidacProlaz(o: {
  env: ApiOkolina; stanjePut?: string; now?: number; sada?: boolean; dryRun?: boolean
  nacrt: () => Promise<Nacrt>
  posalji: PosaljiDokument
  izvjestajDir?: string
  pricuvaSati?: number
}): Promise<{ radnja: 'otvoren' | 'vec-postoji' | 'pricuva' | 'proba-poslana' | 'nista' | 'greska'; poruka: string; taskId?: string; datoteka?: string }> {
  const put = o.stanjePut ?? STANJE_PUT
  const now = o.now ?? Date.now()
  const stanje = citajStanje(put)

  if (o.sada) {
    const n = await o.nacrt()
    if (o.dryRun) return { radnja: 'nista', poruka: `dry-run: proba bi zapisala ${n.tekst.length} znakova i poslala 1 poruku` }
    const oznaka = `${zagrebVrijeme(now).datum}-proba`
    const r = await objaviIzvjestaj({ nacrt: n, oznaka, dir: o.izvjestajDir, uvod: '🧪 Probni prolaz (ručni okidač --sada)', posalji: o.posalji })
    if (!r.ok) return { radnja: 'greska', poruka: `slanje probe nije uspjelo (izvještaj je zapisan: ${r.datoteka})`, datoteka: r.datoteka }
    spremiStanje({ ...stanje, zadnjiPregled: { kljuc: `proba-${zagrebVrijeme(now).datum}`, ts: new Date(now).toISOString(), stavke: n.stavke } }, put)
    return { radnja: 'proba-poslana', poruka: `proba poslana: 1 poruka + ${basename(r.datoteka)} (${n.tekst.length} znakova)`, datoteka: r.datoteka }
  }

  const odluka = odlukaOkidaca(now, stanje)
  if (odluka.okini) {
    const naslov = naslovPregleda(odluka.kljuc)
    const postoji = await api(o.env, `/api/tasks?tag=${encodeURIComponent(OZNAKA_PREGLEDA)}`)
    if (postoji.status !== 200 || !Array.isArray(postoji.body)) {
      return { radnja: 'greska', poruka: `ploča ne odgovara (HTTP ${postoji.status}) — pokušat ću u sljedećem prolazu` }
    }
    const isti = postoji.body.find((t: any) => String(t.title || '').trim() === naslov)
    if (isti) {
      spremiStanje({ ...stanje, zadnjiTjedan: odluka.kljuc, taskId: isti.id, otvorenoMs: stanje.otvorenoMs ?? now }, put)
      return { radnja: 'vec-postoji', poruka: `${isti.id} „${naslov}” već postoji`, taskId: isti.id }
    }
    const n = await o.nacrt()
    const tijelo = {
      title: naslov, description: opisZadatka(odluka.kljuc, n), assignee: 'jelena', priority: 2,
      projectId: 'REGOC_SYSTEM', createdBy: 'tjedni-pregled', tags: [`chat:${CHAT_REGOC}`, OZNAKA_PREGLEDA],
    }
    if (o.dryRun) return { radnja: 'nista', poruka: `dry-run: otvorio bi „${naslov}” (${tijelo.description.length} znakova opisa)` }
    const r = await api(o.env, '/api/tasks', { method: 'POST', body: JSON.stringify(tijelo) })
    const t = r.body?.task ?? r.body
    if (r.status >= 300 || !t?.id) return { radnja: 'greska', poruka: `otvaranje nije uspjelo: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}` }
    spremiStanje({ ...stanje, zadnjiTjedan: odluka.kljuc, taskId: t.id, otvorenoMs: now }, put)
    return { radnja: 'otvoren', poruka: `${t.id} „${naslov}” otvoren`, taskId: t.id }
  }

  // Pričuva: agent nije poslao izvještaj (vrata autonomije, kvota, pad) → deterministički nacrt.
  const kljuc = tjedniKljuc(now)
  const pricuvaMs = (o.pricuvaSati ?? 3) * 3_600_000
  if (stanje.zadnjiTjedan === kljuc && stanje.taskId && stanje.poslanoTjedan !== kljuc
      && typeof stanje.otvorenoMs === 'number' && now - stanje.otvorenoMs >= pricuvaMs) {
    const n = await o.nacrt()
    if (o.dryRun) return { radnja: 'nista', poruka: 'dry-run: poslala bi se pričuva' }
    const uvod = `⚙️ Automatski nacrt (${stanje.taskId} nije poslao izvještaj u ${o.pricuvaSati ?? 3} h)`
    const r = await objaviIzvjestaj({ nacrt: n, oznaka: kljuc, dir: o.izvjestajDir, uvod, posalji: o.posalji })
    if (!r.ok) return { radnja: 'greska', poruka: `slanje pričuve nije uspjelo (izvještaj je zapisan: ${r.datoteka})`, datoteka: r.datoteka }
    spremiStanje({ ...stanje, poslanoTjedan: kljuc, zadnjiPregled: { kljuc, ts: new Date(now).toISOString(), stavke: n.stavke } }, put)
    return { radnja: 'pricuva', poruka: `pričuva poslana za ${kljuc}: 1 poruka + ${basename(r.datoteka)}`, datoteka: r.datoteka }
  }
  return { radnja: 'nista', poruka: odluka.razlog }
}

// ─── 2. SADRŽAJ ───────────────────────────────────────────────────────────────────────────

export type Akcija = 'pusti' | 'arhiviraj' | 'ceka' | 'odluka'
/** Što opcija radi kad je Goran odabere — po prvoj riječi teksta. */
export function akcijaOpcije(tekst: string): Akcija {
  const t = String(tekst || '').trim()
  if (/^pusti/i.test(t)) return 'pusti'
  if (/^arhiv/i.test(t)) return 'arhiviraj'
  if (/^(ostavi|odgodi|odgoda|čekaj|cekaj|pričekaj|pricekaj)/i.test(t)) return 'ceka'
  return 'odluka'
}

export const ZADANE_OPCIJE: OdlukaOpcija[] = [
  { oznaka: 'A', tekst: 'pusti — vrati agentu u rad (uzrok je riješen)' },
  { oznaka: 'B', tekst: 'arhiviraj — zastarjelo, [ARHIVA] bez daljnjeg rada' },
  { oznaka: 'C', tekst: 'ostavi — neka čeka, podsjetnik idući tjedan' },
]

export interface StavkaPregleda { id: string; title: string; klasa: string; dana: number; zasto: string }
export interface StavkaGoranu extends StavkaPregleda { opcije: OdlukaOpcija[]; preporuka: string; izPitanja: boolean }
export interface PodaciPregleda {
  generirano: string; ukupno: number; poKlasi: Record<string, number>
  pusteno: string[]; zatvoreno: string[]; sjenaBiPustila: string[]
  novo: Array<{ id: string; title: string; klasa: string }>
  zastarjelo: StavkaPregleda[]; cekaGorana: StavkaGoranu[]; anomalije: string[]
}

const kratko = (s: string, n: number, redci = false) => {
  const t = redci ? String(s || '').trim() : String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}
const jedinstveni = (xs: string[]) => [...new Set(xs)]

function pitanjeZadatka(t: any) {
  const izvori = [String(t?.description || ''), ...((t?.progressNotes || []) as any[]).map(b => String(b?.note ?? b ?? ''))]
  for (let i = izvori.length - 1; i >= 0; i--) { const p = rasclaniPitanje(izvori[i]); if (p) return p }
  return null
}

export function sastaviPodatke(u: {
  now: number; tasks: BlockedTask[]; decisions: BlockedDecision[]
  revizija: any[]; siroce: any[]; zombi: any[]; okolina?: UzrokProvjera; config: BlockedReviewConfig
}): PodaciPregleda {
  const od = u.now - 7 * D_MS
  const svjez = (r: any) => Date.parse(String(r?.ts || '')) >= od
  const byId = new Map((u.tasks || []).map(t => [t.id, t as any]))
  const poKlasi: Record<string, number> = {}
  for (const d of u.decisions) poKlasi[d.klasa] = (poKlasi[d.klasa] || 0) + 1

  const rev = (u.revizija || []).filter(r => r?.taskId && svjez(r))
  const pusteno = jedinstveni(rev.filter(r => r.nacin === 'live' && r.izvedeno && (r.presuda === 'pusti' || r.presuda === 'otpusti-lanac')).map(r => r.taskId))
  const zatvoreno = jedinstveni(rev.filter(r => r.nacin === 'live' && r.izvedeno && r.presuda === 'zatvori-deploy').map(r => r.taskId))
  const sjenaBiPustila = jedinstveni(rev.filter(r => r.nacin === 'shadow' && PUSTANJA.includes(r.presuda)).map(r => r.taskId))

  const novo: PodaciPregleda['novo'] = []
  const zastarjelo: StavkaPregleda[] = []
  const cekaGorana: StavkaGoranu[] = []
  const anomalije: string[] = []

  for (const d of u.decisions) {
    const t = byId.get(d.taskId) || {}
    const title = String(t.title || d.title || '')
    const dana = Math.max(0, Math.floor((u.now - d.ulazakMs) / D_MS))
    const razlog = String(t.blockedReason || '').trim()
    const baza = { id: d.taskId, title, klasa: d.klasa, dana }
    if (d.ulazakMs >= od) novo.push({ id: d.taskId, title, klasa: d.klasa })

    const imaRoditelja = Array.isArray(t.blockedBy) && t.blockedBy.length > 0  // lanac: razlog je roditelj
    if (!razlog && !imaRoditelja) anomalije.push(`${d.taskId} blocked bez razloga${d.klasa === 'nepoznato' ? ' (i bez klase)' : ''} — „${kratko(title, 60)}”`)
    else if (d.klasa === 'nepoznato') anomalije.push(`${d.taskId} bez klase — razlog „${kratko(razlog, 80)}” ne prepoznaje nijedno pravilo`)
    if (d.klasa === 'lanac' && /cancelled|nepostoji/.test(d.razlog)) anomalije.push(`${d.taskId} lanac s mrtvim roditeljem — ${kratko(d.razlog, 100)}`)

    const prestar = d.presuda === 'razina2' && !['covjek', 'odluka', 'nepoznato'].includes(d.klasa)
    if (d.klasa === 'zastarjelo' || prestar || /^\s*\[ARHIVA\]/i.test(title)) {
      zastarjelo.push({ ...baza, zasto: d.klasa === 'zastarjelo' ? (cekaNa(razlog) || d.razlog) : d.razlog })
      continue
    }
    if (UVIJEK_GORANU.includes(d.klasa) || d.presuda === 'goranu' || d.presuda === 'strop') {
      const p = pitanjeZadatka(t)
      const rizicna = (RIZICNE_KLASE as string[]).includes(d.klasa)
      cekaGorana.push({
        ...baza, zasto: cekaNa(razlog) || d.razlog,
        opcije: p ? p.opcije : ZADANE_OPCIJE, izPitanja: !!p,
        preporuka: p?.preporuka || (dana > 14 && !rizicna
          ? 'B — čeka više od 14 dana, vjerojatno zastarjelo'
          : dana > 14 ? 'C — rizična klasa (sustav/sigurnost/novac/vanjsko): odluči ti, ne arhiviram naslijepo'
          : 'C — mlađe od 14 dana, uzrok još vrijedi'),
      })
    }
  }
  zastarjelo.sort((a, b) => b.dana - a.dana || a.id.localeCompare(b.id))
  cekaGorana.sort((a, b) => b.dana - a.dana || a.id.localeCompare(b.id))

  const sir = (u.siroce || []).filter(r => r?.taskId && svjez(r))
  if (sir.length) {
    const po = new Map<string, any[]>()
    for (const r of sir) po.set(r.taskId, [...(po.get(r.taskId) || []), r])
    const opisi = [...po.entries()].map(([id, rs]) => {
      const z = rs[rs.length - 1]
      return `${id} ×${rs.length}${z.presuda === 'blokiraj' ? ' (blokiran: siroče ×3)' : ` (zadnji pokušaj ${z.pokusaj ?? '?'}/${z.strop ?? 3})`}`
    })
    anomalije.push(`siročad u 7 d: ${opisi.join(', ')}`)
  }
  const zom = (u.zombi || []).filter(r => r?.taskId && svjez(r) && (r.event === 'action' || r.verdict))
  if (zom.length) anomalije.push(`zombiji vraćeni u 7 d: ${zom.length} (${jedinstveni(zom.map(r => r.taskId)).slice(0, 8).join(', ')})`)
  if (u.okolina && !u.okolina.ok) anomalije.push(`revizija uživo trenutno ne bi pustila ništa: ${u.okolina.razlog}`)

  return {
    generirano: new Date(u.now).toISOString(), ukupno: u.decisions.length, poKlasi,
    pusteno, zatvoreno, sjenaBiPustila, novo, zastarjelo, cekaGorana, anomalije,
  }
}

const broj = (id: string) => id.replace(/^TASK-/i, '')

export function sastaviIzvjestaj(p: PodaciPregleda, kljuc: string): Nacrt {
  const r: string[] = []
  const stavke: Record<string, StavkaStanja> = {}
  const stari = p.cekaGorana.filter(c => c.dana > 14).length
  r.push(`# 🧹 Tjedni pregled blokiranih — ${hrDatum(kljuc)}`, '', `_Generirano ${p.generirano} · TjedniPregledBlokiranih.ts (TASK-5215)_`, '')
  r.push('## Brojke', '')
  r.push(`- Blokirano: **${p.ukupno}** · novo u 7 d: ${p.novo.length} · revizija pustila: ${p.pusteno.length}, zatvorila: ${p.zatvoreno.length}`
    + (p.sjenaBiPustila.length ? ` · u sjeni bi pustila: ${p.sjenaBiPustila.length}` : ''))
  r.push(`- Po klasi: ${Object.entries(p.poKlasi).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}`)
  if (p.pusteno.length || p.zatvoreno.length) r.push(`- Pušteno: ${p.pusteno.join(', ') || '—'} · zatvoreno: ${p.zatvoreno.join(', ') || '—'}`)
  if (p.novo.length) r.push(`- Novo blokirano: ${p.novo.map(n => `${n.id} (${n.klasa})`).join(', ')}`)

  r.push('', `## 🗄 ZASTARJELO → za arhivu (${p.zastarjelo.length})`, '')
  if (!p.zastarjelo.length) r.push('— nema')
  for (const z of p.zastarjelo) {
    r.push(`- **${z.id}** · ${kratko(z.title, 90)} — ${kratko(z.zasto, 160)} (${z.dana} d)`)
    stavke[z.id] = { sekcija: 'zastarjelo', zasto: kratko(z.zasto, 200), opcije: [] }
  }

  r.push('', `## 🙋 ČEKA TEBE (${p.cekaGorana.length}; > 14 d: ${stari})`, '')
  if (!p.cekaGorana.length) r.push('— nema')
  if (p.cekaGorana.some(c => !c.izPitanja)) r.push(`Opcije (gdje nije drukčije navedeno): ${ZADANE_OPCIJE.map(o => `${o.oznaka}) ${o.tekst.split(' — ')[0]}`).join(' · ')}`, '')
  for (const c of p.cekaGorana) {
    r.push(`- **${c.id}** · ${c.klasa} · ${c.dana} d — ${kratko(c.title, 90)}`)
    if (c.zasto) r.push(`  - čeka: ${kratko(c.zasto, 200)}`)
    if (c.izPitanja) for (const o of c.opcije) r.push(`  - ${o.oznaka}) ${kratko(o.tekst, 160)}`)
    if (c.preporuka) r.push(`  - ➜ ${kratko(c.preporuka, 160)}`)
    stavke[c.id] = { sekcija: 'cekaGorana', zasto: kratko(c.zasto, 200), opcije: c.opcije }
  }

  r.push('', `## ⚠️ ZAPELO / ANOMALIJE (${p.anomalije.length})`, '')
  if (!p.anomalije.length) r.push('— nema')
  for (const a of p.anomalije) r.push(`- ${kratko(a, 260)}`)

  const pZ = p.zastarjelo.slice(0, 2).map(z => broj(z.id))
  const pG = p.cekaGorana[0]
  const primjerArhiva = `arhiviraj ${pZ.length ? pZ.join(', ') : '1234, 1235'}`
  const primjerOdluka = `${pG ? broj(pG.id) : '1234'} ${pG?.opcije[1]?.oznaka || 'B'}`
  r.push('', '## Kako odgovoriti', '', 'U grupi REGOČ, može više redaka u jednoj poruci:',
    `- „${primjerArhiva}” — u arhivu ([ARHIVA], otkazan)`,
    `- „${primjerOdluka}” — odluka po opciji`,
    `- „pusti ${pG ? broj(pG.id) : '1234'}” — vrati u rad`,
    '', 'Projekti se ne arhiviraju, samo zadaci.')

  // 2–3 retka za opis dokumenta u grupi (uputa #153) — sve ostalo je u datoteci.
  const sazetak = [
    `🧹 Tjedni pregled blokiranih ${hrDatum(kljuc)}: blokirano ${p.ukupno} · novo ${p.novo.length} · revizija pustila ${p.pusteno.length}, zatvorila ${p.zatvoreno.length}`,
    `🗄 za arhivu ${p.zastarjelo.length} · 🙋 čeka tebe ${p.cekaGorana.length} (> 14 d: ${stari}) · ⚠️ anomalije ${p.anomalije.length}`,
    `Odgovor: „${primjerArhiva}” · „${primjerOdluka}” · „pusti <ID>” — detalji u datoteci.`,
  ].join('\n')
  return { tekst: r.join('\n'), sazetak, stavke }
}

// ─── 3. NAREDBE ───────────────────────────────────────────────────────────────────────────

export type Naredba =
  | { vrsta: 'arhiviraj' | 'pusti'; ids: string[] }
  | { vrsta: 'odluka'; id: string; slovo: string }
  | { vrsta: 'projekt'; ids: string[] }

const ID = '(?:TASK-)?\\d{2,6}'
const POPIS = `(${ID}(?:\\s*(?:,|\\bi\\b|\\s)\\s*${ID})*)`
const RE_GLAGOL = new RegExp(`^(arhiviraj|pusti)\\s+${POPIS}\\s*\\.?$`, 'i')
const RE_PROJEKT = /^arhiviraj\s+(PRJ-\d+(?:\s*(?:,|\bi\b|\s)\s*PRJ-\d+)*)\s*\.?$/i
const RE_ODLUKA = /^(?:TASK-)?(\d{2,6})\s*[:\-–]?\s*([A-Fa-f])\s*[).]?$/i
const idovi = (s: string) => (s.match(/(?:TASK-)?(\d{2,6})/gi) || []).map(x => `TASK-${x.replace(/^TASK-/i, '')}`)

/**
 * Naredbe iz Goranove poruke. Svaki neprazni redak MORA biti naredba — inače null i poruka ide
 * starim putem (Claude/REGOČ). Tako „arhiviraj - i daj mi listu …” ostaje razgovor.
 */
export function prepoznajNaredbe(text: string): Naredba[] | null {
  const redci = String(text || '').split('\n').map(s => s.trim()).filter(Boolean)
  if (!redci.length) return null
  const out: Naredba[] = []
  for (const r of redci) {
    let m = RE_PROJEKT.exec(r)
    if (m) { out.push({ vrsta: 'projekt', ids: m[1]!.match(/PRJ-\d+/gi)!.map(x => x.toUpperCase()) }); continue }
    m = RE_GLAGOL.exec(r)
    if (m) { out.push({ vrsta: m[1]!.toLowerCase() as 'arhiviraj' | 'pusti', ids: jedinstveni(idovi(m[2]!)) }); continue }
    m = RE_ODLUKA.exec(r)
    if (m) { out.push({ vrsta: 'odluka', id: `TASK-${m[1]}`, slovo: m[2]!.toUpperCase() }); continue }
    return null
  }
  return out
}

interface IzvedbaOpts { env: ApiOkolina; author: string; stanje: StanjePregleda; now?: number }

async function dohvati(env: ApiOkolina, id: string): Promise<{ t?: any; greska?: string }> {
  try {
    const r = await api(env, `/api/tasks/${encodeURIComponent(id)}`)
    if (r.status === 404) return { greska: `❓ ${id} ne postoji — ništa nije učinjeno.` }
    const t = r.body?.task ?? r.body
    if (r.status !== 200 || !t?.id) return { greska: `❌ ${id}: ploča vraća HTTP ${r.status} — ništa nije učinjeno.` }
    return { t }
  } catch (e: any) {
    return { greska: `❌ ${id}: TaskManager (17781) ne odgovara (${e?.message || e}) — ništa nije učinjeno.` }
  }
}

async function arhiviraj(t: any, o: IzvedbaOpts, dodatak: string): Promise<string> {
  const id = t.id
  const st = String(t.status)
  if (st === 'in_progress') return `⛔ ${id} je in_progress (agent radi) — ne arhiviram.`
  if (st === 'completed') return `ℹ️ ${id} je već završen (completed) — ne arhiviram.`
  if (st === 'cancelled' && /^\s*\[ARHIVA\]/i.test(t.title || '')) return `ℹ️ ${id} je već arhiviran.`
  const zasto = o.stanje.zadnjiPregled?.stavke?.[id]?.zasto || 'zastarjelo'
  const datum = hrDatum(zagrebVrijeme(o.now ?? Date.now()).datum)
  const title = /^\s*\[ARHIVA\]/i.test(t.title || '') ? t.title : `[ARHIVA] ${t.title || ''}`.trim()
  const tijelo = {
    title, status: 'cancelled', tags: jedinstveni([...(t.tags || []), 'arhiva']),
    resultSummary: `ARHIVIRANO po odluci ${o.author} (Telegram ${datum}, tjedni pregled blokiranih): ${dodatak ? `${dodatak}; ` : ''}${zasto}. Projekt se NE arhivira.`,
  }
  const r = await api(o.env, `/api/tasks/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(tijelo) })
  if (r.status !== 200) return `❌ ${id} nije arhiviran: ${r.body?.error || `HTTP ${r.status}`}${r.body?.details ? ` (${r.body.details})` : ''}`
  return `🗄 ${id} arhiviran — „${kratko(t.title, 60)}”`
}

async function odluci(t: any, o: IzvedbaOpts, odluka: string): Promise<string> {
  const id = t.id
  const r = await api(o.env, `/api/tasks/${encodeURIComponent(id)}/odluka`, {
    method: 'POST', body: JSON.stringify({ odluka, by: o.author }),
  })
  if (r.status !== 200) return `❌ ${id}: odluka nije zapisana — ${r.body?.error || `HTTP ${r.status}`}${r.body?.razlog ? ` (${r.body.razlog})` : ''}`
  if (r.body?.odgodjeno) return `⏸ ${id} ostaje blokiran — zapisano: ${kratko(odluka.replace(/^odgodi\s*—\s*/i, ''), 100)}`
  const s = r.body?.task?.status
  return `▶️ ${id} — ${kratko(odluka, 90)} → ${s === 'pending' ? 'u redu, kreće' : `status ${s || '?'}${r.body?.task?.blockedReason ? ` (${kratko(r.body.task.blockedReason, 80)})` : ''}`}`
}

export async function provediNaredbe(naredbe: Naredba[], o: IzvedbaOpts): Promise<string> {
  const out: string[] = []
  const potpis = `${o.author}, tjedni pregled blokiranih`
  for (const n of naredbe) {
    if (n.vrsta === 'projekt') {
      out.push(`🚫 Projekti se ne arhiviraju (Goran 04.10.2026.) — samo zadaci. ${n.ids.join(', ')} nije diran.`)
      continue
    }
    const ids = n.vrsta === 'odluka' ? [n.id] : n.ids
    for (const id of ids) {
      const { t, greska } = await dohvati(o.env, id)
      if (!t) { out.push(greska!); continue }
      if (n.vrsta === 'arhiviraj') { out.push(await arhiviraj(t, o, '')); continue }
      if (n.vrsta === 'pusti') {
        if (t.status !== 'blocked') { out.push(`⛔ ${id} je ${t.status} — „pusti” vrijedi samo za blokirane.`); continue }
        out.push(await odluci(t, o, `pusti — ${potpis}`))
        continue
      }
      // odluka po slovu
      let opcije = o.stanje.zadnjiPregled?.stavke?.[id]?.opcije || []
      if (!opcije.length) opcije = pitanjeZadatka(t)?.opcije || []
      if (!opcije.length) {
        out.push(`❓ ${id}: u zadnjem pregledu nema ponuđenih opcija — napiši „arhiviraj ${broj(id)}” ili „pusti ${broj(id)}”.`)
        continue
      }
      const op = opcije.find(x => x.oznaka.toUpperCase() === n.slovo)
      if (!op) { out.push(`❓ ${id} nema opciju ${n.slovo} (ponuđeno: ${opcije.map(x => x.oznaka).join(', ')}).`); continue }
      const akcija = akcijaOpcije(op.tekst)
      if (akcija === 'arhiviraj') out.push(await arhiviraj(t, o, `opcija ${op.oznaka}) ${kratko(op.tekst, 120)}`))
      else if (akcija === 'ceka') out.push(await odluci(t, o, `odgodi — ${op.oznaka}) ${op.tekst} (${potpis})`))
      else out.push(await odluci(t, o, `${op.oznaka}) ${op.tekst} (${potpis})`))
    }
  }
  return out.join('\n')
}

/**
 * Ulaz za Klaudija (telegram_agent.ts). `obradjeno:false` = nije naredba tjednog pregleda →
 * poruka nastavlja starim putem. Samo grupa REGOČ, samo dopušteni pošiljatelj (Goran).
 */
export async function obradiNaredbuPregleda(text: string, o: {
  chatId: number | undefined; userId: number | undefined; author: string; env: ApiOkolina
  stanje?: StanjePregleda; stanjePut?: string; dopusteni?: number[]; now?: number
}): Promise<{ obradjeno: boolean; odgovor?: string }> {
  if (o.chatId !== CHAT_REGOC) return { obradjeno: false }
  const naredbe = prepoznajNaredbe(text)
  if (!naredbe) return { obradjeno: false }
  if (!(o.dopusteni ?? DOPUSTENI_ZADANO).includes(Number(o.userId))) {
    return { obradjeno: true, odgovor: '⛔ Naredbe tjednog pregleda (arhiviraj / pusti / <ID> <slovo>) zadaje samo Goran. Ništa nije promijenjeno.' }
  }
  const stanje = o.stanje ?? citajStanje(o.stanjePut)
  return { obradjeno: true, odgovor: await provediNaredbe(naredbe, { env: o.env, author: o.author, stanje, now: o.now }) || 'Ništa za učiniti.' }
}

// ─── STVARNI PODACI I CLI ────────────────────────────────────────────────────────────────

function citajJsonlRep(put: string, maxBajtova = 4_000_000): any[] {
  try {
    const fd = openSync(put, 'r')
    try {
      const vel = fstatSync(fd).size
      const od = Math.max(0, vel - maxBajtova)
      const buf = Buffer.alloc(vel - od)
      readSync(fd, buf, 0, buf.length, od)
      const out: any[] = []
      for (const l of buf.toString('utf-8').split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)) } catch { /* poluzapis */ } }
      return out
    } finally { closeSync(fd) }
  } catch { return [] }
}

/** Iste presude kao daemon i `stale-watchdog-report.ts --blocked` (bez StaleCodeCheck-a deploya). */
export async function skupiStvarnePodatke(now = Date.now(), apiBase = 'http://localhost:17781'): Promise<PodaciPregleda> {
  const SW = await import('./StaleWatchdog')
  const { Database } = await import('bun:sqlite')
  const config = SW.loadBlockedReviewConfig()
  const resp = await fetch(`${apiBase}/api/tasks?status=blocked`)
  if (!resp.ok) throw new Error(`TaskManager API ${resp.status}`)
  const tasks = await resp.json() as BlockedTask[]
  const okolina = await SW.izmjeriOkolinu(now)
  const uzrok = SW.provjeriUzrok(okolina, now, config)
  const db = new Database(join(REGOC, 'data', 'regoc.db'), { readonly: true })
  let decisions: BlockedDecision[]
  try {
    const ulaz = SW.makeBlockedReviewLookup(db as any, { now, config, uzrok })
    decisions = SW.evaluateBlockedTasks(tasks, { now, config, ulaz, budzet: SW.procitajBudzet(now) })
  } finally { db.close() }
  return sastaviPodatke({
    now, tasks, decisions, config, okolina: uzrok,
    revizija: citajJsonlRep(SW.REVIZIJA_BLOKIRANIH_LOG),
    siroce: citajJsonlRep(join(REGOC, 'data', 'siroce_oporavak.jsonl')),
    zombi: citajJsonlRep(join(REGOC, 'data', 'zombie_recovery.jsonl')),
  })
}

/** Slanje kanonskim pošiljateljem tg_send.py (token se čita u njegovu procesu): JEDAN sendDocument s opisom. */
export const posaljiDokument: PosaljiDokument = async ({ datoteka, opis }) => {
  const p = Bun.spawn(['python3', join(REGOC, 'tools', 'telegram', 'tg_send.py'), 'dokument', datoteka, '--chat', String(CHAT_REGOC), '--caption', opis],
    { stdout: 'pipe', stderr: 'pipe' })
  const kod = await p.exited
  const izlaz = (await new Response(p.stdout).text()).trim() + (await new Response(p.stderr).text()).trim()
  console.log(`  tg_send dokument: ${izlaz || `izlaz ${kod}`}`)
  return kod === 0
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const cmd = args[0] || 'stanje'
  const ima = (f: string) => args.includes(f)
  const vrijednost = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
  const env: ApiOkolina = { apiBase: process.env.TASKMANAGER_URL || 'http://localhost:17781', fetch }
  const now = Date.now()
  const ts = new Date(now).toISOString()

  if (cmd === 'stanje') { console.log(JSON.stringify(citajStanje(), null, 1)); return }

  if (cmd === 'nacrt') {
    const p = await skupiStvarnePodatke(now, env.apiBase)
    if (ima('--json')) console.log(JSON.stringify(p, null, 1))
    else console.log(sastaviIzvjestaj(p, zagrebVrijeme(now).datum).tekst)
    return
  }

  if (cmd === 'okidac') {
    const sada = ima('--sada')
    const r = await okidacProlaz({
      env, now, sada, dryRun: ima('--dry-run'),
      nacrt: async () => sastaviIzvjestaj(await skupiStvarnePodatke(now, env.apiBase), zagrebVrijeme(now).datum),
      posalji: posaljiDokument,
    })
    // Petlja zove svakih 10 min — „ništa” se ne zapisuje, osim uz --glasno (inače 144 retka dnevno).
    if (r.radnja !== 'nista' || ima('--glasno') || ima('--dry-run')) console.log(`${ts} okidac: ${r.radnja} — ${r.poruka}`)
    if (r.radnja === 'greska') process.exitCode = 1
    return
  }

  if (cmd === 'posalji') {
    const datoteka = vrijednost('--datoteka')
    const nacrt = sastaviIzvjestaj(await skupiStvarnePodatke(now, env.apiBase), zagrebVrijeme(now).datum)
    const tekst = datoteka ? readFileSync(datoteka, 'utf-8').trim() : nacrt.tekst
    const stavkePut = vrijednost('--stavke')
    const stavke = stavkePut ? { ...nacrt.stavke, ...JSON.parse(readFileSync(stavkePut, 'utf-8')) } : nacrt.stavke
    if (ima('--dry-run')) { console.log(`dry-run: 1 poruka (dokument), ${tekst.length} znakova, ${Object.keys(stavke).length} stavki\n${nacrt.sazetak}`); return }
    const kljuc = tjedniKljuc(now)
    const r = await objaviIzvjestaj({ nacrt: { ...nacrt, tekst, stavke }, oznaka: kljuc, posalji: posaljiDokument })
    if (!r.ok) { console.error(`slanje nije uspjelo (izvještaj je zapisan: ${r.datoteka})`); process.exit(1) }
    spremiStanje({ ...citajStanje(), poslanoTjedan: kljuc, zadnjiPregled: { kljuc, ts, stavke } })
    console.log(`${ts} posalji: ok — ${r.datoteka}, 1 poruka u ${CHAT_REGOC}, ${Object.keys(stavke).length} stavki spremljeno`)
    return
  }
  console.log('upotreba: okidac [--sada] [--dry-run] | nacrt [--json] | posalji [--datoteka F.md] [--stavke F] [--dry-run] | stanje')
}

if (import.meta.main) main().catch(e => { console.error(e); process.exit(1) })
