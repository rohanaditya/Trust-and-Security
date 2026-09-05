import { createClient } from '@supabase/supabase-js';

// Server-side only client — uses the service role key so it can bypass RLS.
// NEVER import this into a client component.
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);
