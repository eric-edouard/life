// Distance on the Earth: one definition, for the voice server's stays and Life's waits on places.

const EARTH_RADIUS_M = 6_371_000;
/** How near counts as at a place given by coordinates alone (`read_places_visited`'s `radiusM`, a wait's `radius_m`). */
export const DEFAULT_RADIUS_M = 100;

/** The great-circle distance between two points, in meters (haversine). */
export function distanceM(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) *
      Math.cos(b.latitude * rad) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}
