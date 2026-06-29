<script>
  import { onMount, onDestroy } from 'svelte';
  import { loader } from '$lib/mapLoader.js';
  import { PUBLIC_GOOGLE_MAP_ID, PUBLIC_GOOGLE_MAPS_API_KEY } from '$env/static/public';
  import { theme } from '$lib/theme.svelte.js';
  import { sidebar } from '$lib/sidebarState.svelte.js';

  // ── Parámetros ────────────────────────────────────────────────────────────
  let consumptionPer100km = $state(10);
  let fuelPriceCLP        = $state(1200);
  let kmPerLitre = $derived(consumptionPer100km > 0 ? 100 / consumptionPer100km : 0);

  // ── Formulario nuevo viaje ────────────────────────────────────────────────
  let originInput      = $state('');
  let destinationInput = $state('');
  let loading   = $state(false);
  let formError = $state('');

  // ── Editar viaje ──────────────────────────────────────────────────────────
  let editingId   = $state(null);
  let editOrigin  = $state('');
  let editDest    = $state('');
  let editLoading = $state(false);
  let editError   = $state('');

  // ── Lugares guardados (persistidos en localStorage) ───────────────────────
  const PLACES_KEY = 'dr-saved-places';
  let savedPlaces     = $state([]); // { id, label, address }
  let newPlaceLabel   = $state('');
  let newPlaceAddress = $state('');
  let showPlaceForm   = $state(false);

  // ── Viajes ────────────────────────────────────────────────────────────────
  // Each trip: { id, origin, destination, distanceKm, durationText,
  //              encodedPolyline, path, polyline, color,
  //              timeline: { points[], totalDurationS } }
  let trips = $state([]);

  let tripsWithCost = $derived(
    trips.map((t) => {
      const litres = kmPerLitre > 0 ? t.distanceKm / kmPerLitre : 0;
      return { ...t, litres, cost: litres * fuelPriceCLP };
    })
  );

  let totalDistanceKm = $derived(trips.reduce((s, t) => s + t.distanceKm, 0));
  let totalLitres     = $derived(kmPerLitre > 0 ? totalDistanceKm / kmPerLitre : 0);
  let totalCost       = $derived(totalLitres * fuelPriceCLP);

  // ── PDF ───────────────────────────────────────────────────────────────────
  let pdfLoading = $state(false);

  // ── Visualización ─────────────────────────────────────────────────────────
  // 'idle' | 'playing' | 'paused' | 'done'
  let vizState    = $state('idle');
  let vizSpeedMult = $state(60);
  const SPEED_OPTS = [10, 30, 60, 120];

  // Live HUD stats
  let vizSpeed    = $state(0);
  let vizDistKm   = $state(0);
  let vizLitres   = $state(0);
  let vizCost     = $state(0);
  let vizProgress = $state(0);
  let vizTripLabel = $state('');

  let showHud = $derived(vizState === 'playing' || vizState === 'paused' || vizState === 'done');
  let vizFuelPct = $derived(totalLitres > 0 ? (vizLitres / totalLitres) * 100 : 0);
  let vizDistPct = $derived(vizProgress * 100);

  // ── Mobile bottom sheet ───────────────────────────────────────────────────
  // 'hidden' (just handle) | 'compact' (form or summary card) | 'full'
  let sheetState = $state('compact');

  // Drag bookkeeping
  let sheetEl;
  let dragHeight = $state(null);
  let dragStartY = 0;
  let dragStartH = 0;

  function onHandlePointerDown(e) {
    if (typeof window === 'undefined' || window.innerWidth > 768) return;
    dragStartY = e.clientY;
    dragStartH = sheetEl?.getBoundingClientRect().height ?? 0;
    dragHeight = dragStartH;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onHandlePointerMove(e) {
    if (dragHeight === null) return;
    const delta = dragStartY - e.clientY;
    const max   = window.innerHeight * 0.92;
    dragHeight  = Math.max(0, Math.min(max, dragStartH + delta));
  }

  function onHandlePointerUp(e) {
    if (dragHeight === null) return;
    const vh = window.innerHeight;
    const h  = dragHeight;
    dragHeight = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);

    if (h < 80)             sheetState = 'hidden';
    else if (h < vh * 0.45) sheetState = 'compact';
    else                    sheetState = 'full';
  }

  // Snap to compact (summary card) whenever a trip gets added.
  $effect(() => {
    if (trips.length > 0) sheetState = 'compact';
  });

  // Internal animation bookkeeping (plain vars — not reactive)
  let vizSimTime     = 0;
  let vizTripIdx     = 0;
  let vizLastTs      = null;
  let vizRaf         = null;
  let vizTravPts     = [];
  let vizTravIdx     = 0;

  // Map viz objects
  let vizParticle    = null;
  let vizTravLine    = null;

  // ── Mapa ──────────────────────────────────────────────────────────────────
  let container;
  let map = $state(null);
  let MapClass     = null;
  let activeScheme = null;

  const COLORS = ['#4f46e5','#059669','#d97706','#dc2626','#7c3aed','#0891b2','#db2777','#92400e'];

  onMount(async () => {
    loadPlaces();
    const { Map } = await loader.importLibrary('maps');
    MapClass = Map;
    buildMap({ lat: -36.8197, lng: -73.0521 }, 12);

    const s = document.createElement('style');
    s.dataset.owner = 'daily-route-viz';
    s.textContent = `
      .dr-particle {
        width: 22px; height: 22px;
        background: #fff; border-radius: 50%;
        border: 3px solid currentColor;
        box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 35%, transparent),
                    0 0 18px color-mix(in srgb, currentColor 50%, transparent);
        animation: dr-pulse 1.4s ease-in-out infinite;
        pointer-events: none;
      }
      @keyframes dr-pulse {
        0%,100% { transform: scale(1); }
        50%      { transform: scale(1.25); }
      }
    `;
    document.head.appendChild(s);
  });

  onDestroy(() => {
    stopVizAnim();
    document.querySelector('style[data-owner="daily-route-viz"]')?.remove();
  });

  // `colorScheme` is immutable in the Maps JS API, so we tear the map down
  // and rebuild it on theme change, then redraw trip polylines and the
  // viz particle/trail at their current positions.
  $effect(() => {
    const scheme = theme.isDark ? 'DARK' : 'LIGHT';
    if (!MapClass || activeScheme === scheme) return;
    const c = map?.getCenter()?.toJSON() ?? { lat: -36.8197, lng: -73.0521 };
    const z = map?.getZoom() ?? 12;
    const wasPlaying = vizState === 'playing';
    if (wasPlaying) stopVizAnim();
    buildMap(c, z);
    (async () => {
      await redrawTrips();
      if (vizState !== 'idle') await redrawVizObjects();
      if (wasPlaying) {
        vizState = 'paused';
        playViz();
      }
    })();
  });

  function buildMap(c, z) {
    const scheme = theme.isDark ? 'DARK' : 'LIGHT';
    activeScheme = scheme;
    if (container) container.innerHTML = '';
    // Overlay references attached to the old map are now orphaned;
    // redrawTrips / redrawVizObjects will replace them.
    vizParticle = null;
    vizTravLine = null;
    map = new MapClass(container, {
      center: c,
      zoom: z,
      mapId: PUBLIC_GOOGLE_MAP_ID,
      colorScheme: scheme,
      mapTypeControl: false,
    });
  }

  async function redrawTrips() {
    if (!trips.length || !map) return;
    const { Polyline } = await loader.importLibrary('maps');
    trips = trips.map((t) => ({
      ...t,
      polyline: new Polyline({
        path: t.path,
        strokeColor: t.color,
        strokeWeight: 5,
        strokeOpacity: 0.85,
        map,
      }),
    }));
  }

  async function redrawVizObjects() {
    if (!map || !trips.length) return;
    const currentTrip = trips[vizTripIdx];
    if (!currentTrip) return;

    const { AdvancedMarkerElement } = await loader.importLibrary('marker');
    const { Polyline } = await loader.importLibrary('maps');

    // Determine where the particle should appear on the rebuilt map.
    let curPos;
    if (vizSimTime > 0) {
      const interp = interpolate(currentTrip.timeline.points, vizSimTime);
      curPos = { lat: interp.lat, lng: interp.lng };
    } else if (vizTravPts.length > 0) {
      curPos = vizTravPts[vizTravPts.length - 1];
    } else {
      const p0 = currentTrip.timeline.points[0];
      curPos = { lat: p0.lat, lng: p0.lng };
    }

    const el = document.createElement('div');
    el.className = 'dr-particle';
    el.style.color = currentTrip.color;
    vizParticle = new AdvancedMarkerElement({
      map, position: curPos, content: el, zIndex: 20,
    });

    vizTravLine = new Polyline({
      path: [...vizTravPts, curPos],
      strokeColor: currentTrip.color,
      strokeWeight: 6,
      strokeOpacity: 1,
      map,
      zIndex: 5,
    });
  }

  // ── Agregar viaje ─────────────────────────────────────────────────────────
  // Pide la ruta a la API de Directions y devuelve los datos ya procesados.
  // Reutilizado por addTrip() y saveEdit().
  async function requestRoute(origin, dest) {
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': PUBLIC_GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': [
          'routes.distanceMeters',
          'routes.duration',
          'routes.polyline.encodedPolyline',
          'routes.legs.steps.distanceMeters',
          'routes.legs.steps.staticDuration',
          'routes.legs.steps.polyline.encodedPolyline',
        ].join(','),
      },
      body: JSON.stringify({
        origin: { address: origin },
        destination: { address: dest },
        travelMode: 'DRIVE',
        computeAlternativeRoutes: false,
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.routes?.length) {
      throw new Error(data.error?.message ?? 'No se encontró ruta entre estos dos lugares.');
    }

    const route = data.routes[0];
    const steps = route.legs?.[0]?.steps ?? [];
    const { encoding } = await loader.importLibrary('geometry');

    return {
      distanceKm: route.distanceMeters / 1000,
      durationText: parseDuration(route.duration),
      encodedPolyline: route.polyline.encodedPolyline,
      path: encoding.decodePath(route.polyline.encodedPolyline),
      timeline: buildTimeline(steps, encoding),
    };
  }

  async function addTrip() {
    if (!originInput.trim() || !destinationInput.trim()) return;
    loading = true;
    formError = '';

    try {
      const info = await requestRoute(originInput.trim(), destinationInput.trim());
      const { Polyline } = await loader.importLibrary('maps');

      const color    = COLORS[trips.length % COLORS.length];
      const polyline = new Polyline({ path: info.path, strokeColor: color, strokeWeight: 5, strokeOpacity: 0.85, map });

      trips = [
        ...trips,
        {
          id: Date.now(),
          origin: originInput.trim(),
          destination: destinationInput.trim(),
          ...info,
          polyline,
          color,
        },
      ];

      originInput      = destinationInput.trim();
      destinationInput = '';
      fitAll(trips);

      // If viz was done, reset to idle so controls are clean
      if (vizState === 'done') resetViz();
    } catch (e) {
      formError = e.message;
    } finally {
      loading = false;
    }
  }

  // ── Editar viaje ──────────────────────────────────────────────────────────
  function startEdit(trip) {
    editingId  = trip.id;
    editOrigin = trip.origin;
    editDest   = trip.destination;
    editError  = '';
  }

  function cancelEdit() {
    editingId = null;
    editError = '';
  }

  async function saveEdit(id) {
    const origin = editOrigin.trim();
    const dest   = editDest.trim();
    if (!origin || !dest) return;
    editLoading = true;
    editError   = '';

    try {
      const info = await requestRoute(origin, dest);
      const trip = trips.find((t) => t.id === id);
      if (!trip) return;

      // Replace the old polyline on the map, keeping the trip's color/id.
      trip.polyline.setMap(null);
      const { Polyline } = await loader.importLibrary('maps');
      const polyline = new Polyline({ path: info.path, strokeColor: trip.color, strokeWeight: 5, strokeOpacity: 0.85, map });

      // Geometry changed — clear any running visualization so it doesn't
      // reference stale paths.
      resetViz();

      trips = trips.map((t) =>
        t.id === id ? { ...t, origin, destination: dest, ...info, polyline } : t
      );

      editingId = null;
      fitAll(trips);
    } catch (e) {
      editError = e.message;
    } finally {
      editLoading = false;
    }
  }

  // ── Lugares guardados ─────────────────────────────────────────────────────
  function loadPlaces() {
    try {
      const raw = localStorage.getItem(PLACES_KEY);
      if (raw) savedPlaces = JSON.parse(raw);
    } catch { /* ignore corrupt/unavailable storage */ }
  }

  function persistPlaces() {
    try {
      localStorage.setItem(PLACES_KEY, JSON.stringify(savedPlaces));
    } catch { /* ignore */ }
  }

  function addPlace() {
    const label   = newPlaceLabel.trim();
    const address = newPlaceAddress.trim();
    if (!label || !address) return;
    savedPlaces = [...savedPlaces, { id: Date.now(), label, address }];
    persistPlaces();
    newPlaceLabel   = '';
    newPlaceAddress = '';
    showPlaceForm   = false;
  }

  function removePlace(id) {
    savedPlaces = savedPlaces.filter((p) => p.id !== id);
    persistPlaces();
  }

  function buildTimeline(steps, encoding) {
    const pts = [];
    let cumT = 0, cumD = 0;
    for (const step of steps) {
      const path  = encoding.decodePath(step.polyline.encodedPolyline);
      const dist  = step.distanceMeters ?? 0;
      const dur   = parseInt(step.staticDuration ?? '0');
      const speed = dur > 0 ? (dist / dur) * 3.6 : 0;
      const n = path.length;
      for (let i = 0; i < n; i++) {
        const f = n > 1 ? i / (n - 1) : 0;
        pts.push({
          lat: path[i].lat(), lng: path[i].lng(),
          time: cumT + f * dur, distance: cumD + f * dist, speed,
        });
      }
      cumT += dur; cumD += dist;
    }
    return { points: pts, totalDurationS: cumT };
  }

  // ── Trip list actions ─────────────────────────────────────────────────────
  function removeTrip(id) {
    resetViz();
    const trip = trips.find((t) => t.id === id);
    if (trip) trip.polyline.setMap(null);
    const remaining = trips.filter((t) => t.id !== id);
    trips = remaining;
    fitAll(remaining);
  }

  function clearAll() {
    resetViz();
    trips.forEach((t) => t.polyline.setMap(null));
    trips = [];
    originInput = '';
    destinationInput = '';
  }

  // ── Map helpers ───────────────────────────────────────────────────────────
  async function fitAll(currentTrips) {
    if (!currentTrips.length) return;
    const { LatLngBounds } = await loader.importLibrary('core');
    const bounds = new LatLngBounds();
    currentTrips.forEach((t) => t.path.forEach((p) => bounds.extend(p)));
    map.fitBounds(bounds, { top: 48, right: 48, bottom: 48, left: 48 });
  }

  // ── Visualization playback ────────────────────────────────────────────────
  async function playViz() {
    if (!trips.length) return;

    const isRestart = vizState === 'done' || vizState === 'idle';
    if (isRestart) {
      vizSimTime = 0; vizTripIdx = 0; vizTravPts = []; vizTravIdx = 0;
    }

    // Create map objects if needed
    if (!vizParticle) {
      const { AdvancedMarkerElement } = await loader.importLibrary('marker');
      const el = document.createElement('div');
      el.className = 'dr-particle';
      el.style.color = trips[0].color;
      vizParticle = new AdvancedMarkerElement({
        map, position: trips[0].timeline.points[0], content: el, zIndex: 20,
      });
    }
    if (!vizTravLine) {
      const { Polyline } = await loader.importLibrary('maps');
      vizTravLine = new Polyline({
        path: [], strokeColor: trips[vizTripIdx]?.color ?? '#4f46e5',
        strokeWeight: 6, strokeOpacity: 1, map, zIndex: 5,
      });
    }

    vizState = 'playing';
    vizLastTs = null;
    vizRaf = requestAnimationFrame(vizTick);
  }

  function pauseViz() {
    stopVizAnim();
    vizState = 'paused';
  }

  function resetViz() {
    stopVizAnim();
    destroyVizObjects();
    vizSimTime = 0; vizTripIdx = 0; vizTravPts = []; vizTravIdx = 0;
    vizState = 'idle';
    vizSpeed = 0; vizDistKm = 0; vizLitres = 0; vizCost = 0; vizProgress = 0; vizTripLabel = '';
  }

  function stopVizAnim() {
    if (vizRaf) { cancelAnimationFrame(vizRaf); vizRaf = null; }
  }

  function destroyVizObjects() {
    if (vizParticle)  { vizParticle.map = null;     vizParticle = null; }
    if (vizTravLine)  { vizTravLine.setMap(null);    vizTravLine = null; }
  }

  // ── Animation loop ────────────────────────────────────────────────────────
  function vizTick(ts) {
    if (!vizLastTs) vizLastTs = ts;
    const delta = (ts - vizLastTs) / 1000;
    vizLastTs = ts;
    vizSimTime += delta * vizSpeedMult;

    const currentTrip = trips[vizTripIdx];
    if (!currentTrip) { vizState = 'done'; vizRaf = null; return; }

    // Advance to next trip when current is finished
    if (vizSimTime >= currentTrip.timeline.totalDurationS) {
      // Snap particle to end of current trip
      const pts = currentTrip.timeline.points;
      vizAdvance(currentTrip.timeline.totalDurationS, currentTrip, vizTripIdx);

      if (vizTripIdx + 1 >= trips.length) {
        vizState = 'done';
        vizRaf = null;
        return;
      }

      // Move to next trip
      vizTripIdx++;
      vizSimTime = 0;
      vizTravPts = [];
      vizTravIdx = 0;

      const nextTrip = trips[vizTripIdx];
      // Update traveledLine color to match next trip
      vizTravLine?.setOptions({ strokeColor: nextTrip.color });
      vizTravLine?.setPath([]);
      // Update particle color
      if (vizParticle?.content) vizParticle.content.style.color = nextTrip.color;
    }

    vizAdvance(vizSimTime, trips[vizTripIdx], vizTripIdx);
    vizRaf = requestAnimationFrame(vizTick);
  }

  function vizAdvance(t, trip, tripIdx) {
    if (!trip) return;
    const pts = trip.timeline.points;

    while (vizTravIdx < pts.length && pts[vizTravIdx].time <= t) {
      vizTravPts.push({ lat: pts[vizTravIdx].lat, lng: pts[vizTravIdx].lng });
      vizTravIdx++;
    }

    const cur = interpolate(pts, t);
    if (vizParticle) vizParticle.position = { lat: cur.lat, lng: cur.lng };
    if (vizTravLine) vizTravLine.setPath([...vizTravPts, { lat: cur.lat, lng: cur.lng }]);

    // Cumulative stats
    const completedDist = trips.slice(0, tripIdx).reduce((s, t) => s + t.distanceKm, 0);
    const totalDist = completedDist + cur.distance / 1000;

    vizSpeed    = Math.round(cur.speed);
    vizDistKm   = totalDist;
    vizLitres   = kmPerLitre > 0 ? totalDist / kmPerLitre : 0;
    vizCost     = vizLitres * fuelPriceCLP;
    vizProgress = totalDistanceKm > 0 ? Math.min(1, totalDist / totalDistanceKm) : 0;
    vizTripLabel = `Viaje ${tripIdx + 1} / ${trips.length}`;
  }

  function interpolate(pts, t) {
    if (!pts.length) return { lat: 0, lng: 0, speed: 0, distance: 0 };
    if (t <= pts[0].time) return pts[0];
    if (t >= pts[pts.length - 1].time) return pts[pts.length - 1];
    let lo = 0, hi = pts.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].time <= t) lo = mid; else hi = mid;
    }
    const a = pts[lo], b = pts[hi];
    const f = (t - a.time) / (b.time - a.time);
    return {
      lat: a.lat + f * (b.lat - a.lat), lng: a.lng + f * (b.lng - a.lng),
      speed: a.speed + f * (b.speed - a.speed), distance: a.distance + f * (b.distance - a.distance),
    };
  }

  // ── PDF ───────────────────────────────────────────────────────────────────
  async function generatePDF() {
    if (!tripsWithCost.length) return;
    pdfLoading = true;
    try {
      const { jsPDF } = await import('jspdf');
      await import('jspdf-autotable');
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const M = 15, W = 210 - 2 * M;
      let y = M;

      // Logo + título
      const lx = M + 4, ly = y + 4;
      doc.setFillColor(79, 70, 229);
      doc.circle(lx, ly, 3, 'F');
      doc.setFillColor(255, 255, 255);
      doc.circle(lx, ly, 1.2, 'F');
      doc.setFillColor(79, 70, 229);
      doc.lines([[3, 0], [-1.5, 4], [-1.5, -4]], lx - 1.5, ly + 2.2, [1, 1], 'F', true);
      doc.setFontSize(15);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(79, 70, 229);
      doc.text('Maps', M + 11, y + 5.5);
      const mapsW = doc.getTextWidth('Maps');
      doc.setTextColor(17, 24, 39);
      doc.text(' Sandbox', M + 11 + mapsW, y + 5.5);
      const today = new Date().toLocaleDateString('es-CL', { year: 'numeric', month: 'long', day: 'numeric' });
      doc.setFontSize(8.5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(107, 114, 128);
      doc.text(today, 210 - M, y + 5.5, { align: 'right' });
      y += 14;

      doc.setFontSize(13);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(17, 24, 39);
      doc.text('Gastos Diarios de Combustible', M, y);
      y += 9;

      // Parámetros
      sectionLabel(doc, 'PARÁMETROS DE COMBUSTIBLE', M, y); y += 5;
      doc.setFillColor(249, 250, 251);
      doc.setDrawColor(229, 231, 235);
      doc.roundedRect(M, y, W, 15, 2, 2, 'FD');
      doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(55, 65, 81);
      doc.text(`Consumo: ${consumptionPer100km} L/100 km  =  ${fmtRatio(kmPerLitre)}`, M + 5, y + 6);
      doc.text(`Precio combustible: ${fmtCLP(fuelPriceCLP)} / L`, M + 5, y + 11.5);
      y += 21;

      // Tabla de viajes
      sectionLabel(doc, 'DETALLE DE VIAJES', M, y); y += 4;
      doc.autoTable({
        startY: y, margin: { left: M, right: M },
        head: [['#', 'Desde', 'Hasta', 'Distancia', 'Tiempo', 'Combustible', 'Costo']],
        body: tripsWithCost.map((t, i) => [
          `Viaje ${i + 1}`, t.origin, t.destination,
          fmtKm(t.distanceKm), t.durationText, fmtL(t.litres), fmtCLP(t.cost),
        ]),
        headStyles: { fillColor: [79, 70, 229], textColor: 255, fontSize: 8, fontStyle: 'bold' },
        bodyStyles: { fontSize: 8, textColor: [55, 65, 81] },
        alternateRowStyles: { fillColor: [249, 250, 251] },
        columnStyles: {
          0: { cellWidth: 18 }, 3: { cellWidth: 24, halign: 'right' },
          4: { cellWidth: 20, halign: 'right' }, 5: { cellWidth: 26, halign: 'right' },
          6: { cellWidth: 28, halign: 'right' },
        },
      });
      y = doc.lastAutoTable.finalY + 9;

      // Total
      sectionLabel(doc, 'TOTAL DEL DÍA', M, y); y += 5;
      doc.setFillColor(238, 242, 255); doc.setDrawColor(199, 210, 254);
      doc.roundedRect(M, y, W, 19, 2, 2, 'FD');
      const col = W / 3;
      [['Distancia recorrida', fmtKm(totalDistanceKm)], ['Combustible usado', fmtL(totalLitres)], ['Gasto total', fmtCLP(totalCost)]].forEach(([label, value], i) => {
        const cx = M + col * i + 5;
        doc.setFontSize(7); doc.setFont('helvetica', 'normal'); doc.setTextColor(107, 114, 128);
        doc.text(label, cx, y + 6.5);
        doc.setFontSize(10); doc.setFont('helvetica', 'bold');
        doc.setTextColor(...(i === 2 ? [79, 70, 229] : [17, 24, 39]));
        doc.text(value, cx, y + 14.5);
      });
      y += 26;

      // Mapa
      if (y + 92 > 297 - M) { doc.addPage(); y = M; }
      sectionLabel(doc, 'MAPA DE RUTA', M, y); y += 5;
      const pathParams = trips.map((t, i) => {
        const hex = COLORS[i % COLORS.length].replace('#', '0x') + 'ff';
        return `path=${encodeURIComponent(`weight:5|color:${hex}|enc:${t.encodedPolyline}`)}`;
      }).join('&');
      const staticUrl = `https://maps.googleapis.com/maps/api/staticmap?size=640x320&maptype=roadmap&scale=2&${pathParams}&key=${PUBLIC_GOOGLE_MAPS_API_KEY}`;
      try {
        const imgResp = await fetch(staticUrl);
        if (!imgResp.ok) throw new Error();
        const blob = await imgResp.blob();
        const imgUrl = await blobToDataUrl(blob);
        const renderedH = (W * 320) / 640;
        doc.addImage(imgUrl, 'PNG', M, y, W, renderedH);
      } catch {
        doc.setFillColor(243, 244, 246); doc.setDrawColor(229, 231, 235);
        doc.roundedRect(M, y, W, 85, 2, 2, 'FD');
        doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(156, 163, 175);
        doc.text('Imagen del mapa no disponible', M + W / 2, y + 42.5, { align: 'center' });
      }
      doc.save(`gastos-diarios-${new Date().toISOString().slice(0, 10)}.pdf`);
    } finally {
      pdfLoading = false;
    }
  }

  function sectionLabel(doc, text, x, y) {
    doc.setFontSize(7.5); doc.setFont('helvetica', 'bold'); doc.setTextColor(156, 163, 175);
    doc.text(text, x, y);
  }
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob);
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function parseDuration(s) {
    const secs = parseInt(s ?? '0');
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60);
    if (h === 0) return `${m} min`; if (m === 0) return `${h} h`; return `${h} h ${m} min`;
  }
  function handleKeydown(e) { if (e.key === 'Enter') addTrip(); }
  function fmtKm(n)  { return `${n.toFixed(1)} km`; }
  function fmtL(n)   { return `${n.toFixed(2)} L`; }
  function fmtCLP(n) {
    return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(Math.round(n));
  }
  function fmtRatio(n) { return `${n.toFixed(2)} km/L`; }

  // ── Compare mode ──────────────────────────────────────────────────────────
  let compareMode = $state(false);
  let cmpContainerA;
  let cmpContainerB;
  let cmpMapA = null;
  let cmpMapB = null;
  let cmpSchemeA = null;
  let cmpSchemeB = null;

  // Route A
  let cmpOriginA      = $state('');
  let cmpDestA        = $state('');
  let cmpRouteA       = $state(null); // { distanceKm, durationS, durationText, litres, cost, encodedPolyline }
  let cmpLoadingA     = $state(false);
  let cmpErrorA       = $state('');

  // Route B
  let cmpOriginB      = $state('');
  let cmpDestB        = $state('');
  let cmpRouteB       = $state(null);
  let cmpLoadingB     = $state(false);
  let cmpErrorB       = $state('');

  let cmpLitresA = $derived(cmpRouteA && kmPerLitre > 0 ? cmpRouteA.distanceKm / kmPerLitre : 0);
  let cmpCostA   = $derived(cmpLitresA * fuelPriceCLP);
  let cmpLitresB = $derived(cmpRouteB && kmPerLitre > 0 ? cmpRouteB.distanceKm / kmPerLitre : 0);
  let cmpCostB   = $derived(cmpLitresB * fuelPriceCLP);

  let sidebarWasCollapsed = false;

  function enterCompare() {
    compareMode = true;
    sidebarWasCollapsed = sidebar.collapsed;
    sidebar.collapse();
    // Build compare maps on next tick once containers are mounted
    requestAnimationFrame(() => {
      buildCmpMap('A');
      buildCmpMap('B');
    });
  }

  function exitCompare() {
    compareMode = false;
    if (!sidebarWasCollapsed) sidebar.expand();
    // Clean up compare map overlays
    cmpRouteA = null; cmpRouteB = null;
    cmpErrorA = ''; cmpErrorB = '';
    cmpMapA = null; cmpMapB = null;
    cmpSchemeA = null; cmpSchemeB = null;
  }

  function buildCmpMap(side) {
    const scheme = theme.isDark ? 'DARK' : 'LIGHT';
    const cnt = side === 'A' ? cmpContainerA : cmpContainerB;
    if (!cnt || !MapClass) return;
    cnt.innerHTML = '';
    const m = new MapClass(cnt, {
      center: { lat: -36.8197, lng: -73.0521 },
      zoom: 12,
      mapId: PUBLIC_GOOGLE_MAP_ID,
      colorScheme: scheme,
      mapTypeControl: false,
    });
    if (side === 'A') { cmpMapA = m; cmpSchemeA = scheme; }
    else              { cmpMapB = m; cmpSchemeB = scheme; }
  }

  // Rebuild compare maps on theme change
  $effect(() => {
    if (!compareMode || !MapClass) return;
    const scheme = theme.isDark ? 'DARK' : 'LIGHT';
    if (cmpSchemeA !== scheme) {
      const cA = cmpMapA?.getCenter()?.toJSON() ?? { lat: -36.8197, lng: -73.0521 };
      const zA = cmpMapA?.getZoom() ?? 12;
      buildCmpMap('A');
      if (cmpMapA) { cmpMapA.setCenter(cA); cmpMapA.setZoom(zA); }
      if (cmpRouteA) drawCmpRoute('A', cmpRouteA);
    }
    if (cmpSchemeB !== scheme) {
      const cB = cmpMapB?.getCenter()?.toJSON() ?? { lat: -36.8197, lng: -73.0521 };
      const zB = cmpMapB?.getZoom() ?? 12;
      buildCmpMap('B');
      if (cmpMapB) { cmpMapB.setCenter(cB); cmpMapB.setZoom(zB); }
      if (cmpRouteB) drawCmpRoute('B', cmpRouteB);
    }
  });

  async function calcCmpRoute(side) {
    const origin = side === 'A' ? cmpOriginA : cmpOriginB;
    const dest   = side === 'A' ? cmpDestA   : cmpDestB;
    if (!origin.trim() || !dest.trim()) return;

    if (side === 'A') { cmpLoadingA = true; cmpErrorA = ''; }
    else              { cmpLoadingB = true; cmpErrorB = ''; }

    try {
      const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': PUBLIC_GOOGLE_MAPS_API_KEY,
          'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline',
        },
        body: JSON.stringify({
          origin: { address: origin.trim() },
          destination: { address: dest.trim() },
          travelMode: 'DRIVE',
          computeAlternativeRoutes: false,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.routes?.length) throw new Error(data.error?.message ?? 'No se encontró ruta.');

      const route = data.routes[0];
      const durationS = parseInt(route.duration ?? '0');
      const routeInfo = {
        distanceKm: route.distanceMeters / 1000,
        durationS,
        durationText: parseDuration(route.duration),
        encodedPolyline: route.polyline.encodedPolyline,
      };

      if (side === 'A') cmpRouteA = routeInfo;
      else              cmpRouteB = routeInfo;

      await drawCmpRoute(side, routeInfo);
    } catch (e) {
      if (side === 'A') cmpErrorA = e.message;
      else              cmpErrorB = e.message;
    } finally {
      if (side === 'A') cmpLoadingA = false;
      else              cmpLoadingB = false;
    }
  }

  async function drawCmpRoute(side, routeInfo) {
    const m = side === 'A' ? cmpMapA : cmpMapB;
    if (!m) return;

    const { encoding }     = await loader.importLibrary('geometry');
    const { Polyline }     = await loader.importLibrary('maps');
    const { LatLngBounds } = await loader.importLibrary('core');

    const path = encoding.decodePath(routeInfo.encodedPolyline);
    const color = side === 'A' ? '#4f46e5' : '#059669';

    new Polyline({ path, strokeColor: color, strokeWeight: 5, strokeOpacity: 0.9, map: m });

    const bounds = new LatLngBounds();
    path.forEach(p => bounds.extend(p));
    m.fitBounds(bounds, 48);
  }

  function handleCmpKeydown(side) {
    return (e) => { if (e.key === 'Enter') calcCmpRoute(side); };
  }

  // ── Optimizar ruta ──────────────────────────────────────────────────────────
  let optimizeMode     = $state(false);
  let optStart         = $state('');
  let optStops         = $state([]);     // { id, address }
  let optStopInput     = $state('');
  let optReturnToStart = $state(true);
  let optEnd           = $state('');
  let optLoading       = $state(false);
  let optError         = $state('');
  // optResult: { order:[{label,address}], distanceKm, durationText,
  //              originalDistanceKm, savedKm, encodedPolyline, positions }
  let optResult        = $state(null);

  let optContainer;
  let optMap    = null;
  let optScheme = null;

  let optLitres      = $derived(optResult && kmPerLitre > 0 ? optResult.distanceKm / kmPerLitre : 0);
  let optCost        = $derived(optLitres * fuelPriceCLP);
  let optSavedLitres = $derived(optResult && optResult.savedKm > 0 && kmPerLitre > 0 ? optResult.savedKm / kmPerLitre : 0);
  let optSavedCost   = $derived(optSavedLitres * fuelPriceCLP);

  function enterOptimize() {
    optimizeMode = true;
    sidebarWasCollapsed = sidebar.collapsed;
    sidebar.collapse();
    requestAnimationFrame(() => buildOptMap());
  }

  function exitOptimize() {
    optimizeMode = false;
    if (!sidebarWasCollapsed) sidebar.expand();
    optMap = null; optScheme = null;
  }

  function buildOptMap() {
    const scheme = theme.isDark ? 'DARK' : 'LIGHT';
    if (!optContainer || !MapClass) return;
    optContainer.innerHTML = '';
    optMap = new MapClass(optContainer, {
      center: { lat: -36.8197, lng: -73.0521 },
      zoom: 12, mapId: PUBLIC_GOOGLE_MAP_ID, colorScheme: scheme, mapTypeControl: false,
    });
    optScheme = scheme;
  }

  // Rebuild the optimizer map on theme change and redraw the result.
  $effect(() => {
    if (!optimizeMode || !MapClass) return;
    const scheme = theme.isDark ? 'DARK' : 'LIGHT';
    if (optScheme !== scheme) {
      buildOptMap();
      if (optResult) renderOptOverlay();
    }
  });

  function addOptStop() {
    const address = optStopInput.trim();
    if (!address) return;
    optStops = [...optStops, { id: Date.now(), address }];
    optStopInput = '';
  }

  function removeOptStop(id) {
    optStops = optStops.filter((s) => s.id !== id);
  }

  // Seed the optimizer from places already used in the day's trips,
  // in first-appearance order (deduped, case-insensitive).
  function seedFromTrips() {
    const seen = new Set();
    const uniques = [];
    for (const t of trips) {
      for (const addr of [t.origin, t.destination]) {
        const key = addr.trim().toLowerCase();
        if (key && !seen.has(key)) { seen.add(key); uniques.push(addr); }
      }
    }
    if (!uniques.length) return;
    optStart = uniques[0];
    optStops = uniques.slice(1).map((address, i) => ({ id: Date.now() + i, address }));
    optResult = null;
  }

  async function requestWaypointRoute(origin, destination, intermediates, optimize) {
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': PUBLIC_GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': [
          'routes.distanceMeters',
          'routes.duration',
          'routes.polyline.encodedPolyline',
          'routes.optimizedIntermediateWaypointIndex',
          'routes.legs.startLocation.latLng',
          'routes.legs.endLocation.latLng',
        ].join(','),
      },
      body: JSON.stringify({
        origin: { address: origin },
        destination: { address: destination },
        intermediates: intermediates.map((address) => ({ address })),
        travelMode: 'DRIVE',
        optimizeWaypointOrder: optimize,
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.routes?.length) {
      throw new Error(data.error?.message ?? 'No se pudo calcular la ruta. Revisa las direcciones.');
    }
    const route = data.routes[0];
    return {
      distanceKm: route.distanceMeters / 1000,
      duration: route.duration,
      encodedPolyline: route.polyline.encodedPolyline,
      legs: route.legs ?? [],
      optimizedIndex: route.optimizedIntermediateWaypointIndex
        ?? intermediates.map((_, i) => i),
    };
  }

  async function optimizeRoute() {
    const start = optStart.trim();
    const stops = optStops.map((s) => s.address.trim()).filter(Boolean);
    const end   = optReturnToStart ? start : optEnd.trim();
    if (!start || !end || stops.length < 1) {
      optError = 'Indica un inicio, un fin y al menos una parada.';
      return;
    }
    optLoading = true;
    optError   = '';

    try {
      // Optimized order + the entered order (for the savings comparison).
      const opt  = await requestWaypointRoute(start, end, stops, true);
      const orig = await requestWaypointRoute(start, end, stops, false);

      const orderedStops = opt.optimizedIndex.map((idx) => stops[idx]);
      const order = [
        { label: 'Inicio', address: start },
        ...orderedStops.map((address, i) => ({ label: `Parada ${i + 1}`, address })),
        { label: optReturnToStart ? 'Regreso al inicio' : 'Fin', address: end },
      ];

      // Marker positions come from the leg endpoints (already in optimized order).
      const positions = [];
      if (opt.legs.length) {
        const s = opt.legs[0].startLocation?.latLng;
        if (s) positions.push({ lat: s.latitude, lng: s.longitude, kind: 'start' });
        opt.legs.forEach((leg, i) => {
          const e = leg.endLocation?.latLng;
          if (e) positions.push({
            lat: e.latitude, lng: e.longitude,
            kind: i === opt.legs.length - 1 ? 'end' : 'mid', n: i + 1,
          });
        });
      }

      optResult = {
        order,
        distanceKm: opt.distanceKm,
        durationText: parseDuration(opt.duration),
        originalDistanceKm: orig.distanceKm,
        savedKm: orig.distanceKm - opt.distanceKm,
        encodedPolyline: opt.encodedPolyline,
        positions,
      };

      buildOptMap();
      await renderOptOverlay();
    } catch (e) {
      optError = e.message;
    } finally {
      optLoading = false;
    }
  }

  async function renderOptOverlay() {
    if (!optMap || !optResult) return;
    const { encoding }     = await loader.importLibrary('geometry');
    const { Polyline }     = await loader.importLibrary('maps');
    const { LatLngBounds } = await loader.importLibrary('core');
    const { AdvancedMarkerElement } = await loader.importLibrary('marker');

    const path = encoding.decodePath(optResult.encodedPolyline);
    new Polyline({ path, strokeColor: '#4f46e5', strokeWeight: 5, strokeOpacity: 0.9, map: optMap });

    for (const p of optResult.positions) {
      const el = document.createElement('div');
      el.style.cssText =
        'display:flex;align-items:center;justify-content:center;width:24px;height:24px;' +
        'border-radius:50%;font:700 11px/1 system-ui,sans-serif;color:#fff;' +
        'border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);';
      el.style.background = p.kind === 'start' ? '#059669' : p.kind === 'end' ? '#dc2626' : '#4f46e5';
      el.textContent = p.kind === 'start' ? 'A' : p.kind === 'end' ? 'B' : String(p.n);
      new AdvancedMarkerElement({ map: optMap, position: { lat: p.lat, lng: p.lng }, content: el });
    }

    const bounds = new LatLngBounds();
    path.forEach((pt) => bounds.extend(pt));
    optMap.fitBounds(bounds, 56);
  }
</script>

<!-- Chips de lugares guardados; `set` recibe la dirección elegida. -->
{#snippet placeChips(set)}
  {#if savedPlaces.length > 0}
    <div class="place-chips">
      {#each savedPlaces as place (place.id)}
        <button type="button" class="place-chip" onclick={() => set(place.address)} title={place.address}>
          📍 {place.label}
        </button>
      {/each}
    </div>
  {/if}
{/snippet}

<div class="experiment">
  <header>
    <div>
      <h2>Gastos Diarios</h2>
      <p>Suma varios viajes del día y visualiza el recorrido con contador de combustible en tiempo real.</p>
    </div>
    <div class="header-actions">
      {#if !compareMode && !optimizeMode}
        <button class="btn-compare" onclick={enterOptimize}>
          <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M3 5a1 1 0 011-1h7.586L9.293 1.707A1 1 0 0110.707.293l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414-1.414L11.586 6H4a1 1 0 01-1-1zm14 10a1 1 0 01-1 1H8.414l2.293 2.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 1.414L8.414 14H16a1 1 0 011 1z" clip-rule="evenodd"/></svg>
          Optimizar ruta
        </button>
        <button class="btn-compare" onclick={enterCompare}>
          <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path d="M9 2a1 1 0 00-1 1v14a1 1 0 102 0V3a1 1 0 00-1-1zM3 8a1 1 0 011-1h2a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h2a1 1 0 110 2H4a1 1 0 01-1-1zm10-4a1 1 0 011-1h2a1 1 0 110 2h-2a1 1 0 01-1-1zm0 4a1 1 0 011-1h2a1 1 0 110 2h-2a1 1 0 01-1-1z"/></svg>
          Comparar rutas
        </button>
      {:else if compareMode}
        <button class="btn-clear" onclick={exitCompare}>Salir comparación</button>
      {:else}
        <button class="btn-clear" onclick={exitOptimize}>Salir optimizador</button>
      {/if}
      {#if trips.length > 0 && !compareMode && !optimizeMode}
        <button class="btn-pdf" onclick={generatePDF} disabled={pdfLoading}>
          {#if pdfLoading}
            <span class="spinner-sm"></span> Generando…
          {:else}
            <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
            Descargar PDF
          {/if}
        </button>
        <button class="btn-clear" onclick={clearAll}>Limpiar todo</button>
      {/if}
    </div>
  </header>

  {#if optimizeMode}
  <div class="optimize-body">
    <aside class="opt-panel">
      <div class="opt-intro">
        <div class="opt-intro-text">
          <p class="opt-intro-title">Orden más eficiente</p>
          <p class="opt-intro-sub">Define un inicio, las paradas y el fin. Calculamos el orden que menos kilómetros recorre.</p>
        </div>
        <button class="opt-exit-mobile" onclick={exitOptimize} aria-label="Salir del optimizador">×</button>
      </div>

      <section class="section">
        <label class="field">
          <span>Inicio</span>
          <input type="text" placeholder="Punto de partida" bind:value={optStart} />
        </label>
        {@render placeChips((a) => optStart = a)}
      </section>

      <section class="section">
        <p class="section-title">Paradas a visitar</p>
        {#if optStops.length > 0}
          <ul class="opt-stops">
            {#each optStops as stop, i (stop.id)}
              <li class="opt-stop">
                <span class="opt-stop-num">{i + 1}</span>
                <span class="opt-stop-addr">{stop.address}</span>
                <button class="btn-remove" onclick={() => removeOptStop(stop.id)} aria-label="Quitar parada">×</button>
              </li>
            {/each}
          </ul>
        {/if}
        <div class="opt-add-row">
          <input
            type="text"
            placeholder="Agregar parada"
            bind:value={optStopInput}
            onkeydown={(e) => e.key === 'Enter' && addOptStop()}
          />
          <button class="btn-add opt-add-btn" onclick={addOptStop} disabled={!optStopInput}>+</button>
        </div>
        {@render placeChips((a) => optStopInput = a)}
        {#if trips.length > 0}
          <button class="btn-seed" onclick={seedFromTrips}>↺ Usar lugares de mis viajes</button>
        {/if}
      </section>

      <section class="section">
        <p class="section-title">Fin</p>
        <label class="opt-radio">
          <input type="radio" name="opt-end" checked={optReturnToStart} onchange={() => optReturnToStart = true} />
          <span>Volver al inicio (ida y vuelta)</span>
        </label>
        <label class="opt-radio">
          <input type="radio" name="opt-end" checked={!optReturnToStart} onchange={() => optReturnToStart = false} />
          <span>Terminar en otro lugar</span>
        </label>
        {#if !optReturnToStart}
          <input class="opt-end-input" type="text" placeholder="Punto final" bind:value={optEnd} />
          {@render placeChips((a) => optEnd = a)}
        {/if}
      </section>

      <section class="section">
        <button
          class="btn-add"
          onclick={optimizeRoute}
          disabled={optLoading || !optStart || optStops.length < 1 || (!optReturnToStart && !optEnd)}
        >
          {#if optLoading}<span class="spinner"></span> Optimizando…{:else}Optimizar ruta{/if}
        </button>
        {#if optError}<p class="error">{optError}</p>{/if}
      </section>

      {#if optResult}
        <section class="section">
          <p class="section-title">Orden óptimo</p>
          <ol class="opt-order">
            {#each optResult.order as step, i (step.label + step.address)}
              <li class="opt-order-item">
                <span class="opt-order-badge" class:start={i === 0} class:end={i === optResult.order.length - 1}>
                  {i === 0 ? 'A' : i === optResult.order.length - 1 ? 'B' : i}
                </span>
                <div class="opt-order-text">
                  <span class="opt-order-label">{step.label}</span>
                  <span class="opt-order-addr">{step.address}</span>
                </div>
              </li>
            {/each}
          </ol>
        </section>

        <section class="section total-section">
          <p class="section-title">Resumen</p>
          <div class="result-row"><span>Distancia óptima</span><strong>{fmtKm(optResult.distanceKm)}</strong></div>
          <div class="result-row"><span>Tiempo estimado</span><strong>{optResult.durationText}</strong></div>
          <div class="result-row"><span>Combustible</span><strong>{fmtL(optLitres)}</strong></div>
          <div class="result-row grand-total"><span>Costo</span><strong>{fmtCLP(optCost)}</strong></div>
          {#if optResult.savedKm > 0.05}
            <div class="opt-savings">
              Ahorras <strong>{fmtKm(optResult.savedKm)}</strong> ({fmtCLP(optSavedCost)}) frente al orden ingresado, que recorría {fmtKm(optResult.originalDistanceKm)}.
            </div>
          {:else}
            <div class="opt-savings neutral">El orden que ingresaste ya era el más eficiente.</div>
          {/if}
        </section>
      {/if}
    </aside>

    <div class="opt-map" bind:this={optContainer}></div>
  </div>
  {:else if compareMode}
  <div class="compare-body">
    <!-- Route A -->
    <div class="cmp-side">
      <div class="cmp-form">
        <p class="cmp-label" style="color: #4f46e5;">Ruta A</p>
        <div class="cmp-fields">
          <input type="text" placeholder="Origen A" bind:value={cmpOriginA} onkeydown={handleCmpKeydown('A')} />
          <input type="text" placeholder="Destino A" bind:value={cmpDestA} onkeydown={handleCmpKeydown('A')} />
          <button class="btn-add cmp-btn" onclick={() => calcCmpRoute('A')} disabled={cmpLoadingA || !cmpOriginA || !cmpDestA}>
            {#if cmpLoadingA}<span class="spinner"></span>{:else}Calcular{/if}
          </button>
        </div>
        {#if cmpErrorA}<p class="error">{cmpErrorA}</p>{/if}
        {#if cmpRouteA}
          <div class="cmp-stats">
            <div class="cmp-stat"><span>Distancia</span><strong>{fmtKm(cmpRouteA.distanceKm)}</strong></div>
            <div class="cmp-stat"><span>Tiempo</span><strong>{cmpRouteA.durationText}</strong></div>
            <div class="cmp-stat"><span>Combustible</span><strong>{fmtL(cmpLitresA)}</strong></div>
            <div class="cmp-stat accent"><span>Costo</span><strong>{fmtCLP(cmpCostA)}</strong></div>
          </div>
        {/if}
      </div>
      <div class="cmp-map" bind:this={cmpContainerA}></div>
    </div>

    <!-- Route B -->
    <div class="cmp-side">
      <div class="cmp-form">
        <p class="cmp-label" style="color: #059669;">Ruta B</p>
        <div class="cmp-fields">
          <input type="text" placeholder="Origen B" bind:value={cmpOriginB} onkeydown={handleCmpKeydown('B')} />
          <input type="text" placeholder="Destino B" bind:value={cmpDestB} onkeydown={handleCmpKeydown('B')} />
          <button class="btn-add cmp-btn" onclick={() => calcCmpRoute('B')} disabled={cmpLoadingB || !cmpOriginB || !cmpDestB}>
            {#if cmpLoadingB}<span class="spinner"></span>{:else}Calcular{/if}
          </button>
        </div>
        {#if cmpErrorB}<p class="error">{cmpErrorB}</p>{/if}
        {#if cmpRouteB}
          <div class="cmp-stats">
            <div class="cmp-stat"><span>Distancia</span><strong>{fmtKm(cmpRouteB.distanceKm)}</strong></div>
            <div class="cmp-stat"><span>Tiempo</span><strong>{cmpRouteB.durationText}</strong></div>
            <div class="cmp-stat"><span>Combustible</span><strong>{fmtL(cmpLitresB)}</strong></div>
            <div class="cmp-stat accent"><span>Costo</span><strong>{fmtCLP(cmpCostB)}</strong></div>
          </div>
        {/if}
      </div>
      <div class="cmp-map" bind:this={cmpContainerB}></div>
    </div>

    <!-- Comparison summary bar -->
    {#if cmpRouteA && cmpRouteB}
      {@const diff = cmpCostA - cmpCostB}
      {@const cheaper = diff > 0 ? 'B' : diff < 0 ? 'A' : null}
      <div class="cmp-summary">
        <span class="cmp-summary-label">
          {#if cheaper}
            Ruta {cheaper} es más económica por <strong>{fmtCLP(Math.abs(diff))}</strong>
            ({fmtL(Math.abs(cmpLitresA - cmpLitresB))} menos)
          {:else}
            Ambas rutas tienen el mismo costo
          {/if}
        </span>
      </div>
    {/if}
  </div>
  {:else}
  <div class="body">
    <aside
      class="panel"
      data-state={sheetState}
      class:dragging={dragHeight !== null}
      style={dragHeight !== null ? `height: ${dragHeight}px` : ''}
      bind:this={sheetEl}
    >

      <!-- Mobile-only drag handle. Drag up/down to resize the sheet. -->
      <div
        class="sheet-handle"
        role="slider"
        tabindex="0"
        aria-label="Ajustar panel"
        aria-valuemin="0"
        aria-valuemax="2"
        aria-valuenow={sheetState === 'hidden' ? 0 : sheetState === 'compact' ? 1 : 2}
        onpointerdown={onHandlePointerDown}
        onpointermove={onHandlePointerMove}
        onpointerup={onHandlePointerUp}
        onpointercancel={onHandlePointerUp}
      >
        <span class="handle-bar"></span>
      </div>

      <!-- Compact summary card: shown on mobile once trips exist and the
           sheet is collapsed. Drag up for the full form/list/controls. -->
      {#if trips.length > 0}
        <div class="route-card">
          <p class="card-route">{trips.length} viaje{trips.length !== 1 ? 's' : ''} · {fmtKm(totalDistanceKm)}</p>
          <div class="card-fuel">
            <span class="card-fuel-value">{fmtL(totalLitres)}</span>
            <span class="card-fuel-label">· {fmtCLP(totalCost)}</span>
          </div>
          <button class="card-play" onclick={vizState === 'playing' ? pauseViz : playViz}>
            {#if vizState === 'playing'}
              ⏸ Pausar
            {:else if vizState === 'done'}
              ↺ Repetir
            {:else}
              ▶ Reproducir
            {/if}
          </button>
        </div>
      {/if}

      <!-- Mobile-only action row. Desktop shows these same actions in the page header. -->
      {#if trips.length > 0}
        <div class="mobile-actions">
          <button class="btn-compare" onclick={enterCompare}>Comparar</button>
          <button class="btn-pdf" onclick={generatePDF} disabled={pdfLoading}>
            {#if pdfLoading}
              <span class="spinner-sm"></span> Generando…
            {:else}
              <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
              PDF
            {/if}
          </button>
          <button class="btn-clear" onclick={clearAll}>Limpiar</button>
        </div>
      {/if}

      <!-- Parámetros -->
      <section class="section section-params">
        <p class="section-title">Parámetros de combustible</p>
        <label class="field">
          <span>Consumo <em>(L / 100 km)</em></span>
          <input type="number" min="0.1" step="0.1" bind:value={consumptionPer100km} />
        </label>
        {#if consumptionPer100km > 0}
          <p class="hint">= {fmtRatio(kmPerLitre)}</p>
        {/if}
        <label class="field">
          <span>Precio combustible <em>(CLP / L)</em></span>
          <input type="number" min="1" step="1" bind:value={fuelPriceCLP} />
        </label>
      </section>

      <!-- Nuevo viaje -->
      <section class="section section-new-trip">
        <p class="section-title">Nuevo viaje</p>
        <label class="field">
          <span>Desde</span>
          <input type="text" placeholder="Dirección de origen" bind:value={originInput} onkeydown={handleKeydown} />
        </label>
        {@render placeChips((a) => originInput = a)}
        <label class="field">
          <span>Hasta</span>
          <input type="text" placeholder="Dirección de destino" bind:value={destinationInput} onkeydown={handleKeydown} />
        </label>
        {@render placeChips((a) => destinationInput = a)}
        <button class="btn-add" onclick={addTrip} disabled={loading || !originInput || !destinationInput}>
          {#if loading}
            <span class="spinner"></span> Calculando…
          {:else}
            + Agregar viaje
          {/if}
        </button>
        {#if formError}<p class="error">{formError}</p>{/if}
      </section>

      <!-- Lugares guardados -->
      <section class="section section-places">
        <div class="section-head">
          <p class="section-title">Lugares guardados</p>
          <button class="btn-mini" onclick={() => showPlaceForm = !showPlaceForm}>
            {showPlaceForm ? 'Cancelar' : '+ Nuevo'}
          </button>
        </div>

        {#if showPlaceForm}
          <div class="place-form">
            <input type="text" placeholder="Nombre (Casa, Colegio, Jardín…)" bind:value={newPlaceLabel} />
            <input
              type="text"
              placeholder="Dirección"
              bind:value={newPlaceAddress}
              onkeydown={(e) => e.key === 'Enter' && addPlace()}
            />
            <button class="btn-add" onclick={addPlace} disabled={!newPlaceLabel || !newPlaceAddress}>
              Guardar lugar
            </button>
          </div>
        {/if}

        {#if savedPlaces.length > 0}
          <ul class="saved-list">
            {#each savedPlaces as place (place.id)}
              <li class="saved-item">
                <span class="saved-icon">📍</span>
                <div class="saved-text">
                  <span class="saved-label">{place.label}</span>
                  <span class="saved-address">{place.address}</span>
                </div>
                <button class="btn-remove" onclick={() => removePlace(place.id)} aria-label="Eliminar lugar">×</button>
              </li>
            {/each}
          </ul>
        {:else if !showPlaceForm}
          <p class="places-hint">Guarda lugares frecuentes (casa, colegio, jardín…) para reutilizarlos al crear viajes.</p>
        {/if}
      </section>

      <!-- Lista de viajes -->
      {#if tripsWithCost.length > 0}
        <section class="section">
          <p class="section-title">Viajes del día</p>
          <ul class="trip-list">
            {#each tripsWithCost as trip, i (trip.id)}
              <li class="trip-item">
                <span class="trip-dot" style="background: {trip.color}"></span>
                <div class="trip-body">
                  {#if editingId === trip.id}
                    <div class="trip-edit">
                      <span class="trip-name">Editar viaje {i + 1}</span>
                      <input
                        type="text"
                        placeholder="Desde"
                        bind:value={editOrigin}
                        onkeydown={(e) => e.key === 'Enter' && saveEdit(trip.id)}
                      />
                      {@render placeChips((a) => editOrigin = a)}
                      <input
                        type="text"
                        placeholder="Hasta"
                        bind:value={editDest}
                        onkeydown={(e) => e.key === 'Enter' && saveEdit(trip.id)}
                      />
                      {@render placeChips((a) => editDest = a)}
                      <div class="trip-edit-actions">
                        <button
                          class="btn-save-edit"
                          onclick={() => saveEdit(trip.id)}
                          disabled={editLoading || !editOrigin || !editDest}
                        >
                          {#if editLoading}<span class="spinner"></span> Guardando…{:else}Guardar{/if}
                        </button>
                        <button class="btn-cancel-edit" onclick={cancelEdit}>Cancelar</button>
                      </div>
                      {#if editError}<p class="error">{editError}</p>{/if}
                    </div>
                  {:else}
                    <div class="trip-header-row">
                      <span class="trip-name">Viaje {i + 1}</span>
                      <span class="trip-cost">{fmtCLP(trip.cost)}</span>
                      <button class="btn-edit" onclick={() => startEdit(trip)} aria-label="Editar viaje">✎</button>
                      <button class="btn-remove" onclick={() => removeTrip(trip.id)} aria-label="Eliminar viaje">×</button>
                    </div>
                    <span class="trip-route">{trip.origin} → {trip.destination}</span>
                    <span class="trip-meta">{fmtKm(trip.distanceKm)} · {trip.durationText} · {fmtL(trip.litres)}</span>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      <!-- Total -->
      {#if tripsWithCost.length > 0}
        <section class="section total-section">
          <p class="section-title">Total del día</p>
          <div class="result-row"><span>Distancia recorrida</span><strong>{fmtKm(totalDistanceKm)}</strong></div>
          <div class="result-row"><span>Combustible usado</span><strong>{fmtL(totalLitres)}</strong></div>
          <div class="result-row grand-total"><span>Gasto total</span><strong>{fmtCLP(totalCost)}</strong></div>
        </section>
      {/if}

      <!-- Visualización -->
      {#if trips.length > 0}
        <section class="section">
          <p class="section-title">Visualizar recorrido</p>

          <div class="play-row">
            {#if vizState === 'playing'}
              <button class="btn-play" onclick={pauseViz}>⏸ Pausar</button>
            {:else}
              <button class="btn-play" onclick={playViz}>
                {vizState === 'done' ? '↺ Repetir' : '▶ Reproducir'}
              </button>
            {/if}
            {#if vizState !== 'idle'}
              <button class="btn-reset-viz" onclick={resetViz} title="Reiniciar">↺</button>
            {/if}
          </div>

          <div class="speed-row">
            <span class="speed-label">Velocidad sim.</span>
            <div class="speed-opts">
              {#each SPEED_OPTS as opt (opt)}
                <button class="speed-btn" class:active={vizSpeedMult === opt} onclick={() => vizSpeedMult = opt}>{opt}×</button>
              {/each}
            </div>
          </div>

          {#if showHud}
            <div class="panel-progress">
              <div class="panel-progress-fill" style="width: {vizDistPct}%"></div>
            </div>
            <p class="progress-label">{vizTripLabel} · {vizDistPct.toFixed(1)}%</p>
          {/if}
        </section>
      {/if}

    </aside>

    <!-- Mapa + HUD -->
    <div class="map-wrap">
      <div bind:this={container} class="map"></div>

      {#if showHud}
        <div class="hud">
          <div class="hud-speed-row">
            <div class="hud-speed-num">{vizSpeed}</div>
            <div class="hud-speed-meta">
              <span class="hud-speed-unit">km/h</span>
              {#if vizState === 'done'}
                <span class="hud-badge done">✓ Completado</span>
              {:else if vizState === 'paused'}
                <span class="hud-badge paused">⏸ Pausado</span>
              {:else}
                <span class="hud-badge trip">{vizTripLabel}</span>
              {/if}
            </div>
          </div>

          <div class="hud-sep"></div>

          <div class="hud-stat">
            <div class="hud-stat-header">
              <span class="hud-stat-label">Combustible</span>
              <span class="hud-stat-vals"><strong>{fmtL(vizLitres)}</strong><span class="hud-of">/ {fmtL(totalLitres)}</span></span>
            </div>
            <div class="hud-bar"><div class="hud-bar-fill fuel" style="width: {vizFuelPct}%"></div></div>
          </div>

          <div class="hud-stat">
            <div class="hud-stat-header">
              <span class="hud-stat-label">Distancia</span>
              <span class="hud-stat-vals"><strong>{fmtKm(vizDistKm)}</strong><span class="hud-of">/ {fmtKm(totalDistanceKm)}</span></span>
            </div>
            <div class="hud-bar"><div class="hud-bar-fill dist" style="width: {vizDistPct}%"></div></div>
          </div>

          <div class="hud-sep"></div>

          <div class="hud-cost">
            <span class="hud-cost-label">Gasto acumulado</span>
            <span class="hud-cost-val">{fmtCLP(vizCost)}</span>
            <span class="hud-cost-total">de {fmtCLP(totalCost)} estimado</span>
          </div>
        </div>
      {/if}
    </div>
  </div>
  {/if}
</div>

<style>
  .experiment { display: flex; flex-direction: column; height: 100%; }

  header {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    padding: .875rem 1.25rem; background: var(--surface); border-bottom: 1px solid var(--border); flex-shrink: 0;
    transition: background 0.2s, border-color 0.2s;
  }
  h2 { margin: 0 0 .125rem; font-size: 1rem; font-weight: 600; color: var(--text); }
  header > div > p { margin: 0; font-size: .8125rem; color: var(--text-3); }

  .header-actions { display: flex; align-items: center; gap: .5rem; }

  .btn-pdf {
    display: flex; align-items: center; gap: .375rem;
    padding: .375rem .875rem; background: var(--accent); color: #fff;
    border: none; border-radius: .5rem; font-size: .8125rem; font-weight: 500;
    cursor: pointer; white-space: nowrap; transition: background .15s;
  }
  .btn-pdf:hover:not(:disabled) { background: var(--accent-h); }
  .btn-pdf:disabled { opacity: .6; cursor: not-allowed; }
  .btn-pdf svg { width: 14px; height: 14px; }

  .btn-clear {
    padding: .375rem .875rem; background: var(--danger-bg); color: var(--danger);
    border: none; border-radius: .5rem; font-size: .8125rem; font-weight: 500; cursor: pointer; white-space: nowrap;
  }
  .btn-clear:hover { background: var(--danger-h); }

  .body { flex: 1; display: flex; overflow: hidden; }

  .panel {
    width: 300px; flex-shrink: 0; border-right: 1px solid var(--border);
    background: var(--surface); overflow-y: auto; display: flex; flex-direction: column;
    transition: background 0.2s, border-color 0.2s;
  }

  /* Mobile-only drag handle + card + action row — hidden on desktop. */
  .sheet-handle  { display: none; }
  .mobile-actions { display: none; }
  .route-card    { display: none; }

  .section {
    padding: 1rem; border-bottom: 1px solid var(--border-2);
    display: flex; flex-direction: column; gap: .625rem;
  }
  .section-title {
    margin: 0; font-size: .6875rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: .06em; color: var(--text-4);
  }

  .field { display: flex; flex-direction: column; gap: .25rem; }
  .field span { font-size: .75rem; font-weight: 500; color: var(--text-2); }
  .field em { font-style: normal; color: var(--text-4); font-weight: 400; }
  .field input {
    width: 100%; padding: .4375rem .625rem; border: 1px solid var(--input-border); border-radius: .5rem;
    font-size: .875rem; color: var(--text); background: var(--input-bg); outline: none;
    transition: border-color .15s, background .15s;
  }
  .field input:focus { border-color: var(--accent); background: var(--surface); }

  .hint { margin: -.25rem 0 0; font-size: .75rem; color: var(--text-3); text-align: right; }

  .btn-add {
    display: flex; align-items: center; justify-content: center; gap: .5rem;
    width: 100%; padding: .5rem; background: var(--accent); color: #fff;
    border: none; border-radius: .5rem; font-size: .875rem; font-weight: 500;
    cursor: pointer; transition: background .15s;
  }
  .btn-add:hover:not(:disabled) { background: var(--accent-h); }
  .btn-add:disabled { opacity: .5; cursor: not-allowed; }

  .spinner, .spinner-sm { border-radius: 50%; animation: spin .7s linear infinite; display: inline-block; }
  .spinner    { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.4); border-top-color: #fff; }
  .spinner-sm { width: 12px; height: 12px; border: 2px solid rgba(255,255,255,.4); border-top-color: #fff; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .error {
    margin: 0; font-size: .75rem; color: var(--danger); background: var(--danger-bg);
    padding: .5rem .625rem; border-radius: .375rem; line-height: 1.5;
  }

  .trip-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .trip-item {
    display: flex; align-items: flex-start; gap: .625rem;
    padding: .625rem; background: var(--subtle); border-radius: .5rem; border: 1px solid var(--border-2);
  }
  .trip-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; margin-top: 3px; }
  .trip-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .trip-header-row { display: flex; align-items: center; gap: .5rem; }
  .trip-name { font-size: .8125rem; font-weight: 600; color: var(--text); }
  .trip-cost { flex: 1; text-align: right; font-size: .8125rem; font-weight: 600; font-family: 'SF Mono','Fira Code',monospace; color: var(--accent-text); }
  .btn-remove { background: none; border: none; cursor: pointer; color: var(--text-4); font-size: 1rem; line-height: 1; padding: 0 2px; border-radius: .25rem; flex-shrink: 0; }
  .btn-remove:hover { color: var(--danger); background: var(--danger-bg); }
  .trip-route { font-size: .75rem; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .trip-meta  { font-size: .6875rem; color: var(--text-4); }

  .btn-edit {
    background: none; border: none; cursor: pointer; color: var(--text-4);
    font-size: .8125rem; line-height: 1; padding: 0 2px; border-radius: .25rem; flex-shrink: 0;
  }
  .btn-edit:hover { color: var(--accent-text); background: var(--accent-bg); }

  /* Inline trip editor */
  .trip-edit { display: flex; flex-direction: column; gap: .375rem; }
  .trip-edit input {
    width: 100%; padding: .375rem .5rem; border: 1px solid var(--input-border); border-radius: .375rem;
    font-size: .8125rem; color: var(--text); background: var(--input-bg); outline: none; transition: border-color .15s;
  }
  .trip-edit input:focus { border-color: var(--accent); }
  .trip-edit-actions { display: flex; gap: .375rem; margin-top: .125rem; }
  .btn-save-edit {
    flex: 1; display: flex; align-items: center; justify-content: center; gap: .375rem;
    padding: .375rem; background: var(--accent); color: #fff; border: none; border-radius: .375rem;
    font-size: .8125rem; font-weight: 500; cursor: pointer; transition: background .15s;
  }
  .btn-save-edit:hover:not(:disabled) { background: var(--accent-h); }
  .btn-save-edit:disabled { opacity: .5; cursor: not-allowed; }
  .btn-cancel-edit {
    padding: .375rem .75rem; background: var(--hover); color: var(--text-3);
    border: none; border-radius: .375rem; font-size: .8125rem; cursor: pointer;
  }
  .btn-cancel-edit:hover { background: var(--border); }

  /* Quick-pick chips for saved places */
  .place-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: -.25rem; }
  .place-chip {
    padding: .25rem .5rem; background: var(--subtle); color: var(--text-2);
    border: 1px solid var(--border-2); border-radius: 999px; font-size: .6875rem; font-weight: 500;
    cursor: pointer; white-space: nowrap; transition: all .1s;
  }
  .place-chip:hover { background: var(--accent-bg); color: var(--accent-text); border-color: var(--accent-border); }

  /* Saved places section */
  .section-head { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
  .btn-mini {
    padding: .1875rem .5rem; background: var(--hover); color: var(--text-3);
    border: 1px solid var(--border); border-radius: .375rem; font-size: .6875rem; font-weight: 500; cursor: pointer; transition: all .1s;
  }
  .btn-mini:hover { background: var(--border); color: var(--text-2); }

  .place-form { display: flex; flex-direction: column; gap: .375rem; }
  .place-form input {
    width: 100%; padding: .4375rem .625rem; border: 1px solid var(--input-border); border-radius: .5rem;
    font-size: .875rem; color: var(--text); background: var(--input-bg); outline: none; transition: border-color .15s;
  }
  .place-form input:focus { border-color: var(--accent); }

  .saved-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .saved-item {
    display: flex; align-items: center; gap: .5rem;
    padding: .4375rem .5rem; background: var(--subtle); border: 1px solid var(--border-2); border-radius: .5rem;
  }
  .saved-icon { font-size: .8125rem; flex-shrink: 0; }
  .saved-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .saved-label { font-size: .8125rem; font-weight: 600; color: var(--text); }
  .saved-address { font-size: .6875rem; color: var(--text-4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .places-hint { margin: 0; font-size: .75rem; color: var(--text-4); line-height: 1.5; }

  .total-section { background: var(--subtle); }
  .result-row { display: flex; justify-content: space-between; align-items: baseline; font-size: .875rem; color: var(--text-2); }
  .result-row strong { font-weight: 600; color: var(--text); font-family: 'SF Mono','Fira Code',monospace; font-size: .8125rem; }
  .grand-total { margin-top: .25rem; padding-top: .625rem; border-top: 1px solid var(--border); font-size: .9375rem; font-weight: 600; }
  .grand-total strong { font-size: 1rem; color: var(--accent-text); }

  /* Viz controls */
  .play-row { display: flex; gap: .5rem; }
  .btn-play {
    flex: 1; padding: .5625rem; background: var(--accent); color: #fff;
    border: none; border-radius: .5rem; font-size: .875rem; font-weight: 500; cursor: pointer; transition: background .15s;
  }
  .btn-play:hover { background: var(--accent-h); }
  .btn-reset-viz {
    padding: .5rem .75rem; background: var(--hover); color: var(--text-3);
    border: none; border-radius: .5rem; font-size: 1rem; cursor: pointer; line-height: 1;
  }
  .btn-reset-viz:hover { background: var(--border); }

  .speed-row { display: flex; align-items: center; gap: .5rem; }
  .speed-label { font-size: .75rem; font-weight: 500; color: var(--text-3); white-space: nowrap; }
  .speed-opts { display: flex; gap: 3px; }
  .speed-btn {
    padding: .25rem .5rem; background: var(--hover); color: var(--text-3);
    border: 1px solid var(--border); border-radius: .375rem; font-size: .75rem; cursor: pointer; transition: all .1s;
  }
  .speed-btn:hover { background: var(--border); }
  .speed-btn.active { background: var(--accent-bg); color: var(--accent-text); border-color: var(--accent-border); font-weight: 600; }

  .panel-progress { height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; }
  .panel-progress-fill { height: 100%; background: var(--accent); border-radius: 2px; transition: width .08s linear; }
  .progress-label { margin: 0; font-size: .6875rem; color: var(--text-4); text-align: right; }

  /* Map + HUD */
  .map-wrap { flex: 1; overflow: hidden; position: relative; }
  .map { width: 100%; height: 100%; }

  .hud {
    position: absolute; bottom: 24px; right: 20px;
    background: rgba(15, 23, 42, 0.92); backdrop-filter: blur(10px);
    border-radius: 1.125rem; padding: 1.125rem 1.25rem; min-width: 230px;
    display: flex; flex-direction: column; gap: .875rem;
    box-shadow: 0 8px 32px rgba(0,0,0,.35);
    border: 1px solid rgba(255,255,255,.07); color: #fff;
  }

  .hud-speed-row { display: flex; align-items: flex-end; gap: .5rem; }
  .hud-speed-num {
    font-size: 3rem; font-weight: 800; line-height: 1;
    font-family: 'SF Mono','Fira Code',monospace; color: #a5b4fc; letter-spacing: -.02em;
  }
  .hud-speed-meta { display: flex; flex-direction: column; gap: 4px; padding-bottom: 4px; }
  .hud-speed-unit { font-size: .8125rem; color: #94a3b8; font-weight: 500; }

  .hud-badge {
    font-size: .6875rem; font-weight: 600; padding: 2px 6px; border-radius: 999px;
  }
  .hud-badge.done   { color: #34d399; background: rgba(52,211,153,.12); }
  .hud-badge.paused { color: #fbbf24; background: rgba(251,191,36,.12); }
  .hud-badge.trip   { color: #94a3b8; background: rgba(148,163,184,.12); }

  .hud-sep { height: 1px; background: rgba(255,255,255,.08); }

  .hud-stat { display: flex; flex-direction: column; gap: 5px; }
  .hud-stat-header { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; }
  .hud-stat-label { font-size: .6875rem; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: #64748b; }
  .hud-stat-vals { display: flex; align-items: baseline; gap: .25rem; }
  .hud-stat-vals strong { font-size: .875rem; font-weight: 700; font-family: 'SF Mono','Fira Code',monospace; color: #e2e8f0; }
  .hud-of { font-size: .75rem; color: #475569; }

  .hud-bar { height: 5px; background: rgba(255,255,255,.1); border-radius: 3px; overflow: hidden; }
  .hud-bar-fill { height: 100%; border-radius: 3px; transition: width .08s linear; }
  .hud-bar-fill.fuel { background: linear-gradient(90deg, #818cf8, #6366f1); }
  .hud-bar-fill.dist { background: linear-gradient(90deg, #34d399, #10b981); }

  .hud-cost { display: flex; flex-direction: column; gap: 3px; }
  .hud-cost-label { font-size: .6875rem; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: #64748b; }
  .hud-cost-val { font-size: 1.5rem; font-weight: 800; line-height: 1.1; font-family: 'SF Mono','Fira Code',monospace; color: #818cf8; }
  .hud-cost-total { font-size: .6875rem; color: #475569; }

  /* ── Compare button ── */
  .btn-compare {
    display: flex; align-items: center; gap: .375rem;
    padding: .375rem .875rem; background: var(--surface); color: var(--accent-text);
    border: 1px solid var(--accent-border); border-radius: .5rem;
    font-size: .8125rem; font-weight: 500; cursor: pointer;
    white-space: nowrap; transition: background .15s;
  }
  .btn-compare:hover { background: var(--accent-bg); }
  .btn-compare svg { width: 14px; height: 14px; }

  /* ── Compare mode ── */
  .compare-body {
    flex: 1; display: flex; overflow: hidden; position: relative;
  }
  .cmp-side {
    flex: 1; display: flex; flex-direction: column;
    min-width: 0;
  }
  .cmp-side + .cmp-side { border-left: 2px solid var(--border); }

  .cmp-form {
    padding: .75rem 1rem;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    display: flex; flex-direction: column; gap: .5rem;
    flex-shrink: 0;
  }
  .cmp-label {
    margin: 0; font-size: .75rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: .06em;
  }
  .cmp-fields {
    display: flex; gap: .375rem; align-items: center;
  }
  .cmp-fields input {
    flex: 1; min-width: 0;
    padding: .375rem .5rem;
    border: 1px solid var(--input-border); border-radius: .375rem;
    font-size: .8125rem; color: var(--text); background: var(--input-bg);
    outline: none;
  }
  .cmp-fields input:focus { border-color: var(--accent); }
  .cmp-btn {
    width: auto !important; padding: .375rem .75rem !important;
    font-size: .75rem !important; white-space: nowrap; flex-shrink: 0;
  }

  .cmp-stats {
    display: flex; gap: .5rem; flex-wrap: wrap;
  }
  .cmp-stat {
    flex: 1; min-width: 80px;
    background: var(--subtle); padding: .375rem .5rem; border-radius: .375rem;
    display: flex; flex-direction: column; gap: 1px;
  }
  .cmp-stat span {
    font-size: .625rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: .04em; color: var(--text-4);
  }
  .cmp-stat strong {
    font-size: .8125rem; font-weight: 700; color: var(--text);
    font-family: 'SF Mono', 'Fira Code', monospace;
  }
  .cmp-stat.accent strong { color: var(--accent-text); }

  .cmp-map { flex: 1; min-height: 200px; }

  .cmp-summary {
    position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
    background: rgba(15, 23, 42, 0.92); backdrop-filter: blur(10px);
    color: #fff; padding: .625rem 1.25rem; border-radius: .75rem;
    font-size: .8125rem; white-space: nowrap;
    box-shadow: 0 4px 20px rgba(0,0,0,.3);
    border: 1px solid rgba(255,255,255,.07);
    z-index: 5;
  }
  .cmp-summary strong {
    color: #a5b4fc; font-family: 'SF Mono', 'Fira Code', monospace;
  }

  /* ── Optimizar ruta ── */
  .optimize-body { flex: 1; display: flex; overflow: hidden; }
  .opt-panel {
    width: 320px; flex-shrink: 0; border-right: 1px solid var(--border);
    background: var(--surface); overflow-y: auto; display: flex; flex-direction: column;
    transition: background 0.2s, border-color 0.2s;
  }
  .opt-map { flex: 1; min-width: 0; }

  .opt-intro { display: flex; align-items: flex-start; gap: .5rem; padding: 1rem 1rem .75rem; border-bottom: 1px solid var(--border-2); }
  .opt-intro-text { flex: 1; min-width: 0; }
  .opt-intro-title { margin: 0 0 .125rem; font-size: .875rem; font-weight: 600; color: var(--text); }
  .opt-intro-sub { margin: 0; font-size: .75rem; color: var(--text-3); line-height: 1.5; }
  .opt-exit-mobile {
    display: none; flex-shrink: 0; width: 28px; height: 28px; align-items: center; justify-content: center;
    background: var(--hover); border: 1px solid var(--border); border-radius: .5rem;
    color: var(--text-3); font-size: 1.125rem; line-height: 1; cursor: pointer;
  }

  .opt-stops { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .opt-stop {
    display: flex; align-items: center; gap: .5rem;
    padding: .375rem .5rem; background: var(--subtle); border: 1px solid var(--border-2); border-radius: .5rem;
  }
  .opt-stop-num {
    flex-shrink: 0; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center;
    background: var(--accent-bg); color: var(--accent-text); border-radius: 50%;
    font-size: .6875rem; font-weight: 700;
  }
  .opt-stop-addr { flex: 1; min-width: 0; font-size: .8125rem; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .opt-add-row { display: flex; gap: .375rem; }
  .opt-add-row input {
    flex: 1; min-width: 0; padding: .4375rem .625rem; border: 1px solid var(--input-border); border-radius: .5rem;
    font-size: .875rem; color: var(--text); background: var(--input-bg); outline: none; transition: border-color .15s;
  }
  .opt-add-row input:focus { border-color: var(--accent); }
  .opt-add-btn { width: auto !important; flex-shrink: 0; padding: 0 .875rem !important; font-size: 1.125rem !important; }

  .btn-seed {
    margin-top: .125rem; padding: .375rem .625rem; background: var(--hover); color: var(--text-2);
    border: 1px solid var(--border); border-radius: .5rem; font-size: .75rem; font-weight: 500;
    cursor: pointer; transition: all .1s;
  }
  .btn-seed:hover { background: var(--border); color: var(--text); }

  .opt-radio { display: flex; align-items: center; gap: .5rem; font-size: .8125rem; color: var(--text-2); cursor: pointer; }
  .opt-radio input { accent-color: var(--accent); cursor: pointer; }
  .opt-end-input {
    width: 100%; padding: .4375rem .625rem; border: 1px solid var(--input-border); border-radius: .5rem;
    font-size: .875rem; color: var(--text); background: var(--input-bg); outline: none; transition: border-color .15s;
  }
  .opt-end-input:focus { border-color: var(--accent); }

  .opt-order { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .opt-order-item { display: flex; align-items: center; gap: .625rem; }
  .opt-order-badge {
    flex-shrink: 0; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
    background: var(--accent); color: #fff; border-radius: 50%; font-size: .6875rem; font-weight: 700;
  }
  .opt-order-badge.start { background: #059669; }
  .opt-order-badge.end   { background: #dc2626; }
  .opt-order-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .opt-order-label { font-size: .75rem; font-weight: 600; color: var(--text-3); }
  .opt-order-addr  { font-size: .8125rem; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .opt-savings {
    margin-top: .25rem; padding: .5rem .625rem; border-radius: .5rem; line-height: 1.5;
    font-size: .75rem; color: var(--accent-text); background: var(--accent-bg);
  }
  .opt-savings strong { font-weight: 700; }
  .opt-savings.neutral { color: var(--text-3); background: var(--subtle); }

  /* ── Mobile (iPhone 16 Pro: 402px, Pro Max: 440px) ───────────────────── */
  @media (max-width: 768px) {
    header { display: none; }

    .body { position: relative; }

    .map-wrap { position: absolute; inset: 0; }

    /* ── Bottom sheet ─────────────────────────────────────── */
    .panel {
      position: absolute;
      left: 0; right: 0; bottom: 0;
      width: 100%;
      border-right: none;
      border-top: 1px solid var(--border);
      border-radius: 1rem 1rem 0 0;
      box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.14);
      overflow: hidden;
      transition: height 0.25s ease, background 0.2s, border-color 0.2s;
      z-index: 10;
      overscroll-behavior: contain;
    }
    .panel[data-state="hidden"]  { height: 36px; }
    .panel[data-state="compact"] { height: auto; max-height: 240px; }
    .panel[data-state="full"]    { height: 80vh; overflow-y: auto; }
    .panel.dragging { transition: none; overflow: hidden; }

    /* Drag handle */
    .sheet-handle {
      display: flex;
      justify-content: center;
      align-items: center;
      width: 100%;
      min-height: 28px;
      padding: 0.625rem 0 0.375rem;
      background: var(--surface);
      border: none;
      cursor: grab;
      position: sticky;
      top: 0;
      z-index: 3;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      order: -3;
    }
    .sheet-handle:active { cursor: grabbing; }
    .handle-bar {
      width: 36px;
      height: 4px;
      border-radius: 2px;
      background: var(--border);
    }

    /* ── Compact card (route + fuel only) ──────────────────── */
    .route-card {
      display: flex;
      flex-direction: column;
      gap: 0.625rem;
      padding: 0 1rem 0.875rem;
    }
    .panel[data-state="full"] .route-card { display: none; }

    .card-route {
      margin: 0;
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .card-fuel {
      display: flex;
      align-items: baseline;
      gap: 0.375rem;
    }
    .card-fuel-value {
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 1.125rem;
      font-weight: 700;
      color: var(--text);
    }
    .card-fuel-label {
      font-size: 0.75rem;
      color: var(--text-3);
    }

    .card-play {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.375rem;
      width: 100%;
      padding: 0.625rem;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 0.5rem;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
    }
    .card-play:hover { background: var(--accent-h); }

    /* Mobile action row (PDF + Clear) — shown only in full view. */
    .mobile-actions {
      display: flex;
      gap: 0.5rem;
      padding: 0.25rem 1rem 0.5rem;
      order: -1;
    }
    .mobile-actions .btn-pdf,
    .mobile-actions .btn-clear {
      flex: 1;
      justify-content: center;
    }

    .section-new-trip { order: -2; }

    .section { padding: 0.75rem 1rem; }

    /* ── Compact-mode visibility ───────────────────────────── */
    .panel[data-state="compact"] .section,
    .panel[data-state="compact"] .mobile-actions {
      display: none;
    }
    .panel[data-state="compact"]:not(:has(.route-card)) .section-new-trip {
      display: flex;
    }

    /* ── HUD: compact data-only chip at top-right ─────────── */
    .hud {
      position: absolute;
      top: 12px;
      right: 12px;
      left: auto;
      bottom: auto;
      padding: 0.5rem 0.75rem;
      border-radius: 0.75rem;
      min-width: 0;
      gap: 0.25rem;
    }

    .hud-speed-row { gap: 0.25rem; }
    .hud-speed-num { font-size: 1.5rem; }
    .hud-speed-meta { padding-bottom: 0; gap: 2px; }
    .hud-speed-unit { font-size: 0.625rem; }
    .hud-badge { font-size: 0.5625rem; }

    .hud-sep  { display: none; }
    .hud-bar  { display: none; }
    .hud-of   { display: none; }

    .hud-stat { gap: 0; }
    .hud-stat-label { display: none; }
    .hud-stat-vals strong { font-size: 0.6875rem; }

    .hud-cost { flex-direction: column; gap: 0; }
    .hud-cost-label { display: none; }
    .hud-cost-val { font-size: 0.875rem; }
    .hud-cost-total { display: none; }

    /* Compare mode: stack vertically on mobile */
    .compare-body { flex-direction: column; }
    .cmp-side + .cmp-side { border-left: none; border-top: 2px solid var(--border); }
    .cmp-fields { flex-wrap: wrap; }
    .cmp-fields input { font-size: 16px !important; }
    .cmp-summary {
      bottom: 8px; font-size: .75rem;
      padding: .5rem .75rem;
      white-space: normal; text-align: center;
      max-width: 90vw;
    }
    .btn-compare { font-size: .75rem; padding: .25rem .5rem; }

    /* Optimizer: stack panel over map, expose mobile exit button */
    .optimize-body { flex-direction: column; }
    .opt-panel { width: 100%; max-height: 58%; border-right: none; border-bottom: 1px solid var(--border); }
    .opt-map { min-height: 42vh; }
    .opt-exit-mobile { display: flex; }
    .opt-add-row input, .opt-end-input { font-size: 16px; }
  }
</style>
