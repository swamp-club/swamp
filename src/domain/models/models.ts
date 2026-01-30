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
import "./aws/ec2/instance/ec2_instance_model.ts";
import "./aws/ec2/subnet/ec2_subnet_model.ts";
import "./aws/ec2/vpc/ec2_vpc_model.ts";
import "./keeb/shell/shell_model.ts";
import "./systemd/journalctl/journalctl_model.ts";
import "./command/curl/curl_model.ts";

// Re-export the registry for convenient access
export { modelRegistry } from "./model.ts";
