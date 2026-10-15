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

import { assertEquals } from "@std/assert";
import {
  isRetentionExempt,
  RETENTION_EXEMPT_MODEL_TYPES,
} from "./retention_exemptions.ts";
import { SERVER_TOKEN_MODEL_TYPE } from "../models/access/server_token_model.ts";
import { GRANT_MODEL_TYPE } from "../models/access/grant_model.ts";
import { GROUP_MODEL_TYPE } from "../models/access/group_model.ts";
import { ENROLLMENT_TOKEN_MODEL_TYPE } from "../models/worker/enrollment_token_model.ts";
import { WORKER_MODEL_TYPE } from "../models/worker/worker_model.ts";
import { STEP_LEASE_MODEL_TYPE } from "../models/worker/step_lease_model.ts";
import { PENDING_DISPATCH_MODEL_TYPE } from "../models/worker/pending_dispatch_model.ts";
import { FLEET_PROBE_MODEL_TYPE } from "../models/worker/fleet_probe_model.ts";

Deno.test("isRetentionExempt: covers every built-in access and serve state type", () => {
  const types = [
    SERVER_TOKEN_MODEL_TYPE,
    GRANT_MODEL_TYPE,
    GROUP_MODEL_TYPE,
    ENROLLMENT_TOKEN_MODEL_TYPE,
    WORKER_MODEL_TYPE,
    STEP_LEASE_MODEL_TYPE,
    PENDING_DISPATCH_MODEL_TYPE,
    FLEET_PROBE_MODEL_TYPE,
  ];
  for (const type of types) {
    assertEquals(isRetentionExempt(type.normalized), true, type.normalized);
    // The access commands store grants and groups under the @ form.
    assertEquals(
      isRetentionExempt(`@${type.normalized}`),
      true,
      `@${type.normalized}`,
    );
    assertEquals(
      RETENTION_EXEMPT_MODEL_TYPES.includes(`@${type.normalized}`),
      true,
    );
  }
});

Deno.test("isRetentionExempt: user and extension types are not exempt", () => {
  for (
    const type of [
      "command/shell",
      "@acme/grant",
      "workflow",
      "swamp/other",
    ]
  ) {
    assertEquals(isRetentionExempt(type), false, type);
  }
});
