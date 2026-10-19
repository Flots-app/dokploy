import { ExternalLink, Loader2, Upload } from "lucide-react";
import type { ReactNode } from "react";
import { type UseFormReturn, useWatch } from "react-hook-form";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, type RouterOutputs } from "@/utils/api";
import type { RunnerPool } from "./format";
import {
	appRegistrationUrl,
	githubWebUrl,
	runnerGroupsUrl,
	runnerGroupUrl,
	tokenRequestsUrl,
	tokenTemplateUrl,
} from "./github-links";
import type { PoolFormValues } from "./pool-form";

export type PoolAccess = RouterOutputs["githubRunner"]["testCredentials"];
type PoolForm = UseFormReturn<PoolFormValues>;
type RunnerGroup = PoolAccess["groups"][number];

/** A numbered step of the pool dialog. */
export const Step = ({
	number,
	title,
	description,
	children,
}: {
	number: number;
	title: string;
	description?: string;
	children: ReactNode;
}) => (
	<section className="grid gap-3">
		<div className="flex items-start gap-3">
			<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
				{number}
			</span>
			<div className="space-y-0.5">
				<h3 className="text-sm font-semibold leading-6">{title}</h3>
				{description && (
					<p className="text-xs text-muted-foreground">{description}</p>
				)}
			</div>
		</div>
		<div className="grid gap-4 sm:pl-9">{children}</div>
	</section>
);

const GithubButton = ({
	href,
	disabled,
	children,
}: {
	href: string;
	disabled: boolean;
	children: ReactNode;
}) =>
	disabled ? (
		<Button type="button" variant="outline" size="sm" disabled>
			{children}
			<ExternalLink className="size-3.5" />
		</Button>
	) : (
		<Button asChild variant="outline" size="sm">
			<a href={href} target="_blank" rel="noreferrer">
				{children}
				<ExternalLink className="size-3.5" />
			</a>
		</Button>
	);

const Link = ({ href, children }: { href: string; children: ReactNode }) => (
	<a
		href={href}
		target="_blank"
		rel="noreferrer"
		className="font-medium text-foreground underline underline-offset-4"
	>
		{children}
	</a>
);

const Steps = ({ children }: { children: ReactNode }) => (
	<ol className="grid list-decimal gap-2 pl-4 text-sm text-muted-foreground marker:text-foreground">
		{children}
	</ol>
);

interface GuideProps {
	form: PoolForm;
	pool?: RunnerPool;
	web: string;
	onCheck: () => void;
}

const useTarget = (form: PoolForm) => {
	const [scope, owner, repository] = useWatch({
		control: form.control,
		name: ["scope", "owner", "repository"],
	});
	return { scope, owner: owner.trim(), repository: repository?.trim() ?? "" };
};

const TokenGuide = ({ form, pool, web, onCheck }: GuideProps) => {
	const { scope, owner, repository } = useTarget(form);
	return (
		<>
			<Steps>
				<li>
					<span className="flex flex-wrap items-center gap-2">
						<GithubButton
							href={tokenTemplateUrl(web, scope, owner)}
							disabled={!owner}
						>
							Create the token on GitHub
						</GithubButton>
						{owner
							? "Its name, owner and permissions are already filled in."
							: "Enter the organization first."}
					</span>
				</li>
				<li>
					Under <strong>Repository access</strong>, choose{" "}
					{scope === "organization" ? (
						<>
							<strong>All repositories</strong> (to re-run the jobs a stopped
							machine interrupted, wherever they come from)
						</>
					) : (
						<>
							<strong>Only select repositories</strong> →{" "}
							<strong>{repository || "the repository"}</strong>
						</>
					)}
					, then <strong>Generate token</strong> and copy it.
				</li>
				{scope === "organization" && owner && (
					<li>
						If {owner} reviews token requests, approve it in its{" "}
						<Link href={tokenRequestsUrl(web, owner)}>pending requests</Link>.
					</li>
				)}
			</Steps>
			<FormField
				control={form.control}
				name="token"
				render={({ field }) => (
					<FormItem>
						<FormLabel>Token</FormLabel>
						<FormControl>
							<Input
								type="password"
								autoComplete="off"
								placeholder={pool?.hasToken ? "Unchanged" : "github_pat_…"}
								{...field}
								onBlur={() => {
									field.onBlur();
									if (field.value) onCheck();
								}}
							/>
						</FormControl>
						<FormDescription>
							It expires after a year: create a new one here before, or use a
							GitHub App, which never expires.
						</FormDescription>
						<FormMessage />
					</FormItem>
				)}
			/>
		</>
	);
};

const PrivateKeyField = ({
	form,
	pool,
}: {
	form: PoolForm;
	pool?: RunnerPool;
}) => (
	<FormField
		control={form.control}
		name="appPrivateKey"
		render={({ field }) => (
			<FormItem className="sm:col-span-2">
				<div className="flex items-center justify-between">
					<FormLabel>Private key</FormLabel>
					<Button type="button" variant="ghost" size="sm" asChild>
						<label className="cursor-pointer">
							<Upload className="size-3.5" />
							Load the .pem file
							<input
								type="file"
								accept=".pem"
								className="sr-only"
								onChange={async (event) => {
									const file = event.target.files?.[0];
									if (file) field.onChange((await file.text()).trim());
								}}
							/>
						</label>
					</Button>
				</div>
				<FormControl>
					<Textarea
						rows={3}
						className="font-mono text-xs"
						placeholder={
							pool?.hasAppPrivateKey
								? "Unchanged"
								: "-----BEGIN RSA PRIVATE KEY-----"
						}
						{...field}
					/>
				</FormControl>
				<FormMessage />
			</FormItem>
		)}
	/>
);

const AppGuide = ({ form, pool, web }: GuideProps) => {
	const { scope, owner, repository } = useTarget(form);
	const homepage =
		typeof window === "undefined"
			? "https://dokploy.com"
			: window.location.origin;
	return (
		<>
			<Steps>
				<li>
					<span className="flex flex-wrap items-center gap-2">
						<GithubButton
							href={appRegistrationUrl(web, scope, owner, homepage)}
							disabled={!owner}
						>
							Register the App on GitHub
						</GithubButton>
						{scope === "repository" && owner && (
							<Link
								href={appRegistrationUrl(web, scope, owner, homepage, "user")}
							>
								(personal repository)
							</Link>
						)}
					</span>
					<span className="mt-1 block">
						Permissions are filled in: click <strong>Create GitHub App</strong>{" "}
						(change the name if GitHub says it is taken).
					</span>
				</li>
				<li>
					Copy the <strong>App ID</strong> shown at the top of the App page.
				</li>
				<li>
					<strong>Generate a private key</strong> at the bottom of the page and
					load the downloaded file below.
				</li>
				<li>
					<strong>Install App</strong> (left menu) on{" "}
					{scope === "organization"
						? owner || "the organization"
						: `${owner}/${repository}`}
					. Dokploy finds the installation by itself.
				</li>
			</Steps>
			<div className="grid gap-4 sm:grid-cols-2">
				<FormField
					control={form.control}
					name="appId"
					render={({ field }) => (
						<FormItem>
							<FormLabel>App ID</FormLabel>
							<FormControl>
								<Input inputMode="numeric" placeholder="1234567" {...field} />
							</FormControl>
							<FormMessage />
						</FormItem>
					)}
				/>
				<PrivateKeyField form={form} pool={pool} />
			</div>
		</>
	);
};

const ProviderGuide = ({ form }: GuideProps) => {
	const { data: providers } = api.github.githubProviders.useQuery();
	return (
		<FormField
			control={form.control}
			name="githubId"
			render={({ field }) => (
				<FormItem>
					<FormLabel>GitHub provider</FormLabel>
					<Select value={field.value} onValueChange={field.onChange}>
						<FormControl>
							<SelectTrigger>
								<SelectValue placeholder="Select a provider" />
							</SelectTrigger>
						</FormControl>
						<SelectContent>
							{providers?.map((provider) => (
								<SelectItem key={provider.githubId} value={provider.githubId}>
									{provider.gitProvider.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<FormDescription>
						Its GitHub App needs two more permissions on GitHub: "Self-hosted
						runners: read and write" (organization) or "Administration: read and
						write" (repository), and "Actions: read and write".
					</FormDescription>
					<FormMessage />
				</FormItem>
			)}
		/>
	);
};

const GUIDES = {
	token: TokenGuide,
	app: AppGuide,
	provider: ProviderGuide,
} as const;

const plural = (count: number, word: string) =>
	`${count} ${word}${count === 1 ? "" : "s"}`;

const AccessSummary = ({
	access,
	target,
}: {
	access: PoolAccess;
	target: string;
}) => (
	<AlertBlock type="success">
		Dokploy can manage the runners of {target}.
		{access.runners !== null &&
			` ${plural(access.runners, "runner")} already registered there (${access.online} online).`}
		{access.tokenExpiresAt &&
			` The token expires on ${access.tokenExpiresAt.slice(0, 10)}.`}
		{access.installationId && " The App installation was found."}
	</AlertBlock>
);

/** Step 2: the credentials, with a guide that pre-fills everything on GitHub. */
export const AccessFields = ({
	form,
	pool,
	access,
	checking,
	checkError,
	onCheck,
	onReset,
}: {
	form: PoolForm;
	pool?: RunnerPool;
	access: PoolAccess | undefined;
	checking: boolean;
	checkError: string | null;
	onCheck: () => void;
	/** The last check no longer applies. */
	onReset: () => void;
}) => {
	const [authType, apiUrl] = useWatch({
		control: form.control,
		name: ["authType", "apiUrl"],
	});
	const { scope, owner, repository } = useTarget(form);
	const Guide = GUIDES[authType];
	return (
		<>
			<FormField
				control={form.control}
				name="authType"
				render={({ field }) => (
					<FormItem>
						<FormLabel>Access with</FormLabel>
						<Select
							value={field.value}
							onValueChange={(value) => {
								field.onChange(value);
								onReset();
							}}
						>
							<FormControl>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
							</FormControl>
							<SelectContent>
								<SelectItem value="token">
									A token (simplest, 1 minute)
								</SelectItem>
								<SelectItem value="app">
									A GitHub App (never expires, not tied to a person)
								</SelectItem>
								<SelectItem value="provider">
									A GitHub provider already in Dokploy
								</SelectItem>
							</SelectContent>
						</Select>
						<FormDescription>
							Stored encrypted in Dokploy; it never reaches the machines.
						</FormDescription>
					</FormItem>
				)}
			/>
			<Guide
				form={form}
				pool={pool}
				web={githubWebUrl(apiUrl)}
				onCheck={onCheck}
			/>
			<div className="flex flex-wrap items-center gap-3">
				<Button
					type="button"
					variant="secondary"
					size="sm"
					onClick={onCheck}
					disabled={checking}
				>
					{checking && <Loader2 className="size-4 animate-spin" />}
					Check access
				</Button>
				{!access && !checkError && (
					<span className="text-xs text-muted-foreground">
						Also done when you create the pool.
					</span>
				)}
			</div>
			{access && (
				<AccessSummary
					access={access}
					target={scope === "organization" ? owner : `${owner}/${repository}`}
				/>
			)}
			{checkError && <AlertBlock type="error">{checkError}</AlertBlock>}
		</>
	);
};

const GroupAccess = ({
	group,
	groups,
	owner,
	name,
	web,
}: {
	group: RunnerGroup | undefined;
	groups: RunnerGroup[];
	owner: string;
	name: string;
	web: string;
}) => {
	if (!groups.length) {
		return (
			<>
				Which repositories of {owner || "the organization"} may use the runners.
				Default suits most organizations; check access to list the groups.
			</>
		);
	}
	if (!group) {
		return (
			<span className="text-destructive">
				No group named "{name}" in {owner}: pick one, or{" "}
				<Link href={runnerGroupsUrl(web, owner)}>create it on GitHub</Link>.
			</span>
		);
	}
	const settings = (
		<Link href={runnerGroupUrl(web, owner, group.id)}>group settings</Link>
	);
	if (group.allowsPublicRepositories) {
		return (
			<span className="text-orange-600 dark:text-orange-500">
				Public repositories can use these runners too: anyone opening a pull
				request on them could run code on your machines. Restrict it in the{" "}
				{settings}.
			</span>
		);
	}
	return group.visibility === "all" ? (
		<>
			Every private and internal repository of {owner} can use these runners;
			public ones cannot ({settings}).
		</>
	) : (
		<>Only the repositories chosen in the {settings} can use these runners.</>
	);
};

/** Step 3 (organizations): the runner group, picked among the existing ones. */
export const RunnerGroupField = ({
	form,
	access,
}: {
	form: PoolForm;
	access: PoolAccess | undefined;
}) => {
	const [name, apiUrl] = useWatch({
		control: form.control,
		name: ["runnerGroup", "apiUrl"],
	});
	const { owner } = useTarget(form);
	const groups = access?.groups ?? [];
	const group = groups.find(
		(item) => item.name.toLowerCase() === (name ?? "").trim().toLowerCase(),
	);
	return (
		<FormField
			control={form.control}
			name="runnerGroup"
			render={({ field }) => (
				<FormItem>
					<FormLabel>Runner group</FormLabel>
					{groups.length ? (
						<Select value={group?.name ?? ""} onValueChange={field.onChange}>
							<FormControl>
								<SelectTrigger>
									<SelectValue placeholder="Select a group" />
								</SelectTrigger>
							</FormControl>
							<SelectContent>
								{groups.map((item) => (
									<SelectItem key={item.id} value={item.name}>
										{item.name}
										{item.default && item.name !== "Default"
											? " (default)"
											: ""}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					) : (
						<FormControl>
							<Input placeholder="Default" {...field} />
						</FormControl>
					)}
					<FormDescription>
						<GroupAccess
							group={group}
							groups={groups}
							owner={owner}
							name={name ?? ""}
							web={githubWebUrl(apiUrl)}
						/>
					</FormDescription>
					<FormMessage />
				</FormItem>
			)}
		/>
	);
};
