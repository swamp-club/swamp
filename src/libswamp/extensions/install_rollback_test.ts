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

// An install held uncommitted across the catalog save, and what its
// commit and rollback do on disk (swamp-club#2724). These drive the real
// installExtension through InstallExtensionService with a fake registry
// and real archives. There is no install_rollback.ts: the code under test
// is PendingInstall and applyInstall/installExtension in pull.ts, phase 8
// in install_extension_service.ts, and UpgradeExtensionService.

import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { ensureDir, walk } from "@std/fs";
import { basename, dirname, join, relative } from "@std/path";
import { InstallExtensionService } from "./install_extension_service.ts";
import { UpgradeExtensionService } from "./upgrade_extension_service.ts";
import {
  type InstallContext,
  installExtension,
  type InstallOptions,
  type InstallResult,
} from "./pull.ts";
import { recoverPulledExtensionStaging } from "./recover_staging.ts";
import { createTarGz } from "../../infrastructure/archive/tar_archive.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import {
  extensionInstallRoots,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { isStagingEntryName } from "../../domain/extensions/install_journal.ts";
import { DuplicateTypeUserError } from "../../domain/extensions/duplicate_type_user_error.ts";
import type { DenoRuntime } from "../../domain/runtime/deno_runtime.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import "../../domain/models/models.ts";

await initializeLogging({});

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
  getDenoEnv: () => Deno.env.toObject(),
};

const V1 = "2026.01.01.1";
const V2 = "2026.01.02.1";
const V1_1 = "2026.01.01.2";

// The zod swamp provides to extensions, so no npm download is needed.
const MODEL = (typeId: string) =>
  `// deno-lint-ignore no-explicit-any
const { z } = (globalThis as any).__swamp_zod;

export const model = {
  type: "${typeId}",
  version: "2026.05.05.1",
  globalArguments: z.object({}),
  resources: {
    "data": {
      description: "x",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 1,
    },
  },
  methods: {
    noop: {
      description: "noop",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

/** What one archive ships. */
interface ArchiveSpec {
  /** Model file name to the type it declares. */
  models?: Record<string, string>;
  /** Skill name to its files (relative path to content). */
  skills?: Record<string, Record<string, string>>;
  dependencies?: string[];
}

async function buildArchive(
  name: string,
  version: string,
  spec: ArchiveSpec,
): Promise<Uint8Array> {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_2724_arc_" });
  try {
    const extDir = join(tmp, "extension");
    await ensureDir(extDir);
    const models = Object.keys(spec.models ?? {});
    const skills = Object.keys(spec.skills ?? {});
    const lines = [
      "manifestVersion: 1",
      `name: "${name}"`,
      `version: "${version}"`,
    ];
    if (models.length > 0) {
      lines.push("models:", ...models.map((m) => `  - ${m}`));
    }
    if (skills.length > 0) {
      lines.push("skills:", ...skills.map((s) => `  - ${s}`));
    }
    if (spec.dependencies && spec.dependencies.length > 0) {
      lines.push(
        "dependencies:",
        ...spec.dependencies.map((d) => `  - "${d}"`),
      );
    }
    await Deno.writeTextFile(join(extDir, "manifest.yaml"), lines.join("\n"));
    for (const [file, type] of Object.entries(spec.models ?? {})) {
      await ensureDir(join(extDir, "models"));
      await Deno.writeTextFile(join(extDir, "models", file), MODEL(type));
    }
    for (const [skill, files] of Object.entries(spec.skills ?? {})) {
      for (const [file, content] of Object.entries(files)) {
        const path = join(extDir, "skills", skill, file);
        await ensureDir(dirname(path));
        await Deno.writeTextFile(path, content);
      }
    }
    await createTarGz(extDir, join(tmp, "a.tar.gz"));
    return await Deno.readFile(join(tmp, "a.tar.gz"));
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

/** A temp repo with a real catalog, lockfile and a fake registry. */
class Repo {
  readonly lockfilePath: string;
  readonly skillsDir: string;
  readonly catalog: ExtensionCatalogStore;
  readonly #archives = new Map<string, Uint8Array>();
  readonly #latest = new Map<string, string>();
  readonly #failDownload = new Set<string>();

  constructor(readonly repoDir: string) {
    this.lockfilePath = join(
      repoDir,
      "extensions",
      "models",
      "upstream_extensions.json",
    );
    this.skillsDir = join(repoDir, ".claude", "skills");
    this.catalog = new ExtensionCatalogStore(
      join(repoDir, ".swamp", "_extension_catalog.db"),
    );
  }

  /** Publishes `name@version` to the fake registry as its latest. */
  async publish(name: string, version: string, spec: ArchiveSpec) {
    this.#archives.set(
      `${name}@${version}`,
      await buildArchive(name, version, spec),
    );
    this.#latest.set(name, version);
  }

  /** Makes every download of `name` fail. */
  failDownloadOf(name: string) {
    this.#failDownload.add(name);
  }

  /** A fresh context per command, as the CLI builds one. */
  async ctx(overrides: Partial<InstallContext> = {}): Promise<InstallContext> {
    return {
      getExtension: (n) => {
        const latest = this.#latest.get(n);
        return Promise.resolve(
          latest ? { name: n, description: "", latestVersion: latest } : null,
        );
      },
      downloadArchive: (n, v) => {
        const archive = this.#archives.get(`${n}@${v}`);
        if (this.#failDownload.has(n) || !archive) {
          return Promise.reject(new Error(`cannot download ${n}@${v}`));
        }
        return Promise.resolve(archive);
      },
      getChecksum: () => Promise.resolve(null),
      lockfileRepository: await LockfileRepository.create(this.lockfilePath),
      skillsDirs: [this.skillsDir],
      repoDir: this.repoDir,
      force: true,
      alreadyPulled: new Set(),
      depth: 0,
      ...overrides,
    };
  }

  service(ctx: InstallContext): InstallExtensionService {
    return new InstallExtensionService({
      denoRuntime: testDenoRuntime,
      repository: this.repository(ctx),
    });
  }

  repository(ctx: InstallContext): ExtensionRepository {
    return new ExtensionRepository({
      catalog: this.catalog,
      lockfileRepository: ctx.lockfileRepository,
      repoRoot: this.repoDir,
    });
  }

  /** Installs through InstallExtensionService, as `extension pull` does. */
  async install(
    name: string,
    version: string,
    overrides: Partial<InstallContext> = {},
  ): Promise<InstallResult | undefined> {
    const ctx = await this.ctx(overrides);
    return await this.service(ctx).execute({ name, version }, ctx);
  }

  async lockfile(): Promise<Record<string, unknown>> {
    return JSON.parse(await Deno.readTextFile(this.lockfilePath));
  }

  /** Everything on disk that belongs to `name`: root, bundles and entry. */
  async snapshot(name: string): Promise<Record<string, unknown>> {
    const roots = extensionInstallRoots(this.repoDir, name);
    const out: Record<string, unknown> = {
      root: await tree(roots.extensionRoot),
      entry: (await this.lockfile())[name] ?? null,
    };
    for (const bundle of roots.bundleRoots) {
      out[relative(this.repoDir, bundle.live)] = await tree(bundle.live);
    }
    return out;
  }
}

async function withRepo(fn: (repo: Repo) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_2724_" });
  await ensureDir(join(repoDir, ".swamp"));
  await ensureDir(join(repoDir, "extensions", "models"));
  const repo = new Repo(repoDir);
  await Deno.writeTextFile(repo.lockfilePath, "{}");
  try {
    await fn(repo);
  } finally {
    repo.catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

/**
 * Every file and link under `dir` with its content or link target, or
 * null when `dir` is absent.
 */
async function tree(dir: string): Promise<Record<string, string> | null> {
  if (!(await exists(dir))) return null;
  const out: Record<string, string> = {};
  for await (const entry of walk(dir, { includeDirs: false })) {
    const rel = relative(dir, entry.path).replaceAll("\\", "/");
    out[rel] = entry.isSymlink
      ? `-> ${await Deno.readLink(entry.path)}`
      : await Deno.readTextFile(entry.path);
  }
  return out;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Staging dirs and journals left anywhere under `.swamp`. */
async function stagingLeft(repoDir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of walk(swampPath(repoDir), { includeFiles: false })) {
    if (isStagingEntryName(basename(entry.path))) {
      out.push(relative(repoDir, entry.path));
    }
  }
  return out;
}

function ids() {
  const id = crypto.randomUUID().slice(0, 8);
  return {
    a: `@t/a-${id}`,
    b: `@t/b-${id}`,
    c: `@t/c-${id}`,
    d: `@t/d-${id}`,
    e: `@t/e-${id}`,
    shared: `@t/shared-${id}`,
    own: (n: string) => `@t/own-${n}-${id}`,
  };
}

/** B claims `shared`; A v1 installed with its own type. */
async function installBAndAv1(
  repo: Repo,
  n: ReturnType<typeof ids>,
  aV1: ArchiveSpec = {},
) {
  await repo.publish(n.b, V1, { models: { "b.ts": n.shared } });
  await repo.install(n.b, V1);
  await repo.publish(n.a, V1, {
    models: { "a_v1.ts": n.own("a1"), ...aV1.models },
    ...aV1.skills ? { skills: aV1.skills } : {},
    ...aV1.dependencies ? { dependencies: aV1.dependencies } : {},
  });
  await repo.install(n.a, V1, { channel: "beta" });
}

Deno.test("InstallExtensionService.execute: an upgrade that collides leaves the previous version exactly as it was (swamp-club#2724)", async () => {
  await withRepo(async (repo) => {
    const n = ids();
    await installBAndAv1(repo, n);
    // A key this version does not know: the restore must keep it.
    const lockfile = await repo.lockfile();
    (lockfile[n.a] as Record<string, unknown>).futureField = "kept";
    await Deno.writeTextFile(
      repo.lockfilePath,
      JSON.stringify(lockfile, null, 2) + "\n",
    );
    const before = await repo.snapshot(n.a);
    assertExists((before.entry as Record<string, unknown>).pulledAt);
    assertEquals((before.entry as Record<string, unknown>).channel, "beta");

    await repo.publish(n.a, V2, { models: { "a_v2.ts": n.shared } });
    const thrown = await assertRejects(
      () => repo.install(n.a, V2),
      DuplicateTypeUserError,
    );

    assertEquals(thrown.rolledBack, true);
    assertStringIncludes(thrown.message, `${n.a}@${V1} remains installed`);
    assertEquals(await repo.snapshot(n.a), before);
    assertEquals(await stagingLeft(repo.repoDir), []);
    // The catalog still holds v1 only.
    const ctx = await repo.ctx();
    assertEquals(
      repo.repository(ctx).loadByName(n.a).map((e) => e.version),
      [V1],
    );
  });
});

Deno.test("InstallExtensionService.execute: a collision removes a dependency installed with it and leaves an installed one alone (swamp-club#2724)", async () => {
  await withRepo(async (repo) => {
    const n = ids();
    // E is installed before; D is new with A v2.
    await repo.publish(n.e, V1, { models: { "e.ts": n.own("e") } });
    await repo.install(n.e, V1);
    await installBAndAv1(repo, n);
    const beforeA = await repo.snapshot(n.a);
    const beforeE = await repo.snapshot(n.e);

    await repo.publish(n.d, V1, { models: { "d.ts": n.own("d") } });
    await repo.publish(n.a, V2, {
      models: { "a_v2.ts": n.shared },
      dependencies: [n.d, n.e],
    });
    await assertRejects(() => repo.install(n.a, V2), DuplicateTypeUserError);

    assertEquals(await repo.snapshot(n.a), beforeA);
    assertEquals(await repo.snapshot(n.e), beforeE);
    const d = await repo.snapshot(n.d);
    assertEquals(d.root, null);
    assertEquals(d.entry, null);
    for (const [key, value] of Object.entries(d)) {
      if (key !== "root" && key !== "entry") assertEquals(value, null, key);
    }
    assertEquals(await stagingLeft(repo.repoDir), []);
  });
});

Deno.test("InstallExtensionService.execute: a first install that collides leaves nothing behind (swamp-club#2724)", async () => {
  await withRepo(async (repo) => {
    const n = ids();
    await repo.publish(n.b, V1, { models: { "b.ts": n.shared } });
    await repo.install(n.b, V1);

    await repo.publish(n.c, V1, { models: { "c.ts": n.shared } });
    await assertRejects(() => repo.install(n.c, V1), DuplicateTypeUserError);

    // No root, no entry, and no bundle dir, including the one the
    // catalog save's loader wrote bundles into after the swap.
    for (const [key, value] of Object.entries(await repo.snapshot(n.c))) {
      assertEquals(value, null, key);
    }
    assertEquals(await stagingLeft(repo.repoDir), []);
  });
});

Deno.test("UpgradeExtensionService.execute: an upgrade that collides keeps the previous version (swamp-club#2724)", async () => {
  await withRepo(async (repo) => {
    const n = ids();
    await installBAndAv1(repo, n);
    const before = await repo.snapshot(n.a);

    await repo.publish(n.a, V2, { models: { "a_v2.ts": n.shared } });
    const ctx = await repo.ctx();
    await assertRejects(
      () =>
        new UpgradeExtensionService({
          denoRuntime: testDenoRuntime,
          repository: repo.repository(ctx),
        }).execute(n.a, V2, ctx),
      DuplicateTypeUserError,
    );

    assertEquals(await repo.snapshot(n.a), before);
  });
});

// ===== Skills =====

Deno.test("InstallExtensionService.execute: a skill file only the previous version shipped survives a rollback (swamp-club#2724)", async () => {
  await withRepo(async (repo) => {
    const n = ids();
    const skill = `sk-${crypto.randomUUID().slice(0, 8)}`;
    await installBAndAv1(repo, n, {
      skills: { [skill]: { "SKILL.md": "v1", "old.md": "v1 only" } },
    });

    await repo.publish(n.a, V2, {
      models: { "a_v2.ts": n.shared },
      skills: { [skill]: { "SKILL.md": "v2" } },
    });
    await assertRejects(() => repo.install(n.a, V2), DuplicateTypeUserError);

    assertEquals(
      await Deno.readTextFile(join(repo.skillsDir, skill, "old.md")),
      "v1 only",
    );
  });
});

Deno.test("InstallExtensionService.execute: a skill file the new version drops is pruned when the install commits", async () => {
  await withRepo(async (repo) => {
    const n = ids();
    const skill = `sk-${crypto.randomUUID().slice(0, 8)}`;
    await installBAndAv1(repo, n, {
      skills: { [skill]: { "SKILL.md": "v1", "old.md": "v1 only" } },
    });
    const dropped = `dropped-${crypto.randomUUID().slice(0, 8)}`;
    await repo.publish(n.a, V1_1, {
      models: { "a_v1.ts": n.own("a1") },
      skills: {
        [skill]: { "SKILL.md": "v1", "old.md": "v1 only" },
        [dropped]: { "SKILL.md": "gone next" },
      },
    });
    await repo.install(n.a, V1_1);

    await repo.publish(n.a, V2, {
      models: { "a_v2.ts": n.own("a2") },
      skills: { [skill]: { "SKILL.md": "v2" } },
    });
    const result = await repo.install(n.a, V2);

    assertEquals(await exists(join(repo.skillsDir, dropped)), false);
    const droppedRel = relative(repo.repoDir, join(repo.skillsDir, dropped));
    assert(
      result?.pruned.includes(droppedRel),
      `pruned should report ${droppedRel}: ${result?.pruned}`,
    );
    assertEquals(await stagingLeft(repo.repoDir), []);
  });
});

Deno.test("InstallExtensionService.execute: a dropped skill dir a new dependency merges into keeps only the dependency's files (swamp-club#2724)", async () => {
  await withRepo(async (repo) => {
    const n = ids();
    const skill = `sk-${crypto.randomUUID().slice(0, 8)}`;
    await installBAndAv1(repo, n, {
      skills: { [skill]: { "a.md": "from a" } },
    });

    await repo.publish(n.d, V1, { skills: { [skill]: { "d.md": "from d" } } });
    await repo.publish(n.a, V2, {
      models: { "a_v2.ts": n.own("a2") },
      dependencies: [n.d],
    });
    await repo.install(n.a, V2);

    assertEquals(await tree(join(repo.skillsDir, skill)), {
      "d.md": "from d",
    });
  });
});

Deno.test("InstallExtensionService.execute: a skill dir renamed only in case is pruned under its old name on commit", async () => {
  await withRepo(async (repo) => {
    // Only meaningful where the two spellings are two dirs.
    const probe = join(repo.repoDir, "CaseProbe");
    await Deno.writeTextFile(probe, "");
    const caseSensitive = !(await exists(join(repo.repoDir, "caseprobe")));
    await Deno.remove(probe);
    if (!caseSensitive) return;

    const n = ids();
    const id = crypto.randomUUID().slice(0, 8);
    await installBAndAv1(repo, n, {
      skills: { [`Sk-${id}`]: { "SKILL.md": "v1" } },
    });
    await repo.publish(n.a, V2, {
      models: { "a_v2.ts": n.own("a2") },
      skills: { [`sk-${id}`]: { "SKILL.md": "v2" } },
    });
    await repo.install(n.a, V2);

    assertEquals(await exists(join(repo.skillsDir, `Sk-${id}`)), false);
    assertEquals(
      await Deno.readTextFile(join(repo.skillsDir, `sk-${id}`, "SKILL.md")),
      "v2",
    );
  });
});

Deno.test("InstallExtensionService.execute: pruning a dropped skill dir that is now a symlink removes only the link", async () => {
  if (Deno.build.os === "windows") return;
  await withRepo(async (repo) => {
    const n = ids();
    const skill = `sk-${crypto.randomUUID().slice(0, 8)}`;
    await installBAndAv1(repo, n, {
      skills: { [skill]: { "a.md": "from a" } },
    });
    const target = join(repo.repoDir, "user-data");
    await ensureDir(target);
    await Deno.writeTextFile(join(target, "keep.md"), "keep");
    await Deno.remove(join(repo.skillsDir, skill), { recursive: true });
    await Deno.symlink(target, join(repo.skillsDir, skill), { type: "dir" });

    await repo.publish(n.a, V2, { models: { "a_v2.ts": n.own("a2") } });
    await repo.install(n.a, V2);

    assertEquals(await exists(join(repo.skillsDir, skill)), false);
    assertEquals(await Deno.readTextFile(join(target, "keep.md")), "keep");
  });
});

Deno.test("PendingInstall.commit: the skill prune walk never descends a symlink and keeps a nested root another entry claims", async () => {
  if (Deno.build.os === "windows") return;
  await withRepo(async (repo) => {
    const n = ids();
    const skill = `sk-${crypto.randomUUID().slice(0, 8)}`;
    await installBAndAv1(repo, n, {
      skills: { [skill]: { "a.md": "from a", "sub/a2.md": "from a" } },
    });
    const skillDir = join(repo.skillsDir, skill);
    // A link inside the dropped dir to files elsewhere.
    const target = join(repo.repoDir, "user-data");
    await ensureDir(target);
    await Deno.writeTextFile(join(target, "keep.md"), "keep");
    await Deno.symlink(target, join(skillDir, "linked"), { type: "dir" });

    // A new dependency merges into the dropped dir, and (standing in for
    // any entry written before the install commits) another entry claims
    // a dir inside it: the commit walks the dir file by file.
    await repo.publish(n.d, V1, { skills: { [skill]: { "d.md": "from d" } } });
    await upgradeWith(repo, n, async (pending) => {
      const ctx = await repo.ctx();
      await ctx.lockfileRepository.writeEntry("@t/other", "1.0.0", [
        relative(repo.repoDir, join(skillDir, "sub")),
      ]);
      await pending.commit();
    }, { models: { "a_v2.ts": n.own("a2") }, dependencies: [n.d] });

    assertEquals(await exists(join(skillDir, "a.md")), false);
    assertEquals(await exists(join(skillDir, "linked")), false);
    assertEquals(await Deno.readTextFile(join(target, "keep.md")), "keep");
    assertEquals(
      await Deno.readTextFile(join(skillDir, "sub", "a2.md")),
      "from a",
    );
    assertEquals(await Deno.readTextFile(join(skillDir, "d.md")), "from d");
  });
});

Deno.test("InstallExtensionService.execute: a rollback keeps a skill dir that existed before and the user's files in it", async () => {
  await withRepo(async (repo) => {
    const n = ids();
    await repo.publish(n.b, V1, { models: { "b.ts": n.shared } });
    await repo.install(n.b, V1);
    const skill = `sk-${crypto.randomUUID().slice(0, 8)}`;
    await ensureDir(join(repo.skillsDir, skill));
    await Deno.writeTextFile(join(repo.skillsDir, skill, "mine.md"), "mine");

    await repo.publish(n.c, V1, {
      models: { "c.ts": n.shared },
      skills: { [skill]: { "SKILL.md": "from c" } },
    });
    await assertRejects(() => repo.install(n.c, V1), DuplicateTypeUserError);

    assertEquals(await tree(join(repo.skillsDir, skill)), {
      "mine.md": "mine",
    });
  });
});

Deno.test("InstallExtensionService.execute: a rollback removes a skill dir the install created", async () => {
  await withRepo(async (repo) => {
    const n = ids();
    await repo.publish(n.b, V1, { models: { "b.ts": n.shared } });
    await repo.install(n.b, V1);
    const skill = `sk-${crypto.randomUUID().slice(0, 8)}`;

    await repo.publish(n.c, V1, {
      models: { "c.ts": n.shared },
      skills: { [skill]: { "SKILL.md": "from c", "scripts/run.sh": "x" } },
    });
    await assertRejects(() => repo.install(n.c, V1), DuplicateTypeUserError);

    assertEquals(await exists(join(repo.skillsDir, skill)), false);
  });
});

// ===== The handle =====

/** Runs an A v1 -> v2 upgrade whose phase 8 is `underLock`. */
async function upgradeWith(
  repo: Repo,
  n: ReturnType<typeof ids>,
  underLock: InstallOptions["underLock"],
  v2: ArchiveSpec = { models: { "a_v2.ts": n.own("a2") } },
): Promise<InstallResult | undefined> {
  await repo.publish(n.a, V2, v2);
  return await installExtension(
    { name: n.a, version: V2 },
    await repo.ctx(),
    { underLock },
  );
}

Deno.test("PendingInstall: rollback and commit are idempotent and only the first takes effect", async () => {
  await withRepo(async (repo) => {
    const n = ids();
    await installBAndAv1(repo, n);
    const before = await repo.snapshot(n.a);

    const outcomes: unknown[] = [];
    await upgradeWith(repo, n, async (pending) => {
      outcomes.push(await pending.rollback());
      outcomes.push(await pending.rollback());
      await pending.commit();
    });
    const reverted = [{ name: n.a, version: V2, priorVersion: V1 }];
    assertEquals(outcomes, [
      { status: "rolled-back", reverted },
      { status: "rolled-back", reverted },
    ]);
    assertEquals(await repo.snapshot(n.a), before);

    // Commit first: a later rollback moves nothing.
    await upgradeWith(repo, n, async (pending) => {
      await pending.commit();
      await pending.commit();
      outcomes.push(await pending.rollback());
    });
    assertEquals(outcomes[2], {
      status: "kept",
      kept: [{ name: n.a, version: V2, priorVersion: V1 }],
    });
    const after = await repo.snapshot(n.a);
    assertEquals((after.entry as Record<string, unknown>).version, V2);
    assertEquals(Object.keys(after.root ?? {}).sort(), [
      "manifest.yaml",
      "models/a_v2.ts",
    ]);
    assertEquals(await stagingLeft(repo.repoDir), []);
  });
});

Deno.test("installExtension: an install the caller's phase leaves pending is committed, also when it throws", async () => {
  await withRepo(async (repo) => {
    const n = ids();
    await installBAndAv1(repo, n);

    await assertRejects(
      () => upgradeWith(repo, n, () => Promise.reject(new Error("boom"))),
      Error,
      "boom",
    );

    assertEquals((await repo.lockfile())[n.a] !== undefined, true);
    assertEquals(
      Object.keys((await repo.snapshot(n.a)).root ?? {}).sort(),
      ["manifest.yaml", "models/a_v2.ts"],
    );
    assertEquals(await stagingLeft(repo.repoDir), []);
  });
});

Deno.test("installExtension: without a caller phase the install commits and prunes skill orphans, as extension install does", async () => {
  await withRepo(async (repo) => {
    const n = ids();
    const skill = `sk-${crypto.randomUUID().slice(0, 8)}`;
    await installBAndAv1(repo, n, { skills: { [skill]: { "a.md": "a" } } });

    await repo.publish(n.a, V2, { models: { "a_v2.ts": n.own("a2") } });
    const result = await installExtension(
      { name: n.a, version: V2 },
      await repo.ctx(),
    );

    assertEquals(await exists(join(repo.skillsDir, skill)), false);
    const skillRel = relative(repo.repoDir, join(repo.skillsDir, skill));
    assert(
      result?.pruned.includes(skillRel),
      `pruned should report ${skillRel}: ${result?.pruned}`,
    );
    assertEquals(await stagingLeft(repo.repoDir), []);
  });
});

Deno.test("installExtension: a dependency that fails to install leaves the ones before it installed and committed", async () => {
  await withRepo(async (repo) => {
    const n = ids();
    await installBAndAv1(repo, n);

    await repo.publish(n.d, V1, { models: { "d.ts": n.own("d") } });
    await repo.publish(n.e, V1, { models: { "e.ts": n.own("e") } });
    repo.failDownloadOf(n.e);
    await repo.publish(n.a, V2, {
      models: { "a_v2.ts": n.own("a2") },
      dependencies: [n.d, n.e],
    });
    await assertRejects(
      () => repo.install(n.a, V2),
      Error,
      "cannot download",
    );

    // The parent's entry had landed, so it rolls forward; D stays.
    const lockfile = await repo.lockfile();
    assertEquals((lockfile[n.a] as { version: string }).version, V2);
    assertEquals((lockfile[n.d] as { version: string }).version, V1);
    assertEquals(lockfile[n.e], undefined);
    assertEquals(await stagingLeft(repo.repoDir), []);
  });
});

// ===== A lockfile that cannot be restored =====

/** Makes the context's restoreEntries run `fault` instead. */
function faultRestore(
  ctx: InstallContext,
  fault: (restore: () => Promise<void>) => Promise<void>,
) {
  const lockfile = ctx.lockfileRepository;
  const original = lockfile.restoreEntries.bind(lockfile);
  lockfile.restoreEntries = (entries) => fault(() => original(entries));
}

Deno.test("InstallExtensionService.execute: when the lockfile cannot be restored the whole install is kept on the new version (swamp-club#2724)", async () => {
  await withRepo(async (repo) => {
    const n = ids();
    await installBAndAv1(repo, n);

    await repo.publish(n.d, V1, { models: { "d.ts": n.own("d") } });
    await repo.publish(n.a, V2, {
      models: { "a_v2.ts": n.shared },
      dependencies: [n.d],
    });
    const ctx = await repo.ctx();
    faultRestore(ctx, () => Promise.reject(new Error("disk full")));
    const thrown = await assertRejects(
      () => repo.service(ctx).execute({ name: n.a, version: V2 }, ctx),
      DuplicateTypeUserError,
    );

    assertEquals(thrown.rolledBack, false);
    assertEquals(thrown.rollback, {
      status: "kept",
      kept: [
        { name: n.a, version: V2, priorVersion: V1 },
        { name: n.d, version: V1, priorVersion: null },
      ],
    });
    // Files and entries agree on the new version, the dependency included.
    const lockfile = await repo.lockfile();
    assertEquals((lockfile[n.a] as { version: string }).version, V2);
    assertEquals((lockfile[n.d] as { version: string }).version, V1);
    assertEquals(
      Object.keys((await repo.snapshot(n.a)).root ?? {}).sort(),
      ["manifest.yaml", "models/a_v2.ts"],
    );
    assertExists((await repo.snapshot(n.d)).root);
    assertEquals(await stagingLeft(repo.repoDir), []);
  });
});

Deno.test("InstallExtensionService.execute: a restore that throws after its write landed still rolls back", async () => {
  await withRepo(async (repo) => {
    const n = ids();
    await installBAndAv1(repo, n);
    const before = await repo.snapshot(n.a);

    await repo.publish(n.a, V2, { models: { "a_v2.ts": n.shared } });
    const ctx = await repo.ctx();
    faultRestore(ctx, async (restore) => {
      await restore();
      throw new Error("lock close failed");
    });
    const thrown = await assertRejects(
      () => repo.service(ctx).execute({ name: n.a, version: V2 }, ctx),
      DuplicateTypeUserError,
    );

    assertEquals(thrown.rolledBack, true);
    assertEquals(await repo.snapshot(n.a), before);
  });
});

Deno.test("InstallExtensionService.execute: a lockfile that cannot be read back leaves the rollback to the next install", async () => {
  await withRepo(async (repo) => {
    const n = ids();
    await installBAndAv1(repo, n);
    const before = await repo.snapshot(n.a);
    const priorLockfile = await Deno.readTextFile(repo.lockfilePath);

    await repo.publish(n.a, V2, { models: { "a_v2.ts": n.shared } });
    const ctx = await repo.ctx();
    faultRestore(ctx, async () => {
      await Deno.writeTextFile(repo.lockfilePath, "{ not json");
      throw new Error("torn write");
    });
    const thrown = await assertRejects(
      () => repo.service(ctx).execute({ name: n.a, version: V2 }, ctx),
      DuplicateTypeUserError,
    );

    assertEquals(thrown.rollback, {
      status: "unsettled",
      lockfilePath: repo.lockfilePath,
    });
    assertEquals(thrown.rolledBack, false);
    assert((await stagingLeft(repo.repoDir)).length > 0);

    // Once the lockfile is readable again (here, back to v1's entry), the
    // next recovery settles the install from it: back to v1.
    await Deno.writeTextFile(repo.lockfilePath, priorLockfile);
    await recoverPulledExtensionStaging(repo.repoDir, {
      lockfilePaths: [repo.lockfilePath],
    });
    assertEquals(await repo.snapshot(n.a), before);
    assertEquals(await stagingLeft(repo.repoDir), []);
  });
});
