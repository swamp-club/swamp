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
  ExtensionQualityEvent,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Renderer interface that also reports pass/fail to the CLI. */
export interface ExtensionQualityRenderer
  extends Renderer<ExtensionQualityEvent> {
  passed(): boolean;
  failureMessage(): string;
}

class LogExtensionQualityRenderer implements ExtensionQualityRenderer {
  private _passed = true;
  private _failureMessage = "";

  passed(): boolean {
    return this._passed;
  }

  failureMessage(): string {
    return this._failureMessage;
  }

  handlers(): EventHandlers<ExtensionQualityEvent> {
    const logger = getSwampLogger(["extension", "quality"]);
    return {
      packaging: () => {
        logger.info("Packaging extension for quality scoring...");
      },
      cache_hit: (e) => {
        logger.info`Cache hit — reusing previously packaged tarball (${
          e.hash.slice(0, 12)
        })`;
      },
      scoring: () => {
        logger.info("Scoring extension against Swamp Club quality rubric...");
      },
      completed: (e) => {
        const { score, archiveSize } = e.data;
        logger
          .info`Rubric v${score.rubricVersion} — ${score.earnedPoints}/${score.maxEarnablePoints} points (${score.percentage}%, ${
          score.allPassed ? "all factors earned" : "some factors missing"
        })`;
        for (const factor of score.factors) {
          const mark = factor.status === "earned" ? "✓" : "✗";
          const pts = `${factor.earnedPoints}/${factor.maxPoints}`;
          logger.info`  ${mark} ${factor.id} [${pts}] — ${factor.label}`;
          if (factor.id === "fast-check") {
            logger
              .info`      ℹ This factor is deprecated and will be removed in a future release.`;
          }
          if (factor.status !== "earned" && factor.remediation) {
            logger.info`      → ${factor.remediation}`;
          }
        }
        const { dependencyTrustResult } = e.data;
        if (dependencyTrustResult.audited.length > 0) {
          for (const dep of dependencyTrustResult.audited) {
            const mark = dep.passed ? "✓" : "✗";
            const parts: string[] = [];
            if (dep.registry === "jsr") {
              parts.push("jsr (trusted)");
            } else {
              if (dep.license) parts.push(dep.license);
              if (dep.weeklyDownloads !== null) {
                parts.push(`${formatDownloads(dep.weeklyDownloads)}/week`);
              }
              if (dep.publishedAgo) parts.push(dep.publishedAgo);
            }
            const detail = parts.length > 0 ? ` — ${parts.join(", ")}` : "";
            logger.info`      ${mark} ${dep.name}@${dep.version}${detail}`;
          }
        } else {
          logger.info`      No npm/jsr dependencies to audit`;
        }
        if (dependencyTrustResult.errors.length > 0) {
          logger.error`Dependency trust blockers (push blocked):`;
          for (const err of dependencyTrustResult.errors) {
            logger.error`  ${err.dependency}: ${err.message}`;
          }
        }
        if (dependencyTrustResult.warnings.length > 0) {
          logger.warn`Dependency trust warnings (non-blocking):`;
          for (const w of dependencyTrustResult.warnings) {
            logger.warn`  ${w.dependency}: ${w.message}`;
          }
        }
        // `repository-verified` is a structural check on our side — the
        // server does the final HTTP HEAD to confirm the repo is public.
        // Surface that caveat so users know why their local "earned"
        // could still come back "missing" from the registry.
        logger
          .info`Note: \`repository-verified\` earns here when the URL is well-formed on an allowlisted host; the registry does the final public-reachable check on publish.`;
        logger.info`Packaged archive: ${archiveSize} bytes`;
        if (!score.allPassed) {
          this._passed = false;
          const missing = score.factors
            .filter((f) => f.status !== "earned")
            .map((f) => f.id)
            .join(", ");
          this._failureMessage =
            `Quality rubric factors missing: ${missing}. See messages above for remediation.`;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonExtensionQualityRenderer implements ExtensionQualityRenderer {
  private _passed = true;
  private _failureMessage = "";

  passed(): boolean {
    return this._passed;
  }

  failureMessage(): string {
    return this._failureMessage;
  }

  handlers(): EventHandlers<ExtensionQualityEvent> {
    return {
      packaging: () => {},
      cache_hit: () => {},
      scoring: () => {},
      completed: (e) => {
        const {
          score,
          cacheHash,
          archiveSize,
          cacheHit,
          dependencyTrustResult,
        } = e.data;
        console.log(JSON.stringify(
          {
            status: score.allPassed ? "passed" : "failed",
            rubricVersion: score.rubricVersion,
            earnedPoints: score.earnedPoints,
            maxEarnablePoints: score.maxEarnablePoints,
            percentage: score.percentage,
            allPassed: score.allPassed,
            factors: score.factors,
            dependencyTrust: {
              passed: dependencyTrustResult.passed,
              audited: dependencyTrustResult.audited,
              errors: dependencyTrustResult.errors,
              warnings: dependencyTrustResult.warnings,
            },
            cacheHash,
            archiveSize,
            cacheHit,
          },
          null,
          2,
        ));
        if (!score.allPassed) {
          this._passed = false;
          const missing = score.factors
            .filter((f) => f.status !== "earned")
            .map((f) => f.id)
            .join(", ");
          this._failureMessage = `Quality rubric factors missing: ${missing}.`;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createExtensionQualityRenderer(
  mode: OutputMode,
): ExtensionQualityRenderer {
  switch (mode) {
    case "json":
      return new JsonExtensionQualityRenderer();
    case "log":
      return new LogExtensionQualityRenderer();
  }
}
