import type { DataHandle, DataOutputSpecification } from "./model.ts";

export interface DataOutputValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Domain service for validating data handles against declared spec types.
 */
export class DataOutputValidationService {
  /**
   * Validates that all data handles reference declared spec types.
   */
  validate(
    dataHandles: DataHandle[],
    specs: Record<string, DataOutputSpecification>,
    methodName: string,
  ): DataOutputValidationResult {
    const errors: string[] = [];
    const declaredSpecTypes = new Set(Object.keys(specs));

    // Check that all handles reference declared spec types
    for (const handle of dataHandles) {
      const specTypeValue = handle.specType.value;

      if (!declaredSpecTypes.has(specTypeValue)) {
        errors.push(
          `Data output '${handle.name}' references undeclared spec type '${specTypeValue}' ` +
            `in method '${methodName}'. Declared spec types: ${
              Array.from(declaredSpecTypes).join(", ")
            }`,
        );
      }
    }

    // Check for duplicate instance names
    const names = new Set<string>();
    for (const handle of dataHandles) {
      if (names.has(handle.name)) {
        errors.push(
          `Duplicate data instance name '${handle.name}' in method '${methodName}'`,
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
