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

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  type HubLink,
  type HubLinkInstance,
  INSTANCE_ALIVE_WINDOW_MS,
  isInstanceAlive,
} from "../../domain/serve/hub_link.ts";

export interface HubForgetDeps {
  readonly links: {
    readLink(): Promise<HubLink>;
    listInstances(): Promise<HubLinkInstance[]>;
    clear(): Promise<void>;
  };
  readonly credentials: { delete(): Promise<void> };
  readonly now?: () => number;
}

export interface HubForgetData {
  /** false when there was no link to forget */
  readonly forgot: boolean;
  readonly hubUrl: string | null;
  readonly memberName: string | null;
}

export type HubForgetEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: HubForgetData }
  | { kind: "error"; error: SwampError };

export const SERVE_RUNNING_CODE = "serve_running";

/** clears the link and the credential, refused while a serve on this link is running */
export async function* hubForget(
  _ctx: LibSwampContext,
  deps: HubForgetDeps,
): AsyncGenerator<HubForgetEvent> {
  yield* withGeneratorSpan(
    "swamp.serve.hub.forget",
    {},
    (async function* (): AsyncGenerator<HubForgetEvent> {
      yield { kind: "resolving" };
      try {
        const now = (deps.now ?? Date.now)();
        const running = (await deps.links.listInstances()).filter((instance) =>
          isInstanceAlive(instance, now)
        );
        if (running.length > 0) {
          const minutes = INSTANCE_ALIVE_WINDOW_MS / 60_000;
          yield {
            kind: "error",
            error: {
              code: SERVE_RUNNING_CODE,
              message:
                `A serve for this repository checked in within the last ${minutes} minutes (${
                  plural(running.length, "instance")
                }). Stop it first. If it stopped without shutting down, wait ${minutes} minutes and retry.`,
            },
          };
          return;
        }
        // best effort: forget is how a link record that no longer parses is cleared
        const link = await deps.links.readLink().catch(() => undefined);
        // the credential first: a link left without one is refused, never used
        await deps.credentials.delete();
        await deps.links.clear();
        yield {
          kind: "completed",
          data: {
            forgot: link === undefined || link.state !== "unjoined",
            hubUrl: link?.hubUrl ?? null,
            memberName: link?.memberName ?? null,
          },
        };
      } catch (error) {
        yield {
          kind: "error",
          error: {
            code: "hub_forget_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    })(),
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
