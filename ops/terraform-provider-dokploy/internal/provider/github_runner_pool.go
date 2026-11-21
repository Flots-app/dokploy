package provider

import (
	"context"
	"fmt"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

// The failover, job guard and rollout policy of a pool are objects in the API
// (with defaults that depend on the key that is left out); the schema exposes
// them as scalar attributes and these groups fold them back.
var rnPoolGroups = []rnGroup{
	{
		Key:    "failover",
		Fields: map[string]string{"failoverMode": "mode", "failoverInterruptions": "interruptions", "failoverWindowMinutes": "windowMinutes", "failoverCooldownMinutes": "cooldownMinutes"},
		Defaults: func() map[string]any {
			return map[string]any{"interruptions": 2, "windowMinutes": 10, "cooldownMinutes": 30, "mode": "auto"}
		},
	},
	{
		Key:    "jobGuard",
		Fields: map[string]string{"jobGuardRepositories": "repositories", "jobGuardEvents": "events", "jobGuardRefuseForks": "refuseForks", "jobGuardRefuseDependabot": "refuseDependabot"},
		Defaults: func() map[string]any {
			return map[string]any{"repositories": []any{}, "events": []any{}, "refuseForks": true, "refuseDependabot": true}
		},
	},
	{
		Key:    "rolloutPolicy",
		Fields: map[string]string{"rolloutMaxUnavailable": "maxUnavailable", "rolloutCanary": "canary"},
		Defaults: func() map[string]any {
			return map[string]any{"maxUnavailable": 1, "canary": true}
		},
	},
}

func init() {
	s := &Spec{
		Name: "github_runner_pool",
		Desc: "A pool of GitHub self-hosted runners (Flots fork of Dokploy): the GitHub target the runners register to, how jobs are routed to the pool or to a fallback, how its machines are updated. " +
			"Machines are separate objects (dokploy_github_runner_node). Credentials are write-only: Dokploy keeps them, Terraform never stores them. " +
			"Runtime state (routing, rollouts, usage, reroutes) is not part of the resource.",
		IDKey:          "githubRunnerPoolId",
		ImportHint:     "Import with the githubRunnerPoolId.",
		SecretsVersion: true,
		Fields: []Field{
			{Name: "name", Kind: String, Required: true, Desc: "Name of the pool, unique in the organization."},
			{Name: "description", Kind: String, FromAPI: rnStrFrom, ToAPI: rnStrTo, Desc: "Free text. Empty for none."},
			{Name: "scope", Kind: String, Required: true, OneOf: []string{"organization", "repository"}, Desc: "GitHub target of the runners: an organization, or one repository."},
			{Name: "owner", Kind: String, Required: true, Desc: "GitHub organization or user that owns the target. Cannot change while the pool has machines."},
			{Name: "repository", Kind: String, FromAPI: rnStrFrom, ToAPI: rnStrTo, Desc: "Repository name (without owner) for scope = repository; empty for an organization pool."},
			{Name: "runner_group", Kind: String, Desc: "Runner group of an organization pool (Default unless set); repository runners always use the default group."},
			{Name: "labels", Kind: StringList, Desc: "Labels of the runners (self-hosted and the architecture are added by GitHub). They identify the pool in runs-on."},
			{Name: "api_url", Kind: String, Desc: "GitHub API URL (https://api.github.com, or a GitHub Enterprise Server API). A GitHub provider only works with api.github.com."},
			{Name: "auth_type", Kind: String, Required: true, OneOf: []string{"token", "app", "provider"}, Desc: "How the pool signs GitHub requests: token (personal or fine-grained access token), app (GitHub App of its own) or provider (a GitHub provider of Dokploy)."},
			{Name: "token_wo", API: "token", Kind: String, WriteOnly: true, Desc: "Access token for auth_type = token."},
			{Name: "app_id", Kind: Int, Desc: "GitHub App id for auth_type = app."},
			{Name: "app_installation_id", Kind: String, FromAPI: rnStrFrom, ToAPI: rnStrTo, Desc: "Installation id of the GitHub App; looked up by Dokploy when empty."},
			{Name: "app_private_key_wo", API: "appPrivateKey", Kind: String, WriteOnly: true, Desc: "Private key (PEM) of the GitHub App for auth_type = app."},
			{Name: "github_id", Kind: String, FromAPI: rnStrFrom, ToAPI: rnStrTo, Desc: "Id of the Dokploy GitHub provider for auth_type = provider."},
			{Name: "runner_version", Kind: String, FromAPI: rnStrFrom, ToAPI: rnStrTo, Desc: "Pinned actions/runner release such as 2.329.0; empty follows the latest release."},
			{Name: "runner_env_wo", API: "runnerEnv", Kind: String, WriteOnly: true, Desc: "KEY=VALUE lines added to the environment of every job. Treated as a secret as a whole: Dokploy returns only the names (runner_env_keys), so the text is replaced whenever it is sent."},
			{Name: "runner_env_keys", Kind: StringSet, ReadOnly: true, Volatile: true, Desc: "Names of the variables of the runner environment."},
			{Name: "job_started_hook", Kind: String, FromAPI: rnStrFrom, ToAPI: rnStrTo, Desc: "Absolute path of a script run on the machine before each job; empty for none."},
			{Name: "job_completed_hook", Kind: String, FromAPI: rnStrFrom, ToAPI: rnStrTo, Desc: "Absolute path of a script run on the machine after each job; empty for none."},
			{Name: "job_guard_repositories", Kind: StringSet, Desc: "Job guard: owner/name of the repositories the jobs may come from; empty accepts any the runner group admits."},
			{Name: "job_guard_events", Kind: StringSet, Desc: "Job guard: GitHub events that may trigger the jobs (push, pull_request...); empty accepts any."},
			{Name: "job_guard_refuse_forks", Kind: Bool, Desc: "Job guard: refuse pull requests whose head is in another repository."},
			{Name: "job_guard_refuse_dependabot", Kind: Bool, Desc: "Job guard: refuse the jobs Dependabot triggered."},
			{Name: "rerun_interrupted_jobs", Kind: Bool, Desc: "Re-run, on the other machines, the jobs a crashed or stopped machine interrupted."},
			{Name: "routing_variable", Kind: String, FromAPI: rnStrFrom, ToAPI: rnStrTo, Desc: "Name of the GitHub Actions variable holding the runs-on of the pool while at least one runner is on, and the fallback otherwise; empty disables routing."},
			{Name: "fallback_labels", Kind: StringList, Desc: "runs-on published in the routing variable when the pool cannot take jobs."},
			{Name: "x64_fallback_labels", Kind: StringList, Desc: "Same as fallback_labels for the jobs that need x86_64 (variable suffixed with _X64)."},
			{Name: "failover_mode", Kind: String, OneOf: []string{"auto", "pool", "fallback"}, Desc: "Failover: auto lets health decide, pool and fallback force the routing."},
			{Name: "failover_interruptions", Kind: Int, Desc: "Failover: jobs a machine may lose within the window before it is set aside; 0 turns failover off."},
			{Name: "failover_window_minutes", Kind: Int, Desc: "Failover: the window in which interruptions are counted."},
			{Name: "failover_cooldown_minutes", Kind: Int, Desc: "Failover: how long a machine stays aside after its last loss."},
			{Name: "fallback_chain", Kind: JSON, Desc: "JSON array of the providers jobs go to while the machines cannot take them, in order (max 4): objects with id, kind (blacksmith or github), labels, x64Labels, budget (null or {freeMinutes, pricePerMinute, overspend, warningPercent}) and optionally classLabels. Write every key, as jsonencode() does: the value is compared as stored."},
			{Name: "job_classes", Kind: JSON, Desc: "JSON array of job classes with a routing variable of their own (max 8): objects with id, suffix, arch (native or x64) and fallbackLabels."},
			{Name: "blacksmith_organization", Kind: String, FromAPI: rnStrFrom, ToAPI: rnStrTo, Desc: "Blacksmith organization slug whose usage is read for the fallback budget."},
			{Name: "blacksmith_token_wo", API: "blacksmithToken", Kind: String, WriteOnly: true, Desc: "Token reading the Blacksmith usage."},
			{Name: "billing_token_wo", API: "billingToken", Kind: String, WriteOnly: true, Desc: "Token reading the GitHub billing usage; Dokploy uses the pool's own credentials when it was never set."},
			{Name: "placement", Kind: String, OneOf: []string{"fastest", "spread"}, Desc: "fastest keeps runners waiting only where a new job runs fastest; spread arms every free slot."},
			{Name: "update_policy", Kind: JSON, Desc: "JSON object {auto, window, osPatches?} of the runner and runtime updates; window is null (any time) or {days, start, end, timeZone}. Each machine may override it."},
			{Name: "rollout_max_unavailable", Kind: Int, Desc: "Rollout: machines of the pool updated at the same time."},
			{Name: "rollout_canary", Kind: Bool, Desc: "Rollout: the first machine updated to a new release must stay healthy before the others follow."},
			{Name: "autonomy_reserve", Kind: Int, Desc: "Runner registrations each slot keeps in reserve to arm itself while no controller answers; 0 turns it off."},
			{Name: "has_token", Kind: Bool, ReadOnly: true, Volatile: true, Desc: "Whether Dokploy holds an access token for the pool."},
			{Name: "has_app_private_key", Kind: Bool, ReadOnly: true, Volatile: true, Desc: "Whether Dokploy holds a GitHub App private key for the pool."},
			{Name: "has_blacksmith_token", Kind: Bool, ReadOnly: true, Volatile: true, Desc: "Whether Dokploy holds a Blacksmith token for the pool."},
			{Name: "has_billing_token", Kind: Bool, ReadOnly: true, Volatile: true, Desc: "Whether Dokploy holds a billing token for the pool."},
			{Name: "latest_runner_version", Kind: String, ReadOnly: true, Volatile: true, Desc: "Latest actions/runner release the controller knows."},
			{Name: "created_at", Kind: String, ReadOnly: true, Desc: "Creation date."},
		},
	}
	s.Read = func(ctx context.Context, c *client.Client, id string) (map[string]any, error) {
		pools, err := rnPoolList(ctx, c)
		if err != nil {
			return nil, err
		}
		p, err := rnFind(pools, "githubRunnerPoolId", id)
		if err != nil {
			return nil, err
		}
		return rnFlatten(p, rnPoolGroups), nil
	}
	s.Create = func(ctx context.Context, c *client.Client, in Input) (string, error) {
		body := rnNest(in.Body, nil, rnPoolGroups)
		if err := rnPoolCredentials(body); err != nil {
			return "", err
		}
		var out map[string]any
		if err := c.TRPCMutate(ctx, "githubRunner.createPool", body, &out); err != nil {
			return "", err
		}
		id := asString(out["githubRunnerPoolId"])
		if id == "" {
			return "", fmt.Errorf("the API answer carries no githubRunnerPoolId")
		}
		return id, nil
	}
	s.Update = func(ctx context.Context, c *client.Client, in Input) error {
		// The procedure takes the whole pool: a key left out goes back to its
		// default. The plan is complete (every attribute is Optional+Computed),
		// the secrets left out of the configuration keep their stored value.
		body := rnNest(in.Body, in.Remote, rnPoolGroups)
		return c.TRPCMutate(ctx, "githubRunner.updatePool", body, nil)
	}
	s.Delete = func(ctx context.Context, c *client.Client, id string) error {
		return c.TRPCMutate(ctx, "githubRunner.removePool", map[string]any{"githubRunnerPoolId": id}, nil)
	}
	register(s)
}

// rnPoolCredentials fails early, with the attribute names, when the credentials
// of the chosen authentication method are missing.
func rnPoolCredentials(body map[string]any) error {
	_, hasToken := body["token"]
	_, hasKey := body["appPrivateKey"]
	switch body["authType"] {
	case "token":
		if !hasToken {
			return fmt.Errorf("token_wo is required for auth_type = token")
		}
	case "app":
		if _, hasID := body["appId"]; !hasID || !hasKey {
			return fmt.Errorf("app_id and app_private_key_wo are required for auth_type = app")
		}
	case "provider":
		if body["githubId"] == nil {
			return fmt.Errorf("github_id is required for auth_type = provider")
		}
	}
	return nil
}
