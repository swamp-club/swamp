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

import { Command } from "@cliffy/command";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { consumeStream } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  createStartDeps,
  type SignedInState,
  startInspect,
  startListWorkspaces,
  startPrepare,
} from "../../libswamp/start/start.ts";
import { createStartRenderer } from "../../presentation/renderers/start.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { VERSION } from "./version.ts";
import { loadIdentity } from "../load_identity.ts";
import { blockMessage, createAuthGateDeps, runAuthGate } from "../auth_gate.ts";
import { errorPaths, markErrorPaths, UserError } from "../../domain/errors.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";
import { parseWorkspaceName } from "../../domain/workspace/workspace_name.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { apiKeySourceName } from "../../infrastructure/persistence/api_key_source.ts";
import { processOwnsConfigDir } from "../../infrastructure/persistence/config_dir_ownership.ts";
import { FileLock } from "../../infrastructure/persistence/file_lock.ts";
import { getSwampDataDir } from "../../infrastructure/persistence/paths.ts";
import {
  removeStartServerRecord,
  writeStartServerRecord,
} from "../../infrastructure/persistence/start_server_record.ts";
import { isStartServing } from "../../infrastructure/process/start_instance_probe.ts";
import { openBrowser } from "../../infrastructure/process/browser.ts";
import { registerShutdownHandler } from "../../infrastructure/process/shutdown_handlers.ts";
import {
  StartServerError,
  startStartServer,
  type StartWorkspaceClaims,
} from "../../serve/start/start_server.ts";
import {
  createWorkspaceHub,
  spawnDashboardChild,
} from "../../serve/local/workspace_hub.ts";
import { resolveFixedRepo } from "../../serve/local/fixed_repo.ts";
import {
  DASHBOARD_DIST_DIR,
  dashboardBundleExists,
} from "../../serve/dashboard_assets.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/** Checks sign-in the way the auth gate does, without blocking the run. */
async function checkSignedIn(live: boolean): Promise<SignedInState> {
  let outcome;
  try {
    outcome = await runAuthGate(
      createAuthGateDeps({
        liveChecks: live,
        canWrite: processOwnsConfigDir(),
      }),
    );
  } catch (error) {
    return {
      kind: "blocked",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (outcome.kind === "block") {
    return outcome.reason.kind === "no_credential"
      ? { kind: "not_signed_in" }
      : { kind: "blocked", reason: blockMessage(outcome.reason) };
  }
  const source = apiKeySourceName() ? "api_key" : "file";
  let username: string | undefined;
  try {
    username = (await new AuthRepository().load())?.username;
  } catch {
    username = undefined;
  }
  return { kind: "signed_in", source, ...(username ? { username } : {}) };
}

/**
 * The start dependencies. `prune` lets the running check delete stale
 * server records; the read-only inspection passes false so it writes nothing.
 */
async function buildDeps(prune: boolean) {
  return createStartDeps({
    version: VERSION,
    checkSignedIn,
    serverUrl: Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL,
    identity: await loadIdentity(),
    isRunning: (workspacePath) => isStartServing(workspacePath, prune),
  });
}

/** 32 random bytes, base64url-encoded. */
function newToken(): string {
  let binary = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

function pageUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/dashboard/start#token=${token}`;
}

/**
 * A repo's dashboard on the local hub. The token rides in the fragment,
 * never sent to the server in the URL; the page keeps it and offers it on
 * every request.
 */
function dashboardUrl(port: number, token: string, workspace: string): string {
  return `http://127.0.0.1:${port}/dashboard/w/${
    encodeURIComponent(workspace)
  }#token=${token}`;
}

async function tryOpenBrowser(url: string, enabled: boolean): Promise<boolean> {
  if (!enabled) return false;
  try {
    await openBrowser(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens a workspace for this process. Creating it runs under the
 * workspace's file lock, so two first runs never both initialise the folder.
 * Other `swamp start` processes may have it open too; each records itself
 * in `.swamp/start/servers/<pid>.json`, which the picker reads to say so.
 */
function createWorkspaceClaims(
  record: () => { port: number; token: string },
): StartWorkspaceClaims {
  return {
    claim: async (name, workspacePath, open) => {
      // The lock lives under the data dir for every workspace, so an
      // imported repo never gets a lock file beside it.
      const workspacesDir = join(getSwampDataDir(), "workspaces");
      await ensureDir(workspacesDir);
      const lock = new FileLock(workspacesDir, { lockKey: `${name}.lock` });
      await lock.acquire();
      try {
        const result = await open();
        await writeStartServerRecord(workspacePath, {
          pid: Deno.pid,
          ...record(),
          startedAt: new Date().toISOString(),
        });
        return result;
      } finally {
        await lock.release();
      }
    },
    release: (workspacePath) =>
      removeStartServerRecord(workspacePath, Deno.pid),
  };
}

async function inspectAction(options: AnyOptions, path: string[]) {
  const cliCtx = createContext(options as GlobalOptions, path);
  const ctx = createLibSwampContext({ logger: cliCtx.logger });
  const data = await startInspect(ctx, await buildDeps(false), {
    ...(options.workspace !== undefined
      ? { workspaceName: parseWorkspaceName(options.workspace) }
      : {}),
  });
  createStartRenderer(cliCtx.outputMode).inspection(data, options.workspace);
}

const WORKSPACE_OPTION_DESCRIPTION =
  "Open this registered workspace, wherever its folder is, instead of " +
  "choosing one in the browser; a new name is created under the swamp " +
  "data dir. With --json nothing is created";

export const startStatusCommand = new Command()
  .description(
    "Show your swamp start workspaces and which agents are on your PATH",
  )
  .option("--workspace <name:string>", "Show only this workspace")
  .action(async function (options: AnyOptions) {
    await inspectAction(options, ["start", "status"]);
  });

/**
 * Runs the local hub: the start page and, under `/dashboard/w/<workspace>`,
 * every workspace's dashboard. `swamp start` opens the start page;
 * `swamp dashboard` passes its repo to land on that repo's dashboard.
 */
export async function runStart(
  options: AnyOptions,
  commandPath: string[],
  landingRepoDir?: string,
): Promise<void> {
  const cliCtx = createContext(options as GlobalOptions, commandPath);
  if (cliCtx.outputMode === "json") {
    // JSON mode is read-only: no workspace, no server, no browser.
    await inspectAction(options, ["start"]);
    return;
  }

  const workspaceName = options.workspace === undefined
    ? undefined
    : parseWorkspaceName(options.workspace);
  const renderer = createStartRenderer(cliCtx.outputMode);
  const ctx = createLibSwampContext({ logger: cliCtx.logger });
  const deps = await buildDeps(true);
  const openBrowserEnabled = options.browser !== false;

  if (!await dashboardBundleExists(DASHBOARD_DIST_DIR)) {
    throw new UserError(
      "The start page isn't in this build. If you installed a release, reinstall swamp; from source, run `deno run build-dashboard`, then rebuild.",
    );
  }

  // Sign-in is checked and reported here; the workspace is opened by the
  // server, from --workspace below or from the page. `swamp dashboard` has
  // no sign-in step (the auth gate passed before it ran, and its page has no
  // login), so it says nothing about one.
  if (landingRepoDir === undefined) {
    await consumeStream(startPrepare(ctx, deps, {}), {
      ...renderer.prepareHandlers(),
      completed: () => {},
    });
  }

  // `swamp dashboard` in a folder serves that one repo: no switcher, and
  // nothing added to the workspace registry.
  const fixed = landingRepoDir === undefined ? null : await resolveFixedRepo({
    realPath: (path) => Deno.realPath(path),
    isRepo: (path) => deps.repo.isRepo(path),
    registered: async () => (await deps.registry.load())?.list() ?? [],
  }, landingRepoDir);

  const token = newToken();
  let port = 0;
  const server = startStartServer({
    ctx,
    deps,
    token,
    distDir: DASHBOARD_DIST_DIR,
    hub: createWorkspaceHub({
      token,
      resolveWorkspace: async (name) => {
        if (fixed) return name === fixed.name ? fixed.path : null;
        let parsed: string;
        try {
          parsed = parseWorkspaceName(name);
        } catch {
          return null;
        }
        const entry = (await deps.registry.load())?.get(parsed);
        return entry && await deps.repo.isRepo(entry.path) ? entry.path : null;
      },
      listWorkspaces: async () =>
        fixed ? [fixed] : (await startListWorkspaces(ctx, deps, {
          readOnly: true,
        }))
          .workspaces.map(({ name, path }) => ({ name, path })),
      switchable: fixed === null,
      spawnChild: spawnDashboardChild,
    }),
    claims: createWorkspaceClaims(() => ({ port, token })),
    onWorkspaceOpened: (path, created) =>
      renderer.workspaceOpened(path, created),
  });
  port = server.port;
  try {
    if (workspaceName !== undefined) {
      try {
        await server.openWorkspace(workspaceName);
      } catch (error) {
        if (error instanceof StartServerError) {
          const message = error.code === "not_signed_in"
            ? "Sign in first: run `swamp start` without --workspace to sign in from the page, or run `swamp auth login`."
            : error.message;
          // Keep the original error's marked paths for telemetry.
          throw markErrorPaths(
            new UserError(message, error.code),
            errorPaths(error),
          );
        }
        throw error;
      }
    }

    // `swamp dashboard` lands on its repo's dashboard.
    const url = fixed === null
      ? pageUrl(server.port, token)
      : dashboardUrl(server.port, token, fixed.name);
    renderer.pageReady(
      url,
      await tryOpenBrowser(url, openBrowserEnabled),
      fixed !== null,
    );

    // The exit code a signal stopped us with: 128 + the signal number.
    let signalExitCode: number | undefined;
    let onInterrupt!: () => void;
    const interruptedPromise = new Promise<"interrupted">((resolve) => {
      onInterrupt = () => resolve("interrupted");
    });
    const stopWith = (code: number) => () => {
      signalExitCode ??= code;
      onInterrupt();
    };
    // SIGINT through the shared handler (Windows too); SIGTERM and SIGHUP
    // here, so each gets its own exit code.
    const shutdownHandle = registerShutdownHandler({
      handler: stopWith(130),
      includePosixSignals: false,
    });
    const posixSignals: Array<[Deno.Signal, () => void]> =
      Deno.build.os === "windows"
        ? []
        : [["SIGTERM", stopWith(143)], ["SIGHUP", stopWith(129)]];
    for (const [signal, listener] of posixSignals) {
      Deno.addSignalListener(signal, listener);
    }
    try {
      const end = await Promise.race([server.ended, interruptedPromise]);
      if (end === "interrupted" || end.kind === "paused") {
        renderer.paused(fixed !== null);
      } else {
        renderer.launchedEnd(end.displayName);
      }
    } finally {
      shutdownHandle.dispose();
      for (const [signal, listener] of posixSignals) {
        try {
          Deno.removeSignalListener(signal, listener);
        } catch {
          // Already removed.
        }
      }
    }
    if (signalExitCode !== undefined) Deno.exitCode = signalExitCode;
  } finally {
    await server.shutdown();
  }
}

export const startCommand = new Command()
  .name("start")
  .description(
    "Get from a task to an agent working on it. Opens a local page where you\n" +
      "pick or create a workspace, describe the task, sign in if needed and\n" +
      "pick an agent; Swamp then opens the agent in a new terminal window.\n" +
      "With --json it only reports your workspaces and agents; it starts\n" +
      "nothing and changes nothing.",
  )
  .example("Start", "swamp start")
  .example("Go straight to a workspace", "swamp start --workspace misty-heron")
  .example(
    "Print the page URL instead of opening a browser",
    "swamp start --no-browser",
  )
  .option("--no-browser", "Print the URL instead of opening a browser")
  .option("--workspace <name:string>", WORKSPACE_OPTION_DESCRIPTION)
  .action(async function (options: AnyOptions) {
    await runStart(options, ["start"]);
  })
  .command("status", startStatusCommand);
