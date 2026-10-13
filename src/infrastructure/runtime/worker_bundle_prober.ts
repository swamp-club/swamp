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

import { getLogger } from "@logtape/logtape";
import type {
  BundleProber,
  BundleProbeRequest,
  BundleProbeResult,
} from "../../domain/extensions/bundle_prober.ts";
import { sanitizeDataUrlError } from "../../domain/models/bundle.ts";
import type { BundleProbeReply } from "./bundle_probe_worker.ts";

const logger = getLogger(["swamp", "extensions", "probe"]);

/** How long one bundle's import may take before it is given up on. */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/**
 * How long the worker may take to say it is ready to import. Starting it
 * and loading the kind adapter is swamp's own work, so running out of this
 * is never held against the bundle.
 */
export const DEFAULT_PROBE_STARTUP_TIMEOUT_MS = 60_000;

const WORKER_URL = new URL("./bundle_probe_worker.ts", import.meta.url);

/**
 * Probes bundles in a Deno worker. The worker is started by the first
 * probe, so a pass with nothing to probe costs nothing, and is reused for
 * later probes until one of them hangs, exits or crashes it.
 *
 * Only the bundle's own import is timed: the timeout starts when the
 * worker reports it is ready to import. A worker that never gets that far,
 * or is released under a probe, answers `import-failed`, which is retried,
 * and never `timed-out`, which is pinned to the source.
 *
 * The worker shares the process's permissions, environment and
 * filesystem: it keeps a misbehaving import from ending, stalling or
 * printing into a command, and is not a sandbox for untrusted code. A
 * bundle that writes to `Deno.stdout` directly is not captured.
 */
export class WorkerBundleProber implements BundleProber {
  private readonly timeoutMs: number;
  private readonly startupTimeoutMs: number;
  private worker: Worker | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** Settles the probe in flight, if any, without an answer from it. */
  private abandon: ((message: string) => void) | undefined;

  constructor(
    options: { timeoutMs?: number; startupTimeoutMs?: number } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ??
      DEFAULT_PROBE_STARTUP_TIMEOUT_MS;
  }

  /** Probes run one at a time: the worker answers a single request. */
  probe(request: BundleProbeRequest): Promise<BundleProbeResult> {
    const next = this.queue.then(() => this.probeOne(request));
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * Terminates the worker. A probe still in flight is answered at once as
   * a failed import, not left to run out its timeout against a worker that
   * is gone.
   */
  release(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.abandon?.("the probe was released before it finished");
  }

  private async probeOne(
    request: BundleProbeRequest,
  ): Promise<BundleProbeResult> {
    const worker = this.worker ??= new Worker(WORKER_URL, { type: "module" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await new Promise<
        Extract<BundleProbeReply, { type: "done" }>
      >((resolve) => {
        const settle = (result: BundleProbeResult) =>
          resolve({ type: "done", result, output: [] });
        const failed = (message: string) =>
          settle({ tag: "import-failed", message });
        this.abandon = failed;
        worker.onmessage = (event: MessageEvent<BundleProbeReply>) => {
          if (event.data.type === "done") return resolve(event.data);
          clearTimeout(timer);
          timer = setTimeout(
            () => settle({ tag: "timed-out", timeoutMs: this.timeoutMs }),
            this.timeoutMs,
          );
        };
        worker.onerror = (event) => {
          // Unhandled, a worker error is rethrown in this isolate.
          event.preventDefault();
          failed(event.message);
        };
        worker.onmessageerror = () => failed("unreadable probe reply");
        timer = setTimeout(
          () => failed("the probe worker did not start"),
          this.startupTimeoutMs,
        );
        worker.postMessage(request);
      });
      for (const line of reply.output) {
        logger.debug`Output at import of ${
          sanitizeDataUrlError(request.importUrl)
        }: ${line}`;
      }
      // Only a worker that answered with a finished import is reused, and
      // only while it stays alive: one that dies between probes is dropped,
      // so the next probe starts its own.
      if (this.worker === worker) {
        if (isReusable(reply.result)) {
          worker.onmessage = null;
          worker.onerror = (event) => {
            event.preventDefault();
            if (this.worker === worker) this.release();
          };
        } else {
          this.release();
        }
      }
      return reply.result;
    } finally {
      this.abandon = undefined;
      clearTimeout(timer);
    }
  }
}

function isReusable(result: BundleProbeResult): boolean {
  return result.tag === "primary" || result.tag === "secondary" ||
    result.tag === "no-export" || result.tag === "validation-failed";
}
