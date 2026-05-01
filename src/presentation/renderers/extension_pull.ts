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

import type {
  EventHandlers,
  ExtensionPullEvent,
  InstallResult,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

/** Extended renderer interface with conflict rendering support. */
export interface ExtensionPullRenderer extends Renderer<ExtensionPullEvent> {
  renderConflicts(conflicts: string[]): void;
}

function renderInstallResultLog(result: InstallResult): void {
  const logger = getSwampLogger(["extension", "pull"]);

  logger.info`Pulling ${result.name}@${result.version}`;
  if (result.description) {
    logger.info`Description: ${result.description}`;
  }

  if (result.integrityStatus === "verified") {
    logger.info`Identity verified: ${result.name}@${result.version}`;
  } else {
    logger
      .warn`No checksum available: ${result.name}@${result.version} (legacy extension)`;
  }

  if (result.repository) {
    logger.info`Repository: ${result.repository}`;
  }

  if (result.platforms.length > 0) {
    logger.warn`Platform hint: this extension declares support for ${
      result.platforms.join(", ")
    }`;
  }

  if (result.safetyWarnings.length > 0) {
    logger.warn`Safety warnings:`;
    for (const w of result.safetyWarnings) {
      logger.warn`  ${w.file}: ${w.message}`;
    }
  }

  if (result.missingSourceFiles.length > 0) {
    logger
      .warn`Extension has incomplete source files (${
      String(result.missingSourceFiles.length)
    } missing). The pre-built bundle will be used.`;
    logger
      .warn`To fix, ask the extension author to re-publish with swamp 20260316 or later.`;
    for (const f of result.missingSourceFiles) {
      logger.warn`  missing: ${f}`;
    }
  }

  logger.info`Pulled ${result.name}@${result.version}`;
  logger.info`Extracted ${result.extractedFiles.length} files:`;
  for (const f of result.extractedFiles) {
    logger.info`  ${f}`;
  }

  if (result.hasSkills) {
    const fileCount = String(result.skillFiles.length);
    logger
      .warn`This extension includes AI agent skills (${fileCount} files).`;
    logger
      .warn`Skills are loaded into your AI agent's context and may contain executable scripts.`;
    logger.warn`Review ALL skill files before use:`;
    for (const f of result.skillFiles) {
      logger.warn`  ${f}`;
    }
    if (result.hasSkillScripts) {
      logger
        .warn`This extension includes EXECUTABLE SCRIPTS in skills.`;
      logger
        .warn`These scripts can be run by your AI agent. Review them carefully.`;
    }
  }

  for (const depResult of result.dependencyResults) {
    logger.info`Pulling dependency ${depResult.name}@${depResult.version}`;
    renderInstallResultLog(depResult);
  }
}

function renderInstallResultJson(result: InstallResult): void {
  // Resolved info
  console.log(JSON.stringify(
    {
      name: result.name,
      version: result.version,
      description: result.description,
    },
    null,
    2,
  ));

  // Integrity
  console.log(JSON.stringify(
    {
      integrity: result.integrityStatus,
      name: result.name,
      version: result.version,
    },
    null,
    2,
  ));

  if (result.repository) {
    console.log(JSON.stringify({ repository: result.repository }, null, 2));
  }

  if (result.platforms.length > 0) {
    console.log(JSON.stringify({ platforms: result.platforms }, null, 2));
  }

  if (result.safetyWarnings.length > 0) {
    console.log(JSON.stringify({ warnings: result.safetyWarnings }, null, 2));
  }

  if (result.missingSourceFiles.length > 0) {
    console.log(
      JSON.stringify(
        { missingSourceFiles: result.missingSourceFiles },
        null,
        2,
      ),
    );
  }

  if (result.hasSkills) {
    console.log(JSON.stringify(
      {
        skillWarning: {
          message:
            "Extension includes AI agent skills that will be loaded into agent context. Review for prompt injection.",
          hasScripts: result.hasSkillScripts,
          skillFiles: result.skillFiles,
        },
      },
      null,
      2,
    ));
  }

  // Pull success
  console.log(JSON.stringify(
    {
      name: result.name,
      version: result.version,
      extractedFiles: result.extractedFiles,
    },
    null,
    2,
  ));

  for (const depResult of result.dependencyResults) {
    console.log(JSON.stringify(
      {
        status: "pulling_dependency",
        name: depResult.name,
        version: depResult.version,
      },
      null,
      2,
    ));
    renderInstallResultJson(depResult);
  }
}

class LogExtensionPullRenderer implements ExtensionPullRenderer {
  readonly #logger = getSwampLogger(["extension", "pull"]);

  handlers(): EventHandlers<ExtensionPullEvent> {
    return {
      installing: () => {},
      "orphans-pruned": (e) => {
        this.#logger
          .info`Removed ${
          String(e.paths.length)
        } file(s) no longer in ${e.name}@${e.version}:`;
        for (const p of e.paths) {
          this.#logger.info`  ${p}`;
        }
      },
      completed: (e) => {
        renderInstallResultLog(e.data);
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }

  renderConflicts(conflicts: string[]): void {
    this.#logger
      .warn`The following files already exist and will be overwritten:`;
    for (const c of conflicts) {
      this.#logger.warn`  ${c}`;
    }
  }
}

class JsonExtensionPullRenderer implements ExtensionPullRenderer {
  handlers(): EventHandlers<ExtensionPullEvent> {
    return {
      installing: () => {},
      "orphans-pruned": (e) => {
        console.log(JSON.stringify(
          {
            status: "orphans_pruned",
            name: e.name,
            version: e.version,
            paths: e.paths,
          },
          null,
          2,
        ));
      },
      completed: (e) => {
        renderInstallResultJson(e.data);
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }

  renderConflicts(conflicts: string[]): void {
    console.log(JSON.stringify({ conflicts }, null, 2));
  }
}

export function createExtensionPullRenderer(
  mode: OutputMode,
): ExtensionPullRenderer {
  switch (mode) {
    case "json":
      return new JsonExtensionPullRenderer();
    case "log":
      return new LogExtensionPullRenderer();
  }
}

/** Renders cancellation when user declines the prompt. */
export function renderExtensionPullCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ status: "cancelled" }));
  } else {
    const logger = getSwampLogger(["extension", "pull"]);
    logger.info("Pull cancelled.");
  }
}
