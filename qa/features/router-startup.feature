Feature: Router startup and compact catalog
  The router answers the host over stdio, connects to every enabled
  downstream server, and exposes exactly two tools whose get_tool_schema
  description carries the compact catalog. Run these checks in the QA
  workspace after adding the stdio mock server.

Background:
  Given the QA stack is running and I am in the workspace shell
  And I prepared the router home with "pnpm qa:setup"
  And I added the stdio mock server with "pnpm qa:router add stdio-mock --description 'QA stdio mock' -- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts"

@TC-STARTUP-1
Scenario: The router exposes exactly two tools
  When I list the router tools with "pnpm qa:probe --list"
  Then the output lists exactly "get_tool_schema" and "invoke_tool"

@TC-STARTUP-2
Scenario: The catalog describes the stdio server compactly
  When I list the router tools with "pnpm qa:probe --list"
  Then the "get_tool_schema" description contains the bullet "- stdio-mock (6 tools) - QA stdio mock"
  And the description ends with the list-mode hint "Call get_tool_schema with the server name to list all tools, i.e. get_tool_schema(stdio-mock)"
  And the description lists no tool names

@TC-STARTUP-3
Scenario: A disabled downstream server stays out of the catalog
  When I add the disabled archive server with "pnpm qa:router add archive --disabled --description 'Disabled QA mock' -- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts"
  And I list the router tools with "pnpm qa:probe --list"
  Then the "get_tool_schema" description does not contain "- archive"

@TC-STARTUP-4
Scenario: A server without a description does not stop the router
  Given I removed the server descriptions with "sed -i '/description/d' qa/home/mcp.jsonc"
  When I list the router tools with "pnpm qa:probe --list"
  Then the "get_tool_schema" description contains the bullet "- stdio-mock (6 tools)"
  And that bullet has no description after the tool count
  And the description lists no tool names
