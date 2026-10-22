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

/**
 * Serve reports a v3 run's outcome only once the run's root has committed
 * (swamp-club#3759). A method run whose commit cannot reach the storage
 * sends no `completed` event, to the requesting socket or to a detached
 * run's followers, and answers with the error; one whose commit lands
 * sends `completed` and then `done`.
 */

import "../src/domain/models/models.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { COMMIT_UNREACHABLE_CODE } from "../src/domain/datastore_v3/commit_log_unit_of_work.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import type { ModelType } from "../src/domain/models/model_type.ts";
import {
  type ActiveRun,
  ActiveRunRegistry,
} from "../src/serve/active_run_registry.ts";
import type { BufferTerminal } from "../src/serve/run_event_buffer.ts";
import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import {
  createServeCtx,
  errorFrame,
  type Frame,
  sendRequest,
} from "./serve_request_harness.ts";
import type { RowRepos } from "./usecase_sync_fixtures.ts";
import {
  registerBigWriter,
  seedModel,
  withFaults,
} from "./v3_commit_fault_helpers.ts";

await initializeLogging({});

/** What a detached run's follower saw: event kinds, then the terminal. */
interface Followed {
  readonly events: string[];
  terminal?: BufferTerminal;
}

/** A registry that follows each run it registers, as an attached client. */
class FollowingRegistry extends ActiveRunRegistry {
  readonly followed: Followed[] = [];

  override register(run: ActiveRun): void {
    super.register(run);
    const followed: Followed = { events: [] };
    this.followed.push(followed);
    run.buffer.subscribe({
      onEvent: (_seq, event) => followed.events.push(event.kind),
      onTerminal: (terminal) => {
        followed.terminal = terminal;
      },
      onDetach: () => {},
    });
  }
}

/** A connection context over A's v3 checkout, as serve builds it. */
function v3ServeCtx(
  repos: RowRepos,
  registry?: ActiveRunRegistry,
): ConnectionContext {
  return {
    ...createServeCtx(
      repos.serveRepo,
      undefined,
      registry === undefined ? {} : { activeRunRegistry: registry },
    ),
    holdRepliesUntilCommitted: true,
  };
}

/** Runs `write` on a fresh big-writer model over serve. */
async function methodRun(
  repos: RowRepos,
  cut: boolean,
  registry?: ActiveRunRegistry,
): Promise<Frame[]> {
  const type: ModelType = registerBigWriter(cut);
  try {
    const name = `big-${crypto.randomUUID().slice(0, 8)}`;
    await seedModel(repos, type, name);
    return await sendRequest(v3ServeCtx(repos, registry), {
      type: "model.method.run",
      id: crypto.randomUUID(),
      payload: { modelIdOrName: name, methodName: "write" },
    });
  } finally {
    modelRegistry.invalidateType(type);
  }
}

/** The kinds of the run events among `frames`, in order. */
function eventKinds(frames: Frame[]): string[] {
  return frames
    .filter((frame) => frame.type === "event")
    .map((frame) => (frame.event as { kind: string }).kind);
}

Deno.test({
  name:
    "serve v3 outcome after commit: a method run whose commit cannot reach the storage sends no completed event, only the error (swamp-club#3759)",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withFaults(async (repos) => {
      const frames = await methodRun(repos, true);
      assert(!eventKinds(frames).includes("completed"), JSON.stringify(frames));
      assert(
        !frames.some((frame) => frame.type === "done"),
        JSON.stringify(frames),
      );
      const error = errorFrame(frames)?.error;
      assertEquals(
        error?.code,
        COMMIT_UNREACHABLE_CODE,
        JSON.stringify(frames),
      );
      assertStringIncludes(error?.message ?? "", "steps had already run");
    });
  },
});

Deno.test({
  name:
    "serve v3 outcome after commit: a method run whose commit lands sends completed, then done (swamp-club#3759)",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withFaults(async (repos) => {
      const frames = await methodRun(repos, false);
      assertEquals(errorFrame(frames), undefined, JSON.stringify(frames));
      const types = frames.map((frame) =>
        frame.type === "event"
          ? `event:${(frame.event as { kind: string }).kind}`
          : frame.type
      );
      const completed = types.indexOf("event:completed");
      assert(completed >= 0, types.join(", "));
      assert(types.indexOf("done") > completed, types.join(", "));
    });
  },
});

Deno.test({
  name:
    "serve v3 outcome after commit: a detached method run whose commit cannot reach the storage shows its followers no completed event, then the error (swamp-club#3759)",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withFaults(async (repos) => {
      const registry = new FollowingRegistry();
      await methodRun(repos, true, registry);
      assertEquals(registry.followed.length, 1);
      const [followed] = registry.followed;
      assert(
        !followed.events.includes("completed"),
        followed.events.join(", "),
      );
      const terminal = followed.terminal;
      assert(terminal?.kind === "error", JSON.stringify(terminal));
      assertEquals(terminal.code, COMMIT_UNREACHABLE_CODE);
      assertStringIncludes(terminal.message, "steps had already run");
    });
  },
});

Deno.test({
  name:
    "serve v3 outcome after commit: a detached method run whose commit lands shows its followers completed, then done (swamp-club#3759)",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withFaults(async (repos) => {
      const registry = new FollowingRegistry();
      await methodRun(repos, false, registry);
      assertEquals(registry.followed.length, 1);
      const [followed] = registry.followed;
      assert(
        followed.events.includes("completed"),
        followed.events.join(", "),
      );
      assertEquals(followed.terminal?.kind, "done");
    });
  },
});
