import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config.mjs";

describe("managed observability security headers", () => {
	it("allows Grafana to be framed only by Dokploy itself", async () => {
		const headers = nextConfig.headers;
		expect(headers).toBeTypeOf("function");
		if (!headers) throw new Error("Next.js headers are not configured");
		const headerRules = await headers();
		const grafanaRule = headerRules.find(
			(rule) => rule.source === "/api/observability/grafana/:path*",
		);

		expect(grafanaRule?.headers).toEqual(
			expect.arrayContaining([
				{ key: "X-Frame-Options", value: "SAMEORIGIN" },
				{
					key: "Content-Security-Policy",
					value: "frame-ancestors 'self'",
				},
			]),
		);
	});
});
