import { PrismaClient } from "./generated/prisma";
const prisma = new PrismaClient()

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
		message: async (ws, message) => {
			// Helper functions defined at the top level of message handler
			async function createConversation(data: any) {
				console.log("@@CREATING CONVERSATION", data)
				try {
					const savedConversation = await prisma.conversation.create({
						data: {
							id: data.id,
							title: data.title,
						},
					});

					const synced = {
						id: savedConversation.id,
						status: 'synced'
					};
					console.log("@@SYNCED", synced)
					const response = JSON.stringify({ type: "CREATE_CONVERSATION_RESPONSE", data: synced });
					console.log("@@SENDING RESPONSE:", response);
					if (ws.readyState === WebSocket.OPEN) {
						ws.send(response);
						console.log("@@RESPONSE SENT");
					} else {
						console.log("@@WEBSOCKET CLOSED, CANNOT SEND RESPONSE");
					}
				} catch (error) {
					console.error(`Error saving item:${JSON.stringify(data)}`, error);
					const synced = {
						id: data.id,
						status: 'error'
					};
					const errorResponse = JSON.stringify({ type: "CREATE_CONVERSATION_RESPONSE", data: synced });
					console.log("@@SENDING ERROR RESPONSE:", errorResponse);
					if (ws.readyState === WebSocket.OPEN) {
						ws.send(errorResponse);
					}
				}
			}

			async function syncMessage(data: any) {
				console.log("@@SYNCING MESSAGE", data)

				try {
					const conversationExists = await prisma.conversation.findUnique({
						where: {
							id: data.conversationId
						}
					})

					if (!conversationExists) {
						const synced = {
							id: data.id,
							conversationId: data.conversationId,
							status: 'error'
						};
						const errorResponse = JSON.stringify({ type: "MESSAGE_SYNC_RESPONSE", data: synced });
						if (ws.readyState === WebSocket.OPEN) {
							ws.send(errorResponse);
							return;
						}

					}

					const savedMessage = await prisma.message.create({
						data: {
							id: data.id,
							conversationId: data.conversationId,
							sender: data.sender,
							text: data.text
						}
					})
					const syncedMessage = {
						id: savedMessage.id,
						conversationId: savedMessage.conversationId,
						status: "synced"
					}
					if (ws.readyState === WebSocket.OPEN) {
						ws.send(JSON.stringify({ type: "MESSAGE_SYNC_RESPONSE", data: syncedMessage }));
					}

				} catch (error) {
					console.error(`Error saving item:${JSON.stringify(data)}`, error);
					const synced = {
						id: data.id,
						status: 'error'
					};
					const errorResponse = JSON.stringify({ type: "MESSAGE_SYNC_RESPONSE", data: synced });
					console.log("@@SENDING ERROR RESPONSE:", errorResponse);
					if (ws.readyState === WebSocket.OPEN) {
						ws.send(errorResponse);
					}

				}
			}

			function sendError(msg: string) {
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "ERROR", message: msg }));
				}
			}

			function sendStatus() {
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "RECEIVED_SUCCESS", message: "shaji" }))
				}
			}

			try {
				const parsed = JSON.parse(message.toString());
				console.log("Received:", parsed);

				switch (parsed.type) {
					case "MESSAGE_SYNC_REQUEST":
						syncMessage(parsed.data).catch(err => {
							console.error("Error in syncMessage:", err);
							sendError("Message sync failed");
						});
						break;
					case "CREATE_CONVERSATION_REQUEST":
						createConversation(parsed.data).catch(err => {
							console.error("Error in createConversation:", err);
							sendError("Conversation creation failed");
						});
						break;
					case "DB_CHANGE":
						sendStatus();
						break;
					default:
						sendError("Invalid type");
						break;
				}
			} catch (err) {
				console.error("Message parsing error:", err);
				sendError("Invalid message format");
			}
		},
		close(ws, code, reason) {
			console.log("WebSocket disconnected", code, reason);
		},
	},
});

console.log(`🚀 WebSocket server running at http://localhost:${server.port}`);
