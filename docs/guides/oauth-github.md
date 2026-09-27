# Connect the GitHub MCP server

The official GitHub MCP server at `https://api.githubcopilot.com/mcp`
advertises OAuth but does **not** support Dynamic Client Registration,
so you must pre-register a GitHub OAuth App and pass its credentials
via the `oauth` block. GitHub also requires that the OAuth App be
installed to the repositories and organizations you want the MCP to
access.

1. **Create a GitHub OAuth App.**
   Open <https://github.com/settings/developers> → *New OAuth App* (or
   *Register an application*). Give it any name and homepage URL.
2. **Configure the callback URL.**
   Set the *Authorization callback URL* to:
   `http://localhost/mcp-compress-router/oauth-callback`
3. **Add the GitHub MCP server by URL.**

   ```bash
   npx mcp-compress-router@latest add github \
     --description "GitHub API tools for browsing repositories, issues, and pull requests." \
     https://api.githubcopilot.com/mcp
   ```

4. **Set `oauth` credentials in `mcp.json`.**
   Copy the Client ID and generate a Client Secret, then put them in the
   server entry (use variable expansion to keep secrets out of the
   file):

   ```jsonc
   "github": {
     "type": "http",
     "url": "https://api.githubcopilot.com/mcp",
     "description": "GitHub API tools for browsing repositories, issues, and pull requests.",
     "oauth": {
       "clientId": "${GITHUB_OAUTH_CLIENT_ID}",
       "clientSecret": "${GITHUB_OAUTH_CLIENT_SECRET}",
       "scope": "repo read:org"
     }
   }
   ```

   Request only the scopes the tools you need require; `repo read:org`
   covers the common repo and organization operations. Put the actual
   values in your `.env` file (see
   [Variable Expansion](../reference/configuration.md#variable-expansion)).
5. **Run the login command.**

   ```bash
   npx mcp-compress-router@latest login github
   ```

   Your browser opens to authorize. After you approve, tokens are stored
   in `credentials.json` and the router can call GitHub MCP tools.

> **Note:** if you used a *GitHub App* (not a classic OAuth App), the
> App must be installed to the accounts/repos you want to access before
> login will succeed, and its client secret is generated under *General*
> → *Generate a new client secret*.
