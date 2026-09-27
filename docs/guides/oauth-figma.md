# Connect the Figma MCP server

The official Figma MCP server at `https://mcp.figma.com/mcp` does
**not** support Dynamic Client Registration through the standard MCP
flow. Instead you register an OAuth client via Figma's REST API using a
Personal Access Token, then pass the resulting credentials through the
`oauth` block. Figma also requires the redirect URI to use a **fixed
port** — the port you register is reused on every `login`, so you must
pin it with `oauth.callbackPort`.

1. **Create a Figma Personal Access Token.**
   Follow
   <https://developers.figma.com/docs/rest-api/personal-access-tokens/>
   to generate a PAT and export it as `FIGMA_PERSONAL_ACCESS_TOKEN`. It
   is only used to register the MCP client in the next step.

2. **Register the MCP client via Figma's API.**
   The redirect URI must use `127.0.0.1` on a fixed port — **the port
   matters**, it is reused on every `login`. This example uses `19876`:

   ```bash
   curl -X POST https://api.figma.com/v1/oauth/mcp/register \
     -H "Content-Type: application/json" \
     -H "X-Figma-Token: $FIGMA_PERSONAL_ACCESS_TOKEN" \
     -d '{
       "client_name": "Claude Code (figma)",
       "redirect_uris": ["http://127.0.0.1:19876/mcp-compress-router/oauth-callback"],
       "grant_types": ["authorization_code", "refresh_token"],
       "response_types": ["code"],
       "token_endpoint_auth_method": "none"
     }'
   ```

   Save the `client_id` and `client_secret` from the response (also note
   the `scope` is `mcp:connect`):

   ```json
   {
     "client_id": "CLIENTID",
     "client_secret": "CLIENTSECRET",
     "client_name": "Claude Code (figma)",
     "redirect_uris": ["http://127.0.0.1:19876/mcp-compress-router/oauth-callback"],
     "token_endpoint_auth_method": "none",
     "scope": "mcp:connect"
   }
   ```

3. **Add the Figma MCP server by URL.**

   ```bash
   npx mcp-compress-router@latest add --transport http figma \
     --description "Figma design tools for inspecting files, components, and variables." \
     https://mcp.figma.com/mcp
   ```

4. **Set `oauth` credentials in `mcp.json`.**
   Put the client ID and secret from step 2 in the server entry, using
   the `mcp:connect` scope and the **same fixed port** you registered as
   `callbackPort`:

   ```jsonc
   "figma": {
     "type": "http",
     "url": "https://mcp.figma.com/mcp",
     "description": "Figma design tools for inspecting files, components, and variables.",
     "oauth": {
       "clientId": "${FIGMA_CLIENT_ID}",
       "clientSecret": "${FIGMA_CLIENT_SECRET}",
       "scope": "mcp:connect",
       "callbackPort": 19876
     }
   }
   ```

   Put the actual values in your `.env` file (see
   [Variable Expansion](../reference/configuration.md#variable-expansion)).

5. **Run the login command.**

   ```bash
   npx mcp-compress-router@latest login figma
   ```

   Your browser opens to authorize. After you approve, tokens are stored
   in `credentials.json` and the router can call Figma MCP tools.
