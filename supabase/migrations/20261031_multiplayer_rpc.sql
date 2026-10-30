-- Atomic database-backed multiplayer. Existing custom login does not issue a
-- verifiable session, so these RPCs have the same trust boundary as the old
-- anon-accessible matches table; deploy proper session authentication before
-- using this game in a security-sensitive environment.
create or replace function public.bazaar_initial_state(mode text, username text)
returns jsonb language plpgsql set search_path = public as $$
declare
  money integer := case mode when 'easy' then 2000 when 'hard' then 750 when 'pro' then 500 else 1000 end;
  prices jsonb := '{"apple":25,"bread":15,"date":50,"carpet":180}';
  player jsonb;
begin
  player := jsonb_build_object('money',money,'startMoney',money,'debt',0,'internet',0,
    'warehouse','[{"id":"apple","qty":0,"avgBuy":0,"lockedQty":0},{"id":"bread","qty":0,"avgBuy":0,"lockedQty":0},{"id":"date","qty":0,"avgBuy":0,"lockedQty":0},{"id":"carpet","qty":0,"avgBuy":0,"lockedQty":0}]'::jsonb,
    'darkWarehouse','[{"id":"apple","qty":0,"avgBuy":0,"lockDays":0},{"id":"bread","qty":0,"avgBuy":0,"lockDays":0},{"id":"date","qty":0,"avgBuy":0,"lockDays":0},{"id":"carpet","qty":0,"avgBuy":0,"lockDays":0}]'::jsonb,
    'tradedToday',false,'realTradedToday',false,'negUsedToday',false,'negBlockedItems','{}'::jsonb,
    'festivalActive',false,'festivalUsed',false,'_dayPurchases','{}'::jsonb);
  return jsonb_build_object('mode',mode,'day',1,'prices',prices,
    'darkPrices','{"apple":14,"bread":8,"date":28,"carpet":100}'::jsonb,
    'priceHistory','{"apple":[25],"bread":[15],"date":[50],"carpet":[180]}'::jsonb,
    'netPrices',case when mode='pro' then '{"p1":75,"p2":120,"p10":400}'::jsonb else '{"p1":20,"p2":35,"p10":120}'::jsonb end,
    'events',jsonb_build_array('بازی آنلاین شروع شد! 🌐'),'lastEvent',null,'readyState','{}'::jsonb,
    'player1Username',left(coalesce(username,'بازیکن'),24),'player2Username',null,'player1',player,'player2',player);
end $$;

create or replace function public.bazaar_match_join(body jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  action text := body->>'action'; uid uuid := (body->>'userId')::uuid;
  mid uuid; fid uuid; v_mode text; m public.matches%rowtype;
begin
  if uid is null then return jsonb_build_object('error','کاربر مشخص نیست'); end if;
  -- Serialize queue selection and insertion so simultaneous arrivals cannot
  -- create separate waiting queues or claim the same match.
  perform pg_advisory_xact_lock(hashtext('bazaar_matchmaking'));
  if action='random' then
    delete from public.matches where status='waiting' and created_at < (now() at time zone 'utc') - interval '15 minutes';
    select * into m from public.matches where status='active' and (player1_id=uid or player2_id=uid) order by created_at desc limit 1;
    if found then return jsonb_build_object('success',true,'resumed',true,'matchId',m.id,'isPlayer1',m.player1_id=uid,'gameState',m.game_state,'status','active'); end if;
    select * into m from public.matches where status='waiting' and type='random' and mode='hard' and player2_id is null and player1_id=uid order by created_at desc limit 1;
    if found then return jsonb_build_object('success',true,'matchId',m.id,'isPlayer1',true,'gameState',m.game_state,'status','waiting'); end if;
    select * into m from public.matches where status='waiting' and type='random' and mode='hard' and player2_id is null and player1_id<>uid order by created_at limit 1 for update;
    if found then
      update public.matches set player2_id=uid,status='active',game_state=jsonb_set(game_state,'{player2Username}',to_jsonb(left(coalesce(body->>'username','بازیکن'),24))) where id=m.id returning * into m;
      return jsonb_build_object('success',true,'matchId',m.id,'isPlayer1',false,'gameState',m.game_state,'status','active');
    end if;
    insert into public.matches(player1_id,mode,type,status,game_state) values(uid,'hard','random','waiting',public.bazaar_initial_state('hard',body->>'username')) returning * into m;
    return jsonb_build_object('success',true,'matchId',m.id,'isPlayer1',true,'gameState',m.game_state,'status','waiting');
  elsif action='create-friend' then
    fid := (body->>'friendId')::uuid; v_mode := body->>'mode';
    if fid is null or fid=uid or v_mode not in ('easy','medium','hard','pro') or v_mode is null then return jsonb_build_object('error','درخواست نامعتبر'); end if;
    select * into m from public.matches where status='waiting' and type='friend' and player1_id=uid and player2_id=fid and created_at >= (now() at time zone 'utc') - interval '5 minutes' order by created_at desc limit 1;
    if not found then
      insert into public.matches(player1_id,player2_id,mode,type,status,game_state) values(uid,fid,v_mode,'friend','waiting',public.bazaar_initial_state(v_mode,body->>'username')) returning * into m;
    end if;
    return jsonb_build_object('success',true,'matchId',m.id,'gameState',m.game_state,'status','waiting');
  elsif action='resume-list' then
    return jsonb_build_object('success',true,
      'active',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from public.matches where status='active' and (player1_id=uid or player2_id=uid) order by created_at desc limit 3) x),'[]'::jsonb),
      'invites',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from public.matches where status='waiting' and type='friend' and player2_id=uid and created_at >= (now() at time zone 'utc') - interval '5 minutes' order by created_at desc limit 5) x),'[]'::jsonb));
  elsif action in ('accept-friend','cancel') then
    mid := (body->>'matchId')::uuid;
    select * into m from public.matches where id=mid for update;
    if action='cancel' then
      if not found then return jsonb_build_object('success',true); end if;
      if m.status='waiting' and (m.player1_id=uid or m.player2_id=uid) then delete from public.matches where id=mid; return jsonb_build_object('success',true); end if;
      return jsonb_build_object('error','بازی شروع شده یا اجازه لغو نداری');
    end if;
    if not found or m.type<>'friend' or m.status<>'waiting' or m.player2_id<>uid or m.created_at < (now() at time zone 'utc') - interval '5 minutes' then return jsonb_build_object('error','دعوت معتبر نیست یا منقضی شده'); end if;
    update public.matches set status='active',game_state=jsonb_set(game_state,'{player2Username}',to_jsonb(left(coalesce(body->>'username','بازیکن'),24))) where id=mid returning * into m;
    return jsonb_build_object('success',true,'matchId',m.id,'isPlayer1',false,'gameState',m.game_state,'status','active');
  end if;
  return jsonb_build_object('error','درخواست نامعتبر');
end $$;

create or replace function public.bazaar_profit(p jsonb, prices jsonb)
returns numeric language sql immutable set search_path = public as $$
 select coalesce((p->>'money')::numeric,0)-coalesce((p->>'startMoney')::numeric,0)-coalesce((p->>'debt')::numeric,0)
 + coalesce((select sum(coalesce((w->>'qty')::numeric,0)*coalesce((prices->>(w->>'id'))::numeric,0)) from jsonb_array_elements(coalesce(p->'warehouse','[]'::jsonb)||coalesce(p->'darkWarehouse','[]'::jsonb)) w),0)
$$;

create or replace function public.bazaar_match_turn(body jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  mid uuid := (body->>'matchId')::uuid; pk text := body->>'playerKey'; action text := body->>'action';
  reason text := coalesce(body->>'reason','manual'); opp text; m public.matches%rowtype; gs jsonb; ready jsonb;
  day integer; advanced boolean := false; waiting boolean := false; seconds_left integer; first_ready timestamptz;
  prices jsonb; dark jsonb := '{}'::jsonb; hist jsonb; item text; price integer; demand numeric; total numeric := 0; effect numeric; ev jsonb; events jsonb;
  p1 numeric; p2 numeric; winner text; opp_id uuid; last_seen timestamp;
begin
  if mid is null or pk not in ('player1','player2') or action not in ('ready','check','sync','finish') or pk is null or action is null then return jsonb_build_object('error','درخواست نامعتبر'); end if;
  opp := case pk when 'player1' then 'player2' else 'player1' end;
  select * into m from public.matches where id=mid for update;
  if not found then return jsonb_build_object('error','مچ پیدا نشد'); end if;
  gs := m.game_state;
  if m.status='finished' then return jsonb_build_object('success',true,'gameState',gs,'finished',true,'result',gs->'result','advanced',false,'waitingForOpponent',false); end if;
  if m.status<>'active' then return jsonb_build_object('error','بازی هنوز شروع نشده'); end if;
  if body->'playerState' is not null and jsonb_typeof(body->'playerState')='object' and action<>'check' then gs := jsonb_set(gs,array[pk],coalesce(gs->pk,'{}'::jsonb)||(body->'playerState')); end if;
  day := coalesce((gs->>'day')::integer,1);
  if action='finish' then
    p1 := public.bazaar_profit(gs->'player1',gs->'prices'); p2 := public.bazaar_profit(gs->'player2',gs->'prices');
    if reason='abandon' then winner:=opp;
    elsif reason='opponent-offline' then
      opp_id:=case opp when 'player1' then m.player1_id else m.player2_id end;
      select o.last_seen into last_seen from public.online_players o where o.user_id=opp_id;
      if last_seen is not null and last_seen > (now() at time zone 'utc') - interval '60 seconds' then return jsonb_build_object('error','حریف هنوز آنلاین است'); end if;
      winner:=pk;
    else winner:=case when p1>p2 then 'player1' when p2>p1 then 'player2' else 'draw' end; end if;
    gs:=jsonb_set(gs,'{result}',jsonb_build_object('winner',winner,'reason',reason,'profits',jsonb_build_object('player1',round(p1),'player2',round(p2)),'finishedAt',now()));
    update public.matches set game_state=gs,status='finished' where id=mid;
    return jsonb_build_object('success',true,'gameState',gs,'finished',true,'result',gs->'result','advanced',false,'waitingForOpponent',false);
  end if;
  if action in ('ready','check') then
    ready:=coalesce(gs->'readyState','{}'::jsonb);
    if action='ready' and coalesce((ready->pk->>'day')::integer,0)<>day then ready:=jsonb_set(ready,array[pk],jsonb_build_object('day',day,'readyAt',now())); end if;
    if coalesce((ready->pk->>'day')::integer,0)=day then first_ready:=(ready->pk->>'readyAt')::timestamptz;
    elsif coalesce((ready->opp->>'day')::integer,0)=day then first_ready:=(ready->opp->>'readyAt')::timestamptz; end if;
    advanced := (coalesce((ready->pk->>'day')::integer,0)=day and coalesce((ready->opp->>'day')::integer,0)=day) or (first_ready is not null and first_ready <= now()-interval '60 seconds');
    if advanced then
      prices:=coalesce(gs->'prices','{}'::jsonb); hist:=coalesce(gs->'priceHistory','{}'::jsonb);
      if random()<0.7 then
        ev := (jsonb_build_array(
          jsonb_build_object('id','fire','kind','price','mult',0.5,'text','آتش‌سوزی در بازار! قیمت‌ها نصف شدند! 🔥'),
          jsonb_build_object('id','returns','kind','price','mult',0.7,'text','بار برگشتی! ۳۰٪ تخفیف روی همه کالاها! 📦'),
          jsonb_build_object('id','crisis','kind','price','mult',0.8,'text','بحران اقتصادی! ۲۰٪ کاهش قیمت! 📉'),
          jsonb_build_object('id','benefactor','kind','price','mult',1.5,'text','مشتری خیّر آمد! ۵۰٪ افزایش قیمت! 💸'),
          jsonb_build_object('id','goodnews','kind','price','mult',1.25,'text','خبر خوب اقتصادی! ۲۵٪ افزایش قیمت! 📰'),
          jsonb_build_object('id','gift','kind','player','text','هدیه غافلگیرکننده! +۲۰۰ تومان! 🎁'),
          jsonb_build_object('id','thief','kind','player','text','دزد به غرفه زد! حداکثر ۵۰ تومان دزدیده شد! 🦹'),
          jsonb_build_object('id','lucky','kind','player','text','شانس آوردی! یک کالای مجانی به انبارت اضافه شد! 🍀'),
          jsonb_build_object('id','festival','kind','player','text','جشنواره خرید! اولین خرید امروز ۵۰٪ تخفیف! 🎉')
        ))->floor(random()*9)::integer;
      end if;
      select coalesce(sum(value::numeric),0) into total from jsonb_each_text(coalesce(gs->'player1'->'_dayPurchases','{}'::jsonb)) where value ~ '^[0-9]+(\.[0-9]+)?$';
      select total+coalesce(sum(value::numeric),0) into total from jsonb_each_text(coalesce(gs->'player2'->'_dayPurchases','{}'::jsonb)) where value ~ '^[0-9]+(\.[0-9]+)?$';
      foreach item in array array['apple','bread','date','carpet'] loop
        demand:=coalesce((gs->'player1'->'_dayPurchases'->>item)::numeric,0)+coalesce((gs->'player2'->'_dayPurchases'->>item)::numeric,0);
        effect:=case when total>0 then greatest(-0.2,least(0.2,(0.25-demand/total)*1.2)) else 0 end;
        price:=greatest(18,least(350,round(coalesce((prices->>item)::numeric,25)*(0.65+random()*0.9)*(1+effect))::integer));
        if ev->>'kind'='price' then price:=greatest(18,least(350,round(price*(ev->>'mult')::numeric)::integer)); end if;
        prices:=jsonb_set(prices,array[item],to_jsonb(price)); dark:=jsonb_set(dark,array[item],to_jsonb(greatest(8,round(price*(0.3+random()*0.4))::integer)));
        hist:=jsonb_set(hist,array[item],(coalesce(hist->item,'[]'::jsonb)||to_jsonb(price)) - case when jsonb_array_length(coalesce(hist->item,'[]'::jsonb))>=10 then 0 else -999 end,true);
      end loop;
      gs:=jsonb_set(gs,'{day}',to_jsonb(day+1)); gs:=jsonb_set(gs,'{prices}',prices); gs:=jsonb_set(gs,'{darkPrices}',dark); gs:=jsonb_set(gs,'{priceHistory}',hist);
      if ev is not null then
        gs:=jsonb_set(gs,'{lastEvent}',(ev-'mult')||jsonb_build_object('day',day+1));
        events:=coalesce(gs->'events','[]'::jsonb)||to_jsonb('🎲 '||(ev->>'text'));
        if jsonb_array_length(events)>60 then events:=events-0; end if;
        gs:=jsonb_set(gs,'{events}',events);
      else gs:=jsonb_set(gs,'{lastEvent}','null'::jsonb); end if;
      gs:=jsonb_set(gs,'{player1,_dayPurchases}','{}'::jsonb); gs:=jsonb_set(gs,'{player2,_dayPurchases}','{}'::jsonb); ready:='{}'::jsonb;
    else
      waiting:=action='ready' and coalesce((ready->pk->>'day')::integer,0)=day and coalesce((ready->opp->>'day')::integer,0)<>day;
      if waiting then seconds_left:=greatest(0,ceil(extract(epoch from (first_ready+interval '60 seconds'-now())))::integer); end if;
    end if;
    gs:=jsonb_set(gs,'{readyState}',ready);
  end if;
  update public.matches set game_state=gs where id=mid;
  return jsonb_build_object('success',true,'gameState',gs,'advanced',advanced,'finished',false,'result',null,'waitingForOpponent',waiting,'secondsLeft',seconds_left,'lastEvent',gs->'lastEvent');
end $$;

grant execute on function public.bazaar_match_join(jsonb), public.bazaar_match_turn(jsonb) to anon, authenticated;
