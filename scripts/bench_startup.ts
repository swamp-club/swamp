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

import { parseArgs } from "@std/cli/parse-args";
import { basename, join } from "@std/path";
import { senderArgs } from "../src/infrastructure/telemetry/telemetry_sender_process.ts";
import { childEnv, preflight } from "./swamp_child_env.ts";

export const MIN_RUNS = 5;
const DEFAULT_TIMEOUT_MS = 60_000;
// python3 startup and JSON parsing on top of the child's own deadline
const PYTHON_GRACE_MS = 10_000;
const BYTES_PER_MIB = 1024 * 1024;

const USAGE =
  `usage: deno run bench-startup <binary> [--runs N] [--timeout-ms MS]

  --runs N         runs per median, at least ${MIN_RUNS} (default ${MIN_RUNS})
  --timeout-ms MS  deadline for one run (default ${DEFAULT_TIMEOUT_MS})`;

export interface BenchArgs {
  binary: string;
  runs: number;
  timeoutMs: number;
}

function positiveInteger(flag: string, value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `${flag} must be a positive integer, got ${value}\n\n${USAGE}`,
    );
  }
  return parsed;
}

export function parseBenchArgs(args: readonly string[]): BenchArgs {
  const parsed = parseArgs([...args], {
    string: ["runs", "timeout-ms"],
    unknown: (arg) => {
      if (arg.startsWith("-")) {
        throw new Error(`unknown option ${arg}\n\n${USAGE}`);
      }
      return true;
    },
  });
  if (parsed._.length !== 1) {
    throw new Error(`expected one binary path\n\n${USAGE}`);
  }
  const runs = parsed.runs === undefined
    ? MIN_RUNS
    : positiveInteger("--runs", parsed.runs);
  if (runs < MIN_RUNS) {
    throw new Error(
      `--runs must be at least ${MIN_RUNS}, got ${runs}\n\n${USAGE}`,
    );
  }
  return {
    binary: String(parsed._[0]),
    runs,
    timeoutMs: parsed["timeout-ms"] === undefined
      ? DEFAULT_TIMEOUT_MS
      : positiveInteger("--timeout-ms", parsed["timeout-ms"]),
  };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of no values");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * a compiled binary keeps its V8 code cache under TMPDIR, named by its own file
 * name after symlinks resolve; pass the real path
 */
export function codeCachePath(tmpDir: string, binaryPath: string): string {
  return join(tmpDir, `deno-compile-${basename(binaryPath)}.cache`);
}

/** ru_maxrss is KiB on Linux and bytes on macOS */
export function maxRssBytes(
  ruMaxrss: number,
  os: typeof Deno.build.os,
): number {
  return os === "darwin" ? ruMaxrss : ruMaxrss * 1024;
}

export interface BenchContext {
  /** a fresh lock token per run, so it can never match a live sender's lock */
  newToken(): string;
}

export interface BenchCommand {
  label: string;
  args(context: BenchContext): string[];
}

export const BENCH_MODEL = "bench-shell";
export const BENCH_WORKFLOW = "bench-flow";

export const BENCH_COMMANDS: readonly BenchCommand[] = [
  { label: "version", args: () => ["version"] },
  { label: "--help", args: () => ["--help"] },
  { label: "help data get", args: () => ["help", "data", "get"] },
  { label: "data get", args: () => ["data", "get", BENCH_MODEL, "result"] },
  {
    label: "behavior run",
    args: () => ["behavior", "run", BENCH_MODEL, "execute"],
  },
  { label: "workflow run", args: () => ["workflow", "run", BENCH_WORKFLOW] },
  {
    label: "telemetry sender",
    // no lock file holds the token, so the sender exits right after dispatch
    args: (context) =>
      senderArgs(context.newToken(), {
        endpoint: "http://127.0.0.1:9",
        userAgent: "swamp-bench-startup",
        keepFlushed: false,
      }),
  },
];

export interface RusageReport {
  exitCode: number;
  wallNs: number;
  maxRss: number;
  timedOut: boolean;
}

export function parseRusageReport(text: string): RusageReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`unreadable report from the rusage helper: ${text}`);
  }
  const report = parsed as Partial<Record<keyof RusageReport, unknown>> | null;
  if (
    typeof report?.exitCode !== "number" ||
    typeof report.wallNs !== "number" ||
    typeof report.maxRss !== "number" ||
    typeof report.timedOut !== "boolean"
  ) {
    throw new Error(`unexpected report from the rusage helper: ${text}`);
  }
  return {
    exitCode: report.exitCode,
    wallNs: report.wallNs,
    maxRss: report.maxRss,
    timedOut: report.timedOut,
  };
}

export interface Measurement {
  wallMs: number;
  rssBytes: number;
}

export interface Summary {
  wallMs: number;
  rssMiB: number;
}

export interface BenchRow {
  label: string;
  cold: Summary;
  warm: Summary;
}

export function summarize(measurements: readonly Measurement[]): Summary {
  return {
    wallMs: median(measurements.map((m) => m.wallMs)),
    rssMiB: median(measurements.map((m) => m.rssBytes)) / BYTES_PER_MIB,
  };
}

export function formatTable(
  binary: string,
  runs: number,
  rows: readonly BenchRow[],
): string {
  const lines = [
    `bench-startup: ${binary} (median of ${runs} runs)`,
    "",
    "| command | cold ms | cold MiB | warm ms | warm MiB |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...rows.map((row) =>
      `| ${row.label} | ${Math.round(row.cold.wallMs)} | ${
        row.cold.rssMiB.toFixed(1)
      } | ${Math.round(row.warm.wallMs)} | ${row.warm.rssMiB.toFixed(1)} |`
    ),
  ];
  return lines.join("\n");
}

/** patches one line of a generated file, failing loudly if its shape changed */
export function replaceOnce(
  text: string,
  from: string,
  to: string,
  file: string,
): string {
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + from.length) >= 0) {
    throw new Error(
      `${file}: expected exactly one ${
        JSON.stringify(from)
      }; the generated layout changed`,
    );
  }
  return text.slice(0, at) + to + text.slice(at + from.length);
}

// timing starts at spawn, so python's own startup is not measured; the timer
// kills a hung child so wait4 returns
const RUSAGE_PROGRAM = `
import json, os, signal, sys, threading, time
argv = json.loads(sys.argv[1])
out_fd = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
err_fd = os.open(sys.argv[3], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
in_fd = os.open(os.devnull, os.O_RDONLY)
actions = [
    (os.POSIX_SPAWN_DUP2, in_fd, 0),
    (os.POSIX_SPAWN_DUP2, out_fd, 1),
    (os.POSIX_SPAWN_DUP2, err_fd, 2),
]
timed_out = []
start = time.perf_counter_ns()
pid = os.posix_spawn(argv[0], argv, os.environ, file_actions=actions)
def kill():
    timed_out.append(True)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
timer = threading.Timer(float(sys.argv[4]), kill)
timer.start()
_, status, usage = os.wait4(pid, 0)
wall = time.perf_counter_ns() - start
timer.cancel()
print(json.dumps({
    "exitCode": os.waitstatus_to_exitcode(status),
    "wallNs": wall,
    "maxRss": usage.ru_maxrss,
    "timedOut": bool(timed_out),
}))
`;

interface RunSite {
  binary: string;
  cwd: string;
  env: Record<string, string>;
  outDir: string;
  timeoutMs: number;
}

const decoder = new TextDecoder();

async function measure(site: RunSite, args: string[]): Promise<Measurement> {
  const stdoutFile = join(site.outDir, "stdout");
  const stderrFile = join(site.outDir, "stderr");
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command("python3", {
      args: [
        "-I",
        "-c",
        RUSAGE_PROGRAM,
        JSON.stringify([site.binary, ...args]),
        stdoutFile,
        stderrFile,
        String(site.timeoutMs / 1000),
      ],
      cwd: site.cwd,
      env: site.env,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(site.timeoutMs + PYTHON_GRACE_MS),
    }).output();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error("bench-startup needs python3 on PATH to read peak RSS");
    }
    throw error;
  }
  if (!output.success) {
    throw new Error(
      `the rusage helper failed: ${decoder.decode(output.stderr)}`,
    );
  }
  const report = parseRusageReport(decoder.decode(output.stdout));
  const invocation = `swamp ${args.join(" ")}`;
  if (report.timedOut) {
    throw new Error(`${invocation} timed out after ${site.timeoutMs} ms`);
  }
  if (report.exitCode !== 0) {
    const stderr = await Deno.readTextFile(stderrFile);
    throw new Error(`${invocation} exited ${report.exitCode}:\n${stderr}`);
  }
  return {
    wallMs: report.wallNs / 1e6,
    rssBytes: maxRssBytes(report.maxRss, Deno.build.os),
  };
}

async function runSetup(site: RunSite, args: string[]): Promise<void> {
  const { code, stderr } = await new Deno.Command(site.binary, {
    args,
    cwd: site.cwd,
    env: site.env,
    clearEnv: true,
    stdin: "null",
    stdout: "null",
    stderr: "piped",
    signal: AbortSignal.timeout(site.timeoutMs),
  }).output();
  if (code !== 0) {
    throw new Error(
      `setup: swamp ${args.join(" ")} exited ${code}:\n${
        decoder.decode(stderr)
      }`,
    );
  }
}

async function patchFile(
  path: string,
  from: string,
  to: string,
): Promise<void> {
  const text = await Deno.readTextFile(path);
  await Deno.writeTextFile(path, replaceOnce(text, from, to, path));
}

async function setUpRepo(site: RunSite): Promise<void> {
  await runSetup(site, ["repo", "init", "--tool", "none", "--no-vault"]);
  await runSetup(site, ["behavior", "create", "command/shell", BENCH_MODEL]);
  await patchFile(
    join(site.cwd, "models", "command", "shell", `${BENCH_MODEL}.yaml`),
    "methods: {}",
    "methods:\n  execute:\n    arguments:\n      run: echo bench\n",
  );
  await runSetup(site, ["workflow", "create", BENCH_WORKFLOW]);
  const workflowFile = join(
    site.cwd,
    "workflows",
    `workflow-${BENCH_WORKFLOW}.yaml`,
  );
  await patchFile(
    workflowFile,
    "modelIdOrName: example-behavior",
    `modelIdOrName: ${BENCH_MODEL}`,
  );
  await patchFile(workflowFile, "methodName: run", "methodName: execute");
  await runSetup(site, ["behavior", "run", BENCH_MODEL, "execute"]);
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function benchCommand(
  site: RunSite,
  command: BenchCommand,
  runs: number,
  cachePath: string,
): Promise<BenchRow> {
  const context: BenchContext = { newToken: () => crypto.randomUUID() };
  const cold: Measurement[] = [];
  for (let i = 0; i < runs; i++) {
    await removeIfPresent(cachePath);
    cold.push(await measure(site, command.args(context)));
  }
  await measure(site, command.args(context));
  if (!await exists(cachePath)) {
    // without this, a Deno that moved its cache would report cold equal to warm
    throw new Error(
      `no code cache at ${cachePath} after a warm run of ${command.label}; Deno may have moved it, so codeCachePath needs updating`,
    );
  }
  const warm: Measurement[] = [];
  for (let i = 0; i < runs; i++) {
    warm.push(await measure(site, command.args(context)));
  }
  return { label: command.label, cold: summarize(cold), warm: summarize(warm) };
}

async function main(): Promise<number> {
  let args: BenchArgs;
  try {
    args = parseBenchArgs(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (Deno.build.os === "windows") {
    console.error(
      "bench-startup reads peak RSS with wait4, which Windows lacks",
    );
    return 1;
  }
  const binary = await Deno.realPath(args.binary);
  const scratch = await Deno.makeTempDir({ prefix: "swamp-bench-startup-" });
  try {
    const site: RunSite = {
      binary,
      cwd: join(scratch, "repo"),
      env: childEnv(Deno.env.toObject(), join(scratch, "tmp")),
      outDir: join(scratch, "out"),
      timeoutMs: args.timeoutMs,
    };
    for (const dir of [site.cwd, join(scratch, "tmp"), site.outDir]) {
      await Deno.mkdir(dir);
    }
    await preflight(binary, site.cwd, site.env, args.timeoutMs);
    await setUpRepo(site);
    const cachePath = codeCachePath(join(scratch, "tmp"), binary);
    const rows: BenchRow[] = [];
    for (const command of BENCH_COMMANDS) {
      console.error(`measuring ${command.label}`);
      rows.push(await benchCommand(site, command, args.runs, cachePath));
    }
    console.log(formatTable(binary, args.runs, rows));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
}

if (import.meta.main) {
  Deno.exit(await main());
}
