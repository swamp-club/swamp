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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { assertStringIncludes } from "@std/assert/string-includes";
import { ensureDir, walk } from "@std/fs";
import { dirname, join, relative } from "@std/path";
import { createTarGz } from "../../infrastructure/archive/tar_archive.ts";
import {
  applyInstall,
  computeOrphanDiff,
  ConflictError,
  extensionPull,
  type ExtensionPullDeps,
  type ExtensionPullEvent,
  type ExtensionRef,
  type ExtensionRegistryInfo,
  type InstallContext,
  installExtension,
  type InstallResult,
  isVersionConstraint,
  parseExtensionRef,
  type PreparedInstall,
  prepareInstall,
  validateExtensionName,
} from "./pull.ts";
import { createLibSwampContext } from "../context.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { PulledExtensionsLock } from "../../infrastructure/persistence/pulled_extensions_lock.ts";
import { UserError } from "../../domain/errors.ts";
import { computeChecksum } from "../../domain/models/checksum.ts";
import { MAX_EXTENSION_ARCHIVE_BYTES } from "../../domain/extensions/extension_archive_limits.ts";
import { extensionInstallRoots } from "../../infrastructure/persistence/paths.ts";
import { readInstalledExtensionDigest } from "../../infrastructure/persistence/installed_extension_digest_reader.ts";

Deno.test("parseExtensionRef: parses name without version", () => {
  const ref = parseExtensionRef("@myorg/my-ext");
  assertEquals(ref.name, "@myorg/my-ext");
  assertEquals(ref.version, null);
});

Deno.test("parseExtensionRef: parses name with version", () => {
  const ref = parseExtensionRef("@myorg/my-ext@2026.02.26.1");
  assertEquals(ref.name, "@myorg/my-ext");
  assertEquals(ref.version, "2026.02.26.1");
});

Deno.test("parseExtensionRef: throws on missing @ prefix", () => {
  assertThrows(
    () => parseExtensionRef("myorg/my-ext"),
    UserError,
    'must start with "@"',
  );
});

Deno.test("parseExtensionRef: throws on empty version", () => {
  assertThrows(
    () => parseExtensionRef("@myorg/my-ext@"),
    UserError,
    "Version cannot be empty",
  );
});

Deno.test("parseExtensionRef: parses nested segments", () => {
  const ref = parseExtensionRef("@myorg/my-ext/sub");
  assertEquals(ref.name, "@myorg/my-ext/sub");
  assertEquals(ref.version, null);
});

Deno.test("validateExtensionName: accepts valid names", () => {
  validateExtensionName("@myorg/my-ext");
  validateExtensionName("@my_org/my_ext");
  validateExtensionName("@myorg/my-ext/sub");
});

Deno.test("validateExtensionName: rejects invalid names", () => {
  assertThrows(
    () => validateExtensionName("myorg/my-ext"),
    UserError,
    "Must match",
  );
  assertThrows(
    () => validateExtensionName("@MyOrg/My-Ext"),
    UserError,
    "Must match",
  );
});

Deno.test("LockfileRepository.writeEntry: writes and updates entries", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    const repo = await LockfileRepository.create(lockfilePath);
    await repo.writeEntry("@test/first", "1.0.0", ["a.yaml"]);

    const content = await Deno.readTextFile(lockfilePath);
    const data = JSON.parse(content);
    assertEquals(data["@test/first"].version, "1.0.0");
    assertEquals(data["@test/first"].files, ["a.yaml"]);
    assertStringIncludes(data["@test/first"].pulledAt, "20");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("computeOrphanDiff: empty inputs yield empty diff", () => {
  assertEquals(computeOrphanDiff([], []), []);
  assertEquals(computeOrphanDiff(["a.ts"], []), ["a.ts"]);
  assertEquals(computeOrphanDiff([], ["a.ts"]), []);
});

Deno.test("computeOrphanDiff: identical sets yield no orphans", () => {
  const files = [
    ".swamp/pulled-extensions/@x/y/models/a.ts",
    ".swamp/bundles/abc/a.js",
  ];
  assertEquals(computeOrphanDiff(files, files), []);
});

Deno.test(
  "computeOrphanDiff: paths in old but NOT new are orphans",
  () => {
    // The canonical case from issue 202: v1 had two files, v2 declares
    // only one, so the dropped one is the orphan.
    const oldFiles = [
      ".swamp/pulled-extensions/@hivemq/harvester/kubeconfig/models/harvester/kubeconfig.ts",
      ".swamp/pulled-extensions/@hivemq/harvester/kubeconfig/models/harvester/fetch_kubeconfig.ts",
      ".swamp/bundles/738c72f8/harvester/kubeconfig.js",
      ".swamp/bundles/738c72f8/harvester/fetch_kubeconfig.js",
    ];
    const extractedFiles = [
      ".swamp/pulled-extensions/@hivemq/harvester/kubeconfig/models/harvester/kubeconfig.ts",
      ".swamp/bundles/738c72f8/harvester/kubeconfig.js",
    ];
    const orphans = computeOrphanDiff(oldFiles, extractedFiles);
    assertEquals(orphans.length, 2);
    assertEquals(
      orphans.includes(
        ".swamp/pulled-extensions/@hivemq/harvester/kubeconfig/models/harvester/fetch_kubeconfig.ts",
      ),
      true,
    );
    assertEquals(
      orphans.includes(".swamp/bundles/738c72f8/harvester/fetch_kubeconfig.js"),
      true,
    );
  },
);

Deno.test(
  "computeOrphanDiff: all files dropped — every old path is an orphan",
  () => {
    const oldFiles = ["a.ts", "b.ts", "c.ts"];
    const extractedFiles = ["x.ts"];
    assertEquals(computeOrphanDiff(oldFiles, extractedFiles), [
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
  },
);

Deno.test(
  "computeOrphanDiff: order of returned orphans matches old-list order",
  () => {
    // Stability: if two callers compute the same diff, they get the
    // same list. Important for deterministic event output.
    const oldFiles = ["c.ts", "a.ts", "b.ts"];
    const extractedFiles = ["a.ts"];
    assertEquals(computeOrphanDiff(oldFiles, extractedFiles), ["c.ts", "b.ts"]);
  },
);

Deno.test(
  "computeOrphanDiff: skill recorded per file, now as its root, is not an orphan",
  () => {
    const oldFiles = [".claude/skills/foo/SKILL.md"];
    const extractedFiles = [".claude/skills/foo"];
    assertEquals(computeOrphanDiff(oldFiles, extractedFiles), []);
  },
);

Deno.test(
  "computeOrphanDiff: skill recorded as its root, now per file, is not an orphan",
  () => {
    const oldFiles = [".claude/skills/foo"];
    const extractedFiles = [".claude/skills/foo/SKILL.md"];
    assertEquals(computeOrphanDiff(oldFiles, extractedFiles), []);
  },
);

Deno.test(
  "computeOrphanDiff: a case-only rename leaves the old path an orphan",
  () => {
    const oldFiles = [".swamp/pulled-extensions/@x/y/models/MyModel.ts"];
    const extractedFiles = [".swamp/pulled-extensions/@x/y/models/myModel.ts"];
    assertEquals(computeOrphanDiff(oldFiles, extractedFiles), oldFiles);
  },
);

Deno.test(
  "computeOrphanDiff: a dropped skill root is still an orphan",
  () => {
    const oldFiles = [".claude/skills/foo", ".claude/skills/bar"];
    const extractedFiles = [".claude/skills/bar"];
    assertEquals(computeOrphanDiff(oldFiles, extractedFiles), [
      ".claude/skills/foo",
    ]);
  },
);

// ===== Pin 2 (W2) =====
//
// `extensionPull` is one of the 5 KEEP callsites — its
// {@link ExtensionPullEvent} stream API is consumed directly by
// renderers in `presentation/renderers/extension_pull.ts`. Plan v4
// asserts that W2's internal refactor (pull.ts → InstallExtensionService)
// preserves this stream byte-identically. The architecture-agent's Pin 2
// review demanded a regression test that locks in the current shape so
// the W2 refactor cannot quietly leak through the event payload.
//
// This test captures the pre-W2 event sequence + structural shape. As
// commits 2b/2c land (service refactor + phase 8), the test must keep
// passing — that's the proof of byte-identicality.

function makeStubInstallResult(
  ref: ExtensionRef,
  pruned: string[] = [],
): InstallResult {
  return {
    name: ref.name,
    version: ref.version ?? "1.0.0",
    description: undefined,
    extractedFiles: [`.swamp/pulled-extensions/${ref.name}/models/main.ts`],
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
    pruned,
    shadowedTypes: [],
    createdPaths: [`.swamp/pulled-extensions/${ref.name}/models/main.ts`],
  };
}

async function makeStubDeps(
  installFn: (
    ref: ExtensionRef,
    ctx: InstallContext,
  ) => Promise<InstallResult | undefined>,
): Promise<ExtensionPullDeps> {
  const tmpDir = await Deno.makeTempDir({
    prefix: "swamp_pull_pin2_test_",
  });
  return {
    getExtension: () =>
      Promise.resolve({
        name: "@stub/ext",
        description: "stub",
        latestVersion: "1.0.0",
      }),
    downloadArchive: () => Promise.reject(new Error("stubbed")),
    getChecksum: () => Promise.resolve(null),
    lockfileRepository: await LockfileRepository.create(
      join(tmpDir, "upstream_extensions.json"),
    ),
    skillsDirs: [join(tmpDir, "skills")],
    repoDir: tmpDir,
    alreadyPulled: new Set(),
    depth: 0,
    installExtensionFn: installFn,
  };
}

async function collectEvents(
  gen: AsyncIterable<ExtensionPullEvent>,
): Promise<ExtensionPullEvent[]> {
  const events: ExtensionPullEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

Deno.test(
  "extensionPull: emits installing → completed for a successful install (Pin 2 baseline)",
  async () => {
    const ref: ExtensionRef = { name: "@stub/ext", version: "1.0.0" };
    const deps = await makeStubDeps(() =>
      Promise.resolve(makeStubInstallResult(ref))
    );

    const events = await collectEvents(
      extensionPull(createLibSwampContext(), deps, { ref, force: false }),
    );

    // Lock in the exact event-kind sequence consumed by renderers.
    assertEquals(events.length, 2);
    assertEquals(events[0].kind, "installing");
    assertEquals(events[1].kind, "completed");

    // Lock in the structural shape of the completed event's payload.
    if (events[1].kind === "completed") {
      assertEquals(events[1].data.name, "@stub/ext");
      assertEquals(events[1].data.version, "1.0.0");
      assertEquals(events[1].data.integrityStatus, "verified");
      assertEquals(events[1].data.pruned, []);
    }

    await Deno.remove(deps.repoDir, { recursive: true });
  },
);

Deno.test(
  "extensionPull: emits installing → orphans-pruned → completed when prior version files are pruned (Pin 2 baseline)",
  async () => {
    const ref: ExtensionRef = { name: "@stub/ext", version: "2.0.0" };
    const prunedPaths = [
      ".swamp/pulled-extensions/@stub/ext/models/old.ts",
    ];
    const deps = await makeStubDeps(() =>
      Promise.resolve(makeStubInstallResult(ref, prunedPaths))
    );

    const events = await collectEvents(
      extensionPull(createLibSwampContext(), deps, { ref, force: false }),
    );

    assertEquals(events.length, 3);
    assertEquals(events[0].kind, "installing");
    assertEquals(events[1].kind, "orphans-pruned");
    assertEquals(events[2].kind, "completed");

    if (events[1].kind === "orphans-pruned") {
      assertEquals(events[1].name, "@stub/ext");
      assertEquals(events[1].version, "2.0.0");
      assertEquals(events[1].paths, prunedPaths);
    }

    await Deno.remove(deps.repoDir, { recursive: true });
  },
);

Deno.test(
  "extensionPull: emits only installing when install short-circuits (alreadyPulled)",
  async () => {
    // The real installExtension returns undefined when ref.name is in
    // alreadyPulled. The generator must NOT yield orphans-pruned or
    // completed in that case — only `installing`.
    const ref: ExtensionRef = { name: "@stub/already-pulled", version: null };
    const deps = await makeStubDeps(() => Promise.resolve(undefined));

    const events = await collectEvents(
      extensionPull(createLibSwampContext(), deps, { ref, force: false }),
    );

    assertEquals(events.length, 1);
    assertEquals(events[0].kind, "installing");

    await Deno.remove(deps.repoDir, { recursive: true });
  },
);

Deno.test(
  "extensionPull: emits deprecated_warning when extension is deprecated",
  async () => {
    const ref: ExtensionRef = { name: "@stub/ext", version: "1.0.0" };
    const deps = await makeStubDeps(() =>
      Promise.resolve(makeStubInstallResult(ref))
    );
    deps.getExtension = () =>
      Promise.resolve({
        name: "@stub/ext",
        description: "stub",
        latestVersion: "1.0.0",
        deprecatedAt: "2026-01-01T00:00:00Z",
        deprecationReason: "Merged into collective",
        supersededBy: "@collective/ext",
      });

    const events = await collectEvents(
      extensionPull(createLibSwampContext(), deps, { ref, force: false }),
    );

    assertEquals(events.length, 3);
    assertEquals(events[0].kind, "installing");
    assertEquals(events[1].kind, "deprecated_warning");
    assertEquals(events[2].kind, "completed");

    if (events[1].kind === "deprecated_warning") {
      assertEquals(events[1].name, "@stub/ext");
      assertEquals(events[1].reason, "Merged into collective");
      assertEquals(events[1].supersededBy, "@collective/ext");
    }

    await Deno.remove(deps.repoDir, { recursive: true }).catch(() => {});
  },
);

// ===== isVersionConstraint =====

Deno.test("isVersionConstraint: detects >= prefix", () => {
  assertEquals(isVersionConstraint(">=2026.04.24"), true);
});

Deno.test("isVersionConstraint: detects ^ prefix", () => {
  assertEquals(isVersionConstraint("^1.0.0"), true);
});

Deno.test("isVersionConstraint: detects ~ prefix", () => {
  assertEquals(isVersionConstraint("~1.0.0"), true);
});

Deno.test("isVersionConstraint: detects > prefix", () => {
  assertEquals(isVersionConstraint(">1.0.0"), true);
});

Deno.test("isVersionConstraint: detects < prefix", () => {
  assertEquals(isVersionConstraint("<2.0.0"), true);
});

Deno.test("isVersionConstraint: detects <= prefix", () => {
  assertEquals(isVersionConstraint("<=2.0.0"), true);
});

Deno.test("isVersionConstraint: detects = prefix", () => {
  assertEquals(isVersionConstraint("=1.0.0"), true);
});

Deno.test("isVersionConstraint: returns false for exact version", () => {
  assertEquals(isVersionConstraint("2026.04.24.1782575578"), false);
});

Deno.test("isVersionConstraint: returns false for simple semver", () => {
  assertEquals(isVersionConstraint("1.0.0"), false);
});

// ===== Dependency version constraint resolution (swamp-club#866) =====

Deno.test(
  "dependency version constraint resolution: constraint stripped, name used for lookup",
  () => {
    // Verifies the logic applied in installExtension's dependency loop:
    // 1. Parse the dep string to extract name (for lookups) and version
    // 2. Detect version constraints and null them out so installExtension
    //    resolves to extInfo.latestVersion
    const depRef = parseExtensionRef("@bixu/launchd@>=2026.04.24");
    assertEquals(depRef.name, "@bixu/launchd");
    assertEquals(depRef.version, ">=2026.04.24");
    assertEquals(isVersionConstraint(depRef.version!), true);

    const resolvedRef: ExtensionRef = {
      name: depRef.name,
      version: isVersionConstraint(depRef.version!) ? null : depRef.version,
    };
    assertEquals(resolvedRef.name, "@bixu/launchd");
    assertEquals(resolvedRef.version, null);

    // Exact versions pass through unchanged
    const exactRef = parseExtensionRef("@hivemq/asdlc@2026.06.27.1782598415");
    assertEquals(isVersionConstraint(exactRef.version!), false);
    const resolvedExact: ExtensionRef = {
      name: exactRef.name,
      version: isVersionConstraint(exactRef.version!) ? null : exactRef.version,
    };
    assertEquals(resolvedExact.version, "2026.06.27.1782598415");
  },
);

Deno.test(
  "parseExtensionRef: parses dependency with version constraint",
  () => {
    const ref = parseExtensionRef("@hivemq/asdlc@>=2026.06.27.1782598415");
    assertEquals(ref.name, "@hivemq/asdlc");
    assertEquals(ref.version, ">=2026.06.27.1782598415");
  },
);

Deno.test(
  "parseExtensionRef: parses dependency with caret constraint",
  () => {
    const ref = parseExtensionRef("@swamp/factory@^2026.06.16.1");
    assertEquals(ref.name, "@swamp/factory");
    assertEquals(ref.version, "^2026.06.16.1");
  },
);

Deno.test(
  "installExtension: actionable error when latestVersion is null but rc exists",
  async () => {
    const tmpDir = await Deno.makeTempDir({
      prefix: "swamp_pull_nostable_test_",
    });
    try {
      const extInfo: ExtensionRegistryInfo = {
        name: "@shrug/mercury",
        description: "Mercury",
        latestVersion: null,
        latestRc: "2026.07.19.1",
        latestBeta: "2026.07.18.3",
      };
      const ctx: InstallContext = {
        getExtension: () => Promise.resolve(extInfo),
        downloadArchive: () => Promise.reject(new Error("should not download")),
        getChecksum: () => Promise.resolve(null),
        lockfileRepository: await LockfileRepository.create(
          join(tmpDir, "upstream_extensions.json"),
        ),
        skillsDirs: [join(tmpDir, "skills")],
        repoDir: tmpDir,
        alreadyPulled: new Set(),
        depth: 0,
        force: false,
      };
      const ref: ExtensionRef = { name: "@shrug/mercury", version: null };
      const error = await assertRejects(
        () => installExtension(ref, ctx),
        UserError,
      );
      assertStringIncludes(error.message, "has no stable version");
      assertStringIncludes(error.message, "--channel rc");
    } finally {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "installExtension: actionable error mentions only beta when rc is absent",
  async () => {
    const tmpDir = await Deno.makeTempDir({
      prefix: "swamp_pull_nostable2_test_",
    });
    try {
      const extInfo: ExtensionRegistryInfo = {
        name: "@shrug/mercury",
        description: "Mercury",
        latestVersion: null,
        latestRc: null,
        latestBeta: "2026.07.18.3",
      };
      const ctx: InstallContext = {
        getExtension: () => Promise.resolve(extInfo),
        downloadArchive: () => Promise.reject(new Error("should not download")),
        getChecksum: () => Promise.resolve(null),
        lockfileRepository: await LockfileRepository.create(
          join(tmpDir, "upstream_extensions.json"),
        ),
        skillsDirs: [join(tmpDir, "skills")],
        repoDir: tmpDir,
        alreadyPulled: new Set(),
        depth: 0,
        force: false,
      };
      const ref: ExtensionRef = { name: "@shrug/mercury", version: null };
      const error = await assertRejects(
        () => installExtension(ref, ctx),
        UserError,
      );
      assertStringIncludes(error.message, "has no stable version");
      assertStringIncludes(error.message, "--channel beta");
    } finally {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
  },
);

// ===== Skill ownership (swamp-club#2494) =====
//
// Skills land in shared tool dirs, so a same-named dir may belong to the
// user or another extension. These tests drive installExtension against
// real archives to pin what it records, what it may roll back, and when
// it raises a conflict.

const SKILL_VERSION = "2026.01.01.1";

interface SkillArchiveSpec {
  name: string;
  skills: Record<string, Record<string, string>>;
  dependencies?: string[];
  /** Extra files keyed by path under the extension root, e.g. `models/a.ts`. */
  files?: Record<string, string>;
  /** Leaves manifest.yaml out of the archive. */
  omitManifest?: boolean;
}

/** Builds an extension archive that ships only skills. */
async function buildSkillArchive(spec: SkillArchiveSpec): Promise<Uint8Array> {
  const tmp = await Deno.makeTempDir({ prefix: "swamp_skill_archive_" });
  try {
    const extDir = join(tmp, "extension");
    const lines = [
      "manifestVersion: 1",
      `name: "${spec.name}"`,
      `version: "${SKILL_VERSION}"`,
      Object.keys(spec.skills).length > 0 ? "skills:" : "skills: []",
      ...Object.keys(spec.skills).map((s) => `  - ${s}`),
    ];
    if (spec.dependencies && spec.dependencies.length > 0) {
      lines.push("dependencies:");
      lines.push(...spec.dependencies.map((d) => `  - "${d}"`));
    }
    await ensureDir(extDir);
    if (!spec.omitManifest) {
      await Deno.writeTextFile(
        join(extDir, "manifest.yaml"),
        lines.join("\n"),
      );
    }
    for (const [file, content] of Object.entries(spec.files ?? {})) {
      await ensureDir(dirname(join(extDir, file)));
      await Deno.writeTextFile(join(extDir, file), content);
    }
    for (const [skill, files] of Object.entries(spec.skills)) {
      for (const [file, content] of Object.entries(files)) {
        await ensureDir(join(extDir, "skills", skill));
        await Deno.writeTextFile(join(extDir, "skills", skill, file), content);
      }
    }
    const archivePath = join(tmp, "extension.tar.gz");
    await createTarGz(extDir, archivePath);
    return await Deno.readFile(archivePath);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

async function withSkillRepo(
  fn: (repoDir: string, lockfile: LockfileRepository) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_pull_skills_" });
  try {
    const lockfile = await LockfileRepository.create(
      join(repoDir, "upstream_extensions.json"),
    );
    await fn(repoDir, lockfile);
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
}

function skillInstallContext(
  repoDir: string,
  lockfile: LockfileRepository,
  archives: Record<string, Uint8Array>,
  opts: { force?: boolean; skillsDirs?: string[] } = {},
): InstallContext {
  return {
    getExtension: (name) =>
      Promise.resolve(
        archives[name]
          ? { name, description: "", latestVersion: SKILL_VERSION }
          : null,
      ),
    downloadArchive: (name) => Promise.resolve(archives[name]),
    getChecksum: () => Promise.resolve(null),
    lockfileRepository: lockfile,
    skillsDirs: opts.skillsDirs ?? [join(repoDir, ".claude", "skills")],
    repoDir,
    alreadyPulled: new Set(),
    depth: 0,
    force: opts.force ?? false,
  };
}

function uniqueExtName(): string {
  return `@t/skill-${crypto.randomUUID().slice(0, 8)}`;
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

Deno.test(
  "installExtension: a fresh skill dir is recorded and created as its root",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const name = uniqueExtName();
      const archive = await buildSkillArchive({
        name,
        skills: { foo: { "SKILL.md": "from ext" } },
      });
      const result = await installExtension(
        { name, version: null },
        skillInstallContext(repoDir, lockfile, { [name]: archive }),
      );
      const root = relative(repoDir, join(repoDir, ".claude", "skills", "foo"));
      assertEquals(result?.extractedFiles.includes(root), true);
      assertEquals(result?.createdPaths.includes(root), true);
      assertEquals(lockfile.getEntry(name)?.files?.includes(root), true);
    });
  },
);

Deno.test(
  "installExtension: an existing skill dir the extension does not own raises ConflictError",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const name = uniqueExtName();
      const userSkill = join(repoDir, ".claude", "skills", "foo");
      await ensureDir(userSkill);
      await Deno.writeTextFile(join(userSkill, "notes.md"), "mine");
      const archive = await buildSkillArchive({
        name,
        skills: { foo: { "SKILL.md": "from ext" } },
      });
      const error = await assertRejects(
        () =>
          installExtension(
            { name, version: null },
            skillInstallContext(repoDir, lockfile, { [name]: archive }),
          ),
        ConflictError,
      );
      assertEquals(error.conflicts, [relative(repoDir, userSkill)]);
      assertEquals(error.skillDirs, [relative(repoDir, userSkill)]);
      assertStringIncludes(error.message, "other files kept");
      assertEquals(
        await Deno.readTextFile(join(userSkill, "notes.md")),
        "mine",
      );
      assertEquals(await exists(join(userSkill, "SKILL.md")), false);
    });
  },
);

Deno.test(
  "installExtension: merging into a user's skill dir under force records files, not the root",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const name = uniqueExtName();
      const userSkill = join(repoDir, ".claude", "skills", "foo");
      await ensureDir(userSkill);
      await Deno.writeTextFile(join(userSkill, "notes.md"), "mine");
      await Deno.writeTextFile(join(userSkill, "README.md"), "user readme");
      const archive = await buildSkillArchive({
        name,
        skills: { foo: { "SKILL.md": "from ext", "README.md": "ext readme" } },
      });
      const result = await installExtension(
        { name, version: null },
        skillInstallContext(repoDir, lockfile, { [name]: archive }, {
          force: true,
        }),
      );
      const root = relative(repoDir, userSkill);
      const skillMd = relative(repoDir, join(userSkill, "SKILL.md"));
      const readme = relative(repoDir, join(userSkill, "README.md"));
      const files = lockfile.getEntry(name)?.files ?? [];
      assertEquals(files.includes(root), false);
      assertEquals(files.includes(skillMd), true);
      assertEquals(files.includes(readme), true);
      // Only the file that did not exist before may be rolled back.
      assertEquals(result?.createdPaths.includes(skillMd), true);
      assertEquals(result?.createdPaths.includes(readme), false);
      assertEquals(result?.createdPaths.includes(root), false);
    });
  },
);

Deno.test(
  "installExtension: re-installing the extension's own skill raises no conflict",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const name = uniqueExtName();
      const archive = await buildSkillArchive({
        name,
        skills: { foo: { "SKILL.md": "from ext" } },
      });
      await installExtension(
        { name, version: null },
        skillInstallContext(repoDir, lockfile, { [name]: archive }),
      );
      const result = await installExtension(
        { name, version: null },
        skillInstallContext(repoDir, lockfile, { [name]: archive }),
      );
      const root = relative(repoDir, join(repoDir, ".claude", "skills", "foo"));
      // Still owned as the root, but nothing new to roll back.
      assertEquals(lockfile.getEntry(name)?.files?.includes(root), true);
      assertEquals(result?.createdPaths.includes(root), false);
    });
  },
);

Deno.test(
  "installExtension: ownership recorded per file with backslashes still counts",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const name = uniqueExtName();
      const skillDir = join(repoDir, ".claude", "skills", "foo");
      await ensureDir(skillDir);
      await Deno.writeTextFile(join(skillDir, "SKILL.md"), "old");
      await lockfile.writeEntry(name, "2025.01.01.1", [
        ".claude\\skills\\foo\\SKILL.md",
      ]);
      const archive = await buildSkillArchive({
        name,
        skills: { foo: { "SKILL.md": "new" } },
      });
      await installExtension(
        { name, version: null },
        skillInstallContext(repoDir, lockfile, { [name]: archive }),
      );
      assertEquals(await Deno.readTextFile(join(skillDir, "SKILL.md")), "new");
    });
  },
);

Deno.test(
  "installExtension: two tool dirs record the fresh one as a root and the merged one per file",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const name = uniqueExtName();
      const claudeSkill = join(repoDir, ".claude", "skills", "foo");
      const kiroSkill = join(repoDir, ".kiro", "skills", "foo");
      await ensureDir(claudeSkill);
      await Deno.writeTextFile(join(claudeSkill, "notes.md"), "mine");
      const archive = await buildSkillArchive({
        name,
        skills: { foo: { "SKILL.md": "from ext" } },
      });
      await installExtension(
        { name, version: null },
        skillInstallContext(repoDir, lockfile, { [name]: archive }, {
          force: true,
          skillsDirs: [
            join(repoDir, ".claude", "skills"),
            join(repoDir, ".kiro", "skills"),
          ],
        }),
      );
      const files = lockfile.getEntry(name)?.files ?? [];
      assertEquals(files.includes(relative(repoDir, kiroSkill)), true);
      assertEquals(files.includes(relative(repoDir, claudeSkill)), false);
      assertEquals(
        files.includes(relative(repoDir, join(claudeSkill, "SKILL.md"))),
        true,
      );
    });
  },
);

Deno.test(
  "installExtension: a dependency shipping its parent's skill merges without a conflict",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const parent = uniqueExtName();
      const dep = uniqueExtName();
      const archives = {
        [parent]: await buildSkillArchive({
          name: parent,
          skills: { foo: { "SKILL.md": "parent" } },
          dependencies: [dep],
        }),
        [dep]: await buildSkillArchive({
          name: dep,
          skills: { foo: { "dep.md": "dep" } },
        }),
      };
      const result = await installExtension(
        { name: parent, version: null },
        skillInstallContext(repoDir, lockfile, archives),
      );
      const skillDir = join(repoDir, ".claude", "skills", "foo");
      assertEquals(
        lockfile.getEntry(parent)?.files?.includes(relative(repoDir, skillDir)),
        true,
      );
      assertEquals(
        lockfile.getEntry(dep)?.files?.includes(
          relative(repoDir, join(skillDir, "dep.md")),
        ),
        true,
      );
      assertEquals(result?.dependencyResults.length, 1);
    });
  },
);

Deno.test(
  "installExtension: a symlinked skill dir counts as existing and is not followed",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const name = uniqueExtName();
      const target = join(repoDir, "elsewhere");
      await ensureDir(target);
      await Deno.writeTextFile(join(target, "notes.md"), "mine");
      await ensureDir(join(repoDir, ".claude", "skills"));
      const link = join(repoDir, ".claude", "skills", "foo");
      await Deno.symlink(target, link, { type: "dir" });
      const archive = await buildSkillArchive({
        name,
        skills: { foo: { "SKILL.md": "from ext" } },
      });
      const error = await assertRejects(
        () =>
          installExtension(
            { name, version: null },
            skillInstallContext(repoDir, lockfile, { [name]: archive }),
          ),
        ConflictError,
      );
      assertEquals(error.conflicts, [relative(repoDir, link)]);
    });
  },
);

Deno.test(
  "installExtension: orphan prune keeps a skill dir another extension claims",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const owner = uniqueExtName();
      const other = uniqueExtName();
      const skillDir = join(repoDir, ".claude", "skills", "foo");
      await ensureDir(skillDir);
      await Deno.writeTextFile(join(skillDir, "SKILL.md"), "owner");
      await Deno.writeTextFile(join(skillDir, "other.md"), "other");
      const root = relative(repoDir, skillDir);
      await lockfile.writeEntry(owner, "2025.01.01.1", [root]);
      await lockfile.writeEntry(other, "2025.01.01.1", [
        relative(repoDir, join(skillDir, "other.md")),
      ]);
      // The new owner version drops skill foo and ships bar instead.
      const archive = await buildSkillArchive({
        name: owner,
        skills: { bar: { "SKILL.md": "bar" } },
      });
      const result = await installExtension(
        { name: owner, version: null },
        skillInstallContext(repoDir, lockfile, { [owner]: archive }),
      );
      assertEquals(result?.pruned, []);
      assertEquals(
        await Deno.readTextFile(join(skillDir, "other.md")),
        "other",
      );
    });
  },
);

Deno.test(
  "installExtension: orphan prune still removes an unclaimed dropped skill dir",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const name = uniqueExtName();
      const skillDir = join(repoDir, ".claude", "skills", "foo");
      await ensureDir(skillDir);
      await Deno.writeTextFile(join(skillDir, "SKILL.md"), "old");
      const root = relative(repoDir, skillDir);
      await lockfile.writeEntry(name, "2025.01.01.1", [root]);
      const archive = await buildSkillArchive({
        name,
        skills: { bar: { "SKILL.md": "bar" } },
      });
      const result = await installExtension(
        { name, version: null },
        skillInstallContext(repoDir, lockfile, { [name]: archive }),
      );
      assertEquals(result?.pruned, [root]);
      assertEquals(await exists(skillDir), false);
    });
  },
);

Deno.test(
  "installExtension: switching a skill from per-file to root keeps the files just written",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const name = uniqueExtName();
      const skillDir = join(repoDir, ".claude", "skills", "foo");
      // Prior install merged into a user dir that has since been
      // deleted, so this install creates the root afresh.
      await lockfile.writeEntry(name, "2025.01.01.1", [
        relative(repoDir, join(skillDir, "SKILL.md")),
      ]);
      const archive = await buildSkillArchive({
        name,
        skills: { foo: { "SKILL.md": "new" } },
      });
      const result = await installExtension(
        { name, version: null },
        skillInstallContext(repoDir, lockfile, { [name]: archive }),
      );
      assertEquals(result?.pruned, []);
      assertEquals(await Deno.readTextFile(join(skillDir, "SKILL.md")), "new");
      assertEquals(
        lockfile.getEntry(name)?.files?.includes(relative(repoDir, skillDir)),
        true,
      );
    });
  },
);

Deno.test(
  "installExtension: a user's symlink inside a merged skill dir is not listed as created",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const name = uniqueExtName();
      const userSkill = join(repoDir, ".claude", "skills", "foo");
      await ensureDir(userSkill);
      const target = join(repoDir, "shared-skill.md");
      await Deno.writeTextFile(target, "mine");
      await Deno.symlink(target, join(userSkill, "SKILL.md"), {
        type: "file",
      });
      const archive = await buildSkillArchive({
        name,
        skills: { foo: { "SKILL.md": "from ext", "extra.md": "new" } },
      });
      const result = await installExtension(
        { name, version: null },
        skillInstallContext(repoDir, lockfile, { [name]: archive }, {
          force: true,
        }),
      );
      const created = result?.createdPaths ?? [];
      assertEquals(
        created.includes(relative(repoDir, join(userSkill, "SKILL.md"))),
        false,
      );
      assertEquals(
        created.includes(relative(repoDir, join(userSkill, "extra.md"))),
        true,
      );
    });
  },
);

// ===== Lockfile restore anchors (swamp-club#2639) =====
//
// A restore passes the lockfile entry's checksum and channel on the
// install context. The checksum anchors that entry's archive only, and
// the channel reaches the registry and the rewritten entry.

async function buildParentWithDependency(): Promise<{
  parent: string;
  dep: string;
  archives: Record<string, Uint8Array>;
}> {
  const parent = uniqueExtName();
  const dep = uniqueExtName();
  const archives = {
    [parent]: await buildSkillArchive({
      name: parent,
      skills: { parent: { "SKILL.md": "parent" } },
      dependencies: [dep],
    }),
    [dep]: await buildSkillArchive({
      name: dep,
      skills: { dep: { "SKILL.md": "dep" } },
    }),
  };
  return { parent, dep, archives };
}

Deno.test(
  "installExtension: a dependency is not checked against its parent's expectedChecksum",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const { parent, dep, archives } = await buildParentWithDependency();
      const result = await installExtension(
        { name: parent, version: SKILL_VERSION },
        {
          ...skillInstallContext(repoDir, lockfile, archives),
          expectedChecksum: await computeChecksum(archives[parent]),
        },
      );
      assertEquals(result?.integrityStatus, "verified");
      assertEquals(result?.dependencyResults.length, 1);
      assertEquals(lockfile.getEntry(parent)?.version, SKILL_VERSION);
      assertEquals(lockfile.getEntry(dep)?.version, SKILL_VERSION);
    });
  },
);

Deno.test(
  "installExtension: a parent's own expectedChecksum is still enforced",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const { parent, archives } = await buildParentWithDependency();
      const error = await assertRejects(
        () =>
          installExtension(
            { name: parent, version: SKILL_VERSION },
            {
              ...skillInstallContext(repoDir, lockfile, archives),
              expectedChecksum: "0".repeat(64),
            },
          ),
        UserError,
      );
      assertStringIncludes(error.message, `Checksum mismatch for ${parent}@`);
      assertEquals(lockfile.getEntry(parent), null);
    });
  },
);

Deno.test(
  "installExtension: a dependency's server checksum is still verified",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const { parent, dep, archives } = await buildParentWithDependency();
      const parentChecksum = await computeChecksum(archives[parent]);
      const wrongDepChecksum = "f".repeat(64);
      const error = await assertRejects(
        () =>
          installExtension(
            { name: parent, version: SKILL_VERSION },
            {
              ...skillInstallContext(repoDir, lockfile, archives),
              getChecksum: (name) =>
                Promise.resolve(
                  name === dep ? wrongDepChecksum : parentChecksum,
                ),
              expectedChecksum: parentChecksum,
            },
          ),
        UserError,
      );
      assertStringIncludes(error.message, "Checksum verification failed");
      assertStringIncludes(error.message, wrongDepChecksum);
    });
  },
);

Deno.test(
  "installExtension: the context channel reaches the registry and the lockfile entry",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const name = uniqueExtName();
      const archive = await buildSkillArchive({
        name,
        skills: { beta: { "SKILL.md": "beta" } },
      });
      const channels: Array<string | undefined> = [];
      const base = skillInstallContext(repoDir, lockfile, { [name]: archive });
      await installExtension(
        { name, version: SKILL_VERSION },
        {
          ...base,
          downloadArchive: (n, v, channel) => {
            channels.push(channel);
            return base.downloadArchive(n, v, channel);
          },
          getChecksum: (_n, _v, channel) => {
            channels.push(channel);
            return Promise.resolve(null);
          },
          channel: "beta",
        },
      );
      assertEquals(channels, ["beta", "beta"]);
      assertEquals(lockfile.getEntry(name)?.channel, "beta");
    });
  },
);

// ===== Prepare / apply split (swamp-club#2708) =====
//
// installExtension runs prepareInstall (network I/O and a private temp
// dir only), then applyInstall (repo and lockfile changes). These tests
// pin that prepare leaves the repo alone, that the prepared install's
// temp dir is always cleaned up, and that apply refuses anything but a
// live PreparedInstall.

/** Repo-relative path → size and mtime for every file under `dir`. */
async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for await (const entry of walk(dir, { includeDirs: true })) {
    if (entry.path === dir) continue;
    const stat = await Deno.lstat(entry.path);
    snapshot[relative(dir, entry.path)] =
      `${stat.size}:${stat.mtime?.getTime()}`;
  }
  return snapshot;
}

/** Repo-relative path → content for every file under `dir`. */
async function readTree(
  dir: string,
  skip: string[] = [],
): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  for await (const entry of walk(dir, { includeDirs: false })) {
    const rel = relative(dir, entry.path);
    if (skip.includes(rel)) continue;
    tree[rel] = await Deno.readTextFile(entry.path);
  }
  return tree;
}

async function withTempRoot(
  fn: (tempRoot: string) => Promise<void>,
): Promise<void> {
  const tempRoot = await Deno.makeTempDir({ prefix: "swamp_prepare_root_" });
  try {
    await fn(tempRoot);
  } finally {
    await Deno.remove(tempRoot, { recursive: true }).catch(() => {});
  }
}

async function listDir(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names;
}

function splitArchiveSpec(name: string): SkillArchiveSpec {
  return {
    name,
    skills: { guide: { "SKILL.md": "guide" } },
    files: {
      "models/thing.ts": "export const model = { type: 'thing' };\n",
      "workflows/run.yaml": "name: run\n",
      "files/data.txt": "data\n",
    },
  };
}

Deno.test(
  "prepareInstall: writes nothing outside its temp dir",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      await withTempRoot(async (tempRoot) => {
        const name = uniqueExtName();
        await Deno.writeTextFile(join(repoDir, "existing.txt"), "keep");
        const archive = await buildSkillArchive(splitArchiveSpec(name));
        const ctx = skillInstallContext(repoDir, lockfile, {
          [name]: archive,
        });
        const before = await snapshotTree(repoDir);

        const prepared = await prepareInstall({ name, version: null }, ctx, {
          tempRoot,
        });
        try {
          assertEquals(await snapshotTree(repoDir), before);
          assertEquals(lockfile.getEntry(name), null);
          assertEquals(ctx.alreadyPulled.size, 0);
          assertEquals(prepared.version, SKILL_VERSION);
          assertEquals(
            relative(tempRoot, prepared.extractDir).startsWith(".."),
            false,
          );
          assertEquals(
            await Deno.readTextFile(
              join(prepared.extractDir, "models", "thing.ts"),
            ),
            "export const model = { type: 'thing' };\n",
          );
        } finally {
          await prepared.dispose();
        }
      });
    });
  },
);

Deno.test(
  "PreparedInstall.dispose: removes the temp dir and is idempotent",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      await withTempRoot(async (tempRoot) => {
        const name = uniqueExtName();
        const archive = await buildSkillArchive(splitArchiveSpec(name));
        const prepared = await prepareInstall(
          { name, version: null },
          skillInstallContext(repoDir, lockfile, { [name]: archive }),
          { tempRoot },
        );
        assertEquals((await listDir(tempRoot)).length, 1);

        await prepared.dispose();
        assertEquals(await listDir(tempRoot), []);
        await prepared.dispose();
        assertEquals(await listDir(tempRoot), []);
      });
    });
  },
);

Deno.test(
  "prepareInstall: removes its temp dir when the archive has no manifest",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      await withTempRoot(async (tempRoot) => {
        const name = uniqueExtName();
        const archive = await buildSkillArchive({
          ...splitArchiveSpec(name),
          omitManifest: true,
        });
        const error = await assertRejects(
          () =>
            prepareInstall(
              { name, version: null },
              skillInstallContext(repoDir, lockfile, { [name]: archive }),
              { tempRoot },
            ),
          UserError,
        );
        assertStringIncludes(error.message, "missing manifest.yaml");
        assertEquals(await listDir(tempRoot), []);
      });
    });
  },
);

Deno.test(
  "prepareInstall: removes its temp dir when safety analysis fails",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      await withTempRoot(async (tempRoot) => {
        const name = uniqueExtName();
        const archive = await buildSkillArchive({
          ...splitArchiveSpec(name),
          files: { "models/bad.ts": "export const x = eval('1');\n" },
        });
        const error = await assertRejects(
          () =>
            prepareInstall(
              { name, version: null },
              skillInstallContext(repoDir, lockfile, { [name]: archive }),
              { tempRoot },
            ),
          UserError,
        );
        assertStringIncludes(error.message, "safety errors");
        assertEquals(await listDir(tempRoot), []);
      });
    });
  },
);

Deno.test(
  "applyInstall: a conflict throws ConflictError and changes nothing",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      await withTempRoot(async (tempRoot) => {
        const name = uniqueExtName();
        const userSkill = join(repoDir, ".claude", "skills", "guide");
        await ensureDir(userSkill);
        await Deno.writeTextFile(join(userSkill, "notes.md"), "mine");
        const archive = await buildSkillArchive(splitArchiveSpec(name));
        const ctx = skillInstallContext(repoDir, lockfile, {
          [name]: archive,
        });
        const prepared = await prepareInstall({ name, version: null }, ctx, {
          tempRoot,
        });
        try {
          const before = await snapshotTree(repoDir);
          await assertRejects(() => applyInstall(prepared, ctx), ConflictError);
          assertEquals(await snapshotTree(repoDir), before);
          assertEquals(lockfile.getEntry(name), null);
        } finally {
          await prepared.dispose();
        }
        assertEquals(await listDir(tempRoot), []);
      });
    });
  },
);

Deno.test(
  "applyInstall: prepare then apply writes the same tree and lockfile entry as installExtension",
  async () => {
    const name = uniqueExtName();
    const archive = await buildSkillArchive(splitArchiveSpec(name));
    const lockfileName = "upstream_extensions.json";
    let expectedTree: Record<string, string> = {};
    let expectedEntry: Record<string, unknown> = {};

    await withSkillRepo(async (repoDir, lockfile) => {
      await installExtension(
        { name, version: null },
        skillInstallContext(repoDir, lockfile, { [name]: archive }),
      );
      expectedTree = await readTree(repoDir, [lockfileName]);
      const { pulledAt: _pulledAt, ...entry } = lockfile.getEntry(name)!;
      expectedEntry = entry;
    });

    await withSkillRepo(async (repoDir, lockfile) => {
      const ctx = skillInstallContext(repoDir, lockfile, { [name]: archive });
      const prepared = await prepareInstall({ name, version: null }, ctx);
      try {
        await (await applyInstall(prepared, ctx)).commit();
      } finally {
        await prepared.dispose();
      }
      assertEquals(await readTree(repoDir, [lockfileName]), expectedTree);
      const { pulledAt: _pulledAt, ...entry } = lockfile.getEntry(name)!;
      assertEquals(entry, expectedEntry);
    });
  },
);

Deno.test(
  "applyInstall: refuses a disposed install and keeps the prior version",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const name = uniqueExtName();
      const archive = await buildSkillArchive(splitArchiveSpec(name));
      await installExtension(
        { name, version: null },
        skillInstallContext(repoDir, lockfile, { [name]: archive }),
      );
      const before = await snapshotTree(repoDir);
      const entryBefore = lockfile.getEntry(name);

      const ctx = skillInstallContext(repoDir, lockfile, {
        [name]: archive,
      }, { force: true });
      const prepared = await prepareInstall({ name, version: null }, ctx);
      await prepared.dispose();
      const error = await assertRejects(() => applyInstall(prepared, ctx));
      assertStringIncludes((error as Error).message, "already disposed");
      assertEquals(await snapshotTree(repoDir), before);
      assertEquals(lockfile.getEntry(name), entryBefore);
    });
  },
);

Deno.test(
  "applyInstall: refuses an install whose extract dir vanished",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const name = uniqueExtName();
      const archive = await buildSkillArchive(splitArchiveSpec(name));
      await installExtension(
        { name, version: null },
        skillInstallContext(repoDir, lockfile, { [name]: archive }),
      );
      const before = await snapshotTree(repoDir);
      const entryBefore = lockfile.getEntry(name);

      const ctx = skillInstallContext(repoDir, lockfile, {
        [name]: archive,
      }, { force: true });
      const prepared = await prepareInstall({ name, version: null }, ctx);
      try {
        await Deno.remove(prepared.extractDir, { recursive: true });
        const error = await assertRejects(() => applyInstall(prepared, ctx));
        assertStringIncludes((error as Error).message, "lost its extract dir");
        assertEquals(await snapshotTree(repoDir), before);
        assertEquals(lockfile.getEntry(name), entryBefore);
      } finally {
        await prepared.dispose();
      }
    });
  },
);

Deno.test(
  "applyInstall: refuses an object that did not come from prepareInstall",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const name = uniqueExtName();
      const extractDir = join(repoDir, "fake-extract");
      await ensureDir(join(extractDir, "models"));
      const before = await snapshotTree(repoDir);
      const forged = {
        ref: { name, version: SKILL_VERSION },
        version: SKILL_VERSION,
        extInfo: { name, description: "", latestVersion: SKILL_VERSION },
        localChecksum: "0",
        integrityStatus: "verified",
        manifest: {},
        manifestContent: "",
        extractDir,
        safetyWarnings: [],
        dispose: () => Promise.resolve(),
        assertUsable: () => Promise.resolve(),
      } as unknown as PreparedInstall;

      const error = await assertRejects(() =>
        applyInstall(
          forged,
          skillInstallContext(repoDir, lockfile, {}),
        )
      );
      assertStringIncludes(
        (error as Error).message,
        "requires a PreparedInstall",
      );
      assertEquals(await snapshotTree(repoDir), before);
      assertEquals(lockfile.getEntry(name), null);
    });
  },
);

Deno.test(
  "installExtension: refuses a downloaded archive over the archive size limit before verifying or writing it",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const name = uniqueExtName();
      let checksumFetched = false;
      const ctx: InstallContext = {
        ...skillInstallContext(repoDir, lockfile, {
          [name]: new Uint8Array(MAX_EXTENSION_ARCHIVE_BYTES + 1),
        }),
        getChecksum: () => {
          checksumFetched = true;
          return Promise.resolve(null);
        },
      };
      const error = await assertRejects(
        () => installExtension({ name, version: null }, ctx),
        UserError,
      );
      assertStringIncludes(error.message, `${name}@${SKILL_VERSION}`);
      assertStringIncludes(error.message, "50 MiB archive size limit");
      assertEquals(checksumFetched, false);
      assertEquals(lockfile.getEntry(name), null);
      assertEquals(await exists(join(repoDir, ".claude")), false);
    });
  },
);

// ===== Pulled-extensions lock (swamp-club#2709) =====
//
// installExtension holds the checkout's pulled-extensions lock around
// apply only. A second PulledExtensionsLock instance has its own
// in-process state, so its tryWithLock probes the cross-process file
// lock the way another swamp process would.

Deno.test(
  "installExtension: the lock is free while the top-level prepare downloads, and held for a dependency's",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const { parent, dep, archives } = await buildParentWithDependency();
      const otherProcess = new PulledExtensionsLock();
      const freeDuringDownload: Record<string, boolean> = {};
      const ctx = skillInstallContext(repoDir, lockfile, archives);
      await installExtension({ name: parent, version: SKILL_VERSION }, {
        ...ctx,
        downloadArchive: async (name, version, channel) => {
          const probe = await otherProcess.tryWithLock(
            repoDir,
            () => Promise.resolve(),
          );
          freeDuringDownload[name] = probe.acquired;
          return await ctx.downloadArchive(name, version, channel);
        },
      });
      // A dependency downloads under its parent's lease, by design.
      assertEquals(freeDuringDownload, { [parent]: true, [dep]: false });
      assertEquals(lockfile.getEntry(dep)?.version, SKILL_VERSION);
    });
  },
);

Deno.test(
  "installExtension: a ConflictError reaches the caller with the lock released",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const name = uniqueExtName();
      await ensureDir(join(repoDir, ".claude", "skills", "foo"));
      await Deno.writeTextFile(
        join(repoDir, ".claude", "skills", "foo", "notes.md"),
        "mine",
      );
      const archive = await buildSkillArchive({
        name,
        skills: { foo: { "SKILL.md": "from ext" } },
      });
      await assertRejects(
        () =>
          installExtension(
            { name, version: null },
            skillInstallContext(repoDir, lockfile, { [name]: archive }),
          ),
        ConflictError,
      );
      // The CLI prompts here; another process must be able to proceed.
      assertEquals(
        await new PulledExtensionsLock().tryWithLock(
          repoDir,
          () => Promise.resolve(),
        ),
        { acquired: true, value: undefined },
      );
    });
  },
);

Deno.test(
  "installExtension: apply prunes against the entry on disk, not the context's stale snapshot",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const name = uniqueExtName();
      const lockfilePath = lockfile.lockfilePath;
      const withSkill = (skill: string) =>
        buildSkillArchive({ name, skills: { [skill]: { "SKILL.md": skill } } });

      await installExtension(
        { name, version: null },
        skillInstallContext(repoDir, lockfile, {
          [name]: await withSkill("a"),
        }),
      );
      // This context's snapshot records skill "a"...
      const stale = await LockfileRepository.create(lockfilePath);
      // ...then another install replaces it with skill "b".
      await installExtension(
        { name, version: null },
        skillInstallContext(
          repoDir,
          await LockfileRepository.create(lockfilePath),
          { [name]: await withSkill("b") },
        ),
      );

      // Read from the stale snapshot, "b" would be an unowned dir (a
      // conflict) and would never be pruned.
      await installExtension(
        { name, version: null },
        skillInstallContext(repoDir, stale, { [name]: await withSkill("c") }),
      );
      const skills = join(repoDir, ".claude", "skills");
      assertEquals(await exists(join(skills, "b")), false);
      assertEquals(await exists(join(skills, "c", "SKILL.md")), true);
      const files = (await LockfileRepository.create(lockfilePath))
        .getEntry(name)?.files ?? [];
      assertEquals(files.includes(relative(repoDir, join(skills, "c"))), true);
      assertEquals(files.includes(relative(repoDir, join(skills, "b"))), false);
    });
  },
);

Deno.test(
  "applyInstall: prepare and apply called directly install each extension of a dependency cycle once",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const a = uniqueExtName();
      const b = uniqueExtName();
      const archives = {
        [a]: await buildSkillArchive({
          name: a,
          skills: { [a.slice(3)]: { "SKILL.md": "a" } },
          dependencies: [b],
        }),
        [b]: await buildSkillArchive({
          name: b,
          skills: { [b.slice(3)]: { "SKILL.md": "b" } },
          dependencies: [a],
        }),
      };
      const downloads: string[] = [];
      const base = skillInstallContext(repoDir, lockfile, archives);
      const ctx: InstallContext = {
        ...base,
        downloadArchive: (name, version, channel) => {
          downloads.push(name);
          return base.downloadArchive(name, version, channel);
        },
      };

      const prepared = await prepareInstall({ name: a, version: null }, ctx);
      try {
        await (await applyInstall(prepared, ctx)).commit();
      } finally {
        await prepared.dispose();
      }
      assertEquals(downloads, [a, b]);
      assertEquals(ctx.alreadyPulled.has(a), true);
    });
  },
);

// ===== Stage and swap (swamp-club#2723) =====
//
// applyInstall builds the new version in staging and swaps the
// extension root and bundle roots in whole. These tests pin that the
// result matches a plain install, that a failure restores the prior
// version exactly, and that nested entries survive their parent's swap.

function swapSpec(
  name: string,
  files: Record<string, string>,
  dependencies?: string[],
): SkillArchiveSpec {
  // A manifest must declare at least one kind; a skill named after the
  // extension keeps parents and nested entries from sharing one.
  const skill = `skill-${name.split("/").pop()}`;
  return {
    name,
    skills: { [skill]: { "SKILL.md": name } },
    files,
    dependencies,
  };
}

const V1_FILES = {
  "models/a.ts": "export const model = { type: 'a1' };\n",
  "models/old_only.ts": "export const x = 1;\n",
  "bundles/a.js": "// bundle v1\n",
  "vault-bundles/v.js": "// vault bundle v1\n",
  "files/data.txt": "v1\n",
};

const V2_FILES = {
  "models/a.ts": "export const model = { type: 'a2' };\n",
  "models/new_only.ts": "export const y = 2;\n",
  "bundles/a.js": "// bundle v2\n",
  "files/data.txt": "v2\n",
};

async function installArchive(
  repoDir: string,
  lockfile: LockfileRepository,
  archives: Record<string, Uint8Array>,
  name: string,
  opts: { force?: boolean; skillsDirs?: string[] } = {},
): Promise<InstallResult | undefined> {
  return await installExtension(
    { name, version: null },
    skillInstallContext(repoDir, lockfile, archives, opts),
  );
}

/** The repo tree minus the lockfile; asserts no staging is left. */
async function installedTree(
  repoDir: string,
): Promise<Record<string, string>> {
  for await (const entry of walk(repoDir, { includeFiles: false })) {
    assertEquals(entry.name.startsWith(".swamp-staging"), false, entry.path);
  }
  return await readTree(repoDir, ["upstream_extensions.json"]);
}

function entryWithoutTimes(lockfile: LockfileRepository, name: string) {
  const { pulledAt: _pulledAt, ...entry } = lockfile.getEntry(name)!;
  return entry;
}

function extRootOf(repoDir: string, name: string): string {
  return join(repoDir, ".swamp", "pulled-extensions", name);
}

Deno.test(
  "installExtension: an upgrade produces the same tree and entry as a fresh install",
  async () => {
    const name = uniqueExtName();
    const v1 = await buildSkillArchive(swapSpec(name, V1_FILES));
    const v2 = await buildSkillArchive(swapSpec(name, V2_FILES));

    let freshTree: Record<string, string> = {};
    let freshEntry: Record<string, unknown> = {};
    await withSkillRepo(async (repoDir, lockfile) => {
      await installArchive(repoDir, lockfile, { [name]: v2 }, name);
      freshTree = await installedTree(repoDir);
      freshEntry = entryWithoutTimes(lockfile, name);
    });

    await withSkillRepo(async (repoDir, lockfile) => {
      await installArchive(repoDir, lockfile, { [name]: v1 }, name);
      const vaultBundle = relative(
        repoDir,
        join(
          extensionInstallRoots(repoDir, name).bundleRoots
            .find((r) => r.sourceKind === "vaults")!.live,
          "v.js",
        ),
      );
      const result = await installArchive(
        repoDir,
        lockfile,
        { [name]: v2 },
        name,
        { force: true },
      );
      assertEquals(await installedTree(repoDir), freshTree);
      assertEquals(entryWithoutTimes(lockfile, name), freshEntry);
      assertEquals(
        [...(result?.pruned ?? [])].sort(),
        [
          relative(
            repoDir,
            join(extRootOf(repoDir, name), "models", "old_only.ts"),
          ),
          vaultBundle,
        ].sort(),
      );
    });
  },
);

Deno.test(
  "installExtension: a same-version reinstall leaves the tree and entry unchanged",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const name = uniqueExtName();
      const v1 = await buildSkillArchive(swapSpec(name, V1_FILES));
      await installArchive(repoDir, lockfile, { [name]: v1 }, name);
      const tree = await installedTree(repoDir);
      const entry = lockfile.getEntry(name);
      const result = await installArchive(
        repoDir,
        lockfile,
        { [name]: v1 },
        name,
        { force: true },
      );
      assertEquals(await installedTree(repoDir), tree);
      assertEquals(lockfile.getEntry(name), entry);
      assertEquals(result?.pruned, []);
    });
  },
);

Deno.test(
  "installExtension: --force drops a file the user added to the extension root",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const name = uniqueExtName();
      const v1 = await buildSkillArchive(swapSpec(name, V1_FILES));
      await installArchive(repoDir, lockfile, { [name]: v1 }, name);
      const tree = await installedTree(repoDir);
      const extra = join(extRootOf(repoDir, name), "models", "mine.ts");
      await Deno.writeTextFile(extra, "user file");

      await installArchive(repoDir, lockfile, { [name]: v1 }, name, {
        force: true,
      });
      assertEquals(await exists(extra), false);
      assertEquals(await installedTree(repoDir), tree);
    });
  },
);

Deno.test(
  "installExtension: a nested entry survives its parent's upgrade unchanged",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const parent = uniqueExtName();
      const child = `${parent}/child`;
      const archives = {
        [parent]: await buildSkillArchive(swapSpec(parent, V1_FILES)),
        [child]: await buildSkillArchive(swapSpec(child, {
          "models/c.ts": "export const c = 1;\n",
          "bundles/c.js": "// child bundle\n",
        })),
      };
      await installArchive(repoDir, lockfile, archives, parent);
      await installArchive(repoDir, lockfile, archives, child);
      const childRoot = extRootOf(repoDir, child);
      const childBefore = await snapshotTree(childRoot);
      const childTreeBefore = await readTree(childRoot);
      const childEntry = lockfile.getEntry(child);

      // Installing the child did not make the parent look edited.
      const parentRoot = extRootOf(repoDir, parent);
      assertEquals(
        await readInstalledExtensionDigest(parentRoot, {
          excludeRelDirs: ["child"],
        }),
        lockfile.getEntry(parent)?.filesChecksum,
      );

      const v2 = {
        ...archives,
        [parent]: await buildSkillArchive(swapSpec(parent, V2_FILES)),
      };
      await installArchive(repoDir, lockfile, v2, parent, { force: true });

      assertEquals(await readTree(childRoot), childTreeBefore);
      // Sizes and mtimes too: the child's sources stay no newer than
      // its bundles.
      assertEquals(await snapshotTree(childRoot), childBefore);
      assertEquals(lockfile.getEntry(child), childEntry);
      assertEquals(
        await readInstalledExtensionDigest(parentRoot, {
          excludeRelDirs: ["child"],
        }),
        lockfile.getEntry(parent)?.filesChecksum,
      );
      assertEquals(
        (lockfile.getEntry(parent)?.files ?? []).some((f) =>
          f.includes(`${parent.split("/")[1]}/child`)
        ),
        false,
      );
    });
  },
);

Deno.test(
  "installExtension: refuses a parent whose nested entry sits where it keeps its files",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const parent = uniqueExtName();
      const child = `${parent}/models`;
      const archives = {
        [parent]: await buildSkillArchive(swapSpec(parent, V1_FILES)),
      };
      await lockfile.writeEntry(child, "1.0.0", [], { checksum: "x" });
      const error = await assertRejects(
        () => installArchive(repoDir, lockfile, archives, parent),
        UserError,
      );
      assertStringIncludes(error.message, `${parent}/models`);
      assertEquals(await exists(extRootOf(repoDir, parent)), false);
    });
  },
);

Deno.test(
  "installExtension: a failure after the swap restores the prior version exactly",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const name = uniqueExtName();
      const v1 = await buildSkillArchive(swapSpec(name, V1_FILES));
      await installArchive(repoDir, lockfile, { [name]: v1 }, name);
      const tree = await installedTree(repoDir);
      const entry = lockfile.getEntry(name);

      // A skills dir that cannot be created fails the install after the
      // swap and before the lockfile write.
      const blocker = join(repoDir, "not-a-dir");
      await Deno.writeTextFile(blocker, "");
      const v2 = await buildSkillArchive(swapSpec(name, V2_FILES));
      await assertRejects(() =>
        installArchive(repoDir, lockfile, { [name]: v2 }, name, {
          force: true,
          skillsDirs: [join(blocker, "skills")],
        })
      );
      assertEquals(await installedTree(repoDir), { ...tree, "not-a-dir": "" });
      await lockfile.refresh();
      assertEquals(lockfile.getEntry(name), entry);
    });
  },
);

Deno.test(
  "installExtension: a dependency failing after the lockfile write keeps the parent installed",
  async () => {
    await withSkillRepo(async (repoDir, lockfile) => {
      const name = uniqueExtName();
      const dep = uniqueExtName();
      const archives = {
        [name]: await buildSkillArchive(swapSpec(name, V2_FILES, [dep])),
      };
      // The dependency is not in the registry, so its install throws
      // after the parent's lockfile entry landed.
      await assertRejects(
        () => installArchive(repoDir, lockfile, archives, name),
        UserError,
      );
      await lockfile.refresh();
      assertEquals(lockfile.getEntry(name)?.version, SKILL_VERSION);
      const tree = await installedTree(repoDir);
      assertEquals(
        tree[
          relative(repoDir, join(extRootOf(repoDir, name), "models", "a.ts"))
        ],
        V2_FILES["models/a.ts"],
      );
    });
  },
);
