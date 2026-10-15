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
 * The probe host: a process ProcessBundleProber starts to import bundles
 * in, so one that exits, hangs, prints or spins at import never runs in
 * the command's own process, and can be killed outright (swamp-club#3374,
 * swamp-club#3494). `main.ts` calls {@link runBundleProbeHost} as one of its
 * first statements when started with {@link BUNDLE_PROBE_HOST_MARKER}, so
 * no CLI command, auth gate, telemetry or extension loading runs; from
 * source, `deno run` starts this file directly.
 *
 * It reads one {@link BundleProbeRequest} per line on stdin and writes each
 * {@link BundleProbeHostReply} as one line on stdout behind the prefix the
 * parent sets in {@link BUNDLE_PROBE_FRAME_ENV}. Other stdout lines are a
 * bundle writing to `Deno.stdout` directly. The prefix only frames replies:
 * a bundle runs with swamp's own permissions and could fake one, so the
 * host is not a sandbox. It exits when stdin closes.
 *
 * @module
 */

import { TextLineStream } from "@std/streams";
import type {
  BundleProbeRequest,
  BundleProbeResult,
} from "../../domain/extensions/bundle_prober.ts";
import { installProbeIsolation, probeModule } from "./bundle_probe.ts";

/** The first argument that makes swamp run as a probe host. */
export const BUNDLE_PROBE_HOST_MARKER = "__swamp_bundle_probe_host";

/** The variable naming the prefix of every reply line. */
export const BUNDLE_PROBE_FRAME_ENV = "SWAMP_BUNDLE_PROBE_FRAME";

/** The variable naming the parent's build, which `main.ts` sets. */
export const BUILD_VERSION_ENV = "SWAMP_BUILD_VERSION";

/**
 * What the host writes: `ready` once it can take requests, or
 * `version-mismatch` instead when it is another build than its parent;
 * then for each request `started` once it is ready to import the bundle,
 * so the import alone is timed, and `done`.
 */
export type BundleProbeHostReply =
  | { readonly type: "ready" }
  | {
    readonly type: "version-mismatch";
    readonly host: string;
    readonly parent: string;
  }
  | { readonly type: "started" }
  | {
    readonly type: "done";
    readonly result: BundleProbeResult;
    /** Lines the bundle wrote through `console` while it was imported. */
    readonly output: readonly string[];
  };

/** Whether `args`, a process's arguments, start a probe host. */
export function isBundleProbeHostInvocation(args: readonly string[]): boolean {
  return args[0] === BUNDLE_PROBE_HOST_MARKER;
}

const encoder = new TextEncoder();

/**
 * Runs the probe host until stdin closes. `version` is this binary's
 * build, checked against the parent's; from source there is none and no
 * check. Resolves with 2 only when no reply prefix was given; otherwise it
 * ends the process itself.
 */
export async function runBundleProbeHost(version?: string): Promise<number> {
  const frame = Deno.env.get(BUNDLE_PROBE_FRAME_ENV);
  if (!frame) return 2;
  const parent = Deno.env.get(BUILD_VERSION_ENV);
  const isolation = installProbeIsolation();
  // Replies are an RPC stream on stdout, written in order through its
  // writable, as the worker dispatch runner writes its frames.
  const out = Deno.stdout.writable.getWriter();
  let written: Promise<void> = Promise.resolve();
  const send = (reply: BundleProbeHostReply): Promise<void> => {
    const line = encoder.encode(frame + JSON.stringify(reply) + "\n");
    written = written.then(() => out.write(line)).catch(() => {
      // The parent is gone.
      isolation.exit(1);
    });
    return written;
  };

  // A host from a binary `swamp update` replaced under a running swamp
  // would judge bundles by another release's rules.
  if (version !== undefined && parent !== undefined && version !== parent) {
    await send({ type: "version-mismatch", host: version, parent });
    return isolation.exit(0);
  }
  await send({ type: "ready" });

  const lines = Deno.stdin.readable
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream());
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let request: BundleProbeRequest;
    try {
      request = JSON.parse(line) as BundleProbeRequest;
    } catch {
      continue;
    }
    const result = await probeModule(request, () => {
      // Handled, not dropped: its write is chained into `written`, which
      // catches its failure, and `done` below is awaited behind it.
      void send({ type: "started" });
    });
    await send({ type: "done", result, output: isolation.output.splice(0) });
  }
  await written;
  // Timers or intervals a bundle left running must not keep it alive.
  return isolation.exit(0);
}

if (import.meta.main) {
  Deno.exit(await runBundleProbeHost());
}
