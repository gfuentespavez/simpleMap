<script>
  import Map from '$lib/Map.svelte';
  import { loader } from '$lib/mapLoader.js';

  // Each entry: { id, lat, lng, marker }
  // `marker` is tied to a specific Map instance, so it must be re-created
  // whenever the map is rebuilt (e.g. after a theme change).
  let markers = $state([]);

  async function handleReady(map) {
    const { AdvancedMarkerElement } = await loader.importLibrary('marker');

    // Re-attach existing markers to the (possibly new) map.
    if (markers.length > 0) {
      markers = markers.map((entry) => {
        const marker = new AdvancedMarkerElement({
          map,
          position: { lat: entry.lat, lng: entry.lng },
        });
        marker.addListener('click', () => removeMarker(entry.id));
        return { ...entry, marker };
      });
    }

    map.addListener('click', (e) => {
      const position = e.latLng;
      const id = Date.now();
      const marker = new AdvancedMarkerElement({ map, position });
      marker.addListener('click', () => removeMarker(id));
      markers = [...markers, { id, lat: position.lat(), lng: position.lng(), marker }];
    });
  }

  function removeMarker(id) {
    const entry = markers.find((m) => m.id === id);
    if (entry?.marker) entry.marker.map = null;
    markers = markers.filter((m) => m.id !== id);
  }

  function clearAll() {
    markers.forEach((m) => m.marker && (m.marker.map = null));
    markers = [];
  }

  function fmt(n) { return n.toFixed(4); }
</script>

<div class="experiment">
  <header>
    <div>
      <h2>Custom Markers</h2>
      <p>Haz clic en el mapa para agregar un marcador. Haz clic sobre el marcador para eliminarlo.</p>
    </div>
    {#if markers.length > 0}
      <button onclick={clearAll}>Limpiar ({markers.length})</button>
    {/if}
  </header>

  <div class="body">
    <div class="map-wrap">
      <Map onReady={handleReady} />

      <!-- Mobile-only floating counter + clear button. -->
      {#if markers.length > 0}
        <div class="count-chip">
          <span>{markers.length} marcador{markers.length !== 1 ? 'es' : ''}</span>
          <button onclick={clearAll} aria-label="Limpiar todos">Limpiar</button>
        </div>
      {/if}
    </div>

    {#if markers.length > 0}
      <aside class="list">
        <p class="list-title">{markers.length} marcador{markers.length !== 1 ? 'es' : ''}</p>
        <ul>
          {#each markers as m (m.id)}
            <li>
              <span class="ll">{fmt(m.lat)}, {fmt(m.lng)}</span>
              <button class="remove" onclick={() => removeMarker(m.id)} aria-label="Eliminar">×</button>
            </li>
          {/each}
        </ul>
      </aside>
    {/if}
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
  header > div > p { margin: 0; font-size: 0.8125rem; color: var(--text-3); }

  header > button {
    padding: 0.375rem 0.875rem;
    background: var(--danger-bg);
    color: var(--danger);
    border: none;
    border-radius: 0.5rem;
    cursor: pointer;
    font-size: 0.8125rem;
    font-weight: 500;
    white-space: nowrap;
  }
  header > button:hover { background: var(--danger-h); }

  .body { flex: 1; display: flex; overflow: hidden; }
  .map-wrap { flex: 1; overflow: hidden; position: relative; }

  .count-chip { display: none; }

  .list {
    width: 200px;
    flex-shrink: 0;
    border-left: 1px solid var(--border);
    background: var(--surface);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    transition: background 0.2s, border-color 0.2s;
  }
  .list-title {
    margin: 0;
    padding: 0.75rem 0.875rem 0.375rem;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-4);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0 0.5rem 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 0.5rem;
    border-radius: 0.375rem;
    background: var(--subtle);
  }
  .ll {
    font-size: 0.75rem;
    font-family: 'SF Mono', 'Fira Code', monospace;
    color: var(--text-2);
  }
  .remove {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-4);
    font-size: 1rem;
    line-height: 1;
    padding: 0 2px;
    border-radius: 0.25rem;
  }
  .remove:hover { color: var(--danger); background: var(--danger-bg); }

  @media (max-width: 768px) {
    header { display: none; }
    .list  { display: none; }

    .count-chip {
      display: flex;
      position: absolute;
      top: 12px;
      right: 12px;
      align-items: center;
      gap: 0.5rem;
      padding: 0.4375rem 0.5rem 0.4375rem 0.75rem;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 999px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
      font-size: 0.75rem;
      color: var(--text-2);
      font-weight: 500;
    }
    .count-chip button {
      background: var(--danger-bg);
      color: var(--danger);
      border: none;
      border-radius: 999px;
      padding: 0.25rem 0.625rem;
      font-size: 0.6875rem;
      font-weight: 600;
      cursor: pointer;
    }
  }
</style>
