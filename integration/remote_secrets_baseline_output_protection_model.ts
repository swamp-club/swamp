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
 * Fixture model for the output-protection baseline (swamp-club#3512). Its
 * `fail` method puts its `secret` argument in a method log line, a console
 * line and the thrown error, so a test can see which of those reach serve
 * redacted and which do not.
 */

import { z } from "zod";
import { defineModel, type MethodContext } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";

export const OUTPUT_BASELINE_TYPE = ModelType.create(
  "swamp/secrets-baseline-output",
);

defineModel({
  type: OUTPUT_BASELINE_TYPE,
  version: "2026.10.15.1",
  resources: {
    "out": {
      description: "a resource the test writes over the data plane",
      schema: z.object({ note: z.string() }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  files: {
    "log": {
      description: "a file the test writes over the data plane",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 5,
      streaming: true,
    },
  },
  methods: {
    fail: {
      description: "logs and throws its secret argument",
      kind: "action",
      arguments: z.object({ secret: z.string() }),
      execute: (args, context: MethodContext) => {
        const { secret } = args as { secret: string };
        context.logger.info("method log line {value}", { value: secret });
        console.log(`console line ${secret}`);
        throw new Error(`method failed holding ${secret}`);
      },
    },
  },
});
