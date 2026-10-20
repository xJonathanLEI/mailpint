import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";
import { capture, listing, runtime, sample } from "./runtime.ts";

test("read, download an attachment, refresh, mark unread and delete a message", {
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
      Attachments: [
        {
          Content: Buffer.from("%PDF-1.7 synthetic").toString("base64"),
          Filename: "Subscription agreement.pdf",
          ContentType: "application/pdf",
        },
      ],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    await page.goto((await mf.ready).href);
    await page
      .locator("#subject")
      .filter({ hasText: sample.Subject })
      .waitFor();
    await page.frameLocator("#html-body").locator("h1").waitFor();
    const attachment = page
      .getByRole("region", { name: "Attachments" })
      .getByRole("link", { name: "Download Subscription agreement.pdf, 18 B" });
    assert.equal(
      await attachment.getAttribute("href"),
      `/api/v1/message/${id}/part/1`,
    );
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      attachment.click(),
    ]);
    assert.equal(download.suggestedFilename(), "Subscription agreement.pdf");
    assert.equal(
      await readFile(await download.path(), "utf8"),
      "%PDF-1.7 synthetic",
    );
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

for (const blockExternalImages of [undefined, true] as const) {
  test(`HTML stays isolated with external images ${blockExternalImages ? "blocked" : "allowed by default"}`, {
    timeout: 60_000,
  }, async () => {
    const mf = await runtime(undefined, blockExternalImages);
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
        <img src="https://hostile.test/image" srcset="https://hostile.test/srcset 2x" onerror="alert(1)" alt="Remote image">
        <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" alt="Embedded image">
        <img src="javascript:alert(1)" alt="Bad image protocol">
        <img src="/api/v1/messages" alt="Relative image">
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
        if (route.request().resourceType() === "image") {
          assert.equal(route.request().headers().referer, undefined);
          await route.fulfill({
            contentType: "image/png",
            body: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
              "base64",
            ),
          });
          return;
        }
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
      const expectedImages = blockExternalImages
        ? []
        : ["https://hostile.test/background", "https://hostile.test/image"];
      assert.deepEqual([...remote].sort(), expectedImages);
      assert.equal(
        await frame
          .getByAltText("Remote image")
          .evaluate(
            (node) => node instanceof HTMLImageElement && node.naturalWidth > 0,
          ),
        !blockExternalImages,
      );
      assert.equal(
        await frame
          .getByAltText("Embedded image")
          .evaluate(
            (node) => node instanceof HTMLImageElement && node.naturalWidth > 0,
          ),
        true,
      );
      for (const alt of ["Bad image protocol", "Relative image"]) {
        assert.equal(await frame.getByAltText(alt).getAttribute("src"), null);
      }
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
      assert.deepEqual(remote.slice(expectedImages.length), [
        "https://destination.test/next",
      ]);
      await popup.close();
    } finally {
      await browser.close();
      await mf.dispose();
    }
  });
}
