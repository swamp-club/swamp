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
 * Chooses how the eval generators reach the model: the Anthropic Messages API
 * (CI, and every non-Anthropic provider) or the Claude Code CLI (`claude -p`),
 * which runs on a claude.ai login and needs no ANTHROPIC_API_KEY.
 */

export type Route = "api" | "cli";

export const ROUTES: readonly Route[] = ["api", "cli"];

interface CliModel {
  /** Passed to `claude --model`; an alias resolves to the latest model. */
  model: string;
  /** Passed to `claude --effort`; the CLI's counterpart of thinking budget. */
  effort: string;
}

/** Aliases the CLI route supports. Fable and non-Anthropic models are API-only. */
export const CLI_MODELS: Readonly<Record<string, CliModel>> = {
  sonnet: { model: "sonnet", effort: "low" },
  opus: { model: "opus", effort: "medium" },
};

/**
 * The route used when `--route` is not given: the API in GitHub Actions, where
 * the CI secrets live, and the CLI everywhere else for models that support it.
 */
export function defaultRoute(
  alias: string,
  env: { GITHUB_ACTIONS?: string },
): Route {
  if (env.GITHUB_ACTIONS) return "api";
  return alias in CLI_MODELS ? "cli" : "api";
}

/** Throws when `alias` cannot run on `route`. */
export function assertRouteSupports(alias: string, route: Route): void {
  if (route === "cli" && !(alias in CLI_MODELS)) {
    throw new Error(
      `model "${alias}" has no CLI route; use --route api or one of: ${
        Object.keys(CLI_MODELS).join(", ")
      }`,
    );
  }
}

/** The promptfoo provider entry for the CLI route. */
export function cliProviderEntry(
  alias: string,
  systemPrompt: string,
  toolNames: string[],
): { id: string; config: Record<string, unknown> } {
  const cli = CLI_MODELS[alias];
  return {
    id: "file://claude_cli_provider.mjs",
    config: {
      model: cli.model,
      effort: cli.effort,
      systemPrompt,
      toolNames,
    },
  };
}
