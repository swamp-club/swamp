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
import type { ExtensionAutoResolver } from "../../domain/extensions/extension_auto_resolver.ts";
import type { ExtensionContentMetadata } from "../../domain/extensions/extension_content.ts";
import type { VaultTypeInfo } from "../../domain/vaults/vault_type_registry.ts";
import { MockVaultProvider } from "../../domain/vaults/mock_vault_provider.ts";
import {
  createRegistryConfigFieldsLookup,
  describeVaultTargetConfig,
  type VaultTypeConfigDeps,
} from "./config_fields.ts";

const TYPE = "@swamp/1password";

function metadataFor(
  vaults: ExtensionContentMetadata["vaults"],
): ExtensionContentMetadata {
  return {
    models: [],
    extensions: [],
    workflows: [],
    vaults,
    datastores: [],
    reports: [],
    webhooks: [],
    skills: [],
  };
}

const ONE_PASSWORD_ENTRY = {
  fileName: "onepassword.ts",
  type: TYPE,
  name: "1Password",
  description: "1Password vault provider.",
  hasConfigSchema: true,
  configFields: [
    {
      name: "op_vault",
      type: "string",
      description: "The 1Password vault to use",
      required: true,
    },
    {
      name: "op_account",
      type: "string",
      description: "Account shorthand or UUID",
      required: false,
    },
  ],
};

/** A resolver stub that records describe calls. */
function fakeResolver(
  answer: ExtensionContentMetadata | null,
): ExtensionAutoResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    describeTypeInRegistry(type: string) {
      calls.push(type);
      return Promise.resolve(answer);
    },
  } as unknown as ExtensionAutoResolver & { calls: string[] };
}

Deno.test("createRegistryConfigFieldsLookup: maps the matching vault entry to sanitized fields", async () => {
  const lookup = createRegistryConfigFieldsLookup(
    fakeResolver(metadataFor([{
      ...ONE_PASSWORD_ENTRY,
      configFields: [{
        name: "op_vault",
        type: "string",
        description: "The \x1b[1m1Password\x1b[0m vault",
        required: true,
      }],
    }])),
  );
  assertEquals(await lookup(TYPE), [{
    name: "op_vault",
    type: "string",
    description: "The 1Password vault",
    required: true,
  }]);
});

Deno.test("createRegistryConfigFieldsLookup: asks the resolver once per type", async () => {
  const resolver = fakeResolver(metadataFor([ONE_PASSWORD_ENTRY]));
  const lookup = createRegistryConfigFieldsLookup(resolver);

  const [first, second] = await Promise.all([lookup(TYPE), lookup(TYPE)]);
  await lookup(TYPE);

  assertEquals(first, second);
  assertEquals(resolver.calls, [TYPE]);
});

Deno.test("createRegistryConfigFieldsLookup: null without a resolver, metadata, a matching entry, or fields", async () => {
  assertEquals(await createRegistryConfigFieldsLookup(null)(TYPE), null);
  assertEquals(
    await createRegistryConfigFieldsLookup(fakeResolver(null))(TYPE),
    null,
  );
  assertEquals(
    await createRegistryConfigFieldsLookup(
      fakeResolver(metadataFor([{ ...ONE_PASSWORD_ENTRY, type: "@swamp/x" }])),
    )(TYPE),
    null,
  );
  assertEquals(
    await createRegistryConfigFieldsLookup(
      fakeResolver(metadataFor([{ ...ONE_PASSWORD_ENTRY, configFields: [] }])),
    )(TYPE),
    null,
  );
});

/** Registry metadata is whatever the publisher sent: shape it any way. */
function malformedResolver(vaults: unknown): ExtensionAutoResolver {
  return fakeResolver(
    { ...metadataFor([]), vaults } as unknown as ExtensionContentMetadata,
  );
}

Deno.test("createRegistryConfigFieldsLookup: a malformed registry entry means unknown, never a crash", async () => {
  // No configFields at all, although hasConfigSchema claims there is one.
  assertEquals(
    await createRegistryConfigFieldsLookup(
      malformedResolver([{ type: TYPE, hasConfigSchema: true }]),
    )(TYPE),
    null,
  );
  // vaults is not an array.
  assertEquals(
    await createRegistryConfigFieldsLookup(malformedResolver("nope"))(TYPE),
    null,
  );
  // An entry without a string type, and fields without a string name, are
  // skipped; the rest still come through with safe defaults.
  const fields = await createRegistryConfigFieldsLookup(
    malformedResolver([
      { type: 42, configFields: [{ name: "x", required: true }] },
      {
        type: TYPE,
        configFields: [
          { name: 7, type: "string", required: true },
          { name: "op_vault", type: null, description: 3, required: "yes" },
        ],
      },
    ]),
  )(TYPE);
  assertEquals(fields, [{
    name: "op_vault",
    type: "unknown",
    required: false,
  }]);
});

Deno.test("createRegistryConfigFieldsLookup: a resolver that throws means unknown", async () => {
  const resolver = {
    describeTypeInRegistry: () => Promise.reject(new Error("boom")),
  } as unknown as ExtensionAutoResolver;
  assertEquals(await createRegistryConfigFieldsLookup(resolver)(TYPE), null);
});

Deno.test("createRegistryConfigFieldsLookup: matches the vault entry case-insensitively", async () => {
  const lookup = createRegistryConfigFieldsLookup(
    fakeResolver(
      metadataFor([{ ...ONE_PASSWORD_ENTRY, type: "@Swamp/1Password" }]),
    ),
  );
  assertEquals((await lookup(TYPE))?.length, 2);
});

const SCHEMA = z.object({
  op_vault: z.string().describe("The 1Password vault to use"),
  op_account: z.string().optional(),
});

function makeDeps(
  overrides: Partial<VaultTypeConfigDeps> & {
    typeInfo?: Partial<VaultTypeInfo>;
  } = {},
): VaultTypeConfigDeps & { registryCalls: string[] } {
  const registryCalls: string[] = [];
  const typeInfo: VaultTypeInfo = {
    type: TYPE,
    name: "1Password",
    description: "1Password vault provider.",
    isBuiltIn: false,
    configSchema: SCHEMA,
    createProvider: (name) => new MockVaultProvider(name),
    ...overrides.typeInfo,
  };
  return {
    registryCalls,
    isVaultTypeLoaded: () => Promise.resolve(true),
    getVaultTypeInfo: () => typeInfo,
    findRegistryConfigFields: (type) => {
      registryCalls.push(type);
      return Promise.resolve(null);
    },
    ...overrides,
  };
}

Deno.test("describeVaultTargetConfig: a loaded extension type is described from its schema, not the registry", async () => {
  const deps = makeDeps();
  const fields = await describeVaultTargetConfig(deps, TYPE);
  assertEquals(fields?.map((f) => [f.name, f.required]), [
    ["op_vault", true],
    ["op_account", false],
  ]);
  assertEquals(deps.registryCalls, []);
});

Deno.test("describeVaultTargetConfig: a built-in or schema-less loaded type has no fields to require", async () => {
  assertEquals(
    await describeVaultTargetConfig(
      makeDeps({
        typeInfo: { type: "local_encryption", isBuiltIn: true },
      }),
      "local_encryption",
    ),
    [],
  );
  assertEquals(
    await describeVaultTargetConfig(
      makeDeps({ typeInfo: { configSchema: undefined } }),
      TYPE,
    ),
    [],
  );
});

Deno.test("describeVaultTargetConfig: a loaded type the registry does not know is unknown", async () => {
  assertEquals(
    await describeVaultTargetConfig(
      makeDeps({ getVaultTypeInfo: () => undefined }),
      TYPE,
    ),
    null,
  );
});

Deno.test("describeVaultTargetConfig: an extension type not loaded yet is described from the registry", async () => {
  const deps = makeDeps({
    isVaultTypeLoaded: () => Promise.resolve(false),
    findRegistryConfigFields: () =>
      Promise.resolve([
        { name: "op_vault", type: "string", required: true },
      ]),
  });
  assertEquals((await describeVaultTargetConfig(deps, TYPE))?.length, 1);
});

Deno.test("describeVaultTargetConfig: a non-extension type that is not loaded is unknown, without a registry call", async () => {
  const deps = makeDeps({ isVaultTypeLoaded: () => Promise.resolve(false) });
  assertEquals(await describeVaultTargetConfig(deps, "mystery"), null);
  assertEquals(deps.registryCalls, []);
});
