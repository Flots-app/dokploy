import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	let findFirstResult: unknown;
	let returningResult: unknown;
	const findFirst = vi.fn(async () => findFirstResult);
	const insertValues = vi.fn(() => ({
		returning: vi.fn(async () => [returningResult]),
	}));
	const insert = vi.fn(() => ({ values: insertValues }));
	const updateReturning = vi.fn(async () => [returningResult]);
	const updateWhere = vi.fn(() => ({ returning: updateReturning }));
	const updateSet = vi.fn(() => ({ where: updateWhere }));
	const update = vi.fn(() => ({ set: updateSet }));
	const transaction = vi.fn(
		async (callback: (tx: unknown) => Promise<unknown>) =>
			await callback({
				insert,
				update,
				query: { server: { findFirst } },
			}),
	);

	return {
		findFirst,
		insertValues,
		setFindFirstResult(value: unknown) {
			findFirstResult = value;
		},
		setReturningResult(value: unknown) {
			returningResult = value;
		},
		transaction,
		updateSet,
	};
});

vi.mock("@dokploy/server/db", () => ({
	db: {
		transaction: mocks.transaction,
	},
}));

vi.mock("@dokploy/server/services/proprietary/license-key", () => ({
	hasValidLicense: vi.fn(),
}));

import {
	createServer,
	setDefaultBuildServer,
} from "@dokploy/server/services/server";

const buildServerInput = {
	name: "Builder",
	description: "",
	ipAddress: "10.0.0.2",
	port: 22,
	username: "root",
	sshKeyId: "ssh-1",
	serverType: "build" as const,
	enableDockerCleanup: true,
};

describe("Build Server organization default", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.setFindFirstResult(undefined);
		mocks.setReturningResult({ serverId: "build-1" });
	});

	it("makes the first SSH-capable Build Server the default", async () => {
		await createServer(buildServerInput, "org-1");

		expect(mocks.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				serverType: "build",
				isDefaultBuildServer: true,
			}),
		);
	});

	it("does not replace an existing default or make a Deploy Server default", async () => {
		mocks.setFindFirstResult({ serverId: "build-existing" });
		await createServer(buildServerInput, "org-1");
		expect(mocks.insertValues).toHaveBeenLastCalledWith(
			expect.objectContaining({ isDefaultBuildServer: false }),
		);

		await createServer({ ...buildServerInput, serverType: "deploy" }, "org-1");
		expect(mocks.insertValues).toHaveBeenLastCalledWith(
			expect.objectContaining({ isDefaultBuildServer: false }),
		);
	});

	it("atomically switches the default only to an active SSH Build Server", async () => {
		mocks.setFindFirstResult({
			serverId: "build-2",
			serverType: "build",
			serverStatus: "active",
			sshKeyId: "ssh-2",
		});
		mocks.setReturningResult({ serverId: "build-2" });

		await expect(setDefaultBuildServer("build-2", "org-1")).resolves.toEqual({
			serverId: "build-2",
		});
		expect(mocks.updateSet.mock.calls).toEqual([
			[{ isDefaultBuildServer: false }],
			[{ isDefaultBuildServer: true }],
		]);

		for (const invalid of [
			{ serverType: "deploy", serverStatus: "active", sshKeyId: "ssh-2" },
			{ serverType: "build", serverStatus: "inactive", sshKeyId: "ssh-2" },
			{ serverType: "build", serverStatus: "active", sshKeyId: null },
		]) {
			mocks.setFindFirstResult({ serverId: "invalid", ...invalid });
			await expect(setDefaultBuildServer("invalid", "org-1")).rejects.toThrow(
				/active, accessible by SSH/,
			);
		}
	});
});
