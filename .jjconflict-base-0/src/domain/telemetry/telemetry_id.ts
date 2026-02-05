/**
 * Branded type for Telemetry IDs.
 */
export type TelemetryId = string & { readonly _brand: unique symbol };

/**
 * Creates a TelemetryId from a string.
 */
export function createTelemetryId(id: string): TelemetryId {
  return id as TelemetryId;
}

/**
 * Generates a new unique TelemetryId.
 */
export function generateTelemetryId(): TelemetryId {
  return crypto.randomUUID() as TelemetryId;
}
