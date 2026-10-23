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

import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { useSwamp } from "../client/SwampProvider.tsx";
import { useRequest } from "../client/useRequest.ts";
import type { SharedApprovals } from "../client/useApprovals.ts";
import { extractObject } from "../client/extract.ts";
import {
  activeRunIds,
  type ResumableRun,
  resumeStateFor,
} from "../client/resume_state.ts";
import { useActiveRunsRefetch } from "../client/useActiveRunsRefetch.ts";
import type { HealthSnapshot } from "../client/useHealthStream.ts";
import { useRequestAllPages } from "../client/useRequestAllPages.ts";
import { useWorkflowCatalog } from "../client/useWorkflowCatalog.ts";
import { summariesByName, useRunSummary } from "../client/run_summary.ts";
import { ResumeAction } from "../components/ResumeAction.tsx";
import { CancelRunAction } from "../components/CancelRunAction.tsx";
import type { CancelOutcome } from "../components/cancel_confirm.ts";
import {
  type ApprovalInfo,
  expiredApprovals,
  type ExpiredGate,
  pendingApprovals,
} from "../client/approvals.ts";
import { SignalWaitsPanel } from "../components/SignalWaitsPanel.tsx";
import {
  type DecidedGate,
  decidedGate,
  decidedLabel,
  type Decision,
  decisionOutcome,
  decisionReason,
  gateKey,
  MAX_DECISION_REASON_LENGTH,
  refusalMessage,
} from "../components/decision_confirm.ts";
import { useDecidedGates } from "../client/useDecidedGates.ts";
import { RequestError } from "../client/stream.ts";
import {
  PendingSignalsPanel,
  useHeldSignalClock,
} from "../components/PendingSignalsPanel.tsx";
import {
  heldAt,
  pendingSignalRows,
  signalWaitRows,
} from "../client/signal_wait_state.ts";
import { RouteLink } from "../components/RouteLink.tsx";
import { RunHistoryBar } from "../components/RunHistoryBar.tsx";
import { type Stat, StatPills } from "../components/StatPills.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { FilterBar, useWorkflowFilter } from "../components/FilterBar.tsx";
import { GateDetails } from "../components/GateDetails.tsx";
import {
  SkeletonList,
  SkeletonPills,
  SkeletonRunHistory,
} from "../components/Skeleton.tsx";
import { EMPTY_FILTER, isFilterActive } from "../lib/workflow_facets.ts";
import {
  filterRowsByWorkflow,
  MAX_WORKFLOW_NAMES,
} from "../lib/run_filters.ts";
import { formatWait, oldestFirst } from "../lib/wait_order.ts";
import type { WorkflowJobDef } from "../lib/gate_dag.ts";
import {
  formatAbsoluteTime,
  formatCount,
  formatRelativeTime,
} from "../lib/format.ts";
import "../styles/approvals.css";
import "../styles/mini-dag.css";

interface ApprovalsProps {
  /** Serve's live health snapshot; its active runs are runs serve drives. */
  health?: HealthSnapshot | null;
  approvalsRequest: SharedApprovals;
}

/** A suspended run as the run search lists it. */
interface SuspendedRun extends ResumableRun {
  startedAt?: string;
}

const HISTORY_SLOTS = 12;
/** A wait longer than this reads as overdue. */
const LONG_WAIT_MS = 60 * 60 * 1000;

export function Approvals({ health, approvalsRequest }: ApprovalsProps) {
  const { request } = useSwamp();
  const catalog = useWorkflowCatalog(health ?? null);
  const [filter, setFilter] = useWorkflowFilter();

  const { data, refetch, refresh: refreshApprovals, readFresh } =
    approvalsRequest;
  useEffect(() => refetch(), [refetch]);
  const { decided, hold } = useDecidedGates(data);
  // Every suspended run, page by page: a single capped page would drop
  // runs awaiting resume once there are more than the cap.
  const {
    data: suspendedData,
    error: suspendedError,
    refetch: refetchSuspended,
  } = useRequestAllPages<SuspendedRun>("workflow.run.search", {
    status: "suspended",
  });
  // Refused to a caller who may read no workflow: nothing is listed then.
  // Refetched only with the gates, never on a timer: the listing settles
  // expired waits as it reads. A held signal lapsing changes no run, so the
  // page and the pending signals panel drop lapsed ones on the same clock.
  const { data: waitsData, refetch: refetchWaits } = useRequest(
    "workflow.waits",
    { includeSignalled: true, includePending: true },
  );
  const signalWaits = signalWaitRows(waitsData);
  const heldSignalRows = pendingSignalRows(waitsData);
  const heldClock = useHeldSignalClock(heldSignalRows.length > 0);
  const allHeldSignals = heldAt(heldSignalRows, heldClock);
  const suspendedRuns = useMemo(() => suspendedData ?? [], [suspendedData]);
  // Runs serve drives now, whoever approved them (swamp-club#3005).
  const servedRuns = activeRunIds(health?.activeRuns);
  const refetchGatesAndRuns = useCallback(() => {
    refetch();
    refetchSuspended();
    refetchWaits();
  }, [refetch, refetchSuspended, refetchWaits]);
  useActiveRunsRefetch(health?.activeRuns, suspendedRuns, refetchGatesAndRuns);
  const [notice, setNotice] = useState<string | null>(null);
  const [resumingRuns, setResumingRuns] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const refresh = useCallback(() => {
    refreshApprovals();
    refetchSuspended();
    refetchWaits();
  }, [refreshApprovals, refetchSuspended, refetchWaits]);

  const [error, setError] = useState<string | null>(null);
  // Held here, not by the row: the refetch removes the cancelled run's row.
  const [cancelled, setCancelled] = useState<CancelOutcome | null>(null);
  // Decisions in flight, by gate: both buttons wait until it lands.
  const [deciding, setDeciding] = useState<ReadonlyMap<string, Decision>>(
    () => new Map(),
  );
  const markDeciding = useCallback(
    (a: ApprovalInfo, decision: Decision | null) =>
      setDeciding((prev) => {
        const next = new Map(prev);
        if (decision) next.set(gateKey(a), decision);
        else next.delete(gateKey(a));
        return next;
      }),
    [],
  );

  const handleCancelled = useCallback(
    (outcome: CancelOutcome) => {
      setCancelled(outcome);
      refresh();
    },
    [refresh],
  );

  // A decision that lands holds its gate settled until a listing drops it;
  // one serve refuses is checked against a fresh listing, so a gate decided
  // elsewhere reads as decided rather than as a failure (swamp-club#3697).
  const handleDecision = useCallback(
    async (
      a: ApprovalInfo,
      decision: Decision,
      reasonText: string,
    ): Promise<boolean> => {
      let landed = false;
      let reconciled = false;
      setError(null);
      setNotice(null);
      markDeciding(a, decision);
      const reason = decisionReason(reasonText);
      try {
        const reply = await request<
          { data?: { autoResumed?: boolean } }
        >(decision === "approve" ? "workflow.approve" : "workflow.reject", {
          workflowIdOrName: a.workflowName,
          stepName: a.stepName,
          runId: a.runId,
          ...(reason !== undefined ? { reason } : {}),
        });
        const settled = decidedGate(decision, reply, new Date().toISOString());
        hold(a, settled);
        landed = true;
        if (reply.data?.autoResumed) {
          setResumingRuns((prev) => new Set(prev).add(a.runId));
        }
        setNotice(
          `${a.workflowName} / ${a.stepName}: ${decidedLabel(settled)} at ${
            formatAbsoluteTime(settled.decidedAt)
          } — ${decisionOutcome(decision, reply)}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Only a refusal from serve can mean the gate was already decided;
        // a lost connection leaves the gate as it was.
        let stillListed = true;
        if (err instanceof RequestError) {
          const fresh = await readFresh();
          reconciled = true;
          if (fresh !== null) {
            stillListed = pendingApprovals(fresh).some((g) =>
              gateKey(g) === gateKey(a)
            );
          }
        }
        if (stillListed) setError(refusalMessage(decision, message, true));
        else setNotice(refusalMessage(decision, message, false));
      }
      markDeciding(a, null);
      // Reconciliation already updated the shared listing, including the badge.
      if (!reconciled) refreshApprovals();
      refetchSuspended();
      refetchWaits();
      return landed;
    },
    [
      request,
      refreshApprovals,
      readFresh,
      refetchSuspended,
      refetchWaits,
      markDeciding,
      hold,
    ],
  );

  // Longest wait first in every list: the oldest gate is the most urgent.
  const filterRows = <T,>(rows: readonly T[], nameOf: (row: T) => string) =>
    filterRowsByWorkflow(
      rows,
      filter,
      nameOf,
      catalog.byName,
      catalog.facetsOf,
    );
  const allPending = oldestFirst(pendingApprovals(data), (a) => a.suspendedAt);
  const allExpired = oldestFirst(expiredApprovals(data), (g) => g.suspendedAt);
  const allAwaiting = oldestFirst(
    suspendedRuns.filter((run) => resumeStateFor(run) !== null),
    (run) => run.startedAt,
  );
  const pending = filterRows(allPending, (a) => a.workflowName);
  const expired = filterRows(allExpired, (g) => g.workflowName);
  const awaitingResume = filterRows(allAwaiting, (r) => r.workflowName);
  const waits = filterRows(signalWaits, (w) => w.workflowName);
  const heldSignals = filterRows(allHeldSignals, (p) => p.workflowName);

  const gatesLoaded = data !== null;
  const gatesError = approvalsRequest.error && !gatesLoaded
    ? approvalsRequest.error
    : null;
  const filtering = isFilterActive(filter);
  const allCount = allPending.length + allExpired.length + allAwaiting.length +
    signalWaits.length + allHeldSignals.length;
  const shownCount = pending.length + expired.length + awaitingResume.length +
    waits.length + heldSignals.length;

  // One summary for every workflow on the page, for the history strips.
  // Keyed by the names, so a refetch listing the same workflows keeps the
  // summary request as it is.
  const namesKey = [
    ...new Set(
      [...allPending, ...allExpired, ...allAwaiting].map((r) => r.workflowName),
    ),
  ].sort().join("\u0000");
  const workflowNames = useMemo(
    () => (namesKey ? namesKey.split("\u0000") : []),
    [namesKey],
  );
  const historyRequest = useRunSummary(
    {
      // Past serve's cap, every workflow's history; looked up by name.
      workflows: workflowNames.length <= MAX_WORKFLOW_NAMES
        ? workflowNames
        : undefined,
      recentLimit: HISTORY_SLOTS,
    },
    { enabled: workflowNames.length > 0 },
  );
  const history = summariesByName(historyRequest.summary);
  const historyFor = (workflowName: string): ReactNode => {
    const recent = history.get(workflowName)?.recent;
    if (recent) {
      return (
        <RunHistoryBar
          runs={recent}
          workflowName={workflowName}
          slots={HISTORY_SLOTS}
          height={12}
          noun={`runs of ${workflowName}`}
        />
      );
    }
    return historyRequest.loading
      ? <SkeletonRunHistory slots={HISTORY_SLOTS} height={12} />
      : null;
  };

  const awaitingCount = awaitingResume.length +
    waits.filter((w) => w.awaitingResume).length;
  const stats: Stat[] = [
    {
      label: "pending",
      value: formatCount(pending.length),
      tone: pending.length > 0 ? "warning" : "neutral",
      title: "Gates waiting for a decision",
    },
    {
      label: "expired",
      value: formatCount(expired.length),
      tone: expired.length > 0 ? "danger" : "neutral",
      title: "Gates past their timeout: they can only be cancelled",
    },
    {
      label: "awaiting resume",
      value: formatCount(awaitingCount),
      tone: awaitingCount > 0 ? "running" : "neutral",
      title: "Approved or signalled runs waiting to be resumed",
    },
  ];
  if (signalWaits.length > 0) {
    stats.push({
      label: "signal waits",
      value: formatCount(waits.length),
      title: "Runs waiting for a signal",
    });
  }
  if (allHeldSignals.length > 0) {
    stats.push({
      label: "pending signals",
      value: formatCount(heldSignals.length),
      title: "Signals sent by key, held for the next wait on their key",
    });
  }

  const clearFilters = (
    <button
      type="button"
      className="btn-sm"
      onClick={() => setFilter(EMPTY_FILTER)}
    >
      Clear filters
    </button>
  );

  return (
    <div className="approvals-page">
      <div className="page-header">
        <h1>Approvals & Signals</h1>
        <div className="header-right">
          {gatesLoaded && suspendedData !== null
            ? <StatPills stats={stats} label="Approvals & Signals summary" />
            : !gatesError && <SkeletonPills count={3} />}
        </div>
      </div>

      <FilterBar
        filter={filter}
        onChange={setFilter}
        prefixes={catalog.prefixes}
        webhooks={catalog.webhookRoutes}
        placeholder="Search workflows"
        shown={shownCount}
        total={allCount}
        noun="items"
      />

      <div aria-live="polite" className="approvals-notices">
        {notice && <div className="approvals-notice">{notice}</div>}
        {error && (
          <div className="approvals-notice is-error" role="alert">
            {error}
          </div>
        )}
      </div>
      {cancelled && (
        <div className="resume-action approvals-cancelled">
          <span className="resume-label">{cancelled.message}</span>
          {cancelled.nestedRunsLeft.map((run) => (
            <div key={run.runId}>
              <div className="resume-note">
                {run.workflowName}{" "}
                <span className="mono">{run.runId.slice(0, 8)}</span>{" "}
                — cancel it with:
              </div>
              <code className="resume-command mono">{run.cancelCommand}</code>
            </div>
          ))}
        </div>
      )}

      <section className="panel" aria-labelledby="approvals-pending">
        <div className="panel-header">
          <h2 className="panel-title" id="approvals-pending">
            Pending{" "}
            {gatesLoaded && (
              <span className="panel-count">{pending.length}</span>
            )}
          </h2>
          {gatesLoaded && pending.length > 1 && (
            <span className="approvals-order">Longest waiting first</span>
          )}
        </div>
        {gatesError
          ? (
            <EmptyState
              title="Couldn't load approvals"
              action={
                <button
                  type="button"
                  className="btn-sm"
                  onClick={refetchGatesAndRuns}
                >
                  Try again
                </button>
              }
            >
              {gatesError}
            </EmptyState>
          )
          : !gatesLoaded
          ? <SkeletonList rows={3} label="Loading approvals" />
          : pending.length === 0
          ? (
            filtering && allPending.length > 0
              ? (
                <EmptyState
                  title="No pending approvals match these filters"
                  action={clearFilters}
                >
                  {allPending.length} pending{" "}
                  {allPending.length === 1 ? "gate is" : "gates are"}{" "}
                  hidden by the filters.
                </EmptyState>
              )
              : (
                <EmptyState title="No pending approvals">
                  Gates appear here when a run reaches an approval step.
                </EmptyState>
              )
          )
          : (
            <ul className="approval-list">
              {pending.map((a) => (
                <GateRow
                  key={gateKey(a)}
                  gate={a}
                  waitingSince={a.suspendedAt}
                  waitingLabel="Waiting"
                  history={historyFor(a.workflowName)}
                  note={a.parentRun &&
                    (a.parentWaiting
                      ? `Nested run of ${a.parentRun.workflowName}: resume the parent after this run finishes`
                      : `Nested run of ${a.parentRun.workflowName}: the parent no longer waits on it`)}
                  actions={
                    <DecisionControl
                      gate={a}
                      deciding={deciding.get(gateKey(a)) ?? null}
                      decided={decided.get(gateKey(a)) ?? null}
                      onDecide={handleDecision}
                    />
                  }
                />
              ))}
            </ul>
          )}
      </section>

      {expired.length > 0 && (
        <section className="panel approvals-panel" aria-labelledby="ap-exp">
          <div className="panel-header">
            <h2 className="panel-title" id="ap-exp">
              Expired <span className="panel-count">{expired.length}</span>
            </h2>
            <span className="approvals-order">
              Can no longer be approved or rejected
            </span>
          </div>
          <ul className="approval-list">
            {expired.map((gate) => (
              <GateRow
                key={gateKey(gate)}
                gate={gate}
                waitingSince={gate.suspendedAt}
                waitingLabel="Waited"
                expired={gate}
                history={historyFor(gate.workflowName)}
                note={gate.parentRun &&
                  (gate.parentWaiting
                    ? `Nested run of ${gate.parentRun.workflowName}: the parent stays suspended after this cancel; cancel or resume it separately`
                    : `Nested run of ${gate.parentRun.workflowName}: the parent no longer waits on it`)}
                actions={
                  <CancelRunAction
                    runId={gate.runId}
                    workflowName={gate.workflowName}
                    workflowIdOrName={gate.workflowId}
                    onCancelled={handleCancelled}
                    onRefused={refresh}
                  />
                }
              />
            ))}
          </ul>
        </section>
      )}

      <SignalWaitsPanel
        rows={waits}
        renderResume={(row) => (
          <ResumeAction
            run={{
              runId: row.runId,
              workflowName: row.workflowName,
              status: "suspended",
              awaitingResume: true,
            }}
            onResumed={refresh}
            resuming={resumingRuns.has(row.runId) || servedRuns.has(row.runId)}
            readyBecause="signalled"
          />
        )}
      />

      <PendingSignalsPanel rows={heldSignals} now={heldClock} />

      {suspendedError && suspendedData === null && (
        <div className="approvals-notice is-error" role="alert">
          Couldn't load runs awaiting resume: {suspendedError}
        </div>
      )}

      {awaitingResume.length > 0 && (
        <section className="panel approvals-panel" aria-labelledby="ap-res">
          <div className="panel-header">
            <h2 className="panel-title" id="ap-res">
              Awaiting resume{" "}
              <span className="panel-count">{awaitingResume.length}</span>
            </h2>
            <span className="approvals-order">Oldest run first</span>
          </div>
          <ul className="approval-list">
            {awaitingResume.map((run) => {
              const driven = resumingRuns.has(run.runId) ||
                servedRuns.has(run.runId);
              return (
                <li className="approval-item" key={run.runId}>
                  <div className="approval-main">
                    <span className="approval-toggle-spacer" />
                    <div className="approval-body">
                      <div className="approval-title">
                        <WorkflowLink name={run.workflowName} />
                        <RunLink
                          workflowName={run.workflowName}
                          runId={run.runId}
                        />
                      </div>
                      {run.startedAt && (
                        <div className="approval-meta">
                          <time
                            dateTime={run.startedAt}
                            title={formatAbsoluteTime(run.startedAt)}
                          >
                            Started {formatRelativeTime(run.startedAt)}
                          </time>
                        </div>
                      )}
                      <ResumeAction
                        run={run}
                        onResumed={refresh}
                        resuming={driven}
                      />
                    </div>
                    <div className="approval-history">
                      {historyFor(run.workflowName)}
                    </div>
                    {/* Serve is already driving a run it resumes. */}
                    <div className="approval-side">
                      {!driven && (
                        <CancelRunAction
                          runId={run.runId}
                          workflowName={run.workflowName}
                          onCancelled={handleCancelled}
                          onRefused={refresh}
                        />
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function WorkflowLink({ name }: { name: string }) {
  return (
    <RouteLink
      className="approval-workflow"
      title={`Open workflow ${name}`}
      to={{
        view: "workflows",
        detail: { kind: "workflow", workflowName: name },
      }}
    >
      {name}
    </RouteLink>
  );
}

function RunLink(
  { workflowName, runId }: { workflowName: string; runId: string },
) {
  return (
    <RouteLink
      className="mono approval-run"
      title={`Open run ${runId}`}
      to={{ view: "workflows", detail: { kind: "run", workflowName, runId } }}
    >
      {runId.slice(0, 8)}
    </RouteLink>
  );
}

/** "Waiting 2h 13m", with the exact start on hover. */
function WaitTime({ label, since }: { label: string; since: string }) {
  const t = Date.parse(since);
  if (Number.isNaN(t)) return null;
  const elapsed = Date.now() - t;
  return (
    <time
      dateTime={since}
      title={`Since ${formatAbsoluteTime(since)}`}
      className={`approval-wait${elapsed > LONG_WAIT_MS ? " is-long" : ""}`}
    >
      {label} {formatWait(elapsed)}
    </time>
  );
}

/**
 * Approve and Reject, each confirmed with an optional reason. A gate this
 * viewer cannot decide shows why instead; one decided from this page shows
 * who decided it until the listing drops it.
 */
function DecisionControl(
  { gate, deciding, decided, onDecide }: {
    gate: ApprovalInfo;
    deciding: Decision | null;
    decided: DecidedGate | null;
    onDecide: (
      gate: ApprovalInfo,
      decision: Decision,
      reason: string,
    ) => Promise<boolean>;
  },
) {
  const [confirming, setConfirming] = useState<Decision | null>(null);
  const [reason, setReason] = useState("");
  const reasonId = useId();
  if (decided) {
    return (
      <div className="approval-decided" role="status">
        <span title={formatAbsoluteTime(decided.decidedAt)}>
          {decidedLabel(decided)}
        </span>
      </div>
    );
  }
  const busy = deciding !== null;
  const what = `${gate.stepName} on ${gate.workflowName}`;
  if (gate.canDecide === false) {
    return (
      <div className="approval-actions approval-cannot-decide">
        <button
          type="button"
          className="btn-sm btn-approve"
          disabled
          aria-describedby={reasonId}
        >
          Approve
        </button>
        <button
          type="button"
          className="btn-sm btn-reject"
          disabled
          aria-describedby={reasonId}
        >
          Reject
        </button>
        <span id={reasonId} className="approval-cannot-decide-note">
          You don't hold approve on this workflow
        </span>
      </div>
    );
  }
  if (confirming || busy) {
    const decision = confirming ?? deciding!;
    const verb = decision === "approve" ? "approve" : "reject";
    return (
      <form
        className="approval-confirm"
        aria-busy={busy}
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          // onDecide reports its own failures. A refused or lost decision
          // keeps the form and its reason for another try.
          onDecide(gate, decision, reason)
            .then((landed) => {
              if (!landed) return;
              setConfirming(null);
              setReason("");
            })
            .catch(() => {});
        }}
      >
        <label htmlFor={reasonId} className="approval-confirm-label">
          Reason (optional)
        </label>
        <textarea
          id={reasonId}
          className="approval-reason"
          rows={2}
          maxLength={MAX_DECISION_REASON_LENGTH}
          value={reason}
          disabled={busy}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="approval-actions">
          <button
            type="submit"
            className={`btn-sm ${
              decision === "approve" ? "btn-approve" : "btn-reject"
            }`}
            disabled={busy}
            aria-label={`Confirm ${verb} ${what}`}
          >
            {busy
              ? decision === "approve" ? "Approving…" : "Rejecting…"
              : decision === "approve"
              ? "Confirm approve"
              : "Confirm reject"}
          </button>
          <button
            type="button"
            className="btn-sm"
            disabled={busy}
            onClick={() => {
              setConfirming(null);
              setReason("");
            }}
          >
            Back
          </button>
        </div>
      </form>
    );
  }
  return (
    <div className="approval-actions">
      <button
        type="button"
        className="btn-sm btn-approve"
        aria-label={`Approve ${what}`}
        onClick={() => setConfirming("approve")}
      >
        Approve
      </button>
      <button
        type="button"
        className="btn-sm btn-reject"
        aria-label={`Reject ${what}`}
        onClick={() => setConfirming("reject")}
      >
        Reject
      </button>
    </div>
  );
}

interface GateRowProps {
  gate: {
    workflowName: string;
    runId: string;
    stepName: string;
    prompt?: string;
    initiatedBy?: string;
    inputs?: Readonly<Record<string, unknown>>;
  };
  waitingSince?: string;
  waitingLabel: string;
  expired?: ExpiredGate;
  history: ReactNode;
  note?: string | false;
  actions: ReactNode;
}

/**
 * One gate: what it is and how long it has waited, its workflow's recent
 * runs and its actions. Expanding it shows the run, the gated step, the
 * prompt and the workflow's jobs around the gate, without leaving the
 * page.
 */
function GateRow(
  {
    gate,
    waitingSince,
    waitingLabel,
    expired,
    history,
    note,
    actions,
  }: GateRowProps,
) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const toggleFromRow = (e: MouseEvent<HTMLDivElement>) => {
    if (
      (e.target as Element).closest("a, button, code, input, textarea, form")
    ) {
      return;
    }
    if (globalThis.getSelection?.()?.toString()) return;
    setOpen((v) => !v);
  };
  return (
    <li className={`approval-item${open ? " is-open" : ""}`}>
      <div className="approval-main" onClick={toggleFromRow}>
        <button
          type="button"
          className="approval-toggle"
          aria-expanded={open}
          aria-controls={detailsId}
          aria-label={`${
            open ? "Hide" : "Show"
          } details for ${gate.stepName} on ${gate.workflowName}`}
          onClick={() => setOpen((v) => !v)}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M6 3.5L10.5 8 6 12.5" />
          </svg>
        </button>
        <div className="approval-body">
          <div className="approval-title">
            <WorkflowLink name={gate.workflowName} />
            <span className="approval-sep" aria-hidden="true">/</span>
            <span className="mono approval-step">{gate.stepName}</span>
          </div>
          <div className="approval-meta">
            <RunLink workflowName={gate.workflowName} runId={gate.runId} />
            {gate.initiatedBy && (
              <span className="approval-by mono" title="Started the run">
                by {gate.initiatedBy}
              </span>
            )}
            {waitingSince && (
              <WaitTime label={waitingLabel} since={waitingSince} />
            )}
            {expired && (
              <span title={`Expired ${formatAbsoluteTime(expired.expiredAt)}`}>
                timed out after {formatWait(expired.timeoutSeconds * 1000)}
              </span>
            )}
          </div>
          {gate.prompt && !open && (
            <div className="approval-prompt" title={gate.prompt}>
              {gate.prompt}
            </div>
          )}
          {note && <div className="approval-note">{note}</div>}
        </div>
        <div className="approval-history">{history}</div>
        <div className="approval-side">{actions}</div>
      </div>
      <div id={detailsId} className="approval-details" hidden={!open}>
        {open && (
          <GateContextLoader
            workflowName={gate.workflowName}
            runId={gate.runId}
            stepName={gate.stepName}
            prompt={gate.prompt}
            initiatedBy={gate.initiatedBy}
            inputs={gate.inputs}
          />
        )}
      </div>
    </li>
  );
}

/** Reads the gated workflow's jobs only once a row is expanded. */
function GateContextLoader(
  { workflowName, runId, stepName, prompt, initiatedBy, inputs }: {
    workflowName: string;
    runId: string;
    stepName: string;
    prompt?: string;
    initiatedBy?: string;
    inputs?: Readonly<Record<string, unknown>>;
  },
) {
  const { data, error } = useRequest("workflow.get", {
    workflowIdOrName: workflowName,
  });
  const workflow = extractObject<{ jobs?: WorkflowJobDef[] }>(data);
  return (
    <GateDetails
      workflowName={workflowName}
      stepName={stepName}
      prompt={prompt}
      initiatedBy={initiatedBy}
      inputs={inputs}
      runLink={<RunLink workflowName={workflowName} runId={runId} />}
      jobs={workflow ? workflow.jobs ?? [] : null}
      error={error}
    />
  );
}
