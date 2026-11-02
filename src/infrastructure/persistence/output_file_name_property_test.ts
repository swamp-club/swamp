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

// skipping a file by its name stamp is safe only if comparing stamps orders
// records as comparing their instants does

import { assertEquals } from "@std/assert";
import fc from "fast-check";
import { createDefinitionId } from "../../domain/definitions/definition.ts";
import { ModelOutput } from "../../domain/models/model_output.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import type { OutputKey } from "../../domain/models/repositories.ts";
import { SERVER_TOKEN_MODEL_TYPE } from "../../domain/models/access/server_token_model.ts";
import { YamlOutputRepository } from "./yaml_output_repository.ts";
import "../../domain/models/models.ts";

const TYPE = ModelType.create("command/shell");
const MAX_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
const instant = fc.integer({ min: 0, max: MAX_MS });
const startAndCutoff = instant.chain((started) =>
  fc.tuple(
    fc.constant(started),
    fc.oneof(
      instant,
      fc.integer({
        min: Math.max(0, started - 2),
        max: Math.min(MAX_MS, started + 2),
      }),
    ),
  )
);

Deno.test("findAllGlobalSince: returns a record exactly when it started at or after the cutoff", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-output-stamp-" });
  try {
    await fc.assert(
      fc.asyncProperty(startAndCutoff, async ([startedMs, cutoffMs]) => {
        const repoDir = await Deno.makeTempDir({ dir });
        const repo = new YamlOutputRepository(repoDir);
        const output = ModelOutput.create({
          definitionId: createDefinitionId(crypto.randomUUID()),
          methodName: "run",
          status: "succeeded",
          startedAt: new Date(startedMs),
          provenance: {
            definitionHash: "abc123",
            modelVersion: "2026.02.09.1",
            triggeredBy: "manual",
          },
        });
        await repo.save(TYPE, "run", output);

        const found = await repo.findAllGlobalSince(new Date(cutoffMs));

        assertEquals(
          found.map((r) => r.output.id),
          startedMs >= cutoffMs ? [output.id] : [],
        );
      }),
      { numRuns: 100 },
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("findHistoryByDefinition: returns a record exactly when it started in its since or until window", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-output-stamp-" });
  try {
    await fc.assert(
      fc.asyncProperty(
        startAndCutoff,
        fc.boolean(),
        async ([startedMs, boundMs], isUntil) => {
          const repoDir = await Deno.makeTempDir({ dir });
          const repo = new YamlOutputRepository(repoDir);
          const definitionId = createDefinitionId(crypto.randomUUID());
          const output = ModelOutput.create({
            definitionId,
            methodName: "run",
            status: "succeeded",
            startedAt: new Date(startedMs),
            provenance: {
              definitionHash: "abc123",
              modelVersion: "2026.02.09.1",
              triggeredBy: "manual",
            },
          });
          await repo.save(TYPE, "run", output);
          const bound = new Date(boundMs);

          const found = await repo.findHistoryByDefinition(
            TYPE,
            definitionId,
            isUntil ? { until: bound } : { since: bound },
          );

          const inWindow = isUntil ? startedMs < boundMs : startedMs >= boundMs;
          assertEquals(found.map((o) => o.id), inWindow ? [output.id] : []);
        },
      ),
      { numRuns: 100 },
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

// a global scan judges a file by the key its location carries, so for every
// saved record the location must say what the record says
const definitionIdArb = fc.uuid();
const methodArb = fc.stringMatching(/^[a-z][a-zA-Z0-9_-]{0,15}$/);
const typeArb = fc.constantFrom(TYPE, SERVER_TOKEN_MODEL_TYPE);

Deno.test("findAllGlobalSince: the key a saved record's location carries is the record's own type, method and definition", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-output-key-" });
  try {
    await fc.assert(
      fc.asyncProperty(
        typeArb,
        definitionIdArb,
        methodArb,
        instant,
        async (type, definitionId, method, startedMs) => {
          const repoDir = await Deno.makeTempDir({ dir });
          const repo = new YamlOutputRepository(repoDir);
          const output = ModelOutput.create({
            definitionId: createDefinitionId(definitionId),
            methodName: method,
            status: "succeeded",
            startedAt: new Date(startedMs),
            provenance: {
              definitionHash: "abc123",
              modelVersion: "2026.02.09.1",
              triggeredBy: "manual",
            },
          });
          await repo.save(type, method, output);

          const asked: OutputKey[] = [];
          const found = await repo.findAllGlobalSince(
            new Date(0),
            undefined,
            (keys) => {
              asked.push(...keys);
              return Promise.resolve(keys.map(() => true));
            },
          );

          assertEquals(
            asked.map((key) => [
              key.type.normalized,
              key.definitionId,
              key.methodName,
            ]),
            [[type.normalized, output.definitionId, output.methodName]],
          );
          assertEquals(found.map((r) => r.output.id), [output.id]);
        },
      ),
      { numRuns: 100 },
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
