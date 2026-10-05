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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import fc from "fast-check";
import { withMockedCommand } from "@swamp-club/swamp-testing";
import { withMockedEnv } from "../persistence/path_test_helpers.ts";
import { SchedulerRefreshError } from "../../domain/update/autoupdate_scheduler.ts";
import {
  buildPlist,
  escapeXml,
  LaunchdScheduler,
  parseLaunchctlPrint,
  parsePlistJob,
  unescapeXml,
} from "./launchd_scheduler.ts";

// The job-level part of `launchctl print` from swamp-club#3007: the agent
// after a self-update, refused by launchd on every run.
const STUCK_PRINT = `gui/501/club.swamp.autoupdate = {
	active count = 0
	path = /Users/someone/Library/LaunchAgents/club.swamp.autoupdate.plist
	type = LaunchAgent
	state = not running

	program = /Users/someone/.local/bin/swamp
	arguments = {
		/Users/someone/.local/bin/swamp
		update
		--background
	}

	runs = 27
	last exit code = 78: EX_CONFIG
	run interval = 86400 seconds

	properties = runatload | inferred program | needs LWCR update | managed LWCR | has LWCR
}
`;

const HEALTHY_PRINT = `gui/501/club.swamp.autoupdate = {
	active count = 0
	state = not running
	runs = 3
	last exit code = 0
	run interval = 86400 seconds
	properties = runatload | inferred program | managed LWCR | has LWCR
}
`;

const UNPINNED_PRINT = `gui/501/club.swamp.autoupdate = {
	active count = 0
	state = not running
	runs = 1
	last exit code = 0
	properties = runatload | inferred program
}
`;

// us.zoom.updater on macOS 27 straight after bootout + bootstrap of a job
// Background Task Management pinned at login: the old requirement is gone
// and a fresh one is computed at the next launch.
const RELOADED_MANAGED_PRINT = `gui/501/us.zoom.updater = {
	active count = 0
	state = not running
	runs = 0
	last exit code = (never exited)
	properties = inferred program | untrusted | needs LWCR update | managed LWCR
}
`;

const RUNNING_PRINT = `gui/501/club.swamp.autoupdate = {
	active count = 1
	state = running
	runs = 1
	last exit code = (never exited)
	endpoints = {
		state = active
	}
	jetsamproperties category = daemon
	properties = inferred program
}
`;

const NOT_FOUND = {
  stdout: "",
  stderr: 'Could not find service "club.swamp.autoupdate" in domain for user',
  code: 113,
};

/** `launchctl print`: the domain exists, the job does not. */
function printJobMissing(args: string[]) {
  return args[1].endsWith("club.swamp.autoupdate")
    ? NOT_FOUND
    : { stdout: "gui/501 = {\n}\n", code: 0 };
}

Deno.test("parseLaunchctlPrint: the reporter's stuck agent needs repair", () => {
  assertEquals(parseLaunchctlPrint(STUCK_PRINT), {
    running: false,
    lastExitCode: 78,
    needsRepair: true,
    pinnedToBinary: true,
  });
});

Deno.test("parseLaunchctlPrint: a healthy agent with a pinned requirement", () => {
  assertEquals(parseLaunchctlPrint(HEALTHY_PRINT), {
    running: false,
    lastExitCode: 0,
    needsRepair: false,
    pinnedToBinary: true,
  });
});

Deno.test("parseLaunchctlPrint: a job loaded from the command line is not pinned", () => {
  assertEquals(parseLaunchctlPrint(UNPINNED_PRINT)?.pinnedToBinary, false);
});

Deno.test("parseLaunchctlPrint: a running job that has never exited", () => {
  assertEquals(parseLaunchctlPrint(RUNNING_PRINT), {
    running: true,
    lastExitCode: null,
    needsRepair: false,
    pinnedToBinary: false,
  });
});

Deno.test("parseLaunchctlPrint: a freshly re-registered managed job is not stuck", () => {
  assertEquals(parseLaunchctlPrint(RELOADED_MANAGED_PRINT), {
    running: false,
    lastExitCode: null,
    needsRepair: false,
    pinnedToBinary: false,
  });
});

Deno.test("parseLaunchctlPrint: exit 78 alone needs repair", () => {
  const text =
    "x = {\n\tstate = not running\n\tlast exit code = 78: EX_CONFIG\n}";
  assertEquals(parseLaunchctlPrint(text)?.needsRepair, true);
});

Deno.test("parseLaunchctlPrint: unrecognised output is unknown", () => {
  assertEquals(parseLaunchctlPrint(""), null);
  assertEquals(parseLaunchctlPrint(NOT_FOUND.stderr), null);
});

Deno.test("unescapeXml: reverses escapeXml for any path", () => {
  fc.assert(
    fc.property(fc.string(), (path) => {
      assertEquals(unescapeXml(escapeXml(path)), path);
    }),
  );
});

Deno.test("unescapeXml: decodes in a single pass", () => {
  assertEquals(unescapeXml("&amp;lt;"), "&lt;");
});

Deno.test("parsePlistJob: reads back what buildPlist wrote", () => {
  const path = "/Users/a&b/<swamp>/'bin'/\"swamp\"";
  assertEquals(parsePlistJob(buildPlist(path, "weekly")), {
    binaryPath: path,
    interval: 604800,
  });
});

Deno.test("parsePlistJob: null for a plist without a program", () => {
  assertEquals(parsePlistJob("<plist><dict></dict></plist>"), null);
});

async function withAgentPlist(
  plist: string | null,
  fn: (plistPath: string) => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir();
  try {
    const plistPath = join(
      home,
      "Library",
      "LaunchAgents",
      "club.swamp.autoupdate.plist",
    );
    if (plist !== null) {
      await Deno.mkdir(join(home, "Library", "LaunchAgents"), {
        recursive: true,
      });
      await Deno.writeTextFile(plistPath, plist);
    }
    await withMockedEnv({ HOME: home }, () => fn(plistPath));
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
}

function launchctlCalls(
  calls: { command: string; args: string[] }[],
): string[] {
  return calls
    .filter((c) => c.command === "launchctl")
    .map((c) => c.args[0]);
}

Deno.test("LaunchdScheduler.refresh: boots out, waits, and bootstraps again", async () => {
  const binary = "/Users/someone/.local/bin/swamp";
  await withAgentPlist(buildPlist(binary, "hourly"), async (plistPath) => {
    let booted = true;
    const { result, calls } = await withMockedCommand((cmd, args) => {
      if (cmd === "id") return { stdout: "501\n", code: 0 };
      if (args[0] === "print") {
        return booted ? { stdout: STUCK_PRINT, code: 0 } : NOT_FOUND;
      }
      if (args[0] === "bootout") {
        booted = false;
        return { stdout: "", code: 0 };
      }
      return { stdout: "", code: 0 };
    }, () => new LaunchdScheduler("agent").refresh());

    assertEquals(result, "refreshed");
    assertEquals(launchctlCalls(calls), [
      "print",
      "bootout",
      "print",
      "bootstrap",
    ]);
    const bootstrap = calls.find((c) => c.args[0] === "bootstrap")!;
    assertEquals(bootstrap.args, ["bootstrap", "gui/501", plistPath]);

    const rewritten = parsePlistJob(await Deno.readTextFile(plistPath));
    assertEquals(rewritten, { binaryPath: binary, interval: 3600 });
  });
});

Deno.test("LaunchdScheduler.refresh: leaves a running job alone", async () => {
  const plist = buildPlist("/usr/local/bin/swamp", "daily");
  await withAgentPlist(plist, async (plistPath) => {
    const { result, calls } = await withMockedCommand((cmd) => {
      if (cmd === "id") return { stdout: "501\n", code: 0 };
      return { stdout: RUNNING_PRINT, code: 0 };
    }, () => new LaunchdScheduler("agent").refresh());

    assertEquals(result, "skipped");
    assertEquals(launchctlCalls(calls), ["print"]);
    assertEquals(await Deno.readTextFile(plistPath), plist);
  });
});

Deno.test("LaunchdScheduler.refresh: leaves a job launchd has not loaded alone (e.g. off in Login Items)", async () => {
  const plist = buildPlist("/usr/local/bin/swamp", "daily");
  await withAgentPlist(plist, async (plistPath) => {
    const { result, calls } = await withMockedCommand((cmd, args) => {
      if (cmd === "id") return { stdout: "501\n", code: 0 };
      if (args[0] === "print") return printJobMissing(args);
      return { stdout: "", code: 0 };
    }, () => new LaunchdScheduler("agent").refresh());

    assertEquals(result, "not_needed");
    assertEquals(launchctlCalls(calls), ["print", "print"]);
    assertEquals(await Deno.readTextFile(plistPath), plist);
  });
});

Deno.test("LaunchdScheduler.refresh: loads an unloaded job after an earlier failed refresh", async () => {
  await withAgentPlist(
    buildPlist("/usr/local/bin/swamp", "daily"),
    async (plistPath) => {
      const { result, calls } = await withMockedCommand(
        (cmd, args) => {
          if (cmd === "id") return { stdout: "501\n", code: 0 };
          if (args[0] === "print") return printJobMissing(args);
          return { stdout: "", code: 0 };
        },
        () => new LaunchdScheduler("agent").refresh({ loadIfNotLoaded: true }),
      );

      assertEquals(result, "refreshed");
      assertEquals(launchctlCalls(calls), ["print", "print", "bootstrap"]);
      assertEquals(
        calls.find((c) => c.args[0] === "bootstrap")!.args,
        ["bootstrap", "gui/501", plistPath],
      );
    },
  );
});

Deno.test("LaunchdScheduler.refresh: a bootstrap that fails once is tried again", async () => {
  await withAgentPlist(
    buildPlist("/usr/local/bin/swamp", "daily"),
    async () => {
      let booted = true;
      let bootstraps = 0;
      const { result } = await withMockedCommand((cmd, args) => {
        if (cmd === "id") return { stdout: "501\n", code: 0 };
        if (args[0] === "print") {
          return booted ? { stdout: STUCK_PRINT, code: 0 } : NOT_FOUND;
        }
        if (args[0] === "bootout") booted = false;
        if (args[0] === "bootstrap" && bootstraps++ === 0) {
          return { stdout: "", stderr: "Bootstrap failed: 5", code: 5 };
        }
        return { stdout: "", code: 0 };
      }, () => new LaunchdScheduler("agent").refresh());

      assertEquals(result, "refreshed");
      assertEquals(bootstraps, 2);
    },
  );
});

Deno.test("LaunchdScheduler.refresh: a missing launchd domain (SSH, no desktop login) is unknown", async () => {
  const plist = buildPlist("/usr/local/bin/swamp", "daily");
  await withAgentPlist(plist, async (plistPath) => {
    const { result, calls } = await withMockedCommand((cmd) => {
      if (cmd === "id") return { stdout: "501\n", code: 0 };
      return {
        stdout: "",
        stderr: "Bad request.\nCould not find domain for user gui: 501",
        code: 113,
      };
    }, () => new LaunchdScheduler("agent").refresh());

    assertEquals(result, "unknown");
    assertEquals(launchctlCalls(calls), ["print", "print"]);
    assertEquals(calls.filter((c) => c.args[0] === "print")[1].args, [
      "print",
      "gui/501",
    ]);
    assertEquals(await Deno.readTextFile(plistPath), plist);
  });
});

Deno.test("LaunchdScheduler.refresh: leaves a healthy unpinned job as it is", async () => {
  const plist = buildPlist("/usr/local/bin/swamp", "daily");
  await withAgentPlist(plist, async (plistPath) => {
    const { result, calls } = await withMockedCommand((cmd) => {
      if (cmd === "id") return { stdout: "501\n", code: 0 };
      return { stdout: UNPINNED_PRINT, code: 0 };
    }, () => new LaunchdScheduler("agent").refresh());

    assertEquals(result, "not_needed");
    assertEquals(launchctlCalls(calls), ["print"]);
    assertEquals(await Deno.readTextFile(plistPath), plist);
  });
});

Deno.test("LaunchdScheduler.refresh: leaves a job awaiting its fresh requirement as it is", async () => {
  const plist = buildPlist("/usr/local/bin/swamp", "daily");
  await withAgentPlist(plist, async () => {
    const { result } = await withMockedCommand((cmd) => {
      if (cmd === "id") return { stdout: "501\n", code: 0 };
      return { stdout: RELOADED_MANAGED_PRINT, code: 0 };
    }, () => new LaunchdScheduler("agent").refresh());

    assertEquals(result, "not_needed");
  });
});

Deno.test("LaunchdScheduler.refresh: refreshes a pinned job even when its last run passed", async () => {
  await withAgentPlist(
    buildPlist("/usr/local/bin/swamp", "daily"),
    async () => {
      let booted = true;
      const { result } = await withMockedCommand((cmd, args) => {
        if (cmd === "id") return { stdout: "501\n", code: 0 };
        if (args[0] === "print") {
          return booted ? { stdout: HEALTHY_PRINT, code: 0 } : NOT_FOUND;
        }
        if (args[0] === "bootout") booted = false;
        return { stdout: "", code: 0 };
      }, () => new LaunchdScheduler("agent").refresh());

      assertEquals(result, "refreshed");
    },
  );
});

Deno.test("LaunchdScheduler.refresh: leaves the job alone when its state cannot be read", async () => {
  await withAgentPlist(
    buildPlist("/usr/local/bin/swamp", "daily"),
    async () => {
      const { result, calls } = await withMockedCommand((cmd) => {
        if (cmd === "id") return { stdout: "501\n", code: 0 };
        return { stdout: "a format launchd has not used before", code: 0 };
      }, () => new LaunchdScheduler("agent").refresh());

      assertEquals(result, "unknown");
      assertEquals(launchctlCalls(calls), ["print"]);
    },
  );
});

Deno.test("LaunchdScheduler.refresh: fails without bootstrapping when bootout does not unload", async () => {
  await withAgentPlist(
    buildPlist("/usr/local/bin/swamp", "daily"),
    async () => {
      const { calls } = await withMockedCommand((cmd) => {
        if (cmd === "id") return { stdout: "501\n", code: 0 };
        return { stdout: STUCK_PRINT, code: 0 };
      }, async () => {
        await assertRejects(
          () =>
            new LaunchdScheduler("agent", { bootoutPollIntervalMs: 0 })
              .refresh(),
          Error,
          "did not unload",
        );
      });
      assertEquals(launchctlCalls(calls).includes("bootstrap"), false);
    },
  );
});

Deno.test("LaunchdScheduler.refresh: reports launchd's reason when bootstrap fails", async () => {
  await withAgentPlist(
    buildPlist("/usr/local/bin/swamp", "daily"),
    async () => {
      let booted = true;
      await withMockedCommand((cmd, args) => {
        if (cmd === "id") return { stdout: "501\n", code: 0 };
        if (args[0] === "print") {
          return booted ? { stdout: STUCK_PRINT, code: 0 } : NOT_FOUND;
        }
        if (args[0] === "bootout") booted = false;
        if (args[0] === "bootstrap") {
          return {
            stdout: "",
            stderr: "Bootstrap failed: 5: Input/output error\n",
            code: 5,
          };
        }
        return { stdout: "", code: 0 };
      }, async () => {
        const error = await assertRejects(
          () => new LaunchdScheduler("agent").refresh(),
          SchedulerRefreshError,
        );
        assert(error.message.includes("Input/output error"));
        assertEquals(error.leftUnloaded, true);
      }).then(({ calls }) =>
        assertEquals(
          launchctlCalls(calls).filter((c) => c === "bootstrap").length,
          2,
        )
      );
    },
  );
});

Deno.test("LaunchdScheduler.refresh: no plist means nothing to refresh", async () => {
  await withAgentPlist(null, async () => {
    const { result, calls } = await withMockedCommand(
      [],
      () => new LaunchdScheduler("agent").refresh(),
    );
    assertEquals(result, "not_installed");
    assertEquals(calls.length, 0);
  });
});

Deno.test("LaunchdScheduler.status: reports launchd's runtime state", async () => {
  await withAgentPlist(
    buildPlist("/usr/local/bin/swamp", "daily"),
    async () => {
      const { result } = await withMockedCommand((cmd) => {
        if (cmd === "id") return { stdout: "501\n", code: 0 };
        return { stdout: STUCK_PRINT, code: 0 };
      }, () => new LaunchdScheduler("agent").status());

      assertEquals(result, {
        installed: true,
        cadence: "daily",
        runtime: {
          running: false,
          lastExitCode: 78,
          needsRepair: true,
          pinnedToBinary: true,
        },
      });
    },
  );
});

Deno.test("LaunchdScheduler.status: omits runtime when launchd has no job", async () => {
  await withAgentPlist(
    buildPlist("/usr/local/bin/swamp", "weekly"),
    async () => {
      const { result } = await withMockedCommand((cmd) => {
        if (cmd === "id") return { stdout: "501\n", code: 0 };
        return NOT_FOUND;
      }, () => new LaunchdScheduler("agent").status());

      assertEquals(result, { installed: true, cadence: "weekly" });
    },
  );
});

Deno.test("LaunchdScheduler.refresh: refuses a plist it cannot read back", async () => {
  await withAgentPlist("<plist><dict></dict></plist>", async () => {
    const { calls } = await withMockedCommand([], async () => {
      await assertRejects(
        () => new LaunchdScheduler("agent").refresh(),
        Error,
        "Cannot read the autoupdate job",
      );
    });
    assertEquals(calls.length, 0);
  });
});
