# ADR 0001: TypeScript packages, type ownership, and GPU boundaries

Status: accepted for implementation planning.

This decision refines implementation structure only. It does not revise a frozen public contract or add code, packages, dependencies, or measurements.

## Decision 1: TypeScript npm workspace

**Chosen option.** Use strict TypeScript ES modules in an npm workspace with project references and exactly the six frozen package names. Keep a private browser demo outside the publishable packages.

**Rationale.** The frozen contracts are already expressed in TypeScript and use browser/WebGPU types. Workspace boundaries make the frozen dependency direction mechanically testable while allowing package-local builds and tests.

**Rejected alternatives.** A single package obscures provider and renderer boundaries. Separate repositories make atomic contract changes and deterministic integration tests harder. JavaScript-only sources lose compile-time contract checking. Additional shared packages would violate the required six-name organization.

**Consequences.** Initial scaffolding must establish shared compiler settings, export maps, project references, and dependency checks. Tool and dependency selection remains a separately reviewed implementation change.

**Reversibility.** Partially reversible. Build tooling may change without altering contracts; splitting or merging published packages would be a costly public migration and would require specification review.

## Decision 2: Core owns boundary types

**Chosen option.** `@web-ar-occlusion/core` owns and exports all cross-package public types. Provider and renderer packages import those types but core imports no implementations.

**Rationale.** With only the six frozen packages, one canonical owner avoids duplicate types and circular dependencies. Core already owns orchestration and the public engine contract.

**Rejected alternatives.** A seventh contracts package contradicts the six-package constraint. Letting `motion` own only motion contracts would force core to depend on an implementation-oriented package and create asymmetric type ownership. Structural copies permit drift.

**Consequences.** Provider packages have a type/runtime dependency on core's contract exports, so core must keep implementation modules out of contract import paths and must not use implementation registration side effects.

**Reversibility.** Reversible before publication. After publication, moving exported types requires compatibility re-exports and a versioned migration.

## Decision 3: Directed package graph

**Chosen option.** Provider implementations and renderer integrations depend inward on core; the demo is the composition root. Core never discovers implementations automatically.

**Rationale.** Explicit construction preserves replaceability, prevents renderer/model coupling, and directly enforces the frozen dependency direction.

**Rejected alternatives.** A global provider registry adds hidden state. Core-to-provider imports invert the frozen direction. Renderer ownership of the engine makes the engine non-portable.

**Consequences.** Applications must explicitly create providers and adapters. Each integration carries its renderer as a peer dependency when implemented.

**Reversibility.** Reversible internally, but automatic discovery would require a new reviewed public behavior.

## Decision 4: Canonical GPU texture formats

**Chosen option.** Accept the limited provider and virtual-depth formats listed in the implementation plan, normalize on GPU to `r32float` canonical depth and `r8unorm` confidence, and emit `r8unorm` occlusion. Keep all public depth transport in `GPUTexture`.

**Rationale.** A small explicit format set permits deterministic bind layouts and conformance checks while supporting common scalar float provider output. `r32float` preserves the canonical metre representation; `r8unorm` directly represents normalized confidence and soft masks.

**Rejected alternatives.** An arbitrary-format boundary cannot be safely interpreted without adding fields to the frozen contract. CPU conversion/readback violates the frozen GPU-native path. Packing depth into RGBA complicates conventions and shader tests without an MVP need. Mandating one provider input format needlessly pushes conversion into every provider.

**Consequences.** The engine needs GPU normalization passes and separate bindings for color and depth virtual textures. Unsupported formats degrade to no occlusion with telemetry. Format expansion requires conformance fixtures.

**Reversibility.** Additively reversible: more GPU formats may be supported without changing existing semantics. Canonical or output format changes would affect integrations and require a versioned decision.

## Decision 5: Explicit resource ownership and borrowed outputs

**Chosen option.** Providers own input textures until keyframe release; core owns canonical/history/output resources; output textures are borrowed until the next successful update or disposal.

**Rationale.** Explicit lifetimes prevent use-after-destroy and unbounded per-frame allocation while keeping the exact texture-based output contract.

**Rejected alternatives.** Transferring texture ownership implicitly makes provider reuse unsafe. Caller-owned output allocation expands the public contract. Permanent validity for every output forces unbounded allocation or hidden copies.

**Consequences.** The engine must document release points, retain resources through submitted GPU work, and validate same-device use. Callers needing longer retention must copy on GPU into their own texture.

**Reversibility.** Borrow duration can be extended compatibly. Changing ownership or requiring caller allocations would be a breaking contract decision.
