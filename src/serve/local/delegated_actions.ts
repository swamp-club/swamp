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

import { basename } from "@std/path";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { RunTrackerStore } from "../../infrastructure/persistence/run_tracker_store.ts";
import {
  actionCommand,
  actionErrorCode,
  type ActionFrame,
  attachedReply,
  type DelegatedAction,
} from "./local_actions.ts";

export interface ActionRunner {
  run(
    repoDir: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  /**
   * Starts a command that outlives the dashboard (a resumed run). Resolves the
   * exit code when it ends.
   */
  start(
    repoDir: string,
    args: readonly string[],
  ): { readonly pid: number; readonly exited: Promise<number> };
  watchRuns(repoDir: string): {
    isRunning(runId: string, pid: number): boolean;
    close(): void;
  };
}

export interface DelegatedActionDeps {
  readonly repoDir: string;
  readonly actions: ActionRunner;
  /** the owner stopping: kills attached commands and ends a resume's wait */
  readonly signal: AbortSignal;
}

const RESUME_START_WAIT_MS = 30_000;
const RESUME_START_POLL_MS = 200;

/**
 * Answers the page once. A resume that started hands back its exit, so the
 * caller decides whether to say `done`; nothing here waits for the run.
 */
export async function runDelegatedAction(
  deps: DelegatedActionDeps,
  type: DelegatedAction,
  id: string,
  payload: unknown,
  reply: (frame: ActionFrame) => void,
): Promise<{ readonly exited?: Promise<number> }> {
  const { repoDir, actions, signal } = deps;
  const fail = (message: string) =>
    reply({
      type: "error",
      id,
      error: { code: actionErrorCode(type), message },
    });
  const command = actionCommand(type, payload);
  if (command.kind === "invalid") {
    fail(command.message);
    return {};
  }
  try {
    if (!command.detached) {
      reply(
        attachedReply(
          type,
          id,
          await actions.run(repoDir, command.args, signal),
        ),
      );
      return {};
    }
    // open the tracker before the resume starts so an unreadable tracker
    // fails with nothing started; once started nothing may report failure or
    // a retry would resume the same run twice
    const runs = actions.watchRuns(repoDir);
    const closeRuns = () => {
      try {
        runs.close();
      } catch {
        // Closing a tracker that failed: nothing to release.
      }
    };
    let started: { readonly pid: number; readonly exited: Promise<number> };
    try {
      started = actions.start(repoDir, command.args);
    } catch (error) {
      closeRuns();
      throw error;
    }
    let exitCode: number | null = null;
    const exited = started.exited.then((code) => {
      exitCode = code;
      return code;
    });
    // A tracker read that fails after the start counts as running.
    const running = () => {
      try {
        return runs.isRunning(command.runId, started.pid);
      } catch {
        return true;
      }
    };
    const deadline = Date.now() + RESUME_START_WAIT_MS;
    try {
      while (
        !signal.aborted && exitCode === null && Date.now() < deadline &&
        !running()
      ) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exited,
            new Promise((r) => timer = setTimeout(r, RESUME_START_POLL_MS)),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      closeRuns();
    }
    if (exitCode !== null && exitCode !== 0) {
      fail(
        `The resume stopped before its run started (exit ${exitCode}). ` +
          `Run \`swamp ${command.args.slice(0, -1).join(" ")}\` in this ` +
          "repo to see why.",
      );
      return {};
    }
    // Started, already finished, or still starting after the wait (a resume
    // waiting on a lock, say): the run is under way either way, so the page
    // detaches on this event.
    reply({ type: "event", id, payload: { runId: command.runId } });
    return { exited };
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return {};
  }
}

export function swampInvocation(args: readonly string[]): {
  execPath: string;
  args: string[];
} {
  const execPath = Deno.execPath();
  // From source, Deno.execPath() is deno and Deno.mainModule is swamp.
  const runningFromSource = /^deno(\.exe)?$/i.test(basename(execPath));
  return {
    execPath,
    // From source, as the `dev` task runs it.
    args: runningFromSource
      ? ["run", "-A", "--unstable-bundle", Deno.mainModule, ...args]
      : [...args],
  };
}

/**
 * drops the serve URL variables so actions act on the local repo the dashboard
 * shows; a repo whose marker names a server still sends them there, as the CLI
 * does
 */
export function actionEnv(): Record<string, string> {
  const env = Deno.env.toObject();
  delete env.SWAMP_SERVE_URL;
  delete env.SWAMP_SERVER_URL;
  return env;
}

/**
 * Raw spawns, deliberately outside any engine command guardian: a resume must
 * outlive the process that started it, and these are swamp's own CLI verbs.
 */
export const SWAMP_CLI_ACTIONS: ActionRunner = {
  async run(repoDir, args, signal) {
    const cmd = swampInvocation([...args, "--repo-dir", repoDir]);
    const out = await new Deno.Command(cmd.execPath, {
      args: cmd.args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      env: actionEnv(),
      clearEnv: true,
      ...(signal ? { signal } : {}),
    }).output();
    const decoder = new TextDecoder();
    return {
      code: out.code,
      stdout: decoder.decode(out.stdout),
      stderr: decoder.decode(out.stderr),
    };
  },
  start(repoDir, args) {
    const cmd = swampInvocation([...args, "--repo-dir", repoDir]);
    // Its own process group and no pipes: the run outlives the dashboard,
    // Ctrl-C in its terminal included, and never writes to a closed pipe.
    const process = new Deno.Command(cmd.execPath, {
      args: cmd.args,
      stdin: "null",
      stdout: "null",
      stderr: "null",
      env: actionEnv(),
      clearEnv: true,
      detached: true,
    }).spawn();
    process.unref();
    return { pid: process.pid, exited: process.status.then((s) => s.code) };
  },
  watchRuns(repoDir) {
    const tracker = RunTrackerStore.fromSwampDir(swampPath(repoDir));
    return {
      isRunning(runId, pid) {
        const run = tracker.findById(runId);
        return run !== null && run.status === "running" && run.pid === pid;
      },
      close: () => tracker.close(),
    };
  },
};
