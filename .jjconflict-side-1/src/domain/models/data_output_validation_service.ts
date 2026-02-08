import type { DataOutput, DataOutputSpecification } from "./model.ts";
import type { DataOutputOverride } from "./data_output_override.ts";

export interface DataOutputValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Domain service for validating and enhancing data outputs.
 */
export class DataOutputValidationService {
  /**
   * Validates that all data outputs reference declared spec types.
   */
  validate(
    dataOutputs: DataOutput[],
    specs: Record<string, DataOutputSpecification>,
    methodName: string,
  ): DataOutputValidationResult {
    const errors: string[] = [];
    const declaredSpecTypes = new Set(Object.keys(specs));

    // Check that all outputs reference declared spec types
    for (const output of dataOutputs) {
      const specTypeValue = output.specType.value;

      if (!declaredSpecTypes.has(specTypeValue)) {
        errors.push(
          `Data output '${output.name}' references undeclared spec type '${specTypeValue}' ` +
            `in method '${methodName}'. Declared spec types: ${
              Array.from(declaredSpecTypes).join(", ")
            }`,
        );
      }
    }

    // Check for duplicate instance names
    const names = new Set<string>();
    for (const output of dataOutputs) {
      if (names.has(output.name)) {
        errors.push(
          `Duplicate data instance name '${output.name}' in method '${methodName}'`,
        );
      }
      names.add(output.name);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Applies defaults from spec and merges overrides.
   */
  applyDefaultsAndOverrides(
    dataOutput: DataOutput,
    spec: DataOutputSpecification,
    overrides?: DataOutputOverride[],
  ): DataOutput {
    // Find override for this spec type
    const override = overrides?.find((o) =>
      o.specType.equals(dataOutput.specType)
    );

    return {
      ...dataOutput,
      metadata: {
        ...dataOutput.metadata,
        contentType: dataOutput.metadata.contentType ??
          spec.contentType ??
          "application/json",
        lifetime: override?.lifetime ??
          dataOutput.metadata.lifetime ??
          spec.lifetime ??
          "infinite",
        garbageCollection: override?.garbageCollection ??
          dataOutput.metadata.garbageCollection ??
          spec.garbageCollection ??
          10,
        streaming: dataOutput.metadata.streaming ??
          spec.streaming ??
          false,
        tags: {
          ...(spec.tags ?? {}),
          ...(dataOutput.metadata.tags ?? {}),
          ...(override?.tags ?? {}),
        },
      },
    };
  }
}
