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

import { z } from "zod";
import {
  DriverConfigFieldSchema,
  DriverFieldSchema,
} from "../drivers/driver_config.ts";

/**
 * Branded type for Definition IDs.
 */
export type DefinitionId = string & { readonly _brand: unique symbol };

/**
 * Creates a DefinitionId from a string.
 */
export function createDefinitionId(id: string): DefinitionId {
  return id as DefinitionId;
}

/**
 * JSON Schema property type for definition inputs.
 * Follows JSON Schema draft-07 format.
 */
export interface JsonSchemaProperty {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  default?: unknown;
  enum?: unknown[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaProperty;
  [key: string]: unknown;
}

/**
 * Zod schema for JSON Schema properties with recursive support.
 */
const baseJsonSchemaPropertySchema: z.ZodType<JsonSchemaProperty> = z.lazy(
  () =>
    z.object({
      type: z.enum([
        "string",
        "number",
        "integer",
        "boolean",
        "array",
        "object",
      ])
        .optional(),
      description: z.string().optional(),
      default: z.unknown().optional(),
      enum: z.array(z.unknown()).optional(),
      items: baseJsonSchemaPropertySchema.optional(),
      properties: z.record(z.string(), baseJsonSchemaPropertySchema).optional(),
      required: z.array(z.string()).optional(),
      additionalProperties: z.union([
        z.boolean(),
        baseJsonSchemaPropertySchema,
      ])
        .optional(),
    }).passthrough(),
);

export const JsonSchemaPropertySchema = baseJsonSchemaPropertySchema;

/**
 * InputsSchema type for definition inputs.
 */
export interface InputsSchema {
  type?: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaProperty;
  [key: string]: unknown;
}

/**
 * Zod schema for definition inputs.
 */
export const InputsSchemaSchema: z.ZodType<InputsSchema | undefined> = z
  .object({
    type: z.literal("object").optional(),
    properties: z.record(z.string(), JsonSchemaPropertySchema).optional(),
    required: z.array(z.string()).optional(),
    additionalProperties: z.union([z.boolean(), JsonSchemaPropertySchema])
      .optional(),
  })
  .passthrough()
  .optional();

/**
 * Zod schema for the core properties of a Definition.
 *
 * `typeVersion` accepts CalVer strings.  Legacy numeric values (from
 * pre-CalVer definitions stored on disk) are coerced to `undefined` so
 * the upgrade chain treats them as "oldest version, needs full upgrade".
 */
/**
 * Zod schema for per-method arguments stored in a definition.
 */
export const MethodDataSchema = z.object({
  arguments: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Schema for definition-level check selection (require/skip).
 */
export const CheckSelectionSchema = z.object({
  require: z.array(z.string()).optional(),
  skip: z.array(z.string()).optional(),
}).optional();

/**
 * Type for definition-level check selection.
 */
export type CheckSelection = {
  require?: string[];
  skip?: string[];
};

export const DefinitionSchema = z.object({
  type: z.string().optional(),
  typeVersion: z.preprocess(
    (val) => (typeof val === "number" ? undefined : val),
    z.string().optional(),
  ),
  id: z.string().uuid(),
  name: z.string().min(1).refine(
    (name) =>
      !name.includes("..") && !name.includes("/") && !name.includes("\\") &&
      !name.includes("\0"),
    {
      message:
        "Definition name must not contain '..', '/', '\\', or null bytes (path traversal)",
    },
  ),
  version: z.number().int().positive(),
  tags: z.record(z.string(), z.string()).default({}),
  globalArguments: z.record(z.string(), z.unknown()).default({}),
  methods: z.record(z.string(), MethodDataSchema).default({}),
  inputs: InputsSchemaSchema,
  checks: CheckSelectionSchema,
  driver: DriverFieldSchema,
  driverConfig: DriverConfigFieldSchema,
});

/**
 * Type representing the data stored in a Definition.
 */
export type DefinitionData = z.infer<typeof DefinitionSchema>;

/**
 * Properties required to create a new Definition.
 */
/**
 * Per-method data stored in a definition.
 */
export type MethodData = z.infer<typeof MethodDataSchema>;

/**
 * Properties required to create a new Definition.
 */
export interface CreateDefinitionProps {
  type?: string;
  typeVersion?: string;
  id?: string;
  name: string;
  version?: number;
  tags?: Record<string, string>;
  globalArguments?: Record<string, unknown>;
  methods?: Record<string, MethodData>;
  inputs?: InputsSchema;
  checks?: CheckSelection;
  driver?: string;
  driverConfig?: Record<string, unknown>;
}

/**
 * Definition is an entity representing the configuration for a model instance.
 *
 * Each definition has a unique ID (UUID), a human-readable name, version,
 * optional tags, domain-specific attributes, and optional inputs schema.
 *
 * Attributes can contain CEL expressions in the format ${{ expression }}
 * which will be evaluated when the definition is instantiated.
 */
export class Definition {
  private constructor(
    readonly type: string | undefined,
    readonly typeVersion: string | undefined,
    readonly id: DefinitionId,
    readonly name: string,
    readonly version: number,
    private _tags: Record<string, string>,
    private _globalArguments: Record<string, unknown>,
    private _methods: Record<string, MethodData>,
    private _inputs: InputsSchema | undefined,
    private _checks: CheckSelection | undefined,
    readonly driver: string | undefined,
    readonly driverConfig: Record<string, unknown> | undefined,
  ) {}

  /**
   * Creates a new Definition instance.
   *
   * @param props - Properties for the new definition
   * @returns A new Definition instance
   */
  static create(props: CreateDefinitionProps): Definition {
    const id = props.id ?? crypto.randomUUID();
    const version = props.version ?? 1;

    const validated = DefinitionSchema.parse({
      type: props.type,
      typeVersion: props.typeVersion,
      id,
      name: props.name,
      version,
      tags: props.tags ?? {},
      globalArguments: props.globalArguments ?? {},
      methods: props.methods ?? {},
      inputs: props.inputs,
      checks: props.checks,
      driver: props.driver,
      driverConfig: props.driverConfig,
    });

    return new Definition(
      validated.type,
      validated.typeVersion,
      createDefinitionId(validated.id),
      validated.name,
      validated.version,
      validated.tags,
      validated.globalArguments,
      validated.methods,
      validated.inputs,
      validated.checks,
      validated.driver,
      validated.driverConfig,
    );
  }

  /**
   * Reconstructs a Definition from persisted data.
   *
   * @param data - The persisted data
   * @returns A Definition instance
   */
  static fromData(data: DefinitionData): Definition {
    const validated = DefinitionSchema.parse(data);
    return new Definition(
      validated.type,
      validated.typeVersion,
      createDefinitionId(validated.id),
      validated.name,
      validated.version,
      validated.tags,
      validated.globalArguments,
      validated.methods,
      validated.inputs,
      validated.checks,
      validated.driver,
      validated.driverConfig,
    );
  }

  /**
   * Creates a new Definition with upgraded attributes and an updated typeVersion.
   * Preserves the same id, name, version, tags, and inputs.
   *
   * @param original - The original definition to upgrade
   * @param newAttributes - The upgraded attributes
   * @param newTypeVersion - The CalVer version after upgrade
   * @returns A new Definition with upgraded attributes
   */
  static withUpgradedGlobalArguments(
    original: Definition,
    newGlobalArguments: Record<string, unknown>,
    newTypeVersion: string,
  ): Definition {
    return new Definition(
      original.type,
      newTypeVersion,
      original.id,
      original.name,
      original.version,
      { ...original._tags },
      structuredClone(newGlobalArguments),
      structuredClone(original._methods),
      original._inputs ? structuredClone(original._inputs) : undefined,
      original._checks ? structuredClone(original._checks) : undefined,
      original.driver,
      original.driverConfig
        ? structuredClone(original.driverConfig)
        : undefined,
    );
  }

  /**
   * Returns a copy of the tags.
   */
  get tags(): Record<string, string> {
    return { ...this._tags };
  }

  /**
   * Returns a copy of the global arguments.
   */
  get globalArguments(): Record<string, unknown> {
    return structuredClone(this._globalArguments);
  }

  /**
   * Returns a copy of the per-method data.
   */
  get methodData(): Record<string, MethodData> {
    return structuredClone(this._methods);
  }

  /**
   * Returns a copy of the inputs schema.
   */
  get inputs(): InputsSchema | undefined {
    return this._inputs ? structuredClone(this._inputs) : undefined;
  }

  /**
   * Returns a copy of the check selection (require/skip lists).
   */
  get checkSelection(): CheckSelection | undefined {
    return this._checks ? structuredClone(this._checks) : undefined;
  }

  /**
   * Sets a tag value.
   */
  setTag(key: string, value: string): void {
    this._tags[key] = value;
  }

  /**
   * Removes a tag.
   */
  removeTag(key: string): void {
    delete this._tags[key];
  }

  /**
   * Sets a global argument value.
   */
  setGlobalArgument(key: string, value: unknown): void {
    this._globalArguments[key] = value;
  }

  /**
   * Removes a global argument.
   */
  removeGlobalArgument(key: string): void {
    delete this._globalArguments[key];
  }

  /**
   * Gets the arguments for a specific method.
   */
  getMethodArguments(methodName: string): Record<string, unknown> {
    return structuredClone(this._methods[methodName]?.arguments ?? {});
  }

  /**
   * Sets a single argument for a specific method.
   */
  setMethodArgument(methodName: string, key: string, value: unknown): void {
    if (!this._methods[methodName]) {
      this._methods[methodName] = {};
    }
    if (!this._methods[methodName].arguments) {
      this._methods[methodName].arguments = {};
    }
    this._methods[methodName].arguments![key] = value;
  }

  /**
   * Sets all arguments for a specific method.
   */
  setMethodArguments(
    methodName: string,
    args: Record<string, unknown>,
  ): void {
    if (!this._methods[methodName]) {
      this._methods[methodName] = {};
    }
    this._methods[methodName].arguments = structuredClone(args);
  }

  /**
   * Sets the inputs schema.
   */
  setInputs(inputs: InputsSchema | undefined): void {
    this._inputs = inputs ? structuredClone(inputs) : undefined;
  }

  /**
   * Converts the definition to a plain data object for persistence.
   */
  toData(): DefinitionData {
    return {
      type: this.type,
      typeVersion: this.typeVersion,
      id: this.id,
      name: this.name,
      version: this.version,
      tags: { ...this._tags },
      globalArguments: structuredClone(this._globalArguments),
      methods: structuredClone(this._methods),
      inputs: this._inputs ? structuredClone(this._inputs) : undefined,
      checks: this._checks ? structuredClone(this._checks) : undefined,
      driver: this.driver,
      driverConfig: this.driverConfig
        ? structuredClone(this.driverConfig)
        : undefined,
    };
  }

  /**
   * Computes a hash of the definition for use as an instantiation ID.
   * This hash uniquely identifies the definition configuration.
   */
  async computeHash(): Promise<string> {
    const { type: _type, typeVersion: _tv, ...contentData } = this.toData();
    // Recursively sort keys for consistent hashing
    const sortedData = JSON.stringify(contentData, (_key, value) => {
      if (
        value !== null && typeof value === "object" && !Array.isArray(value)
      ) {
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(value).sort()) {
          sorted[k] = value[k];
        }
        return sorted;
      }
      return value;
    });
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(sortedData);
    const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
}
