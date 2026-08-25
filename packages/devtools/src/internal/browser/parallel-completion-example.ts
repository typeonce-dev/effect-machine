import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

class Cart extends Schema.TaggedClass<Cart>("ParallelCart")("Cart", {
  items: Schema.Number
}) {}
class Order extends Schema.TaggedClass<Order>("ParallelOrder")("Order", {
  orderId: Schema.String,
  total: Schema.Number
}) {}
class Payment extends Schema.TaggedClass<Payment>("ParallelPayment")("Payment", {
  attempts: Schema.Number
}) {}
class AwaitingAuthorization extends Schema.TaggedClass<AwaitingAuthorization>("ParallelAwaitingAuthorization")(
  "AwaitingAuthorization",
  {}
) {}
class Authorized extends Schema.TaggedClass<Authorized>("ParallelAuthorized")("Authorized", {
  authorizationId: Schema.String
}) {}
class Fulfillment extends Schema.TaggedClass<Fulfillment>("ParallelFulfillment")("Fulfillment", {
  warehouse: Schema.String
}) {}
class WaitingForPayment extends Schema.TaggedClass<WaitingForPayment>("ParallelWaitingForPayment")(
  "WaitingForPayment",
  {}
) {}
class Packing extends Schema.TaggedClass<Packing>("ParallelPacking")("Packing", {
  packageCount: Schema.Number
}) {}
class Shipped extends Schema.TaggedClass<Shipped>("ParallelShipped")("Shipped", {
  trackingCode: Schema.String
}) {}
class OrderComplete extends Schema.TaggedClass<OrderComplete>("ParallelOrderComplete")("OrderComplete", {
  orderId: Schema.String
}) {}
class OrderCancelled extends Schema.TaggedClass<OrderCancelled>("ParallelOrderCancelled")(
  "OrderCancelled",
  { reason: Schema.String }
) {}

class Checkout extends Schema.TaggedClass<Checkout>("ParallelCheckout")("Checkout", {
  orderId: Schema.String,
  total: Schema.Number
}) {}
class Authorize extends Schema.TaggedClass<Authorize>("ParallelAuthorize")("Authorize", {
  authorizationId: Schema.String
}) {}
class DeclinePayment extends Schema.TaggedClass<DeclinePayment>("ParallelDeclinePayment")(
  "DeclinePayment",
  { reason: Schema.String }
) {}
class Pack extends Schema.TaggedClass<Pack>("ParallelPack")("Pack", { packages: Schema.Number }) {}
class Ship extends Schema.TaggedClass<Ship>("ParallelShip")("Ship", { trackingCode: Schema.String }) {}
class CompleteAll extends Schema.TaggedClass<CompleteAll>("ParallelCompleteAll")("CompleteAll", {
  authorizationId: Schema.String,
  trackingCode: Schema.String
}) {}
class CancelOrder extends Schema.TaggedClass<CancelOrder>("ParallelCancelOrder")("CancelOrder", {
  reason: Schema.String
}) {}
class RetryOrder extends Schema.TaggedClass<RetryOrder>("ParallelRetryOrder")("RetryOrder", {}) {}
class AutoShip extends Schema.TaggedClass<AutoShip>("ParallelAutoShip")("AutoShip", {}) {}

const ParallelInternalEvents = Machine.internalEvents(AutoShip)
const ParallelStates = Machine.states({
  Cart,
  Order: {
    schema: Order,
    type: "parallel",
    states: {
      payment: {
        schema: Payment,
        initial: "AwaitingAuthorization",
        states: {
          AwaitingAuthorization,
          Authorized: { schema: Authorized, type: "final" }
        }
      },
      fulfillment: {
        schema: Fulfillment,
        initial: "WaitingForPayment",
        states: {
          WaitingForPayment,
          Packing,
          Shipped: { schema: Shipped, type: "final" }
        }
      }
    }
  },
  Complete: { schema: OrderComplete, type: "final", output: Schema.String },
  Cancelled: OrderCancelled
})

export const parallelCompletionMachine = Machine.make({
  id: "parallel-completion",
  states: ParallelStates.states,
  events: Machine.events(
    Checkout,
    Authorize,
    DeclinePayment,
    Pack,
    Ship,
    CompleteAll,
    CancelOrder,
    RetryOrder
  ),
  internalEvents: ParallelInternalEvents,
  initial: (to) => to.Cart().resolve(({ target }) => target.decoded(new Cart({ items: 2 })))
}).handle({
  Cart: {
    on: {
      Checkout: (to) =>
        to.full.Order.initial.resolve(({ event, target }) =>
          target.decoded(new Order({ orderId: event.orderId, total: event.total }))
        )
    }
  },
  Order: {
    initialize: ({ builder }) => builder.payment.from({ attempts: 0 }).fulfillment.from({ warehouse: "north" }),
    on: {
      CancelOrder: (to) =>
        to.full.Cancelled().resolve(({ event, target }) => target.decoded(new OrderCancelled({ reason: event.reason })))
    },
    onDone: (to) =>
      to.full.Complete().resolve(({ target }) => target.decoded(new OrderComplete({ orderId: "completed-order" }))),
    states: {
      payment: {
        initialize: ({ builder }) => builder.from(),
        states: {
          AwaitingAuthorization: {
            on: {
              Authorize: (to) =>
                to.local.Authorized().resolve(({ event, target }) =>
                  target.decoded(new Authorized({ authorizationId: event.authorizationId }))
                ),
              CompleteAll: (to) =>
                to.local.Authorized().resolve(({ event, target }) =>
                  target.decoded(new Authorized({ authorizationId: event.authorizationId }))
                ),
              DeclinePayment: (to) =>
                to.full.Cancelled().resolve(({ event, target }) =>
                  target.decoded(new OrderCancelled({ reason: event.reason }))
                )
            }
          }
        }
      },
      fulfillment: {
        initialize: ({ builder }) => builder.from(),
        states: {
          WaitingForPayment: {
            on: {
              Authorize: (to) =>
                to.local.Packing().resolve(({ target }) => target.decoded(new Packing({ packageCount: 1 }))),
              Pack: (to) =>
                to.local.Packing().resolve(({ event, target }) =>
                  target.decoded(new Packing({ packageCount: event.packages }))
                ),
              CompleteAll: (to) =>
                to.local.Shipped().resolve(({ event, target }) =>
                  target.decoded(new Shipped({ trackingCode: event.trackingCode }))
                )
            }
          },
          Packing: {
            invoke: (from) =>
              from.timer("packing-sla", "5 seconds").onDone((to) =>
                to.none.resolve((_, enqueue) => {
                  enqueue.raise(ParallelInternalEvents.AutoShip())
                })
              ),
            on: {
              AutoShip: (to) =>
                to.local.Shipped().resolve(({ target }) => target.decoded(new Shipped({ trackingCode: "automatic" }))),
              Ship: (to) =>
                to.local.Shipped().resolve(({ event, target }) =>
                  target.decoded(new Shipped({ trackingCode: event.trackingCode }))
                ),
              CompleteAll: (to) =>
                to.local.Shipped().resolve(({ event, target }) =>
                  target.decoded(new Shipped({ trackingCode: event.trackingCode }))
                )
            }
          }
        }
      }
    }
  },
  Complete: {
    output: ({ state }) => state.orderId
  },
  Cancelled: {
    on: {
      RetryOrder: (to) =>
        to.full.Order.initial.resolve(({ target }) => target.decoded(new Order({ orderId: "retry", total: 0 })))
    }
  }
})
