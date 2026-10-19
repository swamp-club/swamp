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

import { UserError } from "../../domain/errors.ts";
import { redactServerUrl } from "../../domain/auth/server_url.ts";

export function parseLabels(
  labelFlags: string[] | undefined,
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const flag of labelFlags ?? []) {
    const eq = flag.indexOf("=");
    if (eq <= 0 || eq === flag.length - 1) {
      throw new UserError(
        `Invalid label '${flag}' — expected the form key=value`,
      );
    }
    labels[flag.slice(0, eq)] = flag.slice(eq + 1);
  }
  return labels;
}

/**
 * Parses SWAMP_WORKER_LABELS — the comma-joined form `worker daemon enable`
 * writes into the service — back into labels.
 */
export function parseCommaSeparatedLabels(
  envValue: string,
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const pair of envValue.split(",")) {
    const trimmed = pair.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0 || eq === trimmed.length - 1) {
      throw new UserError(
        `Invalid label '${trimmed}' in SWAMP_WORKER_LABELS — expected the form key=value`,
      );
    }
    labels[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return labels;
}

export function validateOrchestratorUrl(url: string): void {
  if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
    const shown = redactServerUrl(url);
    throw new UserError(
      `Orchestrator URL must start with ws:// or wss://${
        shown === undefined ? "" : ` (got '${shown}')`
      }`,
    );
  }
}

export function validateMaxDispatches(maxDispatches: number): void {
  if (
    isNaN(maxDispatches) || !Number.isInteger(maxDispatches) ||
    maxDispatches < 1
  ) {
    throw new UserError(
      "--max-dispatches must be a positive integer",
    );
  }
}

/**
 * Parses a --concurrency value: a positive integer, or "auto" for the CPU
 * count of the machine running the worker (min 1).
 */
export function parseConcurrency(raw: string): number {
  if (raw === "auto") {
    return Math.max(1, navigator.hardwareConcurrency ?? 1);
  }
  const parsed = Number(raw);
  if (isNaN(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new UserError(
      '--concurrency must be a positive integer or "auto"',
    );
  }
  return parsed;
}
