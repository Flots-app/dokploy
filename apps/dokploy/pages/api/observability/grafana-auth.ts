import { validateRequest } from "@dokploy/server/lib/auth";
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
	request: NextApiRequest,
	response: NextApiResponse,
) {
	const { user, session } = await validateRequest(request);
	if (!user || !session?.activeOrganizationId)
		return response.status(401).end();
	response.setHeader("X-Grafana-User", user.email);
	response.setHeader("X-Dokploy-Organization-Id", session.activeOrganizationId);
	return response.status(200).end();
}
