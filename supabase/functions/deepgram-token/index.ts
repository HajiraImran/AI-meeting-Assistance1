// Hands the app a short-lived Deepgram token (30s TTL) so it can open the
// transcription websocket directly. Your real Deepgram key never leaves here.
//
// IMPORTANT: the DEEPGRAM_API_KEY must have "Member" permission or higher,
// or Deepgram rejects the token grant. Create the key in the Deepgram Console:
// API Keys -> Create Key -> Advanced -> Permissions: Member.
//
// Deploy:  supabase functions deploy deepgram-token
// Secret:  supabase secrets set DEEPGRAM_API_KEY=your_member_key_here

const DEEPGRAM_KEY = Deno.env.get("DEEPGRAM_API_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: {
        Authorization: `Token ${DEEPGRAM_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl_seconds: 30 }),
    });

    const text = await res.text();

    // Surface Deepgram's actual error so the app can show what's wrong.
    if (!res.ok) {
      return json({ error: `Deepgram ${res.status}: ${text}` });
    }

    return json(JSON.parse(text)); // { access_token, expires_in }
  } catch (err) {
    return json({ error: String(err) });
  }
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
