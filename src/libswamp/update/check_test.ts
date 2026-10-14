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

import { assertEquals, assertRejects } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createUpdateCheckDeps,
  UPDATE_CHECK_MAX_ATTEMPTS,
  updateCheck,
  type UpdateCheckDeps,
  type UpdateCheckEvent,
} from "./check.ts";
import { Platform } from "../../domain/update/platform.ts";
import { UserError } from "../../domain/errors.ts";
import { withMockedFetch } from "@swamp-club/swamp-testing";

function makeDeps(overrides: Partial<UpdateCheckDeps> = {}): UpdateCheckDeps {
  return {
    check: () =>
      Promise.resolve({
        status: "up_to_date" as const,
        currentVersion: "1.0.0",
      }),
    update: () =>
      Promise.resolve({
        status: "updated" as const,
        previousVersion: "1.0.0",
        newVersion: "2.0.0",
      }),
    ...overrides,
  };
}

Deno.test("updateCheck: yields checking then completed for check-only", async () => {
  const deps = makeDeps();
  const platform = Platform.detect();

  const events = await collect<UpdateCheckEvent>(
    updateCheck(createLibSwampContext(), deps, {
      checkOnly: true,
      platform,
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "checking" });
  const completed = events[1] as Extract<
    UpdateCheckEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.status, "up_to_date");
});

Deno.test("updateCheck: yields checking then completed for update", async () => {
  const deps = makeDeps();
  const platform = Platform.detect();

  const events = await collect<UpdateCheckEvent>(
    updateCheck(createLibSwampContext(), deps, {
      checkOnly: false,
      platform,
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "checking" });
  const completed = events[1] as Extract<
    UpdateCheckEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.status, "updated");
});

Deno.test("createUpdateCheckDeps: the update check retries a timed-out request (swamp-club#3428)", async () => {
  const deps = createUpdateCheckDeps("20261001.000000.0-sha.abcdef12", "", {
    sleep: () => Promise.resolve(),
  });
  const { calls } = await withMockedFetch(
    () => {
      throw new DOMException("timed out", "TimeoutError");
    },
    () =>
      assertRejects(
        () => deps.check(Platform.from("linux", "x86_64")),
        UserError,
      ),
  );

  assertEquals(UPDATE_CHECK_MAX_ATTEMPTS, 3);
  assertEquals(calls.length, UPDATE_CHECK_MAX_ATTEMPTS);
});

Deno.test("updateCheck: streams download progress and retries in order before completed", async () => {
  const deps = makeDeps({
    update: (_platform, options) => {
      options?.onProgress?.({ receivedBytes: 0, totalBytes: 100 });
      options?.onRetry?.({
        attempt: 1,
        maxAttempts: 5,
        reason: "no data received for 30s",
        resumeFromBytes: 40,
      });
      options?.onProgress?.({ receivedBytes: 100, totalBytes: 100 });
      return Promise.resolve({
        status: "updated" as const,
        previousVersion: "1.0.0",
        newVersion: "2.0.0",
      });
    },
  });

  const events = await collect<UpdateCheckEvent>(
    updateCheck(createLibSwampContext(), deps, {
      checkOnly: false,
      platform: Platform.detect(),
    }),
  );

  assertEquals(events.map((e) => e.kind), [
    "checking",
    "download_progress",
    "download_retrying",
    "download_progress",
    "completed",
  ]);
  assertEquals(events[3], {
    kind: "download_progress",
    data: { receivedBytes: 100, totalBytes: 100 },
  });
});

Deno.test("updateCheck: passes the context's signal to the check and the update", async () => {
  const controller = new AbortController();
  const seen: (AbortSignal | undefined)[] = [];
  const deps = makeDeps({
    check: (_platform, signal) => {
      seen.push(signal);
      return Promise.resolve({
        status: "up_to_date" as const,
        currentVersion: "1.0.0",
      });
    },
    update: (_platform, options) => {
      seen.push(options?.signal);
      return Promise.resolve({
        status: "up_to_date" as const,
        currentVersion: "1.0.0",
      });
    },
  });
  const ctx = createLibSwampContext({ signal: controller.signal });

  for (const checkOnly of [true, false]) {
    await collect<UpdateCheckEvent>(
      updateCheck(ctx, deps, { checkOnly, platform: Platform.detect() }),
    );
  }

  assertEquals(seen, [controller.signal, controller.signal]);
});

Deno.test("updateCheck: a cancelled update ends with a cancelled error", async () => {
  const controller = new AbortController();
  const deps = makeDeps({
    update: (_platform, options) => {
      options?.onProgress?.({ receivedBytes: 10, totalBytes: 100 });
      controller.abort();
      return Promise.reject(options?.signal?.reason);
    },
  });

  const events = await collect<UpdateCheckEvent>(
    updateCheck(
      createLibSwampContext({ signal: controller.signal }),
      deps,
      { checkOnly: false, platform: Platform.detect() },
    ),
  );

  assertEquals(events.map((e) => e.kind), [
    "checking",
    "download_progress",
    "error",
  ]);
  const error = events[2] as Extract<UpdateCheckEvent, { kind: "error" }>;
  assertEquals(error.error.code, "cancelled");
});

Deno.test("updateCheck: an update failure that is not a cancel is rethrown", async () => {
  const deps = makeDeps({
    update: () => Promise.reject(new UserError("Download failed")),
  });

  await assertRejects(
    () =>
      collect<UpdateCheckEvent>(
        updateCheck(createLibSwampContext(), deps, {
          checkOnly: false,
          platform: Platform.detect(),
        }),
      ),
    UserError,
    "Download failed",
  );
});
