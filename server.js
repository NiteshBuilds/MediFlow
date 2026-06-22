const express    = require('express');
const mongoose   = require('mongoose');
const http       = require('http');
const { Server } = require('socket.io');
const session    = require('express-session');
const MongoStore = require('connect-mongo').default;
const bcrypt     = require('bcrypt');
const https = require('https');

// EmailJS — all credentials stored as environment variables
function sendEmailJS(toEmail, passcode) {
  return new Promise((resolve, reject) => {
    const now = new Date();
    const time = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const payload = JSON.stringify({
      service_id:  process.env.EMAILJS_SERVICE_ID,
      template_id: process.env.EMAILJS_TEMPLATE_ID,
      user_id:     process.env.EMAILJS_PUBLIC_KEY,
      accessToken: process.env.EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email: toEmail,
        passcode: passcode,
        time:     time
      }
    });
    const options = {
      hostname: 'api.emailjs.com',
      path:     '/api/v1.0/email/send',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve();
        else reject(new Error(`EmailJS error ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Suspension email (uses EMAILJS_SUSPEND_TEMPLATE_ID) ────
// Failsafe: if env var missing, log a warning and return without
// throwing — suspension must still succeed in the database.
async function sendSuspensionEmailJS({ ownerName, ownerEmail, pharmacyName, suspensionReason, date }) {
  const templateId = process.env.EMAILJS_SUSPEND_TEMPLATE_ID;
  if (!templateId) {
    console.warn('[SUSPEND_EMAIL] EMAILJS_SUSPEND_TEMPLATE_ID not set — skipping email. Suspension still recorded.');
    return { skipped: true };
  }
  const payload = JSON.stringify({
    service_id:  process.env.EMAILJS_SERVICE_ID,
    template_id: templateId,
    user_id:     process.env.EMAILJS_PUBLIC_KEY,
    accessToken: process.env.EMAILJS_PRIVATE_KEY,
    template_params: {
      ownerName:        ownerName        || '',
      ownerEmail:       ownerEmail       || '',
      pharmacyName:     pharmacyName     || '',
      suspensionReason: suspensionReason || '',
      date:             date             || ''
    }
  });
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.emailjs.com',
      path:     '/api/v1.0/email/send',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve({ sent: true });
        else reject(new Error(`EmailJS suspend error ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const app = express();

// Required for Render (and any reverse proxy): tells Express to trust
// the X-Forwarded-Proto header so it knows the connection is HTTPS,
// which makes secure cookies work correctly.
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Defensive global error logging ─────────────────────────
// connect-mongo occasionally throws asynchronous "Unable to find
// the session to touch" errors from its store worker. They are
// NOT fatal — they don't affect request handling — but if they
// bubble up as unhandled rejections they can crash the Node
// process and hang the Admin dashboard. We log them clearly so
// Railway shows a readable line, but the server keeps running.
process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  // Session-store retries are noisy but harmless — log concisely.
  if (/session to touch|connect-mongo/i.test(msg)) {
    console.warn(`[SESSION_STORE] Non-fatal session-store issue: ${msg}`);
  } else {
    console.error(`[UNHANDLED_REJECTION] ${msg}`);
  }
});
process.on('uncaughtException', (err) => {
  console.error(`[UNCAUGHT_EXCEPTION] ${err && err.message ? err.message : err}`);
});

const server = http.createServer(app);
const io = new Server(server);

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,

  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    ttl: 14 * 24 * 60 * 60
  }),

  cookie: {
    maxAge: 1000 * 60 * 60 * 8,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
  }
}));

// ── Public-path guard ──────────────────────────────────────
// Only login/register pages are accessible without a session.
// Every API call from a logged-in user carries req.session.userId
// which is the pharmacy owner's _id — used as the ownerId fence
// on every DB query throughout the file.
const PUBLIC_PATHS = ['/login.html', '/register.html', '/login', '/register', 
  '/forgot-password.html', '/forgot-password', '/verify-otp', '/reset-password',
  '/admin.html', '/admin/login', '/admin/logout'];
app.use((req, res, next) => {
  const isPublic   = PUBLIC_PATHS.some(p => req.path === p || req.path.startsWith(p));
  const isAsset    = req.path.match(/\.(css|js|png|jpg|ico|woff|woff2)$/);
  // A request is considered "authorized" if EITHER a pharmacy
  // owner session exists (userId) OR the admin is logged in
  // (adminLoggedIn). Without this fix the public-path guard
  // would 401 every /admin/* API call as "Not logged in" even
  // after a successful /admin/login, because the admin never
  // gets a userId on the session.
  const isLoggedIn = !!req.session.userId || !!req.session.adminLoggedIn;
  if (isLoggedIn || isPublic || isAsset) return next();
  if (req.path === '/' || req.path.endsWith('.html')) return res.redirect('/login.html');
  return res.status(401).json({ error: 'Not logged in.' });
});

app.use(express.static('Public'));

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

app.get('/health', (req, res) => res.json({ status: 'ok' }));



// ── OTP Schema ────────────────────────────────────────────
// Stores one-time recovery codes. Auto-deletes after 15 minutes.
const otpSchema = new mongoose.Schema({
  email:     { type: String, required: true, lowercase: true },
  code:      { type: String, required: true },   // 6-digit code
  purpose:   { type: String, enum: ['password_reset', 'profile_edit'], default: 'password_reset' },
  expiresAt: { type: Date,   required: true },
  used:      { type: Boolean, default: false },
});
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // auto-delete after expiry
const OTP = mongoose.model('OTP', otpSchema);


// ══════════════════════════════════════════════════════════
// SCHEMAS
// ══════════════════════════════════════════════════════════

// ── User / Pharmacy account ────────────────────────────────
// One document = one pharmacy workspace (owner account).
// Staff members (future) will reference this _id as pharmacyId.
const userSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  email:       { type: String, required: true, unique: true, lowercase: true },
  password:    { type: String, required: true },

  // Role: 'owner' can manage staff & subscription.
  //       'staff' has read/write access to medicines & billing.
  //       Extend permissions checks in middleware when needed.
  role:        { type: String, enum: ['owner', 'staff'], default: 'owner' },

  // Staff members belong to a pharmacy owner.
  // For owner accounts this is null.
  // For staff accounts this is the owner's _id.
  pharmacyId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // ── Pharmacy Profile ─────────────────────────────────────
  // Collected at registration, printed on every receipt.
  pharmacyName:    { type: String, default: '' },
  pharmacyPhone:   { type: String, default: '' },
  pharmacyAddress: { type: String, default: '' },
  pharmacyEmail:   { type: String, default: '' },
  pharmacyLicense: { type: String, default: '' },

  // ── Subscription ─────────────────────────────────────────
  subscriptionEnd: { type: Date, default: null },

  // ── Suspension (admin-controlled) ────────────────────────
  // When isSuspended is true, the pharmacy owner and all their
  // staff are blocked from logging in and from every protected
  // API endpoint (enforced in requireOwner + /login).
  // Data is never deleted on suspension — medicines, batches,
  // bills, history, and staff are fully preserved.
  isSuspended:     { type: Boolean, default: false, index: true },
  suspensionReason:{ type: String,  default: '' },
  suspendedAt:     { type: Date,    default: null },
  suspendedBy:     { type: String,  default: '' },   // admin email who suspended

}, { timestamps: true });

const User = mongoose.model('User', userSchema);


// ── Batch sub-schema ───────────────────────────────────────
// Lives inside a Medicine document. No ownerId needed here —
// the parent Medicine already scopes it.
const batchSchema = new mongoose.Schema({
  batchLabel:   { type: String },           // "Batch A", "Batch B" — auto-assigned
  stock:        { type: Number, required: true, min: 0 },
  expiryDate:   { type: Date,   required: true },
  addedAt:      { type: Date,   default: Date.now },
  costPrice:    { type: Number, default: 0 },   // purchase price for this batch
  sellingPrice: { type: Number, default: 0 },   // selling price for this batch
}, { _id: true });


// ── Medicine ───────────────────────────────────────────────
// MULTI-TENANT KEY: ownerId links this document to one pharmacy.
// Every query MUST include { ownerId: req.session.userId } so
// Pharmacy A can never read or write Pharmacy B's medicines.
const medicineSchema = new mongoose.Schema({
  // 🔑 Tenant fence — always filter by this
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  name:      { type: String, required: true },
  barcode:   { type: String, required: true },
  price:     { type: Number, required: true },
  costPrice: { type: Number, default: 0 },
  alertsEnabled: { type: Boolean, default: true },
  stockAlertsEnabled: { type: Boolean, default: true },
  batches: { type: [batchSchema], default: [] },
}, { timestamps: true });

// Virtual: total stock across all batches
medicineSchema.virtual('stock').get(function () {
  return this.batches.reduce((sum, b) => sum + b.stock, 0);
});
medicineSchema.set('toJSON',   { virtuals: true });
medicineSchema.set('toObject', { virtuals: true });

// ── IMPORTANT: barcode must be unique *per pharmacy*, not globally.
// We drop the old global unique index on barcode and instead make
// the combination of (ownerId + barcode) unique.
medicineSchema.index({ ownerId: 1, barcode: 1 }, { unique: true, background: true });
medicineSchema.index({ ownerId: 1, name:    1 }, { background: true });

// Text search is per-pharmacy — compound text index includes ownerId
// so MongoDB can filter by tenant before doing the text scan.
medicineSchema.index({ ownerId: 1, name: 'text', barcode: 'text' }, { background: true });

const Medicine = mongoose.model('Medicine', medicineSchema);


// ── Activity Log ───────────────────────────────────────────
// Also tenant-scoped so the activity log page only shows events
// belonging to the logged-in pharmacy.
const logSchema = new mongoose.Schema({
  // 🔑 Tenant fence
  ownerId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  medicineName: String,
  barcode:      String,
  action:       String,   // e.g. "Batch B promoted to Batch A automatically"
  createdAt:    { type: Date, default: Date.now },
});
const Log = mongoose.model('Log', logSchema);


// ── Stock History (sold & restocked) ─────────────────────
const stockHistorySchema = new mongoose.Schema({
  ownerId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type:         { type: String, enum: ['sold', 'restocked'], required: true, index: true },
  // billId groups all line items from one billing session together
  // so history can reconstruct the full receipt for a multi-item bill
  billId:       { type: String, index: true },
  patientName:  String,
  patientAge:   Number,
  patientPhone: String,
  medicineName: String,
  barcode:      String,
  quantity:     { type: Number, required: true },
  unitPrice:    Number,   // sold only
  lineTotal:    Number,   // sold only
  expiryDate:   Date,     // restocked only
  createdAt:    { type: Date, default: Date.now },
});
stockHistorySchema.index({ ownerId: 1, type: 1, createdAt: -1 });
stockHistorySchema.index({ ownerId: 1, billId: 1 });
const StockHistory = mongoose.model('StockHistory', stockHistorySchema);


// ══════════════════════════════════════════════════════════
// MIDDLEWARE HELPER: requireOwner
// Attaches req.ownerId from the session.
// Also resolves staff accounts: a staff member's ownerId is
// their pharmacyId (the owner they belong to).
// All data queries should use req.ownerId — never req.session.userId
// directly — so staff see the same pharmacy data as the owner.
// ══════════════════════════════════════════════════════════
async function requireOwner(req, res, next) {
  try {
    if (!req.session.userId)
      return res.status(401).json({ error: 'Not logged in.' });

    const user = await User.findById(req.session.userId).lean();
    if (!user) return res.status(401).json({ error: 'User not found.' });

    if (user.role === 'staff' && user.pharmacyId) {
      // Staff member — scope to their owner's pharmacy
      req.ownerId   = user.pharmacyId;
      req.userRole  = 'staff';
    } else {
      // Owner account — scope to themselves
      req.ownerId   = user._id;
      req.userRole  = 'owner';
    }

    // ── Suspension guard ───────────────────────────────────
    // If the OWNER account is suspended, block ALL access for
    // both the owner and their staff. Suspended data is never
    // returned; the same 403 + reason is used for every route.
    if (req.userRole === 'owner' && user.isSuspended) {
      return res.status(403).json({
        error:           'Account suspended.',
        suspended:       true,
        reason:          user.suspensionReason || 'Access to MediFlow services is currently restricted.',
        suspendedAt:     user.suspendedAt || null,
      });
    }
    if (req.userRole === 'staff' && user.pharmacyId) {
      // Look up owner once to check suspension status
      const owner = await User.findById(user.pharmacyId).select('isSuspended suspensionReason').lean();
      if (owner && owner.isSuspended) {
        return res.status(403).json({
          error:           'Account suspended.',
          suspended:       true,
          reason:          owner.suspensionReason || 'Access to MediFlow services is currently restricted.',
          suspendedAt:     null,
        });
      }
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}


// ══════════════════════════════════════════════════════════
// HELPERS: assignBatchLabels & doAutoShift
// (unchanged in logic — ownerId is already on the medicine doc)
// ══════════════════════════════════════════════════════════
function assignBatchLabels(medicine, batches) {
  const sorted = [...batches].sort((a, b) => new Date(a.expiryDate) - new Date(b.expiryDate));

  const shiftLogs = {};
  sorted.forEach(b => { if (b.batchLabel) shiftLogs[b._id.toString()] = b.batchLabel; });

  const nonEmpty = sorted.filter(b => b.stock > 0);
  const letters  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const logs     = [];

  nonEmpty.forEach((b, i) => {
    const newLabel = `Batch ${letters[i]}`;
    const oldLabel = shiftLogs[b._id.toString()];
    if (oldLabel && oldLabel !== newLabel)
      logs.push(`${oldLabel} promoted to ${newLabel} automatically`);
    b.batchLabel = newLabel;
  });

  return { updatedBatches: nonEmpty, shiftLogs: logs };
}

async function doAutoShift(medicine) {
  const { updatedBatches, shiftLogs } = assignBatchLabels(medicine, medicine.batches);
  medicine.batches = updatedBatches;
  await medicine.save();

  if (shiftLogs.length > 0) {
    const logDocs = shiftLogs.map(action => ({
      ownerId:      medicine.ownerId,   // 🔑 always carry ownerId into logs
      medicineName: medicine.name,
      barcode:      medicine.barcode,
      action,
    }));
    await Log.insertMany(logDocs);
    console.log(`🔄 Auto-shift [${medicine.ownerId}] ${medicine.name}:`, shiftLogs);
  }

  return shiftLogs;
}


// ══════════════════════════════════════════════════════════
// AUTH ROUTES
// (No ownerId needed here — these create/validate the session)
// ══════════════════════════════════════════════════════════

// POST /register
// Creates an owner account. Subscription starts as null (no active plan).
app.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'All fields are required.' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing)
      return res.status(409).json({ error: 'An account with this email already exists.' });

    const { pharmacyName, pharmacyPhone, pharmacyAddress, pharmacyEmail, pharmacyLicense } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const user = new User({
      name, email, password: hashed, role: 'owner',
      pharmacyName:    pharmacyName    || '',
      pharmacyPhone:   pharmacyPhone   || '',
      pharmacyAddress: pharmacyAddress || '',
      pharmacyEmail:   pharmacyEmail   || '',
      pharmacyLicense: pharmacyLicense || '',
    });
    await user.save();

    req.session.userId   = user._id;
    req.session.userName = user.name;
    res.status(201).json({ success: true, name: user.name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /login
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required.' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'No account found with this email. Please register first.' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Incorrect password. Please try again.' });

    // ── Suspension guard (login) ───────────────────────────
    // For owners, check the owner's own status. For staff,
    // check the pharmacy owner's status — a staff member of a
    // suspended pharmacy must also be blocked.
    if (user.role === 'owner' && user.isSuspended) {
      return res.status(403).json({
        error:           'Account suspended.',
        suspended:       true,
        reason:          user.suspensionReason || 'Access to MediFlow services is currently restricted.',
        suspendedAt:     user.suspendedAt || null,
      });
    }
    if (user.role === 'staff' && user.pharmacyId) {
      const owner = await User.findById(user.pharmacyId).select('isSuspended suspensionReason').lean();
      if (owner && owner.isSuspended) {
        return res.status(403).json({
          error:           'Account suspended.',
          suspended:       true,
          reason:          owner.suspensionReason || 'Access to MediFlow services is currently restricted.',
          suspendedAt:     null,
        });
      }
    }

    req.session.userId   = user._id;
    req.session.userName = user.name;
    res.json({ success: true, name: user.name, role: user.role });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /logout
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// GET /profile — returns pharmacy profile for receipt printing
app.get('/profile', requireOwner, async (req, res) => {
  try {
    const [owner, currentUser] = await Promise.all([
      User.findById(req.ownerId)
        .select('pharmacyName pharmacyPhone pharmacyAddress pharmacyEmail pharmacyLicense')
        .lean(),
      User.findById(req.session.userId)
        .select('name email role')
        .lean(),
    ]);
    if (!owner) return res.status(404).json({ error: 'Profile not found.' });
    if (!currentUser) return res.status(404).json({ error: 'User not found.' });

    res.json({
      name: currentUser.name,
      email: currentUser.email,
      role: currentUser.role,
      pharmacyName: owner.pharmacyName || '',
      pharmacyPhone: owner.pharmacyPhone || '',
      pharmacyAddress: owner.pharmacyAddress || '',
      pharmacyEmail: owner.pharmacyEmail || '',
      pharmacyLicense: owner.pharmacyLicense || '',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /profile/request-edit-code — send OTP for profile edits
app.post('/profile/request-edit-code', requireOwner, async (req, res) => {
  try {
    if (req.userRole !== 'owner')
      return res.status(403).json({ error: 'Only the pharmacy owner can edit profile details.' });

    const user = await User.findById(req.session.userId).select('name email').lean();
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await OTP.deleteMany({ email: user.email.toLowerCase(), purpose: 'profile_edit' });
    await OTP.create({ email: user.email.toLowerCase(), code, purpose: 'profile_edit', expiresAt });

  try {
    console.log(`[PROFILE_OTP] Sending code to ${user.email}`);
    await sendEmailJS(user.email, code);

    console.log('[PROFILE_OTP] OTP sent successfully');

    return res.json({
      success: true,
      message: 'Verification code sent'
    });

  } catch(err) {

    console.error('[PROFILE_OTP] Send failed:', err);

    return res.status(500).json({
      success: false,
      message: 'Failed to send verification code'
    });
  }

    console.log(`[PROFILE_OTP] Sent successfully to ${user.email}`);
    res.json({ success: true, message: 'Verification code sent to your email.' });
  } catch (err) {
    console.error('[PROFILE_OTP] Send failed:', err);
    res.status(500).json({ error: `Failed to send verification code: ${err.message}` });
  }
});

function isProfileEditUnlocked(req) {
  return req.session.profileEditVerifiedFor === String(req.session.userId)
    && req.session.profileEditVerifiedUntil
    && Date.now() < req.session.profileEditVerifiedUntil;
}

// GET /profile/edit-status — whether profile editing is unlocked in this session
app.get('/profile/edit-status', requireOwner, (req, res) => {
  res.json({ unlocked: isProfileEditUnlocked(req) });
});

// POST /profile/verify-edit-code — verify OTP and unlock updates for short duration
app.post('/profile/verify-edit-code', requireOwner, async (req, res) => {
  try {
    if (req.userRole !== 'owner')
      return res.status(403).json({ error: 'Only the pharmacy owner can edit profile details.' });

    const code = String(req.body.code || '').replace(/\D/g, '');
    if (code.length !== 6) return res.status(400).json({ error: 'Enter the 6-digit verification code.' });

    const user = await User.findById(req.session.userId).select('email').lean();
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const otp = await OTP.findOne({
      email: user.email.toLowerCase(),
      code,
      purpose: 'profile_edit',
      used: false,
      expiresAt: { $gt: new Date() },
    });
    if (!otp) return res.status(400).json({ error: 'Invalid or expired code. Request a new code.' });

    // Do not mark OTP used here — only after a successful save (so retry works if save fails)
    req.session.profileEditVerifiedUntil = Date.now() + 10 * 60 * 1000; // 10 minutes
    req.session.profileEditVerifiedFor   = String(req.session.userId);

    req.session.save((err) => {
      if (err) {
        console.error('[PROFILE_OTP] Session save failed:', err);
        return res.status(500).json({ error: 'Verification succeeded but session could not be saved. Try again.' });
      }
      res.json({ success: true, unlocked: true, message: 'Verification successful. You can now edit profile details.' });
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /profile — update account + pharmacy profile details (OTP required)
app.put('/profile', requireOwner, async (req, res) => {
  try {
    if (req.userRole !== 'owner')
      return res.status(403).json({ error: 'Only the pharmacy owner can update the profile.' });

    if (!isProfileEditUnlocked(req))
      return res.status(403).json({ error: 'Please verify your email code before editing details.' });

    const { name, email, currentPassword, newPassword, pharmacyName, pharmacyPhone, pharmacyAddress, pharmacyEmail, pharmacyLicense } = req.body;
    const [owner, user] = await Promise.all([
      User.findById(req.ownerId),
      User.findById(req.session.userId)
    ]);

    if (!owner) return res.status(404).json({ error: 'Profile not found.' });
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (name && name.trim()) user.name = name.trim();
    if (email && email.trim().toLowerCase() !== user.email) {
      const exists = await User.findOne({ email: email.trim().toLowerCase() });
      if (exists) return res.status(409).json({ error: 'That email is already used by another account.' });
      user.email = email.trim().toLowerCase();
    }
    if (newPassword) {
      if (!currentPassword)
        return res.status(400).json({ error: 'Please enter your current password to set a new one.' });
      const match = await bcrypt.compare(currentPassword, user.password);
      if (!match)
        return res.status(401).json({ error: 'Current password is incorrect.' });
      if (newPassword.length < 6)
        return res.status(400).json({ error: 'New password must be at least 6 characters.' });
      user.password = await bcrypt.hash(newPassword, 10);
    }

    if (pharmacyName    !== undefined) owner.pharmacyName    = pharmacyName;
    if (pharmacyPhone   !== undefined) owner.pharmacyPhone   = pharmacyPhone;
    if (pharmacyAddress !== undefined) owner.pharmacyAddress = pharmacyAddress;
    if (pharmacyEmail   !== undefined) owner.pharmacyEmail   = pharmacyEmail;
    if (pharmacyLicense !== undefined) owner.pharmacyLicense = pharmacyLicense;

    await Promise.all([owner.save(), user.save()]);
    await OTP.updateMany(
      { email: user.email.toLowerCase(), purpose: 'profile_edit', used: false },
      { $set: { used: true } }
    );

    req.session.userName = user.name;
    req.session.profileEditVerifiedUntil = null;
    req.session.profileEditVerifiedFor = null;

    req.session.save((err) => {
      if (err) return res.status(500).json({ error: 'Saved, but session update failed. Refresh the page.' });
      res.json({ success: true, name: user.name, email: user.email });
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /me — returns session info + subscription + suspension status
// Modified for active-session suspension: also returns `suspended`
// and `suspensionReason` from the SAME field already used by
// /login + requireOwner middleware. The frontend polls this
// every 30s (via mediflow-brand.js watcher) to detect when an
// admin suspends an already-logged-in pharmacy.
app.get('/me', async (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  try {
    const user = await User.findById(req.session.userId).lean();
    if (!user) return res.json({ loggedIn: false });

    // Resolve which pharmacy this user belongs to
    const ownerId = (user.role === 'staff' && user.pharmacyId)
      ? user.pharmacyId
      : user._id;

    // If staff, read subscription + suspension from the owner account
    const ownerDoc = (user.role === 'staff')
      ? await User.findById(ownerId).lean()
      : user;

    const now = new Date();
    const subscriptionActive = ownerDoc.subscriptionEnd
      ? new Date(ownerDoc.subscriptionEnd) > now
      : false;

    // ── Suspension status (admin-controlled) ─────────────
    // Same field as /login + requireOwner (user.suspensionReason).
    // Admin accounts are not stored in this User model — they use
    // a separate session key (req.session.adminLoggedIn) and
    // never hit this code path on a real session.
    const isSuspended = !!(ownerDoc && ownerDoc.isSuspended);
    const suspensionReason = (ownerDoc && ownerDoc.suspensionReason)
      || 'Access to MediFlow services is currently restricted.';

    res.json({
      loggedIn:           true,
      name:               user.name,
      email:              user.email,
      role:               user.role,
      ownerId:            ownerId,
      subscriptionEnd:    ownerDoc.subscriptionEnd || null,
      subscriptionActive,
      suspended:          isSuspended,
      suspensionReason:   isSuspended ? suspensionReason : '',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ══════════════════════════════════════════════════════════
// FORGOT PASSWORD ROUTES
// ══════════════════════════════════════════════════════════

// POST /forgot-password
// Sends a 6-digit OTP to the user's registered email.
app.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const user = await User.findOne({ email: email.toLowerCase() });
    // Always return success even if not found — prevents email enumeration
    if (!user) {
      return res.json({ success: true, message: 'If this email is registered, a code has been sent.' });
    }

    // Generate 6-digit OTP
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Delete any existing OTPs for this email first
    await OTP.deleteMany({ email: email.toLowerCase() });

    // Save new OTP
    await OTP.create({ email: email.toLowerCase(), code, purpose: 'password_reset', expiresAt });

    // Send email
    await sendEmailJS(user.email, code);

    res.json({ success: true, message: 'Recovery code sent to your email.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to send email. Please check your email configuration in server.js.' });
  }
});

// POST /verify-otp
// Verifies the OTP without resetting password yet — just confirms code is valid.
app.post('/verify-otp', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code are required.' });

    const otp = await OTP.findOne({
      email: email.toLowerCase(),
      code:  code.trim(),
      purpose: 'password_reset',
      used:  false,
      expiresAt: { $gt: new Date() }
    });

    if (!otp) return res.status(400).json({ error: 'Invalid or expired code. Please request a new one.' });

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /reset-password
// Verifies OTP one final time and sets the new password.
app.post('/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword)
      return res.status(400).json({ error: 'All fields are required.' });
    if (newPassword.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const otp = await OTP.findOne({
      email: email.toLowerCase(),
      code:  code.trim(),
      purpose: 'password_reset',
      used:  false,
      expiresAt: { $gt: new Date() }
    });

    if (!otp) return res.status(400).json({ error: 'Invalid or expired code. Please start again.' });

    // Mark OTP as used
    otp.used = true;
    await otp.save();

    // Update password
    const hashed = await bcrypt.hash(newPassword, 10);
    await User.updateOne({ email: email.toLowerCase() }, { password: hashed });

    res.json({ success: true, message: 'Password updated successfully. You can now log in.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════
// STAFF MANAGEMENT ROUTES (owner only)
// Architecture is ready; implement full UI when needed.
// ══════════════════════════════════════════════════════════

// POST /staff/add
// Owner invites a staff member to their pharmacy workspace.
// Body: { name, email, password }
app.post('/staff/add', requireOwner, async (req, res) => {
  try {
    if (req.userRole !== 'owner')
      return res.status(403).json({ error: 'Only the pharmacy owner can add staff.' });

    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email and password are required.' });

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing)
      return res.status(409).json({ error: 'An account with this email already exists.' });

    const hashed = await bcrypt.hash(password, 10);
    const staff  = new User({
      name,
      email,
      password: hashed,
      role:        'staff',
      pharmacyId:  req.ownerId,   // link to owner's pharmacy
    });
    await staff.save();
    res.status(201).json({ success: true, staffId: staff._id, name: staff.name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /staff
// Returns all staff members in this pharmacy.
app.get('/staff', requireOwner, async (req, res) => {
  try {
    if (req.userRole !== 'owner')
      return res.status(403).json({ error: 'Only the pharmacy owner can view staff.' });

    const staffList = await User.find({ pharmacyId: req.ownerId, role: 'staff' })
      .select('name email createdAt')
      .lean();
    res.json(staffList);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /staff/:staffId
// Owner removes a staff member.
app.delete('/staff/:staffId', requireOwner, async (req, res) => {
  try {
    if (req.userRole !== 'owner')
      return res.status(403).json({ error: 'Only the pharmacy owner can remove staff.' });

    // Verify the staff member actually belongs to this pharmacy
    const staff = await User.findOne({ _id: req.params.staffId, pharmacyId: req.ownerId });
    if (!staff) return res.status(404).json({ error: 'Staff member not found.' });

    await staff.deleteOne();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ══════════════════════════════════════════════════════════
// SUBSCRIPTION ROUTES (owner only)
// Call these from your payment webhook to activate/extend plans.
// ══════════════════════════════════════════════════════════

// POST /subscription/activate
// Body: { daysToAdd }  — add N days from today (or from current end if still active)
app.post('/subscription/activate', requireOwner, async (req, res) => {
  try {
    if (req.userRole !== 'owner')
      return res.status(403).json({ error: 'Only the pharmacy owner can manage subscription.' });

    const days = parseInt(req.body.daysToAdd, 10) || 30;
    const owner = await User.findById(req.ownerId);

    const base = (owner.subscriptionEnd && new Date(owner.subscriptionEnd) > new Date())
      ? new Date(owner.subscriptionEnd)   // extend existing active plan
      : new Date();                        // start fresh from today

    base.setDate(base.getDate() + days);
    owner.subscriptionEnd = base;
    await owner.save();

    res.json({ success: true, subscriptionEnd: owner.subscriptionEnd });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /subscription/status
app.get('/subscription/status', requireOwner, async (req, res) => {
  try {
    const owner = await User.findById(req.ownerId).lean();
    const now   = new Date();
    res.json({
      subscriptionEnd:    owner.subscriptionEnd || null,
      subscriptionActive: owner.subscriptionEnd ? new Date(owner.subscriptionEnd) > now : false,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ══════════════════════════════════════════════════════════
// MEDICINE APIs
// Every route uses requireOwner middleware so req.ownerId is
// always set. Every DB query includes { ownerId: req.ownerId }
// as a filter — this is the multi-tenancy fence.
// ══════════════════════════════════════════════════════════

// POST /add-medicine
// Body: { name, barcode, price, stock, expiryDate, alertsEnabled }
app.post('/add-medicine', requireOwner, async (req, res) => {
  try {
    const { name, barcode, price, costPrice, stock, expiryDate, alertsEnabled, stockAlertsEnabled } = req.body;
    if (!name || !barcode || !expiryDate)
      return res.status(400).json({ error: 'Name, barcode and expiry date are required.' });

    const initialBatch = {
      batchLabel: 'Batch A',
      stock:      Number(stock) || 0,
      expiryDate: new Date(expiryDate),
    };

    const med   = new Medicine({
      ownerId: req.ownerId,   // 🔑 set tenant
      name, barcode,
      price:     Number(price),
      costPrice: Number(costPrice) || 0,
      alertsEnabled: alertsEnabled !== false,
      stockAlertsEnabled: stockAlertsEnabled !== false,
      batches: [initialBatch],
    });
    const saved = await med.save();
    res.status(201).json(saved.toJSON());
  } catch (err) {
    if (err.code === 11000)
      return res.status(409).json({ error: 'A medicine with this barcode already exists in your pharmacy.' });
    res.status(500).json({ error: err.message });
  }
});

// GET /medicines — returns only this pharmacy's medicines
app.get('/medicines', requireOwner, async (req, res) => {
  try {
    const meds = await Medicine
      .find({ ownerId: req.ownerId })   // 🔑 tenant filter
      .sort({ name: 1 })
      .select('-__v');
    res.json(meds.map(m => m.toJSON()));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /medicine/:barcode
app.get('/medicine/:barcode', requireOwner, async (req, res) => {
  try {
    const med = await Medicine
      .findOne({ ownerId: req.ownerId, barcode: req.params.barcode })  // 🔑
      .select('-__v');
    if (!med) return res.status(404).json({ error: 'Medicine not found.' });
    res.json(med.toJSON());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /medicine-search?q=
app.get('/medicine-search', requireOwner, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);

    // Full-text search scoped to this pharmacy
    const results = await Medicine.find(
      { ownerId: req.ownerId, $text: { $search: q } },   // 🔑
      { score: { $meta: 'textScore' } }
    ).sort({ score: { $meta: 'textScore' } }).limit(10).select('-__v');

    if (results.length) return res.json(results.map(m => m.toJSON()));

    // Regex fallback — also scoped
    const fallback = await Medicine.find({
      ownerId: req.ownerId,   // 🔑
      $or: [
        { name:    { $regex: q, $options: 'i' } },
        { barcode: { $regex: q, $options: 'i' } },
      ]
    }).limit(10).select('-__v');
    res.json(fallback.map(m => m.toJSON()));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /restock
// Body: { barcode, quantity, expiryDate, costPrice?, sellingPrice? }
app.post('/restock', requireOwner, async (req, res) => {
  try {
    const { barcode, quantity, expiryDate, costPrice, sellingPrice } = req.body;
    if (!barcode || !quantity || !expiryDate)
      return res.status(400).json({ error: 'Barcode, quantity and expiry date are required.' });

    const qty = parseInt(quantity, 10);
    if (isNaN(qty) || qty <= 0)
      return res.status(400).json({ error: 'Quantity must be a positive number.' });

    // 🔑 Tenant-scoped lookup
    const med = await Medicine.findOne({ ownerId: req.ownerId, barcode });
    if (!med) return res.status(404).json({ error: 'No medicine found with that barcode.' });

    const newExpiry = new Date(expiryDate);
    const existingBatch = med.batches.find(b =>
      new Date(b.expiryDate).toDateString() === newExpiry.toDateString()
    );

    // Resolve batch-level prices:
    // If caller sends explicit prices, use them.
    // Otherwise copy from the most recently added batch (latest addedAt).
    let batchCostPrice    = 0;
    let batchSellingPrice = 0;
    if (costPrice !== undefined && sellingPrice !== undefined) {
      batchCostPrice    = Number(costPrice)    || 0;
      batchSellingPrice = Number(sellingPrice) || 0;
    } else if (med.batches.length > 0) {
      // Copy from most recently added batch
      const latest = med.batches.slice().sort((a, b) =>
        new Date(b.addedAt || 0) - new Date(a.addedAt || 0)
      )[0];
      batchCostPrice    = latest.costPrice    || med.costPrice || 0;
      batchSellingPrice = latest.sellingPrice || med.price     || 0;
    } else {
      batchCostPrice    = med.costPrice || 0;
      batchSellingPrice = med.price     || 0;
    }

    if (existingBatch) {
      existingBatch.stock += qty;
      // Only update prices on existing batch if caller explicitly sent new ones
      if (costPrice !== undefined)    existingBatch.costPrice    = batchCostPrice;
      if (sellingPrice !== undefined) existingBatch.sellingPrice = batchSellingPrice;
    } else {
      med.batches.push({
        stock:        qty,
        expiryDate:   newExpiry,
        costPrice:    batchCostPrice,
        sellingPrice: batchSellingPrice,
      });
    }

    await doAutoShift(med);

    try {
      await StockHistory.create({
        ownerId:      req.ownerId,
        type:         'restocked',
        medicineName: med.name,
        barcode:      med.barcode,
        quantity:     qty,
        expiryDate:   newExpiry,
      });
      console.log(`📦 Restock history saved: ${med.name} +${qty} units [owner: ${req.ownerId}]`);
    } catch (histErr) {
      console.error('⚠️  StockHistory.create failed (restock):', histErr.message);
    }

    res.json({ success: true, medicine: med.toJSON() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /bill
// Body: { items: [ { barcode, qty }, ... ] }
app.post('/bill', requireOwner, async (req, res) => {
  try {
    const { items, patientName, patientAge, patientPhone, billId } = req.body;
    // billId comes from the client — generated once per print session
    // so all line items share the same ID and can be grouped in history
    const resolvedBillId = billId || new mongoose.Types.ObjectId().toString();
    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: 'No items provided.' });

    // First pass: validate stock — all scoped to this pharmacy 🔑
    for (const item of items) {
      const med = await Medicine.findOne({ ownerId: req.ownerId, barcode: item.barcode });
      if (!med)
        return res.status(404).json({ error: `Medicine not found: ${item.barcode}` });
      
      let available = 0;
      if (item.batchLabel && item.batchLabel !== 'auto') {
        const batch = med.batches.find(b => b.batchLabel === item.batchLabel);
        if (!batch) return res.status(404).json({ error: `Batch ${item.batchLabel} not found for ${med.name}.` });
        available = batch.stock;
      } else {
        available = med.batches.reduce((s, b) => s + b.stock, 0);
      }
      
      if (available < item.qty)
        return res.status(409).json({
          error: `Not enough stock for "${med.name}"${item.batchLabel && item.batchLabel !== 'auto' ? ` in ${item.batchLabel}` : ''}. Only ${available} available.`,
          barcode: med.barcode,
          available: available,
        });
    }

    // Second pass: deduct (FEFO — Batch A = earliest expiry first) & log sales
    const soldEntries = [];
    for (const item of items) {
      const med = await Medicine.findOne({ ownerId: req.ownerId, barcode: item.barcode }); // 🔑
      let remaining = item.qty;
      let billedBatch = null; // track which batch was billed for price lookup

      if (item.batchLabel && item.batchLabel !== 'auto') {
        const batch = med.batches.find(b => b.batchLabel === item.batchLabel);
        if (batch) {
          billedBatch = batch;
          const deduct = Math.min(batch.stock, remaining);
          batch.stock -= deduct;
          remaining -= deduct;
        }
      } else {
        const sorted  = med.batches.sort((a, b) => new Date(a.expiryDate) - new Date(b.expiryDate));
        for (const batch of sorted) {
          if (remaining <= 0) break;
          if (!billedBatch) billedBatch = batch; // first (FEFO) batch is the price source
          const deduct = Math.min(batch.stock, remaining);
          batch.stock  -= deduct;
          remaining    -= deduct;
        }
      }
      await doAutoShift(med);

      // Use the billed batch's sellingPrice; fall back to med.price for old records
      const unitPrice = Number(
        billedBatch?.sellingPrice != null && billedBatch.sellingPrice > 0
          ? billedBatch.sellingPrice
          : (item.sellingPrice ?? med.price ?? 0)
      );

      soldEntries.push({
        ownerId:      req.ownerId,
        type:         'sold',
        billId:       resolvedBillId,
        patientName:  patientName || '',
        patientAge:   patientAge || null,
        patientPhone: patientPhone || '',
        medicineName: med.name,
        barcode:      med.barcode,
        quantity:     item.qty,
        unitPrice:    unitPrice,
        lineTotal:    unitPrice * item.qty,
      });
    }
    try {
      if (soldEntries.length) await StockHistory.insertMany(soldEntries);
    } catch (histErr) {
      console.warn('Stock history log failed (bill still OK):', histErr.message);
    }

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /stock-history — sold & restocked events for this pharmacy
// Sold items are returned as grouped bills (by billId) so the
// history page can reconstruct a full multi-item receipt.
app.get('/stock-history', requireOwner, async (req, res) => {
  try {
    const limit = 500;
    const [soldRaw, restocked] = await Promise.all([
      StockHistory.find({ ownerId: req.ownerId, type: 'sold' })
        .sort({ createdAt: -1 }).limit(limit).lean(),
      StockHistory.find({ ownerId: req.ownerId, type: 'restocked' })
        .sort({ createdAt: -1 }).limit(limit).lean(),
    ]);

    // Group sold items by billId into bills array
    // Each bill = { billId, patientName, patientAge, patientPhone, createdAt, items[], grandTotal }
    const billMap = new Map();
    for (const row of soldRaw) {
      const key = row.billId || row._id.toString(); // fallback for old rows without billId
      if (!billMap.has(key)) {
        billMap.set(key, {
          billId:       key,
          patientName:  row.patientName  || '',
          patientAge:   row.patientAge   || null,
          patientPhone: row.patientPhone || '',
          createdAt:    row.createdAt,
          items:        [],
          grandTotal:   0,
        });
      }
      const bill = billMap.get(key);
      bill.items.push({
        _id:          row._id,
        medicineName: row.medicineName,
        barcode:      row.barcode,
        quantity:     row.quantity,
        unitPrice:    row.unitPrice,
        lineTotal:    row.lineTotal,
      });
      bill.grandTotal += (row.lineTotal || 0);
    }

    // Convert map to array, sorted newest first
    const bills = [...billMap.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ bills, sold: soldRaw, restocked });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET activity-logs.html — scoped to this pharmacy
app.get('activity-logs.html', requireOwner, async (req, res) => {
  try {
    const logs = await Log
      .find({ ownerId: req.ownerId })   // 🔑
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json(logs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /medicine-batches/:barcode — scoped to this pharmacy
app.get('/medicine-batches/:barcode', requireOwner, async (req, res) => {
  try {
    const med = await Medicine
      .findOne({ ownerId: req.ownerId, barcode: req.params.barcode })  // 🔑
      .select('-__v');
    if (!med) return res.status(404).json({ error: 'Medicine not found.' });
    res.json({ name: med.name, barcode: med.barcode, price: med.price, batches: med.batches });
  } catch (err) { res.status(500).json({ error: err.message }); }
});



// ── DELETE /medicine-batch/:barcode/:batchId ─────────────
// Deletes ONE batch from a medicine. If after deletion the
// medicine has zero batches left, the parent medicine document
// is automatically removed (auto-cleanup so no empty shells
// linger in the database). The existing
// `DELETE /medicine/:barcode` route is untouched and still
// removes the entire medicine in one shot.
app.delete('/medicine-batch/:barcode/:batchId', requireOwner, async (req, res) => {
  try {
    const { barcode, batchId } = req.params;

    // 🔑 Tenant-scoped lookup
    const med = await Medicine.findOne({ ownerId: req.ownerId, barcode });
    if (!med) return res.status(404).json({ error: 'Medicine not found.' });

    const before = med.batches.length;
    const target = med.batches.find(b => b._id.toString() === batchId);
    if (!target) return res.status(404).json({ error: 'Batch not found.' });

    const removedLabel = target.batchLabel || 'Unlabelled';
    const removedStock = target.stock;

    // Remove the specific batch by _id
    med.batches = med.batches.filter(b => b._id.toString() !== batchId);

    // If no batches remain, KEEP the medicine record (stock virtual
    // naturally becomes 0 since it sums over an empty batches array).
    // This lets the medicine still show up in Out of Stock counts/alerts
    // and remain searchable/restockable without recreating it.
    if (med.batches.length === 0) {
      await med.save();
      await Log.create({
        ownerId:      req.ownerId,
        medicineName: med.name,
        barcode:      med.barcode,
        action:       `Batch ${removedLabel} deleted — no batches remaining, medicine is now Out of Stock.`,
      });
      console.log(`🗑️  Batch ${removedLabel} deleted from [${req.ownerId}] ${med.name}; medicine kept with stock=0 (Out of Stock).`);
      return res.json({
        success: true,
        medicineRemoved: false,
        outOfStock: true,
        removedBatch: { label: removedLabel, stock: removedStock },
        remainingBatches: 0,
        message: `Batch ${removedLabel} deleted. "${med.name}" has no remaining batches and is now Out of Stock.`,
      });
    }

    await doAutoShift(med);   // re-label remaining batches A, B, C… (FEFO preserved)
    res.json({
      success: true,
      medicineRemoved: false,
      removedBatch: { label: removedLabel, stock: removedStock },
      remainingBatches: med.batches.length,
      message: `Batch ${removedLabel} deleted.`,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════
// EXPIRED MEDICINES — Dashboard
// Server-side count + list of batches whose expiryDate has
// passed and which still hold stock. Uses MongoDB aggregation
// so we only ship the rows we actually need to the client.
// ══════════════════════════════════════════════════════════

// GET /api/dashboard/expired-count
// Returns just the integer count for the Dashboard stat card.
// Cheap to call repeatedly (refresh button, etc).
app.get('/api/dashboard/expired-count', requireOwner, async (req, res) => {
  try {
    const now = new Date();
    const result = await Medicine.aggregate([
      { $match: { ownerId: req.ownerId } },                  // 🔑 tenant fence
      { $unwind: '$batches' },
      { $match: { 'batches.stock': { $gt: 0 }, 'batches.expiryDate': { $lt: now } } },
      { $count: 'expired' },
    ]);
    const count = result.length ? result[0].expired : 0;
    res.json({ count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/expired-medicines
// Returns the full list of expired batches for the
// Expired Medicines page. Sorted "most recently expired first"
// = oldest expiryDate first (longest ago). Capped at 500 to
// keep the payload bounded.
app.get('/api/expired-medicines', requireOwner, async (req, res) => {
  try {
    const now = new Date();
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 1000);

    const rows = await Medicine.aggregate([
      { $match: { ownerId: req.ownerId } },                  // 🔑 tenant fence
      { $unwind: '$batches' },
      { $match: { 'batches.stock': { $gt: 0 }, 'batches.expiryDate': { $lt: now } } },
      {
        $project: {
          _id:           0,
          name:          1,
          barcode:       1,
          batchLabel:    '$batches.batchLabel',
          stock:         '$batches.stock',
          expiryDate:    '$batches.expiryDate',
        },
      },
      { $sort: { expiryDate: 1 } },    // oldest expiry first = longest expired = "most recently expired"
      { $limit: limit },
    ]);

    // Pre-compute daysSinceExpiry on the server so the client
    // doesn't have to repeat the math on every render.
    const items = rows.map(r => {
      const exp = new Date(r.expiryDate);
      const msPerDay = 86400000;
      // Use floor of whole calendar days — "24 days ago" style
      const daysSinceExpiry = Math.floor((now - exp) / msPerDay);
      return {
        name:           r.name,
        barcode:        r.barcode,
        batchLabel:     r.batchLabel || 'Unlabelled',
        stock:          r.stock,
        expiryDate:     r.expiryDate,
        daysSinceExpiry,
      };
    });

    res.json({ count: items.length, items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════
// DASHBOARD DETAIL VIEWS — Low Stock / Expiring Soon / Out of Stock
// Same aggregation style as /api/expired-medicines above.
// Total Medicines uses the existing GET /medicines route directly
// (no new route needed — it already returns everything required).
// ══════════════════════════════════════════════════════════

// GET /api/low-stock-medicines
// Medicines with total stock > 0 and < 5 units (matches the
// dashboard stat-card definition exactly: stock>0 && stock<5
// && stockAlertsEnabled!==false). Sorted lowest stock first.
app.get('/api/low-stock-medicines', requireOwner, async (req, res) => {
  try {
    const meds = await Medicine.find({ ownerId: req.ownerId }).select('-__v');
    const items = meds
      .map(m => m.toJSON())
      .filter(m => m.stock > 0 && m.stock < 5 && m.stockAlertsEnabled !== false)
      .map(m => ({
        name:          m.name,
        barcode:       m.barcode,
        stock:         m.stock,
        batchCount:    (m.batches || []).filter(b => b.stock > 0).length,
        price:         m.price,
      }))
      .sort((a, b) => a.stock - b.stock);
    res.json({ count: items.length, items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/expiring-soon-medicines
// Batches (not whole medicines) expiring within 90 days, still
// holding stock. Mirrors the dashboard's per-medicine "Expiring
// Soon" definition but expanded to batch level for the detail view.
// Sorted nearest expiry first.
app.get('/api/expiring-soon-medicines', requireOwner, async (req, res) => {
  try {
    const now = new Date();
    const horizon = new Date(now.getTime() + 90 * 86400000);
    const rows = await Medicine.aggregate([
      { $match: { ownerId: req.ownerId } },                  // 🔑 tenant fence
      { $unwind: '$batches' },
      { $match: {
          'batches.stock':      { $gt: 0 },
          'batches.expiryDate': { $gte: now, $lte: horizon },
      }},
      {
        $project: {
          _id:        0,
          name:       1,
          barcode:    1,
          batchLabel: '$batches.batchLabel',
          stock:      '$batches.stock',
          expiryDate: '$batches.expiryDate',
        },
      },
      { $sort: { expiryDate: 1 } },   // nearest expiry first
    ]);

    const items = rows.map(r => {
      const exp = new Date(r.expiryDate);
      const daysRemaining = Math.ceil((exp - now) / 86400000);
      return {
        name:           r.name,
        barcode:        r.barcode,
        batchLabel:     r.batchLabel || 'Unlabelled',
        stock:          r.stock,
        expiryDate:     r.expiryDate,
        daysRemaining,
      };
    });

    res.json({ count: items.length, items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/out-of-stock-medicines
// Medicines with total stock === 0 (no active batches remaining).
// Sorted alphabetically.
app.get('/api/out-of-stock-medicines', requireOwner, async (req, res) => {
  try {
    const meds = await Medicine.find({ ownerId: req.ownerId }).select('-__v');
    const items = meds
      .map(m => m.toJSON())
      .filter(m => m.stock === 0)
      .map(m => ({
        name:    m.name,
        barcode: m.barcode,
        status:  'Out of Stock',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ count: items.length, items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// Permanently delete a medicine from this pharmacy's inventory
app.delete('/medicine/:barcode', requireOwner, async (req, res) => {
  try {
    const result = await Medicine.findOneAndDelete({
      ownerId: req.ownerId,       // 🔑 tenant fence — can only delete own medicines
      barcode: req.params.barcode
    });
    if (!result) return res.status(404).json({ error: 'Medicine not found.' });
    res.json({ success: true, name: result.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
// SOCKET.IO
// Barcode scanner broadcasts are tenant-scoped by joining a
// room named after the ownerId so scanners in Pharmacy A
// don't trigger billing screens in Pharmacy B.
// ══════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  // Client must emit joinPharmacy with their ownerId right after connecting
  socket.on('joinPharmacy', (ownerId) => {
    socket.join(`pharmacy:${ownerId}`);
    console.log(`📋 Socket ${socket.id} joined room pharmacy:${ownerId}`);
  });

  socket.on('barcode', ({ ownerId, barcode }) => {
    console.log(`📦 Barcode [${ownerId}]: ${barcode}`);
    // Only broadcast to sockets in the same pharmacy room
    io.to(`pharmacy:${ownerId}`).emit('barcode', barcode);
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});


// ══════════════════════════════════════════════════════════
//  ADMIN ROUTES — protected by ADMIN_EMAIL + ADMIN_PASSWORD
//  env vars. Completely separate from pharmacy session.
//  Nothing below touches any pharmacy data or existing routes.
// ══════════════════════════════════════════════════════════

// Admin auth middleware
function requireAdmin(req, res, next) {
  if (req.session.adminLoggedIn) return next();
  return res.status(401).json({ error: 'Admin not logged in.' });
}

// POST /admin/login
app.post('/admin/login', (req, res) => {
  const { email, password } = req.body;
  const ADMIN_EMAIL    = process.env.ADMIN_EMAIL;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD)
    return res.status(500).json({ error: 'Admin credentials not configured.' });
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    req.session.adminLoggedIn = true;
    return res.json({ success: true });
  }
  return res.status(401).json({ error: 'Invalid admin credentials.' });
});

// POST /admin/logout
app.post('/admin/logout', (req, res) => {
  req.session.adminLoggedIn = false;
  res.json({ success: true });
});

// GET /admin/stats — overview numbers
app.get('/admin/stats', requireAdmin, async (req, res) => {
  const startedAt = Date.now();
  try {
    const [totalPharmacies, totalMedicines, totalBills, totalRestocks] = await Promise.all([
      User.countDocuments({ role: 'owner' }),
      Medicine.countDocuments(),
      StockHistory.countDocuments({ type: 'sold' }),
      StockHistory.countDocuments({ type: 'restocked' }),
    ]);
    console.log(`[ADMIN_STATS] pharmacies=${totalPharmacies} medicines=${totalMedicines} bills=${totalBills} restocks=${totalRestocks} in ${Date.now() - startedAt}ms`);
    res.json({ totalPharmacies, totalMedicines, totalBills, totalRestocks });
  } catch (err) {
    console.error(`[ADMIN_STATS] Failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/pharmacies — full list of all registered pharmacies
// Robustness: each owner is enriched in an isolated try/catch. If
// ONE pharmacy record is malformed (or its related queries throw),
// that single record is skipped with a console warning and the
// Admin dashboard still loads the remaining pharmacies. The
// endpoint never hangs the front-end spinner on a single bad row.
app.get('/admin/pharmacies', requireAdmin, async (req, res) => {
  const startedAt = Date.now();
  try {
    const owners = await User.find({ role: 'owner' })
      .select('name email pharmacyName pharmacyPhone pharmacyAddress pharmacyEmail pharmacyLicense subscriptionEnd isSuspended suspensionReason suspendedAt suspendedBy createdAt')
      .sort({ createdAt: -1 })
      .lean();

    // For each owner, attach activity stats. Per-owner isolation
    // means a single broken record can't take down the whole list.
    const enriched = [];
    for (const owner of owners) {
      try {
        const ownerId = owner._id;
        const [medicineCount, billCount, restockCount, lastBill, lastRestock, staffCount] = await Promise.all([
          Medicine.countDocuments({ ownerId }),
          StockHistory.countDocuments({ ownerId, type: 'sold' }),
          StockHistory.countDocuments({ ownerId, type: 'restocked' }),
          StockHistory.findOne({ ownerId, type: 'sold' }).sort({ createdAt: -1 }).select('createdAt').lean(),
          StockHistory.findOne({ ownerId, type: 'restocked' }).sort({ createdAt: -1 }).select('createdAt').lean(),
          User.countDocuments({ role: 'staff', pharmacyId: ownerId }),
        ]);
        enriched.push({
          _id:             ownerId,
          name:            owner.name,
          email:           owner.email,
          pharmacyName:    owner.pharmacyName    || '—',
          pharmacyPhone:   owner.pharmacyPhone   || '—',
          pharmacyAddress: owner.pharmacyAddress || '—',
          pharmacyEmail:   owner.pharmacyEmail   || '—',
          pharmacyLicense: owner.pharmacyLicense || '—',
          subscriptionEnd: owner.subscriptionEnd || null,
          registeredAt:    owner.createdAt,
          medicineCount,
          billCount,
          restockCount,
          staffCount,
          lastBillAt:      lastBill    ? lastBill.createdAt    : null,
          lastRestockAt:   lastRestock ? lastRestock.createdAt : null,
          lastActiveAt:    lastBill && lastRestock
            ? (new Date(lastBill.createdAt) > new Date(lastRestock.createdAt) ? lastBill.createdAt : lastRestock.createdAt)
            : (lastBill?.createdAt || lastRestock?.createdAt || null),
          // Suspension fields (so Admin dashboard can show the badge
          // + reason + date without an extra round trip)
          isSuspended:     !!owner.isSuspended,
          suspensionReason:owner.suspensionReason || '',
          suspendedAt:     owner.suspendedAt      || null,
          suspendedBy:     owner.suspendedBy      || '',
        });
      } catch (perPharmacyErr) {
        // One bad record must not poison the whole response. Log
        // clearly and skip it — the Admin still sees every other
        // pharmacy. (suspended + active are both handled the same way)
        console.error(`[ADMIN_PHARMACIES] Skipped pharmacy ${owner._id} (${owner.pharmacyName || owner.name || owner.email}) during enrichment: ${perPharmacyErr.message}`);
        // Still push a minimal record so the admin can see it exists
        // and can debug / delete it from the dashboard if needed.
        enriched.push({
          _id:             owner._id,
          name:            owner.name    || '—',
          email:           owner.email   || '—',
          pharmacyName:    owner.pharmacyName    || '—',
          pharmacyPhone:   owner.pharmacyPhone   || '—',
          pharmacyAddress: owner.pharmacyAddress || '—',
          pharmacyEmail:   owner.pharmacyEmail   || '—',
          pharmacyLicense: owner.pharmacyLicense || '—',
          subscriptionEnd: owner.subscriptionEnd || null,
          registeredAt:    owner.createdAt,
          medicineCount:   0,
          billCount:       0,
          restockCount:    0,
          staffCount:      0,
          lastBillAt:      null,
          lastRestockAt:   null,
          lastActiveAt:    null,
          isSuspended:     !!owner.isSuspended,
          suspensionReason:owner.suspensionReason || '',
          suspendedAt:     owner.suspendedAt      || null,
          suspendedBy:     owner.suspendedBy      || '',
          _loadWarning:    'Stats unavailable for this pharmacy. Other pharmacies loaded normally.',
        });
      }
    }

    console.log(`[ADMIN_PHARMACIES] Served ${enriched.length}/${owners.length} pharmacies in ${Date.now() - startedAt}ms`);
    res.json(enriched);
  } catch (err) {
    console.error(`[ADMIN_PHARMACIES] Fatal error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/pharmacy/:id/bills — recent bills for one pharmacy
app.get('/admin/pharmacy/:id/bills', requireAdmin, async (req, res) => {
  try {
    const ownerId = req.params.id;
    const soldRaw = await StockHistory.find({ ownerId, type: 'sold' })
      .sort({ createdAt: -1 }).limit(100).lean();
    const billMap = new Map();
    for (const row of soldRaw) {
      const key = row.billId || row._id.toString();
      if (!billMap.has(key)) {
        billMap.set(key, {
          billId: key, patientName: row.patientName || '',
          createdAt: row.createdAt, items: [], grandTotal: 0,
        });
      }
      const bill = billMap.get(key);
      bill.items.push({ medicineName: row.medicineName, quantity: row.quantity, unitPrice: row.unitPrice, lineTotal: row.lineTotal });
      bill.grandTotal += (row.lineTotal || 0);
    }
    res.json([...billMap.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /admin/pharmacy/:id/medicines — paginated medicine inventory for one pharmacy
app.get('/admin/pharmacy/:id/medicines', requireAdmin, async (req, res) => {
  try {
    const ownerId = req.params.id;
    const page    = Math.max(1, parseInt(req.query.page) || 1);
    const limit   = 20;
    const skip    = (page - 1) * limit;
    const q       = (req.query.q || '').trim();

    const filter = { ownerId };
    if (q) {
      filter.$or = [
        { name:    { $regex: q, $options: 'i' } },
        { barcode: { $regex: q, $options: 'i' } },
      ];
    }

    const [medicines, total] = await Promise.all([
      Medicine.find(filter).sort({ name: 1 }).skip(skip).limit(limit).select('-__v'),
      Medicine.countDocuments(filter),
    ]);

    const today = new Date();
    const in90  = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000);

    // Summary counts (always unfiltered for the whole pharmacy)
    const allMeds = await Medicine.find({ ownerId }).select('batches');
    let totalMeds = allMeds.length, lowStock = 0, outOfStock = 0, expiringSoon = 0;
    for (const m of allMeds) {
      const stock = m.batches.reduce((s, b) => s + b.stock, 0);
      if (stock === 0) outOfStock++;
      else if (stock < 10) lowStock++;
      const hasExpiring = m.batches.some(b => new Date(b.expiryDate) <= in90 && new Date(b.expiryDate) >= today);
      if (hasExpiring) expiringSoon++;
    }

    res.json({
      medicines: medicines.map(m => m.toJSON()),
      total,
      page,
      pages: Math.ceil(total / limit),
      summary: { totalMeds, lowStock, outOfStock, expiringSoon },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════
// SUSPEND / UNSUSPEND PHARMACY (admin only)
// Marks an account as suspended; preserves ALL data
// (medicines, batches, bills, history, staff, inventory).
// Reactivation clears the flag — no manual DB changes needed.
// EmailJS is fired with EMAILJS_SUSPEND_TEMPLATE_ID; if that
// env var is missing the email is skipped (warning logged)
// but the suspension itself still succeeds.
// ══════════════════════════════════════════════════════════

const VALID_SUSPENSION_REASONS = [
  'Account Verification Required',
  'Policy Violation',
  'Subscription / Payment Issue',
  'Suspicious Activity Detected',
  'Temporary Administrative Review',
];

// POST /admin/pharmacy/:id/suspend
// Body: { reason }  — must be one of VALID_SUSPENSION_REASONS
app.post('/admin/pharmacy/:id/suspend', requireAdmin, async (req, res) => {
  try {
    const ownerId = req.params.id;
    const reason  = String(req.body.reason || '').trim();

    if (!VALID_SUSPENSION_REASONS.includes(reason))
      return res.status(400).json({ error: 'Invalid suspension reason.' });

    const owner = await User.findOne({ _id: ownerId, role: 'owner' });
    if (!owner) return res.status(404).json({ error: 'Pharmacy not found.' });

    // Idempotent: re-suspending an already-suspended account just
    // refreshes the reason + timestamp. Prevents accidental error
    // on a double-click.
    const now    = new Date();
    const wasSuspended = !!owner.isSuspended;
    owner.isSuspended      = true;
    owner.suspensionReason = reason;
    owner.suspendedAt      = now;
    owner.suspendedBy      = process.env.ADMIN_EMAIL || 'admin';
    await owner.save();

    // Fire-and-await the suspension email. If EMAILJS_SUSPEND_TEMPLATE_ID
    // is missing, the helper resolves with { skipped: true } and we
    // do NOT fail the request — the suspension is already persisted.
    let emailResult = { skipped: true };
    try {
      emailResult = await sendSuspensionEmailJS({
        ownerName:        owner.name,
        ownerEmail:       owner.email,
        pharmacyName:     owner.pharmacyName || owner.name,
        suspensionReason: reason,
        date:             now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
      });
    } catch (emailErr) {
      // Log but don't roll back the suspension.
      console.error('[SUSPEND_EMAIL] Failed to send:', emailErr.message);
    }

    console.log(`⏸️  Admin ${owner.suspendedBy} suspended pharmacy: ${owner.pharmacyName || owner.name} (${ownerId}) — reason: "${reason}" ${wasSuspended ? '[re-suspend]' : ''}`);

    res.json({
      success:         true,
      alreadySuspended:wasSuspended,
      pharmacy: {
        _id:              owner._id,
        isSuspended:      true,
        suspensionReason: owner.suspensionReason,
        suspendedAt:      owner.suspendedAt,
        suspendedBy:      owner.suspendedBy,
      },
      email: emailResult,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /admin/pharmacy/:id/unsuspend
// Body: none. Reactivates the account — no data loss.
app.post('/admin/pharmacy/:id/unsuspend', requireAdmin, async (req, res) => {
  try {
    const ownerId = req.params.id;
    const owner = await User.findOne({ _id: ownerId, role: 'owner' });
    if (!owner) return res.status(404).json({ error: 'Pharmacy not found.' });

    if (!owner.isSuspended)
      return res.json({ success: true, alreadyActive: true, message: 'Pharmacy is already active.' });

    const wasReason  = owner.suspensionReason;
    owner.isSuspended      = false;
    owner.suspensionReason = '';
    owner.suspendedAt      = null;
    owner.suspendedBy      = '';
    await owner.save();

    console.log(`▶️  Admin unsuspended pharmacy: ${owner.pharmacyName || owner.name} (${ownerId}) — was reason: "${wasReason}"`);

    res.json({
      success: true,
      pharmacy: {
        _id:              owner._id,
        isSuspended:      false,
        suspensionReason: '',
        suspendedAt:      null,
        suspendedBy:      '',
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /admin/pharmacy/:id — cascade delete entire pharmacy
app.delete('/admin/pharmacy/:id', requireAdmin, async (req, res) => {
  try {
    const ownerId = req.params.id;

    // Verify pharmacy exists
    const owner = await User.findOne({ _id: ownerId, role: 'owner' }).lean();
    if (!owner) return res.status(404).json({ error: 'Pharmacy not found.' });

    // Cascade delete — all collections scoped to this ownerId
    await Promise.all([
      Medicine.deleteMany({ ownerId }),
      StockHistory.deleteMany({ ownerId }),
      Log.deleteMany({ ownerId }),
      User.deleteMany({ pharmacyId: ownerId }), // staff accounts
      OTP.deleteMany({ email: owner.email }),
    ]);

    // Delete the owner account last
    await User.findByIdAndDelete(ownerId);

    console.log(`🗑️  Admin deleted pharmacy: ${owner.pharmacyName || owner.name} (${ownerId})`);
    res.json({ success: true, deleted: owner.pharmacyName || owner.name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// Keep awake on platforms like Railway that may sleep 
const APP_URL = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || null;

if (APP_URL) {
  setInterval(() => {
    https.get(APP_URL, (res) => {
      console.log(`🏓 Keep-alive ping: ${res.statusCode}`);
    }).on('error', () => {});
  }, 14 * 60 * 1000);
}

server.listen(PORT, () => {
  console.log(`🚀 MediFlow running on port ${PORT}`);
});
