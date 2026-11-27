// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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
import { stopsAtFirstFailingArgument } from "../untrusted_parse.ts";

export interface InputValidationError {
  path: string;
  message: string;
}

export interface InputValidationResult {
  valid: boolean;
  errors: InputValidationError[];
}

const JSON_SUFFIX = ":json";

/**
 * the input a `name:json` key was meant for: `:json` is parsed only from
 * command-line arguments, so anywhere else the key arrives verbatim
 */
export function jsonSuffixedInputBase(
  key: string,
  isInput: (name: string) => boolean,
): string | undefined {
  if (!key.endsWith(JSON_SUFFIX) || key.length <= JSON_SUFFIX.length) {
    return undefined;
  }
  const base = key.slice(0, -JSON_SUFFIX.length);
  return isInput(base) ? base : undefined;
}

export function jsonSuffixHint(base: string): string {
  return `the ${JSON_SUFFIX} suffix only works in command-line arguments; ` +
    `elsewhere give ${base} its value directly, under its own name`;
}

/**
 * under serve's untrusted argument policy each array and object walk stops
 * after its first failing entry, so an oversized remote input cannot collect
 * one error per entry
 */
export class InputValidationService {
  validate(
    inputs: Record<string, unknown>,
    schema: InputsSchema,
  ): InputValidationResult {
    const errors: InputValidationError[] = [];
    const required = schema.required ?? [];

    for (const key of required) {
      if (!(key in inputs) || inputs[key] === undefined) {
        errors.push({
          path: key,
          message: `${key} is required`,
        });
      }
    }

    for (const error of this.validateEntries(inputs, schema)) {
      errors.push(error);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * validates only the supplied inputs and skips the required check, for
   * partial sets such as the override inputs of a workflow resume that merge
   * over stored inputs
   */
  validateProvided(
    inputs: Record<string, unknown>,
    schema: InputsSchema,
  ): InputValidationResult {
    const errors = this.validateEntries(inputs, schema);
    return {
      valid: errors.length === 0,
      errors,
    };
  }

  private validateEntries(
    inputs: Record<string, unknown>,
    schema: InputsSchema,
  ): InputValidationError[] {
    const errors: InputValidationError[] = [];

    for (const [key, value] of Object.entries(inputs)) {
      const propSchema = declaredProperty(schema, key);
      if (propSchema) {
        const propErrors = this.validateProperty(key, value, propSchema);
        for (const error of propErrors) errors.push(error);
      } else {
        const error = undeclaredKeyError(key, schema);
        if (error) errors.push(error);
      }
      if (errors.length > 0 && stopsAtFirstFailingArgument()) break;
    }

    return errors;
  }

  /**
   * judges keys only: values handed to a nested workflow can still be
   * expressions the child resolves, which a type check would refuse
   */
  undeclaredInputs(
    inputs: Record<string, unknown>,
    schema: InputsSchema,
  ): InputValidationError[] {
    const errors: InputValidationError[] = [];
    for (const key of Object.keys(inputs)) {
      if (declaredProperty(schema, key)) continue;
      const error = undeclaredKeyError(key, schema);
      if (error) errors.push(error);
      if (errors.length > 0 && stopsAtFirstFailingArgument()) break;
    }
    return errors;
  }

  declaresInput(key: string, schema: InputsSchema): boolean {
    return declaredProperty(schema, key) !== undefined;
  }

  getMissingRequiredInputs(
    inputs: Record<string, unknown>,
    schema: InputsSchema,
  ): string[] {
    const properties = schema.properties ?? schema;
    const required = schema.required ?? [];
    const missing: string[] = [];

    for (const key of required) {
      if (!(key in inputs) || inputs[key] === undefined) {
        const propSchema = properties[key] as JsonSchemaProperty | undefined;
        if (!propSchema?.default) {
          missing.push(key);
        }
      }
    }

    return missing;
  }

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

  private validateProperty(
    path: string,
    value: unknown,
    schema: JsonSchemaProperty,
  ): InputValidationError[] {
    const errors: InputValidationError[] = [];

    if (value === null || value === undefined) {
      if (schema.default === undefined) {
        errors.push({
          path,
          message: `${path} cannot be null or undefined`,
        });
      }
      return errors;
    }

    if (schema.type) {
      const typeError = this.validateType(path, value, schema.type);
      if (typeError) {
        errors.push(typeError);
        return errors;
      }
    }

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

    if (schema.type === "array" && Array.isArray(value)) {
      const arrayErrors = this.validateArray(path, value, schema);
      for (const error of arrayErrors) errors.push(error);
    }

    if (
      schema.type === "object" && typeof value === "object" && value !== null
    ) {
      const objectErrors = this.validateObject(
        path,
        value as Record<string, unknown>,
        schema,
      );
      for (const error of objectErrors) errors.push(error);
    }

    return errors;
  }

  private validateType(
    path: string,
    value: unknown,
    expectedType: string,
  ): InputValidationError | null {
    const actualType = this.getValueType(value);

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

  private getValueType(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
  }

  private validateArray(
    path: string,
    value: unknown[],
    schema: JsonSchemaProperty,
  ): InputValidationError[] {
    const errors: InputValidationError[] = [];

    const minItems = schema.minItems as number | undefined;
    if (minItems !== undefined && value.length < minItems) {
      errors.push({
        path,
        message: `${path} must have at least ${minItems} item${
          minItems === 1 ? "" : "s"
        }`,
      });
    }

    const maxItems = schema.maxItems as number | undefined;
    if (maxItems !== undefined && value.length > maxItems) {
      errors.push({
        path,
        message: `${path} must have at most ${maxItems} item${
          maxItems === 1 ? "" : "s"
        }`,
      });
    }

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

    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const itemErrors = this.validateProperty(
          `${path}[${i}]`,
          value[i],
          schema.items,
        );
        for (const error of itemErrors) errors.push(error);
        if (errors.length > 0 && stopsAtFirstFailingArgument()) break;
      }
    }

    return errors;
  }

  private validateObject(
    path: string,
    value: Record<string, unknown>,
    schema: JsonSchemaProperty,
  ): InputValidationError[] {
    const errors: InputValidationError[] = [];

    if (schema.required) {
      for (const key of schema.required) {
        // Own properties only: a required key named after an
        // Object.prototype member (toString) is not present in `{}`.
        if (!Object.hasOwn(value, key) || value[key] === undefined) {
          errors.push({
            path: `${path}.${key}`,
            message: `${path}.${key} is required`,
          });
        }
      }
    }

    if (schema.properties) {
      for (const [key, propValue] of Object.entries(value)) {
        const propSchema = Object.hasOwn(schema.properties, key)
          ? schema.properties[key]
          : undefined;
        if (propSchema) {
          const propErrors = this.validateProperty(
            `${path}.${key}`,
            propValue,
            propSchema,
          );
          for (const error of propErrors) errors.push(error);
        } else if (schema.additionalProperties === false) {
          errors.push({
            path: `${path}.${key}`,
            message: `${path}.${key} is not a valid property`,
          });
        } else if (
          typeof schema.additionalProperties === "object" &&
          schema.additionalProperties
        ) {
          const propErrors = this.validateProperty(
            `${path}.${key}`,
            propValue,
            schema.additionalProperties,
          );
          for (const error of propErrors) errors.push(error);
        }
        if (errors.length > 0 && stopsAtFirstFailingArgument()) break;
      }
    } else if (
      typeof schema.additionalProperties === "object" &&
      schema.additionalProperties
    ) {
      for (const [key, propValue] of Object.entries(value)) {
        const propErrors = this.validateProperty(
          `${path}.${key}`,
          propValue,
          schema.additionalProperties,
        );
        for (const error of propErrors) errors.push(error);
        if (errors.length > 0 && stopsAtFirstFailingArgument()) break;
      }
    }

    return errors;
  }
}

function declaredProperty(
  schema: InputsSchema,
  key: string,
): JsonSchemaProperty | undefined {
  const properties = schema.properties ?? schema;
  // Own properties only: an input named after an Object.prototype member
  // (constructor, __proto__) is not a declared input.
  const propSchema = Object.hasOwn(properties, key)
    ? properties[key] as JsonSchemaProperty | undefined
    : undefined;
  return propSchema || undefined;
}

// names the key, never its value: a value meant as JSON can carry credentials
function undeclaredKeyError(
  key: string,
  schema: InputsSchema,
): InputValidationError | undefined {
  const base = jsonSuffixedInputBase(
    key,
    (name) => declaredProperty(schema, name) !== undefined,
  );
  if (base !== undefined) {
    return {
      path: key,
      message: `${key} is not an input: ${jsonSuffixHint(base)}`,
    };
  }
  if (schema.additionalProperties === false) {
    return { path: key, message: `${key} is not a valid input property` };
  }
  return undefined;
}
