// app/api/chat/route.ts
import { NextResponse } from "next/server";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_ENV = process.env.PINECONE_ENVIRONMENT || process.env.PINECONE_ENV || "us-west1-gcp";
const PINECONE_INDEX = process.env.PINECONE_INDEX || "my-ai";

if (!OPENAI_API_KEY) console.warn("OPENAI_API_KEY not set");
if (!PINECONE_API_KEY) console.warn("PINECONE_API_KEY not set");

/** Helper: create OpenAI embedding for text */
async function getEmbedding(text: string) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      input: text,
      model: "text-embedding-3-small"
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI embedding error: ${res.status} ${txt}`);
  }
  const j = await res.json();
  return j.data[0].embedding;
}

/** Helper: query Pinecone vector index via REST */
async function queryPineconeVector(embedding: number[] | Float32Array, topK = 3) {
  const url = `https://${PINECONE_INDEX}-${PINECONE_ENV}.svc.pinecone.io/vectors/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": PINECONE_API_KEY
    },
    body: JSON.stringify({
      vector: embedding,
      topK,
      includeMetadata: true,
      includeValues: false
    })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Pinecone query error: ${res.status} ${txt}`);
  }
  return await res.json();
}

function extractTopMetadata(pineconeResponse: any) {
  const matches = (pineconeResponse && pineconeResponse.matches) || [];
  if (!matches.length) return null;
  const top = matches[0];
  const metadata = top.metadata || {};
  return {
    id: top.id || metadata.id || null,
    score: top.score || null,
    brand: metadata.brand || "",
    model_name: metadata.model_name || "",
    reference_number: metadata.reference_number || "",
    description: metadata.description || "",
    category: metadata.category || "",
    movement: metadata.movement || "",
    caliber: metadata.caliber || ""
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

    // 1) compute embedding
    const embedding = await getEmbedding(question);

    // 2) query pinecone
    const pcResp = await queryPineconeVector(embedding as any, 3);
    const meta = extractTopMetadata(pcResp);

    if (!meta) {
      return NextResponse.json({
        answer: "I couldn't find a matching model in the catalog. Try asking about a specific brand/model."
      });
    }

    // 3) price intent detection
    const needsPrice = /price|cost|market|listing|resale|sell|how much|current price|value/i.test(question);

    if (needsPrice) {
      // dynamic import of your lib helper so it works for either CJS or ESM exported file
      const liveLib = await import("../../../lib/livePriceNoUrls");
      // either named export or module.exports
      const getLivePriceNoUrl = liveLib.getLivePriceNoUrl || liveLib.default || liveLib.getLivePriceNoUrl;

      if (typeof getLivePriceNoUrl !== "function") {
        console.warn("getLivePriceNoUrl not found in lib/livePriceNoUrls");
      } else {
        const live = await getLivePriceNoUrl({
          brand: meta.brand || "",
          model: meta.model_name || "",
          reference_number: meta.reference_number || ""
        });

        if (live) {
          return NextResponse.json({
            answer: `Live listing: ${live.currency || ""} ${live.value} — source: ${live.source || "web search"} (as of ${live.ts}).`,
            provenance: [{ source: live.source || "exa", raw: live.raw || "" }],
            metadata: meta
          });
        } else {
          return NextResponse.json({
            answer: `I couldn't fetch a clear live listing price right now. Here's the catalog info I found:\n\n${meta.brand} ${meta.model_name} (${meta.reference_number})\n${meta.description}`,
            metadata: meta
          });
        }
      }
    }

    // 4) Non-price question -> return the catalog description
    return NextResponse.json({
      answer: `${meta.brand} ${meta.model_name} (${meta.reference_number}):\n${meta.description}`,
      metadata: meta
    });
  } catch (e: any) {
    console.error("app/api/chat/route error:", e);
    return NextResponse.json({ error: e?.message || "internal error" }, { status: 500 });
  }
}
