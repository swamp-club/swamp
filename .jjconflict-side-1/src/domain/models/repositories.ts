import type { ModelType } from "./model_type.ts";
import type { ModelOutput, ModelOutputId } from "./model_output.ts";
import type { DefinitionId } from "../definitions/definition.ts";

/**
 * Repository interface for persisting and retrieving ModelOutputs.
 *
 * Stores outputs in the path structure:
 * /outputs/{normalized-type}/{method}/{model-id}-{timestamp}.yaml
 */
export interface OutputRepository {
  /**
   * Finds an output by its ID.
   *
   * @param type - The model type
   * @param method - The method name
   * @param id - The output ID
   * @returns The output if found, or null
   */
  findById(
    type: ModelType,
    method: string,
    id: ModelOutputId,
  ): Promise<ModelOutput | null>;

  /**
   * Finds all outputs for a given definition.
   *
   * @param type - The model type
   * @param definitionId - The definition ID
   * @returns Array of outputs
   */
  findByDefinition(
    type: ModelType,
    definitionId: DefinitionId,
  ): Promise<ModelOutput[]>;

  /**
   * Finds the latest output for a given definition.
   *
   * @param type - The model type
   * @param definitionId - The definition ID
   * @returns The latest output if found, or null
   */
  findLatestByDefinition(
    type: ModelType,
    definitionId: DefinitionId,
  ): Promise<ModelOutput | null>;

  /**
   * Finds all outputs of a given type.
   *
   * @param type - The model type
   * @returns Array of outputs
   */
  findAll(type: ModelType): Promise<ModelOutput[]>;

  /**
   * Finds all outputs across all types.
   *
   * @returns Array of all outputs with their types and methods
   */
  findAllGlobal(): Promise<
    { output: ModelOutput; type: ModelType; method: string }[]
  >;

  /**
   * Saves an output.
   *
   * @param type - The model type
   * @param method - The method name
   * @param output - The output to save
   */
  save(type: ModelType, method: string, output: ModelOutput): Promise<void>;

  /**
   * Deletes an output.
   *
   * @param type - The model type
   * @param method - The method name
   * @param id - The output ID
   */
  delete(type: ModelType, method: string, id: ModelOutputId): Promise<void>;

  /**
   * Generates a new unique ID.
   */
  nextId(): ModelOutputId;

  /**
   * Returns the file path for an output.
   *
   * @param type - The model type
   * @param method - The method name
   * @param output - The output
   * @returns The file path
   */
  getPath(type: ModelType, method: string, output: ModelOutput): string;
}
