// swamp-club#3357 bucket-latency model. Throwaway: spike branch only.
//
// HTTP proxy in front of an emulator that adds:
//   - one RTT to every request,
//   - K extra RTTs to the first request on each new client connection
//     (stands in for the TCP and TLS 1.3 handshakes),
//   - an optional throughput cap on request and response bodies.
// It counts requests by operation, bytes each way, and new client
// connections. Deno.serve keeps one HTTP/1.1 connection per client socket,
// keyed here on the client port, so a client's connection pool shows up as
// the number of distinct ports.
//
// Usage: bucket_proxy.ts <listenPort> <targetBase> <rttMs> <K> <mbps|0>
// Control: GET /__proxy/stats, POST /__proxy/reset
const [listen, target, rttStr, kStr, mbpsStr] = Deno.args;
const rtt = Number(rttStr), K = Number(kStr), mbps = Number(mbpsStr ?? 0);
const sleep = (ms: number) =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

const seen = new Set<string>();
let stats = fresh();
function fresh() {
  return {
    requests: 0,
    connections: 0,
    bytesUp: 0,
    bytesDown: 0,
    ops: {} as Record<string, number>,
  };
}

/** Classifies a request as an object-store operation. */
function op(req: Request, u: URL): string {
  const m = req.method;
  if (m === "GET") {
    // S3: ?list-type=2 on the bucket; GCS: /storage/v1/b/<b>/o without name.
    if (u.searchParams.has("list-type") || /\/o\/?$/.test(u.pathname)) {
      return "LIST";
    }
    return "GET";
  }
  return m;
}

/**
 * The throughput cap is one shared link per direction, not a cap per
 * request: each chunk reserves the next free slot on its direction's link,
 * so parallel transfers share the bandwidth the way they do on a real link.
 */
const linkFreeAt = { up: 0, down: 0 };

/** Paces a body stream on the shared link and counts its bytes. */
function paced(
  body: ReadableStream<Uint8Array> | null,
  dir: "up" | "down",
  count: (n: number) => void,
): ReadableStream<Uint8Array> | null {
  if (body === null) return null;
  const bytesPerMs = mbps > 0 ? (mbps * 1e6) / 8 / 1000 : 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, ctl) {
        count(chunk.byteLength);
        if (bytesPerMs > 0) {
          const start = Math.max(performance.now(), linkFreeAt[dir]);
          linkFreeAt[dir] = start + chunk.byteLength / bytesPerMs;
          await sleep(linkFreeAt[dir] - performance.now());
        }
        ctl.enqueue(chunk);
      },
    }),
  );
}

Deno.serve({ port: Number(listen), onListen() {} }, async (req, info) => {
  const u = new URL(req.url);
  if (u.pathname === "/__proxy/stats") return Response.json(stats);
  if (u.pathname === "/__proxy/reset") {
    stats = fresh();
    return Response.json({ ok: true });
  }
  const key = `${info.remoteAddr.hostname}:${info.remoteAddr.port}`;
  let delay = rtt;
  if (!seen.has(key)) {
    seen.add(key);
    stats.connections++;
    delay += K * rtt;
  }
  stats.requests++;
  const o = op(req, u);
  stats.ops[o] = (stats.ops[o] ?? 0) + 1;
  await sleep(delay);
  const headers = new Headers(req.headers);
  headers.delete("host");
  // The whole request body is read (paced) before anything goes upstream,
  // the way a real bucket refuses a body shorter than its Content-Length.
  // Streaming it on would turn an upload the client abandoned half way into
  // a truncated object on the emulator.
  let body: Uint8Array<ArrayBuffer> | undefined;
  try {
    const p = paced(req.body, "up", (n) => (stats.bytesUp += n));
    body = p ? new Uint8Array(await new Response(p).arrayBuffer()) : undefined;
  } catch {
    stats.ops.ABORTED = (stats.ops.ABORTED ?? 0) + 1;
    return new Response(null, { status: 400 });
  }
  const expected = req.headers.get("content-length");
  if (expected !== null && body !== undefined && body.byteLength !== Number(expected)) {
    stats.ops.ABORTED = (stats.ops.ABORTED ?? 0) + 1;
    return new Response(null, { status: 400 });
  }
  const res = await fetch(target + u.pathname + u.search, {
    method: req.method,
    headers,
    body,
    redirect: "manual",
  });
  return new Response(paced(res.body, "down", (n) => (stats.bytesDown += n)), {
    status: res.status,
    headers: res.headers,
  });
});
