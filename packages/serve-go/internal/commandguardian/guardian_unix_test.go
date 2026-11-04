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

//go:build linux || darwin

package commandguardian

import (
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"syscall"
	"testing"
	"time"
)

type fakeProcess struct {
	exited            chan error
	signalled         chan syscall.Signal
	mu                sync.Mutex
	events            []string
	killOnce          sync.Once
	code              int
	confirmationError error
	reapBlock         <-chan struct{}
	reapStarted       chan struct{}
}

func newFake() *fakeProcess {
	return &fakeProcess{exited: make(chan error, 1), signalled: make(chan syscall.Signal, 8), code: 23}
}
func (p *fakeProcess) record(event string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.events = append(p.events, event)
}
func (p *fakeProcess) observeExit() error { return <-p.exited }
func (p *fakeProcess) signalGroup(signal syscall.Signal) error {
	p.record(signal.String())
	p.signalled <- signal
	if signal == syscall.SIGKILL {
		p.killOnce.Do(func() { p.exited <- nil })
	}
	return nil
}
func (p *fakeProcess) reap() (int, error) {
	p.record("reap")
	if p.reapStarted != nil {
		close(p.reapStarted)
	}
	if p.reapBlock != nil {
		<-p.reapBlock
	}
	return p.code, nil
}
func (p *fakeProcess) confirmExit() error { p.record("confirmed"); return p.confirmationError }
func (p *fakeProcess) assertEvents(t *testing.T, expected []string) {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if !reflect.DeepEqual(p.events, expected) {
		t.Fatalf("events %v, want %v", p.events, expected)
	}
}

func TestOwnerEOFImmediatelyKillsGroupThenReaps(t *testing.T) {
	p := newFake()
	reader, writer := io.Pipe()
	writer.Close()
	code, err := supervise(p, reader, nil, nil, func() <-chan time.Time { t.Error("EOF must not wait for grace"); return nil })
	if err != nil || code != 23 {
		t.Fatalf("code=%d err=%v", code, err)
	}
	p.assertEvents(t, []string{"killed", "reap", "confirmed"})
}

func TestNaturalExitKillsDescendantsBeforeReapingRoot(t *testing.T) {
	p := newFake()
	p.exited <- nil
	reader, writer := io.Pipe()
	defer writer.Close()
	code, err := supervise(p, reader, nil, nil, func() <-chan time.Time { return nil })
	if err != nil || code != 23 {
		t.Fatalf("code=%d err=%v", code, err)
	}
	p.assertEvents(t, []string{"killed", "reap", "confirmed"})
}

func TestCancellationEscalatesOnceAtControlledDeadline(t *testing.T) {
	p := newFake()
	reader, writer := io.Pipe()
	defer writer.Close()
	grace := make(chan time.Time)
	done := make(chan error, 1)
	go func() {
		_, err := supervise(p, reader, nil, nil, func() <-chan time.Time { return grace })
		done <- err
	}()
	if _, err := writer.Write([]byte{1}); err != nil {
		t.Fatal(err)
	}
	if s := <-p.signalled; s != syscall.SIGTERM {
		t.Fatalf("signal %v", s)
	}
	grace <- time.Time{}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	p.assertEvents(t, []string{"terminated", "killed", "reap", "confirmed"})
}

func TestOwnerEOFInterruptsCancellationGrace(t *testing.T) {
	p := newFake()
	reader, writer := io.Pipe()
	done := make(chan error, 1)
	go func() {
		_, err := supervise(p, reader, nil, nil, func() <-chan time.Time { return make(chan time.Time) })
		done <- err
	}()
	writer.Write([]byte{1})
	if s := <-p.signalled; s != syscall.SIGTERM {
		t.Fatalf("signal %v", s)
	}
	writer.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	p.assertEvents(t, []string{"terminated", "killed", "reap", "confirmed"})
}

func TestObservationFailureDoesNotSignalAnUnprovenGroup(t *testing.T) {
	p := newFake()
	failure := errors.New("observation")
	p.exited <- failure
	reader, writer := io.Pipe()
	defer writer.Close()
	_, err := supervise(p, reader, make(chan os.Signal), nil, func() <-chan time.Time { return nil })
	if !errors.Is(err, failure) {
		t.Fatalf("error %v", err)
	}
	p.assertEvents(t, []string{"reap"})
}

func TestLifetimePipeCloseInterruptsReader(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	input, err := pollableInput(reader)
	if err != nil {
		reader.Close()
		t.Fatal(err)
	}
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() { close(started); var b [1]byte; _, err := input.Read(b[:]); done <- err }()
	<-started
	if err := input.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err == nil {
		t.Fatal("closed lifetime pipe should interrupt the read")
	}
}

func TestLostSupervisorKillsBeforeCleanupAcknowledgement(t *testing.T) {
	p := newFake()
	reader, writer := io.Pipe()
	defer writer.Close()
	lost := make(chan struct{})
	close(lost)
	_, err := supervise(p, reader, nil, lost, func() <-chan time.Time { t.Error("supervisor loss must not wait"); return nil })
	if err != nil {
		t.Fatal(err)
	}
	p.assertEvents(t, []string{"killed", "reap", "confirmed"})
}

func TestUnconfirmedDescendantExitPreventsSuccess(t *testing.T) {
	p := newFake()
	failure := errors.New("cleanup unconfirmed")
	p.confirmationError = failure
	p.exited <- nil
	reader, writer := io.Pipe()
	defer writer.Close()
	_, err := supervise(p, reader, nil, nil, func() <-chan time.Time { return nil })
	if !errors.Is(err, failure) {
		t.Fatalf("error=%v", err)
	}
	p.assertEvents(t, []string{"killed", "reap", "confirmed"})
}

func TestTargetLookupPreservesMissingEmptyAndExplicitPATH(t *testing.T) {
	directory := t.TempDir()
	executable := filepath.Join(directory, "command-fixture")
	if err := os.WriteFile(executable, []byte("fixture"), 0700); err != nil {
		t.Fatal(err)
	}
	nonExecutable := t.TempDir()
	if err := os.WriteFile(filepath.Join(nonExecutable, "command-fixture"), []byte("not executable"), 0600); err != nil {
		t.Fatal(err)
	}
	path, err := targetPath("command-fixture", nonExecutable+":"+directory, true)
	if err != nil || path != executable {
		t.Fatalf("path=%q err=%v", path, err)
	}
	if _, err := targetPath("command-fixture", "", true); err == nil {
		t.Fatal("empty PATH must not use supplied directory")
	}
	if _, err := targetPath("sh", "", false); err != nil {
		t.Fatal("missing PATH must use POSIX defaults")
	}
	if _, err := targetPath("", "", false); err == nil {
		t.Fatal("empty command accepted")
	}
	relative, err := targetPath("./fixture", "", false)
	if err != nil || relative != "./fixture" {
		t.Fatalf("relative=%q err=%v", relative, err)
	}
	cmd := targetCommand(executable, []string{"command-fixture", "$(literal)", "a b"}, io.Discard, io.Discard)
	if !reflect.DeepEqual(cmd.Args, []string{"command-fixture", "$(literal)", "a b"}) || cmd.Stdin != nil || len(cmd.ExtraFiles) != 0 || !cmd.SysProcAttr.Setpgid {
		t.Fatalf("target command mutated arguments or inherited a private descriptor: %#v", cmd)
	}
}

func TestCleanupAcknowledgementRequiresConfirmedGroupExit(t *testing.T) {
	for _, failed := range []bool{false, true} {
		p := newFake()
		p.code = 125
		p.exited <- nil
		if failed {
			p.confirmationError = errors.New("uncertain group")
		}
		reader, writer := io.Pipe()
		acknowledged := false
		code, err := finishSupervision(p, reader, nil, nil, func() <-chan time.Time { return nil }, func() error { acknowledged = true; p.record("ack"); return nil })
		writer.Close()
		if code != 125 || acknowledged == failed || (err != nil) != failed {
			t.Fatalf("code=%d ack=%v error=%v", code, acknowledged, err)
		}
		if !failed {
			p.assertEvents(t, []string{"killed", "reap", "confirmed", "ack"})
		}
	}
}

func TestFenceRegistrationRequiresExplicitPermission(t *testing.T) {
	for _, reply := range []byte{'A', 'N'} {
		client, server := net.Pipe()
		received := make(chan byte, 1)
		done := make(chan struct{})
		registered := make(chan struct{})
		go func() {
			defer close(done)
			defer server.Close()
			var request [1]byte
			_, _ = io.ReadFull(server, request[:])
			received <- request[0]
			_, _ = server.Write([]byte{reply})
			// Successful registration clears its temporary deadline after reading
			// A. Keep the peer alive through that final operation, as production
			// does until command cleanup, rather than racing it with pipe close.
			<-registered
		}()
		err := registerConnection(client)
		close(registered)
		client.Close()
		<-done
		if request := <-received; request != 'R' {
			t.Fatalf("request %q", request)
		}
		if (err == nil) != (reply == 'A') {
			t.Fatalf("reply=%q err=%v", reply, err)
		}
	}
}

func TestUncertainReaperHasControlledDeadlineWithoutSignals(t *testing.T) {
	p := newFake()
	release := make(chan struct{})
	p.reapBlock = release
	p.reapStarted = make(chan struct{})
	deadline := make(chan time.Time)
	done := make(chan error, 1)
	go func() { _, err := reapWithin(p, deadline); done <- err }()
	<-p.reapStarted
	deadline <- time.Time{}
	if err := <-done; err == nil {
		t.Fatal("uncertain reap must fail")
	}
	close(release)
	p.assertEvents(t, []string{"reap"})
}
