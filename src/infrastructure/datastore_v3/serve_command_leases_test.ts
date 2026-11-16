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
  judgeRecordedProcess,
  type LocalProcess,
  type ProcessProbe,
  type RecordedProcess,
} from "../../domain/datastore_v3/process_liveness.ts";
import { localProcess } from "./process_identity.ts";
import { commandLeaseRecordsAt } from "./serve_command_leases.ts";

const KEY = "data/aws/ec2/0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a01/.lock";
const SERVE = "https://serve.test";

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "swamp-command-leases-" });
  try {
    await fn(root);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(root, { recursive: true });
    }
  }
}

/**
 * judges records as this host's kernel would, with the recording process
 * seen through `probe`: it stands in for the process after this one exits
 */
async function judgedAs(
  probe: (recordedStart: string | undefined) => ProcessProbe,
): Promise<
  (recorded: RecordedProcess) => Promise<"gone" | "alive" | "unknown">
> {
  const here = await localProcess();
  const local: LocalProcess = {
    ...here,
    pid: here.pid + 1,
    probe: () => probe(here.identity.startTime),
  };
  return (recorded) => Promise.resolve(judgeRecordedProcess(recorded, local));
}

Deno.test("commandLeaseRecordsAt: a lease whose process is gone is dead; a frozen one is not", async () => {
  await withRoot(async (root) => {
    const cases: Array<[string, (start?: string) => ProcessProbe, boolean]> = [
      ["exited", () => ({ present: false, zombie: false }), true],
      [
        "a zombie",
        (start) => ({ present: true, zombie: true, startTime: start }),
        true,
      ],
      [
        "its pid reused",
        () => ({ present: true, zombie: false, startTime: "another start" }),
        true,
      ],
      [
        "frozen (SIGSTOP)",
        (start) => ({ present: true, zombie: false, startTime: start }),
        false,
      ],
    ];
    for (const [name, probe, dead] of cases) {
      const leaseId = crypto.randomUUID();
      const records = commandLeaseRecordsAt(
        root,
        SERVE,
        "token",
        await judgedAs(probe),
      );
      await records.record({ leaseId, lockKey: KEY });
      // a platform that reads no start times cannot tell a reused pid
      const startKnown =
        (await localProcess()).identity.startTime !== undefined;
      assertEquals(
        (await records.deadOn(KEY)).includes(leaseId),
        name === "its pid reused" && !startKnown ? false : dead,
        name,
      );
      await records.forget(leaseId);
    }
  });
});

Deno.test("commandLeaseRecordsAt: only this caller's leases at this serve on this key are ever dead", async () => {
  await withRoot(async (root) => {
    const gone = await judgedAs(() => ({ present: false, zombie: false }));
    const mine = commandLeaseRecordsAt(root, SERVE, "token", gone);
    await mine.record({ leaseId: "lease-on-key", lockKey: KEY });
    await mine.record({ leaseId: "lease-on-other", lockKey: `${KEY}x` });
    await commandLeaseRecordsAt(root, SERVE, "another token", gone).record({
      leaseId: "another-caller",
      lockKey: KEY,
    });
    await commandLeaseRecordsAt(root, "https://other.test", "token", gone)
      .record({ leaseId: "another-serve", lockKey: KEY });
    assertEquals(await mine.deadOn(KEY), ["lease-on-key"]);
  });
});

Deno.test("commandLeaseRecordsAt: a lease never judgeable here is not dead, and a forgotten or unreadable one is never listed", async () => {
  await withRoot(async (root) => {
    const unknown = commandLeaseRecordsAt(
      root,
      SERVE,
      "token",
      () => Promise.resolve("unknown"),
    );
    await unknown.record({ leaseId: "on-another-host", lockKey: KEY });
    assertEquals(await unknown.deadOn(KEY), []);
    await unknown.forget("on-another-host");

    const gone = commandLeaseRecordsAt(
      root,
      SERVE,
      "token",
      () => Promise.resolve("gone"),
    );
    await gone.record({ leaseId: "forgotten", lockKey: KEY });
    await gone.forget("forgotten");
    await Deno.writeTextFile(join(root, "command_leases", "torn.json"), "{");
    await gone.record({ leaseId: "../escape", lockKey: KEY });
    assertEquals(await gone.deadOn(KEY), []);
    await gone.forget("never-recorded");
  });
});
