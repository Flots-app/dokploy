import migrateTestDatabase from "../db/global-setup";

/**
 * These tests create accounts, change sshd, sudoers, the firewall and Docker
 * on the machine they run on: only on a GitHub-hosted runner, thrown away after
 * the job, and only when the workflow says so.
 */
export default async function setup() {
	if (
		process.env.GITHUB_ACTIONS !== "true" ||
		process.env.DOKPLOY_E2E_MACHINE !== "throwaway"
	) {
		throw new Error(
			"The machine tests change this computer: they only run on a throwaway GitHub Actions runner (DOKPLOY_E2E_MACHINE=throwaway)",
		);
	}
	// The Linux machine is driven through Dokploy's services, on PostgreSQL.
	if (process.env.DATABASE_URL) await migrateTestDatabase();
}
