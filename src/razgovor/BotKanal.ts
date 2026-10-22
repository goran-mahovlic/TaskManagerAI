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
//      ručni nastavak NA OVOM kraju (gumb ili „nastavi komunikaciju" od stop-korisnika), nema
//      isteka; drugi kraj smije zaustaviti, ali ne i nastaviti (TASK-5291, N2);
//   2. tvrdi strop: `strop` prijenosa u `prozorMin` bez poruke stop-korisnika, uz `skok ≤ strop`;
//   3. nikad odgovor na vlastitu poruku (`izvor` = ja, ili vlastiti `telegramPorukaId`).
//
// Autentikacija (TASK-5299, ADR-0003 §13 (a)): HMAC-SHA256 nad (ts, metoda, put, tijelo) u
// zaglavlju `X-Bot-Kanal-Potpis: t=<unix s>,v1=<hex>`, `ts` ±60 s, ponovljeni (izvor, lanacId, skok)
// u 10 min se odbija, tajna nikad ne ide na žicu. Po jedna tajna po smjeru: ovaj kraj potpisuje
// tajnom SLANJA, a provjerava tajnom PRIMANJA (= tajna slanja drugog kraja). Adresa je druga brava
// samo gdje se vidi prava adresa (`provjeraAdrese`); iza docker-proxyja svi su `172.24.0.1`.
//
// Više drugih botova (TASK-5728): par tajni je PO DRUGOM BOTU (`<TAJNA>_<IME>`), pa potpis kaže
// tko je pošiljatelj — `izvor` u tijelu mora biti taj bot, a bot smije samo u svoje `chatovi`.
// Zajednički par (bez sufiksa) vrijedi samo za bota kojem ga kraj izričito dopusti (`tajnaZaBota`).
//
// Autorica: Jelena (Engineer), TASK-5290, TASK-5299, TASK-5728 — po dizajnu Kosjenke (ADR-0003, TASK-5289).

export type RazlogStopa = 'fraza' | 'strop' | 'rucno'

export interface DrugiBot {
  /** Ime u ugovoru (`izvor`), npr. `klaudio` / `saban`. */
  ime: string
  /** Telegram korisničko ime bez `@`, npr. `drugiAI_bot` — spomen u odgovoru = prijenos. */
  korisnickoIme: string
  /** Ploča drugog kraja, npr. `http://10.0.0.2:17781`. */
  url: string
  /**
   * Chatovi u kojima je ovaj bot drugi kraj (TASK-5728). Bez popisa = svi `chatovi` (kraj s jednim
   * drugim botom). S popisom bot ne prima zapise ni prijenose drugih grupa i ne smije u njih pisati.
   */
  chatovi?: string[]
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
  /**
   * Gleda li se adresa dolaznog zahtjeva (`adrese`). `false` SAMO gdje proces ne vidi pravu adresu
   * klijenta (glavna ploča u kontejneru: svi su `172.24.0.1`, TASK-5291 §13) — tada drži potpis.
   * `adrese` i dalje određuju kome smije ići potpisana poruka (N3).
   */
  provjeraAdrese: boolean
}

export const BOT_KANAL_ZADANO: Readonly<BotKanalPostavke> = Object.freeze({
  ukljucen: false, drugi: [], chatovi: [], adrese: [], ovlasti: 'citanje',
  stopKorisnici: [], strop: 6, prozorMin: 10, provjeraAdrese: true,
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

/**
 * Tijelo `POST /api/razgovor/od-bota/zapis` (TASK-5394): vidljiva poruka drugog bota u grupi kao
 * ZAPIS — Telegram je ovom botu ne dostavlja. Nije potez: ne pokreće model, ne broji se u strop.
 */
export interface BotZapis {
  izvor: string
  chatId: string
  tekst: string
  telegramPorukaId: string | null
  ts: string
}

/** Lanac koji nosi potez nastao iz bot-poruke — odgovor nastavlja isti lanac sa `skok+1`. */
export interface Lanac { izvor: string; lanacId: string; skok: number; izvornik: Izvornik | null }

export interface Odgovor { status: number; tijelo: Record<string, unknown> }

export const MAX_TEKST = 4000
const POLJA = ['izvor', 'chatId', 'tekst', 'telegramPorukaId', 'lanacId', 'skok', 'izvornik', 'ts']
const POLJA_ZAPISA = ['izvor', 'chatId', 'tekst', 'telegramPorukaId', 'ts']
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

// ─── Potpis (TASK-5299) ──────────────────────────────────────────────────────

export const PUT_RUTE = '/api/razgovor/od-bota'
export const ZAGLAVLJE_POTPISA = 'X-Bot-Kanal-Potpis'
/** Dopušteni pomak sata između dva kraja. */
export const POTPIS_ROK_S = 60
/** Najkraća tajna koja se priznaje (32 nasumična bajta = 64 hex znaka; ispod 32 znaka = nema je). */
export const MIN_TAJNA = 32
const PONOVLJENO_MS = 10 * 60_000

/** Imena tajni kanala (okolina stroja / spremište tajni); par po botu nosi sufiks `_<IME>` (TASK-5728). */
export const TAJNA_SLANJA = 'TM_BOT_KANAL_TAJNA_SLANJE'
export const TAJNA_PRIMANJA = 'TM_BOT_KANAL_TAJNA_PRIMANJE'

/** `TM_BOT_KANAL_TAJNA_SLANJE` + `martinafiles` → `TM_BOT_KANAL_TAJNA_SLANJE_MARTINAFILES`. */
export function imeTajneZa(osnova: string, drugi: string): string {
  return `${osnova}_${drugi.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

/**
 * Tajna za jednog drugog bota: najprije njegova (`<osnova>_<IME>`); zajednički par (`<osnova>`)
 * samo uz `zajednicka` — inače bi svaki novi bot dobio tajnu postojećeg i mogao se predstaviti kao on.
 */
export function tajnaZaBota(
  citaj: (ime: string) => string | null | undefined, osnova: string, drugi: string, zajednicka: boolean,
): string | undefined {
  return citaj(imeTajneZa(osnova, drugi)) || (zajednicka ? citaj(osnova) || undefined : undefined)
}

/** Imena tajni kanala za stranicu Tajne: zajednički par + par po svakom drugom botu (samo imena). */
export function imenaTajniKanala(drugi: string[]): { ime: string; izvor: string }[] {
  const out = [{ ime: TAJNA_SLANJA, izvor: 'botKanal' }, { ime: TAJNA_PRIMANJA, izvor: 'botKanal' }]
  for (const d of drugi) {
    for (const o of [TAJNA_SLANJA, TAJNA_PRIMANJA]) {
      const ime = imeTajneZa(o, d)
      if (!out.some(x => x.ime === ime)) out.push({ ime, izvor: `botKanal.${d}` })
    }
  }
  return out
}

/** Drugi botovi kojima pripada `chatId` (bez vlastitog popisa chatova = svi chatovi kanala). */
export function drugiUChatu(p: Pick<BotKanalPostavke, 'drugi'>, chatId: string): DrugiBot[] {
  return p.drugi.filter(x => !x.chatovi || x.chatovi.includes(chatId))
}

function hmacHex(tajna: string, poruka: string): string {
  return new Bun.CryptoHasher('sha256', tajna).update(poruka).digest('hex')
}

/** `t=<unix s>,v1=<HMAC-SHA256(tajna, "<t>\n<METODA>\n<put>\n<tijelo>")>` — tijelo je sirovi tekst. */
export function potpisi(tajna: string, metoda: string, put: string, tijelo: string, tsS: number): string {
  return `t=${tsS},v1=${hmacHex(tajna, `${tsS}\n${metoda.toUpperCase()}\n${put}\n${tijelo}`)}`
}

export type IshodPotpisa = 'ok' | 'nedostaje' | 'neispravan' | 'istekao'

export function provjeriPotpis(zaglavlje: string | null | undefined, tajna: string, metoda: string, put: string, tijelo: string, sadaMs: number): IshodPotpisa {
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(String(zaglavlje || '').trim())
  if (!m) return 'nedostaje'
  const ts = Number(m[1])
  // Prvo potpis, pa tek onda vrijeme: zastarjeli lažni potpis je i dalje „neispravan".
  if (!jednakaTajna(m[2]!, potpisi(tajna, metoda, put, tijelo, ts).slice(-64))) return 'neispravan'
  return Math.abs(sadaMs / 1000 - ts) <= POTPIS_ROK_S ? 'ok' : 'istekao'
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

/** Host iz adrese ploče (`http://10.0.0.2:17781` → `10.0.0.2`); nečitljivo = ''. */
export function hostUrla(url: string): string {
  try { return new URL(url).hostname.replace(/^\[|\]$/g, '') } catch { return '' }
}

/**
 * Potpisana poruka ide SAMO ploči čiji je host na popisu `adrese` (TASK-5291, N3): bez toga
 * promjena `drugi.url` (API ploče nema prijavu) šalje razgovor bilo kome. Tajna sama ne ide
 * nikamo (TASK-5299), ali sadržaj i dalje nije za tuđe.
 */
export function smijeTajnuNa(url: string, adrese: string[]): boolean {
  const h = hostUrla(url)
  return !!h && adrese.includes(h)
}

/** `::ffff:10.0.0.2` → `10.0.0.2`. */
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

/** Tijelo zapisa (TASK-5394) — isti uvjeti polja kao poruka, bez lanca. */
export function provjeriZapis(raw: unknown): { ok: true; value: BotZapis } | { ok: false; status: 400 | 413; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, status: 400, error: 'tijelo mora biti objekt' }
  const t = raw as Record<string, unknown>
  const nepoznato = Object.keys(t).filter(k => !POLJA_ZAPISA.includes(k))
  if (nepoznato.length) return { ok: false, status: 400, error: `Nepoznato polje: ${nepoznato.join(', ')}` }
  const v = provjeriTijelo({ ...t, lanacId: 'zapis', skok: 1 })
  if (!v.ok) return v
  const m = v.value
  return { ok: true, value: { izvor: m.izvor, chatId: m.chatId, tekst: m.tekst, telegramPorukaId: m.telegramPorukaId, ts: m.ts } }
}

// ─── Kanal ───────────────────────────────────────────────────────────────────

export interface BotKanalOvisnosti {
  /** Ime ovog kraja u ugovoru (`saban` na node-A, `klaudio` na glavnom stroju). */
  ja: string
  postavke: () => BotKanalPostavke
  /**
   * Tajne kanala, po jedna po smjeru (TASK-5299) i po drugom botu (TASK-5728, argument = `DrugiBot.ime`)
   * — nikad u postavkama, zapisu, okolini modela ni na žici. `tajnaSlanja` potpisuje odlazno
   * (`TM_BOT_KANAL_TAJNA_SLANJE[_<IME>]`), `tajnaPrimanja` provjerava dolazno
   * (`TM_BOT_KANAL_TAJNA_PRIMANJE[_<IME>]` = tajna slanja drugog kraja).
   */
  tajnaSlanja: (drugi: string) => string | undefined
  tajnaPrimanja: (drugi: string) => string | undefined
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

/**
 * Dolazni zahtjev: `tijelo` je SIROVI tekst tijela kako je stigao (potpisuje se i parsira samo on),
 * `potpis` je zaglavlje `X-Bot-Kanal-Potpis`, `ip` adresa klijenta kako je vidi proces.
 */
export interface Zahtjev { ip?: string | null; potpis?: string | null; tijelo?: string | null }

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
  /** Ruta `POST /api/razgovor/od-bota`. Uz 202 vraća i provjerenu poruku (iz potpisanih bajtova). */
  primi(z: Zahtjev): Odgovor & { poruka?: BotPoruka }
  /** Rute `POST /od-bota/stop` i `/od-bota/nastavi` (drugi kraj javlja; ne prosljeđuje se dalje). */
  primiStop(z: Zahtjev): Odgovor
  primiNastavak(z: Zahtjev): Odgovor
  /** Ruta `POST /od-bota/zapis` (TASK-5394): uz 202 vraća provjereni zapis — nikad potez. */
  primiZapis(z: Zahtjev): Odgovor & { zapis?: BotZapis }
  /** `GET /od-bota/stanje` — samo uz potpis; bez tajne u odgovoru. */
  stanjeZaDrugog(z: Zahtjev): Odgovor
  /** Poruka čovjeka u grupi. PRVA provjera, prije svih filtara (§4.2). */
  ljudska(p: { chatId: string; posiljateljId: string; posiljateljIme: string; tekst: string }): Promise<'stop' | 'nastavak' | null>
  /** Nakon slanja odgovora u grupu: prenesi drugom botu ako ga spominje (§5). */
  prenesi(u: PrijenosUlaz): Promise<PrijenosIshod>
  /**
   * TASK-5394: vlastita vidljiva poruka u grupi → zapis kod drugih botova (bez spomena, bez stropa,
   * i kad je razmjena zaustavljena — zapis ne pokreće model). Pad se ne javlja u grupu.
   */
  zapisi(u: { chatId: string; tekst: string; telegramPorukaId: string | null }): Promise<'poslano' | 'iskljuceno' | 'pad'>
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
  /** (izvor, lanacId, skok) primljenih poruka → ms; ponavljanje u 10 min = 409 (TASK-5299). */
  const primljeno = new Map<string, number>()
  const tajna = (f: () => string | undefined): string => { const t = f() || ''; return t.length >= MIN_TAJNA ? t : '' }

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

  /**
   * Autentikacija i opći uvjeti rute — `{ od }` = prolazi, `od` je bot čija je tajna potpisala zahtjev.
   * Potpis se provjerava nad metodom i putem RUTE koja obrađuje zahtjev (ne nad onim što klijent
   * tvrdi) i nad sirovim tijelom, tajnom primanja SVAKOG drugog bota (TASK-5728).
   */
  function vrata(z: Zahtjev, metoda: 'GET' | 'POST', put: string, chatId?: string): { greska: Odgovor } | { od: DrugiBot } {
    const ne = (status: number, error: string) => ({ greska: { status, tijelo: { error } } })
    const p = d.postavke()
    if (!p.ukljucen) return ne(403, 'kanal bot↔bot je isključen')
    const kandidati: { bot: DrugiBot; primanje: string }[] = []
    let isteSmjer = false
    for (const bot of p.drugi) {
      const primanje = tajna(() => d.tajnaPrimanja(bot.ime))
      if (!primanje) continue
      if (primanje === d.tajnaSlanja(bot.ime)) { isteSmjer = true; continue }
      kandidati.push({ bot, primanje })
    }
    // Dva bota s istom tajnom primanja: potpis ne kaže tko je — ne prima se nijedan od njih.
    const jedinstveni = kandidati.filter(k => kandidati.filter(x => x.primanje === k.primanje).length === 1)
    if (jedinstveni.length < kandidati.length) log('[bot-kanal] dva druga bota imaju istu tajnu primanja — ne primaju se (TASK-5728)')
    if (!jedinstveni.length) {
      return isteSmjer ? ne(403, 'tajne slanja i primanja moraju biti različite (po jedna po smjeru)')
        : ne(403, 'tajna primanja kanala nije postavljena na ovom stroju')
    }
    const tijelo = typeof z.tijelo === 'string' ? z.tijelo : ''
    let ishod: IshodPotpisa = 'neispravan'
    let od: DrugiBot | null = null
    for (const k of jedinstveni) {
      const i = provjeriPotpis(z.potpis, k.primanje, metoda, `${PUT_RUTE}${put}`, tijelo, sat())
      if (i === 'ok') { od = k.bot; break }
      if (i === 'istekao' || (i === 'nedostaje' && ishod !== 'istekao')) ishod = i
    }
    if (!od) {
      return ne(401, ishod === 'istekao' ? `potpis je stariji ili noviji od ${POTPIS_ROK_S} s (sat?)` : ishod === 'nedostaje' ? `nema zaglavlja ${ZAGLAVLJE_POTPISA}` : 'neispravan potpis')
    }
    if (p.provjeraAdrese !== false && !p.adrese.includes(cistaAdresa(z.ip))) return ne(403, 'adresa nije na popisu')
    if (chatId !== undefined) {
      const g = chatDrugog(p, od, chatId)
      if (g) return { greska: g }
    }
    return { od }
  }

  /** Chat mora biti na popisu kanala i na popisu bota pošiljatelja (TASK-5728). */
  function chatDrugog(p: BotKanalPostavke, od: DrugiBot, chatId: string): Odgovor | null {
    if (!p.chatovi.includes(chatId)) return { status: 403, tijelo: { error: 'chat nije na popisu' } }
    if (od.chatovi && !od.chatovi.includes(chatId)) return { status: 403, tijelo: { error: `chat nije na popisu za ${od.ime}` } }
    return null
  }

  /** Potpisano tijelo kao objekt; `null` = nije JSON. */
  const json = (z: Zahtjev): unknown => { try { return JSON.parse(String(z.tijelo ?? '')) } catch { return null } }

  /** Drugi botovi chata koji imaju tajnu slanja (bez nje bot ne dobiva ništa). */
  const primateljiChata = (p: BotKanalPostavke, chatId: string): { bot: DrugiBot; slanje: string }[] =>
    drugiUChatu(p, chatId).map(bot => ({ bot, slanje: tajna(() => d.tajnaSlanja(bot.ime)) })).filter(x => x.slanje)

  /** Poruka svim drugim botovima TOG chata, svakom potpisana njegovom tajnom (TASK-5728). */
  async function zaDrugog(put: string, tijelo: { chatId: string }): Promise<boolean> {
    const p = d.postavke()
    const primatelji = primateljiChata(p, tijelo.chatId)
    if (!primatelji.length) return false
    let ok = true
    for (const { bot, slanje } of primatelji) {
      if (!smijeTajnuNa(bot.url, p.adrese)) { log(`[bot-kanal] ${bot.ime}: host adrese ploče nije u popisu adresa — poruka ne ide`); ok = false; continue }
      const r = await posalji(bot.url, put, tijelo, slanje)
      ok = ok && r
    }
    return ok
  }

  /** Jedan ponovljeni pokušaj nakon `ponoviMs`; nema reda za kasniju isporuku (§5). Svaki pokušaj nosi svjež potpis. */
  async function posalji(baza: string, put: string, tijelo: unknown, slanje: string): Promise<boolean> {
    const url = `${baza.replace(/\/+$/, '')}${PUT_RUTE}${put}`
    const tekst = JSON.stringify(tijelo)
    for (let pokusaj = 1; pokusaj <= 2; pokusaj++) {
      try {
        const r = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [ZAGLAVLJE_POTPISA]: potpisi(slanje, 'POST', `${PUT_RUTE}${put}`, tekst, Math.floor(sat() / 1000)) },
          body: tekst,
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
    primi(z) {
      const vr = vrata(z, 'POST', '')
      if ('greska' in vr) return vr.greska
      const raw = json(z)
      if (raw === null) return { status: 400, tijelo: { error: 'Neispravan JSON' } }
      const v = provjeriTijelo(raw)
      if (!v.ok) return { status: v.status, tijelo: { error: v.error } }
      const m = v.value
      const p = d.postavke()
      if (m.izvor === d.ja) return { status: 409, tijelo: { razlog: 'vlastita' } }
      // Potpis je tajnom bota `vr.od` — tijelo ne smije tvrditi da je netko drugi (TASK-5728).
      if (!p.drugi.some(x => x.ime === m.izvor)) return { status: 403, tijelo: { error: 'izvor nije na popisu' } }
      if (m.izvor !== vr.od.ime) return { status: 401, tijelo: { error: 'potpis ne pripada izvoru poruke' } }
      const g = chatDrugog(p, vr.od, m.chatId)
      if (g) return g
      // Ponovljena poruka (snimljena pa ponovno poslana u roku potpisa ili s novim potpisom) — TASK-5299.
      const t = sat()
      for (const [k, ms] of primljeno) if (t - ms > PONOVLJENO_MS) primljeno.delete(k)
      const kljuc = `${m.izvor}\n${m.lanacId}\n${m.skok}`
      if (primljeno.has(kljuc)) return { status: 409, tijelo: { razlog: 'ponovljeno' } }
      primljeno.set(kljuc, t)
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

    primiStop(z) {
      const t = tijeloChata(json(z))
      if (!t) { const vr = vrata(z, 'POST', '/stop'); return 'greska' in vr ? vr.greska : { status: 400, tijelo: { error: 'chatId je obavezan' } } }
      const vr = vrata(z, 'POST', '/stop', t.chatId)
      if ('greska' in vr) return vr.greska
      void zaustavi(t.chatId, t.by, t.razlog || 'fraza', false)
      return { status: 200, tijelo: { ok: true, zaustavljen: true } }
    },

    primiNastavak(z) {
      const t = tijeloChata(json(z))
      if (!t) { const vr = vrata(z, 'POST', '/nastavi'); return 'greska' in vr ? vr.greska : { status: 400, tijelo: { error: 'chatId je obavezan' } } }
      const vr = vrata(z, 'POST', '/nastavi', t.chatId)
      if ('greska' in vr) return vr.greska
      // Nastavak s drugog kraja NE skida zastavicu (TASK-5291, N2): stop bi inače bio jak koliko
      // i slabiji kraj — tko ima tajnu ili ljusku na drugom stroju poništio bi stop vlasnika. Oba
      // kraja „Nastavi komunikaciju" vide sami iz grupe; gumb nastavlja samo svoj kraj.
      const zaustavljen = st().zastavice[t.chatId]?.zaustavljen === true
      if (zaustavljen) log(`[bot-kanal] ${t.chatId}: nastavak s drugog kraja (${t.by}) zanemaren — nastavlja se samo ovdje`)
      return { status: 200, tijelo: { ok: true, zaustavljen, napomena: 'nastavak se ne prenosi — samo na ovom kraju' } }
    },

    primiZapis(z) {
      const vr = vrata(z, 'POST', '/zapis')
      if ('greska' in vr) return vr.greska
      const raw = json(z)
      if (raw === null) return { status: 400, tijelo: { error: 'Neispravan JSON' } }
      const v = provjeriZapis(raw)
      if (!v.ok) return { status: v.status, tijelo: { error: v.error } }
      const m = v.value
      const p = d.postavke()
      if (m.izvor === d.ja) return { status: 409, tijelo: { razlog: 'vlastita' } }
      if (!p.drugi.some(x => x.ime === m.izvor)) return { status: 403, tijelo: { error: 'izvor nije na popisu' } }
      if (m.izvor !== vr.od.ime) return { status: 401, tijelo: { error: 'potpis ne pripada izvoru zapisa' } }
      const g = chatDrugog(p, vr.od, m.chatId)
      if (g) return g
      const t = sat()
      for (const [k, ms] of primljeno) if (t - ms > PONOVLJENO_MS) primljeno.delete(k)
      const kljuc = `zapis\n${m.izvor}\n${m.chatId}\n${m.telegramPorukaId ?? `${m.ts}\n${m.tekst.length}`}`
      if (primljeno.has(kljuc)) return { status: 409, tijelo: { razlog: 'ponovljeno' } }
      primljeno.set(kljuc, t)
      return { status: 202, tijelo: { zapisano: true }, zapis: m }
    },

    stanjeZaDrugog(z) {
      const vr = vrata(z, 'GET', '/stanje')
      if ('greska' in vr) return vr.greska
      // Samo zastavice chatova tog bota — drugi bot ne vidi stanje tuđih grupa (TASK-5728).
      const p = d.postavke()
      const zastavice = Object.fromEntries(Object.entries(st().zastavice)
        .filter(([c]) => p.chatovi.includes(c) && (!vr.od.chatovi || vr.od.chatovi.includes(c))))
      return { status: 200, tijelo: { ja: d.ja, zastavice } }
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
      // Poruka STOP-KORISNIKA nulira brojilo stropa (§4.3). Treći član grupe nije nadzor: inače
      // bi porukom svakih nekoliko prijenosa držao razmjenu ispod stropa (TASK-5291, N5).
      const s = st()
      if (smije && s.brojilo[m.chatId]?.length) {
        delete s.brojilo[m.chatId]
        d.spremiste.pisi(s)
      }
      return null
    },

    async prenesi(u) {
      const p = d.postavke()
      const primatelji = p.ukljucen && p.chatovi.includes(u.chatId) ? primateljiChata(p, u.chatId) : []
      if (!primatelji.length) return 'iskljuceno'
      const drugi = primatelji.filter(x => spominje(u.tekst, x.bot.korisnickoIme))
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
      for (const { bot: x, slanje } of drugi) {
        const smijeTajnu = smijeTajnuNa(x.url, p.adrese)
        if (!smijeTajnu) log(`[bot-kanal] ${x.ime}: host adrese ploče nije u popisu adresa — poruka ne ide`)
        const r = smijeTajnu && await posalji(x.url, '', tijelo, slanje)
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

    async zapisi(u) {
      const p = d.postavke()
      if (!p.ukljucen || !p.chatovi.includes(u.chatId) || !primateljiChata(p, u.chatId).length || !u.tekst.trim()) return 'iskljuceno'
      const tijelo: BotZapis = {
        izvor: d.ja, chatId: u.chatId, tekst: u.tekst.slice(0, MAX_TEKST),
        telegramPorukaId: u.telegramPorukaId || null, ts: new Date(sat()).toISOString(),
      }
      return (await zaDrugog('/zapis', tijelo)) ? 'poslano' : 'pad'
    },

    jeZaustavljen: chatId => st().zastavice[chatId]?.zaustavljen === true,
    zaustavi,
    nastavi,
    stanje: st,
  }
}
