import Image from "next/image";

// Roblox icons are small already: served as they are (unoptimized) rather than re-encoded by the server.
export function GameIcon({ url, name, size = "small" }: { url: string | null; name: string; size?: "small" | "large" }) {
  const pixels = size === "large" ? 76 : 42;
  const className = size === "large" ? "thumbnail large" : "thumbnail";
  if (!url) return <span className={className} aria-hidden="true">{Array.from(name.trim())[0]?.toUpperCase() ?? "?"}</span>;
  return <Image className={className} src={url} alt="" width={pixels} height={pixels} unoptimized />;
}
