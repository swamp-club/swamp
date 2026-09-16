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

import type { Workflow } from "./workflow.ts";

/**
 * Computes a deterministic fingerprint of an evaluated workflow by hashing
 * a normalized JSON representation. Non-deterministic fields (the workflow
 * UUID) are excluded so the fingerprint is stable across re-evaluations
 * of the same definition.
 */
export async function computeWorkflowFingerprint(
  workflow: Workflow,
): Promise<string> {
  const data = workflow.toData();
  const normalized = {
    name: data.name,
    jobs: data.jobs,
    inputs: data.inputs,
    concurrency: data.concurrency,
    trigger: data.trigger,
  };
  const json = JSON.stringify(normalized, sortedReplacer);
  const encoded = new TextEncoder().encode(json);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce((acc, k) => {
        acc[k] = (value as Record<string, unknown>)[k];
        return acc;
      }, {} as Record<string, unknown>);
  }
  return value;
}
