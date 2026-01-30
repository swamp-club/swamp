import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import type { DataRepository } from "../../domain/models/repositories.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import {
  createModelDataId,
  ModelData,
  type ModelDataData,
  type ModelDataId,
} from "../../domain/models/model_data.ts";

/**
 * YAML-based implementation of DataRepository.
 *
 * Stores data artifacts as YAML files in the directory structure:
 * {repoDir}/data/data/{normalized-type}/{id}.yaml
 */
export class YamlDataRepository implements DataRepository {
  constructor(private readonly repoDir: string) {}

  async findById(
    type: ModelType,
    id: ModelDataId,
  ): Promise<ModelData | null> {
    const path = this.getPath(type, id);
    try {
      const content = await Deno.readTextFile(path);
      const data = parseYaml(content) as ModelDataData;
      return ModelData.fromData(data);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  async findAll(type: ModelType): Promise<ModelData[]> {
    const dir = this.getTypeDir(type);
    const dataArtifacts: ModelData[] = [];

    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(".yaml")) {
          const path = join(dir, entry.name);
          const content = await Deno.readTextFile(path);
          const data = parseYaml(content) as ModelDataData;
          dataArtifacts.push(ModelData.fromData(data));
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return dataArtifacts;
  }

  async save(type: ModelType, data: ModelData): Promise<void> {
    const dir = this.getTypeDir(type);
    await ensureDir(dir);

    const path = this.getPath(type, data.id);
    const dataObj = data.toData();
    // Remove undefined values since YAML can't stringify them
    const cleanData = JSON.parse(JSON.stringify(dataObj));
    const content = stringifyYaml(cleanData as Record<string, unknown>);
    await Deno.writeTextFile(path, content);
  }

  async delete(type: ModelType, id: ModelDataId): Promise<void> {
    const path = this.getPath(type, id);
    try {
      await Deno.remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  nextId(): ModelDataId {
    return createModelDataId(crypto.randomUUID());
  }

  getPath(type: ModelType, id: ModelDataId): string {
    return join(this.getTypeDir(type), `${id}.yaml`);
  }

  private getTypeDir(type: ModelType): string {
    return join(this.repoDir, "data", "data", type.toDirectoryPath());
  }
}
