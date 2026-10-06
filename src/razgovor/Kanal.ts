// ─── Kanal (ADR-0002 §10) ────────────────────────────────────────────────────
// Sučelje između razgovornog sloja i kanala. Jezgra ne vidi nijedan Telegram ni Signal tip:
// adapter kanala prevodi protokol u `UlaznaPoruka` i sam odlučuje je li poruka upućena botu
// (spomen se u Telegramu i Signalu bilježi različito).
//
// Autorica: Jelena (Engineer), TASK-5277.

export type ImeKanala = 'telegram' | 'signal'

export interface UlaznaPoruka {
  kanal: ImeKanala
  chatId: string
  porukaId: string
  posiljateljId: string
  posiljateljIme: string
  /** Korisničko ime u kanalu (Telegram `username`), bez `@`; nema ga svaki korisnik. */
  posiljateljKorisnickoIme?: string
  posiljateljJeBot: boolean
  tekst: string
  ts: string
  privatno: boolean
  /** Adapter: vlastiti spomen / ime na početku / odgovor na poruku ovog bota. */
  obracanjeBotu: boolean
  /**
   * Adapter: TUĐI spomeni u poruci (bez vlastitog) — korisnička imena malim slovima bez `@`,
   * a spomen korisnika bez imena kao `id:<n>`. Za tišinu kad je poruka za drugoga (TASK-5283).
   */
  spomeni?: string[]
  /** Adapter: poruka je odgovor (reply) na poruku NEKOG DRUGOG (ne ovog bota). */
  odgovorNa?: OdgovorNa
  /** Adapter: tekst je transkript glasovne/zvučne poruke (`[GLAS] …`, TASK-5294). */
  glasovna?: boolean
}

export interface OdgovorNa {
  id: string
  /** Malim slovima, bez `@`. */
  korisnickoIme?: string
  ime?: string
  jeBot: boolean
}

export interface Kanal {
  ime: ImeKanala
  /** Telegram: 4096. */
  maxDuljinaPoruke: number
  /** Telegram bot: 50 MB. */
  maxDokumentBajta: number
  posaljiTekst(chatId: string, tekst: string, replyTo?: string): Promise<boolean>
  posaljiDokument(chatId: string, putanja: string, opis: string): Promise<boolean>
  /** Glasovna poruka (ogg/opus) — TASK-5294. Kanal bez glasa je ne mora imati. */
  posaljiGlas?(chatId: string, ogg: Uint8Array, replyTo?: string): Promise<boolean>
  /** „tipka…" dok model radi. */
  pise?(chatId: string): Promise<void>
}

export interface Razgovor {
  /** Ne čeka odgovor — kanal (long-poll) se ne smije zaustaviti dok model razmišlja. */
  primi(p: UlaznaPoruka, k: Kanal): void
}
