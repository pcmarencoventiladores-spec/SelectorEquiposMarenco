// Función de borde que reenvía a la API de Anthropic.
// Aquí vive la clave: el navegador nunca la ve.
//
// Desplegar:
//   supabase functions deploy asistente --no-verify-jwt
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//   supabase secrets set ORIGEN_PERMITIDO=https://USUARIO.github.io
//
// La URL resultante es la que va en VITE_IA_ENDPOINT:
//   https://rsbjmunbljolbhhsdusk.supabase.co/functions/v1/asistente

const ORIGEN = Deno.env.get("ORIGEN_PERMITIDO") ?? "*";

const cabeceras = {
  "Access-Control-Allow-Origin": ORIGEN,
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cabeceras });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Solo POST" }), { status: 405, headers: cabeceras });
  }

  try {
    const { system, mensaje } = await req.json();
    if (typeof mensaje !== "string" || !mensaje.trim()) {
      return new Response(JSON.stringify({ error: "Falta el mensaje" }), { status: 400, headers: cabeceras });
    }
    // Tope defensivo: sin él, una petición enorme se traduce en factura.
    if (mensaje.length > 8000) {
      return new Response(JSON.stringify({ error: "Mensaje demasiado largo" }), { status: 413, headers: cabeceras });
    }

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system,
        messages: [{ role: "user", content: mensaje }],
      }),
    });

    if (!r.ok) {
      const detalle = await r.text();
      console.error("Anthropic", r.status, detalle.slice(0, 300));
      return new Response(JSON.stringify({ error: "Fallo del proveedor" }), { status: 502, headers: cabeceras });
    }

    const data = await r.json();
    const texto = (data.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("\n");

    return new Response(JSON.stringify({ texto }), { headers: cabeceras });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: "Error interno" }), { status: 500, headers: cabeceras });
  }
});
