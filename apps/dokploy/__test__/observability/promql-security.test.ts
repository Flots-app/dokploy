import {
	assertPrometheusReadEndpoint,
	assertPromQlServiceScope,
} from "@dokploy/server/observability/promql";
import { describe, expect, it } from "vitest";

describe("PromQL database isolation", () => {
	it("accepts one exact service matcher on every selector", () => {
		expect(() =>
			assertPromQlServiceScope(
				'sum(rate(redis_commands_total{service_id="redis-1",cmd="get"}[5m])) / clamp_min(sum(rate(redis_commands_total{service_id="redis-1",cmd="set"}[5m])), 1)',
				"redis-1",
			),
		).not.toThrow();
	});

	it.each([
		'redis_up{service_id="redis-2"}',
		'redis_up{service_id=~"redis-.*"}',
		'redis_up{service_id!="redis-2"}',
		'redis_up{service_id!~"redis-2"}',
		'redis_up{job="redis"}',
		'redis_up{service_id="redis-1"} + redis_up{service_id="redis-2"}',
		'redis_up{service_id="redis-1"} + redis_connected_clients',
		'redis_up{service_id="redis-1",service_id="redis-1"}',
		"redis_up",
		"vector(1)",
		'redis_up{service_id="redis-1"',
	])("rejects cross-service or unscoped expression: %s", (query) => {
		expect(() => assertPromQlServiceScope(query, "redis-1")).toThrow();
	});

	it("accepts aggregation grouping labels without treating them as metrics", () => {
		expect(() =>
			assertPromQlServiceScope(
				'sum by (cmd) (rate(redis_commands_total{service_id="redis-1"}[5m]))',
				"redis-1",
			),
		).not.toThrow();
	});

	it("ignores braces inside string literals but still requires a selector", () => {
		expect(() =>
			assertPromQlServiceScope(
				'label_replace(redis_up{service_id="redis-1"}, "x", "{safe}", "y", "(.*)")',
				"redis-1",
			),
		).not.toThrow();
	});

	it("rejects oversized input", () => {
		expect(() =>
			assertPromQlServiceScope(
				`redis_up{service_id="redis-1"}${" ".repeat(20_001)}`,
				"redis-1",
			),
		).toThrow("Invalid PromQL");
	});
});

describe("Prometheus gateway endpoints", () => {
	it.each(["/api/v1/query", "/api/v1/query_range"])("allows %s", (pathname) => {
		expect(() => assertPrometheusReadEndpoint(pathname)).not.toThrow();
	});

	it.each([
		"/api/v1/labels",
		"/api/v1/series",
		"/api/v1/metadata",
		"/api/v1/status/config",
		"/api/v1/admin/tsdb/delete_series",
		"/-/reload",
	])("rejects administrative or discovery endpoint %s", (pathname) => {
		expect(() => assertPrometheusReadEndpoint(pathname)).toThrow("not allowed");
	});
});
