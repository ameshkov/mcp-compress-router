Feature: Driving Claude Code with the router
  Claude Code is the third coding agent of the QA stack. It speaks the
  Anthropic Messages API and runs headless against the mock LLM's
  Anthropic-compatible endpoint ("ANTHROPIC_BASE_URL" plus
  "ANTHROPIC_AUTH_TOKEN") with a hermetic "CLAUDE_CONFIG_DIR", so the
  plans exercise the real agent without an Anthropic account. The mock
  LLM log is the primary evidence: it shows the router tools under
  Claude's "mcp__qa-router__get_tool_schema" names, the compact catalog,
  the first-sentence descriptions, and the round-trip results.

  The stdio mock is added with "--compression-level low" so the compact
  catalog carries each tool's signature and first-sentence description,
  which is what the description plans verify. Full descriptions are
  never in the catalog, so the long-description plan checks that the
  catalog carries only the first sentence (the head marker) while the
  complete text still reaches the model through the "get_tool_schema"
  result.

  Claude Code cuts every tool description at 2048 characters and
  appends "… [truncated]", so a catalog that grows past that cap reaches
  the model truncated. The truncation plan adds a second stdio mock
  whose "--description" carries the long text (the one catalog field the
  router never compresses) and checks that the model sees the head and
  the truncation marker but not the tail, while the protocol probe shows
  the router's own catalog still carries the complete text.

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
Scenario: Claude Code receives the long description first sentence and the full schema result
  Given I selected the mock LLM script "long-description" with "pnpm qa:llm script long-description"
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

@TC-CLAUDE-9
Scenario: Claude Code truncates an over-long catalog description
  Given I selected the mock LLM script "long-catalog-truncated" with "pnpm qa:llm script long-catalog-truncated"
  And I added the stdio mock server with "pnpm qa:router add stdio-mock-long --description "$(pnpm --silent qa:long-description)" -- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts"
  When I run the claude agent with "pnpm qa:agent --agent claude --prompt 'Test the stdio mcp server'"
  And I show the mock LLM log with "pnpm qa:llm log"
  Then the log shows the catalog beginning "LONG-DESCRIPTION-HEAD"
  And the log shows a passed "catalogIncludes" check for "… [truncated]"
  And the log shows a passed "catalogExcludes" check for "LONG-DESCRIPTION-TAIL"
  And running "pnpm qa:probe --list" shows "LONG-DESCRIPTION-TAIL" in the "get_tool_schema" description
  And the log reports "0 failed" checks
