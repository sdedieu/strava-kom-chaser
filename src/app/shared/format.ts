/** Formatting helpers shared by the UI layer. */

export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.round(totalSeconds % 60);
  if (h > 0) {
    return `${h}h ${pad2(m)}m ${pad2(s)}s`;
  }
  if (m > 0) {
    return `${m}m ${pad2(s)}s`;
  }
  return `${s}s`;
}

export function formatDistance(distanceM: number): string {
  if (distanceM >= 1000) {
    return `${(distanceM / 1000).toFixed(distanceM >= 10000 ? 0 : 1)} km`;
  }
  return `${Math.round(distanceM)} m`;
}

export function formatSpeedKmh(speedMs: number): string {
  return `${(speedMs * 3.6).toFixed(1)} km/h`;
}

export function formatWatts(watts: number | null): string {
  if (watts == null || !Number.isFinite(watts)) return '—';
  return `${Math.round(watts)} W`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
