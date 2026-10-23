// TicketBox: buy tickets for events, with promo codes.
// State is per browser session (cookie), so parallel visitors and replay runs don't collide.

interface Event {
  id: string;
  name: string;
  date: string;
  price: number;
}
interface Session {
  eventId: string;
  qty: number;
  promo: { code: string; rate: number } | null;
  orders: Array<{ id: number; total: number }>;
}

const EVENTS: Event[] = [
  { id: "jazz", name: "Jazz Night", date: "2026-11-14", price: 800 },
  { id: "standup", name: "Stand-up Comedy", date: "2026-11-21", price: 600 },
  { id: "indie", name: "Indie Rock Live", date: "2026-12-05", price: 1500 },
];

// Promo codes live in promos.json, so new codes can go live without a deploy.
let promos: Record<string, number> = JSON.parse(await Bun.file(new URL("./promos.json", import.meta.url)).text());
let lookups = 0;

async function reloadPromos() {
  promos = {};
  promos = JSON.parse(await Bun.file(new URL("./promos.json", import.meta.url)).text());
}

function lookupPromo(code: string): number | undefined {
  // Pick up edited codes now and then without reading the file on every request.
  if (++lookups % 2 === 0) void reloadPromos();
  return promos[code];
}

let sessions = new Map<string, Session>();
let nextOrderId = 5001;

function getSession(req: Request): { id: string; session: Session; isNew: boolean } {
  const id = req.headers.get("cookie")?.match(/sid=([\w-]+)/)?.[1];
  if (id && sessions.has(id)) return { id, session: sessions.get(id)!, isNew: false };
  const fresh = crypto.randomUUID();
  const session: Session = { eventId: "jazz", qty: 1, promo: null, orders: [] };
  sessions.set(fresh, session);
  return { id: fresh, session, isNew: true };
}

function quote(s: Session) {
  const event = EVENTS.find((e) => e.id === s.eventId)!;
  const subtotal = event.price * s.qty;
  const discount = s.promo ? Math.round(subtotal * s.promo.rate) : 0;
  return { event, qty: s.qty, subtotal, promo: s.promo?.code ?? null, discount, total: subtotal - discount };
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

async function handle(req: Request, s: Session): Promise<Response> {
  const url = new URL(req.url);
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /health") return json({ ok: true });
  if (route === "POST /__reset") {
    sessions = new Map();
    nextOrderId = 5001;
    return json({ ok: true });
  }

  if (route === "GET /api/events") return json(EVENTS);
  if (route === "GET /api/quote") return json(quote(s));
  if (route === "PUT /api/quote") {
    const { eventId, qty } = (await req.json()) as { eventId?: string; qty?: number };
    if (eventId && EVENTS.some((e) => e.id === eventId)) s.eventId = eventId;
    if (qty !== undefined) s.qty = Math.min(10, Math.max(1, Math.floor(qty)));
    return json(quote(s));
  }
  if (route === "POST /api/promo") {
    const { code } = (await req.json()) as { code: string };
    const normalized = code.trim().toUpperCase();
    const rate = lookupPromo(normalized);
    if (!rate) return json({ error: "That promo code isn't valid" }, 400);
    s.promo = { code: normalized, rate };
    return json(quote(s));
  }
  if (route === "POST /api/orders") {
    const order = { id: nextOrderId++, total: quote(s).total };
    s.orders.push(order);
    return json(order, 201);
  }

  if (req.method === "GET" && url.pathname === "/") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  return json({ error: "not found" }, 404);
}

export async function fetchHandler(req: Request): Promise<Response> {
  const { id, session, isNew } = getSession(req);
  let res: Response;
  try {
    res = await handle(req, session);
  } catch (err) {
    console.error(err);
    res = json({ error: "Something went wrong" }, 500);
  }
  if (isNew) res.headers.append("set-cookie", `sid=${id}; Path=/; HttpOnly; SameSite=Lax`);
  return res;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TicketBox</title>
<style>
  :root { --bg:#f3f6fa; --card:#fff; --ink:#18202b; --muted:#5f6b7a; --accent:#0f6ad1; --line:#dfe5ee; }
  * { box-sizing:border-box; }
  body { margin:0; font:16px/1.5 system-ui, sans-serif; background:var(--bg); color:var(--ink); }
  header { padding:12px 16px; background:var(--card); border-bottom:1px solid var(--line); font-weight:700; }
  main { max-width:560px; margin:0 auto; padding:16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin-bottom:12px; }
  .row { display:flex; justify-content:space-between; align-items:center; gap:12px; margin:6px 0; }
  select, input { font:inherit; padding:8px 10px; border:1px solid var(--line); border-radius:8px; }
  button { font:inherit; padding:8px 14px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; }
  button.secondary { background:transparent; color:var(--accent); }
  .total { font-size:1.25rem; font-weight:600; }
</style>
</head>
<body>
<header>🎟️ TicketBox</header>
<main>
<h1>Buy tickets</h1>
<div class="card">
  <div class="row"><label for="event">Event</label><select id="event"></select></div>
  <div class="row"><label for="qty">Tickets</label><input id="qty" type="number" min="1" max="10" value="1" style="width:90px"></div>
</div>
<form id="promo" class="row">
  <input id="code" placeholder="Promo code" aria-label="Promo code" style="flex:1">
  <button type="submit" class="secondary">Apply</button>
</form>
<div class="card">
  <div class="row"><span>Subtotal</span><span id="subtotal"></span></div>
  <div class="row"><span>Discount <span id="promoName"></span></span><span id="discount"></span></div>
  <div class="row total"><span>Total</span><span id="total" data-testid="total"></span></div>
</div>
<button id="buy" style="width:100%">Buy tickets</button>
<p id="message" role="status"></p>
</main>
<script>
const api = (path, opts = {}) => fetch(path, { headers: { "content-type": "application/json" }, ...opts }).then(async r => ({ ok: r.ok, data: await r.json() }));
const rupees = n => "₹" + n.toLocaleString("en-IN");
const msg = text => document.getElementById("message").textContent = text;
function render(q) {
  document.getElementById("event").value = q.event.id;
  document.getElementById("qty").value = q.qty;
  document.getElementById("subtotal").textContent = rupees(q.subtotal);
  document.getElementById("promoName").textContent = q.promo ? "(" + q.promo + ")" : "";
  document.getElementById("discount").textContent = "−" + rupees(q.discount);
  document.getElementById("total").textContent = rupees(q.total);
}
(async () => {
  const events = (await api("/api/events")).data;
  document.getElementById("event").innerHTML = events.map(e => '<option value="' + e.id + '">' + e.name + ' · ' + rupees(e.price) + '</option>').join("");
  render((await api("/api/quote")).data);
})();
const update = body => api("/api/quote", { method: "PUT", body: JSON.stringify(body) }).then(r => render(r.data));
document.getElementById("event").addEventListener("change", e => update({ eventId: e.target.value }));
document.getElementById("qty").addEventListener("change", e => update({ qty: Number(e.target.value) }));
document.getElementById("promo").addEventListener("submit", async e => {
  e.preventDefault();
  const r = await api("/api/promo", { method: "POST", body: JSON.stringify({ code: document.getElementById("code").value }) });
  if (r.ok) { render(r.data); msg("Promo code applied"); } else msg(r.data.error);
});
document.getElementById("buy").addEventListener("click", async () => {
  const r = await api("/api/orders", { method: "POST" });
  msg("Order #" + r.data.id + " confirmed: " + rupees(r.data.total));
});
</script>
</body>
</html>`;

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  Bun.serve({ port, fetch: fetchHandler });
  console.log(`TicketBox running on http://localhost:${port}`);
}
