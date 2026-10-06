// ─── Kanal bot↔bot preko LAN-a (ADR-0003) ────────────────────────────────────
// Telegram botu ne isporučuje poruke drugog bota u grupi (izmjereno, ADR-0003 §1), pa dva bota
// razgovaraju HTTP-om (`POST /api/razgovor/od-bota`), a poruka u grupi ostaje radi ljudi.
//
// Ova datoteka je JEZGRA ugovora i brava protiv petlje — bez ijednog uvoza, jer isti ugovor
// izvode dva kraja (ovaj paket i Klaudijev `telegram_agent` + glavna ploča). Druga strana drži
// doslovnu kopiju; test kopije provjerava da su iste (ADR-0003 §11).
//
// Brave (svaka je dovoljna sama, §4):
//   1. zastavica po chatu `zaustavljen` — pale je stop-fraza, strop i ručni gumb; spušta je SAMO
//      ručni nastavak (gumb ili „nastavi komunikaciju" od stop-korisnika), nema isteka;
//   2. tvrdi strop: `strop` prijenosa u `prozorMin` bez ljudske poruke, uz `skok ≤ strop`;
//   3. nikad odgovor na vlastitu poruku (`izvor` = ja, ili vlastiti `telegramPorukaId`).
//
// Autorica: Jelena (Engineer), TASK-5290 — po dizajnu Kosjenke (ADR-0003, TASK-5289).

export type RazlogStopa = 'fraza' | 'strop' | 'rucno'

export interface DrugiBot {
  /** Ime u ugovoru (`izvor`), npr. `klaudio` / `saban`. */
  ime: string
  /** Telegram korisničko ime bez `@`, npr. `klaudioAI_bot` — spomen u odgovoru = prijenos. */
  korisnickoIme: string
  /** Ploča drugog kraja, npr. `http://192.168.10.200:17781`. */
  url: string
}

export interface BotKanalPostavke {
  ukljucen: boolean
  drugi: DrugiBot[]
  chatovi: string[]
  adrese: string[]
  ovlasti: 'citanje' | 'rad'
  /** Brojčani id-evi; prazno = `zadaniStopKorisnici()` (dopušteni koji su brojčani). */
  stopKorisnici: string[]
  strop: number
  prozorMin: number
}

export const BOT_KANAL_ZADANO: Readonly<BotKanalPostavke> = Object.freeze({
  ukljucen: false, drugi: [], chatovi: [], adrese: [], ovlasti: 'citanje',
  stopKorisnici: [], strop: 6, prozorMin: 10,
}) as BotKanalPostavke

export interface ZastavicaChata {
  zaustavljen: boolean
  ts: string
  by: string
  razlog: RazlogStopa | 'nastavak'
}

/** Stanje koje preživi restart (paket: `settings`; Klaudio: `data/bot-kanal.json`). */
export interface BotKanalStanje {
  zastavice: Record<string, ZastavicaChata>
  /** Vrijeme (ms) prijenosa po chatu od zadnje ljudske poruke — za strop. */
  brojilo: Record<string, number[]>
  /** Vlastite vidljive poruke koje su prenesene (odjek = 409 vlastita). */
  poslano: { id: string; ms: number }[]
}

export function praznoStanje(): BotKanalStanje {
  return { zastavice: {}, brojilo: {}, poslano: [] }
}

export interface Spremiste {
  citaj(): BotKanalStanje
  /** `promjenaZastavice` = za povijest (`settings_history`), samo kad se zastavica mijenja. */
  pisi(s: BotKanalStanje, promjenaZastavice?: { chatId: string; z: ZastavicaChata }): void
}

export interface Izvornik { id: string; ime: string }

/** Tijelo `POST /api/razgovor/od-bota` (ADR-0003 §3). */
export interface BotPoruka {
  izvor: string
  chatId: string
  tekst: string
  telegramPorukaId: string | null
  lanacId: string
  skok: number
  izvornik: Izvornik | null
  ts: string
}

/** Lanac koji nosi potez nastao iz bot-poruke — odgovor nastavlja isti lanac sa `skok+1`. */
export interface Lanac { izvor: string; lanacId: string; skok: number; izvornik: Izvornik | null }

export interface Odgovor { status: number; tijelo: Record<string, unknown> }

export const MAX_TEKST = 4000
const POLJA = ['izvor', 'chatId', 'tekst', 'telegramPorukaId', 'lanacId', 'skok', 'izvornik', 'ts']
const MAX_POSLANO = 200
const POSLANO_MS = 3600_000
const DOJAVA_PADA_MS = 10 * 60_000

// ─── Fraze ───────────────────────────────────────────────────────────────────

/** Mala slova, bez dijakritike, interpunkcija u razmak, jedan razmak (ADR-0003 §4.2). */
export function normalizirajFrazu(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** „Sadrži" je namjerno širi uvjet: lažni pogodak samo zaustavi botove, promašaj ostavi petlju. */
export function jeStopFraza(t: string): boolean {
  return ` ${normalizirajFrazu(t)} `.includes(' prekini komunikaciju ')
}

export function jeNastavakFraza(t: string): boolean {
  return ` ${normalizirajFrazu(t)} `.includes(' nastavi komunikaciju ')
}

/** Spominje li tekst `@korisnicko_ime` (bez obzira na velika slova; iza ne smije slovo/broj/_). */
export function spominje(tekst: string, korisnickoIme: string): boolean {
  const k = korisnickoIme.replace(/^@/, '').toLowerCase()
  if (!k) return false
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@${esc}(?![\\p{L}\\p{N}_])`, 'iu').test(tekst)
}

// ─── Ugovor ──────────────────────────────────────────────────────────────────

/** Usporedba tajne u stalnom vremenu (ne curi duljina zajedničkog prefiksa). */
export function jednakaTajna(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let r = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) r |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return r === 0 && x.length > 0
}

export function bearer(authorization: string | null | undefined): string {
  const m = /^Bearer\s+(.+)$/i.exec((authorization || '').trim())
  return m ? m[1]!.trim() : ''
}

/** `::ffff:192.168.10.200` → `192.168.10.200`. */
export function cistaAdresa(ip: string | null | undefined): string {
  return String(ip || '').replace(/^::ffff:/i, '').trim()
}

export function provjeriTijelo(raw: unknown): { ok: true; value: BotPoruka } | { ok: false; status: 400 | 413; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, status: 400, error: 'tijelo mora biti objekt' }
  const t = raw as Record<string, unknown>
  const nepoznato = Object.keys(t).filter(k => !POLJA.includes(k))
  if (nepoznato.length) return { ok: false, status: 400, error: `Nepoznato polje: ${nepoznato.join(', ')}` }
  if (typeof t.izvor !== 'string' || !/^[\w.-]{1,40}$/.test(t.izvor)) return { ok: false, status: 400, error: 'izvor: ime bota' }
  const chatId = typeof t.chatId === 'number' ? String(t.chatId) : t.chatId
  if (typeof chatId !== 'string' || !/^-?\d{1,20}$/.test(chatId)) return { ok: false, status: 400, error: 'chatId: brojčani id chata' }
  if (typeof t.tekst !== 'string' || !t.tekst.trim()) return { ok: false, status: 400, error: 'tekst je obavezan' }
  if (t.tekst.length > MAX_TEKST) return { ok: false, status: 413, error: `tekst je dulji od ${MAX_TEKST} znakova` }
  const tpid = t.telegramPorukaId
  if (tpid !== undefined && tpid !== null && !(typeof tpid === 'number' || (typeof tpid === 'string' && /^\d{1,20}$/.test(tpid)))) {
    return { ok: false, status: 400, error: 'telegramPorukaId: broj' }
  }
  if (typeof t.lanacId !== 'string' || !/^[\w-]{1,64}$/.test(t.lanacId)) return { ok: false, status: 400, error: 'lanacId: uuid' }
  if (typeof t.skok !== 'number' || !Number.isInteger(t.skok) || t.skok < 1) return { ok: false, status: 400, error: 'skok: cijeli broj ≥ 1' }
  let izvornik: Izvornik | null = null
  if (t.izvornik !== undefined && t.izvornik !== null) {
    const iz = t.izvornik as Record<string, unknown>
    if (typeof iz !== 'object' || Array.isArray(iz)) return { ok: false, status: 400, error: 'izvornik: {id, ime} ili null' }
    izvornik = { id: String(iz.id ?? '').slice(0, 32), ime: String(iz.ime ?? '').slice(0, 64) }
  }
  return {
    ok: true,
    value: {
      izvor: t.izvor, chatId, tekst: t.tekst,
      telegramPorukaId: tpid === undefined || tpid === null ? null : String(tpid),
      lanacId: t.lanacId, skok: t.skok, izvornik,
      ts: typeof t.ts === 'string' ? t.ts.slice(0, 40) : '',
    },
  }
}

// ─── Kanal ───────────────────────────────────────────────────────────────────

export interface BotKanalOvisnosti {
  /** Ime ovog kraja u ugovoru (`saban` na node-A, `klaudio` na glavnom stroju). */
  ja: string
  postavke: () => BotKanalPostavke
  /** `TM_BOT_KANAL_TOKEN` — nikad u postavkama, zapisu ni okolini modela (ADR-0003 §3). */
  token: () => string | undefined
  spremiste: Spremiste
  /** Kad je `stopKorisnici` prazan: dopušteni korisnici razgovora koji su brojčani. */
  zadaniStopKorisnici?: () => string[]
  /** Poruka ljudima u grupu (⛔ stop, strop, pad LAN-a). */
  javiUGrupu?: (chatId: string, tekst: string) => Promise<unknown> | unknown
  /** „Odmah": prekini bot-potez u letu i odbaci bot-poruke u redu chata (§4.1). */
  naStop?: (chatId: string) => void
  sat?: () => number
  fetchImpl?: typeof fetch
  /** Pauza prije ponovljenog pokušaja (zadano 2 s; testovi 0). */
  ponoviMs?: number
  uuid?: () => string
  log?: (r: string) => void
}

export interface Zahtjev { authorization?: string | null; ip?: string | null }

export interface PrijenosUlaz {
  chatId: string
  tekst: string
  /** Vidljiva poruka u grupi koju je ovaj kraj upravo poslao. */
  telegramPorukaId: string | null
  /** Lanac poteza koji je nastao iz bot-poruke — inače novi lanac. */
  lanac?: Lanac | null
  /** Čovjek koji je pokrenuo potez (za novi lanac). */
  izvornik?: Izvornik | null
}

export type PrijenosIshod = 'poslano' | 'iskljuceno' | 'bez-spomena' | 'zaustavljeno' | 'strop' | 'pad'

export interface BotKanal {
  /** Ruta `POST /api/razgovor/od-bota`. Uz 202 vraća i provjerenu poruku za razgovor. */
  primi(raw: unknown, z: Zahtjev): Odgovor & { poruka?: BotPoruka }
  /** Rute `POST /od-bota/stop` i `/od-bota/nastavi` (drugi kraj javlja; ne prosljeđuje se dalje). */
  primiStop(raw: unknown, z: Zahtjev): Odgovor
  primiNastavak(raw: unknown, z: Zahtjev): Odgovor
  /** `GET /od-bota/stanje` — samo uz tajnu; bez tajne u odgovoru. */
  stanjeZaDrugog(z: Zahtjev): Odgovor
  /** Poruka čovjeka u grupi. PRVA provjera, prije svih filtara (§4.2). */
  ljudska(p: { chatId: string; posiljateljId: string; posiljateljIme: string; tekst: string }): Promise<'stop' | 'nastavak' | null>
  /** Nakon slanja odgovora u grupu: prenesi drugom botu ako ga spominje (§5). */
  prenesi(u: PrijenosUlaz): Promise<PrijenosIshod>
  jeZaustavljen(chatId: string): boolean
  zaustavi(chatId: string, by: string, razlog: RazlogStopa, javiDrugom?: boolean): Promise<void>
  nastavi(chatId: string, by: string, javiDrugom?: boolean): Promise<void>
  stanje(): BotKanalStanje
}

export function stvoriBotKanal(d: BotKanalOvisnosti): BotKanal {
  const sat = d.sat ?? Date.now
  const log = d.log ?? (() => {})
  const fetchImpl = d.fetchImpl ?? fetch
  const ponoviMs = d.ponoviMs ?? 2000
  const uuid = d.uuid ?? (() => crypto.randomUUID())
  const zadnjaDojavaPada = new Map<string, number>()

  const st = (): BotKanalStanje => {
    const s = d.spremiste.citaj()
    return { zastavice: { ...(s?.zastavice || {}) }, brojilo: { ...(s?.brojilo || {}) }, poslano: [...(s?.poslano || [])] }
  }

  const stopKorisnici = (): string[] => {
    const p = d.postavke().stopKorisnici.filter(x => /^\d+$/.test(x.trim()))
    if (p.length) return p
    return (d.zadaniStopKorisnici?.() || []).filter(x => /^\d+$/.test(String(x).trim()))
  }

  /** Brojilo bez prijenosa izvan prozora. */
  const uProzoru = (s: BotKanalStanje, chatId: string): number[] => {
    const prozor = d.postavke().prozorMin * 60_000
    const t = sat()
    return (s.brojilo[chatId] || []).filter(ms => t - ms <= prozor)
  }

  /** Autentikacija i opći uvjeti rute — `null` = prolazi. */
  function vrata(z: Zahtjev, chatId?: string): Odgovor | null {
    const p = d.postavke()
    if (!p.ukljucen) return { status: 403, tijelo: { error: 'kanal bot↔bot je isključen' } }
    const token = d.token() || ''
    if (!token) return { status: 403, tijelo: { error: 'tajna kanala nije postavljena na ovom stroju' } }
    if (!jednakaTajna(bearer(z.authorization), token)) return { status: 401, tijelo: { error: 'neispravna tajna' } }
    if (!p.adrese.includes(cistaAdresa(z.ip))) return { status: 403, tijelo: { error: 'adresa nije na popisu' } }
    if (chatId !== undefined && !p.chatovi.includes(chatId)) return { status: 403, tijelo: { error: 'chat nije na popisu' } }
    return null
  }

  async function zaDrugog(put: string, tijelo: unknown): Promise<boolean> {
    const p = d.postavke()
    const token = d.token()
    if (!token || !p.drugi.length) return false
    let ok = true
    for (const drugi of p.drugi) {
      const r = await posalji(`${drugi.url.replace(/\/+$/, '')}/api/razgovor/od-bota${put}`, tijelo, token)
      ok = ok && r
    }
    return ok
  }

  /** Jedan ponovljeni pokušaj nakon `ponoviMs`; nema reda za kasniju isporuku (§5). */
  async function posalji(url: string, tijelo: unknown, token: string): Promise<boolean> {
    for (let pokusaj = 1; pokusaj <= 2; pokusaj++) {
      try {
        const r = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify(tijelo),
          signal: AbortSignal.timeout(10_000),
        })
        if (r.status < 500) {
          if (r.status >= 300) log(`[bot-kanal] ${url}: HTTP ${r.status}`)
          return r.status < 300
        }
        log(`[bot-kanal] ${url}: HTTP ${r.status} (pokušaj ${pokusaj})`)
      } catch (e: any) {
        log(`[bot-kanal] ${url}: ${String(e?.message || e)} (pokušaj ${pokusaj})`)
      }
      if (pokusaj === 1 && ponoviMs > 0) await new Promise(r => setTimeout(r, ponoviMs))
    }
    return false
  }

  async function postaviZastavicu(chatId: string, z: ZastavicaChata, nulirajBrojilo: boolean): Promise<void> {
    const s = st()
    s.zastavice[chatId] = z
    if (nulirajBrojilo) delete s.brojilo[chatId]
    d.spremiste.pisi(s, { chatId, z })
  }

  async function zaustavi(chatId: string, by: string, razlog: RazlogStopa, javiDrugom = true): Promise<void> {
    const vec = st().zastavice[chatId]?.zaustavljen === true
    if (!vec) await postaviZastavicu(chatId, { zaustavljen: true, ts: new Date(sat()).toISOString(), by, razlog }, false)
    try { d.naStop?.(chatId) } catch (e: any) { log(`[bot-kanal] prekid u letu: ${String(e?.message || e)}`) }
    if (javiDrugom) {
      const ok = await zaDrugog('/stop', { chatId, by, razlog })
      if (!ok) log(`[bot-kanal] stop nije stigao drugom kraju (${chatId}) — on ga vidi i sam (fraza) ili ga zaustavi strop`)
    }
  }

  async function nastavi(chatId: string, by: string, javiDrugom = true): Promise<void> {
    await postaviZastavicu(chatId, { zaustavljen: false, ts: new Date(sat()).toISOString(), by, razlog: 'nastavak' }, true)
    if (javiDrugom) await zaDrugog('/nastavi', { chatId, by })
  }

  function zabiljeziPrijenos(chatId: string, poslanoId?: string | null): void {
    const s = st()
    const t = sat()
    s.brojilo[chatId] = [...uProzoru(s, chatId), t]
    if (poslanoId) s.poslano = [...s.poslano.filter(x => t - x.ms <= POSLANO_MS), { id: `${chatId}:${poslanoId}`, ms: t }].slice(-MAX_POSLANO)
    d.spremiste.pisi(s)
  }

  async function strop(chatId: string): Promise<void> {
    const p = d.postavke()
    await zaustavi(chatId, d.ja, 'strop')
    await javi(chatId, `⛔ strop bot↔bot (${p.strop} u ${p.prozorMin} min bez čovjeka) — razmjena zaustavljena. Nastavak: Config → Razgovor ili „Nastavi komunikaciju".`)
  }

  async function javi(chatId: string, tekst: string): Promise<void> {
    try { await d.javiUGrupu?.(chatId, tekst) } catch (e: any) { log(`[bot-kanal] javljanje u grupu: ${String(e?.message || e)}`) }
  }

  const tijeloChata = (raw: unknown): { chatId: string; by: string; razlog?: RazlogStopa } | null => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const t = raw as Record<string, unknown>
    const chatId = typeof t.chatId === 'number' ? String(t.chatId) : t.chatId
    if (typeof chatId !== 'string' || !/^-?\d{1,20}$/.test(chatId)) return null
    const razlog = t.razlog === 'strop' || t.razlog === 'rucno' ? t.razlog : 'fraza'
    return { chatId, by: String(t.by ?? '').slice(0, 64) || 'drugi kraj', razlog }
  }

  return {
    primi(raw, z) {
      const prije = vrata(z)
      if (prije) return prije
      const v = provjeriTijelo(raw)
      if (!v.ok) return { status: v.status, tijelo: { error: v.error } }
      const m = v.value
      const p = d.postavke()
      if (!p.chatovi.includes(m.chatId)) return { status: 403, tijelo: { error: 'chat nije na popisu' } }
      if (!p.drugi.some(x => x.ime === m.izvor) && m.izvor !== d.ja) return { status: 403, tijelo: { error: 'izvor nije na popisu' } }
      if (m.izvor === d.ja) return { status: 409, tijelo: { razlog: 'vlastita' } }
      const s = st()
      if (m.telegramPorukaId && s.poslano.some(x => x.id === `${m.chatId}:${m.telegramPorukaId}`)) {
        return { status: 409, tijelo: { razlog: 'vlastita' } }
      }
      if (s.zastavice[m.chatId]?.zaustavljen) return { status: 409, tijelo: { razlog: 'zaustavljeno' } }
      if (m.skok > p.strop) {
        void strop(m.chatId)
        return { status: 409, tijelo: { razlog: 'skok' } }
      }
      if (uProzoru(s, m.chatId).length >= p.strop) {
        void strop(m.chatId)
        return { status: 409, tijelo: { razlog: 'strop' } }
      }
      zabiljeziPrijenos(m.chatId)
      return { status: 202, tijelo: { primljeno: true }, poruka: m }
    },

    primiStop(raw, z) {
      const t = tijeloChata(raw)
      if (!t) return vrata(z) || { status: 400, tijelo: { error: 'chatId je obavezan' } }
      const prije = vrata(z, t.chatId)
      if (prije) return prije
      void zaustavi(t.chatId, t.by, t.razlog || 'fraza', false)
      return { status: 200, tijelo: { ok: true, zaustavljen: true } }
    },

    primiNastavak(raw, z) {
      const t = tijeloChata(raw)
      if (!t) return vrata(z) || { status: 400, tijelo: { error: 'chatId je obavezan' } }
      const prije = vrata(z, t.chatId)
      if (prije) return prije
      void nastavi(t.chatId, t.by, false)
      return { status: 200, tijelo: { ok: true, zaustavljen: false } }
    },

    stanjeZaDrugog(z) {
      const prije = vrata(z)
      if (prije) return prije
      return { status: 200, tijelo: { ja: d.ja, zastavice: st().zastavice } }
    },

    async ljudska(m) {
      const p = d.postavke()
      if (!p.ukljucen || !p.chatovi.includes(m.chatId)) return null
      const stop = jeStopFraza(m.tekst)
      const dalje = !stop && jeNastavakFraza(m.tekst)
      const smije = stopKorisnici().includes(String(m.posiljateljId))
      if ((stop || dalje) && smije) {
        if (stop) {
          await zaustavi(m.chatId, m.posiljateljIme, 'fraza')
          await javi(m.chatId, `⛔ Komunikacija bot↔bot prekinuta (${m.posiljateljIme}). Nastavak: Config → Razgovor ili „Nastavi komunikaciju".`)
          return 'stop'
        }
        await nastavi(m.chatId, m.posiljateljIme)
        await javi(m.chatId, `▶ Komunikacija bot↔bot nastavljena (${m.posiljateljIme}).`)
        return 'nastavak'
      }
      // Ljudska poruka nulira brojilo stropa (§4.3).
      const s = st()
      if (s.brojilo[m.chatId]?.length) {
        delete s.brojilo[m.chatId]
        d.spremiste.pisi(s)
      }
      return null
    },

    async prenesi(u) {
      const p = d.postavke()
      if (!p.ukljucen || !p.chatovi.includes(u.chatId) || !d.token()) return 'iskljuceno'
      const drugi = p.drugi.filter(x => spominje(u.tekst, x.korisnickoIme))
      if (!drugi.length) return 'bez-spomena'
      const s = st()
      if (s.zastavice[u.chatId]?.zaustavljen) return 'zaustavljeno'
      const skok = u.lanac ? u.lanac.skok + 1 : 1
      if (skok > p.strop || uProzoru(s, u.chatId).length >= p.strop) {
        await strop(u.chatId)
        return 'strop'
      }
      const tijelo: BotPoruka = {
        izvor: d.ja, chatId: u.chatId, tekst: u.tekst.slice(0, MAX_TEKST),
        telegramPorukaId: u.telegramPorukaId || null, lanacId: u.lanac?.lanacId || uuid(), skok,
        izvornik: u.lanac ? u.lanac.izvornik : (u.izvornik || null), ts: new Date(sat()).toISOString(),
      }
      zabiljeziPrijenos(u.chatId, u.telegramPorukaId)
      let ok = true
      for (const x of drugi) {
        const r = await posalji(`${x.url.replace(/\/+$/, '')}/api/razgovor/od-bota`, tijelo, d.token()!)
        ok = ok && r
        if (!r) {
          const t = sat()
          const kljuc = `${u.chatId}:${x.ime}`
          if (t - (zadnjaDojavaPada.get(kljuc) ?? -Infinity) >= DOJAVA_PADA_MS) {
            zadnjaDojavaPada.set(kljuc, t)
            await javi(u.chatId, `⚠ ${x.ime} nije dostupan preko LAN-a — poruka je samo u grupi.`)
          }
        }
      }
      return ok ? 'poslano' : 'pad'
    },

    jeZaustavljen: chatId => st().zastavice[chatId]?.zaustavljen === true,
    zaustavi,
    nastavi,
    stanje: st,
  }
}
