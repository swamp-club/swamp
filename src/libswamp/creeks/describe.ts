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

import type { CreekDefinition } from "../../domain/creeks/creek.ts";
import { creekRegistry } from "../../domain/creeks/creek_registry.ts";
import { zodToJsonSchema } from "../types/schema_helpers.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import type { CreekDescribeEvent, CreekMethodDetail } from "./creek_views.ts";

export interface CreekDescribeDeps {
  getCreek: (type: string) => Promise<CreekDefinition | undefined>;
}

/** Wires the real registry into CreekDescribeDeps. */
export async function createCreekDescribeDeps(): Promise<CreekDescribeDeps> {
  await creekRegistry.ensureLoaded();
  return {
    getCreek: async (type) => {
      await creekRegistry.ensureTypeLoaded(type);
      return creekRegistry.get(type);
    },
  };
}

/** Looks up a creek and yields its definition metadata. */
export async function* creekDescribe(
  _ctx: LibSwampContext,
  deps: CreekDescribeDeps,
  creekType: string,
): AsyncGenerator<CreekDescribeEvent> {
  yield* withGeneratorSpan(
    "swamp.creek.describe",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const creek = await deps.getCreek(creekType);
      if (!creek) {
        yield { kind: "error", error: notFound("Creek", creekType) };
        return;
      }

      const methods: CreekMethodDetail[] = Object.entries(creek.methods).map(
        ([name, m]) => ({
          name,
          description: m.description,
          arguments: zodToJsonSchema(m.arguments),
          returns: m.returns ? zodToJsonSchema(m.returns) : undefined,
          strictReturns: m.strictReturns ?? false,
        }),
      );

      yield {
        kind: "completed",
        data: {
          type: creek.type,
          version: creek.version,
          description: creek.description,
          methods,
        },
      };
    })(),
  );
}
