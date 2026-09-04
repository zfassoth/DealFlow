const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const path = require("path");
const crypto = require("crypto");
const webpush = require("web-push");
require("dotenv").config();

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const NOTIFICATION_JOB_SECRET = process.env.NOTIFICATION_JOB_SECRET || "";
const NOTIFICATION_TIME_ZONE = process.env.NOTIFICATION_TIME_ZONE || "America/Chicago";
const NOTIFICATION_HOUR = Math.max(0, Math.min(23, Number(process.env.NOTIFICATION_HOUR || 9)));

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:dealflow@example.com",
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

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
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      archived_at TIMESTAMPTZ,
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

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notification_runs (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      local_date DATE NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(user_id, local_date)
    );

    ALTER TABLE customers ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_customers_user_id ON customers(user_id);
    CREATE INDEX IF NOT EXISTS idx_customers_followup ON customers(user_id, next_follow_up);
    CREATE INDEX IF NOT EXISTS idx_customers_archived ON customers(user_id, archived);
    CREATE INDEX IF NOT EXISTS idx_activities_customer ON activities(customer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
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
function dateISOInTimeZone(date = new Date(), timeZone = NOTIFICATION_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function todayISO() {
  return dateISOInTimeZone(new Date());
}
function offsetISO(days) {
  const base = todayISO();
  const [y,m,d] = base.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  return utc.toISOString().slice(0, 10);
}
async function logActivity(userId, customerId, text) {
  await pool.query(
    "INSERT INTO activities(user_id, customer_id, text) VALUES($1,$2,$3)",
    [userId, customerId, text]
  );
}

function localDateAndHour(timeZone = NOTIFICATION_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type)?.value || "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

async function sendPushToUser(userId, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return { sent: 0, disabled: true };
  const subs = await pool.query("SELECT * FROM push_subscriptions WHERE user_id=$1", [userId]);
  let sent = 0;
  for (const row of subs.rows) {
    const subscription = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await pool.query("DELETE FROM push_subscriptions WHERE id=$1", [row.id]);
      } else {
        console.error("Push send failed:", err.statusCode || err.message);
      }
    }
  }
  return { sent };
}

async function runDueNotifications(force = false) {
  const { date, hour } = localDateAndHour();
  if (!force && hour < NOTIFICATION_HOUR) return { ok: true, skipped: "before_notification_hour", date, hour };

  const users = await pool.query("SELECT DISTINCT user_id FROM push_subscriptions");
  let usersNotified = 0, pushesSent = 0;
  for (const u of users.rows) {
    if (!force) {
      const already = await pool.query("SELECT 1 FROM notification_runs WHERE user_id=$1 AND local_date=$2", [u.user_id, date]);
      if (already.rows[0]) continue;
    }
    const due = await pool.query(`
      SELECT id,name,vehicle,next_follow_up FROM customers
      WHERE user_id=$1 AND archived=FALSE AND status NOT IN ('Sold','Lost')
        AND next_follow_up IS NOT NULL AND next_follow_up <= $2::date
      ORDER BY next_follow_up ASC, updated_at DESC
    `, [u.user_id, date]);
    if (!due.rows.length) continue;

    let payload;
    if (due.rows.length === 1) {
      const c = due.rows[0];
      payload = { title: "DealFlow · Follow-up Due", body: `${c.name} · ${c.vehicle}
Time to follow up.`, url: "/?view=today", tag: `dealflow-due-${date}` };
    } else {
      const first = due.rows[0];
      payload = { title: `DealFlow · ${due.rows.length} Follow-ups Due`, body: `${first.name} · ${first.vehicle}${due.rows.length > 1 ? ` + ${due.rows.length - 1} more` : ""}`, url: "/?view=today", tag: `dealflow-due-${date}` };
    }
    const result = await sendPushToUser(u.user_id, payload);
    if (result.sent > 0) {
      pushesSent += result.sent; usersNotified++;
      if (!force) await pool.query("INSERT INTO notification_runs(user_id, local_date) VALUES($1,$2) ON CONFLICT DO NOTHING", [u.user_id, date]);
    }
  }
  return { ok: true, date, hour, usersNotified, pushesSent };
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

app.get("/api/push/config", auth, (req, res) => {
  res.json({ enabled: !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY), publicKey: VAPID_PUBLIC_KEY, hour: NOTIFICATION_HOUR, timeZone: NOTIFICATION_TIME_ZONE });
});

app.get("/api/push/status", auth, async (req, res) => {
  const count = await pool.query("SELECT COUNT(*)::int AS count FROM push_subscriptions WHERE user_id=$1", [req.session.userId]);
  res.json({ subscribed: count.rows[0].count > 0, subscriptions: count.rows[0].count });
});

app.post("/api/push/subscribe", auth, async (req, res) => {
  try {
    const sub = req.body;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return res.status(400).json({ error: "Invalid push subscription." });
    await pool.query(`
      INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth)
      VALUES($1,$2,$3,$4)
      ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,updated_at=NOW()
    `, [req.session.userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not enable notifications." }); }
});

app.post("/api/push/unsubscribe", auth, async (req, res) => {
  try {
    const endpoint = req.body?.endpoint;
    if (endpoint) await pool.query("DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2", [endpoint, req.session.userId]);
    else await pool.query("DELETE FROM push_subscriptions WHERE user_id=$1", [req.session.userId]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not disable notifications." }); }
});

app.post("/api/push/test", auth, async (req, res) => {
  try {
    const result = await sendPushToUser(req.session.userId, { title: "DealFlow", body: "Notifications are working. You’ll get a reminder when follow-ups are due.", url: "/?view=today", tag: "dealflow-test" });
    if (result.disabled) return res.status(503).json({ error: "Push is not configured on the server yet." });
    if (!result.sent) return res.status(400).json({ error: "No active notification subscription found." });
    res.json({ ok: true, sent: result.sent });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not send test notification." }); }
});

app.post("/api/notifications/run", async (req, res) => {
  if (!NOTIFICATION_JOB_SECRET || req.get("x-dealflow-secret") !== NOTIFICATION_JOB_SECRET) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(await runDueNotifications(false)); }
  catch (e) { console.error(e); res.status(500).json({ error: "Notification job failed." }); }
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
      await pool.query("UPDATE customers SET status='Sold', sold_date=$1, next_follow_up=$2, archived=FALSE, archived_at=NULL, updated_at=NOW() WHERE id=$3 AND user_id=$4",
        [todayISO(), offsetISO(7), id, req.session.userId]);
      await logActivity(req.session.userId, id, "Marked sold · 7-day follow-up scheduled");
    } else if (action === "archive") {
      await pool.query("UPDATE customers SET archived=TRUE, archived_at=NOW(), next_follow_up=NULL, priority='', updated_at=NOW() WHERE id=$1 AND user_id=$2",
        [id, req.session.userId]);
      await logActivity(req.session.userId, id, "Archived · no longer shopping");
    } else if (action === "restore") {
      await pool.query("UPDATE customers SET archived=FALSE, archived_at=NULL, updated_at=NOW() WHERE id=$1 AND user_id=$2",
        [id, req.session.userId]);
      await logActivity(req.session.userId, id, "Restored to active customers");
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

app.delete("/api/customers/:id", auth, async (req, res) => {
  try {
    const id = req.params.id;
    const result = await pool.query(
      "DELETE FROM customers WHERE id=$1 AND user_id=$2 RETURNING id",
      [id, req.session.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not delete customer." });
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
  .then(() => app.listen(PORT, () => {
    console.log(`DealFlow running on port ${PORT}`);
    // Best-effort while the service is awake. The included GitHub Action wakes the free Render service reliably.
    setInterval(() => runDueNotifications(false).catch(err => console.error("Notification interval:", err.message)), 15 * 60 * 1000);
  }))
  .catch(err => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });
