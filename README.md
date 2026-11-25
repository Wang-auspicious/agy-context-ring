# Claude Context Ring (Antigravity Sidecar Plugin)

A 1:1 recreation of Claude Desktop's circular context window indicator, segmented breakdown bar, and compaction controls for **Antigravity 2.0**.

## Features

- **1:1 Claude Desktop Ring & Popover**: Exact `14×14` SVG ring (`r=6`, `stroke-width=2`), `75%` warning / `90%` critical color thresholds, `12px` popover card, `4px` segmented meter bar with `1px` seams, and `10×10px` category swatches.
- **Multi-Session Live Monitoring**: Automatically discovers active (`RUN_STATE_RUNNING`) and recent Antigravity conversations via `ConversationService/ListConversations` and streams live token usage via SSE.
- **Copyable History Path**: Click any session's `folder-shortId` pill to copy its relative `transcript.jsonl` path (`brain/<conversationId>/.system_generated/logs/transcript.jsonl`).
- **Real Compaction & Thresholds**: Supports `256K` / `512K` / `1M` window scaling, configurable auto-compact threshold (`50%`–`90%`, default `60%`), and real `/compact` execution via `agentapi send-message`.

## Local Installation

Place this folder under `~/.gemini/config/plugins/claude-context-ring/` and open **Context Ring** from Antigravity's Auxiliary Side Pane.
