// Render markdown produced by the AI features (summaries, Q&A, digests).
//
// The text is LLM output, but the LLM summarizes attacker-influenced feed
// content, so its markdown can carry raw HTML. `marked` does not sanitize,
// and the result is injected via dangerouslySetInnerHTML inside a Tauri
// webview — so every render is passed through an allowlist sanitizer first.

import { marked } from "marked";

marked.setOptions({ breaks: true, gfm: true });

// Elements removed wholesale, including their text content.
const DROP_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "noscript",
  "template", "link", "meta", "form", "input", "button", "svg",
]);

// Elements kept as-is. Anything else is unwrapped to its children.
const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "span", "div", "blockquote", "pre", "code",
  "strong", "em", "b", "i", "u", "s", "del", "mark", "sub", "sup",
  "ul", "ol", "li", "a",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
]);

// Per-tag attribute allowlist. Everything not listed (incl. on* handlers,
// style, srcset) is stripped.
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
};

const SAFE_HREF = /^(https?:|mailto:)/i;

function sanitizeElement(el: Element) {
  // Depth-first: process children before the element may be unwrapped.
  for (const child of Array.from(el.children)) sanitizeElement(child);

  const tag = el.tagName.toLowerCase();

  if (DROP_TAGS.has(tag)) {
    el.remove();
    return;
  }
  if (!ALLOWED_TAGS.has(tag)) {
    el.replaceWith(...Array.from(el.childNodes)); // unwrap, keep contents
    return;
  }

  const allowed = ALLOWED_ATTRS[tag];
  for (const attr of Array.from(el.attributes)) {
    if (!allowed || !allowed.has(attr.name.toLowerCase())) {
      el.removeAttribute(attr.name);
    }
  }
  if (tag === "a") {
    const href = (el.getAttribute("href") ?? "").trim();
    if (SAFE_HREF.test(href)) {
      el.setAttribute("rel", "noopener noreferrer nofollow");
    } else {
      el.removeAttribute("href");
    }
  }
}

// Some providers occasionally return bold delimiters as literal text (for
// example after entity escaping, or while a streamed response is still being
// assembled). `marked` handles normal `**bold**`, but those leftovers would
// otherwise be visible in the drawer. Repair only ordinary text nodes outside
// code blocks; assigning the match through `textContent` keeps this fallback
// inert even when the model supplied HTML-looking text.
function repairUnrenderedStrong(root: Element) {
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) textNodes.push(node as Text);

  const strongPattern = /\*\*([^*\r\n]+?)\*\*/g;
  for (const textNode of textNodes) {
    if (textNode.parentElement?.closest("pre, code")) continue;
    const value = textNode.nodeValue ?? "";
    strongPattern.lastIndex = 0;
    if (!strongPattern.test(value)) continue;
    strongPattern.lastIndex = 0;

    const fragment = root.ownerDocument!.createDocumentFragment();
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = strongPattern.exec(value))) {
      if (match.index > cursor) {
        fragment.append(root.ownerDocument!.createTextNode(value.slice(cursor, match.index)));
      }
      const strong = root.ownerDocument!.createElement("strong");
      strong.textContent = match[1];
      fragment.append(strong);
      cursor = match.index + match[0].length;
    }
    if (cursor < value.length) {
      fragment.append(root.ownerDocument!.createTextNode(value.slice(cursor)));
    }
    textNode.replaceWith(fragment);
  }
}

export function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false });
  // DOMParser documents are inert — nothing here executes.
  const doc = new DOMParser().parseFromString(raw, "text/html");
  for (const child of Array.from(doc.body.children)) sanitizeElement(child);
  repairUnrenderedStrong(doc.body);
  return doc.body.innerHTML;
}
