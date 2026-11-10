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
import { waitFor } from "@swamp-club/swamp-testing";
import {
  MAX_FAILED_ROUTE_APPLIES,
  type WebhookRoutesApplyResult,
  WebhookRoutesPoller,
} from "./webhook_routes_poller.ts";

function harness(initial: string) {
  const state = {
    snapshot: initial,
    snapshotError: undefined as Error | undefined,
    applyError: undefined as Error | undefined,
    applies: 0,
    onApply: undefined as (() => void) | undefined,
  };
  const poller = new WebhookRoutesPoller({
    intervalMs: 60_000,
    snapshot: () =>
      state.snapshotError
        ? Promise.reject(state.snapshotError)
        : Promise.resolve(state.snapshot),
    apply: () => {
      state.onApply?.();
      if (state.applyError) return Promise.reject(state.applyError);
      state.applies++;
      return Promise.resolve({ changed: 1, errors: [] });
    },
    now: () => new Date("2026-11-09T00:00:00.000Z"),
  });
  return { state, poller };
}

Deno.test("WebhookRoutesPoller: applies the first snapshot once two checks agree", async () => {
  const { state, poller } = harness("v1");

  await poller.pollNow();
  assertEquals(state.applies, 0);
  await poller.pollNow();
  assertEquals(state.applies, 1);
  await poller.pollNow();
  assertEquals(state.applies, 1);
});

Deno.test("WebhookRoutesPoller: a change applies only after it holds for a check", async () => {
  const { state, poller } = harness("v1");
  await poller.pollNow();
  await poller.pollNow();

  state.snapshot = "v2-half";
  await poller.pollNow();
  state.snapshot = "v2";
  await poller.pollNow();
  assertEquals(state.applies, 1);

  await poller.pollNow();
  assertEquals(state.applies, 2);
});

Deno.test("WebhookRoutesPoller: an edit made while applying is applied on a later check", async () => {
  const { state, poller } = harness("v1");
  await poller.pollNow();
  state.onApply = () => {
    state.snapshot = "v2";
    state.onApply = undefined;
  };
  await poller.pollNow();
  assertEquals(state.applies, 1);

  await poller.pollNow();
  await poller.pollNow();
  assertEquals(state.applies, 2);
});

Deno.test("WebhookRoutesPoller: a snapshot error is reported and applies nothing", async () => {
  const { state, poller } = harness("v1");
  state.snapshotError = new Error("permission denied");

  await poller.pollNow();
  await poller.pollNow();

  assertEquals(state.applies, 0);
  assertEquals(
    poller.status().lastError,
    "Could not read the webhook routes directory: permission denied",
  );
  assertEquals(poller.status().lastCheckedAt, "2026-11-09T00:00:00.000Z");

  state.snapshotError = undefined;
  await poller.pollNow();
  await poller.pollNow();
  assertEquals(state.applies, 1);
  assertEquals(poller.status().lastError, null);
});

Deno.test("WebhookRoutesPoller: a failing apply retries a bounded number of times per snapshot", async () => {
  const { state, poller } = harness("v1");
  state.applyError = new Error("vault timed out");
  let attempts = 0;
  state.onApply = () => attempts++;

  for (let i = 0; i < MAX_FAILED_ROUTE_APPLIES + 3; i++) {
    await poller.pollNow();
  }
  assertEquals(attempts, MAX_FAILED_ROUTE_APPLIES);
  assertEquals(
    poller.status().lastError,
    "Could not apply changed webhook route files: vault timed out",
  );

  state.applyError = undefined;
  state.snapshot = "v2";
  await poller.pollNow();
  await poller.pollNow();
  assertEquals(state.applies, 1);
  assertEquals(poller.status().lastAppliedAt, "2026-11-09T00:00:00.000Z");
});

Deno.test("WebhookRoutesPoller: stop waits for a running apply and ends polling", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  let started!: () => void;
  const applying = new Promise<void>((resolve) => started = resolve);
  let finished = false;
  let applies = 0;
  let snapshot = "v1";
  const poller = new WebhookRoutesPoller({
    intervalMs: 60_000,
    snapshot: () => Promise.resolve(snapshot),
    apply: async () => {
      applies++;
      started();
      await gate;
      finished = true;
      return { changed: 1, errors: [] };
    },
  });
  poller.start();
  await poller.pollNow();
  const running = poller.pollNow();
  await applying;

  const stopped = poller.stop();
  release();
  await stopped;
  assertEquals(finished, true);
  await running;

  snapshot = "v2";
  await poller.pollNow();
  await poller.pollNow();
  assertEquals(applies, 1);
});

Deno.test("WebhookRoutesPoller: status reports the interval before any check", () => {
  const { poller } = harness("v1");
  assertEquals(poller.status(), {
    intervalMs: 60_000,
    lastCheckedAt: null,
    lastAppliedAt: null,
    lastError: null,
  });
});

Deno.test("WebhookRoutesPoller: an outage refusal is applied again on every poll until it clears", async () => {
  let outage = true;
  let applies = 0;
  const poller = new WebhookRoutesPoller({
    intervalMs: 60_000,
    snapshot: () => Promise.resolve("v1"),
    apply: () => {
      applies++;
      return Promise.resolve(
        outage
          ? { changed: 0, errors: ["vault timed out"], retryable: true }
          : { changed: 1, errors: [] },
      );
    },
  });

  for (let i = 0; i < MAX_FAILED_ROUTE_APPLIES + 3; i++) {
    await poller.pollNow();
  }
  assertEquals(applies, MAX_FAILED_ROUTE_APPLIES + 2);
  assertEquals(
    poller.status().lastError,
    "Some webhook route files failed on an outage; retrying on the next poll",
  );

  outage = false;
  await poller.pollNow();
  await poller.pollNow();
  assertEquals(applies, MAX_FAILED_ROUTE_APPLIES + 3);
  assertEquals(poller.status().lastError, null);
});

Deno.test("WebhookRoutesPoller: a snapshot error clears once the directory reads again", async () => {
  const { state, poller } = harness("v1");
  await poller.pollNow();
  await poller.pollNow();
  assertEquals(state.applies, 1);

  state.snapshotError = new Error("permission denied");
  await poller.pollNow();
  assertEquals(poller.status().lastError !== null, true);

  state.snapshotError = undefined;
  await poller.pollNow();
  assertEquals(poller.status().lastError, null);
  assertEquals(state.applies, 1);
});

Deno.test("WebhookRoutesPoller: a deploy landing during an apply is applied again once it settles", async () => {
  const snapshots = ["s1", "s1", "s2", "s2", "s2"];
  let applies = 0;
  const poller = new WebhookRoutesPoller({
    intervalMs: 60_000,
    snapshot: () => Promise.resolve(snapshots.shift() ?? "s2"),
    apply: () => {
      applies++;
      return Promise.resolve({ changed: 1, errors: [] });
    },
  });

  await poller.pollNow();
  await poller.pollNow();
  assertEquals(applies, 1);
  await poller.pollNow();
  assertEquals(applies, 2);
  await poller.pollNow();
  assertEquals(applies, 2);
});

Deno.test("WebhookRoutesPoller: an unexpected failure in a check keeps later polls running", async () => {
  let calls = 0;
  let snapshots = 0;
  const poller = new WebhookRoutesPoller({
    intervalMs: 60_000,
    // two checks and the post-apply recheck see v1, later checks see v2
    snapshot: () => Promise.resolve(++snapshots <= 3 ? "v1" : "v2"),
    apply: () => {
      calls++;
      return Promise.resolve(
        (calls === 1
          ? { changed: 0 }
          : { changed: 1, errors: [] }) as unknown as WebhookRoutesApplyResult,
      );
    },
  });

  await poller.pollNow();
  await poller.pollNow();
  assertEquals(
    poller.status().lastError?.startsWith("Webhook route poll failed"),
    true,
  );
  await poller.pollNow();
  await poller.pollNow();
  assertEquals(calls, 2);
  await poller.stop();
});

Deno.test("WebhookRoutesPoller.setIntervalMs: status reports it and a running poller checks at the new interval", async () => {
  const { state, poller } = harness("v1");
  let checks = 0;
  const counting = new WebhookRoutesPoller({
    intervalMs: 3_600_000,
    snapshot: () => {
      checks++;
      return Promise.resolve(state.snapshot);
    },
    apply: () => Promise.resolve({ changed: 0, errors: [] }),
  });
  counting.start();
  try {
    counting.setIntervalMs(10);
    assertEquals(counting.status().intervalMs, 10);
    await waitFor(() => checks >= 2, "two checks at 10ms");
  } finally {
    await counting.stop();
  }
  poller.setIntervalMs(30_000);
  assertEquals(poller.status().intervalMs, 30_000);
});
