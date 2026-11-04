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

import "../domain/models/models.ts";
import "../domain/datastore/datastore_types.ts";
import "../domain/reports/builtin/mod.ts";
import { isAbsolute as isPosixAbsolute } from "@std/path/posix";
import { isAbsolute as isWindowsAbsolute } from "@std/path/windows";
import { setCommandGuardian } from "../infrastructure/process/command_guardian_policy.ts";
import {
  type EngineInput,
  openEngineInput,
  parseEngineInputTarget,
} from "../infrastructure/runtime/engine_input.ts";
import {
  type EngineOutput,
  openEngineOutput,
  parseEngineOutputTarget,
} from "../infrastructure/runtime/engine_output.ts";
import { createLocalEngineContext } from "../serve/local_engine_context.ts";
import { EngineRuntime } from "./runtime.ts";
import { ControlRuntime } from "./control_runtime.ts";
import { WorkspaceRegistryFileRepository } from "../infrastructure/persistence/workspace_registry_file_repository.ts";
import { exists } from "@std/fs";
import { join } from "@std/path";
import {
  EngineWriter,
  parseEngineRequest,
  readEngineFrames,
} from "./protocol.ts";
import {
  EngineProfileError,
  EngineRepositoryNotInitializedError,
} from "./profile.ts";
import {
  admitEngineOperator,
  disposeEngineWithOperatorRefresh,
  EngineOperatorAuthError,
} from "./operator_auth.ts";
import {
  type AuthGateOutcome,
  publishNestedGatePass,
} from "../libswamp/auth/gate.ts";

/** Only authored admission diagnostics may cross the private startup RPC. */
export function engineStartupFailure(
  error: unknown,
  operatorAdmitted: boolean,
): { code: string; message: string } {
  if (error instanceof EngineRepositoryNotInitializedError) {
    // Reconstruct the fixed diagnostic: extension code can throw or mutate
    // error objects, so their message/code properties are not trusted here.
    const failure = new EngineRepositoryNotInitializedError();
    return { code: failure.code, message: failure.message };
  }
  if (
    error instanceof EngineProfileError ||
    (!operatorAdmitted && error instanceof EngineOperatorAuthError)
  ) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "engine_start_failed",
    message:
      "Validate the selected repository and its .swamp.yaml, run swamp serve check-config --repo-dir <repo>, and check installed extensions before retrying.",
  };
}

export interface EnginePipes {
  readonly input: readonly [string, string];
  readonly output: readonly [string, string];
  readonly guardian: string;
  readonly fence: string;
}
export type EngineLaunch =
  | { readonly mode: "repo"; readonly repo: string } & EnginePipes
  | { readonly mode: "control" } & EnginePipes;

/** Parse the complete supervisor contract before acquiring native resources. */
export function parseEngineLaunchArgs(
  args: readonly string[],
  os: string = Deno.build.os,
): EngineLaunch | undefined {
  const absolute = os === "windows" ? isWindowsAbsolute : isPosixAbsolute;
  if (args[0] !== "--stdio") return undefined;
  let rest: readonly string[];
  let repo: string | undefined;
  if (args[1] === "--repo" && args.length === 11 && args[2]) {
    repo = args[2];
    rest = args.slice(3);
  } else if (args[1] === "--control" && args.length === 10) {
    rest = args.slice(2);
  } else {
    return undefined;
  }
  if (
    rest[4] !== "--command-guardian" || !absolute(rest[5]) ||
    rest[6] !== "--command-fence" ||
    (os === "windows" ? rest[7] !== "none" : !absolute(rest[7]))
  ) return undefined;
  try {
    // Each adapter owns its descriptor: aliasing input and output is invalid.
    if (
      parseEngineInputTarget(rest[0], rest[1], os) ===
        parseEngineOutputTarget(rest[2], rest[3], os)
    ) return undefined;
  } catch {
    return undefined;
  }
  const pipes: EnginePipes = {
    input: [rest[0], rest[1]],
    output: [rest[2], rest[3]],
    guardian: rest[5],
    fence: rest[7],
  };
  return repo === undefined
    ? { mode: "control", ...pipes }
    : { mode: "repo", repo, ...pipes };
}

/** Validate the repository engine contract before acquiring native resources. */
export function validateEngineLaunchArgs(
  args: readonly string[],
  os: string = Deno.build.os,
): boolean {
  return parseEngineLaunchArgs(args, os)?.mode === "repo";
}

/** Hidden process entry. Paths come only from the trusted supervisor argv. */
export async function runEngineMain(
  args: readonly string[],
  identity: { version: string; gitSha?: string },
): Promise<number> {
  const launch = parseEngineLaunchArgs(args);
  if (!launch) {
    console.error(
      "Engine is internal; requires --stdio with --repo <repository> or --control, private input/output pipes, --command-guardian <absolute executable> and --command-fence <generation fence>",
    );
    return 2;
  }
  let input: EngineInput | undefined;
  let output: EngineOutput | undefined;
  try {
    input = openEngineInput(launch.input[0], launch.input[1]);
    output = openEngineOutput(launch.output[0], launch.output[1]);
  } catch {
    await Promise.allSettled([input?.dispose(), output?.dispose()]);
    console.error("Cannot open the private engine request and reply pipes");
    return 1;
  }
  if (launch.mode === "control") {
    return await runControlEngine(input, output, identity);
  }
  const inputCancellation = new AbortController();
  // This hidden entry owns the process until main calls Deno.exit. Retain its
  // command policy through the final continuation: a cancellation-ignoring
  // task must still use the generation fence during process teardown.
  setCommandGuardian({
    executable: launch.guardian,
    fence: launch.fence,
  });
  const frames = readEngineFrames(
    input.stream,
    undefined,
    inputCancellation.signal,
  );
  let hello: ReturnType<typeof parseEngineRequest> | undefined;
  let contextCreated = false;
  let admission: Extract<AuthGateOutcome, { kind: "pass" }> | undefined;
  try {
    const first = await frames.next();
    if (first.done) return 0;
    hello = parseEngineRequest(first.value);
    if (hello.method !== "hello" || hello.params?.profile !== "local-v1") {
      throw new Error("Invalid hello");
    }
    const accepted = await admitEngineOperator(identity.version);
    admission = accepted;
    publishNestedGatePass(accepted.handoff);
    const composed = await createLocalEngineContext(launch.repo);
    contextCreated = true;
    const runtime = new EngineRuntime({
      ...composed,
      dispose: () =>
        disposeEngineWithOperatorRefresh(composed.dispose, accepted),
      inputCancellation,
      engineVersion: identity.version,
      gitSha: identity.gitSha ?? "unknown",
    }, output.stream);
    const requests = async function* () {
      yield hello;
      yield* frames;
    };
    await runtime.serve(requests());
    return 0;
  } catch (error) {
    if (hello && !contextCreated) {
      const writer = new EngineWriter(output.stream);
      try {
        writer.send({
          version: 1,
          generation: hello.generation,
          id: hello.id,
          error: engineStartupFailure(error, admission !== undefined),
        });
        await writer.close();
      } catch {
        // A disconnected supervisor cannot receive the safe startup diagnostic.
      }
    }
    // Bootstrap may include vault/extension failures: never echo their input.
    console.error(
      "Engine startup or transport failed; check the repository profile and installed engine compatibility",
    );
    return 1;
  } finally {
    try {
      await frames.return(undefined);
    } finally {
      try {
        await input.dispose();
      } finally {
        await output.dispose();
      }
    }
  }
}

/** The hub's control engine reads only the user's workspace registry. */
async function runControlEngine(
  input: EngineInput,
  output: EngineOutput,
  identity: { version: string; gitSha?: string },
): Promise<number> {
  const runtime = new ControlRuntime({
    workspaces: new WorkspaceRegistryFileRepository(),
    isRepo: (path) => exists(join(path, ".swamp.yaml")),
    realPath: (path) => Deno.realPath(path),
    engineVersion: identity.version,
    gitSha: identity.gitSha ?? "unknown",
  }, output.stream);
  try {
    await runtime.serve(readEngineFrames(input.stream));
    return 0;
  } catch {
    console.error("Hub control engine transport failed");
    return 1;
  } finally {
    try {
      await input.dispose();
    } finally {
      await output.dispose();
    }
  }
}
