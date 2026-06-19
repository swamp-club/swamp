// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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
import "./command/shell/shell_model.ts";

// Remote-execution control-plane models (worker pool, enrollment tokens,
// step leases) — see design/remote-execution.md.
import "./worker/worker_model.ts";
import "./worker/enrollment_token_model.ts";
import "./worker/step_lease_model.ts";

// Access control models (grants, groups, server tokens) — see
// src/domain/access/ for the bounded context's shared value objects.
import "./access/grant_model.ts";
import "./access/group_model.ts";
import "./access/server_token_model.ts";

// Import all of the AWS models - the models in this file are created by the clover pipeline
import "./aws/aws_models.ts";

// Re-export the registry for convenient access
export { modelRegistry } from "./model.ts";

// Built-in infrastructure types are hidden from user-facing discovery
// commands (swamp type search, shell completions, model create suggestions).
import { modelRegistry } from "./model.ts";
for (
  const type of [
    "swamp/enrollment-token",
    "swamp/worker",
    "swamp/step-lease",
    "swamp/server-token",
    "swamp/grant",
    "swamp/group",
  ]
) {
  modelRegistry.markInternal(type);
}
