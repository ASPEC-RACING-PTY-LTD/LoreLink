import type { ReactNode } from "react";
import { BrandMark } from "./BrandMark";

export function AuthFrame({
  kicker,
  title,
  lede,
  children,
}: {
  kicker?: string;
  title: string;
  lede: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-screen bg-background text-foreground lg:grid-cols-[minmax(20rem,28rem)_minmax(0,1fr)]">
      <aside className="relative flex flex-col justify-between overflow-hidden border-b border-border bg-sidebar px-7 py-8 lg:border-r lg:border-b-0 lg:px-10 lg:py-12">
        <div className="absolute top-0 left-0 h-full w-1 bg-accent" aria-hidden="true" />
        <div>
          <BrandMark size="lg" />
          <p className="mt-5 max-w-xs text-sm leading-relaxed text-muted-foreground">Your projects. Their lore.</p>
          <p className="mt-8 hidden max-w-sm font-serif text-3xl leading-tight tracking-tight lg:block">
            Self-hosted docs that stay in Git, and stay yours.
          </p>
        </div>
        <ul className="mt-10 hidden space-y-3 text-sm text-muted-foreground lg:block">
          <li>Instance setup and local accounts</li>
          <li>Organisations, members, and audit</li>
          <li>A public reading shell for later publish</li>
        </ul>
      </aside>
      <main className="flex items-start justify-center px-5 py-10 sm:px-8 lg:items-center lg:py-16">
        <div className="w-full max-w-md">
          {kicker ? <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">{kicker}</p> : null}
          <h1 className="page-title mt-2">{title}</h1>
          <p className="page-lede mt-3">{lede}</p>
          <div className="mt-8">{children}</div>
        </div>
      </main>
    </div>
  );
}
