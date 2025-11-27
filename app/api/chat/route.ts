// app/api/chat/route.ts
import { NextResponse } from "next/server";

/**
 * Chat API route (App Router)
 * - computes embeddings with OpenAI
 * - queries Pinecone vector index (REST)
 * - if the user asks for price, calls lib/livePriceNoUrls.getLivePriceNoUrl
 *
 * Required ENV in Vercel:
 * OPENAI_API_KEY, PINECONE_API_KEY, PINECONE_ENVIRONMENT (or PINECONE_ENV),
 * PINECONE_INDEX (optional, default "my-ai"), EXA_API_KEY & EXA_ENDPOINT if using Exa
 */

// --- Environment variables (required) ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_ENV = process.env.PINECONE_ENVIRONMENT || process.env.PINECONE_ENV || "us-west1-gcp";
const PINECONE_INDEX = process.env.PINECONE_INDEX || "my-ai";

// Early checks: fail fast with helpful message if required env missing
if (!OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY not set in environment");
}
if (!PINECONE_API_KEY) {
  throw new Error("PINECONE_API_KEY not set in environment");
}

/** Create OpenAI embedding for text (text-embedding-3-small) */
async function getEmbedding(text: string) {
  const openaiUrl = "https://api.openai.com/v1/embeddings";

  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${String(OPENAI_API_KEY)}`);

  const res = await fetch(openaiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      input: text,
      model: "text-embedding-3-small",
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`OpenAI embedding error: ${res.status} ${txt}`);
  }

  const j = await res.json();
  if (!j?.data?.[0]?.embedding) throw new Error("OpenAI returned no embedding");
  return j.data[0].embedding;
}

/** Query Pinecone vector index via REST */
async function queryPineconeVector(embedding: number[] | Float32Array, topK = 3) {
  const url = `https://${PINECONE_INDEX}-${PINECONE_ENV}.svc.pinecone.io/vectors/query`;

  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("Api-Key", String(PINECONE_API_KEY));

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      vector: embedding,
      topK,
      includeMetadata: true,
      includeValues: false,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Pinecone query error: ${resp.status} ${txt}`);
  }

  return resp.json();
}

/** Extract top metadata in a stable shape */
function extractTopMetadata(pineconeResponse: any) {
  const matches = (pineconeResponse && pineconeResponse.matches) || [];
  if (!matches || !matches.length) return null;
  const top = matches[0];
  const metadata = top.metadata || {};
  return {
    id: top.id || metadata.id || null,
    score: top.score ?? null,
    brand: metadata.brand || "",
    model_name: metadata.model_name || "",
    reference_number: metadata.reference_number || "",
    description: metadata.description || "",
    category: metadata.category || "",
    movement: metadata.movement || "",
    caliber: metadata.caliber || "",
  };
}

/** POST handler */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const question: string = body?.question?.toString() || "";

    if (!question || !question.trim()) {
      return NextResponse.json({ error: "question required" }, { status: 400 });
    }

    // 1) Compute embedding (OpenAI)
    const embedding: any = await getEmbedding(question);

    // 2) Query Pinecone
    const pcResp = await queryPineconeVector(embedding as any, 3);
    const meta = extractTopMetadata(pcResp);

    if (!meta) {
      return NextResponse.json({
        answer: "I couldn't find a matching model in the catalog. Try asking about a specific brand/model.",
      });
    }

    // 3) Detect price intent
    const needsPrice = /price|cost|market|listing|resale|sell|how much|current price|value/i.test(question);

    if (needsPrice) {
      // dynamic import of helper so it works for CommonJS or ESM exports
      let getLivePriceNoUrl: any = null;
      try {
        // explicit .js can help some bundlers; adjust only if your lib file location differs
        const liveLib = await import("../../../lib/livePriceNoUrls");
        getLivePriceNoUrl = liveLib.getLivePriceNoUrl || liveLib.default || liveLib["getLivePriceNoUrl"];
      } catch (err) {
        console.warn("Could not import livePriceNoUrls helper:", err);
      }

      if (!getLivePriceNoUrl || typeof getLivePriceNoUrl !== "function") {
        console.warn("getLivePriceNoUrl not available; returning catalog info");
        return NextResponse.json({
          answer: `Live price lookup is not available. Here's catalog info:\n\n${meta.brand} ${meta.model_name} (${meta.reference_number})\n${meta.description}`,
          metadata: meta,
        });
      }

      // call helper
      const live = await getLivePriceNoUrl({
        brand: meta.brand || "",
        model: meta.model_name || "",
        reference_number: meta.reference_number || "",
      });

      if (live) {
        return NextResponse.json({
          answer: `Live listing: ${live.currency || ""} ${live.value} — source: ${live.source || "web search"} (as of ${live.ts}).`,
          provenance: [{ source: live.source || "exa", raw: live.raw || "" }],
          metadata: meta,
        });
      } else {
        return NextResponse.json({
          answer: `I couldn't fetch a clear live listing price right now. Here's the catalog info I found:\n\n${meta.brand} ${meta.model_name} (${meta.reference_number})\n${meta.description}`,
          metadata: meta,
        });
      }
    }

    // 4) Non-price question: return the catalog description
    return NextResponse.json({
      answer: `${meta.brand} ${meta.model_name} (${meta.reference_number}):\n${meta.description}`,
      metadata: meta,
    });
  } catch (e: any) {
    console.error("app/api/chat/route error:", e);
    return NextResponse.json({ error: e?.message || "internal error" }, { status: 500 });
  }
}
