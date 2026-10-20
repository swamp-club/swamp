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


// promptfoo custom provider that answers each eval case through the Claude
// Code CLI (`claude -p`), so the evals run on a claude.ai login instead of an
// ANTHROPIC_API_KEY. The model is made to pick exactly one tool name through
// a JSON-schema enum, and the pick is returned as a function-call array — the
// shape the generated assertions already accept.
//
// Plain ESM with no Deno APIs: promptfoo loads this file under Node.

import { execFile } from "node:child_process";

const CLI_TIMEOUT_MS = 120_000;

/** The JSON schema that forces a single tool-name choice. */
export function buildSchema(toolNames) {
  return {
    type: "object",
    properties: { tool: { type: "string", enum: toolNames } },
    required: ["tool"],
    additionalProperties: false,
  };
}

/**
 * Flags that cut `claude -p` off from tools, MCP servers and user settings, so
 * a case is answered from the prompt alone. Shared with the runner's preflight.
 * `--bare` is not an option: it only accepts an API key.
 */
export const ISOLATION_FLAGS = [
  "--tools",
  "",
  "--strict-mcp-config",
  "--setting-sources",
  "",
];

/** Arguments for `claude`; the prompt is passed separately on stdin-free argv. */
export function buildArgs(prompt, config) {
  const args = [
    "-p",
    prompt,
    "--model",
    config.model,
    ...ISOLATION_FLAGS,
    "--system-prompt",
    config.systemPrompt,
    "--json-schema",
    JSON.stringify(buildSchema(config.toolNames)),
    "--output-format",
    "json",
  ];
  if (config.effort) args.push("--effort", config.effort);
  return args;
}

/**
 * Turns the CLI's JSON stdout into a promptfoo provider response. Any answer
 * that is not an in-enum tool name becomes an `error`, which the runner counts
 * as a failed case — never a pass.
 */
export function parseCliOutput(stdout, toolNames) {
  let doc;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return { error: `claude -p printed non-JSON output: ${stdout.slice(0, 200)}` };
  }
  if (doc.is_error) {
    return { error: `claude -p reported an error: ${String(doc.result).slice(0, 200)}` };
  }
  const tool = doc.structured_output?.tool;
  if (typeof tool !== "string" || !toolNames.includes(tool)) {
    return {
      error: `claude -p returned no valid tool choice: ${
        JSON.stringify(doc.structured_output)
      }`,
    };
  }
  const usage = doc.usage ?? {};
  const prompt = (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);
  const completion = usage.output_tokens ?? 0;
  const resolvedModel = Object.keys(doc.modelUsage ?? {})[0];
  return {
    output: [{ function: { name: tool } }],
    tokenUsage: { total: prompt + completion, prompt, completion },
    metadata: { resolvedModel },
  };
}

function runClaude(args) {
  // ANTHROPIC_API_KEY is dropped so the CLI always uses the claude.ai login,
  // even in a shell that still exports a stale key.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return new Promise((resolve) => {
    execFile(
      "claude",
      args,
      { env, timeout: CLI_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  });
}

export default class ClaudeCliProvider {
  constructor(options) {
    this.config = options.config;
    this.providerId = options.id ?? `claude-cli:${this.config.model}`;
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt) {
    const { error, stdout, stderr } = await runClaude(
      buildArgs(prompt, this.config),
    );
    // A nonzero exit still prints a JSON document on stdout when the CLI got
    // as far as the API, so parse it first and fall back to the exit error.
    if (error && !stdout) {
      return {
        error: `claude -p failed: ${error.message} ${String(stderr).slice(0, 200)}`,
      };
    }
    return parseCliOutput(stdout, this.config.toolNames);
  }
}
