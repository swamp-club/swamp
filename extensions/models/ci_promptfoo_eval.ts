import { z } from "npm:zod@4";

const TOKEN_PRICING: Record<string, { prompt: number; completion: number }> = {
  "sonnet": { prompt: 3.0, completion: 15.0 },
  "opus": { prompt: 15.0, completion: 75.0 },
  "gpt-5.4": { prompt: 2.0, completion: 8.0 },
  "gemini-2.5-pro": { prompt: 1.25, completion: 10.0 },
};

const API_KEY_ENV: Record<string, string> = {
  "sonnet": "ANTHROPIC_API_KEY",
  "opus": "ANTHROPIC_API_KEY",
  "gpt-5.4": "OPENAI_API_KEY",
  "gemini-2.5-pro": "GOOGLE_API_KEY",
};

const FailureSchema = z.object({
  description: z.string(),
  output: z.string(),
});

const ResultSchema = z.object({
  model: z.string(),
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  errors: z.number(),
  passRate: z.number(),
  tokens: z.object({
    total: z.number(),
    prompt: z.number(),
    completion: z.number(),
  }),
  cost: z.number(),
  durationMs: z.number(),
  failures: z.array(FailureSchema),
});

interface EvalStats {
  successes: number;
  failures: number;
  errors: number;
  tokenUsage: {
    total: number;
    prompt: number;
    completion: number;
    cached: number;
  };
  durationMs: number;
}

interface EvalResult {
  success: boolean;
  testCase?: {
    description?: string;
    vars?: Record<string, string>;
  };
  response?: {
    output?: unknown;
  };
}

interface PromptfooOutput {
  results: {
    stats: EvalStats;
    results: EvalResult[];
  };
}

function extractToolCallName(output: unknown): string | undefined {
  if (!output) return undefined;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (item?.function?.name) return item.function.name;
      if (item?.functionCall?.name) return item.functionCall.name;
      if (item?.name) return item.name;
    }
  }
  if (typeof output === "object" && output !== null) {
    const obj = output as Record<string, unknown>;
    if (obj.function && typeof obj.function === "object") {
      return (obj.function as Record<string, unknown>).name as string;
    }
    if (obj.functionCall && typeof obj.functionCall === "object") {
      return (obj.functionCall as Record<string, unknown>).name as string;
    }
  }
  return undefined;
}

export const model = {
  type: "@swamp/ci/promptfoo-eval",
  version: "2026.04.10.1",
  globalArguments: z.object({}),
  reports: ["@swamp/ci/eval-result"],
  resources: {
    "result": {
      description: "Structured eval results for a single model",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  files: {
    "raw-results": {
      description: "Full promptfoo results.json output",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    setupNpm: {
      description:
        "Install promptfoo npm dependencies once in the shared workDir. Run this before parallel eval steps to avoid npm install races.",
      arguments: z.object({
        workDir: z.string().describe("Path to the swamp repository checkout"),
      }),
      execute: async (
        args: { workDir: string },
        context: {
          logger: { info: (msg: string) => void };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<unknown>;
        },
      ) => {
        const configDir = `${args.workDir}/evals/promptfoo`;
        context.logger.info(`Installing promptfoo dependencies in ${configDir}`);

        const installCmd = new Deno.Command("npm", {
          args: ["install", "--package-lock=false"],
          cwd: configDir,
          stdout: "piped",
          stderr: "piped",
        });
        const result = await installCmd.output();

        if (result.code !== 0) {
          const stderr = new TextDecoder().decode(result.stderr);
          throw new Error(`npm install failed: ${stderr}`);
        }

        context.logger.info(`Promptfoo dependencies installed`);
        const handle = await context.writeResource(
          "result",
          "npm-install-marker",
          {
            model: "setup",
            total: 0,
            passed: 0,
            failed: 0,
            errors: 0,
            passRate: 0,
            tokens: { total: 0, prompt: 0, completion: 0 },
            cost: 0,
            durationMs: 0,
            failures: [],
            skipped: true,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    run: {
      description:
        "Run promptfoo skill trigger evals for a specific model and capture structured results",
      arguments: z.object({
        workDir: z.string().describe("Path to the swamp repository checkout"),
        model: z.string().describe(
          "Model alias to evaluate (sonnet, opus, gpt-5.4, gemini-2.5-pro)",
        ),
        concurrency: z.number().default(20).describe(
          "Number of concurrent eval calls",
        ),
        selectedModel: z.string().default("all").describe(
          "Filter: only run if model matches this value, or 'all' to run every model",
        ),
      }),
      execute: async (
        args: {
          workDir: string;
          model: string;
          concurrency: number;
          selectedModel: string;
        },
        context: {
          logger: {
            info: (msg: string, data?: Record<string, unknown>) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<unknown>;
          createFileWriter: (
            specName: string,
            name: string,
          ) => { writeText: (content: string) => Promise<void> };
        },
      ) => {
        const { workDir, model: modelAlias, concurrency, selectedModel } = args;
        const promptfooDir = `${workDir}/evals/promptfoo`;

        // Skip if this model wasn't selected
        if (selectedModel !== "all" && selectedModel !== modelAlias) {
          context.logger.info(
            `Skipping ${modelAlias} — not selected (selected: ${selectedModel})`,
          );
          const handle = await context.writeResource(
            "result",
            `result-${modelAlias}`,
            {
              model: modelAlias,
              total: 0,
              passed: 0,
              failed: 0,
              errors: 0,
              passRate: 0,
              tokens: { total: 0, prompt: 0, completion: 0 },
              cost: 0,
              durationMs: 0,
              failures: [],
              skipped: true,
            },
          );
          return { dataHandles: [handle] };
        }

        // Create a per-model isolated work directory. This avoids collisions
        // when multiple models run in parallel (they'd otherwise clobber each
        // other's promptfooconfig.yaml and results.json).
        const tempDir = await Deno.makeTempDir({
          prefix: `swamp-eval-${modelAlias}-`,
        });
        const configPath = `${tempDir}/promptfooconfig.yaml`;
        const resultsPath = `${tempDir}/results.json`;

        context.logger.info(
          `Running promptfoo eval for ${modelAlias} (concurrency=${concurrency}, tempDir=${tempDir})`,
        );

        const startTime = Date.now();

        try {
          // Step 1: Generate promptfoo config for this model. The generator
          // prints to stdout; we capture and write to our per-model path.
          context.logger.info(`Generating config for ${modelAlias}`);
          const genCmd = new Deno.Command("deno", {
            args: [
              "run",
              "--config",
              `${workDir}/deno.json`,
              "--allow-read",
              `${promptfooDir}/generate_config.ts`,
              "--model",
              modelAlias,
            ],
            cwd: workDir,
            stdout: "piped",
            stderr: "piped",
          });
          const genOutput = await genCmd.output();
          if (genOutput.code !== 0) {
            throw new Error(
              `Config generation failed: ${
                new TextDecoder().decode(genOutput.stderr)
              }`,
            );
          }
          await Deno.writeFile(configPath, genOutput.stdout);

          // Step 2: Run promptfoo eval with per-model config and output.
          // cwd is the shared promptfooDir so node_modules is found (npm
          // install runs once in the setup-npm step).
          context.logger.info(`Running promptfoo eval for ${modelAlias}`);
          const evalCmd = new Deno.Command("npx", {
            args: [
              "promptfoo",
              "eval",
              "-c",
              configPath,
              "-j",
              String(concurrency),
              "--no-cache",
              "-o",
              resultsPath,
            ],
            cwd: promptfooDir,
            stdout: "piped",
            stderr: "piped",
          });
          const evalOutput = await evalCmd.output();
          const durationMs = Date.now() - startTime;

          // promptfoo exits 100 when assertions fail (expected), other
          // non-zero is a hard failure (e.g., missing API key).
          const stdout = new TextDecoder().decode(evalOutput.stdout);
          const stderr = new TextDecoder().decode(evalOutput.stderr);

          let rawJson: string;
          try {
            rawJson = await Deno.readTextFile(resultsPath);
          } catch {
            // No results — check if this was a graceful skip (missing key).
            // promptfoo itself doesn't skip; that check is in the outer
            // eval-skill-triggers wrapper. Since we bypass that wrapper,
            // missing keys show up as non-zero exit without results.
            const isSkip = evalOutput.code !== 0 &&
              (stderr.includes("API key") || stderr.includes("api key"));
            if (isSkip) {
              context.logger.info(
                `${modelAlias} skipped — API key not configured`,
              );
              const handle = await context.writeResource(
                "result",
                `result-${modelAlias}`,
                {
                  model: modelAlias,
                  total: 0,
                  passed: 0,
                  failed: 0,
                  errors: 0,
                  passRate: 0,
                  tokens: { total: 0, prompt: 0, completion: 0 },
                  cost: 0,
                  durationMs,
                  failures: [],
                  skipped: true,
                },
              );
              return { dataHandles: [handle] };
            }
            throw new Error(
              `Eval failed — no results.json produced.\nExit code: ${evalOutput.code}\nStdout: ${stdout}\nStderr: ${stderr}`,
            );
          }

          return await processResults(
            rawJson,
            modelAlias,
            durationMs,
            context,
          );
        } finally {
          // Always clean up the per-model temp dir
          await Deno.remove(tempDir, { recursive: true }).catch(() => {});
        }
      },
    },
  },
};

// Helper: parse results.json and write the structured resource.
async function processResults(
  rawJson: string,
  modelAlias: string,
  durationMs: number,
  context: {
    logger: { info: (msg: string) => void };
    writeResource: (
      specName: string,
      name: string,
      data: Record<string, unknown>,
    ) => Promise<unknown>;
    createFileWriter: (
      specName: string,
      name: string,
    ) => { writeText: (content: string) => Promise<void> };
  },
): Promise<{ dataHandles: unknown[] }> {
  const data: PromptfooOutput = JSON.parse(rawJson);
  const { stats, results } = data.results;

  const total = stats.successes + stats.failures;
  const passRate = total > 0 ? stats.successes / total : 0;

  const pricing = TOKEN_PRICING[modelAlias];
  const cost = pricing
    ? (stats.tokenUsage.prompt / 1_000_000) * pricing.prompt +
      (stats.tokenUsage.completion / 1_000_000) * pricing.completion
    : 0;

  const failures = results
    .filter((r) => !r.success)
    .map((r) => {
      const desc = r.testCase?.description ??
        r.testCase?.vars?.query ?? "unknown";
      const calledTool = extractToolCallName(r.response?.output);
      const outputStr = typeof r.response?.output === "string"
        ? r.response.output.slice(0, 80)
        : calledTool
        ? `routed to ${calledTool}`
        : "text response (no tool call)";
      return { description: desc, output: outputStr };
    });

  context.logger.info(
    `Eval complete for ${modelAlias}: ${stats.successes}/${total} passed (${(passRate * 100).toFixed(1)}%)`,
  );

  const resultHandle = await context.writeResource(
    "result",
    `result-${modelAlias}`,
    {
      model: modelAlias,
      total,
      passed: stats.successes,
      failed: stats.failures,
      errors: stats.errors ?? 0,
      passRate,
      tokens: {
        total: stats.tokenUsage.total,
        prompt: stats.tokenUsage.prompt,
        completion: stats.tokenUsage.completion,
      },
      cost,
      durationMs,
      failures,
    },
  );

  const fileWriter = context.createFileWriter(
    "raw-results",
    `raw-results-${modelAlias}`,
  );
  await fileWriter.writeText(rawJson);

  return { dataHandles: [resultHandle] };
}
