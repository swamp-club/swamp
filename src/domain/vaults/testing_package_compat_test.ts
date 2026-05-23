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

/**
 * Type compatibility test for @systeminit/swamp-testing vault types.
 *
 * Verifies that the testing package's VaultProvider type remains structurally
 * compatible with swamp's canonical VaultProvider. If someone changes the
 * canonical interface, this file will fail to type-check.
 */

import type { VaultProvider as CanonicalVaultProvider } from "./vault_provider.ts";
import type {
  VaultAnnotationData as CanonicalVaultAnnotationData,
  VaultAnnotationProvider as CanonicalVaultAnnotationProvider,
} from "./vault_annotation.ts";
import type {
  VaultAnnotation as TestingVaultAnnotation,
  VaultAnnotationData as TestingVaultAnnotationData,
  VaultAnnotationProvider as TestingVaultAnnotationProvider,
  VaultProvider as TestingVaultProvider,
} from "../../../packages/testing/vault_types.ts";

// VaultProvider: verify the testing type's methods match the canonical type.
function _checkVaultProviderFields(vault: TestingVaultProvider) {
  // Verify method signatures match canonical return types
  const _getResult: ReturnType<CanonicalVaultProvider["get"]> = vault.get(
    "key",
  );
  const _putResult: ReturnType<CanonicalVaultProvider["put"]> = vault.put(
    "key",
    "value",
  );
  const _listResult: ReturnType<CanonicalVaultProvider["list"]> = vault.list();
  const _getNameResult: ReturnType<CanonicalVaultProvider["getName"]> = vault
    .getName();

  void [_getResult, _putResult, _listResult, _getNameResult];
}

// VaultAnnotationProvider: verify the testing type's methods match the canonical type.
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

// VaultAnnotationData: verify field compatibility.
function _checkVaultAnnotationDataFields(data: TestingVaultAnnotationData) {
  const _canonical: CanonicalVaultAnnotationData = {
    updatedAt: data.updatedAt,
    url: data.url,
    notes: data.notes,
    labels: data.labels,
  };

  void _canonical;
}

// VaultAnnotation: verify instance method compatibility.
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

Deno.test("testing package vault types: compile-time compatibility check", () => {
  void [
    _checkVaultProviderFields,
    _checkVaultAnnotationProviderFields,
    _checkVaultAnnotationDataFields,
    _checkVaultAnnotationMethods,
  ];
});
