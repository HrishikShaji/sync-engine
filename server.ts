// server.js - Bun server with OpenAI streaming and resume capability
import { serve } from "bun";
import OpenAI from "openai";
import { randomUUID } from "crypto";

const openai = new OpenAI({
	apiKey: process.env.OPEN_ROUTER_API_KEY,
});



// simple-resumable-server.js

// Simple in-memory storage
const sessions = new Map(); // sessionId -> { chunks: [], completed: boolean, error: null }

const server = serve({
	port: 3001,
	async fetch(req) {
		const url = new URL(req.url);

		const corsHeaders = {
			"Access-Control-Allow-Origin": "http://localhost:3000", // Update with your frontend URL
			"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type, Authorization",
			"Access-Control-Allow-Credentials": "true",
		};

		if (req.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders });
		}

		// Health check
		if (url.pathname === "/health") {
			return new Response("OK", { headers: corsHeaders });
		}

		// Start new stream
		if (url.pathname === "/api/chat/start" && req.method === "POST") {
			try {
				const { message } = await req.json();
				const sessionId = randomUUID();

				console.log(`Starting new session: ${sessionId}`);

				// Initialize session
				sessions.set(sessionId, {
					chunks: [],
					completed: false,
					error: null
				});

				// Start processing in background
				processStream(sessionId, message);

				return new Response(JSON.stringify({ sessionId }), {
					headers: { ...corsHeaders, "Content-Type": "application/json" }
				});

			} catch (error) {
				console.error("Start error:", error);
				return new Response(JSON.stringify({ error: error.message }), {
					status: 500,
					headers: { ...corsHeaders, "Content-Type": "application/json" }
				});
			}
		}

		// Get stream
		if (url.pathname === "/api/chat/stream" && req.method === "GET") {
			const sessionId = url.searchParams.get('sessionId');
			const lastIndex = parseInt(url.searchParams.get('lastChunkIndex') || '0');

			console.log(`Stream request for session: ${sessionId}, from index: ${lastIndex}`);

			if (!sessionId || !sessions.has(sessionId)) {
				return new Response("Session not found", {
					status: 404,
					headers: corsHeaders
				});
			}

			const session = sessions.get(sessionId);

			const stream = new ReadableStream({
				start(controller) {
					const encoder = new TextEncoder();

					// Send existing chunks first
					for (let i = lastIndex; i < session.chunks.length; i++) {
						const data = `data: ${JSON.stringify(session.chunks[i])}\n\n`;
						controller.enqueue(encoder.encode(data));
					}

					// If already completed, send done
					if (session.completed) {
						const data = `data: ${JSON.stringify({ type: 'done' })}\n\n`;
						controller.enqueue(encoder.encode(data));
						controller.close();
						return;
					}

					// If error, send error
					if (session.error) {
						const data = `data: ${JSON.stringify({ type: 'error', error: session.error })}\n\n`;
						controller.enqueue(encoder.encode(data));
						controller.close();
						return;
					}

					// Watch for new chunks
					let currentIndex = session.chunks.length;
					const interval = setInterval(() => {
						// Send new chunks
						while (currentIndex < session.chunks.length) {
							const chunk = session.chunks[currentIndex];
							const data = `data: ${JSON.stringify(chunk)}\n\n`;
							controller.enqueue(encoder.encode(data));
							currentIndex++;
						}

						// Check completion
						if (session.completed) {
							const data = `data: ${JSON.stringify({ type: 'done' })}\n\n`;
							controller.enqueue(encoder.encode(data));
							clearInterval(interval);
							controller.close();
							return;
						}

						if (session.error) {
							const data = `data: ${JSON.stringify({ type: 'error', error: session.error })}\n\n`;
							controller.enqueue(encoder.encode(data));
							clearInterval(interval);
							controller.close();
							return;
						}
					}, 100);

					// Cleanup on abort
					const cleanup = () => {
						clearInterval(interval);
					};

					// Handle client disconnect
					req.signal?.addEventListener('abort', cleanup);
				}
			});

			return new Response(stream, {
				headers: {
					...corsHeaders,
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					"Connection": "keep-alive",
				},
			});
		}

		return new Response("Not Found", { status: 404, headers: corsHeaders });
	},
});

// Background stream processing
async function processStream(sessionId, message) {
	const session = sessions.get(sessionId);
	if (!session) return;

	console.log(`Processing stream for session: ${sessionId}`);

	try {
		const stream = await openai.chat.completions.create({
			model: "gpt-3.5-turbo",
			messages: [{ role: "user", content: message }],
			stream: true,
		});

		let chunkIndex = 0;
		for await (const chunk of stream) {
			const content = chunk.choices[0]?.delta?.content;
			if (content) {
				session.chunks.push({
					type: 'content',
					content,
					chunkIndex: chunkIndex++
				});
				console.log(`Added chunk ${chunkIndex - 1} to session ${sessionId}`);
			}
		}

		session.completed = true;
		console.log(`Stream completed for session: ${sessionId}, total chunks: ${session.chunks.length}`);

	} catch (error) {
		console.error(`Stream error for session ${sessionId}:`, error);
		session.error = error.message;
	}
}

console.log(`Simple resumable server running on http://localhost:${server.port}`);
