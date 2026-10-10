// HTTP proxy that adds one RTT per request and K extra RTTs on the first
// request of each new client connection (stand-in for TCP + TLS handshakes).
// Usage: rtt_proxy.ts <listenPort> <targetBase> <rttMs> [K=2]
const [listen, target, rttStr, kStr] = Deno.args;
const rtt = Number(rttStr), K = Number(kStr ?? 2);
const seen = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
Deno.serve({ port: Number(listen), onListen() {} }, async (req, info) => {
  const key = `${info.remoteAddr.hostname}:${info.remoteAddr.port}`;
  let delay = rtt;
  if (!seen.has(key)) { seen.add(key); delay += K * rtt; }
  await sleep(delay);
  const u = new URL(req.url);
  const headers = new Headers(req.headers);
  headers.delete("host");
  const res = await fetch(target + u.pathname + u.search, {
    method: req.method, headers, body: req.body, redirect: "manual",
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
});
