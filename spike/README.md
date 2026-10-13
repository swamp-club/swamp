# swamp-club#3234 Litestream spike (throwaway)

Prototype and measurement scripts behind
`design/enablers/datastore-litestream.md`. This branch is never merged.

- `lib.ts` — node:sqlite writer, Litestream config, control-socket client.
- `exp_compat.ts` — Q2 checkpoint regimes.
- `exp_latency.ts` — Q4/Q8 per-command vs long-lived cost, forced sync, lag.
- `exp_crash.ts` — Q5 kill -9 of replicator, writer, and machine loss.
- `exp_failover.ts`, `exp_zombie.ts` — Q6 restore, follow mode, fences.
- `platform_probe.ts`, `ci_run.sh` — Q7, run by
  `.github/workflows/spike-3234-litestream.yml` on Windows/macOS/Linux.
- `golib/` — option (b), Litestream as a c-shared library via `Deno.dlopen`.
- `rtt_proxy.ts`, `creds_server.ts` — injected RTT and container credentials.
- `results/` — raw JSON lines from the runs quoted in the record.

## swamp-club#3357: Phase 4A bucket-latency model (throwaway)

Branch `spike/3357-litestream-buckets`, cut from main at `34b275cb` and rebased onto main with the fenced writer lease
(swamp-club#3359) with this
directory brought over from `spike/3234-litestream`. Never merged. The
record is the "Phase 4A" section of `design/enablers/datastore-litestream.md`.

Real buckets were out of scope, by direction: every figure comes from
ministack (S3) and fake-gcs-server 1.56.1 (GCS) behind a latency model.
MinIO could not be pulled (Docker Hub denies `minio/minio`, quay.io returns
401).

- `bucket_proxy.ts` — the latency model: one RTT per request, K extra RTTs
  per new client connection (TCP + TLS 1.3), a throughput cap shared per
  direction, and counts of requests, bytes and connections. It reads a whole
  request body before forwarding and refuses a short one, as a real bucket
  does; streaming it on let an upload abandoned by a stopping sidecar land as
  a truncated object.
- `model.ts` — profiles (`s3-zero`, `gs-zero`, `s3-near` 20 ms / 200 Mbit/s,
  `s3-far` 150 ms / 100 Mbit/s, `gs-near` 20 ms / 200 Mbit/s), credential
  stand-ins (container endpoint delayed 0 / 50 / 600 ms), a clean environment.
- `creds_server.ts` — the delayed container-credentials endpoint.
- `exp_bucket_sync.ts` — Q1, forced sync, cold per-command against warm.
- `exp_command.ts` — Q2, whole v3 write commands (spike binary) against v2
  push through the same model.
- `exp_restore.ts` — Q3, restore 1 MB / 100 MB / 1 GB and `restore -f` lag.
- `exp_growth.ts` — Q4, replica growth over a day of commands.
- `exp_idle.ts` — Q5, idle-gap connection reuse and the idle-sidecar faults.
- `exp_idle_restart.ts` — Q5, whether a fresh sidecar after an idle timeout
  re-snapshots.
- `exp_wal_trace.ts` — traces the `commits.db-wal` header through every step
  of a write command (`SWAMP_SPIKE_WAL_LOG`); found the re-snapshot trigger.
  Variant `sync-close-stop` is the fix.
- `exp_restore_objects.ts` — restore time of an uncompacted per-command
  replica, and after a long-lived sidecar compacts it.
- `exp_lineage.ts` — replica path per fence against per lineage, under the
  fenced writer lease, with another writer and a killed command.
- `probe_percommand_snapshot.ts` — reproduces the per-command re-snapshot
  around real CLI commands (Litestream debug log).
- `probe_wal_salt.ts` — the synthetic writer that does *not* reproduce the
  per-command re-snapshot (see the record).
- `../src/infrastructure/datastore_v3/spike_litestream.ts` and its two hooks
  in `v3_repo_context.ts` — the prototype: `SWAMP_SPIKE_LITESTREAM=percommand`
  or `idle`.
- `results/3357/` — raw JSON lines.

```sh
gh release download v0.5.17 --repo benbjohnson/litestream -p checksums.txt \
  -p 'litestream-0.5.17-darwin-arm64.tar.gz'   # check the SHA-256, untar
export LITESTREAM_BIN=$PWD/litestream
docker run -d --name ministack-3357 -p 47357:4566 ministackorg/ministack:latest
docker run -d --name fakegcs-3357 -p 47358:4443 fsouza/fake-gcs-server:1.56.1 \
  -scheme http -port 4443 -public-host localhost:47358
curl -X PUT localhost:47357/lsbucket
curl -X POST 'localhost:47358/storage/v1/b?project=test' -d '{"name":"lsbucket"}'
deno run compile && export SWAMP_BIN=$PWD/swamp   # from the repo root
cd spike
deno run -A exp_bucket_sync.ts s3-far sso 30        # <profile> <creds> <runs>
deno run -A exp_command.ts s3-near static 20
deno run -A exp_restore.ts s3-near static 1,100,1000 20 10
GROWTH_MODE=idle deno run -A exp_growth.ts typical-idle 200 50
deno run -A exp_idle.ts gaps s3-far 1,5,15,30,60,100,130 3
deno run -A exp_idle.ts faults s3-near
```
