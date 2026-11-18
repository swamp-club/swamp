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

import type {
  HostedWorkspaceProvisioner,
  HostedWorkspaceProvisionSpec,
} from "../libswamp/hosted_workspace/deps.ts";
import { exitCode, linesOf, StderrTail } from "./host/deno_serve_process.ts";
import { swampInvocation } from "./swamp_invocation.ts";

export const PROVISION_CHILD_ARGS: readonly string[] = [
  "serve",
  "provision-workspace",
  "--json",
];

export function provisionSpecBytes(
  spec: HostedWorkspaceProvisionSpec,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(spec));
}

export function provisionFailureMessage(
  code: number | null,
  timedOut: boolean,
  stderrTail: readonly string[],
): string {
  const how = timedOut
    ? "timed out and was killed"
    : code === null
    ? "was killed by a signal or could not start"
    : `exited with code ${code}`;
  return stderrTail.length === 0
    ? `The provisioner ${how}.`
    : `The provisioner ${how}:\n${stderrTail.join("\n")}`;
}

/**
 * `env` is the child's whole environment, nothing inherited; the host passes
 * hostChildEnv so the host's SWAMP_DATASTORE or SWAMP_REPO_DIR never reaches it
 */
export function childHostedWorkspaceProvisioner(
  env: Readonly<Record<string, string>>,
): HostedWorkspaceProvisioner {
  return {
    async provision(dir, spec, signal) {
      signal.throwIfAborted();
      const cmd = swampInvocation(PROVISION_CHILD_ARGS);
      const child = new Deno.Command(cmd.execPath, {
        args: cmd.args,
        cwd: dir,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
        env: { ...env },
        clearEnv: true,
      }).spawn();
      const kill = () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
      };
      signal.addEventListener("abort", kill, { once: true });
      try {
        const tail = new StderrTail();
        const drainStdout = (async () => {
          const lines = linesOf(child.stdout);
          while (!(await lines.read()).done) {
            // the child's one line says only that it finished
          }
        })();
        const drainStderr = (async () => {
          const lines = linesOf(child.stderr);
          for (
            let read = await lines.read();
            !read.done;
            read = await lines.read()
          ) {
            tail.push(read.value);
          }
        })();
        const writer = child.stdin.getWriter();
        try {
          await writer.write(provisionSpecBytes(spec));
          await writer.close();
        } catch {
          // a child that exited before reading reports through its status
        }
        const [status] = await Promise.all([
          child.status,
          drainStdout,
          drainStderr,
        ]);
        if (signal.aborted || !status.success) {
          throw new Error(
            provisionFailureMessage(
              exitCode(status),
              signal.aborted,
              tail.lines(),
            ),
          );
        }
      } finally {
        signal.removeEventListener("abort", kill);
      }
    },
  };
}
