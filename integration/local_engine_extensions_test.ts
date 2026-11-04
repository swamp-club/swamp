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
import { assertEquals, assertRejects } from "@std/assert";
import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { detachExtensionSources } from "../src/domain/extensions/model_kind_adapter.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { reportRegistry } from "../src/domain/reports/report_registry.ts";
import { vaultTypeRegistry } from "../src/domain/vaults/vault_type_registry.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import { createLocalEngineContext } from "../src/serve/local_engine_context.ts";
import { SERVE_ENV_MAP } from "../src/serve/serve_config.ts";
import { linkSharedSwampDenoCache } from "./test_helpers.ts";

await initializeLogging({});

const VERSION = "2026.01.01.1";
type Kind = "models" | "vaults" | "reports";

async function write(path: string, text: string): Promise<void> {
  await ensureDir(dirname(path));
  await Deno.writeTextFile(path, text);
}

async function withRepo(
  run: (repo: string, root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "local-engine-extensions-" }),
  );
  try {
    const repo = join(root, "repo");
    const home = join(root, "home");
    await ensureDir(home);
    await linkSharedSwampDenoCache(home);
    await write(
      join(repo, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n",
    );
    await write(
      join(repo, ".swamp", "serve.yaml"),
      "auth:\n  mode: token\n  admins: [user:operator]\n",
    );
    await withMockedEnv({
      ...Object.fromEntries([
        ...Object.values(SERVE_ENV_MAP),
        "SWAMP_DATASTORE",
        "SWAMP_EXTENSIONS_DIR",
        "SWAMP_WORKFLOWS_DIR",
        "SWAMP_MODELS_DIR",
        "SWAMP_BEHAVIORS_DIR",
        "SWAMP_REPORTS_DIR",
        "SWAMP_VAULTS_DIR",
      ].map((key) => [key, undefined])),
      SWAMP_HOME: home,
    }, () => run(repo, root));
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    } else await Deno.remove(root, { recursive: true });
  }
}

function source(kind: Kind, type: string, winner: string): string {
  switch (kind) {
    case "models":
      return `import { z } from "npm:zod@4";
export const model = {
  type: "${type}", version: "${VERSION}", globalArguments: z.object({}),
  methods: { probe: {
    description: "${winner}", arguments: z.object({}),
    execute: async () => ({ dataHandles: [] }),
  } },
};`;
    case "vaults":
      return `export const vault = {
  type: "${type}", name: "${winner}", description: "${winner}",
  createProvider: () => ({
    get: async () => "${winner}", put: async () => {}, list: async () => [],
    getName: () => "${winner}",
  }),
};`;
    case "reports":
      return `export const report = {
  name: "${type}", description: "${winner}", scope: "model",
  execute: async () => ({ artifacts: [] }),
};`;
  }
}

function description(kind: Kind, type: string): string | undefined {
  switch (kind) {
    case "models":
      return modelRegistry.get(type)?.methods.probe.description;
    case "vaults":
      return vaultTypeRegistry.get(type)?.description;
    case "reports":
      return reportRegistry.get(type)?.description;
  }
}

function wrappedSource(kind: Kind, type: string, winner: string): string {
  const exportName = { models: "model", vaults: "vault", reports: "report" }[
    kind
  ];
  const field = kind === "reports" ? "name" : "type";
  return source(kind, type, winner).replace(
    `export const ${exportName} = {`,
    `const wrap = (value: unknown) => value;\nexport const ${exportName} = wrap({`,
  ).replace(
    `${field}: "${type}"`,
    `${field}: ["@test", "${type.substring("@test/".length)}"].join("/")`,
  ).replace(/};$/, "});");
}

function invalidate(kind: Kind, types: string[]): void {
  for (const type of types) {
    switch (kind) {
      case "models":
        modelRegistry.invalidateType(type);
        break;
      case "vaults":
        vaultTypeRegistry.invalidateType(type);
        break;
      case "reports":
        reportRegistry.invalidateType(type);
        break;
    }
  }
}

for (const kind of ["models", "vaults", "reports"] as const) {
  Deno.test(`createLocalEngineContext: ${kind} honor local and ordered mount overrides on cold and warm startup`, async () => {
    await withRepo(async (repo, root) => {
      const suffix = crypto.randomUUID();
      const localType = `@test/local-${suffix}`;
      const mountedType = `@test/mounted-${suffix}`;
      const types = [localType, mountedType];
      // Configured order deliberately disagrees with lexical path order.
      const first = join(root, "z-first-mount");
      const second = join(root, "a-second-mount");
      const pulled = join(repo, ".swamp", "pulled-extensions", "@test", "pkg");
      await write(
        join(repo, ".swamp-sources.yaml"),
        `sources:\n  - path: ${JSON.stringify(first)}\n  - path: ${
          JSON.stringify(second)
        }\n`,
      );
      await write(
        join(pulled, "manifest.yaml"),
        `manifestVersion: 1\nname: "@test/pkg"\nversion: "${VERSION}"\n`,
      );
      for (
        const [dir, winner] of [
          [join(first, "extensions", kind), "first mount"],
          [join(second, "extensions", kind), "second mount"],
          [join(pulled, kind), "pulled"],
        ]
      ) {
        await write(join(dir, "local.ts"), source(kind, localType, winner));
        await write(join(dir, "mounted.ts"), source(kind, mountedType, winner));
      }
      await write(
        join(repo, "extensions", kind, "local.ts"),
        source(kind, localType, "local"),
      );
      const lockfile = await LockfileRepository.create(
        join(repo, "extensions", "models", "upstream_extensions.json"),
      );
      await lockfile.writeEntry("@test/pkg", VERSION, [
        `${kind}/local.ts`,
        `${kind}/mounted.ts`,
      ]);
      try {
        for (const _startup of ["cold", "warm"]) {
          const engine = await createLocalEngineContext(repo);
          try {
            assertEquals(description(kind, localType), "local");
            assertEquals(description(kind, mountedType), "first mount");
          } finally {
            await engine.dispose();
            invalidate(kind, types);
          }
        }
      } finally {
        invalidate(kind, types);
      }
    });
  });
}

Deno.test("createLocalEngineContext: cold reconcile discovers wrapped exports and warm startup attaches built-in add-ons", async () => {
  await withRepo(async (repo) => {
    const suffix = crypto.randomUUID();
    const type = `@test/wrapped-${suffix}`;
    const method = `probe_${suffix.replaceAll("-", "")}`;
    const models = join(repo, "extensions", "models");
    await write(
      join(models, "wrapped.ts"),
      wrappedSource("models", type, "wrapped"),
    );
    await write(
      join(models, "addon.ts"),
      `import { z } from "npm:zod@4";
export const extension = {
  type: "command/shell",
  methods: [{ ${method}: {
    description: "engine add-on", arguments: z.object({}),
    execute: async () => ({ dataHandles: [] }),
  } }],
};`,
    );
    const reset = () => {
      modelRegistry.invalidateType(type);
      detachExtensionSources("command/shell", (path) => path.startsWith(repo));
    };
    try {
      for (const _startup of ["cold", "warm"]) {
        const engine = await createLocalEngineContext(repo);
        try {
          assertEquals(description("models", type), "wrapped");
          assertEquals(modelRegistry.isLazy(type), false);
          assertEquals(
            modelRegistry.get("command/shell")?.methods[method]?.description,
            "engine add-on",
          );
        } finally {
          await engine.dispose();
          reset();
        }
      }
    } finally {
      reset();
    }
  });
});

Deno.test("createLocalEngineContext: configured directories retain computed exports across cold, warm and changed source paths", async () => {
  await withRepo(async (repo, root) => {
    const suffix = crypto.randomUUID();
    const kinds = ["models", "vaults", "reports"] as const;
    const typeFor = (kind: Kind) => `@test/${kind}-${suffix}`;
    const reset = () => {
      for (const kind of kinds) invalidate(kind, [typeFor(kind)]);
    };
    await write(
      join(repo, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n" +
        kinds.map((kind) => `${kind}Dir: configured/${kind}\n`).join(""),
    );
    for (const kind of kinds) {
      await write(
        join(repo, "configured", kind, "wrapped.ts"),
        wrappedSource(kind, typeFor(kind), "marker path"),
      );
      await write(
        join(root, "environment", kind, "wrapped.ts"),
        wrappedSource(kind, typeFor(kind), "environment path"),
      );
    }
    // The default models directory is no longer configured and must not load.
    await write(
      join(repo, "extensions", "models", "unused.ts"),
      "export const model = {};",
    );
    const starts = async (winner: string) => {
      for (const _startup of ["cold", "warm"]) {
        const engine = await createLocalEngineContext(repo);
        try {
          for (const kind of kinds) {
            assertEquals(description(kind, typeFor(kind)), winner);
          }
        } finally {
          await engine.dispose();
          reset();
        }
      }
    };
    try {
      await starts("marker path");
      await withMockedEnv({
        SWAMP_MODELS_DIR: join(root, "environment", "models"),
        SWAMP_VAULTS_DIR: join(root, "environment", "vaults"),
        SWAMP_REPORTS_DIR: join(root, "environment", "reports"),
      }, () => starts("environment path"));
    } finally {
      reset();
    }
  });
});

Deno.test("createLocalEngineContext: indexed invalid exports still refuse startup and repaired sources can reopen", async () => {
  await withRepo(async (repo) => {
    const type = `@test/repair-${crypto.randomUUID()}`;
    const file = join(repo, "extensions", "models", "invalid.ts");
    await write(file, `export const model = { type: "${type}" };`);
    try {
      await assertRejects(
        () => createLocalEngineContext(repo),
        Error,
        "Engine failed to load installed models",
      );
      await write(file, source("models", type, "repaired"));
      const engine = await createLocalEngineContext(repo);
      try {
        assertEquals(description("models", type), "repaired");
      } finally {
        await engine.dispose();
      }
    } finally {
      modelRegistry.invalidateType(type);
    }
  });
});

Deno.test("createLocalEngineContext: relative mounts in a linked worktree resolve from the main checkout", async () => {
  await withRepo(async (repo, root) => {
    const main = join(root, "main-checkout");
    const commonGit = join(main, ".git");
    const worktreeGit = join(commonGit, "worktrees", "engine");
    // Fabricate the small metadata set read by git rev-parse. No init, commit,
    // worktree command or swamp CLI subprocess is needed to create this repo.
    await ensureDir(join(commonGit, "objects"));
    await ensureDir(join(commonGit, "refs"));
    await write(join(commonGit, "HEAD"), "ref: refs/heads/main\n");
    await write(
      join(commonGit, "config"),
      "[core]\nrepositoryformatversion = 0\nbare = false\n",
    );
    await write(join(worktreeGit, "HEAD"), "ref: refs/heads/main\n");
    await write(join(worktreeGit, "commondir"), "../..\n");
    await write(join(worktreeGit, "gitdir"), `${join(repo, ".git")}\n`);
    await write(join(repo, ".git"), `gitdir: ${worktreeGit}\n`);
    await write(
      join(repo, ".swamp-sources.yaml"),
      "sources:\n  - path: shared\n",
    );
    const type = `@test/worktree-${crypto.randomUUID()}`;
    const workflowName = `relative-source-${crypto.randomUUID()}`;
    for (
      const [base, winner] of [[main, "main checkout"], [
        repo,
        "wrong worktree",
      ]]
    ) {
      await write(
        join(base, "shared", "extensions", "models", "relative.ts"),
        source("models", type, winner),
      );
      await write(
        join(base, "shared", "extensions", "workflows", "relative.yaml"),
        JSON.stringify({
          id: crypto.randomUUID(),
          name: workflowName,
          description: winner,
          version: 1,
          jobs: [{
            name: "test-job",
            steps: [{
              name: "test-step",
              task: {
                type: "model_method",
                modelIdOrName: "existing",
                methodName: "probe",
              },
            }],
          }],
        }),
      );
    }
    try {
      for (const _startup of ["cold", "warm"]) {
        const engine = await createLocalEngineContext(repo);
        try {
          assertEquals(description("models", type), "main checkout");
          assertEquals(
            (await engine.context.repoContext.workflowRepo.findByName(
              workflowName,
            ))?.description,
            "main checkout",
          );
        } finally {
          await engine.dispose();
          modelRegistry.invalidateType(type);
        }
      }
    } finally {
      modelRegistry.invalidateType(type);
    }
  });
});
