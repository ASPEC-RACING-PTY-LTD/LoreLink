import type { ReactNode } from "react";

export function LoadingLine({ label }: { label: string }) {
  return (
    <div className="mt-8 flex items-center gap-3 text-muted-foreground">
      <span className="spinner" />
      {label}
    </div>
  );
}

export function ErrorAlert({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="alert alert-error mt-4">
      {children}
    </div>
  );
}

export function InfoAlert({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="alert alert-info mt-4">
      {children}
    </div>
  );
}

export function EmptyPanel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="panel mt-8 px-6 py-10 sm:px-10">
      <h2 className="font-serif text-3xl font-semibold tracking-tight">{title}</h2>
      <div className="page-lede mt-3">{children}</div>
      {action ? <div className="mt-8">{action}</div> : null}
    </section>
  );
}

export function formatWhen(value?: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function shortSha(sha?: string | null) {
  if (!sha) return "None";
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}