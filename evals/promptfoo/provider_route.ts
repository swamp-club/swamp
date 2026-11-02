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



export type Route = "api" | "cli";

export const ROUTES: readonly Route[] = ["api", "cli"];

interface CliModel {
  model: string;
  provider?: "codex";
  effort: string;
}

export const CLI_MODELS: Readonly<Record<string, CliModel>> = {
  sonnet: { model: "sonnet", effort: "low" },
  opus: { model: "opus", effort: "medium" },
  "gpt-6-astra": { model: "gpt-6-astra", effort: "medium", provider: "codex" },
};

/**
 * The route used when `--route` is not given: the API in GitHub Actions, where
 * the CI secrets live, and the CLI everywhere else for models that support it.
 * The opt-in Codex model is CLI-only, including in CI.
 */
export function defaultRoute(
  alias: string,
  env: { GITHUB_ACTIONS?: string },
): Route {
  if (CLI_MODELS[alias]?.provider === "codex") return "cli";
  if (env.GITHUB_ACTIONS) return "api";
  return alias in CLI_MODELS ? "cli" : "api";
}

export function resolveRoute(
  alias: string,
  requested: string | undefined,
  env: { GITHUB_ACTIONS?: string },
): Route {
  const route = requested ?? defaultRoute(alias, env);
  if (!(ROUTES as readonly string[]).includes(route)) {
    throw new Error(
      `unknown route "${route}". Valid routes: ${ROUTES.join(", ")}`,
    );
  }
  assertRouteSupports(alias, route as Route);
  return route as Route;
}

export function assertRouteSupports(alias: string, route: Route): void {
  if (route === "api" && CLI_MODELS[alias]?.provider === "codex") {
    throw new Error(`model "${alias}" is CLI-only; use --route cli`);
  }
  if (route === "cli" && !(alias in CLI_MODELS)) {
    throw new Error(
      `model "${alias}" has no CLI route; use --route api or one of: ${
        Object.keys(CLI_MODELS).join(", ")
      }`,
    );
  }
}

export function cliProviderEntry(
  alias: string,
  systemPrompt: string,
  toolNames: string[],
  tools: unknown[] = [],
): { id: string; config: Record<string, unknown> } {
  assertRouteSupports(alias, "cli");
  const cli = CLI_MODELS[alias];
  return {
    id: cli.provider === "codex"
      ? "file://codex_cli_provider.mjs"
      : "file://claude_cli_provider.mjs",
    config: {
      model: cli.model,
      effort: cli.effort,
      systemPrompt,
      toolNames,
      ...(cli.provider === "codex" ? { tools } : {}),
    },
  };
}
