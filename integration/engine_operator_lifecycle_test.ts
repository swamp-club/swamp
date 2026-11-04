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

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { waitFor } from "@swamp-club/swamp-testing";
import { disposeEngineWithOperatorRefresh } from "../src/engine/operator_auth.ts";
import { EngineRuntime } from "../src/engine/runtime.ts";
import { encodeEngineFrame } from "../src/engine/protocol.ts";
import { createServeCtx, withServeRepo } from "./serve_request_harness.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

for (const completion of ["success", "failure", "deadline"] as const) {
  Deno.test(`engine operator disposal: refresh ${completion} stays inside runtime quiescence`, async () => {
    await withServeRepo(async (repo) => {
      const refresh = Promise.withResolvers<void>();
      const phases: string[] = [];
      const deadlines: Array<{ delayMs: number; expire: () => void }> = [];
      const frames: Array<Record<string, unknown>> = [];
      const output = new WritableStream<Uint8Array>({
        write(bytes) {
          frames.push(JSON.parse(new TextDecoder().decode(bytes.subarray(4))));
        },
      });
      const runtime = new EngineRuntime({
        context: createServeCtx(repo),
        engineVersion: "test",
        gitSha: "test",
        dispose: () =>
          disposeEngineWithOperatorRefresh(
            () => {
              phases.push("repositories closed");
              return Promise.resolve();
            },
            {
              kind: "pass",
              authMode: "verified",
              refresh: () => {
                phases.push("refresh started");
                return refresh.promise;
              },
            },
          ),
        scheduleDeadline(delayMs, expire) {
          deadlines.push({ delayMs, expire });
          return () => {};
        },
      }, output);
      const input = new ReadableStream<Uint8Array>({
        start(controller) {
          for (
            const [id, method, params] of [
              ["hello", "hello", { profile: "local-v1" }],
              ["stop", "engine.quiesce", { deadlineMs: 75 }],
            ] as const
          ) {
            controller.enqueue(
              encodeEngineFrame({
                version: 1,
                generation: "one",
                id,
                method,
                params,
              }),
            );
          }
        },
      });
      const outcome = runtime.serve(input).then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await waitFor(
          () => phases.length === 2 && deadlines.length === 1,
          "refresh is pending inside disposal",
        );
        assertEquals(phases, ["repositories closed", "refresh started"]);
        assertEquals(deadlines[0].delayMs, 75);
        assertEquals(runtime.status.state, "quiescing");
        assertEquals(
          frames.some((frame) => frame.id === "stop"),
          false,
          "no quiescent acknowledgement before refresh settles",
        );
        if (completion === "deadline") deadlines[0].expire();
        else if (completion === "failure") {
          refresh.reject(new Error("private account refresh failure"));
        } else refresh.resolve();
        const failure = await outcome;
        if (completion === "deadline") {
          assert(failure instanceof Error);
          assertEquals(
            (failure as Error & { code: string }).code,
            "drain_timeout",
          );
          assertEquals(runtime.status.state, "failed");
          assertEquals(
            (frames.find((frame) => frame.id === "stop")!.error as {
              code: string;
            }).code,
            "drain_timeout",
          );
        } else {
          assertEquals(failure, undefined);
          assertEquals(runtime.status.state, "stopped");
          assertEquals(
            frames.find((frame) => frame.id === "stop")!.error,
            undefined,
          );
        }
        assertEquals(
          deadlines.length,
          1,
          "there is no extra post-runtime refresh budget",
        );
        assertEquals(output.locked, false);
        assertEquals(input.locked, false);
      } finally {
        refresh.resolve();
        await outcome;
      }
    });
  });
}
