# Experiments

This directory contains optional, self-contained experiments for swamp.

## Important Notes

- **Experiments are not included in compiled binaries by default**
- To include an experiment, use the `--include-experiment` flag when compiling
- Experiments must be built before they can be included in compilation

## Usage

### Basic compilation (no experiments)

```bash
deno run compile
```

### Include specific experiments

```bash
deno run compile --include-experiment web
```

### Multiple experiments

```bash
deno run compile --include-experiment web --include-experiment other
```

## Current Experiments

### webapp (`--include-experiment web`)

A web-based UI for swamp repositories.

**To include in compilation, example:**

1. Build the frontend: `deno run webapp:build`
2. Compile with flag: `deno run compile --include-experiment web`

## Guidelines for New Experiments

1. Keep experiments self-contained within their own subdirectories
2. Add your experiment to the compile script in `scripts/compile.ts`
3. Include build instructions in the experiment's README
4. Follow the pattern: experiments are only compiled into the binary if
   explicitly requested and built first
5. Don't include experiments in testing, refactoring, or architecture decisions
   for the main codebase
