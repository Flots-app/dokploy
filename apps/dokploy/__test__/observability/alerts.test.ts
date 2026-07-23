import { beforeEach, describe, expect, it, vi } from "vitest";

const notificationSenders = vi.hoisted(() => ({
	sendCustomNotification: vi.fn(),
	sendDiscordNotification: vi.fn(),
	sendEmailNotification: vi.fn(),
	sendGotifyNotification: vi.fn(),
	sendLarkNotification: vi.fn(),
	sendMattermostNotification: vi.fn(),
	sendNtfyNotification: vi.fn(),
	sendPushoverNotification: vi.fn(),
	sendResendNotification: vi.fn(),
	sendSlackNotification: vi.fn(),
	sendTeamsNotification: vi.fn(),
	sendTelegramNotification: vi.fn(),
}));

const state = vi.hoisted(() => ({
	eventKeys: new Set<string>(),
	eventSequence: 0,
	deliverySequence: 0,
	deliveryUpdates: [] as Array<Record<string, unknown>>,
	conflictTargetNames: [] as string[][],
	findRule: vi.fn(),
	findNotification: vi.fn(),
	selectedDestinations: [{ notificationId: "notification-selected" }],
}));

vi.mock("@dokploy/server/utils/notifications/utils", () => notificationSenders);

vi.mock("@dokploy/server/db", () => {
	const updateChain = {
		set: vi.fn((values: Record<string, unknown>) => {
			state.deliveryUpdates.push(values);
			return updateChain;
		}),
		where: vi.fn(async () => undefined),
	};

	return {
		db: {
			query: {
				databaseAlertRules: { findFirst: state.findRule },
				notifications: { findFirst: state.findNotification },
			},
			select: vi.fn(() => ({
				from: vi.fn(() => ({
					where: vi.fn(async () => state.selectedDestinations),
				})),
			})),
			insert: vi.fn(() => ({
				values: (values: Record<string, unknown>) => {
					if ("fingerprint" in values) {
						return {
							onConflictDoNothing: ({
								target,
							}: {
								target: Array<{ name: string }>;
							}) => {
								state.conflictTargetNames.push(
									target.map((column) => column.name),
								);
								return {
									returning: async () => {
										const key = [
											values.fingerprint,
											values.status,
											(values.startsAt as Date).toISOString(),
										].join(":");
										if (state.eventKeys.has(key)) return [];
										state.eventKeys.add(key);
										state.eventSequence += 1;
										return [
											{
												...values,
												databaseAlertEventId: `event-${state.eventSequence}`,
											},
										];
									},
								};
							},
						};
					}
					return {
						returning: async () => {
							state.deliverySequence += 1;
							return [
								{
									...values,
									databaseAlertDeliveryId: `delivery-${state.deliverySequence}`,
								},
							];
						},
					};
				},
			})),
			update: vi.fn(() => updateChain),
		},
		dbUrl: "postgres://mock:mock@localhost:5432/mock",
	};
});

import { processAlertmanagerWebhook } from "@dokploy/server/observability/alerts";

const webhook = (
	status: "firing" | "resolved",
	startsAt: string,
): Parameters<typeof processAlertmanagerWebhook>[0]["webhook"] => ({
	status,
	alerts: [
		{
			status,
			labels: {
				rule_id: "rule-1",
				service_id: "postgres-1",
				value: status === "firing" ? "0" : "1",
			},
			annotations: { description: "Database availability changed" },
			startsAt,
			endsAt: status === "resolved" ? "2026-07-23T12:05:00.000Z" : undefined,
			fingerprint: "stable-fingerprint",
		},
	],
});

describe("Alertmanager webhook transitions and delivery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.eventKeys.clear();
		state.eventSequence = 0;
		state.deliverySequence = 0;
		state.deliveryUpdates.length = 0;
		state.conflictTargetNames.length = 0;
		state.findRule.mockResolvedValue({
			databaseAlertRuleId: "rule-1",
			organizationId: "org-1",
			serviceId: "postgres-1",
			metricKey: "postgres.up",
			severity: "critical",
			name: "PostgreSQL down",
			description: "Unavailable",
		});
		state.findNotification.mockImplementation(
			async ({ where: _where }: { where: unknown }) => ({
				notificationId: "notification-selected",
				notificationType: "custom",
				custom: { url: "https://example.com/webhook" },
			}),
		);
		notificationSenders.sendCustomNotification.mockResolvedValue(undefined);
	});

	it("deduplicates repeats, persists resolved, and permits a later firing cycle", async () => {
		const firstStart = "2026-07-23T12:00:00.000Z";
		const secondStart = "2026-07-23T13:00:00.000Z";

		await expect(
			processAlertmanagerWebhook({
				organizationId: "org-1",
				webhook: webhook("firing", firstStart),
			}),
		).resolves.toEqual({ accepted: 1 });
		await expect(
			processAlertmanagerWebhook({
				organizationId: "org-1",
				webhook: webhook("firing", firstStart),
			}),
		).resolves.toEqual({ accepted: 0 });
		await expect(
			processAlertmanagerWebhook({
				organizationId: "org-1",
				webhook: webhook("resolved", firstStart),
			}),
		).resolves.toEqual({ accepted: 1 });
		await expect(
			processAlertmanagerWebhook({
				organizationId: "org-1",
				webhook: webhook("firing", secondStart),
			}),
		).resolves.toEqual({ accepted: 1 });

		expect(notificationSenders.sendCustomNotification).toHaveBeenCalledTimes(3);
		expect(state.findNotification).toHaveBeenCalledTimes(3);
		expect(state.conflictTargetNames[0]).toEqual([
			"organizationId",
			"fingerprint",
			"status",
			"startsAt",
		]);
		expect(state.deliveryUpdates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ status: "sent", error: null }),
			]),
		);
	});

	it("ignores alerts that do not belong to the authenticated organization", async () => {
		state.findRule.mockResolvedValue(undefined);
		await expect(
			processAlertmanagerWebhook({
				organizationId: "org-2",
				webhook: webhook("firing", "2026-07-23T12:00:00.000Z"),
			}),
		).resolves.toEqual({ accepted: 0 });
		expect(notificationSenders.sendCustomNotification).not.toHaveBeenCalled();
	});
});
