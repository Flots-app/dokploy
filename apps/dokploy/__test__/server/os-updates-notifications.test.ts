import { db } from "@dokploy/server/db";
import {
	CHANNEL_LIMITS,
	limitText,
	listNames,
	sendOsUpdateNotifications,
} from "@dokploy/server/utils/notifications/os-updates";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({
	discord: [] as {
		fields: { name: string; value: string }[];
		title: string;
		description: string;
	}[],
	telegram: [] as string[],
	pushover: [] as { title: string; message: string }[],
}));

vi.mock("@dokploy/server/services/admin", () => ({
	getDokployUrl: async () => "https://dokploy.example.test",
}));

vi.mock("@dokploy/server/utils/notifications/utils", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@dokploy/server/utils/notifications/utils")
		>();
	return {
		...original,
		sendDiscordNotification: async (
			_connection: unknown,
			embed: (typeof sent.discord)[number],
		) => {
			sent.discord.push(embed);
		},
		sendTelegramNotification: async (_connection: unknown, text: string) => {
			sent.telegram.push(text);
		},
		sendPushoverNotification: async (
			_connection: unknown,
			title: string,
			message: string,
		) => {
			sent.pushover.push({ title, message });
		},
	};
});

/** 300 servers missed a window: more than any channel takes in a field. */
const servers = Array.from(
	{ length: 300 },
	(_, index) => `server-${index + 1}`,
);

describe("OS updates notices", () => {
	beforeEach(() => {
		sent.discord.length = 0;
		sent.telegram.length = 0;
		sent.pushover.length = 0;
		vi.mocked(db.query.notifications.findMany).mockResolvedValueOnce([
			{
				// The senders are faked: the channels' settings are never read.
				name: "ops",
				discord: {},
				telegram: {},
				pushover: {},
			},
		] as never);
	});

	it("name a few servers, and say how many more", () => {
		expect(listNames(["a", "b"])).toBe("a, b");
		expect(listNames(servers)).toBe(
			"server-1, server-2, server-3, server-4, server-5, server-6, server-7, server-8, server-9, server-10 and 290 more",
		);
		expect(limitText("abcdef", 4)).toBe("abc…");
		expect(limitText("abc", 4)).toBe("abc");
	});

	it("stay within what each channel accepts, whatever they are given", async () => {
		const everyone = servers.join(", ");
		await sendOsUpdateNotifications("org", {
			event: "missed",
			title: `Maintenance window missed: ${"a".repeat(400)}`,
			message: `No Dokploy ran during the window, so ${everyone} did not install their OS updates.`,
			server: everyone,
			configuration: "Weekly security",
			at: new Date("2026-11-08T02:00:00Z"),
		});
		const [discord] = sent.discord;
		// Discord answers 400 beyond these.
		expect(discord?.title.length).toBeLessThanOrEqual(256);
		expect(discord?.description.length).toBeLessThanOrEqual(4096);
		for (const field of discord?.fields ?? []) {
			expect(field.value.length).toBeLessThanOrEqual(1024);
		}
		expect(discord?.fields[0]?.value.endsWith("…")).toBe(true);
		expect(sent.telegram[0]?.length).toBeLessThanOrEqual(4096);
		expect(sent.pushover[0]?.message.length).toBeLessThanOrEqual(
			CHANNEL_LIMITS.pushover,
		);
		expect(sent.pushover[0]?.title.length).toBeLessThanOrEqual(250);
	});
});
