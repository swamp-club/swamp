// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import type {
  InputsSchema,
  JsonSchemaProperty,
} from "../definitions/definition.ts";

/**
 * Individual validation error.
 */
export interface InputValidationError {
  path: string;
  message: string;
}

/**
 * Result of input validation.
 */
export interface InputValidationResult {
  valid: boolean;
  errors: InputValidationError[];
}

/**
 * Domain service for validating inputs against JSON Schema.
 */
export class InputValidationService {
  /**
   * Validates input values against an inputs schema.
   *
   * @param inputs - The input values to validate
   * @param schema - The inputs schema to validate against
   * @returns Validation result with any errors
   */
  validate(
    inputs: Record<string, unknown>,
    schema: InputsSchema,
  ): InputValidationResult {
    const errors: InputValidationError[] = [];

    // Get properties from schema (supports both flat and nested object formats)
    const properties = schema.properties ?? schema;
    const required = schema.required ?? [];

    // Check for missing required inputs
    for (const key of required) {
      if (!(key in inputs) || inputs[key] === undefined) {
        errors.push({
          path: key,
          message: `${key} is required`,
        });
      }
    }

    // Validate each provided input
    for (const [key, value] of Object.entries(inputs)) {
      const propSchema = properties[key] as JsonSchemaProperty | undefined;
      if (propSchema) {
        const propErrors = this.validateProperty(key, value, propSchema);
        errors.push(...propErrors);
      } else if (schema.additionalProperties === false) {
        errors.push({
          path: key,
          message: `${key} is not a valid input property`,
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Gets the names of required inputs that are missing.
   *
   * @param inputs - The input values provided
   * @param schema - The inputs schema
   * @returns Array of missing required input names
   */
  getMissingRequiredInputs(
    inputs: Record<string, unknown>,
    schema: InputsSchema,
  ): string[] {
    const properties = schema.properties ?? schema;
    const required = schema.required ?? [];
    const missing: string[] = [];

    for (const key of required) {
      if (!(key in inputs) || inputs[key] === undefined) {
        // Check if the property has a default value
        const propSchema = properties[key] as JsonSchemaProperty | undefined;
        if (!propSchema?.default) {
          missing.push(key);
        }
      }
    }

    return missing;
  }

  /**
   * Applies default values from schema to inputs.
   *
   * @param inputs - The input values provided
   * @param schema - The inputs schema
   * @returns New inputs object with defaults applied
   */
  applyDefaults(
    inputs: Record<string, unknown>,
    schema: InputsSchema,
  ): Record<string, unknown> {
    const properties = schema.properties ?? schema;
    const result = { ...inputs };

    for (const [key, propSchema] of Object.entries(properties)) {
      const prop = propSchema as JsonSchemaProperty;
      if (prop.default !== undefined && !(key in result)) {
        result[key] = structuredClone(prop.default);
      }
    }

    return result;
  }

  /**
   * Validates a single property value against its schema.
   */
  private validateProperty(
    path: string,
    value: unknown,
    schema: JsonSchemaProperty,
  ): InputValidationError[] {
    const errors: InputValidationError[] = [];

    // Handle null/undefined
    if (value === null || value === undefined) {
      // Null/undefined is only valid if there's a default
      if (schema.default === undefined) {
        errors.push({
          path,
          message: `${path} cannot be null or undefined`,
        });
      }
      return errors;
    }

    // Type validation
    if (schema.type) {
      const typeError = this.validateType(path, value, schema.type);
      if (typeError) {
        errors.push(typeError);
        return errors; // Stop further validation if type is wrong
      }
    }

    // Enum validation
    if (schema.enum && schema.enum.length > 0) {
      if (!schema.enum.includes(value)) {
        const allowedValues = schema.enum
          .map((v) => typeof v === "string" ? `"${v}"` : String(v))
          .join(", ");
        errors.push({
          path,
          message: `${path} must be one of: ${allowedValues}`,
        });
      }
    }

    // Array validation
    if (schema.type === "array" && Array.isArray(value)) {
      const arrayErrors = this.validateArray(path, value, schema);
      errors.push(...arrayErrors);
    }

    // Object validation
    if (
      schema.type === "object" && typeof value === "object" && value !== null
    ) {
      const objectErrors = this.validateObject(
        path,
        value as Record<string, unknown>,
        schema,
      );
      errors.push(...objectErrors);
    }

    return errors;
  }

  /**
   * Validates value type matches schema type.
   */
  private validateType(
    path: string,
    value: unknown,
    expectedType: string,
  ): InputValidationError | null {
    const actualType = this.getValueType(value);

    // Handle integer as a special case of number
    if (expectedType === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return {
          path,
          message: `${path} must be an integer`,
        };
      }
      return null;
    }

    if (actualType !== expectedType) {
      return {
        path,
        message: `${path} must be a ${expectedType}`,
      };
    }

    return null;
  }

  /**
   * Gets the JSON Schema type of a value.
   */
  private getValueType(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
  }

  /**
   * Validates array values.
   */
  private validateArray(
    path: string,
    value: unknown[],
    schema: JsonSchemaProperty,
  ): InputValidationError[] {
    const errors: InputValidationError[] = [];

    // Validate minItems
    const minItems = schema.minItems as number | undefined;
    if (minItems !== undefined && value.length < minItems) {
      errors.push({
        path,
        message: `${path} must have at least ${minItems} item${
          minItems === 1 ? "" : "s"
        }`,
      });
    }

    // Validate maxItems
    const maxItems = schema.maxItems as number | undefined;
    if (maxItems !== undefined && value.length > maxItems) {
      errors.push({
        path,
        message: `${path} must have at most ${maxItems} item${
          maxItems === 1 ? "" : "s"
        }`,
      });
    }

    // Validate uniqueItems
    const uniqueItems = schema.uniqueItems as boolean | undefined;
    if (uniqueItems) {
      const stringified = value.map((v) => JSON.stringify(v));
      const unique = new Set(stringified);
      if (unique.size !== value.length) {
        errors.push({
          path,
          message: `${path} must have unique items`,
        });
      }
    }

    // Validate items schema
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const itemErrors = this.validateProperty(
          `${path}[${i}]`,
          value[i],
          schema.items,
        );
        errors.push(...itemErrors);
      }
    }

    return errors;
  }

  /**
   * Validates object values.
   */
  private validateObject(
    path: string,
    value: Record<string, unknown>,
    schema: JsonSchemaProperty,
  ): InputValidationError[] {
    const errors: InputValidationError[] = [];

    // Validate required properties
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in value) || value[key] === undefined) {
          errors.push({
            path: `${path}.${key}`,
            message: `${path}.${key} is required`,
          });
        }
      }
    }

    // Validate properties
    if (schema.properties) {
      for (const [key, propValue] of Object.entries(value)) {
        const propSchema = schema.properties[key];
        if (propSchema) {
          const propErrors = this.validateProperty(
            `${path}.${key}`,
            propValue,
            propSchema,
          );
          errors.push(...propErrors);
        } else if (schema.additionalProperties === false) {
          errors.push({
            path: `${path}.${key}`,
            message: `${path}.${key} is not a valid property`,
          });
        } else if (
          typeof schema.additionalProperties === "object" &&
          schema.additionalProperties
        ) {
          // Validate against additionalProperties schema
          const propErrors = this.validateProperty(
            `${path}.${key}`,
            propValue,
            schema.additionalProperties,
          );
          errors.push(...propErrors);
        }
      }
    } else if (
      typeof schema.additionalProperties === "object" &&
      schema.additionalProperties
    ) {
      // All properties must match additionalProperties schema
      for (const [key, propValue] of Object.entries(value)) {
        const propErrors = this.validateProperty(
          `${path}.${key}`,
          propValue,
          schema.additionalProperties,
        );
        errors.push(...propErrors);
      }
    }

    return errors;
  }
}
