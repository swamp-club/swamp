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
 * Generates a promptfoo configuration YAML from existing trigger_evals.json
 * files and SKILL.md frontmatter, using lightweight API calls (~193 calls)
 * instead of spawning Claude Code sessions.
 *
 * Usage: deno run --allow-read generate_config.ts [--model <alias>]
 *
 * Supported model aliases: sonnet, opus, gpt-4.1, gemini-2.5-pro
 * Default: sonnet
 */

import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";

interface ProviderDefinition {
  id: string;
  apiKeyEnv: string;
  delay?: number;
}

const PROVIDER_REGISTRY: Record<string, ProviderDefinition> = {
  "sonnet": {
    id: "anthropic:messages:claude-sonnet-4-5",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  "opus": {
    id: "anthropic:messages:claude-opus-4-6",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  "gpt-5.4": {
    id: "openai:gpt-5.4",
    apiKeyEnv: "OPENAI_API_KEY",
    delay: 500,
  },
  "gemini-2.5-pro": {
    id: "google:gemini-2.5-pro",
    apiKeyEnv: "GOOGLE_API_KEY",
  },
};

const VALID_MODELS = Object.keys(PROVIDER_REGISTRY);

const SKILLS_DIR = join(Deno.cwd(), ".claude", "skills");
const SKILL_NAMES = [
  "swamp-data",
  "swamp-extension",
  "swamp-extension-publish",
  "swamp-getting-started",
  "swamp-issue",
  "swamp-model",
  "swamp-repo",
  "swamp-report",
  "swamp-troubleshooting",
  "swamp-vault",
  "swamp-workflow",
];

interface EvalQuery {
  query: string;
  should_trigger: boolean;
  note?: string;
}

interface SkillFrontmatter {
  name: string;
  description: string;
}

function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const lines = content.split("\n");
  if (lines[0].trim() !== "---") {
    throw new Error("Missing frontmatter opening ---");
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new Error("Missing frontmatter closing ---");
  }
  const yamlBlock = lines.slice(1, endIdx).join("\n");
  const parsed = parseYaml(yamlBlock) as Record<string, unknown>;
  return {
    name: String(parsed.name ?? ""),
    description: String(parsed.description ?? ""),
  };
}

interface PromptfooTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

interface PromptfooTest {
  description: string;
  vars: { query: string };
  assert: Array<{ type: string; value: string[] | string; threshold?: number }>;
}

async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    string: ["model"],
    default: { model: "sonnet" },
  });

  const modelAlias = args.model;
  if (!VALID_MODELS.includes(modelAlias)) {
    console.error(
      `Error: unknown model "${modelAlias}". Valid models: ${
        VALID_MODELS.join(", ")
      }`,
    );
    Deno.exit(1);
  }

  const provider = PROVIDER_REGISTRY[modelAlias];
  const tools: PromptfooTool[] = [];
  const tests: PromptfooTest[] = [];

  for (const skillName of SKILL_NAMES) {
    const skillDir = join(SKILLS_DIR, skillName);

    // Read skill description from SKILL.md frontmatter
    const skillMdContent = await Deno.readTextFile(
      join(skillDir, "SKILL.md"),
    );
    const frontmatter = parseSkillFrontmatter(skillMdContent);

    // Add tool definition
    tools.push({
      type: "function",
      function: {
        name: skillName,
        description: frontmatter.description,
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The user's request to process",
            },
          },
          required: ["query"],
        },
      },
    });

    // Read trigger evals
    const evalPath = join(skillDir, "evals", "trigger_evals.json");
    let evalSet: EvalQuery[];
    try {
      const content = await Deno.readTextFile(evalPath);
      evalSet = JSON.parse(content) as EvalQuery[];
    } catch {
      console.error(`Warning: no trigger_evals.json for ${skillName}`);
      continue;
    }

    // Generate test cases
    for (const item of evalSet) {
      const direction = item.should_trigger ? "SHOULD" : "should NOT";
      const desc = `[${skillName}] ${direction} trigger: ${
        item.query.slice(0, 60)
      }`;

      if (item.should_trigger) {
        tests.push({
          description: desc,
          vars: { query: item.query },
          assert: [
            {
              type: "javascript",
              value: [
                `const needle = '${skillName}';`,
                `const str = typeof output === 'string' ? output : JSON.stringify(output);`,
                `try {`,
                `  const parsed = typeof output === 'object' ? (Array.isArray(output) ? output : [output]) : JSON.parse(str);`,
                `  const calls = Array.isArray(parsed) ? parsed : [parsed];`,
                `  return calls.some(c => c.function?.name === needle || c.name === needle || c.functionCall?.name === needle);`,
                `} catch {}`,
                `return str.includes('"' + needle + '"');`,
              ].join("\n"),
            },
          ],
        });
      } else {
        tests.push({
          description: desc,
          vars: { query: item.query },
          assert: [
            {
              type: "javascript",
              value: [
                `const needle = '${skillName}';`,
                `const str = typeof output === 'string' ? output : JSON.stringify(output);`,
                `try {`,
                `  const parsed = typeof output === 'object' ? (Array.isArray(output) ? output : [output]) : JSON.parse(str);`,
                `  const calls = Array.isArray(parsed) ? parsed : [parsed];`,
                `  return !calls.some(c => c.function?.name === needle || c.name === needle || c.functionCall?.name === needle);`,
                `} catch {}`,
                `return !str.includes('"' + needle + '"');`,
              ].join("\n"),
            },
          ],
        });
      }
    }
  }

  const systemMessage =
    "You are a skill router for swamp, an AI-native automation framework. Your ONLY job is to route user requests to the correct skill by making a tool call. You MUST call exactly one tool for every request. A text-only response with no tool call is ALWAYS wrong — every request has a best-matching skill. NEVER respond with text. NEVER ask clarifying questions. Even if the request is vague or missing details, route it to the best-matching skill based on the topic and keywords. The skill itself will handle gathering any missing information from the user.";

  const config = {
    description: `Swamp skill trigger routing evaluation (${modelAlias})`,
    prompts: ["{{query}}"],
    providers: [
      {
        id: provider.id,
        config: {
          temperature: 0,
          max_tokens: 200,
          systemMessage,
          tools,
        },
        ...(provider.delay ? { delay: provider.delay } : {}),
      },
    ],
    tests,
  };

  console.log(stringifyYaml(config, { lineWidth: 200 }));
}

await main();
