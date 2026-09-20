Feature: Using an OAuth-protected streamable-http MCP server
  The `mock-mcp-http-oauth` container requires a bearer token and
  publishes mock OAuth metadata, so the plans exercise login, token
  storage, logout, and login again. The agent-driven authenticated round
  trip lives in `opencode.feature`. The workspace sets
  MCP_COMPRESS_ROUTER_BROWSER=qa-browser, so `add` and `login` complete
  the authorization flow headlessly.

Background:
  Given the QA stack is running and I am in the workspace shell
  And I prepared the router home with "pnpm qa:setup"

@TC-OAUTH-1
Scenario: Adding an OAuth server logs in automatically
  When I add the OAuth mock server with "pnpm qa:router add oauth-mock --description 'QA OAuth mock' http://mock-mcp-http-oauth:3101/mcp"
  And I run "pnpm qa:router list"
  Then the output reports "Successfully authenticated server "oauth-mock""
  And the output shows an "oauth-mock" row with auth "authenticated"

@TC-OAUTH-2
Scenario: After logout the catalog asks for login again
  Given I added the OAuth mock server with "pnpm qa:router add oauth-mock --description 'QA OAuth mock' http://mock-mcp-http-oauth:3101/mcp"
  When I run "pnpm qa:router logout oauth-mock"
  And I list the router tools with "pnpm qa:probe --list"
  Then the output reports "Removed credentials for server "oauth-mock""
  And the "get_tool_schema" description contains "Requires authentication. Run: npx mcp-compress-router login oauth-mock"

@TC-OAUTH-3
Scenario: A logged-out server can be logged in again
  Given I added the OAuth mock server with "pnpm qa:router add oauth-mock --description 'QA OAuth mock' http://mock-mcp-http-oauth:3101/mcp"
  And I ran "pnpm qa:router logout oauth-mock"
  When I run "pnpm qa:router login oauth-mock"
  And I run "pnpm qa:router list"
  Then the output reports "Successfully authenticated server "oauth-mock""
  And the output shows an "oauth-mock" row with auth "authenticated"
