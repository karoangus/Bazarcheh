-- ============================================================
-- بازارچه دارک وب — مایگریشن تعمیرات مولتی‌پلیر
-- اعمال‌شده روی پروژه japskmsxnkxbdlsznsyt (2026-10-30)
-- ============================================================

-- 1) جدول matches سیاست DELETE نداشت → cancel/decline سمت کلاینت بی‌صدا شکست می‌خورد
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='matches' AND policyname='allow delete matches') THEN
    CREATE POLICY "allow delete matches" ON public.matches FOR DELETE TO public USING (true);
  END IF;
END $$;

-- 2) ایندکس‌های پرفورمنس برای کوئری‌های مچ‌میکینگ
CREATE INDEX IF NOT EXISTS matches_matchmaking_idx ON public.matches (status, type, mode, created_at);
CREATE INDEX IF NOT EXISTS matches_player2_idx ON public.matches (player2_id, status);
CREATE INDEX IF NOT EXISTS matches_player1_idx ON public.matches (player1_id, status);
CREATE INDEX IF NOT EXISTS matches_created_at_idx ON public.matches (created_at);
CREATE INDEX IF NOT EXISTS online_players_last_seen_idx ON public.online_players (last_seen);
CREATE INDEX IF NOT EXISTS friends_user_idx ON public.friends (user_id);
CREATE INDEX IF NOT EXISTS friends_friend_idx ON public.friends (friend_id);

-- 3) پاکسازی داده کهنه (مچ‌های ماه‌ها قبل ظرفیت صف مچ‌میکینگ رو پر کرده بودن)
DELETE FROM public.matches WHERE status IN ('waiting','active') AND created_at < now() - interval '1 day';
DELETE FROM public.matches WHERE status = 'finished' AND created_at < now() - interval '7 days';
DELETE FROM public.online_players WHERE last_seen < now() - interval '1 day';
