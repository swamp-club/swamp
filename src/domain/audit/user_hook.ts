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

import { dirname, join } from "@std/path";
import { ensureDir } from "@std/fs";
import { markErrorPaths, UserError } from "../errors.ts";
import {
  CLAUDE_AUDIT_HOOK_SHAPE,
  claudeAuditHooks,
  countAuditHooks,
  LEGACY_CLAUDE_AUDIT_HOOK_ENTRY,
  mergeAuditHooks,
  migrateLegacyClaudeAuditHooks,
} from "../repo/repo_service.ts";

export interface UserAuditHookResult {
  settingsPath: string;
  changed: boolean;
}

export function claudeUserSettingsPath(homeDir: string): string {
  return join(homeDir, ".claude", "settings.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function lstatOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

/** writes land on a symlink's target so a dotfiles-managed link survives the rename */
async function resolveWritePath(settingsPath: string): Promise<string> {
  const info = await lstatOrNull(settingsPath);
  if (info?.isSymlink) {
    try {
      return await Deno.realPath(settingsPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw markErrorPaths(
          new UserError(
            `${settingsPath} is a symlink to a file that does not exist; fix the link or remove it, then run the command again.`,
          ),
          [settingsPath],
        );
      }
      throw error;
    }
  }
  if (info) return settingsPath;
  const dir = dirname(settingsPath);
  const dirInfo = await lstatOrNull(dir);
  if (dirInfo === null) return settingsPath;
  try {
    return join(await Deno.realPath(dir), "settings.json");
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw markErrorPaths(
        new UserError(
          `${dir} is a symlink to a directory that does not exist; fix the link or remove it, then run the command again.`,
        ),
        [dir],
      );
    }
    throw error;
  }
}

interface LoadedSettings {
  writePath: string;
  settings: Record<string, unknown> | null;
  hooks: Record<string, unknown>;
  mode?: number;
}

/** configures every Claude session, so anything unexpected is refused, never overwritten */
async function loadSettings(settingsPath: string): Promise<LoadedSettings> {
  const writePath = await resolveWritePath(settingsPath);
  let text: string;
  let mode: number | undefined;
  try {
    text = await Deno.readTextFile(writePath);
    mode = (await Deno.stat(writePath)).mode ?? undefined;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { writePath, settings: null, hooks: {} };
    }
    throw error;
  }

  let parsed: unknown = {};
  if (text.trim() !== "") {
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw markErrorPaths(
        new UserError(
          `${settingsPath} is not valid JSON (${
            error instanceof Error ? error.message : String(error)
          }); fix it and run the command again. The file was not changed.`,
        ),
        [settingsPath],
      );
    }
  }
  if (!isRecord(parsed)) {
    throw markErrorPaths(
      new UserError(
        `${settingsPath} does not hold a JSON object; fix it and run the command again. The file was not changed.`,
      ),
      [settingsPath],
    );
  }
  if (parsed.hooks !== undefined && !isRecord(parsed.hooks)) {
    throw markErrorPaths(
      new UserError(
        `${settingsPath} has a "hooks" value that is not an object; fix it and run the command again. The file was not changed.`,
      ),
      [settingsPath],
    );
  }
  return {
    writePath,
    settings: parsed,
    hooks: (parsed.hooks as Record<string, unknown> | undefined) ?? {},
    mode,
  };
}

async function saveSettings(
  loaded: LoadedSettings,
  settings: Record<string, unknown>,
): Promise<void> {
  const dir = dirname(loaded.writePath);
  await ensureDir(dir);
  const tmpPath = join(dir, `.settings.json.${crypto.randomUUID()}.tmp`);
  // a rename never leaves Claude Code reading a half-written settings file
  try {
    await Deno.writeTextFile(
      tmpPath,
      JSON.stringify(settings, null, 2) + "\n",
      loaded.mode === undefined ? undefined : { mode: loaded.mode & 0o777 },
    );
    await Deno.rename(tmpPath, loaded.writePath);
  } catch (error) {
    await Deno.remove(tmpPath).catch(() => {});
    throw error;
  }
}

export async function installClaudeUserAuditHook(
  homeDir: string,
): Promise<UserAuditHookResult> {
  const settingsPath = claudeUserSettingsPath(homeDir);
  const loaded = await loadSettings(settingsPath);
  const hooks = mergeAuditHooks(
    migrateLegacyClaudeAuditHooks(loaded.hooks),
    claudeAuditHooks(),
    CLAUDE_AUDIT_HOOK_SHAPE,
  );
  const changed = loaded.settings === null ||
    JSON.stringify(hooks) !== JSON.stringify(loaded.hooks);
  if (changed) await saveSettings(loaded, { ...loaded.settings, hooks });
  return { settingsPath, changed };
}

/** removes only entries equal to one swamp wrote; a user's own variant stays */
export async function removeClaudeUserAuditHook(
  homeDir: string,
): Promise<UserAuditHookResult> {
  const settingsPath = claudeUserSettingsPath(homeDir);
  const loaded = await loadSettings(settingsPath);
  if (loaded.settings === null) return { settingsPath, changed: false };

  const swampJson = new Set([
    ...Object.values(claudeAuditHooks()).flat().map((entry) =>
      JSON.stringify(entry)
    ),
    JSON.stringify(LEGACY_CLAUDE_AUDIT_HOOK_ENTRY),
  ]);
  const hooks: Record<string, unknown> = {};
  for (const [event, entries] of Object.entries(loaded.hooks)) {
    if (!Array.isArray(entries) || !(event in claudeAuditHooks())) {
      hooks[event] = entries;
      continue;
    }
    const kept = entries.filter((entry) =>
      !swampJson.has(JSON.stringify(entry))
    );
    if (kept.length > 0) hooks[event] = kept;
  }
  if (JSON.stringify(hooks) === JSON.stringify(loaded.hooks)) {
    return { settingsPath, changed: false };
  }

  const settings = { ...loaded.settings };
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;
  await saveSettings(loaded, settings);
  return { settingsPath, changed: true };
}

/** never throws: the doctor reports a missing or unreadable file as no hook */
export async function claudeUserAuditHookInstalled(
  homeDir: string,
): Promise<boolean> {
  try {
    const { hooks } = await loadSettings(claudeUserSettingsPath(homeDir));
    return Object.keys(claudeAuditHooks()).every((event) =>
      countAuditHooks(hooks[event], CLAUDE_AUDIT_HOOK_SHAPE) > 0
    );
  } catch {
    return false;
  }
}
