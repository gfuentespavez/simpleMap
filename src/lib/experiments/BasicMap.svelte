<script>
  import Map from '$lib/Map.svelte';

  let center = $state({ lat: -36.8197, lng: -73.0521 });
  let zoom   = $state(12);

  function handleReady(map) {
    map.addListener('center_changed', () => {
      const c = map.getCenter();
      center = { lat: c.lat(), lng: c.lng() };
    });
    map.addListener('zoom_changed', () => {
      zoom = map.getZoom();
    });
  }

  function fmt(n) { return n.toFixed(5); }
</script>

<div class="experiment">
  <header>
    <div>
      <h2>Basic Map</h2>
      <p>Mueve y haz zoom para explorar. Las coordenadas se actualizan en tiempo real.</p>
    </div>
    <div class="coords">
      <span class="coord-label">Centro</span>
      <span class="coord-value">{fmt(center.lat)}, {fmt(center.lng)}</span>
      <span class="coord-label">Zoom</span>
      <span class="coord-value">{zoom}</span>
    </div>
  </header>

  <div class="map-wrap">
    <Map onReady={handleReady} />

    <!-- Mobile-only floating coordinate pill (hidden on desktop via CSS). -->
    <div class="coord-pill">
      <span class="pill-value">{fmt(center.lat)}, {fmt(center.lng)}</span>
      <span class="pill-sep">·</span>
      <span class="pill-value">z{zoom}</span>
    </div>
  </div>
</div>

<style>
  .experiment { display: flex; flex-direction: column; height: 100%; }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.875rem 1.25rem;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    transition: background 0.2s, border-color 0.2s;
  }
  h2 { margin: 0 0 0.125rem; font-size: 1rem; font-weight: 600; color: var(--text); }
  p  { margin: 0; font-size: 0.8125rem; color: var(--text-3); }

  .coords {
    display: grid;
    grid-template-columns: auto auto;
    gap: 0.125rem 0.625rem;
    text-align: right;
  }
  .coord-label {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-4);
  }
  .coord-value {
    font-size: 0.8125rem;
    font-family: 'SF Mono', 'Fira Code', monospace;
    color: var(--text-2);
  }

  .map-wrap { flex: 1; overflow: hidden; position: relative; }

  /* Mobile-only coord pill — hidden on desktop */
  .coord-pill { display: none; }

  @media (max-width: 768px) {
    header { display: none; }

    .coord-pill {
      display: flex;
      position: absolute;
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 0.875rem;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 999px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
      max-width: calc(100vw - 120px);
      pointer-events: none;
    }
    .pill-value {
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 0.75rem;
      color: var(--text-2);
      white-space: nowrap;
    }
    .pill-sep { color: var(--text-4); }
  }
</style>
