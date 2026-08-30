const express = require("express");
const router = express.Router();
const { supabaseAdmin: supabase } = require("./supabaseAdmin.js");
const { requireAuth } = require("./auth.js");

// GET /agents/me — check if the current user is a registered agent
router.get("/me", requireAuth, async (req, res) => {
  const userId = req.user.id;

  const { data, error } = await supabase
    .from("agents")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error && error.code !== "PGRST116") {
    return res.status(500).json({ error: error.message });
  }

  res.json({ agent: data || null });
});

// POST /agents/register
router.post("/register", requireAuth, async (req, res) => {
  const userId = req.user.id;
  const { agencyName, licenseNumber, phone } = req.body;

  if (!agencyName || !licenseNumber || !phone) {
    return res.status(400).json({ error: "Agency name, license number, and phone are required" });
  }

  const { data: existing } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", userId)
    .single();

  if (existing) {
    return res.status(400).json({ error: "You're already registered as an agent" });
  }

  const { data, error } = await supabase
    .from("agents")
    .insert({
      user_id: userId,
      agency_name: agencyName,
      license_number: licenseNumber,
      phone,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.json({ agent: data });
});

module.exports = router;