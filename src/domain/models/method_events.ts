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
 * Domain events emitted during method execution.
 *
 * These events are topology-agnostic — they carry no jobId or stepId.
 * The workflow execution layer wraps them with topology context when
 * forwarding to the event stream.
 */
export type MethodExecutionEvent =
  | {
    type: "output";
    line: string;
    stream: "stdout" | "stderr";
  }
  | {
    type: "vault_secret_stored";
    fieldPath: string;
    vaultName: string;
    vaultKey: string;
  }
  | {
    type: "schema_validation_warning";
    specName: string;
    instanceName: string;
    error: string;
  };
