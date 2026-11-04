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

package commandguardian

import (
	"bytes"
	"io"
	"strings"
	"testing"
)

func TestInvalidInvocationDoesNotEchoCommand(t *testing.T) {
	for _, args := range [][]string{{"secret-canary"}, {"--grace-ms", "secret-canary", "--", "cmd"}, {"--grace-ms", "-1", "--", "cmd"}, {"--fence", "/socket", "--grace-ms", "2147483648", "--", "cmd"}} {
		var stderr bytes.Buffer
		code := Run(args, io.NopCloser(strings.NewReader("")), io.Discard, &stderr)
		if code != 125 || strings.Contains(stderr.String(), "secret-canary") {
			t.Fatalf("code=%d diagnostic=%q", code, stderr.String())
		}
	}
}
func TestCommandArgumentsRemainLiteral(t *testing.T) {
	invocation, err := parseArgs([]string{"--fence", "/private/socket", "--grace-ms", "123", "--", "sh", "-c", "literal; $(secret)"})
	if err != nil || invocation.grace.Milliseconds() != 123 || invocation.command[2] != "literal; $(secret)" {
		t.Fatalf("%v %v %v", invocation.grace, invocation.command, err)
	}
}

func TestGraceAcceptsSharedTimerCeiling(t *testing.T) {
	invocation, err := parseArgs([]string{"--fence", "/socket", "--grace-ms", "2147483647", "--", "cmd"})
	if err != nil || invocation.grace.Milliseconds() != 2147483647 {
		t.Fatalf("%v %v", invocation, err)
	}
}
