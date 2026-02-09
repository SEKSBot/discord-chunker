#!/usr/bin/env node
/**
 * discord-chunker - Token estimation and conversation-aware chunking for Discord channels
 * 
 * Usage:
 *   discord-chunker estimate <channel-id> [--limit N]
 *   discord-chunker chunk <channel-id> --by-time <duration>      # e.g., 1h, 1d, 1w
 *   discord-chunker chunk <channel-id> --by-tokens <max-tokens>  # e.g., 4000
 *   discord-chunker chunk <channel-id> --by-tokens <max-tokens> --gap-minutes <N>
 * 
 * Options:
 *   --limit N           Max messages to fetch (default: 100)
 *   --gap-minutes N     Minutes of silence that defines conversation boundary (default: 30)
 *   --format json|text  Output format (default: text)
 *   --before <id>       Fetch messages before this message ID
 *   --after <id>        Fetch messages after this message ID
 */

import { execSync } from 'child_process';
import { encoding_for_model } from 'tiktoken';

// Initialize tiktoken encoder (cl100k_base is used by GPT-4, Claude, etc.)
let encoder;
try {
  encoder = encoding_for_model('gpt-4');
} catch {
  // Fallback to simple estimation if tiktoken fails
  encoder = null;
}

// ============================================================================
// Token Counting
// ============================================================================

function countTokens(text) {
  if (!text) return 0;
  if (encoder) {
    try {
      return encoder.encode(text).length;
    } catch {
      // Fallback
    }
  }
  // Simple heuristic: ~4 chars per token for English
  return Math.ceil(text.length / 4);
}

function formatMessageForContext(msg) {
  const author = msg.author?.global_name || msg.author?.username || 'Unknown';
  const timestamp = new Date(msg.timestamp).toISOString();
  const content = msg.content || '';
  
  // Include attachments info
  const attachments = (msg.attachments || [])
    .map(a => `[Attachment: ${a.filename}]`)
    .join(' ');
  
  // Include embeds summary
  const embeds = (msg.embeds || [])
    .map(e => `[Embed: ${e.title || e.description?.slice(0, 50) || 'untitled'}]`)
    .join(' ');
  
  const extras = [attachments, embeds].filter(Boolean).join(' ');
  const fullContent = extras ? `${content} ${extras}` : content;
  
  return `[${timestamp}] ${author}: ${fullContent}`;
}

// ============================================================================
// Discord Message Fetching (via OpenClaw gateway)
// ============================================================================

async function fetchMessages(channelId, options = {}) {
  const { limit = 100, before, after } = options;
  
  // Discord API limits to 100 per request, so we need to paginate
  const perPage = Math.min(100, limit);
  let allMessages = [];
  let lastMessageId = before;
  let remaining = limit;
  
  while (remaining > 0) {
    const fetchCount = Math.min(perPage, remaining);
    let cmd = `openclaw message read --channel discord --target "${channelId}" --limit ${fetchCount} --json`;
    
    if (lastMessageId) cmd += ` --before "${lastMessageId}"`;
    if (after && !lastMessageId) cmd += ` --after "${after}"`;
    
    try {
      const result = execSync(cmd, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
      const parsed = JSON.parse(result);
      const messages = parsed.payload?.messages || parsed.messages || [];
      
      if (messages.length === 0) break;
      
      allMessages = allMessages.concat(messages);
      remaining -= messages.length;
      
      // Get the oldest message ID for pagination
      // Discord returns newest first, so last in array is oldest
      lastMessageId = messages[messages.length - 1].id;
      
      // If we got fewer messages than requested, we've hit the end
      if (messages.length < fetchCount) break;
      
      // Small delay to avoid rate limiting
      if (remaining > 0) {
        await new Promise(r => setTimeout(r, 100));
      }
    } catch (err) {
      console.error('Failed to fetch messages:', err.message);
      break;
    }
  }
  
  return allMessages;
}

// ============================================================================
// Conversation Detection
// ============================================================================

function detectConversationBreaks(messages, gapMinutes = 30) {
  if (messages.length === 0) return [];
  
  const breaks = [];
  const gapMs = gapMinutes * 60 * 1000;
  
  // Sort by timestamp (oldest first)
  const sorted = [...messages].sort((a, b) => 
    new Date(a.timestamp) - new Date(b.timestamp)
  );
  
  for (let i = 1; i < sorted.length; i++) {
    const prevTime = new Date(sorted[i - 1].timestamp).getTime();
    const currTime = new Date(sorted[i].timestamp).getTime();
    
    if (currTime - prevTime >= gapMs) {
      breaks.push({
        afterIndex: i - 1,
        beforeIndex: i,
        gapMinutes: Math.round((currTime - prevTime) / 60000),
        beforeMsg: sorted[i - 1].id,
        afterMsg: sorted[i].id,
      });
    }
  }
  
  return breaks;
}

// ============================================================================
// Chunking Functions
// ============================================================================

function chunkByTime(messages, duration) {
  // Parse duration (1h, 1d, 1w, etc.)
  const match = duration.match(/^(\d+)(m|h|d|w)$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${duration}. Use formats like 1h, 1d, 1w`);
  }
  
  const value = parseInt(match[1]);
  const unit = match[2];
  const multipliers = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  const periodMs = value * multipliers[unit];
  
  if (messages.length === 0) return [];
  
  // Sort oldest first
  const sorted = [...messages].sort((a, b) => 
    new Date(a.timestamp) - new Date(b.timestamp)
  );
  
  const chunks = [];
  let currentChunk = [];
  let chunkStart = new Date(sorted[0].timestamp).getTime();
  
  for (const msg of sorted) {
    const msgTime = new Date(msg.timestamp).getTime();
    
    if (msgTime - chunkStart >= periodMs && currentChunk.length > 0) {
      chunks.push({
        messages: currentChunk,
        startTime: new Date(chunkStart).toISOString(),
        endTime: new Date(currentChunk[currentChunk.length - 1].timestamp).toISOString(),
        tokenCount: currentChunk.reduce((sum, m) => sum + countTokens(formatMessageForContext(m)), 0),
      });
      currentChunk = [];
      chunkStart = msgTime;
    }
    
    currentChunk.push(msg);
  }
  
  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    chunks.push({
      messages: currentChunk,
      startTime: new Date(chunkStart).toISOString(),
      endTime: new Date(currentChunk[currentChunk.length - 1].timestamp).toISOString(),
      tokenCount: currentChunk.reduce((sum, m) => sum + countTokens(formatMessageForContext(m)), 0),
    });
  }
  
  return chunks;
}

function chunkByTokens(messages, maxTokens, gapMinutes = 30) {
  if (messages.length === 0) return [];
  
  // Sort oldest first
  const sorted = [...messages].sort((a, b) => 
    new Date(a.timestamp) - new Date(b.timestamp)
  );
  
  // Detect natural conversation breaks
  const breaks = detectConversationBreaks(sorted, gapMinutes);
  const breakIndices = new Set(breaks.map(b => b.beforeIndex));
  
  const chunks = [];
  let currentChunk = [];
  let currentTokens = 0;
  
  for (let i = 0; i < sorted.length; i++) {
    const msg = sorted[i];
    const msgText = formatMessageForContext(msg);
    const msgTokens = countTokens(msgText);
    
    // Check if adding this message would exceed limit
    const wouldExceed = currentTokens + msgTokens > maxTokens && currentChunk.length > 0;
    
    // Check if this is a natural break point
    const isNaturalBreak = breakIndices.has(i);
    
    // Start new chunk if: would exceed AND (at natural break OR significantly over)
    if (wouldExceed && (isNaturalBreak || currentTokens + msgTokens > maxTokens * 1.1)) {
      chunks.push({
        messages: currentChunk,
        startTime: new Date(currentChunk[0].timestamp).toISOString(),
        endTime: new Date(currentChunk[currentChunk.length - 1].timestamp).toISOString(),
        tokenCount: currentTokens,
        naturalBreak: isNaturalBreak,
      });
      currentChunk = [];
      currentTokens = 0;
    }
    
    currentChunk.push(msg);
    currentTokens += msgTokens;
  }
  
  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    chunks.push({
      messages: currentChunk,
      startTime: new Date(currentChunk[0].timestamp).toISOString(),
      endTime: new Date(currentChunk[currentChunk.length - 1].timestamp).toISOString(),
      tokenCount: currentTokens,
      naturalBreak: true,
    });
  }
  
  return chunks;
}

// ============================================================================
// Output Formatting
// ============================================================================

function formatChunkText(chunk, index, total) {
  const lines = [
    `═══════════════════════════════════════════════════════════════`,
    `CHUNK ${index + 1}/${total} | ${chunk.messages.length} messages | ~${chunk.tokenCount} tokens`,
    `Time: ${chunk.startTime} → ${chunk.endTime}`,
    `═══════════════════════════════════════════════════════════════`,
    '',
  ];
  
  for (const msg of chunk.messages) {
    lines.push(formatMessageForContext(msg));
  }
  
  lines.push('');
  return lines.join('\n');
}

function formatEstimateText(messages, totalTokens, byAuthor) {
  const lines = [
    `Discord Channel Token Estimate`,
    `══════════════════════════════`,
    `Total messages: ${messages.length}`,
    `Total tokens: ~${totalTokens}`,
    ``,
    `By Author:`,
  ];
  
  const sortedAuthors = Object.entries(byAuthor)
    .sort((a, b) => b[1].tokens - a[1].tokens);
  
  for (const [author, stats] of sortedAuthors) {
    const pct = ((stats.tokens / totalTokens) * 100).toFixed(1);
    lines.push(`  ${author}: ${stats.messages} msgs, ~${stats.tokens} tokens (${pct}%)`);
  }
  
  return lines.join('\n');
}

function getChunkContent(chunks, chunkIndex) {
  const chunk = chunks[chunkIndex];
  if (!chunk) return null;
  
  return chunk.messages.map(msg => formatMessageForContext(msg)).join('\n');
}

// ============================================================================
// Main CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
discord-chunker - Token estimation and conversation-aware chunking

COMMANDS:
  estimate <channel-id>       Estimate total tokens in channel
  chunk <channel-id>          Divide channel into chunks
  get-chunk <channel-id> <N>  Get content of chunk N (0-indexed)

OPTIONS:
  --limit N                 Max messages to fetch (default: 100)
  --by-time <duration>      Chunk by time period (e.g., 1h, 1d, 1w)
  --by-tokens <max>         Chunk by token count (e.g., 4000)
  --gap-minutes N           Conversation break threshold (default: 30)
  --format json|text        Output format (default: text)
  --summary-only            Only show chunk summaries, not content
  --before <msg-id>         Fetch messages before this ID
  --after <msg-id>          Fetch messages after this ID

EXAMPLES:
  discord-chunker estimate 1234567890 --limit 500
  discord-chunker chunk 1234567890 --by-time 1d --summary-only
  discord-chunker chunk 1234567890 --by-tokens 4000 --gap-minutes 15
  discord-chunker get-chunk 1234567890 0 --by-tokens 4000
`);
    process.exit(0);
  }
  
  const command = args[0];
  const channelId = args[1];
  
  if (!channelId) {
    console.error('Error: channel-id is required');
    process.exit(1);
  }
  
  // Parse options
  const options = {
    limit: 100,
    format: 'text',
    gapMinutes: 30,
    byTime: null,
    byTokens: null,
    before: null,
    after: null,
    summaryOnly: false,
    chunkIndex: null,
  };
  
  // For get-chunk command, third arg is the chunk index
  if (command === 'get-chunk' && args[2] && !args[2].startsWith('--')) {
    options.chunkIndex = parseInt(args[2]);
  }
  
  const startIdx = command === 'get-chunk' ? 3 : 2;
  for (let i = startIdx; i < args.length; i++) {
    switch (args[i]) {
      case '--limit':
        options.limit = parseInt(args[++i]);
        break;
      case '--format':
        options.format = args[++i];
        break;
      case '--gap-minutes':
        options.gapMinutes = parseInt(args[++i]);
        break;
      case '--by-time':
        options.byTime = args[++i];
        break;
      case '--by-tokens':
        options.byTokens = parseInt(args[++i]);
        break;
      case '--before':
        options.before = args[++i];
        break;
      case '--after':
        options.after = args[++i];
        break;
      case '--summary-only':
        options.summaryOnly = true;
        break;
    }
  }
  
  // Fetch messages
  console.error(`Fetching up to ${options.limit} messages from channel ${channelId}...`);
  const messages = await fetchMessages(channelId, options);
  console.error(`Fetched ${messages.length} messages`);
  
  if (messages.length === 0) {
    console.error('No messages found');
    process.exit(1);
  }
  
  // Execute command
  if (command === 'estimate') {
    let totalTokens = 0;
    const byAuthor = {};
    
    for (const msg of messages) {
      const text = formatMessageForContext(msg);
      const tokens = countTokens(text);
      totalTokens += tokens;
      
      const author = msg.author?.global_name || msg.author?.username || 'Unknown';
      if (!byAuthor[author]) {
        byAuthor[author] = { messages: 0, tokens: 0 };
      }
      byAuthor[author].messages++;
      byAuthor[author].tokens += tokens;
    }
    
    if (options.format === 'json') {
      console.log(JSON.stringify({
        channelId,
        messageCount: messages.length,
        totalTokens,
        byAuthor,
        oldestMessage: messages[messages.length - 1]?.timestamp,
        newestMessage: messages[0]?.timestamp,
      }, null, 2));
    } else {
      console.log(formatEstimateText(messages, totalTokens, byAuthor));
    }
    
  } else if (command === 'chunk' || command === 'get-chunk') {
    let chunks;
    
    if (options.byTime) {
      chunks = chunkByTime(messages, options.byTime);
    } else if (options.byTokens) {
      chunks = chunkByTokens(messages, options.byTokens, options.gapMinutes);
    } else {
      console.error('Error: must specify --by-time or --by-tokens');
      process.exit(1);
    }
    
    // Handle get-chunk command
    if (command === 'get-chunk') {
      if (options.chunkIndex === null || options.chunkIndex === undefined) {
        console.error('Error: chunk index required for get-chunk command');
        process.exit(1);
      }
      if (options.chunkIndex < 0 || options.chunkIndex >= chunks.length) {
        console.error(`Error: chunk index ${options.chunkIndex} out of range (0-${chunks.length - 1})`);
        process.exit(1);
      }
      
      const chunk = chunks[options.chunkIndex];
      if (options.format === 'json') {
        console.log(JSON.stringify({
          channelId,
          chunkIndex: options.chunkIndex,
          totalChunks: chunks.length,
          messageCount: chunk.messages.length,
          tokenCount: chunk.tokenCount,
          startTime: chunk.startTime,
          endTime: chunk.endTime,
          content: chunk.messages.map(m => formatMessageForContext(m)).join('\n'),
          messageIds: chunk.messages.map(m => m.id),
        }, null, 2));
      } else {
        console.log(formatChunkText(chunk, options.chunkIndex, chunks.length));
      }
      process.exit(0);
    }
    
    // Regular chunk command
    if (options.format === 'json') {
      console.log(JSON.stringify({
        channelId,
        totalMessages: messages.length,
        chunkCount: chunks.length,
        chunks: chunks.map((c, i) => ({
          index: i,
          messageCount: c.messages.length,
          tokenCount: c.tokenCount,
          startTime: c.startTime,
          endTime: c.endTime,
          naturalBreak: c.naturalBreak,
          messageIds: c.messages.map(m => m.id),
        })),
      }, null, 2));
    } else {
      // For text output, show chunk summaries first, then optionally content
      console.log(`\nChannel ${channelId}: ${messages.length} messages → ${chunks.length} chunks\n`);
      
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const breakNote = c.naturalBreak ? ' [natural break]' : '';
        console.log(`Chunk ${i + 1}: ${c.messages.length} msgs, ~${c.tokenCount} tokens${breakNote}`);
        console.log(`  Time: ${c.startTime.slice(0, 16)} → ${c.endTime.slice(0, 16)}`);
      }
      
      // Output full chunks to stdout for piping (unless --summary-only)
      if (!options.summaryOnly) {
        console.log('\n--- Full Chunks ---\n');
        for (let i = 0; i < chunks.length; i++) {
          console.log(formatChunkText(chunks[i], i, chunks.length));
        }
      }
    }
    
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
