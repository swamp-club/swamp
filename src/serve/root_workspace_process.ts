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

import { exitCode, StderrTail } from "./host/deno_serve_process.ts";
import type { RootWorkspaceCreator } from "./host/root_workspace.ts";
import { swampInvocation } from "./swamp_invocation.ts";

export const ROOT_WORKSPACE_CREATE_TIMEOUT_MS = 120_000;
// the child prints one small JSON object; anything larger is not that
const MAX_CHILD_OUTPUT_BYTES = 256 * 1024;

export function rootWorkspaceCreateArgs(name: string): string[] {
  return ["workspace", "create", name, "--json"];
}

/** the folder from swamp workspace create's --json output */
export function parseWorkspaceCreateOutput(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      "swamp workspace create printed no JSON result on its standard output.",
    );
  }
  const path = typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>).path
    : undefined;
  if (typeof path !== "string" || path === "") {
    throw new Error(
      "swamp workspace create printed a result that names no folder.",
    );
  }
  return path;
}

/** the child's own JSON error when it wrote one, else how it ended and its last stderr lines */
export function workspaceCreateFailure(
  code: number | null,
  timedOut: boolean,
  stderr: string,
): string {
  if (!timedOut) {
    try {
      const parsed: unknown = JSON.parse(stderr);
      const message = typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>).error
        : undefined;
      if (typeof message === "string" && message !== "") return message;
    } catch {
      // not the child's JSON error; its tail says what happened
    }
  }
  const how = timedOut
    ? "timed out and was killed"
    : code === null
    ? "was killed by a signal or could not start"
    : `exited with code ${code}`;
  const tail = new StderrTail();
  for (const line of stderr.split("\n")) {
    if (line.trim() !== "") tail.push(line);
  }
  const lines = tail.lines();
  return lines.length === 0
    ? `swamp workspace create ${how}.`
    : `swamp workspace create ${how}:\n${lines.join("\n")}`;
}

/**
 * `env` is the child's whole environment, nothing inherited: the host's
 * hostChildEnv, so the child writes the same registry the host reads
 */
export function childRootWorkspaceCreator(options: {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs?: number;
}): RootWorkspaceCreator {
  return {
    async create(name) {
      const cmd = swampInvocation(rootWorkspaceCreateArgs(name));
      const child = new Deno.Command(cmd.execPath, {
        args: cmd.args,
        cwd: options.cwd,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        env: { ...options.env },
        clearEnv: true,
      }).spawn();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
      }, options.timeoutMs ?? ROOT_WORKSPACE_CREATE_TIMEOUT_MS);
      try {
        const [status, stdout, stderr] = await Promise.all([
          child.status,
          readCappedStream(child.stdout),
          readCappedStream(child.stderr),
        ]);
        if (timedOut || !status.success) {
          throw new Error(
            workspaceCreateFailure(exitCode(status), timedOut, stderr),
          );
        }
        return parseWorkspaceCreateOutput(stdout);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// keeps the first bytes and drains the rest, so a chatty child never blocks on a full pipe
async function readCappedStream(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    if (size >= MAX_CHILD_OUTPUT_BYTES) continue;
    const kept = chunk.subarray(0, MAX_CHILD_OUTPUT_BYTES - size);
    chunks.push(kept);
    size += kept.length;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}
