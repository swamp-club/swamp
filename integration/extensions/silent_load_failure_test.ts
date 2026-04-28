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

// Regression guard for swamp-club#177.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { initializeTestRepo, runCliCommand } from "../test_helpers.ts";

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

// Missing version field — fails validation in loadModels (result.failed).
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

// Type comes from a constant, not a string literal — the catalog's
// regex-based type extractor cannot match, so populateCatalogFromDir
// silently skips this file unless the new emit is wired in.
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

Deno.test(
  "silent load failure: stderr surfaces both failure modes; working model loads",
  async () => {
    const repoDir = await Deno.makeTempDir({
      prefix: "swamp-issue-177-test-",
    });
    try {
      await initializeTestRepo(repoDir);
      const modelsDir = join(repoDir, "extensions", "models");
      await ensureDir(modelsDir);
      await Deno.writeTextFile(
        join(modelsDir, "working.ts"),
        VALID_MODEL,
      );
      await Deno.writeTextFile(
        join(modelsDir, "missing_version.ts"),
        BAD_MODEL_VALIDATION,
      );
      await Deno.writeTextFile(
        join(modelsDir, "non_literal_type.ts"),
        BAD_MODEL_REGEX,
      );

      const { stdout, stderr } = await runCliCommand(
        ["--json", "model", "type", "search"],
        repoDir,
      );

      // Working model is in stdout regardless of broken siblings.
      const search = JSON.parse(stdout);
      const types = (search.results as Array<{ normalized: string }>).map((
        r,
      ) => r.normalized);
      assertEquals(
        types.includes("@tutorial/working"),
        true,
        "valid model must appear in type search despite broken siblings",
      );

      const warningLines = stderr.split("\n").filter((l) =>
        l.startsWith("swamp-warning:")
      );
      const hintLines = stderr.split("\n").filter((l) =>
        l.trimStart().startsWith("hint:")
      );

      // Each broken file produces exactly one warning line. The validation
      // path may emit twice (once during loadModels, once during the
      // populate pass) — assert AT LEAST one per broken file rather than
      // pin an exact count.
      const validationWarning = warningLines.find((l) =>
        l.includes("missing_version.ts")
      );
      const regexWarning = warningLines.find((l) =>
        l.includes("non_literal_type.ts")
      );
      assertEquals(
        typeof validationWarning,
        "string",
        `expected stderr to name missing_version.ts; got: ${stderr}`,
      );
      assertEquals(
        typeof regexWarning,
        "string",
        `expected stderr to name non_literal_type.ts; got: ${stderr}`,
      );
      assertStringIncludes(validationWarning!, "version");
      assertStringIncludes(regexWarning!, "string literal");

      // Hint is emitted at most once per kind. Two model failures share
      // one hint line.
      assertEquals(
        hintLines.length,
        1,
        `expected exactly one hint line; got ${hintLines.length}: ${
          hintLines.join(" | ")
        }`,
      );
      assertStringIncludes(hintLines[0], "extensions/models/");
      assertStringIncludes(hintLines[0], "auto-discovered");

      // Working model is not named in any warning line.
      const workingMentioned = warningLines.some((l) =>
        l.includes("working.ts")
      );
      assertEquals(
        workingMentioned,
        false,
        "working model must not appear in warning lines",
      );
    } finally {
      await Deno.remove(repoDir, { recursive: true });
    }
  },
);
