-- Run only in an isolated test database with the migrations already applied.
-- Everything is rolled back. Random matchmaking requires an empty queue.
BEGIN;
DO $test$
DECLARE a uuid; b uuid; mid uuid; r jsonb; n integer;
BEGIN
  IF EXISTS (SELECT 1 FROM public.matches WHERE status='waiting' AND type='random') THEN
    RAISE EXCEPTION 'Use an isolated database with an empty random queue';
  END IF;
  INSERT INTO public.users(username,password_hash,security_question,security_answer_hash)
    VALUES ('rpc_a_'||gen_random_uuid(),'x','x','x') RETURNING id INTO a;
  INSERT INTO public.users(username,password_hash,security_question,security_answer_hash)
    VALUES ('rpc_b_'||gen_random_uuid(),'x','x','x') RETURNING id INTO b;
  r:=public.bazaar_match_join(jsonb_build_object('action','random','userId',a,'username','a'));
  IF r->>'status'<>'waiting' THEN RAISE EXCEPTION 'queue: %',r; END IF;
  mid:=(r->>'matchId')::uuid;
  r:=public.bazaar_match_join(jsonb_build_object('action','random','userId',a,'username','a'));
  IF (r->>'matchId')::uuid<>mid THEN RAISE EXCEPTION 'duplicate queue: %',r; END IF;
  r:=public.bazaar_match_join(jsonb_build_object('action','random','userId',b,'username','b'));
  IF r->>'status'<>'active' OR (r->>'matchId')::uuid<>mid THEN RAISE EXCEPTION 'claim: %',r; END IF;
  FOR n IN 1..12 LOOP
    r:=public.bazaar_match_turn(jsonb_build_object('action','ready','matchId',mid,'playerKey','player1'));
    IF r->>'waitingForOpponent'<>'true' THEN RAISE EXCEPTION 'ready: %',r; END IF;
    r:=public.bazaar_match_turn(jsonb_build_object('action','ready','matchId',mid,'playerKey','player2'));
    IF r->>'advanced'<>'true' THEN RAISE EXCEPTION 'advance: %',r; END IF;
  END LOOP;
  IF jsonb_array_length(r->'gameState'->'priceHistory'->'apple')<>10 THEN RAISE EXCEPTION 'history: %',r; END IF;
  r:=public.bazaar_match_turn(jsonb_build_object('action','finish','reason','abandon','matchId',mid,'playerKey','player1'));
  IF r->'result'->>'winner'<>'player2' THEN RAISE EXCEPTION 'finish: %',r; END IF;
  r:=public.bazaar_match_join(jsonb_build_object('action','create-friend','userId',a,'friendId',b,'mode','easy','username','a'));
  mid:=(r->>'matchId')::uuid;
  r:=public.bazaar_match_join(jsonb_build_object('action','accept-friend','userId',b,'matchId',mid,'username','b'));
  IF r->>'status'<>'active' THEN RAISE EXCEPTION 'accept: %',r; END IF;
  r:=public.bazaar_match_turn(jsonb_build_object('action','sync','matchId',mid,'playerKey','player1','playerState',jsonb_build_object('money',2200)));
  IF r->'gameState'->'player1'->>'money'<>'2200' THEN RAISE EXCEPTION 'sync: %',r; END IF;
  r:=public.bazaar_match_turn(jsonb_build_object('action','finish','matchId',mid,'playerKey','player1'));
  IF r->'result'->>'winner'<>'player1' THEN RAISE EXCEPTION 'profit: %',r; END IF;
END $test$;
ROLLBACK;
