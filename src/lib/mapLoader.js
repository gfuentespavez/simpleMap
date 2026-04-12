import { Loader } from '@googlemaps/js-api-loader';
import { PUBLIC_GOOGLE_MAPS_API_KEY } from '$env/static/public';

/**
 * Singleton Google Maps loader.
 * Import this wherever you need to load a Maps library.
 *
 * Usage:
 *   const { Map } = await loader.importLibrary('maps');
 *   const { AdvancedMarkerElement } = await loader.importLibrary('marker');
 */
export const loader = new Loader({
  apiKey: PUBLIC_GOOGLE_MAPS_API_KEY,
  version: 'weekly',
});
