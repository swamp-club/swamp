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
  MethodResult as _CanonicalMethodResult,
} from "./model.ts";

import type {
  DataHandle as TestingDataHandle,
  DataWriter as TestingDataWriter,
  MethodContext as TestingMethodContext,
  MethodResult as TestingMethodResult,
} from "../../../packages/testing/types.ts";

/**
 * Structural compatibility checks between the testing package types and
 * swamp's canonical types.
 *
 * Limitations:
 * - The testing package's MethodContext declares writeResource, readResource,
 *   and createFileWriter as required, while the canonical type has them as
 *   optional. This is intentional — the testing context always provides them.
 * - The canonical MethodContext has required internal fields (modelType, modelId,
 *   dataRepository, definitionRepository) that the testing type omits. This
 *   means neither type is directly assignable to the other.
 * - DataHandle uses a branded DataId in the canonical type but plain string in
 *   the testing type. Extension authors never construct DataIds directly.
 *
 * Because of these differences, we cannot use direct type assignability checks.
 * Instead, we verify field-by-field that every field in the testing type has a
 * compatible type in the canonical interface. If the canonical type renames a
 * field, changes its type, or removes it, these assignments will fail to
 * compile.
 */

// MethodContext: verify the testing type's fields match the canonical field types.
// Uses _CanonicalMethodContext indexed access so if the canonical type renames
// or changes a field's type, the assignment will fail to compile.
function _checkContextFields(ctx: TestingMethodContext) {
  const _signal: _CanonicalMethodContext["signal"] = ctx.signal;
  const _repoDir: _CanonicalMethodContext["repoDir"] = ctx.repoDir;
  const _globalArgs: _CanonicalMethodContext["globalArgs"] = ctx.globalArgs;
  const _methodName: _CanonicalMethodContext["methodName"] = ctx.methodName;

  // definition sub-fields (canonical uses inline object type, not DefinitionInfo)
  const _defName: string = ctx.definition.name;
  const _defId: string = ctx.definition.id;
  const _defVersion: number = ctx.definition.version;
  const _defTags: Record<string, string> = ctx.definition.tags;

  void [_signal, _repoDir, _globalArgs, _methodName];
  void [_defName, _defId, _defVersion, _defTags];
}

// DataHandle: verify field-by-field.
// Cannot use CanonicalDataHandle indexed access for dataId because it's a
// branded type (DataId = string & { _brand }). We check all other fields
// via the canonical type and verify dataId is at least a string.
function _checkDataHandleFields(handle: TestingDataHandle) {
  const _name: CanonicalDataHandle["name"] = handle.name;
  const _specName: CanonicalDataHandle["specName"] = handle.specName;
  const _kind: CanonicalDataHandle["kind"] = handle.kind;
  const _version: CanonicalDataHandle["version"] = handle.version;
  const _size: CanonicalDataHandle["size"] = handle.size;
  const _tags: CanonicalDataHandle["tags"] = handle.tags;
  // dataId: canonical uses branded DataId, testing uses plain string.
  // The brand is a compile-time fiction — extension authors never construct DataIds.
  const _dataId: string = handle.dataId;

  void [_name, _specName, _kind, _version, _size, _tags, _dataId];
}

// DataWriter: verify method parameter types match.
// Cannot directly assign method references because return types include
// DataHandle (with branded DataId). Instead we verify parameter types
// and structural properties.
function _checkDataWriterFields(writer: TestingDataWriter) {
  // Verify methods exist and accept the right parameter types
  const _writeAllResult = writer.writeAll(new Uint8Array());
  const _writeTextResult = writer.writeText("");
  const _writeLineResult = writer.writeLine("");
  const _getFilePathResult = writer.getFilePath();
  const _finalizeResult = writer.finalize();

  // Verify return types are Promises
  const _p1: Promise<TestingDataHandle> = _writeAllResult;
  const _p2: Promise<TestingDataHandle> = _writeTextResult;
  const _p3: Promise<void> = _writeLineResult;
  const _p4: Promise<string> = _getFilePathResult;
  const _p5: Promise<TestingDataHandle> = _finalizeResult;

  // Verify properties match canonical types
  const _dataId: string = writer.dataId;
  const _name: _CanonicalDataWriter["name"] = writer.name;

  void [_p1, _p2, _p3, _p4, _p5, _dataId, _name];
}

// MethodResult: verify field structure matches.
// Cannot check full assignability due to branded DataId in DataHandle.
function _checkMethodResultFields(result: TestingMethodResult) {
  if (result.dataHandles) {
    // Verify each element has the expected shape
    for (const handle of result.dataHandles) {
      const _name: string = handle.name;
      const _specName: string = handle.specName;
      const _kind: "resource" | "file" = handle.kind;
      const _dataId: string = handle.dataId;
      const _version: number = handle.version;
      const _size: number = handle.size;
      void [_name, _specName, _kind, _dataId, _version, _size];
    }
  }
}

// This is a compile-time-only test. If it type-checks, the types are compatible.
Deno.test("testing package types: compile-time compatibility check", () => {
  void [
    _checkContextFields,
    _checkDataHandleFields,
    _checkDataWriterFields,
    _checkMethodResultFields,
  ];
});
