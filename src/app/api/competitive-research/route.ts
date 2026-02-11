import { query } from '@anthropic-ai/claude-agent-sdk'
import * as Sentry from '@sentry/nextjs'

const SYSTEM_PROMPT = `You are a competitive intelligence researcher specializing in application monitoring and error tracking platforms.

Your role is to help analyze Sentry's position in the market by researching and comparing it with competitors like:
- Datadog APM & Error Tracking
- New Relic
- Rollbar
- Bugsnag
- LogRocket
- Raygun
- AppDynamics
- Dynatrace

Key research areas:
- Feature comparisons (error tracking, performance monitoring, session replay, etc.)
- Pricing models and cost analysis
- Developer experience and integrations
- Market positioning and target customers
- Recent product updates and roadmap direction
- Customer reviews and sentiment
- Technical capabilities and limitations

Guidelines:
- Always use web search to get current, accurate information about competitors
- Provide balanced, factual comparisons without being overly promotional
- Include specific data points, pricing, and feature details when available
- Highlight Sentry's strengths AND areas where competitors may have advantages
- Structure responses with clear sections and markdown formatting
- Cite sources when making claims about competitors
- Focus on objective analysis rather than marketing language

When comparing products, consider:
1. Core features and capabilities
2. Ease of integration and setup
3. Pricing and value proposition
4. Platform and language support
5. Performance and reliability
6. Community and ecosystem
7. Recent innovations and updates`

interface MessageInput {
  role: 'user' | 'assistant'
  content: string
}

export async function POST(request: Request) {
  const startTime = performance.now()

  try {
    Sentry.logger.info("Competitive Research API request received")
    Sentry.metrics.count("competitive_research.api.request", 1, {
      attributes: { endpoint: "/api/competitive-research" }
    })

    const { messages } = await request.json() as { messages: MessageInput[] }

    if (!messages || !Array.isArray(messages)) {
      Sentry.logger.warn("Invalid request: messages array missing", {
        hasMessages: !!messages,
        isArray: Array.isArray(messages)
      })
      Sentry.metrics.count("competitive_research.api.validation_error", 1, {
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
      Sentry.metrics.count("competitive_research.api.validation_error", 1, {
        attributes: { reason: "no_user_message" }
      })
      return new Response(
        JSON.stringify({ error: 'No user message found' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    Sentry.logger.info("Processing competitive research request", {
      messageCount: messages.length,
      userMessageLength: lastUserMessage.content.length
    })
    Sentry.metrics.gauge("competitive_research.conversation.message_count", messages.length, {
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
          Sentry.logger.info("Starting competitive research Claude query stream")

          // Use the claude-agent-sdk query function with all default tools enabled
          for await (const message of query({
            prompt: fullPrompt,
            options: {
              maxTurns: 15, // Allow more turns for research tasks
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
                    Sentry.logger.info("Tool invoked during competitive research", {
                      toolName: block.name
                    })
                    Sentry.metrics.count("competitive_research.tool.invoked", 1, {
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
              Sentry.logger.info("Competitive research query completed successfully", {
                durationMs: streamDuration,
                toolsUsed: toolUseCount
              })
              Sentry.metrics.distribution("competitive_research.stream.duration", streamDuration, {
                unit: "millisecond",
                attributes: { status: "success" }
              })
              Sentry.metrics.gauge("competitive_research.stream.tools_used", toolUseCount, {
                unit: "none"
              })
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: 'done' })}\n\n`
              ))
            }

            // Handle errors
            if (message.type === 'result' && message.subtype !== 'success') {
              const streamDuration = performance.now() - streamStartTime
              Sentry.logger.error("Competitive research query failed", {
                durationMs: streamDuration,
                subtype: message.subtype
              })
              Sentry.metrics.distribution("competitive_research.stream.duration", streamDuration, {
                unit: "millisecond",
                attributes: { status: "error" }
              })
              Sentry.metrics.count("competitive_research.stream.error", 1)
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: 'error', message: 'Query did not complete successfully' })}\n\n`
              ))
            }
          }

          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()

          const totalDuration = performance.now() - startTime
          Sentry.metrics.distribution("competitive_research.api.duration", totalDuration, {
            unit: "millisecond",
            attributes: { status: "success" }
          })
        } catch (error) {
          console.error('Stream error:', error)
          Sentry.logger.error("Competitive research stream error occurred", {
            error: error instanceof Error ? error.message : 'Unknown error'
          })
          Sentry.metrics.count("competitive_research.stream.exception", 1)
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
    console.error('Competitive Research API error:', error)
    const totalDuration = performance.now() - startTime

    Sentry.logger.error("Competitive Research API error", {
      error: error instanceof Error ? error.message : 'Unknown error',
      durationMs: totalDuration
    })
    Sentry.metrics.count("competitive_research.api.error", 1)
    Sentry.metrics.distribution("competitive_research.api.duration", totalDuration, {
      unit: "millisecond",
      attributes: { status: "error" }
    })

    return new Response(
      JSON.stringify({ error: 'Failed to process competitive research request. Check server logs for details.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}
