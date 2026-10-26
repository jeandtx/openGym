/* The MCP server with every tool registered, transport-free. index.js connects it to stdio;
   http.js builds one per request for the endpoint the Vercel function serves at /api/mcp.

   Before each tool call the profile is brought up to date (state.js refresh: one revision poll
   in server mode, the document only when it moved, nothing in data-directory mode), and the
   write tools get `env` — the server's address and the token they write with. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { TOOLS } from './tools.js'
import { WRITE_TOOLS } from './write-tools.js'
import { PLAN_TOOLS } from './plan-tools.js'
import { REVIEW_TOOLS } from './review-tools.js'
import { refresh } from './state.js'

export const ALL_TOOLS = [...TOOLS, ...REVIEW_TOOLS, ...WRITE_TOOLS, ...PLAN_TOOLS]

/**
 * `env`: what the write tools and the refresh read (OPENGYM_URL, OPENGYM_TOKEN); process.env by
 * default. `fetchImpl` is for tests.
 */
export function buildServer({ env, fetchImpl } = {}) {
  const server = new McpServer({ name: 'opengym', version: '0.2.0' })
  const ctx = env || fetchImpl ? { ...(env ? { env } : {}), ...(fetchImpl ? { fetchImpl } : {}) } : undefined
  for (const t of ALL_TOOLS) {
    server.tool(
      t.name,
      t.description,
      t.schema,
      async (params) => {
        try {
          await refresh(ctx)
          // The write tools talk to the server, so a handler may answer with a promise.
          const result = await t.handler(params || {}, ctx)
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        } catch (err) {
          const code = err.code || 'ERROR'
          return { isError: true, content: [{ type: 'text', text: `${code}: ${err.message}` }] }
        }
      }
    )
  }
  return server
}
