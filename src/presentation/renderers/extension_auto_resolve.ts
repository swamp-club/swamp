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

import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import {
  gutterLine,
  STATUS_COLORS,
  writeContentLine,
} from "../output/console_writer.ts";

export function renderAutoResolveSearching(
  type: string,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(
      JSON.stringify({ event: "auto_resolve", status: "searching", type }),
    );
  } else {
    writeOutput(
      gutterLine(
        "Resolving",
        STATUS_COLORS.info,
        `${type} not found locally, searching registry...`,
      ),
    );
  }
}

export function renderAutoResolveInstalling(
  extension: string,
  version: string,
  description: string | undefined,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(
      JSON.stringify({
        event: "auto_resolve",
        status: "installing",
        extension,
        version,
      }),
    );
  } else {
    writeOutput(
      gutterLine(
        "Installing",
        STATUS_COLORS.info,
        `${extension}@${version}${description ? ` (${description})` : ""}`,
      ),
    );
  }
}

export function renderAutoResolveInstalled(
  extension: string,
  version: string,
  modelsRegistered: number,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(
      JSON.stringify({
        event: "auto_resolve",
        status: "installed",
        extension,
        version,
        modelsRegistered,
      }),
    );
  } else {
    writeOutput(
      gutterLine(
        "Installed",
        STATUS_COLORS.success,
        `${extension}@${version} (${modelsRegistered} models registered)`,
      ),
    );
  }
}

export function renderAutoResolveNotFound(
  type: string,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(
      JSON.stringify({
        event: "auto_resolve",
        status: "failed",
        type,
        reason: "not_found",
      }),
    );
  } else {
    writeOutput(
      gutterLine(
        "Error",
        STATUS_COLORS.error,
        `auto-resolution failed for type ${type}: no extension publishes this type`,
      ),
    );
    writeContentLine(
      `Install manually with: swamp extension pull <extension-name>`,
    );
  }
}

export function renderAutoResolveAlreadyInstalled(
  extension: string,
  path: string,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(
      JSON.stringify({
        event: "auto_resolve",
        status: "failed",
        extension,
        path,
        reason: "already_installed",
      }),
    );
  } else {
    writeOutput(
      gutterLine(
        "Error",
        STATUS_COLORS.error,
        `${extension} already installed at ${path} but failed to load`,
      ),
    );
    writeContentLine(
      "Local edits may be preventing it from registering — inspect the source and fix errors.",
    );
    writeContentLine(
      `To reset: swamp extension pull "${extension}" --force`,
    );
  }
}

export function renderAutoResolveTruncated(
  extension: string,
  path: string,
  missing: string[],
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(
      JSON.stringify({
        event: "auto_resolve",
        status: "failed",
        extension,
        path,
        reason: "truncated",
        missing,
      }),
    );
  } else {
    const list = missing.length > 5
      ? `${missing.slice(0, 5).join(", ")}, ... and ${missing.length - 5} more`
      : missing.join(", ");
    writeOutput(
      gutterLine(
        "Error",
        STATUS_COLORS.error,
        `${extension} at ${path} is incomplete — missing ${missing.length} file(s): ${list}`,
      ),
    );
    writeContentLine(
      `To re-fetch and repair: swamp extension pull ${extension} --force`,
    );
  }
}

export function renderAutoResolveCollectiveNotTrusted(
  collective: string,
  type: string,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(
      JSON.stringify({
        event: "auto_resolve",
        status: "failed",
        type,
        reason: "collective_not_trusted",
        collective,
      }),
    );
  } else {
    writeOutput(
      gutterLine(
        "Warning",
        STATUS_COLORS.warn,
        `${type} is from collective "${collective}", which is not trusted`,
      ),
    );
    writeContentLine(
      `To allow: swamp extension trust add "${collective}"`,
    );
  }
}

export function renderAutoResolveNetworkError(
  type: string,
  error: string,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(
      JSON.stringify({
        event: "auto_resolve",
        status: "failed",
        type,
        reason: "network_error",
        error,
      }),
    );
  } else {
    writeOutput(
      gutterLine(
        "Error",
        STATUS_COLORS.error,
        `auto-resolution failed for type ${type}: ${error}`,
      ),
    );
    writeContentLine(
      `Install manually with: swamp extension pull <extension-name>`,
    );
  }
}

export function renderAutoResolveNoStableVersion(
  extension: string,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(
      JSON.stringify({
        event: "auto_resolve",
        status: "failed",
        extension,
        reason: "no_stable_version",
      }),
    );
  } else {
    writeOutput(
      gutterLine(
        "Warning",
        STATUS_COLORS.warn,
        `${extension} has no stable version and cannot be auto-resolved`,
      ),
    );
    writeContentLine(
      `Install manually: swamp extension pull ${extension} --channel <rc|beta>`,
    );
  }
}
