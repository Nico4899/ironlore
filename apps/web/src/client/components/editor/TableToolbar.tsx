import { ChevronLeft, ChevronRight, Minus, Plus, Trash2 } from "lucide-react";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  isInTable,
} from "prosemirror-tables";
import type { EditorView } from "prosemirror-view";

/**
 * Floating toolbar for prosemirror-tables editing commands.
 *
 * Positioned directly above the currently-active table (the one
 * containing the selection) by `MarkdownEditor`. Buttons call the
 * canonical prosemirror-tables commands so behaviour matches the
 * upstream library exactly — we don't re-implement row/col
 * arithmetic ourselves.
 *
 * Visible only when `isInTable(view.state)` is true; when the
 * caret leaves the table, `MarkdownEditor` unmounts this node.
 */

interface TableToolbarProps {
  view: EditorView;
  /** Viewport-relative anchor — top-left of the active table. */
  anchor: { top: number; left: number };
}

export function TableToolbar({ view, anchor }: TableToolbarProps) {
  const run = (cmd: (state: typeof view.state, dispatch?: typeof view.dispatch) => boolean) => {
    cmd(view.state, view.dispatch);
    view.focus();
  };
  return (
    <div
      className="fixed z-40 flex items-center gap-1 rounded-md border border-border bg-ironlore-slate-elevated px-1.5 py-1 shadow-xl"
      style={{
        // Anchor the toolbar 6 px above the table so it doesn't
        //  overlap the first row; the browser pushes it below the
        //  viewport top if the table sits flush against the top
        //  scroll position.
        top: Math.max(8, anchor.top - 36),
        left: anchor.left,
      }}
      role="toolbar"
      aria-label="Table actions"
      onMouseDown={(e) => {
        // Stop the click from stealing selection from the editor —
        //  the commands need the cell selection to still be live.
        e.preventDefault();
      }}
    >
      <ToolBtn
        label="Row above"
        onClick={() => run(addRowBefore)}
        icon={<ChevronLeft className="h-3 w-3 rotate-90" />}
      />
      <ToolBtn
        label="Row below"
        onClick={() => run(addRowAfter)}
        icon={<ChevronRight className="h-3 w-3 rotate-90" />}
      />
      <Divider />
      <ToolBtn
        label="Column left"
        onClick={() => run(addColumnBefore)}
        icon={<ChevronLeft className="h-3 w-3" />}
      />
      <ToolBtn
        label="Column right"
        onClick={() => run(addColumnAfter)}
        icon={<ChevronRight className="h-3 w-3" />}
      />
      <Divider />
      <ToolBtn
        label="Delete row"
        onClick={() => run(deleteRow)}
        icon={<Minus className="h-3 w-3 rotate-90" />}
      />
      <ToolBtn
        label="Delete column"
        onClick={() => run(deleteColumn)}
        icon={<Minus className="h-3 w-3" />}
      />
      <Divider />
      <ToolBtn
        label="Delete table"
        onClick={() => run(deleteTable)}
        icon={<Trash2 className="h-3 w-3" />}
        danger
      />
    </div>
  );
}

function ToolBtn({
  label,
  icon,
  onClick,
  danger,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
      className="inline-flex h-6 w-6 items-center justify-center rounded outline-none hover:bg-ironlore-slate-hover focus-visible:ring-1 focus-visible:ring-ironlore-blue/50"
      style={{ color: danger ? "var(--il-red)" : "var(--il-text2)" }}
    >
      {icon}
    </button>
  );
}

function Divider() {
  return (
    <span
      aria-hidden="true"
      style={{ width: 1, height: 14, background: "var(--il-border-soft)", margin: "0 2px" }}
    />
  );
}

/** Re-export for the consumer — avoids a direct prosemirror-tables import there. */
export { isInTable };

/**
 * Small helper to construct the `Plus` icon with a tooltip consistent
 * with the rest of the toolbar. Used for the "Insert row/col" rows
 * but kept flexible so the same surface can host other commands.
 */
export function PlusIcon() {
  return <Plus className="h-3 w-3" />;
}
