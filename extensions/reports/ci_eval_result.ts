/**
 * Per-model eval result report.
 *
 * Method-scope report that runs after each @swamp/ci/promptfoo-eval step
 * and renders that specific model's results in GHA per-job summary format.
 */

interface EvalFailure {
  description: string;
  output: string;
}

interface EvalResult {
  model: string;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  passRate: number;
  tokens: { total: number; prompt: number; completion: number };
  cost: number;
  durationMs: number;
  failures: EvalFailure[];
  skipped?: boolean;
}

interface DataHandle {
  name: string;
  specName: string;
  kind: "resource" | "file";
  dataId: string;
  version: number;
}

interface ModelTypeLike {
  normalized: string;
  raw: string;
  toDirectoryPath: () => string;
  toString: () => string;
  equals: (other: ModelTypeLike) => boolean;
}

interface MethodReportContext {
  scope: "method";
  modelType: ModelTypeLike;
  modelId: string;
  definition: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
  };
  methodName: string;
  executionStatus: "succeeded" | "failed";
  dataHandles: DataHandle[];
  dataRepository: {
    getContent: (
      modelType: ModelTypeLike,
      modelId: string,
      name: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
}

type ReportContext = MethodReportContext | { scope: string };

function isMethodContext(ctx: ReportContext): ctx is MethodReportContext {
  return ctx.scope === "method";
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${seconds}s`;
}

export const report = {
  name: "@swamp/ci/eval-result",
  description:
    "Per-model skill trigger eval results — runs after each @swamp/ci/promptfoo-eval step",
  scope: "method" as const,
  labels: ["ci", "eval"],

  execute: async (
    context: ReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (!isMethodContext(context)) {
      return {
        markdown: "⚠️ This report only runs at method scope.",
        json: { error: "wrong scope" },
      };
    }

    // Only applies to @swamp/ci/promptfoo-eval model runs
    if (context.modelType.normalized !== "@swamp/ci/promptfoo-eval") {
      return {
        markdown: "",
        json: { skipped: true, reason: "wrong model type" },
      };
    }

    // Find the result resource handle
    const resultHandle = context.dataHandles.find(
      (h) => h.specName === "result" && h.kind === "resource",
    );

    if (!resultHandle) {
      return {
        markdown: "_No eval result produced._",
        json: { error: "no result handle" },
      };
    }

    // Load the structured result data
    const content = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      resultHandle.name,
      resultHandle.version,
    );

    if (!content) {
      return {
        markdown: "_Could not load eval result data._",
        json: { error: "no content" },
      };
    }

    const r: EvalResult = JSON.parse(new TextDecoder().decode(content));

    // Skipped models get a minimal summary
    if (r.skipped) {
      return {
        markdown: `## Skill Trigger Eval Results (${r.model})\n\n_Skipped — not selected for this run._\n`,
        json: { model: r.model, skipped: true },
      };
    }

    // Build the full per-model summary (GHA per-job style)
    let md = `## Skill Trigger Eval Results (${r.model})\n\n`;
    md += "| Metric | Value |\n|---|---|\n";
    md += `| Model | ${r.model} |\n`;
    md += `| Total tests | ${r.total} |\n`;
    md += `| Passed | ${r.passed} |\n`;
    md += `| Failed | ${r.failed} |\n`;
    md += `| Pass rate | ${(r.passRate * 100).toFixed(1)}% |\n`;
    md += `| Estimated cost | $${r.cost.toFixed(2)} |\n`;
    md += `| Tokens | ${r.tokens.total.toLocaleString()} |\n`;
    md += `| Duration | ${formatDuration(r.durationMs)} |\n`;

    if (r.failures.length > 0) {
      md += "\n### Failed Tests\n\n";
      md += "| Test | Output |\n|---|---|\n";
      for (const f of r.failures) {
        const escapedDesc = f.description.replace(/\|/g, "\\|");
        const escapedOutput = f.output
          .replace(/\|/g, "\\|")
          .replace(/\n/g, " ");
        md += `| ${escapedDesc} | ${escapedOutput} |\n`;
      }
    }

    return {
      markdown: md,
      json: {
        model: r.model,
        total: r.total,
        passed: r.passed,
        failed: r.failed,
        passRate: r.passRate,
        cost: r.cost,
        tokens: r.tokens.total,
        durationMs: r.durationMs,
        status: r.passRate >= 0.9 ? "pass" : "fail",
        failures: r.failures,
      },
    };
  },
};
