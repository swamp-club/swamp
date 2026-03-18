# TypeScript/Deno DDD Patterns

## Value Object

Immutable, equality by value. Use `readonly` and private constructor with
factory.

```typescript
export class Money {
  private constructor(
    readonly amount: number,
    readonly currency: string,
  ) {}

  static create(amount: number, currency: string): Money {
    if (amount < 0) throw new Error("Amount cannot be negative");
    return new Money(amount, currency);
  }

  add(other: Money): Money {
    if (this.currency !== other.currency) {
      throw new Error("Currency mismatch");
    }
    return Money.create(this.amount + other.amount, this.currency);
  }

  equals(other: Money): boolean {
    return this.amount === other.amount && this.currency === other.currency;
  }
}
```

## Entity

Has identity, mutable state. ID assigned at creation.

```typescript
export type OrderId = string & { readonly _brand: unique symbol };

export function createOrderId(id: string): OrderId {
  return id as OrderId;
}

export class Order {
  private constructor(
    readonly id: OrderId,
    private _status: OrderStatus,
    private _items: OrderItem[],
  ) {}

  static create(id: OrderId): Order {
    return new Order(id, "draft", []);
  }

  get status(): OrderStatus {
    return this._status;
  }

  addItem(item: OrderItem): void {
    if (this._status !== "draft") {
      throw new Error("Cannot modify non-draft order");
    }
    this._items.push(item);
  }

  submit(): void {
    if (this._items.length === 0) {
      throw new Error("Cannot submit empty order");
    }
    this._status = "submitted";
  }
}
```

## Aggregate

Root entity controls all mutations. Children accessed only through root.

```typescript
export class ShoppingCart {
  private constructor(
    readonly id: CartId,
    private _items: Map<ProductId, CartItem>,
    private _customerId: CustomerId,
  ) {}

  static create(id: CartId, customerId: CustomerId): ShoppingCart {
    return new ShoppingCart(id, new Map(), customerId);
  }

  // Expose items as readonly snapshot
  get items(): ReadonlyArray<CartItem> {
    return [...this._items.values()];
  }

  addProduct(productId: ProductId, quantity: number, price: Money): void {
    const existing = this._items.get(productId);
    if (existing) {
      this._items.set(
        productId,
        existing.withQuantity(existing.quantity + quantity),
      );
    } else {
      this._items.set(productId, CartItem.create(productId, quantity, price));
    }
  }

  removeProduct(productId: ProductId): void {
    this._items.delete(productId);
  }

  get total(): Money {
    return this.items.reduce(
      (sum, item) => sum.add(item.lineTotal),
      Money.create(0, "USD"),
    );
  }
}

// CartItem is an entity within the aggregate, not exposed directly
class CartItem {
  private constructor(
    readonly productId: ProductId,
    readonly quantity: number,
    readonly unitPrice: Money,
  ) {}

  static create(
    productId: ProductId,
    quantity: number,
    unitPrice: Money,
  ): CartItem {
    return new CartItem(productId, quantity, unitPrice);
  }

  withQuantity(quantity: number): CartItem {
    return new CartItem(this.productId, quantity, this.unitPrice);
  }

  get lineTotal(): Money {
    return Money.create(
      this.unitPrice.amount * this.quantity,
      this.unitPrice.currency,
    );
  }
}
```

## Domain Service

Stateless operations that don't belong to a single entity.

```typescript
export interface PricingService {
  calculateDiscount(cart: ShoppingCart, customer: Customer): Money;
}

export class StandardPricingService implements PricingService {
  calculateDiscount(cart: ShoppingCart, customer: Customer): Money {
    const total = cart.total;
    const discountRate = customer.tier === "premium" ? 0.1 : 0;
    return Money.create(total.amount * discountRate, total.currency);
  }
}
```

## Repository

Persistence abstraction for aggregate roots only.

```typescript
export interface OrderRepository {
  findById(id: OrderId): Promise<Order | null>;
  save(order: Order): Promise<void>;
  nextId(): OrderId;
}

// Implementation lives in infrastructure layer
export class InMemoryOrderRepository implements OrderRepository {
  private orders = new Map<string, Order>();

  async findById(id: OrderId): Promise<Order | null> {
    return this.orders.get(id) ?? null;
  }

  async save(order: Order): Promise<void> {
    this.orders.set(order.id, order);
  }

  nextId(): OrderId {
    return createOrderId(crypto.randomUUID());
  }
}
```

## Application Service

Orchestrates domain objects to fulfill a use case. Owns the transaction
boundary, accepts cross-cutting concerns via a `Context`, injects dependencies
via a `Deps` interface, and takes operation-specific `Input`. Returns an
`AsyncIterable` of typed progress events so callers can stream results.

Lives in the **application layer** (e.g. `libswamp/`), never in the domain
layer.

```typescript
// Types for the use case
export interface WorkflowRunDeps {
  workflowRepo: WorkflowRepository;
  executionService: WorkflowExecutionService;
}

export interface WorkflowRunInput {
  workflowId: WorkflowId;
  args: Record<string, unknown>;
}

export type WorkflowRunEvent =
  | { kind: "started"; workflowId: WorkflowId }
  | { kind: "stepCompleted"; stepName: string; result: unknown }
  | { kind: "finished"; workflowId: WorkflowId };

// Application service as an async generator function
export async function* workflowRun(
  ctx: Context,
  deps: WorkflowRunDeps,
  input: WorkflowRunInput,
): AsyncIterable<WorkflowRunEvent> {
  const workflow = await deps.workflowRepo.findById(input.workflowId);
  if (!workflow) throw new Error(`Workflow not found: ${input.workflowId}`);

  yield { kind: "started", workflowId: workflow.id };

  for await (
    const event of deps.executionService.execute(ctx, workflow, input.args)
  ) {
    yield {
      kind: "stepCompleted",
      stepName: event.stepName,
      result: event.result,
    };
  }

  yield { kind: "finished", workflowId: workflow.id };
}
```

## Notification Events

Progress events emitted by application services so orchestration layers can
report status without coupling deep domain code to presentation concerns.

### Callback Threading Pattern

Deep domain code emits topology-agnostic events via `onEvent` callbacks. The
orchestration layer wraps those callbacks to attach topology context (e.g. which
workflow step triggered the event) before re-emitting upward.

```typescript
// 1. Domain-level event — knows nothing about workflows
export type MethodExecutionEvent =
  | { type: "invoked"; method: string }
  | { type: "output"; line: string }
  | { type: "completed"; exitCode: number };

// 2. Workflow-level event — wraps domain event with step context
export type WorkflowExecutionEvent =
  | { kind: "stepStarted"; stepName: string }
  | { kind: "methodEvent"; stepName: string; event: MethodExecutionEvent }
  | { kind: "stepFinished"; stepName: string };

// 3. Application service event — wraps workflow event with run context
export type WorkflowRunEvent =
  | { kind: "started"; workflowId: WorkflowId }
  | { kind: "executionEvent"; event: WorkflowExecutionEvent }
  | { kind: "finished"; workflowId: WorkflowId };
```

The chain
`MethodExecutionEvent → onEvent → WorkflowExecutionEvent →
WorkflowRunEvent`
keeps each layer ignorant of layers above it.

### Discriminant Conventions

- Use `kind` for stream/notification events (application service output,
  progress updates). Avoids collision with `step`, which names workflow Steps.
- Use `type` for domain events (e.g. `MethodExecutionEvent`) following the
  established domain event convention.

## Domain Events

Capture state changes for cross-aggregate communication.

```typescript
export interface DomainEvent {
  readonly occurredAt: Date;
  readonly aggregateId: string;
}

export interface OrderSubmittedEvent extends DomainEvent {
  readonly type: "OrderSubmitted";
  readonly orderId: OrderId;
  readonly customerId: CustomerId;
  readonly total: Money;
}

// Aggregate collects events
export class Order {
  private _events: DomainEvent[] = [];

  get events(): ReadonlyArray<DomainEvent> {
    return this._events;
  }

  clearEvents(): void {
    this._events = [];
  }

  submit(): void {
    // ... validation ...
    this._status = "submitted";
    this._events.push({
      type: "OrderSubmitted",
      occurredAt: new Date(),
      aggregateId: this.id,
      orderId: this.id,
      customerId: this._customerId,
      total: this.total,
    });
  }
}
```
