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

import {
  AuditService,
  type AuditTimeline,
  type AuditTimelineOptions,
} from "../../domain/audit/audit_service.ts";
import { JsonlAuditRepository } from "../../infrastructure/persistence/jsonl_audit_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structure for the audit timeline output.
 */
export type AuditTimelineData =
  | { status: "timeline"; timeline: AuditTimeline }
  | { status: "no_data" }
  | { status: "tool_not_supported"; tool: string };

export type AuditTimelineEvent =
  | { kind: "completed"; data: AuditTimelineData }
  | { kind: "error"; error: SwampError };

/** Input for the audit timeline operation. */
export interface AuditTimelineInput {
  hours: number;
  showAll: boolean;
  sessionId?: string;
  tool: string;
}

/** Dependencies for the audit timeline operation. */
export interface AuditTimelineDeps {
  getTimeline: (options: AuditTimelineOptions) => Promise<AuditTimeline>;
}

/** Wires real infrastructure into AuditTimelineDeps. */
export function createAuditTimelineDeps(repoDir: string): AuditTimelineDeps {
  const auditRepository = new JsonlAuditRepository(repoDir);
  const service = new AuditService(auditRepository);
  return {
    getTimeline: (options) => service.getTimeline(options),
  };
}

/** Retrieves the audit timeline of swamp vs direct CLI commands. */
export async function* auditTimeline(
  ctx: LibSwampContext,
  deps: AuditTimelineDeps,
  input: AuditTimelineInput,
): AsyncIterable<AuditTimelineEvent> {
  yield* withGeneratorSpan(
    "swamp.audit.timeline",
    {},
    (async function* () {
      ctx.logger.debug`Fetching audit timeline`;

      // Check if the configured tool supports audit hooks
      if (input.tool === "codex") {
        yield {
          kind: "completed",
          data: { status: "tool_not_supported", tool: input.tool },
        };
        return;
      }

      const timeline = await deps.getTimeline({
        hours: input.hours,
        showAll: input.showAll,
        sessionId: input.sessionId,
      });

      if (
        timeline.entries.length === 0 && timeline.totalSwamp === 0 &&
        timeline.totalDirect === 0
      ) {
        yield { kind: "completed", data: { status: "no_data" } };
        return;
      }

      yield {
        kind: "completed",
        data: { status: "timeline", timeline },
      };
    })(),
  );
}
