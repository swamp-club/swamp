/**
 * Model registry initialization.
 *
 * This module re-exports from the auto-generated registry file.
 * The generated file is created by `deno task generate:models` which
 * scans for *_model.ts files and creates static imports.
 *
 * To add a new model:
 * 1. Create your model file (e.g., aws/s3/bucket/s3_bucket_model.ts)
 * 2. Export a ModelDefinition named with pattern `xxxModel`
 * 3. Run `deno task generate:models` (or `deno task compile` which runs it)
 *
 * That's it! The generator will find your model and add it to the registry.
 */
export {
  ensureModelRegistryInitialized,
  getRegisteredModelCount,
  initializeModelRegistry,
} from "./registry.generated.ts";
