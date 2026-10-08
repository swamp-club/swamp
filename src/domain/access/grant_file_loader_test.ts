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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  readConditionTypeLiterals,
  validateGrantCondition,
} from "../../infrastructure/cel/grant_condition_environment.ts";
import {
  checkServeGrantFiles,
  readServeGrantFiles,
} from "./grant_file_loader.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const OPTIONS = {
  validateCondition: validateGrantCondition,
  readTypeLiterals: readConditionTypeLiterals,
};

const VALID = `
grants:
  - subject: user:adam
    effect: allow
    actions: [run]
    resource: "model:@acme/*"
`;

const MISSPELLED_DENY = `
grants:
  - subject: user:adam
    effect: deny
    actions: [run]
    resource: "model:AWS::EC2::*"
`;

const INVALID = `
grants:
  - subject: user:adam
    effect: allow
    actions: [fly]
    resource: "model:*"
`;

Deno.test("readServeGrantFiles: reads grants/, grants-file and grants-dir as serve resolves them", async () => {
  await withTempDir(async (repoDir) => {
    await ensureDir(join(repoDir, "grants"));
    await ensureDir(join(repoDir, "extra"));
    await Deno.writeTextFile(join(repoDir, "grants", "a.yaml"), VALID);
    await Deno.writeTextFile(join(repoDir, "external.yaml"), VALID);
    await Deno.writeTextFile(join(repoDir, "extra", "b.yaml"), VALID);
    await Deno.writeTextFile(join(repoDir, "extra", "empty.yaml"), "  \n");

    const files = await readServeGrantFiles(repoDir, {
      ...OPTIONS,
      grantsFile: "external.yaml",
      grantsDir: "extra",
    });

    assertEquals([...files.repo.keys()], ["a.yaml"]);
    assertEquals(files.grantsFile?.status, "loaded");
    if (files.grantsDir?.status !== "loaded") throw new Error("not loaded");
    assertEquals(
      files.grantsDir.files.map((f) => [f.sourceName, f.result === null]),
      [["grants-dir/b.yaml", false], ["grants-dir/empty.yaml", true]],
    );
    assertEquals(checkServeGrantFiles(files), { errors: [], warnings: [] });
  });
});

Deno.test("readServeGrantFiles: a grants-dir that is the repository grants/ is read once", async () => {
  await withTempDir(async (repoDir) => {
    await ensureDir(join(repoDir, "grants"));
    const files = await readServeGrantFiles(repoDir, {
      ...OPTIONS,
      grantsDir: "grants",
    });
    assertEquals(files.grantsDir, {
      status: "same-as-repo",
      configured: "grants",
    });
  });
});

Deno.test("checkServeGrantFiles: an invalid entry is an error, a misspelled type a warning", async () => {
  await withTempDir(async (repoDir) => {
    await ensureDir(join(repoDir, "grants"));
    await Deno.writeTextFile(join(repoDir, "grants", "bad.yaml"), INVALID);
    await Deno.writeTextFile(
      join(repoDir, "grants", "spelled.yaml"),
      MISSPELLED_DENY,
    );
    const check = checkServeGrantFiles(
      await readServeGrantFiles(repoDir, OPTIONS),
    );
    assertEquals(check.errors.map((e) => e.file), [join("grants", "bad.yaml")]);
    assertEquals(check.warnings.length, 1);
    assertEquals(check.warnings[0].file, join("grants", "spelled.yaml"));
    assertEquals(check.warnings[0].entry, 1);
    assertStringIncludes(check.warnings[0].message, "model:aws/ec2/*");
  });
});

Deno.test("checkServeGrantFiles: an external source absent here is a warning, not an error", async () => {
  await withTempDir(async (repoDir) => {
    const check = checkServeGrantFiles(
      await readServeGrantFiles(repoDir, {
        ...OPTIONS,
        grantsFile: "absent.yaml",
        grantsDir: "absent-dir",
      }),
    );
    assertEquals(check.errors, []);
    assertEquals(check.warnings.length, 2);
    assertStringIncludes(check.warnings[0].message, "Grants file not found");
    assertStringIncludes(
      check.warnings[1].message,
      "Grants directory not found",
    );
  });
});

Deno.test("checkServeGrantFiles: invalid grants-file and grants-dir entries are errors", async () => {
  await withTempDir(async (repoDir) => {
    await ensureDir(join(repoDir, "extra"));
    await Deno.writeTextFile(join(repoDir, "external.yaml"), INVALID);
    await Deno.writeTextFile(join(repoDir, "extra", "c.yaml"), INVALID);
    const check = checkServeGrantFiles(
      await readServeGrantFiles(repoDir, {
        ...OPTIONS,
        grantsFile: "external.yaml",
        grantsDir: "extra",
      }),
    );
    assertEquals(check.errors.length, 2);
  });
});
