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

import { isServeFederationEnabled } from "../../domain/serve/federation_gate.ts";
import { Command, EnumType } from "@cliffy/command";
import { join, resolve } from "@std/path";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import {
  APP_DESCRIPTOR_FILE,
  APP_SOURCE_DIR,
  appFolderName,
  parseAppDescriptor,
} from "../../domain/apps/app_descriptor.ts";
import {
  APP_DEV_HEARTBEAT_MS,
  FilesystemAppCatalog,
  writeDevRegistration,
} from "../../infrastructure/persistence/filesystem_app_catalog.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import {
  type SwampError,
  userErrorFromSwampError,
} from "../../libswamp/errors.ts";
import {
  appApprove,
  appList,
  type AppListData,
  appRevoke,
} from "../../libswamp/apps/apps.ts";
import {
  APP_TEMPLATES,
  appInit,
  type AppInitData,
  type AppTemplate,
} from "../../libswamp/apps/init.ts";
import {
  appApprovePrompt,
  renderAppApprove,
  renderAppApproveCancelled,
  renderAppBuild,
  renderAppDevReady,
  renderAppInit,
  renderAppList,
  renderAppRevoke,
} from "../../presentation/renderers/app.ts";
import { bunCommands, missingBunMessage, usesMise } from "./app_toolchain.ts";
import { platformRequirement } from "../../domain/apps/app_platform.ts";
import type { InstalledApp } from "../../domain/apps/app_catalog.ts";
import { writeAppPlatform } from "../../libswamp/apps/platform_files.ts";
import type {
  AppApproveResponse,
  AppListResponse,
  AppRevokeResponse,
} from "../../serve/protocol.ts";
import { resolveCliInitiatedBy } from "../auth_context.ts";
import { promptConfirmation } from "../prompt_helpers.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import { localAppDeps } from "./app_deps.ts";
import {
  libSwampContextForRepo,
  requireInitializedRepoReadOnly,
} from "../repo_context.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const REPO_DIR_FLAG = "--repo-dir <dir:string>";
const REPO_DIR_HELP = "Repository directory (env: SWAMP_REPO_DIR)";

/** The local dashboard reads this checkout's record, whatever serve it names. */
const LOCAL_FLAG = "--local";
const LOCAL_HELP = "Act on this checkout, ignoring any configured server";

const appListCommand = withRemoteOptions(
  new Command()
    .name("list")
    .description("List installed apps and whether each one is enabled")
    .option(LOCAL_FLAG, LOCAL_HELP, { hidden: true })
    .option(REPO_DIR_FLAG, REPO_DIR_HELP),
).action(async function (options: AnyOptions) {
  const cliCtx = createContext(options as GlobalOptions, ["app", "list"]);
  renderAppList(cliCtx.outputMode, await listApps(options, cliCtx));
});

async function listApps(
  options: AnyOptions,
  cliCtx: ReturnType<typeof createContext>,
): Promise<AppListData> {
  const server = options.local
    ? undefined
    : resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(server, options);
    const response = await requestServerResponse<AppListResponse>(
      { server, token },
      { type: "app.list" },
    );
    return response.data;
  }
  const { ctx, deps } = await localAppDeps(
    resolveRepoDir(options.repoDir),
    cliCtx.outputMode,
    cliCtx.logger,
  );
  return await completedData(appList(ctx, deps), "Listing apps");
}

export async function completedData<T>(
  stream: AsyncIterable<
    { kind: "completed"; data: T } | { kind: "error"; error: SwampError }
  >,
  action: string,
): Promise<T> {
  let result: { data: T } | undefined;
  await consumeStream(stream, {
    completed: (e) => {
      result = { data: e.data };
    },
    error: (e) => {
      throw userErrorFromSwampError(e.error);
    },
  });
  if (!result) throw new UserError(`${action} did not complete.`);
  return result.data;
}

const appApproveCommand = withRemoteOptions(
  new Command()
    .name("approve")
    .description("Enable an installed app for everyone using this repository")
    .arguments("<name:string>")
    .option(
      "--capability-key <key:string>",
      "Refuse unless the app still asks for exactly this",
      { hidden: true },
    )
    .option("-y, --yes", "Skip confirmation prompt")
    .option("-f, --force", "Skip confirmation prompt (alias for --yes)")
    .option(LOCAL_FLAG, LOCAL_HELP, { hidden: true })
    .option(REPO_DIR_FLAG, REPO_DIR_HELP),
).action(async function (options: AnyOptions, name: string) {
  const cliCtx = createContext(options as GlobalOptions, ["app", "approve"]);
  let capabilityKey = options.capabilityKey as string | undefined;
  if (cliCtx.outputMode === "log" && !options.yes && !options.force) {
    const app = (await listApps(options, cliCtx)).apps.find((entry) =>
      entry.name === name
    );
    if (app !== undefined) {
      const { question, details } = appApprovePrompt(app);
      if (!await promptConfirmation(question, details)) {
        renderAppApproveCancelled(cliCtx.outputMode, name);
        return;
      }
      // the operator agreed to what was shown, not whatever is there by now
      capabilityKey ??= app.capabilityKey;
    }
  }
  const server = options.local
    ? undefined
    : resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(server, options);
    const response = await requestServerResponse<AppApproveResponse>(
      { server, token },
      {
        type: "app.approve",
        payload: {
          name,
          ...(capabilityKey !== undefined ? { capabilityKey } : {}),
        },
      },
    );
    renderAppApprove(cliCtx.outputMode, response.data);
    return;
  }
  const { ctx, deps } = await localAppDeps(
    resolveRepoDir(options.repoDir),
    cliCtx.outputMode,
    cliCtx.logger,
  );
  renderAppApprove(
    cliCtx.outputMode,
    await completedData(
      appApprove(ctx, deps, {
        name,
        capabilityKey,
        approvedBy: await resolveCliInitiatedBy(),
      }),
      `Enabling ${name}`,
    ),
  );
});

const appRevokeCommand = withRemoteOptions(
  new Command()
    .name("revoke")
    .description("Disable an app; it stays installed")
    .arguments("<name:string>")
    .option(LOCAL_FLAG, LOCAL_HELP, { hidden: true })
    .option(REPO_DIR_FLAG, REPO_DIR_HELP),
).action(async function (options: AnyOptions, name: string) {
  const cliCtx = createContext(options as GlobalOptions, ["app", "revoke"]);
  const server = options.local
    ? undefined
    : resolveServeUrl(options.server as string | undefined);
  if (server) {
    const token = await resolveServerTokenFromOptions(server, options);
    const response = await requestServerResponse<AppRevokeResponse>(
      { server, token },
      { type: "app.revoke", payload: { name } },
    );
    renderAppRevoke(cliCtx.outputMode, response.data);
    return;
  }
  const { ctx, deps } = await localAppDeps(
    resolveRepoDir(options.repoDir),
    cliCtx.outputMode,
    cliCtx.logger,
  );
  renderAppRevoke(
    cliCtx.outputMode,
    await completedData(appRevoke(ctx, deps, { name }), `Disabling ${name}`),
  );
});

const appInitCommand = new Command()
  .name("init")
  .description("Create a new app with the theme, components and chart examples")
  .type("template", new EnumType(APP_TEMPLATES))
  .arguments("<name:string>")
  .option("--title <title:string>", "The name shown in the dashboard")
  .option(
    "--template <template:template>",
    "Starting point for the app",
    { default: "dashboard" },
  )
  .option(REPO_DIR_FLAG, REPO_DIR_HELP)
  .action(async function (options: AnyOptions, name: string) {
    const cliCtx = createContext(options as GlobalOptions, ["app", "init"]);
    const template = options.template as AppTemplate;
    const repoDir = resolveRepoDir(options.repoDir);
    const repo = await requireInitializedRepoReadOnly({
      repoDir,
      outputMode: cliCtx.outputMode,
    });
    const folder = appFolderName(name);
    let result: AppInitData | undefined;
    await consumeStream(
      appInit(
        libSwampContextForRepo(repo.repoContext, { logger: cliCtx.logger }),
        {
          name,
          title: options.title as string | undefined,
          directory: join(repo.repoDir, APP_SOURCE_DIR, folder),
          template,
        },
      ),
      {
        completed: (e) => {
          result = e.data;
        },
        error: (e) => {
          throw userErrorFromSwampError(e.error);
        },
      },
    );
    if (result) renderAppInit(cliCtx.outputMode, result);
  });

async function appFolder(dir: string | undefined): Promise<{
  folder: string;
  name: string;
  platformMajor: number;
  /** Whether `app.yaml` names a platform rather than taking the default. */
  declaresPlatform: boolean;
}> {
  const folder = resolve(dir ?? ".");
  const path = join(folder, APP_DESCRIPTOR_FILE);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    throw markErrorPaths(
      new UserError(
        `No ${APP_DESCRIPTOR_FILE} in ${folder}. Run this in the app's folder, or pass its path.`,
      ),
      [folder],
    );
  }
  const descriptor = parseAppDescriptor(text, path, {
    federation: isServeFederationEnabled((name) => Deno.env.get(name)),
  });
  return {
    folder,
    name: descriptor.name,
    platformMajor: platformRequirement(descriptor.platform).major,
    declaresPlatform: /^platform\s*:/m.test(text),
  };
}

async function runVite(
  folder: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<Deno.ChildProcess> {
  // Bun runs the script directly; the .bin shim cannot be spawned on Windows
  const vite = join(folder, "node_modules", "vite", "bin", "vite.js");
  try {
    await Deno.stat(vite);
  } catch {
    throw markErrorPaths(
      new UserError(`Vite is not installed in ${folder}. Run bun install.`),
      [folder],
    );
  }
  const mise = await usesMise(folder);
  for (const { command, args: commandArgs } of bunCommands(mise, vite, args)) {
    try {
      return new Deno.Command(command, {
        args: [...commandArgs],
        cwd: folder,
        env,
        stdin: "null",
        stdout: "piped",
        stderr: "inherit",
      }).spawn();
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  throw new UserError(missingBunMessage(mise));
}

/** Plain sentences without `{`, so the logger prints them as they are. */
export function appBuildWarnings(
  major: number,
  heldMinor: number | undefined,
  declaresPlatform: boolean,
): string[] {
  if (heldMinor === undefined) {
    return [
      `This swamp carries no build of app platform ${major}, so the app's kit types and dev build are missing. A source checkout builds it with: deno run build-app-platform`,
    ];
  }
  if (declaresPlatform) return [];
  const held = `${major}.${heldMinor}`;
  return [
    `app.yaml names no platform, so any swamp with platform ${major} will open the app, even one older than the ${held} this swamp holds. Add platform: "${held}" to app.yaml.`,
  ];
}

const appBuildCommand = new Command()
  .name("build")
  .description("Build an app for serving; pass its folder or run it inside one")
  .arguments("[path:string]")
  .action(async function (options: AnyOptions, dir?: string) {
    const cliCtx = createContext(options as GlobalOptions, ["app", "build"]);
    const { folder, name, platformMajor, declaresPlatform } = await appFolder(
      dir,
    );
    const platform = await writeAppPlatform(folder, platformMajor);
    const warnings = appBuildWarnings(
      platformMajor,
      platform.minor,
      declaresPlatform,
    );
    for (const warning of warnings) cliCtx.logger.warn(warning);
    const child = await runVite(folder, ["build"]);
    // log mode shows Vite's summary on stderr; json keeps stdout to the result
    const relay = cliCtx.outputMode === "log"
      ? child.stdout.pipeTo(Deno.stderr.writable, { preventClose: true })
      : child.stdout.cancel();
    const [{ code }] = await Promise.all([child.status, relay]);
    if (code !== 0) {
      throw new UserError(
        cliCtx.outputMode === "log"
          ? `The build of ${name} failed. See Vite's output above.`
          : `The build of ${name} failed. Run bun run build in its folder to see why.`,
      );
    }
    renderAppBuild(cliCtx.outputMode, { name, directory: folder, warnings });
  });

/** Compared by real path, so a repository opened through a symlink matches. */
export async function inRepoCatalog(
  apps: readonly Pick<InstalledApp, "descriptor" | "origin" | "root">[],
  name: string,
  folder: string,
): Promise<boolean> {
  const real = async (path: string) => {
    try {
      return await Deno.realPath(path);
    } catch {
      return resolve(path);
    }
  };
  const realFolder = await real(folder);
  for (const app of apps) {
    if (
      app.descriptor.name === name && app.origin === "local" &&
      await real(app.root) === realFolder
    ) {
      return true;
    }
  }
  return false;
}

const DEV_READY = /https?:\/\/(127\.0\.0\.1|localhost):(\d+)/;

const appDevCommand = new Command()
  .name("dev")
  .description(
    "Run an app with hot reload inside the local dashboard; pass its folder or run it inside one",
  )
  .arguments("[path:string]")
  .option(REPO_DIR_FLAG, REPO_DIR_HELP)
  .action(async function (options: AnyOptions, dir?: string) {
    const cliCtx = createContext(options as GlobalOptions, ["app", "dev"]);
    const repo = await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });
    const { folder, name, platformMajor, declaresPlatform } = await appFolder(
      dir,
    );
    const platform = await writeAppPlatform(folder, platformMajor);
    for (
      const warning of appBuildWarnings(
        platformMajor,
        platform.minor,
        declaresPlatform,
      )
    ) {
      cliCtx.logger.warn(warning);
    }
    const { apps } = await new FilesystemAppCatalog({ repoDir: repo.repoDir })
      .list();
    if (!await inRepoCatalog(apps, name, folder)) {
      throw new UserError(
        `${name} is not in this repository's ${APP_SOURCE_DIR}/ folder, so the dashboard would not show it. Move it there, or pass --repo-dir.`,
      );
    }
    const child = await runVite(folder, ["--host", "127.0.0.1"], {
      NO_COLOR: "1",
    });
    let registration: string | undefined;
    let stopped = false;
    const forget = () => {
      if (registration === undefined) return;
      try {
        Deno.removeSync(registration);
      } catch {
        // Gone already; a stale file is ignored once its heartbeat stops.
      }
    };
    const stop = () => {
      stopped = true;
      forget();
      try {
        child.kill("SIGTERM");
      } catch {
        // Vite has already exited.
      }
    };
    const signals: Deno.Signal[] = Deno.build.os === "windows"
      ? ["SIGINT"]
      : ["SIGINT", "SIGTERM"];
    for (const signal of signals) Deno.addSignalListener(signal, stop);
    // chained and awaited at exit; a failed touch only lets the registration go stale
    let touching: Promise<void> = Promise.resolve();
    const heartbeat = setInterval(() => {
      const path = registration;
      if (path === undefined) return;
      const now = new Date();
      touching = touching.then(() => Deno.utime(path, now, now)).catch(
        () => {},
      );
    }, APP_DEV_HEARTBEAT_MS);
    try {
      const reader = child.stdout.pipeThrough(new TextDecoderStream())
        .getReader();
      let output = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = new TextEncoder().encode(value);
        // write may take only part of a chunk
        for (let written = 0; written < bytes.length;) {
          written += await Deno.stderr.write(bytes.subarray(written));
        }
        if (registration !== undefined) continue;
        // a read can end mid-URL
        output += value;
        const ready = DEV_READY.exec(output);
        if (ready === null) continue;
        const url = `http://127.0.0.1:${ready[2]}/`;
        registration = await writeDevRegistration(repo.repoDir, {
          name,
          root: folder,
          url,
        });
        renderAppDevReady(cliCtx.outputMode, { name, url });
      }
    } catch (error) {
      stop();
      throw error;
    } finally {
      clearInterval(heartbeat);
      await touching;
      for (const signal of signals) Deno.removeSignalListener(signal, stop);
      forget();
    }
    const { code } = await child.status;
    if (code !== 0 && !stopped) {
      throw new UserError(`The dev server for ${name} stopped unexpectedly.`);
    }
    if (registration === undefined && !stopped) {
      throw new UserError(
        `The dev server for ${name} exited before it was ready. Run bun run dev in its folder to see why.`,
      );
    }
  });

export const appCommand = new Command()
  .name("app")
  .description("Build, enable and manage swamp apps")
  .command("list", appListCommand)
  .command("approve", appApproveCommand)
  .command("revoke", appRevokeCommand)
  .command("init", appInitCommand)
  .command("build", appBuildCommand)
  .command("dev", appDevCommand);
