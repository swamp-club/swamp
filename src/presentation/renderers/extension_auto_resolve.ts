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

import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["extension", "auto-resolve"]);

/**
 * Renders a searching message when auto-resolution begins.
 */
export function renderAutoResolveSearching(
  type: string,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(
      JSON.stringify({ event: "auto_resolve", status: "searching", type }),
    );
  } else {
    logger
      .info`Extension type ${type} not found locally, searching registry...`;
  }
}

/**
 * Renders a message when an extension is found and about to be installed.
 */
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
    logger.info`Found extension ${extension}${
      description ? ` (${description})` : ""
    }`;
    logger.info`Installing ${extension}@${version}...`;
  }
}

/**
 * Renders a message when an extension has been installed and models registered.
 */
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
    logger
      .info`Installed ${extension}@${version} (${modelsRegistered} models registered)`;
  }
}

/**
 * Renders an error message when auto-resolution fails because no extension was found.
 */
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
    logger
      .error`Auto-resolution failed for type ${type}: no matching extension found in registry.`;
    logger.error`Install manually with: swamp extension pull <extension-name>`;
  }
}

/**
 * Renders an error message when auto-resolution finds the extension
 * on disk but refuses to re-install it (issue #121). The user likely
 * has local edits preventing the type from registering; they must
 * either fix the source or opt in to discarding edits via an explicit
 * `extension pull --force`.
 */
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
    logger
      .error`Extension ${extension} is already installed at ${path} but failed to load.`;
    logger
      .error`Local edits may be preventing it from registering — inspect the source and fix errors.`;
    logger
      .error`To reset to the registry version and discard local changes, run: swamp extension pull ${extension} --force`;
  }
}

/**
 * Renders an error message when auto-resolution fails due to a network error.
 */
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
    logger.error`Auto-resolution failed for type ${type}: ${error}`;
    logger.error`Install manually with: swamp extension pull <extension-name>`;
  }
}
