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
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	servecontract "github.com/swamp-club/swamp/packages/serve-go"
	"github.com/swamp-club/swamp/packages/serve-go/internal/protocol"
)

func lifecycleProcess(busy *atomic.Bool) *fakeProcess {
	return newFake(func(p *fakeProcess, e protocol.Envelope) {
		switch e.Method {
		case "hello":
			p.reply(e, map[string]interface{}{"version": 1, "profile": "local-v1", "callerSessionIds": true, "authenticationDeadlines": true, "operations": servecontract.Operations()})
		case "session.open":
			p.reply(e, map[string]string{"sessionId": openingSessionID(e)})
		case "engine.status":
			runs := 0
			if busy.Load() {
				runs = 1
			}
			p.reply(e, Status{State: "ready", Runs: runs})
		case "engine.quiesce":
			p.reply(e, map[string]bool{"quiescent": !busy.Load()})
			if !busy.Load() {
				p.finish()
			}
		case "engine.shutdown":
			p.reply(e, struct{}{})
			p.finish()
		default:
			p.reply(e, struct{}{})
		}
	})
}
func TestSupervisorJoinsOneColdStart(t *testing.T) {
	var starts atomic.Int32
	var busy atomic.Bool
	entered := make(chan struct{})
	release := make(chan struct{})
	s := NewSupervisor(DefaultConfig(), func(ctx context.Context) (Process, error) {
		starts.Add(1)
		close(entered)
		select {
		case <-release:
			return lifecycleProcess(&busy), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	ctx := testContext(t)
	var workers sync.WaitGroup
	errors := make(chan error, 32)
	for i := 0; i < 32; i++ {
		workers.Add(1)
		go func() { defer workers.Done(); errors <- s.Validate(ctx) }()
	}
	<-entered
	close(release)
	workers.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	if starts.Load() != 1 {
		t.Fatalf("process stampede: %d", starts.Load())
	}
	if err := s.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestSupervisorShutdownDeadlineFencesBlockedAdmission(t *testing.T) {
	accepted := make(chan struct{})
	p := newFake(func(p *fakeProcess, e protocol.Envelope) {
		switch e.Method {
		case "hello":
			p.reply(e, map[string]interface{}{"version": 1, "profile": "local-v1", "callerSessionIds": true, "authenticationDeadlines": true, "operations": servecontract.Operations()})
		case "session.open":
			close(accepted) // Authentication is stuck before replying.
		}
	})
	t.Cleanup(func() { _ = p.Kill() })
	s := NewSupervisor(DefaultConfig(), func(context.Context) (Process, error) { return p, nil })
	ctx := testContext(t)
	if err := s.Validate(ctx); err != nil {
		t.Fatal(err)
	}
	opened := make(chan error, 1)
	go func() { _, err := s.Open(context.Background(), "token", "ip"); opened <- err }()
	select {
	case <-accepted:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	deadline, expire := context.WithCancel(context.Background())
	expire()
	stopped := make(chan error, 1)
	go func() { stopped <- s.Shutdown(deadline) }()
	select {
	case err := <-stopped:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("shutdown did not report its expired deadline: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("shutdown waited for admission instead of fencing its process")
	}
	select {
	case <-p.done:
	default:
		t.Fatal("shutdown returned without reaping the blocked process")
	}
	if err := <-opened; !errors.Is(err, ErrUnavailable) {
		t.Fatalf("in-flight admission survived shutdown: %v", err)
	}
}

func TestSupervisorShutdownCancelsAndReapsStartingGeneration(t *testing.T) {
	hello := make(chan struct{})
	p := newFake(func(_ *fakeProcess, e protocol.Envelope) {
		if e.Method == "hello" {
			close(hello)
		}
	})
	t.Cleanup(func() { _ = p.Kill() })
	s := NewSupervisor(DefaultConfig(), func(context.Context) (Process, error) { return p, nil })
	ctx := testContext(t)
	validated := make(chan error, 1)
	go func() { validated <- s.Validate(ctx) }()
	select {
	case <-hello:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := s.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-validated; err == nil {
		t.Fatal("starting generation published after shutdown began")
	}
	select {
	case <-p.done:
	default:
		t.Fatal("starting process was not reaped")
	}
	if s.Snapshot().Ready {
		t.Fatal("drained supervisor reported ready")
	}
}

func TestAdmissionGateCancelledWaitLeavesNoReservations(t *testing.T) {
	var gate admissionGate
	ctx := testContext(t)
	if err := gate.acquire(ctx, false); err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := gate.acquire(cancelled, true); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	gate.release(false)
	if err := gate.acquire(ctx, true); err != nil {
		t.Fatal(err)
	}
	if err := gate.acquire(cancelled, false); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	gate.release(true)
	if gate.readers != 0 || gate.waiting != 0 || gate.writer {
		t.Fatal("cancelled admission leaked a reservation")
	}
}

func TestSupervisorIdleUsesEngineWorkAndStartsFreshGeneration(t *testing.T) {
	var busy atomic.Bool
	var starts atomic.Int32
	config := DefaultConfig()
	config.IdleTimeout = time.Second
	s := NewSupervisor(config, func(context.Context) (Process, error) { starts.Add(1); return lifecycleProcess(&busy), nil })
	ctx := testContext(t)
	if err := s.Validate(ctx); err != nil {
		t.Fatal(err)
	}
	first := s.Snapshot().Generation
	a, err := s.Open(ctx, "credential", "ip")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1000, 0)
	if err := s.Tick(ctx, now); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(ctx, a); err != nil {
		t.Fatal(err)
	}
	busy.Store(true)
	for _, at := range []time.Time{now, now.Add(time.Hour)} {
		if err := s.Tick(ctx, at); err != nil {
			t.Fatal(err)
		}
	}
	if s.Snapshot().State != "ready" {
		t.Fatal("detached work lost its engine")
	}
	busy.Store(false)
	if err := s.Tick(ctx, now.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := s.Tick(ctx, now.Add(2*time.Hour+time.Second)); err != nil {
		t.Fatal(err)
	}
	if state := s.Snapshot(); state.State != "stopped" || !state.Ready {
		t.Fatalf("sleeping validation lost: %+v", state)
	}
	if err := s.Validate(ctx); err != nil {
		t.Fatal(err)
	}
	if starts.Load() != 2 || s.Snapshot().Generation == first {
		t.Fatal("restart reused engine generation")
	}
	if err := s.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
}
func TestSupervisorHealthNeverStartsEngine(t *testing.T) {
	var starts atomic.Int32
	s := NewSupervisor(DefaultConfig(), func(context.Context) (Process, error) { starts.Add(1); return nil, context.Canceled })
	for i := 0; i < 50; i++ {
		_ = s.Snapshot()
	}
	if starts.Load() != 0 {
		t.Fatal("health probe started engine")
	}
}
func TestSupervisorRejectsVersionMismatchAndCoolsDown(t *testing.T) {
	var starts atomic.Int32
	s := NewSupervisor(DefaultConfig(), func(context.Context) (Process, error) {
		starts.Add(1)
		return newFake(func(p *fakeProcess, e protocol.Envelope) {
			p.reply(e, map[string]interface{}{"version": 2, "profile": "local-v1", "callerSessionIds": true, "authenticationDeadlines": true, "operations": servecontract.Operations()})
		}), nil
	})
	ctx := testContext(t)
	if err := s.Validate(ctx); err == nil {
		t.Fatal("accepted incompatible engine")
	}
	if err := s.Validate(ctx); err == nil {
		t.Fatal("bypassed startup cooldown")
	}
	if starts.Load() != 1 || s.Snapshot().Ready {
		t.Fatal("bad engine advertised ready or restarted")
	}
}
func TestSupervisorBoundsColdAdmission(t *testing.T) {
	config := DefaultConfig()
	var busy atomic.Bool
	release := make(chan struct{})
	s := NewSupervisor(config, func(ctx context.Context) (Process, error) {
		select {
		case <-release:
			return lifecycleProcess(&busy), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	s.mu.Lock()
	s.waiters = MaxColdWaiters
	s.mu.Unlock()
	if _, err := s.ensure(testContext(t)); err != ErrBusy {
		t.Fatal("cold admission unbounded")
	}
	close(release)
}

func TestSupervisorPreservesStartupRefusalAndDoesNotRetry(t *testing.T) {
	var starts atomic.Int32
	s := NewSupervisor(DefaultConfig(), func(context.Context) (Process, error) {
		starts.Add(1)
		return newFake(func(p *fakeProcess, e protocol.Envelope) {
			p.send(protocol.Envelope{Version: 1, Generation: e.Generation, ID: e.ID, Error: &protocol.Error{Code: "unsupported_profile", Message: "Remote datastores are unsupported"}})
			p.finish()
		}), nil
	})
	err := s.Validate(testContext(t))
	var failure *protocol.Error
	if !errors.As(err, &failure) || failure.Code != "unsupported_profile" {
		t.Fatalf("startup refusal lost: %v", err)
	}
	if s.Snapshot().Ready {
		t.Fatal("invalid profile advertised readiness")
	}
	_ = s.Validate(testContext(t))
	if starts.Load() != 1 {
		t.Fatal("replayed startup during cooldown")
	}
}

func TestSupervisorQuiesceArrivalWaitsForNextGeneration(t *testing.T) {
	var starts atomic.Int32
	var busy atomic.Bool
	quiescing := make(chan struct{})
	release := make(chan struct{})
	config := DefaultConfig()
	config.IdleTimeout = time.Second
	s := NewSupervisor(config, func(context.Context) (Process, error) {
		if starts.Add(1) > 1 {
			return lifecycleProcess(&busy), nil
		}
		return newFake(func(p *fakeProcess, e protocol.Envelope) {
			switch e.Method {
			case "hello":
				p.reply(e, map[string]interface{}{"version": 1, "profile": "local-v1", "callerSessionIds": true, "authenticationDeadlines": true, "operations": servecontract.Operations()})
			case "engine.status":
				p.reply(e, Status{State: "ready"})
			case "engine.quiesce":
				close(quiescing)
				<-release
				p.reply(e, map[string]bool{"quiescent": true})
				p.finish()
			}
		}), nil
	})
	ctx := testContext(t)
	if err := s.Validate(ctx); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1000, 0)
	if err := s.Tick(ctx, now); err != nil {
		t.Fatal(err)
	}
	ticked := make(chan error, 1)
	go func() { ticked <- s.Tick(ctx, now.Add(time.Second)) }()
	<-quiescing
	opened := make(chan *Session, 1)
	openErrors := make(chan error, 1)
	go func() { session, err := s.Open(ctx, "credential", "ip"); opened <- session; openErrors <- err }()
	close(release)
	if err := <-ticked; err != nil {
		t.Fatal(err)
	}
	session := <-opened
	if err := <-openErrors; err != nil {
		t.Fatal(err)
	}
	if starts.Load() != 2 {
		t.Fatal("arrival reused quiesced engine")
	}
	if err := s.Close(ctx, session); err != nil {
		t.Fatal(err)
	}
	if err := s.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
}
func TestLimitsMatchManifest(t *testing.T) {
	// Read the authoritative cross-language manifest through the shared fixture
	// location; these are transport limits, not a second operation allowlist.
	var manifest struct {
		Limits struct{ QueuedBytes, SessionFrames, Sessions, PendingControls, ColdWaiters int } `json:"limits"`
	}
	raw, err := os.ReadFile("../../protocol.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	l := manifest.Limits
	if l.QueuedBytes != MaxQueueBytes || l.SessionFrames != MaxSessionFrames || l.Sessions != MaxSessions || l.PendingControls != MaxPending || l.ColdWaiters != MaxColdWaiters {
		t.Fatal("Go transport limits drifted from protocol.json")
	}
}

func TestSupervisorRejectsMissingProfileCapabilityBeforeReady(t *testing.T) {
	p := newFake(func(p *fakeProcess, e protocol.Envelope) {
		if e.Method == "hello" {
			p.reply(e, map[string]interface{}{"version": 1, "profile": "local-v1", "callerSessionIds": true, "authenticationDeadlines": true, "operations": []string{"server.version"}})
		}
	})
	t.Cleanup(func() { _ = p.Kill() })
	s := NewSupervisor(DefaultConfig(), func(context.Context) (Process, error) { return p, nil })
	if err := s.Validate(testContext(t)); !errors.Is(err, protocol.ErrVersion) {
		t.Fatalf("incomplete engine capabilities were accepted: %v", err)
	}
	if s.Snapshot().Ready {
		t.Fatal("incompatible engine reported ready")
	}
	select {
	case <-p.done:
	default:
		t.Fatal("incompatible engine was not reaped")
	}
	if !supportsProfile(append(servecontract.Operations(), "future.operation")) {
		t.Fatal("additive engine capabilities must remain compatible")
	}
}

func TestSupervisorRejectsEngineWithoutCallerSessionIDsBeforeReady(t *testing.T) {
	for _, supported := range []interface{}{nil, false} {
		t.Run(fmt.Sprint(supported), func(t *testing.T) {
			p := newFake(func(p *fakeProcess, e protocol.Envelope) {
				if e.Method == "hello" {
					result := map[string]interface{}{"version": 1, "profile": "local-v1", "authenticationDeadlines": true, "operations": servecontract.Operations()}
					if supported != nil {
						result["callerSessionIds"] = supported
					}
					p.reply(e, result)
				}
			})
			t.Cleanup(func() { _ = p.Kill() })
			s := NewSupervisor(DefaultConfig(), func(context.Context) (Process, error) { return p, nil })
			if err := s.Validate(testContext(t)); !errors.Is(err, protocol.ErrVersion) {
				t.Fatalf("engine without caller session IDs was accepted: %v", err)
			}
			if s.Snapshot().Ready {
				t.Fatal("incompatible engine reported ready")
			}
			select {
			case <-p.done:
			default:
				t.Fatal("incompatible engine was not reaped")
			}
		})
	}
}

func TestSupervisorRequiresAuthenticationDeadlinesCapability(t *testing.T) {
	for _, offered := range []interface{}{nil, false} {
		t.Run(fmt.Sprint(offered), func(t *testing.T) {
			p := newFake(func(p *fakeProcess, e protocol.Envelope) {
				result := map[string]interface{}{"version": 1, "profile": "local-v1", "callerSessionIds": true, "operations": servecontract.Operations()}
				if offered != nil {
					result["authenticationDeadlines"] = offered
				}
				p.reply(e, result)
			})
			t.Cleanup(func() { _ = p.Kill() })
			s := NewSupervisor(DefaultConfig(), func(context.Context) (Process, error) { return p, nil })
			if err := s.Validate(testContext(t)); !errors.Is(err, protocol.ErrVersion) {
				t.Fatalf("unbounded authentication engine accepted: %v", err)
			}
			if s.Snapshot().Ready {
				t.Fatal("incompatible engine advertised readiness")
			}
		})
	}
}

func TestRetiringEnginePreservesAcceptedWorkAndRestartsWithoutCooldown(t *testing.T) {
	var busy, opens, dispatches, quiesces, starts atomic.Int32
	var retirement atomic.Bool
	var authenticationBudget atomic.Int64
	p := newFake(func(p *fakeProcess, e protocol.Envelope) {
		switch e.Method {
		case "hello":
			p.reply(e, map[string]interface{}{"version": 1, "profile": "local-v1", "callerSessionIds": true, "authenticationDeadlines": true, "operations": servecontract.Operations()})
		case "session.open":
			opens.Add(1)
			var params struct {
				Credential              string `json:"credential"`
				AuthenticationTimeoutMs int64  `json:"authenticationTimeoutMs"`
			}
			_ = json.Unmarshal(e.Params, &params)
			authenticationBudget.Store(params.AuthenticationTimeoutMs)
			if params.Credential == "stalled-vault" {
				retirement.Store(true)
				p.send(protocol.Envelope{Version: 1, Generation: e.Generation, ID: e.ID, Error: ErrRetiring})
			} else {
				p.reply(e, map[string]string{"sessionId": openingSessionID(e)})
			}
		case "request.dispatch":
			dispatches.Add(1)
			p.reply(e, struct{}{})
		case "engine.status":
			status := Status{State: "retiring", Sessions: 1, AuthenticationWork: 64}
			switch busy.Load() {
			case 1:
				status.Requests = 1
			case 2:
				status.Runs = 1
			case 3:
				status.Reservations = 1
			case 4:
				status.PendingWrites = 1
			}
			p.reply(e, status)
		case "engine.quiesce":
			quiesces.Add(1)
			p.reply(e, map[string]bool{"quiescent": true})
			p.finish()
		case "engine.shutdown":
			p.reply(e, struct{}{})
			p.finish()
		default:
			p.reply(e, struct{}{})
		}
	})
	config := DefaultConfig()
	config.IdleTimeout = 0
	config.Cooldown = time.Hour
	s := NewSupervisor(config, func(context.Context) (Process, error) {
		if starts.Add(1) == 1 {
			return p, nil
		}
		return lifecycleProcess(&atomic.Bool{}), nil
	})
	ctx := testContext(t)
	t.Cleanup(func() { _ = s.Shutdown(ctx) })
	healthy, err := s.Open(ctx, "healthy", "ip")
	if err != nil {
		t.Fatal(err)
	}
	if budget := authenticationBudget.Load(); budget <= 0 || budget >= config.ControlTimeout.Milliseconds() {
		t.Fatalf("authentication did not reserve caller response time: %d", budget)
	}
	var failure *protocol.Error
	if _, err := s.Open(ctx, "stalled-vault", "ip"); !errors.As(err, &failure) || failure.Code != "engine_retiring" || !retirement.Load() {
		t.Fatalf("retirement signal was lost: %v", err)
	}
	if snapshot := s.Snapshot(); snapshot.Ready || snapshot.State != "retiring" {
		t.Fatalf("retiring engine advertised readiness: %+v", snapshot)
	}
	if _, err := s.Open(ctx, "new-token", "ip"); !errors.Is(err, ErrRetiring) || opens.Load() != 2 {
		t.Fatalf("new authentication was admitted after retirement: %v", err)
	}
	for _, request := range [][]byte{[]byte(`{"type":"data.query","id":"read"}`), []byte(`{"type":"cancel","id":"run"}`)} {
		if err := s.Dispatch(ctx, healthy, request); err != nil {
			t.Fatalf("existing authorized control was fenced: %v", err)
		}
	}
	if dispatches.Load() != 2 {
		t.Fatal("Go classified or dropped existing session controls")
	}
	for _, active := range []int32{1, 2, 3, 4} {
		busy.Store(active)
		if err := s.Tick(ctx, time.Unix(1, 0)); err != nil {
			t.Fatal(err)
		}
		if quiesces.Load() != 0 || p.kills.Load() != 0 {
			t.Fatal("retirement interrupted accepted work")
		}
	}
	busy.Store(0)
	if err := s.Tick(ctx, time.Unix(1, 0)); err != nil {
		t.Fatal(err)
	}
	if snapshot := s.Snapshot(); !snapshot.Ready || snapshot.State != "stopped" || quiesces.Load() != 1 {
		t.Fatalf("idle sockets or quarantined auth blocked controlled retirement: %+v", snapshot)
	}
	_ = s.Close(ctx, healthy)
	replacement, err := s.Open(ctx, "new-token", "ip")
	if err != nil || replacement.Generation == healthy.Generation || starts.Load() != 2 {
		t.Fatalf("controlled retirement imposed failure cooldown: replacement=%v err=%v starts=%d", replacement, err, starts.Load())
	}
	if err := s.Close(ctx, replacement); err != nil {
		t.Fatal(err)
	}
}

func TestTickSkipsAdmissionWhenSessionsArePresentOrEngineStopped(t *testing.T) {
	s := NewSupervisor(DefaultConfig(), nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, sessions := range []int{0, 1} {
		s.sessions = sessions
		if sessions != 0 {
			s.client = &Client{}
		}
		if err := s.Tick(ctx, time.Unix(1, 0)); err != nil {
			t.Fatalf("unnecessary Tick queued behind admission: %v", err)
		}
	}
}

func TestTickCancelledStatusClearsIdleWithoutStoppingEngine(t *testing.T) {
	accepted := make(chan struct{})
	p := newFake(func(p *fakeProcess, e protocol.Envelope) {
		if e.Method == "engine.status" {
			close(accepted)
			return
		}
		p.reply(e, struct{}{})
	})
	c := NewClient("g", p)
	t.Cleanup(func() { c.Stop(); c.Wait() })
	s := NewSupervisor(DefaultConfig(), nil)
	s.client, s.state, s.idleSince = c, "ready", time.Unix(1, 0)
	ctx, cancel := context.WithCancel(testContext(t))
	result := make(chan error, 1)
	go func() { result <- s.Tick(ctx, time.Unix(100, 0)) }()
	<-accepted
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if !s.idleSince.IsZero() || p.kills.Load() != 0 || s.Snapshot().State != "ready" {
		t.Fatal("unresponsive engine was considered idle or killed")
	}
}

func TestQuiesceKeepsDrainBudgetWhenProbeContextEnds(t *testing.T) {
	quiescing := make(chan struct{})
	release := make(chan struct{})
	p := newFake(func(p *fakeProcess, e protocol.Envelope) {
		switch e.Method {
		case "engine.status":
			p.reply(e, Status{State: "ready"})
		case "engine.quiesce":
			close(quiescing)
			<-release
			p.reply(e, map[string]bool{"quiescent": true})
			p.finish()
		}
	})
	c := NewClient("g", p)
	t.Cleanup(func() { c.Stop(); c.Wait() })
	s := NewSupervisor(DefaultConfig(), nil)
	s.client, s.state, s.idleSince = c, "ready", time.Unix(1, 0)
	ctx, cancel := context.WithCancel(testContext(t))
	result := make(chan error, 1)
	go func() { result <- s.Tick(ctx, time.Unix(100, 0)) }()
	<-quiescing
	cancel()
	close(release)
	if err := <-result; err != nil {
		t.Fatalf("probe cancellation interrupted persistence drain: %v", err)
	}
	if s.Snapshot().State != "stopped" {
		t.Fatal("quiescent engine remained active")
	}
}

func TestCloseReleasesAccountingDespiteExpiredCallerAndHeldGate(t *testing.T) {
	var busy atomic.Bool
	p := lifecycleProcess(&busy)
	s := NewSupervisor(DefaultConfig(), func(context.Context) (Process, error) { return p, nil })
	ctx := testContext(t)
	session, err := s.Open(ctx, "credential", "ip")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { session.client.Stop(); session.client.Wait() })
	if err := s.gate.acquire(ctx, true); err != nil {
		t.Fatal(err)
	}
	expired, cancel := context.WithCancel(ctx)
	cancel()
	err = s.Close(expired, session)
	if err != nil && !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	s.gate.release(true)
	if err := session.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(ctx, session); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	sessions := s.sessions
	s.mu.Unlock()
	if sessions != 0 {
		t.Fatalf("close leaked or double-released count: %d", sessions)
	}
	select {
	case <-session.Done():
	default:
		t.Fatal("local session remained open")
	}
}

func TestEngineDeadlineReservesResponseMarginAtEveryScale(t *testing.T) {
	for _, tc := range []struct {
		duration time.Duration
		want     int64
	}{
		{30 * time.Second, 27000}, {time.Second, 500}, {10 * time.Millisecond, 5}, {time.Millisecond, 0}, {0, 0},
	} {
		if got := engineDeadline(context.Background(), tc.duration); got != tc.want {
			t.Fatalf("budget %v: %d != %d", tc.duration, got, tc.want)
		}
	}
}

type cleanupProofProcess struct {
	*fakeProcess
	proof     <-chan struct{}
	failure   error
	deadline  chan time.Time
	waitCalls atomic.Int32
}

func (p *cleanupProofProcess) Wait() error {
	p.waitCalls.Add(1)
	<-p.done
	if p.proof != nil {
		<-p.proof
	}
	return p.failure
}
func (p *cleanupProofProcess) SetCleanupDeadline(deadline time.Time) {
	if p.deadline != nil {
		p.deadline <- deadline
	}
}

func TestSupervisorDoesNotReplaceReapedEngineUntilCommandCleanup(t *testing.T) {
	var starts atomic.Int32
	var busy atomic.Bool
	proof := make(chan struct{})
	old := &cleanupProofProcess{fakeProcess: lifecycleProcess(&busy), proof: proof}
	s := NewSupervisor(DefaultConfig(), func(context.Context) (Process, error) {
		if starts.Add(1) == 1 {
			return old, nil
		}
		return lifecycleProcess(&busy), nil
	})
	s.config.Cooldown = 0
	ctx := testContext(t)
	if err := s.Validate(ctx); err != nil {
		t.Fatal(err)
	}
	c := s.client
	old.finish()
	select {
	case <-c.Done():
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := s.Validate(ctx); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("replacement admitted before cleanup: %v", err)
	}
	if starts.Load() != 1 {
		t.Fatal("new engine started before command cleanup")
	}
	close(proof)
	if err := c.Wait(); err != nil {
		t.Fatal(err)
	}
	if err := s.Validate(ctx); err != nil {
		t.Fatal(err)
	}
	if starts.Load() != 2 {
		t.Fatal("confirmed cleanup did not permit replacement")
	}
	if err := s.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestSupervisorUnconfirmedCleanupBlocksEveryReplacementPath(t *testing.T) {
	for _, path := range []string{"crash", "quiesce", "shutdown", "forced-shutdown", "startup"} {
		t.Run(path, func(t *testing.T) {
			var starts atomic.Int32
			var busy atomic.Bool
			p := lifecycleProcess(&busy)
			if path == "startup" {
				p.finish()
				p = newFake(func(p *fakeProcess, e protocol.Envelope) { p.reply(e, map[string]interface{}{"version": 99}) })
			}
			process := &cleanupProofProcess{fakeProcess: p, failure: ErrUnconfirmedCommandCleanup}
			t.Cleanup(func() { _ = process.Kill() })
			config := DefaultConfig()
			config.Cooldown = 0
			config.IdleTimeout = time.Second
			s := NewSupervisor(config, func(context.Context) (Process, error) { starts.Add(1); return process, nil })
			ctx := testContext(t)
			err := s.Validate(ctx)
			if path == "startup" {
				if !errors.Is(err, ErrUnconfirmedCommandCleanup) {
					t.Fatalf("startup lost cleanup error: %v", err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				switch path {
				case "crash":
					p.finish()
					if err := s.client.Wait(); !errors.Is(err, ErrUnconfirmedCommandCleanup) {
						t.Fatal(err)
					}
				case "quiesce":
					now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
					if err := s.Tick(ctx, now); err != nil {
						t.Fatal(err)
					}
					if err := s.Tick(ctx, now.Add(2*time.Second)); !errors.Is(err, ErrUnconfirmedCommandCleanup) {
						t.Fatalf("quiescence lost cleanup proof: %v", err)
					}
				case "shutdown":
					if err := s.Shutdown(ctx); !errors.Is(err, ErrUnconfirmedCommandCleanup) {
						t.Fatalf("shutdown lost cleanup proof: %v", err)
					}
				case "forced-shutdown":
					expired, cancel := context.WithCancel(context.Background())
					cancel()
					if err := s.Shutdown(expired); !errors.Is(err, context.Canceled) {
						t.Fatalf("forced shutdown did not terminate: %v", err)
					}
				}
			}
			for attempt := 0; attempt < 2; attempt++ {
				if err := s.Validate(ctx); !errors.Is(err, ErrUnconfirmedCommandCleanup) {
					t.Fatalf("unconfirmed generation became replaceable: %v", err)
				}
			}
			if starts.Load() != 1 {
				t.Fatalf("unsafe replacement count %d", starts.Load())
			}
			if snapshot := s.Snapshot(); snapshot.Ready || snapshot.State != "broken" {
				t.Fatalf("cleanup failure advertised ready: %+v", snapshot)
			}
		})
	}
}

func TestClientForwardsAbsoluteCommandCleanupDeadline(t *testing.T) {
	var busy atomic.Bool
	p := &cleanupProofProcess{fakeProcess: lifecycleProcess(&busy), deadline: make(chan time.Time, 1)}
	c := NewClient("cleanup-deadline", p)
	t.Cleanup(func() { c.Stop(); _ = c.Wait() })
	deadline := time.Date(2040, 3, 4, 5, 6, 7, 0, time.UTC)
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	c.SetCleanupDeadline(ctx)
	if got := <-p.deadline; !got.Equal(deadline) {
		t.Fatalf("cleanup deadline changed: %v", got)
	}
}

func TestShutdownDeadlineRetainsOneUnfinishedNativeReaper(t *testing.T) {
	for _, phase := range []string{"ready", "unadmitted-startup"} {
		t.Run(phase, func(t *testing.T) {
			proof := make(chan struct{})
			var release sync.Once
			var busy atomic.Bool
			var hellos atomic.Int32
			var starts atomic.Int32
			p := lifecycleProcess(&busy)
			if phase == "unadmitted-startup" {
				p.finish()
				p = newFake(func(_ *fakeProcess, e protocol.Envelope) {
					if e.Method == "hello" {
						hellos.Add(1)
					}
				})
			}
			process := &cleanupProofProcess{fakeProcess: p, proof: proof}
			t.Cleanup(func() { _ = process.Kill(); release.Do(func() { close(proof) }) })
			entered := make(chan struct{})
			s := NewSupervisor(DefaultConfig(), func(ctx context.Context) (Process, error) {
				starts.Add(1)
				if phase == "unadmitted-startup" {
					close(entered)
					<-ctx.Done()
				}
				return process, nil
			})
			ctx := testContext(t)
			validated := make(chan error, 1)
			if phase == "ready" {
				if err := s.Validate(ctx); err != nil {
					t.Fatal(err)
				}
			} else {
				go func() { validated <- s.Validate(ctx) }()
				select {
				case <-entered:
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			}
			expired, cancel := context.WithCancel(context.Background())
			cancel()
			shutdown := make(chan error, 1)
			go func() { shutdown <- s.Shutdown(expired) }()
			select {
			case err := <-shutdown:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("shutdown deadline lost: %v", err)
				}
			case <-ctx.Done():
				t.Fatal("shutdown waited for the held native reaper")
			}
			if phase == "unadmitted-startup" {
				select {
				case err := <-validated:
					if !errors.Is(err, ErrUnconfirmedCommandCleanup) {
						t.Fatalf("startup cleanup uncertainty lost: %v", err)
					}
				case <-ctx.Done():
					t.Fatal("unadmitted startup waited for native reap")
				}
				if hellos.Load() != 0 {
					t.Fatal("cancelled startup admitted engine work")
				}
			}
			s.mu.Lock()
			retained := s.uncertain
			s.mu.Unlock()
			if retained == nil || retained.process != process {
				t.Fatal("native reaper owner was discarded")
			}
			select {
			case <-retained.finished:
				t.Fatal("held reaper falsely completed")
			default:
			}
			if err := s.Validate(ctx); !errors.Is(err, ErrUnconfirmedCommandCleanup) {
				t.Fatalf("replacement allowed while reap is pending: %v", err)
			}
			if starts.Load() != 1 {
				t.Fatal("a replacement engine was started")
			}
			release.Do(func() { close(proof) })
			if err := retained.Wait(); !errors.Is(err, ErrUnconfirmedCommandCleanup) {
				t.Fatalf("late reap cleared sticky uncertainty: %v", err)
			}
			if process.waitCalls.Load() != 1 {
				t.Fatalf("multiple native reapers: %d", process.waitCalls.Load())
			}
			if err := s.Validate(ctx); !errors.Is(err, ErrUnconfirmedCommandCleanup) {
				t.Fatalf("late reap silently restored admission: %v", err)
			}
		})
	}
}

func TestClientExpiredJoinPreservesAlreadyConfirmedCleanup(t *testing.T) {
	var busy atomic.Bool
	client := NewClient("confirmed-cleanup", lifecycleProcess(&busy))
	client.Stop()
	if err := client.Wait(); err != nil {
		t.Fatal(err)
	}
	expired, cancel := context.WithCancel(context.Background())
	cancel()
	if err := client.WaitContext(expired); err != nil {
		t.Fatalf("confirmed cleanup became uncertain: %v", err)
	}
}

func pageProcess(mode string, extensions bool, repo string, opened *[]string, mu *sync.Mutex) *fakeProcess {
	return newFake(func(p *fakeProcess, e protocol.Envelope) {
		switch e.Method {
		case "hello":
			classes := []string{"cli", "page"}
			if mode == "read-only" {
				classes = []string{"page"}
			}
			p.reply(e, map[string]interface{}{"version": 1, "profile": "local-v1", "callerSessionIds": true, "authenticationDeadlines": true, "operations": servecontract.Operations(), "callerClasses": classes, "mode": mode, "extensions": extensions, "repo": map[string]string{"path": repo}})
		case "session.open":
			if opened != nil {
				mu.Lock()
				*opened = append(*opened, string(e.Params))
				mu.Unlock()
			}
			p.reply(e, map[string]string{"sessionId": openingSessionID(e)})
		case "engine.status":
			p.reply(e, Status{State: "ready"})
		case "engine.quiesce":
			p.reply(e, map[string]bool{"quiescent": true})
			p.finish()
		case "engine.shutdown":
			p.reply(e, struct{}{})
			p.finish()
		default:
			p.reply(e, struct{}{})
		}
	})
}

func TestPageSessionHoldsEngineThroughGraceButForcedEvictionIgnoresIt(t *testing.T) {
	config := DefaultConfig()
	config.IdleTimeout = time.Second
	config.PageIdleGrace = time.Hour
	var opened []string
	var mu sync.Mutex
	s := NewSupervisorWith(config, func(context.Context) (Process, error) {
		return pageProcess("full", true, "/repo", &opened, &mu), nil
	}, HubHandshake("/repo", true))
	ctx := testContext(t)
	session, err := s.OpenAs(ctx, OpenRequest{Class: ClassPage, SourceIP: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	if session.Class != ClassPage {
		t.Fatalf("session class %q", session.Class)
	}
	mu.Lock()
	params := opened[0]
	mu.Unlock()
	// A page open names its class and carries no credential.
	if !strings.Contains(params, `"class":"page"`) || strings.Contains(params, "credential") {
		t.Fatalf("page open params %s", params)
	}
	if err := s.Close(ctx, session); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for _, at := range []time.Time{now, now.Add(30 * time.Minute)} {
		if err := s.Tick(ctx, at); err != nil {
			t.Fatal(err)
		}
	}
	if s.Snapshot().State != "ready" {
		t.Fatal("engine stopped inside the page grace")
	}
	if err := s.QuiesceIdle(ctx); err != nil {
		t.Fatal(err)
	}
	if s.Snapshot().State != "stopped" {
		t.Fatal("forced eviction waited for the page grace")
	}
}

func TestHubHandshakeRecordsModeAndRefusesMismatches(t *testing.T) {
	ctx := testContext(t)
	readOnly := NewSupervisorWith(DefaultConfig(), func(context.Context) (Process, error) {
		return pageProcess("read-only", false, "/repo", nil, nil), nil
	}, HubHandshake("/repo", false))
	info, err := readOnly.Info(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode != "read-only" || info.Serves(ClassCLI) || !info.Serves(ClassPage) || info.Extensions {
		t.Fatalf("read-only info %+v", info)
	}
	_ = readOnly.Shutdown(ctx)
	// An engine that loaded extensions for an untrusted workspace is refused.
	mismatch := NewSupervisorWith(DefaultConfig(), func(context.Context) (Process, error) {
		return pageProcess("full", true, "/repo", nil, nil), nil
	}, HubHandshake("/repo", false))
	if err := mismatch.Validate(ctx); !errors.Is(err, ErrExtensionsMismatch) {
		t.Fatalf("expected extensions mismatch, got %v", err)
	}
	_ = mismatch.Shutdown(ctx)
	// A cli-only engine predates dashboard pages and cannot serve the hub.
	legacy := NewSupervisorWith(DefaultConfig(), func(context.Context) (Process, error) {
		return lifecycleProcess(&atomic.Bool{}), nil
	}, HubHandshake("", true))
	if err := legacy.Validate(ctx); !errors.Is(err, protocol.ErrVersion) {
		t.Fatalf("expected version refusal, got %v", err)
	}
	_ = legacy.Shutdown(ctx)
}

type pidProcess struct{ *fakeProcess }

func (pidProcess) Pid() int { return 321 }

func TestSupervisorDetailsReportTheRunningGeneration(t *testing.T) {
	var opened []string
	var mu sync.Mutex
	s := NewSupervisorWith(DefaultConfig(), func(context.Context) (Process, error) {
		return pidProcess{pageProcess("full", true, "/repo", &opened, &mu)}, nil
	}, HubHandshake("/repo", true))
	if details := s.Details(); details != (Details{}) {
		t.Fatalf("details before start: %+v", details)
	}
	ctx := testContext(t)
	session, err := s.OpenAs(ctx, OpenRequest{Class: ClassPage, SourceIP: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	details := s.Details()
	if details.PID != 321 || details.StartedAt.IsZero() || details.Sessions != 1 || details.Pages != 1 {
		t.Fatalf("details: %+v", details)
	}
	if err := s.Close(ctx, session); err != nil {
		t.Fatal(err)
	}
	if details := s.Details(); details.Sessions != 0 || details.Pages != 0 || details.PID != 321 {
		t.Fatalf("details after close: %+v", details)
	}
}

func TestSupervisorLingerKeepsAPagelessGenerationThroughTheGrace(t *testing.T) {
	config := DefaultConfig()
	config.IdleTimeout = time.Second
	config.PageIdleGrace = time.Hour
	var opened []string
	var mu sync.Mutex
	s := NewSupervisorWith(config, func(context.Context) (Process, error) {
		return pageProcess("full", true, "/repo", &opened, &mu), nil
	}, HubHandshake("/repo", true))
	ctx := testContext(t)
	s.Linger()
	if err := s.Validate(ctx); err != nil {
		t.Fatal(err)
	}
	s.Linger()
	now := time.Now()
	for _, at := range []time.Time{now, now.Add(30 * time.Minute)} {
		if err := s.Tick(ctx, at); err != nil {
			t.Fatal(err)
		}
	}
	if s.Snapshot().State != "ready" {
		t.Fatal("a lingering engine stopped inside the grace")
	}
}
