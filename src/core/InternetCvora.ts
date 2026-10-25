// ─── Internet čvora: čitanje weba ≠ objava (TASK-5795) ───────────────────────
// Do sada je jedini izvor bila sklopka capguarda (`/api/capabilities` → allow_internet), a
// capguard postoji samo na RegocMobile Linuxu. Na macOS-u je zato internet uvijek bio „ne", pa je
// korpus pisao „objava na internet nije dopuštena" i model je odbijao i obično pretraživanje.
//
// Postavka čvora `TM_INTERNET` (config/postavke.env, piše je vlasnik):
//   off      — ni čitanje ni objava
//   citanje  — pretraživanje i dohvat stranica (WebSearch, WebFetch); objava i dalje uz odobrenje
//   objava   — čitanje i objava (GitHub, javni linkovi), uz pravila vlasnika
// Bez postavke vrijedi capguard kao prije (allow_internet = oboje), a bez capguarda ništa.
//
// Autorica: Jelena (Engineer), TASK-5795.

export type RazinaInterneta = 'off' | 'citanje' | 'objava'
export const RAZINE_INTERNETA: readonly RazinaInterneta[] = ['off', 'citanje', 'objava']

export interface InternetCvora {
  /** Pretraživanje weba i dohvat stranica. */
  citanje: boolean
  /** Objava van (GitHub push, javni linkovi, javne adrese). */
  objava: boolean
  /** Odakle je odluka: postavka čvora, capguard ili ništa (zadano zatvoreno). */
  izvor: 'TM_INTERNET' | 'capguard' | 'zadano'
}

/**
 * `env.TM_INTERNET` ima prednost; neispravna vrijednost se ne pogađa nego vrijedi kao da je nema.
 * `capguard` = `effective.allow_internet` s ploče (null = nema capguarda ili ploča ne odgovara).
 */
export function internetCvora(env: Record<string, string | undefined>, capguard: boolean | null = null): InternetCvora {
  const v = String(env.TM_INTERNET ?? '').trim().toLowerCase() as RazinaInterneta
  if (RAZINE_INTERNETA.includes(v)) return { citanje: v !== 'off', objava: v === 'objava', izvor: 'TM_INTERNET' }
  if (capguard !== null) return { citanje: capguard, objava: capguard, izvor: 'capguard' }
  return { citanje: false, objava: false, izvor: 'zadano' }
}

/** Rečenica za identitet razgovora (samo razina `puno` ima WebSearch/WebFetch). */
export function uputaInterneta(i: InternetCvora): string {
  if (!i.citanje) return 'Čitanje weba na ovom čvoru nije uključeno (postavka TM_INTERNET): ne pretražuj internet i ne dohvaćaj stranice; ako posao to traži, reci da vlasnik treba uključiti TM_INTERNET=citanje.'
  const citanje = 'Čitanje weba je na ovom čvoru UKLJUČENO: za aktualne podatke (vijesti, sportski rezultati, raspored, cijene, dokumentacija) pretraži internet (WebSearch) i dohvati stranice (WebFetch), pa navedi izvor.'
  return i.objava
    ? `${citanje} Objava na internet (GitHub, javni linkovi) je dopuštena uz pravila vlasnika.`
    : `${citanje} OBJAVA na internet (push na GitHub, javni linkovi, slanje podataka na vanjske servise) i dalje traži izričito odobrenje vlasnika — to se odnosi samo na objavu, ne na čitanje.`
}
