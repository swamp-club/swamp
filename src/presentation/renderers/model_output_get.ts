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
  ModelOutputGetData,
  ModelOutputGetEvent,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";

class LogModelOutputGetRenderer implements Renderer<ModelOutputGetEvent> {
  handlers(): EventHandlers<ModelOutputGetEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonModelOutputGetRenderer implements Renderer<ModelOutputGetEvent> {
  handlers(): EventHandlers<ModelOutputGetEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createModelOutputGetRenderer(
  mode: OutputMode,
): Renderer<ModelOutputGetEvent> {
  switch (mode) {
    case "json":
      return new JsonModelOutputGetRenderer();
    case "log":
      return new LogModelOutputGetRenderer();
  }
}

/** Standalone render function for use by un-migrated search commands. */
export function renderModelOutputGet(
  data: ModelOutputGetData,
  mode: OutputMode,
): void {
  const renderer = createModelOutputGetRenderer(mode);
  const handlers = renderer.handlers();
  handlers.completed({ kind: "completed", data });
}
