import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"
class Cart extends Schema.TaggedClass<Cart>("ParallelCart")("Cart", {
  items: Schema.Number
}) {
}
class Order extends Schema.TaggedClass<Order>("ParallelOrder")("Order", {
  orderId: Schema.String,
  total: Schema.Number
}) {
}
class Payment extends Schema.TaggedClass<Payment>("ParallelPayment")("Payment", {
  attempts: Schema.Number
}) {
}
class AwaitingAuthorization
  extends Schema.TaggedClass<AwaitingAuthorization>("ParallelAwaitingAuthorization")("AwaitingAuthorization", {})
{
}
class Authorized extends Schema.TaggedClass<Authorized>("ParallelAuthorized")("Authorized", {
  authorizationId: Schema.String
}) {
}
class Fulfillment extends Schema.TaggedClass<Fulfillment>("ParallelFulfillment")("Fulfillment", {
  warehouse: Schema.String
}) {
}
class WaitingForPayment
  extends Schema.TaggedClass<WaitingForPayment>("ParallelWaitingForPayment")("WaitingForPayment", {})
{
}
class Packing extends Schema.TaggedClass<Packing>("ParallelPacking")("Packing", {
  packageCount: Schema.Number
}) {
}
class Shipped extends Schema.TaggedClass<Shipped>("ParallelShipped")("Shipped", {
  trackingCode: Schema.String
}) {
}
class OrderComplete extends Schema.TaggedClass<OrderComplete>("ParallelOrderComplete")("OrderComplete", {
  orderId: Schema.String
}) {
}
class OrderCancelled
  extends Schema.TaggedClass<OrderCancelled>("ParallelOrderCancelled")("OrderCancelled", { reason: Schema.String })
{
}
class Checkout extends Schema.TaggedClass<Checkout>("ParallelCheckout")("Checkout", {
  orderId: Schema.String,
  total: Schema.Number
}) {
}
class Authorize extends Schema.TaggedClass<Authorize>("ParallelAuthorize")("Authorize", {
  authorizationId: Schema.String
}) {
}
class DeclinePayment
  extends Schema.TaggedClass<DeclinePayment>("ParallelDeclinePayment")("DeclinePayment", { reason: Schema.String })
{
}
class Pack extends Schema.TaggedClass<Pack>("ParallelPack")("Pack", { packages: Schema.Number }) {
}
class Ship extends Schema.TaggedClass<Ship>("ParallelShip")("Ship", { trackingCode: Schema.String }) {
}
class CompleteAll extends Schema.TaggedClass<CompleteAll>("ParallelCompleteAll")("CompleteAll", {
  authorizationId: Schema.String,
  trackingCode: Schema.String
}) {
}
class CancelOrder extends Schema.TaggedClass<CancelOrder>("ParallelCancelOrder")("CancelOrder", {
  reason: Schema.String
}) {
}
class RetryOrder extends Schema.TaggedClass<RetryOrder>("ParallelRetryOrder")("RetryOrder", {}) {
}
class AutoShip extends Schema.TaggedClass<AutoShip>("ParallelAutoShip")("AutoShip", {}) {
}
const ParallelInternalEvents = Machine.internalEventsFromSchemas(AutoShip)
const ParallelStates = Machine.state({
  states: {
    Cart,
    Order: {
      schema: Order,
      type: "parallel",
      states: {
        payment: {
          schema: Payment,
          states: {
            AwaitingAuthorization,
            Authorized: { schema: Authorized, type: "final" }
          }
        },
        fulfillment: {
          schema: Fulfillment,
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
  }
})
export const parallelCompletionMachine = Machine.make({
  timers: { source1: "5 seconds" },
  id: "parallel-completion",
  root: ParallelStates,
  events: Machine.eventsFromSchemas(
    Checkout,
    Authorize,
    DeclinePayment,
    Pack,
    Ship,
    CompleteAll,
    CancelOrder,
    RetryOrder
  ),
  internalEvents: ParallelInternalEvents
}).handle({
  initial: {
    target: "Cart",
    decoded: true,
    data: new Cart({ items: 2 })
  },
  states: {
    Cart: {
      on: {
        Checkout: {
          target: "Order",
          decoded: true,
          data: ({ event }) => (new Order({ orderId: event.orderId, total: event.total }))
        }
      }
    },
    Order: {
      initial: { payment: ({}) => ({ attempts: 0 }), fulfillment: ({}) => ({ warehouse: "north" }) },
      on: {
        CancelOrder: {
          target: "Cancelled",
          decoded: true,
          data: ({ event }) => (new OrderCancelled({ reason: event.reason }))
        }
      },
      onDone: {
        target: "Complete",
        decoded: true,
        data: () => (new OrderComplete({ orderId: "completed-order" }))
      },
      states: {
        payment: {
          initial: {
            target: "Order.payment.AwaitingAuthorization"
          },
          states: {
            AwaitingAuthorization: {
              on: {
                Authorize: {
                  target: "Order.payment.Authorized",
                  decoded: true,
                  data: ({ event }) => (new Authorized({ authorizationId: event.authorizationId }))
                },
                CompleteAll: {
                  target: "Order.payment.Authorized",
                  decoded: true,
                  data: ({ event }) => (new Authorized({ authorizationId: event.authorizationId }))
                },
                DeclinePayment: {
                  target: "Cancelled",
                  decoded: true,
                  data: ({ event }) => (new OrderCancelled({ reason: event.reason }))
                }
              }
            },
            Authorized: {}
          }
        },
        fulfillment: {
          initial: {
            target: "Order.fulfillment.WaitingForPayment"
          },
          states: {
            WaitingForPayment: {
              on: {
                Authorize: {
                  target: "Order.fulfillment.Packing",
                  decoded: true,
                  data: () => (new Packing({ packageCount: 1 }))
                },
                Pack: {
                  target: "Order.fulfillment.Packing",
                  decoded: true,
                  data: ({ event }) => (new Packing({ packageCount: event.packages }))
                },
                CompleteAll: {
                  target: "Order.fulfillment.Shipped",
                  decoded: true,
                  data: ({ event }) => (new Shipped({ trackingCode: event.trackingCode }))
                }
              }
            },
            Packing: {
              invoke: {
                src: "source1",
                id: "packing-sla",
                onDone: {
                  none: true,
                  resolve: (_, enqueue) => {
                    enqueue.raise(ParallelInternalEvents.AutoShip())
                  }
                }
              },
              on: {
                AutoShip: {
                  target: "Order.fulfillment.Shipped",
                  decoded: true,
                  data: () => (new Shipped({ trackingCode: "automatic" }))
                },
                Ship: {
                  target: "Order.fulfillment.Shipped",
                  decoded: true,
                  data: ({ event }) => (new Shipped({ trackingCode: event.trackingCode }))
                },
                CompleteAll: {
                  target: "Order.fulfillment.Shipped",
                  decoded: true,
                  data: ({ event }) => (new Shipped({ trackingCode: event.trackingCode }))
                }
              }
            },
            Shipped: {}
          }
        }
      }
    },
    Complete: {
      output: ({ state }) => state.orderId
    },
    Cancelled: {
      on: {
        RetryOrder: {
          target: "Order",
          decoded: true,
          data: () => (new Order({ orderId: "retry", total: 0 }))
        }
      }
    }
  }
})
