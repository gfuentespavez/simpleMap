<script>
  import { onMount, onDestroy } from 'svelte';
  import { loader } from '$lib/mapLoader.js';
  import { PUBLIC_GOOGLE_MAP_ID, PUBLIC_GOOGLE_MAPS_API_KEY } from '$env/static/public';
  import { theme } from '$lib/theme.svelte.js';

  // ── Parámetros ────────────────────────────────────────────────────────────
  let consumptionPer100km = $state(10);
  let fuelPriceCLP        = $state(1200);
  let kmPerLitre = $derived(consumptionPer100km > 0 ? 100 / consumptionPer100km : 0);

  // ── Formulario nuevo viaje ────────────────────────────────────────────────
  let originInput      = $state('');
  let destinationInput = $state('');
  let loading   = $state(false);
  let formError = $state('');

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
  async function addTrip() {
    if (!originInput.trim() || !destinationInput.trim()) return;
    loading = true;
    formError = '';

    try {
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
          origin: { address: originInput.trim() },
          destination: { address: destinationInput.trim() },
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
      const { Polyline }  = await loader.importLibrary('maps');

      const path     = encoding.decodePath(route.polyline.encodedPolyline);
      const color    = COLORS[trips.length % COLORS.length];
      const polyline = new Polyline({ path, strokeColor: color, strokeWeight: 5, strokeOpacity: 0.85, map });
      const timeline = buildTimeline(steps, encoding);

      trips = [
        ...trips,
        {
          id: Date.now(),
          origin: originInput.trim(),
          destination: destinationInput.trim(),
          distanceKm: route.distanceMeters / 1000,
          durationText: parseDuration(route.duration),
          encodedPolyline: route.polyline.encodedPolyline,
          path,
          polyline,
          color,
          timeline,
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
</script>

<div class="experiment">
  <header>
    <div>
      <h2>Gastos Diarios</h2>
      <p>Suma varios viajes del día y visualiza el recorrido con contador de combustible en tiempo real.</p>
    </div>
    <div class="header-actions">
      {#if trips.length > 0}
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
          <div class="card-stats">
            <div class="card-stat">
              <span class="card-stat-label">Viajes</span>
              <span class="card-stat-value">{trips.length}</span>
            </div>
            <div class="card-stat">
              <span class="card-stat-label">Distancia</span>
              <span class="card-stat-value">{fmtKm(totalDistanceKm)}</span>
            </div>
            <div class="card-stat">
              <span class="card-stat-label">Combustible</span>
              <span class="card-stat-value">{fmtL(totalLitres)}</span>
            </div>
          </div>

          <div class="card-total">
            <span class="card-total-label">Gasto total</span>
            <span class="card-total-value">{fmtCLP(totalCost)}</span>
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
        <label class="field">
          <span>Hasta</span>
          <input type="text" placeholder="Dirección de destino" bind:value={destinationInput} onkeydown={handleKeydown} />
        </label>
        <button class="btn-add" onclick={addTrip} disabled={loading || !originInput || !destinationInput}>
          {#if loading}
            <span class="spinner"></span> Calculando…
          {:else}
            + Agregar viaje
          {/if}
        </button>
        {#if formError}<p class="error">{formError}</p>{/if}
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
                  <div class="trip-header-row">
                    <span class="trip-name">Viaje {i + 1}</span>
                    <span class="trip-cost">{fmtCLP(trip.cost)}</span>
                    <button class="btn-remove" onclick={() => removeTrip(trip.id)} aria-label="Eliminar viaje">×</button>
                  </div>
                  <span class="trip-route">{trip.origin} → {trip.destination}</span>
                  <span class="trip-meta">{fmtKm(trip.distanceKm)} · {trip.durationText} · {fmtL(trip.litres)}</span>
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

  /* ── Mobile ────────────────────────────────────────────────────────────── */
  @media (max-width: 768px) {
    header { display: none; }

    .body { position: relative; }

    .map-wrap {
      position: absolute;
      inset: 0;
    }

    /* Panel becomes a bottom sheet floating over the map. */
    .panel {
      position: absolute;
      left: 0; right: 0; bottom: 0;
      width: 100%;
      border-right: none;
      border-top: 1px solid var(--border);
      border-radius: 1rem 1rem 0 0;
      box-shadow: 0 -8px 28px rgba(0, 0, 0, 0.18);
      overflow: hidden;
      transition: height 0.28s ease, background 0.2s, border-color 0.2s;
      z-index: 10;
      overscroll-behavior: contain;
    }
    .panel[data-state="hidden"]  { height: 44px; }
    .panel[data-state="compact"] { height: 300px; }
    .panel[data-state="full"]    { height: 82vh; overflow-y: auto; }
    .panel.dragging { transition: none; }

    .sheet-handle {
      display: flex;
      justify-content: center;
      align-items: center;
      width: 100%;
      min-height: 32px;
      padding: 0.75rem 0 0.5rem;
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
      width: 44px;
      height: 5px;
      border-radius: 3px;
      background: var(--border);
    }

    /* ── Compact summary card ──────────────────────────────── */
    .route-card {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      padding: 0.25rem 1rem 1rem;
    }
    .panel[data-state="full"] .route-card { display: none; }

    .card-stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0.5rem;
    }
    .card-stat { display: flex; flex-direction: column; gap: 2px; }
    .card-stat-label {
      font-size: 0.625rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-4);
    }
    .card-stat-value {
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 1rem;
      font-weight: 700;
      color: var(--text);
    }

    .card-total {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      padding: 0.5rem 0.75rem;
      background: var(--subtle);
      border-radius: 0.5rem;
      border: 1px solid var(--border-2);
    }
    .card-total-label {
      font-size: 0.6875rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-4);
    }
    .card-total-value {
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 1.125rem;
      font-weight: 800;
      color: var(--accent-text);
    }

    .card-play {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.375rem;
      width: 100%;
      padding: 0.75rem;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 0.625rem;
      font-size: 0.9375rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
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

    /* Bring the new-trip form right under the drag handle so it's
       visible while the sheet is collapsed (no trips yet). */
    .section-new-trip { order: -2; }

    .section { padding: 0.75rem 1rem; }

    /* ── Compact-mode visibility ───────────────────────────── */
    /* In compact mode: hide every section + the mobile action row. */
    .panel[data-state="compact"] .section,
    .panel[data-state="compact"] .mobile-actions {
      display: none;
    }
    /* ...unless there is no trip yet, in which case the new-trip form
       is what should be visible (no card is rendered). */
    .panel[data-state="compact"]:not(:has(.route-card)) .section-new-trip {
      display: flex;
    }

    /* HUD: move to the top, compact horizontal layout. */
    .hud {
      position: absolute;
      top: 12px;
      right: 12px;
      left: 64px;
      bottom: auto;
      padding: 0.625rem 0.875rem;
      border-radius: 0.875rem;
      gap: 0.5rem;
      min-width: 0;
    }
    .hud-speed-row { gap: 0.375rem; }
    .hud-speed-num { font-size: 1.75rem; }
    .hud-speed-meta { padding-bottom: 2px; }
    .hud-speed-unit { font-size: 0.6875rem; }
    .hud-badge { font-size: 0.625rem; }

    .hud-sep { display: none; }

    .hud-stat-label { display: none; }
    .hud-stat-vals strong { font-size: 0.75rem; }
    .hud-of { display: none; }

    .hud-cost { flex-direction: row; align-items: baseline; gap: 0.375rem; }
    .hud-cost-label { display: none; }
    .hud-cost-val { font-size: 1rem; }
    .hud-cost-total { display: none; }
  }
</style>
