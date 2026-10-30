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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { initializeLogging } from "../logging/logger.ts";
import {
  acquireExplicitLease,
  EXPLICIT_LEASES_FILE,
  type ExplicitLease,
  ExplicitLeaseHeldError,
  explicitLeaseOn,
  ExplicitLeaseUnsupportedError,
  readExplicitLeases,
  recordExplicitLease,
  releaseExplicitLease,
  renewExplicitLeases,
} from "./explicit_model_leases.ts";
import type { LockAcquireReply, LockLease } from "./serve_datastore_client.ts";
import { ServeUnreachableError } from "./serve_upstream_errors.ts";

await initializeLogging({});

const KEY = "data/aws/ec2/0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a01/.lock";
const SIGNAL = new AbortController().signal;

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "swamp-explicit-leases-" });
  try {
    await fn(root);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire on Windows; the OS reclaims temp dirs.
      await Deno.remove(root, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(root, { recursive: true });
    }
  }
}

function held(overrides: Partial<ExplicitLease> = {}): ExplicitLease {
  return {
    leaseId: crypto.randomUUID(),
    lockKey: KEY,
    fence: 3,
    holdMs: 60_000,
    expiresAt: "2026-10-29T12:01:00.000Z",
    floor: [{ name: "vpc", highWater: 2 }],
    ...overrides,
  };
}

/** Serve's lock routes for explicit leases, recording each call. */
class FakeServe {
  readonly timeoutMs = 30_000;
  readonly calls: string[] = [];
  answers: Array<"held" | "acquired" | "unfenced"> = ["acquired"];
  renewal: "renew" | "ended" | Error = "renew";

  acquireLock(
    lockKey: string,
    _ttlMs: number,
    _waitMs: number,
    _signal: AbortSignal,
    options: { holdMs?: number } = {},
  ): Promise<LockAcquireReply> {
    this.calls.push(`acquire ${lockKey} hold=${options.holdMs}`);
    const answer = this.answers.length > 1
      ? this.answers.shift()!
      : this.answers[0];
    if (answer === "held") {
      return Promise.resolve({
        acquired: false,
        heldBy: "other",
        message: "held",
      });
    }
    const lease: LockLease = {
      leaseId: crypto.randomUUID(),
      lockKey,
      ttlMs: options.holdMs ?? 0,
      expiresAt: "2026-10-29T12:30:00.000Z",
      ...(answer === "acquired"
        ? { fence: 7, floor: [], holdMs: options.holdMs }
        : {}),
    };
    return Promise.resolve({ acquired: true, lease });
  }

  renewLock(
    leaseId: string,
    ttlMs: number,
    _signal?: AbortSignal,
    options: { holdMs?: number } = {},
  ): Promise<LockLease | undefined> {
    this.calls.push(
      `renew ${leaseId} ttl=${ttlMs}` +
        (options.holdMs === undefined ? "" : ` hold=${options.holdMs}`),
    );
    if (this.renewal instanceof Error) return Promise.reject(this.renewal);
    if (this.renewal === "ended") return Promise.resolve(undefined);
    return Promise.resolve({
      leaseId,
      lockKey: KEY,
      ttlMs,
      expiresAt: "2026-10-29T13:00:00.000Z",
    });
  }

  releaseLock(leaseId: string): Promise<boolean> {
    this.calls.push(`release ${leaseId}`);
    return Promise.resolve(true);
  }
}

Deno.test("readExplicitLeases: a missing record is none, and a malformed entry is left out", async () => {
  await withRoot(async (root) => {
    assertEquals(await readExplicitLeases(root), []);
    const good = held();
    await Deno.writeTextFile(
      join(root, EXPLICIT_LEASES_FILE),
      JSON.stringify({
        leases: [good, { ...good, leaseId: "not-a-uuid" }, { lockKey: KEY }],
      }),
    );
    assertEquals(await readExplicitLeases(root), [good]);
    await Deno.writeTextFile(join(root, EXPLICIT_LEASES_FILE), "{not json");
    assertEquals(await readExplicitLeases(root), []);
  });
});

Deno.test("acquireExplicitLease: takes a fenced lease for its hold and records it", async () => {
  await withRoot(async (root) => {
    const serve = new FakeServe();
    const { lease, existing } = await acquireExplicitLease(
      root,
      serve,
      KEY,
      1_800_000,
      5_000,
      SIGNAL,
    );
    assertEquals(existing, false);
    assertEquals([lease.fence, lease.holdMs], [7, 1_800_000]);
    // Taken for a short TTL, recorded, then extended to its hold.
    assertEquals(serve.calls, [
      `acquire ${KEY} hold=undefined`,
      `renew ${lease.leaseId} ttl=1800000 hold=1800000`,
    ]);
    assertEquals(lease.expiresAt, "2026-10-29T13:00:00.000Z");
    assertEquals(await explicitLeaseOn(root, KEY), lease);
  });
});

Deno.test("acquireExplicitLease: a lease the checkout already records is renewed for the new hold, not taken again", async () => {
  await withRoot(async (root) => {
    const serve = new FakeServe();
    const recorded = held();
    await recordExplicitLease(root, recorded);
    const { lease, existing } = await acquireExplicitLease(
      root,
      serve,
      KEY,
      1_800_000,
      5_000,
      SIGNAL,
    );
    assertEquals(existing, true);
    assertEquals(lease.leaseId, recorded.leaseId);
    assertEquals(lease.holdMs, 1_800_000);
    assertEquals(lease.expiresAt, "2026-10-29T13:00:00.000Z");
    assertEquals(serve.calls, [
      `renew ${recorded.leaseId} ttl=1800000 hold=1800000`,
    ]);
  });
});

Deno.test("acquireExplicitLease: a recorded lease serve ended is forgotten and a new one taken", async () => {
  await withRoot(async (root) => {
    const serve = new FakeServe();
    serve.renewal = "ended";
    const renew = serve.renewLock.bind(serve);
    serve.renewLock = (leaseId: string, ttlMs: number) => {
      const reply = renew(leaseId, ttlMs);
      // Only the recorded lease has ended; the new one extends.
      serve.renewal = "renew";
      return reply;
    };
    const recorded = held();
    await recordExplicitLease(root, recorded);
    const { lease, existing } = await acquireExplicitLease(
      root,
      serve,
      KEY,
      60_000,
      5_000,
      SIGNAL,
    );
    assertEquals(existing, false);
    assert(lease.leaseId !== recorded.leaseId);
    assertEquals((await readExplicitLeases(root)).length, 1);
  });
});

Deno.test("acquireExplicitLease: a lock still held after the wait is refused, naming no holder", async () => {
  await withRoot(async (root) => {
    const serve = new FakeServe();
    serve.answers = ["held"];
    const error = await assertRejects(
      () => acquireExplicitLease(root, serve, KEY, 60_000, 0, SIGNAL),
      ExplicitLeaseHeldError,
    );
    assert(error.message.includes("another caller"));
    assertEquals(await readExplicitLeases(root), []);
  });
});

Deno.test("acquireExplicitLease: an older serve's unfenced lease is released again and refused", async () => {
  await withRoot(async (root) => {
    const serve = new FakeServe();
    serve.answers = ["unfenced"];
    await assertRejects(
      () => acquireExplicitLease(root, serve, KEY, 60_000, 5_000, SIGNAL),
      ExplicitLeaseUnsupportedError,
    );
    assert(serve.calls.some((call) => call.startsWith("release ")));
    assertEquals(await readExplicitLeases(root), []);
  });
});

Deno.test("releaseExplicitLease: ends the recorded lease at serve and forgets it; none recorded is false", async () => {
  await withRoot(async (root) => {
    const serve = new FakeServe();
    assertEquals(await releaseExplicitLease(root, serve, KEY, SIGNAL), false);
    const recorded = held();
    await recordExplicitLease(root, recorded);
    assertEquals(await releaseExplicitLease(root, serve, KEY, SIGNAL), true);
    assertEquals(serve.calls, [`release ${recorded.leaseId}`]);
    assertEquals(await readExplicitLeases(root), []);
  });
});

Deno.test("renewExplicitLeases: renews each lease for its hold, forgets one serve ended, and keeps one it could not reach", async () => {
  await withRoot(async (root) => {
    const kept = held({ lockKey: "data/a/b/.lock" });
    await recordExplicitLease(root, kept);
    const serve = new FakeServe();
    let result = await renewExplicitLeases(root, serve, SIGNAL);
    assertEquals(result.renewed.map((lease) => lease.expiresAt), [
      "2026-10-29T13:00:00.000Z",
    ]);

    serve.renewal = new Error("serve unreachable");
    result = await renewExplicitLeases(root, serve, SIGNAL);
    assertEquals(result, { renewed: [], ended: [] });
    assertEquals((await readExplicitLeases(root)).length, 1);

    serve.renewal = "ended";
    result = await renewExplicitLeases(root, serve, SIGNAL);
    assertEquals(result.ended.map((lease) => lease.leaseId), [kept.leaseId]);
    assertEquals(await readExplicitLeases(root), []);
  });
});

Deno.test("renewExplicitLeases: a lease another command records while the renewal is in flight is kept", async () => {
  await withRoot(async (root) => {
    const first = held({ lockKey: "data/a/b/.lock" });
    await recordExplicitLease(root, first);
    const second = held({ lockKey: "data/c/d/.lock" });
    const serve = new FakeServe();
    const renew = serve.renewLock.bind(serve);
    serve.renewLock = async (leaseId: string, ttlMs: number) => {
      // Another command acquires a lease meanwhile.
      await recordExplicitLease(root, second);
      return await renew(leaseId, ttlMs);
    };
    await renewExplicitLeases(root, serve, SIGNAL);
    assertEquals(
      (await readExplicitLeases(root)).map((lease) => lease.leaseId).sort(),
      [first.leaseId, second.leaseId].sort(),
    );
  });
});

Deno.test("renewExplicitLeases: with serve unreachable, tries once and keeps every lease's record, judged by its recorded end (swamp-club#4195)", async () => {
  await withRoot(async (root) => {
    await recordExplicitLease(root, held({ lockKey: "data/a/b/.lock" }));
    await recordExplicitLease(root, held({ lockKey: "data/c/d/.lock" }));
    const serve = new FakeServe();
    serve.renewal = new ServeUnreachableError(
      "https://serve.test",
      "never",
      new Error("fetch failed"),
    );
    const result = await renewExplicitLeases(root, serve, SIGNAL);
    assertEquals(result, { renewed: [], ended: [] });
    assertEquals(
      serve.calls.filter((call) => call.startsWith("renew")).length,
      1,
    );
    assertEquals((await readExplicitLeases(root)).length, 2);
  });
});
