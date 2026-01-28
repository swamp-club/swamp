import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import type { ResourceRepository } from "../../domain/models/repositories.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import type { ModelInputId } from "../../domain/models/model_input.ts";
import {
  createModelResourceId,
  ModelResource,
  type ModelResourceData,
  type ModelResourceId,
} from "../../domain/models/model_resource.ts";

/**
 * YAML-based implementation of ResourceRepository.
 *
 * Stores resources as YAML files in the directory structure:
 * {repoDir}/resources/{normalized-type}/{id}.yaml
 */
export class YamlResourceRepository implements ResourceRepository {
  constructor(private readonly repoDir: string) {}

  async findById(
    type: ModelType,
    id: ModelResourceId,
  ): Promise<ModelResource | null> {
    const path = this.getPath(type, id);
    try {
      const content = await Deno.readTextFile(path);
      const data = parseYaml(content) as ModelResourceData;
      return ModelResource.fromData(data);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  async findAll(type: ModelType): Promise<ModelResource[]> {
    const dir = this.getTypeDir(type);
    const resources: ModelResource[] = [];

    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(".yaml")) {
          const path = join(dir, entry.name);
          const content = await Deno.readTextFile(path);
          const data = parseYaml(content) as ModelResourceData;
          resources.push(ModelResource.fromData(data));
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return resources;
  }

  async findByInputId(
    type: ModelType,
    inputId: ModelInputId,
  ): Promise<ModelResource | null> {
    const resources = await this.findAll(type);
    return resources.find((resource) => resource.inputId === inputId) ?? null;
  }

  async save(type: ModelType, resource: ModelResource): Promise<void> {
    const dir = this.getTypeDir(type);
    await ensureDir(dir);

    const path = this.getPath(type, resource.id);
    const data = resource.toData();
    // Remove undefined values since YAML can't stringify them
    const cleanData = JSON.parse(JSON.stringify(data));
    const content = stringifyYaml(cleanData as Record<string, unknown>);
    await Deno.writeTextFile(path, content);
  }

  async delete(type: ModelType, id: ModelResourceId): Promise<void> {
    const path = this.getPath(type, id);
    try {
      await Deno.remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  nextId(): ModelResourceId {
    return createModelResourceId(crypto.randomUUID());
  }

  getPath(type: ModelType, id: ModelResourceId): string {
    return join(this.getTypeDir(type), `${id}.yaml`);
  }

  private getTypeDir(type: ModelType): string {
    return join(this.repoDir, "resources", type.toDirectoryPath());
  }
}
