# Archon

An autonomous system designer. Give it an idea; it expands the open design decisions
breadth-first, researches what it doesn't know against the live web, and draws the
architecture on a tldraw canvas as it goes — then lets you scrub back and watch the
diagram build itself.

```
idea ──▶ Intake ──▶ ┌─────────── frontier of open decisions ───────────┐
                    │                                                   │
                    │   Expander ×N  ──needs current facts?──▶ Researcher (live search)
                    │       │                                    │      │
                    │       └──────────── OpBatch ◀──────────────┘      │
                    │                        │                          │
                    │                   reducer (validates, atomic)     │
                    │                        │                          │
                    │                   DesignGraph ──▶ ELK ──▶ tldraw  │
                    │                        │                          │
                    │                   Scorer / Pruner ────────────────┘
                    └─── halts on: frontier empty · plateau · budget · you ───┘
                                             │
                                   append-only op-log ──▶ replay / resume / scrub
```

## The one architectural rule

**The `DesignGraph` is the source of truth. tldraw is a projection of it.**

Agents emit typed graph operations — seven of them, none containing a coordinate. Layout
is computed deterministically by ELK. Shape ids derive from node ids, so re-projecting a
changed graph animates a diff rather than redrawing the canvas. This is what keeps a
multi-agent loop from turning the diagram into mush: no model is ever allowed to decide
where a box goes.

## Quickstart

```bash
pnpm install
cp .env.example .env      # add your XAI_API_KEY
pnpm dev                  # server :8787, canvas :5173
```

Open http://localhost:5173, describe a system, and watch it build.

## Agents

| Role | What it does | Model (default) |
|---|---|---|
| **Orchestrator** | Owns the loop and the frontier queue; enforces budget and halts | `grok-4.6` |
| **Expander** ×N | Resolves one decision → components, edges, child decisions | `grok-4.5` |
| **Researcher** | Live web/X search when a decision turns on facts that move | `grok-4.6` |
| **Scorer/Pruner** | Rates a branch on 7 dimensions; kills the weak ones | `grok-4.6` |
| **Critic** | Adversarial: attacks a branch, opens decisions for the holes | *not implemented* |
| **Vision-Validator** | Screenshot QA gate for rendering pathologies | *not implemented* |

Expanders run in parallel with an adaptive concurrency pool that halves on a 429. Each
writes through a serializing reducer with per-node version checks, so two agents touching
the same node can't clobber each other — the loser is re-queued with fresh context.

### When it researches

The Expander flags `needsResearch` only when the answer depends on facts that move —
current managed-service limits, recent benchmarks, real pricing, genuine state of the art
— not for timeless fundamentals. A Researcher then runs xAI's provider-executed
`webSearch`/`xSearch` over several steps and attaches its findings to the decision as a
node on the canvas; the Expander re-runs with those findings in context. Research is
capped at `RESEARCH_BUDGET_FRACTION` of the run budget because a single search-backed
call can cost 30× a plain one.

## Replay

Every batch is appended to a SQLite op-log with the prompt, model and response that
produced it. That single mechanism gives you:

- **Resume** — kill the server mid-run; restart rebuilds the graph and parks it paused.
- **Scrub** — the Replay slider re-derives the graph as of any point, so you can watch the
  expansion happen after the fact.
- **Zero-cost replay** — `MOCK_LLM=1` serves recorded responses and never hits the network.

Runs are deep-linkable at `/?run=<id>`.

## Human control

The loop is steerable while it runs, without stopping it:

- **pin** a decision or drag a node — protected from pruning, position becomes authoritative
- **kill** a branch
- **inject** a decision into the frontier
- **budget dial**, run/pause/step

Human ops carry `origin: "human"` and bypass optimistic concurrency: you always win.

## Configuration

| Var | Default | Notes |
|---|---|---|
| `XAI_API_KEY` | — | required |
| `MODEL_*` | `grok-4.6` / `grok-4.5` | per-role tiering |
| `MAX_NODES` / `MAX_DEPTH` | 200 / 6 | hard structural caps |
| `MAX_CHILDREN_PER_DECISION` | 4 | fan-out cap, tapered by depth |
| `MAX_CONCURRENCY` | 3 | parallel Expanders |
| `BUDGET_USD` | 2 | hard halt |
| `RESEARCH_BUDGET_FRACTION` | 0.4 | share of budget research may spend |
| `MOCK_LLM` | 0 | replay recorded responses |
| `ADMIN_TOKEN` | — | when set, gates all mutating routes |

## Dev vs prod

**Dev:** `pnpm dev` — Vite HMR, `tsx watch`, pretty logs, cheap Expander model,
`MOCK_LLM=1` for zero-cost UI work.

**Prod:** `pnpm build && pnpm start` — the server also serves the built canvas. JSON logs,
`ADMIN_TOKEN` gating, `DATA_DIR` as a volume. Or `docker build -t archon . && docker run
-p 8787:8787 -v archon-data:/data -e XAI_API_KEY=... archon`.

## Honest status

This is v0. What actually works: intake, parallel expansion, live research, scoring,
the graph→ELK→tldraw projection, SSE streaming, human ops, resume, and replay.

What is scaffolding, wired but inert:

- **Forests and pruning.** Every node currently inherits `branchId: "main"`, so there is
  one region and `pruneCandidates` never fires. The ranked-forest machinery is built and
  tested; nothing yet *creates* a rival branch. Plateau-halt is deliberately gated on
  having more than one branch so it can't masquerade as convergence.
- **Critic and Vision-Validator** are interfaces with `notImplemented` bodies.
- **Layout at scale.** `debounceLayout` is written but not wired; every commit runs a full
  ELK pass. Fine at 50 nodes, not at 500. The tree also lays out wide and shallow.

Known cost shape: a ~40-node run costs roughly $0.20 with one research call.

## Licensing note

tldraw's SDK is free to use but **watermarks the canvas** without a commercial license.
For non-commercial use that's fine; if you ship this in a product, get a license from
tldraw. Archon's own code is MIT.
