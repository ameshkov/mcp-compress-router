Feature: Driving opencode with a real OpenRouter model
  These plans are opt-in, and unlike every other plan they talk to a real
  model over the network. They need an OpenRouter API key in qa/.env
  ("QA_OPENROUTER_API_KEY", plus the optional "QA_REAL_LLM_MODEL") and a
  workspace container recreated with it; see qa/README.md. There is no
  mock LLM script and no mock LLM log: the evidence is the agent
  transcript and the mock MCP server logs, which show that the real model
  discovered the router and actually used the downstream servers.

  The prompts describe ordinary user tasks and never name a tool, so the
  model has to find the tool through the router the way it would in a
  real session. The plans verify the transcript (the
  "get_tool_schema"/"invoke_tool" call and its result) plus the
  downstream call log. The tasks use the lifelike weather mock
  (`mock-mcp-weather.ts`), whose fixed data makes the expected results
  exact.

Background:
  Given the QA stack is running and I am in the workspace shell
  And I prepared the router home with "pnpm qa:setup"
  And I added the weather mock server with "pnpm qa:router add weather --description 'Live weather forecasts and current conditions' --env MOCK_MCP_TOOLS=weather --env MOCK_CALL_LOG=/tmp/qa-weather-calls.log -- node_modules/.bin/tsx qa/scripts/mock-mcp-stdio/server.ts"

@TC-REALLLM-1
Scenario: A real model discovers the tools of a connected server
  When I run "pnpm qa:agent --real-llm --prompt 'I am planning a trip and want to know what weather information you can get for me. List the available tools and their arguments.'"
  Then the transcript shows a "get_tool_schema" call for server "weather"
  And the transcript shows the tool signatures "get_forecast(city, days)" and "get_current_conditions(city)"
  And the transcript shows the assistant reporting the tool names

@TC-REALLLM-2
Scenario: A real model uses the stdio server to answer a weather question
  When I run "rm -f /tmp/qa-weather-calls.log"
  And I run "pnpm qa:agent --real-llm --prompt 'I am flying to Berlin tomorrow and cannot decide whether to pack an umbrella. Will I need one?'"
  Then the transcript shows an "invoke_tool" call for server "weather"
  And the transcript shows the forecast result "light rain"
  And running "cat /tmp/qa-weather-calls.log" shows a "tools/call get_forecast" line

@TC-REALLLM-3
Scenario: A real model uses a streamable-http server to answer a weather question
  Given I prepared the router home with "pnpm qa:setup"
  And I added the weather streamable-http server with "pnpm qa:router add weather-http --description 'Live weather forecasts and current conditions' http://mock-mcp-weather:3102/mcp"
  When I run "pnpm qa:agent --real-llm --prompt 'I am in Lisbon and about to go for a run. What is the weather like outside right now?'"
  Then the transcript shows an "invoke_tool" call for server "weather-http"
  And the transcript shows the current conditions result "clear skies"
  And the host command "docker compose -f qa/docker-compose.yml logs mock-mcp-weather" shows a "tools/call get_current_conditions" line

@TC-REALLLM-4
Scenario: A real model chains tool calls to compare forecasts
  When I run "rm -f /tmp/qa-weather-calls.log"
  And I run "pnpm qa:agent --real-llm --prompt 'I want to escape the heat this weekend. Which of the cities your weather service supports will be coldest tomorrow?'"
  Then the transcript shows an "invoke_tool" call for server "weather" with tool "list_cities"
  And the transcript shows "invoke_tool" calls for server "weather" with tool "get_forecast" for at least two of the supported cities
  And the transcript shows the assistant naming the Reykjavík forecast (6°C) as the coldest
  And running "cat /tmp/qa-weather-calls.log" shows a "tools/call list_cities" line and a "tools/call get_forecast" line
