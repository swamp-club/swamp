/**
 * Initializes the model registry with all known model types.
 *
 * This module should be imported at application startup to ensure
 * all models are registered before any commands run.
 */
import { modelRegistry } from "./model.ts";
import { echoModel } from "./echo/echo_model.ts";
import { ec2InstanceModel } from "./aws/ec2/instance/ec2_instance_model.ts";

/**
 * Registers all model definitions with the global registry.
 * Safe to call multiple times - will not re-register existing models.
 */
export function initializeModelRegistry(): void {
  if (!modelRegistry.has(echoModel.type)) {
    modelRegistry.register(echoModel);
  }
  if (!modelRegistry.has(ec2InstanceModel.type)) {
    modelRegistry.register(ec2InstanceModel);
  }
}

// Auto-register on import
initializeModelRegistry();
