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

import "./command/shell/shell_model.ts";

import "./worker/worker_model.ts";
import "./worker/enrollment_token_model.ts";
import "./worker/step_lease_model.ts";
import "./worker/pending_dispatch_model.ts";
import "./worker/fleet_probe_model.ts";

import "./access/grant_model.ts";
import "./access/group_model.ts";
import "./access/delegation_model.ts";
import "./access/integration_model.ts";
import "./access/server_token_model.ts";

import "./aws/aws_models.ts";

export { modelRegistry } from "./model.ts";

import { modelRegistry } from "./model.ts";
import { CONTROL_PLANE_MODEL_TYPES } from "./control_plane_types.ts";
for (const type of CONTROL_PLANE_MODEL_TYPES) {
  modelRegistry.markInternal(type);
}
