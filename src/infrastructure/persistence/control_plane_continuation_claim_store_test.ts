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
import { join } from "@std/path";
import {
  type ContinuationClaim,
  continuationClaimKey,
  serveHolder,
} from "../../domain/workflows/continuation_claim.ts";
import { FileSystemControlPlaneStore } from "./fs_control_plane_store.ts";
import {
  ControlPlaneContinuationClaimStore,
  heartbeatLiveness,
} from "./control_plane_continuation_claim_store.ts";

const RUN = "11111111-1111-4111-8111-111111111111";
const OTHER_RUN = "22222222-2222-4222-8222-222222222222";
const KEY = "a".repeat(64);
const NOW = new Date("2026-01-01T00:00:00.000Z");

function claim(generation: number, runId = RUN): ContinuationClaim {
  return {
    runId,
    suspensionKey: KEY,
    generation,
    holder: serveHolder("a"),
    claimedAt: NOW.toISOString(),
  };
}

async function withStore(
  fn: (control: FileSystemControlPlaneStore) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-claims-" });
  try {
    await fn(new FileSystemControlPlaneStore(dir));
  } finally {
    const cleanup = Deno.remove(dir, { recursive: true });
    await (Deno.build.os === "windows" ? cleanup.catch(() => {}) : cleanup);
  }
}

Deno.test("ControlPlaneContinuationClaimStore: a generation is created once, and the highest one is found", async () => {
  await withStore(async (control) => {
    const store = new ControlPlaneContinuationClaimStore(control);
    assertEquals(await store.find(RUN, KEY), undefined);
    assertEquals(await store.create(claim(1)), true);
    assertEquals(await store.create(claim(1)), false);
    assertEquals(await store.create(claim(2)), true);
    assertEquals(await store.find(RUN, KEY), claim(2));
  });
});

Deno.test("ControlPlaneContinuationClaimStore: a generation that cannot be read does not hide the one below it", async () => {
  await withStore(async (control) => {
    const store = new ControlPlaneContinuationClaimStore(control);
    await store.create(claim(1));
    await control.put(
      continuationClaimKey(claim(2)),
      new TextEncoder().encode("not a claim"),
    );
    assertEquals(await store.find(RUN, KEY), claim(1));
  });
});

Deno.test("ControlPlaneContinuationClaimStore: release removes one claim, removeForRun every claim of the run", async () => {
  await withStore(async (control) => {
    const store = new ControlPlaneContinuationClaimStore(control);
    await store.create(claim(1));
    await store.create(claim(2));
    await store.create(claim(1, OTHER_RUN));

    await store.release(claim(2));
    assertEquals(await store.find(RUN, KEY), claim(1));

    await store.removeForRun(RUN);
    assertEquals(await store.find(RUN, KEY), undefined);
    assertEquals(await store.find(OTHER_RUN, KEY), claim(1, OTHER_RUN));
  });
});

Deno.test("heartbeatLiveness: a serve holder is alive while its heartbeat is recent, dead once stale or gone", async () => {
  await withStore(async (control) => {
    const beat = (at: Date) =>
      control.put(
        "heartbeats/a",
        new TextEncoder().encode(
          JSON.stringify({ instanceId: "a", heartbeatAt: at.toISOString() }),
        ),
      );
    const liveness = heartbeatLiveness(control, {
      staleMs: 1000,
      now: () => NOW,
    });

    assertEquals(await liveness(serveHolder("a")), "dead");
    await beat(new Date(NOW.getTime() - 500));
    assertEquals(await liveness(serveHolder("a")), "alive");
    await beat(new Date(NOW.getTime() - 1001));
    assertEquals(await liveness(serveHolder("a")), "dead");
    await control.put("heartbeats/a", new TextEncoder().encode("{"));
    assertEquals(await liveness(serveHolder("a")), "dead");
  });
});

Deno.test("heartbeatLiveness: nothing is known of a holder that is not a serve instance", async () => {
  await withStore(async (control) => {
    const liveness = heartbeatLiveness(control);
    assertEquals(await liveness("local:abc"), "unknown");
    // An instance id cannot name a key outside the heartbeats.
    assertEquals(
      await liveness(serveHolder(join("..", "waits", "x"))),
      "unknown",
    );
  });
});
