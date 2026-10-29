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

/**
 * A managed-config edit names the version it started from (swamp-club#4097):
 * two checkouts of one v3 datastore load a definition at the same version,
 * A saves an edit, and B's edit of the version it loaded is refused with
 * `config_edit_conflict` instead of replacing A's. Each command runs as its
 * own process would: the v3 handles close between commands, so the next one
 * catches its checkout up when it opens.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { walk } from "@std/fs";
import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { configEditConflictOf } from "../src/domain/datastore_v3/config_edit_conflict.ts";
import { closeV3Datastores } from "../src/infrastructure/datastore_v3/v3_repo_context.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { useEditorSessionDepsForTesting } from "../src/libswamp/editor_session.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  runCli,
  runCliRejecting,
  UNSET_ENV,
  withStdin,
} from "./usecase_sync_fixtures.ts";
import { datastoreRecords, withV3RowRepos } from "./usecase_v3_fixtures.ts";

await initializeLogging({});

const json = (repoDir: string) => ["--repo-dir", repoDir, "--json"];

type Kind = "workflow" | "model" | "vault";

/** Runs one command in `repoDir` as its own process, returning its JSON. */
async function cli(
  repoDir: string,
  args: string[],
  stdin?: string,
): Promise<Record<string, unknown>> {
  try {
    const out = await withMockedEnv(
      UNSET_ENV,
      () => runCli({ args: [...args, ...json(repoDir)], stdin }),
    );
    const text = out.join("\n").trim();
    return text === "" ? {} : JSON.parse(text);
  } finally {
    await closeV3Datastores();
  }
}

/** Runs one command that must fail, as its own process; returns its error. */
async function cliRejecting(
  repoDir: string,
  args: string[],
  stdin?: string,
): Promise<unknown> {
  const invocation = { args: [...args, ...json(repoDir)] };
  try {
    return await withMockedEnv(
      UNSET_ENV,
      () =>
        stdin === undefined
          ? runCliRejecting(invocation)
          : withStdin(stdin, () => runCliRejecting(invocation)),
    );
  } finally {
    await closeV3Datastores();
  }
}

/**
 * The definition `name` of `kind` as checkout `repoDir` holds it, parsed,
 * after a `get` (its own command) caught the checkout up.
 */
async function loaded(
  repoDir: string,
  kind: Kind,
  name: string,
): Promise<Record<string, unknown>> {
  await cli(repoDir, [kind, "get", name]);
  const tree =
    { workflow: "workflows", model: "models", vault: "vaults" }[kind];
  for await (
    const entry of walk(swampPath(repoDir, "config", tree), {
      includeDirs: false,
      exts: [".yaml"],
    })
  ) {
    const doc = parseYaml(await Deno.readTextFile(entry.path)) as Record<
      string,
      unknown
    >;
    if (doc.name === name) return doc;
  }
  throw new Error(`no ${kind} ${name} in ${repoDir}`);
}

/** Asserts `error` is the stale-edit refusal of `name`, saying who and when. */
function assertConflict(error: unknown, kind: Kind, name: string): void {
  const conflict = configEditConflictOf(error);
  assert(conflict !== undefined, `not an edit conflict: ${error}`);
  assertEquals(conflict.code, "config_edit_conflict");
  assertEquals(conflict.conflicts.length, 1);
  const [only] = conflict.conflicts;
  assertEquals([only.kind, only.name], [kind, name]);
  assert(only.changedBy !== undefined, "the refusal says who changed it");
  assert(only.changedAt !== undefined, "the refusal says when");
  assert(
    conflict.message.includes(`'${name}'`) &&
      conflict.message.includes(only.changedBy) &&
      conflict.message.includes(only.changedAt),
    `the message names ${name}, who and when: ${conflict.message}`,
  );
}

/** Creates `name` of `kind` in `repoDir`. */
async function create(repoDir: string, kind: Kind, name: string) {
  switch (kind) {
    case "workflow":
      return await cli(repoDir, ["workflow", "create", name]);
    case "model":
      return await cli(repoDir, ["model", "create", "command/shell", name]);
    case "vault":
      return await cli(repoDir, ["vault", "create", "local_encryption", name]);
  }
}

/** A field each kind keeps as given, and two values for it. */
function withEdit(
  kind: Kind,
  doc: Record<string, unknown>,
  by: string,
): Record<string, unknown> {
  return kind === "vault"
    ? { ...doc, config: { ...(doc.config as object), editedBy: by } }
    : { ...doc, tags: { editedBy: by } };
}

function editedBy(kind: Kind, doc: Record<string, unknown>): unknown {
  return kind === "vault"
    ? (doc.config as Record<string, unknown>).editedBy
    : (doc.tags as Record<string, unknown> | undefined)?.editedBy;
}

for (const kind of ["workflow", "model", "vault"] as const) {
  Deno.test(`config edit conflict: B's stdin edit of the ${kind} version it loaded is refused after A saved, and A's edit stands`, async () => {
    await withV3RowRepos({ managedConfig: true }, async (repos) => {
      await create(repos.repoA, kind, "deploy");
      // Both checkouts load deploy at the same version.
      const base = await loaded(repos.repoB, kind, "deploy");
      await loaded(repos.repoA, kind, "deploy");

      await cli(
        repos.repoA,
        [kind, "edit", "deploy"],
        stringifyYaml(withEdit(kind, base, "A")),
      );
      const error = await cliRejecting(
        repos.repoB,
        [kind, "edit", "deploy"],
        stringifyYaml(withEdit(kind, base, "B")),
      );
      assertConflict(error, kind, "deploy");

      // A's edit stands, in the log and in B's checkout.
      for (const repoDir of [repos.repoA, repos.repoB]) {
        assertEquals(
          editedBy(kind, await loaded(repoDir, kind, "deploy")),
          "A",
        );
      }
    });
  });

  Deno.test(`config edit conflict: B's edit after it loaded A's ${kind} version saves`, async () => {
    await withV3RowRepos({ managedConfig: true }, async (repos) => {
      await create(repos.repoA, kind, "deploy");
      const base = await loaded(repos.repoA, kind, "deploy");
      await cli(
        repos.repoA,
        [kind, "edit", "deploy"],
        stringifyYaml(withEdit(kind, base, "A")),
      );
      // B loads A's version before it edits.
      const seen = await loaded(repos.repoB, kind, "deploy");
      assertEquals(editedBy(kind, seen), "A");
      await cli(
        repos.repoB,
        [kind, "edit", "deploy"],
        stringifyYaml(withEdit(kind, seen, "B")),
      );
      assertEquals(
        editedBy(kind, await loaded(repos.repoA, kind, "deploy")),
        "B",
      );
    });
  });
}

Deno.test("config edit conflict: a checkout's first command, a stdin edit of the head of a definition it never held, saves", async () => {
  await withV3RowRepos({ managedConfig: true }, async (repos) => {
    await create(repos.repoA, "workflow", "deploy");
    const v1 = await loaded(repos.repoA, "workflow", "deploy");
    await cli(
      repos.repoA,
      ["workflow", "edit", "deploy"],
      stringifyYaml(withEdit("workflow", v1, "A")),
    );
    // B has run nothing since A created and edited deploy: its catch-up
    // applies both commits, and B's edit starts from the head.
    const head = await loaded(repos.repoA, "workflow", "deploy");
    await cli(
      repos.repoB,
      ["workflow", "edit", "deploy"],
      stringifyYaml({ ...head, description: "from B" }),
    );
    const now = await loaded(repos.repoA, "workflow", "deploy");
    assertEquals([now.description, editedBy("workflow", now)], [
      "from B",
      "A",
    ]);
  });
});

Deno.test("config edit conflict: a definition whose file was edited by hand, out of step with the store, is still deleted", async () => {
  await withV3RowRepos({ managedConfig: true }, async (repos) => {
    await create(repos.repoA, "workflow", "deploy");
    const doc = await loaded(repos.repoA, "workflow", "deploy");
    // As an editor-mode edit leaves it: the file changed, nothing committed.
    for await (
      const entry of walk(swampPath(repos.repoA, "config", "workflows"), {
        includeDirs: false,
        exts: [".yaml"],
      })
    ) {
      await Deno.writeTextFile(
        entry.path,
        stringifyYaml({ ...doc, description: "by hand" }),
      );
    }
    await cli(repos.repoA, deleteArgs("workflow", "deploy"));
    await cliRejecting(repos.repoB, ["workflow", "get", "deploy"]);
  });
});

for (const kind of ["workflow", "model", "vault"] as const) {
  Deno.test(`config edit conflict: retrying a refused stale ${kind} edit unchanged is refused again, and saves once B loads A's version`, async () => {
    await withV3RowRepos({ managedConfig: true }, async (repos) => {
      await create(repos.repoA, kind, "deploy");
      const base = await loaded(repos.repoB, kind, "deploy");
      await cli(
        repos.repoA,
        [kind, "edit", "deploy"],
        stringifyYaml(withEdit(kind, base, "A")),
      );
      const stale = stringifyYaml(withEdit(kind, base, "B"));
      for (let attempt = 0; attempt < 2; attempt++) {
        assertConflict(
          await cliRejecting(repos.repoB, [kind, "edit", "deploy"], stale),
          kind,
          "deploy",
        );
      }
      // Reading another definition does not count as loading this one.
      await create(repos.repoA, kind, "other");
      await loaded(repos.repoB, kind, "other");
      assertConflict(
        await cliRejecting(repos.repoB, [kind, "edit", "deploy"], stale),
        kind,
        "deploy",
      );
      const seen = await loaded(repos.repoB, kind, "deploy");
      await cli(
        repos.repoB,
        [kind, "edit", "deploy"],
        stringifyYaml(withEdit(kind, seen, "B")),
      );
      assertEquals(
        editedBy(kind, await loaded(repos.repoA, kind, "deploy")),
        "B",
      );
    });
  });
}

Deno.test("config edit conflict: B's stale edit is refused when its own earlier edit and A's later one reach B in one catch-up", async () => {
  await withV3RowRepos({ managedConfig: true }, async (repos) => {
    await create(repos.repoA, "workflow", "deploy");
    await loaded(repos.repoA, "workflow", "deploy");
    const v1 = await loaded(repos.repoB, "workflow", "deploy");
    // B edits; B's next command applies B's own commit at its catch-up.
    const v2 = withEdit("workflow", v1, "B");
    await cli(repos.repoB, ["workflow", "edit", "deploy"], stringifyYaml(v2));
    const seenByA = await loaded(repos.repoA, "workflow", "deploy");
    await cli(
      repos.repoA,
      ["workflow", "edit", "deploy"],
      stringifyYaml({ ...seenByA, description: "from A" }),
    );
    // B edits again from its own version, never having loaded A's.
    assertConflict(
      await cliRejecting(
        repos.repoB,
        ["workflow", "edit", "deploy"],
        stringifyYaml({ ...v2, description: "from B" }),
      ),
      "workflow",
      "deploy",
    );
    const now = await loaded(repos.repoA, "workflow", "deploy");
    assertEquals(now.description, "from A");
  });
});

Deno.test("config edit conflict: a stale behavior delete is refused before it removes the behavior's outputs or data", async () => {
  await withV3RowRepos({ managedConfig: true }, async (repos) => {
    const type = repos.modelType.normalized;
    await cli(repos.repoA, ["model", "create", type, "deploy"]);
    await cli(repos.repoA, ["model", "method", "run", "deploy", "noop"]);
    const base = await loaded(repos.repoB, "model", "deploy");
    await cli(
      repos.repoA,
      ["model", "edit", "deploy"],
      stringifyYaml(withEdit("model", base, "A")),
    );
    await loaded(repos.repoA, "model", "deploy");
    const before = await datastoreRecords(repos.repoA);
    assert(
      [...before.keys()].some((key) => !key.startsWith("config/")),
      `the behavior has records besides its definition: ${[...before.keys()]}`,
    );
    assertConflict(
      await cliRejecting(repos.repoB, [
        "model",
        "delete",
        "deploy",
        "--force",
        "--yes",
      ]),
      "model",
      "deploy",
    );
    // Nothing of the delete landed: A catches up to the same records.
    await loaded(repos.repoA, "model", "deploy");
    assertEquals(await datastoreRecords(repos.repoA), before);
  });
});

for (const kind of ["workflow", "model", "vault"] as const) {
  Deno.test(`config edit conflict: a stale ${kind} rename named by id is refused before it creates the new name`, async () => {
    await withV3RowRepos({ managedConfig: true }, async (repos) => {
      await create(repos.repoA, kind, "deploy");
      const base = await loaded(repos.repoB, kind, "deploy");
      await cli(
        repos.repoA,
        [kind, "edit", "deploy"],
        stringifyYaml(withEdit(kind, base, "A")),
      );
      // A vault rename needs no flag; the others ask for one.
      const rename = kind === "vault" ? [] : ["--allow-rename"];
      assertConflict(
        await cliRejecting(
          repos.repoB,
          [kind, "edit", String(base.id), ...rename],
          stringifyYaml({ ...base, name: "deploy2" }),
        ),
        kind,
        "deploy",
      );
      await cliRejecting(repos.repoA, [kind, "get", "deploy2"]);
      assertEquals(
        editedBy(kind, await loaded(repos.repoA, kind, "deploy")),
        "A",
      );
    });
  });
}

for (const kind of ["workflow", "model", "vault"] as const) {
  Deno.test({
    name:
      `config edit conflict: an editor-mode ${kind} edit opens on the current version without a refusal, while a stale stdin edit stays refused`,
    // The editor is POSIX true, which exits at once; Windows has none.
    ignore: Deno.build.os === "windows",
    fn: () => editorModeOpens(kind),
  });
}

async function editorModeOpens(kind: Kind): Promise<void> {
  await withV3RowRepos({ managedConfig: true }, async (repos) => {
    await create(repos.repoA, kind, "deploy");
    const base = await loaded(repos.repoB, kind, "deploy");
    await cli(
      repos.repoA,
      [kind, "edit", "deploy"],
      stringifyYaml(withEdit(kind, base, "A")),
    );
    assertConflict(
      await cliRejecting(
        repos.repoB,
        [kind, "edit", "deploy"],
        stringifyYaml(withEdit(kind, base, "B")),
      ),
      kind,
      "deploy",
    );
    // No stdin: the editor opens on a copy of B's caught-up file, A's
    // version. The editor here closes at once, as a user who closes it
    // unchanged.
    const restore = useEditorSessionDepsForTesting({
      prepareEditor: (path) =>
        Promise.resolve({
          editor: "Fake",
          waitsForExit: true,
          waitConfirmed: true,
          open: () => Promise.resolve({ editor: "Fake", path, success: true }),
        }),
    });
    try {
      await withMockedEnv(
        UNSET_ENV,
        () =>
          withStdin(
            null,
            () =>
              runCli({
                args: [kind, "edit", "deploy", ...json(repos.repoB)],
              }),
          ),
      );
    } finally {
      restore();
      await closeV3Datastores();
    }
    // The edit succeeded and left A's version as it was.
    assertEquals(
      editedBy(kind, await loaded(repos.repoB, kind, "deploy")),
      "A",
    );
  });
}

/**
 * Gives both checkouts another default vault: a remove keeps the
 * repository's default vault.
 */
async function pinDefaultVault(repos: { repoA: string; repoB: string }) {
  await cli(repos.repoA, ["vault", "create", "local_encryption", "keeper"]);
  for (const repoDir of [repos.repoA, repos.repoB]) {
    const path = join(repoDir, ".swamp.yaml");
    const text = await Deno.readTextFile(path);
    await Deno.writeTextFile(path, text.trimEnd() + "\ndefaultVault: keeper\n");
  }
}

/** Deletes `name` of `kind`: `vault remove` is a vault config's delete. */
function deleteArgs(kind: Kind, name: string): string[] {
  return kind === "vault"
    ? ["vault", "remove", name, "--yes"]
    : [kind, "delete", name, "--yes"];
}

for (const kind of ["workflow", "model", "vault"] as const) {
  Deno.test(`config edit conflict: B's delete of the ${kind} version it loaded is refused after A edited it, and A's edit stands`, async () => {
    await withV3RowRepos({ managedConfig: true }, async (repos) => {
      if (kind === "vault") await pinDefaultVault(repos);
      await create(repos.repoA, kind, "deploy");
      const base = await loaded(repos.repoB, kind, "deploy");
      await cli(
        repos.repoA,
        [kind, "edit", "deploy"],
        stringifyYaml(withEdit(kind, base, "A")),
      );
      const error = await cliRejecting(repos.repoB, deleteArgs(kind, "deploy"));
      assertConflict(error, kind, "deploy");
      for (const repoDir of [repos.repoA, repos.repoB]) {
        assertEquals(
          editedBy(kind, await loaded(repoDir, kind, "deploy")),
          "A",
        );
      }
    });
  });

  Deno.test(`config edit conflict: B's delete after it loaded A's ${kind} version removes it`, async () => {
    await withV3RowRepos({ managedConfig: true }, async (repos) => {
      if (kind === "vault") await pinDefaultVault(repos);
      await create(repos.repoA, kind, "deploy");
      const base = await loaded(repos.repoA, kind, "deploy");
      await cli(
        repos.repoA,
        [kind, "edit", "deploy"],
        stringifyYaml(withEdit(kind, base, "A")),
      );
      await loaded(repos.repoB, kind, "deploy");
      await cli(repos.repoB, deleteArgs(kind, "deploy"));
      await cliRejecting(repos.repoA, [kind, "get", "deploy"]);
    });
  });
}
