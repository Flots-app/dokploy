/** GitHub pages that guide the pool setup, with everything Dokploy needs pre-filled. */

type Scope = "organization" | "repository";

/** Web URL of the GitHub instance behind an API URL (github.com or Enterprise Server). */
export const githubWebUrl = (apiUrl: string | undefined) => {
	const api = (apiUrl || "https://api.github.com").replace(/\/+$/, "");
	return api === "https://api.github.com"
		? "https://github.com"
		: api.replace(/\/api\/v3$/, "");
};

/**
 * Runner registration, Actions to re-run the jobs a crash interrupted or move
 * stuck ones to the fallback, and Variables to publish where jobs go.
 */
const permissions = (scope: Scope): Record<string, string> =>
	scope === "organization"
		? {
				organization_self_hosted_runners: "write",
				organization_actions_variables: "write",
				actions: "write",
			}
		: { administration: "write", actions_variables: "write", actions: "write" };

const DESCRIPTION =
	"Lets Dokploy register self-hosted runners, re-run interrupted jobs and send jobs to GitHub-hosted runners when no machine is on.";

/** Fine-grained token creation page, pre-filled (GitHub token templates). */
export const tokenTemplateUrl = (web: string, scope: Scope, owner: string) =>
	`${web}/settings/personal-access-tokens/new?${new URLSearchParams({
		name: `Dokploy runners ${owner}`.slice(0, 40),
		description: DESCRIPTION,
		target_name: owner,
		expires_in: "366",
		...permissions(scope),
	})}`;

/**
 * GitHub App registration, pre-filled. A private App can only be installed on
 * the account that owns it: the organization, or the user for a personal
 * repository.
 */
export const appRegistrationUrl = (
	web: string,
	scope: Scope,
	owner: string,
	homepage: string,
	account: "organization" | "user" = "organization",
) =>
	`${web}${account === "organization" ? `/organizations/${encodeURIComponent(owner)}` : ""}/settings/apps/new?${new URLSearchParams(
		{
			// GitHub App names are unique on GitHub and 34 characters at most.
			name: `Dokploy runners ${owner}`.slice(0, 34),
			description: DESCRIPTION,
			url: homepage,
			public: "false",
			webhook_active: "false",
			...permissions(scope),
		},
	)}`;

export const tokenRequestsUrl = (web: string, owner: string) =>
	`${web}/organizations/${encodeURIComponent(owner)}/settings/personal-access-token-requests`;

export const runnerGroupsUrl = (web: string, owner: string) =>
	`${web}/organizations/${encodeURIComponent(owner)}/settings/actions/runner-groups`;

export const runnerGroupUrl = (web: string, owner: string, groupId: number) =>
	`${runnerGroupsUrl(web, owner)}/${groupId}`;

/**
 * What people paste in the owner field: "Flots-app", "Flots-app/monorepo" or a
 * GitHub URL of either.
 */
export const parseGithubTarget = (value: string) => {
	const path = value
		.trim()
		.replace(/^https?:\/\/[^/]+\//, "")
		.replace(/^orgs\//, "")
		.replace(/\.git$/, "")
		.replace(/\/+$/, "");
	const [owner = "", repository = ""] = path.split("/");
	return { owner, repository: repository || null };
};

/** A label workflows can use, derived from the pool name: "Flots CI" → "flots-ci". */
export const labelFromName = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
