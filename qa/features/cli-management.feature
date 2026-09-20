Feature: Managing the router configuration
  The management CLI reads and writes the QA router home prepared from
  qa/fixtures/mcp.jsonc. Run these checks in the QA workspace after
  adding the mock servers they need.

Background:
  Given the QA stack is running and I am in the workspace shell
  And I prepared the router home with "pnpm qa:setup"
  And I added the stdio mock server with "pnpm qa:router add stdio-mock --description 'QA stdio mock' -- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts"
  And I added the disabled archive server with "pnpm qa:router add archive --disabled --description 'Disabled QA mock' -- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts"

@TC-CLI-1
Scenario: The list command shows enabled and disabled servers
  When I run "pnpm qa:router list"
  Then the output shows a "stdio-mock" row marked enabled with "yes"
  And the output shows an "archive" row marked enabled with "no"

@TC-CLI-2
Scenario: The tools command lists the downstream tools
  When I run "pnpm qa:router tools stdio-mock"
  Then the output lists "echo" as "[exposed]"
  And the output lists "add" as "[exposed]"

@TC-CLI-3
Scenario: A disabled server can be enabled
  When I run "pnpm qa:router enable archive"
  And I run "pnpm qa:router list"
  Then the output shows an "archive" row marked enabled with "yes"
