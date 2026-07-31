import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
	databaseAlertDeliveries,
	databaseAlertDestinations,
	databaseAlertEvents,
	databaseAlertRules,
	notifications,
} from "../db/schema";
import {
	sendCustomNotification,
	sendDiscordNotification,
	sendEmailNotification,
	sendGotifyNotification,
	sendLarkNotification,
	sendMattermostNotification,
	sendNtfyNotification,
	sendPushoverNotification,
	sendResendNotification,
	sendSlackNotification,
	sendTeamsNotification,
	sendTelegramNotification,
} from "../utils/notifications/utils";

export type AlertmanagerWebhook = {
	status: "firing" | "resolved";
	alerts: Array<{
		status: "firing" | "resolved";
		labels: Record<string, string>;
		annotations?: Record<string, string>;
		startsAt: string;
		endsAt?: string;
		fingerprint: string;
	}>;
};

export const formatDatabaseAlertTitle = ({
	status,
	severity,
	name,
}: {
	status: "firing" | "resolved";
	severity: string;
	name: string;
}) =>
	`Dokploy: ${status === "resolved" ? "Resolved" : "Activated"} Severity: ${severity} ${name}`;

const escapeHtml = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");

const dispatchDestination = async ({
	notification,
	title,
	message,
	payload,
	status,
	severity,
}: {
	notification: NonNullable<
		Awaited<ReturnType<typeof findNotificationWithConnection>>
	>;
	title: string;
	message: string;
	payload: Record<string, unknown>;
	status: "firing" | "resolved";
	severity: string;
}) => {
	const color =
		status === "resolved"
			? "#22c55e"
			: severity === "critical"
				? "#ef4444"
				: "#f59e0b";
	const html = `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>`;

	switch (notification.notificationType) {
		case "email":
			if (!notification.email) throw new Error("Email connection is missing");
			await sendEmailNotification(notification.email, title, html);
			return;
		case "resend":
			if (!notification.resend) throw new Error("Resend connection is missing");
			await sendResendNotification(notification.resend, title, html);
			return;
		case "discord":
			if (!notification.discord)
				throw new Error("Discord connection is missing");
			await sendDiscordNotification(notification.discord, {
				title,
				description: message,
				color: Number.parseInt(color.slice(1), 16),
			});
			return;
		case "telegram":
			if (!notification.telegram) {
				throw new Error("Telegram connection is missing");
			}
			await sendTelegramNotification(
				notification.telegram,
				`<b>${escapeHtml(title)}</b>\n${escapeHtml(message)}`,
			);
			return;
		case "slack":
			if (!notification.slack) throw new Error("Slack connection is missing");
			await sendSlackNotification(notification.slack, {
				attachments: [
					{
						color,
						blocks: [
							{
								type: "header",
								text: { type: "plain_text", text: title },
							},
							{
								type: "section",
								text: { type: "mrkdwn", text: message },
							},
						],
					},
				],
			});
			return;
		case "gotify":
			if (!notification.gotify) throw new Error("Gotify connection is missing");
			await sendGotifyNotification(notification.gotify, title, message);
			return;
		case "ntfy":
			if (!notification.ntfy) throw new Error("ntfy connection is missing");
			await sendNtfyNotification(
				notification.ntfy,
				title,
				status === "resolved" ? "white_check_mark" : "warning",
				"",
				message,
			);
			return;
		case "mattermost":
			if (!notification.mattermost) {
				throw new Error("Mattermost connection is missing");
			}
			await sendMattermostNotification(notification.mattermost, {
				text: `**${title}**\n${message}`,
				channel: notification.mattermost.channel,
				username: notification.mattermost.username,
			});
			return;
		case "custom":
			if (!notification.custom) throw new Error("Custom connection is missing");
			await sendCustomNotification(notification.custom, payload);
			return;
		case "lark":
			if (!notification.lark) throw new Error("Lark connection is missing");
			await sendLarkNotification(notification.lark, {
				msg_type: "text",
				content: { text: `${title}\n${message}` },
			});
			return;
		case "teams":
			if (!notification.teams) throw new Error("Teams connection is missing");
			await sendTeamsNotification(notification.teams, {
				title,
				themeColor: color,
				facts: [
					{ name: "State", value: status },
					{ name: "Severity", value: severity },
				],
			});
			return;
		case "pushover":
			if (!notification.pushover) {
				throw new Error("Pushover connection is missing");
			}
			await sendPushoverNotification(notification.pushover, title, message);
			return;
		default:
			throw new Error(
				`Unsupported notification type: ${notification.notificationType}`,
			);
	}
};

const findNotificationWithConnection = async (notificationId: string) =>
	db.query.notifications.findFirst({
		where: eq(notifications.notificationId, notificationId),
		with: {
			slack: true,
			telegram: true,
			discord: true,
			email: true,
			resend: true,
			gotify: true,
			ntfy: true,
			mattermost: true,
			custom: true,
			lark: true,
			pushover: true,
			teams: true,
		},
	});

const deliverEvent = async ({
	eventId,
	ruleId,
	title,
	message,
	payload,
	status,
	severity,
}: {
	eventId: string;
	ruleId: string;
	title: string;
	message: string;
	payload: Record<string, unknown>;
	status: "firing" | "resolved";
	severity: string;
}) => {
	const destinations = await db
		.select({ notificationId: databaseAlertDestinations.notificationId })
		.from(databaseAlertDestinations)
		.where(eq(databaseAlertDestinations.databaseAlertRuleId, ruleId));

	for (const destination of destinations) {
		const [delivery] = await db
			.insert(databaseAlertDeliveries)
			.values({
				databaseAlertEventId: eventId,
				notificationId: destination.notificationId,
				status: "pending",
			})
			.returning();
		if (!delivery) continue;

		try {
			const notification = await findNotificationWithConnection(
				destination.notificationId,
			);
			if (!notification) throw new Error("Notification destination not found");
			await dispatchDestination({
				notification,
				title,
				message,
				payload,
				status,
				severity,
			});
			await db
				.update(databaseAlertDeliveries)
				.set({ status: "sent", attemptedAt: new Date(), error: null })
				.where(
					eq(
						databaseAlertDeliveries.databaseAlertDeliveryId,
						delivery.databaseAlertDeliveryId,
					),
				);
		} catch (error) {
			await db
				.update(databaseAlertDeliveries)
				.set({
					status: "failed",
					attemptedAt: new Date(),
					error: error instanceof Error ? error.message : String(error),
				})
				.where(
					eq(
						databaseAlertDeliveries.databaseAlertDeliveryId,
						delivery.databaseAlertDeliveryId,
					),
				);
		}
	}
};

export const processAlertmanagerWebhook = async ({
	organizationId,
	webhook,
}: {
	organizationId: string;
	webhook: AlertmanagerWebhook;
}) => {
	let accepted = 0;
	for (const alert of webhook.alerts) {
		const ruleId = alert.labels.rule_id;
		const serviceId = alert.labels.service_id;
		if (!ruleId || !serviceId || !alert.fingerprint) continue;

		const rule = await db.query.databaseAlertRules.findFirst({
			where: and(
				eq(databaseAlertRules.databaseAlertRuleId, ruleId),
				eq(databaseAlertRules.organizationId, organizationId),
				eq(databaseAlertRules.serviceId, serviceId),
			),
		});
		if (!rule) continue;

		const status = alert.status === "resolved" ? "resolved" : "firing";
		const [event] = await db
			.insert(databaseAlertEvents)
			.values({
				organizationId,
				databaseAlertRuleId: rule.databaseAlertRuleId,
				serviceId,
				fingerprint: alert.fingerprint,
				status,
				startsAt: new Date(alert.startsAt),
				endsAt:
					status === "resolved" && alert.endsAt ? new Date(alert.endsAt) : null,
				value: alert.labels.value
					? Number.parseFloat(alert.labels.value)
					: null,
				payload: alert as unknown as Record<string, unknown>,
			})
			.onConflictDoNothing({
				target: [
					databaseAlertEvents.organizationId,
					databaseAlertEvents.fingerprint,
					databaseAlertEvents.status,
					databaseAlertEvents.startsAt,
				],
			})
			.returning();
		if (!event) continue;

		accepted += 1;
		const title = formatDatabaseAlertTitle({
			status,
			severity: rule.severity,
			name: rule.name,
		});
		const message =
			alert.annotations?.description ||
			rule.description ||
			`${rule.metricKey} is ${status}`;
		await deliverEvent({
			eventId: event.databaseAlertEventId,
			ruleId: rule.databaseAlertRuleId,
			title,
			message,
			payload: {
				eventId: event.databaseAlertEventId,
				ruleId: rule.databaseAlertRuleId,
				serviceId,
				status,
				severity: rule.severity,
				title,
				message,
				startsAt: alert.startsAt,
				endsAt: alert.endsAt,
			},
			status,
			severity: rule.severity,
		});
	}
	return { accepted };
};
