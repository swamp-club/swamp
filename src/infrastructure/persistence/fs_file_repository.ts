import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import type { FileRepository } from "../../domain/models/repositories.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import {
  createModelFileId,
  ModelFile,
  type ModelFileData,
  type ModelFileId,
} from "../../domain/models/model_file.ts";

/**
 * Metadata file schema stored alongside the content.
 */
interface FileMetadata extends ModelFileData {
  contentFilename: string;
}

/**
 * File system implementation of FileRepository.
 *
 * Stores file artifacts with metadata and content as separate files:
 * - Metadata: {repoDir}/files/{normalized-type}/{model-id}/{method-name}/{file-id}.yaml
 * - Content:  {repoDir}/files/{normalized-type}/{model-id}/{method-name}/{actual-filename}
 */
export class FileSystemFileRepository implements FileRepository {
  constructor(private readonly repoDir: string) {}

  async findById(
    type: ModelType,
    modelId: string,
    methodName: string,
    id: ModelFileId,
  ): Promise<ModelFile | null> {
    const metadataPath = this.getPath(type, modelId, methodName, id);
    try {
      const content = await Deno.readTextFile(metadataPath);
      const metadata = parseYaml(content) as FileMetadata;
      return ModelFile.fromData(metadata);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  async findAll(type: ModelType): Promise<ModelFile[]> {
    const baseDir = this.getTypeDir(type);
    const files: ModelFile[] = [];

    try {
      // Walk through model-id directories
      for await (const modelEntry of Deno.readDir(baseDir)) {
        if (!modelEntry.isDirectory) continue;

        const modelDir = join(baseDir, modelEntry.name);
        // Walk through method-name directories
        for await (const methodEntry of Deno.readDir(modelDir)) {
          if (!methodEntry.isDirectory) continue;

          const methodDir = join(modelDir, methodEntry.name);
          // Find yaml metadata files
          for await (const fileEntry of Deno.readDir(methodDir)) {
            if (fileEntry.isFile && fileEntry.name.endsWith(".yaml")) {
              const path = join(methodDir, fileEntry.name);
              const content = await Deno.readTextFile(path);
              const metadata = parseYaml(content) as FileMetadata;
              files.push(ModelFile.fromData(metadata));
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return files;
  }

  async save(
    type: ModelType,
    modelId: string,
    methodName: string,
    file: ModelFile,
    content: Uint8Array,
  ): Promise<void> {
    const dir = this.getFileDir(type, modelId, methodName);
    await ensureDir(dir);

    // Use actual filename for content storage
    const contentFilename = file.filename;

    // Save metadata
    const metadataPath = this.getPath(type, modelId, methodName, file.id);
    const metadata: FileMetadata = {
      ...file.toData(),
      contentFilename,
    };
    // Remove undefined values since YAML can't stringify them
    const cleanData = JSON.parse(JSON.stringify(metadata));
    const metadataContent = stringifyYaml(cleanData as Record<string, unknown>);
    await Deno.writeTextFile(metadataPath, metadataContent);

    // Save content using actual filename
    const contentPath = this.getContentPath(type, modelId, methodName, file);
    await Deno.writeFile(contentPath, content);
  }

  async getContent(
    type: ModelType,
    modelId: string,
    methodName: string,
    file: ModelFile,
  ): Promise<Uint8Array | null> {
    const contentPath = this.getContentPath(type, modelId, methodName, file);
    try {
      return await Deno.readFile(contentPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  async delete(
    type: ModelType,
    modelId: string,
    methodName: string,
    file: ModelFile,
  ): Promise<void> {
    const metadataPath = this.getPath(type, modelId, methodName, file.id);
    const contentPath = this.getContentPath(type, modelId, methodName, file);

    // Delete both files, ignoring NotFound errors
    try {
      await Deno.remove(metadataPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    try {
      await Deno.remove(contentPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  nextId(): ModelFileId {
    return createModelFileId(crypto.randomUUID());
  }

  getPath(
    type: ModelType,
    modelId: string,
    methodName: string,
    id: ModelFileId,
  ): string {
    return join(this.getFileDir(type, modelId, methodName), `${id}.yaml`);
  }

  getContentPath(
    type: ModelType,
    modelId: string,
    methodName: string,
    file: ModelFile,
  ): string {
    return join(this.getFileDir(type, modelId, methodName), file.filename);
  }

  private getTypeDir(type: ModelType): string {
    return join(this.repoDir, "files", type.toDirectoryPath());
  }

  private getFileDir(
    type: ModelType,
    modelId: string,
    methodName: string,
  ): string {
    return join(this.getTypeDir(type), modelId, methodName);
  }
}
