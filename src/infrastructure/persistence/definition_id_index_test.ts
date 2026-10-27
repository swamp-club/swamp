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
import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import type { DefinitionId } from "../../domain/definitions/definition.ts";
import {
  type DefinitionFileSource,
  DefinitionIdIndex,
} from "./definition_id_index.ts";
import { YamlDefinitionRepository } from "./yaml_definition_repository.ts";
import { statRecord } from "./workflow_run_index.ts";
import {
  diagnosticPhases,
  findSpan,
  isChildOf,
  withCapturedSpans,
  withObservedSpans,
} from "../tracing/span_test_helpers.ts";
import { withDiagnosticArea } from "../../domain/diagnostics/diagnostic_phase.ts";

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

Deno.test("DefinitionIdIndex: a symlinked definition listed before its target exists is read once the target appears", async () => {
  await withTempDir(async (dir) => {
    const { primary, index } = fixture(dir);
    const typeDir = join(primary, "test", "a");
    const target = join(dir, "shared", "prod.yaml");
    const id = crypto.randomUUID();
    await ensureDir(typeDir);
    await Deno.symlink(target, join(typeDir, "prod.yaml"), { type: "file" });
    await bump(typeDir);
    assertEquals(await owners(index, id), []);

    // The link's own directory does not change.
    await writeDefinition(target, id, "prod", { env: "prod" });
    assertEquals(await owners(index, id), [
      { name: "prod", type: "test/a", tags: { env: "prod" } },
    ]);
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

Deno.test("DefinitionIdIndex: a directory listed while its stat was too recent is listed again once that stat looks old, so a file added in the same tick is found", async () => {
  await withTempDir(async (dir) => {
    const { primary, repo } = fixture(dir);
    let now = Date.now() + 60_000;
    const typeDir = join(primary, "test", "a");
    // The directory's stat as a coarse clock reports it: taken within the
    // window, and not moved by the second file, which lands in the same tick.
    const frozen = {
      mtimeMs: now - 500,
      size: 4096,
      ctimeMs: now - 500,
      ino: 1,
    };
    const index = new DefinitionIdIndex(repo, {
      now: () => now,
      stat: (path) =>
        path === typeDir ? Promise.resolve(frozen) : statRecord(path),
    });
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    await writeDefinition(join(typeDir, "a.yaml"), first, "a");
    assertEquals((await owners(index, first)).map((o) => o.name), ["a"]);

    await writeDefinition(join(typeDir, "b.yaml"), second, "b");
    now += 60_000;
    assertEquals((await owners(index, second)).map((o) => o.name), ["b"]);
  });
});

Deno.test("DefinitionIdIndex: a symlink that loops is skipped as a scan skips it, and every other definition is still found", async () => {
  await withTempDir(async (dir) => {
    const { primary, repo, index } = fixture(dir);
    const typeDir = join(primary, "test", "a");
    const id = crypto.randomUUID();
    await writeDefinition(join(typeDir, "good.yaml"), id, "good");
    const loop = join(typeDir, "loop.yaml");
    await Deno.symlink(loop, loop, { type: "file" });
    await bump(typeDir);

    assertEquals((await owners(index, id)).map((o) => o.name), ["good"]);
    assertEquals(
      (await repo.findAllIncludingAutoGlobal()).map((f) => f.definition.name),
      ["good"],
    );
    // Still checked on each request, without failing it.
    assertEquals((await owners(index, id)).map((o) => o.name), ["good"]);
  });
});

Deno.test("DefinitionIdIndex: an owner swapped for a symlink out of the repository since its listing is not read through it", async () => {
  await withTempDir(async (dir) => {
    await withTempDir(async (outside) => {
      const { primary, index } = fixture(dir);
      const path = join(primary, "test", "a", "owner.yaml");
      const id = crypto.randomUUID();
      await writeDefinition(path, id, "owner");
      const view = await index.begin();

      const elsewhere = join(outside, "owner.yaml");
      await Deno.writeTextFile(elsewhere, yamlOf(id, "elsewhere"));
      await Deno.remove(path);
      await Deno.symlink(elsewhere, path, { type: "file" });

      assertEquals(await view.findAllById(id as DefinitionId), []);
    });
  });
});

Deno.test("DefinitionIdIndex: traces how many files a check read", async () => {
  await withTempDir(async (dir) => {
    const { primary, index } = fixture(dir);
    for (let i = 0; i < 40; i++) {
      await writeDefinition(
        join(primary, "test", "a", `d${i}.yaml`),
        crypto.randomUUID(),
        `d${i}`,
      );
    }
    await withCapturedSpans(async (spans) => {
      await index.begin();
      const validate = findSpan(spans, "swamp.serve.definition_index.validate");
      assertEquals(validate.attributes["definition_index.files_parsed"], 40);
      assertEquals(validate.attributes["definition_index.definitions"], 40);
    });
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

Deno.test("DefinitionIdIndex: a cancelled request stops at once without stopping another request's check", async () => {
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

Deno.test("DefinitionIdIndex: inside the step_outputs area a check is an owner_index phase over its validate span, cold, then warm, then refreshed", async () => {
  await withTempDir(async (dir) => {
    const { primary, index } = fixture(dir);
    for (let i = 0; i < 3; i++) {
      await writeDefinition(
        join(primary, "test", "a", `d${i}.yaml`),
        crypto.randomUUID(),
        `d${i}`,
      );
    }
    await withObservedSpans(async (spans) => {
      const check = () =>
        withDiagnosticArea("step_outputs", () => index.begin());
      await check();
      await check();
      await writeDefinition(
        join(primary, "test", "a", "d3.yaml"),
        crypto.randomUUID(),
        "d3",
      );
      await check();

      const phases = diagnosticPhases(spans, "owner_index");
      const validates = spans.filter((s) =>
        s.name === "swamp.serve.definition_index.validate"
      );
      assertEquals(phases.length, 3);
      assertEquals(validates.length, 3);
      for (const [i, phase] of phases.entries()) {
        assert(isChildOf(validates[i], phase));
        assertEquals(phase.attributes["swamp.diagnostic.area"], "step_outputs");
        assertEquals(phase.attributes["swamp.outcome"], "ok");
      }
      assertEquals(
        phases.map((p) => [
          p.attributes["swamp.diagnostic.cache"],
          p.attributes["swamp.diagnostic.files_parsed"],
          p.attributes["swamp.diagnostic.definitions"],
          p.attributes["swamp.diagnostic.dirs_joined"],
        ]),
        [["cold", 3, 3, 0], ["warm", 0, 3, 0], ["refreshed", 1, 4, 0]],
      );
      // The validate span keeps what it exported before, and adds to it.
      assertEquals(validates[0].attributes["definition_index.files_parsed"], 3);
      assertEquals(validates[0].attributes["definition_index.files_joined"], 0);
    });
  });
});

Deno.test("DefinitionIdIndex: outside a diagnostic area a check exports its validate span alone", async () => {
  await withTempDir(async (dir) => {
    const { primary, index } = fixture(dir);
    await writeDefinition(
      join(primary, "test", "a", "d.yaml"),
      crypto.randomUUID(),
      "d",
    );
    await withObservedSpans(async (spans) => {
      await index.begin();
      assertEquals(spans.map((s) => s.name), [
        "swamp.serve.definition_index.validate",
      ]);
    });
  });
});

Deno.test("DefinitionIdIndex: a check that joins another's listing counts it as joined once and links to the check that ran it", async () => {
  await withTempDir(async (dir) => {
    const { primary, counter, index } = fixture(dir);
    for (let i = 0; i < 5; i++) {
      await writeDefinition(
        join(primary, "test", "a", `d${i}.yaml`),
        crypto.randomUUID(),
        `d${i}`,
      );
    }
    await withObservedSpans(async (spans) => {
      await Promise.all(
        [1, 2].map(() =>
          withDiagnosticArea("step_outputs", () => index.begin())
        ),
      );
      assertEquals(counter.reads, 5);
      const validates = spans.filter((s) =>
        s.name === "swamp.serve.definition_index.validate"
      );
      assertEquals(validates.length, 2);
      const num = (s: (typeof validates)[number], key: string) =>
        s.attributes[`definition_index.${key}`] as number;
      // Every file was parsed once: what one check joined, the other read.
      assertEquals(
        validates.reduce(
          (sum, s) => sum + num(s, "files_parsed") - num(s, "files_joined"),
          0,
        ),
        5,
      );
      const joiners = validates.filter((s) => num(s, "dirs_joined") > 0);
      assert(joiners.length > 0);
      for (const joiner of joiners) {
        const other = validates.find((s) => s !== joiner)!;
        assertEquals(
          joiner.links.map((l) => l.context.spanId),
          [other.spanContext().spanId],
        );
      }
      const phases = diagnosticPhases(spans, "owner_index");
      assertEquals(
        phases.map((p) => p.attributes["swamp.diagnostic.files_joined"])
          .sort(),
        validates.map((s) => s.attributes["definition_index.files_joined"])
          .sort(),
      );
    });
  });
});

Deno.test("DefinitionIdIndex: a cancelled check ends its owner_index phase cancelled with the counts it reached", async () => {
  await withTempDir(async (dir) => {
    const { primary, index } = fixture(dir);
    await writeDefinition(
      join(primary, "test", "a", "d.yaml"),
      crypto.randomUUID(),
      "d",
    );
    await withObservedSpans(async (spans) => {
      const cancelled = new AbortController();
      const leaving = withDiagnosticArea(
        "step_outputs",
        () => index.begin(cancelled.signal),
      );
      cancelled.abort();
      await assertRejects(() => leaving);
      const [phase] = diagnosticPhases(spans, "owner_index");
      assertEquals(phase.attributes["swamp.outcome"], "cancelled");
      assertEquals(phase.attributes["swamp.diagnostic.cache"], "cold");
      assertEquals(
        typeof phase.attributes["swamp.diagnostic.dirs_checked"],
        "number",
      );
    });
  });
});

/** What a lookup by name found, as a global scan by name reports it. */
async function named(index: DefinitionIdIndex, name: string) {
  const found = await index.findByName(name);
  return found && {
    name: found.definition.name,
    id: found.definition.id,
    type: found.type.normalized,
  };
}

Deno.test("DefinitionIdIndex.findByName: finds what a scan by name finds, a definition shadowing an auto-definition and the first file in scan order winning", async () => {
  await withTempDir(async (dir) => {
    const { primary, auto, repo, index } = fixture(dir);
    // The same name in both roots, twice in one root, and across types.
    await writeDefinition(
      join(auto, "test", "a", "shared.yaml"),
      crypto.randomUUID(),
      "shared",
    );
    await writeDefinition(
      join(primary, "test", "z", "shared.yaml"),
      crypto.randomUUID(),
      "shared",
    );
    await writeDefinition(
      join(primary, "test", "b", "x.yaml"),
      crypto.randomUUID(),
      "twice",
    );
    await writeDefinition(
      join(primary, "test", "b", "nested", "y.yaml"),
      crypto.randomUUID(),
      "twice",
    );
    await writeDefinition(
      join(primary, "test", "a.yaml"),
      crypto.randomUUID(),
      "file-before-dir",
    );
    await writeDefinition(
      join(primary, "test", "a", "z.yaml"),
      crypto.randomUUID(),
      "file-before-dir",
    );
    await writeDefinition(
      join(auto, "other", "only-auto.yaml"),
      crypto.randomUUID(),
      "only-auto",
    );
    await Deno.writeTextFile(
      join(primary, "test", "b", "broken.yaml"),
      "id: [unclosed\n",
    );

    for (
      const name of [
        "shared",
        "twice",
        "file-before-dir",
        "only-auto",
        "missing",
      ]
    ) {
      const scanned = await repo.findByNameGlobal(name);
      assertEquals(
        await named(index, name),
        scanned && {
          name: scanned.definition.name,
          id: scanned.definition.id,
          type: scanned.type.normalized,
        },
        name,
      );
    }
    assertEquals((await named(index, "shared"))?.type, "test/z");
  });
});

Deno.test("DefinitionIdIndex.findByName: a miss once the index is warm reads no file, and a name another writer adds is found reading only its file", async () => {
  await withTempDir(async (dir) => {
    const { primary, auto, counter, index } = fixture(dir);
    for (let i = 0; i < 5; i++) {
      await writeDefinition(
        join(auto, "test", "a", `d${i}.yaml`),
        crypto.randomUUID(),
        `d${i}`,
      );
    }
    assertEquals(await index.findByName("new"), null);
    assertEquals(counter.reads, 5);
    for (let i = 0; i < 10; i++) {
      assertEquals(await index.findByName(`new-${i}`), null);
    }
    assertEquals(counter.reads, 5);

    await writeDefinition(
      join(auto, "test", "a", "new.yaml"),
      crypto.randomUUID(),
      "new",
    );
    assertEquals((await named(index, "new"))?.type, "test/a");
    // The new file when listed, then again when found.
    assertEquals(counter.reads, 7);

    // A definition added later under models/ shadows the auto-definition.
    await writeDefinition(
      join(primary, "test", "a", "new.yaml"),
      crypto.randomUUID(),
      "new",
    );
    const found = await index.findByName("new");
    assertEquals(found?.primary, true);
    assertEquals(found?.path, join(primary, "test", "a", "new.yaml"));
  });
});

Deno.test("DefinitionIdIndex.findByName: sees a definition another writer removes, moves, and replaces with one declaring another name", async () => {
  await withTempDir(async (dir) => {
    const { auto, index } = fixture(dir);
    const typeDir = join(auto, "test", "a");
    await writeDefinition(
      join(typeDir, "one.yaml"),
      crypto.randomUUID(),
      "one",
    );
    assertEquals((await named(index, "one"))?.name, "one");

    await Deno.rename(join(typeDir, "one.yaml"), join(typeDir, "moved.yaml"));
    await bump(typeDir);
    assertEquals(
      (await index.findByName("one"))?.path,
      join(typeDir, "moved.yaml"),
    );

    // Rewritten through a rename, as editors and save() write.
    const staged = join(auto, "staged.yaml");
    await Deno.writeTextFile(staged, yamlOf(crypto.randomUUID(), "two"));
    await Deno.rename(staged, join(typeDir, "moved.yaml"));
    await bump(join(typeDir, "moved.yaml"));
    await bump(typeDir);
    assertEquals(await index.findByName("one"), null);
    assertEquals((await named(index, "two"))?.name, "two");

    await Deno.remove(join(typeDir, "moved.yaml"));
    await bump(typeDir);
    assertEquals(await index.findByName("two"), null);
  });
});

Deno.test("DefinitionIdIndex.findByName: a file found rewritten in place at lookup is indexed under its new name", async () => {
  await withTempDir(async (dir) => {
    const { auto, index } = fixture(dir);
    const path = join(auto, "test", "a", "file.yaml");
    await writeDefinition(path, crypto.randomUUID(), "before");
    assertEquals((await named(index, "before"))?.name, "before");

    // Overwritten in place: the directory's stat does not move.
    await Deno.writeTextFile(path, yamlOf(crypto.randomUUID(), "after"));
    await bump(path);
    assertEquals(await index.findByName("before"), null);
    assertEquals((await named(index, "after"))?.name, "after");
  });
});

Deno.test("DefinitionIdIndex.findByName: a file that did not parse is found once fixed in place, and a read error is raised rather than taken for a miss", async () => {
  await withTempDir(async (dir) => {
    const { auto, counter, index } = fixture(dir);
    const path = join(auto, "test", "a", "fixed.yaml");
    await ensureDir(dirname(path));
    await Deno.writeTextFile(path, "id: [unclosed\n");
    await bump(path);
    assertEquals(await index.findByName("fixed"), null);

    await Deno.writeTextFile(path, yamlOf(crypto.randomUUID(), "fixed"));
    await bump(path);
    assertEquals((await named(index, "fixed"))?.name, "fixed");

    counter.failOn = path;
    await assertRejects(() => index.findByName("fixed"));
  });
});

Deno.test("DefinitionIdIndex.findByName: concurrent lookups of new names share one listing", async () => {
  await withTempDir(async (dir) => {
    const { auto, counter, index } = fixture(dir);
    for (let i = 0; i < 5; i++) {
      await writeDefinition(
        join(auto, "test", "a", `d${i}.yaml`),
        crypto.randomUUID(),
        `d${i}`,
      );
    }
    const found = await Promise.all(
      Array.from({ length: 36 }, (_, i) => index.findByName(`new-${i}`)),
    );
    assertEquals(found.filter((f) => f !== null), []);
    assertEquals(counter.reads, 5);
  });
});

Deno.test("DefinitionIdIndex.findByName: inside a diagnostic area a lookup's check is a definition_scan phase with the global_index strategy", async () => {
  await withTempDir(async (dir) => {
    const { auto, index } = fixture(dir);
    await writeDefinition(
      join(auto, "test", "a", "d.yaml"),
      crypto.randomUUID(),
      "d",
    );
    await withObservedSpans(async (spans) => {
      await withDiagnosticArea("enrollment", () => index.findByName("d"));
      const [phase] = diagnosticPhases(spans, "definition_scan");
      assertEquals(phase.attributes["swamp.diagnostic.scan_root"], "all");
      assertEquals(
        phase.attributes["swamp.diagnostic.scan_strategy"],
        "global_index",
      );
      assertEquals(phase.attributes["swamp.diagnostic.cache"], "cold");
      assertEquals(diagnosticPhases(spans, "owner_index"), []);
    });
  });
});
