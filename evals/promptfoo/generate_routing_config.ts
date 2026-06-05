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
 * Generates a promptfoo configuration for testing internal routing within
 * the swamp gateway skill. Given a user query and the SKILL.md routing
 * table as context, does Claude pick the correct guide?
 *
 * Each guide topic is presented as a tool. The eval asserts the correct
 * tool is called for each query.
 *
 * Usage: deno run --allow-read generate_routing_config.ts [--model <alias>]
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
  "gemini-3.1-pro": {
    id: "google:gemini-3.1-pro-preview",
    apiKeyEnv: "GOOGLE_API_KEY",
  },
};

const VALID_MODELS = Object.keys(PROVIDER_REGISTRY);

const GUIDE_TOPICS: Record<string, string> = {
  "model": "Load this guide for model operations — create, run, edit, delete, search types, method execution, model outputs",
  "workflow": "Load this guide for workflow operations — create, run, validate, DAG, history, scheduled workflows",
  "data": "Load this guide for data operations — list, query, versions, garbage collection, delete, CEL predicates",
  "vault": "Load this guide for vault operations — create, store/read secrets, list keys, vault expressions",
  "extension": "Load this guide for extension development — create models, vaults, drivers, datastores, reports, Zod schemas, smoke testing, quality scorecard",
  "extension-publish": "Load this guide for publishing — push extensions to registry, deprecate, version bumping",
  "repo": "Load this guide for repository management — init, upgrade, datastores, extension sources, CI/CD",
  "report": "Load this guide for report operations — run, configure, view, filter reports",
  "troubleshooting": "Load this guide for troubleshooting — errors, health checks, diagnostics, tracing, debugging",
  "issue": "Load this guide for issue operations — file bugs, feature requests, security reports, comments",
};

interface RoutingEval {
  query: string;
  expected_guide: string;
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
  assert: Array<{ type: string; value: string }>;
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

  // Read the SKILL.md body (stripping frontmatter) for the system message
  const skillsDir = join(Deno.cwd(), ".claude", "skills", "swamp");
  const skillMdContent = await Deno.readTextFile(join(skillsDir, "SKILL.md"));
  const lines = skillMdContent.split("\n");
  let bodyStart = 0;
  let dashes = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      dashes++;
      if (dashes === 2) {
        bodyStart = i + 1;
        break;
      }
    }
  }
  const skillBody = lines.slice(bodyStart).join("\n").trim();

  // Build tools — one per guide topic
  const tools: PromptfooTool[] = Object.entries(GUIDE_TOPICS).map(
    ([name, description]) => ({
      type: "function",
      function: {
        name: `load_${name.replace("-", "_")}_guide`,
        description,
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
    }),
  );

  // Read routing evals
  const evalPath = join(skillsDir, "evals", "routing_evals.json");
  const evalContent = await Deno.readTextFile(evalPath);
  const evals: RoutingEval[] = JSON.parse(evalContent);

  // Generate test cases
  const tests: PromptfooTest[] = evals.map((item) => {
    const toolName = `load_${item.expected_guide.replace("-", "_")}_guide`;
    return {
      description: `[${item.expected_guide}] ${item.query.slice(0, 60)}`,
      vars: { query: item.query },
      assert: [
        {
          type: "javascript",
          value: [
            `const needle = '${toolName}';`,
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
    `You are a skill router inside the swamp gateway skill. The user's request has already been routed to the swamp skill. Your job is to load the correct guide by calling the matching tool.\n\nHere is the routing table:\n\n${skillBody}\n\nYou MUST call exactly one tool. NEVER respond with text. Route based on the topic and keywords.`;

  // Validate all expected_guide values map to known topics
  const unknownGuides = evals
    .map((e) => e.expected_guide)
    .filter((g) => !(g in GUIDE_TOPICS));
  if (unknownGuides.length > 0) {
    const unique = [...new Set(unknownGuides)];
    console.error(
      `Error: unknown guide topic(s) in routing_evals.json: ${
        unique.join(", ")
      }`,
    );
    console.error(`Valid topics: ${Object.keys(GUIDE_TOPICS).join(", ")}`);
    Deno.exit(1);
  }

  const config = {
    description: `Swamp gateway internal routing evaluation (${modelAlias})`,
    prompts: ["{{query}}"],
    providers: [
      {
        id: provider.id,
        config: {
          temperature: 0,
          max_tokens: 200,
          systemMessage,
          tools,
          tool_choice: "required",
        },
        ...(provider.delay ? { delay: provider.delay } : {}),
      },
    ],
    tests,
  };

  // Suppress YAML anchors by pre-stringifying the config
  const yamlStr = stringifyYaml(JSON.parse(JSON.stringify(config)), {
    lineWidth: 200,
  });
  console.log(yamlStr);
}

await main();
