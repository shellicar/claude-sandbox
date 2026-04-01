/**
 * MITM proxy: intercepts HTTPS requests to api.anthropic.com,
 * logs as curl commands, forwards to real API, returns response.
 */
import http from 'node:http';
import https from 'node:https';

const PORT = 18899;
const TARGET = 'api.anthropic.com';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    // Build curl command
    const parts = [`curl -X ${req.method} 'https://${TARGET}${req.url}'`];

    for (const [k, v] of Object.entries(req.headers)) {
      // Skip hop-by-hop and internal headers
      if (['host', 'connection', 'accept-encoding', 'content-length', 'transfer-encoding'].includes(k)) continue;
      // Redact auth token
      if (k === 'authorization') {
        parts.push(`  -H '${k}: ${String(v).substring(0, 30)}...'`);
      } else {
        parts.push(`  -H '${k}: ${v}'`);
      }
    }

    if (body) {
      // Escape single quotes in body for shell safety
      const escaped = body.replace(/'/g, "'\\''");
      parts.push(`  -d '${escaped}'`);
    }

    console.log('\n' + parts.join(' \\\n'));

    // Forward to real API
    const fwdReq = https.request({
      hostname: TARGET,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: TARGET,
      },
    }, (fwdRes) => {
      console.log(`\n# Response: ${fwdRes.statusCode}`);
      for (const [k, v] of Object.entries(fwdRes.headers)) {
        if (k.startsWith('anthropic') || k === 'x-should-retry' || k === 'retry-after') {
          console.log(`# ${k}: ${v}`);
        }
      }

      res.writeHead(fwdRes.statusCode, fwdRes.headers);
      fwdRes.pipe(res);
    });

    fwdReq.on('error', (e) => {
      console.error('# Forward error:', e.message);
      res.writeHead(502);
      res.end('Bad Gateway');
    });

    fwdReq.write(body);
    fwdReq.end();
  });
});

server.listen(PORT, () => {
  console.log(`# MITM proxy on :${PORT}`);
  console.log(`# Usage: ANTHROPIC_BASE_URL=http://localhost:${PORT} claude -p "prompt"`);
});
