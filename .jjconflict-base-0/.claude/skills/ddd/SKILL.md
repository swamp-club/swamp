---
name: ddd
description: Domain Driven Design guidance for TypeScript/Deno codebases. Apply when writing or modifying code to choose appropriate DDD building blocks (entities, value objects, aggregates, domain services, repositories) and maintain ubiquitous language. Triggers on all code changes to ensure domain model consistency.
---

# Domain Driven Design

Apply these patterns when implementing domain logic in TypeScript/Deno.

## Building Block Selection

Choose the appropriate type based on these criteria:

| Type               | Identity                 | Mutability              | When to Use                                                      |
| ------------------ | ------------------------ | ----------------------- | ---------------------------------------------------------------- |
| **Value Object**   | None (equality by value) | Immutable               | Measurements, descriptions, identifiers, money, dates, addresses |
| **Entity**         | Has unique ID            | Mutable                 | Things with lifecycle, tracked over time, referenced by ID       |
| **Aggregate**      | Root entity + children   | Root controls mutations | Consistency boundary, transactional unit, enforce invariants     |
| **Domain Service** | None                     | Stateless               | Operations spanning multiple aggregates, external integrations   |
| **Repository**     | None                     | Stateless               | Persistence abstraction for aggregates only                      |

### Quick Decision Flow

```
Does it have a unique identity that matters?
├─ No → Value Object
└─ Yes → Does it enforce invariants over child objects?
         ├─ Yes → Aggregate Root
         └─ No → Entity (likely part of an aggregate)
```

## TypeScript Patterns

See [references/patterns.md](references/patterns.md) for implementation
examples.

## Ubiquitous Language

Update the project's ubiquitous language glossary when:

- **New domain concept** introduced (add term + definition)
- **Meaning clarified** through discussion (refine definition)
- **Naming conflicts** discovered (resolve and document)
- **Bounded context boundary** identified (note context for term)

Location: Document terms in code via types/interfaces. Add non-obvious terms to
project documentation.

### Naming Rules

- Use domain expert terminology, not technical jargon
- Prefer nouns for entities/value objects: `Order`, `Money`, `Address`
- Prefer verbs for domain services: `PricingService`, `ShippingCalculator`
- Name aggregates by their root: `Order` (not `OrderAggregate`)

## Anti-Patterns to Avoid

- **Anemic domain model**: Entities with only getters/setters, logic in services
- **God aggregate**: Too many entities under one root (split by invariant
  boundary)
- **Repository per entity**: Only aggregate roots get repositories
- **Leaking persistence**: Domain objects should not know about storage
