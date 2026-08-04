# Roadmap Concept Map — the ideas underneath each phase

Same treatment as 1.2 (ontology) and 1.5/1.6 (kinetics/dynamics), applied
across the whole roadmap. The point isn't decoration — naming the concept
correctly tells you which existing body of design knowledge to borrow from
when a task gets ambiguous, instead of reinventing it from scratch.

---

## Phase 1 — Model-Agnostic Harness

| Task | Concept | Why it fits |
|---|---|---|
| 1.1 (LiteLLM vs. shim) | **Seam placement** (build-vs-buy at an abstraction boundary) | You're not choosing a tool, you're deciding *where the interface line sits* — what's yours to own vs. what's safe to depend on. Same decision shape as choosing where a class boundary goes. |
| 1.2 (unified schema) | **Ontology** | Already established — the shared concepts (Message, ToolCall, Response) and their relations, independent of provider vocabulary. |
| 1.3 (provider adapters) | **Adapter pattern** (GoF) | Textbook case: one target interface, multiple incompatible concrete implementations behind it. |
| 1.4 (config routing) | **Strategy pattern + late binding** | Behavior (which provider/model) is selected by configuration at runtime, not hardcoded — the same idea as dependency injection. |
| 1.5 (conversation manager) | **Kinetics / state machine** | Already established — how state evolves turn by turn, not what it's made of. |
| 1.6 (tool-calling) | **Protocol** (shared contract both sides honor) + **Command pattern** | A ToolCall is an action request encapsulated as data, dispatched generically — the model and your dispatcher agree on a protocol neither owns outright. |
| 1.7 (capstone refactor) | **Strangler fig pattern** | Replacing direct provider calls with harness calls incrementally, in a live project, without a big-bang rewrite — the standard pattern for exactly this kind of migration. |

---

## Phase 2 — Local / Self-Hosted Inference

| Task | Concept | Why it fits |
|---|---|---|
| Model family selection | **Taxonomy** | Classifying by license, size, language support is literally a classification hierarchy — same intellectual move as biological taxonomy, applied to model choice. |
| Inference engines (Ollama/vLLM/llama.cpp) | **Runtime selection** | Choosing an execution environment for a fixed workload, trading startup simplicity (Ollama) against throughput (vLLM) — same tradeoff shape as choosing a language runtime. |
| Quantization | **Lossy compression** (information theory) | Precision-for-size tradeoff with a measurable degradation curve — not a hack, a real compression problem with known techniques (GGUF/AWQ/GPTQ are different points on that curve). |
| GPU sizing math | **Capacity planning** | Estimating resource needs ahead of load, the same discipline as provisioning servers for expected traffic. |

---

## Phase 3 — Infra & Deployment

| Task | Concept | Why it fits |
|---|---|---|
| Docker containerization | **Encapsulation** | Bundling a component with its dependencies into a sealed, portable unit — structural, like 1.2's ontology but at the deployment-unit level instead of the data level. |
| Kubernetes / docker-compose | **Orchestration** | Coordinating multiple encapsulated units over time (restart, scale, network) — this is Phase 3's kinetics: containers are the ontology, orchestration is the dynamics. |
| On-prem vs. private cloud | **Trust boundary** | The real question isn't "where does it run" but "what crosses which boundary" — a threat-modeling concept before it's an infra one. |
| Networking (VPC/firewall/air-gap) | **Topology** | A graph of trust zones and allowed edges between them — literally a graph structure with access rules as edge constraints. |

---

## Phase 4 — Data Governance & Security

| Task | Concept | Why it fits |
|---|---|---|
| Data residency | **Provenance / lineage** | Tracking where a piece of data has *been*, not just where it is now — an extension of the ontology idea (what a "record" is) into its history. |
| Access control / encryption | **Authorization model** (RBAC/ABAC) | This is itself a small ontology — roles, resources, permissions, and the relations between them — that needs the same rigor 1.2 got. |
| Audit logging | **Event sourcing** | Recording every state transition as an immutable, ordered event rather than just current state — this is Phase 4's version of kinetics: the log *is* the recorded history of the system's dynamics. |
| Regulatory frame (EU AI Act, SDAIA) | **Compliance mapping** | Translating one jurisdiction's rule-set onto your system's actual behavior — structurally similar to 1.3's provider translation, just mapping law instead of API shape. |

---

## Phase 5 — Productize

| Task | Concept | Why it fits |
|---|---|---|
| Multi-tenant config | **Generalization** (instance → template) | Turning one working system into a parameterized class of systems — the class/instance relationship from 1.2's ontology, now applied to whole deployments instead of messages. |
| LoRA/QLoRA fine-tuning | **Transfer learning** | Teaching a general-purpose model your client's specific vocabulary and tone — literally adapting a model to a domain ontology, a nice full-circle back to 1.2. |
| Onboarding checklist / template repo | **Metaprogramming** | A repo that generates configured repos — same idea as a code generator, one level up. |

---

## The throughline

Ontology and kinetics aren't just 1.2/1.5 concepts — they're a lens that
recurs at every phase, just at a different scale each time:

- **Structure (ontology-shaped):** 1.2's schema, Phase 3's containers, Phase 4's
  RBAC model, Phase 5's multi-tenant template — "what things are and how they
  relate."
- **Dynamics (kinetics-shaped):** 1.5's conversation state, Phase 3's
  orchestration, Phase 4's event-sourced audit log — "how things change over
  time."

Worth checking any new task against this split as you go: if something feels
hard to design, it's often because it's mixing both (a schema field that's
secretly stateful, an orchestration rule that's secretly a permission). Split
it and the design usually gets easier.
