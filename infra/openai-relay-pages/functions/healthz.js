export function onRequestGet() {
  return Response.json(
    { ok: true, service: "tianclip-openai-relay" },
    { headers: { "cache-control": "no-store" } },
  );
}
