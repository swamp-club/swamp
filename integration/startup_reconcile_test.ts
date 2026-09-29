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
 * Integration tests for the startup catalog reconcile (swamp-club#2702).
 *
 * When the extension catalog is rebuilt from scratch, the startup reconcile
 * re-indexes every pulled extension. Two pulled extensions that provide the
 * same type used to fail I-Repo-1, roll the whole reconcile back and fail
 * every command, including the `doctor extensions --repair` and
 * `extension rm` that fix the state. These tests run
 * `configureStartupExtensions` in-process on a temp repo, with the real
 * reconcile, repository, catalog and model loader.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { configureStartupExtensions } from "../src/cli/mod.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { vaultTypeRegistry } from "../src/domain/vaults/vault_type_registry.ts";
import { datastoreTypeRegistry } from "../src/domain/datastore/datastore_type_registry.ts";
import { reportRegistry } from "../src/domain/reports/report_registry.ts";
import { webhookTypeRegistry } from "../src/domain/webhooks/webhook_type_registry.ts";
import { RemoveExtensionService } from "../src/libswamp/extensions/remove_extension_service.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import { resetManagedConfigRegistry } from "../src/infrastructure/persistence/paths.ts";
import {
  type RepoMarkerData,
  RepoMarkerRepository,
} from "../src/infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";

import "../src/domain/models/models.ts";

/** A model of `type` whose one method is named `method`, so a test can
 *  tell which provider the registry loaded. */
const MODEL_CODE = (type: string, method: string) => `
import { z } from "npm:zod@4";

export const model = {
  type: "${type}",
  version: "2026.05.05.1",
  globalArguments: z.object({}),
  resources: {},
  methods: {
    ${method}: {
      description: "${method}",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

interface Fixture {
  repoDir: string;
  marker: RepoMarkerData;
  scope: string;
  type: string;
  lockfilePath: string;
}

async function withRepo(fn: (fixture: Fixture) => Promise<void>) {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_2702_" });
  const scope = `@t${crypto.randomUUID().slice(0, 8)}`;
  const type = `${scope}/shared/thing`;
  const marker: RepoMarkerData = {
    swampVersion: "0.1.0",
    initializedAt: "2026-01-01T00:00:00.000Z",
    repoId: crypto.randomUUID(),
    tools: [],
  };
  try {
    await new RepoMarkerRepository().write(RepoPath.create(repoDir), marker);
    await ensureDir(join(repoDir, "extensions", "models"));
    await fn({
      repoDir,
      marker,
      scope,
      type,
      lockfilePath: join(
        repoDir,
        "extensions",
        "models",
        "upstream_extensions.json",
      ),
    });
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
    modelRegistry.invalidateType(type);
    resetManagedConfigRegistry();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

/** Writes a pulled extension providing `type` and returns the lockfile
 *  `files` for it, relative to the repo. */
async function writePulled(
  fixture: Fixture,
  name: string,
  method: string,
): Promise<string[]> {
  const rel = join(".swamp", "pulled-extensions", name);
  const extRoot = join(fixture.repoDir, rel);
  await ensureDir(join(extRoot, "models"));
  await Deno.writeTextFile(
    join(extRoot, "manifest.yaml"),
    `manifestVersion: 1\nname: "${name}"\nversion: "1.0.0"\n`,
  );
  await Deno.writeTextFile(
    join(extRoot, "models", "thing.ts"),
    MODEL_CODE(fixture.type, method),
  );
  return [
    join(rel, "manifest.yaml"),
    join(rel, "models", "thing.ts"),
  ];
}

async function writeLockfile(
  fixture: Fixture,
  entries: Record<string, string[]>,
): Promise<void> {
  const map: Record<string, unknown> = {};
  for (const [name, files] of Object.entries(entries)) {
    map[name] = { version: "1.0.0", pulledAt: "2026-01-01T00:00:00Z", files };
  }
  await Deno.writeTextFile(fixture.lockfilePath, JSON.stringify(map));
}

/** Two pulled providers of one type, first listed first in the lockfile. */
async function writeTwoProviders(fixture: Fixture) {
  const first = `${fixture.scope}/first`;
  const second = `${fixture.scope}/second`;
  await writeLockfile(fixture, {
    [first]: await writePulled(fixture, first, "fromFirst"),
    [second]: await writePulled(fixture, second, "fromSecond"),
  });
  return { first, second };
}

/** Runs startup, then `during` while it is live, capturing swamp logs at
 *  `lowestLevel` and above for the whole span. */
async function startup(
  fixture: Fixture,
  during: () => Promise<void> = () => Promise.resolve(),
  lowestLevel: "debug" | "warning" = "warning",
): Promise<string[]> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      { category: ["swamp"], lowestLevel, sinks: ["capture"] },
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: [] },
    ],
    reset: true,
  });
  try {
    const dispose = await configureStartupExtensions({
      repoDir: fixture.repoDir,
      marker: fixture.marker,
      resolvedSources: [],
      deferredWarnings: [],
      quiet: true,
      readDatastoreEnv: () => undefined,
    });
    try {
      await during();
    } finally {
      dispose();
    }
  } finally {
    await reset();
  }
  return records.map((r) =>
    `${r.category.join(".")}: ${r.message.map(String).join("")}`
  );
}

/** Loads the model registry fresh and returns the method names of the
 *  model it resolved for the shared type. */
async function loadedMethods(fixture: Fixture): Promise<string[]> {
  modelRegistry.invalidateType(fixture.type);
  modelRegistry.resetLoadedFlag();
  await modelRegistry.ensureLoaded();
  await modelRegistry.ensureTypeLoaded(fixture.type);
  return Object.keys(modelRegistry.get(fixture.type)?.methods ?? {});
}

Deno.test("configureStartupExtensions: a rebuilt catalog with two pulled providers of one type keeps the first and warns (swamp-club#2702)", async () => {
  await withRepo(async (fixture) => {
    const { first, second } = await writeTwoProviders(fixture);

    let methods: string[] = [];
    const logs = await startup(fixture, async () => {
      methods = await loadedMethods(fixture);
    });

    assertEquals(methods, ["fromFirst"]);
    assertEquals(logs.filter((l) => l.includes("repair failed")), []);
    const conflicts = logs.filter((l) => l.includes("both provide"));
    assertEquals(conflicts.length, 1);
    assertStringIncludes(conflicts[0], `Extensions ${first} and ${second}`);

    // The repaired catalog is marked populated, so the next command does
    // not reconcile again.
    const again = await startup(fixture, () => Promise.resolve(), "debug");
    assertEquals(
      again.filter((l) => l.startsWith("swamp.extensions.reconcile")),
      [],
    );
  });
});

Deno.test("configureStartupExtensions: a reconcile that fails is reported once and does not fail startup (swamp-club#2702)", async () => {
  await withRepo(async (fixture) => {
    // Two local extensions declaring one type: I-Repo-1 still rejects
    // this, so the reconcile fails.
    for (const dir of ["a", "b"]) {
      const subdir = join(fixture.repoDir, "extensions", "models", dir);
      await ensureDir(subdir);
      await Deno.writeTextFile(
        join(subdir, "manifest.yaml"),
        `manifestVersion: 1\nname: "${fixture.scope}/${dir}"\nversion: "1.0.0"\n`,
      );
      await Deno.writeTextFile(
        join(subdir, "thing.ts"),
        MODEL_CODE(fixture.type, `from_${dir}`),
      );
    }
    await writeLockfile(fixture, {});

    let loaded = false;
    const logs = await startup(fixture, async () => {
      // A loader's first load must not repeat the failed reconcile.
      await modelRegistry.ensureLoaded();
      loaded = true;
    });

    assertEquals(loaded, true);
    const failures = logs.filter((l) => l.includes("repair failed"));
    assertEquals(failures.length, 1);
    assertStringIncludes(failures[0], "I-Repo-1");
    assertStringIncludes(failures[0], "swamp doctor extensions");
  });
});

Deno.test("configureStartupExtensions: removing the provider that kept the type hands it to the other (swamp-club#2702)", async () => {
  await withRepo(async (fixture) => {
    const { first } = await writeTwoProviders(fixture);
    await startup(fixture);

    const catalog = new ExtensionCatalogStore(
      join(fixture.repoDir, ".swamp", "_extension_catalog.db"),
    );
    try {
      const lockfileRepository = await LockfileRepository.create(
        fixture.lockfilePath,
      );
      await new RemoveExtensionService({
        repository: new ExtensionRepository({
          catalog,
          lockfileRepository,
          repoRoot: fixture.repoDir,
        }),
        lockfileRepository,
        repoDir: fixture.repoDir,
      }).execute(first);
    } finally {
      catalog.close();
    }

    let methods: string[] = [];
    const logs = await startup(fixture, async () => {
      methods = await loadedMethods(fixture);
    });

    assertEquals(methods, ["fromSecond"]);
    assertEquals(logs.filter((l) => l.includes("repair failed")), []);
  });
});
