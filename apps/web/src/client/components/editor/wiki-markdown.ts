import MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import {
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
} from "prosemirror-markdown";
import { Schema } from "prosemirror-model";

/**
 * Extended markdown schema: default GFM schema + a `wikilink` inline atom.
 *
 * A `wikilink` captures `[[Page]]` and `[[Page#blk_ULID]]` references. The
 * `target` attribute holds the full reference (possibly including the
 * `#blk_…` block-ref suffix); `display` optionally holds a pipe-alias
 * (`[[Page|Alias]]`). The node is a leaf — no inline children — so the
 * editor treats it as a single clickable token.
 */
const baseSchema = defaultMarkdownParser.schema;

/**
 * Parse DOM attrs into the shape `prosemirror-tables` expects. We
 * read `style="text-align: …"` for alignment, plus `colspan` /
 * `rowspan` / `data-colwidth` so pasted HTML tables survive their
 * original geometry.
 */
function parseCellAttrs(el: HTMLElement): {
  alignment: string | null;
  colspan: number;
  rowspan: number;
  colwidth: number[] | null;
} {
  const colspan = Number.parseInt(el.getAttribute("colspan") ?? "1", 10) || 1;
  const rowspan = Number.parseInt(el.getAttribute("rowspan") ?? "1", 10) || 1;
  const widthAttr = el.getAttribute("data-colwidth");
  const colwidth =
    widthAttr && /^\d+(,\d+)*$/.test(widthAttr)
      ? widthAttr.split(",").map((n) => Number.parseInt(n, 10))
      : null;
  return {
    alignment: el.style.textAlign || null,
    colspan,
    rowspan,
    colwidth: colwidth && colwidth.length === colspan ? colwidth : null,
  };
}

/**
 * Render the DOM attrs for a table cell. Omits defaults so the
 * rendered HTML stays clean — `colspan="1"` is noise.
 */
function cellDomAttrs(attrs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const align = attrs.alignment as string | null;
  if (align) out.style = `text-align: ${align}`;
  const colspan = attrs.colspan as number;
  const rowspan = attrs.rowspan as number;
  const colwidth = attrs.colwidth as number[] | null;
  if (colspan && colspan !== 1) out.colspan = String(colspan);
  if (rowspan && rowspan !== 1) out.rowspan = String(rowspan);
  if (colwidth) out["data-colwidth"] = colwidth.join(",");
  return out;
}

export const wikiSchema: Schema = new Schema({
  nodes: baseSchema.spec.nodes
    .addToEnd("table", {
      content: "table_row+",
      group: "block",
      tableRole: "table",
      isolating: true,
      parseDOM: [{ tag: "table" }],
      toDOM() {
        return ["table", ["tbody", 0]];
      },
    })
    .addToEnd("table_row", {
      content: "(table_cell | table_header)+",
      tableRole: "row",
      parseDOM: [{ tag: "tr" }],
      toDOM() {
        return ["tr", 0];
      },
    })
    .addToEnd("table_header", {
      content: "inline*",
      // prosemirror-tables reads colspan / rowspan / colwidth on
      //  every cell when executing its editing commands (addColumn,
      //  deleteRow, mergeCells, etc). Ironlore's GFM serializer
      //  flattens merges on save — the markdown output never emits
      //  span > 1 — but the attrs must exist so the commands run
      //  without asserting on undefined.
      attrs: {
        alignment: { default: null },
        colspan: { default: 1 },
        rowspan: { default: 1 },
        colwidth: { default: null },
      },
      tableRole: "header_cell",
      isolating: true,
      parseDOM: [
        {
          tag: "th",
          getAttrs: (el) => parseCellAttrs(el as HTMLElement),
        },
      ],
      toDOM(node) {
        return ["th", cellDomAttrs(node.attrs), 0];
      },
    })
    .addToEnd("table_cell", {
      content: "inline*",
      attrs: {
        alignment: { default: null },
        colspan: { default: 1 },
        rowspan: { default: 1 },
        colwidth: { default: null },
      },
      tableRole: "cell",
      isolating: true,
      parseDOM: [
        {
          tag: "td",
          getAttrs: (el) => parseCellAttrs(el as HTMLElement),
        },
      ],
      toDOM(node) {
        return ["td", cellDomAttrs(node.attrs), 0];
      },
    })
    .addToEnd("wikilink", {
      inline: true,
      atom: true,
      group: "inline",
      attrs: {
        target: { default: "" },
        display: { default: null },
      },
      parseDOM: [
        {
          tag: "span[data-wikilink]",
          getAttrs: (el) => {
            const element = el as HTMLElement;
            return {
              target: element.getAttribute("data-wikilink") ?? "",
              display: element.getAttribute("data-display"),
            };
          },
        },
      ],
      toDOM(node) {
        const { target, display } = node.attrs as { target: string; display: string | null };
        // Mirrors the Blockref chip shape — see MarkdownEditor's
        //  nodeView for the live-render path, and `.il-blockref` in
        //  globals.css for the shared visual.
        const hashIdx = target.indexOf("#");
        const pagePart = hashIdx === -1 ? target : target.slice(0, hashIdx);
        const blockRaw = hashIdx === -1 ? null : target.slice(hashIdx + 1);
        const shortBlock = blockRaw == null ? null : blockRaw.replace(/^blk_/, "").slice(-4);
        const children: (string | [string, Record<string, string>, string])[] = [
          display ?? pagePart,
        ];
        if (shortBlock) {
          children.push(["span", { class: "il-blockref__id" }, `#${shortBlock}`]);
        }
        return [
          "span",
          {
            "data-wikilink": target,
            "data-display": display ?? "",
            class: "il-blockref ir-wikilink",
          },
          ...children,
        ];
      },
    }),
  marks: baseSchema.spec.marks,
});

// ---------------------------------------------------------------------------
// markdown-it: inline rule for [[target]] and [[target|display]]
// ---------------------------------------------------------------------------

/**
 * Inline rule consumed by markdown-it. Runs before the default `link` rule
 * so `[[foo]]` doesn't get mis-parsed as `[` + `[foo]` + `]`.
 */
function wikilinkRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;

  if (src.charCodeAt(start) !== 0x5b /* [ */ || src.charCodeAt(start + 1) !== 0x5b) {
    return false;
  }

  // Find the matching `]]` on the same inline chunk. We stop at newlines to
  // avoid consuming huge spans on malformed input.
  let end = start + 2;
  let found = -1;
  while (end < src.length - 1) {
    const ch = src.charCodeAt(end);
    if (ch === 0x0a /* \n */) break;
    if (ch === 0x5d /* ] */ && src.charCodeAt(end + 1) === 0x5d) {
      found = end;
      break;
    }
    end++;
  }
  if (found === -1) return false;

  const inner = src.slice(start + 2, found);
  // Wiki-link contents are one line, no nested [[ ]].
  if (inner.includes("[[") || inner.includes("]]") || inner.length === 0) {
    return false;
  }

  if (!silent) {
    const pipeIdx = inner.indexOf("|");
    const target = (pipeIdx === -1 ? inner : inner.slice(0, pipeIdx)).trim();
    const display = pipeIdx === -1 ? null : inner.slice(pipeIdx + 1).trim();

    const token = state.push("wikilink", "", 0);
    token.meta = { target, display };
    token.content = display ?? target;
  }

  state.pos = found + 2;
  return true;
}

function wikilinkPlugin(md: MarkdownIt): void {
  md.inline.ruler.before("link", "wikilink", wikilinkRule);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const md = MarkdownIt("commonmark", { html: false })
  .enable(["table", "strikethrough"])
  .use(wikilinkPlugin);

export const wikiMarkdownParser = new MarkdownParser(wikiSchema, md, {
  ...defaultMarkdownParser.tokens,
  table: { block: "table" },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: "table_row" },
  th: {
    block: "table_header",
    getAttrs: (tok) => ({
      alignment: (tok.attrGet?.("style")?.match(/text-align:\s*(\w+)/) ?? [])[1] ?? null,
      colspan: 1,
      rowspan: 1,
      colwidth: null,
    }),
  },
  td: {
    block: "table_cell",
    getAttrs: (tok) => ({
      alignment: (tok.attrGet?.("style")?.match(/text-align:\s*(\w+)/) ?? [])[1] ?? null,
      colspan: 1,
      rowspan: 1,
      colwidth: null,
    }),
  },
  wikilink: {
    node: "wikilink",
    getAttrs: (tok) => ({
      target: (tok.meta as { target: string; display: string | null }).target,
      display: (tok.meta as { target: string; display: string | null }).display,
    }),
  },
});

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

export const wikiMarkdownSerializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    table(state, node) {
      // Collect column alignments from the first row's header cells
      const firstRow = node.firstChild;
      const alignments: (string | null)[] = [];
      if (firstRow) {
        firstRow.forEach((cell) => {
          alignments.push((cell.attrs.alignment as string | null) ?? null);
        });
      }

      // Render each row
      node.forEach((row, _, rowIdx) => {
        row.forEach((cell, _, cellIdx) => {
          if (cellIdx > 0) state.write(" | ");
          else state.write("| ");
          state.write(cell.textContent);
        });
        state.write(" |\n");

        // After the first (header) row, emit the separator line
        if (rowIdx === 0) {
          for (let i = 0; i < alignments.length; i++) {
            if (i > 0) state.write(" | ");
            else state.write("| ");
            const a = alignments[i];
            if (a === "center") state.write(":---:");
            else if (a === "right") state.write("---:");
            else state.write("---");
          }
          state.write(" |\n");
        }
      });
      state.write("\n");
      state.closeBlock(node);
    },
    table_row(_state, _node) {},
    table_header(_state, _node) {},
    table_cell(_state, _node) {},
    wikilink(state, node) {
      const { target, display } = node.attrs as { target: string; display: string | null };
      state.write(display ? `[[${target}|${display}]]` : `[[${target}]]`);
    },
  },
  defaultMarkdownSerializer.marks,
);
