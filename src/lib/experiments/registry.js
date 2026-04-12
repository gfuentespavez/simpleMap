/**
 * Experiment registry.
 *
 * To add a new experiment:
 *   1. Create a Svelte component in src/lib/experiments/
 *   2. Add an entry here with a unique `id`, a display `name`,
 *      a short `description`, and a dynamic `component` import.
 *
 * @type {Array<{ id: string, name: string, description: string, component: () => Promise<any> }>}
 */
export const experiments = [
  {
    id: 'basic-map',
    name: 'Basic Map',
    description: 'Pan and zoom a map, live coordinate display.',
    component: () => import('./BasicMap.svelte'),
  },
  {
    id: 'markers',
    name: 'Custom Markers',
    description: 'Click to place markers. Click a marker to remove it.',
    component: () => import('./Markers.svelte'),
  },
  {
    id: 'route-visualization',
    name: 'Visualización de Ruta',
    description: 'Partícula animada sobre la ruta con velocidad por segmento y contador de combustible.',
    component: () => import('./RouteVisualization.svelte'),
  },
  {
    id: 'daily-route',
    name: 'Gastos Diarios',
    description: 'Suma varios viajes del día para calcular el gasto total de combustible.',
    component: () => import('./DailyRoute.svelte'),
  },
];
