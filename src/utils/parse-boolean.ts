const TRUE_VALUES = ['1', 'true', 'on', 'yes', 'enabled'];
const FALSE_VALUES = ['0', 'false', 'off', 'no', 'disabled'];

/**
 * Lenient boolean for env vars and config strings (case-insensitive):
 * 1/true/on/yes/enabled and 0/false/off/no/disabled. Anything else, including
 * unset and empty, yields `fallback` (undefined when none is given).
 */
export function parseBoolean(raw: string | undefined): boolean | undefined;
export function parseBoolean(raw: string | undefined, fallback: boolean): boolean;
export function parseBoolean(raw: string | undefined, fallback?: boolean): boolean | undefined {
  const normalized = raw?.trim().toLowerCase() ?? '';
  if (TRUE_VALUES.includes(normalized)) return true;
  if (FALSE_VALUES.includes(normalized)) return false;
  return fallback;
}
