/**
 * Dataset de peajes troncales (manual).
 *
 * Google Routes API no entrega tarifas de peaje para Chile (devuelve
 * `tollInfo: {}` / 0 CLP), por lo que las tarifas se mantienen aquí y se
 * cobran según los peajes que la ruta realmente atraviesa.
 *
 * Las coordenadas de cada plaza están ajustadas sobre la traza real de la
 * Ruta 5 Sur (validadas contra la polilínea de Routes API), de modo que el
 * cálculo por proximidad a la ruta seleccione exactamente las plazas pagadas.
 */

// Tipos de vehículo disponibles. `key` indexa el objeto `tarifas` de cada plaza.
export const TOLL_VEHICLES = [
  { id: 'auto_camioneta', label: 'Auto / Camioneta' },
  { id: 'moto',           label: 'Moto' },
];

// Corredor Ruta 5 Sur: Concepción → Puerto Montt.
export const TOLL_CORRIDOR = {
  via: 'Ruta 5 Sur',
  vigenteDesde: '2026-01-01',
  notas: 'Pago de peaje troncal da derecho a paso gratuito en plaza lateral de salida dentro de 12 horas. Acepta efectivo y tarjeta sin contacto (TSC).',
};

// Plazas troncales, de norte a sur. `tarifas` en CLP por tipo de vehículo.
export const TOLL_PLAZAS = [
  { id: 1, nombre: 'Cabrero',             ruta: 'Ruta 5 Sur',      lat: -37.03388, lng: -72.41768, tarifas: { auto_camioneta: 3100, moto: 1000 } },
  { id: 2, nombre: 'Las Maicas',          ruta: 'Ruta 5 Sur',      lat: -37.95266, lng: -72.41085, tarifas: { auto_camioneta: 3200, moto: 1000 } },
  { id: 3, nombre: 'PUA',                 ruta: 'Ruta 5 Sur',      lat: -38.41682, lng: -72.40660, tarifas: { auto_camioneta: 3400, moto: 1000 } },
  { id: 4, nombre: 'Quepe',               ruta: 'Ruta Araucanía',  lat: -38.86582, lng: -72.61699, tarifas: { auto_camioneta: 3400, moto: 1000 } },
  { id: 5, nombre: 'Lanco',               ruta: 'Ruta Los Ríos',   lat: -39.45025, lng: -72.79165, tarifas: { auto_camioneta: 3500, moto: 1100 } },
  { id: 6, nombre: 'La Unión',            ruta: 'Ruta Los Ríos',   lat: -40.30318, lng: -72.97739, tarifas: { auto_camioneta: 3500, moto: 1100 } },
  { id: 7, nombre: 'Cuatro Vientos',      ruta: 'Panamericana Sur', lat: -40.89729, lng: -73.15342, tarifas: { auto_camioneta: 3500, moto: 1100 } },
  { id: 8, nombre: 'Puerto Montt–Chiloé', ruta: 'Ruta 5 Sur',      lat: -41.44710, lng: -72.96418, tarifas: { auto_camioneta: 1100, moto: 300 } },
  { id: 9, nombre: 'Ferry Canal Chacao', ruta: 'Ruta 5 Sur',      lat: -41.7947597,lng: -73.4083901, tarifas: {auto_camioneta: 24900, moto: 24900 } },
  { id: 10, nombre: 'Ferry Canal Dalcahue', ruta: 'Ruta 5 Sur', lat: -42.3912453, lng: -73.6648463, tarifas: { auto_camioneta: 3500, moto: 300 } },
];

// Una plaza se considera "pagada" si la ruta pasa a <= 5 km de ella. Las plazas
// están separadas por ~30 km o más, así que el umbral evita falsos positivos.
const MATCH_THRESHOLD_KM = 5;

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLng = (bLng - aLng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// Distancia mínima (km) de una plaza a cualquier vértice de la ruta.
function minDistanceToPath(plaza, path) {
  let min = Infinity;
  for (const p of path) {
    const d = haversineKm(plaza.lat, plaza.lng, p.lat, p.lng);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Calcula los peajes de una ruta según las plazas que atraviesa.
 *
 * @param {Array<{lat:number,lng:number}>} path  Vértices de la ruta (densos).
 * @param {string} vehicleKey  'auto_camioneta' | 'moto'
 * @returns {{ matched: Array<{id,nombre,ruta,lat,lng,fare}>, total: number }}
 */
export function computeTollsForPath(path, vehicleKey = 'auto_camioneta') {
  if (!path?.length) return { matched: [], total: 0 };
  const matched = [];
  let total = 0;
  for (const plaza of TOLL_PLAZAS) {
    if (minDistanceToPath(plaza, path) <= MATCH_THRESHOLD_KM) {
      const fare = plaza.tarifas[vehicleKey] ?? 0;
      matched.push({
        id: plaza.id, nombre: plaza.nombre, ruta: plaza.ruta,
        lat: plaza.lat, lng: plaza.lng, fare,
      });
      total += fare;
    }
  }
  return { matched, total };
}
