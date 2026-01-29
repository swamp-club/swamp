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
 * Checks if a string looks like a UUID v4.
 */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
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
