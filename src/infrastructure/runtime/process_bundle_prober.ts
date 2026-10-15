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
import { dirname, fromFileUrl, join } from "@std/path";
import { TextLineStream } from "@std/streams";
import type {
  BundleProber,
  BundleProbeRequest,
  BundleProbeResult,
} from "../../domain/extensions/bundle_prober.ts";
import { sanitizeDataUrlError } from "../../domain/models/bundle.ts";
import { attachProcessJob } from "../process/windows_job.ts";
import {
  BUNDLE_PROBE_FRAME_ENV,
  BUNDLE_PROBE_HOST_MARKER,
  type BundleProbeHostReply,
} from "./bundle_probe_host.ts";

const logger = getLogger(["swamp", "extensions", "probe"]);

/** How long one bundle's import may take before it is given up on. */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/**
 * How long the host may take to say it is ready to import. Starting it
 * and loading the kind adapter is swamp's own work, so running out of this
 * is never held against the bundle.
 */
export const DEFAULT_PROBE_STARTUP_TIMEOUT_MS = 60_000;

/** The command line that starts a probe host. */
export interface ProbeHostCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Variables to set on top of this process's environment. */
  readonly env?: Readonly<Record<string, string>>;
}

/** A `deno run` of the host entry, from source. */
export function sourceProbeHostCommand(): ProbeHostCommand {
  const entry = fromFileUrl(new URL("./bundle_probe_host.ts", import.meta.url));
  // The repo's import map, found from this file, so the host resolves its
  // imports whatever the parent's working directory.
  const config = join(dirname(entry), "..", "..", "..", "deno.json");
  return {
    command: Deno.execPath(),
    args: ["run", "-A", "--config", config, entry],
  };
}

/** How this process starts a probe host: itself, or `deno run` from source. */
export function hostProbeHostCommand(): ProbeHostCommand {
  const execPath = Deno.execPath();
  return /[\\/]deno(\.exe)?$/i.test(execPath)
    ? sourceProbeHostCommand()
    : { command: execPath, args: [BUNDLE_PROBE_HOST_MARKER] };
}

/** What a probe in flight hears from its host. */
interface HostListener {
  reply(reply: BundleProbeHostReply): void;
  /** The host is gone: it exited, crashed or was killed. */
  gone(message: string): void;
}

/** A running probe host process. */
interface ProbeHost {
  send(request: BundleProbeRequest): Promise<void>;
  listen(listener: HostListener | undefined): void;
  /** Kills the host and waits until its process and output have ended. */
  stop(): Promise<void>;
}

const encoder = new TextEncoder();

function startProbeHost(command: ProbeHostCommand): ProbeHost {
  const frame = `@@swamp-probe-${crypto.randomUUID()}@@`;
  // The host stays in this process's group, so a Ctrl+C reaches it as it
  // reaches swamp; on Windows its job ends it when swamp ends.
  const child = new Deno.Command(command.command, {
    args: [...command.args],
    env: { ...command.env, [BUNDLE_PROBE_FRAME_ENV]: frame },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const job = attachProcessJob(child.pid);
  const writer = child.stdin.getWriter();
  let listener: HostListener | undefined;
  let goneMessage: string | undefined;

  // Both pipes are read to the end, so a bundle that prints a lot never
  // blocks the host on a full pipe and gets blamed for the stall.
  const lines = (stream: ReadableStream<Uint8Array>) =>
    stream.pipeThrough(new TextDecoderStream()).pipeThrough(
      new TextLineStream(),
    );
  const readStdout = async () => {
    for await (const line of lines(child.stdout)) {
      if (line.startsWith(frame)) {
        let reply: BundleProbeHostReply;
        try {
          reply = JSON.parse(line.slice(frame.length)) as BundleProbeHostReply;
        } catch {
          continue;
        }
        listener?.reply(reply);
      } else if (line !== "") {
        logger.debug`Output of the probe host: ${line}`;
      }
    }
  };
  const readStderr = async () => {
    for await (const line of lines(child.stderr)) {
      if (line !== "") logger.debug`Output of the probe host: ${line}`;
    }
  };
  const finished = (async () => {
    await Promise.all([
      readStdout().catch(() => {}),
      readStderr().catch(() => {}),
    ]);
    const status = await child.status;
    // After the output is read, so an answer written just before the host
    // ended still reaches its probe first.
    goneMessage = `the probe host exited with code ${status.code}`;
    listener?.gone(goneMessage);
  })();

  return {
    async send(request) {
      await writer.write(encoder.encode(JSON.stringify(request) + "\n"));
    },
    listen(next) {
      listener = next;
      if (next && goneMessage !== undefined) next.gone(goneMessage);
    },
    async stop() {
      listener = undefined;
      // Killed before stdin is closed: a write to a host that stopped
      // reading would otherwise never finish.
      if (job) job.terminate();
      try {
        child.kill("SIGKILL");
      } catch {
        // Exited already.
      }
      await writer.close().catch(() => {});
      await finished;
    },
  };
}

/**
 * Probes bundles in a probe host process (`bundle_probe_host.ts`). The host
 * is started by the first probe, so a pass with nothing to probe costs
 * nothing, and is reused for later probes until one of them hangs, exits
 * or crashes it. Unlike a worker, a host can always be stopped: a bundle
 * that spins in synchronous code at import is killed with it, not left
 * running for the life of the process (swamp-club#3494).
 *
 * Only the bundle's own import is timed: the timeout starts when the host
 * reports it is ready to import. A host that never gets that far, or is
 * released under a probe, answers `import-failed`, which is retried, and
 * never `timed-out`, which is pinned to the source.
 *
 * The host shares swamp's permissions, environment and filesystem: it keeps
 * a misbehaving import from ending, stalling or printing into a command,
 * and is not a sandbox for untrusted code.
 */
export class ProcessBundleProber implements BundleProber {
  private readonly timeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly command: () => ProbeHostCommand;
  private host: ProbeHost | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** Settles the probe in flight, if any, without an answer from it. */
  private abandon: ((message: string) => void) | undefined;
  /** Stops of hosts that died between probes, which release waits for. */
  private dropped: Promise<void> = Promise.resolve();

  constructor(
    options: {
      timeoutMs?: number;
      startupTimeoutMs?: number;
      command?: () => ProbeHostCommand;
    } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ??
      DEFAULT_PROBE_STARTUP_TIMEOUT_MS;
    this.command = options.command ?? hostProbeHostCommand;
  }

  /** Probes run one at a time: the host answers a single request. */
  probe(request: BundleProbeRequest): Promise<BundleProbeResult> {
    const next = this.queue.then(() => this.probeOne(request));
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * Stops the host. A probe still in flight is answered at once as a
   * failed import, not left to run out its timeout against a host that is
   * gone.
   */
  async release(): Promise<void> {
    const host = this.host;
    this.host = undefined;
    this.abandon?.("the probe was released before it finished");
    await host?.stop();
    await this.dropped;
  }

  private async probeOne(
    request: BundleProbeRequest,
  ): Promise<BundleProbeResult> {
    const host = this.host ??= startProbeHost(this.command());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await new Promise<
        Extract<BundleProbeHostReply, { type: "done" }>
      >((resolve) => {
        const settle = (result: BundleProbeResult) =>
          resolve({ type: "done", result, output: [] });
        const failed = (message: string) =>
          settle({ tag: "import-failed", message });
        this.abandon = failed;
        host.listen({
          reply: (reply) => {
            switch (reply.type) {
              case "ready":
                // The startup timer runs on until the kind adapter is in.
                return;
              case "version-mismatch":
                return failed(
                  `swamp ${reply.parent} is running, but its binary is now ` +
                    `${reply.host}; restart swamp to index extension sources`,
                );
              case "started":
                clearTimeout(timer);
                timer = setTimeout(
                  () => settle({ tag: "timed-out", timeoutMs: this.timeoutMs }),
                  this.timeoutMs,
                );
                return;
              case "done":
                return resolve(reply);
            }
          },
          gone: failed,
        });
        timer = setTimeout(
          () => failed("the probe host did not start"),
          this.startupTimeoutMs,
        );
        host.send(request).catch(() =>
          failed("the probe host stopped reading")
        );
      });
      for (const line of reply.output) {
        logger.debug`Output at import of ${
          sanitizeDataUrlError(request.importUrl)
        }: ${line}`;
      }
      // Only a host that answered with a finished import is reused, and
      // only while it stays alive: one that dies between probes is dropped,
      // so the next probe starts its own.
      if (this.host === host) {
        if (isReusable(reply.result)) {
          host.listen({
            reply: () => {},
            gone: () => {
              if (this.host !== host) return;
              this.host = undefined;
              const stopped = host.stop();
              this.dropped = this.dropped.then(() => stopped);
            },
          });
        } else {
          await this.release();
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
