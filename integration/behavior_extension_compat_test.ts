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

// a behavior-spelled extension must send exactly what its model-spelled twin
// sends, and model-spelled ones what they sent before the alias (the goldens)

import { assert, assertEquals } from "@std/assert";
import { EXTENSION_FIXTURES } from "./test_helpers/behavior_extension/fixtures.ts";
import {
  EXTENSION_GOLDEN_PATH,
  snapshotFixture,
} from "./test_helpers/behavior_extension/corpus.ts";

Deno.test("behavior extension goldens: model-spelled extensions push byte-identically", async () => {
  const golden = JSON.parse(
    await Deno.readTextFile(EXTENSION_GOLDEN_PATH),
  ) as Record<string, unknown>;
  assertEquals(
    EXTENSION_FIXTURES.map((f) => f.id).sort(),
    Object.keys(golden).sort(),
  );
  for (const fixture of EXTENSION_FIXTURES) {
    // JSON text, not deep equality: key order is what the registry receives.
    assertEquals(
      JSON.stringify(await snapshotFixture(fixture, "model")),
      JSON.stringify(golden[fixture.id]),
      fixture.id,
    );
  }
});

Deno.test("behavior extension twins: a behavior-spelled extension sends what its model-spelled twin sends", async () => {
  for (const fixture of EXTENSION_FIXTURES) {
    const model = await snapshotFixture(fixture, "model");
    const behavior = await snapshotFixture(fixture, "behavior");
    assertEquals(
      JSON.stringify(behavior.extractor),
      JSON.stringify(model.extractor),
      `${fixture.id}: extractor metadata`,
    );
    assertEquals(
      behavior.catalogGaps,
      model.catalogGaps,
      `${fixture.id}: catalog gaps`,
    );
    assertEquals(
      JSON.stringify(behavior.contentMetadata),
      JSON.stringify(model.contentMetadata),
      `${fixture.id}: content metadata`,
    );
    assertEquals(
      behavior.archive.files,
      model.archive.files,
      `${fixture.id}: archive listing`,
    );
    assert(
      behavior.archive.files.every((f) => !f.includes("behaviors/")),
      `${fixture.id}: no behaviors/ path in the archive`,
    );
    assertEquals(
      behavior.archive.manifest,
      model.archive.manifest,
      `${fixture.id}: re-emitted manifest`,
    );
    // non-source files are byte-identical; the dependency audit record holds
    // each bundle's hash and bundles differ by export name, so it is compared
    // without them
    for (const [file, sha] of Object.entries(model.archive.sha256)) {
      if (file.endsWith(".ts") || file.endsWith(".js")) continue;
      if (file.endsWith("dependency-audit.json")) {
        assertEquals(
          behavior.archive.auditRecord,
          model.archive.auditRecord,
          `${fixture.id}: ${file} without bundle hashes`,
        );
        continue;
      }
      assertEquals(
        behavior.archive.sha256[file],
        sha,
        `${fixture.id}: ${file}`,
      );
    }
    const spelled = behavior.reviewWarnings.filter((w) =>
      w.ruleId === "behavior-spelling"
    );
    assertEquals(spelled.length, 1, `${fixture.id}: behavior-spelling once`);
    assertEquals(spelled[0].file, "(extension)");
    assertEquals(
      behavior.reviewWarnings
        .filter((w) => w.ruleId !== "behavior-spelling")
        .map((w) => ({
          ...w,
          file: w.file.replace("extensions/behaviors/", "extensions/models/"),
          message: w.message.replaceAll(
            "export const behavior",
            "export const model",
          ),
        })),
      model.reviewWarnings,
      `${fixture.id}: review findings`,
    );
    assertEquals(
      model.reviewWarnings.some((w) => w.ruleId === "behavior-spelling"),
      false,
    );
  }
});
