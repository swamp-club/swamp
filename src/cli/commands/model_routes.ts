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

import type { AnyCommand } from "../cli_schema.ts";
import type { CommandRoute } from "../command_routes.ts";
import type { CommandSurface } from "../../presentation/command_surface.ts";

/** a subcommand both spellings route to; each load builds a fresh instance for its surface */
interface SharedRoute {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly hidden: boolean;
  readonly module: string;
  build(surface: CommandSurface, rest: readonly string[]): Promise<AnyCommand>;
}

function bySurface<T>(surface: CommandSurface, behavior: T, model: T): T {
  return surface === "behavior" ? behavior : model;
}

const run: SharedRoute = {
  name: "run",
  aliases: [],
  hidden: false,
  module: "src/cli/commands/model_method_run.ts",
  build: async (surface) => {
    const m = await import("./model_method_run.ts");
    return m.createModelMethodRunCommand(
      bySurface(surface, m.BEHAVIOR_RUN_SYNTAX, m.MODEL_METHOD_RUN_SYNTAX),
    );
  },
};

const create: SharedRoute = {
  name: "create",
  aliases: [],
  hidden: false,
  module: "src/cli/commands/model_create.ts",
  build: async (surface) => {
    const m = await import("./model_create.ts");
    return m.createModelCreateCommand(
      bySurface(surface, m.BEHAVIOR_CREATE_SYNTAX, m.MODEL_CREATE_SYNTAX),
    );
  },
};

const get: SharedRoute = {
  name: "get",
  aliases: [],
  hidden: false,
  module: "src/cli/commands/model_get.ts",
  build: async (surface) => {
    const m = await import("./model_get.ts");
    return m.createModelGetCommand(
      bySurface(surface, m.BEHAVIOR_GET_SYNTAX, m.MODEL_GET_SYNTAX),
    );
  },
};

const edit: SharedRoute = {
  name: "edit",
  aliases: [],
  hidden: false,
  module: "src/cli/commands/model_edit.ts",
  build: async (surface) => {
    const m = await import("./model_edit.ts");
    return m.createModelEditCommand(
      bySurface(surface, m.BEHAVIOR_EDIT_SYNTAX, m.MODEL_EDIT_SYNTAX),
    );
  },
};

const del: SharedRoute = {
  name: "delete",
  aliases: [],
  hidden: false,
  module: "src/cli/commands/model_delete.ts",
  build: async (surface) => {
    const m = await import("./model_delete.ts");
    return m.createModelDeleteCommand(
      bySurface(surface, m.BEHAVIOR_DELETE_SYNTAX, m.MODEL_DELETE_SYNTAX),
    );
  },
};

const validate: SharedRoute = {
  name: "validate",
  aliases: [],
  hidden: false,
  module: "src/cli/commands/model_validate.ts",
  build: async (surface) => {
    const m = await import("./model_validate.ts");
    return m.createModelValidateCommand(
      bySurface(surface, m.BEHAVIOR_VALIDATE_SYNTAX, m.MODEL_VALIDATE_SYNTAX),
    );
  },
};

const evaluate: SharedRoute = {
  name: "evaluate",
  aliases: [],
  hidden: false,
  module: "src/cli/commands/model_evaluate.ts",
  build: async (surface) => {
    const m = await import("./model_evaluate.ts");
    return m.createModelEvaluateCommand(
      bySurface(surface, m.BEHAVIOR_EVALUATE_SYNTAX, m.MODEL_EVALUATE_SYNTAX),
    );
  },
};

const search: SharedRoute = {
  name: "search",
  aliases: ["list"],
  hidden: false,
  module: "src/cli/commands/model_search.ts",
  build: async (surface) => {
    const m = await import("./model_search.ts");
    return m.createModelSearchCommand(
      bySurface(surface, m.BEHAVIOR_SEARCH_SYNTAX, m.MODEL_SEARCH_SYNTAX),
    );
  },
};

const cancel: SharedRoute = {
  name: "cancel",
  aliases: [],
  hidden: false,
  module: "src/cli/commands/model_cancel.ts",
  build: async (surface) => {
    const m = await import("./model_cancel.ts");
    return m.createModelCancelCommand(
      bySurface(surface, m.BEHAVIOR_CANCEL_SYNTAX, m.MODEL_CANCEL_SYNTAX),
    );
  },
};

const lease: SharedRoute = {
  name: "lease",
  aliases: [],
  hidden: false,
  module: "src/cli/commands/model_lease.ts",
  build: async (surface) => {
    const m = await import("./model_lease.ts");
    return m.createModelLeaseCommand(
      bySurface(surface, m.BEHAVIOR_LEASE_SYNTAX, m.MODEL_LEASE_SYNTAX),
    );
  },
};

const describe: SharedRoute = {
  name: "describe",
  aliases: [],
  hidden: false,
  module: "src/cli/commands/model_method_describe.ts",
  build: async (surface) => {
    const m = await import("./model_method_describe.ts");
    return m.createModelMethodDescribeCommand(
      bySurface(
        surface,
        m.BEHAVIOR_DESCRIBE_SYNTAX,
        m.MODEL_METHOD_DESCRIBE_SYNTAX,
      ),
    );
  },
};

const history: SharedRoute = {
  name: "history",
  aliases: [],
  hidden: false,
  module: "src/cli/commands/model_method_history.ts",
  build: async (surface) => {
    const m = await import("./model_method_history.ts");
    return surface === "behavior"
      ? m.createModelMethodHistoryCommand(m.BEHAVIOR_HISTORY_SYNTAX)
      : m.createLegacyModelMethodHistoryCommand();
  },
};

const output: SharedRoute = {
  name: "output",
  aliases: [],
  hidden: false,
  module: "src/cli/commands/model_output.ts",
  build: async (surface) => {
    const m = await import("./model_output.ts");
    return surface === "behavior"
      ? m.createModelOutputCommand(m.BEHAVIOR_OUTPUT_SYNTAX)
      : m.createLegacyModelOutputCommand();
  },
};

const type: SharedRoute = {
  name: "type",
  aliases: [],
  hidden: false,
  module: "src/cli/commands/model_type.ts",
  build: async (surface) => {
    const m = await import("./model_type.ts");
    return surface === "behavior"
      ? m.createModelTypeCommand(m.BEHAVIOR_TYPE_SYNTAX)
      : m.createLegacyModelTypeCommand();
  },
};

const method: SharedRoute = {
  name: "method",
  aliases: [],
  hidden: false,
  module: "src/cli/commands/model_method.ts",
  build: async (_surface, rest) =>
    (await import("./model_method.ts")).createModelMethodCommand(rest),
};

function bind(
  surface: CommandSurface,
  rows: readonly SharedRoute[],
): readonly CommandRoute[] {
  return rows.map(({ name, aliases, hidden, module, build }) => ({
    name,
    aliases,
    hidden,
    module,
    needsFullTree: false,
    load: (rest) => build(surface, rest),
  }));
}

// each table keeps its spelling's registration order, which help lists
export const BEHAVIOR_ROUTES: readonly CommandRoute[] = bind("behavior", [
  run,
  create,
  get,
  edit,
  del,
  validate,
  evaluate,
  search,
  cancel,
  lease,
  describe,
  history,
  output,
  type,
]);

export const MODEL_ROUTES: readonly CommandRoute[] = bind("model", [
  cancel,
  create,
  del,
  edit,
  evaluate,
  get,
  lease,
  search,
  validate,
  method,
  output,
  type,
]);

export const MODEL_METHOD_ROUTES: readonly CommandRoute[] = bind("model", [
  run,
  describe,
  history,
]);
