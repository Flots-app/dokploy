import {
	authorizeObservabilityToken,
	generateExpectedDatabaseMetrics,
} from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";
import { bearerToken } from "@/server/utils/observability-http";

export default async function handler(
	request: NextApiRequest,
	response: NextApiResponse,
) {
	if (request.method !== "GET") {
		response.setHeader("Allow", "GET");
		return response.status(405).end();
	}
	const token = bearerToken(request);
	const settings = token
		? await authorizeObservabilityToken(token, "gateway")
		: null;
	if (!settings) return response.status(401).end();

	response.setHeader(
		"Content-Type",
		"text/plain; version=0.0.4; charset=utf-8",
	);
	response.setHeader("Cache-Control", "no-store");
	return response
		.status(200)
		.send(await generateExpectedDatabaseMetrics(settings.organizationId));
}
