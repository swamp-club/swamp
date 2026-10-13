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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { join, toFileUrl } from "@std/path";
import type { BundleProbeRequest } from "../../domain/extensions/bundle_prober.ts";
import { WorkerBundleProber } from "./worker_bundle_prober.ts";

const VAULT = (type: string) => `
export const vault = {
  type: ${JSON.stringify(type)},
  name: "probe test vault",
  description: "a vault",
  createProvider: () => ({}),
};
`;

/**
 * Runs `fn` with a prober and a way to write bundles for it. The prober is
 * always released, so no worker outlives the test.
 */
async function withProber(
  options: { timeoutMs?: number; startupTimeoutMs?: number },
  fn: (args: {
    prober: WorkerBundleProber;
    type: (name: string) => string;
    bundle: (name: string, js: string) => Promise<BundleProbeRequest>;
  }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp_3374_prober_" });
  const id = crypto.randomUUID().slice(0, 8);
  const prober = new WorkerBundleProber(options);
  try {
    await fn({
      prober,
      type: (name) => `@test/prober-${id}-${name}`,
      bundle: async (name, js) => {
        const path = join(dir, `${name}.js`);
        await Deno.writeTextFile(path, js);
        return { importUrl: toFileUrl(path).href, kind: "vault" };
      },
    });
  } finally {
    prober.release();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("WorkerBundleProber: reports a primary export's type, version and description", async () => {
  await withProber({}, async ({ prober, type, bundle }) => {
    const result = await prober.probe(
      await bundle("ok", VAULT(type("ok"))),
    );
    assertEquals(result, {
      tag: "primary",
      typeNormalized: type("ok"),
      version: "",
      description: "a vault",
    });
  });
});

Deno.test("WorkerBundleProber: a bundle without the kind's export is no-export", async () => {
  await withProber({}, async ({ prober, bundle }) => {
    const result = await prober.probe(
      await bundle("helper", "export const helper = 1;\n"),
    );
    assertEquals(result, { tag: "no-export" });
  });
});

Deno.test("WorkerBundleProber: an export that fails the kind's schema is validation-failed", async () => {
  await withProber({}, async ({ prober, bundle }) => {
    const result = await prober.probe(
      await bundle("invalid", "export const vault = { type: 42 };\n"),
    );
    assertEquals(result.tag, "validation-failed");
  });
});

Deno.test("WorkerBundleProber: an import that throws is import-failed with the error's message", async () => {
  await withProber({}, async ({ prober, bundle }) => {
    const result = await prober.probe(
      await bundle("throws", 'throw new Error("boom at import");\n'),
    );
    assertEquals(result, { tag: "import-failed", message: "boom at import" });
  });
});

Deno.test("WorkerBundleProber: Deno.exit at import is exited with its code, and the process survives", async () => {
  await withProber({}, async ({ prober, type, bundle }) => {
    const result = await prober.probe(
      await bundle("exit", "Deno.exit(3);\n" + VAULT(type("exit"))),
    );
    assertEquals(result, { tag: "exited", code: 3 });
  });
});

Deno.test("WorkerBundleProber: an import that never settles is timed-out", async () => {
  await withProber({ timeoutMs: 200 }, async ({ prober, type, bundle }) => {
    const result = await prober.probe(
      await bundle(
        "hang",
        "await new Promise(() => {});\n" + VAULT(type("hang")),
      ),
    );
    assertEquals(result, { tag: "timed-out", timeoutMs: 200 });
  });
});

Deno.test("WorkerBundleProber: a probe after a hang, an exit or a throw gets a fresh worker and still answers", async () => {
  await withProber({ timeoutMs: 200 }, async ({ prober, type, bundle }) => {
    const hang = await bundle("hang", "await new Promise(() => {});\n");
    const exit = await bundle("exit", "Deno.exit(1);\n");
    const throws = await bundle("throws", 'throw new Error("x");\n');
    const ok = await bundle("ok", VAULT(type("ok")));
    for (const bad of [hang, exit, throws]) {
      await prober.probe(bad);
      assertEquals((await prober.probe(ok)).tag, "primary");
    }
  });
});

Deno.test("WorkerBundleProber: work a bundle leaves behind that throws later is not blamed on the next bundle", async () => {
  await withProber({}, async ({ prober, type, bundle }) => {
    const first = await prober.probe(
      await bundle(
        "deferred",
        'setTimeout(() => { throw new Error("late"); }, 0);\n' +
          'Promise.reject(new Error("late rejection"));\n' +
          VAULT(type("deferred")),
      ),
    );
    assertEquals(first.tag, "primary");
    // Let the deferred work fire inside the worker before the next probe.
    const marker = await bundle(
      "wait",
      "await new Promise((resolve) => setTimeout(resolve, 20));\n",
    );
    assertEquals(await prober.probe(marker), { tag: "no-export" });
    const next = await prober.probe(await bundle("ok", VAULT(type("ok"))));
    assertEquals(next.tag, "primary");
  });
});

Deno.test("WorkerBundleProber: concurrent probes are answered one at a time, each with its own result", async () => {
  await withProber({}, async ({ prober, type, bundle }) => {
    const requests = await Promise.all(
      ["a", "b", "c", "d"].map((name) => bundle(name, VAULT(type(name)))),
    );
    const results = await Promise.all(requests.map((r) => prober.probe(r)));
    assertEquals(
      results.map((r) => r.tag === "primary" ? r.typeNormalized : r.tag),
      ["a", "b", "c", "d"].map(type),
    );
  });
});

Deno.test("WorkerBundleProber: release under a probe in flight answers it as a retryable failed import, not a timeout", async () => {
  await withProber({}, async ({ prober, bundle }) => {
    const hang = await bundle("hang", "await new Promise(() => {});\n");
    const pending = prober.probe(hang);
    // The probe is queued behind a resolved promise: one microtask turn
    // puts it in flight, with its request posted to the worker.
    await Promise.resolve();
    prober.release();
    const result = await pending;
    assertEquals(result.tag, "import-failed");
  });
});

Deno.test("WorkerBundleProber: probes again after release", async () => {
  await withProber({}, async ({ prober, type, bundle }) => {
    const ok = await bundle("ok", VAULT(type("ok")));
    assertEquals((await prober.probe(ok)).tag, "primary");
    prober.release();
    prober.release();
    assertEquals((await prober.probe(ok)).tag, "primary");
  });
});

Deno.test("WorkerBundleProber: a worker that does not start in time is a retryable failed import", async () => {
  await withProber(
    { startupTimeoutMs: 0 },
    async ({ prober, type, bundle }) => {
      const result = await prober.probe(
        await bundle("ok", VAULT(type("ok"))),
      );
      assertEquals(result, {
        tag: "import-failed",
        message: "the probe worker did not start",
      });
    },
  );
});

Deno.test("WorkerBundleProber: console output at import is logged at debug, not printed", async () => {
  const records: LogRecord[] = [];
  await configure({
    reset: true,
    sinks: { capture: (record) => records.push(record) },
    loggers: [
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
      {
        category: ["swamp", "extensions", "probe"],
        lowestLevel: "debug",
        sinks: ["capture"],
      },
    ],
  });
  const printed: unknown[][] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    printed.push(args);
  };
  try {
    await withProber({}, async ({ prober, type, bundle }) => {
      const result = await prober.probe(
        await bundle(
          "print",
          'console.log("HELLO", { from: "extension" });\n' +
            VAULT(type("print")),
        ),
      );
      assertEquals(result.tag, "primary");
    });
    assertEquals(printed, []);
    assertEquals(records.length, 1);
    assertEquals(records[0].level, "debug");
    assertStringIncludes(
      String(records[0].properties.line ?? records[0].message.join("")),
      "HELLO",
    );
  } finally {
    console.log = originalLog;
    await reset();
  }
});

Deno.test("WorkerBundleProber: an error whose cause points back at itself is a failed import, not a hang", async () => {
  await withProber({}, async ({ prober, bundle }) => {
    const result = await prober.probe(
      await bundle(
        "cyclic",
        'const e = new Error("cyclic"); e.cause = e; throw e;\n',
      ),
    );
    assertEquals(result, { tag: "import-failed", message: "cyclic" });
  });
});

Deno.test("WorkerBundleProber: Deno.exit rethrown as another error's cause is still exited", async () => {
  await withProber({}, async ({ prober, bundle }) => {
    const result = await prober.probe(
      await bundle(
        "wrapped",
        'try { Deno.exit(7); } catch (e) { throw new Error("wrapped", { cause: e }); }\n',
      ),
    );
    assertEquals(result, { tag: "exited", code: 7 });
  });
});
