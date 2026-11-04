import { expect, test } from "bun:test";
import { connectApp, createMockHost } from "@swamp-club/app-sdk";

// createMockHost stands in for the dashboard and refuses what app.yaml would
test("the app's reads answer through a mock host", async () => {
  const host = createMockHost({
    app: { capabilities: ["runs:read"] },
    responses: {
      "workflow.run.summary": { data: { totals: { runs: 3 } } },
    },
  });
  const { client } = await connectApp({}, host.port);
  const reply = await client.request("workflow.run.summary", { since: "14d" });
  expect(reply).toEqual({ data: { totals: { runs: 3 } } });
});
