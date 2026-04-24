/**
 * Physics-based estimator for the average power required to ride a
 * Strava segment in a given time.
 *
 * The model follows the standard cycling power equation:
 *
 *   P = (1 / η) · ( m·g·v·sin(θ) + m·g·Crr·cos(θ)·v + ½·ρ·CdA·v³ )
 *
 * where
 *   m   = total mass (rider + bike), kg
 *   g   = gravity (9.81 m/s²)
 *   v   = average speed, m/s
 *   θ   = average road slope (rad)
 *   Crr = rolling resistance coefficient
 *   ρ   = air density, kg/m³
 *   CdA = drag area, m²
 *   η   = drivetrain efficiency
 */

const G = 9.81;
const AIR_DENSITY_KG_M3 = 1.225;
const ROLLING_RESISTANCE_ROAD = 0.005;
/** Approximate drag area for a fit cyclist on the drops. */
const DRAG_AREA_M2 = 0.32;
const DRIVETRAIN_EFFICIENCY = 0.97;
const BIKE_MASS_KG = 8.5;

export interface PowerEstimateInput {
  /** Segment distance in metres. */
  readonly distanceM: number;
  /** Average grade as a percentage (e.g. 7.5 means 7.5 %). */
  readonly averageGradePct: number;
  /** Effort duration in seconds. */
  readonly durationS: number;
  /** Athlete bodyweight in kilograms. */
  readonly riderMassKg: number;
  /** Optional override for the bike mass. Defaults to 8.5 kg. */
  readonly bikeMassKg?: number;
}

/**
 * Returns the average power, in watts, required to complete the segment
 * in `durationS` seconds at a steady pace.
 */
export function estimateAveragePowerW(input: PowerEstimateInput): number {
  const { distanceM, averageGradePct, durationS, riderMassKg } = input;
  if (durationS <= 0 || distanceM <= 0) {
    return 0;
  }

  const totalMassKg = riderMassKg + (input.bikeMassKg ?? BIKE_MASS_KG);
  const speedMs = distanceM / durationS;
  const slopeRad = Math.atan(averageGradePct / 100);

  const gravityW = totalMassKg * G * speedMs * Math.sin(slopeRad);
  const rollingW =
    totalMassKg * G * ROLLING_RESISTANCE_ROAD * Math.cos(slopeRad) * speedMs;
  const aeroW = 0.5 * AIR_DENSITY_KG_M3 * DRAG_AREA_M2 * Math.pow(speedMs, 3);

  const mechanicalW = gravityW + rollingW + aeroW;
  return mechanicalW / DRIVETRAIN_EFFICIENCY;
}
