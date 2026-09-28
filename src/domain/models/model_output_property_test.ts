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
import { assert } from "@std/assert";
import fc from "fast-check";
import { type ExecutionProvenance, ModelOutput } from "./model_output.ts";
import { createDefinitionId } from "../definitions/definition.ts";

const provenance: ExecutionProvenance = {
  definitionHash: "abc123",
  modelVersion: "2026.02.09.1",
  triggeredBy: "manual",
};

// Bounded so toISOString never throws for a reason unrelated to the invariant.
const timestamp = fc.date({
  min: new Date("2000-01-01T00:00:00.000Z"),
  max: new Date("2100-01-01T00:00:00.000Z"),
  noInvalidDate: true,
});

Deno.test("ModelOutput: any completed output survives a toData/fromData round-trip", () => {
  fc.assert(
    fc.property(
      timestamp,
      timestamp,
      fc.boolean(),
      (startedAt, completedAt, succeeded) => {
        const output = ModelOutput.create({
          definitionId: createDefinitionId(crypto.randomUUID()),
          methodName: "run",
          status: "running",
          startedAt,
          provenance,
        });
        if (succeeded) {
          output.markSucceeded(completedAt);
        } else {
          output.markFailed({ message: "boom" }, completedAt);
        }

        const restored = ModelOutput.fromData(output.toData());

        assert(restored.durationMs !== undefined && restored.durationMs >= 0);
        assert(
          restored.completedAt?.getTime() === completedAt.getTime(),
        );
      },
    ),
    { numRuns: 300 },
  );
});
