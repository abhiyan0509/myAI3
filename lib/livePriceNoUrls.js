// lib/livePriceNoUrls.js
// Runtime Exa search for live price when Pinecone has no source_url.
// Requirements: set EXA_API_KEY, EXA_ENDPOINT in Vercel.
// Optional: SCRAPER_BASE_URL if you want to try scraper fallback (not required).

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const EXA_ENDPOINT = process.env.EXA_ENDPOINT || "https://api.exa.example/search"; // <-- replace with real
const EXA_API_KEY = process.env.EXA_API_KEY;
const SCRAPER_BASE = process.env.SCRAPER_BASE_URL || null; // optional fallback

// Simple in-memory cache: { key: { ts: Date, value: ... } }
const cache = new Map();

// Utility: short unique cache key for model + query
function makeCacheKey(brand, model, ref) {
  return `${(brand||"").toLowerCase().trim()}|${(model||"").toLowerCase().trim()}|${(ref||"").toLowerCase().trim()}`;
}

function parsePriceFromText(text) {
  if (!text) return null;
  // Basic heuristic: find currency symbol or code + digits
  const m = text.match(/(USD|EUR|GBP|CHF|INR|\$|€|£|₹)\s?([0-9\.,]{2,})/i);
  if (!m) return null;
  const currency = m[1];
  const rawNum = m[2].replace(/\s+/g, "");
  const numeric = parseFloat(rawNum.replace(/,/g, ""));
  if (Number.isNaN(numeric)) return { raw: m[0], currency };
  return { value: numeric, currency, raw: m[0] };
}

/**
 * Query Exa by search string. Exa request/response shape varies by provider.
 * This function uses a generic POST body: { action: "search", query }
 * Adapt this to match your Exa API.
 */
async function callExaSearch(query) {
  if (!EXA_API_KEY) throw new Error("EXA_API_KEY not configured");
  const body = {
    action: "search",
    query,
    top_k: 5,
    // include extra options if Exa supports (filters, cache, recency)
  };

  const resp = await fetch(EXA_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${EXA_API_KEY}`,
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

/**
 * Try to extract a price candidate from Exa response.
 * This is intentionally conservative: prefer explicit price fields, then snippets.
 */
function extractCandidateFromExaResponse(data) {
  if (!data) return null;

  // 1) If Exa gives 'price' field at top level
  if (data.price && (data.price.value || data.price.raw)) {
    return {
      value: data.price.value || null,
      currency: data.price.currency || null,
      raw: data.price.raw || null,
      source: data.source || null,
    };
  }

  // 2) If Exa returns an array of results
  if (Array.isArray(data.results) && data.results.length) {
    for (const r of data.results) {
      // prefer explicit structured price
      if (r.price && (r.price.value || r.price.raw)) {
        return {
          value: r.price.value || null,
          currency: r.price.currency || null,
          raw: r.price.raw || null,
          source: r.url || r.source || null,
        };
      }
      // try parse from snippet/title
      const text = [r.title || "", r.snippet || "", r.summary || ""].join(" ");
      const parsed = parsePriceFromText(text);
      if (parsed) {
        return { ...parsed, source: r.url || r.source || null };
      }
    }
  }

  // 3) If Exa returned raw text
  if (data.text) {
    const parsed = parsePriceFromText(data.text);
    if (parsed) return { ...parsed, source: data.source || null };
  }

  return null;
}

/**
 * Top-level function to get live price without using Pinecone URLs.
 * - brand, model, reference: used to compose the search query (required at least brand+model)
 * - options: { useScraperFallback: boolean } (optional)
 */
export async function getLivePriceNoUrl({ brand, model, reference_number, options = {} }) {
  const key = makeCacheKey(brand, model, reference_number);
  const now = Date.now();

  // 1) Return cached result if fresh
  const cached = cache.get(key);
  if (cached && (now - cached.ts) < CACHE_TTL_MS) {
    return { ...cached.value, cached: true };
  }

  // 2) Build a search query
  const refPart = reference_number ? ` ${reference_number}` : "";
  const query = `${brand} ${model}${refPart} price Chrono24 Jomashop Bob's Watches`;
  // you can include watch marketplaces in query to bias results

  // 3) Call Exa
  try {
    const data = await callExaSearch(query);
    const candidate = extractCandidateFromExaResponse(data);
    if (candidate) {
      const out = {
        value: candidate.value || null,
        currency: candidate.currency || null,
        raw: candidate.raw || null,
        source: candidate.source || "exa-search",
        ts: new Date().toISOString(),
      };
      cache.set(key, { ts: now, value: out });
      return out;
    }
  } catch (e) {
    // log server-side (Vercel) console for debugging
    console.warn("Exa search failed:", e.message || e);
  }

  // 4) Optional: fallback to scraper microservice if you have it and allowed
  if (options.useScraperFallback && SCRAPER_BASE) {
    try {
      // We don't have a product URL, but some scrapers support site search endpoints — if your scraper does, call it here.
      // Otherwise, skip scraper fallback since it needs a URL. This block is a placeholder.
      const sResp = await fetch(`${SCRAPER_BASE}/v1/search-price`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.SCRAPER_API_KEY || "" },
        body: JSON.stringify({ query }),
      });
      if (sResp.ok) {
        const js = await sResp.json();
        const parsed = js?.price ? { value: js.price, currency: js.currency, raw: js.raw_price_text } : null;
        if (parsed) {
          const out = { ...parsed, source: js.source || "scraper-fallback", ts: new Date().toISOString() };
          cache.set(key, { ts: now, value: out });
          return out;
        }
      }
    } catch (e) {
      console.warn("Scraper fallback error:", e.message || e);
    }
  }

  // 5) Return null if nothing found
  return null;
}
