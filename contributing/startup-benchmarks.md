---
audience: maintainer
last-verified: 2026-11-10 @ c7f34885
---

# Startup benchmark and CLI parity

Two scripts back every change to how the CLI loads its commands:

- `deno run bench-startup <binary>` measures how fast a compiled binary starts
  and how much memory it peaks at.
- `deno run cli-parity <binary-a> <binary-b>` checks that two binaries print the
  same help, completions, suggestions and version output.

## When to rerun them

- Every PR in the lazy command loading plan. Quote the benchmark for the base
  commit and the PR side by side, and run parity with the base binary first.
- Any Deno version bump, once the bundled build ships. A new Deno can move the
  code cache or change startup cost without any swamp change.

Neither script gates CI. The numbers vary with the machine, so compare binaries
measured in one session on one machine.

## Prerequisites

- Be signed in (`swamp auth login`). The auth gate refuses unknown commands and
  every repository command without a credential, so both scripts run with your
  own swamp config. Each first runs an unknown command and stops, naming
  `swamp auth login`, unless it exits 2 (unknown command).
- `python3` on `PATH`, for the benchmark only. Peak RSS comes from the child's
  `wait4` rusage, which Deno does not expose.
- macOS or Linux for the benchmark. Windows has no `wait4`, so it refuses there.

## Building the two binaries

Build the base commit and the PR under different file names, because a compiled
binary keys its code cache by file name:

```sh
mkdir -p ../bin
git worktree add ../swamp-base origin/main
(cd ../swamp-base && deno run compile --output ../bin/swamp-base)
deno run compile --output ../bin/swamp-pr
```

### The bundled build

`deno run compile --bundle` runs `deno bundle` with code splitting before
compiling, so the binary loads a few large chunks instead of every source module.
Releases still ship the unbundled build. Every npm package stays external: the
list comes from the `npm:` imports in the root's and each workspace member's
`deno.json` or `deno.jsonc`, plus their `package.json` dependencies, and the
build fails if the bundle's source maps show a file from Deno's npm cache (any
registry) or a `node_modules` directory, which means a package was inlined
anyway. The bundle lands in `build/bundle/`, which a `--bundle` build removes
when it ends, pass or fail. Its linked source maps are embedded, so stack traces
name source files.

To compare the two builds of one commit, give the bundled binary its own name
and use it as the second binary in both scripts:

```sh
deno run compile --output ../bin/swamp-pr
deno run compile --bundle --output ../bin/swamp-pr-bundled
deno run cli-parity ../bin/swamp-pr ../bin/swamp-pr-bundled
deno run bench-startup ../bin/swamp-pr-bundled
```

## Benchmark

```sh
deno run bench-startup ../bin/swamp-base
deno run bench-startup ../bin/swamp-pr --runs 9
```

It creates a scratch repo (a `command/shell` behavior and a one-step workflow),
runs a fixed command set and prints a markdown table of medians, ready to paste
into the PR: `version`, `--help`, `help data get`, `data get`, `behavior run`,
`workflow run`, and the telemetry sender entry. The sender is started with a
random lock token no lock file holds, so it exits right after dispatch, which is
the cost a command pays to start it.

- **Cold** deletes the binary's V8 code cache before each run. The operating
  system's file cache stays warm, so cold is not a first boot after a restart.
- **Warm** discards one run, then measures with the cache in place.
- Wall time runs from spawn to reap, and Python's own startup is not counted.
  Peak RSS is reported in MiB.
- Each binary gets a private `TMPDIR` in the scratch directory, so its code
  cache never mixes with another binary's or with your own `/tmp`. If the cache
  file is missing after a warm run, the script stops instead of reporting cold
  equal to warm, since that means Deno has moved its cache.
- Repository commands pass through the auth gate on its cached-proof path, which
  is part of what a real command pays. A gate check that has to reach
  swamp-club during a run shows up as an outlier, which the median absorbs.

`--runs` (default and minimum 5) sets the runs per median, and `--timeout-ms`
sets the deadline for one run.

## Parity

```sh
deno run cli-parity ../bin/swamp-base ../bin/swamp-pr
```

It compares stdout, stderr and exit code for:

- `--help`, `help` and `help --include-hidden`
- `<path> --help` and `help <path>` for every command path in the first binary's
  `help --include-hidden` output, hidden ones included
- `completions bash`, `zsh` and `fish`
- a mistyped word at the root and in every group, which prints the suggestion
  list
- `version --json`

Each binary's own version string is replaced with `<version>` before
comparing, and trailing whitespace is dropped, because `--help` pads its Version
line to the table width. Builds stamped with different versions therefore still
match. A difference that does not repeat in a sequential rerun is ignored, which
covers a gate check landing mid-run.

On any difference the script exits 1 and prints the first differing invocation,
in invocation order, with the differing lines of each binary. `--concurrency`
(default: CPU count) and `--timeout-ms` tune the run.

## Environment

Every run of either script gets `SWAMP_NO_TELEMETRY=1`,
`SWAMP_NO_UPDATE_CHECK=1` and `SWAMP_NO_INBOX_NOTICE=1`. `SWAMP_*` variables
other than the config location and credentials are removed, as are `OTEL_*`,
`TRACEPARENT` and `TRACESTATE`, so a `SWAMP_REPO_DIR` or `SWAMP_SERVE_URL` in
your shell cannot point a run at another repo or server.
