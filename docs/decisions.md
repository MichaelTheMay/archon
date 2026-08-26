# Design decisions

Archon's design was settled in six grill iterations. Iterations 1-4 were done before any
code existed; 5 and 6 were done against the running system, and several of their entries
exist only because the scaffold contradicted an earlier assumption.

## Iterations 1-4 (pre-code)

| # | Decision | Resolution |
|---|---|---|
| 1 | Output shape | Ranked forest of candidate architectures; the top branch is "the answer" |
| 2 | Unit of expansion | Open *design decisions*, materialised as a component graph — not boxes |
| 3 | Halt condition | frontier-empty OR plateau OR budget OR human. "Indefinite" means *resumable* |
| 4 | Model | xAI `grok-4.6`, confirmed live via `/v1/models`; per-role tiering |
| 5 | Agent roster | Orchestrator(1) · Expander(N) · Critic(M) · Scorer/Pruner · Vision-Validator |
| 6 | Source of truth | External typed `DesignGraph`; tldraw is a projection + edit surface |
| 7 | Concurrency | Branch-scoped optimistic ops through a serializing reducer |
| 8 | Vision loop | A sparse QA gate, not a reasoning input. Graph metrics answer most of it free |
| 9 | Optimality | Relative to an elicited requirement set, surfaced on-canvas as editable nodes |
| 10 | Stack | TS monorepo · Vite+React+tldraw · Hono · AI SDK · SQLite op-log · SSE |
| 11 | Human control | pin · kill · inject · steer, live, without stopping the loop |
| 12 | Auditability | Append-only op-log with cached prompts → deterministic replay |
| 13 | Failure modes | Runaway fan-out · sibling incoherence · invalid ops · cost blowout · generic convergence |
| 14 | MVP cut | Orchestrator + parallel Expanders + Scorer + projection + live draw + resume |

Two requirements were added mid-build and folded in: **deep research agents**, dispatched
when a decision turns on facts that move (decision 20), and **a recorded, replayable
expansion** rather than a merely streamed one (decision 21).

## Iteration 5 — what the scaffold revealed

**15. Atomic batches plus rejection-based caps is a footgun.**
The reducer enforced a fan-out cap by rejecting; batches are all-or-nothing; so one
over-eager field discarded an entire turn *including the resolution that earned it*. The
first real run died exactly here: intake produced more nodes than `MAX_NODES` and the run
halted with an empty canvas. Caps are now enforced by **truncation at the compile
boundary** (`compileOps`, `compileIntakeOps`), and intake throws loudly rather than
falling through to a `frontier_empty` halt that reads like success.

**16. Node creation must be idempotent.**
Two parallel Expanders, each seeing only its 2-hop local context, independently proposed
`c_mapping_store`. Under the original reducer that was "node exists" → whole batch
rejected → the expander's work thrown away. But two agents converging on the same
component is *agreement*. `addNode` and `openDecision` on an existing id are now no-ops.

**17. Breadth-first over decisions does not terminate on its own.**
Observed 20 decisions against 5 components: expansion opens questions faster than it
closes them, so the frontier never empties and every run terminates on budget rather than
convergence. Fan-out allowance is now **tapered by depth** and hits zero at the depth
limit. Confirmed by a full run: it halted on **`frontier_empty`** with 0 open decisions,
14 resolved and 14 components, for $0.47. The taper makes the tree close itself rather
than merely slowing its growth.

**18. Only structural edges may drive layout.**
`satisfies` fans from every component back to a handful of shared requirements. Fed to
ELK, it collapsed the tree into one flat unreadable hairball. Layout now runs on
`child_of`/`flows`/`depends_on` only, and `satisfies` is not drawn at all — the coverage
it encodes is surfaced in the score table instead. This is the concrete form of decision
8: graph metrics beat pixels.

**19. Research is expensive and must be capped separately.**
A single search-backed call measured **72k input tokens** — roughly 30× a plain expander
call. Research is gated behind `RESEARCH_BUDGET_FRACTION` (default 0.4) so a curious run
cannot spend the whole budget searching. Cost shape for a ~40-node run: about $0.20.

**20. Structured output and provider-executed tools compose.**
Probed before building on it: `generateText` + `Output.object` + xAI `webSearch` works in
a single call and really does search. The planned two-step (gather, then extract) was
unnecessary.

**21. The canvas is a projection, so it must not offer drawing tools.**
tldraw's toolbar and style panel invite edits that the next layout pass silently discards.
Editing chrome is hidden; navigation stays. The one edit that *is* meaningful — dragging a
node — is captured as a pin, and ELK's output is overwritten for pinned nodes because
`elk.position` is only a hint under `layered`.

**21b. A blocked call blocks the whole loop.**
A run sat `running` for minutes with zero nodes and no error: the orchestrator awaits each
LLM call, so one stalled socket parks the entire run silently. Calls now carry a wall-clock
timeout, longer for tool-using research. The related orphan case — a run whose owning
process dies *after* boot stays `running` forever, because the recovery sweep only runs at
startup — is still open.

**21c. Human ops must bypass structural caps, not just concurrency.**
"You always win" was only half true: human batches skipped `baseVersions` but were still
subject to the fan-out cap. Since the taper (17) means deep nodes legitimately sit at the
cap, asking a follow-up on exactly the nodes deep expansion produces returned a silent 409.
Human origin now bypasses the fan-out cap, and rejected edits surface in the UI — a
silently dropped instruction is worse than a visible error, because the user assumes the
loop took it.

**21d. One prompt, not a form.**
Intake originally asked for an idea plus a separate constraints field, which is not how
anyone describes a system out loud. It is now a single free-text box, and the Orchestrator's
job starts earlier: read the constraints out of casual prose and record each reading as a
correctable assumption. "Update basically instantly" became a p99 ≤ 500ms requirement plus
an assumption quoting the phrase and naming the number chosen — which is exactly the
behaviour decision 9 asked for, surfaced where a human can argue with it.

**21e. Text overflow is not overlap, and it is the thing that actually looks broken.**
Nodes appeared to collide while the layout reported zero overlapping boxes: sizes were
hardcoded constants and labels were full sentences, so text spilled over its own borders
onto neighbours. Size is now derived from the label and shared by ELK and the canvas —
they must agree or the bug returns. Diamonds and ellipses get extra slack because their
inscribed text area is much smaller than their bounding box, which is why decision nodes
were the worst offenders. A deterministic `separate()` pass handles the one case ELK
cannot: a human dragging a node on top of another.

**21f. A projection must refuse edits it cannot keep.**
Typing over a shape entered tldraw's in-place text editor, and the next layout pass would
have silently discarded the result. Edit mode is now refused on the canvas; the Inspector
is where text changes. Same principle as hiding the drawing tools — never offer an
interaction whose effect you are about to throw away.

## Iteration 6 — what v1 should be, in order

**22. Create rival branches.** The largest gap between the design and the build: every
node inherits `branchId: "main"`, so the ranked-forest machinery — scoring, pruning,
plateau detection — is fully built, tested, and inert. A run currently hill-climbs one
architecture, which decision 1 explicitly rejected. The fix is to have high-stakes
decisions *fork* rather than resolve. Everything downstream already works.

**23. Critic before Vision.** Both are stubs, but they are not equal. The Critic attacks
the failure mode that actually threatens output quality — generic, plausible designs whose
components no requirement justifies. `weakRationale` already flows from Scorer to score;
the Critic turns those flags into decisions. Vision QA addresses a cosmetic problem that
graph metrics (`layoutMetrics`, already written) largely cover.

**24. Decision dedup by embedding.** Decision 20 of the original design, still unbuilt.
Idempotent ids (15) catch only exact collisions; two Expanders phrasing the same question
differently both survive. Cosine > 0.92 against the open frontier, merging into the
earlier id.

**25. Layout at scale.** `debounceLayout` is written and unwired; every commit runs a full
ELK pass over the whole graph. Fine at 50 nodes, not at 500. Wire it, and lay out
requirements as a separate compact cluster rather than as root's children — they are
context, not tree, and they are what makes the canvas so wide.

**26. Multi-provider.** The provider layer is already role-keyed and model-agnostic in
shape but hard-wired to `createXai`. Adding Anthropic/OpenAI adapters is small and removes
the single-vendor risk flagged in iteration 1.

**27. Don't claim more than is built.** The README names forests, pruning, Critic and
Vision as inert scaffolding rather than features. A system that designs systems loses its
whole claim to judgement the moment its own documentation oversells it.
