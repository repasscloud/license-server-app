/** @jsxImportSource hono/jsx */
import type { Child } from 'hono/jsx';

/** Dialog content is shared with a server-rendered detail page for no-JavaScript access. */
export const DetailDialog = ({ id, title, children, copyId }: { id: string; title: string; children: Child; copyId?: string }) => <dialog id={id} class="detail-dialog" aria-labelledby={`${id}-title`}>
  <div class="dialog-heading"><h2 id={`${id}-title`}>{title}</h2><button type="button" class="secondary" data-dialog-close aria-label="Close dialog">Close</button></div>
  {children}
  {copyId ? <div class="dialog-actions"><button type="button" data-copy-target={copyId}>Copy</button><span data-copy-status role="status" aria-live="polite"></span></div> : null}
</dialog>;
