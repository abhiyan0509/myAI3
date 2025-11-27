// lib/livePriceNoUrls.js
// Runtime Exa search for live price when Pinecone has no source_url.
// Requirements: set EXA_API_KEY, EXA_ENDPOINT in Vercel.

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const EXA_ENDPOINT = process.env.EXA_ENDPOINT || "https://api.exa.ai/search";
const EXA_API_KEY = process.env.EXA_API_KEY;

const cache = new Map();

function makeCacheKey(brand, model, ref) {
  return `${(brand||"").toLowerCase().trim()}|${(model||"").toLowerCase().trim()}|${(ref||"").toLowerCase().trim()}`;
}

function parsePriceFromText(text) {
  if (!text) return null;
  // look for currency symbol or code + digits
  const m = text.match(/(USD|EUR|GBP|CHF|INR|\$|€|£|₹)\s?([0-9\.,]{2,})/i);
  if (!m) return null;
  const currency = m[1];
  const rawNum = m[2].replace(/\s+/g, "");
  const numeric = parseFloat(rawNum.replace(/,/g, ""));
  if (Number.isNaN(numeric)) return { raw: m[0], currency };
  return { value: numeric, currency, raw: m[0] };
}

async function callExaSearch(query) {
  if (!EXA_API_KEY) throw new Error("EXA_API_KEY not configured");
  const body = {
    q: query,
    top_k: 5
  };

  const resp = await fetch(EXA_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${EXA_API_KEY}`
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Exa error ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  return data;
}

function extractCandidateFromExaResponse(data) {
  if (!data) return null;

  // 1) explicit price field (if Exa provides one)
  if (data.price && (data.price.value || data.price.raw)) {
    return {
      value: data.price.value || null,
      currency: data.price.currency || null,
      raw: data.price.raw || null,
      source: data.source || null
    };
  }

  // 2) results array
  if (Array.isArray(data.results) && data.results.length) {
    for (const r of data.results) {
      if (r.price && (r.price.value || r.price.raw)) {
        return {
          value: r.price.value || null,
          currency: r.price.currency || null,
          raw: r.price.raw || null,
          source: r.url || r.source || null
        };
      }
      const text = [r.title || "", r.snippet || "", r.summary || ""].join(" ");
      const parsed = parsePriceFromText(text);
      if (parsed) {
        return { ...parsed, source: r.url || r.source || null };
      }
    }
  }

  // 3) raw text
  if (data.text) {
    const parsed = parsePriceFromText(data.text);
    if (parsed) return { ...parsed, source: data.source || null };
  }

  return null;
}

/**
 * Top-level function to get live price without using Pinecone URLs.
 * - brand, model, reference_number: used to compose the search query
 */
export async function getLivePriceNoUrl({ brand, model, reference_number }) {
  const key = makeCacheKey(brand, model, reference_number);
  const now = Date.now();

  const cached = cache.get(key);
  if (cached && (now - cached.ts) < CACHE_TTL_MS) {
    return { ...cached.value, cached: true };
  }

  const refPart = reference_number ? ` ${reference_number}` : "";
  const query = `${brand} ${model}${refPart} price Chrono24 Jomashop "price"`;

  try {
    const data = await callExaSearch(query);
    const candidate = extractCandidateFromExaResponse(data);
    if (candidate) {
      const out = {
        value: candidate.value || null,
        currency: candidate.currency || null,
        raw: candidate.raw || null,
        source: candidate.source || "exa-search",
        ts: new Date().toISOString()
      };
      cache.set(key, { ts: now, value: out });
      return out;
    }
  } catch (e) {
    console.warn("Exa search failed:", e.message || e);
  }

  return null;
}

// CommonJS compatibility if your project uses require()
module.exports = { getLivePriceNoUrl };
