---
"@typeonce/effect-machine": minor
---

Give a Cluster parent the snapshots of its child machines.

A state that invokes a child machine with `onSnapshot` now runs on Cluster instead of being rejected as `UnsupportedProcessLocal`. Each step of the child that plans its initial state or takes a transition, and leaves it active, saves its encoded snapshot as a persisted request to its parent in the transaction of its checkpoint. The parent applies it once, as a snapshot of the invocation, while it runs that child. A transition on a snapshot that cannot be applied fails the parent. A child whose parent declares no `onSnapshot` for it sends no snapshot.
