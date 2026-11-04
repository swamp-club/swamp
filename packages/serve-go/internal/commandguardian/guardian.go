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

// Package commandguardian contains engine-managed command groups after their
// owning engine dies. Its input is a private lifetime pipe, never command stdin.
package commandguardian

import (
	"errors"
	servecontract "github.com/swamp-club/swamp/packages/serve-go"
	"io"
	"strconv"
	"time"
)

const Mode = "__command_guardian"

type invocation struct {
	grace   time.Duration
	fence   string
	command []string
}

func parseArgs(args []string) (invocation, error) {
	if len(args) < 6 || args[0] != "--fence" || args[1] == "" || args[2] != "--grace-ms" || args[4] != "--" {
		return invocation{}, errors.New("invalid command guardian invocation")
	}
	ms, err := strconv.Atoi(args[3])
	if err != nil || ms < 0 || int64(ms) > servecontract.MaxShutdownDeadlineMilliseconds() {
		return invocation{}, errors.New("invalid command guardian grace")
	}
	return invocation{time.Duration(ms) * time.Millisecond, args[1], args[5:]}, nil
}

// Run is an internal entry point. Diagnostics deliberately contain no command,
// arguments, environment, or operating-system error strings.
func Run(args []string, input io.ReadCloser, stdout, stderr io.Writer) int {
	invocation, err := parseArgs(args)
	if err != nil {
		_, _ = io.WriteString(stderr, "Command guardian: invalid invocation\n")
		return 125
	}
	code, err := runCommand(invocation, input, stdout, stderr)
	if err != nil {
		_, _ = io.WriteString(stderr, "Command guardian: command supervision failed\n")
		return 125
	}
	return code
}
