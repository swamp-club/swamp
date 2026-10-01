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

import {
  assertEquals,
  assertExists,
  assertInstanceOf,
  assertRejects,
} from "@std/assert";
import type { DatastoreProvider } from "../datastore/datastore_provider.ts";
import type { DatastoreVerifier } from "../datastore/datastore_health.ts";
import { datastoreTypeRegistry } from "../datastore/datastore_type_registry.ts";
import {
  type DistributedLock,
  type LockOptions,
  LockTimeoutError,
} from "../datastore/distributed_lock.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";
import { datastoreKindAdapter } from "./datastore_kind_adapter.ts";
import type { RegistrationContext } from "./kind_adapter.ts";

const stubDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve("/usr/bin/false"),
  getDenoEnv: () => ({}),
};

const context: RegistrationContext = {
  absolutePath: "/ext/datastore.ts",
  denoPath: "/usr/bin/false",
  denoRuntime: stubDenoRuntime,
  repoDir: null,
};

/** Mirrors the error the S3 and GCS datastore extensions throw on timeout. */
class ExtensionLockTimeoutError extends Error {
  override readonly name = "LockTimeoutError";
  readonly code = "LOCK_TIMEOUT" as const;

  constructor(
    public readonly lockKey: string,
    public readonly waitedMs: number,
  ) {
    super(`Lock "${lockKey}" — timed out after ${waitedMs}ms`);
  }
}

/**
 * Class-based provider: its members live on the prototype and read `this`,
 * so the adapter's wrapper must not copy it with a spread.
 */
class FakeClassProvider implements DatastoreProvider {
  readonly lockKeys: string[] = [];

  constructor(private readonly root: string) {}

  createLock(_datastorePath: string, options?: LockOptions): DistributedLock {
    const lockKey = options?.lockKey ?? ".datastore.lock";
    this.lockKeys.push(lockKey);
    return {
      acquire: () =>
        Promise.reject(new ExtensionLockTimeoutError(lockKey, 3001)),
      release: () => Promise.resolve(),
      withLock: () =>
        Promise.reject(new ExtensionLockTimeoutError(lockKey, 3001)),
      inspect: () => Promise.resolve(null),
      forceRelease: () => Promise.resolve(false),
    };
  }

  createVerifier(): DatastoreVerifier {
    return {
      verify: () =>
        Promise.resolve({
          healthy: true,
          message: "ok",
          latencyMs: 0,
          datastoreType: "fake",
        }),
    };
  }

  resolveDatastorePath(repoDir: string): string {
    return `${repoDir}/${this.root}`;
  }
}

function datastoreExport(type: string): Record<string, unknown> {
  return {
    type,
    name: "Fake",
    description: "Fake extension datastore",
    createProvider: (config: Record<string, unknown>) =>
      new FakeClassProvider(String(config.root)),
  };
}

function uniqueType(): string {
  return `@test/lock-${crypto.randomUUID().slice(0, 8)}`;
}

for (
  const [path, registerType] of [
    [
      "register",
      (type: string) =>
        datastoreKindAdapter.register(type, datastoreExport(type), {}, context),
    ],
    [
      "promoteFromLazy",
      (type: string) =>
        datastoreKindAdapter.promoteFromLazy(
          type,
          datastoreExport(type),
          {},
          context,
        ),
    ],
  ] as const
) {
  Deno.test(`datastoreKindAdapter.${path}: extension lock timeouts reject with the core LockTimeoutError`, async () => {
    const type = uniqueType();
    try {
      registerType(type);
      const provider = datastoreTypeRegistry.get(type)?.createProvider?.({
        root: "store",
      });
      assertExists(provider);

      const lock = provider.createLock("/ds", { lockKey: "data/m/.lock" });
      const error = await assertRejects(() => lock.acquire(), LockTimeoutError);
      assertEquals(error.code, "lock_timeout");
      assertEquals(error.lockKey, "data/m/.lock");

      await assertRejects(
        () => lock.withLock(() => Promise.resolve()),
        LockTimeoutError,
      );
    } finally {
      datastoreTypeRegistry.invalidateType(type);
    }
  });
}

Deno.test("datastoreKindAdapter.register: other provider members still reach the class instance", async () => {
  const type = uniqueType();
  try {
    datastoreKindAdapter.register(type, datastoreExport(type), {}, context);
    const provider = datastoreTypeRegistry.get(type)?.createProvider?.({
      root: "store",
    });
    assertExists(provider);

    assertEquals(provider.resolveDatastorePath("/repo"), "/repo/store");
    const health = await provider.createVerifier().verify();
    assertEquals(health.healthy, true);
    assertEquals(provider.resolveCachePath, undefined);

    provider.createLock("/ds", { lockKey: "a" });
    const target = provider as unknown as FakeClassProvider;
    assertEquals(target.lockKeys, ["a"]);
    assertInstanceOf(provider, FakeClassProvider);
  } finally {
    datastoreTypeRegistry.invalidateType(type);
  }
});

Deno.test("datastoreKindAdapter.register: wraps a frozen provider with own methods", async () => {
  const type = uniqueType();
  try {
    datastoreKindAdapter.register(
      type,
      {
        type,
        name: "Frozen",
        description: "Frozen object-literal provider",
        createProvider: () =>
          Object.freeze({
            createLock: (_path: string, options?: LockOptions) => ({
              acquire: () =>
                Promise.reject(
                  new ExtensionLockTimeoutError(options?.lockKey ?? "k", 10),
                ),
              release: () => Promise.resolve(),
              withLock: <T>(fn: () => Promise<T>) => fn(),
              inspect: () => Promise.resolve(null),
              forceRelease: () => Promise.resolve(false),
            }),
            createVerifier: () => new FakeClassProvider("x").createVerifier(),
            resolveDatastorePath: (repoDir: string) => `${repoDir}/frozen`,
          }),
      },
      {},
      context,
    );
    const provider = datastoreTypeRegistry.get(type)?.createProvider?.({});
    assertExists(provider);

    assertEquals(provider.resolveDatastorePath("/r"), "/r/frozen");
    await assertRejects(
      () => provider.createLock("/ds", { lockKey: "f" }).acquire(),
      LockTimeoutError,
    );
  } finally {
    datastoreTypeRegistry.invalidateType(type);
  }
});

Deno.test("datastoreKindAdapter.extractTypeFromSource: ignores a declaration inside a string fixture (swamp-club#2876)", () => {
  assertEquals(
    datastoreKindAdapter.extractTypeFromSource(
      'const src = `export const datastore = { type: "@acme/thing" }`;',
    ),
    null,
  );
  const result = datastoreKindAdapter.extractTypeFromSource(
    'const src = `export const datastore = { type: "@acme/thing" }`;\n' +
      'export const datastore = { type: "@real/store" };',
  );
  assertEquals(result?.typeNormalized, "@real/store");
});
