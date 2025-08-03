import { PrismaClient } from "./generated/prisma";
const prisma = new PrismaClient()

const corsHeaders = {
	"Access-Control-Allow-Origin": "http://localhost:3000", // Update with your frontend URL
	"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
	"Access-Control-Allow-Credentials": "true",
};

async function handleChatStream(req: Request): Promise<Response> {
	try {
		const { messages, conversationId } = await req.json() as any;

		if (!messages || !Array.isArray(messages)) {
			return new Response(
				JSON.stringify({ error: 'Messages array is required' }),
				{
					status: 400,
					headers: { ...corsHeaders, "Content-Type": "application/json" }
				}
			);
		}

		// Create streaming response
		const stream = new ReadableStream({
			async start(controller) {
				try {
					const response = await fetch('https://api.openai.com/v1/chat/completions', {
						method: 'POST',
						headers: {
							'Authorization': `Bearer ${process.env.OPEN_ROUTER_API_KEY}`,
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({
							model: 'gpt-4',
							messages: messages,
							stream: true, // Enable streaming
							temperature: 0.7,
						}),
					});

					if (!response.ok) {
						console.log(response)
						throw new Error(`OpenAI API error: ${response.status}`);
					}

					const reader = response.body?.getReader();
					if (!reader) {
						throw new Error('No response body');
					}

					const decoder = new TextDecoder();

					while (true) {
						const { done, value } = await reader.read();

						if (done) {
							// Send final message to indicate completion
							controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
								type: 'done',
								conversationId
							})}\n\n`));
							break;
						}

						const chunk = decoder.decode(value);
						const lines = chunk.split('\n');

						for (const line of lines) {
							if (line.startsWith('data: ')) {
								const data = line.slice(6).trim();

								if (data === '[DONE]') {
									continue;
								}

								try {
									const parsed = JSON.parse(data);
									const content = parsed.choices?.[0]?.delta?.content;

									if (content) {
										// Send the streaming content
										controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
											type: 'content',
											content,
											conversationId
										})}\n\n`));
									}
								} catch (e) {
									// Skip invalid JSON
									console.warn('Failed to parse SSE data:', data);
								}
							}
						}
					}

					controller.close();
				} catch (error) {
					console.error('Streaming error:', error);
					controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
						type: 'error',
						error: error instanceof Error ? error.message : 'Unknown error',
						conversationId
					})}\n\n`));
					controller.close();
				}
			}
		});

		return new Response(stream, {
			headers: {
				...corsHeaders,
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
			},
		});
	} catch (error) {
		console.error('Server error:', error);
		return new Response(
			JSON.stringify({ error: 'Internal server error' }),
			{
				status: 500,
				headers: { ...corsHeaders, "Content-Type": "application/json" }
			}
		);
	}
}

const server = Bun.serve({
	port: 3001,
	fetch(req, server) {
		const url = new URL(req.url);

		// Handle CORS preflight requests
		if (req.method === "OPTIONS") {
			return new Response(null, {
				status: 200,
				headers: corsHeaders
			});
		}

		// Handle HTTP routes
		if (req.method === "POST" && url.pathname === "/api/chat/stream") {
			return handleChatStream(req);
		}

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
							initialPrompt: data.initialPrompt
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
					ws.send(JSON.stringify({ type: "RECEIVED_SUCCESS", message: "done" }))
				}
			}


			async function warmUpDB() {
				const conversations = await prisma.conversation.findMany({ take: 1 })
				console.log("@@CONVERSATIONS", conversations)
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "WARM_UP_STATUS", message: "Warm up complete" }))
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
					case "WARM_UP":
						warmUpDB().catch(err => {
							console.error("Fetching conversations failed", err)
							sendError("warm up failed");
						})

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
