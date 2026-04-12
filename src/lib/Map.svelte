<!--
  Reusable Google Map component.
  Props: center, zoom, mapId, options, onReady
  Automatically follows the app theme (light / dark).
  Because the Maps JS API treats `colorScheme` as an immutable option,
  the map instance is destroyed and rebuilt whenever the theme changes;
  center and zoom are preserved and `onReady` is invoked again so the
  parent can re-attach listeners and overlays.
-->
<script>
  import { onMount } from 'svelte';
  import { loader } from '$lib/mapLoader.js';
  import { PUBLIC_GOOGLE_MAP_ID } from '$env/static/public';
  import { theme } from '$lib/theme.svelte.js';

  let {
    center = { lat: -36.8197, lng: -73.0521 },
    zoom   = 12,
    mapId  = PUBLIC_GOOGLE_MAP_ID,
    options = {},
    onReady = undefined,
  } = $props();

  let container;
  let mapInstance = $state(null);
  let MapClass = null;
  let activeScheme = null;

  onMount(async () => {
    const { Map } = await loader.importLibrary('maps');
    MapClass = Map;
    build(center, zoom);
  });

  $effect(() => {
    const scheme = theme.isDark ? 'DARK' : 'LIGHT';
    if (!MapClass || activeScheme === scheme) return;
    const c = mapInstance?.getCenter()?.toJSON() ?? center;
    const z = mapInstance?.getZoom() ?? zoom;
    build(c, z);
  });

  function build(c, z) {
    const scheme = theme.isDark ? 'DARK' : 'LIGHT';
    activeScheme = scheme;
    // Clear the container so the previous map's DOM is removed
    if (container) container.innerHTML = '';
    mapInstance = new MapClass(container, {
      center: c,
      zoom: z,
      mapId,
      colorScheme: scheme,
      mapTypeControl: false,
      ...options,
    });
    onReady?.(mapInstance);
  }
</script>

<div bind:this={container} class="map-container"></div>

<style>
  .map-container { width: 100%; height: 100%; }
</style>
