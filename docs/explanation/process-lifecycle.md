# About the process lifecycle

Why the router owns its startup and shutdown, and what goes wrong when
it does not. The rules an agent must follow live in the Architecture
section of [AGENTS.md](../../AGENTS.md#architecture).

## Startup must fit the host's budget

A coding agent launches the router at session start and waits for the
MCP `initialize` response before it can show any tools. The host's
budget for that handshake is on the order of 30 seconds. If the router
connected to downstream servers one after another, a single slow server
could eat that budget on its own, so all downstream connects and OAuth
metadata probes run concurrently.

Concurrency alone is not enough: the MCP SDK leaves several awaits in
the connect path unbounded, and a hung dependency would stall startup
forever. The stdio child-process spawn, the HTTP SSE session GET, and
the OAuth metadata and token handshakes are therefore bounded — but
only at the response-header phase. Once a stream or a long-running
tool call has started, capping it would break legitimate work, so SSE
bodies and tool-call POSTs are never capped.

## Host first, downstream second

The router answers the host's `initialize` before any downstream server
has connected. The host sees the router immediately; the catalog fills
in as discovery completes. Tool calls and `tools/list` wait for
discovery — bounded by the per-server connect timeouts and aborted on
shutdown — so the compact catalog always reflects the final discovery
state instead of a half-built one.

The ordering also protects cleanup. The router installs its shutdown
triggers (stdin EOF and signals) and its connection-cleanup hook before
it spawns the first downstream child. If the host disconnects while
connections are still being established, the in-flight children are
terminated instead of being orphaned.

## The router owns its shutdown

The host is not responsible for stopping the router, and in practice it
often just closes the router's stdin pipe. The MCP SDK's stdio server
transport does not listen for stdin EOF, so without an explicit handler
the router would linger forever as a ghost process — and the downstream
servers it spawned, plus their own children (such as browser processes
forked by a downstream server), would keep the event loop alive even
longer.

The router therefore wires a `ShutdownCoordinator`
(`src/services/shutdown-coordinator.ts`) that owns the process
lifecycle. `installShutdownTriggers` trips it on `SIGINT`, `SIGTERM`,
`SIGHUP`, or stdin EOF; every spawned resource registers a cleanup
hook; the entry point awaits `whenShutdown()` so the process stays
alive while serving and exits the moment cleanup finishes; and it
force-exits afterwards so a lingering grandchild pipe cannot trap the
process.

## Terminating the whole process tree

Downstream stdio servers are often launched through a wrapper such as
`npx` or `npm exec`. The SDK signals only the process it spawned
directly, which would leave the real MCP server — a grandchild holding
the inherited stdio pipes — running as an orphan. Cleanup therefore
resolves the descendants from a process snapshot and terminates the
whole tree through `killProcessTree` (`src/utils/process-tree.ts`).

One more subtlety: when a downstream handshake fails, the SDK starts
the transport close fire-and-forget. Cleanup awaits that close even
though the SDK does not, so `process.exit` cannot cut it short before
the child is gone.
