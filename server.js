import express from "express";
import axios from "axios";
import cors from "cors";


const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    try {
      const u = new URL(origin);
      if (u.hostname.endsWith(".pressero.com")) return cb(null, true);
    } catch {}
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false
}));


// Optionnel : répondre explicitement au preflight
app.options("*", cors());

// --- ENV ---
const ADMIN_URL = process.env.PRESSERO_ADMIN_URL || "https://admin.ams.v6.pressero.com";
const SITE_DOMAIN = process.env.PRESSERO_SITE_DOMAIN || "decoration.ams.v6.pressero.com";

// Credentials Pressero (à mettre dans Render ENV, jamais dans le front)
const AUTH_PAYLOAD = {
  UserName: process.env.PRESSERO_USERNAME,
  Password: process.env.PRESSERO_PASSWORD,
  SubscriberId: process.env.PRESSERO_SUBSCRIBER_ID,
  ConsumerID: process.env.PRESSERO_CONSUMER_ID
};

function assertEnv() {
  const missing = Object.entries(AUTH_PAYLOAD)
    .filter(([,v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`Missing ENV: ${missing.join(", ")}`);
  }
}

async function authenticate() {
  assertEnv();
  const r = await axios.post(`${ADMIN_URL}/api/V2/Authentication`, AUTH_PAYLOAD, {
    headers: { "Content-Type": "application/json" }
  });
  const token = r?.data?.Token; // ✅ confirmé :contentReference[oaicite:1]{index=1}
  if (!token) throw new Error("Token introuvable dans la réponse auth (champ Token)");
  return token;
}

function api(token) {
  return axios.create({
    baseURL: ADMIN_URL,
    timeout: 30000,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `token ${token}` // ✅ confirmé via Postman
    }
  });
}
function assertSiteDomain(siteDomain) {
  if (!siteDomain || typeof siteDomain !== "string") throw new Error("siteDomain requis");
  const s = siteDomain.trim().toLowerCase();
  if (!s.endsWith(".pressero.com")) throw new Error("siteDomain invalide");
  if (/[\/\s]/.test(s)) throw new Error("siteDomain invalide");
  return s;
}

function csvEscape(v) {
  const s = (v ?? "").toString();
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, headers) {
  const head = headers.join(",");
  const lines = rows.map(r => headers.map(h => csvEscape(r[h])).join(","));
  return [head, ...lines].join("\n");
}


// ✅ Resolve ProductId from UrlName (brochure-dist, etc.)
async function resolveProductId(client, siteDomain, urlName) {
  const r = await client.post(
    `/api/site/${siteDomain}/products`,
    [{ Column: "UrlName", Value: urlName, Operator: "isequalto" }],
    { params: { pageNumber: 0, pageSize: 1, includeDeleted: false } }
  );

  const item = r?.data?.Items?.[0];
  const productId = item?.ProductId;
  if (!productId) throw new Error("ProductId introuvable pour UrlName=" + urlName);
  return productId;
}



// --- utils ---
function norm(s) {
  return (s || "").toString().trim().toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[’']/g, "'")
    .replace(/[.,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function addrKey({ address, zip, city }) {
  return [norm(address), norm(zip), norm(city)].join("|");
}
function mergeDuplicates(list) {
  const map = new Map();
  for (const row of list || []) {
    const qty = parseInt(row.qty, 10) || 0;
    if (qty <= 0) continue;

    const key = addrKey(row);
    if (!key || key === "||") continue;

    if (!map.has(key)) map.set(key, { ...row, qty });
    else map.get(key).qty += qty;
  }
  return [...map.values()];
}


// --- basic ---
app.get("/health", (req,res)=> res.json({ ok:true }));

// --- Pressero helpers (selon ton doc) :contentReference[oaicite:2]{index=2}
async function getUserId(client, siteDomain, email) {
  const r = await client.get(`/api/site/${siteDomain}/users`, { params: { email } });
  const userId = r?.data?.Items?.[0]?.UserId;
  if (!userId) throw new Error("UserId introuvable pour cet email");
  return userId;
}

async function getCartId(client, siteDomain, userId) {
  const r = await client.get(`/api/cart/${siteDomain}/`, { params: { userId } });
  const cartId = r?.data?.Id;
  if (!cartId) throw new Error("CartId introuvable");
  return cartId;
}

async function getAddressBook(client, siteDomain, userId) {
  const r = await client.get(`/api/site/${siteDomain}/Addressbook/${userId}`);
  return r.data;
}

async function createAddress(client, siteDomain, userId, addr, template) {
  const payload = {
    Business: addr.Business || template?.Business || "Distribution",
    FirstName: template?.FirstName || "Client",
    LastName: template?.LastName || "Distribution",
    Title: addr.Title || template?.Title || undefined,
    Address1: addr.Address1,
    Address2: addr.Address2 || undefined,
    Address3: addr.Address3 || undefined,
    City: addr.City,
    StateProvince: addr.StateProvince || template?.StateProvince || "NA",
    Postal: addr.Postal,
    Country: (addr.Country || template?.Country || "FR").toUpperCase(),
    Phone: addr.Phone || template?.Phone || "",
    Email: addr.Email || template?.Email || ""
  };

  await client.post(`/api/site/${siteDomain}/Addressbook/${userId}/`, payload);

  // re-fetch & re-match
  const ab2 = await getAddressBook(client, siteDomain, userId);
  const key = `${norm(payload.Address1)}|${norm(payload.Postal)}|${norm(payload.City)}|${norm(payload.Business)}`;

  const all = [
    ab2?.PreferredAddress,
    ...(ab2?.Addresses || [])
  ].filter(Boolean);

  const found = all.find(a => {
    const k = `${norm(a?.Address1)}|${norm(a?.Postal)}|${norm(a?.City)}|${norm(a?.Business)}`;
    return k === key;
  });

  return found?.AddressId || null;
}



// 1) Validate addresses: existe ? sinon créer -> retourner addressId
app.post("/validate-addresses", async (req, res) => {
  try {
    const { userEmail, distributionList } = req.body || {};
    if (!userEmail) return res.status(400).json({ error: "userEmail requis" });

    const list = mergeDuplicates(distributionList);
    if (!list.length) return res.status(400).json({ error: "distributionList vide" });

    const token = await authenticate();
    const client = api(token);

    const userId = await getUserId(client, sd, userEmail);
    const ab = await getAddressBook(client, userId);

    const preferred = ab?.PreferredAddress;
    const addresses = ab?.Addresses || [];

    const existingMap = new Map();
    for (const a of addresses) {
      const key = addrKey({ address: a?.Address1, zip: a?.Postal, city: a?.City });
      if (key && a?.AddressId) existingMap.set(key, a.AddressId);
    }

    const validated = [];
    for (const row of list) {
      const key = addrKey(row);
      let addressId = existingMap.get(key) || null;

      if (!addressId) {
        addressId = await createAddress(client, userId, row, preferred);
      }
      if (!addressId) throw new Error(`Impossible de créer/trouver l'adresse: ${row.address} ${row.zip} ${row.city}`);

      validated.push({ ...row, addressId });
    }

    res.json({ ok: true, userId, validated });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Erreur" });
  }
});
app.post("/addressbook/list", async (req, res) => {
  try {
    const { userEmail, siteDomain } = req.body || {};
    if (!userEmail) return res.status(400).json({ error: "userEmail requis" });

    const sd = assertSiteDomain(siteDomain);

    const token = await authenticate();
    const client = api(token);

    const userId = await getUserId(client, sd, userEmail); // si ton getUserId n'a pas sd, laisse tel quel
    const r = await client.get(`/api/site/${sd}/Addressbook/${userId}`);

    const preferred = r?.data?.PreferredAddress || null;
    const addresses = r?.data?.Addresses || [];

    res.json({ ok: true, preferred, addresses });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Erreur" });
  }
});
app.post("/addressbook/import", async (req, res) => {
  try {
    const { userEmail, siteDomain, newAddresses } = req.body || {};
    if (!userEmail) return res.status(400).json({ error: "userEmail requis" });
    if (!Array.isArray(newAddresses) || !newAddresses.length) {
      return res.status(400).json({ error: "newAddresses requis" });
    }

    const sd = assertSiteDomain(siteDomain);
    const token = await authenticate();
    const client = api(token);

    const userId = await getUserId(client, sd, userEmail);

    // Load existing addressbook to dedupe
    const ab = await client.get(`/api/site/${sd}/Addressbook/${userId}`);
    const existing = [
      ab?.data?.PreferredAddress,
      ...(ab?.data?.Addresses || [])
    ].filter(Boolean);

    const keyOf = (a) =>
      `${(a.Address1||"").trim().toLowerCase()}|${(a.Postal||"").trim().toLowerCase()}|${(a.City||"").trim().toLowerCase()}|${(a.Business||"").trim().toLowerCase()}`;

    const existingKeys = new Set(existing.map(keyOf));

    const created = [];
    const skippedDuplicates = [];

    for (const a of newAddresses) {
      const addr = {
        Business: (a.Business || "").trim(),
        FirstName: (a.FirstName || "").trim() || undefined,
        LastName: (a.LastName || "").trim() || undefined,
        Title: (a.Title || "").trim() || undefined,
        Address1: (a.Address1 || "").trim(),
        Address2: (a.Address2 || "").trim() || undefined,
        Address3: (a.Address3 || "").trim() || undefined,
        City: (a.City || "").trim(),
        StateProvince: (a.StateProvince || "").trim() || "NA",
        Postal: (a.Postal || "").trim(),
        Country: (a.Country || "FR").trim().toUpperCase(),
        Phone: (a.Phone || "").trim() || undefined,
        Email: (a.Email || "").trim() || undefined
      };

      if (!addr.Address1 || !addr.City || !addr.Postal || !addr.Country || !addr.Business) {
        skippedDuplicates.push({ reason: "missing_required_fields", addr });
        continue;
      }

      const k = keyOf(addr);
      if (existingKeys.has(k)) {
        skippedDuplicates.push({ reason: "duplicate", addr });
        continue;
      }

      const r = await client.post(`/api/site/${sd}/Addressbook/${userId}/`, addr);
      created.push({ addr, result: r?.data });
      existingKeys.add(k);
    }

    res.json({ ok: true, createdCount: created.length, created, skippedDuplicates });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Erreur" });
  }
});
app.get("/addressbook/export.csv", async (req, res) => {
  try {
    const { userEmail, siteDomain } = req.query || {};
    if (!userEmail) return res.status(400).send("userEmail requis");
    const sd = assertSiteDomain(siteDomain);

    const token = await authenticate();
    const client = api(token);

    const userId = await getUserId(client, sd, userEmail);

    const r = await client.get(`/api/site/${sd}/Addressbook/${userId}`);
    const preferred = r?.data?.PreferredAddress ? [{ ...r.data.PreferredAddress, IsPreferred: true }] : [];
    const addresses = (r?.data?.Addresses || []).map(a => ({ ...a, IsPreferred: false }));

    const rows = [...preferred, ...addresses].map(a => ({
      AddressId: a.AddressId || "",
      Business: a.Business || "",
      FirstName: a.FirstName || "",
      LastName: a.LastName || "",
      Title: a.Title || "",
      Address1: a.Address1 || "",
      Address2: a.Address2 || "",
      Address3: a.Address3 || "",
      City: a.City || "",
      StateProvince: a.StateProvince || "",
      Postal: a.Postal || "",
      Country: a.Country || "",
      Phone: a.Phone || "",
      Email: a.Email || "",
      IsPreferred: a.IsPreferred ? "true" : "false",
      Qty: "" // colonne vide pour que l'utilisateur puisse remplir
    }));

    const headers = ["AddressId","Business","FirstName","LastName","Title","Address1","Address2","Address3","City","StateProvince","Postal","Country","Phone","Email","IsPreferred","Qty"];
    const csv = toCsv(rows, headers);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="addressbook.csv"');
    res.send(csv);
  } catch (e) {
    console.error(e);
    res.status(500).send(e.message || "Erreur");
  }
});


// 2) Add to cart: 1 adresse = 1 item
app.post("/add-to-cart-distribution", async (req, res) => {
  try {
    const {
      userEmail,
      siteDomain,
      urlName,
      shippingMethod,
      pricingOptions,
      otherQuantities,
      lines
    } = req.body || {};

    if (!userEmail || !siteDomain || !urlName || !shippingMethod)
      return res.status(400).json({ error: "userEmail, siteDomain, urlName, shippingMethod requis" });

    if (!Array.isArray(pricingOptions) || !pricingOptions.length)
      return res.status(400).json({ error: "pricingOptions manquant" });

    if (!Array.isArray(lines) || !lines.length)
      return res.status(400).json({ error: "lines manquant" });

    const sd = assertSiteDomain(siteDomain);
    const oq = Array.isArray(otherQuantities) ? otherQuantities : [];

    const token = await authenticate();
    const client = api(token);

    const userId = await getUserId(client, sd, userEmail);
    const cartId = await getCartId(client, sd, userId);
    const productId = await resolveProductId(client, sd, urlName);

    const results = [];

    for (const row of lines) {
      const qty = parseInt(row.qty, 10) || 0;
      if (!qty) continue;

      const quantities = [qty, ...oq];

      const payload = {
        ProductId: productId,
        ShipTo: row.addressId,
        ShippingMethod: shippingMethod,
        PricingParameters: { Quantities: quantities, Options: pricingOptions },
        ItemName: "Distribution",
        Notes: row.label || ""
      };

      try {
        const r = await client.post(
          `/api/cart/${sd}/${cartId}/item/`,
          payload,
          { params: { userId } }
        );
        results.push({ addressId: row.addressId, qty, status: r.status, ok: true });
      } catch (err) {
        const status = err?.response?.status;
        const msg = err?.response?.data?.Message || err?.response?.data?.message || err?.message;

        if (status === 400 && msg === "ReOrderFullSuccess_PriceWarning") {
          results.push({ addressId: row.addressId, qty, status, ok: true, warning: msg });
          continue;
        }
        throw err;
      }
    }

    const added = results.filter(r => r.ok).length;
    const warnings = results.filter(r => r.warning).length;

    res.json({ ok: true, cartId, added, warnings, results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});



const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`cart-orchestrator listening on :${port}`));
