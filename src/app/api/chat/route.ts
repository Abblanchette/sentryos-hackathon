import { query } from '@anthropic-ai/claude-agent-sdk'
import * as Sentry from '@sentry/nextjs'

const SYSTEM_PROMPT = `You are a helpful personal assistant designed to help with general research, questions, and tasks.

Your role is to:
- Answer questions on any topic accurately and thoroughly
- Help with research by searching the web for current information
- Assist with writing, editing, and brainstorming
- Provide explanations and summaries of complex topics
- Help solve problems and think through decisions

Guidelines:
- Be friendly, clear, and conversational
- Use web search when you need current information, facts you're unsure about, or real-time data
- Keep responses concise but complete - expand when the topic warrants depth
- Use markdown formatting when it helps readability (bullet points, code blocks, etc.)
- Be honest when you don't know something and offer to search for answers`

interface MessageInput {
  role: 'user' | 'assistant'
  content: string
}

export async function POST(request: Request) {
  const startTime = performance.now()

  try {
    Sentry.logger.info("Chat API request received")
    Sentry.metrics.count("chat.api.request", 1, {
      attributes: { endpoint: "/api/chat" }
    })

    const { messages } = await request.json() as { messages: MessageInput[] }

    if (!messages || !Array.isArray(messages)) {
      Sentry.logger.warn("Invalid request: messages array missing", {
        hasMessages: !!messages,
        isArray: Array.isArray(messages)
      })
      Sentry.metrics.count("chat.api.validation_error", 1, {
        attributes: { reason: "missing_messages" }
      })
      return new Response(
        JSON.stringify({ error: 'Messages array is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Get the last user message
    const lastUserMessage = messages.filter(m => m.role === 'user').pop()
    if (!lastUserMessage) {
      Sentry.logger.warn("Invalid request: no user message found", {
        messageCount: messages.length
      })
      Sentry.metrics.count("chat.api.validation_error", 1, {
        attributes: { reason: "no_user_message" }
      })
      return new Response(
        JSON.stringify({ error: 'No user message found' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    Sentry.logger.info("Processing chat request", {
      messageCount: messages.length,
      userMessageLength: lastUserMessage.content.length
    })
    Sentry.metrics.gauge("chat.conversation.message_count", messages.length, {
      unit: "none"
    })

    // Build conversation context
    const conversationContext = messages
      .slice(0, -1) // Exclude the last message since we pass it as the prompt
      .map((m: MessageInput) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n')

    const fullPrompt = conversationContext
      ? `${SYSTEM_PROMPT}\n\nPrevious conversation:\n${conversationContext}\n\nUser: ${lastUserMessage.content}`
      : `${SYSTEM_PROMPT}\n\nUser: ${lastUserMessage.content}`

    // Create a streaming response
    const encoder = new TextEncoder()
    let toolUseCount = 0
    let streamStartTime = performance.now()

    const stream = new ReadableStream({
      async start(controller) {
        try {
          Sentry.logger.info("Starting Claude query stream")

          // Use the claude-agent-sdk query function with all default tools enabled
          for await (const message of query({
            prompt: fullPrompt,
            options: {
              maxTurns: 10,
              // Use the preset to enable all Claude Code tools including WebSearch
              tools: { type: 'preset', preset: 'claude_code' },
              // Bypass all permission checks for automated tool execution
              permissionMode: 'bypassPermissions',
              allowDangerouslySkipPermissions: true,
              // Enable partial messages for real-time text streaming
              includePartialMessages: true,
              // Set working directory to the app's directory for sandboxing
              cwd: process.cwd(),
            }
          })) {
            // Handle streaming text deltas (partial messages)
            if (message.type === 'stream_event' && 'event' in message) {
              const event = message.event
              // Handle content block delta events for text streaming
              if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: 'text_delta', text: event.delta.text })}\n\n`
                ))
              }
            }

            // Send tool start events from assistant messages
            if (message.type === 'assistant' && 'message' in message) {
              const content = message.message?.content
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'tool_use') {
                    toolUseCount++
                    Sentry.logger.info("Tool invoked during chat", {
                      toolName: block.name
                    })
                    Sentry.metrics.count("chat.tool.invoked", 1, {
                      attributes: { tool_name: block.name }
                    })
                    controller.enqueue(encoder.encode(
                      `data: ${JSON.stringify({ type: 'tool_start', tool: block.name })}\n\n`
                    ))
                  }
                }
              }
            }

            // Send tool progress updates
            if (message.type === 'tool_progress') {
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: 'tool_progress', tool: message.tool_name, elapsed: message.elapsed_time_seconds })}\n\n`
              ))
            }

            // Signal completion
            if (message.type === 'result' && message.subtype === 'success') {
              const streamDuration = performance.now() - streamStartTime
              Sentry.logger.info("Chat query completed successfully", {
                durationMs: streamDuration,
                toolsUsed: toolUseCount
              })
              Sentry.metrics.distribution("chat.stream.duration", streamDuration, {
                unit: "millisecond",
                attributes: { status: "success" }
              })
              Sentry.metrics.gauge("chat.stream.tools_used", toolUseCount, {
                unit: "none"
              })
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: 'done' })}\n\n`
              ))
            }

            // Handle errors
            if (message.type === 'result' && message.subtype !== 'success') {
              const streamDuration = performance.now() - streamStartTime
              Sentry.logger.error("Chat query failed", {
                durationMs: streamDuration,
                subtype: message.subtype
              })
              Sentry.metrics.distribution("chat.stream.duration", streamDuration, {
                unit: "millisecond",
                attributes: { status: "error" }
              })
              Sentry.metrics.count("chat.stream.error", 1)
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: 'error', message: 'Query did not complete successfully' })}\n\n`
              ))
            }
          }

          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()

          const totalDuration = performance.now() - startTime
          Sentry.metrics.distribution("chat.api.duration", totalDuration, {
            unit: "millisecond",
            attributes: { status: "success" }
          })
        } catch (error) {
          console.error('Stream error:', error)
          Sentry.logger.error("Stream error occurred", {
            error: error instanceof Error ? error.message : 'Unknown error'
          })
          Sentry.metrics.count("chat.stream.exception", 1)
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ type: 'error', message: 'Stream error occurred' })}\n\n`
          ))
          controller.close()
        }
      }
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  } catch (error) {
    console.error('Chat API error:', error)
    const totalDuration = performance.now() - startTime

    Sentry.logger.error("Chat API error", {
      error: error instanceof Error ? error.message : 'Unknown error',
      durationMs: totalDuration
    })
    Sentry.metrics.count("chat.api.error", 1)
    Sentry.metrics.distribution("chat.api.duration", totalDuration, {
      unit: "millisecond",
      attributes: { status: "error" }
    })

    return new Response(
      JSON.stringify({ error: 'Failed to process chat request. Check server logs for details.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}
