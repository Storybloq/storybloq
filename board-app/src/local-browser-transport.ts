export async function localBrowserPost(
  capability: string,
  input: unknown,
  send: typeof fetch = fetch,
) {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  // Never replay a request: a lost response may follow a committed save.
  const response = await send("/api", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-storybloq-capability": capability,
      "x-storybloq-request": nonce,
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    if (error.code === "viewer_capacity") {
      const message =
        "Your draft is preserved. Restart this task's Storybloq connection before saving again. Reloading this page will not reset the connection.";
      return {
        isError: true,
        content: [{ type: "text", text: message }],
        _meta: { editError: { code: "viewer_capacity", message } },
      };
    }
    throw Error(
      "The local board request could not be confirmed. Reload before retrying a change.",
    );
  }
  return response.json();
}
