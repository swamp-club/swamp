import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { cleanupEmptyParentDirs } from "./directory_cleanup.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import type { OutputRepository } from "../../domain/models/repositories.ts";
import type { ModelInputId } from "../../domain/models/model_input.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import {
  createModelOutputId,
  ModelOutput,
  type ModelOutputData,
  type ModelOutputId,
} from "../../domain/models/model_output.ts";
import { modelRegistry } from "../../domain/models/model.ts";

/**
 * YAML-based implementation of OutputRepository.
 *
 * Stores outputs as YAML files in the directory structure:
 * {repoDir}/.data/outputs/{normalized-type}/{method}/{model-id}-{timestamp}.yaml
 */
export class YamlOutputRepository implements OutputRepository {
  constructor(private readonly repoDir: string) {}

  async findById(
    type: ModelType,
    method: string,
    id: ModelOutputId,
  ): Promise<ModelOutput | null> {
    // We need to scan the directory since the filename includes a timestamp
    const dir = this.getMethodDir(type, method);
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(".yaml")) {
          const path = join(dir, entry.name);
          const content = await Deno.readTextFile(path);
          const data = parseYaml(content) as ModelOutputData;
          if (data.id === id) {
            return ModelOutput.fromData(data);
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

  async findByModelInput(
    type: ModelType,
    inputId: ModelInputId,
  ): Promise<ModelOutput[]> {
    const all = await this.findAll(type);
    return all.filter((output) => output.modelInputId === inputId);
  }

  async findLatestByModelInput(
    type: ModelType,
    inputId: ModelInputId,
  ): Promise<ModelOutput | null> {
    const outputs = await this.findByModelInput(type, inputId);
    if (outputs.length === 0) {
      return null;
    }

    // Sort by startedAt descending and return the first one
    outputs.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    return outputs[0];
  }

  async findAll(type: ModelType): Promise<ModelOutput[]> {
    const typeDir = this.getTypeDir(type);
    const outputs: ModelOutput[] = [];

    try {
      // Iterate over method directories
      for await (const methodEntry of Deno.readDir(typeDir)) {
        if (methodEntry.isDirectory) {
          const methodDir = join(typeDir, methodEntry.name);
          // Iterate over output files in method directory
          for await (const entry of Deno.readDir(methodDir)) {
            if (entry.isFile && entry.name.endsWith(".yaml")) {
              const path = join(methodDir, entry.name);
              const content = await Deno.readTextFile(path);
              const data = parseYaml(content) as ModelOutputData;
              outputs.push(ModelOutput.fromData(data));
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

    return outputs;
  }

  async findAllGlobal(): Promise<
    { output: ModelOutput; type: ModelType; method: string }[]
  > {
    const results: { output: ModelOutput; type: ModelType; method: string }[] =
      [];

    // Iterate over all registered model types
    for (const modelType of modelRegistry.types()) {
      const typeOutputs = await this.findAll(modelType);
      for (const output of typeOutputs) {
        results.push({
          output,
          type: modelType,
          method: output.methodName,
        });
      }
    }

    return results;
  }

  async save(
    type: ModelType,
    method: string,
    output: ModelOutput,
  ): Promise<void> {
    const dir = this.getMethodDir(type, method);
    await ensureDir(dir);

    const path = this.getPath(type, method, output);
    const data = output.toData();
    // Remove undefined values since YAML can't stringify them
    const cleanData = JSON.parse(JSON.stringify(data));
    const content = stringifyYaml(cleanData as Record<string, unknown>);
    await Deno.writeTextFile(path, content);
  }

  async delete(
    type: ModelType,
    method: string,
    id: ModelOutputId,
  ): Promise<void> {
    // We need to find the file first since filename includes timestamp
    const dir = this.getMethodDir(type, method);
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(".yaml")) {
          const path = join(dir, entry.name);
          const content = await Deno.readTextFile(path);
          const data = parseYaml(content) as ModelOutputData;
          if (data.id === id) {
            await Deno.remove(path);

            // Clean up empty parent directories
            const outputsDir = join(this.repoDir, ".data", "outputs");
            await cleanupEmptyParentDirs(path, outputsDir);
            return;
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  nextId(): ModelOutputId {
    return createModelOutputId(crypto.randomUUID());
  }

  getPath(type: ModelType, method: string, output: ModelOutput): string {
    const timestamp = output.startedAt.toISOString().replace(/[:.]/g, "-");
    const filename = `${output.modelInputId}-${timestamp}.yaml`;
    return join(this.getMethodDir(type, method), filename);
  }

  private getOutputsDir(): string {
    return join(this.repoDir, ".data", "outputs");
  }

  private getTypeDir(type: ModelType): string {
    return join(this.getOutputsDir(), type.normalized);
  }

  private getMethodDir(type: ModelType, method: string): string {
    return join(this.getTypeDir(type), method);
  }
}
