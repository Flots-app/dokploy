import http from "node:http";

const releaseId = process.env.RELEASE_ID || "unknown";
const unhealthy = process.env.UNHEALTHY === "true";

const server = http.createServer((request, response) => {
	if (request.url === "/health") {
		response.writeHead(unhealthy ? 503 : 200, {
			"content-type": "text/plain",
		});
		response.end(unhealthy ? "unhealthy\n" : "healthy\n");
		return;
	}

	const slowMatch = request.url?.match(/^\/slow\/(\d+)$/);
	const delay = slowMatch ? Math.min(Number(slowMatch[1]), 4) * 1000 : 0;
	setTimeout(() => {
		response.writeHead(200, { "content-type": "text/plain" });
		response.end(`backend:${releaseId}\n`);
	}, delay);
});

server.listen(80);

const shutdown = () => {
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(1), 4_500).unref();
};

process.on("SIGTERM", shutdown);
process.on("SIGQUIT", shutdown);
