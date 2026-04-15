import type { ExtractResult } from "./types.js";

/**
 * Extract headers + body from a .eml buffer (RFC 822 / MIME).
 *
 * postal-mime is pure-ESM and works in both Node and the browser without
 * polyfills. We reduce the body to text by preferring `text` over `html`
 * so the indexed content stays searchable even for HTML-only mail.
 */
export async function extractEml(buffer: ArrayBuffer): Promise<ExtractResult> {
  const mod = (await import("postal-mime")) as unknown as { default?: unknown };
  const PostalMime = (mod.default ?? mod) as unknown;
  const warnings: string[] = [];

  try {
    // postal-mime exposes either a default-instantiable class or a
    // namespace with `.parse` depending on bundler — handle both.
    let parsed:
      | {
          from?: { address?: string; name?: string };
          to?: Array<{ address?: string; name?: string }>;
          cc?: Array<{ address?: string; name?: string }>;
          subject?: string;
          date?: string;
          text?: string;
          html?: string;
        }
      | undefined;

    if (typeof (PostalMime as unknown as { parse?: unknown }).parse === "function") {
      parsed = await (
        PostalMime as unknown as { parse: (b: ArrayBuffer) => Promise<typeof parsed> }
      ).parse(buffer);
    } else {
      const Ctor = PostalMime as unknown as new () => {
        parse: (b: ArrayBuffer) => Promise<typeof parsed>;
      };
      parsed = await new Ctor().parse(buffer);
    }

    const p = parsed ?? {};
    const addr = (a?: { address?: string; name?: string }): string =>
      a ? `${a.name ? `${a.name} ` : ""}<${a.address ?? ""}>` : "";
    const addrs = (list?: Array<{ address?: string; name?: string }>): string =>
      (list ?? []).map(addr).filter(Boolean).join(", ");

    const body = p.text ?? (p.html ? p.html.replace(/<[^>]+>/g, " ") : "");
    const headerBlock = [
      p.subject ? `Subject: ${p.subject}` : "",
      p.from ? `From: ${addr(p.from)}` : "",
      p.to?.length ? `To: ${addrs(p.to)}` : "",
      p.cc?.length ? `Cc: ${addrs(p.cc)}` : "",
      p.date ? `Date: ${p.date}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      text: `${headerBlock}\n\n${body}`.trim(),
      email: {
        from: p.from ? addr(p.from) : undefined,
        to: p.to?.length ? addrs(p.to) : undefined,
        cc: p.cc?.length ? addrs(p.cc) : undefined,
        subject: p.subject,
        date: p.date,
      },
      warnings,
    };
  } catch (err) {
    return {
      text: "",
      warnings: [`extract failed: ${(err as Error).message}`],
    };
  }
}
