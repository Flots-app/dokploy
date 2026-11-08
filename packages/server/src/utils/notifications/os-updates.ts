import { db } from "@dokploy/server/db";
import { notifications } from "@dokploy/server/db/schema";
import OsUpdateNoticeEmail from "@dokploy/server/emails/emails/os-update-notice";
import { getDokployUrl } from "@dokploy/server/services/admin";
import { render } from "@react-email/components";
import { and, eq } from "drizzle-orm";
import escapeHtml from "lodash/escape.js";
import { ntfyHeaderValue } from "./github-runners";
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
} from "./utils";

export interface OsUpdateNotice {
	/** failed: a run failed; missed: a window passed unused; succeeded. */
	event: "failed" | "missed" | "succeeded";
	title: string;
	message: string;
	server: string;
	configuration: string | null;
	at: Date;
}

/** "web-1, web-2 and 8 more": a notice names a few servers, not hundreds. */
export const listNames = (names: string[], max = 10) => {
	if (names.length <= max) return names.join(", ");
	return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
};

/** Cut to what a channel accepts, marking the cut. */
export const limitText = (text: string, max: number) =>
	text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * What the channels accept, in characters: a longer field makes Discord
 * answer 400 and Pushover cut the message; the others are kept as short.
 */
export const CHANNEL_LIMITS = {
	/** With the icon before it, under Pushover's 250 and Discord's 256. */
	title: 240,
	message: 2000,
	factValue: 1024,
	/** Telegram: 4096 for the whole message. */
	telegramFact: 300,
	/** Pushover: 1024 for the whole message. */
	pushover: 1024,
} as const;

const STYLE = {
	failed: {
		icon: "🔴",
		color: 0xed4245,
		hex: "#ED4245",
		lark: "red",
		ntfy: "rotating_light",
	},
	missed: {
		icon: "🟠",
		color: 0xfaa61a,
		hex: "#FAA61A",
		lark: "orange",
		ntfy: "warning",
	},
	succeeded: {
		icon: "✅",
		color: 0x57f287,
		hex: "#57F287",
		lark: "green",
		ntfy: "white_check_mark",
	},
} as const;

/**
 * Sends an OS updates notice to every notification of the organization that
 * subscribed to them. A channel that fails does not stop the others.
 */
export const sendOsUpdateNotifications = async (
	organizationId: string,
	notice: OsUpdateNotice,
) => {
	const notificationList = await db.query.notifications.findMany({
		where: and(
			eq(notifications.osUpdates, true),
			eq(notifications.organizationId, organizationId),
		),
		with: {
			email: true,
			discord: true,
			telegram: true,
			slack: true,
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
	if (!notificationList.length) return;

	const style = STYLE[notice.event];
	const heading = limitText(notice.title, CHANNEL_LIMITS.title);
	const title = `${style.icon} ${heading}`;
	const message = limitText(notice.message, CHANNEL_LIMITS.message);
	const link = `${await getDokployUrl()}/dashboard/os-updates`;
	const date = notice.at.toISOString().replace("T", " ").slice(0, 16);
	const facts = [
		{ name: "Server", value: notice.server },
		...(notice.configuration
			? [{ name: "Configuration", value: notice.configuration }]
			: []),
		{ name: "Date", value: `${date} UTC` },
	].map((fact) => ({
		...fact,
		value: limitText(fact.value, CHANNEL_LIMITS.factValue),
	}));
	const plain = `${message}\n\n${facts.map((fact) => `${fact.name}: ${fact.value}`).join("\n")}\n${link}`;

	for (const notification of notificationList) {
		const {
			email,
			resend,
			discord,
			telegram,
			slack,
			gotify,
			ntfy,
			mattermost,
			custom,
			lark,
			pushover,
			teams,
		} = notification;
		const sends: Promise<unknown>[] = [];
		if (email || resend) {
			const template = await render(
				OsUpdateNoticeEmail({
					heading: notice.title,
					message: notice.message,
					facts,
					link,
				}),
			);
			const subject = `${style.icon} OS Updates: ${notice.title}`;
			if (email) sends.push(sendEmailNotification(email, subject, template));
			if (resend) sends.push(sendResendNotification(resend, subject, template));
		}
		if (discord) {
			sends.push(
				sendDiscordNotification(discord, {
					title,
					description: message,
					url: link,
					color: style.color,
					fields: facts.map((fact) => ({ ...fact, inline: true })),
					timestamp: notice.at.toISOString(),
					footer: { text: "Dokploy OS Updates" },
				}),
			);
		}
		if (telegram) {
			sends.push(
				sendTelegramNotification(
					telegram,
					`<b>${escapeHtml(title)}</b>\n\n${escapeHtml(message)}\n\n${facts.map((fact) => `<b>${fact.name}:</b> ${escapeHtml(limitText(fact.value, CHANNEL_LIMITS.telegramFact))}`).join("\n")}`,
					[[{ text: "Open OS Updates", url: link }]],
				),
			);
		}
		if (slack) {
			sends.push(
				sendSlackNotification(slack, {
					channel: slack.channel,
					attachments: [
						{
							color: style.hex,
							pretext: `*${title}*`,
							text: message,
							fields: facts.map((fact) => ({
								title: fact.name,
								value: fact.value,
								short: true,
							})),
							actions: [{ type: "button", text: "Open OS Updates", url: link }],
						},
					],
				}),
			);
		}
		if (gotify) sends.push(sendGotifyNotification(gotify, title, plain));
		if (ntfy) {
			sends.push(
				sendNtfyNotification(
					ntfy,
					ntfyHeaderValue(heading),
					style.ntfy,
					ntfyHeaderValue(`view, Open OS Updates, ${link}, clear=true;`),
					`${message}\n\n${facts[0]?.value ?? ""} · ${date} UTC`,
				),
			);
		}
		if (mattermost) {
			sends.push(
				sendMattermostNotification(mattermost, {
					text: `**${title}**\n\n${message}\n\n${facts.map((fact) => `**${fact.name}:** ${fact.value}`).join("\n")}\n[Open OS Updates](${link})`,
					channel: mattermost.channel,
					username: mattermost.username || "Dokploy",
				}),
			);
		}
		if (custom) {
			sends.push(
				sendCustomNotification(custom, {
					title: notice.title,
					message: notice.message,
					event: notice.event,
					server: notice.server,
					configuration: notice.configuration,
					link,
					timestamp: notice.at.toISOString(),
					type: "os-updates",
				}),
			);
		}
		if (lark) {
			sends.push(
				sendLarkNotification(lark, {
					msg_type: "interactive",
					card: {
						schema: "2.0",
						header: {
							title: { tag: "plain_text", content: title },
							template: style.lark,
						},
						body: {
							elements: [
								{ tag: "markdown", content: message },
								{
									tag: "markdown",
									content: facts
										.map((fact) => `**${fact.name}:** ${fact.value}`)
										.join("\n"),
								},
								{
									tag: "button",
									text: { tag: "plain_text", content: "Open OS Updates" },
									behaviors: [{ type: "open_url", default_url: link }],
								},
							],
						},
					},
				}),
			);
		}
		if (pushover) {
			sends.push(
				sendPushoverNotification(
					pushover,
					title,
					limitText(plain, CHANNEL_LIMITS.pushover),
				),
			);
		}
		if (teams) {
			sends.push(
				sendTeamsNotification(teams, {
					title,
					facts: [{ name: "Details", value: message }, ...facts],
					potentialAction: {
						type: "Action.OpenUrl",
						title: "Open OS Updates",
						url: link,
					},
				}),
			);
		}
		const results = await Promise.allSettled(sends);
		for (const result of results) {
			if (result.status === "rejected") {
				console.error(
					`OS updates notification "${notification.name}" failed`,
					result.reason,
				);
			}
		}
	}
};
