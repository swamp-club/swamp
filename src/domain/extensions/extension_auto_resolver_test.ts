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

import { assertEquals } from "@std/assert";
import {
  type AutoResolveOutputPort,
  ExtensionAutoResolver,
  type ExtensionInstallerPort,
  type ExtensionLookupPort,
  resolveDatastoreType,
  resolveModelType,
  resolveVaultType,
} from "./extension_auto_resolver.ts";
import { modelRegistry } from "../models/model.ts";
import { ModelType } from "../models/model_type.ts";
import { vaultTypeRegistry } from "../vaults/vault_type_registry.ts";
import { datastoreTypeRegistry } from "../datastore/datastore_type_registry.ts";
import { z } from "zod";

/** Creates a no-op output port that records calls for assertions. */
function createMockOutput(): AutoResolveOutputPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    searching(type: string) {
      calls.push(`searching:${type}`);
    },
    installing(ext: string, ver: string, _desc: string | undefined) {
      calls.push(`installing:${ext}@${ver}`);
    },
    installed(ext: string, ver: string, count: number) {
      calls.push(`installed:${ext}@${ver}:${count}`);
    },
    notFound(type: string) {
      calls.push(`notFound:${type}`);
    },
    networkError(type: string, _err: string) {
      calls.push(`networkError:${type}`);
    },
    alreadyInstalledButFailed(ext: string, path: string) {
      calls.push(`alreadyInstalledButFailed:${ext}:${path}`);
    },
  };
}

/** Creates a mock lookup port. */
function createMockLookup(
  extensions: Record<
    string,
    { description: string; latestVersion: string }
  > = {},
  searchResults: string[] = [],
): ExtensionLookupPort {
  return {
    getExtension(name: string) {
      const ext = extensions[name];
      if (!ext) return Promise.resolve(null);
      return Promise.resolve({ name, ...ext });
    },
    searchExtensions(_params: {
      q?: string;
      collective?: string;
      perPage?: number;
    }) {
      return Promise.resolve({
        extensions: searchResults.map((name) => ({ name })),
      });
    },
  };
}

/** Creates a mock installer port. */
function createMockInstaller(
  shouldSucceed = true,
  version = "2026.03.16.1",
  alreadyInstalled = false,
): ExtensionInstallerPort & {
  installCalls: string[];
  isInstalledCalls: string[];
} {
  const installCalls: string[] = [];
  const isInstalledCalls: string[] = [];
  return {
    installCalls,
    isInstalledCalls,
    isInstalled(extensionName: string) {
      isInstalledCalls.push(extensionName);
      return Promise.resolve(alreadyInstalled);
    },
    installedPath(extensionName: string) {
      return `/fake/pulled-extensions/${extensionName}`;
    },
    install(extensionName: string) {
      installCalls.push(extensionName);
      if (!shouldSucceed) return Promise.resolve(null);
      return Promise.resolve({ version });
    },
    hotLoadModels() {
      return Promise.resolve(3);
    },
    hotLoadVaults() {
      return Promise.resolve();
    },
    hotLoadDatastores() {
      return Promise.resolve();
    },
  };
}

Deno.test("ExtensionAutoResolver - skips non-allowlisted collectives", async () => {
  const output = createMockOutput();
  const resolver = new ExtensionAutoResolver({
    allowedCollectives: ["swamp"],
    extensionLookup: createMockLookup(),
    extensionInstaller: createMockInstaller(),
    output,
  });

  const result = await resolver.resolve("@foo/bar/baz");
  assertEquals(result, false);
  assertEquals(output.calls.length, 0); // No output — silently skipped
});

Deno.test("ExtensionAutoResolver - resolves via direct lookup", async () => {
  const output = createMockOutput();
  const installer = createMockInstaller();
  const resolver = new ExtensionAutoResolver({
    allowedCollectives: ["swamp"],
    extensionLookup: createMockLookup({
      "@swamp/aws": {
        description: "AWS models",
        latestVersion: "2026.03.16.1",
      },
    }),
    extensionInstaller: installer,
    output,
  });

  const result = await resolver.resolve("@swamp/aws/ec2/instance");
  assertEquals(result, true);
  assertEquals(installer.installCalls, ["@swamp/aws"]);
  assertEquals(output.calls[0], "searching:@swamp/aws/ec2/instance");
  assertEquals(output.calls[1], "installing:@swamp/aws@2026.03.16.1");
  assertEquals(output.calls[2], "installed:@swamp/aws@2026.03.16.1:3");
});

Deno.test("ExtensionAutoResolver - tries intermediate candidates before shorter ones", async () => {
  const lookupCalls: string[] = [];
  const lookup: ExtensionLookupPort = {
    getExtension(name: string) {
      lookupCalls.push(name);
      if (name === "@swamp/aws/ec2") {
        return Promise.resolve({
          name,
          description: "EC2 models",
          latestVersion: "2026.03.16.1",
        });
      }
      return Promise.resolve(null);
    },
    searchExtensions() {
      return Promise.resolve({ extensions: [] });
    },
  };

  const resolver = new ExtensionAutoResolver({
    allowedCollectives: ["swamp"],
    extensionLookup: lookup,
    extensionInstaller: createMockInstaller(),
    output: createMockOutput(),
  });

  await resolver.resolve("@swamp/aws/ec2/instance");
  // Should try @swamp/aws/ec2 first, then @swamp/aws
  assertEquals(lookupCalls[0], "@swamp/aws/ec2");
});

Deno.test("ExtensionAutoResolver - falls back to search when direct lookup fails", async () => {
  const output = createMockOutput();
  const installer = createMockInstaller();

  const lookup: ExtensionLookupPort = {
    getExtension(name: string) {
      // Direct lookup always fails, but we need to serve the install lookup
      if (name === "@swamp/aws-toolkit") {
        return Promise.resolve({
          name,
          description: "AWS toolkit",
          latestVersion: "2026.03.16.1",
        });
      }
      return Promise.resolve(null);
    },
    searchExtensions() {
      return Promise.resolve({
        extensions: [{ name: "@swamp/aws-toolkit" }],
      });
    },
  };

  const resolver = new ExtensionAutoResolver({
    allowedCollectives: ["swamp"],
    extensionLookup: lookup,
    extensionInstaller: installer,
    output,
  });

  const result = await resolver.resolve("@swamp/aws/ec2/instance");
  assertEquals(result, true);
  assertEquals(installer.installCalls, ["@swamp/aws-toolkit"]);
});

Deno.test("ExtensionAutoResolver - shows notFound when nothing matches", async () => {
  const output = createMockOutput();
  const resolver = new ExtensionAutoResolver({
    allowedCollectives: ["swamp"],
    extensionLookup: createMockLookup(),
    extensionInstaller: createMockInstaller(),
    output,
  });

  const result = await resolver.resolve("@swamp/nonexistent/type");
  assertEquals(result, false);
  assertEquals(output.calls[0], "searching:@swamp/nonexistent/type");
  assertEquals(output.calls[1], "notFound:@swamp/nonexistent/type");
});

Deno.test("ExtensionAutoResolver - shows networkError on fetch failure", async () => {
  const output = createMockOutput();
  const lookup: ExtensionLookupPort = {
    getExtension(_name: string) {
      return Promise.reject(new TypeError("fetch failed"));
    },
    searchExtensions() {
      return Promise.reject(new TypeError("fetch failed"));
    },
  };

  const resolver = new ExtensionAutoResolver({
    allowedCollectives: ["swamp"],
    extensionLookup: lookup,
    extensionInstaller: createMockInstaller(),
    output,
  });

  const result = await resolver.resolve("@swamp/aws/ec2/instance");
  assertEquals(result, false);
  assertEquals(output.calls[0], "searching:@swamp/aws/ec2/instance");
  assertEquals(output.calls[1], "networkError:@swamp/aws/ec2/instance");
});

Deno.test("ExtensionAutoResolver - re-entrancy guard prevents infinite loops", async () => {
  let resolveCount = 0;
  const lookup: ExtensionLookupPort = {
    getExtension(_name: string) {
      resolveCount++;
      return Promise.resolve(null);
    },
    searchExtensions() {
      return Promise.resolve({ extensions: [] });
    },
  };

  const resolver = new ExtensionAutoResolver({
    allowedCollectives: ["swamp"],
    extensionLookup: lookup,
    extensionInstaller: createMockInstaller(),
    output: createMockOutput(),
  });

  // First call sets up the guard
  const result = await resolver.resolve("@swamp/aws/ec2/instance");
  assertEquals(result, false);
  // Reset count
  resolveCount = 0;

  // Second call with same type should work (guard was released)
  await resolver.resolve("@swamp/aws/ec2/instance");
  assertEquals(resolveCount > 0, true);
});

Deno.test("ExtensionAutoResolver - handles non-@ prefixed types", async () => {
  const output = createMockOutput();
  const installer = createMockInstaller();
  const resolver = new ExtensionAutoResolver({
    allowedCollectives: ["swamp"],
    extensionLookup: createMockLookup({
      "@swamp/echo": {
        description: "Echo model",
        latestVersion: "2026.03.16.1",
      },
    }),
    extensionInstaller: installer,
    output,
  });

  // Non-@ type with "swamp" collective
  const result = await resolver.resolve("swamp/echo/v2");
  assertEquals(result, true);
  assertEquals(installer.installCalls, ["@swamp/echo"]);
});

Deno.test("ExtensionAutoResolver - refuses to install when extension is already on disk", async () => {
  const output = createMockOutput();
  const installer = createMockInstaller(true, "2026.03.16.1", true);
  const resolver = new ExtensionAutoResolver({
    allowedCollectives: ["swamp"],
    extensionLookup: createMockLookup({
      "@swamp/aws": {
        description: "AWS models",
        latestVersion: "2026.03.16.1",
      },
    }),
    extensionInstaller: installer,
    output,
  });

  const result = await resolver.resolve("@swamp/aws/ec2/instance");
  assertEquals(result, false);
  // install must not have been called — silent overwrite would destroy edits
  assertEquals(installer.installCalls, []);
  // isInstalled was asked
  assertEquals(installer.isInstalledCalls, ["@swamp/aws"]);
  // user-visible output surfaced the "already installed but failed" event,
  // not an install-started event
  const kinds = output.calls.map((c) => c.split(":")[0]);
  assertEquals(kinds.includes("installing"), false);
  assertEquals(kinds.includes("alreadyInstalledButFailed"), true);
});

Deno.test("ExtensionAutoResolver - isInstalled is checked before install on the happy path", async () => {
  const output = createMockOutput();
  const installer = createMockInstaller();
  const resolver = new ExtensionAutoResolver({
    allowedCollectives: ["swamp"],
    extensionLookup: createMockLookup({
      "@swamp/aws": {
        description: "AWS models",
        latestVersion: "2026.03.16.1",
      },
    }),
    extensionInstaller: installer,
    output,
  });

  await resolver.resolve("@swamp/aws/ec2/instance");
  // isInstalled must be consulted before the install proceeds — this is
  // the regression guard for issue #121.
  assertEquals(installer.isInstalledCalls, ["@swamp/aws"]);
  assertEquals(installer.installCalls, ["@swamp/aws"]);
});

Deno.test("ExtensionAutoResolver - skips types without a collective", async () => {
  const output = createMockOutput();
  const resolver = new ExtensionAutoResolver({
    allowedCollectives: ["swamp"],
    extensionLookup: createMockLookup(),
    extensionInstaller: createMockInstaller(),
    output,
  });

  const result = await resolver.resolve("singleword");
  assertEquals(result, false);
  assertEquals(output.calls.length, 0);
});

Deno.test("resolveModelType - returns existing definition without resolver", async () => {
  // Register a test model
  const testType = ModelType.create("@test-resolve/unit-test-model");
  if (!modelRegistry.has(testType)) {
    modelRegistry.register({
      type: testType,
      version: "2026.03.16.1",
      methods: {
        run: {
          description: "test",
          arguments: z.object({}),
          execute: () => Promise.resolve({ dataHandles: [] }),
        },
      },
    });
  }

  const result = await resolveModelType(testType, null);
  assertEquals(result !== undefined, true);
  assertEquals(result?.type.normalized, "@test-resolve/unit-test-model");
});

Deno.test("resolveModelType - returns undefined for unknown type without resolver", async () => {
  const result = await resolveModelType("@unknown/nonexistent/type", null);
  assertEquals(result, undefined);
});

Deno.test("resolveVaultType - returns true for existing vault type", async () => {
  // Register a test vault type if needed
  if (!vaultTypeRegistry.has("test-resolve-vault")) {
    vaultTypeRegistry.register({
      type: "test-resolve-vault",
      name: "Test Vault",
      description: "For testing",
      isBuiltIn: true,
    });
  }

  const result = await resolveVaultType("test-resolve-vault", null);
  assertEquals(result, true);
});

Deno.test("resolveVaultType - returns false for unknown type without resolver", async () => {
  const result = await resolveVaultType("@unknown/vault", null);
  assertEquals(result, false);
});

Deno.test("resolveVaultType - skips non-@ types", async () => {
  const resolver = new ExtensionAutoResolver({
    allowedCollectives: ["swamp"],
    extensionLookup: createMockLookup(),
    extensionInstaller: createMockInstaller(),
    output: createMockOutput(),
  });

  const result = await resolveVaultType("plain-type", resolver);
  assertEquals(result, false);
});

Deno.test("resolveDatastoreType - returns true for existing datastore type", async () => {
  if (!datastoreTypeRegistry.has("test-resolve-datastore")) {
    datastoreTypeRegistry.register({
      type: "test-resolve-datastore",
      name: "Test Datastore",
      description: "For testing",
      isBuiltIn: true,
    });
  }

  const result = await resolveDatastoreType("test-resolve-datastore", null);
  assertEquals(result, true);
});

Deno.test("resolveDatastoreType - returns false for unknown type without resolver", async () => {
  const result = await resolveDatastoreType("@unknown/datastore", null);
  assertEquals(result, false);
});

Deno.test("resolveDatastoreType - skips non-@ types", async () => {
  const resolver = new ExtensionAutoResolver({
    allowedCollectives: ["swamp"],
    extensionLookup: createMockLookup(),
    extensionInstaller: createMockInstaller(),
    output: createMockOutput(),
  });

  const result = await resolveDatastoreType("plain-type", resolver);
  assertEquals(result, false);
});
