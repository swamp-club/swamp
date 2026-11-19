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

import { ModelType } from "../model_type.ts";
import { defineModel, type ModelDefinition } from "../model.ts";
import { PolicyReleaseSchema } from "../../access/policy_release.ts";

export const POLICY_RELEASE_MODEL_TYPE = ModelType.create(
  "swamp/policy-release",
);

export const POLICY_RELEASE_ID = "00000000-0000-4000-8000-000000000002";
export const POLICY_RELEASE_DATA_NAME = "release-main";
export const POLICY_RELEASE_DEFINITION_NAME = "policy-release";

/**
 * no methods: only a leading serve writes it, by a direct record write, so no
 * model run can publish a policy to the followers
 */
export const policyReleaseModel: ModelDefinition = defineModel({
  type: POLICY_RELEASE_MODEL_TYPE,
  version: "2026.11.19.1",
  resources: {
    "release": {
      description:
        "The policy the leading serve enforces, which its followers enforce in turn",
      schema: PolicyReleaseSchema,
      lifetime: "infinite",
      garbageCollection: 2,
    },
  },
  methods: {},
});
