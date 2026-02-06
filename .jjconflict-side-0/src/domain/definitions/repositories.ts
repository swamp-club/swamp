import type { ModelType } from "../models/model_type.ts";
import type { Definition, DefinitionId } from "./definition.ts";

/**
 * Repository interface for persisting and retrieving Definitions.
 */
export interface DefinitionRepository {
  /**
   * Finds a definition by its ID.
   *
   * @param type - The model type
   * @param id - The definition ID
   * @returns The definition if found, or null
   */
  findById(type: ModelType, id: DefinitionId): Promise<Definition | null>;

  /**
   * Finds all definitions of a given type.
   *
   * @param type - The model type
   * @returns Array of definitions
   */
  findAll(type: ModelType): Promise<Definition[]>;

  /**
   * Finds a definition by its name within a specific type.
   *
   * @param type - The model type
   * @param name - The definition name
   * @returns The definition if found, or null
   */
  findByName(type: ModelType, name: string): Promise<Definition | null>;

  /**
   * Finds a definition by its name across all model types.
   * Used to enforce global name uniqueness.
   *
   * @param name - The definition name
   * @returns The definition and its type if found, or null
   */
  findByNameGlobal(
    name: string,
  ): Promise<{ definition: Definition; type: ModelType } | null>;

  /**
   * Finds all definitions across all model types.
   *
   * @returns Array of all definitions with their types
   */
  findAllGlobal(): Promise<{ definition: Definition; type: ModelType }[]>;

  /**
   * Saves a definition.
   *
   * @param type - The model type
   * @param definition - The definition to save
   */
  save(type: ModelType, definition: Definition): Promise<void>;

  /**
   * Deletes a definition.
   *
   * @param type - The model type
   * @param id - The definition ID
   */
  delete(type: ModelType, id: DefinitionId): Promise<void>;

  /**
   * Generates a new unique ID.
   */
  nextId(): DefinitionId;

  /**
   * Returns the file path for a definition.
   *
   * @param type - The model type
   * @param id - The definition ID
   * @returns The file path
   */
  getPath(type: ModelType, id: DefinitionId): string;
}
