/**
 * Initializes the model registry with all known model types.
 *
 * This module should be imported at application startup to ensure
 * all models are registered before any commands run.
 */
import { modelRegistry } from "./model.ts";
import { echoModel } from "./echo/echo_model.ts";

/**
 * Registers all model definitions with the global registry.
 * Safe to call multiple times - will not re-register existing models.
 */
export function initializeModelRegistry(): void {
  if (!modelRegistry.has(echoModel.type)) {
    modelRegistry.register(echoModel);
  }
}

// Auto-register on import
initializeModelRegistry();
