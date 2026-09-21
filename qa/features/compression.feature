Feature: Compression levels in the compact catalog
  Each server's compressionLevel controls how its tools appear in the
  "get_tool_schema" description. This plan adds the same stdio mock
  under four different names, one per level, and inspects the catalog
  with the protocol probe. Full tool descriptions never appear in the
  catalog: the "max" level points the model at the list mode instead,
  and the "low" level shows the first sentence only.

Background:
  Given the QA stack is running and I am in the workspace shell
  And I prepared the router home with "pnpm qa:setup"
  And I added the stdio mock server with "pnpm qa:router add stdio-mock-max --description 'QA max mock' --compression-level max -- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts"
  And I added the stdio mock server with "pnpm qa:router add stdio-mock-high --description 'QA high mock' --compression-level high -- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts"
  And I added the stdio mock server with "pnpm qa:router add stdio-mock-medium --description 'QA medium mock' --compression-level medium -- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts"
  And I added the stdio mock server with "pnpm qa:router add stdio-mock-low --description 'QA low mock' --compression-level low -- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts"

@TC-COMPRESS-1
Scenario: The max level renders a tool count and a list-mode pointer
  When I list the router tools with "pnpm qa:probe --list"
  Then the "get_tool_schema" description contains a "## stdio-mock-max" section
  And that section shows the count "Provides 5 tools"
  And that section points at get_tool_schema for "stdio-mock-max"
  And that section lists no tool names

@TC-COMPRESS-2
Scenario: The high level renders comma-separated tool names
  When I list the router tools with "pnpm qa:probe --list"
  Then the "get_tool_schema" description contains a "## stdio-mock-high" section
  And that section lists "echo, add, multi_block, failing_tool, documented_tool"
  And that section lists no "echo(message)"

@TC-COMPRESS-3
Scenario: The medium level renders tool signatures
  When I list the router tools with "pnpm qa:probe --list"
  Then the "get_tool_schema" description contains a "## stdio-mock-medium" section
  And that section lists "echo(message)"
  And that section lists "add(a, b)"
  And that section lists no "Returns the input message"

@TC-COMPRESS-4
Scenario: The low level renders signatures with the first description sentence
  When I list the router tools with "pnpm qa:probe --list"
  Then the "get_tool_schema" description contains a "## stdio-mock-low" section
  And that section lists the line echo(message): Returns the input message with an "echo: " prefix
  And that section lists no "<tool>"

@TC-COMPRESS-5
Scenario: A max-level server still supports the get_tool_schema list mode
  When I run "pnpm qa:probe --tool get_tool_schema --args '{"server":"stdio-mock-max"}'"
  Then the call is not an error
  And the result text shows the tool signatures "echo(message)" and "add(a, b)"
  And the result text tells me to call get_tool_schema with a tool name
