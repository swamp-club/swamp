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
import { EventBus } from "../domain/events/event_bus.ts";
import { createModelUpdated } from "../domain/events/types.ts";
import { FilesystemAccessDataChangeSource } from "./filesystem_access_data_change_source.ts";

const GRANT = "swamp/grant";
const GROUP = "swamp/group";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

/** Writes version `n` of a record the way the data repository lays it out. */
async function writeVersion(
  dir: string,
  modelId: string,
  n: number,
  content = `version ${n}`,
  dataName = dir.endsWith("group") ? "group-main" : "grant-main",
): Promise<void> {
  const dataDir = join(dir, modelId, dataName);
  await Deno.mkdir(join(dataDir, String(n)), { recursive: true });
  await Deno.writeTextFile(join(dataDir, String(n), "raw"), content);
  await Deno.writeTextFile(join(dataDir, String(n), "metadata.yaml"), "m");
  await Deno.writeTextFile(join(dataDir, "latest"), String(n));
}

/** Publishes the event a grant or group method run publishes after it saved. */
async function ownRun(
  bus: EventBus,
  type: string,
  modelId: string,
  ...versions: number[]
): Promise<void> {
  const name = type === GROUP ? "group-main" : "grant-main";
  await bus.publish(
    createModelUpdated(
      type,
      modelId,
      modelId,
      versions.map((version) => ({ name, version })),
    ),
  );
}

async function withSource(
  fn: (ctx: {
    grantDir: string;
    groupDir: string;
    bus: EventBus;
    source: FilesystemAccessDataChangeSource;
  }) => Promise<void>,
): Promise<void> {
  await withTempDir(async (root) => {
    const grantDir = join(root, "data", "swamp", "grant");
    const groupDir = join(root, "data", "swamp", "group");
    const bus = new EventBus();
    const source = new FilesystemAccessDataChangeSource({
      dirs: [grantDir, groupDir, join(root, "data", "@swamp", "grant")],
      eventBus: bus,
    });
    try {
      await fn({ grantDir, groupDir, bus, source });
    } finally {
      source.dispose();
    }
  });
}

Deno.test("FilesystemAccessDataChangeSource: missing directories read as unchanged", async () => {
  await withSource(async ({ source }) => {
    await source.prime();
    assertEquals(await source.detect(), 0);
  });
});

Deno.test("FilesystemAccessDataChangeSource: reports one change without a baseline", async () => {
  await withSource(async ({ source }) => {
    assertEquals(await source.detect(), 1);
    assertEquals(await source.detect(), 0);
  });
});

Deno.test("FilesystemAccessDataChangeSource: a peer's new record is a change, once", async () => {
  await withSource(async ({ grantDir, source }) => {
    await source.prime();
    await writeVersion(grantDir, "g1", 1);
    assertEquals(await source.detect(), 1);
    assertEquals(await source.detect(), 0);
  });
});

Deno.test("FilesystemAccessDataChangeSource: a peer's new version (a revoke) is a change", async () => {
  await withSource(async ({ grantDir, source }) => {
    await writeVersion(grantDir, "g1", 1);
    await source.prime();
    await writeVersion(grantDir, "g1", 2, "revoked");
    assertEquals(await source.detect(), 1);
  });
});

Deno.test("FilesystemAccessDataChangeSource: counts each changed record", async () => {
  await withSource(async ({ grantDir, groupDir, source }) => {
    await source.prime();
    await writeVersion(grantDir, "g1", 1);
    await writeVersion(groupDir, "team", 1);
    assertEquals(await source.detect(), 2);
  });
});

Deno.test("FilesystemAccessDataChangeSource: a deleted record is a change", async () => {
  await withSource(async ({ grantDir, source }) => {
    await writeVersion(grantDir, "g1", 1);
    await source.prime();
    await Deno.remove(join(grantDir, "g1"), { recursive: true });
    assertEquals(await source.detect(), 1);
  });
});

Deno.test("FilesystemAccessDataChangeSource: an mtime-only change is a change", async () => {
  await withSource(async ({ grantDir, source }) => {
    await writeVersion(grantDir, "g1", 1);
    await source.prime();
    const raw = join(grantDir, "g1", "grant-main", "1", "raw");
    await Deno.utime(raw, new Date(2001, 1, 1), new Date(2001, 1, 1));
    assertEquals(await source.detect(), 1);
  });
});

Deno.test("FilesystemAccessDataChangeSource: dot-named temp files are ignored", async () => {
  await withSource(async ({ grantDir, source }) => {
    await writeVersion(grantDir, "g1", 1);
    await source.prime();
    await Deno.writeTextFile(
      join(grantDir, "g1", "grant-main", `.${crypto.randomUUID()}.tmp`),
      "partial",
    );
    assertEquals(await source.detect(), 0);
  });
});

Deno.test("FilesystemAccessDataChangeSource: data other than grant-main and group-main is not watched", async () => {
  await withSource(async ({ grantDir, bus, source }) => {
    await writeVersion(grantDir, "g1", 1);
    await source.prime();
    // The method-summary report a run writes after its event.
    await writeVersion(grantDir, "g1", 1, "report", "report-summary");
    await writeVersion(grantDir, "g1", 2);
    await ownRun(bus, GRANT, "g1", 2);
    assertEquals(await source.detect(), 0);
    // A record holding only other data reads as no record.
    await writeVersion(grantDir, "g2", 1, "report", "report-summary");
    assertEquals(await source.detect(), 0);
  });
});

Deno.test("FilesystemAccessDataChangeSource: versions this process's runs name are not a change", async () => {
  await withSource(async ({ grantDir, groupDir, bus, source }) => {
    await writeVersion(grantDir, "g1", 1);
    await source.prime();
    await writeVersion(grantDir, "g1", 2, "revoked");
    await writeVersion(grantDir, "g2", 1);
    await writeVersion(groupDir, "team", 1);
    await ownRun(bus, GRANT, "g1", 2);
    await ownRun(bus, GRANT, "g2", 1);
    await ownRun(bus, GROUP, "team", 1);
    assertEquals(await source.detect(), 0);
  });
});

Deno.test("FilesystemAccessDataChangeSource: an event that names no versions claims nothing", async () => {
  await withSource(async ({ grantDir, bus, source }) => {
    await source.prime();
    await writeVersion(grantDir, "g1", 1);
    await bus.publish(createModelUpdated(GRANT, "g1", "g1"));
    assertEquals(await source.detect(), 1);
  });
});

Deno.test("FilesystemAccessDataChangeSource: an event naming another version claims nothing", async () => {
  await withSource(async ({ grantDir, bus, source }) => {
    await writeVersion(grantDir, "g1", 1);
    await source.prime();
    await writeVersion(grantDir, "g1", 2, "peer");
    await ownRun(bus, GRANT, "g1", 3);
    assertEquals(await source.detect(), 1);
  });
});

Deno.test("FilesystemAccessDataChangeSource: a peer write to a record this process also wrote is a change", async () => {
  await withSource(async ({ grantDir, bus, source }) => {
    await writeVersion(grantDir, "g1", 1);
    await source.prime();
    await writeVersion(grantDir, "g1", 2, "peer");
    await writeVersion(grantDir, "g1", 3, "own");
    await ownRun(bus, GRANT, "g1", 3);
    assertEquals(await source.detect(), 1);
  });
});

Deno.test("FilesystemAccessDataChangeSource: an own version seen before its event is a change", async () => {
  await withSource(async ({ grantDir, bus, source }) => {
    await writeVersion(grantDir, "g1", 1);
    await source.prime();
    await writeVersion(grantDir, "g1", 2);
    // The cycle runs before the method run publishes its event: fail safe.
    assertEquals(await source.detect(), 1);
    await ownRun(bus, GRANT, "g1", 2);
    assertEquals(await source.detect(), 0);
  });
});

Deno.test("FilesystemAccessDataChangeSource: a late own event never claims a peer's next version", async () => {
  await withSource(async ({ grantDir, bus, source }) => {
    await writeVersion(grantDir, "g1", 1);
    await source.prime();
    await writeVersion(grantDir, "g1", 2, "own");
    assertEquals(await source.detect(), 1);
    // The own event lands after the cycle that already counted version 2,
    // and a peer revokes the same grant in the same interval.
    await ownRun(bus, GRANT, "g1", 2);
    await writeVersion(grantDir, "g1", 3, "peer revoke");
    assertEquals(await source.detect(), 1);
  });
});

Deno.test("FilesystemAccessDataChangeSource: an in-place change with an own event is a change", async () => {
  await withSource(async ({ grantDir, bus, source }) => {
    await writeVersion(grantDir, "g1", 1);
    await source.prime();
    await Deno.writeTextFile(
      join(grantDir, "g1", "grant-main", "1", "raw"),
      "rewritten in place",
    );
    await ownRun(bus, GRANT, "g1", 1);
    assertEquals(await source.detect(), 1);
  });
});

Deno.test("FilesystemAccessDataChangeSource: old versions pruned by an own write are not a change", async () => {
  await withSource(async ({ grantDir, bus, source }) => {
    await writeVersion(grantDir, "g1", 1);
    await writeVersion(grantDir, "g1", 2);
    await source.prime();
    await writeVersion(grantDir, "g1", 3);
    await Deno.remove(join(grantDir, "g1", "grant-main", "1"), {
      recursive: true,
    });
    await ownRun(bus, GRANT, "g1", 3);
    assertEquals(await source.detect(), 0);
  });
});

Deno.test("FilesystemAccessDataChangeSource: a removed newest version is a change despite an own event", async () => {
  await withSource(async ({ grantDir, bus, source }) => {
    await writeVersion(grantDir, "g1", 1);
    await writeVersion(grantDir, "g1", 2);
    await source.prime();
    await Deno.remove(join(grantDir, "g1", "grant-main", "2"), {
      recursive: true,
    });
    await Deno.writeTextFile(join(grantDir, "g1", "grant-main", "latest"), "1");
    await ownRun(bus, GRANT, "g1", 2);
    assertEquals(await source.detect(), 1);
  });
});

Deno.test("FilesystemAccessDataChangeSource: a deleted record is a change despite an own event", async () => {
  await withSource(async ({ grantDir, bus, source }) => {
    await writeVersion(grantDir, "g1", 1);
    await source.prime();
    await Deno.remove(join(grantDir, "g1"), { recursive: true });
    await ownRun(bus, GRANT, "g1", 1);
    assertEquals(await source.detect(), 1);
  });
});

Deno.test("FilesystemAccessDataChangeSource: events for other model types are not own writes", async () => {
  await withSource(async ({ grantDir, bus, source }) => {
    await source.prime();
    await writeVersion(grantDir, "g1", 1);
    await ownRun(bus, "command/shell", "g1", 1);
    assertEquals(await source.detect(), 1);
  });
});

Deno.test("FilesystemAccessDataChangeSource: events after dispose are not recorded", async () => {
  await withSource(async ({ grantDir, bus, source }) => {
    await source.prime();
    source.dispose();
    await writeVersion(grantDir, "g1", 1);
    await ownRun(bus, GRANT, "g1", 1);
    assertEquals(await source.detect(), 1);
  });
});

Deno.test("FilesystemAccessDataChangeSource: listen resumes recording own writes after dispose", async () => {
  await withSource(async ({ grantDir, bus, source }) => {
    await source.prime();
    source.dispose();
    source.listen();
    source.listen();
    await writeVersion(grantDir, "g1", 1);
    await ownRun(bus, GRANT, "g1", 1);
    assertEquals(await source.detect(), 0);
  });
});

Deno.test("FilesystemAccessDataChangeSource: a symlinked directory is recorded, not followed", async () => {
  await withSource(async ({ grantDir, source }) => {
    await writeVersion(grantDir, "g1", 1);
    const outside = await Deno.makeTempDir();
    try {
      await Deno.symlink(outside, join(grantDir, "g1", "grant-main", "link"), {
        type: "dir",
      });
      await source.prime();
      await Deno.writeTextFile(join(outside, "file"), "x");
      assertEquals(await source.detect(), 0);
    } finally {
      await Deno.remove(outside, { recursive: true }).catch(() => {});
    }
  });
});
