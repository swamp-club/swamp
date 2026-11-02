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
 * imports run out of process so a bundle that exits or hangs can be killed; the
 * reply prefix only frames replies, and a bundle with swamp's permissions could
 * fake one, so this is not a sandbox
 */

import { TextLineStream } from "@std/streams";
import type {
  BundleProbeRequest,
  BundleProbeResult,
} from "../../domain/extensions/bundle_prober.ts";
import { installProbeIsolation, probeModule } from "./bundle_probe.ts";

export const BUNDLE_PROBE_HOST_MARKER = "__swamp_bundle_probe_host";

export const BUNDLE_PROBE_FRAME_ENV = "SWAMP_BUNDLE_PROBE_FRAME";

export const BUILD_VERSION_ENV = "SWAMP_BUILD_VERSION";

/**
 * ready once it can take requests, or version-mismatch instead if it is another
 * build than its parent; per request, started just before the import so it
 * alone is timed, then done
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
    readonly output: readonly string[];
  };

export function isBundleProbeHostInvocation(args: readonly string[]): boolean {
  return args[0] === BUNDLE_PROBE_HOST_MARKER;
}

const encoder = new TextEncoder();

/**
 * version is checked against the parent's build; from source there is none and
 * no check. Resolves with 2 only when no reply prefix was given; otherwise it
 * ends the process itself
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
