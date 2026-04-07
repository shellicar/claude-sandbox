/**
 * MITM proxy v2: intercepts queries to api.anthropic.com,
 * parses the Anthropic Messages API structure, and appends readable
 * markdown into request.md and response.md.
 *
 * Usage: ANTHROPIC_BASE_URL=http://localhost:18899 claude -p "prompt"
 * Output: request.md (appended per turn), response.md (appended per turn)
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 18899;
const TARGET = 'api.anthropic.com';
const OUTPUT_DIR = process.env.MITM_OUTPUT_DIR || '.';

const REQUEST_FILE = path.join(OUTPUT_DIR, 'request.md');
const RESPONSE_FILE = path.join(OUTPUT_DIR, 'response.md');

let queryCount = 0;

function appendToFile(filepath, content) {
  fs.appendFileSync(filepath, content + '\n');
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (block.type === 'text') return block.text;
        if (block.type === 'tool_use') return `[Tool Use: ${block.name}]\n\`\`\`json\n${JSON.stringify(block.input, null, 2)}\n\`\`\``;
        if (block.type === 'tool_result') {
          const resultContent = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map(c => c.type === 'text' ? c.text : `[${c.type}]`).join('\n')
              : '[empty]';
          return `[Tool Result: ${block.tool_use_id}]\n${resultContent}`;
        }
        if (block.type === 'image') return `[Image: ${block.source?.media_type || 'unknown'}]`;
        if (block.type === 'thinking') return `<thinking>\n${block.thinking}\n</thinking>`;
        return `[${block.type}]`;
      })
      .join('\n\n');
  }
  return String(content);
}

function splitSystemSections(text) {
  const sections = [];
  let current = { title: 'Preamble', content: '' };

  const lines = text.split('\n');
  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,3})\s+(.+)/);
    const xmlMatch = line.match(/^<([a-zA-Z_-]+)>$/);

    if (headerMatch) {
      if (current.content.trim()) {
        sections.push(current);
      }
      current = { title: headerMatch[2], content: '', level: headerMatch[1].length };
    } else if (xmlMatch) {
      if (current.content.trim()) {
        sections.push(current);
      }
      current = { title: `<${xmlMatch[1]}>`, content: '', level: 2 };
    } else {
      current.content += line + '\n';
    }
  }
  if (current.content.trim()) {
    sections.push(current);
  }

  return sections;
}

function buildRequestMarkdown(body, queryNum) {
  const lines = [];
  const ts = new Date().toISOString();

  lines.push(`# Turn ${queryNum}`);
  lines.push(`> Captured: ${ts}`);
  lines.push(`> Model: ${body.model || 'unknown'}`);
  lines.push(`> Max tokens: ${body.max_tokens || 'default'}`);

  if (body.temperature !== undefined) lines.push(`> Temperature: ${body.temperature}`);
  if (body.top_p !== undefined) lines.push(`> Top-p: ${body.top_p}`);
  if (body.metadata) lines.push(`> Metadata: \`${JSON.stringify(body.metadata)}\``);
  if (body._betas) lines.push(`> Betas: ${body._betas}`);

  lines.push('');

  // --- System prompt ---
  if (body.system) {
    lines.push('## System Prompt');
    lines.push('');

    const systemBlocks = Array.isArray(body.system) ? body.system : [{ type: 'text', text: body.system }];

    for (const [i, block] of systemBlocks.entries()) {
      const text = block.text || block.content || '';
      const cacheControl = block.cache_control ? ` [cache: ${block.cache_control.type}]` : '';
      const sections = splitSystemSections(text);

      if (sections.length <= 1) {
        lines.push(`### System Block ${i + 1}${cacheControl}`);
        lines.push('');
        lines.push(text);
        lines.push('');
      } else {
        lines.push(`### System Block ${i + 1}${cacheControl}`);
        lines.push('');
        for (const section of sections) {
          const level = (section.level || 2) + 2;
          const prefix = '#'.repeat(Math.min(level + 1, 6));
          lines.push(`${prefix} ${section.title}`);
          lines.push('');
          lines.push(section.content.trimEnd());
          lines.push('');
        }
      }
    }
  }

  // --- Tools ---
  if (body.tools && body.tools.length > 0) {
    lines.push('## Tools');
    lines.push('');
    lines.push(`${body.tools.length} tools registered:`);
    lines.push('');
    for (const tool of body.tools) {
      const desc = tool.description ? ` -- ${tool.description.slice(0, 100)}${tool.description.length > 100 ? '...' : ''}` : '';
      lines.push(`- **${tool.name}**${desc}`);
    }
    lines.push('');
  }

  // --- Messages ---
  if (body.messages && body.messages.length > 0) {
    lines.push('## Messages');
    lines.push('');
    lines.push(`${body.messages.length} messages in conversation:`);
    lines.push('');

    for (const [i, msg] of body.messages.entries()) {
      const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
      const cacheControl = msg.cache_control ? ` [cache: ${msg.cache_control.type}]` : '';
      lines.push(`### ${i + 1}. ${role}${cacheControl}`);
      lines.push('');

      const text = extractTextContent(msg.content);
      lines.push(text);
      lines.push('');
    }
  }

  // --- Context management ---
  if (body.context_management) {
    lines.push('## Context Management');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(body.context_management, null, 2));
    lines.push('```');
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  return lines.join('\n');
}

function buildResponseMarkdown(responseBody, queryNum, statusCode, headers) {
  const lines = [];
  const ts = new Date().toISOString();

  lines.push(`# Turn ${queryNum} Response`);
  lines.push(`> Captured: ${ts}`);
  lines.push(`> Status: ${statusCode}`);

  // Anthropic-specific headers
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith('anthropic') || k.startsWith('unified-') || k === 'x-should-retry' || k === 'retry-after' || k === 'request-id') {
      lines.push(`> ${k}: ${v}`);
    }
  }

  lines.push('');

  if (responseBody) {
    try {
      const parsed = JSON.parse(responseBody);

      lines.push(`> Model: ${parsed.model || 'unknown'}`);
      lines.push(`> Stop reason: ${parsed.stop_reason || 'unknown'}`);

      // Usage
      if (parsed.usage) {
        const u = parsed.usage;
        lines.push(`> Tokens: input=${u.input_tokens || 0}, output=${u.output_tokens || 0}, cache_read=${u.cache_read_input_tokens || 0}, cache_creation=${u.cache_creation_input_tokens || 0}`);
      }

      lines.push('');

      // Content blocks
      if (parsed.content && parsed.content.length > 0) {
        lines.push('## Response Content');
        lines.push('');

        for (const block of parsed.content) {
          if (block.type === 'text') {
            lines.push(block.text);
          } else if (block.type === 'tool_use') {
            lines.push(`**[Tool Use: ${block.name}]**`);
            lines.push('```json');
            lines.push(JSON.stringify(block.input, null, 2));
            lines.push('```');
          } else if (block.type === 'thinking') {
            lines.push('<details><summary>Thinking</summary>');
            lines.push('');
            lines.push(block.thinking || '[empty]');
            lines.push('');
            lines.push('</details>');
          } else {
            lines.push(`[${block.type}]`);
          }
          lines.push('');
        }
      }
    } catch {
      // Non-JSON response (streaming SSE or error)
      lines.push('```');
      lines.push(responseBody);
      lines.push('```');
    }
  }

  lines.push('---');
  lines.push('');

  return lines.join('\n');
}

// Clear files on startup
fs.writeFileSync(REQUEST_FILE, '');
fs.writeFileSync(RESPONSE_FILE, '');

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const isMessages = req.method === 'POST' && req.url.startsWith('/v1/messages');

    // Write request
    if (isMessages && body) {
      try {
        queryCount++;
        const parsed = JSON.parse(body);

        const betaHeader = req.headers['anthropic-beta'];
        if (betaHeader) parsed._betas = betaHeader;

        const md = buildRequestMarkdown(parsed, queryCount);
        appendToFile(REQUEST_FILE, md);
        console.log(`# Turn ${queryCount} request appended (${parsed.messages?.length || 0} messages, ${parsed.system ? 'has system' : 'no system'})`);
      } catch (e) {
        console.error('# Parse error:', e.message);
      }
    }

    // Forward to real API and capture response
    const fwdReq = https.request({
      hostname: TARGET,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: TARGET,
      },
    }, (fwdRes) => {
      console.log(`# Response: ${fwdRes.statusCode} ${req.method} ${req.url}`);

      // For non-streaming responses, capture the full body
      // For streaming (SSE), just note it
      const isStreaming = fwdRes.headers['content-type']?.includes('text/event-stream');

      if (isMessages && !isStreaming) {
        let responseBody = '';
        fwdRes.on('data', chunk => responseBody += chunk);
        fwdRes.on('end', () => {
          const md = buildResponseMarkdown(responseBody, queryCount, fwdRes.statusCode, fwdRes.headers);
          appendToFile(RESPONSE_FILE, md);
          console.log(`# Turn ${queryCount} response appended`);
        });
      }

      if (isMessages && isStreaming) {
        // For streaming, just note it in response.md
        const lines = [
          `# Turn ${queryCount} Response`,
          `> Captured: ${new Date().toISOString()}`,
          `> Status: ${fwdRes.statusCode}`,
          `> Streaming: SSE (content streamed to client, not captured here)`,
          '',
        ];
        // Still capture headers
        for (const [k, v] of Object.entries(fwdRes.headers)) {
          if (k.startsWith('anthropic') || k.startsWith('unified-') || k === 'x-should-retry' || k === 'request-id') {
            lines.push(`> ${k}: ${v}`);
          }
        }
        lines.push('');
        lines.push('---');
        lines.push('');
        appendToFile(RESPONSE_FILE, lines.join('\n'));
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
  console.log(`# MITM-MD proxy on :${PORT}`);
  console.log(`# Output: ${path.resolve(REQUEST_FILE)} / ${path.resolve(RESPONSE_FILE)}`);
  console.log(`# Files cleared on startup, appended per turn`);
  console.log(`# Usage: ANTHROPIC_BASE_URL=http://localhost:${PORT} claude -p "prompt"`);
});
