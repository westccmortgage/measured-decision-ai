-- Preserve the result of each field-task email attempt so Studio can explain
-- whether the provider accepted the message or why it was not sent.

alter table public.field_assignments
  add column if not exists email_delivery_error text,
  add column if not exists email_last_attempt_at timestamptz;

comment on column public.field_assignments.email_delivery_state is
  'Provider handoff state. sent means the provider accepted the email; it does not by itself prove inbox delivery.';

comment on column public.field_assignments.email_delivery_error is
  'Last provider or configuration error, retained for project-manager troubleshooting.';
