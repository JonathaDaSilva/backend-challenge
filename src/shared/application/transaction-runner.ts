/**
 * Runs a unit of work atomically. Every repository call made inside `work`
 * joins the same database transaction, without passing a transaction handle
 * around: inbox, balance update, ledger entry and outbox commit together or
 * not at all (README §6.5).
 *
 * `work` may be invoked more than once when the database reports a transient
 * conflict (serialization failure or deadlock), so it must not have side
 * effects outside the database — in particular, it must never publish events.
 */
export interface TransactionRunner {
  run<T>(work: () => Promise<T>): Promise<T>;
}

export const TRANSACTION_RUNNER = Symbol('TRANSACTION_RUNNER');
