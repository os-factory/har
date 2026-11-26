/** Read a JSON request body; a body that does not parse is a 400, never a 500. */
export async function readJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const text = await request.text();
  if (!text.trim()) return { ok: false, error: 'empty body' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: `body is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}
