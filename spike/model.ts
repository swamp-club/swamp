// swamp-club#3357 bucket-latency model: profiles, proxies, credentials and a
// clean Litestream environment. Throwaway: spike branch only.
import { fromFileUrl, join } from "jsr:@std/path@1";
import * as L from "./lib.ts";

export type Backend = "s3" | "gs";

export interface Profile {
  name: string;
  backend: Backend;
  /** One round trip, ms. */
  rtt: number;
  /** Extra round trips on each new connection (TCP + TLS 1.3 = 2). */
  handshakeRtts: number;
  /** Throughput cap, Mbit/s; 0 = uncapped. */
  mbps: number;
}

export const PROFILES: Record<string, Profile> = {
  "s3-zero": { name: "s3-zero", backend: "s3", rtt: 0, handshakeRtts: 0, mbps: 0 },
  "gs-zero": { name: "gs-zero", backend: "gs", rtt: 0, handshakeRtts: 0, mbps: 0 },
  "s3-near": { name: "s3-near", backend: "s3", rtt: 20, handshakeRtts: 2, mbps: 200 },
  "s3-far": { name: "s3-far", backend: "s3", rtt: 150, handshakeRtts: 2, mbps: 100 },
  "gs-near": { name: "gs-near", backend: "gs", rtt: 20, handshakeRtts: 2, mbps: 200 },
};

/** Credential-chain stand-ins: delay of the first credential resolution. */
export const CREDS: Record<string, number> = {
  static: 0,
  identity: 50,
  sso: 600,
};

export const EMULATOR: Record<Backend, string> = {
  s3: `http://localhost:${Deno.env.get("S3_EMU_PORT") ?? "47357"}`,
  gs: `http://localhost:${Deno.env.get("GCS_EMU_PORT") ?? "47358"}`,
};
export const BUCKET = "lsbucket";

const here = (f: string) => fromFileUrl(new URL(f, import.meta.url));

async function freePort(): Promise<number> {
  const l = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

async function waitHttp(url: string) {
  for (let i = 0; i < 400; i++) {
    try {
      const r = await fetch(url);
      await r.body?.cancel();
      return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`not listening: ${url}`);
}

export interface ProxyStats {
  requests: number;
  connections: number;
  bytesUp: number;
  bytesDown: number;
  ops: Record<string, number>;
}

export interface Proxy {
  port: number;
  stats(): Promise<ProxyStats>;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export async function startProxy(p: Profile): Promise<Proxy> {
  const port = await freePort();
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run", "-A", here("./bucket_proxy.ts"), String(port), EMULATOR[p.backend],
      String(p.rtt), String(p.handshakeRtts), String(p.mbps),
    ],
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  const base = `http://127.0.0.1:${port}/__proxy`;
  await waitHttp(`${base}/stats`);
  return {
    port,
    async stats() {
      return await (await fetch(`${base}/stats`)).json();
    },
    async reset() {
      await (await fetch(`${base}/reset`, { method: "POST" })).body?.cancel();
    },
    async stop() {
      child.kill("SIGTERM");
      await child.status;
    },
  };
}

export interface Creds {
  port: number;
  hits(): Promise<number>;
  stop(): Promise<void>;
}

export async function startCreds(delayMs: number): Promise<Creds> {
  const port = await freePort();
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", here("./creds_server.ts"), String(port), String(delayMs)],
    stdout: "null",
    stderr: "null",
  }).spawn();
  await waitHttp(`http://127.0.0.1:${port}/ready`);
  return {
    port,
    async hits() {
      return (await (await fetch(`http://127.0.0.1:${port}/hits`)).json()).hits;
    },
    async stop() {
      child.kill("SIGTERM");
      await child.status;
    },
  };
}

/**
 * A clean environment for Litestream (and swamp): nothing ambient, no AWS
 * config or credential files, credentials only from the container endpoint.
 */
export function cleanEnv(
  backend: Backend,
  proxyPort: number,
  credsPort?: number,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    HOME: Deno.env.get("HOME") ?? "/tmp",
    TMPDIR: Deno.env.get("TMPDIR") ?? "/tmp",
  };
  if (backend === "s3") {
    env.AWS_CONFIG_FILE = "/nonexistent/aws-config";
    env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/aws-credentials";
    env.AWS_EC2_METADATA_DISABLED = "true";
    env.AWS_REGION = "us-east-1";
    if (credsPort !== undefined) {
      env.AWS_CONTAINER_CREDENTIALS_FULL_URI = `http://127.0.0.1:${credsPort}/creds`;
    } else {
      env.AWS_ACCESS_KEY_ID = "test";
      env.AWS_SECRET_ACCESS_KEY = "test";
    }
  } else {
    env.STORAGE_EMULATOR_HOST = `localhost:${proxyPort}`;
  }
  return env;
}

export function replicaSpec(
  backend: Backend,
  proxyPort: number,
  path: string,
): L.ReplicaSpec {
  return backend === "s3"
    ? { kind: "s3", bucket: BUCKET, path, endpoint: `http://localhost:${proxyPort}` }
    : { kind: "gs", bucket: BUCKET, path };
}

/** Median and p95 (nearest rank), plus min, max and n. */
export function summary(xs: number[]) {
  if (xs.length === 0) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const rank = (p: number) => s[Math.max(0, Math.ceil(p * s.length) - 1)];
  const r = (x: number) => +x.toFixed(1);
  return {
    n: s.length,
    min: r(s[0]),
    p50: r(rank(0.5)),
    p95: r(rank(0.95)),
    max: r(s[s.length - 1]),
  };
}

export function appendResult(file: string, row: unknown) {
  const dir = here("./results/3357");
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(join(dir, file), JSON.stringify(row) + "\n", {
    append: true,
  });
}

export async function loadAvg(): Promise<number> {
  const r = await new Deno.Command("sysctl", { args: ["-n", "vm.loadavg"] })
    .output();
  return Number(new TextDecoder().decode(r.stdout).trim().split(/\s+/)[1]);
}

/** Waits until the 1-minute load average drops below `max` (other sessions). */
export async function waitQuiet(max = 4, timeoutMs = 600_000) {
  const t0 = performance.now();
  while ((await loadAvg()) > max && performance.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5000));
  }
  return await loadAvg();
}
