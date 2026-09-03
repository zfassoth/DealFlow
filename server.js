const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

const isRender = !!process.env.RENDER;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isRender ? { rejectUnauthorized: false } : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT DEFAULT 'Salesperson',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS customers (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      vehicle TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'New Lead',
      source TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      next_follow_up DATE,
      last_contact TEXT DEFAULT 'Never',
      sold_date DATE,
      priority TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS activities (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_customers_user_id ON customers(user_id);
    CREATE INDEX IF NOT EXISTS idx_customers_followup ON customers(user_id, next_follow_up);
    CREATE INDEX IF NOT EXISTS idx_activities_customer ON activities(customer_id, created_at DESC);
  `);
}

app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new pgSession({
    pool,
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || "replace-this-in-render",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: isRender,
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
}));

app.use(express.static(path.join(__dirname, "public")));

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(":");
  const actual = crypto.scryptSync(password, salt, 64);
  const expectedBuf = Buffer.from(expected, "hex");
  return expectedBuf.length === actual.length && crypto.timingSafeEqual(expectedBuf, actual);
}
function auth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not signed in" });
  next();
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function offsetISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
async function logActivity(userId, customerId, text) {
  await pool.query(
    "INSERT INTO activities(user_id, customer_id, text) VALUES($1,$2,$3)",
    [userId, customerId, text]
  );
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

app.post("/api/register", async (req, res) => {
  const { email, password, displayName } = req.body;
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: "Use an email and password of at least 6 characters." });
  }
  try {
    const result = await pool.query(
      "INSERT INTO users(email,password_hash,display_name) VALUES($1,$2,$3) RETURNING id",
      [email.trim().toLowerCase(), hashPassword(password), (displayName || "Salesperson").trim()]
    );
    req.session.userId = result.rows[0].id;
    res.json({ ok: true });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "That email is already registered." });
    console.error(e);
    res.status(500).json({ error: "Could not create account." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query("SELECT * FROM users WHERE email=$1", [(email || "").trim().toLowerCase()]);
    const user = result.rows[0];
    if (!user || !verifyPassword(password || "", user.password_hash)) {
      return res.status(401).json({ error: "Invalid email or password." });
    }
    req.session.userId = user.id;
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not sign in." });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", auth, async (req, res) => {
  const result = await pool.query(
    "SELECT id,email,display_name FROM users WHERE id=$1",
    [req.session.userId]
  );
  res.json(result.rows[0]);
});

app.get("/api/customers", auth, async (req, res) => {
  try {
    const c = await pool.query(
      "SELECT * FROM customers WHERE user_id=$1 ORDER BY updated_at DESC",
      [req.session.userId]
    );
    const a = await pool.query(
      "SELECT * FROM activities WHERE user_id=$1 ORDER BY created_at DESC",
      [req.session.userId]
    );
    const grouped = {};
    for (const item of a.rows) (grouped[item.customer_id] ||= []).push(item);
    res.json(c.rows.map(row => ({
      ...row,
      next_follow_up: row.next_follow_up ? new Date(row.next_follow_up).toISOString().slice(0,10) : "",
      sold_date: row.sold_date ? new Date(row.sold_date).toISOString().slice(0,10) : "",
      activity: (grouped[row.id] || []).slice(0, 25)
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not load customers." });
  }
});

app.post("/api/customers", auth, async (req, res) => {
  try {
    const c = req.body;
    const soldDate = c.status === "Sold" ? todayISO() : null;
    const result = await pool.query(`
      INSERT INTO customers
      (user_id,name,phone,vehicle,status,source,notes,next_follow_up,last_contact,sold_date,priority)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING id
    `, [
      req.session.userId,
      c.name,
      c.phone || "",
      c.vehicle,
      c.status || "New Lead",
      c.source || "",
      c.notes || "",
      c.next_follow_up || todayISO(),
      "Never",
      soldDate,
      c.priority || ""
    ]);
    await logActivity(req.session.userId, result.rows[0].id, "Customer added");
    res.json({ id: result.rows[0].id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not add customer." });
  }
});

app.put("/api/customers/:id", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const c = req.body;
    const check = await pool.query("SELECT * FROM customers WHERE id=$1 AND user_id=$2", [id, req.session.userId]);
    if (!check.rows[0]) return res.status(404).json({ error: "Not found" });
    const current = check.rows[0];
    const soldDate = c.status === "Sold" ? (c.sold_date || current.sold_date || todayISO()) : (c.sold_date || null);
    await pool.query(`
      UPDATE customers SET
        name=$1, phone=$2, vehicle=$3, status=$4, source=$5, notes=$6,
        next_follow_up=$7, last_contact=$8, sold_date=$9, priority=$10, updated_at=NOW()
      WHERE id=$11 AND user_id=$12
    `, [
      c.name, c.phone || "", c.vehicle, c.status || "New Lead", c.source || "", c.notes || "",
      c.next_follow_up || null, c.last_contact || current.last_contact, soldDate, c.priority || "",
      id, req.session.userId
    ]);
    await logActivity(req.session.userId, id, "Customer updated");
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not update customer." });
  }
});

app.post("/api/customers/:id/action", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const action = req.body.action;
    const check = await pool.query("SELECT * FROM customers WHERE id=$1 AND user_id=$2", [id, req.session.userId]);
    const c = check.rows[0];
    if (!c) return res.status(404).json({ error: "Not found" });

    if (action === "called") {
      await pool.query("UPDATE customers SET last_contact='Today', next_follow_up=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
        [offsetISO(2), id, req.session.userId]);
      await logActivity(req.session.userId, id, "Called customer · next follow-up in 2 days");
    } else if (action === "noanswer") {
      await pool.query("UPDATE customers SET last_contact='Today', next_follow_up=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
        [offsetISO(1), id, req.session.userId]);
      await logActivity(req.session.userId, id, "No answer · follow-up tomorrow");
    } else if (action === "appt") {
      await pool.query("UPDATE customers SET status='Appointment', next_follow_up=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
        [todayISO(), id, req.session.userId]);
      await logActivity(req.session.userId, id, "Appointment set");
    } else if (action === "sold") {
      await pool.query("UPDATE customers SET status='Sold', sold_date=$1, next_follow_up=$2, updated_at=NOW() WHERE id=$3 AND user_id=$4",
        [todayISO(), offsetISO(7), id, req.session.userId]);
      await logActivity(req.session.userId, id, "Marked sold · 7-day follow-up scheduled");
    } else if (action === "hot") {
      const next = c.priority === "hot" ? "" : "hot";
      await pool.query("UPDATE customers SET priority=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
        [next, id, req.session.userId]);
      await logActivity(req.session.userId, id, next === "hot" ? "Marked as hot prospect" : "Removed hot prospect");
    } else {
      return res.status(400).json({ error: "Unknown action" });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not update customer." });
  }
});

app.post("/api/customers/:id/followup", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const days = Number(req.body.days || 1);
    const check = await pool.query("SELECT id FROM customers WHERE id=$1 AND user_id=$2", [id, req.session.userId]);
    if (!check.rows[0]) return res.status(404).json({ error: "Not found" });
    const date = offsetISO(days);
    await pool.query("UPDATE customers SET next_follow_up=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3",
      [date, id, req.session.userId]);
    await logActivity(req.session.userId, id, `Follow-up scheduled for ${date}`);
    res.json({ ok: true, date });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not schedule follow-up." });
  }
});

function fallbackMessage(c) {
  const first = (c.name || "there").split(" ")[0];
  const notes = (c.notes || "").toLowerCase();
  if (c.status === "Sold") return `Hey ${first}, hope you're still loving the ${c.vehicle}. If you know anyone starting to look for a vehicle, I'd really appreciate you sending them my way. I'll take great care of them.`;
  if (notes.includes("wife") || notes.includes("spouse")) return `Hey ${first}, I was thinking about the ${c.vehicle} we talked about. Did you get a chance to go over everything at home? I'm happy to help with any questions or see if there's another way to make the numbers work better.`;
  if (notes.includes("payment")) return `Hey ${first}, I wanted to circle back on the ${c.vehicle}. I know the payment was the biggest piece we were working through. If you're still interested, I can take another look at the options and see what makes the most sense.`;
  if (c.status === "Appointment") return `Hey ${first}, just confirming we're still good for your visit to check out the ${c.vehicle}. I'll make sure everything is ready for you when you get here.`;
  if (c.status === "New Lead") return `Hey ${first}, I'm reaching out about the ${c.vehicle}. I can help with availability, pricing, trade value, or anything else you want to know. What's most important to you right now?`;
  return `Hey ${first}, I wanted to follow up on the ${c.vehicle} and see where things stand. If you're still considering it, I'm happy to help with any questions or next steps.`;
}

app.post("/api/customers/:id/message", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const result = await pool.query("SELECT * FROM customers WHERE id=$1 AND user_id=$2", [id, req.session.userId]);
    const c = result.rows[0];
    if (!c) return res.status(404).json({ error: "Not found" });

    if (!process.env.OPENAI_API_KEY) return res.json({ message: fallbackMessage(c), mode: "fallback" });

    try {
      const OpenAI = require("openai");
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await client.responses.create({
        model: process.env.OPENAI_MODEL || "gpt-5-mini",
        input: [
          { role: "system", content: "Write one short, natural automotive salesperson follow-up text. Be warm, specific, non-pushy, and never invent facts. Do not include quotation marks." },
          { role: "user", content: `Customer: ${c.name}\nVehicle: ${c.vehicle}\nStatus: ${c.status}\nNotes: ${c.notes}\nLast contact: ${c.last_contact}\nNext follow-up: ${c.next_follow_up || ""}` }
        ]
      });
      res.json({ message: response.output_text.trim(), mode: "ai" });
    } catch (aiErr) {
      console.error("AI fallback:", aiErr.message);
      res.json({ message: fallbackMessage(c), mode: "fallback" });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not generate message." });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDb()
  .then(() => app.listen(PORT, () => console.log(`DealFlow running on port ${PORT}`)))
  .catch(err => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });
