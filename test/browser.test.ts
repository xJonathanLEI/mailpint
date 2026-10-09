import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { capture, listing, runtime, sample } from "./runtime.ts";

test("read, refresh, mark unread and delete a message", {
  timeout: 60_000,
}, async () => {
  const mf = await runtime();
  const browser = await chromium.launch().catch(async (error: unknown) => {
    await mf.dispose();
    throw error;
  });
  try {
    await capture(mf);
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    await page.goto((await mf.ready).href);
    await page
      .locator("#subject")
      .filter({ hasText: sample.Subject })
      .waitFor();
    await page.frameLocator("#html-body").locator("h1").waitFor();
    await page.locator("#view-text").click();
    assert.equal(await page.locator("#plain-text").textContent(), sample.Text);
    await page.locator("#toggle-read").click();
    await page.waitForFunction(
      () => document.getElementById("toggle-read")?.textContent === "Mark read",
    );
    assert.equal((await listing(mf)).unread, 1);
    await page.locator("#refresh").click();
    await page.waitForFunction(
      () =>
        document.getElementById("announcement")?.textContent ===
        "Inbox up to date.",
    );
    assert.equal((await listing(mf)).unread, 1);
    await page.route("**/api/v1/messages?*", (route) =>
      route.fulfill({ status: 503, body: "unavailable" }),
    );
    await page.locator("#refresh").click();
    await page.locator("#refresh-error").waitFor();
    assert.equal(await page.locator("#plain-text").textContent(), sample.Text);
    await page.unroute("**/api/v1/messages?*");
    await page.locator("#retry").click();
    await page.locator("#refresh-error").waitFor({ state: "hidden" });
    await page.locator("#delete-message").click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal((await listing(mf)).total, 1);
    await page.locator("#delete-message").click();
    await page.locator("#confirm-action").click();
    await page.getByRole("heading", { name: "An empty pint." }).waitFor();
    assert.equal((await listing(mf)).total, 0);
  } finally {
    await browser.close();
    await mf.dispose();
  }
});

test("HTML is isolated and links open without an opener", {
  timeout: 60_000,
}, async () => {
  const mf = await runtime();
  const browser = await chromium.launch().catch(async (error: unknown) => {
    await mf.dispose();
    throw error;
  });
  try {
    const id = await capture(mf, {
      ...sample,
      Subject: '<img src="https://hostile.test/subject" onerror="alert(1)">',
      HTML: `<!doctype html><html><head>
        <meta http-equiv="refresh" content="0;url=https://hostile.test/refresh">
        <base href="https://hostile.test/">
        <link rel="stylesheet" href="https://hostile.test/css">
        <style>@import url(https://hostile.test/import); body { background-image:url(https://hostile.test/background) }</style>
        </head><body onload="parent.document.body.textContent='owned'">
        <script>fetch('https://hostile.test/script'); parent.document.body.textContent='owned'</script>
        <iframe src="https://hostile.test/frame"></iframe>
        <svg onload="alert(1)"><a href="javascript:alert(1)">svg link</a></svg>
        <form action="https://hostile.test/form"><input autofocus onfocus="alert(1)"></form>
        <img src="https://hostile.test/image" srcset="https://hostile.test/srcset 2x" onerror="alert(1)" alt="Blocked image">
        <a href="javascript:alert(1)">Bad protocol</a>
        <a href="/api/v1/messages">Relative</a>
        <a href="https://destination.test/next" target="_top" ping="https://hostile.test/ping" onclick="alert(1)">Continue</a>
        </body></html>`,
    });
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    const remote: string[] = [];
    await page.context().route("https://**/*", async (route) => {
      remote.push(route.request().url());
      await route.fulfill({
        contentType: "text/html",
        body: "<title>Destination</title><p>Arrived</p>",
      });
    });
    await page.goto((await mf.ready).href);
    await page.locator("[data-message]").click();
    await page
      .frameLocator("#html-body")
      .getByText("Continue", { exact: true })
      .waitFor();
    const frame = page
      .frames()
      .find((item) => item.url().includes(`/view/${id}`));
    assert.ok(frame);
    await frame.waitForLoadState("load");
    assert.deepEqual(remote, []);
    assert.equal(await page.locator("#subject img").count(), 0);
    assert.equal(
      await frame
        .locator("script, iframe, svg, meta, base, form, input")
        .count(),
      0,
    );
    for (const text of ["Bad protocol", "Relative"]) {
      assert.equal(
        await frame.getByText(text, { exact: true }).getAttribute("href"),
        null,
      );
    }
    const popupPromise = page.waitForEvent("popup");
    await frame.getByRole("link", { name: "Continue" }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    assert.equal(popup.url(), "https://destination.test/next");
    assert.equal(await popup.evaluate(() => window.opener === null), true);
    assert.deepEqual(remote, ["https://destination.test/next"]);
    await popup.close();
  } finally {
    await browser.close();
    await mf.dispose();
  }
});
