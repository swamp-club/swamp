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
import { join } from "@std/path";
import { ModelType } from "../../domain/models/model_type.ts";
import { UserError } from "../../domain/errors.ts";
import { AutoDefinitionNameIndex } from "./auto_definition_name_index.ts";
import { YamlDefinitionRepository } from "./yaml_definition_repository.ts";
import {
  diagnosticPhases,
  findSpan,
  isChildOf,
  withCapturedSpans,
  withObservedSpans,
} from "../tracing/span_test_helpers.ts";
import {
  observeDiagnosticPhase,
  withDiagnosticArea,
} from "../../domain/diagnostics/diagnostic_phase.ts";
import { type RecordFingerprint, statRecord } from "./workflow_run_index.ts";

const TYPE = ModelType.create("test/a");

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
 * A type directory of auto-definitions in `dir`, a reader that counts file
 * reads, and an index whose clock runs a minute ahead, so every stat the
 * test sets is old enough to trust and only a stat that moved makes it list
 * or read again.
 */
async function fixture(dir: string, options: { realClock?: boolean } = {}) {
  const auto = join(dir, ".swamp", "auto-definitions");
  const typeDir = join(auto, TYPE.toDirectoryPath());
  await ensureDir(typeDir);
  const repo = new YamlDefinitionRepository(
    dir,
    undefined,
    join(dir, "models"),
    auto,
  );
  const counter = { reads: 0, failOn: undefined as string | undefined };
  // Stats a test pins, as a file rewritten within one clock tick looks.
  const frozen = new Map<string, RecordFingerprint>();
  const index = new AutoDefinitionNameIndex(
    typeDir,
    TYPE,
    (path, segments, isSymlink) => {
      counter.reads++;
      if (path === counter.failOn) {
        return Promise.reject(new Error(`failed to read ${path}`));
      }
      return repo.readDefinitionFile(path, segments, isSymlink);
    },
    {
      ...(options.realClock ? {} : { now: () => Date.now() + 60_000 }),
      stat: (path) =>
        frozen.has(path) ? Promise.resolve(frozen.get(path)) : statRecord(path),
    },
  );
  return { typeDir, counter, frozen, index };
}

let clock = Date.UTC(2020, 0, 1);

/** Gives `path` an mtime no earlier change has used. */
async function bump(path: string): Promise<void> {
  clock += 1_000;
  await Deno.utime(path, new Date(clock), new Date(clock));
}

/** Writes a definition file, then moves its own and its directory's mtime. */
async function writeDefinition(
  typeDir: string,
  file: string,
  name: string,
  id: string = crypto.randomUUID(),
): Promise<string> {
  const path = join(typeDir, file);
  await Deno.writeTextFile(path, `id: ${id}\nname: ${name}\nversion: 1\n`);
  await bump(path);
  await bump(typeDir);
  return path;
}

/** Rewrites a file in place: its directory's stat does not move. */
async function rewriteInPlace(
  path: string,
  name: string,
  id: string = crypto.randomUUID(),
): Promise<void> {
  await Deno.writeTextFile(path, `id: ${id}\nname: ${name}\nversion: 1\n`);
  await bump(path);
}

Deno.test("AutoDefinitionNameIndex.find: finds a legacy uuid-named file by the name it declares", async () => {
  await withTempDir(async (dir) => {
    const { typeDir, index } = await fixture(dir);
    const id = crypto.randomUUID();
    const path = await writeDefinition(typeDir, `${id}.yaml`, "legacy", id);
    await writeDefinition(typeDir, "plain.yaml", "plain");

    const found = await index.find("legacy");
    assertEquals(found?.definition.id as string | undefined, id);
    assertEquals(found?.path, path);
    assertEquals(await index.find("missing"), null);
  });
});

Deno.test("AutoDefinitionNameIndex.find: answers with the file a name gives first, which the caller reads before asking", async () => {
  await withTempDir(async (dir) => {
    const { typeDir, index } = await fixture(dir);
    const path = await writeDefinition(typeDir, "plain.yaml", "plain");
    const id = crypto.randomUUID();
    await writeDefinition(typeDir, `${id}.yaml`, "plain", id);

    assertEquals((await index.find("plain"))?.path, path);
  });
});

Deno.test("AutoDefinitionNameIndex.find: finds a file whose name is not its filename, and a name that is not filename-safe", async () => {
  await withTempDir(async (dir) => {
    const { typeDir, index } = await fixture(dir);
    await writeDefinition(typeDir, "plain.yaml", "other");
    const id = crypto.randomUUID();
    await writeDefinition(typeDir, `${id}.yaml`, "Not Safe", id);

    assertEquals(
      (await index.find("other"))?.path,
      join(typeDir, "plain.yaml"),
    );
    assertEquals(
      (await index.find("Not Safe"))?.definition.id as string | undefined,
      id,
    );
  });
});

Deno.test("AutoDefinitionNameIndex.find: a miss reads every file once, then only the files new since", async () => {
  await withTempDir(async (dir) => {
    const { typeDir, counter, index } = await fixture(dir);
    for (let i = 0; i < 20; i++) {
      await writeDefinition(typeDir, `worker-${i}.yaml`, `worker-${i}`);
    }

    assertEquals(await index.find("new-worker"), null);
    assertEquals(counter.reads, 20);

    // Nothing changed: no file is read.
    assertEquals(await index.find("new-worker"), null);
    assertEquals(counter.reads, 20);

    await writeDefinition(typeDir, "new-worker.yaml", "new-worker");
    assertEquals(await index.find("another-worker"), null);
    assertEquals(counter.reads, 21);
  });
});

Deno.test("AutoDefinitionNameIndex.find: a removed file is no longer found", async () => {
  await withTempDir(async (dir) => {
    const { typeDir, index } = await fixture(dir);
    const id = crypto.randomUUID();
    const path = await writeDefinition(typeDir, `${id}.yaml`, "legacy", id);
    assertEquals(
      (await index.find("legacy"))?.definition.id as string | undefined,
      id,
    );

    await Deno.remove(path);
    await bump(typeDir);
    assertEquals(await index.find("legacy"), null);
  });
});

Deno.test("AutoDefinitionNameIndex.find: sees a uuid-named file renamed in place without its directory changing", async () => {
  await withTempDir(async (dir) => {
    const { typeDir, index } = await fixture(dir);
    const id = crypto.randomUUID();
    const path = await writeDefinition(
      typeDir,
      `${id}.yaml`,
      "Before Name",
      id,
    );
    assertEquals(
      (await index.find("Before Name"))?.definition.id as string | undefined,
      id,
    );

    await rewriteInPlace(path, "After Name", id);
    assertEquals(await index.find("Before Name"), null);
    assertEquals(
      (await index.find("After Name"))?.definition.id as string | undefined,
      id,
    );
  });
});

Deno.test("AutoDefinitionNameIndex.find: a file found rewritten at lookup is not returned, and is read again", async () => {
  await withTempDir(async (dir) => {
    const { typeDir, frozen, index } = await fixture(dir);
    const id = crypto.randomUUID();
    const path = await writeDefinition(typeDir, `${id}.yaml`, "first", id);
    assertEquals(
      (await index.find("first"))?.definition.id as string | undefined,
      id,
    );

    // Its stat says nothing changed: only the lookup's own read can tell.
    frozen.set(path, (await statRecord(path))!);
    await rewriteInPlace(path, "second", id);
    assertEquals(await index.find("first"), null);
    frozen.delete(path);
    assertEquals(
      (await index.find("second"))?.definition.id as string | undefined,
      id,
    );
  });
});

Deno.test("AutoDefinitionNameIndex.find: a broken file declares nothing until it is fixed", async () => {
  await withTempDir(async (dir) => {
    const { typeDir, index } = await fixture(dir);
    const id = crypto.randomUUID();
    const path = join(typeDir, `${id}.yaml`);
    await Deno.writeTextFile(path, "id: [unterminated\n");
    await bump(path);
    await bump(typeDir);
    assertEquals(await index.find("fixed"), null);

    await rewriteInPlace(path, "fixed", id);
    assertEquals(
      (await index.find("fixed"))?.definition.id as string | undefined,
      id,
    );
  });
});

Deno.test("AutoDefinitionNameIndex.find: follows a symlink's target as it changes, and refuses one that leaves the repository", async () => {
  await withTempDir(async (dir) => {
    const { typeDir, index } = await fixture(dir);
    const targetDir = join(dir, "elsewhere");
    await ensureDir(targetDir);
    const id = crypto.randomUUID();
    const target = join(targetDir, "target.yaml");
    await Deno.writeTextFile(target, `id: ${id}\nname: linked\nversion: 1\n`);
    await bump(target);
    await Deno.symlink(target, join(typeDir, "link.yaml"), { type: "file" });
    await bump(typeDir);
    assertEquals(
      (await index.find("linked"))?.definition.id as string | undefined,
      id,
    );

    await rewriteInPlace(target, "relinked", id);
    assertEquals(await index.find("linked"), null);
    assertEquals(
      (await index.find("relinked"))?.definition.id as string | undefined,
      id,
    );

    await withTempDir(async (outside) => {
      const escaped = join(outside, "escaped.yaml");
      await Deno.writeTextFile(
        escaped,
        `id: ${id}\nname: escaped\nversion: 1\n`,
      );
      await Deno.symlink(escaped, join(typeDir, "escape.yaml"), {
        type: "file",
      });
      await bump(typeDir);
      assertEquals(await index.find("escaped"), null);
    });
  });
});

Deno.test("AutoDefinitionNameIndex.find: a missing directory finds nothing, then is read once it appears", async () => {
  await withTempDir(async (dir) => {
    const { typeDir, index } = await fixture(dir);
    await Deno.remove(typeDir);
    assertEquals(await index.find("legacy"), null);

    await ensureDir(typeDir);
    const id = crypto.randomUUID();
    await writeDefinition(typeDir, `${id}.yaml`, "legacy", id);
    assertEquals(
      (await index.find("legacy"))?.definition.id as string | undefined,
      id,
    );
  });
});

Deno.test("AutoDefinitionNameIndex.find: a listing that fails leaves the index as it was", async () => {
  await withTempDir(async (dir) => {
    const { typeDir, counter, index } = await fixture(dir);
    const id = crypto.randomUUID();
    await writeDefinition(typeDir, `${id}.yaml`, "legacy", id);
    assertEquals(
      (await index.find("legacy"))?.definition.id as string | undefined,
      id,
    );

    const newId = crypto.randomUUID();
    counter.failOn = await writeDefinition(
      typeDir,
      `${newId}.yaml`,
      "newer",
      newId,
    );
    await assertRejects(() => index.find("newer"), Error, "failed to read");

    counter.failOn = undefined;
    assertEquals(
      (await index.find("legacy"))?.definition.id as string | undefined,
      id,
    );
    assertEquals(
      (await index.find("newer"))?.definition.id as string | undefined,
      newId,
    );
  });
});

Deno.test("AutoDefinitionNameIndex.find: overlapping lookups share one check", async () => {
  await withTempDir(async (dir) => {
    const { typeDir, counter, index } = await fixture(dir);
    for (let i = 0; i < 5; i++) {
      await writeDefinition(typeDir, `worker-${i}.yaml`, `worker-${i}`);
    }

    await Promise.all([index.find("a"), index.find("b"), index.find("c")]);
    // The first check reads every file; the two queued behind it share one
    // check, which finds nothing changed.
    assertEquals(counter.reads, 5);
  });
});

Deno.test("AutoDefinitionNameIndex.find: inside the racy window it lists again but reads only new files", async () => {
  await withTempDir(async (dir) => {
    const { typeDir, index } = await fixture(dir, { realClock: true });
    for (let i = 0; i < 3; i++) {
      // Written now, so the directory's stat is too recent to trust.
      await Deno.writeTextFile(
        join(typeDir, `worker-${i}.yaml`),
        `id: ${crypto.randomUUID()}\nname: worker-${i}\nversion: 1\n`,
      );
    }
    await index.find("new-worker");

    await withCapturedSpans(async (spans) => {
      await index.find("new-worker");
      const span = findSpan(spans, "swamp.definition.name_index.validate");
      assertEquals(span.attributes["name_index.relisted"], true);
      assertEquals(span.attributes["name_index.files_parsed"], 0);
      assertEquals(span.attributes["name_index.entries"], 3);
    });
  });
});

Deno.test({
  name:
    "AutoDefinitionNameIndex.find: raises an I/O error reading the file a name gives, rather than finding nothing",
  // Windows has no file modes; root reads any file whatever its mode.
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    await withTempDir(async (dir) => {
      const { typeDir, index } = await fixture(dir);
      const path = await writeDefinition(typeDir, "plain.yaml", "plain");
      assertEquals(await index.find("other"), null);

      // The caller's own read of plain.yaml failed and reported a miss.
      await Deno.chmod(path, 0o000);
      try {
        await assertRejects(
          () => index.find("plain"),
          UserError,
          "Failed to read definition file",
        );
      } finally {
        await Deno.chmod(path, 0o644);
      }
    });
  },
});

Deno.test("AutoDefinitionNameIndex.find: a name-derived file rewritten in place to declare another name is not seen (documented gap, until a lookup of its old name)", async () => {
  await withTempDir(async (dir) => {
    const { typeDir, index } = await fixture(dir);
    const path = await writeDefinition(typeDir, "plain.yaml", "plain");
    assertEquals(await index.find("renamed"), null);

    // Only save() writes auto-definitions, and it moves a renamed definition
    // to its new name's path; an in-place edit like this one is not seen
    // until the file is listed anew.
    await rewriteInPlace(path, "renamed");
    assertEquals(await index.find("renamed"), null);

    // A lookup of the name it declared before reads it, and sees the change.
    assertEquals(await index.find("plain"), null);
    assertEquals((await index.find("renamed"))?.path, path);
  });
});

Deno.test("AutoDefinitionNameIndex.find: the lookup that queued a check counts it, and one that joined it says so", async () => {
  await withTempDir(async (dir) => {
    const { typeDir, index } = await fixture(dir);
    await writeDefinition(typeDir, "a.yaml", "a");
    await writeDefinition(typeDir, `${crypto.randomUUID()}.yaml`, "legacy");
    await withObservedSpans(async (spans) => {
      await withDiagnosticArea("enrollment", () => {
        const lookup = (label: string) =>
          observeDiagnosticPhase(
            "definition_scan",
            { "swamp.diagnostic.scan_root": label },
            () => index.find("legacy"),
          );
        // Both ask before the queued check starts, so the second joins it.
        return Promise.all([lookup("first"), lookup("second")]);
      });
      const [first, second] = ["first", "second"].map((label) =>
        diagnosticPhases(spans, "definition_scan").find((span) =>
          span.attributes["swamp.diagnostic.scan_root"] === label
        )!
      );
      assertEquals(first.attributes["swamp.diagnostic.index_checks_run"], 1);
      assertEquals(first.attributes["swamp.diagnostic.index_relists"], 1);
      assertEquals(first.attributes["swamp.diagnostic.index_entries"], 2);
      assertEquals(
        first.attributes["swamp.diagnostic.index_checks_joined"],
        undefined,
      );
      assertEquals(
        second.attributes["swamp.diagnostic.index_checks_joined"],
        1,
      );
      assertEquals(
        second.attributes["swamp.diagnostic.index_checks_run"],
        undefined,
      );
      const check = findSpan(spans, "swamp.definition.name_index.validate");
      assertEquals(isChildOf(check, first), true);
    });
  });
});
