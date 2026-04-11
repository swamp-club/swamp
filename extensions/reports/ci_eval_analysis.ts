/**
 * Cross-model eval analysis report.
 *
 * Workflow-scope report that reads structured eval results from all
 * @swamp/ci/promptfoo-eval steps, computes cross-model failure analysis,
 * and produces a markdown summary matching the GitHub Actions format.
 */

const PASS_THRESHOLD = 0.9;

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

interface StepExecution {
  jobName: string;
  stepName: string;
  modelName: string;
  modelType: string;
  methodName: string;
  status: "succeeded" | "failed" | "skipped";
  dataHandles: Array<{
    name: string;
    specName: string;
    kind: "resource" | "file";
    dataId: string;
    version: number;
    size: number;
    tags: Record<string, string>;
  }>;
  methodArgs: Record<string, unknown>;
  modelId: string;
  globalArgs: Record<string, unknown>;
}

interface ModelTypeLike {
  normalized: string;
  raw: string;
  toDirectoryPath: () => string;
  toString: () => string;
  equals: (other: ModelTypeLike) => boolean;
}

interface WorkflowReportContext {
  scope: "workflow";
  workflowId: string;
  workflowRunId: string;
  workflowName: string;
  workflowStatus: "succeeded" | "failed";
  stepExecutions: StepExecution[];
  repoDir: string;
  logger: {
    info: (msg: string, data?: Record<string, unknown>) => void;
    warn: (msg: string, data?: Record<string, unknown>) => void;
  };
  dataRepository: {
    getContent: (
      modelType: ModelTypeLike,
      modelId: string,
      name: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
}

// Duck-typed ModelType — matches swamp's ModelType interface without
// requiring an internal import (bundled reports can't import from src/).
function makeModelType(rawType: string): ModelTypeLike {
  const normalized = rawType
    .trim()
    .toLowerCase()
    .replace(/::/g, "/")
    .replace(/\s+/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
  return {
    raw: rawType,
    normalized,
    toDirectoryPath: () => normalized,
    toString: () => rawType,
    equals: (other: ModelTypeLike) => other.normalized === normalized,
  };
}

type ReportContext = WorkflowReportContext | { scope: string };

function isWorkflowContext(ctx: ReportContext): ctx is WorkflowReportContext {
  return ctx.scope === "workflow";
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${seconds}s`;
}

function findCrossModelFailures(
  results: EvalResult[],
): Map<string, string[]> {
  const failureMap = new Map<string, string[]>();
  for (const result of results) {
    for (const failure of result.failures) {
      const desc = failure.description.trim();
      if (!failureMap.has(desc)) {
        failureMap.set(desc, []);
      }
      failureMap.get(desc)!.push(result.model);
    }
  }
  return failureMap;
}

export const report = {
  name: "@swamp/ci/eval-analysis",
  description:
    "Cross-model skill trigger eval analysis — reads all promptfoo-eval results and produces a comparison report",
  scope: "workflow" as const,
  labels: ["ci", "eval"],

  execute: async (
    context: ReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (!isWorkflowContext(context)) {
      return {
        markdown: "⚠️ This report only runs at workflow scope.",
        json: { error: "wrong scope" },
      };
    }

    // Find all eval-runner steps and extract their result data handles
    const evalSteps = context.stepExecutions.filter(
      (step) =>
        step.modelType === "@swamp/ci/promptfoo-eval" &&
        step.methodName === "run",
    );

    if (evalSteps.length === 0) {
      return {
        markdown: "No eval results found — no @swamp/ci/promptfoo-eval steps executed.",
        json: { error: "no eval steps found" },
      };
    }

    // Read result data from each eval step
    const results: EvalResult[] = [];

    for (const step of evalSteps) {
      const resultHandle = step.dataHandles.find(
        (h) => h.specName === "result" && h.kind === "resource",
      );
      if (!resultHandle) {
        context.logger.warn(
          "Eval step {step} has no result data handle, skipping",
          { step: step.stepName },
        );
        continue;
      }

      const content = await context.dataRepository.getContent(
        makeModelType(step.modelType),
        step.modelId,
        resultHandle.name,
        resultHandle.version,
      );
      if (!content) {
        context.logger.warn(
          "Could not read result data for step {step}",
          { step: step.stepName },
        );
        continue;
      }

      const parsed = JSON.parse(new TextDecoder().decode(content));
      results.push(parsed as EvalResult);
    }

    // Separate skipped from actually-run results — skipped models weren't
    // selected for this run and shouldn't affect the verdict.
    const skippedResults = results.filter((r) => r.skipped === true);
    const ranResults = results.filter((r) => r.skipped !== true);

    if (ranResults.length === 0) {
      return {
        markdown: `No eval results to analyze — ${skippedResults.length} models were skipped.`,
        json: { error: "no results loaded", skipped: skippedResults.length },
      };
    }

    // Sort by pass rate descending
    ranResults.sort((a, b) => b.passRate - a.passRate);

    // Compute cross-model failures (only across models that actually ran)
    const crossModelFailures = findCrossModelFailures(ranResults);
    const multiModelFailures = [...crossModelFailures.entries()]
      .filter(([_, models]) => models.length > 1)
      .sort((a, b) => b[1].length - a[1].length);
    const singleModelFailures = [...crossModelFailures.entries()]
      .filter(([_, models]) => models.length === 1);

    // Compute verdict — only models that actually ran count toward pass/fail
    const allPassed = ranResults.every((r) => r.passRate >= PASS_THRESHOLD);
    const failingModels = ranResults
      .filter((r) => r.passRate < PASS_THRESHOLD)
      .map((r) => r.model);

    // This report only renders cross-model comparison — it needs 2+ models
    // to be meaningful. When a single model runs, @swamp/ci/eval-result
    // (method-scope) handles individual results instead.
    if (ranResults.length < 2) {
      return {
        markdown:
          `_Cross-model analysis skipped — only ${ranResults.length} model(s) evaluated. See individual @swamp/ci/eval-result reports for per-model details._\n`,
        json: {
          skipped: true,
          reason: "cross-model analysis requires 2+ models",
          modelsRun: ranResults.map((r) => r.model),
          modelsSkipped: skippedResults.map((r) => r.model),
        },
      };
    }

    // Build markdown report
    let md = "## Cross-Model Skill Trigger Eval Analysis\n\n";

    // Results table
    md += "### Results\n\n";
    md +=
      "| Model | Pass Rate | Passed | Failed | Tokens | Cost | Duration | Status |\n";
    md +=
      "|-------|-----------|--------|--------|--------|------|----------|--------|\n";
    for (const r of ranResults) {
      const status = r.passRate >= PASS_THRESHOLD ? "✅ Pass" : "❌ Fail";
      md += `| ${r.model} | ${(r.passRate * 100).toFixed(1)}% | ${r.passed} | ${r.failed} | ${r.tokens.total.toLocaleString()} | $${r.cost.toFixed(2)} | ${formatDuration(r.durationMs)} | ${status} |\n`;
    }

    if (skippedResults.length > 0) {
      md += `\n_${skippedResults.length} model(s) were not selected for this run: ${skippedResults.map((r) => r.model).join(", ")}_\n`;
    }

    // Cross-model failures
    if (multiModelFailures.length > 0) {
      md += "\n### Cross-Model Failures\n\n";
      md +=
        "These tests fail on multiple models, suggesting skill description issues:\n\n";
      md += "| Test | Models Failing | Count |\n";
      md += "|------|---------------|-------|\n";
      for (const [desc, models] of multiModelFailures) {
        const escapedDesc = desc.replace(/\|/g, "\\|");
        md +=
          `| ${escapedDesc} | ${models.join(", ")} | ${models.length}/${ranResults.length} |\n`;
      }
    }

    // Model-specific failures
    if (singleModelFailures.length > 0) {
      md += "\n### Model-Specific Failures\n\n";
      md +=
        "These tests fail on only one model, suggesting model-specific quirks:\n\n";
      md += "| Test | Model |\n";
      md += "|------|-------|\n";
      for (const [desc, models] of singleModelFailures) {
        const escapedDesc = desc.replace(/\|/g, "\\|");
        md += `| ${escapedDesc} | ${models[0]} |\n`;
      }
    }

    // Verdict
    md += "\n### Verdict\n\n";
    if (allPassed) {
      md += `✅ **All evaluated models pass** the 90% threshold (${ranResults.length}/${ranResults.length}).\n`;
    } else {
      md +=
        "❌ **Action required** — the following models are below the 90% threshold:\n\n";
      for (const model of failingModels) {
        const r = ranResults.find((r) => r.model === model)!;
        md += `- **${model}**: ${(r.passRate * 100).toFixed(1)}%\n`;
      }
    }

    // Build JSON report
    const json = {
      verdict: allPassed ? "pass" : "fail",
      threshold: PASS_THRESHOLD,
      failingModels,
      skippedModels: skippedResults.map((r) => r.model),
      models: ranResults.map((r) => ({
        model: r.model,
        passRate: r.passRate,
        passed: r.passed,
        failed: r.failed,
        tokens: r.tokens.total,
        cost: r.cost,
        durationMs: r.durationMs,
        status: r.passRate >= PASS_THRESHOLD ? "pass" : "fail",
      })),
      crossModelFailures: multiModelFailures.map(([test, models]) => ({
        test,
        models,
        count: models.length,
      })),
      modelSpecificFailures: singleModelFailures.map(([test, models]) => ({
        test,
        model: models[0],
      })),
    };

    return { markdown: md, json };
  },
};
