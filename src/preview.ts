import { commonHeaders } from "./http.js";

// This document is only served with this response CSP and an opaque iframe
// sandbox. Inline email CSS is preserved; all automatic network access is denied.
export const previewPolicy =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-popups allow-popups-to-escape-sandbox";

const allowedTags = new Set(
  "html head body title style a abbr address article aside b bdi bdo blockquote br caption center code col colgroup dd del details div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark nav ol p pre q s samp section small span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul wbr".split(
    " ",
  ),
);
const discardedTags = new Set(
  "script iframe frame frameset object embed svg math template noscript noembed noframes plaintext xmp textarea".split(
    " ",
  ),
);
const allowedAttributes = new Set(
  "class id style title lang dir width height align valign bgcolor border cellpadding cellspacing colspan rowspan role aria-label face color size".split(
    " ",
  ),
);

export function preview(html: string) {
  const source =
    html || "<p>This message has no HTML body. Choose Text to read it.</p>";
  return new HTMLRewriter()
    .on("*", {
      element(element) {
        const tag = element.tagName;
        if (discardedTags.has(tag)) {
          element.remove();
          return;
        }
        if (!allowedTags.has(tag)) {
          element.removeAndKeepContent();
          return;
        }
        const href = element.getAttribute("href");
        const src = element.getAttribute("src");
        const alt = element.getAttribute("alt");
        for (const [name] of [...element.attributes]) {
          if (name && !allowedAttributes.has(name))
            element.removeAttribute(name);
        }
        if (tag === "a") {
          if (href) {
            try {
              const url = new URL(href);
              if (["https:", "http:"].includes(url.protocol)) {
                element.setAttribute("href", url.href);
              }
            } catch {
              // Relative and non-web links have no useful mailbox destination.
            }
          }
          element.setAttribute("target", "_blank");
          element.setAttribute("rel", "noopener noreferrer");
        }
        if (tag === "img") {
          if (
            src &&
            /^data:image\/(?:png|gif|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(
              src,
            )
          ) {
            element.setAttribute("src", src);
          }
          if (alt) element.setAttribute("alt", alt);
        }
      },
    })
    .transform(
      new Response(source, {
        headers: {
          ...commonHeaders,
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": previewPolicy,
        },
      }),
    );
}
