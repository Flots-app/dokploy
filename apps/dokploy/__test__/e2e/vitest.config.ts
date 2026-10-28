import path from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

/**
 * End-to-end tests that turn the machine they run on into a runner machine:
 * the real setup script with sudo, the runtime, the firewall, the uninstall.
 * Only for a throwaway GitHub Actions runner (see global-setup.ts).
 */
export default defineConfig({
	test: {
		root: path.resolve(__dirname, "../.."),
		include: ["__test__/e2e/**/*.e2e.test.ts"],
		globalSetup: [path.resolve(__dirname, "global-setup.ts")],
		pool: "forks",
		fileParallelism: false,
		// One machine: a step builds on the one before.
		sequence: { concurrent: false },
		testTimeout: 30 * 60_000,
		hookTimeout: 5 * 60_000,
	},
	plugins: [
		tsconfigPaths({
			projects: [path.resolve(__dirname, "../../tsconfig.json")],
		}),
	],
	resolve: {
		alias: {
			"@dokploy/server": path.resolve(
				__dirname,
				"../../../../packages/server/src",
			),
		},
	},
});
