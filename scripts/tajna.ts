#!/usr/bin/env bun
/**
 * tajna — upis tajni čvora sa samog stroja (ADR-0007 §8.4, §9). Bootstrap prije nego što
 * Telegram radi, i put kad ploča nije dostupna. Isti pisač i ista brava kao ploča.
 *
 *   bun scripts/tajna.ts postavi IME            # vrijednost iz TTY-a bez ispisa ili iz stdin cijevi
 *   bun scripts/tajna.ts obrisi IME
 *   bun scripts/tajna.ts popis                  # ime, postoji/ne, otisak — nikad vrijednost
 *   bun scripts/tajna.ts podesi --potvrda-uid <uid> [--dopusti-lan-http da|ne] [--dodatno IME_TOKEN]
 *
 * Vrijednost u argv se ODBIJA (izlaz 2): bila bi vidljiva u `ps`, /proc/<pid>/cmdline i
 * povijesti ljuske. Izlaz: 0 uspjeh, 1 greška spremišta, 2 pogrešna uporaba.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { appendFileSync, chmodSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import {
  imeZabranjeno, IME_RE, kljucOtiskaUz, otisak, parsirajRedak, postaviTajnu, provjeriVrijednost, ukloniTajnu,
} from '../src/LoginCreds'
import { datotekaTajniZaPisanje } from '../src/core/ConfigModul'
import { konfigPutanjaZaPisanje, osigurajMapu, stanjePutanja } from '../src/core/paths'
import { ucitajPostavkeTajni } from '../src/TajnePloca'

const UPORABA = 'uporaba: tajna postavi IME | obrisi IME | popis | podesi --potvrda-uid <uid> [--dopusti-lan-http da|ne] [--dodatno IME]'
const van = (kod: number, poruka: string): never => { (kod ? console.error : console.log)(poruka); process.exit(kod) }

function audit(radnja: string, ime: string, ishod: string, dodatno: object = {}): void {
  const put = stanjePutanja('tajne_audit.jsonl')
  try {
    mkdirSync(dirname(put), { recursive: true, mode: 0o700 })
    appendFileSync(put, JSON.stringify({ kada: new Date().toISOString(), radnja, ime, ishod, ip: null, prijenos: 'cli', ...dodatno }) + '\n', { mode: 0o600 })
    chmodSync(put, 0o600)
  } catch {}
}

async function procitajVrijednost(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write('vrijednost (ne ispisuje se): ')
    process.stdin.setRawMode(true)
    process.stdin.resume()
    return new Promise(res => {
      let v = ''
      process.stdin.on('data', (b: Buffer) => {
        for (const ch of b.toString('utf-8')) {
          if (ch === '\r' || ch === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n'); res(v); return }
          if (ch === '\u0003') { process.stdin.setRawMode(false); process.stderr.write('\n'); process.exit(130) }
          if (ch === '\u007f') v = v.slice(0, -1)
          else v += ch
        }
      })
    })
  }
  const sve = await Bun.stdin.text()
  return sve.replace(/\r?\n$/, '') // jedan završni prijelaz retka iz `echo`/`printf '%s\n'`
}

const [radnja, ...ost] = process.argv.slice(2)
const spremiste = datotekaTajniZaPisanje()

if (radnja === 'postavi' || radnja === 'obrisi') {
  const ime = ost[0] || ''
  if (ost.length > 1) van(2, 'vrijednost se NE predaje kao argument (vidi se u ps i povijesti ljuske) — upiši je na upit ili kroz stdin cijev')
  if (!IME_RE.test(ime) || imeZabranjeno(ime)) van(2, `ime nije dopušteno: ${IME_RE.test(ime) ? ime : '(neispravno)'}`)
  if (radnja === 'obrisi') {
    const r = ukloniTajnu(ime, { spremiste })
    if (!r.ok) { audit('brisanje', ime, 'odbijeno', { razlog: r.greska }); van(1, `nije obrisano: ${r.greska}`) }
    audit('brisanje', ime, 'ok', { otisakPrije: r.otisakPrije ?? null })
    van(0, r.uklonjen ? `${ime} obrisana` : `${ime} nije ni postojala`)
  }
  const v = await procitajVrijednost()
  const g = provjeriVrijednost(v)
  if (g) van(2, `vrijednost odbijena: ${g}`)
  const r = postaviTajnu(ime, v, { spremiste })
  if (!r.ok) { audit('upis', ime, 'odbijeno', { razlog: r.greska }); van(1, `nije upisano: ${r.greska}`) }
  audit('upis', ime, 'ok', { otisakPrije: r.otisakPrije ?? null, otisak: r.otisak ?? null })
  van(0, `${ime} upisana · otisak ${r.otisak}${r.otisakPrije ? ` (prije ${r.otisakPrije})` : ''}${process.env[ime] ? ' · UPOZORENJE: okolina procesa ima isto ime i ima prednost' : ''}`)
} else if (radnja === 'popis') {
  const kljuc = kljucOtiskaUz(spremiste)
  const tekst = existsSync(spremiste) ? readFileSync(spremiste, 'utf-8') : ''
  const vidjeno = new Map<string, string>()
  for (const red of tekst.split('\n')) { const p = parsirajRedak(red); if (p) vidjeno.set(p.ime, p.vrijednost) }
  console.log(`spremište: ${spremiste}`)
  for (const [ime, v] of vidjeno) console.log(`${ime.padEnd(32)} ${v ? 'postoji' : 'prazno '}  ${v ? otisak(v, kljuc) : ''}`)
  const p = ucitajPostavkeTajni()
  console.log(`potvrda s ploče: ${p.potvrdaUid.length ? `${p.potvrdaUid.length} primatelj(a)` : 'NIJE podešena (upis s ploče isključen)'} · LAN HTTP: ${p.dopustiLanHttp ? 'dopušten' : 'ne'}`)
  process.exit(0)
} else if (radnja === 'podesi') {
  const put = konfigPutanjaZaPisanje('tajne.json', 'TM_TAJNE_POSTAVKE')
  let j: any = {}
  try { if (existsSync(put)) j = JSON.parse(readFileSync(put, 'utf-8')) } catch {}
  for (let i = 0; i < ost.length; i += 2) {
    const k = ost[i], v = ost[i + 1] ?? ''
    if (k === '--potvrda-uid') {
      const uidovi = v.split(',').map(s => s.trim()).filter(Boolean)
      if (!uidovi.length || !uidovi.every(u => /^\d{1,20}$/.test(u))) van(2, 'potvrda-uid mora biti brojčani Telegram uid (više njih odvoji zarezom)')
      j.potvrdaUid = uidovi
    } else if (k === '--dopusti-lan-http') {
      if (v !== 'da' && v !== 'ne') van(2, '--dopusti-lan-http da|ne')
      j.dopustiLanHttp = v === 'da'
    } else if (k === '--dodatno') {
      if (!/^[A-Z][A-Z0-9_]{1,63}_(PASSWORD|PASS|TOKEN|SECRET|KEY|API_KEY)$/.test(v) || imeZabranjeno(v)) van(2, 'dodatno ime mora završavati s _PASSWORD/_PASS/_TOKEN/_SECRET/_KEY/_API_KEY')
      j.dodatnaImena = [...new Set([...(Array.isArray(j.dodatnaImena) ? j.dodatnaImena : []), v])]
    } else van(2, UPORABA)
  }
  writeFileSync(osigurajMapu(put), JSON.stringify(j, null, 2) + '\n')
  van(0, `zapisano: ${put}`)
} else van(2, UPORABA)
