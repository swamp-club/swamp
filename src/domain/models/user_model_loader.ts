import { z } from "zod";
import { join, resolve } from "@std/path";
import { ModelType } from "./model_type.ts";
import { CalVer } from "./calver.ts";
import type { Definition } from "../definitions/definition.ts";
import {
  type DataHandle,
  type DataOutputSpecification,
  DataOutputSpecificationSchema,
  DataSpecType,
  type MethodContext,
  type MethodDefinition,
  type MethodResult,
  type ModelDefinition,
  modelRegistry,
  type VersionUpgrade,
} from "./model.ts";

/**
 * Plain object result returned by user methods before conversion.
 * User models must use context.createDataWriter() to produce data.
 */
interface UserMethodResult {
  /**
   * Handles for data written via context.createDataWriter() during execution.
   */
  dataHandles?: DataHandle[];
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
 * Schema for validating a user-supplied upgrade step.
 */
const UserUpgradeSchema = z.object({
  toVersion: z.string().refine(CalVer.isValid, {
    message: "toVersion must be valid CalVer (YYYY.MM.DD.MICRO)",
  }),
  description: z.string(),
  upgradeAttributes: z.custom<
    (old: Record<string, unknown>) => Record<string, unknown>
  >((val) => typeof val === "function"),
});

/**
 * Schema for validating user model exports.
 */
const UserModelSchema = z.object({
  type: z.string(),
  version: z.string().refine(CalVer.isValid, {
    message: "version must be valid CalVer (YYYY.MM.DD.MICRO)",
  }),
  inputAttributesSchema: z.custom<z.ZodTypeAny>((val) =>
    val instanceof z.ZodType
  ),
  dataOutputSpecs: z.record(z.string(), DataOutputSpecificationSchema),
  methods: z.record(z.string(), UserMethodSchema),
  upgrades: z.array(UserUpgradeSchema).optional(),
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
 * Allowed namespaces for user-defined models.
 * Currently only "user" is allowed. When authentication is added,
 * the authenticated username will be added to this list.
 */
const ALLOWED_NAMESPACES = ["user"];

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

        // Validate namespace before registration
        const namespaceError = this.validateUserNamespace(userModel.type);
        if (namespaceError) {
          result.failed.push({ file, error: namespaceError });
          continue;
        }

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
   * Validates that a user-defined model type follows the required namespace conventions.
   *
   * Requirements:
   * - Must start with '@' (user namespace prefix)
   * - Must use an allowed namespace (currently only "user")
   * - Must have at least 2 segments (e.g., "@user/echo")
   * - Must not use reserved namespaces (swamp, si)
   *
   * @param rawType - The raw type string from the user model
   * @returns Error message if validation fails, undefined if valid
   */
  private validateUserNamespace(rawType: string): string | undefined {
    const normalized = ModelType.create(rawType).normalized;

    // Check for reserved built-in namespaces
    if (ModelType.isReservedNamespace(normalized)) {
      return `Model type '${rawType}' uses a reserved namespace. User models cannot use 'swamp' or 'si' namespaces.`;
    }

    // Must start with '@'
    if (!ModelType.isUserNamespace(normalized)) {
      return `Model type '${rawType}' must use '@' prefix. Expected format: @user/<name> (e.g., @user/my-model)`;
    }

    // Must use an allowed namespace
    const namespace = ModelType.getUserNamespace(normalized);
    if (!namespace || !ALLOWED_NAMESPACES.includes(namespace)) {
      return `Model type '${rawType}' uses namespace '${namespace}' which is not allowed. Currently only '@user' namespace is allowed.`;
    }

    // Must have at least 2 segments
    const segmentCount = ModelType.getSegmentCount(normalized);
    if (segmentCount < 2) {
      return `Model type '${rawType}' must have at least 2 segments. Expected format: @user/<name> (e.g., @user/my-model)`;
    }

    return undefined;
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
        execute: this.wrapUserExecute(method.execute),
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
   * Wraps a user execute function to pass through dataHandles from the result.
   * User models write data via context.createDataWriter() and return handles.
   */
  private wrapUserExecute(
    userExecuteFn: UserExecuteFn,
  ): (definition: Definition, context: MethodContext) => Promise<MethodResult> {
    return async (definition, context): Promise<MethodResult> => {
      const userResult = await userExecuteFn(definition, context);

      return { dataHandles: userResult.dataHandles };
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
        execute: this.wrapUserExecute(method.execute),
      };
    }

    // User-declared specs need specType converted from string to DataSpecType
    const userSpecs: Record<string, DataOutputSpecification> = {};
    for (const [key, spec] of Object.entries(userModel.dataOutputSpecs)) {
      userSpecs[key] = {
        ...spec,
        specType: DataSpecType.create(String(spec.specType)),
      };
    }

    // Convert user upgrades to VersionUpgrade[]
    const upgrades: VersionUpgrade[] | undefined = userModel.upgrades?.map(
      (u) => ({
        toVersion: u.toVersion,
        description: u.description,
        upgradeAttributes: u.upgradeAttributes,
      }),
    );

    return {
      type: modelType,
      version: userModel.version,
      inputAttributesSchema: userModel.inputAttributesSchema,
      dataOutputSpecs: { ...userSpecs },
      methods,
      ...(upgrades && upgrades.length > 0 ? { upgrades } : {}),
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
