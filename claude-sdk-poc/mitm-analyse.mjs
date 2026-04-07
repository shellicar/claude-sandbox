#!/usr/bin/env node
/**
 * MITM JSONL Analyser
 *
 * Reads requests.jsonl and responses.jsonl from the MITM proxy,
 * produces a detailed analysis of what's happening per turn.
 *
 * Usage: node mitm-analyse.mjs [directory]
 *   directory defaults to current dir
 *
 * Looks for requests.jsonl and responses.jsonl in the given directory.
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || '.';
const requestsFile = path.join(dir, 'requests.jsonl');
const responsesFile = path.join(dir, 'responses.jsonl');

function readJsonl(filepath) {
  if (!fs.existsSync(filepath)) return [];
  return fs.readFileSync(filepath, 'utf-8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
}

function countTokensInContent(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum, block) => {
      if (block.type === 'text') return sum + (block.text?.length || 0);
      if (block.type === 'tool_use') return sum + JSON.stringify(block.input).length;
      if (block.type === 'tool_result') {
        if (typeof block.content === 'string') return sum + block.content.length;
        if (Array.isArray(block.content)) return sum + block.content.reduce((s, c) => s + (c.text?.length || 0), 0);
      }
      if (block.type === 'thinking') return sum + (block.thinking?.length || 0);
      return sum + JSON.stringify(block).length;
    }, 0);
  }
  return JSON.stringify(content).length;
}

function findCacheControlPoints(body) {
  const points = [];

  // System prompt cache_control
  if (body.system) {
    const blocks = Array.isArray(body.system) ? body.system : [body.system];
    blocks.forEach((block, i) => {
      if (block.cache_control) {
        points.push({ location: `system[${i}]`, type: block.cache_control.type });
      }
    });
  }

  // Tool cache_control
  if (body.tools) {
    body.tools.forEach((tool, i) => {
      if (tool.cache_control) {
        points.push({ location: `tools[${i}] (${tool.name})`, type: tool.cache_control.type });
      }
    });
  }

  // Message cache_control
  if (body.messages) {
    body.messages.forEach((msg, i) => {
      if (msg.cache_control) {
        points.push({ location: `messages[${i}] (${msg.role})`, type: msg.cache_control.type });
      }
      // Also check content blocks
      if (Array.isArray(msg.content)) {
        msg.content.forEach((block, j) => {
          if (block.cache_control) {
            points.push({ location: `messages[${i}].content[${j}] (${block.type})`, type: block.cache_control.type });
          }
        });
      }
    });
  }

  return points;
}

function extractToolCalls(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(b => b.type === 'tool_use')
    .map(b => ({ name: b.name, inputSize: JSON.stringify(b.input).length }));
}

function extractToolResults(messages) {
  const results = [];
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        const size = typeof block.content === 'string'
          ? block.content.length
          : Array.isArray(block.content)
            ? block.content.reduce((s, c) => s + (c.text?.length || 0), 0)
            : 0;
        results.push({ tool_use_id: block.tool_use_id, size, is_error: block.is_error || false });
      }
    }
  }
  return results;
}

// Pricing (Claude Opus 4.6 / Sonnet 4.5)
const PRICING = {
  'claude-opus-4-6': { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  'claude-haiku-4-5': { input: 0.80, output: 4, cache_read: 0.08, cache_write: 1 },
};

function getPricing(model) {
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (model?.includes(key)) return pricing;
  }
  // Default to sonnet
  return PRICING['claude-sonnet-4-5'];
}

function calculateCost(usage, pricing) {
  if (!usage) return 0;
  const input = ((usage.input_tokens || 0) / 1_000_000) * pricing.input;
  const output = ((usage.output_tokens || 0) / 1_000_000) * pricing.output;
  const cacheRead = ((usage.cache_read_input_tokens || 0) / 1_000_000) * pricing.cache_read;
  const cacheWrite = ((usage.cache_creation_input_tokens || 0) / 1_000_000) * pricing.cache_write;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function formatBytes(chars) {
  if (chars < 1024) return `${chars} chars`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)}k chars`;
  return `${(chars / (1024 * 1024)).toFixed(1)}M chars`;
}

// --- Main ---

const requests = readJsonl(requestsFile);
const responses = readJsonl(responsesFile);

if (requests.length === 0 && responses.length === 0) {
  console.log('No data found. Run the MITM proxy first.');
  process.exit(1);
}

console.log('='.repeat(80));
console.log('MITM JSONL Analysis');
console.log('='.repeat(80));
console.log(`Requests: ${requests.length} turns`);
console.log(`Responses: ${responses.length} turns`);
console.log('');

// Index responses by turn
const responseByTurn = {};
for (const r of responses) {
  responseByTurn[r.turn] = r;
}

let totalCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
let totalTokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
const toolCallCounts = {};
let totalParallelBatches = 0;
let totalToolCalls = 0;

for (const req of requests) {
  const turn = req.turn;
  const body = req.body;
  const resp = responseByTurn[turn];
  const respBody = resp?.body;

  console.log('-'.repeat(80));
  console.log(`TURN ${turn}  (${req.timestamp})`);
  console.log('-'.repeat(80));

  // Model
  console.log(`Model: ${body.model || 'unknown'}`);

  // Message count
  const msgCount = body.messages?.length || 0;
  console.log(`Messages in context: ${msgCount}`);

  // System prompt
  if (body.system) {
    const sysBlocks = Array.isArray(body.system) ? body.system : [{ text: body.system }];
    const sysSize = sysBlocks.reduce((s, b) => s + (b.text?.length || 0), 0);
    console.log(`System prompt: ${sysBlocks.length} block(s), ${formatBytes(sysSize)}`);
  }

  // Tools
  if (body.tools?.length) {
    const toolSchemaSize = JSON.stringify(body.tools).length;
    console.log(`Tools: ${body.tools.length} registered, ${formatBytes(toolSchemaSize)} total schema`);
  }

  // Cache control points
  const cachePoints = findCacheControlPoints(body);
  if (cachePoints.length > 0) {
    console.log(`Cache control breakpoints:`);
    for (const cp of cachePoints) {
      console.log(`  - ${cp.location} [${cp.type}]`);
    }
  } else {
    console.log(`Cache control breakpoints: NONE`);
  }

  // Message size breakdown
  if (body.messages?.length) {
    const userMsgs = body.messages.filter(m => m.role === 'user');
    const assistantMsgs = body.messages.filter(m => m.role === 'assistant');

    const userSize = userMsgs.reduce((s, m) => s + countTokensInContent(m.content), 0);
    const assistantSize = assistantMsgs.reduce((s, m) => s + countTokensInContent(m.content), 0);
    console.log(`Message sizes: user=${formatBytes(userSize)}, assistant=${formatBytes(assistantSize)}`);

    // Tool results in this turn's messages
    const toolResults = extractToolResults(body.messages);
    if (toolResults.length > 0) {
      const bigResults = toolResults.filter(r => r.size > 5000).sort((a, b) => b.size - a.size);
      if (bigResults.length > 0) {
        console.log(`Large tool results (>5k chars):`);
        for (const r of bigResults) {
          console.log(`  - ${r.tool_use_id}: ${formatBytes(r.size)}${r.is_error ? ' [ERROR]' : ''}`);
        }
      }
    }
  }

  // Context management
  if (body.context_management) {
    console.log(`Context management: ${JSON.stringify(body.context_management)}`);
  }

  // Response analysis
  if (respBody && typeof respBody === 'object') {
    const usage = respBody.usage;
    if (usage) {
      console.log('');
      console.log(`Tokens: input=${usage.input_tokens || 0}, output=${usage.output_tokens || 0}, cache_read=${usage.cache_read_input_tokens || 0}, cache_write=${usage.cache_creation_input_tokens || 0}`);

      const cacheTotal = (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      const cacheReadPct = cacheTotal > 0 ? ((usage.cache_read_input_tokens || 0) / cacheTotal * 100).toFixed(1) : '0';
      console.log(`Cache hit ratio: ${cacheReadPct}% reads`);

      const pricing = getPricing(body.model);
      const cost = calculateCost(usage, pricing);
      console.log(`Cost: $${cost.total.toFixed(4)} (input=$${cost.input.toFixed(4)}, output=$${cost.output.toFixed(4)}, cache_read=$${cost.cacheRead.toFixed(4)}, cache_write=$${cost.cacheWrite.toFixed(4)})`);

      totalCost.input += cost.input;
      totalCost.output += cost.output;
      totalCost.cacheRead += cost.cacheRead;
      totalCost.cacheWrite += cost.cacheWrite;
      totalCost.total += cost.total;

      totalTokens.input += (usage.input_tokens || 0);
      totalTokens.output += (usage.output_tokens || 0);
      totalTokens.cache_read += (usage.cache_read_input_tokens || 0);
      totalTokens.cache_write += (usage.cache_creation_input_tokens || 0);
    }

    // Tool calls in response
    if (respBody.content) {
      const toolCalls = extractToolCalls(respBody.content);
      if (toolCalls.length > 0) {
        console.log(`Tool calls: ${toolCalls.length}${toolCalls.length > 1 ? ' (PARALLEL)' : ''}`);
        for (const tc of toolCalls) {
          console.log(`  - ${tc.name} (input: ${formatBytes(tc.inputSize)})`);
          toolCallCounts[tc.name] = (toolCallCounts[tc.name] || 0) + 1;
        }
        totalToolCalls += toolCalls.length;
        totalParallelBatches++;
      }
    }

    console.log(`Stop reason: ${respBody.stop_reason || 'unknown'}`);
  }

  console.log('');
}

// --- Summary ---
console.log('='.repeat(80));
console.log('SESSION SUMMARY');
console.log('='.repeat(80));
console.log(`Total turns: ${requests.length}`);
console.log(`Total tool calls: ${totalToolCalls} across ${totalParallelBatches} batches (avg ${totalParallelBatches > 0 ? (totalToolCalls / totalParallelBatches).toFixed(1) : 0} per batch)`);
console.log('');

console.log('Token totals:');
console.log(`  Input:       ${totalTokens.input.toLocaleString()}`);
console.log(`  Output:      ${totalTokens.output.toLocaleString()}`);
console.log(`  Cache read:  ${totalTokens.cache_read.toLocaleString()}`);
console.log(`  Cache write: ${totalTokens.cache_write.toLocaleString()}`);
const totalCacheTokens = totalTokens.cache_read + totalTokens.cache_write;
const overallCacheHit = totalCacheTokens > 0 ? (totalTokens.cache_read / totalCacheTokens * 100).toFixed(1) : '0';
console.log(`  Cache hit ratio: ${overallCacheHit}%`);
console.log('');

console.log('Cost breakdown:');
console.log(`  Input:       $${totalCost.input.toFixed(4)}`);
console.log(`  Output:      $${totalCost.output.toFixed(4)}`);
console.log(`  Cache read:  $${totalCost.cacheRead.toFixed(4)}`);
console.log(`  Cache write: $${totalCost.cacheWrite.toFixed(4)}`);
console.log(`  TOTAL:       $${totalCost.total.toFixed(4)}`);
console.log('');

if (Object.keys(toolCallCounts).length > 0) {
  console.log('Tool usage:');
  const sorted = Object.entries(toolCallCounts).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sorted) {
    console.log(`  ${name}: ${count}`);
  }
  console.log('');
}

console.log(`Avg cost per turn: $${requests.length > 0 ? (totalCost.total / requests.length).toFixed(4) : '0'}`);
