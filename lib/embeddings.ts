// Voyage AI embeddings — Anthropic's recommended embedding provider, has a free tier.
// Swap this out for OpenAI's text-embedding-3-small if you'd rather use that
// (just change the endpoint/body below — keep the 1536 dim or update schema.sql to match).

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';

export async function embed(texts: string[], inputType: 'document' | 'query'): Promise<number[][]> {
  const res = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: texts,
      model: 'voyage-3-lite', // fast + cheap, good enough for a hackathon corpus
      input_type: inputType,   // 'document' when embedding chunks, 'query' when embedding a question
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Voyage embedding request failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  return data.data.map((d: { embedding: number[] }) => d.embedding);
}

export async function embedOne(text: string, inputType: 'document' | 'query'): Promise<number[]> {
  const [vec] = await embed([text], inputType);
  return vec;
}
