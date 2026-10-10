Feature: Driving GitHub Copilot CLI with the router
  Copilot CLI is the second coding agent of the QA stack. It runs in
  BYOK mode against the scripted mock LLM ("COPILOT_PROVIDER_*" plus
  "COPILOT_OFFLINE=true") with a hermetic "COPILOT_HOME", so the plans
  exercise the real agent without a GitHub account. The mock LLM log is
  the primary evidence: it shows the router tools under Copilot's
  hyphenated names ("qa-router-get_tool_schema"), the compact catalog,
  and the round-trip results.

  The catalog in the "get_tool_schema" description is always compact:
  each server with tools appears as a single bullet with its tool count
  and description, and the description ends with a list-mode hint. Tool
  names, argument signatures, and tool descriptions are never in the
  catalog; the model reads them with a "get_tool_schema" list or schema
  call, which the description plans verify.

Background:
  Given the QA stack is running and I am in the workspace shell
  And I prepared the router home with "pnpm qa:setup"
  And I added the stdio mock server with "pnpm qa:router add stdio-mock --description 'QA stdio mock' -- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts"

@TC-COPILOT-1
Scenario: Copilot CLI is configured with the router server
  When I list the copilot MCP servers with "pnpm qa:agent --agent copilot --mcp-list"
  Then the output shows "qa-router (local)"

@TC-COPILOT-2
Scenario: Copilot discovers the router tools and the compact stdio catalog
  Given I selected the mock LLM script "stdio-catalog" with "pnpm qa:llm script stdio-catalog"
  When I run the copilot agent with "pnpm qa:agent --agent copilot --prompt 'Test the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the mock LLM log shows the request tools "qa-router-get_tool_schema" and "qa-router-invoke_tool"
  And the mock LLM log shows the catalog bullet "- stdio-mock (6 tools)"
  And the mock LLM log shows the catalog hint "Call get_tool_schema with the server name to list all tools"
  And the mock LLM log shows no downstream tool "echo" in the request tools
  And the mock LLM log shows a passed "catalogExcludes" check for "echo"
  And the mock LLM log shows the list-mode signature "echo(message)"
  And the mock LLM log shows no validation failures

@TC-COPILOT-3
Scenario: Copilot uses the router end to end
  Given I selected the mock LLM script "stdio-roundtrip" with "pnpm qa:llm script stdio-roundtrip"
  When I run the copilot agent with "pnpm qa:agent --agent copilot --prompt 'Add two numbers with the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the log shows a "get_tool_schema" call for server "stdio-mock"
  And the log shows an "invoke_tool" call for tool "add" with arguments 20 and 22
  And the log shows the tool result "42" in the next request
  And the agent transcript shows the "invoke_tool" call with output "42"
  And the log reports "0 failed" checks

@TC-COPILOT-4
Scenario: Copilot passes every downstream tool description to the model
  Given I selected the mock LLM script "stdio-descriptions" with "pnpm qa:llm script stdio-descriptions"
  When I run the copilot agent with "pnpm qa:agent --agent copilot --prompt 'Test the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the log shows the complete "echo" tool description in the schema result
  And the log shows the complete "add" tool description in the schema result
  And the log shows the complete "multi_block" tool description in the schema result
  And the log shows the complete "failing_tool" tool description in the schema result
  And the log reports "0 failed" checks

@TC-COPILOT-5
Scenario: A long tool description reaches Copilot complete through the schema result
  Given I selected the mock LLM script "long-description" with "pnpm qa:llm script long-description"
  When I run the copilot agent with "pnpm qa:agent --agent copilot --prompt 'Test the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the log shows no "LONG-DESCRIPTION-HEAD" in the catalog
  And the log shows no "LONG-DESCRIPTION-TAIL" in the catalog
  And the log shows the complete long description in a "get_tool_schema" result
  And the log reports "0 failed" checks

@TC-COPILOT-6
Scenario: Copilot recovers from a guided argument error
  Given I selected the mock LLM script "retry" with "pnpm qa:llm script retry"
  When I run the copilot agent with "pnpm qa:agent --agent copilot --prompt 'Add two numbers with the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the log shows "Missing required argument" in a tool result
  And the log shows a corrected "invoke_tool" call with arguments 30 and 12
  And the log shows the tool result "42" in the next request
  And the log reports "0 failed" checks

@TC-COPILOT-7
Scenario: A downstream error result reaches Copilot
  Given I selected the mock LLM script "fail" with "pnpm qa:llm script fail"
  When I run the copilot agent with "pnpm qa:agent --agent copilot --prompt 'Call the failing tool on the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the agent transcript shows the "invoke_tool" call with an error mentioning "boom"
  And the log shows "boom" in a tool result
  And the log reports "0 failed" checks

@TC-COPILOT-8
Scenario: Closing Copilot leaves no QA processes behind
  Given I selected the mock LLM script "stdio-roundtrip" with "pnpm qa:llm script stdio-roundtrip"
  When I run the copilot agent with "pnpm qa:agent --agent copilot --prompt 'Test the stdio mcp server'"
  Then running "pgrep -fl build/index.js" finds no router process
  And running "pgrep -fl qa/scripts/mock-mcp-stdio" finds no stdio mock process
