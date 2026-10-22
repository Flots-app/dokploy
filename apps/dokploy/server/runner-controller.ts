/**
 * A GitHub runner controller of its own, for high availability: it runs next
 * to the Dokploy server, on the same database, and takes the lead within 20
 * seconds when the current leader stops. Run it from the Dokploy image, as a
 * second service with the same environment (DATABASE_URL or POSTGRES_*):
 *
 *   node dist/runner-controller.mjs
 */
import { startGithubRunnerController } from "@dokploy/server/utils/github-runners/controller";
import packageInfo from "../package.json";

const start = async () => {
	for (;;) {
		try {
			await startGithubRunnerController({
				kind: "standalone",
				version: packageInfo.version,
			});
			return;
		} catch (error) {
			// The database (or its migration by the Dokploy server) is not ready yet.
			console.error("Runner controller: retrying in 10 seconds", error);
			await new Promise((resolve) => setTimeout(resolve, 10_000));
		}
	}
};

void start();
