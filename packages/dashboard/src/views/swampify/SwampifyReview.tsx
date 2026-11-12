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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { useMemo, useState } from "react";
import type { SwampifyRow } from "../../client/swampify.ts";
import type { ComparisonRecord } from "../../client/useSwampify.ts";
import {
  swampifyBuildBrief,
  swampifyBuildTask,
} from "../../lib/agent_sessions/swampify.ts";
import {
  formatDay,
  formatRate,
  formatTokens,
  harnessName,
  KIND_LABEL,
  type OfferView,
  type OptionView,
  startHarnessId,
  type SwampifyLauncher,
} from "../../lib/swampify_view.ts";
import { formatCount, pluralize } from "../../lib/format.ts";
import { ComparisonBlock } from "./SwampifyComparison.tsx";
import { CheckIcon, CopyIcon } from "./SwampifyParts.tsx";
import {
  createLine,
  foundCandidates,
  optionStatus,
} from "./SwampifyOptions.tsx";

export interface OptionReviewProps {
  readonly option: OptionView;
  readonly offer: OfferView;
  /** The behavior that holds the offer, named in the brief's commands. */
  readonly behavior: string;
  readonly comparison: SwampifyRow | undefined;
  readonly records: ReadonlyMap<string, ComparisonRecord>;
  readonly onLoadComparison: (row: SwampifyRow) => void;
  readonly onBack: () => void;
  /** The local dashboard's launch; absent under serve. */
  readonly launch?: SwampifyLauncher;
  /** Tests start with the brief shown. */
  readonly initialBriefShown?: boolean;
  /** Tests start in a launch state. */
  readonly initialLaunch?: LaunchState;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export type LaunchState =
  | { readonly kind: "idle" }
  | { readonly kind: "launching" }
  | { readonly kind: "opened" }
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "failed"; readonly message: string };

function HandOff(
  {
    brief,
    task,
    becomes,
    harness,
    launch,
    initialShown = false,
    initialLaunch,
  }: {
    brief: string | null;
    task: string | null;
    becomes: string;
    harness: string;
    launch: SwampifyLauncher | undefined;
    initialShown?: boolean;
    initialLaunch?: LaunchState;
  },
) {
  const [shown, setShown] = useState(initialShown);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [launched, setLaunched] = useState<LaunchState>(
    initialLaunch ?? { kind: "idle" },
  );
  if (brief === null) {
    return (
      <p className="sw-muted">
        This offer's behavior name can't be written into a brief safely, so
        there is no brief to copy. Ask your agent to build it with the swampify
        skill.
      </p>
    );
  }
  const agent = harnessName(harness);
  const startId = startHarnessId(harness);
  const canLaunch = launch !== undefined && task !== null && startId !== null;
  const onLaunch = async () => {
    if (!canLaunch) return;
    setLaunched({ kind: "launching" });
    try {
      const outcome = await launch(task, startId);
      setLaunched(
        outcome.opened
          ? { kind: "opened" }
          : { kind: "command", command: outcome.command },
      );
    } catch (error) {
      setLaunched({
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const busy = launched.kind === "launching";
  const done = launched.kind === "opened" || launched.kind === "command";
  return (
    <>
      <p className="sw-small">
        {canLaunch
          ? `Swampify! opens ${agent} in this repo on a brief that tells it to record your pick, build the ${becomes}, run it once and show you the result.`
          : `Hand it to your agent: the brief tells it to record your pick, build the ${becomes}, run it once and show you the result. Paste it to your agent in this repo.`}
      </p>
      <div className="sw-handoff-actions">
        {canLaunch && (
          <button
            type="button"
            className="sw-btn sw-btn-primary"
            disabled={busy || done}
            onClick={() => void onLaunch()}
          >
            {busy ? `Opening ${agent}…` : "Swampify!"}
          </button>
        )}
        <button
          type="button"
          className={canLaunch ? "sw-btn" : "sw-btn sw-btn-primary"}
          aria-expanded={shown}
          aria-controls="sw-brief"
          onClick={() => setShown(!shown)}
        >
          {shown ? "Hide brief" : "Show brief"}
        </button>
      </div>
      {canLaunch && (launched.kind === "idle" || busy) && (
        <p className="sw-muted sw-small">
          {agent}{" "}
          opens in a new terminal and can read, edit and run files in this repo.
          Clicking Swampify! confirms you trust this folder.
        </p>
      )}
      <div role="status" className="sw-small">
        {launched.kind === "opened" && (
          <p>
            Opened {agent}{" "}
            in a new terminal. It records your pick, then builds the {becomes}.
          </p>
        )}
        {launched.kind === "command" && (
          <>
            <p>
              No terminal could be opened. Run this in a terminal to start{" "}
              {agent} on the brief:
            </p>
            <pre className="sw-brief">{launched.command}</pre>
          </>
        )}
      </div>
      {launched.kind === "failed" && (
        <p className="sw-fail sw-small" role="alert">
          {launched.message} You can still show the brief and copy it.
        </p>
      )}
      {shown && (
        <div className="sw-brief-wrap">
          <pre id="sw-brief" className="sw-brief">{brief}</pre>
          <button
            type="button"
            className="sw-icon-btn sw-copy"
            aria-label={copied === "copied" ? "Copied" : "Copy brief"}
            title={copied === "copied" ? "Copied" : "Copy brief"}
            onClick={() =>
              void copyText(brief).then((ok) =>
                setCopied(ok ? "copied" : "failed")
              )}
          >
            {copied === "copied" ? <CheckIcon /> : <CopyIcon />}
          </button>
        </div>
      )}
      {copied === "failed" && (
        <p className="sw-fail sw-small" role="alert">
          The browser refused the clipboard. Select the brief above and copy it.
        </p>
      )}
    </>
  );
}

/**
 * One option: what swamp would build, the evidence behind it, and the brief
 * that hands it to the user's agent.
 */
export function OptionReview(props: OptionReviewProps) {
  const { option: view, offer } = props;
  const { option } = view;
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const candidates = useMemo(() => foundCandidates(view), [view]);
  const brief = useMemo(
    () => swampifyBuildBrief({ behavior: props.behavior, option, candidates }),
    [props.behavior, option, candidates],
  );
  const task = useMemo(
    () => swampifyBuildTask({ behavior: props.behavior, option, candidates }),
    [props.behavior, option, candidates],
  );
  const status = optionStatus(view, offer);
  const state = offer.offer.state;
  const target = state.kind === "built" && view.picked ? state.target : null;
  const unshown = view.candidates.length - candidates.length;

  return (
    <div className="sw-page">
      <button type="button" className="sw-link sw-back" onClick={props.onBack}>
        ← Swampify
      </button>
      <header className="sw-review-head">
        <h1 className="sw-title">
          {option.name}
          {status && <span className="sw-status">{status}</span>}
        </h1>
        <p className="sw-why">{option.why}</p>
      </header>

      <section className="sw-card sw-pad sw-build" aria-labelledby="sw-build-h">
        <h2 id="sw-build-h">
          {target ? "What swamp built" : "What swamp would build"}
        </h2>
        <p>
          {createLine(option)}
          {option.outline ? ", in these steps:" : "."}
        </p>
        {option.outline && (
          <ol className="sw-steps">
            {option.outline.map((step, i) => <li key={i}>{step}</li>)}
          </ol>
        )}
        <div className="sw-handoff">
          {target
            ? (
              <p>
                Your agent built the {target.kind} <code>{target.name}</code>.
              </p>
            )
            : (
              <HandOff
                brief={brief}
                task={task}
                becomes={option.becomes}
                harness={offer.offer.reading.harness}
                launch={props.launch}
                initialShown={props.initialBriefShown}
                initialLaunch={props.initialLaunch}
              />
            )}
        </div>
      </section>

      {(props.comparison || target) && (
        <section className="sw-card sw-pad" aria-labelledby="sw-cmp-h">
          <h2 id="sw-cmp-h">Raw against swamp</h2>
          <ComparisonBlock
            row={props.comparison}
            open={comparisonOpen}
            onToggle={() =>
              setComparisonOpen(!comparisonOpen)}
            records={props.records}
            onLoad={props.onLoadComparison}
          />
        </section>
      )}

      <section className="sw-card sw-pad" aria-labelledby="sw-ev-h">
        <h2 id="sw-ev-h">The evidence</h2>
        <p className="sw-small">
          It stands for {pluralize(view.candidates.length, "candidate")}:
        </p>
        {candidates.map((c) => (
          <div key={c.id} className="sw-evidence">
            <div className="sw-evidence-label">{c.label}</div>
            <div className="sw-muted sw-small">
              {KIND_LABEL[c.kind]} · {formatCount(c.occurrences)} runs in{" "}
              {pluralize(c.sessions, "session")} ·{" "}
              {formatTokens(c.perOccurrence.weightedTokens.median)}{" "}
              tokens per run · {formatRate(c.failureRate)} failed ·{" "}
              {formatDay(c.firstSeen)} to {formatDay(c.lastSeen)}
            </div>
            {c.excerpts[0] && (
              <pre className="sw-excerpt">{c.excerpts[0].text}</pre>
            )}
          </div>
        ))}
        {unshown > 0 && (
          <p className="sw-muted sw-small">
            {pluralize(unshown, "candidate")} {unshown === 1 ? "is" : "are"}
            {" "}
            not in the shown assessment.
          </p>
        )}
      </section>
    </div>
  );
}
