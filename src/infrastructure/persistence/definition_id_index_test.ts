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
import type { DefinitionId } from "../../domain/definitions/definition.ts";
import {
  type DefinitionFileSource,
  DefinitionIdIndex,
} from "./definition_id_index.ts";
import { YamlDefinitionRepository } from "./yaml_definition_repository.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

/**
 * A repository in `dir`, a source that counts file reads, and an index whose
 * clock runs a minute ahead, so every stat the test sets is old enough to
 * trust and only a stat that moved makes it list or read again.
 */
function fixture(dir: string) {
  const primary = join(dir, "models");
  const auto = join(dir, ".swamp", "auto-definitions");
  const repo = new YamlDefinitionRepository(dir, undefined, primary, auto);
  const counter = { reads: 0, failOn: undefined as string | undefined };
  const source: DefinitionFileSource = {
    definitionRoots: () => repo.definitionRoots(),
    readDefinitionFile: (path, segments, isSymlink) => {
      counter.reads++;
      if (path === counter.failOn) {
        return Promise.reject(new Error(`failed to read ${path}`));
      }
      return repo.readDefinitionFile(path, segments, isSymlink);
    },
  };
  const index = new DefinitionIdIndex(source, {
    now: () => Date.now() + 60_000,
  });
  return { primary, auto, repo, counter, index };
}

let clock = Date.UTC(2020, 0, 1);

/** Gives `path` an mtime no earlier change has used. */
async function bump(path: string): Promise<void> {
  clock += 1_000;
  await Deno.utime(path, new Date(clock), new Date(clock));
}

function yamlOf(id: string, name: string, tags: Record<string, string> = {}) {
  const tagLines = Object.entries(tags).map(([k, v]) => `  ${k}: ${v}\n`);
  return `id: ${id}\nname: ${name}\nversion: 1\n` +
    (tagLines.length > 0 ? `tags:\n${tagLines.join("")}` : "");
}

/** Writes a definition file as another writer would, moving its stats. */
async function writeDefinition(
  path: string,
  id: string,
  name: string,
  tags: Record<string, string> = {},
): Promise<void> {
  await ensureDir(dirname(path));
  await Deno.writeTextFile(path, yamlOf(id, name, tags));
  await bump(path);
  await bump(dirname(path));
}

async function owners(index: DefinitionIdIndex, id: string) {
  const view = await index.begin();
  return (await view.findAllById(id as DefinitionId)).map((found) => ({
    name: found.definition.name,
    type: found.type.normalized,
    tags: found.definition.tags,
  }));
}

Deno.test("DefinitionIdIndex: finds every definition declaring an id, definitions first, as a scan does", async () => {
  await withTempDir(async (dir) => {
    const { primary, auto, repo, index } = fixture(dir);
    const id = crypto.randomUUID();
    await writeDefinition(join(auto, "test", "a", "copy.yaml"), id, "copy");
    await writeDefinition(
      join(primary, "test", "b", "original.yaml"),
      id,
      "original",
    );
    await writeDefinition(join(primary, "test", "a", "copy.yaml"), id, "copy");
    await writeDefinition(
      join(primary, "test", "a", "other.yaml"),
      crypto.randomUUID(),
      "other",
    );

    const scanned = (await repo.findAllIncludingAutoGlobal())
      .filter((found) => found.definition.id === id)
      .map((found) => ({
        name: found.definition.name,
        type: found.type.normalized,
        tags: found.definition.tags,
      }));
    assertEquals(await owners(index, id), scanned);
    assertEquals(scanned.map((o) => o.type), ["test/a", "test/b", "test/a"]);
    assertEquals(await owners(index, crypto.randomUUID()), []);
  });
});

Deno.test("DefinitionIdIndex: reads each file once while nothing changes, however many requests check it", async () => {
  await withTempDir(async (dir) => {
    const { primary, counter, index } = fixture(dir);
    for (let i = 0; i < 5; i++) {
      await writeDefinition(
        join(primary, "test", "a", `d${i}.yaml`),
        crypto.randomUUID(),
        `d${i}`,
      );
    }
    await index.begin();
    assertEquals(counter.reads, 5);
    for (let i = 0; i < 10; i++) await index.begin();
    assertEquals(counter.reads, 5);
  });
});

Deno.test("DefinitionIdIndex: concurrent requests share one listing", async () => {
  await withTempDir(async (dir) => {
    const { primary, counter, index } = fixture(dir);
    const id = crypto.randomUUID();
    for (let i = 0; i < 5; i++) {
      await writeDefinition(
        join(primary, "test", "a", `d${i}.yaml`),
        i === 0 ? id : crypto.randomUUID(),
        `d${i}`,
      );
    }
    const views = await Promise.all(
      Array.from({ length: 10 }, () => index.begin()),
    );
    assertEquals(counter.reads, 5);
    for (const view of views) {
      assertEquals(
        (await view.findAllById(id as DefinitionId)).map((found) =>
          found.definition.name
        ),
        ["d0"],
      );
    }
  });
});

Deno.test("DefinitionIdIndex: sees definitions another writer adds, removes and renames, reading only the new files", async () => {
  await withTempDir(async (dir) => {
    const { primary, auto, counter, index } = fixture(dir);
    const id = crypto.randomUUID();
    const typeDir = join(primary, "test", "a");
    await writeDefinition(
      join(typeDir, "kept.yaml"),
      crypto.randomUUID(),
      "kept",
    );
    assertEquals(await owners(index, id), []);
    const before = counter.reads;

    await writeDefinition(join(typeDir, "added.yaml"), id, "added");
    assertEquals(await owners(index, id), [
      { name: "added", type: "test/a", tags: {} },
    ]);
    // The new file, then the owner read at lookup.
    assertEquals(counter.reads - before, 2);

    await Deno.rename(join(typeDir, "added.yaml"), join(typeDir, "moved.yaml"));
    await bump(typeDir);
    assertEquals((await owners(index, id)).map((o) => o.name), ["added"]);

    await writeDefinition(join(auto, "test", "c", "auto.yaml"), id, "auto");
    assertEquals((await owners(index, id)).map((o) => o.type), [
      "test/a",
      "test/c",
    ]);

    await Deno.remove(join(typeDir, "moved.yaml"));
    await bump(typeDir);
    await Deno.remove(join(auto, "test"), { recursive: true });
    await bump(auto);
    assertEquals(await owners(index, id), []);
  });
});

Deno.test("DefinitionIdIndex: a definition recreated under the same file name with a new id is found by its new id", async () => {
  await withTempDir(async (dir) => {
    const { primary, index } = fixture(dir);
    const path = join(primary, "test", "a", "same.yaml");
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    await writeDefinition(path, first, "same");
    assertEquals((await owners(index, first)).length, 1);

    await Deno.remove(path);
    await writeDefinition(path, second, "same");
    assertEquals(await owners(index, first), []);
    assertEquals((await owners(index, second)).length, 1);
  });
});

Deno.test("DefinitionIdIndex: an owner's tags rewritten in place are read at lookup", async () => {
  await withTempDir(async (dir) => {
    const { primary, index } = fixture(dir);
    const path = join(primary, "test", "a", "tagged.yaml");
    const id = crypto.randomUUID();
    await writeDefinition(path, id, "tagged", { env: "dev" });
    assertEquals((await owners(index, id))[0].tags, { env: "dev" });

    // In place: the directory's stat does not move.
    await Deno.writeTextFile(path, yamlOf(id, "tagged", { env: "prod" }));
    assertEquals((await owners(index, id))[0].tags, { env: "prod" });
  });
});

Deno.test("DefinitionIdIndex: an owner rewritten in place to declare another id moves to that id", async () => {
  await withTempDir(async (dir) => {
    const { primary, index } = fixture(dir);
    const path = join(primary, "test", "a", "moving.yaml");
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    await writeDefinition(path, first, "moving");
    assertEquals((await owners(index, first)).length, 1);

    await Deno.writeTextFile(path, yamlOf(second, "moving"));
    assertEquals(await owners(index, first), []);
    assertEquals((await owners(index, second)).length, 1);
  });
});

Deno.test("DefinitionIdIndex: an owner a lookup found rewritten in place is checked again, so a change back is seen", async () => {
  await withTempDir(async (dir) => {
    const { primary, index } = fixture(dir);
    const path = join(primary, "test", "a", "flip.yaml");
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    await writeDefinition(path, first, "flip");
    assertEquals((await owners(index, first)).length, 1);

    // In place, so the directory's stat does not move: the lookup of
    // `first` finds the file declaring `second` and moves it there.
    await Deno.writeTextFile(path, yamlOf(second, "flip"));
    await bump(path);
    assertEquals(await owners(index, first), []);

    await Deno.writeTextFile(path, yamlOf(first, "flip", { env: "prod" }));
    await bump(path);
    assertEquals(await owners(index, first), [
      { name: "flip", type: "test/a", tags: { env: "prod" } },
    ]);
    assertEquals(await owners(index, second), []);
  });
});

Deno.test("DefinitionIdIndex: a symlinked definition whose target in another directory changes id is seen without its own directory changing", async () => {
  await withTempDir(async (dir) => {
    const { primary, index } = fixture(dir);
    const typeDir = join(primary, "test", "a");
    const targetDir = join(dir, "extra");
    const target = join(targetDir, "target.yaml");
    const link = join(typeDir, "link.yaml");
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    await writeDefinition(target, first, "linked", { team: "b" });
    await ensureDir(typeDir);
    await Deno.symlink(target, link, { type: "file" });
    await bump(typeDir);
    assertEquals((await owners(index, first)).map((o) => o.name), ["linked"]);

    /** Replaces the target by renaming a new file over it, in its own directory. */
    const replaceTarget = async (id: string) => {
      await Deno.writeTextFile(
        `${target}.tmp`,
        yamlOf(id, "linked", { team: "b" }),
      );
      await Deno.rename(`${target}.tmp`, target);
      await bump(target);
      await bump(targetDir);
    };

    await replaceTarget(second);
    assertEquals((await owners(index, second)).map((o) => o.name), ["linked"]);
    assertEquals(await owners(index, first), []);

    await replaceTarget(first);
    assertEquals((await owners(index, first)).map((o) => o.name), ["linked"]);
    assertEquals(await owners(index, second), []);
  });
});

Deno.test("DefinitionIdIndex: a file that did not parse is read again once fixed in place", async () => {
  await withTempDir(async (dir) => {
    const { primary, index } = fixture(dir);
    const path = join(primary, "test", "a", "broken.yaml");
    const id = crypto.randomUUID();
    await ensureDir(dirname(path));
    await Deno.writeTextFile(path, "id: [not, a, definition\n");
    await bump(path);
    await bump(dirname(path));
    assertEquals(await owners(index, id), []);

    await Deno.writeTextFile(path, yamlOf(id, "fixed"));
    await bump(path);
    assertEquals((await owners(index, id)).map((o) => o.name), ["fixed"]);
  });
});

Deno.test("DefinitionIdIndex: a root created after the first request is seen", async () => {
  await withTempDir(async (dir) => {
    const { auto, index } = fixture(dir);
    const id = crypto.randomUUID();
    assertEquals(await owners(index, id), []);
    await writeDefinition(join(auto, "test", "a", "late.yaml"), id, "late");
    assertEquals((await owners(index, id)).map((o) => o.name), ["late"]);
  });
});

Deno.test("DefinitionIdIndex: a directory whose stat is too recent to trust is listed again on every check", async () => {
  await withTempDir(async (dir) => {
    const { primary, repo, counter } = fixture(dir);
    let now = Date.UTC(2030, 0, 1);
    const index = new DefinitionIdIndex({
      definitionRoots: () => repo.definitionRoots(),
      readDefinitionFile: (path, segments, isSymlink) => {
        counter.reads++;
        return repo.readDefinitionFile(path, segments, isSymlink);
      },
    }, { now: () => now });
    const typeDir = join(primary, "test", "a");
    await ensureDir(typeDir);
    await Deno.writeTextFile(
      join(typeDir, "d.yaml"),
      yamlOf(crypto.randomUUID(), "d"),
    );
    // Every stat within the window before the index's clock.
    const recent = new Date(now - 500);
    await Deno.utime(join(typeDir, "d.yaml"), recent, recent);
    await Deno.utime(typeDir, recent, recent);
    await Deno.utime(primary, recent, recent);

    await index.begin();
    await index.begin();
    assertEquals(counter.reads, 2);

    // Once the window has passed, the same stats are trusted.
    now += 60_000;
    await index.begin();
    const settled = counter.reads;
    await index.begin();
    assertEquals(counter.reads, settled);
  });
});

Deno.test("DefinitionIdIndex: a listing that fails leaves the index as it was, and the next request lists again", async () => {
  await withTempDir(async (dir) => {
    const { primary, counter, index } = fixture(dir);
    const typeDir = join(primary, "test", "a");
    const kept = crypto.randomUUID();
    const added = crypto.randomUUID();
    await writeDefinition(join(typeDir, "kept.yaml"), kept, "kept");
    const view = await index.begin();

    await writeDefinition(join(typeDir, "added.yaml"), added, "added");
    counter.failOn = join(typeDir, "added.yaml");
    await assertRejects(() => index.begin(), Error, "failed to read");
    assertEquals(
      (await view.findAllById(kept as DefinitionId)).map((found) =>
        found.definition.name
      ),
      ["kept"],
    );

    counter.failOn = undefined;
    assertEquals((await owners(index, added)).map((o) => o.name), ["added"]);
    assertEquals((await owners(index, kept)).map((o) => o.name), ["kept"]);
  });
});

Deno.test("DefinitionIdIndex: a cancelled request stops at once, and a listing another request waits on goes on", async () => {
  await withTempDir(async (dir) => {
    const { primary, index } = fixture(dir);
    const id = crypto.randomUUID();
    await writeDefinition(join(primary, "test", "a", "d.yaml"), id, "d");

    const cancelled = new AbortController();
    const leaving = index.begin(cancelled.signal);
    const staying = index.begin();
    cancelled.abort(new Error("request cancelled"));
    await assertRejects(() => leaving, Error, "request cancelled");
    const view = await staying;
    assertEquals(
      (await view.findAllById(id as DefinitionId)).map((found) =>
        found.definition.name
      ),
      ["d"],
    );
  });
});

Deno.test("DefinitionIdIndex: an already cancelled request reads nothing", async () => {
  await withTempDir(async (dir) => {
    const { primary, counter, index } = fixture(dir);
    await writeDefinition(
      join(primary, "test", "a", "d.yaml"),
      crypto.randomUUID(),
      "d",
    );
    const cancelled = new AbortController();
    cancelled.abort(new Error("request cancelled"));
    await assertRejects(
      () => index.begin(cancelled.signal),
      Error,
      "request cancelled",
    );
    assertEquals(counter.reads, 0);
  });
});
