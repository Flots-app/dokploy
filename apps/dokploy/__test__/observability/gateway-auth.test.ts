import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
	assertPrometheusReadEndpoint: vi.fn((pathname: string) => {
		if (!["/api/v1/query", "/api/v1/query_range"].includes(pathname)) {
			throw new Error("Prometheus endpoint is not allowed");
		}
	}),
	assertPromQlServiceScope: vi.fn(),
	authorizeObservabilityToken: vi.fn(),
	findDatabaseDeployment: vi.fn(),
	getObservabilityPrometheusUrl: vi.fn(
		() => "http://dokploy-observability-prometheus-org-1:9090",
	),
}));
const auth = vi.hoisted(() => ({ validateRequest: vi.fn() }));
const permission = vi.hoisted(() => ({ hasPermission: vi.fn() }));
const userFindFirst = vi.hoisted(() => vi.fn());
const memberFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@dokploy/server", () => server);
vi.mock("@dokploy/server/lib/auth", () => auth);
vi.mock("@dokploy/server/services/permission", () => permission);
vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			user: { findFirst: userFindFirst },
			member: { findFirst: memberFindFirst },
		},
	},
}));

import handler from "@/pages/api/observability/prometheus-gateway/[serviceId]/[[...path]]";

const request = ({
	headers = {},
	path = ["api", "v1", "query"],
}: {
	headers?: Record<string, string>;
	path?: string[];
} = {}) =>
	({
		method: "GET",
		headers,
		query: {
			serviceId: "postgres-1",
			path,
			query: 'pg_up{service_id="postgres-1"}',
		},
	}) as any;

const response = () => {
	const result = {
		statusCode: 0,
		body: undefined as unknown,
		headers: {} as Record<string, unknown>,
		status: vi.fn((code: number) => {
			result.statusCode = code;
			return result;
		}),
		setHeader: vi.fn((name: string, value: unknown) => {
			result.headers[name] = value;
		}),
		end: vi.fn(() => result),
		json: vi.fn((body: unknown) => {
			result.body = body;
			return result;
		}),
		send: vi.fn((body: unknown) => {
			result.body = body;
			return result;
		}),
	};
	return result;
};

describe("Prometheus gateway identity and endpoint security", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		auth.validateRequest.mockResolvedValue({ user: null, session: null });
		permission.hasPermission.mockResolvedValue(true);
		server.authorizeObservabilityToken.mockResolvedValue({
			organizationId: "org-1",
		});
		server.findDatabaseDeployment.mockResolvedValue({
			serviceId: "postgres-1",
			organizationId: "org-1",
		});
		userFindFirst.mockResolvedValue({ id: "user-1" });
		memberFindFirst.mockResolvedValue({
			role: "owner",
			accessedServices: [],
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response('{"status":"success"}')),
		);
	});

	it("ignores a forged Grafana identity header without the internal token", async () => {
		const res = response();
		await handler(
			request({ headers: { "x-grafana-user": "owner@example.com" } }),
			res as any,
		);
		expect(res.statusCode).toBe(401);
		expect(server.authorizeObservabilityToken).not.toHaveBeenCalled();
		expect(server.findDatabaseDeployment).not.toHaveBeenCalled();
	});

	it("requires the Grafana identity when the internal token is used", async () => {
		const res = response();
		await handler(
			request({
				headers: { "x-dokploy-observability-token": "gateway-token" },
			}),
			res as any,
		);
		expect(res.statusCode).toBe(401);
		expect(userFindFirst).not.toHaveBeenCalled();
	});

	it("rejects an authenticated Grafana user without service access", async () => {
		memberFindFirst.mockResolvedValue({
			role: "member",
			accessedServices: ["redis-2"],
		});
		const res = response();
		await handler(
			request({
				headers: {
					"x-dokploy-observability-token": "gateway-token",
					"x-grafana-user": "member@example.com",
				},
			}),
			res as any,
		);
		expect(res.statusCode).toBe(401);
		expect(server.findDatabaseDeployment).not.toHaveBeenCalled();
	});

	it("returns not found when the datasource service is in another organization", async () => {
		server.findDatabaseDeployment.mockResolvedValue({
			serviceId: "postgres-1",
			organizationId: "org-2",
		});
		const res = response();
		await handler(
			request({
				headers: {
					"x-dokploy-observability-token": "gateway-token",
					"x-grafana-user": "owner@example.com",
				},
			}),
			res as any,
		);
		expect(res.statusCode).toBe(404);
	});

	it("blocks administrative Prometheus endpoints before proxying", async () => {
		const res = response();
		await handler(
			request({
				headers: {
					"x-dokploy-observability-token": "gateway-token",
					"x-grafana-user": "owner@example.com",
				},
				path: ["api", "v1", "labels"],
			}),
			res as any,
		);
		expect(res.statusCode).toBe(403);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("executes only the validated POST query when URL and body are polluted", async () => {
		const scopedQuery = 'pg_up{service_id="postgres-1"}';
		const req = Object.assign(
			Readable.from([
				`query=${encodeURIComponent(scopedQuery)}&query=${encodeURIComponent("unscoped_metric")}`,
			]),
			request({
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"x-dokploy-observability-token": "gateway-token",
					"x-grafana-user": "owner@example.com",
				},
			}),
			{
				method: "POST",
				query: {
					serviceId: "postgres-1",
					path: ["api", "v1", "query"],
					query: "unscoped_metric",
				},
			},
		);
		const res = response();

		await handler(req as any, res as any);

		expect(server.assertPromQlServiceScope).toHaveBeenCalledWith(
			scopedQuery,
			"postgres-1",
		);
		const [upstreamUrl, init] = vi.mocked(fetch).mock.calls[0] ?? [];
		expect(String(upstreamUrl)).not.toContain("query=");
		const forwarded = new URLSearchParams(
			Buffer.from(init?.body as ArrayBuffer).toString("utf8"),
		);
		expect(forwarded.getAll("query")).toEqual([scopedQuery]);
	});
});
