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
 * Measures what the datastore format guard (swamp-club#3189) costs a command
 * on an S3 or GCS datastore (swamp-club#3191).
 *
 * Each target is an emulator behind a counting HTTP proxy this script runs,
 * so request counts are measured rather than inferred. Every repo's
 * datastore `endpoint` / `apiEndpoint` must point at the proxy's port, not at
 * the emulator. For each repo, command and mode, the binaries run
 * interleaved, `--runs` times each, and the script reports the median and
 * p95 wall time, the median request count, and how many of those requests
 * were the marker read (`_control/datastore-format`) or the S3 preflight
 * (`HEAD /<bucket>`).
 *
 * Modes:
 * - `healthy`: everything is forwarded.
 * - `stall-marker`: requests for the marker key hang until the client gives
 *   up, and everything else is forwarded. This isolates the guard's
 *   degraded-path wait. A fully paused emulator (`docker pause`) is not used,
 *   because there the command's own requests stall for their 30 s timeouts
 *   and drown the guard's wait.
 *
 * Network shape, to approximate a real bucket on top of a local emulator:
 * - `--latency-ms N` delays every forwarded request by N ms, one round trip.
 * - `--handshake-rtts K` (default 2) adds K more round trips to the first
 *   request on each new client connection, standing in for TCP and TLS.
 * - `--creds-port P --creds-delay-ms D` serves AWS container credentials
 *   on 127.0.0.1:P after D ms. Run the binaries with
 *   `AWS_CONTAINER_CREDENTIALS_FULL_URI=http://127.0.0.1:P/creds` and no
 *   `AWS_ACCESS_KEY_ID`, so each fresh S3 client resolves credentials
 *   through a slow source, as SSO, IMDS or an assumed role would.
 *
 * To check that the guard still refuses in time under that shape, plant a
 * newer-format marker first and run `--modes healthy`: every run should
 * then fail (exit 1), and `failures` should equal `--runs`.
 *
 * Setup (one repo per target and namespace layout), for example:
 *
 *   docker run -d --name ministack-bench -p 47191:4566 ministackorg/ministack:latest
 *   docker run -d --name fakegcs-bench -p 47192:4443 fsouza/fake-gcs-server:1.56.1 \
 *     -scheme http -port 4443 -public-host localhost:47192
 *   curl -X PUT localhost:47191/bench
 *   curl -X POST 'localhost:47192/storage/v1/b?project=test' -d '{"name":"bench"}'
 *   # with this script's proxies running (--serve-only), in each repo:
 *   swamp repo init --tool none
 *   swamp datastore setup extension @swamp/s3-datastore --config \
 *     '{"bucket":"bench","prefix":"solo","region":"us-east-1",
 *       "endpoint":"http://localhost:47291","forcePathStyle":true}'
 *   swamp model create command/shell bench
 *
 * Usage:
 *
 *   deno run -A scripts/bench_datastore_format_guard.ts \
 *     --target s3=http://localhost:47191@47291 \
 *     --target gcs=http://localhost:47192@47292 \
 *     --binary guard=/path/to/swamp --binary noguard=/path/to/patched \
 *     --repo s3:solo=/tmp/bench/s3-solo --repo s3:ns=/tmp/bench/s3-ns \
 *     --runs 20 --modes healthy,stall-marker --out results.json
 *
 * The `noguard` comparison binary is the same commit with
 * `readDatastoreFormatMarker` patched to return `unsupported` before any
 * remote call; it is built in a scratch worktree and never committed.
 * S3 credentials come from the environment (`AWS_ACCESS_KEY_ID=test` and
 * friends for ministack).
 */

import { parseArgs } from "@std/cli/parse-args";

const MARKER_PATH_FRAGMENT = "_control/datastore-format";

/** Gives up on an emulator request that has not answered in this long. */
const UPSTREAM_TIMEOUT_MS = 60_000;

type Mode = "healthy" | "stall-marker";

interface Target {
  name: string;
  upstream: string;
  port: number;
}

interface Counters {
  total: number;
  marker: number;
  preflight: number;
  markerMs: number[];
}

interface Proxy {
  counters: Counters;
  mode: Mode;
  server: Deno.HttpServer;
}

interface NetworkShape {
  latencyMs: number;
  handshakeRtts: number;
}

const delay = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : undefined;

const COMMANDS: Record<string, string[]> = {
  "data list": ["data", "list", "bench", "--json"],
  "model method run": [
    "model",
    "method",
    "run",
    "bench",
    "execute",
    "--input",
    "run=true",
    "--json",
  ],
  "datastore sync": ["datastore", "sync", "--json"],
};

/** Response headers that no longer describe a body `fetch` decoded. */
const DROPPED_RESPONSE_HEADERS = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
];

function freshCounters(): Counters {
  return { total: 0, marker: 0, preflight: 0, markerMs: [] };
}

function parseTarget(spec: string): Target {
  const match = /^([^=]+)=(.+)@(\d+)$/.exec(spec);
  if (!match) throw new Error(`--target ${spec}: want name=upstream@port`);
  return { name: match[1], upstream: match[2], port: Number(match[3]) };
}

function parsePair(flag: string, spec: string): [string, string] {
  const at = spec.indexOf("=");
  if (at <= 0) throw new Error(`--${flag} ${spec}: want label=value`);
  return [spec.slice(0, at), spec.slice(at + 1)];
}

function isPreflight(req: Request): boolean {
  if (req.method !== "HEAD") return false;
  const segments = new URL(req.url).pathname.split("/").filter(Boolean);
  return segments.length === 1;
}

function startProxy(target: Target, shape: NetworkShape): Proxy {
  const proxy: Proxy = {
    counters: freshCounters(),
    mode: "healthy",
    server: undefined as unknown as Deno.HttpServer,
  };
  // Client ports seen so far: a new one is a new connection.
  const connections = new Set<number>();
  proxy.server = Deno.serve(
    { port: target.port, hostname: "127.0.0.1", onListen: () => {} },
    async (req, info) => {
      const url = new URL(req.url);
      const port = (info.remoteAddr as Deno.NetAddr).port;
      const handshake = connections.has(port) ? 0 : shape.handshakeRtts;
      connections.add(port);
      await delay(shape.latencyMs * (1 + handshake));
      const isMarker = decodeURIComponent(url.pathname + url.search).includes(
        MARKER_PATH_FRAGMENT,
      );
      proxy.counters.total++;
      if (isMarker) proxy.counters.marker++;
      if (isPreflight(req)) proxy.counters.preflight++;

      if (isMarker && proxy.mode === "stall-marker") {
        await new Promise<void>((resolve) => {
          if (req.signal.aborted) return resolve();
          req.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return new Response(null, { status: 504 });
      }

      const started = performance.now();
      const upstream = await fetch(
        target.upstream + url.pathname + url.search,
        {
          method: req.method,
          headers: req.headers,
          body: req.body,
          redirect: "manual",
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        },
      );
      if (isMarker) proxy.counters.markerMs.push(performance.now() - started);
      const headers = new Headers(upstream.headers);
      for (const name of DROPPED_RESPONSE_HEADERS) headers.delete(name);
      return new Response(upstream.body, { status: upstream.status, headers });
    },
  );
  return proxy;
}

function startCredentialsServer(port: number, delayMs: number): Deno.HttpServer {
  return Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    async () => {
      await delay(delayMs);
      return Response.json({
        AccessKeyId: "test",
        SecretAccessKey: "test",
        Token: "test",
        Expiration: new Date(Date.now() + 3_600_000).toISOString(),
      });
    },
  );
}

async function runOnce(
  binary: string,
  repoDir: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ms: number; code: number }> {
  const started = performance.now();
  const child = new Deno.Command(binary, {
    args: [...args, "--repo-dir", repoDir],
    cwd: repoDir,
    env: {
      SWAMP_NO_TELEMETRY: "1",
      SWAMP_NO_UPDATE_CHECK: "1",
      DO_NOT_TRACK: "1",
    },
    stdout: "null",
    stderr: "piped",
    signal: AbortSignal.timeout(timeoutMs),
  }).spawn();
  const { code, stderr } = await child.output();
  const ms = performance.now() - started;
  if (code !== 0) {
    const tail = new TextDecoder().decode(stderr).trim().split("\n").slice(-3);
    console.error(`  exit ${code}: ${tail.join(" | ")}`);
  }
  return { ms, code };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

interface Cell {
  repo: string;
  command: string;
  mode: Mode;
  binary: string;
  runs: number;
  failures: number;
  medianMs: number;
  p95Ms: number;
  medianRequests: number;
  markerRequests: number;
  preflightRequests: number;
  medianMarkerUpstreamMs: number;
}

async function main(): Promise<void> {
  const flags = parseArgs(Deno.args, {
    string: [
      "target",
      "binary",
      "repo",
      "runs",
      "modes",
      "out",
      "timeout",
      "latency-ms",
      "handshake-rtts",
      "creds-port",
      "creds-delay-ms",
      "commands",
    ],
    boolean: ["serve-only"],
    collect: ["target", "binary", "repo"],
  });
  const targets = (flags.target as string[]).map(parseTarget);
  const shape: NetworkShape = {
    latencyMs: Number(flags["latency-ms"] ?? 0),
    handshakeRtts: Number(flags["handshake-rtts"] ?? 2),
  };
  const proxies = new Map(targets.map((t) => [t.name, startProxy(t, shape)]));
  const credentials = flags["creds-port"]
    ? startCredentialsServer(
      Number(flags["creds-port"]),
      Number(flags["creds-delay-ms"] ?? 0),
    )
    : undefined;

  if (flags["serve-only"]) {
    console.log(
      `Proxies up: ${
        targets.map((t) => `${t.name} :${t.port} -> ${t.upstream}`).join(", ")
      }. Ctrl-C to stop.`,
    );
    await new Promise(() => {});
  }

  const binaries = (flags.binary as string[]).map((s) => parsePair("binary", s));
  const repos = (flags.repo as string[]).map((s) => parsePair("repo", s));
  const runs = Number(flags.runs ?? 20);
  const timeoutMs = Number(flags.timeout ?? 120_000);
  const modes = (flags.modes ?? "healthy,stall-marker").split(",") as Mode[];

  const cells: Cell[] = [];
  for (const [repoLabel, repoDir] of repos) {
    const proxy = proxies.get(repoLabel.split(":")[0]);
    if (!proxy) throw new Error(`--repo ${repoLabel}: no target named so`);
    for (const mode of modes) {
      proxy.mode = mode;
      const commands = flags.commands
        ? flags.commands.split(",").map((c) => c.trim())
        : Object.keys(COMMANDS);
      for (const command of commands) {
        const args = COMMANDS[command];
        if (!args) throw new Error(`--commands: unknown command ${command}`);
        const samples = new Map(
          binaries.map(([label]) => [label, {
            ms: [] as number[],
            requests: [] as number[],
            marker: [] as number[],
            preflight: [] as number[],
            markerMs: [] as number[],
            failures: 0,
          }]),
        );
        // One warm-up per binary, not recorded.
        for (const [, binary] of binaries) {
          await runOnce(binary, repoDir, args, timeoutMs);
        }
        for (let i = 0; i < runs; i++) {
          for (const [label, binary] of binaries) {
            proxy.counters = freshCounters();
            const { ms, code } = await runOnce(binary, repoDir, args, timeoutMs);
            const s = samples.get(label)!;
            s.ms.push(ms);
            s.requests.push(proxy.counters.total);
            s.marker.push(proxy.counters.marker);
            s.preflight.push(proxy.counters.preflight);
            s.markerMs.push(...proxy.counters.markerMs);
            if (code !== 0) s.failures++;
          }
        }
        for (const [label] of binaries) {
          const s = samples.get(label)!;
          const cell: Cell = {
            repo: repoLabel,
            command,
            mode,
            binary: label,
            runs,
            failures: s.failures,
            medianMs: Math.round(percentile(s.ms, 50)),
            p95Ms: Math.round(percentile(s.ms, 95)),
            medianRequests: percentile(s.requests, 50),
            markerRequests: percentile(s.marker, 50),
            preflightRequests: percentile(s.preflight, 50),
            medianMarkerUpstreamMs: Math.round(percentile(s.markerMs, 50)),
          };
          cells.push(cell);
          console.log(
            [
              repoLabel.padEnd(8),
              command.padEnd(17),
              mode.padEnd(12),
              label.padEnd(10),
              `median ${cell.medianMs} ms`.padEnd(16),
              `p95 ${cell.p95Ms} ms`.padEnd(13),
              `requests ${cell.medianRequests}`.padEnd(13),
              `marker ${cell.markerRequests}`,
              `preflight ${cell.preflightRequests}`,
              cell.failures ? `failures ${cell.failures}` : "",
            ].join(" "),
          );
        }
      }
    }
  }

  if (flags.out) {
    await Deno.writeTextFile(flags.out, JSON.stringify(cells, null, 2) + "\n");
  }
  for (const proxy of proxies.values()) await proxy.server.shutdown();
  await credentials?.shutdown();
}

if (import.meta.main) {
  await main();
}
