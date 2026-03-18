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
  VaultDescribeData,
  VaultDescribeEvent,
} from "../../libswamp/mod.ts";
import type { VaultConfig } from "../../domain/vaults/vault_config.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";

class LogVaultDescribeRenderer implements Renderer<VaultDescribeEvent> {
  handlers(): EventHandlers<VaultDescribeEvent> {
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

class JsonVaultDescribeRenderer implements Renderer<VaultDescribeEvent> {
  handlers(): EventHandlers<VaultDescribeEvent> {
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

export function createVaultDescribeRenderer(
  mode: OutputMode,
): Renderer<VaultDescribeEvent> {
  switch (mode) {
    case "json":
      return new JsonVaultDescribeRenderer();
    case "log":
      return new LogVaultDescribeRenderer();
  }
}

/**
 * Standalone render function for use by un-migrated search commands.
 * Accepts a VaultConfig domain object for backward compatibility.
 */
export function renderVaultDescribe(
  config: VaultConfig,
  mode: OutputMode,
): void {
  const data: VaultDescribeData = config.toData();
  const renderer = createVaultDescribeRenderer(mode);
  const handlers = renderer.handlers();
  handlers.completed({ kind: "completed", data });
}
