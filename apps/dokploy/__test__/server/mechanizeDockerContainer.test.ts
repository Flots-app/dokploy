import type { ApplicationNested } from "@dokploy/server/utils/builders";
import { mechanizeDockerContainer } from "@dokploy/server/utils/builders";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockCreateServiceOptions = {
	Labels?: Record<string, string>;
	TaskTemplate?: {
		ContainerSpec?: {
			Env?: string[];
			Image?: string;
			Labels?: Record<string, string>;
			StopGracePeriod?: number;
			Ulimits?: Array<{ Name: string; Soft: number; Hard: number }>;
		};
	};
	UpdateConfig?: Record<string, unknown>;
	RollbackConfig?: Record<string, unknown>;
	[key: string]: unknown;
};

const { inspectMock, getServiceMock, createServiceMock, getRemoteDockerMock } =
	vi.hoisted(() => {
		const inspect = vi.fn<() => Promise<never>>();
		const getService = vi.fn(() => ({ inspect }));
		const createService = vi.fn<
			(opts: MockCreateServiceOptions) => Promise<void>
		>(async () => undefined);
		const getRemoteDocker = vi.fn(async () => ({
			getService,
			createService,
		}));
		return {
			inspectMock: inspect,
			getServiceMock: getService,
			createServiceMock: createService,
			getRemoteDockerMock: getRemoteDocker,
		};
	});

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: getRemoteDockerMock,
}));

const createApplication = (
	overrides: Partial<ApplicationNested> = {},
): ApplicationNested =>
	({
		applicationId: "application-id",
		appName: "test-app",
		buildType: "dockerfile",
		env: null,
		mounts: [],
		cpuLimit: null,
		memoryLimit: null,
		memoryReservation: null,
		cpuReservation: null,
		command: null,
		ports: [],
		sourceType: "docker",
		dockerImage: "example:latest",
		registry: null,
		environment: {
			project: { env: null },
			env: null,
		},
		replicas: 1,
		stopGracePeriodSwarm: 0,
		ulimitsSwarm: null,
		serverId: "server-id",
		...overrides,
	}) as unknown as ApplicationNested;

describe("mechanizeDockerContainer", () => {
	beforeEach(() => {
		inspectMock.mockReset();
		inspectMock.mockRejectedValue(
			Object.assign(new Error("service not found"), { statusCode: 404 }),
		);
		getServiceMock.mockClear();
		createServiceMock.mockClear();
		getRemoteDockerMock.mockClear();
		getRemoteDockerMock.mockResolvedValue({
			getService: getServiceMock,
			createService: createServiceMock,
		});
	});

	it("passes stopGracePeriodSwarm as a number and keeps zero values", async () => {
		const application = createApplication({ stopGracePeriodSwarm: 0 });

		await mechanizeDockerContainer(application);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0] as
			| [MockCreateServiceOptions]
			| undefined;
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec?.StopGracePeriod).toBe(0);
		expect(typeof settings.TaskTemplate?.ContainerSpec?.StopGracePeriod).toBe(
			"number",
		);
	});

	it("omits StopGracePeriod when stopGracePeriodSwarm is null", async () => {
		const application = createApplication({ stopGracePeriodSwarm: null });

		await mechanizeDockerContainer(application);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0] as
			| [MockCreateServiceOptions]
			| undefined;
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec).not.toHaveProperty(
			"StopGracePeriod",
		);
	});

	it("passes ulimits to ContainerSpec when ulimitsSwarm is defined", async () => {
		const ulimits = [
			{ Name: "nofile", Soft: 10000, Hard: 20000 },
			{ Name: "nproc", Soft: 4096, Hard: 8192 },
		];
		const application = createApplication({ ulimitsSwarm: ulimits });

		await mechanizeDockerContainer(application);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0];
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec?.Ulimits).toEqual(ulimits);
	});

	it("omits Ulimits when ulimitsSwarm is null", async () => {
		const application = createApplication({ ulimitsSwarm: null });

		await mechanizeDockerContainer(application);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0];
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec).not.toHaveProperty("Ulimits");
	});

	it("omits Ulimits when ulimitsSwarm is an empty array", async () => {
		const application = createApplication({ ulimitsSwarm: [] });

		await mechanizeDockerContainer(application);

		expect(createServiceMock).toHaveBeenCalledTimes(1);
		const call = createServiceMock.mock.calls[0];
		if (!call) {
			throw new Error("createServiceMock should have been called once");
		}
		const [settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec).not.toHaveProperty("Ulimits");
	});

	it("pins the immutable release and enforces start-first rollback settings", async () => {
		const application = createApplication({
			env: "DOKPLOY_DEPLOYMENT_ID=user-controlled\nFEATURE=true",
			username: "registry-user",
			password: "registry-password",
			registryUrl: "registry.example.com",
		});

		await mechanizeDockerContainer(application, {
			runtimeImage: "registry.example.com/team/app:deployment-123",
			deploymentId: "deployment-123",
			enforceZeroDowntime: true,
		});

		const call = createServiceMock.mock.calls[0];
		if (!call)
			throw new Error("createServiceMock should have been called once");
		const [settings] = call;
		expect(settings.TaskTemplate?.ContainerSpec?.Image).toBe(
			"registry.example.com/team/app:deployment-123",
		);
		expect(settings.TaskTemplate?.ContainerSpec?.Env).toContain(
			"DOKPLOY_DEPLOYMENT_ID=deployment-123",
		);
		expect(settings.TaskTemplate?.ContainerSpec?.Env).not.toContain(
			"DOKPLOY_DEPLOYMENT_ID=user-controlled",
		);
		expect(settings.UpdateConfig).toMatchObject({
			Parallelism: 1,
			Order: "start-first",
			FailureAction: "rollback",
			MaxFailureRatio: 0,
		});
		expect(settings.RollbackConfig).toMatchObject({
			Parallelism: 1,
			Order: "start-first",
			FailureAction: "pause",
		});
		expect(settings.Labels).toMatchObject({
			"com.dokploy.application-id": "application-id",
			"com.dokploy.deployment-id": "deployment-123",
		});
		expect(settings.TaskTemplate?.ContainerSpec?.Labels).toMatchObject({
			"com.dokploy.deployment-id": "deployment-123",
		});
		expect(createServiceMock).toHaveBeenCalledWith(settings);
	});

	it("does not turn a transient inspect failure into a create attempt", async () => {
		inspectMock.mockRejectedValueOnce(
			Object.assign(new Error("Docker daemon unavailable"), {
				statusCode: 503,
			}),
		);

		await expect(mechanizeDockerContainer(createApplication())).rejects.toThrow(
			"Docker daemon unavailable",
		);
		expect(createServiceMock).not.toHaveBeenCalled();
	});
});
