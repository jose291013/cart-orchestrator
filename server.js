// server.js (ESM)
import express from "express";
import axios from "axios";
import cors from "cors";
import ExcelJS from "exceljs";
import multer from "multer";
import Papa from "papaparse";

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "10mb" }));

/**
 * -------------------- CORS (simple et stable) --------------------
 * Autorise les pages Pressero (*.pressero.com). Pas de double système.
 */
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // server-to-server / Postman
    try {
      const u = new URL(origin);
      if (u.hostname.endsWith(".pressero.com")) return cb(null, true);
    } catch {}
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  credentials: false
}));
app.options("*", cors());

/**
 * -------------------- Upload --------------------
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB
});

/**
 * -------------------- ENV (on garde tes variables d'avant) --------------------
 * (NE change pas tes env Render si tu utilisais déjà celles-ci)
 */
const ADMIN_URL = process.env.PRESSERO_ADMIN_URL || "https://admin.ams.v6.pressero.com";

const AUTH_PAYLOAD = {
  UserName: process.env.PRESSERO_USERNAME,
  Password: process.env.PRESSERO_PASSWORD,
  SubscriberId: process.env.PRESSERO_SUBSCRIBER_ID,
  ConsumerID: process.env.PRESSERO_CONSUMER_ID
};

function assertEnv() {
  const missing = Object.entries(AUTH_PAYLOAD)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length) {
    throw new Error(`Missing ENV: ${missing.join(", ")}`);
  }
}

function assertSiteDomain(siteDomain) {
  if (!siteDomain || typeof siteDomain !== "string") throw new Error("siteDomain requis");
  const s = siteDomain.trim().toLowerCase();
  if (!s.endsWith(".pressero.com")) throw new Error("siteDomain invalide");
  if (/[\/\s]/.test(s)) throw new Error("siteDomain invalide");
  return s;
}

/**
 * -------------------- AUTH / API --------------------
 * On garde EXACTEMENT la méthode qui marchait chez toi.
 */
async function authenticate() {
  assertEnv();
  const r = await axios.post(`${ADMIN_URL}/api/V2/Authentication`, AUTH_PAYLOAD, {
    headers: { "Content-Type": "application/json" },
    timeout: 30000
  });

  const token = r?.data?.Token;
  if (!token) throw new Error("Token introuvable dans la réponse auth (champ Token)");
  return token;
}

function api(token) {
  return axios.create({
    baseURL: ADMIN_URL,
    timeout: 30000,
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "Authorization": `token ${token}`
    }
  });
}

/**
 * -------------------- Normalisation / signatures anti-doublons --------------------
 */
function norm(s) {
  return (s ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[’']/g, "'")
    .trim();
}

// signature "sans Business" : c'est la clé la plus sûre pour éviter les doublons
function sigNoBusiness(a) {
  return `${norm(a?.Address1)}|${norm(a?.Postal)}|${norm(a?.City)}|${norm(a?.Country || "")}`;
}

function pick(obj, keys) {
  if (!obj) return "";
  const lower = Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [String(k).toLowerCase().trim(), v])
  );
  for (const k of keys) {
    const v = lower[String(k).toLowerCase().trim()];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}

function normalizeImportedAddress(r) {
  const AddressId = String(pick(r, ["addressid", "AddressId", "id", "Id"]) || "").trim() || undefined;

  const addr = {
    AddressId,
    Business: String(pick(r, ["business", "société", "societe", "company"]) || "").trim(),
    FirstName: String(pick(r, ["firstname", "prénom", "prenom", "nombre"]) || "").trim(),
    LastName: String(pick(r, ["lastname", "nom", "apellido"]) || "").trim(),
    Title: String(pick(r, ["title", "titre", "cargo"]) || "").trim(),
    Address1: String(pick(r, ["address1", "adresse", "direccion", "dirección", "address"]) || "").trim(),
    Address2: String(pick(r, ["address2"]) || "").trim(),
    Address3: String(pick(r, ["address3"]) || "").trim(),
    City: String(pick(r, ["city", "ville", "ciudad"]) || "").trim(),
    StateProvince: String(pick(r, ["stateprovince", "state", "province", "région", "region"]) || "").trim() || "NA",
    Postal: String(pick(r, ["postal", "cp", "codepostal", "codigopostal", "zip"]) || "").trim(),
    Country: String(pick(r, ["country", "pays", "país", "pais"]) || "").trim() || "FR",
    Phone: String(pick(r, ["phone", "téléphone", "telephone", "telefono"]) || "").trim(),
    Email: String(pick(r, ["email", "mail"]) || "").trim()
  };

  // champs minimaux
  if (!addr.Address1 || !addr.City || !addr.Postal || !addr.Country) return null;

  // par défaut
  if (!addr.Business) addr.Business = "Distribution";

  return addr;
}

/**
 * -------------------- Parsers CSV/XLSX --------------------
 */
async function parseCsvBuffer(buf) {
  const text = buf.toString("utf8");
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  return (parsed.data || []).map(normalizeImportedAddress).filter(Boolean);
}

async function parseXlsxBuffer(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) return [];

  const headerRow = ws.getRow(1);
  const headers = headerRow.values.slice(1).map(h => String(h || "").trim());

  const rows = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = row.getCell(idx + 1).value;
    });
    const n = normalizeImportedAddress(obj);
    if (n) rows.push(n);
  });

  return rows;
}

/**
 * -------------------- Pressero helpers --------------------
 */
async function getUserId(client, siteDomain, email) {
  const r = await client.get(`/api/site/${siteDomain}/users/`, {
    params: { pageNumber: 0, pageSize: 1, email, includeDeleted: false }
  });
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

// Resolve ProductId from UrlName
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

  // Re-fetch pour retrouver l'AddressId exact
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

  if (addr.AddressId) {
    await client.put(
      `/api/site/${siteDomain}/Addressbook/${userId}/`,
      payload,
      { params: { addressId: addr.AddressId } }
    );
    return { mode: "updated", addressId: addr.AddressId };
  }

  const createdId = await createAddress(client, siteDomain, userId, payload, preferred);
  return { mode: "created", addressId: createdId };
}

/**
 * -------------------- CSV export helpers --------------------
 */
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

/**
 * -------------------- ROUTES --------------------
 */
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * Addressbook list
 */
app.post("/addressbook/list", async (req, res) => {
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

    // dédoublonnage par AddressId
    const map = new Map();
    for (const a of [preferred, ...addresses].filter(Boolean)) {
      const id = a?.AddressId;
      if (id && !map.has(id)) map.set(id, a);
    }

    return res.json({
      ok: true,
      preferredId: preferred?.AddressId || null,
      addresses: [...map.values()]
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || "Erreur" });
  }
});

/**
 * Import file (CSV/XLSX)
 * Objectif: update si AddressId, sinon CREATE,
 * MAIS: skip si (sans AddressId) l'adresse existe déjà dans l'addressbook (signature sans business)
 * + dédoublonnage interne du fichier
 */
app.post("/addressbook/import-file", upload.single("file"), async (req, res) => {
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
    else if (ext === "xlsx" || ext === "xls") addresses = await parseXlsxBuffer(f.buffer);
    else return res.status(400).json({ error: "Format non supporté (csv/xlsx)" });

    if (!addresses.length) {
      return res.status(400).json({ error: "Aucune ligne valide trouvée dans le fichier." });
    }

    const token = await authenticate();
    const client = api(token);
    const userId = await getUserId(client, sd, userEmail);

    // signatures existantes dans l'addressbook => SKIP des créations en doublon
    const abExisting = await getAddressBook(client, sd, userId);
    const existingAll = [abExisting?.PreferredAddress, ...(abExisting?.Addresses || [])].filter(Boolean);
    const existingSig = new Set(existingAll.map(sigNoBusiness));

    // dédoublonnage interne du fichier import
    const seen = new Set();
    const unique = [];
    for (const a of addresses) {
      const key = a.AddressId ? `id:${a.AddressId}` : `k:${sigNoBusiness(a)}`;
      if (seen.has(key)) continue;
      seen.add(key);
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
        // si pas d'AddressId, on SKIP si déjà existant (signature sans business)
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

        if (r.mode === "updated") {
          updatedCount++;
        } else {
          createdCount++;
          // important: dès qu'on crée, on ajoute la signature pour éviter doublons dans la même run
          existingSig.add(sigNoBusiness(addr));
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
    console.error(e);
    return res.status(500).json({ error: e.message || "Erreur import-file" });
  }
});

/**
 * Validate addresses for distribution list
 * - merge duplicates
 * - ensure each address exists in addressbook (create if missing)
 * - return addressId per line
 */
function mergeDuplicates(list) {
  if (!Array.isArray(list)) return [];
  const map = new Map();
  for (const r of list) {
    const address = (r?.address || r?.Address1 || "").toString().trim();
    const zip = (r?.zip || r?.Postal || "").toString().trim();
    const city = (r?.city || r?.City || "").toString().trim();
    const country = (r?.country || r?.Country || "FR").toString().trim().toUpperCase();
    const qty = Number(r?.qty || r?.quantity || 0) || 0;
    if (!address || !zip || !city || qty <= 0) continue;

    const key = `${norm(address)}|${norm(zip)}|${norm(city)}|${norm(country)}`;
    const prev = map.get(key) || { address, zip, city, country, qty: 0 };
    prev.qty += qty;
    map.set(key, prev);
  }
  return [...map.values()];
}

app.post("/validate-addresses", async (req, res) => {
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

    const existingAll = [ab?.PreferredAddress, ...(ab?.Addresses || [])].filter(Boolean);
    const existingSigToId = new Map();
    for (const a of existingAll) {
      if (a?.AddressId) existingSigToId.set(sigNoBusiness(a), a.AddressId);
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
    console.error(e);
    return res.status(500).json({ error: e.message || "Erreur" });
  }
});

/**
 * Export CSV
 */
app.get("/addressbook/export.csv", async (req, res) => {
  try {
    const { userEmail, siteDomain } = req.query || {};
    if (!userEmail) return res.status(400).send("userEmail requis");

    const sd = assertSiteDomain(siteDomain);

    const token = await authenticate();
    const client = api(token);

    const userId = await getUserId(client, sd, userEmail);
    const ab = await getAddressBook(client, sd, userId);

    const preferred = ab?.PreferredAddress ? [{ ...ab.PreferredAddress, IsPreferred: true }] : [];
    const addresses = (ab?.Addresses || []).map(a => ({ ...a, IsPreferred: false }));

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
      Qty: ""
    }));

    const headers = [
      "AddressId","Business","FirstName","LastName","Title",
      "Address1","Address2","Address3","City","StateProvince",
      "Postal","Country","Phone","Email","IsPreferred","Qty"
    ];

    const csv = toCsv(rows, headers);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="addressbook.csv"');
    return res.send(csv);
  } catch (e) {
    console.error(e);
    return res.status(500).send(e.message || "Erreur");
  }
});

/**
 * Export XLSX (ExcelJS) — on garde comme avant (fonctionnel)
 */
app.get("/addressbook/export.xlsx", async (req, res) => {
  try {
    const { userEmail, siteDomain } = req.query || {};
    if (!userEmail) return res.status(400).send("userEmail requis");
    const sd = assertSiteDomain(siteDomain);

    const token = await authenticate();
    const client = api(token);

    const userId = await getUserId(client, sd, userEmail);
    const ab = await getAddressBook(client, sd, userId);

    const preferred = ab?.PreferredAddress
      ? [{ ...ab.PreferredAddress, IsPreferred: true }]
      : [];
    const addresses = (ab?.Addresses || []).map(a => ({ ...a, IsPreferred: false }));

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
      Qty: ""
    }));

    const wb = new ExcelJS.Workbook();
    wb.creator = "cart-orchestrator";
    wb.created = new Date();

    const ws = wb.addWorksheet("Addressbook", {
      views: [{ state: "frozen", ySplit: 1 }]
    });

    ws.columns = [
      { header: "AddressId", key: "AddressId", width: 36 },
      { header: "Business", key: "Business", width: 24 },
      { header: "FirstName", key: "FirstName", width: 16 },
      { header: "LastName", key: "LastName", width: 16 },
      { header: "Title", key: "Title", width: 16 },
      { header: "Address1", key: "Address1", width: 34 },
      { header: "Address2", key: "Address2", width: 22 },
      { header: "Address3", key: "Address3", width: 22 },
      { header: "City", key: "City", width: 18 },
      { header: "StateProvince", key: "StateProvince", width: 18 },
      { header: "Postal", key: "Postal", width: 12 },
      { header: "Country", key: "Country", width: 10 },
      { header: "Phone", key: "Phone", width: 18 },
      { header: "Email", key: "Email", width: 26 },
      { header: "IsPreferred", key: "IsPreferred", width: 12 },
      { header: "Qty", key: "Qty", width: 10 }
    ];

    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: "middle" };
    ws.getRow(1).height = 18;

    ws.addRows(rows);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="addressbook.xlsx"');

    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error(e);
    return res.status(500).send(e.message || "Erreur");
  }
});

/**
 * Add to cart distribution (1 adresse = 1 item)
 */
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

    return res.json({ ok: true, cartId, added, warnings, results });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`cart-orchestrator listening on :${port}`));
