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

import type {
  VaultAnnotation,
  VaultAnnotationProvider,
  VaultProvider,
} from "./vault_types.ts";

/** A recorded vault operation for inspection. */
export interface VaultOperation {
  method:
    | "get"
    | "put"
    | "list"
    | "getName"
    | "getAnnotation"
    | "putAnnotation"
    | "deleteAnnotation"
    | "listAnnotations";
  key?: string;
  value?: string;
  timestamp: number;
}

/** Options for creating a vault test context. */
export interface VaultTestContextOptions {
  /** Name of the vault provider (default: "test-vault"). */
  name?: string;
  /** Pre-seed secrets so get() returns them. Keys are secret names. */
  secrets?: Record<string, string>;
  /**
   * If true, get() throws for missing keys (default: true).
   * If false, get() returns "" for missing keys.
   */
  throwOnMissing?: boolean;
  /** If true, the vault also implements VaultAnnotationProvider (default: false). */
  withAnnotations?: boolean;
}

/** The return value from createVaultTestContext. */
export interface VaultTestContextResult {
  /** The VaultProvider to pass to code under test. */
  vault: VaultProvider;
  /** The VaultAnnotationProvider if withAnnotations was true, otherwise undefined. */
  annotationProvider: VaultAnnotationProvider | undefined;
  /** Returns all secrets currently stored in the vault. */
  getStoredSecrets(): Record<string, string>;
  /** Returns all vault operations recorded during the test. */
  getOperations(): VaultOperation[];
  /** Returns operations filtered by method name. */
  getOperationsByMethod(
    method: VaultOperation["method"],
  ): VaultOperation[];
}

/**
 * Creates an in-memory VaultProvider for unit testing extension code
 * that interacts with vaults.
 *
 * ```typescript
 * import { createVaultTestContext } from "@systeminit/swamp-testing";
 *
 * Deno.test("reads API key from vault", async () => {
 *   const { vault, getOperations } = createVaultTestContext({
 *     secrets: { "api-key": "sk-test-123" },
 *   });
 *
 *   const key = await vault.get("api-key");
 *   assertEquals(key, "sk-test-123");
 *   assertEquals(getOperations().length, 1);
 * });
 * ```
 */
export function createVaultTestContext(
  options?: VaultTestContextOptions,
): VaultTestContextResult {
  const secrets = new Map<string, string>(
    Object.entries(options?.secrets ?? {}),
  );
  const annotations = new Map<string, VaultAnnotation>();
  const operations: VaultOperation[] = [];
  const name = options?.name ?? "test-vault";
  const throwOnMissing = options?.throwOnMissing ?? true;
  const withAnnotations = options?.withAnnotations ?? false;

  function record(
    method: VaultOperation["method"],
    key?: string,
    value?: string,
  ) {
    operations.push({ method, key, value, timestamp: Date.now() });
  }

  const vault: VaultProvider = {
    get(secretKey: string): Promise<string> {
      record("get", secretKey);
      const secret = secrets.get(secretKey);
      if (secret === undefined) {
        if (throwOnMissing) {
          return Promise.reject(
            new Error(
              `Secret '${secretKey}' not found in test vault '${name}'`,
            ),
          );
        }
        return Promise.resolve("");
      }
      return Promise.resolve(secret);
    },

    put(secretKey: string, secretValue: string): Promise<void> {
      record("put", secretKey, secretValue);
      secrets.set(secretKey, secretValue);
      return Promise.resolve();
    },

    list(): Promise<string[]> {
      record("list");
      return Promise.resolve(Array.from(secrets.keys()).sort());
    },

    getName(): string {
      record("getName");
      return name;
    },
  };

  let annotationProvider: VaultAnnotationProvider | undefined;
  if (withAnnotations) {
    annotationProvider = {
      getAnnotation(secretKey: string): Promise<VaultAnnotation | null> {
        record("getAnnotation", secretKey);
        return Promise.resolve(annotations.get(secretKey) ?? null);
      },

      putAnnotation(
        secretKey: string,
        annotation: VaultAnnotation,
      ): Promise<void> {
        record("putAnnotation", secretKey);
        annotations.set(secretKey, annotation);
        return Promise.resolve();
      },

      deleteAnnotation(secretKey: string): Promise<void> {
        record("deleteAnnotation", secretKey);
        annotations.delete(secretKey);
        return Promise.resolve();
      },

      listAnnotations(): Promise<Map<string, VaultAnnotation>> {
        record("listAnnotations");
        return Promise.resolve(new Map(annotations));
      },
    };
  }

  return {
    vault,
    annotationProvider,
    getStoredSecrets: () => Object.fromEntries(secrets),
    getOperations: () => [...operations],
    getOperationsByMethod: (method) =>
      operations.filter((op) => op.method === method),
  };
}
