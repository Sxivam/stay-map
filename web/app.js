/* Stay Map: every stay in a place on one map, with direct contacts. Data: web/data/<place>.json (see pipeline/build.py). */
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const FILM = params.has('film');
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ACCENT = '#ff9d6c';
  const KIND = { hostel: 'Hostel', guesthouse: 'Guesthouse', hotel: 'Hotel', resort: 'Resort', villa: 'Villa / apartment', camp: 'Camp' };
  const PAGE = 30;

  // Small DOM builder. All place data is untrusted text, so it only ever goes in through textContent.
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v; else if (k.startsWith('on')) e[k] = v; else e.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid);
    return e;
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: carry on without saving */ } },
  };
  const fmt = (n) => Math.round(n).toLocaleString('en-IN');
  const dist = (m) => (m < 950 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(m < 9500 ? 1 : 0)} km`);
  const nice = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  let map, place, stays = [], byId = new Map(), matched = [], shown = 0, selected = null, is3d = true, tourTimer = null, railLock = 0;
  let saved = new Set(), hasKind = new Set();
  const f = { kinds: new Set(), beach: 0, phone: false, site: false, saved: false };   // chips
  let parsed = { kinds: new Set(), beach: 0, phone: false, site: false, words: [] };  // from the sentence box
  const trip = Object.assign({ in: defaultDate(0), out: defaultDate(4), n: 4 }, store.get('staymap-trip', {}));

  function defaultDate(plus) { // next 29 December, the New Year rush
    const now = new Date(), y = now.getMonth() === 11 && now.getDate() > 29 ? now.getFullYear() + 1 : now.getFullYear();
    const d = new Date(Date.UTC(y, 11, 29 + plus));
    return d.toISOString().slice(0, 10);
  }

  // ---------- the sentence box: plain keyword reading, no AI call ----------
  const KIND_WORDS = [[/\bhostels?\b|\bdorms?\b|\bbackpackers?\b/, 'hostel'], [/\bguest ?houses?\b|\bhome ?stays?\b|\bbnb\b|\bb&b\b/, 'guesthouse'],
    [/\bhotels?\b/, 'hotel'], [/\bresorts?\b/, 'resort'], [/\bvillas?\b|\bapartments?\b|\bflats?\b|\bcottages?\b/, 'villa'], [/\bcamp(ing|s|site)?\b|\btents?\b/, 'camp']];
  const STOP = new Set('a an the in at on of for to with and or near by from me us we i my our want need looking find show stay stays place places room rooms people person night nights that has have is are good best cheap under around area beach walk walking distance close'.split(' '));
  function parse(q) {
    let s = ' ' + q.toLowerCase().replace(/[.,!?]/g, ' ') + ' ';
    const out = { kinds: new Set(), beach: 0, phone: false, site: false, words: [] };
    // A type word only filters if this place has stays of that type; otherwise it stays a plain search word ("resort" in a name).
    for (const [re, k] of KIND_WORDS) if (hasKind.has(k) && re.test(s)) { out.kinds.add(k); s = s.replace(new RegExp(re.source, 'g'), ' '); }
    const m = s.match(/(\d+(?:\.\d+)?)\s*(km|kms|m|metres?|meters?|min|mins|minutes?)\b/);
    if (m && place.beaches) { const n = parseFloat(m[1]); out.beach = /^km/.test(m[2]) ? n * 1000 : /^min/.test(m[2]) ? n * 80 : n; s = s.replace(m[0], ' '); }
    else if (/beach ?front|on the beach|sea ?(view|front|facing)/.test(s)) { out.beach = 300; s = s.replace(/beach ?front|on the beach|sea ?(view|front|facing)/g, ' '); }
    else if (/(near|close to|walk(ing)?( distance)? to|by) (the )?(beach|sea)/.test(s)) out.beach = 1000;
    if (/\b(phone|whatsapp|call|number|contact|direct)\b/.test(s)) { out.phone = true; s = s.replace(/\b(phone|whatsapp|call|number|contact|direct)\b/g, ' '); }
    if (/\b(website|site|online)\b/.test(s)) { out.site = true; s = s.replace(/\b(website|site|online)\b/g, ' '); }
    out.words = s.split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));
    return out;
  }

  // ---------- filtering ----------
  function isMatch(s) {
    const kinds = f.kinds.size ? f.kinds : parsed.kinds;
    if (kinds.size && !kinds.has(s.k)) return false;
    const beach = f.beach || parsed.beach;
    if (beach && !(s.bd != null && s.bd <= beach)) return false;
    if ((f.phone || parsed.phone) && !s.p) return false;
    if ((f.site || parsed.site) && !s.w) return false;
    if (f.saved && !saved.has(s.id)) return false;
    for (const w of parsed.words) if (!s.hay.includes(w)) return false;
    return true;
  }
  function apply({ fit = true } = {}) {
    stopTour();
    matched = stays.filter(isMatch);
    matched.sort((a, b) => (b.p || b.w ? 1 : 0) - (a.p || a.w ? 1 : 0) || (a.bd ?? 1e9) - (b.bd ?? 1e9));
    const on = new Set(matched.map((s) => s.id));
    if (map?.getSource('stays')) for (const s of stays) map.setFeatureState({ source: 'stays', id: s.id }, { m: on.has(s.id) });
    countTo(matched.length);
    $('count-label').textContent = (matched.length === stays.length ? `stays in ${place.name}` : `of ${fmt(stays.length)} stays match`);
    renderChips();
    renderRail();
    $('empty').hidden = matched.length > 0;
    if (fit && map && matched.length && matched.length < stays.length) fitTo(matched);
  }
  let countNow = 0, countRaf = 0;
  function countTo(to) {
    cancelAnimationFrame(countRaf);
    const from = countNow, t0 = performance.now(), ms = calm ? 1 : 700;
    (function step(t) {
      const p = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - p, 3);
      countNow = from + (to - from) * e; $('count').textContent = fmt(countNow);
      if (p < 1) countRaf = requestAnimationFrame(step);
    })(t0);
  }

  // ---------- chips ----------
  function renderChips() {
    const counts = {}; for (const s of stays) counts[s.k] = (counts[s.k] || 0) + 1;
    const kinds = f.kinds.size ? f.kinds : parsed.kinds, beach = f.beach || parsed.beach;
    const chip = (label, on, fn, n, cls) => h('button', { class: 'chip' + (on ? ' on' : '') + (cls ? ' ' + cls : ''), 'aria-pressed': String(!!on), onclick: fn }, label, n != null ? h('small', {}, fmt(n)) : null);
    const list = [];
    if (saved.size) list.push(chip('♥ Saved', f.saved, () => { f.saved = !f.saved; apply(); }, saved.size));
    if (f.saved && saved.size) list.push(chip('Share list', false, share));
    for (const k of Object.keys(KIND)) if (counts[k]) list.push(chip(KIND[k], kinds.has(k), () => { f.kinds = new Set(kinds); f.kinds.has(k) ? f.kinds.delete(k) : f.kinds.add(k); parsed.kinds = new Set(); apply(); }, counts[k]));
    if (place.beaches) {
      list.push(chip('Sea within 300 m', beach && beach <= 300, () => { f.beach = beach && beach <= 300 ? 0 : 300; parsed.beach = 0; apply(); }, null, 'sep'));
      list.push(chip('Within 1 km', beach > 300 && beach <= 1000, () => { f.beach = beach > 300 && beach <= 1000 ? 0 : 1000; parsed.beach = 0; apply(); }));
    }
    list.push(chip('Has phone', f.phone || parsed.phone, () => { f.phone = !(f.phone || parsed.phone); parsed.phone = false; apply({ fit: false }); }, place.phones, 'sep'));
    list.push(chip('Has website', f.site || parsed.site, () => { f.site = !(f.site || parsed.site); parsed.site = false; apply({ fit: false }); }, place.sites));
    $('chips').replaceChildren(...list);
  }

  // ---------- cards ----------
  const waOk = (p) => !p.startsWith('+91') || /^\+91[6-9]\d{9}$/.test(p); // Indian landlines are not on WhatsApp
  function message(s) {
    return `Hi! Is ${s.n} available from ${nice(trip.in)} to ${nice(trip.out)} for ${trip.n} ${trip.n === 1 ? 'person' : 'people'}? What would the total price be?`;
  }
  function card(s, i) {
    const where = s.t || s.a || '';
    const maps = /^https:\/\/(www\.)?google\.[a-z.]+\/maps/.test(s.gu || '') ? s.gu : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(`${s.n} ${where} ${place.name}`);
    const web = /^https?:\/\//i.test(s.w || '') ? s.w : null;
    const osm = s.src === 'google' ? maps : `https://www.openstreetmap.org/${{ n: 'node', w: 'way', r: 'relation' }[s.id[0]]}/${s.id.slice(1)}`;
    const acts = [];
    if (s.p && waOk(s.p)) acts.push(h('a', { class: 'btn wa', target: '_blank', rel: 'noopener', href: `https://wa.me/${s.p.replace(/\D/g, '')}?text=${encodeURIComponent(message(s))}` }, 'WhatsApp'));
    if (s.p) acts.push(h('a', { class: 'btn', href: 'tel:' + s.p }, 'Call'));
    if (web) acts.push(h('a', { class: 'btn', target: '_blank', rel: 'noopener', href: web }, 'Website'));
    acts.push(h('a', { class: 'btn' + (s.p ? '' : ' main'), target: '_blank', rel: 'noopener', href: maps }, 'Photos & prices'));
    const isSaved = saved.has(s.id);
    acts.push(h('button', { class: 'btn save' + (isSaved ? ' on' : ''), 'aria-label': isSaved ? 'Remove from saved' : 'Save', 'aria-pressed': String(isSaved),
      onclick: (ev) => { toggleSave(s.id); ev.currentTarget.classList.toggle('on', saved.has(s.id)); ev.currentTarget.textContent = saved.has(s.id) ? '♥' : '♡'; } }, isSaved ? '♥' : '♡'));
    const bits = [];
    if (s.bd != null) bits.push(`${dist(s.bd)} to ${s.bn || 'the sea'}`);
    if (s.g) bits.push(`${s.g.toFixed(1)}★ (${fmt(s.gn || 0)})`);
    if (s.st) bits.push(`${s.st} star`);
    if (s.r) bits.push(`${s.r} rooms`);
    if (s.wifi) bits.push('wifi');
    if (s.pool) bits.push('pool');
    return h('article', { class: 'card' + (s.id === selected ? ' sel' : ''), 'data-id': s.id, style: `--i:${i % PAGE}`, onclick: (ev) => { if (!ev.target.closest('a,button')) select(s.id, { fly: true }); } },
      h('div', { class: 'k' }, h('span', {}, h('b', {}, KIND[s.k].split(' ')[0]), where ? ' · ' + where : ''), h('span', {}, s.p ? 'Direct contact' : web ? 'Has website' : '')),
      h('h3', {}, s.n),
      h('div', { class: 'meta' }, bits.join(' · ') || h('i', {}, 'No extra details on record')),
      h('div', { class: 'acts' }, acts),
      h('div', { class: 'foot' }, h('span', {}, s.p ? s.p + ({ web: ' · from its website', google: ' · from Google Maps' }[s.ps] || '') : 'No public number on record'), h('a', { href: osm, target: '_blank', rel: 'noopener' }, 'Source · fix this')));
  }
  function renderRail(first) {
    const rail = $('rail');
    let list = matched;
    if (first) list = [first, ...matched.filter((s) => s !== first)];
    rail._list = list; shown = 0; rail.replaceChildren(); rail.scrollLeft = 0;
    more();
  }
  function more() {
    const rail = $('rail'), list = rail._list || [];
    rail.querySelector('.more')?.remove();
    const next = list.slice(shown, shown + PAGE);
    rail.append(...next.map((s, i) => card(s, shown + i)));
    shown += next.length;
    if (shown < list.length) rail.append(h('button', { class: 'more', onclick: more }, `Show more (${fmt(list.length - shown)} left)`));
  }
  function toggleSave(id) {
    saved.has(id) ? saved.delete(id) : saved.add(id);
    store.set('staymap-saved-' + place.slug, [...saved]);
    if (!saved.size) f.saved = false;
    renderChips();
  }
  async function share() {
    const url = `${location.origin}${location.pathname}?place=${place.slug}#s=${[...saved].join('.')}`;
    const text = `My ${place.name} shortlist (${saved.size} stays)`;
    try { if (navigator.share) { await navigator.share({ title: text, url }); return; } await navigator.clipboard.writeText(url); toast('Link copied. Send it to your group.'); }
    catch (e) { if (e.name !== 'AbortError') prompt('Copy this link', url); }
  }
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2400); }

  // ---------- selection and camera ----------
  function pad() {
    const top = $('top').getBoundingClientRect(), rail = $('rail').getBoundingClientRect(), wide = innerWidth >= 760;
    if (document.body.classList.contains('bare')) return { top: 40, bottom: 40, left: 40, right: 40 };
    return { top: wide ? 40 : top.bottom + 10, bottom: rail.height + 10, left: wide ? top.right + 20 : 30, right: wide ? 80 : 30 };
  }
  function select(id, { fly = false, scroll = true } = {}) {
    if (selected) map.setFeatureState({ source: 'stays', id: selected }, { sel: false });
    selected = id;
    if (!id) return;
    const s = byId.get(id);
    map.setFeatureState({ source: 'stays', id }, { sel: true });
    if (scroll) {
      let el = $('rail').querySelector(`[data-id="${id}"]`);
      if (!el) { renderRail(s); el = $('rail').querySelector(`[data-id="${id}"]`); }
      railLock = performance.now() + 900;
      el.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', inline: 'center', block: 'nearest' });
    }
    for (const c of $('rail').querySelectorAll('.card')) c.classList.toggle('sel', c.dataset.id === id);
    if (fly) map.flyTo({ center: s.ll, zoom: Math.max(map.getZoom(), 15.2), pitch: is3d ? 55 : 0, padding: pad(), duration: calm ? 0 : 1800, essential: true });
  }
  // Camera for a box of coordinates, worked out by hand: the library's own bounds helper gives up on a far-away
  // globe and double-counts padding once padding has been set.
  function camFor([w, s, e, n], duration, maxZoom = 22) {
    const p = pad(), lat = (s + n) / 2;
    const W = Math.max(160, innerWidth - p.left - p.right), H = Math.max(160, innerHeight - p.top - p.bottom);
    const zx = Math.log2((W * 360) / (512 * Math.max(0.002, e - w))), zy = Math.log2((H * 360 * Math.cos((lat * Math.PI) / 180)) / (512 * Math.max(0.002, n - s)));
    return { center: [(w + e) / 2, lat], zoom: Math.min(zx, zy, maxZoom + 0.4) - 0.4, pitch: is3d ? 45 : 0, bearing: 0, padding: p, duration: calm ? 0 : duration, essential: true };
  }
  function fitTo(list) {
    const xs = list.map((s) => s.ll[0]), ys = list.map((s) => s.ll[1]);
    map.flyTo(camFor([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], 1600, 15));
  }
  const overview = (duration = 2000) => camFor(place.bbox, duration);
  function intro() {
    stopTour(); select(null);
    document.body.classList.add('loading');
    const done = () => { document.body.classList.remove('loading'); if (FILM) setTimeout(tour, 1200); };
    if (calm || params.has('nointro')) { map.jumpTo(overview(0)); return done(); }
    map.jumpTo({ center: [place.center[0], place.center[1] - 8], zoom: 1.6, pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
    let gone = false; // start the dive once the globe's imagery is in, or after 3 s on a slow connection
    const go = () => { if (gone) return; gone = true; setTimeout(() => { map.flyTo({ ...overview(4200), curve: 1.5 }); map.once('moveend', done); }, 600); };
    map.once('idle', go); setTimeout(go, 3000);
  }
  function tour() { // filming: glide through the first few matches
    let i = 0; const list = matched.filter((s) => s.p || s.w).slice(0, 8);
    (function next() {
      if (i >= list.length) { map.flyTo(overview(3500)); return; }
      select(list[i++].id, { fly: true });
      tourTimer = setTimeout(next, 4800);
    })();
  }
  function stopTour() { clearTimeout(tourTimer); tourTimer = null; }

  // ---------- map ----------
  function createMap() {
    map = new maplibregl.Map({
      container: 'map', center: place.center, zoom: 8, maxPitch: 70, attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false,
      style: {
        version: 8, projection: { type: 'globe' }, glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
        sky: { 'sky-color': '#05070b', 'horizon-color': '#231510', 'fog-color': '#05070b', 'sky-horizon-blend': 0.7, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.2,
          'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 9, 0] },
        sources: {
          sat: { type: 'raster', tileSize: 256, maxzoom: 18, tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'] },
          omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#06080c' } },
          { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-brightness-max': 0.34, 'raster-saturation': -0.6, 'raster-contrast': 0.2 } },
          { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': '#071523', 'fill-opacity': 0.72 } },
          { id: 'roads', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary']]],
            paint: { 'line-color': '#ffc7a3', 'line-opacity': 0.16, 'line-blur': 1, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.4, 16, 2.4] } },
          { id: 'buildings', type: 'fill-extrusion', source: 'omt', 'source-layer': 'building', minzoom: 14,
            paint: { 'fill-extrusion-color': '#1a1c22', 'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6], 'fill-extrusion-opacity': 0.8 } },
          { id: 'towns', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 8.5, filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village', 'suburb']]],
            layout: { 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': ['Noto Sans Bold'], 'text-transform': 'uppercase', 'text-letter-spacing': 0.14,
              'text-size': ['match', ['get', 'class'], ['city', 'town'], 12.5, 10] },
            paint: { 'text-color': '#a9a39a', 'text-halo-color': 'rgba(0,0,0,.8)', 'text-halo-width': 1.2 } },
        ],
      },
    });
    map.touchZoomRotate.disableRotation();
  }
  function addStays() {
    const m = ['boolean', ['feature-state', 'm'], true], sel = ['boolean', ['feature-state', 'sel'], false];
    map.addSource('stays', { type: 'geojson', promoteId: 'id',
      data: { type: 'FeatureCollection', features: stays.map((s) => ({ type: 'Feature', properties: { id: s.id, n: s.n, c: s.p || s.w ? 1 : 0 }, geometry: { type: 'Point', coordinates: s.ll } })) } });
    map.addLayer({ id: 'glow', type: 'circle', source: 'stays', paint: { 'circle-color': ACCENT, 'circle-blur': 1,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 3, 11, 9, 15, 26], 'circle-opacity': ['interpolate', ['linear'], ['zoom'], 9, ['case', m, 0.12, 0], 13, ['case', m, ['case', ['==', ['get', 'c'], 1], 0.5, 0.26], 0]] } });
    map.addLayer({ id: 'dots', type: 'circle', source: 'stays', paint: {
      'circle-color': ['case', sel, '#ffffff', m, ACCENT, '#3a3d45'], 'circle-opacity': ['case', m, 1, 0.45],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, ['case', sel, 4, 1.1], 11, ['case', sel, 7, 2.6], 15, ['case', sel, 11, 6]],
      'circle-stroke-width': ['case', sel, 3, 0], 'circle-stroke-color': 'rgba(255,255,255,.35)' } });
    map.addLayer({ id: 'names', type: 'symbol', source: 'stays', minzoom: 13.6,
      layout: { 'text-field': ['get', 'n'], 'text-font': ['Noto Sans Regular'], 'text-size': 11.5, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true, 'text-max-width': 9 },
      paint: { 'text-color': '#f4efe8', 'text-halo-color': 'rgba(0,0,0,.85)', 'text-halo-width': 1.4, 'text-opacity': ['case', m, 1, 0] } });
    if (!calm) setInterval(() => { // slow breathing glow: one paint property, cheap
      const k = 1 + 0.3 * Math.sin(performance.now() / 520);
      map.setPaintProperty('glow', 'circle-radius', ['interpolate', ['linear'], ['zoom'], 7, 3 * k, 11, 9 * k, 15, 26 * k]);
    }, 90);
    map.on('click', (e) => {
      const hit = map.queryRenderedFeatures([[e.point.x - 9, e.point.y - 9], [e.point.x + 9, e.point.y + 9]], { layers: ['dots'] })
        .find((ft) => ft.state.m !== false);
      if (hit) { stopTour(); select(hit.properties.id, { fly: true }); }
    });
    map.on('mousemove', (e) => { map.getCanvas().style.cursor = map.queryRenderedFeatures(e.point, { layers: ['dots'] }).length ? 'pointer' : ''; });
  }

  // ---------- wiring ----------
  function wire() {
    let t;
    $('q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { parsed = parse($('q').value); apply(); }, 280); });
    $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
    $('reset').onclick = () => { $('q').value = ''; parsed = parse(''); f.kinds.clear(); f.beach = 0; f.phone = f.site = f.saved = false; apply({ fit: false }); map.flyTo(overview()); };
    const tripLabel = () => { $('trip-btn').textContent = `${nice(trip.in)} → ${nice(trip.out)} · ${trip.n} ${trip.n === 1 ? 'person' : 'people'}`; };
    $('t-in').value = trip.in; $('t-out').value = trip.out; $('t-n').value = trip.n; tripLabel();
    $('trip-btn').onclick = () => { const open = $('trip-edit').hidden; $('trip-edit').hidden = !open; $('trip-btn').setAttribute('aria-expanded', String(open)); };
    $('trip-edit').addEventListener('input', () => {
      if ($('t-in').value) trip.in = $('t-in').value;
      if ($('t-out').value) trip.out = $('t-out').value;
      trip.n = Math.max(1, Math.min(40, parseInt($('t-n').value, 10) || 1));
      store.set('staymap-trip', trip); tripLabel(); renderRail(selected ? byId.get(selected) : null);
    });
    $('trip-edit').addEventListener('submit', (e) => e.preventDefault());
    $('c-home').onclick = () => { stopTour(); select(null); map.flyTo(overview()); };
    $('c-tilt').onclick = () => { is3d = !is3d; $('c-tilt').textContent = is3d ? '3D' : '2D'; map.easeTo({ pitch: is3d ? 50 : 0, duration: 700 }); };
    $('c-replay').onclick = intro;
    const bare = () => document.body.classList.toggle('bare');
    $('c-hide').onclick = bare;
    addEventListener('keydown', (e) => {
      if (e.target.matches('input,select,textarea') || e.metaKey || e.ctrlKey) return;
      if (e.key === 'h') bare(); else if (e.key === 'r') intro(); else if (e.key === 't') tour(); else if (e.key === 'Escape') document.body.classList.remove('bare');
    });
    // Swiping the cards moves the map: the card nearest the middle becomes the selected stay.
    let settle;
    $('rail').addEventListener('scroll', () => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        const rail = $('rail');
        if (rail.scrollLeft + rail.clientWidth > rail.scrollWidth - 200 && rail.querySelector('.more')) more();
        if (performance.now() < railLock || rail.scrollLeft < 8) return;
        const mid = rail.getBoundingClientRect().left + rail.clientWidth / 2;
        let best = null, gap = 1e9;
        for (const c of rail.querySelectorAll('.card')) { const r = c.getBoundingClientRect(), g = Math.abs(r.left + r.width / 2 - mid); if (g < gap) { gap = g; best = c; } }
        if (best && best.dataset.id !== selected) { stopTour(); select(best.dataset.id, { fly: true, scroll: false }); }
      }, 160);
    }, { passive: true });
  }

  async function start() {
    const places = await fetch('data/places.json', { cache: 'no-store' }).then((r) => r.json());
    const slug = places.find((p) => p.slug === params.get('place'))?.slug || places[0].slug;
    const data = await fetch(`data/${slug}.json`, { cache: 'no-store' }).then((r) => r.json());
    place = data.place; stays = data.stays;
    hasKind = new Set(stays.map((s) => s.k));
    for (const s of stays) { s.hay = [s.n, s.a, s.t, s.bn, s.ad, KIND[s.k]].filter(Boolean).join(' ').toLowerCase(); byId.set(s.id, s); }
    document.title = `Every stay in ${place.name}, on one map`;
    saved = new Set(store.get('staymap-saved-' + slug, []).filter((id) => byId.has(id)));
    const shared = (location.hash.match(/s=([\w.]+)/) || [])[1];
    if (shared) { for (const id of shared.split('.')) if (byId.has(id)) saved.add(id); f.saved = saved.size > 0; }
    if (places.length > 1) {
      const sel = $('place'); sel.hidden = false;
      sel.append(...places.map((p) => h('option', { value: p.slug, selected: p.slug === slug ? '' : null }, p.name)));
      sel.onchange = () => { location.search = '?place=' + sel.value; };
    }
    $('credit').append('© ', h('a', { href: 'https://www.openstreetmap.org/copyright', target: '_blank', rel: 'noopener' }, 'OpenStreetMap'), ` · Esri · OpenFreeMap · checked ${nice(place.built)}`);
    if (FILM) document.body.classList.add('bare');
    createMap(); wire();
    const shot = (params.get('shot') || '').split(',').map(Number);
    if (params.get('q')) { $('q').value = params.get('q'); parsed = parse(params.get('q')); }
    map.on('load', () => {
      addStays(); apply({ fit: false });
      if (shot.length >= 3 && shot.every(Number.isFinite)) { map.jumpTo({ center: [shot[0], shot[1]], zoom: shot[2], pitch: shot[3] || 0 }); document.body.classList.remove('loading'); if (params.get('sel')) select(params.get('sel'), { scroll: !FILM }); }
      else { intro(); if (params.get('q') && matched.length) setTimeout(() => fitTo(matched), 300); }
    });
  }
  start().catch((e) => { document.body.classList.remove('loading'); $('empty').hidden = false; $('empty').textContent = 'Could not load the map data. Run the pipeline first (see README).'; console.error(e); });
})();
