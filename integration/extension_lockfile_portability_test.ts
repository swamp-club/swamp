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
 * Integration tests for a lockfile shared between Windows and POSIX
 * checkouts (swamp-club#3569). A Windows checkout writes
 * `upstream_extensions.json` paths with backslashes, and its bundle paths
 * name a bundle namespace hashed from a backslash path. These tests run the
 * real startup missing-files check and the real `extension install` restore
 * over such a lockfile, in-process on a temp repo.
 */

import { assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  configureStartupExtensions,
  type DeferredWarning,
} from "../src/cli/mod.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { vaultTypeRegistry } from "../src/domain/vaults/vault_type_registry.ts";
import { datastoreTypeRegistry } from "../src/domain/datastore/datastore_type_registry.ts";
import { reportRegistry } from "../src/domain/reports/report_registry.ts";
import { webhookTypeRegistry } from "../src/domain/webhooks/webhook_type_registry.ts";
import { resetManagedConfigRegistry } from "../src/infrastructure/persistence/paths.ts";
import {
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../src/infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { extensionInstall } from "../src/libswamp/extensions/install.ts";

import "../src/domain/models/models.ts";

interface Fixture {
  repoDir: string;
  marker: RepoMarkerData;
  lockfilePath: string;
  name: string;
}

/**
 * A repo with one pulled extension on disk (a manifest and an additional
 * file, so startup has nothing to bundle) and a lockfile as a Windows
 * checkout wrote it.
 */
async function withWindowsLockfileRepo(
  fn: (fixture: Fixture, written: string) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_3569_" });
  const name = `@t${crypto.randomUUID().slice(0, 8)}/ext`;
  const marker: RepoMarkerData = {
    swampVersion: "0.1.0",
    initializedAt: "2026-01-01T00:00:00.000Z",
    repoId: crypto.randomUUID(),
    tools: [],
  };
  try {
    await new RepoMarkerRepository().write(RepoPath.create(repoDir), marker);
    const extRoot = join(repoDir, ".swamp", "pulled-extensions", name);
    await ensureDir(join(extRoot, "files"));
    await Deno.writeTextFile(
      join(extRoot, "manifest.yaml"),
      `manifestVersion: 1\nname: "${name}"\nversion: "1.0.0"\n`,
    );
    await Deno.writeTextFile(join(extRoot, "files", "README.md"), "x");
    const windows = (path: string) => path.replaceAll("/", "\\");
    const lockfilePath = join(
      repoDir,
      "extensions",
      "models",
      "upstream_extensions.json",
    );
    await ensureDir(join(repoDir, "extensions", "models"));
    const written = JSON.stringify(
      {
        [name]: {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00.000Z",
          files: [
            windows(".swamp/bundles/2f6574ec/ext.js"),
            windows(`.swamp/pulled-extensions/${name}/files/README.md`),
            windows(`.swamp/pulled-extensions/${name}/manifest.yaml`),
          ],
          serverUrl: "https://swamp-club.com",
        },
      },
      null,
      2,
    ) + "\n";
    await Deno.writeTextFile(lockfilePath, written);
    await fn({ repoDir, marker, lockfilePath, name }, written);
  } finally {
    for (
      const registry of [
        modelRegistry,
        vaultTypeRegistry,
        datastoreTypeRegistry,
        reportRegistry,
        webhookTypeRegistry,
      ]
    ) {
      registry.clearLoadersForTesting();
    }
    resetManagedConfigRegistry();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

async function startupWarnings(fixture: Fixture): Promise<string[]> {
  const warnings: DeferredWarning[] = [];
  const dispose = await configureStartupExtensions({
    repoDir: fixture.repoDir,
    marker: fixture.marker,
    resolvedSources: [],
    deferredWarnings: warnings,
    quiet: true,
    readDatastoreEnv: () => undefined,
  });
  dispose();
  return warnings.map((w) => w.error);
}

async function install(fixture: Fixture) {
  for await (
    const event of extensionInstall(createLibSwampContext({}), {
      lockfilePath: fixture.lockfilePath,
      repoDir: fixture.repoDir,
      createInstallContext: () =>
        Promise.reject(new Error("an up-to-date extension is not installed")),
    })
  ) {
    if (event.kind === "completed") return event.data;
  }
  throw new Error("install did not complete");
}

Deno.test("startup: a lockfile written on Windows reports no missing source files and is not rewritten (swamp-club#3569)", async () => {
  await withWindowsLockfileRepo(async (fixture, written) => {
    const warnings = await startupWarnings(fixture);
    assertEquals(
      warnings.filter((w) => w.includes("missing source files")),
      [],
    );
    assertEquals(await Deno.readTextFile(fixture.lockfilePath), written);
  });
});

Deno.test("extension install: rewrites a lockfile written on Windows once, without reinstalling (swamp-club#3569)", async () => {
  await withWindowsLockfileRepo(async (fixture) => {
    const result = await install(fixture);
    assertEquals(result.upToDate, 1);
    assertEquals(result.installed, 0);
    assertEquals(JSON.parse(await Deno.readTextFile(fixture.lockfilePath)), {
      [fixture.name]: {
        version: "1.0.0",
        pulledAt: "2026-01-01T00:00:00.000Z",
        files: [
          `.swamp/pulled-extensions/${fixture.name}/files/README.md`,
          `.swamp/pulled-extensions/${fixture.name}/manifest.yaml`,
        ],
        serverUrl: "https://swamp-club.com",
      },
    });

    const normalized = await Deno.readTextFile(fixture.lockfilePath);
    await install(fixture);
    assertEquals(
      (await startupWarnings(fixture)).filter((w) =>
        w.includes("missing source files")
      ),
      [],
    );
    assertEquals(await Deno.readTextFile(fixture.lockfilePath), normalized);
  });
});
