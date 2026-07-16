revoke all on function public.invoke_lotto_update() from public, anon, authenticated;
grant execute on function public.invoke_lotto_update() to service_role;

revoke all on function public.invoke_lotto_predict_notify() from public, anon, authenticated;
grant execute on function public.invoke_lotto_predict_notify() to service_role;

revoke all on function public.activate_lotto_agent_state(jsonb) from public, anon, authenticated;
grant execute on function public.activate_lotto_agent_state(jsonb) to service_role;

revoke all on function public.claim_next_lai_learning(text, text, date, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_next_lai_learning(text, text, date, text, integer)
  to service_role;

revoke all on function public.recover_lai_learning_order(text, text, date)
  from public, anon, authenticated;
grant execute on function public.recover_lai_learning_order(text, text, date)
  to service_role;
