/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */

/** @type {import("next").NextConfig} */
const nextConfig = {
	reactStrictMode: true,
	typescript: {
		ignoreBuildErrors: true,
	},
	transpilePackages: ["@dokploy/server"],
	async headers() {
		return [
			{
				// Apply security headers to all routes
				source: "/:path*",
				headers: [
					{
						key: "X-Frame-Options",
						value: "DENY",
					},
					{
						key: "Content-Security-Policy",
						value: "frame-ancestors 'none'",
					},
					{
						key: "X-Content-Type-Options",
						value: "nosniff",
					},
					{
						key: "Referrer-Policy",
						value: "strict-origin-when-cross-origin",
					},
				],
			},
			{
				// Grafana is embedded by Dokploy on the managed monitoring pages.
				// Keep framing same-origin only while overriding the global denial.
				source: "/api/observability/grafana/:path*",
				headers: [
					{
						key: "X-Frame-Options",
						value: "SAMEORIGIN",
					},
					{
						key: "Content-Security-Policy",
						value: "frame-ancestors 'self'",
					},
				],
			},
		];
	},
};

export default nextConfig;
