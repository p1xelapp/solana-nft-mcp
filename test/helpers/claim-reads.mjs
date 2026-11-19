import { readFileSync } from "node:fs";

const folder = new URL("../fixtures/reads-2026-11-19/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name + ".json", folder)));
const requests = read("requests");
globalThis.fetch = async (input, init = {}) => {
  const body = init.body && JSON.parse(init.body);
  const url = new URL(input);
  const capture = requests.find((r) => {
    if (!body) return r.url === url.href || (!r.method && new URL(r.url).pathname === url.pathname);
    if (r.method !== body.method) return false;
    if (Array.isArray(r.params)) return r.params[0] === body.params[0];
    if (r.params.id !== undefined) return r.params.id === body.params.id;
    return r.params.groupValue === body.params.groupValue && r.params.page === body.params.page;
  });
  if (capture && capture.label !== process.env.UNAVAILABLE_READ) return Response.json(read(capture.label));
  if (body?.method === "getMultipleAccounts") {
    for (const r of requests.filter((r) => r.method === body.method)) {
      const ids = r.params[0];
      if (!body.params[0].every((id) => ids.includes(id))) continue;
      const reply = read(r.label);
      reply.result.value = body.params[0].map((id) => reply.result.value[ids.indexOf(id)]);
      return Response.json(reply);
    }
  }
  throw new TypeError("The requested source is offline");
};
