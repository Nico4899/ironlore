import { AtSign, Upload } from "lucide-react";
import { ComposerPopover, PopoverItem } from "./ComposerPopover.js";

/**
 * `+` composer popover — two items per the brand spec:
 *
 *   · Upload from computer — triggers the hidden file input (same
 *     handler previously bound to the mono `@` chip).
 *   · Add context — inserts `@` into the textarea + focuses so the
 *     mention picker takes over.
 *
 * The same menu is opened via click OR by typing `+` as the first
 * character of an empty draft (handled in AIPanel.tsx).
 */

interface PlusMenuProps {
  open: boolean;
  onClose: () => void;
  /** Called when the user picks "Upload from computer". */
  onUpload: () => void;
  /** Called when the user picks "Add context" — composer inserts `@`. */
  onAddContext: () => void;
}

export function PlusMenu({ open, onClose, onUpload, onAddContext }: PlusMenuProps) {
  return (
    <ComposerPopover open={open} onClose={onClose} ariaLabel="Add to prompt" minWidth={220}>
      <PopoverItem
        icon={<Upload size={14} />}
        label="Upload from computer"
        onClick={() => {
          onUpload();
          onClose();
        }}
      />
      <PopoverItem
        icon={<AtSign size={14} />}
        label="Add context"
        hint="@"
        onClick={() => {
          onAddContext();
          onClose();
        }}
      />
    </ComposerPopover>
  );
}
