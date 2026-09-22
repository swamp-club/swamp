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

import { UserError } from "../../domain/errors.ts";

/**
 * How long to wait for the launcher to exit before assuming it has handed
 * the URL to a browser it is now running in the foreground.
 */
export const BROWSER_LAUNCH_GRACE_MS = 2000;

/** The parts of a spawned launcher process that {@link openBrowser} uses. */
export interface BrowserLauncherProcess {
  readonly status: Promise<Deno.CommandStatus>;
  unref(): void;
}

/** Dependencies for {@link openBrowser}, injected for testability. */
export interface OpenBrowserDeps {
  readonly os: typeof Deno.build.os;
  readonly graceMs: number;
  readonly spawn: (
    command: string,
    options: Deno.CommandOptions,
  ) => BrowserLauncherProcess;
}

const defaultDeps: OpenBrowserDeps = {
  os: Deno.build.os,
  graceMs: BROWSER_LAUNCH_GRACE_MS,
  spawn: (command, options) => new Deno.Command(command, options).spawn(),
};

/**
 * Open a URL in the user's default browser.
 *
 * Resolves once the launcher has handed the URL off. Some launchers run the
 * browser in the foreground instead of exiting (xdg-open's generic path does
 * this when the browser is not already open), so a launcher still running
 * after the grace window is treated as launched rather than awaited.
 * Throws a UserError with the URL if the launcher cannot be started or exits
 * with an error.
 */
export async function openBrowser(
  url: string,
  deps: Partial<OpenBrowserDeps> = {},
): Promise<void> {
  const { os, graceMs, spawn } = { ...defaultDeps, ...deps };

  let cmd: string[];
  if (os === "darwin") {
    cmd = ["open", url];
  } else if (os === "windows") {
    cmd = ["cmd", "/c", "start", url];
  } else {
    // Linux and other Unix-like systems
    cmd = ["xdg-open", url];
  }

  const failure = new UserError(
    `Could not open a browser. Please open this URL manually:\n  ${url}`,
  );

  let child: BrowserLauncherProcess;
  try {
    // Null stdio so a browser started by the launcher cannot hold a pipe
    // to this process open.
    child = spawn(cmd[0], {
      args: cmd.slice(1),
      stdin: "null",
      stdout: "null",
      stderr: "null",
    });
  } catch {
    throw failure;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const stillRunning = new Promise<"running">((resolve) => {
    timer = setTimeout(() => resolve("running"), graceMs);
  });

  let outcome: Deno.CommandStatus | "running";
  try {
    outcome = await Promise.race([child.status, stillRunning]);
  } catch {
    throw failure;
  } finally {
    clearTimeout(timer);
  }

  if (outcome === "running") {
    // Let this process exit without waiting for the browser.
    child.unref();
    return;
  }
  if (!outcome.success) {
    throw failure;
  }
}
