import {
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Minus,
  Quote,
  Type,
} from "lucide-react";
import { setBlockType, wrapIn } from "prosemirror-commands";
import type { NodeType, Schema } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";
import type { ReactNode } from "react";

/**
 * A single slash-menu option. `run` is a standard ProseMirror command —
 * given the cleaned state (with the `/query` text already removed), it
 * inserts or transforms the current block.
 */
export interface SlashItem {
  title: string;
  description: string;
  icon: ReactNode;
  keywords: string[];
  run: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean;
}

/**
 * Slash-menu context detected from the current selection. When non-null,
 * the menu should be open and filtered by `query`.
 */
export interface SlashContext {
  query: string;
  /** Position of the leading "/" (inside the paragraph, not at the block boundary). */
  from: number;
  /** End of the query text (cursor position). */
  to: number;
}

/**
 * Detect a slash-menu trigger at the current cursor. Returns a context
 * when the cursor sits in a paragraph whose entire text starts with "/",
 * so arbitrary prose isn't misinterpreted as a slash command.
 */
export function getSlashContext(state: EditorState): SlashContext | null {
  const { $from, empty } = state.selection;
  if (!empty) return null;
  const parent = $from.parent;
  if (parent.type.name !== "paragraph") return null;
  const text = parent.textContent;
  if (!text.startsWith("/")) return null;
  // Bail if the "prose" grew beyond a plausible command name — a paragraph
  // literally beginning with `/foo bar baz ...` is more likely a URL or
  // regex than a pending command.
  const query = text.slice(1);
  if (query.length > 24 || /\s/.test(query)) return null;
  return {
    query,
    from: $from.start(),
    to: $from.start() + text.length,
  };
}

/**
 * Build the list of slash-menu items from the current schema. Commands
 * that require unavailable node types are silently skipped so this stays
 * resilient against schema changes.
 */
export function buildSlashItems(schema: Schema): SlashItem[] {
  const {
    heading,
    paragraph,
    bullet_list,
    ordered_list,
    list_item,
    blockquote,
    code_block,
    horizontal_rule,
  } = schema.nodes;
  const items: SlashItem[] = [];

  if (heading) {
    items.push({
      title: "Heading 1",
      description: "Top-level section title",
      icon: <Heading1 className="h-4 w-4" />,
      keywords: ["h1", "heading", "title"],
      run: setBlockType(heading, { level: 1 }),
    });
    items.push({
      title: "Heading 2",
      description: "Subsection title",
      icon: <Heading2 className="h-4 w-4" />,
      keywords: ["h2", "heading", "subtitle"],
      run: setBlockType(heading, { level: 2 }),
    });
    items.push({
      title: "Heading 3",
      description: "Nested section title",
      icon: <Heading3 className="h-4 w-4" />,
      keywords: ["h3", "heading"],
      run: setBlockType(heading, { level: 3 }),
    });
  }

  if (paragraph) {
    items.push({
      title: "Text",
      description: "Plain paragraph",
      icon: <Type className="h-4 w-4" />,
      keywords: ["p", "paragraph", "text"],
      run: setBlockType(paragraph),
    });
  }

  if (bullet_list && list_item && paragraph) {
    items.push({
      title: "Bullet list",
      description: "Unordered list",
      icon: <List className="h-4 w-4" />,
      keywords: ["ul", "list", "bullet"],
      run: insertListCommand(bullet_list, list_item, paragraph),
    });
  }

  if (ordered_list && list_item && paragraph) {
    items.push({
      title: "Numbered list",
      description: "Ordered list",
      icon: <ListOrdered className="h-4 w-4" />,
      keywords: ["ol", "ordered", "numbered"],
      run: insertListCommand(ordered_list, list_item, paragraph),
    });
  }

  if (blockquote) {
    items.push({
      title: "Quote",
      description: "Indented callout",
      icon: <Quote className="h-4 w-4" />,
      keywords: ["quote", "blockquote"],
      run: wrapIn(blockquote),
    });
  }

  if (code_block) {
    items.push({
      title: "Code block",
      description: "Fenced code",
      icon: <Code className="h-4 w-4" />,
      keywords: ["code", "pre"],
      run: setBlockType(code_block),
    });
  }

  if (horizontal_rule) {
    items.push({
      title: "Divider",
      description: "Horizontal rule",
      icon: <Minus className="h-4 w-4" />,
      keywords: ["hr", "divider", "rule"],
      run: (state, dispatch) => {
        if (dispatch) {
          dispatch(state.tr.replaceSelectionWith(horizontal_rule.create()).scrollIntoView());
        }
        return true;
      },
    });
  }

  return items;
}

/**
 * Filter items by query string. Matches against title and keywords,
 * case-insensitive, substring-anywhere so "ol" finds "Numbered list".
 */
export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  if (!query) return items;
  const q = query.toLowerCase();
  return items.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.keywords.some((k) => k.toLowerCase().includes(q)),
  );
}

/**
 * Replace the current paragraph with a list containing one empty item.
 * Written without `prosemirror-schema-list` so we can stay on the current
 * dependency set.
 */
function insertListCommand(listType: NodeType, itemType: NodeType, paragraphType: NodeType) {
  return (state: EditorState, dispatch?: (tr: Transaction) => void): boolean => {
    const paragraph = paragraphType.create();
    const item = itemType.create(null, paragraph);
    const list = listType.create(null, item);
    if (dispatch) {
      dispatch(state.tr.replaceSelectionWith(list).scrollIntoView());
    }
    return true;
  };
}
