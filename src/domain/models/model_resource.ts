import { z } from "zod";
import type { ModelInputId } from "./model_input.ts";

/**
 * Branded type for ModelResource IDs.
 */
export type ModelResourceId = string & { readonly _brand: unique symbol };

/**
 * Creates a ModelResourceId from a string.
 */
export function createModelResourceId(id: string): ModelResourceId {
  return id as ModelResourceId;
}

/**
 * Converts a ModelInputId to a ModelResourceId.
 * Since we've unified the ID system, both types represent the same underlying UUID.
 */
export function inputIdToResourceId(
  inputId: ModelInputId,
): ModelResourceId {
  return inputId as unknown as ModelResourceId;
}

/**
 * Zod schema for the core properties of a ModelResource.
 */
export const ModelResourceSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  attributes: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Type representing the data stored in a ModelResource.
 */
export type ModelResourceData = z.infer<typeof ModelResourceSchema>;

/**
 * Properties required to create a new ModelResource.
 */
export interface CreateModelResourceProps {
  id?: string;
  version?: number;
  createdAt?: Date;
  attributes?: Record<string, unknown>;
}

/**
 * ModelResource is an entity representing the output/result of a model method execution.
 *
 * Each resource has a unique ID (UUID), a reference to its input, creation timestamp,
 * version, and domain-specific attributes.
 */
export class ModelResource {
  private constructor(
    readonly id: ModelResourceId,
    readonly version: number,
    readonly createdAt: Date,
    private _attributes: Record<string, unknown>,
  ) {}

  /**
   * Creates a new ModelResource instance.
   *
   * @param props - Properties for the new resource
   * @returns A new ModelResource instance
   */
  static create(props: CreateModelResourceProps): ModelResource {
    const id = props.id ?? crypto.randomUUID();
    const version = props.version ?? 1;
    const createdAt = props.createdAt ?? new Date();

    const validated = ModelResourceSchema.parse({
      id,
      version,
      createdAt: createdAt.toISOString(),
      attributes: props.attributes ?? {},
    });

    return new ModelResource(
      createModelResourceId(validated.id),
      validated.version,
      new Date(validated.createdAt),
      validated.attributes,
    );
  }

  /**
   * Reconstructs a ModelResource from persisted data.
   *
   * @param data - The persisted data
   * @returns A ModelResource instance
   */
  static fromData(data: ModelResourceData): ModelResource {
    const validated = ModelResourceSchema.parse(data);
    return new ModelResource(
      createModelResourceId(validated.id),
      validated.version,
      new Date(validated.createdAt),
      validated.attributes,
    );
  }

  /**
   * Returns a copy of the attributes.
   */
  get attributes(): Record<string, unknown> {
    return { ...this._attributes };
  }

  /**
   * Sets an attribute value.
   */
  setAttribute(key: string, value: unknown): void {
    this._attributes[key] = value;
  }

  /**
   * Converts the resource to a plain data object for persistence.
   */
  toData(): ModelResourceData {
    return {
      id: this.id,
      version: this.version,
      createdAt: this.createdAt.toISOString(),
      attributes: { ...this._attributes },
    };
  }
}
