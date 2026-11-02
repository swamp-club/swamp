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
  VaultExistenceProvider,
  VaultProvider,
  VaultPutOptions,
} from "./vault_types.ts";

export interface VaultOperation {
  method:
    | "get"
    | "has"
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

export interface VaultTestContextOptions {
  name?: string;
  secrets?: Record<string, string>;
  /**
   * If true, get() throws for missing keys (default: true).
   * If false, get() returns "" for missing keys.
   */
  throwOnMissing?: boolean;
  withAnnotations?: boolean;
  /**
   * has() answers presence without touching the value and records a "has"
   * operation, so value reads and existence checks count separately. Requires
   * throwOnMissing, since has() must agree with get().
   */
  withExistence?: boolean;
  /**
   * Keys the vault's credentials may not read. get() and has() both reject
   * them with the same error, as a real provider does for a key it can see
   * but not read. put() and list() are unaffected.
   */
  unauthorizedKeys?: string[];
}

export interface VaultTestContextResult {
  vault: VaultProvider;
  annotationProvider: VaultAnnotationProvider | undefined;
  getStoredSecrets(): Record<string, string>;
  getStoredTags(secretKey: string): Record<string, string> | undefined;
  getOperations(): VaultOperation[];
  getOperationsByMethod(
    method: VaultOperation["method"],
  ): VaultOperation[];
}

export interface VaultExistenceTestContextResult
  extends VaultTestContextResult {
  vault: VaultProvider & VaultExistenceProvider;
}

export function createVaultTestContext(
  options: VaultTestContextOptions & { withExistence: true },
): VaultExistenceTestContextResult;
export function createVaultTestContext(
  options?: VaultTestContextOptions,
): VaultTestContextResult;
export function createVaultTestContext(
  options?: VaultTestContextOptions,
): VaultTestContextResult {
  const secrets = new Map<string, string>(
    Object.entries(options?.secrets ?? {}),
  );
  const tags = new Map<string, Record<string, string>>();
  const annotations = new Map<string, VaultAnnotation>();
  const operations: VaultOperation[] = [];
  const name = options?.name ?? "test-vault";
  const throwOnMissing = options?.throwOnMissing ?? true;
  const withAnnotations = options?.withAnnotations ?? false;
  const withExistence = options?.withExistence ?? false;
  const unauthorized = new Set(options?.unauthorizedKeys ?? []);
  if (withExistence && !throwOnMissing) {
    throw new Error(
      "createVaultTestContext: withExistence requires throwOnMissing, " +
        "because has() must agree with get() and a get() that returns the " +
        "empty string for a missing key always succeeds",
    );
  }

  function unauthorizedError(secretKey: string): Error {
    return new Error(
      `Access denied to secret '${secretKey}' in test vault '${name}'`,
    );
  }

  function record(
    method: VaultOperation["method"],
    key?: string,
    value?: string,
  ) {
    operations.push({ method, key, value, timestamp: Date.now() });
  }

  const baseVault: VaultProvider = {
    get(secretKey: string): Promise<string> {
      record("get", secretKey);
      if (unauthorized.has(secretKey)) {
        return Promise.reject(unauthorizedError(secretKey));
      }
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

    put(
      secretKey: string,
      secretValue: string,
      putOptions?: VaultPutOptions,
    ): Promise<void> {
      record("put", secretKey, secretValue);
      secrets.set(secretKey, secretValue);
      if (putOptions?.tags && Object.keys(putOptions.tags).length > 0) {
        tags.set(secretKey, { ...putOptions.tags });
      }
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

  const vault: VaultProvider = withExistence
    ? Object.assign(baseVault, {
      has(secretKey: string): Promise<boolean> {
        record("has", secretKey);
        if (unauthorized.has(secretKey)) {
          return Promise.reject(unauthorizedError(secretKey));
        }
        return Promise.resolve(secrets.has(secretKey));
      },
    })
    : baseVault;

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
    getStoredTags: (secretKey: string) => {
      const stored = tags.get(secretKey);
      return stored ? { ...stored } : undefined;
    },
    getOperations: () => [...operations],
    getOperationsByMethod: (method) =>
      operations.filter((op) => op.method === method),
  };
}
