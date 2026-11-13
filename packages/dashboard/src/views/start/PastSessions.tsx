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

import { useEffect, useState } from "react";
import { NavIcon } from "../../components/nav_icons.tsx";
import {
  isValidWorkspaceName,
  parseExcludedPaths,
  PAST_SESSIONS_DEFAULT_WINDOW,
  PAST_SESSIONS_WINDOWS,
  type PastSessionsHarness,
  pastSessionsHarnesses,
  swampifyWorkspaceName,
} from "./helpers.ts";
import {
  describeChooseError,
  ErrorBox,
  type ScreenProps,
  useAction,
} from "./parts.tsx";
import type { HarnessList, StartStatus } from "./types.ts";

/** The collapsed card's one line. */
export const PAST_SESSIONS_CARD_TEXT =
  "Find tasks to automate from your agent session history.";

const PAST_SESSIONS_HARNESS_NAMES: Record<PastSessionsHarness, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/**
 * "Start from your past sessions": says what will be read and stored, then
 * creates a workspace and saves a Swampify kick-off task in it. The page
 * sends only the window, the excluded paths and the agent; the server writes
 * the task text.
 */
export function PastSessionsPanel(
  { status, client, onStatus, taken, disabled, initialOpen = false }:
    & ScreenProps
    & {
      taken: readonly string[];
      disabled: boolean;
      /** Test-only: render with the panel already open. */
      initialOpen?: boolean;
    },
) {
  const offered = pastSessionsHarnesses(status.signals);
  const [open, setOpen] = useState(initialOpen);
  const [windowDays, setWindowDays] = useState(PAST_SESSIONS_DEFAULT_WINDOW);
  const [excludeText, setExcludeText] = useState("");
  const [picked, setPicked] = useState<PastSessionsHarness | null>(null);
  const [name, setName] = useState("");
  const [installed, setInstalled] = useState<Record<string, boolean> | null>(
    null,
  );
  const { busy, error, run } = useAction(onStatus, describeChooseError);
  useEffect(() => {
    if (!open) return;
    let active = true;
    client.request<HarnessList>("start.harness.list")
      .then((reply) => {
        if (!active) return;
        const found: Record<string, boolean> = {};
        for (const h of reply?.harnesses ?? []) found[h.id] = h.found;
        setInstalled(found);
      })
      .catch(() => {
        if (active) setInstalled({});
      });
    return () => {
      active = false;
    };
  }, [open, client]);
  const harness = picked !== null && offered.includes(picked)
    ? picked
    : offered.find((h) => installed?.[h] !== false) ?? offered[0];
  const suggested = swampifyWorkspaceName(taken);
  const finalName = name.trim() || suggested;
  const nameOk = isValidWorkspaceName(finalName);
  const harnessOk = harness !== undefined && installed?.[harness] !== false;
  const canSubmit = !busy && !disabled && nameOk && harnessOk;

  if (!open) {
    return (
      <div className="start-past-card">
        <NavIcon name="swampify" className="start-past-card-icon" />
        <p className="start-past-card-text">{PAST_SESSIONS_CARD_TEXT}</p>
        <button
          type="button"
          className="start-primary start-small"
          onClick={() => setOpen(true)}
          disabled={disabled}
        >
          swampify!
        </button>
      </div>
    );
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || harness === undefined) return;
    const exclude = parseExcludedPaths(excludeText);
    void run(() =>
      client.request<StartStatus>("start.swampify.kickoff", {
        name: finalName,
        windowDays,
        ...(exclude.length > 0 ? { exclude } : {}),
        harness,
      })
    );
  };

  return (
    <form
      className="start-form-panel start-past-sessions"
      onSubmit={submit}
      aria-labelledby="start-past-sessions-title"
    >
      <h3 id="start-past-sessions-title" className="start-form-title">
        Start from your past sessions
      </h3>
      <p className="start-panel-intro">
        Your agent looks through your Claude Code and Codex history for chores
        you repeat, and offers a few worth automating.
      </p>
      <ul className="start-disclosure">
        <li>
          <strong>What it reads:</strong>{" "}
          transcript text on this machine, including your prompts and the
          agent's replies, for the window and scope you choose below. Your agent
          asks before it reads anything.
        </li>
        <li>
          <strong>What the workspace stores:</strong>{" "}
          counts, token costs, and up to five short, redacted excerpts for each
          repeated chore. Session records stay prompt-free: they never hold
          prompts or replies.
        </li>
        <li>
          <strong>Where it goes:</strong>{" "}
          this workspace's data stays on this machine unless you choose to sync
          it to a datastore or serve it.
        </li>
      </ul>
      <ErrorBox message={error} />
      <label className="start-field-label" htmlFor="start-past-window">
        Window
      </label>
      <select
        id="start-past-window"
        className="start-input"
        value={windowDays}
        onChange={(e) => setWindowDays(Number(e.target.value))}
      >
        {PAST_SESSIONS_WINDOWS.map((days) => (
          <option key={days} value={days}>Last {days} days</option>
        ))}
      </select>
      <label className="start-field-label" htmlFor="start-past-exclude">
        Scope
      </label>
      <p className="start-hint" id="start-past-exclude-hint">
        Every session on this machine. To leave folders out, list them one per
        line, starting with <code>/</code> or <code>~</code>.
      </p>
      <textarea
        id="start-past-exclude"
        className="start-textarea start-input-mono"
        value={excludeText}
        onChange={(e) => setExcludeText(e.target.value)}
        rows={3}
        placeholder="~/src/client-repo"
        spellCheck={false}
        aria-describedby="start-past-exclude-hint"
      />
      <fieldset className="start-past-agents">
        <legend className="start-field-label">Agent</legend>
        {offered.map((id) => (
          <label key={id} className="start-past-agent">
            <input
              type="radio"
              name="start-past-agent"
              value={id}
              checked={harness === id}
              onChange={() => setPicked(id)}
              disabled={installed?.[id] === false}
            />
            {PAST_SESSIONS_HARNESS_NAMES[id]}
            {installed?.[id] === false && (
              <span className="start-hint">not on your PATH</span>
            )}
          </label>
        ))}
      </fieldset>
      <label className="start-field-label" htmlFor="start-past-name">
        Workspace name
      </label>
      <input
        id="start-past-name"
        className="start-input"
        value={name}
        placeholder={suggested}
        onChange={(e) => setName(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={!nameOk}
      />
      <div className="start-actions">
        <button
          type="button"
          className="start-secondary"
          onClick={() => setOpen(false)}
          disabled={busy}
        >
          Cancel
        </button>
        <button type="submit" className="start-primary" disabled={!canSubmit}>
          {busy ? "Setting up…" : "Create workspace from past sessions"}
        </button>
      </div>
    </form>
  );
}
