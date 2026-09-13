# Long Task Worker (v0.12.10; v0.12.9 baseline)

> v0.12.10 adds a bounded worker tick for expiry and wake processing; a fresh Host and session revalidation are still required.

Long work follows a durable protocol: suspend and release the process, wait for an event or human signal, wake, revalidate, and dispatch a fresh Host. The worker stores only references and digests. It never reattaches a dead Host process; context drift returns `needs_replan`.
