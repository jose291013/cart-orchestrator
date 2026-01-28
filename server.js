import express from "express";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "5mb" }));

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

// ✅ Resolve ProductId from UrlName (brochure-dist, etc.)
async function resolveProductId(client, urlName) {
  const r = await client.post(
    `/api/site/${SITE_DOMAIN}/products`,
    [
      {
        Column: "UrlName",
        Value: urlName,
        Operator: "isequalto"
      }
    ],
    {
      params: {
        pageNumber: 0,
        pageSize: 1,
        includeDeleted: false
      }
    }
  );

  const item = r?.data?.Items?.[0];
  const productId = item?.ProductId;

  if (!productId) {
    throw new Error("ProductId introuvable pour UrlName=" + urlName);
  }

  console.log("✅ ProductId résolu :", productId);
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
async function getUserId(client, email) {
  const r = await client.get(`/api/site/${SITE_DOMAIN}/users`, { params: { email }});
  const userId = r?.data?.Items?.[0]?.UserId;
  if (!userId) throw new Error("UserId introuvable pour cet email");
  return userId;
}

async function getCartId(client, userId) {
  const r = await client.get(`/api/cart/${SITE_DOMAIN}/`, { params: { userId }});
  const cartId = r?.data?.Id;
  if (!cartId) throw new Error("CartId introuvable");
  return cartId;
}

async function getAddressBook(client, userId) {
  const r = await client.get(`/api/site/${SITE_DOMAIN}/Addressbook/${userId}`);
  return r.data;
}

async function createAddress(client, userId, row, template) {
  const payload = {
    FirstName: template?.FirstName || "Client",
    LastName: template?.LastName || "Distribution",
    Address1: row.address,
    City: row.city,
    Postal: row.zip,
    Country: template?.Country || "FR",
    Phone: template?.Phone || "",
    Email: template?.Email || ""
  };

  await client.post(`/api/site/${SITE_DOMAIN}/Addressbook/${userId}`, payload);

  // On rematch après création (robuste)
  const ab2 = await getAddressBook(client, userId);
  const key = addrKey(row);
  const found = (ab2?.Addresses || []).find(a => addrKey({
    address: a?.Address1,
    zip: a?.Postal,
    city: a?.City
  }) === key);

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

    const userId = await getUserId(client, userEmail);
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

// 2) Add to cart: 1 adresse = 1 item
app.post("/add-to-cart-distribution", async (req, res) => {
  try {
    const {
      userEmail,
      urlName,              // ✅ au lieu de productId
      shippingMethod,
      pricingOptions,
      validatedList
    } = req.body || {};

    if (!userEmail || !urlName || !shippingMethod)
      return res.status(400).json({ error: "userEmail, urlName, shippingMethod requis" });

    if (!Array.isArray(pricingOptions) || !pricingOptions.length)
      return res.status(400).json({ error: "pricingOptions manquant" });

    if (!Array.isArray(validatedList) || !validatedList.length)
      return res.status(400).json({ error: "validatedList manquant" });

    // ✅ Auth
    const token = await authenticate();
    const client = api(token);

    // ✅ UserId + CartId
    const userId = await getUserId(client, userEmail);
    const cartId = await getCartId(client, userId);

    // ✅ Resolve productId automatiquement
    const productId = await resolveProductId(client, urlName);

    const results = [];

    // ✅ Boucle : 1 adresse = 1 ligne panier
    for (const row of validatedList) {
      const qty = parseInt(row.qty, 10) || 0;
      if (!qty) continue;

      const payload = {
        ProductId: productId,
        ShipTo: row.addressId,
        ShippingMethod: shippingMethod,
        PricingParameters: {
          Quantities: [qty, 1],
          Options: pricingOptions
        },
        ItemName: "Distribution",
        Notes: `${row.address} | ${row.zip} | ${row.city}`
      };

      const r = await client.post(
        `/api/cart/${SITE_DOMAIN}/${cartId}/item/`,
        payload,
        { params: { userId } }
      );

      results.push({
        addressId: row.addressId,
        qty,
        status: r.status
      });
    }

    res.json({
      ok: true,
      cartId,
      added: results.length,
      results
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});


const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`cart-orchestrator listening on :${port}`));
