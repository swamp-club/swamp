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
 * An edit made in the editor is a committed edit (swamp-club#4107): the
 * editor works on a copy, and the copy is saved through the repository as a
 * piped edit is. Before the fix, a v3 checkout's editor edit changed only
 * its own file, so the other checkout never saw it. Each command runs as its
 * own process would: the v3 handles close between commands. The editor is a
 * shell script set as EDITOR, so these cases skip on Windows.
 */

import "../src/domain/models/models.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { walk } from "@std/fs";
import { dirname, join } from "@std/path";
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
  settle,
  UNSET_ENV,
  withRowRepos,
  withStdin,
} from "./usecase_sync_fixtures.ts";
import { withV3RowRepos } from "./usecase_v3_fixtures.ts";

await initializeLogging({});

const ignore = Deno.build.os === "windows";

type Kind = "workflow" | "model" | "vault";

const json = (repoDir: string) => ["--repo-dir", repoDir, "--json"];

/** Runs one command in `repoDir` as its own process, returning its JSON. */
async function cli(
  repoDir: string,
  args: string[],
  options: { stdin?: string | null; env?: Record<string, string> } = {},
): Promise<Record<string, unknown>> {
  try {
    const out = await withMockedEnv(
      { ...UNSET_ENV, ...options.env },
      () =>
        options.stdin === undefined
          ? runCli({ args: [...args, ...json(repoDir)] })
          : withStdin(
            options.stdin,
            () => runCli({ args: [...args, ...json(repoDir)] }),
          ),
    );
    const text = out.join("\n").trim();
    return text === "" ? {} : JSON.parse(text);
  } finally {
    await closeV3Datastores();
  }
}

/** Runs one editor-mode command that must fail; returns its error. */
async function cliRejecting(
  repoDir: string,
  args: string[],
  env: Record<string, string>,
): Promise<unknown> {
  try {
    return await withMockedEnv(
      { ...UNSET_ENV, ...env },
      () =>
        withStdin(
          null,
          () => runCliRejecting({ args: [...args, ...json(repoDir)] }),
        ),
    );
  } finally {
    await closeV3Datastores();
  }
}

/** The definition `name` of `kind` as checkout `repoDir` holds it after a `get`. */
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

/**
 * An editor script in `dir` that waits a moment, as a person would, then
 * replaces the file it is given with `content`, recording the path it was
 * given. Its EDITOR value is returned. It is not a known editor, so swamp
 * waits for its process to exit.
 */
async function scriptedEditor(
  dir: string,
  content: string,
): Promise<{ env: Record<string, string>; givenPath: () => Promise<string> }> {
  const next = join(dir, `next-${crypto.randomUUID()}.yaml`);
  const given = join(dir, `given-${crypto.randomUUID()}`);
  const script = join(dir, `editor-${crypto.randomUUID()}.sh`);
  await Deno.writeTextFile(next, content);
  await Deno.writeTextFile(
    script,
    [
      "#!/bin/sh",
      `printf '%s' "$1" > '${given}'`,
      "sleep 0.2",
      `cat '${next}' > "$1"`,
      "",
    ].join("\n"),
  );
  await Deno.chmod(script, 0o755);
  return {
    env: { EDITOR: script },
    givenPath: () => Deno.readTextFile(given),
  };
}

for (const kind of ["workflow", "model", "vault"] as const) {
  Deno.test({
    name:
      `editor edit: A's editor edit of a ${kind} reaches B through the v3 commit log`,
    ignore,
    fn: async () => {
      await withV3RowRepos({ managedConfig: true }, async (repos, ds) => {
        await create(repos.repoA, kind, "deploy");
        const base = await loaded(repos.repoB, kind, "deploy");
        assertEquals(editedBy(kind, base), undefined);

        const editor = await scriptedEditor(
          ds,
          stringifyYaml(
            withEdit(kind, await loaded(repos.repoA, kind, "deploy"), "A"),
          ),
        );
        const result = await cli(repos.repoA, [kind, "edit", "deploy"], {
          stdin: null,
          env: editor.env,
        });

        assertEquals(result.status, "updated");
        // The editor never opened the stored file.
        const given = await editor.givenPath();
        assert(
          !given.startsWith(repos.repoA),
          `the editor opened ${given}, inside the checkout`,
        );
        for (const repoDir of [repos.repoA, repos.repoB]) {
          assertEquals(
            editedBy(kind, await loaded(repoDir, kind, "deploy")),
            "A",
            `${repoDir} sees A's editor edit`,
          );
        }
      });
    },
  });

  Deno.test({
    name:
      `editor edit: B's editor edit of a ${kind} A changed opens on A's version and commits`,
    ignore,
    fn: async () => {
      await withV3RowRepos({ managedConfig: true }, async (repos, ds) => {
        await create(repos.repoA, kind, "deploy");
        // Both checkouts load deploy at the same version, then A edits it.
        const base = await loaded(repos.repoB, kind, "deploy");
        await cli(repos.repoA, [kind, "edit", "deploy"], {
          stdin: stringifyYaml(withEdit(kind, base, "A")),
        });

        // B's command catches its checkout up, so the editor opens on A's
        // version; the script saves B's edit over it.
        const editor = await scriptedEditor(
          ds,
          stringifyYaml(withEdit(kind, base, "B")),
        );
        const result = await cli(repos.repoB, [kind, "edit", "deploy"], {
          stdin: null,
          env: editor.env,
        });

        assertEquals(result.status, "updated");
        assertEquals(
          editedBy(kind, await loaded(repos.repoA, kind, "deploy")),
          "B",
        );
      });
    },
  });

  Deno.test(`editor edit: closing the editor on an unchanged ${kind} saves nothing`, async () => {
    await withV3RowRepos({ managedConfig: true }, async (repos) => {
      await create(repos.repoA, kind, "deploy");
      let copy: string | undefined;
      const restore = useEditorSessionDepsForTesting({
        prepareEditor: (path) =>
          Promise.resolve({
            editor: "Fake",
            waitsForExit: true,
            waitConfirmed: true,
            open: () => {
              copy = path;
              return Promise.resolve({ editor: "Fake", path, success: true });
            },
          }),
      });
      try {
        const result = await cli(repos.repoA, [kind, "edit", "deploy"], {
          stdin: null,
        });
        assertEquals(result.status, "unchanged");
      } finally {
        restore();
      }
      // The copy was removed, not left in TMPDIR.
      await assertRejects(
        () => Deno.stat(dirname(copy!)),
        Deno.errors.NotFound,
      );
    });
  });

  Deno.test({
    name:
      `editor edit: an editor that exits with an error saves nothing to the ${kind}`,
    ignore,
    fn: async () => {
      await withV3RowRepos({ managedConfig: true }, async (repos) => {
        await create(repos.repoA, kind, "deploy");
        const before = await loaded(repos.repoA, kind, "deploy");
        // vim's :cq: the edit is abandoned, whatever the file holds.
        const error = await cliRejecting(
          repos.repoA,
          [kind, "edit", "deploy"],
          {
            EDITOR: "false",
          },
        );
        assert(error instanceof Error, `not an error: ${error}`);
        assertStringIncludes(error.message, "exited with an error");
        assertEquals(await loaded(repos.repoA, kind, "deploy"), before);
      });
    },
  });

  Deno.test({
    name:
      `editor edit: invalid YAML from the editor keeps the copy and leaves the ${kind} as it was`,
    ignore,
    fn: async () => {
      await withV3RowRepos({ managedConfig: true }, async (repos, ds) => {
        await create(repos.repoA, kind, "deploy");
        const before = await loaded(repos.repoA, kind, "deploy");
        const editor = await scriptedEditor(ds, "name: [unclosed\n");

        const error = await cliRejecting(
          repos.repoA,
          [kind, "edit", "deploy"],
          editor.env,
        );

        const kept = await editor.givenPath();
        try {
          assert(error instanceof Error, `not an error: ${error}`);
          assertStringIncludes(error.message, `Your edit is kept at ${kept}`);
          assertEquals(await Deno.readTextFile(kept), "name: [unclosed\n");
          assertEquals(await loaded(repos.repoA, kind, "deploy"), before);
        } finally {
          await Deno.remove(dirname(kept), { recursive: true }).catch(() => {});
        }
      });
    },
  });
}

Deno.test({
  name:
    "editor edit: an editor that cannot wait is refused and nothing is written",
  ignore,
  fn: async () => {
    await withV3RowRepos({ managedConfig: true }, async (repos) => {
      await create(repos.repoA, "model", "deploy");
      const before = await loaded(repos.repoA, "model", "deploy");

      // A launcher that hands the file to another program: refused by
      // name, before it runs, wherever it is installed.
      const bin = await Deno.makeTempDir({ prefix: "swamp-launcher-" });
      const launcher = join(bin, "xdg-open");
      await Deno.writeTextFile(launcher, "#!/bin/sh\nexit 0\n");
      await Deno.chmod(launcher, 0o755);
      let error: unknown;
      try {
        error = await cliRejecting(
          repos.repoA,
          ["model", "edit", "deploy"],
          { EDITOR: launcher },
        );
      } finally {
        await Deno.remove(bin, { recursive: true });
      }

      assert(error instanceof Error, `not an error: ${error}`);
      assertStringIncludes(error.message, "pipe the YAML on stdin");
      assertEquals(await loaded(repos.repoA, "model", "deploy"), before);
    });
  },
});

Deno.test({
  name:
    "editor edit: on v2 managedConfig, A's editor edit of a model reaches B",
  ignore,
  fn: async () => {
    await withRowRepos({ managedConfig: true }, async (repos) => {
      await create(repos.repoA, "model", "deploy");
      await settle(repos);
      // v2 keeps managed config in its datastore cache, so B is read
      // through `get` rather than its files.
      const tags = async () =>
        (await cli(repos.repoB, ["model", "get", "deploy"])).tags as
          | Record<string, unknown>
          | undefined;
      assertEquals((await tags())?.editedBy, undefined);
      const dir = await Deno.makeTempDir({ prefix: "swamp-editor-v2-" });
      try {
        // The editor changes the copy it is given in place.
        const script = join(dir, "editor.sh");
        await Deno.writeTextFile(
          script,
          [
            "#!/bin/sh",
            `sed 's/^tags: {}$/tags: {editedBy: A}/' "$1" > '${dir}/out'`,
            `cat '${dir}/out' > "$1"`,
            "",
          ].join("\n"),
        );
        await Deno.chmod(script, 0o755);
        const editor = { env: { EDITOR: script } };
        const result = await cli(repos.repoA, ["model", "edit", "deploy"], {
          stdin: null,
          env: editor.env,
        });
        assertEquals(result.status, "updated");
        // Whatever A's edit marked for the push lands on the remote and in B.
        await settle(repos);
        assertEquals((await tags())?.editedBy, "A");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  },
});

for (const kind of ["workflow", "model", "vault"] as const) {
  Deno.test(`editor edit: a ${kind} change A commits while B's editor is open refuses B's save and keeps B's copy`, async () => {
    await withV3RowRepos({ managedConfig: true }, async (repos) => {
      await create(repos.repoA, kind, "deploy");
      const base = await loaded(repos.repoB, kind, "deploy");
      await loaded(repos.repoA, kind, "deploy");

      let kept: string | undefined;
      // The person at B's editor types B's edit; while the editor is still
      // open, A saves its own edit and commits it.
      const restore = useEditorSessionDepsForTesting({
        prepareEditor: (path) =>
          Promise.resolve({
            editor: "Fake",
            waitsForExit: true,
            open: async () => {
              kept = path;
              await Deno.writeTextFile(
                path,
                stringifyYaml(withEdit(kind, base, "B")),
              );
              await withStdin(
                stringifyYaml(withEdit(kind, base, "A")),
                () =>
                  runCli({
                    args: [kind, "edit", "deploy", ...json(repos.repoA)],
                  }),
              );
              return { editor: "Fake", path };
            },
          }),
      });
      let error: unknown;
      try {
        error = await cliRejecting(repos.repoB, [kind, "edit", "deploy"], {});
      } finally {
        restore();
      }

      try {
        assert(error instanceof Error, `not an error: ${error}`);
        assertEquals(
          configEditConflictOf(error)?.code,
          "config_edit_conflict",
          `not an edit conflict: ${error.message}`,
        );
        assertStringIncludes(error.message, `Your edit is kept at ${kept}`);
        assertEquals(
          await Deno.readTextFile(kept!),
          stringifyYaml(withEdit(kind, base, "B")),
        );
        // A's edit stands, in both checkouts.
        for (const repoDir of [repos.repoA, repos.repoB]) {
          assertEquals(
            editedBy(kind, await loaded(repoDir, kind, "deploy")),
            "A",
          );
        }
      } finally {
        if (kept !== undefined) {
          await Deno.remove(dirname(kept), { recursive: true }).catch(() => {});
        }
      }
    });
  });
}

Deno.test("editor edit: on v3, repairing a workflow file broken by hand is refused at commit, keeping the copy, and B keeps the stored version", async () => {
  await withV3RowRepos({ managedConfig: true }, async (repos) => {
    await create(repos.repoA, "workflow", "deploy");
    const good = await loaded(repos.repoA, "workflow", "deploy");
    await loaded(repos.repoB, "workflow", "deploy");
    // A's file is broken by hand. A hand edit is not a commit, so the file
    // is out of step with the store and the next save's precondition fails
    // (a documented limit); the repair must say so, not drop the edit.
    const path = join(
      swampPath(repos.repoA, "config", "workflows"),
      "workflow-deploy.yaml",
    );
    await Deno.writeTextFile(path, stringifyYaml({ ...good, ependssss: true }));

    let copy: string | undefined;
    const restore = useEditorSessionDepsForTesting({
      prepareEditor: (path) =>
        Promise.resolve({
          editor: "Fake",
          waitsForExit: true,
          waitConfirmed: true,
          open: async () => {
            copy = path;
            await Deno.writeTextFile(
              path,
              stringifyYaml(withEdit("workflow", good, "A")),
            );
            return { editor: "Fake", path, success: true };
          },
        }),
    });
    let error: unknown;
    try {
      error = await cliRejecting(
        repos.repoA,
        ["workflow", "edit", "deploy"],
        {},
      );
    } finally {
      restore();
    }
    try {
      assert(error instanceof Error, `not an error: ${error}`);
      assertStringIncludes(error.message, `Your edit is kept at ${copy}`);
      assertEquals(
        editedBy("workflow", await loaded(repos.repoB, "workflow", "deploy")),
        undefined,
      );
    } finally {
      if (copy !== undefined) {
        await Deno.remove(dirname(copy), { recursive: true }).catch(() => {});
      }
    }
  });
});
