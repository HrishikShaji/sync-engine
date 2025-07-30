const server = Bun.serve({
	port: 3001,
	fetch(req, server) {
		const upgrade = req.headers.get("upgrade") || "";
		if (upgrade.toLowerCase() === "websocket") {
			const success = server.upgrade(req);
			if (success) return; // connection upgraded, do not respond
			return new Response("WebSocket upgrade failed", { status: 400 });
		}

		return new Response("WebSocket server only", { status: 404 });
	},

	websocket: {
		open(ws) {
			console.log("WebSocket client connected");
			ws.send(
				JSON.stringify({
					type: "welcome",
					message: "Connected to WebSocket server!",
					timestamp: new Date().toISOString(),
				})
			);
		},

		message(ws, message) {
			try {
				const parsed = JSON.parse(message.toString());
				console.log("Received:", parsed);

				switch (parsed.type) {
					case "MESSAGE_SYNC_REQUEST":
						return syncMessage(parsed.data);
					default:
						return sendError("Invalid type");
				}

				function syncMessage(data: any) {
					const synced = { ...data, syncStatus: "synced" };
					ws.send(JSON.stringify({ type: "MESSAGE_SYNC_RESPONSE", data: synced }));
				}

				function sendError(msg: string) {
					ws.send(JSON.stringify({ type: "ERROR", message: msg }));
				}
			} catch (err) {
				ws.send(JSON.stringify({ type: "ERROR", message: "Invalid message format" }));
			}
		},

		close(ws, code, reason) {
			console.log("WebSocket disconnected", code, reason);
		},
	},
});

console.log(`🚀 WebSocket server running at http://localhost:${server.port}`);
