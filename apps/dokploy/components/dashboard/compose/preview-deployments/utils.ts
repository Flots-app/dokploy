export const COMPOSE_PREVIEW_DOCS_URL =
	"https://github.com/Flots-app/dokploy/blob/canary/ops/compose-preview/README.md";

/** Shared by the source page and the instance page so both link the same URL. */
export const previewDomainUrl = (domain: {
	https: boolean;
	host: string;
	path: string | null;
}) =>
	`${domain.https ? "https" : "http"}://${domain.host}${domain.path && domain.path !== "/" ? domain.path : ""}`;

/** Previews need a self-hosted GitHub Docker Compose source (see the router). */
export const supportsComposePreviews = (
	source?: { sourceType: string; composeType: string } | null,
	isCloud?: boolean,
) =>
	!!source &&
	!isCloud &&
	source.sourceType === "github" &&
	source.composeType === "docker-compose";

/** `2026-11-20 20:00 UTC`: same output on the server and in every browser. */
export const formatUtc = (iso: string) =>
	`${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** States in which an environment is moving: the list polls faster then. */
export const isPreviewBusy = (status: string) =>
	status === "pending" || status === "deploying" || status === "removing";

/** A failed allocation that retries on its own: the server reports it as an
 * error so it keeps being retried, but it is a queue, not a failure. */
export const isWaitingForCapacity = (preview: {
	status: string;
	error: string | null;
}) =>
	preview.status === "error" &&
	!!preview.error?.startsWith("Waiting for capacity");
