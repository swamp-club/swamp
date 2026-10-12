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
 * The managed extension lockfile on a v3 datastore (swamp-club#3279): CLI
 * and serve `extension pull` and `extension update`, and `doctor extensions
 * --repair`, against a stubbed registry. Each commits the lockfile through
 * the commit log, so a second checkout that catches up reads the same
 * entries.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import { createTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import {
  type RowRepos,
  runCli,
  runCliRejecting,
  runServe,
  serveCtx,
  UNSET_ENV,
} from "./usecase_sync_fixtures.ts";
import { datastoreRecords, withV3RowRepos } from "./usecase_v3_fixtures.ts";
import { openV3Datastore } from "../src/infrastructure/datastore_v3/v3_datastore.ts";

await initializeLogging({});

const EXTENSION = "@test/lockpub-v3";
const V1 = "2026.01.01.1";
const V2 = "2026.02.01.1";
const REGISTRY = "https://registry.test";
const ARCHIVE_HOST = "https://archives.test";

async function buildArchive(version: string): Promise<Uint8Array> {
  const dir = await Deno.makeTempDir({ prefix: "swamp_3279_arc_" });
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

/** A registry that serves {@link EXTENSION} at `latest.version`. */
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
          description: "v3 lockfile fixture",
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

/** Runs `fn` on a managed-config v3 repo, with a stubbed registry. */
async function withV3Registry(
  latest: { version: string },
  fn: (repos: RowRepos, datastorePath: string) => Promise<void>,
): Promise<void> {
  const archives = new Map([
    [V1, await buildArchive(V1)],
    [V2, await buildArchive(V2)],
  ]);
  const home = await Deno.makeTempDir({ prefix: "swamp_3279_home_" });
  try {
    await withMockedEnv(
      {
        ...UNSET_ENV,
        SWAMP_CLUB_URL: REGISTRY,
        HOME: home,
        SWAMP_HOME: home,
        SWAMP_CONFIG_DIR: join(home, ".config", "swamp"),
      },
      () =>
        withMockedFetch(
          registry(archives, latest),
          () => withV3RowRepos({ managedConfig: true }, fn),
        ),
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(home, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(home, { recursive: true });
    }
  }
}

function cli(repos: RowRepos, ...args: string[]): string[] {
  return [...args, "--repo-dir", repos.repoA, "--json"];
}

/** The lockfile entries a checkout reads, as `name@version`. */
async function lockfileEntries(repoDir: string): Promise<string[]> {
  const text = await Deno.readTextFile(
    swampPath(repoDir, "config", "upstream_extensions.json"),
  );
  const entries = JSON.parse(text) as Record<string, { version: string }>;
  return Object.entries(entries).map(([name, entry]) =>
    `${name}@${entry.version}`
  ).sort();
}

/**
 * B catches up and holds what A committed. Pulled extension sources
 * (`config/pulled-extensions/`) are each checkout's own (swamp-club#2612),
 * so they are left out of the comparison.
 */
async function assertLockfileShared(
  repos: RowRepos,
  datastorePath: string,
  label: string,
  expected: string,
): Promise<void> {
  const b = openV3Datastore({ repoDir: repos.repoB, datastorePath });
  try {
    await b.catchUp();
  } finally {
    await b.close();
  }
  const shared = async (repoDir: string) =>
    new Map(
      [...await datastoreRecords(repoDir)].filter(([rel]) =>
        !rel.startsWith("config/pulled-extensions/")
      ),
    );
  const writer = await shared(repos.repoA);
  assert(writer.size > 0, `${label}: the writer committed nothing`);
  assertEquals(await shared(repos.repoB), writer, label);
  assertEquals(await lockfileEntries(repos.repoB), [expected]);
}

Deno.test({
  name: "v3 extension lockfile: CLI extension pull commits the new entry",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withV3Registry({ version: V1 }, async (repos, datastorePath) => {
      await runCli({
        args: cli(repos, "extension", "pull", `${EXTENSION}@${V1}`),
      });
      await assertLockfileShared(
        repos,
        datastorePath,
        "cli pull",
        `${EXTENSION}@${V1}`,
      );
    });
  },
});

Deno.test({
  name: "v3 extension lockfile: serve extension.pull commits the new entry",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withV3Registry({ version: V1 }, async (repos, datastorePath) => {
      await runServe(serveCtx(repos), {
        type: "extension.pull",
        payload: { extensionName: `${EXTENSION}@${V1}` },
      });
      await assertLockfileShared(
        repos,
        datastorePath,
        "serve pull",
        `${EXTENSION}@${V1}`,
      );
    });
  },
});

Deno.test({
  name:
    "v3 extension lockfile: CLI and serve extension update commit the upgraded entry",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    for (const composition of ["cli", "serve"] as const) {
      const latest = { version: V1 };
      await withV3Registry(latest, async (repos, datastorePath) => {
        await runCli({
          args: cli(repos, "extension", "pull", `${EXTENSION}@${V1}`),
        });
        latest.version = V2;
        if (composition === "cli") {
          await runCli({ args: cli(repos, "extension", "update", EXTENSION) });
        } else {
          await runServe(serveCtx(repos), {
            type: "extension.update",
            payload: { extensionName: EXTENSION },
          });
        }
        await assertLockfileShared(
          repos,
          datastorePath,
          `${composition} update`,
          `${EXTENSION}@${V2}`,
        );
      });
    }
  },
});

Deno.test({
  name:
    "v3 extension lockfile: doctor extensions --repair applies on v3 and the lockfile stays committed",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withV3Registry({ version: V1 }, async (repos, datastorePath) => {
      await runCli({
        args: cli(repos, "extension", "pull", `${EXTENSION}@${V1}`),
      });
      // The pulled sources are the checkout's own; remove them so the
      // repair has something to fix.
      await Deno.remove(swampPath(repos.repoA, "pulled-extensions"), {
        recursive: true,
      }).catch(() => {});
      await Deno.remove(
        swampPath(repos.repoA, "config", "pulled-extensions"),
        { recursive: true },
      ).catch(() => {});
      // doctor reports the missing source it found, so it exits 1 even
      // when its repair re-pulled the extension.
      const output: string[] = [];
      await runCliRejecting(
        { args: cli(repos, "doctor", "extensions", "--repair") },
        output,
      );
      const report = JSON.parse(output.join("\n"));
      assertEquals(report.repairReport.mode, "applied");
      assertStringIncludes(output.join("\n"), EXTENSION);
      await assertLockfileShared(
        repos,
        datastorePath,
        "doctor repair",
        `${EXTENSION}@${V1}`,
      );
    });
  },
});
