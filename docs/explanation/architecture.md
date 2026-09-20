# About the architecture

Why MCP Compress Router is structured the way it is. The rules an agent
must follow live in the Architecture section of
[AGENTS.md](../../AGENTS.md#architecture); this document explains the
reasoning behind them. For startup and shutdown, see
[About the process lifecycle](./process-lifecycle.md).

## Why a layered architecture

The router has to talk to two very different worlds: the host's MCP
session on one side and an arbitrary number of downstream MCP servers
on the other. Those worlds change for different reasons — the host
protocol and the tool surface on one side, downstream transports,
OAuth, caching, and recovery on the other. Keeping them apart is what
makes the codebase navigable and testable.

The code is therefore split into four layers, each depending only on
the layers below it:

- **Entry point** (`src/index.ts`) — wires dependencies, registers tool
  handlers, and starts the stdio transport.
- **Tool handlers** (`src/tools/`) — parse parameters, delegate to core
  services, and format responses.
- **Core services** (`src/services/`) — catalog building, downstream
  discovery and connections, configuration, OAuth, and shutdown.
- **Utilities** (`src/utils/`) — parsing, validation, filtering,
  formatting, atomic writes, timeouts, and logging.

The dependency flow is one-way:

```text
Entry point (index.ts)
     ↓
Tool handlers (tools/)
     ↓
Core services (services/)
     ↓
Utilities (utils/)
```

A tool handler cannot reach into a transport client, and a service
cannot depend on a handler. When a change is needed, the layer it
belongs to is usually obvious, and the blast radius stays small.

## Why tool handlers receive only the catalog

The entry point builds the catalog from the discovered servers and
injects it into the handlers. Handlers never receive transport clients,
raw server connections, or configuration objects.

This keeps the handler surface narrow: a handler can answer "which
tools exist" and "call this tool" without knowing how a server was
spawned, whether it speaks stdio or HTTP, or where its credentials came
from. Those details stay in the connection layer, where they are wired
together once. It also makes handlers straightforward to test — a test
can build a catalog directly instead of standing up a real downstream
server.

The same boundary is why business logic lives in `src/services/` and
never in `src/tools/`: the tools module is a thin adapter between the
MCP protocol and the router's core.

## Why the layers are enforced

Barrel `index.ts` files define each module's public API, and code
outside a module imports only from its barrel. That is what keeps the
dependency direction honest: if a module's internals can only be
reached through its barrel, a lower layer cannot quietly grow a
dependency on a higher one.

TypeScript strict mode and runtime validation at the boundaries
(config parsing, argument validation) make illegal states hard to
construct in the first place. For a process that sits between a host
and several downstream servers, failing early and loudly at the
boundary is far cheaper than debugging a malformed state later.
