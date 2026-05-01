// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import type { ExtensionLoadWarning } from "../../infrastructure/logging/extension_load_warnings.ts";
import { resetExtensionLoadWarnings } from "../../infrastructure/logging/extension_load_warnings.ts";
import {
  DOCTOR_REGISTRY_ORDER,
  doctorExtensions,
  type DoctorExtensionsDeps,
  type DoctorExtensionsEvent,
  type DoctorRegistryName,
} from "./doctor.ts";

interface SpyEntry {
  fn: string;
  registry?: DoctorRegistryName;
}

/**
 * Builds a deps object with spy callbacks. The shared `events` array
 * records every callback invocation so tests can assert ordering.
 *
 * The `getWarnings` stub returns a stable closure over the supplied
 * snapshot — it is called once per kind iteration and must return the
 * same value every time so partition-by-kind is deterministic.
 */
function buildDeps(
  options: {
    warnings?: ReadonlyArray<ExtensionLoadWarning>;
    throwForRegistry?: DoctorRegistryName;
    repoDir?: string;
    skillsDir?: string;
  } = {},
): {
  deps: DoctorExtensionsDeps;
  events: SpyEntry[];
} {
  const events: SpyEntry[] = [];
  const warnings = options.warnings ?? [];

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
    getWarnings: () => warnings,
    resetState: () => {
      events.push({ fn: "resetState" });
    },
    readUpstreamExtensions: () => Promise.resolve({}),
    repoDir: options.repoDir ?? "/tmp/swamp-test-repo",
    skillsDir: options.skillsDir ?? ".claude/skills",
    abortSignal: new AbortController().signal,
  };

  return { deps, events };
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
  const { deps } = buildDeps();

  const events = await collect(doctorExtensions(deps));

  const completed = events.find((e) => e.kind === "completed");
  assertEquals(completed?.kind, "completed");
  if (completed?.kind !== "completed") return;
  assertEquals(completed.report.overallStatus, "pass");
  for (const registry of DOCTOR_REGISTRY_ORDER) {
    const result = completed.report.registries[registry];
    assertEquals(result.status, "pass");
    assertEquals(result.failures.length, 0);
  }
});

Deno.test("doctorExtensions: emits all five kind-completed events in fixed order", async () => {
  resetExtensionLoadWarnings();
  const { deps } = buildDeps();

  const events = await collect(doctorExtensions(deps));
  const completedEvents = events.filter((e) => e.kind === "kind-completed");

  assertEquals(completedEvents.length, 5);
  for (let i = 0; i < DOCTOR_REGISTRY_ORDER.length; i++) {
    const event = completedEvents[i];
    if (event.kind !== "kind-completed") throw new Error("unreachable");
    assertEquals(event.result.registry, DOCTOR_REGISTRY_ORDER[i]);
  }
});

Deno.test("doctorExtensions: order of operations — resetState + all resetLoadedFlag run BEFORE any ensureLoaded", async () => {
  resetExtensionLoadWarnings();
  const { deps, events } = buildDeps();

  await collect(doctorExtensions(deps));

  // Find the indices of the first ensureLoaded vs all resets.
  const firstEnsureLoadedIdx = events.findIndex((e) => e.fn === "ensureLoaded");
  const lastResetIdx = events.reduce(
    (acc, e, i) =>
      e.fn === "resetState" || e.fn === "resetLoadedFlag" ? i : acc,
    -1,
  );

  // The last reset must come before the first ensureLoaded — that is
  // the load-bearing invariant the service owns.
  assertEquals(lastResetIdx < firstEnsureLoadedIdx, true);

  // resetState runs exactly once, and before any resetLoadedFlag.
  const resetStateIdx = events.findIndex((e) => e.fn === "resetState");
  assertEquals(resetStateIdx, 0);
  assertEquals(
    events.filter((e) => e.fn === "resetState").length,
    1,
  );

  // All five resetLoadedFlag calls fire exactly once.
  const resetCounts = new Map<DoctorRegistryName, number>();
  for (const e of events) {
    if (e.fn !== "resetLoadedFlag" || !e.registry) continue;
    resetCounts.set(e.registry, (resetCounts.get(e.registry) ?? 0) + 1);
  }
  for (const registry of DOCTOR_REGISTRY_ORDER) {
    assertEquals(resetCounts.get(registry), 1);
  }
});

Deno.test("doctorExtensions: model/extension fold — both ExtensionKind values land under the model registry's row", async () => {
  resetExtensionLoadWarnings();
  const mixedWarnings: ExtensionLoadWarning[] = [
    { kind: "model", file: "/m1.ts", error: "missing version" },
    { kind: "extension", file: "/m2.ts", error: "non-literal type" },
    { kind: "vault", file: "/v.ts", error: "broken vault" },
    { kind: "driver", file: "/d.ts", error: "broken driver" },
  ];
  const { deps } = buildDeps({ warnings: mixedWarnings });

  const events = await collect(doctorExtensions(deps));
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind !== "completed") {
    throw new Error("expected completed event");
  }

  // The model row absorbs BOTH the kind=model AND the kind=extension warnings.
  const modelRow = completed.report.registries.model;
  assertEquals(modelRow.status, "fail");
  assertEquals(modelRow.failures.length, 2);
  assertEquals(modelRow.failures[0].file, "/m1.ts");
  assertEquals(modelRow.failures[1].file, "/m2.ts");

  // The vault row sees only its own warnings.
  const vaultRow = completed.report.registries.vault;
  assertEquals(vaultRow.status, "fail");
  assertEquals(vaultRow.failures.length, 1);
  assertEquals(vaultRow.failures[0].file, "/v.ts");

  // datastore + report rows are clean.
  assertEquals(completed.report.registries.datastore.status, "pass");
  assertEquals(completed.report.registries.report.status, "pass");

  // Overall status is fail because at least one registry failed.
  assertEquals(completed.report.overallStatus, "fail");
});

Deno.test("doctorExtensions: per-kind throw isolation — a thrown ensureLoaded becomes a fail without aborting other kinds", async () => {
  resetExtensionLoadWarnings();
  const { deps } = buildDeps({ throwForRegistry: "vault" });

  const events = await collect(doctorExtensions(deps));
  const completed = events.find((e) => e.kind === "completed");
  if (completed?.kind !== "completed") {
    throw new Error("expected completed event");
  }

  // Vault failed, others passed.
  assertEquals(completed.report.registries.vault.status, "fail");
  assertEquals(completed.report.registries.vault.failures.length, 1);
  assertEquals(
    completed.report.registries.vault.failures[0].error.includes("stub-throw"),
    true,
  );

  // The other registries still ran and reported pass.
  assertEquals(completed.report.registries.model.status, "pass");
  assertEquals(completed.report.registries.driver.status, "pass");
  assertEquals(completed.report.registries.datastore.status, "pass");
  assertEquals(completed.report.registries.report.status, "pass");

  // All five kind-completed events were emitted.
  const completedEvents = events.filter((e) => e.kind === "kind-completed");
  assertEquals(completedEvents.length, 5);
});

Deno.test("doctorExtensions: completed report has all five registry keys even on pass", async () => {
  resetExtensionLoadWarnings();
  const { deps } = buildDeps();

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
      deps.readUpstreamExtensions = () => Promise.resolve(upstream);

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
      deps.readUpstreamExtensions = () => Promise.resolve(upstream);

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
      deps.readUpstreamExtensions = () => Promise.resolve(upstream);

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
      deps.readUpstreamExtensions = () => Promise.resolve(upstream);

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
