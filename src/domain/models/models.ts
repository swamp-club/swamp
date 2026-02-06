/**
 * Model registry barrel file.
 *
 * Importing this module triggers self-registration of all models.
 * Each model file uses defineModel() or defineAndRegister() at module level,
 * which registers the model with the global registry as a side effect.
 *
 * To add a new model:
 * 1. Create your model file (e.g., aws/s3/bucket/s3_bucket_model.ts)
 * 2. Use defineModel() or defineAndRegister() to define and register it
 * 3. Add an import for the file below
 */

// Import all model files to trigger registration
import "./echo/echo_model.ts";
import "./keeb/shell/shell_model.ts";
import "./systemd/journalctl/journalctl_model.ts";
import "./command/curl/curl_model.ts";
import "./aws/cli/aws_cli_model.ts";
import "./mermaid/workflow_diagram/workflow_diagram_model.ts";
import "./lets-get-sensitive/vault_model.ts";

// Import all of the AWS models - the models in this file are created by the clover pipeline
import "./aws/aws_models.ts";

// Re-export the registry for convenient access
export { modelRegistry } from "./model.ts";
