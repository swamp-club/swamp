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
  extensionMemberDoctorDeps,
  toDoctorWarnings,
} from "./doctor.ts";
import type { DoctorAggregateReport } from "./doctor_aggregate.ts";
import { z } from "zod";
import { modelRegistry } from "../../domain/models/model.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  modelKindAdapter,
  removeAttachedExtensionsForType,
} from "../../domain/extensions/model_kind_adapter.ts";
import type { ExtensionTypeRow } from "../../infrastructure/persistence/extension_catalog_store.ts";

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
    skillsDirs: [options.skillsDir ?? ".claude/skills"],
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

Deno.test("doctorExtensions: clean state — all registries pass", async () => {
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

  assertEquals(completedEvents.length, DOCTOR_REGISTRY_ORDER.length);
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
  assertEquals(completed.report.registries.datastore.status, "pass");
  assertEquals(completed.report.registries.report.status, "pass");
  assertEquals(completed.report.registries.webhook.status, "pass");

  const completedEvents = events.filter((e) => e.kind === "kind-completed");
  assertEquals(completedEvents.length, DOCTOR_REGISTRY_ORDER.length);
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
  assertEquals(keys, ["datastore", "model", "report", "vault", "webhook"]);
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

Deno.test("doctorExtensions: rescanSkipped from deps reaches the report", async () => {
  resetExtensionLoadWarnings();
  const { deps } = buildDeps({ aggregateState: emptyAggregateReport() });
  deps.rescanSkipped = {
    reason: "Cannot resolve the s3 datastore",
    repairSkipped: true,
  };

  const events = await collect(doctorExtensions(deps));

  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind !== "completed") {
    throw new Error("expected a completed event");
  }
  assertEquals(completed.report.rescanSkipped, {
    reason: "Cannot resolve the s3 datastore",
    repairSkipped: true,
  });
  assertEquals(completed.report.repairReport, undefined);
});

// -- Extension member collisions (swamp-club#2562) ---------------------------

Deno.test("doctorExtensions: attaches extension members after every registry loads and reports collisions as warnings", async () => {
  const { deps, events } = buildDeps();
  deps.attachExtensionMembers = () => {
    events.push({ fn: "attachExtensionMembers" });
    return Promise.resolve([{
      sourcePath: "@x/broken",
      category: "ExtensionAttachFailed",
      message: "boom",
    }]);
  };
  const collision = {
    type: "@x/base",
    memberKind: "method" as const,
    name: "probe",
    winner: "/repo/extensions/models/local.ts",
    losers: ["/repo/.swamp/pulled-extensions/@x/y/models/p.ts"],
  };
  deps.getMemberCollisions = () => [collision];

  const out = await collect(doctorExtensions(deps));
  const completed = out.find((e) => e.kind === "completed");
  if (completed?.kind !== "completed") {
    throw new Error("expected completed event");
  }

  const attachAt = events.findIndex((e) => e.fn === "attachExtensionMembers");
  const lastEnsure = events.map((e) => e.fn).lastIndexOf("ensureLoaded");
  assertEquals(attachAt > lastEnsure, true);
  assertEquals(completed.report.memberCollisions, [collision]);
  assertEquals(
    completed.report.warnings.map((w) => w.category),
    ["ExtensionAttachFailed"],
  );
  assertEquals(completed.report.overallStatus, "pass");
});

Deno.test("doctorExtensions: memberCollisions is empty without the collision dependency", async () => {
  const { deps } = buildDeps();
  const out = await collect(doctorExtensions(deps));
  const completed = out.find((e) => e.kind === "completed");
  if (completed?.kind !== "completed") {
    throw new Error("expected completed event");
  }
  assertEquals(completed.report.memberCollisions, []);
});

Deno.test("toDoctorWarnings: keeps each warning's category and defaults to TypeExtractionFailed", () => {
  assertEquals(
    toDoctorWarnings([
      {
        kind: "extension",
        file: "a.ts",
        error: "x",
        category: "MemberCollision",
      },
      { kind: "model", file: "b.ts", error: "y" },
    ]),
    [
      { sourcePath: "a.ts", category: "MemberCollision", message: "x" },
      { sourcePath: "b.ts", category: "TypeExtractionFailed", message: "y" },
    ],
  );
});

Deno.test("extensionMemberDoctorDeps: loads each registered target type and reports load failures", async () => {
  const good = `@test/doctor-good-${crypto.randomUUID().slice(0, 8)}`;
  const broken = `@test/doctor-broken-${crypto.randomUUID().slice(0, 8)}`;
  for (const type of [good, broken]) {
    modelRegistry.register({
      type: ModelType.create(type),
      version: "2026.01.01.0",
      methods: {},
    });
  }
  const row = (extendsType: string) =>
    ({ extends_type: extendsType }) as ExtensionTypeRow;
  const catalog = {
    findByKind: () => [
      row(good),
      row(good),
      row(broken),
      row(""),
      row("@test/unregistered"),
    ],
  };
  const loaded: string[] = [];
  const original = modelRegistry.ensureTypeLoaded;
  modelRegistry.ensureTypeLoaded = (type) => {
    loaded.push(String(type));
    return type === broken
      ? Promise.reject(new Error("bundle import failed"))
      : Promise.resolve();
  };
  try {
    const failures = await extensionMemberDoctorDeps(catalog)
      .attachExtensionMembers!();
    assertEquals(loaded.sort(), [broken, good].sort());
    assertEquals(failures, [{
      sourcePath: broken,
      category: "ExtensionAttachFailed",
      message: "bundle import failed",
    }]);
  } finally {
    modelRegistry.ensureTypeLoaded = original;
    modelRegistry.invalidateType(good);
    modelRegistry.invalidateType(broken);
  }
});

Deno.test("extensionMemberDoctorDeps: collisions come from the attach record, not re-emitted warnings", () => {
  const type = `@test/doctor-record-${crypto.randomUUID().slice(0, 8)}`;
  modelRegistry.register({
    type: ModelType.create(type),
    version: "2026.01.01.0",
    methods: {
      probe: {
        description: "base probe",
        arguments: z.object({}),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  });
  try {
    modelKindAdapter.processSecondaryExport!(
      "/repo/extensions/models/ext.ts",
      {
        type,
        methods: [{
          probe: {
            description: "ext probe",
            arguments: z.object({}),
            execute: () => Promise.resolve({ dataHandles: [] }),
          },
        }],
      },
      { loaded: [], extended: [], failed: [] },
      { sourcePath: "/repo/extensions/models/ext.ts", pulled: false },
    );
    // Doctor resets warnings before it runs; the record must survive that.
    resetExtensionLoadWarnings();
    const collisions = extensionMemberDoctorDeps({ findByKind: () => [] })
      .getMemberCollisions!()
      .filter((c) => c.type === type);
    assertEquals(collisions, [{
      type,
      memberKind: "method",
      name: "probe",
      winner: null,
      losers: ["/repo/extensions/models/ext.ts"],
    }]);
  } finally {
    modelRegistry.invalidateType(type);
    removeAttachedExtensionsForType(type);
    resetExtensionLoadWarnings();
  }
});
