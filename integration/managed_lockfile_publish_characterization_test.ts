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

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { configure, type LogRecord } from "@logtape/logtape";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import { buildManagedLockfileTransaction } from "../src/cli/managed_config_sync.ts";
import { resolveManagedLockfileForWrite } from "../src/cli/repo_context.ts";
import type { DatastoreSyncService } from "../src/domain/datastore/datastore_sync_service.ts";
import { UserError } from "../src/domain/errors.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { createTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import {
  markLockfilePublishPending,
  readLockfilePublishPending,
} from "../src/infrastructure/persistence/pending_lockfile_publish.ts";
import { RepoMarkerRepository } from "../src/infrastructure/persistence/repo_marker_repository.ts";
import type { ManagedLockfileLock } from "../src/libswamp/extensions/managed_lockfile_transaction.ts";
import {
  baseline,
  observe,
  type RowRepos,
  runCli,
  runServe,
  serveCtx,
  settle,
  syncOrder,
  UNSET_ENV,
  withRowRepos,
} from "./usecase_sync_fixtures.ts";
import { linkSharedSwampDenoCache } from "./test_helpers.ts";
import { errorFrame, sendRequest } from "./serve_request_harness.ts";

await initializeLogging({});

const EXTENSION = "@test/lockpub";
const V1 = "2026.01.01.1";
const V2 = "2026.02.01.1";
const REGISTRY = "https://registry.test";
const ARCHIVE_HOST = "https://archives.test";
const LOCKFILE_KEY = "config/upstream_extensions.json";

interface Recorded {
  ops: string[];
  order: string[];
  warnings: string[];
  error?: { name: string; code?: string; message: string };
  pending: string;
  remote: string[];
}

async function buildArchive(version: string): Promise<Uint8Array> {
  const dir = await Deno.makeTempDir({ prefix: "swamp_3192_arc_" });
  try {
    const extDir = join(dir, "extension");
    await ensureDir(join(extDir, "models"));
    await Deno.writeTextFile(
      join(extDir, "manifest.yaml"),
      `manifestVersion: 1\nname: "${EXTENSION}"\nversion: "${version}"\n` +
        `models:\n  - m.ts\n`,
    );
    await Deno.writeTextFile(
      join(extDir, "models", "m.ts"),
      `export const model = { type: "${EXTENSION}/m", version: "${version}", methods: {} };\n`,
    );
    await createTarGz(extDir, join(dir, "a.tar.gz"));
    return await Deno.readFile(join(dir, "a.tar.gz"));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function registry(
  archives: Map<string, Uint8Array>,
  latest: { version: string },
): (request: Request) => Response {
  const name = encodeURIComponent(EXTENSION);
  return (request) => {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    if (url.origin === ARCHIVE_HOST) {
      const archive = archives.get(path.slice(1));
      if (archive) return new Response(new Uint8Array(archive));
    }
    if (url.origin === REGISTRY) {
      if (
        path === `/api/v1/extensions/${EXTENSION}` ||
        url.pathname === `/api/v1/extensions/${name}`
      ) {
        return Response.json({
          id: "ext-1",
          name: EXTENSION,
          namespace: "@test",
          description: "lockfile publish fixture",
          repository: null,
          homepageUrl: null,
          license: null,
          platforms: [],
          labels: [],
          contentTypes: ["models"],
          contentNames: [],
          latestVersion: latest.version,
          author: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          yankedAt: null,
          yankReason: null,
          deprecatedAt: null,
          deprecatedByUserId: null,
          deprecationReason: null,
          supersededBy: null,
          repositoryVerified: null,
          repositoryVerifiedAt: null,
          repositoryVerifiedUrl: null,
          pullCount: 0,
        });
      }
      const download = path.match(/^\/api\/v1\/extensions\/.+@(.+)\/download$/);
      if (download) {
        return new Response(null, {
          status: 302,
          headers: { location: `${ARCHIVE_HOST}/${download[1]}` },
        });
      }
      if (path.endsWith("/checksum")) {
        return new Response(null, { status: 404 });
      }
      if (path.endsWith("/latest")) {
        return Response.json({ version: latest.version });
      }
    }
    throw new Error(
      `unexpected network request: ${request.method} ${request.url}`,
    );
  };
}

async function withRegistry(
  latest: { version: string },
  fn: () => Promise<void>,
): Promise<void> {
  const archives = new Map([
    [V1, await buildArchive(V1)],
    [V2, await buildArchive(V2)],
  ]);
  const home = await Deno.makeTempDir({ prefix: "swamp_3192_home_" });
  try {
    await linkSharedSwampDenoCache(home);
    await withMockedEnv(
      {
        ...UNSET_ENV,
        SWAMP_CLUB_URL: REGISTRY,
        HOME: home,
        SWAMP_HOME: home,
        SWAMP_CONFIG_DIR: join(home, ".config", "swamp"),
      },
      () => withMockedFetch(registry(archives, latest), fn),
    );
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
}

async function captureLockfileWarnings(
  fn: () => Promise<void>,
): Promise<string[]> {
  const captured: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => captured.push(record) },
    loggers: [
      { category: [], lowestLevel: "warning", sinks: ["capture"] },
      { category: ["logtape", "meta"], lowestLevel: "fatal", sinks: [] },
    ],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await initializeLogging({ _reset: true });
  }
  return captured
    .filter((record) =>
      record.category.includes("managed-config") ||
      record.category.includes("lockfile")
    )
    .map((record) => {
      const message = record.message.map((part) => String(part)).join("");
      return `${record.category.join(".")} ${record.level}: ${message}`;
    });
}

function remoteEntries(repos: RowRepos): string[] {
  const bytes = repos.remote.files().get(LOCKFILE_KEY);
  if (!bytes) return [];
  const entries = JSON.parse(new TextDecoder().decode(bytes)) as Record<
    string,
    { version: string }
  >;
  return Object.entries(entries).map(([name, entry]) =>
    `${name}@${entry.version}`
  ).sort();
}

function describeError(
  error: unknown,
): { name: string; code?: string; message: string } {
  if (error instanceof UserError) {
    return {
      name: error.name,
      ...(error.code ? { code: error.code } : {}),
      message: error.message,
    };
  }
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "unknown", message: String(error) };
}

async function record(
  options: {
    seed?: (repos: RowRepos) => Promise<void>;
    noSettle?: boolean;
  },
  fn: (repos: RowRepos) => Promise<void>,
): Promise<Recorded> {
  let recorded: Recorded | undefined;
  await withRowRepos({ managedConfig: true }, async (repos) => {
    await options.seed?.(repos);
    if (!options.noSettle) await settle(repos);
    const base = baseline(repos);
    let error: Recorded["error"];
    const warnings = await captureLockfileWarnings(async () => {
      try {
        await fn(repos);
      } catch (caught) {
        error = describeError(caught);
      }
    });
    recorded = {
      ops: observe(repos, base).ops,
      order: syncOrder(repos, base),
      warnings,
      ...(error ? { error } : {}),
      pending: (await readLockfilePublishPending(repos.repoA)).kind,
      remote: remoteEntries(repos),
    };
  });
  return recorded!;
}

function cli(repos: RowRepos, ...args: string[]): string[] {
  return [...args, "--repo-dir", repos.repoA, "--json"];
}

async function pullV1(repos: RowRepos): Promise<void> {
  await runCli({ args: cli(repos, "extension", "pull", `${EXTENSION}@${V1}`) });
}

async function lockfilePath(repos: RowRepos): Promise<string> {
  const marker = await new RepoMarkerRepository().read(
    RepoPath.create(repos.repoA),
  );
  return (await resolveManagedLockfileForWrite(repos.repoA, marker))
    .lockfilePath;
}

function recordingLock(
  repos: RowRepos,
  release: () => Promise<void> = () => Promise.resolve(),
): ManagedLockfileLock {
  return {
    acquire: () => Promise.resolve(),
    release: async () => {
      repos.releases.push(repos.remote.ops().length);
      await release();
    },
  };
}

async function cliTransaction(
  repos: RowRepos,
  options: {
    syncService?: DatastoreSyncService;
    lock?: ManagedLockfileLock;
  } = {},
) {
  return buildManagedLockfileTransaction({
    syncService: options.syncService ?? repos.a.syncService!,
    datastoreConfig: repos.a.datastoreConfig,
    repoDir: repos.repoA,
    lockfilePath: await lockfilePath(repos),
    lock: options.lock ?? recordingLock(repos),
  });
}

async function writeEntry(path: string, name: string): Promise<void> {
  await ensureDir(dirname(path));
  await (await LockfileRepository.create(path)).writeEntry(name, V1, []);
}

const EXPECTED: Record<string, Recorded> = {
  "cli pull": {
    ops: [
      "pull[0]",
      "markDirty config/upstream_extensions.json",
      "push[1]",
    ],
    order: [
      "pull",
      "push",
      "release",
    ],
    warnings: [],
    pending: "none",
    remote: [
      "@test/lockpub@2026.01.01.1",
    ],
  },
  "serve pull": {
    ops: [
      "pull[0]",
      "markDirty config/upstream_extensions.json",
      "push[1]",
    ],
    order: [
      "pull",
      "push",
      "release",
    ],
    warnings: [],
    pending: "none",
    remote: [
      "@test/lockpub@2026.01.01.1",
    ],
  },
  "cli update": {
    ops: [
      "pull[0]",
      "pull[0]",
      "markDirty config/upstream_extensions.json",
      "push[1]",
    ],
    order: [
      "pull",
      "release",
      "pull",
      "push",
      "release",
    ],
    warnings: [],
    pending: "none",
    remote: [
      "@test/lockpub@2026.02.01.1",
    ],
  },
  "serve update": {
    ops: [
      "pull[0]",
      "pull[0]",
      "markDirty config/upstream_extensions.json",
      "push[1]",
    ],
    order: [
      "pull",
      "release",
      "pull",
      "push",
      "release",
    ],
    warnings: [],
    pending: "none",
    remote: [
      "@test/lockpub@2026.02.01.1",
    ],
  },
  "zero-count push": {
    ops: [
      "pull[0]",
      "markDirty config/upstream_extensions.json",
    ],
    order: [
      "pull",
      "release",
    ],
    warnings: [],
    error: {
      name: "ManagedLockfileUnpublishedError",
      code: "managed_config_unpublished",
      message:
        "The change is saved locally but was not published to the datastore: the datastore reported that the push uploaded nothing; if this repeats, update the datastore extension. Run 'swamp extension install' to publish it: it fetches the datastore's lockfile and replays the change onto it.",
    },
    pending: "delta",
    remote: [],
  },
  "unknown pending": {
    ops: [
      "pull[0]",
      "markDirty config/upstream_extensions.json",
      "push[1]",
    ],
    order: [
      "pull",
      "push",
      "release",
    ],
    warnings: [
      "cli.managed-config warning: An earlier extension lockfile change was not published and its content was not recorded; merging every local entry into the datastore's lockfile, which may undo other checkouts' removals or upgrades of those extensions.",
    ],
    pending: "none",
    remote: [
      "@test/local@2026.01.01.1",
      "@test/unrecorded@2026.01.01.1",
    ],
  },
  "throwing change": {
    ops: [
      "pull[0]",
      "markDirty config/upstream_extensions.json",
      "push[1]",
    ],
    order: [
      "pull",
      "push",
      "release",
    ],
    warnings: [],
    error: {
      name: "Error",
      message: "the install failed after its entry landed",
    },
    pending: "none",
    remote: [
      "@test/partial@2026.01.01.1",
    ],
  },
  "serve defer": {
    ops: [
      "pull[0]",
      "markDirty config/upstream_extensions.json",
    ],
    order: [
      "pull",
      "release",
    ],
    warnings: [
      "serve.extension.lockfile warning: The extension lockfile change was not published to the datastore; the next extension change retries it: injected push failure",
    ],
    pending: "delta",
    remote: [
      "@test/lockpub@2026.01.01.1",
    ],
  },
  "failed publish, failed release": {
    ops: [
      "pull[0]",
      "markDirty config/upstream_extensions.json",
    ],
    order: [
      "pull",
      "release",
    ],
    warnings: [
      "cli.managed-config warning: Failed to release the datastore lock: the lock could not be released",
    ],
    error: {
      name: "ManagedLockfileUnpublishedError",
      code: "managed_config_unpublished",
      message:
        "The change is saved locally but was not published to the datastore: injected push failure. Run 'swamp extension install' to publish it: it fetches the datastore's lockfile and replays the change onto it.",
    },
    pending: "delta",
    remote: [],
  },
};

Deno.test("managed lockfile publish characterization: CLI extension pull publishes the new entry", async () => {
  await withRegistry({ version: V1 }, async () => {
    const recorded = await record({}, (repos) => pullV1(repos));
    assertEquals(recorded, EXPECTED["cli pull"]);
  });
});

Deno.test("managed lockfile publish characterization: serve extension.pull publishes the new entry", async () => {
  await withRegistry({ version: V1 }, async () => {
    const recorded = await record({}, async (repos) => {
      await runServe(serveCtx(repos), {
        type: "extension.pull",
        payload: { extensionName: `${EXTENSION}@${V1}` },
      });
    });
    assertEquals(recorded, EXPECTED["serve pull"]);
  });
});

Deno.test("managed lockfile publish characterization: CLI extension update publishes the upgraded entry", async () => {
  const latest = { version: V1 };
  await withRegistry(latest, async () => {
    const recorded = await record({
      seed: async (repos) => {
        await pullV1(repos);
        latest.version = V2;
      },
    }, async (repos) => {
      await runCli({ args: cli(repos, "extension", "update", EXTENSION) });
    });
    assertEquals(recorded, EXPECTED["cli update"]);
  });
});

Deno.test("managed lockfile publish characterization: serve extension.update publishes the upgraded entry", async () => {
  const latest = { version: V1 };
  await withRegistry(latest, async () => {
    const recorded = await record({
      seed: async (repos) => {
        await pullV1(repos);
        latest.version = V2;
      },
    }, async (repos) => {
      await runServe(serveCtx(repos), {
        type: "extension.update",
        payload: { extensionName: EXTENSION },
      });
    });
    assertEquals(recorded, EXPECTED["serve update"]);
  });
});

Deno.test("managed lockfile publish characterization: a push that sends nothing while the lockfile must upload fails and keeps the change pending", async () => {
  const recorded = await record({}, async (repos) => {
    const service = repos.a.syncService!;
    // A sync service that lost track of its dirty files: it takes the mark
    // and reports pushing nothing.
    const forgetful = {
      ...service,
      markDirty: (options?: { relPath?: string }) => service.markDirty(options),
      pushChanged: () => Promise.resolve(0),
    } as DatastoreSyncService;
    const transaction = await cliTransaction(repos, { syncService: forgetful });
    const path = transaction.lockfilePath;
    await transaction.run(() => writeEntry(path, "@test/new"));
  });
  assertEquals(recorded, EXPECTED["zero-count push"]);
});

Deno.test("managed lockfile publish characterization: an older swamp's pending record warns, merges local entries and publishes", async () => {
  const recorded = await record({
    seed: async (repos) => {
      await writeEntry(await lockfilePath(repos), "@test/local");
    },
  }, async (repos) => {
    // Recorded after the settle, so the local entry is on the remote too and
    // the record carries only what an older swamp wrote: no content.
    await writeEntry(await lockfilePath(repos), "@test/unrecorded");
    await markLockfilePublishPending(repos.repoA);
    const transaction = await cliTransaction(repos);
    await transaction.refresh();
  });
  assertEquals(recorded, EXPECTED["unknown pending"]);
});

Deno.test("managed lockfile publish characterization: a change that throws after writing publishes and rethrows its own error", async () => {
  const recorded = await record({}, async (repos) => {
    const transaction = await cliTransaction(repos);
    const path = transaction.lockfilePath;
    await transaction.run(async () => {
      await writeEntry(path, "@test/partial");
      throw new Error("the install failed after its entry landed");
    });
  });
  assertEquals(recorded, EXPECTED["throwing change"]);
});

Deno.test("managed lockfile publish characterization: serve defers a failed publish, succeeds and keeps the change pending", async () => {
  const recorded = await record({
    seed: async (repos) => {
      await writeEntry(await lockfilePath(repos), EXTENSION);
    },
  }, async (repos) => {
    repos.remote.failNext("push");
    const frames = await sendRequest(serveCtx(repos), {
      type: "extension.rm",
      id: crypto.randomUUID(),
      payload: { extensionName: EXTENSION },
    });
    assertEquals(errorFrame(frames)?.error, undefined);
  });
  assertEquals(recorded, EXPECTED["serve defer"]);
});

Deno.test("managed lockfile publish characterization: a failed publish then a failed lock release reports the publish", async () => {
  const recorded = await record({}, async (repos) => {
    repos.remote.failNext("push");
    const transaction = await cliTransaction(repos, {
      lock: recordingLock(
        repos,
        () => Promise.reject(new Error("the lock could not be released")),
      ),
    });
    const path = transaction.lockfilePath;
    await transaction.run(() => writeEntry(path, "@test/new"));
  });
  assertEquals(recorded, EXPECTED["failed publish, failed release"]);
});
