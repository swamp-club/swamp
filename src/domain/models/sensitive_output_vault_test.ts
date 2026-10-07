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
import { z } from "zod";
import {
  resolveSensitiveOutputVault,
  sensitiveOutputTargets,
  sensitiveOutputTargetVaults,
  type SensitiveOutputVaultConfig,
} from "./sensitive_output_vault.ts";
import type { ResourceOutputSpec } from "./model.ts";

function vaults(
  defaultVault: string | undefined,
  userVaults: string[],
): SensitiveOutputVaultConfig {
  return {
    getDefaultVaultName: () => defaultVault,
    getUserVaultNames: () => userVaults,
  };
}

Deno.test("resolveSensitiveOutputVault: field, then override, then spec, then default, then first user vault", () => {
  const config = vaults("dflt", ["first", "second"]);
  assertEquals(
    resolveSensitiveOutputVault({
      fieldVaultName: "field",
      overrideVaultName: "override",
      specVaultName: "spec",
    }, config),
    "field",
  );
  assertEquals(
    resolveSensitiveOutputVault({
      overrideVaultName: "override",
      specVaultName: "spec",
    }, config),
    "override",
  );
  assertEquals(
    resolveSensitiveOutputVault({ specVaultName: "spec" }, config),
    "spec",
  );
  assertEquals(resolveSensitiveOutputVault({}, config), "dflt");
  assertEquals(
    resolveSensitiveOutputVault({}, vaults(undefined, ["first", "second"])),
    "first",
  );
  assertEquals(
    resolveSensitiveOutputVault({}, vaults(undefined, [])),
    undefined,
  );
});

Deno.test("sensitiveOutputTargetVaults: one target per field vault, spec-level for the rest", () => {
  const resources: Record<string, ResourceOutputSpec> = {
    creds: {
      schema: z.object({
        a: z.string().meta({ sensitive: true, vaultName: "erp" }),
        b: z.string().meta({ sensitive: true }),
        plain: z.string(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
      vaultName: "spec-vault",
    },
    public: {
      schema: z.object({ x: z.string() }),
      lifetime: "infinite",
      garbageCollection: 10,
      vaultName: "never-used",
    },
    all: {
      schema: z.object({ y: z.string() }),
      lifetime: "infinite",
      garbageCollection: 10,
      sensitiveOutput: true,
    },
  };
  assertEquals(
    sensitiveOutputTargetVaults(resources, undefined, vaults("dflt", ["u"])),
    ["erp", "spec-vault", "dflt"],
  );
  assertEquals(
    sensitiveOutputTargetVaults(
      resources,
      [{ specName: "creds", vaultName: "ovr" }, { specName: "all" }],
      vaults(undefined, ["u"]),
    ),
    ["erp", "ovr", "u"],
  );
  assertEquals(
    sensitiveOutputTargetVaults(undefined, undefined, vaults("d", [])),
    [],
  );
});

Deno.test("sensitiveOutputTargets: carries a field's own vaultKey, and no key where it is generated", () => {
  const resources: Record<string, ResourceOutputSpec> = {
    creds: {
      schema: z.object({
        pinned: z.string().meta({ sensitive: true, vaultKey: "api-token" }),
        again: z.string().meta({ sensitive: true, vaultKey: "api-token" }),
        generated: z.string().meta({ sensitive: true }),
        elsewhere: z.string().meta({
          sensitive: true,
          vaultName: "erp",
          vaultKey: "db",
        }),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
      vaultName: "outputs",
    },
  };
  assertEquals(
    sensitiveOutputTargets(resources, undefined, vaults(undefined, ["u"])),
    [
      { vaultName: "outputs", vaultKey: "api-token" },
      { vaultName: "outputs" },
      { vaultName: "erp", vaultKey: "db" },
    ],
  );
  assertEquals(
    sensitiveOutputTargetVaults(resources, undefined, vaults(undefined, [])),
    ["outputs", "erp"],
  );
});

Deno.test("resolveSensitiveOutputVault: an empty override vaultName is ignored, as the data writer ignores it", () => {
  const config = vaults("dflt", ["first"]);
  assertEquals(
    resolveSensitiveOutputVault(
      { overrideVaultName: "", specVaultName: "spec" },
      config,
    ),
    "spec",
  );
  assertEquals(
    resolveSensitiveOutputVault({ overrideVaultName: "" }, config),
    "dflt",
  );
  const resources: Record<string, ResourceOutputSpec> = {
    creds: {
      schema: z.object({ secret: z.string().meta({ sensitive: true }) }),
      lifetime: "infinite",
      garbageCollection: 10,
      vaultName: "spec-vault",
    },
  };
  assertEquals(
    sensitiveOutputTargetVaults(
      resources,
      [{ specName: "creds", vaultName: "" }],
      config,
    ),
    ["spec-vault"],
  );
});
