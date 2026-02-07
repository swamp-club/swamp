import { z } from "zod";
import { join, resolve } from "@std/path";
import { ModelType } from "./model_type.ts";
import type { Definition } from "../definitions/definition.ts";
import {
  type DataOutput,
  type DataOutputSpecification,
  DataOutputSpecificationSchema,
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
  dataOutputSpecs: z.record(z.string(), DataOutputSpecificationSchema)
    .optional(),
  methods: z.record(z.string(), UserMethodSchema),
});

/**
 * Schema for validating user extension exports.
 */
const UserExtensionSchema = z.object({
  type: z.string(),
  methods: z.array(z.record(z.string(), UserMethodSchema)),
});

/**
 * Result of loading user models from a directory.
 */
export interface LoadResult {
  loaded: string[];
  extended: string[];
  failed: Array<{ file: string; error: string }>;
}

/**
 * Loader for user-defined TypeScript models and extensions.
 *
 * Users export a plain `model` object to define new types, or an `extension`
 * object to add methods to existing types.
 * This loader validates the structure and registers/extends models with the global registry.
 */
export class UserModelLoader {
  /**
   * Loads all user models and extensions from the specified directory.
   * Uses two-pass loading: models first, then extensions.
   *
   * @param modelsDir - The directory containing user model/extension files
   * @returns Result containing lists of loaded, extended, and failed files
   */
  async loadModels(modelsDir: string): Promise<LoadResult> {
    const result: LoadResult = { loaded: [], extended: [], failed: [] };

    // Check if directory exists
    try {
      await Deno.stat(modelsDir);
    } catch {
      return result; // No user models directory - not an error
    }

    const files = await this.discoverFiles(modelsDir);

    // Import all files and classify by export name
    const modelFiles: Array<{
      file: string;
      module: Record<string, unknown>;
    }> = [];
    const extensionFiles: Array<{
      file: string;
      module: Record<string, unknown>;
    }> = [];
    const unknownFiles: string[] = [];

    for (const file of files) {
      try {
        const absolutePath = resolve(modelsDir, file);
        const module = await import(`file://${absolutePath}`);

        if (module.model) {
          modelFiles.push({ file, module });
        } else if (module.extension) {
          extensionFiles.push({ file, module });
        } else {
          unknownFiles.push(file);
        }
      } catch (error) {
        result.failed.push({ file, error: String(error) });
      }
    }

    // Pass 1: Process all model exports (register new types)
    for (const { file, module } of modelFiles) {
      try {
        const parsed = UserModelSchema.safeParse(module.model);
        if (!parsed.success) {
          result.failed.push({ file, error: parsed.error.message });
          continue;
        }

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

    // Pass 2: Process all extension exports (extend existing types)
    for (const { file, module } of extensionFiles) {
      try {
        this.processExtension(file, module.extension, result);
      } catch (error) {
        result.failed.push({ file, error: String(error) });
      }
    }

    // Files with neither export
    for (const file of unknownFiles) {
      result.failed.push({
        file,
        error: "No 'model' or 'extension' export found",
      });
    }

    return result;
  }

  /**
   * Processes an extension export and extends the target model type.
   */
  private processExtension(
    file: string,
    extensionExport: unknown,
    result: LoadResult,
  ): void {
    const parsed = UserExtensionSchema.safeParse(extensionExport);
    if (!parsed.success) {
      result.failed.push({ file, error: parsed.error.message });
      return;
    }

    const ext = parsed.data;

    // Flatten methods array into a single record, checking for duplicate names
    const flatMethods: Record<
      string,
      z.infer<typeof UserMethodSchema>
    > = {};
    for (const methodRecord of ext.methods) {
      for (const [name, method] of Object.entries(methodRecord)) {
        if (flatMethods[name]) {
          result.failed.push({
            file,
            error:
              `Duplicate method name '${name}' within extension methods array`,
          });
          return;
        }
        flatMethods[name] = method;
      }
    }

    // Get the target model's inputAttributesSchema for methods without their own
    const targetModel = modelRegistry.get(ext.type);
    if (!targetModel) {
      result.failed.push({
        file,
        error: `Cannot extend unregistered model type: ${ext.type}`,
      });
      return;
    }

    // Convert extension methods using wrapUserExecute
    const methods: Record<string, MethodDefinition> = {};
    for (const [name, method] of Object.entries(flatMethods)) {
      methods[name] = {
        description: method.description,
        inputAttributesSchema: method.inputAttributesSchema ??
          targetModel.inputAttributesSchema,
        execute: this.wrapUserExecute(name, method.execute),
      };
    }

    // Extend the model
    try {
      modelRegistry.extend(ext.type, methods);
      result.extended.push(file);
    } catch (error) {
      result.failed.push({ file, error: String(error) });
    }
  }

  /**
   * Wraps a user execute function to convert UserMethodResult to MethodResult
   * with proper DataOutput format.
   */
  private wrapUserExecute(
    methodName: string,
    userExecuteFn: UserExecuteFn,
  ): (definition: Definition, context: MethodContext) => Promise<MethodResult> {
    return async (definition, context): Promise<MethodResult> => {
      const userResult = await userExecuteFn(definition, context);
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
              ownerRef: methodName,
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
              ownerRef: methodName,
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
                ownerRef: methodName,
              },
            },
          });
        }
      }

      return { dataOutputs };
    };
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
        execute: this.wrapUserExecute(name, method.execute),
      };
    }

    const defaultSpecs: Record<string, DataOutputSpecification> = {
      "data": {
        specType: DataSpecType.create("data"),
        description: "Data output",
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "data" },
      },
      "resource": {
        specType: DataSpecType.create("resource"),
        description: "Resource output",
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        tags: { type: "resource" },
      },
    };

    // User-declared specs need specType converted from string to DataSpecType
    const userSpecs: Record<string, DataOutputSpecification> = {};
    if (userModel.dataOutputSpecs) {
      for (const [key, spec] of Object.entries(userModel.dataOutputSpecs)) {
        userSpecs[key] = {
          ...spec,
          specType: DataSpecType.create(String(spec.specType)),
        };
      }
    }

    return {
      type: modelType,
      version: userModel.version,
      inputAttributesSchema: userModel.inputAttributesSchema,
      dataOutputSpecs: { ...defaultSpecs, ...userSpecs },
      methods,
    };
  }

  /**
   * Recursively discovers TypeScript files in the given directory.
   * Returns relative paths (e.g., "aws/ec2_start.ts", "echo_audit.ts").
   * Excludes test files.
   */
  private async discoverFiles(
    dir: string,
    prefix = "",
  ): Promise<string[]> {
    const files: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      const relativePath = prefix ? join(prefix, entry.name) : entry.name;
      if (entry.isDirectory) {
        const nested = await this.discoverFiles(
          join(dir, entry.name),
          relativePath,
        );
        files.push(...nested);
      } else if (
        entry.isFile && entry.name.endsWith(".ts") &&
        !entry.name.endsWith("_test.ts")
      ) {
        files.push(relativePath);
      }
    }
    return files.sort();
  }
}
