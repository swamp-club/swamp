import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import type { ModelType } from "../../domain/models/model_type.ts";
import {
  ModelInput,
  type ModelInputData,
  type ModelInputId,
} from "../../domain/models/model_input.ts";

/**
 * Repository for storing evaluated model inputs.
 *
 * Writes to {repoDir}/inputs-evaluated/{normalized-type}/{id}.yaml
 * This directory contains inputs with all expressions resolved.
 */
export class YamlEvaluatedInputRepository {
  constructor(private readonly repoDir: string) {}

  /**
   * Finds an evaluated input by its ID.
   */
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

  /**
   * Finds all evaluated inputs of a given type.
   */
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

  /**
   * Saves an evaluated input.
   */
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

  /**
   * Deletes an evaluated input.
   */
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

  /**
   * Clears all evaluated inputs.
   */
  async clear(): Promise<void> {
    const dir = join(this.repoDir, "inputs-evaluated");
    try {
      await Deno.remove(dir, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  /**
   * Returns the file path for an evaluated input.
   */
  getPath(type: ModelType, id: ModelInputId): string {
    return join(this.getTypeDir(type), `${id}.yaml`);
  }

  private getTypeDir(type: ModelType): string {
    return join(this.repoDir, "inputs-evaluated", type.toDirectoryPath());
  }
}
