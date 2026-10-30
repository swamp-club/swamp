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
  type OutputSummaryRow,
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

/** `summaries` as rows, each of a record no test here compares. */
function rowsOf(...summaries: OutputSummary[]): OutputSummaryRow[] {
  return summaries.map((summary) => ({
    summary,
    record: { mtimeMs: 1, size: 1 },
  }));
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
    assertEquals(await index.append(TYPE, rowsOf(first, other)), 2);
    const later = { ...first, status: "succeeded" as const };
    assertEquals(await index.append(TYPE, rowsOf(later)), 1);

    const rows = await index.read(TYPE, DAY);
    assertEquals(rows.size, 2);
    assertEquals(rows.get(keyOf(first))?.summary.status, "succeeded");
    assertEquals(rows.get(keyOf(other))?.summary.id, other.id);
  });
});

Deno.test("OutputSummaryIndex.append: a run not finished has no row, nor does a start no file name can carry", async () => {
  await withTempDir(async (dir) => {
    const index = indexIn(dir);
    assertEquals(
      await index.append(
        TYPE,
        rowsOf(
          summaryOf({ status: "running" }),
          summaryOf({ status: "pending" }),
          summaryOf({ startedAt: new Date("+012026-01-02T00:00:00.000Z") }),
        ),
      ),
      0,
    );
    assertEquals((await index.read(TYPE, DAY)).size, 0);
  });
});

Deno.test("OutputSummaryIndex.append: never stores an error message", async () => {
  await withTempDir(async (dir) => {
    const index = indexIn(dir);
    await index.append(
      TYPE,
      rowsOf(summaryOf({ status: "failed", errorMessage: "secret" })),
    );
    const text = await Deno.readTextFile(await shardIn(dir));
    assertEquals(text.includes("secret"), false);
  });
});

Deno.test("OutputSummaryIndex.read: skips torn, invalid and unfinished lines and keeps the rest", async () => {
  await withTempDir(async (dir) => {
    const index = indexIn(dir);
    const kept = summaryOf();
    await index.append(TYPE, rowsOf(kept));
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
    await indexIn(dir, "one").append(TYPE, rowsOf(summary));
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
    assertEquals(await index.append(TYPE, rowsOf(summaryOf())), 0);
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
      await index.append(TYPE, rowsOf(summary));
      const shard = await shardIn(dir);
      const outside = join(dir, "outside.txt");
      await Deno.writeTextFile(outside, "untouched");
      await Deno.remove(shard);
      await Deno.symlink(outside, shard, { type: "file" });

      assertEquals(await index.append(TYPE, rowsOf(summaryOf())), 0);
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
      await index.append(TYPE, rowsOf(summaryOf()));
      const shard = await shardIn(dir);
      const outside = join(dir, "outside.txt");
      await Deno.remove(shard);
      await Deno.symlink(outside, shard, { type: "file" });

      assertEquals(await index.append(TYPE, rowsOf(summaryOf())), 0);
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
      assertEquals(await index.append(TYPE, rowsOf(summaryOf())), 0);
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
    await index.append(TYPE, rowsOf(summaryOf()));
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
    await index.append(TYPE, rowsOf(kept, gone, kept));

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
    await index.append(TYPE, rowsOf(kept));
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
    await index.append(TYPE, rowsOf(summaryOf()));
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
    await indexIn(dir, "one").append(TYPE, rowsOf(summaryOf()));
    await indexIn(dir, "two").append(TYPE, rowsOf(summaryOf()));
    await removeStaleOutputSummaries(dir);
    assertEquals((await indexIn(dir, "one").read(TYPE, DAY)).size, 0);
    assertEquals((await indexIn(dir, "two").read(TYPE, DAY)).size, 0);
  });
});

Deno.test("OutputSummaryIndex.generation: moves each time the summaries are cleared, and only then", async () => {
  await withTempDir(async (dir) => {
    const index = indexIn(dir);
    assertEquals(await index.generation(), undefined);
    await index.append(TYPE, rowsOf(summaryOf()));
    assertEquals(await index.generation(), undefined);

    await removeStaleOutputSummaries(dir);
    const first = await index.generation();
    assertEquals(typeof first, "string");
    await index.append(TYPE, rowsOf(summaryOf()));
    assertEquals(await index.generation(), first);

    await removeStaleOutputSummaries(dir);
    assertEquals((await index.generation()) === first, false);
  });
});

Deno.test("OutputSummaryIndex.read: a row reads back with the fingerprint it was added with", async () => {
  await withTempDir(async (dir) => {
    const index = indexIn(dir);
    const summary = summaryOf();
    const record = { mtimeMs: 5, size: 6, ctimeMs: 7, ino: 8 };
    await index.append(TYPE, [{ summary, record }]);
    assertEquals(
      (await index.read(TYPE, DAY)).get(keyOf(summary))?.record,
      record,
    );
  });
});

Deno.test("OutputSummaryIndex.read: a shard at least half duplicates is rewritten with one row per key, the last of each", async () => {
  await withTempDir(async (dir) => {
    const index = indexIn(dir);
    const first = summaryOf({ status: "cancelled" });
    const other = summaryOf();
    const later = { ...first, status: "succeeded" as const };
    await index.append(TYPE, rowsOf(first, other, first, other, later));
    const shard = await shardIn(dir);

    const rows = await index.read(TYPE, DAY);
    assertEquals(rows.size, 2);
    const lines = (await Deno.readTextFile(shard)).trim().split("\n");
    assertEquals(lines.length, 2);
    assertEquals(
      await index.read(TYPE, DAY),
      rows,
    );
    assertEquals(rows.get(keyOf(first))?.summary.status, "succeeded");
  });
});

Deno.test("OutputSummaryIndex.read: a shard with few duplicates is left as it is", async () => {
  await withTempDir(async (dir) => {
    const index = indexIn(dir);
    const once = summaryOf();
    await index.append(TYPE, rowsOf(once, summaryOf(), summaryOf(), once));
    const shard = await shardIn(dir);
    const before = await Deno.readTextFile(shard);
    assertEquals((await index.read(TYPE, DAY)).size, 3);
    assertEquals(await Deno.readTextFile(shard), before);
  });
});

Deno.test("OutputSummaryIndex.read: a shard that grew since it was read is not rewritten, so the rows added are kept", async () => {
  await withTempDir(async (dir) => {
    const index = indexIn(dir);
    const duplicated = summaryOf();
    await index.append(TYPE, rowsOf(duplicated, duplicated));
    const shard = await shardIn(dir);
    const added = summaryOf();

    const readFile = Deno.readFile;
    (Deno as { readFile: typeof Deno.readFile }).readFile = async (
      path,
      options,
    ) => {
      const content = await readFile(path, options);
      if (String(path) === shard) {
        (Deno as { readFile: typeof Deno.readFile }).readFile = readFile;
        await index.append(TYPE, rowsOf(added));
      }
      return content;
    };
    try {
      await index.read(TYPE, DAY);
    } finally {
      (Deno as { readFile: typeof Deno.readFile }).readFile = readFile;
    }

    assertEquals((await Deno.readTextFile(shard)).trim().split("\n").length, 3);
    assertEquals((await index.read(TYPE, DAY)).has(keyOf(added)), true);
  });
});

Deno.test("removeStaleOutputSummaries: a removal that fails still leaves no row to read, and the next clear takes what it left", async () => {
  await withTempDir(async (dir) => {
    const index = indexIn(dir);
    await index.append(TYPE, rowsOf(summaryOf()));

    const remove = Deno.remove;
    (Deno as { remove: typeof Deno.remove }).remove = () =>
      Promise.reject(new Error("Directory not empty"));
    try {
      await removeStaleOutputSummaries(dir);
    } finally {
      (Deno as { remove: typeof Deno.remove }).remove = remove;
    }
    assertEquals((await index.read(TYPE, DAY)).size, 0);

    await removeStaleOutputSummaries(dir);
    assertEquals(
      (await Array.fromAsync(
        Deno.readDir(swampPath(dir, OUTPUT_SUMMARIES_DIR)),
      ))
        .map((entry) => entry.name),
      ["cleared"],
    );
  });
});

Deno.test("removeStaleOutputSummaries: readers adding rows while it clears fail no removal", async () => {
  await withTempDir(async (dir) => {
    const index = indexIn(dir);
    const failures: unknown[] = [];
    const remove = Deno.remove;
    (Deno as { remove: typeof Deno.remove }).remove = async (path, options) => {
      try {
        await remove(path, options);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) failures.push(error);
        throw error;
      }
    };
    let clearing = true;
    // Each writer keeps making a new type's directory, which is what a removal
    // walking the tree cannot get ahead of.
    const writers = Array.from({ length: 4 }, async (_, writer) => {
      for (let i = 0; clearing; i++) {
        await index.append(`${TYPE}/${writer}/${i % 8}`, rowsOf(summaryOf()));
      }
    });
    try {
      for (let i = 0; i < 40; i++) {
        for (let j = 0; j < 32; j++) {
          await index.append(`${TYPE}/seed/${j}`, rowsOf(summaryOf()));
        }
        await removeStaleOutputSummaries(dir);
      }
    } finally {
      clearing = false;
      await Promise.all(writers);
      (Deno as { remove: typeof Deno.remove }).remove = remove;
    }
    assertEquals(failures, []);
  });
});
