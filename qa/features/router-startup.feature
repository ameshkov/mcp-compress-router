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
Scenario: The catalog describes the stdio server and its tools
  When I list the router tools with "pnpm qa:probe --list"
  Then the "get_tool_schema" description contains a "## stdio-mock" section
  And that section lists "echo"
  And that section lists "add"
  And that section lists "multi_block"
  And that section lists "failing_tool"
  And that section lists "documented_tool"

@TC-STARTUP-3
Scenario: A disabled downstream server stays out of the catalog
  When I add the disabled archive server with "pnpm qa:router add archive --disabled --description 'Disabled QA mock' -- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts"
  And I list the router tools with "pnpm qa:probe --list"
  Then the "get_tool_schema" description does not contain "## archive"
