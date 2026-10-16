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

import { assertEquals, assertThrows } from "@std/assert";
import { assertStringIncludes } from "@std/assert/string-includes";
import {
  ConflictError,
  detectConflicts,
  type InstallContext,
  type InstallResult,
  LockfileRepository,
  parseExtensionRef,
  pullExtension,
} from "./extension_pull.ts";
import { ExtensionReplacement } from "../../domain/extensions/extension_replacement.ts";
import {
  getSwampLogger,
  initializeLogging,
} from "../../infrastructure/logging/logger.ts";
import "../../domain/models/models.ts";
import type { UpstreamExtensionEntry } from "../../infrastructure/persistence/upstream_extensions.ts";
import { UserError } from "../../domain/errors.ts";
import { dirname, join } from "@std/path";
import { ensureDir } from "@std/fs";
import { createTarGz } from "../../infrastructure/archive/tar_archive.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";

await initializeLogging({});

Deno.test("parseExtensionRef parses name without version", () => {
  const ref = parseExtensionRef("@myorg/my-ext");
  assertEquals(ref.name, "@myorg/my-ext");
  assertEquals(ref.version, null);
});

Deno.test("parseExtensionRef parses name with version", () => {
  const ref = parseExtensionRef("@myorg/my-ext@2026.02.26.1");
  assertEquals(ref.name, "@myorg/my-ext");
  assertEquals(ref.version, "2026.02.26.1");
});

Deno.test("parseExtensionRef throws on name without @ prefix", () => {
  const error = assertThrows(
    () => parseExtensionRef("invalid-name"),
    UserError,
  );
  assertStringIncludes(error.message, "must start with");
});

Deno.test("parseExtensionRef throws on empty version after @", () => {
  const error = assertThrows(
    () => parseExtensionRef("@myorg/my-ext@"),
    UserError,
  );
  assertStringIncludes(error.message, "Version cannot be empty");
});

Deno.test("LockfileRepository.writeEntry persists files array", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    const files = [
      "extensions/models/foo/bar.yaml",
      "extensions/models/foo/baz.ts",
    ];
    const repo = await LockfileRepository.create(lockfilePath);
    await repo.writeEntry("@test/ext", "1.0.0", files);

    const content = await Deno.readTextFile(lockfilePath);
    const data = JSON.parse(content) as Record<string, UpstreamExtensionEntry>;

    assertEquals(data["@test/ext"].version, "1.0.0");
    assertEquals(data["@test/ext"].files, files);
    assertEquals(typeof data["@test/ext"].pulledAt, "string");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("LockfileRepository.writeEntry preserves existing entries", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    const repoFirst = await LockfileRepository.create(lockfilePath);
    await repoFirst.writeEntry("@test/first", "1.0.0", ["a.yaml"]);
    // Sibling instance simulates a second process; re-reads disk under
    // lock so the merged write picks up the prior entry.
    const repoSecond = await LockfileRepository.create(lockfilePath);
    await repoSecond.writeEntry("@test/second", "2.0.0", ["b.yaml"]);

    const content = await Deno.readTextFile(lockfilePath);
    const data = JSON.parse(content) as Record<string, UpstreamExtensionEntry>;

    assertEquals(data["@test/first"].version, "1.0.0");
    assertEquals(data["@test/first"].files, ["a.yaml"]);
    assertEquals(data["@test/second"].version, "2.0.0");
    assertEquals(data["@test/second"].files, ["b.yaml"]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("LockfileRepository.writeEntry handles empty files array", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    const repo = await LockfileRepository.create(lockfilePath);
    await repo.writeEntry("@test/empty", "1.0.0", []);

    const content = await Deno.readTextFile(lockfilePath);
    const data = JSON.parse(content) as Record<string, UpstreamExtensionEntry>;

    assertEquals(data["@test/empty"].files, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("detectConflicts uses nested path for bundles, not basename", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    // Set up extract dir with a nested bundle: bundles/k8s/netpol.js
    const extractDir = join(tmpDir, "extract");
    const bundleSubdir = join(extractDir, "bundles", "k8s");
    await Deno.mkdir(bundleSubdir, { recursive: true });
    await Deno.writeTextFile(join(bundleSubdir, "netpol.js"), "// bundle");

    // Set up the repo with the same nested bundle already installed
    const repoDir = join(tmpDir, "repo");
    const bundlesDir = join(repoDir, ".swamp", "bundles");
    const nestedBundleDir = join(bundlesDir, "k8s");
    await Deno.mkdir(nestedBundleDir, { recursive: true });
    await Deno.writeTextFile(join(nestedBundleDir, "netpol.js"), "// existing");

    // Also create empty dirs for models and workflows
    const modelsDir = join(repoDir, "extensions", "models");
    const workflowsDir = join(repoDir, "workflows");
    await Deno.mkdir(modelsDir, { recursive: true });
    await Deno.mkdir(workflowsDir, { recursive: true });

    const conflicts = await detectConflicts(
      extractDir,
      modelsDir,
      workflowsDir,
      bundlesDir,
      repoDir,
    );

    // Should detect the conflict at the nested path, not the flat basename
    assertEquals(conflicts, [join(".swamp", "bundles", "k8s", "netpol.js")]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ===== Overwrite prompt (swamp-club#2877) =====

const REPLACEMENT = ExtensionReplacement.create({
  name: "@test/ext",
  current: {
    version: "2026.09.23.1",
    channel: "stable",
    publishedChannel: "stable",
  },
  incoming: {
    version: "2026.10.01.1",
    channel: "stable",
    publishedChannel: "beta",
  },
});
const HEADLINE =
  "@test/ext: installed 2026.09.23.1 (stable) -> incoming 2026.10.01.1 (beta, following stable)";

function stubResult(): InstallResult {
  return {
    name: "@test/ext",
    version: "2026.10.01.1",
    description: undefined,
    extractedFiles: [],
    integrityStatus: "verified",
    repository: undefined,
    platforms: [],
    safetyWarnings: [],
    binaries: [],
    conflicts: [],
    missingSourceFiles: [],
    hasSkills: false,
    hasSkillScripts: false,
    skillFiles: [],
    dependencies: [],
    dependencyResults: [],
    extendsTypes: [],
    pruned: [],
    createdPaths: [],
  };
}

/**
 * Runs pullExtension against an install that conflicts unless forced and,
 * when forced, reports the replacement and an unopted pre-release as the
 * real install does. Returns the console output and the prompt asked.
 */
async function pullWithConflict(answer: boolean): Promise<{
  out: string;
  installs: boolean[];
  asked: { question: string; details: string[] }[];
}> {
  const dir = await Deno.makeTempDir({ prefix: "swamp_pull_prompt_" });
  const installs: boolean[] = [];
  const asked: { question: string; details: string[] }[] = [];
  const lines: string[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn };
  const capture = (...args: unknown[]) =>
    lines.push(args.map(String).join(" "));
  console.log = capture;
  console.info = capture;
  console.warn = capture;
  try {
    await pullExtension({ name: "@test/ext", version: null }, {
      getExtension: () => Promise.resolve(null),
      downloadArchive: () => Promise.reject(new Error("unused")),
      getChecksum: () => Promise.resolve(null),
      logger: getSwampLogger(["extension", "pull"]),
      lockfileRepository: await LockfileRepository.create(
        join(dir, "upstream_extensions.json"),
      ),
      skillsDirs: [],
      repoDir: dir,
      force: false,
      outputMode: "log",
      alreadyPulled: new Set(),
      depth: 0,
      confirm: (question, details) => {
        asked.push({ question, details });
        return Promise.resolve(answer);
      },
      installExtensionFn: (_ref, c: InstallContext) => {
        installs.push(c.force);
        if (!c.force) {
          return Promise.reject(
            new ConflictError(["a.ts"], [], REPLACEMENT),
          );
        }
        c.onReplacing?.(REPLACEMENT);
        c.onUnoptedPrerelease?.({
          name: "@test/ext",
          version: "2026.10.01.1",
          publishedChannel: "beta",
          parent: null,
        });
        return Promise.resolve(stubResult());
      },
    });
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
  return { out: lines.join("\n"), installs, asked };
}

Deno.test("pullExtension: the overwrite prompt states the replacement once, then what y and N do", async () => {
  const { out, installs, asked } = await pullWithConflict(true);
  assertEquals(installs, [false, true]);
  assertEquals(out.split(HEADLINE).length - 1, 1);
  assertEquals(asked, [{
    question: "Overwrite existing files?",
    details: [
      "  y = replace 2026.09.23.1 (stable) with 2026.10.01.1 (beta)",
      "  N = exit; nothing is changed",
    ],
  }]);
  assertStringIncludes(
    out,
    "@test/ext@2026.10.01.1 is a beta release, and --channel was not passed",
  );
});

Deno.test("pullExtension: answering N cancels without installing", async () => {
  const { out, installs } = await pullWithConflict(false);
  assertEquals(installs, [false]);
  assertStringIncludes(out, HEADLINE);
  assertStringIncludes(out, "Pull cancelled.");
});

Deno.test("pullExtension: a dependency's conflict states each replacement once across the retry", async () => {
  const depReplacement = ExtensionReplacement.create({
    name: "@test/dep",
    current: null,
    incoming: {
      version: "2026.10.01.1",
      channel: "stable",
      publishedChannel: "stable",
    },
  });
  const dir = await Deno.makeTempDir({ prefix: "swamp_pull_prompt_" });
  const lines: string[] = [];
  const original = { log: console.log, info: console.info, warn: console.warn };
  const capture = (...args: unknown[]) =>
    lines.push(args.map(String).join(" "));
  console.log = capture;
  console.info = capture;
  console.warn = capture;
  try {
    await pullExtension({ name: "@test/ext", version: null }, {
      getExtension: () => Promise.resolve(null),
      downloadArchive: () => Promise.reject(new Error("unused")),
      getChecksum: () => Promise.resolve(null),
      logger: getSwampLogger(["extension", "pull"]),
      lockfileRepository: await LockfileRepository.create(
        join(dir, "upstream_extensions.json"),
      ),
      skillsDirs: [],
      repoDir: dir,
      force: false,
      outputMode: "log",
      alreadyPulled: new Set(),
      depth: 0,
      confirm: () => Promise.resolve(true),
      // The parent goes ahead, then its dependency conflicts; the retry
      // reaches both again.
      installExtensionFn: (_ref, c: InstallContext) => {
        c.onReplacing?.(REPLACEMENT);
        c.onUnoptedPrerelease?.({
          name: "@test/ext",
          version: "2026.10.01.1",
          publishedChannel: "beta",
          parent: null,
        });
        if (!c.force) {
          return Promise.reject(
            new ConflictError(["d.ts"], [], depReplacement),
          );
        }
        c.onReplacing?.(depReplacement);
        return Promise.resolve(stubResult());
      },
    });
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
  const out = lines.join("\n");
  assertEquals(out.split(HEADLINE).length - 1, 1);
  assertEquals(out.split("@test/dep: installed unknown").length - 1, 1);
  assertEquals(out.split("is a beta release").length - 1, 1);
});

Deno.test("pullExtension: the forced retry after a dependency's conflict starts from the extensions marked before the pull (swamp-club#3313)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_pull_retry_" });
  const retrySeen: string[][] = [];
  try {
    await pullExtension({ name: "@test/ext", version: null }, {
      getExtension: () => Promise.resolve(null),
      downloadArchive: () => Promise.reject(new Error("unused")),
      getChecksum: () => Promise.resolve(null),
      logger: getSwampLogger(["extension", "pull"]),
      lockfileRepository: await LockfileRepository.create(
        join(dir, "upstream_extensions.json"),
      ),
      skillsDirs: [],
      repoDir: dir,
      force: false,
      outputMode: "log",
      alreadyPulled: new Set(["@test/before"]),
      depth: 0,
      confirm: () => Promise.resolve(true),
      // The parent and its dependency are both reached before the
      // dependency's files conflict.
      installExtensionFn: (_ref, c: InstallContext) => {
        if (!c.force) {
          c.alreadyPulled.add("@test/ext");
          c.alreadyPulled.add("@test/dep");
          return Promise.reject(new ConflictError(["d.ts"], []));
        }
        retrySeen.push([...c.alreadyPulled].sort());
        return Promise.resolve(stubResult());
      },
    });
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
  assertEquals(retrySeen, [["@test/before"]]);
});

const PULL_VERSION = "2026.01.01.1";

// The zod swamp provides to extensions, so no npm download is needed.
function modelSource(typeId: string): string {
  return `// deno-lint-ignore no-explicit-any
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
}

/** An extension archive shipping one model file, as the registry serves it. */
async function buildArchive(
  name: string,
  modelFile: string,
  typeId: string,
  dependencies: string[],
): Promise<Uint8Array> {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_pull_arc_" });
  try {
    const extDir = join(tmp, "extension");
    await ensureDir(join(extDir, "models"));
    const lines = [
      "manifestVersion: 1",
      `name: "${name}"`,
      `version: "${PULL_VERSION}"`,
      "models:",
      `  - ${modelFile}`,
    ];
    if (dependencies.length > 0) {
      lines.push("dependencies:", ...dependencies.map((d) => `  - "${d}"`));
    }
    await Deno.writeTextFile(join(extDir, "manifest.yaml"), lines.join("\n"));
    await Deno.writeTextFile(
      join(extDir, "models", modelFile),
      modelSource(typeId),
    );
    await createTarGz(extDir, join(tmp, "a.tar.gz"));
    return await Deno.readFile(join(tmp, "a.tar.gz"));
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

Deno.test("pullExtension: answering y to a dependency's conflict installs the dependency over its files (swamp-club#3313)", async () => {
  const id = crypto.randomUUID().slice(0, 8);
  const parent = `@t/p-${id}`;
  const dep = `@t/d-${id}`;
  const archives = new Map([
    [parent, await buildArchive(parent, "p.ts", `@t/own-p-${id}`, [dep])],
    [dep, await buildArchive(dep, "d.ts", `@t/own-d-${id}`, [])],
  ]);
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_pull_dep_" });
  const lockfilePath = join(
    repoDir,
    "extensions",
    "models",
    "upstream_extensions.json",
  );
  await ensureDir(join(repoDir, "extensions", "models"));
  await Deno.writeTextFile(lockfilePath, "{}");
  // The dependency's files are on disk with no lockfile entry.
  const depFile = join(
    repoDir,
    ".swamp",
    "pulled-extensions",
    dep,
    "models",
    "d.ts",
  );
  await ensureDir(dirname(depFile));
  await Deno.writeTextFile(depFile, "local\n");
  const catalog = new ExtensionCatalogStore(
    join(repoDir, ".swamp", "_extension_catalog.db"),
  );
  let asked = 0;
  try {
    const lockfileRepository = await LockfileRepository.create(lockfilePath);
    await pullExtension({ name: parent, version: null }, {
      getExtension: (name) =>
        Promise.resolve({
          name,
          description: "",
          latestVersion: PULL_VERSION,
        }),
      downloadArchive: (name) => {
        const archive = archives.get(name);
        return archive
          ? Promise.resolve(archive)
          : Promise.reject(new Error(`cannot download ${name}`));
      },
      getChecksum: () => Promise.resolve(null),
      logger: getSwampLogger(["extension", "pull"]),
      lockfileRepository,
      skillsDirs: [],
      repoDir,
      force: false,
      outputMode: "log",
      alreadyPulled: new Set(),
      depth: 0,
      denoRuntime: {
        ensureDeno: () => Promise.resolve(Deno.execPath()),
        getDenoEnv: () => Deno.env.toObject(),
      },
      repository: new ExtensionRepository({
        catalog,
        lockfileRepository,
        repoRoot: repoDir,
      }),
      confirm: () => {
        asked++;
        return Promise.resolve(true);
      },
    });

    assertEquals(asked, 1);
    const lockfile = JSON.parse(await Deno.readTextFile(lockfilePath));
    assertEquals(lockfile[parent]?.version, PULL_VERSION);
    assertEquals(lockfile[dep]?.version, PULL_VERSION);
    assertEquals(
      await Deno.readTextFile(depFile),
      modelSource(`@t/own-d-${id}`),
    );
  } finally {
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
});
