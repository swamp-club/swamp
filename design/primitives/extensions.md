---
audience: extension-author, maintainer
last-verified: 2026-09-16 @ 03224b68
---

# Extensions

An extension is a package of behaviors, workflows, vaults, datastores, reports
and skills that others can pull from a registry into their repositories.

Four kinds have a runtime type registry and loader: behaviors, vaults,
datastores and reports (`src/cli/mod.ts` wires only these four).

## Name

Every extension has a scoped name, `@collective/name`. Extra path segments may
group related extensions. All parts are lowercase letters, digits, hyphens and
underscores. The pattern is `@[a-z0-9_-]+/[a-z0-9_-]+(/[a-z0-9_-]+)*`.

The collectives `@swamp` and `@si` are reserved for built-in extensions, so
external authors cannot use them. This is enforced on behavior types, not when
the manifest is parsed (`RESERVED_COLLECTIVES` in
`src/domain/models/model_type.ts`).

You cannot use another person's name in the extensions you publish.

Examples: `@keeb/ssh`, `@acme/deploy`, `@myorg/aws-helpers`, `@swamp/aws/ec2`,
`@swamp/aws/accessanalyzer/analyzer`.

## Version

Extensions use **CalVer** `YYYY.MM.DD.MICRO` (e.g., `2026.02.26.1`), the same
scheme as behaviors (see [behaviors](./behaviors.md)). The micro counter allows
several versions a day and resets each new date.

Each name+version pair must be unique in the registry, across every release
channel. On a push conflict an interactive push says which channel the version
is on and what each answer does. A version on the requested channel or a higher
one can only be bumped; a version on a lower channel can also be promoted in
place (see [Promotion](#promotion)), which moves the published build without
uploading the local files. `--yes` and `--json` never prompt: they fail, and
the message gives the promote command when one applies.

A yanked version stays taken: its number cannot be published again. It cannot
be promoted either, so on any channel the push offers only to bump or stop, and
its message names the yank and the reason in place of the promote command.

### Epoch suffix

`swamp extension push manifest.yaml --version-suffix epoch` replaces the micro
segment with the current Unix epoch seconds, e.g. `2026.06.18.1750263600`. This
avoids push collisions in CI, where nobody can answer a bump prompt. Each push
gets a unique, increasing version that records the exact publish time, and the
date prefix stays readable.

`swamp extension version <name>` asks the registry for the latest published
version and computes the next one. It takes an extension name, or
`--manifest <path>` to read the name from a manifest. It works outside a swamp
repository.

## Publication Visibility

A manifest may set `visibility: public` or `visibility: private`.
`swamp extension push manifest.yaml --visibility private` sets the same intent
for one publication and wins over the manifest. With neither, registry defaults
apply. `public` selects that default, so `--visibility public` overrides a
private manifest. It does not make an already-private extension public or
override a private collective's default. Release channels are independent of
visibility.

The effective intent is stored in the packaged manifest and the package cache
key. Private intent is sent on both initiation and confirmation. Public or
default intent omits the wire field, since the registry accepts only explicit
private. Preview and dry-run show the requested `visibility` as `public`,
`private` or `default` (registry decides); public is labelled as the registry
default. Dry-run does not establish the applied visibility; private intent adds
the private-entitlement registry check described below. Successful output
reports the actual `public`/`private` visibility from the confirmation response.
Explicit private requests require a private confirmation and never fall back to
a best-effort lookup.

## Declared License

A manifest may set `license:` to an SPDX license expression. It is optional for
public and private extensions alike: nothing is refused without it. Parsing a
manifest only checks that `license` is a non-empty string, so reading an
installed extension never depends on the SPDX lists.

Push preparation checks a declared value with the syntax-only parser in
`@swamp-club/extension-scoring/licensing` against the SPDX License List vendored
there (`deno run refresh-spdx` updates it, pinned to a release). Only SPDX identifiers in
canonical case count; a malformed expression, an unknown or deprecated id, or
any `LicenseRef-`/`AdditionRef-` produces a warning (`licenseWarnings` in
quality, `warnings.license` in push) and never blocks.

The rubric has two license factors, one point each: `has-license` ("License
declared") for a valid SPDX `license:`, and `license-file` ("LICENSE file
included") for a non-empty license file in the archive. The expression is sent
on initiation and confirmation; `extension info` shows the latest version's
license when the registry reports one, else the extension-level setting.
`extension search --licensed` asks for licensed extensions only.

A private publication the registry refuses on entitlement (its 403) is reported
as the registry's own sentence followed by what the registry had reported for
the collective at sign-in: its plan, as the registry labels it, and its trial
standing. The note is a report, not a diagnosis, and it names no plan the
registry did not send; when the registry reported no entitlement, it says so.
Nothing about plan or trial is written to disk: entitlement is read from the
push's own whoami call and held for that push only.

The upgraded registry creates explicit-private extensions as private from the
start, even inside public collectives, and enforces namespace permissions and
private-extension entitlements. Republish with private intent to keep that
requirement. An already-public extension produces a conflict; use the registry's
visibility action first. With public or omitted intent, new extensions take
their collective's default and existing ones keep their own visibility.

Explicit private publication needs the private-publication API from Lab #2200 on
**all registry replicas**. Older servers ignore the field, and checking the
confirmation cannot undo public exposure. Finish the registry rollout first,
including on custom registries, and pause explicit-private publishing while
rolling back to an older service. Public or omitted requests still work with
older servers, including their old visibility-lookup fallback.

## Release Channels

Extensions have three release channels with a strict promotion order:

```
beta → rc → stable
  └──────────┘  (can skip rc)
```

- **stable**: the default. All existing versions are stable. Omitting
  `--channel`, or passing `--channel stable`, on push and pull means stable.
  Auto-resolve considers only stable versions.
- **rc**: release candidate. Opt in with `--channel rc`.
- **beta**: early preview. Opt in with `--channel beta`.

### Version uniqueness

A version is unique per extension across all channels; you cannot push
`2026.06.10.1` as both beta and stable. So promotion changes only metadata, and
the archive bytes and checksum stay the same.

### Push

`swamp extension push manifest.yaml --channel rc` pushes to rc and
`swamp extension push manifest.yaml --channel beta` to beta. With no
`--channel` flag, push goes to stable.

Before uploading, push runs the registry checks: authentication, collective
membership, reserved collective (`@swamp`, `@si` need the registry's own word
on membership), private entitlement when the intent is private, and version
exists. The version check asks the versions endpoint for every channel, because
a version is unique across them. A rejected key fails authentication; it never
falls back to the username.

Private entitlement is decided from the `collectiveEntitlements` the same
whoami call returns (Lab #1544), never from a cached plan. The entry read is
the one for the extension's own collective. Its `privateExtensions` field is
the registry's verdict and decides the check (swamp-club#3311): `allowed`
passes, `trial-ended` and `paywalled` fail, and a value this client does not
know is `not-run` with cause `entitlement-undecided`. The verdict already
covers what plan and trial cannot show: a personal namespace is entitled when
any collective its owner belongs to has a paid plan or an active trial, so its
entry reads `allowed` while its own trial has ended. The CLI never combines
entries to work this out. A registry that sends no verdict (an older or
self-hosted one) is decided from plan and trial: a paid plan or an active
trial passes, an ended trial or none fails (a trial starts only when its
collective is created, never at publish, swamp-club#3104), and a Personal
License or an unknown trial state is undecided.

The messages describe standing the way the registry's web pages do and never
call the absence of a plan a "Free plan": a paid plan by name, admin standing,
a free trial with days left, a personal namespace covered by another
collective, a Personal License. A refusal names what is needed and the billing
page, and makes no claim about a trial unless the registry said it ended:
`Collective "@acme"'s 30-day free trial has ended. Private extensions need a
paid plan; upgrade at <registry>/o/acme/billing.`, or `Private extensions in
"@acme" need a paid plan; upgrade at <registry>/o/acme/billing.` A refusal the
registry makes at publish is passed on with the same words, as what the
registry reported at sign-in. Undecided leaves the push to the registry's
decision, as does a registry that reports no entitlement for the collective.
The check is omitted for a collective that is not the caller's (membership is
the message that matters) and never runs for public or default intent.

### Dry run

A green dry run means a green push. `--dry-run` runs the same registry checks
read-only when credentials are present and reports each verdict with the
wording the real push fails with; a failed check exits non-zero, after the
summary. Without credentials the summary lists each check it could not run and
why, and the run stays green: the registry was never asked. A check the
registry was asked about but did not answer also exits non-zero: the dry run
cannot confirm what the push needs, so it does not claim green. An undecided
private-entitlement check leaves the run green too: the registry answered, and
the push lets it decide. A dry run never prompts and never writes to the
registry.

The dry-run summary lists every HTTP call the run made (the registry for
whoami, the versions list and the drift lookup; OSV and npm for the
dependency-trust audit) and says "No API calls were made." only when the list
is empty. In JSON these are the `registryChecks` and `apiCalls` fields of the
`dry_run` document, beside `contentHash`.

`--json` writes one document per run on stdout (swamp-club#3017). The
renderer records each part as the run produces it and writes the document
when the run ends: `status` (`dry_run`, `pushed`, `failed`, `blocked` or
`cancelled`), `resolved` (file paths absolute), `warnings` grouped by family
(`safety`, `review`, `dependencyTrust`, `versionDrift`,
`versionBumpUpgrade`, and on a completed push `registry`), and the run
summary at the top level. The `registry` family is what the registry said
about a push it accepted, such as client `contentMetadata` it discarded in
favour of its own extraction (swamp-club#2900): one `{ "message": ... }`
object per warning. Log mode prints it as a `Registry warnings:` block after
the summary. The API client reduces that text to at most 20 printable single
lines before anything prints it; the number it left out is
`registryWarningsOmitted` beside the summary, present only when above zero,
and a closing line of the log block. The family appears only when the confirm
response was received, and it never gates the push. A blocked
prepare carries `errors` keyed by the gate that blocked it instead. The
review-report skeleton is a nested object on its finding. Errors still go to
stderr as `{"error": ...}`. Log mode prints a path relative to the current
directory when the file is under it, or is pushed content (under the repo
or the manifest's directory) sharing an ancestor below the filesystem root
with it; anything else, such as the review report under the temp dir,
prints absolute. When a `--json` run throws without a render having
written its document (a version that already exists, a manifest error, an
unexpected failure), the command writes it with status `failed`, carrying
`resolved` and `warnings` when they were recorded, before the error
propagates. Every `--json` run that reaches the push command (past flag
parsing and the account gate) leaves exactly one document on stdout.

`extension quality` packages through the same prepare phase, on a cache hit
too, but skips the registry checks and makes no registry call. It runs the
local gates in `collect` mode (`localGates`): each failed gate (content
collectives, the additionalFiles allowlist, safety, dependency trust,
skills, fmt/lint, upgrade chain, review errors, archive size) is recorded
instead of thrown, files a check rejected (hidden, symlink, disallowed type,
oversized, unreadable, disallowed additionalFiles) are left out of the
archive (never copied into it), and the rubric is scored and printed beside
the failures. Rejected files are also left out of every later gate, since
fmt, lint and review would read a symlink's target and quote it. Such an
archive is never cached or uploaded. A push enforces: the first failure
throws.

The rubric runs `deno doc` on the archive as the registry does, with the
author's config stripped. When the source does not resolve (a bare import
that ships as written, a module missing from the archive), the failure is
scored the way the registry scores it (swamp-club#3370), not thrown: lint is
skipped, the documentation factors score 0, and `docAnalysisError` names
what did not resolve. Quality then fails; a bare-specifiers finding, when
there is one, is the reason given.

The rubric and every rule it rests on live in the
`@swamp-club/extension-scoring` package (`packages/extension-scoring`,
swamp-club#3781), which swamp builds from source as a workspace member and the
registry imports from JSR: the factor table and `composeScore`, the archive
layout rules (README and LICENSE names matched exactly against a listing,
entrypoints always prefixed with their kind directory, the manifest-root search,
the `deno doc` arguments), the SPDX license policy, the secret-docs detector and
the files it reads, the dependency audit's extraction, resolution, record and
evaluation, and the doc-failure describer. Swamp keeps only the I/O around it:
extracting the archive, running `deno doc`, reading files and fetching from npm,
OSV and JSR. The package ships the vectors both sides test against
(`vectors/*.json`) and stays pure TypeScript with no runtime APIs, which
`integration/extension_scoring_package_rules_test.ts` enforces. A rule change
that can move a score bumps `RUBRIC_VERSION` (v5 is the first shared rubric; v6, swamp-club#3970, frees a locked range of the loose point).
`swamp extension quality --isolated` runs `deno doc` with an empty cache and a
minimal environment, as the registry does.

The package cache (`.swamp/cache/packages/<hash>/`) records the swamp
version that wrote each entry and is reused only by that version, because a
reused archive skips the fmt/lint gate. The version is not part of the hash,
which also keys the adversarial-review report. The hash covers the lockfile
the bundler runs `--frozen` against (`frozenLockPath`), when the project
has one (swamp-club#3662): the bundles and the dependency audit record ship
the versions it locks, so a lock bump with no source change rebuilds the
archive. An extension without a lock keeps its hash.

The content hash labels files by their path from the extensions root, not
the swamp repo dir, so it does not depend on where the swamp repo sits. CI
publishes from a swamp repo initialised inside the extension directory; a dry
run from a sibling repo, with the root inferred from the manifest or named by
`--extensions-dir`, hashes the same (see the `swamp` skill's publish reference).

### Pull

`swamp extension pull @name` resolves the latest stable version. For a
prerelease-only extension it fails with a message suggesting the right
`--channel` flag. `swamp extension pull @name --channel rc` and
`swamp extension pull @name --channel beta` resolve the latest rc or beta.
Pinning an exact version (`@name@2026.06.10.1`) installs that version whatever
channel it is published on.

So an install has two channels. The followed channel is what the lockfile's
`channel` records: the `--channel` flag, stable without one. `update` and
`outdated` look for newer versions there. The published channel is where the
registry lists the installed version. The two differ when an exact version is
pulled from another channel, or when a version is promoted after it was
pulled. Pull resolves the published channel without a request when the
version is the registry's latest on a channel, and otherwise looks it up in
the versions list, the installed and incoming versions in one scan. A beta or
rc installed while the extension follows stable, whether pinned at the top or
by a dependency, gets a warning that `update` keeps following stable and how
to follow the release's channel instead. Nothing is refused.

When a pull replaces an installed extension, it states what is installed and
what is coming before writing anything, for example
`@x/y: installed 2026.09.23.1 (stable) -> incoming 2026.10.01.1 (beta,
following stable)`, followed by whether it is an upgrade, a downgrade, the same
version or an unknown installed version, and any change of published channel.
The overwrite prompt shows this above the file list and says what y and N do;
`--yes` and `--force` log the same lines. A pull replaces an install when the
extension's root is on this checkout: a lockfile entry alone (a managed lockfile
can list an extension another checkout holds) or a conflict alone (a user's
skill dir) is not one. The installed version comes from the
lockfile entry, else from a `manifest.yaml` under the extension root that names
the extension, else it is unknown and said to be. A replacement whose incoming
channel cannot be looked up fails, as what it replaces cannot be stated; a
first install warns and goes ahead with the channel unknown. In JSON the
conflict document carries `name`, `current`, `incoming` (each `{version,
channel, publishedChannel}`), `change` and `channelChanged`, and a successful
pull's first document carries `channel`, `publishedChannel`, `previous`,
`change` and `channelChanged`.

### Search and Versions

`swamp extension search --channel rc --channel beta` shows extensions with
versions in either channel. `--channel` can be repeated; without it, only stable
results are shown.

`swamp extension version @name` shows the latest published version and computes
the next CalVer version.

### Info

`swamp extension info @name` always shows the latest stable, rc and beta
versions that exist. No flag is needed.

It also shows content metadata for the latest version: behavior types,
extensions (foreign-type grafts), workflows, vaults, datastores, reports and
skills. By default behaviors show the type name and method names, and extensions
show the target type and grafted method names. `--verbose` adds each method's
arguments and descriptions. JSON output (`--json`) includes the full
`contentMetadata` object.

### Promotion

`swamp extension promote @name 2026.06.10.1 --channel rc` promotes a beta
version to rc; `--channel stable` promotes to stable. Only forward moves are
allowed:

- beta → rc ✅
- beta → stable ✅
- rc → stable ✅
- stable → rc ❌
- rc → beta ❌
- stable → beta ❌

`swamp extension promote path/to/manifest.yaml --channel stable` takes the name
and version from the manifest, asks the registry which channel the version is
on, and promotes from there, or fails with "Nothing to promote" when no channel
below the target carries it. `--from-channel` is refused with a manifest, since
the registry reports the source channel. An argument matching `@collective/name`
is always the name form.

Promotion changes registry metadata only; the archive is not uploaded again.
The server then recalculates the latest version per channel. The CLI checks the
direction only when `--from-channel` is given; otherwise the server enforces it
(`src/libswamp/extensions/promote.ts`).

The registry refuses to promote a yanked version, or any version of a yanked
extension, and its refusal names the yank and the reason. The manifest form
already knows the yank from its lookup, so it refuses with the same sentence
before calling the registry; the name form does no lookup and leaves the
refusal to the registry.

### Auto-resolve safety

Trusted-collective auto-resolution uses only stable versions, never beta or rc.
Lockfile-pinned restores fetch the exact version whatever its channel.

Concurrent processes that auto-resolve in one repository install one at a time:
each takes a repo-wide lock (`.swamp/.extension-install.lock`) around
inspecting, installing and loading. A process that then finds the extension
already installed by another loads it rather than failing, and reports the
type missing only when the loaded extension does not provide it
(`src/domain/extensions/extension_auto_resolver.ts`). The install itself also
takes the per-checkout pulled-extensions lock (see
[Concurrency Safety](#concurrency-safety)), which serializes it against
explicit installs and removals.

In `swamp serve` the inspect, install and load also take their turn with
hot-reload and the per-run refresh of local models
(`withExtensionMutation` in `src/serve/extension_reload.ts`). Without it, a
run's refresh pass sees the new lockfile entry and rebundles the extension
alongside the install. Runs that start during an install wait for it in their
refresh pass (swamp-club#3911).

The registry calls one auto-install makes — for the extension and each
dependency it pulls — share a single 150s deadline
(`AUTO_RESOLVE_INSTALL_DEADLINE_MS` in `src/cli/auto_resolver_adapters.ts`), so
the process holding the lock releases it before the 180s lock wait of a process
behind it runs out. A process that does give up waiting reports which process
holds the lock (`installBusy`, JSON reason `install_busy` with `holder`,
`hostname`, `pid` and `waitedMs`) instead of reporting the type as not
registered.

### Registry retries

Registry reads retry transient failures
(`src/infrastructure/http/transient_retry.ts`): a timeout, a connection failure,
HTTP 502/503/504, or a 429 whose Retry-After is 60s or less (at most twice). A
read makes an initial attempt plus at most five retries, waiting 1s, 2s, 4s, 8s
and 16s with up to 25% jitter (or the Retry-After when longer), with a 15s
timeout per attempt and 150s in total (room for two capped Retry-After waits); an
archive download gets 120s per attempt
and 300s in total, and its fetch and body read are retried together. One loop,
one retry count and one total budget cover every kind of failure, so rate-limit
and transient retries never multiply. Writes — push, upload, confirm, yank,
deprecate, promote — are never retried, nor are other statuses or a caller's
own cancellation or deadline.

Before each wait one warning names the service, request, reason, wait and count,
for example
`swamp-club registry: GET /api/v1/extensions/… timed out after 15s · retrying in 2s (retry 2/5)`.
It goes to stderr in log mode; JSON mode attaches no console sink, so stdout
stays valid JSON. The final error names the method, the path without its query
string, the attempts and the elapsed time. Every URL in a notice or error,
including one embedded in a fetch error's own message, is reduced to origin and
path, so a signed download URL's signature never reaches a log; the signed URL
never receives identity headers.

### Lockfile

A team commits `upstream_extensions.json`, and checkouts on different OSes
share it, so an entry holds only what is the same on every checkout. Its
`files` and `include` paths are repo-relative and use forward slashes. `files`
lists source paths only: bundle cache paths are left out, because a bundle
namespace is a hash of an OS-separated path, so its directory differs between
Windows and POSIX checkouts. `extension rm` deletes the extension's bundle
namespaces itself. `filesChecksum` hashes forward-slash paths, so it matches
across OSes, and a same-version reinstall keeps `pulledAt`. Reads accept a
lockfile an older swamp wrote on Windows (backslash paths, bundle paths) and
treat it as the canonical form (`canonicalLockfileEntry` in
`src/infrastructure/persistence/upstream_extensions.ts`), so it raises no
missing-files warning. Reads never rewrite it: the next lockfile write does,
and `swamp extension install` rewrites it even when every extension is up to
date. The managed lockfile is not committed, so install leaves it as the
datastore holds it.

The paths that pull, update, install and rm report, in log output and in
`--json`, use the same repo-relative forward-slash form on every OS
(`lockfileRelative`), so a report never mixes separators.

The `upstream_extensions.json` entry records the install channel in a `channel`
field. It is written only for non-stable installs, so entries without it read
as `"stable"` (`src/infrastructure/persistence/lockfile_repository.ts`). The
update service looks for updates within the installed channel.

The entry also records the published channel, in `publishedChannel`, when it
was known at install time; a restore that cannot look it up keeps the value
recorded for the same version. The lockfile is repo-controlled, so the value is
read through `readPublishedChannel`, which ignores anything that is not a
channel name. `swamp extension list` shows it: `v2026.10.01.1 [beta, following
stable]` when it differs from the followed channel, and `publishedChannel` in
JSON entries.

### Update cache

The update check cache (`.swamp/extension-update-checks.json`) keys stable
entries by the bare extension name, for backward compatibility, and non-stable
ones by `name:channel` (e.g. `@swamp/aws:rc`).

## Freshness

Two opt-in commands report whether installed extensions are behind the
registry. There is no passive warning on load.

### `swamp extension list`

When stdout is a terminal, this adds a "latest" column to the installed
extensions table. Outdated rows are marked `(update available)`, and rows where
the registry was unreachable `(offline — last check failed)`. Two flags control
this:

- `--check-updates` forces enrichment on, e.g. in CI to get the side-by-side
  view in JSON output.
- `--no-check-updates` forces it off.

By default, enrichment runs only when stdout is a terminal and the output mode
is `log`. JSON output and piped runs skip it, so scripted `extension list` stays
cheap and offline.

When enrichment ran, each JSON entry has optional `latestVersion` and
`updateStatus` fields. `updateStatus` is one of `up_to_date`,
`update_available`, `unknown_offline` or `deprecated`
(`src/presentation/renderers/extension_list.ts`). Consumers can tell "didn't
try" (fields absent) from "tried and failed" (`updateStatus: "unknown_offline"`,
`latestVersion: null`).

Two more optional fields appear whether or not enrichment ran
(`src/libswamp/extensions/list.ts`, swamp-club#2483):

- `onDiskVersion` is present when the version in the extension's on-disk
  manifest differs from the version the lockfile pins, so the loaded code is not
  what the lockfile pins. Log mode shows `(on disk vX)` on the row, then a
  remedy line.
- `autoResolved: true` marks an entry that comes only from the transitional
  in-repo auto-resolve lockfile, not the team's. Log mode shows
  `(auto-resolved)` on the row. `update`, `rm` and `install` act on the team's
  lockfile only, so they do not see such an entry. It is never checked for
  updates (no `latestVersion` or `updateStatus`), and log mode ends with a
  footer saying `update` and `rm` do not manage it. Until swamp-club#2495, it is
  repaired by deleting what it installed so the auto-resolver reinstalls it;
  `extension pull` would pin it in the team's lockfile. Once its directory and
  source files are all gone it is not listed, since it awaits that reinstall.
- `removeToReinstall` accompanies `autoResolved`: the repo-relative paths to
  delete for that reinstall, namely the extension's directory and any pulled
  skill dirs it tracks. A skill dir another extension also claims is shared,
  so only this extension's own files in it are listed. A skill dir left in
  place does not block the reinstall: the auto-resolver writes the skill back
  into it. The log-mode
  remedy line names these paths.

### `swamp extension outdated`

A subcommand for CI gates and scheduled checks. It shows every status other than
up_to_date (update_available, not_found, failed), but the exit code depends only
on update_available:

- Exit 1 if at least one extension has status `update_available`.
- Exit 0 otherwise, including when only `not_found` or `failed` are present.

So `swamp extension outdated && deploy` fails only when a newer version clearly
exists, not on transient registry errors. This exit code is a public contract.
Widening it to fail on not_found/failed would silently break pipelines that rely
on it.

### Deprecation

An extension can be deprecated without being yanked. Deprecated extensions can
still be pulled and resolved, so existing workflows keep working.

`swamp extension deprecate` deprecates a whole extension, not single versions.
The optional `--superseded-by` flag names a replacement.
`swamp extension undeprecate` reverses it.

Deprecation shows up in five places:

- `swamp extension search` shows `[deprecated]` next to the extension.
- `swamp extension info` shows the deprecation time, reason and successor (if
  set).
- `swamp extension pull` warns and names the successor.
- `swamp extension outdated` reports a `deprecated` status alongside
  `update_available`, `not_found` and `failed`. Like not_found/failed, it does
  not fail the exit code, because the extension still works.
- `swamp extension list --check-updates` marks the extension `(deprecated)`
  when the enrichment status is available.

Registry API endpoints are `POST /api/v1/extensions/{name}/deprecate` (body:
`{reason, supersededBy?}`) and `POST /api/v1/extensions/{name}/undeprecate` (no
body). The extension info view returns `deprecatedAt`, `deprecatedByUserId`,
`deprecationReason` and `supersededBy`.

### Cache and registry

Both commands share a 24-hour on-disk cache at
`.swamp/extension-update-checks.json`. The TTL matches `CHECK_INTERVAL_MS` in
`src/domain/update/update_check_cache.ts`. Within that window, freshness comes
from the cache without contacting the registry. The commands only read the
registry; nothing is pulled or upgraded as a side effect.

If the registry call fails for a stale entry, the cache stores
`latestVersion: installedVersion` so it does not retry for 24h. During that time
the entry reads as `up_to_date` although the latest version is unknown. For
advisory data, that is better than every command hitting an unreachable
registry. The in-memory entry from the list composer also carries
`updateStatus: "unknown_offline"`, so within one run the user can tell "just
failed" from "cached up_to_date". After 24h the entry expires and the next
command tries again.

The cache file is written with `atomicWriteTextFile`, so concurrent writers
cannot corrupt it. The repository rewrites the whole map, though, so parallel
runs can lose each other's changes (last writer wins). Entries are independent
and advisory, so a lost change recurs on the next stale check. A
per-extension file or kvstore would remove this trade-off and is a future
improvement.

### Why no passive on-load warning

The original request (issue #199) asked for a warning on every command that
resolves an extension bundle. Comparable tools pointed the other way:

- Terraform, OpenTofu and Ansible all chose not to nag passively about
  plugin/provider staleness, leaving it to the user to opt in. OpenTofu
  reconsidered (issue #2032, closed not-planned) over CI breakage concerns.
- Pulumi warns passively about the CLI itself, not plugins, and users have
  complained about noise on every run (issue #5576), the wrong severity (issue
  #10578), and warnings they can't act on when package managers lag (issue
  #2426).
- No surveyed tool has a well-liked per-extension passive warning. gh's
  extension version checker came closest, and it caused problems (issue
  #10235: a blocking PostRun call hangs commands for minutes).

If demand appears, the documented but unbuilt design is one aggregated line at
the end of a command: info level (not warn), 24h display cooldown, TTY gating,
env-var suppression, and non-blocking, time-limited registry calls.
(`SWAMP_NO_UPDATE_CHECK` in `src/cli/mod.ts` turns off the CLI's own
self-update check, not extension freshness.) Per-extension warnings at the
start of every command are ruled out.

## Behavior Spelling

An extension can name its behaviors with the behavior spelling
(swamp-club#3338). Each name below is an exact synonym of its model form,
which keeps working unchanged:

| Behavior spelling                 | Model form              |
| --------------------------------- | ----------------------- |
| `export const behavior`           | `export const model`    |
| `extensions/behaviors/`           | `extensions/models/`    |
| manifest `behaviors:`             | manifest `models:`      |
| `SWAMP_BEHAVIORS_DIR`             | `SWAMP_MODELS_DIR`      |
| `source add --only behaviors`     | `--only models`         |
| `search --content-type behaviors` | `--content-type models` |

- **Export.** The behavior kind adapter reads `behavior` as an alias of its
  `model` export key (`primaryExport` in
  `src/domain/extensions/kind_adapter.ts`). A module that exports both as
  definitions is refused, because which one it means cannot be told. An
  unrelated `behavior` binding that does not read as a definition is ignored,
  so modules written before the alias load as they did.
- **Environment variable.** `SWAMP_BEHAVIORS_DIR` names the models directory
  exactly as `SWAMP_MODELS_DIR` does (swamp-club#3410). The order is
  `SWAMP_MODELS_DIR`, then `SWAMP_BEHAVIORS_DIR`, then `.swamp.yaml`
  `modelsDir`, then the default; an empty value counts as unset.
  `resolveModelsDir` is the one reader. Both set to different non-empty
  values is refused once at CLI startup with an error naming both; equal
  values are accepted. `resolveModelsDir` itself never refuses, because some
  callers swallow its errors.
- **Kind and content type.** `swamp extension source add --only behaviors`
  is stored in `.swamp-sources.yaml` as `models`, and
  `swamp extension search --content-type behaviors` asks the registry for
  `models` (swamp-club#3410). A list that names both collapses to one
  `models`; a list without the behavior spelling is kept as typed.
  `behaviours` is not a synonym and is refused naming the value.
- **Directory.** `extensions/behaviors/` loads beside `extensions/models/`
  only while the models directory is the default. Once `SWAMP_MODELS_DIR`,
  `SWAMP_BEHAVIORS_DIR` or `.swamp.yaml` `modelsDir` moves it, there is no
  behaviors directory, so a
  repo that chose where its behaviors live never gains a second one
  (`resolveBehaviorsDir` in
  `src/infrastructure/persistence/resolve_models_dir.ts`). Source repos added
  with `swamp extension source add` follow the same rule, and their behaviors
  directory loads after their models directory. In the repo itself both
  directories are local, so neither outranks the other: a type defined in both
  is a duplicate-type error naming the two files.
- **Manifest key.** `behaviors:` lists behavior entry points. They and the
  `include` entries resolve from the behaviors directory, from the configured
  models directory when there is none, or from the manifest's directory under
  `paths.base: manifest`. A manifest that sets `models:` ignores `behaviors:`,
  as it always did, so the behavior spelling is read only when `models:` is
  absent.
- **Push.** The archive keeps one layout. Push packs files from the behaviors
  directory under the archive's `models/`, by their path from that directory,
  and writes the pushed manifest with `models:`. Two files that would be
  packed at the same `models/` path, one from each directory, fail the push
  (`assertDistinctModelArchivePaths` in `src/libswamp/extensions/push.ts`).
- **Compatibility warning.** A swamp client or worker older than the first
  release with swamp-club#3338 reads only `export const model`,
  `extensions/models/` and `models:`, so it cannot load a behavior-spelled
  source. Push adds the `behavior-spelling` review warning (Compatibility
  dimension) naming the spellings the extension uses. The rule is acceptable:
  `--yes` or an extension-scoped `quality.yaml` entry acknowledges it.
- **Unchanged.** Swamp keeps writing the model form. `swamp repo init`
  creates `extensions/models/`, the generated agent guidance names it, and
  pulled extensions keep their `models/` layout. `export const extension`,
  `modelRegistry.extend` and other code names have no behavior spelling.
  `@swamp-club/swamp-testing` exports `defineBehavior`, the same function as
  `defineModel`, from 0.20261013.52, its first release after swamp-club#3338.

## Manifest

Every extension is defined by a `manifest.yaml` file that declares its contents
and how to package them.

### Required Fields

- `manifestVersion`: must be `1`, the only supported version.
- `name`: scoped name (`@collective/name`).
- `version`: CalVer version string.
- At least one of `models` (or `behaviors`), `workflows`, `vaults`,
  `datastores`, `reports`, `webhooks` or `skills`.

### Path Safety

Every manifest path must be **relative and downward-only**. Push rejects paths
with `..` components (e.g., `../../workflows/file.yaml`) or a leading `/`
(absolute paths). Such paths would produce archive entries that pull's safety
check rejects, since it refuses any tar entry containing `..` or starting with
`/`.

### Optional Fields

- `description`: human-readable description.
- `paths.base`: how the typed keys below resolve, `"typedDir"` (default) or
  `"manifest"`. See "Path resolution" below. Under `"manifest"`, entries must not
  repeat the typed directory prefix, because the archive already puts each entry
  under its typed directory: write `models: ["project.ts"]`, not
  `models: ["models/project.ts"]`.
- `models`: relative paths to TypeScript behavior files (e.g.,
  `["aws/ec2/instance.ts"]`). Resolved via `paths.base`.
- `behaviors`: the behavior spelling of `models`, ignored when `models` is set.
  See "Behavior Spelling" above.
- `workflows`: relative paths to YAML workflow files. Resolved via `paths.base`.
- `vaults`, `datastores`, `reports`: relative paths to TypeScript vault,
  datastore and report files. Resolved via `paths.base`.
- `skills`: skill directory names. Each must contain a `SKILL.md` whose YAML
  frontmatter declares `name` and `description`. Skills are passive markdown
  guidance; swamp never runs them.
- `repository`: URL of the source repository (e.g.,
  `"https://github.com/org/repo"`).
- `releaseNotes`: free-form notes for this version (max 5000 characters).
- `include`: relative paths to files copied into the archive next to behaviors
  but not bundled, such as helper scripts run as a `Deno.Command` subprocess
  rather than imported. Resolved via `paths.base`.
- `additionalFiles`: relative paths to non-behavior files (README, config,
  etc.). Always resolved relative to the manifest's own directory.
- `platforms`: supported platform identifiers (e.g.,
  `["darwin-aarch64", "linux-x86_64"]`). Informational only; shown during pull.
- `labels`: categorization labels (e.g., `["aws", "kubernetes"]`), at most
  `MAX_LABELS = 20` (`src/domain/extensions/extension_manifest.ts`).
- `dependencies`: extension names (`@collective/name`) this extension needs.
  They are pulled automatically.

### Example

```yaml
manifestVersion: 1
name: "@keeb/ssh"
version: "2026.02.26.1"
license: MIT
description: "SSH connection management for swamp"
models:
  - ssh/connection.ts
workflows:
  - ssh-check.yaml
reports:
  - cost-summary.ts
additionalFiles:
  - ssh/known_hosts_template.txt
dependencies:
  - "@keeb/network"
platforms:
  - darwin-aarch64
  - linux-x86_64
labels:
  - ssh
  - networking
```

### Path Resolution

`paths.base` picks the directory that typed-key entries (`models`,
`behaviors`, `vaults`, `datastores`, `reports`, `include`) and
`additionalFiles` resolve against during push:

- **`typedDir` (default)**: typed entries resolve relative to their configured
  directory from the repo marker (`modelsDir`, `vaultsDir`, etc., or environment
  overrides like `SWAMP_MODELS_DIR` or its behavior spelling
  `SWAMP_BEHAVIORS_DIR`). `behaviors` entries resolve from the
  behaviors directory (see "Behavior Spelling"). `additionalFiles` resolves
  relative to the manifest's own directory. This is the original rule, kept by
  every manifest without `paths.base`.
- **`manifest`**: every typed entry and `additionalFiles` resolve relative to
  the manifest's own directory. Use it when each extension has its own
  subdirectory holding manifest, source, README and LICENSE (e.g.
  `extensions/models/myext/manifest.yaml` next to `myext/echo.ts` and
  `myext/README.md`).

Workflows honour `paths.base: manifest`: the manifest's own directory is
searched first, then `workflows/` and `extensions/workflows/` under the
extensions root (see "Split Extensions Directory" below), then the same two
under the repo dir. Under the default `paths.base: typedDir`, the extensions
root and repo dir locations are used; with no `--extensions-dir` and a manifest
inside the repo they coincide, so the list is the historical one.

Skills honour it too: the manifest's own directory first (e.g.
`sub/.claude/skills/<name>/`), then the extensions root's skill directory, then
the repo-root (project-local) one. Every enrolled tool's skill directory is
searched, not only the primary tool's. The user's global skill directory
(`~/.claude/skills/`) is never searched: a skill is not packaged from a locally
installed copy just because it has the same name (swamp-club#3018).

When the root was inferred (no `--extensions-dir`) and a bundled workflow or
skill exists under both it and the repo dir at different paths, push refuses
with an error naming both, rather than silently packaging one of them. With
`--extensions-dir` the flag's root simply wins: a git worktree holds every
tracked file in both trees by design, and the author chose the root.

Local source loading also honours `paths.base: manifest`. At startup the loader
scans every known extension directory for such manifests. If one declares a kind
other than its parent directory's (e.g. a `reports:` entry in a manifest under
`extensions/models/myext/`), its directory becomes an extra source directory for
that kind. This closes a gap between dev and prod. Published bundles loaded
every declared component, but local loading only found components in the
matching kind directory.

### Source-Path Skill Installation

Source-path extensions (set up in `.swamp-sources.yaml`) can provide skills too.
When `extension source add` records a source, it reads its `manifest.yaml`. If
that declares `skills`, it copies those skill directories into the repo's
tool-specific skills directory (e.g. `.claude/skills/`). Resolution uses the
same `paths.base` strategy as `extension push` and `extension quality`: relative
to the manifest under `paths.base: manifest`, otherwise under the source root's
tool-specific skill directories.

The installed skill names are recorded in the `installedSkills` field of the
source entry in `.swamp-sources.yaml`. `extension source rm` reads this field
and deletes those skill directories, so cleanup works even if the source
directory is gone.

The manifest in the archive keeps its field strings as written, with no
path rewriting or normalization, so the registry stores what the author pushed.
The archive layout under each typed-key directory follows the entry strings:
under `paths.base: manifest` with `models: [echo.ts]`, the archive contains
`extension/models/echo.ts` directly.

## Archive Structure

On push, an extension is packaged as a gzipped tar archive:

```
extension.tar.gz
└── extension/
    ├── manifest.yaml
    ├── quality.yaml          # Declared acceptances and the generated declaration, when present
    ├── dependency-audit.json # Each shipped npm/jsr version, unaudited code, bundle hashes and format (v2)
    ├── models/              # Source TypeScript behavior files
    │   └── ssh/
    │       ├── connection.ts
    │       └── helpers.ts
    ├── bundles/              # Compiled behavior JavaScript bundles
    │   └── ssh/
    │       └── connection.js
    ├── workflows/            # YAML workflow files
    │   └── ssh-check.yaml
    ├── vaults/               # Source TypeScript vault files
    ├── vault-bundles/        # Compiled vault JavaScript bundles
    ├── datastores/           # Source TypeScript datastore files
    ├── datastore-bundles/    # Compiled datastore JavaScript bundles
    ├── reports/              # Source TypeScript report files
    ├── report-bundles/       # Compiled report JavaScript bundles
    ├── skills/               # Skill directories (SKILL.md + references)
    ├── files/                # Additional files
    ├── lib/                  # Shared sources mirrored from one level above a kind's directory, any unreserved name
    └── _shared/              # Shared sources from anywhere else in the repository
```

Pull installs the archive at `.swamp/pulled-extensions/<name>/`, each entry at
its archive path. Shared sources (see [Import Resolution](#import-resolution))
go there too, so the installed sources' relative imports resolve as they do in
the archive.

Pull reads each entry's tar header before the entry is written and installs only
regular files and directories. A symlink, hardlink, device, FIFO or any other
entry type refuses the whole archive, naming the entry and its type but never a
link's target, so an installed extension never holds a link. After extraction
pull makes the same last check push makes on its staged tree: a symlink anywhere
under the extracted archive refuses it. Archive paths in pull's errors print
control characters as visible escapes.

### Behaviors

Source TypeScript files keep their paths relative to the active base: the
configured `modelsDir` under `paths.base: typedDir`, or the manifest's directory
under `paths.base: manifest`. Files from the behaviors directory are packed
under `models/` by their path from it. Local imports are followed recursively;
if `connection.ts` imports `./helpers.ts`, both are included.

Files in `include` are also copied to `models/`, keeping their paths relative to
the active base (the behaviors directory for a `behaviors:` manifest). They are
not bundled; they are raw TypeScript meant to run as subprocesses or standalone
utilities.

### Loader pre-check

At runtime, loaders find `.ts` files in their directories and try to bundle
each. First the loader reads the source and looks for the expected named export
(`export const model` or `export const behavior`, `export const vault`, etc.).
Files without it are skipped silently, with no bundling attempt and no error.
This way helper scripts with unbundleable dependencies (e.g., native modules
used via a `Deno.Command` subprocess) cause no failures.

### Bundles

Each behavior entry point is compiled with `deno bundle`, with zod externalized.
All other non-local specifiers (`npm:`, `jsr:`, `https:`) are resolved and
inlined, so they work in the compiled binary, where only swamp's own embedded
dependency graph exists. Zod stays external so extensions share swamp's zod
instance, which schema `instanceof` checks require. Dynamic `import()` is not
supported; all imports must be static and top-level. Bundles are JavaScript
files stored next to their sources under `bundles/`.

**Specifier kinds:** `deno bundle` handles `npm:`, `jsr:` and
`https:` natively and alike. All are inlined, cached by Deno's module cache, and
follow the same zod externalization rules, with no per-kind configuration.

**Pin versions on all non-local specifiers** (`npm:`, `jsr:`, `https:`) for
reproducibility. An unpinned specifier resolves to the registry's "latest" at
push time, so the published bundle changes silently whenever upstream releases.
Author guidance is in
`.claude/skills/swamp/references/extension-publish/references/publishing.md`.

#### Project-aware bundling

An extension may live inside a project with a Deno config (`deno.json` or
`deno.jsonc`) or a `package.json`. `swamp extension push` walks up from the
manifest directory to the repo root looking for project config.

**Detection priority:** push walks the whole path for a Deno config first,
taking `deno.json` over `deno.jsonc` in the same directory as Deno does
(swamp-club#3612). Only if it finds neither does it walk again for
`package.json`. So a Deno config always wins, whatever its depth. Push, quality
and fmt share this lookup (`detectExtensionProject`), and every reader of the
config's own settings (`lock`, `lint.rules.exclude`) parses it as JSONC
(`parseDenoConfig`).

**Bare specifier gate:** a `package.json` is used only if an entry point
imports a bare name (e.g., `from "zod"` rather than `from "npm:zod@4"`), in any
import form: static, side-effect, dynamic or re-export (swamp-club#3983). This
keeps an unrelated `package.json` (e.g., one listing `@anthropic-ai/claude-code`
for tooling) from being taken as the extension's project config.

Specifiers come only from the module's own imports. Import statements
inside template literals are generated code for a script the extension emits at
runtime, not part of its own module graph, so every bare-specifier check ignores
them.

**One resolver (swamp-club#3969):** push, quality, fmt and the loader read the
project, each module's import sites and Deno's module graph through one module,
`src/domain/extensions/dependency_resolution/`: `detectExtensionProject` and
the lock rules (`configuredLockPath`, `frozenLockPath`), the import sites
(`scanImportSites`, read with the shared scorer's scanner from
`@swamp-club/extension-scoring/source`, so push reads imports as the registry
does), the bare-specifier classifier (`isBareSpecifier`), the top-level
import-map reader the package cache key and the zod fallback use, and
`runDenoInfo`, the one way swamp runs `deno info`. Each caller keeps its own
flags for the read. The scan reads each module's syntax tree
(swamp-club#3983): one parse configuration, `parseExtensionModule` in
`@swamp-club/extension-scoring/source`, serves the import scan, the
quality-ignore directive reader and the bundler's own parse, and picks the
syntax from the file: TypeScript, JavaScript (without the TypeScript plugin,
which refuses some valid JavaScript) or JSX, reading CommonJS (`.cjs`, `.cts`)
as a script and other modules as modules. Push and quality refuse a code
file that does not parse, naming it (the `source-syntax` gate), and a bundle
push built that does not parse fails as a swamp bug. The registry's audit
counts such a module as not audited (`writtenSpecifiers` returns null, and
`scorecardResult` takes the module's path), so it costs the dependency-trust
points; the loader reads it as having no imports, so the
bundler reports its syntax error. The input vectors
(`dependency_resolution/testdata/dependency_input_vectors/`, run by
`integration/dependency_input_vectors_test.ts`) pin, per input form, what push
ships, audits and records, what quality and fmt read and what the loader
bundles, against real Deno with local npm, JSR and URL hosts. Each runs in a
process whose working directory is the vector's repository, since Deno discovers
a config from the working directory, not from the module it reads.

#### Bundling permutations

| Scenario                                  | `deno bundle` flags                                      | Quality check flags    | Notes                                                                                                            |
| ----------------------------------------- | -------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Deno config found**                     | `--config <deno.json>`                                   | `--config <deno.json>` | The config governs resolution; project lint/fmt rules apply (`extension fmt` too)                                |
| **`package.json` found, bare specifiers** | `--node-modules-dir=manual`, `cwd` set to package.json dir | `--no-config`          | Deno auto-detects package.json; `node_modules/` must exist from `npm install` or `deno install`                  |
| **`package.json` found, `npm:` imports**  | `--no-lock --node-modules-dir=none`                      | `--no-config`          | Package.json is ignored (extension doesn't need it)                                                              |
| **No config found**                       | `--no-lock --node-modules-dir=none`                      | `--no-config`          | Default                                                                                                          |

Every lint of extension code (push, `extension quality`, `extension fmt`)
passes `--rules-exclude=no-import-prefix`: with a project config Deno's
recommended set forbids the `npm:`/`jsr:` imports the bare-specifier finding
asks for, so the two would contradict. The project's other rules still apply.
The `bare-specifiers` finding names only the bare imports that ship as written
(see [Bare imports in the shipped source](#bare-imports-in-the-shipped-source)):
under a Deno config, those Deno does not resolve to an `npm:`, `jsr:`, `node:`
or URL specifier; in package.json mode, those that do not resolve to a
registry dependency installed in `node_modules/`; with neither, every bare
import.

In the bare-specifier row, push, quality and fmt read `node_modules/` as
installed (`--node-modules-dir=manual`) and never write it (swamp-club#3630):
Deno managing it (`auto`) adds its own `node_modules/.deno/` tree, even to one
`npm install` made. The module graph read, the bundle and the lock flags share
`denoProjectArgs`, so all three follow it. A dependency package.json declares
at a registry range that is not installed, or is installed outside that
range, fails push and quality with an install hint naming each package; fmt
reads past it. Local loading (the extension loader, `serve` reload) still
bundles with `--node-modules-dir=auto`.

`--node-modules-dir=none` is required in the last two rows. Without it, any
`package.json` in the directory tree switches Deno to `node_modules/`
resolution, which breaks `npm:` imports with errors like "Could not find a
matching package for 'npm:@octokit/rest@22.0.1' in the node_modules directory."

`jsr:` and `https:` specifiers behave the same in all four rows. They need no
`deno.json` or `package.json`, so project-config detection does not affect them.
Deno's module cache fetches them on first use and reuses them offline.

#### Zod externalization

Zod is externalized with `--external` flags matching the specifier as written.
The bundler handles:

- `npm:zod@4` and `npm:zod` (base patterns, always applied)
- Every other zod 4 spelling, pinned (`npm:zod@4.3.6`) or ranged
  (`npm:zod@^4.1`, `npm:zod@>=4.1 <5`), exactly as written: the bundler reads
  the entry point and every module it reaches through relative imports as text
  (`zod4SpecifiersReachedFrom`, no `deno` call) and externalizes each `npm:zod`
  specifier that admits only 4.x. Push ships such a spelling whenever the
  config resolves `"zod"` to one (swamp-club#3637), so a pulled extension
  rebundles with zod still shared.
- Bare `"zod"` under a Deno config: when every module that writes it resolves
  it, as Deno does (imports, an `importMap` file, a scope, a workspace root), to
  an `npm:zod` version or range that admits only 4.x, both the resolved
  specifiers and bare `"zod"` are externalized (`sharedZodTargets`,
  swamp-club#3612). `--external` matches the written text for the whole bundle,
  so a scope that sends `"zod"` to zod 3 in any one module keeps it inlined
  everywhere. Push hands the bundler the resolutions it read from the module
  graph; the loader and serve reload run `deno info` themselves.
- Bare `"zod"` via `package.json`: when `dependencies` or `devDependencies`
  lists zod 4.x

After bundling, `rewriteZodImports` rewrites each externalized zod import to
`globalThis.__swamp_zod`, which `installZodGlobal()` sets at runtime. The
rewrite matches bare `"zod"`, `npm:zod`, and any version or range every admitted
version of which is 4.x (`isZod4Specifier`), but excludes zod 3.x, to avoid
silent runtime breakage; an import whose version or range admits only 3.x is
refused at bundle time.

The rewrite applies to import declarations only. The bundle is parsed to find
them, so the same text inside a string, template literal, comment or regex
literal — the output of an extension that generates TypeScript, say — is left
byte-identical. A bundle that holds zod import text but cannot be parsed is
rejected with a `bundle_parse_failed` error naming the extension, rather than
rewritten by guesswork — the cause is either a damaged cached bundle or syntax
the parser does not support. The zod 3.x check is scoped the same way.

#### Runtime bundle caching

At runtime, loaders look for cached bundles in `.swamp/bundles/` (or the
matching `-bundles/` directory). If the source has bare specifiers that need a
project config and a cached bundle exists, the loader uses it, since re-bundling
without the config would fail. This serves pulled extensions built in a
`package.json` project, or whose bare imports the Deno config did not resolve,
whose archive has pre-built bundles but no project config. Bare imports the
config resolves were rewritten to their targets on push, so that source
re-bundles on its own. Imports inside template literals don't count here either,
so an extension that only generates code re-bundles normally.

With a non-filesystem datastore (e.g. `@swamp/s3-datastore`), bundle paths go
through the `DatastorePathResolver` instead of the hardcoded local `.swamp/`
directory, so bundle reads and writes use the datastore cache path (e.g.
`~/.swamp/repos/<repo-id>/bundles/`). The datastore loader is the exception.
Because of bootstrap order it always uses the local path: it loads the
datastore extensions that configure the resolver. Without a resolver (e.g.
during `repo init` or in tests), loaders fall back to the local `.swamp/` path.

### Vaults, Datastores, Reports, and Webhooks

Vault, datastore, report and webhook entry points are bundled like behaviors.
Each gets a compiled `.js` file in its `-bundles/` directory (`vault-bundles/`,
`datastore-bundles/`, `report-bundles/`, `webhook-bundles/`). Local imports are
followed as for behaviors, wherever they live. The install-time `KIND_DIRS`
array covers `["models", "vaults", "datastores", "reports", "webhooks"]`.

Each bundle's export is validated against a Zod schema:

- **Vaults**: `export const vault` with `type`, `name`, `description`,
  optional `configSchema`, and `createProvider`
- **Datastores**: `export const datastore` with `type`, `name`,
  `description`, optional `configSchema`, and `createProvider`
- **Reports**: `export const report` with `name`, `description`, `scope`,
  optional `labels`, and `execute`
- **Webhooks**: `export const webhook` with `type`, `name`, `description`,
  optional `configSchema`, and `createHandler`. `createHandler` returns the
  handler for `swamp serve` webhook endpoints whose scheme is the type (see
  [serve](serve.md))

### Collective Validation

Push checks that all content (behavior types, vault types, workflow names,
datastore types, report names, webhook types) uses the extension name's
collective, so an extension cannot register types under another collective.

### Workflows

Each workflow lands at `workflows/<archive name>` in the archive. A manifest
entry whose directory holds exactly one listed workflow is named after that
directory (`namespace-debug/workflow.yaml` → `namespace-debug.yaml`), the
one-workflow-per-folder layout where every file is called `workflow.yaml`. A
directory listed more than once keeps each file's basename
(`workflows/a.yaml`, `workflows/b.yaml` → `a.yaml`, `b.yaml`), as a bare entry
always does. Two entries that still map to one archive name, including a
workflow pulled in by dependency resolution, fail every command that resolves
the manifest (`push`, `push --dry-run`, `quality`, `fmt`) with an error naming
both; a file listed twice is rejected as a duplicate entry. A package never
drops a workflow silently.
Consumers never depend on these file names: pull discovers workflows by the
`name` field inside each YAML.

### Additional Files

`additionalFiles` go under `files/`, keeping their relative paths. A manifest
entry `prompts/review.md` lands at `files/prompts/review.md` in the archive, and
at `.swamp/pulled-extensions/<name>/files/prompts/review.md` for consumers.

Push rejects:

- Duplicate entries (case-insensitive, NFC-normalized). Two entries mapping to
  the same archive path fail with an error naming both.
- Symlinks, to avoid archive bloat and path escapes: an entry that is a symlink,
  or one reached through a symlinked directory, is refused by the safety gate's
  symlink rule (see below). Copy the target file into the extension tree
  instead.

### Runtime access

Method `execute` functions and report functions get a context with an
`extensionFile(relPath)` helper. It turns a relative `additionalFiles` path into
an absolute path, whether the extension was added with
`swamp extension source add` (relative to the manifest) or pulled from the
registry (under `.swamp/pulled-extensions/<name>/files/`).

```ts
export const model = {
  type: "@org/ext/demo",
  version: "2026.04.22.1",
  methods: {
    run: {
      arguments: z.object({}),
      execute: async (_args, ctx) => {
        const path = ctx.extensionFile("prompts/review.md");
        const prompt = await Deno.readTextFile(path);
        // ...
      },
    },
  },
};
```

The helper throws a typed `UserError` if the path is unsafe (contains `..` or
starts with `/`), the file is missing, or the behavior was not shipped via an
extension manifest. For a missing file, pulled archives get a re-publish hint;
source-mode callers get the absolute path and a pointer to the manifest entry.

## Import Resolution

When packaging, the CLI reads each entry point's module graph (behavior, vault,
datastore, report or webhook) with `deno info`, under the same project config
`deno bundle` uses, so the archive's source copy holds every local module the
bundle was built from (swamp-club#3376). That covers static, side-effect, type
and literal dynamic imports, and JSON, text or bytes imports, wherever the
module lives in the repository. Non-local imports (`npm:`, `jsr:`, `https:`) are
not packaged as source; `deno bundle` inlines them at bundle time.

Each local module goes where its relative imports still resolve:

- Inside the kind's directory: `<kind>/<path relative to the directory>`, byte
  for byte, as it always has.
- One level above the kind's directory: its mirrored path at the archive root
  (`../lib/cmp.ts` from `models/` becomes `lib/cmp.ts`), byte for byte, unless
  the name is one the archive reserves (`bundles`, `files`, a kind directory,
  and so on).
- Anywhere else in the repository: `_shared/<path from the extensions root>`,
  with each leading `..` written as `_up` (the registry rejects `..` in archive
  paths). Only the archived copies of the importing files change: the import
  specifiers that point at a `_shared/` module are rewritten, and line numbers
  stay the same.

No extension file may have a symlink on its path (swamp-club#3421): not the
file itself, and not any directory between it and the outermost root that
holds it, the repository, the extensions root or the manifest's directory. That
covers entry points, graph modules, `include`, `additionalFiles`, `binaries`,
workflows and skills, so a symlinked `extensions/`, a symlinked skill directory
and a symlink inside a skill are refused too. Symlinks above that root, such as
a repository under macOS `/tmp`, are not the extension's and are allowed. Push
never follows one: each refused file stays listed, unread, for the safety gate,
which refuses it by the symlink rule and names the symlinked component, never
its target. The package cache hashes it by path, not contents. Staging copies
regular files only, and push checks the staged tree holds no symlink before it
builds the archive, so an archive never holds one.

Symlinks are taken out of the graph before it is used (swamp-club#3420). An
entry point with a symlink on its path is never read: not by the bare-specifier scan,
`deno info` or the bundler. A module `deno info` reaches through a symlink is removed along with
every module it alone leads to and any error recorded for it, since that error
quotes the target's source. Each symlink is then listed for the safety gate,
which refuses it by the symlink rule before anything is bundled; `fmt` leaves
symlinks out, so it never writes through one. The checks that run before the
safety gate never read a symlink either: content metadata skips one, so what a
target declares cannot reach the content-collective check, and a symlinked
`quality.yaml` is refused unread.

Push fails when a local module is missing, when its real path leaves the
repository and the extensions root (a relative import that climbs out of them),
or when two different files would share an archive path. Data modules are packaged, hashed
and safety-scanned, but not formatted, linted or reviewed as TypeScript.

Pull installs the shared sources at the same path under the extension's install
root (swamp-club#3384): every file under `_shared/` or under a top-level entry
whose name the archive does not reserve. `isReservedArchiveRootName` is the one
list push and pull both read. It also holds `drivers` and `driver-bundles`,
which push wrote before driver support was removed and pull has always ignored.
Pull passes each shared source, data modules included, to the safety analyzer
push uses, records it in the lockfile entry's `files`, and treats it like any
other installed file on upgrade, conflict detection and `extension rm`. It
refuses an archive, before writing the entry, that holds:

- a symlink or hardlink anywhere, as push never writes one;
- under a shared source, a backslash (push writes `/`; on Windows the extractor
  would split on it), a hidden or `..` segment, `node_modules`, or a
  `deno.json`, `deno.jsonc` or `package.json` (any case), which would change how
  the installed source resolves;
- a top-level name that differs from a reserved one only by case.

An extension nested under another (`@a/b/lib` under `@a/b`) cannot be installed
at a directory where its parent keeps shared sources, nor the parent installed
over such a nested entry. Either install fails and names the extension to remove
first.

### Consumers run the publisher's bundle

Every consumer path runs the bundle the archive ships, as `extension install`
always has (swamp-club#3972): `extension pull`, `extension update`, auto-resolve
on first use, and serve's `extension.pull` and `extension.update`. They all go
through phase 8, which indexes the staged archive bundle through the loader's
trusted-pulled path (`trustPulledCache`) instead of rebuilding it. So pull and
install of one version leave the same bundle bytes, and on every kept path the
dependency tree is the one the publisher bundled `--frozen` against their lock.

The v2 dependency audit record (`dependency-audit.json`) is what pull checks the
bundles against, in `prepareInstall`, right after it scans them and on the same
bytes:

- **`bundles`** maps each bundle file's archive path to a SHA-256 push took of
  it. A bundle that is not listed, a listed bundle that is not in the archive,
  or a hash that does not match refuses the pull before anything is written. The
  keys are only compared with the paths the scan found, never opened. The record
  and the bundles come from one push, so this shows neither was changed apart
  from the other; it does not show who published them. The bundle scan below is
  the check on the bundle's content, and signing (swamp-club#1592) the later
  check on its publisher.
- **`bundleFormat`** names what the bundles expect from the swamp that runs
  them: `BUNDLE_FORMAT_VERSION` in `bundle.ts`, an ES module that takes zod 4
  from `globalThis.__swamp_zod` and holds no zod 3 import. A record written
  before the field existed reads as format 1. It is unrelated to
  `BUNDLE_LAYOUT_VERSION`, which names where a repo keeps bundles on disk.

An archive with no v2 record (pushed before swamp-club#3970) keeps its bundles
unchecked, as install does; the scan still covers them. A record that is present
but neither v1 nor v2 refuses the pull.

Phase 8 rebuilds a source from the pinned shipped source, with `--no-config` and
through the `checkBundle` scan, only when:

- the record's `bundleFormat` is not this swamp's, in which case every source of
  that extension is rebuilt. The staged archive bundle is removed first, so a
  rebuild that fails, or that the loader would not try, leaves the source
  unindexed instead of running a bundle of the wrong format;
- the archive has no bundle for the source;
- the kept bundle fails to load or index, in which case that source is rebuilt
  once. A source the archive had no bundle for was rebuilt on the first try and
  is not tried again.

Workers still build their own self-contained bundle, with zod inlined, from the
registered source (`createBundleSourceFactory`), since no host provides zod
there. Its top-level versions are the pinned ones; transitive versions resolve
fresh.

### Pull scans the bundles that run

The bundle is what runs, and it can hold code the source copy lacks: an archive
published before swamp-club#3376 can bundle local modules its source copy left
out, and any archive can bundle code from directories pull does not scan, such
as `files/`. So pull also scans bundles (swamp-club#3383), at two points:

- **The archive's bundles**, in `prepareInstall`, after the source scan and
  before anything is written: every file in a bundle dir, whatever its name,
  since a case-insensitive filesystem opens `thing.JS` as `thing.js`. This is
  what every consumer path runs (see above). Phase 8 indexes it without
  scanning it again.
- **Each bundle phase 8 rebuilds** (a bundle format this swamp does not run, a
  source with no archive bundle, or a kept bundle that failed to load), through
  the loader's `checkBundle` hook, after it is built and before it is probed or
  imported. The probe host runs a bundle's top-level code with full permissions,
  so a scan after it would be too late. A refusal here rolls the install back,
  as a type collision does; any other phase-8 fault commits the half-installed
  state. A source that fails for another reason does not stop the rest: every
  source is still rebuilt and scanned, and a refusal anywhere in the set (the
  extension or a dependency) decides ahead of any other failure. The rebuilt
  bundle is deleted, because a bundle dir the archive had nothing for is not
  staged; if it cannot be, the refusal names the file to delete. On a refused
  upgrade whose archive had no bundle at that path, the previous version's
  bundle is gone too and is rebuilt from its source on the next load. As with a
  collision, the catalog's recorded source modules for the refused sources stay
  until the next bundle rewrites them.

Only the `dynamic-code` rule runs on a bundle (`analyzeBundleSafety`). It is the
one hard-error rule that reads content. The file rules (type, size, count) are
for sources and would refuse every `.js` file or any bundle over 1 MB, and links
are refused for the whole archive already. The source scan is unchanged.

A finding is attributed to the module whose boundary is the closest one above it
(`BundleModuleMap`). esbuild writes a path comment (`// <path>`, verbatim,
spaces included) above each module. Every line comment at column 0 is a
boundary, except an annotation (`@__NO_SIDE_EFFECTS__`), a source-map directive,
or a legal comment starting with `!` or `@license`. So a module comment the
pattern does not recognize (an unusual extension, a path broken by a newline in
a file name) still ends the module above it, and its code counts as the
extension's own. When the bundle parses, the comments come from the parser's
comment list, so comment-like text in a string cannot start a module, and lines
are counted by `\n` from each comment's offset, as the safety rules count them.

A module whose path is in a Deno or npm cache, under `node_modules`, or at a
remote specifier is a dependency. Its findings are pull warnings, one per
dependency module (named by its registry part, such as `npm:ajv/...`), and do
not block. Every other finding refuses the install and names the bundle, module
and line: findings in the extension's own modules, above the first module
comment (esbuild's runtime prelude has no eval), or anywhere in a bundle without
module comments. In a rebuilt bundle, a module under a `pulled-extensions` root
is the extension's own even under a `node_modules` directory, since this machine
chose that path. Module paths are printed with control characters escaped and
are cut to 200 characters.

An archive bundle's comments are the publisher's text. A publisher can put a
dependency's path above their own code and turn its findings into warnings. That
gap is accepted until signing ties the bundle to its publisher; the bundle hash
in the record cannot, since the publisher writes both. The rebuilt-bundle scan
does not have the gap: its comments are written by this machine's esbuild, and a
rebuilt bundle that does not parse counts as the extension's own throughout,
since without a parse a module comment cannot be told from text in a string.
Code in a real npm or remote dependency, chosen by the author, still only warns
in either scan: findings in dependency code are reported, not refused.

Two gaps remain outside this scan (swamp-club#3996): an archive bundle can
import a file the scan does not read (a sibling under `bundles/`, or a file
under `files/`) at run time, and a pulled source with no bundle on disk, or
whose source changed, is rebuilt by a later warm load (`recoverMissingBundle`,
`rebundleAndUpdateCatalog`) or by serve's hot reload (`reloadPulledExtensions`)
without a scan. A layout-version change evicts kept archive bundles, so the next
load rebuilds them that way too. Since pull keeps the archive's bundle, a failed
pull-time rebuild now leaves a source without a bundle only on the fallback
paths. Closing the first gap needs a new rule (refusing relative imports in a
bundle), which waits on the safety-analyzer review; the second needs those
rebuild paths to pass the same `checkBundle` hook.

Measured on 2026-10-26 against the latest stable version of every published
extension (7,330 bundles): none would be refused, and 58 extensions have
dependency findings in well-known npm packages (cel-js, jsonpath-plus, ajv,
typebox, zod when inlined, and others). Every bundle carries module comments.

### Bare imports in the shipped source

The archive never holds the project's `deno.json` or `deno.lock`, and the
registry's scorer strips any it finds, so a bare import (`from "ms"`) would not
resolve in the shipped source. Under a Deno config, push rewrites each bare
import a code module writes to the specifier Deno resolves it to from that
module (swamp-club#3637), in the archived copy only, at the import's exact span,
beside the relative rewrites above:

- Resolution is Deno's own (swamp-club#3612). The module graph push already
  reads with `deno info` under the project config reports, for every local
  module, what each bare import it writes resolved to — through the config's
  `imports`, an `importMap` file it references, the scope covering that module,
  or a workspace root's imports. `bareImportsFromDenoInfo` keeps these as
  `ResolvedBareImport`s, and a `BareImportResolver` answers by importing module
  and specifier, never with another module's answer. A name Deno reports an
  error for is unresolved, ships as written and raises the `bare-specifiers`
  finding; push never falls back to reading the config itself, so it never
  ships or audits a different target than the bundle was built with. Deno
  refuses a remote `importMap` in a config, and so does push's graph read.
- Under a manual `nodeModulesDir` (a `package.json` beside the config) Deno
  applies the import map and then looks the npm package up in
  `node_modules`, so a mapped name reads as an error when nothing is
  installed and as a file there when it is. Either way it carries no
  specifier, so any unresolved name is read again with
  `--node-modules-dir=none` (`withPackageSpecifiers`), where Deno names the
  npm specifier instead: where a package is installed does not change what a
  name maps to. That read also resolves a name listed only in the
  `package.json`, as Deno does, so it is rewritten and audited too. The
  bundler's own graph read (loader, serve reload) does the same, so a bare
  `"zod"` stays external there. These resolution reads run with `--no-lock`:
  they are queries, never freeze or write the author's lock, and a lock
  written under a manual `node_modules` need not hold what the other mode
  wants; the bundle keeps its own lock flags. When Deno gives no answer for a
  bare `"zod"` at all (offline, a registry error), the bundler keeps the
  config's own zod 4 entry external, as before, rather than inline a second
  zod; that fallback decides only the bundle's externals, never what ships or
  is audited.
- The package cache hash covers the config file's text, and also each
  resolution its top-level `imports` would not give (an `importMap` file, a
  scope, a workspace root), so editing an import map file cannot reuse a stale
  archive while every config with plain top-level imports keeps its hash.
- The imports are the ones the dependency audit reads (`scanImportSites`):
  the string literals Babel parses as an import's module specifier (static
  import, side-effect import, `export ... from`, `import()` or
  `typeof import()`), so import text in a comment, string, template or regex
  literal is never rewritten. Push audits every code module it rewrites,
  JavaScript included. A `.tsx` or `.jsx` module is parsed with JSX. A module
  that does not parse is refused before any rewrite is planned. The rewrite and
  the `bare-specifiers` finding come from one plan (`planBareImports`).
- The target is written as Deno reports it, then pinned to the exact version
  the bundle holds, exactly as a specifier written out in source is (see
  "The canonical shipped form" below). A `key/` target
  written `npm:/name@v/` is written `npm:name@v/`, which Deno reads the same and
  the registry's parser reads at all. A zod target the host shares (4.x at the
  root or `/v4`, the same namespace) ships as `npm:zod@4`: zod is never bundled
  or audited, every swamp shares its own, and `npm:zod@4` is the spelling older
  swamp versions externalize when they rebundle a pulled source. Another zod
  subpath (`/v4/core`, `/mini`) has its own exports, ships as the map writes
  it, and is bundled.
- Only `npm:`, `jsr:`, `node:` and `http(s):` targets are written. A target
  that is a local path is a local module edge the plan already places; any
  other bare import ships as written and raises the `bare-specifiers` finding.
- A target the source uses that holds a quote, backslash, backtick, line break
  or `${` fails the push and names the map key. The safety, review and lint
  gates read the source on disk, so the archived copy must hold no code they
  did not see.

In package.json mode (swamp-club#3630) the graph is read with
`--node-modules-dir=manual`, so Deno resolves each bare import to a file in
`node_modules/`. `installedPackageImports` names the package installed
there instead, `npm:<name>@<installed version><subpath>`, read from the
installed package's own `package.json`: the code the bundle inlines, and so
what users of the pulled extension run. The archive ships no `package.json`
or `node_modules/`, so this is the only version a user can get. The installed
manifest is repo-controlled, so it names a package only when its name is a
valid npm name, its version is strict semver, and the name is the package
package.json declares (the `npm:` alias target, when it is one) or, for a
package package.json does not declare, its `node_modules/` directory. So the
specifier push ships and the one the audit checks are always the same
package. Anything else, or a non-registry declaration (`file:`, `link:`,
`workspace:`, git, a URL), ships as written and raises the `bare-specifiers`
finding; a declared package installed under another name (an alias changed
without reinstalling) is a stale tree. The resolution also records the range
package.json declares for the package (`dependencies`, then
`devDependencies`), which the dependency audit reads. Both `npm install` and
`deno install` layouts resolve the same way.

The registry's dependency scan then audits these imports as `npm:`/`jsr:`
specifiers, `deno doc` resolves them so the extension is scored, and a pulled
extension's source rebundles without the author's config.

## Per-Subdirectory Extension Identity

By default, all files under `extensions/<kind>/` form one local extension
aggregate, `@local/<repo-basename>@0.0.0`, or the identity in the top-level
`extensions/manifest.yaml` if present.

If a subdirectory directly under `extensions/<kind>/` has its own
`manifest.yaml` declaring both `name` and `version`, it becomes a separate
aggregate. Its files belong to that identity instead of the default
`@local/<repo>` aggregate. Sibling directories can then hold separately
published extensions:

```
extensions/models/
  foo/
    manifest.yaml    # name: @ns/foo, version: 2026.06.01.1
    instance.ts      → claimed by @ns/foo@2026.06.01.1
  bar/
    manifest.yaml    # name: @ns/bar, version: 2026.06.01.1
    instance.ts      → claimed by @ns/bar@2026.06.01.1
  shared.ts          → claimed by @local/<repo>@0.0.0
```

**Precedence:** a top-level `extensions/manifest.yaml` claims the whole
`extensions/` tree and per-subdirectory manifests are ignored. Per-subdirectory
discovery applies only without one.

### Origin Precedence Enforcement

If a local source and a pulled extension provide the same `(kind, type)`, the
local source wins. The catalog clears the pulled row's `type_normalized`, so the
row no longer occupies the type namespace. This is the same treatment the
catalog gives `ValidationFailed` or `EntryPointUnreadable` states. The pulled
files stay on disk for reference (diffing, version comparison) but are not
registered as active types.

This supports the push/pull development loop: while you edit a local source that
is also pulled from the registry, `extension pull` succeeds and the local types
take precedence. The in-memory registry always worked this way (`load()`
processes local directories first and deduplicates with `hasType()`); the
catalog now matches. That dedupe covers primary types only. Members that
`export const extension` files add to a type follow the rules below.

When the local source is removed, the next loader pass re-activates the pulled
type on its own (see [Stale-source healing](#stale-source-healing)). If two
pulled extensions provide the same `(kind, type)`, the one that already holds
the type keeps it, so pulling another extension never takes a type away. The
loader warns that it chose between them, naming both extensions and the
`swamp extension rm` that switches to the other.

### Extension Member Collisions

Several `export const extension` files can add a member (a method, check or
resource spec) with the same name to one behavior type. Only one of them is
registered, and the winner does not depend on catalog order or on which attach
path ran (swamp-club#2562):

1. A member the base behavior defines always wins.
2. Between extensions, a local source beats a source-mounted one, which beats a
   pulled one. A source is pulled when its path is under
   `<repo>/.swamp/pulled-extensions/` or `<repo>/.swamp/config/pulled-extensions/`
   (`isPulledExtensionPath`, which `resolveOriginConflicts` shares), and
   source-mounted when it is under one of the repository's `mountedSourceDirs`
   (swamp-club#2563). Between two mounted sources the earlier
   `.swamp-sources.yaml` entry wins.
3. Within one tier, the lexicographically smaller canonical path wins, the same
   tie-break as I2.

The behavior kind adapter records which extension contributed each member, along
with the definition it contributed. When a higher-ranked extension attaches
later, whether through a stale rescan, an auto-install, or serve reload,
`ModelRegistry.applyExtensionMembers` replaces the lower-ranked member in one
immutable merge. `extend()` itself still refuses to replace anything. A source
that re-attaches replaces its own members silently. Because the record also
stores the definition object, a member whose current definition is not the
recorded one counts as a base member, which wins. Each collision emits one
`MemberCollision` warning that names both files and the winner, and
`getExtensionMemberCollisions()` exposes the resolved state for
`swamp doctor extensions`. The loser's other members stay registered, so an
extension can end up partly active.

Every attach path (`load()`, `loadSingleType`, and
`attachPendingExtensionsForType`, which the registry's extension attacher also
calls) marks a processed extension attached by source path and fingerprint, so
a later pass does not import it again.

Cold-start indexing defers to rows written by the import-based reconcile. When
`populateCatalogFromDir` finds an indexed row with the same fingerprint, it
keeps that row instead of re-reading the type from source text. That keeps
exports the static extractor cannot read, such as
`export const extension = withOptions(definition)`, from warning on every
catalog rebuild. The cold load before it reuses the same rows' bundles: a local
source whose indexed row names its bundle at the current fingerprint, with its
module graph recorded, is imported from that bundle rather than bundled again.
So a repository's first command bundles each local extension once, in
reconcile, and a stale-lock warning prints once (swamp-club#3869).

The static extractor only reads a declaration that sits in code. An
`export const model = { type: ... }` inside a string, template literal or
comment is test-fixture text, not a type claim. The scanner also recognises
regex literals, so a backtick or `/*` inside one does not hide the code after
it. This matters for pulled and source-mounted directories, which walk
`_test.ts` files on purpose so a behavior named `docker_image_test.ts` still
loads. Before this rule, two fixtures naming one type produced two catalog rows
with no extension identity. Every later catalog save, such as an unrelated
`swamp extension pull`, then failed I-Repo-1 (swamp-club#2876).

The scanner only decides what the source-text index reads. It never stops a
source from being imported. The warm scan treats every source without a row as
stale and imports it. When that import finds no export, the catalog records the
source's fingerprint as having none (`no-export:<kind>:<path>` in
`bundle_meta`). Later scans skip it until the source changes, so a fixture
costs one bundle and import per edit rather than per command. Only a bundle
built from the current source is recorded. A cached bundle may predate an
export added since.

Opening the catalog heals rows a pre-fix binary left behind. It only considers
rows already in the broken state: Indexed, outside a pulled extension, with no
extension identity, and claiming a non-extension type that another live row
also claims. It deletes those whose source declares no export of the row's kind
in code. With no duplicate claims this is a single query, so it runs on every
open. A real declaration the scanner misreads can only cost a row that was
blocking every save, and the warm scan imports the source and writes the row
back.

The lookup also finds a row written under another spelling of the same file.
Reaching the repo under a second spelling of its root (`/tmp/r` and
`/private/tmp/r` on macOS) changes the source-dirs fingerprint and forces a
cold rebuild. When the exact lookup misses, the loader matches rows outside its
own spelling of the repo root by symlink-resolved path, in either direction. An
up-to-date match is moved to the current spelling, leaving one row per file, as
the next warm scan would.

## Split Extensions Directory (`--extensions-dir`)

By default, swamp finds local extension sources in `extensions/<kind>/` under
the repository root (`--repo-dir` / `SWAMP_REPO_DIR`). The `--extensions-dir`
flag (or `SWAMP_EXTENSIONS_DIR` env var) moves only the source scanning root;
all data stays at the repository root.

This supports **git worktree** setups where the working tree (code plane) is
separate from the `.swamp/` data directory (data plane):

```
# Main repo has .swamp/ data + original extensions
~/repo/
  .swamp/          ← data, bundles, catalog (data plane)
  .swamp.yaml      ← repo marker
  extensions/models/my-model.ts

# Worktree has its own working copy of extensions
~/repo/trees/feature-branch/
  .swamp.yaml      ← same marker (committed to git)
  extensions/models/my-model.ts      ← modified copy
  extensions/models/new-model.ts     ← worktree-only
```

Usage:

```
SWAMP_REPO_DIR=~/repo \
SWAMP_EXTENSIONS_DIR=~/repo/trees/feature-branch \
  swamp behavior type search my-model
```

### What `--extensions-dir` controls

- Local extension source scanning for all 4 kinds (behaviors, vaults,
  datastores, reports)
- The extensions root that `extension push`, `quality` and `fmt` resolve a
  manifest's typed entries, workflows and skills from: swamp appends the
  configured typed directory (`extensions/models` by default) to it, so the
  flag names the directory that *contains* `extensions/`, not `extensions/`
  itself
- One candidate base for a relative manifest argument (see below)

### The manifest argument

`extension push`, `quality` and `fmt` take a manifest argument, resolved by
`resolveManifestArgument` (`src/cli/resolve_manifest_path.ts`) the same way in
all three (swamp-club#3018, swamp-club#2747):

- An absolute path is used as given. A relative path is tried against
  `--extensions-dir` when set (the flag names the tree the extension lives in,
  and the worktree setup above runs from the main checkout with the flag at
  the worktree, so the current directory must not shadow it), then the current
  directory, then the repo dir, so a path typed from where the author stands
  wins over the repo and scripts that pass repo-relative paths with
  `--repo-dir` keep working.
- A candidate matches when it is a file, or a directory holding
  `manifest.yaml` (then `manifest.yml`, `manifest.json`); the first match wins.
  `swamp extension push extensions/models/x` and
  `swamp extension push extensions/models/x/manifest.yaml` are equivalent.
- Candidates are only ever `stat`ed, so a directory never reaches
  `readTextFile`. A directory without a manifest fails with
  `No manifest.yaml found in <dir>`; a path that exists nowhere fails with
  `Manifest file not found: <argument as typed> (looked in <every candidate>)`.

### Choosing the extensions root without the flag

With no `--extensions-dir`, `resolveExtensionFiles` picks the root
additively, so an existing manifest never packages a different set of files:

1. Infer a root: the nearest directory from the manifest's own directory
   upward that holds an `extensions/` directory or a `.swamp.yaml` marker. For
   a manifest inside the repo the walk stops at the repo dir, so
   `<repo>/extensions/models/x/manifest.yaml` yields the repo dir; outside the
   repo it falls back to the manifest's directory. The home directory is never
   a root, and a home skill directory is never a skill candidate.
2. If the inferred root is the repo dir, nothing changes.
3. Otherwise probe every typed entry under both bases. An entry present under
   both at different real paths is an error naming both paths and the flag.
   If any entry resolves under the repo dir, the repo dir stays the root
   (as today). Only a manifest that resolves nothing under the repo
   dir moves to the inferred root.

The `deno.json` / `package.json` walk up from the manifest stops at the repo
dir for a manifest inside the repo, as it always has, and at the extensions
root that contains a manifest outside the repo (`projectConfigBoundary`), never
above the tree the manifest belongs to.

This is what lets `swamp extension push ~/sc/swamp-extensions/kubernetes` work
from any swamp repo, and lets a monorepo of sub-directory extensions push each
one from its root, while a repo that also keeps a copy of a sub-directory's
behavior at `<repo>/extensions/models/` fails loudly instead of silently
packaging the repo copy.

Every not-found error from the resolver prints the path or paths it looked in
and ends with the fix: `--extensions-dir <dir>` naming the directory that
contains `<typed dir>/<entry>`, or `paths.base: manifest`; when the entry sits
next to the manifest, the error says so.

### What stays at `--repo-dir`

- `.swamp/` data directory (outputs, data artifacts, workflow runs)
- Extension catalog (`_extension_catalog.db`)
- Bundle cache (`.swamp/bundles/`)
- Pulled extensions (`.swamp/pulled-extensions/`)
- Behavior definitions (`models/<type>/<id>.yaml`)
- Lockfiles and secrets

### Validation

The CLI rejects an `--extensions-dir` inside `.swamp/`, so data-plane files are
never read as extension sources. The path must be an existing directory.

## Adversarial Review Directory (`SWAMP_EXTENSION_REVIEW_DIR`)

The adversarial review gate in `swamp extension push` looks for a report tied to
the content hash at `<base>/swamp-extension-review/<name>-<hash>.json`. By
default `<base>` is the OS temp directory (`TMPDIR` / `TMP` / `TEMP` / `/tmp`),
which is fine locally but does not persist on CI runners.

`SWAMP_EXTENSION_REVIEW_DIR` overrides the base, so CI can keep reports in a
repo-local path that persists across runners:

```yaml
# GitHub Actions example
env:
  SWAMP_EXTENSION_REVIEW_DIR: ${{ github.workspace }}/.swamp-reviews

steps:
  - uses: actions/checkout@v4
  - run: swamp extension push extensions/my-ext/manifest.yaml --yes
```

Precedence: `SWAMP_EXTENSION_REVIEW_DIR` > `TMPDIR` > `TMP` > `TEMP` > `/tmp`.
The `baseTmpDir` parameter on `reviewReportPath()`, used by tests, overrides all
env vars.

### Push confirmation and warning acceptance

`swamp extension push` asks one question on the way to a publish: whether the
safety and review warnings, and any unaudited dependencies, it found are
acceptable and the push should happen.
`--yes` (and its alias `--force`) answers it, in every mode:

- Interactive runs prompt once for the warnings and once for the push.
- `--yes` skips both prompts. The dry-run and completed summaries, in log and
  JSON, then record which warnings it waived (`acceptedWarnings`; the log
  header names the flag), so the audit trail shows what was accepted rather
  than a silent pass.
- A `--json` run without `--yes` never prompts and never refuses. A dry run
  never prompts either: it performs no push and so has nothing to confirm.
- A log-mode run without a terminal and without `--yes` fails in the prompt,
  whose error names the flag.

Dependency trust warnings that carry a `cause` (unaudited dependencies, see
[Not audited](#not-audited), and the shipped-version findings, see
[The version that ships](#the-version-that-ships)) are gated like the safety
and review warnings and recorded under `acceptedWarnings.dependencyTrust`, a
list present only when there is at least one. The other advisory warnings (the
rest of dependency trust, version drift, missing upgrade entries) never gate a
push and are outside the record.

History: swamp 20261005.154947.0 (issue #3015) split the two consents, made
`--accept-warnings` the only waiver and had non-interactive runs refuse
without it. Nearly every clean-runner publish carries at least one warning, so
every external CI publish on the stable channel failed on its next run, and
issue #3047 restored `--yes` the same day and removed `--accept-warnings`
rather than keep an alias. The accountability gain, the `acceptedWarnings`
record, stayed. Any future tightening of `--yes` is decided after declared
acceptances (below, #3021) have landed, with a deprecation window.

### Declared acceptances

A waiver covers a run; an acceptance covers one finding, for good, where the
finding is, with a reason, and is reviewed with the code. The rule catalog
(`src/domain/extensions/extension_rule_catalog.ts`) is the single source of
truth for every rule id a safety or review finding carries, its severity
class, its scope (site, file or extension), its remediation text and whether
it can be accepted at all: error-level rules, the adversarial-review family
(evidence, not a lint; #3065) and the acceptance meta rules never can, and an
unknown id never can. A test cross-checks the catalog against the detectors.

Every finding carries `ruleId`, `file`, a 1-based `line` when it has one and
`remediation`; the four safety warnings are one finding per offending line.
That identity (file, rule, line) is what an acceptance names, so a
rule-wide or file-wide acceptance of a site-scoped rule is not expressible.

- **Inline directive** (`src/domain/extensions/extension_acceptances.ts`):
  `// swamp-quality-ignore <rule-id>`, with an optional `: <reason>`, on the
  finding's line or the line directly above, or `<!-- … -->` on the line above in Markdown; the
  same comment anywhere in a file accepts the file-scoped
  `testing-completeness`. In source the parser reads directives from the
  comments Babel finds, so the keyword inside a string, template or regex
  literal is never a directive, and a quote in an earlier comment cannot
  hide one (swamp-club#3846, swamp-club#3153); every directive in a source
  file that does not parse is a blocking `invalid-acceptance`, since there
  a comment cannot be told from a string. Markdown is read line by line.
  The review rules strip comments, and the safety checks scan every source
  line as written, so nothing can hide behind a directive, on push or on
  pull. A directive's reason, when given, may not contain `Deno.Command(` or
  a base64 run, so a directive cannot trigger the rule it accepts; a quote
  is allowed, since it sits in a comment the parser found. Only the
  long-line count discounts the directive's own text (at most about 230
  characters; in Markdown never a span holding a quote), using the same
  directive spans as the parser (`directiveSpans`). A standalone directive targets the next
  line, or the one after a single blank line, so a formatter's blank line
  after an HTML comment is harmless; stacked directives share a target.
  Directive text inside a Markdown fenced code block or a source `/* ... */`
  block is documentation and is not parsed. Text after the rule id with no
  colon, an unknown, error-level or otherwise non-acceptable
  rule (with its remediation), an extension-scoped rule, a `//` directive inside a block comment that closes on its line (which would
  hide code from the safety scan), or more than 50 directives in a file is a
  blocking `invalid-acceptance` finding naming the comment; reasons are
  capped at 200 characters and rejected, never truncated.
- **Sidecar** (`src/domain/extensions/extension_quality_sidecar.ts`):
  `quality.yaml` beside `manifest.yaml`, discovered by location only (most
  manifests are regenerated and the manifest schema drops unknown keys
  silently), strict schema, version 1; an entry's `reason` is optional. It
  carries extension-scoped
  acceptances (no catalog rule is one today: `bare-specifiers` is not
  acceptable, since the registry cannot score the extension however it is
  justified), a site rule for a `.txt` file or `manifest.yaml` (no comment form; file-wide, contained in the manifest's directory),
  a site rule on one line of a Markdown file (`file` plus `line`, for a line
  inside a fenced code block, where an HTML comment would render as part of
  the block; swamp-club#3757) and the `generated`
  declaration `{ by, source, commit }` agreed with #3065, which accepts
  `testing-completeness` for the package; a file entry names a site-scoped
  rule in a file with no comment form, or in Markdown with a `line`, never a
  file-scoped one. When any finding in a Markdown file sits where no comment
  can go, the report offers line entries for every finding in that file and
  no comments, so applying them all moves no named line. It joins the content
  hash when present (an extension without one keeps its hash), so a changed
  acceptance moves the hash and the review-report path, and is packaged at
  the archive root. A malformed sidecar blocks before any gate.
  Pull does not copy it: a pulled extension cannot be re-pushed, and the
  registry holds the acceptances.
- **One pass, shared** (`runQualityFindings` in
  `src/libswamp/extensions/push.ts`): push runs it at stage 10b and
  `swamp extension quality` on every run including a cache hit. The review
  rules, the bare-specifier check, the `uncatalogued-model` check and
  `applyAcceptances` (pure, property-tested: accepted plus remaining is
  exactly the input) produce the
  unaccepted findings the warnings gate counts, the `stale-acceptance`
  warning for each directive that matches nothing, and the acceptances with
  their reasons. `testing-completeness` is accepted per file first, then
  the remaining findings collapse to one per extension carrying the files.
- **Uncatalogued behaviors** (`modelCatalogGap` in
  `src/domain/extensions/model_catalog_gap.ts`): the push content metadata reads
  a behavior's `type` and `version` as string literals from a plain `export
  const model = { ... }` or `export const behavior = { ... }` object and
  silently leaves out any entry point where either is unreadable, so the
  registry ships the bundle but lists no behavior type. `modelCatalogGap` says
  why, built on the same extractors and property-tested to agree with them, and
  `runQualityFindings` reports one file-scoped `uncatalogued-model` warning per
  such entry point. It is not acceptable. Like any unaccepted warning it prompts
  an interactive push, but it changes no extractor and no error gate: the
  extractors stay as they are, since the version-drift and upgrade-chain checks
  read the same version (swamp-club#2486).
- **Reporting.** The dry-run, completed and quality summaries close with
  `Accepted warnings:` and `Unresolved warnings:` (each warning neither fixed
  nor accepted, with its remediation and one line saying how to accept it).
  In JSON they are `declaredAcceptances` and `unresolvedWarnings` beside
  `acceptedWarnings`, built from the gated warnings, not the waiver record, so
  a `--json` run, a dry run and an interactive "y" all get them. Each
  unresolved warning, and each finding in the JSON `warnings` lists, carries
  an `Acceptance` value (`acceptanceFor` in `extension_acceptances.ts`)
  describing the edit, so an agent applies it without parsing prose: a
  comment `{ form, file, line, position, text }` with `position`
  `line-above` (a new line above the finding, so several findings on one
  line each take a stacked directive; `text` is the whole line, indented
  like the finding's line so the file stays formatted) or `file-header`
  (file-scoped, `line` 1), or a sidecar `{ form, file, entry: { rule, file? } }` naming one entry
  for the `accept` list, so any number of them merge into one valid
  `quality.yaml`. No acceptance carries a reason. There is none for a
  finding the sidecar could not name (a `.txt` file outside the manifest's
  directory), a collapsed finding (each listed file takes its own), or a
  line a comment cannot go above: `commentSites` (computed in
  `runQualityFindings` for each warned line) leaves out the lines that begin
  inside a multi-line string, template literal or block comment (Babel
  tokens), a Markdown fence or a multi-line HTML comment, any line the
  directive parser would not read a comment above (it is the judge, so an
  offered acceptance always takes effect), and every line of a source file
  that does not parse, since there a comment would be ignored or would
  change the string. Log mode prints `cannot be accepted here` under such a
  warning.
  JSON paths are
  absolute (the report is local output, never computed for another machine);
  `entry.file` is manifest-relative because it is written into the sidecar,
  and log mode prints paths openable from the current directory. The
  acceptances travel to the registry in `contentMetadata.acceptances`
  (stored by swamp-club#3095), `reason` omitted when none was given, with
  files by their archive path (`models/x.ts`, `vaults/v.ts`), never a local
  one. The registry returns them as `latestVersionDetail.acceptances`
  (`null` when the version declared none; at most 500 entries, with `total`
  counting every entry sent), and `swamp extension info` shows them to the
  installer: `parseRegistryAcceptances`
  (`src/domain/extensions/registry_acceptances.ts`) turns the registry's
  nulls into absent fields, drops malformed entries and keeps at most 500,
  and log mode prints an `Accepted warnings:` block in push's line format
  (archive paths, control characters escaped, `and N more` when `total`
  exceeds the entries returned). The renderer reads them only through that
  parser, so data relayed by a remote serve is checked too. In `--json` they
  are `contentMetadata.acceptances`, absent when there are none, so a
  registry that predates swamp-club#3095 changes nothing.

## Dependencies

Extensions can depend on other extensions. On pull, missing dependencies are
pulled automatically.

### Dependency Resolution

- The manifest lists dependencies by scoped name (e.g., `@keeb/network`).
- Each is checked against `upstream_extensions.json` and pulled recursively if
  not installed.
- Recursion stops at depth 10 to prevent circular dependency loops.
- An `alreadyPulled` set tracks extensions visited in one pull session to avoid
  repeat work.

### Workflow Dependency Resolution

During push, the CLI also finds the behaviors a workflow references. It parses
workflow YAML for `model_method` and `workflow` step tasks and looks up the
behavior source files. Only user-collective behaviors (types starting with `@`)
are bundled; built-in behaviors are skipped.

## Automatic Resolution

Extensions from trusted collectives resolve on first use, without a manual
`extension pull`. When swamp meets an unknown behavior type from a trusted
collective, it searches the registry, installs the extension, hot-loads it and
carries on.

### Trusted Collectives

By default only the first-party `swamp` collective is trusted, so `@swamp/*`
extensions auto-resolve with no configuration.

Default trusted collectives: `["swamp"]`.

**Membership collectives are not trusted automatically** (swamp-club#465).
Membership lets you publish to a collective; it does not grant install consent
on the consumer side. A compromised or careless member's publish must
not be able to run code in every repo that uses the collective's types. Trust a
collective yourself:

```bash
swamp extension trust add myorg
```

which records it in `trustedCollectives` in `.swamp.yaml`:

```yaml
trustedCollectives:
  - swamp
  - myorg
```

Membership collectives are cached in `auth.json` during `auth login` and
`auth whoami`. `trustMemberCollectives: true` trusts every collective you
belong to (the old default); prefer trusting them one by one. Set
`trustedCollectives` to `[]` to turn off automatic resolution.

A trusted collective's extensions auto-resolve, but the installed version is
**pinned to the committed lockfile** (see
[Version pinning on auto-resolve](#version-pinning-on-auto-resolve) below). So a
trusted collective still cannot silently push an updated version into a repo.

#### CLI Management

Manage trusted collectives with the `swamp extension trust` commands:

```bash
swamp extension trust list                # Show explicit, membership, and resolved collectives
swamp extension trust add <collective>    # Add a collective to the trusted list
swamp extension trust rm <collective>     # Remove a collective from the trusted list
swamp extension trust auto-trust <on|off> # Opt in/out of trusting all membership collectives
```

`auto-trust` also accepts `true`/`enable` and `false`/`disable`
(`src/cli/commands/extension_trust_auto_trust.ts`).

### Version pinning on auto-resolve

If the extension already has an entry in the committed
`upstream_extensions.json` lockfile, auto-resolve installs the **pinned
version** and checks the download against the recorded **checksum**, instead of
fetching the latest (swamp-club#465). This is the same integrity-checked path
`swamp extension install` uses.

This matters on a fresh checkout, where `.swamp/pulled-extensions/` is
gitignored but the lockfile is committed. Without pinning, the first reference
to a type would silently fetch the latest version, letting a trusted collective
push an unreviewed update into the repo. Moving to a newer version takes an
explicit `swamp extension pull` / `swamp extension update`. If the checksum no
longer matches the registry (content drift), the install fails with guidance
instead of installing the changed bytes.

The first resolve (no lockfile entry yet) installs the latest version and
writes the entry, which then pins later resolves.

### Resolution Algorithm

1. **Local registry**: is the type already registered locally?
2. **Direct lookup**: try the full type as an extension name, then strip
   trailing segments for shorter candidates (e.g., `@swamp/aws/ec2/instance` →
   `@swamp/aws/ec2/instance` → `@swamp/aws/ec2` → `@swamp/aws`). For
   two-segment types like `@keeb/mongodb-datastore`, the full type is the only
   candidate; stripping more would leave a bare collective.
3. **Search fallback**: otherwise, search the type's collective and take the
   highest-ranked of the top 5 results whose latest version's published metadata
   lists the type among its behaviors, vaults, datastores or webhooks. Search
   ranks by words, so an unchecked hit can be unrelated (a made-up type once
   installed `@swamp/gcp/realtimebidding`). When no result lists the type,
   resolution reports not-found and installs nothing (swamp-club#3246).

### Safety: never overwrite on-disk extensions

Auto-resolution never overwrites an extension already on disk. If it is present
but its type failed to register, the problem is local, often a syntax error in
the user's unfinished edit, and a silent force-pull would destroy that work.

The resolver puts the pulled tree in one of four states, which decide what
auto-resolve does:

- **Missing**: no entry in `upstream_extensions.json`, or the directory
  `.swamp/pulled-extensions/<name>/` is absent and no source files the lockfile
  lists remain on disk. A clean install goes ahead. If the type still is not
  registered after the install hot-loads, the resolver reports
  `installedWithoutType` rather than success: a direct candidate is matched by
  name alone (swamp-club#3246).
- **Intact**: the lockfile entry, the directory and every file the lockfile
  lists are present. The resolver then checks the extension catalog for a
  failed source (`BundleBuildFailed`, `ValidationFailed` or
  `EntryPointUnreadable`) under the extension's directory, matched by path.
  - If one failed, or the catalog is unavailable, the failure is local. The
    resolver reports `alreadyInstalledButFailed` with the install path and the
    `--force` recovery command.
  - If none failed, the extension loaded but does not provide the type, usually
    because the installed version predates it (swamp-club#2476). The resolver
    reports `installedWithoutType`. When the registry has a newer CalVer
    version, it names that version and `swamp extension update <name>`. In JSON
    mode the event has `reason: "type_not_provided"` with `installedVersion`
    and `newerVersion`.
- **Truncated**: the lockfile entry and directory exist, but some listed files
  are missing (swamp-club#133). This "present but incomplete" state used to
  cause misleading `Unknown <kind> type` errors later. The resolver now reports
  `alreadyInstalledTruncated` naming the missing files, exits with an error, and
  does not try to repair. In JSON mode the event shape is:
  ```json
  {
    "event": "auto_resolve",
    "status": "failed",
    "extension": "...",
    "path": "...",
    "reason": "truncated",
    "missing": ["..."]
  }
  ```
- **Legacy**: the per-extension directory is absent, but source files the
  lockfile declares remain at older locations. Auto-resolution reports this and
  leaves the files alone. Run `swamp extension pull <name>` to accept the
  migration. A skill dir the entry records never counts: skill dirs are
  current-layout wherever they are (see below). With only a skill dir left, the
  state is missing and the install proceeds. It writes the skill back into the
  dirs the entry records, so the entry keeps its skill paths and none are
  pruned. An install with no recorded skill dir puts skills in
  `.swamp/pulled-extensions/skills/`, and so do the dependencies an install
  pulls in, since dependencies merge into existing skill dirs without a
  conflict (swamp-club#3727).

"Intact-but-fails" and "truncated" share one recovery,
`swamp extension pull <name> --force`, the only way auto-installation state can
overwrite a pulled extension. Legacy state needs an explicit
`swamp extension pull <name>` migration. No auto-resolve, validate or run
command will overwrite local edits, silently re-fetch a broken tree, or migrate
legacy files.

Truncation is checked per file: any file in the extension's lockfile entry that
cannot be stat'd. Only presence is checked, not contents.

Paths under `.swamp/bundles/`, `.swamp/vault-bundles/`,
`.swamp/datastore-bundles/` and `.swamp/report-bundles/` are excluded. They are
regenerable build artifacts, and clearing the bundle cache is routine. It must
not flip an extension with intact source into the truncated branch, which would
take over the user-WIP path from issue #121. Only source files in
`.swamp/pulled-extensions/<name>/` count.

### Hot-Loading

After installing, swamp re-runs behavior and vault discovery with
`skipAlreadyRegistered`, so only the new types load and types from startup are
not registered twice.

Hot-loading also re-attaches user extensions under `extensions/models/` that
`extend` a newly installed base type. The installer walks the catalog's
extension rows and calls the extension-attach primitive for each base that is
now fully registered. A user extension targeting `@swamp/aws/ec2/instance`
works as soon as auto-resolve pulls `@swamp/aws`, with no separate command.

### Re-Entrancy Guard

A process runs one auto-resolution per type at a time. A caller that asks for
a type already being resolved, for example a second `swamp serve` request,
waits for that resolution and gets its result; the `@`-prefixed and bare
spellings of a type count as one. A call made from inside a running
resolution is refused at once instead, which prevents infinite loops and never
waits on the install lock the caller's own chain holds (swamp-club#3911).

### Architecture

`ExtensionAutoResolver` is a domain service with port interfaces. CLI-layer
adapters implement registry access, extension installation and behavior/vault
discovery.

### Output

Auto-resolution always prints status: searching, installing, and a confirmation
with the number of behaviors the extension has registered, counted from its
catalog rows, so a caller that adopts an install another caller already loaded
still reports the extension's full count (swamp-club#3911).

## Safety

Every TypeScript file in an extension is checked before push and after pull.

### Hard Errors (block push/pull)

- Hidden files (names starting with `.`)
- File extensions other than `.ts`, `.json`, `.md`, `.yaml`, `.yml` and `.txt`.
  Files declared in `binaries` are exempt, as are the extensionless legal
  basenames in `LEGAL_BASENAMES` (`AUTHORS`, `CONTRIBUTORS`, `COPYING`,
  `COPYING-EXCEPTION`, `LICENSE`, `NOTICE`, `PATENTS`;
  `src/domain/extensions/extension_safety_analyzer.ts`).
- Symlinks
- A single file over 1 MB
- Total extension size over 10 MB
- More than 150 files
- Dynamic code execution (code injection): the global `eval` in any form, the
  `Function` constructor, `.constructor(...)` calls, and any member access
  named `eval` or `Function` (`x.eval(...)`), because the receiver may be the
  global object and no static check can rule that out. The source is parsed
  with `@babel/parser` and the rules apply to the syntax tree, so method and
  property *definitions* named `eval`, TypeScript types, and text in strings,
  comments and regexes do not count
  (`src/domain/extensions/dynamic_code_detector.ts`). A file that does not
  parse falls back to the plain text check for `eval(` and `new Function(`.
  Not caught: names assembled at runtime, a `.constructor` stored before it is
  called (`const F = fn.constructor; F(src)`), and `new x.constructor(...)`
  when `x` is not a function or class literal. The check is a hygiene gate,
  not a sandbox.

### Warnings (prompt user)

One finding per offending line, each with a rule id, so each can be declared
acceptable on its own (see Declared acceptances):

- `long-line`: a line with more than 500 non-whitespace characters
- `base64-run`: a run of 100+ consecutive base64 characters
- `deno-command`: a use of `Deno.Command` (subprocess spawning), read from the
  syntax tree, so comments and strings never count. It flags `Command` read off
  `Deno` in any spelling (`Deno.Command`, `Deno["Command"]`, through casts or a
  global object, `import C = Deno.Command`) and `Deno` itself used as a value,
  since an alias reaches `Command` (`const d = Deno`, destructuring from `Deno`,
  passing it, `Deno[key]` with a non-literal key). A member named `Command` on
  any other object is not flagged, but `Command` read off a member named `Deno`
  on any receiver is (`g.Deno.Command`, `this.Deno.Command`). Not caught: other
  uses of an alias of the global object (`const d = g.Deno; new d.Command()`, or
  a parameter pattern given it, `(({ Deno: d }) => ...)(globalThis)`) and names
  assembled at runtime. A file that does not parse falls back to the old text check
  (`Deno.Command(` on the line). Other process APIs (`node:child_process`) are
  not covered by this rule (swamp-club#3169).
- `ipv4-address-literals`: IPv4 address literals in `.md` and `.txt` files
  outside the RFC 5737 documentation, loopback and link-local ranges (found by
  the extensible content rule framework)
- `secret-unsafe-docs` (`@swamp-club/extension-scoring/secret-docs`, appended
  in `runQualityFindings`): docs that put a secret in plaintext or reference a
  vault with syntax swamp does not resolve. The shared selector picks the files
  from the archive push builds: Markdown that is not a binary, an include file
  or data a module imports (fenced code for all patterns, prose for credential
  shapes only), the describe strings of every non-test code module, and the
  manifest's parsed `description`, reported on its `description:` line. A
  secret argument is one a schema (`extensions:` methods included) marks
  sensitive, or an undeclared name that reads as a secret. Linear-time
  patterns, a line-length cap and file caps (1 MiB, 10,000 files; unread
  documentation fails the factor and cannot be accepted), since the registry
  runs the same check on archives it did not author. An unaccepted finding
  loses the `secret-safe-docs` point (swamp-club#3757)

### Binaries

The `binaries` manifest field declares executable host helpers. They skip the
file-extension allowlist but get every other check (hidden files, symlinks, size
limits, file count). On POSIX systems, executable mode bits survive publish and
pull.

On pull, the CLI warns the user to inspect declared binaries before use. The
list is also sent to swamp-club as push metadata for display on extension pages.

### Integrity Verification

Archives are verified with SHA-256 checksums, computed at push and stored in the
registry. Pull checks the downloaded archive against it. Legacy extensions from
before checksum support are marked "unverified" but still allowed.

### Archive Size Limits

Two limits in `src/domain/extensions/extension_archive_limits.ts` bound every
extension archive:

| Limit                                      | Value   | Bounds                                            |
| ------------------------------------------ | ------- | ------------------------------------------------- |
| `MAX_EXTENSION_ARCHIVE_BYTES`              | 50 MiB  | The compressed `.tar.gz`                          |
| `MAX_EXTENSION_ARCHIVE_DECOMPRESSED_BYTES` | 500 MiB | One decompressed read pass (tar headers + bodies) |

The compressed limit is enforced three times. The registry download counts
bytes as they arrive, and refuses an oversize `Content-Length` before reading
anything. `installExtension` checks it again before verifying checksums or
writing to the temp dir, so every download source is bounded, not just HTTP.
Push checks it in `extensionPushPrepare`, so `extension push`, `--dry-run` and
`extension quality` (when it packages a fresh archive) report an archive that
consumers could not download. Push does not check the decompressed limit.

The decompressed limit is a byte-counting stream placed right after gunzip in
`listTarGzEntries` and `extractTarGz`. The listing pass and the extract pass
each count separately, and going over the limit aborts either pass with
`ArchiveSizeLimitError`. This stops a small archive that expands to gigabytes
(a gzip bomb) from filling the temp dir.

Both values match the registry scoring analyzer's ceilings. The registry
enforces no size limit at publish time, so any archive the registry can score
still installs.

## Runtime Permissions

Extension methods run inside the host Deno process (via
`InProcessExecutor`) and share the permissions compiled into the binary. The
binary uses individually scoped flags, not `--allow-all`, to keep privileges
minimal and avoid auto-granting future Deno permission categories:

| Flag            | Grants                                     |
| --------------- | ------------------------------------------ |
| `--allow-read`  | Filesystem reads (regular files)           |
| `--allow-write` | Filesystem writes (regular files)          |
| `--allow-env`   | Environment variable access                |
| `--allow-run`   | Subprocess spawning (`Deno.Command`)       |
| `--allow-sys`   | System info (hostname, OS, memory)         |
| `--allow-net`   | Network access (HTTP, TCP, UDP)            |
| `--allow-ffi`   | Foreign function interface (libc `getrlimit`/`setrlimit` for fd-limit raising at serve startup; libc and libproc for the auth gate's nested-run ancestry check; libc for the `/proc` reads that find a deferred write whose process died) |

`scripts/compile.ts` has the authoritative flag list.

### Device Node I/O

`Deno.open()` on character or block device nodes (e.g., `/dev/ttyUSB0`,
`/dev/spidev0.0`) fails in the compiled binary. Deno compiled binaries need
`--allow-all` for device nodes, even with `--allow-read` and `--allow-write`.
This is a Deno limitation, not a swamp one.

For hardware I/O, spawn a subprocess with `Deno.Command`, which `--allow-run`
permits:

```typescript
// Read from a serial device using cat
const cmd = new Deno.Command("cat", { args: ["/dev/ttyUSB0"], stdout: "piped" });
const { stdout } = await cmd.output();
const data = new TextDecoder().decode(stdout);

// Write to a serial device using dd
const write = new Deno.Command("dd", {
  args: ["of=/dev/ttyUSB0"],
  stdin: "piped",
});
const child = write.spawn();
const writer = child.stdin.getWriter();
await writer.write(new TextEncoder().encode("AT\r\n"));
await writer.close();
await child.status;

// Configure a serial port using stty
const stty = new Deno.Command("stty", {
  args: ["-F", "/dev/ttyUSB0", "115200", "cs8", "-cstopb", "-parenb"],
});
await stty.output();
```

Remote workers run bundles in-process with the same permissions as the CLI, so
this applies on every execution path.

## Dependency Trust Audit

During the push prepare phase, source files are scanned for `npm:` and `jsr:`
import specifiers. Each npm dependency is checked against trust gates adapted
from `@bixu/wheelshop`:

### Hard Errors (block push)

- Deprecated packages
- HIGH, CRITICAL or UNKNOWN severity vulnerabilities (via OSV.dev)

### Warnings (shown but don't block)

- MEDIUM severity vulnerabilities
- License not in the allowlist (MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD,
  MPL-2.0, Unlicense, CC0-1.0)
- No maintainers listed
- Weekly downloads below 1,000
- Last publish more than 24 months ago

### The canonical shipped form

Since swamp-club#3970, every `npm:` and `jsr:` import in an archive's source
names the exact version its bundle holds: `npm:<name>@<x.y.z>[/subpath]` or
`jsr:@<scope>/<name>@<x.y.z>[/subpath]`, plain semver, with no `^`, `~`, `=`,
`v`, dist-tag or missing version. zod is the one exception: the host provides
it, so a zod import ships as written and is never audited. Authors keep
writing ranges, dist-tags, unpinned imports, import-map names and package.json
dependencies; push pins each import site in the archived copy, at its exact
span, beside the relative and bare-import rewrites above
(`dependency_resolution/canonical_form.ts`). The bundle is not touched.

- The version comes from the module graph the bundle is built from: the same
  `deno info` read, with the bundle's flags (`--frozen` against the lock, or
  `--no-lock`), reports each `npm:` and `jsr:` specifier's exact version in
  `redirects` and each npm dependency's `npmPackage`
  (`dependency_resolution/package_versions.ts`). An `npm:` import or an
  import-map target that Deno reads from `node_modules/` is pinned to the
  installed copy's version, read from its `package.json`. So the shipped
  specifier, the bundle and the audit read one answer.
- Every site kind is pinned: static, side-effect, dynamic and type imports,
  and re-exports. A site the graph gives no exact version for refuses the
  push, naming the import, so a range can never ship. Before writing the
  archive, push checks every `npm:`/`jsr:` import its source writes with the
  shared `canonicalShippedSpecifierIssue`; a failure there is a bug in push.
- No `deno.json`, `deno.jsonc`, `deno.lock`, `package.json`,
  `package-lock.json`, `.npmrc` or anything under `node_modules/` ships, from
  a kind directory, an include or `additionalFiles`. Push leaves each out
  before any gate runs, drops it from the manifest's `additionalFiles`, and
  warns with `archive-project-file` naming it. Pull refuses such files, and
  the pinned source needs none.
- A consumer rebuild of pulled source (the loader's rebundle and recovery of
  a missing bundle, serve hot-reload, a worker's self-contained bundle) runs
  `deno bundle` with `--no-config` and never looks a config up, so a
  `deno.json` in or above the consumer's repository cannot apply its import
  map to pulled source. Local extensions and push keep finding their own
  config.
- Code from outside npm and JSR still ships as it does today, inlined in the
  bundle: URL imports (with every module fetched through them) and
  package.json dependencies installed from a path, a workspace or git. The
  record lists each under `unaudited` (below).

### The version that ships

Each `npm:` and `jsr:` specifier is audited at the version the push ships
(swamp-club#3352), whether the source writes it out or writes a bare import the
project `deno.json` import map resolves to it (swamp-club#3611), or, in
package.json mode, one that resolves to an installed dependency
(swamp-club#3630). Push hands the audit the version the bundle holds, read from the module
graph as above (`DependencySpecifier.bundled`, swamp-club#3970): an exact pin
as written, an installed package at its installed version, anything else at
the graph's version, from the lock when the bundle was built against one and
from the registry otherwise. The audit then resolves nothing itself, so the
version audited, bundled and shipped is one answer. The chain below is how the
registry, and an audit with no bundled version, resolves a version. The
extractor resolves bare imports as the bundler does: an
exact key, else the longest `key/` prefix, where a key mapped to an `npm:` or
`jsr:` package also covers its subpaths (`"@std/path"` resolves
`@std/path/posix`) unless the map has its own `key/` entry. It reads the map as
JSON, resolves only the bare imports the source uses, and takes only the
module specifiers the module's syntax tree holds (swamp-club#3983), so import
text inside a string, comment, template or regex literal is never audited. These are the same imports push
rewrites to their targets in the shipped source (swamp-club#3637), and the audit
reads every non-test code file the archive ships, JavaScript, include files and
code under `files/` included, as the registry does, so nothing ships as an `npm:`/`jsr:` specifier
unaudited. A package both written out and mapped
at the same specifier is audited once, as the written form. The rules live in
`@swamp-club/extension-scoring/dependency-audit` and run no Deno tooling, so
they outlive the runtime:

1. An exact pin (`1.2.3`, `=1.2.3`, `v1.2.3`) is that version.
2. Otherwise, in package.json mode, the version installed in `node_modules/`
   (swamp-club#3630, `from: "installed"`). The audited specifier is the
   range package.json declares, so a range there raises the loose-specifier
   finding as an import-map range does; the shipped version is the installed
   one, which the bundle inlines whatever `deno.lock` records, so the lock is
   not read for it.
3. Otherwise, the lockfile the bundler honours: the version it records for
   this import's own specifier (Deno may write `^2.0.0` as `npm:ms@2`, so
   equivalent ranges match), else the highest version it records for the
   package that satisfies the specifier. A higher transitive copy never
   overrides the import's own entry. The lockfile is the one the bundler
   uses: with a `deno.json` or `deno.jsonc`, its `lock` setting (read as
   JSONC, swamp-club#3612) or the `deno.lock` beside it; in package.json
   mode, the `deno.lock` there; otherwise none, since the bundler runs with
   `--no-lock`. A config that cannot be parsed reads no lock. The lockfile sits behind the `LockedDependencyVersions` port; the
   Deno adapter (`src/infrastructure/runtime/deno_lockfile_reader.ts`) reads
   lock formats 4 and 5 as data, capped at 16 MiB. A lock entry that no
   longer satisfies the specifier falls through; push itself never gets
   there, because it refuses a stale lock (below).
4. Otherwise, the registry. npm resolves the way the registry's scorecard
   does: a range to the highest published release that satisfies it, a
   dist-tag through `dist-tags`, no version to `latest`. JSR takes the
   highest version that is neither yanked nor a prerelease, falling back to
   a yanked match as Deno does, and `latest` for no version.

Push and quality treat the author's lockfile as read-only
(swamp-club#3613). The module graph read (`deno info`) and the bundle run
with `--frozen` when the project has the lock the bundler honours, and with
`--no-lock` when it has none (`frozenLockPath` in `dependency_resolution/`; a
config that cannot be parsed keeps the `deno.lock` beside it). A lock
that no longer matches the project fails the push with an error naming the
lock, the config and `deno install --entrypoint <file>`, instead of being
rewritten in the author's tree, so the version the audit reads from the lock
is the version that ships. `extension fmt` reads the module graph read-only
too (swamp-club#3717), so `fmt` and `fmt --check` never create or rewrite the
lock push then bundles against. A stale lock does not fail `fmt`: the read is
lenient, so each entry point the lock refused is formatted and linted alone,
and `fmt` warns with the same `deno install --entrypoint` command (and lists
it under `staleLockfiles` in `--json`). `deno fmt` and `deno lint` themselves
never touch the lock. The extension loader, which every command runs at
startup, reads the lock read-only too (swamp-club#3869), so an extension in the
repository's loaded `extensions/` directory keeps its lock wherever fmt, quality
and push read it: its bundle and module graph read run `--frozen` against the
lock the project has and `--no-lock` when it has none. A stale lock does not
stop the extension loading: the loader warns with the same `deno install
--entrypoint` command and bundles with `--no-lock`, leaving the lock unchanged.
`serve` reload and self-contained bundles pass no project config, so they run
`--no-lock`.

The audit summary carries the source text (`specifier`; for a mapped import,
the specifier the map resolves it to), the bare import as written
(`importedAs`, mapped imports only; `extension quality`'s log mode prints it
as `(as "<bare name>")` on the dependency's line), the resolved `version` and
`resolvedFrom` (`exact`, `installed`, `lockfile` or `registry`). Every finding for a
mapped import ends `(imported as "<bare name>" through the project's Deno
config)`, and blocks or
warns exactly as it would written out. npm
license, maintainers and deprecation come from that version's manifest; a
version the packument does not list is not audited. The age warning keeps
the package's latest publish, since it measures maintenance. Each package is
fetched once however many specifiers name it, and OSV is asked once per
shipped version.

| Finding                                  | Severity | Cause                |
| ---------------------------------------- | -------- | -------------------- |
| Shipped and latest both deprecated       | error    | none                 |
| Shipped version deprecated, latest not   | warning  | `deprecated-version` |
| Unpinned, range or dist-tag, no lock     | warning  | `loose-specifier`    |
| Shipped JSR version yanked               | warning  | `jsr-yanked`         |
| JSR package or version missing, bad name | error    | `jsr-missing`        |

The first row keeps its old message, `package is deprecated`. A
`loose-specifier` finding is raised only when no valid lock fixed the version
(swamp-club#3970): pinning exact versions and committing a lock earn the point
alike. A `deno.lock` always counts, since push bundles `--frozen` against it;
a `package-lock.json` counts only when every package the bundle takes from
`node_modules/` (transitive ones included) is the version the lock names
(lockfileVersion 2 or 3), and otherwise is treated as no lock, with a
`package-lock-mismatch` warning naming the first mismatch. The push message
names the fix and the cost: `no lock: ^2 resolved to 2.1.3 today; commit a
lock or pin exact versions (costs 1 point)`. The rule applies to every
archive the registry scores, so a v1 archive whose ranges came from its lock
gets the point back. The exact
wording is pinned by
`vectors/dependency_audit.json` in `@swamp-club/extension-scoring`, which
holds the push and scorecard wording side by side. swamp-club#3354 makes
deprecated pins and loose specifiers errors after a two-week window.

Every finding with a cause carries a `remediation`, and `jsr-yanked` and
`deprecated-version` findings carry a `suggestedVersion` when another stable
version exists (the newest in the shipped version's major, or its minor for
0.x, else the newest overall; yanked, deprecated and prerelease versions never
qualify). When the lockfile chose the shipped version, the remediation also
says to refresh it. The findings report that closes push, dry run and
`extension quality` lists each of them under Unresolved warnings with
`file` `(dependency)` and its remediation as the `fix:` line. The summary
repeats what the Dependency warnings block already printed, on purpose: it is
the recap an author or agent reads. A `not-audited` remediation depends on why
the audit could not run (a lookup outage, an invalid name, a specifier no
published version matches, or an unexpected failure), because a re-run only
helps the first.

### The dependency audit record

Push writes `dependency-audit.json` at the archive root, beside
`manifest.yaml` (swamp-club#3662), so the registry's scorecard
(swamp-club#3778) audits the version that ships rather than re-resolving it.
Since swamp-club#3970 it is `recordVersion: 2`, built from the canonical
shipped form. The rules, writer and reader both, live in
`@swamp-club/extension-scoring/dependency-audit`:

```json
{
  "recordVersion": 2,
  "bundles": { "bundles/m.js": "sha256:…" },
  "dependencies": [
    {
      "registry": "npm", "name": "ms", "spec": "2.1.3", "version": "2.1.3",
      "from": "lockfile", "locked": true, "writtenAs": ["ms", "npm:ms@^2"]
    }
  ],
  "unaudited": [
    {
      "kind": "url", "origin": "https://example.com/x.ts",
      "modules": { "https://example.com/x.ts": "sha256:…" }
    }
  ]
}
```

- `dependencies` holds one entry per shipped package version: `spec` always
  equals `version`, the version every import of it ships pinned to. `from`
  is the weakest source across those imports (`exact`, `lockfile`,
  `installed`, `registry`), `locked` whether a valid lock fixed every one of
  them, and `writtenAs` what the author wrote, sorted: `npm:ms@^2`, or a bare
  `ms` an import map or package.json resolved. A non-exact entry with
  `locked: false` is what costs the loose point. Every version the archive's
  source names is listed, including one the audit did not read (a test
  module the plan places).
- `bundles` maps each bundle file's archive path to the SHA-256 of its bytes,
  so a consumer or the registry can check a bundle is the one published with
  this source (swamp-club#3972 checks it at pull).
- `unaudited` lists code from outside npm and JSR: `kind` `url` (an import a
  local module writes, with every module fetched through it), `package-json`
  (a `file:`, `link:` or `workspace:` dependency) or `git`; `origin` the URL
  or the package.json spec as written; `modules` a SHA-256 of each module the
  bundle holds, keyed by URL or by path from the package.json directory.
  No local absolute path is written.
- Everything is sorted, so the record is the same on every push. It is
  always written, with empty lists when there is nothing to list, so the
  registry can tell such an archive from one that predates the record. It is
  written by the author's machine and trusted as a best effort, as the
  bundles beside it are.
- The package cache hash covers the graph's exact versions, the unaudited
  modules' hashes and whether a package-lock.json counts as a lock, so a
  lockless range that resolves to a new version misses the cache instead of
  reusing an archive pinned to yesterday's.
- A reader that knows only v1 (`parseDependencyAuditRecord`) reads a v2
  record as no record; `parseDependencyAuditRecordV2` reads v2. The registry
  then audits a v2 archive's exact source versions until swamp-club#3973
  reads the record. No swamp version reads the record on the consumer side.
- `dependency-audit.json` is a reserved archive root name. A swamp older
  than the record does not reserve it, so its pull installs the file at the
  extension's install root as a shared source; it is not a resolution
  config, so nothing refuses or reads it.

Archives pushed before swamp-club#3970 carry `recordVersion: 1`: one entry
per `(registry, name, spec)`, where `spec` is what the shipped source wrote
after `@` (a range included), `version` the version the audit checked and
`from` its source. The registry keeps reading those with the v1 rules and
vectors (`record`, `recordEntries`), which are frozen.

### Not audited

A dependency whose npm registry, OSV.dev or JSR lookup fails (an error status,
no network, a timeout, or for JSR a reply that is not JSON or lists no
versions), or whose specifier no published version matches, is **not audited**.
It is never reported as passed: its audit summary has `passed: false`, `cause:
"not-audited"` and a `reason` naming each failed lookup (or `OSV not queried (no
published version matches <spec>)`), and a warning with the same cause joins
`warnings.dependencyTrust`. When npm fails but the specifier is an exact version
or the lockfile resolves it, OSV is still queried, so a HIGH or CRITICAL
vulnerability still blocks; otherwise a range, dist-tag or missing version
cannot be resolved without npm and is not queried. A failed weekly-downloads
lookup alone leaves the dependency audited.

Code the bundles hold from outside npm and JSR (a URL import, a git dependency,
a local package.json dependency; the graph's `unaudited` list, which the v2
record also carries) is not audited either (swamp-club#4018).
`withUnauditedCode` adds one warning per origin, with `dependency` set to the
origin made safe for one line; push's prepare applies it to every run, so
`extension quality` and push charge it as the registry does, through
`scorecardResult`'s `unaudited` parameter. It still ships. Unaudited
dependencies join the push warnings gate (an interactive push prompts; `--yes`
waives them), never block on their own, and never change the exit code.
`DependencyTrustResult.passed` keeps meaning "no blockers".

The summary and the warning both carry `notAuditedFix`, the fix their
remediation gives: `outage` (a failed lookup; re-run), `specifier` (no published
version matches), `name` (an invalid package name), `origin` (code from outside
npm and JSR; replace it with an `npm:` or `jsr:` package), `canonical` (registry
only: a v2 archive whose source breaks the canonical form; push again),
`unexpected` (the audit threw) or `other`. Only an `outage` clears on a re-run,
so `extension quality`'s dependency-trust row and the quality and push
not-audited headers say to re-run only when every unaudited dependency's fix is
`outage`. When `deno doc` fails and its output names nothing (one unpublished
npm version fails all of deno's npm resolution, and deno names whichever import
it was resolving), quality's `docAnalysisError` names the `specifier`
dependencies instead.

### jsr Dependencies

Each jsr package is looked up once at `https://jsr.io/<name>/meta.json` with
`Accept: application/json`; its name is checked locally first and an invalid
one is never fetched. The shipped version must exist (a missing package or
version is an error) and a yanked one warns. OSV has no JSR data, so there is
no vulnerability check, and the npm-specific gates (license, maintainers,
downloads, age) do not apply.

### Quality Rubric Factor

Dependency trust is a rubric factor (`dependency-trust`, worth 2 points) in both
`swamp extension quality` (CLI) and swamp-club's server-side scorer. It scores 2
when every dependency passes the trust gates with no findings, 1 when the only
findings are `loose-specifier` warnings (one point however many), and 0 when
any dependency has a blocker. A blocker is a hard error, a `deprecated-version`
warning (a pinned deprecated version), a `jsr-yanked` warning, or an unaudited
dependency (`not-audited`). Push still only warns on the last four (`--yes`
accepts them); nothing here becomes a push error. `dependencyTrustBlockerCount`
counts the errors, deprecated and yanked warnings; `looseSpecifierCount` counts
the distinct dependencies with a loose specifier. The shared vectors in
`vectors/dependency_audit.json` pin the rule for both scorers.

The registry scores a v2 archive (`recordVersion: 2`) as written
(swamp-club#4018): `canonicalRecordedVersions` turns the record into the
version source, under which `resolveShippedVersion` takes only an exact
specifier the record lists, reading no lock and resolving no range. Any other
`npm:` or `jsr:` specifier (a range, an unlisted version) is not audited with
`canonicalShippedSpecifierIssue`'s message; OSV, deprecation and yank checks
still run on a listed version. The loose point comes from the record: an entry
whose `from` is `registry`, or `installed` without `locked`, costs it under the
non-exact spelling its `writtenAs` keeps. A v1 archive, or one whose record
does not parse, keeps the earlier order (exact, record, lock, registry). The
`canonicalScoring` vectors pin this path.

## Registry

Extensions are distributed through the swamp registry at
`https://swamp-club.com`.

### Authentication

Push needs an API key in the `x-api-key` header
(`src/infrastructure/http/extension_api_client.ts`). Pull does not, but sends
the key when available so private or non-default registries can authorize it
(`src/libswamp/extensions/pull.ts`). Users can push only to their own
collective. `swamp auth login` authenticates to Swamp Club and provides the key.

`swamp extension yank <name> <version>` withdraws a published version from
resolution (`src/libswamp/extensions/yank.ts`). Deprecation, by contrast, leaves
versions pullable.

### Push Protocol

Push has three phases:

1. **Initiate**: `POST /api/v1/extensions/push` declares intent and returns a
   presigned S3 upload URL.
2. **Upload**: `PUT {uploadUrl}` uploads the tar.gz archive straight to S3.
3. **Confirm**: `POST /api/v1/extensions/confirm` finalizes the version.

### Pull Protocol

1. **Resolve**: `GET /api/v1/extensions/{name}` returns metadata and the latest
   version.
2. **Download**: `GET /api/v1/extensions/{name}@{version}/download` follows a
   302 redirect to the archive.
3. **Verify**: `GET /api/v1/extensions/{name}@{version}/checksum` returns the
   SHA-256 checksum.

## Upstream Extensions Tracking

On pull, the extension's metadata and extracted file list are recorded in
`upstream_extensions.json`. By default it lives in the behaviors directory
(`<modelsDir>/upstream_extensions.json`). Repos on managed config keep it at
the datastore's resolved config base: `<path>/config` for a filesystem
datastore, the cache's `config/` for S3 or GCS, with the namespace in front of
`config/` when one is set (`<path>/<namespace>/config`;
`resolveManagedConfigPaths`, `src/cli/repo_context.ts`). On managed config,
pulled sources stay in the repo's `.swamp/config/pulled-extensions` whatever
the datastore; otherwise they live in `.swamp/pulled-extensions`. Until
swamp-club#2495, the auto-resolver in an S3/GCS managed repo records installs
in the in-repo `.swamp/config/upstream_extensions.json` instead, and readers
merge it in read-only (see datastores "Extension commands and the
chicken-and-egg", swamp-club#2483). The file supports clean removal, conflict
detection and **integrity-anchored restore** (see the `checksum` field below).

### Structure

```json
{
  "@keeb/ssh": {
    "version": "2026.02.26.1",
    "pulledAt": "2026-02-27T10:30:00.000Z",
    "checksum": "sha256-…",
    "filesChecksum": "sha256-…",
    "serverUrl": "https://registry.example.com",
    "channel": "rc",
    "files": [
      ".swamp/pulled-extensions/@keeb/ssh/models/ssh/connection.ts",
      ".swamp/pulled-extensions/@keeb/ssh/models/ssh/helpers.ts",
      ".swamp/pulled-extensions/@keeb/ssh/workflows/ssh-check.yaml",
      ".swamp/pulled-extensions/@keeb/ssh/manifest.yaml",
      ".swamp/bundles/<hash>/ssh/connection.js"
    ]
  }
}
```

### Integrity Anchor

Optional fields (`src/infrastructure/persistence/upstream_extensions.ts`):

- `filesChecksum`: a digest of the extracted subtree, so auto-update can detect
  local edits before overwriting.
- `serverUrl`: a non-default registry.
- `channel`: present only for non-stable installs.

Every entry records the archive's SHA-256 at install time (`checksum`). The
lockfile-restore pass (`swamp extension install`, which `swamp repo upgrade`
also runs to migrate legacy layouts) checks the fresh download byte for byte
against it. On mismatch the restore fails loudly with an error that offers a
choice: accept the current registry content (`swamp extension pull <name>`) or
pin an older version. So the lockfile is an integrity manifest as well as a
version record, and restores cannot silently accept changed registry bytes.
Entries from before checksum tracking (pre-commit `f4dfc083`) skip the check.

`swamp extension pull <name>` is how the user opts in to whatever the registry
now serves. Integrity checks apply only to lockfile-restore flows.

### Restore Reconciliation

`swamp extension install` decides per entry whether the disk already matches the
lockfile. File presence is not enough: another version's files may occupy the
per-extension subtree, left by an earlier pull or by `doctor extensions`
repairing a missing type. For each entry whose files are all present at the
current layout, install compares:

1. **Version**: the entry's `version` against the `version` in the installed
   `manifest.yaml` copy. A mismatch re-pulls the pinned version
   (swamp-club#2150). A constraint pin (`>=`, `^`, `~`) has no single version to
   match, and an entry installed before the manifest copy existed has no
   on-disk identity. Both go on to the content check rather than re-pulling on
   every run.
2. **Content**: the subtree digest against `filesChecksum`. This catches a
   lockfile updated through git without a matching re-fetch (swamp-club#1021).
3. **Dependencies**: each dependency the installed `manifest.yaml` declares
   against the lockfile, matched by name. A dependency with no entry re-pulls
   the parent, whose dependency loop installs it. Pull writes a parent's entry
   before installing its dependencies, so a dependency install that fails, or a
   hand-edited lockfile, otherwise leaves the dependency missing on every later
   restore (swamp-club#2646). A dependency that does not parse as an extension
   ref also re-pulls the parent, which then fails that entry. Such a dependency,
   or one the registry no longer serves, re-downloads the parent and reports it
   failed on every restore until the parent's manifest or the registry changes.
   A dependency removed with `extension rm` while a parent still declares it
   (rm warns about such dependents) is reinstalled by the next restore.

`doctor extensions --repair` restores the pinned version for the same reason:
re-pulling the latest would rewrite the entry and silently drop the pin.
Extensions with no lockfile entry have no pin and still resolve latest.

### Concurrency Safety

All changes to `upstream_extensions.json` take an advisory lockfile with
retries (10 attempts, 100ms backoff) and use atomic writes, so concurrent
operations cannot corrupt it. The lock sits next to an in-repo lockfile
(`upstream_extensions.json.lock`). For a managed lockfile it is a sibling file
named exactly `.lock` (`lockfileAdvisoryLockPath`): datastore sync excludes
that name, so a push never uploads it to other checkouts, and every repo or
worktree writing the same lockfile shares it (swamp-club#2838).

That lock covers a single entry write. The rest of an install or removal (the
stage and swap of the extension's roots, the skills copy, orphan pruning, crash
recovery, the catalog save) is serialized per checkout by the
**pulled-extensions lock**
(`src/infrastructure/persistence/pulled_extensions_lock.ts`, swamp-club#2709).
Without it, two installs, or an install and an `extension rm`, can leave a mix
of two versions' files, prune files the other just wrote, or record an entry
that does not match the tree.

A section takes two layers: an in-process first-come-first-served mutex keyed
by the checkout, so concurrent `swamp serve` requests queue without polling,
then a `FileLock` on `.swamp/pulled-extensions.lock` for other processes. Its
TTL (30s) and heartbeat clear a crashed holder. A waiter's 180s budget covers
both layers: time queued behind a section in its own process, then time waiting
for another process's file lock. Past it, the waiter gets a `LockTimeoutError`
naming the lock file (and, when another process holds it, that holder). A
waiter that times out gives up its place in the queue without blocking the
sections behind it. `tryWithLock` reports busy instead of waiting.

Where it is held:

- **Install**: `installExtension` takes it around apply only. Prepare
  (registry lookup, download, checksum and safety checks) runs before it, so
  the extension's own download never holds up another process (a dependency's
  does; see below), and a `ConflictError` leaves the
  section before the CLI's conflict prompt. Every install path goes through
  `installExtension`: pull, update, the lockfile restore in
  `extension install`, auto-resolve, and the `swamp serve` admin handlers. One
  exception: when `extension install` migrates an entry from a legacy layout,
  it deletes the old-layout paths (`sweepLegacyPaths`) after `installExtension`
  returns, outside the lock. Those paths lie outside every extension's own
  subtree (`.swamp/pulled-extensions/<ext-name>/`, where names are scoped as
  `@x/...`), so no current-layout install writes them.
- **Catalog save**: `InstallExtensionService` runs its catalog save and the
  install's commit or rollback in the same section, through
  `installExtension`'s `underLock` hook.
- **Removal**: `RemoveExtensionService.execute` runs entirely under it.
  `extension rm`'s preview and confirmation prompt stay outside.
- **Dependencies**: dependency installs run under the parent's section, their
  registry lookups and downloads included. Whether a dependency needs
  installing is only known from the lockfile read under the lock.

Each section calls `LockfileRepository.refresh()` first, so the prior entry it
prunes against, and the other entries' claims `rm` checks, are the ones on
disk rather than the snapshot taken when the command started.

The lock is reentrant through an `AsyncLocalStorage` lease: a section entered
while the caller's lease for the same checkout is active runs inline. The lease
is deactivated when its section exits, so a promise created inside it that
enters a section afterwards has to take the lock.

**Lock order.** Take locks in this order, and never take an outer one while
holding an inner one:

1. the datastore global lock, when held (e.g. model validate, workflow
   evaluate, or a managed lockfile transaction);
2. `.swamp/.extension-install.lock` (auto-resolve, see
   [Auto-resolve safety](#auto-resolve-safety));
3. `.swamp/pulled-extensions.lock`;
4. the lockfile's advisory lock (innermost).

**Managed lockfile transactions.** On an extension-backed datastore with
managedConfig the lockfile is shared through the datastore, which stores it
last-writer-wins. Installs and removals then run their section inside a
`ManagedLockfileTransaction` (`src/libswamp/extensions/managed_lockfile_transaction.ts`,
swamp-club#2838). The command sets it up with `withManagedLockfileTransaction`.
`installExtension` and `RemoveExtensionService` enter it through
`inManagedLockfileTransaction`, after prepare and before the pulled-extensions
lock, never inside apply. A transaction takes the global lock, fetches the
shared lockfile, replays any change an earlier transaction failed to publish,
runs the section, then records the change as a `LockfileDelta` and publishes the
lockfile. Nested sections, such as dependency installs, join the outer
transaction. A dependency that the fetched lockfile lists but that is missing
from this checkout is installed at its pinned version, as a pending
dependency of the parent, so a rollback restores the pinned entry it replaced.
The files-present check applies only to a lockfile a transaction governs; an
entry whose paths lie outside the repo (a pre-`.swamp` layout) still counts as
installed. See [Datastores](../enablers/datastores.md) for the fetch and
publish.

A swamp from before swamp-club#2838 locks a managed lockfile through
`upstream_extensions.json.lock`, not the sibling `.lock`, so an older and a
newer swamp writing the same lockfile (a shared filesystem datastore, or
worktrees sharing a cache) do not exclude each other. Upgrade every writer
together.

The auto-resolve lock stays separate. It covers inspecting, downloading,
installing and loading, so a process that loses the race loads what the winner
installed. The pulled-extensions lock covers only the local changes, so an
explicit install is not held up by another process's download.

Reconcile from disk and bundle eviction do not take the lock. A reconcile that
runs inside an install's swap window (see
[Install Transaction](#install-transaction)) finds the extension's root briefly
absent. It records the extension's sources as `EntryPointUnreadable`, never
tombstoned, because the lockfile entry is still there, and the next reconcile
returns them to `Indexed`. Bundle eviction skips staging entries.

## File Extraction (Per-Extension Layout)

Each installed extension has its own subtree at
`.swamp/pulled-extensions/<ext-name>/`, where `<ext-name>` is its scoped name
(e.g. `@swamp/aws/ec2`). Per-type directories inside it mirror the archive:

| Archive directory    | Destination                                                    |
| -------------------- | -------------------------------------------------------------- |
| `manifest.yaml`      | `.swamp/pulled-extensions/<ext-name>/manifest.yaml` (ro)       |
| `models/`            | `.swamp/pulled-extensions/<ext-name>/models/`                  |
| `workflows/`         | `.swamp/pulled-extensions/<ext-name>/workflows/`               |
| `vaults/`            | `.swamp/pulled-extensions/<ext-name>/vaults/`                  |
| `datastores/`        | `.swamp/pulled-extensions/<ext-name>/datastores/`              |
| `reports/`           | `.swamp/pulled-extensions/<ext-name>/reports/`                 |
| `files/`             | `.swamp/pulled-extensions/<ext-name>/files/`                   |
| `bundles/`           | `.swamp/bundles/<bundleNamespace(per-extension models dir)>/`  |
| `vault-bundles/`     | `.swamp/vault-bundles/<bundleNamespace(…vaults dir)>/`         |
| `datastore-bundles/` | `.swamp/datastore-bundles/<bundleNamespace(…datastores dir)>/` |
| `report-bundles/`    | `.swamp/report-bundles/<bundleNamespace(…reports dir)>/`       |
| `skills/`            | Every enrolled tool's skills dir (deduplicated)                |

### Multi-tool skill materialization

In repos enrolled for several AI tools (`marker.tools` has 2+ entries),
`extension pull`, `extension update`, `extension install` and
`extension source add` extract skills to every enrolled tool's project-local
skills directory. Directories are deduplicated, so tools sharing a path are
written once. At project level, codex/opencode/copilot map to `.agents/skills/`
and cursor to `.cursor/skills/`. At the global (user-level) tier, cursor also
uses `.agents/skills/` (`SKILL_DIRS` / `GLOBAL_SKILL_DIRS` in
`src/domain/repo/skill_dirs.ts`).

Every skill copy is tracked in the lockfile's `files[]` array. So
`extension rm` deletes every copy, and re-pulling after a tool change prunes the
old tool's stale skill paths. A skill is tracked as its directory root when the
extension owns the dir: the install created it, or the prior entry already
listed the root. A skill merged into a dir that existed and that the extension
does not own is tracked file by file, so rm and the orphan prune delete only
what the extension wrote. The orphan prune does not treat a change between the
two forms as an orphan, and it keeps any path another lockfile entry claims.
Path comparisons for ownership ignore separator style and letter case, because
Windows-written lockfiles use backslashes and macOS and Windows filesystems are
case-insensitive (`src/domain/extensions/extension_path_claims.ts`).

The `resolveUniqueLocalSkillsDirs(repoDir, tools)` helper follows the
`resolveUniqueGlobalSkillsDirs(tools)` pattern used for user-level skill
directories.

### Why extension-first?

Sibling extensions from one collective (e.g. `@swamp/aws/ec2` and
`@swamp/aws/eks`) often ship files with the same basename: shared helpers under
`_lib/`, boilerplate like `README.md` and `LICENSE.txt`, and chance matches like
`cluster.ts`. In a type-first (flat) layout these collide on extraction. The
second pull either fails with `ConflictError` or, with `--force`, silently
overwrites the first. The silent overwrite is the dangerous case. Behavior
bundles import `_lib/*` helpers transitively, so swapping `_lib/aws.ts` between
ec2 and eks gives wrong runtime results with no type or load error.

In the extension-first layout, each extension's files live in their own subtree
keyed on its scoped name, so this cannot happen. The registry already uses the
scoped name as an identity value object; making it the filesystem aggregate root
only adds a path segment.

### manifest.yaml colocation

Each archive manifest is extracted to
`.swamp/pulled-extensions/<ext-name>/manifest.yaml` with mode `0o444`
(read-only) and a `# Read-only; regenerate via 'swamp extension pull'` header.
Every installed extension thus describes itself on disk, and `extension rm`'s
dependent resolution reads that manifest instead of re-fetching or re-parsing
the archive. Some filesystems (notably Windows) treat the read-only mode as
advisory. The header documents it; it is not a security boundary.

### Bundle cache isolation

`bundleNamespace(baseDir, repoDir)` hashes its input relative path. Each
extension has its own behaviors dir, so each hash is unique and each extension
gets its own namespace under `.swamp/bundles/…` with no extra logic. In
datastore-backed repos where `bundles/` is tiered to S3 (see
`DEFAULT_DATASTORE_SUBDIRS`), team members' bundle caches stay separate per
extension.

If files exist at the destination and `--force` is not set, the user is asked to
confirm the overwrite. Since each extension has its own subtree, ConflictError
fires for those files only when an extension is reinstalled over itself.

Skills are the exception: they land in shared tool dirs, so a skill dir of the
same name may already belong to the user or to another extension. A skill dir
that exists and that the extension's prior lockfile entry does not list (as the
root or as files under it) is a ConflictError for the top-level extension.
`ConflictError.skillDirs` names those dirs, and the pull prompt and `--json`
output (`skillDirs`) list them apart from overwritten files, since the install
writes into them rather than replacing them. With
`--force`, and for dependencies, the install merges into the dir and logs a
warning naming it. The auto-resolver retries conflicts on pulled skill dirs, and
on skill dirs the pinned entry records, with force, as it does for stale bundle
output.

macOS resource fork files (`._*`) cannot get into archives. The Deno-native
archiver in `src/infrastructure/archive/tar_archive.ts` walks an explicit file
list on push and filters AppleDouble entries on extraction, so no
`COPYFILE_DISABLE` environment variable is involved.

### Bundle staleness and recovery

A swamp upgrade that changes `BUNDLE_LAYOUT_VERSION` can leave bundles stale.
The `ExtensionLoader.buildIndex` invalidation guards detect the mismatch and
delete stale bundle files before reconciliation, so the `bundleWithCache`
fallback cannot reuse bundles built for an incompatible runtime.

Pulled extensions ship without a `deno.json`. Push rewrites the bare imports its
import map resolves to their `npm:`/`jsr:` targets (swamp-club#3637), so such a
pulled extension re-bundles locally. One whose source still has bare imports (an
unmapped name, or one built in a `package.json` project) cannot: `deno bundle`
fails and it depends on the registry package's pre-built bundles. Once a stale
bundle is deleted, the extension enters `BundleBuildFailed` and is unavailable
until re-pulled.

Recovery paths:

- **`swamp doctor extensions --repair`** re-pulls pulled extensions in
  `BundleBuildFailed` or `ValidationFailed` state from the registry.
- **`swamp extension pull <name> --force`** re-downloads the extension and its
  pre-built bundle.
- **User-facing warning:** `registerLazyFromCatalog` warns when extensions are
  skipped for failure states and points to the recovery commands. It fires only
  if the source file exists; stale catalog entries for deleted sources are
  skipped silently (swamp-club#894).

Bump `BUNDLE_LAYOUT_VERSION` whenever a change to the bundler, runtime interface
or zod global shape makes existing bundles incompatible.

## Install Transaction

An install replaces an extension's files by **stage and swap**
(`ExtensionInstallTransaction` in
`src/infrastructure/persistence/extension_install_transaction.ts`, the journal
and recovery rules in `src/domain/extensions/install_journal.ts`,
swamp-club#2723). It used to copy the new version over the live one file by
file. That left a mix of two versions' files after a crash and could not be
undone.

**Roots.** The swap moves whole directories: the extension root
`<pulledRoot>/<name>/` and each of its bundle namespace dirs
`.swamp/<kind>-bundles/<ns>/`, including one that neither exists nor gets files
from the new version: the catalog save's loaders write bundles into it after
the swap, and a rollback must remove them. Skills are not swapped. A skill dir
can be shared with the user or another extension, so skills keep the merge copy
and `createdPaths` rules in
[Multi-tool skill materialization](#multi-tool-skill-materialization), and sit
outside the guarantees below: a rolled-back install can leave the new version's
content in a skill file it overwrote. Skill orphans are pruned only when the
install commits, so a rollback finds the previous version's skill files still
there and a failed install never leaves an entry claiming a deleted skill file.
The prune reads the claims at commit: a dropped skill dir that a dependency
installed in the same call merged files into is walked, and only the files no
entry claims (in either direction: an entry listing the file, or a dir above
it) are removed. The walk descends plain dirs only, never a symlink, and
removes a link itself, never its target.

**Staging.** Each root's new and old copies live in a staging dir next to it,
so every rename stays on one filesystem:

- extension root: `<pulledRoot>/.swamp-staging/<stagingId>/{new,old}/0`;
- bundle root: `.swamp/<kind>-bundles/.swamp-staging-<stagingId>/{new,old}/<i>`.

A reader that lists the pulled root or a bundle kind dir must skip
`.swamp-staging*` entries (`isStagingEntryName`). Most readers get extension
names from the lockfile or keep only `@`-prefixed entries, so they never see
them. `doctor extensions` bundle enumeration, the vault bundle preload for
datastore expressions, bundle eviction, the managed-config migration copy and
`directory_merge` skip them explicitly.

**Journal.** Before any staging dir exists (only the dir that holds it),
the install writes `<pulledRoot>/.swamp-staging/<stagingId>/journal.json` with an atomic
write. It records the owner id, the stagingId, the absolute repo dir, the
extension name, the phase
(`staged` or `swapped`), the lockfile path the install writes, the new archive
checksum, the old and new manifest digests, every root (live, old and new
paths, whether the live root existed and whether it was a symlink, whether the
new version has files for it), and the nested entry roots carried over. A bundle
root may have neither existed nor have new files; the extension root always has
new files. A binary from before swamp-club#2724 rejects such a journal as having
"nothing to swap" and leaves it with a warning, so after a downgrade in the middle
of an interrupted install that extension stays blocked until the journal is
settled by a current binary or resolved by hand.

**Swap.** Phase 1 moves each existing live root to `old/<i>`. Phase 2 moves
each new root into place, bundles first, then the extension root (staged
without `manifest.yaml`), then `manifest.yaml` last. A bundle cache dir that a
loader outside the lock recreated since phase 1 is moved aside into staging
first, not treated as a failure. The journal then records
`swapped`. Any failed rename undoes the completed ones in reverse order,
carrying on past a step that cannot be undone (a bundle dir a loader recreated)
so the other roots still go back. Before
each phase the install re-reads the journal and stops unless it still owns it.
No rename ever targets an existing path, so Windows never renames over a
directory. Between the first phase-1 rename and the `swapped` write only
renames, lstats and journal reads and writes happen, so the window in which a
root is absent to readers outside the lock stays short.

**Commit or rollback.** `applyInstall` returns a `PendingInstall`: the swap is
done and the old roots are kept. It covers the extension and every dependency
installed with it, which stay uncommitted too (their owner ids stay active, so
a later dependency's recovery leaves their journals alone). Exactly one of
`commit()` and `rollback()` takes effect; calling either again does nothing.
The caller of `installExtension` ends it in its `underLock` hook, still under
the lock (see
[Commit or rollback after the catalog save](#commit-or-rollback-after-the-catalog-save));
`installExtension` commits one left pending, and commits right after apply when
there is no hook (the lockfile restore in `extension install`, auto-resolve
without a catalog). If apply fails after some dependencies were applied, they
are committed and the parent rolls forward, since its entry has landed.

- **Commit** deletes the staging, and with it the old roots, dependencies
  first, then prunes the skill orphans. Deleting staging removes the journal
  first, so a crash part-way through leaves journal-less staging for the sweep,
  never a journal that could later restore a half-deleted old root. Warnings
  about what the install replaced or removed under the extension root are
  logged here, once they are final.
- **Rollback** (`ExtensionInstallTransaction.rollback()`) plans each root with
  the crash recovery planner, forced back, and runs the same renames through the
  same helper (`applyRecoveryRenames`). The one addition: a bundle cache dir a
  loader recreates between moving the new copy aside and the old one back is
  moved to a free path under `superseded/` in staging and the rename retried
  once. Staging is then deleted, journal first. A root it cannot account for,
  or a rename that fails, leaves the journal for crash recovery.

**Settle.** Any failure after staging starts is settled before it propagates,
by the same rule as crash recovery: forward when the journal reached `swapped`
and the lockfile entry landed (a dependency failed after the parent was
written), back otherwise. In process the install knows whether its own lockfile
write completed, so a failed same-version reinstall rolls back even though the
prior entry already carries its checksum. Settle never replaces the original error. If settle
itself fails, the journal stays for crash recovery.

**Crash recovery.** `recoverPulledExtensionStaging(repoDir)` runs under the
pulled-extensions lock at the start of every apply and every removal. Other
callers, such as convergence, can call it directly. For each journal whose
owner is not an install running in this process (no pid checks: containers
reuse pids):

- The journal is validated first. Every path must be exactly the one derived
  from the extension name and the stagingId, and the lockfile path must be one
  this checkout can write (`resolveExtensionLockfilePaths`, including the
  non-managed `extensions/models/upstream_extensions.json`). An invalid journal
  is left in place with one warning naming it.
- It rolls forward when the journal reached `swapped` and the recorded
  lockfile's entry carries the new checksum; otherwise back. Rolling forward
  checks that the extension root and its manifest are the new ones, not
  whether a bundle root is live: loaders outside the lock rebuild and evict
  bundle caches.
- Rolling back, each root is judged from where its original is: in `old/<i>`
  once phase 1 moved it aside, otherwise still live. Where the new copy is
  does not matter, so a crash inside `begin` or during cleanup stays
  recoverable, and a live dir found next to a moved-aside original (a bundle
  cache a loader recreated) is superseded. Never from the extension's
  manifest. Recovery only renames; a superseded root goes to `discard/<i>` and
  is deleted with the staging, so the only copy of a root is never deleted.
- An original that is gone, a symlink or file where a directory belongs
  (including any staging dir or a dir above a live root, but not an extension
  root recorded as a symlink, see below), or a failed
  recovery leaves the journal in place with a warning. While such a journal
  names an extension, installing or removing it, or an extension nested in or
  above it, is refused with a message naming the journal: changing its roots
  first would let a later recovery act on files it did not write. The
  refusal's advice follows what recovery found at the extension root and at
  `old/0`: move the previous version back when only it is left, keep the
  wanted one when both exist, check the live root when nothing is staged,
  pull again when neither exists. It never says to delete staging that may
  hold the only copy.
- Journal paths are absolute, derived from the absolute repository path. A
  journal written under another repo dir (the repo was moved or copied, a CI
  workspace was restored at another path, a container mounts it elsewhere, or
  a symlinked spelling such as macOS `/tmp` and `/private/tmp`) is rebased
  first: each path under the recorded repo dir moves under the current one,
  and a path outside it (a lockfile kept outside the repo) is kept. The exact
  validation then runs on the rebased journal, so the rebase only accepts a
  journal that could have been written with the current paths, and a copied
  checkout recovers its own files, never the original's.
- Staging with no journal is swept only once it is older than an hour.

Recovery never writes the lockfile. A same-version reinstall has equal old and
new checksums, so after a process crash (not a failure the install settles
itself) between `swapped` and the lockfile write, recovery rolls forward. The tree is then the reinstalled one with the old entry, identical
apart from any files it could not carry forward (see below).

**Extra files.** The swap replaces a root whole, so the install copies
the files a user added under `.swamp/pulled-extensions/<name>/` into the
new root, keeping their times, as the merge copy kept them. `extension
update`, `extension install` and `repo upgrade` install with force, so
this is what keeps those files, not the local-edits guard. A file is the
user's when the new archive does not ship it and the prior lockfile
entry's `files[]` does not list it. A file the entry lists is one the
prior version shipped and the new one dropped, so it goes with the old
root, and an upgrade never leaves a mix of two versions' files. Where the
archive ships a file at the same path, the archive's copy wins (a
`ConflictError` without `--force`, as before). The user's files stay out
of `files[]`; `filesChecksum` is the digest of the tree on disk, theirs
included, as before.

The entry's list only describes the tree when the installed
`manifest.yaml` is the entry's version. When it is not (a lockfile
restored from git after an upgrade), or the entry has no `files[]`, or
there is no entry, unlisted files cannot be told apart from ones an older
version shipped. The install then keeps only what the archive ships and
logs a warning naming each file it removed. A symlink, or a path under
one where the new archive ships a file, cannot be copied and is named in
a warning the same way. No file under the root is removed without either
being listed in the prior entry or named in a warning.

**Symlinked extension root.** An extension root that is a symlink is replaced,
not written through. Phase 1 moves the link itself to `old/<i>`, the new
version goes in as a real directory, and commit deletes the link with the
staging; the link's target is never read or written by the swap. Files in the
target are not carried forward. Once the lockfile entry is written, a warning
names the link and its target and says to re-create the link to keep using it.
A failure or a crash puts the link back where it was: the journal records
`liveIsLink`, and recovery treats the link as the original in the `old` and
live slots. A bundle root that is a symlink is still refused.

**Nested entries.** A scoped name can nest another (`@a/b` contains the root of
`@a/b/c`). An install of `@a/b` copies each nested entry's root into its new
root, keeping file and directory times so the nested entry's sources stay no
newer than its pre-built bundles, and records it in the journal. A nested entry
whose first path segment is a kind dir or `manifest.yaml` (`@a/b/models`) is
refused, whichever of the two is installed second: the parent's own files live
there, and the swap would move them aside and commit would delete them. Such a
layout installed before this change; remove one of the two to install the
other. The installed-extension digest (`filesChecksum`) leaves nested entry
roots out, so installing `@a/b/c` does not make `@a/b` look locally edited. A
digest stored before this rule covered the nested root too. While a root has
nested entries, the local-edits check and the `extension install` content check
also accept that whole-tree digest, until the next install stores the new one.

**Not protected.** The pulled-extensions lock is per host. Two hosts that
mount one checkout on a shared volume can still interleave, and one host's
recovery can roll back the other's install in flight. A crash-leftover
staging dir under `.swamp/config/pulled-extensions` in a managed-config repo
can be pushed by a full sync before the next install or removal recovers it.
Rolling back an interrupted first install moves aside whatever is at the live
root; if a swamp without this change, or another host, installed the extension
there in between, recovery discards that install while its lockfile entry
stays.

## Layout Migration

Repos with extensions under older layouts migrate with `swamp repo upgrade`.
Three generations are recognised:

- **gen-1 (pre-`.swamp/`):** files under `extensions/<type>/...`.
- **gen-2 (flat under `.swamp/`):** files under
  `.swamp/pulled-extensions/<type>/<file>`. Filenames collide across extensions
  here, so earlier installs may have overwritten each other and renaming cannot
  recover the real content.
- **current (per-extension):** files under
  `.swamp/pulled-extensions/<ext-name>/<type>/...`. No migration needed.

gen-1 and gen-2 migrate the same way, and nothing is renamed in place. After
refreshing the repo, `repo upgrade` runs the `swamp extension install` pass
(`extensionInstall` in `src/libswamp/extensions/install.ts`).
`needsInstallOrMigration` marks an entry for migration when all its tracked
files exist and at least one is at a gen-1 or gen-2 path. The install re-pulls
that extension into its per-extension subtree, verified against the lockfile's
stored checksum, and rewrites the entry's `files` to the new paths. When it
commits, it prunes the old paths that no other entry claims. `sweepLegacyPaths`
then removes every gen-1 or gen-2 path of the entry that is still on disk. An
entry with a missing file is re-pulled as a plain install instead: the
commit-time prune still removes its unclaimed old paths, but the sweep does not
run for it. The sweep does not check other entries' claims, so a gen-2 file
shared by two colliding extensions goes too. The extension that still lists it
is handled later in the pass, finds the file missing, and is re-pulled.

The lockfile tolerates mixed generations, since each entry stands alone. The CLI
guard warns with a one-line reminder instead of failing, so migrated extensions
stay usable during a partial upgrade. The migration is resumable. A failed
re-pull or sweep is reported for that entry and the pass moves on to the next.
Errors before the re-pull starts are not isolated this way. An unreadable
tracked file, or an entry name or path that escapes the repo, for example,
aborts the whole pass, and `repo upgrade` reports it as an error. A failed
re-pull (a download error or a checksum mismatch) leaves the entry's legacy
files and lockfile entry as they were, so the next `swamp extension install` or
`repo upgrade` retries it. The sweep treats `Deno.errors.NotFound` as already
removed. Any other sweep error comes after the re-pull has committed: the entry
is reported failed, but its lockfile entry already lists the new paths, so later
passes see it as up to date and do not retry the sweep. Legacy files the sweep
had not reached stay on disk until removed by hand.

Skill directory entries are always treated as current-layout, wherever they
are. Each is tracked as one dir path in `entry.files[]`, e.g.
`.claude/skills/<name>`, `.cursor/skills/<name>`, or
`.swamp/pulled-extensions/skills/<name>` for the `tool=none` fallback. The
install flow filters them out before classification, using the skillsDir passed
through `ExtensionInstallDeps`. They never trigger migration on their own and the
post-migration sweep never touches them. Without the filter, the `tool=none`
path would look like a gen-2 path and the freshly restored skill dir would be
deleted. On its own, the path-only `classifyExtensionFile` helper flags only the
documented gen-1 shape, `extensions/<known-type>/...` with `<known-type>` in
`PULLED_TYPE_DIRS`. Any other non-`.swamp/` path, or a path it doesn't
recognise, counts as current-layout and is ignored rather than swept. It matches
on path segments, not separators: a lockfile written on Windows stores
backslash-separated paths, and those classify the same as their forward-slash
form.

## Removal

`extension rm` first runs crash recovery (see
[Install Transaction](#install-transaction)), so the files it removes are the
ones the lockfile describes. It then checks that every file tracked in `upstream_extensions.json`
resolves inside the repository. If any path does not, for example in a lockfile
written before `.swamp/` existed with `SWAMP_MODELS_DIR` outside the repo, rm
fails with nothing changed and names the paths to remove from the entry.

It then tombstones the extension's catalog rows, freeing its `(kind, type)`
slots atomically in one SQLite transaction. After that it removes the lockfile
entry, deletes the tracked files, and prunes empty parent directories. A file
that cannot be deleted, for example because of a permission error or a file
locked on Windows, does not stop the rm. It is listed in `failedFiles` for the
user to remove by hand, since nothing tracks it any more. A tracked path that
another installed extension also claims (a shared skill dir that extension
lists, or lists files under) is kept and reported in `retainedFiles`. Tracked
paths are checked with `lstat`, so a symlink is unlinked rather than followed.

If other installed extensions depend on the target (found by scanning their
`manifest.yaml` files on disk), a warning is shown first.

A second rm of the same extension gives a clean
`Extension <name> is not installed.` user error. The lifecycle service decides
"not installed" only when both the catalog and the lockfile show it absent, so
extensions in a partial state still rm cleanly.

Extensions pulled before file tracking existed cannot be removed cleanly; the
user is asked to re-pull with `--force` to fill in the file list first.

## Lifecycle Services

`InstallExtensionService`, `RemoveExtensionService` and
`UpgradeExtensionService` (in `src/libswamp/extensions/`) are the only three
paths that write the catalog. CLI command files never call the catalog directly;
they build the service and call `execute(...)`. This split lets `rm` prune
catalog rows, and the unified loader builds on it.

### Asymmetric ordering

Install is **filesystem → lockfile → catalog**. Remove is the inverse:
**catalog → lockfile → filesystem**, preceded by a path check that changes
nothing when it fails.

If rm deleted files first, the catalog would briefly point
at deleted bundle files and concurrent type resolution would crash. With the
catalog first, a crash mid-rm leaves files on disk but a clean catalog, and the
next loader pass finds the orphans via `findStaleFiles`. With the catalog last
on install, a crash mid-install leaves files and the lockfile entry but no
catalog rows, and the next loader pass rebuilds them through the cold-start
path.

### Phase 8: synchronous type extraction at install

After writing files and the lockfile entry, phase 8 walks the per-extension
subtree and calls each loader's `bundleAndIndexOne(args)` on every source file.
It builds an `Extension` aggregate whose Sources are `Indexed` with
`(kind, typeNormalized, bundlePath)` set, and commits it with
`repository.saveAll([extension])` in one SQLite transaction. The repository's
I-Repo-1 invariant (no two non-tombstoned Sources share
`(kind, typeNormalized)`) is therefore checked at install, not at the next
steady-state loader pass. A type collision between extensions shows up as a
clean `DuplicateTypeUserError` before the user sees "successfully pulled".

For a pulled extension, `bundleAndIndexOne` takes the archive's staged bundle
rather than rebuilding it, unless pull found its bundle format is not this
swamp's (see "Consumers run the publisher's bundle").

`bundleAndIndexOne` is a strict per-loader contract: it bundles, extracts types
and returns metadata, but **does not write to the catalog**. Only the lifecycle
service writes the catalog, which keeps I-Repo-1 firing consistently on every
install.

### Unreachable-path pre-flight prune

Before checking I-Repo-1, `saveAll` prunes non-Tombstoned rows whose
`source_path` is outside the canonical repo root. These are stale rows from
container sessions that bind-mounted the repo elsewhere (e.g. `/workspace/...`
vs `/Users/...`). Unpruned, these phantom rows cause cross-aggregate
`(kind, typeNormalized)` collisions that block every catalog write, including
`rm` of unrelated extensions.

Sources mounted through `.swamp-sources.yaml` can live outside the repo root
(a sibling checkout, or the git main worktree when the repo is a worktree). Each
repository is built with `mountedSourceDirs`, the per-kind directories the
current `.swamp-sources.yaml` resolves to (`resolveMountedSourceDirs`), and the
prune keeps a row under one of them whose source file still exists
(swamp-club#2563). Without that, every partial save (`extension pull`, `rm`,
`update`, the loader's failure records) deleted the mounted rows until the next
index. Keeping any out-of-root row whose source exists would be wrong: a repo
copied from A to B, with A still on disk, would keep A's local rows, and
`resolveOriginConflicts` treats them as local, so they would clear the type on
B's pulled rows. `integration/extension_repository_mount_dirs_rules_test.ts`
fails on a production construction that omits `mountedSourceDirs`.

### Mounted-source conflict settle

A kept mounted row can share a `(kind, type)` with a local row or with a row
under another mount: a cold index types every file it discovers, and older
binaries left such pairs typed.
`ExtensionCatalogStore.settleMountedTypeConflicts` settles them in the loader's
registration order: a local row beats a mounted one, a row under an earlier
`.swamp-sources.yaml` entry beats a later one, then the smaller canonical path.
`saveAll` runs it before I-Repo-1, and the loader runs it after each pass
(through `ExtensionRepository.settleMountedTypeConflicts`). The losing mounted
row's type is cleared, as `resolveOriginConflicts` clears a pulled row's. This
runs whenever the repository has mount directories, including saves that pass
`pruneUnreachable: false`. Pulled rows are left to `resolveOriginConflicts`, and
conflicts between two local rows still fail I-Repo-1.

### Stale-source pre-flight prune

In the same step, `saveAll` also deletes rows that could only mislead type
resolution (`ExtensionCatalogStore.pruneStaleSources`, swamp-club#2490):

- a row that claims a type (or, for an extension row, a base type) whose source
  file is missing. Only `NotFound` counts as missing. Importing such a row
  either fails with ENOENT when its bundle is rebuilt, or silently runs an old
  bundle;
- when the repo's active pulled root is known, a row under the other pulled
  root, `.swamp/pulled-extensions/` or `.swamp/config/pulled-extensions/`.
  `datastore config migrate` copies the pulled tree rather than moving it.
  Datastore rows are exempt: the on-disk datastore chooser can load from either
  root, and `purgeUnchosenPulledDatastoreRows` decides which one survives.

Rows in the save, Tombstoned rows and rows in a failure state
(`CATALOG_FAILURE_STATES`, kept so doctor can report them) are never deleted.
Deletion uses the raw stored path, so keys written on another OS still match.
The prune runs before I-Repo-1, so a typed row whose source is gone no longer
blocks another extension from claiming its type. A copied old-root row no
longer shares a type with its new-root twin either, which used to roll back
every unrelated save. Like the unreachable-path prune, it is skipped when the
caller passes `pruneUnreachable: false`. Once the transaction commits, each
removed row's bundle is deleted, unless the row's source still exists under
another spelling of the repo root or another row still references the bundle.

### Stale-source healing

The loader keeps its own catalog writes consistent with the rules above, so a
stale row never crashes a command (swamp-club#2490):

- **Identity.** `deriveExtensionIdentity` recognizes both pulled roots, so
  `extension rm` finds and tombstones rows under
  `.swamp/config/pulled-extensions/`. `computeExtensionRoot` still roots every
  pulled aggregate under `.swamp/pulled-extensions/<name>`, so two roots in one
  aggregate never trip I1.
- **Unseen rows.** The cold path of `buildIndex` removes rows its scan no longer
  reaches, exactly as `findStaleFiles` does on the warm path. Both use the same
  discovery and exempt failure states. Rows under an old pulled root, or rows
  of an extension that is no longer installed, do not outlive a cold pass.
- **Type-load guard.** `loadSingleType` checks that a row's source exists before
  importing its bundle, whether or not the bundle exists. A row whose source is
  gone is deleted, and the next row claiming the type is tried. With none left,
  the registry reports the type as not found. The behavior adapter filters
  extension rows the same way. Every kind registry drops a lazy entry that its
  loader did not promote.
- **Conflict settle.** A rebundle never writes a type that a higher-ranked row
  already holds: a local row outranks a source-mounted one, which outranks a
  pulled one (`compareExtensionPrecedence`), and a pulled row that holds the
  type outranks any other pulled row. Before swamp-club#2563 the loader ranked
  a mounted row as local and broke the tie by path, so a local override added
  after a mounted source was indexed typeless when the mounted path sorted
  first. A cold index discovers files in sorted order, so there the smallest
  path is indexed first and wins. After
  each pass, pulled rows that still share a `(kind, type)`, as an older binary
  could leave them, are settled by insertion order: the earliest row keeps the
  type (`settlePulledTypeConflicts`), which is the row that binary resolved.
  Conflicts with source-mounted rows are settled next
  (`settleMountedTypeConflicts`), then pulled-vs-local conflicts
  (`resolveOriginConflicts`), so a local override ends up the only claimant.
  `saveAll` settles pulled conflicts only when asked
  (`settlePulledTypeConflicts: true`), which only ReconcileFromDisk does: a
  conflicting install still fails with `DuplicateTypeError`. The loader and the
  reconcile report a settled conflict with the same warning, once per process.
- **Typeless-row heal.** A row whose type was cleared for a conflict keeps an
  empty type after the winning row is gone, because its fingerprint still
  matches. The per-kind `bundle_meta` marker
  `migration_applied:typeless-row-heal-v2:<kind>` is absent after an upgrade and
  is cleared whenever a row that claims a type is deleted or upserted with a
  different type. While it is absent, the next warm pass imports the existing
  bundle of each seen, typeless `Indexed` row, and of each row it wrote typeless
  in the same pass, to learn its type. It writes the type back only when no row
  claims it, for at most one row per type: a local row before a source-mounted
  one before a pulled one, then the smallest path. When every row claiming the
  type is a source-mounted row the chosen row outranks, the type moves to the
  chosen row instead. That repairs local overrides an older binary indexed
  typeless behind a mounted row; the marker moved from `v1` to `v2` so the heal
  runs once after upgrading (swamp-club#2563). The pass then sets the marker.
  This writes the catalog only and never the registry, so a pulled row cannot
  displace a local override. The heal is also skipped, with the marker left
  unset, while the kind has a local row in a failed state whose source still
  exists: a failed row claims no type, so a broken local override would
  otherwise hand its type to the pulled row it shadows. The heal runs once that
  row is fixed or its file is removed.

### Atomic upgrade pattern

For each new aggregate it saves, the install service tombstones any existing
aggregate with the same name but a different version, and submits everything
to `saveAll` in one transaction:

```
saveAll([tombstoneAll(v1), ..., v2])
```

I-Repo-1 checks the post-save state, where only the new version holds the slot.
Without this pattern, a force-pull of an installed extension, or any
version-bump pull, would fail with `DuplicateTypeError` against the user's own
earlier version. Reinstalling the same version skips the tombstone; the
diff-save in `saveAll` handles the overwrite.

`UpgradeExtensionService` is a thin facade over
`InstallExtensionService.execute(...)` so call sites can state upgrade intent.
The atomic-tombstone logic lives in the install service's phase 8.

### Commit or rollback after the catalog save

Phase 8 receives the install uncommitted, as a `PendingInstall` (see
[Install Transaction](#install-transaction)): the previous versions of the
extension and of every dependency installed with it are still kept aside.
`InstallExtensionService` ends it under the lock (swamp-club#2724):

- **The catalog save succeeds**: commit.
- **`DuplicateTypeError`** (two different extensions claiming the same
  `(kind, typeNormalized)`): rollback. SQLite ROLLBACK has already undone the
  catalog, so the previous versions' rows are still there; the rollback puts
  the files back to match them:
  1. Every lockfile entry the install wrote is restored in **one write**
     (`LockfileRepository.restoreEntries`): the prior entry object exactly as it
     was read, or no entry where there was none. The write is under the
     advisory lock, and the entry is not rebuilt, so file order, empty fields
     and unknown keys come back as they were.
  2. Every root is moved back, dependencies first, in reverse install order.
  3. The skill paths the install created are deleted. A skill dir that existed
     before the install is never deleted: only the files the install newly
     wrote in it are removed, and files it overwrote keep their new content.

  The entries go back before any root, so a crash in between leaves journals
  whose lockfile entry is not their install's, and recovery rolls each one
  back. An upgrade that collides therefore leaves the previous version
  installed exactly, files, bundles and lockfile entry.
- **Any other fault** (a source that fails to bundle, a generic `saveAll`
  failure): commit, then the "Install partially applied" message (see
  [Crash-state recovery](#crash-state-recovery)).

If the lockfile write reports an error, the rollback reads the lockfile back:
releasing the advisory lock runs after the write, so an error does not prove
nothing landed. Where every entry was restored it carries on. Where none was, it
commits the whole install and reports `kept`: files, lockfile and dependencies
stay consistently on the new version, the half-state of a generic fault plus an
unresolved collision, which the next loader pass settles first-wins. Where the
lockfile cannot be read back, or holds neither the restored entries nor the new
ones, it leaves every journal for the next install or removal to settle from the
lockfile then, and reports `unsettled`. A root the rollback cannot move back
(a disk state it cannot account for, or a failed rename) also reports
`unsettled`: its journal stays, its lockfile entry is already restored, and the
next recovery rolls it back, or leaves it with a warning naming the journal when
the disk state still does not match any it can produce.

The error then propagates as a `DuplicateTypeUserError` (a `UserError`
subclass). The top-level CLI handler prints a clean one-line message in log mode
and a structured `duplicateType` object in `--json` mode:

```json
{
  "error": "Type \"@scope/foo\" (kind=model) is already claimed by ...",
  "duplicateType": {
    "kind": "model",
    "type": "@scope/foo",
    "isGhostRow": false,
    "rolledBack": true,
    "rollback": { "status": "rolled-back" },
    "existing": {
      "extensionName": "...",
      "extensionVersion": "...",
      "canonicalPath": "..."
    },
    "conflicting": {
      "extensionName": "...",
      "extensionVersion": "...",
      "canonicalPath": "..."
    }
  }
}
```

`existing` is the extension that already held the type in the catalog and
`conflicting` is the one being installed, regardless of how their paths sort:
the repository decides this from which sources are in the failing save, not
from catalog row order.

`rollback` says how the rollback ended: `rolled-back` (with `reverted`: each
extension's name, the version it tried and its prior version), `kept` (the same,
as `kept`) or `unsettled` (with the lockfile path); `rolledBack` is true only for
`rolled-back`. A `rolled-back` message names the version that remains installed
when the extension had one ("rolled back; `<name>@<prior>` remains installed").
A `kept` message says the install was kept rather than "Cannot install", and
suggests `swamp extension pull <name>@<prior>` for each kept extension that had a
prior version, `swamp extension rm <name>` for one that did not, or removing the
extension that already held the type (or `swamp doctor extensions` when that is
a ghost row). An `unsettled` message says the next `swamp extension` install or
removal will finish the rollback or name the install journal to resolve by hand;
the lockfile path is in the JSON only.

`extension update` reports an update whose collision left it `kept` as
`kept_with_collision` (previous and new version, and the error), counted apart
from `updated` and `failed` in the summary (`keptWithCollision`).

The message suggests `swamp extension rm <existing-name>`. A conflict may come
from a **ghost catalog row**, whose source file was deleted outside swamp. The
service then stats the `existing` side's path via `Deno.stat` and suggests
`swamp doctor extensions` instead, the right fix for orphaned rows. The
`isGhostRow` flag on `DuplicateTypeUserError` is then `true` and appears in the
`--json` output's `duplicateType` object.

### Bounded atomicity

Each `execute(...)` is its own transaction. Bulk operations (`extension update`
over N extensions) run N separate transactions, not one all-or-nothing batch. If
extension A's upgrade rolls back on a collision with unchanged extension B,
extensions already upgraded in the run stay upgraded. The unit of atomicity
is one extension, never a multi-extension run.

### Crash-state recovery

A crash during the file changes of an install is put right by the next install
or removal: the journal lets recovery roll the swap forward or back (see
[Install Transaction](#install-transaction)), so the extension root and its
bundle dirs are always one version's, never a mix. Skill files are outside that
guarantee.

Any failure other than `DuplicateTypeError` inside `repository.saveAll` (SQLite
I/O error, OOM, process killed mid-commit) leaves the catalog in its pre-save
state via SQLite ROLLBACK. The install then commits, so the filesystem and
lockfile hold the new version; only `DuplicateTypeError` rolls the install
back. A source that fails to bundle during phase 8 commits the same way, so one
source that cannot import on this machine does not stop the rest installing. A
retry succeeds, because the diff-save in `saveAll` reconciles the catalog with
the disk and lockfile.

A process killed while phase 8 holds the install uncommitted leaves a journal
that reached `swapped` with its lockfile entry landed, so the next recovery
rolls it forward: the same half-state as a generic fault.

Known crash edges the recovery leaves for a person, with the journal named:

- A same-version reinstall over a symlinked extension root that collides, then
  crashes after its rollback renames: the entry carries the new checksum, so
  recovery plans forward and finds the restored link where it expects the new
  directory.
- A rollback that crashes after moving a previously absent bundle root's new
  copy to `discard/<i>`, followed by a loader recreating that bundle dir.

For rm, the catalog tombstone is the first change, so a fault in that
`saveAll` leaves catalog, lockfile and FS in their pre-rm state and a retry is a
clean re-rm.

Known limit: these per-extension atomicity guarantees are reasoned about per
process. No automated
stress test covers concurrent `swamp` processes changing one repository
(parallel `pull`/`rm`/`update`).

### Unified loader

One `ExtensionLoader` (`src/domain/extensions/extension_loader.ts`),
parameterized by a `KindAdapter` (`model_kind_adapter.ts`,
`vault_kind_adapter.ts`, `datastore_kind_adapter.ts`,
`report_kind_adapter.ts`), gives one `bundleAndIndexOne` dispatch for all four
kinds. The install/remove/upgrade services keep their public API, and CLI
command files (`extension_pull.ts`, `extension_update.ts`, `extension_rm.ts`,
etc.) build them directly.

### ReconcileFromDisk and freshness as an aggregate query

`ReconcileFromDiskService`
(`src/libswamp/extensions/reconcile_from_disk_service.ts`) and the freshness
contract form two layers:

1. **Type resolution layer**: `isFresh(state) = state === "Indexed"`, a
   constant-time aggregate query. Type resolution ignores all other RowState
   tags.

2. **State maintenance layer**, split between two paths:
   - **Cold-start / explicit reconcile:** `ReconcileFromDiskService` walks the
     whole disk across all three origin types (locals, pulled, source-mounted)
     and repairs state after the fact. It runs when
     `anyKindNeedsInvalidation()` returns true, i.e. some kind's
     `populated:<kind>` marker in `bundle_meta` is unset.
   - **Warm-start / hot path:** `findStaleFiles` compares fingerprints
     incrementally, run by each loader's `buildIndex` once the catalog is
     populated. It deletes rows whose source it no longer sees, except those in
     a failure state; the cold path applies the same removal
     (`removeUnseenCatalogRows`). A `BundleBuildFailed` row with a matching
     fingerprint counts as stale and is retried on the next scan, not treated
     as a cache hit. A transient build failure (e.g. npm deps unreachable on a
     cold cache at first load) must recover when conditions change, not block
     the type across restarts. Deterministic `ValidationFailed` rows stay excluded,
     since re-bundling them only wastes work.

The development workflow depends on warm-start incremental detection, so
`findStaleFiles` keeps its full fingerprint comparison rather than becoming a
deletion-sweep shim.

**ReconcileFromDisk semantics.** The service:

- Walks the on-disk source trees for all origin types.
- Loads current aggregate state via `repository.loadAll()`.
- Diffs disk against the aggregate and emits RowState transitions with the
  existing Extension aggregate methods.
- Uses each loader's `bundleAndIndexOne` for type extraction, not
  `InstallExtensionService`: the source and lockfile already exist, and
  reconcile only repairs state.
- Saves via `repository.saveAll()` in one SQLite transaction, with
  `settlePulledTypeConflicts: true`. Two pulled extensions that provide the same
  `(kind, type)` are settled the way the loader settles them, not rejected: the
  earliest-inserted row keeps the type, and a warning names both extensions.
  On a rebuilt catalog that is the entry listed first in the lockfile. Without
  this, the reconcile rolled back and left the catalog empty, so every later
  command failed the same way (swamp-club#2702). Duplicates among local and
  source-mounted extensions still throw `DuplicateTypeError`.

**Locals vs pulled reconcile matrix:**

| Origin         | Source on disk | Source in aggregate | Transition                                                 |
| -------------- | -------------- | ------------------- | ---------------------------------------------------------- |
| Local          | present        | absent              | `bundleAndIndexOne` → `Indexed`                            |
| Local          | absent         | present             | `markSourceMissing` → `OrphanedBundleOnly` or `Tombstoned` |
| Pulled         | present        | absent              | `bundleAndIndexOne` → `Indexed`                            |
| Pulled         | absent         | lockfile present    | `recordEntryPointUnreadable` (no automatic re-fetch)       |
| Pulled         | outside walk   | lockfile present    | `Tombstoned` (e.g. the pre-migrate copy, swamp-club#2490)  |
| Pulled         | absent         | lockfile absent     | `Tombstoned` (orphan from failed rm)                       |
| Source-mounted | —              | —                   | Follows local semantics                                    |

**Trigger points:** cold-start (when `anyKindNeedsInvalidation()` returns true)
and an explicit `swamp doctor extensions`. It does not run on every command,
where reconcile would dominate hot-path performance.

`swamp serve check-config` promises to leave the repository untouched, so
startup neither opens the catalog nor reconciles for it. Both wait for the first
registry load, which the command only reaches when it reads a token secrets key
from a vault.

A reconcile that fails at startup is logged ("Extension catalog repair failed")
and the command continues on the loaders' own indexing, so
`swamp doctor extensions` and `swamp extension rm`, which repair the state, stay
reachable. The populated markers are not set, so the next command retries.

Serve reload runs a scoped form, `reconcileUncataloguedPulled()`, for pulled
lockfile entries that have no catalog rows, such as files a managed-config sync
copied into a running serve. It creates aggregates only for those extensions,
saving each separately so one failure (for example a `DuplicateTypeError`)
rolls back only that extension. It skips local and source-mounted sources,
orphan tombstoning, the populated markers and the >50% guardrail. The
guardrail stops reconcile from mass transitioning existing rows, and the
scoped form never reconciles an existing aggregate. Each save still runs
saveAll's origin-conflict resolution across the repo, as every pull does, so it
can clear the type on a pulled row that a local or source-mounted row also
claims. Its saves skip saveAll's prune of rows whose source is outside the repo
root (`pruneUnreachable: false`), so they cannot delete any row they did not
create. The prune itself keeps the rows of live mounted sources only through
the repository's `mountedSourceDirs`. An entry with no entry-point sources on
disk is reported as skipped, and nothing is saved for it.

**dryRun mode:** `execute({ dryRun: true })` collects transitions without
calling `repository.saveAll()`. It returns `ReconcileTransition` records
(`{ source, fromState, toState, reason }`) that `swamp doctor extensions`
renders directly.

**Transition-count guardrail:** if a run would transition more than 50% of
existing rows (minimum 10 rows), it aborts and returns the transitions unapplied.
This catches mass-tombstone bugs.

**enforceI2 transform.** The Extension aggregate enforces I2 by picking a
deterministic winner and tombstoning the loser instead of throwing. The Source
with the lexicographically smaller `canonicalPath` wins; the loser is tombstoned
with reason `"renamed"`. Cross-aggregate uniqueness (I-Repo-1) still throws
`DuplicateTypeError` at the repository layer, after a reconcile save has settled
pulled-vs-pulled conflicts. Both checks skip `extension`-kind
Sources: an extension's type is the base type it adds methods to, and one
package may ship several extension files for the same base type.

**Recorded source modules.** A source's fingerprint covers every local module
its bundle was built from, wherever it lives and however it is imported: a model
in `extensions/models/` that imports `../lib/msg.ts`, or side-effect imports
`./side.ts`, goes stale when either changes (swamp-club#3385). Each time the
loader bundles a source (`bundleWithCache`), it reads the entry point's module
graph with `deno info`, the same source of truth push uses, under the same
project config as the bundle. It records the graph's local modules, its missing
modules, the deno config and the lockfile that config names (recorded before it
exists, so a lock created, updated or pulled later rebuilds the bundle against
it, swamp-club#3869) in the catalog's `source_modules` table.
`computeSourceFingerprint` hashes that list, so the warm scan never spawns a
process. A recorded list stays valid until the source changes: a relative import
can only reach a new module if a recorded module's content changes or a recorded
missing module appears, and either changes the fingerprint. A source with no
recorded list falls back to the relative imports `resolveLocalImports` finds
within the kind's directory. Pulled sources with no recorded list are not forced
stale, since their bundles ship pre-built and may be served without a rebuild; a
pulled source that does rebundle locally gets its graph recorded like any other.
A local source with no list (a catalog an earlier binary wrote) is stale once,
so its bundle is rebuilt and its list recorded. A bundle attempt that fails
records the fallback, so a failing source is not retried on every command. A
good bundle whose graph cannot be read (a `deno info` timeout under load)
records the fallback marked graph pending, and the warm scan finds that local
source stale once more (swamp-club#3487). `rebundleAndUpdateCatalog` clears the
mark before it can return or throw, so the retry is used up however it ends: it
records the graph, or keeps the fallback for good when the graph fails again. A
graph naming more than `MAX_SOURCE_MODULES` (10,000) modules records the
fallback without a retry, and the catalog refuses longer lists. A catalog row
whose source no longer declares the kind's export is given the fallback too, so
it settles.
Production loaders get the reader from `createDenoInfoModuleGraphReader`;
`integration/extension_loader_wiring_rules_test.ts` keeps each construction that
has a catalog passing it. Two changes are not seen: adding a `deno.json` that
was not discovered at bundle time, and a pulled extension's shared sources
outside its kind's directory.

**Unreadable dependencies.** `computeSourceFingerprint`
(`src/domain/extensions/bundle_freshness.ts`) substitutes the internal
`UNREADABLE_PLACEHOLDER` constant for any dependency it cannot hash, so broken
transitive deps give a stable fingerprint. The failure then surfaces at
`bundleAndIndexOne` as `BundleBuildFailed`. Zod schema validation failures (the
bundle built but its export was rejected) surface as `ValidationFailed`, via a
`ValidationError` subclass carrying the bundle path and fingerprint (see
`validation_error.ts`).

**Forward-only revert posture.** To revert, delete `_extension_catalog.db`; the
next cold-start rebuilds it from disk.

## `swamp doctor extensions` — aggregate-state rendering and repair

`swamp doctor extensions` (`src/cli/commands/doctor_extensions.ts`) does two
things:

1. **Aggregate-state rendering**: per-extension RowState distribution, orphan
   detection and summary rollups, in both `log` and `json` modes. It always runs
   after the existing invalidation-guard checks. `--verbose` adds per-source
   detail.

2. **Repair**: `--repair` prunes Tombstoned/OrphanedBundleOnly catalog rows and
   deletes unreferenced `.js` files in `<kind>-bundles/`. `--dry-run` previews
   the repair; `-y`/`--yes` (alias `-f`/`--force`) skips the confirmation
   prompt. There is no `--apply` flag.

**Bundle naming convention:** a rebundle overwrites the file (not
content-addressed), so orphans grow by one per deleted source. The `bundle_path`
column is the source of truth for which files are referenced.

**Event model:** `DoctorExtensionsReport` gains `aggregateState`,
`repairReport` and `recentTransitions` fields, with no new event kinds, so
existing `--json` consumers keep working.

**`recentTransitions`**: an array, always present (empty when nothing changed),
filled from `ReconcileResult.transitions[]`. Each entry has `sourcePath` (from
`SourceLocation.canonicalPath`, matching `sourceDetails[].sourcePath`),
`fromState`, `toState` and `reason`. There is no timestamp, because every
`doctor extensions` run triggers reconcile and all transitions come from the
current process. JSON mode always includes the array; log mode shows it only
with `--verbose`. It comes through the
`DoctorExtensionsDeps.getRecentTransitions` callback, so the generator stays
free of infrastructure.

**Repair safety:** repair never touches Indexed and Bundled rows.

**Member collisions and warning categories:** after the registries load, doctor
loads every behavior type that an extension row targets, so extensions attach
and collisions resolve. The report's `memberCollisions` array lists each
collision with its winner (null when a base-behavior member wins) and its
losers. Each warning keeps the category it was raised with
(`TypeExtractionFailed`, `MemberCollision`, or `ExtensionAttachFailed`). Both
are advisory and never change `overallStatus`. The CLI and the serve admin
handler build these through the same helpers, `toDoctorWarnings` and
`extensionMemberDoctorDeps`.

## Lazy Per-Bundle Loading

Each extension bundle is imported on demand, not all at once, so CLI response
time stays constant however many extensions are installed.

### Architecture

**Extension Catalog**: a SQLite database at `.swamp/_extension_catalog.db`
indexes every known bundle type. Each row stores the normalized type
(`type_normalized`), bundle path, source path, source mtime, source fingerprint
(sha-256 content hash), version, the RowState discriminant (`state`) and, for
extensions, the base type it targets (`extends_type`)
(`src/infrastructure/persistence/extension_catalog_store.ts`). The content
fingerprint decides freshness; `source_mtime` is kept only for observability.
The catalog sits at the `.swamp` root because all registry types (behaviors,
vaults, datastores, reports) share it. It is independent of the data catalog
(`_catalog.db`) used for data queries.

A `kind` column (`model`, `extension`, `vault`, `datastore`, `report`) lets one
catalog serve every registry type. The behavior, vault, datastore and report
registries all register lazy entries from it (`registerLazy` in each registry).
The per-kind `populated:<kind>` marker in `bundle_meta` records whether a kind
has been fully indexed.

**Loading Flow**:

1. On the first `ensureLoaded()` call, the behavior registry's loader runs
   `buildIndex()`, which:
   - Checks the catalog's `populated` flag.
   - If populated: scans source directories and computes a sha-256 content
     fingerprint over each entry point plus its transitive local `.ts`
     dependencies. It compares that with the stored fingerprint, rebundles only
     changed files, then registers lazy entries for every type from the catalog
     without importing bundles. A changed file's type is learned by probing
     its new bundle in isolation (see Probed Indexing below), not by importing
     it into the command's isolate.

     Fingerprints replaced mtime-based freshness in issue #125, because mtime
     was unreliable with atomic-rename saves, mtime-preserving sync tools and
     sub-millisecond edits.

     The fingerprint is **total**. If a transitive dep is unreadable (broken
     symlink, deleted file, FilesystemLoop), its hash entry becomes a stable
     sentinel instead of throwing. A stable broken state then gives a stable
     fingerprint, and the entry is not marked permanently stale (#208). Fixing
     the dep turns the sentinel back into a real hash and triggers a rebundle.
     All four kinds (behaviors, vaults, datastores, reports) share this, since
     they share the freshness service.

     Likewise, a source can bundle and import cleanly but fail schema
     validation (e.g. a required field was removed). Its catalog row is then
     upserted with the new fingerprint and `state = ValidationFailed`. (The
     former `validation_failed` column was folded into `state`.) Fingerprint
     comparison still works: `findStaleFiles` sees the row, so a stable broken
     source stays not-stale. Registration skips non-`Indexed` rows, so the
     extension stays out of the registry until the source is fixed. Editing the
     source gives a new fingerprint, marks the file stale, triggers a rebundle
     and moves the row back to `Indexed`. This covers only the steady-state
     `rebundleAndUpdateCatalog` hot path. The cold-start parses (initial
     `loadModels` Pass 1, the by-name `loadSingleType`, and the
     extension-attach predicate) keep their existing failure handling, as they
     are outside the read-only steady-state loop.
   - **Fingerprint preservation on build failure (issue #265).** When
     `bundleWithCache` returns the cached `.js` instead of a fresh bundle
     (`fromCache: true`), the caller `rebundleAndUpdateCatalog` keeps the
     catalog's stored `source_fingerprint` rather than writing the new one.
     The file stays "stale", so `findStaleFiles` retries on the next warm
     start. Writing the new fingerprint next to the old bundle would hide the
     staleness for good: fingerprints would match and nothing would retry.
     `BundleResult` (`bundle_freshness.ts`) records why the bundle came from
     cache in `cacheReason`, and each case logs at most one warning:
     - `trusted-pulled`: a pulled extension's existing bundle is reused on
       purpose, with no rebundle attempt (the bundle exists and either the
       caller passed `trustPulledCache` or `isExpectedBundleFailure` is true).
       Nothing failed, so both `load()` and reconcile log at debug only.
     - `rebundle-failed` with `expectedFailure: false`: `deno bundle` threw
       although a project `deno.json`/`deno.jsonc` exists. `bundleWithCache`
       emits the one warning
       `Rebundle failed for <file>, using cached bundle: <error>`, and the
       reconcile line drops to debug.
     - `rebundle-failed` with `expectedFailure: true`: no project deno config
       exists between the source file and the repo root
       (`isExpectedBundleFailure`), so failure is expected, usually from bare
       specifiers. `bundleWithCache` logs at debug and reconcile emits the one
       warning `Bundle could not be regenerated for <file> — source fingerprint
       preserved, will retry on next command`.

     The fingerprint is kept the same way in all three cases. The reconcile log
     fires only when stored and new fingerprints differ, never on a normal
     cache hit with unchanged source. `findStaleFiles` treats a changed
     fingerprint as stale, and also retries `BundleBuildFailed` rows whose
     fingerprint matches, as described under the warm-start path above
     (`src/domain/extensions/bundle_freshness.ts`). Warm start and reconcile
     work on independent axes.

   - If not populated (first run or DB deleted): bundles every source file
     without importing it into V8 (`load()` with `indexOnly: true`), fills the
     catalog from source extraction and registers lazy entries. This avoids OOM
     in repos with thousands of behavior definitions: bundles stay on disk until
     `ensureTypeLoaded()` imports them. Schema validation errors wait until the
     type is first used, as in warm start.

2. `types()` returns both fully loaded and lazy type names, so commands like
   `behavior type search` import no bundles.

   `vault type search` and `datastore type search` also show each type's
   declared name and description, which a lazy entry does not carry. They
   read both from the entry's source text (`listVaultTypes`,
   `listDatastoreTypes`, using the extractors `extension push` uses) and
   still import nothing: a listing must not run extension code, which can
   exit, hang or print at import. A name the source computes falls back to
   the type id; a computed description falls back to the catalog's for a
   vault and to empty for a datastore.

3. When a specific type is needed (e.g. `behavior get`, `behavior create`),
   `ensureTypeLoaded(type)` looks up its bundle path in the catalog and imports
   only that bundle, plus any extension bundles targeting the base type.

   A type that is already registered never reaches the type loader: built-in
   types such as `command/shell`, and types that a full load or the
   auto-resolver registered directly. For these, `ensureTypeLoaded` runs the
   extension attacher once per type per process instead
   (`ModelRegistry.setExtensionAttacher`, wired by the CLI to
   `attachPendingExtensionsForType`). Control-plane types are never extended:
   `ModelRegistry.extend` and `applyExtensionMembers` refuse them, and the
   behavior adapter fails an add-on that targets one with `Cannot extend
   control-plane model type`, on every attach path. If the attacher itself fails
   (for example the catalog is unreadable), the failure is logged and retried on
   the next call, and the base type stays usable without its add-ons. A single
   add-on that fails to import is skipped and logged, and is retried by the next
   attach pass: a hot reload, a new attacher or a new process (swamp-club#2846).

4. Concurrent callers for the same type share one load promise (per-type
   memoization). `ensureTypeLoaded` also awaits a pending load promise when the
   type is already in the registry. `loadSingleType` registers the base type via
   `promoteFromLazy` before attaching extensions, so a caller arriving between
   those steps must wait for the extensions to be merged (swamp-club#521).

### Probed Indexing

Indexing has to evaluate a bundle to learn its type whenever source text is
not enough: a new or edited source on the warm path, the startup reconcile
(`ReconcileFromDiskService`), the typeless-row heal, and an install's index
of pulled sources. Those evaluations **probe** the bundle rather than load it
(swamp-club#3374). A probe imports the bundle in a separate probe host process
and answers with plain data: the exported type, version and description, or why there is
none. Loading, which makes a type usable, still imports the bundle into the
command's isolate, and only happens when the type is used.

`BundleProber` (`src/domain/extensions/bundle_prober.ts`) is the port;
`ProcessBundleProber` (`src/infrastructure/runtime/process_bundle_prober.ts`)
implements it. The host is swamp itself: `main.ts` hands a process started
with `__swamp_bundle_probe_host` to `bundle_probe_host.ts` before any CLI
work, as it does for the Litestream supervisor, and from source the prober
runs that file with `deno run`. The host reads one request per line on stdin
and answers on stdout, behind a per-host prefix that tells its replies from
anything a bundle writes there. The probe logic itself is
`bundle_probe.ts`. The CLI's index loaders,
its startup reconcile, `swamp doctor extensions` and `swamp extension pull`
pass one. An `ExtensionLoader` built without a prober imports in-process: the
full-load path (`load()` without `indexOnly`, serve hot-reload, the
auto-resolver), the local model refresher a long-lived process runs before
each run (it loads what it refreshes, so an edited add-on to a type already in
use is attached straight away), and the path unit tests use.

What a source does at import therefore cannot reach a command that does not
use it:

- **Exit.** `Deno.exit` in the host throws, so the import stops there. The
  source is recorded as `ValidationFailed`.
- **Hang.** An import that has not settled after 10 seconds
  (`DEFAULT_PROBE_TIMEOUT_MS`) is abandoned and its host killed, which also
  stops a bundle spinning in synchronous code: a Deno worker cannot be
  stopped there, so the first prober, which used one, left such a bundle
  running for the life of the process (swamp-club#3494). The source is
  recorded as `ValidationFailed`. Only the bundle's own import is timed: the
  host reports when it is ready to import, and the timeout starts then, so
  starting the host and loading the kind adapter never counts against a
  source.
- **Print.** `console` output in the host is captured and logged at debug,
  and so is anything the bundle writes to the host's stdout or stderr
  directly.
- **Throw.** Reported as a failed import and recorded as `BundleBuildFailed`,
  as an in-process import that threw was, so it is retried on the next
  command.

An exit or a hang is recorded as `ValidationFailed` because that state is not
retried until the source fingerprint changes: one command pays the timeout, not
every command. The exception is a reconcile, which probes every source that is
not `Indexed`: `swamp doctor extensions` reconciles on each run, so it pays the
timeout again for a source that still hangs. The user is warned once, with the
source's path, the reason and how to retry: edit a local source, upgrade or
re-pull a pulled one. Anything that is not the bundle's doing is reported as a
failed import, which is retried, and never pinned to the source: a host that
does not start, one that dies, one from another build (a binary `swamp update`
replaced under a running swamp, which is asked to restart), or a prober
released under a probe. On the warm
path a source that no aggregate knows yet gets a `ValidationFailed` catalog row
directly, since without a row it would be stale, and probed again, on every
scan.

A probed pass registers nothing and imports nothing into the command's
isolate. A type whose source changed becomes a lazy entry like any other, and
model add-ons are not attached at index time: a lazy base type attaches them
when it is loaded, and an already registered one through the registry's
extension attacher on first use (swamp-club#2846). A source that the same
command goes on to use is therefore evaluated twice, once in the host and
once on load.

The host is robustness isolation, **not a sandbox**. It runs with swamp's
permissions, environment and filesystem, so it does not make untrusted
extension code safe to index. The reply prefix is random for each host, so no
output turns into a reply by accident, but a bundle that reads it could fake
one on purpose.

One host serves a pass's probes in turn and is replaced after any probe that
did not finish cleanly. Work a bundle leaves behind (a timer that throws, a
rejected promise) is swallowed in the host so it cannot end the host under
the next bundle; a host that dies anyway is dropped. Each pass releases its
prober, which kills the host and waits for it to end. An install indexes an
extension and its dependencies concurrently through one prober and releases
it once, after all of them, and the tree indexer's lanes share one prober.
The host is started by the first probe, so a pass with nothing to probe
starts none. A host stays in swamp's process group, so a Ctrl+C reaches it,
and on Windows runs in a kill-on-close Job Object. On Linux and macOS, a swamp
that ends without releasing its prober (killed outright, not by Ctrl+C) leaves
its host to exit when it next reads its closed stdin, which a host spinning in
a bundle's synchronous code never does. A process a bundle starts ends with
the host, as it ended with a terminated worker: stopping a host lists its
children before killing it and kills them too (on Windows the job ends them),
though not processes they started in turn, nor any once the host has already
exited. Listing them needs `pgrep`, so where it is missing they are left
running. Until then such a process holds the
host's output pipes open, so stopping a host reads its last output for a short
grace period rather than to the end. Starting one costs a
process start of the swamp binary (about half a second, as `main.ts` loads
the CLI before it reads the marker), paid once per pass that probes.

### Self-Healing

Deleting `_extension_catalog.db` triggers a cold-start rebuild on next access:
source files are bundled without importing into V8 and the catalog is refilled
from source extraction. Types are then lazy entries imported on demand. The
`populated` flag follows the data catalog's backfill pattern.

## Reporting Issues Against Extensions

`--extension <name>` (alias `-x`) on the `swamp issue bug|feature|security`
commands files a report against a specific extension. The CLI routes it by the
extension's collective and declared `repository`:

1. **`@swamp/*` extensions** go to the existing swamp-club Lab, the same
   endpoint `swamp issue bug` uses. The extension name, installed version and
   the reporter's environment are appended to the body under an
   `## Environment` section. The title is unchanged.

2. **Third-party extensions with `repository` set** go to that upstream
   repository. If the `gh` CLI is installed and authenticated (`GH_TOKEN` or
   `gh auth login`), the report is created with `gh issue create`. Otherwise the
   CLI opens the provider's new-issue URL in the browser with title and body
   filled in (supported for GitHub and GitLab). For other hosts it opens the
   repo root and prints the prepared body for manual pasting.

3. **Third-party extensions without `repository`** are refused cleanly. The
   guidance points reporters to the extension's swamp-club page, which has
   publisher contact info, and tells publishers to add a `repository:` field to
   their manifest. The exit code stays 0; the refusal is informational.

### Security Routing

For `swamp issue security --extension <name>` against a third-party GitHub
repository, the CLI first checks whether GitHub's Private Vulnerability
Reporting (PVR) is enabled, via
`gh api repos/<owner>/<repo>/private-vulnerability-reporting`:

- **PVR enabled**: open the GitHub advisory form
  (`<repo>/security/advisories/new`). It is structured and can't be prefilled
  from the URL, so the user fills it in.
- **PVR disabled**: **refuse**. This is a security guardrail that must not be
  removed. The CLI never falls back to a public issue for a security report,
  since that would silently publish the vulnerability. The refusal tells the
  reporter to contact the publisher privately and the publisher to enable PVR at
  `<repo>/settings/security_analysis`.
- **PVR check failed or gh unavailable**: open the advisory URL and show a
  fallback issue URL in the output. The user decides after seeing GitHub's
  response.

GitHub and GitLab differ on purpose. GitLab opens the normal issue form with a
"toggle confidential" warning, because confidential issues exist on every GitLab
repo and so always give the user a safe path. GitHub's PVR is opt-in per repo,
so with PVR off the CLI refuses rather than trust the reporter not to file
publicly.

### Publish-Time Nudge

When `swamp extension push` runs on a manifest without a `repository` field, the
CLI warns that users will not be able to file issues via `--extension`. The
warning never blocks the push; some publishers may leave out `repository`
on purpose.
