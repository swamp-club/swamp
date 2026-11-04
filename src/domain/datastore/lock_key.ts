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

/**
 * Constructs the canonical per-model lock key, optionally scoped under a
 * namespace. Uses `/` (not SEPARATOR) since lock keys are passed as opaque
 * strings to custom providers (e.g. S3 object keys).
 */
export function modelLockKey(
  namespace: string | undefined,
  modelType: string,
  modelId: string,
): string {
  const base = `data/${modelType}/${modelId}/.lock`;
  return namespace ? `${namespace}/${base}` : base;
}

/**
 * Constructs the lock key of a workflow run's claim, optionally scoped under
 * a namespace. It sits outside `data/` and `workflow-runs/`, so neither the
 * per-model lock scan nor the run repository's directory reads see it, and
 * the file is named `.lock`, the one name datastore sync never transfers.
 */
export function workflowRunLockKey(
  namespace: string | undefined,
  runId: string,
): string {
  const base = `workflow-run-claims/${runId}/.lock`;
  return namespace ? `${namespace}/${base}` : base;
}
