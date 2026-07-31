import {
	assertPrometheusReadEndpoint,
	assertPromQlServiceScope,
	authorizeObservabilityToken,
	findDatabaseDeployment,
	getObservabilityPrometheusUrl,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { validateRequest } from "@dokploy/server/lib/auth";
import { hasPermission } from "@dokploy/server/services/permission";
import { and, eq } from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";
import { member, user as userTable } from "@/server/db/schema";
import {
	readRequestBody,
	sendUpstreamResponse,
	toFetchBody,
} from "@/server/utils/observability-http";

export const config = { api: { bodyParser: false } };

const authorizeRequest = async (request: NextApiRequest, serviceId: string) => {
	const internalToken = request.headers["x-dokploy-observability-token"];
	if (typeof internalToken === "string") {
		const settings = await authorizeObservabilityToken(
			internalToken,
			"gateway",
		);
		const grafanaIdentity = request.headers["x-grafana-user"];
		if (!settings || typeof grafanaIdentity !== "string") return null;
		const identity = await db.query.user.findFirst({
			where: eq(userTable.email, grafanaIdentity),
			columns: { id: true },
		});
		if (!identity) return null;
		const membership = await db.query.member.findFirst({
			where: and(
				eq(member.userId, identity.id),
				eq(member.organizationId, settings.organizationId),
			),
		});
		if (!membership) return null;
		if (
			membership.role !== "owner" &&
			membership.role !== "admin" &&
			!membership.accessedServices.includes(serviceId)
		) {
			return null;
		}
		const ctx = {
			user: { id: identity.id },
			session: { activeOrganizationId: settings.organizationId },
		};
		if (!(await hasPermission(ctx, { monitoring: ["read"] }))) return null;
		return { organizationId: settings.organizationId };
	}

	const { user, session } = await validateRequest(request);
	if (!user || !session?.activeOrganizationId) return null;
	const ctx = {
		user: { id: user.id },
		session: { activeOrganizationId: session.activeOrganizationId },
	};
	if (!(await hasPermission(ctx, { monitoring: ["read"] }))) return null;
	const membership = await db.query.member.findFirst({
		where: and(
			eq(member.userId, user.id),
			eq(member.organizationId, session.activeOrganizationId),
		),
	});
	if (
		!membership ||
		(membership.role !== "owner" &&
			membership.role !== "admin" &&
			!membership.accessedServices.includes(serviceId))
	) {
		return null;
	}
	return { organizationId: session.activeOrganizationId };
};

export default async function handler(
	request: NextApiRequest,
	response: NextApiResponse,
) {
	if (!["GET", "POST"].includes(request.method ?? "")) {
		response.setHeader("Allow", "GET, POST");
		return response.status(405).end();
	}
	const serviceId =
		typeof request.query.serviceId === "string"
			? request.query.serviceId
			: null;
	if (!serviceId) return response.status(404).end();
	const authorization = await authorizeRequest(request, serviceId);
	if (!authorization) return response.status(401).end();

	const database = await findDatabaseDeployment(serviceId);
	if (!database || database.organizationId !== authorization.organizationId) {
		return response.status(404).end();
	}

	const pathSegments = Array.isArray(request.query.path)
		? request.query.path
		: [];
	const pathname = `/${pathSegments.join("/")}`;
	try {
		assertPrometheusReadEndpoint(pathname);
		let body: Buffer | undefined;
		let query =
			typeof request.query.query === "string" ? request.query.query : null;
		if (request.method === "POST") {
			body = await readRequestBody(request, 2 * 1024 * 1024);
			const contentType = request.headers["content-type"] ?? "";
			if (contentType.includes("application/json")) {
				const parsed = JSON.parse(body.toString("utf8")) as {
					query?: unknown;
				};
				query = typeof parsed.query === "string" ? parsed.query : null;
				body = Buffer.from(JSON.stringify({ ...parsed, query }));
			} else {
				const form = new URLSearchParams(body.toString("utf8"));
				query = form.get("query") ?? query;
				if (query) form.set("query", query);
				body = Buffer.from(form.toString());
			}
		}
		if (!query) throw new Error("PromQL query is required");
		assertPromQlServiceScope(query, serviceId);

		const upstreamUrl = new URL(
			`${getObservabilityPrometheusUrl(authorization.organizationId)}${pathname}`,
		);
		for (const [key, value] of Object.entries(request.query)) {
			if (
				key === "path" ||
				key === "serviceId" ||
				(request.method === "POST" && key === "query")
			) {
				continue;
			}
			for (const item of Array.isArray(value) ? value : [value]) {
				if (item !== undefined) upstreamUrl.searchParams.append(key, item);
			}
		}
		const upstream = await fetch(upstreamUrl, {
			method: request.method,
			headers: {
				Accept: "application/json",
				...(request.headers["content-type"] && {
					"Content-Type": request.headers["content-type"],
				}),
			},
			body: body ? toFetchBody(body) : undefined,
			signal: AbortSignal.timeout(30_000),
		});
		return sendUpstreamResponse(upstream, response);
	} catch (error) {
		return response.status(403).json({
			status: "error",
			errorType: "forbidden",
			error: error instanceof Error ? error.message : "Query denied",
		});
	}
}
