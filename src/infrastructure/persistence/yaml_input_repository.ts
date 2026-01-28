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
 * {repoDir}/inputs/{normalized-type}/{id}.yaml
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
    const inputsDir = join(this.repoDir, "inputs");

    try {
      // Iterate through all type directories
      for await (const vendorEntry of Deno.readDir(inputsDir)) {
        if (!vendorEntry.isDirectory) continue;

        const vendorDir = join(inputsDir, vendorEntry.name);
        for await (const typeEntry of Deno.readDir(vendorDir)) {
          if (!typeEntry.isDirectory) continue;

          const typeDir = join(vendorDir, typeEntry.name);
          // Read all inputs in this type directory
          for await (const fileEntry of Deno.readDir(typeDir)) {
            if (!fileEntry.isFile || !fileEntry.name.endsWith(".yaml")) continue;

            const path = join(typeDir, fileEntry.name);
            const content = await Deno.readTextFile(path);
            const data = parseYaml(content) as ModelInputData;
            const input = ModelInput.fromData(data);

            if (input.name === name) {
              // Reconstruct the model type from the directory path
              const typeStr = `${vendorEntry.name}/${typeEntry.name}`;
              return { input, type: ModelType.create(typeStr) };
            }
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
    return join(this.repoDir, "inputs", type.toDirectoryPath());
  }
}
