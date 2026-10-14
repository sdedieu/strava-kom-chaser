/**
 * Requires a finite number.
 *
 * @param {number} value Value to validate.
 * @param {string} name Name to use in the thrown validation error.
 * @return {number} The validated value.
 */
export function requireFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }

  return value;
}

/**
 * Requires a positive finite number.
 *
 * @param {number} value Value to validate.
 * @param {string} name Name to use in the thrown validation error.
 * @return {number} The validated value.
 */
export function requirePositiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }

  return value;
}

/**
 * Requires a finite number within an inclusive range.
 *
 * @param {number} value Value to validate.
 * @param {number} minimum Inclusive minimum allowed value.
 * @param {number} maximum Inclusive maximum allowed value.
 * @param {string} name Name to use in the thrown validation error.
 * @return {number} The validated value.
 */
export function requireInRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }

  return value;
}

/**
 * Clamps a number to an inclusive range.
 *
 * @param {number} value Value to clamp.
 * @param {number} minimum Inclusive minimum allowed value.
 * @param {number} maximum Inclusive maximum allowed value.
 * @return {number} The clamped value.
 */
export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Rounds a number to a fixed number of decimal places.
 *
 * @param {number} value Value to round.
 * @param {number} decimalPlaces Number of decimal places.
 * @return {number} The rounded value.
 */
export function round(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces;
  return Math.round(value * factor) / factor;
}
