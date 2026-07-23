import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	let deleteResult: unknown;
	const updateWhere = vi.fn(async () => undefined);
	const set = vi.fn(() => ({ where: updateWhere }));
	const update = vi.fn(() => ({ set }));
	const returning = vi.fn(async () => [deleteResult]);
	const deleteWhere = vi.fn(() => ({ returning }));
	const deleteRow = vi.fn(() => ({ where: deleteWhere }));
	const transaction = vi.fn(
		async (callback: (tx: unknown) => Promise<unknown>) =>
			await callback({ update, delete: deleteRow }),
	);
	const execAsync = vi.fn(async () => ({ stdout: "", stderr: "" }));

	return {
		deleteRow,
		deleteWhere,
		execAsync,
		returning,
		set,
		setDeleteResult(value: unknown) {
			deleteResult = value;
		},
		transaction,
		update,
		updateWhere,
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

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: mocks.execAsync,
	execAsyncRemote: vi.fn(),
}));

import { removeRegistry } from "@dokploy/server/services/registry";
import { deleteServer } from "@dokploy/server/services/server";

describe("Compose Build Server resource deletion", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("clears both Compose selections in the same transaction before deleting a Build Server", async () => {
		const deletedServer = { serverId: "build-1" };
		mocks.setDeleteResult(deletedServer);

		await expect(deleteServer("build-1")).resolves.toEqual(deletedServer);

		expect(mocks.transaction).toHaveBeenCalledOnce();
		expect(mocks.set).toHaveBeenCalledWith({
			buildServerId: null,
			buildRegistryId: null,
		});
		expect(mocks.updateWhere).toHaveBeenCalledOnce();
		expect(mocks.deleteWhere).toHaveBeenCalledOnce();
		expect(mocks.updateWhere.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.deleteWhere.mock.invocationCallOrder[0]!,
		);
	});

	it("clears both Compose selections in the same transaction before deleting a registry", async () => {
		const deletedRegistry = {
			registryId: "registry-1",
			registryUrl: "registry.example.com",
		};
		mocks.setDeleteResult(deletedRegistry);

		await expect(removeRegistry("registry-1")).resolves.toEqual(
			deletedRegistry,
		);

		expect(mocks.transaction).toHaveBeenCalledOnce();
		expect(mocks.set).toHaveBeenCalledWith({
			buildServerId: null,
			buildRegistryId: null,
		});
		expect(mocks.updateWhere).toHaveBeenCalledOnce();
		expect(mocks.deleteWhere).toHaveBeenCalledOnce();
		expect(mocks.updateWhere.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.deleteWhere.mock.invocationCallOrder[0]!,
		);
	});
});
