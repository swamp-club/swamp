import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import type { InputRepository } from "../../domain/models/repositories.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  createModelInputId,
  ModelInput,
  type ModelInputData,
  type ModelInputId,
} from "../../domain/models/model_input.ts";

/**
 * YAML-based implementation of InputRepository.
 *
 * Stores inputs as YAML files in the directory structure:
 * {repoDir}/data/inputs/{normalized-type}/{id}.yaml
 */
export class YamlInputRepository implements InputRepository {
  constructor(private readonly repoDir: string) {}

  async findById(
    type: ModelType,
    id: ModelInputId,
  ): Promise<ModelInput | null> {
    const path = this.getPath(type, id);
    try {
      const content = await Deno.readTextFile(path);
      const data = parseYaml(content) as ModelInputData;
      return ModelInput.fromData(data);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  async findAll(type: ModelType): Promise<ModelInput[]> {
    const dir = this.getTypeDir(type);
    const inputs: ModelInput[] = [];

    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(".yaml")) {
          const path = join(dir, entry.name);
          const content = await Deno.readTextFile(path);
          const data = parseYaml(content) as ModelInputData;
          inputs.push(ModelInput.fromData(data));
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return inputs;
  }

  async findByName(type: ModelType, name: string): Promise<ModelInput | null> {
    const inputs = await this.findAll(type);
    return inputs.find((input) => input.name === name) ?? null;
  }

  async findByNameGlobal(
    name: string,
  ): Promise<{ input: ModelInput; type: ModelType } | null> {
    const inputsDir = join(this.repoDir, "data", "inputs");
    return await this.searchInputByName(inputsDir, [], name);
  }

  /**
   * Recursively searches for an input file by name in nested directory structures.
   */
  private async searchInputByName(
    currentDir: string,
    pathSegments: string[],
    name: string,
  ): Promise<{ input: ModelInput; type: ModelType } | null> {
    try {
      for await (const entry of Deno.readDir(currentDir)) {
        const fullPath = join(currentDir, entry.name);

        if (entry.isFile && entry.name.endsWith(".yaml")) {
          // Found a YAML file, check if it matches the name
          const content = await Deno.readTextFile(fullPath);
          const data = parseYaml(content) as ModelInputData;
          const input = ModelInput.fromData(data);

          if (input.name === name) {
            // Reconstruct the model type from the path segments
            const typeStr = pathSegments.join("/");
            return { input, type: ModelType.create(typeStr) };
          }
        } else if (entry.isDirectory) {
          // Recursively search subdirectories
          const result = await this.searchInputByName(
            fullPath,
            [...pathSegments, entry.name],
            name,
          );
          if (result) {
            return result;
          }
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }

    return null;
  }

  /**
   * Finds all inputs across all model types in the repository.
   */
  async findAllGlobal(): Promise<{ input: ModelInput; type: ModelType }[]> {
    const inputsDir = join(this.repoDir, "data", "inputs");
    const results: { input: ModelInput; type: ModelType }[] = [];
    await this.collectAllInputs(inputsDir, [], results);
    return results;
  }

  /**
   * Recursively collects all input files from nested directory structures.
   */
  private async collectAllInputs(
    currentDir: string,
    pathSegments: string[],
    results: { input: ModelInput; type: ModelType }[],
  ): Promise<void> {
    try {
      for await (const entry of Deno.readDir(currentDir)) {
        const fullPath = join(currentDir, entry.name);

        if (entry.isFile && entry.name.endsWith(".yaml")) {
          // Found a YAML file, add it to results
          const content = await Deno.readTextFile(fullPath);
          const data = parseYaml(content) as ModelInputData;
          const input = ModelInput.fromData(data);

          // Reconstruct the model type from the path segments
          const typeStr = pathSegments.join("/");
          results.push({ input, type: ModelType.create(typeStr) });
        } else if (entry.isDirectory) {
          // Recursively search subdirectories
          await this.collectAllInputs(
            fullPath,
            [...pathSegments, entry.name],
            results,
          );
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  async save(type: ModelType, input: ModelInput): Promise<void> {
    const dir = this.getTypeDir(type);
    await ensureDir(dir);

    const path = this.getPath(type, input.id);
    const data = input.toData();
    // Remove undefined values since YAML can't stringify them
    const cleanData = JSON.parse(JSON.stringify(data));
    const content = stringifyYaml(cleanData as Record<string, unknown>);
    await Deno.writeTextFile(path, content);
  }

  async delete(type: ModelType, id: ModelInputId): Promise<void> {
    const path = this.getPath(type, id);
    try {
      await Deno.remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  nextId(): ModelInputId {
    return createModelInputId(crypto.randomUUID());
  }

  getPath(type: ModelType, id: ModelInputId): string {
    return join(this.getTypeDir(type), `${id}.yaml`);
  }

  private getTypeDir(type: ModelType): string {
    return join(this.repoDir, "data", "inputs", type.toDirectoryPath());
  }
}
