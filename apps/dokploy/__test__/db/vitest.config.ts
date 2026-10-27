import path from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

/**
 * Tests against a real PostgreSQL: the migrations, the constraints and the
 * services and routers that the unit tests can only run with a mocked DB.
 * DATABASE_URL must name a database ending in "_test" (see global-setup.ts).
 */
export default defineConfig({
	test: {
		root: path.resolve(__dirname, "../.."),
		include: ["__test__/db/**/*.db.test.ts"],
		globalSetup: [path.resolve(__dirname, "global-setup.ts")],
		pool: "forks",
		// One database for every file: no file sees another one's rows half-written.
		fileParallelism: false,
		testTimeout: 30_000,
		hookTimeout: 60_000,
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
