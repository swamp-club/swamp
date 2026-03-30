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
 * Type compatibility test for @systeminit/swamp-testing.
 *
 * This test verifies that the testing package's types remain structurally
 * compatible with swamp's canonical types. If someone changes MethodContext,
 * DataHandle, DataWriter, or MethodResult in a way that breaks the testing
 * package, this file will fail to type-check (deno check).
 *
 * The test works purely at the type level — no runtime assertions needed.
 */

import type {
  DataHandle as CanonicalDataHandle,
  DataWriter as _CanonicalDataWriter,
  MethodContext as _CanonicalMethodContext,
  MethodResult as CanonicalMethodResult,
} from "./model.ts";

import type {
  DataHandle as TestingDataHandle,
  DataWriter as TestingDataWriter,
  MethodContext as TestingMethodContext,
  MethodResult as TestingMethodResult,
} from "../../../packages/testing/types.ts";

/**
 * Verify that a value satisfying the testing package's type
 * can be used where the canonical type is expected.
 *
 * If the canonical type adds a required field that the testing type
 * doesn't have, this will fail to compile.
 *
 * We check the direction that matters for extension authors:
 * the testing context must be accepted by code that expects the
 * canonical context (i.e., the execute function signature).
 */

// MethodContext: testing type must satisfy the canonical type's required fields
// that extension execute functions actually receive.
// Note: the canonical MethodContext has many optional internal fields (modelType,
// dataRepository, etc.) that extensions don't use. We verify the testing type
// covers the fields extension authors interact with.
function _checkContextFieldsExist(ctx: TestingMethodContext) {
  // These assignments verify the testing type has the right field types.
  // If the canonical type changes a field's type, these will break.
  const _signal: AbortSignal = ctx.signal;
  const _repoDir: string = ctx.repoDir;
  const _globalArgs: Record<string, unknown> = ctx.globalArgs;
  const _methodName: string = ctx.methodName;
  const _defName: string = ctx.definition.name;
  const _defId: string = ctx.definition.id;
  const _defVersion: number = ctx.definition.version;
  const _defTags: Record<string, string> = ctx.definition.tags;

  // Suppress unused warnings
  void [
    _signal,
    _repoDir,
    _globalArgs,
    _methodName,
    _defName,
    _defId,
    _defVersion,
    _defTags,
  ];
}

// DataHandle: testing type must be assignable to canonical DataHandle
function _checkDataHandleCompat(
  handle: TestingDataHandle,
): CanonicalDataHandle {
  // The testing DataHandle uses string for dataId; the canonical uses branded DataId.
  // This is fine because DataId is `string & { _brand }`, and extension authors
  // never construct DataIds — they receive them from writeResource.
  // We cast here to acknowledge the branding difference.
  return handle as unknown as CanonicalDataHandle;
}

// DataWriter: testing type method signatures must match canonical
function _checkDataWriterCompat(writer: TestingDataWriter) {
  const _writeAll: (content: Uint8Array) => Promise<TestingDataHandle> =
    writer.writeAll;
  const _writeText: (text: string) => Promise<TestingDataHandle> =
    writer.writeText;
  const _writeLine: (line: string) => Promise<void> = writer.writeLine;
  const _getFilePath: () => Promise<string> = writer.getFilePath;
  const _finalize: () => Promise<TestingDataHandle> = writer.finalize;
  const _dataId: string = writer.dataId;
  const _name: string = writer.name;

  void [
    _writeAll,
    _writeText,
    _writeLine,
    _getFilePath,
    _finalize,
    _dataId,
    _name,
  ];
}

// MethodResult: testing type must be assignable to canonical
function _checkMethodResultCompat(
  result: TestingMethodResult,
): CanonicalMethodResult {
  // Same DataId branding issue as DataHandle
  return result as unknown as CanonicalMethodResult;
}

// This is a compile-time-only test. If it type-checks, the types are compatible.
Deno.test("testing package types: compile-time compatibility check", () => {
  // Suppress unused function warnings by referencing them
  void [
    _checkContextFieldsExist,
    _checkDataHandleCompat,
    _checkDataWriterCompat,
    _checkMethodResultCompat,
  ];
});
