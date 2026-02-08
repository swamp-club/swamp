import { z } from "zod";
import { resolve } from "@std/path";
import { ModelType } from "./model_type.ts";
import type { Definition } from "../definitions/definition.ts";
import {
  type DataOutput,
  DataSpecType,
  type MethodContext,
  type MethodDefinition,
  type MethodResult,
  type ModelDefinition,
  modelRegistry,
} from "./model.ts";

/**
 * Plain object result returned by user methods before conversion.
 */
interface UserMethodResult {
  /**
   * Direct data outputs with explicit content and metadata.
   */
  dataOutputs?: Array<{
    name: string;
    specType?: string;
    content: Uint8Array | string;
    metadata?: {
      contentType?: string;
      lifetime?: string;
      garbageCollection?: number;
      streaming?: boolean;
      tags?: Record<string, string>;
    };
  }>;
  /**
   * Resource output - a simpler format that gets converted to dataOutputs.
   * The resource attributes are serialized as JSON and tagged with type=resource.
   */
  resource?: {
    id?: string;
    attributes: Record<string, unknown>;
  };
  /**
   * Data output - a simpler format that gets converted to dataOutputs.
   * The data attributes are serialized as JSON.
   */
  data?: {
    attributes: Record<string, unknown>;
    name?: string;
    tags?: Record<string, string>;
  };
  [key: string]: unknown;
}

/**
 * User method execute function type.
 * User models receive Definition.
 */
type UserExecuteFn = (
  definition: Definition,
  context: MethodContext,
) => Promise<UserMethodResult>;

/**
 * Schema for validating user method exports.
 */
const UserMethodSchema = z.object({
  description: z.string(),
  inputAttributesSchema: z.custom<z.ZodTypeAny>((val) =>
    val instanceof z.ZodType
  ).optional(),
  execute: z.custom<UserExecuteFn>((val) => typeof val === "function"),
}).passthrough();

/**
 * Schema for validating user model exports.
 */
const UserModelSchema = z.object({
  type: z.string(),
  version: z.number(),
  inputAttributesSchema: z.custom<z.ZodTypeAny>((val) =>
    val instanceof z.ZodType
  ),
  methods: z.record(z.string(), UserMethodSchema),
});

/**
 * Result of loading user models from a directory.
 */
export interface LoadResult {
  loaded: string[];
  failed: Array<{ file: string; error: string }>;
}

/**
 * Loader for user-defined TypeScript models.
 *
 * Users export a plain `model` object from their TypeScript files.
 * This loader validates the structure and registers models with the global registry.
 */
export class UserModelLoader {
  /**
   * Loads all user models from the specified directory.
   *
   * @param modelsDir - The directory containing user model files
   * @returns Result containing lists of loaded and failed files
   */
  async loadModels(modelsDir: string): Promise<LoadResult> {
    const result: LoadResult = { loaded: [], failed: [] };

    // Check if directory exists
    try {
      await Deno.stat(modelsDir);
    } catch {
      return result; // No user models directory - not an error
    }

    const files = await this.discoverModels(modelsDir);

    for (const file of files) {
      try {
        const absolutePath = resolve(modelsDir, file);
        const module = await import(`file://${absolutePath}`);

        if (!module.model) {
          result.failed.push({ file, error: "No 'model' export found" });
          continue;
        }

        // Validate the model structure
        const parsed = UserModelSchema.safeParse(module.model);
        if (!parsed.success) {
          result.failed.push({ file, error: parsed.error.message });
          continue;
        }

        // Convert to ModelDefinition and register
        const userModel = parsed.data;
        const modelDef = this.convertToModelDefinition(userModel);

        if (!modelRegistry.has(modelDef.type)) {
          modelRegistry.register(modelDef);
          result.loaded.push(file);
        } else {
          result.failed.push({
            file,
            error: `Model type '${userModel.type}' already registered`,
          });
        }
      } catch (error) {
        result.failed.push({ file, error: String(error) });
      }
    }

    return result;
  }

  /**
   * Converts a user model export to a proper ModelDefinition.
   */
  private convertToModelDefinition(
    userModel: z.infer<typeof UserModelSchema>,
  ): ModelDefinition {
    const modelType = ModelType.create(userModel.type);

    // Wrap user's execute functions to convert plain objects to proper entities
    const methods: Record<string, MethodDefinition> = {};
    for (const [name, method] of Object.entries(userModel.methods)) {
      methods[name] = {
        description: method.description,
        inputAttributesSchema: method.inputAttributesSchema ??
          userModel.inputAttributesSchema,
        execute: async (definition, context): Promise<MethodResult> => {
          const userResult = await method.execute(definition, context);
          const definitionHash = await definition.computeHash();

          // Convert user data outputs to proper DataOutput format
          const dataOutputs: DataOutput[] = [];

          // Handle resource output (simpler format)
          if (userResult.resource && userResult.resource.attributes) {
            const resourceJson = JSON.stringify(userResult.resource.attributes);
            dataOutputs.push({
              name: "resource",
              specType: DataSpecType.create("resource"),
              content: new TextEncoder().encode(resourceJson),
              metadata: {
                contentType: "application/json",
                lifetime: "infinite",
                garbageCollection: 10,
                streaming: false,
                tags: { type: "resource" },
                ownerDefinition: {
                  definitionHash,
                  ownerType: "model-method",
                  ownerRef: name,
                },
              },
            });
          }

          // Handle data output (simpler format)
          if (userResult.data && userResult.data.attributes) {
            const dataJson = JSON.stringify(userResult.data.attributes);
            dataOutputs.push({
              name: userResult.data.name ?? "data",
              specType: DataSpecType.create("data"),
              content: new TextEncoder().encode(dataJson),
              metadata: {
                contentType: "application/json",
                lifetime: "infinite",
                garbageCollection: 10,
                streaming: false,
                tags: userResult.data.tags ?? { type: "data" },
                ownerDefinition: {
                  definitionHash,
                  ownerType: "model-method",
                  ownerRef: name,
                },
              },
            });
          }

          // Handle explicit dataOutputs
          if (userResult.dataOutputs) {
            for (const output of userResult.dataOutputs) {
              const content = typeof output.content === "string"
                ? new TextEncoder().encode(output.content)
                : output.content;

              dataOutputs.push({
                name: output.name,
                specType: DataSpecType.create(output.specType ?? "data"),
                content,
                metadata: {
                  contentType: output.metadata?.contentType ??
                    "application/octet-stream",
                  lifetime: output.metadata?.lifetime ?? "infinite",
                  garbageCollection: output.metadata?.garbageCollection ?? 10,
                  streaming: output.metadata?.streaming ?? false,
                  tags: output.metadata?.tags ?? { type: "data" },
                  ownerDefinition: {
                    definitionHash,
                    ownerType: "model-method",
                    ownerRef: name,
                  },
                },
              });
            }
          }

          return { dataOutputs };
        },
      };
    }

    return {
      type: modelType,
      version: userModel.version,
      inputAttributesSchema: userModel.inputAttributesSchema,
      dataOutputSpecs: {},
      methods,
    };
  }

  /**
   * Discovers TypeScript model files in the given directory.
   * Excludes test files.
   */
  private async discoverModels(dir: string): Promise<string[]> {
    const files: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      if (
        entry.isFile && entry.name.endsWith(".ts") &&
        !entry.name.endsWith("_test.ts")
      ) {
        files.push(entry.name);
      }
    }
    return files.sort();
  }
}
