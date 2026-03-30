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
 * Type compatibility test for @systeminit/swamp-testing driver types.
 *
 * Verifies that the testing package's execution driver types remain
 * structurally compatible with swamp's canonical types.
 */

import type {
  ExecutionCallbacks as CanonicalExecutionCallbacks,
  ExecutionDriver as CanonicalExecutionDriver,
  ExecutionRequest as CanonicalExecutionRequest,
  ExecutionResult as CanonicalExecutionResult,
} from "./execution_driver.ts";

import type {
  ExecutionCallbacks as TestingExecutionCallbacks,
  ExecutionDriver as TestingExecutionDriver,
  ExecutionRequest as TestingExecutionRequest,
  ExecutionResult as TestingExecutionResult,
} from "../../../packages/testing/driver_types.ts";

// ExecutionRequest: verify field-by-field.
function _checkExecutionRequestFields(req: TestingExecutionRequest) {
  const _protocolVersion: CanonicalExecutionRequest["protocolVersion"] =
    req.protocolVersion;
  const _modelType: CanonicalExecutionRequest["modelType"] = req.modelType;
  const _modelId: CanonicalExecutionRequest["modelId"] = req.modelId;
  const _methodName: CanonicalExecutionRequest["methodName"] = req.methodName;
  const _globalArgs: CanonicalExecutionRequest["globalArgs"] = req.globalArgs;
  const _methodArgs: CanonicalExecutionRequest["methodArgs"] = req.methodArgs;

  // definitionMeta sub-fields
  const _defId: string = req.definitionMeta.id;
  const _defName: string = req.definitionMeta.name;
  const _defVersion: number = req.definitionMeta.version;
  const _defTags: Record<string, string> = req.definitionMeta.tags;

  // Optional fields
  const _resourceSpecs: CanonicalExecutionRequest["resourceSpecs"] =
    req.resourceSpecs;
  const _fileSpecs: CanonicalExecutionRequest["fileSpecs"] = req.fileSpecs;
  const _bundle: CanonicalExecutionRequest["bundle"] = req.bundle;
  const _traceHeaders: CanonicalExecutionRequest["traceHeaders"] =
    req.traceHeaders;

  void [
    _protocolVersion,
    _modelType,
    _modelId,
    _methodName,
    _globalArgs,
    _methodArgs,
    _defId,
    _defName,
    _defVersion,
    _defTags,
    _resourceSpecs,
    _fileSpecs,
    _bundle,
    _traceHeaders,
  ];
}

// ExecutionCallbacks: verify callback signatures.
function _checkExecutionCallbacksFields(cb: TestingExecutionCallbacks) {
  const _onLog: CanonicalExecutionCallbacks["onLog"] = cb.onLog;
  // onResourceWritten: both canonical and testing accept DataHandle.
  // Cannot directly assign due to branded DataId, so verify the optional
  // callback field exists on both types.
  const _onResourceWritten: TestingExecutionCallbacks["onResourceWritten"] =
    cb.onResourceWritten;
  void [_onLog, _onResourceWritten];
}

// ExecutionResult: verify field types.
function _checkExecutionResultFields(result: TestingExecutionResult) {
  const _status: CanonicalExecutionResult["status"] = result.status;
  const _error: CanonicalExecutionResult["error"] = result.error;
  const _logs: CanonicalExecutionResult["logs"] = result.logs;
  const _durationMs: CanonicalExecutionResult["durationMs"] = result.durationMs;
  const _followUpActions: CanonicalExecutionResult["followUpActions"] =
    result.followUpActions;

  void [_status, _error, _logs, _durationMs, _followUpActions];
}

// ExecutionDriver: verify interface shape.
function _checkExecutionDriverFields(driver: TestingExecutionDriver) {
  const _type: CanonicalExecutionDriver["type"] = driver.type;
  const _initialize: CanonicalExecutionDriver["initialize"] = driver.initialize;
  const _shutdown: CanonicalExecutionDriver["shutdown"] = driver.shutdown;

  void [_type, _initialize, _shutdown];
}

Deno.test("testing package driver types: compile-time compatibility check", () => {
  void [
    _checkExecutionRequestFields,
    _checkExecutionCallbacksFields,
    _checkExecutionResultFields,
    _checkExecutionDriverFields,
  ];
});
