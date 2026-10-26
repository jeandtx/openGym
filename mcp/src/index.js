#!/usr/bin/env node
/* openGym MCP server — stdio transport. The LLM client (Claude Desktop, Claude Code, Cursor, …)
   spawns this process locally, talks JSON-RPC over stdin/stdout, tears it down when the session
   ends. No extra container. With a data directory the read tools make no network call; with
   OPENGYM_URL alone (server mode, state.js) they read through your own openGym server, and the
   write tools always do — it talks to that server and nothing else. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { TOOLS } from './tools.js'
import { WRITE_TOOLS } from './write-tools.js'
import { PLAN_TOOLS } from './plan-tools.js'
import { REVIEW_TOOLS } from './review-tools.js'
import { init, getUser, refresh, remoteMode } from './state.js'

const server = new McpServer({
  name: 'opengym',
  version: '0.2.0'
})

// Fail fast on bad config so a misnamed OPENGYM_DATA doesn't silently answer every call with
// the no-state sentinel. Always register every tool so the LLM sees the full list at
// handshake, even when state didn't resolve.
try {
  if (remoteMode()) await refresh()
  else init()
  const u = getUser()
  console.error(`[opengym-mcp] serving profile ${u.name} (${u.id})${remoteMode() ? ' from ' + process.env.OPENGYM_URL : ''}`)
} catch (e) {
  console.error(`[opengym-mcp] ${e.message}`)
  // Don't exit — keep the tool listings up so the user sees a useful error after fixing their
  // env and restarting.
}

for (const t of [...TOOLS, ...REVIEW_TOOLS, ...WRITE_TOOLS, ...PLAN_TOOLS]) {
  server.tool(
    t.name,
    t.description,
    t.schema,
    async (params) => {
      try {
        // Server mode: the profile as the server has it now (one revision poll, the document
        // only when it moved), so an answer never lags a session logged on the phone.
        await refresh()
        // The write tools talk to the server, so a handler may answer with a promise.
        const result = await t.handler(params || {})
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        const code = err.code || 'ERROR'
        return {
          isError: true,
          content: [{ type: 'text', text: `${code}: ${err.message}` }]
        }
      }
    }
  )
}

const transport = new StdioServerTransport()
await server.connect(transport)
// Process stays alive serving JSON-RPC over stdio until the LLM client disconnects.
