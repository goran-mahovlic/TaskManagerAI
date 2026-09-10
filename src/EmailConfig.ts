/**
 * EmailConfig — postavke izlazne (SMTP) i ulazne (IMAP) pošte (DIZAJN-integracije §3).
 *
 * IZLAZ: obavijest o zadatku, isti pozivatelj kao `obavijestiZadatak()` u Telegramu. Bun
 * nema ugrađen SMTP klijent, pa je `nodemailer` u `optionalDependencies` — bez njega
 * kartica jasno kaže što instalirati, a ostatak paketa radi. To je isti obrazac kao
 * `chromadb`/`ollama`: neobavezna sposobnost ne smije rušiti osnovnu instalaciju.
 *
 * ULAZ: poller po uzoru na Telegram — svaka poruka koja prođe filtar postaje JEDAN
 * `POST /api/ingest` sa `source: 'email'`. Nikakve odluke u polleru: pragove, projekt i
 * položaj po izvoru već rješava `IngestConfig`. Druga preslika tih pravila značila bi da
 * ista poruka iz e-pošte i iz Telegrama dobiva različitu sudbinu.
 *
 * SIGURNOSNA CRTA (za Malika): `filtar` je jedino polje koje bi bez provjere pustilo
 * korisnikov niz u IMAP naredbu → odbija se sve s `\r`, `\n` i navodnikom (CRLF injection).
 *
 * Autorica: Jelena (Engineer), TASK-4800.
 */

import { ConfigModul, tajnaPostavljena, type StanjeIntegracije } from './core/ConfigModul'
import { prigusenje, provjeriUrl } from './core/ProbeGuard'

export interface SmtpPostavke {
  host: string
  port: number
  tls: boolean
  korisnik: string
  lozinkaEnv: string
  posiljatelj: string
}

export interface ImapPostavke {
  host: string
  port: number
  tls: boolean
  korisnik: string
  lozinkaEnv: string
  mapa: string
  filtar: string
  intervalSek: number
  oznaciProcitano: boolean
}

export interface EmailPostavke {
  ukljucen: boolean
  smjer: 'izlaz' | 'ulaz' | 'oba'
  /**
   * Smije li „Probaj" ići na privatnu/lokalnu adresu? Zadano `false` — v. `probajEmail`.
   * (Nextcloud i GitLab imaju isto polje sa `true`, jer tamo je samostalno hostanje pravilo,
   * a ne iznimka; poštanski poslužitelj na kućnoj mreži jest iznimka i traži svjestan klik.)
   */
  dopustiPrivatneMreze: boolean
  smtp: SmtpPostavke
  imap: ImapPostavke
  primatelji: string[]
}

export const ZADANE_POSTAVKE: EmailPostavke = {
  ukljucen: false,
  smjer: 'izlaz',
  dopustiPrivatneMreze: false,
  smtp: { host: '', port: 587, tls: true, korisnik: '', lozinkaEnv: 'SMTP_PASSWORD', posiljatelj: '' },
  imap: {
    host: '', port: 993, tls: true, korisnik: '', lozinkaEnv: 'IMAP_PASSWORD',
    mapa: 'INBOX', filtar: '', intervalSek: 60, oznaciProcitano: true,
  },
  primatelji: [],
}

export const GRANICE = {
  host: { maxDuljina: 200 },
  port: { min: 1, max: 65535 },
  intervalSek: { min: 10, max: 3600 },
  filtar: { maxDuljina: 200 },
  primatelji: { maxStavki: 20 },
} as const

/** CRLF i navodnik ne smiju u IMAP naredbu — to je injekcija, ne filtar. */
const RE_FILTAR = /^[^"\r\n]*$/
const RE_EPOSTA = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const RE_ENV = /^[A-Z][A-Z0-9_]*$/

const posluziteljPolja = (tajna: string) => ({
  host: { tip: 'tekst' as const, maxDuljina: GRANICE.host.maxDuljina },
  port: { tip: 'broj' as const, min: GRANICE.port.min, max: GRANICE.port.max },
  tls: { tip: 'bool' as const },
  korisnik: { tip: 'tekst' as const, maxDuljina: 200 },
  lozinkaEnv: {
    tip: 'tekst' as const, maxDuljina: 64, tajnaEnv: true, uzorak: RE_ENV,
    uzorakPoruka: `upiši IME varijable okoline (npr. ${tajna}), ne lozinku`,
  },
})

const modul = new ConfigModul<EmailPostavke>({
  ime: 'email',
  datoteka: 'email.json',
  envVar: 'TM_EMAIL_CONFIG',
  zadane: ZADANE_POSTAVKE,
  shema: {
    ukljucen: { tip: 'bool' },
    smjer: { tip: 'izbor', vrijednosti: ['izlaz', 'ulaz', 'oba'] },
    dopustiPrivatneMreze: { tip: 'bool' },
    smtp: {
      tip: 'objekt',
      polja: {
        ...posluziteljPolja('SMTP_PASSWORD'),
        posiljatelj: {
          tip: 'tekst', maxDuljina: 200, uzorak: RE_EPOSTA,
          uzorakPoruka: 'mora biti adresa e-pošte',
        },
      },
    },
    imap: {
      tip: 'objekt',
      polja: {
        ...posluziteljPolja('IMAP_PASSWORD'),
        mapa: { tip: 'tekst', maxDuljina: 100 },
        filtar: {
          tip: 'tekst', maxDuljina: GRANICE.filtar.maxDuljina, uzorak: RE_FILTAR,
          uzorakPoruka: 'ne smije sadržavati navodnik ni prijelaz retka (IMAP naredba)',
        },
        intervalSek: { tip: 'broj', min: GRANICE.intervalSek.min, max: GRANICE.intervalSek.max },
        oznaciProcitano: { tip: 'bool' },
      },
    },
    primatelji: { tip: 'popis' },
  },
})

/**
 * Putanja se razrjesava PRI SVAKOM CITANJU (v. `ConfigModul.putanja`) — zamrznuta
 * vrijednost pokazivala bi na primjer uz paket i nakon prvog zapisa u `$TM_HOME/config/`.
 */
export function EMAIL_CONFIG_PATH(): string { return modul.putanja }

/** Sam modul — ploca ga treba za putanju i za stanje. */
export const emailKonfigModul = modul

export const loadEmailConfig = (path?: string) => modul.load(path)
export const saveEmailConfig = (zakrpa: Partial<EmailPostavke>, path?: string) => modul.save(zakrpa, path)

/** Uz shemu, provjeri i ono što shema ne zna: svaki primatelj mora biti adresa e-pošte. */
export function validateEmailPatch(tijelo: unknown) {
  const p = modul.validate(tijelo)
  const primatelji = (p.zakrpa as any)?.primatelji
  if (Array.isArray(primatelji)) {
    if (primatelji.length > GRANICE.primatelji.maxStavki) {
      p.greske.push(`primatelji: najviše ${GRANICE.primatelji.maxStavki} adresa`)
    }
    for (const a of primatelji) {
      if (!RE_EPOSTA.test(String(a))) p.greske.push(`primatelji: „${a}" nije adresa e-pošte`)
    }
  }
  p.ok = p.greske.length === 0
  return p
}

export function stanjeEmail(cfg: EmailPostavke = loadEmailConfig()): StanjeIntegracije & {
  smtpSpreman: boolean
  imapSpreman: boolean
  knjiznicaPrisutna: boolean
} {
  const smtpTajna = tajnaPostavljena(cfg.smtp.lozinkaEnv)
  const imapTajna = tajnaPostavljena(cfg.imap.lozinkaEnv)
  const smtpSpreman = !!(cfg.smtp.host && cfg.smtp.korisnik && cfg.smtp.posiljatelj && smtpTajna)
  const imapSpreman = !!(cfg.imap.host && cfg.imap.korisnik && imapTajna)
  const knjiznicaPrisutna = imaNodemailer()

  const trebaIzlaz = cfg.smjer === 'izlaz' || cfg.smjer === 'oba'
  const trebaUlaz = cfg.smjer === 'ulaz' || cfg.smjer === 'oba'

  let zastoKey = 'int_zasto_spreman'
  let zastoVars: Record<string, string> | undefined
  let spreman = true
  if (!cfg.ukljucen) { spreman = false; zastoKey = 'int_zasto_iskljucen' }
  else if (trebaIzlaz && !cfg.smtp.host) { spreman = false; zastoKey = 'int_zasto_nema_adrese' }
  else if (trebaIzlaz && !smtpTajna) { spreman = false; zastoKey = 'int_zasto_treba_kljuc'; zastoVars = { env: cfg.smtp.lozinkaEnv } }
  else if (trebaIzlaz && !knjiznicaPrisutna) { spreman = false; zastoKey = 'int_zasto_treba_knjiznica'; zastoVars = { paket: 'nodemailer' } }
  else if (trebaUlaz && !imapSpreman) { spreman = false; zastoKey = 'int_zasto_nepotpun_ulaz' }
  else if (trebaIzlaz && !cfg.primatelji.length) { spreman = false; zastoKey = 'int_zasto_nema_primatelja' }

  return {
    ukljucen: cfg.ukljucen,
    tajnaPostavljena: smtpTajna || imapTajna,
    spreman, zastoKey, zastoVars,
    smtpSpreman, imapSpreman, knjiznicaPrisutna,
  }
}

/** Je li neobavezna knjižnica instalirana? Provjerava se razrješavanjem, bez učitavanja. */
export function imaNodemailer(): boolean {
  try {
    // `import.meta.resolveSync` ne izvršava modul — samo kaže postoji li.
    ;(import.meta as any).resolveSync?.('nodemailer')
    return !!(import.meta as any).resolveSync
  } catch {
    return false
  }
}

// ─── Izlaz ───────────────────────────────────────────────────────────────────

export interface Ishod { ok: boolean; greska?: string; detalj?: Record<string, unknown> }

/**
 * Pošalji obavijest e-poštom. Bez `nodemailer`-a vraća uputu, ne iznimku — instalacija bez
 * te knjižnice je normalno stanje, a ne kvar.
 */
export async function posaljiEmail(
  naslov: string, tekst: string, path?: string,
): Promise<Ishod> {
  const cfg = loadEmailConfig(path)
  if (!cfg.ukljucen) return { ok: false, greska: 'e-pošta je isključena' }
  if (cfg.smjer === 'ulaz') return { ok: false, greska: 'postavljen je samo ulazni smjer' }
  if (!cfg.smtp.host) return { ok: false, greska: 'SMTP poslužitelj nije upisan' }
  if (!cfg.primatelji.length) return { ok: false, greska: 'nijedan primatelj nije upisan' }

  const { procitajTajnu } = await import('./core/ConfigModul')
  const lozinka = procitajTajnu(cfg.smtp.lozinkaEnv)
  if (!lozinka) return { ok: false, greska: `lozinka nije postavljena (varijabla ${cfg.smtp.lozinkaEnv})` }

  let nodemailer: any
  try {
    nodemailer = await import('nodemailer')
  } catch {
    return { ok: false, greska: 'za e-poštu instaliraj knjižnicu: bun add nodemailer' }
  }
  try {
    const prijenos = (nodemailer.default || nodemailer).createTransport({
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      secure: cfg.smtp.tls && cfg.smtp.port === 465,
      requireTLS: cfg.smtp.tls,
      auth: { user: cfg.smtp.korisnik, pass: lozinka },
    })
    const info = await prijenos.sendMail({
      from: cfg.smtp.posiljatelj,
      to: cfg.primatelji.join(', '),
      subject: naslov,
      text: tekst,
    })
    return { ok: true, detalj: { messageId: info?.messageId } }
  } catch (e: any) {
    return { ok: false, greska: String(e?.message || e) }
  }
}

/** Obavijest o zadatku — isti oblik i isti prekidači kao Telegram. */
export async function obavijestiZadatakEmail(
  taskId: string, naslov: string, status: string, path?: string,
): Promise<Ishod> {
  const ikona = status === 'completed' ? '✅' : status === 'failed' ? '❌' : '📋'
  return posaljiEmail(`${ikona} ${taskId} — ${status}`, `${naslov}\n\nZadatak: ${taskId}\nStatus: ${status}\n`, path)
}

// ─── Proba ───────────────────────────────────────────────────────────────────

/**
 * Vrata koja „Probaj" smije dodirnuti. Popis, ne raspon.
 *
 * KVAR KOJI OVO ZATVARA (revizija TASK-4801, nalaz B1): shema pušta vrata 1–65535, pa je
 * gumb „Probaj" bio skener vrata s odgovorom natrag u tijelu API-ja — izmjereno 5030 ms na
 * otvorenima naspram 24 ms na zatvorenima, i to na DRUGIM strojevima u mreži, bez ijedne
 * prijave. Samo slanje i dalje smije koristiti bilo koja vrata (ima instalacija na 2525);
 * ograničen je isključivo put koji stranac može pokrenuti.
 */
export const POSTANSKA_VRATA: readonly number[] = [25, 143, 465, 587, 993] as const

/**
 * Provjeri par (host, vrata) PRIJE ijednog mrežnog poziva.
 *
 * Host nije URL nego golo ime, pa se za `provjeriUrl` sastavlja privremena adresa — time
 * e-pošta dobiva istu obranu (sheme, privatni rasponi, vjerodajnice u adresi) koju
 * Nextcloud već ima, umjesto druge preslike pravila koja bi se razišla s prvom.
 */
export function provjeriPosluzitelj(
  host: string, port: number, dopustiPrivatneMreze: boolean,
): { ok: boolean; greska?: string } {
  const h = String(host || '').trim()
  if (!h) return { ok: false, greska: 'poslužitelj nije upisan' }
  // Prvo ADRESA, pa vrata: „ova adresa je u privatnoj mreži" je odluka koju je korisnik
  // donio na kartici i koju može promijeniti; popis vrata je tvrdo pravilo. Kad su oba
  // prekršena, korisniku je korisniji prvi razlog.
  // `https://` je ovdje samo nosač imena: nikakav HTTP zahtjev ne slijedi.
  const provjera = provjeriUrl(`https://${h}`, { dopustiPrivatneMreze })
  if (!provjera.ok) return { ok: false, greska: provjera.greska }
  if (!POSTANSKA_VRATA.includes(Number(port))) {
    return {
      ok: false,
      greska: `vrata ${port} nisu poštanska — proba ide samo na ${POSTANSKA_VRATA.join(', ')}`,
    }
  }
  return { ok: true }
}

/**
 * SMTP: `EHLO` + `AUTH`, BEZ slanja poruke (proba koja šalje poštu je slanje, ne proba).
 * IMAP: veza pa odmah prekid.
 *
 * Bez `nodemailer`-a proba za izlaz vraća uputu za instalaciju; ulaz se provjerava golom
 * TLS vezom, pa za njega knjižnica nije potrebna.
 *
 * TRI OBRANE IZ REVIZIJE TASK-4801 (nalaz B1), redom kojim se izvode:
 *   1. isključena integracija ne dira mrežu — prekidač na kartici mora nešto značiti;
 *   2. `prigusenje('email')` — jedna proba u 5 s, da nizanje ne postane skener;
 *   3. `provjeriPosluzitelj` (privatne mreže, pa popis poštanskih vrata) PRIJE poziva.
 * Ishod nosi samo `ok`/`trajanjeMs`: pozdrav poslužitelja se više ne vraća pozivatelju.
 *
 * ZAŠTO PRIGUŠENJE IDE PRIJE PROVJERE ADRESE. I sama odbijenica je odgovor: „ova adresa je
 * privatna" / „ova vrata nisu poštanska" razlikuje se od „poslužitelj se nije javio", pa bi
 * neograničen niz odbijenica i dalje bio brz upitnik o tuđoj mreži. Dopusnicu zato troši
 * SVAKA proba, uspješna ili ne.
 */
export async function probajEmail(path?: string): Promise<Ishod> {
  const cfg = loadEmailConfig(path)
  const trebaIzlaz = cfg.smjer === 'izlaz' || cfg.smjer === 'oba'
  const trebaUlaz = cfg.smjer === 'ulaz' || cfg.smjer === 'oba'
  const detalj: Record<string, unknown> = {}
  const greske: string[] = []

  // 1) Prekidač na kartici gasi i probu. Prije je proba radila i uz `ukljucen: false`.
  if (!cfg.ukljucen) return { ok: false, greska: 'e-pošta je isključena — uključi ju pa probaj' }

  // 2) Prigušenje. Bez njega je pet proba za redom savršen skener (izmjereno u reviziji).
  const p = prigusenje('email')
  if (!p.ok) return { ok: false, greska: `pričekaj još ${Math.ceil(p.cekajMs / 1000)} s prije nove probe` }

  // 3) Adrese — PRIJE ijednog mrežnog poziva, za oba smjera.
  const provjere = [
    trebaIzlaz && cfg.smtp.host
      ? provjeriPosluzitelj(cfg.smtp.host, cfg.smtp.port, cfg.dopustiPrivatneMreze) : null,
    trebaUlaz && cfg.imap.host
      ? provjeriPosluzitelj(cfg.imap.host, cfg.imap.port, cfg.dopustiPrivatneMreze) : null,
  ]
  const odbijena = provjere.find(x => x && !x.ok)
  if (odbijena) return { ok: false, greska: odbijena.greska }

  if (trebaIzlaz) {
    if (!cfg.smtp.host) greske.push('SMTP poslužitelj nije upisan')
    else {
      let nodemailer: any = null
      try { nodemailer = await import('nodemailer') } catch { /* nema je */ }
      if (!nodemailer) greske.push('za SMTP probu instaliraj: bun add nodemailer')
      else {
        const { procitajTajnu } = await import('./core/ConfigModul')
        const lozinka = procitajTajnu(cfg.smtp.lozinkaEnv)
        if (!lozinka) greske.push(`SMTP lozinka nije postavljena (varijabla ${cfg.smtp.lozinkaEnv})`)
        else {
          try {
            const prijenos = (nodemailer.default || nodemailer).createTransport({
              host: cfg.smtp.host, port: cfg.smtp.port,
              secure: cfg.smtp.tls && cfg.smtp.port === 465, requireTLS: cfg.smtp.tls,
              auth: { user: cfg.smtp.korisnik, pass: lozinka },
            })
            await prijenos.verify()
            detalj.smtp = 'prijava prihvaćena'
          } catch (e: any) {
            greske.push(`SMTP: ${String(e?.message || e)}`)
          }
        }
      }
    }
  }

  if (trebaUlaz) {
    if (!cfg.imap.host) greske.push('IMAP poslužitelj nije upisan')
    else {
      const r = await probajImapVezu(cfg)
      if (r.ok) detalj.imap = 'veza uspostavljena'
      else greske.push(`IMAP: ${r.greska}`)
    }
  }

  return greske.length ? { ok: false, greska: greske.join('; '), detalj } : { ok: true, detalj }
}

/**
 * Gola TLS veza do IMAP-a: čeka da se poslužitelj javi i odmah se odspoji.
 *
 * ŠTO SE VRAĆA: samo `ok` i `trajanjeMs`. Prije se vraćalo prvih 120 B pozdrava
 * poslužitelja (revizija TASK-4801, B1) — to je čitanje tuđeg odgovora kroz našu ploču,
 * suprotno pravilu iz `ProbeGuard`: „proba vraća SAŽETAK, nikad sirovo tijelo".
 *
 * Namjerno NE šalje `LOGIN` bez knjižnice — ručno sastavljena IMAP naredba s korisničkim
 * nizom je upravo ona injekcija koju `filtar` provjerom sprječavamo.
 */
export const IMAP_ROK_MS = 5000

export async function probajImapVezu(cfg: EmailPostavke): Promise<Ishod> {
  const pocetak = Date.now()
  // Rukovatelji se PREDAJU `Bun.connect`-u unaprijed. Prijašnja izvedba pridruživala je
  // `socket.data = …` NAKON spajanja — to se nikad nije okinulo, pa je svaka otvorena
  // vrata čekala punih 5 s (upravo onih „5030 ms" iz revizije, koje su i bile orakl).
  let javise: (v: boolean) => void = () => { /* postavlja se odmah niže */ }
  const cekaj = new Promise<boolean>((resolve) => { javise = resolve })
  let socket: any = null

  // ROK OBUHVAĆA I SPAJANJE, ne samo čekanje na odgovor. `Bun.connect` prema adresi koja
  // ne odgovori (vatrozid tiho odbacuje SYN) visi do OS-ovog roka — izmjereno 12 s, dulje
  // od `idleTimeout` samog poslužitelja, pa je zahtjev pucao bez tijela. Uz to je razlika
  // „odbijeno odmah" naspram „visi 12 s" opet orakl o tuđoj mreži. S rokom oko CIJELE
  // radnje svaki ishod staje u istih 5 s.
  let istekao = false
  const rok = setTimeout(() => { istekao = true; javise(false) }, IMAP_ROK_MS)
  const porukaIsteka = `poslužitelj se nije javio u ${Math.round(IMAP_ROK_MS / 1000)} s`

  let greskaVeze: string | null = null
  // Veza se NIKAD ne ostavlja bez rukovatelja: i uspjeh i neuspjeh se obrađuju ovdje, pa
  // spajanje koje dođe NAKON isteka roka odmah zatvara vlastiti socket (inače bi ostao
  // otvoren prema tuđem poslužitelju, bez ijednog čitatelja).
  const veza = Bun.connect({
    hostname: cfg.imap.host,
    port: cfg.imap.port,
    tls: cfg.imap.tls,
    socket: {
      // Sadržaj se NAMJERNO ne čita: zanima nas samo je li se poslužitelj javio.
      data() { javise(true) },
      error() { javise(false) },
      close() { javise(false) },
    },
  }).then(
    (s: any) => {
      if (istekao) { try { s?.end() } catch { /* već zatvoren */ } return null }
      socket = s
      return s
    },
    (e: any) => { greskaVeze = String(e?.message || e).slice(0, 200); javise(false); return null },
  )

  try {
    const otvorena = await Promise.race([veza, cekaj.then(() => null)])
    if (!otvorena) {
      // Rok je istekao ili se spajanje izjalovilo — u oba slučaja bez tuđeg sadržaja.
      return { ok: false, greska: istekao ? porukaIsteka : (greskaVeze || porukaIsteka) }
    }
    // Veza je otvorena — ostatak roka teče dalje na čekanje da poslužitelj progovori.
    const javio = await cekaj
    return javio
      ? { ok: true, detalj: { trajanjeMs: Date.now() - pocetak } }
      : { ok: false, greska: greskaVeze || porukaIsteka }
  } finally {
    clearTimeout(rok)
    try { socket?.end() } catch { /* već zatvoren */ }
  }
}
