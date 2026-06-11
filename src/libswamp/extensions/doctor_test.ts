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

import { assertEquals } from "@std/assert";
import {
  emitExtensionLoadWarning,
  getExtensionLoadWarnings,
  resetExtensionLoadWarnings,
} from "../../infrastructure/logging/extension_load_warnings.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import {
  DOCTOR_REGISTRY_ORDER,
  doctorExtensions,
  type DoctorExtensionsDeps,
  type DoctorExtensionsEvent,
  type DoctorRegistryDeps,
  type DoctorRegistryName,
  type DoctorWarning,
} from "./doctor.ts";
import type { DoctorAggregateReport } from "./doctor_aggregate.ts";

interface SpyEntry {
  fn: string;
  registry?: DoctorRegistryName;
}

function buildDeps(
  options: {
    throwForRegistry?: DoctorRegistryName;
    repoDir?: string;
    skillsDir?: string;
    aggregateState?: DoctorAggregateReport;
  } = {},
): {
  deps: DoctorExtensionsDeps;
  events: SpyEntry[];
} {
  const events: SpyEntry[] = [];

  const registries = DOCTOR_REGISTRY_ORDER.map((registry) => ({
    registry,
    ensureLoaded: () => {
      events.push({ fn: "ensureLoaded", registry });
      if (options.throwForRegistry === registry) {
        throw new Error(`stub-throw-${registry}`);
      }
      return Promise.resolve();
    },
    resetLoadedFlag: () => {
      events.push({ fn: "resetLoadedFlag", registry });
    },
  }));

  const deps: DoctorExtensionsDeps = {
    registries,
    lockfileRepository: new LockfileRepository(
      "/test/repo/upstream_extensions.json",
      {},
    ),
    repoDir: options.repoDir ?? "/tmp/swamp-test-repo",
    skillsDir: options.skillsDir ?? ".claude/skills",
    abortSignal: new AbortController().signal,
    buildAggregateState: options.aggregateState
      ? () => Promise.resolve(options.aggregateState!)
      : undefined,
  };

  return { deps, events };
}

function emptyAggregateReport(): DoctorAggregateReport {
  return {
    aggregates: [],
    sourceDetails: [],
    catalogOrphans: [],
    bundleOrphans: [],
    totalSources: 0,
    healthySources: 0,
    orphanRowCount: 0,
    orphanBundleFileCount: 0,
  };
}

async function collect(
  stream: AsyncIterable<DoctorExtensionsEvent>,
): Promise<DoctorExtensionsEvent[]> {
  const out: DoctorExtensionsEvent[] = [];
  for await (const event of stream) {
    out.push(event);
  }
  return out;
}

Deno.test("doctorExtensions: clean state — all five registries pass", async () => {
  resetExtensionLoadWarnings();
  const { deps } = buildDeps({ aggregateState: emptyAggregateReport() });

  const events = await collect(doctorExtensions(deps));

  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind !== "completed") return;
  assertEquals(completed.report.overallStatus, "pass");
  assertEquals(completed.report.recentTransitions, []);
  for (const registry of DOCTOR_REGISTRY_ORDER) {
    const result = completed.report.registries[registry];
    assertEquals(result.status, "pass");
  }
});

Deno.test("doctorExtensions: emits all five kind-completed events in fixed order", async () => {
  resetExtensionLoadWarnings();
  const { deps } = buildDeps({ aggregateState: emptyAggregateReport() });

  const events = await collect(doctorExtensions(deps));
  const completedEvents = events.filter((e) => e.kind === "kind-completed");

  assertEquals(completedEvents.length, 5);
  for (let i = 0; i < DOCTOR_REGISTRY_ORDER.length; i++) {
    const event = completedEvents[i];
    if (event.kind !== "kind-completed") throw new Error("unreachable");
    assertEquals(event.result.registry, DOCTOR_REGISTRY_ORDER[i]);
  }
});

Deno.test("doctorExtensions: order of operations — all resetLoadedFlag run BEFORE any ensureLoaded", async () => {
  resetExtensionLoadWarnings();
  const { deps, events } = buildDeps({
    aggregateState: emptyAggregateReport(),
  });

  await collect(doctorExtensions(deps));

  const firstEnsureLoadedIdx = events.findIndex((e) => e.fn === "ensureLoaded");
  const lastResetIdx = events.reduce(
    (acc, e, i) => e.fn === "resetLoadedFlag" ? i : acc,
    -1,
  );

  assertEquals(lastResetIdx < firstEnsureLoadedIdx, true);

  const resetCounts = new Map<DoctorRegistryName, number>();
  for (const e of events) {
    if (e.fn !== "resetLoadedFlag" || !e.registry) continue;
    resetCounts.set(e.registry, (resetCounts.get(e.registry) ?? 0) + 1);
  }
  for (const registry of DOCTOR_REGISTRY_ORDER) {
    assertEquals(resetCounts.get(registry), 1);
  }
});

Deno.test("doctorExtensions: model/extension fold — both ExtensionKind values in sourceDetails drive model registry status", async () => {
  resetExtensionLoadWarnings();
  const aggregate = emptyAggregateReport();
  const withFailures: DoctorAggregateReport = {
    ...aggregate,
    sourceDetails: [
      {
        sourcePath: "/m1.ts",
        stateTag: "BundleBuildFailed",
        fingerprint: "",
        bundlePath: "",
        kind: "model",
        lastError: "missing version",
      },
      {
        sourcePath: "/m2.ts",
        stateTag: "ValidationFailed",
        fingerprint: "",
        bundlePath: "",
        kind: "extension",
        lastError: "non-literal type",
      },
      {
        sourcePath: "/v.ts",
        stateTag: "BundleBuildFailed",
        fingerprint: "",
        bundlePath: "",
        kind: "vault",
        lastError: "broken vault",
      },
    ],
  };
  const { deps } = buildDeps({ aggregateState: withFailures });

  const events = await collect(doctorExtensions(deps));
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind !== "completed") {
    throw new Error("expected completed event");
  }

  assertEquals(completed.report.registries.model.status, "fail");
  assertEquals(completed.report.registries.vault.status, "fail");
  assertEquals(completed.report.registries.datastore.status, "pass");
  assertEquals(completed.report.registries.report.status, "pass");
  assertEquals(completed.report.overallStatus, "fail");
});

Deno.test("doctorExtensions: per-kind throw isolation — a thrown ensureLoaded becomes a fail without aborting other kinds", async () => {
  resetExtensionLoadWarnings();
  const { deps } = buildDeps({
    throwForRegistry: "vault",
    aggregateState: emptyAggregateReport(),
  });

  const events = await collect(doctorExtensions(deps));
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind !== "completed") {
    throw new Error("expected completed event");
  }

  assertEquals(completed.report.registries.vault.status, "fail");
  assertEquals(completed.report.registries.model.status, "pass");
  assertEquals(completed.report.registries.driver.status, "pass");
  assertEquals(completed.report.registries.datastore.status, "pass");
  assertEquals(completed.report.registries.report.status, "pass");

  const completedEvents = events.filter((e) => e.kind === "kind-completed");
  assertEquals(completedEvents.length, 5);
});

Deno.test("doctorExtensions: completed report has all five registry keys even on pass", async () => {
  resetExtensionLoadWarnings();
  const { deps } = buildDeps({ aggregateState: emptyAggregateReport() });

  const events = await collect(doctorExtensions(deps));
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind !== "completed") {
    throw new Error("expected completed event");
  }

  const keys = Object.keys(completed.report.registries).sort();
  assertEquals(keys, ["datastore", "driver", "model", "report", "vault"]);
});

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import type { UpstreamExtensionsMap } from "../../infrastructure/persistence/upstream_extensions.ts";
import type { ReconcileTransition } from "./reconcile_from_disk_service.ts";
import { makeSourceLocation } from "../../domain/extensions/source_location.ts";

Deno.test(
  "doctorExtensions: detects an orphan file under a per-extension subtree",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_orphan_" });
    try {
      // Seed a tracked file plus an UNtracked sibling — the sibling
      // is the orphan we expect doctor to flag.
      const extDir = join(
        tmpDir,
        ".swamp/pulled-extensions/@x/y/models",
      );
      await ensureDir(extDir);
      await Deno.writeTextFile(join(extDir, "tracked.ts"), "// tracked");
      await Deno.writeTextFile(join(extDir, "orphan.ts"), "// orphan");

      const { deps } = buildDeps({
        repoDir: tmpDir,
        skillsDir: ".claude/skills",
      });
      const upstream: UpstreamExtensionsMap = {
        "@x/y": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [".swamp/pulled-extensions/@x/y/models/tracked.ts"],
        },
      };
      deps.lockfileRepository = new LockfileRepository(
        "/test/repo/upstream_extensions.json",
        upstream,
      );

      const events = await collect(doctorExtensions(deps));
      const completed = events.find((e) => e.kind === "completed");
      if (completed?.kind !== "completed") {
        throw new Error("expected completed event");
      }

      assertEquals(completed.report.orphanFiles.length, 1);
      assertEquals(completed.report.orphanFiles[0].extensionName, "@x/y");
      assertEquals(
        completed.report.orphanFiles[0].path,
        ".swamp/pulled-extensions/@x/y/models/orphan.ts",
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "doctorExtensions: nested scoped siblings do not cross-attribute orphans",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_orphan_" });
    try {
      const iamDir = join(
        tmpDir,
        ".swamp/pulled-extensions/@swamp/aws/iam/models",
      );
      const s3Dir = join(
        tmpDir,
        ".swamp/pulled-extensions/@swamp/aws/s3/models",
      );
      await ensureDir(iamDir);
      await ensureDir(s3Dir);
      await Deno.writeTextFile(join(iamDir, "role.ts"), "// iam");
      await Deno.writeTextFile(join(s3Dir, "bucket.ts"), "// s3");

      const { deps } = buildDeps({
        repoDir: tmpDir,
        skillsDir: ".claude/skills",
      });
      const upstream: UpstreamExtensionsMap = {
        "@swamp/aws/iam": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [".swamp/pulled-extensions/@swamp/aws/iam/models/role.ts"],
        },
        "@swamp/aws/s3": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [".swamp/pulled-extensions/@swamp/aws/s3/models/bucket.ts"],
        },
      };
      deps.lockfileRepository = new LockfileRepository(
        "/test/repo/upstream_extensions.json",
        upstream,
      );

      const events = await collect(doctorExtensions(deps));
      const completed = events.find((e) => e.kind === "completed");
      if (completed?.kind !== "completed") {
        throw new Error("expected completed event");
      }

      assertEquals(completed.report.orphanFiles.length, 0);
    } finally {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "doctorExtensions: orphans do NOT change overallStatus from pass to fail",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_orphan_" });
    try {
      const extDir = join(
        tmpDir,
        ".swamp/pulled-extensions/@x/y/models",
      );
      await ensureDir(extDir);
      await Deno.writeTextFile(join(extDir, "tracked.ts"), "// tracked");
      await Deno.writeTextFile(join(extDir, "stray.ts"), "// stray");

      const { deps } = buildDeps({
        repoDir: tmpDir,
        skillsDir: ".claude/skills",
      });
      const upstream: UpstreamExtensionsMap = {
        "@x/y": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [".swamp/pulled-extensions/@x/y/models/tracked.ts"],
        },
      };
      deps.lockfileRepository = new LockfileRepository(
        "/test/repo/upstream_extensions.json",
        upstream,
      );

      const events = await collect(doctorExtensions(deps));
      const completed = events.find((e) => e.kind === "completed");
      if (completed?.kind !== "completed") {
        throw new Error("expected completed event");
      }

      // Even though there's an orphan, overallStatus stays "pass" —
      // orphans are warnings, not failures.
      assertEquals(completed.report.orphanFiles.length, 1);
      assertEquals(completed.report.overallStatus, "pass");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "doctorExtensions: missing lockfile yields no orphans (no-op walk)",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_orphan_" });
    try {
      const { deps } = buildDeps({
        repoDir: tmpDir,
        skillsDir: ".claude/skills",
      });
      // Default readUpstreamExtensions returns {} — the no-lockfile case.
      const events = await collect(doctorExtensions(deps));
      const completed = events.find((e) => e.kind === "completed");
      if (completed?.kind !== "completed") {
        throw new Error("expected completed event");
      }
      assertEquals(completed.report.orphanFiles, []);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "doctorExtensions: skill-dir entries do NOT produce orphan walks",
  async () => {
    // Skills are tracked as directory paths only; we cannot
    // meaningfully orphan-detect within a skill dir. extractTopLevelRoot
    // returns null for skill paths, so the walk skips them.
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_orphan_" });
    try {
      const skillDir = join(tmpDir, ".claude/skills/foo");
      await ensureDir(skillDir);
      await Deno.writeTextFile(join(skillDir, "SKILL.md"), "# foo");
      await Deno.writeTextFile(
        join(skillDir, "untracked-script.sh"),
        "#!/bin/sh\n",
      );

      const { deps } = buildDeps({
        repoDir: tmpDir,
        skillsDir: ".claude/skills",
      });
      const upstream: UpstreamExtensionsMap = {
        "@x/y": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [".claude/skills/foo"],
        },
      };
      deps.lockfileRepository = new LockfileRepository(
        "/test/repo/upstream_extensions.json",
        upstream,
      );

      const events = await collect(doctorExtensions(deps));
      const completed = events.find((e) => e.kind === "completed");
      if (completed?.kind !== "completed") {
        throw new Error("expected completed event");
      }
      // Inner files of a skill dir are NOT walked — no orphan reported.
      assertEquals(completed.report.orphanFiles, []);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "doctorExtensions: detects an orphan inside a bundle namespace",
  async () => {
    // The orphan path that closes the #201 catalog loop: a stray bundle
    // file under .swamp/bundles/<hash>/ that was dropped between
    // versions but never removed from disk. The doctor scan must walk
    // the bundle namespace as a separate root from the per-extension
    // subtree, since bundles live in a different tree.
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_orphan_" });
    try {
      // Tracked: a model file under pulled-extensions AND its bundle
      // under bundles/abc/. Untracked: a stray bundle file in the same
      // namespace from a prior version.
      const extDir = join(tmpDir, ".swamp/pulled-extensions/@x/y/models");
      const bundleDir = join(tmpDir, ".swamp/bundles/abc");
      await ensureDir(extDir);
      await ensureDir(bundleDir);
      await Deno.writeTextFile(join(extDir, "current.ts"), "// current");
      await Deno.writeTextFile(
        join(bundleDir, "current.js"),
        "// current bundle",
      );
      await Deno.writeTextFile(
        join(bundleDir, "stray_old_bundle.js"),
        "// orphan",
      );

      const { deps } = buildDeps({
        repoDir: tmpDir,
        skillsDir: ".claude/skills",
      });
      const upstream: UpstreamExtensionsMap = {
        "@x/y": {
          version: "2.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [
            ".swamp/pulled-extensions/@x/y/models/current.ts",
            ".swamp/bundles/abc/current.js",
          ],
        },
      };
      deps.lockfileRepository = new LockfileRepository(
        "/test/repo/upstream_extensions.json",
        upstream,
      );

      const events = await collect(doctorExtensions(deps));
      const completed = events.find((e) => e.kind === "completed");
      if (completed?.kind !== "completed") {
        throw new Error("expected completed event");
      }

      // Exactly one orphan: the stray bundle file. The pulled-extensions
      // subtree is clean (only current.ts).
      assertEquals(completed.report.orphanFiles.length, 1);
      assertEquals(completed.report.orphanFiles[0].extensionName, "@x/y");
      assertEquals(
        completed.report.orphanFiles[0].path,
        ".swamp/bundles/abc/stray_old_bundle.js",
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "doctorExtensions: recentTransitions defaults to empty array when no callback provided",
  async () => {
    resetExtensionLoadWarnings();
    const { deps } = buildDeps();

    const events = await collect(doctorExtensions(deps));
    const completed = events.find((e) => e.kind === "completed");
    if (completed?.kind !== "completed") {
      throw new Error("expected completed event");
    }
    assertEquals(completed.report.recentTransitions, []);
  },
);

Deno.test(
  "doctorExtensions: recentTransitions surfaces transitions from getRecentTransitions callback",
  async () => {
    resetExtensionLoadWarnings();
    const transitions: ReconcileTransition[] = [
      {
        source: makeSourceLocation("/repo/extensions/models/a.ts", "/repo"),
        fromState: "Indexed",
        toState: "Tombstoned",
        reason: "source file deleted from disk",
      },
      {
        source: makeSourceLocation("/repo/extensions/models/b.ts", "/repo"),
        fromState: null,
        toState: "Indexed",
        reason: "new source discovered",
      },
    ];

    const { deps } = buildDeps();
    deps.getRecentTransitions = () => transitions;

    const events = await collect(doctorExtensions(deps));
    const completed = events.find((e) => e.kind === "completed");
    if (completed?.kind !== "completed") {
      throw new Error("expected completed event");
    }
    assertEquals(completed.report.recentTransitions.length, 2);
    assertEquals(completed.report.recentTransitions[0].toState, "Tombstoned");
    assertEquals(
      completed.report.recentTransitions[0].source.canonicalPath,
      "/repo/extensions/models/a.ts",
    );
    assertEquals(completed.report.recentTransitions[1].fromState, null);
    assertEquals(completed.report.recentTransitions[1].toState, "Indexed");
  },
);

Deno.test(
  "doctorExtensions: resetWarnings prevents stale bootstrap warnings from leaking into report",
  async () => {
    resetExtensionLoadWarnings();

    emitExtensionLoadWarning(
      {
        kind: "model",
        file: "/repo/extensions/models/stale.ts",
        error: "stale bootstrap warning",
      },
      { quiet: true },
    );
    assertEquals(getExtensionLoadWarnings().length, 1);

    const warnings: DoctorWarning[] = [];
    const { deps } = buildDeps();
    deps.resetWarnings = resetExtensionLoadWarnings;
    deps.getWarnings = () =>
      getExtensionLoadWarnings().map((w) => ({
        sourcePath: w.file,
        category: "TypeExtractionFailed",
        message: w.error,
      }));

    const events = await collect(doctorExtensions(deps));
    const completed = events.find((e) => e.kind === "completed");
    if (completed?.kind !== "completed") {
      throw new Error("expected completed event");
    }
    assertEquals(completed.report.warnings.length, 0);
    void warnings;
  },
);

Deno.test(
  "doctorExtensions: warnings emitted during loader pass appear in report",
  async () => {
    resetExtensionLoadWarnings();

    const { deps } = buildDeps();
    const originalEnsureLoaded = deps.registries[0].ensureLoaded;
    (deps.registries as DoctorRegistryDeps[])[0] = {
      ...deps.registries[0],
      ensureLoaded: async () => {
        emitExtensionLoadWarning(
          {
            kind: "model",
            file: "/repo/extensions/models/non_literal.ts",
            error: "type field could not be extracted",
          },
          { quiet: true },
        );
        await originalEnsureLoaded();
      },
    };
    deps.resetWarnings = resetExtensionLoadWarnings;
    deps.getWarnings = () =>
      getExtensionLoadWarnings().map((w) => ({
        sourcePath: w.file,
        category: "TypeExtractionFailed",
        message: w.error,
      }));

    const events = await collect(doctorExtensions(deps));
    const completed = events.find((e) => e.kind === "completed");
    if (completed?.kind !== "completed") {
      throw new Error("expected completed event");
    }
    assertEquals(completed.report.warnings.length, 1);
    assertEquals(
      completed.report.warnings[0].sourcePath,
      "/repo/extensions/models/non_literal.ts",
    );
    assertEquals(
      completed.report.warnings[0].category,
      "TypeExtractionFailed",
    );
    assertEquals(completed.report.overallStatus, "pass");
  },
);

Deno.test(
  "doctorExtensions: second invocation does not double-count warnings",
  async () => {
    resetExtensionLoadWarnings();

    const { deps } = buildDeps();
    const originalEnsureLoaded = deps.registries[0].ensureLoaded;
    (deps.registries as DoctorRegistryDeps[])[0] = {
      ...deps.registries[0],
      ensureLoaded: async () => {
        emitExtensionLoadWarning(
          {
            kind: "model",
            file: "/repo/extensions/models/non_literal.ts",
            error: "type field could not be extracted",
          },
          { quiet: true },
        );
        await originalEnsureLoaded();
      },
    };
    deps.resetWarnings = resetExtensionLoadWarnings;
    deps.getWarnings = () =>
      getExtensionLoadWarnings().map((w) => ({
        sourcePath: w.file,
        category: "TypeExtractionFailed",
        message: w.error,
      }));

    // First invocation
    let events = await collect(doctorExtensions(deps));
    let completed = events.find((e) => e.kind === "completed");
    if (completed?.kind !== "completed") {
      throw new Error("expected completed event");
    }
    assertEquals(completed.report.warnings.length, 1);

    // Second invocation — reset should clear, loader re-emits exactly once
    events = await collect(doctorExtensions(deps));
    completed = events.find((e) => e.kind === "completed");
    if (completed?.kind !== "completed") {
      throw new Error("expected completed event");
    }
    assertEquals(completed.report.warnings.length, 1);
  },
);
