# Connect your coding agent

Register MCP Compress Router with your coding agent the same way you
register any other stdio MCP server. The router reads its server list
from a
[user-wide config file](../reference/configuration.md#configuration-file-location)
by default, so register it at the **user** scope (or your agent's
equivalent): every project then gets the same compressed catalog with
no per-project setup.

Any agent that can spawn a local stdio MCP server works. The examples
below cover the agents this project tests against.

## Claude Code

See the [Claude Code MCP docs](https://code.claude.com/docs/en/mcp).
Add the router at `user` scope so it applies everywhere (Claude Code
also supports `local` for a single private project and `project` for a
shareable `.mcp.json`):

```sh
claude mcp add mcp-compress-router --scope user -- npx -y mcp-compress-router@latest
```

## Opencode

See the [opencode MCP servers docs](https://opencode.ai/docs/mcp-servers/).

```sh
opencode mcp add mcp-compress-router -- npx -y mcp-compress-router@latest
```

## Codex

See the [Codex MCP docs](https://developers.openai.com/codex/mcp).

```sh
codex mcp add mcp-compress-router -- npx -y mcp-compress-router@latest
```

## GitHub Copilot (VS Code)

See the
[VS Code MCP docs](https://code.visualstudio.com/docs/agent-customization/mcp-servers).
Open the Command Palette (`Cmd+Shift+P`) →
`MCP: Open User Configuration` and add the server block under
`mcp.servers` (project-level `.vscode/mcp.json` is also supported and
merged with the user-level settings, project taking precedence):

```json
{
  "servers": {
    "mcp-compress-router": {
      "command": "npx",
      "args": ["-y", "mcp-compress-router@latest"]
    }
  }
}
```

## Other agents

Configure the router as a stdio server that runs
`npx -y mcp-compress-router@latest`. The agent spawns the router as a
child process and sees exactly two tools (`get_tool_schema` and
`invoke_tool`); you normally do not run the router yourself.

Once the agent is connected,
[add the downstream MCP servers](../reference/configuration.md#add-name-commandorurl-rest)
you want to compress.
