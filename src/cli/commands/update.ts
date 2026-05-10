// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { createContext, type GlobalOptions, isStdinTty } from "../context.ts";
import { VERSION } from "./version.ts";
import { Platform } from "../../domain/update/platform.ts";
import {
  consumeStream,
  createLibSwampContext,
  createUpdateCheckDeps,
  updateCheck,
} from "../../libswamp/mod.ts";
import { createUpdateCheckRenderer } from "../../presentation/renderers/update_check.ts";
import { Spinner } from "../../presentation/spinner.ts";
import { UpdatePreferencesFileRepository } from "../../infrastructure/update/update_preferences_file_repository.ts";
import { AutoupdateLogFileRepository } from "../../infrastructure/update/autoupdate_log_file_repository.ts";
import { createScheduler } from "../../infrastructure/update/scheduler_factory.ts";
import {
  isValidCadence,
  type UpdateCadence,
} from "../../domain/update/update_preferences.ts";
import {
  AUTOUPDATE_LOG_RETENTION_DAYS,
  type AutoupdateLogEntry,
} from "../../domain/update/autoupdate_log.ts";
import type { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const BACKGROUND_TIMEOUT_MS = 5 * 60 * 1000;

async function runBackgroundUpdate(
  ctx: { logger: ReturnType<typeof getSwampLogger> },
): Promise<void> {
  const platform = Platform.detect();
  const logRepo = new AutoupdateLogFileRepository();
  const deps = createUpdateCheckDeps(VERSION, Deno.execPath());

  const entry: AutoupdateLogEntry = {
    timestamp: new Date().toISOString(),
    versionBefore: VERSION,
    versionAfter: null,
    outcome: "up_to_date",
  };

  let timeoutId: number;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("Background update timed out")),
        BACKGROUND_TIMEOUT_MS,
      );
      Deno.unrefTimer(timeoutId);
    });
    const result = await Promise.race([deps.update(platform), timeout]);
    clearTimeout(timeoutId!);

    if (result.status === "updated") {
      entry.versionAfter = result.newVersion;
      entry.outcome = "updated";
    }
  } catch (error) {
    clearTimeout(timeoutId!);
    entry.outcome = "error";
    entry.error = error instanceof Error ? error.message : String(error);
  }

  await logRepo.append(entry);
  await logRepo.prune(AUTOUPDATE_LOG_RETENTION_DAYS);

  ctx.logger.debug`Background update completed: ${entry.outcome}`;

  if (
    entry.outcome === "error" && entry.error &&
    entry.error.toLowerCase().includes("permission denied")
  ) {
    Deno.exit(1);
  }
}

function promptCadence(defaultCadence: UpdateCadence): UpdateCadence {
  while (true) {
    const input = prompt(
      "How often should swamp check for updates? (daily/weekly)",
      defaultCadence,
    );
    if (input === null) {
      throw new UserError(
        "No input received. Use `swamp config set update.cadence <daily|weekly>` instead.",
      );
    }
    if (isValidCadence(input)) {
      return input;
    }
    console.error(`Invalid cadence: ${input}. Must be "daily" or "weekly".`);
  }
}

async function runSetupAuto(
  ctx: { logger: ReturnType<typeof getSwampLogger>; outputMode: string },
): Promise<void> {
  if (!isStdinTty()) {
    throw new UserError(
      "Cannot set up autoupdate in a non-interactive environment. Use `swamp config set` instead.",
    );
  }

  const binaryPath = Deno.execPath();
  const probeFile = binaryPath + ".swamp-write-test";
  try {
    await Deno.writeTextFile(probeFile, "");
    await Deno.remove(probeFile);
  } catch (error) {
    if (error instanceof Deno.errors.PermissionDenied) {
      throw new UserError(
        `Cannot set up autoupdate: the directory containing ${binaryPath} is not writable.\n` +
          `The background scheduler runs as your user and cannot replace the binary.\n\n` +
          `Options:\n` +
          `  • Change ownership:  sudo chown ${
            Deno.env.get("USER") ?? "$(whoami)"
          } ${binaryPath}\n` +
          `  • Run updates manually:  sudo swamp update`,
      );
    }
    throw error;
  }

  const prefsRepo = new UpdatePreferencesFileRepository();
  const prefs = await prefsRepo.read();
  const logger = ctx.logger;

  const cadence = promptCadence(prefs.cadence);

  const scheduler = await createScheduler();
  await scheduler.install(binaryPath, cadence);

  await prefsRepo.write({ ...prefs, enabled: true, cadence });

  if (ctx.outputMode === "json") {
    console.log(JSON.stringify({ enabled: true, cadence }));
  } else {
    logger.info`Autoupdate enabled with ${cadence} checks`;

    const status = await scheduler.status();
    if (status.installed) {
      logger.info("Background scheduler installed successfully");
    }
  }
}

async function runDisableAuto(
  ctx: { logger: ReturnType<typeof getSwampLogger>; outputMode: string },
): Promise<void> {
  const prefsRepo = new UpdatePreferencesFileRepository();
  const prefs = await prefsRepo.read();

  const scheduler = await createScheduler();
  await scheduler.remove();

  await prefsRepo.write({ ...prefs, enabled: false });

  if (ctx.outputMode === "json") {
    console.log(
      JSON.stringify({ key: "update.auto", value: "disabled" }),
    );
  } else {
    ctx.logger.info("Autoupdate disabled and scheduler removed");
  }
}

async function runSetupAutoStatus(
  ctx: { logger: ReturnType<typeof getSwampLogger>; outputMode: string },
): Promise<void> {
  const prefsRepo = new UpdatePreferencesFileRepository();
  const prefs = await prefsRepo.read();

  if (ctx.outputMode === "json") {
    const scheduler = await createScheduler();
    const scheduleStatus = await scheduler.status();
    const logRepo = new AutoupdateLogFileRepository();
    const entries = await logRepo.readAll();
    const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;

    console.log(JSON.stringify(
      {
        enabled: prefs.enabled,
        cadence: prefs.cadence,
        schedulerInstalled: scheduleStatus.installed,
        lastUpdate: lastEntry,
      },
      null,
      2,
    ));
    return;
  }

  const logger = ctx.logger;

  if (!prefs.enabled) {
    logger.info(
      "Autoupdate is disabled. Run `swamp update --setup-auto` to enable.",
    );
    return;
  }

  logger.info`Autoupdate: enabled`;
  logger.info`Cadence: ${prefs.cadence}`;

  const scheduler = await createScheduler();
  const scheduleStatus = await scheduler.status();
  logger.info`Scheduler installed: ${scheduleStatus.installed}`;

  const logRepo = new AutoupdateLogFileRepository();
  const entries = await logRepo.readAll();
  if (entries.length > 0) {
    const last = entries[entries.length - 1];
    logger.info`Last check: ${last.timestamp} (${last.outcome})`;
    if (last.versionAfter) {
      logger
        .info`Last update: ${last.versionBefore} → ${last.versionAfter}`;
    }
  } else {
    logger.info("No autoupdate history yet");
  }
}

export const updateCommand = new Command()
  .description("Update swamp to the latest version")
  .option("--check", "Check for updates without installing")
  .option("--background", "Run update silently", { hidden: true })
  .option(
    "--setup-auto [action:string]",
    "Configure autoupdate interactively; use 'status' to check, 'disable' to turn off",
  )
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["update"]);
    ctx.logger.debug("Executing update command");

    if (options.background) {
      await runBackgroundUpdate(ctx);
      return;
    }

    if (options.setupAuto !== undefined) {
      const validActions = ["status", "disable"];
      if (
        typeof options.setupAuto === "string" &&
        !validActions.includes(options.setupAuto)
      ) {
        throw new UserError(
          `Unknown action: ${options.setupAuto}. Valid actions: ${
            validActions.join(", ")
          } (or omit value for interactive setup)`,
        );
      }

      if (options.setupAuto === "status") {
        await runSetupAutoStatus(ctx);
      } else if (options.setupAuto === "disable") {
        await runDisableAuto(ctx);
      } else {
        await runSetupAuto(ctx);
      }
      return;
    }

    const platform = Platform.detect();
    ctx.logger.debug`Detected platform: ${platform}`;

    const spinner = ctx.outputMode !== "json" ? new Spinner() : null;

    try {
      const message = options.check
        ? "Checking for updates..."
        : "Updating swamp...";
      spinner?.start(message);

      const libCtx = createLibSwampContext({ logger: ctx.logger });
      const deps = createUpdateCheckDeps(VERSION, Deno.execPath());
      const renderer = createUpdateCheckRenderer(ctx.outputMode);
      await consumeStream(
        updateCheck(libCtx, deps, {
          checkOnly: options.check ?? false,
          platform,
        }),
        renderer.handlers(),
      );

      spinner?.stop();
    } catch (err) {
      spinner?.stop();
      throw err;
    }

    ctx.logger.debug("Update command completed");
  });
