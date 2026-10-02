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

// Add-ons that extend a built-in model type (swamp-club#2846). Built-in
// types are registered eagerly, so they never pass through the lazy type
// loader that attaches add-ons to local types. On a warm start the add-on
// must still attach when the type is resolved, through the extension
// attacher the CLI wires to the loader.

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { ExtensionLoader } from "../src/domain/extensions/extension_loader.ts";
import {
  detachExtensionSources,
  getExtensionMemberCollisions,
  modelKindAdapter,
} from "../src/domain/extensions/model_kind_adapter.ts";
import { resolveModelType } from "../src/domain/extensions/extension_auto_resolver.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";

import "../src/domain/models/models.ts";

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
  getDenoEnv: () => Deno.env.toObject(),
};

const SHELL = "command/shell";

const ADDON = (targetType: string, method: string) => `
import { z } from "npm:zod@4";

export const extension = {
  type: "${targetType}",
  methods: [{
    ${method}: {
      description: "added by an add-on",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;

const LOCAL_MODEL = (type: string) => `
import { z } from "npm:zod@4";

export const model = {
  type: "${type}",
  version: "2026.01.01.1",
  globalArguments: z.object({}),
  methods: {
    ping: {
      description: "ping",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

interface Repo {
  repoDir: string;
  modelsDir: string;
  pulledDir: string;
  repository: ExtensionRepository;
}

async function withRepo(fn: (repo: Repo) => Promise<void>): Promise<void> {
  const repoDir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp_2846_builtin_addon_" }),
  );
  const modelsDir = join(repoDir, "extensions", "models");
  const pulledDir = join(
    repoDir,
    ".swamp",
    "pulled-extensions",
    "@acme",
    "shell-addon",
    "models",
  );
  await ensureDir(modelsDir);
  await ensureDir(pulledDir);
  const lockfilePath = join(modelsDir, "upstream_extensions.json");
  await Deno.writeTextFile(lockfilePath, "{}");
  const catalog = new ExtensionCatalogStore(
    join(repoDir, ".swamp", "_extension_catalog.db"),
  );
  const repository = new ExtensionRepository({
    catalog,
    lockfileRepository: await LockfileRepository.create(lockfilePath),
    repoRoot: repoDir,
  });
  try {
    await fn({ repoDir, modelsDir, pulledDir, repository });
  } finally {
    modelRegistry.setExtensionAttacher(null);
    detachExtensionSources(SHELL, (path) => path.startsWith(repoDir));
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

/**
 * Indexes the repo cold, then starts a second loader on the warm catalog and
 * wires it into the registry the way `loadUserModels` does. Returns how many
 * times the attacher ran, per type.
 */
async function warmStart(repo: Repo): Promise<Map<string, number>> {
  const additionalDirs = [repo.pulledDir];
  await new ExtensionLoader(
    testDenoRuntime,
    modelKindAdapter,
    repo.repoDir,
    undefined,
    repo.repository,
  ).buildIndex(repo.modelsDir, { additionalDirs, indexOnly: true });

  const loader = new ExtensionLoader(
    testDenoRuntime,
    modelKindAdapter,
    repo.repoDir,
    undefined,
    repo.repository,
  );
  await loader.buildIndex(repo.modelsDir, { additionalDirs, indexOnly: true });
  const attachCalls = new Map<string, number>();
  modelRegistry.setExtensionAttacher(async (type) => {
    attachCalls.set(type, (attachCalls.get(type) ?? 0) + 1);
    await loader.attachPendingExtensionsForType(type);
  });
  return attachCalls;
}

function shellMethods(): string[] {
  return Object.keys(modelRegistry.get(SHELL)!.methods);
}

for (const source of ["local", "pulled"] as const) {
  Deno.test(`builtin add-on: a ${source} add-on on command/shell attaches on a warm start`, async () => {
    await withRepo(async (repo) => {
      const method = `probe_${crypto.randomUUID().slice(0, 8)}`;
      const dir = source === "local" ? repo.modelsDir : repo.pulledDir;
      await Deno.writeTextFile(
        join(dir, "shell_addon.ts"),
        ADDON(SHELL, method),
      );

      const attachCalls = await warmStart(repo);
      const def = await resolveModelType(SHELL, null);
      await resolveModelType(SHELL, null);

      assertEquals(method in def!.methods, true);
      assertEquals("execute" in def!.methods, true);
      assertEquals(attachCalls.get(SHELL), 1);
    });
  });
}

Deno.test("builtin add-on: with no add-on on command/shell its methods are unchanged", async () => {
  await withRepo(async (repo) => {
    const localType = `@test/plain-${crypto.randomUUID().slice(0, 8)}`;
    await Deno.writeTextFile(
      join(repo.modelsDir, "plain.ts"),
      LOCAL_MODEL(localType),
    );
    const before = shellMethods();

    try {
      const attachCalls = await warmStart(repo);
      await resolveModelType(SHELL, null);

      assertEquals(shellMethods(), before);
      assertEquals(attachCalls.get(SHELL), 1);
      assertEquals(modelRegistry.isLazy(localType), true);
    } finally {
      modelRegistry.invalidateType(localType);
    }
  });
});

Deno.test("builtin add-on: a later explicit attach pass does not re-attach or collide", async () => {
  await withRepo(async (repo) => {
    const method = `probe_${crypto.randomUUID().slice(0, 8)}`;
    await Deno.writeTextFile(
      join(repo.modelsDir, "shell_addon.ts"),
      ADDON(SHELL, method),
    );
    const additionalDirs = [repo.pulledDir];
    await warmStart(repo);
    await resolveModelType(SHELL, null);
    const attached = shellMethods();

    // The auto-resolver and serve's hot reload attach explicitly after
    // loading new bases; doing so after the hook ran must be a no-op.
    const loader = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repo.repoDir,
      undefined,
      repo.repository,
    );
    await loader.buildIndex(repo.modelsDir, {
      additionalDirs,
      indexOnly: true,
    });
    await loader.attachPendingExtensionsForType(SHELL);

    assertEquals(shellMethods(), attached);
    assertEquals(
      getExtensionMemberCollisions().filter((c) => c.type === SHELL),
      [],
    );
  });
});

Deno.test("builtin add-on: an add-on on a control-plane type never attaches, even on a cold index", async () => {
  await withRepo(async (repo) => {
    const method = `sneaky_${crypto.randomUUID().slice(0, 8)}`;
    await Deno.writeTextFile(
      join(repo.modelsDir, "grant_addon.ts"),
      ADDON("swamp/grant", method),
    );
    const before = Object.keys(modelRegistry.get("swamp/grant")!.methods);

    // A cold, importing load is the path that attaches add-ons whose rows
    // were bundled in the same pass.
    const loader = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repo.repoDir,
      undefined,
      repo.repository,
    );
    const result = await loader.buildIndex(repo.modelsDir, {
      additionalDirs: [repo.pulledDir],
    });
    await loader.attachPendingExtensionsForType("swamp/grant");

    assertEquals(
      Object.keys(modelRegistry.get("swamp/grant")!.methods),
      before,
    );
    assertEquals(
      result.failed.some((f) =>
        f.error.includes("Cannot extend control-plane model type")
      ),
      true,
    );
  });
});
