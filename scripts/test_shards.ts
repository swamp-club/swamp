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

import { join, relative, SEPARATOR } from "@std/path";
import { TextLineStream } from "@std/streams";

export const WEIGHTS_FILE = "scripts/test_shard_weights.json";
export const DEFAULT_WEIGHT_SECONDS = 0.05;
export const RECORD_THRESHOLD_SECONDS = 3;
const MAX_SHARDS = 4;
const CORES_PER_SHARD = 8;

const TEST_FILE = /(^|[_.])test\.(js|mjs|ts|mts|jsx|tsx)$/;
const ANSI = /\x1b\[[0-9;]*m/g;
const RESULT_LINE = /^(ok|FAILED) \| (\d+) passed\b.*?\| (\d+) failed\b(?:.*?\| (\d+) ignored\b)?/;
const FAILURE_HEADING = /^ (ERRORS|FAILURES) $/;
const TEST_LINE = /^\.\/(\S+) => .* \.\.\. (?:ok|FAILED|ignored) \(([^)]+)\)\s*$/;

export function isTestFile(name: string): boolean {
  return TEST_FILE.test(name);
}

export interface TestConfig {
  include: string[];
  exclude: string[];
}

function trimDir(path: string): string {
  return path.replace(/^\.\//, "").replace(/\/+$/, "");
}

export function testConfigFrom(denoJson: unknown): TestConfig {
  const config = (denoJson ?? {}) as {
    exclude?: string[];
    test?: { include?: string[]; exclude?: string[] };
  };
  return {
    include: (config.test?.include ?? ["./"]).map(trimDir),
    exclude: [...(config.exclude ?? []), ...(config.test?.exclude ?? [])].map(
      trimDir,
    ),
  };
}

function toPosix(path: string): string {
  return path.split(SEPARATOR).join("/");
}

// finds what deno test would, from the same include and exclude
export async function discoverTestFiles(
  root: string,
  config: TestConfig,
): Promise<string[]> {
  const excluded = (path: string) =>
    config.exclude.some((e) => e !== "" && (path === e || path.startsWith(`${e}/`)));
  const found = new Set<string>();
  const walk = async (dir: string): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const full = join(dir, entry.name);
      const path = toPosix(relative(root, full));
      if (excluded(path)) continue;
      if (entry.isDirectory) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        await walk(full);
      } else if (entry.isFile && isTestFile(entry.name)) {
        found.add(path);
      }
    }
  };
  for (const include of config.include) {
    const start = include === "" ? root : join(root, include);
    const info = await Deno.stat(start).catch(() => undefined);
    if (info?.isDirectory) await walk(start);
    else if (info?.isFile && !excluded(include)) found.add(include);
  }
  return [...found].sort();
}

/** Longest-first greedy assignment; ties go to the lowest shard. */
export function partition(
  files: readonly string[],
  weights: Readonly<Record<string, number>>,
  shards: number,
): string[][] {
  const weighed = files.map((file) => ({
    file,
    weight: weights[file] ?? DEFAULT_WEIGHT_SECONDS,
  })).sort((a, b) =>
    b.weight - a.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
  );
  const loads = new Array<number>(shards).fill(0);
  const out: string[][] = Array.from({ length: shards }, () => []);
  for (const { file, weight } of weighed) {
    let best = 0;
    for (let i = 1; i < shards; i++) if (loads[i] < loads[best]) best = i;
    out[best].push(file);
    loads[best] += weight;
  }
  return out;
}

export interface ShardPlan {
  shards: number;
  jobs: number;
}

export function shardPlan(
  cores: number,
  requestedShards?: number,
  denoJobs?: string,
): ShardPlan {
  const shards = requestedShards ??
    Math.min(MAX_SHARDS, Math.max(1, Math.floor(cores / CORES_PER_SHARD)));
  const fixedJobs = denoJobs !== undefined ? Number.parseInt(denoJobs, 10) : NaN;
  const jobs = fixedJobs > 0
    ? fixedJobs
    : Math.max(1, Math.floor(cores / shards));
  return { shards, jobs };
}

export interface TestTask {
  env: Record<string, string>;
  flags: string[];
}

/** Reads the test task as `[NAME=value ...] deno test <flags>`. */
export function parseTestTask(denoJson: unknown): TestTask {
  const task = (denoJson as { tasks?: Record<string, unknown> })?.tasks?.test;
  if (typeof task !== "string") throw new Error("deno.json has no test task");
  const words = task.trim().split(/\s+/);
  const env: Record<string, string> = {};
  while (words.length > 0 && /^[A-Z_][A-Z0-9_]*=/.test(words[0])) {
    const [name, ...value] = words.shift()!.split("=");
    env[name] = value.join("=");
  }
  if (words[0] !== "deno" || words[1] !== "test") {
    throw new Error(`The test task does not run deno test: ${task}`);
  }
  return { env, flags: words.slice(2) };
}

export function stripAnsi(line: string): string {
  return line.replace(ANSI, "");
}

export interface ShardCounts {
  passed: number;
  failed: number;
  ignored: number;
  line: string;
}

export function parseResultLine(raw: string): ShardCounts | undefined {
  const line = stripAnsi(raw).trim();
  const match = RESULT_LINE.exec(line);
  if (!match) return undefined;
  return {
    passed: Number(match[2]),
    failed: Number(match[3]),
    ignored: Number(match[4] ?? 0),
    line,
  };
}

/** From the first ERRORS or FAILURES heading up to the result line. */
export function failureBlocks(lines: readonly string[]): string[] {
  const plain = lines.map(stripAnsi);
  const start = plain.findIndex((l) => FAILURE_HEADING.test(l));
  if (start < 0) return [];
  const end = plain.findIndex((l, i) => i > start && RESULT_LINE.test(l.trim()));
  return plain.slice(start, end < 0 ? undefined : end);
}

function seconds(text: string): number {
  let total = 0;
  for (const [, n, unit] of text.matchAll(/(\d+(?:\.\d+)?)(ms|µs|m|s)/g)) {
    const value = Number(n);
    total += unit === "m"
      ? value * 60
      : unit === "s"
      ? value
      : unit === "ms"
      ? value / 1_000
      : value / 1_000_000;
  }
  return total;
}

/** Summed test seconds per file, keeping files at or over the threshold. */
export function weightsFromLines(
  lines: Iterable<string>,
): Record<string, number> {
  const totals = new Map<string, number>();
  for (const raw of lines) {
    const match = TEST_LINE.exec(stripAnsi(raw));
    if (!match) continue;
    totals.set(match[1], (totals.get(match[1]) ?? 0) + seconds(match[2]));
  }
  return Object.fromEntries(
    [...totals].filter(([, s]) => s >= RECORD_THRESHOLD_SECONDS)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([file, s]) => [file, Math.round(s * 10) / 10]),
  );
}

export interface ShardOutcome {
  code: number;
  signal: string | null;
  leftovers: string[];
}

export function combinedExitCode(outcomes: readonly ShardOutcome[]): number {
  return outcomes.every((o) =>
      o.code === 0 && o.signal === null && o.leftovers.length === 0
    )
    ? 0
    : 1;
}

const SHARD_DIR_NAMES = "0123456789abcdefghijklmnopqrstuvwxyz";

// one-character names keep TMPDIR short for tests' socket and tar paths;
// exclusive mkdir keeps concurrent runs apart
export async function allocateShardDirs(
  base: string,
  count: number,
): Promise<string[]> {
  const dirs: string[] = [];
  for (const name of SHARD_DIR_NAMES) {
    if (dirs.length === count) break;
    const dir = join(base, name);
    try {
      await Deno.mkdir(dir);
      dirs.push(dir);
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
  }
  if (dirs.length < count) {
    await Promise.all(dirs.map((d) => Deno.remove(d, { recursive: true })));
    throw new Error(
      `No free shard directories left in ${base}; remove stale single-character directories there`,
    );
  }
  return dirs;
}

export interface CliOptions {
  shards?: number;
  recordWeights: boolean;
  passThrough: string[];
}

export function parseCliArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = { recordWeights: false, passThrough: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--record-weights") {
      options.recordWeights = true;
    } else if (arg === "--shards" || arg.startsWith("--shards=")) {
      const value = arg === "--shards" ? args[++i] : arg.slice(9);
      const shards = Number(value);
      if (!Number.isInteger(shards) || shards < 1) {
        throw new Error(`--shards needs a whole number of at least 1, not ${value}`);
      }
      options.shards = shards;
    } else if (!arg.startsWith("-") && (arg.includes("/") || isTestFile(arg))) {
      throw new Error(
        `test-shards runs the whole suite; run one file with deno run test ${arg}`,
      );
    } else {
      options.passThrough.push(arg);
    }
  }
  return options;
}

interface ShardRun {
  index: number;
  files: number;
  lines: string[];
  outcome: ShardOutcome;
  wallMs: number;
}

function readWeights(root: string): Record<string, number> {
  try {
    const parsed = JSON.parse(Deno.readTextFileSync(join(root, WEIGHTS_FILE)));
    return (parsed?.secondsByFile ?? {}) as Record<string, number>;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {};
    throw error;
  }
}

async function pipeLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const lines = stream.pipeThrough(new TextDecoderStream()).pipeThrough(
    new TextLineStream(),
  );
  for await (const line of lines) onLine(line);
}

async function runShard(
  index: number,
  files: readonly string[] | undefined,
  root: string,
  task: TestTask,
  passThrough: readonly string[],
  jobs: number,
  tmp: string,
  children: Set<Deno.ChildProcess>,
): Promise<ShardRun> {
  const started = Date.now();
  const encoder = new TextEncoder();
  const prefix = `[${index}] `;
  const lines: string[] = [];
  // deno by name, which is what the task's --allow-run=deno resolves
  const child = new Deno.Command("deno", {
    args: ["test", ...task.flags, ...passThrough, ...(files ?? [])],
    cwd: root,
    env: {
      ...task.env,
      NO_COLOR: "1",
      DENO_JOBS: String(jobs),
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  children.add(child);
  const onLine = (line: string) => {
    lines.push(line);
    // one whole line per write, so shards never split each other's lines
    const bytes = encoder.encode(`${prefix}${line}\n`);
    for (let written = 0; written < bytes.length;) {
      written += Deno.stdout.writeSync(bytes.subarray(written));
    }
  };
  const [status] = await Promise.all([
    child.status,
    pipeLines(child.stdout, onLine),
    pipeLines(child.stderr, onLine),
  ]);
  children.delete(child);
  const leftovers: string[] = [];
  for await (const entry of Deno.readDir(tmp)) {
    leftovers.push(join(tmp, entry.name));
  }
  return {
    index,
    files: files?.length ?? 0,
    lines,
    outcome: { code: status.code, signal: status.signal, leftovers },
    wallMs: Date.now() - started,
  };
}

function printSummary(runs: readonly ShardRun[], wallMs: number): void {
  const out: string[] = ["", "test-shards summary"];
  let passed = 0, failed = 0, ignored = 0;
  for (const run of runs) {
    const counts = run.lines.map(parseResultLine).findLast((c) =>
      c !== undefined
    );
    passed += counts?.passed ?? 0;
    failed += counts?.failed ?? 0;
    ignored += counts?.ignored ?? 0;
    const files = run.files > 0 ? `${run.files} files` : "all files";
    const exit = run.outcome.signal ?? `exit ${run.outcome.code}`;
    out.push(
      `  shard ${run.index}: ${files}, ${Math.round(run.wallMs / 1000)}s, ${exit}: ${
        counts?.line ?? "no result line"
      }`,
    );
  }
  out.push(
    `  total: ${passed} passed | ${failed} failed | ${ignored} ignored (${
      Math.round(wallMs / 1000)
    }s)`,
  );
  for (const run of runs) {
    const ok = run.outcome.code === 0 && run.outcome.signal === null;
    if (!ok) {
      out.push("", `shard ${run.index} failures:`, ...failureBlocks(run.lines));
    }
    if (run.outcome.leftovers.length > 0) {
      out.push(
        "",
        `shard ${run.index} left temp entries behind; remove each when its test ends:`,
        ...run.outcome.leftovers.map((p) => `  ${p}`),
      );
    }
  }
  console.log(out.join("\n"));
}

async function main(args: string[]): Promise<number> {
  const options = parseCliArgs(args);
  const root = Deno.cwd();
  const denoJson = JSON.parse(await Deno.readTextFile(join(root, "deno.json")));
  const task = parseTestTask(denoJson);
  const isWindows = Deno.build.os === "windows";
  const plan = shardPlan(
    navigator.hardwareConcurrency ?? 1,
    isWindows ? 1 : options.shards,
    Deno.env.get("DENO_JOBS"),
  );
  let groups: (string[] | undefined)[] = [undefined];
  if (plan.shards > 1) {
    const files = await discoverTestFiles(root, testConfigFrom(denoJson));
    groups = partition(files, readWeights(root), plan.shards);
  }

  const tmpBase = Deno.env.get("TMPDIR") ?? Deno.env.get("TMP") ??
    Deno.env.get("TEMP") ?? "/tmp";
  const shardDirs = await allocateShardDirs(tmpBase, groups.length);
  const children = new Set<Deno.ChildProcess>();
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already exited.
      }
    }
  };
  const signals: Deno.Signal[] = isWindows ? ["SIGINT"] : ["SIGINT", "SIGTERM"];
  for (const signal of signals) Deno.addSignalListener(signal, stop);

  const started = Date.now();
  try {
    console.log(
      `test-shards: ${groups.length} shard(s) x ${plan.jobs} jobs`,
    );
    const runs = await Promise.all(
      groups.map((files, index) =>
        runShard(
          index,
          files,
          root,
          task,
          options.passThrough,
          plan.jobs,
          shardDirs[index],
          children,
        )
      ),
    );
    printSummary(runs, Date.now() - started);
    if (options.recordWeights) {
      const weights = weightsFromLines(runs.flatMap((r) => r.lines));
      await Deno.writeTextFile(
        join(root, WEIGHTS_FILE),
        `${JSON.stringify({ secondsByFile: weights }, null, 2)}\n`,
      );
      console.log(`Wrote ${Object.keys(weights).length} weights to ${WEIGHTS_FILE}`);
    }
    if (interrupted) return 130;
    return combinedExitCode(runs.map((r) => r.outcome));
  } finally {
    for (const signal of signals) Deno.removeSignalListener(signal, stop);
    await Promise.all(
      shardDirs.map((dir) => Deno.remove(dir, { recursive: true }).catch(() => {})),
    );
  }
}

if (import.meta.main) {
  try {
    Deno.exit(await main(Deno.args));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
