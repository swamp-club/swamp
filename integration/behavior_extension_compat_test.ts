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

// Extension authors may use the behavior spelling — export const behavior,
// extensions/behaviors/ and the behaviors: manifest key — as an exact
// synonym of the model spelling (swamp-club#3338). The registry keys on what
// push sends, so a behavior-spelled extension must send exactly what its
// model-spelled twin sends, and every model-spelled extension must send
// what it sent before the alias existed (the goldens).

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
    // Non-source files (manifest, include data) are byte-identical.
    for (const [file, sha] of Object.entries(model.archive.sha256)) {
      if (file.endsWith(".ts") || file.endsWith(".js")) continue;
      assertEquals(
        behavior.archive.sha256[file],
        sha,
        `${fixture.id}: ${file}`,
      );
    }
    // The same findings, plus the one behavior-spelling warning.
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
