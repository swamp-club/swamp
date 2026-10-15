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
import type { BundleProbeRequest } from "../src/domain/extensions/bundle_prober.ts";
import {
  ProcessBundleProber,
  sourceProbeHostCommand,
} from "../src/infrastructure/runtime/process_bundle_prober.ts";
import {
  BUNDLE_PROBE_FRAME_ENV,
  type BundleProbeHostReply,
} from "../src/infrastructure/runtime/bundle_probe_host.ts";
import { isProcessAlive } from "../src/infrastructure/process/process_kill.ts";
import { waitFor } from "@swamp-club/swamp-testing";

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
 * always released, so no host outlives the test.
 */
async function withProber(
  options: { timeoutMs?: number; startupTimeoutMs?: number },
  fn: (args: {
    prober: ProcessBundleProber;
    type: (name: string) => string;
    bundle: (name: string, js: string) => Promise<BundleProbeRequest>;
  }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp_3374_prober_" });
  const id = crypto.randomUUID().slice(0, 8);
  const prober = new ProcessBundleProber(options);
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
    await prober.release();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("ProcessBundleProber: reports a primary export's type, version and description", async () => {
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

Deno.test("ProcessBundleProber: a bundle without the kind's export is no-export", async () => {
  await withProber({}, async ({ prober, bundle }) => {
    const result = await prober.probe(
      await bundle("helper", "export const helper = 1;\n"),
    );
    assertEquals(result, { tag: "no-export" });
  });
});

Deno.test("ProcessBundleProber: an export that fails the kind's schema is validation-failed", async () => {
  await withProber({}, async ({ prober, bundle }) => {
    const result = await prober.probe(
      await bundle("invalid", "export const vault = { type: 42 };\n"),
    );
    assertEquals(result.tag, "validation-failed");
  });
});

Deno.test("ProcessBundleProber: an import that throws is import-failed with the error's message", async () => {
  await withProber({}, async ({ prober, bundle }) => {
    const result = await prober.probe(
      await bundle("throws", 'throw new Error("boom at import");\n'),
    );
    assertEquals(result, { tag: "import-failed", message: "boom at import" });
  });
});

Deno.test("ProcessBundleProber: Deno.exit at import is exited with its code, and the process survives", async () => {
  await withProber({}, async ({ prober, type, bundle }) => {
    const result = await prober.probe(
      await bundle("exit", "Deno.exit(3);\n" + VAULT(type("exit"))),
    );
    assertEquals(result, { tag: "exited", code: 3 });
  });
});

Deno.test("ProcessBundleProber: an import that never settles is timed-out", async () => {
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

Deno.test("ProcessBundleProber: a probe after a hang, an exit or a throw gets a fresh host and still answers", async () => {
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

Deno.test("ProcessBundleProber: work a bundle leaves behind that throws later is not blamed on the next bundle", async () => {
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
    // Let the deferred work fire inside the host before the next probe.
    const marker = await bundle(
      "wait",
      "await new Promise((resolve) => setTimeout(resolve, 20));\n",
    );
    assertEquals(await prober.probe(marker), { tag: "no-export" });
    const next = await prober.probe(await bundle("ok", VAULT(type("ok"))));
    assertEquals(next.tag, "primary");
  });
});

Deno.test("ProcessBundleProber: concurrent probes are answered one at a time, each with its own result", async () => {
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

Deno.test("ProcessBundleProber: release under a probe in flight answers it as a retryable failed import, not a timeout", async () => {
  await withProber({}, async ({ prober, bundle }) => {
    const hang = await bundle("hang", "await new Promise(() => {});\n");
    const pending = prober.probe(hang);
    // The probe is queued behind a resolved promise: one microtask turn
    // puts it in flight, with its host starting.
    await Promise.resolve();
    await prober.release();
    const result = await pending;
    assertEquals(result.tag, "import-failed");
  });
});

Deno.test("ProcessBundleProber: probes again after release", async () => {
  await withProber({}, async ({ prober, type, bundle }) => {
    const ok = await bundle("ok", VAULT(type("ok")));
    assertEquals((await prober.probe(ok)).tag, "primary");
    await prober.release();
    await prober.release();
    assertEquals((await prober.probe(ok)).tag, "primary");
  });
});

Deno.test("ProcessBundleProber: a host that does not start in time is a retryable failed import", async () => {
  await withProber(
    { startupTimeoutMs: 0 },
    async ({ prober, type, bundle }) => {
      const result = await prober.probe(
        await bundle("ok", VAULT(type("ok"))),
      );
      assertEquals(result, {
        tag: "import-failed",
        message: "the probe host did not start",
      });
    },
  );
});

Deno.test("ProcessBundleProber: console output at import is logged at debug, not printed", async () => {
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
    // The host's own stderr (a deno warning, from source) is logged too.
    const atImport = records.filter((record) =>
      record.message.join("").includes("Output at import")
    );
    assertEquals(atImport.length, 1);
    assertEquals(atImport[0].level, "debug");
    assertStringIncludes(
      String(atImport[0].properties.line ?? atImport[0].message.join("")),
      "HELLO",
    );
  } finally {
    console.log = originalLog;
    await reset();
  }
});

Deno.test("ProcessBundleProber: an error whose cause points back at itself is a failed import, not a hang", async () => {
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

Deno.test("ProcessBundleProber: Deno.exit rethrown as another error's cause is still exited", async () => {
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

Deno.test("ProcessBundleProber: a bundle that spins in synchronous code is timed-out, and release ends its host (swamp-club#3494)", async () => {
  await withProber({ timeoutMs: 300 }, async ({ prober, bundle }) => {
    const pidFile = await Deno.makeTempFile({ prefix: "swamp_3494_pid_" });
    try {
      const result = await prober.probe(
        await bundle(
          "spin",
          `Deno.writeTextFileSync(${
            JSON.stringify(pidFile)
          }, String(Deno.pid));\n` +
            "while (true) {}\n",
        ),
      );
      assertEquals(result, { tag: "timed-out", timeoutMs: 300 });
      // A timed-out probe is not reusable, so its host is already stopped.
      const pid = Number(await Deno.readTextFile(pidFile));
      assertEquals(isProcessAlive(pid), false);
    } finally {
      await Deno.remove(pidFile).catch(() => {});
    }
  });
});

Deno.test("ProcessBundleProber: lines a bundle writes to stdout directly are logged, not taken as an answer", async () => {
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
  try {
    await withProber({}, async ({ prober, type, bundle }) => {
      const result = await prober.probe(
        await bundle(
          "raw",
          'Deno.stdout.writeSync(new TextEncoder().encode("RAW LINE\\n"));\n' +
            VAULT(type("raw")),
        ),
      );
      assertEquals(result.tag, "primary");
    });
    assertEquals(
      records.some((record) =>
        record.message.map(String).join("").includes("RAW LINE")
      ),
      true,
    );
  } finally {
    await reset();
  }
});

Deno.test("ProcessBundleProber: a bundle that prints more than a pipe holds still answers", async () => {
  await withProber({}, async ({ prober, type, bundle }) => {
    const result = await prober.probe(
      await bundle(
        "loud",
        'const line = new TextEncoder().encode("x".repeat(1023) + "\\n");\n' +
          "for (let i = 0; i < 1024; i++) {\n" +
          "  Deno.stdout.writeSync(line);\n" +
          "  Deno.stderr.writeSync(line);\n" +
          "}\n" +
          VAULT(type("loud")),
      ),
    );
    assertEquals(result.tag, "primary");
  });
});

/** Starts a host from source with `env` added, for tests that drive it. */
function spawnHost(env: Record<string, string> = {}) {
  const frame = `@@test-${crypto.randomUUID()}@@`;
  const { command, args } = sourceProbeHostCommand();
  const child = new Deno.Command(command, {
    args: [...args],
    env: { ...env, [BUNDLE_PROBE_FRAME_ENV]: frame },
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  return { child, frame };
}

function repliesIn(stdout: Uint8Array, frame: string): BundleProbeHostReply[] {
  return new TextDecoder().decode(stdout).split("\n")
    .filter((line) => line.startsWith(frame))
    .map((line) => JSON.parse(line.slice(frame.length)));
}

Deno.test("bundle probe host: exits when stdin closes, though a bundle left an interval running", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp_3494_host_" });
  try {
    const path = join(dir, "interval.js");
    await Deno.writeTextFile(path, "setInterval(() => {}, 1000);\n");
    const { child, frame } = spawnHost();
    const writer = child.stdin.getWriter();
    await writer.write(
      new TextEncoder().encode(
        JSON.stringify({ importUrl: toFileUrl(path).href, kind: "vault" }) +
          "\n",
      ),
    );
    await writer.close();
    const { code, stdout } = await child.output();
    assertEquals(code, 0);
    const replies = repliesIn(stdout, frame);
    assertEquals(replies.map((r) => r.type), ["ready", "started", "done"]);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("ProcessBundleProber: a host from another build than this swamp refuses to probe, as a retryable failed import", async () => {
  const entry = new URL(
    "../src/infrastructure/runtime/bundle_probe_host.ts",
    import.meta.url,
  ).href;
  const source = sourceProbeHostCommand();
  const config = source.args[source.args.indexOf("--config") + 1];
  const prober = new ProcessBundleProber({
    // A host as a binary swamp update replaced would start: it reports
    // build 2 to a parent running build 1.
    command: () => ({
      command: Deno.execPath(),
      args: [
        "eval",
        "--config",
        config,
        `import { runBundleProbeHost } from ${JSON.stringify(entry)};\n` +
        `Deno.exit(await runBundleProbeHost("2.0.0"));`,
      ],
      env: { SWAMP_BUILD_VERSION: "1.0.0" },
    }),
  });
  try {
    const result = await prober.probe({
      importUrl: "data:text/javascript,export%20const%20x%20%3D%201%3B",
      kind: "vault",
    });
    assertEquals(result.tag, "import-failed");
    assertStringIncludes(
      result.tag === "import-failed" ? result.message : "",
      "swamp 1.0.0 is running, but its binary is now 2.0.0",
    );
  } finally {
    await prober.release();
  }
});

Deno.test("ProcessBundleProber: a host that dies between probes is replaced by the next probe", async () => {
  await withProber({}, async ({ prober, type, bundle }) => {
    const pidFile = await Deno.makeTempFile({ prefix: "swamp_3494_pid_" });
    try {
      const first = await prober.probe(
        await bundle(
          "pid",
          `Deno.writeTextFileSync(${
            JSON.stringify(pidFile)
          }, String(Deno.pid));\n` +
            VAULT(type("pid")),
        ),
      );
      assertEquals(first.tag, "primary");
      const pid = Number(await Deno.readTextFile(pidFile));
      Deno.kill(pid, "SIGKILL");
      await waitFor(() => !isProcessAlive(pid), "the host to die");
      const next = await prober.probe(await bundle("ok", VAULT(type("ok"))));
      assertEquals(next.tag, "primary");
    } finally {
      await Deno.remove(pidFile).catch(() => {});
    }
  });
});
