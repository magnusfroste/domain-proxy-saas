/**
 * DomainProxy SaaS Starter
 * 
 * A complete example showing how to integrate DomainProxy into your SaaS.
 * This starter demonstrates:
 * - User authentication
 * - Multi-tenant architecture
 * - Custom domain registration via DomainProxy API
 * - Host-based tenant detection
 * 
 * Use this as a starting point for your own SaaS!
 */

const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs-extra');
const axios = require('axios');
const path = require('path');

const app = express();

// =============================================================================
// CONFIGURATION
// =============================================================================

const config = {
  port: process.env.PORT || 3001,
  
  // DomainProxy settings - use Cloud or your self-hosted instance
  domainProxy: {
    url: process.env.DOMAINPROXY_URL || 'https://proxy.froste.eu',
    apiKey: process.env.DOMAINPROXY_API_KEY || 'saas_demo_123',
  },
  
  // Your SaaS public URL (where DomainProxy will proxy to)
  saasUrl: process.env.SAAS_URL || 'http://localhost:3001',
  
  // Demo credentials (change in production!)
  demo: {
    email: process.env.DEMO_EMAIL || 'demo@example.com',
    password: process.env.DEMO_PASSWORD || 'demo123',
  },
  
  // VPS demo mode
  enableVpsDemo: process.env.ENABLE_VPS_DEMO === 'true',
  
  isDev: process.env.NODE_ENV !== 'production',
};

// =============================================================================
// DATABASE SETUP
// =============================================================================

const DATA_DIR = path.join(__dirname, 'data');
fs.ensureDirSync(DATA_DIR);
const db = new sqlite3.Database(path.join(DATA_DIR, 'saas.db'), (err) => {
  if (err) {
    console.error('❌ Failed to open database:', err);
    process.exit(1);
  }
  console.log('✅ Database opened successfully');
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: DATA_DIR }),
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: !config.isDev, maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Initialize database schema
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    company_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    base_domain TEXT NOT NULL,
    subdomain TEXT NOT NULL,
    company_name TEXT,
    tagline TEXT,
    primary_color TEXT DEFAULT '#22c55e',
    content TEXT DEFAULT '',
    domain_status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id),
    UNIQUE(base_domain, subdomain)
  )`);

  // Create demo user
  db.get('SELECT id FROM users WHERE email = ?', [config.demo.email], (err, row) => {
    if (!row) {
      db.run('INSERT INTO users (email, password, company_name) VALUES (?, ?, ?)', 
        [config.demo.email, config.demo.password, 'Demo Company']);
    }
  });
});

// // API: Get proxies from DomainProxy
// const getProxiesFromAPI = async () => {
//   try {
//     const response = await axios.get(`${config.domainProxy.url}/api/v1/proxies`, {
//       headers: { 'X-API-Key': config.domainProxy.apiKey }
//     });
//     return response.data;
//   } catch (err) {
//     console.error('Failed to fetch proxies:', err.message);
//     return [];
//   }
// };

const domainProxyClient = {
  async createTenant(baseDomain) {
    const response = await axios.post(
      `${config.domainProxy.url}/api/v1/create-tenant`,
      { base_domain: baseDomain },
      { headers: { 'X-API-Key': config.domainProxy.apiKey, 'Content-Type': 'application/json' } }
    );
    return response.data;
  },

  async registerSubdomain(subdomain, baseDomain, targetUrl) {
    const response = await axios.post(
      `${config.domainProxy.url}/api/v1/register-subdomain`,
      { subdomain, base_domain: baseDomain, target_url: targetUrl },
      { headers: { 'X-API-Key': config.domainProxy.apiKey, 'Content-Type': 'application/json' } }
    );
    return response.data;
  },

  async deleteProxy(subdomain, baseDomain) {
    const response = await axios.post(
      `${config.domainProxy.url}/api/v1/delete-proxy`,
      { subdomain, base_domain: baseDomain },
      { headers: { 'X-API-Key': config.domainProxy.apiKey, 'Content-Type': 'application/json' } }
    );
    return response.data;
  },

  async verifyDomain(domain) {
    const response = await axios.get(
      `${config.domainProxy.url}/api/v1/verify-domain?domain=${domain}`,
      { headers: { 'X-API-Key': config.domainProxy.apiKey } }
    );
    return response.data;
  }
};

// Auto-login demo user for demo purposes
function autoLoginDemo(req, res, next) {
  if (!req.session.userId) {
    db.get('SELECT id FROM users WHERE email = ?', [config.demo.email], (err, user) => {
      if (!err && user) {
        req.session.userId = user.id;
        req.session.companyName = 'Demo Company';
      }
      next();
    });
  } else {
    next();
  }
}

function requireLogin(req, res, next) {
  if (req.session.userId) return next();
  res.redirect('/login');
}

// Detect if request is from a custom domain (tenant page)
function detectTenant(req, res, next) {
  // Allow testing via ?tenant=domain query param
  if (req.query.tenant) {
    console.log('🔍 Query tenant detection:', req.query.tenant);
    const parts = req.query.tenant.split('.');
    if (parts.length >= 2) {
      req.tenant = null; // Reset
      req.tenantHost = { subdomain: parts[0], baseDomain: parts.slice(1).join('.') };
      console.log('📍 Looking up tenant:', req.tenantHost);
      // Look up tenant
      db.get(
        'SELECT * FROM tenants WHERE subdomain = ? AND base_domain = ?',
        [req.tenantHost.subdomain, req.tenantHost.baseDomain],
        (err, tenant) => {
          if (err) {
            console.error('❌ DB error in tenant lookup:', err);
            req.tenant = null;
          } else if (tenant) {
            console.log('✅ Found tenant via query:', tenant.company_name || tenant.subdomain);
            req.tenant = tenant;
          } else {
            console.log('⚠️ No tenant found for:', req.tenantHost);
            req.tenant = null;
          }
          next();
        }
      );
      return;
    }
  }
  
  const host = (req.headers['x-original-host'] || req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  console.log('🔍 Host-based tenant detection:', { host, 'x-original-host': req.headers['x-original-host'], 'x-forwarded-host': req.headers['x-forwarded-host'], 'req.headers.host': req.headers.host });
  console.log('🔍 All headers received:', JSON.stringify(req.headers, null, 2));
  const parts = host.split('.');
  
  // Skip if it's localhost or the main SaaS domain
  if (host.includes('localhost') || parts.length < 2) {
    console.log('⚠️ Skipping tenant detection (localhost or main domain)');
    req.tenant = null;
    return next();
  }
  
  const subdomain = parts[0];
  const baseDomain = parts.slice(1).join('.');
  console.log('📍 Host-based lookup:', { subdomain, baseDomain });
  
  db.get(
    'SELECT * FROM tenants WHERE subdomain = ? AND base_domain = ?',
    [subdomain, baseDomain],
    (err, tenant) => {
      if (err) {
        console.error('❌ DB error in host tenant lookup:', err);
        req.tenant = null;
      } else if (tenant) {
        console.log('✅ Found tenant via host:', tenant.company_name || tenant.subdomain);
        req.tenant = tenant;
      } else {
        console.log('⚠️ No tenant found for host:', { subdomain, baseDomain });
        req.tenant = null;
      }
      req.tenantHost = { subdomain, baseDomain };
      next();
    }
  );
}

// =============================================================================
// STYLES (shared across pages)
// =============================================================================

const styles = `
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0a; color: #e5e5e5; line-height: 1.6; }
  .container { max-width: 900px; margin: 0 auto; padding: 40px 20px; }
  h1 { color: #fff; margin-bottom: 10px; }
  h2 { color: #fff; margin: 30px 0 15px; }
  h3 { color: #22c55e; }
  a { color: #22c55e; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .btn { display: inline-block; background: #22c55e; color: #000; padding: 12px 24px; border-radius: 8px; font-weight: 600; border: none; cursor: pointer; text-decoration: none; }
  .btn:hover { background: #16a34a; text-decoration: none; }
  .btn-secondary { background: #333; color: #fff; }
  .btn-danger { background: #ef4444; }
  .card { background: #111; border: 1px solid #222; border-radius: 12px; padding: 25px; margin: 15px 0; }
  input, textarea, select { width: 100%; padding: 12px; background: #1a1a1a; border: 1px solid #333; border-radius: 6px; color: #fff; font-size: 1rem; margin-bottom: 15px; }
  input:focus, textarea:focus { outline: none; border-color: #22c55e; }
  label { display: block; color: #888; margin-bottom: 5px; font-size: 0.9rem; }
  .nav { background: #111; padding: 15px 0; border-bottom: 1px solid #222; }
  .nav-inner { max-width: 900px; margin: 0 auto; padding: 0 20px; display: flex; justify-content: space-between; align-items: center; }
  .logo { font-weight: bold; font-size: 1.2rem; color: #fff; }
  .nav a { color: #888; margin-left: 20px; }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 4px; font-size: 0.8rem; font-weight: 600; }
  .badge-success { background: #22c55e; color: #000; }
  .badge-pending { background: #f59e0b; color: #000; }
  .badge-error { background: #ef4444; color: #fff; }
  code { background: #1a1a1a; padding: 3px 8px; border-radius: 4px; font-family: monospace; color: #22c55e; }
  .tenant-card { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 15px; }
  .tenant-info { flex: 1; min-width: 200px; }
  .tenant-actions { display: flex; gap: 10px; }
  .dns-box { background: #0a0a0a; border: 1px solid #333; border-radius: 6px; padding: 15px; margin-top: 15px; }
  .subtitle { color: #888; margin-bottom: 30px; }
</style>
`;

// =============================================================================
// AUTH ROUTES
// =============================================================================

app.get('/test', (req, res) => {
  res.send('Test route working!');
});

app.get('/health', (req, res) => {
  res.send('OK');
});

app.get('/login', (req, res) => {
  const emailValue = config.demo.email;
  const passwordValue = config.demo.password;
  
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login - SaaS Starter</title>
  ${styles}
</head>
<body>
<div class="container" style="max-width:400px;margin-top:100px;">
  <h1>🚀 SaaS Starter</h1>
  <p class="subtitle">Login to manage your custom domains</p>
  
  <div class="card">
    <form method="post" action="/login">
      <label>Email</label>
      <input name="email" type="email" value="${emailValue}" required>
      
      <label>Password</label>
      <input name="password" type="password" value="${passwordValue}" required>
      
      <button type="submit" class="btn" style="width:100%;">Login</button>
    </form>
  </div>
  
  <p style="text-align:center;margin-top:20px;color:#666;">
    Demo: ${config.demo.email} / ${config.demo.password}
  </p>
  
  <p style="text-align:center;margin-top:30px;font-size:0.9rem;">
    Powered by <a href="https://proxy.froste.eu" target="_blank">DomainProxy</a>
  </p>
</div>
</body>
</html>
  `);
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT id, company_name FROM users WHERE email = ? AND password = ?', [email, password], (err, user) => {
    if (user) {
      req.session.userId = user.id;
      req.session.companyName = user.company_name;
      res.redirect('/dashboard');
    } else {
      res.redirect('/login?error=invalid');
    }
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// =============================================================================
// DASHBOARD ROUTES
// =============================================================================

app.get('/dashboard', autoLoginDemo, async (req, res) => {
  const userId = req.session.userId;
  const synced = req.query.synced;
  
  // Get proxies from API if synced
  let apiProxies = [];
  if (synced) {
    apiProxies = await getProxiesFromAPI();
  }
  
  db.all('SELECT * FROM tenants WHERE user_id = ? ORDER BY created_at DESC', [userId], (err, tenants) => {
    if (err) tenants = [];
    
    const proxyDomain = new URL(config.domainProxy.url).hostname;
    
    const tenantCards = tenants.map(t => {
      const fullDomain = `${t.subdomain}.${t.base_domain}`;
      const statusBadge = t.domain_status === 'active' 
        ? '<span class="badge badge-success">Active</span>'
        : t.domain_status === 'registered'
        ? '<span class="badge badge-pending">Registered (DNS Pending)</span>'
        : '<span class="badge badge-pending">Pending</span>';
      
      return `
        <div class="card">
          <div class="tenant-card">
            <div class="tenant-info">
              <h3>${t.company_name || fullDomain}</h3>
              <p><a href="https://${fullDomain}" target="_blank">${fullDomain}</a> ${statusBadge}</p>
              ${t.tagline ? `<p style="color:#888;">${t.tagline}</p>` : ''}
            </div>
            <div class="tenant-actions">
              <a href="/dashboard/edit/${t.id}" class="btn btn-secondary">Edit</a>
              <a href="/p/${t.subdomain}_${t.base_domain.replace(/\./g, '_')}" target="_blank" class="btn" style="background:#10b981;">🔗 Path Link</a>
              <form method="post" action="/dashboard/check-status/${t.id}" style="margin:0;display:inline;">
                <button type="submit" class="btn" style="background:#3b82f6;">Check Status</button>
              </form>
              <form method="post" action="/dashboard/delete/${t.id}" style="margin:0;display:inline;" onsubmit="return confirm('Delete this domain?')">
                <button type="submit" class="btn btn-danger">Delete</button>
              </form>
            </div>
          </div>
          <div class="dns-box">
            <p style="color:#888;margin-bottom:10px;font-size:0.9rem;">📋 DNS Setup — Add this CNAME record:</p>
            <code style="display:block;padding:10px;background:#111;">${t.subdomain}.${t.base_domain} → ${proxyDomain}</code>
          </div>
        </div>
      `;
    }).join('') || '<div class="card"><p style="color:#888;">No custom domains yet. Create one below!</p></div>';

    res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard - SaaS Starter</title>
  ${styles}
</head>
<body>
<nav class="nav">
  <div class="nav-inner">
    <span class="logo">🚀 SaaS Starter</span>
    <div>
      <a href="/dashboard">Dashboard</a>
      <a href="/logout">Logout</a>
    </div>
  </div>
</nav>

<div class="container">
  <h1>Dashboard</h1>
  <p class="subtitle">Manage your custom domains</p>

  <h2>Add Custom Domain</h2>
  <div class="card">
    <form method="post" action="/dashboard/create">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:15px;">
        <div>
          <label>Subdomain</label>
          <input name="subdomain" placeholder="app" value="app" required>
        </div>
        <div>
          <label>Base Domain</label>
          <input name="base_domain" placeholder="customer.com" required>
        </div>
      </div>
      
      <label>Company Name</label>
      <input name="company_name" placeholder="Acme Corp">
      
      <label>Tagline</label>
      <input name="tagline" placeholder="Building the future...">
      
      <label>Page Content (HTML)</label>
      <textarea name="content" rows="4" placeholder="<p>Welcome to our page!</p>"></textarea>
      
      <button type="submit" class="btn">Create & Register Domain</button>
    </form>
  </div>

  <h2>Your Domains</h2>
  <div style="margin-bottom:20px;">
    <form method="post" action="/dashboard/sync-proxies" style="display:inline;">
      <button type="submit" class="btn" style="background:#6366f1;">🔄 Sync from DomainProxy API</button>
    </form>
    ${synced ? `<span style="color:#22c55e;margin-left:10px;">Synced ${synced} proxies from API</span>` : ''}
  </div>
  ${tenantCards}
  
  <div style="margin-top:40px;padding:20px;background:#111;border-radius:8px;border:1px solid #222;">
    <h3 style="margin-bottom:10px;">📖 How it works</h3>
    <ol style="color:#888;padding-left:20px;">
      <li>Create a domain above</li>
      <li>Add the CNAME record to your DNS provider</li>
      <li>Wait a few minutes for DNS propagation</li>
      <li>Visit your custom domain — HTTPS works automatically!</li>
    </ol>
    <p style="margin-top:15px;font-size:0.9rem;">
      Powered by <a href="${config.domainProxy.url}" target="_blank">DomainProxy</a>
    </p>
  </div>
</div>
</body>
</html>
    `);
  });
});

app.post('/dashboard/create', autoLoginDemo, async (req, res) => {
  const userId = req.session.userId;
  const { subdomain, base_domain, company_name, tagline, content } = req.body;
  
  let domainStatus = 'pending';
  
  try {
    // 1. Create tenant (base domain) in DomainProxy
    await domainProxyClient.createTenant(base_domain);
    console.log(`✅ Tenant created: ${base_domain}`);

    // 2. Register subdomain proxy
    await domainProxyClient.registerSubdomain(subdomain, base_domain, config.saasUrl);
    console.log(`✅ Proxy registered: ${subdomain}.${base_domain}`);
    
    domainStatus = 'registered';
  } catch (err) {
    console.error(`❌ DomainProxy API error: ${err.response?.data || err.message}`);
    // Continue - save tenant anyway, user can retry
  }
  
  db.run(
    `INSERT INTO tenants (user_id, base_domain, subdomain, company_name, tagline, content, domain_status) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, base_domain, subdomain, company_name, tagline, content, domainStatus],
    (err) => {
      if (err) console.error('DB error:', err);
      res.redirect('/dashboard');
    }
  );
});

app.get('/dashboard/edit/:id', autoLoginDemo, (req, res) => {
  const userId = req.session.userId;
  const tenantId = req.params.id;
  
  db.get('SELECT * FROM tenants WHERE id = ? AND user_id = ?', [tenantId, userId], (err, tenant) => {
    if (!tenant) return res.redirect('/dashboard');
    
    res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Edit Domain - SaaS Starter</title>
  ${styles}
</head>
<body>
<nav class="nav">
  <div class="nav-inner">
    <span class="logo">🚀 SaaS Starter</span>
    <div>
      <a href="/dashboard">Dashboard</a>
      <a href="/logout">Logout</a>
    </div>
  </div>
</nav>

<div class="container" style="max-width:600px;">
  <h1>Edit Domain</h1>
  <p class="subtitle">${tenant.subdomain}.${tenant.base_domain}</p>
  
  <div class="card">
    <form method="post" action="/dashboard/update/${tenantId}">
      <label>Company Name</label>
      <input name="company_name" value="${tenant.company_name || ''}">
      
      <label>Tagline</label>
      <input name="tagline" value="${tenant.tagline || ''}">
      
      <label>Primary Color</label>
      <input name="primary_color" type="color" value="${tenant.primary_color || '#22c55e'}" style="height:50px;">
      
      <label>Page Content (HTML)</label>
      <textarea name="content" rows="8">${tenant.content || ''}</textarea>
      
      <div style="display:flex;gap:10px;">
        <button type="submit" class="btn">Save Changes</button>
        <a href="/dashboard" class="btn btn-secondary">Cancel</a>
      </div>
    </form>
  </div>
</div>
</body>
</html>
    `);
  });
});

app.post('/dashboard/update/:id', autoLoginDemo, (req, res) => {
  const userId = req.session.userId;
  const tenantId = req.params.id;
  const { company_name, tagline, primary_color, content } = req.body;
  
  db.run(
    `UPDATE tenants SET company_name = ?, tagline = ?, primary_color = ?, content = ? 
     WHERE id = ? AND user_id = ?`,
    [company_name, tagline, primary_color, content, tenantId, userId],
    () => res.redirect('/dashboard')
  );
});

app.post('/dashboard/check-status/:id', autoLoginDemo, async (req, res) => {
  const userId = req.session.userId;
  const tenantId = req.params.id;
  
  db.get('SELECT * FROM tenants WHERE id = ? AND user_id = ?', [tenantId, userId], async (err, tenant) => {
    if (!tenant) return res.redirect('/dashboard');
    
    try {
      const domain = `${tenant.subdomain}.${tenant.base_domain}`;
      const result = await domainProxyClient.verifyDomain(domain);
      
      if (result.verified) {
        db.run('UPDATE tenants SET domain_status = ? WHERE id = ?', ['active', tenantId]);
      }
      // If not verified, keep as is
    } catch (err) {
      console.error('Status check failed:', err.message);
    }
    
    res.redirect('/dashboard');
  });
});

// API: Get proxies from DomainProxy
const getProxiesFromAPI = async () => {
  try {
    const response = await axios.get(`${config.domainProxy.url}/api/v1/proxies`, {
      headers: { 'X-API-Key': config.domainProxy.apiKey }
    });
    return response.data;
  } catch (err) {
    console.error('Failed to fetch proxies:', err.message);
    return [];
  }
};

app.post('/dashboard/sync-proxies', autoLoginDemo, async (req, res) => {
  const proxies = await getProxiesFromAPI();
  res.redirect('/dashboard?synced=' + proxies.length);
});

app.get('/dashboard/delete/:id', autoLoginDemo, async (req, res) => {
  console.log('🚨 DELETE ROUTE HIT:', req.url, req.params);
  const userId = req.session.userId;
  const tenantId = req.params.id;
  
  console.log(`🔍 DELETE request: userId=${userId}, tenantId=${tenantId}`);
  
  // Get tenant info first
  db.get('SELECT * FROM tenants WHERE id = ? AND user_id = ?', [tenantId, userId], async (err, tenant) => {
    if (err) {
      console.error('❌ DB error getting tenant:', err);
      return res.redirect('/dashboard?error=db');
    }
    
    if (!tenant) {
      console.log('⚠️ Tenant not found or not owned by user');
      return res.redirect('/dashboard?error=notfound');
    }
    
    console.log(`📝 Found tenant: ${tenant.subdomain}.${tenant.base_domain}`);
    
    // Try to delete from DomainProxy
    try {
      await domainProxyClient.deleteProxy(tenant.subdomain, tenant.base_domain);
      console.log(`✅ Proxy deleted from DomainProxy: ${tenant.subdomain}.${tenant.base_domain}`);
    } catch (err) {
      console.error(`⚠️ Failed to delete proxy from DomainProxy: ${err.message}`);
      // Continue anyway - still delete from local DB
    }
    
    db.run('DELETE FROM tenants WHERE id = ? AND user_id = ?', [tenantId, userId], (deleteErr) => {
      if (deleteErr) {
        console.error('❌ DB error deleting tenant:', deleteErr);
        return res.redirect('/dashboard?error=delete');
      }
      
      console.log(`✅ Tenant deleted from local DB: ID ${tenantId}`);
      res.redirect('/dashboard?deleted=1');
    });
  });
});

// =============================================================================
// TENANT PAGES (Host-based routing)
// =============================================================================

// This middleware detects custom domains and renders tenant pages
app.use(detectTenant);

// Path-based tenant access: /p/subdomain_baseDomain
app.get('/p/:encoded', (req, res) => {
  const encoded = req.params.encoded;
  const parts = encoded.split('_');
  if (parts.length < 2) {
    return res.redirect('/dashboard');
  }
  
  const subdomain = parts[0];
  const baseDomain = parts.slice(1).join('.'); // Reconstruct with dots
  
  console.log('🔍 Path-based tenant access:', { encoded, subdomain, baseDomain });
  
  db.get(
    'SELECT * FROM tenants WHERE subdomain = ? AND base_domain = ?',
    [subdomain, baseDomain],
    (err, tenant) => {
      if (err) {
        console.error('❌ DB error in path tenant lookup:', err);
        return res.redirect('/dashboard');
      }
      
      if (!tenant) {
        console.log('⚠️ No tenant found for path:', { subdomain, baseDomain });
        return res.redirect('/dashboard');
      }
      
      console.log('✅ Found tenant via path:', tenant.company_name || tenant.subdomain);
      return renderTenantPage(req, res, tenant);
    }
  );
});

app.get('/', autoLoginDemo, (req, res, next) => {
  // If VPS demo mode, show demo tenant page
  if (config.enableVpsDemo) {
    const demoTenant = {
      company_name: 'Demo SaaS',
      tagline: 'Running in VPS Demo Mode',
      primary_color: '#22c55e',
      content: '<p>This is a demo running directly on VPS, bypassing host header issues from platforms like EasyPanel/Railway.</p><p>Custom domains would normally be detected here via DomainProxy.</p>'
    };
    return renderTenantPage(req, res, demoTenant);
  }
  
  // If accessed via custom domain, show tenant page
  if (req.tenant) {
    return renderTenantPage(req, res, req.tenant);
  }
  // Otherwise redirect to dashboard
  res.redirect('/dashboard');
});

// Catch-all for tenant pages on custom domains
app.use((req, res, next) => {
  if (req.tenant) {
    return renderTenantPage(req, res, req.tenant);
  }
  next();
});

function renderTenantPage(req, res, tenant) {
  const primaryColor = tenant.primary_color || '#22c55e';
  
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${tenant.company_name || tenant.subdomain} - ${tenant.base_domain}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0a; color: #e5e5e5; line-height: 1.6; min-height: 100vh; }
    .hero { text-align: center; padding: 120px 20px; background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 100%); }
    .hero h1 { font-size: 3.5rem; margin-bottom: 15px; color: #fff; }
    .hero p { font-size: 1.3rem; color: #888; max-width: 600px; margin: 0 auto; }
    .content { max-width: 800px; margin: 0 auto; padding: 60px 20px; }
    .badge { display: inline-block; background: ${primaryColor}20; border: 1px solid ${primaryColor}40; color: ${primaryColor}; padding: 8px 18px; border-radius: 25px; font-size: 0.9rem; margin-bottom: 25px; }
    footer { text-align: center; padding: 40px; color: #666; border-top: 1px solid #222; }
    footer a { color: #888; }
  </style>
</head>
<body>
  <div class="hero">
    <div class="badge">✨ Welcome</div>
    <h1>${tenant.company_name || tenant.subdomain}</h1>
    <p>${tenant.tagline || `Welcome to ${tenant.subdomain}.${tenant.base_domain}`}</p>
  </div>
  
  <div class="content">
    ${tenant.content || '<p style="text-align:center;color:#888;">Content coming soon...</p>'}
  </div>
  
  <footer>
    <p>Powered by <a href="${config.domainProxy.url}" target="_blank">DomainProxy</a></p>
  </footer>
</body>
</html>
  `);
}

// =============================================================================
// 404 HANDLER
// =============================================================================

app.use((req, res) => {
  res.status(404).send(`
<!DOCTYPE html>
<html>
<head>
  <title>404 - Not Found</title>
  ${styles}
</head>
<body>
<div class="container" style="text-align:center;margin-top:100px;">
  <h1 style="font-size:4rem;">404</h1>
  <p class="subtitle">Page not found</p>
  <a href="/dashboard" class="btn">Go to Dashboard</a>
</div>
</body>
</html>
  `);
});

// =============================================================================
// SERVER STARTUP
// =============================================================================

try {
  app.listen(config.port, () => {
    console.log(`🚀 SaaS Starter running!\n   Deployed: ${new Date().toISOString()}\n\n   Local:        http://localhost:${config.port}\n   Dashboard:    http://localhost:${config.port}/dashboard\n   Demo:         ${config.demo.email} / ${config.demo.password}\n\n   DomainProxy:  ${config.domainProxy.url}\n   API Key:      ${config.domainProxy.apiKey.substring(0, 12)}...\n`);
  });
} catch (error) {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
}