import { z } from "zod";

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
 */
export const DefinitionSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  version: z.number().int().positive(),
  tags: z.record(z.string(), z.string()).default({}),
  attributes: z.record(z.string(), z.unknown()).default({}),
  inputs: InputsSchemaSchema,
});

/**
 * Type representing the data stored in a Definition.
 */
export type DefinitionData = z.infer<typeof DefinitionSchema>;

/**
 * Properties required to create a new Definition.
 */
export interface CreateDefinitionProps {
  id?: string;
  name: string;
  version?: number;
  tags?: Record<string, string>;
  attributes?: Record<string, unknown>;
  inputs?: InputsSchema;
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
    readonly id: DefinitionId,
    readonly name: string,
    readonly version: number,
    private _tags: Record<string, string>,
    private _attributes: Record<string, unknown>,
    private _inputs: InputsSchema | undefined,
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
      id,
      name: props.name,
      version,
      tags: props.tags ?? {},
      attributes: props.attributes ?? {},
      inputs: props.inputs,
    });

    return new Definition(
      createDefinitionId(validated.id),
      validated.name,
      validated.version,
      validated.tags,
      validated.attributes,
      validated.inputs,
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
      createDefinitionId(validated.id),
      validated.name,
      validated.version,
      validated.tags,
      validated.attributes,
      validated.inputs,
    );
  }

  /**
   * Returns a copy of the tags.
   */
  get tags(): Record<string, string> {
    return { ...this._tags };
  }

  /**
   * Returns a copy of the attributes.
   */
  get attributes(): Record<string, unknown> {
    return structuredClone(this._attributes);
  }

  /**
   * Returns a copy of the inputs schema.
   */
  get inputs(): InputsSchema | undefined {
    return this._inputs ? structuredClone(this._inputs) : undefined;
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
   * Sets an attribute value.
   */
  setAttribute(key: string, value: unknown): void {
    this._attributes[key] = value;
  }

  /**
   * Removes an attribute.
   */
  removeAttribute(key: string): void {
    delete this._attributes[key];
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
      id: this.id,
      name: this.name,
      version: this.version,
      tags: { ...this._tags },
      attributes: structuredClone(this._attributes),
      inputs: this._inputs ? structuredClone(this._inputs) : undefined,
    };
  }

  /**
   * Computes a hash of the definition for use as an instantiation ID.
   * This hash uniquely identifies the definition configuration.
   */
  async computeHash(): Promise<string> {
    const data = this.toData();
    // Sort keys for consistent hashing
    const sortedData = JSON.stringify(data, Object.keys(data).sort());
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(sortedData);
    const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
}
