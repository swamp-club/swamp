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

// Before swamp-club#4100 was fixed, `datastore setup extension` could copy
// .swamp/ into an extension cache that no push would ever send, then delete
// the source. `doctor datastores --repair` uploads those files with the
// datastore's repairUnpushedFiles, before namespace contamination repair
// wipes the cache, and refuses that wipe while the cache holds anything the
// remote lacks (swamp-club#4112). The in-memory remote stands in for S3.

import "../src/domain/models/models.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { Command } from "@cliffy/command";
import { dirname, join } from "@std/path";
import { createInMemoryRemote } from "@swamp-club/swamp-testing";
import type {
  InMemoryRemoteOptions,
  InMemorySyncService,
} from "@swamp-club/swamp-testing";
import { doctorDatastoresCommand } from "../src/cli/commands/doctor_datastores.ts";
import type {
  NamespaceContaminationSummary,
  RepairUnpushedFilesOptions,
  UnpushedFilesSummary,
} from "../src/domain/datastore/datastore_sync_service.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { UserError } from "../src/domain/errors.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { registerTestDatastoreType } from "../src/infrastructure/testing/test_datastore_type.ts";
import { VERSION } from "../src/cli/commands/version.ts";

await initializeLogging({});

const NS = "infra";
const TEAMMATE = `${NS}/data/teammate/t.json`;
const STRANDED = `${NS}/data/mine/a.json`;

interface HarnessOptions {
  /** Whether the extension has repairUnpushedFiles. Default true. */
  repairUnpushed?: boolean;
  /** Whether the extension reports namespace contamination. Default false. */
  contamination?: boolean;
  /** Runs when contamination repair first looks, before its wipe check. */
  onContaminationDetect?: (
    cachePath: string,
    remote: ReturnType<typeof createInMemoryRemote>,
    signal: AbortSignal | undefined,
  ) => Promise<void>;
  /** The repo's namespace; null for none. Default {@link NS}. */
  namespace?: string | null;
  remote?: InMemoryRemoteOptions;
  /** Leaves the cache with no last-synced index. */
  neverPulled?: boolean;
  /** Makes the lock's release reject. */
  releaseFails?: boolean;
  /** The datastore type's name, for behavior specific to one. */
  typeName?: string;
  /** Replaces what a real, not dry, repair returns. */
  repairResult?: UnpushedFilesSummary;
}

interface Harness {
  repoDir: string;
  cachePath: string;
  remote: ReturnType<typeof createInMemoryRemote>;
  /** The teammate's cache and sync service, which pushed {@link TEAMMATE}. */
  teammateCache: string;
  teammate: InMemorySyncService;
  /** Lock acquires and releases, and contamination calls, in order. */
  events: string[];
  /** Runs `doctor datastores --json` with `args`, and its stdout. */
  doctor: (...args: string[]) => Promise<{ out: string; error?: unknown }>;
}

async function writeFile(path: string, content: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, content);
}

function remoteText(
  remote: ReturnType<typeof createInMemoryRemote>,
  key: string,
): string | undefined {
  const bytes = remote.files().get(key);
  return bytes && new TextDecoder().decode(bytes);
}

/**
 * A repo on a test datastore type whose cache a pull left clean, beside a
 * remote that holds a teammate's file.
 */
async function withHarness(
  options: HarnessOptions,
  fn: (harness: Harness) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-repair-unpushed-" });
  const namespace = options.namespace === undefined ? NS : options.namespace;
  const teammateKey = namespace ? TEAMMATE : "data/teammate/t.json";
  const remote = createInMemoryRemote(options.remote);
  const events: string[] = [];
  const contamination = async (
    o?: { dryRun?: boolean; signal?: AbortSignal },
  ): Promise<NamespaceContaminationSummary> => {
    events.push(o?.dryRun ? "contamination-detect" : "contamination-delete");
    if (o?.dryRun) {
      await options.onContaminationDetect?.(cachePath, remote, o.signal);
    }
    return {
      foreignNamespaces: [{ namespace: "other", objectCount: 1 }],
      totalForeignObjects: 1,
      deleted: o?.dryRun ? 0 : 1,
    };
  };
  const { typeName, dispose } = registerTestDatastoreType(
    {
      connect: (cacheDir, connectOptions) => {
        const service = remote.connect(cacheDir, connectOptions);
        const repairResult = options.repairResult;
        return {
          ...service,
          ...(options.contamination
            ? { repairNamespaceContamination: contamination }
            : {}),
          ...(repairResult
            ? {
              repairUnpushedFiles: (o?: RepairUnpushedFilesOptions) =>
                o?.dryRun
                  ? service.repairUnpushedFiles!(o)
                  : Promise.resolve(repairResult),
            }
            : {}),
        };
      },
    },
    {
      ...(options.typeName ? { typeName: options.typeName } : {}),
      connect: { repairUnpushedFiles: options.repairUnpushed ?? true },
      createLock: () => ({
        acquire: () => {
          events.push("acquire");
          return Promise.resolve();
        },
        release: () => {
          events.push("release");
          return options.releaseFails
            ? Promise.reject(new Error("the lock store is unreachable"))
            : Promise.resolve();
        },
        withLock: <T>(f: () => Promise<T>) => f(),
        inspect: () => Promise.resolve(null),
        forceRelease: () => Promise.resolve(true),
      }),
    },
  );
  const repoDir = join(dir, "repo");
  const cachePath = join(repoDir, ".test-cache");
  try {
    await Deno.mkdir(repoDir, { recursive: true });
    const homeDir = join(dir, "home");
    await new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    }).init(RepoPath.create(repoDir), { tools: [] });
    const markerPath = join(repoDir, ".swamp.yaml");
    await Deno.writeTextFile(
      markerPath,
      (await Deno.readTextFile(markerPath)).trimEnd() + "\n" + [
        "datastore:",
        `  type: '${typeName}'`,
        "  config:",
        "    bucket: test-bucket",
        ...(namespace ? [`  namespace: ${namespace}`] : []),
      ].join("\n") + "\n",
    );

    const teammateCache = join(dir, "teammate-cache");
    await writeFile(join(teammateCache, teammateKey), '{"t":1}');
    const teammate = remote.connect(teammateCache, { instance: "teammate" });
    await teammate.markDirty({ relPath: teammateKey });
    await teammate.pushChanged(namespace ? { namespace } : undefined);
    // An earlier pull left the cache clean, as before swamp-club#4100.
    if (!options.neverPulled) {
      await remote.connect(cachePath, { instance: "earlier" }).pullChanged(
        namespace ? { namespace } : undefined,
      );
    }

    const doctor = async (...args: string[]) => {
      const originalLog = console.log;
      const lines: string[] = [];
      console.log = (...parts: unknown[]) => {
        lines.push(parts.map((p) => String(p)).join(" "));
      };
      let error: unknown;
      try {
        await new Command()
          .globalOption("--json", "JSON output")
          .command("datastores", doctorDatastoresCommand)
          .parse(["datastores", "--repo-dir", repoDir, "--json", ...args]);
      } catch (thrown) {
        error = thrown;
      } finally {
        console.log = originalLog;
      }
      return { out: lines.join("\n"), error };
    };
    await fn({
      repoDir,
      cachePath,
      remote,
      teammateCache,
      teammate,
      events,
      doctor,
    });
  } finally {
    dispose();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("doctor datastores --repair: previews a stranded cache file, uploads it with -y under the lock, and leaves a pending delete for the next push (swamp-club#4112)", async () => {
  await withHarness({}, async ({ cachePath, remote, events, doctor }) => {
    await writeFile(join(cachePath, STRANDED), '{"a":1}');
    const gone = `${NS}/data/gone/g.json`;
    const teammate = remote.connect(join(cachePath, "..", "peer"), {
      instance: "peer",
    });
    await writeFile(join(cachePath, "..", "peer", gone), "{}");
    await teammate.markDirty({ relPath: gone });
    await teammate.pushChanged({ namespace: NS });
    const mine = remote.connect(cachePath, { instance: "mine" });
    await mine.pullChanged({ namespace: NS });
    await Deno.remove(join(cachePath, gone));
    await mine.markDirty({ relPath: gone });

    const preview = await doctor("--repair");
    assertEquals(preview.error, undefined);
    const previewed = JSON.parse(preview.out).unpushed;
    assertEquals(previewed.status, "unpushed_preview");
    assertEquals(previewed.summary.samplePaths, [STRANDED]);
    assertEquals(remote.files().has(STRANDED), false);
    assertEquals(events, []);

    const run = await doctor("--repair", "-y");
    assertEquals(run.error, undefined);
    const repaired = JSON.parse(run.out).unpushed;
    assertEquals(repaired.status, "unpushed_completed");
    assertEquals(repaired.summary.uploaded, 1);
    assertEquals(remoteText(remote, STRANDED), '{"a":1}');
    assertEquals(remoteText(remote, TEAMMATE), '{"t":1}');
    assertEquals(remote.files().has(gone), true);
    assertEquals(events, ["acquire", "release"]);

    await mine.pushChanged({ namespace: NS });
    assertEquals(remote.files().has(gone), false);
    assertEquals(remoteText(remote, STRANDED), '{"a":1}');
  });
});

Deno.test("doctor datastores --repair -y: wipes for contamination repair only after the stranded file reached the remote, with the lock held throughout (swamp-club#4112)", async () => {
  await withHarness(
    { contamination: true },
    async ({ cachePath, remote, events, doctor }) => {
      await writeFile(join(cachePath, STRANDED), '{"a":1}');

      const run = await doctor("--repair", "-y");

      assertEquals(run.error, undefined);
      const report = JSON.parse(run.out);
      assertEquals(report.unpushed.status, "unpushed_completed");
      assertEquals(report.contamination.status, "completed");
      assertEquals(remoteText(remote, STRANDED), '{"a":1}');
      // The wipe and re-pull brought it back from the remote.
      assertEquals(
        await Deno.readTextFile(join(cachePath, STRANDED)),
        '{"a":1}',
      );
      assertEquals(events, [
        "acquire",
        "contamination-detect",
        "contamination-delete",
        "release",
      ]);
    },
  );
});

Deno.test("doctor datastores --repair -y: refuses the contamination wipe while the cache holds a local edit the remote lacks (swamp-club#4112)", async () => {
  await withHarness(
    { contamination: true },
    async ({ cachePath, remote, events, doctor }) => {
      await writeFile(join(cachePath, TEAMMATE), '{"t":"edited"}');

      const run = await doctor("--repair", "-y");

      assertEquals(run.error instanceof UserError, true);
      const message = (run.error as Error).message;
      assertStringIncludes(message, "Refusing to wipe the local cache");
      assertStringIncludes(message, TEAMMATE);
      assertStringIncludes(message, "Do not pull first");
      assertStringIncludes(message, "was not wiped");
      assertEquals(
        await Deno.readTextFile(join(cachePath, TEAMMATE)),
        '{"t":"edited"}',
      );
      assertEquals(remoteText(remote, TEAMMATE), '{"t":1}');
      assertEquals(events, ["acquire", "contamination-detect", "release"]);
    },
  );
});

Deno.test("doctor datastores --repair -y: refuses the contamination wipe while a push is pending (swamp-club#4112)", async () => {
  await withHarness(
    { contamination: true },
    async ({ cachePath, remote, events, doctor }) => {
      await remote.connect(cachePath).markDirty({ relPath: TEAMMATE });

      const run = await doctor("--repair", "-y");

      assertStringIncludes(
        (run.error as Error).message,
        "swamp datastore sync --push",
      );
      assertEquals(events.includes("contamination-delete"), false);
      assertEquals(events.at(-1), "release");
    },
  );
});

Deno.test("doctor datastores --repair -y: refuses the contamination wipe when a file reaches the cache after the unpushed files stage (swamp-club#4112)", async () => {
  await withHarness(
    {
      contamination: true,
      onContaminationDetect: (cachePath) =>
        writeFile(join(cachePath, `${NS}/data/late/l.json`), "{}"),
    },
    async ({ cachePath, events, doctor }) => {
      const run = await doctor("--repair", "-y");

      assertStringIncludes(
        (run.error as Error).message,
        `${NS}/data/late/l.json`,
      );
      assertEquals(
        await Deno.readTextFile(join(cachePath, `${NS}/data/late/l.json`)),
        "{}",
      );
      assertEquals(events.includes("contamination-delete"), false);
    },
  );
});

Deno.test("doctor datastores --repair: an extension without repairUnpushedFiles is reported, and contamination repair refuses to wipe (swamp-club#4112)", async () => {
  await withHarness(
    { repairUnpushed: false, contamination: true },
    async ({ cachePath, events, doctor }) => {
      await writeFile(join(cachePath, STRANDED), '{"a":1}');

      const preview = await doctor("--repair");
      assertEquals(preview.error, undefined);
      const report = JSON.parse(preview.out);
      assertEquals(report.unpushed.status, "unpushed_not_supported");
      assertStringIncludes(
        report.unpushed.message,
        "does not implement repairUnpushedFiles",
      );
      assertEquals(report.contamination.status, "preview");

      const run = await doctor("--repair", "-y");
      assertStringIncludes(
        (run.error as Error).message,
        "does not implement repairUnpushedFiles",
      );
      assertStringIncludes(
        (run.error as Error).message,
        "was not wiped",
      );
      assertEquals(
        await Deno.readTextFile(join(cachePath, STRANDED)),
        '{"a":1}',
      );
      assertEquals(events.includes("contamination-delete"), false);
      assertEquals(events.includes("acquire"), false);
    },
  );
});

Deno.test("doctor datastores --repair -y: uploads a stranded file in a repo with no namespace (swamp-club#4112)", async () => {
  await withHarness(
    { namespace: null },
    async ({ cachePath, remote, doctor }) => {
      await writeFile(join(cachePath, "data/mine/a.json"), '{"a":1}');

      const run = await doctor("--repair", "-y");

      assertEquals(run.error, undefined);
      assertEquals(JSON.parse(run.out).unpushed.status, "unpushed_completed");
      assertEquals(remoteText(remote, "data/mine/a.json"), '{"a":1}');
    },
  );
});

Deno.test("doctor datastores --repair -y: a v1 monolith remote is refused with the migration steps (swamp-club#4112)", async () => {
  await withHarness(
    { remote: { monolithIndex: true } },
    async ({ cachePath, remote, events, doctor }) => {
      await writeFile(join(cachePath, STRANDED), '{"a":1}');

      const run = await doctor("--repair", "-y");

      assertStringIncludes((run.error as Error).message, "migrate-index");
      assertEquals(remote.files().has(STRANDED), false);
      assertEquals(events, ["acquire", "release"]);
    },
  );
});

Deno.test("doctor datastores: points at --repair when the cache holds files the remote never received, without failing (swamp-club#4112)", async () => {
  await withHarness({}, async ({ cachePath, doctor }) => {
    await writeFile(join(cachePath, STRANDED), '{"a":1}');

    const check = await doctor();

    assertEquals(check.error, undefined);
    const report = JSON.parse(check.out);
    assertEquals(report.overallStatus, "pass");
    assertEquals(report.unpushedFilesFinding.unpushed, 1);
    assertEquals(report.unpushedFilesFinding.samplePaths, [STRANDED]);
    assertStringIncludes(
      report.unpushedFilesFinding.warning,
      "restores it for everyone",
    );
  });
});

/** A copy this cache kept of a file the teammate then deleted. */
async function keepPeerDeletedCopy(
  harness: Harness,
): Promise<void> {
  await Deno.writeTextFile(join(harness.cachePath, TEAMMATE), '{"mine":1}');
  await harness.teammate.markDirty({ relPath: TEAMMATE });
  await Deno.remove(join(harness.teammateCache, TEAMMATE));
  await harness.teammate.pushChanged({ namespace: NS });
  await harness.remote.connect(harness.cachePath, { instance: "earlier" })
    .pullChanged({ namespace: NS });
}

Deno.test("doctor datastores --repair: a copy a peer deleted is reported, never uploaded, and does not block the wipe (swamp-club#4138)", async () => {
  await withHarness({ contamination: true }, async (harness) => {
    await keepPeerDeletedCopy(harness);

    const preview = JSON.parse((await harness.doctor("--repair")).out);
    assertEquals(preview.unpushed.status, "unpushed_preview");
    assertEquals(preview.unpushed.summary.peerDeleted, 1);
    assertEquals(preview.unpushed.summary.unpushed, 0);

    const run = await harness.doctor("--repair", "-y");
    assertEquals(run.error, undefined);
    assertEquals(JSON.parse(run.out).contamination.status, "completed");
    assertEquals(remoteText(harness.remote, TEAMMATE), undefined);
  });
});

Deno.test("doctor datastores --repair -y: a wipe check that fails refuses the wipe, and says nothing changed (swamp-club#4138)", async () => {
  await withHarness(
    {
      contamination: true,
      onContaminationDetect: (_cachePath, remote) => {
        remote.failNext("repair");
        return Promise.resolve();
      },
    },
    async ({ cachePath, events, doctor }) => {
      await writeFile(join(cachePath, STRANDED), '{"a":1}');

      const run = await doctor("--repair", "-y");

      assertStringIncludes((run.error as Error).message, "could not check");
      assertStringIncludes(
        (run.error as Error).message,
        "was not wiped",
      );
      assertEquals(events.includes("contamination-delete"), false);
      assertEquals(events.at(-1), "release");
      assertEquals(
        await Deno.readTextFile(join(cachePath, STRANDED)),
        '{"a":1}',
      );
    },
  );
});

Deno.test("doctor datastores --repair -y: a file a repair could not index fails the stage and refuses the wipe, naming the cache (swamp-club#4138)", async () => {
  await withHarness(
    {
      contamination: true,
      repairResult: {
        unpushed: 1,
        samplePaths: [`${NS}/data/x`],
        alreadyPresent: 0,
        sampleAlreadyPresent: [],
        locallyModified: 0,
        sampleModified: [],
        unknown: 0,
        sampleUnknown: [],
        peerDeleted: 0,
        samplePeerDeleted: [],
        remoteMovedOn: 0,
        uploaded: 0,
        pendingChanges: false,
      },
    },
    async ({ cachePath, events, doctor }) => {
      await writeFile(join(cachePath, NS, "data", "x"), "kept");

      const run = await doctor("--repair", "-y");

      const message = (run.error as Error).message;
      assertStringIncludes(message, "did not complete");
      assertStringIncludes(message, cachePath);
      assertStringIncludes(message, "copy out and remove");
      assertEquals(events.includes("contamination-delete"), false);
      assertEquals(
        await Deno.readTextFile(join(cachePath, NS, "data", "x")),
        "kept",
      );
    },
  );
});

Deno.test("doctor datastores --repair -y: a failed lock release keeps a completed repair's outcome (swamp-club#4138)", async () => {
  await withHarness(
    { contamination: true, releaseFails: true },
    async ({ cachePath, remote, events, doctor }) => {
      await writeFile(join(cachePath, STRANDED), '{"a":1}');

      const run = await doctor("--repair", "-y");

      assertEquals(run.error, undefined);
      const report = JSON.parse(run.out);
      assertEquals(report.contamination.status, "completed");
      assertStringIncludes(
        report.warnings[0],
        "Could not release the datastore lock",
      );
      assertEquals(remoteText(remote, STRANDED), '{"a":1}');
      assertEquals(events.at(-1), "release");
    },
  );
});

Deno.test("doctor datastores --repair -y: a failed lock release keeps a stage's own error (swamp-club#4138)", async () => {
  await withHarness(
    { releaseFails: true, remote: { monolithIndex: true } },
    async ({ cachePath, events, doctor }) => {
      await writeFile(join(cachePath, STRANDED), '{"a":1}');

      const run = await doctor("--repair", "-y");

      assertStringIncludes((run.error as Error).message, "migrate-index");
      assertEquals(events.at(-1), "release");
    },
  );
});

Deno.test("doctor datastores --repair -y: contamination detection is bounded, since it runs under the lock (swamp-club#4138)", async () => {
  let signal: AbortSignal | undefined;
  await withHarness(
    {
      contamination: true,
      onContaminationDetect: (_cachePath, _remote, received) => {
        signal = received;
        return Promise.resolve();
      },
    },
    async ({ doctor }) => {
      assertEquals((await doctor("--repair", "-y")).error, undefined);
      assertEquals(signal instanceof AbortSignal, true);
    },
  );
});

Deno.test("doctor datastores --repair: a failed unpushed check is reported, exits 1, and the contamination preview still shows (swamp-club#4138)", async () => {
  await withHarness(
    { contamination: true, remote: { monolithIndex: true } },
    async ({ cachePath, events, doctor }) => {
      await writeFile(join(cachePath, STRANDED), '{"a":1}');

      const preview = await doctor("--repair");
      // Deno.exit set this before the test runner turned it into an error.
      Deno.exitCode = 0;

      assertStringIncludes((preview.error as Error).message, "exit code: 1");
      const report = JSON.parse(preview.out);
      assertEquals(report.unpushed.status, "unpushed_failed");
      assertStringIncludes(report.unpushed.message, "Nothing was uploaded");
      assertEquals(report.contamination.status, "preview");
      assertEquals(events.includes("contamination-delete"), false);
    },
  );
});

for (const typeName of ["@swamp/s3-datastore", "@swamp/gcs-datastore"]) {
  Deno.test(`doctor datastores: ${typeName} too old to check says what to update to, without failing (swamp-club#4138)`, async () => {
    await withHarness(
      { repairUnpushed: false, typeName },
      async ({ doctor }) => {
        const check = await doctor();
        assertEquals(check.error, undefined);
        const finding = JSON.parse(check.out).unpushedFilesFinding;
        assertEquals(finding.unpushed, 0);
        assertStringIncludes(finding.error, "2026.10.30.1 or later");
        assertStringIncludes(finding.error, "swamp extension update");

        const repair = JSON.parse((await doctor("--repair")).out);
        assertEquals(repair.unpushed.status, "unpushed_not_supported");
        assertStringIncludes(repair.unpushed.message, "2026.10.30.1 or later");
      },
    );
  });
}

Deno.test("doctor datastores --repair -y: removing the local versions a refusal names clears it, and the wipe goes ahead (swamp-club#4138)", async () => {
  await withHarness(
    { contamination: true },
    async ({ cachePath, events, doctor }) => {
      await writeFile(join(cachePath, TEAMMATE), '{"t":"edited"}');

      const refused = await doctor("--repair", "-y");
      assertStringIncludes(
        (refused.error as Error).message,
        "remove them there",
      );
      assertEquals(events.includes("contamination-delete"), false);

      await Deno.remove(join(cachePath, TEAMMATE));
      const run = await doctor("--repair", "-y");

      assertEquals(run.error, undefined);
      assertEquals(JSON.parse(run.out).contamination.status, "completed");
    },
  );
});

Deno.test("doctor datastores --repair: a cache that never pulled is told to pull first, and exits 1 (swamp-club#4138)", async () => {
  await withHarness(
    { neverPulled: true },
    async ({ doctor }) => {
      const preview = await doctor("--repair");
      // Deno.exit set this before the test runner turned it into an error.
      Deno.exitCode = 0;

      assertStringIncludes((preview.error as Error).message, "exit code: 1");
      const report = JSON.parse(preview.out);
      assertEquals(report.unpushed.status, "unpushed_failed");
      assertStringIncludes(report.unpushed.message, "Pull first");
      assertStringIncludes(report.unpushed.message, "Nothing was uploaded");
    },
  );
});

Deno.test("doctor datastores --repair --json: a skipped stage says so, unlike one that does not apply (swamp-club#4138)", async () => {
  // A namespace named after a layout directory cannot run the unmigrated
  // repair, which skips this stage.
  await withHarness({ namespace: "data" }, async ({ doctor }) => {
    const run = await doctor("--repair");
    // Deno.exit set this before the test runner turned it into an error.
    Deno.exitCode = 0;

    assertStringIncludes((run.error as Error).message, "exit code: 1");
    const report = JSON.parse(run.out);
    assertEquals(report.unpushed.status, "unpushed_skipped");
    assertStringIncludes(report.unpushed.message, "unmigrated data repair");
  });
});

Deno.test("doctor datastores --repair -y: following a refusal for a pending edit keeps the file on the remote, and the wipe goes ahead (swamp-club#4138)", async () => {
  await withHarness(
    { contamination: true },
    async ({ cachePath, remote, events, doctor }) => {
      await writeFile(join(cachePath, TEAMMATE), '{"t":"edited"}');
      const service = remote.connect(cachePath, { instance: "earlier" });
      await service.markDirty({ relPath: TEAMMATE });

      const refused = await doctor("--repair", "-y");
      const message = (refused.error as Error).message;
      assertEquals(
        message.indexOf("swamp datastore sync --push") <
          message.indexOf("remove them there"),
        true,
      );
      assertEquals(events.includes("contamination-delete"), false);

      // In the order the refusal gives: the push comes first.
      await service.pushChanged({ namespace: NS });
      assertEquals(remoteText(remote, TEAMMATE), '{"t":"edited"}');

      const run = await doctor("--repair", "-y");
      assertEquals(run.error, undefined);
      assertEquals(JSON.parse(run.out).contamination.status, "completed");
      assertEquals(remoteText(remote, TEAMMATE), '{"t":"edited"}');
    },
  );
});
