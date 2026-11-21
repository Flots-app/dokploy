package provider

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
)

// fakeTRPC is an in-memory stand-in for the raw tRPC endpoint
// (/api/trpc/<router>.<proc>) of the Flots-fork-only routers: GitHub runner
// pools and machines, OS updates and firewalls. It mimics what matters for the
// resources: the zod validation of the real inputs (required keys, defaults of
// the keys left out, unknown keys stripped), the secrets that are never read
// back, and the overview/list shapes the objects are found in.
type fakeTRPC struct {
	t  *testing.T
	mu sync.Mutex
	// next numbers the ids.
	next int

	pools   map[string]map[string]any
	secrets map[string]map[string]any // pool id -> stored secrets
	nodes   map[string]map[string]any

	servers    map[string]string         // serverId -> name
	osConfigs  map[string]map[string]any // osUpdateConfigurationId -> row
	osAssigned map[string]string         // "server:<id>" | "node:<id>" -> configuration id
	firewalls  map[string]map[string]any // firewallId -> row
	attached   map[string]string         // "<type>:<id>" -> firewallId
	calls      []fakeTRPCCall
	hooks      map[string]func(in map[string]any) *fakeTRPCError
	removeLag  int            // overview reads a removed machine stays for
	removing   map[string]int // machine id -> reads left
	procs      map[string]func(in map[string]any) (any, *fakeTRPCError)
	allowCalls map[string]bool
}

type fakeTRPCCall struct {
	Proc  string
	Input map[string]any
}

type fakeTRPCError struct {
	Status  int
	Message string
}

func newFakeTRPC(t *testing.T) (*fakeTRPC, *httptest.Server) {
	f := &fakeTRPC{
		t:          t,
		pools:      map[string]map[string]any{},
		secrets:    map[string]map[string]any{},
		nodes:      map[string]map[string]any{},
		servers:    map[string]string{},
		osConfigs:  map[string]map[string]any{},
		osAssigned: map[string]string{},
		firewalls:  map[string]map[string]any{},
		attached:   map[string]string{},
		hooks:      map[string]func(map[string]any) *fakeTRPCError{},
		removing:   map[string]int{},
	}
	f.procs = map[string]func(map[string]any) (any, *fakeTRPCError){
		"githubRunner.overview":        f.poolOverview,
		"githubRunner.createPool":      f.createPool,
		"githubRunner.updatePool":      f.updatePool,
		"githubRunner.removePool":      f.removePool,
		"githubRunner.updateMachine":   f.updateMachine,
		"githubRunner.enableMachine":   f.enableMachine,
		"githubRunner.disableMachine":  f.disableMachine,
		"githubRunner.removeMachine":   f.removeMachine,
		"osUpdate.overview":            f.osOverview,
		"osUpdate.createConfiguration": f.osCreate,
		"osUpdate.updateConfiguration": f.osUpdate,
		"osUpdate.removeConfiguration": f.osRemove,
		"firewall.list":                f.fwList,
		"firewall.create":              f.fwCreate,
		"firewall.update":              f.fwUpdate,
		"firewall.remove":              f.fwRemove,
		"firewall.attach":              f.fwAttach,
		"firewall.detach":              f.fwDetach,
	}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeTRPC) newID(prefix string) string {
	f.next++
	return fmt.Sprintf("%s-%d", prefix, f.next)
}

// ------------------------------------------------------------------ HTTP

func (f *fakeTRPC) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	reply := func(status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(v)
	}
	fail := func(e *fakeTRPCError) {
		reply(e.Status, map[string]any{"error": map[string]any{"json": map[string]any{"message": e.Message, "code": -32600}}})
	}
	if r.Header.Get("x-api-key") != "test-key" {
		fail(&fakeTRPCError{http.StatusUnauthorized, "unauthorized"})
		return
	}
	proc, ok := strings.CutPrefix(r.URL.Path, "/api/trpc/")
	if !ok {
		fail(&fakeTRPCError{http.StatusNotFound, "not a tRPC path: " + r.URL.Path})
		return
	}
	in := map[string]any{}
	var envelope struct {
		JSON map[string]any `json:"json"`
	}
	switch r.Method {
	case http.MethodGet:
		if raw := r.URL.Query().Get("input"); raw != "" {
			if err := json.Unmarshal([]byte(raw), &envelope); err != nil {
				fail(&fakeTRPCError{http.StatusBadRequest, "bad input: " + err.Error()})
				return
			}
		}
	case http.MethodPost:
		if err := json.NewDecoder(r.Body).Decode(&envelope); err != nil {
			fail(&fakeTRPCError{http.StatusBadRequest, "bad body: " + err.Error()})
			return
		}
	}
	if envelope.JSON != nil {
		in = envelope.JSON
	}
	f.calls = append(f.calls, fakeTRPCCall{Proc: proc, Input: in})
	if h, ok := f.hooks[proc]; ok {
		if e := h(in); e != nil {
			fail(e)
			return
		}
	}
	h, ok := f.procs[proc]
	if !ok {
		fail(&fakeTRPCError{http.StatusNotFound, "No procedure found on path " + proc})
		return
	}
	out, e := h(in)
	if e != nil {
		fail(e)
		return
	}
	reply(http.StatusOK, map[string]any{"result": map[string]any{"data": map[string]any{"json": out}}})
}

// callsOf returns the inputs the procedure was called with.
func (f *fakeTRPC) callsOf(proc string) []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []map[string]any
	for _, c := range f.calls {
		if c.Proc == proc {
			out = append(out, c.Input)
		}
	}
	return out
}

func (f *fakeTRPC) called(proc string) int { return len(f.callsOf(proc)) }

// resetCalls forgets the recorded calls.
func (f *fakeTRPC) resetCalls() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = nil
}

// ------------------------------------------------------------------ zod-ish helpers

func ftBad(format string, a ...any) *fakeTRPCError {
	return &fakeTRPCError{http.StatusBadRequest, fmt.Sprintf(format, a...)}
}

var ftNotFound = func(what string) *fakeTRPCError {
	return &fakeTRPCError{http.StatusNotFound, what + " not found"}
}

func ftMap(v any) map[string]any { m, _ := v.(map[string]any); return m }
func ftList(v any) []any         { l, _ := v.([]any); return l }

// ftDefault returns in[key], or def when the key is left out (zod .default()).
func ftDefault(in map[string]any, key string, def any) any {
	if v, ok := in[key]; ok {
		return v
	}
	return def
}

// ftRequire checks that an object carries every listed key.
func ftRequire(what string, obj map[string]any, keys ...string) *fakeTRPCError {
	if obj == nil {
		return ftBad("%s: expected an object", what)
	}
	for _, k := range keys {
		if _, ok := obj[k]; !ok {
			return ftBad("%s.%s: Required", what, k)
		}
	}
	return nil
}

func ftEnum(what string, v any, allowed ...string) *fakeTRPCError {
	s, _ := v.(string)
	for _, a := range allowed {
		if s == a {
			return nil
		}
	}
	return ftBad("%s: invalid enum value %v, expected %s", what, v, strings.Join(allowed, " | "))
}

func ftInt(what string, v any, lo, hi float64) *fakeTRPCError {
	n, ok := v.(float64)
	if !ok || n != float64(int64(n)) || n < lo || n > hi {
		return ftBad("%s: expected an integer between %v and %v, got %v", what, lo, hi, v)
	}
	return nil
}

func ftDeepCopy(v any) any {
	b, _ := json.Marshal(v)
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}

func ftCopy(m map[string]any) map[string]any {
	if m == nil {
		return nil
	}
	return ftDeepCopy(m).(map[string]any)
}

// ------------------------------------------------------------------ GitHub runner pools

var ftLabelRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

func ftLabels(what string, v any, min, max int) *fakeTRPCError {
	l, ok := v.([]any)
	if !ok || len(l) < min || len(l) > max {
		return ftBad("%s: expected an array of %d to %d labels", what, min, max)
	}
	for _, e := range l {
		if s, _ := e.(string); !ftLabelRe.MatchString(s) {
			return ftBad("%s: Invalid label %v", what, e)
		}
	}
	return nil
}

func ftStrOrNull(what string, v any) *fakeTRPCError {
	if v == nil {
		return nil
	}
	if _, ok := v.(string); !ok {
		return ftBad("%s: expected a string or null", what)
	}
	return nil
}

// ftPoolValues validates a pool payload the way apiCreateGithubRunnerPool /
// apiUpdateGithubRunnerPool do, and returns the stored columns (without the
// secrets): keys left out take their default, unknown keys are dropped.
func ftPoolValues(in map[string]any) (map[string]any, *fakeTRPCError) {
	if s, _ := in["name"].(string); strings.TrimSpace(s) == "" {
		return nil, ftBad("name: Required")
	}
	if e := ftEnum("scope", in["scope"], "organization", "repository"); e != nil {
		return nil, e
	}
	if s, _ := in["owner"].(string); s == "" {
		return nil, ftBad("owner: Required")
	}
	if e := ftEnum("authType", in["authType"], "token", "app", "provider"); e != nil {
		return nil, e
	}
	v := map[string]any{
		"name": in["name"], "scope": in["scope"], "owner": in["owner"], "authType": in["authType"],
		"description":            ftDefault(in, "description", nil),
		"repository":             ftDefault(in, "repository", nil),
		"runnerGroup":            ftDefault(in, "runnerGroup", "Default"),
		"labels":                 ftDefault(in, "labels", []any{}),
		"apiUrl":                 ftDefault(in, "apiUrl", "https://api.github.com"),
		"appId":                  ftDefault(in, "appId", nil),
		"appInstallationId":      ftDefault(in, "appInstallationId", nil),
		"githubId":               ftDefault(in, "githubId", nil),
		"runnerVersion":          ftDefault(in, "runnerVersion", nil),
		"jobStartedHook":         ftDefault(in, "jobStartedHook", nil),
		"jobCompletedHook":       ftDefault(in, "jobCompletedHook", nil),
		"rerunInterruptedJobs":   ftDefault(in, "rerunInterruptedJobs", true),
		"routingVariable":        ftDefault(in, "routingVariable", nil),
		"fallbackLabels":         ftDefault(in, "fallbackLabels", []any{"ubuntu-24.04"}),
		"x64FallbackLabels":      ftDefault(in, "x64FallbackLabels", []any{"ubuntu-24.04"}),
		"fallbackChain":          ftDefault(in, "fallbackChain", []any{}),
		"jobClasses":             ftDefault(in, "jobClasses", []any{}),
		"blacksmithOrganization": ftDefault(in, "blacksmithOrganization", nil),
		"placement":              ftDefault(in, "placement", "fastest"),
		"autonomyReserve":        ftDefault(in, "autonomyReserve", float64(2)),
	}
	for _, k := range []string{"description", "repository", "appInstallationId", "githubId", "runnerVersion", "jobStartedHook", "jobCompletedHook", "routingVariable", "blacksmithOrganization"} {
		if e := ftStrOrNull(k, v[k]); e != nil {
			return nil, e
		}
	}
	if (v["scope"] == "repository") != (v["repository"] != nil) {
		return nil, ftBad("repository: A repository pool needs a repository, an organization pool none")
	}
	if e := ftLabels("labels", v["labels"], 0, 50); e != nil {
		return nil, e
	}
	if v["routingVariable"] != nil && len(ftList(v["labels"])) == 0 {
		return nil, ftBad("labels: The fallback needs a label")
	}
	if e := ftLabels("fallbackLabels", v["fallbackLabels"], 1, 10); e != nil {
		return nil, e
	}
	if e := ftLabels("x64FallbackLabels", v["x64FallbackLabels"], 1, 10); e != nil {
		return nil, e
	}
	if e := ftEnum("placement", v["placement"], "fastest", "spread"); e != nil {
		return nil, e
	}
	if e := ftInt("autonomyReserve", v["autonomyReserve"], 0, 10); e != nil {
		return nil, e
	}
	// failover: the object is optional, its keys are not.
	failover := ftDefault(in, "failover", map[string]any{"interruptions": float64(2), "windowMinutes": float64(10), "cooldownMinutes": float64(30), "mode": "auto"})
	fo := ftMap(failover)
	if e := ftRequire("failover", fo, "interruptions", "windowMinutes", "cooldownMinutes", "mode"); e != nil {
		return nil, e
	}
	if e := ftEnum("failover.mode", fo["mode"], "auto", "pool", "fallback"); e != nil {
		return nil, e
	}
	v["failover"] = ftPick(fo, "interruptions", "windowMinutes", "cooldownMinutes", "mode")
	// jobGuard: every key has its own default.
	jg := ftMap(ftDefault(in, "jobGuard", map[string]any{}))
	if jg == nil {
		return nil, ftBad("jobGuard: expected an object")
	}
	v["jobGuard"] = map[string]any{
		"repositories":     ftDefault(jg, "repositories", []any{}),
		"events":           ftDefault(jg, "events", []any{}),
		"refuseForks":      ftDefault(jg, "refuseForks", true),
		"refuseDependabot": ftDefault(jg, "refuseDependabot", true),
	}
	ro := ftMap(ftDefault(in, "rolloutPolicy", map[string]any{"maxUnavailable": float64(1), "canary": true}))
	if e := ftRequire("rolloutPolicy", ro, "maxUnavailable", "canary"); e != nil {
		return nil, e
	}
	v["rolloutPolicy"] = ftPick(ro, "maxUnavailable", "canary")
	up := ftMap(ftDefault(in, "updatePolicy", map[string]any{"auto": true, "window": nil}))
	if e := ftRequire("updatePolicy", up, "auto", "window"); e != nil {
		return nil, e
	}
	v["updatePolicy"] = ftPick(up, "auto", "window", "osPatches")
	// fallbackChain and jobClasses: every key but classLabels is required.
	chain := make([]any, 0)
	for i, e := range ftList(v["fallbackChain"]) {
		p := ftMap(e)
		if err := ftRequire(fmt.Sprintf("fallbackChain[%d]", i), p, "id", "kind", "labels", "x64Labels", "budget"); err != nil {
			return nil, err
		}
		keep := ftPick(p, "id", "kind", "labels", "x64Labels", "budget", "classLabels")
		if b := ftMap(p["budget"]); b != nil {
			keep["budget"] = ftPick(b, "freeMinutes", "pricePerMinute", "overspend", "warningPercent")
			if err := ftRequire("budget", keep["budget"].(map[string]any), "freeMinutes", "pricePerMinute", "overspend", "warningPercent"); err != nil {
				return nil, err
			}
		}
		chain = append(chain, keep)
	}
	v["fallbackChain"] = chain
	classes := make([]any, 0)
	for i, e := range ftList(v["jobClasses"]) {
		c := ftMap(e)
		if err := ftRequire(fmt.Sprintf("jobClasses[%d]", i), c, "id", "suffix", "arch", "fallbackLabels"); err != nil {
			return nil, err
		}
		classes = append(classes, ftPick(c, "id", "suffix", "arch", "fallbackLabels"))
	}
	v["jobClasses"] = classes
	return v, nil
}

func ftPick(m map[string]any, keys ...string) map[string]any {
	out := map[string]any{}
	for _, k := range keys {
		if v, ok := m[k]; ok {
			out[k] = v
		}
	}
	return out
}

// poolSecrets validates the credentials of a creation.
func (f *fakeTRPC) checkPoolCredentials(in map[string]any) *fakeTRPCError {
	missing := (in["authType"] == "token" && in["token"] == nil) ||
		(in["authType"] == "app" && (in["appId"] == nil || in["appPrivateKey"] == nil)) ||
		(in["authType"] == "provider" && in["githubId"] == nil)
	if missing {
		return ftBad("Missing credentials for this authentication method")
	}
	return nil
}

func (f *fakeTRPC) poolNameTaken(name, except string) bool {
	for id, p := range f.pools {
		if id != except && p["name"] == name {
			return true
		}
	}
	return false
}

func (f *fakeTRPC) publicPool(id string) map[string]any {
	p := ftCopy(f.pools[id])
	s := f.secrets[id]
	p["hasToken"] = s["token"] != nil
	p["hasAppPrivateKey"] = s["appPrivateKey"] != nil
	p["hasBlacksmithToken"] = s["blacksmithToken"] != nil
	p["hasBillingToken"] = s["billingToken"] != nil
	keys := []any{}
	for _, line := range strings.Split(ftStr(s["runnerEnv"]), "\n") {
		if k, _, ok := strings.Cut(line, "="); ok && strings.TrimSpace(k) != "" {
			keys = append(keys, strings.TrimSpace(k))
		}
	}
	p["runnerEnvKeys"] = keys
	return p
}

func ftStr(v any) string { s, _ := v.(string); return s }

func (f *fakeTRPC) createPool(in map[string]any) (any, *fakeTRPCError) {
	v, e := ftPoolValues(in)
	if e != nil {
		return nil, e
	}
	if e := f.checkPoolCredentials(in); e != nil {
		return nil, e
	}
	if f.poolNameTaken(ftStr(v["name"]), "") {
		return nil, &fakeTRPCError{http.StatusConflict, fmt.Sprintf("A runner pool named %s already exists", v["name"])}
	}
	id := f.newID("pool")
	f.storePool(id, v)
	f.secrets[id] = map[string]any{
		"token": in["token"], "appPrivateKey": in["appPrivateKey"], "runnerEnv": ftDefault(in, "runnerEnv", ""),
		"blacksmithToken": in["blacksmithToken"], "billingToken": in["billingToken"],
	}
	return f.publicPool(id), nil
}

func (f *fakeTRPC) storePool(id string, v map[string]any) {
	v["githubRunnerPoolId"] = id
	if _, ok := v["organizationId"]; !ok {
		v["organizationId"] = "org-1"
	}
	if _, ok := v["createdAt"]; !ok {
		v["createdAt"] = "2026-01-01T00:00:00.000Z"
	}
	for _, k := range []string{"routing", "x64Routing"} {
		if _, ok := v[k]; !ok {
			v[k] = nil
		}
	}
	for _, k := range []string{"rollouts", "classRouting", "fallbackUsage"} {
		if _, ok := v[k]; !ok {
			v[k] = map[string]any{}
		}
	}
	f.pools[id] = v
}

func (f *fakeTRPC) updatePool(in map[string]any) (any, *fakeTRPCError) {
	id := ftStr(in["githubRunnerPoolId"])
	old := f.pools[id]
	if old == nil {
		return nil, ftNotFound("Runner pool")
	}
	v, e := ftPoolValues(in)
	if e != nil {
		return nil, e
	}
	if f.poolNameTaken(ftStr(v["name"]), id) {
		return nil, &fakeTRPCError{http.StatusConflict, "A runner pool named " + ftStr(v["name"]) + " already exists"}
	}
	for _, n := range f.nodes {
		if n["githubRunnerPoolId"] == id && (v["scope"] != old["scope"] || v["owner"] != old["owner"] || v["repository"] != old["repository"] || v["apiUrl"] != old["apiUrl"]) {
			return nil, ftBad("The GitHub target of a pool with machines cannot change: remove its machines first")
		}
	}
	// Runtime state is not touched by an update.
	for _, k := range []string{"createdAt", "organizationId", "routing", "x64Routing", "rollouts", "classRouting", "fallbackUsage"} {
		v[k] = old[k]
	}
	f.storePool(id, v)
	// Secrets left null keep their stored value.
	s := f.secrets[id]
	for _, k := range []string{"token", "appPrivateKey", "runnerEnv", "blacksmithToken", "billingToken"} {
		if in[k] != nil {
			s[k] = in[k]
		}
	}
	return f.publicPool(id), nil
}

func (f *fakeTRPC) removePool(in map[string]any) (any, *fakeTRPCError) {
	id := ftStr(in["githubRunnerPoolId"])
	if f.pools[id] == nil {
		return nil, ftNotFound("Runner pool")
	}
	for _, n := range f.nodes {
		if n["githubRunnerPoolId"] == id {
			return nil, ftBad("Remove the machines of this pool first")
		}
	}
	delete(f.pools, id)
	delete(f.secrets, id)
	return map[string]any{"warning": nil}, nil
}

func (f *fakeTRPC) publicNode(id string) map[string]any {
	n := ftCopy(f.nodes[id])
	n["hasOwnKey"] = true
	n["firewallStatus"] = nil
	n["runnerNamePrefix"] = "dkp-" + ftStr(n["name"]) + "-"
	return n
}

func (f *fakeTRPC) poolOverview(map[string]any) (any, *fakeTRPCError) {
	// A machine being removed disappears after a few reads.
	for id, left := range f.removing {
		if left <= 0 {
			delete(f.nodes, id)
			delete(f.removing, id)
		} else {
			f.removing[id] = left - 1
		}
	}
	ids := make([]string, 0, len(f.pools))
	for id := range f.pools {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ftStr(f.pools[ids[i]]["name"]) < ftStr(f.pools[ids[j]]["name"]) })
	out := []any{}
	for _, id := range ids {
		p := f.publicPool(id)
		p["firewall"] = nil
		p["latestRunnerVersion"] = "2.338.2"
		p["reroutes"] = []any{}
		p["nextNodeId"] = nil
		nodes := []any{}
		nids := make([]string, 0)
		for nid, n := range f.nodes {
			if n["githubRunnerPoolId"] == id {
				nids = append(nids, nid)
			}
		}
		sort.Strings(nids)
		for _, nid := range nids {
			nodes = append(nodes, f.publicNode(nid))
		}
		p["nodes"] = nodes
		out = append(out, p)
	}
	return out, nil
}

// ------------------------------------------------------------------ GitHub runner machines

func (f *fakeTRPC) updateMachine(in map[string]any) (any, *fakeTRPCError) {
	id := ftStr(in["githubRunnerNodeId"])
	n := f.nodes[id]
	if n == nil {
		return nil, ftNotFound("Runner machine")
	}
	if e := ftRequire("input", in, "description", "cpuPercent", "memoryPercent", "diskReserveGb", "diskCleanupPercent", "maxRunners", "vmDiskGb", "extraLabels"); e != nil {
		return nil, e
	}
	for _, c := range []struct {
		k      string
		lo, hi float64
	}{{"cpuPercent", 10, 100}, {"memoryPercent", 10, 100}, {"diskReserveGb", 0, 10000}, {"diskCleanupPercent", 50, 99}, {"maxRunners", 0, 32}, {"vmDiskGb", 20, 4096}} {
		if e := ftInt(c.k, in[c.k], c.lo, c.hi); e != nil {
			return nil, e
		}
	}
	if e := ftLabels("extraLabels", in["extraLabels"], 0, 20); e != nil {
		return nil, e
	}
	if x, ok := in["x64Runners"]; ok {
		if e := ftInt("x64Runners", x, 0, 4); e != nil {
			return nil, e
		}
		if x.(float64) > 0 && n["platform"] != "macos" {
			return nil, ftBad("x86_64 runners run on Macs, through Rosetta")
		}
	}
	if up, ok := in["updatePolicy"]; ok && up != nil {
		if e := ftRequire("updatePolicy", ftMap(up), "auto", "window"); e != nil {
			return nil, e
		}
	}
	n["description"] = in["description"]
	for _, k := range []string{"cpuPercent", "memoryPercent", "diskReserveGb", "diskCleanupPercent", "maxRunners", "vmDiskGb", "extraLabels"} {
		n[k] = in[k]
	}
	// Left out keeps the current setting; null (updatePolicy) follows the pool.
	for _, k := range []string{"x64Runners", "updatePolicy"} {
		if v, ok := in[k]; ok {
			n[k] = v
		}
	}
	return map[string]any{"node": f.publicNode(id), "operation": nil}, nil
}

func (f *fakeTRPC) enableMachine(in map[string]any) (any, *fakeTRPCError) {
	n := f.nodes[ftStr(in["githubRunnerNodeId"])]
	if n == nil {
		return nil, ftNotFound("Runner machine")
	}
	n["enabled"], n["phase"] = true, "ready"
	return map[string]any{"githubRunnerOperationId": f.newID("op")}, nil
}

func (f *fakeTRPC) disableMachine(in map[string]any) (any, *fakeTRPCError) {
	n := f.nodes[ftStr(in["githubRunnerNodeId"])]
	if n == nil {
		return nil, ftNotFound("Runner machine")
	}
	if e := ftEnum("mode", in["mode"], "wait", "kill"); e != nil {
		return nil, e
	}
	n["enabled"], n["phase"] = false, "stopped"
	return nil, nil
}

func (f *fakeTRPC) removeMachine(in map[string]any) (any, *fakeTRPCError) {
	id := ftStr(in["githubRunnerNodeId"])
	if f.nodes[id] == nil {
		return nil, ftNotFound("Runner machine")
	}
	if e := ftEnum("mode", in["mode"], "wait", "kill"); e != nil {
		return nil, e
	}
	if f.removeLag > 0 && in["force"] != true {
		f.removing[id] = f.removeLag
		f.nodes[id]["phase"] = "draining"
		return map[string]any{"githubRunnerOperationId": f.newID("op")}, nil
	}
	delete(f.nodes, id)
	return nil, nil
}

// seedPool stores a pool as githubRunner.overview shows it (what is derived
// is dropped) and returns its id. The has* flags decide which secrets exist.
func (f *fakeTRPC) seedPool(raw string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var p map[string]any
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		f.t.Fatalf("bad pool sample: %v", err)
	}
	id := ftStr(p["githubRunnerPoolId"])
	for _, k := range []string{"hasToken", "hasAppPrivateKey", "hasBlacksmithToken", "hasBillingToken", "runnerEnvKeys", "firewall", "latestRunnerVersion", "reroutes", "nextNodeId", "nodes"} {
		delete(p, k)
	}
	f.pools[id] = p
	f.secrets[id] = map[string]any{"runnerEnv": ""}
	return id
}

// seedNode stores a machine as the overview shows it.
func (f *fakeTRPC) seedNode(raw string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var n map[string]any
	if err := json.Unmarshal([]byte(raw), &n); err != nil {
		f.t.Fatalf("bad node sample: %v", err)
	}
	for _, k := range []string{"hasOwnKey", "firewallStatus", "runnerNamePrefix"} {
		delete(n, k)
	}
	id := ftStr(n["githubRunnerNodeId"])
	f.nodes[id] = n
	return id
}

// poolField and nodeField read what the fake stores.
func (f *fakeTRPC) pool(id string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return ftCopy(f.pools[id])
}

func (f *fakeTRPC) secret(id, key string) any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.secrets[id][key]
}

func (f *fakeTRPC) node(id string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return ftCopy(f.nodes[id])
}

// ------------------------------------------------------------------ OS updates

var (
	ftClockRe  = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
	ftRuleKeys = []string{"id", "direction", "action", "protocol", "ports", "peer", "description"}
)

func ftOsValues(in map[string]any) (map[string]any, *fakeTRPCError) {
	if s := ftStr(in["name"]); s == "" {
		return nil, ftBad("name: Required")
	}
	sc := ftMap(in["schedule"])
	if e := ftRequire("schedule", sc, "recurrence", "startTime", "timeZone", "durationMinutes"); e != nil {
		return nil, e
	}
	if e := ftEnum("schedule.recurrence", sc["recurrence"], "daily", "weekly", "monthly"); e != nil {
		return nil, e
	}
	if !ftClockRe.MatchString(ftStr(sc["startTime"])) {
		return nil, ftBad("schedule.startTime: Use a 24-hour time such as 02:00")
	}
	if e := ftInt("schedule.durationMinutes", sc["durationMinutes"], 60, 720); e != nil {
		return nil, e
	}
	schedule := map[string]any{
		"recurrence": sc["recurrence"], "startTime": sc["startTime"], "timeZone": sc["timeZone"], "durationMinutes": sc["durationMinutes"],
		"weekdays":     ftDefault(sc, "weekdays", []any{}),
		"monthlyMode":  ftDefault(sc, "monthlyMode", "day"),
		"monthDay":     ftDefault(sc, "monthDay", float64(1)),
		"monthWeek":    ftDefault(sc, "monthWeek", float64(1)),
		"monthWeekday": ftDefault(sc, "monthWeekday", float64(0)),
	}
	if schedule["recurrence"] == "weekly" && len(ftList(schedule["weekdays"])) == 0 {
		return nil, ftBad("schedule.weekdays: Pick at least one day")
	}
	v := map[string]any{
		"name":               in["name"],
		"description":        ftDefault(in, "description", nil),
		"enabled":            ftDefault(in, "enabled", true),
		"schedule":           schedule,
		"classification":     ftDefault(in, "classification", "security"),
		"includePackages":    ftDefault(in, "includePackages", []any{}),
		"excludePackages":    ftDefault(in, "excludePackages", []any{}),
		"reboot":             ftDefault(in, "reboot", "if-required"),
		"allowDockerUpdates": ftDefault(in, "allowDockerUpdates", false),
		"notifyOnSuccess":    ftDefault(in, "notifyOnSuccess", false),
	}
	if e := ftEnum("classification", v["classification"], "security", "all"); e != nil {
		return nil, e
	}
	if e := ftEnum("reboot", v["reboot"], "if-required", "never", "always"); e != nil {
		return nil, e
	}
	return v, nil
}

func (f *fakeTRPC) osAssign(id string, in map[string]any) *fakeTRPCError {
	servers := ftList(ftDefault(in, "serverIds", []any{}))
	nodes := ftList(ftDefault(in, "runnerNodeIds", []any{}))
	for _, s := range servers {
		if _, ok := f.servers[ftStr(s)]; !ok {
			return &fakeTRPCError{http.StatusForbidden, "You cannot access this server"}
		}
	}
	for _, n := range nodes {
		if f.nodes[ftStr(n)] == nil {
			return &fakeTRPCError{http.StatusForbidden, "You cannot access this runner machine"}
		}
	}
	for k, cfg := range f.osAssigned {
		if cfg == id {
			delete(f.osAssigned, k)
		}
	}
	for _, s := range servers {
		f.osAssigned["server:"+ftStr(s)] = id
	}
	for _, n := range nodes {
		f.osAssigned["node:"+ftStr(n)] = id
	}
	return nil
}

func (f *fakeTRPC) osCreate(in map[string]any) (any, *fakeTRPCError) {
	v, e := ftOsValues(in)
	if e != nil {
		return nil, e
	}
	for _, c := range f.osConfigs {
		if c["name"] == v["name"] {
			return nil, &fakeTRPCError{http.StatusConflict, "A configuration named " + ftStr(v["name"]) + " already exists"}
		}
	}
	id := f.newID("osu")
	if e := f.osAssign(id, in); e != nil {
		return nil, e
	}
	v["osUpdateConfigurationId"], v["organizationId"] = id, "org-1"
	v["createdAt"], v["updatedAt"] = "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"
	f.osConfigs[id] = v
	return ftCopy(v), nil
}

func (f *fakeTRPC) osUpdate(in map[string]any) (any, *fakeTRPCError) {
	id := ftStr(in["osUpdateConfigurationId"])
	old := f.osConfigs[id]
	if old == nil {
		return nil, ftNotFound("Maintenance configuration")
	}
	v, e := ftOsValues(in)
	if e != nil {
		return nil, e
	}
	if e := f.osAssign(id, in); e != nil {
		return nil, e
	}
	v["osUpdateConfigurationId"], v["organizationId"], v["createdAt"] = id, "org-1", old["createdAt"]
	v["updatedAt"] = "2026-02-02T00:00:00.000Z"
	f.osConfigs[id] = v
	return ftCopy(v), nil
}

func (f *fakeTRPC) osRemove(in map[string]any) (any, *fakeTRPCError) {
	id := ftStr(in["osUpdateConfigurationId"])
	if f.osConfigs[id] == nil {
		return nil, ftNotFound("Maintenance configuration")
	}
	delete(f.osConfigs, id)
	for k, cfg := range f.osAssigned {
		if cfg == id {
			delete(f.osAssigned, k)
		}
	}
	return map[string]any{"ok": true}, nil
}

func (f *fakeTRPC) osOverview(map[string]any) (any, *fakeTRPCError) {
	servers := []any{}
	for id, name := range f.servers {
		servers = append(servers, map[string]any{"serverId": id, "name": name, "configuration": nil})
	}
	runnerNodes := []any{}
	for id, n := range f.nodes {
		if n["platform"] == "linux" {
			runnerNodes = append(runnerNodes, map[string]any{"githubRunnerNodeId": id, "name": n["name"], "configuration": nil})
		}
	}
	cfgs := []any{}
	ids := make([]string, 0, len(f.osConfigs))
	for id := range f.osConfigs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		c := ftCopy(f.osConfigs[id])
		srv, nodes := []any{}, []any{}
		for k, cfg := range f.osAssigned {
			if cfg != id {
				continue
			}
			kind, mid, _ := strings.Cut(k, ":")
			if kind == "server" {
				srv = append(srv, map[string]any{"serverId": mid, "name": f.servers[mid]})
			} else {
				nodes = append(nodes, map[string]any{"githubRunnerNodeId": mid, "name": f.nodes[mid]["name"]})
			}
		}
		c["servers"], c["runnerNodes"], c["hiddenMachines"] = srv, nodes, 0
		c["window"] = map[string]any{"open": nil, "next": nil}
		cfgs = append(cfgs, c)
	}
	return map[string]any{"servers": servers, "runnerNodes": runnerNodes, "configurations": cfgs}, nil
}

// ------------------------------------------------------------------ firewalls

func ftFwValues(in map[string]any, partial bool) (map[string]any, *fakeTRPCError) {
	v := map[string]any{}
	set := func(k string, def any) {
		if x, ok := in[k]; ok {
			v[k] = x
		} else if !partial {
			v[k] = def
		}
	}
	if !partial {
		if s := ftStr(in["name"]); s == "" {
			return nil, ftBad("name: Required")
		}
	}
	set("name", nil)
	set("description", nil)
	set("inboundPolicy", "allow")
	set("outboundPolicy", "allow")
	set("rules", []any{})
	for _, k := range []string{"inboundPolicy", "outboundPolicy"} {
		if x, ok := v[k]; ok {
			if e := ftEnum(k, x, "allow", "deny"); e != nil {
				return nil, e
			}
		}
	}
	if rules, ok := v["rules"]; ok {
		kept := []any{}
		ids := map[string]bool{}
		for i, r := range ftList(rules) {
			rule := ftMap(r)
			if e := ftRequire(fmt.Sprintf("rules[%d]", i), rule, ftRuleKeys...); e != nil {
				return nil, e
			}
			if e := ftEnum("direction", rule["direction"], "inbound", "outbound"); e != nil {
				return nil, e
			}
			if e := ftEnum("action", rule["action"], "allow", "deny"); e != nil {
				return nil, e
			}
			if e := ftEnum("protocol", rule["protocol"], "any", "tcp", "udp", "icmp"); e != nil {
				return nil, e
			}
			peer := ftMap(rule["peer"])
			switch ftStr(peer["type"]) {
			case "object":
				if e := ftEnum("peer.object", peer["object"], "internet", "private", "tailnet", "dokploy", "any"); e != nil {
					return nil, e
				}
				peer = ftPick(peer, "type", "object")
			case "addresses":
				if len(ftList(peer["addresses"])) == 0 {
					return nil, ftBad("peer.addresses: Add at least one address")
				}
				peer = ftPick(peer, "type", "addresses")
			default:
				return nil, ftBad("peer.type: invalid discriminator")
			}
			if ids[ftStr(rule["id"])] {
				return nil, ftBad("rules: Each rule needs its own id")
			}
			ids[ftStr(rule["id"])] = true
			clean := ftPick(rule, ftRuleKeys...)
			clean["peer"] = peer
			kept = append(kept, clean)
		}
		v["rules"] = kept
	}
	return v, nil
}

func (f *fakeTRPC) fwList(map[string]any) (any, *fakeTRPCError) {
	ids := make([]string, 0, len(f.firewalls))
	for id := range f.firewalls {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := []any{}
	for _, id := range ids {
		row := ftCopy(f.firewalls[id])
		targets := []any{}
		keys := make([]string, 0)
		for k, fw := range f.attached {
			if fw == id {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		for _, k := range keys {
			typ, tid, _ := strings.Cut(k, ":")
			name := tid
			if typ == rnTargetPool {
				name = ftStr(f.pools[tid]["name"])
			} else {
				name = ftStr(f.nodes[tid]["name"])
			}
			targets = append(targets, map[string]any{"type": typ, "id": tid, "name": name, "machines": []any{}})
		}
		row["attachments"], row["targets"] = []any{}, targets
		row["filtersOutbound"], row["notes"] = true, map[string]any{"linux": []any{}, "macos": []any{}}
		out = append(out, row)
	}
	return out, nil
}

func (f *fakeTRPC) fwCreate(in map[string]any) (any, *fakeTRPCError) {
	v, e := ftFwValues(in, false)
	if e != nil {
		return nil, e
	}
	for _, fw := range f.firewalls {
		if fw["name"] == v["name"] {
			return nil, &fakeTRPCError{http.StatusConflict, "duplicate key value violates unique constraint firewall_org_name_unique"}
		}
	}
	id := f.newID("fw")
	v["firewallId"], v["organizationId"], v["revision"] = id, "org-1", float64(1)
	v["createdAt"], v["updatedAt"] = "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"
	f.firewalls[id] = v
	return ftCopy(v), nil
}

func (f *fakeTRPC) fwUpdate(in map[string]any) (any, *fakeTRPCError) {
	id := ftStr(in["firewallId"])
	row := f.firewalls[id]
	if row == nil {
		return nil, ftNotFound("Firewall")
	}
	if rev, ok := in["revision"]; ok && rev != row["revision"] {
		return nil, &fakeTRPCError{http.StatusConflict, "Firewall changed since it was opened"}
	}
	v, e := ftFwValues(in, true)
	if e != nil {
		return nil, e
	}
	for k, x := range v {
		row[k] = x
	}
	row["revision"] = row["revision"].(float64) + 1
	return ftCopy(row), nil
}

func (f *fakeTRPC) fwRemove(in map[string]any) (any, *fakeTRPCError) {
	id := ftStr(in["firewallId"])
	if f.firewalls[id] == nil {
		return nil, ftNotFound("Firewall")
	}
	delete(f.firewalls, id)
	for k, fw := range f.attached {
		if fw == id {
			delete(f.attached, k)
		}
	}
	return map[string]any{"ok": true}, nil
}

func (f *fakeTRPC) fwTarget(in map[string]any) (string, *fakeTRPCError) {
	t := ftMap(in["target"])
	if e := ftEnum("target.type", t["type"], rnTargetPool, rnTargetNode); e != nil {
		return "", e
	}
	id := ftStr(t["id"])
	if (t["type"] == rnTargetPool && f.pools[id] == nil) || (t["type"] == rnTargetNode && f.nodes[id] == nil) {
		return "", ftNotFound("Runner resource")
	}
	return ftStr(t["type"]) + ":" + id, nil
}

func (f *fakeTRPC) fwAttach(in map[string]any) (any, *fakeTRPCError) {
	if f.firewalls[ftStr(in["firewallId"])] == nil {
		return nil, ftNotFound("Firewall")
	}
	key, e := f.fwTarget(in)
	if e != nil {
		return nil, e
	}
	f.attached[key] = ftStr(in["firewallId"]) // replaces the firewall it had
	return map[string]any{"ok": true}, nil
}

func (f *fakeTRPC) fwDetach(in map[string]any) (any, *fakeTRPCError) {
	key, e := f.fwTarget(in)
	if e != nil {
		return nil, e
	}
	delete(f.attached, key)
	return map[string]any{"ok": true}, nil
}
