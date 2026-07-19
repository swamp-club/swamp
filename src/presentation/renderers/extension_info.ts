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

import type {
  EventHandlers,
  ExtensionContentMetadata,
  ExtensionInfoEvent,
  ExtractedExtension,
  ExtractedModel,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

function extractBasename(name: string): string {
  const slash = name.indexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

function renderContentMetadata(
  logger: ReturnType<typeof getSwampLogger>,
  meta: ExtensionContentMetadata,
  verbose: boolean,
): void {
  if (meta.models.length > 0) {
    logger.info``;
    logger.info`Models (${meta.models.length}):`;
    for (const model of meta.models) {
      const methods = model.methods.map((m) => m.name).join(", ");
      const name = model.type || model.fileName;
      logger.info`  ${name} — methods: ${methods || "none"}`;
      if (verbose) {
        renderModelDetail(logger, model);
      }
    }
  }

  if (meta.extensions && meta.extensions.length > 0) {
    logger.info``;
    logger.info`Extends (${meta.extensions.length}):`;
    for (const ext of meta.extensions) {
      const methods = ext.methods.map((m) => m.name).join(", ");
      logger.info`  ${ext.extendsType} — methods: ${methods || "none"}`;
      if (verbose) {
        renderExtensionDetail(logger, ext);
      }
    }
  }

  if (meta.workflows.length > 0) {
    logger.info``;
    logger.info`Workflows (${meta.workflows.length}):`;
    for (const wf of meta.workflows) {
      logger.info`  ${wf.name} — ${wf.description || wf.id}`;
    }
  }

  if (meta.vaults.length > 0) {
    logger.info``;
    logger.info`Vaults (${meta.vaults.length}):`;
    for (const v of meta.vaults) {
      logger.info`  ${v.type} — ${v.description || v.name}`;
    }
  }

  if (meta.datastores.length > 0) {
    logger.info``;
    logger.info`Datastores (${meta.datastores.length}):`;
    for (const ds of meta.datastores) {
      logger.info`  ${ds.type} — ${ds.description || ds.name}`;
    }
  }

  if (meta.drivers.length > 0) {
    logger.info``;
    logger.info`Drivers (${meta.drivers.length}):`;
    for (const drv of meta.drivers) {
      logger.info`  ${drv.type} — ${drv.description || drv.name}`;
    }
  }

  if (meta.reports.length > 0) {
    logger.info``;
    logger.info`Reports (${meta.reports.length}):`;
    for (const r of meta.reports) {
      logger.info`  ${r.name} — ${r.description} (${r.scope})`;
    }
  }

  if (meta.skills.length > 0) {
    logger.info``;
    logger.info`Skills (${meta.skills.length}):`;
    for (const s of meta.skills) {
      logger.info`  ${s.name} — ${s.description}`;
    }
  }
}

function renderModelDetail(
  logger: ReturnType<typeof getSwampLogger>,
  model: ExtractedModel,
): void {
  for (const method of model.methods) {
    const args = method.arguments
      .map((a) => `${a.name}${a.required ? "" : "?"}:${a.type}`)
      .join(", ");
    logger.info`    ${method.name}(${args})`;
    if (method.description) {
      logger.info`      ${method.description}`;
    }
  }
}

function renderExtensionDetail(
  logger: ReturnType<typeof getSwampLogger>,
  ext: ExtractedExtension,
): void {
  for (const method of ext.methods) {
    const args = method.arguments
      .map((a) => `${a.name}${a.required ? "" : "?"}:${a.type}`)
      .join(", ");
    logger.info`    ${method.name}(${args})`;
    if (method.description) {
      logger.info`      ${method.description}`;
    }
  }
}

class LogExtensionInfoRenderer implements Renderer<ExtensionInfoEvent> {
  #verbose: boolean;

  constructor(verbose: boolean) {
    this.#verbose = verbose;
  }

  handlers(): EventHandlers<ExtensionInfoEvent> {
    const logger = getSwampLogger(["extension", "info"]);
    const verbose = this.#verbose;
    return {
      resolving: () => {},
      completed: (e) => {
        const d = e.data;

        const versionLabel = d.latestVersion ??
          (d.latestRc ? `rc: ${d.latestRc}` : null) ??
          (d.latestBeta ? `beta: ${d.latestBeta}` : null) ??
          "prerelease only";
        logger.info`${d.name} (${versionLabel})`;
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

        if (d.dependencies.length > 0) {
          logger.info``;
          logger
            .info`Dependencies: ${d.dependencies.join(", ")}`;
          logger
            .info`  Models from these extensions may be invoked via context.runModel()`;
        }

        if (d.contentMetadata) {
          renderContentMetadata(logger, d.contentMetadata, verbose);
        }

        logger.info``;

        if (d.latestRc) {
          logger.info`Latest RC:   ${d.latestRc}`;
        }
        if (d.latestBeta) {
          logger.info`Latest Beta: ${d.latestBeta}`;
        }

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
  verbose = false,
): Renderer<ExtensionInfoEvent> {
  switch (mode) {
    case "json":
      return new JsonExtensionInfoRenderer();
    case "log":
      return new LogExtensionInfoRenderer(verbose);
  }
}
