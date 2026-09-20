Feature: Reading downstream tool schemas
  get_tool_schema returns the JSON parameter schema of tools on a
  connected server and reports actionable errors for unknown servers or
  tools. Run these checks in the QA workspace after adding the stdio
  mock server.

Background:
  Given the QA stack is running and I am in the workspace shell
  And I prepared the router home with "pnpm qa:setup"
  And I added the stdio mock server with "pnpm qa:router add stdio-mock --description 'QA stdio mock' -- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts"

@TC-SCHEMA-1
Scenario: The schema of a mock tool is returned
  When I run "pnpm qa:probe --tool get_tool_schema --args '{"server":"stdio-mock","tools":["add"]}'"
  Then the call is not an error
  And the result JSON contains a tool named "add"
  And the tool input schema offers the properties "a" and "b"
  And "a" and "b" are listed as required

@TC-SCHEMA-2
Scenario: An unknown server is reported with the available servers
  When I run "pnpm qa:probe --tool get_tool_schema --args '{"server":"does-not-exist","tools":["echo"]}'"
  Then the call reports an error
  And the error says Server "does-not-exist" not found
  And the error lists "stdio-mock" among the available servers

@TC-SCHEMA-3
Scenario: An unknown tool is reported with the valid tools
  When I run "pnpm qa:probe --tool get_tool_schema --args '{"server":"stdio-mock","tools":["no_such_tool"]}'"
  Then the call reports an error
  And the error names "no_such_tool" as not found
  And the error lists every valid tool of "stdio-mock"

@TC-SCHEMA-4
Scenario: Several tool schemas are returned in one call
  When I run "pnpm qa:probe --tool get_tool_schema --args '{"server":"stdio-mock","tools":["echo","add"]}'"
  Then the result JSON contains tools named "echo" and "add"
