// Voyage AI embeddings — Anthropic's recommended embedding provider, has a free tier.
// Swap this out for OpenAI's text-embedding-3-small if you'd rather use that
// (just change the endpoint/body below — keep the 512 dim or update schema.sql to match).

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const MAX_RETRIES = 5;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function embed(texts: string[], inputType: 'document' | 'query'): Promise<number[][]> {
  let attempt = 0;
  while (true) {
    const res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        input: texts,
        model: 'voyage-3-lite',
        input_type: inputType,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      return data.data.map((d: { embedding: number[] }) => d.embedding);
    }

    if (res.status === 429 && attempt < MAX_RETRIES) {
      attempt++;
      const retryAfterHeader = res.headers.get('retry-after');
      const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 21_000;
      console.warn(`  Rate limited by Voyage, waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${MAX_RETRIES})...`);
      await sleep(waitMs);
      continue;
    }

    const err = await res.text();
    throw new Error(`Voyage embedding request failed: ${res.status} ${err}`);
  }
}

export async function embedOne(text: string, inputType: 'document' | 'query'): Promise<number[]> {
  const [vec] = await embed([text], inputType);
  return vec;
}
