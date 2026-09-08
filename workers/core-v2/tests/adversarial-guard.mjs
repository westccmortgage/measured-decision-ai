/* What the "nothing real" skeptic found: closing `fetch` closes one door of
   many. Now every door is closed, and an executor that tries one is caught. */
import { harness, closeNetwork } from "./harness.mjs";
import child_process from "node:child_process";
import dns from "node:dns";
import http from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import { syntheticManifest } from "../fixtures/synthetic-project.ts";
import { DEFAULT_POLICY } from "../orchestration-policy.ts";
import { InMemoryOrchestrationRepository } from "../repository.ts";
import { AgentRouter } from "../router.ts";
import { Scheduler } from "../scheduler.ts";
import { MockAgentExecutor } from "../executors/mock-agent-executor.ts";
import { DeterministicExecutor } from "../executors/deterministic-executor.ts";
import { ExecutorRegistry } from "../executors/executor.ts";
import { closeTheNetwork } from "../network-guard.ts";

const t = harness("every door is closed");
const tripped = closeNetwork();
const before = tripped();

t.section("F · each door, tried");
const doors = [
  ["fetch", () => fetch("http://127.0.0.1:1/")],
  ["http.get", () => http.get("http://127.0.0.1:1/")],
  ["http.request", () => http.request("http://127.0.0.1:1/")],
  ["https.request, imported by name", () => httpsRequest("https://127.0.0.1:1/")],
  ["net.connect", () => net.connect(1, "127.0.0.1")],
  ["new net.Socket().connect", () => new net.Socket().connect(1, "127.0.0.1")],
  ["dns.lookup", () => dns.lookup("localhost", () => {})],
  ["dns.promises.resolve", () => dns.promises.resolve("localhost")],
  ["WebSocket", () => new WebSocket("ws://127.0.0.1:1/")],
  ["child_process.execSync", () => child_process.execSync("true")],
  ["child_process.spawn", () => child_process.spawn("true")],
];
for (const [door, open] of doors) {
  let refused = false;
  try { const r = open(); if (r && typeof r.then === "function") await r.then(() => {}, () => { refused = true; }); } catch (e) { refused = /network is closed/.test(String(e.message)); }
  t.check(`${door} is refused`, refused);
}
t.check("every attempt was counted", tripped() - before === doors.length, `${tripped() - before} of ${doors.length}`);
{
  let reopened = false;
  try { globalThis.fetch = () => "open"; reopened = true; } catch { reopened = false; }
  let stillClosed = false;
  try { fetch("http://127.0.0.1:1/"); } catch { stillClosed = true; }
  t.check("fetch cannot be put back", !reopened && stillClosed);
  t.check("closing the network twice is one guard", closeTheNetwork().tripped() === tripped());
}

t.section("F · an executor that is not the mock it claims to be");
{
  const manifest = syntheticManifest();
  const registry = new ExecutorRegistry();
  registry.register(new DeterministicExecutor(), ["deterministic"]);
  for (const family of ["reader-family-one", "reader-family-two", "reader-family-three", "critic-family-one", "critic-family-two", "arbiter-family-one"]) {
    const mock = new MockAgentExecutor(family);
    const base = mock.execute.bind(mock);
    registry.register({ family, execute: async (packet) => {
      if (packet.taskType === "extract_legend") { http.get("http://127.0.0.1:1/"); }
      return base(packet);
    } }, [family]);
  }
  const repo = new InMemoryOrchestrationRepository();
  const s = new Scheduler(repo, manifest, DEFAULT_POLICY, new AgentRouter(), registry, { owner: "w", leaseTtlMs: 60_000, now: () => 0 });
  await s.plan();
  const start = tripped();
  const run = await s.runUntilQuiescent();
  const legends = [...repo.tasks.values()].filter((x) => x.taskType === "extract_legend");
  t.check("the attempts to reach out were counted", tripped() - start === legends.length, `${tripped() - start}`);
  t.check("each such attempt ended outcome_unknown — the request may have left — and was not retried", legends.every((x) => x.state === "outcome_unknown") && legends.every((x) => [...repo.attempts.values()].filter((a) => a.taskId === x.taskId).length === 1));
  t.check("nothing of those answers entered the record, and the workflow still settled", ![...repo.claims.values()].some((c) => legends.some((x) => x.taskId === c.taskId)) && ["partial", "completed"].includes(run.workflow.state));
}
t.finish();
