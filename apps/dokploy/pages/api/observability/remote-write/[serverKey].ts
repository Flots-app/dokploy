import {
	authorizeRemoteWrite,
	getObservabilityPrometheusUrl,
} from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";
import {
	bearerToken,
	firstHeader,
	readRequestBody,
	sendUpstreamResponse,
	toFetchBody,
} from "@/server/utils/observability-http";

export const config = { api: { bodyParser: false } };

export default async function handler(
	request: NextApiRequest,
	response: NextApiResponse,
) {
	if (request.method !== "POST") {
		response.setHeader("Allow", "POST");
		return response.status(405).end();
	}
	const serverKey =
		typeof request.query.serverKey === "string"
			? request.query.serverKey
			: null;
	const token = bearerToken(request);
	if (!serverKey || !token) return response.status(401).end();
	const agent = await authorizeRemoteWrite({ serverKey, token });
	if (!agent) return response.status(401).end();

	try {
		const body = await readRequestBody(request, 32 * 1024 * 1024);
		const upstream = await fetch(
			`${getObservabilityPrometheusUrl(agent.organizationId)}/api/v1/write`,
			{
				method: "POST",
				headers: {
					"Content-Type":
						firstHeader(request.headers["content-type"]) ??
						"application/x-protobuf",
					...(request.headers["content-encoding"] && {
						"Content-Encoding":
							firstHeader(request.headers["content-encoding"]) ?? "",
					}),
					...(request.headers["x-prometheus-remote-write-version"] && {
						"X-Prometheus-Remote-Write-Version":
							firstHeader(
								request.headers["x-prometheus-remote-write-version"],
							) ?? "",
					}),
				},
				body: toFetchBody(body),
				signal: AbortSignal.timeout(30_000),
			},
		);
		return sendUpstreamResponse(upstream, response);
	} catch (error) {
		return response.status(502).json({
			message:
				error instanceof Error ? error.message : "Remote Write proxy failed",
		});
	}
}
