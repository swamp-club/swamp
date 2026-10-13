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

import type { LoaderKind } from "./kind_adapter.ts";
import type { SourceFingerprint } from "./source_fingerprint.ts";
import { ValidationError } from "./validation_error.ts";

/**
 * What a bundle exports, learned without loading it into the main isolate.
 * Every variant is plain data, so a result can cross an isolation boundary.
 */
export type BundleProbeResult =
  | {
    readonly tag: "primary";
    readonly typeNormalized: string;
    readonly version: string;
    readonly description: string;
  }
  | { readonly tag: "secondary"; readonly typeNormalized: string }
  | { readonly tag: "no-export" }
  | { readonly tag: "validation-failed"; readonly message: string }
  | { readonly tag: "import-failed"; readonly message: string }
  | { readonly tag: "timed-out"; readonly timeoutMs: number }
  | { readonly tag: "exited"; readonly code: number };

export interface BundleProbeRequest {
  /** The URL the main isolate would pass to `import()` for this bundle. */
  readonly importUrl: string;
  /** Which kind adapter validates the bundle's export. */
  readonly kind: LoaderKind;
}

/**
 * Probes a bundle: evaluates it in isolation to learn its type, as opposed
 * to loading it, which makes it usable. Indexing probes, so a source that
 * exits, hangs or prints at import cannot end, stall or corrupt a command
 * that never uses it (swamp-club#3374).
 */
export interface BundleProber {
  probe(request: BundleProbeRequest): Promise<BundleProbeResult>;
  /**
   * Frees whatever the prober holds. A later probe starts over, so the
   * owner of a pass calls this once the pass is finished.
   */
  release(): void;
}

/**
 * A probe that did not finish: the import never settled, or the source
 * tried to exit the process. It is a {@link ValidationError} so the source
 * is recorded as `ValidationFailed` and left alone until its fingerprint
 * changes, instead of costing every command another timeout.
 */
export class ProbeFailedError extends ValidationError {
  constructor(
    message: string,
    bundlePath: string,
    fingerprint: SourceFingerprint,
  ) {
    super(message, bundlePath, fingerprint);
    this.name = "ProbeFailedError";
  }
}

/**
 * The reason recorded for a probe that did not finish. It names the source
 * and says how to retry: a local source is edited, a pulled one is not the
 * user's to edit.
 */
export function describeProbeFailure(
  result: Extract<BundleProbeResult, { tag: "timed-out" | "exited" }>,
  source: { readonly sourcePath: string; readonly pulled: boolean },
): string {
  const what = result.tag === "timed-out"
    ? `its import did not finish within ${formatTimeout(result.timeoutMs)}`
    : `it called exit(${result.code}) at import`;
  const retry = source.pulled
    ? "Upgrade or re-pull the extension to retry."
    : "Edit the file to retry.";
  return `Extension source ${source.sourcePath} was not indexed: ${what}. ${retry}`;
}

function formatTimeout(timeoutMs: number): string {
  return timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}s` : `${timeoutMs}ms`;
}
