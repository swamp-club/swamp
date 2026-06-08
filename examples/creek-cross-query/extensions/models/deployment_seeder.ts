// Seeds a handful of swamp `deployment` resources. Each carries a
// `customer` and `service` field — the cross-query examples in the
// README join these against the Postgres customers table and the
// MySQL deploy_audits table.

import { z } from "zod";

const defineModel = <T>(def: T): T => def;

const DeploymentSchema = z.object({
  customer: z.string(),
  service: z.string(),
  environment: z.enum(["prod", "staging", "dev"]),
  version: z.string(),
});

export const model = defineModel({
  type: "@example/deployment",
  version: "2026.06.01.1",
  resources: {
    spec: {
      description: "A single deployment record",
      schema: DeploymentSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    seed: {
      description: "Write a fixed set of deployment resources",
      arguments: z.object({}),
      // deno-lint-ignore no-explicit-any
      execute: async (_args: unknown, ctx: any) => {
        const seeds = [
          { customer: "acme-corp", service: "api", environment: "prod", version: "v2.3.1" },
          { customer: "acme-corp", service: "web", environment: "prod", version: "v2.3.1" },
          { customer: "beech-labs", service: "api", environment: "prod", version: "v1.9.0" },
          { customer: "cedar-systems", service: "api", environment: "staging", version: "v0.4.2" },
          { customer: "elm-bank", service: "api", environment: "prod", version: "v4.0.0" },
          { customer: "elm-bank", service: "web", environment: "prod", version: "v4.0.0" },
          { customer: "dogwood-io", service: "api", environment: "dev", version: "v0.0.7" },
          // fir-and-co exists in Postgres but has no swamp deployments —
          // gives us a "in pg but not in swamp" case for set-difference examples.
        ];
        const handles = [];
        for (const seed of seeds) {
          const name = `${seed.customer}-${seed.service}`;
          handles.push(await ctx.writeResource("spec", name, seed));
        }
        return { dataHandles: handles };
      },
    },
  },
});
