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
import {
  type AutoResolveOutputPort,
  ExtensionAutoResolver,
  type ExtensionInstallerPort,
  type ExtensionLookupPort,
  type InstallationInspection,
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
    alreadyInstalledTruncated(ext: string, path: string, missing: string[]) {
      calls.push(
        `alreadyInstalledTruncated:${ext}:${path}:${missing.join(",")}`,
      );
    },
    collectiveNotTrusted(collective: string, type: string) {
      calls.push(`collectiveNotTrusted:${collective}:${type}`);
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
  inspection: InstallationInspection = { state: "missing" },
): ExtensionInstallerPort & {
  installCalls: string[];
  inspectCalls: string[];
} {
  const installCalls: string[] = [];
  const inspectCalls: string[] = [];
  return {
    installCalls,
    inspectCalls,
    inspectInstallation(extensionName: string) {
      inspectCalls.push(extensionName);
      return Promise.resolve(inspection);
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
  // Untrusted @collective/* references surface an actionable trust hint rather
  // than installing or failing silently (swamp-club#465).
  assertEquals(output.calls, ["collectiveNotTrusted:foo:@foo/bar/baz"]);
});

Deno.test("ExtensionAutoResolver - untrusted collective emits trust hint but does not install", async () => {
  const output = createMockOutput();
  const installer = createMockInstaller();
  const resolver = new ExtensionAutoResolver({
    allowedCollectives: ["swamp"],
    extensionLookup: createMockLookup({
      "@myorg/tools": { description: "x", latestVersion: "2026.03.16.1" },
    }),
    extensionInstaller: installer,
    output,
  });

  const result = await resolver.resolve("@myorg/tools/widget");
  assertEquals(result, false);
  assertEquals(installer.installCalls, []);
  assertEquals(output.calls, [
    "collectiveNotTrusted:myorg:@myorg/tools/widget",
  ]);
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
  // Full type tried first, then stripped candidates longest-to-shortest
  assertEquals(lookupCalls[0], "@swamp/aws/ec2/instance");
  assertEquals(lookupCalls[1], "@swamp/aws/ec2");
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

Deno.test("ExtensionAutoResolver - refuses to install when extension is intact on disk", async () => {
  // Issue #121 regression guard: intact tree + type failed to register
  // means local edits are the cause; a silent reinstall would destroy
  // WIP. Must surface `alreadyInstalledButFailed` and skip install.
  const output = createMockOutput();
  const installer = createMockInstaller(true, "2026.03.16.1", {
    state: "intact",
    path: "/fake/pulled-extensions/@swamp/aws",
  });
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
  assertEquals(installer.installCalls, []);
  assertEquals(installer.inspectCalls, ["@swamp/aws"]);
  const kinds = output.calls.map((c) => c.split(":")[0]);
  assertEquals(kinds.includes("installing"), false);
  assertEquals(kinds.includes("alreadyInstalledButFailed"), true);
  assertEquals(kinds.includes("alreadyInstalledTruncated"), false);
});

Deno.test("ExtensionAutoResolver - surfaces truncated error when tree is incomplete", async () => {
  // swamp-club#133 regression guard: truncated tree + type failed to
  // register means files listed in the lockfile are missing from disk.
  // Must surface `alreadyInstalledTruncated` naming the missing files,
  // not the generic "local edits" message, and must not reinstall.
  const output = createMockOutput();
  const installer = createMockInstaller(true, "2026.03.16.1", {
    state: "truncated",
    path: "/fake/pulled-extensions/@swamp/aws",
    missing: [
      ".swamp/pulled-extensions/@swamp/aws/manifest.yaml",
      ".swamp/pulled-extensions/@swamp/aws/datastores/s3.ts",
    ],
  });
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
  assertEquals(installer.installCalls, []);
  assertEquals(installer.inspectCalls, ["@swamp/aws"]);
  const truncatedCalls = output.calls.filter((c) =>
    c.startsWith("alreadyInstalledTruncated:")
  );
  assertEquals(truncatedCalls.length, 1);
  // The event must carry the full missing list, not a truncated prefix.
  assertEquals(
    truncatedCalls[0],
    "alreadyInstalledTruncated:@swamp/aws:/fake/pulled-extensions/@swamp/aws:" +
      ".swamp/pulled-extensions/@swamp/aws/manifest.yaml," +
      ".swamp/pulled-extensions/@swamp/aws/datastores/s3.ts",
  );
  const kinds = output.calls.map((c) => c.split(":")[0]);
  assertEquals(kinds.includes("installing"), false);
  assertEquals(kinds.includes("alreadyInstalledButFailed"), false);
});

Deno.test("ExtensionAutoResolver - inspectInstallation is consulted before install on the happy path", async () => {
  // Regression guard for #121: the resolver must consult the inspection
  // port before proceeding to install. When the tree is missing,
  // install proceeds normally.
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
  assertEquals(installer.inspectCalls, ["@swamp/aws"]);
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

// --- Stream-0 regression net: candidate names preserve forward slashes ---

Deno.test("ExtensionAutoResolver - buildCandidateNames preserves forward-slash separators", async () => {
  // The private buildCandidateNames helper splits on `/` and stitches
  // candidates back together with `/`. Stream C is leaving this code
  // alone because the type-string IS the logical key — it's never a
  // host filesystem path. This test pins the contract by observing the
  // candidate names through the public resolve() entry point: a refactor
  // that swaps `/` for `path.SEPARATOR` would surface as backslash-
  // separated lookup names on Windows and fail this assertion.
  const lookupCalls: string[] = [];
  const lookup: ExtensionLookupPort = {
    getExtension(name: string) {
      lookupCalls.push(name);
      return Promise.resolve(null);
    },
    searchExtensions() {
      return Promise.resolve({ extensions: [] });
    },
  };

  const resolver = new ExtensionAutoResolver({
    allowedCollectives: ["user"],
    extensionLookup: lookup,
    extensionInstaller: createMockInstaller(),
    output: createMockOutput(),
  });

  // Input is `@user/aws/ec2`; with collective "user" allowlisted, we
  // expect the candidate progression `@user/aws/ec2` (full type),
  // then `@user/aws` (stripped).
  await resolver.resolve("@user/aws/ec2");

  // Every observed candidate must be forward-slash separated.
  assertEquals(
    lookupCalls.length > 0,
    true,
    `expected at least one candidate lookup; got: ${
      JSON.stringify(lookupCalls)
    }`,
  );
  for (const candidate of lookupCalls) {
    assertEquals(
      candidate.includes("\\"),
      false,
      `candidate must not contain backslash; got: ${candidate}`,
    );
    assertEquals(
      candidate.startsWith("@"),
      true,
      `candidate must remain @-prefixed; got: ${candidate}`,
    );
  }
  // Pin candidates: full type first, then stripped.
  assertEquals(
    lookupCalls.includes("@user/aws/ec2"),
    true,
    `expected @user/aws/ec2 among candidates; got: ${
      JSON.stringify(lookupCalls)
    }`,
  );
  assertEquals(
    lookupCalls.includes("@user/aws"),
    true,
    `expected @user/aws among candidates; got: ${JSON.stringify(lookupCalls)}`,
  );
});

// --- Issue #445: 2-segment datastore types must be tried as direct candidates ---

Deno.test("ExtensionAutoResolver - resolves 2-segment datastore type via direct lookup", async () => {
  const output = createMockOutput();
  const installer = createMockInstaller();
  const resolver = new ExtensionAutoResolver({
    allowedCollectives: ["keeb"],
    extensionLookup: createMockLookup({
      "@keeb/mongodb-datastore": {
        description: "MongoDB datastore",
        latestVersion: "2026.05.01.1",
      },
    }),
    extensionInstaller: installer,
    output,
  });

  const result = await resolver.resolve("@keeb/mongodb-datastore");
  assertEquals(result, true);
  assertEquals(installer.installCalls, ["@keeb/mongodb-datastore"]);
});

Deno.test("ExtensionAutoResolver - 2-segment type generates full type as only candidate", async () => {
  const lookupCalls: string[] = [];
  const lookup: ExtensionLookupPort = {
    getExtension(name: string) {
      lookupCalls.push(name);
      return Promise.resolve(null);
    },
    searchExtensions() {
      return Promise.resolve({ extensions: [] });
    },
  };

  const resolver = new ExtensionAutoResolver({
    allowedCollectives: ["keeb"],
    extensionLookup: lookup,
    extensionInstaller: createMockInstaller(),
    output: createMockOutput(),
  });

  await resolver.resolve("@keeb/mongodb-datastore");
  assertEquals(
    lookupCalls,
    ["@keeb/mongodb-datastore"],
    "2-segment type should produce exactly one direct-lookup candidate (the full type)",
  );
});

Deno.test("ExtensionAutoResolver - untrusted collective hint is emitted once per collective", async () => {
  const output = createMockOutput();
  const resolver = new ExtensionAutoResolver({
    allowedCollectives: ["swamp"],
    extensionLookup: createMockLookup(),
    extensionInstaller: createMockInstaller(),
    output,
  });

  await resolver.resolve("@myorg/tools/widget");
  await resolver.resolve("@myorg/tools/gizmo");
  await resolver.resolve("@myorg/utils/helper");

  // One hint for the whole collective, not one per referenced type.
  assertEquals(output.calls, [
    "collectiveNotTrusted:myorg:@myorg/tools/widget",
  ]);
});

Deno.test("ExtensionAutoResolver - installing message reports the pinned version, not latest", async () => {
  const output = createMockOutput();
  const installer = createMockInstaller(
    true,
    "2026.01.01.1", // installer reports the pinned version it installed
    { state: "missing", lockedVersion: "2026.01.01.1" },
  );
  const resolver = new ExtensionAutoResolver({
    allowedCollectives: ["swamp"],
    extensionLookup: createMockLookup({
      "@swamp/aws": { description: "AWS", latestVersion: "2026.09.09.9" },
    }),
    extensionInstaller: installer,
    output,
  });

  const result = await resolver.resolve("@swamp/aws/ec2/instance");
  assertEquals(result, true);
  // "installing" must show the pinned version (from the lockfile), not latest.
  assertEquals(output.calls[1], "installing:@swamp/aws@2026.01.01.1");
  assertEquals(output.calls[2], "installed:@swamp/aws@2026.01.01.1:3");
});
