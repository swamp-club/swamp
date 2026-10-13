// Fake ECS/container credentials endpoint. Usage: creds_server.ts <port> <delayMs>
// GET /ready and GET /hits answer at once; every other path is a credential
// fetch, delayed by delayMs (swamp-club#3357 models credential chains).
const [port, delay] = Deno.args.map(Number);
let hits = 0;
Deno.serve({ port, onListen() {} }, async (req) => {
  const path = new URL(req.url).pathname;
  if (path === "/ready") return new Response("ok");
  if (path === "/hits") return Response.json({ hits });
  hits++;
  await new Promise((r) => setTimeout(r, delay));
  return Response.json({ AccessKeyId: "test", SecretAccessKey: "test", Token: "tok", Expiration: new Date(Date.now() + 3600e3).toISOString() });
});
