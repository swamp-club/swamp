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

// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import type { ScrollbackItem } from "../state.ts";
import { StatusIcon } from "./status_icon.tsx";
import { ReportBlock, ReportErrorBlock } from "./report_block.tsx";
import { DataHints } from "./data_hints.tsx";
import { formatDuration } from "../../../output/utils/duration_formatter.ts";

interface ScrollbackEntryProps {
  item: ScrollbackItem;
}

export function ScrollbackEntry({ item }: ScrollbackEntryProps) {
  switch (item.type) {
    case "job":
      return <CompletedJobBlock item={item} />;
    case "report":
      return <ReportBlock name={item.name} markdown={item.markdown} />;
    case "report_error":
      return <ReportErrorBlock name={item.name} error={item.error} />;
    case "data_hints":
      return (
        <DataHints
          workflowName={item.workflowName}
          artifactNames={item.artifactNames}
        />
      );
  }
}

function CompletedJobBlock(
  { item }: {
    item: Extract<ScrollbackItem, { type: "job" }>;
  },
) {
  const statusStr = item.status === "succeeded" ? "completed" : item.status;
  const icon = item.status === "succeeded" || item.status === "completed"
    ? "completed"
    : item.status === "failed"
    ? "failed"
    : item.status === "skipped"
    ? "skipped"
    : "completed";

  const dur = item.duration !== null
    ? ` (${formatDuration(item.duration)})`
    : "";

  // Right-side summary
  let summary: string;
  if (item.singleStepLabel) {
    summary = `${item.singleStepLabel}${dur}`;
  } else if (item.completedStepCount > 0) {
    summary = `${item.completedStepCount} steps${dur}`;
  } else {
    summary = `${statusStr}${dur}`;
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text>{item.jobId}</Text>
        <Box flexGrow={1} />
        <Text>
          <StatusIcon status={icon} />
          {summary}
        </Text>
      </Box>
      {item.outputSections.map((section) => (
        <Box key={section.stepId} flexDirection="column">
          {item.outputSections.length > 1 && (
            <Text dimColor>
              │ [{section.modelName}
              {section.methodName ? ` \u2192 ${section.methodName}` : ""}]
            </Text>
          )}
          {section.lines.map((line, i) => <Text key={i} dimColor>│ {line}
          </Text>)}
          {section.error && !section.allowedFailure && (
            <Text color="red">│ Error: {section.error}</Text>
          )}
          {section.error && section.allowedFailure && (
            <Text color="yellow">
              │ Warning (allowed failure): {section.error}
            </Text>
          )}
          {section.reports.map((report, ri) => {
            if (report.success) {
              return (
                <ReportBlock
                  key={ri}
                  name={report.name}
                  markdown={report.markdown}
                />
              );
            }
            return (
              <ReportErrorBlock
                key={ri}
                name={report.name}
                error={report.error}
              />
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
