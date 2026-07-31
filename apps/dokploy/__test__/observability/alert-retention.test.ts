import { selectPurgeableDatabaseAlertEventIds } from "@dokploy/server/observability/service";
import { describe, expect, it } from "vitest";

type Transition = {
	databaseAlertEventId: string;
	organizationId: string;
	fingerprint: string;
	status: "pending" | "firing" | "resolved";
	startsAt: Date;
	createdAt: Date;
};

const transition = ({
	id,
	organizationId = "org-1",
	fingerprint = "fingerprint-1",
	status,
	startsAt = "2026-07-23T12:00:00.000Z",
	createdAt = startsAt,
}: {
	id: string;
	organizationId?: string;
	fingerprint?: string;
	status: Transition["status"];
	startsAt?: string;
	createdAt?: string;
}): Transition => ({
	databaseAlertEventId: id,
	organizationId,
	fingerprint,
	status,
	startsAt: new Date(startsAt),
	createdAt: new Date(createdAt),
});

describe("selectPurgeableDatabaseAlertEventIds", () => {
	it("retains old unresolved incidents while purging completed history", () => {
		const cutoff = new Date("2026-07-01T00:00:00.000Z");
		const resolvedCycle = "2026-06-01T00:00:00.000Z";
		const events = [
			transition({
				id: "old-unresolved",
				status: "firing",
				startsAt: "2026-05-01T00:00:00.000Z",
				createdAt: "2026-05-01T00:00:00.000Z",
			}),
			transition({
				id: "old-firing-resolved",
				status: "firing",
				startsAt: resolvedCycle,
				createdAt: resolvedCycle,
			}),
			transition({
				id: "old-resolution",
				status: "resolved",
				startsAt: resolvedCycle,
				createdAt: "2026-06-01T01:00:00.000Z",
			}),
			transition({
				id: "recent-resolution",
				status: "resolved",
				fingerprint: "recent",
				startsAt: "2026-07-10T00:00:00.000Z",
				createdAt: "2026-07-10T01:00:00.000Z",
			}),
		];

		expect(selectPurgeableDatabaseAlertEventIds(events, cutoff)).toEqual([
			"old-firing-resolved",
			"old-resolution",
		]);
	});
});
