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
  VaultExistenceProvider as CanonicalVaultExistenceProvider,
  VaultProvider as CanonicalVaultProvider,
} from "./vault_provider.ts";
import type {
  VaultAnnotationData as CanonicalVaultAnnotationData,
  VaultAnnotationProvider as CanonicalVaultAnnotationProvider,
} from "./vault_annotation.ts";
import { assertEquals } from "@std/assert";
import {
  isSecretNotFoundError as testingIsSecretNotFoundError,
  SECRET_NOT_FOUND_CODE as TESTING_SECRET_NOT_FOUND_CODE,
  SecretNotFoundError as TestingSecretNotFoundError,
} from "../../../packages/testing/vault_types.ts";
import {
  isSecretNotFoundError,
  SECRET_NOT_FOUND_CODE,
  SecretNotFoundError,
} from "./secret_not_found_error.ts";
import type {
  VaultAnnotation as TestingVaultAnnotation,
  VaultAnnotationData as TestingVaultAnnotationData,
  VaultAnnotationProvider as TestingVaultAnnotationProvider,
  VaultExistenceProvider as TestingVaultExistenceProvider,
  VaultProvider as TestingVaultProvider,
} from "../../../packages/testing/vault_types.ts";

function _checkVaultProviderFields(vault: TestingVaultProvider) {
  const _getResult: ReturnType<CanonicalVaultProvider["get"]> = vault.get(
    "key",
  );
  const _putResult: ReturnType<CanonicalVaultProvider["put"]> = vault.put(
    "key",
    "value",
  );
  const _putWithTagsResult: ReturnType<CanonicalVaultProvider["put"]> = vault
    .put(
      "key",
      "value",
      { tags: { env: "test" } },
    );
  const _listResult: ReturnType<CanonicalVaultProvider["list"]> = vault.list();
  const _getNameResult: ReturnType<CanonicalVaultProvider["getName"]> = vault
    .getName();

  void [
    _getResult,
    _putResult,
    _putWithTagsResult,
    _listResult,
    _getNameResult,
  ];
}

function _checkVaultAnnotationProviderFields(
  provider: TestingVaultAnnotationProvider,
) {
  const _getAnnotation: ReturnType<
    CanonicalVaultAnnotationProvider["getAnnotation"]
  > = provider.getAnnotation("key") as ReturnType<
    CanonicalVaultAnnotationProvider["getAnnotation"]
  >;
  const _putAnnotation: ReturnType<
    CanonicalVaultAnnotationProvider["putAnnotation"]
  > = provider.putAnnotation(
    "key",
    {} as TestingVaultAnnotation,
  );
  const _deleteAnnotation: ReturnType<
    CanonicalVaultAnnotationProvider["deleteAnnotation"]
  > = provider.deleteAnnotation("key");
  const _listAnnotations: ReturnType<
    CanonicalVaultAnnotationProvider["listAnnotations"]
  > = provider.listAnnotations() as ReturnType<
    CanonicalVaultAnnotationProvider["listAnnotations"]
  >;

  void [_getAnnotation, _putAnnotation, _deleteAnnotation, _listAnnotations];
}

function _checkVaultAnnotationDataFields(data: TestingVaultAnnotationData) {
  const _canonical: CanonicalVaultAnnotationData = {
    updatedAt: data.updatedAt,
    url: data.url,
    notes: data.notes,
    labels: data.labels,
  };

  void _canonical;
}

function _checkVaultAnnotationMethods(annotation: TestingVaultAnnotation) {
  const _toData: CanonicalVaultAnnotationData = annotation
    .toData() as CanonicalVaultAnnotationData;
  const _isEmpty: boolean = annotation.isEmpty();
  const _url: string | undefined = annotation.url;
  const _notes: string | undefined = annotation.notes;
  const _labels: Readonly<Record<string, string>> = annotation.labels;
  const _updatedAt: Date = annotation.updatedAt;

  void [_toData, _isEmpty, _url, _notes, _labels, _updatedAt];
}

function _checkVaultExistenceProviderFields(
  provider: TestingVaultExistenceProvider,
) {
  const _has: ReturnType<CanonicalVaultExistenceProvider["has"]> = provider
    .has("key");
  void _has;
}

Deno.test("testing package vault types: compile-time compatibility check", () => {
  void [
    _checkVaultProviderFields,
    _checkVaultExistenceProviderFields,
    _checkVaultAnnotationProviderFields,
    _checkVaultAnnotationDataFields,
    _checkVaultAnnotationMethods,
  ];
});

Deno.test("testing package SecretNotFoundError: each side recognises the other's error", () => {
  assertEquals(TESTING_SECRET_NOT_FOUND_CODE, SECRET_NOT_FOUND_CODE);
  const fromExtension = new TestingSecretNotFoundError("creds", "token");
  const fromHost = new SecretNotFoundError("creds", "token");
  assertEquals(isSecretNotFoundError(fromExtension), true);
  assertEquals(testingIsSecretNotFoundError(fromHost), true);
  assertEquals(fromExtension.name, fromHost.name);
  assertEquals(fromExtension.message, fromHost.message);
  assertEquals(fromExtension.vaultName, fromHost.vaultName);
  assertEquals(fromExtension.key, fromHost.key);
});

Deno.test("testing package SecretNotFoundError: both helpers ignore a code found only in a cause", () => {
  const wrapped = new Error("could not authenticate", {
    cause: new TestingSecretNotFoundError("login", "service-token"),
  });
  assertEquals(isSecretNotFoundError(wrapped), false);
  assertEquals(testingIsSecretNotFoundError(wrapped), false);
});
