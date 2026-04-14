const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const INVITE_CODE = process.env.INVITE_CODE;

async function kvGet(key) {
  const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  const data = await res.json();
  return data.result ? JSON.parse(data.result) : null;
}

async function kvSet(key, value, expirySeconds = null) {
  const url = expirySeconds
    ? `${KV_URL}/set/${encodeURIComponent(key)}?EX=${expirySeconds}`
    : `${KV_URL}/set/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  return res.json();
}

async function kvDel(key) {
  await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
}

function hashPassword(password) {
  let hash = 0;
  for (let i = 0; i < password.length; i++) {
    const char = password.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 48; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

async function validateSession(req) {
  const token = req.headers['x-session-token'];
  if (!token) return null;
  const session = await kvGet(`session:${token}`);
  return session || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: 'Storage not configured.' });

  const { action } = req.body;

  // --- PUBLIC ACTIONS (no session required) ---

  if (action === 'signup') {
    const { username, password, inviteCode } = req.body;
    if (!username || !password || !inviteCode) return res.status(400).json({ error: 'All fields are required.' });
    if (inviteCode !== INVITE_CODE) return res.status(401).json({ error: 'Invalid invite code.' });
    const trimmedUsername = username.trim().toLowerCase();
    if (trimmedUsername.length < 2) return res.status(400).json({ error: 'Username must be at least 2 characters.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    const existing = await kvGet(`user:${trimmedUsername}`);
    if (existing) return res.status(409).json({ error: 'Username already taken.' });
    await kvSet(`user:${trimmedUsername}`, {
      username: trimmedUsername,
      displayName: username.trim(),
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString()
    });
    // Auto-login after signup
    const token = generateToken();
    await kvSet(`session:${token}`, { username: trimmedUsername, displayName: username.trim() }, 2592000);
    return res.status(200).json({ success: true, displayName: username.trim(), sessionToken: token });
  }

  if (action === 'login') {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    const trimmedUsername = username.trim().toLowerCase();
    const user = await kvGet(`user:${trimmedUsername}`);
    if (!user || user.passwordHash !== hashPassword(password)) {
      return res.status(401).json({ error: 'Incorrect username or password.' });
    }
    const token = generateToken();
    await kvSet(`session:${token}`, { username: trimmedUsername, displayName: user.displayName }, 2592000);
    return res.status(200).json({ success: true, displayName: user.displayName, sessionToken: token });
  }

  // --- PROTECTED ACTIONS (valid session required) ---

  const session = await validateSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated. Please log in.' });

  if (action === 'logout') {
    const token = req.headers['x-session-token'];
    await kvDel(`session:${token}`);
    return res.status(200).json({ success: true });
  }

  if (action === 'getHistory') {
    const hist = await kvGet('invoice_history') || [];
    return res.status(200).json({ history: hist });
  }

  if (action === 'addHistory') {
    const { entry } = req.body;
    if (!entry) return res.status(400).json({ error: 'Missing entry.' });
    const hist = await kvGet('invoice_history') || [];
    hist.push(entry);
    if (hist.length > 100) hist.splice(0, hist.length - 100);
    await kvSet('invoice_history', hist);
    return res.status(200).json({ success: true, history: hist });
  }

  if (action === 'voidHistory') {
    const { invoiceNumber } = req.body;
    const hist = await kvGet('invoice_history') || [];
    const idx = hist.findIndex(h => h.invoiceNumber === invoiceNumber);
    if (idx !== -1) { hist[idx].voided = true; hist[idx].voidedAt = new Date().toISOString(); await kvSet('invoice_history', hist); }
    return res.status(200).json({ success: true, history: hist });
  }

  if (action === 'approveHistory') {
    const { invoiceNumber } = req.body;
    const hist = await kvGet('invoice_history') || [];
    const idx = hist.findIndex(h => h.invoiceNumber === invoiceNumber);
    if (idx !== -1) { hist[idx].approved = true; hist[idx].approvedAt = new Date().toISOString(); await kvSet('invoice_history', hist); }
    return res.status(200).json({ success: true, history: hist });
  }

  if (action === 'deleteHistory') {
    const { invoiceNumber } = req.body;
    const hist = await kvGet('invoice_history') || [];
    await kvSet('invoice_history', hist.filter(h => h.invoiceNumber !== invoiceNumber));
    return res.status(200).json({ success: true, history: hist.filter(h => h.invoiceNumber !== invoiceNumber) });
  }

  if (action === 'markPaidHistory') {
    const { invoiceNumber, paymentDate } = req.body;
    const hist = await kvGet('invoice_history') || [];
    const idx = hist.findIndex(h => h.invoiceNumber === invoiceNumber);
    if (idx !== -1) { hist[idx].paid = true; hist[idx].paidAt = paymentDate; await kvSet('invoice_history', hist); }
    return res.status(200).json({ success: true, history: hist });
  }

  return res.status(400).json({ error: 'Unknown action.' });
}