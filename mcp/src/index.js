#!/usr/bin/env node
/* openGym MCP server — stdio transport. The LLM client (Claude Desktop, Claude Code, Cursor, …)
   spawns this process locally, talks JSON-RPC over stdin/stdout, tears it down when the session
   ends. No extra container. With a data directory the read tools make no network call; with
   OPENGYM_URL alone (server mode, state.js) they read through your own openGym server, and the
   write tools always do — it talks to that server and nothing else. The same tools are served
   over HTTP by http.js. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { buildServer } from './server.js'
import { init, getUser, refresh, remoteMode } from './state.js'

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

const server = buildServer()
const transport = new StdioServerTransport()
await server.connect(transport)
// Process stays alive serving JSON-RPC over stdio until the LLM client disconnects.
