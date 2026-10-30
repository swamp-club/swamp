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
import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import type { OutputSummary } from "../../domain/models/output_summary.ts";
import {
  OUTPUT_SUMMARIES_DIR,
  outputFileStamp,
  OutputSummaryIndex,
  outputSummaryKey,
  removeStaleOutputSummaries,
} from "./output_summary_index.ts";
import { swampPath } from "./paths.ts";

const TYPE = "@acme/thing";
const DAY = "2026-01-02";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function summaryOf(overrides: Partial<OutputSummary> = {}): OutputSummary {
  return {
    id: crypto.randomUUID(),
    definitionId: crypto.randomUUID(),
    methodName: "run",
    status: "succeeded",
    startedAt: new Date(`${DAY}T03:04:05.006Z`),
    durationMs: 7,
    provenance: { triggeredBy: "manual" },
    ...overrides,
  };
}

function keyOf(summary: OutputSummary): string {
  return outputSummaryKey(
    summary.methodName,
    summary.definitionId,
    outputFileStamp(summary.startedAt),
  );
}

function indexIn(dir: string, baseDir = "outputs"): OutputSummaryIndex {
  return new OutputSummaryIndex(dir, join(dir, baseDir));
}

/** The one shard under `dir`. */
async function shardIn(dir: string): Promise<string> {
  const found: string[] = [];
  const walk = async (at: string) => {
    for await (const entry of Deno.readDir(at)) {
      const path = join(at, entry.name);
      if (entry.isDirectory) await walk(path);
      else found.push(path);
    }
  };
  await walk(swampPath(dir, OUTPUT_SUMMARIES_DIR));
  assertEquals(found.length, 1);
  return found[0];
}

Deno.test("OutputSummaryIndex.read: a shard never written has no rows", async () => {
  await withTempDir(async (dir) => {
    assertEquals((await indexIn(dir).read(TYPE, DAY)).size, 0);
  });
});

Deno.test("OutputSummaryIndex.append: rows read back by key, and the last row of a key wins", async () => {
  await withTempDir(async (dir) => {
    const index = indexIn(dir);
    const first = summaryOf({ status: "cancelled" });
    const other = summaryOf();
    assertEquals(await index.append(TYPE, [first, other]), 2);
    const later = { ...first, status: "succeeded" as const };
    assertEquals(await index.append(TYPE, [later]), 1);

    const rows = await index.read(TYPE, DAY);
    assertEquals(rows.size, 2);
    assertEquals(rows.get(keyOf(first))?.status, "succeeded");
    assertEquals(rows.get(keyOf(other))?.id, other.id);
  });
});

Deno.test("OutputSummaryIndex.append: a run not finished has no row, nor does a start no file name can carry", async () => {
  await withTempDir(async (dir) => {
    const index = indexIn(dir);
    assertEquals(
      await index.append(TYPE, [
        summaryOf({ status: "running" }),
        summaryOf({ status: "pending" }),
        summaryOf({ startedAt: new Date("+012026-01-02T00:00:00.000Z") }),
      ]),
      0,
    );
    assertEquals((await index.read(TYPE, DAY)).size, 0);
  });
});

Deno.test("OutputSummaryIndex.append: never stores an error message", async () => {
  await withTempDir(async (dir) => {
    const index = indexIn(dir);
    await index.append(TYPE, [
      summaryOf({ status: "failed", errorMessage: "secret" }),
    ]);
    const text = await Deno.readTextFile(await shardIn(dir));
    assertEquals(text.includes("secret"), false);
  });
});

Deno.test("OutputSummaryIndex.read: skips torn, invalid and unfinished lines and keeps the rest", async () => {
  await withTempDir(async (dir) => {
    const index = indexIn(dir);
    const kept = summaryOf();
    await index.append(TYPE, [kept]);
    const shard = await shardIn(dir);
    const line = (await Deno.readTextFile(shard)).trim();
    const running = line.replace('"succeeded"', '"running"');
    await Deno.writeTextFile(
      shard,
      `{"id":"torn\n[1,2]\n${running}\n${line}\n${line.slice(0, 20)}`,
    );
    const rows = await index.read(TYPE, DAY);
    assertEquals([...rows.keys()], [keyOf(kept)]);
  });
});

Deno.test("OutputSummaryIndex: each records root has its own shards", async () => {
  await withTempDir(async (dir) => {
    const summary = summaryOf();
    await indexIn(dir, "one").append(TYPE, [summary]);
    assertEquals((await indexIn(dir, "one").read(TYPE, DAY)).size, 1);
    assertEquals((await indexIn(dir, "two").read(TYPE, DAY)).size, 0);
  });
});

Deno.test("OutputSummaryIndex: an index that cannot be used fails no caller", async () => {
  await withTempDir(async (dir) => {
    const blocked = swampPath(dir, OUTPUT_SUMMARIES_DIR);
    await ensureDir(dirname(blocked));
    await Deno.writeTextFile(blocked, "");
    const index = indexIn(dir);
    assertEquals(await index.append(TYPE, [summaryOf()]), 0);
    assertEquals((await index.read(TYPE, DAY)).size, 0);
    assertEquals(await index.compact(new Map(), "9999-12-31"), {
      shardsRewritten: 0,
      shardsRemoved: 0,
    });
  });
});

Deno.test({
  name:
    "OutputSummaryIndex.append: a shard symlinked out of the index is not written through",
  // Creating a symlink needs a privilege Windows runners may lack.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const index = indexIn(dir);
      const summary = summaryOf();
      await index.append(TYPE, [summary]);
      const shard = await shardIn(dir);
      const outside = join(dir, "outside.txt");
      await Deno.writeTextFile(outside, "untouched");
      await Deno.remove(shard);
      await Deno.symlink(outside, shard, { type: "file" });

      assertEquals(await index.append(TYPE, [summaryOf()]), 0);
      assertEquals(await Deno.readTextFile(outside), "untouched");
    });
  },
});

Deno.test({
  name:
    "OutputSummaryIndex.append: a dangling shard symlink does not create its target",
  // Creating a symlink needs a privilege Windows runners may lack.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const index = indexIn(dir);
      await index.append(TYPE, [summaryOf()]);
      const shard = await shardIn(dir);
      const outside = join(dir, "outside.txt");
      await Deno.remove(shard);
      await Deno.symlink(outside, shard, { type: "file" });

      assertEquals(await index.append(TYPE, [summaryOf()]), 0);
      await assertRejects(() => Deno.stat(outside), Deno.errors.NotFound);
    });
  },
});

Deno.test({
  name:
    "removeStaleOutputSummaries: a marker symlinked out of the index is replaced, not written through",
  // Creating a symlink needs a privilege Windows runners may lack.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const outside = join(dir, "outside.txt");
      await Deno.writeTextFile(outside, "untouched");
      const marker = swampPath(dir, OUTPUT_SUMMARIES_DIR, "cleared");
      await ensureDir(dirname(marker));
      await Deno.symlink(outside, marker, { type: "file" });

      await removeStaleOutputSummaries(dir);

      assertEquals(await Deno.readTextFile(outside), "untouched");
      assertEquals((await Deno.lstat(marker)).isSymlink, false);
    });
  },
});

Deno.test({
  name:
    "removeStaleOutputSummaries: a directory symlinked out of the checkout loses only the link, and its target keeps its files",
  // Creating a symlink needs a privilege Windows runners may lack.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "someone-elses");
      await ensureDir(target);
      await Deno.writeTextFile(join(target, "precious.txt"), "kept");
      const link = swampPath(dir, OUTPUT_SUMMARIES_DIR);
      await ensureDir(dirname(link));
      await Deno.symlink(target, link, { type: "dir" });

      const index = indexIn(dir);
      assertEquals(await index.append(TYPE, [summaryOf()]), 0);
      assertEquals(await index.compact(new Map(), "9999-12-31"), {
        shardsRewritten: 0,
        shardsRemoved: 0,
      });

      await removeStaleOutputSummaries(dir);

      assertEquals(
        await Deno.readTextFile(join(target, "precious.txt")),
        "kept",
      );
      assertEquals((await Deno.lstat(link)).isDirectory, true);
      assertEquals(
        (await Array.fromAsync(Deno.readDir(target))).map((e) => e.name),
        ["precious.txt"],
      );
    });
  },
});

Deno.test("OutputSummaryIndex.shardBytes: the size of a shard, and 0 without one", async () => {
  await withTempDir(async (dir) => {
    const index = indexIn(dir);
    assertEquals(await index.shardBytes(TYPE, DAY), 0);
    await index.append(TYPE, [summaryOf()]);
    assertEquals(
      await index.shardBytes(TYPE, DAY),
      (await Deno.stat(await shardIn(dir))).size,
    );
  });
});

Deno.test("OutputSummaryIndex.compact: drops rows whose record is gone, keeps the others, and rewrites duplicates away", async () => {
  await withTempDir(async (dir) => {
    const index = indexIn(dir);
    const kept = summaryOf();
    const gone = summaryOf();
    await index.append(TYPE, [kept, gone, kept]);

    assertEquals(
      await index.compact(
        new Map([[TYPE, new Set([keyOf(kept)])]]),
        "9999-12-31",
      ),
      { shardsRewritten: 1, shardsRemoved: 0 },
    );

    assertEquals([...(await index.read(TYPE, DAY)).keys()], [keyOf(kept)]);
    const text = await Deno.readTextFile(await shardIn(dir));
    assertEquals(text.trim().split("\n").length, 1);
  });
});

Deno.test("OutputSummaryIndex.compact: a shard with nothing to drop is left alone", async () => {
  await withTempDir(async (dir) => {
    const index = indexIn(dir);
    const kept = summaryOf();
    await index.append(TYPE, [kept]);
    assertEquals(
      await index.compact(
        new Map([[TYPE, new Set([keyOf(kept)])]]),
        "9999-12-31",
      ),
      { shardsRewritten: 0, shardsRemoved: 0 },
    );
  });
});

Deno.test("OutputSummaryIndex.compact: removes a shard with no live rows, and leaves one still taking rows", async () => {
  await withTempDir(async (dir) => {
    const index = indexIn(dir);
    await index.append(TYPE, [summaryOf()]);
    const shard = await shardIn(dir);

    assertEquals(await index.compact(new Map(), DAY), {
      shardsRewritten: 0,
      shardsRemoved: 0,
    });
    await Deno.stat(shard);

    assertEquals(await index.compact(new Map(), "9999-12-31"), {
      shardsRewritten: 0,
      shardsRemoved: 1,
    });
    await assertRejects(() => Deno.stat(shard), Deno.errors.NotFound);
  });
});

Deno.test("removeStaleOutputSummaries: removes every root's shards, and is fine with none", async () => {
  await withTempDir(async (dir) => {
    await removeStaleOutputSummaries(dir);
    await indexIn(dir, "one").append(TYPE, [summaryOf()]);
    await indexIn(dir, "two").append(TYPE, [summaryOf()]);
    await removeStaleOutputSummaries(dir);
    assertEquals((await indexIn(dir, "one").read(TYPE, DAY)).size, 0);
    assertEquals((await indexIn(dir, "two").read(TYPE, DAY)).size, 0);
  });
});

Deno.test("OutputSummaryIndex.generation: moves each time the summaries are cleared, and only then", async () => {
  await withTempDir(async (dir) => {
    const index = indexIn(dir);
    assertEquals(await index.generation(), undefined);
    await index.append(TYPE, [summaryOf()]);
    assertEquals(await index.generation(), undefined);

    await removeStaleOutputSummaries(dir);
    const first = await index.generation();
    assertEquals(typeof first, "string");
    await index.append(TYPE, [summaryOf()]);
    assertEquals(await index.generation(), first);

    await removeStaleOutputSummaries(dir);
    assertEquals((await index.generation()) === first, false);
  });
});
