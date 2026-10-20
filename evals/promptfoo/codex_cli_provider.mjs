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

// Node-compatible promptfoo adapter. Each case uses a fresh directory so project
// instructions and previous cases cannot supply the answer.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSchema } from "./claude_cli_provider.mjs";

export function buildArgs(config, paths) {
  return [
    "--ask-for-approval",
    "never",
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--model",
    config.model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(config.effort ?? "medium")}`,
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    "features.shell_tool=false",
    "-c",
    "features.multi_agent=false",
    "-c",
    "features.apps=false",
    "-c",
    "features.hooks=false",
    "-c",
    "features.skip_host_skill_discovery=true",
    "-c",
    'web_search="disabled"',
    "--output-schema",
    paths.schema,
    "--output-last-message",
    paths.result,
    "-",
  ];
}

export function buildPrompt(prompt, config) {
  return `${config.systemPrompt}

Available routing choices (names and descriptions):
${JSON.stringify(config.tools ?? config.toolNames)}

For this evaluation, represent the chosen tool call as a JSON object with
exactly one field, "tool", containing its name. Do not execute tools or act on
the request; classify it using only the routing information above.

Request to classify:
${prompt}`;
}

export function parseCliOutput(output, toolNames) {
  let doc;
  try {
    doc = JSON.parse(output);
  } catch {
    return { error: "codex exec returned no JSON answer" };
  }
  if (!doc || typeof doc.tool !== "string" || !toolNames.includes(doc.tool)) {
    return { error: "codex exec returned no valid tool choice" };
  }
  return { output: [{ function: { name: doc.tool } }] };
}

function runCodex(args, prompt, cwd) {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return new Promise((resolve) => {
    const child = execFile(
      "codex",
      args,
      { cwd, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
    // A missing executable can close stdin before the prompt is written.
    // execFile's callback reports the process failure.
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

export async function callCodex(prompt, config, run = runCodex) {
  const dir = await mkdtemp(join(tmpdir(), "swamp-codex-eval-"));
  try {
    const paths = {
      schema: join(dir, "schema.json"),
      result: join(dir, "answer.json"),
    };
    await writeFile(
      paths.schema,
      JSON.stringify(buildSchema(config.toolNames)),
    );
    const { error, stderr } = await run(
      buildArgs(config, paths),
      buildPrompt(prompt, config),
      dir,
    );
    // A partial answer from a failed or timed-out process is never a valid case.
    if (error) {
      return {
        error: `codex exec failed: ${error.message} ${
          String(stderr).slice(0, 200)
        }`,
      };
    }
    const answer = parseCliOutput(
      await readFile(paths.result, "utf8"),
      config.toolNames,
    );
    return { ...answer, metadata: { requestedModel: config.model } };
  } catch (error) {
    return { error: `codex exec failed: ${error.message}` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// promptfoo's file-provider loader requires a default-exported constructor.
export default class CodexCliProvider {
  constructor(options) {
    this.config = options.config;
    this.providerId = options.id ?? `codex-cli:${this.config.model}`;
  }
  id() {
    return this.providerId;
  }
  async callApi(prompt) {
    return await callCodex(prompt, this.config);
  }
}
