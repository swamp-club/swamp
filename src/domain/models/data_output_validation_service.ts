import type { DataHandle } from "./model.ts";

export interface DataOutputValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Domain service for validating data handles produced by method execution.
 *
 * Spec name validation is now enforced at writer creation time by the
 * resource/file writer factories. This service focuses on detecting duplicate
 * instance names within a single method execution.
 */
export class DataOutputValidationService {
  /**
   * Validates data handles for duplicate instance names.
   */
  validate(
    dataHandles: DataHandle[],
  ): DataOutputValidationResult {
    const errors: string[] = [];

    // Check for duplicate instance names
    const names = new Set<string>();
    for (const handle of dataHandles) {
      if (names.has(handle.name)) {
        errors.push(
          `Duplicate data instance name '${handle.name}'`,
        );
      }
      names.add(handle.name);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
