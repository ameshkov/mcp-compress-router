Feature: Invoking downstream tools
  invoke_tool forwards a call to the named downstream MCP server and
  returns its result verbatim, while rejecting invalid arguments before
  the call reaches the server. Run these checks in the QA workspace
  after adding the stdio mock server.

Background:
  Given the QA stack is running and I am in the workspace shell
  And I prepared the router home with "pnpm qa:setup"
  And I added the stdio mock server with "pnpm qa:router add stdio-mock --description 'QA stdio mock' -- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts"

@TC-INVOKE-1
Scenario: An echo call round-trips its argument
  When I run "pnpm qa:probe --tool invoke_tool --args '{"server":"stdio-mock","tool":"echo","arguments":{"message":"hello qa"}}'"
  Then the call is not an error
  And the result text is "echo: hello qa"

@TC-INVOKE-2
Scenario: A numeric call returns the computed result
  When I run "pnpm qa:probe --tool invoke_tool --args '{"server":"stdio-mock","tool":"add","arguments":{"a":2,"b":3}}'"
  Then the call is not an error
  And the result text is "5"

@TC-INVOKE-3
Scenario: A downstream error result is passed through
  When I run "pnpm qa:probe --tool invoke_tool --args '{"server":"stdio-mock","tool":"failing_tool","arguments":{"message":"boom"}}'"
  Then the call is an error result
  And the result text is "boom"

@TC-INVOKE-4
Scenario: Invalid arguments are rejected without calling the server
  When I run "pnpm qa:probe --tool invoke_tool --args '{"server":"stdio-mock","tool":"add","arguments":{"a":2}}'"
  Then the call reports an error
  And the error mentions Missing required argument: "b"
  And the error shows the expected shape of "add"
