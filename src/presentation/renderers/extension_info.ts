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

import type { EventHandlers, ExtensionInfoEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

function extractBasename(name: string): string {
  const slash = name.indexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

class LogExtensionInfoRenderer implements Renderer<ExtensionInfoEvent> {
  handlers(): EventHandlers<ExtensionInfoEvent> {
    const logger = getSwampLogger(["extension", "info"]);
    return {
      resolving: () => {},
      completed: (e) => {
        const d = e.data;

        logger.info`${d.name} (${d.latestVersion})`;
        logger.info`${d.description}`;
        logger.info``;

        if (d.author) {
          logger
            .info`Author:      ${d.author.displayName} (${d.author.username})`;
        }
        if (d.namespace) {
          logger.info`Collective:  ${d.namespace}`;
        }
        if (d.license) {
          logger.info`License:     ${d.license}`;
        }
        if (d.repository) {
          const verified = d.repositoryVerified ? " (verified)" : "";
          logger.info`Repository:  ${d.repository}${verified}`;
        }
        if (d.homepageUrl) {
          logger.info`Homepage:    ${d.homepageUrl}`;
        }

        logger.info``;

        if (d.platforms.length > 0) {
          logger.info`Platforms:   ${d.platforms.join(", ")}`;
        }
        if (d.labels.length > 0) {
          logger.info`Labels:      ${d.labels.join(", ")}`;
        }
        if (d.contentTypes.length > 0) {
          logger.info`Contents:    ${d.contentTypes.join(", ")}`;
        }
        if (d.contentNames.length > 0) {
          logger.info`Exports:     ${d.contentNames.join(", ")}`;
        }

        logger.info``;

        logger.info`Downloads:   ${d.pullCount}`;
        if (d.score) {
          logger.info`Quality:     ${d.score.grade} (${d.score.percentage}%)`;
        }

        logger.info``;

        logger.info`Created:     ${d.createdAt}`;
        logger.info`Updated:     ${d.updatedAt}`;

        if (d.yankedAt) {
          logger.info``;
          logger.warn`Yanked:      ${d.yankedAt}`;
          if (d.yankReason) {
            logger.warn`Reason:      ${d.yankReason}`;
          }
        }

        if (d.deprecatedAt) {
          logger.info``;
          logger.warn`Deprecated:  ${d.deprecatedAt}`;
          if (d.deprecationReason) {
            logger.warn`Reason:      ${d.deprecationReason}`;
          }
          if (d.supersededBy) {
            logger.warn`Superseded:  ${d.supersededBy}`;
          }
        }
      },
      not_found: (e) => {
        const basename = extractBasename(e.extensionName);
        throw new UserError(
          `Extension ${e.extensionName} not found in the registry.\nTry: swamp extension search ${basename}`,
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonExtensionInfoRenderer implements Renderer<ExtensionInfoEvent> {
  handlers(): EventHandlers<ExtensionInfoEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      not_found: (e) => {
        throw new UserError(
          `Extension ${e.extensionName} not found in the registry.`,
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createExtensionInfoRenderer(
  mode: OutputMode,
): Renderer<ExtensionInfoEvent> {
  switch (mode) {
    case "json":
      return new JsonExtensionInfoRenderer();
    case "log":
      return new LogExtensionInfoRenderer();
  }
}
