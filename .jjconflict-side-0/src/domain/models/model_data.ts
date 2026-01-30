import { z } from "zod";
import type { ModelInputId } from "./model_input.ts";

/**
 * Branded type for ModelData IDs.
 */
export type ModelDataId = string & { readonly _brand: unique symbol };

/**
 * Creates a ModelDataId from a string.
 */
export function createModelDataId(id: string): ModelDataId {
  return id as ModelDataId;
}

/**
 * Converts a ModelInputId to a ModelDataId.
 * By convention, data artifacts share their ID with their originating input.
 */
export function inputIdToDataId(inputId: ModelInputId): ModelDataId {
  return inputId as unknown as ModelDataId;
}

/**
 * Zod schema for the core properties of a ModelData.
 */
export const ModelDataSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  attributes: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Type representing the data stored in a ModelData.
 */
export type ModelDataData = z.infer<typeof ModelDataSchema>;

/**
 * Properties required to create a new ModelData.
 */
export interface CreateModelDataProps {
  id?: string;
  version?: number;
  createdAt?: Date;
  attributes?: Record<string, unknown>;
}

/**
 * ModelData is an entity representing structured data output produced by methods.
 *
 * Each data artifact has a unique ID (UUID), creation timestamp,
 * version, and domain-specific attributes.
 */
export class ModelData {
  private constructor(
    readonly id: ModelDataId,
    readonly version: number,
    readonly createdAt: Date,
    private _attributes: Record<string, unknown>,
  ) {}

  /**
   * Creates a new ModelData instance.
   *
   * @param props - Properties for the new data artifact
   * @returns A new ModelData instance
   */
  static create(props: CreateModelDataProps): ModelData {
    const id = props.id ?? crypto.randomUUID();
    const version = props.version ?? 1;
    const createdAt = props.createdAt ?? new Date();

    const validated = ModelDataSchema.parse({
      id,
      version,
      createdAt: createdAt.toISOString(),
      attributes: props.attributes ?? {},
    });

    return new ModelData(
      createModelDataId(validated.id),
      validated.version,
      new Date(validated.createdAt),
      validated.attributes,
    );
  }

  /**
   * Reconstructs a ModelData from persisted data.
   *
   * @param data - The persisted data
   * @returns A ModelData instance
   */
  static fromData(data: ModelDataData): ModelData {
    const validated = ModelDataSchema.parse(data);
    return new ModelData(
      createModelDataId(validated.id),
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
   * Converts the data artifact to a plain data object for persistence.
   */
  toData(): ModelDataData {
    return {
      id: this.id,
      version: this.version,
      createdAt: this.createdAt.toISOString(),
      attributes: { ...this._attributes },
    };
  }
}
