import type { ModelInput } from "./model_input.ts";
import { createModelInputId } from "./model_input.ts";
import type { ModelType } from "./model_type.ts";
import { modelRegistry } from "./model.ts";
import type { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";

/**
 * UUID v4 regex pattern for detecting if an argument is a UUID.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Partial ID pattern - at least 3 hex characters (with optional dashes).
 * Used for Docker-style partial ID matching.
 */
const PARTIAL_ID_PATTERN = /^[0-9a-f-]{3,}$/i;

/**
 * Checks if a string looks like a UUID v4.
 */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Checks if a value could be a partial ID (3+ hex chars) or a full UUID.
 * This is used for Docker-style partial ID matching.
 */
export function isPartialId(value: string): boolean {
  return PARTIAL_ID_PATTERN.test(value);
}

/**
 * Result of a partial ID lookup when the match is found.
 */
export interface PartialIdMatch<T> {
  match: T;
  id: string;
}

/**
 * Result type for partial ID matching.
 */
export type PartialIdResult<T> =
  | { status: "found"; match: T }
  | { status: "not_found" }
  | { status: "ambiguous"; matches: PartialIdMatch<T>[] };

/**
 * Matches items by partial ID prefix (Docker-style).
 *
 * Normalizes both the partial ID and item IDs by removing dashes and
 * converting to lowercase before matching.
 *
 * @param items - Array of items with their IDs
 * @param partialId - The partial ID to match against
 * @returns The match result: found, not_found, or ambiguous
 */
export function matchByPartialId<T>(
  items: Array<{ id: string; item: T }>,
  partialId: string,
): PartialIdResult<T> {
  const normalizedPartial = partialId.toLowerCase().replace(/-/g, "");
  const matches = items.filter(({ id }) =>
    id.toLowerCase().replace(/-/g, "").startsWith(normalizedPartial)
  );

  if (matches.length === 0) {
    return { status: "not_found" };
  }
  if (matches.length === 1) {
    return { status: "found", match: matches[0].item };
  }
  return {
    status: "ambiguous",
    matches: matches.map((m) => ({ match: m.item, id: m.id })),
  };
}

/**
 * Result of a global model lookup.
 */
export interface ModelLookupResult {
  input: ModelInput;
  type: ModelType;
}

/**
 * Finds an input by ID, searching across all registered model types.
 */
export async function findInputByIdGlobal(
  inputRepo: YamlInputRepository,
  id: string,
): Promise<ModelLookupResult | null> {
  const inputId = createModelInputId(id);

  for (const type of modelRegistry.types()) {
    const input = await inputRepo.findById(type, inputId);
    if (input) {
      return { input, type };
    }
  }

  return null;
}
