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

import { assert, assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { initializeTestRepo, runCliCommand } from "../test_helpers.ts";

const VALID_MODEL = `
import { z } from "npm:zod@4";
export const model = {
  type: "@tutorial/transitions-test",
  version: "2026.05.12.0",
  globalArguments: z.object({}),
  resources: {},
  methods: {
    run: {
      description: "no-op",
      arguments: z.object({}),
      execute: () => ({ dataHandles: [] }),
    },
  },
};
`;

async function withTestRepo(
  fn: (repoDir: string) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({
    prefix: "swamp-doctor-transitions-test-",
  });
  try {
    await initializeTestRepo(repoDir);
    await fn(repoDir);
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
}

interface TransitionEntry {
  sourcePath: string;
  fromState: string | null;
  toState: string;
  reason: string;
}

interface DoctorReport {
  overallStatus: string;
  recentTransitions: TransitionEntry[];
  aggregateState?: {
    sourceDetails: {
      sourcePath: string;
      stateTag: string;
    }[];
  };
}

async function runDoctor(repoDir: string): Promise<DoctorReport> {
  const result = await runCliCommand(
    ["doctor", "extensions", "--json", "--verbose"],
    repoDir,
  );
  assertEquals(result.code, 0, `doctor failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

// AC 1: Deleted local extension source → recentTransitions contains
// Tombstoned or OrphanedBundleOnly transition. The first doctor run
// populates the catalog via the loader; the pre-reconcile step on a
// fresh catalog produces no transitions because loadAll() returns an
// empty set. The deletion transition surfaces on the subsequent run.
Deno.test("doctor extensions transitions: deleted local source produces transition", async () => {
  await withTestRepo(async (repoDir) => {
    const modelDir = join(repoDir, "extensions", "models");
    await ensureDir(modelDir);
    const modelPath = join(modelDir, "tombstone_test.ts");

    await Deno.writeTextFile(modelPath, VALID_MODEL);

    // First run: populate the catalog (loader indexes the source)
    const first = await runDoctor(repoDir);
    assert(
      first.aggregateState,
      "Expected aggregateState in verbose output",
    );
    const indexedDetail = first.aggregateState.sourceDetails.find((d) =>
      d.sourcePath.includes("tombstone_test.ts")
    );
    assert(indexedDetail, "Source should appear in sourceDetails");
    assertEquals(indexedDetail.stateTag, "Indexed");

    // Delete the source file
    await Deno.remove(modelPath);

    // Second run: reconcile detects the missing source
    const second = await runDoctor(repoDir);
    assert(
      Array.isArray(second.recentTransitions),
      "recentTransitions must be an array",
    );
    const transition = second.recentTransitions.find((t) =>
      t.sourcePath.includes("tombstone_test.ts") &&
      (t.toState === "Tombstoned" || t.toState === "OrphanedBundleOnly")
    );
    assert(
      transition,
      `Expected transition to Tombstoned or OrphanedBundleOnly, got: ${
        JSON.stringify(second.recentTransitions)
      }`,
    );
    assertEquals(transition.fromState, "Indexed");
  });
});

// AC 2: Deleted pulled extension source → transition
Deno.test("doctor extensions transitions: deleted pulled source produces transition", async () => {
  await withTestRepo(async (repoDir) => {
    const extName = "@test/pulled-transitions";
    const extRoot = join(repoDir, ".swamp", "pulled-extensions", extName);
    const modelDir = join(extRoot, "models");
    await ensureDir(modelDir);
    const modelPath = join(modelDir, "pulled_model.ts");

    await Deno.writeTextFile(
      modelPath,
      VALID_MODEL.replace(
        "@tutorial/transitions-test",
        "@test/pulled-transition-model",
      ),
    );

    const lockfileDir = join(repoDir, "extensions", "models");
    await ensureDir(lockfileDir);
    const lockfilePath = join(lockfileDir, "upstream_extensions.json");
    const lockfile: Record<string, unknown> = {};
    lockfile[extName] = {
      version: "2026.05.12.0",
      pulledAt: new Date().toISOString(),
    };
    await Deno.writeTextFile(lockfilePath, JSON.stringify(lockfile, null, 2));

    // First run: populate the catalog
    const first = await runDoctor(repoDir);
    assert(first.aggregateState, "Expected aggregateState");
    const indexedDetail = first.aggregateState.sourceDetails.find((d) =>
      d.sourcePath.includes("pulled_model.ts")
    );
    assert(indexedDetail, "Pulled source should appear in sourceDetails");
    assertEquals(indexedDetail.stateTag, "Indexed");

    // Delete the pulled source file
    await Deno.remove(modelPath);

    // Second run: reconcile detects the missing source
    const second = await runDoctor(repoDir);
    assert(
      Array.isArray(second.recentTransitions),
      "recentTransitions must be an array",
    );
    const transition = second.recentTransitions.find((t) =>
      t.sourcePath.includes("pulled_model.ts")
    );
    assert(
      transition,
      `Expected transition for deleted pulled source, got: ${
        JSON.stringify(second.recentTransitions)
      }`,
    );
  });
});

// AC 3: No deletion → recentTransitions is empty (steady state)
Deno.test("doctor extensions transitions: no changes produces empty recentTransitions on second run", async () => {
  await withTestRepo(async (repoDir) => {
    const modelDir = join(repoDir, "extensions", "models");
    await ensureDir(modelDir);
    const modelPath = join(modelDir, "stable_model.ts");

    await Deno.writeTextFile(
      modelPath,
      VALID_MODEL.replace(
        "@tutorial/transitions-test",
        "@tutorial/stable",
      ),
    );

    // First run: populate the catalog
    await runDoctor(repoDir);

    // Second run: no changes, steady state
    const second = await runDoctor(repoDir);
    assertEquals(
      second.recentTransitions,
      [],
      "Steady-state run should produce no transitions",
    );
  });
});

// Path-format consistency: sourcePath in recentTransitions matches sourceDetails
Deno.test("doctor extensions transitions: sourcePath format matches sourceDetails", async () => {
  await withTestRepo(async (repoDir) => {
    const modelDir = join(repoDir, "extensions", "models");
    await ensureDir(modelDir);
    const modelPath = join(modelDir, "path_check.ts");

    await Deno.writeTextFile(
      modelPath,
      VALID_MODEL.replace(
        "@tutorial/transitions-test",
        "@tutorial/path-check",
      ),
    );

    // First run: populate the catalog, record the sourcePath used
    const first = await runDoctor(repoDir);
    assert(first.aggregateState, "Expected aggregateState");
    const detail = first.aggregateState.sourceDetails.find((d) =>
      d.sourcePath.includes("path_check.ts")
    );
    assert(detail, "Expected sourceDetail for new source");
    const detailSourcePath = detail.sourcePath;

    // Delete the source to force a transition
    await Deno.remove(modelPath);

    // Second run: capture the transition
    const second = await runDoctor(repoDir);
    const transition = second.recentTransitions.find((t) =>
      t.sourcePath.includes("path_check.ts")
    );
    assert(transition, "Expected transition for deleted source");

    assertEquals(
      transition.sourcePath,
      detailSourcePath,
      "recentTransitions[].sourcePath must exactly match sourceDetails[].sourcePath",
    );
  });
});
