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
import { dirname, join, resolve } from "@std/path";

interface Options {
  readonly binaries: Readonly<Record<string, string>>;
  readonly latencyMs: number;
  readonly farLatencyMs: number;
  readonly handshakeRtts: number;
  readonly rounds: number;
  readonly history: number;
  readonly followers: number;
  readonly workDir: string;
  readonly fakeGcsImage: string;
  readonly keep: boolean;
  readonly setupOnly: boolean;
  readonly largeHistory: number;
  readonly largeKib: number;
  readonly idleMs: number;
  readonly coldRounds: number;
  readonly cloneRounds: number;
  readonly startupRounds: number;
  readonly telemetryLatencyMs: number;
  readonly v2Hydration: readonly ("full" | "lazy")[];
  readonly objectRateLimitMs: number;
  readonly sustainedWritesMs: number;
  readonly stepSleepMs: number;
}

const GCS_EXTENSION = "@swamp/gcs-datastore";
const BUCKET = "lane";
const WRITER = "writer";
const BIG = "big";
const WORKFLOW = "two-steps";
const SLOW = "slow";
const SLOW_BIG = "slow-big";
/** two steps that outlast the run checkpoint interval, the second large */
const SLOW_WORKFLOW = "two-slow-steps";

function usage(): never {
  console.error(
    `usage: deno run -A scripts/measure_v3_team_round_trips.ts \\
  --binary label=path [--binary label=path ...] [--latency-ms 100] \\
  [--far-latency-ms 140] \\
  [--handshake-rtts 2] [--rounds 12] [--history 200] [--followers 1] \\
  [--work-dir dir] [--fake-gcs-image image] [--keep] [--setup-only] \\
  [--large-history 20] [--large-kib 64] [--idle-ms 70000] [--cold-rounds 2] \\
  [--clone-rounds 2] [--startup-rounds 6] [--telemetry-latency-ms 300] \\
  [--v2-hydration full,lazy] [--object-rate-limit-ms 1000] \\
  [--sustained-writes-ms 60000] [--step-sleep-ms 3000]`,
  );
  Deno.exit(2);
}

function parseOptions(): Options {
  const args = parseArgs(Deno.args, {
    string: [
      "binary",
      "latency-ms",
      "handshake-rtts",
      "rounds",
      "history",
      "followers",
      "work-dir",
      "fake-gcs-image",
      "large-history",
      "large-kib",
      "idle-ms",
      "cold-rounds",
      "clone-rounds",
      "startup-rounds",
      "telemetry-latency-ms",
      "object-rate-limit-ms",
      "sustained-writes-ms",
      "v2-hydration",
      "step-sleep-ms",
    ],
    boolean: ["keep", "setup-only"],
    collect: ["binary"],
    default: {
      "latency-ms": "100",
      "handshake-rtts": "2",
      rounds: "12",
      history: "200",
      followers: "1",
      "fake-gcs-image": "fsouza/fake-gcs-server:1.56.1",
      "large-history": "20",
      "large-kib": "64",
      // past serve's 60 s vault-match TTL
      "idle-ms": "70000",
      "cold-rounds": "2",
      "clone-rounds": "2",
      "startup-rounds": "6",
      "telemetry-latency-ms": "300",
      "v2-hydration": "",
      "object-rate-limit-ms": "0",
      "sustained-writes-ms": "0",
      "step-sleep-ms": "3000",
    },
  });
  const binaries: Record<string, string> = {};
  for (const spec of (args.binary ?? []) as string[]) {
    const at = spec.indexOf("=");
    if (at <= 0) usage();
    binaries[spec.slice(0, at)] = resolve(spec.slice(at + 1));
  }
  if (Object.keys(binaries).length === 0) usage();
  const v2Hydration: ("full" | "lazy")[] = [];
  for (const mode of String(args["v2-hydration"]).split(",")) {
    if (mode === "") continue;
    if (mode !== "full" && mode !== "lazy") usage();
    v2Hydration.push(mode);
  }
  return {
    binaries,
    latencyMs: Number(args["latency-ms"]),
    farLatencyMs: Number(args["far-latency-ms"] ?? 0),
    handshakeRtts: Number(args["handshake-rtts"]),
    rounds: Number(args.rounds),
    history: Number(args.history),
    followers: Number(args.followers),
    workDir: resolve(
      args["work-dir"] ?? Deno.makeTempDirSync({ prefix: "swamp-team-lane-" }),
    ),
    fakeGcsImage: args["fake-gcs-image"],
    keep: args.keep,
    setupOnly: args["setup-only"],
    largeHistory: Number(args["large-history"]),
    largeKib: Number(args["large-kib"]),
    idleMs: Number(args["idle-ms"]),
    coldRounds: Number(args["cold-rounds"]),
    cloneRounds: Number(args["clone-rounds"]),
    startupRounds: Number(args["startup-rounds"]),
    telemetryLatencyMs: Number(args["telemetry-latency-ms"]),
    v2Hydration,
    objectRateLimitMs: Number(args["object-rate-limit-ms"]),
    sustainedWritesMs: Number(args["sustained-writes-ms"]),
    stepSleepMs: Number(args["step-sleep-ms"]),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

type StorageKind =
  | "upload"
  | "download"
  | "metadata"
  | "list"
  | "delete"
  | "other";

function storageKind(req: Request): StorageKind {
  const url = new URL(req.url);
  if (req.method === "DELETE") return "delete";
  if (url.pathname.startsWith("/upload/") || req.method === "PUT") {
    return "upload";
  }
  if (url.searchParams.get("alt") === "media") return "download";
  if (req.method === "GET" && /\/b\/[^/]+\/o$/.test(url.pathname)) {
    return "list";
  }
  if (req.method === "GET" && url.pathname.includes("/o/")) return "metadata";
  if (req.method === "GET" && url.searchParams.has("prefix")) return "list";
  return "other";
}

interface StorageEvent {
  readonly at: number;
  readonly kind: StorageKind;
}

// a multipart upload names its object in the body, not the query
function mutatedObject(req: Request, body: Uint8Array | undefined): string | undefined {
  const url = new URL(req.url);
  const path = url.pathname;
  const target = /\/(?:rewriteTo|copyTo)\/b\/[^/]+\/o\/([^/]+)$/.exec(path);
  if (req.method === "POST" && target !== null) {
    return decodeURIComponent(target[1]);
  }
  if (req.method === "POST" && path.startsWith("/upload/")) {
    const named = url.searchParams.get("name");
    if (named !== null) return named;
    const text = new TextDecoder().decode(body?.slice(0, 4096));
    return /"name"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  }
  const object = /\/storage\/v1\/b\/[^/]+\/o\/([^/]+)$/.exec(path);
  if ((req.method === "DELETE" || req.method === "PATCH") && object !== null) {
    return decodeURIComponent(object[1]);
  }
  return undefined;
}

function objectRateLimiter(intervalMs: number) {
  const last = new Map<string, number>();
  const refused: { readonly at: number; readonly object: string }[] = [];
  // off during setup: the extension's write probe rewrites one object at once
  let enforcing = false;
  return {
    refused,
    enforce(on: boolean): void {
      enforcing = on;
    },
    refuse(req: Request, body: Uint8Array | undefined): Response | undefined {
      if (intervalMs <= 0 || !enforcing) return undefined;
      const object = mutatedObject(req, body);
      if (object === undefined) return undefined;
      const now = Date.now();
      const previous = last.get(object);
      if (previous !== undefined && now - previous < intervalMs) {
        refused.push({ at: now, object });
        const message =
          `The object ${BUCKET}/${object} exceeded the rate limit for object mutation operations (create, update, and delete).`;
        return Response.json({
          error: {
            code: 429,
            message,
            errors: [{ message, domain: "usageLimits", reason: "rateLimitExceeded" }],
          },
        }, { status: 429 });
      }
      last.set(object, now);
      return undefined;
    },
  };
}

type ObjectRateLimiter = ReturnType<typeof objectRateLimiter>;

const DROPPED_RESPONSE_HEADERS = [
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
];

/**
 * the far member's link to serve: every request, and every feed frame each
 * way, waits a round trip; a new connection pays its handshakes too
 */
export function startMemberProxy(
  port: number,
  upstream: string,
  latencyMs: number,
  handshakeRtts: number,
): Deno.HttpServer {
  const connections = new Set<string>();
  return Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    async (req, info) => {
      const remote = info.remoteAddr as Deno.NetAddr;
      const key = `${remote.hostname}:${remote.port}`;
      const handshake = connections.has(key) ? 0 : handshakeRtts;
      connections.add(key);
      const url = new URL(req.url);
      if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
        // upgraded at once, as a request awaited first is gone; the link's
        // delay falls on each frame instead
        const headers: Record<string, string> = {};
        const auth = req.headers.get("authorization");
        if (auth !== null) headers.authorization = auth;
        const { socket, response } = Deno.upgradeWebSocket(req);
        const upstreamSocket = new WebSocket(
          upstream.replace(/^http/, "ws") + url.pathname + url.search,
          { headers } as unknown as string[],
        );
        const pending: string[] = [];
        upstreamSocket.onopen = () => {
          for (const frame of pending.splice(0)) upstreamSocket.send(frame);
        };
        socket.onmessage = (event) => {
          setTimeout(() => {
            if (upstreamSocket.readyState === WebSocket.OPEN) {
              upstreamSocket.send(event.data);
            } else pending.push(event.data);
          }, latencyMs / 2);
        };
        upstreamSocket.onmessage = (event) => {
          setTimeout(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send(event.data);
          }, latencyMs / 2);
        };
        socket.onclose = () => upstreamSocket.close();
        upstreamSocket.onclose = () => {
          if (socket.readyState <= WebSocket.OPEN) socket.close();
        };
        return response;
      }
      const body = req.body === null
        ? undefined
        : new Uint8Array(await req.arrayBuffer());
      await delay(latencyMs * (1 + handshake));
      const forwarded = new Headers(req.headers);
      forwarded.delete("host");
      forwarded.delete("content-length");
      const upstreamResponse = await fetch(
        upstream + url.pathname + url.search,
        {
          method: req.method,
          headers: forwarded,
          ...(body === undefined ? {} : { body }),
          redirect: "manual",
        },
      );
      const headers = new Headers(upstreamResponse.headers);
      for (const name of DROPPED_RESPONSE_HEADERS) headers.delete(name);
      const bytes = req.method === "HEAD"
        ? null
        : new Uint8Array(await upstreamResponse.arrayBuffer());
      return new Response(bytes, { status: upstreamResponse.status, headers });
    },
  );
}

function startStorageProxy(
  port: number,
  upstream: string,
  latencyMs: number,
  handshakeRtts: number,
  events: StorageEvent[],
  limiter: ObjectRateLimiter,
): Deno.HttpServer {
  const connections = new Set<string>();
  const upstreamHost = new URL(upstream).host;
  const ownHost = `127.0.0.1:${port}`;
  return Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    async (req, info) => {
      const remote = info.remoteAddr as Deno.NetAddr;
      const key = `${remote.hostname}:${remote.port}`;
      const handshake = connections.has(key) ? 0 : handshakeRtts;
      connections.add(key);
      // Buffered before forwarding: a body cut short by a stopping sidecar
      // must not land as a truncated object.
      const body = req.body === null
        ? undefined
        : new Uint8Array(await req.arrayBuffer());
      await delay(latencyMs * (1 + handshake));
      events.push({ at: Date.now(), kind: storageKind(req) });
      const refusal = limiter.refuse(req, body);
      if (refusal !== undefined) return refusal;
      const url = new URL(req.url);
      const upstreamResponse = await fetch(
        upstream + url.pathname + url.search,
        {
          method: req.method,
          headers: req.headers,
          ...(body === undefined ? {} : { body }),
          redirect: "manual",
        },
      );
      const headers = new Headers(upstreamResponse.headers);
      for (const name of DROPPED_RESPONSE_HEADERS) headers.delete(name);
      const location = headers.get("location");
      if (location !== null) {
        headers.set("location", location.replaceAll(upstreamHost, ownHost));
      }
      let bytes: Uint8Array<ArrayBuffer> | null = req.method === "HEAD"
        ? null
        : new Uint8Array(await upstreamResponse.arrayBuffer());
      const type = headers.get("content-type") ?? "";
      if (bytes !== null && /json|xml/.test(type)) {
        bytes = new TextEncoder().encode(
          new TextDecoder().decode(bytes).replaceAll(upstreamHost, ownHost),
        );
      }
      return new Response(bytes, { status: upstreamResponse.status, headers });
    },
  );
}

interface SinkSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

function attributeValue(
  value: Record<string, unknown>,
): string | number | boolean {
  if ("stringValue" in value) return String(value.stringValue);
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("boolValue" in value) return Boolean(value.boolValue);
  return JSON.stringify(value);
}

function nanosToMs(value: unknown): number {
  return Number(BigInt(String(value)) / 1_000_000n);
}

function startOtlpSink(port: number, spans: SinkSpan[]): Deno.HttpServer {
  return Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      if (req.method !== "POST") return new Response(null, { status: 405 });
      if (!url.pathname.endsWith("/v1/traces")) {
        await req.body?.cancel();
        return Response.json({});
      }
      const payload = await req.json() as {
        resourceSpans?: {
          scopeSpans?: { spans?: Record<string, unknown>[] }[];
        }[];
      };
      for (const resource of payload.resourceSpans ?? []) {
        for (const scope of resource.scopeSpans ?? []) {
          for (const span of scope.spans ?? []) {
            const attributes: Record<string, string | number | boolean> = {};
            for (
              const attribute of (span.attributes ?? []) as {
                key: string;
                value: Record<string, unknown>;
              }[]
            ) {
              attributes[attribute.key] = attributeValue(attribute.value);
            }
            spans.push({
              name: String(span.name),
              traceId: String(span.traceId),
              spanId: String(span.spanId),
              parentSpanId: String(span.parentSpanId ?? ""),
              startMs: nanosToMs(span.startTimeUnixNano),
              endMs: nanosToMs(span.endTimeUnixNano),
              attributes,
            });
          }
        }
      }
      return Response.json({});
    },
  );
}

interface Env {
  readonly home: string;
  readonly storageHost: string;
  readonly otlp: string;
}

function baseEnv(env: Env): Record<string, string> {
  return {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    HOME: Deno.env.get("HOME") ?? env.home,
    TMPDIR: Deno.env.get("TMPDIR") ?? "/tmp",
    SWAMP_NO_UPDATE_CHECK: "1",
    SWAMP_NO_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    STORAGE_EMULATOR_HOST: env.storageHost,
    OTEL_EXPORTER_OTLP_ENDPOINT: env.otlp,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
  };
}

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

async function run(
  binary: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  check = true,
): Promise<RunResult> {
  const started = performance.now();
  const output = await new Deno.Command(binary, {
    args: [...args],
    cwd,
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const result = {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    ms: performance.now() - started,
  };
  if (check && result.code !== 0) {
    throw new Error(
      `${binary} ${args.join(" ")} exited ${result.code}:\n${result.stderr}\n${result.stdout}`,
    );
  }
  return result;
}

function lastJson(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  return JSON.parse(text.slice(start)) as Record<string, unknown>;
}

interface Lane {
  readonly leader: ServeNode;
  readonly followers: readonly ServeNode[];
  readonly members: readonly Member[];
  stop(): Promise<void>;
}

interface ServeNode {
  readonly name: string;
  readonly repo: string;
  readonly origin: string;
  readonly process: Deno.ChildProcess;
  readonly logged: Promise<unknown>;
}

interface Member {
  readonly name: string;
  readonly repo: string;
  readonly origin: string;
  readonly token: string;
}

function gcsConfig(prefix: string, storageHost: string): string {
  return JSON.stringify({
    bucket: BUCKET,
    prefix,
    projectId: "test",
    apiEndpoint: `http://${storageHost}`,
  });
}

async function initRepo(
  binary: string,
  dir: string,
  env: Record<string, string>,
): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  laneRepos.push(dir);
  await run(binary, ["repo", "init", "--tool", "none", "--json"], dir, env);
  await run(
    binary,
    ["extension", "pull", GCS_EXTENSION, "--json"],
    dir,
    env,
  );
}

async function startServe(
  binary: string,
  name: string,
  repo: string,
  port: number,
  env: Record<string, string>,
  logDir: string,
  claimedAddress?: string,
): Promise<ServeNode> {
  const origin = `http://127.0.0.1:${port}`;
  const open = (stream: string) =>
    Deno.open(join(logDir, `${name}.${stream}.log`), {
      write: true,
      create: true,
      truncate: true,
    });
  const out = await open("out");
  const err = await open("err");
  const process = new Deno.Command(binary, {
    args: [
      "serve",
      "--no-schedule",
      "--auth-mode",
      "token",
      "--admins",
      "user:lane-admin",
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      // every node names the claim's address; each advertises its own
      "--address",
      claimedAddress ?? origin,
      "--advertise-address",
      origin,
      "--repo-dir",
      repo,
    ],
    cwd: repo,
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const logged = Promise.all([
    process.stdout.pipeTo(out.writable),
    process.stderr.pipeTo(err.writable),
  ]);
  for (let i = 0; i < 600; i++) {
    try {
      const response = await fetch(`${origin}/health`);
      await response.body?.cancel();
      if (response.status < 500) {
        return { name, repo, origin, process, logged };
      }
    } catch {
      // not listening yet
    }
    await delay(250);
  }
  throw new Error(`serve ${name} did not start; see ${logDir}/${name}.err.log`);
}

async function setUpLane(
  binary: string,
  label: string,
  options: Options,
  env: Env,
): Promise<Lane> {
  const root = join(options.workDir, label);
  await Deno.mkdir(root, { recursive: true });
  const runEnv = baseEnv(env);
  const prefix = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const leaderRepo = join(root, "serve-a");
  const farProxies: Deno.HttpServer[] = [];
  await initRepo(binary, leaderRepo, runEnv);
  await run(binary, [
    "datastore",
    "setup",
    "extension",
    GCS_EXTENSION,
    "--format",
    "3",
    "--config",
    gcsConfig(prefix, env.storageHost),
    "--json",
  ], leaderRepo, runEnv);
  await run(
    binary,
    ["datastore", "config", "migrate", "--json"],
    leaderRepo,
    runEnv,
  );
  const leaderPort = freePort();
  const leaderOrigin = `http://127.0.0.1:${leaderPort}`;
  const members: Member[] = [];
  const memberCount = 3;
  const tokens: string[] = [];
  for (let i = 1; i <= memberCount; i++) {
    const name = `m${i}`;
    await run(binary, [
      "access",
      "grant",
      "create",
      "--subject",
      `user:${name}`,
      "--allow",
      "read,write,run",
      "--on",
      "behavior:*",
      "--json",
    ], leaderRepo, runEnv);
    await run(binary, [
      "access",
      "grant",
      "create",
      "--subject",
      `user:${name}`,
      "--allow",
      "read,write,run",
      "--on",
      "workflow:*",
      "--json",
    ], leaderRepo, runEnv);
    await run(binary, [
      "access",
      "grant",
      "create",
      "--subject",
      `user:${name}`,
      "--allow",
      "read,write",
      "--on",
      "data:*",
      "--json",
    ], leaderRepo, runEnv);
    await run(binary, [
      "access",
      "grant",
      "create",
      "--subject",
      `user:${name}`,
      "--allow",
      "read,write",
      "--on",
      "vault:*",
      "--json",
    ], leaderRepo, runEnv);
    await run(binary, [
      "access",
      "token",
      "mint",
      name,
      "--principal",
      `user:${name}`,
      "--json",
    ], leaderRepo, runEnv);
    const revealed = await run(
      binary,
      ["access", "token", "reveal", name, "--json"],
      leaderRepo,
      runEnv,
    );
    tokens.push(String(lastJson(revealed.stdout).token));
  }
  await run(binary, [
    "datastore",
    "claim",
    "--address",
    leaderOrigin,
    "--json",
  ], leaderRepo, runEnv);
  const leader = await startServe(
    binary,
    "serve-a",
    leaderRepo,
    leaderPort,
    runEnv,
    root,
  );
  const followers: ServeNode[] = [];
  for (let i = 0; i < options.followers; i++) {
    const name = `serve-${String.fromCharCode(98 + i)}`;
    const repo = join(root, name);
    await Deno.mkdir(repo, { recursive: true });
    await Deno.copyFile(
      join(leaderRepo, ".swamp.yaml"),
      join(repo, ".swamp.yaml"),
    );
    // the datastore's extension installs itself when serve loads .swamp.yaml
    followers.push(
      await startServe(
        binary,
        name,
        repo,
        freePort(),
        runEnv,
        root,
        leader.origin,
      ),
    );
  }
  for (let i = 0; i < memberCount; i++) {
    const name = `m${i + 1}`;
    const repo = join(root, name);
    await initRepo(binary, repo, runEnv);
    // The far member reaches the leader through a follower, or with
    // --far-latency-ms straight to the leader over a slow link.
    const far = i === memberCount - 1;
    let origin = far && followers.length > 0 && options.farLatencyMs <= 0
      ? followers[0].origin
      : leader.origin;
    if (far && options.farLatencyMs > 0) {
      const port = freePort();
      farProxies.push(
        startMemberProxy(
          port,
          origin,
          options.farLatencyMs,
          options.handshakeRtts,
        ),
      );
      origin = `http://127.0.0.1:${port}`;
    }
    await pointAtServe(repo, leaderRepo, origin);
    members.push({ name, repo, origin, token: tokens[i] });
  }
  return {
    leader,
    followers,
    members,
    async stop() {
      for (const proxy of farProxies) await proxy.shutdown();
      for (const node of [...followers, leader]) {
        try {
          node.process.kill("SIGTERM");
        } catch {
          // already gone
        }
        await node.process.status;
        await node.logged;
      }
    },
  };
}

async function pointAtServe(
  repo: string,
  leaderRepo: string,
  origin: string,
): Promise<void> {
  const marker = await Deno.readTextFile(join(leaderRepo, ".swamp.yaml"));
  const datastore = marker.slice(marker.indexOf("datastore:"));
  const own = await Deno.readTextFile(join(repo, ".swamp.yaml"));
  await Deno.writeTextFile(
    join(repo, ".swamp.yaml"),
    own.slice(0, own.indexOf("datastore:") >= 0 ? own.indexOf("datastore:") : own.length)
      .trimEnd() + `\nserverAddress: ${JSON.stringify(origin)}\n` +
      datastore,
  );
}

function memberEnv(env: Env, member: Member): Record<string, string> {
  return {
    ...baseEnv(env),
    SWAMP_SERVER_URL: member.origin,
    SWAMP_SERVER_TOKEN: member.token,
  };
}

async function memberRun(
  binary: string,
  env: Env,
  member: Member,
  args: readonly string[],
): Promise<RunResult> {
  return await run(
    binary,
    [...args, "--json"],
    member.repo,
    memberEnv(env, member),
  );
}

// random so no two outputs share a chunk; base64 grows it by a third
function bigRun(largeKib: number): string {
  return `run=head -c ${Math.floor(largeKib * 1024 * 3 / 4)} /dev/urandom | base64`;
}

async function seedMember(
  binary: string,
  env: Env,
  member: Member,
  largeKib: number,
  stepSleepMs: number,
) {
  const sleep = `sleep ${(stepSleepMs / 1000).toFixed(3)}`;
  await memberRun(binary, env, member, [
    "model",
    "create",
    "command/shell",
    WRITER,
    "--global-arg",
    "run=echo written",
  ]);
  await memberRun(binary, env, member, [
    "model",
    "create",
    "command/shell",
    BIG,
    "--global-arg",
    bigRun(largeKib),
  ]);
  await memberRun(binary, env, member, [
    "model",
    "create",
    "command/shell",
    SLOW,
    "--global-arg",
    `run=${sleep}; echo written`,
  ]);
  await memberRun(binary, env, member, [
    "model",
    "create",
    "command/shell",
    SLOW_BIG,
    "--global-arg",
    `run=${sleep}; ${bigRun(largeKib).slice("run=".length)}`,
  ]);
  await createTwoStepWorkflow(binary, env, member, WORKFLOW, WRITER, WRITER);
  await createTwoStepWorkflow(
    binary,
    env,
    member,
    SLOW_WORKFLOW,
    SLOW,
    SLOW_BIG,
  );
}

async function createTwoStepWorkflow(
  binary: string,
  env: Env,
  member: Member,
  name: string,
  first: string,
  second: string,
) {
  const body = join(member.repo, `${name}.body.yaml`);
  await Deno.writeTextFile(
    body,
    [
      `name: ${name}`,
      "jobs:",
      "  - name: main",
      "    steps:",
      "      - name: one",
      "        task:",
      "          type: model_method",
      `          modelIdOrName: ${first}`,
      "          methodName: execute",
      "      - name: two",
      "        dependsOn:",
      "          - step: one",
      "            condition:",
      "              type: succeeded",
      "        task:",
      "          type: model_method",
      `          modelIdOrName: ${second}`,
      "          methodName: execute",
      "",
    ].join("\n"),
  );
  // workflow edit opens $EDITOR on the stored file: this one keeps its id and
  // writes the two steps
  const editor = join(member.repo, `write-${name}.sh`);
  await Deno.writeTextFile(
    editor,
    `#!/bin/sh\nid=$(grep '^id:' "$1")\n{ echo "$id"; cat '${body}'; } > "$1"\n`,
  );
  await Deno.chmod(editor, 0o755);
  await memberRun(binary, env, member, ["workflow", "create", name]);
  await run(
    binary,
    ["workflow", "edit", name, "--json"],
    member.repo,
    { ...memberEnv(env, member), EDITOR: editor, VISUAL: editor },
  );
}

interface Sample {
  readonly binary: string;
  readonly member: string;
  readonly command: string;
  readonly round: number;
  readonly ms: number;
  readonly code: number;
  readonly memberRequests: readonly string[];
  readonly storage: Readonly<Record<StorageKind, number>>;
  readonly spans: readonly SinkSpan[];
}

function emptyStorageCounts(): Record<StorageKind, number> {
  return {
    upload: 0,
    download: 0,
    metadata: 0,
    list: 0,
    delete: 0,
    other: 0,
  };
}

const COMMANDS: Readonly<Record<string, readonly string[]>> = {
  write: ["model", "method", "run", WRITER, "execute"],
  workflow: ["workflow", "run", WORKFLOW],
  "slow workflow": ["workflow", "run", SLOW_WORKFLOW],
  "data get": ["data", "get", WRITER, "result"],
  "data list": ["data", "list", WRITER],
};

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

async function settle(
  spans: readonly SinkSpan[],
  events: readonly StorageEvent[],
): Promise<void> {
  // Exporters flush at process exit and serve batches; wait until quiet.
  let last = -1;
  for (let i = 0; i < 40; i++) {
    const now = spans.length + events.length;
    if (now === last) return;
    last = now;
    await delay(250);
  }
}

async function sampleOnce(
  label: string,
  binary: string,
  member: Member,
  command: string,
  args: readonly string[],
  round: number,
  env: Env,
  spans: SinkSpan[],
  events: StorageEvent[],
): Promise<Sample> {
  await settle(spans, events);
  const fromSpan = spans.length;
  const fromEvent = events.length;
  const started = Date.now();
  const result = await run(
    binary,
    [...args, "--json"],
    member.repo,
    memberEnv(env, member),
    false,
  );
  const ended = Date.now();
  await settle(spans, events);
  const window = spans.slice(fromSpan).filter((span) =>
    span.startMs >= started - 5 && span.startMs <= ended + 5
  );
  const storage = emptyStorageCounts();
  for (const event of events.slice(fromEvent)) {
    if (event.at >= started && event.at <= ended) storage[event.kind]++;
  }
  if (result.code !== 0) {
    console.error(
      `  ${label} ${member.name} ${command}: exit ${result.code}: ${
        result.stderr.trim().split("\n").slice(-2).join(" | ")
      }`,
    );
  }
  return {
    binary: label,
    member: member.name,
    command,
    round,
    ms: result.ms,
    code: result.code,
    memberRequests: window
      .filter((span) => span.name === "swamp.datastore.v3.serve.request")
      .sort((a, b) => a.startMs - b.startMs)
      .map((span) =>
        `${span.attributes["http.request.method"]} ${
          span.attributes["http.route"]
        }`
      ),
    storage,
    spans: window,
  };
}

async function measure(
  label: string,
  binary: string,
  lane: Lane,
  options: Options,
  env: Env,
  spans: SinkSpan[],
  events: StorageEvent[],
): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (let round = 0; round < options.rounds; round++) {
    for (const member of lane.members) {
      for (const [command, args] of Object.entries(COMMANDS)) {
        samples.push(
          await sampleOnce(
            label,
            binary,
            member,
            command,
            args,
            round,
            env,
            spans,
            events,
          ),
        );
      }
    }
  }
  return samples;
}

async function measureCold(
  lanes: readonly [string, string, Lane][],
  options: Options,
  env: Env,
  spans: SinkSpan[],
  events: StorageEvent[],
): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (let round = 0; round < options.coldRounds; round++) {
    console.error(`idling ${options.idleMs} ms for cold reads, round ${round + 1}`);
    await delay(options.idleMs);
    for (const [label, binary, lane] of lanes) {
      for (const member of lane.members) {
        samples.push(
          await sampleOnce(
            label,
            binary,
            member,
            "cold data get",
            COMMANDS["data get"],
            round,
            env,
            spans,
            events,
          ),
        );
      }
    }
  }
  return samples;
}

async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isSymlink) continue;
    if (entry.isDirectory) total += await treeBytes(path);
    else total += (await Deno.lstat(path)).size;
  }
  return total;
}

// a datastore's cache can live under ~/.swamp/repos/<repoId>, outside the repo
async function homeCacheOf(repo: string): Promise<string | undefined> {
  const marker = await Deno.readTextFile(join(repo, ".swamp.yaml"));
  const id = /^repoId:\s*"?([^"\s]+)"?/m.exec(marker)?.[1];
  const home = Deno.env.get("HOME");
  return id === undefined || home === undefined
    ? undefined
    : join(home, ".swamp", "repos", id);
}

async function storedBytes(repo: string): Promise<number> {
  const cache = await homeCacheOf(repo);
  let cached = 0;
  if (cache !== undefined) {
    try {
      cached = await treeBytes(cache);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return (await treeBytes(repo)) + cached;
}

// every repo the lane made, so their home caches go when it ends
const laneRepos: string[] = [];

interface CloneSample {
  readonly binary: string;
  readonly kind: string;
  readonly round: number;
  readonly ms: number;
  readonly code: number;
  readonly bytes: number;
}

async function measureClone(
  label: string,
  binary: string,
  lane: Lane,
  options: Options,
  env: Env,
): Promise<CloneSample[]> {
  const samples: CloneSample[] = [];
  const m1 = lane.members[0];
  for (let round = 0; round < options.cloneRounds; round++) {
    const repo = join(dirname(lane.leader.repo), `clone-${round + 1}`);
    await initRepo(binary, repo, baseEnv(env));
    await pointAtServe(repo, lane.leader.repo, m1.origin);
    const before = await storedBytes(repo);
    const result = await run(
      binary,
      ["data", "list", WRITER, "--json"],
      repo,
      memberEnv(env, { ...m1, repo }),
      false,
    );
    if (result.code !== 0) {
      console.error(
        `  ${label} v3 clone: exit ${result.code}: ${
          result.stderr.trim().split("\n").slice(-3).join(" | ")
        }`,
      );
    }
    samples.push({
      binary: label,
      kind: "v3 member clone",
      round,
      ms: result.ms,
      code: result.code,
      bytes: (await storedBytes(repo)) - before,
    });
  }
  return samples;
}

async function measureV2Clone(
  label: string,
  binary: string,
  options: Options,
  env: Env,
): Promise<CloneSample[]> {
  const samples: CloneSample[] = [];
  const root = join(options.workDir, `${label}-v2`);
  const runEnv = baseEnv(env);
  const config = gcsConfig(
    `${label}-v2-${crypto.randomUUID().slice(0, 8)}`,
    env.storageHost,
  );
  const writer = join(root, "writer");
  await initRepo(binary, writer, runEnv);
  await run(binary, [
    "datastore",
    "setup",
    "extension",
    GCS_EXTENSION,
    "--config",
    config,
    "--json",
  ], writer, runEnv);
  await run(binary, [
    "model",
    "create",
    "command/shell",
    WRITER,
    "--global-arg",
    "run=echo written",
    "--json",
  ], writer, runEnv);
  await run(binary, [
    "model",
    "create",
    "command/shell",
    BIG,
    "--global-arg",
    bigRun(options.largeKib),
    "--json",
  ], writer, runEnv);
  console.error(`seeding the ${label} v2 bucket`);
  for (let i = 0; i < options.history; i++) {
    await run(binary, [...COMMANDS.write, "--json"], writer, runEnv);
  }
  for (let i = 0; i < options.largeHistory; i++) {
    await run(
      binary,
      ["model", "method", "run", BIG, "execute", "--json"],
      writer,
      runEnv,
    );
  }
  for (const mode of options.v2Hydration) {
    for (let round = 0; round < options.cloneRounds; round++) {
      const repo = join(root, `clone-${mode}-${round + 1}`);
      await initRepo(binary, repo, runEnv);
      // v2 keeps definitions in the repo, so a git clone brings them along
      await new Deno.Command("cp", {
        args: ["-R", join(writer, "models"), join(repo, "models")],
      }).output();
      const before = await storedBytes(repo);
      const started = performance.now();
      const setup = await run(binary, [
        "datastore",
        "setup",
        "extension",
        GCS_EXTENSION,
        "--config",
        config,
        "--hydration-strategy",
        mode,
        "--json",
      ], repo, runEnv, false);
      const list = setup.code === 0
        ? await run(binary, ["data", "list", WRITER, "--json"], repo, runEnv, false)
        : setup;
      if (list.code !== 0) {
        console.error(
          `  ${label} v2 clone (${mode}): exit ${list.code}: ${
            list.stderr.trim().split("\n").slice(-3).join(" | ")
          }`,
        );
      }
      samples.push({
        binary: label,
        kind: `v2 clone (${mode})`,
        round,
        ms: performance.now() - started,
        code: list.code,
        bytes: (await storedBytes(repo)) - before,
      });
    }
  }
  return samples;
}

interface StartupSample {
  readonly binary: string;
  readonly telemetry: boolean;
  readonly ms: number;
}

// a local ingest answering after the injected delay, so no lane run reaches
// the real telemetry endpoint
function startTelemetryIngest(
  port: number,
  latencyMs: number,
  posts: { count: number },
): Deno.HttpServer {
  return Deno.serve(
    { hostname: "127.0.0.1", port, onListen: () => {} },
    async (req) => {
      await req.body?.cancel();
      if (req.method === "POST") posts.count++;
      await delay(latencyMs);
      return new Response(null, { status: 202 });
    },
  );
}

async function measureStartup(
  label: string,
  binary: string,
  lane: Lane,
  options: Options,
  env: Env,
  ingest: string,
): Promise<StartupSample[]> {
  const samples: StartupSample[] = [];
  const m1 = lane.members[0];
  const off = memberEnv(env, m1);
  const { SWAMP_NO_TELEMETRY: _a, DO_NOT_TRACK: _b, ...rest } = off;
  const on = {
    ...rest,
    SWAMP_TELEMETRY_ENDPOINT: ingest,
    // the spool stays inside the lane
    SWAMP_CONFIG_DIR: join(options.workDir, `${label}-telemetry-config`),
  };
  for (let round = 0; round < options.startupRounds; round++) {
    for (const [telemetry, runEnv] of [[false, off], [true, on]] as const) {
      const result = await run(binary, ["version", "--json"], m1.repo, runEnv);
      samples.push({ binary: label, telemetry, ms: result.ms });
    }
  }
  return samples;
}

async function sustainedWrites(
  label: string,
  binary: string,
  lane: Lane,
  options: Options,
  env: Env,
  limiter: ObjectRateLimiter,
) {
  const fromRefusal = limiter.refused.length;
  limiter.enforce(true);
  const until = Date.now() + options.sustainedWritesMs;
  const failures: { member: string; error: string }[] = [];
  let writes = 0;
  await Promise.all(lane.members.map(async (member) => {
    while (Date.now() < until) {
      const result = await memberRun(binary, env, member, [...COMMANDS.write]);
      writes++;
      if (result.code !== 0) {
        failures.push({
          member: member.name,
          error: (result.stderr || result.stdout).slice(-600),
        });
      }
    }
  }));
  limiter.enforce(false);
  const refused = limiter.refused.slice(fromRefusal);
  const byObject: Record<string, number> = {};
  for (const { object } of refused) {
    const kind = object.replace(/[0-9a-f]{16,}|\d{6,}/g, "*");
    byObject[kind] = (byObject[kind] ?? 0) + 1;
  }
  return {
    label,
    writes,
    failed: failures.length,
    failedOn429: failures.filter((f) => /429|rateLimitExceeded/.test(f.error))
      .length,
    refusedByProxy: refused.length,
    refusedObjects: byObject,
    sampleFailure: failures[0],
  };
}

async function seedHistory(
  binary: string,
  lane: Lane,
  options: Options,
  env: Env,
): Promise<void> {
  const member = lane.members[0];
  for (let i = 0; i < options.history; i++) {
    await memberRun(binary, env, member, [...COMMANDS.write]);
  }
  for (let i = 0; i < options.largeHistory; i++) {
    await memberRun(binary, env, member, ["model", "method", "run", BIG, "execute"]);
  }
}

function spanTotal(sample: Sample, name: string): number {
  return sample.spans
    .filter((span) => span.name === name)
    .reduce((sum, span) => sum + span.endMs - span.startMs, 0);
}

function outsideCliMs(sample: Sample): number {
  return sample.ms - spanTotal(sample, "swamp.cli");
}

// K2a: the swamp.cli span less bootstrap and the method's own execution
function k2aMs(sample: Sample): number {
  const total = (name: string) =>
    sample.spans
      .filter((span) => span.name === name)
      .reduce((sum, span) => sum + span.endMs - span.startMs, 0);
  return total("swamp.cli") - total("swamp.cli.bootstrap") -
    total("swamp.method.execute");
}

export function summarize(
  samples: readonly Sample[],
  options: Pick<
    Options,
    "latencyMs" | "handshakeRtts" | "rounds" | "followers" | "farLatencyMs"
  >,
): string {
  const lines: string[] = [];
  lines.push(
    `latency ${options.latencyMs} ms per storage request, ${options.handshakeRtts} handshake RTTs per new connection, ${options.rounds} rounds`,
  );
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    const near = sample.member === "m3" &&
        (options.followers > 0 || options.farLatencyMs > 0)
      ? "far"
      : "near";
    const key = `${sample.binary} | ${sample.command} | ${near}`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  lines.push(
    "binary | command | member | n | failed | wall p50 / p95 ms | K2a p50 / p95 ms | outside swamp.cli p50 ms | teardown p50 ms | requests to serve (median) | storage requests (median)",
  );
  for (const [key, group] of groups) {
    const ok = group.filter((sample) => sample.code === 0);
    const ms = ok.map((sample) => sample.ms);
    const k2a = ok.map(k2aMs);
    const outside = ok.map(outsideCliMs);
    const teardown = ok.map((sample) =>
      spanTotal(sample, "swamp.cli.teardown")
    );
    const requests = ok.map((sample) => sample.memberRequests.length);
    const storage = ok.map((sample) =>
      Object.values(sample.storage).reduce((a, b) => a + b, 0)
    );
    lines.push(
      `${key} | ${group.length} | ${group.length - ok.length} | ${
        Math.round(percentile(ms, 50))
      } / ${Math.round(percentile(ms, 95))} | ${
        Math.round(percentile(k2a, 50))
      } / ${Math.round(percentile(k2a, 95))} | ${
        Math.round(percentile(outside, 50))
      } | ${Math.round(percentile(teardown, 50))} | ${
        percentile(requests, 50)
      } | ${
        percentile(storage, 50)
      }`,
    );
  }
  return lines.join("\n");
}

/**
 * a workflow sample split as the dogfood breakdown splits it: before the first
 * step, the steps, the workflow's own work outside them, and teardown
 */
function workflowPhases(sample: Sample) {
  const cli = sample.spans.find((span) => span.name === "swamp.cli");
  const steps = sample.spans.filter((span) =>
    span.name === "swamp.workflow.step"
  ).sort((a, b) => a.startMs - b.startMs);
  if (cli === undefined || steps.length === 0) return undefined;
  const stepMs = steps.map((span) => span.endMs - span.startMs);
  const teardown = spanTotal(sample, "swamp.cli.teardown");
  const before = steps[0].startMs - cli.startMs;
  const inside = cli.endMs - cli.startMs;
  const commits = sample.memberRequests.filter((request) =>
    request === "POST commits" ||
    request === "POST partitions/{partition}/commits"
  ).length;
  const requestSpans = sample.spans.filter((span) =>
    span.name === "swamp.datastore.v3.serve.request"
  );
  const within = (from: number, to: number) =>
    requestSpans.filter((span) => span.startMs >= from && span.startMs < to)
      .length;
  const stepRequests = steps.map((span) => within(span.startMs, span.endMs));
  const beforeRequests = within(cli.startMs, steps[0].startMs);
  return {
    startup: sample.ms - inside,
    before,
    steps: stepMs,
    workflowLevel: inside - before - stepMs.reduce((a, b) => a + b, 0) -
      teardown,
    teardown,
    commits,
    requests: sample.memberRequests.length,
    beforeRequests,
    stepRequests,
    workflowLevelRequests: sample.memberRequests.length - beforeRequests -
      stepRequests.reduce((a, b) => a + b, 0),
  };
}

export function summarizeWorkflows(
  samples: readonly Sample[],
  options: Pick<Options, "followers" | "farLatencyMs">,
): string {
  const lines = [
    "binary | workflow | member | n | wall p50 / p95 ms | start-up p50 | before p50 | step 1 p50 | step 2 p50 | workflow-level p50 | teardown p50 / max | commit requests | requests | requests before / step 1 / step 2 / workflow-level",
  ];
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    if (!sample.command.endsWith("workflow") || sample.code !== 0) continue;
    const far = sample.member === "m3" &&
      (options.followers > 0 || options.farLatencyMs > 0);
    const key = `${sample.binary} | ${sample.command} | ${
      far ? "far" : "near"
    }`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  const p50 = (values: number[]) => Math.round(percentile(values, 50));
  for (const [key, group] of groups) {
    const phases = group.map(workflowPhases).filter((p) => p !== undefined);
    lines.push(
      `${key} | ${group.length} | ${p50(group.map((s) => s.ms))} / ${
        Math.round(percentile(group.map((s) => s.ms), 95))
      } | ${p50(phases.map((p) => p.startup))} | ${
        p50(phases.map((p) => p.before))
      } | ${p50(phases.map((p) => p.steps[0] ?? 0))} | ${
        p50(phases.map((p) => p.steps[1] ?? 0))
      } | ${p50(phases.map((p) => p.workflowLevel))} | ${
        p50(phases.map((p) => p.teardown))
      } / ${Math.round(Math.max(...phases.map((p) => p.teardown)))} | ${
        p50(phases.map((p) => p.commits))
      } | ${p50(phases.map((p) => p.requests))} | ${
        p50(phases.map((p) => p.beforeRequests))
      } / ${p50(phases.map((p) => p.stepRequests[0] ?? 0))} / ${
        p50(phases.map((p) => p.stepRequests[1] ?? 0))
      } / ${p50(phases.map((p) => p.workflowLevelRequests))}`,
    );
  }
  return lines.join("\n");
}

export function summarizeClones(samples: readonly CloneSample[]): string {
  const lines = [
    "binary | clone | n | failed | wall p50 ms | bytes stored p50 (MB)",
  ];
  const groups = new Map<string, CloneSample[]>();
  for (const sample of samples) {
    const key = `${sample.binary} | ${sample.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  for (const [key, group] of groups) {
    const ok = group.filter((sample) => sample.code === 0);
    lines.push(
      `${key} | ${group.length} | ${group.length - ok.length} | ${
        Math.round(percentile(ok.map((s) => s.ms), 50))
      } | ${
        (percentile(ok.map((s) => s.bytes), 50) / 1_048_576).toFixed(1)
      }`,
    );
  }
  return lines.join("\n");
}

export function summarizeStartup(
  samples: readonly StartupSample[],
  flushes: number,
): string {
  const lines = [
    `swamp version in a member checkout; ${flushes} telemetry posts to the local ingest`,
    "binary | telemetry | n | wall p50 / p95 ms",
  ];
  for (const binary of new Set(samples.map((sample) => sample.binary))) {
    for (const telemetry of [false, true]) {
      const ms = samples
        .filter((s) => s.binary === binary && s.telemetry === telemetry)
        .map((s) => s.ms);
      lines.push(
        `${binary} | ${telemetry ? "on" : "off"} | ${ms.length} | ${
          Math.round(percentile(ms, 50))
        } / ${Math.round(percentile(ms, 95))}`,
      );
    }
  }
  return lines.join("\n");
}

// a serve span is the member request's child once serve adopts the member's
// traceparent; a binary that ignores it is matched by route and time window
export function breakdown(samples: readonly Sample[], label: string): string {
  const lines: string[] = [];
  for (const command of Object.keys(COMMANDS)) {
    const group = samples
      .filter((sample) =>
        sample.binary === label && sample.command === command &&
        sample.member === "m1" && sample.code === 0
      )
      .sort((a, b) => a.ms - b.ms);
    if (group.length === 0) continue;
    const median = group[Math.floor(group.length / 2)];
    lines.push(
      `\n${label} ${command} (m1, ${Math.round(median.ms)} ms, ${median.memberRequests.length} requests to serve)`,
    );
    const byId = new Map(median.spans.map((span) => [span.spanId, span]));
    const under = (root: SinkSpan) =>
      median.spans.filter((span) => {
        for (
          let parent = byId.get(span.parentSpanId);
          parent !== undefined;
          parent = byId.get(parent.parentSpanId)
        ) {
          if (parent.spanId === root.spanId) return true;
        }
        return false;
      });
    const requests = median.spans
      .filter((span) => span.name === "swamp.datastore.v3.serve.request")
      .sort((a, b) => a.startMs - b.startMs);
    const parentName = (span: SinkSpan) =>
      byId.get(span.parentSpanId)?.name ?? "";
    for (const request of requests) {
      const route = String(request.attributes["http.route"]);
      const method = String(request.attributes["http.request.method"]);
      const server = median.spans.find((span) =>
        span.parentSpanId === request.spanId &&
        span.name.startsWith(`${method} /api/v1/datastore/`)
      ) ?? median.spans.find((span) =>
        span.name === `${method} /api/v1/datastore/{namespace}/${route}` &&
        span.startMs >= request.startMs - 2 && span.endMs <= request.endMs + 2
      );
      const storage = server === undefined
        ? []
        : under(server).filter((span) => span.name.startsWith("GCS ") ||
          span.name.startsWith("S3 "));
      const auth = server?.attributes["swamp.serve.auth_ms"];
      lines.push(
        `  ${String(request.endMs - request.startMs).padStart(5)} ms  ${method} ${route}  [${
          parentName(request).replace("swamp.datastore.v3.serve.", "")
        }]${auth === undefined ? "" : `  auth ${auth} ms`}`,
      );
      for (const call of storage) {
        const key = String(call.attributes["gcp.gcs.key"] ?? "")
          .replace(/[0-9a-f]{64}/, "<sha256>");
        lines.push(
          `           ${String(call.endMs - call.startMs).padStart(5)} ms  ${call.name} ${key}`,
        );
      }
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseOptions();
  await Deno.mkdir(options.workDir, { recursive: true });
  const spans: SinkSpan[] = [];
  const events: StorageEvent[] = [];
  const gcsPort = freePort();
  const proxyPort = freePort();
  const otlpPort = freePort();
  const ingestPort = freePort();
  const posts = { count: 0 };
  const ingest = startTelemetryIngest(
    ingestPort,
    options.telemetryLatencyMs,
    posts,
  );
  const clones: CloneSample[] = [];
  const startups: StartupSample[] = [];
  const container = `swamp-team-lane-${crypto.randomUUID().slice(0, 8)}`;
  await new Deno.Command("docker", {
    args: [
      "run",
      "-d",
      "--name",
      container,
      "-p",
      `127.0.0.1:${gcsPort}:4443`,
      options.fakeGcsImage,
      "-scheme",
      "http",
      "-port",
      "4443",
      // its own address: it serves a download only when the Host header names
      // it, and fetch sends the upstream's; the proxy rewrites links back
      "-public-host",
      `127.0.0.1:${gcsPort}`,
    ],
    stdout: "null",
  }).output();
  const limiter = objectRateLimiter(options.objectRateLimitMs);
  const proxy = startStorageProxy(
    proxyPort,
    `http://127.0.0.1:${gcsPort}`,
    options.latencyMs,
    options.handshakeRtts,
    events,
    limiter,
  );
  const sink = startOtlpSink(otlpPort, spans);
  const env: Env = {
    home: options.workDir,
    storageHost: `127.0.0.1:${proxyPort}`,
    otlp: `http://127.0.0.1:${otlpPort}`,
  };
  const all: Sample[] = [];
  try {
    for (let i = 0; i < 120; i++) {
      try {
        const response = await fetch(
          `http://127.0.0.1:${gcsPort}/storage/v1/b?project=test`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: BUCKET }),
          },
        );
        await response.body?.cancel();
        if (response.status < 500) break;
      } catch {
        // not up yet
      }
      await delay(250);
    }
    const lanes: [string, string, Lane][] = [];
    for (const [label, binary] of Object.entries(options.binaries)) {
      console.error(`setting up the ${label} lane`);
      const lane = await setUpLane(binary, label, options, env);
      lanes.push([label, binary, lane]);
      if (options.setupOnly) {
        console.error(JSON.stringify({
          storageHost: env.storageHost,
          otlp: env.otlp,
          leader: lane.leader.origin,
          members: lane.members,
        }));
        await new Promise<void>((done) =>
          Deno.addSignalListener("SIGINT", () => done())
        );
        await lane.stop();
        return;
      }
      await seedMember(
        binary,
        env,
        lane.members[0],
        options.largeKib,
        options.stepSleepMs,
      );
      console.error(`seeding ${options.history} commits`);
      await seedHistory(binary, lane, options, env);
    }
    if (options.sustainedWritesMs > 0) {
      for (const [label, binary, lane] of lanes) {
        console.error(`sustained writes on ${label}`);
        console.log(JSON.stringify(
          await sustainedWrites(label, binary, lane, options, env, limiter),
        ));
      }
      for (const [, , lane] of lanes) await lane.stop();
      return;
    }
    // Interleaved blocks, so drift on the host lands on every binary alike.
    for (let block = 0; block < 2; block++) {
      for (const [label, binary, lane] of lanes) {
        console.error(`measuring ${label}, block ${block + 1}`);
        all.push(
          ...await measure(
            label,
            binary,
            lane,
            { ...options, rounds: Math.ceil(options.rounds / 2) },
            env,
            spans,
            events,
          ),
        );
      }
    }
    all.push(...await measureCold(lanes, options, env, spans, events));
    for (const [label, binary, lane] of lanes) {
      console.error(`measuring ${label} start-up and fresh clones`);
      startups.push(
        ...await measureStartup(
          label,
          binary,
          lane,
          options,
          env,
          `http://127.0.0.1:${ingestPort}`,
        ),
      );
      clones.push(...await measureClone(label, binary, lane, options, env));
    }
    for (const [, , lane] of lanes) await lane.stop();
    if (options.v2Hydration.length > 0) {
      for (const [label, binary] of Object.entries(options.binaries)) {
        clones.push(...await measureV2Clone(label, binary, options, env));
      }
    }
  } finally {
    await Deno.writeTextFile(
      join(options.workDir, "samples.json"),
      JSON.stringify(all, null, 1),
    );
    console.log(summarize(all, options));
    console.log(summarizeWorkflows(all, options));
    console.log(`\n${summarizeStartup(startups, posts.count)}`);
    console.log(`\n${summarizeClones(clones)}`);
    for (const label of new Set(all.map((s) => s.binary))) {
      console.log(breakdown(all, label));
    }
    console.error(`samples: ${join(options.workDir, "samples.json")}`);
    // serve's Litestream supervisors outlive it until they idle out
    await new Deno.Command("pkill", {
      args: ["-f", `__swamp_v3_replication_supervisor --db ${options.workDir}`],
      stdout: "null",
      stderr: "null",
    }).output();
    await proxy.shutdown();
    await sink.shutdown();
    await ingest.shutdown();
    if (!options.keep) {
      for (const repo of laneRepos) {
        const cache = await homeCacheOf(repo).catch(() => undefined);
        if (cache !== undefined) {
          await Deno.remove(cache, { recursive: true }).catch(() => {});
        }
      }
    }
    if (!options.keep) {
      await new Deno.Command("docker", {
        args: ["rm", "-f", container],
        stdout: "null",
        stderr: "null",
      }).output();
    }
  }
}

if (import.meta.main) await main();
