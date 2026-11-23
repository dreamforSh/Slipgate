/**
 * Small, dependency-free Markdown → HTML renderer for admin-written content (announcements,
 * landing page). Safety model: every input character is HTML-escaped first and only the
 * constructs below are turned back into tags, so raw HTML in the source never renders.
 * Links and images accept only http(s), mailto and site-relative URLs.
 *
 * Supported: # headings, paragraphs, line breaks, **bold**, *italic*, ~~strike~~, `code`,
 * fenced ``` code blocks, > quotes, - / * / 1. lists, --- rules, [text](url), ![alt](url),
 * and | pipe | tables |.
 */

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function safeUrl(raw: string): string | null {
  const url = raw.trim();
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  if (url.startsWith("#")) return url;
  return null;
}

function formatEmphasis(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
}

/** Inline formatting on already-escaped text. */
function inline(escaped: string): string {
  const tokens: string[] = [];
  const stash = (rendered: string): string => {
    tokens.push(rendered);
    return `\u0000${tokens.length - 1}\u0000`;
  };
  let out = escaped.replace(/`([^`]+)`/g, (_m, code: string) => stash(`<code>${code}</code>`));
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt: string, url: string) => {
    const safe = safeUrl(url.replace(/&amp;/g, "&"));
    return safe ? stash(`<img src="${escapeHtml(safe)}" alt="${alt}" loading="lazy" />`) : m;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) => {
    const safe = safeUrl(url.replace(/&amp;/g, "&"));
    if (!safe) return m;
    const external = /^https?:/i.test(safe);
    return stash(
      `<a href="${escapeHtml(safe)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${formatEmphasis(text)}</a>`,
    );
  });
  out = formatEmphasis(out);
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => tokens[Number(i)] ?? "");
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

export function renderMarkdown(source: string): string {
  const lines = escapeHtml(source.replace(/\u0000/g, "").replace(/\r\n?/g, "\n")).split("\n");
  const html: string[] = [];
  let i = 0;
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length) {
      html.push(`<p>${paragraph.map(inline).join("<br />")}</p>`);
      paragraph = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) body.push(lines[i++]!);
      i++;
      html.push(`<pre><code>${body.join("\n")}</code></pre>`);
      continue;
    }
    if (!trimmed) {
      flush();
      i++;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      const level = heading[1]!.length + 1; // # renders as h2: the page owns h1
      html.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flush();
      html.push("<hr />");
      i++;
      continue;
    }
    if (trimmed.startsWith("&gt;")) {
      flush();
      const quote: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("&gt;")) quote.push(lines[i++]!.trim().replace(/^&gt;\s?/, ""));
      html.push(`<blockquote>${quote.map(inline).join("<br />")}</blockquote>`);
      continue;
    }
    if (/^([-*+]|\d+\.)\s+/.test(trimmed)) {
      flush();
      const ordered = /^\d+\./.test(trimmed);
      const items: string[] = [];
      while (i < lines.length && /^([-*+]|\d+\.)\s+/.test(lines[i]!.trim())) {
        items.push(`<li>${inline(lines[i++]!.trim().replace(/^([-*+]|\d+\.)\s+/, ""))}</li>`);
      }
      html.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    if (trimmed.startsWith("|") && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1]!.trim())) {
      flush();
      const head = splitRow(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) rows.push(splitRow(lines[i++]!));
      html.push(
        `<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
      continue;
    }
    paragraph.push(trimmed);
    i++;
  }
  flush();
  return html.join("\n");
}

/** Plain-text excerpt (markup stripped) for previews and list rows. */
export function markdownExcerpt(source: string, max = 120): string {
  const text = source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
