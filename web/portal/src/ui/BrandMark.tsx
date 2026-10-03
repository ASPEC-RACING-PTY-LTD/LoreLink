export function BrandMark({
  size = "md",
  wordmark = true,
  src = "/logo.png",
}: {
  size?: "sm" | "md" | "lg";
  wordmark?: boolean;
  src?: string;
}) {
  const mark = size === "lg" ? "size-11" : size === "sm" ? "size-8" : "size-9";
  const text = size === "lg" ? "text-3xl" : size === "sm" ? "text-lg" : "text-xl";

  return (
    <span className="inline-flex items-center gap-2.5">
      <img src={src} alt="" width={36} height={36} className={`${mark} object-contain`} aria-hidden="true" />
      {wordmark ? <span className={`brand-mark leading-none ${text}`}>LoreLink</span> : null}
    </span>
  );
}
