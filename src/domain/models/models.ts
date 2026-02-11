// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

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
