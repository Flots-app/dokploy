import type { NextApiResponse } from "next";
import { describe, expect, it, vi } from "vitest";
import { sendUpstreamResponse } from "../../server/utils/observability-http";

const responseDouble = () => {
	const response = {
		status: vi.fn(),
		setHeader: vi.fn(),
		send: vi.fn(),
		end: vi.fn(),
	};
	response.status.mockReturnValue(response);
	response.setHeader.mockReturnValue(response);
	response.send.mockReturnValue(response);
	response.end.mockReturnValue(response);
	return response;
};

describe("observability upstream responses", () => {
	it("does not forward content encoding after fetch has decoded the body", async () => {
		const response = responseDouble();
		const upstream = new Response("<html>Grafana</html>", {
			headers: {
				"content-encoding": "gzip",
				"content-type": "text/html",
			},
		});

		await sendUpstreamResponse(
			upstream,
			response as unknown as NextApiResponse,
		);

		expect(response.setHeader).not.toHaveBeenCalledWith(
			"content-encoding",
			expect.anything(),
		);
		expect(response.setHeader).toHaveBeenCalledWith(
			"content-type",
			"text/html",
		);
		expect(response.send).toHaveBeenCalledWith(
			Buffer.from("<html>Grafana</html>"),
		);
	});

	it("ends bodyless upstream responses without sending a buffer", async () => {
		const response = responseDouble();
		const upstream = new Response(null, { status: 204 });

		await sendUpstreamResponse(
			upstream,
			response as unknown as NextApiResponse,
		);

		expect(response.status).toHaveBeenCalledWith(204);
		expect(response.end).toHaveBeenCalledOnce();
		expect(response.send).not.toHaveBeenCalled();
	});
});
