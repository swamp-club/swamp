// A creek that exposes the example MySQL container as a queryable
// surface inside CEL. End-users call its methods from `swamp data query`
// — e.g. `creek("@example/mysql", "audits_for", {customer: "acme-corp"})`.

import { z } from "zod";
import mysql from "mysql2/promise";

const defineCreek = <T>(def: T): T => def;
const defineCreekMethod = <T>(def: T): T => def;

const MYSQL_CONN = {
  host: "127.0.0.1",
  port: 3309,
  user: "example",
  password: "example",
  database: "example",
  connectionLimit: 4,
  // Return bigints from BIGINT columns as plain numbers — easier to use
  // from CEL. The seeded ids are small so precision is safe.
  supportBigNumbers: false,
};

let _pool: mysql.Pool | undefined;
function getPool(): mysql.Pool {
  if (!_pool) _pool = mysql.createPool(MYSQL_CONN);
  return _pool;
}

export const creek = defineCreek({
  type: "@example/mysql",
  version: "2026.06.01.1",
  description: "Query the example MySQL deployment audit log",
  methods: {
    audits_for: defineCreekMethod({
      description: "All deploy audits for one customer, newest first",
      arguments: z.object({ customer: z.string() }),
      execute: async (args: { customer: string }) => {
        const pool = getPool();
        const [rows] = await pool.query(
          "select customer, service, status, duration_ms, deployed_at " +
            "from deploy_audits where customer = ? order by deployed_at desc",
          [args.customer],
        );
        return rows;
      },
    }),
    last_deploy_for: defineCreekMethod({
      description: "Most recent deploy audit for one customer (or null)",
      arguments: z.object({ customer: z.string() }),
      execute: async (args: { customer: string }) => {
        const pool = getPool();
        const [rows] = await pool.query(
          "select customer, service, status, duration_ms, deployed_at " +
            "from deploy_audits where customer = ? " +
            "order by deployed_at desc limit 1",
          [args.customer],
        );
        const list = rows as Array<Record<string, unknown>>;
        return list[0] ?? null;
      },
    }),
    failed_since: defineCreekMethod({
      description:
        "All failed deploys since a given ISO timestamp (across all customers)",
      arguments: z.object({ since: z.string() }),
      execute: async (args: { since: string }) => {
        const pool = getPool();
        const [rows] = await pool.query(
          "select customer, service, status, duration_ms, deployed_at " +
            "from deploy_audits where status = 'failed' and deployed_at >= ? " +
            "order by deployed_at desc",
          [args.since],
        );
        return rows;
      },
    }),
  },
});
