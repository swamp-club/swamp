# Adversarial Review Dimensions

Challenge each plan across these dimensions:

## Architecture

Does this follow DDD principles? Are domain boundaries correct? Is this the
right abstraction level? Are there better patterns? Reference `design/*.md` for
established architectural decisions.

## Scope

Is this doing too much or too little? Does it match the issue? Is there scope
creep? Are there unnecessary changes?

## Risk

Are all failure modes identified? What about edge cases, race conditions,
backwards compatibility? What could go wrong that isn't listed?

Pay particular attention to **state that persists across failure
boundaries**. If a function mutates module-scope state (a map, registry,
cache, signal handler) before performing I/O that can throw, check every
failure path unwinds that state — especially when an outer `catch` block
re-reads the same state for cleanup. The failure mode is silent: the
first error propagates, the cleanup hits orphaned state, and the
cleanup's own failure shadows the original error.

## Testing

Is the testing strategy sufficient? Are edge cases covered? Are there
integration test gaps? Is there over-reliance on unit tests? Was the UAT
assessment thorough — are there end-to-end CLI or adversarial test gaps that
should be filed in `swamp-club/swamp-uat`?

## Complexity

Is this over-engineered? Could it be simpler? Are there unnecessary abstractions
or indirections?

## Security

Does this change handle untrusted input from a trust boundary (WebSocket
messages, extension sources, lockfiles, user-supplied paths, repo-controlled
JSON)? Challenge each trust boundary crossing:

### Trust boundary & authorization design

- **Authorization/execution identity consistency**: If the change authorizes an
  operation using one value and executes using another (different payload fields,
  raw vs. normalized forms), that is a critical finding. The identity used for
  the security decision must be the exact same canonical value used for
  execution.
- **Canonicalization before security decisions**: If input can be represented in
  multiple forms (case variants, separator substitution like `.` for `/`,
  whitespace, `::`, `//`), is it normalized to a single canonical form _before_
  any authorization or access-control check? Raw-vs-canonical mismatches are
  bypass vectors.
- **Defense-in-depth at execution sinks**: Sensitive operations (command
  execution, access-control model execution, credential access, file deletion)
  should independently verify authorization at the point of execution, not rely
  solely on an upstream gate that may use a different code path or identity.
- **Confused deputy / privilege delegation**: When code acts on behalf of a
  caller (serve executing a model for a WebSocket client, extension install
  acting on lockfile data), does the callee operate with the _caller's_
  authority? Can the caller influence which authority is used, which code path
  runs, or which capabilities are exercised beyond what they were authorized for?

### Data flow & input validation

- **Trace untrusted data from ingress to sink**: For every trust boundary
  crossing in this change, trace the data from where it enters (WebSocket
  message field, extension manifest entry, lockfile array, CLI argument) to
  where it acts (file operation, command execution, authorization decision,
  database write). Every step in that path must either validate/constrain the
  data or be proven safe by the step before it. If a step assumes "the caller
  already validated this," verify the assumption holds for _every_ caller.
- **Reachability from unvalidated paths**: If a function receives data that was
  validated at the call site, is the same function reachable from a different
  path that skips validation? Internal functions called from both validated and
  unvalidated contexts must validate defensively or the plan must ensure a
  single validated entry point.
- **Untrusted data in persisted artifacts**: If repo-controlled or
  user-controlled data is written to a file that is later read back and acted
  upon (lockfiles, config, manifests), verify the read-back path validates the
  data shape and containment — not just the write path. A hand-edited or
  malicious committed file bypasses write-time checks.

### Filesystem safety

- **Path and symlink containment**: If the change performs file operations
  (copy, delete, read, stat) using paths from external data (lockfiles,
  extension manifests, archive entries, user input), does it validate that
  resolved paths stay within the expected root? Check for `..` traversal,
  absolute paths, and symlinks that escape the boundary. Use existing primitives
  (`assertSafePath`, `assertContainedPath`, `validateNoSymlinkEscape`) or
  equivalent. New file-handling code that doesn't use these is a finding.

### Resource exhaustion

- **Unbounded operations from untrusted input**: Can a client-controlled value
  (array length, string size, nesting depth, query predicate, CEL condition)
  cause unbounded memory allocation, CPU consumption, or recursive processing?
  Operations driven by untrusted input must have explicit size, depth, or
  complexity limits.

### Information disclosure

- **Error leakage to callers**: Do error messages, stack traces, or WebSocket
  error frames returned to clients leak internal paths, token fragments,
  configuration details, or other information useful to an attacker? Errors
  crossing trust boundaries should be generic; diagnostic detail belongs in
  server-side logs only.

### Stateful protocol safety

- **Stale authorization on long-lived connections**: If a WebSocket connection
  is long-lived, are permissions re-evaluated on each request? If grants are
  revoked or tokens expire, when does the revocation take effect for existing
  connections? Plans that add new authorized operations to serve must consider
  the authorization lifecycle.
- **Replay and ordering**: Can WebSocket messages be replayed to repeat
  operations that should be one-shot? Can message ordering be manipulated to
  bypass checks that assume a sequence?

## Correctness

Will this actually solve the problem? Are there logical gaps? Does the approach
match established patterns in the codebase?

## Documentation

Does this change introduce or modify domain concepts, CLI commands, extension
patterns, or architectural decisions that should be reflected in `design/*.md`
or `.claude/skills/`? If a design doc describes behavior this plan changes, the
plan must include a step to update it. If a skill references CLI commands or
examples affected by this change, the plan must include a step to update the
skill. Flag any gaps as findings.
