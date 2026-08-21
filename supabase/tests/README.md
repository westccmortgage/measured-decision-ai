# Security invariant tests

`security_invariants.sql` asserts the properties that must not quietly stop being
true: tenant isolation, evidence immutability, who may delete, that the audit
trail cannot be rewritten, and that an AI process cannot author a decision.

Fifty-one assertions. Every one of them describes something a future change
could remove by accident.

## Running them

Needs a local PostgreSQL 16 and nothing else — no Supabase account, no network.

```
bash supabase/tests/run.sh
```

The script builds a throwaway cluster, creates the small part of Supabase the
migrations depend on (`auth.users`, `auth.uid()`, `storage.objects`,
`storage.foldername`, the `anon`/`authenticated`/`service_role` roles), applies
every migration in order exactly the way `supabase db push` does — one
transaction per file — and then runs the assertions inside a transaction it
rolls back.

Applying the migrations is itself a test: a migration that cannot be applied to
an empty database is a migration that will fail in CI.

## Writing more

The tests act as real people by setting `test.uid`, which the harness wires to
`auth.uid()`. They never use the service role, because the service role bypasses
row-level security and would prove nothing about it.

Three helpers:

- `pg_temp.check(label, condition)` — the condition must hold.
- `pg_temp.affects(label, statement, n)` — the statement must change exactly n rows.
- `pg_temp.refused(label, statement)` — the statement must raise.

One rule that cost an afternoon: a volatile function call and a query that reads
its effect cannot share a statement. One query sees one snapshot, so the read
happens as of before the call. Split them.
