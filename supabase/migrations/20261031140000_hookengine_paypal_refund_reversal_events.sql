-- Revoke Pro access when a subscription sale is refunded or reversed.
CREATE OR REPLACE FUNCTION public.hookengine_apply_paypal_event(p_event_id text, p_event_type text, p_subscription_id text, p_event_time timestamp with time zone, p_next_billing_time timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_status text;
  v_plan text;
  v_sub public.hookengine_subscriptions%rowtype;
  v_refresh jsonb;
begin
  if coalesce(p_event_id,'')='' or coalesce(p_subscription_id,'')='' or p_event_time is null then
    return jsonb_build_object('applied',false,'reason','invalid_event');
  end if;

  if p_event_type in ('BILLING.SUBSCRIPTION.ACTIVATED','BILLING.SUBSCRIPTION.RE-ACTIVATED') then
    v_status := 'active';
    v_plan := 'pro';
  elsif p_event_type in ('BILLING.SUBSCRIPTION.CANCELLED','BILLING.SUBSCRIPTION.EXPIRED') then
    v_status := 'cancelled';
    v_plan := 'free';
  elsif p_event_type in (
    'BILLING.SUBSCRIPTION.SUSPENDED',
    'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
    'PAYMENT.SALE.REFUNDED',
    'PAYMENT.SALE.REVERSED'
  ) then
    -- A refunded or reversed subscription sale revokes the paid entitlement.
    v_status := 'past_due';
    v_plan := 'free';
  else
    return jsonb_build_object('applied',false,'reason','unsupported_event');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('hookengine-paypal-event:'||p_event_id,0));
  if exists (select 1 from public.hookengine_paypal_webhook_events where event_id=p_event_id) then
    return jsonb_build_object('applied',false,'reason','duplicate_event');
  end if;

  select * into v_sub
  from public.hookengine_subscriptions
  where provider='paypal' and provider_subscription_id=p_subscription_id
  for update;

  if not found then
    -- Do not claim the event yet: checkout may still be saving the pending subscription row.
    -- Returning unknown_subscription lets PayPal retry safely.
    return jsonb_build_object('applied',false,'reason','unknown_subscription');
  end if;

  if v_sub.paypal_last_event_at is not null and p_event_time <= v_sub.paypal_last_event_at then
    insert into public.hookengine_paypal_webhook_events(event_id,event_type,subscription_id,event_time,outcome)
    values (p_event_id,p_event_type,p_subscription_id,p_event_time,'stale_event');
    return jsonb_build_object('applied',false,'reason','stale_event');
  end if;

  update public.hookengine_subscriptions
  set plan=v_plan,
      status=v_status,
      current_period_end=case when v_plan='pro' then coalesce(p_next_billing_time,current_period_end) else null end,
      credits_balance=0,
      credit_period_started_at=null,
      credit_period_ends_at=null,
      trial_started_at=null,
      trial_ends_at=null,
      paypal_last_event_at=p_event_time,
      updated_at=now()
  where user_id=v_sub.user_id;

  update public.hookengine_profiles set plan=v_plan where user_id=v_sub.user_id;

  if v_plan='pro' then
    v_refresh := public.hookengine_refresh_credit_period(v_sub.user_id);
  end if;

  insert into public.hookengine_paypal_webhook_events(event_id,event_type,subscription_id,event_time,outcome)
  values (p_event_id,p_event_type,p_subscription_id,p_event_time,'applied');

  return jsonb_build_object(
    'applied',true,'plan',v_plan,'status',v_status,
    'credits_balance',(select credits_balance from public.hookengine_subscriptions where user_id=v_sub.user_id)
  );
end;
$function$;

revoke all on function public.hookengine_apply_paypal_event(text,text,text,timestamp with time zone,timestamp with time zone) from public, anon, authenticated;
grant execute on function public.hookengine_apply_paypal_event(text,text,text,timestamp with time zone,timestamp with time zone) to service_role;
