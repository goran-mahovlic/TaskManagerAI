// Logika rasporeda Config stranice (TASK-5169) — bez DOM-a, bez ovisnosti.
// Ista pravila vrijede u pregledniku (prototip, kasnije TaskWebUI) i na poslužitelju
// (PUT /api/config/raspored). Raspored NIKAD ne nosi vrijednosti postavki — samo
// redoslijed, širinu (stupci 1–4) i visinu (null = prirodna, inače px u koracima od 40).
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.CfgRasporedLogika = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const VERZIJA = 1
  const STUPACA = 4
  const VIS_MIN = 160
  const VIS_MAX = 1200
  const VIS_KORAK = 40
  const MAX_KARTICA = 64
  const MAX_BAJTOVA = 8192
  const ID_UZORAK = /^info-[a-z0-9-]{1,60}-card$/

  const stisni = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
  const zaokruziVisinu = px => stisni(Math.round(px / VIS_KORAK) * VIS_KORAK, VIS_MIN, VIS_MAX)

  /** Validacija tijela PUT-a. Strogo: nepoznat ključ ili kriva vrijednost = 400, ništa se ne upisuje. */
  function validiraj(ulaz) {
    const greska = error => ({ ok: false, error })
    if (!ulaz || typeof ulaz !== 'object' || Array.isArray(ulaz)) return greska('raspored mora biti objekt')
    let bajtova
    try { bajtova = new TextEncoder().encode(JSON.stringify(ulaz)).length } catch { return greska('raspored nije JSON') }
    if (bajtova > MAX_BAJTOVA) return greska(`raspored je veći od ${MAX_BAJTOVA} B`)
    const visak = Object.keys(ulaz).filter(k => !['v', 'redoslijed', 'kartice'].includes(k))
    if (visak.length) return greska(`nepoznato polje: ${visak.join(', ')} (raspored ne nosi vrijednosti postavki)`)
    if (ulaz.v !== VERZIJA) return greska(`v mora biti ${VERZIJA}`)
    if (!Array.isArray(ulaz.redoslijed)) return greska('redoslijed mora biti niz ID-jeva')
    if (ulaz.redoslijed.length > MAX_KARTICA) return greska(`najviše ${MAX_KARTICA} kartica`)
    const vidjeno = new Set()
    for (const id of ulaz.redoslijed) {
      if (typeof id !== 'string' || !ID_UZORAK.test(id)) return greska(`neispravan ID kartice: ${String(id).slice(0, 80)}`)
      if (vidjeno.has(id)) return greska(`ID se ponavlja: ${id}`)
      vidjeno.add(id)
    }
    const k = ulaz.kartice
    if (!k || typeof k !== 'object' || Array.isArray(k)) return greska('kartice mora biti objekt')
    const kartice = {}
    const ids = Object.keys(k)
    if (ids.length > MAX_KARTICA) return greska(`najviše ${MAX_KARTICA} kartica`)
    for (const id of ids) {
      if (!ID_UZORAK.test(id)) return greska(`neispravan ID kartice: ${id.slice(0, 80)}`)
      const m = k[id]
      if (!m || typeof m !== 'object' || Array.isArray(m)) return greska(`${id}: mjere moraju biti objekt`)
      const visakM = Object.keys(m).filter(x => x !== 'w' && x !== 'h')
      if (visakM.length) return greska(`${id}: nepoznato polje ${visakM.join(', ')}`)
      if (!Number.isInteger(m.w) || m.w < 1 || m.w > STUPACA) return greska(`${id}: w mora biti cijeli broj 1–${STUPACA}`)
      if (m.h !== null && (!Number.isInteger(m.h) || m.h < VIS_MIN || m.h > VIS_MAX || m.h % VIS_KORAK !== 0))
        return greska(`${id}: h mora biti null ili ${VIS_MIN}–${VIS_MAX} u koracima od ${VIS_KORAK}`)
      kartice[id] = { w: m.w, h: m.h }
    }
    return { ok: true, value: { v: VERZIJA, redoslijed: ulaz.redoslijed.slice(), kartice } }
  }

  /**
   * Redoslijed jedne skupine. `zadano` = ID-jevi kartica skupine kako stoje u HTML-u.
   * Kartice koje spremljeni raspored poznaje popunjavaju SVOJA mjesta spremljenim redom;
   * nepoznate (nova kartica nakon nadogradnje) ostaju na zadanom mjestu. Spremljeni ID
   * kojeg u HTML-u nema (druga inačica, uklonjena kartica) se preskače, ali se ne briše.
   */
  function poredajSkupinu(zadano, redoslijed) {
    const rang = new Map((redoslijed || []).map((id, i) => [id, i]))
    const poznate = zadano.filter(id => rang.has(id)).sort((a, b) => rang.get(a) - rang.get(b))
    let i = 0
    return zadano.map(id => (rang.has(id) ? poznate[i++] : id))
  }

  /** Mjere kartice: spremljene ako postoje, inače zadane (info-full = 4 stupca, ostale 2). */
  function mjere(id, raspored, puna) {
    const m = raspored && raspored.kartice && raspored.kartice[id]
    return m ? { w: m.w, h: m.h } : { w: puna ? STUPACA : 2, h: null }
  }

  /** Spoji spremljeni raspored s karticama na disku — ID-jevi koje ova stranica ne poznaje ostaju sačuvani. */
  function spoji(stari, novo) {
    const vidljivi = new Set(novo.redoslijed)
    const redoslijed = novo.redoslijed.concat(((stari && stari.redoslijed) || []).filter(id => !vidljivi.has(id)))
    const kartice = Object.assign({}, (stari && stari.kartice) || {}, novo.kartice)
    return { v: VERZIJA, redoslijed: redoslijed.slice(0, MAX_KARTICA), kartice }
  }

  /** Broj izmjena između dva rasporeda nad istim skupom kartica (za oznaku na gumbu). */
  function brojIzmjena(a, b) {
    let n = 0
    const ids = new Set([...Object.keys(a.kartice), ...Object.keys(b.kartice)])
    for (const id of ids) {
      const x = a.kartice[id] || {}, y = b.kartice[id] || {}
      if (x.w !== y.w) n++
      if (x.h !== y.h) n++
    }
    const pa = a.redoslijed.join('|'), pb = b.redoslijed.join('|')
    if (pa !== pb) {
      for (let i = 0; i < Math.max(a.redoslijed.length, b.redoslijed.length); i++) if (a.redoslijed[i] !== b.redoslijed[i]) n++
    }
    return n
  }

  return { VERZIJA, STUPACA, VIS_MIN, VIS_MAX, VIS_KORAK, MAX_BAJTOVA, ID_UZORAK,
    stisni, zaokruziVisinu, validiraj, poredajSkupinu, mjere, spoji, brojIzmjena }
})
