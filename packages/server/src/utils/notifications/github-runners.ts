import { db } from "@dokploy/server/db";
import { notifications } from "@dokploy/server/db/schema";
import GithubRunnerAlertEmail from "@dokploy/server/emails/emails/github-runner-alert";
import { getDokployUrl } from "@dokploy/server/services/admin";
import type { RunnerNotice } from "@dokploy/server/utils/github-runners/alerts";
import { render } from "@react-email/components";
import { and, eq } from "drizzle-orm";
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

const STYLE = {
	critical: {
		icon: "🔴",
		color: 0xed4245,
		hex: "#ED4245",
		lark: "red",
		ntfy: "rotating_light",
	},
	warning: {
		icon: "🟠",
		color: 0xfaa61a,
		hex: "#FAA61A",
		lark: "orange",
		ntfy: "warning",
	},
	resolved: {
		icon: "✅",
		color: 0x57f287,
		hex: "#57F287",
		lark: "green",
		ntfy: "white_check_mark",
	},
	info: {
		icon: "ℹ️",
		color: 0x5865f2,
		hex: "#5865F2",
		lark: "blue",
		ntfy: "information_source",
	},
} as const;

/** The heading of a notice, e.g. "Resolved: m6 is unreachable". */
export const runnerNoticeHeading = (notice: RunnerNotice) => {
	switch (notice.event) {
		case "resolved":
			return `Resolved: ${notice.title}`;
		case "reminder":
			return `Still open: ${notice.title}`;
		default:
			return notice.title;
	}
};

const escapeHtml = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Sends a GitHub Runners notice to every notification of the organization
 * that subscribed to them. A channel that fails does not stop the others.
 */
export const sendGithubRunnerNotifications = async (
	organizationId: string,
	notice: RunnerNotice,
) => {
	const notificationList = await db.query.notifications.findMany({
		where: and(
			eq(notifications.githubRunners, true),
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

	const style =
		STYLE[notice.event === "resolved" ? "resolved" : notice.severity];
	const heading = runnerNoticeHeading(notice);
	const title = `${style.icon} ${heading}`;
	const link = `${await getDokployUrl()}/dashboard/runners`;
	const date = notice.at.toISOString().replace("T", " ").slice(0, 16);
	const where = notice.machine
		? `${notice.pool} › ${notice.machine}`
		: notice.pool;
	const plain = `${notice.message}\n\nPool: ${notice.pool}${notice.machine ? `\nMachine: ${notice.machine}` : ""}\nDate: ${date} UTC\n${link}`;
	const facts = [
		{ name: "Pool", value: notice.pool },
		...(notice.machine ? [{ name: "Machine", value: notice.machine }] : []),
		{ name: "Date", value: `${date} UTC` },
	];

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
				GithubRunnerAlertEmail({
					heading,
					message: notice.message,
					pool: notice.pool,
					machine: notice.machine,
					date: `${date} UTC`,
					link,
				}),
			);
			const subject = `${style.icon} GitHub Runners: ${heading}`;
			if (email) sends.push(sendEmailNotification(email, subject, template));
			if (resend) sends.push(sendResendNotification(resend, subject, template));
		}
		if (discord) {
			sends.push(
				sendDiscordNotification(discord, {
					title,
					description: notice.message,
					url: link,
					color: style.color,
					fields: facts.map((fact) => ({ ...fact, inline: true })),
					timestamp: notice.at.toISOString(),
					footer: { text: "Dokploy GitHub Runners" },
				}),
			);
		}
		if (telegram) {
			sends.push(
				sendTelegramNotification(
					telegram,
					`<b>${escapeHtml(title)}</b>\n\n${escapeHtml(notice.message)}\n\n<b>Pool:</b> ${escapeHtml(notice.pool)}${notice.machine ? `\n<b>Machine:</b> ${escapeHtml(notice.machine)}` : ""}\n<b>Date:</b> ${date} UTC`,
					[[{ text: "Open GitHub Runners", url: link }]],
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
							text: notice.message,
							fields: facts.map((fact) => ({
								title: fact.name,
								value: fact.value,
								short: true,
							})),
							actions: [
								{ type: "button", text: "Open GitHub Runners", url: link },
							],
						},
					],
				}),
			);
		}
		if (gotify) {
			sends.push(sendGotifyNotification(gotify, title, plain));
		}
		if (ntfy) {
			sends.push(
				sendNtfyNotification(
					ntfy,
					heading,
					style.ntfy,
					`view, Open GitHub Runners, ${link}, clear=true;`,
					`${notice.message}\n\n${where} · ${date} UTC`,
				),
			);
		}
		if (mattermost) {
			sends.push(
				sendMattermostNotification(mattermost, {
					text: `**${title}**\n\n${notice.message}\n\n**Pool:** ${notice.pool}${notice.machine ? `\n**Machine:** ${notice.machine}` : ""}\n**Date:** ${date} UTC\n[Open GitHub Runners](${link})`,
					channel: mattermost.channel,
					username: mattermost.username || "Dokploy",
				}),
			);
		}
		if (custom) {
			sends.push(
				sendCustomNotification(custom, {
					title: heading,
					message: notice.message,
					event: notice.event,
					severity: notice.severity,
					pool: notice.pool,
					machine: notice.machine,
					link,
					timestamp: notice.at.toISOString(),
					type: "github-runners",
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
								{ tag: "markdown", content: notice.message },
								{
									tag: "markdown",
									content: facts
										.map((fact) => `**${fact.name}:** ${fact.value}`)
										.join("\n"),
								},
								{
									tag: "button",
									text: { tag: "plain_text", content: "Open GitHub Runners" },
									behaviors: [{ type: "open_url", default_url: link }],
								},
							],
						},
					},
				}),
			);
		}
		if (pushover) {
			sends.push(sendPushoverNotification(pushover, title, plain));
		}
		if (teams) {
			sends.push(
				sendTeamsNotification(teams, {
					title,
					facts: [{ name: "Details", value: notice.message }, ...facts],
					potentialAction: {
						type: "Action.OpenUrl",
						title: "Open GitHub Runners",
						url: link,
					},
				}),
			);
		}
		const results = await Promise.allSettled(sends);
		for (const result of results) {
			if (result.status === "rejected") {
				console.error(
					`GitHub runner notification "${notification.name}" failed`,
					result.reason,
				);
			}
		}
	}
};
