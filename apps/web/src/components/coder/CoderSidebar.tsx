import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

/** Collapsible sidebar section: chevron toggles a bounded region so no single
 *  panel can push the rest of the sidebar out of view. */
export function SidebarSection({
  title,
  icon,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-3">
      <button
        type="button"
        className="mb-1.5 flex w-full items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-faint hover:text-ink"
        onClick={() => setOpen((o) => !o)}
      >
        {icon}
        {title}
        <ChevronDown size={12} className={`ml-auto shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && children}
    </div>
  );
}
