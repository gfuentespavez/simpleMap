import { experiments } from '$lib/experiments/registry.js';
import { error } from '@sveltejs/kit';

export function load({ params }) {
  const found = experiments.find((e) => e.id === params.experiment);
  if (!found) {
    error(404, `No experiment named "${params.experiment}"`);
  }
  return { experimentId: found.id };
}
