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

package engine

import (
	"errors"
	"reflect"
	"testing"
)

func TestProcessGroupIsKilledBeforeRootReapAndNeverAfter(t *testing.T) {
	for _, observationFails := range []bool{false, true} {
		t.Run(map[bool]string{false: "observed-exit", true: "observer-failure"}[observationFails], func(t *testing.T) {
			var order []string
			failure := errors.New("observer failure")
			p := &childProcess{
				release:   func() { order = append(order, "group-kill") },
				terminate: func() error { order = append(order, "late-kill"); return nil },
			}
			err := p.waitGroupBeforeReaping(func() error {
				order = append(order, "observe-unreaped")
				if observationFails {
					return failure
				}
				return nil
			}, func() error {
				if !p.exited {
					t.Error("root PID released while Kill could still signal its group")
				}
				order = append(order, "reap")
				return nil
			})
			if errors.Is(err, failure) != observationFails {
				t.Fatalf("observer error lost: %v", err)
			}
			if err := p.Kill(); err != nil {
				t.Fatal(err)
			}
			want := []string{"observe-unreaped", "group-kill", "reap"}
			if observationFails {
				want = []string{"observe-unreaped"}
				if !errors.Is(err, ErrUnconfirmedCommandCleanup) {
					t.Fatalf("uncertain ownership was not sticky: %v", err)
				}
			}
			if !reflect.DeepEqual(order, want) {
				t.Fatalf("unsafe signal/reap order: %v", order)
			}
		})
	}
}

func TestUncertainProcessHasOneTrackedReaperAndRetainsResult(t *testing.T) {
	p := &childProcess{}
	entered, release := make(chan struct{}), make(chan struct{})
	failure := errors.New("cannot reap owned process")
	p.startUncertainReaper(func() error { close(entered); <-release; return failure })
	<-entered
	p.startUncertainReaper(func() error { t.Error("second reaper started"); return nil })
	close(release)
	select {
	case <-p.uncertainReaper.done:
		if !errors.Is(p.uncertainReaper.err, failure) {
			t.Fatal("background reap result was discarded")
		}
	case <-testContext(t).Done():
		t.Fatal("background reaper did not settle")
	}
}
