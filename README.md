# discord-chunker

Token estimation and conversation-aware chunking for Discord channels.

## Purpose

Helps agents working with Discord channels to:
- Estimate token counts before processing
- Split large channels into manageable chunks that fit in context windows
- Preserve conversation boundaries (no cutting mid-thought)

## Installation

The tool is located at `~/tools/discord-chunker/` and symlinked to `~/.local/bin/discord-chunker`.

Requires:
- Node.js 18+
- OpenClaw gateway running
- `tiktoken` npm package (installed automatically)

## Commands

### estimate

Estimate total tokens in a channel:

```bash
discord-chunker estimate <channel-id> [--limit N]
```

Example:
```bash
discord-chunker estimate 1234567890123456789 --limit 500
```

Output:
```
Discord Channel Token Estimate
══════════════════════════════
Total messages: 500
Total tokens: ~45230

By Author:
  Alice: 200 msgs, ~18000 tokens (39.8%)
  Bob: 180 msgs, ~15230 tokens (33.7%)
  Charlie: 120 msgs, ~12000 tokens (26.5%)
```

### chunk

Divide a channel into chunks:

```bash
# By time periods
discord-chunker chunk <channel-id> --by-time <duration>

# By token count (conversation-aware)
discord-chunker chunk <channel-id> --by-tokens <max-tokens> [--gap-minutes N]
```

Durations: `1m`, `1h`, `1d`, `1w` (minutes, hours, days, weeks)

Examples:
```bash
# Chunk by day
discord-chunker chunk 1234567890123456789 --by-time 1d --summary-only

# Chunk to fit in 4000-token context windows
discord-chunker chunk 1234567890123456789 --by-tokens 4000 --gap-minutes 15

# Get JSON output for programmatic use
discord-chunker chunk 1234567890123456789 --by-tokens 4000 --format json
```

### read

Read recent messages (for catching up on a channel):

```bash
discord-chunker read <channel-id> [--since-minutes N] [--since-message <id>]
discord-chunker read <channel-id> [--since-time <time>] [--before-time <time>]
```

Examples:
```bash
# Read messages from last 10 minutes
discord-chunker read 1234567890123456789 --since-minutes 10

# Read messages since a specific message
discord-chunker read 1234567890123456789 --since-message 1470476722968465543

# Read messages since a human-readable time
discord-chunker read 1234567890123456789 --since-time "7:33am"
discord-chunker read 1234567890123456789 --since-time "7:33 PST"
discord-chunker read 1234567890123456789 --since-time "2026-02-14 07:33"

# Read messages in a time range
discord-chunker read 1234567890123456789 --since-time "7:00am" --before-time "8:00am"
```

Output is chronological (oldest first) — ideal for context-building.

### get-chunk

Retrieve a specific chunk's content:

```bash
discord-chunker get-chunk <channel-id> <chunk-index> --by-tokens <max-tokens>
```

Example:
```bash
# Get the second chunk (0-indexed)
discord-chunker get-chunk 1234567890123456789 1 --by-tokens 4000
```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--limit N` | Max messages to fetch | 100 |
| `--by-time <duration>` | Chunk by time period | - |
| `--by-tokens <max>` | Chunk by token count | - |
| `--gap-minutes N` | Minutes of silence = conversation break | 30 |
| `--format json\|text` | Output format | text |
| `--summary-only` | Only show chunk summaries | false |
| `--before <id>` | Fetch messages before this ID | - |
| `--after <id>` | Fetch messages after this ID | - |
| `--since-time <time>` | Messages after this time (human-readable) | - |
| `--before-time <time>` | Messages before this time (human-readable) | - |

## Conversation-Aware Chunking

When using `--by-tokens`, the tool:

1. Detects natural conversation breaks (gaps > `--gap-minutes`)
2. Tries to split at these breaks when approaching the token limit
3. Falls back to hard splits only when necessary (and notes them)

Chunks marked `[natural break]` end at a conversation boundary.

## JSON Output

Use `--format json` for programmatic access:

```json
{
  "channelId": "1234567890123456789",
  "totalMessages": 500,
  "chunkCount": 12,
  "chunks": [
    {
      "index": 0,
      "messageCount": 45,
      "tokenCount": 3890,
      "startTime": "2024-01-15T10:00:00.000Z",
      "endTime": "2024-01-15T12:30:00.000Z",
      "naturalBreak": true,
      "messageIds": ["msg1", "msg2", ...]
    }
  ]
}
```

## Agent Usage Pattern

Recommended workflow for processing large channels:

```bash
# 1. Estimate total size
discord-chunker estimate <channel-id> --limit 1000

# 2. Get chunk summary
discord-chunker chunk <channel-id> --by-tokens 4000 --summary-only --format json

# 3. Process chunks iteratively
for i in 0 1 2 3; do
  discord-chunker get-chunk <channel-id> $i --by-tokens 4000
  # Process chunk...
done
```
