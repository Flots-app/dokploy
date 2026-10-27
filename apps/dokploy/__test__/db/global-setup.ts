import { readFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const migrationsFolder = path.resolve(__dirname, "../../drizzle");

/**
 * Applies the migrations (a no-op when CI already ran migration:run) and checks
 * every journal entry is recorded. The tests write and delete rows, so only a
 * database whose name ends in "_test" is accepted.
 */
export default async function setup() {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error("DATABASE_URL must point to a test database");
	const name = new URL(url).pathname.slice(1);
	if (!name.endsWith("_test")) {
		throw new Error(
			`Refusing to run the DB tests on "${name}": its name must end in _test`,
		);
	}
	const sql = postgres(url, { max: 1, onnotice: () => {} });
	try {
		await migrate(drizzle(sql), { migrationsFolder });
		const journal = JSON.parse(
			readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8"),
		) as { entries: unknown[] };
		const [applied] = await sql<{ count: number }[]>`
			select count(*)::int as count from drizzle.__drizzle_migrations`;
		if (applied?.count !== journal.entries.length) {
			throw new Error(
				`${applied?.count} migrations recorded, ${journal.entries.length} in the journal`,
			);
		}
	} finally {
		await sql.end();
	}
}
