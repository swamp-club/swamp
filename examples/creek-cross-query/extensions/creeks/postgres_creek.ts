// A creek that exposes the example Postgres container as a queryable
// surface inside CEL. End-users call its methods from `swamp data query`
// — e.g. `creek("@example/postgres", "customer", {name: "acme-corp"}).plan`.
//
// The connection is shared across all calls in a single CEL evaluation
// (the swamp runtime memoises by `(type, method, argsHash)`), so a
// 1000-row predicate calling `customer(name)` for 30 distinct names
// hits Postgres 30 times, not 1000.

import { z } from "zod";
import postgres from "postgres";

// Local helpers — the swamp runtime validates the exported `creek`
// structurally via Zod, so these can be plain identity functions. In
// production you would import them from `@swamp/swamp/libswamp`.
const defineCreek = <T>(def: T): T => def;
const defineCreekMethod = <T>(def: T): T => def;

const PG_CONN = {
  host: "127.0.0.1",
  port: 5439,
  user: "example",
  password: "example",
  database: "example",
  // Keep the pool small — creeks run in short-lived CLI invocations.
  max: 4,
  idle_timeout: 5,
};

let _sql: ReturnType<typeof postgres> | undefined;
function getSql(): ReturnType<typeof postgres> {
  if (!_sql) _sql = postgres(PG_CONN);
  return _sql;
}

export const creek = defineCreek({
  type: "@example/postgres",
  version: "2026.06.01.1",
  description: "Query the example Postgres customers + incidents tables",
  methods: {
    customer: defineCreekMethod({
      description: "Look up one customer by primary-key name",
      arguments: z.object({ name: z.string() }),
      execute: async (args: { name: string }) => {
        const sql = getSql();
        const rows = await sql`
          select name, plan, last_login, mrr_cents
          from customers
          where name = ${args.name}
        `;
        return rows[0] ?? null;
      },
    }),
    customers_on_plan: defineCreekMethod({
      description: "List every customer on a given plan",
      arguments: z.object({ plan: z.string() }),
      execute: async (args: { plan: string }) => {
        const sql = getSql();
        const rows = await sql`
          select name, plan, last_login, mrr_cents
          from customers
          where plan = ${args.plan}
          order by name
        `;
        return [...rows];
      },
    }),
    open_incidents_for: defineCreekMethod({
      description: "List open incidents for a single customer",
      arguments: z.object({ customer: z.string() }),
      execute: async (args: { customer: string }) => {
        const sql = getSql();
        const rows = await sql`
          select severity, opened_at
          from incidents
          where customer = ${args.customer}
          order by opened_at desc
        `;
        return [...rows];
      },
    }),
  },
});
