import { z } from "zod";
import { resolve } from "@std/path";
import { ModelType } from "./model_type.ts";
import { ModelResource } from "./model_resource.ts";
import { ModelData } from "./model_data.ts";
import type { ModelInput } from "./model_input.ts";
import {
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
  resource?: {
    id: string;
    attributes: Record<string, unknown>;
  };
  data?: {
    id: string;
    attributes: Record<string, unknown>;
  };
  [key: string]: unknown;
}

/**
 * User method execute function type.
 */
type UserExecuteFn = (
  input: ModelInput,
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
 * At least one of resourceAttributesSchema or dataAttributesSchema should be provided.
 */
const UserModelSchema = z.object({
  type: z.string(),
  version: z.number(),
  inputAttributesSchema: z.custom<z.ZodTypeAny>((val) =>
    val instanceof z.ZodType
  ),
  resourceAttributesSchema: z.custom<z.ZodTypeAny>((val) =>
    val instanceof z.ZodType
  ).optional(),
  dataAttributesSchema: z.custom<z.ZodTypeAny>((val) =>
    val instanceof z.ZodType
  ).optional(),
  methods: z.record(z.string(), UserMethodSchema),
}).refine(
  (data) => data.resourceAttributesSchema || data.dataAttributesSchema,
  {
    message:
      "Model must have at least one of resourceAttributesSchema or dataAttributesSchema",
  },
);

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
        execute: async (input, context): Promise<MethodResult> => {
          const userResult = await method.execute(input, context);

          // Convert plain resource object to ModelResource if present
          let resource: ModelResource | undefined;
          if (userResult.resource) {
            if (userResult.resource instanceof ModelResource) {
              resource = userResult.resource;
            } else {
              resource = ModelResource.create({
                id: userResult.resource.id,
                attributes: userResult.resource.attributes,
              });
            }
          }

          // Convert plain data object to ModelData if present
          let data: ModelData | undefined;
          if (userResult.data) {
            if (userResult.data instanceof ModelData) {
              data = userResult.data;
            } else {
              data = ModelData.create({
                id: userResult.data.id,
                attributes: userResult.data.attributes,
              });
            }
          }

          return { resource, data };
        },
      };
    }

    return {
      type: modelType,
      version: userModel.version,
      inputAttributesSchema: userModel.inputAttributesSchema,
      resourceAttributesSchema: userModel.resourceAttributesSchema,
      dataAttributesSchema: userModel.dataAttributesSchema,
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
