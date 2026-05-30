const express    = require('express');
const mongoose   = require('mongoose');
const http       = require('http');
const { Server } = require('socket.io');
const session    = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt     = require('bcrypt');
const nodemailer = require('nodemailer');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const io = new Server(server);

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,

  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI
  }),

  cookie: {
    maxAge: 1000 * 60 * 60 * 8,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
  }
}));

// ── Public-path guard ──────────────────────────────────────
// Only login/register pages are accessible without a session.
// Every API call from a logged-in user carries req.session.userId
// which is the pharmacy owner's _id — used as the ownerId fence
// on every DB query throughout the file.
const PUBLIC_PATHS = ['/login.html', '/register.html', '/login', '/register', 
  '/forgot-password.html', '/forgot-password', '/verify-otp', '/reset-password'];
app.use((req, res, next) => {
  const isPublic   = PUBLIC_PATHS.some(p => req.path === p || req.path.startsWith(p));
  const isAsset    = req.path.match(/\.(css|js|png|jpg|ico|woff|woff2)$/);
  const isLoggedIn = !!req.session.userId;
  if (isLoggedIn || isPublic || isAsset) return next();
  if (req.path === '/' || req.path.endsWith('.html')) return res.redirect('/login.html');
  return res.status(401).json({ error: 'Not logged in.' });
});

app.use(express.static('Public'));

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ── Email transporter (Gmail) ──────────────────────────────
// Replace these with your Gmail address and App Password.
// To get App Password: Google Account → Security → 2-Step Verification → App Passwords
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
  user: process.env.EMAIL_USER,
  pass: process.env.EMAIL_PASS
}
});

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

}, { timestamps: true });

const User = mongoose.model('User', userSchema);


// ── Batch sub-schema ───────────────────────────────────────
// Lives inside a Medicine document. No ownerId needed here —
// the parent Medicine already scopes it.
const batchSchema = new mongoose.Schema({
  batchLabel: { type: String },           // "Batch A", "Batch B" — auto-assigned
  stock:      { type: Number, required: true, min: 0 },
  expiryDate: { type: Date,   required: true },
  addedAt:    { type: Date,   default: Date.now },
}, { _id: true });


// ── Medicine ───────────────────────────────────────────────
// MULTI-TENANT KEY: ownerId links this document to one pharmacy.
// Every query MUST include { ownerId: req.session.userId } so
// Pharmacy A can never read or write Pharmacy B's medicines.
const medicineSchema = new mongoose.Schema({
  // 🔑 Tenant fence — always filter by this
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  name:    { type: String, required: true },
  barcode: { type: String, required: true },
  price:   { type: Number, required: true },
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

    console.log(`[PROFILE_OTP] Sending code to ${user.email}`);
    await transporter.sendMail({
      from: '"MediFlow" <mediflow.pharmacy@gmail.com>',
      to: user.email,
      subject: 'MediFlow — Profile Edit Verification Code',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:2rem;border:1px solid #e0f4f4;border-radius:12px">
          <h2 style="color:#0d6b6e;margin-bottom:.5rem">🔐 Profile Update Verification</h2>
          <p style="color:#3a5a5c;margin-bottom:1.5rem">Hi ${user.name}, use this code to unlock profile editing in MediFlow:</p>
          <div style="background:#f0f4f5;border:2px dashed #0d6b6e;border-radius:10px;padding:1.5rem;text-align:center;margin-bottom:1.5rem">
            <span style="font-size:2.5rem;font-weight:800;letter-spacing:.4rem;color:#0d6b6e">${code}</span>
          </div>
          <p style="color:#7a9ea0;font-size:.85rem">This code expires in <strong>10 minutes</strong>. If you did not request this, ignore this email.</p>
        </div>
      `
    });

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

// GET /me — returns session info + subscription status
app.get('/me', async (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  try {
    const user = await User.findById(req.session.userId).lean();
    if (!user) return res.json({ loggedIn: false });

    // Resolve which pharmacy this user belongs to
    const ownerId = (user.role === 'staff' && user.pharmacyId)
      ? user.pharmacyId
      : user._id;

    // If staff, read subscription from the owner account
    const ownerDoc = (user.role === 'staff')
      ? await User.findById(ownerId).lean()
      : user;

    const now = new Date();
    const subscriptionActive = ownerDoc.subscriptionEnd
      ? new Date(ownerDoc.subscriptionEnd) > now
      : false;

    res.json({
      loggedIn:           true,
      name:               user.name,
      email:              user.email,
      role:               user.role,
      ownerId:            ownerId,
      subscriptionEnd:    ownerDoc.subscriptionEnd || null,
      subscriptionActive,
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
    await transporter.sendMail({
      from: '"MediFlow" <mediflow.pharmacy@gmail.com>',   // ← replace with your Gmail
      to: user.email,
      subject: 'MediFlow — Password Recovery Code',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:2rem;border:1px solid #e0f4f4;border-radius:12px">
          <h2 style="color:#0d6b6e;margin-bottom:.5rem">🔐 Password Recovery</h2>
          <p style="color:#3a5a5c;margin-bottom:1.5rem">Hi ${user.name}, here is your MediFlow recovery code:</p>
          <div style="background:#f0f4f5;border:2px dashed #0d6b6e;border-radius:10px;padding:1.5rem;text-align:center;margin-bottom:1.5rem">
            <span style="font-size:2.5rem;font-weight:800;letter-spacing:.4rem;color:#0d6b6e">${code}</span>
          </div>
          <p style="color:#7a9ea0;font-size:.85rem">This code expires in <strong>15 minutes</strong>. Do not share it with anyone.</p>
          <p style="color:#7a9ea0;font-size:.85rem;margin-top:1rem">If you did not request this, you can safely ignore this email.</p>
          <hr style="border:none;border-top:1px solid #e0f4f4;margin:1.5rem 0"/>
          <p style="color:#b0c8ca;font-size:.75rem;text-align:center">Simplified With MediFlow</p>
        </div>
      `
    });

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
// Body: { name, barcode, price, stock, expiryDate }
app.post('/add-medicine', requireOwner, async (req, res) => {
  try {
    const { name, barcode, price, stock, expiryDate } = req.body;
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
      price:   Number(price),
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
// Body: { barcode, quantity, expiryDate }
app.post('/restock', requireOwner, async (req, res) => {
  try {
    const { barcode, quantity, expiryDate } = req.body;
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

    if (existingBatch) {
      existingBatch.stock += qty;
    } else {
      med.batches.push({ stock: qty, expiryDate: newExpiry });
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
    const { items, patientName, patientAge, patientPhone } = req.body;
    if (!Array.isArray(items) || items.length === 0)
      return res.status(400).json({ error: 'No items provided.' });

    // First pass: validate stock — all scoped to this pharmacy 🔑
    for (const item of items) {
      const med = await Medicine.findOne({ ownerId: req.ownerId, barcode: item.barcode });
      if (!med)
        return res.status(404).json({ error: `Medicine not found: ${item.barcode}` });
      const totalStock = med.batches.reduce((s, b) => s + b.stock, 0);
      if (totalStock < item.qty)
        return res.status(409).json({
          error: `Not enough stock for "${med.name}". Only ${totalStock} available.`,
          barcode: med.barcode,
          available: totalStock,
        });
    }

    // Second pass: deduct (FEFO — Batch A = earliest expiry first) & log sales
    const soldEntries = [];
    for (const item of items) {
      const med = await Medicine.findOne({ ownerId: req.ownerId, barcode: item.barcode }); // 🔑
      let remaining = item.qty;
      const sorted  = med.batches.sort((a, b) => new Date(a.expiryDate) - new Date(b.expiryDate));
      for (const batch of sorted) {
        if (remaining <= 0) break;
        const deduct = Math.min(batch.stock, remaining);
        batch.stock  -= deduct;
        remaining    -= deduct;
      }
      await doAutoShift(med);
      soldEntries.push({
        ownerId:      req.ownerId,
        type:         'sold',
        patientName:  patientName || '',
        patientAge:   patientAge || null,
        patientPhone: patientPhone || '',
        medicineName: med.name,
        barcode:      med.barcode,
        quantity:     item.qty,
        unitPrice:    med.price,
        lineTotal:    med.price * item.qty,
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
app.get('/stock-history', requireOwner, async (req, res) => {
  try {
    const limit = 200;
    const [sold, restocked] = await Promise.all([
      StockHistory.find({ ownerId: req.ownerId, type: 'sold' })
        .sort({ createdAt: -1 }).limit(limit).lean(),
      StockHistory.find({ ownerId: req.ownerId, type: 'restocked' })
        .sort({ createdAt: -1 }).limit(limit).lean(),
    ]);
    res.json({ sold, restocked });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /activity-logs — scoped to this pharmacy
app.get('/activity-logs', requireOwner, async (req, res) => {
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



// ── DELETE /medicine/:barcode ──────────────────────────────
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


// ── Start ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 MediFlow running on port ${PORT}`);
});
