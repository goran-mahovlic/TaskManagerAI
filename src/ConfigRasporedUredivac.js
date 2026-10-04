// Uređivač rasporeda Config stranice (TASK-5170; dizajn i prototip TASK-5169, Grga:
// docs/DIZAJN-config-uredivac-rasporeda.md, docs/skice/config-raspored/uredivac.js).
// Poslužuje se kao /config-raspored.js IZA logike (window.CfgRasporedLogika iz core/ConfigRaspored.ts),
// zasebno od predloška HTML-a — predložak bi pojeo backslash i backtick (lekcija TASK-4633/TASK-4803).
// Pointer Events = jedan put za miš, dodir i olovku; isto u Geckou i Blinku. HTML5 DnD se NE koristi.
// Gumb uređuje SAMO raspored; vrijednosti postavki su u uređivanju `inert` (dizajn §6).
;(function () {
  'use strict'
  var L = window.CfgRasporedLogika
  var grid = document.getElementById('info-grid')
  var gumb = document.getElementById('cr-uredi')
  if (!L || !grid || !gumb) return
  var oznaka = gumb.querySelector('.cr-oznaka')
  var broj = gumb.querySelector('.cr-broj')
  var najava = document.getElementById('cr-najava')
  var mobitel = window.matchMedia('(max-width: 900px)')
  var SIRINA = { 1: '¼', 2: '½', 3: '¾', 4: '1/1' }
  var RUTA = '/api/config/raspored'

  function T(k, zad) { return typeof _T === 'function' ? _T(k, zad) : zad }
  function Tv(k, zad, v) { var s = T(k, zad); for (var kk in v) s = s.split('{' + kk + '}').join(v[kk]); return s }

  var stanje = { uredujem: false, sprema: false, pocetni: null, zadani: null, zadanoTrazeno: false, osnova: null, spremljen: null }
  var vuca = null

  function kartice() { return Array.prototype.slice.call(grid.querySelectorAll(':scope > .info-card')) }
  function skupinaOd(el) { var p = el; while (p && !(p.classList && p.classList.contains('info-skupina'))) p = p.previousElementSibling; return p }
  function karticeSkupine(sk) { return kartice().filter(function (c) { return skupinaOd(c) === sk }) }
  function naslov(c) {
    var t = c.querySelector('.info-card-title'); if (!t) return c.id
    var k = t.cloneNode(true)
    k.querySelectorAll('.icon, .cr-hvat, .cr-mjera').forEach(function (x) { x.remove() })
    return k.textContent.replace(/\s+/g, ' ').trim() || c.id
  }
  function izmjena(n) {
    var d = n % 10, s = n % 100
    if (n === 1) return Tv('cfg_raspored_izmjena_1', '{n} izmjena', { n: n })
    if (d >= 2 && d <= 4 && (s < 12 || s > 14)) return Tv('cfg_raspored_izmjena_2', '{n} izmjene', { n: n })
    return Tv('cfg_raspored_izmjena_5', '{n} izmjena', { n: n })
  }
  function visinaTekst(h) { return h ? Tv('cfg_raspored_visina_px', '{h} piksela', { h: h }) : T('cfg_raspored_visina_prirodna', 'prirodna') }
  function javi(t) { if (!najava) return; najava.textContent = ''; setTimeout(function () { najava.textContent = t }, 30) }
  function javiMjesto(c) {
    var red = karticeSkupine(skupinaOd(c)), m = mjereOd(c)
    javi(Tv('cfg_raspored_najava_kartica', '{naslov}: mjesto {i} od {n}, širina {w}, visina {h}',
      { naslov: naslov(c), i: red.indexOf(c) + 1, n: red.length, w: SIRINA[m.w], h: visinaTekst(m.h) }))
  }

  function postaviMjere(c, w, h) {
    c.dataset.crW = String(w); c.style.setProperty('--cr-w', String(w))
    if (h) { c.dataset.crH = String(h); c.style.setProperty('--cr-h', h + 'px') }
    else { delete c.dataset.crH; c.style.removeProperty('--cr-h') }
    var m = c.querySelector('.cr-mjera'); if (m) m.textContent = SIRINA[w] + ' · ' + (h ? h + ' px' : 'auto')
  }
  function mjereOd(c) { return { w: Number(c.dataset.crW), h: c.dataset.crH ? Number(c.dataset.crH) : null } }

  /** Raspored kakav je SADA u DOM-u (redoslijed = DOM, mjere = data-atributi). */
  function trenutni() {
    var r = { v: L.VERZIJA, redoslijed: [], kartice: {} }
    kartice().forEach(function (c) { r.redoslijed.push(c.id); r.kartice[c.id] = mjereOd(c) })
    return r
  }

  /** Primjena: kartice se fizički premještaju (tab-redoslijed i čitač ekrana prate sliku — nema CSS `order`). */
  function primijeni(r) {
    grid.querySelectorAll(':scope > .info-skupina').forEach(function (sk) {
      var red = L.poredajSkupinu(stanje.zadani.skupine[sk.id] || [], r ? r.redoslijed : [])
      var sidro = sk
      red.forEach(function (id) { var c = document.getElementById(id); if (c) { sidro.after(c); sidro = c } })
    })
    kartice().forEach(function (c) { var m = L.mjere(c.id, r, c.classList.contains('info-full')); postaviMjere(c, m.w, m.h) })
    osvjeziBroj()
  }

  function ukrasi() {
    kartice().forEach(function (c) {
      var t = c.querySelector('.info-card-title'); if (!t || t.querySelector('.cr-hvat')) return
      var h = document.createElement('button')
      h.type = 'button'; h.className = 'cr-hvat'; h.textContent = '⠿'; h.tabIndex = -1
      t.insertBefore(h, t.firstChild)
      var m = document.createElement('span'); m.className = 'cr-mjera'; t.appendChild(m)
      // Kut ide PRVI: postojeće `.info-card > div:last-child { overflow-x: auto }` mora i dalje
      // pogađati sadržaj, inače široka tablica raširi stranicu (izmjereno 683 px na 390).
      var k = document.createElement('div'); k.className = 'cr-kut'; k.setAttribute('aria-hidden', 'true'); c.insertBefore(k, c.firstChild)
    })
  }

  // Sadržaj kartice je u uređivanju `inert`: nijedan klizač, prekidač ni „Spremi" vrijednosti
  // ne može se dirnuti — raspored fizički ne može promijeniti postavku.
  function zakljucaj(da) {
    kartice().forEach(function (c) {
      Array.prototype.forEach.call(c.children, function (d) {
        if (d.classList.contains('info-card-title') || d.classList.contains('cr-kut')) return
        if (da) d.setAttribute('inert', ''); else d.removeAttribute('inert')
      })
      if (da) { c.tabIndex = 0; c.setAttribute('aria-roledescription', T('cfg_raspored_pomicna', 'pomična kartica')) }
      else { c.removeAttribute('tabindex'); c.removeAttribute('aria-roledescription') }
    })
  }

  function postaviGumb() {
    oznaka.textContent = stanje.sprema ? T('cfg_raspored_spremam', '… Spremam')
      : stanje.uredujem ? T('cfg_raspored_spremi', '💾 Spremi raspored') : T('cfg_raspored_uredi', '✎ Uredi raspored')
    gumb.setAttribute('aria-pressed', stanje.uredujem ? 'true' : 'false')
    gumb.setAttribute('aria-busy', stanje.sprema ? 'true' : 'false')
    gumb.title = stanje.uredujem ? T('cfg_raspored_spremi_naslov', 'Spremi raspored i izađi iz uređivanja')
      : T('cfg_raspored_uredi_naslov', 'Uredi raspored okvira (vrijednosti se ne mijenjaju)')
  }

  /** Natpisi koje sastavlja JS (aria-label nema data-i18n) — i nakon promjene jezika. */
  function jezik() {
    postaviGumb()
    var a = { 'cr-sazmi': ['cfg_raspored_sazmi_aria', 'Sažmi kartice na naslove'], 'cr-zadano': ['cfg_raspored_zadano_aria', 'Vrati zadani raspored'],
      'cr-odustani': ['cfg_raspored_odustani_aria', 'Odustani od izmjena rasporeda'] }
    Object.keys(a).forEach(function (id) { var b = document.getElementById(id); if (b) b.setAttribute('aria-label', T(a[id][0], a[id][1])) })
    kartice().forEach(function (c) { var h = c.querySelector('.cr-hvat'); if (h) h.setAttribute('aria-label', Tv('cfg_raspored_premjesti', 'Premjesti: {naslov}', { naslov: naslov(c) })) })
  }

  function osvjeziBroj() {
    if (!stanje.uredujem) { gumb.dataset.izmjena = '0'; return }
    var sad = trenutni(), n = L.brojIzmjena(stanje.pocetni, sad)
    gumb.dataset.izmjena = String(n); broj.textContent = String(n)
    kartice().forEach(function (c, i) {
      var a = stanje.pocetni.kartice[c.id] || {}, b = sad.kartice[c.id]
      c.classList.toggle('cr-promijenjena', a.w !== b.w || a.h !== b.h || stanje.pocetni.redoslijed[i] !== c.id)
    })
  }

  function udi() {
    stanje.uredujem = true; stanje.zadanoTrazeno = false; stanje.pocetni = trenutni()
    document.body.classList.add('cr-uredivanje')
    postaviSazeto(mobitel.matches)
    zakljucaj(true); postaviGumb(); osvjeziBroj()
    javi(T('cfg_raspored_najava_ulaz', 'Uređivanje rasporeda. Strelice premještaju karticu, Shift i strelice mijenjaju veličinu, Escape odustaje.'))
  }
  function izadi() {
    stanje.uredujem = false
    document.body.classList.remove('cr-uredivanje'); postaviSazeto(false)
    kartice().forEach(function (c) { c.classList.remove('cr-promijenjena') })
    zakljucaj(false); postaviGumb(); osvjeziBroj()
  }

  function posalji(tijelo) {
    tijelo.osnova = stanje.osnova; tijelo.by = 'ploca'; tijelo.source = 'config-raspored'
    return fetch(RUTA, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tijelo) })
      .then(function (r) {
        return r.json().catch(function () { return {} }).then(function (b) {
          if (r.status === 409) throw new Error(T('cfg_raspored_409', 'Raspored je u međuvremenu promijenjen na drugom uređaju — Odustani pa uredi ponovo.'))
          if (!r.ok) throw new Error(b.error || ('HTTP ' + r.status))
          return b
        })
      })
  }

  function spremi() {
    var nacrt = trenutni(), n = L.brojIzmjena(stanje.pocetni, nacrt)
    // Spremanje bez izmjena NE šalje zahtjev — audit se ne zatrpava praznim retcima.
    if (n === 0 && !stanje.zadanoTrazeno) { izadi(); poruka(T('cfg_raspored_bez_izmjena', 'Raspored nije mijenjan — ništa nije zapisano.')); return }
    var naZadano = stanje.zadanoTrazeno && L.brojIzmjena(stanje.zadani.raspored, nacrt) === 0
    var provjera = naZadano ? { ok: true } : L.validiraj(nacrt)
    if (!provjera.ok) { poruka(Tv('cfg_raspored_nije_spremljen', 'Raspored NIJE spremljen: {greska} — i dalje uređuješ.', { greska: provjera.error }), true); return }
    stanje.sprema = true; postaviGumb()
    posalji(naZadano ? { zadano: true } : { raspored: nacrt }).then(function (b) {
      stanje.sprema = false; stanje.osnova = b.osnova === undefined ? null : b.osnova; stanje.spremljen = b.raspored || null
      izadi()
      poruka(naZadano ? T('cfg_raspored_zadano_spremljen', 'Vraćen zadani raspored.')
        : Tv('cfg_raspored_spremljen', 'Raspored spremljen ({izmjena}).', { izmjena: izmjena(n) }))
    }, function (e) {
      stanje.sprema = false; postaviGumb()
      poruka(Tv('cfg_raspored_nije_spremljen', 'Raspored NIJE spremljen: {greska} — i dalje uređuješ.', { greska: e.message }), true)
    })
  }

  function odustani() {
    var nacrt = trenutni(), n = L.brojIzmjena(stanje.pocetni, nacrt)
    primijeni(stanje.pocetni); izadi()
    if (n > 0) poruka(Tv('cfg_raspored_ponisteno', 'Poništeno: {izmjena}.', { izmjena: izmjena(n) }), false,
      T('cfg_raspored_vrati', 'Vrati'), function () { udi(); primijeni(nacrt) })
  }

  function postaviSazeto(da) {
    document.body.classList.toggle('cr-sazeto', da)
    var b = document.getElementById('cr-sazmi'); if (b) b.setAttribute('aria-pressed', da ? 'true' : 'false')
  }

  var porukaRok = null
  function poruka(tekst, greska, gumbTekst, akcija) {
    var p = document.getElementById('cr-poruka'), g = document.getElementById('cr-poruka-gumb')
    document.getElementById('cr-poruka-tekst').textContent = tekst
    p.classList.toggle('greska', !!greska); p.classList.add('vidljiva')
    g.hidden = !gumbTekst; g.textContent = gumbTekst || ''
    g.onclick = function () { p.classList.remove('vidljiva'); if (akcija) akcija() }
    clearTimeout(porukaRok); porukaRok = setTimeout(function () { p.classList.remove('vidljiva') }, greska ? 9000 : 6000)
  }

  // ── Vučenje i promjena veličine ──────────────────────────────────────────────
  grid.addEventListener('pointerdown', function (e) {
    if (!stanje.uredujem) return
    var hvat = e.target.closest('.cr-hvat'), kut = e.target.closest('.cr-kut')
    if (!hvat && !kut) return
    // Zaglavljeno vučenje (pointerup se izgubio izvan prozora) se otkazuje, ne blokira novo.
    if (vuca) zavrsi(true)
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    var c = e.target.closest('.info-card'), r = c.getBoundingClientRect()
    try { e.target.setPointerCapture(e.pointerId) } catch (x) { /* sintetički događaj */ }
    if (hvat) {
      var mjesto = document.createElement('div')
      mjesto.className = 'cr-mjesto'; mjesto.style.setProperty('--cr-w', c.dataset.crW); mjesto.style.height = r.height + 'px'
      grid.insertBefore(mjesto, c)
      c.classList.add('cr-vucem')
      c.style.left = r.left + 'px'; c.style.top = r.top + 'px'; c.style.width = r.width + 'px'; c.style.height = r.height + 'px'
      vuca = { tip: 'vuci', c: c, mjesto: mjesto, dx: e.clientX - r.left, dy: e.clientY - r.top, sk: skupinaOd(c), x: e.clientX, y: e.clientY, id: e.pointerId }
      document.body.classList.add('cr-vuce'); requestAnimationFrame(autoskrol)
    } else {
      var gs = getComputedStyle(grid), stupci = gs.gridTemplateColumns.split(' ').length, gap = parseFloat(gs.columnGap) || 0
      vuca = { tip: 'mijenjaj', c: c, r: r, x0: e.clientX, y0: e.clientY, stupci: stupci, gap: gap, id: e.pointerId,
        colW: (grid.clientWidth - gap * (stupci - 1)) / stupci, w0: Number(c.dataset.crW), h0: c.dataset.crH ? Number(c.dataset.crH) : null }
      c.classList.add('cr-mijenjam')
    }
  })

  document.addEventListener('pointermove', function (e) {
    if (!vuca || e.pointerId !== vuca.id) return
    e.preventDefault()
    if (vuca.tip === 'vuci') { vuca.x = e.clientX; vuca.y = e.clientY; pomakni() } else mijenjaj(e.clientX, e.clientY)
  }, { passive: false })
  document.addEventListener('pointerup', function (e) { if (vuca && e.pointerId === vuca.id) zavrsi(false) })
  document.addEventListener('pointercancel', function (e) { if (vuca && e.pointerId === vuca.id) zavrsi(true) })
  // Prozor je izgubio fokus usred vučenja (Alt+Tab, obavijest): vučenje se otkazuje, kartica se vraća.
  window.addEventListener('blur', function () { if (vuca) zavrsi(true) })

  function pomakni() {
    var c = vuca.c
    c.style.left = (vuca.x - vuca.dx) + 'px'; c.style.top = (vuca.y - vuca.dy) + 'px'
    var pod = document.elementFromPoint(vuca.x, vuca.y)
    var cilj = pod && pod.closest('#info-grid > .info-card')
    // Samo unutar svoje skupine: navigacija 01–05 i naslovi skupina ostaju istiniti.
    if (!cilj || cilj === c || skupinaOd(cilj) !== vuca.sk) return
    var rr = cilj.getBoundingClientRect()
    var prije = (vuca.x - rr.left) / rr.width + (vuca.y - rr.top) / rr.height < 1
    if (prije) { if (vuca.mjesto.nextElementSibling !== cilj) grid.insertBefore(vuca.mjesto, cilj) }
    else if (cilj.nextElementSibling !== vuca.mjesto) grid.insertBefore(vuca.mjesto, cilj.nextElementSibling)
  }

  function autoskrol() {
    if (!vuca || vuca.tip !== 'vuci') return
    var rub = 80, v = 0
    if (vuca.y < rub) v = -Math.ceil((rub - vuca.y) / 4)
    else if (vuca.y > innerHeight - rub) v = Math.ceil((vuca.y - (innerHeight - rub)) / 4)
    if (v) { window.scrollBy(0, v); pomakni() }
    requestAnimationFrame(autoskrol)
  }

  function mijenjaj(x, y) {
    var c = vuca.c, dx = x - vuca.x0, dy = y - vuca.y0, m = mjereOd(c), w = m.w, h = m.h
    if (vuca.stupci > 1 && Math.abs(dx) > 8)
      w = L.stisni(Math.round((vuca.r.width + dx + vuca.gap) / (vuca.colW + vuca.gap)), 1, L.STUPACA)
    // U sažetom prikazu visina se ne vidi, pa se ni ne mijenja; prag 8 px štiti od drhtaja prsta.
    if (!document.body.classList.contains('cr-sazeto') && Math.abs(dy) > 8) h = L.zaokruziVisinu(vuca.r.height + dy)
    if (w !== m.w || h !== m.h) { postaviMjere(c, w, h); osvjeziBroj() }
  }

  function zavrsi(otkazano) {
    var v = vuca; vuca = null
    if (v.tip === 'vuci') {
      if (!otkazano) grid.insertBefore(v.c, v.mjesto)
      v.mjesto.remove()
      v.c.classList.remove('cr-vucem')
      v.c.style.left = v.c.style.top = v.c.style.width = v.c.style.height = ''
      document.body.classList.remove('cr-vuce')
    } else {
      v.c.classList.remove('cr-mijenjam')
      if (otkazano) postaviMjere(v.c, v.w0, v.h0)
    }
    javiMjesto(v.c)
    osvjeziBroj()
  }

  grid.addEventListener('dblclick', function (e) {
    if (!stanje.uredujem || !e.target.closest('.cr-kut')) return
    var c = e.target.closest('.info-card'); postaviMjere(c, mjereOd(c).w, null); osvjeziBroj()
  })

  // ── Tipkovnica: isti posao bez miša i prsta ─────────────────────────────────
  grid.addEventListener('keydown', function (e) {
    if (!stanje.uredujem) return
    var c = e.target.closest && e.target.closest('#info-grid > .info-card')
    if (!c || e.target !== c) return
    var m = mjereOd(c), red = karticeSkupine(skupinaOd(c)), i = red.indexOf(c), k = e.key
    if (e.shiftKey && (k === 'ArrowLeft' || k === 'ArrowRight')) postaviMjere(c, L.stisni(m.w + (k === 'ArrowRight' ? 1 : -1), 1, L.STUPACA), m.h)
    else if (e.shiftKey && (k === 'ArrowUp' || k === 'ArrowDown')) postaviMjere(c, m.w, L.zaokruziVisinu((m.h || c.getBoundingClientRect().height) + (k === 'ArrowDown' ? 40 : -40)))
    else if (k === 'a' || k === 'A') postaviMjere(c, m.w, null)
    else if ((k === 'ArrowUp' || k === 'ArrowLeft') && i > 0) red[i - 1].before(c)
    else if ((k === 'ArrowDown' || k === 'ArrowRight') && i < red.length - 1) red[i + 1].after(c)
    else return
    e.preventDefault(); c.focus(); osvjeziBroj(); javiMjesto(c)
  })

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !stanje.uredujem) return
    var tab = document.getElementById('tab-info')
    if (tab && !tab.classList.contains('active')) return
    e.preventDefault()
    if (vuca) zavrsi(true); else odustani()
  })

  // ── JEDAN gumb ───────────────────────────────────────────────────────────────
  gumb.addEventListener('click', function () {
    if (stanje.sprema) return
    if (stanje.uredujem) spremi(); else udi()
  })
  document.getElementById('cr-odustani').addEventListener('click', odustani)
  document.getElementById('cr-zadano').addEventListener('click', function () {
    primijeni(stanje.zadani.raspored); stanje.zadanoTrazeno = true
    javi(T('cfg_raspored_najava_zadano', 'Zadani raspored primijenjen. Spremi ga ili odustani.'))
  })
  document.getElementById('cr-sazmi').addEventListener('click', function () { postaviSazeto(!document.body.classList.contains('cr-sazeto')) })
  window.addEventListener('beforeunload', function (e) {
    if (stanje.uredujem && gumb.dataset.izmjena !== '0') { e.preventDefault(); e.returnValue = '' }
  })

  /** WS `raspored_changed` s drugog uređaja: primijeni, ali NE usred uređivanja (tamo čeka 409). */
  function izvana(d) {
    if (stanje.uredujem || !d) return
    stanje.osnova = d.osnova === undefined ? null : d.osnova
    stanje.spremljen = d.raspored && L.validiraj(d.raspored).ok ? d.raspored : null
    primijeni(stanje.spremljen)
  }

  // ── Pokretanje: zadani raspored se uzima iz HTML-a PRIJE primjene spremljenog ──
  ukrasi()
  kartice().forEach(function (c) { postaviMjere(c, c.classList.contains('info-full') ? L.STUPACA : 2, null) })
  stanje.zadani = { raspored: trenutni(), skupine: {} }
  grid.querySelectorAll(':scope > .info-skupina').forEach(function (sk) { stanje.zadani.skupine[sk.id] = karticeSkupine(sk).map(function (c) { return c.id }) })
  jezik()
  // Mreža čeka spremljeni raspored najviše 300 ms (visibility), da kartice ne skaču.
  grid.classList.add('cr-ceka')
  var pustiMrezu = setTimeout(function () { grid.classList.remove('cr-ceka') }, 300)
  fetch(RUTA).then(function (r) { return r.ok ? r.json() : null }).then(function (b) {
    if (!b) return
    stanje.osnova = b.osnova === undefined ? null : b.osnova
    if (b.raspored && L.validiraj(b.raspored).ok) { stanje.spremljen = b.raspored; if (!stanje.uredujem) primijeni(b.raspored) }
    else if (b.invalid) console.warn('[raspored] spremljeni raspored odbačen, crta se zadani:', b.invalid)
  }).catch(function (e) { console.warn('[raspored] dohvat nije uspio, crta se zadani:', e) })
    .then(function () { clearTimeout(pustiMrezu); grid.classList.remove('cr-ceka') })

  window.CfgRaspored = { stanje: stanje, trenutni: trenutni, primijeni: primijeni, udi: udi, spremi: spremi, odustani: odustani, izvana: izvana, jezik: jezik }
})()
