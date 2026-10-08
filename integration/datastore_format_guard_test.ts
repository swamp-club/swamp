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

// The datastore format guard (swamp-club#3189): a datastore marked with a
// format this binary cannot read is refused by every entry point before
// anything is written, on a remote (the in-memory remote's control plane)
// and on a shared filesystem directory. A datastore without a marker
// behaves exactly as before.

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertInstanceOf } from "@std/assert";
import { join, relative } from "@std/path";
import { walk } from "@std/fs";
import {
  acquireModelLocks,
  requireInitializedRepo,
  requireInitializedRepoReadOnly,
  requireInitializedRepoUnlocked,
  resolveDatastoreForRepo,
} from "../src/cli/repo_context.ts";
import { VERSION } from "../src/cli/commands/version.ts";
import {
  DATASTORE_FORMAT_MARKER_FILE,
  DATASTORE_FORMAT_MARKER_INVALID_CODE,
  DATASTORE_FORMAT_MARKER_KEY,
  DATASTORE_FORMAT_UNSUPPORTED_CODE,
} from "../src/domain/datastore/datastore_format.ts";
import { errorPaths, UserError } from "../src/domain/errors.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { registerTestDatastoreType } from "../src/infrastructure/testing/test_datastore_type.ts";
import { resolveConfigTierPath } from "../src/cli/resolve_datastore.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createDatastoreSetupDeps,
  datastoreSetupExtension,
} from "../src/libswamp/datastores/setup.ts";
import { consumeStream } from "../src/libswamp/stream.ts";
import { collect } from "../src/libswamp/testing.ts";
import { createDatastoreSetupRenderer } from "../src/presentation/renderers/datastore_setup.ts";
import {
  baseline,
  cacheDir,
  type CliInvocation,
  observe,
  type RowRepos,
  runCli,
  runCliRejecting,
  withRowRepos,
} from "./usecase_sync_fixtures.ts";

await initializeLogging({});

const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
const FORMAT_3 = { format: 3, minReaderFormat: 3, writtenBy: "2027.01.01.1" };

type Snapshot = Map<string, string>;

/** Every file under `dir`, by relative path, with its bytes as hex. */
async function snapshotDir(dir: string): Promise<Snapshot> {
  const files: Snapshot = new Map();
  try {
    for await (const entry of walk(dir, { includeDirs: true })) {
      const rel = relative(dir, entry.path);
      if (entry.isFile) {
        const bytes = await Deno.readFile(entry.path);
        files.set(rel, Array.from(bytes, (b) => b.toString(16)).join(""));
      } else {
        files.set(rel, "<dir>");
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return files;
}

function assertRefused(error: unknown, code: string, label: string): void {
  assertInstanceOf(error, UserError, `${label}: ${error}`);
  assertEquals(error.code, code, `${label}: ${error.message}`);
  assert(
    error.message.includes("Nothing was changed."),
    `${label}: ${error.message}`,
  );
}

/** Appends a line inside the repo's `datastore:` block, which is last. */
async function appendToDatastoreBlock(
  repoDir: string,
  line: string,
): Promise<void> {
  const path = join(repoDir, ".swamp.yaml");
  const marker = await Deno.readTextFile(path);
  await Deno.writeTextFile(path, marker.trimEnd() + "\n" + line + "\n");
}

// ---------------------------------------------------------------------------
// Remote datastores
// ---------------------------------------------------------------------------

const json = (repos: RowRepos) => ["--repo-dir", repos.repoA, "--json"];

/** CLI entry points that open the repo's datastore, each refused. */
const REMOTE_COMMANDS: Array<(repos: RowRepos) => CliInvocation> = [
  (r) => ({ args: ["datastore", "sync", ...json(r)] }),
  (r) => ({ args: ["datastore", "sync", "--pull", ...json(r)] }),
  (r) => ({ args: ["datastore", "sync", "--push", ...json(r)] }),
  (r) => ({ args: ["datastore", "compact", ...json(r)] }),
  (r) => ({ args: ["datastore", "migrate-index", ...json(r)] }),
  (r) => ({ args: ["datastore", "config", "migrate", ...json(r)] }),
  (r) => ({ args: ["datastore", "status", ...json(r)] }),
  (r) => ({ args: ["datastore", "lock", "status", ...json(r)] }),
  (r) => ({ args: ["datastore", "lock", "release", "--force", ...json(r)] }),
  (r) => ({ args: ["datastore", "namespace", "set", "team", ...json(r)] }),
  (r) => ({
    args: ["datastore", "catalog", "pull", "--namespaces", "x", ...json(r)],
  }),
  (r) => ({ args: ["data", "gc", "--force", ...json(r)] }),
  (r) => ({ args: ["model", "method", "run", "m1", "noop", ...json(r)] }),
  (r) => ({ args: ["model", "validate", "m1", ...json(r)] }),
  (r) => ({ args: ["workflow", "run", "wf1", ...json(r)] }),
  (r) => ({ args: ["workflow", "create", "wf2", ...json(r)] }),
  (r) => ({
    args: ["vault", "create", "local_encryption", "v1", ...json(r)],
  }),
  (r) => ({ args: ["run", "gc", "--force", ...json(r)] }),
  (r) => ({ args: ["worker", "token", "revoke", "wt1", ...json(r)] }),
];

interface RemoteFingerprint {
  files: Map<string, Uint8Array>;
  control: Map<string, Uint8Array>;
  ops: number;
  cache: Snapshot;
  marker: string;
}

async function fingerprint(repos: RowRepos): Promise<RemoteFingerprint> {
  return {
    files: new Map(repos.remote.files()),
    control: new Map(repos.remote.controlPlaneRecords()),
    ops: repos.remote.ops().length,
    cache: await snapshotDir(cacheDir(repos.repoA)),
    marker: await Deno.readTextFile(join(repos.repoA, ".swamp.yaml")),
  };
}

function assertUnchanged(
  before: RemoteFingerprint,
  after: RemoteFingerprint,
  label: string,
): void {
  assertEquals(after.ops, before.ops, `${label}: remote ops recorded`);
  assertEquals(after.files, before.files, `${label}: remote files changed`);
  assertEquals(
    after.control,
    before.control,
    `${label}: control-plane records changed`,
  );
  assertEquals(after.cache, before.cache, `${label}: local cache changed`);
  assertEquals(after.marker, before.marker, `${label}: .swamp.yaml changed`);
}

for (
  const [name, marker, code] of [
    ["format 3", FORMAT_3, DATASTORE_FORMAT_UNSUPPORTED_CODE],
    [
      "minReaderFormat 3",
      { format: 2, minReaderFormat: 3 },
      DATASTORE_FORMAT_UNSUPPORTED_CODE,
    ],
    ["a garbled marker", "{not json", DATASTORE_FORMAT_MARKER_INVALID_CODE],
  ] as const
) {
  Deno.test(`datastore format guard: a remote datastore with ${name} is refused by every entry point, writing nothing`, async () => {
    await withRowRepos({ remote: { controlPlane: true } }, async (repos) => {
      repos.remote.seedControlPlane(
        DATASTORE_FORMAT_MARKER_KEY,
        typeof marker === "string"
          ? new TextEncoder().encode(marker)
          : encode(marker),
      );
      const before = await fingerprint(repos);

      for (const command of REMOTE_COMMANDS) {
        const invocation = command(repos);
        const label = `swamp ${invocation.args.slice(0, 4).join(" ")}`;
        assertRefused(await runCliRejecting(invocation), code, label);
        assertUnchanged(before, await fingerprint(repos), label);
      }

      for (
        const [label, open] of [
          ["requireInitializedRepo", () =>
            requireInitializedRepo({
              repoDir: repos.repoA,
              outputMode: "json",
            })],
          [
            "requireInitializedRepoUnlocked",
            () =>
              requireInitializedRepoUnlocked({
                repoDir: repos.repoA,
                outputMode: "json",
              }),
          ],
          [
            "requireInitializedRepoReadOnly",
            () =>
              requireInitializedRepoReadOnly({
                repoDir: repos.repoA,
                outputMode: "json",
              }),
          ],
          // A config that never went through resolveDatastoreForRepo.
          ["acquireModelLocks", () =>
            acquireModelLocks(
              { ...repos.a.datastoreConfig },
              [{ modelType: repos.modelType.normalized, modelId: "m1" }],
              repos.repoA,
            )],
        ] as const
      ) {
        let error: unknown;
        try {
          await open();
        } catch (e) {
          error = e;
        }
        assertRefused(error, code, label);
        assertUnchanged(before, await fingerprint(repos), label);
      }
    });
  });
}

Deno.test("datastore format guard: setup onto a remote datastore with a newer format is refused, writing nothing", async () => {
  await withRowRepos({ remote: { controlPlane: true } }, async (repos) => {
    const target = registerTestDatastoreType({
      connect: (cache) => repos.remote.connect(cache, { instance: "S" }),
    });
    try {
      repos.remote.seedControlPlane(
        DATASTORE_FORMAT_MARKER_KEY,
        encode(FORMAT_3),
      );
      const before = await fingerprint(repos);
      // In-process through libswamp: the CLI's account gate for external
      // datastores runs before setup and is not what is under test.
      const events = await collect(
        datastoreSetupExtension(
          createLibSwampContext(),
          createDatastoreSetupDeps(repos.repoA, resolveConfigTierPath),
          {
            type: target.typeName,
            config: { bucket: "b" },
            repoDir: repos.repoA,
            skipMigration: false,
          },
        ),
      );
      let error: unknown;
      try {
        await consumeStream(
          (async function* () {
            yield* events;
          })(),
          createDatastoreSetupRenderer("json").handlers(),
        );
      } catch (e) {
        error = e;
      }
      assertRefused(error, DATASTORE_FORMAT_UNSUPPORTED_CODE, "setup");
      assertUnchanged(before, await fingerprint(repos), "setup");
    } finally {
      target.dispose();
    }
  });
});

Deno.test("datastore format guard: a namespaced repo sees the datastore-wide marker", async () => {
  await withRowRepos({ remote: { controlPlane: true } }, async (repos) => {
    await appendToDatastoreBlock(repos.repoA, "  namespace: team");
    repos.remote.seedControlPlane(
      DATASTORE_FORMAT_MARKER_KEY,
      encode(FORMAT_3),
    );
    const before = await fingerprint(repos);
    for (
      const args of [
        ["datastore", "sync", "--pull"],
        ["model", "method", "run", "m1", "noop"],
      ]
    ) {
      assertRefused(
        await runCliRejecting({ args: [...args, ...json(repos)] }),
        DATASTORE_FORMAT_UNSUPPORTED_CODE,
        args.join(" "),
      );
    }
    assertUnchanged(before, await fingerprint(repos), "namespaced");
  });
});

Deno.test("datastore format guard: a marker only under one namespace is not datastore-wide and is not read", async () => {
  await withRowRepos({ remote: { controlPlane: true } }, async (repos) => {
    await appendToDatastoreBlock(repos.repoA, "  namespace: team");
    repos.remote.seedControlPlane(
      DATASTORE_FORMAT_MARKER_KEY,
      encode(FORMAT_3),
      { namespace: "team" },
    );
    await runCli({ args: ["datastore", "sync", "--pull", ...json(repos)] });
  });
});

Deno.test("datastore format guard: a control-plane read failure proceeds", async () => {
  await withRowRepos({ remote: { controlPlane: true } }, async (repos) => {
    repos.remote.seedControlPlane(
      DATASTORE_FORMAT_MARKER_KEY,
      encode(FORMAT_3),
    );
    repos.remote.failNext("controlPlane", new Error("connection reset"));
    // The marker read failed, so the command ran as it would without one.
    await runCli({ args: ["datastore", "sync", "--pull", ...json(repos)] });
  });
});

Deno.test("datastore format guard: one resolved config is checked once; a newly resolved config is checked again", async () => {
  await withRowRepos({ remote: { controlPlane: true } }, async (repos) => {
    const { datastoreConfig } = await resolveDatastoreForRepo(repos.repoA);
    repos.remote.seedControlPlane(
      DATASTORE_FORMAT_MARKER_KEY,
      encode(FORMAT_3),
    );
    // The config passed the check before the marker existed; the same
    // object is not read again within this process.
    const locks = await acquireModelLocks(
      datastoreConfig,
      [{ modelType: repos.modelType.normalized, modelId: "m1" }],
      repos.repoA,
    );
    await locks.flush();
    let error: unknown;
    try {
      await resolveDatastoreForRepo(repos.repoA);
    } catch (e) {
      error = e;
    }
    assertRefused(error, DATASTORE_FORMAT_UNSUPPORTED_CODE, "re-resolve");
  });
});

/**
 * Remote rows run with no marker, a format 2 marker, and no control plane at
 * all observe the same sync operations and remote content: the check
 * changes nothing for a format 2 datastore.
 */
const UNCHANGED_ROWS: string[][] = [
  ["datastore", "sync"],
  ["data", "gc", "--force"],
  ["run", "gc", "--force"],
  ["workflow", "create", "wf2"],
  ["vault", "create", "local_encryption", "v1"],
];

for (const args of UNCHANGED_ROWS) {
  Deno.test(`datastore format guard: swamp ${args.join(" ")} behaves the same with no marker or a format 2 marker`, async () => {
    const observed: unknown[] = [];
    for (
      const variant of ["no control plane", "no marker", "format 2"] as const
    ) {
      await withRowRepos(
        { remote: { controlPlane: variant !== "no control plane" } },
        async (repos) => {
          if (variant === "format 2") {
            repos.remote.seedControlPlane(
              DATASTORE_FORMAT_MARKER_KEY,
              encode({ format: 2, writtenBy: VERSION }),
            );
          }
          const base = baseline(repos);
          const stdout = await runCli({ args: [...args, ...json(repos)] });
          const observation = observe(repos, base);
          observed.push({
            ops: observation.ops.filter((op) => !op.startsWith("controlPlane")),
            remote: observation.remote,
            stdout: stdout.length,
          });
        },
      );
    }
    assertEquals(observed[1], observed[0], "no marker differs");
    assertEquals(observed[2], observed[0], "format 2 differs");
  });
}

// ---------------------------------------------------------------------------
// Filesystem datastores
// ---------------------------------------------------------------------------

async function withFilesystemRepo(
  options: { namespace?: string },
  fn: (ctx: { repoDir: string; datastore: string; dir: string }) => Promise<
    void
  >,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-format-guard-" });
  try {
    const repoDir = join(dir, "repo");
    const datastore = join(dir, "shared");
    await Deno.mkdir(repoDir, { recursive: true });
    await Deno.mkdir(datastore, { recursive: true });
    const homeDir = join(repoDir, "test-home");
    await new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    }).init(RepoPath.create(repoDir), { tools: [] });
    const marker = join(repoDir, ".swamp.yaml");
    await Deno.writeTextFile(
      marker,
      (await Deno.readTextFile(marker)).trimEnd() + "\n" + [
        "datastore:",
        "  type: filesystem",
        `  path: '${datastore}'`,
        ...(options.namespace ? [`  namespace: ${options.namespace}`] : []),
      ].join("\n") + "\n",
    );
    await fn({ repoDir, datastore, dir });
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const FILESYSTEM_COMMANDS: string[][] = [
  ["datastore", "compact"],
  ["datastore", "status"],
  ["datastore", "lock", "status"],
  ["datastore", "lock", "release", "--force"],
  ["datastore", "namespace", "set", "team"],
  ["data", "gc", "--force"],
  ["model", "method", "run", "m1", "noop"],
  ["workflow", "create", "wf2"],
  ["run", "gc", "--force"],
];

for (const namespace of [undefined, "infra"]) {
  Deno.test(
    `datastore format guard: a filesystem datastore with a newer format is refused by every entry point, writing nothing${
      namespace ? " (namespaced repo)" : ""
    }`,
    async () => {
      await withFilesystemRepo(
        { namespace },
        async ({ repoDir, datastore }) => {
          const markerPath = join(datastore, DATASTORE_FORMAT_MARKER_FILE);
          await Deno.writeFile(markerPath, encode(FORMAT_3));
          const fingerprintFs = async () => ({
            datastore: await snapshotDir(datastore),
            marker: await Deno.readTextFile(join(repoDir, ".swamp.yaml")),
          });
          const before = await fingerprintFs();

          for (const args of FILESYSTEM_COMMANDS) {
            const label = `swamp ${args.join(" ")}`;
            assertRefused(
              await runCliRejecting({
                args: [...args, "--repo-dir", repoDir, "--json"],
              }),
              DATASTORE_FORMAT_UNSUPPORTED_CODE,
              label,
            );
            assertEquals(await fingerprintFs(), before, label);
          }

          let error: unknown;
          try {
            await requireInitializedRepo({ repoDir, outputMode: "json" });
          } catch (e) {
            error = e;
          }
          assertRefused(error, DATASTORE_FORMAT_UNSUPPORTED_CODE, "helper");
          assertEquals(await fingerprintFs(), before, "helper");
        },
      );
    },
  );
}

Deno.test("datastore format guard: a garbled filesystem marker is refused and names the file for telemetry redaction", async () => {
  await withFilesystemRepo({}, async ({ repoDir, datastore }) => {
    const markerPath = join(datastore, DATASTORE_FORMAT_MARKER_FILE);
    await Deno.writeTextFile(markerPath, "{not json");
    const error = await runCliRejecting({
      args: ["data", "gc", "--force", "--repo-dir", repoDir, "--json"],
    });
    assertRefused(error, DATASTORE_FORMAT_MARKER_INVALID_CODE, "garbled");
    assertEquals(errorPaths(error), [markerPath]);
  });
});

Deno.test("datastore format guard: setup filesystem onto a directory with a newer format is refused, writing nothing", async () => {
  await withFilesystemRepo({}, async ({ repoDir, dir }) => {
    const target = join(dir, "target");
    await Deno.mkdir(target);
    await Deno.writeFile(
      join(target, DATASTORE_FORMAT_MARKER_FILE),
      encode(FORMAT_3),
    );
    const before = await snapshotDir(target);
    const yaml = await Deno.readTextFile(join(repoDir, ".swamp.yaml"));
    const error = await runCliRejecting({
      args: [
        "datastore",
        "setup",
        "filesystem",
        "--path",
        target,
        "--repo-dir",
        repoDir,
        "--json",
      ],
    });
    assertRefused(error, DATASTORE_FORMAT_UNSUPPORTED_CODE, "setup");
    assertEquals(await snapshotDir(target), before);
    assertEquals(await Deno.readTextFile(join(repoDir, ".swamp.yaml")), yaml);
  });
});

Deno.test("datastore format guard: a filesystem datastore with no marker or a format 2 marker is used as before", async () => {
  await withFilesystemRepo({}, async ({ repoDir, datastore }) => {
    await runCli({
      args: ["data", "gc", "--force", "--repo-dir", repoDir, "--json"],
    });
    await Deno.writeFile(
      join(datastore, DATASTORE_FORMAT_MARKER_FILE),
      encode({ format: 2 }),
    );
    await runCli({
      args: ["data", "gc", "--force", "--repo-dir", repoDir, "--json"],
    });
  });
});
