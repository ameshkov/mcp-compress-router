Feature: Adding a streamable-http MCP server
  The tester adds the streamable-http mock server, which runs in its own
  container (`mock-mcp-http` in qa/docker-compose.yml), and verifies its
  catalog over the HTTP transport with the protocol probe. The
  agent-driven HTTP round trip lives in `opencode.feature`, which also
  inspects the downstream container log.

@TC-HTTP-1
Scenario: The HTTP server appears in the catalog
  Given the QA stack is running and I am in the workspace shell
  And I prepared the router home with "pnpm qa:setup"
  And I added the streamable-http mock server with "pnpm qa:router add http-mock --description 'QA streamable-http mock' http://mock-mcp-http:3100/mcp"
  When I list the router tools with "pnpm qa:probe --list"
  Then the "get_tool_schema" description contains a "## http-mock" section
  And that section lists "add"
  And that section lists "whoami"
