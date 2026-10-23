// No Repro browser runner. It runs on the repo owner's own GitHub Actions runner (copied into
// their repo as .github/norepro/runner.mjs), never on No Repro's servers.
//   node runner.mjs <job.json> <out.json>
// job: { mode: "snapshot" | "replay", baseUrl, reset: "POST /__reset" | null, runs, plan: { viewport, steps, check } }
// Replay: start the app, run the steps `runs` times in fresh browsers, evaluate the check each time. If a step
// can't be performed, the page is described (elements, text) so No Repro can correct the plan.
// Snapshot: run the steps once, then describe the page.
// Bisect: for each commit git bisect picks, install + start the app there and replay the plan;
// the bug showing marks it bad, not showing marks it good, build failures are skipped.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const CANDIDATES = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[data-testid],[id]';
const MAX_ELEMENTS = 60;

export function countRequests(requests, method, path) {
  return requests.filter((r) => r.method === method.toUpperCase() && r.path === path).length;
}

/** Checks that don't need the live page. Returns null when the page is needed. */
export function evaluateOffline(check, observed) {
  if (check.type === "request_count") {
    const n = countRequests(observed.requests, check.method, check.path);
    return { passed: n <= check.max, detail: `${check.method.toUpperCase()} ${check.path} was sent ${n} time${n === 1 ? "" : "s"} (expected at most ${check.max})` };
  }
  if (check.type === "no_errors") {
    return observed.errors.length
      ? { passed: false, detail: `${observed.errors.length} error${observed.errors.length === 1 ? "" : "s"}: ${observed.errors[0]}` }
      : { passed: true, detail: "no errors" };
  }
  return null;
}

const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

function locate(page, t) {
  let loc =
    t.by === "role" ? page.getByRole(t.role ?? "button", { name: t.value, exact: true })
    : t.by === "label" ? page.getByLabel(t.value, { exact: true })
    : t.by === "placeholder" ? page.getByPlaceholder(t.value, { exact: true })
    : t.by === "testId" ? page.getByTestId(t.value)
    : t.by === "text" ? page.getByText(t.value, { exact: true })
    : page.locator(t.value);
  if (t.nth !== null && t.nth !== undefined) loc = loc.nth(t.nth);
  return loc;
}

const QUIET_MS = 500;
const SETTLE_MAX_MS = 6000;

/**
 * Wait until the app has had no requests in flight for QUIET_MS (or SETTLE_MAX_MS passes).
 * Playwright's "networkidle" load state only fires once per page load, so after a click it
 * returns at once, before the requests the click triggers have even started.
 */
export async function settle(page, observed, now = () => Date.now(), sleep = (ms) => page.waitForTimeout(ms)) {
  const deadline = now() + SETTLE_MAX_MS;
  await sleep(50); // let handlers fired by the action start their requests
  while (now() < deadline) {
    if (observed.inflight === 0 && now() - observed.lastActivity >= QUIET_MS) return;
    await sleep(50);
  }
}

async function runStep(page, step, baseUrl, observed) {
  const opts = { timeout: 5000 };
  switch (step.do) {
    case "goto":
    {
      // Second line of defence: never leave the app's origin, whatever the plan says.
      const url = new URL(step.path, baseUrl);
      if (url.origin !== new URL(baseUrl).origin) throw new Error(`refusing to leave the app: ${url.origin}`);
      await page.goto(url.toString(), { timeout: 15000 });
    }
      break;
    case "click": {
      const loc = locate(page, step.target);
      for (let i = 0; i < step.times; i++) await loc.click({ ...opts, noWaitAfter: step.times > 1 });
      break;
    }
    case "fill":
      await locate(page, step.target).fill(step.value, opts);
      break;
    case "press":
      await locate(page, step.target).press(step.key, opts);
      break;
    case "select":
      await locate(page, step.target).selectOption(step.value, opts);
      break;
    case "wait":
      await page.waitForTimeout(Math.min(step.ms, 3000));
      break;
  }
  await settle(page, observed);
}

function instrument(page, origin) {
  const observed = { requests: [], errors: [], inflight: 0, lastActivity: Date.now() };
  // Count every request the page makes (any origin) so settle() knows when it's quiet.
  const done = () => {
    observed.inflight = Math.max(0, observed.inflight - 1);
    observed.lastActivity = Date.now();
  };
  page.on("request", () => {
    observed.inflight++;
    observed.lastActivity = Date.now();
  });
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.origin !== origin) return;
    // Everything the app itself sends (API calls, form posts); plain page loads aren't interesting.
    const pageLoad = r.resourceType() === "document" && r.method() === "GET";
    if (!pageLoad) observed.requests.push({ method: r.method(), path: u.pathname });
  });
  page.on("response", (r) => {
    if (r.status() >= 500) observed.errors.push(`${r.request().method()} ${new URL(r.url()).pathname} returned ${r.status()}`);
  });
  page.on("console", (m) => m.type() === "error" && observed.errors.push(`console: ${squash(m.text()).slice(0, 200)}`));
  page.on("pageerror", (e) => observed.errors.push(`uncaught: ${squash(e.message).slice(0, 200)}`));
  return observed;
}

async function sameElement(page, loc, handle) {
  try {
    if ((await loc.count()) !== 1) return false;
    const other = await loc.elementHandle({ timeout: 500 });
    return other ? await page.evaluate(([a, b]) => a === b, [other, handle]) : false;
  } catch {
    return false;
  }
}

/** Visible elements, each with a locator that's been checked to find exactly that element. */
async function describeElements(page) {
  const handles = await page.$$(CANDIDATES);
  const out = [];
  for (const h of handles) {
    if (out.length >= MAX_ELEMENTS) break;
    if (!(await h.isVisible().catch(() => false))) continue;
    const info = await h.evaluate((el) => {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      const explicitRole = el.getAttribute("role");
      const implicit =
        tag === "button" || (tag === "input" && ["button", "submit", "reset"].includes(type)) ? "button"
        : tag === "a" ? "link"
        : tag === "select" ? "combobox"
        : tag === "textarea" ? "textbox"
        : tag === "input" && type === "checkbox" ? "checkbox"
        : tag === "input" && type === "radio" ? "radio"
        : tag === "input" && type === "search" ? "searchbox"
        : tag === "input" ? "textbox"
        : null;
      const labelEl = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : el.closest("label");
      const text = (el.innerText || el.value || "").replace(/\s+/g, " ").trim();
      return {
        tag,
        role: explicitRole || implicit,
        ariaLabel: el.getAttribute("aria-label"),
        label: labelEl ? labelEl.innerText.replace(/\s+/g, " ").trim() : null,
        placeholder: el.getAttribute("placeholder"),
        testId: el.getAttribute("data-testid"),
        id: el.id || null,
        text: text.slice(0, 80),
        value: tag === "input" || tag === "textarea" ? el.value : null,
      };
    });
    const name = info.ariaLabel || info.label || (info.role === "button" || info.role === "link" ? info.text : null) || info.placeholder;
    const tries = [];
    if (info.role && name) tries.push({ by: "role", value: name, role: info.role, nth: null });
    if (info.testId) tries.push({ by: "testId", value: info.testId, role: null, nth: null });
    if (info.label) tries.push({ by: "label", value: info.label, role: null, nth: null });
    if (info.placeholder) tries.push({ by: "placeholder", value: info.placeholder, role: null, nth: null });
    if (info.id) tries.push({ by: "css", value: `#${info.id.replace(/([^\w-])/g, "\\$1")}`, role: null, nth: null });
    if (!info.role && info.text) tries.push({ by: "text", value: info.text, role: null, nth: null });
    let target = null;
    for (const t of tries) {
      if (await sameElement(page, locate(page, t), h)) {
        target = t;
        break;
      }
    }
    if (!target) continue; // can't address it reliably, so don't offer it
    out.push({
      ref: `e${out.length + 1}`,
      kind: info.role ?? info.tag,
      name: name ?? info.text ?? "",
      text: info.text,
      value: info.value,
      target,
    });
  }
  return out;
}

async function resetApp(baseUrl, reset) {
  if (!reset) return;
  const [method, path] = reset.split(" ");
  await fetch(new URL(path, baseUrl), { method }).catch(() => {});
}

async function oneRun(browser, job, withSnapshot, runIndex) {
  const origin = new URL(job.baseUrl).origin;
  const context = await browser.newContext({ viewport: job.plan.viewport, hasTouch: job.plan.viewport.width < 600 });
  const page = await context.newPage();
  const observed = instrument(page, origin);
  const result = { ok: true, failedStep: null, error: null };
  try {
    for (let i = 0; i < job.plan.steps.length; i++) {
      try {
        await runStep(page, job.plan.steps[i], job.baseUrl, observed);
      } catch (err) {
        Object.assign(result, { ok: false, failedStep: i, error: squash(err.message).slice(0, 300) });
        break;
      }
    }
    if (withSnapshot || !result.ok) {
      result.url = new URL(page.url()).pathname;
      result.title = await page.title().catch(() => "");
      result.text = squash(await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).slice(0, 2500);
      result.elements = await describeElements(page);
    }
    // Requests set off by the last step may still be on their way; the check must see them.
    await settle(page, observed);
    if (result.ok && job.plan.check) {
      let verdict = evaluateOffline(job.plan.check, observed);
      if (!verdict) {
        const c = job.plan.check;
        if (c.type === "text_visible") {
          const seen = await page.getByText(c.text).first().isVisible({ timeout: 2000 }).catch(() => false);
          verdict = { passed: seen, detail: seen ? `the page shows "${c.text}"` : `the page doesn't show "${c.text}"` };
        } else {
          const shown = squash(await locate(page, c.target).innerText({ timeout: 3000 }).catch(() => ""));
          const passed = shown.includes(squash(c.expected));
          verdict = { passed, detail: passed ? `shows "${shown}"` : `shows "${shown || "nothing"}" instead of "${c.expected}"` };
        }
      }
      result.check = verdict;
    }
    if (runIndex !== null) {
      await mkdir("/tmp/norepro", { recursive: true });
      await page.screenshot({ path: `/tmp/norepro/run-${runIndex}.png` }).catch(() => {});
    }
  } finally {
    result.requests = observed.requests;
    result.errors = observed.errors;
    await context.close();
  }
  return result;
}

// ---------- the app under test ----------
// Install and start commands come from the repo owner's workflow (env), never from the plan.

const APP = {
  dir: process.env.NOREPRO_APP_DIR || process.cwd(),
  install: process.env.NOREPRO_INSTALL || "",
  start: process.env.NOREPRO_START || "",
  readyUrl: process.env.NOREPRO_READY_URL || "",
  log: process.env.NOREPRO_APP_LOG || "app.log",
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function answers(url) {
  try {
    const res = await fetch(url, { redirect: "manual" });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Install and start the app at whatever commit is checked out. Returns a stop() or why it failed. */
async function startApp(label) {
  const { spawn, spawnSync } = await import("node:child_process");
  const { openSync, appendFileSync } = await import("node:fs");
  appendFileSync(APP.log, `\n===== ${label} =====\n`);
  const fd = openSync(APP.log, "a");
  if (APP.install) {
    const res = spawnSync("bash", ["-lc", APP.install], { cwd: APP.dir, stdio: ["ignore", fd, fd], timeout: 10 * 60_000 });
    if (res.status !== 0) return { ok: false, reason: "install failed" };
  }
  const child = spawn("bash", ["-lc", APP.start], { cwd: APP.dir, stdio: ["ignore", fd, fd], detached: true });
  let exited = false;
  child.on("exit", () => (exited = true));
  const stop = async () => {
    try {
      process.kill(-child.pid, "SIGTERM"); // the whole process group: npm/bun spawn children
    } catch {}
    for (let i = 0; i < 20 && (await answers(APP.readyUrl)); i++) await wait(250);
  };
  for (let i = 0; i < 120; i++) {
    if (await answers(APP.readyUrl)) return { ok: true, stop };
    if (exited) return { ok: false, reason: "the app exited while starting" };
    await wait(1000);
  }
  await stop();
  return { ok: false, reason: "the app didn't answer within 2 minutes" };
}

async function replayAll(browser, job, runs) {
  const out = [];
  for (let i = 1; i <= runs; i++) {
    await resetApp(job.baseUrl, job.reset);
    const run = await oneRun(browser, job, false, i);
    out.push(run);
    // If the steps can't be followed, repeating them won't help; report what the page looked like.
    if (!run.ok) break;
  }
  return out;
}

// ---------- bisect ----------

/**
 * Classify one commit's runs the way git bisect needs: the bug showed, it didn't, or we can't tell.
 * `signature` holds the errors every reproducing run showed (e.g. "GET /api/notes returned 500").
 * When there is one, it decides: an old commit can fail the check for unrelated reasons (the
 * text it looks for didn't exist yet), and that isn't this bug.
 */
export function classify(runs, signature = []) {
  if (!runs.length || runs.some((r) => !r.ok)) return "skip";
  if (signature.length) return runs.some((r) => (r.errors ?? []).some((e) => signature.includes(e))) ? "bad" : "good";
  return runs.some((r) => r.check && !r.check.passed) ? "bad" : "good";
}

/** "<sha> is the first bad commit" (newer git quotes it: "first 'bad' commit") → sha */
export function firstBadFrom(output) {
  return output.match(/^([0-9a-f]{40}) is the first '?bad'? commit/m)?.[1] ?? null;
}

async function bisect(browser, job) {
  const { execFileSync } = await import("node:child_process");
  const git = (...args) => execFileSync("git", args, { cwd: APP.dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const clean = () => {
    git("reset", "--hard", "-q");
    git("clean", "-fdq"); // keeps ignored folders like node_modules between commits
  };
  const info = (sha) => {
    const [full, message, author, date] = git("show", "-s", "--format=%H%x1f%s%x1f%an%x1f%aI", sha).trim().split("\x1f");
    return { sha: full, message, author, date };
  };
  const { good, bad, runsPerCommit = 2, maxSteps = 12, signature = [] } = job.bisect;
  const steps = [];

  const test = async (sha, label) => {
    clean();
    git("checkout", "-q", sha);
    const app = await startApp(`${label} ${sha.slice(0, 7)}`);
    if (!app.ok) {
      steps.push({ sha, result: "skip", why: app.reason });
      return "skip";
    }
    try {
      const result = classify(await replayAll(browser, job, runsPerCommit), signature);
      steps.push({ sha, result });
      return result;
    } finally {
      await app.stop();
    }
  };

  // Check the known-good end first: if the bug is already there, this isn't a regression in the range.
  const goodResult = await test(good, "known good");
  if (goodResult === "bad") return { status: "not-regression", good: info(good), bad: info(bad), steps };
  if (goodResult === "skip") return { status: "inconclusive", reason: "the known-good commit couldn't be tested", good: info(good), bad: info(bad), steps };

  clean();
  git("bisect", "start", bad, good);
  try {
    let output = "";
    for (let i = 0; i < maxSteps; i++) {
      const sha = git("rev-parse", "HEAD").trim();
      const result = await test(sha, "bisect");
      clean();
      git("checkout", "-q", sha); // test() may leave things dirty; bisect needs the commit it chose
      output = git("bisect", result);
      const found = firstBadFrom(output);
      if (found) return { status: "found", good: info(good), bad: info(bad), firstBad: info(found), steps };
      if (/only 'skip'ped commits left/.test(output)) break;
    }
    return { status: "inconclusive", reason: "too many commits couldn't be built or tested", good: info(good), bad: info(bad), steps };
  } finally {
    try {
      git("bisect", "reset");
    } catch {}
  }
}

// ---------- main ----------

async function main() {
  const [jobPath, outPath] = process.argv.slice(2);
  const job = JSON.parse(await readFile(jobPath, "utf8"));
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    let out;
    if (job.mode === "bisect") {
      out = { bisect: await bisect(browser, job) };
    } else {
      const app = APP.start ? await startApp("current") : { ok: true, stop: async () => {} };
      if (!app.ok) {
        out = { fatal: `The app didn't start: ${app.reason}.`, appStartFailed: true };
      } else {
        try {
          out = job.mode === "snapshot" ? (await resetApp(job.baseUrl, job.reset), await oneRun(browser, job, true, null)) : { runs: await replayAll(browser, job, job.runs) };
        } finally {
          await app.stop();
        }
      }
    }
    await writeFile(outPath, JSON.stringify(out));
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  main().catch(async (err) => {
    await writeFile(process.argv[3], JSON.stringify({ fatal: String(err?.message ?? err) })).catch(() => {});
    process.exitCode = 1;
  });
}
