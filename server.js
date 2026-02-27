// server.js (ESM)
import express from "express";
import axios from "axios";
import cors from "cors";
import multer from "multer";


// -------------------- CONFIG --------------------
const PORT = process.env.PORT || 10000;

// Base admin Pressero
const ADMIN_BASE = process.env.PRESSERO_ADMIN_BASE || "https://admin.ams.v6.pressero.com";
console.log("[CFG] ADMIN_BASE =", ADMIN_BASE);

// Identifiants (mets-les dans Render > Environment)
const ADMIN_USER = process.env.PRESSERO_ADMIN_USER || process.env.ADMIN_USER || "";
const ADMIN_PASS = process.env.PRESSERO_ADMIN_PASS || process.env.ADMIN_PASS || "";

// -------------------- APP --------------------
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "10mb" }));

// -------------------- CORS (UN SEUL SYSTEME) --------------------
app.use(cors({
  origin: (origin, cb) => {
    // Server-to-server / Postman (no origin)
    if (!origin) return cb(null, true);
    try {
      const u = new URL(origin);
      // Autorise tous les sous-domaines Pressero
      if (u.hostname.endsWith(".pressero.com")) return cb(null, true);
    } catch {}
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  credentials: false
}));
app.options("*", cors());

// -------------------- MULTER --------------------
const upload = multer({ storage: multer.memoryStorage() });

// -------------------- UTILS --------------------
function norm(s) {
  return (s ?? "").toString().trim().toLowerCase().replace(/\s+/g, " ");
}

// Signature SANS Business (pour éviter les doublons)
function sigNoBusiness(a) {
  return `${norm(a.Address1)}|${norm(a.Postal)}|${norm(a.City)}|${norm(a.Country || "")}`;
}

function assertSiteDomain(siteDomain) {
  const sd = (siteDomain || "").trim();
  if (!sd) throw new Error("siteDomain requis");
  // garde-fou
  if (!/^[a-z0-9.-]+$/i.test(sd)) throw new Error("siteDomain invalide");
  return sd;
}

function requireEnv() {
  if (!ADMIN_USER || !ADMIN_PASS) {
    throw new Error("Missing env: PRESSERO_ADMIN_USER / PRESSERO_ADMIN_PASS");
  }
}

// -------------------- AUTH / API CLIENT --------------------
async function authenticate() {
  requireEnv();

  const candidates = [
    "/api/public/authenticate",
    "/api/public/authentication/token"
    // ⚠️ retire /api/authenticate (ça t’a déjà cassé)
  ];

  let lastErr;
  for (const p of candidates) {
    try {
      console.log("[AUTH] trying:", `${ADMIN_BASE}${p}`);

      const r = await axios.post(
        `${ADMIN_BASE}${p}`,
        { UserName: ADMIN_USER, Password: ADMIN_PASS },
        { timeout: 20000 }
      );

      const token = r?.data?.Token || r?.data?.token || r?.data?.AuthToken || r?.data;
      if (token && typeof token === "string") return token;

      lastErr = new Error(`Auth ok but token missing for ${p}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Authentication failed");
}

function api(token) {
  return axios.create({
    baseURL: ADMIN_BASE,
    timeout: 30000,
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "Authorization": `token ${token}`
    }
  });
}

// -------------------- PRESERO HELPERS --------------------

// Fallback getUserId : tente plusieurs endpoints connus
async function getUserId(client, siteDomain, email) {
  const em = (email || "").trim();
  if (!em) throw new Error("Email requis pour getUserId");

  // essais d’endpoints (selon versions/tenants)
  const tries = [
    { method: "get", url: `/api/site/${siteDomain}/User`, params: { email: em } },
    { method: "get", url: `/api/site/${siteDomain}/Users`, params: { email: em } },
    { method: "get", url: `/api/site/${siteDomain}/User/Find`, params: { email: em } },
    { method: "get", url: `/api/site/${siteDomain}/Users/Find`, params: { email: em } },
    { method: "get", url: `/api/site/${siteDomain}/UserByEmail`, params: { email: em } }
  ];

  let lastErr;
  for (const t of tries) {
    try {
      const r = await client[t.method](t.url, { params: t.params });
      const data = r?.data;

      // formats possibles
      const id =
        data?.UserId || data?.Id || data?.id ||
        (Array.isArray(data) ? (data[0]?.UserId || data[0]?.Id || data[0]?.id) : null) ||
        (data?.User ? (data.User.UserId || data.User.Id) : null);

      if (id) return id;
      lastErr = new Error(`UserId introuvable via ${t.url}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Impossible de récupérer userId");
}

async function getAddressBook(client, siteDomain, userId) {
  const r = await client.get(`/api/site/${siteDomain}/Addressbook/${userId}`);
  return r.data;
}

// create + refetch pour récupérer AddressId
async function createAddress(client, siteDomain, userId, addr, template) {
  const payload = {
    Business: addr.Business || template?.Business || "Distribution",
    FirstName: addr.FirstName || template?.FirstName || "Client",
    LastName: addr.LastName || template?.LastName || "Distribution",
    Title: addr.Title || template?.Title || undefined,
    Address1: addr.Address1,
    Address2: addr.Address2 || undefined,
    Address3: addr.Address3 || undefined,
    City: addr.City,
    StateProvince: addr.StateProvince || template?.StateProvince || "NA",
    Postal: addr.Postal,
    Country: (addr.Country || template?.Country || "FR").toUpperCase(),
    Phone: addr.Phone || template?.Phone || undefined,
    Email: addr.Email || template?.Email || undefined
  };

  await client.post(`/api/site/${siteDomain}/Addressbook/${userId}/`, payload);

  // Refetch & match (SANS business) => plus stable
  const ab2 = await getAddressBook(client, siteDomain, userId);
  const all = [ab2?.PreferredAddress, ...(ab2?.Addresses || [])].filter(Boolean);

  const key = sigNoBusiness(payload);
  const found = all.find(a => sigNoBusiness(a) === key);

  return found?.AddressId || null;
}

async function upsertAddress(client, siteDomain, userId, addr) {
  const ab = await getAddressBook(client, siteDomain, userId);
  const preferred = ab?.PreferredAddress || null;

  const payload = {
    Business: addr.Business || preferred?.Business || "Distribution",
    FirstName: addr.FirstName || preferred?.FirstName || "Client",
    LastName: addr.LastName || preferred?.LastName || "Distribution",
    Title: addr.Title || preferred?.Title || undefined,
    Address1: addr.Address1,
    Address2: addr.Address2 || undefined,
    Address3: addr.Address3 || undefined,
    City: addr.City,
    StateProvince: addr.StateProvince || preferred?.StateProvince || "NA",
    Postal: addr.Postal,
    Country: (addr.Country || preferred?.Country || "FR").toUpperCase(),
    Phone: addr.Phone || preferred?.Phone || undefined,
    Email: addr.Email || preferred?.Email || undefined
  };

  // UPDATE
  if (addr.AddressId) {
    await client.put(
      `/api/site/${siteDomain}/Addressbook/${userId}/`,
      payload,
      { params: { addressId: addr.AddressId } }
    );
    return { mode: "updated", addressId: addr.AddressId };
  }

  // CREATE
  const createdId = await createAddress(client, siteDomain, userId, payload, preferred);
  return { mode: "created", addressId: createdId };
}

// -------------------- PARSERS --------------------
function normalizeRowToAddress(row) {
  // accepte colonnes variées : AddressId / AddressID etc.
  const addr = {
    AddressId: (row.AddressId || row.AddressID || row.addressId || row.addressID || "").toString().trim() || "",
    Business: (row.Business || row.business || "").toString().trim() || "Distribution",
    FirstName: (row.FirstName || row.firstname || "").toString().trim() || "Client",
    LastName: (row.LastName || row.lastname || "").toString().trim() || "Distribution",
    Title: (row.Title || row.title || "").toString().trim() || "",
    Address1: (row.Address1 || row.address1 || row.Address || row.address || "").toString().trim(),
    Address2: (row.Address2 || row.address2 || "").toString().trim() || "",
    Address3: (row.Address3 || row.address3 || "").toString().trim() || "",
    City: (row.City || row.city || "").toString().trim(),
    StateProvince: (row.StateProvince || row.state || row.province || "NA").toString().trim() || "NA",
    Postal: (row.Postal || row.zip || row.postal || "").toString().trim(),
    Country: (row.Country || row.country || "FR").toString().trim().toUpperCase(),
    Phone: (row.Phone || row.phone || "").toString().trim() || "",
    Email: (row.Email || row.email || "").toString().trim() || ""
  };

  // nettoie AddressId vide
  if (!addr.AddressId) delete addr.AddressId;
  return addr;
}


async function parseCsvBuffer(buf) {
  const txt = buf.toString("utf-8");
  const lines = txt.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return [];

  const headers = lines[0].split(",").map(h => h.trim());
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map(c => c.trim());
    const row = {};
    headers.forEach((h, idx) => row[h] = cols[idx] ?? "");
    const addr = normalizeRowToAddress(row);
    if (addr.Address1 && addr.City && addr.Postal && addr.Country) out.push(addr);
  }
  return out;
}

// -------------------- ROUTES --------------------
app.get("/health", (req, res) => res.json({ ok: true }));

// Liste addressbook (dedupe preferred)
app.post("/addressbook/list", async (req, res, next) => {
  try {
    const { userEmail, siteDomain } = req.body || {};
    if (!userEmail) return res.status(400).json({ error: "userEmail requis" });

    const sd = assertSiteDomain(siteDomain);

    const token = await authenticate();
    const client = api(token);

    const userId = await getUserId(client, sd, userEmail);
    const ab = await getAddressBook(client, sd, userId);

    const preferred = ab?.PreferredAddress || null;
    const addresses = ab?.Addresses || [];

    const map = new Map();
    for (const a of [preferred, ...addresses].filter(Boolean)) {
      const id = a?.AddressId;
      if (id && !map.has(id)) map.set(id, a);
    }

    return res.json({
      ok: true,
      userId,
      preferredId: preferred?.AddressId || null,
      addresses: [...map.values()]
    });
  } catch (e) {
    return next(e);
  }
});

// Import fichier (CSV/XLSX) : update + create + SKIP doublons existants
app.post("/addressbook/import-file", upload.single("file"), async (req, res, next) => {
  try {
    const userEmail = (req.body?.userEmail || "").trim();
    const siteDomain = (req.body?.siteDomain || "").trim();
    if (!userEmail) return res.status(400).json({ error: "userEmail requis" });

    const sd = assertSiteDomain(siteDomain);
    const f = req.file;
    if (!f) return res.status(400).json({ error: "Fichier manquant (field 'file')" });

    const name = (f.originalname || "file").toLowerCase();
    const ext = name.split(".").pop();

    let addresses = [];
    if (ext === "csv") addresses = await parseCsvBuffer(f.buffer);
else return res.status(400).json({ error: "Format non supporté (csv uniquement)" });

    if (!addresses.length) {
      return res.status(400).json({ error: "Aucune ligne valide trouvée dans le fichier." });
    }

    const token = await authenticate();
    const client = api(token);

    const userId = await getUserId(client, sd, userEmail);

    // EXISTING signatures in addressbook (skip duplicates)
    const abExisting = await getAddressBook(client, sd, userId);
    const existingAll = [
      abExisting?.PreferredAddress,
      ...(abExisting?.Addresses || [])
    ].filter(Boolean);
    const existingSig = new Set(existingAll.map(sigNoBusiness));

    // DEDUPE inside file
    const seen = new Set();
    const unique = [];
    for (const a of addresses) {
      const k = a.AddressId ? `id:${a.AddressId}` : `k:${sigNoBusiness(a)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(a);
    }

    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    const skipped = [];
    const errors = [];

    for (let i = 0; i < unique.length; i++) {
      const addr = unique[i];
      try {
        // SKIP duplicates already in addressbook (only for rows without AddressId)
        if (!addr.AddressId) {
          const s = sigNoBusiness(addr);
          if (existingSig.has(s)) {
            skippedCount++;
            skipped.push({
              index: i + 1,
              address: `${addr.Address1} / ${addr.Postal} / ${addr.City}`,
              reason: "duplicate_in_addressbook"
            });
            continue;
          }
        }

        const r = await upsertAddress(client, sd, userId, addr);

        if (r.mode === "updated") updatedCount++;
        else {
          createdCount++;
          existingSig.add(sigNoBusiness(addr)); // avoid duplicates in same run
        }
      } catch (e) {
        errors.push({
          index: i + 1,
          address: `${addr.Address1} / ${addr.Postal} / ${addr.City}`,
          message: e?.response?.data?.Message || e?.message || "unknown_error",
          status: e?.response?.status || null
        });
      }
    }

    return res.json({
      ok: errors.length === 0,
      totalParsed: addresses.length,
      totalImported: unique.length,
      createdCount,
      updatedCount,
      skippedCount,
      errorCount: errors.length,
      skipped,
      errors
    });
  } catch (e) {
    return next(e);
  }
});

// Validate distribution list: ensure each address exists (create if missing), return addressId
function mergeDuplicates(list) {
  if (!Array.isArray(list)) return [];
  const map = new Map();
  for (const r of list) {
    const address = (r?.address || r?.Address1 || "").toString().trim();
    const zip = (r?.zip || r?.Postal || "").toString().trim();
    const city = (r?.city || r?.City || "").toString().trim();
    const country = (r?.country || r?.Country || "FR").toString().trim().toUpperCase();
    const qty = Number(r?.qty || r?.quantity || 1) || 1;

    if (!address || !zip || !city) continue;
    const key = `${norm(address)}|${norm(zip)}|${norm(city)}|${norm(country)}`;
    const prev = map.get(key) || { address, zip, city, country, qty: 0 };
    prev.qty += qty;
    map.set(key, prev);
  }
  return [...map.values()];
}

app.post("/validate-addresses", async (req, res, next) => {
  try {
    const { userEmail, siteDomain, distributionList } = req.body || {};
    if (!userEmail) return res.status(400).json({ error: "userEmail requis" });

    const sd = assertSiteDomain(siteDomain);
    const list = mergeDuplicates(distributionList);
    if (!list.length) return res.status(400).json({ error: "distributionList vide" });

    const token = await authenticate();
    const client = api(token);

    const userId = await getUserId(client, sd, userEmail);
    const ab = await getAddressBook(client, sd, userId);
    const preferred = ab?.PreferredAddress || null;

    // map existing by signature
    const existingAll = [ab?.PreferredAddress, ...(ab?.Addresses || [])].filter(Boolean);
    const existingSigToId = new Map();
    for (const a of existingAll) {
      const id = a?.AddressId;
      if (id) existingSigToId.set(sigNoBusiness(a), id);
    }

    const validated = [];

    for (const row of list) {
      const addr = {
        Business: "Distribution",
        Address1: row.address,
        City: row.city,
        Postal: row.zip,
        Country: row.country || preferred?.Country || "FR"
      };

      const s = sigNoBusiness(addr);
      let addressId = existingSigToId.get(s) || null;

      if (!addressId) {
        addressId = await createAddress(client, sd, userId, addr, preferred);
        if (addressId) existingSigToId.set(s, addressId);
      }

      if (!addressId) throw new Error(`Impossible de créer/trouver l'adresse: ${row.address} ${row.zip} ${row.city}`);

      validated.push({ ...row, addressId });
    }

    return res.json({ ok: true, userId, validated });
  } catch (e) {
    return next(e);
  }
});

// Export CSV
app.get("/addressbook/export.csv", async (req, res, next) => {
  try {
    const { userEmail, siteDomain } = req.query || {};
    if (!userEmail) return res.status(400).send("userEmail requis");

    const sd = assertSiteDomain(siteDomain);

    const token = await authenticate();
    const client = api(token);
    const userId = await getUserId(client, sd, userEmail);
    const ab = await getAddressBook(client, sd, userId);

    const preferred = ab?.PreferredAddress || null;
    const addresses = ab?.Addresses || [];

    // dedupe by AddressId
    const map = new Map();
    for (const a of [preferred, ...addresses].filter(Boolean)) {
      const id = a?.AddressId;
      if (id && !map.has(id)) map.set(id, a);
    }
    const unique = [...map.values()];

    const headers = [
      "AddressId","Business","FirstName","LastName","Title",
      "Address1","Address2","Address3","City","StateProvince",
      "Postal","Country","Phone","Email","IsPreferred"
    ];

    const lines = [headers.join(",")];
    for (const a of unique) {
      const row = headers.map(h => {
        const v = (h === "IsPreferred")
          ? (a?.AddressId && preferred?.AddressId && a.AddressId === preferred.AddressId ? "true" : "false")
          : (a?.[h] ?? "");
        const s = String(v).replace(/"/g, '""');
        return `"${s}"`;
      });
      lines.push(row.join(","));
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="addressbook.csv"`);
    return res.send(lines.join("\n"));
  } catch (e) {
    return next(e);
  }
});

// Export XLSX (désactivé pour raisons de sécurité)
app.get("/addressbook/export.xlsx", (req, res) => {
  return res.status(410).json({
    ok: false,
    error: "XLSX export disabled for security. Use /addressbook/export.csv"
  });
});

// -------------------- ERROR HANDLER (JSON lisible) --------------------
app.use((err, req, res, next) => {
  console.error("[SERVER ERROR]", err?.response?.data || err?.stack || err);

  const status = err?.response?.status || err?.statusCode || 500;
  const upstream = err?.response?.data || null;

  res.status(status).json({
    ok: false,
    error: err?.message || "server_error",
    status,
    upstream
  });
});

// -------------------- START --------------------
app.listen(PORT, () => {
  console.log(`cart-orchestrator listening on :${PORT}`);
});
