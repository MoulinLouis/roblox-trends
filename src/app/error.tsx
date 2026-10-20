"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <div className="content"><div className="card card-pad"><p className="eyebrow">Error</p><h1>Something went wrong</h1><p className="page-subtitle">{error.message || "An unexpected error occurred."}</p><button className="button primary" onClick={reset}>Try again</button></div></div>;
}
