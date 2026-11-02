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
  DataHandle as CanonicalDataHandle,
  DataWriter as _CanonicalDataWriter,
  MethodContext as _CanonicalMethodContext,
  MethodDefinition as _CanonicalMethodDefinition,
  MethodResult as _CanonicalMethodResult,
  ModelDefinition as _CanonicalModelDefinition,
} from "./model.ts";

import type {
  DataHandle as TestingDataHandle,
  DataRecord as TestingDataRecord,
  DataWriter as TestingDataWriter,
  MethodContext as TestingMethodContext,
  MethodResult as TestingMethodResult,
} from "../../../packages/testing/types.ts";

import type { DataRecord as CanonicalDataRecord } from "../data/data_record.ts";

import type {
  MethodDefinition as TestingMethodDefinition,
  ModelDefinition as TestingModelDefinition,
} from "../../../packages/testing/model_definition_types.ts";

/**
 * the testing types differ from the canonical ones (required vs optional
 * fields, plain vs branded DataId), so assignability fails; check field by
 * field so a rename or type change fails to compile
 */

function _checkContextFields(ctx: TestingMethodContext) {
  const _signal: _CanonicalMethodContext["signal"] = ctx.signal;
  const _repoDir: _CanonicalMethodContext["repoDir"] = ctx.repoDir;
  const _globalArgs: _CanonicalMethodContext["globalArgs"] = ctx.globalArgs;
  const _methodName: _CanonicalMethodContext["methodName"] = ctx.methodName;
  const _createCelEnvironment: _CanonicalMethodContext["createCelEnvironment"] =
    ctx.createCelEnvironment;

  const _defName: string = ctx.definition.name;
  const _defId: string = ctx.definition.id;
  const _defVersion: number = ctx.definition.version;
  const _defTags: Record<string, string> = ctx.definition.tags;

  const _readModelData: (
    modelName: string,
    specName?: string,
  ) => Promise<TestingDataRecord[]> = ctx.readModelData;

  void [_signal, _repoDir, _globalArgs, _methodName, _createCelEnvironment];
  void [_defName, _defId, _defVersion, _defTags, _readModelData];
}

function _checkDataRecordFields(record: TestingDataRecord) {
  const _id: CanonicalDataRecord["id"] = record.id;
  const _name: CanonicalDataRecord["name"] = record.name;
  const _version: CanonicalDataRecord["version"] = record.version;
  const _isLatest: CanonicalDataRecord["isLatest"] = record.isLatest;
  const _createdAt: CanonicalDataRecord["createdAt"] = record.createdAt;
  const _namespace: CanonicalDataRecord["namespace"] = record.namespace;
  const _attributes: CanonicalDataRecord["attributes"] = record.attributes;
  const _tags: CanonicalDataRecord["tags"] = record.tags;
  const _modelName: CanonicalDataRecord["modelName"] = record.modelName;
  const _modelId: CanonicalDataRecord["modelId"] = record.modelId;
  const _modelType: CanonicalDataRecord["modelType"] = record.modelType;
  const _specName: CanonicalDataRecord["specName"] = record.specName;
  const _dataType: CanonicalDataRecord["dataType"] = record.dataType;
  const _contentType: CanonicalDataRecord["contentType"] = record.contentType;
  const _lifetime: CanonicalDataRecord["lifetime"] = record.lifetime;
  const _ownerType: CanonicalDataRecord["ownerType"] = record.ownerType;
  const _streaming: CanonicalDataRecord["streaming"] = record.streaming;
  const _size: CanonicalDataRecord["size"] = record.size;
  const _content: CanonicalDataRecord["content"] = record.content;
  const _ownerRef: CanonicalDataRecord["ownerRef"] = record.ownerRef;
  const _workflowRunId: CanonicalDataRecord["workflowRunId"] =
    record.workflowRunId;
  const _workflowName: CanonicalDataRecord["workflowName"] =
    record.workflowName;
  const _jobName: CanonicalDataRecord["jobName"] = record.jobName;
  const _stepName: CanonicalDataRecord["stepName"] = record.stepName;
  const _source: CanonicalDataRecord["source"] = record.source;

  void [
    _id,
    _name,
    _version,
    _isLatest,
    _createdAt,
    _namespace,
    _attributes,
    _tags,
    _modelName,
    _modelId,
    _modelType,
    _specName,
    _dataType,
    _contentType,
    _lifetime,
    _ownerType,
    _streaming,
    _size,
    _content,
    _ownerRef,
    _workflowRunId,
    _workflowName,
    _jobName,
    _stepName,
    _source,
  ];
}

function _checkDataHandleFields(handle: TestingDataHandle) {
  const _name: CanonicalDataHandle["name"] = handle.name;
  const _specName: CanonicalDataHandle["specName"] = handle.specName;
  const _kind: CanonicalDataHandle["kind"] = handle.kind;
  const _version: CanonicalDataHandle["version"] = handle.version;
  const _size: CanonicalDataHandle["size"] = handle.size;
  const _tags: CanonicalDataHandle["tags"] = handle.tags;
  const _dataId: string = handle.dataId;
  const _attributes: CanonicalDataHandle["attributes"] = handle.attributes;

  void [_name, _specName, _kind, _version, _size, _tags, _dataId, _attributes];
}

function _checkDataWriterFields(writer: TestingDataWriter) {
  const _writeAllResult = writer.writeAll(new Uint8Array());
  const _writeTextResult = writer.writeText("");
  const _writeLineResult = writer.writeLine("");
  const _getFilePathResult = writer.getFilePath();
  const _finalizeResult = writer.finalize();

  const _p1: Promise<TestingDataHandle> = _writeAllResult;
  const _p2: Promise<TestingDataHandle> = _writeTextResult;
  const _p3: Promise<void> = _writeLineResult;
  const _p4: Promise<string> = _getFilePathResult;
  const _p5: Promise<TestingDataHandle> = _finalizeResult;

  const _dataId: string = writer.dataId;
  const _name: _CanonicalDataWriter["name"] = writer.name;

  void [_p1, _p2, _p3, _p4, _p5, _dataId, _name];
}

function _checkMethodResultFields(result: TestingMethodResult) {
  if (result.dataHandles) {
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

function _checkMethodDefinitionFields(def: TestingMethodDefinition) {
  const _description: _CanonicalMethodDefinition["description"] =
    def.description;
  const _hasArguments: boolean = typeof def.arguments._zod === "object";
  const _execute: (
    args: ReturnType<typeof def.arguments.parse>,
    ctx: TestingMethodContext,
  ) => Promise<{ dataHandles?: unknown }> = def.execute as never;

  void [_description, _hasArguments, _execute];
}

function _checkModelDefinitionFields(
  def: TestingModelDefinition,
) {
  const _type: string = def.type;
  const _version: _CanonicalModelDefinition["version"] = def.version;

  if (def.methods) {
    for (const methodName of Object.keys(def.methods)) {
      const method = def.methods[methodName];
      _checkMethodDefinitionFields(method);
    }
  }

  if (def.upgrades) {
    for (const upgrade of def.upgrades) {
      const _toVersion: string = upgrade.toVersion;
      void _toVersion;
    }
  }

  void [_type, _version];
}

Deno.test("testing package types: compile-time compatibility check", () => {
  void [
    _checkContextFields,
    _checkDataHandleFields,
    _checkDataRecordFields,
    _checkDataWriterFields,
    _checkMethodResultFields,
    _checkMethodDefinitionFields,
    _checkModelDefinitionFields,
  ];
});

// the testing package mirrors createExtensionCelEnvironment locally because it
// cannot import from src/ at publish; these tests fail if the two diverge
import { assertEquals, assertThrows } from "@std/assert";
import { createExtensionCelEnvironment as canonicalFactory } from "../../infrastructure/cel/cel_evaluator.ts";
import { createExtensionCelEnvironment as testingFactory } from "../../../packages/testing/_cel_environment.ts";

Deno.test("cel env factory parity: both factories produce identical results", () => {
  const exprs: Array<[string, Record<string, unknown>]> = [
    ["a + 2", { a: 1.5 }],
    ["a - 1", { a: 3.5 }],
    ["a * 2", { a: 1.5 }],
    ["a / 2", { a: 5.0 }],
    ["a % 2", { a: 5.0 }],
    ["2 + a", { a: 1.5 }],
    ["a.?b", { a: { b: 42 } }],
    ["a.?b", { a: null }],
    ['{"k": a, "lit": "v"}', { a: "dyn" }],
  ];

  const a = canonicalFactory();
  const b = testingFactory();

  for (const [expr, ctx] of exprs) {
    assertEquals(
      a.evaluate(expr, ctx),
      b.evaluate(expr, ctx),
      `Factories diverge on expression "${expr}"`,
    );
  }

  a.registerFunction("quadruple(int): int", (x: bigint) => x * 4n);
  b.registerFunction("quadruple(int): int", (x: bigint) => x * 4n);
  assertEquals(a.evaluate("quadruple(5)"), b.evaluate("quadruple(5)"));
});

Deno.test("cel env factory isolation: each call returns a fresh Environment", () => {
  for (const factory of [canonicalFactory, testingFactory]) {
    const first = factory();
    first.registerFunction("only_on_first(): bool", () => true);
    assertEquals(first.evaluate("only_on_first()"), true);

    const second = factory();
    assertThrows(
      () => second.evaluate("only_on_first()"),
      Error,
    );
  }
});
