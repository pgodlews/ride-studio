import type { Ride } from './ride';

/** Inclusive visible indices, or no public route. Never infer privacy from missing distance. */
export function publicRouteRange(ride: Ride, indices: number[], trimMetres: number): { from: number; to: number } | null {
  if (indices.length < 2) return null;
  if (trimMetres === 0) return { from: 0, to: indices.length - 1 };
  if (!Number.isFinite(trimMetres) || trimMetres < 0) return null;
  const distance = ride.raw('distance');
  if (!distance) return null;
  const [start, end] = ride.extent('distance');
  if (!Number.isFinite(start) || end - start <= 2 * trimMetres) return null;
  // Unknown or decreasing distances cannot establish which GPS points are private.
  let previous = -Infinity;
  for (let i = 0; i < ride.t.length; i++) {
    if (!Number.isFinite(distance[i]) || distance[i] < previous) return null;
    previous = distance[i];
  }
  let from = 0;
  let to = indices.length - 1;
  while (from <= to && distance[indices[from]] < start + trimMetres) from++;
  while (to >= from && distance[indices[to]] > end - trimMetres) to--;
  return from < to ? { from, to } : null;
}
