Feature: Driving opencode with the router
  opencode is the reference coding agent of the QA stack. These plans
  drive real opencode sessions against the router and the scripted mock
  LLM and verify the agent-observable surface in the mock LLM log: the
  router server and its two tools are discovered, the tools are used end
  to end over stdio, streamable-http, and OAuth-protected servers, every
  downstream tool description reaches the model (including a
  deliberately long one), guided errors are recoverable, and closing
  opencode leaves no router or mock process behind.

  The stdio mock is added with "--compression-level low" so the compact
  catalog carries the full downstream tool descriptions, which is what
  the description plans verify. The remote-server scenarios add the
  HTTP or OAuth mock on top of that background.

Background:
  Given the QA stack is running and I am in the workspace shell
  And I prepared the router home with "pnpm qa:setup"
  And I added the stdio mock server with "pnpm qa:router add stdio-mock --description 'QA stdio mock' --compression-level low -- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts"

@TC-OPENCODE-1
Scenario: opencode discovers the router server
  When I list the opencode MCP servers with "pnpm qa:agent --mcp-list"
  Then the output shows "qa-router" as connected
  And the output shows its command as "node build/index.js"

@TC-OPENCODE-2
Scenario: The model sees the router tools and the stdio catalog
  Given I selected the mock LLM script "stdio-catalog" with "pnpm qa:llm script stdio-catalog"
  When I run the coding agent with "pnpm qa:agent --prompt 'Test the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the mock LLM log shows the request tools "get_tool_schema" and "invoke_tool"
  And the mock LLM log shows the catalog section "## stdio-mock"
  And the mock LLM log shows the catalog tool line "add(a, b)"
  And the mock LLM log shows no downstream tool "echo" in the request tools
  And the mock LLM log shows no validation failures

@TC-OPENCODE-3
Scenario: opencode uses the router end to end
  Given I selected the mock LLM script "stdio-roundtrip" with "pnpm qa:llm script stdio-roundtrip"
  When I run the coding agent with "pnpm qa:agent --prompt 'Add two numbers with the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the log shows a "get_tool_schema" call for server "stdio-mock"
  And the log shows an "invoke_tool" call for tool "add" with arguments 20 and 22
  And the log shows the tool result "42" in the next request
  And the log reports "0 failed" checks

@TC-OPENCODE-4
Scenario: The model sees every downstream tool description
  Given I selected the mock LLM script "stdio-descriptions" with "pnpm qa:llm script stdio-descriptions"
  When I run the coding agent with "pnpm qa:agent --prompt 'Test the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the log shows the complete "echo" tool description
  And the log shows the complete "add" tool description
  And the log shows the complete "multi_block" tool description
  And the log shows the complete "failing_tool" tool description
  And the log reports "0 failed" checks

@TC-OPENCODE-5
Scenario: A very long tool description is not cut by opencode
  Given I selected the mock LLM script "long-description" with "pnpm qa:llm script long-description"
  When I run the coding agent with "pnpm qa:agent --prompt 'Test the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the log shows the catalog beginning "LONG-DESCRIPTION-HEAD"
  And the log shows the catalog ending "LONG-DESCRIPTION-TAIL"
  And the log shows the end of the long description in a "get_tool_schema" result
  And the log reports "0 failed" checks

@TC-OPENCODE-6
Scenario: opencode recovers from a guided argument error
  Given I selected the mock LLM script "retry" with "pnpm qa:llm script retry"
  When I run the coding agent with "pnpm qa:agent --prompt 'Add two numbers with the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the log shows "Missing required argument" in a tool result
  And the log shows a corrected "invoke_tool" call with arguments 30 and 12
  And the log shows the tool result "42" in the next request
  And the log reports "0 failed" checks

@TC-OPENCODE-7
Scenario: A downstream error result reaches opencode
  Given I selected the mock LLM script "fail" with "pnpm qa:llm script fail"
  When I run the coding agent with "pnpm qa:agent --prompt 'Call the failing tool on the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the agent transcript shows the "invoke_tool" call with an error mentioning "boom"
  And the log shows "boom" in a tool result
  And the log reports "0 failed" checks

@TC-OPENCODE-8
Scenario: Closing opencode leaves no QA processes behind
  Given I selected the mock LLM script "stdio-roundtrip" with "pnpm qa:llm script stdio-roundtrip"
  When I run the coding agent with "pnpm qa:agent --prompt 'Test the stdio mcp server'"
  Then running "pgrep -fl build/index.js" finds no router process
  And running "pgrep -fl qa/scripts/mock-mcp-stdio" finds no stdio mock process

@TC-OPENCODE-9
Scenario: opencode uses a streamable-http server end to end
  Given I added the streamable-http mock server with "pnpm qa:router add http-mock --description 'QA streamable-http mock' http://mock-mcp-http:3100/mcp"
  And I selected the mock LLM script "http-roundtrip" with "pnpm qa:llm script http-roundtrip"
  When I run the coding agent with "pnpm qa:agent --prompt 'Test the http mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the log shows a "get_tool_schema" call for server "http-mock"
  And the log shows an "invoke_tool" call for tool "add" with arguments 20 and 22
  And the log shows the tool result "42" in the next request
  And the log reports "0 failed" checks
  And the host command "docker compose -f qa/docker-compose.yml logs mock-mcp-http" shows a "tools/call add" line

@TC-OPENCODE-10
Scenario: opencode uses an OAuth-protected server end to end
  Given I added the OAuth mock server with "pnpm qa:router add oauth-mock --description 'QA OAuth mock' http://mock-mcp-http-oauth:3101/mcp"
  And I selected the mock LLM script "oauth-roundtrip" with "pnpm qa:llm script oauth-roundtrip"
  When I run the coding agent with "pnpm qa:agent --prompt 'Test the oauth mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the log shows a "get_tool_schema" call for server "oauth-mock"
  And the log shows an "invoke_tool" call for tool "add" with arguments 20 and 22
  And the log shows the tool result "42" in the next request
  And the log reports "0 failed" checks
  And the host command "docker compose -f qa/docker-compose.yml logs mock-mcp-http-oauth" shows a "tools/call add" line
