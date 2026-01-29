import type { ModelType } from "./model_type.ts";
import type { ModelInput, ModelInputId } from "./model_input.ts";
import type { ModelResource, ModelResourceId } from "./model_resource.ts";

/**
 * Repository interface for persisting and retrieving ModelInputs.
 */
export interface InputRepository {
  /**
   * Finds an input by its ID.
   *
   * @param type - The model type
   * @param id - The input ID
   * @returns The input if found, or null
   */
  findById(type: ModelType, id: ModelInputId): Promise<ModelInput | null>;

  /**
   * Finds all inputs of a given type.
   *
   * @param type - The model type
   * @returns Array of inputs
   */
  findAll(type: ModelType): Promise<ModelInput[]>;

  /**
   * Finds an input by its name within a specific type.
   *
   * @param type - The model type
   * @param name - The input name
   * @returns The input if found, or null
   */
  findByName(type: ModelType, name: string): Promise<ModelInput | null>;

  /**
   * Finds an input by its name across all model types.
   * Used to enforce global name uniqueness.
   *
   * @param name - The input name
   * @returns The input and its type if found, or null
   */
  findByNameGlobal(
    name: string,
  ): Promise<{ input: ModelInput; type: ModelType } | null>;

  /**
   * Saves an input.
   *
   * @param type - The model type
   * @param input - The input to save
   */
  save(type: ModelType, input: ModelInput): Promise<void>;

  /**
   * Deletes an input.
   *
   * @param type - The model type
   * @param id - The input ID
   */
  delete(type: ModelType, id: ModelInputId): Promise<void>;

  /**
   * Generates a new unique ID.
   */
  nextId(): ModelInputId;

  /**
   * Returns the file path for an input.
   *
   * @param type - The model type
   * @param id - The input ID
   * @returns The file path
   */
  getPath(type: ModelType, id: ModelInputId): string;
}

/**
 * Repository interface for persisting and retrieving ModelResources.
 */
export interface ResourceRepository {
  /**
   * Finds a resource by its ID.
   *
   * @param type - The model type
   * @param id - The resource ID
   * @returns The resource if found, or null
   */
  findById(type: ModelType, id: ModelResourceId): Promise<ModelResource | null>;

  /**
   * Finds all resources of a given type.
   *
   * @param type - The model type
   * @returns Array of resources
   */
  findAll(type: ModelType): Promise<ModelResource[]>;

  /**
   * Finds a resource by its input ID.
   *
   * @param type - The model type
   * @param inputId - The input ID
   * @returns The resource if found, or null
   */
  findByInputId(
    type: ModelType,
    inputId: ModelInputId,
  ): Promise<ModelResource | null>;

  /**
   * Saves a resource.
   *
   * @param type - The model type
   * @param resource - The resource to save
   */
  save(type: ModelType, resource: ModelResource): Promise<void>;

  /**
   * Deletes a resource.
   *
   * @param type - The model type
   * @param id - The resource ID
   */
  delete(type: ModelType, id: ModelResourceId): Promise<void>;

  /**
   * Generates a new unique ID.
   */
  nextId(): ModelResourceId;

  /**
   * Returns the file path for a resource.
   *
   * @param type - The model type
   * @param id - The resource ID
   * @returns The file path
   */
  getPath(type: ModelType, id: ModelResourceId): string;
}
