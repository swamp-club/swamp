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

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { initializeTestRepo, runCliCommand } from "../test_helpers.ts";

const VALID_MODEL = `
import { z } from "npm:zod@4";
export const model = {
  type: "@tutorial/failure-test",
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

const SCHEMA_INVALID_MODEL = `
export const model = "not an object";
`;

const UNRESOLVABLE_IMPORT_MODEL = `
import { nonexistent } from "./this_file_does_not_exist.ts";
export const model = nonexistent;
`;

const VALIDATION_FAILING_MODEL = `
import { z } from "npm:zod@4";
export const model = {
  type: "@tutorial/bad-import",
  version: "2026.05.12.0",
  globalArguments: "not a zod schema",
  resources: {},
  methods: {},
};
`;

const NON_LITERAL_TYPE_MODEL = `
import { z } from "npm:zod@4";
const TYPE = "@tutorial/non-literal";
export const model = {
  type: TYPE,
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
    prefix: "swamp-doctor-failure-test-",
  });
  try {
    await initializeTestRepo(repoDir);
    await fn(repoDir);
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
}

interface DoctorReport {
  overallStatus: string;
  registries: Record<
    string,
    { registry: string; status: string }
  >;
  aggregateState: {
    totalSources: number;
    sourceDetails: {
      sourcePath: string;
      stateTag: string;
      fingerprint?: string;
      kind?: string;
      lastError?: string;
    }[];
  };
  warnings: {
    sourcePath: string;
    category: string;
    message: string;
  }[];
}

async function runDoctor(
  repoDir: string,
  opts?: { allowNonZero?: boolean },
): Promise<DoctorReport> {
  const result = await runCliCommand(
    ["doctor", "extensions", "--json", "--verbose"],
    repoDir,
  );
  if (!opts?.allowNonZero) {
    assertEquals(result.code, 0, `doctor failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function findSourceDetail(
  report: DoctorReport,
  pathFragment: string,
): DoctorReport["aggregateState"]["sourceDetails"][0] | undefined {
  return report.aggregateState.sourceDetails.find((d) =>
    d.sourcePath.includes(pathFragment)
  );
}

// AC 1: schema-invalid content → ValidationFailed in sourceDetails (#340)
Deno.test("doctor extensions: schema-invalid content produces ValidationFailed in sourceDetails", async () => {
  await withTestRepo(async (repoDir) => {
    const modelDir = join(repoDir, "extensions", "models");
    await ensureDir(modelDir);
    const modelPath = join(modelDir, "test_model.ts");

    await Deno.writeTextFile(modelPath, VALID_MODEL);
    const first = await runDoctor(repoDir);
    const indexedDetail = findSourceDetail(first, "test_model.ts");
    assert(
      indexedDetail,
      "Source should appear in sourceDetails after first run",
    );
    assertEquals(indexedDetail.stateTag, "Indexed");

    await Deno.writeTextFile(modelPath, SCHEMA_INVALID_MODEL);
    const second = await runDoctor(repoDir, { allowNonZero: true });
    const failedDetail = findSourceDetail(second, "test_model.ts");
    assert(
      failedDetail,
      "Source should appear in sourceDetails after corruption",
    );
    assertEquals(failedDetail.stateTag, "ValidationFailed");
  });
});

// AC 2: validation-failing content → ValidationFailed in sourceDetails (#340)
Deno.test("doctor extensions: validation-failing content produces ValidationFailed in sourceDetails", async () => {
  await withTestRepo(async (repoDir) => {
    const modelDir = join(repoDir, "extensions", "models");
    await ensureDir(modelDir);
    const modelPath = join(modelDir, "bad_validation.ts");

    await Deno.writeTextFile(
      modelPath,
      VALID_MODEL.replace(
        "@tutorial/failure-test",
        "@tutorial/bad-import",
      ),
    );
    const first = await runDoctor(repoDir);
    const indexedDetail = findSourceDetail(first, "bad_validation.ts");
    assert(indexedDetail, "Source should appear in sourceDetails");
    assertEquals(indexedDetail.stateTag, "Indexed");

    await Deno.writeTextFile(modelPath, VALIDATION_FAILING_MODEL);
    const second = await runDoctor(repoDir, { allowNonZero: true });
    const failedDetail = findSourceDetail(second, "bad_validation.ts");
    assert(failedDetail, "Source should appear after corruption");
    assertEquals(failedDetail.stateTag, "ValidationFailed");
  });
});

// AC 3: deleted source file for pulled extension → EntryPointUnreadable
Deno.test("doctor extensions: deleted pulled source produces EntryPointUnreadable in sourceDetails", async () => {
  await withTestRepo(async (repoDir) => {
    const extName = "@test/pulled-ext";
    const extRoot = join(repoDir, ".swamp", "pulled-extensions", extName);
    const modelDir = join(extRoot, "models");
    await ensureDir(modelDir);
    const modelPath = join(modelDir, "pulled_model.ts");

    await Deno.writeTextFile(
      modelPath,
      VALID_MODEL.replace(
        "@tutorial/failure-test",
        "@test/pulled-model",
      ),
    );

    // Create lockfile entry in the default models dir (extensions/models/)
    const lockfileDir = join(repoDir, "extensions", "models");
    await ensureDir(lockfileDir);
    const lockfilePath = join(lockfileDir, "upstream_extensions.json");
    const lockfile: Record<string, unknown> = {};
    lockfile[extName] = {
      version: "2026.05.12.0",
      pulledAt: new Date().toISOString(),
    };
    await Deno.writeTextFile(lockfilePath, JSON.stringify(lockfile, null, 2));

    const first = await runDoctor(repoDir);
    const indexedDetail = findSourceDetail(first, "pulled_model.ts");
    assert(indexedDetail, "Pulled source should appear in sourceDetails");
    assertEquals(indexedDetail.stateTag, "Indexed");

    // Delete the source file, keep the lockfile entry
    await Deno.remove(modelPath);
    const second = await runDoctor(repoDir, { allowNonZero: true });
    const missingDetail = findSourceDetail(second, "pulled_model.ts");
    assert(
      missingDetail,
      "Source should remain in sourceDetails after deletion",
    );
    assertEquals(missingDetail.stateTag, "EntryPointUnreadable");
  });
});

// AC 4: deleted local source with bundle → OrphanedBundleOnly
Deno.test("doctor extensions: deleted local source with bundle produces OrphanedBundleOnly", async () => {
  await withTestRepo(async (repoDir) => {
    const modelDir = join(repoDir, "extensions", "models");
    await ensureDir(modelDir);
    const modelPath = join(modelDir, "ephemeral_model.ts");

    await Deno.writeTextFile(
      modelPath,
      VALID_MODEL.replace(
        "@tutorial/failure-test",
        "@tutorial/ephemeral",
      ),
    );

    const first = await runDoctor(repoDir);
    const indexedDetail = findSourceDetail(first, "ephemeral_model.ts");
    assert(indexedDetail, "Source should appear in sourceDetails");
    assertEquals(indexedDetail.stateTag, "Indexed");

    // Delete the source file, leave the bundle on disk
    await Deno.remove(modelPath);
    const second = await runDoctor(repoDir);
    const orphanDetail = findSourceDetail(second, "ephemeral_model.ts");
    assert(
      orphanDetail,
      "Source should remain in sourceDetails after deletion",
    );
    assertEquals(orphanDetail.stateTag, "OrphanedBundleOnly");
  });
});

// Recovery path — ValidationFailed → valid content → Indexed (#340)
Deno.test("doctor extensions: ValidationFailed recovers to Indexed when source is fixed", async () => {
  await withTestRepo(async (repoDir) => {
    const modelDir = join(repoDir, "extensions", "models");
    await ensureDir(modelDir);
    const modelPath = join(modelDir, "recovery_model.ts");

    // Start valid → Indexed
    await Deno.writeTextFile(
      modelPath,
      VALID_MODEL.replace(
        "@tutorial/failure-test",
        "@tutorial/recovery",
      ),
    );
    const first = await runDoctor(repoDir);
    const indexed = findSourceDetail(first, "recovery_model.ts");
    assert(indexed);
    assertEquals(indexed.stateTag, "Indexed");

    // Corrupt → ValidationFailed
    await Deno.writeTextFile(modelPath, SCHEMA_INVALID_MODEL);
    const second = await runDoctor(repoDir, { allowNonZero: true });
    const failed = findSourceDetail(second, "recovery_model.ts");
    assert(failed);
    assertEquals(failed.stateTag, "ValidationFailed");

    // Fix → Indexed again
    await Deno.writeTextFile(
      modelPath,
      VALID_MODEL.replace(
        "@tutorial/failure-test",
        "@tutorial/recovery",
      ),
    );
    const third = await runDoctor(repoDir);
    const recovered = findSourceDetail(third, "recovery_model.ts");
    assert(recovered);
    assertEquals(recovered.stateTag, "Indexed");
    assertNotEquals(
      recovered.fingerprint,
      failed.fingerprint,
      "Fingerprint should change from ValidationFailed to Indexed",
    );
  });
});

// Fingerprint assertion — ValidationFailed stores current source fingerprint (#340)
Deno.test("doctor extensions: ValidationFailed stores current source fingerprint", async () => {
  await withTestRepo(async (repoDir) => {
    const modelDir = join(repoDir, "extensions", "models");
    await ensureDir(modelDir);
    const modelPath = join(modelDir, "fp_model.ts");

    await Deno.writeTextFile(
      modelPath,
      VALID_MODEL.replace("@tutorial/failure-test", "@tutorial/fp-check"),
    );
    const first = await runDoctor(repoDir);
    const indexed = findSourceDetail(first, "fp_model.ts");
    assert(indexed);
    assertEquals(indexed.stateTag, "Indexed");
    const indexedFingerprint = indexed.fingerprint;
    assert(indexedFingerprint, "Indexed source should have a fingerprint");

    await Deno.writeTextFile(modelPath, SCHEMA_INVALID_MODEL);
    const second = await runDoctor(repoDir, { allowNonZero: true });
    const failed = findSourceDetail(second, "fp_model.ts");
    assert(failed);
    assertEquals(failed.stateTag, "ValidationFailed");

    assert(
      failed.fingerprint,
      "ValidationFailed source should have a fingerprint",
    );
    assertNotEquals(
      failed.fingerprint,
      indexedFingerprint,
      "ValidationFailed fingerprint must differ from the prior Indexed fingerprint",
    );
  });
});

// #340 regression: unresolvable import → BundleBuildFailed (not ValidationFailed)
Deno.test("doctor extensions: unresolvable import produces BundleBuildFailed in sourceDetails", async () => {
  await withTestRepo(async (repoDir) => {
    const modelDir = join(repoDir, "extensions", "models");
    await ensureDir(modelDir);
    const modelPath = join(modelDir, "bad_import.ts");

    await Deno.writeTextFile(
      modelPath,
      VALID_MODEL.replace(
        "@tutorial/failure-test",
        "@tutorial/bad-import-test",
      ),
    );
    const first = await runDoctor(repoDir);
    const indexed = findSourceDetail(first, "bad_import.ts");
    assert(indexed, "Source should appear in sourceDetails");
    assertEquals(indexed.stateTag, "Indexed");

    // Delete cached bundles so the fallback path doesn't reuse the valid bundle
    const bundlesDir = join(repoDir, ".swamp", "bundles");
    await Deno.remove(bundlesDir, { recursive: true }).catch(() => {});

    await Deno.writeTextFile(modelPath, UNRESOLVABLE_IMPORT_MODEL);
    const second = await runDoctor(repoDir, { allowNonZero: true });
    const failed = findSourceDetail(second, "bad_import.ts");
    assert(failed, "Source should appear after corruption");
    assertEquals(
      failed.stateTag,
      "BundleBuildFailed",
      "Unresolvable import must produce BundleBuildFailed, not ValidationFailed",
    );
  });
});

// #340: BundleBuildFailed recovery — unresolvable import → fix → Indexed
Deno.test("doctor extensions: BundleBuildFailed recovers to Indexed when import is fixed", async () => {
  await withTestRepo(async (repoDir) => {
    const modelDir = join(repoDir, "extensions", "models");
    await ensureDir(modelDir);
    const modelPath = join(modelDir, "import_recovery.ts");

    await Deno.writeTextFile(
      modelPath,
      VALID_MODEL.replace(
        "@tutorial/failure-test",
        "@tutorial/import-recovery",
      ),
    );
    const first = await runDoctor(repoDir);
    const indexed = findSourceDetail(first, "import_recovery.ts");
    assert(indexed);
    assertEquals(indexed.stateTag, "Indexed");

    // Delete cached bundles so the fallback path doesn't reuse the valid bundle
    const bundlesDir = join(repoDir, ".swamp", "bundles");
    await Deno.remove(bundlesDir, { recursive: true }).catch(() => {});

    await Deno.writeTextFile(modelPath, UNRESOLVABLE_IMPORT_MODEL);
    const second = await runDoctor(repoDir, { allowNonZero: true });
    const failed = findSourceDetail(second, "import_recovery.ts");
    assert(failed);
    assertEquals(failed.stateTag, "BundleBuildFailed");

    await Deno.writeTextFile(
      modelPath,
      VALID_MODEL.replace(
        "@tutorial/failure-test",
        "@tutorial/import-recovery",
      ),
    );
    const third = await runDoctor(repoDir);
    const recovered = findSourceDetail(third, "import_recovery.ts");
    assert(recovered);
    assertEquals(recovered.stateTag, "Indexed");
  });
});

// W7: lastError populates on failure and clears on recovery
Deno.test("doctor extensions: lastError populates on failure and clears on recovery", async () => {
  await withTestRepo(async (repoDir) => {
    const modelDir = join(repoDir, "extensions", "models");
    await ensureDir(modelDir);
    const modelPath = join(modelDir, "last_error_lifecycle.ts");

    await Deno.writeTextFile(modelPath, SCHEMA_INVALID_MODEL);
    const failed = await runDoctor(repoDir, { allowNonZero: true });
    const failedDetail = findSourceDetail(failed, "last_error_lifecycle.ts");
    assert(failedDetail, "Source should appear in sourceDetails");
    assert(
      failedDetail.stateTag === "BundleBuildFailed" ||
        failedDetail.stateTag === "ValidationFailed",
      `Expected failure state, got ${failedDetail.stateTag}`,
    );
    assert(
      failedDetail.lastError && failedDetail.lastError.length > 0,
      `lastError must be populated on failure, got: ${
        JSON.stringify(failedDetail.lastError)
      }`,
    );

    await Deno.writeTextFile(
      modelPath,
      VALID_MODEL.replace(
        "@tutorial/failure-test",
        "@tutorial/last-error-lifecycle",
      ),
    );
    const recovered = await runDoctor(repoDir);
    const recoveredDetail = findSourceDetail(
      recovered,
      "last_error_lifecycle.ts",
    );
    assert(recoveredDetail, "Source should appear after recovery");
    assertEquals(recoveredDetail.stateTag, "Indexed");
    assertEquals(
      recoveredDetail.lastError,
      undefined,
      "lastError must be absent from sourceDetails after recovery to Indexed",
    );
  });
});

// Addition 3: smoke perf check — >=10 extensions must complete in <30s
Deno.test("doctor extensions: reconcile with >=10 extensions completes in <30s", async () => {
  await withTestRepo(async (repoDir) => {
    const modelDir = join(repoDir, "extensions", "models");
    await ensureDir(modelDir);

    for (let i = 0; i < 12; i++) {
      await Deno.writeTextFile(
        join(modelDir, `perf_model_${i}.ts`),
        VALID_MODEL
          .replace("@tutorial/failure-test", `@tutorial/perf-${i}`)
          .replace("2026.05.12.0", `2026.05.12.${i}`),
      );
    }

    const start = Date.now();
    const result = await runDoctor(repoDir);
    const elapsed = Date.now() - start;

    assert(
      elapsed < 30_000,
      `doctor with 12 extensions took ${elapsed}ms, expected <30000ms`,
    );
    assertEquals(result.overallStatus, "pass");
    assert(
      result.aggregateState.totalSources >= 12,
      `Expected >=12 sources, got ${result.aggregateState.totalSources}`,
    );
  });
});

// #351: non-literal type field → warnings-only (overallStatus=pass, exit 0, warnings populated)
Deno.test("doctor extensions: non-literal type field appears in warnings[] without failing", async () => {
  await withTestRepo(async (repoDir) => {
    const modelDir = join(repoDir, "extensions", "models");
    await ensureDir(modelDir);
    await Deno.writeTextFile(
      join(modelDir, "non_literal.ts"),
      NON_LITERAL_TYPE_MODEL,
    );

    const result = await runDoctor(repoDir);
    assertEquals(
      result.overallStatus,
      "pass",
      "overallStatus must be pass — type-extraction warnings are advisory",
    );

    assert(
      Array.isArray(result.warnings),
      "report must include a warnings array",
    );
    const typeWarning = result.warnings.find((w) =>
      w.sourcePath.includes("non_literal.ts")
    );
    assert(
      typeWarning !== undefined,
      `expected warnings[] to contain non_literal.ts; got: ${
        JSON.stringify(result.warnings)
      }`,
    );
    assertEquals(typeWarning!.category, "TypeExtractionFailed");
  });
});
