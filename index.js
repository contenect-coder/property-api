const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
require("dotenv").config();
const pointsRouter = require("./points.js");

const { sendEmail } = require("./mailer.js");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Ensure the uploads folder exists
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// Serve uploaded images at http://localhost:3001/uploads/<filename>
app.use("/uploads", express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB cap
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Only image files are allowed"));
    cb(null, true);
  },
});

const propertyUpload = upload.fields([
  { name: "image", maxCount: 1 },
  { name: "tour_image", maxCount: 1 },
]);

// Helper & background task functions
async function growPropertyValues() {
  try {
    const properties = await pool.query("select id from properties");

    for (const { id } of properties.rows) {
      const latest = await pool.query(
        "select value from valuations where property_id = $1 order by recorded_at desc limit 1",
        [id]
      );
      if (latest.rows.length === 0) continue;

      const currentValue = Number(latest.rows[0].value);
      const growthFactor = 1 + (Math.random() * 0.0005 + 0.0001); // 0.01%–0.06% per run
      const newValue = Math.round(currentValue * growthFactor);

      await pool.query(
        "insert into valuations (property_id, value) values ($1, $2)",
        [id, newValue]
      );
    }
  } catch (err) {
    console.error("Error growing property values:", err);
  }
}

// Run every 30 minutes instead of every 60 seconds
setInterval(growPropertyValues, 30 * 60 * 1000);

// Health Checks
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/db-check", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ connected: true, time: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ connected: false, error: err.message });
  }
});

// Payments
app.post("/payments", async (req, res) => {
  const { user_id, type, amount, property_id, maintenance_request_id, note } = req.body;

  if (!user_id || !type || !amount) {
    return res.status(400).json({ error: "user_id, type, and amount are required" });
  }
  if (!["rent", "maintenance_fee", "other"].includes(type)) {
    return res.status(400).json({ error: "type must be rent, maintenance_fee, or other" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO payments (user_id, property_id, maintenance_request_id, type, amount, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [user_id, property_id || null, maintenance_request_id || null, type, amount, note || null]
    );

    await createNotification(user_id, "Payment received", `We've recorded your payment of Rs. ${amount}.`);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error recording payment:", err);
    res.status(500).json({ error: "Failed to record payment" });
  }
});

app.get("/users/:userId/payments", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         pay.*,
         p.title AS property_title, p.location AS property_location,
         mr.category AS maintenance_category
       FROM payments pay
       LEFT JOIN properties p ON p.id = pay.property_id
       LEFT JOIN maintenance_requests mr ON mr.id = pay.maintenance_request_id
       WHERE pay.user_id = $1
       ORDER BY pay.paid_at DESC`,
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching payments:", err);
    res.status(500).json({ error: "Failed to fetch payments" });
  }
});

// Notifications
app.get("/users/:userId/notifications", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching notifications:", err);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

app.patch("/notifications/:id/read", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE notifications SET read = true WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Notification not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error marking notification read:", err);
    res.status(500).json({ error: "Failed to mark notification read" });
  }
});

// Properties
app.get("/properties", async (req, res) => {
  try {
    const result = await pool.query(`
      select p.*, v.value as current_value
      from properties p
      left join lateral (
        select value from valuations
        where property_id = p.id
        order by recorded_at desc
        limit 1
      ) v on true
      order by p.created_at desc
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/properties/:id/valuations", async (req, res) => {
  try {
    const result = await pool.query(
      "select value, recorded_at from valuations where property_id = $1 order by recorded_at asc",
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/properties", propertyUpload, async (req, res) => {
  try {
    const { title, location, property_type, deal_type, beds, baths, price_value, tour_url } = req.body;
    const image_url = req.files?.image?.[0] ? `/uploads/${req.files.image[0].filename}` : null;
    const tour_image_url = req.files?.tour_image?.[0]
      ? `/uploads/${req.files.tour_image[0].filename}`
      : null;

    const result = await pool.query(
      `INSERT INTO properties (title, location, property_type, deal_type, beds, baths, price_value, image_url, tour_url, tour_image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        title,
        location,
        property_type,
        deal_type,
        beds || null,
        baths || null,
        price_value,
        image_url,
        tour_url || null,
        tour_image_url,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// Property Ownership & Positions
app.post("/property-owners", async (req, res) => {
  const { user_id, property_id } = req.body;
  if (!user_id || !property_id) {
    return res.status(400).json({ error: "user_id and property_id are required" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO property_owners (user_id, property_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, property_id) DO NOTHING
       RETURNING *`,
      [user_id, property_id]
    );

    if (result.rows[0]) {
      await createNotification(user_id, "Property purchased", "Your property purchase was completed successfully.");
    }

    res.status(201).json(result.rows[0] || { user_id, property_id, already_owned: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to record purchase" });
  }
});

app.get("/users/:userId/properties", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, po.purchased_at
       FROM property_owners po
       JOIN properties p ON p.id = po.property_id
       WHERE po.user_id = $1
       ORDER BY po.purchased_at DESC`,
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch owned properties" });
  }
});

app.post("/positions", async (req, res) => {
  const { user_id, property_id, amount } = req.body;
  if (!user_id || !property_id || !amount) {
    return res.status(400).json({ error: "user_id, property_id, and amount are required" });
  }
  try {
    const latest = await pool.query(
      "select value from valuations where property_id = $1 order by recorded_at desc limit 1",
      [property_id]
    );
    if (latest.rows.length === 0) {
      return res.status(404).json({ error: "No valuation found for this property" });
    }
    const valueAtEntry = latest.rows[0].value;
    const result = await pool.query(
      `insert into positions (user_id, property_id, amount, value_at_entry)
       values ($1, $2, $3, $4) returning *`,
      [user_id, property_id, amount, valueAtEntry]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/users/:userId/portfolio", async (req, res) => {
  try {
    const result = await pool.query(
      `
      select
        pos.id, pos.amount, pos.value_at_entry, pos.created_at,
        p.id as property_id, p.title, p.location,
        v.value as current_property_value,
        round((pos.amount / pos.value_at_entry) * v.value, 2) as current_value
      from positions pos
      join properties p on p.id = pos.property_id
      left join lateral (
        select value from valuations
        where property_id = p.id
        order by recorded_at desc
        limit 1
      ) v on true
      where pos.user_id = $1
      order by pos.created_at desc
      `,
      [req.params.userId]
    );

    const round2 = (n) => Number(n.toFixed(2));

    const positions = result.rows.map((row) => {
      const amount = Number(row.amount);
      const currentValue = Number(row.current_value);
      const profit = round2(currentValue - amount);
      const profitPct = amount > 0 ? round2((profit / amount) * 100) : 0;

      return {
        ...row,
        amount,
        value_at_entry: Number(row.value_at_entry),
        current_property_value: Number(row.current_property_value),
        current_value: currentValue,
        profit,
        profit_pct: profitPct,
      };
    });

    const totalInvested = round2(positions.reduce((sum, p) => sum + p.amount, 0));
    const totalCurrentValue = round2(positions.reduce((sum, p) => sum + p.current_value, 0));
    const totalProfit = round2(totalCurrentValue - totalInvested);
    const totalProfitPct = totalInvested > 0 ? round2((totalProfit / totalInvested) * 100) : 0;

    res.json({
      positions,
      totals: {
        total_invested: totalInvested,
        total_current_value: totalCurrentValue,
        total_profit: totalProfit,
        total_profit_pct: totalProfitPct,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Maintenance Requests
app.post("/maintenance-requests", upload.single("image"), async (req, res) => {
  const { user_id, property_id, category, description, preferred_date } = req.body;

  if (!user_id || !property_id || !category) {
    return res.status(400).json({ error: "user_id, property_id, and category are required" });
  }

  try {
    const ownerCheck = await pool.query(
      "SELECT 1 FROM property_owners WHERE user_id = $1 AND property_id = $2",
      [user_id, property_id]
    );
    if (ownerCheck.rowCount === 0) {
      return res.status(403).json({ error: "Only the property owner can request maintenance" });
    }

    const image_url = req.file ? `/uploads/${req.file.filename}` : null;

    const result = await pool.query(
      `INSERT INTO maintenance_requests
        (user_id, property_id, category, description, image_url, preferred_date)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [user_id, property_id, category, description || null, image_url, preferred_date || null]
    );

    await createNotification(
      user_id,
      "Maintenance request submitted",
      `Your ${category.replace("_", " ")} request has been received.`
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error creating maintenance request:", err);
    res.status(500).json({ error: "Failed to create maintenance request" });
  }
});

app.get("/users/:userId/maintenance-requests", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT mr.*, p.title AS property_title, p.location AS property_location
       FROM maintenance_requests mr
       JOIN properties p ON p.id = mr.property_id
       WHERE mr.user_id = $1
       ORDER BY mr.created_at DESC`,
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching maintenance requests:", err);
    res.status(500).json({ error: "Failed to fetch maintenance requests" });
  }
});

// Community Posts
app.get("/community-posts", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, user_id, author_name, content, image_url, created_at
       FROM community_posts
       ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching community posts:", err);
    res.status(500).json({ error: "Failed to fetch community posts" });
  }
});

app.post("/community-posts", upload.single("image"), async (req, res) => {
  try {
    const { user_id, content, author_name } = req.body;
    if (!user_id || !content || !content.trim()) {
      return res.status(400).json({ error: "user_id and content are required" });
    }

    const image_url = req.file ? `/uploads/${req.file.filename}` : null;

    const result = await pool.query(
      `INSERT INTO community_posts (user_id, author_name, content, image_url)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, author_name, content, image_url, created_at`,
      [user_id, author_name || null, content.trim(), image_url]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error creating community post:", err);
    res.status(500).json({ error: "Failed to create community post" });
  }
});

// GET upcoming events, soonest first
app.get("/community-events", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM community_events
       WHERE event_date >= CURRENT_DATE
       ORDER BY event_date ASC, event_time ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create event (multer, same upload pattern as community-posts)
app.post("/community-events", upload.single("image"), async (req, res) => {
  try {
    const { title, description, category, event_date, event_time, location, created_by, organizer_name } = req.body;
    const image_url = req.file ? `/uploads/${req.file.filename}` : null;

    const { rows } = await pool.query(
      `INSERT INTO community_events
        (title, description, category, event_date, event_time, location, image_url, created_by, organizer_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [title, description || null, category || "gathering", event_date, event_time || null, location || null, image_url, created_by || null, organizer_name || "Resident"]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/amenities", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM amenities ORDER BY name ASC`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// existing bookings for one amenity on one date, so the frontend can grey out taken slots
app.get("/amenities/:id/bookings", async (req, res) => {
  try {
    const { date } = req.query;
    const { rows } = await pool.query(
      `SELECT start_time, end_time FROM amenity_bookings
       WHERE amenity_id = $1 AND booking_date = $2 AND status = 'confirmed'`,
      [req.params.id, date]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/amenity-bookings", async (req, res) => {
  try {
    const { amenity_id, user_id, booking_date, start_time, end_time } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO amenity_bookings (amenity_id, user_id, booking_date, start_time, end_time)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [amenity_id, user_id, booking_date, start_time, end_time]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "That slot was just taken — pick another." });
    }
    res.status(500).json({ error: err.message });
  }
});

app.get("/users/:userId/amenity-bookings", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ab.*, a.name AS amenity_name, a.category
       FROM amenity_bookings ab
       JOIN amenities a ON a.id = ab.amenity_id
       WHERE ab.user_id = $1 AND ab.status = 'confirmed'
       ORDER BY ab.booking_date ASC, ab.start_time ASC`,
      [req.params.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/amenity-bookings/:id/cancel", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE amenity_bookings SET status = 'cancelled' WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Booking not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Favorites
app.get("/users/:userId/favorites", async (req, res) => {
  try {
    const result = await pool.query(
      `select p.*, v.value as current_value, f.created_at as favorited_at
       from favorites f
       join properties p on p.id = f.property_id
       left join lateral (
         select value from valuations
         where property_id = p.id
         order by recorded_at desc
         limit 1
       ) v on true
       where f.user_id = $1
       order by f.created_at desc`,
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/favorites", async (req, res) => {
  const { user_id, property_id } = req.body;
  if (!user_id || !property_id) {
    return res.status(400).json({ error: "user_id and property_id are required" });
  }
  try {
    const result = await pool.query(
      `insert into favorites (user_id, property_id) values ($1, $2)
       on conflict (user_id, property_id) do nothing
       returning *`,
      [user_id, property_id]
    );
    res.status(201).json(result.rows[0] || { message: "Already favorited" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/favorites", async (req, res) => {
  const { user_id, property_id } = req.body;
  if (!user_id || !property_id) {
    return res.status(400).json({ error: "user_id and property_id are required" });
  }
  try {
    await pool.query(
      `delete from favorites where user_id = $1 and property_id = $2`,
      [user_id, property_id]
    );
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Newsletter
app.post("/newsletter/subscribe", async (req, res) => {
  const { email, resendEmail } = req.body;

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: "A valid email is required" });
  }

  const cleanEmail = email.toLowerCase().trim();

  try {
    const result = await pool.query(
      `INSERT INTO newsletter_subscribers (email)
       VALUES ($1)
       ON CONFLICT (email) DO NOTHING
       RETURNING *`,
      [cleanEmail]
    );

    const alreadySubscribed = result.rows.length === 0;
    let emailResult = null;

    // Send confirmation email for new subscribers or if specifically requested
    if (!alreadySubscribed || resendEmail === true) {
      emailResult = await sendEmail({
        to: cleanEmail,
        subject: "Welcome to HOME Real Estate — Subscription Confirmed",
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px; background: #ffffff; border: 1px solid #e7e5e4; border-radius: 16px;">
            <div style="text-align: center; margin-bottom: 28px;">
              <h1 style="color: #1c1917; margin: 0; font-size: 26px; font-weight: 700; letter-spacing: -0.5px;">HOME Real Estate</h1>
              <p style="color: #78716c; font-size: 14px; margin-top: 6px;">Your premier gateway to curated real estate in Sri Lanka</p>
            </div>
            
            <div style="background-color: #fcfbf9; border: 1px solid #f5f5f4; padding: 24px; border-radius: 12px; margin-bottom: 24px;">
              <h2 style="color: #292524; font-size: 18px; margin-top: 0; font-weight: 600;">You're successfully subscribed! 🎉</h2>
              <p style="color: #57534e; font-size: 15px; line-height: 1.6; margin: 0 0 12px 0;">
                Thank you for joining. We have confirmed your subscription for:
              </p>
              <div style="background: #ffffff; padding: 10px 16px; border-radius: 8px; border: 1px dashed #d6d3d1; font-family: monospace; font-size: 14px; color: #1c1917; display: inline-block;">
                ${cleanEmail}
              </div>
              <p style="color: #57534e; font-size: 14px; line-height: 1.6; margin: 16px 0 0 0;">
                You will receive our weekly curated picks across <strong>Buy</strong>, <strong>Rent</strong>, and <strong>Invest</strong> categories, along with neighborhood price insights and verified market updates.
              </p>
            </div>

            <div style="text-align: center; margin: 32px 0;">
              <a href="https://famous-pavlova-ed0138.netlify.app/" style="background: #1c1917; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 9999px; font-weight: 600; font-size: 14px; display: inline-block;">
                Explore Latest Listings →
              </a>
            </div>

            <hr style="border: none; border-top: 1px solid #f5f5f4; margin: 28px 0;" />
            <p style="color: #a8a29e; font-size: 12px; text-align: center; margin: 0; line-height: 1.5;">
              © 2026 HOME Real Estate Agency. Colombo, Sri Lanka.<br/>
              If you didn't request this email, you can ignore it or unsubscribe anytime.
            </p>
          </div>
        `,
        text: `Welcome to HOME Real Estate!\n\nYour subscription for ${cleanEmail} has been confirmed. You will receive weekly picks for buying, renting, and investing in Sri Lanka.\n\nBrowse properties anytime at: https://famous-pavlova-ed0138.netlify.app/`,
      });
    }

    res.status(alreadySubscribed ? 200 : 201).json({
      message: alreadySubscribed ? "Already subscribed" : "Subscribed successfully",
      subscriber: result.rows[0] || { email: cleanEmail },
      emailSent: emailResult ? emailResult.success : false,
      emailProvider: emailResult ? emailResult.provider : null,
      emailError: emailResult && !emailResult.success ? emailResult.error : null,
    });
  } catch (err) {
    console.error("Error subscribing to newsletter:", err);
    res.status(500).json({ error: "Failed to subscribe" });
  }
});

app.use("/points", pointsRouter);

app.use("/agents", require("./agents"));


// Global Error Handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(400).json({ error: err.message || "Unexpected server error" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));