import Link from "next/link";

export default function NotFound() {
  return <div className="content"><div className="card empty"><h1>Page not found</h1><p>This page does not exist in radar v2.</p><Link className="button primary" href="/">Return to overview</Link></div></div>;
}
