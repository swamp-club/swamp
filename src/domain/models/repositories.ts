import type { ModelType } from "./model_type.ts";
import type { ModelInput, ModelInputId } from "./model_input.ts";
import type { ModelResource, ModelResourceId } from "./model_resource.ts";
import type { ModelData, ModelDataId } from "./model_data.ts";
import type { ModelFile, ModelFileId } from "./model_file.ts";
import type { LogEntry, ModelLog, ModelLogId } from "./model_log.ts";
import type { ModelOutput, ModelOutputId } from "./model_output.ts";

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

/**
 * Repository interface for persisting and retrieving ModelData.
 */
export interface DataRepository {
  /**
   * Finds a data artifact by its ID.
   *
   * @param type - The model type
   * @param id - The data ID
   * @returns The data if found, or null
   */
  findById(type: ModelType, id: ModelDataId): Promise<ModelData | null>;

  /**
   * Finds all data artifacts of a given type.
   *
   * @param type - The model type
   * @returns Array of data artifacts
   */
  findAll(type: ModelType): Promise<ModelData[]>;

  /**
   * Saves a data artifact.
   *
   * @param type - The model type
   * @param data - The data to save
   */
  save(type: ModelType, data: ModelData): Promise<void>;

  /**
   * Deletes a data artifact.
   *
   * @param type - The model type
   * @param id - The data ID
   */
  delete(type: ModelType, id: ModelDataId): Promise<void>;

  /**
   * Generates a new unique ID.
   */
  nextId(): ModelDataId;

  /**
   * Returns the file path for a data artifact.
   *
   * @param type - The model type
   * @param id - The data ID
   * @returns The file path
   */
  getPath(type: ModelType, id: ModelDataId): string;
}

/**
 * Repository interface for persisting and retrieving ModelFiles.
 *
 * Stores files in the path structure:
 * /files/{normalized-type}/{model-id}/{method-name}/{actual-filename}
 */
export interface FileRepository {
  /**
   * Finds a file artifact by its ID.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param methodName - The method name
   * @param id - The file ID
   * @returns The file metadata if found, or null
   */
  findById(
    type: ModelType,
    modelId: string,
    methodName: string,
    id: ModelFileId,
  ): Promise<ModelFile | null>;

  /**
   * Finds all file artifacts of a given type.
   *
   * @param type - The model type
   * @returns Array of file metadata
   */
  findAll(type: ModelType): Promise<ModelFile[]>;

  /**
   * Saves a file artifact with its content.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param methodName - The method name
   * @param file - The file metadata
   * @param content - The file content
   */
  save(
    type: ModelType,
    modelId: string,
    methodName: string,
    file: ModelFile,
    content: Uint8Array,
  ): Promise<void>;

  /**
   * Gets the content of a file artifact.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param methodName - The method name
   * @param file - The file metadata (for filename)
   * @returns The file content if found, or null
   */
  getContent(
    type: ModelType,
    modelId: string,
    methodName: string,
    file: ModelFile,
  ): Promise<Uint8Array | null>;

  /**
   * Deletes a file artifact and its content.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param methodName - The method name
   * @param file - The file metadata (for filename)
   */
  delete(
    type: ModelType,
    modelId: string,
    methodName: string,
    file: ModelFile,
  ): Promise<void>;

  /**
   * Generates a new unique ID.
   */
  nextId(): ModelFileId;

  /**
   * Returns the metadata file path for a file artifact.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param methodName - The method name
   * @param id - The file ID
   * @returns The metadata file path
   */
  getPath(
    type: ModelType,
    modelId: string,
    methodName: string,
    id: ModelFileId,
  ): string;

  /**
   * Returns the content file path for a file artifact.
   *
   * @param type - The model type
   * @param modelId - The model input ID
   * @param methodName - The method name
   * @param file - The file metadata (for filename)
   * @returns The content file path
   */
  getContentPath(
    type: ModelType,
    modelId: string,
    methodName: string,
    file: ModelFile,
  ): string;
}

/**
 * Repository interface for persisting and retrieving ModelLogs.
 * Supports streaming writes for log entries.
 */
export interface LogRepository {
  /**
   * Finds a log artifact by its ID.
   *
   * @param type - The model type
   * @param id - The log ID
   * @returns The log if found, or null
   */
  findById(type: ModelType, id: ModelLogId): Promise<ModelLog | null>;

  /**
   * Finds all log artifacts of a given type.
   *
   * @param type - The model type
   * @returns Array of logs
   */
  findAll(type: ModelType): Promise<ModelLog[]>;

  /**
   * Saves a complete log artifact.
   *
   * @param type - The model type
   * @param log - The log to save
   */
  save(type: ModelType, log: ModelLog): Promise<void>;

  /**
   * Appends a single entry to an existing log (streaming support).
   *
   * @param type - The model type
   * @param id - The log ID
   * @param entry - The entry to append
   */
  append(type: ModelType, id: ModelLogId, entry: LogEntry): Promise<void>;

  /**
   * Reads log entries as an async iterable (streaming support).
   *
   * @param type - The model type
   * @param id - The log ID
   * @returns Async iterable of log entries
   */
  stream(type: ModelType, id: ModelLogId): AsyncIterable<LogEntry>;

  /**
   * Deletes a log artifact.
   *
   * @param type - The model type
   * @param id - The log ID
   */
  delete(type: ModelType, id: ModelLogId): Promise<void>;

  /**
   * Generates a new unique ID.
   */
  nextId(): ModelLogId;

  /**
   * Returns the file path for a log artifact.
   *
   * @param type - The model type
   * @param id - The log ID
   * @returns The file path
   */
  getPath(type: ModelType, id: ModelLogId): string;
}

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
   * Finds all outputs for a given model input.
   *
   * @param type - The model type
   * @param inputId - The model input ID
   * @returns Array of outputs
   */
  findByModelInput(
    type: ModelType,
    inputId: ModelInputId,
  ): Promise<ModelOutput[]>;

  /**
   * Finds the latest output for a given model input.
   *
   * @param type - The model type
   * @param inputId - The model input ID
   * @returns The latest output if found, or null
   */
  findLatestByModelInput(
    type: ModelType,
    inputId: ModelInputId,
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
