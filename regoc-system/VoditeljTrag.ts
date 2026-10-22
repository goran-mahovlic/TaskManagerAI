// ─── Voditelj lanca V3: trag i poruke (ADR-0024 §O5–O7, TASK-5678) ───────────
// Što voditelj ostavlja iza sebe: presude po članu (i u sjeni), jedna bilješka (progressNotes) po
// promjeni, najviše jedna poruka u grupu lanca po buđenju (samo kad se otisak promijenio ili je nešto
// napravljeno), jedna najava u sjeni, dnevni sažetak u 08:00 samo ako se u 24 h nešto dogodilo, i
// kartica za ploču. Čista logika + čitanje stanja; slanje (tg_send.py) i ploču ubrizgava daemon.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import * as V from './VoditeljLanca'

// ─── Kanal ──────────────────────────────────────────────────────────────────

/** `chat:<id>` s voditelja (grupa lanca); null = voditelj nema grupu → ne šalje se ništa. */
export function chatVoditelja(tags: string[] | null | undefined): number | null {
  const t = (tags || []).map(String).find(x => /^chat:-?\d+$/.test(x))
  return t ? Number(t.slice('chat:'.length)) : null
}

/** Dodatna polja u stanju voditelja (datoteka `<TASK>.json`); stare datoteke ih nemaju. */
export interface StanjeTraga {
  /** Kad je poslana najava sjene (jednom po voditelju). */
  najavaSjene?: string | null
  /** Otisak uz koji je poslana zadnja poruka buđenja (dedup O6). */
  porukaOtisak?: string | null
  /** Zadnja bilješka na voditelju (isti tekst se ne ponavlja). */
  zadnjaBiljeska?: string | null
  /** Lokalni dan kad je dnevni sažetak obrađen (poslan ili preskočen jer nije bilo ničega). */
  sazetakDan?: string | null
}

// ─── Presude (sjena i pogon) ────────────────────────────────────────────────

export type VrstaPresude = 'lazni-pad' | 'stvarni-pad' | 'nespojena-grana' | 'zaglavljen' | 'goran-spreman' | 'goran-ceka-granu' | 'ceka-gorana'
export interface Presuda { taskId: string; k: string; vrsta: VrstaPresude; tekst: string }

/**
 * O5: samo-Goranov posao je spreman kad su prethodnici completed I nijedna grana lanca nije izvan main
 * (K7 je push paketa — gura sve isporuke lanca, pa ne smije krenuti dok je i jedna grana nespojena).
 */
export function goranSpreman(c: V.Clan, clanovi: V.Clan[], otisak: V.Otisak): 'spreman' | 'ceka-granu' | 'ne' {
  if (!V.prethodniciGotovi(c, clanovi)) return 'ne'
  return otisak.nespojene.length ? 'ceka-granu' : 'spreman'
}

const kratko = (x: unknown, n: number) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

/** Što voditelj misli o svakom članu kojem nešto treba — isti sud u sjeni i u pogonu. */
export function presudeLanca(clanovi: V.Clan[], otisak: V.Otisak): Presuda[] {
  const out: Presuda[] = []
  for (const c of clanovi) {
    const k = V.kOznaka(c)
    if (V.samoGoran(c)) {
      if (c.status === 'completed' || c.status === 'cancelled') continue
      const sp = goranSpreman(c, clanovi, otisak)
      if (sp === 'spreman') out.push({ taskId: c.id, k, vrsta: 'goran-spreman', tekst: `${k} ${c.id}: spreman za Gorana (prethodnici gotovi, grane u main) — jedna obavijest` })
      if (sp === 'ceka-granu') out.push({ taskId: c.id, k, vrsta: 'goran-ceka-granu', tekst: `${k} ${c.id}: Goranov, prethodnici gotovi, čeka spajanje ${otisak.nespojene.map(g => g.grana).join(', ')}` })
      continue
    }
    if (c.status === 'blocked') {
      if ((c.tags || []).includes('needs-decision')) { out.push({ taskId: c.id, k, vrsta: 'ceka-gorana', tekst: `${k} ${c.id}: čeka Goranovu odluku (needs-decision)` }); continue }
      const pad = V.razvrstajPad(c.blockedReason)
      if (!pad) continue
      out.push(pad.vrsta === 'lazni'
        ? { taskId: c.id, k, vrsta: 'lazni-pad', tekst: `${k} ${c.id}: lažni pad (${pad.potpis}, adresat ${pad.adresat}) — ${pad.uzrok}` }
        : { taskId: c.id, k, vrsta: 'stvarni-pad', tekst: `${k} ${c.id}: stvarni pad (${pad.potpis}) — ${kratko(pad.uzrok, 120)}` })
    }
  }
  for (const id of otisak.zaglavljeni) {
    const c = clanovi.find(x => x.id === id)
    out.push({ taskId: id, k: c ? V.kOznaka(c) : id, vrsta: 'zaglavljen', tekst: `${c ? V.kOznaka(c) : id} ${id}: in_progress bez živog najma` })
  }
  for (const g of otisak.nespojene) {
    const c = clanovi.find(x => x.id === g.taskId)
    out.push({ taskId: g.taskId, k: c ? V.kOznaka(c) : g.taskId, vrsta: 'nespojena-grana', tekst: `${c ? V.kOznaka(c) : g.taskId} ${g.taskId}: nespojena grana ${g.grana} (completed, nije u main)` })
  }
  return out
}

// ─── Bilješka (progressNotes) ───────────────────────────────────────────────

export function biljeskaSjene(presude: Presuda[], plan: string): string {
  const p = presude.length ? presude.map(x => x.tekst).join('; ') : 'nema presuda'
  return kratko(`👁️ voditelj (sjena): ${p} · bi napravio: ${plan}`, 1200)
}

// ─── Poruka buđenja (O6: najviše jedna, samo kad ima promjene) ──────────────

export function odluciPorukuBudjenja(s: StanjeTraga, u: { nacin: V.NacinVoditelja; otisak: string; izvedenih: number }): { salji: boolean; razlog: string } {
  if (u.nacin !== 'on') return { salji: false, razlog: 'sjena: u grupu ide samo najava' }
  if (u.izvedenih > 0) return { salji: true, razlog: `${u.izvedenih} radnji` }
  if (u.otisak !== (s.porukaOtisak ?? null)) return { salji: true, razlog: 'otisak promijenjen' }
  return { salji: false, razlog: 'otisak isti kao u zadnjoj poruci, bez radnji' }
}

export function tekstPorukeBudjenja(u: { voditeljId: string; lanac: string; presude: Presuda[]; radnje: string[]; obavijesti: string[] }): string {
  const red = [`🧭 Voditelj lanca ${u.lanac} (${u.voditeljId})`]
  for (const o of u.obavijesti) red.push(`🔔 ${kratko(o, 400)}`)
  if (u.radnje.length) red.push(`Napravljeno: ${u.radnje.join('; ')}`)
  if (u.presude.length) red.push(...u.presude.slice(0, 8).map(p => `• ${p.tekst}`))
  else red.push('Lanac bez otvorenih nalaza.')
  const s = red.join('\n')
  return s.length > 1400 ? s.slice(0, 1397) + '…' : s
}

// ─── Najava sjene (jedina poruka u grupu dok je voditelj u sjeni) ───────────

export const trebaNajavu = (s: StanjeTraga, nacin: V.NacinVoditelja): boolean => nacin === 'shadow' && !s.najavaSjene

export function tekstNajave(u: { voditeljId: string; lanac: string; presude: Presuda[] }): string {
  const t = [`👁️ Voditelj lanca ${u.lanac} (${u.voditeljId}) radi u SJENI (ADR-0024): prati lanac, sudi i bilježi u dnevnik, ali ništa ne mijenja i ne šalje druge poruke u ovu grupu do prelaska na „on”.`]
  if (u.presude.length) t.push('Prvi pogled:', ...u.presude.slice(0, 6).map(p => `• ${p.tekst}`))
  const s = t.join('\n')
  return s.length > 1400 ? s.slice(0, 1397) + '…' : s
}

// ─── Dnevni sažetak 08:00 (samo ako se u 24 h nešto dogodilo) ──────────────

const SAZETAK_OD_SATA = 8
const SAZETAK_DO_SATA = 10 // prozor 08:00–09:59: daemon ugašen u osam ne šalje sažetak u podne

/** Događaj = promjena otiska ili izvedena radnja. Periodičko buđenje bez promjene nije događaj. */
export function dogadjaji24h(dnevnik: Record<string, any>[], now: number): Record<string, any>[] {
  return dnevnik.filter(z => {
    const t = Date.parse(String(z.ts || ''))
    if (!Number.isFinite(t) || t < now - 24 * 3600_000) return false
    return z.promjena === true || (Array.isArray(z.izvedene) && z.izvedene.length > 0)
  })
}

export function odluciSazetak(s: StanjeTraga, u: { nacin: V.NacinVoditelja; now: number; dnevnik: Record<string, any>[] }): { obradi: boolean; salji: boolean; razlog: string; dogadjaja: number } {
  const sat = new Date(u.now).getHours()
  const dan = V.danKljuc(u.now)
  if (sat < SAZETAK_OD_SATA || sat >= SAZETAK_DO_SATA || s.sazetakDan === dan) return { obradi: false, salji: false, razlog: 'nije vrijeme', dogadjaja: 0 }
  const n = dogadjaji24h(u.dnevnik, u.now).length
  if (!n) return { obradi: true, salji: false, razlog: 'u 24 h se ništa nije dogodilo', dogadjaja: 0 }
  if (u.nacin !== 'on') return { obradi: true, salji: false, razlog: `sjena: sažetak (${n} događaja) samo u dnevnik`, dogadjaja: n }
  return { obradi: true, salji: true, razlog: `${n} događaja u 24 h`, dogadjaja: n }
}

export function tekstSazetka(u: { voditeljId: string; lanac: string; dogadjaja: number; presude: Presuda[]; potrosnja: { budjenja: number; usd: number } }): string {
  const t = [`🌅 Voditelj lanca ${u.lanac} (${u.voditeljId}) — 24 h: ${u.dogadjaja} događaja, ${u.potrosnja.budjenja} buđenja, $${u.potrosnja.usd.toFixed(2)}.`]
  t.push(...(u.presude.length ? u.presude.slice(0, 8).map(p => `• ${p.tekst}`) : ['Lanac bez otvorenih nalaza.']))
  const s = t.join('\n')
  return s.length > 1400 ? s.slice(0, 1397) + '…' : s
}

// ─── Kartica na ploči ───────────────────────────────────────────────────────

export function citajDnevnik(voditeljId: string, dir = V.mapaVoditelja(), n = 200): Record<string, any>[] {
  try {
    return readFileSync(V.putDnevnika(voditeljId, dir), 'utf8').trim().split('\n').filter(Boolean).slice(-n)
      .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) as Record<string, any>[]
  } catch { return [] }
}

export interface Kartica {
  voditeljId: string
  lanac: string
  nacin: V.NacinVoditelja
  otisak: string | null
  zadnjeBudjenje: string | null
  sljedeceBudjenje: string | null
  potrosnja: { budjenja: number; usd: number; maxBudjenja: number; maxUsd: number }
  otvorenaPitanja: { kljuc: string; taskId: string }[]
  presude: Presuda[]
  zadnjiZapis: string | null
  najavaSjene: string | null
  dnevnik: { ts: string; opis: string }[]
}

function opisZapisa(z: Record<string, any>): string {
  if (z.kraj) return `kraj buđenja: ${(z.izvedene || []).length} radnji${z.biljeska ? ` — ${kratko(z.biljeska, 120)}` : ''}`
  if (z.budjenje) return `buđenje (${z.kod}): ${kratko(z.razlog, 140)}`
  if (z.sjena) return `sjena (${z.kod || '—'}): ${kratko(z.razlog, 140)}`
  if (z.poruka) return `poruka u grupu (${z.poruka}): ${z.ok ? 'poslana' : 'nije poslana'}`
  if (z.sazetak) return `dnevni sažetak: ${kratko(z.razlog, 120)}`
  return kratko(JSON.stringify(z), 160)
}

/** Kartica voditelja za ploču; null = nema datoteke stanja (zadatak nije voditelj ili još nije prošao tick). */
export function citajKarticu(voditeljId: string, o: { dir?: string; nacin: V.NacinVoditelja; now: number; postavke?: V.PostavkeVoditelja }): Kartica | null {
  const dir = o.dir || V.mapaVoditelja()
  const s = V.citajStanje(voditeljId, dir)
  if (!s || s === 'pokvaren') return null
  const p = o.postavke || V.citajPostavke()
  const st = s as V.StanjeVoditelja & StanjeTraga & { zadnjiZapis?: string | null }
  const danas = st.potrosnja?.dan === V.danKljuc(o.now)
  const dn = citajDnevnik(voditeljId, dir)
  const sPresudama = [...dn].reverse().find(z => Array.isArray(z.presude))
  return {
    voditeljId, lanac: st.lanac, nacin: o.nacin, otisak: st.otisak,
    zadnjeBudjenje: st.zadnjeBudjenje, sljedeceBudjenje: st.sljedeceBudjenje,
    potrosnja: { budjenja: danas ? st.potrosnja.budjenja : 0, usd: danas ? st.potrosnja.usd : 0, maxBudjenja: p.maxBudjenjaDan, maxUsd: p.maxUsdDan },
    otvorenaPitanja: Object.entries(st.otvorenaPitanja || {}).map(([kljuc, taskId]) => ({ kljuc, taskId })),
    presude: (sPresudama?.presude || []) as Presuda[],
    zadnjiZapis: st.zadnjiZapis ?? null,
    najavaSjene: st.najavaSjene ?? null,
    dnevnik: dn.slice(-8).reverse().map(z => ({ ts: String(z.ts || ''), opis: opisZapisa(z) })),
  }
}

/** Način iz features.json (ploča nema daemonov getFlag). */
export function nacinIzFeatures(put = join(process.env.HOME || homedir(), '.claude', 'regoc', 'features.json')): V.NacinVoditelja {
  try { return existsSync(put) ? V.citajNacin(JSON.parse(readFileSync(put, 'utf8'))?.voditeljLanca) : 'off' } catch { return 'off' }
}
