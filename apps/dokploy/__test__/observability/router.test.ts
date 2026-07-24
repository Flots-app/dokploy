import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
	createDatabaseAlertRule: vi.fn(),
	disableManagedObservability: vi.fn(),
	exportObservabilityArtifacts: vi.fn(),
	findDatabaseDeployment: vi.fn(),
	getActiveDatabaseAlerts: vi.fn(),
	getCurrentMetricValue: vi.fn(),
	getDatabaseAlertHistory: vi.fn(),
	getDatabaseAlertStates: vi.fn(),
	getMetricCatalog: vi.fn(),
	getObservabilityState: vi.fn(),
	hasValidLicense: vi.fn(),
	installManagedObservability: vi.fn(),
	listDatabaseAlertRules: vi.fn(),
	reconcileManagedObservability: vi.fn(),
	removeDatabaseAlertRule: vi.fn(),
	setDatabaseMonitoringEnabled: vi.fn(),
	updateDatabaseAlertRule: vi.fn(),
}));

const permissions = vi.hoisted(() => ({
	checkPermission: vi.fn(),
	checkServicePermissionAndAccess: vi.fn(),
	findMemberByUserId: vi.fn(),
}));

const databaseAlertRuleFindFirst = vi.hoisted(() => vi.fn());
const dbMock = vi.hoisted(() => ({
	query: {
		databaseAlertRules: {
			findFirst: databaseAlertRuleFindFirst,
		},
	},
}));

vi.mock("@dokploy/server", () => server);
vi.mock("@dokploy/server/services/permission", () => permissions);
vi.mock("@dokploy/server/db", () => ({ db: dbMock }));
vi.mock("@dokploy/server/lib/auth", () => ({ validateRequest: vi.fn() }));

import { observabilityRouter } from "@/server/api/routers/observability";

const context = (organizationId = "org-1") =>
	({
		user: {
			id: "user-1",
			email: "user@example.com",
			role: "owner",
			ownerId: "user-1",
			enableEnterpriseFeatures: false,
			isValidEnterpriseLicense: false,
		},
		session: {
			id: "session-1",
			userId: "user-1",
			activeOrganizationId: organizationId,
			expiresAt: new Date(Date.now() + 60_000),
			token: "session-token",
			createdAt: new Date(),
			updatedAt: new Date(),
			ipAddress: null,
			userAgent: null,
		},
		db: dbMock,
		req: {},
		res: {},
	}) as any;

const database = (organizationId = "org-1") => ({
	serviceId: "postgres-1",
	name: "Postgres",
	appName: "postgres-app",
	databaseType: "postgres" as const,
	organizationId,
	serverId: "local",
	projectId: "project-1",
	environmentId: "environment-1",
	databaseName: "postgres",
	databaseUser: "postgres",
	databasePassword: "secret",
	monitoringEnabled: true,
	applicationStatus: "done" as const,
});

const validRule = {
	serviceId: "postgres-1",
	metricKey: "postgres.up",
	operator: "eq" as const,
	threshold: 0,
	lookbackWindow: "1m",
	forDuration: "1m",
	severity: "critical" as const,
	name: "alert-postgres-availability-critical-eq-0",
	description: "Unavailable",
	notificationIds: [],
	enabled: true,
};

describe("observability router authorization", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		permissions.checkPermission.mockResolvedValue(undefined);
		permissions.checkServicePermissionAndAccess.mockResolvedValue(undefined);
		permissions.findMemberByUserId.mockResolvedValue({ role: "owner" });
		server.findDatabaseDeployment.mockResolvedValue(database());
		server.getMetricCatalog.mockReturnValue({ metrics: [], presets: [] });
		server.installManagedObservability.mockResolvedValue({
			skipped: false,
			errors: [],
		});
		server.createDatabaseAlertRule.mockResolvedValue({
			databaseAlertRuleId: "rule-1",
		});
		server.exportObservabilityArtifacts.mockResolvedValue({
			filename: "observability.zip",
			contentType: "application/zip",
			data: "archive",
		});
		server.getActiveDatabaseAlerts.mockResolvedValue([]);
		databaseAlertRuleFindFirst.mockResolvedValue(undefined);
	});

	it("allows an owner with monitoring.create to install the global stack", async () => {
		const caller = observabilityRouter.createCaller(context());
		await expect(
			caller.install({ publicUrl: "https://dokploy.example.com" }),
		).resolves.toEqual({ skipped: false, errors: [] });
		expect(permissions.checkPermission).toHaveBeenCalledWith(
			expect.anything(),
			{ monitoring: ["create"] },
		);
		expect(server.installManagedObservability).toHaveBeenCalledWith({
			organizationId: "org-1",
			publicUrl: "https://dokploy.example.com",
		});
	});

	it("rejects global installation for a member before provisioning", async () => {
		permissions.findMemberByUserId.mockResolvedValue({ role: "member" });
		const caller = observabilityRouter.createCaller(context());
		await expect(
			caller.install({ publicUrl: "https://dokploy.example.com" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(server.installManagedObservability).not.toHaveBeenCalled();
	});

	it("checks both monitoring.read and service access for the catalog", async () => {
		const caller = observabilityRouter.createCaller(context());
		await expect(caller.catalog({ serviceId: "postgres-1" })).resolves.toEqual({
			metrics: [],
			presets: [],
		});
		expect(permissions.checkPermission).toHaveBeenCalledWith(
			expect.anything(),
			{ monitoring: ["read"] },
		);
		expect(permissions.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"postgres-1",
			{
				monitoring: ["read"],
			},
		);
	});

	it("hides a database that belongs to another organization", async () => {
		server.findDatabaseDeployment.mockResolvedValue(database("org-2"));
		const caller = observabilityRouter.createCaller(context("org-1"));
		await expect(
			caller.catalog({ serviceId: "postgres-1" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(server.getMetricCatalog).not.toHaveBeenCalled();
	});

	it("does not create a rule when service mutation access is denied", async () => {
		permissions.checkServicePermissionAndAccess.mockRejectedValue(
			new TRPCError({ code: "FORBIDDEN" }),
		);
		const caller = observabilityRouter.createCaller(context());
		await expect(caller.createRule(validRule)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(server.createDatabaseAlertRule).not.toHaveBeenCalled();
	});

	it("does not reveal cross-organization alert rules", async () => {
		databaseAlertRuleFindFirst.mockResolvedValue(undefined);
		const caller = observabilityRouter.createCaller(context("org-1"));
		await expect(
			caller.updateRule({ ruleId: "org-2-rule", rule: validRule }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(server.updateDatabaseAlertRule).not.toHaveBeenCalled();
	});

	it("exports artifacts only after read access to the requested service", async () => {
		const caller = observabilityRouter.createCaller(context());
		await expect(
			caller.exportArtifacts({ serviceId: "postgres-1" }),
		).resolves.toMatchObject({ filename: "observability.zip" });
		expect(permissions.checkServicePermissionAndAccess).toHaveBeenCalledWith(
			expect.anything(),
			"postgres-1",
			{ monitoring: ["read"] },
		);
		expect(server.exportObservabilityArtifacts).toHaveBeenCalledWith(
			"org-1",
			"postgres-1",
		);
	});

	it("lists every organization alert for owners", async () => {
		const caller = observabilityRouter.createCaller(context());
		await expect(caller.activeAlerts()).resolves.toEqual([]);
		expect(server.getActiveDatabaseAlerts).toHaveBeenCalledWith({
			organizationId: "org-1",
			allowedServiceIds: undefined,
		});
	});

	it("limits the global alert view to a member's accessible services", async () => {
		permissions.findMemberByUserId.mockResolvedValue({
			role: "member",
			accessedServices: ["postgres-1", "redis-1"],
		});
		const caller = observabilityRouter.createCaller(context());
		await expect(caller.activeAlerts()).resolves.toEqual([]);
		expect(server.getActiveDatabaseAlerts).toHaveBeenCalledWith({
			organizationId: "org-1",
			allowedServiceIds: ["postgres-1", "redis-1"],
		});
	});
});
