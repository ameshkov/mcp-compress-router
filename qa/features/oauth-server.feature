Feature: Using an OAuth-protected streamable-http MCP server
  The `mock-mcp-http-oauth` container requires a bearer token and
  publishes mock OAuth metadata, so the plans exercise login, token
  storage, logout, and login again. The agent-driven authenticated round
  trip lives in `opencode.feature`. The workspace sets
  MCP_COMPRESS_ROUTER_BROWSER=qa-browser, so `add` and `login` complete
  the authorization flow headlessly. A login completing also proves the
  CSRF `state` round trip: the mock echoes the state back, and a callback
  that does not echo it is ignored, so the login would time out instead.
  The mock authorization server matches `redirect_uri` against the
  client registration under the RFC 8252 loopback rule: scheme, host,
  and path must match, the port is ignored. It also advertises and
  echoes the RFC 9207 issuer (`iss`), so a login completing proves the
  router used a callback URI the registration covers and accepted the
  matching issuer. Finally, the mock requires the RFC 8707 `resource`
  parameter on the authorization and token requests and logs the value:
  the router derives it from the mock's protected resource metadata, so
  a login completing proves the router sent the per-server resource
  indicator a strict provider demands. One plan bypasses qa-browser:
  `login --no-browser` prints the authorization URL, the tester resolves
  its redirect target with curl without following it, and pastes the
  resulting URL back at the prompt.

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
  And the "get_tool_schema" description shows the indented status line "Requires authentication. Ask the user to run: npx mcp-compress-router login oauth-mock. This opens a browser for interactive authorization. Do not run it yourself."

@TC-OAUTH-3
Scenario: A logged-out server can be logged in again
  Given I added the OAuth mock server with "pnpm qa:router add oauth-mock --description 'QA OAuth mock' http://mock-mcp-http-oauth:3101/mcp"
  And I ran "pnpm qa:router logout oauth-mock"
  When I run "pnpm qa:router login oauth-mock"
  And I run "pnpm qa:router list"
  Then the output reports "Successfully authenticated server "oauth-mock""
  And the output shows an "oauth-mock" row with auth "authenticated"

@TC-OAUTH-4
Scenario: The login registers the portless loopback callback URI
  When I add the OAuth mock server with "pnpm qa:router add oauth-mock --description 'QA OAuth mock' http://mock-mcp-http-oauth:3101/mcp"
  Then the host command "docker compose -f qa/docker-compose.yml logs mock-mcp-http-oauth" shows a "redirect_uris=[http://127.0.0.1/mcp-compress-router/oauth-callback]" line
  And the same output shows an "auto-approved, redirecting to http://127.0.0.1:" line
  And the same output contains the callback path "/mcp-compress-router/oauth-callback"

@TC-OAUTH-5
Scenario: Login accepts the issuer the mock advertises
  When I add the OAuth mock server with "pnpm qa:router add oauth-mock --description 'QA OAuth mock' http://mock-mcp-http-oauth:3101/mcp"
  And I run "pnpm qa:router list"
  Then the output reports "Successfully authenticated server "oauth-mock""
  And the output shows an "oauth-mock" row with auth "authenticated"
  And the host command "docker compose -f qa/docker-compose.yml logs mock-mcp-http-oauth" shows an "iss=http://mock-mcp-http-oauth:3101" line

@TC-OAUTH-6
Scenario: The login sends the RFC 8707 resource indicator
  When I add the OAuth mock server with "pnpm qa:router add oauth-mock --description 'QA OAuth mock' http://mock-mcp-http-oauth:3101/mcp"
  Then the host command "docker compose -f qa/docker-compose.yml logs mock-mcp-http-oauth" shows an "auto-approved, redirecting to http://127.0.0.1:" line with "resource=http://mock-mcp-http-oauth:3101/mcp"
  And the same output shows an "issued tokens (authorization_code" line with "resource=http://mock-mcp-http-oauth:3101/mcp"

@TC-OAUTH-7
Scenario: Login without a browser accepts a pasted redirect URL
  Given I added the OAuth mock server with "pnpm qa:router add oauth-mock --description 'QA OAuth mock' http://mock-mcp-http-oauth:3101/mcp"
  And I ran "pnpm qa:router logout oauth-mock"
  When I run "pnpm qa:router login oauth-mock --no-browser" and leave it waiting at the paste prompt
  And I copy the printed authorization URL and, in another terminal, obtain its redirect target without following it with "curl -s -o /dev/null -w '%{redirect_url}' '<authorization URL>'"
  And I paste the resulting redirect URL at the paste prompt
  Then the output reports "Successfully authenticated server "oauth-mock""
  And the output shows an "oauth-mock" row with auth "authenticated"
  And the host command "docker compose -f qa/docker-compose.yml logs mock-mcp-http-oauth" shows an "issued tokens (authorization_code" line

@TC-OAUTH-8
Scenario: The login registers with the configured DCR client identity
  When I add the OAuth mock server with "pnpm qa:router add --client-name 'QA Override Client' --client-uri 'https://qa.example.com/app' oauth-mock --description 'QA OAuth mock' http://mock-mcp-http-oauth:3101/mcp"
  Then the host command "docker compose -f qa/docker-compose.yml logs mock-mcp-http-oauth" shows a "registration client_name=QA Override Client client_uri=https://qa.example.com/app" line
  And the same output shows an "auto-approved, redirecting to http://127.0.0.1:" line
