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
import { join } from "@std/path";
import { childEnv, preflight } from "./swamp_child_env.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const CONTEXT_LINES = 3;
export const VERSION_PLACEHOLDER = "<version>";

const USAGE =
  `usage: deno run cli-parity <binary-a> <binary-b> [--concurrency N] [--timeout-ms MS]

  --concurrency N  invocations in flight at once (default: CPU count)
  --timeout-ms MS  deadline for one invocation (default ${DEFAULT_TIMEOUT_MS})`;

export interface ParityArgs {
  binaryA: string;
  binaryB: string;
  concurrency: number;
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

export function parseParityArgs(
  args: readonly string[],
  defaultConcurrency: number,
): ParityArgs {
  const parsed = parseArgs([...args], {
    string: ["concurrency", "timeout-ms"],
    unknown: (arg) => {
      if (arg.startsWith("-")) {
        throw new Error(`unknown option ${arg}\n\n${USAGE}`);
      }
      return true;
    },
  });
  if (parsed._.length !== 2) {
    throw new Error(`expected two binary paths\n\n${USAGE}`);
  }
  return {
    binaryA: String(parsed._[0]),
    binaryB: String(parsed._[1]),
    concurrency: parsed.concurrency === undefined
      ? Math.max(1, defaultConcurrency)
      : positiveInteger("--concurrency", parsed.concurrency),
    timeoutMs: parsed["timeout-ms"] === undefined
      ? DEFAULT_TIMEOUT_MS
      : positiveInteger("--timeout-ms", parsed["timeout-ms"]),
  };
}

/** the slice of CliCommandSchema (src/cli/cli_schema.ts) this script reads */
export interface SchemaNode {
  name: string;
  aliases: string[];
  hidden: boolean;
  subcommands: SchemaNode[];
}

function toNode(value: unknown, where: string): SchemaNode {
  const node = value as Partial<Record<keyof SchemaNode, unknown>> | null;
  if (
    typeof node?.name !== "string" || !Array.isArray(node.aliases) ||
    typeof node.hidden !== "boolean" || !Array.isArray(node.subcommands)
  ) {
    throw new Error(
      `help --include-hidden: unexpected command shape at ${where}`,
    );
  }
  const name = node.name;
  return {
    name,
    aliases: node.aliases.map(String),
    hidden: node.hidden,
    subcommands: node.subcommands.map((child, i) =>
      toNode(child, `${where} > ${name}[${i}]`)
    ),
  };
}

export function parseSchema(text: string): SchemaNode {
  const parsed = JSON.parse(text) as { root?: unknown } | null;
  return toNode(parsed?.root, "root");
}

export function parseVersionJson(text: string): string {
  const parsed = JSON.parse(text) as { version?: unknown } | null;
  if (typeof parsed?.version !== "string" || parsed.version === "") {
    throw new Error(`version --json printed no version: ${text}`);
  }
  return parsed.version;
}

/** every command path below the root, hidden ones included, depth first */
export function extractCommandPaths(root: SchemaNode): string[][] {
  const paths: string[][] = [];
  const walk = (node: SchemaNode, prefix: string[]) => {
    for (const child of node.subcommands) {
      const path = [...prefix, child.name];
      paths.push(path);
      walk(child, path);
    }
  };
  walk(root, []);
  return paths;
}

/**
 * keeps the first letter so Cliffy still has a near match to suggest; never
 * returns a name or alias that already resolves
 */
export function typoFor(name: string, taken: ReadonlySet<string>): string {
  for (let i = 1; i + 1 < name.length; i++) {
    if (name[i] === name[i + 1]) continue;
    const swapped = name.slice(0, i) + name[i + 1] + name[i] +
      name.slice(i + 2);
    if (!taken.has(swapped)) return swapped;
  }
  let candidate = `${name}q`;
  while (taken.has(candidate)) candidate += "q";
  return candidate;
}

function typoInGroup(group: SchemaNode): string {
  const taken = new Set(
    group.subcommands.flatMap((child) => [child.name, ...child.aliases]),
  );
  const target = group.subcommands.find((child) => !child.hidden) ??
    group.subcommands[0];
  return typoFor(target.name, taken);
}

export const COMPLETION_SHELLS: readonly string[] = ["bash", "zsh", "fish"];

export function buildInvocations(root: SchemaNode): string[][] {
  const invocations: string[][] = [
    ["--help"],
    ["help"],
    ["help", "--include-hidden"],
  ];
  for (const path of extractCommandPaths(root)) {
    invocations.push([...path, "--help"], ["help", ...path]);
  }
  for (const shell of COMPLETION_SHELLS) {
    invocations.push(["completions", shell]);
  }
  const typos = (node: SchemaNode, prefix: string[]) => {
    if (node.subcommands.length === 0) return;
    invocations.push([...prefix, typoInGroup(node)]);
    for (const child of node.subcommands) {
      typos(child, [...prefix, child.name]);
    }
  };
  typos(root, []);
  invocations.push(["version", "--json"]);
  return invocations;
}

/**
 * masks each binary's own version, then trailing whitespace: Cliffy pads the
 * Version line of --help to its table width, so the padding follows the length
 */
export function normalize(text: string, version: string): string {
  const masked = version === ""
    ? text
    : text.replaceAll(version, VERSION_PLACEHOLDER);
  return masked.split("\n").map((line) => line.trimEnd()).join("\n");
}

export interface RunOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface InvocationResult {
  args: string[];
  a: RunOutput;
  b: RunOutput;
}

export function differs(result: InvocationResult): boolean {
  return result.a.exitCode !== result.b.exitCode ||
    result.a.stdout !== result.b.stdout ||
    result.a.stderr !== result.b.stderr;
}

export function formatInvocation(args: readonly string[]): string {
  return ["swamp", ...args].join(" ");
}

function streamDiff(stream: string, a: string, b: string): string[] {
  const linesA = a.split("\n");
  const linesB = b.split("\n");
  let at = 0;
  while (
    at < linesA.length && at < linesB.length && linesA[at] === linesB[at]
  ) {
    at++;
  }
  const show = (lines: string[], i: number) =>
    i < lines.length ? lines[i] : "(end of output)";
  const out = [`  ${stream} differs at line ${at + 1}:`];
  for (let i = Math.max(0, at - CONTEXT_LINES); i < at; i++) {
    out.push(`      ${linesA[i]}`);
  }
  for (const [label, lines] of [["A", linesA], ["B", linesB]] as const) {
    const last = Math.min(lines.length, at + CONTEXT_LINES + 1);
    for (let i = at; i < Math.max(last, at + 1); i++) {
      out.push(`    ${label} ${show(lines, i)}`);
    }
  }
  return out;
}

export interface DiffReport {
  differing: number;
  report?: string;
}

/** names the first difference in invocation order, not completion order */
export function diffReport(results: readonly InvocationResult[]): DiffReport {
  const failing = results.filter(differs);
  if (failing.length === 0) return { differing: 0 };
  const first = failing[0];
  const lines = [
    `cli-parity: ${failing.length} of ${results.length} invocations differ. First difference:`,
    "",
    formatInvocation(first.args),
  ];
  if (first.a.stdout !== first.b.stdout) {
    lines.push(...streamDiff("stdout", first.a.stdout, first.b.stdout));
  }
  if (first.a.stderr !== first.b.stderr) {
    lines.push(...streamDiff("stderr", first.a.stderr, first.b.stderr));
  }
  if (first.a.exitCode !== first.b.exitCode) {
    lines.push(`  exit code: A ${first.a.exitCode}, B ${first.b.exitCode}`);
  }
  return { differing: failing.length, report: lines.join("\n") };
}

/** results keep the order of items whatever order the work finishes in */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

interface Side {
  binary: string;
  env: Record<string, string>;
  version: string;
}

interface RunSite {
  cwd: string;
  timeoutMs: number;
}

const decoder = new TextDecoder();

async function runRaw(
  side: Pick<Side, "binary" | "env">,
  site: RunSite,
  args: readonly string[],
): Promise<RunOutput> {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command(side.binary, {
      args: [...args],
      cwd: site.cwd,
      env: side.env,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(site.timeoutMs),
    }).output();
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(
        `${side.binary}: ${
          formatInvocation(args)
        } timed out after ${site.timeoutMs} ms`,
      );
    }
    throw error;
  }
  return {
    exitCode: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

async function run(
  side: Side,
  site: RunSite,
  args: readonly string[],
): Promise<RunOutput> {
  const raw = await runRaw(side, site, args);
  return {
    exitCode: raw.exitCode,
    stdout: normalize(raw.stdout, side.version),
    stderr: normalize(raw.stderr, side.version),
  };
}

async function compare(
  a: Side,
  b: Side,
  site: RunSite,
  args: string[],
): Promise<InvocationResult> {
  const [outA, outB] = await Promise.all([
    run(a, site, args),
    run(b, site, args),
  ]);
  return { args, a: outA, b: outB };
}

async function readVersion(
  side: Pick<Side, "binary" | "env">,
  site: RunSite,
): Promise<string> {
  const out = await runRaw(side, site, ["version", "--json"]);
  if (out.exitCode !== 0) {
    throw new Error(
      `${side.binary}: version --json exited ${out.exitCode}:\n${out.stderr}`,
    );
  }
  return parseVersionJson(out.stdout);
}

async function main(): Promise<number> {
  let args: ParityArgs;
  try {
    args = parseParityArgs(Deno.args, navigator.hardwareConcurrency);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const scratch = await Deno.makeTempDir({ prefix: "swamp-cli-parity-" });
  try {
    const site: RunSite = {
      cwd: join(scratch, "cwd"),
      timeoutMs: args.timeoutMs,
    };
    await Deno.mkdir(site.cwd);
    const base = Deno.env.toObject();
    // two binaries with one file name would otherwise share a code cache
    const sides: Pick<Side, "binary" | "env">[] = [];
    for (const [i, path] of [args.binaryA, args.binaryB].entries()) {
      const tmp = join(scratch, `tmp-${i}`);
      await Deno.mkdir(tmp);
      sides.push({
        binary: await Deno.realPath(path),
        env: childEnv(base, tmp),
      });
    }
    for (const side of sides) {
      await preflight(side.binary, site.cwd, side.env, args.timeoutMs);
    }
    const [a, b] = await Promise.all(
      sides.map(async (side) => ({
        ...side,
        version: await readVersion(side, site),
      })),
    );

    const schema = await runRaw(a, site, ["help", "--include-hidden"]);
    if (schema.exitCode !== 0) {
      throw new Error(
        `${a.binary}: help --include-hidden exited ${schema.exitCode}:\n${schema.stderr}`,
      );
    }
    const invocations = buildInvocations(parseSchema(schema.stdout));
    console.error(`comparing ${invocations.length} invocations`);
    const results = await mapPool(
      invocations,
      args.concurrency,
      (invocation) => compare(a, b, site, invocation),
    );
    // a gate proof refresh landing mid-run can change one output once; only a
    // difference that repeats in a sequential rerun counts
    for (const [i, result] of results.entries()) {
      if (differs(result)) results[i] = await compare(a, b, site, result.args);
    }

    const { differing, report } = diffReport(results);
    if (differing === 0) {
      console.log(`cli-parity: all ${results.length} invocations match`);
      return 0;
    }
    console.log(report);
    return 1;
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
