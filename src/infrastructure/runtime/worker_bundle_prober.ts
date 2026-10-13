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
import type { BundleProbeReply } from "./bundle_probe_worker.ts";

const logger = getLogger(["swamp", "extensions", "probe"]);

/** How long one bundle's import may take before it is given up on. */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

const WORKER_URL = new URL("./bundle_probe_worker.ts", import.meta.url);

/**
 * Probes bundles in a Deno worker. The worker is started by the first
 * probe, so a pass with nothing to probe costs nothing, and is reused for
 * later probes until one of them hangs, exits or crashes it.
 *
 * The worker shares the process's permissions, environment and
 * filesystem: it keeps a misbehaving import from ending, stalling or
 * printing into a command, and is not a sandbox for untrusted code. A
 * bundle that writes to `Deno.stdout` directly is not captured.
 */
export class WorkerBundleProber implements BundleProber {
  private readonly timeoutMs: number;
  private worker: Worker | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  }

  /** Probes run one at a time: the worker answers a single request. */
  probe(request: BundleProbeRequest): Promise<BundleProbeResult> {
    const next = this.queue.then(() => this.probeOne(request));
    this.queue = next.catch(() => {});
    return next;
  }

  release(): void {
    this.worker?.terminate();
    this.worker = undefined;
  }

  private async probeOne(
    request: BundleProbeRequest,
  ): Promise<BundleProbeResult> {
    const worker = this.worker ??= new Worker(WORKER_URL, { type: "module" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await new Promise<BundleProbeReply>((resolve) => {
        const settle = (result: BundleProbeResult) =>
          resolve({ result, output: [] });
        worker.onmessage = (event: MessageEvent<BundleProbeReply>) =>
          resolve(event.data);
        worker.onerror = (event) => {
          // Unhandled, a worker error is rethrown in this isolate.
          event.preventDefault();
          settle({ tag: "import-failed", message: event.message });
        };
        worker.onmessageerror = () =>
          settle({ tag: "import-failed", message: "unreadable probe reply" });
        timer = setTimeout(
          () => settle({ tag: "timed-out", timeoutMs: this.timeoutMs }),
          this.timeoutMs,
        );
        worker.postMessage(request);
      });
      for (const line of reply.output) {
        logger.debug`Output at import of ${request.importUrl}: ${line}`;
      }
      // Only a worker that answered with a finished import is reused.
      // Errors that arrive between probes are still kept out of this
      // isolate.
      if (isReusable(reply.result)) {
        worker.onerror = (event) => event.preventDefault();
      } else {
        this.release();
      }
      return reply.result;
    } finally {
      clearTimeout(timer);
    }
  }
}

function isReusable(result: BundleProbeResult): boolean {
  return result.tag === "primary" || result.tag === "secondary" ||
    result.tag === "no-export" || result.tag === "validation-failed";
}
