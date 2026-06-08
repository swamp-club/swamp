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

import { getLogger } from "@logtape/logtape";
import type { CreekDefinition } from "../../domain/creeks/creek.ts";
import { creekRegistry } from "../../domain/creeks/creek_registry.ts";
import { createCreekHandle } from "../../domain/creeks/creek_handle.ts";
import type { VaultService } from "../../domain/vaults/vault_service.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound, validationFailed } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import type { CreekCallEvent } from "./creek_views.ts";

export interface CreekCallDeps {
  getCreek: (type: string) => Promise<CreekDefinition | undefined>;
  vaultService?: VaultService;
  /** Resolver for the `extensionFile` helper on the method context. */
  extensionFileResolver?: (type: string) => (relPath: string) => string;
}

export interface CreekCallInput {
  type: string;
  method: string;
  args: Record<string, unknown>;
}

/** Wires the real registry into CreekCallDeps. */
export async function createCreekCallDeps(
  vaultService?: VaultService,
): Promise<CreekCallDeps> {
  await creekRegistry.ensureLoaded();
  return {
    getCreek: async (type) => {
      await creekRegistry.ensureTypeLoaded(type);
      return creekRegistry.get(type);
    },
    vaultService,
  };
}

/**
 * Invokes a single method on a registered creek. Used by `swamp creek call`
 * for ad-hoc inspection and by integration tests for smoke checks. CEL-side
 * dispatch goes through `cross_query_cel.ts`, not this service.
 */
export async function* creekCall(
  _ctx: LibSwampContext,
  deps: CreekCallDeps,
  input: CreekCallInput,
  signal?: AbortSignal,
): AsyncGenerator<CreekCallEvent> {
  yield* withGeneratorSpan(
    "swamp.creek.call",
    {},
    (async function* () {
      yield { kind: "running" };

      const creek = await deps.getCreek(input.type);
      if (!creek) {
        yield { kind: "error", error: notFound("Creek", input.type) };
        return;
      }
      if (!creek.methods[input.method]) {
        yield {
          kind: "error",
          error: validationFailed(
            `Unknown method "${input.method}" on creek "${input.type}". Available: ${
              Object.keys(creek.methods).join(", ")
            }`,
          ),
        };
        return;
      }

      const handle = createCreekHandle(
        input.type,
        new Map(),
        creekRegistry,
        {
          signal: signal ?? new AbortController().signal,
          logger: getLogger(["creek", "call", input.type]),
          vaultService: deps.vaultService,
          extensionFile: deps.extensionFileResolver?.(input.type) ?? ((p) => p),
        },
      );

      try {
        const result = await handle.call(input.method, input.args);
        yield {
          kind: "completed",
          data: {
            type: input.type,
            method: input.method,
            args: input.args,
            result,
          },
        };
      } catch (err) {
        yield {
          kind: "error",
          error: validationFailed(
            err instanceof Error ? err.message : String(err),
          ),
        };
      }
    })(),
  );
}
