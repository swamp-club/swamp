// Fake ECS/container credentials endpoint. Usage: creds_server.ts <port> <delayMs>
const [port, delay] = Deno.args.map(Number);
let hits = 0;
Deno.serve({ port, onListen() {} }, async () => {
  hits++;
  await new Promise((r) => setTimeout(r, delay));
  console.error(`creds hit ${hits}`);
  return Response.json({ AccessKeyId: "test", SecretAccessKey: "test", Token: "tok", Expiration: new Date(Date.now() + 3600e3).toISOString() });
});
