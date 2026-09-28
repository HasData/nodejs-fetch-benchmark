// Throughput under load for four Node HTTP clients.
//
// Local HTTP server (1 KB HTML body, no network noise), 1,000 requests per
// client per concurrency level (1, 10, 50, 200), a simple worker pool for
// concurrency. Recorded per run: wall time, req/s, failures, peak RSS.
// The stand serves nodejs-fetch-api, axios-vs-fetch, and the JS libraries
// pillar, each article shows its own slice.
//
// Node pinned by the articles: 22.x. Run: node throughput.mjs
import http from "node:http";
import axios from "axios";
import nodeFetch from "node-fetch";
import { request as undiciRequest, Agent } from "undici";

const BODY = "<html><body>" + "x".repeat(1000) + "</body></html>";
const N = 1000;
const LEVELS = [1, 10, 50, 200];

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(BODY);
});
await new Promise(r => server.listen(0, r));
const URL_ = `http://127.0.0.1:${server.address().port}/`;
const agent = new Agent({ connections: 256 });

const clients = {
  "native fetch": async () => { const r = await fetch(URL_); await r.text(); return r.status; },
  "axios": async () => { const r = await axios.get(URL_); return r.status; },
  "node-fetch@3": async () => { const r = await nodeFetch(URL_); await r.text(); return r.status; },
  "undici request": async () => { const r = await undiciRequest(URL_, { dispatcher: agent }); await r.body.text(); return r.statusCode; },
};

async function run(name, fn, concurrency) {
  global.gc?.();
  let next = 0, ok = 0, failed = 0, peak = 0;
  const t0 = process.hrtime.bigint();
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= N) return;
      try {
        const s = await fn();
        s >= 200 && s < 400 ? ok++ : failed++;
      } catch { failed++; }
      if (i % 50 === 0) peak = Math.max(peak, process.memoryUsage.rss());
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { client: name, concurrency, ms: Math.round(ms), rps: Math.round(N / (ms / 1000)),
           ok, failed, peak_rss_mb: Math.round(peak / 1e6) };
}

// One client per process keeps RSS honest and module loading isolated:
// with CLIENT set, run that client and print JSON lines; without it,
// spawn one child per client and merge. 3 reps per level, median reported.
const REPS = 3;
if (process.env.CLIENT) {
  const fn = clients[process.env.CLIENT];
  await run(process.env.CLIENT, fn, 10); // warmup, discarded
  for (const c of LEVELS) {
    const reps = [];
    for (let i = 0; i < REPS; i++) reps.push(await run(process.env.CLIENT, fn, c));
    const rps = reps.map(r => r.rps).sort((a, b) => a - b);
    console.log(JSON.stringify({ client: process.env.CLIENT, concurrency: c,
      rps_median: rps[1], rps_min: rps[0], rps_max: rps[2],
      failed: reps.reduce((s, r) => s + r.failed, 0),
      peak_rss_mb: Math.max(...reps.map(r => r.peak_rss_mb)) }));
  }
  server.close();
  agent.close();
} else {
  server.close();
  agent.close();
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const self = fileURLToPath(import.meta.url);
  const results = [];
  for (const name of Object.keys(clients)) {
    const out = execFileSync(process.execPath, [self],
      { env: { ...process.env, CLIENT: name }, encoding: "utf-8" });
    for (const line of out.trim().split(String.fromCharCode(10))) {
      if (line.startsWith("{")) { results.push(JSON.parse(line)); console.log(line); }
    }
  }
  const fs = await import("node:fs");
  fs.writeFileSync(new URL("./results/throughput_results.json", import.meta.url),
                   JSON.stringify({ node: process.version, n: N, reps: REPS, results }, null, 1));
  console.log("saved results/throughput_results.json");
}
