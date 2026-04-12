<script>
  import { onMount, onDestroy } from 'svelte';
  import { loader } from '$lib/mapLoader.js';
  import { PUBLIC_GOOGLE_MAP_ID, PUBLIC_GOOGLE_MAPS_API_KEY } from '$env/static/public';
  import { theme } from '$lib/theme.svelte.js';

  // ── Inputs ────────────────────────────────────────────────────────────────
  let origin      = $state('');
  let destination = $state('');
  let consumptionPer100km = $state(10);
  let fuelPriceCLP        = $state(1200);
  let kmPerLitre = $derived(consumptionPer100km > 0 ? 100 / consumptionPer100km : 0);

  // ── Route data ────────────────────────────────────────────────────────────
  // routeData.points[] = { lat, lng, time (s from start), distance (m from start), speed (km/h) }
  let routeData      = $state(null);
  let isCalculating  = $state(false);
  let calcError      = $state('');

  let totalLitres = $derived(routeData && kmPerLitre > 0 ? routeData.totalDistanceKm / kmPerLitre : 0);
  let totalCost   = $derived(totalLitres * fuelPriceCLP);

  // ── Animation state ───────────────────────────────────────────────────────
  // 'idle' | 'ready' | 'playing' | 'paused' | 'done'
  let animState = $state('idle');
  let speedMult = $state(60);
  const SPEED_OPTS = [10, 30, 60, 120];

  // Live HUD stats (updated imperatively each frame, written as $state for reactivity)
  let liveSpeed    = $state(0);
  let liveDistKm   = $state(0);
  let liveLitres   = $state(0);
  let liveCost     = $state(0);
  let liveProgress = $state(0);

  // Internal animation bookkeeping (plain vars — not reactive)
  let simTime      = 0;
  let lastTs       = null;
  let raf          = null;
  let traveledPts  = [];   // LatLngLiteral[] accumulated as particle moves
  let traveledIdx  = 0;   // index into routeData.points up to which we've already added to traveledPts

  // ── Map objects ───────────────────────────────────────────────────────────
  let container;
  let map = $state(null);
  let MapClass      = null;
  let activeScheme  = null;
  let bgLine        = null;
  let traveledLine  = null;
  let particle      = null;

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  onMount(async () => {
    const { Map } = await loader.importLibrary('maps');
    MapClass = Map;
    buildMap({ lat: -36.8197, lng: -73.0521 }, 12);

    // Inject particle CSS (scoped styles don't reach AdvancedMarkerElement content)
    const s = document.createElement('style');
    s.dataset.owner = 'route-vis';
    s.textContent = `
      .rv-particle {
        width: 22px; height: 22px;
        background: #4f46e5; border-radius: 50%;
        border: 3px solid #fff;
        box-shadow: 0 0 0 3px rgba(79,70,229,.35), 0 0 18px rgba(79,70,229,.5);
        animation: rv-pulse 1.4s ease-in-out infinite;
        pointer-events: none;
      }
      @keyframes rv-pulse {
        0%,100% { box-shadow: 0 0 0 3px rgba(79,70,229,.3),  0 0 14px rgba(79,70,229,.4); }
        50%     { box-shadow: 0 0 0 9px rgba(79,70,229,.08), 0 0 30px rgba(79,70,229,.9); }
      }
    `;
    document.head.appendChild(s);
  });

  onDestroy(() => {
    stopAnim();
    document.querySelector('style[data-owner="route-vis"]')?.remove();
  });

  // `colorScheme` is immutable in the Maps JS API, so we rebuild the map
  // whenever the theme changes and redraw any existing overlays.
  $effect(() => {
    const scheme = theme.isDark ? 'DARK' : 'LIGHT';
    if (!MapClass || activeScheme === scheme) return;
    const c = map?.getCenter()?.toJSON() ?? { lat: -36.8197, lng: -73.0521 };
    const z = map?.getZoom() ?? 12;
    const wasPlaying = animState === 'playing';
    if (wasPlaying) stopAnim();
    buildMap(c, z);
    if (routeData) {
      renderRouteOverlays().then(() => {
        if (wasPlaying) play();
      });
    }
  });

  function buildMap(c, z) {
    const scheme = theme.isDark ? 'DARK' : 'LIGHT';
    activeScheme = scheme;
    if (container) container.innerHTML = '';
    // Dropping references to overlays tied to the old map instance.
    bgLine = null;
    traveledLine = null;
    particle = null;
    map = new MapClass(container, {
      center: c,
      zoom: z,
      mapId: PUBLIC_GOOGLE_MAP_ID,
      colorScheme: scheme,
      mapTypeControl: false,
    });
  }

  async function renderRouteOverlays() {
    if (!routeData || !map) return;

    const { encoding } = await loader.importLibrary('geometry');
    const { Polyline } = await loader.importLibrary('maps');
    const { AdvancedMarkerElement } = await loader.importLibrary('marker');

    const fullPath = encoding.decodePath(routeData.encodedPolyline);

    bgLine = new Polyline({
      path: fullPath, strokeColor: '#cbd5e1', strokeWeight: 6, strokeOpacity: 1, map,
      zIndex: 1,
    });

    traveledLine = new Polyline({
      path: [...traveledPts], strokeColor: '#4f46e5', strokeWeight: 5, strokeOpacity: 0.9, map,
      zIndex: 2,
    });

    const curPt = simTime > 0 ? interpolate(routeData.points, simTime) : routeData.points[0];
    const el = document.createElement('div');
    el.className = 'rv-particle';
    particle = new AdvancedMarkerElement({
      map, position: { lat: curPt.lat, lng: curPt.lng }, content: el, zIndex: 10,
    });
  }

  // ── Calculate route ───────────────────────────────────────────────────────
  async function calculateRoute() {
    if (!origin.trim() || !destination.trim()) return;
    isCalculating = true;
    calcError = '';
    clearVis();
    routeData = null;
    animState = 'idle';

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
          origin: { address: origin.trim() },
          destination: { address: destination.trim() },
          travelMode: 'DRIVE',
          computeAlternativeRoutes: false,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.routes?.length) throw new Error(data.error?.message ?? 'No se encontró ruta.');

      const route = data.routes[0];
      const steps = route.legs?.[0]?.steps ?? [];

      const { encoding }     = await loader.importLibrary('geometry');
      const { LatLngBounds } = await loader.importLibrary('core');

      const points   = buildTimeline(steps, encoding);
      const fullPath = encoding.decodePath(route.polyline.encodedPolyline);

      // Reset animation bookkeeping before drawing.
      simTime = 0; traveledPts = []; traveledIdx = 0;

      routeData = {
        totalDistanceKm: route.distanceMeters / 1000,
        totalDurationS:  parseInt(route.duration ?? '0'),
        points,
        encodedPolyline: route.polyline.encodedPolyline,
      };

      await renderRouteOverlays();

      // Fit map
      const bounds = new LatLngBounds();
      fullPath.forEach(p => bounds.extend(p));
      map.fitBounds(bounds, 60);

      // Initial live stats
      setLiveStats(points[0], 0);
      animState = 'ready';
    } catch (e) {
      calcError = e.message;
    } finally {
      isCalculating = false;
    }
  }

  // Build a flat timeline from per-step data.
  // Each point carries the cumulative time and distance, plus the step's average speed.
  function buildTimeline(steps, encoding) {
    const pts = [];
    let cumT = 0, cumD = 0;

    for (const step of steps) {
      const path  = encoding.decodePath(step.polyline.encodedPolyline);
      const dist  = step.distanceMeters ?? 0;
      const dur   = parseInt(step.staticDuration ?? '0');
      const speed = dur > 0 ? (dist / dur) * 3.6 : 0; // m/s → km/h

      const n = path.length;
      for (let i = 0; i < n; i++) {
        const f = n > 1 ? i / (n - 1) : 0;
        pts.push({
          lat: path[i].lat(), lng: path[i].lng(),
          time:     cumT + f * dur,
          distance: cumD + f * dist,
          speed,
        });
      }
      cumT += dur;
      cumD += dist;
    }
    return pts;
  }

  // ── Playback controls ─────────────────────────────────────────────────────
  function play() {
    if (animState === 'done') { simTime = 0; traveledPts = []; traveledIdx = 0; }
    animState = 'playing';
    lastTs = null;
    raf = requestAnimationFrame(tick);
  }

  function pause() {
    stopAnim();
    animState = 'paused';
  }

  function reset() {
    stopAnim();
    simTime = 0; traveledPts = []; traveledIdx = 0;
    animState = 'ready';
    if (routeData) {
      const p = routeData.points[0];
      if (particle)     particle.position = { lat: p.lat, lng: p.lng };
      if (traveledLine) traveledLine.setPath([]);
      setLiveStats(p, 0);
    }
  }

  function stopAnim() {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
  }

  // ── Animation loop ────────────────────────────────────────────────────────
  function tick(ts) {
    if (!lastTs) lastTs = ts;
    const delta = (ts - lastTs) / 1000; // real seconds elapsed
    lastTs = ts;
    simTime += delta * speedMult;

    if (routeData && simTime >= routeData.totalDurationS) {
      simTime = routeData.totalDurationS;
      advance(simTime);
      animState = 'done';
      raf = null;
      return;
    }

    advance(simTime);
    raf = requestAnimationFrame(tick);
  }

  function advance(t) {
    if (!routeData) return;
    const pts = routeData.points;

    // Accumulate waypoints the particle has passed
    while (traveledIdx < pts.length && pts[traveledIdx].time <= t) {
      traveledPts.push({ lat: pts[traveledIdx].lat, lng: pts[traveledIdx].lng });
      traveledIdx++;
    }

    const cur = interpolate(pts, t);

    if (particle)     particle.position = { lat: cur.lat, lng: cur.lng };
    if (traveledLine) traveledLine.setPath([...traveledPts, { lat: cur.lat, lng: cur.lng }]);

    setLiveStats(cur, t);
  }

  function setLiveStats(pt, t) {
    if (!routeData) return;
    liveSpeed    = Math.round(pt.speed);
    liveDistKm   = pt.distance / 1000;
    liveLitres   = kmPerLitre > 0 ? liveDistKm / kmPerLitre : 0;
    liveCost     = liveLitres * fuelPriceCLP;
    liveProgress = routeData.totalDurationS > 0 ? Math.min(1, t / routeData.totalDurationS) : 0;
  }

  // Linear interpolation between timeline points using binary search
  function interpolate(pts, t) {
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
      lat:      a.lat      + f * (b.lat      - a.lat),
      lng:      a.lng      + f * (b.lng      - a.lng),
      speed:    a.speed    + f * (b.speed    - a.speed),
      distance: a.distance + f * (b.distance - a.distance),
    };
  }

  function clearVis() {
    stopAnim();
    if (bgLine)       { bgLine.setMap(null);       bgLine = null; }
    if (traveledLine) { traveledLine.setMap(null);  traveledLine = null; }
    if (particle)     { particle.map = null;        particle = null; }
    traveledPts = []; traveledIdx = 0;
  }

  function handleKeydown(e) { if (e.key === 'Enter') calculateRoute(); }

  function fmtKm(n)  { return `${n.toFixed(1)} km`; }
  function fmtL(n)   { return `${n.toFixed(3)} L`; }
  function fmtCLP(n) {
    return new Intl.NumberFormat('es-CL', {
      style: 'currency', currency: 'CLP', maximumFractionDigits: 0,
    }).format(Math.round(n));
  }
  function fmtDur(s) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h === 0) return `${m} min`;
    if (m === 0) return `${h} h`;
    return `${h} h ${m} min`;
  }

  let fuelPct     = $derived(totalLitres > 0 ? (liveLitres / totalLitres) * 100 : 0);
  let distPct     = $derived(liveProgress * 100);
  let showHud     = $derived(animState === 'playing' || animState === 'paused' || animState === 'done');

  // ── Mobile bottom sheet ───────────────────────────────────────────────────
  // 'hidden' (just the handle peeking) | 'compact' (form or result card) | 'full'
  let sheetState = $state('compact');

  // Drag bookkeeping. While `dragHeight` is non-null, we render the panel with
  // an explicit pixel height so it tracks the user's finger; on release we
  // snap to the closest state.
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
    const delta = dragStartY - e.clientY; // positive = dragged up
    const max   = window.innerHeight * 0.92;
    dragHeight  = Math.max(0, Math.min(max, dragStartH + delta));
  }

  function onHandlePointerUp(e) {
    if (dragHeight === null) return;
    const vh = window.innerHeight;
    const h  = dragHeight;
    dragHeight = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);

    // Snap to nearest state
    if (h < 80)            sheetState = 'hidden';
    else if (h < vh * 0.45) sheetState = 'compact';
    else                    sheetState = 'full';
  }

  // Snap the sheet to the compact card whenever a new route is calculated.
  $effect(() => {
    if (routeData) sheetState = 'compact';
  });
</script>

<div class="experiment">
  <header>
    <h2>Visualización de Ruta</h2>
    <p>Partícula animada sobre la ruta con velocidad por segmento y contador de combustible en tiempo real.</p>
  </header>

  <div class="body">

    <!-- ── Panel ──────────────────────────────────────────────────────────── -->
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

      <!-- Compact result card: shown on mobile once a route is ready and the
           sheet is collapsed. Drag up to expand for the full form. -->
      {#if routeData}
        <div class="route-card">
          <div class="card-endpoints">
            <div class="endpoint">
              <span class="endpoint-dot origin"></span>
              <div class="endpoint-body">
                <span class="endpoint-label">Desde</span>
                <span class="endpoint-value">{origin}</span>
              </div>
            </div>
            <div class="endpoint">
              <span class="endpoint-dot dest"></span>
              <div class="endpoint-body">
                <span class="endpoint-label">Hasta</span>
                <span class="endpoint-value">{destination}</span>
              </div>
            </div>
          </div>

          <div class="card-stats">
            <div class="card-stat">
              <span class="card-stat-label">Distancia</span>
              <span class="card-stat-value">{fmtKm(routeData.totalDistanceKm)}</span>
            </div>
            <div class="card-stat">
              <span class="card-stat-label">Combustible</span>
              <span class="card-stat-value">{fmtL(totalLitres)}</span>
            </div>
          </div>

          <button class="card-play" onclick={animState === 'playing' ? pause : play}>
            {#if animState === 'playing'}
              ⏸ Pausar
            {:else if animState === 'done'}
              ↺ Repetir
            {:else}
              ▶ Reproducir
            {/if}
          </button>
        </div>
      {/if}

      <!-- Route form (origin + destination). Hidden on mobile when the card is showing. -->
      <section class="section section-form">
        <p class="section-title">Ruta</p>
        <label class="field">
          <span>Desde</span>
          <input type="text" placeholder="Dirección de origen"
            bind:value={origin} onkeydown={handleKeydown} />
        </label>
        <label class="field">
          <span>Hasta</span>
          <input type="text" placeholder="Dirección de destino"
            bind:value={destination} onkeydown={handleKeydown} />
        </label>
        <button class="btn-calc" onclick={calculateRoute}
          disabled={isCalculating || !origin || !destination}>
          {#if isCalculating}
            <span class="spinner"></span> Calculando…
          {:else}
            Calcular ruta
          {/if}
        </button>
        {#if calcError}<p class="error">{calcError}</p>{/if}
      </section>

      <!-- Fuel params -->
      <section class="section">
        <p class="section-title">Parámetros de combustible</p>
        <label class="field">
          <span>Consumo <em>(L / 100 km)</em></span>
          <input type="number" min="0.1" step="0.1" bind:value={consumptionPer100km} />
        </label>
        <label class="field">
          <span>Precio <em>(CLP / L)</em></span>
          <input type="number" min="1" step="1" bind:value={fuelPriceCLP} />
        </label>
      </section>

      <!-- Route summary -->
      {#if routeData}
        <section class="section">
          <p class="section-title">Resumen de ruta</p>
          <div class="summary-grid">
            <div class="summary-item">
              <span class="s-label">Distancia</span>
              <span class="s-value">{fmtKm(routeData.totalDistanceKm)}</span>
            </div>
            <div class="summary-item">
              <span class="s-label">Tiempo estimado</span>
              <span class="s-value">{fmtDur(routeData.totalDurationS)}</span>
            </div>
            <div class="summary-item">
              <span class="s-label">Combustible total</span>
              <span class="s-value">{fmtL(totalLitres)}</span>
            </div>
            <div class="summary-item">
              <span class="s-label">Costo total</span>
              <span class="s-value accent">{fmtCLP(totalCost)}</span>
            </div>
          </div>
        </section>

        <!-- Playback controls -->
        <section class="section">
          <p class="section-title">Reproducción</p>

          <div class="play-row">
            {#if animState === 'playing'}
              <button class="btn-play" onclick={pause}>⏸ Pausar</button>
            {:else}
              <button class="btn-play" onclick={play}>
                {animState === 'done' ? '↺ Repetir' : '▶ Reproducir'}
              </button>
            {/if}
            {#if animState !== 'idle' && animState !== 'ready'}
              <button class="btn-reset" onclick={reset} title="Reiniciar al inicio">↺</button>
            {/if}
          </div>

          <div class="speed-row">
            <span class="speed-label">Velocidad sim.</span>
            <div class="speed-opts">
              {#each SPEED_OPTS as opt (opt)}
                <button class="speed-btn" class:active={speedMult === opt}
                  onclick={() => speedMult = opt}>{opt}×</button>
              {/each}
            </div>
          </div>

          {#if showHud}
            <div class="panel-progress">
              <div class="panel-progress-fill" style="width: {distPct}%"></div>
            </div>
            <p class="progress-label">{(distPct).toFixed(1)}% completado</p>
          {/if}
        </section>
      {/if}

    </aside>

    <!-- ── Map + HUD ──────────────────────────────────────────────────────── -->
    <div class="map-wrap">
      <div bind:this={container} class="map"></div>

      {#if showHud}
        <div class="hud">

          <!-- Speed -->
          <div class="hud-speed-row">
            <div class="hud-speed-num">{liveSpeed}</div>
            <div class="hud-speed-meta">
              <span class="hud-speed-unit">km/h</span>
              {#if animState === 'done'}
                <span class="hud-done-badge">✓ Completado</span>
              {:else if animState === 'paused'}
                <span class="hud-paused-badge">⏸ Pausado</span>
              {/if}
            </div>
          </div>

          <div class="hud-sep"></div>

          <!-- Fuel gauge -->
          <div class="hud-stat">
            <div class="hud-stat-header">
              <span class="hud-stat-label">Combustible</span>
              <span class="hud-stat-values">
                <strong>{fmtL(liveLitres)}</strong>
                <span class="hud-of">/ {fmtL(totalLitres)}</span>
              </span>
            </div>
            <div class="hud-bar">
              <div class="hud-bar-fill fuel" style="width: {fuelPct}%"></div>
            </div>
          </div>

          <!-- Distance gauge -->
          <div class="hud-stat">
            <div class="hud-stat-header">
              <span class="hud-stat-label">Distancia</span>
              <span class="hud-stat-values">
                <strong>{fmtKm(liveDistKm)}</strong>
                <span class="hud-of">/ {fmtKm(routeData.totalDistanceKm)}</span>
              </span>
            </div>
            <div class="hud-bar">
              <div class="hud-bar-fill dist" style="width: {distPct}%"></div>
            </div>
          </div>

          <div class="hud-sep"></div>

          <!-- Cost counter -->
          <div class="hud-cost">
            <span class="hud-cost-label">Gasto acumulado</span>
            <span class="hud-cost-val">{fmtCLP(liveCost)}</span>
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
    display: flex; align-items: baseline; gap: .75rem;
    padding: .875rem 1.25rem; background: var(--surface);
    border-bottom: 1px solid var(--border); flex-shrink: 0;
    transition: background 0.2s, border-color 0.2s;
  }
  h2 { margin: 0; font-size: 1rem; font-weight: 600; white-space: nowrap; color: var(--text); }
  header p { margin: 0; font-size: .8125rem; color: var(--text-3); }

  .body { flex: 1; display: flex; overflow: hidden; }

  /* ── Panel ── */
  .panel {
    width: 280px; flex-shrink: 0;
    border-right: 1px solid var(--border); background: var(--surface);
    overflow-y: auto; display: flex; flex-direction: column;
    transition: background 0.2s, border-color 0.2s;
  }

  /* Mobile-only: drag handle + card are hidden on desktop. */
  .sheet-handle { display: none; }
  .route-card   { display: none; }
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
    width: 100%; padding: .4375rem .625rem;
    border: 1px solid var(--input-border); border-radius: .5rem;
    font-size: .875rem; color: var(--text); background: var(--input-bg);
    outline: none; transition: border-color .15s, background .15s;
  }
  .field input:focus { border-color: var(--accent); background: var(--surface); }

  .btn-calc {
    display: flex; align-items: center; justify-content: center; gap: .5rem;
    width: 100%; padding: .5rem; background: var(--accent); color: #fff;
    border: none; border-radius: .5rem; font-size: .875rem; font-weight: 500;
    cursor: pointer; transition: background .15s;
  }
  .btn-calc:hover:not(:disabled) { background: var(--accent-h); }
  .btn-calc:disabled { opacity: .5; cursor: not-allowed; }

  .spinner {
    width: 14px; height: 14px;
    border: 2px solid rgba(255,255,255,.4); border-top-color: #fff;
    border-radius: 50%; animation: spin .7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .error {
    margin: 0; font-size: .75rem; color: var(--danger);
    background: var(--danger-bg); padding: .5rem .625rem;
    border-radius: .375rem; line-height: 1.5;
  }

  .summary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; }
  .summary-item {
    background: var(--subtle); padding: .5rem .625rem; border-radius: .5rem;
  }
  .s-label { display: block; font-size: .6875rem; color: var(--text-4); margin-bottom: 2px; }
  .s-value {
    display: block; font-size: .875rem; font-weight: 600; color: var(--text);
    font-family: 'SF Mono', 'Fira Code', monospace;
  }
  .s-value.accent { color: var(--accent-text); }

  .play-row { display: flex; gap: .5rem; }
  .btn-play {
    flex: 1; padding: .5625rem; background: var(--accent); color: #fff;
    border: none; border-radius: .5rem; font-size: .875rem; font-weight: 500;
    cursor: pointer; transition: background .15s;
  }
  .btn-play:hover { background: var(--accent-h); }
  .btn-reset {
    padding: .5rem .75rem; background: var(--hover); color: var(--text-3);
    border: none; border-radius: .5rem; font-size: 1rem; cursor: pointer; line-height: 1;
  }
  .btn-reset:hover { background: var(--border); }

  .speed-row { display: flex; align-items: center; gap: .5rem; }
  .speed-label { font-size: .75rem; font-weight: 500; color: var(--text-3); white-space: nowrap; }
  .speed-opts { display: flex; gap: 3px; }
  .speed-btn {
    padding: .25rem .5rem; background: var(--hover); color: var(--text-3);
    border: 1px solid var(--border); border-radius: .375rem;
    font-size: .75rem; cursor: pointer; transition: all .1s;
  }
  .speed-btn:hover { background: var(--border); }
  .speed-btn.active {
    background: var(--accent-bg); color: var(--accent-text); border-color: var(--accent-border); font-weight: 600;
  }

  .panel-progress {
    height: 4px; background: var(--border); border-radius: 2px; overflow: hidden;
  }
  .panel-progress-fill {
    height: 100%; background: var(--accent); border-radius: 2px; transition: width .08s linear;
  }
  .progress-label { margin: 0; font-size: .6875rem; color: var(--text-4); text-align: right; }

  /* ── Map + HUD ── */
  .map-wrap { flex: 1; overflow: hidden; position: relative; }
  .map { width: 100%; height: 100%; }

  .hud {
    position: absolute; bottom: 24px; right: 20px;
    background: rgba(15, 23, 42, 0.92);
    backdrop-filter: blur(10px);
    border-radius: 1.125rem;
    padding: 1.125rem 1.25rem;
    min-width: 230px;
    display: flex; flex-direction: column; gap: .875rem;
    box-shadow: 0 8px 32px rgba(0,0,0,.35);
    color: #fff;
    border: 1px solid rgba(255,255,255,.07);
  }

  /* Speed */
  .hud-speed-row { display: flex; align-items: flex-end; gap: .5rem; }
  .hud-speed-num {
    font-size: 3rem; font-weight: 800; line-height: 1;
    font-family: 'SF Mono', 'Fira Code', monospace;
    color: #a5b4fc; letter-spacing: -.02em;
  }
  .hud-speed-meta { display: flex; flex-direction: column; gap: 4px; padding-bottom: 4px; }
  .hud-speed-unit { font-size: .8125rem; color: #94a3b8; font-weight: 500; }
  .hud-done-badge {
    font-size: .6875rem; font-weight: 600; color: #34d399;
    background: rgba(52,211,153,.12); padding: 2px 6px; border-radius: 999px;
  }
  .hud-paused-badge {
    font-size: .6875rem; font-weight: 600; color: #fbbf24;
    background: rgba(251,191,36,.12); padding: 2px 6px; border-radius: 999px;
  }

  .hud-sep { height: 1px; background: rgba(255,255,255,.08); }

  /* Stat rows */
  .hud-stat { display: flex; flex-direction: column; gap: 5px; }
  .hud-stat-header {
    display: flex; align-items: baseline;
    justify-content: space-between; gap: .5rem;
  }
  .hud-stat-label {
    font-size: .6875rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: .06em; color: #64748b;
  }
  .hud-stat-values { display: flex; align-items: baseline; gap: .25rem; }
  .hud-stat-values strong {
    font-size: .875rem; font-weight: 700;
    font-family: 'SF Mono', 'Fira Code', monospace; color: #e2e8f0;
  }
  .hud-of { font-size: .75rem; color: #475569; }

  .hud-bar { height: 5px; background: rgba(255,255,255,.1); border-radius: 3px; overflow: hidden; }
  .hud-bar-fill { height: 100%; border-radius: 3px; transition: width .08s linear; }
  .hud-bar-fill.fuel { background: linear-gradient(90deg, #818cf8, #6366f1); }
  .hud-bar-fill.dist { background: linear-gradient(90deg, #34d399, #10b981); }

  /* Cost counter */
  .hud-cost { display: flex; flex-direction: column; gap: 3px; }
  .hud-cost-label {
    font-size: .6875rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: .06em; color: #64748b;
  }
  .hud-cost-val {
    font-size: 1.5rem; font-weight: 800; line-height: 1.1;
    font-family: 'SF Mono', 'Fira Code', monospace; color: #818cf8;
  }
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
    /* Snap heights: hidden peek, compact form/card, expanded full. */
    .panel[data-state="hidden"]  { height: 44px; }
    .panel[data-state="compact"] { height: 280px; }
    .panel[data-state="full"]    { height: 82vh; overflow-y: auto; }

    /* Disable the snap transition while the user is actively dragging. */
    .panel.dragging { transition: none; }

    /* Drag handle — hit target is generous for touch. */
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
    }
    .sheet-handle:active { cursor: grabbing; }
    .handle-bar {
      width: 44px;
      height: 5px;
      border-radius: 3px;
      background: var(--border);
    }

    /* ── Compact result card ───────────────────────────────── */
    /* Shown only in compact state when a route has been calculated.
       Full state shows the complete form/details instead. */
    .route-card {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      padding: 0.25rem 1rem 1rem;
    }
    .panel[data-state="full"] .route-card { display: none; }

    .card-endpoints {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      position: relative;
    }
    .endpoint { display: flex; align-items: flex-start; gap: 0.625rem; }
    .endpoint-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
      margin-top: 5px;
    }
    .endpoint-dot.origin { background: var(--accent); }
    .endpoint-dot.dest   { background: #10b981; }
    .endpoint-body { display: flex; flex-direction: column; min-width: 0; flex: 1; }
    .endpoint-label {
      font-size: 0.625rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-4);
    }
    .endpoint-value {
      font-size: 0.875rem;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .card-stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.5rem;
      padding-top: 0.5rem;
      border-top: 1px solid var(--border-2);
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
      font-size: 1.0625rem;
      font-weight: 700;
      color: var(--text);
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

    /* In compact mode:
       - If no route yet, show only the first section (the form).
       - If a route exists, the .route-card replaces every section. */
    .panel[data-state="compact"] .section ~ .section,
    .panel[data-state="compact"] .route-card ~ .section {
      display: none;
    }

    .section { padding: 0.75rem 1rem; }

    /* HUD: move to the top of the screen, compact horizontal layout. */
    .hud {
      position: absolute;
      top: 12px;
      right: 12px;
      left: 64px;                 /* leave room for hamburger */
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

    .hud-sep { display: none; }

    .hud-stat-label { display: none; }
    .hud-stat-values strong { font-size: 0.75rem; }
    .hud-of { display: none; }

    .hud-cost { flex-direction: row; align-items: baseline; gap: 0.375rem; }
    .hud-cost-label { display: none; }
    .hud-cost-val { font-size: 1rem; }
    .hud-cost-total { display: none; }
  }
</style>
