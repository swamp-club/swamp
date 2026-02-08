/**
 * Branded type for Data IDs.
 */
export type DataId = string & { readonly _brand: unique symbol };

/**
 * Creates a DataId from a string.
 */
export function createDataId(id: string): DataId {
  return id as DataId;
}

/**
 * Generates a new unique DataId.
 */
export function generateDataId(): DataId {
  return crypto.randomUUID() as DataId;
}
