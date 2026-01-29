import { z } from "zod";

/**
 * Branded type for ModelInput IDs.
 */
export type ModelInputId = string & { readonly _brand: unique symbol };

/**
 * Creates a ModelInputId from a string.
 */
export function createModelInputId(id: string): ModelInputId {
  return id as ModelInputId;
}

/**
 * Zod schema for the core properties of a ModelInput.
 */
export const ModelInputSchema = z.object({
  id: z.string().uuid(),
  resourceId: z.string().uuid().optional(),
  name: z.string().min(1),
  version: z.number().int().positive(),
  tags: z.record(z.string(), z.string()).default({}),
  attributes: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Type representing the data stored in a ModelInput.
 */
export type ModelInputData = z.infer<typeof ModelInputSchema>;

/**
 * Properties required to create a new ModelInput.
 */
export interface CreateModelInputProps {
  id?: string;
  name: string;
  version?: number;
  resourceId?: string;
  tags?: Record<string, string>;
  attributes?: Record<string, unknown>;
}

/**
 * ModelInput is an entity representing the input configuration for a model instance.
 *
 * Each input has a unique ID (UUID), a human-readable name, version, optional tags,
 * and domain-specific attributes.
 */
export class ModelInput {
  private constructor(
    readonly id: ModelInputId,
    private _resourceId: string | undefined,
    readonly name: string,
    readonly version: number,
    private _tags: Record<string, string>,
    private _attributes: Record<string, unknown>,
  ) {}

  /**
   * Creates a new ModelInput instance.
   *
   * @param props - Properties for the new input
   * @returns A new ModelInput instance
   */
  static create(props: CreateModelInputProps): ModelInput {
    const id = props.id ?? crypto.randomUUID();
    const version = props.version ?? 1;

    const validated = ModelInputSchema.parse({
      id,
      resourceId: props.resourceId,
      name: props.name,
      version,
      tags: props.tags ?? {},
      attributes: props.attributes ?? {},
    });

    return new ModelInput(
      createModelInputId(validated.id),
      validated.resourceId,
      validated.name,
      validated.version,
      validated.tags,
      validated.attributes,
    );
  }

  /**
   * Reconstructs a ModelInput from persisted data.
   *
   * @param data - The persisted data
   * @returns A ModelInput instance
   */
  static fromData(data: ModelInputData): ModelInput {
    const validated = ModelInputSchema.parse(data);
    return new ModelInput(
      createModelInputId(validated.id),
      validated.resourceId,
      validated.name,
      validated.version,
      validated.tags,
      validated.attributes,
    );
  }

  /**
   * Returns the resource ID if one has been assigned.
   */
  get resourceId(): string | undefined {
    return this._resourceId;
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
    return { ...this._attributes };
  }

  /**
   * Sets the resource ID for this input.
   */
  setResourceId(resourceId: string): void {
    this._resourceId = resourceId;
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
   * Converts the input to a plain data object for persistence.
   */
  toData(): ModelInputData {
    return {
      id: this.id,
      resourceId: this._resourceId,
      name: this.name,
      version: this.version,
      tags: { ...this._tags },
      attributes: { ...this._attributes },
    };
  }
}
