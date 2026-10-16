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
import {
  belowRedactorMinimum,
  CANARY_CLASSES,
  classifyValue,
  generateCanaries,
  generateCanary,
  REDACTOR_MIN_LENGTH,
  registerCountingVault,
} from "./canary_values.ts";
import { SecretRedactor } from "../src/domain/secrets/secret_redactor.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";

Deno.test("generateCanaries: yields one canary per class", () => {
  const canaries = generateCanaries();
  assertEquals(canaries.map((c) => c.class), [...CANARY_CLASSES]);
});

Deno.test("generateCanary: unique classes differ between runs and keep a searchable half", () => {
  for (const canaryClass of CANARY_CLASSES) {
    const first = generateCanary(canaryClass);
    if (!first.unique) continue;
    const second = generateCanary(canaryClass);
    assertNotEquals(first.value, second.value, canaryClass);
    assert(first.value.startsWith("cnr"), canaryClass);
    assert(first.value.length >= REDACTOR_MIN_LENGTH, canaryClass);
  }
});

Deno.test("generateCanary: short classes fall below the redactor minimum", () => {
  for (const canaryClass of ["empty", "one-char", "two-char", "astral-pair"]) {
    const canary = generateCanary(canaryClass as typeof CANARY_CLASSES[number]);
    assert(belowRedactorMinimum(canary), canaryClass);
    assertEquals(canary.unique, false, canaryClass);
  }
  // One astral character, two code units.
  const astral = generateCanary("astral-pair");
  assertEquals([...astral.value].length, 1);
  assertEquals(astral.value.length, 2);
});

Deno.test("generateCanary: the redactor masks every unique class and ignores every short one", () => {
  for (const canary of generateCanaries()) {
    const redactor = new SecretRedactor();
    redactor.addSecret(canary.value);
    const text = `before ${canary.value} after`;
    if (belowRedactorMinimum(canary)) {
      assertEquals(redactor.redact(text), text, canary.class);
    } else {
      assertEquals(redactor.redact(text), "before *** after", canary.class);
    }
  }
});

Deno.test("classifyValue: exact equality wins over the shape a canary imitates", () => {
  for (const canary of generateCanaries()) {
    assertEquals(
      classifyValue(canary.value, canary),
      "plaintext",
      canary.class,
    );
  }
});

Deno.test("classifyValue: names the engine-1 stand-ins", () => {
  const canary = generateCanary("quotes");
  assertEquals(classifyValue(undefined, canary), "absent");
  assertEquals(
    classifyValue(`__SWAMP_VSEC_${"0a1b2c3d".repeat(4)}_7__`, canary),
    "sentinel",
  );
  assertEquals(
    classifyValue("${{ vault.get('canary', 'k') }}", canary),
    "reference",
  );
  assertEquals(classifyValue("sensitive-canary.k", canary), "placeholder");
  assertEquals(classifyValue("***", canary), "mask");
  assertEquals(classifyValue(42, canary), "other");
});

Deno.test("registerCountingVault: serves canaries, counts reads, and unregisters", async () => {
  const canary = generateCanary("bmp-unicode");
  const vault = registerCountingVault({ k: canary.value });
  try {
    const service = new VaultService();
    service.registerVault({ name: "canary", type: vault.type, config: {} });
    assertEquals(await service.get("canary", "k"), canary.value);
    assertEquals(await service.get("canary", "k"), canary.value);
    assertEquals(vault.readsOf("k"), 2);
    assertEquals(vault.reads, [
      { vault: "canary", key: "k" },
      { vault: "canary", key: "k" },
    ]);
  } finally {
    vault.dispose();
  }
});
