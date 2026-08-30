const express = require("express");
const router = express.Router();
const { supabaseAdmin: supabase } = require("./supabaseAdmin.js");
const { requireAuth } = require("./auth.js");

// GET /points/balance
router.get("/balance", requireAuth, async (req, res) => {
  const userId = req.user.id;

  const { data, error } = await supabase
    .from("user_points")
    .select("balance")
    .eq("user_id", userId)
    .single();

  if (error && error.code !== "PGRST116") return res.status(500).json({ error: error.message });

  res.json({ balance: data?.balance ?? 0 });
});

// GET /points/history
router.get("/history", requireAuth, async (req, res) => {
  const userId = req.user.id;

  const { data, error } = await supabase
    .from("points_transactions")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ transactions: data });
});

// POST /points/earn
router.post("/earn", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { actionKey, referenceId } = req.body;

  const { data: rule, error: ruleError } = await supabase
    .from("points_rules")
    .select("points, active")
    .eq("action_key", actionKey)
    .single();

  if (ruleError || !rule || !rule.active) {
    return res.status(400).json({ error: "Invalid or inactive action" });
  }

  const { error: txError } = await supabase.from("points_transactions").insert({
    user_id: userId,
    amount: rule.points,
    reason: actionKey,
    reference_id: referenceId ?? null,
  });

  if (txError) return res.status(500).json({ error: txError.message });

  const { data: current } = await supabase
    .from("user_points")
    .select("balance")
    .eq("user_id", userId)
    .single();

  const newBalance = (current?.balance ?? 0) + rule.points;

  const { error: balError } = await supabase
    .from("user_points")
    .upsert({ user_id: userId, balance: newBalance, updated_at: new Date() });

  if (balError) return res.status(500).json({ error: balError.message });

  res.json({ earned: rule.points, newBalance });
});

// GET /points/rewards
router.get("/rewards", requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("rewards_catalog")
    .select("*")
    .eq("active", true)
    .order("points_cost", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ rewards: data });
});

// POST /points/redeem
router.post("/redeem", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { rewardId } = req.body;

  const { data: reward, error: rewardError } = await supabase
    .from("rewards_catalog")
    .select("points_cost, active")
    .eq("id", rewardId)
    .single();

  if (rewardError || !reward || !reward.active) {
    return res.status(400).json({ error: "Invalid or inactive reward" });
  }

  const { data: current, error: balError } = await supabase
    .from("user_points")
    .select("balance")
    .eq("user_id", userId)
    .single();

  if (balError || !current || current.balance < reward.points_cost) {
    return res.status(400).json({ error: "Insufficient points" });
  }

  const newBalance = current.balance - reward.points_cost;

  const { error: updateError } = await supabase
    .from("user_points")
    .update({ balance: newBalance, updated_at: new Date() })
    .eq("user_id", userId);

  if (updateError) return res.status(500).json({ error: updateError.message });

  await supabase.from("points_transactions").insert({
    user_id: userId,
    amount: -reward.points_cost,
    reason: "redemption",
    reference_id: rewardId,
  });

  const { error: redemptionError } = await supabase
    .from("reward_redemptions")
    .insert({ user_id: userId, reward_id: rewardId, status: "pending" });

  if (redemptionError) return res.status(500).json({ error: redemptionError.message });

  res.json({ redeemed: reward.points_cost, newBalance });
});

module.exports = router;