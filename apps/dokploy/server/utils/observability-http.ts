import type { NextApiRequest, NextApiResponse } from "next";

export const readRequestBody = (
	request: NextApiRequest,
	maxBytes: number,
): Promise<Buffer> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		request.on("data", (chunk: Buffer | string) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			total += buffer.length;
			if (total > maxBytes) {
				reject(new Error("Request body is too large"));
				request.destroy();
				return;
			}
			chunks.push(buffer);
		});
		request.on("end", () => resolve(Buffer.concat(chunks)));
		request.on("error", reject);
	});

const responseHeaders = [
	"cache-control",
	"content-language",
	"content-type",
	"etag",
	"expires",
	"last-modified",
	"location",
	"set-cookie",
	"vary",
] as const;

export const sendUpstreamResponse = async (
	upstream: Response,
	response: NextApiResponse,
	{ rewriteLocation }: { rewriteLocation?: (location: string) => string } = {},
) => {
	response.status(upstream.status);
	for (const name of responseHeaders) {
		const value = upstream.headers.get(name);
		if (!value) continue;
		response.setHeader(
			name,
			name === "location" && rewriteLocation ? rewriteLocation(value) : value,
		);
	}
	if (upstream.status === 204 || upstream.status === 304) {
		response.end();
		return;
	}
	response.send(Buffer.from(await upstream.arrayBuffer()));
};

export const bearerToken = (request: NextApiRequest) => {
	const authorization = request.headers.authorization;
	if (!authorization?.startsWith("Bearer ")) return null;
	return authorization.slice("Bearer ".length).trim() || null;
};

export const toFetchBody = (buffer: Buffer): ArrayBuffer =>
	buffer.buffer.slice(
		buffer.byteOffset,
		buffer.byteOffset + buffer.byteLength,
	) as ArrayBuffer;

export const firstHeader = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value[0] : value;
