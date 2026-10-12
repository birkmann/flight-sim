// The JSON response helper extracted from eu-ui/packages/ai-gateway/src/handler.mjs.
export function json(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
}
