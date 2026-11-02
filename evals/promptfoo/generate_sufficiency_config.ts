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
 * Generates a promptfoo configuration for testing guide sufficiency.
 * Given a user query and ONLY the short guide.md content, can the model
 * answer from the guide alone or does it need reference.md?
 *
 * Two tools are offered: answer_from_guide and need_reference. The eval
 * asserts the correct tool is called based on the answerable_from_guide flag.
 *
 * Usage: deno run --allow-read generate_sufficiency_config.ts [--model <alias>]
 */

import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import {
  CLI_MODELS,
  cliProviderEntry,
  resolveRoute,
  type Route,
} from "./provider_route.ts";

interface ProviderDefinition {
  id: string;
  apiKeyEnv: string;
  delay?: number;
  noToolChoice?: boolean;
  thinking?: Record<string, string>;
}

const PROVIDER_REGISTRY: Record<string, ProviderDefinition> = {
  "sonnet": {
    id: "anthropic:messages:claude-sonnet-4-5",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  "opus": {
    id: "anthropic:messages:claude-opus-5-5",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    noToolChoice: true,
    thinking: { type: "adaptive" },
  },
  "fable": {
    id: "anthropic:messages:claude-fable-5",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    noToolChoice: true,
    thinking: { type: "adaptive" },
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
  "gemini-3.1-pro": {
    id: "google:gemini-3.1-pro-preview",
    apiKeyEnv: "GOOGLE_API_KEY",
  },
};

const VALID_MODELS = [
  ...new Set([...Object.keys(PROVIDER_REGISTRY), ...Object.keys(CLI_MODELS)]),
];

const GUIDE_DIRS: Record<string, string> = {
  "behavior": "references/behavior",
  "workflow": "references/workflow",
  "data": "references/data",
  "extension": "references/extension",
  "repo": "references/repo",
  "vault": "references/vault",
  "report": "references/report",
  "issue": "references/issue",
  "extension-publish": "references/extension-publish",
  "troubleshooting": "references/troubleshooting",
  "architecture": "references/architecture",
  "share": "references/share",
  "serve": "references/serve",
};

/**
 * Guides quote swamp's own `{{ ... }}` expressions (vault.get, for one), which
 * promptfoo renders as template code and rejects, erroring those cases. A raw
 * block makes it pass the text through untouched.
 */
function rawBlock(text: string): string {
  return `{% raw %}${text}{% endraw %}`;
}

interface SufficiencyEval {
  query: string;
  guide: string;
  answerable_from_guide: boolean;
  note: string;
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
  vars: { query: string; guide_content: string };
  assert: Array<{ type: string; value: string }>;
}

export async function generateConfig(
  argv: string[],
): Promise<Record<string, unknown>> {
  const args = parseArgs(argv, {
    string: ["model", "route"],
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
  let route: Route;
  try {
    route = resolveRoute(modelAlias, args.route, {
      GITHUB_ACTIONS: Deno.env.get("GITHUB_ACTIONS"),
    });
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    Deno.exit(1);
  }

  const skillsDir = join(Deno.cwd(), ".claude", "skills", "swamp");

  // Read guide.md content for each guide topic
  const guideContents: Record<string, string> = {};
  for (const [topic, dir] of Object.entries(GUIDE_DIRS)) {
    const guidePath = join(skillsDir, dir, "guide.md");
    guideContents[topic] = await Deno.readTextFile(guidePath);
  }

  // Build tools
  const tools: PromptfooTool[] = [
    {
      type: "function",
      function: {
        name: "answer_from_guide",
        description:
          "Call this when the guide content provided is sufficient to answer the user's query. The guide contains the commands, rules, or information needed.",
        parameters: {
          type: "object",
          properties: {
            answer: {
              type: "string",
              description: "Brief answer derived from the guide content",
            },
          },
          required: ["answer"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "need_reference",
        description:
          "Call this when the guide content is NOT sufficient to answer the user's query. The guide lacks the detailed walkthrough, output shapes, or implementation specifics needed.",
        parameters: {
          type: "object",
          properties: {
            missing: {
              type: "string",
              description: "What information is missing from the guide",
            },
          },
          required: ["missing"],
        },
      },
    },
  ];

  // Read sufficiency evals
  const evalPath = join(skillsDir, "evals", "guide_sufficiency_evals.json");
  const evalContent = await Deno.readTextFile(evalPath);
  const evals: SufficiencyEval[] = JSON.parse(evalContent);

  // Validate all guide references
  const unknownGuides = evals
    .map((e) => e.guide)
    .filter((g) => !(g in GUIDE_DIRS));
  if (unknownGuides.length > 0) {
    const unique = [...new Set(unknownGuides)];
    console.error(
      `Error: unknown guide(s) in guide_sufficiency_evals.json: ${
        unique.join(", ")
      }`,
    );
    console.error(`Valid guides: ${Object.keys(GUIDE_DIRS).join(", ")}`);
    Deno.exit(1);
  }

  // Generate test cases
  const tests: PromptfooTest[] = evals.map((item) => {
    const expectedTool = item.answerable_from_guide
      ? "answer_from_guide"
      : "need_reference";
    const label = item.answerable_from_guide ? "sufficient" : "insufficient";
    return {
      description: `[${item.guide}:${label}] ${item.query.slice(0, 50)}`,
      vars: {
        query: item.query,
        guide_content: rawBlock(guideContents[item.guide]),
      },
      assert: [
        {
          type: "javascript",
          value: [
            `const needle = '${expectedTool}';`,
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
    };
  });

  const systemMessage =
    `You are evaluating whether a skill guide contains enough information for an AI agent to act on a user's query.\n\nThe guide content is included in the user message below the query. Based ONLY on the guide content provided, decide:\n- If the guide contains the CLI command, rule, concept, or procedure needed to act on the query → call answer_from_guide. A command in a Quick Reference table with its syntax IS sufficient — the agent can run it and inspect the output.\n- If the query asks about implementation details, internal mechanics, step-by-step walkthroughs, output shapes, or advanced configuration that the guide does not cover → call need_reference\n\nKey principle: if the guide shows the exact command to run (even in a table row), that is sufficient for queries asking how to DO something. Only call need_reference when the query asks about HOW something works internally or needs details beyond what the command table provides.`;

  const config = {
    description: `Swamp guide sufficiency evaluation (${modelAlias})`,
    prompts: ["{{query}}\n\n---\n\nGuide content:\n\n{{guide_content}}"],
    providers: route === "cli"
      ? [
        cliProviderEntry(
          modelAlias, systemMessage, tools.map((t) => t.function.name), tools,
        ),
      ]
      : [
      {
        id: provider.id,
        config: {
          ...(provider.thinking
            ? { thinking: provider.thinking }
            : { temperature: 0 }),
          max_tokens: provider.thinking ? 2048 : 200,
          systemMessage,
          tools,
          ...(provider.noToolChoice ? {} : { tool_choice: "required" }),
        },
        ...(provider.delay ? { delay: provider.delay } : {}),
      },
      ],
    tests,
  };

  return JSON.parse(JSON.stringify(config));
}

if (import.meta.main) {
  console.log(stringifyYaml(await generateConfig(Deno.args), { lineWidth: 200 }));
}
