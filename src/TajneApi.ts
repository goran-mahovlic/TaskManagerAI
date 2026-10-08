/**
 * TajneApi — `/api/tajne*`: upis, rotacija i brisanje tajni čvora s ploče (ADR-0007).
 *
 * SAMO-ZA-PISANJE: nijedna ruta ne vraća vrijednost — ni GET, ni greška, ni audit. Odgovor
 * nosi ime, postoji/ne, HMAC otisak, oblik retka, zasjenjenost i zadnji događaj (tko/kada).
 *
 * Brane, redom (§4): CSRF (X-TM-Tajne, JSON, Sec-Fetch-Site, vlastiti Origin) → prijenos
 * (loopback / Tailscale / HTTPS; čisti LAN HTTP samo uz `dopustiLanHttp`; IP peera, nikad
 * X-Forwarded-For) → popis imena (§6) → kod iz vlasnikova privatnog Telegrama (§4.2) →
 * JEDINI pisač `LoginCreds.upisiTajnu/ukloniTajnu`.
 *
 * Čista funkcija nad (zahtjev, kontekst): TaskWebUI samo prosljeđuje, test zove izravno.
 * Dnevnik dobiva samo `[TAJNE] <radnja> <IME> <ishod> <prijenos>` (§8.1).
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'
import {
  imeZabranjeno, IME_RE, kljucOtiskaUz, opisStarogRetka, otisak, parsirajRedak, upisiTajnu,
  provjeriVrijednost, ukloniTajnu, type DopustenoIme,
} from './LoginCreds'
import type { PotvrdaVlasnika, RadnjaTajne } from './core/PotvrdaVlasnika'

export interface PostavkeTajni { potvrdaUid: string[]; dopustiLanHttp: boolean }

export interface KontekstTajni {
  spremiste: string
  auditPut: string
  dogadajiPut: string
  potvrda: PotvrdaVlasnika
  postavke: () => PostavkeTajni
  imena: () => DopustenoIme[]
  /** Okolina procesa (zasjenjenost, §7.1). Zadano `process.env`. */
  env?: Record<string, string | undefined>
  log?: (redak: string) => void
  sat?: () => number
}

export interface ZahtjevTajni {
  metoda: string
  put: string
  zaglavlja: Headers
  ip: string | null
  tls: boolean
  tijelo: string
}

export interface OdgovorTajni { status: number; tijelo: any; zaglavlja: Record<string, string> }

const NAJVECE_TIJELO = 64 * 1024
const NAJVISE_U_SKUPINI = 20
/** Kod je vezan uz TOČAN skup imena: kod za {A,B} ne vrijedi za {A}. */
const kljucSkupine = (imena: string[]): string => [...new Set(imena)].sort().join(', ')

// ─── Prijenos (§4.3) ─────────────────────────────────────────────────────────

export type VrstaPrijenosa = 'loopback' | 'tailscale' | 'https' | 'lan-http' | 'nepoznat'

export function odlukaPrijenosa(ip: string | null, tls: boolean, p: { dopustiLanHttp: boolean }):
  { dopusten: boolean; vrsta: VrstaPrijenosa; razlog?: string } {
  if (!ip) return { dopusten: false, vrsta: 'nepoznat', razlog: 'tajne_prijenos_nepoznat' }
  const a = ip.toLowerCase().replace(/^::ffff:/, '')
  if (/^127\./.test(a) || a === '::1') return { dopusten: true, vrsta: 'loopback' }
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(a)
  if (v4 && Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127) return { dopusten: true, vrsta: 'tailscale' }
  if (/^fd7a:115c:a1e0:/.test(a)) return { dopusten: true, vrsta: 'tailscale' }
  if (tls) return { dopusten: true, vrsta: 'https' }
  if (p.dopustiLanHttp) return { dopusten: true, vrsta: 'lan-http' }
  return { dopusten: false, vrsta: 'lan-http', razlog: 'tajne_lan_http' }
}

// ─── CSRF (§4.4) ─────────────────────────────────────────────────────────────

function csrfGreska(z: ZahtjevTajni): string | null {
  const h = z.zaglavlja
  if (h.get('x-tm-tajne') !== '1') return 'tajne_csrf'
  const sfs = h.get('sec-fetch-site')
  if (sfs && sfs !== 'same-origin') return 'tajne_csrf'
  const origin = h.get('origin')
  if (origin) {
    try { if (new URL(origin).host !== (h.get('host') || '')) return 'tajne_csrf' } catch { return 'tajne_csrf' }
  }
  if (z.metoda !== 'GET' && !(h.get('content-type') || '').toLowerCase().startsWith('application/json')) return 'tajne_csrf'
  return null
}

// ─── Audit i događaji (§7.2, §7.3) ───────────────────────────────────────────

interface AuditRedak {
  kada: string; radnja: string; ime: string | null; ishod: string
  otisakPrije?: string | null; otisak?: string | null; ip: string | null; prijenos: string
  zahtjevId?: string | null; potvrda?: string | null; razlog?: string | null
}

function dopisi(put: string, red: object): void {
  try {
    mkdirSync(dirname(put), { recursive: true, mode: 0o700 })
    appendFileSync(put, JSON.stringify(red) + '\n', { mode: 0o600 })
    chmodSync(put, 0o600)
  } catch { /* audit ne smije srušiti upis; greška se ne citira */ }
}

function zadnjiDogadaji(put: string): Map<string, AuditRedak> {
  const out = new Map<string, AuditRedak>()
  try {
    for (const l of readFileSync(put, 'utf-8').split('\n')) {
      if (!l) continue
      try {
        const r = JSON.parse(l) as AuditRedak
        if (r.ime && r.ishod === 'ok' && (r.radnja === 'upis' || r.radnja === 'brisanje')) out.set(r.ime, r)
      } catch {}
    }
  } catch {}
  return out
}

// ─── Obrada ──────────────────────────────────────────────────────────────────

const ODGOVOR_ZAGLAVLJA = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }

export async function obradiTajne(z: ZahtjevTajni, ctx: KontekstTajni): Promise<OdgovorTajni> {
  const env = ctx.env || process.env
  const sat = ctx.sat || Date.now
  const postavke = ctx.postavke()
  const prijenos = odlukaPrijenosa(z.ip, z.tls, postavke)
  const kljucPut = kljucOtiskaUz(ctx.spremiste)
  const odg = (status: number, tijelo: any): OdgovorTajni => ({ status, tijelo, zaglavlja: { ...ODGOVOR_ZAGLAVLJA } })
  const audit = (radnja: string, ime: string | null, ishod: string, dodatno: Partial<AuditRedak> = {}) => {
    dopisi(ctx.auditPut, { kada: new Date(sat()).toISOString(), radnja, ime, ishod, ip: z.ip, prijenos: prijenos.vrsta, ...dodatno })
    ctx.log?.(`[TAJNE] ${radnja} ${ime ?? '-'} ${ishod} ${prijenos.vrsta}`)
  }
  const odbij = (status: number, greska: string, ime: string | null, radnja = 'odbijeno') => {
    audit(radnja, ime, 'odbijeno', { razlog: greska })
    return odg(status, { greska })
  }

  const csrf = csrfGreska(z)
  if (csrf) return odbij(403, csrf, null)

  const dio = z.put.replace(/^\/api\/tajne\/?/, '')
  const dopustena = ctx.imena()
  const naPopisu = (ime: unknown): ime is string =>
    typeof ime === 'string' && IME_RE.test(ime) && !imeZabranjeno(ime) && dopustena.some(d => d.ime === ime)

  // GET /api/tajne — popis bez ijedne vrijednosti.
  if (z.metoda === 'GET' && dio === '') {
    let redovi: string[] = []
    try { redovi = existsSync(ctx.spremiste) ? readFileSync(ctx.spremiste, 'utf-8').split('\n') : [] } catch {}
    const zadnje = zadnjiDogadaji(ctx.auditPut)
    const tajne = dopustena.map(d => {
      let redak: string | null = null, vrijednost: string | null = null
      for (const r of redovi) { const p = parsirajRedak(r); if (p && p.ime === d.ime) { redak = r; vrijednost = p.vrijednost } }
      const postoji = !!vrijednost
      const o = postoji ? opisStarogRetka(redak!) : { oblik: 'novi', opasan: false }
      const zd = zadnje.get(d.ime)
      return {
        ime: d.ime, izvor: d.izvor, postoji,
        otisak: postoji ? otisak(vrijednost!, kljucPut) : null,
        oblik: o.oblik, opasan: o.opasan,
        zasjenjena: !!env[d.ime],
        zadnje: zd ? { radnja: zd.radnja, kada: zd.kada, ip: zd.ip, prijenos: zd.prijenos } : null,
      }
    })
    return odg(200, {
      tajne,
      potvrda: { podesena: postavke.potvrdaUid.length > 0, primatelja: postavke.potvrdaUid.length },
      prijenos,
      zakljucano: ctx.potvrda.zakljucano(),
    })
  }

  if (!['POST', 'PUT', 'DELETE'].includes(z.metoda)) return odg(405, { greska: 'metoda_nije_dopustena' })
  if (!prijenos.dopusten) return odbij(403, prijenos.razlog || 'tajne_prijenos', null)
  if (z.tijelo.length > NAJVECE_TIJELO) return odbij(413, 'tijelo_preveliko', null)
  let t: any
  try { t = z.tijelo ? JSON.parse(z.tijelo) : {} } catch { return odbij(400, 'tijelo_neispravno', null) }
  if (!t || typeof t !== 'object' || Array.isArray(t)) return odbij(400, 'tijelo_neispravno', null)

  // POST /api/tajne/kod {ime | imena[], radnja} — kod ide u vlasnikov privatni Telegram.
  // Jedan kod pokriva cijelu skupinu (uputa #194: jedan „Spremi" po skupini postavki).
  if (z.metoda === 'POST' && dio === 'kod') {
    const radnja = t.radnja === 'brisanje' ? 'brisanje' : t.radnja === 'upis' ? 'upis' : null
    if (!radnja) return odbij(400, 'radnja_neispravna', null)
    const trazena: unknown[] = Array.isArray(t.imena) ? t.imena : [t.ime]
    const los = trazena.find(i => !naPopisu(i))
    if (los !== undefined || !trazena.length || trazena.length > NAJVISE_U_SKUPINI || (radnja === 'brisanje' && trazena.length !== 1)) {
      return odbij(400, 'ime_nije_dopusteno', typeof los === 'string' && IME_RE.test(los) ? los : null)
    }
    const kljuc = kljucSkupine(trazena as string[])
    const r = await ctx.potvrda.zatrazi(kljuc, radnja)
    if (!r.ok) {
      const status = r.greska === 'zakljucano' ? 429 : r.greska === 'potvrda_nije_podesena' ? 409 : 502
      return odbij(status, r.greska, kljuc, r.greska === 'zakljucano' ? 'zakljucano' : 'odbijeno')
    }
    audit('kod_poslan', kljuc, 'ok', { zahtjevId: r.zahtjevId, potvrda: 'telegram' })
    return odg(200, { zahtjevId: r.zahtjevId, istjece: r.istjece, poslanoNa: r.poslanoNa })
  }

  // PUT /api/tajne {vrijednosti:{IME:v}}, PUT /api/tajne/:ime {vrijednost}, DELETE /api/tajne/:ime
  if (z.metoda === 'POST' || dio === 'kod') return odg(405, { greska: 'metoda_nije_dopustena' })
  const radnja: RadnjaTajne = z.metoda === 'PUT' ? 'upis' : 'brisanje'
  const skupno = dio === ''
  if (skupno && radnja === 'brisanje') return odg(405, { greska: 'metoda_nije_dopustena' })
  let upisi: [string, unknown][]
  if (skupno) {
    if (!t.vrijednosti || typeof t.vrijednosti !== 'object' || Array.isArray(t.vrijednosti)) return odbij(400, 'tijelo_neispravno', null)
    upisi = Object.entries(t.vrijednosti)
  } else {
    let ime = ''
    try { ime = decodeURIComponent(dio) } catch {}
    upisi = [[ime, t.vrijednost]]
  }
  if (!upisi.length || upisi.length > NAJVISE_U_SKUPINI) return odbij(400, 'ime_nije_dopusteno', null)
  for (const [ime] of upisi) if (!naPopisu(ime)) return odbij(400, 'ime_nije_dopusteno', IME_RE.test(ime) ? ime : null)
  if (radnja === 'upis') {
    // Vrijednosti se provjeravaju PRIJE koda: pogrešno upisana lozinka ne troši kod, a skupina
    // se upisuje sva ili nijedna.
    for (const [ime, v] of upisi) {
      const g = provjeriVrijednost(v)
      if (g) { audit('odbijeno', ime, 'odbijeno', { razlog: g }); return odg(400, skupno ? { greska: g, ime } : { greska: g }) }
    }
  }
  const imena = upisi.map(([i]) => i)
  const kljuc = kljucSkupine(imena)
  const p = ctx.potvrda.provjeri(t.zahtjevId, t.kod, kljuc, radnja)
  if (!p.ok) {
    const status = p.greska === 'zakljucano' ? 429 : 403
    return odbij(status, p.greska, kljuc, p.greska === 'kod_pogresan' ? 'kod_pogresan' : p.greska === 'zakljucano' ? 'zakljucano' : 'odbijeno')
  }
  const rezultati: any[] = []
  const upozorenja: string[] = []
  for (let i = 0; i < upisi.length; i++) {
    const ime = imena[i]!
    const v = upisi[i]![1] as string
    const r = radnja === 'upis'
      ? upisiTajnu(ime, v, { spremiste: ctx.spremiste, kljucOtiska: kljucPut })
      : ukloniTajnu(ime, { spremiste: ctx.spremiste, kljucOtiska: kljucPut })
    const rubniRazmak = radnja === 'upis' && /^\s|\s$/.test(v)
    upisi[i] = [ime, undefined]
    if (!r.ok) {
      audit(radnja, ime, 'odbijeno', { razlog: r.greska || 'spremiste_greska' })
      return odg(r.greska === 'spremiste_nije_sigurno' ? 409 : 500, { greska: r.greska || 'spremiste_greska', ...(skupno ? { ime, upisano: rezultati.map(x => x.ime) } : {}) })
    }
    audit(radnja, ime, 'ok', { otisakPrije: r.otisakPrije ?? null, otisak: r.otisak ?? null, zahtjevId: t.zahtjevId, potvrda: 'telegram' })
    dopisi(ctx.dogadajiPut, { kada: new Date(sat()).toISOString(), ime, radnja, otisak: r.otisak ?? null })
    const zasjenjena = !!env[ime]
    if (zasjenjena) upozorenja.push(`${ime}: vrijednost iz okoline procesa ima prednost — makni ${ime} iz okoline (postavke.env/systemd) i restartaj kad je mirno`)
    if (rubniRazmak) upozorenja.push(`${ime}: vrijednost ima razmak na rubu — upisana je točno tako (ne reže se)`)
    rezultati.push(radnja === 'upis'
      ? { ime, postoji: true, otisakPrije: r.otisakPrije ?? null, otisak: r.otisak ?? null, zasjenjena }
      : { ime, postoji: false, otisakPrije: r.otisakPrije ?? null })
  }
  t.vrijednost = undefined; t.vrijednosti = undefined
  if (skupno) return odg(200, { tajne: rezultati, upozorenja })
  return odg(200, radnja === 'upis' ? { ...rezultati[0], upozorenja } : rezultati[0])
}
