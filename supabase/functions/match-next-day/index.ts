// supabase/functions/match-next-day/index.ts
// v3 — هماهنگی atomic روز در بازی آنلاین بازارچه
// اکشن‌ها:
//   'ready'  — وضعیت پلیر merge می‌شه، علامت آماده برای روز جاری؛ اگه هر دو آماده باشن (یا ۶۰ ثانیه از آماده‌بودن یکی بگذره) روز جلو میره
//   'check'  — فقط بررسی/پولینگ (بدون ثبت آماده‌بودن)؛ اگه تایم‌اوت گذشته باشه روز رو جلو می‌بره
//   'sync'   — فقط merge اتمی وضعیت خود پلیر (بعد از معامله‌ها) بدون منطق روز
//   'finish' — پایان بازی: merge وضعیت نهایی، محاسبه برنده روی سرور (سود = پول + ارزش انبار − سرمایه اولیه − بدهی)
// رویدادهای تصادفی مشترک (تغییر قیمت‌ها) روی سرور رول می‌شن تا وضعیت دنیا برای هر دو پلیر یکسان باشه.
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

function genPrices(prev: any, demandMap: any) {
  const p: any = {};
  ITEMS.forEach((item) => {
    if (!prev) {
      p[item.id] = item.base;
    } else {
      const factor = 0.65 + Math.random() * 0.9;
      let raw = Math.round((prev[item.id] ?? item.base) * factor);
      if (demandMap && Object.keys(demandMap).length > 0) {
        const totalDemand = Object.values(demandMap).reduce((s: number, v: any) => s + (v || 0), 0) || 1;
        const itemDemand = demandMap[item.id] || 0;
        const demandShare = itemDemand / totalDemand;
        const avgShare = 1 / ITEMS.length;
        let demandEffect = (avgShare - demandShare) * 1.2;
        demandEffect = Math.max(-0.2, Math.min(0.2, demandEffect));
        raw = Math.round(raw * (1 + demandEffect));
      }
      p[item.id] = Math.max(18, Math.min(350, raw));
    }
  });
  return p;
}

function genDarkPrices(normal: any) {
  const p: any = {};
  ITEMS.forEach((item) => {
    const disc = 0.3 + Math.random() * 0.4;
    p[item.id] = Math.max(8, Math.round((normal[item.id] ?? item.base) * (1 - disc)));
  });
  return p;
}

// رویدادهای مشترک — یک بار روی سرور رول می‌شن.
// kind='price' → روی قیمت‌های مشترک اعمال میشه (هر دو پلیر یکسان می‌بینن)
// kind='player' → هر کلاینت اثرش رو روی وضعیت شخصی خودش اعمال می‌کنه
const SHARED_EVENTS: any[] = [
  { id: "fire", kind: "price", mult: 0.5, text: "آتش‌سوزی در بازار! قیمت‌ها نصف شدند! 🔥" },
  { id: "returns", kind: "price", mult: 0.7, text: "بار برگشتی! ۳۰٪ تخفیف روی همه کالاها! 📦" },
  { id: "crisis", kind: "price", mult: 0.8, text: "بحران اقتصادی! ۲۰٪ کاهش قیمت! 📉" },
  { id: "benefactor", kind: "price", mult: 1.5, text: "مشتری خیّر آمد! ۵۰٪ افزایش قیمت! 💸" },
  { id: "goodnews", kind: "price", mult: 1.25, text: "خبر خوب اقتصادی! ۲۵٪ افزایش قیمت! 📰" },
  { id: "gift", kind: "player", text: "هدیه غافلگیرکننده! +۲۰۰ تومان! 🎁" },
  { id: "thief", kind: "player", text: "دزد به غرفه زد! حداکثر ۵۰ تومان دزدیده شد! 🦹" },
  { id: "lucky", kind: "player", text: "شانس آوردی! یک کالای مجانی به انبارت اضافه شد! 🍀" },
  { id: "festival", kind: "player", text: "جشنواره خرید! اولین خرید امروز ۵۰٪ تخفیف! 🎉" },
];

function rollSharedEvent() {
  if (Math.random() >= 0.7) return null;
  return SHARED_EVENTS[Math.floor(Math.random() * SHARED_EVENTS.length)];
}

function stateProfit(state: any, prices: any) {
  if (!state) return -Infinity;
  let inv = 0;
  (state.warehouse || []).forEach((w: any) => (inv += (w.qty || 0) * (prices?.[w.id] || 0)));
  (state.darkWarehouse || []).forEach((w: any) => (inv += (w.qty || 0) * (prices?.[w.id] || 0)));
  return (state.money || 0) + inv - (state.startMoney || 0) - (state.debt || 0);
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const ADVANCE_TIMEOUT_MS = 60000;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json();
    const { matchId, playerKey, playerState, action, reason } = body;
    if (!matchId || !["ready", "check", "sync", "finish"].includes(action)) {
      return json({ error: "درخواست نامعتبر" }, 400);
    }
    if (playerKey !== "player1" && playerKey !== "player2") {
      return json({ error: "playerKey نامعتبر" }, 400);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );
    const opponentKey = playerKey === "player1" ? "player2" : "player1";

    const MAX_RETRIES = 6;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const { data: match, error: fetchErr } = await admin
        .from("matches").select("*").eq("id", matchId).maybeSingle();
      if (fetchErr) return json({ error: "خطا در خواندن مچ" }, 500);
      if (!match) return json({ error: "مچ پیدا نشد" }, 404);

      // مچ قبلاً تموم شده — نتیجه موجود رو برگردون (idempotent)
      if (match.status === "finished") {
        return json({
          success: true, gameState: match.game_state, advanced: false,
          finished: true, result: match.game_state?.result || null,
          waitingForOpponent: false, secondsLeft: null,
        });
      }

      let gs: any = { ...(match.game_state || {}) };
      const snapshot = JSON.stringify(match.game_state || {});
      const currentDay = gs.day || 1;
      let newStatus: string | null = null;

      // merge وضعیت خود پلیر (فقط کلید خودش — اتمی داخل همین حلقه)
      if (playerState && action !== "check") {
        gs[playerKey] = { ...gs[playerKey], ...playerState };
      }

      if (action === "finish") {
        let winner: string;
        const finishReason = reason || "manual";
        if (finishReason === "abandon") {
          winner = opponentKey; // ترک بازی = باخت خودکار
        } else if (finishReason === "opponent-offline") {
          // قبل از پیروزی خودکار، مطمئن شو حریف واقعاً آفلاینه (ضد سوءاستفاده)
          const oppId = opponentKey === "player1" ? match.player1_id : match.player2_id;
          const { data: opp } = await admin
            .from("online_players").select("last_seen").eq("user_id", oppId).maybeSingle();
          const oppStale = !opp || Date.now() - new Date(opp.last_seen + "Z").getTime() > 60000;
          winner = oppStale ? playerKey : "auto";
        } else {
          winner = "auto";
        }
        const p1 = stateProfit(gs.player1, gs.prices || {});
        const p2 = stateProfit(gs.player2, gs.prices || {});
        if (winner === "auto") {
          winner = p1 > p2 ? "player1" : p2 > p1 ? "player2" : "draw";
        }
        gs.result = {
          winner,
          reason: finishReason,
          profits: { player1: Math.round(p1), player2: Math.round(p2) },
          finishedAt: new Date().toISOString(),
        };
        newStatus = "finished";
      }

      if (action === "ready" || action === "check") {
        if (action === "ready") {
          if (!gs.readyState) gs.readyState = {};
          if (!gs.readyState[playerKey] || gs.readyState[playerKey].day !== currentDay) {
            gs.readyState[playerKey] = { day: currentDay, readyAt: new Date().toISOString() };
          }
        }
        const myReady = gs.readyState?.[playerKey]?.day === currentDay;
        const oppReady = gs.readyState?.[opponentKey]?.day === currentDay;
        let shouldAdvance = false;
        if (myReady && oppReady) {
          shouldAdvance = true;
        } else if (myReady || oppReady) {
          const first = gs.readyState[myReady ? playerKey : opponentKey];
          if (first?.readyAt && Date.now() - new Date(first.readyAt).getTime() >= ADVANCE_TIMEOUT_MS) {
            shouldAdvance = true;
          }
        }

        if (shouldAdvance) {
          // تقاضای دیروز هر دو پلیر → قیمت‌های جدید
          const demandMap: any = {};
          ["player1", "player2"].forEach((pk) => {
            const dp = gs[pk]?._dayPurchases || {};
            Object.entries(dp).forEach(([id, qty]: any) => {
              demandMap[id] = (demandMap[id] || 0) + (qty || 0);
            });
          });
          gs.day = currentDay + 1;
          const newPrices = genPrices(gs.prices || null, demandMap);
          // رویداد مشترک — یک بار روی سرور رول میشه
          const ev = rollSharedEvent();
          if (ev && ev.kind === "price") {
            ITEMS.forEach((item) => {
              newPrices[item.id] = Math.max(18, Math.min(350, Math.round(newPrices[item.id] * ev.mult)));
            });
          }
          gs.prices = newPrices;
          gs.darkPrices = genDarkPrices(newPrices);
          if (!gs.priceHistory) gs.priceHistory = {};
          ITEMS.forEach((item) => {
            if (!gs.priceHistory[item.id]) gs.priceHistory[item.id] = [];
            gs.priceHistory[item.id].push(newPrices[item.id]);
            if (gs.priceHistory[item.id].length > 10) gs.priceHistory[item.id].shift();
          });
          gs.lastEvent = ev ? { id: ev.id, kind: ev.kind, text: ev.text, day: gs.day } : null;
          if (ev) {
            if (!gs.events) gs.events = [];
            gs.events.push(`🎲 ${ev.text}`);
            if (gs.events.length > 60) gs.events = gs.events.slice(-60);
          }
          ["player1", "player2"].forEach((pk) => {
            if (gs[pk]) gs[pk]._dayPurchases = {};
          });
          gs.readyState = {};
        }
      }

      // گارد race condition: بین خوندن و الان کسی game_state رو عوض کرده؟
      const { data: recheck } = await admin
        .from("matches").select("game_state,status").eq("id", matchId).maybeSingle();
      if (!recheck) return json({ error: "مچ پیدا نشد" }, 404);
      if (recheck.status === "finished") {
        return json({
          success: true, gameState: recheck.game_state, advanced: false,
          finished: true, result: recheck.game_state?.result || null,
          waitingForOpponent: false, secondsLeft: null,
        });
      }
      if (JSON.stringify(recheck.game_state || {}) !== snapshot) {
        await new Promise((r) => setTimeout(r, 60 + Math.random() * 140));
        continue;
      }

      const update: any = { game_state: gs };
      if (newStatus) update.status = newStatus;
      const { error: updateErr } = await admin.from("matches").update(update).eq("id", matchId);
      if (updateErr) return json({ error: "خطا در آپدیت: " + updateErr.message }, 500);

      if (action === "finish") {
        return json({
          success: true, gameState: gs, advanced: false,
          finished: true, result: gs.result, waitingForOpponent: false, secondsLeft: null,
        });
      }

      const advanced = gs.day > currentDay;
      const stillWaiting = !advanced && action === "ready" &&
        !!gs.readyState?.[playerKey] && gs.readyState?.[opponentKey]?.day !== currentDay;
      let secondsLeft: number | null = null;
      if (stillWaiting && gs.readyState?.[playerKey]?.readyAt) {
        secondsLeft = Math.max(
          0,
          Math.ceil((ADVANCE_TIMEOUT_MS - (Date.now() - new Date(gs.readyState[playerKey].readyAt).getTime())) / 1000),
        );
      }
      return json({
        success: true, gameState: gs, advanced,
        finished: newStatus === "finished", result: gs.result || null,
        waitingForOpponent: stillWaiting, secondsLeft,
        lastEvent: gs.lastEvent || null,
      });
    }
    return json({ error: "سرور مشغوله، دوباره تلاش کن" }, 409);
  } catch (e: any) {
    return json({ error: "خطای سرور: " + (e?.message || String(e)) }, 500);
  }
});
