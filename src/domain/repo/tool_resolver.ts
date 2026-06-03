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

import {
  BUILT_IN_TOOL_NAMES,
  builtInToolConfig,
  customToolConfig,
  type CustomToolDefinition,
  isBuiltInTool,
  type ToolConfig,
} from "./custom_tool.ts";
import { UserError } from "../errors.ts";

export type CustomToolLoader = (
  repoDir: string,
) => Promise<CustomToolDefinition[]>;

export class ToolResolver {
  private customTools: CustomToolDefinition[] | null = null;

  constructor(
    private repoDir: string,
    private loadCustomToolsFn: CustomToolLoader,
  ) {}

  async resolve(name: string): Promise<ToolConfig> {
    if (isBuiltInTool(name)) {
      return builtInToolConfig(name);
    }

    const custom = await this.findCustomTool(name);
    if (custom) {
      return customToolConfig(custom);
    }

    const known = await this.allKnownNames();
    throw new UserError(
      `Unknown tool "${name}". Available tools: ${known.join(", ")}. ` +
        `Run \`swamp agent setup\` to define a custom tool.`,
    );
  }

  async isKnown(name: string): Promise<boolean> {
    if (isBuiltInTool(name)) return true;
    const custom = await this.findCustomTool(name);
    return custom !== undefined;
  }

  async allKnownNames(): Promise<string[]> {
    const customs = await this.loadCustomTools();
    return [
      ...BUILT_IN_TOOL_NAMES.filter((n) => n !== "none"),
      ...customs.map((c) => c.name),
    ];
  }

  private async findCustomTool(
    name: string,
  ): Promise<CustomToolDefinition | undefined> {
    const customs = await this.loadCustomTools();
    return customs.find((c) => c.name === name);
  }

  private async loadCustomTools(): Promise<CustomToolDefinition[]> {
    if (this.customTools === null) {
      this.customTools = await this.loadCustomToolsFn(this.repoDir);
    }
    return this.customTools;
  }
}
