// The Vercel function: api/server.js's request handler, bundled by scripts/vercel/build.mjs.
// Imported, server.js does not listen; the platform calls the handler with node's own req/res.
//
// /api/mcp is the MCP server's HTTP endpoint (mcp/src/http.js), served from the same function so
// a client connects to the app's own address (docs/MCP_CLAUDE_CODE.md). It is a client of the api
// like the phone app: every read and write it makes goes back through the routes below, with the
// caller's own token, to ORIGIN.
import { handler as api } from '../../api/server.js';

let mcp = null;
const mcpHandler = async () => {
  if (!mcp) {
    const { createHandler } = await import('../../mcp/src/http.js');
    mcp = createHandler({ base: (process.env.ORIGIN || '').replace(/\/+$/, '') });
  }
  return mcp;
};

export default async function handler(req, res) {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/api/mcp' || p === '/api/mcp/') {
    if (!process.env.ORIGIN) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'ORIGIN is not set: the MCP endpoint needs the app\'s public address' }));
    }
    return (await mcpHandler())(req, res);
  }
  return api(req, res);
}
