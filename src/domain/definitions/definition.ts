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

import { z } from "zod";
import {
  GarbageCollectionSchema,
  LifetimeSchema,
} from "../data/data_metadata.ts";
import { rejectRemovedDriverFields } from "../removed_driver_fields.ts";
import {
  type ReportSelection,
  ReportSelectionSchema,
} from "../reports/report_selection.ts";

export type DefinitionId = string & { readonly _brand: unique symbol };

export function createDefinitionId(id: string): DefinitionId {
  return id as DefinitionId;
}

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

export interface InputsSchema {
  type?: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaProperty;
  [key: string]: unknown;
}

export const RequiredInputsSchemaSchema: z.ZodType<InputsSchema> = z
  .object({
    type: z.literal("object").optional(),
    properties: z.record(z.string(), JsonSchemaPropertySchema).optional(),
    required: z.array(z.string()).optional(),
    additionalProperties: z.union([z.boolean(), JsonSchemaPropertySchema])
      .optional(),
  })
  .passthrough();

export const InputsSchemaSchema: z.ZodType<InputsSchema | undefined> =
  RequiredInputsSchemaSchema.optional();

/**
 * a malformed typeVersion must survive loading (a number is stringified):
 * definitions are hand-edited, and rejecting here would make them unloadable by
 * the very command used to diagnose them
 */
export const MethodDataSchema = z.object({
  arguments: z.record(z.string(), z.unknown()).optional(),
});

export const CheckSelectionSchema = z.object({
  require: z.array(z.string()).optional(),
  skip: z.array(z.string()).optional(),
}).optional();

export type CheckSelection = {
  require?: string[];
  skip?: string[];
};

const ResourceOverrideSchema = z.object({
  lifetime: LifetimeSchema.optional(),
  garbageCollection: GarbageCollectionSchema.optional(),
  vaultName: z.string().min(1).optional(),
});

export type ResourceOverride = z.infer<typeof ResourceOverrideSchema>;

export type ResourceOverrides = Record<string, ResourceOverride>;

const DEFINITION_NAME_MAX_LENGTH = 64;
const DEFINITION_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** legacy names that fail the strict pattern fall back to UUID-based filenames */
export function isFilenameSafeDefinitionName(name: string): boolean {
  return (
    DEFINITION_NAME_PATTERN.test(name) &&
    name.length <= DEFINITION_NAME_MAX_LENGTH
  );
}

const definitionNameBase = z.string().min(1).refine(
  (name) => {
    if (name.includes("..") || name.includes("\\") || name.includes("\0")) {
      return false;
    }
    if (name.includes("/")) {
      return /^@[a-z0-9_-]+\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/.test(name);
    }
    return true;
  },
  {
    message:
      "Definition name must not contain '..', '\\', or null bytes (path traversal). '/' is only allowed in scoped @collective/name patterns.",
  },
);

const definitionNameStrict = definitionNameBase
  .refine(
    (name) => name.includes("/") || DEFINITION_NAME_PATTERN.test(name),
    {
      message:
        "Definition name must be lowercase alphanumeric with hyphens or underscores (e.g. 'my-server'). Must start with a letter or number.",
    },
  )
  .refine(
    (name) => name.length <= DEFINITION_NAME_MAX_LENGTH,
    {
      message:
        `Definition name must be at most ${DEFINITION_NAME_MAX_LENGTH} characters.`,
    },
  );

export function definitionNameViolation(name: string): string | undefined {
  const result = definitionNameStrict.safeParse(name);
  return result.success ? undefined : result.error.issues[0]?.message;
}

const DefinitionObjectSchema = z.object({
  type: z.string().optional(),
  typeVersion: z.preprocess(
    (val) => (typeof val === "number" ? String(val) : val),
    z.string().optional(),
  ),
  id: z.string().uuid(),
  name: definitionNameBase,
  description: z.string().optional(),
  version: z.number().int().positive(),
  tags: z.record(z.string(), z.string()).default({}),
  globalArguments: z.record(z.string(), z.unknown()).default({}),
  methods: z.record(z.string(), MethodDataSchema).default({}),
  inputs: InputsSchemaSchema,
  checks: CheckSelectionSchema,
  reports: ReportSelectionSchema,
  resources: z.record(z.string(), ResourceOverrideSchema).optional(),
});

const DefinitionStrictObjectSchema = z.object({
  type: z.string().optional(),
  typeVersion: z.preprocess(
    (val) => (typeof val === "number" ? String(val) : val),
    z.string().optional(),
  ),
  id: z.string().uuid(),
  name: definitionNameStrict,
  description: z.string().optional(),
  version: z.number().int().positive(),
  tags: z.record(z.string(), z.string()).default({}),
  globalArguments: z.record(z.string(), z.unknown()).default({}),
  methods: z.record(z.string(), MethodDataSchema).default({}),
  inputs: InputsSchemaSchema,
  checks: CheckSelectionSchema,
  reports: ReportSelectionSchema,
  resources: z.record(z.string(), ResourceOverrideSchema).optional(),
});

/** uses permissive name validation so existing definitions still load */
export const DefinitionSchema = z.preprocess(
  rejectRemovedDriverFields,
  DefinitionObjectSchema,
);

const DefinitionStrictSchema = z.preprocess(
  rejectRemovedDriverFields,
  DefinitionStrictObjectSchema,
);

export type DefinitionData = z.infer<typeof DefinitionObjectSchema>;

export type MethodData = z.infer<typeof MethodDataSchema>;

export interface CreateDefinitionProps {
  type?: string;
  typeVersion?: string;
  id?: string;
  name: string;
  description?: string;
  version?: number;
  tags?: Record<string, string>;
  globalArguments?: Record<string, unknown>;
  methods?: Record<string, MethodData>;
  inputs?: InputsSchema;
  checks?: CheckSelection;
  reports?: ReportSelection;
  resources?: ResourceOverrides;
}

export class Definition {
  private constructor(
    readonly type: string | undefined,
    readonly typeVersion: string | undefined,
    readonly id: DefinitionId,
    readonly name: string,
    readonly description: string | undefined,
    readonly version: number,
    private _tags: Record<string, string>,
    private _globalArguments: Record<string, unknown>,
    private _methods: Record<string, MethodData>,
    private _inputs: InputsSchema | undefined,
    private _checks: CheckSelection | undefined,
    private _reports: ReportSelection | undefined,
    private _resources: ResourceOverrides | undefined,
  ) {}

  static create(props: CreateDefinitionProps): Definition {
    const id = props.id ?? crypto.randomUUID();
    const version = props.version ?? 1;

    const validated = DefinitionStrictSchema.parse({
      type: props.type,
      typeVersion: props.typeVersion,
      id,
      name: props.name,
      description: props.description,
      version,
      tags: props.tags ?? {},
      globalArguments: props.globalArguments ?? {},
      methods: props.methods ?? {},
      inputs: props.inputs,
      checks: props.checks,
      reports: props.reports,
      resources: props.resources,
    });

    return new Definition(
      validated.type,
      validated.typeVersion,
      createDefinitionId(validated.id),
      validated.name,
      validated.description,
      validated.version,
      validated.tags,
      validated.globalArguments,
      validated.methods,
      validated.inputs,
      validated.checks,
      validated.reports,
      validated.resources,
    );
  }

  static fromData(data: DefinitionData): Definition {
    const validated = DefinitionSchema.parse(data);
    return new Definition(
      validated.type,
      validated.typeVersion,
      createDefinitionId(validated.id),
      validated.name,
      validated.description,
      validated.version,
      validated.tags,
      validated.globalArguments,
      validated.methods,
      validated.inputs,
      validated.checks,
      validated.reports,
      validated.resources,
    );
  }

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
      original.description,
      original.version,
      { ...original._tags },
      structuredClone(newGlobalArguments),
      structuredClone(original._methods),
      original._inputs ? structuredClone(original._inputs) : undefined,
      original._checks ? structuredClone(original._checks) : undefined,
      original._reports ? structuredClone(original._reports) : undefined,
      original._resources ? structuredClone(original._resources) : undefined,
    );
  }

  get tags(): Record<string, string> {
    return { ...this._tags };
  }

  get globalArguments(): Record<string, unknown> {
    return structuredClone(this._globalArguments);
  }

  get methodData(): Record<string, MethodData> {
    return structuredClone(this._methods);
  }

  get inputs(): InputsSchema | undefined {
    return this._inputs ? structuredClone(this._inputs) : undefined;
  }

  get checkSelection(): CheckSelection | undefined {
    return this._checks ? structuredClone(this._checks) : undefined;
  }

  get reportSelection(): ReportSelection | undefined {
    return this._reports ? structuredClone(this._reports) : undefined;
  }

  setTag(key: string, value: string): void {
    this._tags[key] = value;
  }

  removeTag(key: string): void {
    delete this._tags[key];
  }

  setGlobalArgument(key: string, value: unknown): void {
    this._globalArguments[key] = value;
  }

  removeGlobalArgument(key: string): void {
    delete this._globalArguments[key];
  }

  getMethodArguments(methodName: string): Record<string, unknown> {
    return structuredClone(this._methods[methodName]?.arguments ?? {});
  }

  setMethodArgument(methodName: string, key: string, value: unknown): void {
    if (!this._methods[methodName]) {
      this._methods[methodName] = {};
    }
    if (!this._methods[methodName].arguments) {
      this._methods[methodName].arguments = {};
    }
    this._methods[methodName].arguments![key] = value;
  }

  setMethodArguments(
    methodName: string,
    args: Record<string, unknown>,
  ): void {
    if (!this._methods[methodName]) {
      this._methods[methodName] = {};
    }
    this._methods[methodName].arguments = structuredClone(args);
  }

  setInputs(inputs: InputsSchema | undefined): void {
    this._inputs = inputs ? structuredClone(inputs) : undefined;
  }

  get resources(): ResourceOverrides | undefined {
    return this._resources;
  }

  toData(): DefinitionData {
    return {
      type: this.type,
      typeVersion: this.typeVersion,
      id: this.id,
      name: this.name,
      description: this.description,
      version: this.version,
      tags: { ...this._tags },
      globalArguments: structuredClone(this._globalArguments),
      methods: structuredClone(this._methods),
      inputs: this._inputs ? structuredClone(this._inputs) : undefined,
      checks: this._checks ? structuredClone(this._checks) : undefined,
      reports: this._reports ? structuredClone(this._reports) : undefined,
      resources: this._resources ? structuredClone(this._resources) : undefined,
    };
  }

  async computeHash(): Promise<string> {
    const {
      type: _type,
      typeVersion: _tv,
      description: _desc,
      ...contentData
    } = this.toData();
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
