import type { ReactNode } from "react";

export function PageHeader({
  crumbs,
  title,
  lede,
  action,
}: {
  crumbs: string[];
  title: string;
  lede: string;
  action?: ReactNode;
}) {
  return (
    <header>
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        {crumbs.join(" / ")}
      </nav>
      <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="page-title">{title}</h1>
          <p className="page-lede mt-2">{lede}</p>
        </div>
        {action ? <div className="shrink-0 sm:pt-1">{action}</div> : null}
      </div>
    </header>
  );
}
