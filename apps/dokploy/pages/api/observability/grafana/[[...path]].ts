import { getObservabilityGrafanaUrl } from "@dokploy/server";
import { validateRequest } from "@dokploy/server/lib/auth";
import type { NextApiRequest, NextApiResponse } from "next";
import {
	readRequestBody,
	sendUpstreamResponse,
	toFetchBody,
} from "@/server/utils/observability-http";

export const config = { api: { bodyParser: false } };

export default async function handler(
	request: NextApiRequest,
	response: NextApiResponse,
) {
	const { user, session } = await validateRequest(request);
	if (!user || !session?.activeOrganizationId)
		return response.status(401).end();
	const grafanaUrl = getObservabilityGrafanaUrl(session.activeOrganizationId);

	const route = Array.isArray(request.query.path)
		? request.query.path.map(encodeURIComponent).join("/")
		: "";
	const upstreamUrl = new URL(
		`${grafanaUrl}/api/observability/grafana/${route}`,
	);
	for (const [key, value] of Object.entries(request.query)) {
		if (key === "path") continue;
		for (const item of Array.isArray(value) ? value : [value]) {
			if (item !== undefined) upstreamUrl.searchParams.append(key, item);
		}
	}

	try {
		const hasBody = !["GET", "HEAD"].includes(request.method ?? "GET");
		const body = hasBody
			? await readRequestBody(request, 16 * 1024 * 1024)
			: undefined;
		const upstream = await fetch(upstreamUrl, {
			method: request.method,
			headers: {
				Accept: request.headers.accept ?? "*/*",
				"Accept-Language": request.headers["accept-language"] ?? "en",
				"X-Grafana-User": user.email,
				"X-Dokploy-Organization-Id": session.activeOrganizationId,
				...(request.headers["content-type"] && {
					"Content-Type": request.headers["content-type"],
				}),
			},
			body: body ? toFetchBody(body) : undefined,
			redirect: "manual",
			signal: AbortSignal.timeout(30_000),
		});
		return sendUpstreamResponse(upstream, response, {
			rewriteLocation: (location) => {
				try {
					const parsed = new URL(location);
					return `${parsed.pathname}${parsed.search}${parsed.hash}`;
				} catch {
					return location.replace(grafanaUrl, "");
				}
			},
		});
	} catch (error) {
		return response.status(502).json({
			message: error instanceof Error ? error.message : "Grafana proxy failed",
		});
	}
}
