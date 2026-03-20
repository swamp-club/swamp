// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
 * Skill trigger evaluation script that tests whether user prompts trigger the
 * correct bundled skills. Spawns `claude -p` subprocesses with stream-json
 * output to detect whether Claude invokes the Skill or Read tool for the
 * skill under test.
 *
 * Each skill can provide an `evals/trigger_evals.json` file containing test
 * queries with expected trigger/no-trigger outcomes.
 *
 * Usage: deno run eval-skill-triggers [--skill <name>] [--model <model>] [--verbose]
 *
 * Options (via environment variables):
 *   EVAL_WORKERS        - Parallel claude -p workers (default: 5)
 *   EVAL_TIMEOUT        - Timeout per query in seconds (default: 30)
 *   EVAL_RUNS           - Runs per query for statistical confidence (default: 3)
 *   EVAL_THRESHOLD      - Trigger rate threshold 0.0–1.0 (default: 0.5)
 *   EVAL_PASS_THRESHOLD - Minimum pass rate for a skill to pass (default: 0.8)
 *   EVAL_MODEL          - Model to use for claude -p
 *   EVAL_SKILL          - Run evals for a single skill only
 *
 * Exit codes:
 *   0 - All skills with eval sets pass their trigger threshold
 *   1 - One or more skills failed or had errors
 */

import { SkillAssets } from "../src/infrastructure/assets/skill_assets.ts";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import { parseArgs } from "@std/cli/parse-args";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single eval query in trigger_evals.json */
interface EvalQuery {
  query: string;
  should_trigger: boolean;
  note?: string;
}

/** Result for a single query (aggregated across runs) */
interface QueryResult {
  query: string;
  should_trigger: boolean;
  trigger_rate: number;
  triggers: number;
  runs: number;
  pass: boolean;
}

/** Full eval output for a skill */
interface EvalOutput {
  skill_name: string;
  description: string;
  results: QueryResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
}

/** Aggregated score for reporting */
interface SkillEvalScore {
  name: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  positiveResults: QueryResult[];
  negativeResults: QueryResult[];
  error?: string;
}

interface EvalConfig {
  workers: number;
  timeout: number;
  runsPerQuery: number;
  triggerThreshold: number;
  model: string | undefined;
  skillFilter: string | undefined;
  passThreshold: number;
  verbose: boolean;
  debug: boolean;
}

// ─── Configuration ───────────────────────────────────────────────────────────

function getConfig(): EvalConfig {
  const args = parseArgs(Deno.args, {
    string: ["skill", "model"],
    boolean: ["verbose", "debug"],
    default: { verbose: false, debug: false },
  });

  return {
    workers: parseInt(Deno.env.get("EVAL_WORKERS") ?? "5"),
    timeout: parseInt(Deno.env.get("EVAL_TIMEOUT") ?? "30"),
    runsPerQuery: parseInt(Deno.env.get("EVAL_RUNS") ?? "3"),
    triggerThreshold: parseFloat(Deno.env.get("EVAL_THRESHOLD") ?? "0.5"),
    model: args.model ?? Deno.env.get("EVAL_MODEL"),
    skillFilter: args.skill ?? Deno.env.get("EVAL_SKILL"),
    passThreshold: parseFloat(Deno.env.get("EVAL_PASS_THRESHOLD") ?? "0.8"),
    verbose: args.verbose,
    debug: args.debug,
  };
}

// ─── SKILL.md parsing ────────────────────────────────────────────────────────

interface SkillFrontmatter {
  name: string;
  description: string;
}

async function parseSkillMd(skillDir: string): Promise<SkillFrontmatter> {
  const content = await Deno.readTextFile(join(skillDir, "SKILL.md"));
  const lines = content.split("\n");

  if (lines[0].trim() !== "---") {
    throw new Error(`SKILL.md in ${skillDir} missing frontmatter (no opening ---)`);
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new Error(`SKILL.md in ${skillDir} missing frontmatter (no closing ---)`);
  }

  const yamlBlock = lines.slice(1, endIdx).join("\n");
  const parsed = parseYaml(yamlBlock) as Record<string, unknown>;

  const name = typeof parsed.name === "string" ? parsed.name : "";
  const description = typeof parsed.description === "string"
    ? parsed.description
    : "";

  if (!name || !description) {
    throw new Error(`SKILL.md in ${skillDir} missing name or description in frontmatter`);
  }

  return { name, description };
}

// ─── Eval set loading & validation ───────────────────────────────────────────

async function loadEvalSet(skillDir: string): Promise<EvalQuery[] | null> {
  const evalPath = join(skillDir, "evals", "trigger_evals.json");
  try {
    const content = await Deno.readTextFile(evalPath);
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) {
      console.error(`  Warning: ${evalPath} is not a JSON array, skipping`);
      return null;
    }
    return parsed as EvalQuery[];
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }
}

function validateEvalSet(evalSet: EvalQuery[], skillName: string): string[] {
  const errors: string[] = [];

  if (evalSet.length === 0) {
    errors.push(`${skillName}: eval set is empty`);
    return errors;
  }

  const hasPositive = evalSet.some((q) => q.should_trigger);
  const hasNegative = evalSet.some((q) => !q.should_trigger);

  if (!hasPositive) {
    errors.push(
      `${skillName}: eval set has no positive (should_trigger: true) cases`,
    );
  }
  if (!hasNegative) {
    errors.push(
      `${skillName}: eval set has no negative (should_trigger: false) cases`,
    );
  }

  for (let i = 0; i < evalSet.length; i++) {
    const item = evalSet[i];
    if (typeof item.query !== "string" || item.query.trim() === "") {
      errors.push(`${skillName}: eval[${i}] has empty or missing query`);
    }
    if (typeof item.should_trigger !== "boolean") {
      errors.push(`${skillName}: eval[${i}] has non-boolean should_trigger`);
    }
  }

  return errors;
}

// ─── Single query runner ─────────────────────────────────────────────────────

/**
 * Find the project root by walking up from cwd looking for .claude/.
 * Mirrors the logic in run_eval.py.
 */
function findProjectRoot(): string {
  let current = Deno.cwd();
  while (true) {
    try {
      Deno.statSync(join(current, ".claude"));
      return current;
    } catch {
      const parent = join(current, "..");
      if (parent === current) return Deno.cwd();
      current = parent;
    }
  }
}

/**
 * Run a single query against `claude -p` and detect whether an existing skill
 * was triggered. The bundled skills are already installed in .claude/skills/,
 * so we just run the query and check if Claude calls the Skill or Read tool
 * targeting the skill under test.
 *
 * A skill is considered "triggered" if Claude's first tool call is either:
 *   - Skill({ skill: "<skillName>" })
 *   - Read({ file_path: ".../<skillName>/..." })
 */
async function runSingleQuery(
  query: string,
  skillName: string,
  _skillDescription: string,
  timeoutSec: number,
  projectRoot: string,
  model: string | undefined,
  debug: boolean = false,
): Promise<boolean> {
  if (debug) {
    console.error(`  [debug] query: "${query.slice(0, 80)}"`);
    console.error(`  [debug] skillName: ${skillName}`);
    console.error(`  [debug] projectRoot: ${projectRoot}`);
  }

  const args = [
    "-p",
    query,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  if (model) {
    args.push("--model", model);
  }

  // Remove CLAUDECODE env var to allow nesting claude -p inside a Claude
  // Code session. The guard is for interactive terminal conflicts;
  // programmatic subprocess usage is safe.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(Deno.env.toObject())) {
    if (k !== "CLAUDECODE") {
      env[k] = v;
    }
  }

  const command = new Deno.Command("claude", {
    args,
    stdout: "piped",
    stderr: "null",
    cwd: projectRoot,
    env,
  });

  const process = command.spawn();

  // Read stdout as a stream and parse line-by-line
  const reader = process.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pendingToolName: string | null = null;
  let accumulatedJson = "";

  const timeoutMs = timeoutSec * 1000;
  const startTime = Date.now();

  /**
   * Check whether the accumulated JSON from a Skill or Read tool call
   * references the target skill. Matches the skill name as a value
   * (e.g., "swamp-vault") and also matches Read calls to paths containing
   * the skill directory name (e.g., ".claude/skills/swamp-vault/SKILL.md").
   */
  function matchesSkill(json: string): boolean {
    return json.includes(`"${skillName}"`) ||
      json.includes(`/${skillName}/`) ||
      json.includes(`/${skillName}"`);
  }

  try {
    while (Date.now() - startTime < timeoutMs) {
      const readResult = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(
            () => resolve({ done: true, value: undefined }),
            timeoutMs - (Date.now() - startTime),
          )
        ),
      ]);

      if (readResult.done) break;

      buffer += decoder.decode(readResult.value, { stream: true });

      while (buffer.includes("\n")) {
        const newlineIdx = buffer.indexOf("\n");
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line) continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (debug) {
          const evType = event.type as string;
          if (evType === "stream_event") {
            const se = event.event as Record<string, unknown> | undefined;
            const seType = se?.type as string ?? "?";
            if (seType === "content_block_start") {
              const cb = se?.content_block as
                | Record<string, unknown>
                | undefined;
              console.error(
                `  [debug] stream_event: ${seType} block_type=${cb?.type} name=${cb?.name ?? "-"}`,
              );
            } else if (seType === "content_block_delta") {
              const delta = se?.delta as
                | Record<string, unknown>
                | undefined;
              console.error(
                `  [debug] stream_event: ${seType} delta_type=${delta?.type}`,
              );
            } else {
              console.error(`  [debug] stream_event: ${seType}`);
            }
          } else if (evType === "assistant") {
            const message = event.message as
              | Record<string, unknown>
              | undefined;
            const content = (message?.content ?? []) as Record<
              string,
              unknown
            >[];
            const toolCalls = content
              .filter((c) => c.type === "tool_use")
              .map(
                (c) =>
                  `${c.name}(${JSON.stringify(c.input).slice(0, 100)})`,
              );
            const textBlocks = content
              .filter((c) => c.type === "text")
              .map((c) => `text(${(c.text as string).slice(0, 60)}…)`);
            console.error(
              `  [debug] assistant message: ${
                [...toolCalls, ...textBlocks].join(", ") || "empty"
              }`,
            );
          } else {
            console.error(`  [debug] event type=${evType}`);
          }
        }

        // Early detection via stream events
        if (event.type === "stream_event") {
          const se = event.event as Record<string, unknown> | undefined;
          if (!se) continue;
          const seType = se.type as string;

          if (seType === "content_block_start") {
            const cb = se.content_block as
              | Record<string, unknown>
              | undefined;
            if (cb?.type === "tool_use") {
              const toolName = cb.name as string;
              if (toolName === "Skill" || toolName === "Read") {
                pendingToolName = toolName;
                accumulatedJson = "";
              } else {
                // Claude called a different tool first — not our skill
                return false;
              }
            }
          } else if (seType === "content_block_delta" && pendingToolName) {
            const delta = se.delta as Record<string, unknown> | undefined;
            if (delta?.type === "input_json_delta") {
              accumulatedJson += (delta.partial_json as string) ?? "";
              if (matchesSkill(accumulatedJson)) {
                return true;
              }
            }
          } else if (
            seType === "content_block_stop" || seType === "message_stop"
          ) {
            if (pendingToolName) {
              return matchesSkill(accumulatedJson);
            }
            if (seType === "message_stop") {
              return false;
            }
          }
        }

        // Fallback: full assistant message
        if (event.type === "assistant") {
          const message = event.message as
            | Record<string, unknown>
            | undefined;
          const content = (message?.content ?? []) as Record<
            string,
            unknown
          >[];
          for (const item of content) {
            if (item.type !== "tool_use") continue;
            const toolName = item.name as string;
            const toolInput = item.input as Record<string, unknown>;
            if (
              toolName === "Skill" &&
              (toolInput.skill as string ?? "").includes(skillName)
            ) {
              return true;
            }
            if (
              toolName === "Read" &&
              (toolInput.file_path as string ?? "").includes(
                `/${skillName}/`,
              )
            ) {
              return true;
            }
            return false;
          }
        }

        if (event.type === "result") {
          return false;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch { /* ignore */ }
    try {
      process.kill();
    } catch { /* already exited */ }
  }

  return false;
}

// ─── Concurrency pool ────────────────────────────────────────────────────────

/**
 * Run async tasks with a concurrency limit.
 */
async function pooled<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++;
      results[idx] = await tasks[idx]();
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, tasks.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// ─── Skill eval runner ───────────────────────────────────────────────────────

async function runSkillEval(
  skillName: string,
  skillDir: string,
  evalSet: EvalQuery[],
  config: EvalConfig,
): Promise<EvalOutput> {
  const { description } = await parseSkillMd(skillDir);
  const projectRoot = findProjectRoot();

  // Build tasks: each query × runsPerQuery
  interface RunInfo {
    query: string;
    should_trigger: boolean;
    runIndex: number;
  }

  const runInfos: RunInfo[] = [];
  const tasks: (() => Promise<boolean>)[] = [];
  let isFirstTask = true;

  for (const item of evalSet) {
    for (let r = 0; r < config.runsPerQuery; r++) {
      runInfos.push({
        query: item.query,
        should_trigger: item.should_trigger,
        runIndex: r,
      });
      // Only enable debug on the very first run to avoid flooding output
      const enableDebug = config.debug && isFirstTask;
      isFirstTask = false;
      tasks.push(() =>
        runSingleQuery(
          item.query,
          skillName,
          description,
          config.timeout,
          projectRoot,
          config.model,
          enableDebug,
        )
      );
    }
  }

  // Run with concurrency pool
  const triggerResults = await pooled(tasks, config.workers);

  // Aggregate by query
  const queryTriggers = new Map<string, boolean[]>();
  const queryItems = new Map<string, EvalQuery>();

  for (let i = 0; i < runInfos.length; i++) {
    const info = runInfos[i];
    if (!queryTriggers.has(info.query)) {
      queryTriggers.set(info.query, []);
    }
    queryTriggers.get(info.query)!.push(triggerResults[i]);

    if (!queryItems.has(info.query)) {
      const evalItem = evalSet.find((e) => e.query === info.query)!;
      queryItems.set(info.query, evalItem);
    }
  }

  const results: QueryResult[] = [];
  for (const [query, triggers] of queryTriggers) {
    const item = queryItems.get(query)!;
    const triggerCount = triggers.filter(Boolean).length;
    const triggerRate = triggerCount / triggers.length;
    const shouldTrigger = item.should_trigger;

    const didPass = shouldTrigger
      ? triggerRate >= config.triggerThreshold
      : triggerRate < config.triggerThreshold;

    results.push({
      query,
      should_trigger: shouldTrigger,
      trigger_rate: triggerRate,
      triggers: triggerCount,
      runs: triggers.length,
      pass: didPass,
    });
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;

  return {
    skill_name: skillName,
    description,
    results,
    summary: {
      total,
      passed,
      failed: total - passed,
    },
  };
}

// ─── Summary table ───────────────────────────────────────────────────────────

function buildSummaryTable(
  scores: SkillEvalScore[],
  allPassed: boolean,
): string {
  const lines: string[] = ["## Skill Trigger Eval Results\n"];

  lines.push("| Skill | Queries | Passed | Failed | Pass Rate | Status |");
  lines.push("|-------|---------|--------|--------|-----------|--------|");

  for (const score of scores) {
    const rate = `${(score.passRate * 100).toFixed(0)}%`;
    const status = score.error
      ? "Error"
      : score.passRate >= 0.8
      ? "Pass"
      : "Fail";
    lines.push(
      `| ${score.name} | ${score.total} | ${score.passed} | ${score.failed} | ${rate} | ${status} |`,
    );
  }

  lines.push("");

  if (allPassed) {
    lines.push("All skills pass the trigger eval threshold.");
  } else {
    lines.push("One or more skills failed the trigger eval threshold.");
  }

  // Detail failed queries
  const failures = scores.filter(
    (s) =>
      s.positiveResults.some((r) => !r.pass) ||
      s.negativeResults.some((r) => !r.pass),
  );
  if (failures.length > 0) {
    lines.push("");
    lines.push("### Failed Queries\n");
    for (const score of failures) {
      const failedPositives = score.positiveResults.filter((r) => !r.pass);
      const failedNegatives = score.negativeResults.filter((r) => !r.pass);

      if (failedPositives.length > 0) {
        lines.push(`**${score.name}** — missed triggers:`);
        for (const r of failedPositives) {
          lines.push(`- "${r.query}" (triggered ${r.triggers}/${r.runs})`);
        }
        lines.push("");
      }
      if (failedNegatives.length > 0) {
        lines.push(`**${score.name}** — false triggers:`);
        for (const r of failedNegatives) {
          lines.push(`- "${r.query}" (triggered ${r.triggers}/${r.runs})`);
        }
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = getConfig();
  const assets = new SkillAssets();
  let skillNames = assets.getSkillNames();

  if (config.skillFilter) {
    if (!skillNames.includes(config.skillFilter)) {
      console.error(
        `Error: skill "${config.skillFilter}" not found. Available: ${
          skillNames.join(", ")
        }`,
      );
      Deno.exit(1);
    }
    skillNames = [config.skillFilter];
  }

  console.log(`Evaluating triggers for ${skillNames.length} skills…`);
  console.log(
    `  workers=${config.workers} timeout=${config.timeout}s runs=${config.runsPerQuery} threshold=${config.triggerThreshold}`,
  );

  const scores: SkillEvalScore[] = [];
  let allPassed = true;
  let skippedCount = 0;

  for (const name of skillNames) {
    const skillDir = join(assets.getSkillsDir(), name);
    const evalSet = await loadEvalSet(skillDir);

    if (!evalSet) {
      console.log(`  ${name}: no evals/trigger_evals.json, skipping`);
      skippedCount++;
      continue;
    }

    // Validate eval set structure
    const validationErrors = validateEvalSet(evalSet, name);
    if (validationErrors.length > 0) {
      for (const err of validationErrors) {
        console.error(`  ${err}`);
      }
      scores.push({
        name,
        total: 0,
        passed: 0,
        failed: 0,
        passRate: 0,
        positiveResults: [],
        negativeResults: [],
        error: validationErrors.join("; "),
      });
      allPassed = false;
      continue;
    }

    console.log(
      `  ${name}: running ${evalSet.length} queries (${config.runsPerQuery} runs each)…`,
    );

    try {
      const output = await runSkillEval(name, skillDir, evalSet, config);
      const { summary } = output;
      const passRate = summary.total > 0
        ? summary.passed / summary.total
        : 0;

      const positiveResults = output.results.filter((r) => r.should_trigger);
      const negativeResults = output.results.filter((r) => !r.should_trigger);

      scores.push({
        name,
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        passRate,
        positiveResults,
        negativeResults,
      });

      if (passRate < config.passThreshold) {
        allPassed = false;
      }

      // Print per-query details
      for (const r of output.results) {
        const status = r.pass ? "PASS" : "FAIL";
        const expected = r.should_trigger
          ? "should trigger"
          : "should NOT trigger";
        console.log(
          `    [${status}] ${r.triggers}/${r.runs} (${expected}): ${
            r.query.slice(0, 70)
          }`,
        );
      }

      console.log(
        `    ${name}: ${summary.passed}/${summary.total} passed (${
          (passRate * 100).toFixed(0)
        }%)`,
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`    Failed to evaluate ${name}: ${msg}`);
      scores.push({
        name,
        total: 0,
        passed: 0,
        failed: 0,
        passRate: 0,
        positiveResults: [],
        negativeResults: [],
        error: msg,
      });
      allPassed = false;
    }
  }

  // Write GitHub Actions summary
  const summary = buildSummaryTable(scores, allPassed);
  const summaryFile = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (summaryFile) {
    await Deno.writeTextFile(summaryFile, summary);
  }

  // Always print summary to console
  console.log(`\n${summary}`);

  if (skippedCount > 0) {
    console.log(`\n${skippedCount} skill(s) skipped (no eval set found).`);
  }

  // Write full results JSON for downstream consumption
  const resultsPath = Deno.env.get("EVAL_RESULTS_PATH");
  if (resultsPath) {
    await Deno.writeTextFile(resultsPath, JSON.stringify(scores, null, 2));
  }

  if (!allPassed) {
    console.error(
      "\nTrigger eval failed: one or more skills below threshold.",
    );
    Deno.exit(1);
  }

  console.log("\nAll skills passed trigger evals.");
  Deno.exit(0);
}

main();
