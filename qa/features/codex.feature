Feature: Driving Codex CLI with the router
  Codex CLI is the fourth coding agent of the QA stack. It speaks the
  OpenAI Responses API and runs headless against the mock LLM's
  Responses-compatible endpoint (a custom "wire_api = responses"
  provider plus the dummy "QA_MOCK_API_KEY") with a hermetic
  "CODEX_HOME", so the plans exercise the real agent without an OpenAI
  account. The mock LLM log is the primary evidence: it shows the router
  tools inside Codex's "mcp__qa_router" namespace tool, the compact
  catalog, the full tool descriptions, and the round-trip results.

  Codex advertises MCP tools as namespace children, so the log shows the
  qualified "mcp__qa_router__get_tool_schema" and
  "mcp__qa_router__invoke_tool" names. It does not truncate tool
  descriptions, so the long-description plan checks the complete catalog.

Background:
  Given the QA stack is running and I am in the workspace shell
  And I prepared the router home with "pnpm qa:setup"
  And I added the stdio mock server with "pnpm qa:router add stdio-mock --description 'QA stdio mock' --compression-level low -- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts"

@TC-CODEX-1
Scenario: Codex CLI is configured with the router server
  When I list the codex MCP servers with "pnpm qa:agent --agent codex --mcp-list"
  Then the JSON output contains a server named "qa-router"
  And the JSON output contains the command "node" and the argument "build/index.js"

@TC-CODEX-2
Scenario: Codex discovers the router tools and the stdio catalog
  Given I selected the mock LLM script "stdio-catalog" with "pnpm qa:llm script stdio-catalog"
  When I run the codex agent with "pnpm qa:agent --agent codex --prompt 'Test the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the mock LLM log shows the request tools "mcp__qa_router__get_tool_schema" and "mcp__qa_router__invoke_tool"
  And the mock LLM log shows the catalog section "## stdio-mock"
  And the mock LLM log shows the catalog tool line "add(a, b)"
  And the mock LLM log shows no downstream tool "echo" in the request tools
  And the mock LLM log shows no validation failures

@TC-CODEX-3
Scenario: Codex uses the router end to end
  Given I selected the mock LLM script "stdio-roundtrip" with "pnpm qa:llm script stdio-roundtrip"
  When I run the codex agent with "pnpm qa:agent --agent codex --prompt 'Add two numbers with the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the log shows a "get_tool_schema" call for server "stdio-mock"
  And the log shows an "invoke_tool" call for tool "add" with arguments 20 and 22
  And the log shows the tool result "42" in the next request
  And the agent transcript shows the "invoke_tool" call with output "42"
  And the log reports "0 failed" checks

@TC-CODEX-4
Scenario: Codex passes every downstream tool description to the model
  Given I selected the mock LLM script "stdio-descriptions" with "pnpm qa:llm script stdio-descriptions"
  When I run the codex agent with "pnpm qa:agent --agent codex --prompt 'Test the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the log shows the complete "echo" tool description
  And the log shows the complete "add" tool description
  And the log shows the complete "multi_block" tool description
  And the log shows the complete "failing_tool" tool description
  And the log reports "0 failed" checks

@TC-CODEX-5
Scenario: A very long tool description is not cut by Codex
  Given I selected the mock LLM script "long-description" with "pnpm qa:llm script long-description"
  When I run the codex agent with "pnpm qa:agent --agent codex --prompt 'Read the documented tool schema'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the log shows the catalog beginning "LONG-DESCRIPTION-HEAD"
  And the log shows the catalog ending "LONG-DESCRIPTION-TAIL"
  And the log shows the end of the long description in a "get_tool_schema" result
  And the log reports "0 failed" checks

@TC-CODEX-6
Scenario: Codex recovers from a guided argument error
  Given I selected the mock LLM script "retry" with "pnpm qa:llm script retry"
  When I run the codex agent with "pnpm qa:agent --agent codex --prompt 'Add two numbers with the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the log shows "Missing required argument" in a tool result
  And the log shows a corrected "invoke_tool" call with arguments 30 and 12
  And the log shows the tool result "42" in the next request
  And the log reports "0 failed" checks

@TC-CODEX-7
Scenario: A downstream error result reaches Codex
  Given I selected the mock LLM script "fail" with "pnpm qa:llm script fail"
  When I run the codex agent with "pnpm qa:agent --agent codex --prompt 'Call the failing tool on the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the agent transcript shows the "invoke_tool" call with output "boom"
  And the log shows "boom" in a tool result
  And the log reports "0 failed" checks

@TC-CODEX-8
Scenario: Closing Codex leaves no QA processes behind
  Given I selected the mock LLM script "stdio-roundtrip" with "pnpm qa:llm script stdio-roundtrip"
  When I run the codex agent with "pnpm qa:agent --agent codex --prompt 'Test the stdio mcp server'"
  Then running "pgrep -fl build/index.js" finds no router process
  And running "pgrep -fl qa/scripts/mock-mcp-stdio" finds no stdio mock process
