import { Github } from "lucide-react";
import type { ReactNode } from "react";
import type { RunnerPool } from "./format";
import { CopyCode } from "./shared";

/** The runs-on line that sends a workflow's jobs to the pool. */
export const WorkflowSnippet = ({ pool }: { pool: RunnerPool }) => (
	<div className="grid gap-1.5 text-xs text-muted-foreground">
		<span>
			Send a job to these machines from{" "}
			{pool.scope === "organization"
				? `any repository of ${pool.owner} allowed by its "${pool.runnerGroup}" runner group`
				: `${pool.owner}/${pool.repository}`}
			:
		</span>
		<CopyCode
			code={`runs-on: [${["self-hosted", ...pool.labels].join(", ")}]`}
		/>
		<span>
			Add <code>dokploy-&lt;machine&gt;</code> to the list to pin one machine.
			{pool.labels.length === 0 &&
				" The pool has no label: every self-hosted job can land on it."}
		</span>
	</div>
);

const Item = ({
	number,
	title,
	children,
}: {
	number: number;
	title: string;
	children: ReactNode;
}) => (
	<li className="flex gap-3 rounded-lg border p-4 text-left">
		<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
			{number}
		</span>
		<div className="space-y-1">
			<p className="text-sm font-medium">{title}</p>
			<p className="text-xs text-muted-foreground">{children}</p>
		</div>
	</li>
);

/** The page before the first pool: what the three steps are. */
export const GettingStarted = ({ action }: { action: ReactNode }) => (
	<div className="flex flex-col items-center gap-6 py-8 text-center">
		<Github className="size-8 text-muted-foreground" />
		<div className="space-y-1">
			<p className="font-medium">
				Run your GitHub Actions on your own machines
			</p>
			<p className="text-sm text-muted-foreground">
				About five minutes for an organization and its first machine.
			</p>
		</div>
		<ol className="grid w-full max-w-3xl gap-3 sm:grid-cols-3">
			<Item number={1} title="Create a pool">
				Connect a GitHub organization or repository. Dokploy pre-fills the token
				or App on GitHub for you.
			</Item>
			<Item number={2} title="Add machines">
				A Mac or a Linux machine reachable over SSH. Dokploy installs and sizes
				everything; you choose how much of it the jobs get.
			</Item>
			<Item number={3} title="Point workflows at it">
				Replace <code>runs-on: ubuntu-latest</code> with the line the pool gives
				you.
			</Item>
		</ol>
		{action}
	</div>
);
