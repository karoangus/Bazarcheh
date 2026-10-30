// supabase/functions/match-join/index.ts
// v1 — مچ‌میکینگ اتمی برای بازارچه (جلوگیری از race condition در پیوستن همزمان)
// اکشن‌ها:
//   'random'         — پاکسازی مچ‌های کهنه + پیوستن اتمی به صف رندوم یا ساخت مچ جدید (اگه مچ فعال قبلی داری، همون رو ریزامی کن)
//   'create-friend'  — ساخت دعوت دوئل برای دوست (body: friendId, mode)
//   'accept-friend'  — قبول اتمی دعوت (body: matchId)
//   'cancel'         — لغو/رد کردن مچ در انتظار (body: matchId)
//   'resume-list'    — لیست مچ‌های فعال و دعوت‌های ورودی برای کاربر
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ITEMS: any[] = [
  { id: "apple", base: 25 },
  { id: "bread", base: 15 },
  { id: "date", base: 50 },
  { id: "carpet", base: 180 },
];

const MODE_MONEY: any = { easy: 2000, medium: 1000, hard: 750, pro: 500 };
const RANDOM_MODE = "hard"; // صف رندوم روی مود سخت
const INVITE_TTL_MS = 5 * 60 * 1000; // عمر دعوت دوستانه: ۵ دقیقه
const STALE_WAITING_MS = 15 * 60 * 1000; // مچ در انتظار قدیمی‌تر از ۱۵ دقیقه = کهنه
const STALE_ACTIVE_MS = 3 * 24 * 60 * 60 * 1000; // مچ فعال قدیمی‌تر از ۳ روز = مرده

const rnd = (a: number, b: number) => Math.floor(Math.random() * (b - a + 1)) + a;

function genDarkPrices(normal: any) {
  const p: any = {};
  ITEMS.forEach((item) => {
    const disc = 0.3 + Math.random() * 0.4;
    p[item.id] = Math.max(8, Math.round(normal[item.id] * (1 - disc)));
  });
  return p;
}

function newPlayerState(startMoney: number) {
  return {
    money: startMoney, startMoney, debt: 0, internet: 0,
    warehouse: ITEMS.map((i) => ({ id: i.id, qty: 0, avgBuy: 0, lockedQty: 0 })),
    darkWarehouse: ITEMS.map((i) => ({ id: i.id, qty: 0, avgBuy: 0, lockDays: 0 })),
    tradedToday: false, realTradedToday: false, negUsedToday: false,
    negBlockedItems: {}, festivalActive: false, festivalUsed: false,
    _dayPurchases: {},
  };
}

function buildInitialGameState(mode: string, player1Username: string) {
  const startMoney = MODE_MONEY[mode] ?? 1000;
  const prices: any = {};
  ITEMS.forEach((i) => (prices[i.id] = i.base));
  // تاریخچه ۵ روز شبیه‌سازی‌شده + روز جاری
  const priceHistory: any = {};
  const sim: any = {};
  ITEMS.forEach((i) => (sim[i.id] = i.base));
  const history = [sim];
  for (let d = 0; d < 4; d++) {
    const next: any = {};
    ITEMS.forEach((item) => {
      const factor = 0.75 + Math.random() * 0.6;
      next[item.id] = Math.max(18, Math.min(350, Math.round(history[history.length - 1][item.id] * factor)));
    });
    history.push(next);
  }
  ITEMS.forEach((item) => {
    priceHistory[item.id] = history.map((h) => h[item.id]);
    priceHistory[item.id].push(prices[item.id]);
  });
  return {
    mode, day: 1,
    prices,
    darkPrices: genDarkPrices(prices),
    priceHistory,
    netPrices: mode === "pro" ? { p1: rnd(50, 100), p2: rnd(90, 150), p10: rnd(300, 500) } : { p1: 20, p2: 35, p10: 120 },
    events: ["بازی آنلاین شروع شد! 🌐"],
    lastEvent: null,
    readyState: {},
    player1Username,
    player2Username: null,
    player1: newPlayerState(startMoney),
    player2: newPlayerState(startMoney),
  };
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json();
    const { action, userId } = body;
    const username = (body.username || "بازیکن").toString().slice(0, 24);
    if (!userId) return json({ error: "userId الزامی است" }, 400);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    // ===== رندوم =====
    if (action === "random") {
      // پاکسازی فرصت‌طلبانه مچ‌های کهنه (جلوگیری از پر شدن ظرفیت صف)
      await admin.from("matches").delete().eq("status", "waiting")
        .lt("created_at", new Date(Date.now() - STALE_WAITING_MS).toISOString());
      await admin.from("matches").delete().eq("status", "active")
        .lt("created_at", new Date(Date.now() - STALE_ACTIVE_MS).toISOString());

      // اگه مچ فعال قبلی داری → ریزامی کن (جلوگیری از بازی‌های شبحی)
      const { data: myActive } = await admin.from("matches").select("*")
        .eq("status", "active")
        .or(`player1_id.eq.${userId},player2_id.eq.${userId}`)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (myActive) {
        return json({
          success: true, resumed: true,
          matchId: myActive.id,
          isPlayer1: myActive.player1_id === userId,
          gameState: myActive.game_state,
          status: "active",
        });
      }

      // پیدا کردن کاندیدهای در انتظار (بدون خودم)
      const { data: candidates } = await admin.from("matches").select("*")
        .eq("status", "waiting").eq("type", "random").eq("mode", RANDOM_MODE)
        .is("player2_id", null).neq("player1_id", userId)
        .order("created_at", { ascending: true }).limit(5);

      // تلاش اتمی برای claim کردن هر کاندید (update ... where status='waiting' and player2_id is null)
      for (const c of candidates || []) {
        const gs = { ...(c.game_state || {}), player2Username: username };
        const { data: claimed } = await admin.from("matches")
          .update({ player2_id: userId, status: "active", game_state: gs })
          .eq("id", c.id).eq("status", "waiting").is("player2_id", null)
          .select();
        if (claimed && claimed.length === 1 && claimed[0].player2_id === userId) {
          return json({
            success: true, matchId: c.id, isPlayer1: false,
            gameState: claimed[0].game_state, status: "active",
          });
        }
      }

      // کاندیدی نبود → ساخت مچ جدید در صف
      const initState = buildInitialGameState(RANDOM_MODE, username);
      const { data: created, error } = await admin.from("matches")
        .insert({ player1_id: userId, mode: RANDOM_MODE, type: "random", status: "waiting", game_state: initState })
        .select().single();
      if (error || !created) return json({ error: "خطا در ساخت مچ" }, 500);
      return json({
        success: true, matchId: created.id, isPlayer1: true,
        gameState: created.game_state, status: "waiting",
      });
    }

    // ===== ساخت دعوت دوستانه =====
    if (action === "create-friend") {
      const { friendId, mode } = body;
      if (!friendId) return json({ error: "friendId الزامی است" }, 400);
      if (friendId === userId) return json({ error: "نمی‌تونی با خودت دوئل کنی! 😄" }, 400);
      if (!MODE_MONEY[mode]) return json({ error: "مود نامعتبر" }, 400);

      // اگه دعوت در انتظار قبلی (کمتر از ۵ دقیقه) برای همین دوست داری، همون رو برگردون (idempotent)
      const { data: existing } = await admin.from("matches").select("*")
        .eq("status", "waiting").eq("type", "friend")
        .eq("player1_id", userId).eq("player2_id", friendId)
        .gte("created_at", new Date(Date.now() - INVITE_TTL_MS).toISOString())
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (existing) {
        return json({ success: true, matchId: existing.id, gameState: existing.game_state, status: "waiting", duplicated: true });
      }

      const { count } = await admin.from("matches").select("*", { count: "exact", head: true })
        .eq("status", "waiting").eq("type", "friend").eq("player1_id", userId);
      if ((count || 0) >= 5) return json({ error: "دعوت‌های در انتظار زیادی داری! صبر کن تا جواب بدن." }, 429);

      const initState = buildInitialGameState(mode, username);
      const { data: created, error } = await admin.from("matches")
        .insert({ player1_id: userId, player2_id: friendId, mode, type: "friend", status: "waiting", game_state: initState })
        .select().single();
      if (error || !created) return json({ error: "خطا در ارسال دعوت" }, 500);
      return json({ success: true, matchId: created.id, gameState: created.game_state, status: "waiting" });
    }

    // ===== قبول دعوت دوستانه =====
    if (action === "accept-friend") {
      const { matchId } = body;
      if (!matchId) return json({ error: "matchId الزامی است" }, 400);
      const { data: match } = await admin.from("matches").select("*").eq("id", matchId).maybeSingle();
      if (!match) return json({ error: "دعوت پیدا نشد" }, 404);
      if (match.status !== "waiting") return json({ error: "این دعوت دیگه معتبر نیست" }, 409);
      if (match.player2_id !== userId) return json({ error: "این دعوت برای تو نیست" }, 403);
      if (Date.now() - new Date(match.created_at + "Z").getTime() > INVITE_TTL_MS) {
        await admin.from("matches").delete().eq("id", matchId).eq("status", "waiting");
        return json({ error: "دعوت منقضی شده" }, 410);
      }
      const gs = { ...(match.game_state || {}), player2Username: username };
      const { data: claimed } = await admin.from("matches")
        .update({ status: "active", game_state: gs })
        .eq("id", matchId).eq("status", "waiting")
        .select();
      if (!claimed || claimed.length !== 1) return json({ error: "دعوت هم‌اکنون گرفته شد" }, 409);
      return json({
        success: true, matchId, isPlayer1: false,
        gameState: claimed[0].game_state, status: "active",
      });
    }

    // ===== لغو / رد کردن =====
    if (action === "cancel") {
      const { matchId } = body;
      if (!matchId) return json({ error: "matchId الزامی است" }, 400);
      const { data: match } = await admin.from("matches").select("*").eq("id", matchId).maybeSingle();
      if (!match) return json({ success: true });
      if (match.status === "waiting" && (match.player1_id === userId || match.player2_id === userId)) {
        await admin.from("matches").delete().eq("id", matchId).eq("status", "waiting");
        return json({ success: true });
      }
      return json({ error: "بازی شروع شده — برای ترک از گزینه «ترک بازی» استفاده کن" }, 409);
    }

    // ===== لیست ریزامی =====
    if (action === "resume-list") {
      const { data: active } = await admin.from("matches").select("*")
        .eq("status", "active")
        .or(`player1_id.eq.${userId},player2_id.eq.${userId}`)
        .order("created_at", { ascending: false }).limit(3);
      const { data: invites } = await admin.from("matches").select("*")
        .eq("status", "waiting").eq("type", "friend").eq("player2_id", userId)
        .gte("created_at", new Date(Date.now() - INVITE_TTL_MS).toISOString())
        .order("created_at", { ascending: false }).limit(5);
      return json({ success: true, active: active || [], invites: invites || [] });
    }

    return json({ error: "اکشن نامعتبر" }, 400);
  } catch (e: any) {
    return json({ error: "خطای سرور: " + (e?.message || String(e)) }, 500);
  }
});
