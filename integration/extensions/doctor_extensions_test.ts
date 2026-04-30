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

// End-to-end coverage for `swamp doctor extensions` (swamp-club#180).
// Each test uses a fresh repo because `kind: "extension"` warnings
// only fire on the catalog-population path
// (user_model_loader.ts:populateCatalogFromDir), which only runs when
// the bundle catalog is empty. A warmed catalog from a previous run
// would skip the populate path and the fold rule would not be
// exercised end-to-end.

import { assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { basename, join } from "@std/path";
import { initializeTestRepo, runCliCommand } from "../test_helpers.ts";

// Valid model with a quoted `type` literal — loads cleanly. Fixture
// (d) extends THIS model, so it must always appear so that the
// extension's `processExtension` succeeds at runtime (otherwise the
// "Cannot extend unregistered model type" failure short-circuits to
// retryable+log-only and never reaches the captured warnings array).
const VALID_MODEL = `
import { z } from "npm:zod@4";
export const model = {
  type: "@tutorial/working",
  version: "2026.04.28.0",
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

// Missing `version` — fails Zod validation in loadModels. Recorded
// under kind=model.
const BAD_MODEL_VALIDATION = `
import { z } from "npm:zod@4";
export const model = {
  type: "@tutorial/missing-version",
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

// `type` field is a const, not a literal — populateCatalogFromDir's
// regex cannot extract it. Recorded under kind=model.
const BAD_MODEL_REGEX = `
import { z } from "npm:zod@4";
const TYPE = "@tutorial/non-literal-type";
export const model = {
  type: TYPE,
  version: "2026.04.28.0",
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

// EXTENSION (not model) with a non-literal `type`. This is the only
// fixture that triggers `emitTypeExtractionFailure(file, "extension")`
// — recorded under kind=extension by populateCatalogFromDir. The
// doctor service must fold this into the model registry's row.
//
// The extension targets the type from VALID_MODEL so processExtension
// succeeds at runtime; the catalog-population regex still fails on
// the source text because TYPE is a const reference.
const BAD_EXTENSION_REGEX = `
import { z } from "npm:zod@4";
const TYPE = "@tutorial/working";
export const extension = {
  type: TYPE,
  methods: [{
    extra: {
      description: "no-op extension method",
      arguments: z.object({}),
      execute: () => ({ dataHandles: [] }),
    },
  }],
};
`;

interface DoctorJson {
  overallStatus: "pass" | "fail";
  registries: Record<
    string,
    {
      status: "pass" | "fail";
      failures: Array<{ file: string; error: string }>;
    }
  >;
}

function findFailureFor(
  failures: Array<{ file: string; error: string }>,
  needle: string,
): { file: string; error: string } | undefined {
  return failures.find((f) => f.file.includes(needle));
}

Deno.test(
  "doctor extensions: failing fixtures land under the model row (model+extension fold), all five registries reported",
  async () => {
    const repoDir = await Deno.makeTempDir({
      prefix: "swamp-issue-180-fail-",
    });
    try {
      await initializeTestRepo(repoDir);
      const modelsDir = join(repoDir, "extensions", "models");
      await ensureDir(modelsDir);
      await Deno.writeTextFile(join(modelsDir, "working.ts"), VALID_MODEL);
      await Deno.writeTextFile(
        join(modelsDir, "missing_version.ts"),
        BAD_MODEL_VALIDATION,
      );
      await Deno.writeTextFile(
        join(modelsDir, "non_literal_type.ts"),
        BAD_MODEL_REGEX,
      );
      await Deno.writeTextFile(
        join(modelsDir, "non_literal_type_extension.ts"),
        BAD_EXTENSION_REGEX,
      );

      // Run the doctor as the FIRST swamp command in this repo so the
      // bundle catalog is empty when ensureLoaded() runs.
      const { stdout, code } = await runCliCommand(
        ["--json", "doctor", "extensions"],
        repoDir,
      );

      // The doctor command's JSON mode emits a single pretty-printed
      // object on stdout. Find the first `{` to skip any cliffy
      // bootstrap chatter (there shouldn't be any with --json, but
      // defensive).
      const firstBrace = stdout.indexOf("{");
      const slice = stdout.slice(firstBrace);
      const parsed = JSON.parse(slice) as DoctorJson;

      assertEquals(
        code,
        1,
        `expected exit 1; got code=${code}, stdout=${stdout}`,
      );
      assertEquals(parsed.overallStatus, "fail");

      // All five registry keys present.
      const keys = Object.keys(parsed.registries).sort();
      assertEquals(
        keys,
        ["datastore", "driver", "model", "report", "vault"],
      );

      // The non-model registries pass with empty failure arrays.
      assertEquals(parsed.registries.vault.status, "pass");
      assertEquals(parsed.registries.driver.status, "pass");
      assertEquals(parsed.registries.datastore.status, "pass");
      assertEquals(parsed.registries.report.status, "pass");
      assertEquals(parsed.registries.vault.failures.length, 0);
      assertEquals(parsed.registries.driver.failures.length, 0);
      assertEquals(parsed.registries.datastore.failures.length, 0);
      assertEquals(parsed.registries.report.failures.length, 0);

      // The model registry's row absorbs the kind=model failures (b, c)
      // AND the kind=extension failure (d) thanks to the fold.
      const modelRow = parsed.registries.model;
      assertEquals(modelRow.status, "fail");

      const validationFailure = findFailureFor(
        modelRow.failures,
        "missing_version.ts",
      );
      const regexFailure = findFailureFor(
        modelRow.failures,
        "non_literal_type.ts",
      );
      const extensionFailure = findFailureFor(
        modelRow.failures,
        "non_literal_type_extension.ts",
      );

      assertEquals(
        typeof validationFailure?.file,
        "string",
        `expected missing_version.ts under model row; got: ${
          JSON.stringify(modelRow.failures)
        }`,
      );
      assertEquals(
        typeof regexFailure?.file,
        "string",
        `expected non_literal_type.ts under model row; got: ${
          JSON.stringify(modelRow.failures)
        }`,
      );
      assertEquals(
        typeof extensionFailure?.file,
        "string",
        `expected non_literal_type_extension.ts under model row (proves model+extension fold); got: ${
          JSON.stringify(modelRow.failures)
        }`,
      );
    } finally {
      await Deno.remove(repoDir, { recursive: true });
    }
  },
);

Deno.test(
  "doctor extensions: clean repo passes with all five registries empty",
  async () => {
    const repoDir = await Deno.makeTempDir({
      prefix: "swamp-issue-180-pass-",
    });
    try {
      await initializeTestRepo(repoDir);
      // No fixtures — clean repo.

      const { stdout, code } = await runCliCommand(
        ["--json", "doctor", "extensions"],
        repoDir,
      );

      const firstBrace = stdout.indexOf("{");
      const slice = stdout.slice(firstBrace);
      const parsed = JSON.parse(slice) as DoctorJson;

      assertEquals(
        code,
        0,
        `expected exit 0; got code=${code}, stdout=${stdout}`,
      );
      assertEquals(parsed.overallStatus, "pass");

      // All five registry keys still present, all empty.
      const keys = Object.keys(parsed.registries).sort();
      assertEquals(
        keys,
        ["datastore", "driver", "model", "report", "vault"],
      );
      for (const key of keys) {
        assertEquals(parsed.registries[key].status, "pass");
        assertEquals(parsed.registries[key].failures.length, 0);
      }
    } finally {
      await Deno.remove(repoDir, { recursive: true });
    }
  },
);

Deno.test(
  "doctor extensions: log mode exits non-zero on failing fixtures",
  async () => {
    const repoDir = await Deno.makeTempDir({
      prefix: "swamp-issue-180-log-",
    });
    try {
      await initializeTestRepo(repoDir);
      const modelsDir = join(repoDir, "extensions", "models");
      await ensureDir(modelsDir);
      await Deno.writeTextFile(
        join(modelsDir, "missing_version.ts"),
        BAD_MODEL_VALIDATION,
      );

      const { code } = await runCliCommand(
        ["doctor", "extensions"],
        repoDir,
      );

      assertEquals(code, 1, `expected exit 1 in log mode on failure`);
    } finally {
      await Deno.remove(repoDir, { recursive: true });
    }
  },
);

Deno.test(
  "doctor extensions: repeat invocation in same repo reports the same failures (catalog-rescan regression guard)",
  async () => {
    // The bundle catalog short-circuits ensureLoaded() when populated,
    // which would silently hide failures on a second invocation. The
    // doctor command invalidates the catalog before each run; this
    // test guards against regression of that fix.
    const repoDir = await Deno.makeTempDir({
      prefix: "swamp-issue-180-repeat-",
    });
    try {
      await initializeTestRepo(repoDir);
      const modelsDir = join(repoDir, "extensions", "models");
      await ensureDir(modelsDir);
      await Deno.writeTextFile(join(modelsDir, "working.ts"), VALID_MODEL);
      await Deno.writeTextFile(
        join(modelsDir, "missing_version.ts"),
        BAD_MODEL_VALIDATION,
      );
      await Deno.writeTextFile(
        join(modelsDir, "non_literal_type_extension.ts"),
        BAD_EXTENSION_REGEX,
      );

      // First invocation — catalog starts empty, populates during this run.
      const first = await runCliCommand(
        ["--json", "doctor", "extensions"],
        repoDir,
      );
      const firstParsed = JSON.parse(
        first.stdout.slice(first.stdout.indexOf("{")),
      ) as DoctorJson;

      // Second invocation — catalog now populated. Without the
      // doctor's catalog-rescan, this would short-circuit and report pass.
      const second = await runCliCommand(
        ["--json", "doctor", "extensions"],
        repoDir,
      );
      const secondParsed = JSON.parse(
        second.stdout.slice(second.stdout.indexOf("{")),
      ) as DoctorJson;

      assertEquals(
        first.code,
        1,
        `first run expected exit 1; got ${first.code}, stdout=${first.stdout}`,
      );
      assertEquals(
        second.code,
        1,
        `second run expected exit 1 (catalog-rescan regression?); got ${second.code}, stdout=${second.stdout}`,
      );
      assertEquals(firstParsed.overallStatus, "fail");
      assertEquals(secondParsed.overallStatus, "fail");

      // The second run must surface the same failure files as the first.
      // Use basename() so the comparison works regardless of host separator.
      const firstFiles = firstParsed.registries.model.failures
        .map((f) => basename(f.file))
        .sort();
      const secondFiles = secondParsed.registries.model.failures
        .map((f) => basename(f.file))
        .sort();
      assertEquals(
        firstFiles,
        secondFiles,
        "second invocation must report the same failures as the first",
      );
      // Both files we expect to fail are present (validation + extension fold).
      assertEquals(
        secondFiles.includes("missing_version.ts"),
        true,
      );
      assertEquals(
        secondFiles.includes("non_literal_type_extension.ts"),
        true,
      );
    } finally {
      await Deno.remove(repoDir, { recursive: true });
    }
  },
);
