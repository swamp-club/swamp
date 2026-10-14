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
import { groupCommandAction } from "../group_action.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { UpdatePreferencesFileRepository } from "../../infrastructure/update/update_preferences_file_repository.ts";
import { TelemetryPreferencesFileRepository } from "../../infrastructure/persistence/telemetry_preferences_file_repository.ts";
import { WorkspacePreferencesFileRepository } from "../../infrastructure/persistence/workspace_preferences_file_repository.ts";
import { expandHome } from "../../libswamp/workspace/workspace_store.ts";
import { resolve } from "@std/path";
import {
  createScheduler,
  isRunningAsRoot,
  resolveLaunchdMode,
} from "../../infrastructure/update/scheduler_factory.ts";
import type { UpdateCadence } from "../../domain/update/update_preferences.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const CONFIG_KEYS: Record<string, { description: string; values?: string[] }> =
  {
    "update.auto": {
      description: "Enable or disable background autoupdate",
      values: ["enabled", "disabled"],
    },
    "update.cadence": {
      description: "How often to check for updates",
      values: ["hourly", "daily", "weekly"],
    },
    "telemetry.collection": {
      description:
        "Enable or disable usage telemetry for every run, in any repository",
      values: ["enabled", "disabled"],
    },
    "workspaces.dir": {
      description:
        'The folder new workspaces are created in (an existing folder, or "default" for the swamp data dir)',
    },
  };

/** What `workspaces.dir` shows when no folder is set. */
const WORKSPACES_DIR_DEFAULT = "default";

/**
 * The folder a `workspaces.dir` value names, absolute and as it really is,
 * or undefined for "default".
 *
 * @throws {UserError} when it isn't an existing folder
 */
async function workspacesDirValue(raw: string): Promise<string | undefined> {
  const typed = raw.trim();
  if (typed === WORKSPACES_DIR_DEFAULT) return undefined;
  if (typed === "") {
    throw new UserError(
      `Give workspaces.dir a folder, or "${WORKSPACES_DIR_DEFAULT}" for the swamp data dir.`,
    );
  }
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  const expanded = expandHome(typed, home, Deno.build.os);
  // A relative folder is taken from where the command runs.
  const path = resolve(expanded);
  let isDirectory = false;
  try {
    isDirectory = (await Deno.stat(path)).isDirectory;
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw markErrorPaths(
      new UserError(
        `There's no folder at ${path}. Create it first, or choose another.`,
      ),
      [path],
    );
  }
  return await Deno.realPath(path);
}

const configGetCommand = new Command()
  .description("Get a configuration value")
  .arguments("<key:string>")
  .action(async function (options: AnyOptions, key: string) {
    const ctx = createContext(options as GlobalOptions, ["config", "get"]);
    ctx.logger.debug`Getting config key: ${key}`;

    if (!(key in CONFIG_KEYS)) {
      throw new UserError(
        `Unknown config key: ${key}. Valid keys: ${
          Object.keys(CONFIG_KEYS).join(", ")
        }`,
      );
    }

    const prefsRepo = new UpdatePreferencesFileRepository();
    const prefs = await prefsRepo.read();

    let value: string;
    switch (key) {
      case "update.auto":
        value = prefs.enabled ? "enabled" : "disabled";
        break;
      case "update.cadence":
        value = prefs.cadence;
        break;
      case "telemetry.collection": {
        const telemetry = await new TelemetryPreferencesFileRepository().read();
        value = telemetry.disabled ? "disabled" : "enabled";
        break;
      }
      case "workspaces.dir":
        value = (await new WorkspacePreferencesFileRepository().read()).dir ??
          WORKSPACES_DIR_DEFAULT;
        break;
      default:
        throw new UserError(`Unknown config key: ${key}`);
    }

    if (ctx.outputMode === "json") {
      console.log(JSON.stringify({ key, value }));
    } else {
      ctx.logger.info`${value}`;
    }
  });

const configSetCommand = new Command()
  .description("Set a configuration value")
  .arguments("<key:string> <value:string>")
  .action(async function (options: AnyOptions, key: string, value: string) {
    const ctx = createContext(options as GlobalOptions, ["config", "set"]);
    ctx.logger.debug`Setting config key: ${key} = ${value}`;

    if (!(key in CONFIG_KEYS)) {
      throw new UserError(
        `Unknown config key: ${key}. Valid keys: ${
          Object.keys(CONFIG_KEYS).join(", ")
        }`,
      );
    }

    const meta = CONFIG_KEYS[key];
    if (meta.values && !meta.values.includes(value)) {
      throw new UserError(
        `Invalid value for ${key}: ${value}. Must be ${
          meta.values.map((v) => `"${v}"`).join(" or ")
        }.`,
      );
    }

    // Like telemetry, a plain user-level file: no scheduler, no root check.
    if (key === "workspaces.dir") {
      const dir = await workspacesDirValue(value);
      await new WorkspacePreferencesFileRepository().write(
        dir === undefined ? {} : { dir },
      );
      const shown = dir ?? WORKSPACES_DIR_DEFAULT;
      if (ctx.outputMode === "json") {
        console.log(JSON.stringify({ key, value: shown }));
      } else {
        ctx.logger.info(
          dir === undefined
            ? "New workspaces are created under the swamp data dir"
            : `New workspaces are created in ${dir}`,
        );
      }
      return;
    }

    // Telemetry is a plain user-level file with no scheduler behind it, so it
    // never needs the root check the update.* keys do.
    if (key === "telemetry.collection") {
      const disabled = value === "disabled";
      const telemetryRepo = new TelemetryPreferencesFileRepository();
      await telemetryRepo.write({ ...(await telemetryRepo.read()), disabled });

      if (ctx.outputMode === "json") {
        console.log(JSON.stringify({ key, value }));
      } else {
        ctx.logger.info(
          disabled
            ? "Telemetry disabled for every run, in any repository"
            : "User-level telemetry opt-out removed; --no-telemetry, SWAMP_NO_TELEMETRY, DO_NOT_TRACK and a repository's telemetryDisabled still apply",
        );
        ctx.logger.info("Restart any running swamp serve daemon to apply it");
      }
      return;
    }

    const prefsRepo = new UpdatePreferencesFileRepository();
    const prefs = await prefsRepo.read();

    const launchdMode = await resolveLaunchdMode();

    if (launchdMode === "daemon" && !isRunningAsRoot()) {
      const schedulerDesc = Deno.build.os === "darwin"
        ? "system LaunchDaemon"
        : "system-level scheduler";
      throw new UserError(
        `Autoupdate is configured as a ${schedulerDesc} (root-owned binary).\n` +
          `Re-run with sudo to modify:\n\n` +
          `  sudo swamp config set ${key} ${value}`,
      );
    }

    switch (key) {
      case "update.auto": {
        const enabling = value === "enabled";

        const scheduler = await createScheduler({ launchdMode });
        if (enabling) {
          await scheduler.install(Deno.execPath(), prefs.cadence);
        } else {
          await scheduler.remove();
        }

        await prefsRepo.write({ ...prefs, enabled: enabling });

        if (ctx.outputMode === "json") {
          console.log(JSON.stringify({ key, value }));
        } else {
          ctx.logger.info(
            enabling
              ? "Autoupdate enabled and scheduler installed"
              : "Autoupdate disabled and scheduler removed",
          );
        }
        break;
      }
      case "update.cadence": {
        const cadence = value as UpdateCadence;
        if (prefs.enabled) {
          const scheduler = await createScheduler({ launchdMode });
          await scheduler.install(Deno.execPath(), cadence);
        }

        await prefsRepo.write({ ...prefs, cadence });

        if (ctx.outputMode === "json") {
          console.log(JSON.stringify({ key, value }));
        } else if (prefs.enabled) {
          ctx.logger
            .info`Cadence updated to ${value} and scheduler reinstalled`;
        } else {
          ctx.logger.info`Cadence updated to ${value}`;
        }
        break;
      }
      default:
        throw new UserError(`Unhandled config key: ${key}`);
    }
  });

const configListCommand = new Command()
  .description("List all configuration keys and current values")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["config", "list"]);

    const prefsRepo = new UpdatePreferencesFileRepository();
    const prefs = await prefsRepo.read();
    const telemetry = await new TelemetryPreferencesFileRepository().read();

    const values: Record<string, string> = {
      "update.auto": prefs.enabled ? "enabled" : "disabled",
      "update.cadence": prefs.cadence,
      "telemetry.collection": telemetry.disabled ? "disabled" : "enabled",
      "workspaces.dir":
        (await new WorkspacePreferencesFileRepository().read()).dir ??
          WORKSPACES_DIR_DEFAULT,
    };

    if (ctx.outputMode === "json") {
      console.log(JSON.stringify(values, null, 2));
      return;
    }

    for (const [key, meta] of Object.entries(CONFIG_KEYS)) {
      const current = values[key];
      const allowed = meta.values ? ` (${meta.values.join("|")})` : "";
      ctx.logger.info(`${key} = ${current}${allowed}`);
    }
  });

export const configCommand = new Command()
  .description("Manage swamp configuration")
  .action(groupCommandAction)
  .command("get", configGetCommand)
  .command("set", configSetCommand)
  .command("list", configListCommand);
