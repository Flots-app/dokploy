import {
	type AlertmanagerWebhook,
	authorizeObservabilityToken,
	processAlertmanagerWebhook,
} from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";
import {
	bearerToken,
	readRequestBody,
} from "@/server/utils/observability-http";

export const config = { api: { bodyParser: false } };

const webhookSchema = z.object({
	status: z.enum(["firing", "resolved"]),
	alerts: z.array(
		z.object({
			status: z.enum(["firing", "resolved"]),
			labels: z.record(z.string(), z.string()),
			annotations: z.record(z.string(), z.string()).optional(),
			startsAt: z.string().datetime({ offset: true }),
			endsAt: z.string().datetime({ offset: true }).optional(),
			fingerprint: z.string().min(1),
		}),
	),
});

export default async function handler(
	request: NextApiRequest,
	response: NextApiResponse,
) {
	if (request.method !== "POST") {
		response.setHeader("Allow", "POST");
		return response.status(405).end();
	}
	const token = bearerToken(request);
	const settings = token
		? await authorizeObservabilityToken(token, "alertmanager")
		: null;
	if (!settings) return response.status(401).end();

	try {
		const body = await readRequestBody(request, 2 * 1024 * 1024);
		const webhook = webhookSchema.parse(
			JSON.parse(body.toString("utf8")),
		) as AlertmanagerWebhook;
		return response.status(200).json(
			await processAlertmanagerWebhook({
				organizationId: settings.organizationId,
				webhook,
			}),
		);
	} catch (error) {
		return response.status(400).json({
			message: error instanceof Error ? error.message : "Invalid webhook",
		});
	}
}
