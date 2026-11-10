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
  indicator a strict provider demands. Refresh tokens are single-use and
  bound to the client that requested them: the mock invalidates one as
  soon as it is redeemed, and it rejects a token presented by a client
  that does not own it with `invalid_grant` without consuming the token.
  Authorization codes are bound the same way: the mock rejects a code
  redeemed by another `client_id` with `invalid_grant` and leaves it
  available to the client it was issued to.
  A stale refresh token presented by a second router instance is rejected
  the same way — the concurrent-instances plan proves such a rejection
  never wipes the tokens the winning instance stored. Mock client
  registrations never expire, so the expired-registration plan moves the
  stored expiry into the past with `pnpm qa:expire-client`: a login that
  succeeds and stores a different `client_id` proves the router replaced
  the dead registration instead of reusing it. The mock also has a QA
  control endpoint that makes the provider forget a registration
  entirely: `pnpm qa:revoke-client` marks the stored `client_id` as
  revoked, and the mock then rejects it with `invalid_client` at its
  authorization and token endpoints. A token request rejected with
  `invalid_client` must discard the stored registration, so a new client
  registration replaces the dead one: the runtime flow (the SDK's
  `auth()` retry) may register it during the same call, while the
  `--no-browser` login token exchange leaves it to the next login, which
  succeeds either way. Two plans prove that recovery: the runtime
  token-refresh plan forces a token request, and the `--no-browser` plan
  revokes the client after the authorization redirect is obtained, so the
  login token exchange observes the rejection. Together they prove the
  router recovers from a provider-side rejection, not only from a locally
  expired secret. Two plans bypass qa-browser: `login --no-browser` prints
  the authorization URL, the tester resolves its redirect target with curl
  without following it, and pastes the resulting URL back at the prompt.

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

@TC-OAUTH-9
Scenario: Changing the server URL invalidates stored credentials
  Given I added the OAuth mock server with "pnpm qa:router add oauth-mock --description 'QA OAuth mock' http://mock-mcp-http-oauth:3101/mcp"
  When I note the stored "client_id" in "qa/home/credentials.json"
  And I run "sed -i 's|http://mock-mcp-http-oauth:3101/mcp|http://mock-mcp-http-oauth:3101/mcp/|' qa/home/mcp.jsonc"
  And I run "pnpm qa:router list"
  Then the output shows an "oauth-mock" row with auth "requires login"
  When I run "pnpm qa:router login oauth-mock"
  And I run "pnpm qa:router list"
  Then the output reports "Successfully authenticated server "oauth-mock""
  And the output shows an "oauth-mock" row with auth "authenticated"
  And the stored "serverUrl" in "qa/home/credentials.json" is "http://mock-mcp-http-oauth:3101/mcp/"
  And the stored "client_id" in "qa/home/credentials.json" differs from the noted value

@TC-OAUTH-10
Scenario: Concurrent instances do not wipe each other's refreshed tokens
  Given I added the OAuth mock server with "pnpm qa:router add oauth-mock --description 'QA OAuth mock' http://mock-mcp-http-oauth:3101/mcp"
  And I marked the stored access token as rejected with "pnpm qa:reject-token oauth-mock"
  When I ran two router calls at once with "pnpm qa:probe --tool invoke_tool --args '{"server":"oauth-mock","tool":"echo","arguments":{"message":"race"}}' >/tmp/qa-race-a.log 2>&1 && echo ok >/tmp/qa-race-a.status || echo fail >/tmp/qa-race-a.status & pnpm qa:probe --tool invoke_tool --args '{"server":"oauth-mock","tool":"echo","arguments":{"message":"race"}}' >/tmp/qa-race-b.log 2>&1 && echo ok >/tmp/qa-race-b.status || echo fail >/tmp/qa-race-b.status & wait"
  Then both "/tmp/qa-race-a.status" and "/tmp/qa-race-b.status" contain "ok"
  And I run "pnpm qa:router list"
  And the output shows an "oauth-mock" row with auth "authenticated"
  And the stored "refresh_token" in "qa/home/credentials.json" is not empty

@TC-OAUTH-12
Scenario: An expired client registration is replaced at login
  Given I added the OAuth mock server with "pnpm qa:router add oauth-mock --description 'QA OAuth mock' http://mock-mcp-http-oauth:3101/mcp"
  When I note the stored "client_id" in "qa/home/credentials.json"
  And I run "pnpm qa:expire-client oauth-mock"
  And I run "pnpm qa:router login oauth-mock"
  Then the output reports "Successfully authenticated server "oauth-mock""
  And the stored "client_id" in "qa/home/credentials.json" differs from the noted value

@TC-OAUTH-11
Scenario: A rejected access token recovers through a coordinated refresh
  Given I added the OAuth mock server with "pnpm qa:router add oauth-mock --description 'QA OAuth mock' http://mock-mcp-http-oauth:3101/mcp"
  And I marked the stored access token as rejected while keeping its expiry with "pnpm qa:reject-token oauth-mock --keep-expiry"
  When I run "pnpm qa:probe --tool invoke_tool --args '{"server":"oauth-mock","tool":"echo","arguments":{"message":"recover"}}'"
  Then the call is not an error
  And the result text is "echo: recover"
  And the host command "docker compose -f qa/docker-compose.yml logs mock-mcp-http-oauth" shows a "rejected unauthenticated MCP request" line
  And the same output shows an "issued tokens (refresh_token" line

@TC-OAUTH-13
Scenario: A provider-revoked client registration is cleared by a token refresh
  Given I added the OAuth mock server with "pnpm qa:router add oauth-mock --description 'QA OAuth mock' http://mock-mcp-http-oauth:3101/mcp"
  When I note the stored "client_id" in "qa/home/credentials.json"
  And I run "pnpm qa:revoke-client oauth-mock"
  And I run "pnpm qa:reject-token oauth-mock"
  And I run "pnpm qa:probe --tool invoke_tool --args '{"server":"oauth-mock","tool":"echo","arguments":{"message":"revoked"}}'"
  Then the call is an error
  And the host command "docker compose -f qa/docker-compose.yml logs mock-mcp-http-oauth" shows a "rejected revoked client" line
  And the same output shows a "rejected refresh token issued to another client" line
  When I run "pnpm qa:router login oauth-mock"
  And I run "pnpm qa:router list"
  Then the output reports "Successfully authenticated server "oauth-mock""
  And the output shows an "oauth-mock" row with auth "authenticated"
  And the stored "client_id" in "qa/home/credentials.json" differs from the noted value

@TC-OAUTH-14
Scenario: A provider-revoked client registration is cleared by the login token exchange
  Given I added the OAuth mock server with "pnpm qa:router add oauth-mock --description 'QA OAuth mock' http://mock-mcp-http-oauth:3101/mcp"
  When I note the stored "client_id" in "qa/home/credentials.json"
  And I run "pnpm qa:router login oauth-mock --no-browser" and leave it waiting at the paste prompt
  And I copy the printed authorization URL and, in another terminal, obtain its redirect target without following it with "curl -s -o /dev/null -w '%{redirect_url}' '<authorization URL>'"
  And I run "pnpm qa:revoke-client oauth-mock"
  And I paste the resulting redirect URL at the paste prompt
  Then the output reports "Server "oauth-mock" rejected the stored OAuth client registration (invalid_client: Invalid client_id). Run "npx mcp-compress-router login oauth-mock" again to register a new client."
  And the stored "client_id" in "qa/home/credentials.json" is absent
  When I run "pnpm qa:router login oauth-mock"
  Then the output reports "Successfully authenticated server "oauth-mock""
  And the stored "client_id" in "qa/home/credentials.json" differs from the noted value
