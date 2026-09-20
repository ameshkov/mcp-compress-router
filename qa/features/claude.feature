Feature: Driving Claude Code with the router
  Claude Code is the third coding agent of the QA stack. It speaks the
  Anthropic Messages API and runs headless against the mock LLM's
  Anthropic-compatible endpoint ("ANTHROPIC_BASE_URL" plus
  "ANTHROPIC_AUTH_TOKEN") with a hermetic "CLAUDE_CONFIG_DIR", so the
  plans exercise the real agent without an Anthropic account. The mock
  LLM log is the primary evidence: it shows the router tools under
  Claude's "mcp__qa-router__get_tool_schema" names, the compact catalog,
  the full tool descriptions, and the round-trip results.

  The stdio mock is added with "--compression-level low" so the compact
  catalog carries the full downstream tool descriptions, which is what
  the description plans verify. Claude Code truncates any single tool
  description at 2000 characters, so the long-description plan checks
  the truncation boundary instead of the complete catalog: the catalog
  head reaches the model, the tail does not, and the "get_tool_schema"
  result still carries the complete description.

Background:
  Given the QA stack is running and I am in the workspace shell
  And I prepared the router home with "pnpm qa:setup"
  And I added the stdio mock server with "pnpm qa:router add stdio-mock --description 'QA stdio mock' --compression-level low -- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts"

@TC-CLAUDE-1
Scenario: Claude Code is configured with the router server
  When I list the claude MCP servers with "pnpm qa:agent --agent claude --mcp-list"
  Then the output shows "qa-router: node build/index.js"
  And the output shows "Connected"

@TC-CLAUDE-2
Scenario: Claude Code discovers the router tools and the stdio catalog
  Given I selected the mock LLM script "stdio-catalog" with "pnpm qa:llm script stdio-catalog"
  When I run the claude agent with "pnpm qa:agent --agent claude --prompt 'Test the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the mock LLM log shows the request tools "mcp__qa-router__get_tool_schema" and "mcp__qa-router__invoke_tool"
  And the mock LLM log shows the catalog section "## stdio-mock"
  And the mock LLM log shows the catalog tool line "add(a, b)"
  And the mock LLM log shows no downstream tool "echo" in the request tools
  And the mock LLM log shows no validation failures

@TC-CLAUDE-3
Scenario: Claude Code uses the router end to end
  Given I selected the mock LLM script "stdio-roundtrip" with "pnpm qa:llm script stdio-roundtrip"
  When I run the claude agent with "pnpm qa:agent --agent claude --prompt 'Add two numbers with the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the log shows a "get_tool_schema" call for server "stdio-mock"
  And the log shows an "invoke_tool" call for tool "add" with arguments 20 and 22
  And the log shows the tool result "42" in the next request
  And the agent transcript shows the "invoke_tool" call with output "42"
  And the log reports "0 failed" checks

@TC-CLAUDE-4
Scenario: Claude Code passes every downstream tool description to the model
  Given I selected the mock LLM script "stdio-descriptions" with "pnpm qa:llm script stdio-descriptions"
  When I run the claude agent with "pnpm qa:agent --agent claude --prompt 'Test the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the log shows the complete "echo" tool description
  And the log shows the complete "add" tool description
  And the log shows the complete "multi_block" tool description
  And the log shows the complete "failing_tool" tool description
  And the log reports "0 failed" checks

@TC-CLAUDE-5
Scenario: Claude Code truncates the catalog but keeps the full tool schema result
  Given I selected the mock LLM script "long-description-truncated" with "pnpm qa:llm script long-description-truncated"
  When I run the claude agent with "pnpm qa:agent --agent claude --prompt 'Read the documented tool schema'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the log shows the catalog beginning "LONG-DESCRIPTION-HEAD"
  And the log shows a passed "catalogExcludes" check for "LONG-DESCRIPTION-TAIL"
  And the log shows the end of the long description in a "get_tool_schema" result
  And the log reports "0 failed" checks

@TC-CLAUDE-6
Scenario: Claude Code recovers from a guided argument error
  Given I selected the mock LLM script "retry" with "pnpm qa:llm script retry"
  When I run the claude agent with "pnpm qa:agent --agent claude --prompt 'Add two numbers with the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the log shows "Missing required argument" in a tool result
  And the log shows a corrected "invoke_tool" call with arguments 30 and 12
  And the log shows the tool result "42" in the next request
  And the log reports "0 failed" checks

@TC-CLAUDE-7
Scenario: A downstream error result reaches Claude Code
  Given I selected the mock LLM script "fail" with "pnpm qa:llm script fail"
  When I run the claude agent with "pnpm qa:agent --agent claude --prompt 'Call the failing tool on the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the agent transcript shows the "invoke_tool" call mentioning "boom"
  And the log shows "boom" in a tool result
  And the log reports "0 failed" checks

@TC-CLAUDE-8
Scenario: Closing Claude Code leaves no QA processes behind
  Given I selected the mock LLM script "stdio-roundtrip" with "pnpm qa:llm script stdio-roundtrip"
  When I run the claude agent with "pnpm qa:agent --agent claude --prompt 'Test the stdio mcp server'"
  Then running "pgrep -fl build/index.js" finds no router process
  And running "pgrep -fl qa/scripts/mock-mcp-stdio" finds no stdio mock process
