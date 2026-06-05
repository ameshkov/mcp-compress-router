# MCP Compressing Router

Compress all connected MCP into a single router MCP and save up to 99% on
tokens.

## The Problem

When you have multiple MCPs every request to the LLM will include ALL their
tools and descriptions, which can quickly eat up your token limit and increase
costs.

Check out this [example](docs/assets/tools.json) to understand how
quickly and how large it can get. This example represents just 3 popular MCP
servers: Notion MCP, Github MCP and Pylance MCP.

The overhead that is created is about **26K tokens**, but let's check how much
it actually costs you in USD. I will use Opus API pricing for calculation and
I'll assume that on average you have a 50-turn coding session (pretty
reasonable these days).

- Input: `26K tokens * $5 / 1M = $0.13`
- Cache write (caching is not free): `26K tokens * $6.25 / 1M = $0.1625`
- Cache read (49 turns): `26K tokens * 49 * $0.50 / 1M = $0.637`

So the total overhead on an average coding session is about **$0.9275**.
And that's just for 3 MCPs, imagine if you had more!

## The Solution

Instead of sending all the tools and descriptions every time, you can use a
single router MCP that compresses all the connected MCPs into one with just
two tools: `get_tool_schema`, `invoke_tool`.

`get_tool_schema` in the description only has a list of MCP servers, optional
descriptions (you can write them yourself), and a list of tool names for each
MCP server. [Here is an example](docs/assets/tools-compressed.json) of how the
compressed version looks like, and it takes about 900 tokens.

If we repeat our exercise with the compressed version, the total overhead on
an average coding session will be about **$0.032175** so we saved about
**96.5%** on costs!

This is just a basic example with just 3 MCP servers, the more MCP servers you
have, the more you save.
